"""
美股資料抓取 - 使用 yfinance
"""
import pandas as pd
import yfinance as yf

TF_MAP = {
    "1M": "1mo",
    "1w": "1wk",
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
}

MAX_DAYS = {
    "1M": 3650, "1w": 3650, "1d": 3650,
    "4h": 60, "1h": 730, "15m": 60,
}


def fetch_us_stock(symbol: str, start: str, end: str, timeframe: str = "1d") -> pd.DataFrame:
    interval = TF_MAP.get(timeframe, "1d")
    ticker   = yf.Ticker(symbol)
    raw      = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)

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
    df["time"] = pd.to_datetime(df["time"]).dt.floor("s")
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
