"""AI 策略研究引擎：暴力枚舉指標組合 → 回測 → 排序（強化反過擬合版）

每個方向（多/空）有 6 個指標原子，枚舉 size 2~4 的組合（50 種/方向）。
信號棒 = 所有原子當棒同時觸發；進場 = 信號棒下一根；目標 = BB middle；
停損 = 信號棒高/低 ± 緩衝；max_hold 限制持倉最久 K 棒（避免無限掃描）。

反過擬合機制：
1. 重疊訊號排除：上筆未結算前的新訊號跳過，避免一波趨勢中連續同向訊號灌水
2. Train/Test 切分：依時序前 70% 訓練、後 30% 測試，列出兩端勝率
3. Wilson 95% CI 下界：小樣本自動降權，避免「10 筆 90%」假名牌
4. Profit Factor：總獲利 R / 總虧損 R，比期望值更易解讀
5. Robust 標籤：test_wr/train_wr ≥ 0.85 且 test_total ≥ 3 才算穩健

效能：多 target 用 ThreadPoolExecutor 平行抓資料 + 跑研究。

CLI 用法：
    python -m research.ai_strategy --market crypto --symbol BTC/USDT --tf 1h --top 20
    python -m research.ai_strategy --market crypto --symbol BTC/USDT,ETH/USDT \\
           --tf 1h,4h --days 365 --min-trades 10 --top 30 --sort ci_low --csv out.csv
"""
from __future__ import annotations
import argparse
import itertools
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd

_HERE = os.path.dirname(__file__)
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from utils.crt import _ts_val  # noqa: E402
from utils.data import enrich_df  # noqa: E402


# ── 6 個方向性原子 ──────────────────────────────────────────────────
ATOM_KEYS = ["crt", "kdj", "res", "bb", "rsi", "macd"]
ATOM_LABELS = {
    "crt":  "CRT",
    "kdj":  "KDJ叉",
    "res":  "共振",
    "bb":   "BB觸軌",
    "rsi":  "RSI極端",
    "macd": "MACD叉",
}
DIR_LABEL = {"short": "空", "long": "多"}

# 各 TF 的預設 max_hold（K 棒上限）。0 = 不限制
_TF_DEFAULT_MAX_HOLD = {
    "1M": 12, "1w": 26, "1d": 30,
    "4h": 60, "1h": 96, "15m": 96, "5m": 96,
}


def _build_atoms(df: pd.DataFrame) -> dict[str, dict[str, np.ndarray]]:
    """{atom_key: {"short": bool_array, "long": bool_array}}"""
    n = len(df)

    def col_i(name):
        if name not in df.columns:
            return np.zeros(n, dtype=np.int8)
        return df[name].fillna(0).astype(np.int8).to_numpy()

    def col_f(name):
        if name not in df.columns:
            return np.full(n, np.nan, dtype=float)
        return df[name].to_numpy(dtype=float)

    crt   = col_i("crt")
    cross = col_i("kdj_cross")
    res   = col_i("resonance")
    highs, lows = col_f("high"), col_f("low")
    bb_up, bb_lo = col_f("bb_upper"), col_f("bb_lower")
    rsi14 = col_f("rsi_14")
    hist  = col_f("macd_hist")

    prev_hist = np.concatenate([[np.nan], hist[:-1]])
    macd_dead = (prev_hist > 0) & (hist <= 0) & ~np.isnan(prev_hist) & ~np.isnan(hist)
    macd_gold = (prev_hist < 0) & (hist >= 0) & ~np.isnan(prev_hist) & ~np.isnan(hist)

    bb_up_touch = ~np.isnan(bb_up) & (highs >= bb_up * 0.998)
    bb_lo_touch = ~np.isnan(bb_lo) & (lows  <= bb_lo * 1.002)

    rsi_ob = ~np.isnan(rsi14) & (rsi14 > 70)
    rsi_os = ~np.isnan(rsi14) & (rsi14 < 30)

    return {
        "crt":  {"short": crt == -1,    "long": crt == 1},
        "kdj":  {"short": cross == -1,  "long": cross == 1},
        "res":  {"short": res == -1,    "long": res == 1},
        "bb":   {"short": bb_up_touch,  "long": bb_lo_touch},
        "rsi":  {"short": rsi_ob,       "long": rsi_os},
        "macd": {"short": macd_dead,    "long": macd_gold},
    }


def _scan_outcome_idx(highs, lows, closes, target_arr,
                      entry_i, n, stop_px, direction, max_hold=0):
    """掃出場：回傳 (outcome, exit_idx)；無結算回 (None, -1)。
    max_hold > 0 時，最多掃 max_hold 根 K 棒"""
    end = n if max_hold <= 0 else min(n, entry_i + max_hold)
    for j in range(entry_i, end):
        t = target_arr[j]
        if t != t:  # NaN check
            continue
        hi, lo, cl = highs[j], lows[j], closes[j]
        if direction == "short":
            hit_stop = hi >= stop_px
            hit_tgt  = lo <= t
            if hit_stop and hit_tgt:
                return ("win" if cl <= t else "loss"), j
            if hit_stop: return "loss", j
            if hit_tgt:  return "win", j
        else:
            hit_stop = lo <= stop_px
            hit_tgt  = hi >= t
            if hit_stop and hit_tgt:
                return ("win" if cl >= t else "loss"), j
            if hit_stop: return "loss", j
            if hit_tgt:  return "win", j
    return None, -1


def _wilson_ci(wins: int, total: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval；回傳 (lower, upper) ∈ [0, 1]"""
    if total <= 0:
        return 0.0, 0.0
    p = wins / total
    denom = 1.0 + z * z / total
    centre = p + z * z / (2 * total)
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total))
    return max(0.0, (centre - half) / denom), min(1.0, (centre + half) / denom)


def _finalize_bucket(b: dict) -> Optional[dict]:
    """把 trade tracker 轉成統計 dict"""
    wins, losses = b["wins"], b["losses"]
    total = wins + losses
    if total == 0:
        return None
    wr = wins / total
    avg_rr = (b["rr_sum"] / b["rr_n"]) if b["rr_n"] else 1.0
    pf = (b["rr_sum"] / losses) if losses > 0 else None  # None = 無敗（PF=∞）
    expectancy = wr * avg_rr - (1.0 - wr)
    ci_low, ci_high = _wilson_ci(wins, total)
    return {
        "total": total, "wins": wins, "losses": losses,
        "win_rate": round(wr * 100, 1),
        "ci_low":   round(ci_low * 100, 1),
        "ci_high":  round(ci_high * 100, 1),
        "avg_rr":   round(avg_rr, 2),
        "profit_factor": (round(pf, 2) if pf is not None else None),
        "expectancy":    round(expectancy, 3),
        "max_loss_streak": b["max_loss_streak"],
    }


def _new_bucket() -> dict:
    return {"wins": 0, "losses": 0, "rr_sum": 0.0, "rr_n": 0,
            "max_loss_streak": 0, "cur_loss_streak": 0}


def _eval_combo(
    df: pd.DataFrame,
    atoms: dict,
    combo: tuple[str, ...],
    direction: str,
    stop_buffer_pct: float,
    max_hold: int,
    train_split: float,
    arrays: dict,
) -> Optional[dict]:
    n = len(df)
    if n < 30:
        return None

    mask = atoms[combo[0]][direction].copy()
    for k in combo[1:]:
        mask &= atoms[k][direction]
    mask[n - 1] = False

    idxs = np.flatnonzero(mask)
    if len(idxs) == 0:
        return None

    highs, lows, closes = arrays["highs"], arrays["lows"], arrays["closes"]
    opens, bb_mid = arrays["opens"], arrays["bb_mid"]
    train_end = int(n * train_split)

    train_b = _new_bucket()
    test_b  = _new_bucket()

    def _record(bucket, outcome, rr):
        if outcome == "win":
            bucket["wins"] += 1
            bucket["rr_sum"] += rr
            bucket["rr_n"] += 1
            bucket["cur_loss_streak"] = 0
        else:
            bucket["losses"] += 1
            bucket["cur_loss_streak"] += 1
            if bucket["cur_loss_streak"] > bucket["max_loss_streak"]:
                bucket["max_loss_streak"] = bucket["cur_loss_streak"]

    next_avail = 0  # 重疊排除：下一筆訊號的最早可進場 bar

    for i in idxs:
        i = int(i)
        entry_i = i + 1
        if entry_i < next_avail:
            continue          # 上筆未結算，跳過
        if entry_i >= n:
            break

        if direction == "short":
            stop_px = highs[i] * (1.0 + stop_buffer_pct)
        else:
            stop_px = lows[i] * (1.0 - stop_buffer_pct)

        outcome, exit_idx = _scan_outcome_idx(
            highs, lows, closes, bb_mid,
            entry_i, n, float(stop_px), direction, max_hold,
        )
        if outcome is None:
            next_avail = entry_i + 1
            continue

        # 算 R = reward/risk
        entry_px = opens[entry_i]
        tgt = bb_mid[entry_i]
        rr = 1.0
        if not (math.isnan(entry_px) or math.isnan(tgt) or math.isnan(stop_px)):
            risk = abs(entry_px - stop_px)
            if risk > 1e-9:
                rr = min(abs(entry_px - tgt) / risk, 10.0)

        bucket = train_b if i < train_end else test_b
        _record(bucket, outcome, rr)
        next_avail = exit_idx + 1

    # 合併 train + test 成 overall
    all_b = {
        "wins":   train_b["wins"]   + test_b["wins"],
        "losses": train_b["losses"] + test_b["losses"],
        "rr_sum": train_b["rr_sum"] + test_b["rr_sum"],
        "rr_n":   train_b["rr_n"]   + test_b["rr_n"],
        "max_loss_streak": max(train_b["max_loss_streak"], test_b["max_loss_streak"]),
        "cur_loss_streak": 0,
    }
    overall = _finalize_bucket(all_b)
    if not overall:
        return None
    train = _finalize_bucket(train_b)
    test  = _finalize_bucket(test_b)

    # Robust 判定：test 有效樣本且勝率不爛於 train × 0.85
    robust = False
    train_test_ratio = None
    if train and test and test["total"] >= 3 and train["win_rate"] > 0:
        ratio = test["win_rate"] / train["win_rate"]
        train_test_ratio = round(ratio, 2)
        if ratio >= 0.85:
            robust = True

    # 排序分數：Wilson 下界 × √total；穩健加 20% bonus
    base_score = (overall["ci_low"] / 100.0) * math.sqrt(overall["total"])
    score = round(base_score * (1.2 if robust else 1.0), 3)

    return {
        "combo": list(combo),
        "direction": direction,
        **overall,
        "score": score,
        "robust": robust,
        "train": train,
        "test": test,
        "train_test_ratio": train_test_ratio,
    }


def research_one(
    df: pd.DataFrame,
    sizes: tuple[int, ...] = (2, 3, 4),
    stop_buffer_pct: float = 0.0,
    min_trades: int = 10,
    long_only: bool = False,
    max_hold: int = 0,
    train_split: float = 0.7,
) -> list[dict]:
    atoms = _build_atoms(df)
    directions = ["long"] if long_only else ["short", "long"]
    # 預抽 numpy array 一次，傳給所有 combo eval（省重複 to_numpy）
    arrays = {
        "highs":  df["high"].to_numpy(dtype=float),
        "lows":   df["low"].to_numpy(dtype=float),
        "closes": df["close"].to_numpy(dtype=float),
        "opens":  df["open"].to_numpy(dtype=float),
        "bb_mid": (df["bb_middle"].to_numpy(dtype=float)
                   if "bb_middle" in df.columns
                   else np.full(len(df), np.nan)),
    }
    out: list[dict] = []
    for size in sizes:
        for combo in itertools.combinations(ATOM_KEYS, size):
            for d in directions:
                stat = _eval_combo(df, atoms, combo, d, stop_buffer_pct,
                                   max_hold, train_split, arrays)
                if stat and stat["total"] >= min_trades:
                    out.append(stat)
    return out


# ── 資料抓取 ─────────────────────────────────────────────────────
_TF_INIT_DAYS = {"1M": 3650, "1w": 1825, "1d": 730, "4h": 365, "1h": 365, "15m": 60, "5m": 30}


def fetch_history_df(
    market: str,
    symbol: str,
    timeframe: str,
    days: int = 0,
    exchange: str = "pionex",
    finmind_token: str = "",
    api_key: str = "",
    api_secret: str = "",
) -> pd.DataFrame:
    if days <= 0:
        days = _TF_INIT_DAYS.get(timeframe, 365)
    end = date.today().isoformat()

    if market == "crypto":
        from data.crypto import fetch_crypto_ohlcv
        start = (date.today() - timedelta(days=days)).isoformat()
        df = fetch_crypto_ohlcv(symbol, timeframe, start, end, exchange,
                                api_key=api_key, api_secret=api_secret)
    elif market == "us":
        from data.us_stock import fetch_us_stock, MAX_DAYS as US_MAX_DAYS
        max_d = US_MAX_DAYS.get(timeframe, 3650)
        start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
        df = fetch_us_stock(symbol, start, end, timeframe)
    elif market == "tw":
        from data.taiwan import (
            fetch_tw_intraday_yf, fetch_tw_intraday, fetch_tw_daily_yf,
            fetch_tw_stock, resample_tw, YF_MAX_DAYS as TW_YF_MAX_DAYS,
        )
        if timeframe in ("5m", "15m", "1h"):
            max_d = TW_YF_MAX_DAYS.get(timeframe, 60)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            try:
                df = fetch_tw_intraday_yf(symbol, timeframe, start, end)
            except Exception:
                if not finmind_token:
                    raise
                df = fetch_tw_intraday(symbol, timeframe, start, end, finmind_token)
        elif timeframe == "4h":
            max_d = TW_YF_MAX_DAYS.get("1h", 60)
            start = (date.today() - timedelta(days=min(days, max_d))).isoformat()
            _df = fetch_tw_intraday_yf(symbol, "1h", start, end)
            _df = _df.set_index("time").resample(
                "4h", origin="start_day", offset="1h",
            ).agg({"open": "first", "high": "max", "low": "min",
                   "close": "last", "volume": "sum"}).dropna(subset=["open"]).reset_index()
            df = _df
        else:
            start = (date.today() - timedelta(days=days)).isoformat()
            try:
                df = fetch_tw_daily_yf(symbol, start, end)
            except Exception:
                df = fetch_tw_stock(symbol, start, end, finmind_token)
            if timeframe != "1d":
                df = resample_tw(df, timeframe)
    else:
        raise ValueError(f"不支援的市場：{market}")

    if df is None or df.empty:
        raise ValueError(f"查無 {symbol} 資料")
    return enrich_df(df, signals=True)   # 研究用:需 crt/kdj_cross/resonance 訊號欄


# ── 主入口 ──────────────────────────────────────────────────────
def _process_target(tgt: dict, days: int, min_trades: int, stop_buffer_pct: float,
                    sizes: tuple, max_hold: int, train_split: float,
                    finmind_token: str) -> tuple[dict, list[dict]]:
    """單個 target：抓資料 + 跑 research。回傳 (summary, stats_list)"""
    market, symbol, tf = tgt["market"], tgt["symbol"], tgt["timeframe"]
    exchange = tgt.get("exchange", "pionex")
    long_only = (market == "tw")

    try:
        df = fetch_history_df(market, symbol, tf, days=days,
                              exchange=exchange, finmind_token=finmind_token)
    except Exception as e:
        return ({"market": market, "symbol": symbol, "timeframe": tf,
                 "error": str(e), "bars": 0}, [])

    mh = max_hold if max_hold >= 0 else _TF_DEFAULT_MAX_HOLD.get(tf, 60)
    stats = research_one(df, sizes=sizes, stop_buffer_pct=stop_buffer_pct,
                         min_trades=min_trades, long_only=long_only,
                         max_hold=mh, train_split=train_split)
    from_date = str(df.iloc[0]["time"])[:10] if len(df) else ""

    for s in stats:
        s["market"] = market
        s["symbol"] = symbol
        s["timeframe"] = tf
        s["exchange"] = exchange
        s["from_date"] = from_date
        s["combo_label"] = " + ".join(ATOM_LABELS[k] for k in s["combo"])
        s["dir_label"] = DIR_LABEL[s["direction"]]

    summary = {"market": market, "symbol": symbol, "timeframe": tf,
               "bars": len(df), "from_date": from_date, "matched": len(stats),
               "max_hold": mh}
    return summary, stats


_SORT_KEYS = ("score", "win_rate", "ci_low", "expectancy", "profit_factor", "total")


def run_research(
    targets: list[dict],
    days: int = 0,
    min_trades: int = 10,
    stop_buffer_pct: float = 0.0,
    sizes: tuple[int, ...] = (2, 3, 4),
    top_n: int = 50,
    sort_by: str = "score",
    finmind_token: str = "",
    max_hold: int = -1,           # -1 = 用 TF 預設；0 = 不限
    train_split: float = 0.7,
    robust_only: bool = False,
    max_workers: int = 4,
) -> dict:
    all_results: list[dict] = []
    per_target: list[dict] = []

    # 平行抓+算
    workers = max(1, min(max_workers, len(targets)))
    if workers == 1 or len(targets) == 1:
        for tgt in targets:
            summary, stats = _process_target(tgt, days, min_trades, stop_buffer_pct,
                                             sizes, max_hold, train_split, finmind_token)
            per_target.append(summary)
            all_results.extend(stats)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            fut_map = {pool.submit(_process_target, tgt, days, min_trades,
                                   stop_buffer_pct, sizes, max_hold, train_split,
                                   finmind_token): tgt for tgt in targets}
            for fut in as_completed(fut_map):
                summary, stats = fut.result()
                per_target.append(summary)
                all_results.extend(stats)

    if robust_only:
        all_results = [r for r in all_results if r.get("robust")]

    key = sort_by if sort_by in _SORT_KEYS else "score"
    def _sk(r):
        v = r.get(key)
        return -1 if v is None else v
    all_results.sort(key=_sk, reverse=True)
    top = all_results[:top_n] if top_n > 0 else all_results

    # per_target 依原輸入順序排（平行化後 as_completed 順序亂掉）
    order = {f"{t['market']}/{t['symbol']}/{t['timeframe']}": i for i, t in enumerate(targets)}
    per_target.sort(key=lambda s: order.get(f"{s['market']}/{s['symbol']}/{s['timeframe']}", 999))

    return {
        "results": top,
        "per_target": per_target,
        "total_combos_scanned": len(all_results),
        "params": {
            "days": days, "min_trades": min_trades,
            "stop_buffer_pct": stop_buffer_pct,
            "sizes": list(sizes), "sort_by": key, "top_n": top_n,
            "max_hold": max_hold, "train_split": train_split,
            "robust_only": robust_only,
        },
    }


# ── CLI ────────────────────────────────────────────────────────
def _parse_csv(s: str) -> list[str]:
    return [x.strip() for x in s.split(",") if x.strip()]


def _main():
    ap = argparse.ArgumentParser(description="AI 策略研究（強化反過擬合版）")
    ap.add_argument("--market", default="crypto", choices=["crypto", "us", "tw"])
    ap.add_argument("--symbol", default="BTC/USDT", help="逗號分隔多個")
    ap.add_argument("--tf", default="1h", help="逗號分隔多個")
    ap.add_argument("--exchange", default="pionex")
    ap.add_argument("--days", type=int, default=0)
    ap.add_argument("--min-trades", type=int, default=10)
    ap.add_argument("--stop-buffer", type=float, default=0.0)
    ap.add_argument("--sizes", default="2,3,4")
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--sort", default="score", choices=list(_SORT_KEYS))
    ap.add_argument("--max-hold", type=int, default=-1, help="持倉最久 K 棒；-1 用 TF 預設，0 不限")
    ap.add_argument("--train-split", type=float, default=0.7)
    ap.add_argument("--robust-only", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--csv", default="")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    symbols = _parse_csv(args.symbol)
    tfs = _parse_csv(args.tf)
    sizes = tuple(int(x) for x in _parse_csv(args.sizes))
    targets = [{"market": args.market, "symbol": s, "timeframe": tf, "exchange": args.exchange}
               for s in symbols for tf in tfs]

    print(f"📊 跑 {len(targets)} 個 (symbol×tf) × {sum(math.comb(6, k) for k in sizes) * 2} 組合 "
          f"(workers={args.workers}, robust_only={args.robust_only})")
    import time as _t
    t0 = _t.time()
    out = run_research(
        targets, days=args.days, min_trades=args.min_trades,
        stop_buffer_pct=args.stop_buffer, sizes=sizes, top_n=args.top,
        sort_by=args.sort, max_hold=args.max_hold, train_split=args.train_split,
        robust_only=args.robust_only, max_workers=args.workers,
    )
    print(f"⏱  {_t.time() - t0:.1f}s")
    print(f"\n✅ 共 {out['total_combos_scanned']} 組達門檻")
    for t in out["per_target"]:
        if t.get("error"):
            print(f"  ⚠ {t['market']}/{t['symbol']}/{t['timeframe']}: {t['error']}")
        else:
            print(f"  • {t['market']}/{t['symbol']}/{t['timeframe']}: "
                  f"{t['bars']} 根 from {t['from_date']}, max_hold={t['max_hold']}, 達門檻 {t['matched']}")

    print(f"\n🏆 Top {len(out['results'])}（依 {args.sort}）:")
    print(f"  {'#':>3} {'標的':<14} {'TF':<4} {'方向':<2} {'勝率':>5} {'CI低':>5} {'筆數':>4} {'PF':>5} "
          f"{'連敗':>3} {'測試':>5} 穩健 組合")
    for i, r in enumerate(out["results"], 1):
        pf = r.get("profit_factor")
        pf_s = f"{pf:>5.2f}" if pf is not None else "  ∞  "
        test_wr = (r.get("test") or {}).get("win_rate")
        test_s = f"{test_wr:>5.1f}" if test_wr is not None else "  —  "
        robust = "🔒" if r.get("robust") else "  "
        print(f"  {i:>3} {r['symbol']:<14} {r['timeframe']:<4} {r['dir_label']:<2} "
              f"{r['win_rate']:>4.1f}% {r['ci_low']:>4.1f}% {r['total']:>4} {pf_s} "
              f"{r['max_loss_streak']:>3} {test_s}  {robust}  {r['combo_label']}")

    if args.csv:
        rows = []
        for r in out["results"]:
            row = {k: v for k, v in r.items() if k not in ("train", "test")}
            row["train_wr"] = (r.get("train") or {}).get("win_rate")
            row["train_n"] = (r.get("train") or {}).get("total")
            row["test_wr"]  = (r.get("test") or {}).get("win_rate")
            row["test_n"]   = (r.get("test") or {}).get("total")
            row["combo"] = "+".join(r["combo"])
            rows.append(row)
        pd.DataFrame(rows).to_csv(args.csv, index=False, encoding="utf-8-sig")
        print(f"\n💾 CSV → {args.csv}")
    if args.json:
        import json
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"💾 JSON → {args.json}")


if __name__ == "__main__":
    _main()
