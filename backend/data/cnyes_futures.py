"""cnyes 鉅亨網 台指期盤中分鐘（含夜盤即時）＋ 自建 DB 歷史累積。

cnyes charting API（TradingView UDF 格式）：免金鑰、免開戶、**含夜盤即時**。
  GET ws.api.cnyes.com/ws/api/v1/charting/history?symbol=TWF:TXF:FUTURES&resolution=1&to=<unix>
  回 data.{s,t[],o[],h[],l[],c[],v[]}（t=unix 秒、降冪）。**只回『當前交易時段』(~當日)**。

歷史分鐘：TAIFEX 授權資料、無免費歷史源 → 自己每隔數秒抓當前時段存進 DB
（Postgres/SQLite，沿用 routes.account 連線層）→ 從開始收集起往後累積成歷史。
⚠ 跨重啟持久需 Railway Postgres；本機/無 PG 的 SQLite 重部署會清。
"""
import time

from utils.http_pool import SESSION   # 共用連線池（省掉每次 TLS 交握，見該模組）
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

# ★ 2026-09-17 實測：鉅亨約 7~10% 的請求回 **HTTP 200** 但內容是
#   {"statusCode": 5031, "message": "Redis連線錯誤", "data": []}（對方伺服器內部錯誤）。
#   原本只看 HTTP 狀態 → 當成「沒資料」回 None → 台股當日 K 退回**落後約 20 分鐘**的 yfinance
#   （守門員 check_tw_sources 在開盤 48 分鐘時只拿到 6 根 5 分 K＝只到 09:25，就是這樣抓到的）。
#   伺服器常駐時有 cnyes_last_good 墊著，但開機後第一次、或當天第一次看某檔時沒得墊。
# ⚠ 只重試 statusCode ≥ 500：「真的沒資料」（收盤後、不存在的代號）是 statusCode 200 ＋ t 為空陣列，
#   不可以重試（每次請求都會白打一倍）。
# ⚠ 只重試 **1 次**、等 0.3 秒：錯誤是**一陣一陣**的（實測 75 秒內 9 次錯誤全擠在同一段 4.3 秒裡），
#   要蓋住一整段得在請求裡等 4 秒以上 —— 這條在即時報價路徑上（每秒輪詢），不可以；
#   對方故障時狂重試也只會加重它的負擔。重試 1 次只救零星的與錯誤段邊緣的；
#   整段錯誤期間靠 routes 端的 cnyes_last_good 墊著，下一輪輪詢自然恢復。
_CNYES_TRIES = 2

def _cnyes_data(params: dict) -> dict:
    """打 charting API，回 data（dict）。對方伺服器錯誤（statusCode≥500）短暫等待後重試；
    連線/HTTP 錯誤照樣丟出（呼叫端原本就有 except）。"""
    for _i in range(_CNYES_TRIES):
        r = SESSION.get(_BASE, params=params, headers=_HDRS, timeout=8)
        r.raise_for_status()
        j = r.json() or {}
        try:
            _sc = int(j.get("statusCode") or 200)
        except (TypeError, ValueError):
            _sc = 200
        if _sc < 500 or _i == _CNYES_TRIES - 1:
            d = j.get("data")
            return d if isinstance(d, dict) else {}
        time.sleep(0.3)
    return {}


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
        d = _cnyes_data({"symbol": sym, "resolution": "1", "to": int(now)})
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
        d = _cnyes_data({"symbol": f"TWS:{symbol}:STOCK", "resolution": "1", "to": now})
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


# ── 台股批次即時報價（2026-09-18）────────────────────────────────────────────
#   GET ws.api.cnyes.com/ws/api/v1/quote/quotes/TWS:2330:STOCK,TWS:2317:STOCK,…?column=A
#   免金鑰、一個請求最多 **500 檔**（再多網址超長 → HTTP 400）。
#
#   ★ 為什麼從 TWSE MIS 換過來（實測，2026-09-18 收盤後量的）：
#     | 　             | 每檔傳輸(gzip) | 一個請求吃幾檔 | 500 檔耗時 |
#     | MIS            | 82 bytes      | 100           | ~11s(2.2s×5) |
#     | cnyes quotes   | **36 bytes**  | **500**       | **0.67s**    |
#     → 同樣的預算，輪掃一圈從 **45 秒縮到 ~15 秒**，請求數反而少一半。
#     ★ 正確性：抽樣 120 檔與證交所官方價比對 **106/106 完全相同**（其餘 14 檔是 MIS 收盤後
#       沒有成交價可比）。而且**沒有 MIS 那個「z 是 '-' 只好用買賣區間估價」的問題**
#       （實測 6597 我們估 68.8、cnyes 給 70.1＝真實收盤，差 1.9%）。
#   ⚠ 沒成交的股票 cnyes 回「無時間戳、無價格」（實測 33 檔）→ 一律跳過，讓 opendata 基底留著。
#   ⚠ 回來的每筆都帶 **報價時間戳**(200007) → 呼叫端可以自己驗「這份資料有多新」，
#     不必假設對方即時（見 main.py 疊價 worker 的落後偵測）。
_QUOTE_URL = "https://ws.api.cnyes.com/ws/api/v1/quote/quotes/"
CNYES_QUOTE_BATCH = 500          # 一個請求的上限（網址長度限制，501 檔起 HTTP 400）
# 欄位代碼（column=A 這組）
_Q_PRICE, _Q_CHG, _Q_PREV, _Q_PCT = "6", "11", "21", "56"
_Q_TIME, _Q_VOL, _Q_CODE = "200007", "800001", "200010"


#   ⚠ **上市/上櫃是 `TWS:`、興櫃是 `TWG:`**（2026-09-19）：只用 TWS 問的話興櫃整批 404，
#     那 343 檔就只剩落後一整天的 opendata 基底價。前綴記在 _TW_PREFIX，暖機後分組送出
#     → 穩定狀態不會多花請求；沒看過的代號先當 TWS、查無再用另一個前綴補問一次。
_TW_PREFIX = {}                  # 代號 → 解得出來的前綴（"TWS" 上市櫃／"TWG" 興櫃）
_TW_NOQ = {}                     # 代號 → 上次確認「兩種前綴都查無」的時間（30 分鐘內不再試）
_NOQ_TTL = 1800


def _quote_req(pref, batch):
    """打一個批次，回 (data 陣列, 這批有沒有拿到回應)。連線失敗回 (None, False)。"""
    url = _QUOTE_URL + ",".join(f"{pref}:{s}:STOCK" for s in batch)
    j = None
    for _i in range(_CNYES_TRIES):            # 同 charting：對方 statusCode≥500 才重試一次
        try:
            r = SESSION.get(url, params={"column": "A"}, headers=_HDRS, timeout=10)
            r.raise_for_status()
            j = r.json() or {}
        except Exception:
            return None, False
        try:
            _sc = int(j.get("statusCode") or 200)
        except (TypeError, ValueError):
            _sc = 200
        if _sc < 500 or _i == _CNYES_TRIES - 1:
            break
        j = None
        time.sleep(0.3)
    if j is None:
        return None, False
    return (j.get("data") or []), True


def _quote_pass(pref, syms, out, seen):
    """用某個前綴問一輪。out 收有價的、seen 收「回應裡出現過的代號」。
    ⚠ seen 與「有沒有價」要分開：今天還沒成交的股票**會**出現在回應裡但沒有價
      —— 把它算成「查無」的話，它一開始交易我們也不會去更新它。"""
    asked = set()
    for i in range(0, len(syms), CNYES_QUOTE_BATCH):
        batch = syms[i:i + CNYES_QUOTE_BATCH]
        data, ok = _quote_req(pref, batch)
        if not ok:
            continue                          # 連線失敗＝沒問到，不可當成「查無」
        asked.update(batch)
        for x in (data or []):
            sym, px, qts = x.get(_Q_CODE), x.get(_Q_PRICE), x.get(_Q_TIME)
            if not sym:
                continue
            sym = str(sym)
            seen.add(sym)
            _TW_PREFIX[sym] = pref
            if not px or not qts:             # 今天沒成交 → 跳過（讓基底留著）
                continue
            try:
                p, chg = float(px), round(float(x.get(_Q_CHG) or 0), 4)
                # column=A 不含昨收欄位 → 由「現價 − 漲跌」推導（實測與 Yahoo 昨收逐檔相同）
                prev = float(x.get(_Q_PREV) or 0) or round(p - chg, 4)
                out[sym] = {
                    "price": p,
                    "change_amt": chg,
                    "change_pct": round(float(x.get(_Q_PCT) or 0), 2),
                    "volume": float(x.get(_Q_VOL) or 0) * 1000,   # cnyes 給「張」→ 股（同 MIS）
                    "prev": prev, "est": False, "qts": int(qts),
                }
            except (TypeError, ValueError):
                continue
    return asked


def fetch_tw_quotes_bulk(symbols, answered=None):
    """cnyes 台股批次報價 → {代號: {price, change_pct, change_amt, volume, prev, est, qts}}。

    est 一律 False（都是真實成交價，不是估的）、qts＝那筆報價的時間戳（unix 秒）。
    整批失敗回空 dict（呼叫端會退回 MIS）。

    `answered`（選填 set）＝這次**真的問出確定答案**的代號，回填給呼叫端記進度用。
    ⚠⚠ **它不等於 symbols**，差別就是 2026-09-21 那個 bug 的根因：
      ・某個 chunk 連線失敗 → 那 500 檔根本沒送出去（`_quote_pass` 會跳過，不算查無）
      ・被 `_TW_NOQ` 擋掉的 → 這輪壓根沒問
      呼叫端若拿 symbols 當「問過了」，**整批抓失敗會被記成「查過、這幾檔沒報價」**
      → 收盤補齊一輪就宣告完成，203 檔興櫃整晚停在前一個交易日的價（本機實測）。
      「確定的答案」只有三種：回應裡有它／兩種前綴都問過都沒有／剛確認過查無還在 NOQ 內。"""
    out, seen = {}, set()
    now = time.time()
    uniq = [s for s in dict.fromkeys(symbols) if s]
    syms = [s for s in uniq
            if now - _TW_NOQ.get(s, 0) > _NOQ_TTL]         # 兩種前綴都查無的，30 分鐘內不再問
    if answered is not None:
        # 被 NOQ 擋掉的＝30 分鐘內才剛確認過「兩種前綴都查無」→ 那也是一個確定的答案
        answered.update(set(uniq) - set(syms))
    grp = {"TWS": [], "TWG": []}
    for s in syms:
        grp[_TW_PREFIX.get(s, "TWS")].append(s)            # 沒看過的先當上市櫃
    asked = set()
    for pref in ("TWS", "TWG"):
        if grp[pref]:
            asked |= _quote_pass(pref, grp[pref], out, seen)
    # 問過但回應裡根本沒這檔 → 前綴猜錯（多半是興櫃）→ 換另一個前綴補問一次，之後就記住了
    retry = {"TWS": [], "TWG": []}
    for s in asked:
        if s not in seen:
            retry["TWG" if _TW_PREFIX.get(s, "TWS") == "TWS" else "TWS"].append(s)
    asked2 = set()
    for pref in ("TWS", "TWG"):
        if retry[pref]:
            asked2 |= _quote_pass(pref, retry[pref], out, seen)
    for s in asked2:                                        # 兩種前綴都查無（下市/停牌）→ 先擱著
        if s not in seen:
            _TW_NOQ[s] = now
            if answered is not None:
                answered.add(s)                             # 兩種前綴都問到了、都沒有＝確定的答案
    if answered is not None:
        answered.update(seen)                               # 回應裡出現過的（有沒有成交都算問到了）
    return out


def tw_quotes_lag(price_map: dict) -> float:
    """這批 cnyes 報價「最新的那筆」距現在幾秒。★ 用途：**不要假設對方即時，量出來**。

    免費報價源最常見的壞法是安靜地延遲 15~20 分鐘（畫面上完全看不出來，數字照樣在跳）。
    每筆報價都自帶時間戳 → 取整批的最大值（最活躍那檔的最後成交時間）就是這個來源的新鮮度。
    盤中這個值應該是幾秒；大到幾分鐘就代表對方落後 → 呼叫端該退回 MIS。
    空 dict 回 -1（沒東西可判）。"""
    ts = [u.get("qts") or 0 for u in price_map.values()]
    return round(time.time() - max(ts), 1) if ts and max(ts) else -1.0
