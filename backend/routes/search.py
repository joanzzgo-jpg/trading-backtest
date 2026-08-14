"""搜索 API 路由"""
import threading
import time as _time

from fastapi import APIRouter, HTTPException, Response
from data.taiwan import search_tw_stock
from data.us_stock import search_us_stocks
from data.crypto import fetch_crypto_markets, fetch_tickers, _fetch_pionex_symbols, _fetch_pionex_perp_symbols
from utils.cache import cache

router = APIRouter(prefix="/api", tags=["search"])


# ── 台指期報價：過期先給舊值、背景單飛更新（2026-08-04）────────────────────────────
# ★ 為什麼：原本寫成 `futs = cache.get("txf_tickers", ttl=3)` → 沒中就**在請求執行緒裡**
#   呼叫 fetch_wall_tickers()（cnyes 網路請求，實測 214~473ms）。等於每 3 秒就有「一個
#   倒楣的使用者」替所有人去抓一次，他那次請求整個卡住。
#   實測（台股報價列，前端每 3 秒輪詢一次）：每 ~3.5 秒出現一次 400~800ms、最慢 2.8s 的卡頓；
#   同時段 /api/latest 完全正常（120 次只有 1 次 >150ms）→ 證實不是全行程 GIL 爭用，
#   就是這一支自己在請求裡等網路。
# ★ 改法：有舊值就先回舊值 + 背景更新（單飛，最多一條在跑）；只有冷啟動那一次才同步抓。
#   台指期報價本來就允許幾秒誤差（前端 3 秒輪詢），拿 3 秒前的值換「零卡頓」非常划算。
# ⚠ 失敗也要記時間戳：否則抓失敗後每個請求都會再踢一次背景更新，變成打爆 cnyes。
_TXF_TTL = 3.0
_TXF = {"data": None, "ts": 0.0, "busy": False}
_TXF_LOCK = threading.Lock()


def _txf_refresh():
    try:
        from data.cnyes_futures import fetch_wall_tickers
        d = fetch_wall_tickers()
        with _TXF_LOCK:
            _TXF["data"] = d
    except Exception:
        pass
    finally:
        with _TXF_LOCK:
            _TXF["ts"] = _time.time()      # 成功失敗都記，避免失敗時每個請求都重踢
            _TXF["busy"] = False


def _txf_tickers():
    """台指期三兄弟報價。永遠不讓請求執行緒等網路（冷啟動第一次除外）。"""
    now = _time.time()
    kick = False
    with _TXF_LOCK:
        data, stale = _TXF["data"], (now - _TXF["ts"]) >= _TXF_TTL
        if stale and not _TXF["busy"]:
            _TXF["busy"] = True
            kick = data is not None        # 有舊值 → 背景更新；沒有 → 下面同步抓
    if kick:
        threading.Thread(target=_txf_refresh, daemon=True).start()
        return data
    if data is not None:
        return data
    # 冷啟動：完全沒有值可回。只有搶到 busy 的那一個同步抓，其餘先回空（下一輪就有了）。
    with _TXF_LOCK:
        mine = _TXF["busy"]
    if not mine:
        return []
    _txf_refresh()
    with _TXF_LOCK:
        return _TXF["data"] or []


# ── 外匯報價：同 _txf_tickers（過期先給舊值、背景單飛更新）───────────────────────
# ★ 2026-08-11 實測：這支冷路徑 **894ms**、熱的 1ms。前端 fx 也是**每秒**輪詢（ticker.js
#   只有台股放慢到 3 秒），伺服器快取 30 秒 → 每 30 秒就有一個倒楣使用者等 0.9 秒。
# ★ 更嚴重的是**沒有單飛**：多個使用者同時撞到過期那一刻，每個人各自去打 21 檔 yfinance
#   → 一瞬間 N×21 個請求砸向 Yahoo，直接吃 429（us_stock 已經為了 429 加過冷卻，
#   但這條路是直接 `yf.download`，不受那層保護）。單飛把它壓成「最多一條在跑」。
_FX_TTL = 30.0
_FX = {"data": None, "ts": 0.0, "busy": False}
_FX_LOCK = threading.Lock()


def _fx_fetch():
    """抓 21 個貨幣對的「最近兩根日線」算現價與漲跌幅。回 list（失敗回 None）。"""
    from data.forex import FX_PAIRS, to_yf
    try:
        import yfinance as _yf, warnings as _w
        _w.filterwarnings("ignore")
        _map = {to_yf(p_): p_ for p_ in FX_PAIRS}
        data = _yf.download(list(_map.keys()), period="5d", interval="1d",
                            progress=False, group_by="ticker", threads=True)
    except Exception:
        return None
    rows = []
    for ysym, disp in _map.items():
        try:
            col = data[ysym]["Close"].dropna()
            if len(col) < 1:
                continue
            price = float(col.iloc[-1])
            prev = float(col.iloc[-2]) if len(col) > 1 else price
            amt = round(price - prev, 6)
            rows.append({"symbol": disp, "display": disp, "price": price,
                         "open": prev, "change_amt": amt,
                         "change_pct": round((amt / prev * 100) if prev else 0.0, 2),
                         "volume": 0})     # ⚠ 外匯是店頭市場、無集中成交量 → 恆為 0
        except Exception:
            continue
    rows.sort(key=lambda t: -t["change_pct"])
    return rows or None


def _fx_refresh():
    try:
        d = _fx_fetch()
        if d:
            with _FX_LOCK:
                _FX["data"] = d
    except Exception:
        pass
    finally:
        with _FX_LOCK:
            _FX["ts"] = _time.time()       # 成功失敗都記，避免失敗時每個請求都重踢
            _FX["busy"] = False


def _fx_tickers():
    """外匯報價列。永遠不讓請求執行緒等網路（冷啟動第一次除外）。"""
    now = _time.time()
    kick = False
    with _FX_LOCK:
        data, stale = _FX["data"], (now - _FX["ts"]) >= _FX_TTL
        if stale and not _FX["busy"]:
            _FX["busy"] = True
            kick = data is not None
    if kick:
        threading.Thread(target=_fx_refresh, daemon=True).start()
        return data
    if data is not None:
        return data
    with _FX_LOCK:                          # 冷啟動：只有搶到 busy 的那一個同步抓
        mine = _FX["busy"]
    if not mine:
        return []                           # 其餘先回空，下一輪（1 秒後）就有了
    _fx_refresh()
    with _FX_LOCK:
        return _FX["data"] or []


@router.get("/search")
def search(market: str, keyword: str, exchange: str = "pionex", token: str = ""):
    """搜索標的"""
    if market == "tw":
        # 台指期歸在台股底下 → 三兄弟置頂於搜尋結果（可用 TXF/台指 等關鍵字搜）
        from data.taifex_mis import PRODUCTS as _FP
        kw = (keyword or "").strip().upper()
        futs = [{"symbol": s, "display": s, "name": n} for s, n in _FP.items()
                if not kw or kw in s or kw in n or "台指" in (keyword or "") or "期" in (keyword or "")]
        return {"results": futs + search_tw_stock(keyword, token)}
    elif market == "crypto":
        # keyword 為交易所名稱時當交易所過濾用（舊行為兼容）；否則當搜尋關鍵字
        if keyword in ["pionex", "binance", "bybit", "okx"]:
            exchange = keyword
            kw = ""
        else:
            kw = (keyword or "").strip().upper()
        markets = fetch_crypto_markets(exchange)
        if kw:
            # 按關鍵字過濾（base 或 symbol contains）
            markets = [m for m in markets if kw in m.get("base", "").upper() or kw in m.get("symbol", "").upper()]
        return {"results": markets[:50]}
    elif market == "fx":
        # 外匯：清單固定 21 個貨幣對 → 純本機過濾，不打網路
        from data.forex import search as _fx_search
        return {"results": _fx_search(keyword)}
    return {"results": []}


@router.get("/us/search")
def us_search(q: str = ""):
    """搜尋美股標的"""
    if not q or len(q) < 1:
        return {"results": []}
    cache_key = f"us_search:{q.upper()}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached
    results = search_us_stocks(q)
    result = {"results": results}
    cache.set(cache_key, result)
    return result


@router.get("/hk/search")
def hk_search(q: str = ""):
    """搜尋港股標的：主源騰訊建議(支援中文名/代號、繁簡橋接)，再併 Yahoo .HK 補英文邊角，去重。
    修：舊版只用 Yahoo → 繁體中文名(騰訊/美團/匯豐…)全查無，港股使用者搜不到自家股票。"""
    if not q or len(q) < 1:
        return {"results": []}
    cache_key = f"hk_search:{q.upper()}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached
    from data.hk_stock import search_hk_stocks, hk_canon_code
    results = search_hk_stocks(q)                      # 主源：騰訊建議（中文/代號/常見英文，~100-500ms）
    # 只有騰訊「查無」時才補打 Yahoo（Yahoo 每次 +0.5~8s 卻對中文回 0 筆 → 平時是純拖慢，故僅當後備）
    if not results:
        seen = set()
        for r in search_us_stocks(q):
            s = str(r.get("symbol", "")).upper()
            if not s.endswith(".HK"):
                continue
            c5 = hk_canon_code(s[:-3])                  # 正規化為標準 5 碼＋濾掉 80700 等雙櫃檯
            if not c5:
                continue
            s = f"{c5}.HK"
            if s not in seen:
                r["symbol"] = s
                results.append(r); seen.add(s)
    result = {"results": results}
    cache.set(cache_key, result)
    return result


# ── 報價列傳輸瘦身（★只做在 HTTP 邊界，不可下沉到 live_data）───────────────────
# 為什麼：報價輪詢是全站最高頻的請求（crypto 每秒一輪／人）。實測整包 689 檔
#   raw 105.5KB / gzip **25.0KB**，而其中兩個欄位是「算得出來的」：
#     change_amt ≡ price − open（689/689 筆完全吻合）
#     spot       ≡ display 去掉 ".P"（689/689 筆完全吻合）
#   加上浮點瘦身（volume 例如 643173198.826843 → 整數；price/open 6 位有效數字；pct 2 位）
#   → gzip 25.0 → **17.5KB（-29.9%）**。前端在唯一的合併點 `_tkFill()` 補回來，消費者不必改。
# ⚠ **不可以連 symbol 一起省**（還能再省 9.6%）：跨源時 symbol 格式不同
#   （Binance `EVAAUSDT` vs Pionex `EVAA_USDT_PERP`）→ 從 display 推導只在「來源是 Binance」
#   時成立，幣安一冷卻降級就全錯。見 memory project_ticker-merge-key-display。
# ⚠ 只套用在 crypto：台股那批的 change_amt 是「對前一日收盤」算的，不是 price−open，推導不成立。
# ⚠ 不可原地改 live_data 的字典（那是共用的即時快取）→ 一律建新的。
_SLIM_MEMO = {"rev": None, "rows": None}


def _slim_crypto_rows(rows, rev):
    """砍可推導欄位＋浮點瘦身。以 rev 記憶，同一版只算一次（多人同時輪詢時只付一次 CPU）。"""
    m = _SLIM_MEMO
    if rev is not None and m["rev"] == rev and m["rows"] is not None:
        return m["rows"]
    out = []
    for t in rows:
        o = dict(t)
        o.pop("change_amt", None)
        o.pop("spot", None)
        for k in ("price", "open"):
            v = o.get(k)
            if isinstance(v, float):
                o[k] = float(f"{v:.6g}")
        v = o.get("change_pct")
        if isinstance(v, float):
            o["change_pct"] = round(v, 2)
        v = o.get("volume")
        if isinstance(v, float):
            o["volume"] = int(v)
        out.append(o)
    if rev is not None:
        m["rev"], m["rows"] = rev, out
    return out


@router.get("/tickers")
def get_tickers(response: Response, market: str = "futures", since: str = ""):
    """取得標的列表：優先從記憶體即時快取讀取，啟動初期才 fallback 至直接 API。
    since=上次回應的 rev token → 只回「有變動的標的」(delta:true)＋新 token；
    token 失效(重啟/別的worker/太舊/無資料) → 自動回整包。crypto 1s/tw 3s 輪詢頻寬大減、行為不變。"""
    from utils.live_data import get as live_get, has_data, has_tw_data, get_delta, delta_token
    from data.taiwan import fetch_tw_tickers
    # HTTP 快取：crypto 1s、tw 2s（台股高量股由 MIS 疊價 worker 每 3s 更新記憶體→短快取讓報價列即時跳）。
    # 避免多分頁/多用戶同步 polling 造成的重複請求。
    response.headers["Cache-Control"] = f"public, max-age={2 if market == 'tw' else 1}"
    if market == "tw":
        # 台指期（三兄弟近月）置頂於台股清單。cnyes 即時價(含夜盤)+MIS 參考價。
        # ⚠ 走 _txf_tickers()：過期先回舊值、背景更新 —— 絕不在請求裡等網路（見上方說明）。
        futs = _txf_tickers()
        if has_tw_data():
            if since:
                d = get_delta("tw", since)
                if d is not None:   # delta＝台股變動檔＋台指期三兄弟一律附上（客戶端靠 symbol 合併）
                    d["tickers"] = (futs or []) + d["tickers"]
                    d["source"] = "live"
                    return d
            out = {"tickers": (futs or []) + live_get("tw"), "source": "live"}
            tok = delta_token("tw")
            if tok:
                out["rev"] = tok
            return out
        return {"tickers": (futs or []) + fetch_tw_tickers(), "source": "direct"}
    if market == "fx":
        # 外匯行情列：固定 21 個貨幣對，用 yfinance 批次抓「最近兩根日線」算現價與漲跌幅。
        # ⚠ 走 _fx_tickers()：過期先回舊值、背景單飛更新 —— 絕不在請求裡等網路（見上方說明）。
        # ⚠ 快取 30 秒：外匯沒有像加密那樣的免費全市場即時端點，逐檔抓成本高；
        #   報價列本來就是給「看盤面」用的，30 秒夠了（主圖那條是每秒更新、不受此影響）。
        return {"tickers": _fx_tickers(), "source": "live"}
    if market == "spot":
        # ★ 2026-08-10 現貨改成「有人看才抓」：登記需求時間，背景 worker 據此決定要不要每秒更新。
        #   為什麼：worker 原本無條件每秒抓 Binance 現貨全標的 —— 實測 **3683 筆**（永續才 726 筆），
        #   等於每秒多解析 5 倍的 JSON、多吃一份 API 權重，而現貨清單只有「標的搜尋切到現貨分頁」
        #   時才看得到（前端自己的註解：視窗多數時間是關的）。這條白吃的 CPU 與上游額度，
        #   正是造成 Binance 偶發限流→來源反覆跳→K 棒抖動的那份預算。
        from utils import live_data as _ld
        _ld.mark_spot_wanted()
    if has_data():
        tok = delta_token(market)
        if since:
            d = get_delta(market, since)
            if d is not None:
                d["tickers"] = _slim_crypto_rows(d["tickers"], None)   # 差量筆數少，不進記憶體
                d["source"] = "live"
                return d
        out = {"tickers": _slim_crypto_rows(live_get(market), tok), "source": "live"}
        if tok:
            out["rev"] = tok
        return out
    # 冷啟動 fallback：直接呼叫 API
    tickers = fetch_tickers(market)
    return {"tickers": tickers, "source": "direct"}


@router.get("/pionex/symbols")
def get_pionex_symbols():
    """診斷用：回傳目前快取的 Pionex 標的清單"""
    spot  = _fetch_pionex_symbols()
    perp  = _fetch_pionex_perp_symbols()
    return {
        "spot":  {"count": len(spot),  "symbols": sorted(spot)},
        "perp":  {"count": len(perp),  "symbols": sorted(perp)},
    }
