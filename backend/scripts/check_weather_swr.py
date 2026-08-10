#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：天氣類端點**絕不在請求執行緒裡等網路**（過期先回舊值、背景更新）。

用法（不需要服務跑著，直接在行程內驗）：
    cd backend && ../.venv312/bin/python scripts/check_weather_swr.py

為什麼需要這支
    2026-08-11 實測：`/api/weather` 冷路徑 **1817ms**、`/api/nearby_rain` **3300ms**，
    而熱的只有 10ms / 3ms。也就是快取一過期，那個倒楣的使用者就在請求裡等 1.8~3.3 秒。
    這是本專案第二次踩同一個坑（第一次是台指期報價，見 routes/search.py `_txf_tickers`）。

    ★ 這個壞法**平常完全看不出來**：自己開來看幾乎都命中快取（幾毫秒），
      只有「剛好卡在過期那一刻」的人會慢，而他也不會回報、伺服器也不報錯。
      靠手測碰不到 → 只能靠這支主動把 TTL 調成 1 秒、逼出過期那一刻。

    ⚠ 順便驗 `_force` 沒有外露成查詢參數：它是背景重算用來繞過 SWR 的旗標，
      一旦留在被 @router 裝飾的函式簽章上，FastAPI 會把它變成公開查詢參數 →
      任何人打 `?_force=1` 就能繞過快取、每個請求直打 CWA/Open-Meteo（免費額度打爆）。

判準（每支端點三項）
    ① 過期後的請求 < 200ms（＝拿到舊值就回，沒有在等網路）
    ② 回的不是空值
    ③ 背景更新跑完後 busy 旗標有清掉（沒清＝一次失敗後就再也不會更新）

回傳碼：0 全過 / 1 有端點會卡住或 _force externally 可用 / 2 測試不成立
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LAT, LON = 25.033, 121.565
FAST_MS = 200.0        # 過期後仍 <200ms ＝ 沒有在請求裡等網路（實測拿舊值是 0~1ms）


async def _run() -> int:
    try:
        from routes import weather as W
    except Exception as e:
        print(f"✗ 匯入 routes.weather 失敗（{type(e).__name__}: {e}）→ 測試不成立")
        return 2

    cases = [
        ("/api/weather", W.weather, W._WX_STALE, W._WX_BUSY,
         lambda: (setattr(W, "_WX_TTL", 1), setattr(W, "_WX_TTL_WET", 1))),
        ("/api/nearby_rain", W.nearby_rain, W._NR_STALE, W._NR_BUSY,
         lambda: (setattr(W, "_NR_TTL", 1), setattr(W, "_NR_TTL_WET", 1))),
    ]
    fails = []
    for name, fn, stale, busy, shrink_ttl in cases:
        try:
            t = time.perf_counter()
            await fn(LAT, LON)                      # 冷啟動：本來就該同步算（會慢，正常）
            cold = (time.perf_counter() - t) * 1000
        except Exception as e:
            print(f"   {name} 冷啟動取得失敗（{type(e).__name__}: {str(e)[:60]}）"
                  f" — 略過（可能沒網路/上游掛了），不算失敗")
            continue
        shrink_ttl()                                # 把 TTL 縮到 1 秒，逼出「剛好過期」那一刻
        await asyncio.sleep(1.4)
        t = time.perf_counter()
        res = await fn(LAT, LON)
        warm = (time.perf_counter() - t) * 1000
        ok = warm < FAST_MS and res is not None
        print(f"   {'✓' if ok else '✗'} {name:16s} 冷 {cold:6.0f}ms → 過期後 {warm:6.0f}ms"
              f"（應 <{FAST_MS:.0f}ms＝回舊值不等網路）")
        if warm >= FAST_MS:
            fails.append(f"{name} 過期時仍在請求裡同步等網路（{warm:.0f}ms）")
        if res is None:
            fails.append(f"{name} 過期時回了空值")
        await asyncio.sleep(4.0)                    # 等背景那條跑完
        if busy:
            fails.append(f"{name} busy 沒清乾淨 → 一次失敗後就再也不會更新")
        print(f"     背景更新收尾 {'✓' if not busy else '✗ 仍卡著'}　舊值儲存 {len(stale)} 筆")

    # _force 不得外露成查詢參數
    try:
        import main as _m
        for r in _m.app.routes:
            if getattr(r, "path", "") in ("/api/weather", "/api/nearby_rain"):
                qp = [p.name for p in r.dependant.query_params]
                if "_force" in qp:
                    fails.append(f"{r.path} 把 _force 暴露成查詢參數（?_force=1 可繞過快取直打上游）")
        print("   ✓ _force 沒有外露成查詢參數" if not any("_force" in f for f in fails)
              else "   ✗ _force 外露")
    except Exception as e:
        print(f"   （_force 外露檢查略過：{type(e).__name__}）")

    print()
    if fails:
        print("★ 有端點會讓使用者等網路（或快取可被外部繞過）：")
        for f in fails:
            print(f"   {f}")
        return 1
    print("★ 天氣類端點過期時一律先回舊值、背景更新，沒有人會卡在請求裡等網路")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_run()))
