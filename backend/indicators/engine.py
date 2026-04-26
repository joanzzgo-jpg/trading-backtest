"""
技術指標引擎 - 純 pandas/numpy 實作，不依賴額外函式庫
"""
import pandas as pd
import numpy as np


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    """返回 (macd_line, signal_line, histogram)"""
    fast_ema = ema(series, fast)
    slow_ema = ema(series, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def bollinger_bands(series: pd.Series, period: int = 20, std_dev: float = 2.0):
    """返回 (upper, middle, lower)"""
    middle = sma(series, period)
    std = series.rolling(period).std()
    upper = middle + std_dev * std
    lower = middle - std_dev * std
    return upper, middle, lower


def stochastic(high: pd.Series, low: pd.Series, close: pd.Series, k_period: int = 14, d_period: int = 3):
    """返回 (%K, %D)"""
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    k = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, np.nan)
    d = sma(k, d_period)
    return k, d


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, adjust=False).mean()


def crt_markers(high: pd.Series, low: pd.Series, open_: pd.Series, close: pd.Series) -> pd.Series:
    """
    CRT (Candle Range Theory) 標記偵測
    紅K（漲）→ 下一根綠K（跌）且最高點 > 紅K最高點 → 看空 (-1)
    綠K（跌）→ 下一根紅K（漲）且最低點 < 綠K最低點 → 看多 (1)
    """
    n = len(close)
    signals = pd.Series(0, index=close.index, dtype=int)

    for i in range(n - 1):
        cur_bull  = close.iloc[i] > open_.iloc[i]   # 漲（紅K）
        cur_bear  = close.iloc[i] < open_.iloc[i]   # 跌（綠K）
        next_bull = close.iloc[i+1] > open_.iloc[i+1]
        next_bear = close.iloc[i+1] < open_.iloc[i+1]

        if cur_bull and next_bear and high.iloc[i+1] > high.iloc[i]:
            signals.iloc[i+1] = -1   # 看空：紅K後綠K掃上影

        elif cur_bear and next_bull and low.iloc[i+1] < low.iloc[i]:
            signals.iloc[i+1] = 1    # 看多：綠K後紅K掃下影

    return signals


def kdj(high: pd.Series, low: pd.Series, close: pd.Series, k_period: int = 9, d_period: int = 3):
    """返回 (K, D, J)"""
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    rsv = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, np.nan)
    k = rsv.ewm(com=d_period - 1, adjust=False).mean()
    d = k.ewm(com=d_period - 1, adjust=False).mean()
    j = 3 * k - 2 * d
    return k, d, j


def vwap(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
    typical_price = (high + low + close) / 3
    return (typical_price * volume).cumsum() / volume.cumsum()


def add_indicators(df: pd.DataFrame, config: dict) -> pd.DataFrame:
    """
    根據設定批次計算指標並附加到 DataFrame
    config 範例:
    {
        "ma": [{"type": "sma", "period": 20}, {"type": "ema", "period": 50}],
        "rsi": {"period": 14},
        "macd": {"fast": 12, "slow": 26, "signal": 9},
        "bb": {"period": 20, "std": 2.0},
        "stoch": {"k": 14, "d": 3},
        "atr": {"period": 14},
        "vwap": true
    }
    """
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df.get("volume", pd.Series(dtype=float))

    if "ma" in config:
        for ma_cfg in config["ma"]:
            period = ma_cfg["period"]
            ma_type = ma_cfg.get("type", "sma")
            col = f"{ma_type}_{period}"
            df[col] = ema(close, period) if ma_type == "ema" else sma(close, period)

    if "rsi" in config:
        period = config["rsi"].get("period", 14)
        df[f"rsi_{period}"] = rsi(close, period)

    if "macd" in config:
        cfg = config["macd"]
        fast, slow, sig = cfg.get("fast", 12), cfg.get("slow", 26), cfg.get("signal", 9)
        df["macd"], df["macd_signal"], df["macd_hist"] = macd(close, fast, slow, sig)

    if "bb" in config:
        cfg = config["bb"]
        period, std = cfg.get("period", 20), cfg.get("std", 2.0)
        df["bb_upper"], df["bb_middle"], df["bb_lower"] = bollinger_bands(close, period, std)

    if "stoch" in config:
        cfg = config["stoch"]
        k, d = stochastic(high, low, close, cfg.get("k", 14), cfg.get("d", 3))
        df["stoch_k"], df["stoch_d"] = k, d

    if "kdj" in config:
        cfg = config["kdj"]
        k_val, d_val, j_val = kdj(high, low, close, cfg.get("k_period", 9), cfg.get("d_period", 3))
        df["kdj_k"], df["kdj_d"], df["kdj_j"] = k_val, d_val, j_val

    if "atr" in config:
        period = config["atr"].get("period", 14)
        df[f"atr_{period}"] = atr(high, low, close, period)

    if config.get("vwap") and not volume.empty:
        df["vwap"] = vwap(high, low, close, volume)

    return df
