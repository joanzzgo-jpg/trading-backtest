"""DataFrame 磁碟快取——讓重量級 fetch+enrich 的結果跨重啟 / 重新部署存活。

只用於勝率回測的 enriched df（`crt_df`）。記憶體快取（`data_cache`）重啟即失，
Railway 每次部署都會清空 → 部署後第一個使用者又要等一次抓取。尤其 Pionex 獨有
小幣的 K 線抓取慢且受 10 req/s 限流，存檔後「抓一次就一勞永逸」，也減少 Pionex 呼叫。

- 序列化用 pickle（內建、免額外依賴；跨 pandas 版本失敗就當 cache miss 重抓，安全）。
- 原子寫入（寫 tmp 再 os.replace）避免半寫檔。
- TTL 由檔案 mtime 判斷；檔數超過上限時淘汰最舊（避免無限長大）。
"""
import os
import time
import pickle
import hashlib
import threading

_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".df_cache")
_MAX_FILES = 60          # 上限：約 60 個標的×時框的 enriched df（每個數 MB）
_lock = threading.Lock()


def _path(key: str) -> str:
    h = hashlib.md5(key.encode("utf-8")).hexdigest()
    return os.path.join(_DIR, h + ".pkl")


def get(key: str, ttl: int):
    """未過期則回傳 df，否則 None。任何讀取/反序列化錯誤都當 miss。"""
    p = _path(key)
    try:
        if os.path.exists(p) and (time.time() - os.path.getmtime(p)) < ttl:
            with open(p, "rb") as f:
                return pickle.load(f)
    except Exception:
        pass
    return None


def set(key: str, df) -> None:
    try:
        with _lock:
            os.makedirs(_DIR, exist_ok=True)
            p = _path(key)
            tmp = f"{p}.{os.getpid()}.{threading.get_ident()}.tmp"
            with open(tmp, "wb") as f:
                pickle.dump(df, f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, p)   # 原子置換
            _evict_if_needed()
    except Exception:
        pass


def _evict_if_needed() -> None:
    try:
        files = [os.path.join(_DIR, f) for f in os.listdir(_DIR) if f.endswith(".pkl")]
        if len(files) > _MAX_FILES:
            files.sort(key=os.path.getmtime)        # 最舊在前
            for old in files[:len(files) - _MAX_FILES]:
                try:
                    os.remove(old)
                except OSError:
                    pass
    except Exception:
        pass
