"""數據獲取 API 路由"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import date, timedelta, datetime as dt
from typing import Optional
import os
import time
import math
import threading
import pandas as pd

from data.taiwan import fetch_tw_stock, resample_tw, fetch_tw_intraday, fetch_tw_realtime, fetch_tw_intraday_yf, fetch_tw_latest_bar_yf, fetch_tw_daily_yf, YF_MAX_DAYS as TW_YF_MAX_DAYS
from data.fugle import fetch_fugle_intraday, fugle_enabled
from data.alpaca import fetch_alpaca_bars, alpaca_enabled
from data.twelvedata import fetch_twelvedata_intraday, twelvedata_enabled
from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
from data.hk_stock import fetch_hk_realtime
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
        if timeframe in ("1m", "5m", "15m", "1h"):
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
            _df = _df.resample("4h", origin="start_day", offset="1h").agg(
                {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
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
    elif market in ("us", "hk"):
        # 港股(hk)＝美股同一條 yfinance 路：代號用 xxxx.HK(如 0700.HK)，時框/時區/盤別全沿用。
        max_d = US_MAX_DAYS.get(timeframe, 3650)
        start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
        return fetch_us_stock(symbol, start, end, timeframe)
    elif market == "crypto":
        start = (date.today() - timedelta(days=days)).isoformat()
        from data.crypto import _fetch_binance_fapi, _calc_max_candles
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
                    return _dfb
            except Exception:
                pass
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


@router.get("/_diag_trade")
def diag_trade():
    """自動交易／訊號通知診斷（瀏覽器直接開）：定位『完全沒推播/沒進場』斷在哪。
    notify_enabled=False→VAPID沒設(訂閱推播發不出)；subs=0→無訂閱；auto_accounts空→cfg沒讀到active；
    某帳號 scan_tfs 空或 crypto_watchlist=0→該帳號不會被掃。**不洩漏任何金鑰。**"""
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
                "ss_on": (cfg.get("ss") or {}).get("on"),
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
            if req.timeframe in ("1m", "5m", "15m", "1h", "4h"):
                # 4h 走 1h 來源再重採樣（避免 yfinance 1h bug）
                src_tf = "1h" if req.timeframe == "4h" else req.timeframe
                max_d = TW_YF_MAX_DAYS.get(src_tf, 60)
                if use_limit:
                    bars_per_day = {"1m": 270, "5m": 78, "15m": 26, "1h": 5, "4h": 2}.get(req.timeframe, 26)
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
                if (fugle_enabled() and src_tf in ("1m", "5m", "15m", "1h")
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
        elif req.market in ("us", "hk"):
            # 港股(hk)＝美股同一條 yfinance 路（代號 xxxx.HK）。即時報價疊加僅美股(Finnhub)，港股純用 yfinance。
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
                min_start = (date.fromisoformat(end) - timedelta(days=max_d)).isoformat()
                start = max(start_raw, min_start)
            df = fetch_us_stock(req.symbol, start, end, req.timeframe)
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
            if tf in ("1m", "5m", "15m", "1h", "4h"):
                # ⭐ Fugle 富果即時分鐘K 優先（無 20 分延遲、無空隙、任何標的秒出、不需 MIS 累積）。
                #    快取 8 秒；失敗或未設 FUGLE_TOKEN → fallback 回下方 yfinance + MIS。
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
                    if rt and tf in ("1m", "5m", "15m", "1h"):
                        minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}[tf]
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
                    _mins = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240}.get(req.timeframe)
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
        elif req.market == "hk":
            # 港股(hk)：歷史 yfinance(延遲~15分)，即時尖端用騰訊即時報價自己堆分鐘棒 → 當下就有最新棒、無延遲。
            _mins = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}.get(req.timeframe)
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
    # 若有 FINNHUB_TOKEN，美股也算即時；港股(騰訊即時)在上面 hk 分支已 return，這裡只是純 yfinance 尾
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


# 只後端(回測/自動交易)用、前端不讀的 per-signal 欄位 → 回前端 JSON 時砍掉
_WR_SLIM_DROP = frozenset({"est_r", "est_r_b", "rr", "rr_b", "rr_real", "rr_b_real"})
# S1~S12 已退役，前端只保留 SS 系列訊號（ss1/ss2）。S1~S12 的 key＝abc/ab/3~12。
_SS_KEEP_KEYS = frozenset({"ss1", "ss2"})


@router.get("/crt_winrate")
def crt_winrate_api(
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
):
    """/api/crt_winrate 路由：呼叫 get_crt_winrate(含快取) → 回前端時把 signals『瘦身』
    （拿掉只後端用的 est/rr 欄位 + 省略 None 值），省 ~40% 傳輸量、加快手機端載入。
    band_ratio：上下軌目標比例（1.0=上下軌；0.8=8成軌，HUD 切到 8成軌時前端帶此參數另抓一份）。
    vw：FVG/策略標記的近段窗根數（前端往歷史滑時加大→補算舊區標記；勝率統計不受影響）。
    ⚠ 回測/自動交易是 Python 直接呼叫 get_crt_winrate → 拿『完整』signals，不受此瘦身影響。"""
    wr = get_crt_winrate(market, symbol, timeframe, exchange, stop_buffer_pct,
                         solve, solve_target, api_key, api_secret, finmind_token,
                         band_ratio=band_ratio, vw=vw)
    if solve or not isinstance(wr, dict):        # solve 模式非勝率結構 → 原樣回
        return wr
    sigs = wr.get("signals")
    if not sigs:
        return wr
    # S1~S12 已退役（全驗無 edge）→ 只回 SS 系列訊號（ss1/ss2）給前端；S1~S12 標記/HUD 不再出現。
    # fvg 為獨立 key，原樣保留。⚠ 回測走 Python 直呼 get_crt_winrate 拿完整 signals，不受此處影響。
    slim = [{k: v for k, v in s.items() if v is not None and k not in _WR_SLIM_DROP}
            for s in sigs if s.get("k") in _SS_KEEP_KEYS]
    return {**wr, "signals": slim}


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


def _coach_pos_in_channel(ch, price):
    if not ch or price is None:
        return "—"
    trend = "上升通道" if ch["dir"] == 1 else "下降通道"
    if price > ch["upper"]:
        return trend + "·上軌外"
    if price < ch["lower"]:
        return trend + "·下軌外"
    return trend + "·通道內"


def _coach_nearest_htf_zone(snap, direction, price):
    """市場位置：方向為空取上方最近未填補空缺口；為多取下方最近未填補多缺口。"""
    if not snap or price is None:
        return None
    fvg = snap.get("fvg") or {"l": [], "s": []}
    if direction == -1:
        cands = [z for z in fvg["s"] if max(z["top"], z["bot"]) > price]
        if cands:
            z = min(cands, key=lambda z: min(z["top"], z["bot"]) - price)
            return {"side": "上方", "kind": "空方缺口", "top": z["top"], "bot": z["bot"]}
    elif direction == 1:
        cands = [z for z in fvg["l"] if min(z["top"], z["bot"]) < price]
        if cands:
            z = max(cands, key=lambda z: max(z["top"], z["bot"]) - price)
            return {"side": "下方", "kind": "多方缺口", "top": z["top"], "bot": z["bot"]}
    return None


def _coach_tp_list(snaps, direction, price, n=4):
    """多段止盈 TP1～TP4（對齊 Pine POSITION_MAX_TP=4）：用 1H/4H 支撐/阻力區，
    依離進場價由近到遠取前 n 個「近邊」出場價。多→上方阻力區(近邊=下緣)；空→下方支撐區(近邊=上緣)。
    跨時框匯總、過近(<0.1%)去重。"""
    if price is None:
        return []
    cands = []
    for snap in snaps:
        if not snap:
            continue
        sr = snap.get("sr") or {"res": [], "sup": []}
        fvg = snap.get("fvg") or {"l": [], "s": []}
        if direction == 1:                                   # 多：上方阻力區/空缺口，近邊＝下緣
            for z in sr.get("res", []) + fvg.get("s", []):   # SR 阻力 + 空FVG(反向缺口)當離場目標
                edge = min(z["top"], z["bot"])
                if edge > price:
                    cands.append((edge, edge - price))
        elif direction == -1:                                # 空：下方支撐區/多缺口，近邊＝上緣
            for z in sr.get("sup", []) + fvg.get("l", []):
                edge = max(z["top"], z["bot"])
                if edge < price:
                    cands.append((edge, price - edge))
    cands.sort(key=lambda x: x[1])                           # 依距離近→遠
    out = []
    for edge, _d in cands:
        if any(abs(edge - m) <= abs(price) * 0.001 for m in out):   # 過近去重
            continue
        out.append(edge)
        if len(out) >= n:
            break
    return out


def _coach_all_named(snap, tfname):
    """某時框全部有效區（雙向 OB/FVG + SR），帶名稱。給「市場位置」用。"""
    if not snap:
        return []
    out = []
    for side, dl in (("l", "多"), ("s", "空")):
        for z in (snap.get("ob") or {}).get(side, []):
            out.append((z["top"], z["bot"], f"{tfname} {dl}方訂單區"))
        for z in (snap.get("fvg") or {}).get(side, []):
            out.append((z["top"], z["bot"], f"{tfname} {dl}方缺口"))
    for k, kl in (("res", "阻力"), ("sup", "支撐")):
        for z in (snap.get("sr") or {}).get(k, []):
            out.append((z["top"], z["bot"], f"{tfname} {kl}區"))
    return out


def _coach_current_zone(s4h, s1h, price):
    """市場位置：目前價格所在的區（1H 優先），否則最近的區。"""
    if price is None:
        return None
    zs = _coach_all_named(s1h, "1H") + _coach_all_named(s4h, "4H")
    inside = [z for z in zs if min(z[0], z[1]) <= price <= max(z[0], z[1])]
    if inside:
        z = min(inside, key=lambda z: abs((z[0] + z[1]) / 2 - price))
        return {"inside": True, "kind": z[2], "top": z[0], "bot": z[1]}
    if zs:
        z = min(zs, key=lambda z: min(abs(price - z[0]), abs(price - z[1])))
        return {"inside": False, "kind": z[2], "top": z[0], "bot": z[1]}
    return None


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
    cached = data_cache.get(ck, ttl=10)
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
            d = data_cache.get(dk, ttl=_dttl)
            if d is None:
                d = fetch_crt_df(market, symbol, tf, days, exchange, api_key, api_secret, finmind_token)
                data_cache.set(dk, d)
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
    with _TPE(max_workers=len(_TFS)) as _pool:
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
    data_cache.set(ck, out)
    return out


_coach_scan_bg_lock = threading.Lock()
_coach_scan_inflight: set = set()


def _coach_scan_compute(market, exchange, n, tfset, min_stage, ck):
    """教練掃描本體：跑完寫入 ck 快取並回傳。closed=0＝與教練面板完全同基準(含未收盤棒)＋共用同一份
    K棒快取與 smc_coach 結果快取 → 清單上的 stage 就是點進面板會看到的 stage(不再「點進去連第7步都沒到」)。"""
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
                d = smc_coach_api(market, sym, exchange, tfset=_ts)   # closed=0=與面板同基準
                if d.get("ok") and d.get("stage", 0) >= min_stage:
                    hits[_ts] = {"stage": d["stage"], "direction": d["direction"],
                                 "plan": d.get("plan"), "price": d.get("price")}
            except Exception:
                pass
        return sym, hits

    results = []
    if syms:
        with _TPE(max_workers=6) as _pool:                # 每標的內部已並行4時框；併發6標的(權重感知節流已防429/418)
            for sym, hits in _pool.map(_scan_one, syms):
                if hits:
                    results.append({"symbol": sym, "hits": hits,
                                    "top_stage": max(h["stage"] for h in hits.values())})
    results.sort(key=lambda r: -r["top_stage"])
    out = {"ok": True, "scanned": len(syms), "min_stage": min_stage,
           "results": results, "asof": time.time()}
    if syms:                       # universe 抓不到(418封禁/暖機)＝掃了個空 → 不寫快取,下次請求直接重試
        data_cache.set(ck, out)
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
        """逐檔重算教練(與面板同基準)，已退階(<min_stage)的剔除。只跑清單上的少數幾檔。"""
        from concurrent.futures import ThreadPoolExecutor as _TPE
        def _one(r):
            hits = {}
            for ver in (r.get("hits") or {}):
                try:
                    d = smc_coach_api(market, r["symbol"], exchange, tfset=ver)   # 與面板同基準
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
        with _TPE(max_workers=4) as _pool:
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
        for _i in range(_n):
            _j = _i - _PL                                    # 於 _j 確認 pivot(需兩側各 _PL 根)
            if _j >= _PL:
                if _H[_j] >= _H[_j - _PL:_j + _PL + 1].max(): _sh = _H[_j]   # 擺動高
                if _L[_j] <= _L[_j - _PL:_j + _PL + 1].min(): _sl = _L[_j]   # 擺動低
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

        def _zone_at(tstr):
            t = np.datetime64(pd.to_datetime(tstr))
            i = np.searchsorted(_bt, t, side="right") - 1    # 標記所在(或之前)那根棒(自身資料已知，非未來)
            return int(zn[i]) if 0 <= i < _n else 0
        # 弱信號＝位置不對：空/破多在折價區(-1)、多/破空在溢價區(+1)。fvg_ms:d=s空/d=l多；fvg_break:d=l破多(bear)/d=s破空(bull)
        for m in ms:
            _z = _zone_at(m["t"]); bear = (m.get("d") == "s")
            m["weak"] = bool((bear and _z == -1) or ((not bear) and _z == 1))
        for m in bk:
            _z = _zone_at(m["t"]); bear = (m.get("d") == "l")
            m["weak"] = bool((bear and _z == -1) or ((not bear) and _z == 1))
        for m in sh:                                     # 順多/順空 與 多/空 同規則：順空在折價、順多在溢價 → weak
            _z = _zone_at(m["t"]); bear = (m.get("d") == "s")
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
):
    """CRT 策略各時間級別勝率（每個子統計至少 10 個案例，不足則往前翻倍）。

    stop_buffer_pct：停損緩衝（decimal，例 0.005 = 0.5%）。
    短：stop = base_high × (1 + buf)；多：stop = base_low × (1 - buf)。
    band_ratio：上下軌『止盈目標』比例（1.0=原上下軌；0.8=8成軌）。非 1.0 時 cache_key 另分流，不污染主勝率。
    """
    from datetime import date, timedelta
    _buf = round(max(0.0, float(stop_buffer_pct or 0.0)), 4)
    _br = round(max(0.1, min(1.0, float(band_ratio or 1.0))), 3)
    _long_only = (market == "tw")  # 台股不能放空
    _br_tag = "" if _br >= 0.999 else f":br{_br}"   # 預設 1.0 不改 key（沿用既有快取）；8成軌等另分流
    # vw＝FVG/策略標記的「近段窗」根數(勝率統計不受此影響)。前端往歷史滑時加大 vw 重取→補算舊區標記。
    #   前端送固定階梯值(見 winrate.js _wrVwLadder)→ 快取條目有限；0/預設→空 tag(沿用主快取,窗=_VISUAL_WINDOW)。
    _vw = int(vw) if vw and vw > 0 else 0
    _vw_tag = "" if _vw <= 0 else f":vw{_vw}"
    cache_key = f"crt_wr99:{market}:{symbol}:{exchange}:{timeframe}:{_buf}:{int(_long_only)}{_br_tag}{_vw_tag}"   # v96:股票隔盤跳空(影線對影線)缺口盒;v95:+vw(視覺標記近段窗)
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
            _fresh = (market != "crypto" or _bar_now is None
                      or data_cache.get(bar_key, ttl=_WR_CACHE_TTL) == _bar_now)
            if _fresh:
                if not with_bars:
                    return cached
                _wr_cached = cached   # with_bars：沿用快取結果，但仍往下載 df 取 K 棒陣列

    MIN_CASES = 40   # 每個訊號（S1~S7 × 空/多）最少採樣數；不足會自動往前加倍天數
    # 各時間框架：初始天數 / 最大天數
    # 上限拉到資料源實際可能的歷史深度（Binance fapi BTC 2019/9~、spot 2017/8~、Bybit/OKX 類似）
    TF_INIT = {"1M": 3650, "1w": 1825, "1d": 730,  "8h": 730,  "4h": 365,  "2h": 365,  "1h": 365,   "30m": 90,  "15m": 60,  "5m": 30,  "1m": 7}
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

    # ── bar-aware 尾巴補抓（crypto）──────────────────────────────
    # 深歷史沿用快取，只在「已有新棒收盤」時補抓一段短窗、接到尾巴後重算 → 便宜又即時。
    # 短窗夠長（~400 根）涵蓋指標 lookback，且 df 受 30 分 TTL 護著，尾巴最多差 30 分→必然重疊不留 gap。
    if market == "crypto" and not solve and _bar_now is not None and df is not None:
        try:
            _last = pd.Timestamp(df["time"].iloc[-1]).value / 1e9
            if _last < _bar_now:                      # 快取尾巴比現在最新棒舊 → 補抓
                _rd = max(2, math.ceil(400 * _iv / 86400) + 2)
                _recent = _fetch_df(_rd)              # 短窗 raw OHLCV（抓量小、便宜）
                if _recent is not None and len(_recent):
                    _cols = ["time", "open", "high", "low", "close", "volume"]
                    _cut = _recent["time"].iloc[0]
                    _merged = pd.concat(
                        [df[df["time"] < _cut][_cols], _recent[_cols]], ignore_index=True)
                    df = enrich_df(_merged)
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
                                   visual_window=_vw, stock_gap=(market != "crypto"))
        try:
            _tag_htf_bias(df, timeframe, result)   # 標 weak(逆 HTF 趨勢=弱信號)→前端淡化
        except Exception:
            pass
        data_cache.set(cache_key, result)
        if _bar_now is not None:
            data_cache.set(bar_key, _bar_now)   # 標記此結果對應的最新棒 → bar-aware 新鮮度判定用
    if with_bars:
        return {**result, "_bars": _export_bars(df)}   # 加倉回測：附 K 棒陣列（後端內部用）
    return result
