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
# 交易功能僅限這個帳號使用（其他帳號一律擋）。空＝不限帳號（只靠口令）。設為 "qwer" 即只有 qwer 能交易。
_OWNER = (os.getenv("TRADE_OWNER") or "").strip()

_ALL_SIGS = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "ss1"}
_ALL_TFS = {"5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"}
_AUTO_DEFAULT = {"on": False, "owner": "", "sigs": [], "tfs": [], "usdt": 50.0,
                 "lev": 3, "maxPos": 3, "dirs": "both"}


# ── 訪問控制 ──────────────────────────────────────────────────
def _locked() -> bool:
    return bool(_ACCESS_KEY) or _ON_RAILWAY


def _guard(key: Optional[str], name: Optional[str] = None):
    # 第一道：交易口令（公網沒設口令 → 一律拒）
    if _ACCESS_KEY:
        if not secrets.compare_digest(key or "", _ACCESS_KEY):
            raise HTTPException(403, "交易口令錯誤（TRADE_ACCESS_KEY）")
    elif _ON_RAILWAY:
        raise HTTPException(403, "伺服器未設定 TRADE_ACCESS_KEY，公網環境停用交易")
    # 第二道：帳號白名單（只有 TRADE_OWNER 能交易，其他帳號擋掉）
    if _OWNER and _acct._norm_name(name or "") != _acct._norm_name(_OWNER):
        raise HTTPException(403, f"交易功能僅限帳號「{_OWNER}」使用")


def _require_configured():
    if not bt.configured():
        raise HTTPException(503, "未設定 Binance 交易金鑰（BINANCE_TRADE_API_KEY/SECRET）")


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
            vals = (time.time(), bt.env_name(), kw.get("source"), kw.get("status"),
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


# ── 自動交易執行器（notify_monitor 呼叫；絕不向外拋例外）───────
def execute_signal_trade(market, exchange, symbol, tf, k, d, sig):
    """新進場訊號 → 依自動交易設定市價進場 + 掛交易所託管 SL/TP。"""
    try:
        if market != "crypto" or not bt.configured():
            return
        cfg = get_auto_cfg()
        if not (cfg["on"] and k in cfg["sigs"] and tf in cfg["tfs"]):
            return
        want = "short" if d == "s" else "long"
        if cfg["dirs"] != "both" and cfg["dirs"] != want:
            return
        import routes.notify as notify
        # ⚠ 關鍵：只交易「擁有者帳號自己的自選清單」裡的標的。
        # 監控器會掃描所有訂閱推播帳號（種子帳號/其他用戶）的自選 → 若不限定擁有者，
        # 別人自選的訊號就會用你的 Binance 帳戶下單（曾發生：自動開了 ICNT/SPORTFUN 等
        # 根本不在自選的單）。owner 未綁定 → 不交易。
        owner = (cfg.get("owner") or "").strip()
        if not owner:
            return
        owner_syms = {(w.get("symbol") or "") for w in notify.account_watchlist(owner)}
        if symbol not in owner_syms:
            return
        evt_key = f"atrade:{symbol}:{tf}:{k}:{d}:{sig.get('t')}"
        if notify.seen_event(evt_key):
            return
        notify.mark_event(evt_key)   # 先標記：下單只該嘗試一次，失敗也不無限重試

        entry = sig.get("entry")
        stop = sig.get("stop")
        rr = sig.get("rr")
        if entry is None or stop is None:
            return
        bsym, scale = bt.resolve_symbol(symbol)
        pos = bt.positions()
        if any(p["symbol"] == bsym for p in pos):
            _log_trade(source="auto", status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg="已有同合約持倉，略過")
            return
        if len(pos) >= cfg["maxPos"]:
            _log_trade(source="auto", status="skipped", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg=f"持倉數已達上限 {cfg['maxPos']}")
            return

        notional = cfg["usdt"] * cfg["lev"]
        px = bt.last_price(bsym)
        if notional < bt.min_notional(bsym):
            _log_trade(source="auto", status="failed", symbol=symbol, bsym=bsym,
                       side=want, sig=k, d=d, tf=tf, sigt=str(sig.get("t")),
                       msg=f"名目金額 {notional:.1f} 低於合約下限 {bt.min_notional(bsym)}")
            return
        qty = bt.quantize_qty(bsym, notional / px)
        try:
            bt.set_leverage(bsym, cfg["lev"])
        except bt.TradeError:
            pass   # 槓桿設定失敗就用現值（有倉位/掛單時交易所會拒改）

        side = "BUY" if want == "long" else "SELL"
        o = bt.place_order(bsym, side, qty, "MARKET")

        # SL=訊號停損價、TP=進場 ± 盈虧比×風險（皆為圖表價 → ×scale 換回合約價）
        sl_px = bt.quantize_price(bsym, float(stop) * scale)
        tp_px = None
        if rr:
            risk = abs(float(entry) - float(stop))
            tgt = float(entry) - rr * risk if d == "s" else float(entry) + rr * risk
            tp_px = bt.quantize_price(bsym, tgt * scale)
        close_side = "SELL" if want == "long" else "BUY"
        # 先掛停損（自動單的安全命脈）。掛失敗 → 立刻市價平掉剛進的倉，絕不留「無停損保護」
        # 的自動倉位（曾發生：冷門合約不支援條件單 -4120，倉位開了卻沒 SL）。
        try:
            bt.place_close_trigger(bsym, close_side, sl_px, "sl")
        except bt.TradeError as e:
            try:
                bt.close_position(bsym)
            except bt.TradeError:
                pass
            _log_trade(source="auto", status="failed", symbol=symbol, bsym=bsym, side=want,
                       qty=qty, entry=str(entry), sl=str(stop), sig=k, d=d, tf=tf,
                       sigt=str(sig.get("t")),
                       msg=f"停損無法掛單（{e}）→ 已即時平倉，不留無保護持倉")
            print(f"  ⚠ 自動下單 {bsym} 停損掛單失敗，已平倉：{e}")
            return
        warn = []
        if tp_px:
            try:
                bt.place_close_trigger(bsym, close_side, tp_px, "tp")
            except bt.TradeError as e:
                warn.append(f"TP 掛單失敗（不影響停損保護）：{e}")
        _log_trade(source="auto", status="open", symbol=symbol, bsym=bsym, side=want,
                   qty=qty, entry=str(entry), sl=str(stop),
                   tp=(str(tp_px) if tp_px else None), sig=k, d=d, tf=tf,
                   sigt=str(sig.get("t")), msg="；".join(warn) or None)
        print(f"  🤖 自動下單 {bt.env_name()}: {bsym} {side} {qty}（{symbol} {tf} "
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
        if market != "crypto" or not bt.configured():
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
        r = bt.close_position(bsym)
        msg = "策略止盈平倉" if event == "tp" else "策略止損平倉"
        if not r.get("ok"):
            msg += "（交易所端已先出場）"
        _update_trade(row_id, "closed", msg)
        print(f"  🤖 自動平倉 {bt.env_name()}: {bsym}（{event}）")
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
def status():
    # owner = 交易功能限定的帳號（前端據此只在登入該帳號時顯示交易入口）；空＝不限帳號
    return {"configured": bt.configured(), "env": bt.env_name(), "locked": _locked(),
            "owner": _OWNER}


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
    _guard(req.key, req.name)
    _require_configured()
    try:
        return {"env": bt.env_name(), "balance": bt.balance(),
                "positions": bt.positions(), "orders": bt.open_orders(),
                "auto": get_auto_cfg(fresh=True)}
    except bt.TradeError as e:
        raise HTTPException(502, str(e))


@router.post("/order")
def order(req: OrderReq):
    _guard(req.key, req.name)
    _require_configured()
    want = "long" if req.side == "long" else "short"
    try:
        bsym, scale = bt.resolve_symbol(req.symbol)
        usdt = max(1.0, float(req.usdt))
        lev = max(1, min(int(req.lev), 50))
        notional = usdt * lev
        if notional < bt.min_notional(bsym):
            raise bt.TradeError(f"名目金額 {notional:.1f} USDT 低於此合約下限 "
                                f"{bt.min_notional(bsym)}，請加大金額或槓桿")
        try:
            bt.set_leverage(bsym, lev)
        except bt.TradeError:
            pass
        side = "BUY" if want == "long" else "SELL"
        otype = "LIMIT" if req.type == "LIMIT" else "MARKET"
        ref_px = float(req.price) * scale if (otype == "LIMIT" and req.price) else bt.last_price(bsym)
        qty = bt.quantize_qty(bsym, notional / ref_px)
        price = bt.quantize_price(bsym, float(req.price) * scale) if (otype == "LIMIT" and req.price) else None
        o = bt.place_order(bsym, side, qty, otype, price=price)
        close_side = "SELL" if want == "long" else "BUY"
        warn = []
        for v, kind in ((req.sl, "sl"), (req.tp, "tp")):
            if v:
                try:
                    bt.place_close_trigger(bsym, close_side, bt.quantize_price(bsym, float(v) * scale), kind)
                except bt.TradeError as e:
                    warn.append(f"{'停損' if kind == 'sl' else '止盈'}掛單失敗：{e}")
        _log_trade(source="manual", status="open" if otype == "MARKET" else "pending",
                   symbol=req.symbol, bsym=bsym, side=want, qty=qty,
                   entry=(str(req.price) if price else None),
                   sl=(str(req.sl) if req.sl else None), tp=(str(req.tp) if req.tp else None),
                   msg="；".join(warn) or None)
        return {"ok": True, "bsym": bsym, "qty": qty, "order": o, "warn": warn}
    except bt.TradeError as e:
        raise HTTPException(400, str(e))


@router.post("/close")
def close(req: CloseReq):
    _guard(req.key, req.name)
    _require_configured()
    try:
        r = bt.close_position(req.bsym.upper())
        if r.get("ok"):
            _log_trade(source="manual", status="closed", symbol=req.bsym,
                       bsym=req.bsym.upper(), msg="手動平倉")
        return r
    except bt.TradeError as e:
        raise HTTPException(400, str(e))


@router.post("/cancel")
def cancel(req: CancelReq):
    _guard(req.key, req.name)
    _require_configured()
    try:
        bt.cancel_order(req.bsym.upper(), req.orderId)
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
    _guard(req.key, req.name)
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
    if bt.configured():
        try:
            pnl = bt.income_history(40)
        except bt.TradeError:
            pass
    return {"log": log, "pnl": pnl}
