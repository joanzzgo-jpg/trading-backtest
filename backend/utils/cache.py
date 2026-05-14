"""緩存管理工具"""
import time
import threading

class SimpleCache:
    """簡易記憶體緩存（Railway 記憶體有限，保持小量）"""
    def __init__(self, max_size: int = 12):
        self._cache = {}
        self._max_size = max_size
        self._lock = threading.Lock()

    def get(self, key: str, ttl: int):
        with self._lock:
            if key in self._cache:
                data, ts = self._cache[key]
                if time.time() - ts < ttl:
                    return data
                del self._cache[key]
        return None

    def set(self, key: str, data):
        now = time.time()
        with self._lock:
            expired = [k for k, (_, ts) in self._cache.items() if now - ts > 600]
            for k in expired:
                del self._cache[k]
            if len(self._cache) >= self._max_size:
                oldest = min(self._cache, key=lambda k: self._cache[k][1])
                del self._cache[oldest]
            self._cache[key] = (data, now)

    def clear(self):
        with self._lock:
            self._cache.clear()

# 全局緩存實例
cache = SimpleCache(max_size=12)
