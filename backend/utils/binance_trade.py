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
# 2026-06：Binance 把合約測試網由舊 testnet.binancefuture.com 遷到新版 demo 平台
# （後台 demo.binance.com / API 域名 demo-fapi.binance.com）。兩者目前同帳號同資料，
# 但舊域名屬「舊版」會被淘汰 → 改用新域名。新版測試網需在 demo.binance.com 另建金鑰。
TESTNET_BASE = "https://demo-fapi.binance.com"

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

    # ── 持倉模式（單向 / 雙向 Hedge）──────────────────────────────
    # Binance USDⓈ-M 帳號級設定 dualSidePosition：False=單向(每幣一個淨倉)、True=雙向(同幣可同時持
    # 多倉+空倉、各自獨立 SL/TP)。FVG 雙槽（同幣多空並存）需 hedge。依 client 實例快取，避免每單一次 API。
    def get_position_mode(self) -> bool:
        """回 True=雙向(hedge) / False=單向。失敗保守回 False(單向)。"""
        if getattr(self, "_pos_mode", None) is not None:
            return self._pos_mode
        try:
            r = self._request("GET", "/fapi/v1/positionSide/dual")
            self._pos_mode = bool(r.get("dualSidePosition"))
        except TradeError:
            self._pos_mode = False
        return self._pos_mode

    def set_position_mode(self, hedge: bool):
        """切帳號持倉模式。有持倉/掛單時 Binance 會拒切(-4059/-4068 等) → 拋 TradeError 給上層提示。"""
        self._request("POST", "/fapi/v1/positionSide/dual",
                      {"dualSidePosition": "true" if hedge else "false"})
        self._pos_mode = bool(hedge)

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
                "posSide": p.get("positionSide", "BOTH"),   # hedge 下 LONG/SHORT，單向為 BOTH
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
            "posSide": o.get("positionSide", "BOTH"),     # hedge 下 LONG/SHORT，供分側撤單
            "time": o.get("time"),
        } for o in rows]

    def algo_orders(self, sym: str = None) -> list:
        """查目前掛著的 algo 條件單(SL/TP)的『實際觸發價』，供核對通知/紀錄的止損止盈是否一致。
        Binance 2025-12 把條件單遷到 algo API → 不在 /fapi/v1/openOrders；用 algo 專屬 GET。
        端點/權限失敗一律回空（read-only，絕不影響面板）。回 type=STOP_MARKET(止損)/TAKE_PROFIT_MARKET(止盈)。"""
        # ⚠ read-only、純核對用：無論端點對錯、回傳格式如何，一律不得拋例外（曾因未知格式拖垮
        # /overview → 持倉頁卡死）。整段以 try 包住、任何例外都回 []。
        try:
            # 官方端點：GET /fapi/v1/openAlgoOrders（symbol 省略=回全部標的）。回傳每筆含 orderType/
            # algoId/triggerPrice/closePosition（type 欄位名實為 orderType）。
            try:
                rows = self._request("GET", "/fapi/v1/openAlgoOrders", {"symbol": sym} if sym else {})
            except Exception:
                rows = None
            if isinstance(rows, dict):
                rows = rows.get("orders") or rows.get("data") or []
            if not isinstance(rows, list):
                return []
            out = []
            for o in rows:
                if not isinstance(o, dict):
                    continue
                try:
                    out.append({
                        "symbol": o.get("symbol"),
                        "algoId": o.get("algoId") or o.get("orderId") or o.get("strategyId"),
                        "type": o.get("orderType") or o.get("type"),    # STOP_MARKET / TAKE_PROFIT_MARKET
                        "side": o.get("side"),
                        "triggerPrice": float(o.get("triggerPrice", 0) or o.get("stopPrice", 0) or 0),
                        "closePosition": bool(o.get("closePosition")),
                        "posSide": o.get("positionSide", "BOTH"),       # hedge 分側撤 SL/TP 用
                    })
                except (TypeError, ValueError):
                    continue
            return out
        except Exception:
            return []

    def income_history(self, limit: int = 40) -> list:
        rows = self._request("GET", "/fapi/v1/income",
                             {"incomeType": "REALIZED_PNL", "limit": max(1, min(limit, 100))})
        rows.sort(key=lambda r: r.get("time", 0), reverse=True)
        return [{"symbol": r.get("symbol"), "pnl": float(r.get("income", 0) or 0),
                 "ts": (r.get("time") or 0) / 1000} for r in rows]

    def income_daily(self, start_ms: int, end_ms: int = None) -> list:
        """區間內『交易損益明細』給每日盈虧月曆用：已實現損益 + 手續費 + 資金費，按來源時間。
        排除 TRANSFER（出入金）等非交易項，避免污染每日盈虧。
        ⚠ Binance /fapi/v1/income 是『從 startTime 往後、時間升序』回傳，單次上限 1000 筆。
        自動交易 75 天內常超過 1000（每筆平倉有 已實現+手續費 多列＋每8h資金費）→ 單次抓只會拿到
        最舊的 1000，最近幾天(含今天/跨日)被截掉、月曆不結算。故改『往後分頁』把全區間抓齊。
        失敗由呼叫方處理。"""
        end = int(end_ms) if end_ms else None
        cur = int(start_ms)
        out = []
        keep = {"REALIZED_PNL", "COMMISSION", "FUNDING_FEE"}
        for _ in range(40):                                  # 安全上限：最多 40 頁(4 萬筆)
            params = {"startTime": cur, "limit": 1000}
            if end:
                params["endTime"] = end
            rows = self._request("GET", "/fapi/v1/income", params)
            if not rows:
                break
            for r in rows:
                if r.get("incomeType") in keep:
                    out.append({"symbol": r.get("symbol"),
                                "pnl": float(r.get("income", 0) or 0),
                                "ts": (r.get("time") or 0) / 1000,
                                "type": r.get("incomeType")})
            if len(rows) < 1000:                             # 不足一頁 → 已到區間尾
                break
            last = max((r.get("time") or 0) for r in rows)
            if last <= cur:                                  # 時間沒前進 → 防無限迴圈
                break
            cur = last + 1                                   # 下一頁從最後一筆之後接著抓
        return out

    def last_fill_price(self, sym: str):
        """最近一筆成交價（平倉通知顯示『出場 @ X』用）。純顯示、失敗回 None、絕不拋例外。"""
        try:
            rows = self._request("GET", "/fapi/v1/userTrades", {"symbol": sym, "limit": 1})
            if isinstance(rows, list) and rows:
                return float(rows[-1].get("price", 0) or 0) or None
        except Exception:
            pass
        return None

    # ── 下單 ──
    def set_leverage(self, sym: str, lev: int):
        lev = max(1, min(int(lev), 125))
        self._request("POST", "/fapi/v1/leverage", {"symbol": sym, "leverage": lev})

    def place_order(self, sym, side, qty, order_type="MARKET", price=None, reduce_only=False,
                    position_side=None) -> dict:
        p = {"symbol": sym, "side": side, "type": order_type, "quantity": qty}
        if order_type == "LIMIT":
            if not price:
                raise TradeError("限價單需要價格")
            p["price"] = price
            p["timeInForce"] = "GTC"
        # hedge：帶 positionSide(LONG/SHORT)，且 reduceOnly 互斥（hedge 下由 positionSide+反向 side 平倉）。
        if position_side in ("LONG", "SHORT"):
            p["positionSide"] = position_side
        elif reduce_only:
            p["reduceOnly"] = "true"
        o = self._request("POST", "/fapi/v1/order", p)
        return {"orderId": o.get("orderId"), "status": o.get("status"),
                "avgPrice": float(o.get("avgPrice", 0) or 0)}

    def place_close_trigger(self, sym, side, stop_price, kind, position_side=None) -> dict:
        # ⚠ 2025-12-09 起 Binance USDⓈ-M 把所有條件單(STOP_MARKET/TAKE_PROFIT_MARKET/STOP/
        # TAKE_PROFIT/TRAILING_STOP_MARKET)遷到 Algo Order API：舊的 POST /fapi/v1/order 掛這些
        # 一律回 -4120(STOP_ORDER_SWITCH_ALGO，與幣種無關，BTC 也擋)。改用 POST /fapi/v1/algoOrder：
        # 必帶 algoType=CONDITIONAL，且價格參數名由 stopPrice 改為 triggerPrice。
        t = "STOP_MARKET" if kind == "sl" else "TAKE_PROFIT_MARKET"
        p = {
            "algoType": "CONDITIONAL", "symbol": sym, "side": side, "type": t,
            "triggerPrice": stop_price, "closePosition": "true", "workingType": "CONTRACT_PRICE",
        }
        if position_side in ("LONG", "SHORT"):   # hedge：觸發單綁定該側持倉
            p["positionSide"] = position_side
        o = self._request("POST", "/fapi/v1/algoOrder", p)
        return {"orderId": o.get("orderId") or o.get("algoId") or o.get("strategyId"),
                "status": o.get("status")}

    def cancel_order(self, sym, order_id):
        self._request("DELETE", "/fapi/v1/order", {"symbol": sym, "orderId": order_id})

    def cancel_all(self, sym):
        self._request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": sym})

    def cancel_all_algo(self, sym):
        # 取消該合約所有 algo 條件單(SL/TP)。新版 Algo「取消全部」的 bulk 端點(algoOrderList)參數不明、
        # 易失效 → 改最可靠做法：先用「列出」(GET /fapi/v1/openAlgoOrders，已確認)拿到每筆的 algoId，
        # 再逐筆用「取消單筆」(DELETE /fapi/v1/algoOrder，已確認)刪掉。全程只用官方確認可用的端點。
        # 回成功取消的筆數；個別失敗不中斷(盡量清乾淨)。
        n = 0
        for o in self.algo_orders(sym):
            aid = o.get("algoId")
            if not aid:
                continue
            try:
                self.cancel_algo(sym, aid)
                n += 1
            except TradeError:
                pass
        return n

    def cancel_algo(self, sym, algo_id):
        # 取消單一 Algo 條件單（用 algoId）：供「TP 跟著中軌移動」只取消舊 TP、不動 SL。
        # ⚠ 官方文件參數只要 algoId（不含 symbol）→ 不送 symbol，避免新版端點對未列參數嚴格驗證而拒絕
        # （疑似害止盈一直移不動＝retarget 取消舊 TP 失敗）。sym 僅保留簽名相容、不送出。
        self._request("DELETE", "/fapi/v1/algoOrder", {"algoId": algo_id})

    def close_position(self, sym, position_side=None) -> dict:
        """平倉 + 清該合約掛單/觸發單。
        position_side=None（單向）：清整個合約所有單、平淨倉。
        position_side=LONG/SHORT（hedge）：只清『該側』的限價/觸發單、只平該側持倉（不碰對向倉）。"""
        ps = position_side if position_side in ("LONG", "SHORT") else None
        if ps:
            # ── hedge 分側清理：只撤該 side 的殘單/SL/TP，平該 side 的倉 ──
            try:
                for o in self.open_orders(sym):
                    if o.get("posSide") == ps:
                        try: self.cancel_order(sym, o["orderId"])
                        except TradeError: pass
            except TradeError:
                pass
            try:
                for o in self.algo_orders(sym):
                    if o.get("posSide") == ps and o.get("algoId"):
                        try: self.cancel_algo(sym, o["algoId"])
                        except TradeError: pass
            except TradeError:
                pass
            pos = [p for p in self.positions() if p["symbol"] == sym and p.get("posSide") == ps]
            if not pos:
                return {"ok": False, "msg": "已無持倉"}
            p = pos[0]
            close_side = "SELL" if ps == "LONG" else "BUY"   # 平該側 = 反向 + positionSide(不可 reduceOnly)
            qty = self.quantize_qty(sym, p["qty"])
            o = self.place_order(sym, close_side, qty, "MARKET", position_side=ps)
            return {"ok": True, "order": o}
        # ── 單向：維持原行為 ──
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
        # 先試 reduceOnly(最安全、絕不反向)；部分帳號/測試網會全面拒絕 reduceOnly(-2022 ReduceOnly
        # Order is rejected)→ 退回純市價平倉（數量＝持倉量、精確 → 平到 0、不會反向開倉）。
        try:
            o = self.place_order(sym, side, qty, "MARKET", reduce_only=True)
        except TradeError as e:
            if "-2022" in str(e) or "ReduceOnly" in str(e):
                o = self.place_order(sym, side, qty, "MARKET")   # 純市價(精確數量→平到0)
            else:
                raise
        return {"ok": True, "order": o}
