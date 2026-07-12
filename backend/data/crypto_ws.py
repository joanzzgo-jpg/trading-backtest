"""Binance WebSocket 即時報價（取代每秒 REST 輪詢，權重極低）。

只在 leader worker 且 env TICKER_WS 開啟時執行（預設關 → 沿用 REST 輪詢，零風險）。
機制：先用一次 REST fetch_tickers 種子完整清單，之後訂閱 `!miniTicker@arr`
（全市場迷你行情，每 ~1s 推「有變動的」標的）增量更新記憶體 map → 重建清單餵 live_data。
一條 spot + 一條 futures 連線即涵蓋全市場，Binance 權重近乎 0。斷線自動重連（退避）。
"""
import asyncio
import json
import time

SPOT_WS = "wss://stream.binance.com:9443/ws/!miniTicker@arr"
FUT_WS  = "wss://fstream.binance.com/ws/!miniTicker@arr"


def _mini_to_ticker(m: dict, is_fut: bool):
    """miniTicker 單筆 → app ticker dict（格式與 data.crypto 的 REST 版一致）。非 USDT 對回 None。"""
    sym = m.get("s", "")
    if not sym.endswith("USDT"):
        return None
    try:
        c = float(m["c"]); o = float(m.get("o", 0))
    except (KeyError, ValueError, TypeError):
        return None
    base = sym[:-4]
    chg = c - o
    pct = round((chg / o * 100), 2) if o else 0.0
    d = {
        "symbol": sym, "price": c, "open": o,
        "change_pct": pct, "change_amt": round(chg, 8),
        "volume": float(m.get("q", 0) or 0),
        "spot": base + "/USDT",
        "display": base + ("/USDT.P" if is_fut else "/USDT"),
    }
    return d


async def run_ticker_ws():
    """leader 專用：WS 維護 futures/spot 即時報價 → live_data。永不 return（含重連）。"""
    import aiohttp
    from data.crypto import (fetch_tickers, _apply_perp_filter,
                             _fetch_pionex_symbols, _fetch_pionex_perp_symbols)
    from utils.live_data import update as live_update

    loop = asyncio.get_event_loop()
    fut_map, spot_map = {}, {}     # symbol -> ticker dict（持續累積，保清單完整）
    _last_emit = [0.0]
    # 逐市場記「最後一次該市場 WS 真的推進」的時間 → 逐市場判斷是否要 REST 補。
    # （重要：期貨 fstream WS 在部分地區/Railway 連得上卻不推任何資料；若與 spot 共用一個時間戳，
    #   spot 一直在推會讓看門狗誤判「WS 健康」→ 期貨永遠凍在種子值＝「合約數字不跳」的根因。）
    _last_ws_fut  = [0.0]
    _last_ws_spot = [0.0]

    def _perp_set():
        try:
            from data.crypto import _fetch_fapi_perp_set
            return _fetch_fapi_perp_set()
        except Exception:
            return set()

    def _spot_set():
        return _fetch_pionex_symbols() or _fetch_pionex_perp_symbols() or set()

    def _emit(force=False):
        now = time.time()
        if not force and now - _last_emit[0] < 1.0:   # 最多每秒餵一次(WS 可能更密)
            return
        _last_emit[0] = now
        fut = sorted(fut_map.values(), key=lambda x: x["change_pct"], reverse=True)
        spot = sorted(spot_map.values(), key=lambda x: x["change_pct"], reverse=True)
        try:
            live_update(fut, spot)
        except Exception:
            pass

    def _rest_refresh():
        """同步 REST 重抓完整清單（用於種子與看門狗；由 executor 呼叫，不擋事件迴圈）。"""
        try:
            for t in fetch_tickers("futures"):
                fut_map[t["symbol"]] = t
            for t in fetch_tickers("spot"):
                spot_map[t["symbol"]] = t
            return True
        except Exception as e:
            print(f"  ⚠ REST 補抓失敗：{str(e)[:100]}")
            return False

    # ── 種子：一次 REST 拿完整清單（放 executor，不擋迴圈） ──
    if await loop.run_in_executor(None, _rest_refresh):
        _emit(force=True)
        print(f"  ✓ WS 報價種子完成 futures={len(fut_map)} spot={len(spot_map)}")

    def _apply_prices(mp, prices):
        """把輕量 REST 現價 {SYMBOL: price} 套到既有 map（保留種子的 24h open → 重算漲跌幅）。"""
        if not prices:
            return False
        for sym, t in mp.items():
            p = prices.get(sym)
            if p is None:
                continue
            t["price"] = p
            o = t.get("open") or 0
            if o:
                t["change_amt"] = round(p - o, 8)
                t["change_pct"] = round((p - o) / o * 100, 2)
        return True

    async def _rest_fallback():
        """逐市場看門狗（每秒）：哪個市場的 WS >4s 沒推進 → 用『輕量 REST 現價』每秒補該市場。
        期貨 fstream WS 被 Binance 靜默封鎖（連得上不推）時，合約報價就靠這條 1s REST 保持跳動；
        spot WS 正常時 spot 不會觸發。另每 ~15s 做一次完整 24h 重抓（補新標的、刷新量/open）。"""
        from data.crypto import _fetch_fapi_prices, _fetch_spot_prices
        cnt = 0
        while True:
            await asyncio.sleep(1)
            now = time.time()
            changed = False
            if now - _last_ws_fut[0] > 4:
                fp = await loop.run_in_executor(None, _fetch_fapi_prices)
                if _apply_prices(fut_map, fp):
                    changed = True
            if now - _last_ws_spot[0] > 4:
                sp = await loop.run_in_executor(None, _fetch_spot_prices)
                if _apply_prices(spot_map, sp):
                    changed = True
            cnt += 1
            if cnt % 15 == 0:   # 完整重抓：補新上市標的 + 刷新 24h 量/open（漲跌幅基準）
                await loop.run_in_executor(None, _rest_refresh)
                changed = True
            if changed:
                _emit(force=True)

    async def _stream(url, is_fut):
        backoff = 1
        try:
            allow = _perp_set() if is_fut else _spot_set()
        except Exception:
            allow = set()
        mp = fut_map if is_fut else spot_map
        _refresh = [time.time()]
        while True:
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.ws_connect(url, heartbeat=30, timeout=20) as ws:
                        backoff = 1
                        async for msg in ws:
                            if msg.type != aiohttp.WSMsgType.TEXT:
                                continue
                            try:
                                arr = json.loads(msg.data)
                            except Exception:
                                continue
                            if not isinstance(arr, list):
                                continue
                            # 每 5 分鐘刷新一次允許集合（新上市標的）
                            if time.time() - _refresh[0] > 300:
                                allow = _perp_set() if is_fut else _spot_set()
                                _refresh[0] = time.time()
                            for m in arr:
                                d = _mini_to_ticker(m, is_fut)
                                if d and d["symbol"][:-4].upper() in allow:
                                    mp[d["symbol"]] = d
                            (_last_ws_fut if is_fut else _last_ws_spot)[0] = time.time()   # 該市場 WS 有推進
                            _emit()
            except Exception as e:
                await asyncio.sleep(min(backoff, 30))
                backoff = min(backoff * 2, 30)
                print(f"  ⚠ WS 重連（{'fut' if is_fut else 'spot'}）：{str(e)[:80]}")

    # return_exceptions=True：任一條(串流/REST補)掛掉不會取消其他 → 補救永遠活著、報價不凍結。
    await asyncio.gather(_stream(FUT_WS, True), _stream(SPOT_WS, False), _rest_fallback(),
                         return_exceptions=True)
