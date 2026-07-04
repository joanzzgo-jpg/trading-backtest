"""
港股資料 — 歷史走 yfinance（非中資、代號 xxxx.HK），即時報價走騰訊 qt.gtimg.cn。

- 歷史：由 routes 端直接委派 yfinance（與美股同一支 fetch_us_stock），非中資、穩定。
- 即時：fetch_hk_realtime() 打騰訊即時報價 qt.gtimg.cn（社群公認不封 IP、從美國 IP 實測穩定），
  **只送出「查該檔股價」、不外洩任何使用者資料**；回當下價＋當日累積量＋時間，交給累積器堆每分鐘 K。
- 安全：自寫、只用 requests，不引第三方行情套件（避免供應鏈風險）；回應只解析數字、不執行（無 eval）。
- 時間：騰訊回港股當地時間（GMT+8）。全站慣例後端送 UTC naive，前端 toTime() 再 +8 還原（港/台同 GMT+8）。

騰訊 r_hk 報價欄位（~ 分隔）：[3]現價 [5]開 [6]當日累積量 [30]時間 [33]高 [34]低。
"""
import requests
from datetime import datetime

_QUOTE_URL = "https://qt.gtimg.cn/q=r_hk{code}"


def _norm_code(symbol: str) -> str:
    """0700.HK／00700／700 → 統一 5 碼零填（港股主板代碼）。"""
    s = "".join(ch for ch in symbol.strip().upper().replace(".HK", "") if ch.isdigit())
    if not s:
        raise ValueError(f"無效港股代號：{symbol}（請用如 0700.HK 或 00700）")
    return s.zfill(5)


def fetch_hk_realtime(symbol: str):
    """騰訊即時報價 → dict(time=HKT naive, open/high/low/close, volume=當日累積量)；失敗回 None。"""
    code = _norm_code(symbol)
    try:
        r = requests.get(_QUOTE_URL.format(code=code), timeout=6,
                         headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"})
        r.raise_for_status()
        r.encoding = "gbk"
        txt = r.text
        i = txt.find('"'); j = txt.rfind('"')
        if i < 0 or j <= i:
            return None
        f = txt[i + 1:j].split("~")
        if len(f) < 35 or not f[3]:
            return None
        price = float(f[3])
        ts = datetime.strptime(f[30].strip(), "%Y/%m/%d %H:%M:%S")   # 港股當地時間(GMT+8) naive
        return {
            "time":   ts,
            "open":   float(f[5])  if f[5]  else price,
            "high":   float(f[33]) if f[33] else price,
            "low":    float(f[34]) if f[34] else price,
            "close":  price,
            "volume": float(f[6])  if f[6]  else 0.0,   # 當日累積成交量(股)
        }
    except Exception:
        return None
