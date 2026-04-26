"""
FastAPI 後端主程式
"""
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import os, sys

sys.path.insert(0, os.path.dirname(__file__))

from data.taiwan import fetch_tw_stock, resample_tw, search_tw_stock
from data.crypto import fetch_crypto_ohlcv, fetch_crypto_markets
from indicators.engine import add_indicators, crt_markers
from backtest.engine import BacktestEngine, BacktestConfig
from strategies.builtin import BUILTIN_STRATEGIES

app = FastAPI(title="回測系統")

# 靜態檔案
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=os.path.join(FRONTEND_DIR, "static")), name="static")


@app.get("/")
def index():
    return FileResponse(
        os.path.join(FRONTEND_DIR, "templates", "index.html"),
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


# ── 資料 API ─────────────────────────────────────────────────

class OHLCVRequest(BaseModel):
    market: str
    symbol: str
    start: str = ""
    end: str = ""
    limit: int = 0        # >0 表示取最新 N 根，忽略 start/end
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@app.post("/api/ohlcv")
def get_ohlcv(req: OHLCVRequest):
    from datetime import date, timedelta
    use_limit = req.limit > 0

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

    # 固定計算指標：BB + KDJ + RSI14 + RSI7 + CRT
    from indicators.engine import rsi as calc_rsi
    import math
    default_indicators = {
        "bb": {"period": 20, "std": 2.0},
        "kdj": {"k_period": 9, "d_period": 3},
        "rsi": {"period": 14},
    }
    df = add_indicators(df, default_indicators)
    df["rsi_7"]  = calc_rsi(df["close"], 7)
    df["crt"]    = crt_markers(df["high"], df["low"], df["open"], df["close"])

    records = df.to_dict(orient="records")
    for r in records:
        r["time"] = r["time"].isoformat()
        for key in list(r.keys()):
            if isinstance(r[key], float) and math.isnan(r[key]):
                r[key] = None
    return {"data": records}


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
    """回傳最新 2 根 K 棒（用於即時更新）"""
    import math
    try:
        if req.market == "tw":
            from datetime import date, timedelta
            end = date.today().isoformat()
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


@app.get("/api/search")
def search(market: str, keyword: str, token: str = ""):
    if market == "tw":
        return {"results": search_tw_stock(keyword, token)}
    elif market == "crypto":
        exchange = keyword if keyword in ["pionex", "binance", "bybit", "okx"] else "pionex"
        markets = fetch_crypto_markets(exchange)
        return {"results": markets[:50]}
    return {"results": []}


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
    # 1. 抓資料
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

    # 2. 取得策略
    strategy_def = BUILTIN_STRATEGIES.get(req.strategy_id)
    if not strategy_def:
        raise HTTPException(400, f"找不到策略: {req.strategy_id}")

    signal_fn, required_indicators = strategy_def["fn"](**req.strategy_params)

    # 3. 計算指標
    df = add_indicators(df, required_indicators)

    # 4. 回測
    config = BacktestConfig(
        initial_capital=req.initial_capital,
        commission=req.commission,
        slippage=req.slippage,
        size_pct=req.size_pct,
        allow_short=req.allow_short,
    )
    engine = BacktestEngine(df, config)
    result = engine.run(signal_fn)

    # 5. 回傳結果
    ohlcv = df[["time", "open", "high", "low", "close", "volume"]].copy()
    ohlcv["time"] = ohlcv["time"].dt.strftime("%Y-%m-%dT%H:%M:%S")

    # 指標欄位
    indicator_cols = [c for c in df.columns if c not in ["time", "open", "high", "low", "close", "volume"]]
    indicators_data = {}
    for col in indicator_cols:
        indicators_data[col] = df[col].where(df[col].notna(), other=None).tolist()

    return {
        "stats": result.stats(),
        "trades": result.trades_to_list(),
        "equity_curve": result.equity_to_list(),
        "ohlcv": ohlcv.to_dict(orient="records"),
        "indicators": indicators_data,
    }
