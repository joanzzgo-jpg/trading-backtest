"""
台股資料抓取 - 使用 FinMind API（免費）
"""
import pandas as pd
import requests
from datetime import datetime, timedelta


FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"


def fetch_tw_stock(symbol: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """
    抓取台股 OHLCV 資料
    symbol: 股票代號，例如 "2330" (台積電)
    start/end: "YYYY-MM-DD"
    """
    params = {
        "dataset": "TaiwanStockPrice",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind API 錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的資料")

    df = pd.DataFrame(records)
    df = df.rename(columns={
        "date": "time",
        "open": "open",
        "max": "high",
        "min": "low",
        "close": "close",
        "Trading_Volume": "volume",
    })
    df["time"] = pd.to_datetime(df["time"])
    df = df[["time", "open", "high", "low", "close", "volume"]].copy()
    df = df.sort_values("time").reset_index(drop=True)

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


def resample_tw(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """將日線資料聚合為週線或月線"""
    if timeframe == "1d":
        return df
    rule = {"1w": "W-FRI", "1M": "MS"}.get(timeframe, "1d")
    df = df.set_index("time")
    resampled = df.resample(rule).agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open"])
    resampled = resampled.reset_index()
    return resampled


def search_tw_stock(keyword: str, api_token: str = "") -> list[dict]:
    """搜尋台股代號"""
    params = {
        "dataset": "TaiwanStockInfo",
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    records = data.get("data", [])

    keyword = keyword.lower()
    results = [
        {"symbol": r["stock_id"], "name": r.get("stock_name", "")}
        for r in records
        if keyword in r.get("stock_id", "").lower()
        or keyword in r.get("stock_name", "").lower()
    ]
    return results[:20]
