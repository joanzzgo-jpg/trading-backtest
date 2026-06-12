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
- 訊號引擎判定止盈/止損（中軌會漂移，可能早於交易所掛單觸發）→ settle_signal_trade()
  把對應倉位市價平掉 → 出場邏輯與回測/通知一致。
- 每筆交易記 trade_log（含 testnet/live 標記），前端交易面板顯示。
"""
import os
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

_ALL_SIGS = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "ss1"}
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
                 "stopAfterLoss": False}


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
def _own_creds(name: str):
    """讀某帳號自綁的 Binance 金鑰（已解密）。回 (api_key, api_secret, env) 或 None。"""
    name = _acct._norm_name(name or "")
    if not name:
        return None
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
                    "entry", "sl", "tp", "sig", "dir", "tf", "sigt", "msg")
            vals = (time.time(), kw.get("mode") or bt.env_name(), kw.get("source"), kw.get("status"),
                    kw.get("symbol"), kw.get("bsym"), kw.get("side"), kw.get("qty"),
                    kw.get("entry"), kw.get("sl"), kw.get("tp"), kw.get("sig"),
                    kw.get("d"), kw.get("tf"), kw.get("sigt"), kw.get("msg"))
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


def _push_owner(owner, title, body, symbol, tf="", event="atrade"):
    """把自動交易結果推給擁有者帳號（Web Push）並寫進訊號聊天室。絕不向外拋例外。"""
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
        notify.log_signal(owner, time.time(), event, title, body, symbol, "crypto", "pionex", tf)
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
    跑逐方向狀態機，回此方向當下是否「可進場」(active)。無資料 → 預設可進場。"""
    if not all_signals:
        return True
    cur_t = _sig_epoch(sig.get("t"))
    prior = {}
    for s in all_signals:
        t = s.get("t"); r = s.get("r")
        if not t or r not in ("w", "l"):
            continue
        if _sig_epoch(t) >= cur_t:        # 只看「此訊號之前」已結算的
            continue
        prior[(str(t), s.get("d"))] = s   # (t,d) 去重（同圖表合併時間軸）
    seq = sorted(prior.values(), key=lambda s: _sig_epoch(s.get("t")))
    active = {"s": True, "l": True}
    for s in seq:
        sd = s.get("d"); r = s.get("r")
        if active.get(sd, True):
            if r != "w":
                active[sd] = False                  # 進場中遇敗 → 該方向停手
        elif r == "w":
            active[sd] = True                       # 停手中、同向紙上會贏 → 解除
        active["l" if sd == "s" else "s"] = True    # 反向訊號出現 → 解除其停手
    return active.get(d, True)


# ── 自動交易執行器（notify_monitor 呼叫；絕不向外拋例外）───────
def execute_signal_trade(market, exchange, symbol, tf, k, d, sig, all_signals=None):
    """新進場訊號 → 依自動交易設定市價進場 + 掛交易所託管 SL/TP。
    all_signals=該標的當前完整訊號列表（含結算結果），供「敗後停手」模擬用。"""
    try:
        if market != "crypto":
            return
        cfg = get_auto_cfg()
        if not (cfg["on"] and k in cfg["sigs"] and tf in cfg["tfs"]):
            return
        want = "short" if d == "s" else "long"
        if cfg["dirs"] != "both" and cfg["dirs"] != want:
            return
        # ⚠ 已結算訊號不追進場：剛開自動交易時，監控器會掃到最近窗內「已經到止盈/止損」的舊訊號
        # （r=w/l）。若照樣進場，settle 會立刻判定它已結算 → 馬上平倉（＝開單馬上關單）。
        # 只進「還沒結算(live)」的訊號。
        if sig.get("r") in ("w", "l"):
            return
        import routes.notify as notify
        # ⚠ 關鍵：只交易「擁有者帳號自己的自選清單」裡的標的，且用該帳號自己的金鑰下單。
        # owner 未綁定、或該帳號沒金鑰 → 不交易。
        owner = (cfg.get("owner") or "").strip()
        if not owner:
            return
        client, _ = _client_for(owner)
        if client is None:
            return
        owner_syms = {(w.get("symbol") or "") for w in notify.account_watchlist(owner)}
        if symbol not in owner_syms:
            return
        evt_key = f"atrade:{symbol}:{tf}:{k}:{d}:{sig.get('t')}"
        if notify.seen_event(evt_key):
            return
        notify.mark_event(evt_key)   # 先標記：下單只該嘗試一次，失敗也不無限重試

        # 敗後停手（同圖表 crt._calc_stop_strategy 的逐方向狀態機）：用「此訊號之前、已結算」的
        # 同/反向訊號序列重跑模擬，若此方向當下「停手中」→ 跳過進場。
        if cfg.get("stopAfterLoss") and not _stop_after_loss_ok(d, sig, all_signals):
            _log_trade(source="auto", status="skipped", symbol=symbol, side=want,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg="敗後停手：此方向上次落敗、停手中，跳過此進場")
            return

        entry = sig.get("entry")
        stop = sig.get("stop")
        rr = sig.get("rr")
        if entry is None or stop is None:
            return
        bsym, scale = client.resolve_symbol(symbol)
        pos = client.positions()
        if any(p["symbol"] == bsym for p in pos):
            _log_trade(source="auto", mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg="已有同合約持倉，略過")
            return
        if len(pos) >= cfg["maxPos"]:
            _log_trade(source="auto", mode=client.env, status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg=f"持倉數已達上限 {cfg['maxPos']}")
            return

        px = client.last_price(bsym)

        # 停損價（圖表價）：slPct=止損緩衝 %。以「策略訊號停損」為基準，再往「離進場更遠」
        # 方向外推 X%（多單→更低、空單→更高），給緩衝、避免被插針掃掉；0=直接用策略停損。
        orig_stop = float(stop)
        # 此標的若有個別止損緩衝%設定 → 用它；否則用全域 slPct
        per = (cfg.get("perSym") or {}).get(symbol)
        slpct = per if per is not None else (cfg.get("slPct") or 0)
        if slpct > 0:
            stop_chart = orig_stop * (1 + slpct / 100) if d == "s" else orig_stop * (1 - slpct / 100)
        else:
            stop_chart = orig_stop
        sl_px = client.quantize_price(bsym, stop_chart * scale)

        # ── 倉位大小 + 槓桿 ──
        risk_usd = cfg.get("riskUsd") or 0
        lev_cap = max(1, min(int(cfg["lev"]), 50))
        if risk_usd > 0:
            # 固定風險倉位：數量 = 風險金額 ÷（停損距離 + 進出兩腿手續費），槓桿自動挑（強平在停損外）。
            e_c = px * scale                       # 用「實際成交參考價」算（市價單以現價成交）
            s_c = stop_chart * scale               # 停損合約價
            dist = abs(e_c - s_c)
            if dist <= 0:
                _log_trade(source="auto", mode=client.env, status="failed", symbol=symbol, bsym=bsym,
                           side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                           msg="停損距離為 0，無法計算風險倉位")
                return
            fee = 0.0005                           # Binance 合約吃單 0.05%/邊
            # 每單位虧損（把手續費全算進去）：停損距離 + 進場腿(以進場價)手續費 + 出場腿(以停損價)手續費
            per_unit_loss = dist + fee * e_c + fee * s_c
            q_base = risk_usd / per_unit_loss      # 風險金額換算的數量
            notional = q_base * e_c
            stop_pct = dist / e_c if e_c else 0.05
            # 自動槓桿（保守，防大波動/插針在停損前被強平）：強平距離 ≥ 停損距離×2.5 + 維持保證金緩衝。
            # 用該合約「真實維持保證金率 mmr 與最大槓桿」上限把關。
            max_lev, mmr = client.lev_bracket(bsym)
            denom = stop_pct * 2.5 + mmr
            auto_lev = int(1.0 / denom) if denom > 0 else lev_cap
            lev = max(1, min(auto_lev, lev_cap, max_lev))
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
        o = client.place_order(bsym, side, qty, "MARKET")
        # 止盈維持策略目標（用「原始策略風險 = 進場到策略停損」算 → 不受停損緩衝影響）
        tp_px = None
        if rr:
            risk = abs(float(entry) - orig_stop)
            tgt = float(entry) - rr * risk if d == "s" else float(entry) + rr * risk
            tp_px = client.quantize_price(bsym, tgt * scale)
        close_side = "SELL" if want == "long" else "BUY"
        # 先掛停損（自動單的安全命脈）。掛失敗 → 立刻市價平掉剛進的倉，絕不留「無停損保護」
        # 的自動倉位（曾發生：冷門合約不支援條件單 -4120，倉位開了卻沒 SL）。
        try:
            client.place_close_trigger(bsym, close_side, sl_px, "sl")
        except bt.TradeError as e:
            try:
                client.close_position(bsym)
            except bt.TradeError:
                pass
            _log_trade(source="auto", mode=client.env, status="failed", symbol=symbol, bsym=bsym, side=want,
                       qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)), sig=k, d=d, tf=tf,
                       sigt=str(sig.get("t")),
                       msg=f"停損無法掛單（{e}）→ 已即時平倉，不留無保護持倉")
            _push_owner(owner, f"⚠ 自動進場取消 · {symbol}",
                        f"停損無法掛單、為避免無保護持倉已即時平倉\n{e}", symbol, tf=tf, event="atrade_open")
            print(f"  ⚠ 自動下單 {bsym} 停損掛單失敗，已平倉：{e}")
            return
        warn = []
        if tp_px:
            try:
                client.place_close_trigger(bsym, close_side, tp_px, "tp")
            except bt.TradeError as e:
                warn.append(f"TP 掛單失敗（不影響停損保護）：{e}")
        _log_trade(source="auto", mode=client.env, status="open", symbol=symbol, bsym=bsym, side=want,
                   qty=qty, entry=str(entry), sl=str(round(stop_chart, 8)),
                   tp=(str(tp_px) if tp_px else None), sig=k, d=d, tf=tf,
                   sigt=str(sig.get("t")), msg="；".join(warn) or None)
        # 通知擁有者：自動進場
        envtag = "實盤" if client.env == "live" else "測試網"
        body = (f"{'做空' if want == 'short' else '做多'}　數量 {qty}\n"
                f"進場 {entry}　停損 {round(stop_chart, 8)}"
                + (f"　止盈 {tp_px}" if tp_px else ""))
        _push_owner(owner, f"🤖 自動進場 · {symbol}（{envtag}）", body, symbol, tf=tf, event="atrade_open")
        print(f"  🤖 自動下單 {client.env}: {bsym} {side} {qty}（{symbol} {tf} "
              f"{k}/{d}）" + (f" ⚠{warn}" if warn else ""))
    except Exception as e:
        try:
            _log_trade(source="auto", status="failed", symbol=symbol, side=d,
                       sig=k, d=d, tf=tf, sigt=str(sig.get("t")), msg=str(e))
        except Exception:
            pass
        print(f"  ⚠ 自動下單失敗 {symbol} {tf} {k}/{d}：{e}")


def settle_signal_trade(market, exchange, symbol, tf, k, d, sig, event):
    """訊號引擎判定止盈/止損 → 平掉對應的自動倉位（中軌出場早於交易所掛單時對齊策略）。"""
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
        r = client.close_position(bsym)
        msg = "策略止盈平倉" if event == "tp" else "策略止損平倉"
        if not r.get("ok"):
            msg += "（交易所端已先出場）"
        _update_trade(row_id, "closed", msg)
        # 實際已實現盈虧（剛平倉這筆，從 income 取最近一筆該合約 REALIZED_PNL）
        pnl = None
        try:
            for inc in client.income_history(15):
                if inc.get("symbol") == bsym:
                    pnl = inc.get("pnl")
                    break
        except bt.TradeError:
            pass
        # 通知擁有者：自動平倉（含盈虧）
        result = "止盈" if event == "tp" else "止損"
        body = f"{result}平倉　{symbol}"
        if pnl is not None:
            body += f"\n已實現盈虧 {pnl:+.2f} USDT"
        _push_owner((cfg.get("owner") or "").strip(),
                    f"🤖 自動{result} · {symbol}", body, symbol, tf=tf,
                    event=("atrade_tp" if event == "tp" else "atrade_sl"))
        print(f"  🤖 自動平倉 {client.env}: {bsym}（{event}）pnl={pnl}")
    except Exception as e:
        print(f"  ⚠ 自動平倉失敗 {symbol} {tf}：{e}")


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
        return {"env": client.env, "balance": client.balance(),
                "positions": client.positions(), "orders": client.open_orders(),
                "auto": get_auto_cfg(fresh=True)}
    except bt.TradeError as e:
        raise HTTPException(502, str(e))


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


@router.post("/auto")
def set_auto(req: AutoReq):
    _guard(req.key, req.name)
    cfg = _clean_auto(req.cfg)
    _save_auto_cfg(cfg)
    return {"ok": True, "cfg": cfg}


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
