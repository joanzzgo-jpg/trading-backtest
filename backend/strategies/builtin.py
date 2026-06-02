"""
內建策略（向量化版）

每個策略回傳 (signal_fn, required_indicators)：
  signal_fn(df) -> np.ndarray[int8]，長度 = len(df)，每根 K 棒一個值：
     1 = buy（做多進場）   -1 = sell（多單出場）
     2 = short（做空進場）  -2 = cover（空單回補）   0 = 無動作
向量化（用 .shift 比較）取代逐列迴圈，長歷史回測也快、不卡。
required_indicators 格式不變，交給 add_indicators 計算欄位。
"""
import numpy as np
import pandas as pd


def _empty(df):
    return np.zeros(len(df), dtype=np.int8)


# ── 均線交叉 ──────────────────────────────────────────────────
def ma_crossover(fast_period: int = 10, slow_period: int = 30):
    fast_col = f"sma_{fast_period}"
    slow_col = f"sma_{slow_period}"

    def signal_fn(df):
        out = _empty(df)
        if fast_col not in df or slow_col not in df:
            return out
        f, s = df[fast_col], df[slow_col]
        fp, sp = f.shift(1), s.shift(1)
        out[((fp <= sp) & (f > s)).to_numpy(na_value=False)] = 1   # 金叉 → buy
        out[((fp >= sp) & (f < s)).to_numpy(na_value=False)] = -1  # 死叉 → sell
        return out

    return signal_fn, {"ma": [{"type": "sma", "period": fast_period}, {"type": "sma", "period": slow_period}]}


# ── RSI 超買超賣 ───────────────────────────────────────────────
def rsi_strategy(period: int = 14, oversold: float = 30, overbought: float = 70):
    col = f"rsi_{period}"

    def signal_fn(df):
        out = _empty(df)
        if col not in df:
            return out
        r, rp = df[col], df[col].shift(1)
        out[((rp < oversold) & (r >= oversold)).to_numpy(na_value=False)] = 1    # 由超賣回升 → buy
        out[((rp > overbought) & (r <= overbought)).to_numpy(na_value=False)] = -1  # 由超買回落 → sell
        return out

    return signal_fn, {"rsi": {"period": period}}


# ── MACD 交叉 ─────────────────────────────────────────────────
def macd_strategy(fast: int = 12, slow: int = 26, signal: int = 9):
    def signal_fn(df):
        out = _empty(df)
        if "macd" not in df or "macd_signal" not in df:
            return out
        m, s = df["macd"], df["macd_signal"]
        mp, sp = m.shift(1), s.shift(1)
        out[((mp <= sp) & (m > s)).to_numpy(na_value=False)] = 1
        out[((mp >= sp) & (m < s)).to_numpy(na_value=False)] = -1
        return out

    return signal_fn, {"macd": {"fast": fast, "slow": slow, "signal": signal}}


# ── 布林通道 ──────────────────────────────────────────────────
def bb_strategy(period: int = 20, std: float = 2.0):
    def signal_fn(df):
        out = _empty(df)
        if "bb_lower" not in df or "bb_upper" not in df:
            return out
        c = df["close"]
        out[(c < df["bb_lower"]).to_numpy(na_value=False)] = 1
        out[(c > df["bb_upper"]).to_numpy(na_value=False)] = -1
        return out

    return signal_fn, {"bb": {"period": period, "std": std}}


# ── KDJ 交叉 ──────────────────────────────────────────────────
def kdj_strategy(k_period: int = 9, d_period: int = 3,
                 oversold: float = 20, overbought: float = 80):
    def signal_fn(df):
        out = _empty(df)
        if "kdj_k" not in df or "kdj_d" not in df:
            return out
        k, d = df["kdj_k"], df["kdj_d"]
        kp, dp = k.shift(1), d.shift(1)
        out[((kp <= dp) & (k > d) & (k < oversold + 20)).to_numpy(na_value=False)] = 1
        out[((kp >= dp) & (k < d) & (k > overbought - 20)).to_numpy(na_value=False)] = -1
        return out

    return signal_fn, {"kdj": {"k_period": k_period, "d_period": d_period}}


# ── RSI + 均線複合 ────────────────────────────────────────────
def rsi_ma_strategy(rsi_period: int = 14, ma_period: int = 20,
                    oversold: float = 35, overbought: float = 65):
    rsi_col = f"rsi_{rsi_period}"
    ma_col  = f"sma_{ma_period}"

    def signal_fn(df):
        out = _empty(df)
        if rsi_col not in df or ma_col not in df:
            return out
        r, rp = df[rsi_col], df[rsi_col].shift(1)
        c, ma = df["close"], df[ma_col]
        out[((rp < oversold) & (r >= oversold) & (c > ma)).to_numpy(na_value=False)] = 1
        out[((rp > overbought) & (r <= overbought) & (c < ma)).to_numpy(na_value=False)] = -1
        return out

    return signal_fn, {
        "rsi": {"period": rsi_period},
        "ma":  [{"type": "sma", "period": ma_period}],
    }


# ── 布林 + RSI 雙重確認 ───────────────────────────────────────
def bb_rsi_strategy(bb_period: int = 20, std: float = 2.0,
                    rsi_period: int = 14, rsi_low: float = 35, rsi_high: float = 65):
    rsi_col = f"rsi_{rsi_period}"

    def signal_fn(df):
        out = _empty(df)
        if "bb_lower" not in df or rsi_col not in df:
            return out
        c, r = df["close"], df[rsi_col]
        out[((c < df["bb_lower"]) & (r < rsi_low)).to_numpy(na_value=False)] = 1
        out[((c > df["bb_upper"]) & (r > rsi_high)).to_numpy(na_value=False)] = -1
        return out

    return signal_fn, {
        "bb":  {"period": bb_period, "std": std},
        "rsi": {"period": rsi_period},
    }


# ── 策略列表 ──────────────────────────────────────────────────
BUILTIN_STRATEGIES = {
    "ma_crossover": {
        "name": "均線交叉",
        "desc": "快線上穿慢線買進、下穿賣出（順勢）",
        "fn":   ma_crossover,
        "params": [
            {"key":"fast_period","label":"快線週期","type":"int","default":10,"min":2,"max":200},
            {"key":"slow_period","label":"慢線週期","type":"int","default":30,"min":5,"max":500},
        ],
    },
    "rsi": {
        "name": "RSI 超買超賣",
        "desc": "RSI 由超賣回升買進、由超買回落賣出（逆勢）",
        "fn":   rsi_strategy,
        "params": [
            {"key":"period",    "label":"RSI 週期","type":"int",  "default":14,"min":2,"max":100},
            {"key":"oversold",  "label":"超賣閾值", "type":"float","default":30,"min":1,"max":49},
            {"key":"overbought","label":"超買閾值", "type":"float","default":70,"min":51,"max":99},
        ],
    },
    "macd": {
        "name": "MACD 交叉",
        "desc": "MACD 上穿訊號線買進、下穿賣出",
        "fn":   macd_strategy,
        "params": [
            {"key":"fast",  "label":"快線","type":"int","default":12,"min":2,"max":50},
            {"key":"slow",  "label":"慢線","type":"int","default":26,"min":5,"max":200},
            {"key":"signal","label":"信號","type":"int","default":9, "min":2,"max":50},
        ],
    },
    "bb": {
        "name": "布林通道",
        "desc": "跌破下軌買進、突破上軌賣出（均值回歸）",
        "fn":   bb_strategy,
        "params": [
            {"key":"period","label":"週期",      "type":"int",  "default":20, "min":5,"max":200},
            {"key":"std",   "label":"標準差倍數","type":"float","default":2.0,"min":0.5,"max":5.0},
        ],
    },
    "kdj": {
        "name": "KDJ 交叉",
        "desc": "K 於低檔上穿 D 買進、高檔下穿賣出",
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
        "desc": "RSI 回升且站上均線才買、回落且跌破均線才賣",
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
        "desc": "觸下軌且 RSI 超賣才買、觸上軌且 RSI 超買才賣",
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
