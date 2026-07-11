"""數據處理工具"""
import math
import pandas as pd
from indicators.engine import add_indicators, crt_markers, rsi as calc_rsi, macd as calc_macd, \
    kdj_first_cross, bb_kdj_rsi_resonance


def enrich_df(df: pd.DataFrame, signals: bool = False, indicators: bool = True) -> pd.DataFrame:
    """統一計算所有預設指標（已存在的欄位不重複計算）。

    signals=False（預設）：不算 crt / kdj_cross / resonance 三個「訊號」欄位。
        這三欄原只供 CRT S1~S12 使用（2026-07 已移除），且佔 enrich 約 8 成成本
        （kdj_first_cross 最重）。live 路徑（勝率/FVG/SS/圖表）皆不再讀 → 預設略過。
    signals=True：仍補算三欄，供離線研究腳本（research/）沿用舊分析。
    indicators=False：連 KDJ/RSI/MACD/rsi_7 都不算（只留主圖要用的 BB）。
        前端副圖(KDJ/RSI/MACD)隱藏時(預設)由 /api/ohlcv 帶 indicators=False → 省計算 +
        每根少 8 個欄位的 payload。副圖打開時前端會帶 True 重抓。"""
    if signals:
        indicators = True   # 訊號欄位需要 kdj/rsi 底層欄位 → 強制計算指標
    missing = {}
    if "bb_upper" not in df.columns:
        missing["bb"] = {"period": 20, "std": 2.0}
    if indicators:
        if "kdj_k" not in df.columns:
            missing["kdj"] = {"k_period": 9, "d_period": 3}
        if "rsi_14" not in df.columns:
            missing["rsi"] = {"period": 14}
        if "macd" not in df.columns:
            missing["macd"] = {"fast": 12, "slow": 26, "signal": 9}
    if missing:
        df = add_indicators(df, missing)
    # 1σ 內帶(bb_upper_1/bb_lower_1)已移除：前端 series 不再建立、後端無人讀 → 不補算
    if indicators and "rsi_7" not in df.columns:   # RSI 面板的 rsi7 線需要
        df["rsi_7"] = calc_rsi(df["close"], 7)
    if signals:   # 訊號欄位（僅離線研究用；live 路徑已不需要，見 docstring）
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

