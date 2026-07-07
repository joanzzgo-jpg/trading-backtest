"""cnyes 鉅亨網 台指期盤中分鐘（含夜盤即時）＋ 自建 DB 歷史累積。

cnyes charting API（TradingView UDF 格式）：免金鑰、免開戶、**含夜盤即時**。
  GET ws.api.cnyes.com/ws/api/v1/charting/history?symbol=TWF:TXF:FUTURES&resolution=1&to=<unix>
  回 data.{s,t[],o[],h[],l[],c[],v[]}（t=unix 秒、降冪）。**只回『當前交易時段』(~當日)**。

歷史分鐘：TAIFEX 授權資料、無免費歷史源 → 自己每隔數秒抓當前時段存進 DB
（Postgres/SQLite，沿用 routes.account 連線層）→ 從開始收集起往後累積成歷史。
⚠ 跨重啟持久需 Railway Postgres；本機/無 PG 的 SQLite 重部署會清。
"""
import time
import requests
import pandas as pd
from datetime import datetime

_BASE = "https://ws.api.cnyes.com/ws/api/v1/charting/history"
_HDRS = {"Origin": "https://www.cnyes.com", "Referer": "https://www.cnyes.com/",
         "User-Agent": "Mozilla/5.0"}
# 產品碼 → cnyes symbol（微台 TMF 不在 cnyes → 自動略過）
_SYMBOL = {"TXF": "TWF:TXF:FUTURES", "MXF": "TWF:MXF:FUTURES", "TMF": "TWF:TMF:FUTURES"}
PRODUCTS = ("TXF", "MXF", "TMF")
_TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "8h": 480}

_live_cache: dict = {}   # prod → (fetch_ts, df_1m[ts,o,h,l,c,v])


def fetch_cnyes_1m(product: str):
    """cnyes 當前時段 1 分鐘K（含夜盤）DataFrame[ts,o,h,l,c,v]。快取 8s；失敗沿用上次。無資料回 None。"""
    prod = (product or "").upper()
    sym = _SYMBOL.get(prod)
    if not sym:
        return None
    now = time.time()
    c = _live_cache.get(prod)
    if c and now - c[0] < 8:
        return c[1]
    try:
        r = requests.get(_BASE, params={"symbol": sym, "resolution": "1", "to": int(now)},
                         headers=_HDRS, timeout=8)
        r.raise_for_status()
        d = (r.json() or {}).get("data") or {}
    except Exception:
        return c[1] if c else None
    t = d.get("t") or []
    if not t or d.get("s") != "ok":
        return c[1] if c else None
    o, h, l, cl, v = (d.get("o") or [], d.get("h") or [], d.get("l") or [],
                      d.get("c") or [], d.get("v") or [])
    rows = []
    for i in range(len(t)):
        try:
            rows.append({"ts": int(t[i]), "o": float(o[i]), "h": float(h[i]),
                         "l": float(l[i]), "c": float(cl[i]), "v": float(v[i] or 0)})
        except Exception:
            continue
    if not rows:
        return c[1] if c else None
    df = pd.DataFrame(rows).drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    _live_cache[prod] = (now, df)
    return df


# ── DB 儲存（沿用 routes.account 的 Postgres/SQLite 連線層）─────────────
_table_ready = False


def _ensure_table():
    global _table_ready
    if _table_ready:
        return
    import routes.account as acct
    conn, _ = acct._db()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS txf_min (
                product TEXT, ts BIGINT,
                o DOUBLE PRECISION, h DOUBLE PRECISION, l DOUBLE PRECISION,
                c DOUBLE PRECISION, v DOUBLE PRECISION,
                PRIMARY KEY (product, ts)
            )
        """ if acct._use_pg() else """
            CREATE TABLE IF NOT EXISTS txf_min (
                product TEXT, ts INTEGER,
                o REAL, h REAL, l REAL, c REAL, v REAL,
                PRIMARY KEY (product, ts)
            )
        """)
        conn.commit()
        _table_ready = True
    finally:
        conn.close()


def save_1m(product: str, df):
    """把 1 分鐘K upsert 進 DB（同分鐘會更新＝當前形成中的棒也能刷新）。"""
    if df is None or df.empty:
        return
    import routes.account as acct
    _ensure_table()
    conn, ph = acct._db()
    try:
        if acct._use_pg():
            sql = (f"INSERT INTO txf_min (product,ts,o,h,l,c,v) VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph}) "
                   "ON CONFLICT (product,ts) DO UPDATE SET o=EXCLUDED.o,h=EXCLUDED.h,"
                   "l=EXCLUDED.l,c=EXCLUDED.c,v=EXCLUDED.v")
        else:
            sql = ("INSERT INTO txf_min (product,ts,o,h,l,c,v) VALUES (?,?,?,?,?,?,?) "
                   "ON CONFLICT(product,ts) DO UPDATE SET o=excluded.o,h=excluded.h,"
                   "l=excluded.l,c=excluded.c,v=excluded.v")
        prod = (product or "").upper()
        rows = [(prod, int(r.ts), float(r.o), float(r.h), float(r.l), float(r.c), float(r.v))
                for r in df.itertuples()]
        conn.executemany(sql, rows)
        conn.commit()
    finally:
        conn.close()


def load_1m(product: str, limit_bars: int = 20000):
    """從 DB 讀最近 limit_bars 根 1 分鐘K（升冪）。無資料回 None。"""
    import routes.account as acct
    _ensure_table()
    conn, ph = acct._db()
    try:
        cur = conn.execute(
            f"SELECT ts,o,h,l,c,v FROM txf_min WHERE product={ph} ORDER BY ts DESC LIMIT {ph}",
            ((product or "").upper(), int(limit_bars)))
        rows = cur.fetchall()
    finally:
        conn.close()
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["ts", "o", "h", "l", "c", "v"])
    return df.sort_values("ts").reset_index(drop=True)


def collect_all() -> int:
    """抓三兄弟當前時段 → 存 DB（背景 worker 用）。回傳有存的產品數。"""
    n = 0
    for prod in PRODUCTS:
        try:
            df = fetch_cnyes_1m(prod)
            if df is not None and not df.empty:
                save_1m(prod, df)
                n += 1
        except Exception:
            pass
    return n


# ── 供圖表：DB 歷史 ＋ 當前時段(cnyes live) 合併，再 resample ─────────────
def _to_ohlc(df):
    d = df.copy()
    d["time"] = d["ts"].apply(lambda s: datetime.utcfromtimestamp(int(s)))   # UTC naive（前端 toTime +8）
    return d[["time", "o", "h", "l", "c", "v"]].rename(
        columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})


def get_txf_intraday(product: str, timeframe: str):
    """台指期盤中 K：DB 歷史 ＋ cnyes 當前時段 合併 → resample 成各時框。無資料回 None。"""
    m = _TF_MIN.get(timeframe)
    if m is None:
        return None
    prod = (product or "").upper()
    hist = load_1m(prod)
    live = fetch_cnyes_1m(prod)
    frames = [x for x in (hist, live) if x is not None and not x.empty]
    if not frames:
        return None
    allm = pd.concat(frames).drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    df = _to_ohlc(allm)
    if m == 1:
        return df
    return df.set_index("time").resample(f"{m}min").agg({
        "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum",
    }).dropna(subset=["open"]).reset_index()
