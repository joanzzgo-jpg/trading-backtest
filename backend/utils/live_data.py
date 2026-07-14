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
_delta = {}   # market → {"rev": int, "sym_rev": {sym: rev}, "prev": {sym: dict快照}}


def _track(market: str, lst: list):
    """在 _lock 內呼叫：比對每個標的 dict 是否與上一版不同 → 蓋最後變動 rev。
    ⚠ prev 必須存「副本」：overlay_tw 是就地改同一批 dict，存原參照會永遠相等、測不到變動。"""
    d = _delta.setdefault(market, {"rev": 0, "sym_rev": {}, "prev": {}})
    d["rev"] += 1
    rev, prev, srev = d["rev"], d["prev"], d["sym_rev"]
    cur = {}
    for t in lst:
        s = t.get("symbol")
        if not s:
            continue
        cur[s] = t
        if prev.get(s) != t:
            srev[s] = rev
    for s in list(srev.keys()):          # 下架標的清掉（防 srev 無限長大）
        if s not in cur:
            srev.pop(s, None)
    d["prev"] = {s: dict(t) for s, t in cur.items()}


def delta_token(market: str):
    """目前版本 token（整包回應附上 → 客戶端下次帶 since 用）。follower 無 _delta → None。"""
    d = _delta.get(market)
    return f"{_BOOT}:{d['rev']}" if d else None


def get_delta(market: str, token: str):
    """回「自 token 版以來有變動的標的」；token 失效/跨程序/太舊 → None（呼叫端回整包）。
    先鎖內快照 rev/sym_rev 再取清單：期間若又有更新,新變動不在本次回應,但回的 token 也是舊 rev
    → 下一輪必補到,不漏報。"""
    d = _delta.get(market)
    if not d or not token:
        return None
    try:
        boot, r = token.rsplit(":", 1)
        r = int(r)
    except Exception:
        return None
    with _lock:
        rev = d["rev"]
        if boot != _BOOT or r > rev or rev - r > 900:   # 900版≈15分鐘沒跟上 → 整包重來
            return None
        srev = dict(d["sym_rev"])
    lst = get(market)
    changed = [] if r == rev else [t for t in lst if srev.get(t.get("symbol"), rev) > r]
    return {"tickers": changed, "rev": f"{_BOOT}:{rev}", "delta": True}

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
        snap = dict(_cache)
    _write_shared(snap)                              # leader 寫共享磁碟供 follower 讀


def update_tw(tw: list):
    with _lock:
        _cache["tw"] = tw
        _cache["ts"] = time.time()
        _track("tw", tw)
        snap = dict(_cache)
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
