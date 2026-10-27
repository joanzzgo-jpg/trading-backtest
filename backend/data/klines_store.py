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
import time

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


_FROZEN_RUN_MIN = 3


def _drop_frozen_runs(sym: str, tf: str, df):
    """★★ 上游「半壞」時會送**零成交量、四價凍住**的填充棒 —— 這種棒不可以烘進版控倉庫。

    2026-10-27（使用者：「為什麼早上8:05-8:30 虛擬貨幣數據是平的」→「能修嗎」）：
    那段平掉的資料是 **Binance fapi 自己的 feed**（同一刻 Bybit 正常）。它的形狀是
    「連續好幾根 volume=0 且 open==high==low==close」→ 畫出來就是一條水平線。

    ★ 為什麼守在這裡而不是請求路徑：
      ・倉庫檔（`data/klines5m/*.pkl.gz`）是**版控、會隨 git 上 Railway** 的 → 壞棒一旦存進去就
        **永久固化**,而且完全不報錯（有棒、時間也對,只是價格是假的）→ 之後所有 FVG／勝率／
        回測全部建立在假棒上。這正是本檔與 claude.md 一再記錄的「倉庫會固化壞資料」。
      ・**請求路徑刻意不動**：那是使用者眼前的即時資料,當場丟掉會變成一個看得見的缺口;
        而且實測 Binance **後來會自己更正**（2026-10-27 回頭掃 18 天 × 5 個標的 26,380 根,
        零量棒 0 根 —— 當初那段現在是乾淨的）。既然會自己好,就讓倉庫晚一點再收乾淨的那份。

    ★ 門檻 `_FROZEN_RUN_MIN = 3` 是**量出來的,不是猜的**：掃過整個倉庫 488,259 根
      （含我們最清淡的標的 XAUT 代幣化黃金,鄰棒成交量只有 0.011~0.7）——
      零量棒確實有 14 根,但**連續段的最長長度是 1**。所以「連續 ≥3 根」在我們的資料宇宙裡
      不會自然發生,而使用者回報的那段（08:05~08:30 ＝ 6 根）會被抓到。
      ⚠⚠ **絕對不可以改成「任何零量棒都丟」**：XAUT 那 12 根零量、275 根四價相同是**真的**
        （那 5 分鐘真的沒人成交）—— 丟掉就是偽造資料,比保留更糟。

    ⚠ 丟掉會留下一個洞,而 `find_holes` 會把它報成**新破洞**（`repair_klines5m` 回傳 1）。
      **那是功能不是 bug**：它在說「這一段上游給的是垃圾,等它更正後再跑一次 --fix」。
      寧可留一個會自己被補掉的洞,也不要固化一段假棒（同 claude.md「寧可回空也不要回舊」）。
    ⚠ 一定要印出來：修掉之後守門員就看不到上游在吐壞資料了（同 `_scrub_latest`／
      `_fix_bar_bounds` 把丟掉/修過的棒印出來的理由）。
    """
    if df is None or getattr(df, "empty", True) or "volume" not in df.columns:
        return df, 0
    try:
        v = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
        o = pd.to_numeric(df["open"], errors="coerce")
        h = pd.to_numeric(df["high"], errors="coerce")
        lo = pd.to_numeric(df["low"], errors="coerce")
        c = pd.to_numeric(df["close"], errors="coerce")
    except Exception:
        return df, 0
    frozen = ((v <= 0) & (o == h) & (h == lo) & (lo == c)).tolist()
    runs, start = [], None
    for i, f in enumerate(frozen + [False]):
        if f and start is None:
            start = i
        elif not f and start is not None:
            if i - start >= _FROZEN_RUN_MIN:
                runs.append((start, i - 1))
            start = None
    if not runs:
        return df, 0
    drop = []
    for a, b in runs:
        drop.extend(range(a, b + 1))
        try:
            print(f"  ⚠ {sym} {tf}: 拒絕烘進倉庫 —— 上游給了 {b - a + 1} 根"
                  f"「零成交量且四價凍住」的填充棒 "
                  f"{df['time'].iloc[a]} ~ {df['time'].iloc[b]}（價 {o.iloc[a]}）。"
                  f"留洞等上游更正後再跑 --fix。")
        except Exception:
            pass
    return df.drop(df.index[drop]).reset_index(drop=True), len(drop)


def save(sym: str, tf: str, df) -> int:
    """合併既有 + 去重 + 排序 + 只保留該時框 cutoff,原子寫入。回傳存檔後總根數。

    ⚠ 寫入前先擋掉上游的「凍住填充棒」（見 `_drop_frozen_runs`）—— 這是唯一的烘烤邊界,
      暖機／`--fix`／`--extend` 三條路都走它,擋在這裡就不可能漏。
    """
    if df is None or df.empty:
        return 0
    df, _dropped = _drop_frozen_runs(sym, tf, df)
    if df is None or df.empty:
        # 整批都是填充棒 → 什麼都不寫（不是失敗,下一次 --fix 會再來）
        old = load_all(sym, tf)
        return 0 if old is None or old.empty else len(old)
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


MAX_REPAIR_CHUNKS = 400   # 單一缺口最多打幾次 API（防失控：一年份 5m 缺口在 1 天/塊下是 365 次）


def repair_holes(sym: str, tf: str, exchange: str = "binance",
                 pad_days: int = 1, log=print, pause: float = 0.35):
    """補洞：找出破洞 → 分段重抓 → 存回。回傳 (修補前破洞數, 修補後仍存在的破洞數)。

    ★分段抓是必要的、不能圖方便一次要整段(2026-07-30 追出來的第二層根因)：
      跨過「該幣在 Binance 的永續上線日」(BTC 2019-09-08 / ETH 2019-11-27)的長區間，fapi 會回
      **非空、但只有上線後那一小截**(實測 2018-11-21~2019-09-09 只回 8 根、全在 09-08 之後)，
      而 fetch_crypto_ohlcv 的 fallback **只在完全空時才觸發** → 前面 10 個月被靜默丟掉。
      同一區間切短了問(2019-01-01~2019-01-05)就正常回 30 根。
      → 每段約 500 根：落在上線日之前的每一段 fapi 都回空 → 正常退到其他來源，才抓得到。

    ★限流保護（三道，缺一不可）：分段抓的代價就是「請求變多」——
      ① 每段之間 sleep(pause)：Binance fapi 是 10 次/秒/IP，撞到 418/429 會**全域熔斷 60 秒，
         而且重試會 +10 秒永遠清不掉**（見 CLAUDE.md）。0.35s/次 ≈ 3 次/秒，留足餘裕。
      ② 開跑前檢查 _BINANCE_COOLDOWN_UNTIL：已在冷卻就直接放棄這輪（硬打只會把冷卻拉更長）。
      ③ MAX_REPAIR_CHUNKS 上限：缺口異常大時停手並回報，不讓它無限打下去。"""
    from data.crypto import fetch_crypto_ohlcv   # 延遲匯入避免循環相依
    import data.crypto as _c

    _cd = getattr(_c, "_BINANCE_COOLDOWN_UNTIL", 0) or 0
    if time.time() < _cd:
        log(f"     ⚠ Binance 冷卻中（剩 {_cd - time.time():.0f}s）→ 這輪不補，稍後再跑")
        return 0, len(find_holes(load_all(sym, tf), tf))

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
        hit = 0
        while cur < stop:
            if hit >= MAX_REPAIR_CHUNKS:
                log(f"     ⚠ 已打滿 {MAX_REPAIR_CHUNKS} 次仍未補完，停手（缺口過大，分次跑）")
                break
            if time.time() < (getattr(_c, "_BINANCE_COOLDOWN_UNTIL", 0) or 0):
                log("     ⚠ 中途撞上 Binance 冷卻 → 停手，已抓到的照存")
                break
            nxt = min(cur + pd.Timedelta(days=chunk_days), stop)
            try:
                g = fetch_crypto_ohlcv(sym, tf, cur.strftime("%Y-%m-%d"),
                                       nxt.strftime("%Y-%m-%d"), exchange)
                if g is not None and not g.empty:
                    got_all.append(g)
            except Exception:
                pass                               # 單段失敗不影響其他段
            hit += 1
            cur = nxt
            if pause and cur < stop:
                time.sleep(pause)                  # ★節流：見上方「限流保護」
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
