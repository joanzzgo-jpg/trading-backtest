#!/usr/bin/env python3
"""股票資料來源守門員（台股為主，兼驗美股/港股同類坑）——
動到 data/taiwan.py、data/us_stock.py 或 routes/data.py 的股票段就跑這支。

用法：
    cd backend && ../.venv312/bin/python scripts/check_tw_sources.py
    有任何一項失敗 → 回傳碼 1。

★為什麼需要這支（2026-08-01）：
  台股這塊接連出過兩次「安靜壞掉」的問題，共同點是**跑一輪看起來完全正常**，
  要跨輪、跨呼叫端的順序才會現形：
    ① 30m/2h 拿到的其實是日線（時框閘門漏列）——切過去圖還是有東西，不報錯。
    ② 條件式抓取的 ETag 與解析結果分家 → 清單從 1972 檔掉到 50 檔，而且因為來源檔案
       內容真的沒變會一直 304，**自己不會好**。
  兩個都是「單輪測試」抓不到的，所以這支專測「多輪 + 不同呼叫順序」。
"""
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import data.taiwan as TW                                    # noqa: E402
from routes.data import fetch_crt_df                        # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'✓' if ok else '✗'} {name}{('  — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def reset():
    TW._TW_DAY_ALL.update({"ts": 0.0, "date": None, "rows": {}})
    TW._TW_DAY_SRC.clear()
    TW._TW_DUMP.clear()
    TW._TW_TICKER_PEAK["n"] = 0


print("① 清單基本盤")
reset()
tk = TW.fetch_tw_tickers()
n0 = len(tk)
check("抓得到全台股清單", n0 > 1500, f"{n0} 檔")
zero = [x for x in tk if x.get("volume", 0) == 0]
check("成交量不得整批為 0（上櫃欄位名曾寫錯）", len(zero) == 0, f"量=0 的 {len(zero)} 檔")

print("\n② 條件式抓取：連跑多輪不得縮水（304 快速路徑）")
reset()          # ★必須先清掉，否則第 1 輪已經是 304，等於拿 304 比 304
sizes, times = [], []
for _ in range(3):
    t = time.perf_counter()
    sizes.append(len(TW.fetch_tw_tickers()))
    times.append(time.perf_counter() - t)
check("三輪筆數一致", len(set(sizes)) == 1, f"{sizes}")
check("第 2 輪明顯變快（代表 304 生效）", times[1] < times[0] * 0.5,
      f"{times[0]:.2f}s → {times[1]:.2f}s")

print("\n③ 兩個呼叫端交錯（ETag 與解析結果分家會在這裡爆）")
for order in (("備援", "清單"), ("清單", "備援")):
    reset()
    for who in order:
        TW._tw_day_all_refresh() if who == "備援" else TW.fetch_tw_tickers()
    n = len(TW.fetch_tw_tickers())
    d = len(TW._TW_DAY_ALL["rows"])
    check(f"順序 {order[0]}→{order[1]}：清單與日線都完整", n > 1500 and d > 1500, f"清單 {n} 檔 / 日線 {d} 檔")

print("\n④ 日線快取：兩包分屬不同交易日時不得混用日期")
reset()
TW.fetch_tw_tickers()
import datetime                                              # noqa: E402
if TW._TW_DAY_SRC.get(TW.TPEX_DAY_ALL_URL):
    real = TW._TW_DAY_ALL["date"]
    TW._TW_DAY_SRC[TW.TPEX_DAY_ALL_URL]["date"] = real - datetime.timedelta(days=1)
    TW._day_commit()
    otc = any(c in TW._TW_DAY_ALL["rows"] for c in ("6488", "5483"))
    check("舊日期那包被排除（不會補出日期錯的 K 棒）",
          TW._TW_DAY_ALL["date"] == real and not otc,
          f"date={TW._TW_DAY_ALL['date']} 含上櫃={otc}")

print("\n⑤ 縮水自我復原守門")
reset()
TW.fetch_tw_tickers()
peak = TW._TW_TICKER_PEAK["n"]
_fake = {"0001": {"symbol": "0001", "display": "0001", "name": "假的",
                  "price": 1.0, "change_pct": 0.0, "change_amt": 0.0, "volume": 0.0}}
TW._TW_DUMP[(TW.TWSE_DAY_ALL_URL, TW.DUMP_TICKERS)]["payload"] = _fake
TW._TW_DUMP[(TW.TPEX_DAY_ALL_URL, TW.DUMP_TICKERS)]["payload"] = {}
small = len(TW.fetch_tw_tickers())
check("偵測到縮水並清掉條件式快取", not TW._TW_DUMP, f"高水位 {peak} → 這輪 {small} 檔")
recovered = len(TW.fetch_tw_tickers())
check("下一輪自動復原", recovered > 1500, f"{recovered} 檔")

print("\n⑥ 各時框分桶（30m/2h 曾經拿到的是日線）")
EXPECT = {"5m": (40, 60), "15m": (15, 22), "30m": (8, 12), "1h": (4, 6), "2h": (2, 4), "4h": (1, 3), "1d": (1, 1)}
import pandas as pd                                          # noqa: E402
for tf, (lo, hi) in EXPECT.items():
    try:
        df = fetch_crt_df("tw", "2330", tf, 60)
        if df is None or df.empty:
            check(f"{tf} 有資料", False, "空")
            continue
        t = pd.to_datetime(df["time"])
        last = t.dt.date.max()
        cnt = int((t.dt.date == last).sum())
        check(f"{tf} 最後交易日 {cnt} 根（預期 {lo}~{hi}）", lo <= cnt <= hi, f"{last}")
    except Exception as e:
        check(f"{tf} 有資料", False, f"{type(e).__name__}: {e}")

print("\n⑦ 美股／港股同一個坑（30m/2h 曾經也是日線）")
US_EXPECT = {"15m": (20, 30), "30m": (11, 15), "1h": (6, 8), "2h": (3, 5), "4h": (2, 3), "1d": (1, 1)}
for mkt, sym in (("us", "AAPL"), ("hk", "0700.HK")):
    for tf, (lo, hi) in US_EXPECT.items():
        try:
            df = fetch_crt_df(mkt, sym, tf, 30)
            if df is None or df.empty:
                check(f"{mkt} {tf} 有資料", False, "空")
                continue
            t = pd.to_datetime(df["time"])
            last = t.dt.date.max()
            cnt = int((t.dt.date == last).sum())
            check(f"{mkt} {tf} 最後交易日 {cnt} 根（預期 {lo}~{hi}）", lo <= cnt <= hi, f"{last}")
        except Exception as e:
            check(f"{mkt} {tf} 有資料", False, f"{type(e).__name__}: {e}")

print()
if FAILS:
    print(f"★ 失敗 {len(FAILS)} 項：{FAILS}")
    sys.exit(1)
print("★ 台股來源全部通過")
