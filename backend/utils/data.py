"""數據處理工具"""
import math
import pandas as pd
from indicators.engine import add_indicators, crt_markers, rsi as calc_rsi, macd as calc_macd, \
    kdj_first_cross, bb_kdj_rsi_resonance


def enrich_df(df: pd.DataFrame) -> pd.DataFrame:
    """統一計算所有預設指標（已存在的欄位不重複計算）"""
    missing = {}
    if "bb_upper" not in df.columns:
        missing["bb"] = {"period": 20, "std": 2.0}
    if "kdj_k" not in df.columns:
        missing["kdj"] = {"k_period": 9, "d_period": 3}
    if "rsi_14" not in df.columns:
        missing["rsi"] = {"period": 14}
    if "macd" not in df.columns:
        missing["macd"] = {"fast": 12, "slow": 26, "signal": 9}
    if missing:
        df = add_indicators(df, missing)
    if "bb_upper_1" not in df.columns and "bb_middle" in df.columns:   # 1σ 內帶（快取舊資料補算）
        _sd1 = df["close"].rolling(20).std()
        df["bb_upper_1"] = df["bb_middle"] + _sd1
        df["bb_lower_1"] = df["bb_middle"] - _sd1
    if "rsi_7" not in df.columns:
        df["rsi_7"] = calc_rsi(df["close"], 7)
    if "crt" not in df.columns:
        df["crt"] = crt_markers(df["high"], df["low"], df["open"], df["close"])
    if "kdj_cross" not in df.columns:
        df["kdj_cross"] = kdj_first_cross(df["kdj_k"], df["kdj_d"])
    if "resonance" not in df.columns:
        df["resonance"] = bb_kdj_rsi_resonance(
            df["high"], df["low"], df["bb_upper"], df["bb_lower"],
            df["kdj_k"], df["kdj_d"], df["rsi_7"],
            rsi_ob=65, rsi_os=35,
        )
    return df


def df_to_records(df: pd.DataFrame):
    """轉換 DataFrame 為 JSON 友好的記錄"""
    records = df.to_dict(orient="records")
    for r in records:
        if "time" in r and hasattr(r["time"], "isoformat"):
            r["time"] = r["time"].isoformat()
        for key in list(r.keys()):
            if isinstance(r[key], float) and math.isnan(r[key]):
                r[key] = None
    return records

