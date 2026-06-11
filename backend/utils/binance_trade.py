"""Binance USDⓈ-M 永續合約「下單」客戶端（手動交易 + 自動交易共用）。

設計：
- **預設 testnet 測試網**（BINANCE_TRADE_ENV=live 才打實盤）→ 沒設成 live 絕不會動真錢。
- 金鑰只放伺服器環境變數（BINANCE_TRADE_API_KEY / BINANCE_TRADE_API_SECRET），
  不經前端、不存 DB、不入帳號快照。缺金鑰 → configured()=False，交易功能整組停用。
- 行情/K 線仍走 data/crypto.py 的公開端點；本檔只管「簽名私有端點」（下單/持倉/槓桿）。
- 單向持倉模式（One-way, positionSide=BOTH）；TP/SL 用 closePosition=true 的條件市價單，
  由交易所託管（伺服器重啟也不影響出場）。
- 數量/價格依 exchangeInfo 的 stepSize/tickSize 量化（快取 1hr），否則下單必被拒。
- 圖表符號 "BTC/USDT" / "BTC/USDT.P" → "BTCUSDT"；圖上若用 1000 倍合約資料
  （如 1000PEPE 除以 1000 顯示），下單時自動換回 1000 倍合約並把價格 ×1000。
"""
import os
import time
import hmac
import hashlib
import threading
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from urllib.parse import urlencode

import requests

LIVE_BASE    = "https://fapi.binance.com"
TESTNET_BASE = "https://testnet.binancefuture.com"

_API_KEY    = (os.getenv("BINANCE_TRADE_API_KEY") or "").strip()
_API_SECRET = (os.getenv("BINANCE_TRADE_API_SECRET") or "").strip()
_ENV        = (os.getenv("BINANCE_TRADE_ENV") or "testnet").strip().lower()
BASE        = LIVE_BASE if _ENV == "live" else TESTNET_BASE


class TradeError(Exception):
    """下單/查詢失敗（含 Binance 回的錯誤訊息），路由層轉成 HTTP 4xx/5xx。"""


def configured() -> bool:
    return bool(_API_KEY and _API_SECRET)


def env_name() -> str:
    return "live" if _ENV == "live" else "testnet"


# ── HTTP（簽名）──────────────────────────────────────────────
def _request(method: str, path: str, params: dict = None, signed: bool = True,
             timeout: float = 10.0):
    params = {k: v for k, v in (params or {}).items() if v is not None}
    headers = {"X-MBX-APIKEY": _API_KEY} if _API_KEY else {}
    if signed:
        if not configured():
            raise TradeError("未設定 BINANCE_TRADE_API_KEY / BINANCE_TRADE_API_SECRET")
        params["timestamp"] = int(time.time() * 1000)
        params["recvWindow"] = 5000
        qs = urlencode(params)
        params["signature"] = hmac.new(_API_SECRET.encode(), qs.encode(),
                                       hashlib.sha256).hexdigest()
    try:
        r = requests.request(method, BASE + path, params=params,
                             headers=headers, timeout=timeout)
    except requests.RequestException as e:
        raise TradeError(f"連線 Binance 失敗：{e}")
    if r.status_code >= 400:
        try:
            j = r.json()
            msg = f"{j.get('msg', r.text)}（code {j.get('code')}）"
        except Exception:
            msg = r.text[:200]
        raise TradeError(f"Binance 拒絕（HTTP {r.status_code}）：{msg}")
    return r.json()


# ── exchangeInfo（量化規則，快取 1hr）─────────────────────────
_xinfo_cache = {"ts": 0.0, "symbols": {}}
_xinfo_lock = threading.Lock()


def _exchange_info() -> dict:
    """symbol → {stepSize, tickSize, minQty, minNotional}。公開端點、快取 1hr。"""
    with _xinfo_lock:
        if time.time() - _xinfo_cache["ts"] < 3600 and _xinfo_cache["symbols"]:
            return _xinfo_cache["symbols"]
        data = _request("GET", "/fapi/v1/exchangeInfo", signed=False, timeout=15)
        out = {}
        for s in data.get("symbols", []):
            if s.get("status") != "TRADING":
                continue
            f = {x["filterType"]: x for x in s.get("filters", [])}
            out[s["symbol"]] = {
                "stepSize": f.get("LOT_SIZE", {}).get("stepSize", "0.001"),
                "minQty": f.get("LOT_SIZE", {}).get("minQty", "0"),
                "tickSize": f.get("PRICE_FILTER", {}).get("tickSize", "0.01"),
                "minNotional": f.get("MIN_NOTIONAL", {}).get("notional", "5"),
            }
        if out:
            _xinfo_cache["symbols"] = out
            _xinfo_cache["ts"] = time.time()
        return _xinfo_cache["symbols"]


def resolve_symbol(app_symbol: str):
    """圖表符號 → (Binance 合約符號, 價格倍率)。
    "BTC/USDT.P"/"BTC/USDT" → "BTCUSDT"；找不到時試 "1000"+base（圖上 1000 倍合約
    已除以 1000 顯示 → 下單價格要 ×1000，倍率回 1000）。找不到 → TradeError。"""
    s = (app_symbol or "").strip().upper()
    if s.endswith(".P"):
        s = s[:-2]
    sym = s.replace("/", "").replace("_", "")
    info = _exchange_info()
    if sym in info:
        return sym, 1.0
    base = s.split("/")[0]
    alt = f"1000{base}USDT"
    if alt in info:
        return alt, 1000.0
    raise TradeError(f"Binance 永續找不到合約：{app_symbol}")


def _q(val, step, mode=ROUND_DOWN) -> str:
    """依 stepSize/tickSize 量化成字串（Decimal 防浮點誤差；去尾零）。"""
    d = (Decimal(str(val)) / Decimal(step)).to_integral_value(rounding=mode) * Decimal(step)
    s = format(d, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def quantize_qty(sym: str, qty: float) -> str:
    f = _exchange_info().get(sym) or {}
    q = _q(qty, f.get("stepSize", "0.001"), ROUND_DOWN)
    if Decimal(q) <= 0 or Decimal(q) < Decimal(f.get("minQty", "0")):
        raise TradeError(f"數量太小（{sym} 最小 {f.get('minQty')}）：請加大金額或槓桿")
    return q


def quantize_price(sym: str, price: float) -> str:
    f = _exchange_info().get(sym) or {}
    return _q(price, f.get("tickSize", "0.01"), ROUND_HALF_UP)


def min_notional(sym: str) -> float:
    try:
        return float((_exchange_info().get(sym) or {}).get("minNotional", 5))
    except Exception:
        return 5.0


# ── 查詢 ─────────────────────────────────────────────────────
def last_price(sym: str) -> float:
    j = _request("GET", "/fapi/v1/ticker/price", {"symbol": sym}, signed=False, timeout=5)
    return float(j["price"])


def balance() -> dict:
    """USDT 錢包：{total, available, unrealized}。"""
    rows = _request("GET", "/fapi/v2/balance")
    for b in rows:
        if b.get("asset") == "USDT":
            return {
                "total": float(b.get("balance", 0)),
                "available": float(b.get("availableBalance", 0)),
                "unrealized": float(b.get("crossUnPnl", 0)),
            }
    return {"total": 0.0, "available": 0.0, "unrealized": 0.0}


def positions() -> list:
    """非零持倉：[{symbol, side, qty, entry, mark, upnl, lev, liq, notional}]。"""
    rows = _request("GET", "/fapi/v2/positionRisk")
    out = []
    for p in rows:
        amt = float(p.get("positionAmt", 0) or 0)
        if not amt:
            continue
        mark = float(p.get("markPrice", 0) or 0)
        out.append({
            "symbol": p["symbol"],
            "side": "long" if amt > 0 else "short",
            "qty": abs(amt),
            "entry": float(p.get("entryPrice", 0) or 0),
            "mark": mark,
            "upnl": float(p.get("unRealizedProfit", 0) or 0),
            "lev": int(float(p.get("leverage", 0) or 0)),
            "liq": float(p.get("liquidationPrice", 0) or 0),
            "notional": abs(amt) * mark,
        })
    return out


def open_orders(sym: str = None) -> list:
    rows = _request("GET", "/fapi/v1/openOrders", {"symbol": sym} if sym else {})
    return [{
        "symbol": o["symbol"], "orderId": o["orderId"], "type": o["type"],
        "side": o["side"], "qty": float(o.get("origQty", 0) or 0),
        "price": float(o.get("price", 0) or 0),
        "stopPrice": float(o.get("stopPrice", 0) or 0),
        "reduceOnly": bool(o.get("reduceOnly")), "closePosition": bool(o.get("closePosition")),
        "time": o.get("time"),
    } for o in rows]


def income_history(limit: int = 40) -> list:
    """已實現盈虧紀錄（最近 7 天，由新到舊）。"""
    rows = _request("GET", "/fapi/v1/income",
                    {"incomeType": "REALIZED_PNL", "limit": max(1, min(limit, 100))})
    rows.sort(key=lambda r: r.get("time", 0), reverse=True)
    return [{"symbol": r.get("symbol"), "pnl": float(r.get("income", 0) or 0),
             "ts": (r.get("time") or 0) / 1000} for r in rows]


# ── 下單 ─────────────────────────────────────────────────────
def set_leverage(sym: str, lev: int):
    lev = max(1, min(int(lev), 125))
    _request("POST", "/fapi/v1/leverage", {"symbol": sym, "leverage": lev})


def place_order(sym: str, side: str, qty: str, order_type: str = "MARKET",
                price: str = None, reduce_only: bool = False) -> dict:
    """side=BUY/SELL；order_type=MARKET/LIMIT（LIMIT 必帶 price，GTC）。"""
    p = {"symbol": sym, "side": side, "type": order_type, "quantity": qty}
    if order_type == "LIMIT":
        if not price:
            raise TradeError("限價單需要價格")
        p["price"] = price
        p["timeInForce"] = "GTC"
    if reduce_only:
        p["reduceOnly"] = "true"
    o = _request("POST", "/fapi/v1/order", p)
    return {"orderId": o.get("orderId"), "status": o.get("status"),
            "avgPrice": float(o.get("avgPrice", 0) or 0)}


def place_close_trigger(sym: str, side: str, stop_price: str, kind: str) -> dict:
    """交易所託管的全倉出場條件單：kind=sl→STOP_MARKET / tp→TAKE_PROFIT_MARKET。
    closePosition=true：觸發即市價平掉整個倉位（不需數量、倉位加減碼也適用）。"""
    t = "STOP_MARKET" if kind == "sl" else "TAKE_PROFIT_MARKET"
    o = _request("POST", "/fapi/v1/order", {
        "symbol": sym, "side": side, "type": t,
        "stopPrice": stop_price, "closePosition": "true",
        "workingType": "CONTRACT_PRICE",   # 以最新成交價觸發（與圖表/策略判定一致）
    })
    return {"orderId": o.get("orderId"), "status": o.get("status")}


def cancel_order(sym: str, order_id: int):
    _request("DELETE", "/fapi/v1/order", {"symbol": sym, "orderId": order_id})


def cancel_all(sym: str):
    _request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": sym})


def close_position(sym: str) -> dict:
    """市價平掉該合約整個倉位＋撤掉掛單（孤兒 TP/SL 一併清除）。已無倉位 → ok=False。"""
    pos = [p for p in positions() if p["symbol"] == sym]
    try:
        cancel_all(sym)
    except TradeError:
        pass
    if not pos:
        return {"ok": False, "msg": "已無持倉"}
    p = pos[0]
    side = "SELL" if p["side"] == "long" else "BUY"
    qty = quantize_qty(sym, p["qty"])
    o = place_order(sym, side, qty, "MARKET", reduce_only=True)
    return {"ok": True, "order": o}
