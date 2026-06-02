"""回測 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw
from data.crypto import fetch_crypto_ohlcv
from indicators.engine import add_indicators
from backtest.engine import BacktestEngine, BacktestConfig
from strategies.builtin import BUILTIN_STRATEGIES
from utils.data import enrich_df, df_to_records

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

    if df.empty or len(df) < 10:
        raise HTTPException(400, "資料不足，請確認標的與日期範圍")

    strategy_def = BUILTIN_STRATEGIES.get(req.strategy_id)
    if not strategy_def:
        raise HTTPException(400, f"找不到策略: {req.strategy_id}")

    try:
        signal_fn, required_indicators = strategy_def["fn"](**req.strategy_params)
    except Exception as e:
        raise HTTPException(400, f"策略參數錯誤: {e}")

    try:
        df = add_indicators(df, required_indicators)
        df = enrich_df(df)
    except Exception as e:
        raise HTTPException(400, f"指標計算失敗: {e}")

    config = BacktestConfig(
        initial_capital=req.initial_capital,
        commission=req.commission,
        slippage=req.slippage,
        size_pct=req.size_pct,
        allow_short=req.allow_short,
        timeframe=req.timeframe,
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
    return response


# ══════════════════════════════════════════════════════════════
#  CRT 訊號回測（S1~S12）— 重用勝率引擎已算好的 signals，做資金曲線/績效
# ══════════════════════════════════════════════════════════════
class CrtBacktestRequest(BaseModel):
    market: str
    symbol: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    signal: str = "all"        # abc / ab / s3~s12 / all(=S2~S11 合計，去重、不含 S1/S12)
    direction: str = "both"    # short / long / both
    target: str = "mid"        # mid / band（rr 倍數以 mid 預估值為準，band 為近似）
    stop_buffer_pct: float = 0.0
    initial_capital: float = 100_000
    risk_pct: float = 0.02     # 每筆交易風險佔資金比例（輸/止損 = -1R）
    finmind_token: str = ""


# UI 的 signal key（s3..）↔ signal record 的 k（"3"..）；abc/ab 同名
_CRT_AGG = {"ab", "3", "4", "5", "6", "7", "8", "9", "10", "11"}   # 總勝率合計範圍（S2~S11）


@router.post("/crt_backtest")
def run_crt_backtest(req: CrtBacktestRequest):
    """用 CRT 訊號(S1~S12) 的勝負序列 + 每筆預估盈虧比(rr) 模擬資金曲線。
    重用 /api/crt_winrate 的計算（已深歷史 + 1hr 快取），不另抓資料。"""
    from routes.data import get_crt_winrate
    try:
        wr = get_crt_winrate(
            market=req.market, symbol=req.symbol, timeframe=req.timeframe,
            exchange=req.exchange, stop_buffer_pct=req.stop_buffer_pct,
            finmind_token=req.finmind_token,
        )
    except Exception as e:
        raise HTTPException(400, f"勝率計算失敗: {e}")

    sigs = (wr or {}).get("signals") or []
    rkey  = "r_b"  if req.target == "band" else "r"
    otkey = "ot_b" if req.target == "band" else "ot"

    want = req.signal
    if want.startswith("s") and want[1:].isdigit():
        want = want[1:]          # s3 → 3

    def _match(s):
        k = s.get("k")
        if req.signal == "all":
            if k not in _CRT_AGG:
                return False
        elif k != want:
            return False
        d = s.get("d")
        if req.direction == "short" and d != "s":
            return False
        if req.direction == "long" and d != "l":
            return False
        return s.get(rkey) in ("w", "l")   # 只取已結算

    picked = [s for s in sigs if _match(s)]
    picked.sort(key=lambda s: s.get(otkey) or s.get("t") or "")

    # all：同一根 K(同 t,d) 可能多訊號重疊 → 去重，與總勝率口徑一致
    if req.signal == "all":
        seen = set(); dedup = []
        for s in picked:
            key = (s.get("t"), s.get("d"))
            if key in seen:
                continue
            seen.add(key); dedup.append(s)
        picked = dedup

    cap = float(req.initial_capital)
    risk_pct = max(0.001, min(1.0, float(req.risk_pct or 0.02)))
    trades, equity = [], []
    if picked:
        equity.append({"time": picked[0].get("t"), "equity": round(cap, 2)})
    wins = losses = 0
    gross_win = gross_loss = 0.0
    r_sum = 0.0
    peak = cap
    max_dd = 0.0
    for s in picked:
        win = s.get(rkey) == "w"
        rr = float(s.get("rr") or 1.0)
        trade_r = rr if win else -1.0
        pnl = cap * risk_pct * trade_r
        cap += pnl
        if win:
            wins += 1; gross_win += pnl
        else:
            losses += 1; gross_loss += abs(pnl)
        r_sum += trade_r
        peak = max(peak, cap)
        if peak > 0:
            max_dd = min(max_dd, (cap - peak) / peak)
        trades.append({
            "time": s.get("t"), "exit": s.get(otkey),
            "dir": s.get("d"), "sig": s.get("k"),
            "result": "win" if win else "loss",
            "rr": round(rr, 2), "pnl": round(pnl, 2), "equity": round(cap, 2),
        })
        equity.append({"time": s.get(otkey) or s.get("t"), "equity": round(cap, 2)})

    total = wins + losses
    stats = {
        "total_trades": total,
        "wins": wins, "losses": losses,
        "win_rate":     round(wins / total * 100, 1) if total else 0,
        "total_return": round((cap - req.initial_capital) / req.initial_capital * 100, 2),
        "final_equity": round(cap, 2),
        "max_drawdown": round(abs(max_dd) * 100, 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (999.0 if gross_win > 0 else 0),
        "avg_r":  round(r_sum / total, 3) if total else 0,
        "net_r":  round(r_sum, 2),
        "from_date": (wr or {}).get("from_date"),
    }
    return {"stats": stats, "trades": trades, "equity_curve": equity}
