"""全域即時 ticker 快取，由背景執行緒維護，供 API 路由直接讀取。

多 worker 支援（無需 Redis）：
  只有「leader」worker 會跑背景抓取執行緒並呼叫 update() → 它同時把快照原子寫到共享磁碟檔。
  其他 follower worker 的記憶體 _cache 一直是空/舊 → get()/has_*() 自動回退讀共享磁碟檔
  （0.5s memo，免每請求都讀磁碟）。workers=1 時唯一 worker 即 leader，全走記憶體、行為不變。
"""
import os
import time
import pickle
import threading

_cache = {"futures": [], "spot": [], "tw": [], "ts": 0.0}
_lock  = threading.Lock()

# ── delta 支援（/api/tickers?since=…）───────────────────────────────
# leader 每次 update 時逐標的比對上一版快照 → 記「最後變動 rev」；
# 路由帶舊 rev 來 → 只回有變動的標的（crypto 1s 輪詢頻寬大減、行為不變）。
# token 摻 _BOOT（process 標識）：重啟/別的 worker 的 token 一律判失效 → 回整包，永不出錯資料。
_BOOT  = f"{int(time.time()):x}-{os.getpid():x}"
_delta = {}   # market → {"rev": int, "sym_rev": {sym: {欄位: rev}}, "prev": {sym: dict快照}}


def _track(market: str, lst: list):
    """在 _lock 內呼叫：逐**欄位**比對是否與上一版不同 → 蓋該欄位的最後變動 rev。
    ⚠ prev 必須存「副本」：overlay_tw 是就地改同一批 dict，存原參照會永遠相等、測不到變動。

    ★ 2026-08-17 由「每標的一個 rev」細到「每欄位一個 rev」。
      為什麼：crypto 永續每秒有 672/689 檔在動 → 舊的列級差量幾乎等於整包（實測 17.4KB vs
      17.9KB，省不到 3%）。但一列 6 個欄位裡，`symbol`／`display` **永遠不變**（佔封包 40%），
      `open` 一整天不變（13%），真正每秒在跳的只有 price/change_pct/volume。
      改成欄位級之後實測 **−55%**（三輪 8845B → 3995B）。
    ⚠ 差量是相對**客戶端的 token**（不是相對伺服器的上一版）→ 每個欄位都得各自記錄
      最後變動版本，不能只記「這一版有沒有變」；落後好幾版的客戶端才拿得到完整的差異。"""
    d = _delta.setdefault(market, {"rev": 0, "sym_rev": {}, "prev": {}})
    d["rev"] += 1
    rev, prev, srev = d["rev"], d["prev"], d["sym_rev"]
    cur = {}
    for t in lst:
        s = t.get("symbol")
        if not s:
            continue
        cur[s] = t
        p, fr = prev.get(s), srev.get(s)
        if p is None or not isinstance(fr, dict):
            srev[s] = {k: rev for k in t}        # 新標的（或從舊格式升上來）→ 整列算這一版變的
            continue
        for k, v in t.items():
            if p.get(k) != v:
                fr[k] = rev
        for k in [k for k in fr if k not in t]:  # 欄位消失（換來源）→ 記成變動，讓下次整列重送
            fr.pop(k, None)
            fr["_gone"] = rev
    for s in list(srev.keys()):          # 下架標的清掉（防 srev 無限長大）
        if s not in cur:
            srev.pop(s, None)
    d["prev"] = {s: dict(t) for s, t in cur.items()}


def _snap_with_delta() -> dict:
    """在 _lock 內呼叫：把「資料」與「delta 狀態」放進同一份快照。

    ★ 2026-08-15 為什麼要share delta 狀態：`_track` 只在 leader 跑 → follower 的 `_delta` 永遠是空的
      → `delta_token()` 回 None、`get_delta()` 也回 None → **follower 一律回整包**。
      線上 workers=2 輪流服務 ≈ 一半的輪詢都在傳整包。台股整包 gzip **52.1KB**、
      差量只要 **0.5KB**（實測 4 秒內只有 3/1966 檔變動）→ 這一半的浪費非常貴
      （台股 3 秒一輪 ≈ 每人每小時 62MB）。
    ⚠ 只 share `rev`/`sym_rev`，**不 share `prev`**：那是 leader 比對用的整份上一版快照，
      體積等於再放一份資料，而 follower 根本不需要（它不做 _track）。
    ⚠ boot 也要跟著走：follower 要用**leader 的 boot** 發 token，否則兩邊發出的 token
      互不相認，等於沒修。
    """
    snap = dict(_cache)
    snap["_boot"] = _BOOT
    snap["_delta"] = {m: {"rev": d["rev"], "sym_rev": dict(d["sym_rev"])}
                      for m, d in _delta.items()}
    return snap


def _shared_delta(market: str):
    """follower 用：從共享快照取 (boot, rev, sym_rev)；沒有就回 None。"""
    sh = _read_shared()
    boot = sh.get("_boot")
    d = (sh.get("_delta") or {}).get(market)
    if not boot or not d:
        return None
    return boot, d.get("rev", 0), d.get("sym_rev") or {}


def delta_token(market: str):
    """目前版本 token（整包回應附上 → 客戶端下次帶 since 用）。follower 無 _delta → None。"""
    d = _delta.get(market)
    if d:
        return f"{_BOOT}:{d['rev']}"
    sd = _shared_delta(market)          # follower：用 leader 寫在共享快照裡的版本
    return f"{sd[0]}:{sd[1]}" if sd else None


def get_delta(market: str, token: str, fields: bool = False):
    """回「自 token 版以來有變動的標的」；token 失效/跨程序/太舊 → None（呼叫端回整包）。
    先鎖內快照 rev/sym_rev 再取清單：期間若又有更新,新變動不在本次回應,但回的 token 也是舊 rev
    → 下一輪必補到,不漏報。

    fields=True → **只回真的變了的欄位**（省 55%）。**必須由前端明講它看得懂**（`?fd=1`）。
    ★ 2026-08-19 事故：欄位級差量上線後，使用者回報「合約行情不動了」。
      根因是**版本歪斜**：他的分頁還跑著改版前的 JS，而後端已經在送部分欄位 ——
      舊版 `_tkMerge` 是「整列覆蓋」(`m.set(id, t)`)，收到 `{display, price, change_pct}`
      就把 `symbol`/`open`/`volume` 全洗掉 → 排序崩掉、畫面看起來凍住，**而且零錯誤**。
      全新 profile 永遠測不到（它拿的是新 JS）；線上每次部署都會有一批「開著沒重整」的分頁中招。
    → 預設回舊格式（整列），前端帶 `fd=1` 才升級。舊分頁自動安全，不必等使用者重整。"""
    if not token:
        return None
    try:
        boot, r = token.rsplit(":", 1)
        r = int(r)
    except Exception:
        return None
    d = _delta.get(market)
    if d:                                              # leader：用自己的
        with _lock:
            rev = d["rev"]
            if boot != _BOOT or r > rev or rev - r > 900:   # 900版≈15分鐘沒跟上 → 整包重來
                return None
            srev = dict(d["sym_rev"])
        my_boot = _BOOT
    else:                                              # follower：用 leader 寫在共享快照裡的
        sd = _shared_delta(market)
        if not sd:
            return None
        my_boot, rev, srev = sd
        if boot != my_boot or r > rev or rev - r > 900:
            return None
    lst = get(market)
    changed = []
    if r != rev:
        for t in lst:
            fr = srev.get(t.get("symbol"))
            if not isinstance(fr, dict):     # 沒有紀錄（剛上架／舊格式）→ 保守整列送
                changed.append(t)
                continue
            ks = [k for k, kr in fr.items() if kr > r]
            if not ks:
                continue
            if not fields:                   # 舊前端：這一列有任何欄位變了就整列送（改版前的行為）
                changed.append(t)
                continue
            row = {k: t[k] for k in ks if k in t}
            # 合併鍵一定要在：前端 _tkMerge 用 display（沒有才退回 symbol）當鍵，少了它這一列
            # 會被當成新標的塞進清單（跨源 symbol 格式不同，見 memory ticker-merge-key-display）。
            if t.get("display") is not None:
                row["display"] = t["display"]
            elif t.get("symbol") is not None:
                row["symbol"] = t["symbol"]
            changed.append(row)
    return {"tickers": changed, "rev": f"{my_boot}:{rev}", "delta": True}

# 共享磁碟快照（與 disk_cache 同目錄，跨 process 存活）。原子寫（temp+rename）避免讀到半截。
_SHARE_DIR  = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".df_cache")
_SHARE_PATH = os.path.join(_SHARE_DIR, "live_ticker.pkl")
_FRESH_SEC  = 5.0           # 本地記憶體視為「新鮮」的秒數（leader 每秒 update → 一直新鮮）
_shared_memo = {"ts": 0.0, "data": None}   # follower 讀磁碟的 0.5s memo


_REDIS_KEY = "live:ticker"

def _write_shared(snapshot: dict):
    # Redis 優先（跨 worker 快、TTL 自動過期）；沒設 Redis → 原子寫磁碟 fallback。
    try:
        from utils import shared_store
        if shared_store.enabled():
            shared_store.set_blob(_REDIS_KEY, snapshot, ttl=30)
            return
    except Exception:
        pass
    try:
        os.makedirs(_SHARE_DIR, exist_ok=True)
        tmp = f"{_SHARE_PATH}.{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            pickle.dump(snapshot, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, _SHARE_PATH)        # 原子替換
    except Exception:
        pass


def _read_shared() -> dict:
    """讀共享快照（Redis 優先，否則磁碟；一律 0.5s memo 免頻繁 IO）。失敗回空。"""
    now = time.time()
    if _shared_memo["data"] is not None and now - _shared_memo["ts"] < 0.5:
        return _shared_memo["data"]
    data = None
    try:
        from utils import shared_store
        if shared_store.enabled():
            data = shared_store.get_blob(_REDIS_KEY)
    except Exception:
        data = None
    if data is None:
        data = {"futures": [], "spot": [], "tw": [], "ts": 0.0}
        try:
            with open(_SHARE_PATH, "rb") as f:
                data = pickle.load(f)
        except Exception:
            pass
    _shared_memo["ts"] = now
    _shared_memo["data"] = data
    return data


# ── 現貨「有人看才抓」（2026-08-10）──────────────────────────────────────────
#   /api/tickers?market=spot 進來就蓋一次時間戳；背景 worker 只在 _SPOT_WANT_SEC 秒內
#   有人要過才更新現貨。沒人看時每秒省下 3683 筆 JSON 解析＋一份 Binance api 權重。
#   ⚠ 別把窗口調太短：使用者在現貨分頁上「看著不動」時不會一直發請求嗎——會，前端每秒輪詢，
#     所以 90 秒非常寬鬆，純粹是「關掉視窗後多跑一會兒」的緩衝。
_SPOT_WANT = {"ts": 0.0}
_SPOT_WANT_SEC = 90.0


def mark_spot_wanted():
    _SPOT_WANT["ts"] = time.time()


def spot_wanted() -> bool:
    return (time.time() - _SPOT_WANT["ts"]) <= _SPOT_WANT_SEC


def spot_idle_sec() -> float:
    return round(time.time() - _SPOT_WANT["ts"], 1) if _SPOT_WANT["ts"] else -1.0


def _local_fresh() -> bool:
    return bool(_cache["ts"]) and (time.time() - _cache["ts"]) < _FRESH_SEC


def get(market: str) -> list:
    with _lock:
        if _local_fresh():
            return list(_cache.get(market, []))
    return list(_read_shared().get(market, []))     # follower / 記憶體尚無資料 → 讀共享磁碟


def has_data() -> bool:
    with _lock:
        if _local_fresh():
            return bool(_cache["futures"])
    return bool(_read_shared().get("futures"))


def has_tw_data() -> bool:
    with _lock:
        if _local_fresh():
            return bool(_cache["tw"])
    return bool(_read_shared().get("tw"))


def update(futures: list, spot: list):
    with _lock:
        _cache["futures"] = futures
        _cache["spot"]    = spot
        _cache["ts"]      = time.time()
        _track("futures", futures)
        _track("spot", spot)
        snap = _snap_with_delta()
    _write_shared(snap)                              # leader 寫共享磁碟供 follower 讀


def update_tw(tw: list):
    with _lock:
        _cache["tw"] = tw
        _cache["ts"] = time.time()
        _track("tw", tw)
        snap = _snap_with_delta()
    _write_shared(snap)


def overlay_tw(price_map: dict):
    """把 MIS 即時價(sym→{price,change_pct,change_amt,volume})就地疊到快取台股清單 →
    熱門/高量股即時跳動，不必每次重抓 opendata 全量。只改變動值、不動清單結構(排序前端做)。"""
    if not price_map:
        return
    with _lock:
        lst = _cache.get("tw") or []
        if not lst:
            return
        for t in lst:
            u = price_map.get(t.get("symbol"))
            if u:
                t["price"] = u["price"]; t["change_pct"] = u["change_pct"]
                t["change_amt"] = u["change_amt"]; t["volume"] = u["volume"]
        _cache["ts"] = time.time()
        _track("tw", lst)     # 就地改也要追蹤變動（prev 存副本，比對可靠）
        snap = dict(_cache)
    _write_shared(snap)
