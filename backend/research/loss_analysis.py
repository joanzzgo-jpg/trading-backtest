"""S1-S7 失敗訊號共同點分析

目的：把每個訊號的 win/loss 結果配上「訊號當下的市場特徵」，找出輸的訊號集中
出現在哪些情境，作為下一輪 filter 的依據。

特徵列表（皆於訊號棒當下計算）：
1. BB 寬度（標準化）：(bb_upper - bb_lower) / close
2. ATR14 / close：波動度
3. 預估 RR：|entry_open - bb_middle| / |entry_open - stop|
4. 訊號棒結構：body / (high-low)、upper_wick / range、lower_wick / range
5. 訊號棒方向收盤：close / (high+low)/2
6. 量能：volume / volume_ma20
7. 趨勢方向：close - sma50 (>0 = 短期向上，<0 = 向下)
8. BB 中軌斜率（5 根 K 棒）
9. RSI14 at signal bar
10. KDJ K 值 at signal bar

CLI：
    python -m research.loss_analysis --market crypto --symbol BTC/USDT --tf 1h
"""
from __future__ import annotations
import argparse
import os
import sys
from datetime import date, timedelta
from collections import defaultdict

import numpy as np
import pandas as pd

_HERE = os.path.dirname(__file__)
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from utils.crt import _calc_crt_winrate  # noqa
from utils.data import enrich_df  # noqa
from research.ai_strategy import fetch_history_df  # noqa


def _compute_features(df: pd.DataFrame) -> dict:
    """為每根 K 棒預先算好所有特徵欄位（O(n) 一次完成）"""
    n = len(df)
    o = df["open"].to_numpy(dtype=float)
    h = df["high"].to_numpy(dtype=float)
    l = df["low"].to_numpy(dtype=float)
    c = df["close"].to_numpy(dtype=float)
    v = df["volume"].to_numpy(dtype=float)
    bb_u = df["bb_upper"].to_numpy(dtype=float)
    bb_m = df["bb_middle"].to_numpy(dtype=float)
    bb_l = df["bb_lower"].to_numpy(dtype=float)
    rsi  = df.get("rsi_14", pd.Series([np.nan]*n)).to_numpy(dtype=float)
    kdj_k = df.get("kdj_k", pd.Series([np.nan]*n)).to_numpy(dtype=float)

    bb_width_pct = (bb_u - bb_l) / np.where(c == 0, np.nan, c)

    # ATR14（簡化版：用 close-to-close 變化 rolling 14）
    tr = np.maximum.reduce([h - l,
                            np.abs(h - np.roll(c, 1)),
                            np.abs(l - np.roll(c, 1))])
    tr[0] = h[0] - l[0]
    atr14 = pd.Series(tr).ewm(span=14, adjust=False).mean().to_numpy()
    atr_pct = atr14 / np.where(c == 0, np.nan, c)

    rng = h - l
    body = np.abs(c - o)
    upper_wick = h - np.maximum(o, c)
    lower_wick = np.minimum(o, c) - l
    body_pct = body / np.where(rng == 0, np.nan, rng)
    uw_pct = upper_wick / np.where(rng == 0, np.nan, rng)
    lw_pct = lower_wick / np.where(rng == 0, np.nan, rng)
    close_in_range = (c - l) / np.where(rng == 0, np.nan, rng)  # 0=收最低 1=收最高

    # 量能比
    vol_ma20 = np.full(n, np.nan, dtype=float)
    if n >= 20:
        cs = np.cumsum(v)
        vol_ma20[19:] = (cs[19:] - np.concatenate([[0.0], cs[:-20]])) / 20.0
    vol_ratio = v / np.where(np.isnan(vol_ma20) | (vol_ma20 == 0), np.nan, vol_ma20)

    # 短期趨勢：close - SMA50
    sma50 = pd.Series(c).rolling(50).mean().to_numpy()
    trend_dev = (c - sma50) / np.where(c == 0, np.nan, c)  # 標準化偏差

    # BB middle 斜率（5 K 棒）
    bb_m_slope = np.full(n, np.nan, dtype=float)
    bb_m_slope[5:] = (bb_m[5:] - bb_m[:-5]) / np.where(c[5:] == 0, np.nan, c[5:])

    return dict(
        bb_width_pct=bb_width_pct, atr_pct=atr_pct,
        body_pct=body_pct, uw_pct=uw_pct, lw_pct=lw_pct,
        close_in_range=close_in_range,
        vol_ratio=vol_ratio, trend_dev=trend_dev,
        bb_m_slope=bb_m_slope, rsi=rsi, kdj_k=kdj_k,
        opens=o, highs=h, lows=l, closes=c, bb_m=bb_m,
        times=df["time"].astype(str).tolist(),
    )


def _signal_bar_index(s: dict) -> int | None:
    """從訊號回推訊號棒在 df 的索引：用 ohlcvData.time == s.t 比對"""
    return None  # 由外部 caller 提供 index map


def _build_time_idx(df: pd.DataFrame) -> dict:
    """signal.t 是 ISO 格式（含 T），df.time 是 pd.Timestamp，需用 isoformat 對齊"""
    out = {}
    for i, t in enumerate(df["time"]):
        if hasattr(t, "isoformat"):
            out[t.isoformat()] = i
        else:
            out[str(t)] = i
    return out


def _entry_idx_for(sig_k: str, signal_idx: int) -> int:
    """訊號棒 → 進場棒索引（依訊號類型）"""
    # abc: i+1; ab/s7: signal=B at i+1, entry=i+2 (so entry = signal_idx+1)
    # s3/4/5/7: signal=C at i+2, entry=i+3 (entry = signal_idx+1)
    # s6: signal=D at i+3, entry=i+4 (entry = signal_idx+1)
    # 統一：entry = signal_idx + 1
    return signal_idx + 1


def analyze(df: pd.DataFrame, result: dict) -> pd.DataFrame:
    """回傳 features × outcome DataFrame，可篩 win/loss 比較"""
    feats = _compute_features(df)
    tidx  = _build_time_idx(df)

    rows = []
    for s in result.get("signals", []):
        # 同時看中軌與帶軌結果
        sig_t = s["t"]
        sig_idx = tidx.get(sig_t)
        if sig_idx is None:
            continue
        entry_idx = _entry_idx_for(s["k"], sig_idx)
        if entry_idx >= len(df):
            continue

        # 預估 RR（中軌）
        entry_px = feats["opens"][entry_idx]
        bb_mid_at_entry = feats["bb_m"][entry_idx]
        if s["d"] == "s":
            stop_px = feats["highs"][sig_idx]  # 不加 buf 簡化
        else:
            stop_px = feats["lows"][sig_idx]
        risk = abs(entry_px - stop_px)
        reward = abs(entry_px - bb_mid_at_entry) if not np.isnan(bb_mid_at_entry) else 0
        est_rr = (reward / risk) if risk > 1e-9 else np.nan
        est_rr = min(est_rr, 10) if not np.isnan(est_rr) else np.nan  # cap

        rows.append({
            "k": s["k"],
            "d": s["d"],
            "r_mid":  s.get("r"),
            "r_band": s.get("r_b"),
            "v":      s.get("v", False),
            "bb_width":  feats["bb_width_pct"][sig_idx],
            "atr_pct":   feats["atr_pct"][sig_idx],
            "body_pct":  feats["body_pct"][sig_idx],
            "uw_pct":    feats["uw_pct"][sig_idx],
            "lw_pct":    feats["lw_pct"][sig_idx],
            "close_in_r": feats["close_in_range"][sig_idx],
            "vol_ratio": feats["vol_ratio"][sig_idx],
            "trend_dev": feats["trend_dev"][sig_idx],
            "bb_slope":  feats["bb_m_slope"][sig_idx],
            "rsi":       feats["rsi"][sig_idx],
            "kdj_k":     feats["kdj_k"][sig_idx],
            "est_rr":    est_rr,
        })
    return pd.DataFrame(rows)


def _compare_groups(df_f: pd.DataFrame, feat_cols: list[str]) -> pd.DataFrame:
    """比較 win vs loss 兩組在每個 feature 的中位數差異"""
    out = []
    for col in feat_cols:
        for outcome_col, label in (("r_mid", "中軌"), ("r_band", "上下軌")):
            wins = df_f[df_f[outcome_col] == "w"][col].dropna()
            loss = df_f[df_f[outcome_col] == "l"][col].dropna()
            if len(wins) < 10 or len(loss) < 10:
                continue
            w_med, l_med = wins.median(), loss.median()
            w_mean, l_mean = wins.mean(), loss.mean()
            # 用相對差衡量；用兩組 std 做粗略 effect size
            pooled_std = np.sqrt((wins.std() ** 2 + loss.std() ** 2) / 2)
            effect = (w_mean - l_mean) / pooled_std if pooled_std > 1e-9 else 0
            out.append({
                "feature": col, "target": label,
                "win_med":  round(w_med, 4),
                "loss_med": round(l_med, 4),
                "win_mean": round(w_mean, 4),
                "loss_mean":round(l_mean, 4),
                "effect":   round(effect, 2),
                "n_win":    len(wins),
                "n_loss":   len(loss),
            })
    return pd.DataFrame(out).sort_values("effect", key=lambda c: c.abs(), ascending=False)


def _per_signal_breakdown(df_f: pd.DataFrame) -> pd.DataFrame:
    """每個訊號類型的 win/loss 在關鍵特徵上的差異（用 effect size 排序）"""
    key_feats = ["est_rr", "bb_width", "atr_pct", "vol_ratio", "trend_dev",
                 "close_in_r", "rsi", "kdj_k"]
    rows = []
    for k in df_f["k"].unique():
        sub = df_f[df_f["k"] == k]
        for feat in key_feats:
            wins = sub[sub["r_mid"] == "w"][feat].dropna()
            loss = sub[sub["r_mid"] == "l"][feat].dropna()
            if len(wins) < 10 or len(loss) < 10:
                continue
            pooled_std = np.sqrt((wins.std() ** 2 + loss.std() ** 2) / 2)
            effect = (wins.mean() - loss.mean()) / pooled_std if pooled_std > 1e-9 else 0
            if abs(effect) < 0.15:
                continue  # 噪音
            rows.append({
                "sig": k, "feat": feat,
                "win_med":  round(wins.median(), 4),
                "loss_med": round(loss.median(), 4),
                "effect":   round(effect, 2),
                "direction": "WIN高" if effect > 0 else "LOSS高",
                "n_w/n_l":  f"{len(wins)}/{len(loss)}",
            })
    return pd.DataFrame(rows).sort_values("effect", key=lambda c: c.abs(), ascending=False)


def run(market: str, symbol: str, tf: str, exchange: str = "pionex", days: int = 0):
    print(f"📊 取資料 {market}/{symbol}/{tf}...")
    df = fetch_history_df(market, symbol, tf, days=days, exchange=exchange)
    print(f"   bars: {len(df)}, from {df.iloc[0]['time']} to {df.iloc[-1]['time']}")

    print(f"\n🧮 計算訊號 + 結果...")
    result = _calc_crt_winrate(df, stop_buffer_pct=0.0, long_only=(market == "tw"))
    sigs = result.get("signals", [])
    n_w_mid = sum(1 for s in sigs if s.get("r") == "w")
    n_l_mid = sum(1 for s in sigs if s.get("r") == "l")
    print(f"   訊號: {len(sigs)} 個（中軌 win/loss = {n_w_mid}/{n_l_mid}）")

    print(f"\n🔍 計算每訊號特徵...")
    df_f = analyze(df, result)
    print(f"   feature DataFrame: {len(df_f)} 列")

    print(f"\n📈 整體比較 win vs loss（依 effect size 排序，top 15）:")
    feat_cols = ["est_rr", "bb_width", "atr_pct", "body_pct", "uw_pct",
                 "lw_pct", "close_in_r", "vol_ratio", "trend_dev",
                 "bb_slope", "rsi", "kdj_k"]
    cmp = _compare_groups(df_f, feat_cols)
    print(cmp.head(15).to_string(index=False))

    print(f"\n🎯 各訊號類型的失敗共同點（effect>=0.15，依 effect 排）:")
    per_sig = _per_signal_breakdown(df_f)
    if len(per_sig) > 0:
        print(per_sig.to_string(index=False))
    else:
        print("   （沒有發現明顯差異）")

    return df_f, cmp, per_sig


def _main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", default="crypto")
    ap.add_argument("--symbol", default="BTC/USDT")
    ap.add_argument("--tf", default="1h")
    ap.add_argument("--exchange", default="pionex")
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--csv", default="")
    args = ap.parse_args()
    df_f, cmp, per_sig = run(args.market, args.symbol, args.tf, args.exchange, args.days)
    if args.csv:
        df_f.to_csv(args.csv, index=False)
        print(f"\n💾 features → {args.csv}")


if __name__ == "__main__":
    _main()
