"""Twelve Data API — 美股『即時』分鐘K（含成交量；Finnhub 累積器的可選升級）。

需環境變數 TWELVEDATA_TOKEN（到 twelvedata.com 用 email 免費申請，免 KYC）。
**支援多把金鑰**：逗號/空白分隔 → 輪替分散免費版 8 req/min 上限（多人/多標的用）。
任一把 429 → 冷卻 60 秒換下一把；失敗回 None，呼叫端 fallback 回 Finnhub 累積器。
金鑰只從環境變數讀，絕不寫死/commit。time_series 回傳含 volume，時區請求 UTC → UTC naive。

  GET https://api.twelvedata.com/time_series?symbol=AAPL&interval=5min&timezone=UTC&apikey=KEY
  → {"values":[{"datetime":"2024-01-02 15:55:00","open","high","low","close","volume"}, ...](新→舊), "status":"ok"}
"""
import os
import time
import requests
import pandas as pd

_URL = "https://api.twelvedata.com/time_series"
_TF = {"5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day"}
_cooldown: dict = {}
_rr = {"i": 0}


def _keys():
    raw = os.getenv("TWELVEDATA_TOKEN", "")
    return [k.strip() for k in raw.replace(",", " ").split() if k.strip()]


def twelvedata_enabled() -> bool:
    return bool(_keys())


def _pick_key():
    keys = _keys()
    if not keys:
        return None
    now = time.time()
    avail = [k for k in keys if _cooldown.get(k, 0) < now] or keys
    k = avail[_rr["i"] % len(avail)]
    _rr["i"] += 1
    return k


def fetch_twelvedata_intraday(symbol: str, timeframe: str, outputsize: int = 40):
    """回傳即時分鐘K DataFrame（含 volume、time 為 UTC naive），失敗/未啟用回 None。"""
    interval = _TF.get(timeframe)
    if not interval or not twelvedata_enabled():
        return None
    key = _pick_key()
    try:
        r = requests.get(_URL, params={"symbol": symbol, "interval": interval,
                                       "outputsize": outputsize, "timezone": "UTC",
                                       "apikey": key, "format": "JSON"}, timeout=8)
        j = r.json()
        if j.get("status") != "ok":
            if str(j.get("code")) == "429":
                _cooldown[key] = time.time() + 60
            return None
        vals = j.get("values") or []
        out = []
        for v in vals:
            out.append({"time": pd.Timestamp(v["datetime"]),       # 已請求 timezone=UTC → naive 即 UTC
                        "open": float(v["open"]), "high": float(v["high"]),
                        "low": float(v["low"]), "close": float(v["close"]),
                        "volume": float(v.get("volume") or 0)})
        if not out:
            return None
        return pd.DataFrame(out).sort_values("time").reset_index(drop=True)  # values 是新→舊，排成升冪
    except Exception:
        return None
