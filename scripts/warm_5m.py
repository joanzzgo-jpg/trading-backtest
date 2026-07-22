"""暖機 K 線倉庫(BTC/ETH/SOL/XAUT × 5m/4h/1d)。手動跑,存到 backend/data/klines5m/(版控)。

用法(在專案根)：
    backend/.venv312/bin/python scripts/warm_5m.py                 # 全標的 × 全時框(5m 1年、4h/1d 全歷史)
    backend/.venv312/bin/python scripts/warm_5m.py 60              # 5m 只抓最近 60 天(4h/1d 仍全)
    backend/.venv312/bin/python scripts/warm_5m.py 370 BTC        # 只 BTC
    backend/.venv312/bin/python scripts/warm_5m.py 370 ALL 4h,1d  # 只暖 4h/1d(快,幾MB)

放慢節奏避開限流;可重複跑(只補新的、自動去重)。暖完 commit 一次即可(隨 git 部署到 Railway、全用戶共用)。
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from data.crypto import fetch_crypto_ohlcv          # noqa: E402
from data import klines_store                        # noqa: E402

ALL = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XAUT/USDT"]
# 每時框:抓多深(天)、每塊多大(天)。4h/1d 根數少→大塊快;5m 根數多→小塊避限流。
TF_CFG = {"5m": (370, 25), "4h": (4000, 700), "1d": (4500, 2000)}
PAUSE = 1.2          # 每塊間隔秒(避限流)


def warm(sym: str, tf: str, days: int, chunk_days: int):
    start_limit = datetime.now(timezone.utc) - timedelta(days=days)
    end = datetime.now(timezone.utc)
    total = 0
    while end > start_limit:
        start = max(end - timedelta(days=chunk_days), start_limit)
        s, e = start.strftime("%Y-%m-%d"), (end + timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            df = fetch_crypto_ohlcv(sym, tf, s, e, "binance", limit=0)
        except Exception as ex:
            print(f"  {sym} {tf} {s}~{e} 失敗: {str(ex)[:80]}")
            df = None
        if df is not None and not df.empty:
            n = klines_store.save(sym, tf, df)
            total += len(df)
            print(f"  {sym} {tf} {s}~{e}: +{len(df):>5} 根  (倉庫共 {n})")
        else:
            print(f"  {sym} {tf} {s}~{e}: 空")
        end = start
        time.sleep(PAUSE)
    return total


if __name__ == "__main__":
    days_override = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    want = (sys.argv[2].upper() if len(sys.argv) > 2 else "ALL")
    syms = ALL if want == "ALL" else [x for x in ALL if x.startswith(want)]
    tfs = (sys.argv[3].split(",") if len(sys.argv) > 3 else list(TF_CFG.keys()))
    print(f"暖機倉庫:{syms} × {tfs}  → backend/data/klines5m/")
    for sym in syms:
        for tf in tfs:
            if tf not in TF_CFG:
                continue
            d, ck = TF_CFG[tf]
            d = days_override if (days_override and tf == "5m") else d   # 只有 5m 吃 days 覆寫(4h/1d 維持全歷史)
            print(f"=== {sym} {tf} (最近 {d} 天) ===")
            warm(sym, tf, d, ck)
    print("完成。commit 後隨 git 部署到 Railway、所有用戶共用;本機重啟即讀新庫。")
