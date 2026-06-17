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

_ALL_SIGS = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "ss1", "ss2", "ss3"}
_ALL_TFS = {"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"}
# 自動交易止盈目標＝「下軌→上軌」的此比例位（多單靠上軌、空單鏡像靠下軌），取代滿格外軌(=1.0)。
# 0.98＝離上軌 2% 處先止盈 → 不等價格剛好碰到外軌(常常差一點點沒成交又反轉吐回)。進場初始 TP 與
# retarget 跟軌共用此比例。改這一個值即可調整。
_AUTO_TP_BAND_RATIO = 0.98
_AUTO_DEFAULT = {"on": False, "owner": "", "sigs": [], "tfs": [], "usdt": 50.0,
                 "lev": 3, "maxPos": 3, "dirs": "both",
                 # riskUsd=每筆風險金額（打到停損約虧這麼多 USDT，含來回手續費）；>0 時改用「固定風險倉位」
                 # 模式：數量由停損距離自動算、槓桿自動挑（強平在停損外），lev 當槓桿上限。0=用保證金×槓桿。
                 "riskUsd": 0.0,
                 # slPct=全域止損緩衝 %（0=用訊號原停損）。perSym={標的:止損緩衝%} 個別覆寫（每標的不同）。
                 "slPct": 0.0,
                 "perSym": {},
                 # stopAfterLoss=敗後停手（同圖表）：某方向落敗後停手、跳過後續同向訊號，
                 # 直到同向「紙上會贏」或反向訊號出現才解除（非時間冷卻）
                 "stopAfterLoss": False,
                 # maxAdds=加倉上限筆數（含首筆）。1=不加倉(同合約只一倉，同向訊號略過)；>1=持倉中同向訊號
                 # 再現就加一筆(到上限)，合併均價、淨倉止損重設到「打到就總虧 N×R」的價位(R=riskUsd)→
                 # 每多加一筆最大虧損只多 1R。只在固定風險模式(riskUsd>0)生效；先掛新止損後取消舊、永不平倉。
                 "maxAdds": 1,
                 # reverse=反向模式(止損↔止盈互換)：訊號照舊判定，但實際下「反方向」單——
                 # 止損掛在原止盈軌位、止盈掛在原止損位。反向倉 SL/TP 固定不追蹤(retarget 跳過)、且不加倉。
                 # ⚠ 回測顯示這在 SS/CRT 上會虧更多(方向毛利為正、反過來等於丟掉正確方向又付兩次手續費)。
                 "reverse": False}


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


def _clean_auto(p: Optional[dict]) -> dict:
    p = p or {}
    out = dict(_AUTO_DEFAULT)
    out["on"] = bool(p.get("on"))
    # owner = 綁定的擁有者帳號名稱：自動交易只下「這個帳號自選清單裡」的標的，
    # 避免掃到別的帳號（種子帳號/其他用戶）的自選就用你的 Binance 帳戶下單。
    out["owner"] = (p.get("owner") or "").strip()[:40]
    out["sigs"] = [s for s in (p.get("sigs") or []) if s in _ALL_SIGS]
    out["tfs"] = [t for t in (p.get("tfs") or []) if t in _ALL_TFS]
    try:
        out["usdt"] = max(1.0, min(float(p.get("usdt", 50)), 100000.0))
    except (TypeError, ValueError):
        pass
    try:
        out["lev"] = max(1, min(int(p.get("lev", 3)), 50))
    except (TypeError, ValueError):
        pass
    try:
        out["maxPos"] = max(1, min(int(p.get("maxPos", 3)), 50))
    except (TypeError, ValueError):
        pass
    if p.get("dirs") in ("both", "long", "short"):
        out["dirs"] = p["dirs"]
    try:
        out["slPct"] = max(0.0, min(float(p.get("slPct", 0) or 0), 50.0))
    except (TypeError, ValueError):
        pass
    try:
        out["riskUsd"] = max(0.0, min(float(p.get("riskUsd", 0) or 0), 100000.0))
    except (TypeError, ValueError):
        pass
    # 各標的止損緩衝%覆寫：{標的: 緩衝%}（0~50；空值/非法略過 → 該標的用全域 slPct）
    ps = {}
    for sym, v in (p.get("perSym") or {}).items():
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if fv > 0:
            ps[str(sym)] = max(0.0, min(fv, 50.0))
    out["perSym"] = ps
    out["stopAfterLoss"] = bool(p.get("stopAfterLoss"))
    out["reverse"] = bool(p.get("reverse"))     # 反向模式(止損↔止盈互換、反方向下單)
    try:
        out["maxAdds"] = max(1, min(int(p.get("maxAdds", 1)), 20))   # 加倉上限(含首筆)，1=不加倉；上限 20
    except (TypeError, ValueError):
        pass
    return out


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
            if not cfg.get("on"):
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
                    "entry", "sl", "tp", "sig", "dir", "tf", "sigt", "msg", "tp_oid", "sl_oid", "acct", "rev")
            vals = (time.time(), kw.get("mode") or bt.env_name(), kw.get("source"), kw.get("status"),
                    kw.get("symbol"), kw.get("bsym"), kw.get("side"), kw.get("qty"),
                    kw.get("entry"), kw.get("sl"), kw.get("tp"), kw.get("sig"),
                    kw.get("d"), kw.get("tf"), kw.get("sigt"), kw.get("msg"),
                    str(kw["tp_oid"]) if kw.get("tp_oid") is not None else None,
                    str(kw["sl_oid"]) if kw.get("sl_oid") is not None else None,
                    kw.get("acct"), 1 if kw.get("rev") else 0)
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


def _sig_epoch(t) -> float:
    """訊號時間 → epoch 秒（naive 以 UTC 解讀，對齊 Binance）。"""
    try:
        import pandas as pd
        return pd.Timestamp(t).value / 1e9
    except Exception:
        return 0.0


def _stop_after_loss_ok(d, sig, all_signals) -> bool:
    """重現圖表「敗後停手」：用「此訊號之前、已結算(w/l)」的訊號序列（按時間排序、(t,d) 去重）
    跑逐方向狀態機，回此方向當下是否「可進場」(active)。無資料 → 預設可進場。
    已內含「一次一筆」（同策略回測 _filter_stop_after_loss）：重建狀態時，前筆未結算(持倉中)
    期間出現的訊號『不算進場、也不計輸贏』——比照實盤同標的同時只持一倉（執行層 trade.py:504
    本就擋同合約重複開倉，這裡讓敗後停手的歷史狀態跟它一致）。"""
    if not all_signals:
        return True
    cur_t = _sig_epoch(sig.get("t"))
    is_ss = sig.get("k") in ("ss1", "ss2")    # SS 系列獨立敗後停手（與圖表 _ss_stop_strategy 一致）
    prior = {}
    for s in all_signals:
        t = s.get("t"); r = s.get("r")
        if not t or r not in ("w", "l"):
            continue
        if _sig_epoch(t) >= cur_t:        # 只看「此訊號之前」已結算的
            continue
        if is_ss and s.get("k") not in ("ss1", "ss2"):
            continue                      # SS 只看 SS 自己的歷史，不混入 S 系列
        prior[(str(t), s.get("d"))] = s   # (t,d) 去重（同圖表合併時間軸）
    seq = sorted(prior.values(), key=lambda s: _sig_epoch(s.get("t")))
    active = {"s": True, "l": True}
    stop_ot = {"s": None, "l": None}                # 讓該方向停手的那筆敗單「止損出場棒」
    busy_until = 0.0                                # 一次一筆：目前持倉的結算時間(epoch)；0＝無持倉
    for s in seq:
        sd = s.get("d"); r = s.get("r")
        if busy_until and _sig_epoch(s.get("t")) < busy_until:
            continue                                # 持倉中 → 完全略過（開不了倉，不進場/不回穩/不解除反向）
        # 新規則（僅 SS）：被停損出場的那根 K，同時又冒出同向 SS 訊號（出場棒==訊號棒）→ 視同回場
        if is_ss and not active.get(sd, True) and stop_ot.get(sd) is not None \
           and str(s.get("t")) == str(stop_ot[sd]):
            active[sd] = True
        if active.get(sd, True):
            busy_until = _sig_epoch(s.get("ot")) or 0.0   # 開倉 → 鎖到此筆結算為止
            if r != "w":
                active[sd] = False                  # 進場中遇敗 → 該方向停手
                stop_ot[sd] = s.get("ot")           # 記下此敗單的止損出場棒（供新規則比對）
        elif r == "w":
            active[sd] = True                       # 停手中、同向紙上會贏 → 解除
        active["l" if sd == "s" else "s"] = True    # 反向訊號出現 → 解除其停手
    # 新規則同樣作用在「當前這筆 SS 訊號」本身：此方向停手中，但訊號棒 == 該方向止損出場棒 → 放行
    if is_ss and not active.get(d, True) and stop_ot.get(d) is not None \
       and str(sig.get("t")) == str(stop_ot[d]):
        return True
    return active.get(d, True)


# ── 自動交易執行器（notify_monitor 呼叫；絕不向外拋例外）───────
def execute_signal_trade(market, exchange, symbol, tf, k, d, sig, all_signals=None):
    """新進場訊號 → 逐個『已開啟自動交易』的帳號各自獨立評估下單
    （每帳號用自己的金鑰/自選/設定、紀錄以 acct 隔離，互不干擾）。
    all_signals=該標的當前完整訊號列表（含結算結果），供「敗後停手」模擬用。"""
    if market != "crypto":
        return
    for _name, _cfg in get_all_auto_cfgs():
        try:
            _exec_signal_for_account(_name, _cfg, market, exchange, symbol, tf, k, d, sig, all_signals)
        except Exception as e:
            print(f"  ⚠ 自動下單失敗 {_name} {symbol} {tf} {k}/{d}：{e}")


def _exec_signal_for_account(name, cfg, market, exchange, symbol, tf, k, d, sig, all_signals=None):
    """單一帳號(name)的進場評估：用該帳號自己的金鑰下單、自選過濾、acct 隔離紀錄。cfg.on 必為 True。"""
    try:
        # 訊號/時框未勾 → 靜默 return（量大：每根掃描所有未勾的訊號×時框，留紀錄會洗版）。
        if not (k in cfg["sigs"] and tf in cfg["tfs"]):
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
        owner_syms = {(w.get("symbol") or "") for w in notify.account_watchlist(owner)}
        if symbol not in owner_syms:
            _skip(f"{symbol} 不在帳號「{owner}」的合約自選清單，跳過")
            return

        # 敗後停手（同圖表 crt._calc_stop_strategy 的逐方向狀態機）：用「此訊號之前、已結算」的
        # 同/反向訊號序列重跑模擬，若此方向當下「停手中」→ 跳過進場。
        if cfg.get("stopAfterLoss") and not _stop_after_loss_ok(d, sig, all_signals):
            _skip("敗後停手：此方向上次落敗、停手中，跳過此進場")
            return

        entry = sig.get("entry")
        stop = sig.get("stop")
        rr = sig.get("rr")          # 中軌預估盈虧比
        rr_b = sig.get("rr_b")      # 上下軌預估盈虧比（自動交易止盈目標＝上下軌）
        if entry is None or stop is None:
            return
        bsym, scale = client.resolve_symbol(symbol)
        pos = client.positions()
        existing = next((p for p in pos if p["symbol"] == bsym), None)
        max_adds = int(cfg.get("maxAdds", 1) or 1)
        is_add = False; add_row_id = None; cur_adds = 1
        add_old_sl = None; add_old_sl_oid = None     # 既有自動倉的止損(圖表價)與其交易所單 id → 加倉時用來收緊重掛

        # ── 反向模式(止損↔止盈互換、反方向下單)─────────────────────────
        # 訊號照舊判定(含方向過濾/敗後停手用『訊號方向』)，但實際下「反方向」單:
        #   新止損 = 原止盈軌位(中軌→上下軌 ratio 位)、新止盈 = 原止損價。方向反轉。
        # 反向倉 SL/TP 固定不追蹤(rev=1 → retarget 跳過)、且不加倉(max_adds=1)。
        _reverse = bool(cfg.get("reverse")); _rev_tp = None
        if _reverse:
            risk0 = abs(float(entry) - float(stop))
            if rr_b is not None and rr is not None:
                tp_rr0 = rr + (2.0 * _AUTO_TP_BAND_RATIO - 1.0) * (rr_b - rr)
            else:
                tp_rr0 = rr_b if rr_b else rr
            if not tp_rr0 or risk0 <= 0:
                _skip("反向模式:缺 rr/rr_b 無法算原止盈軌位,跳過")
                return
            orig_target = float(entry) - tp_rr0 * risk0 if d == "s" else float(entry) + tp_rr0 * risk0
            _rev_tp = float(stop)                  # 原止損 → 新止盈
            stop = orig_target                     # 原止盈軌位 → 新止損(基準)
            d = "l" if d == "s" else "s"           # 方向反轉
            want = "long" if d == "l" else "short"
            max_adds = 1                           # 反向倉不加倉

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
        elif len(pos) >= cfg["maxPos"]:
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
        o = client.place_order(bsym, side, qty, "MARKET")   # 市價：開倉 or 加倉(同向加進淨倉)
        # 止盈到「下軌→上軌的 _AUTO_TP_BAND_RATIO 位」（空→鏡像靠下軌、多→靠上軌；用原始策略風險算→
        # 不受停損緩衝影響）。因標準布林上下軌對稱於中軌 → 該比例位 = 中軌 + (2r−1)(外軌−中軌)，
        # 換算 RR：tp_rr = rr + (2r−1)(rr_b − rr)（rr＝中軌預估RR、rr_b＝外軌預估RR）。缺 rr_b/rr →
        # 退回外軌/中軌。之後 retarget_auto_tp 每根 K 跟著同一比例位移動。
        tp_px = None; tgt = None     # tgt=止盈圖表價(顯示/紀錄用)；tp_px=合約價(掛單用，=tgt×scale)
        if _reverse:
            tgt = _rev_tp                          # 反向:止盈=原止損價(固定,不追蹤軌)
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
                _np = next((p for p in client.positions() if p["symbol"] == bsym), None)
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
            _osl = client.place_close_trigger(bsym, close_side, sl_px, "sl")
            sl_oid = _osl.get("orderId")
        except bt.TradeError as e:
            # 自癒：止損掛不上最常見＝該合約殘留條件單塞滿 algo 上限(每合約~20)→ -4509。走到這代表
            # 進場前無持倉（is_add 早已 return）→ 該合約所有 algo 條件單必為孤兒 → 清掉後重試一次。
            _sl_ok = False
            try:
                client.cancel_all_algo(bsym)                               # 清孤兒條件單(端點已修正為 algoOrderList)
                _osl = client.place_close_trigger(bsym, close_side, sl_px, "sl")
                sl_oid = _osl.get("orderId")
                _sl_ok = True
                print(f"  ♻ 自動下單 {bsym} 止損 {e} → 清殘單後重掛成功")
            except bt.TradeError:
                _sl_ok = False
            if not _sl_ok:
                try:
                    client.close_position(bsym)
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
                _otp = client.place_close_trigger(bsym, close_side, tp_px, "tp")
                tp_oid = _otp.get("orderId")    # 存 TP(algo) 單 id → 之後「跟著中軌移動」用 id 精準取消重掛
            except bt.TradeError as e:
                warn.append(f"TP 掛單失敗（不影響停損保護）：{e}")
        _log_trade(source="auto", acct=name, mode=client.env, status="open", symbol=symbol, bsym=bsym, side=want,
                   qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)),
                   tp=(str(round(tgt, 8)) if (tp_px and tgt is not None) else None), tp_oid=tp_oid, sl_oid=sl_oid,
                   sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg="；".join(warn) or None, rev=_reverse)
        # 通知擁有者：自動進場（方向用 📈做多 / 📉做空 一眼看出）
        envtag = "實盤" if client.env == "live" else "測試網"
        rev_tag = "🔄反向 " if _reverse else ""
        dir_emoji = "📉" if want == "short" else "📈"
        dir_txt = f"{dir_emoji} {'做空' if want == 'short' else '做多'}"
        l1 = f"{rev_tag}{dir_txt} · {lev}x · 數量 {qty} · {envtag}"
        l2 = f"進場 {_fmt_px(entry)}" + (f" → 止盈 {_fmt_px(tgt)}" if (tp_px and tgt is not None) else "")
        l3 = f"停損 {_fmt_px(stop_chart)}" + ("（反向：止損=原止盈軌、止盈=原止損）" if _reverse else "")
        body = "\n".join([l1, l2, l3]) + (f"\n⚠ {_size_warn}" if _size_warn else "")
        _push_owner(owner, f"{rev_tag}{dir_emoji} 自動進場{'做空' if want == 'short' else '做多'} · {symbol}（{envtag}）",
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
                         sig=None, d=None, sigt=None):
    """市價平掉一筆自動倉 + 更新紀錄 + 通知 owner（含已實現盈虧）。settle 與 retarget 共用。
    sig/d/sigt：對應的進場訊號鍵/方向/訊號棒時間 → 讓平倉通知能串接到自動進場通知。"""
    r = client.close_position(bsym)               # 內部會取消該合約所有 algo（SL/TP）
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
                try:
                    pos_syms = {p["symbol"] for p in client.positions()}
                except bt.TradeError:
                    continue
                for row_id, bsym, rsig, rd, rsigt, sl_oid, tp_oid in rows:
                    if bsym in pos_syms:
                        continue                       # 仍有持倉 → 未平，跳過
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
                        open_ids = {str(o.get("algoId")) for o in client.algo_orders(bsym) if o.get("algoId")}
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
                        _rk = cfg.get("riskUsd") or 0
                        if _rk > 0 and abs(pnl) < _rk * 0.4:
                            ev = "tp"
                        else:
                            ev = "tp" if pnl >= 0 else "sl"
                    try:
                        client.cancel_all_algo(bsym)   # 清殘留的另一張觸發單，避免孤兒
                    except bt.TradeError:
                        pass
                    _close_auto_position(name, client, row_id, bsym, symbol, tf, ev,
                                         "交易所止盈平倉（盤中觸及上下軌）" if ev == "tp" else "交易所止損平倉（盤中觸及停損）",
                                         sig=rsig, d=rd, sigt=rsigt)
            except Exception as e:
                print(f"  ⚠ 自動倉對帳失敗 {name} {symbol} {tf}：{e}")
    except Exception as e:
        print(f"  ⚠ 自動倉對帳失敗 {symbol} {tf}：{e}")


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
                    if _rev:
                        continue                        # 反向倉：SL/TP 固定不追蹤軌，retarget 不碰
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
        otype = "LIMIT" if req.type == "LIMIT" else "MARKET"
        ref_px = float(req.price) * scale if (otype == "LIMIT" and req.price) else client.last_price(bsym)
        qty = client.quantize_qty(bsym, notional / ref_px)
        price = client.quantize_price(bsym, float(req.price) * scale) if (otype == "LIMIT" and req.price) else None
        o = client.place_order(bsym, side, qty, otype, price=price)
        close_side = "SELL" if want == "long" else "BUY"
        warn = []
        for v, kind in ((req.sl, "sl"), (req.tp, "tp")):
            if v:
                try:
                    client.place_close_trigger(bsym, close_side, client.quantize_price(bsym, float(v) * scale), kind)
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
        r = client.close_position(req.bsym.upper())
        if r.get("ok"):
            _log_trade(source="manual", acct=_acct._norm_name(req.name or ""), mode=client.env,
                       status="closed", symbol=req.bsym, bsym=req.bsym.upper(), msg="手動平倉")
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
