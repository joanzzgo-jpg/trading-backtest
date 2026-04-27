"""
FastAPI 後端主程式 - v2（含快取、MACD 指標）
"""
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import os, sys, time, math, gc

sys.path.insert(0, os.path.dirname(__file__))

from data.taiwan import fetch_tw_stock, resample_tw, search_tw_stock
from data.crypto import fetch_crypto_ohlcv, fetch_crypto_markets, fetch_tickers, _fetch_pionex_symbols, _fetch_futures_tickers_fapi
from indicators.engine import add_indicators, crt_markers, rsi as calc_rsi, macd as calc_macd
from backtest.engine import BacktestEngine, BacktestConfig
from strategies.builtin import BUILTIN_STRATEGIES

app = FastAPI(title="回測系統")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")


@app.on_event("startup")
async def _warmup():
    """啟動時預熱 Pionex 標的快取（背景執行，不阻塞啟動）"""
    import asyncio, concurrent.futures
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _fetch_pionex_symbols)


@app.get("/")
def index():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "templates", "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# ── 簡易記憶體快取（Railway 記憶體有限，保持小量）─────────────
_CACHE: dict = {}
_CACHE_MAX = 12   # 從 200 降到 12，避免 OOM

def _cache_get(key: str, ttl: int):
    if key in _CACHE:
        data, ts = _CACHE[key]
        if time.time() - ts < ttl:
            return data
        del _CACHE[key]   # TTL 過期直接刪除，立即釋放記憶體
    return None

def _cache_set(key: str, data):
    # 先淘汰所有 TTL > 600s 的過期項目
    now = time.time()
    expired = [k for k, (_, ts) in _CACHE.items() if now - ts > 600]
    for k in expired:
        del _CACHE[k]
    # 再依 LRU 淘汰最舊項目
    if len(_CACHE) >= _CACHE_MAX:
        oldest = min(_CACHE, key=lambda k: _CACHE[k][1])
        del _CACHE[oldest]
    _CACHE[key] = (data, now)


# ── 資料 API ─────────────────────────────────────────────────

class OHLCVRequest(BaseModel):
    market: str
    symbol: str
    start: str = ""
    end: str = ""
    limit: int = 0
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


def _enrich(df):
    """統一計算所有預設指標"""
    default_indicators = {
        "bb":   {"period": 20, "std": 2.0},
        "kdj":  {"k_period": 9, "d_period": 3},
        "rsi":  {"period": 14},
        "macd": {"fast": 12, "slow": 26, "signal": 9},
    }
    df = add_indicators(df, default_indicators)
    df["rsi_7"] = calc_rsi(df["close"], 7)
    df["crt"]   = crt_markers(df["high"], df["low"], df["open"], df["close"])
    return df


def _df_to_records(df):
    records = df.to_dict(orient="records")
    for r in records:
        r["time"] = r["time"].isoformat()
        for key in list(r.keys()):
            if isinstance(r[key], float) and math.isnan(r[key]):
                r[key] = None
    return records


@app.post("/api/ohlcv")
def get_ohlcv(req: OHLCVRequest):
    from datetime import date, timedelta
    use_limit = req.limit > 0

    cache_key = f"ohlcv:{req.market}:{req.symbol}:{req.timeframe}:{req.exchange}:{req.start}:{req.end}:{req.limit}"
    ttl = 30 if use_limit else 300
    cached = _cache_get(cache_key, ttl)
    if cached:
        return cached

    try:
        if req.market == "tw":
            if use_limit:
                end   = date.today().isoformat()
                start = (date.today() - timedelta(days=req.limit * 2)).isoformat()
            else:
                start, end = req.start, req.end
            df = fetch_tw_stock(req.symbol, start, end, req.finmind_token)
            df = resample_tw(df, req.timeframe)
            if use_limit:
                df = df.tail(req.limit)
        elif req.market == "crypto":
            if use_limit:
                df = fetch_crypto_ohlcv(
                    req.symbol, req.timeframe, limit=req.limit,
                    exchange_id=req.exchange, api_key=req.api_key, api_secret=req.api_secret,
                )
            else:
                df = fetch_crypto_ohlcv(
                    req.symbol, req.timeframe, req.start, req.end,
                    req.exchange, api_key=req.api_key, api_secret=req.api_secret,
                )
        else:
            raise HTTPException(400, f"不支援的市場: {req.market}")
    except Exception as e:
        raise HTTPException(400, str(e))

    df = _enrich(df)
    result = {"data": _df_to_records(df)}
    del df          # 立即釋放 DataFrame 記憶體
    gc.collect()
    _cache_set(cache_key, result)
    return result


# ── 即時最新 K 棒 ─────────────────────────────────────────────

class LatestRequest(BaseModel):
    market: str
    symbol: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@app.post("/api/latest")
def get_latest(req: LatestRequest):
    try:
        if req.market == "tw":
            from datetime import date, timedelta
            end   = date.today().isoformat()
            start = (date.today() - timedelta(days=30)).isoformat()
            df = fetch_tw_stock(req.symbol, start, end, req.finmind_token)
            df = resample_tw(df, req.timeframe)
        else:
            df = fetch_crypto_ohlcv(
                req.symbol, req.timeframe, limit=3,
                exchange_id=req.exchange,
                api_key=req.api_key, api_secret=req.api_secret,
            )
    except Exception as e:
        raise HTTPException(400, str(e))

    if df.empty:
        raise HTTPException(400, "無資料")

    records = df.tail(2).to_dict(orient="records")
    for r in records:
        r["time"] = r["time"].isoformat()
        for key in list(r.keys()):
            if isinstance(r[key], float) and math.isnan(r[key]):
                r[key] = None
    return {"data": records}


@app.get("/api/tickers")
def get_tickers(market: str = "futures"):
    cache_key = f"tickers:{market}"
    cached = _cache_get(cache_key, ttl=2)    # 2 秒快取，近即時
    if cached:
        return cached
    tickers = fetch_tickers(market)
    # source 欄位：第一筆 ticker 有 spot 欄位 → fapi 成功；否則是 spot fallback
    source = "fapi" if (tickers and "spot" in tickers[0] and market == "futures") else "spot"
    result = {"tickers": tickers, "source": source}
    _cache_set(cache_key, result)
    return result


@app.get("/api/search")
def search(market: str, keyword: str, token: str = ""):
    if market == "tw":
        return {"results": search_tw_stock(keyword, token)}
    elif market == "crypto":
        exchange = keyword if keyword in ["pionex", "binance", "bybit", "okx"] else "pionex"
        markets  = fetch_crypto_markets(exchange)
        return {"results": markets[:50]}
    return {"results": []}


@app.get("/api/pionex/symbols")
def get_pionex_symbols():
    """診斷用：回傳目前快取的 Pionex 標的清單"""
    syms = _fetch_pionex_symbols()
    return {"count": len(syms), "symbols": sorted(syms), "source": "pionex_api" if syms else "fallback"}


# ── 策略 API ─────────────────────────────────────────────────

@app.get("/api/strategies")
def list_strategies():
    return {
        k: {"name": v["name"], "params": v["params"]}
        for k, v in BUILTIN_STRATEGIES.items()
    }


# ── 回測 API ─────────────────────────────────────────────────

class BacktestRequest(BaseModel):
    market: str
    symbol: str
    start: str
    end: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    strategy_id: str
    strategy_params: dict = {}
    initial_capital: float = 100_000
    commission: float = 0.001
    slippage: float = 0.0005
    size_pct: float = 0.1
    allow_short: bool = False
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@app.post("/api/backtest")
def run_backtest(req: BacktestRequest):
    try:
        if req.market == "tw":
            df = fetch_tw_stock(req.symbol, req.start, req.end, req.finmind_token)
            df = resample_tw(df, req.timeframe)
        else:
            df = fetch_crypto_ohlcv(
                req.symbol, req.timeframe, req.start, req.end,
                req.exchange, api_key=req.api_key, api_secret=req.api_secret,
            )
    except Exception as e:
        raise HTTPException(400, f"資料抓取失敗: {e}")

    if len(df) < 10:
        raise HTTPException(400, "資料不足，請擴大日期範圍")

    strategy_def = BUILTIN_STRATEGIES.get(req.strategy_id)
    if not strategy_def:
        raise HTTPException(400, f"找不到策略: {req.strategy_id}")

    signal_fn, required_indicators = strategy_def["fn"](**req.strategy_params)
    df = add_indicators(df, required_indicators)
    df = _enrich(df)

    config = BacktestConfig(
        initial_capital=req.initial_capital,
        commission=req.commission,
        slippage=req.slippage,
        size_pct=req.size_pct,
        allow_short=req.allow_short,
    )
    engine = BacktestEngine(df, config)
    result = engine.run(signal_fn)

    ohlcv = df[["time", "open", "high", "low", "close", "volume"]].copy()
    ohlcv["time"] = ohlcv["time"].dt.strftime("%Y-%m-%dT%H:%M:%S")

    indicator_cols = [c for c in df.columns if c not in ["time", "open", "high", "low", "close", "volume"]]
    indicators_data = {}
    for col in indicator_cols:
        indicators_data[col] = df[col].where(df[col].notna(), other=None).tolist()

    response = {
        "stats":        result.stats(),
        "trades":       result.trades_to_list(),
        "equity_curve": result.equity_to_list(),
        "ohlcv":        ohlcv.to_dict(orient="records"),
        "indicators":   indicators_data,
    }
    del df, ohlcv, result
    gc.collect()
    return response
