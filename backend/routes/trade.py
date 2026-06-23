"""手動交易 + 自動交易（Binance USDⓈ-M 永續）。

安全模型：
- 金鑰只在伺服器 env（見 utils/binance_trade.py）；前端永遠拿不到。
- 站是公開多人用 → 交易端點（除 /status）要求 TRADE_ACCESS_KEY（env 設定的口令）：
  前端輸入一次存 localStorage，之後每個請求帶上。沒設 env 時只允許本機開發直用。
- 預設 testnet：BINANCE_TRADE_ENV=live 才動真錢。

自動交易（每帳號獨立）：
- 設定存 DB 表 trade_auto_acct（每帳號一列、各自獨立、互不覆蓋；沿用 account.py 雙後端）→ 重啟不丟。
  舊的單列 trade_auto(id=1) 於 _ensure_db 一次性遷移到其 owner 帳號的列；trade_log 以 acct 欄隔離各帳號倉位。
- notify_monitor 偵測到「新進場訊號」→ execute_signal_trade()：逐個『已開啟自動交易』的帳號各自用自己的
  金鑰/自選/設定市價進場 + 交易所託管 SL（訊號停損價）/ TP（進場 ± 盈虧比×風險），兩人同標的也互不干擾。
- 出場：全由交易所掛的觸發單『盤中即時』觸發（止損 STOP_MARKET＝緩衝價、止盈 TAKE_PROFIT_MARKET＝上下軌，
  retarget_auto_tp 每根把 TP 移到最新上下軌）→ 碰到止盈/止損位就出，不等收盤(整點)決定。
  reconcile_auto_position() 每輪對帳：未平倉若交易所已無持倉(觸發單已平) → 補記錄+通知。
  （舊的 settle_signal_trade() 會在收盤用訊號結算提早市價平倉、架空止損緩衝 → 已停用，保留定義備查。）
- 每筆交易記 trade_log（含 testnet/live 標記），前端交易面板顯示。
"""
import os
import re
import json
import time
import secrets
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routes import account as _acct
from utils import binance_trade as bt

router = APIRouter(prefix="/api/trade")

_ACCESS_KEY = (os.getenv("TRADE_ACCESS_KEY") or "").strip()
_ON_RAILWAY = _acct._ON_RAILWAY
# TRADE_OWNER=用「共用 env 金鑰」的那一個帳號（如 qwer）。其他帳號要交易須各自綁自己的金鑰。
_OWNER = (os.getenv("TRADE_OWNER") or "").strip()
# TRADE_ALLOW=允許使用交易功能（看得到入口、可綁自己金鑰）的帳號白名單（逗號分隔）。
# 未設 → 預設只有 _OWNER。要開放某帳號：把它加進 TRADE_ALLOW，再讓它綁自己的金鑰。
_ALLOW = {_acct._norm_name(s) for s in (os.getenv("TRADE_ALLOW") or _OWNER).split(",") if s.strip()}


def _allowed(name: str) -> bool:
    return _acct._norm_name(name or "") in _ALLOW if _ALLOW else False

_ALL_SIGS = {"ss1", "ss2", "ss3", "fvg"}   # S1~S12 已退役(無 edge)，自動交易只收 SS 系列 + FVG
_ALL_TFS = {"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"}
# 自動交易止盈目標＝「下軌→上軌」的此比例位（多單靠上軌、空單鏡像靠下軌），取代滿格外軌(=1.0)。
# 0.98＝離上軌 2% 處先止盈 → 不等價格剛好碰到外軌(常常差一點點沒成交又反轉吐回)。進場初始 TP 與
# retarget 跟軌共用此比例。改這一個值即可調整。
_AUTO_TP_BAND_RATIO = 0.98
# 自動交易設定＝SS 與 FVG 兩份『完全獨立』的子設定（風險控制本就不同：slPct/加倉/多時框 是 SS 專屬；
# 進場模式 是 FVG 專屬；FVG 固定 1h、3W/6W、無加倉/無緩衝；連 maxPos/每筆風險的理想值都不同）。
# 共用的只有 on(主開關)/owner。hedge 不進 cfg(是 Binance 帳號級、由 _is_hedge 讀)。
# riskUsd=每筆風險金額(打到停損約虧這麼多 USDT,含來回手續費)；>0 改「固定風險倉位」(數量由停損距離算、
#   槓桿自動挑、lev 當上限)；0=保證金×槓桿。dirs=方向過濾。
_SS_DEFAULT = {"on": False, "sigs": [], "tfs": [], "dirs": "both",
               "usdt": 50.0, "lev": 3, "riskUsd": 0.0, "maxPos": 3,
               # maxAdds=加倉上限(含首筆)。1=不加倉；>1=同向持倉中再現加一筆(到上限)。只 riskUsd>0 生效。
               "maxAdds": 1,
               # slPct=全域止損緩衝%(0=用訊號原停損)。perSym={標的:%} 或 {"標的|時框":%} 個別覆寫。
               "slPct": 0.0, "perSym": {}}
# FVG 子設定：進場模式 market(收盤確認市價,保證成交)/limit(缺口⅓階梯,影線版,成交率未實證)。固定 1h、
# 止損3W/止盈6W → 無 slPct/無 maxAdds/無 tfs；maxPos 預設 15(回測組合上限)。
# universe=標的來源：watchlist(自選,預設)/top60(成交量前60加密永續,排除RWA如PAXG黃金,每日重抓)。
_FVG_DEFAULT = {"on": False, "entry": "market", "dirs": "both",
                "usdt": 50.0, "lev": 3, "riskUsd": 0.0, "maxPos": 15, "universe": "watchlist"}
_AUTO_DEFAULT = {"on": False, "owner": "",
                 "ss": dict(_SS_DEFAULT), "fvg": dict(_FVG_DEFAULT)}


# ── 金鑰加密（Fernet）：Secret 加密後才入庫 ───────────────────
_fernet_obj = None


def _fernet():
    """Fernet 加解密器。金鑰來源：env TRADE_ENC_KEY（urlsafe-b64 32 byte）→ 否則由
    VAPID_PRIVATE_KEY 以 PBKDF2 推導（伺服器有此 env 才能解 → DB 外洩無 env 仍解不開）。"""
    global _fernet_obj
    if _fernet_obj is not None:
        return _fernet_obj
    import base64
    from cryptography.fernet import Fernet
    raw = (os.getenv("TRADE_ENC_KEY") or "").strip()
    if raw:
        try:
            _fernet_obj = Fernet(raw.encode())
            return _fernet_obj
        except Exception:
            pass
    seed = (os.getenv("VAPID_PRIVATE_KEY") or os.getenv("ACCOUNT_ADMIN_KEY") or "trade-fallback").encode()
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b"trade-creds-v1", iterations=200000)
    _fernet_obj = Fernet(base64.urlsafe_b64encode(kdf.derive(seed)))
    return _fernet_obj


def _enc(s: str) -> str:
    return _fernet().encrypt((s or "").encode()).decode()


def _dec(s: str) -> str:
    return _fernet().decrypt((s or "").encode()).decode()


# ── 帳號金鑰解析：自綁金鑰 → 否則擁有者退回 env ──────────────
def _acct_env_suffix(name: str) -> str:
    """帳號名 → 環境變數後綴（大寫、非英數轉底線）。如 'Abc' → 'ABC'、'a.b@c' → 'A_B_C'。"""
    return re.sub(r"[^A-Za-z0-9]", "_", _acct._norm_name(name or "")).upper()


def _own_creds(name: str):
    """讀某帳號的 Binance 金鑰（已解密）。回 (api_key, api_secret, env) 或 None。
    優先序：① 該帳號專屬環境變數 TRADE_KEY_<NAME>/TRADE_SECRET_<NAME>/TRADE_ENV_<NAME>
            ② App 自綁（trade_creds，加密）。"""
    name = _acct._norm_name(name or "")
    if not name:
        return None
    # ① 每帳號專屬環境變數金鑰（Railway 可直接設、各帳號各自獨立、與 qwer 的共用 env 金鑰互不干擾）
    suf = _acct_env_suffix(name)
    ek = (os.getenv(f"TRADE_KEY_{suf}") or "").strip()
    es = (os.getenv(f"TRADE_SECRET_{suf}") or "").strip()
    if ek and es:
        # 安全防護：禁止用「共用 env 金鑰(TRADE_OWNER 那把)」當別的帳號金鑰 → 避免兩帳號操作同一交易所帳戶互相干擾
        if bt.env_configured() and ek == bt._ENV_API_KEY and _acct._norm_name(name) != _acct._norm_name(_OWNER):
            print(f"  ⚠ {name} 的 TRADE_KEY_{suf} 與共用金鑰相同 → 忽略(避免帳號互相干擾)")
        else:
            return (ek, es, bt.norm_env(os.getenv(f"TRADE_ENV_{suf}") or "testnet"))
    # ② App 自綁（trade_creds）
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute(f"SELECT api_key, secret_enc, env FROM trade_creds WHERE name={ph}", (name,))
            row = cur.fetchone()
        finally:
            conn.close()
        if row and row[0] and row[1]:
            return (row[0], _dec(row[1]), bt.norm_env(row[2] or "testnet"))
    except Exception as e:
        print(f"  ⚠ 讀取金鑰失敗（{name}）：{e}")
    return None


def _client_for(name: str):
    """依帳號解析交易 Client：①自綁金鑰 ②擁有者帳號退回 env 金鑰 ③都沒 → None。
    不在白名單的帳號一律 None（即使誤綁了金鑰也不放行）。回 (client_or_None, is_env_owner)。"""
    if not _allowed(name):
        return None, False
    creds = _own_creds(name)
    if creds:
        return bt.Client(*creds), False
    if _OWNER and _acct._norm_name(name or "") == _acct._norm_name(_OWNER) and bt.env_configured():
        return bt.env_client(), True
    return None, False


# ── 訪問控制 ──────────────────────────────────────────────────
def _locked() -> bool:
    return bool(_ACCESS_KEY) or _ON_RAILWAY


def _guard(key: Optional[str], name: Optional[str] = None):
    """驗證並回傳此帳號的交易 Client。無金鑰 → 403。
    使用 env 金鑰的擁有者帳號 → 另需 TRADE_ACCESS_KEY 口令（保護共用 env 帳戶）。
    自綁金鑰的帳號 → 不需口令（自己的金鑰、登入該帳號即可）。"""
    nm = _acct._norm_name(name or "")
    if not nm:
        raise HTTPException(403, "請先登入帳號")
    client, is_env_owner = _client_for(nm)
    if client is None:
        raise HTTPException(403, "此帳號尚未綁定 Binance 金鑰")
    if is_env_owner:
        if _ACCESS_KEY:
            if not secrets.compare_digest(key or "", _ACCESS_KEY):
                raise HTTPException(403, "交易口令錯誤（TRADE_ACCESS_KEY）")
        elif _ON_RAILWAY:
            raise HTTPException(403, "伺服器未設定 TRADE_ACCESS_KEY，公網環境停用 env 帳戶交易")
    return client


# ── 自動交易設定（DB 單列，重啟不丟）──────────────────────────
_inited = False
_auto_cache = {}                              # name -> {"ts":, "cfg":}（每帳號設定 10s 快取）
_auto_all_cache = {"ts": 0.0, "rows": None}   # 所有「已開啟」帳號設定 [(name,cfg),...] 的 10s 快取
_surge_cache = {"ts": 0.0, "v": False}        # FVG 爆量風控判定 60s 快取（見 _fvg_surge_active）


def _ensure_db():
    global _inited
    if _inited:
        return
    _acct._ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_auto (
                id         INTEGER PRIMARY KEY,
                cfg        TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS trade_auto (
                id         INTEGER PRIMARY KEY,
                cfg        TEXT,
                updated_at REAL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_log (
                id        BIGSERIAL PRIMARY KEY,
                ts        DOUBLE PRECISION,
                mode      TEXT, source TEXT, status TEXT,
                symbol    TEXT, bsym TEXT, side TEXT,
                qty       TEXT, entry TEXT, sl TEXT, tp TEXT,
                sig       TEXT, dir TEXT, tf TEXT, sigt TEXT,
                msg       TEXT, closed_ts DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS trade_log (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        REAL,
                mode      TEXT, source TEXT, status TEXT,
                symbol    TEXT, bsym TEXT, side TEXT,
                qty       TEXT, entry TEXT, sl TEXT, tp TEXT,
                sig       TEXT, dir TEXT, tf TEXT, sigt TEXT,
                msg       TEXT, closed_ts REAL
            )
        """)
        # 交易口令寫穿表（每帳號一筆）：讓口令「跟著帳戶移動」、輸一次換裝置免再輸。
        # 不靠整包 localStorage 快照同步（會被別台舊快照蓋掉、登入時機不對就帶不到）。
        # 注意：存的是「交易口令」(TRADE_ACCESS_KEY 的門禁碼)，非 Binance 金鑰；金鑰仍只在 env。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_userkey (
                name       TEXT PRIMARY KEY,
                tkey       TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS trade_userkey (
                name       TEXT PRIMARY KEY,
                tkey       TEXT,
                updated_at REAL
            )
        """)
        # 每帳號自綁的 Binance 金鑰：api_key 明文（公鑰）、secret_enc=Fernet 加密、env=testnet/live。
        # 伺服器需 env 加密金鑰才能解 → DB 外洩無 env 仍解不開。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_creds (
                name       TEXT PRIMARY KEY,
                api_key    TEXT,
                secret_enc TEXT,
                env        TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS trade_creds (
                name       TEXT PRIMARY KEY,
                api_key    TEXT,
                secret_enc TEXT,
                env        TEXT,
                updated_at REAL
            )
        """)
        conn.commit()
        # 既有 DB 補欄位：tp_oid = 交易所 TP(algo) 單 id，供「TP 跟著中軌移動」用 id 精準取消重掛。
        # idempotent：欄位已存在會丟錯 → rollback（Postgres 失敗交易須回滾，否則後續語句全失敗）。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN tp_oid TEXT")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # adds = 此自動倉的加倉筆數(含首筆，預設 1)，供「加倉上限」判定與顯示。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN adds INTEGER DEFAULT 1")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # sl_oid = 交易所 SL(algo) 單 id，供「加倉後止損移到最新筆」用 id 精準取消重掛（不碰 TP、不清整個合約）。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN sl_oid TEXT")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # acct = 此筆交易屬於哪個帳號（自動交易每帳號獨立後，用它把各帳號的倉位/紀錄完全隔開，
        # 避免兩人同標的時 trade_log 互相污染）。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN acct TEXT")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # rev = 1 表示「反向模式」開的倉(止損↔止盈互換、反方向)。retarget_auto_tp 看到 rev=1 直接跳過
        # (反向倉 SL/TP 固定不追蹤軌)，避免把 TP 移到錯邊。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN rev INTEGER DEFAULT 0")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # extra = JSON 雜項：FVG 限價階梯版用來存三檔限價單 [{oid,level,px}] + 缺口 top/bot，
        # 供 reconcile_fvg_pending 偵測成交/撤殘單/過期。其他交易留空。
        try:
            conn.execute("ALTER TABLE trade_log ADD COLUMN extra TEXT")
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
        # 每帳號自動交易設定（取代舊的單列 trade_auto id=1）：每個帳號一列、各自獨立、互不覆蓋。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trade_auto_acct (
                name       TEXT PRIMARY KEY,
                cfg        TEXT,
                updated_at DOUBLE PRECISION
            )
        """ if _acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS trade_auto_acct (
                name       TEXT PRIMARY KEY,
                cfg        TEXT,
                updated_at REAL
            )
        """)
        conn.commit()
        # 一次性遷移：舊的全域單列 trade_auto(id=1) → 搬進它的 owner 帳號的 trade_auto_acct 列，
        # 並把既有未標 acct 的自動倉/紀錄補上該 owner（否則新版『依 acct 查』會找不到既有持倉）。
        try:
            _row = conn.execute("SELECT cfg FROM trade_auto WHERE id=1").fetchone()
            if _row and _row[0]:
                _old = json.loads(_row[0])
                _ow = (_old.get("owner") or "").strip()
                _exists = conn.execute("SELECT 1 FROM trade_auto_acct LIMIT 1").fetchone()
                if _ow and not _exists:           # 尚未遷移過 → 搬一次
                    conn.execute(
                        f"INSERT INTO trade_auto_acct (name, cfg, updated_at) VALUES ({ph},{ph},{ph}) "
                        f"ON CONFLICT (name) DO NOTHING",
                        (_ow, _row[0], time.time()))
                    conn.execute(
                        f"UPDATE trade_log SET acct={ph} WHERE source='auto' AND acct IS NULL", (_ow,))
                    conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
    finally:
        conn.close()
    _inited = True


def _num(v, dflt, lo, hi, integer=False):
    try:
        x = (int if integer else float)(v if v is not None else dflt)
        return max(lo, min(x, hi))
    except (TypeError, ValueError):
        return dflt


def _clean_ss(p: dict) -> dict:
    """SS 子設定 sanitize。"""
    p = p or {}
    o = dict(_SS_DEFAULT)
    o["on"] = bool(p.get("on"))
    o["sigs"] = [s for s in (p.get("sigs") or []) if s in ("ss1", "ss2", "ss3")]
    o["tfs"] = [t for t in (p.get("tfs") or []) if t in _ALL_TFS]
    if p.get("dirs") in ("both", "long", "short"):
        o["dirs"] = p["dirs"]
    o["usdt"] = _num(p.get("usdt"), 50.0, 1.0, 100000.0)
    o["lev"] = _num(p.get("lev"), 3, 1, 50, True)
    o["riskUsd"] = _num(p.get("riskUsd") or 0, 0.0, 0.0, 100000.0)
    o["maxPos"] = _num(p.get("maxPos"), 3, 1, 50, True)
    o["maxAdds"] = _num(p.get("maxAdds"), 1, 1, 20, True)
    o["slPct"] = _num(p.get("slPct") or 0, 0.0, 0.0, 50.0)
    ps = {}
    for sym, v in (p.get("perSym") or {}).items():
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if fv > 0:
            ps[str(sym)] = max(0.0, min(fv, 50.0))
    o["perSym"] = ps
    return o


def _clean_fvg(p: dict) -> dict:
    """FVG 子設定 sanitize（固定 1h/3W/6W → 無 tfs/slPct/maxAdds）。"""
    p = p or {}
    o = dict(_FVG_DEFAULT)
    o["on"] = bool(p.get("on"))
    o["entry"] = p.get("entry") if p.get("entry") in ("market", "limit") else "market"
    if p.get("dirs") in ("both", "long", "short"):
        o["dirs"] = p["dirs"]
    o["usdt"] = _num(p.get("usdt"), 50.0, 1.0, 100000.0)
    o["lev"] = _num(p.get("lev"), 3, 1, 50, True)
    o["riskUsd"] = _num(p.get("riskUsd") or 0, 0.0, 0.0, 100000.0)
    o["maxPos"] = _num(p.get("maxPos"), 15, 1, 50, True)
    o["universe"] = p.get("universe") if p.get("universe") in ("watchlist", "top60") else "watchlist"
    return o


def _clean_auto(p: Optional[dict]) -> dict:
    """回巢狀 {on, owner, ss:{…}, fvg:{…}}。相容『舊扁平 cfg』→ 平滑遷移到 ss/fvg 兩份。
    owner=綁定擁有者帳號：自動交易只下此帳號自選清單裡的標的（避免掃到別人自選就用你的 Binance 下單）。"""
    p = p or {}
    out = {"on": bool(p.get("on")), "owner": (p.get("owner") or "").strip()[:40]}
    if "ss" in p or "fvg" in p:
        out["ss"] = _clean_ss(p.get("ss") or {})
        out["fvg"] = _clean_fvg(p.get("fvg") or {})
    else:
        # ── 舊扁平格式遷移：sizing/sigs/tfs/緩衝/加倉 全給 SS；FVG 取舊 fvgEntry+sizing、maxPos 預設15 ──
        ss = _clean_ss(p)
        ss["sigs"] = [s for s in (p.get("sigs") or []) if s in ("ss1", "ss2", "ss3")]
        ss["on"] = bool(ss["sigs"])                    # 舊有勾 ss → SS 開
        out["ss"] = ss
        fvg = _clean_fvg({"entry": p.get("fvgEntry"), "dirs": p.get("dirs"),
                          "usdt": p.get("usdt"), "lev": p.get("lev"), "riskUsd": p.get("riskUsd")})
        fvg["on"] = "fvg" in (p.get("sigs") or [])     # 舊有勾 fvg → FVG 開
        out["fvg"] = fvg
    return out


def _auto_active(cfg: dict) -> bool:
    """此帳號自動交易是否有效＝主開關 on 且至少一個策略開。"""
    return bool(cfg.get("on") and (cfg.get("ss", {}).get("on") or cfg.get("fvg", {}).get("on")))


def get_auto_cfg(name: str = None, fresh: bool = False) -> dict:
    """讀『某帳號』的自動交易設定（10s 快取）。name 省略/空 → 回預設(全關)。
    owner 一律設成該列帳號名（不靠前端傳的 owner 欄）→ 自動交易只下此帳號自己的自選、用自己的金鑰。"""
    nm = _acct._norm_name(name or "")
    if not nm:
        return dict(_AUTO_DEFAULT)
    c = _auto_cache.get(nm)
    if not fresh and c and time.time() - c["ts"] < 10:
        return c["cfg"]
    cfg = dict(_AUTO_DEFAULT)
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute(f"SELECT cfg FROM trade_auto_acct WHERE name={ph}", (nm,))
            row = cur.fetchone()
        finally:
            conn.close()
        if row and row[0]:
            cfg = _clean_auto(json.loads(row[0]))
    except Exception:
        pass
    cfg["owner"] = nm
    _auto_cache[nm] = {"ts": time.time(), "cfg": cfg}
    return cfg


def get_all_auto_cfgs(fresh: bool = False):
    """回所有『已開啟(on)』帳號的自動交易設定：[(name, cfg), ...]。供執行器逐帳號獨立跑、互不干擾。"""
    if not fresh and _auto_all_cache["rows"] is not None and time.time() - _auto_all_cache["ts"] < 10:
        return _auto_all_cache["rows"]
    out = []
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            rows = conn.execute("SELECT name, cfg FROM trade_auto_acct").fetchall()
        finally:
            conn.close()
        for nm, cfgs in rows:
            if not nm or not cfgs:
                continue
            try:
                cfg = _clean_auto(json.loads(cfgs))
            except Exception:
                continue
            if not _auto_active(cfg):           # 主開關關、或 SS/FVG 兩策略都關 → 不收錄
                continue
            cfg["owner"] = nm
            out.append((nm, cfg))
    except Exception:
        pass
    _auto_all_cache["rows"] = out
    _auto_all_cache["ts"] = time.time()
    return out


def _save_auto_cfg(name: str, cfg: dict):
    nm = _acct._norm_name(name or "")
    if not nm:
        return
    cfg["owner"] = nm
    _ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO trade_auto_acct (name, cfg, updated_at) VALUES ({ph},{ph},{ph}) "
            f"ON CONFLICT (name) DO UPDATE SET cfg=excluded.cfg, updated_at=excluded.updated_at",
            (nm, json.dumps(cfg), time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    _auto_cache[nm] = {"ts": time.time(), "cfg": cfg}
    _auto_all_cache["rows"] = None     # 失效 → 下次重讀（含此帳號的開/關變動）


# ── 交易紀錄 ──────────────────────────────────────────────────
def _log_trade(**kw) -> Optional[int]:
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cols = ("ts", "mode", "source", "status", "symbol", "bsym", "side", "qty",
                    "entry", "sl", "tp", "sig", "dir", "tf", "sigt", "msg", "tp_oid", "sl_oid", "acct", "rev", "extra")
            vals = (time.time(), kw.get("mode") or bt.env_name(), kw.get("source"), kw.get("status"),
                    kw.get("symbol"), kw.get("bsym"), kw.get("side"), kw.get("qty"),
                    kw.get("entry"), kw.get("sl"), kw.get("tp"), kw.get("sig"),
                    kw.get("d"), kw.get("tf"), kw.get("sigt"), kw.get("msg"),
                    str(kw["tp_oid"]) if kw.get("tp_oid") is not None else None,
                    str(kw["sl_oid"]) if kw.get("sl_oid") is not None else None,
                    kw.get("acct"), 1 if kw.get("rev") else 0,
                    kw.get("extra"))
            cur = conn.execute(
                f"INSERT INTO trade_log ({','.join(cols)}) VALUES ({','.join([ph]*len(cols))})",
                vals)
            conn.commit()
            try:
                return cur.lastrowid
            except Exception:
                return None
        finally:
            conn.close()
    except Exception:
        return None


def _update_trade(row_id: int, status: str, msg: str = None):
    try:
        conn, ph = _acct._db()
        try:
            conn.execute(
                f"UPDATE trade_log SET status={ph}, msg=COALESCE({ph},msg), closed_ts={ph} WHERE id={ph}",
                (status, msg, time.time(), row_id))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _set_trade_tp(row_id: int, tp: str, tp_oid):
    """更新某筆開倉的 TP 價與交易所 TP(algo) 單 id（供「TP 跟著中軌移動」記錄最新掛單）。"""
    try:
        conn, ph = _acct._db()
        try:
            conn.execute(
                f"UPDATE trade_log SET tp={ph}, tp_oid={ph} WHERE id={ph}",
                (tp, str(tp_oid) if tp_oid is not None else None, row_id))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _fmt_px(p) -> str:
    """價格格式化：大數加千分位、小數保留有效位（與 notify_monitor._fmt_price 一致）。"""
    try:
        p = float(p)
    except (TypeError, ValueError):
        return str(p)
    if p >= 1000:
        return f"{p:,.2f}"
    if p >= 1:
        return f"{p:.4g}"
    return f"{p:.6g}"


def _push_owner(owner, title, body, symbol, tf="", event="atrade", sig=None, d=None, sigt=None):
    """把自動交易結果推給擁有者帳號（Web Push）並寫進訊號聊天室。絕不向外拋例外。
    sig/d/sigt：對應進場訊號鍵/方向/訊號棒時間 → 讓自動平倉訊息能串接回自動進場訊息。"""
    try:
        import routes.notify as notify
        payload = {
            "title": title, "body": body,
            "tag": f"atrade:{symbol}:{event}:{int(time.time())}",
            "data": {"symbol": symbol, "market": "crypto", "exchange": "pionex", "tf": tf},
        }
        on = _acct._norm_name(owner)
        for s in notify.all_active_subs():
            if _acct._norm_name(s.get("name")) == on:
                notify.send_push(s, payload)
        notify.log_signal(owner, time.time(), event, title, body, symbol, "crypto", "pionex", tf,
                          sig=sig, d=d, sigt=sigt)
    except Exception as e:
        print(f"  ⚠ 自動交易通知失敗：{e}")


# ── 持倉模式（單向 / 雙向 hedge）小工具 ───────────────────────
def _is_hedge(client) -> bool:
    """此 client 帳號是否雙向持倉(hedge)。失敗保守回 False(單向) → 行為與現狀一致。"""
    try:
        return bool(client.get_position_mode())
    except Exception:
        return False


def _posside(want, hedge):
    """hedge→positionSide(LONG/SHORT)；單向→None（下單不帶 positionSide、行為不變）。"""
    return (("LONG" if want == "long" else "SHORT") if hedge else None)


# ── 自動交易執行器（notify_monitor 呼叫；絕不向外拋例外）───────
def execute_signal_trade(market, exchange, symbol, tf, k, d, sig, all_signals=None):
    """新進場訊號 → 逐個『已開啟自動交易』的帳號各自獨立評估下單
    （每帳號用自己的金鑰/自選/設定、紀錄以 acct 隔離，互不干擾）。
    all_signals=該標的當前完整訊號列表（含結算結果），供「敗後停手」模擬用。"""
    if market != "crypto":
        return
    for _name, _cfg in get_all_auto_cfgs():
        scfg = _cfg["fvg"] if k == "fvg" else _cfg["ss"]   # 各策略獨立子設定（sizing/maxPos/方向…）
        if not scfg.get("on"):
            continue
        try:
            _exec_signal_for_account(_name, scfg, market, exchange, symbol, tf, k, d, sig, all_signals)
        except Exception as e:
            print(f"  ⚠ 自動下單失敗 {_name} {symbol} {tf} {k}/{d}：{e}")


def _open_pos_count(name, fvg_only) -> int:
    """此帳號目前未了結的自動倉數（供各策略獨立 maxPos）。fvg_only=True 只算 FVG(含 pending 限價)；
    False 只算 SS。"""
    try:
        c, ph = _acct._db()
        try:
            if fvg_only:
                r = c.execute(f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND acct={ph} "
                              f"AND sig='fvg' AND status IN ('open','pending')", (name,)).fetchone()
            else:
                r = c.execute(f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND acct={ph} "
                              f"AND sig IN ('ss1','ss2','ss3') AND status='open'", (name,)).fetchone()
            return r[0] if r else 0
        finally:
            c.close()
    except Exception:
        return 0


def _exec_signal_for_account(name, cfg, market, exchange, symbol, tf, k, d, sig, all_signals=None):
    """單一帳號(name)的進場評估：用該帳號自己的金鑰下單、自選過濾、acct 隔離紀錄。
    ⚠ cfg = 該策略的『子設定』(ss 或 fvg)，已在 execute_signal_trade gate 過 on。"""
    try:
        if k == "fvg":
            # FVG 限價版由 place_fvg_limit_ladder 在缺口確認時掛限價 → 市價路徑(fvg_sigs)不下單。
            if cfg.get("entry") == "limit":
                return
        else:
            # SS：訊號/時框未勾 → 靜默 return（量大，留紀錄會洗版）。
            if not (k in cfg.get("sigs", []) and tf in cfg.get("tfs", [])):
                return
        want = "short" if d == "s" else "long"
        import routes.notify as notify
        # 逐事件去重（鍵含帳號名 → 每帳號各自獨立評估一次）：之後每個「跳過原因」都只記一次 log。
        evt_key = f"atrade:{name}:{symbol}:{tf}:{k}:{d}:{sig.get('t')}"
        if notify.seen_event(evt_key):
            return
        notify.mark_event(evt_key)   # 標記：此帳號此訊號只嘗試/記錄一次，不重複

        def _skip(msg):
            """記一筆 skipped 交易紀錄（前端交易面板看得到）：說明此訊號為何沒進場。"""
            _log_trade(source="auto", acct=name, status="skipped", symbol=symbol, side=want,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=msg)

        # 方向過濾：訊號/時框已符合、僅方向不收 → 留一筆 skipped（量小，且能解釋「為何只做多／只做空」）。
        if cfg["dirs"] != "both" and cfg["dirs"] != want:
            _skip(f"方向不符：此帳號自動交易只做{'多單' if cfg['dirs'] == 'long' else '空單'}，跳過{want}")
            return

        # ⚠ 已結算訊號不追進場（避免開單即平倉）。只進「還沒結算(live)」的訊號。
        if sig.get("r") in ("w", "l"):
            _skip("訊號已結算(非 live)，不追進場（避免開單即平倉）")
            return
        # ⚠ 關鍵：用此帳號自己的金鑰下單、只交易此帳號自己的自選清單裡的標的。
        owner = name
        client, _ = _client_for(owner)
        if client is None:
            _skip(f"帳號「{owner}」沒有交易所金鑰，無法下單")
            return
        owner_syms = {(w.get("symbol") or "") for w in fvg_account_symbols(owner, cfg)}
        if symbol not in owner_syms:                 # universe=top60(FVG) → 比對成交量前60;否則自選
            _skip(f"{symbol} 不在帳號「{owner}」的標的清單，跳過")
            return

        entry = sig.get("entry")
        stop = sig.get("stop")
        rr = sig.get("rr")          # 中軌預估盈虧比
        rr_b = sig.get("rr_b")      # 上下軌預估盈虧比（自動交易止盈目標＝上下軌）
        if entry is None or stop is None:
            return
        bsym, scale = client.resolve_symbol(symbol)
        _hedge = _is_hedge(client)              # 雙向持倉帳號 → 下單帶 positionSide、同幣多空分倉
        pos = client.positions()
        max_adds = int(cfg.get("maxAdds", 1) or 1)
        is_add = False; add_row_id = None; cur_adds = 1
        add_old_sl = None; add_old_sl_oid = None     # 既有自動倉的止損(圖表價)與其交易所單 id → 加倉時用來收緊重掛

        _psd = _posside(want, _hedge)              # hedge: LONG/SHORT；單向: None
        # 同合約持倉判定：hedge 下只認『同 side』為既有倉（多/空各一槽、互不擋）
        existing = next((p for p in pos if p["symbol"] == bsym
                         and (not _hedge or p.get("posSide") == _psd)), None)

        if existing:
            # 已有同合約持倉：加倉開啟(maxAdds>1) + 同向 + 未達上限 → 加倉；否則略過。
            try:
                _c, _ph = _acct._db()
                try:
                    # ⚠ 只認「同時框」的自動倉：交易所同合約只有一個淨倉，若不比時框，15m 訊號會看到
                    #   5m 開的倉、誤當成 5m 的加倉（5m/15m 攪在一起）。改成只找同 tf 的自動倉。
                    _r = _c.execute(
                        f"SELECT id, adds, sl, sl_oid, sig, dir, sigt FROM trade_log WHERE source='auto' AND status='open' "
                        f"AND acct={_ph} AND bsym={_ph} AND tf={_ph} ORDER BY id DESC LIMIT 1", (name, bsym, tf)).fetchone()
                finally:
                    _c.close()
            except Exception:
                _r = None
            cur_adds = (_r[1] if (_r and _r[1]) else 1)
            _why = None
            if existing.get("side") != want:   _why = "已有反向持倉，略過（單向不能反手）"
            elif not _r:                       _why = "此合約已被其他時框/手動持倉佔用（同合約只能一個淨倉），略過"
            elif max_adds <= 1:                _why = "已有同合約持倉，略過"
            elif cur_adds >= max_adds:         _why = f"加倉已達上限 {max_adds} 筆，略過"
            if _why:
                _log_trade(source="auto", acct=name, mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                           side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=_why)
                return
            is_add = True; add_row_id = _r[0]; add_old_sl = _r[2]; add_old_sl_oid = _r[3]
            # 原進場訊號鍵/方向/訊號棒時間 → 讓加倉通知「回覆」串接回原自動進場訊息（同一串）
            add_entry_sig = _r[4]; add_entry_d = _r[5]; add_entry_sigt = _r[6]
        elif _open_pos_count(name, k == "fvg") >= cfg["maxPos"]:   # 各策略獨立計數(只算同策略倉)
            _log_trade(source="auto", acct=name, mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg=f"持倉數已達上限 {cfg['maxPos']}")
            return

        px = client.last_price(bsym)

        # 停損價（圖表價）：slPct=止損緩衝 %。以「策略訊號停損」為基準，再往「離進場更遠」
        # 方向外推 X%（多單→更低、空單→更高），給緩衝、避免被插針掃掉；0=直接用策略停損。
        orig_stop = float(stop)
        # 止損緩衝%查詢順序：該「標的×時間框」個別值 → 該標的（全時框）→ 全域 slPct。
        ps = cfg.get("perSym") or {}
        per = ps.get(f"{symbol}|{tf}")
        if per is None:
            per = ps.get(symbol)
        slpct = per if per is not None else (cfg.get("slPct") or 0)
        if slpct > 0:
            stop_chart = orig_stop * (1 + slpct / 100) if d == "s" else orig_stop * (1 - slpct / 100)
        else:
            stop_chart = orig_stop
        sl_px = client.quantize_price(bsym, stop_chart * scale)

        # ── 進場前防呆：停損必須在進場價的「虧損側」，否則根本不進場 ──
        # 停損用 STOP_MARKET：多單＝SELL stop（停損價須 < 現價）、空單＝BUY stop（停損價須 > 現價）。
        # 若止損緩衝太小、或進場棒已越過設定區間極值 → 停損價會落到現價的同側/錯側，交易所會判
        # 「立即觸發」(-2021) 拒掛 → 過去因此「開了倉卻掛不上停損 → 即時平倉 → 推自動進場取消」，
        # 白繳兩趟手續費又發警報。改成這裡直接放棄：不開倉、不平倉、不發取消。
        sl_f = float(sl_px)
        if (want == "long" and sl_f >= px) or (want == "short" and sl_f <= px):
            _log_trade(source="auto", acct=name, mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       entry=str(entry), sl=str(round(stop_chart, 8)),
                       msg=f"現價 {px} 已在停損 {sl_f} 的{'下方' if want == 'long' else '上方'}"
                           f"（止損緩衝過小／進場棒越過極值）→ 放棄進場，不開倉")
            print(f"  ⏭ 自動下單跳過 {bsym}：停損 {sl_f} 在現價 {px} 錯側，放棄進場")
            return

        # ── 倉位大小 + 槓桿 ──
        risk_usd = cfg.get("riskUsd") or 0
        lev_cap = max(1, min(int(cfg["lev"]), 50))
        _size_warn = None
        if risk_usd > 0:
            # 「固定金額 + 固定止損 → 算槓桿」：數量由止損額 risk_usd 反推(含來回手續費)，使打到停損約虧
            # risk_usd；槓桿 = 名目 ÷ 進場金額(保證金 cfg.usdt)。＝ 止損額 ÷（金額 × 停損距離）。
            e_c = px                               # px=last_price(bsym) 已是合約價 → 不可再 ×scale（曾雙重縮放，1000 倍合約數量算成 1/1000）
            s_c = stop_chart * scale               # 停損合約價
            dist = abs(e_c - s_c)
            if dist <= 0:
                _log_trade(source="auto", acct=name, mode=client.env, status="failed", symbol=symbol, bsym=bsym,
                           side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                           msg="停損距離為 0，無法計算倉位")
                return
            fee = 0.0005                           # Binance 合約吃單 0.05%/邊
            # 每單位虧損（把手續費全算進去）：停損距離 + 進場腿(以進場價)手續費 + 出場腿(以停損價)手續費
            per_unit_loss = dist + fee * e_c + fee * s_c
            q_base = risk_usd / per_unit_loss      # 打到停損約虧 risk_usd 的數量
            notional = q_base * e_c
            stop_pct = dist / e_c if e_c else 0.05
            max_lev, mmr = client.lev_bracket(bsym)
            margin = cfg.get("usdt") or 0          # 進場金額(保證金)＝使用者填的「金額」
            # 槓桿 = 名目 ÷ 金額。安全上限：強平須在停損外(~1.25×停損距離)，否則金額太小→停損前先爆倉、
            # 虧掉整筆保證金(超過設定止損額) → 自動壓低槓桿(等於多投保證金)。
            safe_lev = int(1.0 / (stop_pct * 1.25 + mmr)) if (stop_pct * 1.25 + mmr) > 0 else max_lev
            want_lev = round(notional / margin) if margin > 0 else safe_lev
            lev = max(1, min(want_lev, safe_lev, max_lev, 50))
            if want_lev > lev:
                _size_warn = f"槓桿 {want_lev}→{lev}x（金額太小、強平會在停損內 → 自動降槓桿、多投保證金保護）"
            qty = client.quantize_qty(bsym, q_base)
        else:
            lev = lev_cap
            notional = cfg["usdt"] * lev
            qty = client.quantize_qty(bsym, notional / px)
        if notional < client.min_notional(bsym):
            _log_trade(source="auto", acct=name, mode=client.env, status="failed", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg=f"名目金額 {notional:.1f} 低於合約下限 {client.min_notional(bsym)}"
                           + ("（風險金額太小、把每筆風險或上限槓桿調大）" if risk_usd > 0 else ""))
            return
        try:
            client.set_leverage(bsym, lev)
        except bt.TradeError:
            pass   # 槓桿設定失敗就用現值（有倉位/掛單時交易所會拒改）

        side = "BUY" if want == "long" else "SELL"
        o = client.place_order(bsym, side, qty, "MARKET", position_side=_psd)   # 市價：開倉 or 加倉(同向加進淨倉)
        # 止盈到「下軌→上軌的 _AUTO_TP_BAND_RATIO 位」（空→鏡像靠下軌、多→靠上軌；用原始策略風險算→
        # 不受停損緩衝影響）。因標準布林上下軌對稱於中軌 → 該比例位 = 中軌 + (2r−1)(外軌−中軌)，
        # 換算 RR：tp_rr = rr + (2r−1)(rr_b − rr)（rr＝中軌預估RR、rr_b＝外軌預估RR）。缺 rr_b/rr →
        # 退回外軌/中軌。之後 retarget_auto_tp 每根 K 跟著同一比例位移動。
        tp_px = None; tgt = None     # tgt=止盈圖表價(顯示/紀錄用)；tp_px=合約價(掛單用，=tgt×scale)
        if sig.get("tp") is not None:
            # 固定止盈訊號（FVG：tp=top+6W/bot−6W 圖表價）→ 直接用，繞過上下軌 rr/rr_b 計算。
            # retarget_auto_tp 會依 sig 種類跳過此倉 → TP 固定不追蹤軌（見該函式）。
            tgt = float(sig["tp"])
            tp_px = client.quantize_price(bsym, tgt * scale)
        else:
            if rr_b is not None and rr is not None:
                tp_rr = rr + (2.0 * _AUTO_TP_BAND_RATIO - 1.0) * (rr_b - rr)
            else:
                tp_rr = rr_b if rr_b else rr
            if tp_rr:
                risk = abs(float(entry) - orig_stop)
                tgt = float(entry) - tp_rr * risk if d == "s" else float(entry) + tp_rr * risk
                tp_px = client.quantize_price(bsym, tgt * scale)
        close_side = "SELL" if want == "long" else "BUY"

        # ── 加倉：市價已合併進淨倉。止損『固定在首筆、不隨加倉移動』──
        # 首筆掛的 SL 是 closePosition(平整倉)→ 本就保護加倉後的整個淨倉，不需重設。
        # 過去會重設到 N×R，但實測常撞 -4509(algo 滿)/-2021(錯側) 一直掛單失敗；且與回測「首筆止損」
        # 不一致。改成加倉完全不動 SL → 沿用首筆止損單，只更新數量/均價/筆數。止盈仍由 retarget 跟軌。
        if is_add:
            try:
                _np = next((p for p in client.positions() if p["symbol"] == bsym
                            and (not _hedge or p.get("posSide") == _psd)), None)
            except bt.TradeError:
                _np = None
            new_qty = _np.get("qty") if _np else None
            _ne = _np.get("entry") if _np else None
            new_entry_chart = (_ne / scale) if (_ne and scale) else _ne     # 合約均價 → 圖表均價
            new_adds = cur_adds + 1
            new_sl_oid = add_old_sl_oid          # 沿用首筆 SL 單 id（不動）
            new_sl_chart = None                  # 不改 sl 欄（維持首筆止損價）
            sl_note = "止損固定首筆、不隨加倉移動"

            try:
                _c2, _ph2 = _acct._db()
                try:
                    if new_sl_chart is not None:                 # 有移動 → 連 sl/sl_oid 一起更新
                        _c2.execute(
                            f"UPDATE trade_log SET qty={_ph2}, entry={_ph2}, adds={_ph2}, "
                            f"sl={_ph2}, sl_oid={_ph2} WHERE id={_ph2}",
                            (str(new_qty) if new_qty is not None else None,
                             str(new_entry_chart) if new_entry_chart is not None else None,
                             new_adds, str(round(new_sl_chart, 8)),
                             str(new_sl_oid) if new_sl_oid is not None else None, add_row_id))
                    else:                                        # 沒移動 → 只更新 qty/entry/adds
                        _c2.execute(
                            f"UPDATE trade_log SET qty={_ph2}, entry={_ph2}, adds={_ph2} WHERE id={_ph2}",
                            (str(new_qty) if new_qty is not None else None,
                             str(new_entry_chart) if new_entry_chart is not None else None,
                             new_adds, add_row_id))
                    _c2.commit()
                finally:
                    _c2.close()
            except Exception:
                pass
            envtag = "實盤" if client.env == "live" else "測試網"
            dir_emoji = "📉" if want == "short" else "📈"
            l1 = f"{dir_emoji} 第 {new_adds} 筆 · {'做空' if want == 'short' else '做多'} · {envtag}"
            l2 = f"加倉 {_fmt_px(entry)} · 數量 +{qty}"
            l3 = f"均價 {_fmt_px(new_entry_chart) if new_entry_chart else '—'} · {sl_note}"
            # 串接回原進場訊息：用「原進場」的 sig/d/sigt（非本次加倉訊號）→ 加倉像回覆掛在同一串
            _push_owner(owner, f"➕ 自動加倉{dir_emoji} · {symbol}（第{new_adds}筆）", "\n".join([l1, l2, l3]),
                        symbol, tf=tf, event="atrade_open",
                        sig=(add_entry_sig or k), d=(add_entry_d or d), sigt=(add_entry_sigt or str(sig.get("t"))))
            print(f"  ➕ 自動加倉 {client.env}: {bsym} 第{new_adds}筆 +{qty}（{sl_note}）")
            return

        # 先掛停損（自動單的安全命脈）。掛失敗 → 立刻市價平掉剛進的倉，絕不留「無停損保護」
        # 的自動倉位（曾發生：冷門合約不支援條件單 -4120，倉位開了卻沒 SL）。
        sl_oid = None                       # 交易所 SL(algo) 單 id → 加倉時用它精準取消重掛
        try:
            _osl = client.place_close_trigger(bsym, close_side, sl_px, "sl", position_side=_psd)
            sl_oid = _osl.get("orderId")
        except bt.TradeError as e:
            # 自癒：止損掛不上最常見＝該合約殘留條件單塞滿 algo 上限(每合約~20)→ -4509。走到這代表
            # 進場前無持倉（is_add 早已 return）→ 該合約所有 algo 條件單必為孤兒 → 清掉後重試一次。
            # ⚠ hedge 帳號不可 cancel_all_algo（會誤撤對向倉的 SL/TP）→ 直接重試一次、不清。
            _sl_ok = False
            try:
                if not _hedge:
                    client.cancel_all_algo(bsym)                           # 清孤兒條件單(端點已修正為 algoOrderList)
                _osl = client.place_close_trigger(bsym, close_side, sl_px, "sl", position_side=_psd)
                sl_oid = _osl.get("orderId")
                _sl_ok = True
                print(f"  ♻ 自動下單 {bsym} 止損 {e} → 重掛成功")
            except bt.TradeError:
                _sl_ok = False
            if not _sl_ok:
                try:
                    client.close_position(bsym, position_side=_psd)
                except bt.TradeError:
                    pass
                _log_trade(source="auto", acct=name, mode=client.env, status="failed", symbol=symbol, bsym=bsym, side=want,
                           qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)), sig=k, d=d, tf=tf,
                           sigt=str(sig.get("t")),
                           msg=f"停損無法掛單（{e}）→ 已清殘單仍失敗 → 即時平倉，不留無保護持倉")
                _push_owner(owner, f"⚠ 自動進場取消 · {symbol}",
                            f"停損無法掛單（已試清殘單仍失敗）、為避免無保護持倉已即時平倉\n{e}",
                            symbol, tf=tf, event="atrade")
                print(f"  ⚠ 自動下單 {bsym} 停損掛單失敗（清殘單後仍失敗），已平倉：{e}")
                return
        warn = []
        if _size_warn:
            warn.append(_size_warn)
        tp_oid = None
        if tp_px:
            try:
                _otp = client.place_close_trigger(bsym, close_side, tp_px, "tp", position_side=_psd)
                tp_oid = _otp.get("orderId")    # 存 TP(algo) 單 id → 之後「跟著中軌移動」用 id 精準取消重掛
            except bt.TradeError as e:
                warn.append(f"TP 掛單失敗（不影響停損保護）：{e}")
        _log_trade(source="auto", acct=name, mode=client.env, status="open", symbol=symbol, bsym=bsym, side=want,
                   qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)),
                   tp=(str(round(tgt, 8)) if (tp_px and tgt is not None) else None), tp_oid=tp_oid, sl_oid=sl_oid,
                   sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg="；".join(warn) or None)
        # 通知擁有者：自動進場（方向用 📈做多 / 📉做空 一眼看出）
        envtag = "實盤" if client.env == "live" else "測試網"
        dir_emoji = "📉" if want == "short" else "📈"
        dir_txt = f"{dir_emoji} {'做空' if want == 'short' else '做多'}"
        l1 = f"{dir_txt} · {lev}x · 數量 {qty} · {envtag}"
        l2 = f"進場 {_fmt_px(entry)}" + (f" → 止盈 {_fmt_px(tgt)}" if (tp_px and tgt is not None) else "")
        l3 = f"停損 {_fmt_px(stop_chart)}"
        body = "\n".join([l1, l2, l3]) + (f"\n⚠ {_size_warn}" if _size_warn else "")
        _push_owner(owner, f"{dir_emoji} 自動進場{'做空' if want == 'short' else '做多'} · {symbol}（{envtag}）",
                    body, symbol, tf=tf, event="atrade_open", sig=k, d=d, sigt=str(sig.get("t")))
        print(f"  🤖 自動下單 {client.env}: {bsym} {side} {qty}（{symbol} {tf} "
              f"{k}/{d}）" + (f" ⚠{warn}" if warn else ""))
    except Exception as e:
        try:
            _log_trade(source="auto", acct=name, status="failed", symbol=symbol, side=d,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=str(e))
        except Exception:
            pass
        print(f"  ⚠ 自動下單失敗 {name} {symbol} {tf} {k}/{d}：{e}")


def _close_auto_position(owner, client, row_id, bsym, symbol, tf, event, reason,
                         sig=None, d=None, sigt=None, position_side=None):
    """市價平掉一筆自動倉 + 更新紀錄 + 通知 owner（含已實現盈虧）。settle 與 retarget 共用。
    sig/d/sigt：對應的進場訊號鍵/方向/訊號棒時間 → 讓平倉通知能串接到自動進場通知。
    position_side：hedge 帳號傳 LONG/SHORT → 只清/平該側（不碰對向倉）；單向傳 None。"""
    r = client.close_position(bsym, position_side=position_side)   # hedge:分側；單向:取消該合約所有 algo
    msg = reason if r.get("ok") else reason + "（交易所端已先出場）"
    _update_trade(row_id, "closed", msg)
    pnl = None                                    # 實際已實現盈虧：從 income 取最近一筆該合約 REALIZED_PNL
    try:
        for inc in client.income_history(15):
            if inc.get("symbol") == bsym:
                pnl = inc.get("pnl"); break
    except bt.TradeError:
        pass
    result = "止盈" if event == "tp" else "止損"
    icon = "✅" if event == "tp" else "👎"            # 止盈勾勾／止損倒讚
    _xpx = None                                       # 實際出場價（顯示用，讓人一眼核對是不是真的到位）
    try:
        _xpx = client.last_fill_price(bsym)
    except Exception:
        pass
    _xtxt = f"\n出場 @ {_fmt_px(_xpx)}" if _xpx else ""
    # body 保留「已實現盈虧 {±x} USDT」格式（今日摘要正則解析用），後綴賺/賠金額讓人一眼看懂
    if pnl is not None:
        gain = "賺" if pnl >= 0 else "賠"
        body = f"{icon} {result}平倉\n已實現盈虧 {pnl:+.2f} USDT（{gain} {abs(pnl):.2f}）{_xtxt}"
    else:
        body = f"{icon} {result}平倉{_xtxt}"
    _push_owner(owner, f"{icon} 自動{result} · {symbol}", body, symbol, tf=tf,
                event=("atrade_tp" if event == "tp" else "atrade_sl"),
                sig=sig, d=d, sigt=sigt)
    print(f"  🤖 自動平倉 {client.env}: {bsym}（{event}）pnl={pnl}")
    return pnl


def settle_signal_trade(market, exchange, symbol, tf, k, d, sig, event):
    """訊號引擎判定止盈/止損 → 平掉對應自動倉（逐帳號獨立）。
    註：監控器已改走 reconcile_auto_position（盤中觸發單對帳），此函式保留備查。"""
    try:
        if market != "crypto":
            return
        sigt = str(sig.get("t"))
        for name, cfg in get_all_auto_cfgs():
            client, _ = _client_for(name)
            if client is None:
                continue
            _ensure_db()
            conn, ph = _acct._db()
            try:
                row = conn.execute(
                    f"SELECT id, bsym FROM trade_log WHERE source='auto' AND status='open' "
                    f"AND acct={ph} AND symbol={ph} AND tf={ph} AND sig={ph} AND dir={ph} AND sigt={ph} "
                    f"ORDER BY id DESC LIMIT 1",
                    (name, symbol, tf, k, d, sigt)).fetchone()
            finally:
                conn.close()
            if not row:
                continue
            row_id, bsym = row
            reason = "策略止盈平倉" if event == "tp" else "策略止損平倉"
            _close_auto_position(name, client, row_id, bsym, symbol, tf, event, reason,
                                 sig=k, d=d, sigt=sigt)
    except Exception as e:
        print(f"  ⚠ 自動平倉失敗 {symbol} {tf}：{e}")


def reconcile_auto_position(market, exchange, symbol, tf):
    """自動倉出場對帳（逐帳號獨立）：各帳號該『標的×時框』的未平自動倉，若『該帳號』交易所已無持倉
    （止損/止盈觸發單盤中即時已平）→ 補記錄+通知。各帳號用自己的金鑰查自己的持倉、紀錄以 acct 隔離，
    兩人同標的也互不誤判。止盈/止損依該倉已實現盈虧正負判定。冪等：只處理 status='open' 且該帳號交易所已無倉者。"""
    try:
        if market != "crypto":
            return
        for name, cfg in get_all_auto_cfgs():
            try:
                client, _ = _client_for(name)
                if client is None:
                    continue
                _ensure_db()
                conn, ph = _acct._db()
                try:
                    rows = conn.execute(
                        f"SELECT id, bsym, sig, dir, sigt, sl_oid, tp_oid FROM trade_log WHERE source='auto' AND status='open' "
                        f"AND acct={ph} AND symbol={ph} AND tf={ph}", (name, symbol, tf)).fetchall()
                finally:
                    conn.close()
                if not rows:
                    continue
                _hedge = _is_hedge(client)
                try:
                    _poss = client.positions()
                except bt.TradeError:
                    continue
                pos_set = ({(p["symbol"], p.get("posSide")) for p in _poss} if _hedge
                           else {p["symbol"] for p in _poss})
                for row_id, bsym, rsig, rd, rsigt, sl_oid, tp_oid in rows:
                    _rpsd = ("LONG" if rd == "l" else "SHORT") if _hedge else None   # 該倉對應的 positionSide
                    if (((bsym, _rpsd) in pos_set) if _hedge else (bsym in pos_set)):
                        continue                       # 該側仍有持倉 → 未平，跳過
                    # 持倉已不在 → 交易所觸發單已盤中平倉。判止盈/止損：該合約最近一筆已實現盈虧正負。
                    pnl = None
                    try:
                        for inc in client.income_history(30):
                            if inc.get("symbol") == bsym:
                                pnl = inc.get("pnl"); break
                    except bt.TradeError:
                        pass
                    if pnl is None:
                        continue                       # 盈虧尚未入帳 → 下一輪重試（避免誤判/漏記盈虧）
                    # 止盈/止損判定：優先看「哪張觸發單還掛著」（清孤兒前先查）→ 另一張就是已觸發的那張。
                    # 因止盈會跟軌漂到進場價內側、賠錢的止盈出場若只看盈虧正負會被誤標成「止損」（沒到止損就止損）。
                    # 查不到掛單（端點失敗/兩張都沒了）→ 退回用盈虧正負判定。
                    ev = None
                    if sl_oid or tp_oid:
                        open_ids = {str(o.get("algoId")) for o in client.algo_orders(bsym)
                                    if o.get("algoId") and (not _hedge or o.get("posSide") == _rpsd)}
                        if open_ids:
                            sl_open = sl_oid and str(sl_oid) in open_ids
                            tp_open = tp_oid and str(tp_oid) in open_ids
                            if sl_open and not tp_open:
                                ev = "tp"              # 止損單還掛著 → 已觸發的是止盈
                            elif tp_open and not sl_open:
                                ev = "sl"              # 止盈單還掛著 → 已觸發的是止損
                    if ev is None:
                        # 退回判定：固定風險模式下「真止損」≈ 虧掉 riskUsd（有感金額）。若 |pnl| 遠小於它
                        # （<40%），代表是「平盤/止盈附近」出場，不是真止損 → 標止盈，避免賠 0.01 被誤標成止損。
                        # cfg 為巢狀 → 依該列 sig 取對應子設定的 riskUsd（fvg列→fvg、ss列→ss）。
                        _sub = cfg.get("fvg", {}) if rsig == "fvg" else cfg.get("ss", {})
                        _rk = _sub.get("riskUsd") or 0
                        if _rk > 0 and abs(pnl) < _rk * 0.4:
                            ev = "tp"
                        else:
                            ev = "tp" if pnl >= 0 else "sl"
                    try:
                        if not _hedge:                 # 單向：清殘留的另一張觸發單；hedge 由 _close 分側清(不碰對向)
                            client.cancel_all_algo(bsym)
                    except bt.TradeError:
                        pass
                    _close_auto_position(name, client, row_id, bsym, symbol, tf, ev,
                                         "交易所止盈平倉（盤中觸及上下軌）" if ev == "tp" else "交易所止損平倉（盤中觸及停損）",
                                         sig=rsig, d=rd, sigt=rsigt, position_side=_rpsd)
            except Exception as e:
                print(f"  ⚠ 自動倉對帳失敗 {name} {symbol} {tf}：{e}")
    except Exception as e:
        print(f"  ⚠ 自動倉對帳失敗 {symbol} {tf}：{e}")


def _fvg_surge_active(now_ts=None):
    """FVG 爆量風控：全市場(所有自動帳號) 近24h FVG 新掛單數 > 近30日日均 × 2.0 →
    判定為『高波動洗盤 regime』，暫停掛新單。依據 2020-2026 32幣 CAP15 回測：回撤前
    新進場筆數先爆到日均~2~2.5倍(雙向被洗、敗率衝68-72%)；此規則把最大回撤 177→151R(−15%)、
    報酬僅 −1.6%。base<1(資料太少/watchlist太小)→不啟用，避免冷啟誤判。60s 快取，絕不拋例外。"""
    global _surge_cache
    now = now_ts or time.time()
    if _surge_cache and now - _surge_cache["ts"] < 60:
        return _surge_cache["v"]
    active = False
    try:
        _c, _ph = _acct._db()
        try:
            q = (f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND sig='fvg' "
                 f"AND status NOT IN ('skipped','failed') AND ts > {_ph}")
            r24 = _c.execute(q, (now - 86400,)).fetchone()[0]
            n30 = _c.execute(q, (now - 30 * 86400,)).fetchone()[0]
        finally:
            _c.close()
        base = n30 / 30.0
        if base >= 1.0 and r24 > 2.0 * base:
            active = True
    except Exception:
        active = False
    _surge_cache = {"ts": now, "v": active}
    return active


_universe_cache = {"ts": 0.0, "syms": []}   # 成交量前60加密永續宇宙，24h 快取


def top_crypto_universe(n=60):
    """成交量前 n 名加密永續(underlyingType=COIN、USDT報價、PERPETUAL，排除 underlyingSubType 含 'RWA'
    如 PAXG 黃金)→ watchlist 格式 dict 清單(symbol 'BTC/USDT.P' 同自選)。每日重抓(24h 快取);
    失敗回上次快取或空。絕不拋例外。"""
    global _universe_cache
    now = time.time()
    if _universe_cache["syms"] and now - _universe_cache["ts"] < 86400:
        return _universe_cache["syms"][:n]
    try:
        import urllib.request
        info = json.load(urllib.request.urlopen("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=20))
        meta = {s.get("symbol"): s for s in info.get("symbols", [])}
        tk = json.load(urllib.request.urlopen("https://fapi.binance.com/fapi/v1/ticker/24hr", timeout=20))
        rows = []
        for t in tk:
            sym = t.get("symbol"); d = meta.get(sym) or {}
            if d.get("underlyingType") != "COIN" or d.get("contractType") != "PERPETUAL":
                continue
            if not sym or not sym.endswith("USDT"):
                continue
            if "RWA" in (d.get("underlyingSubType") or []):       # 排除黃金/RWA(PAXG 等代幣化實體資產)
                continue
            rows.append((sym, float(t.get("quoteVolume", 0) or 0)))
        rows.sort(key=lambda x: x[1], reverse=True)
        out = [{"symbol": f"{sym[:-4]}/USDT.P", "market": "crypto", "exchange": "pionex"}
               for sym, _ in rows[:max(n, 60)]]
        if out:
            _universe_cache = {"ts": now, "syms": out}
    except Exception as e:
        print(f"  ⚠ 取成交量宇宙失敗：{e}")
    return _universe_cache["syms"][:n]


def fvg_account_symbols(name, fvg_cfg):
    """此帳號 FVG 要掃/掛的標的(watchlist 格式)：universe=top60 → 成交量前60;否則該帳號自選。"""
    if (fvg_cfg or {}).get("universe") == "top60":
        return top_crypto_universe(60)
    import routes.notify as notify
    return notify.account_watchlist(name)


def place_fvg_limit_ladder(name, cfg, market, exchange, symbol, tf, gap):
    """FVG 限價階梯版（影線版）進場：缺口 top/mid/bot 各掛 ⅓ 限價單(maker, GTC)。
    gap={"t","top","bot","d"}(圖表價)。只 1h、用此帳號自己金鑰/自選/方向過濾。SL/TP 不在此掛——
    成交後由 reconcile_fvg_pending 掛 closePosition 觸發單；殘單/過期/平倉撤殘單亦由其管理。絕不拋例外。"""
    if market != "crypto":
        return
    try:
        import routes.notify as notify
        d = gap.get("d"); top = float(gap["top"]); bot = float(gap["bot"])
        if top <= bot:
            return
        want = "short" if d == "s" else "long"
        if cfg["dirs"] != "both" and cfg["dirs"] != want:
            return
        # 爆量風控：高波動洗盤 regime 暫停掛新單(在 mark_event 之前→regime 解除後缺口仍可重掛)
        if _fvg_surge_active():
            print(f"  ⏸ FVG爆量風控跳過 {symbol}（{name}）：近24h新進場>近月日均2x，暫停新單")
            return
        evt = f"fvglimit:{name}:{symbol}:{tf}:{d}:{gap.get('t')}"
        if notify.seen_event(evt):
            return
        notify.mark_event(evt)
        client, _ = _client_for(name)
        if client is None:
            return
        if symbol not in {(w.get("symbol") or "") for w in fvg_account_symbols(name, cfg)}:
            return                                   # universe=top60 → 比對成交量前60;否則自選
        bsym, scale = client.resolve_symbol(symbol)
        _hedge = _is_hedge(client)               # 雙向持倉 → 同幣多空各一槽；單向 → 同幣只一組
        _psd = _posside(want, _hedge)
        # 去重：單向 per-symbol（同幣多空互沖、cancel_all 會誤撤對向 → 只一組）；
        #       hedge per-(symbol×方向)（多空分倉、各自 SL/TP → 同幣可多空兩組）。並守 maxPos。
        _c, _ph = _acct._db()
        try:
            if _hedge:
                _dup = _c.execute(
                    f"SELECT 1 FROM trade_log WHERE source='auto' AND sig='fvg' AND status IN ('pending','open') "
                    f"AND acct={_ph} AND symbol={_ph} AND tf={_ph} AND dir={_ph} LIMIT 1",
                    (name, symbol, tf, d)).fetchone()
            else:
                _dup = _c.execute(
                    f"SELECT 1 FROM trade_log WHERE source='auto' AND sig='fvg' AND status IN ('pending','open') "
                    f"AND acct={_ph} AND symbol={_ph} AND tf={_ph} LIMIT 1", (name, symbol, tf)).fetchone()
            _open_n = _c.execute(
                f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND sig='fvg' "
                f"AND status IN ('pending','open') AND acct={_ph}", (name,)).fetchone()   # 只算 FVG 自己的倉
        finally:
            _c.close()
        if _dup:
            return
        if _open_n and _open_n[0] >= int(cfg.get("maxPos", 15) or 15):
            return
        W = top - bot
        wr = W / (top if want == "long" else bot)
        # 2% 寬度上限：缺口寬 > 價格 2% → 止盈打不到、抱久擋倉位，跳過不掛。
        if wr > 0.02:
            return
        _mid = (top + bot) / 2.0
        if wr > 0.012:                                             # 過寬(1.2%~2%)：上框+中間、止損=框、止盈3W、不深檔拉近
            levels = [top, _mid] if want == "long" else [_mid, bot]
            stop = bot if want == "long" else top
            tp   = (top + 3 * W) if want == "long" else (bot - 3 * W)
        else:                                                     # 窄缺口：三檔、止損2W、止盈6W、可深檔拉近
            levels = [top, _mid, bot]
            stop = (bot - 2 * W) if want == "long" else (top + 2 * W)
            tp   = (top + 6 * W) if want == "long" else (bot - 6 * W)
        _wide = wr > 0.012
        risk_usd = cfg.get("riskUsd") or 0
        lev_cap = max(1, min(int(cfg["lev"]), 50))
        mid = _mid
        stop_pct = abs(mid - stop) / mid if mid else 0.05
        _ntr = len(levels)                                         # 檔數(窄=3、過寬=2)：每檔風險均分
        try:
            max_lev, mmr = client.lev_bracket(bsym)
        except Exception:
            max_lev, mmr = 50, 0.0
        safe_lev = int(1.0 / (stop_pct * 1.25 + mmr)) if (stop_pct * 1.25 + mmr) > 0 else max_lev
        if risk_usd > 0:
            lev = max(1, min(safe_lev, max_lev, 50))           # 止損額模式：槓桿由「止損距離」自動算(不受設定槓桿上限)
        else:
            lev = max(1, min(lev_cap, safe_lev, max_lev, 50))  # 保證金模式：用你設的槓桿(仍受安全上限)
        try:
            client.set_leverage(bsym, lev)
        except bt.TradeError:
            pass
        fee = 0.0005
        side = "BUY" if want == "long" else "SELL"
        orders = []
        for lv in levels:
            lv_c = lv * scale; s_c = stop * scale
            if risk_usd > 0:
                per = abs(lv_c - s_c) + fee * lv_c + fee * s_c          # 每單位虧損(含來回手續費)
                qb = (risk_usd / _ntr) / per if per > 0 else 0
            else:
                qb = ((cfg["usdt"] / _ntr) * lev) / lv_c if lv_c else 0  # 保證金模式：每檔 usdt/檔數 × lev
            qty = client.quantize_qty(bsym, qb)
            try:
                px = client.quantize_price(bsym, lv_c)
                o = client.place_order(bsym, side, qty, "LIMIT", price=px, position_side=_psd)
                orders.append({"oid": o.get("orderId"), "level": lv, "px": px, "qty": qty})
            except bt.TradeError as e:
                orders.append({"oid": None, "level": lv, "qty": qty, "err": str(e)[:80]})
        placed = [o for o in orders if o.get("oid")]
        extra = json.dumps({"top": top, "bot": bot, "orders": orders, "gap_t": gap.get("t"), "wide": _wide})
        _log_trade(source="auto", acct=name, mode=client.env,
                   status="pending" if placed else "failed",
                   symbol=symbol, bsym=bsym, side=want, sig="fvg", d=d, tf=tf,
                   sigt=str(gap.get("t")), sl=str(round(stop, 8)), tp=str(round(tp, 8)),
                   entry=str(round(mid, 8)), extra=extra,
                   msg=(f"FVG限價階梯 掛 {len(placed)}/{_ntr} 檔" if placed else "FVG限價階梯 全部掛單失敗"))
        if placed:
            envtag = "實盤" if client.env == "live" else "測試網"
            dir_emoji = "📉" if want == "short" else "📈"
            _push_owner(name, f"⏳ FVG限價掛單{dir_emoji} · {symbol}（{envtag}）",
                        f"{'做空' if want == 'short' else '做多'} · 缺口 {_fmt_px(bot)}~{_fmt_px(top)}\n"
                        f"掛 {len(placed)}/{_ntr} 檔限價 · 止損 {_fmt_px(stop)} · 止盈 {_fmt_px(tp)}",
                        symbol, tf=tf, event="atrade_open", sig="fvg", d=d, sigt=str(gap.get("t")))
        print(f"  ⏳ FVG限價階梯 {client.env}: {bsym} {side} 掛{len(placed)}/{_ntr}（{symbol} {tf} {d}）")
    except Exception as e:
        print(f"  ⚠ FVG限價掛單失敗 {name} {symbol}：{e}")


def reconcile_fvg_pending(market, exchange, symbol, tf):
    """FVG 限價階梯版生命週期對帳（逐帳號、每根 1h 收盤）：
    ① pending 且已有持倉(≥1 檔成交) → 掛 SL/TP closePosition + status→open（之後平倉交給 reconcile_auto_position；
       其 close_position 會 cancel_all 一併撤殘單＝止盈/止損撤殘單）。SL 掛不上 → 自癒重試→仍失敗就市價平倉，
       絕不留無保護持倉。② 過期(168 根=一週)未成交 → 撤殘單 + status expired。絕不拋例外。"""
    try:
        if market != "crypto" or tf != "1h":
            return
        import calendar
        for name, cfg in get_all_auto_cfgs():
            try:
                _ensure_db()
                conn, ph = _acct._db()
                try:
                    rows = conn.execute(
                        f"SELECT id, bsym, dir, sl, tp, extra FROM trade_log WHERE source='auto' AND sig='fvg' "
                        f"AND status='pending' AND acct={ph} AND symbol={ph} AND tf={ph}",
                        (name, symbol, tf)).fetchall()
                finally:
                    conn.close()
                if not rows:
                    continue
                client, _ = _client_for(name)
                if client is None:
                    continue
                bs0, scale = client.resolve_symbol(symbol)
                _hedge = _is_hedge(client)
                for row_id, bsym, d, sl_s, tp_s, extra_s in rows:
                    _psd = _posside("short" if d == "s" else "long", _hedge)
                    try:
                        ex = json.loads(extra_s) if extra_s else {}
                    except Exception:
                        ex = {}
                    oids = [str(o.get("oid")) for o in (ex.get("orders") or []) if o.get("oid")]
                    try:
                        resting = {str(o["orderId"]) for o in client.open_orders(bsym)}
                        _pos = next((p for p in client.positions()
                                     if p["symbol"] == bsym and (not _hedge or p.get("posSide") == _psd)), None)
                        has_pos = _pos is not None
                    except bt.TradeError:
                        continue
                    gt = ex.get("gap_t")
                    try:
                        gep = calendar.timegm(time.strptime(str(gt)[:19], "%Y-%m-%dT%H:%M:%S")) if gt else None
                    except Exception:
                        gep = None
                    expired = (gep is not None) and (time.time() - gep > 168 * 3600)

                    if has_pos:
                        # ≥1 檔成交 → 掛 SL/TP closePosition、狀態轉 open
                        want = "short" if d == "s" else "long"
                        close_side = "SELL" if want == "long" else "BUY"
                        sl_px = client.quantize_price(bsym, float(sl_s) * scale)
                        tp_px = client.quantize_price(bsym, float(tp_s) * scale)
                        sl_oid = tp_oid = None
                        try:
                            sl_oid = client.place_close_trigger(bsym, close_side, sl_px, "sl", position_side=_psd).get("orderId")
                        except bt.TradeError:
                            try:
                                if not _hedge: client.cancel_all_algo(bsym)   # hedge 不可清(誤撤對向)
                                sl_oid = client.place_close_trigger(bsym, close_side, sl_px, "sl", position_side=_psd).get("orderId")
                            except bt.TradeError:
                                sl_oid = None
                        if not sl_oid:
                            # 止損掛不上：分辨「真的到/穿止損(本就該平)」vs「暫時性(插針已回/API抽搐/帶寬)→該重試別亂平」
                            mark = float((_pos or {}).get("mark") or 0)
                            stopf = float(sl_s)
                            past_stop = (mark <= stopf) if want == "long" else (mark >= stopf)
                            nfail = int(ex.get("slfail", 0)) + 1
                            if (not past_stop) and mark > 0 and nfail < 5:
                                # 價格還沒到止損 + 失敗<5次 → 不平倉、保留 pending、下個 tick(~60s)重試掛止損
                                ex["slfail"] = nfail
                                c3, ph3 = _acct._db()
                                try:
                                    c3.execute(f"UPDATE trade_log SET extra={ph3} WHERE id={ph3}",
                                               (json.dumps(ex), row_id)); c3.commit()
                                finally:
                                    c3.close()
                                print(f"  ⟳ FVG止損暫掛不上(現價未到止損)、保留重試 {nfail}/5：{bsym}")
                                continue
                            # 真的到/穿止損，或連 5 次仍掛不上(無法保護) → 撤殘單 + 市價平倉
                            for oid in oids:
                                if oid in resting:
                                    try: client.cancel_order(bsym, oid)
                                    except bt.TradeError: pass
                            try: client.close_position(bsym, position_side=_psd)
                            except bt.TradeError: pass
                            _rsn = "已到止損價" if past_stop else "止損連5次掛不上、無法保護"
                            _update_trade(row_id, "failed", f"FVG限價成交但{_rsn}→已市價平倉")
                            _push_owner(name, f"⚠ FVG限價平倉 · {symbol}", f"成交後{_rsn}、已即時平倉", symbol,
                                        tf=tf, event="atrade", sig="fvg", d=d, sigt=str(gt))
                            continue
                        try:
                            tp_oid = client.place_close_trigger(bsym, close_side, tp_px, "tp", position_side=_psd).get("orderId")
                        except bt.TradeError:
                            tp_oid = None
                        if expired:                                  # 過期 → 撤掉仍未成交的階梯殘單(不再補成交同缺口)
                            for oid in oids:
                                if oid in resting:
                                    try: client.cancel_order(bsym, oid)
                                    except bt.TradeError: pass
                        c2, ph2 = _acct._db()
                        try:
                            c2.execute(
                                f"UPDATE trade_log SET status='open', sl_oid={ph2}, tp_oid={ph2}, msg={ph2} WHERE id={ph2}",
                                (str(sl_oid), str(tp_oid) if tp_oid else None,
                                 "FVG限價成交→已掛SL/TP" + ("（TP掛單失敗）" if not tp_oid else ""), row_id))
                            c2.commit()
                        finally:
                            c2.close()
                        envtag = "實盤" if client.env == "live" else "測試網"
                        _push_owner(name, f"✅ FVG限價成交 · {symbol}（{envtag}）",
                                    f"已成交、掛上止損 {_fmt_px(float(sl_s))} / 止盈 {_fmt_px(float(tp_s))}"
                                    + ("\n⚠ 止盈單掛單失敗" if not tp_oid else ""),
                                    symbol, tf=tf, event="atrade_open", sig="fvg", d=d, sigt=str(gt))
                        print(f"  ✅ FVG限價成交 {client.env}: {bsym} → 掛SL/TP，轉 open")
                    elif expired:
                        # 從未成交且過期 → 撤所有殘單、標 expired
                        for oid in oids:
                            if oid in resting:
                                try: client.cancel_order(bsym, oid)
                                except bt.TradeError: pass
                        _update_trade(row_id, "expired", "FVG限價 168 根未成交→撤單作廢")
                        _push_owner(name, f"⌛ FVG限價過期 · {symbol}", "缺口掛單一週未成交、已撤單作廢",
                                    symbol, tf=tf, event="atrade", sig="fvg", d=d, sigt=str(gt))
            except Exception as e:
                print(f"  ⚠ FVG限價對帳失敗 {name} {symbol}：{e}")
    except Exception as e:
        print(f"  ⚠ FVG限價對帳失敗 {symbol}：{e}")


def reconcile_fvg_pending_all():
    """每次監控 tick（~60s）都跑、不等 1h 收盤：找出所有『pending 的 FVG 列』、對已成交的
    立刻掛 SL/TP，把『成交→止損』的裸窗從最多 1 小時縮到 ~60 秒（降低成交後止損掛不上/裸奔）。
    只對『真的有 pending FVG』的標的打交易所 API → 成本受限。idempotent：已轉 open 的列不再處理。"""
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            rows = conn.execute(
                "SELECT DISTINCT symbol, tf FROM trade_log "
                "WHERE source='auto' AND sig='fvg' AND status='pending'").fetchall()
        finally:
            conn.close()
        for symbol, tf in rows:
            try:
                reconcile_fvg_pending("crypto", "binance", symbol, tf or "1h")
            except Exception:
                pass
    except Exception as e:
        print(f"  ⚠ FVG即時止損對帳失敗：{e}")


def push_auto_status():
    """每 ~10 分鐘推播自動交易狀況給各 owner：餘額、持倉數/未實現盈虧、FVG 掛單數。絕不拋例外。"""
    try:
        for name, cfg in get_all_auto_cfgs():
            try:
                client, _ = _client_for(name)
                if client is None:
                    continue
                bal = client.balance()
                poss = client.positions()
                upnl = sum(p["upnl"] for p in poss)
                _ensure_db()
                conn, ph = _acct._db()
                try:
                    pend = conn.execute(
                        f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND sig='fvg' "
                        f"AND status='pending' AND acct={ph}", (name,)).fetchone()[0]
                finally:
                    conn.close()
                envtag = "實盤" if client.env == "live" else "測試網"
                syms = "、".join(sorted({p["symbol"].replace("USDT", "") for p in poss}))[:80] or "無持倉"
                body = (f"餘額 {bal['total']:.2f}U（可用 {bal['available']:.2f}）\n"
                        f"持倉 {len(poss)} 筆 · 未實現 {upnl:+.2f}U\n"
                        f"FVG 掛單 {pend} 筆\n{syms}")
                _push_owner(name, f"📊 自動交易狀況（{envtag}）", body, "", event="atrade_status")
            except Exception:
                pass
    except Exception as e:
        print(f"  ⚠ 狀況推播失敗：{e}")


def reconcile_fvg_deepfill(market, exchange, symbol, tf):
    """FVG 深檔拉近（定版 6/6/2）：監控 open 的 FVG 限價倉，若『底檔(最深那張)已成交』
    (=三檔全中、價格插到底、近止損)且止盈還在 6W → 撤舊 TP、改掛 2W 近止盈快跑。
    1-2 檔成交維持 6W(讓淺觸反彈跑滿)；3 檔全成交才收緊。每根 1h 收盤呼叫一次。絕不拋例外。"""
    try:
        if market != "crypto" or tf != "1h":
            return
        for name, cfg in get_all_auto_cfgs():
            try:
                _ensure_db()
                conn, ph = _acct._db()
                try:
                    rows = conn.execute(
                        f"SELECT id, bsym, dir, tp_oid, extra FROM trade_log WHERE source='auto' AND sig='fvg' "
                        f"AND status='open' AND acct={ph} AND symbol={ph} AND tf={ph}",
                        (name, symbol, tf)).fetchall()
                finally:
                    conn.close()
                if not rows:
                    continue
                client, _ = _client_for(name)
                if client is None:
                    continue
                _hedge = _is_hedge(client)
                _, scale = client.resolve_symbol(symbol)
                for row_id, bsym, d, tp_oid, extra_s in rows:
                    try:
                        ex = json.loads(extra_s) if extra_s else {}
                    except Exception:
                        ex = {}
                    if ex.get("tp2w") or ex.get("wide"):
                        continue                                  # 已收緊過、或過寬缺口(止盈固定3W、本就不拉近) → 不動
                    top = ex.get("top"); bot = ex.get("bot")
                    if not top or not bot or top <= bot:
                        continue
                    W = top - bot
                    want = "short" if d == "s" else "long"
                    deep_lv = bot if want == "long" else top       # 最深檔：多=缺口底、空=缺口頂
                    deep_oid = next((str(o.get("oid")) for o in (ex.get("orders") or [])
                                     if o.get("oid") and abs(float(o.get("level", 0)) - deep_lv) <= W * 0.02), None)
                    if not deep_oid:
                        continue                                  # 底檔當初沒掛上 → 無法追蹤、不動
                    try:
                        resting = {str(o["orderId"]) for o in client.open_orders(bsym)}
                    except bt.TradeError:
                        continue
                    if deep_oid in resting:
                        continue                                  # 底檔還掛著(未成交) → 不是三檔全中、不收緊
                    # 底檔已成交(三檔全中) → 止盈收到 2W
                    psd = _posside(want, _hedge)
                    close_side = "SELL" if want == "long" else "BUY"
                    new_tp = (top + 2 * W) if want == "long" else (bot - 2 * W)
                    new_tp_px = client.quantize_price(bsym, new_tp * scale)
                    try:
                        if tp_oid: client.cancel_algo(bsym, tp_oid)
                    except bt.TradeError:
                        pass
                    try:
                        new_oid = client.place_close_trigger(bsym, close_side, new_tp_px, "tp", position_side=psd).get("orderId")
                    except bt.TradeError:
                        new_oid = None
                    ex["tp2w"] = True
                    c2, ph2 = _acct._db()
                    try:
                        c2.execute(
                            f"UPDATE trade_log SET tp_oid={ph2}, tp={ph2}, extra={ph2}, msg={ph2} WHERE id={ph2}",
                            (str(new_oid) if new_oid else tp_oid, str(round(new_tp, 8)),
                             json.dumps(ex), "FVG三檔全成交→止盈收緊2W", row_id))
                        c2.commit()
                    finally:
                        c2.close()
                    _push_owner(name, f"🎯 FVG深檔拉近 · {symbol}",
                                f"三檔全成交、止盈收緊到 {_fmt_px(new_tp)}（2W 快跑）",
                                symbol, tf=tf, event="atrade", sig="fvg", d=d, sigt=str(ex.get("gap_t")))
                    print(f"  🎯 FVG深檔拉近 {client.env}: {bsym} TP→2W {_fmt_px(new_tp)}")
            except Exception as e:
                print(f"  ⚠ FVG深檔拉近失敗 {name} {symbol}：{e}")
    except Exception as e:
        print(f"  ⚠ FVG深檔拉近失敗 {symbol}：{e}")


def retarget_auto_tp(market, exchange, symbol, tf, upper_chart, lower_chart):
    """TP 跟著上下軌移動（逐帳號獨立）：用最新上下軌把各帳號該「標的×時框」未平自動倉的交易所 TP 單
    取消重掛到對應軌（空→下軌、多→上軌）。只動 TP（用 algoId 精準取消）→ 絕不碰 SL。目標軌已越過
    現價(達成側)→ 即時市價平倉。每根 K 收盤呼叫一次。絕不拋例外。
    ⚠ 止盈目標一律夾在「含手續費的保本價」內側（多單不低於進場、空單不高於進場）→ 軌漂到進場價虧損側
       時 TP 停在保本價，絕不掛成賠錢出場（避免「沒到止損就賠錢出」）。虧損出場只由止損單負責。"""
    try:
        if market != "crypto":
            return
        for name, cfg in get_all_auto_cfgs():
            try:
                _ensure_db()
                conn, ph = _acct._db()
                try:
                    rows = conn.execute(
                        f"SELECT id, bsym, dir, tp, tp_oid, sig, sigt, COALESCE(rev,0) FROM trade_log WHERE source='auto' "
                        f"AND status='open' AND acct={ph} AND symbol={ph} AND tf={ph}", (name, symbol, tf)).fetchall()
                finally:
                    conn.close()
                if not rows:
                    continue                            # 此帳號此標的×時框無未平自動倉 → 不碰交易所
                client, _ = _client_for(name)
                if client is None:
                    continue
                bsym0, scale = client.resolve_symbol(symbol)
                px = client.last_price(bsym0)
                # 淨倉均價（合約價）→ 算「含來回手續費的保本價」，止盈絕不掛到保本價的虧損側（見下）。
                try:
                    _pos_map = {p["symbol"]: p for p in client.positions()}
                except bt.TradeError:
                    _pos_map = {}
                fee = 0.0005                                # 與開倉/加倉計算一致（吃單 0.05%/邊）
                # 止盈目標＝「下軌→上軌的 _AUTO_TP_BAND_RATIO 位」（多單靠上軌、空單鏡像靠下軌），
                # 取代滿格外軌。需上下軌齊備，缺一即無法算此比例位 → 該輪不動 TP。
                if upper_chart is None or lower_chart is None \
                   or upper_chart != upper_chart or lower_chart != lower_chart:
                    continue
                _bwidth = upper_chart - lower_chart
                for row_id, bsym, d, old_tp, tp_oid, rsig, rsigt, _rev in rows:
                    if _rev or rsig == "fvg":
                        continue                        # 反向倉 / FVG 倉：SL/TP 固定不追蹤軌，retarget 不碰
                    try:
                        want = "short" if d == "s" else "long"
                        # 98% 位：多＝下軌+ratio×寬、空＝下軌+(1−ratio)×寬（鏡像，靠下軌）
                        band = (lower_chart + _AUTO_TP_BAND_RATIO * _bwidth) if want == "long" \
                               else (lower_chart + (1.0 - _AUTO_TP_BAND_RATIO) * _bwidth)
                        # ── 夾住保本價：上下軌會隨行情漂到「進場價的虧損側」（多單軌跌破進場、空單軌漲過
                        #    進場）→ 若直接把止盈掛在軌上，TAKE_PROFIT 觸發＝賠錢出場，會「沒到止損就賠錢出」。
                        #    這裡把止盈目標夾在含手續費的保本價：多單 TP≥E(1+fee)/(1−fee)、空單 TP≤E(1−fee)/(1+fee)。
                        #    虧損出場只由止損單負責；軌在保本價內側時就停在保本價（不會提早認賠）。
                        tp_c = float(band) * scale          # 軌目標（合約價）
                        e_c = (_pos_map.get(bsym) or {}).get("entry")
                        if e_c:
                            be = e_c * (1 + fee) / (1 - fee) if want == "long" else e_c * (1 - fee) / (1 + fee)
                            tp_c = max(tp_c, be) if want == "long" else min(tp_c, be)
                        new_tp_px = client.quantize_price(bsym0, tp_c)
                        new_tp_f = float(new_tp_px)
                        # ── 只進不退(ratchet)：止盈只往獲利方向移（多單往上、空單往下），不往進場價拉回。
                        #    避免軌暫時下飄把止盈一路拉到保本價 → 小回檔就平盤出場(曾發生 BTC 賠 0.01「止損」)。
                        #    要嘛漲/跌到目標獲利出、要嘛打到真止損出，不再被拉回平盤。
                        if old_tp is not None:
                            try:
                                _otp = float(old_tp)
                                new_tp_f = max(new_tp_f, _otp) if want == "long" else min(new_tp_f, _otp)
                                new_tp_px = client.quantize_price(bsym0, new_tp_f)
                            except (TypeError, ValueError):
                                pass
                        # 目標已碰到/越過現價＝達成側 → 立刻市價平倉（碰到就馬上止盈，避免掛不了 TP 又裸著）。
                        if (want == "long" and new_tp_f <= px) or (want == "short" and new_tp_f >= px):
                            _close_auto_position(name, client, row_id, bsym, symbol, tf,
                                                 "tp", "策略止盈平倉(止盈位觸及，即時平倉)", sig=rsig, d=d, sigt=rsigt)
                            continue
                        if old_tp is not None and str(new_tp_px) == str(old_tp):
                            continue                    # 軌沒移動（同 tick）→ 不動，免徒增掛單
                        close_side = "SELL" if want == "long" else "BUY"
                        if tp_oid:                       # 先用 id 取消舊 TP（取消失敗＝已不存在，無妨）；SL 完全不碰
                            try:
                                client.cancel_algo(bsym, tp_oid)
                            except bt.TradeError:
                                pass
                        o = client.place_close_trigger(bsym, close_side, new_tp_px, "tp")
                        _set_trade_tp(row_id, str(new_tp_px), o.get("orderId"))
                    except bt.TradeError as e:
                        print(f"  ⚠ TP 移動失敗 {bsym}：{e}")
            except Exception as e:
                print(f"  ⚠ retarget_auto_tp 失敗 {name} {symbol} {tf}：{e}")
    except Exception as e:
        print(f"  ⚠ retarget_auto_tp 失敗 {symbol} {tf}：{e}")


# ── request models ────────────────────────────────────────────
class KeyReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None       # 登入帳號（owner 白名單檢查用）


class OrderReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    symbol: str                      # 圖表符號，如 BTC/USDT.P
    side: str                        # long / short
    type: str = "MARKET"             # MARKET / LIMIT
    usdt: float                      # 保證金（名目 = usdt × lev）
    lev: int = 3
    price: Optional[float] = None    # 限價（圖表價）
    sl: Optional[float] = None       # 停損（圖表價）
    tp: Optional[float] = None       # 止盈（圖表價）


class CloseReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    bsym: str                        # Binance 合約符號（持倉列回傳的）


class CancelReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    bsym: str
    orderId: int


class PosModeReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    hedge: bool = False


class AutoReq(BaseModel):
    key: Optional[str] = None
    name: Optional[str] = None
    cfg: dict


class SaveKeyReq(BaseModel):
    name: str
    tkey: str


class MyKeyReq(BaseModel):
    name: str


# ── endpoints ─────────────────────────────────────────────────
@router.get("/status")
def status(name: str = ""):
    """全域 + 此帳號的交易可用性。
    canTrade=此帳號能否交易（自綁金鑰 或 擁有者帳號有 env 金鑰）→ 前端據此決定是否顯示入口。
    hasOwnKeys=此帳號是否自綁了金鑰；env=此帳號將使用的環境（testnet/live）。"""
    nm = _acct._norm_name(name or "")
    own = _own_creds(nm) if nm else None
    client, is_env_owner = _client_for(nm) if nm else (None, False)
    return {
        "envConfigured": bt.env_configured(),     # 全域 env 是否設了金鑰（給擁有者）
        "owner": _OWNER,
        "locked": _locked(),
        "allowed": _allowed(nm),                  # 此帳號是否在白名單（可看入口/綁金鑰）
        "isEnvOwner": bool(_OWNER and nm and _acct._norm_name(nm) == _acct._norm_name(_OWNER)),
        "canTrade": client is not None,           # 此帳號當下能否交易（有金鑰）
        "hasOwnKeys": own is not None,
        "usingEnv": is_env_owner,                 # 此帳號用的是共用 env 金鑰（擁有者）
        "env": (own[2] if own else (bt.env_name() if is_env_owner else "testnet")),
        "hedge": (_is_hedge(client) if client else False),   # 目前持倉模式（雙向=FVG 雙槽）
    }


# ── 綁定 Binance 金鑰（每帳號各自）──────────────────────────────
class BindReq(BaseModel):
    name: str
    api_key: str
    api_secret: str
    env: str = "testnet"


class CredReq(BaseModel):
    name: str


@router.post("/bind")
def bind_keys(req: BindReq):
    """綁定/更新此帳號的 Binance 金鑰：先驗證能查餘額 → Secret 加密入庫。"""
    name = _acct._norm_name(req.name)
    if not name:
        raise HTTPException(400, "請先登入帳號")
    if not _allowed(name):
        raise HTTPException(403, "此帳號未獲准使用交易功能（請管理員加入白名單）")
    ak = (req.api_key or "").strip()
    sk = (req.api_secret or "").strip()
    env = bt.norm_env(req.env)
    if not ak or not sk:
        raise HTTPException(400, "請填入 API Key 與 Secret")
    # 禁止用「共用 env 帳戶」的金鑰去綁別的帳號（避免冒用擁有者帳戶）
    if bt.env_configured() and ak == bt._ENV_API_KEY and _acct._norm_name(name) != _acct._norm_name(_OWNER):
        raise HTTPException(403, "此金鑰為共用帳戶金鑰，不可綁到其他帳號")
    try:
        bal = bt.verify_keys(ak, sk, env)        # 驗證金鑰可用（並確認 env 對）
    except bt.TradeError as e:
        raise HTTPException(400, f"金鑰驗證失敗：{e}")
    _ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO trade_creds (name, api_key, secret_enc, env, updated_at) "
            f"VALUES ({ph},{ph},{ph},{ph},{ph}) "
            f"ON CONFLICT (name) DO UPDATE SET api_key=excluded.api_key, "
            f"secret_enc=excluded.secret_enc, env=excluded.env, updated_at=excluded.updated_at",
            (name, ak, _enc(sk), env, time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "env": env, "balance": bal}


@router.post("/unbind")
def unbind_keys(req: CredReq):
    """解除此帳號自綁的金鑰（之後此帳號不能交易，除非它是擁有者退回 env）。"""
    name = _acct._norm_name(req.name)
    if not name:
        raise HTTPException(400, "缺少帳號")
    _ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute(f"DELETE FROM trade_creds WHERE name={ph}", (name,))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/savekey")
def save_key(req: SaveKeyReq):
    """把交易口令綁到帳號（寫穿表）→ 換裝置登入即可取回、不必再輸。
    存的是門禁口令（非 Binance 金鑰）；以帳號名稱為識別，與帳號同步同一信任模型。"""
    name = _acct._norm_name(req.name)
    if not name:
        raise HTTPException(400, "缺少帳號")
    _ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO trade_userkey (name, tkey, updated_at) VALUES ({ph},{ph},{ph}) "
            f"ON CONFLICT (name) DO UPDATE SET tkey=excluded.tkey, updated_at=excluded.updated_at",
            (name, req.tkey or "", time.time()))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/mykey")
def my_key(req: MyKeyReq):
    """取回該帳號綁定的交易口令（登入後前端用它免去再次輸入）。"""
    name = _acct._norm_name(req.name)
    if not name:
        return {"tkey": ""}
    _ensure_db()
    conn, ph = _acct._db()
    try:
        cur = conn.execute(f"SELECT tkey FROM trade_userkey WHERE name={ph}", (name,))
        row = cur.fetchone()
    finally:
        conn.close()
    return {"tkey": (row[0] if row and row[0] else "")}


@router.post("/overview")
def overview(req: KeyReq):
    client = _guard(req.key, req.name)
    try:
        # ⚠ 不在此放 algo_orders()：/overview 每 2 秒刷新持倉，是看倉的命脈；algo GET 端點未確定，
        # 一旦變慢/出錯會拖垮整個持倉頁(曾卡死)。核對止損止盈改走手動的 /verify_sltp。
        positions = client.positions()
        # 附上加倉筆數：把此帳號未平自動倉的 adds 依 bsym 併進持倉（手動倉/非自動倉 → 無 adds 欄）。
        # 整段 try 包住、任何失敗都不影響持倉頁（看倉命脈絕不可被這個附加查詢拖垮）。
        try:
            nm = _acct._norm_name(req.name or "")
            _ensure_db()
            _c, _ph = _acct._db()
            try:
                _rows = _c.execute(
                    f"SELECT bsym, adds FROM trade_log WHERE source='auto' AND status='open' AND acct={_ph}",
                    (nm,)).fetchall()
            finally:
                _c.close()
            _adds = {r[0]: r[1] for r in _rows if r and r[0]}
            for p in positions:
                a = _adds.get(p.get("symbol"))
                if a and int(a) > 1:
                    p["adds"] = int(a)
        except Exception:
            pass
        return {"env": client.env, "balance": client.balance(),
                "positions": positions, "orders": client.open_orders(),
                "auto": get_auto_cfg(req.name, fresh=True)}
    except bt.TradeError as e:
        raise HTTPException(502, str(e))


@router.post("/verify_sltp")
def verify_sltp(req: KeyReq):
    """核對未平自動倉：紀錄(通知)的止損/止盈 vs 交易所『實際掛單觸發價』（皆換算圖表價比較）。
    sl_diff_pct/tp_diff_pct >0.15 → 通知與實際掛單不一致；has_algo=false → 交易所查不到該倉止損/止盈單(危險)。"""
    client = _guard(req.key, req.name)
    name = _acct._norm_name(req.name or "")
    try:
        algos = client.algo_orders()
        positions = {p["symbol"] for p in client.positions()}
    except bt.TradeError as e:
        raise HTTPException(502, str(e))
    by_sym = {}
    for a in algos:
        g = by_sym.setdefault(a["symbol"], {"sl": None, "tp": None})
        if a["type"] == "STOP_MARKET":          g["sl"] = a["triggerPrice"]
        elif a["type"] == "TAKE_PROFIT_MARKET": g["tp"] = a["triggerPrice"]
    _ensure_db()
    conn, ph = _acct._db()
    try:
        cur = conn.execute(
            f"SELECT symbol, bsym, side, sl, tp, tf FROM trade_log "
            f"WHERE source='auto' AND status='open' AND acct={ph} ORDER BY id DESC LIMIT 30",
            (name,))
        rows = cur.fetchall()
    finally:
        conn.close()
    def _f(v):
        try: return float(v)
        except (TypeError, ValueError): return None
    def _mm(x, y):
        if x is None or y is None or not y: return None
        return round(abs(x - y) / abs(y) * 100, 3)
    out = []
    for symbol, bsym, side, sl, tp, tf in rows:
        _, scale = client.resolve_symbol(symbol)
        sc = scale or 1
        a = by_sym.get(bsym, {})
        sl_notif = _f(sl)                                          # 紀錄止損(圖表價)
        tp_notif = _f(tp)                                          # 紀錄止盈(圖表價，已修正)
        sl_act = (a["sl"] / sc) if a.get("sl") else None          # 交易所止損(合約→圖表)
        tp_act = (a["tp"] / sc) if a.get("tp") else None
        out.append({
            "symbol": symbol, "tf": tf, "side": side,
            "sl_notified": sl_notif, "sl_exchange": sl_act, "sl_diff_pct": _mm(sl_notif, sl_act),
            "tp_notified": tp_notif, "tp_exchange": tp_act, "tp_diff_pct": _mm(tp_notif, tp_act),
            "has_algo": bool(a), "in_position": (bsym in positions),
        })
    return {"items": out, "algo_count": len(algos)}


@router.post("/order")
def order(req: OrderReq):
    client = _guard(req.key, req.name)
    want = "long" if req.side == "long" else "short"
    try:
        bsym, scale = client.resolve_symbol(req.symbol)
        usdt = max(1.0, float(req.usdt))
        lev = max(1, min(int(req.lev), 50))
        notional = usdt * lev
        if notional < client.min_notional(bsym):
            raise bt.TradeError(f"名目金額 {notional:.1f} USDT 低於此合約下限 "
                                f"{client.min_notional(bsym)}，請加大金額或槓桿")
        try:
            client.set_leverage(bsym, lev)
        except bt.TradeError:
            pass
        side = "BUY" if want == "long" else "SELL"
        _psd = _posside(want, _is_hedge(client))   # hedge 帳號手動單也帶 positionSide
        otype = "LIMIT" if req.type == "LIMIT" else "MARKET"
        ref_px = float(req.price) * scale if (otype == "LIMIT" and req.price) else client.last_price(bsym)
        qty = client.quantize_qty(bsym, notional / ref_px)
        price = client.quantize_price(bsym, float(req.price) * scale) if (otype == "LIMIT" and req.price) else None
        o = client.place_order(bsym, side, qty, otype, price=price, position_side=_psd)
        close_side = "SELL" if want == "long" else "BUY"
        warn = []
        for v, kind in ((req.sl, "sl"), (req.tp, "tp")):
            if v:
                try:
                    client.place_close_trigger(bsym, close_side, client.quantize_price(bsym, float(v) * scale), kind, position_side=_psd)
                except bt.TradeError as e:
                    warn.append(f"{'停損' if kind == 'sl' else '止盈'}掛單失敗：{e}")
        _log_trade(source="manual", acct=_acct._norm_name(req.name or ""), mode=client.env,
                   status="open" if otype == "MARKET" else "pending",
                   symbol=req.symbol, bsym=bsym, side=want, qty=qty,
                   entry=(str(req.price) if price else None),
                   sl=(str(req.sl) if req.sl else None), tp=(str(req.tp) if req.tp else None),
                   msg="；".join(warn) or None)
        return {"ok": True, "bsym": bsym, "qty": qty, "order": o, "warn": warn}
    except bt.TradeError as e:
        raise HTTPException(400, str(e))


@router.post("/close")
def close(req: CloseReq):
    client = _guard(req.key, req.name)
    try:
        _bs = req.bsym.upper()
        if _is_hedge(client):                  # hedge：把該合約多、空兩側都平
            r1 = client.close_position(_bs, position_side="LONG")
            r2 = client.close_position(_bs, position_side="SHORT")
            r = {"ok": bool(r1.get("ok") or r2.get("ok")), "long": r1, "short": r2}
        else:
            r = client.close_position(_bs)
        if r.get("ok"):
            _log_trade(source="manual", acct=_acct._norm_name(req.name or ""), mode=client.env,
                       status="closed", symbol=req.bsym, bsym=_bs, msg="手動平倉")
        return r
    except bt.TradeError as e:
        raise HTTPException(400, str(e))


@router.post("/cancel")
def cancel(req: CancelReq):
    client = _guard(req.key, req.name)
    try:
        client.cancel_order(req.bsym.upper(), req.orderId)
        return {"ok": True}
    except bt.TradeError as e:
        raise HTTPException(400, str(e))


@router.post("/posmode")
def posmode(req: PosModeReq):
    """切換此帳號 Binance 持倉模式：單向 / 雙向(hedge)。雙向＝同幣可同時多空各一倉(FVG 雙槽需要)。
    ⚠ 帳號級設定、影響該帳號所有交易；有持倉/掛單時 Binance 拒切 → 回友善訊息。
    GET 對應在 /status 回傳目前模式（前端顯示用）。"""
    client = _guard(req.key, req.name)
    try:
        cur = client.get_position_mode()
        if cur == bool(req.hedge):
            return {"ok": True, "hedge": cur, "msg": "已是此模式"}
        client.set_position_mode(bool(req.hedge))
        return {"ok": True, "hedge": bool(req.hedge)}
    except bt.TradeError as e:
        msg = str(e)
        if "-4059" in msg or "No need to change" in msg:
            return {"ok": True, "hedge": bool(req.hedge), "msg": "已是此模式"}
        if "-4068" in msg or "position" in msg.lower() or "open order" in msg.lower():
            raise HTTPException(400, "有未平倉位或掛單，無法切換持倉模式 → 請先全部平倉/撤單再切")
        raise HTTPException(400, msg)


def _sweep_orphan_algo(client) -> dict:
    """全帳號清殘留 algo 條件單 + 回診斷。先用原始 GET /fapi/v1/openAlgoOrders 看真實回應(看得到真錯誤/
    格式)，再對『無持倉合約』的條件單逐筆用 algoId 取消。回 dict 含各步驟數字/錯誤，供定位端點問題。"""
    d = {"listed": 0, "orphans": 0, "cancelled": 0, "list_err": "", "cancel_err": "", "sample": ""}
    raw = None
    try:                                              # ① 原始列出(不經 algo_orders 的吞例外包裝 → 看真錯誤)
        raw = client._request("GET", "/fapi/v1/openAlgoOrders", {})
    except Exception as e:
        d["list_err"] = str(e)[:120]
    if isinstance(raw, dict):
        raw = raw.get("orders") or raw.get("data") or []
    if not isinstance(raw, list):
        raw = []
    d["listed"] = len(raw)
    if raw and isinstance(raw[0], dict):
        a0 = raw[0]
        d["sample"] = f"{a0.get('symbol')}/{a0.get('orderType') or a0.get('type')}/id={a0.get('algoId')}"
    try:                                              # ② 無持倉合約的孤兒條件單 → 逐筆取消
        pos_syms = {p["symbol"] for p in client.positions()}
    except Exception:
        pos_syms = set()
    for o in raw:
        if not isinstance(o, dict):
            continue
        sym = o.get("symbol"); aid = o.get("algoId")
        if not sym or not aid or sym in pos_syms:
            continue
        d["orphans"] += 1
        try:
            client.cancel_algo(sym, aid)
            d["cancelled"] += 1
        except bt.TradeError as e:
            if not d["cancel_err"]:
                d["cancel_err"] = str(e)[:120]
    return d


@router.post("/auto")
def set_auto(req: AutoReq):
    client = _guard(req.key, req.name)
    name = _acct._norm_name(req.name or "")
    prev = get_auto_cfg(name, fresh=True)             # 此帳號存檔前的設定 → 判斷是否『剛從關→開』
    cfg = _clean_auto(req.cfg)
    _save_auto_cfg(name, cfg)                          # 存進此帳號自己的列（不影響別帳號）
    # 此帳號剛把自動交易『關→開』→ 清此帳號無持倉合約的殘留條件單，並推一則診斷通知(列出/取消數字+錯誤)，
    # 供定位 -4509(殘單清不掉)卡在哪一步：列不出？取消被拒？上限是全帳號？
    diag = None
    if cfg.get("on") and not prev.get("on"):
        diag = _sweep_orphan_algo(client)
        owner = name
        if diag.get("cancelled"):
            _push_owner(owner, f"🧹 已清理殘留條件單 · {diag['cancelled']} 筆",
                        f"全帳號列出 {diag['listed']} 筆 algo 條件單，清掉無持倉合約的 {diag['cancelled']} 筆"
                        f"（共 {diag['orphans']} 筆孤兒）。", "", event="atrade")
        else:
            _push_owner(owner, "🔧 條件單診斷",
                        f"列出 {diag['listed']} 筆／孤兒 {diag['orphans']} 筆／取消 {diag['cancelled']} 筆"
                        + (f"\n列出錯誤：{diag['list_err']}" if diag['list_err'] else "")
                        + (f"\n取消錯誤：{diag['cancel_err']}" if diag['cancel_err'] else "")
                        + (f"\n樣本：{diag['sample']}" if diag['sample'] else ""),
                        "", event="atrade")
    return {"ok": True, "cfg": cfg, "diag": diag}


@router.post("/history")
def history(req: KeyReq):
    client = _guard(req.key, req.name)
    name = _acct._norm_name(req.name or "")
    _ensure_db()
    conn, ph = _acct._db()
    try:
        # 只回此帳號自己的交易紀錄（acct=本帳號），外加未標記 acct 的舊資料（遷移前的歷史）。
        cur = conn.execute(
            f"SELECT ts,mode,source,status,symbol,bsym,side,qty,entry,sl,tp,sig,dir,tf,msg,closed_ts "
            f"FROM trade_log WHERE acct={ph} OR acct IS NULL ORDER BY id DESC LIMIT 60", (name,))
        rows = cur.fetchall()
    finally:
        conn.close()
    log = [{"ts": r[0], "mode": r[1], "source": r[2], "status": r[3], "symbol": r[4],
            "bsym": r[5], "side": r[6], "qty": r[7], "entry": r[8], "sl": r[9],
            "tp": r[10], "sig": r[11], "dir": r[12], "tf": r[13], "msg": r[14],
            "closed_ts": r[15]} for r in rows]
    pnl = []
    try:
        pnl = client.income_history(40)
    except bt.TradeError:
        pass
    return {"log": log, "pnl": pnl}


@router.post("/pnl_daily")
def pnl_daily(req: KeyReq):
    """每日已實現盈虧（交易損益月曆用）：近 ~75 天的 已實現損益+手續費+資金費，按台北日期加總。
    回 {days: {'YYYY-MM-DD': pnl, ...}}（已是台北日期）。"""
    client = _guard(req.key, req.name)
    import time as _t
    from datetime import datetime as _dt, timedelta as _td
    end = int(_t.time() * 1000)
    start = end - 75 * 86400 * 1000        # 近 ~75 天（涵蓋當月＋上月月曆）
    try:
        rows = client.income_daily(start, end)
    except bt.TradeError as e:
        raise HTTPException(400, str(e))
    days = {}      # 日期 → 當日總盈虧
    byday = {}     # 日期 → 當日明細列 [{sym, pnl, type, ts}]（給點擊那天看進出場詳情）
    for r in rows:
        d = (_dt.utcfromtimestamp(r["ts"]) + _td(hours=8)).strftime("%Y-%m-%d")   # 台北日期
        days[d] = round(days.get(d, 0.0) + r["pnl"], 4)
        sym = (r.get("symbol") or "").replace("USDT", "")        # 顯示用：去 USDT 後綴
        byday.setdefault(d, []).append({"sym": sym, "pnl": round(r["pnl"], 4),
                                        "type": r.get("type"), "ts": r["ts"]})
    for d in byday:                                              # 各日明細按時間排序
        byday[d].sort(key=lambda x: x["ts"])
    return {"days": days, "byday": byday}
