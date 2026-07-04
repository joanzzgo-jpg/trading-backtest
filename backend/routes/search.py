"""搜索 API 路由"""
from fastapi import APIRouter, HTTPException, Response
from data.taiwan import search_tw_stock
from data.us_stock import search_us_stocks
from data.crypto import fetch_crypto_markets, fetch_tickers, _fetch_pionex_symbols, _fetch_pionex_perp_symbols
from utils.cache import cache

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
def search(market: str, keyword: str, exchange: str = "pionex", token: str = ""):
    """搜索標的"""
    if market == "tw":
        return {"results": search_tw_stock(keyword, token)}
    elif market == "crypto":
        # keyword 為交易所名稱時當交易所過濾用（舊行為兼容）；否則當搜尋關鍵字
        if keyword in ["pionex", "binance", "bybit", "okx"]:
            exchange = keyword
            kw = ""
        else:
            kw = (keyword or "").strip().upper()
        markets = fetch_crypto_markets(exchange)
        if kw:
            # 按關鍵字過濾（base 或 symbol contains）
            markets = [m for m in markets if kw in m.get("base", "").upper() or kw in m.get("symbol", "").upper()]
        return {"results": markets[:50]}
    return {"results": []}


@router.get("/us/search")
def us_search(q: str = ""):
    """搜尋美股標的"""
    if not q or len(q) < 1:
        return {"results": []}
    cache_key = f"us_search:{q.upper()}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached
    results = search_us_stocks(q)
    result = {"results": results}
    cache.set(cache_key, result)
    return result


@router.get("/hk/search")
def hk_search(q: str = ""):
    """搜尋港股標的：沿用 Yahoo 搜尋(非中資)、只留 .HK 結果(可用名稱或代號搜，如 tencent / 0700)。"""
    if not q or len(q) < 1:
        return {"results": []}
    cache_key = f"hk_search:{q.upper()}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached
    results = [r for r in search_us_stocks(q) if str(r.get("symbol", "")).upper().endswith(".HK")]
    result = {"results": results}
    cache.set(cache_key, result)
    return result


@router.get("/tickers")
def get_tickers(response: Response, market: str = "futures"):
    """取得標的列表：優先從記憶體即時快取讀取，啟動初期才 fallback 至直接 API。"""
    from utils.live_data import get as live_get, has_data, has_tw_data
    from data.taiwan import fetch_tw_tickers
    # HTTP 快取：crypto 1s（每秒輪詢）、tw 10s。瀏覽器與中介層可用此短快取
    # 避免多分頁/多用戶同步 polling 造成的重複請求
    response.headers["Cache-Control"] = f"public, max-age={10 if market == 'tw' else 1}"
    if market == "tw":
        if has_tw_data():
            return {"tickers": live_get("tw"), "source": "live"}
        return {"tickers": fetch_tw_tickers(), "source": "direct"}
    if has_data():
        return {"tickers": live_get(market), "source": "live"}
    # 冷啟動 fallback：直接呼叫 API
    tickers = fetch_tickers(market)
    return {"tickers": tickers, "source": "direct"}


@router.get("/pionex/symbols")
def get_pionex_symbols():
    """診斷用：回傳目前快取的 Pionex 標的清單"""
    spot  = _fetch_pionex_symbols()
    perp  = _fetch_pionex_perp_symbols()
    return {
        "spot":  {"count": len(spot),  "symbols": sorted(spot)},
        "perp":  {"count": len(perp),  "symbols": sorted(perp)},
    }
