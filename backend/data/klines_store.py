"""本機 5m K 線倉庫（僅本機、僅 BTC/ETH/SOL）。

用途：把約 1 年的 5m K 線存磁碟,crypto 5m 的「歷史回填」請求(帶 start/end 的 range)優先
從這裡切片回傳 → 看深度歷史/複盤時秒開、免每塊都打 API 串流。
只加速歷史回填；「初次/最新」(use_limit) 一律走 API 保新鮮(倉庫可能沒補到最後幾根)。

- 只本機用：Railway 每次部署清空檔案系統,線上不靠這個(仍走原本 API 串流)。
- pickle 序列化(跟 utils/disk_cache 一樣、免額外依賴)、原子寫入。
- 由 scripts/warm_5m.py 建立/更新(手動跑)。
"""
import os
import pickle
import threading

import pandas as pd

_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".klines5m")
SYMBOLS = {"BTC/USDT", "ETH/USDT", "SOL/USDT"}   # 只存這三個(使用者指定)
_KEEP_DAYS = 370
_lock = threading.Lock()
_memo = {}   # norm_symbol -> (mtime, df)  避免每請求讀磁碟


def _norm(sym: str) -> str:
    s = (sym or "").upper()
    if s.endswith(".P"):
        s = s[:-2]
    return s


def is_target(symbol: str, timeframe: str) -> bool:
    return timeframe == "5m" and _norm(symbol) in SYMBOLS


def _path(sym: str) -> str:
    return os.path.join(_DIR, _norm(sym).replace("/", "_") + "_5m.pkl")


def load_all(sym: str):
    p = _path(sym)
    if not os.path.exists(p):
        return None
    key = _norm(sym)
    try:
        mt = os.path.getmtime(p)
        c = _memo.get(key)
        if c and c[0] == mt:
            return c[1]
        with open(p, "rb") as f:
            df = pickle.load(f)
        _memo[key] = (mt, df)
        return df
    except Exception:
        return None


def save(sym: str, df) -> int:
    """合併既有 + 去重 + 排序 + 只保留約 1 年,原子寫入。回傳存檔後總根數。"""
    if df is None or df.empty:
        return 0
    os.makedirs(_DIR, exist_ok=True)
    old = load_all(sym)
    if old is not None and not old.empty:
        df = pd.concat([old, df], ignore_index=True)
    df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
    cutoff = df["time"].iloc[-1] - pd.Timedelta(days=_KEEP_DAYS)
    df = df[df["time"] >= cutoff].reset_index(drop=True)
    p = _path(sym)
    tmp = p + ".tmp"
    with _lock:
        with open(tmp, "wb") as f:
            pickle.dump(df, f)
        os.replace(tmp, p)
        _memo.pop(_norm(sym), None)
    return len(df)


def load_range(symbol: str, start: str, end: str):
    """歷史回填用：倉庫涵蓋 [start, end] 才回傳切片(格式同 fetch_crypto_ohlcv),否則 None → 上游走 API。
    只服務帶 start/end 的 range 請求；初次/最新(無日期)回 None,讓 API 給最新鮮的。"""
    if not (start and end):
        return None
    df = load_all(symbol)
    if df is None or df.empty:
        return None
    try:
        rstart = pd.Timestamp(start)
        rend = pd.Timestamp(end)
    except Exception:
        return None
    smin = df["time"].iloc[0]
    smax = df["time"].iloc[-1]
    # 倉庫必須「往舊夠深(涵蓋 start)」且「往新到 end」才用;否則交還 API(避免給不完整/過期資料)
    if smin > rstart or smax < rend:
        return None
    t = df["time"]
    out = df[(t >= rstart - pd.Timedelta(days=1)) & (t <= rend + pd.Timedelta(days=1))].reset_index(drop=True)
    return out if not out.empty else None
