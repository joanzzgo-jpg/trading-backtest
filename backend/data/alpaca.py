"""Alpaca Market Data API — 美股『即時』分鐘K（IEX feed，免費即時，突破 yfinance ~15 分延遲）。

需環境變數 ALPACA_KEY / ALPACA_SECRET（alpaca.markets 免費申請，Paper 或 Live 皆可取得行情權限）。
未設 → 回 None，呼叫端 fallback 回 Finnhub + yfinance。被 429 限流 → 冷卻 60 秒降級。
金鑰只從環境變數讀，絕不寫死/commit。時間統一轉 UTC naive（與 us_stock 一致；前端 toTime +8 顯示）。

v2 bars：GET https://data.alpaca.markets/v2/stocks/{symbol}/bars?timeframe=5Min&feed=iex&sort=asc
  headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY
  → {"bars":[{"t":"2024-..Z","o","h","l","c","v","n","vw"}], "next_page_token":...}
"""
import os
import time
import requests
import pandas as pd

_BASE = "https://data.alpaca.markets/v2/stocks"
_TF = {"5m": "5Min", "15m": "15Min", "1h": "1Hour", "2h": "2Hour",
       "4h": "4Hour", "1d": "1Day", "1w": "1Week", "1M": "1Month"}
_cooldown = {"until": 0.0}   # 被 429 限流時的冷卻到期時間戳


def alpaca_enabled() -> bool:
    return bool(os.getenv("ALPACA_KEY") and os.getenv("ALPACA_SECRET"))


def fetch_alpaca_bars(symbol: str, timeframe: str, start: str = None, end: str = None, limit: int = 10000):
    """回傳 OHLCV DataFrame（time UTC naive），失敗/未啟用/冷卻中回 None。feed=iex（免費即時）。"""
    tfp = _TF.get(timeframe)
    if not tfp or not alpaca_enabled() or time.time() < _cooldown["until"]:
        return None
    headers = {"APCA-API-KEY-ID": os.getenv("ALPACA_KEY"),
               "APCA-API-SECRET-KEY": os.getenv("ALPACA_SECRET")}
    params = {"timeframe": tfp, "feed": "iex", "limit": min(limit, 10000),
              "sort": "asc", "adjustment": "raw"}
    if start:
        params["start"] = start
    if end:
        params["end"] = end
    try:
        bars, url, page = [], f"{_BASE}/{symbol}/bars", None
        for _ in range(12):                      # 分頁（最多 12 頁）
            if page:
                params["page_token"] = page
            r = requests.get(url, params=params, headers=headers, timeout=8)
            if r.status_code == 429:
                _cooldown["until"] = time.time() + 60
                return None
            r.raise_for_status()
            j = r.json()
            bars += j.get("bars") or []
            page = j.get("next_page_token")
            if not page:
                break
        if not bars:
            return None
        out = [{"time": pd.Timestamp(b["t"]).tz_convert("UTC").tz_localize(None),
                "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"],
                "volume": b.get("v") or 0} for b in bars]
        return pd.DataFrame(out).sort_values("time").reset_index(drop=True)
    except Exception:
        return None
