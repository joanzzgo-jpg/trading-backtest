"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException, Request, Response
# 大回應（ohlcv / 勝率，動輒 1MB+）直送 orjson：跳過 FastAPI 的 jsonable_encoder 整棵樹走訪。
# ★2026-08-02 改用 Response + orjson.dumps，不再用 fastapi.responses.ORJSONResponse：
#   後者在 FastAPI 0.139 已標記棄用，**每回應一次就噴一則 FastAPIDeprecationWarning**
#   → 伺服器 log 被洗版到看不見真正的警告（實測要一路往上撈才找得到一則 TWSE 逾時）。
#   這裡的 options 與 ORJSONResponse.render 完全相同（OPT_NON_STR_KEYS | OPT_SERIALIZE_NUMPY），
#   輸出位元組一致，只是少了那個棄用的類別。
try:
    import orjson as _orjson
    _ORJ_OPT = _orjson.OPT_NON_STR_KEYS | _orjson.OPT_SERIALIZE_NUMPY
except Exception:
    _orjson = None
    _ORJ_OPT = 0


def _json_resp(payload, headers=None):
    """等同舊的 ORJSONResponse（同樣的 orjson options），但不觸發棄用警告。
    沒裝 orjson → 原樣回 dict，走 FastAPI 預設序列化路徑。"""
    if _orjson is None:
        return payload
    return Response(content=_orjson.dumps(payload, option=_ORJ_OPT),
                    media_type="application/json", headers=headers)
from pydantic import BaseModel
from utils.tf import check_tf as _check_tf, clamp_limit as _clamp_limit
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os
import sys
import time
import math
import threading
import pandas as pd
import numpy as np
import datetime as _dt
import threading as _threading
import collections as _collections

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, fetch_tw_daily_yf, merge_tw_intraday, cnyes_last_good, resample_tw_4h, resample_tw_intraday, TW_RESAMPLE, tw_daily_fill_latest, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.fugle import fetch_fugle_intraday, fugle_enabled
# 註：fetch_taifex_quote / resolve_front_month 曾列在這裡但整檔沒用到（唯一的使用者是
#     _diag_futopt，它在函式內自己 import）→ 2026-07-31 移除，順便解掉那處名稱遮蔽。
from data.taifex_mis import (fetch_taifex_daily,
                             PRODUCTS as FUTOPT_PRODUCTS, _INTRADAY_MIN as TXF_INTRADAY)
from data.cnyes_futures import get_txf_intraday, fetch_cnyes_stock_intraday
from data.alpaca import fetch_alpaca_bars, alpaca_enabled
from data.twelvedata import fetch_twelvedata_intraday, twelvedata_enabled
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.hk_stock import fetch_hk_realtime
from data.us_finnhub import fetch_us_quote
from data.crypto import fetch_crypto_ohlcv, last_fetch_source
import data.crypto as _crypto
from utils.cache import cache, data_cache, coach_cache
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

# 勝率 / df 快取保鮮期（秒）。30 分鐘：深歷史統計（算勝率用）這麼久重抓一次就夠。
# 注意：「最新一根訊號」不受此 30 分拖累 —— crypto 走下方 bar-aware 機制，一收新棒就
# 補抓短窗尾巴重算（即時價另走每秒路徑、也不受此影響）。想更省限流可調大。
_WR_CACHE_TTL = 1800

# 各時框秒數（bar-aware 新鮮度用；與 notify_monitor._TF_SEC 同義）
_CRT_IV = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
           "4h": 14400, "8h": 28800, "1d": 86400, "1w": 604800, "1M": 2592000}


def fetch_crt_df(market: str, symbol: str, timeframe: str, days: int,
                 exchange: str = "pionex", api_key: str = "", api_secret: str = "",
                 finmind_token: str = "") -> pd.DataFrame:
    """依市場 / 時間框架取得指定天數的 K 棒（CRT 勝率與訊號監控共用）。

    從 get_crt_winrate 內的 _fetch_df 抽出成模組層級，讓背景訊號監控器能以「短窗、即時」
    取得最新 K 棒（不吃 30 分勝率快取），同時 route 仍委派此函式（行為不變）。
    """
    end = date.today().isoformat()
    if market == "tw":
        if symbol.upper() in FUTOPT_PRODUCTS:
            # 台指期(TXF/MXF/TMF)：盤中走 get_txf_intraday(cnyes即時+自建DB歷史)、
            # 日/週/月走 fetch_taifex_daily(FinMind期貨日線)——與 /api/ohlcv 同源，
            # 讓 CRT 勝率/FVG/策略也能算(先前因 yfinance 抓不到期貨代號而缺標記)。
            if timeframe in TXF_INTRADAY:
                fdf = get_txf_intraday(symbol, timeframe)
                return fdf if (fdf is not None and not fdf.empty) else pd.DataFrame()
            start = (date.today() - timedelta(days=days)).isoformat()
            ddf = fetch_taifex_daily(symbol, start, end, finmind_token)
            if ddf is None or ddf.empty:
                return pd.DataFrame()
            return ddf if timeframe == "1d" else resample_tw(ddf, timeframe)
        if timeframe in ("1m", "5m", "15m", "1h"):
            max_d = TW_YF_MAX_DAYS.get(timeframe, 60)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            try:
                df = fetch_tw_intraday_yf(symbol, timeframe, start, end)
            except Exception:
                if finmind_token:
                    df = fetch_tw_intraday(symbol, timeframe, start, end, finmind_token)
                else:
                    raise
            # 今日改用 cnyes 個股即時分鐘K（連續無跳號）→ 策略/勝率標記在今日棒上也對齊即時；歷史仍 yfinance。
            # ★2026-07-31 改「合併」不再「二選一」（使用者回報「台股K棒不穩定」）：
            #   舊作法 = 以 cnyes 最早那根當 cutoff、yfinance 只留之前的、cnyes 整段蓋上去，且
            #   cnyes 一失敗就 except: pass → 當日**整段**退回落後的 yfinance（實測 12:36 時它
            #   只到 11:45）→ 最後幾根 K 棒往回退、重整又跑回來。
            #   現在：① cnyes 抓失敗就沿用「今天最後一次成功」的那份（cnyes_last_good）；
            #         ② 與 yfinance 逐欄位合併（時間軸取聯集、high 取大 low 取小、open/close 以
            #            即時源為準、volume 取大）→ 結果是決定性的，不再受接合點位置影響。
            #   規則與理由詳見 data/taiwan.py 的 merge_tw_intraday。
            if df is not None and not df.empty:
                try:
                    cdf = cnyes_last_good(symbol, timeframe,
                                          fetch_cnyes_stock_intraday(symbol, timeframe))
                    df = merge_tw_intraday(df, cdf)
                except Exception:
                    pass
            return df
        elif timeframe in TW_RESAMPLE:          # 30m / 2h / 4h ← 由 15m 或 1h 重採樣
            # ★2026-08-01：原本這裡只有 "4h"，30m/2h 因此掉進下面的日線分支 →
            #   resample_tw 對未知 rule 一律退回 "1d"（見該函式）→ **日線資料被貼上 30m/2h 的標籤**
            #   送到前端。使用者看到的是「切到 30m，圖卻是日線」，而且完全不報錯。
            _src_tf, _ = TW_RESAMPLE[timeframe]
            max_d = TW_YF_MAX_DAYS.get(_src_tf, 60)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            try:
                _df = fetch_tw_intraday_yf(symbol, _src_tf, start, end)
            except Exception:
                if finmind_token:
                    _df = fetch_tw_intraday(symbol, _src_tf, start, end, finmind_token)
                else:
                    raise
            # 也接 cnyes（2026-07-31）：這條原本只吃 yfinance，而 yfinance 台股盤中會落後
            # 十幾二十分鐘（實測 12:36 時它只到 11:45、cnyes 已到 12:30）→ **形成中的那根棒
            # 的收盤/高低都是舊的**。先把當日的 cnyes 合併進來再分桶，形成中的那根就是最新的。
            try:
                _c1 = cnyes_last_good(symbol, _src_tf, fetch_cnyes_stock_intraday(symbol, _src_tf))
                _df = merge_tw_intraday(_df, _c1)
            except Exception:
                pass
            return resample_tw_intraday(_df, timeframe)
        else:
            start = (date.today() - timedelta(days=days)).isoformat()
            try:
                _df = fetch_tw_daily_yf(symbol, start, end)
            except Exception:
                _df = fetch_tw_stock(symbol, start, end, finmind_token)
            # yfinance 台股日線收盤後會延遲很久才補上當天（實測週五收盤後 13 小時仍沒有）→
            # 用 TWSE/TPEX 官方 opendata 補最新那個交易日；週線/月線由日線聚合，一併受惠。
            _df = tw_daily_fill_latest(_df, symbol)
            if timeframe != "1d":
                _df = resample_tw(_df, timeframe)
            return _df
    elif market in ("us", "hk"):
        # 港股(hk)＝美股同一條 yfinance 路：代號用 xxxx.HK(如 0700.HK)，時框/時區/盤別全沿用。
        max_d = US_MAX_DAYS.get(timeframe, 3650)
        start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
        return fetch_us_stock(symbol, start, end, timeframe)
    elif market == "crypto":
        start = (date.today() - timedelta(days=days)).isoformat()
        from data.crypto import _fetch_binance_fapi, _calc_max_candles, _set_src
        # 本機/版控 5m 倉庫(BTC/ETH/SOL)：深歷史 FVG/勝率直接讀倉庫(算得到深、且免打 API 抓一年),
        #   再接「倉庫最新~今天」的新尾巴(Binance)保鮮 → 深歷史+即時尾巴一份完整 df。
        try:
            from data.klines_store import is_target as _k_is, load_from as _k_from
            if _k_is(symbol, timeframe):
                _kd = _k_from(symbol, timeframe, start)
                if _kd is not None and not _kd.empty:
                    _set_src("binance")
                    _b0 = symbol[:-2] if symbol.upper().endswith(".P") else symbol
                    _ts = _kd["time"].iloc[-1].strftime("%Y-%m-%d")
                    try:
                        _tail = _fetch_binance_fapi(_b0, timeframe, _ts, end, 0, max_candles=6000)
                        if _tail is not None and not _tail.empty:
                            _kd = pd.concat([_kd, _tail]).drop_duplicates("time").sort_values("time").reset_index(drop=True)
                    except Exception:
                        pass
                    return _kd
        except Exception:
            pass
        _set_src(None)   # 重置來源；此路徑直呼 _fetch_binance_fapi（不經 fetch_crypto_ohlcv）→ 需自行標記
        _base = symbol[:-2] if symbol.upper().endswith(".P") else symbol
        _bb = _base.split("/")[0].upper()
        _mc = _calc_max_candles(start, end, timeframe)
        for _cand, _div in ((_base, 1.0), (f"1000{_bb}/USDT", 1000.0)):
            try:
                _dfb = _fetch_binance_fapi(_cand, timeframe, start, end, 0, max_candles=_mc)
                if not _dfb.empty and len(_dfb) >= 50:
                    if _div != 1.0:
                        for _c in ("open", "high", "low", "close"):
                            _dfb[_c] = _dfb[_c] / _div
                    _set_src("binance"); return _dfb
            except Exception:
                pass
        # Binance 直取失敗 → fetch_crypto_ohlcv 內含 Pionex/Bybit 降級並會自行標記來源
        return fetch_crypto_ohlcv(symbol, timeframe, start, end, exchange,
                                  api_key=api_key, api_secret=api_secret)
    raise HTTPException(400, f"不支援的市場: {market}")

def _keyed_lock(key: str) -> threading.Lock:
    with _inflight_guard:
        lk = _inflight_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _inflight_locks[key] = lk
        return lk


import secrets as _secrets
_ADMIN_KEY = os.getenv("ACCOUNT_ADMIN_KEY")

def _require_admin(key: str):
    """診斷端點守門：設了 ACCOUNT_ADMIN_KEY 就要求 ?key= 相符（constant-time）；沒設→開放(開發)。
    防止陌生人讀 env 變數名／帳號名等資訊揭露。"""
    if _ADMIN_KEY and not _secrets.compare_digest(key or "", _ADMIN_KEY):
        raise HTTPException(403, "需要管理金鑰（?key=ACCOUNT_ADMIN_KEY）")


# ── 效能回報收集（配合前端 window._perfProbe）────────────────────────────────
#   為什麼要有這條：使用者無法把 console 輸出貼回來（環境限制），headless 又測不出他機器上的
#   卡頓（卡的原因通常是「某個預設關閉、但他開著」的疊加層 —— 足跡那個 bug 就是這樣才找到的）。
#   → 探針量完直接 POST 上來，開發端 GET 回來看。純數字與開關名稱，不含任何個資。
#   記憶體環形緩衝、上限 20 筆、單筆 32KB；重啟即清空。
_PERF_REPORTS: "_collections.deque" = _collections.deque(maxlen=20)


@router.post("/_perf_report")
async def perf_report(request: Request):
    try:
        raw = await request.body()
        if len(raw) > 32768:
            raise HTTPException(413, "報告過大")
        import orjson as _oj
        data = _oj.loads(raw)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "格式錯誤")
    _PERF_REPORTS.append({"at": _dt.datetime.now().isoformat(timespec="seconds"), "r": data})
    return {"ok": True, "n": len(_PERF_REPORTS)}


@router.get("/_perf_report")
def perf_report_list():
    """開發端讀回來看（最新在最後）。"""
    return {"n": len(_PERF_REPORTS), "reports": list(_PERF_REPORTS)}


@router.get("/_diag")
def diag(key: str = ""):
    """環境變數診斷（只回名稱/長度/數量，**絕不洩漏金鑰值**），用來確認 Railway 設定是否生效。"""
    _require_admin(key)
    from data.fugle import _keys as _fugle_keys
    from data.twelvedata import _keys as _td_keys
    names = sorted(os.environ.keys())
    import sys as _sys
    from utils import redis_cache as _rcache
    try:
        import notify_monitor as _nm
        _leader = bool(_nm._lease and _nm._lease.held) if _nm._lease else None
    except Exception:
        _leader = None
    return {
        "python": _sys.version.split()[0],                 # 執行中 Python 版本（本機/Railway 一致性檢查）
        "orjson": _orjson is not None,                     # orjson 序列化是否生效
        "redis": _rcache.enabled(),                        # Redis 共享快取(REDIS_URL)是否啟用
        "monitor_leader": _leader,                         # 本 worker 是否為 monitor 單跑者(多實例診斷)
        "fugle_keys": len(_fugle_keys()),                  # 台股：Fugle 金鑰把數（0 = 沒設對）
        "twelvedata_keys": len(_td_keys()),                # 美股：Twelve Data 金鑰把數
        "fugle_like_var_names": [k for k in names if "fug" in k.lower()],
        "twelvedata_like_var_names": [k for k in names if "twelve" in k.lower() or "12data" in k.lower()],
        "alpaca": bool(os.getenv("ALPACA_KEY") and os.getenv("ALPACA_SECRET")),
        "finnhub": bool(os.getenv("FINNHUB_TOKEN")),
        "cwa": bool(os.getenv("CWA_API_KEY")),
        "anthropic": bool(os.getenv("ANTHROPIC_API_KEY")),   # Claude API 金鑰(小熊台詞/交易截圖辨識用)
    }


@router.get("/_diag_mem")
def diag_mem():
    """記憶體診斷：process RSS + 兩個快取池的佔用（本機、Railway 皆可用）。
    看 process_rss_mb（整個服務吃多少 RAM）與 data_cache.df_total_mb（深歷史 df 快取佔多少）。"""
    import subprocess
    def _rss_mb():
        try:   # Linux(Railway)：/proc/self/status VmRSS（當前 RSS，kB）
            with open("/proc/self/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        return round(int(line.split()[1]) / 1024, 1)
        except Exception:
            pass
        try:   # macOS 本機：ps -o rss（當前 RSS，kB）
            out = subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())]).decode().strip()
            return round(int(out) / 1024, 1)
        except Exception:
            pass
        try:   # 退回 peak（resource；macOS=bytes、Linux=kB）
            import resource
            r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return round(r / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)
        except Exception:
            return None

    def _report(c):
        try:
            with c._lock:
                items = list(c._cache.items())
        except Exception:
            items = []
        total = 0.0; ents = []
        for k, (data, ts) in items:
            mb = None
            if isinstance(data, pd.DataFrame):
                mb = round(data.memory_usage(deep=True).sum() / 1024 / 1024, 2)
                total += mb
            ents.append({"key": (k[:64] if isinstance(k, str) else str(k)[:64]), "df_mb": mb})
        return {"count": len(items), "max_size": c._max_size,
                "df_total_mb": round(total, 1), "entries": ents}

    def _crypto_source_status():
        """Binance 熔斷剩餘秒數 + 最近一次抓取實際用的來源。"""
        st = {"last_source": None, "binance_cooldown_left": 0.0}
        try:
            from data import crypto as _c
            st["last_source"] = last_fetch_source()
            cd = float(getattr(_c, "_BINANCE_COOLDOWN_UNTIL", 0.0) or 0.0)
            st["binance_cooldown_left"] = round(max(0.0, cd - time.time(), ), 1)
            # ★ 已用權重＝整條穩定性鏈的預算表：撞到上限 → 熔斷 → 來源反覆跳 → K 棒抖動。
            #   查「K 棒又在動」「行情凍住」時先看這裡，比翻日誌快。
            w, ts, lim = _c._BINANCE_USED_W, _c._BINANCE_W_TS, _c._BINANCE_W_LIMIT
            st["weight"] = {h: {"used": (w[h] if time.time() - ts[h] < 70 else 0), "limit": lim[h]}
                            for h in ("fapi", "api")}
            # 誰把權重吃光：最近 60 秒按端點分類（查限流問題的第一站）
            st["weight"]["fapi"]["by_endpoint"] = _c.weight_breakdown("fapi")
        except Exception as e:
            st["error"] = str(e)[:120]
        return st

    def _spot_poll_status():
        """現貨背景輪詢是否在跑（有人看才抓；idle_sec=-1 代表這輪從沒人要過）。"""
        try:
            from utils import live_data as _ld
            return {"active": _ld.spot_wanted(), "idle_sec": _ld.spot_idle_sec()}
        except Exception as e:
            return {"error": str(e)[:120]}

    def _ticker_price_status():
        """報價列價格更新健康度：age_sec 一直長大＝合約行情正在凍住（安靜壞掉，沒這個查不出來）。
        ★ 2026-08-08 加：使用者回報「主圖跟合約行情數值有時候對不上」，根因是 Binance 掛掉時
          主圖有 fallback 會換源續跳、報價列沒有就整列凍住 → 要能一眼看出「現在是不是凍著」。"""
        st = {"age_sec": None, "src": None}
        try:
            import main as _m
            s = getattr(_m, "_TK_PRICE_STAT", None) or {}
            if s.get("ts"):
                st["age_sec"] = round(time.time() - s["ts"], 1)
            st["src"] = s.get("src") or None
        except Exception as e:
            st["error"] = str(e)[:120]
        return st

    # Redis 共享層狀態（多 worker 報價共享用）：configured=有無設 REDIS_URL；ok=實際能否讀寫
    def _redis_status():
        st = {"configured": False, "ok": False, "roundtrip_ms": None}
        try:
            from utils import shared_store
            st["configured"] = bool(shared_store._REDIS_URL)
            if shared_store.enabled():
                t0 = time.time()
                shared_store.set_blob("diag:ping", {"t": t0}, ttl=10)
                v = shared_store.get_blob("diag:ping")
                st["ok"] = bool(v and abs(v.get("t", 0) - t0) < 1e-6)
                st["roundtrip_ms"] = round((time.time() - t0) * 1000, 1)
        except Exception as e:
            st["err"] = str(e)[:120]
        return st

    def _role():
        """這個回應是**哪一個 worker** 給的。
        ★ 沒有這欄會嚴重誤導（2026-08-10 實測踩到）：線上 workers=2，只有 leader 跑背景執行緒，
          follower 的權重/報價健康度**永遠是 0/None**。隨機打到 follower 時看起來像「一切閒置正常」，
          實際上那個 worker 本來就什麼都不做 —— 等於把「查不到」誤讀成「沒問題」。
          要看真實狀態就一直打到 role=leader 為止（或用 pid 區分兩個 worker）。"""
        try:
            import main as _m
            return {"role": "leader" if getattr(_m, "_IS_LEADER", False) else "follower",
                    "pid": os.getpid()}
        except Exception:
            return {"role": "unknown", "pid": os.getpid()}

    return {
        "worker": _role(),                # ⚠ 先看這個：follower 的背景數據全是 0，不是「健康」
        "process_rss_mb": _rss_mb(),      # 整個服務目前吃多少 RAM
        "malloc_trim": (lambda: __import__("utils.memtrim", fromlist=["stat"]).stat)(),
        "platform": sys.platform,
        "workers_env": os.getenv("WEB_CONCURRENCY", "1"),   # 設定的 worker 數
        "ticker_ws": (os.getenv("TICKER_WS") or "0"),        # WS 報價開關
        "redis": _redis_status(),         # Redis 共享層（configured/ok/roundtrip）
        "data_cache": _report(data_cache),        # 深歷史 df + 勝率結果（32 條硬上限）
        "coach_cache": _report(coach_cache),      # 教練 df/結果（160 條；與上面分開才不會互相擠掉）
        "volatile_cache": _report(cache),    # ohlcv/報價/搜尋等（48 條）
        # ★ 2026-08-06 加：crypto 資料源狀態。
        #   查「K 棒有小跳空／策略標記怪」時第一個要看的東西 —— Binance 一旦熔斷就會降級到
        #   Bybit/Pionex，兩者對同一根已收盤 K 棒的數值差幾點（實測整串偏移 3~6 點）。
        #   每份快照**內部**都連續，但前端把「來源 A 的即時」與「來源 B 的補洞」拼起來，
        #   接合處就是一道跳空。⚠ 這兩個值是 uvicorn 行程內的模組全域，
        #   在另一個 python 行程裡 import 讀到的永遠是初始值 0（我踩過）→ 只能靠這支端點看。
        "crypto_source": _crypto_source_status(),
        "ticker_price": _ticker_price_status(),   # 報價列多久沒更新到新價 + 這次的價格來源
        "spot_poll": _spot_poll_status(),         # 現貨背景輪詢（有人看才抓）
    }


@router.get("/_diag_fugle")
def diag_fugle(symbol: str = "2330", timeframe: str = "1m"):
    """富果即時抓取探針（瀏覽器直接開）：定位『台股還是延遲 20 分』斷在哪。
    直接打 Fugle intraday candles，回報 HTTP 狀態＋最新一根 K 時間，**絕不洩漏金鑰**。
    判讀：status=200 且 last_candle 接近現在→富果正常(延遲另有他因)；429→額度爆(該把冷卻)；
         401/403→金鑰權限；data 空→休市或該檔無資料。多把金鑰逐把測，看是否某把壞。"""
    import time as _t
    import requests
    from data.fugle import _keys as _fugle_keys, _BASE, _TF
    tfp = _TF.get(timeframe, "1")
    out = {"symbol": symbol, "timeframe": timeframe, "keys": len(_fugle_keys()), "probes": []}
    for i, tok in enumerate(_fugle_keys()):
        p = {"key_idx": i}
        try:
            t0 = _t.time()
            r = requests.get(f"{_BASE}/intraday/candles/{symbol}",
                             params={"timeframe": tfp},
                             headers={"X-API-KEY": tok}, timeout=8)
            p["status"] = r.status_code
            p["ms"] = int((_t.time() - t0) * 1000)
            try:
                j = r.json()
                rows = j.get("data") or []
                p["candles"] = len(rows)
                if rows:
                    p["last_candle"] = rows[-1].get("date")   # 最新一根時間（判斷有無延遲）
                    p["last_close"] = rows[-1].get("close")
                    # 盤中一眼判：最新一根距「現在」幾分鐘。0~2＝富果即時OK(延遲在前端)；~15-20＝富果REST本身延遲。
                    try:
                        _lc = pd.Timestamp(rows[-1]["date"])                      # 含 +08:00
                        _now = pd.Timestamp.now(tz=_lc.tz)
                        p["delay_min"] = round((_now - _lc).total_seconds() / 60, 1)
                    except Exception:
                        pass
                elif isinstance(j, dict):
                    p["msg"] = str(j.get("message") or j.get("error") or "")[:120]
            except Exception as je:
                p["parse_err"] = str(je)[:80]; p["body"] = r.text[:160]
        except Exception as e:
            p["err"] = str(e)[:120]
        out["probes"].append(p)
    return out


@router.get("/_diag_futopt")
def diag_futopt(product: str = "TXF"):
    """台指期（TAIFEX MIS）抓取探針：確認免費官方源是否正常回即時報價。免金鑰。
    判讀：front_month 有值且 quote.price 有值→正常（休市則為最後收盤）；
         都是 None→MIS 連線失敗或該產品不在 feed（如微台 TMF）。"""
    product = (product or "TXF").upper()
    from data.taifex_mis import resolve_front_month as _rf, fetch_taifex_quote, _get_quote_list
    front = _rf(product)
    q = fetch_taifex_quote(product)
    return {
        "source": "TAIFEX MIS (mis.taifex.com.tw)",
        "product": product,
        "front_month": front,
        "quote_ok": bool(q and q.get("price") is not None),
        "quote": q,
        "feed_count": len(_get_quote_list()),
    }


@router.get("/_diag_trade")
def diag_trade(key: str = ""):
    """自動交易／訊號通知診斷（瀏覽器直接開）：定位『完全沒推播/沒進場』斷在哪。
    notify_enabled=False→VAPID沒設(訂閱推播發不出)；subs=0→無訂閱；auto_accounts空→cfg沒讀到active；
    某帳號 scan_tfs 空或 crypto_watchlist=0→該帳號不會被掃。**不洩漏任何金鑰。**"""
    _require_admin(key)   # 會列出帳號名等 → 需管理金鑰(設了才擋)
    out = {"notify_enabled": False, "subs": 0, "auto_accounts": []}
    try:
        import routes.notify as notify
        out["notify_enabled"] = bool(notify.notify_enabled())
        out["subs"] = len(notify.all_active_subs()) if notify.notify_enabled() else 0
    except Exception as e:
        out["notify_err"] = str(e)[:120]
    try:
        from routes.trade import get_all_auto_cfgs
        import notify_monitor as nm
        import routes.notify as notify
        for name, cfg in get_all_auto_cfgs(fresh=True):
            wl = []; wln = -1; sample = []
            try:
                wl = notify.account_watchlist(name)
                wln = len([w for w in wl if (w.get("market") or "crypto") == "crypto" and w.get("symbol")])
                sample = [f"{w.get('symbol')}|{w.get('market') or '?'}" for w in wl[:8] if isinstance(w, dict)]
            except Exception as we:
                sample = [f"ERR:{str(we)[:60]}"]
            out["auto_accounts"].append({
                "name": name,
                "main_on": cfg.get("on"),
                "fvg_on": (cfg.get("fvg") or {}).get("on"),
                "fvg_entry": (cfg.get("fvg") or {}).get("entry"),
                "scan_tfs": sorted(nm._auto_tfs(cfg)),
                "crypto_watchlist": wln,
                "watchlist_total": len(wl),
                "watchlist_sample": sample,
            })
    except Exception as e:
        out["auto_err"] = str(e)[:120]
    return out


@router.get("/_diag_fvg")
def diag_fvg():
    """FVG 限價掛單診斷（瀏覽器直接開）：定位『限價模式卻都沒掛單』斷在哪。
    surge=爆量封控是否擋單；gap_cache=每整點刷新的新鮮缺口快取(空→收盤掃描沒跑/沒缺口)；
    per_account=各 limit 帳號的宇宙標的數＋此刻快取中『逼近且通過該宇宙過濾』的缺口數(>0 卻沒掛=掛單函式內閘門擋住)；
    recent_fvg_log=近期 FVG 掛單記錄(status/msg→有沒有嘗試、為何失敗)。**不洩漏任何金鑰。**"""
    out = {}
    try:
        from routes.trade import _fvg_surge_active
        out["surge_active"] = bool(_fvg_surge_active())
    except Exception as e:
        out["surge_err"] = str(e)[:120]
    # 缺口快取概況
    try:
        import notify_monitor as nm
        now = time.time()
        gc = []
        for sym, ent in list(nm._fvg_gap_cache.items()):
            gc.append({"sym": sym, "gaps": len(ent.get("gaps") or []),
                       "age_s": int(now - ent.get("ts", 0))})
        out["gap_cache_n"] = len(gc)
        out["gap_cache"] = sorted(gc, key=lambda x: -x["gaps"])[:30]
    except Exception as e:
        out["gap_cache_err"] = str(e)[:120]
    # 各 limit 帳號：逐缺口跑「place_fvg_limit_ladder 全部閘門」，回報每個逼近缺口卡在哪格。
    try:
        import notify_monitor as nm
        import routes.notify as notify
        import routes.account as _acct
        from routes.trade import (get_all_auto_cfgs, fvg_account_symbols, _client_for,
                                  _is_hedge, _fvg_gap_already_settled)
        from data.crypto import _fetch_fapi_prices
        prices = _fetch_fapi_prices() or {}
        NEAR_W = 1.5
        accts = []
        for name, cfg in get_all_auto_cfgs():
            fvg = cfg.get("fvg") or {}
            if not (fvg.get("on") and fvg.get("entry") == "limit"):
                continue
            try:
                uni_syms = {(w.get("symbol") or "") for w in fvg_account_symbols(name, fvg)}
            except Exception:
                uni_syms = set()
            try:
                client, _ = _client_for(name)
            except Exception:
                client = None
            hedge = False
            try:
                hedge = _is_hedge(client) if client else False
            except Exception:
                pass
            # 此帳號目前 pending/open FVG 倉數（maxPos 閘門用）
            pend_n = open_n = 0; pend_syms = []
            try:
                _c, _ph = _acct._db()
                try:
                    pend_n = _c.execute(f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND sig='fvg' AND status='pending' AND acct={_ph}", (name,)).fetchone()[0]
                    open_n = _c.execute(f"SELECT COUNT(*) FROM trade_log WHERE source='auto' AND sig='fvg' AND status='open' AND acct={_ph}", (name,)).fetchone()[0]
                    pend_syms = [r[0] for r in _c.execute(f"SELECT DISTINCT symbol FROM trade_log WHERE source='auto' AND sig='fvg' AND status IN ('pending','open') AND acct={_ph}", (name,)).fetchall()]
                finally:
                    _c.close()
            except Exception:
                pass
            maxpos = int(fvg.get("maxPos", 15) or 15)
            held = pend_n + open_n
            reasons = {}; near = 0; would = []
            for sym, ent in list(nm._fvg_gap_cache.items()):
                if sym not in uni_syms:
                    continue
                px = prices.get(sym.replace(".P", "").replace("/", "").upper())
                if px is None:
                    continue
                for g in ent.get("gaps") or []:
                    try:
                        top = float(g["top"]); bot = float(g["bot"]); W = top - bot; d = g.get("d")
                    except Exception:
                        continue
                    if W <= 0:
                        continue
                    # 逼近判定
                    if d == "l":
                        if not (px <= top + NEAR_W * W): continue
                    else:
                        if not (px >= bot - NEAR_W * W): continue
                    near += 1
                    want = "short" if d == "s" else "long"
                    # 逐閘門（順序同 place_fvg_limit_ladder）
                    if cfg.get("fvg", {}).get("dirs", "both") != "both" and fvg.get("dirs") != want:
                        r = "dirs方向過濾"
                    elif notify.seen_event(f"fvglimit:{name}:{sym}:1h:{d}:{g.get('t')}"):
                        r = "dedup已掛過此缺口"
                    elif client is None:
                        r = "no_client無金鑰"
                    elif (not hedge and sym in pend_syms):
                        r = "dup同標的已有倉(單向)"
                    elif held >= maxpos:
                        r = "maxPos已滿"
                    elif (W / (top if want == "long" else bot)) > 0.02:
                        r = "too_wide>2%"
                    elif _fvg_gap_already_settled(sym, g.get("t"),
                                                  (bot - 2 * W) if want == "long" else (top + 2 * W),
                                                  (top + 6 * W) if want == "long" else (bot - 6 * W), want):
                        r = "settled已了結"
                    else:
                        r = "WOULD_PLACE應該要掛!"; would.append(f"{sym}{'多' if want=='long' else '空'}")
                    reasons[r] = reasons.get(r, 0) + 1
            accts.append({"name": name, "universe": fvg.get("universe"),
                          "universe_syms": len(uni_syms), "pending": pend_n, "open": open_n,
                          "maxPos": maxpos, "held_vs_max": f"{held}/{maxpos}",
                          "approaching": near, "block_reasons": reasons,
                          "would_place": would[:10]})
        out["per_account"] = accts
        out["prices_n"] = len(prices)
    except Exception as e:
        import traceback
        out["per_account_err"] = str(e)[:120]; out["per_account_tb"] = traceback.format_exc()[-400:]
    # 近期 FVG 掛單記錄（status + msg 直接說明嘗試/失敗原因）
    try:
        import routes.account as _acct
        conn, ph = _acct._db()
        try:
            cur = conn.execute(
                "SELECT ts,acct,status,symbol,side,sig,tf,msg FROM trade_log "
                "WHERE sig='fvg' ORDER BY id DESC LIMIT 20")
            rows = cur.fetchall()
        finally:
            conn.close()
        out["recent_fvg_log"] = [{"ts": r[0], "acct": r[1], "status": r[2], "symbol": r[3],
                                  "side": r[4], "sig": r[5], "tf": r[6], "msg": r[7]} for r in rows]
        out["recent_fvg_n"] = len(rows)
    except Exception as e:
        out["recent_fvg_err"] = str(e)[:120]
    return out


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



def _us_market_open() -> bool:
    """美股現在是不是盤中（美東 09:30–16:00、週一~五）。

    ★ 2026-08-15：用來讓「即時指示燈」在收盤後誠實。三條即時來源
      （Alpaca / Twelve Data / Finnhub）都是**無條件**回 live=True，
      收盤後它們照樣回得出「最後一根」→ 指示燈整晚亮著說即時，
      但實測收盤後 AAPL 5m 已落後 25 分。
    ⚠ 不用「最後一根的棒齡」判斷：15m/1h 的形成中那根本來就會舊到一個週期，
      真即時與延遲的棒齡一模一樣，分不出來（這個坑我在 NQ=F 那次踩過）。
    ⚠ 不含美股假日表（那要年年維護，正是 CPI 那張表的教訓）→ 假日會殘留一次誤報，
      但假日整天沒有新資料、使用者本來就看得出來，代價可接受。
    """
    try:
        from zoneinfo import ZoneInfo
        # ⚠ 本模組把 datetime 類別匯入成 `dt`（line 26），沒有裸的 `datetime` 名稱。
        #   我第一版寫 datetime.now() → NameError → 被下面的 except 吞掉、恆回 True，
        #   而且**看起來完全正常**（週六凌晨測出「盤中=True」才發現）。
        now = dt.now(ZoneInfo("America/New_York"))
        if now.weekday() >= 5:
            return False
        mins = now.hour * 60 + now.minute
        return 9 * 60 + 30 <= mins <= 16 * 60
    except Exception:
        return True    # 判不出來就別亂關（寧可維持原本行為）


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
_mis_lock = threading.Lock()   # 背景 worker 與請求執行緒都會累積同一 key → 保護讀改寫
# 最近經 /api/latest 請求過的台股 (symbol, minutes) → 上次存取 epoch。背景 worker 據此
# 持續累積這些標的的即時分鐘K，不必等前端 poll → 無 Fugle 的本機切走再切回也不留斷層。
_tw_hot: dict = {}

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

# 即時累積器支援的時框 → 每根幾分鐘（台股 MIS 與港股騰訊**共用這一份**）。
# ★2026-08-02 收斂：原本這張表在台股/港股兩個分支各抄一份（1309/1409 行），
#   而且兩份都缺 30m —— 30m/2h 直到今天才真的能用，之前是日線，所以沒人發現。
# ⚠ 為什麼只加 30m、**不加 2h**：累積器是依「UTC 時鐘整除」分桶，主路徑
#   （resample_tw_intraday / _resample_session）是「貼齊開盤」分桶。實測：
#     30m → 台股/港股兩邊邊界都一致（01:00,01:30,…）→ 安全
#     2h  → 台股 主路徑 01:00/03:00/05:00 vs 累積器 00:00/02:00/04:00  ✗
#           港股 主路徑 01:30/03:30/05:30 vs 累積器 00:00/02:00/04:00  ✗
#   加了會堆出「與主序列對不上的假 K 棒」，正是 resample_tw_4h 註解警告過的情況。
#   要支援 2h 得先把累積器改成貼齊開盤分桶 —— 那是另一件事，單獨做、單獨驗。
RT_ACC_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60}


def _mis_accumulate(symbol: str, minutes: int, rt: dict):
    """用 TWSE MIS 即時報價即時堆出當前/近期『真實』分鐘 K 棒。回傳今日已累積 bar list(升冪)。
    背景 worker 與請求執行緒都可能同時呼叫同一 key → 全程持鎖，避免讀改寫競態。"""
    with _mis_lock:
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
            prev_c = cur["c"] if cur is not None else None
            if cur is not None:
                st["done"][cur["ts"]] = cur
            # 開盤價沿用上一根收盤(價格連續)：MIS 只有 10 秒取樣，若開盤就設成現價，這根一開始
            # 會是 o=h=l=c 的扁線；改用上一根收盤當 open、高低同時納入 open ⇒ 價格一離開上一根
            # 收盤，即時那根當下就有實體+上下影線，不再「只剩現價一條線」。當日首棒無前值 → 用現價。
            o = prev_c if prev_c is not None else price
            st["cur"] = {"ts": bar_ts, "o": o, "h": max(o, price), "l": min(o, price),
                         "c": price, "vol0": cumvol, "vol": 0}
        else:                                                  # 同分鐘 → 更新高/低/收 + 量(累積量差)
            cur["h"] = max(cur["h"], price); cur["l"] = min(cur["l"], price); cur["c"] = price
            cur["vol"] = max(0, cumvol - cur["vol0"])
        return _mis_acc_list(symbol, minutes)


def _tw_realtime_worker():
    """背景執行緒：交易時段(09:00-13:30 TPE)持續替最近看過的台股標的用 TWSE MIS 累積即時分鐘K。
    不依賴前端 poll → 使用者切走再切回、或前端沒在 poll 時，累積器仍不斷前進 → 無 Fugle 的本機
    也不再有『切標的回來中間一段沒棒』的斷層(那 20 分鐘窗口只剩開機初期，yfinance 延遲追上即補平)。
    每 15 秒一輪；每個 symbol 只抓一次即時報價、供其所有已請求時框累積；共用 tw_mis_ 快取不重複打 TWSE。"""
    while True:
        try:
            now_tpe = dt.utcnow() + timedelta(hours=8)
            mod = now_tpe.hour * 60 + now_tpe.minute
            in_session = now_tpe.weekday() < 5 and 9 * 60 <= mod < 13 * 60 + 30
            if in_session and _tw_hot:
                cutoff = time.time() - 1200                    # 只維護近 20 分內被請求過的標的
                # 順手清掉太舊(>1hr)的紀錄，避免無限增長
                for k, ts in [(k, v) for k, v in list(_tw_hot.items()) if v < time.time() - 3600]:
                    _tw_hot.pop(k, None)
                pairs = [(s, m) for (s, m), ts in list(_tw_hot.items()) if ts >= cutoff]
                rt_by_sym: dict = {}
                for sym, minutes in pairs:
                    if sym not in rt_by_sym:
                        mk = f"tw_mis_{sym}"
                        rt = cache.get(mk, ttl=10)
                        if rt is None:
                            rt = fetch_tw_realtime(sym)
                            if rt:
                                cache.set(mk, rt)
                        rt_by_sym[sym] = rt
                    rt = rt_by_sym.get(sym)
                    if rt:
                        _mis_accumulate(sym, minutes, rt)
        except Exception:
            pass
        time.sleep(15)


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


# ───────── 騰訊即時累積港股分鐘 K（免費、免 KYC；同 MIS 思路，有當日累積量）─────────
# 港股歷史走 yfinance(延遲~15分)，即時尖端用騰訊即時報價自己堆分鐘棒 → 當下就有最新棒。
# 騰訊報價只送出「查股價」、不外洩任何資料。HK 交易時段 09:30-12:00、13:00-16:00 HKT(=GMT+8)。
_hk_acc: dict = {}

def _hk_acc_list(symbol: str, minutes: int):
    st = _hk_acc.get(f"{symbol}:{minutes}")
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

def _hk_accumulate(symbol: str, minutes: int, rt: dict):
    """用騰訊即時報價即時堆出港股當前/近期分鐘 K。回傳今日已累積 bar list(升冪)。"""
    price = rt.get("close")
    hk_utc = rt["time"] - timedelta(hours=8)               # HKT naive → UTC naive
    bar_min = (hk_utc.hour * 60 + hk_utc.minute) // minutes * minutes
    bar_ts  = hk_utc.replace(hour=bar_min // 60, minute=bar_min % 60, second=0, microsecond=0)
    bar_hkt = ((bar_ts.hour + 8) % 24) * 60 + bar_ts.minute
    # 僅交易時段(09:30-16:00 HKT)累積；午休(12:00-13:00)自然無新棒；其餘時間回傳已累積不動
    if price is None or bar_hkt < 9 * 60 + 30 or bar_hkt >= 16 * 60:
        return _hk_acc_list(symbol, minutes)
    key = f"{symbol}:{minutes}"
    st = _hk_acc.get(key)
    if st is None or st["day"] != hk_utc.date():           # 換日重置
        st = {"day": hk_utc.date(), "cur": None, "done": {}}
        _hk_acc[key] = st
    cumvol = rt.get("volume") or 0
    cur = st["cur"]
    if cur is None or cur["ts"] != bar_ts:                 # 新分鐘 → 收掉舊棒、開新棒
        if cur is not None:
            st["done"][cur["ts"]] = cur
        st["cur"] = {"ts": bar_ts, "o": price, "h": price, "l": price, "c": price, "vol0": cumvol, "vol": 0}
    else:                                                  # 同分鐘 → 更新高/低/收 + 量(當日累積量差)
        cur["h"] = max(cur["h"], price); cur["l"] = min(cur["l"], price); cur["c"] = price
        cur["vol"] = max(0, cumvol - cur["vol0"])
    return _hk_acc_list(symbol, minutes)


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
    indicators: bool = True   # False=前端副圖隱藏→不算 KDJ/RSI/MACD、payload 少 8 欄（見 enrich_df）


# ── /api/ohlcv 的快速序列化 ───────────────────────────────────────────────────
#   量測（BTC 5m 7200 根＝背景補載一塊的典型大小、含 BB 共 9 欄）：
#     df_to_records            14.2ms   其中 to_dict 5.9ms、**逐列 NaN/isoformat 迴圈 11.8ms**
#     jsonable_encoder         41.1ms   ← FastAPI 回純 dict 時一定會做的整棵樹走訪
#     json.dumps               13.1ms
#     ─────────────────────────────  合計 ~68ms／每塊，全是純開銷
#     orjson.dumps              1.4ms
#   → 兩件事：①時間戳改**向量化**轉字串、NaN 交給 orjson（它自動轉 null）→ 省掉那圈迴圈；
#             ②回 ORJSONResponse 跳過 jsonable_encoder。實測 ~68ms → ~7ms。
#   ⚠ 不能改動共用的 df_to_records：其他端點仍走 FastAPI 預設編碼器，那裡 NaN 必須先轉 None
#     （json.dumps 會吐出非法的 `NaN`）。故另開這兩個只給本端點用的函式。
# 指標欄位瘦身用：這些是「算出來、只拿去畫線／顯示」的欄位，帶著 float64 的 17 位有效數字
#   （`"bb_middle": 60514.079999999994`）純粹是浪費頻寬——螢幕上根本畫不出那個精度。
#   實測 BTC 1h 1500 根：693KB→559KB，gzip 230KB→157KB（−32%）。這是首屏最大的一包。
# ⚠ 一定要用「有效位數」不能用「小數位數」：bb_*／macd_* 是**價格尺度**，round(x, 4) 會把
#   SHIB 那種 0.00001234 直接抹平成 0。8 位有效數字在任何價位都遠超過畫面能表現的精度。
# ⚠ 只動這 11 個推導欄位，open/high/low/close/volume 一律不碰（前端會拿它們重算 BB、比對時間、
#   算量能均線——原值進原值出，不引入任何誤差）。
_OHLCV_SLIM_COLS = ("rsi_14", "rsi_7", "macd", "macd_signal", "macd_hist",
                    "bb_upper", "bb_middle", "bb_lower", "kdj_k", "kdj_d", "kdj_j")
#   2026-08-04 再收一檔 8→6（實測 BTC 5m 2218 根：gzip 193.2KB→163.7KB，再省 15.3%）。
#   ⚠ 6 是「顯示會不會變」定出來的，不是拍腦袋：winrate.js 的 fmt() 對 >=1000 的價格用
#     toFixed(0)、<1000 用 toFixed(4)。6 位有效數字能保住 999,999 以內價格的整數位
#     → 兩條格式化路徑輸出完全不變。再往下走 sig=5 就會把六位數價格捨到十位
#     （BTC 曾站上 100000，120456 會顯示成 120460）＝使用者看得出來，故止步於 6。
#     畫面誤差方面 6 位只有 0.0067px（400px 高的窗格），遠在看不見的範圍。
_OHLCV_SLIM_SIG = 6


def _round_sig_series(s, sig=_OHLCV_SLIM_SIG):
    """向量化「四捨五入到 N 位有效數字」。NaN/inf/0 原樣保留。
    做法：先取十進位指數 → 縮放到整數位四捨五入 → 縮回去。之所以不用 np.round(a, decimals)，
    是因為它的 decimals 只吃純量，而我們每一格需要不同的小數位（值的量級不同）。"""
    a = s.to_numpy(dtype="float64", copy=True)
    m = np.isfinite(a) & (a != 0)
    if not m.any():
        return a
    scale = np.power(10.0, sig - 1 - np.floor(np.log10(np.abs(a[m]))))
    r = np.round(a[m] * scale) / scale
    a[m] = np.where(np.isfinite(r), r, a[m])   # 極端量級導致 scale 溢位 → 保留原值
    return a


def _ohlcv_records(df):
    """DataFrame → records（時間戳向量化轉 ISO；指標欄位縮到 8 位有效數字；NaN 原樣留給 orjson 轉 null）。"""
    try:
        out = df
        _slim = [c for c in _OHLCV_SLIM_COLS if c in out.columns]
        if _slim or ("time" in out.columns and hasattr(out["time"], "dt")):
            out = out.copy()
        for c in _slim:
            try:
                out[c] = _round_sig_series(out[c])
            except Exception:
                pass          # 單一欄位轉換失敗 → 該欄保持原樣（瘦身是可有可無的，正確性優先）
        if "time" in out.columns and hasattr(out["time"], "dt"):
            out["time"] = out["time"].dt.strftime("%Y-%m-%dT%H:%M:%S")
        return out.to_dict(orient="records")
    except Exception:
        return df_to_records(df)      # 任何意外 → 退回原本作法（正確性優先）


def _ohlcv_resp(payload):
    """大回應直接交給 orjson；缺 orjson 時退回純 dict（走 FastAPI 預設路徑）。
    ⚠ 退回預設路徑時 records 內可能留著 NaN → json.dumps 會產生非法 JSON，故此時改用
      df_to_records 的語義補一次 None 轉換。"""
    if _orjson is not None:
        return _json_resp(payload)
    try:
        for r in payload.get("data") or []:
            for k, v in r.items():
                if isinstance(v, float) and v != v:
                    r[k] = None
    except Exception:
        pass
    return payload


_OHLCV_SF_LOCK = _threading.Lock()
_OHLCV_SF: dict = {}
_OHLCV_SF_WAIT = 20.0        # 深歷史一次可能抓十幾個窗，等久一點也比重複打交易所划算


def _ohlcv_cache_key(req):
    """算出快取鍵 / TTL / use_limit。**單一定義**：路由的單飛與實作都用這一份，
    抄兩份就會出現「等的人跟做的人用不同的鍵」→ 單飛完全失效卻沒人發現。"""
    use_limit = req.limit > 0
    # 守衛:limit<=0 且沒給日期範圍 → 強制 500。內部「無上限」約定(背景補載/重播預載)
    # 一律附 start/end;外部亂傳 0/負值會拉整段歷史(BTC 1h 自 2017 起 ~8 萬根)=巨量回應。
    if not use_limit and not req.start and not req.end:
        req.limit, use_limit = 500, True
    key = (f"ohlcv:{req.market}:{req.symbol}:{req.timeframe}:{req.exchange}:"
           f"{req.start}:{req.end}:{req.limit}:i{int(req.indicators)}")
    return key, (30 if use_limit else 300), use_limit


@router.post("/ohlcv")
def get_ohlcv(req: OHLCVRequest):
    """取得 OHLCV 數據（單飛外殼；實作在 _ohlcv_build）。

    ⚠ 開頭先擋不認得的時框／夾住 limit（utils/tf.py）：
      沒有這層的話 timeframe="99z" 會 **200 OK 回 500 根日線**（靜默退化，圖上有東西不報錯），
      limit=999999 會回 **60079 根**。兩者都實測過。

    ★為什麼要單飛（2026-08-02）：純 TTL 快取擋不住「同時 miss」的叢發 ——
      實測 8 個人同時開**同一個標的**的圖表，會**各自**打交易所一次（8 次）。
      /api/latest 早就有單飛（同樣測試只打 1 次），但 ohlcv 才是重的那支：
      一般請求 500 根、深歷史一次十幾個窗 → 8 人同開 = 交易所被打近百次。
      使用者一多就是這樣撞上限流的（Binance 10 次/秒/IP，全站共用一個出口 IP）。
    → 同一把 key 只讓一個人去抓（leader），其他人等它抓完直接讀快取。
      等逾時就自己抓 → 最壞退回原本行為，不會卡住。"""
    req.timeframe = _check_tf(req.timeframe)
    req.limit = _clamp_limit(req.limit)
    cache_key, ttl, _ = _ohlcv_cache_key(req)
    cached = cache.get(cache_key, ttl)
    if cached:
        return _ohlcv_resp(cached)

    _leader = False
    with _OHLCV_SF_LOCK:
        _ev = _OHLCV_SF.get(cache_key)
        if _ev is None:
            _ev = _threading.Event(); _OHLCV_SF[cache_key] = _ev; _leader = True
    if not _leader:
        _ev.wait(_OHLCV_SF_WAIT)
        cached = cache.get(cache_key, ttl + 5)   # 放寬幾秒：leader 剛寫完就算「稍舊」也接受
        if cached:
            return _ohlcv_resp(cached)
    try:
        return _ohlcv_build(req)
    finally:
        if _leader:                              # 一定要放行，否則其他人白等 20 秒
            with _OHLCV_SF_LOCK:
                _OHLCV_SF.pop(cache_key, None)
            _ev.set()


def _ohlcv_build(req: OHLCVRequest):
    """實際抓取/組裝（原 get_ohlcv 的內容，一行未改）。"""
    cache_key, ttl, use_limit = _ohlcv_cache_key(req)

    # ── BB 暖身期補償（2026-07-30）────────────────────────────────────────────
    #   BB(20) 需要 20 根才有值 → 每一塊的**開頭 19 根 bb_upper/middle/lower 都是 null**。
    #   前端往舊滑是「一塊一塊 prepend」，前一塊的那 19 根 null 會被下一塊推到陣列中段
    #   → **BB 帶在每個補載接縫處斷一截**（5m 約 1.5 小時）。深滑 40 輪實測 BB 資料點比 K 棒
    #   少 190 根 = 19 × 10 塊，比例與塊數完全吻合。
    #   → 範圍請求時把起點往前多抓一段暖身，算完指標再切回使用者要的範圍：接縫處就有值了。
    #   ⚠ 只動 range 模式（use_limit 的初次載入本來就從最新往回抓、開頭在最舊端、看不到）。
    _warm_start = None
    if not use_limit and req.start:
        try:
            _wsec = _CRT_IV.get(req.timeframe, 3600) * 30      # 30 根餘裕（BB 只要 20）
            _warm_start = req.start
            req.start = (dt.fromisoformat(req.start) - timedelta(seconds=_wsec)).date().isoformat()
        except Exception:
            _warm_start = None

    try:
        if req.market == "tw" and req.symbol.upper() in FUTOPT_PRODUCTS:
            tf = req.timeframe
            if tf in TXF_INTRADAY:
                # 盤中(分/時)：cnyes(含夜盤即時) + 自建DB歷史 → resample
                fdf = get_txf_intraday(req.symbol, tf)
                df = fdf if fdf is not None else pd.DataFrame()
            elif tf in ("1d", "1w", "1M"):
                # 日/週/月：FinMind 期貨日線 + resample_tw（有跨日歷史）
                end = req.end or date.today().isoformat()
                if use_limit:
                    per = {"1d": 2, "1w": 9, "1M": 40}.get(tf, 2)
                    start = (date.today() - timedelta(days=max(180, req.limit * per))).isoformat()
                else:
                    start = req.start or (date.fromisoformat(end) - timedelta(days=1460)).isoformat()
                ddf = fetch_taifex_daily(req.symbol, start, end, req.finmind_token)
                ddf = ddf if ddf is not None else pd.DataFrame()
                if not ddf.empty and tf != "1d":
                    ddf = resample_tw(ddf, tf)
                df = ddf.tail(req.limit) if (use_limit and not ddf.empty) else ddf
            else:
                raise HTTPException(400, "台指期不支援此時框")
        elif req.market == "tw":
            if "/" in req.symbol:
                raise ValueError(f"{req.symbol} 不是台股代號，請確認市場選擇")
            if req.timeframe in ("1m", "5m", "15m", "1h") or req.timeframe in TW_RESAMPLE:
                # 30m/2h/4h 走 15m 或 1h 來源再重採樣（避免 yfinance 對台股非 15m 盤中時框的 bug）
                src_tf = TW_RESAMPLE[req.timeframe][0] if req.timeframe in TW_RESAMPLE else req.timeframe
                max_d = TW_YF_MAX_DAYS.get(src_tf, 60)
                if use_limit:
                    bars_per_day = {"1m": 270, "5m": 78, "15m": 26, "30m": 9, "1h": 5, "2h": 3, "4h": 2}.get(req.timeframe, 26)
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
                # ⭐ 今日改用 cnyes 個股即時分鐘K（歷史仍 yfinance）→ 一載入就即時、連續無跳號、無延遲、
                #    免金鑰（同台指期資料源）。只在「查詢範圍含今日」時併入（歷史/重播查詢 end 為過去日，跳過不影響）。
                # ★2026-08-01 補上「合併」：這條是**畫在圖上的那份資料**，但先前只有勝率那條
                #   （fetch_crt_df）換成了 merge_tw_intraday，這裡還停在舊的「切一刀再接上去」。
                #   舊作法＝以 cnyes 最早那根當 cutoff、整段蓋掉 yfinance，且 cnyes 一失敗就整段
                #   退回落後的 yfinance（實測 12:36 時它只到 11:45）→ 最後幾根 K 棒往回退、
                #   重整又跑回來，正是使用者回報的「台股 K 棒不穩定」。與勝率那條用同一套規則：
                #   ① 抓不到就沿用今天最後一次成功的（cnyes_last_good）② 逐欄位合併（見 merge_tw_intraday）。
                _today_live = False
                if (src_tf in ("1m", "5m", "15m", "1h")
                        and end >= date.today().isoformat() and not df.empty):
                    cdf = cnyes_last_good(req.symbol, src_tf,
                                          fetch_cnyes_stock_intraday(req.symbol, src_tf))
                    if cdf is not None and not cdf.empty:
                        df = merge_tw_intraday(df, cdf)
                        _today_live = True
                # cnyes 失敗（收盤/查無）時退回 Fugle（若設 token）→ 再退回純 yfinance。
                if (not _today_live and fugle_enabled() and src_tf in ("1m", "5m", "15m", "1h")
                        and end >= date.today().isoformat() and not df.empty):
                    fdf = fetch_fugle_intraday(req.symbol, src_tf)
                    if fdf is not None and not fdf.empty:
                        cutoff = fdf["time"].min()           # Fugle 當日最早一根 → 之後全用 Fugle
                        df = pd.concat([df[df["time"] < cutoff], fdf],
                                       ignore_index=True).sort_values("time").reset_index(drop=True)
                # 30m/2h/4h 重採樣（對齊台北 09:00 = UTC 01:00）
                # ⚠ 改用共用的 resample_tw_intraday：這裡原本是把分桶規則**抄一份**在本地，
                #   正是 resample_tw_4h 註解警告過的情況（兩條路徑規則一旦分歧，最後一根時間戳
                #   對不上 → 前端當成新的一根接上去 → 圖上多一根假 K 棒）。
                if req.timeframe in TW_RESAMPLE:
                    df = resample_tw_intraday(df, req.timeframe)
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
                # 同 fetch_crt_df：官方 opendata 補最新交易日（yfinance 收盤後會延遲很久）
                df = tw_daily_fill_latest(df, req.symbol)
                df = resample_tw(df, req.timeframe)
                if use_limit:
                    df = df.tail(req.limit)
        elif req.market == "crypto":
            df = None
            # 5m 倉庫(BTC/ETH/SOL)：帶 start 的 range 請求優先讀倉庫 → 深度歷史秒開。
            #   ① end 空/到今天(看歷史切時框「一次到位」)：倉庫深歷史 + Binance 新尾巴 → [start,現在]一份完整
            #      → 前端第一次畫就在正確位置、不必先載近段再滑過去。
            #   ② end 在過去(背景回填分塊)：直接切倉庫該段。
            #   初次/最新(use_limit)走 API 保新鮮。倉庫沒涵蓋→None 自動退 API。線上無此檔亦 graceful。
            if not use_limit and req.start:
                try:
                    from data.klines_store import is_target as _k_is, load_from as _k_from, load_range as _k_load
                    if _k_is(req.symbol, req.timeframe):
                        _today = date.today().isoformat()
                        if (not req.end) or req.end >= _today:
                            _st = _k_from(req.symbol, req.timeframe, req.start)
                            if _st is not None and not _st.empty:
                                _ts = _st["time"].iloc[-1].strftime("%Y-%m-%d")
                                _tail = fetch_crypto_ohlcv(req.symbol, req.timeframe, _ts, _today, req.exchange)
                                if _tail is not None and not _tail.empty:
                                    df = pd.concat([_st, _tail]).drop_duplicates("time").sort_values("time").reset_index(drop=True)
                                else:
                                    df = _st
                        else:
                            df = _k_load(req.symbol, req.timeframe, req.start, req.end)
                except Exception:
                    df = None
            if df is None:
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
        elif req.market in ("us", "hk", "fx"):
            # 港股(hk)＝美股同一條 yfinance 路（代號 xxxx.HK）。即時報價疊加僅美股(Finnhub)，港股純用 yfinance。
            # ★ 2026-08-11 外匯(fx)也走這條：只差代號轉換（EUR/USD → EURUSD=X、黃金 → GC=F）。
            #   為什麼不另寫一套：這條路已經處理完所有踩過的坑 —— Yahoo 不支援 2h（抓 1h 併）、
            #   4h 也由 1h 併（原生 4h 只能回溯 60 天）、各時框 MAX_DAYS 與「嚴格小於」邊界 buffer、
            #   零寬區間要回空不能拋 400。外匯自己再寫一份只會把這些重踩一遍。
            #   ⚠ 外匯無成交量（Yahoo 的 FX volume 恆為 0）——這是店頭市場的性質，不是 bug。
            max_d = US_MAX_DAYS.get(req.timeframe, 3650)
            # 美股各 TF 每日 bar 數（用於 limit→days 反推，避免過量請求觸 yfinance 邊界）
            # 6.5h 交易：4h≈2、1h≈7、15m≈26、5m≈78（港股交易時段較短，buffer 已足夠涵蓋）
            _bpd = {"1M": 1/30, "1w": 1/7, "1d": 1, "4h": 2, "2h": 3.25, "1h": 7, "15m": 26, "5m": 78, "1m": 390}
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
                # ★2026-08-01：下限要以「今天」算，不是以 end 算。
                #   yfinance 的分鐘/小時資料是**相對於現在**的滾動視窗（15m/30m 約 60 天），
                #   跟你要求的 end 落在哪天無關。原本寫 end - max_d，往回補歷史時（end 也在過去）
                #   會算出一個 yfinance 根本搆不到的區間 → 回空 → 被當成「查無此標的」，
                #   前端 console 一路 400，訊息還是「請確認代號正確」——但代號根本沒錯。
                #   實測 AAPL 15m/30m 帶 start=2026-06-01 起就必定 400（15m 早就如此，非新問題）。
                _floor = (date.today() - timedelta(days=max_d)).isoformat()
                start = max(start_raw, _floor)
                # 夾完之後 start 追上或越過 end ＝ 這段已經在可取範圍之外（或被夾成零寬區間）。
                # ⚠ 一定要含「等於」：背景補載是一天一天往回要的，走到邊界時會出現
                #   start=06-02 end=06-03、夾完變成 start=end=06-03 的零寬請求，
                #   yfinance 對零寬區間回空 → 又被當成「查無此標的」。
                if end <= _floor or start >= end:
                    # 整段都在可取範圍之外（例：要 2025 年的 15m）→ 這不是錯誤，是「沒有更舊的了」。
                    # 回空讓前端的背景補載自然停住，不要拋 400 誤導成代號有問題。
                    _empty = {"data": []}
                    cache.set(cache_key, _empty)
                    return _ohlcv_resp(_empty)
            _sym = req.symbol
            _fx_crypto = None
            if req.market == "fx":
                from data.forex import to_yf as _fx_to_yf, crypto_symbol as _fx_cs
                _fx_crypto = _fx_cs(req.symbol)      # 貴金屬 → 幣安代幣化商品（即時且有量）
                _sym = _fx_to_yf(req.symbol)
            if _fx_crypto:
                if use_limit:
                    df = fetch_crypto_ohlcv(_fx_crypto, req.timeframe, limit=req.limit, exchange_id="binance")
                else:
                    df = fetch_crypto_ohlcv(_fx_crypto, req.timeframe, start, end, "binance")
            else:
                df = fetch_us_stock(_sym, start, end, req.timeframe)
            # Finnhub 即時報價疊加到最後一根 K 棒（失敗不影響主流程）；港股無 Finnhub 覆蓋，純用 yfinance。
            if req.market == "us" and os.getenv("FINNHUB_TOKEN"):
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
        # 台指期休市/無資料屬正常（futopt 僅盤中）→ 回空表不報錯，前端 graceful
        if req.market == "tw" and req.symbol.upper() in FUTOPT_PRODUCTS:
            return {"data": []}
        raise HTTPException(400, f"查無 {req.symbol} 的資料，該標的可能不支援此交易所")

    df = enrich_df(df, indicators=req.indicators)
    # 切掉上面多抓的暖身段（指標已算完 → 使用者拿到的第一根就有 BB 值，接縫不再斷）。
    #   保留 1 天邊際：與倉庫 load_range 既有行為一致，前端靠它重疊去重、判斷接得上。
    if _warm_start:
        try:
            _cut = pd.Timestamp(_warm_start) - pd.Timedelta(days=1)
            _kept = df[df["time"] >= _cut]
            if len(_kept) >= 2:
                df = _kept.reset_index(drop=True)
        except Exception:
            pass
    result = {"data": _ohlcv_records(df)}
    # ★ 2026-08-06 回傳實際資料源（crypto）。用途：前端接合時判斷「這批資料跟我手上那批
    #   是不是同一個來源」—— 各來源對同一根已收盤 K 棒的數值差幾點（實測整串偏移 3~6 點），
    #   每份快照內部連續、混在一起才會在接合處留下跳空。
    #   ⚠ 放在 cache.set 之前：快取命中時也要帶著它當初的來源，否則前端判斷會失真。
    if req.market == "crypto":
        try:
            result["src"] = last_fetch_source()
        except Exception:
            pass
    cache.set(cache_key, result)
    return _ohlcv_resp(result)


class LatestRequest(BaseModel):
    market: str
    symbol: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    api_key: str = ""
    api_secret: str = ""
    finmind_token: str = ""


@router.get("/export_klines")
def export_klines(symbol: str, timeframe: str = "1d", market: str = "crypto", exchange: str = "pionex"):
    """把指定標的+時框的『完整可取歷史』K 線匯出成 CSV 下載(存到電腦)。
    crypto 走 Binance/本機倉庫深歷史。用法:瀏覽器直接開
      /api/export_klines?symbol=BTC/USDT&timeframe=1d  → 自動下載 BTCUSDT_1d.csv
    """
    # ⚠ 小時框 days 不能太大:資料源有列數上限,days 過大會回傳「最舊那段」而砍掉最近的(15m/30m/1m
    #   曾停在數月~2年前)。調到「總根數在上限內」→ 結尾貼到現在。深度=該時框能取到的最近最深。
    _days = {"1m": 20, "5m": 370, "15m": 720, "30m": 700, "1h": 2500,
             "2h": 4000, "4h": 5000, "1d": 5000, "1w": 5000, "1M": 5000}.get(timeframe, 2500)
    try:
        df = fetch_crt_df(market, symbol, timeframe, _days, exchange)
    except Exception as e:
        raise HTTPException(400, str(e))
    if df is None or df.empty:
        raise HTTPException(404, "查無資料")
    cols = [c for c in ["time", "open", "high", "low", "close", "volume"] if c in df.columns]
    out = df[cols].copy()
    try:  # 時間轉可讀字串(ISO),Excel/試算表友善
        out["time"] = out["time"].astype(str)
    except Exception:
        pass
    csv = out.to_csv(index=False)
    fn = f"{symbol.replace('/', '').replace('.', '')}_{timeframe}.csv"
    return Response(csv, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fn}"'})


# ── 即時 K 棒的「來源黏著」（2026-08-08）────────────────────────────────────────
#   使用者回報「主圖最新 K 棒還是會動」。實測（headless 盯 ohlcvData，1m、100 秒）：
#     形成中那根的 open 變動 1 次、**已收盤的棒被改寫 38 次**，幅度 4~15 點（不是浮點誤差）。
#   根因是**來源在 binance / bybit 之間反覆跳**：Binance 偶發限流/逾時 → 這一秒退 Bybit、
#   下一秒又回 Binance。兩家對同一根已收盤 K 棒差幾點，而前端為了「不留接縫」，
#   換源時會整段重對齊（連 open 一起換）、同源時保留 open 只換 h/l/c ——
#   於是每跳一次，畫面上那幾根就跟著動一次。連續性守門員甚至傾印出
#   **O64938 但 L64948（低點比開盤還高）的不可能 K 棒**，就是兩份不同來源被縫在同一根上。
#
#   對策：短時間內**守住原來的來源**。新抓到的資料若換了交易所，而我們手上這份同源資料
#   還很新（≤ _SRC_STICKY_SEC），這一拍就**回空**（不是回舊資料，見下方 ⚠），前端的
#   `if (!json.data?.length) return;` 會乾淨地跳過這一輪、圖表停在原值不動。
#     ・Binance 只是「每隔幾秒漏一拍」→ 那幾拍跳過，完全不換源，也就沒有任何重寫。
#     ・Binance 真的掛掉 → 沒有新的同源資料來刷新 ts，過了 _SRC_STICKY_SEC 就採用 Bybit，
#       整個切換過程只發生**一次**重對齊，而不是每秒一次。
#   ⚠ 第一版是「回手上那份舊的」，錯得很隱蔽：於是回應在「最新」與「最多 15 秒前」之間交替，
#     而前端的 `t < lastT` 補正是**照單全收**的 → 同一根 K 棒被新值、舊值輪流蓋，
#     實測同一根 high 在 65048 ↔ 65038.1 之間來回跳（±9.9）。**回空才是對的**：
#     沒有資料就什麼都不動，比給一份「內部一致但過期」的快照安全。
#   ⚠ 代價是換源那一刻最多有 _SRC_STICKY_SEC 秒「最後一根不動」。這是刻意的取捨：
#     停一下看不出來，跳來跳去很明顯。別為了「更即時」把它調到 5 秒以下（等於沒黏著）。
_SRC_STICKY: dict = {}
#   ★ 60 秒是量出來的，不是拍腦袋：本機 Binance 約 28% 的秒數失敗（150 秒裡 34 次退 Bybit、
#     27 次 hold）。窗口 15 秒時仍有 2 次真的換源 → 定案棒被整根改寫、看得出來在動。
#     拉到 60 秒＝「只要 Binance 一分鐘內成功過一次就絕不換源」，正常的間歇性失敗完全吃掉。
#     代價：Binance 真的整組掛掉時，最後一根最多停 60 秒才切到 Bybit。這是刻意的取捨——
#     停一下沒人看得出來，數字跳來跳去每個人都看得出來。
_SRC_STICKY_SEC = 60.0
_SRC_STICKY_LOCK = _threading.Lock()


def _sticky_source(key: str, df, src):
    """回傳 (df, src, hold)。hold=True 代表「這一拍別送」（換源但手上同源資料還新）。"""
    if df is None or getattr(df, "empty", True) or not src:
        return df, src, False
    now = time.time()
    with _SRC_STICKY_LOCK:
        st = _SRC_STICKY.get(key)
        if st and st["src"] != src and (now - st["ts"]) <= _SRC_STICKY_SEC:
            return df, src, True           # 守住原來的來源：這一拍跳過
        if len(_SRC_STICKY) > 200:         # 只留近期在看的標的，別無限長大
            for k in [k for k, v in _SRC_STICKY.items() if now - v["ts"] > 300]:
                _SRC_STICKY.pop(k, None)
        _SRC_STICKY[key] = {"src": src, "ts": now}
    return df, src, False


@router.post("/latest")
def get_latest(req: LatestRequest):
    """取得最新 K 棒"""
    req.timeframe = _check_tf(req.timeframe)      # 不認得的時框當場 400，不要靜默退日線
    _crypto_src = None      # 這份 df 的實際來源（crypto 才有；跟著資料走，見下方快取那段）
    try:
        if req.market == "tw" and req.symbol.upper() in FUTOPT_PRODUCTS:
            # 台指期（歸台股底下）：盤中時框回累積K tail（快取 3 秒）；日/週/月線無即時 tick 回空
            if req.timeframe not in TXF_INTRADAY:
                return {"live": False, "data": []}
            fkey = f"txf_cnyes_{req.symbol}_{req.timeframe}"
            fdf = cache.get(fkey, ttl=3)
            if fdf is None:
                fdf = get_txf_intraday(req.symbol, req.timeframe)
                if fdf is not None and not fdf.empty:
                    cache.set(fkey, fdf)
            if fdf is not None and not fdf.empty:
                return {"live": True, "data": df_to_records(fdf.tail(20))}
            return {"live": False, "data": []}
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
            if tf in ("1m", "5m", "15m", "1h") or tf in TW_RESAMPLE:
                # ⭐ cnyes 個股即時分鐘K 最優先（同台指期資料源：09:00 起連續無跳號、無延遲、含即時那根、
                #    免金鑰）。徹底解決 yfinance 台股盤中延遲15-20分 + MIS 只補打開後那段 → 「1010跳1030」
                #    斷層。快取 8 秒；失敗/收盤/查無 → fallback 回 Fugle→yfinance+MIS。
                # 4h 也走這條（2026-07-31）：cnyes 沒有原生 4h → 抓 1h 再用與 /api/ohlcv **同一個**
                # 分桶函式 resample_tw_4h 產 4h。原本 4h 被排除在外，只能落到最下面的 yfinance
                # 路徑並回 live=False → 前端根本不會輪詢更新它，盤中那根 4h 就一直是舊值。
                # ★2026-08-01：連同 30m/2h 一起（原本只有 4h）。理由與上方 4h 那段完全相同 ——
                #   被排除在外的時框會落到最下面的 yfinance 路徑並回 live=False → **前端根本不會
                #   輪詢更新它**，盤中那根就一直是舊值。30m/2h 先前拿到的是日線所以看不出來，
                #   現在它們是真的盤中棒了，這個洞就會現形。
                _src_tf = TW_RESAMPLE[tf][0] if tf in TW_RESAMPLE else tf
                if True:
                    cnkey = f"tw_cnyes_{req.symbol}_{_src_tf}"
                    cndf = cache.get(cnkey, ttl=8)
                    if cndf is None:
                        cndf = fetch_cnyes_stock_intraday(req.symbol, _src_tf)
                        if cndf is not None and not cndf.empty:
                            cache.set(cnkey, cndf)
                    if cndf is not None and not cndf.empty:
                        if tf in TW_RESAMPLE:
                            cndf = resample_tw_intraday(cndf, tf)   # 與 /api/ohlcv 同一個分桶函式
                        if cndf is not None and not cndf.empty:
                            return {"live": True, "data": df_to_records(cndf.tail(40))}
                # Fugle 富果即時分鐘K 次之（無 20 分延遲、無空隙）。快取 8 秒；失敗或未設 FUGLE_TOKEN → yfinance+MIS。
                if tf in ("1m", "5m", "15m", "1h") and fugle_enabled():
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
                    if rt and tf in RT_ACC_MINUTES:
                        minutes = RT_ACC_MINUTES[tf]
                        _tw_hot[(req.symbol, minutes)] = time.time()   # 背景 worker 據此持續累積此標的
                        # MIS 即時累積真實分鐘棒：把 yfinance 最後一根之後的(含當下這根)接上 → 當下就有最新棒、無 20 分 gap
                        yf_last = pd.Timestamp(df_out.iloc[-1]["time"]).floor(f"{minutes}min")
                        # MIS 即時累積真實分鐘棒(yf_last 之後)；缺的分鐘用「前一根收盤」平盤補齊(o=h=l=c、量0)：
                        #   避免「1010 直接跳 1030」斷層——yfinance 台股盤中延遲 15-20 分、MIS 只從打開那刻起補，
                        #   中間那段兩邊沒蓋 → 缺號。補平盤棒讓圖連續；yfinance 追上後真實棒會覆蓋這些暫時棒。
                        mis_by_ts = {pd.Timestamp(b["time"]): b for b in _mis_accumulate(req.symbol, minutes, rt)
                                     if pd.Timestamp(b["time"]) > yf_last}
                        if mis_by_ts:
                            step = pd.Timedelta(minutes=minutes)
                            end_t = max(mis_by_ts)
                            start_t = yf_last + step
                            _min_start = end_t - 59 * step      # 上限60根:只補最新窗,更舊交 yfinance(確保當下這根一定含)
                            if start_t < _min_start: start_t = _min_start
                            last_c = float(df_out.iloc[-1]["close"])
                            t = start_t; _guard = 0
                            while t <= end_t and _guard < 80:
                                _tp = ((t.hour + 8) % 24) * 60 + t.minute
                                if 9 * 60 <= _tp < 13 * 60 + 30:   # 只補交易時段
                                    b = mis_by_ts.get(t)
                                    if b:
                                        recs.append({"time": t.isoformat(), "open": b["open"], "high": b["high"],
                                                     "low": b["low"], "close": b["close"], "volume": b["volume"]})
                                        last_c = b["close"]
                                    else:                          # 缺號 → 前一根收盤平盤填
                                        recs.append({"time": t.isoformat(), "open": last_c, "high": last_c,
                                                     "low": last_c, "close": last_c, "volume": 0})
                                t += step; _guard += 1
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
            _us_live = False          # 有沒有真的套到即時來源（見下方各 return 與 _finnhub_overlay）
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
                    return {"live": _us_market_open(), "data": df_to_records(adf.tail(20))}
            # ⭐ Twelve Data 即時 + 成交量（可選升級；設 TWELVEDATA_TOKEN 啟用）；快取 10 秒
            if twelvedata_enabled() and req.timeframe in ("5m", "15m", "1h", "4h"):
                tkey = f"us_td_{req.symbol}_{req.timeframe}"
                tdf = cache.get(tkey, ttl=10)
                if tdf is None:
                    tdf = fetch_twelvedata_intraday(req.symbol, req.timeframe)
                    if tdf is not None and not tdf.empty:
                        cache.set(tkey, tdf)
                if tdf is not None and not tdf.empty:
                    return {"live": _us_market_open(), "data": df_to_records(tdf.tail(20))}
            end   = date.today().isoformat()
            start = (date.today() - timedelta(days=10)).isoformat()
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
            # Finnhub 即時報價（免費/免 KYC）：盤中分鐘/小時用即時價自己堆「當下這根」真實K(無量,
            # yfinance 回補)→ 接在 yfinance 最後一根之後、無 20 分延遲；報價過期或日線→只疊加最後一根。
            if os.getenv("FINNHUB_TOKEN"):
                try:
                    quote = fetch_us_quote(req.symbol)
                    _mins = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240}.get(req.timeframe)
                    acc = _finnhub_accumulate(req.symbol, _mins, quote) if (_mins and quote) else []
                    if acc:
                        recs = df_to_records(df.tail(6))
                        yf_last = pd.Timestamp(df.iloc[-1]["time"]).floor(f"{_mins}min")
                        for b in acc:
                            if pd.Timestamp(b["time"]) > yf_last:
                                recs.append({"time": b["time"].isoformat(), "open": b["open"],
                                             "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]})
                        return {"live": _us_market_open(), "data": recs}
                    # ★ 第二個回傳值就是「有沒有真的疊到即時價」——原本被丟掉，
                    #   結果只能靠「有沒有設金鑰」猜 live，對 Finnhub 沒涵蓋的標的就會說謊。
                    df, _us_live = _finnhub_overlay(df, quote)   # 報價過期/日線 → 退回疊加最後一根
                except Exception:
                    pass  # Finnhub 出錯就純用 yfinance 資料
        elif req.market == "fx":
            # 外匯即時：走與 /api/ohlcv 同一條 yfinance 路抓最近幾根。
            # ⚠ 實測主要貨幣對（EUR/USD、USD/JPY、GBP/USD）最後一根 1m K 只落後 **0.8 分鐘**
            #   ——與加密同量級，不需要像台股/美股那樣另外接即時源疊加。
            #   （黃金走期貨 GC=F 約落後 10 分鐘，屬資料源限制。）
            from data.forex import to_yf as _fx_to_yf, crypto_symbol as _fx_cs
            _fx_crypto = _fx_cs(req.symbol)
            if _fx_crypto:                            # 貴金屬走幣安：即時 0.6 分、有成交量
                df = fetch_crypto_ohlcv(_fx_crypto, req.timeframe, limit=3, exchange_id="binance")
            else:
                _fxdays = {"1m": 3, "5m": 8, "15m": 20, "1h": 40, "4h": 120}.get(req.timeframe, 400)
                df = fetch_us_stock(_fx_to_yf(req.symbol),
                                    (date.today() - timedelta(days=_fxdays)).isoformat(),
                                    date.today().isoformat(), req.timeframe)
            if df is None or df.empty:
                return {"live": False, "data": []}
        elif req.market == "hk":
            # 港股(hk)：歷史 yfinance(延遲~15分)，即時尖端用騰訊即時報價自己堆分鐘棒 → 當下就有最新棒、無延遲。
            _mins = RT_ACC_MINUTES.get(req.timeframe)
            df = pd.DataFrame()
            try:                                              # yfinance 尾(補真實量)；1m 僅近 7 天，取 6 天內
                end   = date.today().isoformat()
                start = (date.today() - timedelta(days=6 if _mins else 10)).isoformat()
                df = fetch_us_stock(req.symbol, start, end, req.timeframe)
            except Exception:
                pass                                          # 休市/無盤中資料 → 純靠騰訊累積器
            if _mins:
                hk_key = f"hk_rt_{req.symbol}"
                rt = cache.get(hk_key, ttl=8)                 # 騰訊報價快取 8 秒(禮貌、夠即時)
                if rt is None:
                    rt = fetch_hk_realtime(req.symbol)
                    if rt:
                        cache.set(hk_key, rt)
                acc = _hk_accumulate(req.symbol, _mins, rt) if rt else []
                if acc:
                    recs = df_to_records(df.tail(6)) if not df.empty else []
                    yf_last = pd.Timestamp(df.iloc[-1]["time"]).floor(f"{_mins}min") if not df.empty else None
                    for b in acc:
                        if yf_last is None or pd.Timestamp(b["time"]) > yf_last:
                            recs.append({"time": b["time"].isoformat(), "open": b["open"],
                                         "high": b["high"], "low": b["low"], "close": b["close"], "volume": b["volume"]})
                    if recs:
                        return {"live": True, "data": recs}
            if df.empty:                                      # 休市且無累積 → 優雅回空(不報 400)
                return {"live": False, "data": []}
        else:
            # ★1 秒共用快取（2026-07-31 補）：這條是**唯一沒有快取**的即時價路徑 —— tw(10s)/
            #   hk(8s)/alpaca(8s)/twelvedata(10s) 都有，只有 crypto 每次請求都直接打 Binance。
            #   而前端 crypto 是「每秒一次」且依規範不可改慢 → 每多一個同時在看的人就多 1 req/s，
            #   全部共用伺服器同一個 IP，而 fapi 是 10 次/秒/IP、超過會全域熔斷 60 秒（還會 +10s
            #   累加）。再加上 ticker worker、教練暖掃、足跡 aggTrades 也在吃同一份額度。
            #   TTL 取 1 秒＝剛好等於前端輪詢間隔 → 單一使用者的新鮮度完全不變（他下一次輪詢時
            #   快取已過期、照樣抓新的），但「同一秒內的多個使用者」會收斂成一次上游請求。
            #   帶自有金鑰的請求不走快取（那是使用者自己的交易所連線，不與他人共用）。
            # ★單飛（2026-07-31 補）：光有 TTL 快取擋不住「同時 miss」—— 8 個請求同一瞬間到達時，
            #   快取都還沒被填，於是 8 個全部打上游（實測純快取版在冷叢發下毫無改善）。而要防的
            #   Binance 限流恰恰就是這種叢發。→ 同一把 key 只讓一個人去抓（leader），其他人等它
            #   （follower，最多 3 秒）；抓完大家一起讀快取。等逾時就自己抓，最壞退回原本行為。
            #   同 _WR_SF 的作法。
            # ★ 2026-08-08：快取存的是 (df, src) 而不是單獨的 df。
            #   為什麼：src 來自 last_fetch_source()，那是 **thread-local**——「這條執行緒上次抓的來源」。
            #   走快取時根本沒發生抓取，事後再問它，拿到的是**同一條 worker thread 上一個請求**
            #   （可能是別的標的）的來源。實測兩個客戶端同時輪詢時，同一個標的的 src 會在
            #   binance/bybit 之間**完美交替**——全是假的換源。
            #   後果不是顯示問題而是**改資料**：前端 _bgLoadNewerBars 看到「換源」就整段重對齊
            #   （連 open 一起換）→ 已收盤的棒 open 跳 12 點；看到「同源」則保留 open 只換 h/l/c
            #   → 兩份不同來源的快照被縫在同一根上，量到 **O64938 但 L64948（低點比開盤高）的
            #   不可能 K 棒**。使用者說的「最新 K 棒還是會動」就是這個。
            #   → 來源必須跟著資料本身走（/api/ohlcv 早就是把 src 存進快取內容，這支漏了）。
            _ck = f"crypto_latest_{req.exchange}_{req.symbol}_{req.timeframe}"
            _hit = cache.get(_ck, ttl=1) if not req.api_key else None
            df, _crypto_src = _hit if isinstance(_hit, tuple) else (None, None)
            if df is None and not req.api_key:
                _leader = False
                with _LATEST_SF_LOCK:
                    _ev = _LATEST_SF.get(_ck)
                    if _ev is None:
                        _ev = _threading.Event(); _LATEST_SF[_ck] = _ev; _leader = True
                if not _leader:
                    _ev.wait(3.0)                       # 等 leader 抓完（結果已進快取）
                    _hit = cache.get(_ck, ttl=2)        # 放寬一點點：leader 剛寫完就算它「1 秒前」也接受
                    df, _crypto_src = _hit if isinstance(_hit, tuple) else (None, None)
                if df is None:
                    try:
                        df = fetch_crypto_ohlcv(
                            req.symbol, req.timeframe, limit=3,
                            exchange_id=req.exchange,
                            api_key=req.api_key, api_secret=req.api_secret,
                        )
                        # ⚠ 一定要在這裡取（同一條執行緒、剛抓完的那一刻）才對得上這份 df
                        _crypto_src = last_fetch_source()
                        if df is not None and not df.empty:
                            cache.set(_ck, (df, _crypto_src))
                    finally:
                        if _leader:                     # 一定要放行，否則其他人白等 3 秒
                            with _LATEST_SF_LOCK:
                                _LATEST_SF.pop(_ck, None)
                            _ev.set()
                elif _leader:
                    with _LATEST_SF_LOCK:
                        _LATEST_SF.pop(_ck, None)
                    _ev.set()
            elif df is None:
                df = fetch_crypto_ohlcv(
                    req.symbol, req.timeframe, limit=3,
                    exchange_id=req.exchange,
                    api_key=req.api_key, api_secret=req.api_secret,
                )
                _crypto_src = last_fetch_source()       # 自有金鑰路徑不走快取，抓完立刻取
    except Exception as e:
        raise HTTPException(400, str(e))

    if req.market == "crypto" and not req.api_key:
        df, _crypto_src, _hold = _sticky_source(
            f"{req.exchange}_{req.symbol}_{req.timeframe}", df, _crypto_src)
        if _hold:
            return {"live": True, "data": []}   # 這一拍跳過，不拿別的來源去蓋

    if df.empty:
        raise HTTPException(400, "無資料")

    # ⚠ 回 3 根不是 2 根（2026-08-04）：第一根的用途是「把已收盤那根補成最終值」。
    #   只回 2 根時補正窗口只有一輪 —— 交易所把上一根定案得稍慢一點，等前端要補時
    #   那根已經被擠出回傳範圍，於是永遠停在未完成值、與下一根的開盤價對不上＝小跳空
    #   （使用者回報「最新一根都會這樣、要重整才會好」，實測跳空 3~6 點）。
    #   本來就已經抓了 limit=3，多回一根成本可忽略，卻讓補正多一輪機會。
    records = df_to_records(df.tail(3))
    # ★ 2026-08-15 使用者：「NQ=F 跳很慢」。舊判定是
    #     `req.market == "us" and bool(os.getenv("FINNHUB_TOKEN"))`
    #   —— 只看「**有沒有設金鑰**」，不看「**這一檔到底有沒有拿到即時資料**」。
    #   Finnhub／Twelve Data 不涵蓋 CME 期貨（NQ=F、ES=F…）與部分 ETF/外國掛牌 →
    #   那些標的其實是純 yfinance 的 ~10~15 分延遲資料，卻照樣回 live=True、
    #   前端的即時指示燈亮著。線上實測：AAPL 落後 1.6 分（真即時）、NQ=F 落後 **11.5 分**，
    #   兩者都回 live=True。這是**對使用者說謊**：他以為在看即時、實際上慢十分鐘。
    #   → 改成看「資料本身新不新鮮」：最後一根的起始時間距現在若超過「一個週期 + 3 分鐘」，
    #     就不是即時。這個判準與哪家供應商無關，供應商臨時失效時也會自己說實話。
    #   ⚠ 只改盤中時框：日/週/月線的最後一根本來就會「舊」一整天，用這個判準會恆為 False。
    #   ⚠ 一開始我改成「看最後一根的棒齡」，那是錯的判準：15m 的形成中那根本來就會
    #     「舊」到 15 分鐘 —— 實測 AAPL 15m（真即時）與 NQ=F 15m（延遲 11.9 分）棒齡一模一樣，
    #     完全分不出來。正確訊號是「**有沒有真的套到即時來源**」，而它早就存在：
    #     `_finnhub_overlay` 的第二個回傳值，只是原本被丟掉了。
    live = ((req.market == "crypto") or (req.market == "fx")
            or (req.market == "us" and locals().get("_us_live", False) and _us_market_open()))
    resp = {"live": live, "data": records}
    if req.market == "crypto":   # 同 /api/ohlcv：讓前端看得到來源，接合前先比對
        # ⚠ 用「跟著這份 df 一起記下來的」來源，不要在這裡現問 last_fetch_source()——
        #   它是 thread-local，走快取時回的是同一條執行緒上一個請求（可能是別的標的）的來源。
        if _crypto_src:
            resp["src"] = _crypto_src
    return resp


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


def _round_wr_floats(o):
    """勝率回應浮點瘦身：全部 round 到 8 位有效數字（相對誤差 <5e-9，顯示/下單/回測皆無感）。
    vwap 等全精度浮點（如 2030.54431503598→2030.5443）是回應體積的主要水分；
    在 get_crt_winrate 快取寫入前跑一次 → 快取即存瘦身版、之後命中零成本。
    順便把 np.float64 轉成原生 float（isinstance 涵蓋子類），對 orjson 序列化更穩。

    ⚠ 就地改寫、不重建容器（2026-08-03）：這支佔一次未快取勝率請求的 19.3%
      （wall-clock A/B：含 244.6ms、停用 197.4ms），而其中約兩成純粹花在替上萬個
      dict/list 配置新容器。改成 in-place 後同一份資料 11.6ms→9.0ms（−22%）。
      安全性：呼叫點的 result 是 _calc_crt_winrate 剛回傳的區域變數；退一步說，
      本函式做的事只是「把浮點收到 8 位有效數字」（相對誤差 <5e-9，本來就定義為無感），
      即使碰到共用物件也不會產生語意差異。
    ⚠ 浮點判定必須用 isinstance 不能用 `type(v) is float`：np.float64 是 float 的子類，
      用 type 比對會整批漏掉、原封不動流進 orjson。
    ⚠ 別為了「少一次格式化」而先用 repr 判斷長度：repr 本身就是一次格式化，實測更慢。"""
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, float):
                o[k] = float(f"{v:.8g}")
            elif isinstance(v, (dict, list)):
                _round_wr_floats(v)
        return o
    if isinstance(o, list):
        for i, v in enumerate(o):
            if isinstance(v, float):
                o[i] = float(f"{v:.8g}")
            elif isinstance(v, (dict, list)):
                _round_wr_floats(v)
        return o
    if isinstance(o, float):
        return float(f"{o:.8g}")
    return o


# 只後端(回測/自動交易)用、前端不讀的 per-signal 欄位 → 回前端 JSON 時砍掉
_WR_SLIM_DROP = frozenset({"est_r", "est_r_b", "rr", "rr_b", "rr_real", "rr_b_real"})
# S1~S12 已退役；SS 系列（ss1/ss2/ss3）2026-08-05 亦全面移除 → 不再回傳任何策略訊號給前端。
# 保留這個空集合而不是拆掉整條過濾：signals 這個欄位仍存在（前端與瘦身邏輯都吃它），只是恆為空。
_SS_KEEP_KEYS = frozenset()


_GIT_REV = None
def _git_rev():
    """ETag 摻 git 版號：部署後(瘦身/序列化邏輯可能變)舊 ETag 全數失效，永不 304 到跨版本殘影。"""
    global _GIT_REV
    if _GIT_REV is None:
        try:
            import main as _m
            _GIT_REV = str(getattr(_m, "_GIT_VER", "0"))
        except Exception:
            _GIT_REV = "0"
    return _GIT_REV


# ── 同鍵請求合併 single-flight ────────────────────────────────────────────────
#   同一份勝率同時被要求多次(背景預熱撞上使用者自己那次、兩個分頁、手機+桌機)時,原本會各算一遍
#   互搶 CPU：實測積極預熱時使用者那次 2485ms→4381ms。→ 第一個進來的當 leader 實際計算,
#   其餘 follower 等它算完(結果進快取)再走正常路徑 → 命中快取(~16ms)。
#   ・key 用「路由參數」組:它完整決定內部 cache_key(long_only 由 market 推導),不必複製內部鍵邏輯。
#   ・follower 等待有上限(_WR_SF_WAIT);逾時就自己算 → 最壞退化成現狀,不會卡住。
#   ・leader 一律在 finally 釋放(含例外)→ 不會有鎖漏掉導致後續全部等到逾時。
#   ・solve 模式不參與(語義不同、不共用快取)。
# 即時價單飛：同一把 key 同時 miss 時只讓一個人去抓上游，其他人等它（見 get_latest 的 crypto 分支）
_LATEST_SF_LOCK = _threading.Lock()
_LATEST_SF: dict = {}

_WR_SF_LOCK = _threading.Lock()
_WR_SF: dict = {}
_WR_SF_WAIT = 25.0


def _wr_sf_acquire(key):
    """回傳 (is_leader, event)。leader 負責算完後 _wr_sf_release。"""
    with _WR_SF_LOCK:
        ev = _WR_SF.get(key)
        if ev is not None:
            return False, ev
        ev = _threading.Event()
        _WR_SF[key] = ev
        return True, ev


def _wr_sf_release(key):
    with _WR_SF_LOCK:
        ev = _WR_SF.pop(key, None)
    if ev is not None:
        ev.set()


@router.get("/crt_winrate")
def crt_winrate_api(
    request: Request,
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
    band_ratio: float = 1.0,
    vw: int = 0,
    proto_min: float = 0.0005,
    no_proto_ms: int = 0,
    no_proto_break: int = 0,
    lite: str = "",
    warm: int = 0,
    base_h: str = "",
    skip: str = "",
):
    """/api/crt_winrate 路由：呼叫 get_crt_winrate(含快取) → 回前端時把 signals『瘦身』
    （拿掉只後端用的 est/rr 欄位 + 省略 None 值），省 ~40% 傳輸量、加快手機端載入。
    band_ratio：上下軌目標比例（1.0=上下軌；0.8=8成軌，HUD 切到 8成軌時前端帶此參數另抓一份）。
    vw：FVG/策略標記的近段窗根數（前端往歷史滑時加大→補算舊區標記；勝率統計不受影響）。
    ETag/304：結果帶內容指紋 _h(重算時算一次) → 同內容重看(同一根棒內切回標的、刷新)回 304
    幾乎零傳輸；前端 fetch 需用 cache:"no-cache"(存快取+每次驗證)。無 _h(舊快取/降級)則照常整包回。
    ⚠ 回測/自動交易是 Python 直接呼叫 get_crt_winrate → 拿『完整』signals，不受此瘦身影響。"""
    def _run():
        return get_crt_winrate(market, symbol, timeframe, exchange, stop_buffer_pct,
                               solve, solve_target, api_key, api_secret, finmind_token,
                               band_ratio=band_ratio, vw=vw, proto_min=proto_min,
                               no_proto_ms=bool(no_proto_ms), no_proto_break=bool(no_proto_break))

    if solve:
        wr = _run()                       # solve 語義不同、不共用快取 → 不參與合併
    else:
        _sf_key = (f"{market}|{symbol}|{exchange}|{timeframe}|{stop_buffer_pct}|{band_ratio}"
                   f"|{vw}|{proto_min}|{int(bool(no_proto_ms))}|{int(bool(no_proto_break))}")
        _leader, _ev = _wr_sf_acquire(_sf_key)
        if _leader:
            try:
                wr = _run()
            finally:
                _wr_sf_release(_sf_key)   # ★含例外一定釋放,否則後續 follower 全等到逾時
        else:
            _ev.wait(_WR_SF_WAIT)         # 等 leader 算完(結果已進快取)→ 自己再走一次=命中快取
            wr = _run()                   # 逾時也走這裡:最壞退化成「各自算」,不會卡住
    if solve or not isinstance(wr, dict):        # solve 模式非勝率結構 → 原樣回
        return wr
    # warm=1：只為了「把這個 vw 階梯算進快取」，不要整包回（前端往舊滑時預熱下一階用）。
    #   量測(2026-07-28)：同一 vw 冷算 ~2.5s、之後命中僅 16ms(gzip 82ms) → 使用者感受到的
    #   「越滑越久才出標記」幾乎全是「換 vw 階梯那一次冷算」。預先在背景付掉這 2.5s，
    #   使用者真的滑到時就是命中快取。回幾十 bytes → 預熱本身不吃頻寬（手機也安全）。
    if warm:
        return {"ok": True, "vw": vw, "n": len(wr.get("fvg") or [])}
    if lite == "ms":
        # 輕量模式(多圖迷你圖用)：只回 多空/破多空 標記陣列(幾KB vs 整包~190KB)。
        # 照樣吃 get_crt_winrate 快取(命中=毫秒級)；冷門標的首算仍要等(前端 async 補上)。
        # 只回近段各 250 筆：迷你圖只載 ~320 根 K,整包標記(vw=8000 可達數千筆/98KB)是浪費
        return _wr_resp({"fvg_ms": (wr.get("fvg_ms") or [])[-250:], "fvg_break": (wr.get("fvg_break") or [])[-250:]})
    _h = wr.get("_h")
    etag = f'W/"{_h}-{_git_rev()}"' if _h else None
    # ⚠ 帶 base_h（要差量）時不走 304：差量請求的 URL 與整包不同 → 瀏覽器沒有對應的快取 body，
    #   回 304 會讓 fetch 拿到空回應。差量本來就便宜，直接算。
    if etag and not base_h and request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})
    out = {k: v for k, v in wr.items() if k != "_h"}
    sigs = wr.get("signals")
    if sigs:
        # 策略訊號已全部退役（S1~S12 無 edge、SS 系列 2026-08-05 移除）→ 這裡恆為空清單。
        # fvg 為獨立 key，原樣保留。⚠ 回測走 Python 直呼 get_crt_winrate 拿完整 signals，不受此處影響。
        out["signals"] = [{k: v for k, v in s.items() if v is not None and k not in _WR_SLIM_DROP}
                          for s in sigs if s.get("k") in _SS_KEEP_KEYS]
    out = _wr_slim(out)                       # 先瘦身成「送出形態」，差量才是對前端手上那份做的
    # ★「沒在顯示的圖層就不送」（2026-07-31）：這些圖層前端只有在對應開關打開時才會畫，而
    #   它們預設全是關的 —— 教練疊加層(smc_*/channel)、VWAP、關鍵高低(pd_ranges)。實測 BTC 1h
    #   一份回應 533KB 裡它們佔 259KB(49%)，等於預設情況下有一半的傳輸從頭到尾沒被用到。
    #   前端在 fetch 時把「目前用不到的」列進 skip；任何圖層被打開時前端會發現快取裡缺這個 key
    #   → 自動重抓一次完整的。
    # ⚠ 只做在這個 HTTP 邊界，不能做進 crt.py —— notify_monitor 直接呼叫 get_crt_winrate 餵
    #   自動交易，那條路徑必須永遠拿到完整內容。
    # ⚠ 指紋要跟著 skip 走：_h 是「內容」的指紋，但送出去的形態現在依 skip 而不同。若不區分，
    #   不同 skip 的客戶端會共用同一個 _h → ETag 回錯的 304、差量索引拿到別種形態的 base。
    _skip = {s for s in (skip or "").replace(" ", "").split(",") if s} & _WR_SKIPPABLE
    if _skip:
        out = {k: v for k, v in out.items() if k not in _skip}
    _h_eff = (_h + "." + ",".join(sorted(_skip))) if (_h and _skip) else _h
    if _h_eff:
        etag = f'W/"{_h_eff}-{_git_rev()}"'
        if not base_h and request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-cache"})
        out["_h"] = _h_eff                    # 前端存起來，下次升階當 base_h 用
        _wr_hidx_put(_h_eff, out)             # 登記雜湊索引（下一階要拿它算差量）
    if base_h and base_h != _h_eff:
        d = _wr_build_delta(base_h, out, _h_eff)
        if d is not None:
            return _wr_resp(d, slim=False, no_store=True)
    return _wr_resp(out, etag, slim=False)


# ── 勝率回應「線材瘦身」（只在 HTTP 邊界做，核心 _calc_crt_winrate 的回傳一律不動）──────
#   ★為什麼一定要在這層做（2026-07-28 差點踩到）：`notify_monitor` 是直接呼叫 _calc_crt_winrate 拿
#   結果餵自動交易/推播的（notify_monitor.py:221 拿 res["fvg"] → place_fvg_limit_ladder 讀
#   gap.get("sweep") 做 sweepBoost、gap.get("t") 做已了結防呆）。若在 crt.py 就把欄位砍掉/把時間戳
#   換成整數，會**靜默弄壞下單邏輯**。故：核心回傳保持完整，只有送瀏覽器的這一份瘦身。
#   ⚠ 同理不可就地改動（payload 內的 list/dict 可能是被快取、且被伺服器端共用的物件）→ 一律建新物件。
#
#   量測（BTC 15m vw=45000，整包 5.46MB、快取命中仍要 1.9s）：
#     ① fvg 佔 63.7%（10976 筆 × 332B）→ 砍前端 0 引用欄位(gi/sweep)、省略 False 布林、
#        ett/etm/etb 等於 t2 時省略（實測 44% 全等）→ 單筆 332→224B
#     ② 時間戳 ISO 字串是各鍵最大單項（vwap 60%、smc_sweep 69%、signals 三個合計 52%）
#        → 轉 epoch 秒整數（21B→10B）。前端 toTime() 已同時吃字串與數字（utils.js）。
_WR_EPOCH_KEYS = ("t", "t2", "t0", "t1", "ot", "ot_b", "et", "xt", "ett", "etm", "etb",
                  "tp1t", "tp2t", "tp3t", "tp4t", "slt")
_WR_LIST_KEYS = ("fvg", "signals", "fvg_ms", "fvg_break", "fvg_shun", "fvg_special",
                 "fvg_trades", "smc_sweep", "smc_struct", "smc_ob", "smc_sr", "vwap")


def _wr_ep(v):
    """ISO 字串 → epoch 秒整數；非字串/解析失敗 → 原樣（冪等，重複套用安全）。"""
    if not isinstance(v, str) or len(v) < 10:
        return v
    try:
        return int(_dt.datetime.fromisoformat(v).replace(tzinfo=_dt.timezone.utc).timestamp())
    except Exception:
        return v


def _wr_slim_row(k, z):
    """單筆瘦身（回傳新 dict，不動原物件）。"""
    if not isinstance(z, dict):
        return z
    y = dict(z)
    if k == "fvg":
        y.pop("gi", None); y.pop("sweep", None)        # 前端 grep 0 引用（伺服器端仍拿得到完整版）
        # ★pens（每次被突破的點位）同理，而且是最大的一塊：實測 BTC 1h vw=45000
        #   整包 3214KB 裡 pens 就佔 378KB（11.8%）、13,027 個點。
        #   charts.js 明確寫著「『吃到 FVG 的點位』(pens 突破菱形) 使用者要求隱藏 → 不再畫」，
        #   全前端對 .pens 的讀取只剩「把它對映進 zone 物件」那兩行，對映完再也沒人讀 →
        #   算了、轉了時間戳、壓縮了、傳了、parse 了，然後丟掉。
        #   ⚠ 只在這層拿掉：notify_monitor 直接吃 _calc_crt_winrate 的結果餵自動交易，
        #     核心那份必須保持完整（見本區塊開頭的說明）。
        y.pop("pens", None)
        for b in ("go", "gv", "dim", "inv", "gap"):
            if y.get(b) is False:                       # 前端是 `z.go === true` / `!!z.dim` → 缺鍵=false
                y.pop(b, None)
        if y.get("used") is True:                       # ⚠ 前端 `z.used !== false`（預設 true）→ 只省 True
            y.pop("used", None)
        _t2 = y.get("t2")
        for e in ("ett", "etm", "etb"):
            if e in y and y[e] == _t2:                  # ⚠ 只省「等於 t2」；明確 null(沒觸及)必須照送
                del y[e]
    for tk in _WR_EPOCH_KEYS:
        if tk in y:
            y[tk] = _wr_ep(y[tk])
    # （pens 已在上面 fvg 分支整個拿掉 → 不再需要逐點轉時間戳，順帶省下這段 CPU）
    _f = y.get("fills")
    if isinstance(_f, list):
        y["fills"] = [([_wr_ep(e[0]), *e[1:]] if isinstance(e, (list, tuple)) and e else
                       (_wr_ep(e) if isinstance(e, str) else e)) for e in _f]
    return y


def _wr_slim(payload):
    """整包瘦身：只重建需要動的那幾個 list，其餘鍵沿用原物件（零複製）。"""
    if not isinstance(payload, dict):
        return payload
    try:
        out = dict(payload)
        for k in _WR_LIST_KEYS:
            v = out.get(k)
            if isinstance(v, list) and v:
                out[k] = [_wr_slim_row(k, z) for z in v]
        return out
    except Exception:
        return payload   # 瘦身失敗照原樣送（功能優先）


def _wr_resp(payload, etag=None, slim=True, no_store=False):
    """勝率大回應（1MB+）直接回 ORJSONResponse：跳過 FastAPI 的 jsonable_encoder 整棵樹走訪
    （這一步在快取命中路徑占大頭），序列化交給 orjson。缺 orjson 時原樣回 dict（走預設路徑）。
    內容已在 get_crt_winrate 快取前經 _round_wr_floats 轉純原生型別 → orjson 可直接序列化。
    etag 有值時附 ETag + no-cache(=可存但每次驗證) → 讓瀏覽器下次帶 If-None-Match。
    slim=False：payload 已瘦身過（差量路徑先瘦身才能算 ops）→ 不重複跑。
    no_store：差量回應是「相對某個 base」的，絕不可被瀏覽器/中介快取當成完整結果重用。"""
    hdrs = None
    if no_store:
        hdrs = {"Cache-Control": "private, no-store"}
    elif etag:
        hdrs = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if slim:
        payload = _wr_slim(payload)      # 線材瘦身（只影響送出去的這份，見上方註解）
    if _orjson is not None:
        return _json_resp(payload, headers=hdrs)
    return payload


# ── 升階「範圍化補抓」：vw 換階時只回差量 ────────────────────────────────────────
#   往歷史滑 → vw 8000→20000→45000。每一階都把「同一批近段標記」整包重傳一次：實測 BTC 5m
#   8000→20000 整包 gzip 470KB，其中近段那 8000 根的標記前端**早就有了**。
#   → 前端帶 base_h（它手上那份的內容指紋），後端把新舊兩份逐筆比對，只送「真正不一樣的筆數」
#     ＋一串「沿用舊的第 i~j 筆」指令。實測省 57~67% 傳輸（470→156KB / 823→355KB），
#     算差量 19~36ms。
#   ★為什麼可以「逐筆沿用」而不是「只接新露出的那段」：實測窗變大時，重疊區的標記**不是**原封不動
#     （fvg_ms 這種要吃更早的 setup FVG，差異散到 5800 根深）。純接尾巴會少 0.7% 標記且無從察覺 →
#     一律走「後端拿新舊兩份逐筆 diff」，內容由後端保證正確，前端只做拼接。
#   ★安全網：後端算完 ops 後，先用 ops 把舊的雜湊序列重建一次，比對必須逐筆等於新的雜湊序列；
#     不符就整包回。→ diff 有 bug 只會退化成「沒省到頻寬」，永遠不會送出錯的標記。
#   ・只存「每筆的雜湊」不存內容（copy 指令用索引、literal 取自新的那份）→ 一份索引約 100~200KB，
#     上限 16 份；換實例/被淘汰 → 找不到 base_h → 整包回（前端本來就吃兩種回應）。
# 「沒在顯示就不送」的可省略圖層（前端依當下開關決定要不要列進 skip）。
#   ・smc_sweep/smc_struct/smc_ob/smc_sr/channel：只在 _drawCoachOverlay 內畫，由 window._coachOn
#     控制（掃蕩標記也一樣，見 render.js 的 `window._coachOn ? lastSMCSweepMarkers : []`）。預設關。
#   ・vwap：由 window._vwapOn 控制，且前端還有自算版本優先。預設關。
#   ・pd_ranges：由 window._pdOn 控制。預設關。
# ⚠ 白名單制：只有列在這裡的 key 允許被省略 —— 前端就算送了別的名字也不會生效，
#   免得哪天誤傳把 fvg/signals 這種主體砍掉。
# ★signals（SS1/SS2 反轉訊號標記）2026-08-03 加入：它是回應裡第二大的一塊，
#   而且**是唯一值多的資料，gzip 壓不掉** —— 實測不送它 gzip 607KB → 493KB（省 19%）。
#   前端有「一鍵隱藏訊號標記」按鈕（wrSignalsToggleBtn），隱藏時這 114KB 完全用不到。
#   ⚠ 與其他幾個不同：signals **預設是顯示的** → 只有主動關掉的人才省得到，
#     這是有意的（不能為了省流量而讓預設看不到東西）。
_WR_SKIPPABLE = frozenset({"smc_sweep", "smc_struct", "smc_ob", "smc_sr",
                           "channel", "vwap", "pd_ranges", "signals"})

_WR_DELTA_KEYS = ("fvg", "signals", "fvg_ms", "fvg_break", "fvg_shun", "fvg_special",
                  "fvg_trades", "smc_sweep", "smc_struct", "smc_ob", "smc_sr", "vwap",
                  "fvg_bb", "fvg_bb_a", "fvg_bb_m", "fvg_sigs")
_WR_HIDX: "_collections.OrderedDict" = _collections.OrderedDict()   # _h → {key: [每筆雜湊]}
_WR_HIDX_MAX = 16
_WR_HIDX_LOCK = _threading.Lock()


_WR_HW = 16   # 每筆摘要位元組數（128-bit）


def _wr_hash_index(payload: dict) -> dict:
    """把回應中的各 list 轉成「所有筆的 128-bit 摘要接成一條 bytes」。
    ⚠ 兩個都不能省：
      ① 別存原始 JSON bytes——BTC 5m vw45000 的 fvg 13000+ 筆 × ~220B ≈ 3MB／份 × 24 份 = 70MB。
      ② 別存 list[bytes]——每個 bytes 物件光 Python 開銷就 ~49B，比 16B 的內容還大（總量 4x）。
      接成一條 blob 後：最大一份實測 537KB(BTC 5m vw45000)、16 份最壞 ~8.6MB，Railway 吃得下。
    128-bit 對一萬多筆的碰撞機率 ~1e-30；碰撞是「沿用到不同內容」的唯一失效路徑，這個量級可忽略。"""
    import orjson as _oj
    from hashlib import blake2b as _bb
    idx = {}
    for k in _WR_DELTA_KEYS:
        v = payload.get(k)
        if isinstance(v, list):
            idx[k] = b"".join(_bb(_oj.dumps(z, option=_oj.OPT_SORT_KEYS, default=str),
                                  digest_size=_WR_HW).digest() for z in v)
    return idx


def _wr_hidx_put(h: str, payload: dict):
    if not h:
        return
    with _WR_HIDX_LOCK:
        if h in _WR_HIDX:
            _WR_HIDX.move_to_end(h)
            return
    try:
        idx = _wr_hash_index(payload)
    except Exception:
        return
    with _WR_HIDX_LOCK:
        _WR_HIDX[h] = idx
        _WR_HIDX.move_to_end(h)
        while len(_WR_HIDX) > _WR_HIDX_MAX:
            _WR_HIDX.popitem(last=False)


def _wr_hidx_get(h: str):
    if not h:
        return None
    with _WR_HIDX_LOCK:
        idx = _WR_HIDX.get(h)
        if idx is not None:
            _WR_HIDX.move_to_end(h)
        return idx


def _wr_list_ops(old_blob: bytes, new_l: list, new_blob: bytes):
    """新清單相對舊清單的重建指令：[0, start, len]=沿用舊的這段、[1, [筆…]]=直接送內容。
    貪婪延長連續段（標記本就時間排序、大段是原封不動的）→ ops 數量極少（實測 1~24 條）。
    old_blob/new_blob 是 _wr_hash_index 打包的摘要條，第 i 筆 = blob[i*W:(i+1)*W]。"""
    W = _WR_HW
    n_old = len(old_blob) // W
    pos = {}
    for i in range(n_old):
        h = old_blob[i * W:(i + 1) * W]
        if h not in pos:
            pos[h] = i          # 只記第一次出現：連續延長會自然吃掉後續
    ops = []
    lit = []
    cs = -1
    cl = 0
    cur = -1

    def _flush_copy():
        nonlocal cs, cl
        if cl:
            ops.append([0, cs, cl]); cs = -1; cl = 0

    def _flush_lit():
        nonlocal lit
        if lit:
            ops.append([1, lit]); lit = []

    for j in range(len(new_blob) // W):
        h = new_blob[j * W:(j + 1) * W]
        if cl and cur + 1 < n_old and old_blob[(cur + 1) * W:(cur + 2) * W] == h:
            cur += 1; cl += 1; continue        # 延長目前的沿用段
        i = pos.get(h)
        if i is not None:
            _flush_copy(); _flush_lit()
            cs = i; cl = 1; cur = i
        else:
            _flush_copy(); lit.append(new_l[j])
    _flush_copy(); _flush_lit()
    return ops


def _wr_build_delta(base_h: str, payload: dict, new_h: str):
    """成功回差量 dict、無法/不划算回 None（呼叫端整包回）。payload 必須是『已瘦身』的送出形態。"""
    old_idx = _wr_hidx_get(base_h)
    if not old_idx:
        return None
    try:
        import orjson as _oj
        from hashlib import blake2b as _bb
        new_idx = _wr_hash_index(payload)
    except Exception:
        return None
    out = {"_d": 1, "_base": base_h}
    if new_h:
        out["_h"] = new_h
    ops_map = {}
    saved = 0
    for k, v in payload.items():
        if k in _WR_DELTA_KEYS and isinstance(v, list) and k in old_idx and k in new_idx:
            ops = _wr_list_ops(old_idx[k], v, new_idx[k])
            # ★安全網：用 ops 重建摘要條，必須逐位元等於新的那條 → 不符就這個 key 整包送
            W = _WR_HW
            rec = []
            for op in ops:
                rec.append(old_idx[k][op[1] * W:(op[1] + op[2]) * W] if op[0] == 0 else
                           b"".join(_bb(_oj.dumps(z, option=_oj.OPT_SORT_KEYS, default=str),
                                        digest_size=W).digest() for z in op[1]))
            if b"".join(rec) == new_idx[k]:
                nb = len(_oj.dumps(v, default=str))
                db = len(_oj.dumps(ops, default=str))
                if db < nb * 0.75:            # 省不到 25% 就別繞這一圈（省下前端拼接）
                    ops_map[k] = ops; saved += nb - db
                    continue
        out[k] = v
    if not ops_map or saved < 50000:          # 整體省不到 ~50KB → 直接整包，維持路徑單純
        return None
    out["_ops"] = ops_map
    return out


# ── SR+SMC 多空教練（多時框步驟狀態機）────────────────────────────────────────
#   Round1：抓 4H/1H/15M/日 → 各時框 SMC 快照 → 方向/主方向/市場位置/1H通道（面板頂部）。
#   步驟 1～8 狀態機於後續 round 疊加。
_COACH_TF_DAYS = {"1d": 320, "4h": 60, "1h": 20, "15m": 7}
# 低時框版（tfset=fast）：整組往下移一級＝4h(頂/方向)→1h(高HTF)→15m(低HTF)→5m(執行)。判斷邏輯完全沿用。
_COACH_TF_DAYS_FAST = {"4h": 60, "1h": 20, "15m": 7, "5m": 3}
# 角色→(頂顯示, 高HTF=方向+區, 低HTF=區, 執行, 高HTF標籤, 低HTF標籤)
_COACH_ROLES = {
    "default": ("1d", "4h", "1h", "15m", "4H", "1H"),
    "fast":    ("4h", "1h", "15m", "5m", "1H", "15M"),
}


# 教練純計算 helper 已抽到 routes/coach_calc.py（純函式、零耦合）→ 匯入沿用，既有 import 路徑不變
from routes.coach_calc import (_coach_pos_in_channel, _coach_nearest_htf_zone,
                               _coach_tp_list, _coach_all_named, _coach_current_zone)


@router.get("/smc_coach")
def smc_coach_api(
    market: str,
    symbol: str,
    exchange: str = "pionex",
    api_key: str = "",
    api_secret: str = "",
    finmind_token: str = "",
    tfset: str = "default",
    closed: int = 0,
):
    """SR+SMC 多空教練面板資料（多時框）。tfset=default(1d/4h/1h/15m) 或 fast(4h/1h/15m/5m)；判斷邏輯相同。

    closed=1（掃描器/推播用）：①只用「已收盤」K 棒判斷——丟掉最後一根未收盤棒，避免盤中影線掃蕩/MSS
    成立又消失 → 推了「可進場」點進去卻沒了（與訊號通知的收盤確認原則一致）；②K 棒走 coach 專用短 TTL
    快取——default/fast 共用的 4h/1h/15m 只抓一次、連續掃描也重用（60 檔×兩版 480 請求 → ~300）。
    面板（closed=0）行為完全不變：即時抓、含未收盤棒＝「當下狀態」。"""
    from utils import smc
    _tfset = tfset if tfset in _COACH_ROLES else "default"
    _TFS = _COACH_TF_DAYS_FAST if _tfset == "fast" else _COACH_TF_DAYS
    _top_tf, _hh_tf, _hl_tf, _ex_tf, _hh_lbl, _hl_lbl = _COACH_ROLES[_tfset]
    _ex_lbl = _ex_tf.upper()   # 執行時框標籤(default:15M／fast:5M)
    ck = f"smc_coach:{market}:{symbol}:{exchange}:{_tfset}:{1 if closed else 0}"
    cached = coach_cache.get(ck, ttl=10)      # 教練走自己的快取（見 utils/cache.py 說明）
    if cached:
        return cached
    # 4 個時框平行抓取（各僅 1 window/1 請求 → 並行安全、不觸限流）：序列 ~520ms → 並行 ~150ms。
    #   狀態機純計算僅 ~23ms，瓶頸全在網路抓取，故並行是主要加速手段。fetch 內走 I/O 會放開 GIL。
    from concurrent.futures import ThreadPoolExecutor as _TPE
    dfs = {}; snaps = {}
    def _coach_load(item):
        tf, days = item
        try:
            # K 棒共用短快取：常駐暖掃(每2分)已把前60檔全部時框抓好 → 面板點進去直接命中(毫秒級,
            # 原本要重抓4~5個時框 ~5秒)。代價=執行時框最舊 ~100s,教練看的是結構、現價另走每秒 ticker,可接受。
            dk = f"coach_df:{market}:{symbol}:{exchange}:{tf}:{days}"
            # TTL 按時框分層:高時框結構一根棒才變一次,不必每輪重抓 → 暖掃每輪只真抓 5m/15m,權重大降
            _dttl = {"5m": 30, "15m": 60, "1h": 300, "4h": 600, "1d": 900}.get(tf, 100)
            d = coach_cache.get(dk, ttl=_dttl)
            if d is None:
                d = fetch_crt_df(market, symbol, tf, days, exchange, api_key, api_secret, finmind_token)
                coach_cache.set(dk, d)
            if closed:
                _iv = _CRT_IV.get(tf)
                if _iv and len(d) >= 30:
                    # 資料源時間為 UTC naive；最後一根「開盤+週期 > 現在」＝未收盤 → 丟掉（只用已收盤棒）
                    _last = pd.Timestamp(d["time"].iloc[-1]).timestamp()
                    if _last + _iv > time.time():
                        d = d.iloc[:-1]
            return tf, d, smc.snapshot(d)
        except Exception:
            return tf, None, None
    # ⚠ 池裡的 worker 不會繼承 thread-local 的背景標記 → 一定要傳下去（見 crypto.is_background 註）
    from data.crypto import mark_background as _mbg, is_background as _isbg
    with _TPE(max_workers=len(_TFS), initializer=_mbg, initargs=(_isbg(),)) as _pool:
        for tf, d, sn in _pool.map(_coach_load, list(_TFS.items())):
            dfs[tf] = d; snaps[tf] = sn
    # 角色別名：頂(顯示)/高HTF(方向+區)/低HTF(區)/執行 → 沿用原 s1d/s4h/s1h/s15 變數名，其餘判斷不改。
    s1d, s4h, s1h, s15 = snaps.get(_top_tf), snaps.get(_hh_tf), snaps.get(_hl_tf), snaps.get(_ex_tf)
    _df_hh, _df_hl, _df_ex = dfs.get(_hh_tf), dfs.get(_hl_tf), dfs.get(_ex_tf)
    t4 = s4h["trend"] if s4h else 0
    t1 = s1h["trend"] if s1h else 0
    td = s1d["trend"] if s1d else 0
    direction = 1 if t4 == 1 else (-1 if t4 == -1 else 0)   # 主方向＝高HTF(default:4H／fast:1H)趨勢
    price = (s15 or s4h or {}).get("price")
    # 忠實狀態機：把 高/低HTF 算成逐棒 series → 對齊每根執行時框(request.security 復刻)+失效退階。
    if direction != 0 and _df_ex is not None:
        try:
            _ser4 = smc.htf_series(_df_hh)
            _ser1 = smc.htf_series(_df_hl)
            # 對齊 TV：最後一根「未收盤」棒只允許觸碰類判定(closed=1 已丟掉未收盤棒 → 恆為 False)
            _forming = False
            if not closed and len(_df_ex):
                _ivx = _CRT_IV.get(_ex_tf)
                if _ivx:
                    _forming = pd.Timestamp(_df_ex["time"].iloc[-1]).timestamp() + _ivx > time.time()
            coach = smc.run_coach2(_df_ex, _ser4, _ser1, direction, forming_last=_forming)
        except Exception:
            coach = {"stage": 0}
    else:
        coach = {"stage": 0}
    # 市場位置：目前價格所在的區（任一時框任一類型，取最貼近者）
    zone = _coach_current_zone(s4h, s1h, price)
    st = coach.get("stage", 0)
    _dn = "多" if direction == 1 else ("空" if direction == -1 else "")
    _fmt = lambda v: "—" if v is None else (f"{v:.0f}" if abs(v) >= 1000 else f"{v:.4f}")
    _rng = lambda a, b: "—" if a is None or b is None else f"{_fmt(min(a,b))} ~ {_fmt(max(a,b))}"
    # 掃蕩目標：空單掃前高、多單掃前低（尚未被破的最近擺點）
    _tg = (s15.get("targets") if s15 else None) or {}
    _swt = _tg.get("sh") if direction == -1 else _tg.get("sl")
    _tps_all = _coach_tp_list([s1h, s4h], direction, price, n=4) if (direction != 0 and price is not None) else []
    steps = [
        {"n": 1, "title": "方向", "done": st >= 1,
         "text": (f"方向通過｜{_hh_lbl} 主{_dn}" if direction != 0 else f"等待 {_hh_lbl} 確認主方向")},
        {"n": 2, "title": "區域", "done": st >= 2,
         "text": (f"已進入{_dn}方區｜{coach.get('zone_name') or (_hh_lbl+'/'+_hl_lbl+' '+_dn+'方區')} {_rng(coach.get('zone_top'), coach.get('zone_bot'))}" if st >= 2
                  else f"等待價格進入 {_hh_lbl}/{_hl_lbl} {_dn}方訂單區／缺口／區")},
        {"n": 3, "title": "掃蕩", "done": st >= 3,
         "text": (f"已掃過前{'低' if direction==1 else '高'}｜{_fmt(coach.get('sweep_px'))}" if st >= 3
                  else f"等待掃過前{'低' if direction==1 else '高'}｜目標 {_fmt(_swt)}")},
        {"n": 4, "title": "轉向", "done": st >= 4,
         "text": (f"MSS 完成｜確認價 {_fmt(coach.get('mss_px'))}" if st >= 4
                  else (f"等待 15M 收盤{'站上' if direction==1 else '跌破'} MSS 確認價 {_fmt(coach.get('mss_px'))}" if st == 3
                        else "等待掃蕩後轉向 (MSS)"))},
        {"n": 5, "title": "延續", "done": st >= 5,
         "text": (f"{_dn}方 BOS 完成｜{_fmt(coach.get('bos_px'))}" if st >= 5
                  else f"等待形成{_dn}方延續{'高' if direction==1 else '低'}點")},
        {"n": 6, "title": "掛單＋反應K", "done": st >= 6,
         "text": (f"{_dn}單掛單區 {_rng(coach.get('entry_top'), coach.get('entry_bot'))}｜來源：{coach.get('entry_name') or _ex_lbl+' '+_dn+'方缺口'}｜等待盤中觸碰" if st >= 6
                  else f"等待新的 {_ex_lbl} {_dn}方訂單區／缺口形成")},
        {"n": 7, "title": "進場條件完成", "done": st >= 7,
         "text": ("步驟 7 完成｜已觸碰掛單區，請設定持倉" if st >= 7 else "步驟 7 尚未完成｜等待盤中觸碰掛單區")},
        {"n": 8, "title": "持倉離場管理", "done": st >= 7,
         "text": (f"可進場｜依 TP1~TP{len(_tps_all)}／SL 離場（{_ex_lbl} 圖已畫計畫線）" if (st >= 7 and _tps_all)
                  else ("可進場｜請設定持倉、依 TP/SL 離場" if st >= 7 else "等待步驟7完成後進入持倉離場管理（TP1~TP4/SL）"))},
    ]
    # HTF 投影區（1H/4H 的 OB/FVG/SR）：給前端在低時框圖上畫，對齊 Pine f_htfVisibleZones。
    htf_zones = []
    for snap, tfn in ((s4h, _hh_lbl), (s1h, _hl_lbl)):
        if not snap:
            continue
        for side, dl, dv in (("l", "多", "l"), ("s", "空", "s")):
            for z in (snap.get("ob") or {}).get(side, []):
                htf_zones.append({"top": z["top"], "bot": z["bot"], "t0": z.get("t0"), "name": f"{tfn} {dl}OB", "kind": "ob", "dir": dv})
            for z in (snap.get("fvg") or {}).get(side, []):
                htf_zones.append({"top": z["top"], "bot": z["bot"], "t0": z.get("t0"), "name": f"{tfn} {dl}缺口", "kind": "fvg", "dir": dv})
        for k, kl, dv in (("res", "阻力", "s"), ("sup", "支撐", "l")):
            for z in (snap.get("sr") or {}).get(k, []):
                htf_zones.append({"top": z["top"], "bot": z["bot"], "t0": z.get("t0"), "name": f"{tfn} {kl}", "kind": "sr", "dir": dv})
    # HTF 投影通道（4H 靛/1H 青，各自 anchor→右，涵蓋範圍對齊 TV）
    htf_channels = []
    for snap, tfn in ((s4h, _hh_lbl), (s1h, _hl_lbl)):
        ch = (snap or {}).get("channel")
        if ch and ch.get("t1"):
            htf_channels.append({"tf": tfn, "dir": ch["dir"], "t1": ch["t1"], "t2": ch["t2"],
                                 "lo1": ch["lo1"], "lo2": ch["lo2"], "up1": ch["up1"], "up2": ch["up2"]})
    # 進度：最後完成步驟 + 下一個等待項（對齊 TV「已進入…｜等待…」）
    _done = [s for s in steps if s["done"]]
    _wait = [s for s in steps if not s["done"]]
    prog = (_done[-1]["text"] if _done else steps[0]["text"])
    if _wait:
        prog += "｜" + _wait[0]["text"].split("｜")[0]
    # 交易計畫預覽（步驟8：非互動；進場區=掛單區或HTF區、停損=掃蕩極值外、止盈=反向最近HTF區）
    plan = None
    if direction != 0 and price is not None:
        if st >= 6 and coach.get("entry_top") is not None:
            e_top, e_bot = coach["entry_top"], coach["entry_bot"]
        elif st >= 2 and coach.get("zone_top") is not None:
            e_top, e_bot = coach["zone_top"], coach["zone_bot"]
        else:
            e_top = e_bot = None
        swp = coach.get("sweep_px")
        sl = swp if swp is not None else (e_bot if direction == 1 else e_top)
        tps = _tps_all                                           # TP1～TP4：1H/4H 支撐阻力近→遠(上方已算)
        tp = tps[0] if tps else None                              # tp 保留(最近的)＝相容舊前端
        if e_top is not None or sl is not None or tps:
            plan = {"entry": ([e_bot, e_top] if e_top is not None else None), "sl": sl, "tp": tp, "tps": tps}
    out = {
        "ok": True, "symbol": symbol, "price": price,
        "direction": direction, "stage": st,
        "dir_text": ((f"{_dn}單主軸｜同向{_dn}方推進" if t4 == t1 else f"{_dn}單主軸｜{_hh_lbl} {smc_trend_txt(t4)}｜{_hl_lbl} {smc_trend_txt(t1)}") if direction != 0 else f"等待 {_hh_lbl} 主方向"),
        "progress": prog,
        "trend": {_top_tf: td, _hh_tf: t4, _hl_tf: t1},
        "tfset": _tfset,
        "market_pos": zone,
        "channel_1h": _coach_pos_in_channel(s1h["channel"] if s1h else None, price),
        "position_status": "無持倉",
        "plan": plan,
        "bos_time": coach.get("bos_time"),   # 步驟5(BOS)達成時間 → 前端主圖標記
        "htf_zones": htf_zones,
        "htf_channels": htf_channels,
        "steps": steps,
    }
    coach_cache.set(ck, out)
    return out


_coach_scan_bg_lock = threading.Lock()
_coach_scan_inflight: set = set()


def _coach_scan_compute(market, exchange, n, tfset, min_stage, ck):
    """教練掃描本體：跑完寫入 ck 快取並回傳。closed=1＝只認「已收盤棒」判斷(丟掉最後一根未收盤棒)：
    未收盤那根影線掃出的 BOS 不算數，要收盤確認 stage 才列出 → 點進去不會「剛才有 5、現在退回 3」。
    代價：最多晚半根棒(執行時框 15m/5m)才列，且清單 stage 會比 closed=0 面板保守。使用者要「確認有5」故選此。"""
    from concurrent.futures import ThreadPoolExecutor as _TPE
    from routes.trade import top_crypto_universe
    if market == "crypto":
        syms = [s["symbol"] for s in (top_crypto_universe(n) or [])]
    else:
        syms = []
    _sets = ["default", "fast"] if tfset == "both" else [tfset if tfset in _COACH_ROLES else "default"]

    def _scan_one(sym):
        hits = {}
        for _ts in _sets:
            try:
                d = smc_coach_api(market, sym, exchange, tfset=_ts, closed=1)   # closed=1=只認已收盤棒(收盤確認,不 repaint)
                if d.get("ok") and d.get("stage", 0) >= min_stage:
                    hits[_ts] = {"stage": d["stage"], "direction": d["direction"],
                                 "plan": d.get("plan"), "price": d.get("price")}
            except Exception:
                pass
        return sym, hits

    results = []
    if syms:
        from data.crypto import mark_background as _mbg, is_background as _isbg
        with _TPE(max_workers=6, initializer=_mbg, initargs=(_isbg(),)) as _pool:   # 併發6標的；背景標記要傳進池子
            for sym, hits in _pool.map(_scan_one, syms):
                if hits:
                    results.append({"symbol": sym, "hits": hits,
                                    "top_stage": max(h["stage"] for h in hits.values())})
    results.sort(key=lambda r: -r["top_stage"])
    out = {"ok": True, "scanned": len(syms), "min_stage": min_stage,
           "results": results, "asof": time.time()}
    if syms:                       # universe 抓不到(418封禁/暖機)＝掃了個空 → 不寫快取,下次請求直接重試
        coach_cache.set(ck, out)
    return out


def _live_fut_price(sym: str):
    """'BTC/USDT.P' → ticker worker 記憶體現價（每秒更新，零請求成本）；找不到回 None。
    用 display 匹配——Binance 源 symbol='BTCUSDT'、Pionex fallback 源 symbol='BTC_USDT_PERP'，
    但兩種源的 display 都是 'BTC/USDT.P'（掃描器的 symbol 格式），穩定一致。"""
    try:
        from utils import live_data
        key = sym.upper()
        norm = sym.replace(".P", "").replace("/", "").upper()   # 'BTCUSDT'（Binance 源備援）
        for t in live_data.get("futures"):
            if (t.get("display") or "").upper() == key or t.get("symbol") == norm:
                return t.get("price")
    except Exception:
        pass
    return None


def _filter_at_entry(results, tol=0.001, near=0.03):
    """留「現價此刻在掛單區內(±tol，near_pct=0)」或「距區緣 ≤near(標 near_pct%)」的命中。
    掛單區(結構)變化慢、現價變化快 → 快取存未過濾命中(結構)，回應當下用每秒 ticker 現價過濾＝真正即時。
    「接近」層是給限價掛單提前準備用——near 太嚴(1%)實測大部分時間整欄空白、看起來像壞掉，
    放 3% 讓清單常有幾檔可看，靠「近x%」距離標示+排序分辨遠近；推播仍只推區內(near_pct=0)。
    ★「還沒到 TP1」關卡：使用者只要「現在還掛得上單、進得了場」的——現價已達第一止盈(多單 px≥TP1、
    空單 px≤TP1)＝行情已走掉、進場是追高殺低，直接剔除；沒 TP1 資料則不擋。"""
    out = []
    for r in results or []:
        px = _live_fut_price(r["symbol"])
        if px is None:
            continue
        hits = {}
        for ver, h in (r.get("hits") or {}).items():
            plan = h.get("plan") or {}
            ent = plan.get("entry")
            if not ent or len(ent) < 2 or ent[0] is None or ent[1] is None:
                continue
            # 還沒到 TP1 才算「可進場掛單」（多單現價未達TP1、空單未跌破TP1）
            _tps = plan.get("tps") or ([plan.get("tp")] if plan.get("tp") is not None else [])
            _tp1 = _tps[0] if _tps else None
            _dir = h.get("direction")
            if _tp1 is not None and ((_dir == 1 and px >= _tp1) or (_dir == -1 and px <= _tp1)):
                continue
            lo, hi = min(ent), max(ent)
            if lo * (1 - tol) <= px <= hi * (1 + tol):
                hits[ver] = {**h, "px": px, "near_pct": 0}          # 區內＝進場中
            else:
                _d = min(abs(px - lo), abs(px - hi)) / px
                if _d <= near:
                    hits[ver] = {**h, "px": px, "near_pct": round(_d * 100, 2)}   # 接近(給提前掛單)
        if hits:
            out.append({"symbol": r["symbol"], "hits": hits,
                        "top_stage": max(h["stage"] for h in hits.values()),
                        "min_near": min(h["near_pct"] for h in hits.values())})
    out.sort(key=lambda r: (r["min_near"], -r["top_stage"]))   # 區內在前、越接近越前
    return out


def _coach_scan_spawn_bg(market, exchange, n, tfset, min_stage, ck):
    """背景重掃（inflight 防重複）。"""
    with _coach_scan_bg_lock:
        if ck in _coach_scan_inflight:
            return
        _coach_scan_inflight.add(ck)
    def _bg():
        try:
            _coach_scan_compute(market, exchange, n, tfset, min_stage, ck)
        finally:
            with _coach_scan_bg_lock:
                _coach_scan_inflight.discard(ck)
    threading.Thread(target=_bg, daemon=True).start()


@router.get("/coach_scan")
def coach_scan_api(
    market: str = "crypto",
    exchange: str = "binance",
    n: int = 60,
    tfset: str = "both",
    min_stage: int = 5,
    wait: int = 0,
    at_entry: int = 0,
):
    """教練掃描器：對成交量前 n 名加密永續跑教練(default+fast兩版)，篩出 stage≥min_stage 的標的。
    門檻預設 stage≥5(BOS 延續完成)：步驟5=setup成立、步驟6=去掛限價單、步驟7=觸碰成交,
    提前到 BOS 一確認就列,對限價單交易者留下掛單前置時間(等步驟7才列會來不及)。
    回 results=[{symbol, hits:{default/fast:{stage,direction,plan,price}}}]，依最高 stage 排序。

    at_entry=1：回應當下①逐檔「複驗」清單標的(與面板同基準、吃 10s/30s 短快取,只有幾檔很便宜)——
    已退階的當場剔除,清單 stage=點進面板看到的 stage;②再用「每秒 ticker 現價」過濾:區內(●進場中)
    或距區≤3%(近x%)。5m 執行時框的第7步壽命只有幾分鐘 → 每次回應都複驗,不讓死單掛在清單上。
    stale-while-revalidate：快取過期但 30 分內有舊結果 → 立即回舊的(帶 stale:true)＋背景重掃；
    完全沒結果(冷啟動)也不同步掃 → 回 warming:true＋背景掃，端點永遠即回。wait=1＝等新結果。"""
    ck = f"coach_scan:{market}:{exchange}:{n}:{tfset}:{min_stage}"

    def _reverify_hits(results):
        """逐檔重算教練(收盤確認基準 closed=1)，已退階(<min_stage)的剔除。只跑清單上的少數幾檔。"""
        from concurrent.futures import ThreadPoolExecutor as _TPE
        def _one(r):
            hits = {}
            for ver in (r.get("hits") or {}):
                try:
                    d = smc_coach_api(market, r["symbol"], exchange, tfset=ver, closed=1)   # closed=1=收盤確認(不 repaint)
                    if d.get("ok") and d.get("stage", 0) >= min_stage:
                        hits[ver] = {"stage": d["stage"], "direction": d["direction"],
                                     "plan": d.get("plan"), "price": d.get("price")}
                except Exception:
                    pass
            return {"symbol": r["symbol"], "hits": hits,
                    "top_stage": max(h["stage"] for h in hits.values())} if hits else None
        rs = (results or [])[:24]   # 上限24檔，防極端長清單拖慢
        if not rs:
            return []
        from data.crypto import mark_background as _mbg, is_background as _isbg
        with _TPE(max_workers=4, initializer=_mbg, initargs=(_isbg(),)) as _pool:
            fresh = [r for r in _pool.map(_one, rs) if r]
        fresh.sort(key=lambda r: -r["top_stage"])
        return fresh

    def _view(o, reverified=False):
        if not at_entry:
            return o
        rs = o.get("results")
        if not reverified:
            try:
                rs = _reverify_hits(rs)
            except Exception:
                pass
        return {**o, "results": _filter_at_entry(rs), "verified": True}

    cached = data_cache.get(ck, ttl=120)
    if cached:
        return _view(cached)
    if not wait:
        _coach_scan_spawn_bg(market, exchange, n, tfset, min_stage, ck)
        stale = data_cache.get(ck, ttl=1800)
        if stale:
            try:
                fresh = _reverify_hits(stale.get("results"))
                return _view({**stale, "results": fresh, "stale": True}, reverified=True)
            except Exception:
                return _view({**stale, "stale": True})
        # 冷啟動：連舊結果都沒有 → 不同步掃(會卡 15~20s)，回暖機狀態、背景掃完下次請求就有
        return {"ok": True, "scanned": 0, "min_stage": min_stage, "results": [],
                "warming": True, "asof": time.time()}
    return _view(_coach_scan_compute(market, exchange, n, tfset, min_stage, ck))


def smc_trend_txt(t):
    return "多" if t == 1 else ("空" if t == -1 else "待定")


def _export_bars(_df) -> dict:
    """把已 enrich 的 df 轉成純陣列（給回測加倉模擬重走 K 棒用；只在後端內部流通，不序列化給前端）。
    time 用與 crt._calc_crt_winrate 完全相同的 datetime64[s]→str，確保訊號 t 可精確對到棒索引。"""
    try:
        _t = _df["time"].to_numpy("datetime64[s]").astype(str).tolist()
    except Exception:
        _t = [(_x.isoformat() if hasattr(_x, "isoformat") else str(_x)) for _x in _df["time"]]
    def _arr(col):
        return _df[col].astype(float).tolist() if col in _df.columns else [float("nan")] * len(_df)
    return {
        "time": _t,
        "open": _arr("open"),  "high": _arr("high"),
        "low":  _arr("low"),   "close": _arr("close"),
        "bb_upper": _arr("bb_upper"), "bb_lower": _arr("bb_lower"),
    }


def _tag_htf_bias(df, timeframe, result):
    """把 fvg_ms(方向多空)/fvg_break(破多破空) 依『折價/溢價位置』標 weak(位置不對=弱→前端淡化)。
    **不用 HTF**：直接在『當前時框』自己的結構腿 dealing range 上算折價/溢價(50%±5%帶)。
    空/破多 在折價區(便宜還想空)、多/破空 在溢價區(貴還想多) → weak。就地算、免另抓。"""
    ms = result.get("fvg_ms") or []
    bk = result.get("fvg_break") or []
    sh = result.get("fvg_shun") or []
    if (not ms and not bk and not sh) or df is None or len(df) < 40:
        return
    try:
        import numpy as np
        _H = df["high"].to_numpy(float); _L = df["low"].to_numpy(float); _C = df["close"].to_numpy(float)
        _n = len(df); _PL = 8                                # 半窗 8 根定「較主要」擺動(對齊 ICT:用有意義擺動、避免 micro range)
        zn = [0] * _n; _sh = None; _sl = None; _cur = 0; _legStart = 0
        _lHi = None; _lLo = None; _legs = []                 # 每段結構腿：(startIdx, endIdx, top, bot)
        # 擺動點的「兩側各 _PL 根極值」先用滾動視窗一次算好（2026-07-31）：原本在逐棒迴圈裡對
        # numpy 切片做 .max()/.min()，剖析器實測各 17512 次呼叫、合計約 24ms。
        # ⚠ 等價性：迴圈裡 _j 的範圍是 [_PL, _n-_PL-1]，視窗 [_j-_PL, _j+_PL] 永遠落在陣列內
        #   → 中心式 rolling(2*_PL+1) 在該範圍內給的值與切片 .max()/.min() 逐格相同（邊緣的 NaN
        #   落在 _j 用不到的區間）。
        _win = 2 * _PL + 1
        _rmax = pd.Series(_H).rolling(_win, center=True).max().to_numpy()
        _rmin = pd.Series(_L).rolling(_win, center=True).min().to_numpy()
        for _i in range(_n):
            _j = _i - _PL                                    # 於 _j 確認 pivot(需兩側各 _PL 根)
            if _j >= _PL:
                if _H[_j] >= _rmax[_j]: _sh = _H[_j]         # 擺動高
                if _L[_j] <= _rmin[_j]: _sl = _L[_j]         # 擺動低
            _flip = 0                                        # BOS 轉向 → 開新腿
            if _sh is not None and _C[_i] > _sh and _cur != 1: _flip = 1
            elif _sl is not None and _C[_i] < _sl and _cur != -1: _flip = -1
            if _flip != 0:
                if _lHi is not None and _lLo is not None and _lHi > _lLo:   # 收掉上一腿(存入歷史)
                    _legs.append((_legStart, _i, _lHi, _lLo))
                _legStart = _i; _cur = _flip
                if _flip == 1: _lLo = _sl; _lHi = _H[_i]     # 上升腿：低鎖保護低、高從當根起
                else: _lHi = _sh; _lLo = _L[_i]              # 下降腿鏡像
            else:
                if _cur == 1: _lHi = _H[_i] if _lHi is None else max(_lHi, _H[_i])
                elif _cur == -1: _lLo = _L[_i] if _lLo is None else min(_lLo, _L[_i])
            if _lHi is not None and _lLo is not None and _lHi > _lLo:   # 折價/溢價(dealing range 50%±5%)
                _mid = (_lHi + _lLo) / 2.0; _band = (_lHi - _lLo) * 0.05
                zn[_i] = 1 if _C[_i] > _mid + _band else (-1 if _C[_i] < _mid - _band else 0)
        if _lHi is not None and _lLo is not None and _lHi > _lLo:   # 最後(進行中)那腿 endIdx=None
            _legs.append((_legStart, None, _lHi, _lLo))
        _bt = pd.to_datetime(df["time"]).values
        # 弱信號＝位置不對：空/破多在折價區(-1)、多/破空在溢價區(+1)。
        #   fvg_ms:d=s空/d=l多；fvg_break:d=l破多(bear)/d=s破空(bull)；fvg_shun/fvg_special 同 fvg_ms。
        # ★一次向量化解析時間（2026-07-31）：原本是 `def _zone_at(tstr)` 每個標記呼叫一次，裡面對
        #   **單一字串**做 pd.to_datetime —— pandas 對純量會每次重新推斷格式，剖析器實測 364 次呼叫
        #   吃掉 87ms（其中 61ms 花在 _guess_datetime_format_for_array、57148 次 re.search），
        #   佔整個勝率計算 292ms 的 30%。改成把四組標記的時間收成一個陣列、轉一次、searchsorted
        #   一次 → 格式只推斷一次。輸出完全相同（同一批值、同一個來源格式）。
        _groups = [(ms, "s"), (bk, "l"), (sh, "s"), (result.get("fvg_special") or [], "s")]
        _all_t = [m["t"] for _grp, _bd in _groups for m in _grp]
        if _all_t:
            _idx = np.searchsorted(_bt, pd.to_datetime(pd.Series(_all_t)).values, side="right") - 1
            _k = 0
            for _grp, _bear_d in _groups:
                for m in _grp:
                    _i = int(_idx[_k]); _k += 1
                    _z = int(zn[_i]) if 0 <= _i < _n else 0   # 標記所在(或之前)那根棒(自身資料已知，非未來)
                    bear = (m.get("d") == _bear_d)
                    m["weak"] = bool((bear and _z == -1) or ((not bear) and _z == 1))
        # 每段歷史交易區間(給前端畫折價/溢價/EQ)：t0→t1(None=進行中)、top/bot/eq。近 300 段。
        _tl = df["time"].tolist()
        _rngs = []
        for (_s, _e, _hi, _lo) in _legs[-300:]:
            try:
                _t0 = pd.Timestamp(_tl[_s]).isoformat()
                _t1 = pd.Timestamp(_tl[_e]).isoformat() if _e is not None else None
            except Exception:
                continue
            _rngs.append({"top": float(_hi), "bot": float(_lo),
                          "eq": float((_hi + _lo) / 2.0), "t0": _t0, "t1": _t1})
        if _rngs:
            result["pd_ranges"] = _rngs
            result["pd_range"] = _rngs[-1]   # 相容：最新那段
    except Exception:
        pass


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
    with_bars: bool = False,
    band_ratio: float = 1.0,
    vw: int = 0,
    proto_min: float = 0.0005,
    no_proto_ms: bool = False,
    no_proto_break: bool = False,
):
    """CRT 策略各時間級別勝率（每個子統計至少 10 個案例，不足則往前翻倍）。

    stop_buffer_pct：停損緩衝（decimal，例 0.005 = 0.5%）。
    短：stop = base_high × (1 + buf)；多：stop = base_low × (1 - buf)。
    band_ratio：上下軌『止盈目標』比例（1.0=原上下軌；0.8=8成軌）。非 1.0 時 cache_key 另分流，不污染主勝率。
    """
    from datetime import date, timedelta
    _buf = round(max(0.0, float(stop_buffer_pct or 0.0)), 4)
    _br = round(max(0.1, min(1.0, float(band_ratio or 1.0))), 3)
    _long_only = (market == "tw" and symbol.upper() not in FUTOPT_PRODUCTS)  # 台股不能放空；台指期是期貨可做空
    _br_tag = "" if _br >= 0.999 else f":br{_br}"   # 預設 1.0 不改 key（沿用既有快取）；8成軌等另分流
    # vw＝FVG/策略標記的「近段窗」根數(勝率統計不受此影響)。前端往歷史滑時加大 vw 重取→補算舊區標記。
    #   前端送固定階梯值(見 winrate.js _wrVwLadder)→ 快取條目有限；0/預設→空 tag(沿用主快取,窗=_VISUAL_WINDOW)。
    _vw = int(vw) if vw and vw > 0 else 0
    # 真正的大時框(4h/8h/1d/1M,根數少≤~1.8萬、payload≤~2MB)FVG 算「全歷史」→ 解「大時區顯示不夠長」。
    #   ⚠ 30m/2h 排除:它們根數最多(~3.5萬)、全歷史 payload 暴增到 3.5~3.8MB → Railway/手機易逾時失敗
    #     (「切時框找不到/載入問題」根因)。30m/2h 維持近段窗、往回拖靠 bg-load 補深即可。
    #   1w 前端不顯示 FVG → 不 boost。1m/5m/15m(可達十萬根)靠 vw 省效能。
    if timeframe in ("4h", "1d", "1M"):   # 8h 已移除
        _vw = max(_vw, 30000)
    _vw_tag = "" if _vw <= 0 else f":vw{_vw}"
    # proto 缺口(B)寬度門檻（多空/破多空）：前端可切換比較。預設 0.05% 不改 key（沿用既有快取），其餘另分流。
    _pm = round(float(proto_min), 5) if proto_min and proto_min > 0 else 0.0005
    _pm_tag = "" if abs(_pm - 0.0005) < 1e-9 else f":pm{_pm}"
    # no_proto_ms/break：多空、破多空各自 B 改用正常3根FVG(g+1確認)取代單根proto；預設關(空tag、沿用proto快取)
    _np_tag = ("" if not no_proto_ms else ":npm1") + ("" if not no_proto_break else ":npb1")
    cache_key = f"crt_wr105:{market}:{symbol}:{exchange}:{timeframe}:{_buf}:{int(_long_only)}{_br_tag}{_vw_tag}{_pm_tag}{_np_tag}"   # v101:no_proto拆多空/破多空獨立;v99:止損連續反色K run極值;v97:+fvg_ms止盈
    bar_key = cache_key + ":bar"
    # bar-aware 新鮮度：記下「算這份結果時最新那根棒的開盤時刻」。crypto 在「同一根棒內」吃快取，
    # 一旦有新棒收盤就讓快取失效 → 走下方短窗補抓重算 → 最新訊號最多慢到「收盤後第一次請求」，
    # 不再被 30 分 TTL 拖。tw/us 維持原 30 分行為（盤外不必每根棒重抓、也避免多打 yfinance）。
    _iv = _CRT_IV.get(timeframe)
    _bar_now = math.floor(time.time() / _iv) * _iv if _iv else None
    # 注意：solve 模式不可命中此勝率快取（cache_key 不含 solve），否則會回傳勝率而非求解結果
    _wr_cached = None
    if not solve:
        cached = data_cache.get(cache_key, ttl=_WR_CACHE_TTL)   # 保鮮期內直接回快取（即時價另走每秒路徑）
        if cached:
            # 新鮮度：容許結果落後「1 根」(新棒剛形成的幾秒內 df 還沒補到→不必每次重算 storm；且最新一根
            #   本來就不能有完整 FVG)。落後超過 1 根 → 判不新鮮 → 重算+重試尾巴補抓 → 自癒。
            _bk = data_cache.get(bar_key, ttl=_WR_CACHE_TTL)
            _fresh = (market != "crypto" or _bar_now is None
                      or (_bk is not None and (_bar_now - _bk) <= (_iv or 0)))
            if _fresh:
                if not with_bars:
                    return cached
                _wr_cached = cached   # with_bars：沿用快取結果，但仍往下載 df 取 K 棒陣列
        if _wr_cached is None and not with_bars:
            # Redis 共享快取(多實例,REDIS_URL 未設=no-op)：別的實例算過就直接拿(~10-20ms vs 重算 5-8s)。
            # 與記憶體路徑同 bar-aware 語義：crypto 存入時的最新棒 != 當前棒 → 視為過期不採用。
            from utils import redis_cache as _rcache
            _rhit = _rcache.get_json("wr:" + cache_key)
            if _rhit and isinstance(_rhit, dict) and "result" in _rhit:
                _rb = _rhit.get("bar")
                if market != "crypto" or _bar_now is None or (_rb is not None and (_bar_now - _rb) <= (_iv or 0)):
                    _res = _rhit["result"]
                    data_cache.set(cache_key, _res)          # 回填本實例記憶體
                    if _bar_now is not None:
                        data_cache.set(bar_key, _bar_now)
                    return _res

    MIN_CASES = 40   # 每個訊號（S1~S7 × 空/多）最少採樣數；不足會自動往前加倍天數
    # 各時間框架的最大歷史深度。上限拉到資料源實際可能的深度（Binance fapi BTC 2019/9~、
    # spot 2017/8~、Bybit/OKX 類似）。
    # 註：這裡原本還有一份沒人用的 TF_INIT（初始天數）→ 2026-07-31 移除；
    #     實際在用的初始天數表是 research/ai_strategy.py 的 _TF_INIT_DAYS。
    # 注意：TF_MAX 是「勝率計算」用的歷史深度，不是圖表顯示深度
    # 5/15/30m 圖上不必看到太久以前，但統計需要足夠案例數（MIN_CASES=40 × 11 訊號 × 空/多）
    TF_MAX  = {"1M": 7300, "1w": 7300, "1d": 7300, "8h": 5475, "4h": 5475, "2h": 4380, "1h": 2920,  "30m": 730, "15m": 720, "5m": 180, "1m": 20}

    def _sufficient(r: dict) -> bool:
        """每個訊號的空/多案例數都達到 MIN_CASES"""
        return all(
            (r.get(sig) or {}).get(d, {}).get("total", 0) >= MIN_CASES
            for sig in ("abc", "ab", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11") for d in ("short", "long")
        )

    def _fetch_df(days: int) -> pd.DataFrame:
        """依市場 / 時間框架取得指定天數的 K 棒（委派模組層級 fetch_crt_df，邏輯不變）。"""
        return fetch_crt_df(market, symbol, timeframe, days, exchange,
                            api_key=api_key, api_secret=api_secret, finmind_token=finmind_token)

    # 深度按需(2026-07-11)：深時框(5m~4h)初始只抓「統計 floor 深度」→ 標記快出(fetch 佔冷啟 ~90%)；
    #   往歷史滑時前端 vw 變大 → 這裡自動加深、補算舊區標記，最深仍到 TF_MAX。floor 已給 ~1.5萬根K
    #   (遠超 MIN_CASES=40)、勝率統計幾乎不受影響。8h/1d/1w/1M/1m 資料本就少、不縮(維持 TF_MAX)。
    _tf_max = TF_MAX.get(timeframe, 3650)
    # BTC/ETH/SOL 有本機/版控 5m 倉庫 → 5m FVG/勝率深度上限拉到 1 年(倉庫供得起深歷史→老K也有FVG,免API抓一年)
    if timeframe == "5m" and market == "crypto":
        try:
            from data.klines_store import is_target as _k_is5
            if _k_is5(symbol, "5m"):
                _tf_max = max(_tf_max, 365)
        except Exception:
            pass
    _FLOOR = {"5m": 60, "15m": 180, "30m": 365, "1h": 730, "2h": 730}   # 4h/8h/1d/1w/1M 維持全深度(都畫、使用者要求)
    if market == "crypto" and timeframe in _FLOOR:
        _bsec = _CRT_IV.get(timeframe, 3600)
        _need = (_vw * _bsec / 86400.0 * 1.15) if _vw > 0 else 0   # vw(往歷史滑)覆蓋天數 + 15% 邊際
        # 量化成幾級(floor, ×2, ×4, TF_MAX)→ df 快取條目有限、不爆
        days_max = _tf_max
        for _lvl in (_FLOOR[timeframe], _FLOOR[timeframe] * 2, _FLOOR[timeframe] * 4, _tf_max):
            if _lvl >= _need:
                days_max = min(_lvl, _tf_max); break
    else:
        days_max = _tf_max
    # 已抓+enrich 的 df 另外快取（不含 buffer）→ 換 SL 緩衝等重算時免重抓（抓資料佔總時間 90%+）
    # 深度進 key → 不同深度各自快取（滑回加深不覆蓋淺快取、淺請求也不誤用深快取的舊尖端）
    df_key = f"crt_df3:{market}:{symbol}:{exchange}:{timeframe}:d{days_max}"
    # base 深歷史 TTL：老 K 不可變 → crypto 有下方「尾巴補抓」逐請求保鮮尖端，深歷史可長存 7 天，
    #   不必每 30 分整包重抓 ~70k 根（抓資料佔總時間 90%+，這是切回舊標的卡頓的主因）。
    #   記憶體上限由 data_cache max_size(32 條) 硬卡、與 TTL 無關 → 拉長不影響 RAM 峰值。
    #   台股/美股此路徑無尾巴補抓、盤中新棒靠重抓 → 維持原 30 分，避免供應期內尖端不更新。
    _df_ttl = 604800 if market == "crypto" else _WR_CACHE_TTL   # crypto 7天、其餘 30 分
    _deg_key = df_key + ":deg"   # 降級來源(Pionex/Bybit)標記 → 冷卻結束就作廢重抓乾淨 Binance
    def _load_df():
        d = data_cache.get(df_key, ttl=_df_ttl)   # 記憶體
        # 降級來源快取：Binance 冷卻一結束就丟棄 → 逼重抓乾淨 Binance（避免髒 fallback 資料持久化生假 FVG）
        if d is not None and data_cache.get(_deg_key, ttl=_df_ttl) and time.time() >= _crypto._BINANCE_COOLDOWN_UNTIL:
            return None
        if d is None:
            d = disk_cache.get(df_key, ttl=_df_ttl)   # 磁碟（跨重啟/部署存活；只存 Binance 乾淨資料）
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
                df = enrich_df(df, indicators=False)   # 勝率/FVG/SS 只讀 BB+OHLCV，不讀 kdj/rsi/macd
                data_cache.set(df_key, df)
                # ⚠ 只有『來源＝Binance』才寫 7 天磁碟長效快取。Binance 冷卻時降級到 Pionex/Bybit 的資料
                #   wick/邊界不同→可能生 Binance 上沒有的假 FVG（2025-08 BTC 8h 2.86% 假空缺口即此）；
                #   標記為降級 → 冷卻一結束 _load_df 會丟棄重抓，不讓髒資料在磁碟持久化（Railway 尤甚）。
                if market == "crypto" and last_fetch_source() not in (None, "binance"):
                    data_cache.set(_deg_key, True)
                else:
                    data_cache.set(_deg_key, False)
                    disk_cache.set(df_key, df)       # 寫磁碟（下次重啟/部署免重抓）

    # ── bar-aware 尾巴補抓（crypto）──────────────────────────────
    # 深歷史沿用快取，只在「已有新棒收盤」時補抓一段短窗、接到尾巴後重算 → 便宜又即時。
    # 短窗夠長（~400 根）涵蓋指標 lookback，且 df 受 30 分 TTL 護著，尾巴最多差 30 分→必然重疊不留 gap。
    # ⚠ Binance 冷卻中不補抓：此時 _fetch_df 會降級到 Pionex/Bybit，接到 Binance 尾巴上 → 接縫兩側
    #   wick 不同會生假 FVG（且被 concat 進快取）。冷卻中直接用既有乾淨 df，冷卻結束再補即可。
    if (market == "crypto" and not solve and _bar_now is not None and df is not None
            and time.time() >= _crypto._BINANCE_COOLDOWN_UNTIL):
        try:
            _last = pd.Timestamp(df["time"].iloc[-1]).value / 1e9
            if _last < _bar_now:                      # 快取尾巴比現在最新棒舊 → 補抓
                _rd = max(2, math.ceil(400 * _iv / 86400) + 2)
                _recent = _fetch_df(_rd)              # 短窗 raw OHLCV（抓量小、便宜）
                # 只把『Binance 來源』的尾巴接上去；萬一還是降級來源就別 concat（避免接縫假 FVG）
                if (last_fetch_source() in (None, "binance")
                        and _recent is not None and len(_recent)):
                    _cols = ["time", "open", "high", "low", "close", "volume"]
                    _cut = _recent["time"].iloc[0]
                    _merged = pd.concat(
                        [df[df["time"] < _cut][_cols], _recent[_cols]], ignore_index=True)
                    df = enrich_df(_merged, indicators=False)   # 同上：勝率路徑不讀 kdj/rsi/macd
                    data_cache.set(df_key, df)
                    disk_cache.set(df_key, df)
        except Exception:
            pass                                       # 補抓失敗就用舊 df，不影響可用性

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

    if _wr_cached is not None:
        result = _wr_cached
    else:
        result = _calc_crt_winrate(df, stop_buffer_pct=_buf, long_only=_long_only, band_ratio=_br,
                                   visual_window=_vw, stock_gap=(market != "crypto"), proto_min=_pm,
                                   no_proto_ms=no_proto_ms, no_proto_break=no_proto_break)
        try:
            _tag_htf_bias(df, timeframe, result)   # 標 weak(逆 HTF 趨勢=弱信號)→前端淡化
        except Exception:
            pass
        result = _round_wr_floats(result)          # 浮點 8 位有效數字瘦身(raw JSON 約省 2~3 成)，快取存瘦身版
        # 內容指紋（ETag/304 用）：只在「重算寫入快取」時算一次(~數ms)，之後每次命中零成本。
        # 存進快取/Redis 一起帶走；路由端(crt_winrate_api)用它比對 If-None-Match 回 304 省 200KB 傳輸。
        try:
            import orjson as _oj, hashlib as _hl
            result["_h"] = _hl.md5(_oj.dumps(result)).hexdigest()[:16]
        except Exception:
            pass
        data_cache.set(cache_key, result)
        # ⚠ 新鮮鍵用「結果實際算到的最新棒」(_res_bar) 而非時鐘 _bar_now：
        #   若這次尾巴補抓失敗/冷卻→df 沒跟上→_res_bar < _bar_now → 下次請求判不新鮮 → 重算重試補抓 → 自癒。
        #   (原本一律蓋 _bar_now：補抓失敗算出的舊 FVG 被當「新鮮」一直回，卡住不自癒＝「最近FVG消失」根因。)
        _res_bar = _bar_now
        if _iv:
            try: _res_bar = math.floor(pd.Timestamp(df["time"].iloc[-1]).value / 1e9 / _iv) * _iv
            except Exception: _res_bar = _bar_now
        # Redis 共享快取寫入(多實例)：⚠ 降級來源(Bybit/Pionex,df 標 :deg)不寫 → 髒資料不跨實例傳播
        try:
            from utils import redis_cache as _rcache
            if _rcache.enabled() and (market != "crypto" or not data_cache.get(_deg_key, ttl=_df_ttl)):
                _rcache.set_json("wr:" + cache_key, {"bar": _res_bar, "result": result}, ttl=_WR_CACHE_TTL)
        except Exception:
            pass
        if _bar_now is not None:
            data_cache.set(bar_key, _res_bar)   # 標記此結果實際算到的最新棒 → bar-aware 新鮮度判定用（落後即自癒）
    if with_bars:
        return {**result, "_bars": _export_bars(df)}   # 加倉回測：附 K 棒陣列（後端內部用）
    return result
