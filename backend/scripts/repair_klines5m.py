#!/usr/bin/env python3
"""5m/4h/1d 倉庫「破洞」偵測與修補。

為什麼需要：倉庫檔（backend/data/klines5m/*.pkl.gz）是版控的、會一起上 Railway。
一旦某次暖機/回填在中途斷掉，缺的那段就被**固化進檔案**，之後任何讀倉庫的請求都拿到有洞的
資料 —— 而且很難察覺（K 線只是「少一段」，不會報錯）。2026-07-30 實測就抓到 BTC 5m 缺 434 根
（2026-07-21 02:45 → 07-22 15:00）、XAUT 5m 缺 1608 根，兩者都已 commit 上線。

用法：
    python scripts/repair_klines5m.py            # 只檢查、不寫檔
    python scripts/repair_klines5m.py --fix      # 檢查並補抓缺口後存回

補不回來的缺口（資料源本身就沒有）會列出來但不當失敗 —— 例如標的上線前、交易所長時間停機。
"""
import sys
import os
import argparse
import datetime as dt

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pandas as pd
from data.klines_store import load_all, save, SYMBOLS, STORE_TFS  # noqa: E402
from data.crypto import fetch_crypto_ohlcv  # noqa: E402

_TF_SEC = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def find_holes(df, tf):
    """回傳 [(前一根, 後一根, 缺幾根)]；只看嚴格大於一格的間隔。"""
    sec = _TF_SEC.get(tf)
    if not sec or df is None or df.empty:
        return []
    t = df["time"].tolist()
    out = []
    for i in range(1, len(t)):
        gap = (t[i] - t[i - 1]).total_seconds()
        if gap > sec:
            out.append((t[i - 1], t[i], int(gap // sec) - 1))
    return out


def repair(sym, tf, exchange="binance", pad_days=1):
    df = load_all(sym, tf)
    if df is None or df.empty:
        print(f"  {sym} {tf}: 無倉庫檔，略過")
        return 0, 0
    holes = find_holes(df, tf)
    if not holes:
        print(f"  {sym} {tf}: {len(df)} 根，無破洞 ✓")
        return 0, 0
    print(f"  {sym} {tf}: {len(df)} 根，破洞 {len(holes)} 個")
    fixed = 0
    for a, b, n in holes:
        # 兩側各留 pad_days 天邊際 → 一定與既有資料重疊，drop_duplicates 會處理掉
        s = (a - pd.Timedelta(days=pad_days)).strftime("%Y-%m-%d")
        e = (b + pd.Timedelta(days=pad_days)).strftime("%Y-%m-%d")
        print(f"     補 {a} → {b}（缺 {n} 根）以 {s}~{e} 重抓 …", end=" ", flush=True)
        try:
            got = fetch_crypto_ohlcv(sym, tf, s, e, exchange)
        except Exception as ex:
            print(f"失敗（{ex}）")
            continue
        if got is None or got.empty:
            print("資料源沒有這段")
            continue
        # 只留真正落在缺口內的，避免把邊際資料當成「補到了」
        inside = got[(got["time"] > a) & (got["time"] < b)]
        print(f"抓到 {len(got)} 根，其中缺口內 {len(inside)} 根")
        if len(inside):
            save(sym, tf, got)
            fixed += 1
    after = load_all(sym, tf)
    left = find_holes(after, tf)
    print(f"     → 修補後 {len(after)} 根，剩餘破洞 {len(left)}")
    for a, b, n in left:
        print(f"        補不回來: {a} → {b}（缺 {n} 根，資料源無此段）")
    return len(holes), len(left)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="實際補抓並寫回檔案（預設只檢查）")
    ap.add_argument("--tf", default="", help="只處理指定時框（如 5m）")
    args = ap.parse_args()

    total_holes = 0
    for sym in sorted(SYMBOLS):
        for tf in sorted(STORE_TFS):
            if args.tf and tf != args.tf:
                continue
            if args.fix:
                h, left = repair(sym, tf)
                total_holes += left
            else:
                df = load_all(sym, tf)
                holes = find_holes(df, tf)
                total_holes += len(holes)
                n = 0 if df is None else len(df)
                rng = "" if df is None or df.empty else f" {df['time'].iloc[0]} ~ {df['time'].iloc[-1]}"
                print(f"  {sym} {tf}: {n} 根{rng}  破洞 {len(holes)}")
                for a, b, c in holes[:5]:
                    print(f"     {a} → {b}  缺 {c} 根")
    print(f"\n{'修補後剩餘' if args.fix else '目前'}破洞總數: {total_holes}")
    return 1 if (total_holes and not args.fix) else 0


if __name__ == "__main__":
    sys.exit(main())
