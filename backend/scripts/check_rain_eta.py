#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：附近雨區的「幾分鐘後到」必須符合攔截幾何。

用法（不需要服務跑著、不打網路，純幾何）：
    cd backend && ../.venv312/bin/python scripts/check_rain_eta.py

為什麼需要這支
    2026-08-11 抓到兩個相反方向的錯，而且**看起來都很正常**（有數字、不報錯）：
      ✗ 誤報：夾角 65° 的雨區其實是從 7.3km 外斜掠而過、永遠不會到你頭上，
        舊算法（點對點 + 速度投影 dist/(speed·cos)）照樣回「約 38 分後到」。
      ✗ 晚報：40km 寬的雨帶斜壓過來，先碰到你的是**邊緣**不是中心 → 舊算法晚報 10 分鐘。
    這種錯不可能靠看畫面發現（要等 38 分鐘後沒下雨、還要記得自己看過什麼），
    也不可能靠真實天氣測（要剛好有那個幾何的雨）→ 只能用**已知幾何**驗。

判準（把雨區放在指定方位/距離，給定移動向量，檢查回報的 ETA）
    ・會正面經過你 → 要報，且時間 = (沿程距離 − 邊緣提前量) / 速度，容許 ±3 分
    ・會從旁邊掠過 → **不准報時間**（可以留「往你移動」旗標，但不能掛假時間）
    容許 ±3 分：dist_km 只留到小數一位、方位換算有捨入，本來就不該追求分鐘級精確。

回傳碼：0 全對 / 1 有案例算錯 / 2 測試不成立
"""
import copy
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LAT, LON = 25.03, 121.55
TOL_MIN = 3


def _at(W, dist_km, brg, sid="s", level="中雨", mm=3.0, dx_km=0.0):
    """在使用者的 brg 方位、dist_km 處放一個有雨測站（dx_km＝再往東偏移，用來排成雨帶）。"""
    r = math.radians(brg)
    la = LAT + dist_km * math.cos(r) / 110.57
    lo = (LON + dist_km * math.sin(r) / (111.32 * math.cos(math.radians(LAT)))
          + dx_km / (111.32 * math.cos(math.radians(LAT))))
    return {"_lat": la, "_lon": lo, "_sid": sid, "level": level, "mmph": mm,
            "dist_km": round(W._haversine_km(LAT, LON, la, lo), 1),
            "dir": W._bearing_zh(brg), "name": sid, "area": ""}


def main() -> int:
    try:
        from routes import weather as W
    except Exception as e:
        print(f"✗ 匯入 routes.weather 失敗（{type(e).__name__}: {e}）→ 測試不成立")
        return 2

    def band(n, dist, brg, gap=10.0, level="大雨"):
        return [_at(W, dist, brg, f"b{i}", level, 8.0, (i - (n - 1) / 2) * gap) for i in range(n)]

    # (說明, 雨區, 移動bearing, 速度, 期望ETA分鐘 or None＝不准報, 用風向推估)
    CASES = [
        ("正南 20km 直直往你來",           [_at(W, 20, 180)],          0, 30, 30,   False),
        ("西南 8km 夾角65° 孤站雨胞",       [_at(W, 8, 245)],           0, 30, None, False),
        ("40km 寬雨帶 夾角50°",            band(5, 25, 230),           0, 30, 22,   False),
        ("30km 外 夾角40° 孤站",           [_at(W, 30, 220)],          0, 30, None, False),
        ("同上但只有風向推估（誤差錐較大）",   [_at(W, 30, 220)],          0, 30, None, True),
        ("幾乎正對 夾角5° 12km",           [_at(W, 12, 175)],          0, 30, 14,   False),
        ("72km 寬鋒面 40km 外 夾角35°",    band(7, 40, 215, 12.0),     0, 45, 37,   False),
        ("在你正北（已經過去了）",           [_at(W, 15, 0)],            0, 30, None, False),
    ]

    bad = []
    for label, cells, mb, spd, want, by_wind in CASES:
        motion = None if by_wind else {"bearing": mb, "speed_kmh": spd}
        wind = ((mb + 180) % 360, spd) if by_wind else None
        try:
            res = W._finalize_nearby(LAT, LON, copy.deepcopy(cells), 0.0, motion, "test", "T",
                                     wind=wind, coverage=None, far_cells=[])
        except Exception as e:
            print(f"   ✗ {label}：算的時候炸了（{type(e).__name__}: {e}）")
            bad.append((label, "拋例外")); continue
        appr = res.get("approaching")
        got = appr.get("eta_min") if appr else None
        if want is None:
            ok = got is None
            shown, expect = (f"約{got}分後到" if got is not None else "不報時間"), "不准報時間（斜掠而過）"
        else:
            ok = got is not None and abs(got - want) <= TOL_MIN
            shown, expect = (f"約{got}分後到" if got is not None else "不報時間"), f"約{want}分（±{TOL_MIN}）"
        print(f"   {'✓' if ok else '✗'} {label:26s} → {shown:10s} 應為 {expect}")
        if not ok:
            bad.append((label, f"回 {shown}，應 {expect}"))

    print()
    if bad:
        print("★ 雨區 ETA 算錯（使用者會看到不會到的雨說幾分後到，或真的要下了卻晚報）：")
        for label, why in bad:
            print(f"   {label}：{why}")
        return 1
    print(f"★ {len(CASES)} 個幾何案例全部正確：會經過的算得準、只是掠過的不掛假時間")
    return 0


if __name__ == "__main__":
    sys.exit(main())
