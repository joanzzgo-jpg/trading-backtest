"""
回測引擎 - 模擬交易、計算績效
"""
import pandas as pd
import numpy as np
from dataclasses import dataclass, field
from typing import Literal


@dataclass
class Trade:
    entry_time: pd.Timestamp
    entry_price: float
    side: Literal["long", "short"]
    size: float          # 單位：股數或幣數
    exit_time: pd.Timestamp = None
    exit_price: float = None
    pnl: float = None
    pnl_pct: float = None
    exit_reason: str = ""


_CANDLES_PER_YEAR = {
    "1M": 12,
    "1w": 52,
    "1d": 252,
    "4h": 252 * 6,
    "1h": 252 * 24,
    "15m": 252 * 96,
    "5m": 252 * 288,
}


@dataclass
class BacktestConfig:
    initial_capital: float = 100_000.0
    commission: float = 0.001       # 0.1% 手續費
    slippage: float = 0.0005        # 0.05% 滑點
    size_pct: float = 0.1           # 每次用 10% 資金
    allow_short: bool = False       # 是否允許做空
    max_positions: int = 1          # 最大同時持倉數
    timeframe: str = "1d"


class BacktestEngine:
    def __init__(self, df: pd.DataFrame, config: BacktestConfig = None):
        self.df = df.reset_index(drop=True)
        self.config = config or BacktestConfig()
        self.trades: list[Trade] = []
        self.equity_curve: list[dict] = []
        self._open_trades: list[Trade] = []
        self._capital = self.config.initial_capital

    # ── 策略呼叫入口 ─────────────────────────────────────────
    def run(self, signal_fn) -> "BacktestResult":
        """
        signal_fn(df) -> np.ndarray[int8]，每根 K 棒：1=buy -1=sell 2=short -2=cover 0=無。
        向量化（一次算完整個訊號陣列）+ numpy 迴圈跑部位狀態機 → 長歷史也快、不卡。
        """
        sigs   = np.asarray(signal_fn(self.df), dtype=np.int8)
        times  = self.df["time"].tolist()   # pd.Timestamp 串列（有 .isoformat()，給 trades/equity 序列化）
        closes = self.df["close"].to_numpy(dtype=float)
        n = len(closes)
        if sigs.shape[0] != n:   # 防呆：長度不符 → 補零
            tmp = np.zeros(n, dtype=np.int8); tmp[:min(n, sigs.shape[0])] = sigs[:n]; sigs = tmp

        eq = self.equity_curve
        ot = self._open_trades
        max_pos = self.config.max_positions
        allow_short = self.config.allow_short
        for i in range(n):
            s = int(sigs[i])
            price = closes[i]
            if   s == 1 and len(ot) < max_pos: self._open_long(times[i], price)
            elif s == -1:                      self._close_all(times[i], price, "sell signal")
            elif s == 2 and allow_short:       self._open_short(times[i], price)
            elif s == -2:                      self._close_all(times[i], price, "cover signal")

            if ot:
                unrealized = 0.0
                for t in ot:
                    unrealized += (price - t.entry_price) * t.size if t.side == "long" else (t.entry_price - price) * t.size
            else:
                unrealized = 0.0
            eq.append({"time": times[i], "equity": self._capital + unrealized})

        # 強制平倉
        if ot:
            self._close_all(times[-1], closes[-1], "end of data")

        return BacktestResult(self.trades, self.equity_curve, self.config.initial_capital, self.config.timeframe)

    # ── 內部操作 ─────────────────────────────────────────────
    def _open_long(self, time, price):
        entry_price = price * (1 + self.config.slippage)
        size = (self._capital * self.config.size_pct) / entry_price
        cost = entry_price * size * (1 + self.config.commission)
        if cost > self._capital:
            return
        self._capital -= cost
        self._open_trades.append(Trade(
            entry_time=time,
            entry_price=entry_price,
            side="long",
            size=size,
        ))

    def _open_short(self, time, price):
        entry_price = price * (1 - self.config.slippage)
        size = (self._capital * self.config.size_pct) / entry_price
        self._open_trades.append(Trade(
            entry_time=time,
            entry_price=entry_price,
            side="short",
            size=size,
        ))

    def _close_all(self, time, price, reason: str):
        for trade in list(self._open_trades):
            exit_price = price
            entry_fee = trade.entry_price * trade.size * self.config.commission
            if trade.side == "long":
                exit_price *= (1 - self.config.slippage)
                gross = (exit_price - trade.entry_price) * trade.size
                fee = exit_price * trade.size * self.config.commission
                pnl = gross - fee - entry_fee
                pnl_pct = pnl / (trade.entry_price * trade.size)
            else:
                exit_price *= (1 + self.config.slippage)
                gross = (trade.entry_price - exit_price) * trade.size
                fee = exit_price * trade.size * self.config.commission
                pnl = gross - fee - entry_fee
                pnl_pct = pnl / (trade.entry_price * trade.size)

            self._capital += exit_price * trade.size - fee
            trade.exit_time = time
            trade.exit_price = exit_price
            trade.pnl = pnl
            trade.pnl_pct = pnl_pct
            trade.exit_reason = reason
            self.trades.append(trade)

        self._open_trades.clear()


class BacktestResult:
    def __init__(self, trades: list[Trade], equity_curve: list[dict], initial_capital: float, timeframe: str = "1d"):
        self.trades = trades
        self.equity_curve = equity_curve
        self.initial_capital = initial_capital
        self.timeframe = timeframe

    def stats(self) -> dict:
        if not self.trades:
            return {"error": "無交易紀錄"}

        pnls = [t.pnl for t in self.trades]
        pnl_pcts = [t.pnl_pct for t in self.trades]
        winners = [p for p in pnls if p > 0]
        losers = [p for p in pnls if p <= 0]

        equity = pd.Series([e["equity"] for e in self.equity_curve])
        peak = equity.cummax()
        drawdown = (equity - peak) / peak
        max_drawdown = drawdown.min()

        final_equity = equity.iloc[-1]
        total_return = (final_equity - self.initial_capital) / self.initial_capital

        eq_df = pd.DataFrame(self.equity_curve).set_index("time")
        per_bar_returns = eq_df["equity"].pct_change().dropna()
        annual_factor = _CANDLES_PER_YEAR.get(self.timeframe, 252)
        sharpe = (per_bar_returns.mean() / per_bar_returns.std() * np.sqrt(annual_factor)) if per_bar_returns.std() > 0 else 0

        total_loss = sum(losers)
        profit_factor = abs(sum(winners) / total_loss) if total_loss != 0 else float("inf")

        return {
            "total_trades": len(self.trades),
            "win_rate": len(winners) / len(self.trades) if self.trades else 0,
            "profit_factor": round(profit_factor, 2),
            "total_return": round(total_return * 100, 2),
            "final_equity": round(final_equity, 2),
            "max_drawdown": round(abs(max_drawdown) * 100, 2),
            "sharpe_ratio": round(sharpe, 2),
            "avg_win": round(np.mean(winners), 2) if winners else 0,
            "avg_loss": round(np.mean(losers), 2) if losers else 0,
            "avg_pnl_pct": round(np.mean(pnl_pcts) * 100, 2),
            "total_pnl": round(sum(pnls), 2),
        }

    def trades_to_list(self) -> list[dict]:
        return [
            {
                "entry_time": t.entry_time.isoformat(),
                "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                "side": t.side,
                "entry_price": round(t.entry_price, 4),
                "exit_price": round(t.exit_price, 4) if t.exit_price else None,
                "size": round(t.size, 6),
                "pnl": round(t.pnl, 2) if t.pnl is not None else None,
                "pnl_pct": round(t.pnl_pct * 100, 2) if t.pnl_pct is not None else None,
                "exit_reason": t.exit_reason,
            }
            for t in self.trades
        ]

    def equity_to_list(self) -> list[dict]:
        return [
            {"time": e["time"].isoformat(), "equity": round(e["equity"], 2)}
            for e in self.equity_curve
        ]
