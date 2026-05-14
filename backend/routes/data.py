"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.crypto import fetch_crypto_ohlcv
from utils.cache import cache
from utils.data import enrich_df, df_to_records

router = APIRouter(prefix="/api", tags=["data"])


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
            # 分鐘/小時時框：MIS 提供整日累計 OHLCV，不能用於分 K
            # 改用 yfinance intraday 取最新一根實際 K 棒，快取 60 秒
            if tf in ("5m", "15m", "1h", "4h"):
                intra_key = f"tw_intra_{req.symbol}_{tf}"
                intra_cached = cache.get(intra_key, ttl=60)
                if intra_cached:
                    return intra_cached
                try:
                    end_d   = date.today().isoformat()
                    start_d = (date.today() - timedelta(days=3)).isoformat()
                    df_intra = fetch_tw_intraday_yf(req.symbol, tf, start_d, end_d)
                    if not df_intra.empty:
                        result = {"live": False, "data": df_to_records(df_intra.tail(2))}
                        cache.set(intra_key, result)
                        return result
                except Exception:
                    pass
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
