"""
內建策略 - 可直接使用或作為自訂策略範本
"""
import pandas as pd


def ma_crossover(fast_period: int = 10, slow_period: int = 30):
    """均線交叉策略：快線上穿慢線買進，下穿賣出"""
    fast_col = f"sma_{fast_period}"
    slow_col = f"sma_{slow_period}"

    def signal_fn(row, df, idx):
        if idx < 1:
            return None
        prev = df.iloc[idx - 1]
        # 快線上穿慢線
        if prev[fast_col] <= prev[slow_col] and row[fast_col] > row[slow_col]:
            return "buy"
        # 快線下穿慢線
        if prev[fast_col] >= prev[slow_col] and row[fast_col] < row[slow_col]:
            return "sell"
        return None

    required_indicators = {
        "ma": [
            {"type": "sma", "period": fast_period},
            {"type": "sma", "period": slow_period},
        ]
    }
    return signal_fn, required_indicators


def rsi_strategy(period: int = 14, oversold: float = 30, overbought: float = 70):
    """RSI 超買超賣策略"""
    col = f"rsi_{period}"

    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row[col]):
            return None
        prev = df.iloc[idx - 1]
        # 從超賣區回升 -> 買進
        if prev[col] < oversold and row[col] >= oversold:
            return "buy"
        # 從超買區回落 -> 賣出
        if prev[col] > overbought and row[col] <= overbought:
            return "sell"
        return None

    required_indicators = {"rsi": {"period": period}}
    return signal_fn, required_indicators


def macd_strategy():
    """MACD 交叉策略：MACD 線上穿信號線買進，下穿賣出"""

    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row["macd"]):
            return None
        prev = df.iloc[idx - 1]
        if prev["macd"] <= prev["macd_signal"] and row["macd"] > row["macd_signal"]:
            return "buy"
        if prev["macd"] >= prev["macd_signal"] and row["macd"] < row["macd_signal"]:
            return "sell"
        return None

    required_indicators = {"macd": {"fast": 12, "slow": 26, "signal": 9}}
    return signal_fn, required_indicators


def bb_strategy(period: int = 20, std: float = 2.0):
    """布林通道策略：價格跌破下軌買進，突破上軌賣出"""

    def signal_fn(row, df, idx):
        if pd.isna(row["bb_lower"]):
            return None
        if row["close"] < row["bb_lower"]:
            return "buy"
        if row["close"] > row["bb_upper"]:
            return "sell"
        return None

    required_indicators = {"bb": {"period": period, "std": std}}
    return signal_fn, required_indicators


BUILTIN_STRATEGIES = {
    "ma_crossover": {
        "name": "均線交叉",
        "fn": ma_crossover,
        "params": [
            {"key": "fast_period", "label": "快線週期", "type": "int", "default": 10, "min": 2, "max": 200},
            {"key": "slow_period", "label": "慢線週期", "type": "int", "default": 30, "min": 5, "max": 500},
        ],
    },
    "rsi": {
        "name": "RSI 超買超賣",
        "fn": rsi_strategy,
        "params": [
            {"key": "period", "label": "RSI 週期", "type": "int", "default": 14, "min": 2, "max": 100},
            {"key": "oversold", "label": "超賣閾值", "type": "float", "default": 30, "min": 1, "max": 49},
            {"key": "overbought", "label": "超買閾值", "type": "float", "default": 70, "min": 51, "max": 99},
        ],
    },
    "macd": {
        "name": "MACD 交叉",
        "fn": macd_strategy,
        "params": [],
    },
    "bb": {
        "name": "布林通道",
        "fn": bb_strategy,
        "params": [
            {"key": "period", "label": "週期", "type": "int", "default": 20, "min": 5, "max": 200},
            {"key": "std", "label": "標準差倍數", "type": "float", "default": 2.0, "min": 0.5, "max": 5.0},
        ],
    },
}
