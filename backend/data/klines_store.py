"""本機/版控 K 線倉庫(BTC/ETH/SOL/XAUT × 5m/4h/1d)。

用途:把深歷史 K 線存磁碟(gzip、版控 → 隨 git 部署到 Railway),深度歷史請求優先從這裡切片,
看深度/複盤/勝率FVG 秒開、免每塊都打交易所 API。所有電腦的用戶連 Railway 都共用這份庫。
「初次/最新」(use_limit) 一律走 API 保新鮮(庫可能沒補到最後幾根)。

- 隨 git 部署:放版控目錄 backend/data/klines5m/(沿用歷史目錄名),gzip 壓縮 → 部署包過去。
- pickle 序列化(跟 utils/disk_cache 一樣、免額外依賴)、原子寫入。
- 由 scripts/warm_5m.py 建立/更新(手動跑),暖機後 commit 一次即可(歷史靜態、最新仍即時)。
- 懶載入 + mtime memo:用到某(標的,時框)才讀磁碟。
"""
import os
import gzip
import pickle
import threading

import pandas as pd

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "klines5m")   # 沿用歷史目錄名(含所有時框)
SYMBOLS = {"BTC/USDT", "ETH/USDT", "SOL/USDT", "XAUT/USDT"}   # 存這些標的
STORE_TFS = {"5m", "4h", "1d"}                                # 存這些時框(5m近段深、4h/1d全歷史·根數少檔案小)
# 各時框保留天數(cutoff):5m 約 1 年;4h/1d 全歷史(根數少、RAM/檔案成本極低)
_KEEP_DAYS = {"5m": 370, "4h": 4000, "1d": 4500}
_lock = threading.Lock()
_memo = {}   # (norm_symbol, tf) -> (mtime, df)  避免每請求讀磁碟


def _norm(sym: str) -> str:
    s = (sym or "").upper()
    if s.endswith(".P"):
        s = s[:-2]
    return s


def is_target(symbol: str, timeframe: str) -> bool:
    return timeframe in STORE_TFS and _norm(symbol) in SYMBOLS


def _path(sym: str, tf: str) -> str:
    return os.path.join(_DIR, _norm(sym).replace("/", "_") + f"_{tf}.pkl.gz")


def load_all(sym: str, tf: str):
    p = _path(sym, tf)
    if not os.path.exists(p):
        return None
    key = (_norm(sym), tf)
    try:
        mt = os.path.getmtime(p)
        c = _memo.get(key)
        if c and c[0] == mt:
            return c[1]
        with gzip.open(p, "rb") as f:
            df = pickle.load(f)
        _memo[key] = (mt, df)
        return df
    except Exception:
        return None


def save(sym: str, tf: str, df) -> int:
    """合併既有 + 去重 + 排序 + 只保留該時框 cutoff,原子寫入。回傳存檔後總根數。"""
    if df is None or df.empty:
        return 0
    os.makedirs(_DIR, exist_ok=True)
    old = load_all(sym, tf)
    if old is not None and not old.empty:
        df = pd.concat([old, df], ignore_index=True)
    df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
    keep = _KEEP_DAYS.get(tf, 4000)
    cutoff = df["time"].iloc[-1] - pd.Timedelta(days=keep)
    df = df[df["time"] >= cutoff].reset_index(drop=True)
    p = _path(sym, tf)
    tmp = p + ".tmp"
    with _lock:
        with gzip.open(tmp, "wb", compresslevel=6) as f:
            pickle.dump(df, f)
        os.replace(tmp, p)
        _memo.pop((_norm(sym), tf), None)
    return len(df)


def load_range(symbol: str, tf: str, start: str, end: str):
    """歷史回填用:倉庫涵蓋 [start, end] 才回傳切片,否則 None → 上游走 API。"""
    if not (start and end):
        return None
    df = load_all(symbol, tf)
    if df is None or df.empty:
        return None
    try:
        rstart = pd.Timestamp(start)
        rend = pd.Timestamp(end)
    except Exception:
        return None
    smin = df["time"].iloc[0]
    smax = df["time"].iloc[-1]
    if smin > rstart or smax < rend:
        return None
    t = df["time"]
    out = df[(t >= rstart - pd.Timedelta(days=1)) & (t <= rend + pd.Timedelta(days=1))].reset_index(drop=True)
    return out if not out.empty else None


def load_from(symbol: str, tf: str, start: str):
    """回傳倉庫中 >= start 的所有資料(到倉庫最新)。倉庫夠深(涵蓋 start)才回,否則 None → 交還 API;
    呼叫端會再接「倉庫最新~今天」的新尾巴保鮮。"""
    if not start:
        return None
    df = load_all(symbol, tf)
    if df is None or df.empty:
        return None
    try:
        rstart = pd.Timestamp(start)
    except Exception:
        return None
    if df["time"].iloc[0] > rstart:      # 倉庫不夠深 → 交還 API
        return None
    out = df[df["time"] >= rstart - pd.Timedelta(days=1)].reset_index(drop=True)
    return out if not out.empty else None
