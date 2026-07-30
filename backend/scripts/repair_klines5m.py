#!/usr/bin/env python3
"""K 線倉庫「破洞」掃描與修補（薄 CLI，邏輯在 data/klines_store.py）。

為什麼需要：倉庫檔（backend/data/klines5m/*.pkl.gz）是版控的、會一起上 Railway。
一旦某次暖機/回填在中途缺一塊，那個洞就被**固化進檔案**，之後所有讀倉庫的請求都拿到有洞的
資料 —— 不報錯、不拋例外，K 線只是「少一段」。2026-07-30 實測抓到 BTC 5m 缺 434 根、
BTC/ETH 4h 各缺 10 個月，全都已 commit 上線才被深滑 E2E 發現。

★診斷提醒：只有「請求範圍完全落在倉庫涵蓋內」時洞才會露出來。超出倉庫尾端的範圍會整段退 API
（API 沒洞）→ 查起來像沒事。所以「我查過沒事」不代表沒事。

用法（在 backend/ 下）：
    python scripts/repair_klines5m.py               # 只掃描（有洞回傳碼 1，可當推送前守門）
    python scripts/repair_klines5m.py --fix         # 掃描並補抓後存回
    python scripts/repair_klines5m.py --fix --tf 5m # 只處理 5m

補不回來的（資料源本身就沒有：標的上線前、交易所長時間停機）會列出但不當失敗。
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data.klines_store import (load_all, find_holes, repair_holes,  # noqa: E402
                               SYMBOLS, STORE_TFS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="實際補抓並寫回檔案（預設只掃描）")
    ap.add_argument("--tf", default="", help="只處理指定時框（如 5m）")
    ap.add_argument("--symbol", default="", help="只處理指定標的（如 BTC）")
    args = ap.parse_args()

    total = 0
    for sym in sorted(SYMBOLS):
        if args.symbol and not sym.upper().startswith(args.symbol.upper()):
            continue
        for tf in sorted(STORE_TFS):
            if args.tf and tf != args.tf:
                continue
            df = load_all(sym, tf)
            holes = find_holes(df, tf)
            n = 0 if df is None else len(df)
            rng = "" if df is None or df.empty else f" {df['time'].iloc[0]} ~ {df['time'].iloc[-1]}"
            print(f"  {sym} {tf}: {n} 根{rng}  破洞 {len(holes)}")
            if not holes:
                continue
            if not args.fix:
                for a, b, c in holes[:6]:
                    print(f"     {a} → {b}  缺 {c} 根")
                total += len(holes)
                continue
            before, left = repair_holes(sym, tf)
            after = load_all(sym, tf)
            print(f"     → 修補後 {0 if after is None else len(after)} 根，剩餘破洞 {left}")
            total += left

    label = "修補後剩餘" if args.fix else "目前"
    print(f"\n{label}破洞總數: {total}")
    return 1 if (total and not args.fix) else 0


if __name__ == "__main__":
    sys.exit(main())
