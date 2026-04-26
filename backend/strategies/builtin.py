"""
內建策略
"""
import pandas as pd


# ── 均線交叉 ──────────────────────────────────────────────────
def ma_crossover(fast_period: int = 10, slow_period: int = 30):
    fast_col = f"sma_{fast_period}"
    slow_col = f"sma_{slow_period}"

    def signal_fn(row, df, idx):
        if idx < 1: return None
        prev = df.iloc[idx - 1]
        if prev[fast_col] <= prev[slow_col] and row[fast_col] > row[slow_col]: return "buy"
        if prev[fast_col] >= prev[slow_col] and row[fast_col] < row[slow_col]: return "sell"
        return None

    return signal_fn, {"ma": [{"type":"sma","period":fast_period}, {"type":"sma","period":slow_period}]}


# ── RSI 超買超賣 ───────────────────────────────────────────────
def rsi_strategy(period: int = 14, oversold: float = 30, overbought: float = 70):
    col = f"rsi_{period}"

    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row[col]): return None
        prev = df.iloc[idx - 1]
        if prev[col] < oversold  and row[col] >= oversold:  return "buy"
        if prev[col] > overbought and row[col] <= overbought: return "sell"
        return None

    return signal_fn, {"rsi": {"period": period}}


# ── MACD 交叉 ─────────────────────────────────────────────────
def macd_strategy(fast: int = 12, slow: int = 26, signal: int = 9):
    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row["macd"]): return None
        prev = df.iloc[idx - 1]
        if prev["macd"] <= prev["macd_signal"] and row["macd"] > row["macd_signal"]: return "buy"
        if prev["macd"] >= prev["macd_signal"] and row["macd"] < row["macd_signal"]: return "sell"
        return None

    return signal_fn, {"macd": {"fast": fast, "slow": slow, "signal": signal}}


# ── 布林通道 ──────────────────────────────────────────────────
def bb_strategy(period: int = 20, std: float = 2.0):
    def signal_fn(row, df, idx):
        if pd.isna(row.get("bb_lower")): return None
        if row["close"] < row["bb_lower"]: return "buy"
        if row["close"] > row["bb_upper"]: return "sell"
        return None

    return signal_fn, {"bb": {"period": period, "std": std}}


# ── KDJ 交叉 ──────────────────────────────────────────────────
def kdj_strategy(k_period: int = 9, d_period: int = 3,
                 oversold: float = 20, overbought: float = 80):
    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row.get("kdj_k")): return None
        prev = df.iloc[idx - 1]
        # K 上穿 D 且在超賣區附近
        if (prev["kdj_k"] <= prev["kdj_d"] and row["kdj_k"] > row["kdj_d"]
                and row["kdj_k"] < oversold + 20):
            return "buy"
        # K 下穿 D 且在超買區附近
        if (prev["kdj_k"] >= prev["kdj_d"] and row["kdj_k"] < row["kdj_d"]
                and row["kdj_k"] > overbought - 20):
            return "sell"
        return None

    return signal_fn, {"kdj": {"k_period": k_period, "d_period": d_period}}


# ── RSI + 均線複合 ────────────────────────────────────────────
def rsi_ma_strategy(rsi_period: int = 14, ma_period: int = 20,
                    oversold: float = 35, overbought: float = 65):
    rsi_col = f"rsi_{rsi_period}"
    ma_col  = f"sma_{ma_period}"

    def signal_fn(row, df, idx):
        if idx < 1 or pd.isna(row.get(rsi_col)) or pd.isna(row.get(ma_col)):
            return None
        prev = df.iloc[idx - 1]
        # RSI 從超賣回升 + 價格站上均線
        if (prev[rsi_col] < oversold and row[rsi_col] >= oversold
                and row["close"] > row[ma_col]):
            return "buy"
        # RSI 從超買回落 + 價格跌破均線
        if (prev[rsi_col] > overbought and row[rsi_col] <= overbought
                and row["close"] < row[ma_col]):
            return "sell"
        return None

    return signal_fn, {
        "rsi": {"period": rsi_period},
        "ma":  [{"type": "sma", "period": ma_period}],
    }


# ── 布林 + RSI 雙重確認 ───────────────────────────────────────
def bb_rsi_strategy(bb_period: int = 20, std: float = 2.0,
                    rsi_period: int = 14, rsi_low: float = 35, rsi_high: float = 65):
    rsi_col = f"rsi_{rsi_period}"

    def signal_fn(row, df, idx):
        if pd.isna(row.get("bb_lower")) or pd.isna(row.get(rsi_col)):
            return None
        if row["close"] < row["bb_lower"] and row[rsi_col] < rsi_low:
            return "buy"
        if row["close"] > row["bb_upper"] and row[rsi_col] > rsi_high:
            return "sell"
        return None

    return signal_fn, {
        "bb":  {"period": bb_period, "std": std},
        "rsi": {"period": rsi_period},
    }


# ── 策略列表 ──────────────────────────────────────────────────
BUILTIN_STRATEGIES = {
    "ma_crossover": {
        "name": "均線交叉",
        "fn":   ma_crossover,
        "params": [
            {"key":"fast_period","label":"快線週期","type":"int","default":10,"min":2,"max":200},
            {"key":"slow_period","label":"慢線週期","type":"int","default":30,"min":5,"max":500},
        ],
    },
    "rsi": {
        "name": "RSI 超買超賣",
        "fn":   rsi_strategy,
        "params": [
            {"key":"period",    "label":"RSI 週期","type":"int",  "default":14,"min":2,"max":100},
            {"key":"oversold",  "label":"超賣閾值", "type":"float","default":30,"min":1,"max":49},
            {"key":"overbought","label":"超買閾值", "type":"float","default":70,"min":51,"max":99},
        ],
    },
    "macd": {
        "name": "MACD 交叉",
        "fn":   macd_strategy,
        "params": [
            {"key":"fast",  "label":"快線","type":"int","default":12,"min":2,"max":50},
            {"key":"slow",  "label":"慢線","type":"int","default":26,"min":5,"max":200},
            {"key":"signal","label":"信號","type":"int","default":9, "min":2,"max":50},
        ],
    },
    "bb": {
        "name": "布林通道",
        "fn":   bb_strategy,
        "params": [
            {"key":"period","label":"週期",      "type":"int",  "default":20, "min":5,"max":200},
            {"key":"std",   "label":"標準差倍數","type":"float","default":2.0,"min":0.5,"max":5.0},
        ],
    },
    "kdj": {
        "name": "KDJ 交叉",
        "fn":   kdj_strategy,
        "params": [
            {"key":"k_period",   "label":"K 週期","type":"int",  "default":9, "min":2,"max":50},
            {"key":"d_period",   "label":"D 週期","type":"int",  "default":3, "min":1,"max":10},
            {"key":"oversold",   "label":"超賣區","type":"float","default":20,"min":1,"max":40},
            {"key":"overbought", "label":"超買區","type":"float","default":80,"min":60,"max":99},
        ],
    },
    "rsi_ma": {
        "name": "RSI + 均線複合",
        "fn":   rsi_ma_strategy,
        "params": [
            {"key":"rsi_period", "label":"RSI 週期","type":"int",  "default":14,"min":2,"max":100},
            {"key":"ma_period",  "label":"MA 週期", "type":"int",  "default":20,"min":2,"max":200},
            {"key":"oversold",   "label":"超賣閾值","type":"float","default":35,"min":1,"max":49},
            {"key":"overbought", "label":"超買閾值","type":"float","default":65,"min":51,"max":99},
        ],
    },
    "bb_rsi": {
        "name": "布林 + RSI 雙確認",
        "fn":   bb_rsi_strategy,
        "params": [
            {"key":"bb_period", "label":"BB 週期",  "type":"int",  "default":20, "min":5,"max":200},
            {"key":"std",       "label":"BB 倍數",  "type":"float","default":2.0,"min":0.5,"max":5.0},
            {"key":"rsi_period","label":"RSI 週期", "type":"int",  "default":14, "min":2,"max":100},
            {"key":"rsi_low",   "label":"RSI 超賣", "type":"float","default":35, "min":1,"max":49},
            {"key":"rsi_high",  "label":"RSI 超買", "type":"float","default":65, "min":51,"max":99},
        ],
    },
}
