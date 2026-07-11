"""
美股資料抓取 - 使用 yfinance
"""
import pandas as pd
import yfinance as yf

# ── yfinance 反封/防卡：Railway 等雲端 IP 常被 Yahoo tarpit（連上不回應）→ 無 timeout 會無限卡。
#   ① 一律加 timeout（止血，不再卡死）②用 curl_cffi 瀏覽器指紋 session 假冒（避開 Yahoo bot 偵測，雲端標準解法）。
_YF_TIMEOUT = 15
_YF_SESSION = None
def _yf_session():
    global _YF_SESSION
    if _YF_SESSION is not None:
        return _YF_SESSION
    try:
        from curl_cffi import requests as _cr
        _YF_SESSION = _cr.Session(impersonate="chrome")
    except Exception:
        try:
            import requests as _rq
            _YF_SESSION = _rq.Session()
            _YF_SESSION.headers.update({"User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"})
        except Exception:
            _YF_SESSION = False
    return _YF_SESSION

def _yf_ticker(symbol):
    # 港股：全站用 HKEX 標準 5 碼(00020.HK)，但 Yahoo/yfinance 只認去前導零的 4 碼(0020.HK) → 抓價前轉換。
    if isinstance(symbol, str) and symbol.upper().endswith(".HK"):
        digits = "".join(ch for ch in symbol[:-3] if ch.isdigit())
        if digits and 1 <= int(digits) <= 9999:
            symbol = f"{str(int(digits)).zfill(4)}.HK"   # 00020.HK → 0020.HK（Yahoo 用 4 碼）
    sess = _yf_session()
    if sess:
        try:
            return yf.Ticker(symbol, session=sess)
        except Exception:
            pass
    return yf.Ticker(symbol)

TF_MAP = {
    "1M": "1mo",
    "1w": "1wk",
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
    "5m": "5m",
    "1m": "1m",
}

MAX_DAYS = {
    "1M": 3650, "1w": 3650, "1d": 3650,
    # yfinance 對 intraday 是「嚴格小於」邊界（剛好觸頂會被拒），留 1 天 buffer
    "4h": 59, "1h": 720, "15m": 59, "5m": 59, "1m": 7,   # 1m yfinance 僅近 7 天
}


def fetch_us_stock(symbol: str, start: str, end: str, timeframe: str = "1d") -> pd.DataFrame:
    interval = TF_MAP.get(timeframe, "1d")
    ticker   = _yf_ticker(symbol)
    try:
        raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True, timeout=_YF_TIMEOUT)
    except TypeError:   # 舊版 yfinance history 不吃 timeout
        raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)

    if raw.empty:
        raise ValueError(f"無資料: {symbol}，請確認代號正確（如 AAPL、TSLA）")

    df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
    df.columns = ["open", "high", "low", "close", "volume"]

    # 移除 timezone（相容各版本 yfinance）
    idx = pd.to_datetime(df.index)
    if idx.tz is not None:
        idx = idx.tz_convert("UTC").tz_localize(None)
    df.index = idx
    df.index.name = "time"
    df = df.reset_index()
    # 美股 1h/4h 用 09:30 半小時錯位（如 09:30、10:30），不能 floor 到整點，
    # 否則 13:30 UTC（=09:30 ET 開盤）會被往前推到 13:00（盤前），時間軸全錯。
    # 只對 1m/5m/15m 做 floor（這些對齊整點/分鐘），其他直接保留 yfinance 原時間。
    freq = {"1m": "1min", "5m": "5min", "15m": "15min"}.get(timeframe)
    if freq:
        df["time"] = pd.to_datetime(df["time"]).dt.floor(freq)
        df = df.drop_duplicates(subset=["time"], keep="last").reset_index(drop=True)
    else:
        df["time"] = pd.to_datetime(df["time"]).dt.floor("s")
    df = df.dropna(subset=["close"]).reset_index(drop=True)
    return df


def _parse_yf_quotes(quotes: list) -> list:
    out = []
    for r in quotes:
        sym = r.get("symbol", "")
        if not sym:
            continue
        out.append({
            "symbol":   sym,
            "name":     r.get("longname") or r.get("shortname") or sym,
            "type":     r.get("quoteType", ""),
            "exchange": r.get("exchDisp") or r.get("exchange", ""),
        })
    return out


def search_us_stocks(query: str) -> list:
    """搜尋美股，依序嘗試 requests → yf.Search，失敗回傳空列表"""
    # 方法 1: requests（比 urllib 更穩定，自動處理 SSL / redirect）
    try:
        import requests as _req
        resp = _req.get(
            "https://query1.finance.yahoo.com/v1/finance/search",
            params={"q": query, "quotesCount": 10, "newsCount": 0},
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"},
            timeout=8,
        )
        if resp.ok:
            return _parse_yf_quotes(resp.json().get("quotes", []))
    except Exception:
        pass

    # 方法 2: yf.Search fallback
    try:
        return _parse_yf_quotes(yf.Search(query, max_results=10).quotes)
    except Exception:
        return []
