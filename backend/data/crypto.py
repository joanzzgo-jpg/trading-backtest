"""
加密貨幣資料抓取 — 直接呼叫 Binance REST API（無需 ccxt）
Pionex 使用 Binance 流動性，行情相同；Bybit / OKX 也各自實作。
"""
import json
import time
import urllib.request
import urllib.parse
import pandas as pd
from datetime import datetime, timezone, timedelta
from typing import Union, Optional

# ── Binance（含 Pionex）────────────────────────────────────────
BINANCE_BASE      = "https://api.binance.com"
BINANCE_FAPI_BASE = "https://fapi.binance.com"  # 永續合約
PIONEX_BASE       = "https://api.pionex.com"

# ── Bybit ─────────────────────────────────────────────────────
BYBIT_BASE   = "https://api.bybit.com"
BYBIT_TF = {
    "1M": "M", "1w": "W", "1d": "D",
    "4h": "240", "1h": "60", "15m": "15", "5m": "5",
}

# ── OKX ───────────────────────────────────────────────────────
OKX_BASE  = "https://www.okx.com"
OKX_TF = {
    "1M": "1M", "1w": "1W", "1d": "1D",
    "4h": "4H", "1h": "1H", "15m": "15m", "5m": "5m",
}

TIMEFRAME_MAP = {
    "1M": "1M", "1w": "1w", "1d": "1d",
    "4h": "4h", "1h": "1h", "15m": "15m", "5m": "5m",
}


def _get(url: str, timeout: int = 30) -> Union[dict, list]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ── Pionex 已知合約（硬編碼備援，API 失敗時使用）────────────────
# 來源：Pionex 官網合約列表（2025 年常見永續合約）
PIONEX_PERP_FALLBACK: set = {
    "BTC","ETH","BNB","SOL","XRP","ADA","DOGE","AVAX","DOT","MATIC",
    "LINK","UNI","LTC","ATOM","ETC","NEAR","FTM","OP","ARB","INJ",
    "SUI","APT","TIA","BONK","WIF","PEPE","SHIB","TRX","SAND","MANA",
    "AXS","GALA","APE","RUNE","THETA","VET","XLM","ALGO","FIL","AAVE",
    "COMP","SNX","MKR","CRV","LDO","DYDX","GMX","BLUR","PENDLE","SEI",
    "PYTH","JUP","STRK","MANTA","ALT","PIXEL","PORTAL","SAGA","OMNI",
    "ENA","W","TON","NOT","IO","ZK","BLAST","POL","EIGEN","SCR","CATI",
    "HMSTR","NEIRO","MOODENG","GOAT","ACT","PNUT","KAIA","SWELL","1INCH",
    "SUSHI","YFI","BAT","ZRX","ENJ","CHZ","FLOW","ROSE","ONE","QTUM",
    "ICX","ZIL","ONT","IOTA","XTZ","NEO","DASH","ZEC","EOS","TRX",
    "WLD","RNDR","FET","AGIX","OCEAN","GRT","API3","BAND","LUNA","LUNC",
    "CAKE","GMT","GST","STEPN","HIGH","LAZIO","PORTO","SANTOS","ACH",
    "HOOK","MAGIC","LOOKS","IMX","BLUR","NFP","AI","XAI","MANTA","ALT",
    "JTO","PYTH","BONK","WIF","BOME","ETHFI","AEVO","SAGA","OMNI","REZ",
    "BB","NOT","IO","ZK","LISTA","ZRO","RENDER","METH","SLF",
}

# ── Pionex 合約快取（分開快取現貨與永續）────────────────────────
_PIONEX_SYMS_CACHE:      dict = {"ts": 0.0, "syms": None}   # spot
_PIONEX_PERP_SYMS_CACHE: dict = {"ts": 0.0, "syms": None}   # futures/PERP


def _fetch_pionex_perp_symbols() -> set:
    """取得 Pionex 永續合約 base 幣集合（大寫），快取 1 小時。
    使用官方 PERP API：GET /api/v1/common/symbols?type=PERP
    API 失敗時回傳 PIONEX_PERP_FALLBACK 備援清單。
    """
    global _PIONEX_PERP_SYMS_CACHE
    now = time.time()
    cached = _PIONEX_PERP_SYMS_CACHE
    if now - cached["ts"] < 3600 and cached["syms"] is not None:
        return cached["syms"]

    syms: set = set()
    try:
        data  = _get(f"{PIONEX_BASE}/api/v1/common/symbols?type=PERP", timeout=10)
        items = (data.get("data") or {}).get("symbols") or []
        for s in items:
            base = s.get("baseAsset") or s.get("baseCurrency") or s.get("base") or ""
            # symbol 格式如 BTC_USDT_PERP，也嘗試從 symbol 解析
            if not base:
                sym_str = s.get("symbol", "")
                base = sym_str.split("_")[0] if "_" in sym_str else ""
            if base:
                syms.add(str(base).upper())
    except Exception:
        pass

    if len(syms) >= 5:
        _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": syms}
        return syms

    # API 失敗 → 使用硬編碼備援（不快取，下次仍重試 API）
    return PIONEX_PERP_FALLBACK


def _fetch_pionex_symbols() -> set:
    """取得 Pionex 現貨 base 幣集合（大寫），快取 1 小時。
    API 全失敗時回傳空集合。
    """
    global _PIONEX_SYMS_CACHE
    now = time.time()
    if now - _PIONEX_SYMS_CACHE["ts"] < 3600 and _PIONEX_SYMS_CACHE["syms"] is not None:
        return _PIONEX_SYMS_CACHE["syms"]
    syms: set = set()
    for endpoint in (
        f"{PIONEX_BASE}/api/v1/common/symbols",
        f"{PIONEX_BASE}/api/v2/common/symbols",
    ):
        try:
            data  = _get(endpoint, timeout=8)
            items = (data.get("data") or {}).get("symbols") or data.get("symbols") or []
            for s in items:
                base  = s.get("baseCurrency") or s.get("base") or ""
                quote = s.get("quoteCurrency") or s.get("quote") or ""
                if str(quote).upper() == "USDT" and base:
                    syms.add(str(base).upper())
            if len(syms) >= 5:
                break
        except Exception:
            continue
    if len(syms) >= 5:
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": syms}
        return syms
    return set()


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


_TF_BARS_PER_DAY = {
    "1M": 1/30, "1w": 1/7, "1d": 1,
    "4h": 6, "1h": 24, "15m": 96, "5m": 288,
}
_TF_BAR_SECONDS = {
    "1M": 2592000, "1w": 604800, "1d": 86400,
    "4h": 14400,   "1h": 3600,   "15m": 900, "5m": 300,
}
# 各時間級別的合理上限（根數），避免 API 請求過多
# 注意：fetcher 是「FROM start 往前 paginate 直到撞 cap」，所以 cap 必須 ≥ TF_MAX × bars/day
# 否則資料會在 start+cap 提早結束（不到 end），造成最近幾天無訊號
_TF_MAX_CANDLES = {
    "1M":   500,
    "1w":   800,
    "1d":   7500,    # 1d:  TF_MAX 5475 天 → cap 至少 5475
    "4h":   30000,   # 4h:  TF_MAX 3650 天 × 6 bars = 21900
    "1h":   50000,   # 1h:  TF_MAX 1825 天 × 24 bars = 43800
    "15m":  40000,   # 15m: TF_MAX 365 天 × 96 bars = 35040
    "5m":   30000,   # 5m:  TF_MAX 90 天 × 288 bars = 25920
}

def _calc_max_candles(start: Optional[str], end: Optional[str], timeframe: str) -> int:
    """根據日期範圍與時間級別計算所需根數，避免截斷歷史資料。"""
    tf_cap = _TF_MAX_CANDLES.get(timeframe, 5000)
    if not start or not end:
        return tf_cap
    try:
        from datetime import datetime as _dt
        days = max(1, (_dt.strptime(end, "%Y-%m-%d") - _dt.strptime(start, "%Y-%m-%d")).days + 1)
        needed = int(days * _TF_BARS_PER_DAY.get(timeframe, 1) * 1.05) + 50
        return min(needed, tf_cap)
    except Exception:
        return tf_cap


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
#  Binance Futures (fapi) — 永續合約 K 線
# ══════════════════════════════════════════════════════════════
def _fetch_binance_fapi(symbol: str, timeframe: str,
                        start: Optional[str], end: Optional[str], limit: int,
                        max_candles: int = 3000) -> pd.DataFrame:
    """使用 fapi.binance.com 取得永續合約 K 線，失敗時拋出例外由呼叫方 fallback"""
    sym = _sym_binance(symbol)
    tf  = TIMEFRAME_MAP.get(timeframe, "1d")

    if start is None and end is None:
        url = f"{BINANCE_FAPI_BASE}/fapi/v1/klines?symbol={sym}&interval={tf}&limit={limit}"
        return _make_df(_get(url, timeout=10))

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    all_rows: list = []

    while True:
        params = {"symbol": sym, "interval": tf, "limit": 1000}
        if since:   params["startTime"] = since
        if end_ms:  params["endTime"]   = end_ms
        url   = f"{BINANCE_FAPI_BASE}/fapi/v1/klines?{urllib.parse.urlencode(params)}"
        batch = _get(url, timeout=10)
        if not batch:
            break
        all_rows.extend(batch)
        last_ts = batch[-1][0]
        if (end_ms and last_ts >= end_ms) or len(batch) < 1000 or len(all_rows) >= max_candles:
            break
        since = last_ts + 1

    return _make_df(all_rows)


def _fetch_futures_tickers_fapi() -> list:
    """從 fapi.binance.com 取得永續合約 24h 行情，失敗回傳空串列"""
    try:
        data = _get(f"{BINANCE_FAPI_BASE}/fapi/v1/ticker/24hr", timeout=10)
        tickers = []
        for t in data:
            sym = t.get("symbol", "")
            if not sym.endswith("USDT"):
                continue
            try:
                base = sym[:-4]
                tickers.append({
                    "symbol":     sym,
                    "price":      float(t["lastPrice"]),
                    "change_pct": float(t["priceChangePercent"]),
                    "change_amt": float(t.get("priceChange", 0)),
                    "volume":     float(t.get("quoteVolume", 0)),
                    "display":    base + "/USDT.P",
                    "spot":       base + "/USDT",
                })
            except (KeyError, ValueError):
                continue
        return tickers
    except Exception:
        return []


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
#  Pionex native klines
# ══════════════════════════════════════════════════════════════
# Pionex klines interval 格式（實測：大寫縮寫，1h=60M；1w/1M 不支援）
PIONEX_TF_MAP = {
    "1M": None, "1w": None, "1d": "1D",
    "4h": "4H", "1h": "60M", "15m": "15M", "5m": "5M",
}


def _fetch_pionex_klines(symbol: str, timeframe: str,
                          start: Optional[str], end: Optional[str], limit: int,
                          max_candles: int = 3000, is_perp: bool = False) -> pd.DataFrame:
    """Pionex 自有 K 線 API，支援 Pionex 獨有合約（不在 Binance fapi 上的）"""
    tf = PIONEX_TF_MAP.get(timeframe)
    if tf is None:
        return pd.DataFrame(columns=["time","open","high","low","close","volume"])
    sym = symbol.replace("/", "_").upper()
    if is_perp and not sym.endswith("_PERP"):
        sym += "_PERP"

    # limit-only mode → 換算成時間範圍，部分 Pionex API 對純 limit 請求回傳異常
    if start is None and end is None:
        now_dt    = datetime.now(timezone.utc)
        bar_secs  = _TF_BAR_SECONDS.get(timeframe, 86400)
        start_dt  = now_dt - timedelta(seconds=int(limit * bar_secs * 1.1) + bar_secs)
        start = start_dt.strftime("%Y-%m-%d")
        end   = now_dt.strftime("%Y-%m-%d")

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    # Pionex 不接受未來的 endTime，限制在當前時間
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    if end_ms and end_ms > now_ms:
        end_ms = now_ms
    all_rows: list = []

    while True:
        params2: dict = {"symbol": sym, "interval": tf, "limit": 500}
        if since:  params2["startTime"] = since
        if end_ms: params2["endTime"]   = end_ms
        url  = f"{PIONEX_BASE}/api/v1/market/klines?{urllib.parse.urlencode(params2)}"
        data = _get(url, timeout=10)
        if not data.get("result", True):
            break  # Pionex 明確回傳失敗，停止重試
        klines = (data.get("data") or {}).get("klines") or []
        if not klines:
            break
        rows = []
        for k in klines:
            try:
                rows.append([int(k["time"]), k["open"], k["high"], k["low"], k["close"], k.get("volume", k.get("amount", 0))])
            except (KeyError, TypeError):
                continue
        if not rows:
            break
        all_rows.extend(rows)
        last_ts = rows[-1][0]
        if (end_ms and last_ts >= end_ms) or len(klines) < 500 or len(all_rows) >= max_candles:
            break
        since = last_ts + 1

    return _make_df(all_rows)


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
    # 去除永續合約後綴 .P（前端顯示用），並記錄是否為永續合約
    is_perp = symbol.upper().endswith(".P")
    if is_perp:
        symbol = symbol[:-2]
    ex = exchange_id.lower()

    # limit 超過 1000 時換算成時間範圍（Binance 單次請求上限 1500，統一用分頁安全）
    if limit > 1000 and not start and not end:
        now_dt   = datetime.now(timezone.utc)
        bar_secs = _TF_BAR_SECONDS.get(timeframe, 86400)
        end   = now_dt.strftime("%Y-%m-%d")
        start = (now_dt - timedelta(seconds=int(limit * bar_secs * 1.05))).strftime("%Y-%m-%d")

    # 若日期範圍超過 cap，把 start 往後移到 end - cap×bar_duration
    # 確保永遠抓到最新的資料，而非從太久之前截斷
    if start and end:
        bar_secs = _TF_BAR_SECONDS.get(timeframe, 86400)
        cap = _TF_MAX_CANDLES.get(timeframe, 5000)
        try:
            end_dt   = datetime.strptime(end, "%Y-%m-%d")
            min_start = end_dt - timedelta(seconds=int(cap * bar_secs * 1.02))
            if datetime.strptime(start, "%Y-%m-%d") < min_start:
                start = min_start.strftime("%Y-%m-%d")
        except Exception:
            pass

    mc = _calc_max_candles(start, end, timeframe)
    if ex in ("pionex", "binance"):
        # Binance 優先（歷史深、穩定）：永續合約 → 現貨
        try:
            df = _fetch_binance_fapi(symbol, timeframe, start, end, limit, max_candles=mc)
            if not df.empty:
                return df
        except Exception:
            pass
        try:
            df = _fetch_binance(symbol, timeframe, start, end, limit, max_candles=mc)
            if not df.empty:
                return df
        except Exception:
            pass
        # Pionex 獨有合約（不在 Binance 上）→ 走 Pionex 自己的 klines 作為最後備援
        if ex == "pionex":
            try:
                df = _fetch_pionex_klines(symbol, timeframe, start, end, limit, max_candles=mc, is_perp=is_perp)
                if not df.empty:
                    return df
            except Exception:
                pass
        raise ValueError(f"找不到 {symbol} 的行情資料，請確認標的代號是否正確")
    elif ex == "bybit":
        return _fetch_bybit(symbol, timeframe, start, end, limit, max_candles=mc)
    elif ex == "okx":
        return _fetch_okx(symbol, timeframe, start, end, limit, max_candles=mc)
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


def _apply_pionex_perp_filter(tickers: list) -> list:
    """依 Pionex 永續合約清單過濾；API 失敗時使用硬編碼備援"""
    pionex_syms = _fetch_pionex_perp_symbols()
    return [t for t in tickers if t["symbol"][:-4].upper() in pionex_syms]


def _apply_pionex_filter(tickers: list) -> list:
    """依 Pionex 現貨標的清單過濾；API 失敗（空集合）時不過濾"""
    pionex_syms = _fetch_pionex_symbols()
    if not pionex_syms:
        return tickers
    return [t for t in tickers if t["symbol"][:-4].upper() in pionex_syms]


def fetch_tickers(market: str = "futures") -> list:
    """從 Pionex API 取得即時 24h 行情；失敗時 futures 改用 Binance FAPI 備援。"""
    type_param = "PERP" if market == "futures" else ""
    url = f"{PIONEX_BASE}/api/v1/market/tickers"
    if type_param:
        url += f"?type={type_param}"
    try:
        data = _get(url, timeout=10)
        raw = data.get("data", {}).get("tickers", [])
        tickers = []
        for t in raw:
            sym = t.get("symbol", "")
            if market == "futures":
                if not sym.endswith("_USDT_PERP"):
                    continue
                base = sym[: -len("_USDT_PERP")]
                display = base + "/USDT.P"
                spot    = base + "/USDT"
            else:
                if not sym.endswith("_USDT"):
                    continue
                # 排除含底線的複合標的（如 BTC_ETH_USDT）
                if "_" in sym[: -len("_USDT")]:
                    continue
                base    = sym[: -len("_USDT")]
                display = base + "/USDT"
                spot    = display
            try:
                open_  = float(t["open"])
                close  = float(t["close"])
                change_pct = (close - open_) / open_ * 100 if open_ else 0.0
                tickers.append({
                    "symbol":     sym,
                    "display":    display,
                    "spot":       spot,
                    "price":      close,
                    "change_pct": round(change_pct, 2),
                    "change_amt": round(close - open_, 8),
                    "volume":     float(t.get("amount", 0)),
                })
            except (KeyError, ValueError):
                continue
        if tickers:
            tickers.sort(key=lambda x: x["change_pct"], reverse=True)
            return tickers
    except Exception:
        pass
    # Pionex 失敗 → Binance FAPI 備援（僅合約）
    if market == "futures":
        tickers = _fetch_futures_tickers_fapi()
        if tickers:
            tickers.sort(key=lambda x: x["change_pct"], reverse=True)
            return tickers
    return []
