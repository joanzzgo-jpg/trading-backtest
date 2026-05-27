"""強化版濾鏡研究：跨標的/時框，測哪種 est_rr 條件最能提高勝率又保留足夠樣本。

跑法：cd backend && python3 research/variant_study.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date, timedelta
from data.crypto import fetch_crypto_ohlcv
from utils.data import enrich_df
from utils.crt import _calc_crt_winrate

SYMBOLS = ["BTC/USDT.P", "ETH/USDT.P", "SOL/USDT.P", "BNB/USDT.P"]
TFS = [("1d", 1460), ("4h", 730), ("1h", 365)]


def _dedup_signals(signals):
    """同 (t,d) 去重（與總勝率同母體，S1 不計），回傳 [(rr, r)]（只取已結算）。"""
    seen = set(); out = []
    for s in sorted(signals, key=lambda x: x["t"]):
        if s["k"] == "abc":
            continue
        key = (s["t"], s["d"])
        if key in seen:
            continue
        seen.add(key)
        if s["r"] not in ("w", "l"):
            continue
        out.append((s.get("rr"), s["r"]))
    return out


def _wr(rows):
    w = sum(1 for _, r in rows if r == "w")
    t = len(rows)
    return (round(w / t * 100, 1) if t else None), w, t


def main():
    pool = []  # 全部去重訊號 (rr, r)
    for sym in SYMBOLS:
        for tf, days in TFS:
            try:
                end = date.today().isoformat()
                start = (date.today() - timedelta(days=days)).isoformat()
                df = fetch_crypto_ohlcv(sym, tf, start, end, "pionex")
                df = enrich_df(df)
                r = _calc_crt_winrate(df)
                rows = _dedup_signals(r["signals"])
                pool.extend(rows)
                wr, w, t = _wr(rows)
                print(f"  {sym} {tf}: {t} 筆, 勝率 {wr}%")
            except Exception as e:
                print(f"  {sym} {tf}: ERR {e}")

    rr_rows = [(rr, r) for rr, r in pool if rr is not None]
    base_wr, base_w, base_t = _wr(pool)
    print(f"\n=== 母體合計 {base_t} 筆，基準勝率 {base_wr}% （有 rr 值 {len(rr_rows)} 筆）===\n")

    print("【A】est_rr 分桶看勝率關係（驗證低 RR 是否真的高勝率）")
    bands = [(0, 0.5), (0.5, 0.8), (0.8, 1.0), (1.0, 1.3), (1.3, 1.6),
             (1.6, 2.0), (2.0, 3.0), (3.0, 99)]
    for lo, hi in bands:
        sub = [(rr, r) for rr, r in rr_rows if lo <= rr < hi]
        wr, w, t = _wr(sub)
        bar = "█" * int((wr or 0) / 3)
        print(f"  RR [{lo:>4}, {hi:>4}): {t:>5} 筆  勝率 {str(wr):>5}%  {bar}")

    print("\n【B】est_rr ≤ X 門檻掃描（勝率 / 保留率 / 提升）")
    for x in [0.5, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0]:
        sub = [(rr, r) for rr, r in rr_rows if rr <= x]
        wr, w, t = _wr(sub)
        keep = round(t / len(rr_rows) * 100, 1) if rr_rows else 0
        lift = round((wr - base_wr), 1) if wr is not None else None
        print(f"  RR≤{x:>3}: {t:>5} 筆  勝率 {str(wr):>5}%  保留 {keep:>5}%  提升 {lift:+}")

    print("\n【C】est_rr 區間（避免太近的雜訊）：lo ≤ RR ≤ hi")
    for lo, hi in [(0.3, 1.0), (0.4, 1.2), (0.5, 1.3), (0.5, 1.5), (0.6, 1.5)]:
        sub = [(rr, r) for rr, r in rr_rows if lo <= rr <= hi]
        wr, w, t = _wr(sub)
        keep = round(t / len(rr_rows) * 100, 1) if rr_rows else 0
        lift = round((wr - base_wr), 1) if wr is not None else None
        print(f"  {lo}≤RR≤{hi}: {t:>5} 筆  勝率 {str(wr):>5}%  保留 {keep:>5}%  提升 {lift:+}")


if __name__ == "__main__":
    main()
