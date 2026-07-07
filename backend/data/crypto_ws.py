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

    fut_map, spot_map = {}, {}     # symbol -> ticker dict（持續累積，保清單完整）
    _last_emit = [0.0]

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

    # ── 種子：一次 REST 拿完整清單（WS 只推有變動的，先鋪底才不會前幾秒空） ──
    try:
        for t in fetch_tickers("futures"):
            fut_map[t["symbol"]] = t
        for t in fetch_tickers("spot"):
            spot_map[t["symbol"]] = t
        _emit(force=True)
        print(f"  ✓ WS 報價種子完成 futures={len(fut_map)} spot={len(spot_map)}")
    except Exception as e:
        print(f"  ⚠ WS 種子失敗（仍會靠 WS 累積）：{str(e)[:100]}")

    async def _stream(url, is_fut):
        backoff = 1
        allow = _perp_set() if is_fut else _spot_set()
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
                            _emit()
            except Exception as e:
                await asyncio.sleep(min(backoff, 30))
                backoff = min(backoff * 2, 30)
                print(f"  ⚠ WS 重連（{'fut' if is_fut else 'spot'}）：{str(e)[:80]}")

    await asyncio.gather(_stream(FUT_WS, True), _stream(SPOT_WS, False))
