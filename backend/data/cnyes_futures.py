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


# ── 台股個股：cnyes charting 同一支 API（TWS:<代號>:STOCK）連續分鐘K、無延遲、免金鑰 ──
_STOCK_TF_MIN = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}
_stock_cache: dict = {}   # (symbol,tf) → (fetch_ts, df)；8 秒快取，避免多路徑重複打 cnyes


def fetch_cnyes_stock_intraday(symbol: str, timeframe: str):
    """cnyes 台股個股當前時段分鐘K(連續·09:00起無跳號·無延遲·含即時那根)→
    DataFrame[time(UTC naive),open,high,low,close,volume]。抓 1 分鐘再 resample(邊界對齊 yfinance 歷史)。
    失敗/無資料/收盤回 None。symbol=純代號(如 '2330')；ETF 也走 :STOCK(cnyes 接受)。快取 8 秒。"""
    m = _STOCK_TF_MIN.get(timeframe)
    if not m or not symbol:
        return None
    now = int(time.time())
    _ck = (symbol, timeframe)
    _c = _stock_cache.get(_ck)
    if _c and now - _c[0] < 8:
        return _c[1]
    try:
        r = requests.get(_BASE, params={"symbol": f"TWS:{symbol}:STOCK", "resolution": "1", "to": now},
                         headers=_HDRS, timeout=8)
        r.raise_for_status()
        d = (r.json() or {}).get("data") or {}
    except Exception:
        return None
    t = d.get("t") or []
    if d.get("s") != "ok" or not t:
        return None
    o, h, l, cl, v = (d.get("o") or [], d.get("h") or [], d.get("l") or [],
                      d.get("c") or [], d.get("v") or [])
    rows = []
    for i in range(len(t)):
        try:
            rows.append({"time": datetime.utcfromtimestamp(int(t[i])), "open": float(o[i]),
                         "high": float(h[i]), "low": float(l[i]), "close": float(cl[i]),
                         "volume": float(v[i] or 0)})
        except Exception:
            continue
    if not rows:
        return None
    df = pd.DataFrame(rows).drop_duplicates("time").sort_values("time").reset_index(drop=True)
    if m != 1:
        df = df.set_index("time").resample(f"{m}min").agg({
            "open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"
        }).dropna().reset_index()
    _stock_cache[_ck] = (now, df)
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


def fetch_wall_tickers():
    """報價牆用：三兄弟 cnyes 即時價(含夜盤) + TAIFEX MIS 參考價(前結算)算漲跌。
    欄位對齊台股 ticker + is_future 置頂旗標。cnyes 無的(微台)退回純 MIS。"""
    from data.taifex_mis import fetch_taifex_quote, PRODUCTS as _NAMES
    out = []
    for prod in PRODUCTS:
        df = fetch_cnyes_1m(prod)
        mq = fetch_taifex_quote(prod)   # 取參考價(前結算)＝price-change_amt
        ref = None
        if mq and mq.get("price") is not None and mq.get("change_amt") is not None:
            ref = mq["price"] - mq["change_amt"]
        if df is not None and not df.empty:
            price = float(df.iloc[-1]["c"])
            vol = float(df["v"].sum())
            if ref:
                camt = price - ref
                cpct = camt / ref * 100
            else:   # 無參考價 → 退回 cnyes 當前時段首根當基準
                base = float(df.iloc[0]["c"]) or price
                camt = price - base
                cpct = (camt / base * 100) if base else 0.0
        elif mq and mq.get("price") is not None:   # cnyes 無(微台) → 純 MIS
            price = mq["price"]; vol = mq.get("volume") or 0
            camt = mq.get("change_amt") or 0.0; cpct = mq.get("change_pct") or 0.0
        else:
            continue
        out.append({
            "symbol": prod, "display": prod, "name": _NAMES.get(prod, prod),
            "price": price, "change_pct": round(cpct, 2),
            "change_amt": round(camt, 1), "volume": vol, "is_future": True,
        })
    return out


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
