"""搜索 API 路由"""
from fastapi import APIRouter, HTTPException
from data.taiwan import search_tw_stock
from data.us_stock import search_us_stocks
from data.crypto import fetch_crypto_markets, fetch_tickers, _fetch_pionex_symbols, _fetch_pionex_perp_symbols
from utils.cache import cache

router = APIRouter(prefix="/api", tags=["search"])


@router.get("/search")
def search(market: str, keyword: str, token: str = ""):
    """搜索標的"""
    if market == "tw":
        return {"results": search_tw_stock(keyword, token)}
    elif market == "crypto":
        exchange = keyword if keyword in ["pionex", "binance", "bybit", "okx"] else "pionex"
        markets  = fetch_crypto_markets(exchange)
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


@router.get("/tickers")
def get_tickers(market: str = "futures"):
    """取得標的列表"""
    cache_key = f"tickers:{market}"
    cached = cache.get(cache_key, ttl=2)
    if cached:
        return cached
    tickers = fetch_tickers(market)
    source = "fapi" if (tickers and "spot" in tickers[0] and market == "futures") else "spot"
    result = {"tickers": tickers, "source": source}
    cache.set(cache_key, result)
    return result


@router.get("/pionex/symbols")
def get_pionex_symbols():
    """診斷用：回傳目前快取的 Pionex 標的清單"""
    spot  = _fetch_pionex_symbols()
    perp  = _fetch_pionex_perp_symbols()
    return {
        "spot":  {"count": len(spot),  "symbols": sorted(spot)},
        "perp":  {"count": len(perp),  "symbols": sorted(perp)},
    }
