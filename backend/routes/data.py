"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, fetch_tw_daily_yf, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.crypto import fetch_crypto_ohlcv
from utils.cache import cache
from utils.data import enrich_df, df_to_records

router = APIRouter(prefix="/api", tags=["data"])


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
        new = {"time": bar_ts, "open": float(last["close"] or close),
               "high": close, "low": close, "close": close, "volume": 0}
        for col in df.columns:
            if col not in new:
                new[col] = None
        df = pd.concat([df, pd.DataFrame([new])], ignore_index=True)
        return df, True
    return df, False


def _ts(row) -> str:
    """pandas Timestamp → ISO 字串（含 T，避免 toTime 解析 NaN）"""
    t = row["time"]
    return t.isoformat() if hasattr(t, "isoformat") else str(t)


def _scan_outcome(df: pd.DataFrame, entry_i: int, stop_px: float, direction: str):
    """從 entry_i 向後掃描，回傳 'win' / 'loss' / None（未結算）"""
    n = len(df)
    for j in range(entry_i, n):
        bar    = df.iloc[j]
        bb_mid = bar.get("bb_middle")
        if pd.isna(bb_mid):
            continue
        hi, lo, cl = float(bar["high"]), float(bar["low"]), float(bar["close"])
        bb_mid = float(bb_mid)
        if direction == "short":
            hit_stop = hi >= stop_px
            hit_tgt  = lo <= bb_mid
            if hit_stop and hit_tgt:
                return "win" if cl <= bb_mid else "loss"
            if hit_stop: return "loss"
            if hit_tgt:  return "win"
        else:
            hit_stop = lo <= stop_px
            hit_tgt  = hi >= bb_mid
            if hit_stop and hit_tgt:
                return "win" if cl >= bb_mid else "loss"
            if hit_stop: return "loss"
            if hit_tgt:  return "win"
    return None


def _calc_crt_winrate(df: pd.DataFrame) -> dict:
    """
    兩種訊號合併計算勝率：
    1. ABC：同一棒 CRT + KDJ死/金叉 + 超買/超賣共振
    2. AB ：A棒超買/超賣，B棒（緊接）CRT + KDJ死/金叉
    """
    # 空/多 各自勝負計數（兩種訊號合計）
    ws_abc = ls_abc = wl_abc = ll_abc = 0   # ABC 訊號
    ws_ab  = ls_ab  = wl_ab  = ll_ab  = 0   # AB  訊號
    recent:  list = []
    signals: list = []
    n = len(df)

    def _iv(row, col):
        return int(row.get(col, 0) or 0)

    # ── 訊號一：ABC（同棒三條件）────────────────────────────
    for i in range(n - 1):
        row = df.iloc[i]
        crt_v = _iv(row, "crt"); cross_v = _iv(row, "kdj_cross"); res_v = _iv(row, "resonance")
        if   crt_v == -1 and cross_v == -1 and res_v == -1: direction = "short"
        elif crt_v ==  1 and cross_v ==  1 and res_v ==  1: direction = "long"
        else: continue
        entry_i = i + 1
        if entry_i >= n: continue
        stop_px  = float(row["high"]) if direction == "short" else float(row["low"])
        sig_time = _ts(df.iloc[i])
        signals.append({"t": sig_time, "d": "s" if direction == "short" else "l", "k": "abc"})
        outcome = _scan_outcome(df, entry_i, stop_px, direction)
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_abc += 1
            else:                ls_abc += 1
        else:
            if outcome == "win": wl_abc += 1
            else:                ll_abc += 1
        recent.append({"t": sig_time, "d": "s" if direction == "short" else "l",
                        "r": "w" if outcome == "win" else "l", "k": "abc"})

    # ── 訊號二：AB（A=共振，B=CRT+死/金叉）─────────────────
    for i in range(n - 2):
        row_a = df.iloc[i]
        row_b = df.iloc[i + 1]
        res_a   = _iv(row_a, "resonance")
        crt_b   = _iv(row_b, "crt")
        cross_b = _iv(row_b, "kdj_cross")
        if   res_a == -1 and crt_b == -1 and cross_b == -1: direction = "short"
        elif res_a ==  1 and crt_b ==  1 and cross_b ==  1: direction = "long"
        else: continue
        # B 棒同時出現共振 → 等同訊號一（ABC），不重複計入訊號二
        res_b = _iv(row_b, "resonance")
        if direction == "short" and res_b == -1: continue
        if direction == "long"  and res_b ==  1: continue
        # B 棒若影線或本體已碰到 BB 中軌，訊號無效（目標已提前觸及）
        bb_mid_b = row_b.get("bb_middle")
        if bb_mid_b is None or pd.isna(bb_mid_b): continue
        bb_mid_b = float(bb_mid_b)
        if direction == "short" and float(row_b["low"])  <= bb_mid_b: continue
        if direction == "long"  and float(row_b["high"]) >= bb_mid_b: continue
        entry_i = i + 2
        if entry_i >= n: continue
        stop_px  = float(row_b["high"]) if direction == "short" else float(row_b["low"])
        sig_time = _ts(df.iloc[i + 1])   # 訊號棒 = B棒
        signals.append({"t": sig_time, "d": "s" if direction == "short" else "l", "k": "ab"})
        outcome = _scan_outcome(df, entry_i, stop_px, direction)
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_ab += 1
            else:                ls_ab += 1
        else:
            if outcome == "win": wl_ab += 1
            else:                ll_ab += 1
        recent.append({"t": sig_time, "d": "s" if direction == "short" else "l",
                        "r": "w" if outcome == "win" else "l", "k": "ab"})

    # ── 統計 ────────────────────────────────────────────────
    def _stats(w, l):
        t = w + l
        return {"total": t, "wins": w, "win_rate": round(w / t * 100, 1) if t else None}

    wins_s = ws_abc + ws_ab;  losses_s = ls_abc + ls_ab
    wins_l = wl_abc + wl_ab;  losses_l = ll_abc + ll_ab
    tot_s = wins_s + losses_s; tot_l = wins_l + losses_l
    total = tot_s + tot_l;     wins  = wins_s + wins_l
    recent.sort(key=lambda x: x["t"])

    return {
        "total":    total,
        "wins":     wins,
        "win_rate": round(wins / total * 100, 1) if total else None,
        "short":    _stats(wins_s, losses_s),
        "long":     _stats(wins_l, losses_l),
        "abc":      {"short": _stats(ws_abc, ls_abc), "long": _stats(wl_abc, ll_abc)},
        "ab":       {"short": _stats(ws_ab,  ls_ab),  "long": _stats(wl_ab,  ll_ab)},
        "recent":   recent[-30:],
        "signals":  signals,
    }


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
            if req.timeframe in ("5m", "15m", "1h"):
                max_d = TW_YF_MAX_DAYS.get(req.timeframe, 60)
                if use_limit:
                    days = min(max_d, req.limit // {"5m":78,"15m":26,"1h":7}.get(req.timeframe,26))
                    days = max(days, 5)
                    end   = date.today().isoformat()
                    start = (date.today() - timedelta(days=days)).isoformat()
                else:
                    end   = req.end or date.today().isoformat()
                    # yfinance 台股實際上限約 60 天（1h 理論 730 天但常失敗）
                    start_raw = req.start or end
                    min_start = (date.fromisoformat(end) - timedelta(days=60)).isoformat()
                    start = max(start_raw, min_start)
                try:
                    df = fetch_tw_intraday_yf(req.symbol, req.timeframe, start, end)
                except Exception:
                    # 無 token 時 FinMind 會直接 422，有 token 才 fallback
                    if req.finmind_token:
                        fm_start = max(start, (date.fromisoformat(end) - timedelta(days=90)).isoformat())
                        df = fetch_tw_intraday(req.symbol, req.timeframe, fm_start, end, req.finmind_token)
                    else:
                        raise
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
            if use_limit:
                max_d = US_MAX_DAYS.get(req.timeframe, 365)
                end   = date.today().isoformat()
                start = (date.today() - timedelta(days=min(req.limit * 2, max_d))).isoformat()
            else:
                start, end = req.start, req.end
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
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
            # 1. TWSE MIS 即時（盤中），快取 30 秒避免頻繁打官方 API
            mis_key = f"tw_mis_{req.symbol}"
            rt = cache.get(mis_key, ttl=30)
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
            # 分鐘/小時時框：yfinance 快取 5 分鐘，MIS 即時價疊加每 30 秒刷新
            if tf in ("5m", "15m", "1h", "4h"):
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
                    df_out = df_intra.tail(2).copy()
                    is_live = False
                    if rt and tf in ("5m", "15m", "1h"):
                        minutes = {"5m": 5, "15m": 15, "1h": 60}[tf]
                        df_out, is_live = _mis_overlay(df_out, rt, minutes)
                    return {"live": is_live, "data": df_to_records(df_out)}
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
            end   = date.today().isoformat()
            start = (date.today() - timedelta(days=10)).isoformat()
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
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
    live = req.market not in ("tw", "us")
    return {"live": live, "data": records}


@router.get("/crt_winrate")
def get_crt_winrate(
    market: str,
    symbol: str,
    timeframe: str = "1d",
    exchange: str = "pionex",
    api_key: str = "",
    api_secret: str = "",
    finmind_token: str = "",
):
    """CRT 策略各時間級別勝率"""
    from datetime import date, timedelta
    cache_key = f"crt_wr:{market}:{symbol}:{exchange}:{timeframe}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached

    # 各時間框架的回測天數上限
    TF_DAYS = {
        "1M": 3650, "1w": 1825, "1d": 730,
        "4h": 365,  "1h": 365,  "15m": 60, "5m": 30,
    }
    days = TF_DAYS.get(timeframe, 730)
    end  = date.today().isoformat()

    try:
        if market == "tw":
            if timeframe in ("5m", "15m", "1h"):
                max_d = TW_YF_MAX_DAYS.get(timeframe, 60)
                start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
                try:
                    df = fetch_tw_intraday_yf(symbol, timeframe, start, end)
                except Exception:
                    if finmind_token:
                        df = fetch_tw_intraday(symbol, timeframe, start, end, finmind_token)
                    else:
                        raise
            elif timeframe == "4h":
                max_d = TW_YF_MAX_DAYS.get("1h", 730)
                start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
                try:
                    df = fetch_tw_intraday_yf(symbol, "1h", start, end)
                except Exception:
                    if finmind_token:
                        df = fetch_tw_intraday(symbol, "1h", start, end, finmind_token)
                    else:
                        raise
                df = df.set_index("time")
                df = df.resample("4h").agg({"open":"first","high":"max","low":"min","close":"last","volume":"sum"})
                df = df.dropna(subset=["open"]).reset_index()
            else:
                start = (date.today() - timedelta(days=days)).isoformat()
                try:
                    df = fetch_tw_daily_yf(symbol, start, end)
                except Exception:
                    df = fetch_tw_stock(symbol, start, end, finmind_token)
                if timeframe != "1d":
                    df = resample_tw(df, timeframe)
        elif market == "us":
            max_d = US_MAX_DAYS.get(timeframe, 3650)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            df = fetch_us_stock(symbol, start, end, timeframe)
        elif market == "crypto":
            start = (date.today() - timedelta(days=days)).isoformat()
            df = fetch_crypto_ohlcv(symbol, timeframe, start, end, exchange,
                                    api_key=api_key, api_secret=api_secret)
        else:
            raise HTTPException(400, f"不支援的市場: {market}")
    except Exception as e:
        raise HTTPException(400, str(e))

    if len(df) < 50:
        raise HTTPException(400, f"資料不足 50 根K棒（{timeframe}）")
    df = enrich_df(df)
    result = _calc_crt_winrate(df)
    cache.set(cache_key, result)
    return result
