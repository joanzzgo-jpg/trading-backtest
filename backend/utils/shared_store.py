"""跨 worker 共享 KV 層：有 REDIS_URL 就用 Redis，否則回退磁碟（.df_cache）。

用途：多 worker 下「leader 抓一次 → 寫共享層 → 所有 worker 讀」的即時報價/快照共享，
避免每個 worker 各自打 Binance（同 IP 權重會被 N 倍消耗）。

介面刻意極簡（set_blob/get_blob），失敗一律吞掉回 None/False → 呼叫端有磁碟 fallback，
Redis 掛了也不會弄壞服務（degrade gracefully）。
"""
import os
import time
import pickle

# Railway 加 Redis 服務會注入 REDIS_URL（有些方案是 REDIS_PRIVATE_URL）。都沒有 → 停用、走磁碟。
_REDIS_URL = (os.getenv("REDIS_URL") or os.getenv("REDIS_PRIVATE_URL") or "").strip()
_redis = None
_tried = False
_last_fail = 0.0        # 連線失敗後冷卻，避免每次呼叫都重試拖慢


def _client():
    """回 redis client 或 None。連線只建一次；失敗後 30s 內不重試。"""
    global _redis, _tried, _last_fail
    if _redis is not None:
        return _redis
    if not _REDIS_URL:
        return None
    now = time.time()
    if _tried and now - _last_fail < 30:
        return None
    _tried = True
    try:
        import redis
        c = redis.from_url(_REDIS_URL, socket_timeout=2, socket_connect_timeout=2,
                           retry_on_timeout=True, health_check_interval=30)
        c.ping()
        _redis = c
        print("  ✓ Redis 共享層已連線")
        return _redis
    except Exception as e:
        _last_fail = now
        print(f"  ⚠ Redis 連線失敗，改用磁碟 fallback：{str(e)[:120]}")
        return None


def enabled() -> bool:
    return _client() is not None


def set_blob(key: str, obj, ttl: int = None) -> bool:
    """pickle 後寫入。ttl 秒（None＝不過期）。失敗回 False。"""
    c = _client()
    if c is None:
        return False
    try:
        c.set(key, pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL), ex=ttl)
        return True
    except Exception:
        return False


def get_blob(key: str):
    """讀回並 unpickle。無值/失敗回 None。"""
    c = _client()
    if c is None:
        return None
    try:
        raw = c.get(key)
        return pickle.loads(raw) if raw else None
    except Exception:
        return None
