"""
台股資料抓取 - 歷史日線用 FinMind，分鐘/小時用 yfinance（不需 token）
"""
import re as _re
import time as _time
import threading as _threading
import logging
import pandas as pd
import requests

from utils.http_pool import SESSION   # 共用連線池（省掉每次 TLS 交握，見該模組）
from datetime import datetime, timedelta, date

_log = logging.getLogger("taiwan")

FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data"


def fetch_tw_stock(symbol: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """
    抓取台股 OHLCV 資料
    symbol: 股票代號，例如 "2330" (台積電)
    start/end: "YYYY-MM-DD"
    """
    params = {
        "dataset": "TaiwanStockPrice",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = SESSION.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind API 錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的資料")

    df = pd.DataFrame(records)
    df = df.rename(columns={
        "date": "time",
        "open": "open",
        "max": "high",
        "min": "low",
        "close": "close",
        "Trading_Volume": "volume",
    })
    df["time"] = pd.to_datetime(df["time"])
    df = df[["time", "open", "high", "low", "close", "volume"]].copy()
    df = df.sort_values("time").reset_index(drop=True)

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df


def resample_tw(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """將日線資料聚合為週線或月線"""
    if timeframe == "1d":
        return df
    # 月線用 ME（月末最後一天），與台股月K對齊；週線用週五
    rule = {"1w": "W-FRI", "1M": "ME"}.get(timeframe, "1d")
    df = df.set_index("time")
    resampled = df.resample(rule).agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open"])
    resampled = resampled.reset_index()
    return resampled


def fetch_tw_intraday(symbol: str, timeframe: str, start: str, end: str, api_token: str = "") -> pd.DataFrame:
    """抓取台股分鐘 K 線並聚合為 5m / 15m / 1h"""
    params = {
        "dataset": "TaiwanStockPriceMinute",
        "data_id": symbol,
        "start_date": start,
        "end_date": end,
        "token": api_token,
    }
    resp = SESSION.get(FINMIND_API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("status") != 200:
        raise ValueError(f"FinMind 分鐘資料錯誤: {data.get('msg', '未知錯誤')}")

    records = data.get("data", [])
    if not records:
        raise ValueError(f"找不到 {symbol} 的分鐘資料（需登入 FinMind 免費帳號取得 token）")

    df = pd.DataFrame(records)
    # FinMind 分鐘資料欄位: date, Time, open, high, low, close, volume
    time_col  = "date" if "date" in df.columns else "Date"
    clock_col = "Time" if "Time" in df.columns else "time"
    df["time"] = pd.to_datetime(df[time_col].astype(str) + " " + df[clock_col].astype(str))

    col_map = {}
    for c in df.columns:
        cl = c.lower()
        if cl in ("open","high","low","close","volume") and c not in col_map.values():
            col_map[c] = cl
    df = df.rename(columns=col_map)
    df = df[["time","open","high","low","close","volume"]].copy()
    for c in ["open","high","low","close","volume"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.sort_values("time").dropna(subset=["open"]).reset_index(drop=True)

    rule = {"5m": "5min", "15m": "15min", "1h": "h"}.get(timeframe, "5min")
    df = df.set_index("time")
    df = df.resample(rule).agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"})
    df = df.dropna(subset=["open"]).reset_index()
    return df


YF_TF_MAP = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "1h"}  # yfinance 不支援 4h，用 1h 替代

# yfinance 各 interval 最多可回溯天數
# 注意：1h 改用 15m 內部重採樣（避開 yfinance 1h 對台股的成交量缺漏 bug），
# 所以實際 1h 上限受 15m 60 天限制
# 留 2 天 buffer：yfinance 邊界嚴格小於、fetch_tw_intraday_yf 又會 end+1 → 一共佔 2 天
YF_MAX_DAYS = {"1m": 7, "5m": 58, "15m": 58, "1h": 58}   # 1m yfinance 僅近 7 天


def _yf_history(ticker, interval: str, start: str, end: str):
    """呼叫 yfinance history，回傳 DataFrame；空或失敗回 None。
    ⚠ 一律加 timeout：雲端(Railway)常被 Yahoo tarpit(連上不回應)，無 timeout 會無限卡死→備援永不觸發。"""
    # auto_adjust=False：要「實際成交價」而非還原股價。台股最小跳動 0.01（≤2 位小數），
    # 還原股價會除以除權息/分割調整係數 → 產生 97.345 這種不符檔位的第 3 位小數怪值，
    # 且與日線主源 FinMind（未還原原始價）對不起來。關掉調整 → 價格真實、符合檔位、跨時框一致
    # （代價：除權息日會有真實除息跳空，反而更忠實）。
    try:
        try:
            raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=False, timeout=12)
        except TypeError:   # 舊版 history 不吃 timeout
            raw = ticker.history(start=start, end=end, interval=interval, auto_adjust=False)
        return raw if not raw.empty else None
    except Exception as e:
        _log.warning(f"[yf_history] {ticker.ticker} {interval} {start}~{end}: {e}")
        return None



# ══════════════════════════════════════════════════════════════
#  分割／減資自動還原（2026-09-10 使用者：「若有拆股的標的自動換算價格」）
#
#  ⚠ 為什麼不用 yfinance 的 .splits：**它會漏**。實測 6949 沛爾生醫*-創 2026-09-07
#    做了 1:20 分割，yfinance 的 splits 回「無」（太新、又是創新板）→ 圖上留下一個
#    -94.5% 的假崩盤（停牌 7 天、1490 → 81.9）。舊案例（6415/2603/6669）它有收錄，
#    所以「資料源已經處理好」只對舊事件成立，不能當通則。
#  ⚠ 官方 opendata 也沒有：除權息預告表(TWT48U_ALL)只收除權除息，
#    面額變更/分割屬於另一種公司行動，不在裡面。
#
#  → 改用**資料本身**判斷，不依賴任何 split feed：
#    台股有 ±10% 漲跌幅限制 → 跳空超過門檻在數學上不可能，除非發生公司行動。
#    而且限制反過來把比例夾在很窄的範圍：
#      還原後的前收 = 前收/R，且「開盤必須落在它的 ±10% 內」
#      → R ∈ [前收/(開×1.1), 前收/(開×0.9)]
#    在這個範圍裡找**乾淨的比例**（整數倍，或 1/2、2/5 這類簡單減資比）。
#    6949：R ∈ [16.5, 20.2] → 唯一乾淨解 = 20（1490÷20 = 74.5，開 81.95 正好漲停）。
#
#  ★★ 找不到乾淨解就**原樣不動** —— 寧可留著那個跳空，也不要編一個比例把歷史整段改掉。
#     （錯的還原比沒有還原更糟：使用者看不出來，但每個價格都是假的。）
# ══════════════════════════════════════════════════════════════
_TW_LIMIT = 0.10            # 台股單日漲跌幅限制
_TW_GAP_TRIGGER = 0.18      # 跳空超過這個才懷疑公司行動（留足夠緩衝，不誤判正常行情）
# 乾淨比例候選：分割（1股變 N 股）與減資（N 股併 1 股 / 常見減資比例）
_TW_CLEAN_RATIOS = [2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 40, 50, 100]
_TW_CLEAN_RATIOS += [1/2, 2/5, 1/4, 3/10, 1/5, 3/5, 7/10, 1/10, 4/5, 9/10]


def _tw_clean_ratio(lo: float, hi: float):
    """在 [lo,hi] 範圍內找唯一一個「乾淨」的比例；找不到或有多個 → None（不還原）。"""
    hits = [r for r in _TW_CLEAN_RATIOS if lo <= r <= hi]
    if len(hits) != 1:
        return None
    return hits[0]


# ── 官方係數（比猜的準）───────────────────────────────────────────────
#  2026-09-10 抓到的實例：6901 亞果生醫 2022-11-23 開 77.54、前一天收 62.66
#  ＝ **+23.75% 的跳空**，台股 ±10% 之下不可能 —— 是 yfinance 把當年的
#  現金增資/股票股利記成「1.27 分割」，卻只調整了一半的資料所留下的假斷崖。
#  乾淨比例只猜得到 0.8（真值 1/1.27 = 0.7874，差 1.6%），而 yfinance 自己
#  就有那個係數 → 有記錄就用**精確值**，沒記錄（6949 那種新分割）才退回用猜的。
#  ⚠ 只在「係數落在漲跌幅推出來的窗口內」時才採用：對不上就代表那筆記錄跟這個
#    跳空無關（日期錯位／別的事件），寧可不用也不要拿錯的係數改歷史。
#  ⚠ 只有**偵測到跳空**才會來問（一般標的一次都不問），並快取 12 小時 ——
#    這支會被每一次台股日線請求呼叫，不可以在常見路徑上多打一次網路。
_TW_SPLIT_FEED: dict = {}          # symbol → (取得時刻, {date: 係數})
_TW_SPLIT_FEED_TTL = 12 * 3600


def _tw_split_feed(symbol: str) -> dict:
    """yfinance 登記的分割係數 {date: 係數}；抓不到回空 dict（不是錯誤，多數股票本來就沒有）。"""
    import time as _t
    hit = _TW_SPLIT_FEED.get(symbol)
    if hit and _t.time() - hit[0] < _TW_SPLIT_FEED_TTL:
        return hit[1]
    out = {}
    try:
        import yfinance as yf
        for suffix in (".TW", ".TWO"):
            try:
                sp = yf.Ticker(f"{symbol}{suffix}").splits
            except Exception:
                continue
            if sp is None or len(sp) == 0:
                continue
            for k, v in sp.items():
                try:
                    out[pd.Timestamp(k).tz_localize(None).date()] = float(v)
                except Exception:
                    continue
            break
    except Exception:
        pass
    _TW_SPLIT_FEED[symbol] = (_t.time(), out)
    return out


def _tw_feed_ratio(symbol: str, when, lo: float, hi: float):
    """這一天有沒有登記的分割係數？有且落在 [lo,hi] 內就回它（精確值），否則 None。"""
    if not symbol:
        return None
    feed = _tw_split_feed(symbol)
    if not feed:
        return None
    try:
        d0 = pd.Timestamp(when).date()
    except Exception:
        return None
    for dd, fac in feed.items():
        if abs((dd - d0).days) > 2 or not fac:      # 日期允許差 2 天（來源常錯位一天）
            continue
        for cand in (1.0 / fac, float(fac)):        # 除以係數才是「換算回現在的股數基準」
            if lo <= cand <= hi:
                return cand
    return None


def tw_adjust_splits(df, symbol: str = ""):
    """把分割/減資**之前**的價格換算成現在的股數基準（量同步反向調整）。

    ⚠ 日期一律看 time 欄位：本檔 fetch_tw_daily_yf 回的是 RangeIndex + time 欄位，
      拿 df.index 當日期會變成 1970 年 → 條件對每一根都成立 → **整份資料（含最新價）
      全被除掉**（實測 6415 最新收盤 404 被改成 101，而後面 tw_daily_fill_latest 又會
      用官方值蓋回最後一根 → 最新價看起來是對的、只有歷史全錯，最難發現的那種）。
    ⚠ 由新往舊掃、比例累乘：跨越兩次分割的舊資料要除以兩者的乘積。
    """
    try:
        if df is None or getattr(df, "empty", True) or len(df) < 3:
            return df
        need = ("open", "high", "low", "close")
        if not all(c in df.columns for c in need):
            return df
        t = pd.to_datetime(df["time"]) if "time" in df.columns else pd.to_datetime(df.index)
        c = df["close"].astype(float).values
        o = df["open"].astype(float).values
        events = []                                   # (位置, 比例) —— 位置之前的都要除
        for i in range(1, len(df)):
            pc, op = c[i - 1], o[i]
            if not (pc > 0 and op > 0):
                continue
            if abs(op - pc) / pc < _TW_GAP_TRIGGER:   # 沒有異常跳空 → 不是公司行動
                continue
            lo = pc / (op * (1 + _TW_LIMIT))
            hi = pc / (op * (1 - _TW_LIMIT))
            _lo, _hi = min(lo, hi), max(lo, hi)
            # 先問官方係數（精確），沒登記才退回「唯一乾淨解」那套猜法
            # ⚠ 興櫃**沒有漲跌幅限制** → 「跳空超過漲跌幅＝公司行動」這個前提對它不成立，
            #   真實的一日大漲大跌會被猜成分割比例、把整段歷史除掉。興櫃只認官方登記的係數。
            r = _tw_feed_ratio(symbol, t.iloc[i], _lo, _hi)
            if not r and str(symbol).strip() not in esb_codes():
                r = _tw_clean_ratio(_lo, _hi)
            if r:
                events.append((i, r))
        if not events:
            return df
        out = df.copy()
        div = pd.Series(1.0, index=df.index)
        for i, r in events:
            div.iloc[:i] *= r                         # 這次事件之前的全部要除
        for col in need:
            out[col] = (out[col].astype(float) / div).round(4)
        if "volume" in out.columns:
            out["volume"] = (out["volume"].astype(float) * div).round(0)
        _log.info(f"[tw_splits] {symbol}: 偵測到 {len(events)} 次分割/減資 "
                  f"{[(str(t.iloc[i])[:10], round(r, 4)) for i, r in events]}")
        return out
    except Exception as e:
        _log.warning(f"[tw_adjust_splits] {symbol}: {e}")
        return df

# ── 興櫃(ESB)日線：官方 TPEX「興櫃個股歷史行情」──────────────────────────────
#   2026-09-12 使用者：「7887日Ｋ怪怪的」「我看其他看盤軟體都很多」。
#   根因：興櫃股在 yfinance 幾乎沒有歷史（實測 7887 只有 4 根：2026-09-08 起），
#   而官方其實有（TPEX 這支端點回得到 2026-03 以來每一天）。
#   ⚠ 興櫃公開資料**沒有開盤價、也沒有收盤價**，只有 成交最高/最低/均價/股數/筆數：
#     ・收盤 ← 官方均價（興櫃的漲跌本來就是以「前一日均價」為基準算的，行情列那份也是）
#     ・開盤 ← 前一日均價，且**必須夾進當日高低區間**。不夾就會生出「開盤價高於最高價」的
#       不可能 K 棒 —— FinMind 的興櫃資料就是沒夾（實測 7887 2026-09-11：開 153.55 > 高 152.00），
#       那種棒會被 check_bar_invariants 判定資料壞掉，也會讓所有策略計算失真。
_ESB_HIST_CACHE = {}                      # (code, y, m) -> (寫入時間, rows)
_ESB_CODES_CACHE = {"ts": 0.0, "codes": set()}
_ESB_HDRS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def esb_codes() -> set:
    """目前的興櫃代號集合（TPEX 當日行情表，300 多檔）。10 分鐘快取；抓不到回空集合＝不啟用興櫃路徑。"""
    now = _time.time()
    if _ESB_CODES_CACHE["codes"] and now - _ESB_CODES_CACHE["ts"] < 600:
        return _ESB_CODES_CACHE["codes"]
    try:
        r = SESSION.get(TPEX_ESB_URL, headers=_ESB_HDRS, timeout=15)
        r.raise_for_status()
        codes = {str(d.get("SecuritiesCompanyCode", "")).strip()
                 for d in r.json() if str(d.get("SecuritiesCompanyCode", "")).strip()}
        if codes:
            _ESB_CODES_CACHE.update(ts=now, codes=codes)
    except Exception as e:
        _log.warning(f"[esb] 興櫃代號清單抓取失敗: {e}")
    return _ESB_CODES_CACHE["codes"]


def _esb_month(code: str, y: int, m: int) -> list:
    """抓某檔某個月的興櫃日成交（回原始列）。過去月份的資料不會再變 → 快取 7 天，當月 10 分鐘。"""
    key = (code, y, m)
    hit = _ESB_HIST_CACHE.get(key)
    today = date.today()
    ttl = 600 if (y == today.year and m == today.month) else 7 * 86400
    if hit and _time.time() - hit[0] < ttl:
        return hit[1]
    rows = []
    try:
        r = SESSION.get(TPEX_ESB_HIST_URL, headers=_ESB_HDRS, timeout=20,
                        params={"code": code, "date": f"{y}/{m:02d}/01", "response": "json"})
        r.raise_for_status()
        j = r.json()
        for t in (j.get("tables") or []):
            if t.get("data"):
                rows = t["data"]
                break
    except Exception as e:
        _log.warning(f"[esb] {code} {y}/{m:02d} 歷史抓取失敗: {e}")
        return hit[1] if hit else []
    _ESB_HIST_CACHE[key] = (_time.time(), rows)
    return rows


def fetch_esb_daily(symbol: str, start: str, end: str = "", max_months: int = 24) -> pd.DataFrame:
    """興櫃個股日線（官方）。回 time/open/high/low/close/volume；抓不到回空 DataFrame。

    ⚠ 一個月一個請求 → 由新往舊掃，連續兩個月沒資料就停（＝上興櫃之前）；再加 max_months 上限，
      免得使用者把時間軸拉到很早時對官方站狂打幾十次。
    """
    cols = ["time", "open", "high", "low", "close", "volume"]
    try:
        s_date = date.fromisoformat(start) if start else (date.today() - timedelta(days=365))
    except Exception:
        s_date = date.today() - timedelta(days=365)
    cur = date.today().replace(day=1)
    out, empty_run = [], 0
    for _ in range(max_months):
        rows = _esb_month(symbol, cur.year, cur.month)
        if not rows:
            empty_run += 1
            if empty_run >= 2:
                break
        else:
            empty_run = 0
            for r in rows:
                try:
                    roc = str(r[0]).split("/")
                    d = date(int(roc[0]) + 1911, int(roc[1]), int(roc[2]))
                    vol = float(str(r[1]).replace(",", "") or 0)
                    hi  = float(str(r[3]).replace(",", "") or 0)
                    lo  = float(str(r[4]).replace(",", "") or 0)
                    avg = float(str(r[5]).replace(",", "") or 0)
                except (ValueError, IndexError, TypeError):
                    continue
                if vol <= 0 or avg <= 0 or hi <= 0 or lo <= 0:
                    continue                                  # 當天沒成交 → 沒有 K 棒
                out.append((d, hi, lo, avg, vol))
        cur = (cur - timedelta(days=1)).replace(day=1)         # 往前一個月
        if cur < s_date.replace(day=1):
            break
    if not out:
        return pd.DataFrame(columns=cols)
    out.sort(key=lambda x: x[0])
    recs, prev_avg = [], None
    for d, hi, lo, avg, vol in out:
        op = avg if prev_avg is None else min(max(prev_avg, lo), hi)   # 開盤＝前一日均價，夾進當日區間
        recs.append({"time": pd.Timestamp(d), "open": round(op, 2), "high": round(hi, 2),
                     "low": round(lo, 2), "close": round(avg, 2), "volume": vol})
        prev_avg = avg
    df = pd.DataFrame(recs, columns=cols)
    if end:
        try:
            df = df[df["time"] <= pd.Timestamp(date.fromisoformat(end))]
        except Exception:
            pass
    return df.reset_index(drop=True)


def tw_esb_backfill(df, symbol: str, start: str):
    """興櫃：把官方歷史補在 yfinance 那幾根**前面**（yfinance 幾乎沒有興櫃歷史）。

    ⚠ yfinance 有的那幾天維持原樣不覆蓋：那幾根是真實的開高低收（第一筆/最後一筆成交），
      比官方那份「均價當收盤」更貼近其他看盤軟體；官方那份只用來補它沒有的歷史。
    非興櫃、或官方也沒有資料 → 原樣回傳（完全不影響上市櫃）。
    """
    try:
        code = str(symbol).strip()
        if code not in esb_codes():
            return df
        have = 0
        first = None
        if df is not None and not getattr(df, "empty", True) and "time" in df.columns:
            have = len(df)
            first = pd.to_datetime(df["time"]).min()
        old = fetch_esb_daily(code, start)
        if old is None or old.empty:
            return df
        if first is not None:
            old = old[pd.to_datetime(old["time"]) < first]
        if old.empty:
            return df
        merged = old if not have else pd.concat([old, df], ignore_index=True)
        merged = merged.sort_values("time").drop_duplicates(subset="time", keep="last").reset_index(drop=True)
        _log.info(f"[esb] {code} 興櫃歷史補齊：yfinance {have} 根 → {len(merged)} 根")
        return merged
    except Exception as e:
        _log.warning(f"[esb] {symbol} 歷史補齊失敗: {e}")
        return df


def fetch_tw_daily_yf(symbol: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股日線資料（不需 token，盤中即更新）。
    先試 .TW 再試 .TWO；end 自動 +1 天確保包含當日。
    """
    import yfinance as yf
    try:
        end_incl = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    except Exception:
        end_incl = (date.today() + timedelta(days=1)).isoformat()
    for suffix in (".TW", ".TWO"):
        raw = _yf_history(yf.Ticker(f"{symbol}{suffix}"), "1d", start, end_incl)
        if raw is None:
            continue
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.columns = ["open", "high", "low", "close", "volume"]
        idx = pd.to_datetime(df.index)
        if idx.tz is not None:
            idx = idx.tz_convert("Asia/Taipei").tz_localize(None)
        idx = idx.normalize()
        df.index = idx
        df.index.name = "time"
        df = df.reset_index()
        df["time"] = pd.to_datetime(df["time"])
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        for col in ["open", "high", "low", "close"]:   # 台股≤2位小數→消 yfinance float32 精度雜訊
            df[col] = df[col].round(2)
        return df.dropna(subset=["close"])
    raise ValueError(f"找不到 {symbol} 的日線資料（yfinance .TW/.TWO 均失敗）")


def fetch_tw_intraday_yf(symbol: str, timeframe: str, start: str, end: str) -> pd.DataFrame:
    """
    用 yfinance 抓台股分鐘/小時資料（不需 token）。
    先試 .TW 再試 .TWO；若指定範圍失敗，自動縮短至近 30 天重試。

    注意：1h 改用 15m 內部重採樣（避開 yfinance 1h 對台股的「成交量缺漏 + 開盤
    錯位」bug——yfinance 直接抓 1h 會少 35% 成交量、第一根落在 10:00 而非 09:00）。
    """
    import yfinance as yf

    # 1h 內部用 15m 重組（解決 yfinance 1h bug）
    src_tf      = "15m" if timeframe == "1h" else timeframe
    interval    = YF_TF_MAP.get(src_tf, "1h")
    # yfinance end 不含當天，+1 天確保抓到今日資料
    end_incl    = (date.today() + timedelta(days=1)).isoformat()
    short_start = (date.today() - timedelta(days=30)).isoformat()
    end_incl_req = (date.fromisoformat(end) + timedelta(days=1)).isoformat() if end else end_incl

    for suffix in (".TW", ".TWO"):
        ticker = yf.Ticker(f"{symbol}{suffix}")
        raw = _yf_history(ticker, interval, start, end_incl_req)
        if raw is None:
            raw = _yf_history(ticker, interval, short_start, end_incl)
        if raw is None:
            continue
        df = raw[["Open", "High", "Low", "Close", "Volume"]].copy()
        df.columns = ["open", "high", "low", "close", "volume"]
        idx = pd.to_datetime(df.index)
        if idx.tz is None:
            idx = idx.tz_localize("Asia/Taipei")
        idx = idx.tz_convert("UTC").tz_localize(None)
        df.index = idx
        df.index.name = "time"
        df = df.reset_index()
        # Floor to bar boundary so partial/in-progress bars (e.g. stamped 11:40
        # by yfinance instead of 11:00) align to clean period starts.
        src_freq = {"1m": "1min", "5m": "5min", "15m": "15min"}.get(src_tf, "60min")
        df["time"] = pd.to_datetime(df["time"]).dt.floor(src_freq)
        df = df.drop_duplicates(subset=["time"], keep="last").reset_index(drop=True)
        df = df.dropna(subset=["close"])
        # ─ TW 開盤集合競價過濾 ──────────────────────────────
        # yfinance 對台股 15m/1h 在 09:00 會放一根 vol=0「集合競價快照」棒：
        # 第一根 1h「10:00」實際缺資料，第一根 15m「09:00」有資料但若 yfinance
        # 回傳 vol=0 就濾掉。一律過濾以避免長影線誤導圖表。
        df = df[df["volume"] > 0].reset_index(drop=True)
        # ─ 台股交易時間過濾（09:00-13:30 Taipei）──────────
        # 防 yfinance 偶爾回傳 13:30 收盤集合競價 bar 或盤前/盤後 bar
        tpe_min = ((df["time"].dt.hour + 8) % 24) * 60 + df["time"].dt.minute
        df = df[(tpe_min >= 9 * 60) & (tpe_min < 13 * 60 + 30)].reset_index(drop=True)
        # ─ 1h 內部重採樣（15m → 1h，對齊台北 09:00 為第一根） ──
        # 用 origin="start_day" + offset="1h" 把 1h bins 對齊到 UTC 01:00（=台北
        # 09:00），讓第一根 1h 包含 09:00-09:59 完整成交量（解決 yfinance 1h bug）。
        if timeframe == "1h":
            df = df.set_index("time").resample(
                "1h", origin="start_day", offset="1h"
            ).agg({
                "open": "first", "high": "max", "low": "min",
                "close": "last", "volume": "sum",
            }).dropna(subset=["open"]).reset_index()
        # 台股價格最多 2 位小數（下單也只到 2 位）→ 四捨五入消 yfinance float32 精度雜訊
        # （如 96.4 存成 float32 = 96.4000015；0.05/0.1 跳動的中低價股才會冒出假小數）。
        for _c in ("open", "high", "low", "close"):
            df[_c] = df[_c].round(2)
        return df
    raise ValueError(f"找不到 {symbol} 的分鐘資料（請確認代號正確，例如 2330）")


TWSE_MIS_URL     = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
TWSE_MIS_HEADERS = {"Referer": "https://mis.twse.com.tw/stock/index.jsp"}
# TWSE opendata：全上市股票每日行情（盤中更新）
TWSE_DAY_ALL_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
# TPEX opendata：全上櫃股票每日行情
TPEX_DAY_ALL_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
# 興櫃即時統計（含最新成交價/均價/量）。興櫃沒有收盤集合競價 → 漲跌以「前一日均價」為基準。
TPEX_ESB_URL     = "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics"
# 興櫃個股「歷史行情」（一次一個月；ROC 日期）。openapi 只有當日行情表，歷史只有這支新站端點。
TPEX_ESB_HIST_URL = "https://www.tpex.org.tw/www/zh-tw/emerging/historical"

# 備援熱門清單（opendata 失敗時用 MIS 抓這 50 支）
TW_POPULAR = [
    ("2330","tse"),("2317","tse"),("2454","tse"),("2412","tse"),("2308","tse"),
    ("2382","tse"),("2881","tse"),("2882","tse"),("2886","tse"),("2891","tse"),
    ("2884","tse"),("2885","tse"),("2892","tse"),("2002","tse"),("1301","tse"),
    ("1303","tse"),("1326","tse"),("2357","tse"),("2303","tse"),("3711","tse"),
    ("2379","tse"),("2395","tse"),("4904","tse"),("4938","tse"),("3034","tse"),
    ("3008","tse"),("2327","tse"),("2376","tse"),("2408","tse"),("5880","tse"),
    ("2890","tse"),("6505","tse"),("1216","tse"),("2912","tse"),("2301","tse"),
    ("2353","tse"),("2409","tse"),("3045","tse"),("2887","tse"),("2615","tse"),
    ("2603","tse"),("2609","tse"),("2610","tse"),("2618","tse"),("2883","tse"),
    ("2880","tse"),("2337","tse"),("6669","otc"),("3231","otc"),("6770","tse"),
]

TW_NAME_MAP = {
    "2330":"台積電","2317":"鴻海","2454":"聯發科","2412":"中華電","2308":"台達電",
    "2382":"廣達","2881":"富邦金","2882":"國泰金","2886":"兆豐金","2891":"中信金",
    "2884":"玉山金","2885":"元大金","2892":"第一金","2002":"中鋼","1301":"台塑",
    "1303":"南亞","1326":"台化","2357":"華碩","2303":"聯電","3711":"日月光投控",
    "2379":"瑞昱","2395":"研華","4904":"遠傳","4938":"和碩","3034":"聯詠",
    "3008":"大立光","2327":"國巨","2376":"技嘉","2408":"南亞科","5880":"合庫金",
    "2890":"永豐金","6505":"台塑化","1216":"統一","2912":"統一超","2301":"光寶科",
    "2353":"宏碁","2409":"友達","3045":"台灣大","2887":"台新金","2615":"萬海",
    "2603":"長榮","2609":"陽明","2610":"華航","2618":"長榮航","2883":"開發金",
    "2880":"華南金","2337":"旺宏","6669":"緯穎","3231":"緯創","6770":"力積電",
}


def _parse_tw_change(s: str) -> float:
    """解析 TWSE/TPEX 漲跌字串，正負均支援（含 ▲▼ 或 +- 前綴）。"""
    s = (s or "").strip()
    if not s or s in ("---", "--", ""):
        return 0.0
    neg = s.startswith("-") or "▼" in s
    clean = _re.sub(r"[^0-9.]", "", s)
    if not clean:
        return 0.0
    val = float(clean)
    return -val if neg else val


# ── opendata 條件式抓取（2026-08-01）─────────────────────────────────────────
# ★_tw_ticker_worker 每 30 秒抓這兩包，但它們**一天只變一次**：
#     TWSE Last-Modified 05:20（台北）、TPEX 15:30 GMT＝23:30（台北），都是收盤後才更新。
#   而每輪要下載 429KB（gzip 後：TWSE 72KB + TPEX 357KB；解壓後是 310KB + 3886KB）
#   → 一天 2880 輪 ≈ **1.24GB 下載 + 每輪 1.79 秒的解析**，其中 2878 輪內容一模一樣。
#   兩邊都給 ETag/Last-Modified 且實測支援 304（回 0 bytes、8ms/28ms）→ 帶條件標頭即可。
# ⚠ 逐來源各自快取「解析結果」，不可只留一份合併後的：兩包更新時間不同（相差數小時），
#   若只留合併結果，TWSE 變而 TPEX 沒變的那一輪就會把 TPEX 的資料整批弄丟。
# 條件式抓取的驗證碼快取 —— **鍵是 (url, 用途)，不是只有 url**。
# ★為什麼要帶「用途」：同一份 opendata 有兩個消費者，而且各自把解析結果存在不同地方
#   （清單 → _TW_DUMP[...]["payload"]；日線 → _TW_DAY_SRC[url]["rows"]）。
#   若驗證碼只用 url 當鍵、兩邊共用，就會出現「A 存了 ETag 但沒有 A 的結果，B 拿到 304
#   卻沒東西可用」→ 實測台股清單從 1972 檔掉到 50 檔，而且因為檔案內容真的沒變會一直
#   304 下去，**要等隔天檔案更新才會自己好**。
#   分開存之後，每個用途的「驗證碼」與「它自己的結果」永遠成對出現，別的呼叫端動不到，
#   這個 bug 從結構上就不可能再發生（而不是靠呼叫端記得傳對旗標）。
_TW_DUMP: dict = {}      # (url, purpose) -> {etag, lastmod, payload}

DUMP_TICKERS = "tickers"   # 用途：全台股報價清單
DUMP_DAY     = "day"       # 用途：最新交易日日線（tw_daily_fill_latest）

_TW_TICKER_PEAK = {"n": 0}   # 清單歷史高水位（健全性守門用，見 fetch_tw_tickers 末段）


class _NotModified(Exception):
    """內部哨兵：304 → 跳過該來源的解析段（不是錯誤）。"""


# ★ 下載「途中」斷線要自己重試（2026-09-17 實測）：上櫃全量 opendata 解壓約 3.9MB，
#   連抓 12 次斷 2 次，全是 ChunkedEncodingError（標頭收到了、內容下載到一半連線被對方關掉）；
#   上市/興櫃同樣抓 12 次 0 次。http_pool 的 urllib3 Retry **管不到這段** —— 它只重試
#   「送出請求～收到標頭」，requests 讀內容是在那之後。
#   沒重試的後果（植回舊碼實測）：那一輪上櫃約 900 檔**變成沒有價格**（公司名單補回名稱、價格空白）、
#   約 120 檔整個不見；公司名單也剛好抓失敗時更糟，整批消失（2681→1689，只少 37%，碰不到下面
#   「縮水一半」的自我修復門檻）→ 零錯誤。守門員 check_tw_sources 就是這樣紅的。
# ⚠ 只重試 ChunkedEncodingError：連線層錯誤 urllib3 已經重試過 2 次，再包一層只會讓
#   逾時的最壞情況翻倍（worker 卡更久）。GET 冪等，整個請求重來是安全的。
_TW_BODY_TRIES = 3
# ★ 總時限（2026-09-17 實測）：上櫃那份有一次整整拖了 **685 秒**才斷、另一次 36 秒。
#   requests 的 timeout 是「兩次收到資料之間最多等多久」，**不是整個下載的上限** ——
#   對方每隔幾秒吐一點，下載就能無限拖下去 → 台股清單背景更新（每 30 秒一輪）整個卡住十幾分鐘，
#   期間上市/上櫃/興櫃基底都不更新、零錯誤（守門員曾因此卡 17 分鐘）。
#   → 內容改串流讀、由計時器到點直接切斷 socket（卡在讀取中的呼叫會立刻出錯），
#     接著走呼叫端的「沿用上一份」。正常情況：上市 <2s、上櫃 3~5s，30 秒很寬。
# ⚠ 標頭階段拿不到 socket（回應物件還沒生出來）→ 靠每次讀取的逾時擋（最多 10 秒一次）。
_TW_BODY_BUDGET = 30


def _kill_resp(r):
    """從別的執行緒切斷回應底層的 socket：shutdown 才能叫醒卡在 recv 的讀取（光 close 不一定會）。"""
    import socket as _socket
    for _get in (lambda: r.raw.connection.sock, lambda: r.raw._fp.fp.raw._sock):
        try:
            _sk = _get()
            if _sk is not None:
                _sk.shutdown(_socket.SHUT_RDWR)
                break
        except Exception:
            continue
    try:
        r.close()
    except Exception:
        pass


def _get_body_retry(url: str, headers: dict = None, timeout: int = 20, budget: float = None):
    budget = _TW_BODY_BUDGET if budget is None else budget
    t0 = _time.monotonic()
    for _i in range(_TW_BODY_TRIES):
        left = budget - (_time.monotonic() - t0)
        if left <= 0.5:
            raise requests.exceptions.Timeout(f"{url.rsplit('/', 1)[-1]} 超過總時限 {budget:.0f}s")
        try:
            r = SESSION.get(url, headers=headers or {}, timeout=(5, min(timeout, 10, left)), stream=True)
        except requests.exceptions.ChunkedEncodingError:
            if _i == _TW_BODY_TRIES - 1:
                raise
            _time.sleep(0.3 * (_i + 1))
            continue
        left = budget - (_time.monotonic() - t0)
        _killed = {"v": False}
        def _kill():
            _killed["v"] = True
            _kill_resp(r)
        _tm = _threading.Timer(max(0.1, left), _kill)
        _tm.daemon = True
        _tm.start()
        try:
            buf = bytearray()
            for _chunk in r.iter_content(65536):
                buf += _chunk
            r._content = bytes(buf)                 # 讓呼叫端照常用 r.json() / r.status_code
            r._content_consumed = True
            return r
        except Exception:
            if _killed["v"]:
                raise requests.exceptions.Timeout(
                    f"{url.rsplit('/', 1)[-1]} 內容下載超過總時限 {budget:.0f}s（對方拖著慢慢吐）")
            if _i == _TW_BODY_TRIES - 1:
                raise
            _time.sleep(0.3 * (_i + 1))
        finally:
            _tm.cancel()


def _dump_get(url: str, purpose: str, timeout: int = 20):
    """帶 If-None-Match / If-Modified-Since 抓 opendata。
    回 (json, True)＝有更新要重新解析；(None, False)＝沒變，沿用上次解析結果。

    只有「這個用途上次真的解析成功過」才會送條件標頭 —— 見上方 _TW_DUMP 說明。
    解析成功後呼叫端要用 _dump_done() 把結果登記回來，下次才敢走 304。"""
    ent = _TW_DUMP.setdefault((url, purpose), {})
    hdrs = {}
    if ent.get("payload") is not None:          # 手上有結果才敢問「有沒有變」
        if ent.get("etag"):
            hdrs["If-None-Match"] = ent["etag"]
        if ent.get("lastmod"):
            hdrs["If-Modified-Since"] = ent["lastmod"]
    r = _get_body_retry(url, headers=hdrs, timeout=timeout)
    if r.status_code == 304:
        return None, False
    r.raise_for_status()
    ent["etag"]    = r.headers.get("ETag")
    ent["lastmod"] = r.headers.get("Last-Modified")
    ent["payload"] = None                        # 先作廢：解析完才由 _dump_done 補上
    return r.json(), True


def _dump_done(url: str, purpose: str, payload):
    """解析成功 → 登記結果。沒登記過的用途永遠不會走 304（見 _dump_get）。"""
    _TW_DUMP.setdefault((url, purpose), {})["payload"] = payload


def _dump_cached(url: str, purpose: str):
    """取上次解析成功的結果（304 時用）。"""
    return _TW_DUMP.get((url, purpose), {}).get("payload")


def _tw_code_ok(code: str) -> bool:
    """這個代號要不要收進台股清單。

    ・4 碼純數字 ＝ 一般股票，以及早期的 ETF（0050 / 0056）。
    ・「00」開頭的 5~6 碼 ＝ 近年的 ETF（00878 國泰永續高股息、006208 富邦台50、
      00919、00929…）。可能帶一個**字尾字母**（00631L 正2 / 00632R 反1 / 00679B 債券）
      → 所以不能用 code.isdigit() 判，要只看前 5 碼是不是數字。

    ⚠⚠ **不可以放寬成「5~6 碼都收」**：上櫃那份 opendata 有 10963 筆，其中
        70xx/71xx/72xx/73xx 開頭的 **9950 筆是權證**（實測），全收進來清單會爆掉。
        「00」這個前綴正好把 ETF 跟權證分開。
    ⚠ 2026-09-06 之前這裡是硬寫 `len(code) == 4` → 上市 232 檔、上櫃 119 檔 ETF
      **整批不存在**（清單、搜尋、自選名稱、報價全都沒有）。使用者回報的形狀是
      「台股依舊有些沒中文名」——自選裡的 00878/006208 找不到對應資料，副標只好退回 "TW"。
    """
    if not code:
        return False
    if len(code) == 4 and code.isdigit():
        return True
    if 5 <= len(code) <= 6 and code.startswith("00") and code[:5].isdigit():
        return True
    return False


# 公司基本資料（上市 t187ap03_L / 上櫃 mopsfin_t187ap03_O）：只拿「代號 → 簡稱」。
# ⚠ 為什麼需要它：每日行情那兩份只收錄「當天有成交資訊」的標的，**當天沒被收錄的上市櫃股票
#   會整檔從清單消失** —— 名稱、搜尋、自選副標全都沒有（使用者 2026-09-06 回報的
#   「6949 就沒有」＝沛爾生醫*-創，它在公司清單裡、圖表也載得到，只是不在行情那份）。
#   實測這種標的共 6 檔（1563 巧新 / 1589 永冠-KY / 4804 大略-KY / 6129 普誠 /
#   6461 益得 / 6949 沛爾生醫*-創）→ 補進來時只給名稱、價格留 None（見 fetch_tw_tickers 末段）。
# 6 小時抓一次就夠（公司清單一天最多變動幾檔）；抓失敗就沿用上一份，絕不清空。
_TW_NAME_MASTER = {"map": {}, "ts": 0.0}
_TW_MASTER_TTL = 6 * 3600

def _tw_name_master() -> dict:
    import time as _t
    if _TW_NAME_MASTER["map"] and _t.time() - _TW_NAME_MASTER["ts"] < _TW_MASTER_TTL:
        return _TW_NAME_MASTER["map"]
    out = {}
    for url, ckey, nkeys in (
        ("https://openapi.twse.com.tw/v1/opendata/t187ap03_L", "公司代號", ("公司簡稱", "公司名稱")),
        ("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O", "SecuritiesCompanyCode",
         ("CompanyAbbreviation", "CompanyName")),
        ("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R", "SecuritiesCompanyCode",
         ("CompanyAbbreviation", "CompanyName")),     # 興櫃
    ):
        try:
            # 走共用池＋內容斷線重試（上櫃公司清單同樣會中途斷，見 _get_body_retry）；
            # 池不存 cookie，行為與原本 requests.get 相同
            r = _get_body_retry(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
            r.raise_for_status()
            for d in r.json():
                code = str(d.get(ckey) or "").strip()
                if not _tw_code_ok(code):
                    continue
                name = next((str(d.get(k) or "").strip() for k in nkeys if str(d.get(k) or "").strip()), "")
                if name:
                    out.setdefault(code, name)
        except Exception as e:
            _log.warning(f"[tw_tickers] 公司清單 {url.rsplit('/', 1)[-1]} 取得失敗: {e}")
    if out:                                   # ⚠ 抓失敗不可以把既有的清空（寧可用舊的）
        _TW_NAME_MASTER["map"] = out
        _TW_NAME_MASTER["ts"] = _t.time()
    return _TW_NAME_MASTER["map"]


def fetch_tw_tickers() -> list:
    """抓取全台股（上市＋上櫃）每日行情，以漲跌幅排序。
    主力：TWSE/TPEX opendata（全量，盤中更新）。
    備援：MIS 熱門 50 支即時。
    """
    tickers: dict[str, dict] = {}

    # ── 1. TWSE 上市全量 ──────────────────────────────────────
    try:
        _data, _changed = _dump_get(TWSE_DAY_ALL_URL, DUMP_TICKERS, timeout=15)
        if not _changed:                      # 304：內容沒變 → 直接用上次解析好的，跳過整輪解析
            tickers.update(_dump_cached(TWSE_DAY_ALL_URL, DUMP_TICKERS) or {})
            raise _NotModified
        _parsed = {}
        _day_reset(TWSE_DAY_ALL_URL)
        for d in _data:
            code = (d.get("Code") or "").strip()
            if not _tw_code_ok(code):
                continue
            close_s = (d.get("ClosingPrice") or "").replace(",", "").strip()
            if not close_s or close_s in ("--", "0", "0.00"):
                continue
            try:
                close      = float(close_s)
                change_amt = _parse_tw_change(d.get("Change", "0"))
                prev       = close - change_amt
                change_pct = round(change_amt / prev * 100, 2) if prev else 0.0
                vol        = float((d.get("TradeVolume") or "0").replace(",", ""))
                _day_put(TWSE_DAY_ALL_URL, code, d,
                         ("OpeningPrice", "HighestPrice", "LowestPrice", "ClosingPrice"),
                         "TradeVolume", d.get("Date"))
                _parsed[code] = {
                    "symbol": code, "display": code,
                    "name": (d.get("Name") or code).strip(),
                    "price": close, "change_pct": change_pct,
                    "change_amt": round(change_amt, 2), "volume": vol,
                }
            except (ValueError, TypeError):
                continue
        _dump_done(TWSE_DAY_ALL_URL, DUMP_TICKERS, _parsed)   # 登記後下次才敢走 304
        tickers.update(_parsed)
    except _NotModified:
        pass
    except Exception as e:
        # 重試完還是失敗 → 沿用上一輪成功解析的那份（檔案一天只更新幾次，30 秒前那份仍然有效）；
        # 不沿用的話這一輪清單直接少掉一整個市場。手上沒有（冷啟動）才真的缺。
        _prev = _dump_cached(TWSE_DAY_ALL_URL, DUMP_TICKERS) or {}
        tickers.update(_prev)
        _log.warning(f"[tw_tickers] TWSE opendata error: {e}（沿用上一份 {len(_prev)} 檔）")

    # ── 2. TPEX 上櫃全量 ──────────────────────────────────────
    try:
        _data, _changed = _dump_get(TPEX_DAY_ALL_URL, DUMP_TICKERS, timeout=15)
        if not _changed:                      # 304 → 沿用上次解析結果（見 _dump_get）
            for _c, _v in (_dump_cached(TPEX_DAY_ALL_URL, DUMP_TICKERS) or {}).items():
                tickers.setdefault(_c, _v)    # setdefault：TSE 優先，與下方 `if code in tickers` 一致
            raise _NotModified
        _parsed = {}
        _day_reset(TPEX_DAY_ALL_URL)
        for d in _data:
            code = (d.get("SecuritiesCompanyCode") or "").strip()
            if not _tw_code_ok(code):
                continue
            close_s = (d.get("Close") or "").replace(",", "").strip()
            if not close_s or close_s in ("--", "0", "0.00"):
                continue
            if code in tickers:
                continue  # TSE 優先
            try:
                close      = float(close_s)
                change_amt = _parse_tw_change(d.get("Change", "0"))
                prev       = close - change_amt
                change_pct = round(change_amt / prev * 100, 2) if prev else 0.0
                # ⚠ 欄位名是 TradingShares（TPEX 回應裡**沒有** "Volume" 這個欄位）→
                #   原本寫 d.get("Volume") 永遠拿到 0：實測全清單 1972 檔有 877 檔量=0，
                #   全部是上櫃股。後果不只是「依量排序時上櫃永遠墊底」，更嚴重的是
                #   _tw_rt_overlay_worker 只對「量最大前 120 檔」疊即時價 → 上櫃股永遠輪不到，
                #   盤中顯示的會是 opendata 的【昨日收盤】（見下方第 3 段註解）。
                vol        = float((d.get("TradingShares") or "0").replace(",", ""))
                _day_put(TPEX_DAY_ALL_URL, code, d, ("Open", "High", "Low", "Close"),
                         "TradingShares", d.get("Date"))
                _parsed[code] = {
                    "symbol": code, "display": code,
                    "name": (d.get("CompanyName") or code).strip(),
                    "price": close, "change_pct": change_pct,
                    "change_amt": round(change_amt, 2), "volume": vol,
                }
            except (ValueError, TypeError):
                continue
        _dump_done(TPEX_DAY_ALL_URL, DUMP_TICKERS, _parsed)
        for _c, _v in _parsed.items():
            tickers.setdefault(_c, _v)
    except _NotModified:
        pass
    except Exception as e:
        _prev = _dump_cached(TPEX_DAY_ALL_URL, DUMP_TICKERS) or {}   # 同上：沿用上一份
        for _c, _v in _prev.items():
            tickers.setdefault(_c, _v)
        _log.warning(f"[tw_tickers] TPEX opendata error: {e}（沿用上一份 {len(_prev)} 檔）")

    # 兩包都解析完 → 把順手收集的「最新交易日日線」搬進快取（給 tw_daily_fill_latest 用）
    _day_commit()

    # ── 2b. 興櫃（TPEX ESB）─────────────────────────────────────
    #   使用者 2026-09-06:「7887 為什麼沒有中文」→ 7887 宇川精材是**興櫃**，
    #   而興櫃整批 363 檔原本完全不在清單裡（上市/上櫃兩份都沒有它）。
    #   ⚠ 興櫃沒有收盤集合競價 → 這份給的是 LatestPrice(最新成交) 與
    #     PreviousAveragePrice(前一日均價)，漲跌一律以**前一日均價**為基準，
    #     不能拿「收盤價」的算法硬套。
    #   ⚠ 標記 is_esb=True：興櫃流動性與上市櫃差很多，前端/使用者要分得出來。
    # ⚠ 一定要走 _dump_get 的條件式抓取（跟上市/上櫃同一套）：直接 requests.get 的話，
    #   worker 每 30 秒就重抓一次整份（~140KB）且每輪都要重新解析 —— 守門員的
    #   「第 2 輪明顯變快（代表 304 生效）」會直接失敗（實測 0.67s → 0.38s，門檻 <0.335s）。
    try:
        _data, _changed = _dump_get(TPEX_ESB_URL, DUMP_TICKERS, timeout=20)
        if not _changed:                       # 304：沿用上次解析結果
            for _c, _v in (_dump_cached(TPEX_ESB_URL, DUMP_TICKERS) or {}).items():
                tickers.setdefault(_c, _v)
            raise _NotModified
        _esb_parsed = {}
        for d in _data:
            code = (d.get("SecuritiesCompanyCode") or "").strip()
            if not _tw_code_ok(code) or code in tickers:      # 上市/上櫃優先
                continue
            try:
                last = float((d.get("LatestPrice") or "").replace(",", "").strip() or 0)
                base = float((d.get("PreviousAveragePrice") or "").replace(",", "").strip() or 0)
                if last <= 0:
                    continue
                amt = round(last - base, 2) if base > 0 else 0.0
                pct = round(amt / base * 100, 2) if base > 0 else 0.0
                vol = float((d.get("TransactionVolume") or "0").replace(",", "").strip() or 0)
                _esb_parsed[code] = {
                    "symbol": code, "display": code,
                    "name": (d.get("CompanyName") or code).strip(),
                    "price": last, "change_pct": pct, "change_amt": amt,
                    "volume": vol, "is_esb": True,
                }
            except (ValueError, TypeError):
                continue
        _dump_done(TPEX_ESB_URL, DUMP_TICKERS, _esb_parsed)   # 登記後下次才敢走 304
        for _c, _v in _esb_parsed.items():
            tickers.setdefault(_c, _v)
    except _NotModified:
        pass
    except Exception as e:
        _prev = _dump_cached(TPEX_ESB_URL, DUMP_TICKERS) or {}       # 同上：沿用上一份
        for _c, _v in _prev.items():
            tickers.setdefault(_c, _v)
        _log.warning(f"[tw_tickers] 興櫃 opendata error: {e}（沿用上一份 {len(_prev)} 檔）")

    # ── 健全性守門：清單「莫名其妙縮水」就丟掉條件式快取、下一輪強制整包重抓 ──────────
    # ★為什麼要有這個：條件式抓取（304）失敗時的樣子是「安靜地回一份不完整的清單」，
    #   而且因為來源檔案內容真的沒變，會一直 304 下去 —— 自己不會好，要等隔天。
    #   實測就發生過一次（1972 → 50 檔）。上面已經從結構上修掉成因，但這類「快取狀態
    #   與現實脫節」的錯法不會只有一種，所以留一道能**自我復原**的網：
    #   只要比歷史高水位少掉一半以上，就清掉驗證碼，下一輪（30 秒後）整包重抓。
    try:
        _n = len(tickers)
        _peak = _TW_TICKER_PEAK["n"]
        if _n and _peak and _n < _peak * 0.5:
            _log.warning(f"[tw_tickers] 清單異常縮水 {_peak} → {_n} 檔，丟棄條件式快取、下輪整包重抓")
            _TW_DUMP.clear()
            _TW_TICKER_PEAK["n"] = 0          # 重新建立高水位，避免持續誤判
        elif _n > _peak:
            _TW_TICKER_PEAK["n"] = _n
    except Exception:
        pass

    # ── 3. MIS 即時補強（盤中）：⚠ opendata(STOCK_DAY_ALL) 盤中給的是【昨日收盤】，用 MIS(delay:0)
    #      把今日即時價疊到熱門 50 支(單一請求、輕)。全部台股的今日價由 _tw_rt_overlay_worker 分頁輪掃補齊
    #      (MIS 有速率限制、不能一次狂打全部；分頁節流)。opendata 失敗時此段也當備援清單。
    try:
        rt = fetch_tw_realtime_bulk([s for s, _ in TW_POPULAR])
        for sym, u in rt.items():
            t = tickers.get(sym)
            if t:
                t["price"] = u["price"]; t["change_pct"] = u["change_pct"]
                t["change_amt"] = u["change_amt"]; t["volume"] = u["volume"]
            else:
                tickers[sym] = {"symbol": sym, "display": sym, "name": TW_NAME_MAP.get(sym, sym),
                                "price": u["price"], "change_pct": u["change_pct"],
                                "change_amt": u["change_amt"], "volume": u["volume"]}
    except Exception as e:
        _log.warning(f"[tw_tickers] MIS error: {e}")

    # ── 4. 補上「有掛牌但今天沒有行情」的股票：只給名稱，價格留 None ──────────────
    #   前端對 price == null 已有「---」的處理；這樣它們至少**存在**（搜尋得到、加得進自選、
    #   自選副標有中文名、點下去圖表也載得出來），而不是整檔消失。
    try:
        for code, name in _tw_name_master().items():
            if code not in tickers:
                tickers[code] = {"symbol": code, "display": code, "name": name,
                                 "price": None, "change_pct": None,
                                 "change_amt": None, "volume": 0}
    except Exception as e:
        _log.warning(f"[tw_tickers] 補名稱失敗: {e}")

    # price 是 None ＝ 只有名稱沒有行情（上面補的），要留著；price <= 0 ＝ 髒資料，丟掉。
    result = [t for t in tickers.values() if t.get("price") is None or t["price"] > 0]
    # 排序：上市櫃有行情 → 興櫃 → 沒有行情。
    # ⚠ 興櫃必須排在上市櫃**之後**：興櫃**沒有漲跌幅限制**，直接混在一起排的話它會佔滿
    #   漲幅榜前段（實測前 25 名被興櫃拿走 6 席：+51%/+42%/+39%/+33%/+25%/+12%），
    #   把上市櫃真正的 ±10% 漲停股整批擠下去 —— 而那才是看這張榜的人要找的東西。
    # ⚠ 沒有漲跌幅的排最後（不能直接拿 None 比大小，會 TypeError）。
    result.sort(key=lambda x: (x.get("change_pct") is None,
                               bool(x.get("is_esb")),
                               -(x.get("change_pct") or 0.0)))
    return result


def fetch_tw_latest_bar_yf(symbol: str):
    """用 yfinance 抓最新一根日線（盤中即更新，盤後取當日收盤）"""
    try:
        import yfinance as yf
        for suffix in (".TW", ".TWO"):
            try:
                raw = yf.Ticker(f"{symbol}{suffix}").history(
                    period="5d", interval="1d", auto_adjust=True, timeout=12)
            except TypeError:
                raw = yf.Ticker(f"{symbol}{suffix}").history(
                    period="5d", interval="1d", auto_adjust=True)
            if raw.empty:
                continue
            last = raw.iloc[-1]
            ts = pd.Timestamp(raw.index[-1])
            if ts.tzinfo is not None:
                ts = ts.tz_convert("Asia/Taipei").tz_localize(None)
            else:
                # naive timestamp 假設已是台北時間（yfinance 日線通常如此）
                pass
            ts = ts.normalize()  # 取日期部分（00:00:00）
            return {
                "time":   ts,
                "open":   float(last["Open"]),
                "high":   float(last["High"]),
                "low":    float(last["Low"]),
                "close":  float(last["Close"]),
                "volume": float(last["Volume"]),
            }
    except Exception:
        pass
    return None


def _mis_f(x):
    """MIS 欄位轉正數；"-"／空／0 一律回 None（MIS 用 "-" 表示「沒有這個值」）。"""
    try:
        v = float(x)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _mis_first(seq):
    """MIS 的五檔字串 "0.0000_110.5000_110.0000_..." → 第一個有效價；沒有則 None。"""
    if not seq or seq == "-":
        return None
    for part in str(seq).split("_"):
        v = _mis_f(part)
        if v:
            return v
    return None


def _mis_today_price(d):
    """從 MIS 記錄取「今日成交價」；判不出來就回 None（呼叫端會跳過該檔）。

    ★ 2026-08-03 修的 bug（使用者回報「台股右列表看到的都是舊的」）：
      舊碼在 z(最新成交價)=="-" 時直接拿 y(昨收)頂替。但 z 是 "-" 的最大宗情形是
      **漲跌停鎖死**——當下沒有撮合，不是沒有行情。實測 2337 旺宏：
          z=-  y=100.5  o=102.5  h=u=110.5  a=-（無人賣）  b=…110.5（買盤全掛漲停）
      拿 y 頂替 → 顯示 100.5、漲跌幅 0%，而且這個「昨收」還會經由 overlay_tw()
      **覆蓋掉 opendata 已經正確的今日價(110.5)** → 使用者看到的整列都是舊價。

    取值順序（一律只取「今天」的價，寧可回 None 也不拿昨收混充）：
      ① z 有效 → 直接用
      ② 今天沒成交(v<=0) → 今日無價可言 → None（讓 opendata 的值留著）
      ③ 只有買盤沒賣盤 → 漲停鎖死 → 今日最高已觸漲停價就取漲停價，否則取最佳買價
      ④ 只有賣盤沒買盤 → 跌停鎖死 → 同理取跌停價／最佳賣價
      ⑤ 今日高低相同 → 全天只成交在一個價 → 用它
      ⑥ 兩邊都有報價 → 用「今日高/低之中，落在買賣價區間內的那一個」
         最後成交價必定落在買賣價之間，而 h/l 是今天真的成交過的價 → 只有一個落在區間內時
         幾乎就是它。實測 6862 三集瑞-KY：買 136.5／賣 137.5，h=137.5 在區間內、l=125 不在
         → 取 137.5（正確；中價會算成 137.0，落後的 opendata 更是給 125.0）。
      ⑦ h、l 都在或都不在區間內 → 買賣中價（標準 mark price 近似）

    ⚠ 這裡刻意「寧可估也不要讓路」：曾一度改成判不出就 return None、讓 opendata 的值留著，
      但實測 opendata 對冷門股會落後一整天（6862 給 125.0 ＝ 昨收，真實 137.5），
      讓路等於把錯的留下。買賣價區間是當下的真實市場，估出來的誤差遠小於落後一天。
    """
    z = _mis_f(d.get("z"))
    if z:
        return z
    try:
        vol = float((d.get("v", "0") or "0").replace(",", ""))
    except (TypeError, ValueError):
        vol = 0.0
    if vol <= 0:
        return None                       # 今天還沒成交過 → 沒有「今日價」
    bid, ask = _mis_first(d.get("b")), _mis_first(d.get("a"))
    hi, lo = _mis_f(d.get("h")), _mis_f(d.get("l"))
    up, dn = _mis_f(d.get("u")), _mis_f(d.get("w"))
    if bid and not ask:
        # 賣單整個空掉＝漲停鎖死。若今日最高已觸漲停價，最後成交價就是漲停價
        # （不能直接取最佳買價：實測 6862 買 136.5 但實際已成交在漲停 137.5）。
        return up if (hi and up and hi == up) else bid
    if ask and not bid:
        return dn if (lo and dn and lo == dn) else ask   # 跌停鎖死，同理
    if hi and lo and hi == lo:
        return hi
    if bid and ask:
        _in = lambda v: v is not None and bid - 1e-9 <= v <= ask + 1e-9
        hi_in, lo_in = _in(hi), _in(lo)
        if hi_in and not lo_in:
            return hi
        if lo_in and not hi_in:
            return lo
        return round((bid + ask) / 2, 4)
    return None


def fetch_tw_realtime_bulk(symbols):
    """MIS 即時報價 bulk（一次多檔、盤中 delay:0）：symbols=代號 list。
    先全試上市(tse)、未解析的再試上櫃(otc)。回 {sym: {price,change_pct,change_amt,volume}}。
    供『台股報價列即時疊價』快 worker 用——只打 MIS(輕)、不重抓 opendata 全量。"""
    out: dict = {}
    syms = [s for s in dict.fromkeys(symbols) if s]        # 去重保序
    if not syms:
        return out

    def _q(prefix, batch):
        if not batch:
            return
        ex_ch = "|".join(f"{prefix}_{s}.tw" for s in batch)
        try:
            resp = SESSION.get(TWSE_MIS_URL,
                                params={"ex_ch": ex_ch, "json": "1", "delay": "0"},
                                headers=TWSE_MIS_HEADERS, timeout=10)
            resp.raise_for_status()
            for d in resp.json().get("msgArray", []):
                sym = d.get("c", "")
                if not sym:
                    continue
                prev = _mis_f(d.get("y"))
                if not prev:
                    continue
                price = _mis_today_price(d)
                if price is None:
                    continue            # 判不出今日價 → 整檔跳過，別覆蓋 opendata 已有的正確值
                try:
                    camt = round(price - prev, 2)
                    cpct = round((camt / prev * 100) if prev else 0.0, 2)
                    vol = float((d.get("v", "0") or "0").replace(",", "")) * 1000
                    out[sym] = {"price": price, "change_pct": cpct,
                                "change_amt": camt, "volume": vol}
                except (ValueError, TypeError):
                    continue
        except Exception as e:
            _log.warning(f"[tw_rt_bulk] {prefix} error: {e}")

    # ⚠ MIS 有速率限制(超速→封 IP 回 z=-/空)：每個請求之間留 0.35s 間隔，避免密集連打被封。
    _first = True
    for i in range(0, len(syms), 100):                     # MIS 保守每批 100
        if not _first: _time.sleep(0.35)
        _first = False
        _q("tse", syms[i:i + 100])
    unresolved = [s for s in syms if s not in out]          # 上市沒有的再試上櫃
    for i in range(0, len(unresolved), 100):
        _time.sleep(0.35)
        _q("otc", unresolved[i:i + 100])
    return out


def fetch_tw_realtime(symbol: str):
    """
    TWSE MIS 即時報價（盤中）。
    先試上市(tse)，再試上櫃(otc)。
    z（最新成交）盤中偶爾為 '-'，改用委買最佳價補位；盤後或無委買才回 None。
    """
    def _f(s, fallback="0"):
        try:
            return float(str(s or fallback).replace(",", ""))
        except Exception:
            return float(str(fallback).replace(",", ""))

    for exchange in ("tse", "otc"):
        try:
            resp = SESSION.get(
                TWSE_MIS_URL,
                params={"ex_ch": f"{exchange}_{symbol}.tw", "json": "1", "delay": "0"},
                headers=TWSE_MIS_HEADERS,
                timeout=6,
            )
            resp.raise_for_status()
            arr = resp.json().get("msgArray", [])
            if not arr:
                continue
            d = arr[0]
            date_str = d.get("d", "")
            if not date_str:
                continue
            # ★ 2026-08-10 改用與報價列**同一個**估價器 _mis_today_price（使用者回報
            #   「台股日 K 最新顯示有 bug、會變成像下大 K 棒」）。
            #   舊碼：z(最新成交價)=="-" 時直接拿**最佳委買價**當現價。委買永遠在委賣之下，
            #   於是每當 z 消失（實測 2330 在盤中可以連續一分鐘以上都是 '-'，不是瞬間），
            #   當日 K 的收盤就被壓到買價 → 日 K 被畫成陰線，且**系統性偏低**。
            #   實測現場：z='-'、買 2380／賣 2385、開 2390 → 主圖收 2380（畫成大陰線），
            #   而報價列走 _mis_today_price 得到 2385 → 兩邊還對不上（同「主圖跟行情不一致」那類）。
            #   _mis_today_price 有 7 條規則（漲跌停鎖死、只有單邊掛單、用今日高/低落在買賣區間
            #   內的那一個…），是為了報價列踩過坑才寫出來的；圖表沒理由另外自己猜一套。
            _px = _mis_today_price(d)
            if _px is None:
                continue   # 真的判不出今日價 → 試下一個交易所（別拿昨收/買價混充）
            time_str = d.get("t", "09:00:00")
            ts = datetime.strptime(f"{date_str} {time_str}", "%Y%m%d %H:%M:%S")
            volume = _f(d.get("v"), "0") * 1000  # 張 → 股
            _o = _f(d.get("o"), _px)
            _h = _f(d.get("h"), _px)
            _l = _f(d.get("l"), _px)
            # ⚠ OHLC 不變式：估出來的收盤價可能落在 MIS 回報的今日高低之外（例如規則⑦取買賣中價，
            #   而中價比今日最低還低）→ 會畫出「低點比收盤高」的不可能 K 棒。一律把高低撐開包住
            #   open/close，寧可高低多一點點，也不要送出自相矛盾的棒（同 crypto 那條硬不變式）。
            _h = max(_h, _o, _px)
            _l = min(_l, _o, _px) if _l else min(_o, _px)
            return {
                "time":   ts,
                "open":   _o,
                "high":   _h,
                "low":    _l,
                "close":  _px,
                "volume": volume,
            }
        except Exception:
            continue
    return None


_TW_INFO_CACHE = {"ts": 0.0, "records": None}   # 全台股清單記憶體快取（近乎靜態，一天變動一次）


def _tw_stock_info(api_token: str = "") -> list:
    """全台股清單(TaiwanStockInfo) — 記憶體快取 12hr。
    清單近乎靜態(僅新上市/下市才變) → 不必每次搜尋都重抓整包(原本每次 ~380ms + FinMind 限額風險)。
    抓取失敗且有舊快取 → stale-serve(不因暫時失敗讓搜尋整個掛掉)。"""
    now = _time.time()
    c = _TW_INFO_CACHE
    if c["records"] is not None and now - c["ts"] < 43200:
        return c["records"]
    try:
        resp = SESSION.get(FINMIND_API_URL,
                            params={"dataset": "TaiwanStockInfo", "token": api_token}, timeout=30)
        resp.raise_for_status()
        records = resp.json().get("data", [])
    except Exception:
        return c["records"] or []
    if records:
        _TW_INFO_CACHE["ts"] = now
        _TW_INFO_CACHE["records"] = records
        _TW_INFO_CACHE["current"] = None      # 換了新清單 → 去重結果作廢，下次重算
        return records
    return c["records"] or []


def _tw_stock_current(api_token: str = "") -> list:
    """把上面那份清單「每個代號只留現行那一筆」。

    來源 TaiwanStockInfo 是**產業分類異動史**：同一檔股票每換一次分類就多一列，實測 4296 筆
    裡有 1048 個代號重複。而且代號會被回收再配給別家公司（5450 舊列＝寶聯通 2020、
    新列＝南良 2026）→ 不處理的話搜尋不只跳出重複項，還會顯示**已經不是那家公司的舊名**。
    取 date 最大的那列＝現行分類與現行名稱。

    ⚠ 必須在「過濾關鍵字之前」做：先過濾再去重的話，搜舊公司名時整個過濾結果裡只剩那筆舊列、
      沒有新列可以把它擠掉 → 舊名照樣被搜出來（等於沒修）。
    結果跟著 12hr 清單一起快取，不必每次搜尋都掃 4296 筆。"""
    c = _TW_INFO_CACHE
    records = _tw_stock_info(api_token)
    if c.get("current") is not None and c.get("current_src") is records:
        return c["current"]
    latest: dict = {}
    for r in records:
        sid = r.get("stock_id", "")
        if not sid:
            continue
        cur = latest.get(sid)
        # date 缺失視為最舊（空字串在字串比較下本來就最小）；ISO 日期可直接字串比大小
        if cur is None or str(r.get("date") or "") >= str(cur.get("date") or ""):
            latest[sid] = r
    out = list(latest.values())
    c["current"] = out
    c["current_src"] = records
    return out


def search_tw_stock(keyword: str, api_token: str = "") -> list[dict]:
    """搜尋台股代號（清單走 12hr 記憶體快取，過濾在本機、毫秒級）。

    清單先經 _tw_stock_current() 去重（每個代號只留現行那筆）→ 搜 2330 不再跳出兩個台積電、
    也不會搜到已經換過公司的舊名。理由與順序的講究見該函式。"""
    records = _tw_stock_current(api_token)
    keyword = keyword.lower()
    return [
        {"symbol": r["stock_id"], "name": r.get("stock_name", "")}
        for r in records
        if keyword in r.get("stock_id", "").lower()
        or keyword in r.get("stock_name", "").lower()
    ][:20]


# ─── 台股分鐘 K：yfinance（歷史）× cnyes（當日即時）合併 ────────────────────────
#
# 為什麼要「合併」而不是「二選一」（2026-07-31）：
#   原本的作法是 cutoff = cnyes 最早那根，然後 yfinance 只留 cutoff 之前、cnyes 整段接上去。
#   它有兩個問題：
#     ① cnyes 一失敗就 except: pass → 當日**整段**退回 yfinance，而 yfinance 的當日尾巴會落後
#        （實測 12:36 時它只到 11:45）→ 使用者看到最後幾根 K 棒「往回退」、重整又跑回來。
#     ② 兩個來源對同一根偶爾會有單一欄位的小差異（實測 13 根已收盤棒裡 1 根：2330 的 high 差 5、
#        0050 的 close 差 0.05）。誰贏純粹看接合點落在哪 → 同一根 K 棒的值會因為接合位置而變。
#   合併之後：
#     ・時間軸取聯集 → 任何一邊有的棒都不會消失。
#     ・重疊的棒逐欄位合：high 取兩邊較高、low 取兩邊較低（兩個 feed 的逐筆覆蓋度本來就略有差異，
#       取極值才是這根棒真正的高低）、close/open 以 cnyes 為準（即時源、連續無跳號）、
#       volume 取大（cnyes 盤中是累積中的量，取大值才單調不倒退）。
#   ★這是「決定性」的：同一組輸入永遠得到同一個結果，不再受接合點位置影響。
_TW_CN_LAST: dict = {}          # (symbol, tf) → (日期, cnyes df)：最後一次成功的當日分鐘K
_TW_CN_LAST_MAX = 200


def cnyes_last_good(symbol: str, tf: str, fresh):
    """記住最後一次成功的 cnyes 當日 K；這次抓失敗就沿用（同一天才算數）。
    → cnyes 短暫失敗不會讓當日 K 棒整段退回落後的 yfinance（＝使用者看到的「K 棒不穩定」）。"""
    key = (symbol, tf)
    today = date.today().isoformat()
    if fresh is not None and not fresh.empty:
        if len(_TW_CN_LAST) > _TW_CN_LAST_MAX:
            _TW_CN_LAST.clear()                      # 粗暴但有界（同 main.py 限流桶的作法）
        _TW_CN_LAST[key] = (today, fresh)
        return fresh
    got = _TW_CN_LAST.get(key)
    if got and got[0] == today:
        return got[1]                                # 沿用今天最後一次成功的
    return None


def merge_tw_intraday(yf_df, cn_df):
    """yfinance 歷史 × cnyes 當日 → 逐欄位合併（規則見上方說明）。任一邊為空就回另一邊。"""
    if cn_df is None or cn_df.empty:
        return yf_df
    if yf_df is None or yf_df.empty:
        return cn_df.sort_values("time").reset_index(drop=True)
    y = yf_df.set_index("time")
    c = cn_df.set_index("time")
    both = y.index.intersection(c.index)
    if len(both):
        # 逐欄位合併（只動重疊那段；其餘各自保留）
        for col, how in (("high", "max"), ("low", "min"), ("volume", "max")):
            if col in y.columns and col in c.columns:
                y.loc[both, col] = (y.loc[both, col].combine(c.loc[both, col], max if how == "max" else min))
        for col in ("open", "close"):                 # 即時源優先
            if col in y.columns and col in c.columns:
                y.loc[both, col] = c.loc[both, col]
    only_c = c.index.difference(y.index)              # cnyes 才有的（yfinance 落後的尾巴）
    out = pd.concat([y, c.loc[only_c]]) if len(only_c) else y
    return out.sort_index().reset_index()


# 台股盤中重採樣：目標時框 → (來源時框, pandas rule)
#   台股交易時段 09:00~13:30（台北）＝ 01:00~05:30 UTC，只有 4.5 小時。
#   一律 origin="start_day" + offset="1h"，讓每天第一桶從 UTC 01:00（＝台北 09:00）開始：
#     30m → 09:00,09:30,…,13:00（9 桶，最後一桶只有半小時）
#     2h  → 09:00,11:00,13:00（3 桶，最後一桶只有半小時）
#     4h  → 09:00,13:00（2 桶）
#   來源一律取 15m 而非直接跟 yfinance 要 30m/2h：yfinance 對台股的非 15m 盤中時框有
#   「成交量缺漏＋開盤錯位」問題（1h 的實測見 fetch_tw_intraday_yf 註解），從 15m 自己組最可靠。
TW_RESAMPLE = {"30m": ("15m", "30min"), "2h": ("15m", "2h"), "4h": ("1h", "4h")}


def resample_tw_intraday(df_src, timeframe: str):
    """台股盤中時框重採樣的**唯一**分桶定義（30m / 2h / 4h 共用）。

    ⚠ 抽成共用函式的理由：/api/ohlcv 與 /api/latest 兩條路徑都要產這些棒，分桶規則只要有一邊
      寫得不一樣，最後一根的時間戳就對不上 → 前端會把它當成「新的一根」接上去，圖上多出一根
      假 K 棒。改規則時這裡改一次就好。"""
    ent = TW_RESAMPLE.get(timeframe)
    if ent is None or df_src is None or df_src.empty:
        return df_src
    out = df_src.set_index("time").resample(ent[1], origin="start_day", offset="1h").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    )
    return out.dropna(subset=["open"]).reset_index()


def resample_tw_4h(df_1h):
    """（保留舊名給既有呼叫端）台股 1h → 4h，實作見 resample_tw_intraday。"""
    return resample_tw_intraday(df_1h, "4h")


# ── 官方 opendata 補「最新交易日」日線（2026-08-01）────────────────────────────
# ★為什麼：日線來源是 yfinance，而它對台股收盤後會延遲很久才補上當天那根。實測 7/31（週五）
#   13:30 收盤後，直到隔天（週六）凌晨 03:00 它都還只到 7/30 —— 也就是**收盤後約 13 個小時，
#   日線圖上根本看不到剛剛結束的那個交易日**（週線/月線同理，因為都由日線聚合）。
#   那天 2330 收 2425（漲停 +9.98%），日線圖卻停在 2205，落差很大且完全沒有提示。
# → 改成：日線抓回來後，若官方 opendata 的最新交易日比它新，就用官方那根補上。
#
# ⚠ 成交量口徑不同，這點要知道：同一天 2330，TWSE 官方 TradeVolume 69,478,145 股、
#   yfinance 57,145,894 股（差 21%）。價格（開高低收）兩邊一致，量不一致。官方是權威值，
#   但為了讓整條序列的量看起來一致，補進去的這根仍會在 yfinance 補上後被它取代
#   （見下方 tw_daily_fill_latest：只在「官方日期比較新」時才補，日期一樣就不動）。
_TW_DAY_ALL = {"ts": 0.0, "date": None, "rows": {}}
_TW_DAY_ALL_TTL = 600.0
_TW_DAY_REFRESHING = False

# 逐來源存放（**不可只留一份合併結果**）：TWSE 與 TPEX 的更新時刻差好幾小時
# （實測 Last-Modified：TWSE 台北 05:20、TPEX 台北 23:30）→ 會有一段時間兩包分屬不同交易日。
# 若混在一起，晚更新的那包就會被貼上另一包的日期＝**日期錯的 K 棒**。
# 故各自記自己的日期，合併時只採用「最新那個交易日」的來源；還沒更新的那包就先不參與
# （寧可上櫃股暫時補不到，也不要補一根日期錯的）。
_TW_DAY_SRC: dict = {}       # url -> {"date": date, "rows": {code: bar}}


def _day_reset(url):
    """該來源要重新解析（HTTP 200）→ 先清掉它自己那份，避免舊列殘留。"""
    _TW_DAY_SRC[url] = {"date": None, "rows": {}}


def _day_put(url, code, item, ohlc_keys, vol_key, date_str):
    """把 opendata 的一列存成日線棒（給 fetch_tw_tickers 的兩個解析迴圈共用）。"""
    try:
        o, h, l, c = (_f(item.get(k)) for k in ohlc_keys)
        if None in (o, h, l, c) or c <= 0:
            return
        ent = _TW_DAY_SRC.setdefault(url, {"date": None, "rows": {}})
        if ent["date"] is None:
            ent["date"] = _roc_to_date(date_str)
        ent["rows"][code] = {"open": o, "high": h, "low": l, "close": c,
                             "volume": _f(item.get(vol_key)) or 0.0}
    except Exception:
        pass


def _day_commit():
    """各來源解析完 → 取「最新交易日」那些來源合併成正式快取。"""
    dates = [v["date"] for v in _TW_DAY_SRC.values() if v.get("date")]
    if not dates:
        return
    best = max(dates)
    rows = {}
    for v in _TW_DAY_SRC.values():
        if v.get("date") == best:
            rows.update(v["rows"])
    if rows:
        _TW_DAY_ALL.update({"ts": _time.time(), "date": best, "rows": rows})


def _roc_to_date(s: str):
    """民國日期字串 "1150731" → date(2026, 7, 31)。格式不符回 None。"""
    s = (s or "").strip()
    if len(s) != 7 or not s.isdigit():
        return None
    try:
        return date(int(s[:3]) + 1911, int(s[3:5]), int(s[5:7]))
    except ValueError:
        return None


def _f(v):
    """opendata 的數字字串（可能含千分位/"--"/"+"）→ float；不可解析回 None。"""
    try:
        t = str(v).replace(",", "").replace("+", "").strip()
        return float(t) if t and t not in ("--", "---") else None
    except (ValueError, TypeError):
        return None


def fetch_tw_day_all():
    """TWSE(上市)＋TPEX(上櫃) 官方 opendata 的「最新交易日全市場日線」。
    回 (trade_date, {代號: {open,high,low,close,volume}})；抓不到回 (None, {})。

    ⚠ 全市場一次抓、依代號查表 —— 這兩包合計約 1.2 萬列，**絕不可每個標的各打一次**。
      實測兩包都只含單一交易日，所以不需要再依日期過濾。"""
    global _TW_DAY_REFRESHING
    now = _time.time()
    stale = not _TW_DAY_ALL["date"] or now - _TW_DAY_ALL["ts"] >= _TW_DAY_ALL_TTL
    if not stale:
        return _TW_DAY_ALL["date"], _TW_DAY_ALL["rows"]
    # ★過期也**先把手上這份回傳**，更新丟到背景做（stale-while-revalidate）。
    #   實測冷抓要 3.25 秒（TPEX 那包 3.9MB／2.58s、TWSE 只有 310KB／162ms）——
    #   放在請求路徑上等於「每 10 分鐘就有一個使用者的台股日線多等 3 秒」，不可接受。
    #   正常情況下這裡根本不會觸發：_tw_ticker_worker 每 30 秒抓同樣那兩包，會透過
    #   _day_put/_day_commit 順手把這份快取填好（零額外網路）。這條只是「台股 worker
    #   沒在跑」時的保險（例如純加密貨幣部署）。
    if not _TW_DAY_REFRESHING:
        _TW_DAY_REFRESHING = True
        _threading.Thread(target=_tw_day_all_refresh, daemon=True).start()
    return _TW_DAY_ALL["date"], _TW_DAY_ALL["rows"]


def _tw_day_all_refresh():
    """背景更新（見 fetch_tw_day_all）。只有台股 worker 沒在跑時才會用到。

    ⚠ 這裡**刻意重用 _dump_get/_day_reset/_day_put/_day_commit**，不自己再抄一份解析：
      原本抄了一份，而那份用 `d0 = d0 or ...`（日期只取第一個來源的）→ TWSE 與 TPEX
      分屬不同交易日時，TPEX 的每一列都會被貼上 TWSE 的日期＝日期錯的 K 棒。
      主路徑修好了、這份沒有，正是「同樣的邏輯抄兩份」必然出現的分歧。現在只有一份。"""
    global _TW_DAY_REFRESHING
    try:
        for url, code_key, ohlc, vol_key in (
            (TWSE_DAY_ALL_URL, "Code", ("OpeningPrice", "HighestPrice", "LowestPrice", "ClosingPrice"), "TradeVolume"),
            (TPEX_DAY_ALL_URL, "SecuritiesCompanyCode", ("Open", "High", "Low", "Close"), "TradingShares"),
        ):
            try:
                data, changed = _dump_get(url, DUMP_DAY, timeout=20)
                if not changed:            # 沒變 → 這來源既有的 _TW_DAY_SRC 仍有效
                    continue
                _day_reset(url)
                for item in data:
                    c = (item.get(code_key) or "").strip()
                    if c.isdigit() and len(c) == 4:
                        _day_put(url, c, item, ohlc, vol_key, item.get("Date"))
                _dump_done(url, DUMP_DAY, _TW_DAY_SRC.get(url))
            except Exception as e:
                _log.warning(f"[tw_day_all] {url.rsplit('/', 1)[-1]} 失敗: {e}")
        _day_commit()
        _TW_DAY_ALL["ts"] = _time.time()   # 就算全失敗也更新時戳，避免狂重試
    finally:
        _TW_DAY_REFRESHING = False


def tw_daily_fill_latest(df, symbol: str):
    """yfinance 日線落後時，用官方 opendata 補上最新那個交易日。

    只在「官方交易日**嚴格新於** df 最後一根」時才補 —— 日期一樣就不動，讓 yfinance
    自己那根當主（整條序列的成交量口徑才一致，見上方說明）。"""
    if df is None or df.empty or "time" not in df.columns:
        return df
    try:
        d0, rows = fetch_tw_day_all()
        bar = rows.get(str(symbol).strip()) if d0 else None
        if not bar:
            return df
        last = pd.to_datetime(df["time"].iloc[-1]).date()
        if d0 <= last:                                   # 已經有了（或官方比較舊）→ 不動
            return df
        add = pd.DataFrame([{"time": pd.Timestamp(d0), **bar}])
        return pd.concat([df, add], ignore_index=True)
    except Exception as e:
        _log.warning(f"[tw_daily_fill] {symbol}: {e}")
        return df
