#!/usr/bin/env python3
"""勝率／策略標記計算（utils/crt.py `_calc_crt_winrate`）的「黃金輸出」守門員。

用法：
    cd backend && ../.venv312/bin/python scripts/check_crt_golden.py            # 比對；有任何一組不同 → 回傳碼 1
    cd backend && ../.venv312/bin/python scripts/check_crt_golden.py --update   # **刻意**改了標記邏輯後才用：重寫指紋

★為什麼需要這支（2026-09-17）：
  crt.py 一直在做「輸出不可以變」的效能優化（刪沒人讀的圖層、逐根迴圈改跳躍查詢…），
  每次都靠臨時腳本拿舊版逐位元比對。標記錯了畫面上**完全看不出來**（K 棒上照樣有多/空/順標記，
  只是少幾個或位置不同），而那正是這個回測工具的核心輸出。→ 把比對固定下來。
  判準＝固定歷史區段 × 參數變體的**整份輸出 JSON 雜湊**，任何一個標記、任何一個欄位不同都算失敗。

⚠ 資料只用 K 線倉庫裡 4h／1d 的**固定歷史區段**（2017/2019 起完整保留、只會往尾端長）；
  5m 倉庫會滾動砍頭（_KEEP_DAYS=370），不能用。倉庫缺了這些區段 → 回傳碼 2（測試不成立）。
⚠ 注入 NaN 的變體必留：跳躍查詢那類優化最容易在「資料空洞」時跟逐根版分岔。
⚠ 看到失敗先問「我是不是刻意改了標記邏輯」：是 → --update 並在 commit 訊息寫明哪些標記變了、為什麼；
  不是 → 那就是 bug，不可以 --update 蓋掉。
"""
import sys
import os
import json
import hashlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np                                            # noqa: E402
import pandas as pd                                           # noqa: E402
from data import klines_store                                 # noqa: E402
from utils.crt import _calc_crt_winrate                       # noqa: E402

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crt_golden.json")

# (名稱, 標的, 時框, 起, 迄, 參數, 注入NaN比例)
CASES = [
    ("BTC 4h 2021~2024",            "BTC/USDT", "4h", "2021-01-01", "2024-12-31", {}, 0),
    ("ETH 4h 2022~2025H1",          "ETH/USDT", "4h", "2022-01-01", "2025-06-30", {}, 0),
    ("BTC 1d 2020~2025",            "BTC/USDT", "1d", "2020-01-01", "2025-12-31", {}, 0),
    ("BTC 4h no_proto_ms/break",    "BTC/USDT", "4h", "2023-01-01", "2024-12-31", {"no_proto_ms": True, "no_proto_break": True}, 0),
    ("ETH 4h stock_gap+long_only",  "ETH/USDT", "4h", "2023-01-01", "2024-12-31", {"stock_gap": True, "long_only": True}, 0),
    ("BTC 4h visual_window=2000",   "BTC/USDT", "4h", "2021-01-01", "2024-12-31", {"visual_window": 2000}, 0),
    ("BTC 4h 注入 1% NaN",          "BTC/USDT", "4h", "2021-01-01", "2024-12-31", {}, 0.01),
    ("ETH 4h 注入 2% NaN",          "ETH/USDT", "4h", "2022-01-01", "2024-12-31", {}, 0.02),
]


def _frame(sym, tf, a, b, nan_ratio):
    d = klines_store.load_all(sym, tf)
    if d is None or not len(d):
        return None
    if "time" not in d.columns:
        d = d.reset_index().rename(columns={d.index.name or "index": "time"})
    t = pd.to_datetime(d["time"])
    d = d[(t >= a) & (t <= b + " 23:59:59")].reset_index(drop=True)
    if nan_ratio:
        rng = np.random.default_rng(20260917)                 # 固定種子 → 每次注入同一批位置
        idx = rng.choice(len(d), size=int(len(d) * nan_ratio), replace=False)
        for c in ("open", "high", "low", "close"):
            d.loc[idx, c] = np.nan
    return d


def main():
    update = "--update" in sys.argv
    golden = {}
    if os.path.exists(GOLDEN) and not update:
        golden = json.load(open(GOLDEN, encoding="utf-8"))
    out, fails, invalid = {}, [], []
    for name, sym, tf, a, b, kw, nr in CASES:
        d = _frame(sym, tf, a, b, nr)
        if d is None or len(d) < 500:
            invalid.append(name)
            print(f"  ⊘ {name}  — 倉庫缺這段資料（{0 if d is None else len(d)} 根）")
            continue
        r = _calc_crt_winrate(d.copy(), **kw)
        h = hashlib.sha256(json.dumps(r, sort_keys=True, default=str).encode()).hexdigest()[:20]
        counts = {k: len(r.get(k) or []) for k in ("fvg", "fvg_ms", "fvg_break", "fvg_shun", "fvg_special", "fvg_sigs")}
        out[name] = {"bars": len(d), "hash": h, "counts": counts}
        if update:
            print(f"  ✎ {name}  — {len(d)} 根 {h}  {counts}")
            continue
        g = golden.get(name)
        if not g:
            invalid.append(name)
            print(f"  ⊘ {name}  — 沒有黃金指紋（先跑 --update）")
        elif g["bars"] != len(d):
            invalid.append(name)
            print(f"  ⊘ {name}  — 資料根數變了 {g['bars']} → {len(d)}（倉庫被改過？測試不成立）")
        elif g["hash"] != h:
            fails.append(name)
            diff = {k: f"{g['counts'].get(k)}→{v}" for k, v in counts.items() if g["counts"].get(k) != v}
            print(f"  ✗ {name}  — 輸出變了 {g['hash']} → {h}；筆數差異 {diff or '（筆數相同、內容不同）'}")
        else:
            print(f"  ✓ {name}  — {len(d)} 根，輸出與黃金指紋逐位元相同")
    if update:
        json.dump(out, open(GOLDEN, "w", encoding="utf-8"), ensure_ascii=False, indent=1, sort_keys=True)
        print(f"\n★ 已寫入 {GOLDEN}（{len(out)} 組）")
        return 0
    if fails:
        print(f"\n★ 失敗 {len(fails)} 項：{fails}\n  → 刻意改了標記邏輯才可以 --update；否則是 bug。")
        return 1
    if invalid:
        print(f"\n★ 測試不成立 {len(invalid)} 項（回傳碼 2，不是通過）：{invalid}")
        return 2
    print(f"\n★ 勝率/標記計算輸出與黃金指紋全部相同（{len(out)} 組）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
