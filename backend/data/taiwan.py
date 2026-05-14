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


def _yf_history(ticker, interval: str, start: str, end: str):
    """呼叫 yfinance history，回傳 DataFrame；空或失敗回 None。"""
    try:
        raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)
        return raw if not raw.empty else None
    except Exception:
        return None


def fetch_tw_intraday_yf(symbol: str, timeframe: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股分鐘/小時資料（不需 token）。
    先試 .TW 再試 .TWO；若指定範圍失敗，自動縮短至近 30 天重試。
    """
    import yfinance as yf
    from datetime import date, timedelta

    interval    = YF_TF_MAP.get(timeframe, "1h")
    # yfinance end 不含當天，+1 天確保抓到今日資料
    end_incl    = (date.today() + timedelta(days=1)).isoformat()
    short_start = (date.today() - timedelta(days=30)).isoformat()
    # 同樣修正傳入的 end
    end_incl_req = (date.fromisoformat(end) + timedelta(days=1)).isoformat() if end else end_incl

    for suffix in (".TW", ".TWO"):
        ticker = yf.Ticker(f"{symbol}{suffix}")
        raw = _yf_history(ticker, interval, start, end_incl_req)
        if raw is None:
            raw = _yf_history(ticker, interval, short_start, end_incl)
        if raw is None:
            continue
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.columns = ["open", "high", "low", "close", "volume"]
        idx = pd.to_datetime(df.index)
        if idx.tz is None:
            idx = idx.tz_localize("Asia/Taipei")
        idx = idx.tz_convert("UTC").tz_localize(None)
        df.index = idx
        df.index.name = "time"
        df = df.reset_index()
        df["time"] = pd.to_datetime(df["time"]).dt.floor("s")
        return df
    raise ValueError(f"找不到 {symbol} 的分鐘資料（請確認代號正確，例如 2330）")


TWSE_MIS_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TWSE_MIS_HEADERS = {"Referer": "https://mis.twse.com.tw/stock/index.jsp"}

# 熱門台股清單 (代號, tse上市/otc上櫃)
TW_POPULAR = [
    ("2330","tse"),("2317","tse"),("2454","tse"),("2412","tse"),("2308","tse"),
    ("2382","tse"),("2881","tse"),("2882","tse"),("2886","tse"),("2891","tse"),
    ("2884","tse"),("2885","tse"),("2892","tse"),("2002","tse"),("1301","tse"),
    ("1303","tse"),("1326","tse"),("2357","tse"),("2303","tse"),("3711","tse"),
    ("2379","tse"),("2395","tse"),("4904","tse"),("4938","tse"),("3034","tse"),
    ("3008","tse"),("2327","tse"),("2376","tse"),("2408","tse"),("5880","tse"),
    ("2890","tse"),("6505","tse"),("1216","tse"),("2912","tse"),("2301","tse"),
    ("2353","tse"),("2409","tse"),("3045","tse"),("2887","tse"),("2615","tse"),
    ("2603","tse"),("2609","tse"),("2610","tse"),("2618","tse"),("2883","tse"),
    ("2880","tse"),("2337","tse"),("6669","otc"),("3231","otc"),("6770","tse"),
]

TW_NAME_MAP = {
    "2330":"台積電","2317":"鴻海","2454":"聯發科","2412":"中華電","2308":"台達電",
    "2382":"廣達","2881":"富邦金","2882":"國泰金","2886":"兆豐金","2891":"中信金",
    "2884":"玉山金","2885":"元大金","2892":"第一金","2002":"中鋼","1301":"台塑",
    "1303":"南亞","1326":"台化","2357":"華碩","2303":"聯電","3711":"日月光投控",
    "2379":"瑞昱","2395":"研華","4904":"遠傳","4938":"和碩","3034":"聯詠",
    "3008":"大立光","2327":"國巨","2376":"技嘉","2408":"南亞科","5880":"合庫金",
    "2890":"永豐金","6505":"台塑化","1216":"統一","2912":"統一超","2301":"光寶科",
    "2353":"宏碁","2409":"友達","3045":"台灣大","2887":"台新金","2615":"萬海",
    "2603":"長榮","2609":"陽明","2610":"華航","2618":"長榮航","2883":"開發金",
    "2880":"華南金","2337":"旺宏","6669":"緯穎","3231":"緯創","6770":"力積電",
}


def fetch_tw_tickers() -> list:
    """批量抓取熱門台股即時行情（TWSE MIS），盤後用昨收價計算漲跌。"""
    ex_ch = "|".join(f"{ex}_{sym}.tw" for sym, ex in TW_POPULAR)
    try:
        resp = requests.get(
            TWSE_MIS_URL,
            params={"ex_ch": ex_ch, "json": "1", "delay": "0"},
            headers=TWSE_MIS_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        arr = resp.json().get("msgArray", [])
        tickers = []
        for d in arr:
            sym = d.get("c", "")
            if not sym:
                continue
            z = d.get("z", "-")   # 最新成交價
            y = d.get("y", "-")   # 昨收價
            if not z or z == "-":
                z = y             # 盤後 / 未成交用昨收
            try:
                price      = float(z)
                prev       = float(y)
                change_amt = round(price - prev, 2)
                change_pct = round((change_amt / prev * 100) if prev else 0.0, 2)
                raw_vol    = d.get("v", "0") or "0"
                volume     = float(raw_vol.replace(",", "")) * 1000
                name       = d.get("n", "") or TW_NAME_MAP.get(sym, sym)
                tickers.append({
                    "symbol":     sym,
                    "display":    sym,
                    "name":       name,
                    "price":      price,
                    "change_pct": change_pct,
                    "change_amt": change_amt,
                    "volume":     volume,
                })
            except (ValueError, TypeError):
                continue
        tickers.sort(key=lambda x: x["change_pct"], reverse=True)
        return tickers
    except Exception:
        return []


def fetch_tw_latest_bar_yf(symbol: str) -> dict | None:
    """用 yfinance 抓最新一根日線（盤中即更新，盤後取當日收盤）"""
    try:
        import yfinance as yf
        for suffix in (".TW", ".TWO"):
            raw = yf.Ticker(f"{symbol}{suffix}").history(
                period="5d", interval="1d", auto_adjust=True
            )
            if raw.empty:
                continue
            last = raw.iloc[-1]
            ts = pd.Timestamp(raw.index[-1])
            if ts.tzinfo is not None:
                ts = ts.tz_convert("Asia/Taipei").tz_localize(None)
            ts = ts.normalize()  # 取日期部分
            return {
                "time":   ts,
                "open":   float(last["Open"]),
                "high":   float(last["High"]),
                "low":    float(last["Low"]),
                "close":  float(last["Close"]),
                "volume": float(last["Volume"]),
            }
    except Exception:
        pass
    return None


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
