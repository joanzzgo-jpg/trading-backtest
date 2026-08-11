"""
美股資料抓取 - 使用 yfinance
"""
import pandas as pd

# ── yfinance 延遲載入（2026-08-12）──────────────────────────────────────────
# 它在 pandas/numpy 之外**額外吃 30.9 MB**、另外拉進 93 個模組
# （curl_cffi / peewee / bs4 / lxml / websockets / protobuf …）。
# 原本是模組層 import → 每個 worker 一開機就付這筆錢，但美股/港股/外匯的請求
# 不見得每個 worker 都會遇到（線上 workers=2、follower 常常整天只服務加密貨幣）。
# 改成第一次真的要用才載入 → 沒用到就完全不佔。
# ⚠ 一定要走 `_yf()` 取用，不要在模組層 `import yfinance as yf` —— 那就白費了。
# ⚠ taiwan.py / routes/search.py 早就是函式內 import（延遲的），只有這裡是模組層。
_yf_mod = None
def _yf():
    global _yf_mod
    if _yf_mod is None:
        import yfinance as _m
        _yf_mod = _m
    return _yf_mod

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
            return _yf().Ticker(symbol, session=sess)
        except Exception:
            pass
    return _yf().Ticker(symbol)

# 目標時框 → 跟 yfinance 要的 interval。
# ⚠ Yahoo 只認這些：[1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 4h, 1d, 5d, 1wk, 1mo, 3mo]
#   —— 也就是 **2h 不支援**（實測回 "Invalid input - interval=2h is not supported"）。
# ★2026-08-01 修：原本這張表沒有 30m 也沒有 2h，而取值是 TF_MAP.get(tf, "1d") →
#   兩者**靜默退回日線**，前端切到 30m/2h 看到的是日 K（有東西、不報錯，極難發現）。
#   實測 AAPL 30m/2h 都只有「最後交易日 1 根、時間 04:00」＝與 1d 完全一致。
#   30m 官方支援 → 直接要；2h 不支援 → 要 1h 回來自己併（見 _resample_session）。
TF_MAP = {
    "1M": "1mo",
    "1w": "1wk",
    "1d": "1d",
    # ★2026-08-02 4h 也改成由 1h 併：Yahoo 原生 4h 的可回溯上限只有 60 天，
    #   而 1h 有 730 天 → 原本會出現「4 小時線的歷史比 2 小時線還短」（實測 AAPL
    #   4h 只有 80 根、2h 卻有 661 根），完全反直覺。
    #   已逐根驗證兩者等價：同期間 36 根，時間戳、開高低收、成交量**全部完全相同**
    #   （美股與港股皆是）→ 換來源不改變任何一根 K 棒，只是能看得更久。
    "4h": "1h",
    "2h": "1h",     # Yahoo 無 2h → 抓 1h 再併
    "1h": "1h",
    "30m": "30m",
    "15m": "15m",
    "5m": "5m",
    "1m": "1m",
}
RESAMPLE_N = {"2h": 2, "4h": 4}     # 目標時框 → 要把幾根來源棒併成一根

MAX_DAYS = {
    "1M": 3650, "1w": 3650, "1d": 3650,
    # yfinance 對 intraday 是「嚴格小於」邊界（剛好觸頂會被拒），留 1 天 buffer
    "4h": 720, "2h": 720, "1h": 720, "30m": 59, "15m": 59, "5m": 59, "1m": 7,   # 1m yfinance 僅近 7 天
}


def _resample_session(df: pd.DataFrame, n: int) -> pd.DataFrame:
    """把每個交易日的 K 棒「每 n 根併成一根」（從當天第一根算起）。

    ⚠ 刻意不用固定時間原點分桶：美股夏令/冬令時開盤的 UTC 時間差 1 小時（13:30 vs 14:30），
      港股還有午休（09:30-12:00、13:00-16:00 HKT）。用「當天第幾根」分組，對所有市場、
      所有時區、DST 換季都成立，而且與 Yahoo 自己的 4h 分法（貼齊開盤）一致。"""
    if df is None or df.empty or n <= 1:
        return df
    d = df.copy()
    day = d["time"].dt.normalize()
    grp = d.groupby(day).cumcount() // n
    out = d.groupby([day, grp], sort=True).agg(
        time=("time", "first"), open=("open", "first"), high=("high", "max"),
        low=("low", "min"), close=("close", "last"), volume=("volume", "sum"),
    ).reset_index(drop=True)
    return out.sort_values("time").reset_index(drop=True)


# ── Yahoo 限流冷卻（2026-08-11）────────────────────────────────────────────────
# ⚠ 為什麼要有：快速連續切標的/時框時（外匯 21 檔尤其容易），Yahoo 會回 **429**，
#   而舊碼把任何失敗都說成「無資料，請確認代號正確」→ 使用者看到的是「找不到」，
#   但代號根本沒錯，只是被限流。而且沒有冷卻的話會繼續打、把限流拖更久。
#   （同 Binance/Pionex 那兩個熔斷的思路：撞到限流就停手一下，並回**正確的訊息**。）
_YF_COOLDOWN_UNTIL = 0.0
_YF_COOLDOWN_SEC = 20.0


def _yf_is_rate_limited(err) -> bool:
    m = str(err).lower()
    return ("429" in m or "too many requests" in m or "rate limit" in m)


def fetch_us_stock(symbol: str, start: str, end: str, timeframe: str = "1d") -> pd.DataFrame:
    global _YF_COOLDOWN_UNTIL
    import time as _t
    if _t.time() < _YF_COOLDOWN_UNTIL:
        raise ValueError(f"{symbol} 暫時無法取得：資料源限流中，請稍候幾秒再試")
    interval = TF_MAP.get(timeframe, "1d")
    ticker   = _yf_ticker(symbol)
    try:
        try:
            raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True, timeout=_YF_TIMEOUT)
        except TypeError:   # 舊版 yfinance history 不吃 timeout
            raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=True)
    except Exception as _e:
        # ⚠ 限流(429) 與「真的查無此代號」要分開講：混在一起會讓使用者以為代號打錯。
        if _yf_is_rate_limited(_e):
            _YF_COOLDOWN_UNTIL = _t.time() + _YF_COOLDOWN_SEC
            raise ValueError(f"{symbol} 暫時無法取得：資料源限流中，請稍候幾秒再試")
        raise

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
    # Yahoo 沒有的時框（目前只有 2h）→ 由來源棒併出來。放在**這個函式內**而不是各路由，
    # 是因為 fetch_us_stock 有 4 個呼叫端 —— 台股就是同一份分桶規則抄在兩處而分歧過。
    _n = RESAMPLE_N.get(timeframe)
    if _n:
        df = _resample_session(df, _n)
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
        return _parse_yf_quotes(_yf().Search(query, max_results=10).quotes)
    except Exception:
        return []
