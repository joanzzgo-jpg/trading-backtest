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


def crt_markers(high: pd.Series, low: pd.Series, open_: pd.Series, close: pd.Series) -> pd.Series:
    """
    CRT (Candle Range Theory) 標記偵測
    紅K（漲）→ 下一根綠K（跌）且最高點 > 紅K最高點 → 看空 (-1)
    綠K（跌）→ 下一根紅K（漲）且最低點 < 綠K最低點 → 看多 (1)
    """
    cur_bull = close > open_
    cur_bear = close < open_
    next_bull = cur_bull.shift(-1)
    next_bear = cur_bear.shift(-1)

    bearish = cur_bull & next_bear & (high.shift(-1) > high)
    bullish = cur_bear & next_bull & (low.shift(-1) < low)

    signals = pd.Series(0, index=close.index, dtype=int)
    signals[bearish.shift(1).fillna(False)] = -1
    signals[bullish.shift(1).fillna(False)] = 1
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


def kdj_first_cross(
    k: pd.Series, d: pd.Series,
    ob: int = 80, os_: int = 20,
    max_golden_k: int = 60, min_dead_k: int = 40,
) -> pd.Series:
    """KDJ 首次交叉狀態機（無脫離限制版）

    - 武裝：K 或 D 進入超賣(< os_)即武裝金叉；進入超買(> ob)即武裝死叉
    - 無脫離限制：不要求 K/D 先離開超買/超賣區
    - 金叉：K 上穿 D + 武裝中 + K <= max_golden_k
    - 死叉：K 下穿 D + 武裝中 + K >= min_dead_k
    Returns: +1=黃金交叉, -1=死亡交叉, 0=無
    """
    k_arr = k.to_numpy(dtype=float, na_value=np.nan)
    d_arr = d.to_numpy(dtype=float, na_value=np.nan)
    n     = len(k_arr)
    cross = np.zeros(n, dtype=np.int8)
    wait_golden = False
    wait_dead   = False

    for i in range(n):
        ki, di = k_arr[i], d_arr[i]
        if np.isnan(ki) or np.isnan(di):
            continue
        # 武裝判斷（進入超賣/超買即觸發，無需離開）
        if ki < os_ or di < os_:
            wait_golden = True
        if ki > ob or di > ob:
            wait_dead = True
        if i > 0:
            pk, pd_ = k_arr[i - 1], d_arr[i - 1]
            if not (np.isnan(pk) or np.isnan(pd_)):
                if pk < pd_ and ki >= di and wait_golden and ki <= max_golden_k:
                    cross[i] = 1
                    wait_golden = False
                elif pk > pd_ and ki <= di and wait_dead and ki >= min_dead_k:
                    cross[i] = -1
                    wait_dead = False

    return pd.Series(cross.astype(int), index=k.index)


def bb_kdj_rsi_resonance(
    high: pd.Series, low: pd.Series,
    bb_upper: pd.Series, bb_lower: pd.Series,
    k: pd.Series, d: pd.Series, rsi_val: pd.Series,
    kd_ob: int = 80, kd_os: int = 20,
    rsi_ob: int = 70, rsi_os: int = 30,
) -> pd.Series:
    """
    超買超賣共振: 布林帶觸軌 + KD 超買超賣 + RSI 超買超賣
    Returns: +1=超賣(看多), -1=超買(看空), 0=無訊號
    """
    touch_upper = high >= bb_upper * 0.997   # 0.3% 緩衝
    touch_lower = low  <= bb_lower * 1.003
    kd_ob_cond  = (k > kd_ob) | (d > kd_ob)
    kd_os_cond  = (k < kd_os) | (d < kd_os)
    rsi_ob_cond = rsi_val > rsi_ob
    rsi_os_cond = rsi_val < rsi_os

    signal = pd.Series(0, index=high.index, dtype=int)
    signal[touch_upper & kd_ob_cond & rsi_ob_cond] = -1
    signal[touch_lower & kd_os_cond & rsi_os_cond] =  1
    return signal


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
        # 1σ 內帶（同均線/週期，只差 1 個標準差）— 與 2σ 並存，前端疊畫
        _bb_sd1 = close.rolling(period).std()
        df["bb_upper_1"] = df["bb_middle"] + _bb_sd1
        df["bb_lower_1"] = df["bb_middle"] - _bb_sd1

    if "stoch" in config:
        cfg = config["stoch"]
        k, d = stochastic(high, low, close, cfg.get("k", 14), cfg.get("d", 3))
        df["stoch_k"], df["stoch_d"] = k, d

    if "kdj" in config:
        cfg = config["kdj"]
        k_val, d_val, j_val = kdj(high, low, close, cfg.get("k_period", 9), cfg.get("d_period", 3))
        df["kdj_k"], df["kdj_d"], df["kdj_j"] = k_val, d_val, j_val

    if config.get("vwap") and not volume.empty:
        df["vwap"] = vwap(high, low, close, volume)

    return df
