"""Fugle 富果 Marketdata API — 台股『即時』分鐘 K（突破 yfinance 20 分延遲）。

需環境變數 FUGLE_TOKEN（到 developer.fugle.tw 申請免費開發者金鑰）。未設定時所有
函式回 None，呼叫端自動 fallback 回 yfinance + MIS。金鑰只從環境變數讀，絕不寫死/commit。

Marketdata v1.0 intraday candles 回傳當日即時分鐘K（升冪）：
  GET /marketdata/v1.0/stock/intraday/candles/{symbol}?timeframe={1|5|10|15|30|60}
  header: X-API-KEY: <token>
  → {"timeframe":"5","data":[{"date":"2026-05-29T09:00:00.000+08:00","open","high","low","close","volume","average"}, ...]}
"""
import os
import requests
import pandas as pd

_BASE = "https://api.fugle.tw/marketdata/v1.0/stock"
# app 時框 → Fugle intraday timeframe（分鐘）。4h 不支援(最大 60)，由呼叫端走既有路徑。
_TF = {"5m": "5", "15m": "15", "1h": "60", "1m": "1"}


def fugle_enabled() -> bool:
    return bool(os.getenv("FUGLE_TOKEN"))


def fetch_fugle_intraday(symbol: str, timeframe: str):
    """回傳今日即時分鐘K DataFrame（time 為 UTC naive，與 yfinance 一致），失敗/未啟用回 None。"""
    token = os.getenv("FUGLE_TOKEN")
    tfp = _TF.get(timeframe)
    if not token or not tfp:
        return None
    try:
        r = requests.get(f"{_BASE}/intraday/candles/{symbol}",
                         params={"timeframe": tfp},
                         headers={"X-API-KEY": token}, timeout=8)
        r.raise_for_status()
        rows = r.json().get("data") or []
        if not rows:
            return None
        out = []
        for c in rows:
            # "2026-05-29T09:00:00.000+08:00" → UTC naive（前端 toTime() +8 還原台北時間）
            ts = pd.Timestamp(c["date"]).tz_convert("UTC").tz_localize(None)
            out.append({"time": ts, "open": c.get("open"), "high": c.get("high"),
                        "low": c.get("low"), "close": c.get("close"),
                        "volume": c.get("volume") or 0})
        if not out:
            return None
        return pd.DataFrame(out).sort_values("time").reset_index(drop=True)
    except Exception:
        return None
