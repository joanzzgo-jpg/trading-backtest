"""數據處理工具"""
import math
import pandas as pd
import gc
from indicators.engine import add_indicators, crt_markers, rsi as calc_rsi, macd as calc_macd, \
    kdj_first_cross, bb_kdj_rsi_resonance


def enrich_df(df: pd.DataFrame) -> pd.DataFrame:
    """統一計算所有預設指標"""
    default_indicators = {
        "bb":   {"period": 20, "std": 2.0},
        "kdj":  {"k_period": 9, "d_period": 3},
        "rsi":  {"period": 14},
        "macd": {"fast": 12, "slow": 26, "signal": 9},
    }
    df = add_indicators(df, default_indicators)
    df["rsi_7"] = calc_rsi(df["close"], 7)
    df["crt"]   = crt_markers(df["high"], df["low"], df["open"], df["close"])
    df["kdj_cross"] = kdj_first_cross(df["kdj_k"], df["kdj_d"])
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


def safe_df_cleanup(df: pd.DataFrame):
    """安全釋放 DataFrame 記憶體"""
    del df
    gc.collect()
