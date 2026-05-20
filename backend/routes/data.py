"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, fetch_tw_daily_yf, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.us_finnhub import fetch_us_quote
from data.crypto import fetch_crypto_ohlcv
from utils.cache import cache
from utils.data import enrich_df, df_to_records
from utils.crt import _calc_crt_winrate

router = APIRouter(prefix="/api", tags=["data"])


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
        new = {"time": bar_ts, "open": float(last["close"] or close),
               "high": close, "low": close, "close": close, "volume": 0}
        for col in df.columns:
            if col not in new:
                new[col] = None
        df = pd.concat([df, pd.DataFrame([new])], ignore_index=True)
        return df, True
    return df, False




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
            _bpd = {"1M": 1/30, "1w": 1/7, "1d": 1, "4h": 2, "1h": 7, "15m": 26, "5m": 78}
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
            # Finnhub 即時報價疊加（失敗不影響主流程）
            if os.getenv("FINNHUB_TOKEN"):
                try:
                    quote = fetch_us_quote(req.symbol)
                    df, _ = _finnhub_overlay(df, quote)
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


@router.get("/crt_winrate")
def get_crt_winrate(
    market: str,
    symbol: str,
    timeframe: str = "1d",
    exchange: str = "pionex",
    stop_buffer_pct: float = 0.0,
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
    cache_key = f"crt_wr38:{market}:{symbol}:{exchange}:{timeframe}:{_buf}:{int(_long_only)}"
    cached = cache.get(cache_key, ttl=3600)
    if cached:
        return cached

    MIN_CASES = 40   # 每個訊號（S1~S7 × 空/多）最少採樣數；不足會自動往前加倍天數
    # 各時間框架：初始天數 / 最大天數
    # 上限拉到資料源實際可能的歷史深度（Binance fapi BTC 2019/9~、spot 2017/8~、Bybit/OKX 類似）
    TF_INIT = {"1M": 3650, "1w": 1825, "1d": 730,  "4h": 365,  "1h": 365,   "15m": 60,  "5m": 30}
    TF_MAX  = {"1M": 7300, "1w": 7300, "1d": 7300, "4h": 5475, "1h": 2920,  "15m": 720, "5m": 180}

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
            return fetch_crypto_ohlcv(symbol, timeframe, start, end, exchange,
                                      api_key=api_key, api_secret=api_secret)
        raise HTTPException(400, f"不支援的市場: {market}")

    # 直接一次抓 TF_MAX 天的資料（不再做 doubling loop —— 過去 S1/S5/S7 等稀有訊號
    # 永遠達不到 MIN_CASES=40，doubling 會跑滿 4 次浪費 80% 時間）
    days_max  = TF_MAX.get(timeframe, 3650)
    try:
        df = _fetch_df(days_max)
    except Exception as e:
        raise HTTPException(400, str(e))

    if len(df) < 50:
        raise HTTPException(400, f"資料不足 50 根K棒（{timeframe}）")

    df = enrich_df(df)
    result = _calc_crt_winrate(df, stop_buffer_pct=_buf, long_only=_long_only)

    cache.set(cache_key, result)
    return result
