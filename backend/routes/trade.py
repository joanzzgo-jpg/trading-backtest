"""手動交易 + 自動交易（Binance USDⓈ-M 永續）。

安全模型：
- 金鑰只在伺服器 env（見 utils/binance_trade.py）；前端永遠拿不到。
- 站是公開多人用 → 交易端點（除 /status）要求 TRADE_ACCESS_KEY（env 設定的口令）：
  前端輸入一次存 localStorage，之後每個請求帶上。沒設 env 時只允許本機開發直用。
- 預設 testnet：BINANCE_TRADE_ENV=live 才動真錢。

自動交易：
- 設定存 DB 單列 trade_auto（沿用 account.py 的 Postgres/SQLite 雙後端）→ 重啟不丟。
- notify_monitor 偵測到「新進場訊號」→ execute_signal_trade()：市價進場 +
  交易所託管 SL（訊號停損價）/ TP（進場 ± 盈虧比×風險）。
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

_ALL_SIGS = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "ss1", "ss2"}
_ALL_TFS = {"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"}
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
                 # 再現就加一筆(到上限)，合併均價、停損移到最新筆、各筆冒 1R → 最壞約虧 N×R(停損上移常更少)。
                 "maxAdds": 1}


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
_auto_cache = {"ts": 0.0, "cfg": None}


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
        out["maxPos"] = max(1, min(int(p.get("maxPos", 3)), 20))
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
    try:
        out["maxAdds"] = max(1, min(int(p.get("maxAdds", 1)), 10))   # 加倉上限(含首筆)，1=不加倉
    except (TypeError, ValueError):
        pass
    return out


def get_auto_cfg(fresh: bool = False) -> dict:
    """讀自動交易設定（10s 快取：監控器每訊號都會查）。"""
    if not fresh and _auto_cache["cfg"] is not None and time.time() - _auto_cache["ts"] < 10:
        return _auto_cache["cfg"]
    cfg = dict(_AUTO_DEFAULT)
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute("SELECT cfg FROM trade_auto WHERE id=1")
            row = cur.fetchone()
        finally:
            conn.close()
        if row and row[0]:
            cfg = _clean_auto(json.loads(row[0]))
    except Exception:
        pass
    _auto_cache["cfg"] = cfg
    _auto_cache["ts"] = time.time()
    return cfg


def _save_auto_cfg(cfg: dict):
    _ensure_db()
    conn, ph = _acct._db()
    try:
        conn.execute(
            f"INSERT INTO trade_auto (id, cfg, updated_at) VALUES (1,{ph},{ph}) "
            f"ON CONFLICT (id) DO UPDATE SET cfg=excluded.cfg, updated_at=excluded.updated_at",
            (json.dumps(cfg), time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    _auto_cache["cfg"] = cfg
    _auto_cache["ts"] = time.time()


# ── 交易紀錄 ──────────────────────────────────────────────────
def _log_trade(**kw) -> Optional[int]:
    try:
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cols = ("ts", "mode", "source", "status", "symbol", "bsym", "side", "qty",
                    "entry", "sl", "tp", "sig", "dir", "tf", "sigt", "msg", "tp_oid")
            vals = (time.time(), kw.get("mode") or bt.env_name(), kw.get("source"), kw.get("status"),
                    kw.get("symbol"), kw.get("bsym"), kw.get("side"), kw.get("qty"),
                    kw.get("entry"), kw.get("sl"), kw.get("tp"), kw.get("sig"),
                    kw.get("d"), kw.get("tf"), kw.get("sigt"), kw.get("msg"),
                    str(kw["tp_oid"]) if kw.get("tp_oid") is not None else None)
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
    """新進場訊號 → 依自動交易設定市價進場 + 掛交易所託管 SL/TP。
    all_signals=該標的當前完整訊號列表（含結算結果），供「敗後停手」模擬用。"""
    try:
        if market != "crypto":
            return
        cfg = get_auto_cfg()
        # 設定層過濾（未開／此訊號未勾／此時框未勾／方向不符）→ 靜默：每根非目標訊號都會進來，
        # 記 log 會洗版。這四項屬「使用者設定」，前端面板看得到，不必入交易紀錄。
        if not (cfg["on"] and k in cfg["sigs"] and tf in cfg["tfs"]):
            return
        want = "short" if d == "s" else "long"
        if cfg["dirs"] != "both" and cfg["dirs"] != want:
            return
        import routes.notify as notify
        # 逐事件去重前移：每個「設定上要交易」的訊號只評估一次 → 之後每個「跳過原因」都只記一次 log
        # （不洗版）→ 用來診斷「設定都對了卻沒觸發」卡在哪一關。
        evt_key = f"atrade:{symbol}:{tf}:{k}:{d}:{sig.get('t')}"
        if notify.seen_event(evt_key):
            return
        notify.mark_event(evt_key)   # 標記：此訊號只嘗試/記錄一次，不重複

        def _skip(msg):
            """記一筆 skipped 交易紀錄（前端交易面板看得到）：說明此訊號為何沒進場。"""
            _log_trade(source="auto", status="skipped", symbol=symbol, side=want,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=msg)

        # ⚠ 已結算訊號不追進場：監控器會掃到最近窗內「已到止盈/止損」的舊訊號(r=w/l)，照樣進場 →
        # settle 會立刻判定已結算 → 馬上平倉（開單即關單）。只進「還沒結算(live)」的訊號。
        if sig.get("r") in ("w", "l"):
            _skip("訊號已結算(非 live)，不追進場（避免開單即平倉）")
            return
        # ⚠ 關鍵：只交易「擁有者帳號自己的自選清單」裡的標的，且用該帳號自己的金鑰下單。
        owner = (cfg.get("owner") or "").strip()
        if not owner:
            _skip("自動交易未綁定擁有者帳號(owner)")
            return
        client, _ = _client_for(owner)
        if client is None:
            _skip(f"擁有者帳號「{owner}」沒有交易所金鑰，無法下單")
            return
        owner_syms = {(w.get("symbol") or "") for w in notify.account_watchlist(owner)}
        if symbol not in owner_syms:
            _skip(f"{symbol} 不在擁有者帳號「{owner}」的合約自選清單，跳過")
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
        if existing:
            # 已有同合約持倉：加倉開啟(maxAdds>1) + 同向 + 未達上限 → 加倉；否則略過。
            try:
                _c, _ph = _acct._db()
                try:
                    _r = _c.execute(
                        f"SELECT id, adds FROM trade_log WHERE source='auto' AND status='open' "
                        f"AND bsym={_ph} ORDER BY id DESC LIMIT 1", (bsym,)).fetchone()
                finally:
                    _c.close()
            except Exception:
                _r = None
            cur_adds = (_r[1] if (_r and _r[1]) else 1)
            _why = None
            if max_adds <= 1:                  _why = "已有同合約持倉，略過"
            elif existing.get("side") != want: _why = "已有反向持倉，略過（單向不能反手）"
            elif not _r:                       _why = "已有持倉但查無對應自動倉，略過（不加倉）"
            elif cur_adds >= max_adds:         _why = f"加倉已達上限 {max_adds} 筆，略過"
            if _why:
                _log_trade(source="auto", mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                           side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=_why)
                return
            is_add = True; add_row_id = _r[0]
        elif len(pos) >= cfg["maxPos"]:
            _log_trade(source="auto", mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
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
            _log_trade(source="auto", mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
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
                _log_trade(source="auto", mode=client.env, status="failed", symbol=symbol, bsym=bsym,
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
            _log_trade(source="auto", mode=client.env, status="failed", symbol=symbol, bsym=bsym,
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
        # 止盈到「上下軌」（空→下軌、多→上軌；用原始策略風險＝進場到策略停損算 → 不受停損緩衝影響）。
        # rr_b＝上下軌預估盈虧比；缺(軌為 NaN)→ 退回中軌 rr。之後 retarget_auto_tp 每根 K 跟著軌移動。
        tp_px = None; tgt = None     # tgt=止盈圖表價(顯示/紀錄用)；tp_px=合約價(掛單用，=tgt×scale)
        tp_rr = rr_b if rr_b else rr
        if tp_rr:
            risk = abs(float(entry) - orig_stop)
            tgt = float(entry) - tp_rr * risk if d == "s" else float(entry) + tp_rr * risk
            tp_px = client.quantize_price(bsym, tgt * scale)
        close_side = "SELL" if want == "long" else "BUY"

        # ── 加倉：市價已合併進淨倉 → 只更新均價/筆數，完全不碰既有止損/止盈 ──
        # 既有的 closePosition 止損與「數量」無關（觸發即平整個淨倉）→ 加倉後它仍保護加大後的整倉、
        # 無需重掛。⚠ 絕不在這裡「取消舊單→掛新單」：新版 Algo API 的取消是非同步、又有單量上限，
        # 重掛常踩 -4130/-4509，而舊邏輯一掛不上就「平整倉」→ 訊號再現又開→又加→又平，狂 churn 燒
        # 手續費（曾 48 分鐘開平上百次、虧 -500 幾乎全是手續費）。代價：止損維持在「首筆」結構停損、
        # 不下移到最新筆（較保守、但永不 churn）。止盈仍由 retarget_auto_tp 每根 K 跟上下軌移動。
        if is_add:
            try:
                _np = next((p for p in client.positions() if p["symbol"] == bsym), None)
            except bt.TradeError:
                _np = None
            new_qty = _np.get("qty") if _np else None
            _ne = _np.get("entry") if _np else None
            new_entry_chart = (_ne / scale) if (_ne and scale) else _ne     # 合約均價 → 圖表均價
            new_adds = cur_adds + 1
            try:
                _c2, _ph2 = _acct._db()
                try:
                    _c2.execute(                                            # 只更新 qty/entry/adds，sl/tp 不動
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
            l1 = f"第 {new_adds} 筆 · {'做空' if want == 'short' else '做多'} · {envtag}"
            l2 = f"加倉 {_fmt_px(entry)} · 數量 +{qty}"
            l3 = f"均價 {_fmt_px(new_entry_chart) if new_entry_chart else '—'} · 止損維持首筆（不下移、不重掛）"
            _push_owner(owner, f"➕ 自動加倉 · {symbol}（第{new_adds}筆）", "\n".join([l1, l2, l3]),
                        symbol, tf=tf, event="atrade_open", sig=k, d=d, sigt=str(sig.get("t")))
            print(f"  ➕ 自動加倉 {client.env}: {bsym} 第{new_adds}筆 +{qty}（止損不動）")
            return

        # 先掛停損（自動單的安全命脈）。掛失敗 → 立刻市價平掉剛進的倉，絕不留「無停損保護」
        # 的自動倉位（曾發生：冷門合約不支援條件單 -4120，倉位開了卻沒 SL）。
        try:
            client.place_close_trigger(bsym, close_side, sl_px, "sl")
        except bt.TradeError as e:
            # 自癒：止損掛不上最常見＝該合約殘留條件單塞滿 algo 上限(每合約~20)→ -4509。走到這代表
            # 進場前無持倉（is_add 早已 return）→ 該合約所有 algo 條件單必為孤兒 → 清掉後重試一次。
            _sl_ok = False
            try:
                client.cancel_all_algo(bsym)                               # 清孤兒條件單(端點已修正為 algoOrderList)
                client.place_close_trigger(bsym, close_side, sl_px, "sl")
                _sl_ok = True
                print(f"  ♻ 自動下單 {bsym} 止損 {e} → 清殘單後重掛成功")
            except bt.TradeError:
                _sl_ok = False
            if not _sl_ok:
                try:
                    client.close_position(bsym)
                except bt.TradeError:
                    pass
                _log_trade(source="auto", mode=client.env, status="failed", symbol=symbol, bsym=bsym, side=want,
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
        _log_trade(source="auto", mode=client.env, status="open", symbol=symbol, bsym=bsym, side=want,
                   qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)),
                   tp=(str(round(tgt, 8)) if (tp_px and tgt is not None) else None), tp_oid=tp_oid, sig=k, d=d, tf=tf,
                   sigt=str(sig.get("t")), msg="；".join(warn) or None)
        # 通知擁有者：自動進場
        envtag = "實盤" if client.env == "live" else "測試網"
        dir_txt = "做空" if want == "short" else "做多"
        l1 = f"{dir_txt} · {lev}x · 數量 {qty} · {envtag}"
        l2 = f"進場 {_fmt_px(entry)}" + (f" → 止盈 {_fmt_px(tgt)}" if (tp_px and tgt is not None) else "")
        l3 = f"停損 {_fmt_px(stop_chart)}"
        body = "\n".join([l1, l2, l3]) + (f"\n⚠ {_size_warn}" if _size_warn else "")
        _push_owner(owner, f"🤖 自動進場 · {symbol}（{envtag}）", body, symbol, tf=tf, event="atrade_open",
                    sig=k, d=d, sigt=str(sig.get("t")))
        print(f"  🤖 自動下單 {client.env}: {bsym} {side} {qty}（{symbol} {tf} "
              f"{k}/{d}）" + (f" ⚠{warn}" if warn else ""))
    except Exception as e:
        try:
            _log_trade(source="auto", status="failed", symbol=symbol, side=d,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=str(e))
        except Exception:
            pass
        print(f"  ⚠ 自動下單失敗 {symbol} {tf} {k}/{d}：{e}")


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
    # body 保留「已實現盈虧 {±x} USDT」格式（今日摘要正則解析用），後綴賺/賠金額讓人一眼看懂
    if pnl is not None:
        gain = "賺" if pnl >= 0 else "賠"
        body = f"{icon} {result}平倉\n已實現盈虧 {pnl:+.2f} USDT（{gain} {abs(pnl):.2f}）"
    else:
        body = f"{icon} {result}平倉"
    _push_owner(owner, f"{icon} 自動{result} · {symbol}", body, symbol, tf=tf,
                event=("atrade_tp" if event == "tp" else "atrade_sl"),
                sig=sig, d=d, sigt=sigt)
    print(f"  🤖 自動平倉 {client.env}: {bsym}（{event}）pnl={pnl}")
    return pnl


def settle_signal_trade(market, exchange, symbol, tf, k, d, sig, event):
    """訊號引擎判定止盈/止損(以上下軌結算) → 平掉對應的自動倉位（軌出場早於交易所 band TP 時對齊策略）。"""
    try:
        if market != "crypto":
            return
        cfg = get_auto_cfg()
        client, _ = _client_for((cfg.get("owner") or "").strip())
        if client is None:
            return
        sigt = str(sig.get("t"))
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute(
                f"SELECT id, bsym FROM trade_log WHERE source='auto' AND status='open' "
                f"AND symbol={ph} AND tf={ph} AND sig={ph} AND dir={ph} AND sigt={ph} "
                f"ORDER BY id DESC LIMIT 1",
                (symbol, tf, k, d, sigt))
            row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            return
        row_id, bsym = row
        reason = "策略止盈平倉" if event == "tp" else "策略止損平倉"
        _close_auto_position((cfg.get("owner") or "").strip(), client, row_id, bsym, symbol, tf, event, reason,
                             sig=k, d=d, sigt=sigt)
    except Exception as e:
        print(f"  ⚠ 自動平倉失敗 {symbol} {tf}：{e}")


def reconcile_auto_position(market, exchange, symbol, tf):
    """自動倉出場對帳：該『標的×時框』的未平自動倉，若交易所已無持倉（止損/止盈觸發單『盤中即時』已平）
    → 補記錄 + 通知。取代原本『收盤(整點) settle 平倉』：
      • 出場改由交易所掛的觸發單盤中即時觸發（碰到止盈/止損位就出，不再整點才決定）。
      • 止損確實落在通知顯示的緩衝價（交易所掛單），不再被『訊號自身較近的止損』提早平。
    止盈/止損依該倉已實現盈虧正負判定。冪等：只處理 status='open' 且交易所已無倉者。"""
    try:
        if market != "crypto":
            return
        cfg = get_auto_cfg()
        owner = (cfg.get("owner") or "").strip()
        client, _ = _client_for(owner)
        if client is None:
            return
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute(
                f"SELECT id, bsym, sig, dir, sigt FROM trade_log WHERE source='auto' AND status='open' "
                f"AND symbol={ph} AND tf={ph}", (symbol, tf))
            rows = cur.fetchall()
        finally:
            conn.close()
        if not rows:
            return
        try:
            pos_syms = {p["symbol"] for p in client.positions()}
        except bt.TradeError:
            return
        for row_id, bsym, rsig, rd, rsigt in rows:
            if bsym in pos_syms:
                continue                           # 仍有持倉 → 未平，跳過
            # 持倉已不在 → 交易所觸發單已盤中平倉。判止盈/止損：該合約最近一筆已實現盈虧正負。
            pnl = None
            try:
                for inc in client.income_history(30):
                    if inc.get("symbol") == bsym:
                        pnl = inc.get("pnl"); break
            except bt.TradeError:
                pass
            if pnl is None:
                continue                           # 已實現盈虧尚未入帳 → 先不記，下一輪重試（避免誤判止盈/止損、漏記盈虧）
            event = "tp" if pnl >= 0 else "sl"
            try:
                client.cancel_all_algo(bsym)       # 清殘留的另一張觸發單（止損觸發→殘留止盈，反之亦然），避免孤兒
            except bt.TradeError:
                pass
            _close_auto_position(owner, client, row_id, bsym, symbol, tf, event,
                                 "交易所止盈平倉（盤中觸及上下軌）" if event == "tp" else "交易所止損平倉（盤中觸及停損）",
                                 sig=rsig, d=rd, sigt=rsigt)
    except Exception as e:
        print(f"  ⚠ 自動倉對帳失敗 {symbol} {tf}：{e}")


def retarget_auto_tp(market, exchange, symbol, tf, upper_chart, lower_chart):
    """TP 跟著上下軌移動：用最新上下軌(已收盤棒)把該「標的×時框」所有未平自動倉的交易所 TP 單
    取消重掛到對應軌（空單→下軌 lower、多單→上軌 upper）。只動 TP（用開倉時存下的 algoId 精準
    取消）→ 絕不碰 SL（零 SL 空窗）。目標軌已越過現價(達成側)→ 不重掛(避免 -2021)、交給 settle
    市價平倉。每根 K 收盤呼叫一次。絕不拋例外。"""
    try:
        if market != "crypto":
            return
        cfg = get_auto_cfg()
        if not cfg.get("on"):
            return
        _ensure_db()
        conn, ph = _acct._db()
        try:
            cur = conn.execute(
                f"SELECT id, bsym, dir, tp, tp_oid, sig, sigt FROM trade_log WHERE source='auto' "
                f"AND status='open' AND symbol={ph} AND tf={ph}", (symbol, tf))
            rows = cur.fetchall()
        finally:
            conn.close()
        if not rows:
            return                              # 此標的×時框無未平自動倉 → 不碰交易所
        client, _ = _client_for((cfg.get("owner") or "").strip())
        if client is None:
            return
        bsym0, scale = client.resolve_symbol(symbol)
        px = client.last_price(bsym0)
        for row_id, bsym, d, old_tp, tp_oid, rsig, rsigt in rows:
            try:
                want = "short" if d == "s" else "long"
                band = lower_chart if want == "short" else upper_chart   # 空→下軌、多→上軌
                if band is None or band != band:    # NaN/缺 → 跳過此倉（不動其 TP）
                    continue
                new_tp_px = client.quantize_price(bsym0, float(band) * scale)
                new_tp_f = float(new_tp_px)
                # 目標軌已碰到/越過現價（多單→軌已在現價下、空單→已在現價上）＝達成側 → 立刻市價平倉，
                # 不丟給收盤確認的 settle（碰到就馬上止盈，且避免「掛不了 TP 又裸著等下一根」）。
                if (want == "long" and new_tp_f <= px) or (want == "short" and new_tp_f >= px):
                    _close_auto_position((cfg.get("owner") or "").strip(), client, row_id, bsym, symbol, tf,
                                         "tp", "策略止盈平倉(上下軌觸及，即時平倉)", sig=rsig, d=d, sigt=rsigt)
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
        return {"env": client.env, "balance": client.balance(),
                "positions": client.positions(), "orders": client.open_orders(),
                "auto": get_auto_cfg(fresh=True)}
    except bt.TradeError as e:
        raise HTTPException(502, str(e))


@router.post("/verify_sltp")
def verify_sltp(req: KeyReq):
    """核對未平自動倉：紀錄(通知)的止損/止盈 vs 交易所『實際掛單觸發價』（皆換算圖表價比較）。
    sl_diff_pct/tp_diff_pct >0.15 → 通知與實際掛單不一致；has_algo=false → 交易所查不到該倉止損/止盈單(危險)。"""
    client = _guard(req.key, req.name)
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
            f"WHERE source='auto' AND status='open' ORDER BY id DESC LIMIT 30")
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
        _log_trade(source="manual", mode=client.env, status="open" if otype == "MARKET" else "pending",
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
            _log_trade(source="manual", mode=client.env, status="closed", symbol=req.bsym,
                       bsym=req.bsym.upper(), msg="手動平倉")
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
    prev = get_auto_cfg(fresh=True)                   # 存檔前的設定 → 判斷是否『剛從關→開』
    cfg = _clean_auto(req.cfg)
    _save_auto_cfg(cfg)
    # 剛把自動交易『關→開』→ 清無持倉合約的殘留條件單，並推一則診斷通知(列出/取消數字+錯誤)，
    # 供定位 -4509(殘單清不掉)卡在哪一步：列不出？取消被拒？上限是全帳號？
    diag = None
    if cfg.get("on") and not prev.get("on"):
        diag = _sweep_orphan_algo(client)
        owner = (cfg.get("owner") or "").strip()
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
    _ensure_db()
    conn, ph = _acct._db()
    try:
        cur = conn.execute(
            "SELECT ts,mode,source,status,symbol,bsym,side,qty,entry,sl,tp,sig,dir,tf,msg,closed_ts "
            "FROM trade_log ORDER BY id DESC LIMIT 60")
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
