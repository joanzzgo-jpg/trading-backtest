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
        snap = dict(_cache)
    _write_shared(snap)                              # leader 寫共享磁碟供 follower 讀


def update_tw(tw: list):
    with _lock:
        _cache["tw"] = tw
        _cache["ts"] = time.time()
        snap = dict(_cache)
    _write_shared(snap)
