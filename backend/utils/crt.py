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
    # 強化版 filter：訊號棒量能放大（vol > 1.3× MA20）
    # 試過反向收盤（過寬鬆，91% 訊號都通過）、拒絕影線（反而更差），最後回到量能
    # 1.5× 太緊（樣本掉太多），1.3× 是兼顧樣本與品質的平衡點
    vol = _col_f("volume")
    vol_ma20 = np.full(n, np.nan, dtype=float)
    if n >= 20:
        csum = np.cumsum(vol)
        vol_ma20[19:] = (csum[19:] - np.concatenate([[0.0], csum[:-20]])) / 20.0
    vol_climax = (~np.isnan(vol_ma20)) & (vol > vol_ma20 * 1.3)
    # 為了沿用既有變數名（避免改 5 處 signal block），重新命名
    rev_short = vol_climax
    rev_long  = vol_climax

    # ── 給 S9 用的 BB 觸軌 + MACD 叉判定 ─────────────────────
    # 觸軌用 0.3% 緩衝（與共振一致）
    bb_up_touch = (~np.isnan(bb_up)) & (highs >= bb_up * 0.997)
    bb_lo_touch = (~np.isnan(bb_lo)) & (lows  <= bb_lo * 1.003)
    # MACD hist 過零
    hist = _col_f("macd_hist")
    prev_hist = np.concatenate([[np.nan], hist[:-1]])
    macd_dead = (prev_hist > 0) & (hist <= 0) & ~np.isnan(prev_hist) & ~np.isnan(hist)
    macd_gold = (prev_hist < 0) & (hist >= 0) & ~np.isnan(prev_hist) & ~np.isnan(hist)

    # ── 計數器：mid_cnt[k] = [ws, ls, wl, ll]；band_cnt 同結構 ──
    # 同時為「強化版」（_v）建一份，只計入 macd_hist 方向一致的訊號
    SIG_KEYS = ["abc", "ab", "3", "4", "5", "6", "7", "8", "9"]
    mid_cnt   = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    band_cnt  = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    mid_cnt_v = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    band_cnt_v= {k: [0, 0, 0, 0] for k in SIG_KEYS}
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
    mid_rr   = {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
    band_rr  = {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
    mid_rr_v = {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
    band_rr_v= {k: {"short": _new_rr_bucket(), "long": _new_rr_bucket()} for k in SIG_KEYS}
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
                     om, otm, omj, ob, otb, obj, variant=False):
        signals.append({
            "t": sig_time, "d": d_str, "k": sig_key,
            "r":   "w" if om == "win" else ("l" if om else None), "ot":   otm,
            "r_b": "w" if ob == "win" else ("l" if ob else None), "ot_b": otb,
            "v": bool(variant),  # 強化版（macd_hist 方向一致）才為 True
        })
        _bump(mid_cnt,  sig_key, direction, om)
        _bump(band_cnt, sig_key, direction, ob)
        _bump_rr(mid_rr,  sig_key, direction, entry_i, omj, stop_px, om, bb_mid)
        band_arr = bb_lo if direction == "short" else bb_up
        _bump_rr(band_rr, sig_key, direction, entry_i, obj, stop_px, ob, band_arr)
        # 強化版：只有 macd_hist 方向一致的訊號才進 _v 計數器
        if variant:
            _bump(mid_cnt_v,  sig_key, direction, om)
            _bump(band_cnt_v, sig_key, direction, ob)
            _bump_rr(mid_rr_v,  sig_key, direction, entry_i, omj, stop_px, om, bb_mid)
            _bump_rr(band_rr_v, sig_key, direction, entry_i, obj, stop_px, ob, band_arr)
        if om is not None:
            recent.append({"t": sig_time, "d": d_str, "r": "w" if om == "win" else "l", "k": sig_key})

    # ── 訊號一 ABC（同棒三條件）──────────────────────────────
    # 排除：訊號棒影線已碰到 BB 中軌（目標已達成，無利可圖）
    if n >= 2:
        m_short = (crt == -1) & (cross == -1) & (res == -1) \
                & ~np.isnan(bb_mid) & (lows > bb_mid)
        m_long  = (crt ==  1) & (cross ==  1) & (res ==  1) \
                & ~np.isnan(bb_mid) & (highs < bb_mid)
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
            # 強化版：訊號棒（i）反向收盤（空：收低半 / 多：收高半）
            variant = rev_short[i] if direction == "short" else rev_long[i]
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "abc", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj, variant=bool(variant))

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
            ib = i + 1   # B 棒（訊號棒）
            stop_px = _stop(highs[ib] if direction == "short" else lows[ib], direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            entry_i = i + 2
            # 強化版：B 棒（訊號棒）反向收盤
            variant = rev_short[ib] if direction == "short" else rev_long[ib]
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "ab", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj, variant=bool(variant))

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
        # 加排除「D 棒已碰中軌」（與其他訊號統一）
        d_bbm   = bb_mid[3:n-1]
        s6_short = a_clean & b_clean & c_clean \
                 & (d_crt == -1) & ~np.isnan(d_bbu) & (d_hi  >= d_bbu) \
                 & ~np.isnan(d_bbm) & (d_lo_ > d_bbm)
        s6_long  = a_clean & b_clean & c_clean \
                 & (d_crt ==  1) & ~np.isnan(d_bbl) & (d_lo_ <= d_bbl) \
                 & ~np.isnan(d_bbm) & (d_hi < d_bbm)
        if long_only: s6_short[:] = False
        for i in np.flatnonzero(s6_short | s6_long):
            i = int(i)
            direction = "short" if s6_short[i] else "long"
            d_bar = i + 3  # D 棒（訊號棒）在原始 array 的索引
            stop_px = _stop(highs[d_bar] if direction == "short" else lows[d_bar], direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[d_bar]
            entry_i = d_bar + 1
            # 強化版：D 棒（訊號棒）反向收盤
            variant = rev_short[d_bar] if direction == "short" else rev_long[d_bar]
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "6", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj, variant=bool(variant))

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
        # 加排除「已碰中軌」（與 S2/S4/S5 統一）：c 棒影線必須在中軌的「外側」
        s3_short = (a_res == -1) & ~((a_crt == -1) & (a_cross == -1)) \
                 & (b_res == -1) & ~((b_crt == -1) & (b_cross == -1)) \
                 & (c_cross == -1) & ~((c_crt == -1) & (c_res == -1)) \
                 & ~np.isnan(c_bbu) & (c_hi < c_bbu) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s3_long  = (a_res ==  1) & ~((a_crt ==  1) & (a_cross ==  1)) \
                 & (b_res ==  1) & ~((b_crt ==  1) & (b_cross ==  1)) \
                 & (c_cross ==  1) & ~((c_crt ==  1) & (c_res ==  1)) \
                 & ~np.isnan(c_bbl) & (c_lo_ > c_bbl) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

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

        # ── 訊號七 S7（S4 寬鬆版）────────────────────────────────
        # 短：A 棒 必含 CRT 空（與 S4 不同）+ 共振 -1 + KDJ=0
        #     B 棒 全無
        #     C 棒 KDJ 死叉 + res=0 + CRT 不限（允許 CRT 空，S4 必須 0）
        s7_short = (a_res == -1) & (a_crt == -1) & (a_cross == 0) \
                 & (b_res == 0)  & (b_crt == 0)  & (b_cross == 0) \
                 & (c_cross == -1) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s7_long  = (a_res ==  1) & (a_crt ==  1) & (a_cross == 0) \
                 & (b_res == 0)  & (b_crt == 0)  & (b_cross == 0) \
                 & (c_cross ==  1) & (c_res == 0) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

        # ── 訊號八 S8（三棒「一棒一指標」序列：超買 → CRT → 死叉）─
        # 短：A 只共振、B 只 CRT 空、C 只 KDJ 死叉，三棒分別出現單一指標
        s8_short = (a_res == -1) & (a_crt == 0)  & (a_cross == 0) \
                 & (b_crt == -1) & (b_res == 0)  & (b_cross == 0) \
                 & (c_cross == -1) & (c_res == 0) & (c_crt == 0) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s8_long  = (a_res ==  1) & (a_crt == 0)  & (a_cross == 0) \
                 & (b_crt ==  1) & (b_res == 0)  & (b_cross == 0) \
                 & (c_cross ==  1) & (c_res == 0) & (c_crt == 0) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

        # ── 訊號九 S9（三棒視窗：BB 觸軌 + MACD 叉）──────────
        # 短：A/B/C 任一根碰布林上軌 AND 任一根 MACD 死叉
        # 多：A/B/C 任一根碰布林下軌 AND 任一根 MACD 金叉
        a_bup = bb_up_touch[:n-3]; b_bup = bb_up_touch[1:n-2]; c_bup = bb_up_touch[2:n-1]
        a_blo = bb_lo_touch[:n-3]; b_blo = bb_lo_touch[1:n-2]; c_blo = bb_lo_touch[2:n-1]
        a_mdd = macd_dead[:n-3];   b_mdd = macd_dead[1:n-2];   c_mdd = macd_dead[2:n-1]
        a_mdg = macd_gold[:n-3];   b_mdg = macd_gold[1:n-2];   c_mdg = macd_gold[2:n-1]
        s9_short = (a_bup | b_bup | c_bup) & (a_mdd | b_mdd | c_mdd) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s9_long  = (a_blo | b_blo | c_blo) & (a_mdg | b_mdg | c_mdg) \
                 & ~np.isnan(c_bbm) & (c_hi < c_bbm)

        if long_only:
            s3_short[:] = False
            s4_short[:] = False
            s5_short[:] = False
            s7_short[:] = False
            s8_short[:] = False
            s9_short[:] = False

        def _process_3bar(short_mask, long_mask, k_str):
            for i in np.flatnonzero(short_mask | long_mask):
                i = int(i)
                direction = "short" if short_mask[i] else "long"
                if direction == "short":
                    stop_px = _stop(max(a_hi[i], b_hi[i], c_hi[i]), direction)
                else:
                    stop_px = _stop(min(a_lo_[i], b_lo_[i], c_lo_[i]), direction)
                d_str = "s" if direction == "short" else "l"
                c_bar = i + 2  # C 棒（訊號棒）
                sig_time = times_iso[c_bar]
                entry_i = i + 3
                # 強化版：C 棒（訊號棒）反向收盤
                variant = rev_short[c_bar] if direction == "short" else rev_long[c_bar]
                om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
                _push_signal(sig_time, d_str, k_str, direction, entry_i, float(stop_px),
                             om, otm, omj, ob, otb, obj, variant=bool(variant))

        _process_3bar(s3_short, s3_long, "3")
        _process_3bar(s4_short, s4_long, "4")
        _process_3bar(s5_short, s5_long, "5")
        _process_3bar(s7_short, s7_long, "7")
        _process_3bar(s8_short, s8_long, "8")
        _process_3bar(s9_short, s9_long, "9")

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

    def _build_target_stats(cnt, rr_cnt, cnt_v=None, rr_cnt_v=None):
        """從 cnt + rr_cnt 算出該 target 的完整統計結構。
        如帶 cnt_v / rr_cnt_v，再算出 *_v（強化版 = 加 MACD 方向 filter）"""
        per_sig = {
            k: {
                "short": _stats(v[0], v[1], rr_cnt[k]["short"]),
                "long":  _stats(v[2], v[3], rr_cnt[k]["long"]),
            }
            for k, v in cnt.items()
        }
        per_sig_v = None
        if cnt_v is not None and rr_cnt_v is not None:
            per_sig_v = {
                k: {
                    "short": _stats(v[0], v[1], rr_cnt_v[k]["short"]),
                    "long":  _stats(v[2], v[3], rr_cnt_v[k]["long"]),
                }
                for k, v in cnt_v.items()
            }
        # 訊號一不計入合計
        wins_s   = sum(cnt[k][0] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
        losses_s = sum(cnt[k][1] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
        wins_l   = sum(cnt[k][2] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
        losses_l = sum(cnt[k][3] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
        tot = wins_s + losses_s + wins_l + losses_l
        wins = wins_s + wins_l
        out = {
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
            "s7":       per_sig["7"],
            "s8":       per_sig["8"],
            "s9":       per_sig["9"],
        }
        if per_sig_v is not None:
            # 強化版合計（S2~S9 _v）
            wins_s_v   = sum(cnt_v[k][0] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
            losses_s_v = sum(cnt_v[k][1] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
            wins_l_v   = sum(cnt_v[k][2] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
            losses_l_v = sum(cnt_v[k][3] for k in ("ab", "3", "4", "5", "6", "7", "8", "9"))
            tot_v = wins_s_v + losses_s_v + wins_l_v + losses_l_v
            wins_v = wins_s_v + wins_l_v
            out["variant"] = {
                "total":    tot_v,
                "wins":     wins_v,
                "win_rate": round(wins_v / tot_v * 100, 1) if tot_v else None,
                "short":    _stats(wins_s_v, losses_s_v),
                "long":     _stats(wins_l_v, losses_l_v),
                "abc":      per_sig_v["abc"],
                "ab":       per_sig_v["ab"],
                "s3":       per_sig_v["3"],
                "s4":       per_sig_v["4"],
                "s5":       per_sig_v["5"],
                "s6":       per_sig_v["6"],
                "s7":       per_sig_v["7"],
                "s8":       per_sig_v["8"],
                "s9":       per_sig_v["9"],
            }
        return out

    mid_out  = _build_target_stats(mid_cnt,  mid_rr,  mid_cnt_v,  mid_rr_v)
    band_out = _build_target_stats(band_cnt, band_rr, band_cnt_v, band_rr_v)
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
