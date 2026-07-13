"""可選的 Redis 共享快取（多實例用）。

只在設了 REDIS_URL 時啟用（Railway 加 Redis 服務會自動注入）；沒設＝完全 no-op、
單實例行為分毫不變。用途：勝率結果的跨實例共享——多實例下請求輪流打到不同實例，
各實例記憶體快取各自冷熱；有 Redis 後 A 實例算過的結果 B 實例直接拿（~10-20ms），
不用重算 5~8s。

儲存格式：zlib(level3) 壓縮的 JSON bytes（勝率 1.4MB → ~240KB；32 標的 ≈ 8MB，
免費層 Redis 也放得下）。任何 Redis 錯誤一律靜默略過 → 退回原本記憶體快取路徑。
"""
import json
import os
import zlib

_rc = None
_tried = False


def client():
    """惰性建立 Redis 連線；無 REDIS_URL / 連不上 → None（永遠 no-op）。"""
    global _rc, _tried
    if _tried:
        return _rc
    _tried = True
    url = (os.getenv("REDIS_URL") or "").strip()
    if not url:
        return None
    try:
        import redis
        _rc = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        _rc.ping()
        print("  ✓ Redis 共享快取已啟用")
    except Exception as e:
        print(f"  ⚠ Redis 連線失敗（改用純記憶體快取）：{e}")
        _rc = None
    return _rc


def enabled() -> bool:
    return client() is not None


def get_json(key: str):
    c = client()
    if c is None:
        return None
    try:
        b = c.get(key)
        return json.loads(zlib.decompress(b)) if b else None
    except Exception:
        return None


def set_json(key: str, obj, ttl: int):
    c = client()
    if c is None:
        return
    try:
        c.setex(key, int(ttl), zlib.compress(
            json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 3))
    except Exception:
        pass
