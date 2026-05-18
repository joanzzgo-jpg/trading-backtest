"""CRT 策略訊號掃描與勝率計算（numpy 向量化加速版，含中軌＋帶軌雙目標）

對比舊版以 df.iloc[i].get(col) 逐 row 取值的寫法，本版預先把所有欄位抽成 numpy array：
- 6 個主要迴圈用 vectorized mask 找出候選 index，只跑符合條件的少數幾根 K 棒
- _scan_outcome 用 array 直接取值，省下 pandas Series 介面成本（~10-50x faster）
- 每個訊號同時計算「中軌目標」與「帶軌目標」的勝負結果，前端可切換顯示
"""
import math
import numpy as np
import pandas as pd


def _ts_val(t) -> str:
    return t.isoformat() if hasattr(t, "isoformat") else str(t)


def _scan_outcome_np(highs, lows, closes, target_arr, times_iso, entry_i, n, stop_px, direction):
    """從 entry_i 向後掃描，target_arr 提供每根的目標價（中軌或上下軌）。

    回傳 ('win'/'loss', bar_time_iso, exit_idx) 或 (None, None, -1)。
    SHORT：target_arr 應為 bb_middle 或 bb_lower；命中條件 low <= target
    LONG ：target_arr 應為 bb_middle 或 bb_upper；命中條件 high >= target
    """
    for j in range(entry_i, n):
        t = target_arr[j]
        if t != t:  # 比 math.isnan 還快一點：NaN != NaN
            continue
        hi = highs[j]; lo = lows[j]; cl = closes[j]
        if direction == "short":
            hit_stop = hi >= stop_px
            hit_tgt  = lo <= t
            if hit_stop and hit_tgt:
                result = "win" if cl <= t else "loss"
            elif hit_stop: result = "loss"
            elif hit_tgt:  result = "win"
            else: continue
        else:
            hit_stop = lo <= stop_px
            hit_tgt  = hi >= t
            if hit_stop and hit_tgt:
                result = "win" if cl >= t else "loss"
            elif hit_stop: result = "loss"
            elif hit_tgt:  result = "win"
            else: continue
        return result, times_iso[j], j
    return None, None, -1


def _calc_crt_winrate(df: pd.DataFrame, stop_buffer_pct: float = 0.0, long_only: bool = False) -> dict:
    """
    六種訊號合併計算勝率（中軌目標 + 帶軌目標雙統計）。

    stop_buffer_pct：停損緩衝百分比（decimal，例如 0.005 = 0.5%）。
    short：stop = base_high × (1 + buffer)（高於最高值幾 %）
    long ：stop = base_low  × (1 - buffer)（低於最低值幾 %）

    long_only：True 時只算多單（台股不能放空），所有 short mask 強制清空。
    """
    n = len(df)

    # ── 全部欄位一次抽成 numpy array（避免在 6 個迴圈內反覆 df.iloc）──
    times_iso = [_ts_val(t) for t in df["time"]]
    highs  = df["high"].to_numpy(dtype=float)
    lows   = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    # 進場價：用次根 open；若無 open 欄位（不應該發生）退回用 close
    opens  = df["open"].to_numpy(dtype=float) if "open" in df.columns else closes

    def _col_f(name):
        if name not in df.columns:
            return np.full(n, np.nan, dtype=float)
        return df[name].to_numpy(dtype=float)

    bb_mid = _col_f("bb_middle")
    bb_up  = _col_f("bb_upper")
    bb_lo  = _col_f("bb_lower")

    def _col_i(name):
        if name not in df.columns:
            return np.zeros(n, dtype=np.int8)
        return df[name].fillna(0).astype(np.int8).to_numpy()

    crt   = _col_i("crt")
    cross = _col_i("kdj_cross")
    res   = _col_i("resonance")

    # ── 計數器：mid_cnt[k] = [ws, ls, wl, ll]；band_cnt 同結構 ──
    SIG_KEYS = ["abc", "ab", "3", "4", "5", "6"]
    mid_cnt  = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    band_cnt = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    # RR 累計：mid_rr[k][dir] = {"est_sum": 預估 RR 總和（所有訊號）,
    #                          "est_n": 預估 RR 樣本數,
    #                          "act_win_sum": 實際贏的 R 總和（用結算時 BB）,
    #                          "n_win": 贏的筆數, "n_loss": 輸的筆數}
    def _new_rr_bucket():
        # est_sum_all/est_n_all：所有訊號的預估 RR（平均 RR_預估）
        # est_sum_win：贏的訊號預估 RR 總和（拿來算預估淨 R = est_sum_win - n_loss）
        # act_sum_win：贏的訊號實際 RR 總和（拿來算實際淨 R 與 PF）
        return {
            "est_sum_all": 0.0, "est_n_all": 0,
            "est_sum_win": 0.0,
            "act_sum_win": 0.0,
            "n_win": 0, "n_loss": 0,
        }
    mid_rr  = {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
    band_rr = {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
    recent:  list = []
    signals: list = []

    def _bump(counters, sig_key, direction, outcome):
        if outcome is None: return
        if direction == "short":
            counters[sig_key][0 if outcome == "win" else 1] += 1
        else:
            counters[sig_key][2 if outcome == "win" else 3] += 1

    def _stop(base, direction):
        """套用停損緩衝：短=base×(1+buf)、多=base×(1-buf)"""
        if direction == "short":
            return base * (1.0 + stop_buffer_pct)
        return base * (1.0 - stop_buffer_pct)

    def _scan_dual(entry_i, stop_px, direction):
        """同時掃中軌與帶軌目標。
        帶軌目標：short→bb_lower、long→bb_upper（更遠的反向極端）"""
        om, otm, omj = _scan_outcome_np(highs, lows, closes, bb_mid, times_iso, entry_i, n, stop_px, direction)
        band_arr = bb_lo if direction == "short" else bb_up
        ob, otb, obj = _scan_outcome_np(highs, lows, closes, band_arr, times_iso, entry_i, n, stop_px, direction)
        return om, otm, omj, ob, otb, obj

    def _rr_at(entry_i, exit_idx, stop_px, direction, target_arr):
        """計算 RR：reward / risk。
        - 預估（exit_idx=-1 → 用 entry_i 的 target）
        - 實際（exit_idx≥0 → 用 exit_idx 的 target，僅 win 有意義）
        單根 RR cap 10 避免 BB 極端展寬時 outlier 拉爆統計。"""
        if entry_i < 0 or entry_i >= n: return None
        entry_px = opens[entry_i]
        idx = entry_i if exit_idx < 0 else exit_idx
        tgt = target_arr[idx]
        if entry_px != entry_px or tgt != tgt:  # NaN
            return None
        risk = abs(entry_px - stop_px)
        if risk < 1e-12: return None
        return min(abs(entry_px - tgt) / risk, 10.0)

    def _bump_rr(rr_dict, sig_key, direction, entry_i, exit_idx, stop_px, outcome, target_arr):
        b = rr_dict[sig_key][direction]
        rr_est = _rr_at(entry_i, -1, stop_px, direction, target_arr)
        if rr_est is not None:
            b["est_sum_all"] += rr_est
            b["est_n_all"]   += 1
        if outcome == "win":
            if rr_est is not None:
                b["est_sum_win"] += rr_est
            rr_act = _rr_at(entry_i, exit_idx, stop_px, direction, target_arr)
            if rr_act is not None:
                b["act_sum_win"] += rr_act
            b["n_win"] += 1
        elif outcome == "loss":
            b["n_loss"] += 1

    def _push_signal(sig_time, d_str, sig_key, direction, entry_i, stop_px,
                     om, otm, omj, ob, otb, obj):
        signals.append({
            "t": sig_time, "d": d_str, "k": sig_key,
            "r":   "w" if om == "win" else ("l" if om else None), "ot":   otm,
            "r_b": "w" if ob == "win" else ("l" if ob else None), "ot_b": otb,
        })
        _bump(mid_cnt,  sig_key, direction, om)
        _bump(band_cnt, sig_key, direction, ob)
        _bump_rr(mid_rr,  sig_key, direction, entry_i, omj, stop_px, om, bb_mid)
        band_arr = bb_lo if direction == "short" else bb_up
        _bump_rr(band_rr, sig_key, direction, entry_i, obj, stop_px, ob, band_arr)
        if om is not None:
            recent.append({"t": sig_time, "d": d_str, "r": "w" if om == "win" else "l", "k": sig_key})

    # ── 訊號一 ABC（同棒三條件）──────────────────────────────
    if n >= 2:
        m_short = (crt == -1) & (cross == -1) & (res == -1)
        m_long  = (crt ==  1) & (cross ==  1) & (res ==  1)
        m_short[n-1] = False  # 最後一根沒有 i+1
        m_long[n-1]  = False
        if long_only: m_short[:] = False
        for i in np.flatnonzero(m_short | m_long):
            i = int(i)
            direction = "short" if m_short[i] else "long"
            stop_px = _stop(highs[i] if direction == "short" else lows[i], direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[i]
            entry_i = i + 1
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "abc", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── 訊號二 AB（A=共振，B=CRT+KDJ叉）─────────────────────
    if n >= 3:
        a_res = res[:n-2]
        b_crt = crt[1:n-1]; b_cross = cross[1:n-1]; b_res = res[1:n-1]
        b_bb  = bb_mid[1:n-1]
        b_lo_  = lows[1:n-1]; b_hi_ = highs[1:n-1]
        m_short = (a_res == -1) & (b_crt == -1) & (b_cross == -1) & (b_res != -1) \
                  & ~np.isnan(b_bb) & (b_lo_ > b_bb)
        m_long  = (a_res ==  1) & (b_crt ==  1) & (b_cross ==  1) & (b_res !=  1) \
                  & ~np.isnan(b_bb) & (b_hi_ < b_bb)
        if long_only: m_short[:] = False
        for i in np.flatnonzero(m_short | m_long):
            i = int(i)
            direction = "short" if m_short[i] else "long"
            ib = i + 1
            stop_px = _stop(highs[ib] if direction == "short" else lows[ib], direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            entry_i = i + 2
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "ab", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── 訊號六 S6（4 棒 pattern：ABC 無指標 + D 觸軌 CRT）─────
    # A、B、C 三根都不能有任何指標（crt=0, cross=0, res=0）
    # D 棒：做空 → crt=-1 且 high >= bb_upper（影線或本體觸上軌）
    #       做多 → crt=+1 且 low  <= bb_lower
    # 邏輯：3 根「安靜」棒後突然出現觸軌反轉 K → 高品質的「轉折開始」訊號
    if n >= 5:
        a_clean = (crt[:n-4]   == 0) & (cross[:n-4]   == 0) & (res[:n-4]   == 0)
        b_clean = (crt[1:n-3]  == 0) & (cross[1:n-3]  == 0) & (res[1:n-3]  == 0)
        c_clean = (crt[2:n-2]  == 0) & (cross[2:n-2]  == 0) & (res[2:n-2]  == 0)
        d_crt   = crt[3:n-1]
        d_hi    = highs[3:n-1]
        d_lo_   = lows[3:n-1]
        d_bbu   = bb_up[3:n-1]
        d_bbl   = bb_lo[3:n-1]
        s6_short = a_clean & b_clean & c_clean \
                 & (d_crt == -1) & ~np.isnan(d_bbu) & (d_hi  >= d_bbu)
        s6_long  = a_clean & b_clean & c_clean \
                 & (d_crt ==  1) & ~np.isnan(d_bbl) & (d_lo_ <= d_bbl)
        if long_only: s6_short[:] = False
        for i in np.flatnonzero(s6_short | s6_long):
            i = int(i)
            direction = "short" if s6_short[i] else "long"
            d_bar = i + 3  # D 棒在原始 array 的索引
            stop_px = _stop(highs[d_bar] if direction == "short" else lows[d_bar], direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[d_bar]
            entry_i = d_bar + 1
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "6", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── 訊號三/四/五（三棒）共用 slice ─────────────────────────
    if n >= 4:
        a_res, a_crt, a_cross = res[:n-3], crt[:n-3], cross[:n-3]
        b_res, b_crt, b_cross = res[1:n-2], crt[1:n-2], cross[1:n-2]
        c_res, c_crt, c_cross = res[2:n-1], crt[2:n-1], cross[2:n-1]
        a_hi, a_lo_ = highs[:n-3],  lows[:n-3]
        b_hi, b_lo_ = highs[1:n-2], lows[1:n-2]
        c_hi, c_lo_ = highs[2:n-1], lows[2:n-1]
        c_bbu, c_bbl, c_bbm = bb_up[2:n-1], bb_lo[2:n-1], bb_mid[2:n-1]

        # 排除「真正觸軌」：c_hi 必須 < bb_upper（嚴格不能觸到）才允許 S3 短
        # 舊版用 *0.995 緩衝太嚴，把離上軌 0.5% 內的都當「觸軌」排掉了
        s3_short = (a_res == -1) & ~((a_crt == -1) & (a_cross == -1)) \
                 & (b_res == -1) & ~((b_crt == -1) & (b_cross == -1)) \
                 & (c_cross == -1) & ~((c_crt == -1) & (c_res == -1)) \
                 & ~np.isnan(c_bbu) & (c_hi < c_bbu)
        s3_long  = (a_res ==  1) & ~((a_crt ==  1) & (a_cross ==  1)) \
                 & (b_res ==  1) & ~((b_crt ==  1) & (b_cross ==  1)) \
                 & (c_cross ==  1) & ~((c_crt ==  1) & (c_res ==  1)) \
                 & ~np.isnan(c_bbl) & (c_lo_ > c_bbl)

        s4_short = (a_res == -1) & (a_crt == 0) & (a_cross == 0) \
                 & (b_res == 0)  & (b_crt == 0) & (b_cross == 0) \
                 & (c_cross == -1) & (c_crt == 0) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s4_long  = (a_res ==  1) & (a_crt == 0) & (a_cross == 0) \
                 & (b_res == 0)  & (b_crt == 0) & (b_cross == 0) \
                 & (c_cross ==  1) & (c_crt == 0) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

        s5_short = (a_res == 0) & (a_crt == 0) & (a_cross == 0) \
                 & (b_res == -1) & (b_crt == 0) & (b_cross == 0) \
                 & (c_cross == -1) & (c_crt == 0) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s5_long  = (a_res == 0) & (a_crt == 0) & (a_cross == 0) \
                 & (b_res ==  1) & (b_crt == 0) & (b_cross == 0) \
                 & (c_cross ==  1) & (c_crt == 0) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

        if long_only:
            s3_short[:] = False
            s4_short[:] = False
            s5_short[:] = False

        def _process_3bar(short_mask, long_mask, k_str):
            for i in np.flatnonzero(short_mask | long_mask):
                i = int(i)
                direction = "short" if short_mask[i] else "long"
                if direction == "short":
                    stop_px = _stop(max(a_hi[i], b_hi[i], c_hi[i]), direction)
                else:
                    stop_px = _stop(min(a_lo_[i], b_lo_[i], c_lo_[i]), direction)
                d_str = "s" if direction == "short" else "l"
                sig_time = times_iso[i + 2]
                entry_i = i + 3
                om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
                _push_signal(sig_time, d_str, k_str, direction, entry_i, float(stop_px),
                             om, otm, omj, ob, otb, obj)

        _process_3bar(s3_short, s3_long, "3")
        _process_3bar(s4_short, s4_long, "4")
        _process_3bar(s5_short, s5_long, "5")

    # ── 統計輸出 ─────────────────────────────────────────────
    def _stats(w, l, rr=None):
        """rr：對應方向的 RR bucket（含 est_sum_all/est_sum_win/act_sum_win/n_win/n_loss）"""
        t = w + l
        out = {"total": t, "wins": w, "losses": l, "win_rate": round(w / t * 100, 1) if t else None}
        if not rr:
            return out
        n_all = rr["est_n_all"]
        avg_rr_est = (rr["est_sum_all"] / n_all) if n_all else None
        avg_rr_act = (rr["act_sum_win"] / rr["n_win"]) if rr["n_win"] else None
        # 淨 R：贏的 RR 總和 - 輸的筆數×1R
        net_r_est = (rr["est_sum_win"] - rr["n_loss"]) if (rr["n_win"] + rr["n_loss"]) else None
        net_r_act = (rr["act_sum_win"] - rr["n_loss"]) if (rr["n_win"] + rr["n_loss"]) else None
        # Profit Factor（實際）= 總實際贏 R / 總輸 R（輸=每筆 1R）
        pf_act = (rr["act_sum_win"] / rr["n_loss"]) if rr["n_loss"] > 0 else (None if rr["n_win"] == 0 else float("inf"))
        out["avg_rr_est"]  = round(avg_rr_est, 2) if avg_rr_est is not None else None
        out["avg_rr_act"]  = round(avg_rr_act, 2) if avg_rr_act is not None else None
        out["net_r_est"]   = round(net_r_est, 2)  if net_r_est  is not None else None
        out["net_r_act"]   = round(net_r_act, 2)  if net_r_act  is not None else None
        out["profit_factor"] = (round(pf_act, 2) if isinstance(pf_act, float) and pf_act != float("inf") else
                                ("inf" if pf_act == float("inf") else None))
        return out

    def _build_target_stats(cnt, rr_cnt):
        """從 cnt + rr_cnt 算出該 target 的完整統計結構。"""
        per_sig = {
            k: {
                "short": _stats(v[0], v[1], rr_cnt[k]["short"]),
                "long":  _stats(v[2], v[3], rr_cnt[k]["long"]),
            }
            for k, v in cnt.items()
        }
        # 訊號一不計入合計
        wins_s   = sum(cnt[k][0] for k in ("ab", "3", "4", "5", "6"))
        losses_s = sum(cnt[k][1] for k in ("ab", "3", "4", "5", "6"))
        wins_l   = sum(cnt[k][2] for k in ("ab", "3", "4", "5", "6"))
        losses_l = sum(cnt[k][3] for k in ("ab", "3", "4", "5", "6"))
        tot = wins_s + losses_s + wins_l + losses_l
        wins = wins_s + wins_l
        return {
            "total":    tot,
            "wins":     wins,
            "win_rate": round(wins / tot * 100, 1) if tot else None,
            "short":    _stats(wins_s, losses_s),
            "long":     _stats(wins_l, losses_l),
            "abc":      per_sig["abc"],
            "ab":       per_sig["ab"],
            "s3":       per_sig["3"],
            "s4":       per_sig["4"],
            "s5":       per_sig["5"],
            "s6":       per_sig["6"],
        }

    mid_out  = _build_target_stats(mid_cnt,  mid_rr)
    band_out = _build_target_stats(band_cnt, band_rr)
    recent.sort(key=lambda x: x["t"])
    from_date = str(df.iloc[0]["time"])[:10] if n else ""

    return {
        **mid_out,                # backward compat：mid 統計放在頂層
        "band": band_out,         # 帶軌（short=BB 下軌、long=BB 上軌）統計
        "long_only": long_only,   # 是否只算多單（台股=True）
        "from_date": from_date,
        "recent":   recent[-30:],
        "signals":  signals,
    }
