"""
Finnhub 美股即時報價（免費 60 calls/min）

設定：環境變數 FINNHUB_TOKEN（從 https://finnhub.io 免費註冊取得）

免費版只開放 /quote endpoint（即時報價），歷史 K 棒仍用 yfinance。
overlay 模式：拿 Finnhub 即時價疊加到 yfinance 最後一根 K 棒，達到「真即時」。
"""
import os
import time
import requests

FINNHUB_API = "https://finnhub.io/api/v1"

# 進程內 quote 快取（每 symbol 2s）—避免同一秒多個請求重複打 Finnhub，
# 也讓 Finnhub 暫時掛掉時不會每次都 timeout 拖慢
_QUOTE_CACHE: dict = {}   # symbol → (timestamp, quote_dict_or_None)
_QUOTE_TTL = 2.0
_FAIL_BACKOFF_TTL = 30.0  # Finnhub 失敗時 30s 內不再嘗試（避免每次都吃 timeout）


def _get_token(token: str = "") -> str:
    return token or os.getenv("FINNHUB_TOKEN", "")


def fetch_us_quote(symbol: str, token: str = ""):
    """抓 Finnhub 即時報價。回傳 dict 或 None。

    /quote 回傳：
    - c: current price
    - d: change (absolute)
    - dp: percent change
    - h: high of day
    - l: low of day
    - o: open of day
    - pc: previous close
    - t: timestamp (UNIX seconds, UTC)
    """
    tok = _get_token(token)
    if not tok:
        return None
    now = time.time()
    cached = _QUOTE_CACHE.get(symbol)
    if cached:
        cts, cval = cached
        # 成功的 quote 2s 內直接回快取
        if cval is not None and (now - cts) < _QUOTE_TTL:
            return cval
        # 失敗（None）30s 內不再嘗試，避免每次都吃 timeout
        if cval is None and (now - cts) < _FAIL_BACKOFF_TTL:
            return None
    try:
        resp = requests.get(
            f"{FINNHUB_API}/quote",
            params={"symbol": symbol, "token": tok},
            timeout=3,
        )
        resp.raise_for_status()
        d = resp.json()
        if not d or float(d.get("c", 0)) <= 0:
            _QUOTE_CACHE[symbol] = (now, None)
            return None
        quote = {
            "symbol":     symbol,
            "price":      float(d["c"]),
            "open":       float(d.get("o", d["c"])),
            "high":       float(d.get("h", d["c"])),
            "low":        float(d.get("l", d["c"])),
            "close":      float(d["c"]),
            "prev_close": float(d.get("pc", 0)),
            "change":     float(d.get("d", 0)),
            "change_pct": float(d.get("dp", 0)),
            "timestamp":  int(d.get("t", now)),
        }
        _QUOTE_CACHE[symbol] = (now, quote)
        return quote
    except Exception as e:
        print(f"[finnhub] {symbol} quote error: {e}")
        _QUOTE_CACHE[symbol] = (now, None)  # backoff 30s
        return None


def fetch_us_tickers(symbols: list, token: str = "") -> list:
    """批次抓多檔即時報價（用於 ticker panel）。串行呼叫但有 cache，速度堪用。

    回傳格式相容 fetch_tw_tickers / fetch_tickers 的結構。
    """
    tok = _get_token(token)
    if not tok or not symbols:
        return []
    out = []
    for sym in symbols:
        q = fetch_us_quote(sym, tok)
        if not q:
            continue
        out.append({
            "symbol":     sym,
            "display":    sym,
            "name":       sym,
            "price":      q["price"],
            "change_pct": q["change_pct"],
            "change_amt": q["change"],
            "volume":     0,  # /quote 沒給 volume
        })
    return out
