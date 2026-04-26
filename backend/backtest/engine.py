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


@dataclass
class BacktestConfig:
    initial_capital: float = 100_000.0
    commission: float = 0.001       # 0.1% 手續費
    slippage: float = 0.0005        # 0.05% 滑點
    size_pct: float = 0.1           # 每次用 10% 資金
    allow_short: bool = False       # 是否允許做空
    max_positions: int = 1          # 最大同時持倉數


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
        signal_fn(row, df, idx) -> "buy" | "sell" | "short" | "cover" | None
        """
        for i, row in self.df.iterrows():
            price = row["close"]
            signal = signal_fn(row, self.df, i)

            if signal == "buy" and len(self._open_trades) < self.config.max_positions:
                self._open_long(row)
            elif signal == "sell":
                self._close_all(row, "sell signal")
            elif signal == "short" and self.config.allow_short:
                self._open_short(row)
            elif signal == "cover":
                self._close_all(row, "cover signal")

            # 記錄資金曲線
            unrealized = sum(
                (price - t.entry_price) * t.size if t.side == "long"
                else (t.entry_price - price) * t.size
                for t in self._open_trades
            )
            self.equity_curve.append({
                "time": row["time"],
                "equity": self._capital + unrealized,
            })

        # 強制平倉
        if self._open_trades:
            last_row = self.df.iloc[-1]
            self._close_all(last_row, "end of data")

        return BacktestResult(self.trades, self.equity_curve, self.config.initial_capital)

    # ── 內部操作 ─────────────────────────────────────────────
    def _open_long(self, row):
        entry_price = row["close"] * (1 + self.config.slippage)
        size = (self._capital * self.config.size_pct) / entry_price
        cost = entry_price * size * (1 + self.config.commission)
        if cost > self._capital:
            return
        self._capital -= cost
        self._open_trades.append(Trade(
            entry_time=row["time"],
            entry_price=entry_price,
            side="long",
            size=size,
        ))

    def _open_short(self, row):
        entry_price = row["close"] * (1 - self.config.slippage)
        size = (self._capital * self.config.size_pct) / entry_price
        self._open_trades.append(Trade(
            entry_time=row["time"],
            entry_price=entry_price,
            side="short",
            size=size,
        ))

    def _close_all(self, row, reason: str):
        for trade in list(self._open_trades):
            exit_price = row["close"]
            if trade.side == "long":
                exit_price *= (1 - self.config.slippage)
                gross = (exit_price - trade.entry_price) * trade.size
                fee = exit_price * trade.size * self.config.commission
                pnl = gross - fee
                pnl_pct = (exit_price - trade.entry_price) / trade.entry_price
            else:
                exit_price *= (1 + self.config.slippage)
                gross = (trade.entry_price - exit_price) * trade.size
                fee = exit_price * trade.size * self.config.commission
                pnl = gross - fee
                pnl_pct = (trade.entry_price - exit_price) / trade.entry_price

            self._capital += exit_price * trade.size + pnl - (exit_price * trade.size * self.config.commission)
            trade.exit_time = row["time"]
            trade.exit_price = exit_price
            trade.pnl = pnl
            trade.pnl_pct = pnl_pct
            trade.exit_reason = reason
            self.trades.append(trade)

        self._open_trades.clear()


class BacktestResult:
    def __init__(self, trades: list[Trade], equity_curve: list[dict], initial_capital: float):
        self.trades = trades
        self.equity_curve = equity_curve
        self.initial_capital = initial_capital

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

        # 夏普比率（簡化：日報酬）
        eq_df = pd.DataFrame(self.equity_curve).set_index("time")
        daily_returns = eq_df["equity"].pct_change().dropna()
        sharpe = (daily_returns.mean() / daily_returns.std() * np.sqrt(252)) if daily_returns.std() > 0 else 0

        profit_factor = abs(sum(winners) / sum(losers)) if losers else float("inf")

        return {
            "total_trades": len(self.trades),
            "win_rate": len(winners) / len(self.trades) if self.trades else 0,
            "profit_factor": round(profit_factor, 2),
            "total_return": round(total_return * 100, 2),
            "final_equity": round(final_equity, 2),
            "max_drawdown": round(max_drawdown * 100, 2),
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
