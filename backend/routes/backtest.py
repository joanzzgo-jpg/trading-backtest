"""回測 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw
from data.crypto import fetch_crypto_ohlcv
from indicators.engine import add_indicators
from backtest.engine import BacktestEngine, BacktestConfig
from strategies.builtin import BUILTIN_STRATEGIES
from utils.data import enrich_df, df_to_records, safe_df_cleanup

router = APIRouter(prefix="/api", tags=["backtest"])


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


@router.post("/backtest")
def run_backtest(req: BacktestRequest):
    """執行回測"""
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
    df = enrich_df(df)

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
    safe_df_cleanup(df)
    return response
