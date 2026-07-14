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
        # 台指期歸在台股底下 → 三兄弟置頂於搜尋結果（可用 TXF/台指 等關鍵字搜）
        from data.taifex_mis import PRODUCTS as _FP
        kw = (keyword or "").strip().upper()
        futs = [{"symbol": s, "display": s, "name": n} for s, n in _FP.items()
                if not kw or kw in s or kw in n or "台指" in (keyword or "") or "期" in (keyword or "")]
        return {"results": futs + search_tw_stock(keyword, token)}
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
    """搜尋港股標的：主源騰訊建議(支援中文名/代號、繁簡橋接)，再併 Yahoo .HK 補英文邊角，去重。
    修：舊版只用 Yahoo → 繁體中文名(騰訊/美團/匯豐…)全查無，港股使用者搜不到自家股票。"""
    if not q or len(q) < 1:
        return {"results": []}
    cache_key = f"hk_search:{q.upper()}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached
    from data.hk_stock import search_hk_stocks, hk_canon_code
    results = search_hk_stocks(q)                      # 主源：騰訊建議（中文/代號/常見英文，~100-500ms）
    # 只有騰訊「查無」時才補打 Yahoo（Yahoo 每次 +0.5~8s 卻對中文回 0 筆 → 平時是純拖慢，故僅當後備）
    if not results:
        seen = set()
        for r in search_us_stocks(q):
            s = str(r.get("symbol", "")).upper()
            if not s.endswith(".HK"):
                continue
            c5 = hk_canon_code(s[:-3])                  # 正規化為標準 5 碼＋濾掉 80700 等雙櫃檯
            if not c5:
                continue
            s = f"{c5}.HK"
            if s not in seen:
                r["symbol"] = s
                results.append(r); seen.add(s)
    result = {"results": results}
    cache.set(cache_key, result)
    return result


@router.get("/tickers")
def get_tickers(response: Response, market: str = "futures", since: str = ""):
    """取得標的列表：優先從記憶體即時快取讀取，啟動初期才 fallback 至直接 API。
    since=上次回應的 rev token → 只回「有變動的標的」(delta:true)＋新 token；
    token 失效(重啟/別的worker/太舊/無資料) → 自動回整包。crypto 1s/tw 3s 輪詢頻寬大減、行為不變。"""
    from utils.live_data import get as live_get, has_data, has_tw_data, get_delta, delta_token
    from data.taiwan import fetch_tw_tickers
    # HTTP 快取：crypto 1s、tw 2s（台股高量股由 MIS 疊價 worker 每 3s 更新記憶體→短快取讓報價列即時跳）。
    # 避免多分頁/多用戶同步 polling 造成的重複請求。
    response.headers["Cache-Control"] = f"public, max-age={2 if market == 'tw' else 1}"
    if market == "tw":
        # 台指期（三兄弟近月）置頂於台股清單。cnyes 即時價(含夜盤)+MIS 參考價，快取 3 秒。
        from data.cnyes_futures import fetch_wall_tickers
        futs = cache.get("txf_tickers", ttl=3)
        if futs is None:
            futs = fetch_wall_tickers()
            cache.set("txf_tickers", futs)
        if has_tw_data():
            if since:
                d = get_delta("tw", since)
                if d is not None:   # delta＝台股變動檔＋台指期三兄弟一律附上（客戶端靠 symbol 合併）
                    d["tickers"] = (futs or []) + d["tickers"]
                    d["source"] = "live"
                    return d
            out = {"tickers": (futs or []) + live_get("tw"), "source": "live"}
            tok = delta_token("tw")
            if tok:
                out["rev"] = tok
            return out
        return {"tickers": (futs or []) + fetch_tw_tickers(), "source": "direct"}
    if has_data():
        if since:
            d = get_delta(market, since)
            if d is not None:
                d["source"] = "live"
                return d
        out = {"tickers": live_get(market), "source": "live"}
        tok = delta_token(market)
        if tok:
            out["rev"] = tok
        return out
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
