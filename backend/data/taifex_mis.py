"""TAIFEX 官方 MIS 期貨即時行情 — 免金鑰、免開戶、即時。

台指期(TAIEX 期貨)歸在台股 market=tw 底下，由 symbol(TXF/MXF/TMF) 偵測走本模組。
與台股用的 TWSE MIS 同思路：
- 報價：POST mis.taifex.com.tw/futures/api/getQuoteList（一次回全部期貨即時快照，快取 2s）。
- K線：MIS 無分時端點 → 用即時報價『前向累積』分鐘K（同 routes/data.py `_mis_accumulate`）；
  只有「伺服器開始輪詢之後」的當日棒（開盤早段補不回來，這是免費源的限制）。

近月合約：從 getQuoteList 挑該產品「單一月份、最近到期」的合約（如大台 TXFG6-F=臺指期近月）。
"""
import re
import time
import requests
import pandas as pd
from datetime import datetime, timedelta

_URL = "https://mis.taifex.com.tw/futures/api/getQuoteList"
_HDRS = {
    "Content-Type": "application/json",
    "Origin": "https://mis.taifex.com.tw",
    "Referer": "https://mis.taifex.com.tw/futures/",
    "User-Agent": "Mozilla/5.0",
}
# 產品碼 → 顯示名（台指三兄弟；微台 TMF 在 MIS 主 feed 未必有，抓不到就自動略過）
PRODUCTS = {"TXF": "台指期(大台)", "MXF": "小台指", "TMF": "微台指"}
_TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}

_qcache = {"ts": 0.0, "data": None}   # getQuoteList 全量快取（一次抓全部期貨）


def _get_quote_list():
    """回傳全部期貨即時報價 list（快取 2s；失敗沿用上次成功結果 stale-serve）。"""
    now = time.time()
    if _qcache["data"] is not None and now - _qcache["ts"] < 2:
        return _qcache["data"]
    try:
        r = requests.post(_URL, json={"MarketType": "0", "SymbolType": "F"},
                          headers=_HDRS, timeout=8)
        r.raise_for_status()
        j = r.json()
        if j.get("RtCode") != "0":
            return _qcache["data"] or []
        lst = (j.get("RtData") or {}).get("QuoteList") or []
        if lst:
            _qcache["data"] = lst
            _qcache["ts"] = now
        return lst or (_qcache["data"] or [])
    except Exception:
        return _qcache["data"] or []


def _f(v):
    try:
        if v in (None, "", "--"):
            return None
        return float(str(v).replace(",", ""))
    except Exception:
        return None


def _month_key(disp: str) -> int:
    """從 DispCName 尾端數字排序近月，如 '臺指期076'→07月6年→607、'臺指期017'→01月7年→701。"""
    m = re.search(r"(\d+)\D*$", disp or "")
    if not m:
        return 999999
    s = m.group(1)
    if len(s) >= 3:                      # MMY（月2碼+年）
        return int(s[-1]) * 100 + int(s[:2])
    return 999999


def resolve_front_month(product: str):
    """把產品碼(TXF/MXF/TMF)解析成當前近月合約碼(如 TXFG6-F)。抓不到回 None。"""
    product = (product or "").upper()
    if product not in PRODUCTS:
        return None
    pat = re.compile(rf"^{product}[A-Z]\d-F$")   # 單一月份合約（排除價差/組合）
    cands = []
    for q in _get_quote_list():
        sid = q.get("SymbolID", "")
        if pat.match(sid):
            cands.append((_month_key(q.get("DispCName", "")), sid))
    if not cands:
        return None
    cands.sort()                          # 依到期月升冪 → 第一個即近月
    return cands[0][1]


def _find_quote(symbol_id: str):
    for q in _get_quote_list():
        if q.get("SymbolID") == symbol_id:
            return q
    return None


def fetch_taifex_quote(product: str):
    """近月即時報價 dict，抓不到/休市無資料回 None。"""
    prod = (product or "").upper()
    sid = resolve_front_month(prod)
    if not sid:
        return None
    q = _find_quote(sid)
    if not q:
        return None
    price = _f(q.get("CLastPrice"))
    if price is None:
        price = _f(q.get("CTestPrice"))       # 盤前/收盤僅有試撮價
    if price is None:
        return None
    ref = _f(q.get("CRefPrice"))
    diff = _f(q.get("CDiff"))
    if diff is None and ref is not None:
        diff = price - ref
    dpct = _f(q.get("CDiffRate"))
    if dpct is None and ref:
        dpct = (price - ref) / ref * 100
    return {
        "symbol": prod, "contract": sid,
        "name": PRODUCTS.get(prod, q.get("DispCName") or sid),
        "price": price, "change_amt": diff, "change_pct": dpct,
        "volume": _f(q.get("CTotalVolume")) or 0,
        "open": _f(q.get("COpenPrice")), "high": _f(q.get("CHighPrice")),
        "low": _f(q.get("CLowPrice")),
        "bid": _f(q.get("CBidPrice1")), "ask": _f(q.get("CAskPrice1")),
        "cdate": q.get("CDate"), "ctime": q.get("CTime"),
    }


def fetch_taifex_tickers():
    """報價牆用：台指三兄弟近月即時報價 rows（欄位對齊台股 ticker + is_future 置頂旗標）。"""
    out = []
    for prod in PRODUCTS:
        q = fetch_taifex_quote(prod)
        if not q or q.get("price") is None:
            continue
        out.append({
            "symbol": prod, "display": prod, "name": q["name"], "price": q["price"],
            "change_pct": q.get("change_pct") or 0.0,
            "change_amt": q.get("change_amt") or 0.0,
            "volume": q.get("volume") or 0, "is_future": True,
        })
    return out


# ── 前向累積分鐘K（同台股 _mis_accumulate 思路）─────────────────────
_acc: dict = {}   # key f"{prod}:{minutes}" → {"day":date, "cur":{...}|None, "done":{ts:bar}}


def _acc_list(key: str):
    st = _acc.get(key)
    if not st:
        return []
    keys = set(st["done"].keys())
    if st["cur"]:
        keys.add(st["cur"]["ts"])
    out = []
    for ts in sorted(keys):
        b = st["cur"] if (st["cur"] and ts == st["cur"]["ts"]) else st["done"][ts]
        out.append({"time": ts, "open": b["o"], "high": b["h"], "low": b["l"],
                    "close": b["c"], "volume": b["vol"]})
    return out


def _parse_dt(cdate: str, ctime: str):
    """CDate '20260706' + CTime 'HHMMSS' → 台北時間 → UTC naive（前端 toTime() 會 +8 還原）。"""
    try:
        ct = (ctime or "").rjust(6, "0")
        dt = datetime(int(cdate[:4]), int(cdate[4:6]), int(cdate[6:8]),
                      int(ct[:2]), int(ct[2:4]), int(ct[4:6]))
        return dt - timedelta(hours=8)
    except Exception:
        return None


def fetch_taifex_candles(product: str, timeframe: str):
    """前向累積分鐘K DataFrame（time UTC naive）。無新報價→回已累積；都沒有→None。"""
    minutes = _TF_MIN.get(timeframe)
    if minutes is None:
        return None
    prod = (product or "").upper()
    key = f"{prod}:{minutes}"
    q = fetch_taifex_quote(prod)
    price = q.get("price") if q else None
    dt = _parse_dt(q.get("cdate"), q.get("ctime")) if q else None
    if q is None or price is None or dt is None:
        rows = _acc_list(key)
        return pd.DataFrame(rows) if rows else None
    bar_min = (dt.hour * 60 + dt.minute) // minutes * minutes
    bar_ts = dt.replace(hour=bar_min // 60, minute=bar_min % 60, second=0, microsecond=0)
    st = _acc.get(key)
    if st is None or st["day"] != dt.date():          # 換日重置
        st = {"day": dt.date(), "cur": None, "done": {}}
        _acc[key] = st
    cumvol = q.get("volume") or 0
    cur = st["cur"]
    if cur is None or cur["ts"] != bar_ts:            # 新分鐘 → 收舊棒、開新棒
        if cur is not None:
            st["done"][cur["ts"]] = cur
        st["cur"] = {"ts": bar_ts, "o": price, "h": price, "l": price, "c": price,
                     "vol0": cumvol, "vol": 0}
    else:                                             # 同分鐘 → 更新高/低/收 + 量(累積量差)
        cur["h"] = max(cur["h"], price); cur["l"] = min(cur["l"], price); cur["c"] = price
        cur["vol"] = max(0, cumvol - cur["vol0"])
    rows = _acc_list(key)
    return pd.DataFrame(rows) if rows else None


# ── 背景輪詢：盤中每隔數秒自動累積，使「每一分鐘 K」都被記到（不必等有人開圖表）──
TF_LIST = ("1m", "5m", "15m", "1h")


def in_session() -> bool:
    """現在是否為台指期交易時段(台北時間)。日盤 08:45–13:45(一~五)、
    夜盤 15:00–翌日 05:00(一~五夜，延續到六晨)。週日無盤。"""
    tpe = datetime.utcnow() + timedelta(hours=8)
    wd = tpe.weekday()                       # Mon=0 … Sun=6
    hm = tpe.hour * 60 + tpe.minute
    day  = wd <= 4 and (8 * 60 + 45) <= hm < (13 * 60 + 45)   # 日盤 一~五
    eve  = wd <= 4 and hm >= 15 * 60                          # 夜盤前半 一~五 15:00+
    morn = 1 <= wd <= 5 and hm < 5 * 60                       # 夜盤後半 二~六 00:00–05:00
    return day or eve or morn


def poll_all() -> int:
    """把三兄弟 × 各時框都累積一次（供背景 worker 每隔數秒呼叫）。回傳有資料的組數。"""
    n = 0
    for prod in PRODUCTS:
        for tf in TF_LIST:
            try:
                df = fetch_taifex_candles(prod, tf)
                if df is not None and not df.empty:
                    n += 1
            except Exception:
                pass
    return n
