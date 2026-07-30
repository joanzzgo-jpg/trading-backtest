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


TF_SEC = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800,
          "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}


def find_holes(df, tf):
    """回傳倉庫資料的破洞 [(前一根, 後一根, 缺幾根)]。df 可為 DataFrame 或 None。

    ★為什麼一定要有這個(2026-07-30 血淚)：倉庫檔是版控的、會隨 git 上 Railway。暖機/回填只要
    中途缺一塊，那個洞就被**固化進檔案**，之後所有讀倉庫的請求都拿到有洞的資料——而且不報錯、
    不拋例外，K 線只是「少一段」。實際踩到：BTC 5m 缺 434 根、BTC/ETH 4h 各缺 10 個月，全都已
    commit 上線才被深滑 E2E 抓到。→ 寫入端(warm)與檢查端(repair)都必須跑這個。"""
    sec = TF_SEC.get(tf)
    if not sec or df is None or getattr(df, "empty", True):
        return []
    t = df["time"].tolist()
    out = []
    for i in range(1, len(t)):
        gap = (t[i] - t[i - 1]).total_seconds()
        if gap > sec:
            out.append((t[i - 1], t[i], int(gap // sec) - 1))
    return out


def repair_holes(sym: str, tf: str, exchange: str = "binance",
                 pad_days: int = 1, log=print):
    """補洞：找出破洞 → 分段重抓 → 存回。回傳 (修補前破洞數, 修補後仍存在的破洞數)。

    ★分段抓是必要的、不能圖方便一次要整段(2026-07-30 追出來的第二層根因)：
      跨過「該幣在 Binance 的永續上線日」(BTC 2019-09-08 / ETH 2019-11-27)的長區間，fapi 會回
      **非空、但只有上線後那一小截**(實測 2018-11-21~2019-09-09 只回 8 根、全在 09-08 之後)，
      而 fetch_crypto_ohlcv 的 fallback **只在完全空時才觸發** → 前面 10 個月被靜默丟掉。
      同一區間切短了問(2019-01-01~2019-01-05)就正常回 30 根。
      → 每段約 500 根：落在上線日之前的每一段 fapi 都回空 → 正常退到其他來源，才抓得到。"""
    from data.crypto import fetch_crypto_ohlcv   # 延遲匯入避免循環相依

    df = load_all(sym, tf)
    holes = find_holes(df, tf)
    if not holes:
        return 0, 0
    sec = TF_SEC[tf]
    chunk_days = max(1, int(500 * sec / 86400))
    for a, b, n in holes:
        got_all = []
        cur = a - pd.Timedelta(days=pad_days)      # 兩側留邊際 → 必與既有資料重疊，dedup 會處理
        stop = b + pd.Timedelta(days=pad_days)
        while cur < stop:
            nxt = min(cur + pd.Timedelta(days=chunk_days), stop)
            try:
                g = fetch_crypto_ohlcv(sym, tf, cur.strftime("%Y-%m-%d"),
                                       nxt.strftime("%Y-%m-%d"), exchange)
                if g is not None and not g.empty:
                    got_all.append(g)
            except Exception:
                pass                               # 單段失敗不影響其他段
            cur = nxt
        if not got_all:
            log(f"     {a} → {b}（缺 {n} 根）：資料源沒有這段")
            continue
        got = pd.concat(got_all, ignore_index=True).drop_duplicates("time").sort_values("time")
        inside = got[(got["time"] > a) & (got["time"] < b)]   # 只算真正落在缺口內的
        log(f"     {a} → {b}（缺 {n} 根）：抓到 {len(got)} 根，缺口內 {len(inside)} 根")
        if len(inside):
            save(sym, tf, got)
    left = find_holes(load_all(sym, tf), tf)
    return len(holes), len(left)


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
