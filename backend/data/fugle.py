"""Fugle 富果 Marketdata API — 台股『即時』分鐘 K（突破 yfinance 20 分延遲）。

需環境變數 FUGLE_TOKEN（到 developer.fugle.tw 申請免費開發者金鑰）。
**支援多把金鑰**：FUGLE_TOKEN 可放多把，用逗號/空白分隔 → 輪替分散每秒上限（規模化用）。
任一把被 429 限流 → 冷卻 60 秒、自動換下一把；全部失敗回 None，呼叫端 fallback 回 yfinance+MIS。
金鑰只從環境變數讀，絕不寫死/commit。

Marketdata v1.0 intraday candles 回傳當日即時分鐘K（升冪）：
  GET /marketdata/v1.0/stock/intraday/candles/{symbol}?timeframe={1|5|10|15|30|60}
  header: X-API-KEY: <token>
"""
import os
import time
import requests
import pandas as pd

_BASE = "https://api.fugle.tw/marketdata/v1.0/stock"
_TF = {"5m": "5", "15m": "15", "1h": "60", "1m": "1"}   # 4h 不支援(最大 60)，由呼叫端走既有路徑
_cooldown: dict = {}    # token → 冷卻到期時間戳（被 429 限流時）
_rr = {"i": 0}          # round-robin 指標


def _keys():
    # 金鑰本身是 base64（無空白/逗號），故可安全用逗號/空白分隔多把
    raw = os.getenv("FUGLE_TOKEN", "")
    return [k.strip() for k in raw.replace(",", " ").split() if k.strip()]


def fugle_enabled() -> bool:
    return bool(_keys())


def _pick_key():
    keys = _keys()
    if not keys:
        return None
    now = time.time()
    avail = [k for k in keys if _cooldown.get(k, 0) < now] or keys   # 全冷卻中 → 仍盡力一試
    k = avail[_rr["i"] % len(avail)]
    _rr["i"] += 1
    return k


def fetch_fugle_intraday(symbol: str, timeframe: str):
    """回傳今日即時分鐘K DataFrame（time 為 UTC naive，與 yfinance 一致），失敗/未啟用回 None。"""
    tfp = _TF.get(timeframe)
    if not tfp or not fugle_enabled():
        return None
    token = _pick_key()
    try:
        r = requests.get(f"{_BASE}/intraday/candles/{symbol}",
                         params={"timeframe": tfp},
                         headers={"X-API-KEY": token}, timeout=8)
        if r.status_code == 429:                       # 限流 → 該把冷卻 60s，本次降級
            _cooldown[token] = time.time() + 60
            return None
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
