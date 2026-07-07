"""S6 安靜棒數研究：比較 1/2/3/4 根安靜棒對勝率的影響。

S6 原邏輯：N 根「全無指標」K 棒 + 1 根「CRT 反轉 + 觸 BB 軌」訊號棒。
本研究跨多個加密貨幣標的與時間框架，比較 N=1/2/3/4 哪個勝率最高、樣本足夠。

跑法：cd backend && python3 research/s6_quiet_bars_study.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date, timedelta
import math
import numpy as np
import pandas as pd

from data.crypto import fetch_crypto_ohlcv
from utils.data import enrich_df
from utils.crt import _scan_outcome_np, _scan_outcome_fixed

# 跨主流幣 + 部分 alt：12 個標的
SYMBOLS = [
    "BTC/USDT.P", "ETH/USDT.P", "SOL/USDT.P", "BNB/USDT.P",
    "XRP/USDT.P", "DOGE/USDT.P", "ADA/USDT.P", "AVAX/USDT.P",
    "LINK/USDT.P", "MATIC/USDT.P", "ATOM/USDT.P", "DOT/USDT.P",
]
TFS = [("1d", 1460), ("4h", 730), ("1h", 365)]


def scan_s6(df: pd.DataFrame, quiet_bars: int):
    """掃描 N 根安靜棒版本 S6，回傳 [(direction, result)]。result ∈ {'win','loss'}"""
    n = len(df)
    total_bars = quiet_bars + 1   # quiet + signal bar
    if n < total_bars + 1:        # 還需 i+1 進場棒
        return []

    crt   = df["crt"].fillna(0).astype(np.int8).to_numpy()
    cross = df["kdj_cross"].fillna(0).astype(np.int8).to_numpy()
    res   = df["resonance"].fillna(0).astype(np.int8).to_numpy()
    highs = df["high"].to_numpy(dtype=float)
    lows  = df["low"].to_numpy(dtype=float)
    closes= df["close"].to_numpy(dtype=float)
    opens = df["open"].to_numpy(dtype=float) if "open" in df.columns else closes
    bbm   = df["bb_middle"].to_numpy(dtype=float)
    bbu   = df["bb_upper"].to_numpy(dtype=float)
    bbl   = df["bb_lower"].to_numpy(dtype=float)
    try:
        times_iso = df["time"].to_numpy("datetime64[s]").astype(str).tolist()
    except Exception:
        times_iso = [str(t) for t in df["time"]]

    out = []
    last_i = n - total_bars - 1   # 進場棒不超出
    for i in range(0, last_i + 1):
        # 前 quiet_bars 根全無指標
        ok = True
        for j in range(quiet_bars):
            idx = i + j
            if crt[idx] != 0 or cross[idx] != 0 or res[idx] != 0:
                ok = False; break
        if not ok:
            continue
        c_idx = i + quiet_bars
        c_crt = int(crt[c_idx])
        bbm_c = bbm[c_idx]; bbu_c = bbu[c_idx]; bbl_c = bbl[c_idx]
        if math.isnan(bbm_c):
            continue
        if c_crt == -1:
            if math.isnan(bbu_c): continue
            if not (highs[c_idx] >= bbu_c and lows[c_idx] > bbm_c):
                continue
            direction = "short"
            stop_px = float(np.max(highs[i:c_idx+1]))
        elif c_crt == 1:
            if math.isnan(bbl_c): continue
            if not (lows[c_idx] <= bbl_c and highs[c_idx] < bbm_c):
                continue
            direction = "long"
            stop_px = float(np.min(lows[i:c_idx+1]))
        else:
            continue
        entry_i = c_idx + 1
        if entry_i >= n:
            continue
        result, _, _ = _scan_outcome_np(highs, lows, closes, bbm, times_iso,
                                          entry_i, n, stop_px, direction)
        if result in ("win", "loss"):
            out.append((direction, result))
    return out


def _wr(rows):
    w = sum(1 for _, r in rows if r == "win")
    t = len(rows)
    return (round(w / t * 100, 1) if t else None), w, t


def main():
    QUIET_OPTIONS = [1, 2, 3, 4]
    aggregate = {q: [] for q in QUIET_OPTIONS}   # quiet_bars → 全部 (d, r) rows
    per_sym = {}                                  # (sym, tf) → {q: rows}

    print("\n══ S6 安靜棒數研究 ══")
    print(f"標的: {len(SYMBOLS)} 個 × 時框: {len(TFS)} 種 = {len(SYMBOLS)*len(TFS)} 組")
    print(f"安靜棒選項: {QUIET_OPTIONS}")
    print()

    for sym in SYMBOLS:
        for tf, days in TFS:
            try:
                end = date.today().isoformat()
                start = (date.today() - timedelta(days=days)).isoformat()
                df = fetch_crypto_ohlcv(sym, tf, start, end, "pionex")
                df = enrich_df(df, signals=True)   # 研究用:需 crt/kdj_cross/resonance 訊號欄
                row = {}
                for q in QUIET_OPTIONS:
                    rows = scan_s6(df, q)
                    aggregate[q].extend(rows)
                    row[q] = rows
                per_sym[(sym, tf)] = row
                stats = " | ".join(f"q={q}:{_wr(row[q])[0]}%({_wr(row[q])[2]})" for q in QUIET_OPTIONS)
                print(f"  {sym:<14} {tf:>3}  {stats}")
            except Exception as e:
                print(f"  {sym:<14} {tf:>3}  ERR {e}")

    print("\n══ 跨全標的合計 ══")
    print(f"{'安靜棒':>6} | {'勝':>5} | {'敗':>5} | {'總':>5} | {'勝率':>6} | 圖示")
    print("-" * 60)
    base = None
    for q in QUIET_OPTIONS:
        wr, w, t = _wr(aggregate[q])
        l = t - w
        bar = "█" * int((wr or 0) / 2)
        marker = " ★" if base is not None and wr and wr > base else ""
        if base is None: base = wr
        print(f"  q={q:>3} | {w:>5} | {l:>5} | {t:>5} | {str(wr):>5}% | {bar}{marker}")

    print("\n══ 方向分解（空/多）══")
    for q in QUIET_OPTIONS:
        rows = aggregate[q]
        s_rows = [r for r in rows if r[0] == "short"]
        l_rows = [r for r in rows if r[0] == "long"]
        s_wr = _wr(s_rows); l_wr = _wr(l_rows)
        print(f"  q={q}: 空 {s_wr[0]}% ({s_wr[2]}筆)  多 {l_wr[0]}% ({l_wr[2]}筆)")

    print("\n══ 各時框分解 ══")
    for tf, _ in TFS:
        print(f"\n  {tf}:")
        for q in QUIET_OPTIONS:
            rows = []
            for sym in SYMBOLS:
                rows.extend(per_sym.get((sym, tf), {}).get(q, []))
            wr, w, t = _wr(rows)
            print(f"    q={q}: {wr}% ({t} 筆)")

    print("\n══ 結論建議 ══")
    sorted_q = sorted(QUIET_OPTIONS, key=lambda q: (_wr(aggregate[q])[0] or 0), reverse=True)
    best = sorted_q[0]
    best_wr = _wr(aggregate[best])
    cur_wr = _wr(aggregate[2])
    print(f"  最高勝率：q={best}，{best_wr[0]}%（{best_wr[2]} 筆）")
    print(f"  目前版本：q=2，{cur_wr[0]}%（{cur_wr[2]} 筆）")
    if best != 2 and best_wr[2] >= 40:
        diff = best_wr[0] - cur_wr[0]
        keep = round(best_wr[2] / cur_wr[2] * 100, 1) if cur_wr[2] else 0
        print(f"  → 切換到 q={best} 可提升 {diff:+.1f}% 勝率，保留 {keep}% 樣本")
    else:
        print("  → 維持目前 q=2 設定")


if __name__ == "__main__":
    main()
