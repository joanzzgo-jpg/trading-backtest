"""全域即時 ticker 快取，由背景執行緒維護，供 API 路由直接讀取。"""
import threading

_cache = {"futures": [], "spot": [], "tw": [], "ts": 0.0}
_lock  = threading.Lock()


def get(market: str) -> list:
    with _lock:
        return list(_cache.get(market, []))


def has_data() -> bool:
    with _lock:
        return bool(_cache["futures"])


def has_tw_data() -> bool:
    with _lock:
        return bool(_cache["tw"])


def update(futures: list, spot: list):
    import time
    with _lock:
        _cache["futures"] = futures
        _cache["spot"]    = spot
        _cache["ts"]      = time.time()


def update_tw(tw: list):
    import time
    with _lock:
        _cache["tw"] = tw
        _cache["ts"] = time.time()
