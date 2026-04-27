"""
加密貨幣資料抓取 — 直接呼叫 Binance REST API（無需 ccxt）
Pionex 使用 Binance 流動性，行情相同；Bybit / OKX 也各自實作。
"""
import json
import time
import urllib.request
import urllib.parse
import pandas as pd
from datetime import datetime, timezone
from typing import Union, Optional

# ── Binance（含 Pionex）────────────────────────────────────────
BINANCE_BASE      = "https://api.binance.com"
BINANCE_FAPI_BASE = "https://fapi.binance.com"  # 永續合約
PIONEX_BASE       = "https://api.pionex.com"

# ── Bybit ─────────────────────────────────────────────────────
BYBIT_BASE   = "https://api.bybit.com"
BYBIT_TF = {
    "1M": "M", "1w": "W", "1d": "D",
    "4h": "240", "1h": "60", "15m": "15",
}

# ── OKX ───────────────────────────────────────────────────────
OKX_BASE  = "https://www.okx.com"
OKX_TF = {
    "1M": "1M", "1w": "1W", "1d": "1D",
    "4h": "4H", "1h": "1H", "15m": "15m",
}

TIMEFRAME_MAP = {
    "1M": "1M", "1w": "1w", "1d": "1d",
    "4h": "4h", "1h": "1h", "15m": "15m",
}


def _get(url: str, timeout: int = 30) -> Union[dict, list]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ── Pionex 標的快取（1 小時更新一次）────────────────────────────
_PIONEX_SYMS_CACHE: dict = {"ts": 0.0, "syms": set()}

def _fetch_pionex_symbols() -> set:
    """取得 Pionex 有上架的 base 幣集合（大寫），快取 1 小時。
    失敗時回傳空集合（呼叫方按空集合視為「不過濾」）。
    """
    global _PIONEX_SYMS_CACHE
    now = time.time()
    if now - _PIONEX_SYMS_CACHE["ts"] < 3600 and _PIONEX_SYMS_CACHE["syms"]:
        return _PIONEX_SYMS_CACHE["syms"]
    syms: set = set()
    for endpoint in (
        f"{PIONEX_BASE}/api/v1/common/symbols",
        f"{PIONEX_BASE}/api/v2/common/symbols",
    ):
        try:
            data  = _get(endpoint, timeout=8)
            items = (
                (data.get("data") or {}).get("symbols") or
                data.get("symbols") or []
            )
            for s in items:
                base  = s.get("baseCurrency") or s.get("base") or ""
                quote = s.get("quoteCurrency") or s.get("quote") or ""
                if str(quote).upper() == "USDT" and base:
                    syms.add(str(base).upper())
            if len(syms) >= 5:
                break   # 成功取得，跳出迴圈
        except Exception:
            continue
    if len(syms) >= 5:
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": syms}
    return syms


def _sym_binance(symbol: str) -> str:
    return symbol.replace("/", "").upper()


def _sym_bybit(symbol: str) -> str:
    return symbol.replace("/", "").upper()


def _sym_okx(symbol: str) -> str:
    # BTC/USDT → BTC-USDT
    return symbol.replace("/", "-").upper()


def _to_ms(date_str: str, end_of_day: bool = False) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    ms = int(dt.timestamp() * 1000)
    return ms + 86_400_000 - 1 if end_of_day else ms


def _make_df(rows: list, time_col=0, unit="ms") -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["time","open","high","low","close","volume"])
    df = pd.DataFrame(rows)
    df = df.iloc[:, :6].copy()
    df.columns = ["time","open","high","low","close","volume"]
    df["time"] = pd.to_datetime(df["time"].astype(float), unit=unit)
    for c in ["open","high","low","close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df.drop_duplicates("time").sort_values("time").reset_index(drop=True)


# ══════════════════════════════════════════════════════════════
#  Binance
# ══════════════════════════════════════════════════════════════
def _fetch_binance(symbol: str, timeframe: str,
                   start: Optional[str], end: Optional[str], limit: int,
                   max_candles: int = 3000) -> pd.DataFrame:
    sym = _sym_binance(symbol)
    tf  = TIMEFRAME_MAP.get(timeframe, "1d")

    if start is None and end is None:
        url = f"{BINANCE_BASE}/api/v3/klines?symbol={sym}&interval={tf}&limit={limit}"
        return _make_df(_get(url))

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    all_rows: list = []

    while True:
        params = {"symbol": sym, "interval": tf, "limit": 1000}
        if since:   params["startTime"] = since
        if end_ms:  params["endTime"]   = end_ms
        url   = f"{BINANCE_BASE}/api/v3/klines?{urllib.parse.urlencode(params)}"
        batch = _get(url)
        if not batch:
            break
        all_rows.extend(batch)
        last_ts = batch[-1][0]
        if (end_ms and last_ts >= end_ms) or len(batch) < 1000 or len(all_rows) >= max_candles:
            break
        since = last_ts + 1

    return _make_df(all_rows)


# ══════════════════════════════════════════════════════════════
#  Bybit
# ══════════════════════════════════════════════════════════════
def _fetch_bybit(symbol: str, timeframe: str,
                 start: Optional[str], end: Optional[str], limit: int,
                 max_candles: int = 3000) -> pd.DataFrame:
    sym = _sym_bybit(symbol)
    tf  = BYBIT_TF.get(timeframe, "D")

    if start is None and end is None:
        url = f"{BYBIT_BASE}/v5/market/kline?category=spot&symbol={sym}&interval={tf}&limit={limit}"
        data = _get(url)
        rows = data.get("result", {}).get("list", [])
        # Bybit 回傳順序為倒序
        rows = [[r[0],r[1],r[2],r[3],r[4],r[5]] for r in reversed(rows)]
        return _make_df(rows)

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    all_rows: list = []
    cursor = end_ms

    while True:
        params = {"category": "spot", "symbol": sym, "interval": tf, "limit": 1000}
        if cursor: params["end"]   = cursor
        if since:  params["start"] = since
        url   = f"{BYBIT_BASE}/v5/market/kline?{urllib.parse.urlencode(params)}"
        data  = _get(url)
        batch = data.get("result", {}).get("list", [])
        if not batch:
            break
        rows = [[r[0],r[1],r[2],r[3],r[4],r[5]] for r in reversed(batch)]
        all_rows = rows + all_rows
        first_ts = int(batch[-1][0])
        if since and first_ts <= since:
            break
        if len(batch) < 1000 or len(all_rows) >= max_candles:
            break
        cursor = first_ts - 1

    return _make_df(all_rows)


# ══════════════════════════════════════════════════════════════
#  OKX
# ══════════════════════════════════════════════════════════════
def _fetch_okx(symbol: str, timeframe: str,
               start: Optional[str], end: Optional[str], limit: int,
               max_candles: int = 3000) -> pd.DataFrame:
    sym = _sym_okx(symbol)
    tf  = OKX_TF.get(timeframe, "1D")

    if start is None and end is None:
        url  = f"{OKX_BASE}/api/v5/market/candles?instId={sym}&bar={tf}&limit={limit}"
        data = _get(url)
        rows = [[r[0],r[1],r[2],r[3],r[4],r[5]] for r in reversed(data.get("data", []))]
        return _make_df(rows)

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    all_rows: list = []
    after = end_ms

    while True:
        params = {"instId": sym, "bar": tf, "limit": 300}
        if after: params["after"]  = after
        if since: params["before"] = since
        url   = f"{OKX_BASE}/api/v5/market/history-candles?{urllib.parse.urlencode(params)}"
        data  = _get(url)
        batch = data.get("data", [])
        if not batch:
            break
        rows = [[r[0],r[1],r[2],r[3],r[4],r[5]] for r in reversed(batch)]
        all_rows = rows + all_rows
        first_ts = int(batch[-1][0])
        if since and first_ts <= since:
            break
        if len(batch) < 300 or len(all_rows) >= max_candles:
            break
        after = first_ts - 1

    return _make_df(all_rows)


# ══════════════════════════════════════════════════════════════
#  公開介面
# ══════════════════════════════════════════════════════════════
def fetch_crypto_ohlcv(
    symbol: str,
    timeframe: str = "1d",
    start: str = None,
    end: str = None,
    exchange_id: str = "pionex",
    limit: int = 1000,
    api_key: str = "",
    api_secret: str = "",
) -> pd.DataFrame:
    # 去除永續合約後綴 .P（前端顯示用，後端統一用現貨代號查詢）
    if symbol.upper().endswith(".P"):
        symbol = symbol[:-2]
    ex = exchange_id.lower()
    if ex in ("pionex", "binance"):
        return _fetch_binance(symbol, timeframe, start, end, limit)
    elif ex == "bybit":
        return _fetch_bybit(symbol, timeframe, start, end, limit)
    elif ex == "okx":
        return _fetch_okx(symbol, timeframe, start, end, limit)
    else:
        raise ValueError(f"不支援的交易所: {exchange_id}")


def fetch_crypto_markets(exchange_id: str = "pionex"):
    """取得 USDT 現貨交易對（只回傳前 200 筆）"""
    ex = exchange_id.lower()
    try:
        if ex in ("pionex", "binance"):
            data = _get(f"{BINANCE_BASE}/api/v3/exchangeInfo")
            pionex_syms = _fetch_pionex_symbols() if ex == "pionex" else set()
            results = [
                {"symbol": f"{s['baseAsset']}/{s['quoteAsset']}",
                 "base": s["baseAsset"], "quote": s["quoteAsset"]}
                for s in data.get("symbols", [])
                if s.get("status") == "TRADING" and s.get("quoteAsset") == "USDT"
                   and s.get("isSpotTradingAllowed")
                   and (not pionex_syms or s["baseAsset"].upper() in pionex_syms)
            ]
        elif ex == "bybit":
            data = _get(f"{BYBIT_BASE}/v5/market/instruments-info?category=spot")
            results = [
                {"symbol": f"{s['baseCoin']}/{s['quoteCoin']}",
                 "base": s["baseCoin"], "quote": s["quoteCoin"]}
                for s in data.get("result", {}).get("list", [])
                if s.get("quoteCoin") == "USDT" and s.get("status") == "Trading"
            ]
        elif ex == "okx":
            data = _get(f"{OKX_BASE}/api/v5/public/instruments?instType=SPOT")
            results = [
                {"symbol": f"{s['baseCcy']}/{s['quoteCcy']}",
                 "base": s["baseCcy"], "quote": s["quoteCcy"]}
                for s in data.get("data", [])
                if s.get("quoteCcy") == "USDT" and s.get("state") == "live"
            ]
        else:
            results = []
    except Exception:
        results = []
    return results[:200]


def fetch_tickers(market: str = "futures") -> list:
    """取得即時 24h 漲跌幅排行（全部 USDT 交易對）。
    統一使用 Binance spot API，回傳所有 USDT 現貨交易對，依漲跌幅排序。
    """
    try:
        data = _get(f"{BINANCE_BASE}/api/v3/ticker/24hr")
        tickers = []
        for t in data:
            sym = t.get("symbol", "")
            if not sym.endswith("USDT") or "_" in sym:
                continue
            try:
                base = sym[:-4]
                entry = {
                    "symbol":     sym,
                    "price":      float(t["lastPrice"]),
                    "change_pct": float(t["priceChangePercent"]),
                    "volume":     float(t.get("quoteVolume", 0)),
                }
                if market == "futures":
                    entry["display"] = base + "/USDT.P"
                    entry["spot"]    = base + "/USDT"
                else:
                    entry["display"] = base + "/USDT"
                tickers.append(entry)
            except (KeyError, ValueError):
                continue

        # ── 只保留 Pionex 有上架的標的 ──────────────────────────
        pionex_syms = _fetch_pionex_symbols()
        if pionex_syms:
            # Pionex API 成功：嚴格過濾
            tickers = [t for t in tickers if t["symbol"][:-4].upper() in pionex_syms]
        else:
            # Pionex API 失敗：退而取成交量前 200（覆蓋 Pionex 幾乎所有上架幣）
            tickers.sort(key=lambda x: x["volume"], reverse=True)
            tickers = tickers[:200]

        # 依漲跌幅排序回傳
        tickers.sort(key=lambda x: x["change_pct"], reverse=True)
        return tickers
    except Exception:
        return []
