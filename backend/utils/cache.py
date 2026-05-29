"""緩存管理工具"""
import time
import threading
from collections import OrderedDict


class SimpleCache:
    """記憶體 LRU 快取（Railway 記憶體有限，保持小量）。

    - TTL 以「寫入時間」為錨：get 時檢查，過期才刪；命中不延長 TTL。
    - 淘汰策略為真 LRU：get 命中把 key 移到尾端，容量滿時淘汰最久未存取者。

    舊版兩個問題已修正：
    1. 以「寫入時間」FIFO 淘汰（非 LRU）→ 熱門但較早寫入的項目會被踢掉。
    2. 每次 set 盲目清掉所有 >600s 的項目，導致 3 小時 TTL 的 df 快取
       只要有任何一次 set 就在 10 分鐘內被清掉（抓資料佔總時間 90%+，影響大）。
    現改為純 max_size + 逐項 TTL，記憶體上限由 max_size 明確界定。
    """
    def __init__(self, max_size: int = 12):
        self._cache: "OrderedDict[str, tuple]" = OrderedDict()  # key -> (data, set_ts)
        self._max_size = max_size
        self._lock = threading.Lock()

    def get(self, key: str, ttl: int):
        with self._lock:
            item = self._cache.get(key)
            if item is None:
                return None
            data, ts = item
            if time.time() - ts >= ttl:
                del self._cache[key]          # 逾期才刪（lazy expiry）
                return None
            self._cache.move_to_end(key)      # 標記為最近存取（LRU）
            return data

    def set(self, key: str, data):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = (data, time.time())
            while len(self._cache) > self._max_size:
                self._cache.popitem(last=False)   # 淘汰最久未存取者

    def clear(self):
        with self._lock:
            self._cache.clear()


# 一般／揮發性快取：ohlcv、即時報價、搜尋、AI 等（量多、重算便宜）
cache = SimpleCache(max_size=16)

# CRT 勝率重量級產物：fetch+enrich 的 df、勝率結果、求解結果。
# 抓資料佔總時間 90%+，與揮發性快取分池，避免被例行 ohlcv 請求擠掉。
data_cache = SimpleCache(max_size=8)
