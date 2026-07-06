"""Fugle 富果 Marketdata futopt API — 台指期（TAIEX 期貨）『即時』行情。

與 data/fugle.py 同一把 X-API-KEY（同 FUGLE_TOKEN、同 host、同限流）→ 直接
共用它的金鑰池／round-robin／429 冷卻，不另開一套。

futopt（期貨/選擇權）為 Fugle BETA API，**只有今日盤中資料，無跨日歷史**：
  GET /marketdata/v1.0/futopt/intraday/candles/{symbol}?timeframe={1|5|15|30|60}
  GET /marketdata/v1.0/futopt/intraday/quote/{symbol}
  GET /marketdata/v1.0/futopt/intraday/tickers?type=FUTURE&exchange=TAIFEX&session=REGULAR&product=TXF
  header: X-API-KEY: <token>

本模組只做「台指三兄弟」：大台 TXF、小台 MXF、微台 TMF。前端用產品碼當 symbol，
本模組再解析成當前近月合約碼（如 TXFC5）去打 Fugle。
"""
import time
import requests
import pandas as pd
from datetime import date

from data.fugle import _pick_key, fugle_enabled  # 共用金鑰池／冷卻
from utils.cache import cache

_BASE = "https://api.fugle.tw/marketdata/v1.0/futopt"
_TF = {"1m": "1", "5m": "5", "15m": "15", "1h": "60"}   # 30m 不接（前端無此鈕）；4h/日線 futopt 無

# 產品碼 → 顯示名（台指三兄弟）
PRODUCTS = {
    "TXF": "台指期(大台)",
    "MXF": "小台指",
    "TMF": "微台指",
}


def _get(path: str, params: dict):
    """打 futopt 端點，回 (status_code, json)；例外回 (None, None)。429 冷卻該把金鑰。"""
    token = _pick_key()
    if not token:
        return None, None
    try:
        r = requests.get(f"{_BASE}/{path}", params=params,
                         headers={"X-API-KEY": token}, timeout=8)
        if r.status_code == 429:
            # 沿用 fugle 的冷卻表（同一把金鑰）
            from data.fugle import _cooldown
            _cooldown[token] = time.time() + 60
            return 429, None
        if r.status_code != 200:
            return r.status_code, None
        return 200, r.json()
    except Exception:
        return None, None


def resolve_front_month(product: str):
    """把產品碼（TXF/MXF/TMF）解析成當前近月合約碼（如 TXFC5）。
    近月＝ endDate >= 今天 的合約中 endDate 最小者。每日快取。未啟用/失敗回 None。"""
    product = (product or "").upper()
    if product not in PRODUCTS or not fugle_enabled():
        return None
    ckey = f"futopt_front_{product}"
    cached = cache.get(ckey, ttl=6 * 3600)   # 近月一天內不變，快取 6 小時
    if cached:
        return cached
    status, j = _get("intraday/tickers", {
        "type": "FUTURE", "exchange": "TAIFEX", "session": "REGULAR", "product": product,
    })
    if status != 200 or not j:
        return None
    today = date.today().isoformat()
    cand = []
    for d in j.get("data") or []:
        sym = d.get("symbol") or ""
        end = d.get("endDate") or ""
        # 只取單一近月合約（symbol=產品碼+2碼月年，長度 5），排除價差/組合單
        if not (sym.startswith(product) and len(sym) == len(product) + 2):
            continue
        if end and end >= today:
            cand.append((end, sym))
    if not cand:
        return None
    cand.sort()                       # endDate 升冪 → 第一個即近月
    front = cand[0][1]
    cache.set(ckey, front)
    return front


def _resolve(symbol_or_product: str):
    """前端可能傳產品碼(TXF)或直接合約碼(TXFC5)。是產品碼就解析近月，否則原樣用。"""
    s = (symbol_or_product or "").upper()
    if s in PRODUCTS:
        return resolve_front_month(s)
    return s or None


def fetch_futopt_candles(symbol_or_product: str, timeframe: str):
    """今日即時分鐘K DataFrame（time=UTC naive，與 fugle stock 一致），失敗/未啟用回 None。"""
    tfp = _TF.get(timeframe)
    if not tfp or not fugle_enabled():
        return None
    sym = _resolve(symbol_or_product)
    if not sym:
        return None
    status, j = _get(f"intraday/candles/{sym}", {"timeframe": tfp})
    if status != 200 or not j:
        return None
    rows = j.get("data") or []
    if not rows:
        return None
    out = []
    for c in rows:
        # "2026-05-29T08:45:00.000+08:00" → UTC naive（前端 toTime() +8 還原台北時間）
        ts = pd.Timestamp(c["date"]).tz_convert("UTC").tz_localize(None)
        out.append({"time": ts, "open": c.get("open"), "high": c.get("high"),
                    "low": c.get("low"), "close": c.get("close"),
                    "volume": c.get("volume") or 0})
    if not out:
        return None
    return pd.DataFrame(out).sort_values("time").reset_index(drop=True)


def fetch_futopt_quote(symbol_or_product: str):
    """即時報價 dict：{symbol, name, price, change_amt, change_pct, volume, open, high, low, bid, ask}。
    失敗/未啟用/休市回 None。"""
    if not fugle_enabled():
        return None
    prod = (symbol_or_product or "").upper()
    sym = _resolve(prod)
    if not sym:
        return None
    status, j = _get(f"intraday/quote/{sym}", {})
    if status != 200 or not j:
        return None
    price = j.get("lastPrice")
    if price is None:
        return None
    lt = j.get("lastTrade") or {}
    total = j.get("total") or {}
    return {
        "symbol": prod if prod in PRODUCTS else sym,
        "contract": sym,
        "name": PRODUCTS.get(prod, sym),
        "price": price,
        "change_amt": j.get("change"),
        "change_pct": j.get("changePercent"),
        "volume": total.get("tradeVolume") or 0,
        "open": j.get("openPrice"),
        "high": j.get("highPrice"),
        "low": j.get("lowPrice"),
        "bid": lt.get("bid"),
        "ask": lt.get("ask"),
    }


def fetch_futopt_tickers():
    """報價牆用：台指三兄弟近月合約即時報價 rows（欄位與台股 ticker 一致）。"""
    out = []
    for prod in PRODUCTS:
        q = fetch_futopt_quote(prod)
        if not q or not q.get("price"):
            continue
        out.append({
            "symbol": prod, "display": prod, "name": q["name"],
            "price": q["price"],
            "change_pct": q.get("change_pct") or 0.0,
            "change_amt": q.get("change_amt") or 0.0,
            "volume": q.get("volume") or 0,
            "is_future": True,          # 前端據此把台指期置頂於台股清單
        })
    return out
