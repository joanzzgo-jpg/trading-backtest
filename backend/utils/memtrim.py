# -*- coding: utf-8 -*-
"""定期把用不到的記憶體還給作業系統（只有 Linux/glibc 有效）。

為什麼需要（2026-08-11 實測）
    線上 follower worker 佔 **513 MB**，但它的快取幾乎是空的
    （data_cache 6/32 只有 0.2MB、coach_cache 0/160、volatile 3/48）。
    一個把所有套件都 import 完的乾淨行程只有 **136 MB** → 差了將近 380 MB。

    量過**不是漏**：連打三輪各 12 個重請求，RSS 434→454 MB（第一輪 +20MB），
    第二、三輪各只 +0.1MB 就打平，靜置 20 秒也不降。
    這是典型的**高水位／記憶體碎片**：Python 把物件釋放回自己的配置器，
    但 glibc 不會主動把那些空頁還給作業系統 → RSS 停在「歷來尖峰」。
    ⚠ 判準就是「會不會打平」：一直線性往上長才是漏，打平＝碎片。兩者處置完全不同，
      先分清楚再動手，不然會去修一個不存在的漏。

    `malloc_trim(0)` 就是 glibc 提供來做這件事的：把 arena 裡的空閒頁還給 OS。
    Railway 是 Linux/glibc → 有效；macOS 用別的配置器 → 這支自動變成 no-op（本機量不到）。

⚠ 刻意**不呼叫 `gc.collect()`**：DataFrame 這類大物件靠引用計數就會即時釋放，
  不需要 GC；而 500MB 堆疊上的 full collect 會抓著 GIL 造成可觀的停頓。
  先只做 trim、量了再說 —— 不要一次塞兩個變因進去。
⚠ 間隔放很長（預設 5 分鐘）：trim 本身不貴，但沒必要頻繁做；它只在「剛釋放完一大塊」
  之後才有東西可還。
"""
import ctypes
import ctypes.util
import os
import sys
import threading
import time

INTERVAL_SEC = float(os.getenv("MALLOC_TRIM_SEC", "300"))
stat = {"supported": None, "runs": 0, "last_ms": None, "last_at": 0.0, "last_freed": None}

_trim = None


def _load():
    """取得 glibc 的 malloc_trim；非 glibc（macOS/musl）回 None。"""
    global _trim
    if _trim is not None:
        return _trim or None
    if not sys.platform.startswith("linux"):
        stat["supported"] = False
        _trim = False
        return None
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        fn = libc.malloc_trim
        fn.argtypes = [ctypes.c_size_t]
        fn.restype = ctypes.c_int
        _trim = fn
        stat["supported"] = True
    except Exception:
        stat["supported"] = False
        _trim = False
    return _trim or None


def _rss_mb():
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[1]) * (os.sysconf("SC_PAGE_SIZE") / (1024 * 1024))
    except Exception:
        return None


def trim_once():
    """跑一次 malloc_trim。回 (前 RSS, 後 RSS, 耗時 ms) 或 None（不支援）。"""
    fn = _load()
    if fn is None:
        return None
    before = _rss_mb()
    t = time.perf_counter()
    try:
        fn(0)
    except Exception:
        return None
    ms = (time.perf_counter() - t) * 1000
    after = _rss_mb()
    stat.update({"runs": stat["runs"] + 1, "last_ms": round(ms, 1), "last_at": time.time(),
                 "last_freed": (None if (before is None or after is None) else round(before - after, 1))})
    return before, after, ms


def _worker():
    while True:
        time.sleep(INTERVAL_SEC)
        try:
            r = trim_once()
            if r and r[0] is not None and (r[0] - r[1]) >= 5:      # 只在真的還了 ≥5MB 才出聲
                print(f"  🧹 malloc_trim 還回 {r[0] - r[1]:.0f} MB（{r[0]:.0f}→{r[1]:.0f} MB，{r[2]:.0f}ms）")
        except Exception:
            pass


def start():
    """啟動背景 trim。非 Linux 直接不啟動（省一條執行緒）。"""
    if _load() is None:
        return False
    threading.Thread(target=_worker, daemon=True, name="malloc-trim").start()
    return True
