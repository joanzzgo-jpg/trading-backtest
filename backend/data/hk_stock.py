"""
港股資料 — 歷史走 yfinance（非中資、代號 xxxx.HK），即時報價走騰訊 qt.gtimg.cn。

- 歷史：由 routes 端直接委派 yfinance（與美股同一支 fetch_us_stock），非中資、穩定。
- 即時：fetch_hk_realtime() 打騰訊即時報價 qt.gtimg.cn（社群公認不封 IP、從美國 IP 實測穩定），
  **只送出「查該檔股價」、不外洩任何使用者資料**；回當下價＋當日累積量＋時間，交給累積器堆每分鐘 K。
- 安全：自寫、只用 requests，不引第三方行情套件（避免供應鏈風險）；回應只解析數字、不執行（無 eval）。
- 時間：騰訊回港股當地時間（GMT+8）。全站慣例後端送 UTC naive，前端 toTime() 再 +8 還原（港/台同 GMT+8）。

騰訊 r_hk 報價欄位（~ 分隔）：[3]現價 [5]開 [6]當日累積量 [30]時間 [33]高 [34]低。
"""
import re
import codecs
import requests
from datetime import datetime

_QUOTE_URL = "https://qt.gtimg.cn/q=r_hk{code}"
_SUGGEST_URL = "https://smartbox.gtimg.cn/s3/"   # 騰訊選股建議（支援中文名/代號，同 HK 報價生態）


def _norm_code(symbol: str) -> str:
    """0700.HK／00700／700 → 統一 5 碼零填（港股主板代碼）。"""
    s = "".join(ch for ch in symbol.strip().upper().replace(".HK", "") if ch.isdigit())
    if not s:
        raise ValueError(f"無效港股代號：{symbol}（請用如 0700.HK 或 00700）")
    return s.zfill(5)


def hk_yahoo_code(code: str):
    """港股代號 → Yahoo/yfinance 用的 4 碼格式(去前導零、補足 4 碼)：00700→0700、09988→9988。
    只認普通股/ETF 區間(1~9999)；結構性商品/RMB 雙櫃檯(≥10000，如 80700)回 None。非數字回 None。"""
    s = "".join(ch for ch in str(code) if ch.isdigit())
    if not s:
        return None
    n = int(s)
    if n < 1 or n > 9999:              # 09999 以上非普通股(窩輪/牛熊證/RMB 櫃檯)
        return None
    return str(n).zfill(4)


def _decode_esc(s: str) -> str:
    """騰訊建議回應的名稱是 \\uXXXX 轉義字串 → 還原成中文；失敗回原字串。"""
    try:
        return codecs.decode(s.encode("latin-1", "ignore"), "unicode_escape")
    except Exception:
        return s


def search_hk_stocks(query: str):
    """港股搜尋：走騰訊 smartbox 建議（中文/英文/代號皆可，同 HK 報價生態、社群公認不封 IP）。
    ⚠ 騰訊建議庫用**簡體**收錄 → 先繁轉簡再查（否則『騰訊/美團/匯豐』等繁體名查無）；
    只留正股/ETF（type=GP）、濾掉窩輪牛熊證（QZ）與 RMB 雙櫃檯/衍生代號（8/6/7 開頭，如 80700
    = 00700 的人民幣櫃檯）；顯示名稱再簡轉繁。回 [{symbol:'00700.HK', name, type, exchange}]；失敗回 []。
    只送出「查詢字串」、不外洩任何使用者資料；回應純解析、不執行（無 eval）。"""
    q = (query or "").strip()
    if not q:
        return []
    try:
        import zhconv
        qs = zhconv.convert(q, "zh-hans")            # 繁→簡（騰訊建議庫用簡體）
    except Exception:
        qs = q
    try:
        r = requests.get(_SUGGEST_URL, params={"v": "2", "q": qs, "t": "hk"}, timeout=6,
                         headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"})
        r.raise_for_status()
        r.encoding = "gbk"
        m = re.search(r'v_hint="(.*)"', r.text, re.S)   # 貪婪吃到最後一個引號（名稱為 \\u 轉義、無裸引號）
    except Exception:
        return []
    if not m or m.group(1) in ("N", ""):
        return []
    out, seen = [], set()
    for part in m.group(1).split("^"):
        f = part.split("~")
        if len(f) < 5:
            continue
        mk, code, name = f[0], f[1], f[2]
        typ = f[4].split("-")[0]                      # 尾端可能帶 -NX 結束記號
        if mk != "hk" or typ != "GP":                # 只要正股/ETF，濾掉窩輪牛熊證(QZ)等
            continue
        c4 = hk_yahoo_code(code)                      # 5 碼→Yahoo 4 碼；RMB 櫃檯/衍生→None 濾掉
        if not c4:
            continue
        sym = f"{c4}.HK"
        if sym in seen:
            continue
        seen.add(sym)
        try:
            import zhconv
            zh = zhconv.convert(_decode_esc(name), "zh-hant")   # 簡→繁顯示（全站繁體）
        except Exception:
            zh = _decode_esc(name)
        out.append({"symbol": sym, "name": zh, "type": "股票", "exchange": "Hong Kong"})
        if len(out) >= 20:
            break
    return out


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
