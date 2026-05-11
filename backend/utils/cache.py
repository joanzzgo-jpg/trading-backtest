"""緩存管理工具"""
import time

class SimpleCache:
    """簡易記憶體緩存（Railway 記憶體有限，保持小量）"""
    def __init__(self, max_size: int = 12):
        self._cache = {}
        self._max_size = max_size
    
    def get(self, key: str, ttl: int):
        """取得緩存，檢查 TTL"""
        if key in self._cache:
            data, ts = self._cache[key]
            if time.time() - ts < ttl:
                return data
            del self._cache[key]
        return None
    
    def set(self, key: str, data):
        """設置緩存，進行 LRU 淘汰"""
        now = time.time()
        # 先淘汰所有 TTL > 600s 的過期項目
        expired = [k for k, (_, ts) in self._cache.items() if now - ts > 600]
        for k in expired:
            del self._cache[k]
        # 再依 LRU 淘汰最舊項目
        if len(self._cache) >= self._max_size:
            oldest = min(self._cache, key=lambda k: self._cache[k][1])
            del self._cache[oldest]
        self._cache[key] = (data, now)
    
    def clear(self):
        """清空所有緩存"""
        self._cache.clear()

# 全局緩存實例
cache = SimpleCache(max_size=12)
