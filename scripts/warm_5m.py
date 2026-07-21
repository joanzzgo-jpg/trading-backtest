"""暖機本機 5m 倉庫(BTC/ETH/SOL 各約 1 年)。只本機、手動跑。

用法(在專案根)：
    backend/.venv312/bin/python scripts/warm_5m.py            # 三個各 1 年
    backend/.venv312/bin/python scripts/warm_5m.py 60         # 只抓最近 60 天(快速測試)
    backend/.venv312/bin/python scripts/warm_5m.py 370 BTC    # 只 BTC、1 年

放慢節奏避開交易所限流;可重複跑(只補新的、自動去重)。存到 backend/.klines5m/。
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from data.crypto import fetch_crypto_ohlcv          # noqa: E402
from data import klines_store                        # noqa: E402

ALL = ["BTC/USDT", "ETH/USDT", "SOL/USDT"]
CHUNK_DAYS = 25
PAUSE = 1.5          # 每塊間隔秒(避限流)


def warm(sym: str, days: int):
    start_limit = datetime.now(timezone.utc) - timedelta(days=days)
    end = datetime.now(timezone.utc)
    total = 0
    while end > start_limit:
        start = max(end - timedelta(days=CHUNK_DAYS), start_limit)
        s, e = start.strftime("%Y-%m-%d"), (end + timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            df = fetch_crypto_ohlcv(sym, "5m", s, e, "binance", limit=0)
        except Exception as ex:
            print(f"  {sym} {s}~{e} 失敗: {str(ex)[:80]}")
            df = None
        if df is not None and not df.empty:
            n = klines_store.save(sym, df)
            total += len(df)
            print(f"  {sym} {s}~{e}: +{len(df):>5} 根  (倉庫共 {n})")
        else:
            print(f"  {sym} {s}~{e}: 空")
        end = start
        time.sleep(PAUSE)
    return total


if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 370
    if len(sys.argv) > 2:
        want = sys.argv[2].upper()
        syms = [x for x in ALL if x.startswith(want)]
    else:
        syms = ALL
    print(f"暖機 5m 倉庫：{syms}  最近 {days} 天  →  backend/.klines5m/")
    for sym in syms:
        print(f"=== {sym} ===")
        warm(sym, days)
    print("完成。重啟本機服務後,crypto 5m 歷史回填會優先讀倉庫(秒開)。")
