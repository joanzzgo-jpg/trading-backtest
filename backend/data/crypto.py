"""
加密貨幣資料抓取 — 直接呼叫 Binance REST API（無需 ccxt）
Pionex 使用 Binance 流動性，行情相同；Bybit / OKX 也各自實作。
"""
import json
import os
import time
import urllib.request
import urllib.parse
import urllib.error
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
    "4h": "240", "2h": "120", "1h": "60", "15m": "15", "5m": "5",
}

# ── OKX ───────────────────────────────────────────────────────
OKX_BASE  = "https://www.okx.com"
OKX_TF = {
    "1M": "1M", "1w": "1W", "1d": "1D",
    "8h": "8H", "4h": "4H", "2h": "2H", "1h": "1H",
    "30m": "30m", "15m": "15m", "5m": "5m",
}

TIMEFRAME_MAP = {
    "1M": "1M", "1w": "1w", "1d": "1d",
    "8h": "8h", "4h": "4h", "2h": "2h", "1h": "1h",
    "30m": "30m", "15m": "15m", "5m": "5m",
}


def _get(url: str, timeout: int = 30) -> Union[dict, list]:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ── Pionex 全域熔斷 ────────────────────────────────────────────
# Pionex 429 規則：封鎖 60s，且封鎖期間「每多打一次 +10s」→ 持續重試會讓封鎖永遠清不掉。
# 對策：任一 Pionex 呼叫吃到 429，就觸發 5 分鐘全域冷卻，期間所有 Pionex 呼叫直接跳過（不再戳它），
# 讓封鎖窗口能真正過完。呼叫端本來就有 fallback / stale-serve，熔斷期間自動降級不會壞。
_PIONEX_COOLDOWN_UNTIL = 0.0
_PIONEX_COOLDOWN_SECS   = 300

import threading as _threading
# 同時最多 3 個 Pionex 請求（Pionex 限制 10 req/s，留餘裕）。
# 不再用 lock + sleep 序列化 — 那會讓單次請求內的深度分頁卡 17s+。
# 改用 Semaphore：併發抓但限總量，內部分頁可一起跑，整體快 ~3x。
_PIONEX_SEM = _threading.Semaphore(3)

def _pionex_get(url: str, timeout: int = 30) -> Union[dict, list]:
    """Pionex 專用 GET：併發上限 3 + 429 熔斷保護。"""
    global _PIONEX_COOLDOWN_UNTIL
    if time.time() < _PIONEX_COOLDOWN_UNTIL:
        raise RuntimeError("Pionex 熔斷中（429 冷卻），暫不請求")
    with _PIONEX_SEM:
        try:
            return _get(url, timeout=timeout)
        except urllib.error.HTTPError as e:
            if getattr(e, "code", None) == 429:
                _PIONEX_COOLDOWN_UNTIL = time.time() + _PIONEX_COOLDOWN_SECS
            raise


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

# ── Pionex 標的清單「硬碟快取」：24hr 內讀檔、完全不打 Pionex；過期才抓一次寫回。
# 重啟也直接讀檔不重抓 → Pionex 一天約被呼叫 1 次，徹底避開 10/秒限流。
_PIONEX_CACHE_FILE = os.path.join(os.path.dirname(__file__), ".pionex_syms_cache.json")
_PIONEX_DISK_TTL   = 86400   # 24 小時

def _load_disk_syms(key: str):
    """讀硬碟清單快取。回傳 (set, age_seconds)；無/壞檔回 (None, None)。"""
    try:
        with open(_PIONEX_CACHE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        entry = d.get(key)
        if entry and entry.get("syms"):
            return set(entry["syms"]), time.time() - float(entry.get("ts", 0))
    except Exception:
        pass
    return None, None

def _save_disk_syms(key: str, syms: set):
    """把成功抓到的清單寫硬碟（合併現有，不動另一個 key）。"""
    try:
        d = {}
        try:
            with open(_PIONEX_CACHE_FILE, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            d = {}
        d[key] = {"syms": sorted(syms), "ts": time.time()}
        with open(_PIONEX_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(d, f)
    except Exception:
        pass


def _fetch_pionex_perp_symbols() -> set:
    """取得 Pionex 永續合約 base 幣集合（大寫），快取 1 小時。
    使用官方 PERP API：GET /api/v1/common/symbols?type=PERP
    API 失敗時回傳 PIONEX_PERP_FALLBACK 備援清單。
    """
    global _PIONEX_PERP_SYMS_CACHE
    now = time.time()
    cached = _PIONEX_PERP_SYMS_CACHE
    # 成功快取 1hr；失敗（429）退避 5 分鐘（負快取）。Pionex 429 會封鎖 60s 且「期間每多打一次
    # +10s」，60s 重試會一直戳到封鎖、永遠清不掉 → 拉長到 300s 讓封鎖窗口過完、靠 stale-serve 撐住。
    _ttl = 300 if cached.get("fallback") else 3600
    if now - cached["ts"] < _ttl and cached["syms"] is not None:
        return cached["syms"]

    # 先讀硬碟：24hr 內就用硬碟，完全不打 Pionex
    disk_syms, age = _load_disk_syms("perp")
    if disk_syms and age is not None and age < _PIONEX_DISK_TTL:
        _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": disk_syms, "fallback": False}
        return disk_syms

    syms: set = set()
    try:
        data  = _pionex_get(f"{PIONEX_BASE}/api/v1/common/symbols?type=PERP", timeout=10)
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
        _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": syms, "fallback": False}
        _save_disk_syms("perp", syms)
        return syms

    # API 失敗（429）→ stale-serve：記憶體上次成功 → 硬碟(即使過期) → 硬編碼備援；退避 5 分鐘
    prev = cached.get("syms")
    if prev and not cached.get("fallback"):
        _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": prev, "fallback": True}
        return prev
    if disk_syms:
        _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": disk_syms, "fallback": True}
        return disk_syms
    _PIONEX_PERP_SYMS_CACHE = {"ts": now, "syms": PIONEX_PERP_FALLBACK, "fallback": True}
    return PIONEX_PERP_FALLBACK


def _fetch_pionex_symbols() -> set:
    """取得 Pionex 現貨 base 幣集合（大寫），快取 1 小時。
    API 全失敗時回傳空集合。
    """
    global _PIONEX_SYMS_CACHE
    now = time.time()
    # 成功快取 1hr；失敗（429）退避 5 分鐘（負快取）。理由同 perp：60s 重試會一直戳到 Pionex
    # 封鎖（429 期間每多打一次 +10s）導致永遠清不掉 → 300s 讓封鎖過完，期間靠 stale-serve 撐住。
    _ttl = 300 if _PIONEX_SYMS_CACHE.get("fallback") else 3600
    if now - _PIONEX_SYMS_CACHE["ts"] < _ttl and _PIONEX_SYMS_CACHE["syms"] is not None:
        return _PIONEX_SYMS_CACHE["syms"]
    # 先讀硬碟：24hr 內就用硬碟，完全不打 Pionex
    disk_syms, age = _load_disk_syms("spot")
    if disk_syms and age is not None and age < _PIONEX_DISK_TTL:
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": disk_syms, "fallback": False}
        return disk_syms
    syms: set = set()
    for endpoint in (
        f"{PIONEX_BASE}/api/v1/common/symbols",
        f"{PIONEX_BASE}/api/v2/common/symbols",
    ):
        try:
            data  = _pionex_get(endpoint, timeout=8)
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
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": syms, "fallback": False}
        _save_disk_syms("spot", syms)
        return syms
    # API 全失敗（429）→ stale-serve：記憶體上次成功 → 硬碟(即使過期) → 空集合；退避 5 分鐘
    prev = _PIONEX_SYMS_CACHE.get("syms")
    if prev:
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": prev, "fallback": True}
        return prev
    if disk_syms:
        _PIONEX_SYMS_CACHE = {"ts": now, "syms": disk_syms, "fallback": True}
        return disk_syms
    _PIONEX_SYMS_CACHE = {"ts": now, "syms": set(), "fallback": True}   # 從未成功過 → 空集合
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
    "8h": 3, "4h": 6, "2h": 12, "1h": 24,
    "30m": 48, "15m": 96, "5m": 288,
}
_TF_BAR_SECONDS = {
    "1M": 2592000, "1w": 604800, "1d": 86400,
    "8h": 28800,   "4h": 14400,   "2h": 7200,   "1h": 3600,
    "30m": 1800,   "15m": 900,    "5m": 300,
}
# 各時間級別的合理上限（根數），避免 API 請求過多
# 注意：fetcher 是「FROM start 往前 paginate 直到撞 cap」，所以 cap 必須 ≥ TF_MAX × bars/day
# 否則資料會在 start+cap 提早結束（不到 end），造成最近幾天無訊號
_TF_MAX_CANDLES = {
    "1M":   500,
    "1w":   1200,    # 1w: TF_MAX 7300 天 / 7 = 1043
    "1d":   10000,   # 1d: TF_MAX 7300 天
    "8h":   20000,   # 8h: TF_MAX 5475 天 × 3 bars = 16425
    "4h":   40000,   # 4h: TF_MAX 5475 天 × 6 bars = 32850
    "2h":   55000,   # 2h: TF_MAX 4380 天 × 12 bars = 52560
    "1h":   80000,   # 1h: TF_MAX 2920 天 × 24 bars = 70080
    "30m":  35000,   # 30m: TF_MAX 720 天 × 48 bars = 34560
    "15m":  75000,   # 15m: TF_MAX 720 天 × 96 bars = 69120
    "5m":   55000,   # 5m: TF_MAX 180 天 × 288 bars = 51840
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
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    if end_ms and end_ms > now_ms:
        end_ms = now_ms
    if since is None:
        since = now_ms - max_candles * _TF_BAR_SECONDS.get(timeframe, 86400) * 1000
    if end_ms is None:
        end_ms = now_ms

    # 並行分段抓取（與 fapi 共用）；spot 單頁上限 1000
    return _fetch_binance_klines_parallel(
        f"{BINANCE_BASE}/api/v3/klines", sym, tf, since, end_ms, timeframe, max_candles, page=1000)


# ══════════════════════════════════════════════════════════════
#  Binance Futures (fapi) — 永續合約 K 線
# ══════════════════════════════════════════════════════════════
def _fetch_binance_fapi(symbol: str, timeframe: str,
                        start: Optional[str], end: Optional[str], limit: int,
                        max_candles: int = 3000) -> pd.DataFrame:
    """使用 fapi.binance.com 取得永續合約 K 線，失敗時拋出例外由呼叫方 fallback。
    大範圍改用「並行分段抓取」（把時間切成多個 window 同時打），比循序快數倍。"""
    sym = _sym_binance(symbol)
    tf  = TIMEFRAME_MAP.get(timeframe, "1d")

    if start is None and end is None:
        url = f"{BINANCE_FAPI_BASE}/fapi/v1/klines?symbol={sym}&interval={tf}&limit={limit}"
        return _make_df(_get(url, timeout=10))

    since  = _to_ms(start) if start else None
    end_ms = _to_ms(end, end_of_day=True) if end else None
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    if end_ms and end_ms > now_ms:
        end_ms = now_ms
    if since is None:
        since = now_ms - max_candles * _TF_BAR_SECONDS.get(timeframe, 86400) * 1000
    if end_ms is None:
        end_ms = now_ms

    df = _fetch_binance_klines_parallel(
        f"{BINANCE_FAPI_BASE}/fapi/v1/klines", sym, tf, since, end_ms, timeframe, max_candles)
    return df


# Binance klines 單頁上限 1500（fapi/spot 皆然）
_BINANCE_PAGE = 1500


def _fetch_binance_klines_parallel(base_url, sym, tf, since_ms, end_ms, timeframe, max_candles,
                                   page=_BINANCE_PAGE):
    """把 [since, end] 依「每頁 page 根」切成多個 window，用 ThreadPool 同時抓。
    Binance klines 接受 startTime+endTime+limit，每 window 自包含、可平行。
    page：單頁上限——合約(fapi) 1500、現貨(spot) 1000（spot 給 1500 也只回 1000，
    window 步進須等於實際頁數，否則會出現缺口）。"""
    from concurrent.futures import ThreadPoolExecutor
    bar_ms  = _TF_BAR_SECONDS.get(timeframe, 86400) * 1000
    page_ms = page * bar_ms

    windows = []
    s = since_ms
    while s < end_ms and len(windows) * page < max_candles:
        e = min(s + page_ms - bar_ms, end_ms)
        windows.append((s, e))
        s = e + bar_ms
    if not windows:
        return _make_df([])

    def _fetch_window(w):
        ws, we = w
        url = f"{base_url}?symbol={sym}&interval={tf}&startTime={ws}&endTime={we}&limit={page}"
        try:
            return _get(url, timeout=10)
        except Exception:
            return []

    all_rows: list = []
    # 第一個 window 先單獨打——失敗就拋例外（讓 caller fallback 到別的來源）
    first = _fetch_window(windows[0])
    if first is None:
        first = []
    all_rows.extend(first)
    if len(windows) > 1:
        # worker 數依 window 數動態調整（上限 8）。實測 Binance 對單 IP 並發有甜蜜點：
        # 4 太少、16 反被降速，8 最快 → 上限 8 兼顧速度與避免限流。
        _workers = min(8, max(4, len(windows) - 1))
        with ThreadPoolExecutor(max_workers=_workers) as pool:
            for batch in pool.map(_fetch_window, windows[1:]):
                if batch:
                    all_rows.extend(batch)

    if not all_rows:
        return _make_df([])
    # 去重（window 邊界可能重疊）+ 依時間排序
    seen = set()
    uniq = []
    for r in sorted(all_rows, key=lambda x: x[0]):
        if r[0] in seen:
            continue
        seen.add(r[0])
        uniq.append(r)
    # 超過上限時保留「最近」max_candles 根（不是最舊的）→ 避免最近幾根 K 被砍掉沒訊號
    if len(uniq) > max_candles:
        uniq = uniq[-max_candles:]
    return _make_df(uniq)


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
                    "open":       float(t.get("openPrice", 0)),   # 24h 開盤，給每秒重算漲跌幅
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
    "8h": "8H", "4h": "4H", "1h": "60M",
    "30m": "30M", "15m": "15M", "5m": "5M",
    # 2h: Pionex API 不支援原生 2H，由 _fetch_pionex_klines 內部抓 1H 重採樣
    "2h": "_RESAMPLE_FROM_1H",
}


def _fetch_pionex_klines(symbol: str, timeframe: str,
                          start: Optional[str], end: Optional[str], limit: int,
                          max_candles: int = 3000, is_perp: bool = False) -> pd.DataFrame:
    """Pionex 自有 K 線 API，支援 Pionex 獨有合約（不在 Binance fapi 上的）"""
    tf = PIONEX_TF_MAP.get(timeframe)
    if tf is None:
        return pd.DataFrame(columns=["time","open","high","low","close","volume"])
    # 2h：Pionex 不支援原生 2H，遞迴抓 1h 然後重採樣
    if tf == "_RESAMPLE_FROM_1H":
        df_1h = _fetch_pionex_klines(symbol, "1h", start, end,
                                       limit=limit * 2, max_candles=max_candles * 2, is_perp=is_perp)
        if df_1h.empty:
            return df_1h
        df_1h = df_1h.set_index("time")
        df_2h = df_1h.resample("2h").agg(
            {"open":"first","high":"max","low":"min","close":"last","volume":"sum"}
        ).dropna(subset=["open"]).reset_index()
        return df_2h
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

    # Pionex klines 回傳是 **newest-first** 排序（rows[0]=最新, rows[-1]=最舊）
    # 分頁邏輯：用「最舊一根的 time-1」當下次的 endTime，往更早抓
    seen_ts = set()   # 用來偵測 API 回傳同一批資料（防止無限迴圈）
    cur_end = end_ms
    while True:
        params2: dict = {"symbol": sym, "interval": tf, "limit": 500}
        if since:    params2["startTime"] = since
        if cur_end:  params2["endTime"]   = cur_end
        url  = f"{PIONEX_BASE}/api/v1/market/klines?{urllib.parse.urlencode(params2)}"
        data = _pionex_get(url, timeout=10)
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
        # Pionex 回傳是 newest-first；oldest_ts 是這批最舊的一根
        # 防呆：若這批的最舊 ts 已在 seen_ts，表示 API 拒絕分頁 / 卡死 → 跳出
        oldest_ts = min(r[0] for r in rows)
        if oldest_ts in seen_ts:
            break
        seen_ts.add(oldest_ts)
        all_rows.extend(rows)
        # 已抓到 startTime 邊界 / 不足一頁 / 達 max → 結束
        if (since and oldest_ts <= since) or len(klines) < 500 or len(all_rows) >= max_candles:
            break
        cur_end = oldest_ts - 1   # 下一頁往更早抓

    # 排序去重後回傳（Pionex newest-first + 多頁可能有重複邊界）
    if all_rows:
        all_rows.sort(key=lambda r: r[0])
        dedup = []
        prev_t = -1
        for r in all_rows:
            if r[0] != prev_t:
                dedup.append(r); prev_t = r[0]
        all_rows = dedup
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
        last_err = None
        # `.P` 明示使用者要的是 **Pionex 永續**——直接打 Pionex，**跳過 Binance**。
        # 為什麼：Binance fapi 同名標的（如 LYNUSDT）可能跟 Pionex LYN_USDT_PERP **不是同一個市場**，
        # vol 規模差 ~200x；若有時 Binance 回應有時失敗，realtime poll 會在兩種規模間隨機跳，
        # 圖表成交量看起來像「亂跳」。`.P` 後綴是使用者明示意圖，必須尊重它。
        if ex == "pionex" and is_perp:
            try:
                df = _fetch_pionex_klines(symbol, timeframe, start, end, limit, max_candles=mc, is_perp=True)
                if not df.empty:
                    return df
            except Exception as e:
                last_err = e
            # `.P` 走完 Pionex 還空 → 直接走錯誤分支（不要 fallback 到 Binance 避免 vol 跳變）
            if time.time() < _PIONEX_COOLDOWN_UNTIL:
                raise ValueError(f"{symbol} 暫時無法取得：Pionex 限流冷卻中（剩 {int(_PIONEX_COOLDOWN_UNTIL - time.time())} 秒，請等待後再試）")
            raise ValueError(f"找不到 {symbol} 的行情資料，請確認標的代號是否正確")
        # 無 .P：Binance 優先（歷史深、穩定）
        try:
            df = _fetch_binance_fapi(symbol, timeframe, start, end, limit, max_candles=mc)
            if not df.empty:
                return df
        except Exception as e:
            last_err = e
        try:
            df = _fetch_binance(symbol, timeframe, start, end, limit, max_candles=mc)
            if not df.empty:
                return df
        except Exception as e:
            last_err = e
        # 若使用者沒加 .P 後綴，但標的只在 Pionex 永續存在 → 自動視為 perp
        if ex == "pionex" and not is_perp:
            try:
                _perp_syms = _fetch_pionex_perp_symbols()
                base_sym = symbol.split("/")[0].upper()
                if base_sym in _perp_syms:
                    is_perp = True   # 自動補 perp
            except Exception:
                pass
        if ex == "pionex":
            try:
                df = _fetch_pionex_klines(symbol, timeframe, start, end, limit, max_candles=mc, is_perp=is_perp)
                if not df.empty:
                    return df
            except Exception as e:
                last_err = e
        # 區分限流（429）與真的找不到：限流時別誤導使用者「代號錯誤」
        es = str(last_err).lower() if last_err is not None else ""
        es_zh = str(last_err) if last_err is not None else ""
        if "429" in es or "too many" in es or "rate limit" in es or "熔斷" in es_zh:
            raise ValueError(f"{symbol} 暫時無法取得：Pionex 限流冷卻中，請稍後再試")
        # 全域冷卻中也視為限流（即使 last_err 是 Binance 找不到 — 因為冷卻中 Pionex 沒實際嘗試）
        if time.time() < _PIONEX_COOLDOWN_UNTIL:
            raise ValueError(f"{symbol} 暫時無法取得：Pionex 限流冷卻中（剩 {int(_PIONEX_COOLDOWN_UNTIL - time.time())} 秒，請等待後再試）")
        raise ValueError(f"找不到 {symbol} 的行情資料，請確認標的代號是否正確")
    elif ex == "bybit":
        return _fetch_bybit(symbol, timeframe, start, end, limit, max_candles=mc)
    elif ex == "okx":
        return _fetch_okx(symbol, timeframe, start, end, limit, max_candles=mc)
    else:
        raise ValueError(f"不支援的交易所: {exchange_id}")


def fetch_crypto_markets(exchange_id: str = "pionex"):
    """取得 USDT 永續合約清單（Pionex 預設用 perp，配合前端 .P 後綴）"""
    ex = exchange_id.lower()
    try:
        if ex == "pionex":
            # Pionex 主用途是永續合約 → 直接返回 perp 清單（含 .P 後綴）
            # 包含 Pionex 永續清單上所有標的（含 Binance 沒有的 Pionex 獨有）
            perp = _fetch_pionex_perp_symbols()
            results = [{"symbol": f"{s}/USDT.P", "base": s, "quote": "USDT"} for s in sorted(perp)]
        elif ex == "binance":
            data = _get(f"{BINANCE_BASE}/api/v3/exchangeInfo")
            results = [
                {"symbol": f"{s['baseAsset']}/{s['quoteAsset']}",
                 "base": s["baseAsset"], "quote": s["quoteAsset"]}
                for s in data.get("symbols", [])
                if s.get("status") == "TRADING" and s.get("quoteAsset") == "USDT"
                   and s.get("isSpotTradingAllowed")
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


def _fetch_fapi_prices() -> dict:
    """Binance 永續全合約最新價 {SYMBOL: price}（weight 2，給每秒高頻更新用）。"""
    try:
        data = _get(f"{BINANCE_FAPI_BASE}/fapi/v1/ticker/price", timeout=8)
        return {d["symbol"]: float(d["price"]) for d in data
                if isinstance(d, dict) and d.get("symbol") and d.get("price")}
    except Exception:
        return {}


def _fetch_spot_prices() -> dict:
    """Binance 現貨全標的最新價 {SYMBOL: price}（weight 4，給每秒高頻更新用）。"""
    try:
        data = _get(f"{BINANCE_BASE}/api/v3/ticker/price", timeout=8)
        return {d["symbol"]: float(d["price"]) for d in data
                if isinstance(d, dict) and d.get("symbol") and d.get("price")}
    except Exception:
        return {}


def _fetch_spot_tickers_binance() -> list:
    """Binance 現貨 24h ticker（USDT 對），格式與 Pionex 一致；失敗回 []。"""
    try:
        data = _get(f"{BINANCE_BASE}/api/v3/ticker/24hr", timeout=10)
        tickers = []
        for t in data:
            sym = t.get("symbol", "")
            if not sym.endswith("USDT"):
                continue
            base = sym[:-4]
            try:
                close = float(t["lastPrice"])
                tickers.append({
                    "symbol":     sym,
                    "display":    base + "/USDT",
                    "spot":       base + "/USDT",
                    "price":      close,
                    "open":       float(t.get("openPrice", 0)),
                    "change_pct": round(float(t["priceChangePercent"]), 2),
                    "change_amt": round(float(t.get("priceChange", 0)), 8),
                    "volume":     float(t.get("quoteVolume", 0)),
                })
            except (KeyError, ValueError):
                continue
        return tickers
    except Exception:
        return []


def _fetch_pionex_tickers(market: str = "futures") -> list:
    """直接從 Pionex API 取 24h 行情（僅備援用；正常走 Binance 以免狂打 Pionex 觸 429）。"""
    type_param = "PERP" if market == "futures" else ""
    url = f"{PIONEX_BASE}/api/v1/market/tickers"
    if type_param:
        url += f"?type={type_param}"
    try:
        data = _pionex_get(url, timeout=10)
        raw = data.get("data", {}).get("tickers", [])
        tickers = []
        for t in raw:
            sym = t.get("symbol", "")
            if market == "futures":
                if not sym.endswith("_USDT_PERP"):
                    continue
                base = sym[: -len("_USDT_PERP")]; display = base + "/USDT.P"; spot = base + "/USDT"
            else:
                if not sym.endswith("_USDT"):
                    continue
                if "_" in sym[: -len("_USDT")]:
                    continue
                base = sym[: -len("_USDT")]; display = base + "/USDT"; spot = display
            try:
                open_ = float(t["open"]); close = float(t["close"])
                change_pct = (close - open_) / open_ * 100 if open_ else 0.0
                tickers.append({
                    "symbol": sym, "display": display, "spot": spot, "price": close,
                    "open": open_,
                    "change_pct": round(change_pct, 2), "change_amt": round(close - open_, 8),
                    "volume": float(t.get("amount", 0)),
                })
            except (KeyError, ValueError):
                continue
        return tickers
    except Exception:
        return []


def fetch_tickers(market: str = "futures") -> list:
    """24h 行情。**改以 Binance 為主**（Pionex 用 Binance 流動性、價格一致、限流寬鬆），
    過濾成 Pionex 有的標的；Binance 失敗才退回 Pionex。

    為何這樣做：原本每 2 秒輪詢 Pionex tickers 會觸發 429（Too Many Requests），
    連帶讓 Pionex klines 失效 → Pionex 獨有標的「找不到」。改走 Binance 後 Pionex
    幾乎不被呼叫（只剩 1hr 快取的標的清單），429 解除、klines 恢復。"""
    if market == "futures":
        tickers = _apply_pionex_perp_filter(_fetch_futures_tickers_fapi())
        if tickers:
            tickers.sort(key=lambda x: x["change_pct"], reverse=True)
            return tickers
        return _fetch_pionex_tickers("futures")   # Binance 失敗才退回 Pionex
    # 現貨：Binance 現貨過濾成 Pionex 現貨。Pionex 現貨清單暫抓不到時，退用永續清單
    # （有硬編碼備援）當過濾代理，避免 spot 空白；都不打 Pionex tickers 以免 429。
    psyms = _fetch_pionex_symbols() or _fetch_pionex_perp_symbols()
    tickers = [t for t in _fetch_spot_tickers_binance() if t["symbol"][:-4].upper() in psyms]
    tickers.sort(key=lambda x: x["change_pct"], reverse=True)
    return tickers
