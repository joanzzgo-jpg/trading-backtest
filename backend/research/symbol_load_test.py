"""全標的 × 多時框 載入診斷：找出「找不到 / 沒回應(慢) / 空資料」的合約標的。

跑法：cd backend && python3 research/symbol_load_test.py
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data.crypto import (fetch_crypto_ohlcv, fetch_tickers,
                         _fetch_pionex_perp_symbols, _fetch_futures_tickers_fapi)

TFS = ["15m", "1h", "4h", "1d"]
SLOW = 6.0   # 秒，超過視為「慢/可能沒回應」


def main():
    tickers = fetch_tickers("futures")
    syms = [t["display"] for t in tickers]
    pset = _fetch_pionex_perp_symbols()
    bset = set(t["symbol"][:-4].upper() for t in _fetch_futures_tickers_fapi())
    exclusive = sorted(pset - bset)

    print(f"合約清單 {len(syms)} 個；Pionex 獨有(不在Binance) {len(exclusive)} 個：")
    print("  ", exclusive)
    print(f"\n測試 {len(syms)} 標的 × {len(TFS)} 時框 = {len(syms)*len(TFS)} 次載入...\n")

    fails = {}   # symbol -> [(tf, reason, sec)]
    for s in syms:
        for tf in TFS:
            try:
                t0 = time.time()
                df = fetch_crypto_ohlcv(s, tf, limit=120, exchange_id="pionex")
                dt = time.time() - t0
                if df.empty:
                    fails.setdefault(s, []).append((tf, "EMPTY", round(dt, 1)))
                elif dt > SLOW:
                    fails.setdefault(s, []).append((tf, "SLOW", round(dt, 1)))
            except Exception as e:
                dt = round(time.time() - t0, 1)
                fails.setdefault(s, []).append((tf, str(e)[:45], dt))

    print("=" * 60)
    if not fails:
        print("✅ 全部成功，無失敗/慢/空")
    else:
        print(f"⚠ 有問題的標的 {len(fails)} 個：")
        for s, probs in fails.items():
            tag = " [Pionex獨有]" if s.replace("/USDT.P", "").upper() in (pset - bset) else ""
            print(f"  {s}{tag}: {probs}")
    print("=" * 60)
    total = len(syms) * len(TFS)
    nfail = sum(len(v) for v in fails.values())
    print(f"成功 {total - nfail} / {total}")


if __name__ == "__main__":
    main()
