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

    回傳 ('win'/'loss', bar_time_iso) 或 (None, None)。
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
        return result, times_iso[j]
    return None, None


def _calc_crt_winrate(df: pd.DataFrame) -> dict:
    """
    六種訊號合併計算勝率（中軌目標 + 帶軌目標雙統計）：
    1. ABC：同一棒 CRT + KDJ死/金叉 + 超買/超賣共振
    2. AB ：A棒共振，B棒（緊接）CRT + KDJ死/金叉
    3. S3 ：A棒僅共振，B棒僅共振，C棒僅KDJ死/金叉
    4. S4 ：A棒純共振，B棒無指標，C棒純KDJ死/金叉
    5. S5 ：A棒無指標，B棒純共振，C棒純KDJ死/金叉
    6. S6 ：單棒 CRT + 放量（vol ≥ 前 20 根均量 × 1.5）
    訊號一不計入總勝率
    """
    n = len(df)

    # ── 全部欄位一次抽成 numpy array（避免在 6 個迴圈內反覆 df.iloc）──
    times_iso = [_ts_val(t) for t in df["time"]]
    highs  = df["high"].to_numpy(dtype=float)
    lows   = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)

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
    recent:  list = []
    signals: list = []

    def _bump(counters, sig_key, direction, outcome):
        if outcome is None: return
        if direction == "short":
            counters[sig_key][0 if outcome == "win" else 1] += 1
        else:
            counters[sig_key][2 if outcome == "win" else 3] += 1

    def _scan_dual(entry_i, stop_px, direction):
        """同時掃中軌與帶軌目標。
        帶軌目標：short→bb_lower、long→bb_upper（更遠的反向極端）"""
        om, otm = _scan_outcome_np(highs, lows, closes, bb_mid, times_iso, entry_i, n, stop_px, direction)
        band_arr = bb_lo if direction == "short" else bb_up
        ob, otb = _scan_outcome_np(highs, lows, closes, band_arr, times_iso, entry_i, n, stop_px, direction)
        return om, otm, ob, otb

    def _push_signal(sig_time, d_str, sig_key, direction, om, otm, ob, otb):
        signals.append({
            "t": sig_time, "d": d_str, "k": sig_key,
            "r":   "w" if om == "win" else ("l" if om else None), "ot":   otm,
            "r_b": "w" if ob == "win" else ("l" if ob else None), "ot_b": otb,
        })
        _bump(mid_cnt,  sig_key, direction, om)
        _bump(band_cnt, sig_key, direction, ob)
        if om is not None:
            recent.append({"t": sig_time, "d": d_str, "r": "w" if om == "win" else "l", "k": sig_key})

    # ── 訊號一 ABC（同棒三條件）──────────────────────────────
    if n >= 2:
        m_short = (crt == -1) & (cross == -1) & (res == -1)
        m_long  = (crt ==  1) & (cross ==  1) & (res ==  1)
        m_short[n-1] = False  # 最後一根沒有 i+1
        m_long[n-1]  = False
        for i in np.flatnonzero(m_short | m_long):
            i = int(i)
            direction = "short" if m_short[i] else "long"
            stop_px = highs[i] if direction == "short" else lows[i]
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[i]
            om, otm, ob, otb = _scan_dual(i + 1, float(stop_px), direction)
            _push_signal(sig_time, d_str, "abc", direction, om, otm, ob, otb)

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
        for i in np.flatnonzero(m_short | m_long):
            i = int(i)
            direction = "short" if m_short[i] else "long"
            ib = i + 1
            stop_px = highs[ib] if direction == "short" else lows[ib]
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            om, otm, ob, otb = _scan_dual(i + 2, float(stop_px), direction)
            _push_signal(sig_time, d_str, "ab", direction, om, otm, ob, otb)

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
        for i in np.flatnonzero(s6_short | s6_long):
            i = int(i)
            direction = "short" if s6_short[i] else "long"
            d_bar = i + 3  # D 棒在原始 array 的索引
            stop_px = highs[d_bar] if direction == "short" else lows[d_bar]
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[d_bar]
            om, otm, ob, otb = _scan_dual(d_bar + 1, float(stop_px), direction)
            _push_signal(sig_time, d_str, "6", direction, om, otm, ob, otb)

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

        def _process_3bar(short_mask, long_mask, k_str):
            for i in np.flatnonzero(short_mask | long_mask):
                i = int(i)
                direction = "short" if short_mask[i] else "long"
                if direction == "short":
                    stop_px = max(a_hi[i], b_hi[i], c_hi[i])
                else:
                    stop_px = min(a_lo_[i], b_lo_[i], c_lo_[i])
                d_str = "s" if direction == "short" else "l"
                sig_time = times_iso[i + 2]
                om, otm, ob, otb = _scan_dual(i + 3, float(stop_px), direction)
                _push_signal(sig_time, d_str, k_str, direction, om, otm, ob, otb)

        _process_3bar(s3_short, s3_long, "3")
        _process_3bar(s4_short, s4_long, "4")
        _process_3bar(s5_short, s5_long, "5")

    # ── 統計輸出 ─────────────────────────────────────────────
    def _stats(w, l):
        t = w + l
        return {"total": t, "wins": w, "losses": l, "win_rate": round(w / t * 100, 1) if t else None}

    def _build_target_stats(cnt):
        """從 cnt dict 算出該 target 的完整統計結構。"""
        per_sig = {k: {"short": _stats(v[0], v[1]), "long": _stats(v[2], v[3])} for k, v in cnt.items()}
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

    mid_out  = _build_target_stats(mid_cnt)
    band_out = _build_target_stats(band_cnt)
    recent.sort(key=lambda x: x["t"])
    from_date = str(df.iloc[0]["time"])[:10] if n else ""

    return {
        **mid_out,                # backward compat：mid 統計放在頂層
        "band": band_out,         # 新增：帶軌（short=BB 下軌、long=BB 上軌）統計
        "from_date": from_date,
        "recent":   recent[-30:],
        "signals":  signals,
    }
