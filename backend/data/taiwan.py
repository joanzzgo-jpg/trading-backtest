"""
台股資料抓取 - 歷史日線用 FinMind，分鐘/小時用 yfinance（不需 token）
"""
import pandas as pd
import requests
from datetime import datetime, timedelta, date


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


def fetch_tw_intraday(symbol: str, timeframe: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """抓取台股分鐘 K 線並聚合為 5m / 15m / 1h"""
    params = {
        "dataset": "TaiwanStockPriceMinute",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = requests.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind 分鐘資料錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的分鐘資料（需登入 FinMind 免費帳號取得 token）")

    df = pd.DataFrame(records)
    # FinMind 分鐘資料欄位: date, Time, open, high, low, close, volume
    time_col  = "date" if "date" in df.columns else "Date"
    clock_col = "Time" if "Time" in df.columns else "time"
    df["time"] = pd.to_datetime(df[time_col].astype(str) + " " + df[clock_col].astype(str))

    col_map = {}
    for c in df.columns:
        cl = c.lower()
        if cl in ("open","high","low","close","volume") and c not in col_map.values():
            col_map[c] = cl
    df = df.rename(columns=col_map)
    df = df[["time","open","high","low","close","volume"]].copy()
    for c in ["open","high","low","close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values("time").dropna(subset=["open"]).reset_index(drop=True)

    rule = {"5m": "5min", "15m": "15min", "1h": "h"}.get(timeframe, "5min")
    df = df.set_index("time")
    df = df.resample(rule).agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"})
    df = df.dropna(subset=["open"]).reset_index()
    return df


YF_TF_MAP = {"5m": "5m", "15m": "15m", "1h": "1h", "4h": "1h"}  # yfinance 不支援 4h，用 1h 替代

# yfinance 各 interval 最多可回溯天數
YF_MAX_DAYS = {"5m": 60, "15m": 60, "1h": 730}


def fetch_tw_intraday_yf(symbol: str, timeframe: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股分鐘/小時資料（不需 token）。
    先試上市後綴 .TW，失敗再試上櫃 .TWO。
    """
    import yfinance as yf

    interval = YF_TF_MAP.get(timeframe, "1h")
    for suffix in (".TW", ".TWO"):
        try:
            raw = yf.Ticker(f"{symbol}{suffix}").history(
                start=start, end=end, interval=interval, auto_adjust=True
            )
            if raw.empty:
                continue
            df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
            df.columns = ["open", "high", "low", "close", "volume"]
            idx = pd.to_datetime(df.index)
            # yfinance 有時回傳 naive 時間戳（已是 Asia/Taipei 當地時間）
            # 統一先 localize 成 Asia/Taipei，再轉 UTC
            if idx.tz is None:
                idx = idx.tz_localize("Asia/Taipei")
            idx = idx.tz_convert("UTC").tz_localize(None)
            df.index = idx
            df.index.name = "time"
            df = df.reset_index()
            df["time"] = pd.to_datetime(df["time"]).dt.floor("s")
            return df
        except Exception:
            continue
    raise ValueError(f"找不到 {symbol} 的分鐘資料（請確認代號正確，例如 2330）")


TWSE_MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TWSE_MIS_HEADERS = {"Referer": "https://mis.twse.com.tw/stock/index.jsp"}


def fetch_tw_realtime(symbol: str):
    """
    TWSE MIS 即時報價（盤中）。
    先試上市(tse)，再試上櫃(otc)。
    盤後或無成交時回傳 None。
    """
    for exchange in ("tse", "otc"):
        try:
            resp = requests.get(
                TWSE_MIS_URL,
                params={"ex_ch": f"{exchange}_{symbol}.tw", "json": "1", "delay": "0"},
                headers=TWSE_MIS_HEADERS,
                timeout=6,
            )
            resp.raise_for_status()
            arr = resp.json().get("msgArray", [])
            if not arr:
                continue
            d = arr[0]
            z = d.get("z", "-")
            if not z or z == "-":
                return None  # 盤後或尚未成交
            date_str = d.get("d", "")
            time_str = d.get("t", "09:00:00")
            if not date_str:
                return None
            ts = datetime.strptime(f"{date_str} {time_str}", "%Y%m%d %H:%M:%S")
            raw_vol = d.get("v", "0") or "0"
            volume = float(raw_vol.replace(",", "")) * 1000  # 張 → 股
            return {
                "time":   ts,
                "open":   float(d.get("o") or z),
                "high":   float(d.get("h") or z),
                "low":    float(d.get("l") or z),
                "close":  float(z),
                "volume": volume,
            }
        except Exception:
            continue
    return None


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
