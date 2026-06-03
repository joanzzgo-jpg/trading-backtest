"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os
import threading
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, fetch_tw_daily_yf, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.fugle import fetch_fugle_intraday, fugle_enabled
from data.alpaca import fetch_alpaca_bars, alpaca_enabled
from data.twelvedata import fetch_twelvedata_intraday, twelvedata_enabled
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.us_finnhub import fetch_us_quote
from data.crypto import fetch_crypto_ohlcv
from utils.cache import cache, data_cache
from utils import disk_cache
from utils.data import enrich_df, df_to_records
from utils.crt import _calc_crt_winrate

router = APIRouter(prefix="/api", tags=["data"])

# ── 單飛鎖（single-flight）：多人同時要同一份重量級 df 時，只有一個請求真的去抓，
#    其餘等它的結果。防「快取雪崩」（cache stampede）——避免 N 個使用者同時觸發 N 次
#    一模一樣的 12 秒抓取＋撞共用 IP 限流。每個 key 一把 threading.Lock（端點為同步、跑在
#    threadpool，故用 thread lock）。 ──
_inflight_locks: dict = {}
_inflight_guard = threading.Lock()

# 勝率 / df 快取保鮮期（秒）。30 分鐘：最近一根訊號最多慢 30 分（即時價另走每秒路徑、
# 不受此影響）。有單飛鎖護著故不會雪崩；想更新鮮可再調小、想更省限流可調大。
_WR_CACHE_TTL = 1800

def _keyed_lock(key: str) -> threading.Lock:
    with _inflight_guard:
        lk = _inflight_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _inflight_locks[key] = lk
        return lk


@router.get("/_diag")
def diag():
    """環境變數診斷（只回名稱/長度/數量，**絕不洩漏金鑰值**），用來確認 Railway 設定是否生效。"""
    from data.fugle import _keys as _fugle_keys
    from data.twelvedata import _keys as _td_keys
    names = sorted(os.environ.keys())
    return {
        "fugle_keys": len(_fugle_keys()),                  # 台股：Fugle 金鑰把數（0 = 沒設對）
        "twelvedata_keys": len(_td_keys()),                # 美股：Twelve Data 金鑰把數
        "fugle_like_var_names": [k for k in names if "fug" in k.lower()],
        "twelvedata_like_var_names": [k for k in names if "twelve" in k.lower() or "12data" in k.lower()],
        "alpaca": bool(os.getenv("ALPACA_KEY") and os.getenv("ALPACA_SECRET")),
        "finnhub": bool(os.getenv("FINNHUB_TOKEN")),
        "cwa": bool(os.getenv("CWA_API_KEY")),
    }


@router.post("/reset_pionex_cooldown")
def reset_pionex_cooldown():
    """手動清除 Pionex 5 分鐘限流冷卻（給卡死時應急用）"""
    import data.crypto as _c
    _c._PIONEX_COOLDOWN_UNTIL = 0.0
    return {"ok": True, "msg": "Pionex 冷卻已清除"}


@router.get("/pionex_status")
def pionex_status():
    """看 Pionex 冷卻狀態：是否冷卻中、剩幾秒、上次呼叫多久前"""
    import data.crypto as _c
    import time as _t
    now = _t.time()
    return {
        "cooldown_active": now < _c._PIONEX_COOLDOWN_UNTIL,
        "cooldown_remaining_sec": max(0, int(_c._PIONEX_COOLDOWN_UNTIL - now)),
        "concurrency_limit": 3,
    }



def _finnhub_overlay(df: pd.DataFrame, quote: dict):
    """把 Finnhub 即時報價疊加到 yfinance 最後一根 K 棒。Returns (df, is_live).
    只更新「close」並擴展 high/low；不建新 bar（避免半小時錯位的 1h/4h 對齊問題，
    讓 yfinance 自己掃進新 bar，Finnhub 只負責即時更新最後一根的價格）。
    """
    import time as _time
    if not quote or df.empty:
        return df, False
    # 報價超過 5 分鐘就不算即時（市場已收盤或 token 出錯）
    if (_time.time() - quote.get("timestamp", 0)) > 300:
        return df, False
    df = df.copy()
    i = df.index[-1]
    last = df.iloc[-1]
    close = float(quote["close"])
    df.at[i, "close"] = close
    df.at[i, "high"]  = max(float(last["high"] or close), close)
    df.at[i, "low"]   = min(float(last["low"]  or close), close)
    return df, True


def _mis_overlay(df: pd.DataFrame, rt: dict, minutes: int):
    """Overlay TWSE MIS live price onto the latest intraday bar. Returns (df, is_live).
    fetch_tw_intraday_yf already floors timestamps to bar boundaries, so last_ts
    should already be clean. We also floor defensively here for safety.
    """
    mis_utc = rt["time"] - timedelta(hours=8)          # TST naive → UTC naive
    total_min = mis_utc.hour * 60 + mis_utc.minute
    bar_min = (total_min // minutes) * minutes
    bar_ts = mis_utc.replace(hour=bar_min // 60, minute=bar_min % 60,
                             second=0, microsecond=0)
    # 台股交易時間：09:00-13:30 Taipei。bar_ts 對應的 TPE 時間若在交易時間外，
    # 不建立/更新 bar（避免 13:30 收盤後 MIS 還回傳資料時造出 phantom 13:30 bar）
    bar_tpe_min = ((bar_ts.hour + 8) % 24) * 60 + bar_ts.minute
    if bar_tpe_min < 9 * 60 or bar_tpe_min >= 13 * 60 + 30:
        return df, False
    last = df.iloc[-1]
    last_ts = pd.Timestamp(last["time"])
    last_bar_ts = last_ts.floor(f"{minutes}min")
    close = rt["close"]
    if bar_ts == last_bar_ts:
        df = df.copy()
        i = df.index[-1]
        df.at[i, "close"] = close
        df.at[i, "high"]  = max(float(last["high"] or close), close)
        df.at[i, "low"]   = min(float(last["low"]  or close), close)
        return df, True
    if bar_ts > last_bar_ts:
        # yfinance 台股分鐘線延遲 ~20 分：若把即時棒放到「現在」的時間點，會與最後一根真實棒
        # 之間出現 ~20 分鐘空隙。改為把即時棒接在「最後一根真實棒的下一根」→ 連續、無 gap；
        # 等 yfinance 之後補上真實資料(tail 多送幾根)就會覆蓋並自然往前推進。
        o = float(last["close"] or close)
        new = {"time": last_bar_ts + timedelta(minutes=minutes), "open": o,
               "high": max(o, close), "low": min(o, close), "close": close, "volume": 0}
        for col in df.columns:
            if col not in new:
                new[col] = None
        df = pd.concat([df, pd.DataFrame([new])], ignore_index=True)
        return df, True
    return df, False


# ───────── MIS 即時累積『真實』分鐘 K（突破 yfinance 台股 ~20 分延遲）─────────
# yfinance/Yahoo 對台股分鐘線強制延遲約 20 分鐘（無解）。但 TWSE MIS 即時報價無延遲
# （回傳即時價 + 當日累積成交量），故逐次取樣可即時堆出『真實』分鐘 K，填補 yfinance
# 尚未公布的最近 ~20 分鐘，讓圖表連續且即時。狀態存於模組層（隨伺服器存活；重啟後
# 需重新累積，約一個交易時段內收斂）。
_mis_acc: dict = {}   # key f"{symbol}:{minutes}" → {"day":date, "cur":{...}|None, "done":{ts:bar}}

def _mis_acc_list(symbol: str, minutes: int):
    st = _mis_acc.get(f"{symbol}:{minutes}")
    if not st:
        return []
    keys = set(st["done"].keys())
    if st["cur"]:
        keys.add(st["cur"]["ts"])
    out = []
    for ts in sorted(keys):
        b = st["cur"] if (st["cur"] and ts == st["cur"]["ts"]) else st["done"][ts]
        out.append({"time": ts, "open": b["o"], "high": b["h"], "low": b["l"],
                    "close": b["c"], "volume": b["vol"]})
    return out

def _mis_accumulate(symbol: str, minutes: int, rt: dict):
    """用 TWSE MIS 即時報價即時堆出當前/近期『真實』分鐘 K 棒。回傳今日已累積 bar list(升冪)。"""
    price = rt.get("close")
    mis_utc = rt["time"] - timedelta(hours=8)              # TST naive → UTC naive
    bar_min = (mis_utc.hour * 60 + mis_utc.minute) // minutes * minutes
    bar_ts  = mis_utc.replace(hour=bar_min // 60, minute=bar_min % 60, second=0, microsecond=0)
    bar_tpe = ((bar_ts.hour + 8) % 24) * 60 + bar_ts.minute
    # 僅交易時段(09:00-13:30 TPE)累積；其餘時間回傳已累積結果不動
    if price is None or bar_tpe < 9 * 60 or bar_tpe >= 13 * 60 + 30:
        return _mis_acc_list(symbol, minutes)
    key = f"{symbol}:{minutes}"
    st = _mis_acc.get(key)
    if st is None or st["day"] != mis_utc.date():          # 換日重置
        st = {"day": mis_utc.date(), "cur": None, "done": {}}
        _mis_acc[key] = st
    cumvol = rt.get("volume") or 0
    cur = st["cur"]
    if cur is None or cur["ts"] != bar_ts:                 # 新分鐘 → 收掉舊棒、開新棒
        if cur is not None:
            st["done"][cur["ts"]] = cur
        st["cur"] = {"ts": bar_ts, "o": price, "h": price, "l": price, "c": price, "vol0": cumvol, "vol": 0}
    else:                                                  # 同分鐘 → 更新高/低/收 + 量(累積量差)
        cur["h"] = max(cur["h"], price); cur["l"] = min(cur["l"], price); cur["c"] = price
        cur["vol"] = max(0, cumvol - cur["vol0"])
    return _mis_acc_list(symbol, minutes)


# ───────── Finnhub 即時累積美股分鐘 K（免費、免 KYC，用既有 FINNHUB_TOKEN）─────────
# Alpaca 需券商 KYC/付費，故美股即時改用 Finnhub /quote 即時價自己堆分鐘棒（同 MIS 思路）。
# Finnhub quote 無成交量 → 即時棒 volume=0（yfinance 之後回補真實量）。報價過期(>5min)不累積。
_fh_acc: dict = {}

def _fh_acc_list(symbol: str, minutes: int):
    st = _fh_acc.get(f"{symbol}:{minutes}")
    if not st:
        return []
    keys = set(st["done"].keys())
    if st["cur"]:
        keys.add(st["cur"]["ts"])
    out = []
    for ts in sorted(keys):
        b = st["cur"] if (st["cur"] and ts == st["cur"]["ts"]) else st["done"][ts]
        out.append({"time": ts, "open": b["o"], "high": b["h"], "low": b["l"],
                    "close": b["c"], "volume": 0})
    return out

def _finnhub_accumulate(symbol: str, minutes: int, quote: dict):
    """用 Finnhub 即時報價即時堆出美股當前分鐘 K。回傳今日已累積 bar list(升冪)；報價過期→不動。"""
    import time as _t
    if not quote:
        return _fh_acc_list(symbol, minutes)
    qt = int(quote.get("timestamp") or 0)
    price = quote.get("close")
    if not price or (_t.time() - qt) > 300:                # 報價過期(收盤/錯誤)→ 不累積
        return _fh_acc_list(symbol, minutes)
    step = minutes * 60
    bar_ts = pd.Timestamp((qt // step) * step, unit="s")   # epoch floor → UTC naive
    key = f"{symbol}:{minutes}"
    st = _fh_acc.get(key)
    if st is None or st["day"] != bar_ts.date():           # 換日重置
        st = {"day": bar_ts.date(), "cur": None, "done": {}}
        _fh_acc[key] = st
    cur = st["cur"]
    if cur is None or cur["ts"] != bar_ts:                 # 新分鐘 → 收掉舊棒、開新棒
        if cur is not None:
            st["done"][cur["ts"]] = cur
        st["cur"] = {"ts": bar_ts, "o": price, "h": price, "l": price, "c": price}
    else:                                                  # 同分鐘 → 更新高/低/收
        cur["h"] = max(cur["h"], price); cur["l"] = min(cur["l"], price); cur["c"] = price
    return _fh_acc_list(symbol, minutes)


class OHLCVRequest(BaseModel):
    market: str
    symbol: str
    start: str = ""
    end: str = ""
    limit: int = 0
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@router.post("/ohlcv")
def get_ohlcv(req: OHLCVRequest):
    """取得 OHLCV 數據"""
    use_limit = req.limit > 0
    cache_key = f"ohlcv:{req.market}:{req.symbol}:{req.timeframe}:{req.exchange}:{req.start}:{req.end}:{req.limit}"
    ttl = 30 if use_limit else 300
    cached = cache.get(cache_key, ttl)
    if cached:
        return cached

    try:
        if req.market == "tw":
            if "/" in req.symbol:
                raise ValueError(f"{req.symbol} 不是台股代號，請確認市場選擇")
            if req.timeframe in ("5m", "15m", "1h", "4h"):
                # 4h 走 1h 來源再重採樣（避免 yfinance 1h bug）
                src_tf = "1h" if req.timeframe == "4h" else req.timeframe
                max_d = TW_YF_MAX_DAYS.get(src_tf, 60)
                if use_limit:
                    bars_per_day = {"5m": 78, "15m": 26, "1h": 5, "4h": 2}.get(req.timeframe, 26)
                    days = min(max_d, req.limit // bars_per_day)
                    days = max(days, 5)
                    end   = date.today().isoformat()
                    start = (date.today() - timedelta(days=days)).isoformat()
                else:
                    end   = req.end or date.today().isoformat()
                    start_raw = req.start or end
                    min_start = (date.fromisoformat(end) - timedelta(days=max_d)).isoformat()
                    start = max(start_raw, min_start)
                try:
                    df = fetch_tw_intraday_yf(req.symbol, src_tf, start, end)
                except Exception:
                    # 無 token 時 FinMind 會直接 422，有 token 才 fallback
                    if req.finmind_token:
                        fm_start = max(start, (date.fromisoformat(end) - timedelta(days=90)).isoformat())
                        df = fetch_tw_intraday(req.symbol, src_tf, fm_start, end, req.finmind_token)
                    else:
                        raise
                # ⭐ 今日改用 Fugle 富果即時分鐘K（歷史仍 yfinance）→ 一載入就即時、無 20 分延遲、
                #    無空隙。只在「查詢範圍含今日」時併入（歷史/重播查詢 end 為過去日，跳過不影響）。
                if (fugle_enabled() and src_tf in ("5m", "15m", "1h")
                        and end >= date.today().isoformat() and not df.empty):
                    fdf = fetch_fugle_intraday(req.symbol, src_tf)
                    if fdf is not None and not fdf.empty:
                        cutoff = fdf["time"].min()           # Fugle 當日最早一根 → 之後全用 Fugle
                        df = pd.concat([df[df["time"] < cutoff], fdf],
                                       ignore_index=True).sort_values("time").reset_index(drop=True)
                # 4h 重採樣（對齊台北 09:00 = UTC 01:00）
                if req.timeframe == "4h":
                    df = df.set_index("time").resample(
                        "4h", origin="start_day", offset="1h"
                    ).agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"}) \
                     .dropna(subset=["open"]).reset_index()
                if use_limit:
                    df = df.tail(req.limit)
            else:
                if use_limit:
                    end   = date.today().isoformat()
                    start = (date.today() - timedelta(days=req.limit * 2)).isoformat()
                else:
                    start, end = req.start, req.end
                try:
                    df = fetch_tw_daily_yf(req.symbol, start, end)
                except Exception:
                    df = fetch_tw_stock(req.symbol, start, end, req.finmind_token)
                df = resample_tw(df, req.timeframe)
                if use_limit:
                    df = df.tail(req.limit)
        elif req.market == "crypto":
            if use_limit:
                df = fetch_crypto_ohlcv(
                    req.symbol, req.timeframe, limit=req.limit,
                    exchange_id=req.exchange, api_key=req.api_key, api_secret=req.api_secret,
                )
            else:
                df = fetch_crypto_ohlcv(
                    req.symbol, req.timeframe, req.start, req.end,
                    req.exchange, api_key=req.api_key, api_secret=req.api_secret,
                )
        elif req.market == "us":
            max_d = US_MAX_DAYS.get(req.timeframe, 3650)
            # 美股各 TF 每日 bar 數（用於 limit→days 反推，避免過量請求觸 yfinance 邊界）
            # 6.5h 交易：4h≈2、1h≈7、15m≈26、5m≈78
            _bpd = {"1M": 1/30, "1w": 1/7, "1d": 1, "4h": 2, "2h": 3.25, "1h": 7, "15m": 26, "5m": 78}
            if use_limit:
                bars_per_day = _bpd.get(req.timeframe, 1)
                # 1.6 倍 buffer 容納週末/假日
                days_need = max(5, int(req.limit / bars_per_day * 1.6))
                days = min(days_need, max_d)
                end   = date.today().isoformat()
                start = (date.today() - timedelta(days=days)).isoformat()
            else:
                end   = req.end or date.today().isoformat()
                start_raw = req.start or end
                min_start = (date.fromisoformat(end) - timedelta(days=max_d)).isoformat()
                start = max(start_raw, min_start)
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
            # Finnhub 即時報價疊加到最後一根 K 棒（失敗不影響主流程）
            if os.getenv("FINNHUB_TOKEN"):
                try:
                    quote = fetch_us_quote(req.symbol)
                    df, _ = _finnhub_overlay(df, quote)
                except Exception:
                    pass  # Finnhub 出錯就純用 yfinance 資料，不阻塞
        else:
            raise HTTPException(400, f"不支援的市場: {req.market}")
    except Exception as e:
        raise HTTPException(400, str(e))

    if df.empty:
        raise HTTPException(400, f"查無 {req.symbol} 的資料，該標的可能不支援此交易所")

    df = enrich_df(df)
    result = {"data": df_to_records(df)}
    cache.set(cache_key, result)
    return result


class LatestRequest(BaseModel):
    market: str
    symbol: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@router.post("/latest")
def get_latest(req: LatestRequest):
    """取得最新 K 棒"""
    try:
        if req.market == "tw":
            if "/" in req.symbol:
                raise ValueError(f"{req.symbol} 不是台股代號，請確認市場選擇")
            # 1. TWSE MIS 即時（盤中），快取 10 秒（即時棒要夠即時，單一標的每分鐘約 6 次、仍禮貌）
            mis_key = f"tw_mis_{req.symbol}"
            rt = cache.get(mis_key, ttl=10)
            if rt is None:
                rt = fetch_tw_realtime(req.symbol)
                if rt:
                    cache.set(mis_key, rt)
            tf = req.timeframe
            if rt and tf == "1d":
                # MIS 只在日線使用：回傳整日 OHLCV 符合日線語意
                # TWSE MIS 回傳台灣本地時間（UTC+8），前端 toTime() 預期 UTC
                ts = rt["time"] - timedelta(hours=8)
                ts = dt(ts.year, ts.month, ts.day)
                return {"live": True, "data": [{
                    "time":   ts.isoformat(),
                    "open":   rt["open"],
                    "high":   rt["high"],
                    "low":    rt["low"],
                    "close":  rt["close"],
                    "volume": rt["volume"],
                }]}
            # 分鐘/小時時框：
            if tf in ("5m", "15m", "1h", "4h"):
                # ⭐ Fugle 富果即時分鐘K 優先（無 20 分延遲、無空隙、任何標的秒出、不需 MIS 累積）。
                #    快取 8 秒；失敗或未設 FUGLE_TOKEN → fallback 回下方 yfinance + MIS。
                if tf in ("5m", "15m", "1h") and fugle_enabled():
                    fkey = f"tw_fugle_{req.symbol}_{tf}"
                    fdf = cache.get(fkey, ttl=8)
                    if fdf is None:
                        fdf = fetch_fugle_intraday(req.symbol, tf)
                        if fdf is not None and not fdf.empty:
                            cache.set(fkey, fdf)
                    if fdf is not None and not fdf.empty:
                        return {"live": True, "data": df_to_records(fdf.tail(20))}
                yf_intra_key = f"tw_yf_intra_{req.symbol}_{tf}"
                df_intra = cache.get(yf_intra_key, ttl=300)
                if df_intra is None:
                    try:
                        end_d   = date.today().isoformat()
                        start_d = (date.today() - timedelta(days=3)).isoformat()
                        df_intra = fetch_tw_intraday_yf(req.symbol, tf, start_d, end_d)
                        if not df_intra.empty:
                            cache.set(yf_intra_key, df_intra)
                    except Exception:
                        pass
                if df_intra is not None and not df_intra.empty:
                    df_out = df_intra.tail(6).copy()           # 多送幾根，讓 yfinance 之後補的真實棒能覆蓋暫時的 MIS 棒
                    recs = df_to_records(df_out)
                    is_live = False
                    if rt and tf in ("5m", "15m", "1h"):
                        minutes = {"5m": 5, "15m": 15, "1h": 60}[tf]
                        # MIS 即時累積真實分鐘棒：把 yfinance 最後一根之後的(含當下這根)接上 → 當下就有最新棒、無 20 分 gap
                        yf_last = pd.Timestamp(df_out.iloc[-1]["time"]).floor(f"{minutes}min")
                        for b in _mis_accumulate(req.symbol, minutes, rt):
                            if pd.Timestamp(b["time"]) > yf_last:
                                recs.append({"time": b["time"].isoformat(), "open": b["open"],
                                             "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]})
                                is_live = True
                    return {"live": is_live, "data": recs}
                # 分鐘/小時不可 fall-through 到日線來源（時間戳不相容）
                return {"live": False, "data": []}
            # 2. yfinance fallback（盤中約 15 分鐘延遲，盤後即時），快取 5 分鐘
            yf_key = f"tw_yf_{req.symbol}"
            yf_cached = cache.get(yf_key, ttl=300)
            if yf_cached:
                return yf_cached
            yf_bar = fetch_tw_latest_bar_yf(req.symbol)
            if yf_bar:
                result = {"live": False, "data": [{
                    "time":   yf_bar["time"].isoformat(),
                    "open":   yf_bar["open"],
                    "high":   yf_bar["high"],
                    "low":    yf_bar["low"],
                    "close":  yf_bar["close"],
                    "volume": yf_bar["volume"],
                }]}
                cache.set(yf_key, result)
                return result
            # 3. FinMind 最終備援
            end   = date.today().isoformat()
            start = (date.today() - timedelta(days=5)).isoformat()
            df = fetch_tw_stock(req.symbol, start, end, req.finmind_token)
            df = resample_tw(df, req.timeframe)
        elif req.market == "us":
            # ⭐ Alpaca IEX 即時分鐘K 優先（無延遲、當下就有最新棒）；快取 8 秒、失敗 fallback 回 Finnhub+yfinance
            if alpaca_enabled():
                akey = f"us_alpaca_{req.symbol}_{req.timeframe}"
                adf = cache.get(akey, ttl=8)
                if adf is None:
                    adf = fetch_alpaca_bars(req.symbol, req.timeframe,
                                            start=(date.today() - timedelta(days=6)).isoformat())
                    if adf is not None and not adf.empty:
                        cache.set(akey, adf)
                if adf is not None and not adf.empty:
                    return {"live": True, "data": df_to_records(adf.tail(20))}
            # ⭐ Twelve Data 即時 + 成交量（可選升級；設 TWELVEDATA_TOKEN 啟用）；快取 10 秒
            if twelvedata_enabled() and req.timeframe in ("5m", "15m", "1h", "4h"):
                tkey = f"us_td_{req.symbol}_{req.timeframe}"
                tdf = cache.get(tkey, ttl=10)
                if tdf is None:
                    tdf = fetch_twelvedata_intraday(req.symbol, req.timeframe)
                    if tdf is not None and not tdf.empty:
                        cache.set(tkey, tdf)
                if tdf is not None and not tdf.empty:
                    return {"live": True, "data": df_to_records(tdf.tail(20))}
            end   = date.today().isoformat()
            start = (date.today() - timedelta(days=10)).isoformat()
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
            # Finnhub 即時報價（免費/免 KYC）：盤中分鐘/小時用即時價自己堆「當下這根」真實K(無量,
            # yfinance 回補)→ 接在 yfinance 最後一根之後、無 20 分延遲；報價過期或日線→只疊加最後一根。
            if os.getenv("FINNHUB_TOKEN"):
                try:
                    quote = fetch_us_quote(req.symbol)
                    _mins = {"5m": 5, "15m": 15, "1h": 60, "4h": 240}.get(req.timeframe)
                    acc = _finnhub_accumulate(req.symbol, _mins, quote) if (_mins and quote) else []
                    if acc:
                        recs = df_to_records(df.tail(6))
                        yf_last = pd.Timestamp(df.iloc[-1]["time"]).floor(f"{_mins}min")
                        for b in acc:
                            if pd.Timestamp(b["time"]) > yf_last:
                                recs.append({"time": b["time"].isoformat(), "open": b["open"],
                                             "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]})
                        return {"live": True, "data": recs}
                    df, _ = _finnhub_overlay(df, quote)   # 報價過期/日線 → 退回疊加最後一根
                except Exception:
                    pass  # Finnhub 出錯就純用 yfinance 資料
        else:
            df = fetch_crypto_ohlcv(
                req.symbol, req.timeframe, limit=3,
                exchange_id=req.exchange,
                api_key=req.api_key, api_secret=req.api_secret,
            )
    except Exception as e:
        raise HTTPException(400, str(e))

    if df.empty:
        raise HTTPException(400, "無資料")

    records = df_to_records(df.tail(2))
    # 若有 FINNHUB_TOKEN，美股也算即時
    live = (req.market == "crypto") or (req.market == "us" and bool(os.getenv("FINNHUB_TOKEN")))
    return {"live": live, "data": records}


def _solve_stop_pct(df, target: str, long_only: bool):
    """掃描止損%，找出讓「敗後停手」總勝率達標的最小止損%。
    目標 80%（止損 ≤5%）；若需 >5% 才達 80%，改找達 75% 的止損%。
    回傳 {stop_pct, win_rate, total, target, sweep}。"""
    def _wr_at(buf):
        # _solve 精簡模式：只算選定 target 的「敗後停手」勝率（比完整計算快 ~4-6x）
        r = _calc_crt_winrate(df, stop_buffer_pct=buf, long_only=long_only,
                              _solve=target)
        return r.get("win_rate"), (r.get("total") or 0)

    sweep = []
    buf = 0.0
    while buf <= 0.0601:
        wr, tot = _wr_at(round(buf, 4))
        sweep.append({"pct": round(buf * 100, 2), "wr": wr, "total": tot})
        buf += 0.005

    def _first(thresh, max_pct):
        for s in sweep:
            if s["wr"] is not None and s["wr"] >= thresh and s["pct"] <= max_pct + 1e-9:
                return s
        return None

    hit = _first(80, 5.0)
    if hit:
        return {"stop_pct": hit["pct"], "win_rate": hit["wr"], "total": hit["total"],
                "target": 80, "achieved": True, "sweep": sweep}
    hit = _first(75, 6.0)
    if hit:
        return {"stop_pct": hit["pct"], "win_rate": hit["wr"], "total": hit["total"],
                "target": 75, "achieved": True, "sweep": sweep}
    best = max(sweep, key=lambda s: (s["wr"] or 0))
    return {"stop_pct": best["pct"], "win_rate": best["wr"], "total": best["total"],
            "target": 80, "achieved": False, "sweep": sweep}


@router.get("/crt_winrate")
def get_crt_winrate(
    market: str,
    symbol: str,
    timeframe: str = "1d",
    exchange: str = "pionex",
    stop_buffer_pct: float = 0.0,
    solve: int = 0,
    solve_target: str = "mid",
    api_key: str = "",
    api_secret: str = "",
    finmind_token: str = "",
):
    """CRT 策略各時間級別勝率（每個子統計至少 10 個案例，不足則往前翻倍）。

    stop_buffer_pct：停損緩衝（decimal，例 0.005 = 0.5%）。
    短：stop = base_high × (1 + buf)；多：stop = base_low × (1 - buf)。
    """
    from datetime import date, timedelta
    _buf = round(max(0.0, float(stop_buffer_pct or 0.0)), 4)
    _long_only = (market == "tw")  # 台股不能放空
    cache_key = f"crt_wr71:{market}:{symbol}:{exchange}:{timeframe}:{_buf}:{int(_long_only)}"
    # 注意：solve 模式不可命中此勝率快取（cache_key 不含 solve），否則會回傳勝率而非求解結果
    if not solve:
        cached = data_cache.get(cache_key, ttl=_WR_CACHE_TTL)   # 保鮮期內直接回快取（即時價另走每秒路徑）
        if cached:
            return cached

    MIN_CASES = 40   # 每個訊號（S1~S7 × 空/多）最少採樣數；不足會自動往前加倍天數
    # 各時間框架：初始天數 / 最大天數
    # 上限拉到資料源實際可能的歷史深度（Binance fapi BTC 2019/9~、spot 2017/8~、Bybit/OKX 類似）
    TF_INIT = {"1M": 3650, "1w": 1825, "1d": 730,  "8h": 730,  "4h": 365,  "2h": 365,  "1h": 365,   "30m": 90,  "15m": 60,  "5m": 30}
    # 注意：TF_MAX 是「勝率計算」用的歷史深度，不是圖表顯示深度
    # 5/15/30m 圖上不必看到太久以前，但統計需要足夠案例數（MIN_CASES=40 × 11 訊號 × 空/多）
    TF_MAX  = {"1M": 7300, "1w": 7300, "1d": 7300, "8h": 5475, "4h": 5475, "2h": 4380, "1h": 2920,  "30m": 730, "15m": 720, "5m": 180}

    def _sufficient(r: dict) -> bool:
        """每個訊號的空/多案例數都達到 MIN_CASES"""
        return all(
            (r.get(sig) or {}).get(d, {}).get("total", 0) >= MIN_CASES
            for sig in ("abc", "ab", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11") for d in ("short", "long")
        )

    def _fetch_df(days: int) -> pd.DataFrame:
        """依市場 / 時間框架取得指定天數的 K 棒"""
        end = date.today().isoformat()
        if market == "tw":
            if timeframe in ("5m", "15m", "1h"):
                max_d = TW_YF_MAX_DAYS.get(timeframe, 60)
                start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
                try:
                    return fetch_tw_intraday_yf(symbol, timeframe, start, end)
                except Exception:
                    if finmind_token:
                        return fetch_tw_intraday(symbol, timeframe, start, end, finmind_token)
                    raise
            elif timeframe == "4h":
                max_d = TW_YF_MAX_DAYS.get("1h", 60)
                start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
                try:
                    _df = fetch_tw_intraday_yf(symbol, "1h", start, end)
                except Exception:
                    if finmind_token:
                        _df = fetch_tw_intraday(symbol, "1h", start, end, finmind_token)
                    else:
                        raise
                _df = _df.set_index("time")
                # offset="1h" 對齊到 UTC 01:00 = 台北 09:00（TW 開盤）
                # 4h bins：UTC 01:00-04:59（TPE 09:00-13:00 主力交易）、05:00 後半段（13:00-13:30 收尾，極短）
                _df = _df.resample("4h", origin="start_day", offset="1h").agg(
                    {"open":"first","high":"max","low":"min","close":"last","volume":"sum"}
                )
                return _df.dropna(subset=["open"]).reset_index()
            else:
                start = (date.today() - timedelta(days=days)).isoformat()
                try:
                    _df = fetch_tw_daily_yf(symbol, start, end)
                except Exception:
                    _df = fetch_tw_stock(symbol, start, end, finmind_token)
                if timeframe != "1d":
                    _df = resample_tw(_df, timeframe)
                return _df
        elif market == "us":
            max_d = US_MAX_DAYS.get(timeframe, 3650)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            return fetch_us_stock(symbol, start, end, timeframe)
        elif market == "crypto":
            start = (date.today() - timedelta(days=days)).isoformat()
            # 勝率只用 OHLC（不看成交量）→ 優先用 Binance 合約並行抓取（快、無 Pionex 10req/s 限流）。
            # 主流幣兩邊 OHLC 幾乎一致、訊號相同；Pionex 獨有小幣 Binance 抓不到 → fallback 原路由。
            # 圖表顯示仍走原 exchange（Pionex，成交量一致），不受此影響。
            from data.crypto import _fetch_binance_fapi, _calc_max_candles
            _base = symbol[:-2] if symbol.upper().endswith(".P") else symbol
            _bb = _base.split("/")[0].upper()
            _mc = _calc_max_candles(start, end, timeframe)
            # 依序試：原名 → Binance 的 1000x 命名（PEPE→1000PEPE，價格÷1000 對齊原尺度）。
            # 1000x 不影響訊號（指標皆相對值），把更多迷因幣移到快路徑、少打 Pionex 共用限額。
            for _cand, _div in ((_base, 1.0), (f"1000{_bb}/USDT", 1000.0)):
                try:
                    _dfb = _fetch_binance_fapi(_cand, timeframe, start, end, 0, max_candles=_mc)
                    if not _dfb.empty and len(_dfb) >= 50:
                        if _div != 1.0:
                            for _c in ("open", "high", "low", "close"):
                                _dfb[_c] = _dfb[_c] / _div
                        return _dfb
                except Exception:
                    pass
            # Binance（含 1000x）都沒有 → Pionex 獨有 → 走原路由
            return fetch_crypto_ohlcv(symbol, timeframe, start, end, exchange,
                                      api_key=api_key, api_secret=api_secret)
        raise HTTPException(400, f"不支援的市場: {market}")

    # 直接一次抓 TF_MAX 天的資料（不再做 doubling loop —— 過去 S1/S5/S7 等稀有訊號
    # 永遠達不到 MIN_CASES=40，doubling 會跑滿 4 次浪費 80% 時間）
    days_max  = TF_MAX.get(timeframe, 3650)
    # 已抓+enrich 的 df 另外快取（不含 buffer）→ 換 SL 緩衝等重算時免重抓（抓資料佔總時間 90%+）
    df_key = f"crt_df3:{market}:{symbol}:{exchange}:{timeframe}"
    def _load_df():
        d = data_cache.get(df_key, ttl=_WR_CACHE_TTL)   # 記憶體
        if d is None:
            d = disk_cache.get(df_key, ttl=_WR_CACHE_TTL)   # 磁碟（跨重啟/部署存活）
            if d is not None:
                data_cache.set(df_key, d)           # 回填記憶體
        return d

    df = _load_df()
    if df is None:
        # 單飛鎖：多人同時要同一 df 只有一個真的抓，其餘等結果（防雪崩＋省共用限流）
        with _keyed_lock(df_key):
            df = _load_df()   # double-check：可能別的請求剛抓好並回填
            if df is None:
                try:
                    df = _fetch_df(days_max)
                except Exception as e:
                    raise HTTPException(400, str(e))
                if len(df) < 50:
                    raise HTTPException(400, f"資料不足 50 根K棒（{timeframe}）")
                df = enrich_df(df)
                data_cache.set(df_key, df)
                disk_cache.set(df_key, df)       # 寫磁碟（下次重啟/部署免重抓）

    # 求解模式：掃描止損% 找達標的建議值（用已快取的 df，免重抓）
    if solve:
        solve_key = f"crt_solve5:{market}:{symbol}:{exchange}:{timeframe}:{solve_target}:{int(_long_only)}"
        cached_s = data_cache.get(solve_key, ttl=3600)
        if cached_s:
            return cached_s
        _solve_tgt = solve_target if solve_target in ("mid", "band", "rr") else "mid"
        sol = _solve_stop_pct(df, target=_solve_tgt, long_only=_long_only)
        data_cache.set(solve_key, sol)
        return sol

    result = _calc_crt_winrate(df, stop_buffer_pct=_buf, long_only=_long_only)

    data_cache.set(cache_key, result)
    return result
