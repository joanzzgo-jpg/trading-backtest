"""Binance USDⓈ-M 永續合約客戶端（多帳戶：每個帳號用自己的金鑰）。

設計：
- **每個呼叫帶入該帳號的金鑰**（Client 物件持有 key/secret/env）→ 不再讀全域 env，
  讓多帳戶各自交易到自己的帳戶。金鑰由 routes/trade.py 從加密儲存解出後建立 Client；
  擁有者帳號（TRADE_OWNER）沒綁自己的金鑰時，退回用 env 金鑰（env_client）。
- 公開端點（exchangeInfo / ticker price）不需金鑰 → 模組層級函式、依 env（testnet/live）
  各自快取（兩網合約清單不同、量化規則也不同）。
- 單向持倉模式（One-way）；TP/SL 用 closePosition=true 條件市價單交易所託管。
- 數量/價格依 exchangeInfo 的 stepSize/tickSize 量化（快取 1hr）。
- 圖表符號 "BTC/USDT(.P)" → "BTCUSDT"；圖上 1000 倍合約（÷1000 顯示）→ 下單換回 1000 倍、價格 ×1000。
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

# env 金鑰（給擁有者帳號 qwer 用；其他帳號各自綁自己的）
_ENV_API_KEY    = (os.getenv("BINANCE_TRADE_API_KEY") or "").strip()
_ENV_API_SECRET = (os.getenv("BINANCE_TRADE_API_SECRET") or "").strip()
_ENV_ENV        = (os.getenv("BINANCE_TRADE_ENV") or "testnet").strip().lower()


class TradeError(Exception):
    """下單/查詢失敗（含 Binance 回的錯誤訊息），路由層轉成 HTTP 4xx/5xx。"""


def _base_for(env: str) -> str:
    return LIVE_BASE if env == "live" else TESTNET_BASE


def norm_env(env) -> str:
    return "live" if str(env).strip().lower() == "live" else "testnet"


def env_configured() -> bool:
    """env 是否設了金鑰（給擁有者帳號退回用）。"""
    return bool(_ENV_API_KEY and _ENV_API_SECRET)


def env_name() -> str:
    return norm_env(_ENV_ENV)


def env_client():
    """用 env 金鑰建 Client（擁有者帳號 qwer 沒綁自己金鑰時退回用）。"""
    return Client(_ENV_API_KEY, _ENV_API_SECRET, _ENV_ENV) if env_configured() else None


# ── 公開端點（無金鑰，依 env 各自快取）─────────────────────────
def _public_get(env: str, path: str, params: dict = None, timeout: float = 10.0):
    try:
        r = requests.get(_base_for(env) + path, params=params or {}, timeout=timeout)
    except requests.RequestException as e:
        raise TradeError(f"連線 Binance 失敗：{e}")
    if r.status_code >= 400:
        raise TradeError(f"Binance 公開端點錯誤（HTTP {r.status_code}）：{r.text[:160]}")
    return r.json()


_xinfo_cache = {}        # env -> {"ts":..., "symbols":{...}}
_xinfo_lock = threading.Lock()


def exchange_info(env: str = "testnet") -> dict:
    env = norm_env(env)
    with _xinfo_lock:
        c = _xinfo_cache.get(env)
        if c and time.time() - c["ts"] < 3600 and c["symbols"]:
            return c["symbols"]
    data = _public_get(env, "/fapi/v1/exchangeInfo", timeout=15)
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
        with _xinfo_lock:
            _xinfo_cache[env] = {"ts": time.time(), "symbols": out}
    return out


def resolve_symbol(app_symbol: str, env: str = "testnet"):
    """圖表符號 → (Binance 合約符號, 價格倍率)。找不到 → TradeError。"""
    s = (app_symbol or "").strip().upper()
    if s.endswith(".P"):
        s = s[:-2]
    sym = s.replace("/", "").replace("_", "")
    info = exchange_info(env)
    if sym in info:
        return sym, 1.0
    base = s.split("/")[0]
    alt = f"1000{base}USDT"
    if alt in info:
        return alt, 1000.0
    raise TradeError(f"Binance 永續找不到合約：{app_symbol}")


def _q(val, step, mode=ROUND_DOWN) -> str:
    d = (Decimal(str(val)) / Decimal(step)).to_integral_value(rounding=mode) * Decimal(step)
    s = format(d, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def quantize_qty(sym: str, qty: float, env: str = "testnet") -> str:
    f = exchange_info(env).get(sym) or {}
    q = _q(qty, f.get("stepSize", "0.001"), ROUND_DOWN)
    if Decimal(q) <= 0 or Decimal(q) < Decimal(f.get("minQty", "0")):
        raise TradeError(f"數量太小（{sym} 最小 {f.get('minQty')}）：請加大金額或槓桿")
    return q


def quantize_price(sym: str, price: float, env: str = "testnet") -> str:
    f = exchange_info(env).get(sym) or {}
    return _q(price, f.get("tickSize", "0.01"), ROUND_HALF_UP)


def min_notional(sym: str, env: str = "testnet") -> float:
    try:
        return float((exchange_info(env).get(sym) or {}).get("minNotional", 5))
    except Exception:
        return 5.0


def last_price(sym: str, env: str = "testnet") -> float:
    j = _public_get(env, "/fapi/v1/ticker/price", {"symbol": sym}, timeout=5)
    return float(j["price"])


def verify_keys(api_key: str, api_secret: str, env: str = "testnet") -> dict:
    """驗證一組金鑰能否查餘額（綁定時用）。成功回 balance，失敗拋 TradeError。"""
    return Client(api_key, api_secret, env).balance()


# 合約槓桿分級快取：(env, sym) → (max_leverage, maintenance_margin_rate)
_levbr_cache = {}


# ── 私有端點客戶端（每個帳號一個 Client）──────────────────────
class Client:
    def __init__(self, api_key: str, api_secret: str, env: str = "testnet"):
        self.api_key = api_key or ""
        self.api_secret = api_secret or ""
        self.env = norm_env(env)
        self.base = _base_for(self.env)

    def _request(self, method: str, path: str, params: dict = None, timeout: float = 10.0):
        if not (self.api_key and self.api_secret):
            raise TradeError("缺少 API 金鑰")
        params = {k: v for k, v in (params or {}).items() if v is not None}
        params["timestamp"] = int(time.time() * 1000)
        params["recvWindow"] = 5000
        qs = urlencode(params)
        params["signature"] = hmac.new(self.api_secret.encode(), qs.encode(),
                                       hashlib.sha256).hexdigest()
        try:
            r = requests.request(method, self.base + path, params=params,
                                 headers={"X-MBX-APIKEY": self.api_key}, timeout=timeout)
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

    # 量化便捷（綁定此 client 的 env）
    def resolve_symbol(self, s):       return resolve_symbol(s, self.env)
    def quantize_qty(self, sym, q):    return quantize_qty(sym, q, self.env)
    def quantize_price(self, sym, p):  return quantize_price(sym, p, self.env)
    def min_notional(self, sym):       return min_notional(sym, self.env)
    def last_price(self, sym):         return last_price(sym, self.env)

    def lev_bracket(self, sym):
        """回 (該合約最大可用槓桿, 第一級維持保證金率 mmr)。簽名端點、依 (env,sym) 快取。
        失敗 → 保守預設 (20, 0.01)。"""
        key = (self.env, sym)
        c = _levbr_cache.get(key)
        if c:
            return c
        try:
            rows = self._request("GET", "/fapi/v1/leverageBracket", {"symbol": sym})
            br = (rows[0].get("brackets") if rows else []) or []
            max_lev = max(int(b.get("initialLeverage", 1)) for b in br) if br else 20
            # 取最低門檻那一級的維持保證金率（最寬鬆、最保守地估強平緩衝）
            mmr = min(float(b.get("maintMarginRatio", 0.01)) for b in br) if br else 0.01
            out = (max_lev, mmr if mmr > 0 else 0.005)
        except Exception:
            out = (20, 0.01)
        _levbr_cache[key] = out
        return out

    # ── 查詢 ──
    def balance(self) -> dict:
        rows = self._request("GET", "/fapi/v2/balance")
        for b in rows:
            if b.get("asset") == "USDT":
                return {"total": float(b.get("balance", 0)),
                        "available": float(b.get("availableBalance", 0)),
                        "unrealized": float(b.get("crossUnPnl", 0))}
        return {"total": 0.0, "available": 0.0, "unrealized": 0.0}

    def positions(self) -> list:
        rows = self._request("GET", "/fapi/v2/positionRisk")
        out = []
        for p in rows:
            amt = float(p.get("positionAmt", 0) or 0)
            if not amt:
                continue
            mark = float(p.get("markPrice", 0) or 0)
            out.append({
                "symbol": p["symbol"], "side": "long" if amt > 0 else "short",
                "qty": abs(amt), "entry": float(p.get("entryPrice", 0) or 0),
                "mark": mark, "upnl": float(p.get("unRealizedProfit", 0) or 0),
                "lev": int(float(p.get("leverage", 0) or 0)),
                "liq": float(p.get("liquidationPrice", 0) or 0),
                "notional": abs(amt) * mark,
            })
        return out

    def open_orders(self, sym: str = None) -> list:
        rows = self._request("GET", "/fapi/v1/openOrders", {"symbol": sym} if sym else {})
        return [{
            "symbol": o["symbol"], "orderId": o["orderId"], "type": o["type"],
            "side": o["side"], "qty": float(o.get("origQty", 0) or 0),
            "price": float(o.get("price", 0) or 0),
            "stopPrice": float(o.get("stopPrice", 0) or 0),
            "reduceOnly": bool(o.get("reduceOnly")), "closePosition": bool(o.get("closePosition")),
            "time": o.get("time"),
        } for o in rows]

    def income_history(self, limit: int = 40) -> list:
        rows = self._request("GET", "/fapi/v1/income",
                             {"incomeType": "REALIZED_PNL", "limit": max(1, min(limit, 100))})
        rows.sort(key=lambda r: r.get("time", 0), reverse=True)
        return [{"symbol": r.get("symbol"), "pnl": float(r.get("income", 0) or 0),
                 "ts": (r.get("time") or 0) / 1000} for r in rows]

    # ── 下單 ──
    def set_leverage(self, sym: str, lev: int):
        lev = max(1, min(int(lev), 125))
        self._request("POST", "/fapi/v1/leverage", {"symbol": sym, "leverage": lev})

    def place_order(self, sym, side, qty, order_type="MARKET", price=None, reduce_only=False) -> dict:
        p = {"symbol": sym, "side": side, "type": order_type, "quantity": qty}
        if order_type == "LIMIT":
            if not price:
                raise TradeError("限價單需要價格")
            p["price"] = price
            p["timeInForce"] = "GTC"
        if reduce_only:
            p["reduceOnly"] = "true"
        o = self._request("POST", "/fapi/v1/order", p)
        return {"orderId": o.get("orderId"), "status": o.get("status"),
                "avgPrice": float(o.get("avgPrice", 0) or 0)}

    def place_close_trigger(self, sym, side, stop_price, kind) -> dict:
        # ⚠ 2025-12-09 起 Binance USDⓈ-M 把所有條件單(STOP_MARKET/TAKE_PROFIT_MARKET/STOP/
        # TAKE_PROFIT/TRAILING_STOP_MARKET)遷到 Algo Order API：舊的 POST /fapi/v1/order 掛這些
        # 一律回 -4120(STOP_ORDER_SWITCH_ALGO，與幣種無關，BTC 也擋)。改用 POST /fapi/v1/algoOrder：
        # 必帶 algoType=CONDITIONAL，且價格參數名由 stopPrice 改為 triggerPrice。
        t = "STOP_MARKET" if kind == "sl" else "TAKE_PROFIT_MARKET"
        o = self._request("POST", "/fapi/v1/algoOrder", {
            "algoType": "CONDITIONAL", "symbol": sym, "side": side, "type": t,
            "triggerPrice": stop_price, "closePosition": "true", "workingType": "CONTRACT_PRICE",
        })
        return {"orderId": o.get("orderId") or o.get("algoId") or o.get("strategyId"),
                "status": o.get("status")}

    def cancel_order(self, sym, order_id):
        self._request("DELETE", "/fapi/v1/order", {"symbol": sym, "orderId": order_id})

    def cancel_all(self, sym):
        self._request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": sym})

    def cancel_all_algo(self, sym):
        # 條件單(SL/TP)現為 Algo Order，allOpenOrders 不含 → 需用 algo 專屬端點取消（避免孤兒停損）
        self._request("DELETE", "/fapi/v1/algoOrders", {"symbol": sym})

    def cancel_algo(self, sym, algo_id):
        # 取消單一 Algo 條件單（用 algoId）：供「TP 跟著中軌移動」只取消舊 TP、不動 SL
        self._request("DELETE", "/fapi/v1/algoOrder", {"symbol": sym, "algoId": algo_id})

    def close_position(self, sym) -> dict:
        pos = [p for p in self.positions() if p["symbol"] == sym]
        try:
            self.cancel_all(sym)
        except TradeError:
            pass
        try:
            self.cancel_all_algo(sym)    # 一併取消 Algo 條件單(SL/TP)
        except TradeError:
            pass
        if not pos:
            return {"ok": False, "msg": "已無持倉"}
        p = pos[0]
        side = "SELL" if p["side"] == "long" else "BUY"
        qty = self.quantize_qty(sym, p["qty"])
        o = self.place_order(sym, side, qty, "MARKET", reduce_only=True)
        return {"ok": True, "order": o}
