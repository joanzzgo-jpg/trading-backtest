"""CRT 策略訊號掃描與勝率計算"""
import pandas as pd


def _ts(row) -> str:
    t = row["time"]
    return t.isoformat() if hasattr(t, "isoformat") else str(t)


def _scan_outcome(df: pd.DataFrame, entry_i: int, stop_px: float, direction: str):
    """從 entry_i 向後掃描，回傳 ('win'/'loss', bar_time) 或 (None, None)"""
    n = len(df)
    for j in range(entry_i, n):
        bar    = df.iloc[j]
        bb_mid = bar.get("bb_middle")
        if pd.isna(bb_mid):
            continue
        hi, lo, cl = float(bar["high"]), float(bar["low"]), float(bar["close"])
        bb_mid = float(bb_mid)
        if direction == "short":
            hit_stop = hi >= stop_px
            hit_tgt  = lo <= bb_mid
            if hit_stop and hit_tgt:
                result = "win" if cl <= bb_mid else "loss"
            elif hit_stop: result = "loss"
            elif hit_tgt:  result = "win"
            else: continue
        else:
            hit_stop = lo <= stop_px
            hit_tgt  = hi >= bb_mid
            if hit_stop and hit_tgt:
                result = "win" if cl >= bb_mid else "loss"
            elif hit_stop: result = "loss"
            elif hit_tgt:  result = "win"
            else: continue
        return result, _ts(bar)
    return None, None


def _calc_crt_winrate(df: pd.DataFrame) -> dict:
    """
    五種訊號合併計算勝率：
    1. ABC：同一棒 CRT + KDJ死/金叉 + 超買/超賣共振
    2. AB ：A棒共振，B棒（緊接）CRT + KDJ死/金叉
    3. S3 ：A棒僅共振，B棒僅共振，C棒僅KDJ死/金叉
    4. S4 ：A棒純共振，B棒無指標，C棒純KDJ死/金叉
    5. S5 ：A棒無指標，B棒純共振，C棒純KDJ死/金叉
    訊號一不計入總勝率
    """
    ws_abc = ls_abc = wl_abc = ll_abc = 0   # 訊號一
    ws_ab  = ls_ab  = wl_ab  = ll_ab  = 0   # 訊號二
    ws_3   = ls_3   = wl_3   = ll_3   = 0   # 訊號三
    ws_4   = ls_4   = wl_4   = ll_4   = 0   # 訊號四
    ws_5   = ls_5   = wl_5   = ll_5   = 0   # 訊號五
    recent:  list = []
    signals: list = []
    n = len(df)

    def _iv(row, col):
        return int(row.get(col, 0) or 0)

    # ── 訊號一：ABC（同棒三條件）────────────────────────────
    for i in range(n - 1):
        row = df.iloc[i]
        crt_v = _iv(row, "crt"); cross_v = _iv(row, "kdj_cross"); res_v = _iv(row, "resonance")
        if   crt_v == -1 and cross_v == -1 and res_v == -1: direction = "short"
        elif crt_v ==  1 and cross_v ==  1 and res_v ==  1: direction = "long"
        else: continue
        entry_i = i + 1
        if entry_i >= n: continue
        stop_px  = float(row["high"]) if direction == "short" else float(row["low"])
        sig_time = _ts(df.iloc[i])
        d_str    = "s" if direction == "short" else "l"
        outcome, ot = _scan_outcome(df, entry_i, stop_px, direction)
        signals.append({"t": sig_time, "d": d_str, "k": "abc",
                         "r": "w" if outcome == "win" else ("l" if outcome else None), "ot": ot})
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_abc += 1
            else:                ls_abc += 1
        else:
            if outcome == "win": wl_abc += 1
            else:                ll_abc += 1
        recent.append({"t": sig_time, "d": d_str, "r": "w" if outcome == "win" else "l", "k": "abc"})

    # ── 訊號二：AB（A=共振，B=CRT+死/金叉）─────────────────
    for i in range(n - 2):
        row_a = df.iloc[i]
        row_b = df.iloc[i + 1]
        res_a   = _iv(row_a, "resonance")
        crt_b   = _iv(row_b, "crt")
        cross_b = _iv(row_b, "kdj_cross")
        if   res_a == -1 and crt_b == -1 and cross_b == -1: direction = "short"
        elif res_a ==  1 and crt_b ==  1 and cross_b ==  1: direction = "long"
        else: continue
        # B 棒同時出現共振 → 等同訊號一（ABC），不重複計入訊號二
        res_b = _iv(row_b, "resonance")
        if direction == "short" and res_b == -1: continue
        if direction == "long"  and res_b ==  1: continue
        # B 棒若影線或本體已碰到 BB 中軌，訊號無效（目標已提前觸及）
        bb_mid_b = row_b.get("bb_middle")
        if bb_mid_b is None or pd.isna(bb_mid_b): continue
        bb_mid_b = float(bb_mid_b)
        if direction == "short" and float(row_b["low"])  <= bb_mid_b: continue
        if direction == "long"  and float(row_b["high"]) >= bb_mid_b: continue
        entry_i = i + 2
        if entry_i >= n: continue
        stop_px  = float(row_b["high"]) if direction == "short" else float(row_b["low"])
        sig_time = _ts(df.iloc[i + 1])
        d_str    = "s" if direction == "short" else "l"
        outcome, ot = _scan_outcome(df, entry_i, stop_px, direction)
        signals.append({"t": sig_time, "d": d_str, "k": "ab",
                         "r": "w" if outcome == "win" else ("l" if outcome else None), "ot": ot})
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_ab += 1
            else:                ls_ab += 1
        else:
            if outcome == "win": wl_ab += 1
            else:                ll_ab += 1
        recent.append({"t": sig_time, "d": d_str, "r": "w" if outcome == "win" else "l", "k": "ab"})

    # ── 訊號三：ABC三棒（每棒最多兩個指標觸發）────────────────
    for i in range(n - 3):
        row_a = df.iloc[i]
        row_b = df.iloc[i + 1]
        row_c = df.iloc[i + 2]
        res_a = _iv(row_a, "resonance"); crt_a = _iv(row_a, "crt"); cross_a = _iv(row_a, "kdj_cross")
        res_b = _iv(row_b, "resonance"); crt_b = _iv(row_b, "crt"); cross_b = _iv(row_b, "kdj_cross")
        res_c = _iv(row_c, "resonance"); crt_c = _iv(row_c, "crt"); cross_c = _iv(row_c, "kdj_cross")
        s_a = res_a == -1 and not (crt_a == -1 and cross_a == -1)
        s_b = res_b == -1 and not (crt_b == -1 and cross_b == -1)
        s_c = cross_c == -1 and not (crt_c == -1 and res_c == -1)
        l_a = res_a == 1 and not (crt_a == 1 and cross_a == 1)
        l_b = res_b == 1 and not (crt_b == 1 and cross_b == 1)
        l_c = cross_c == 1 and not (crt_c == 1 and res_c == 1)
        if   s_a and s_b and s_c: direction = "short"
        elif l_a and l_b and l_c: direction = "long"
        else: continue
        # C 棒碰至布林上/下軌 → 不算訊號三
        bb_up_c = row_c.get("bb_upper"); bb_lo_c = row_c.get("bb_lower")
        if bb_up_c is None or pd.isna(bb_up_c): continue
        if bb_lo_c is None or pd.isna(bb_lo_c): continue
        if direction == "short" and float(row_c["high"]) >= float(bb_up_c) * 0.995: continue
        if direction == "long"  and float(row_c["low"])  <= float(bb_lo_c) * 1.005: continue
        entry_i = i + 3
        if entry_i >= n: continue
        if direction == "short":
            stop_px = max(float(row_a["high"]), float(row_b["high"]), float(row_c["high"]))
        else:
            stop_px = min(float(row_a["low"]),  float(row_b["low"]),  float(row_c["low"]))
        sig_time = _ts(df.iloc[i + 2])
        d_str    = "s" if direction == "short" else "l"
        outcome, ot = _scan_outcome(df, entry_i, stop_px, direction)
        signals.append({"t": sig_time, "d": d_str, "k": "3",
                         "r": "w" if outcome == "win" else ("l" if outcome else None), "ot": ot})
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_3 += 1
            else:                ls_3 += 1
        else:
            if outcome == "win": wl_3 += 1
            else:                ll_3 += 1
        recent.append({"t": sig_time, "d": d_str, "r": "w" if outcome == "win" else "l", "k": "3"})

    # ── 訊號四：ABC三棒（A純共振，B無指標，C純KDJ叉）────────────
    for i in range(n - 3):
        row_a = df.iloc[i]
        row_b = df.iloc[i + 1]
        row_c = df.iloc[i + 2]
        res_a = _iv(row_a, "resonance"); crt_a = _iv(row_a, "crt"); cross_a = _iv(row_a, "kdj_cross")
        res_b = _iv(row_b, "resonance"); crt_b = _iv(row_b, "crt"); cross_b = _iv(row_b, "kdj_cross")
        res_c = _iv(row_c, "resonance"); crt_c = _iv(row_c, "crt"); cross_c = _iv(row_c, "kdj_cross")
        s_a = res_a == -1 and crt_a == 0 and cross_a == 0
        s_b = res_b == 0  and crt_b == 0 and cross_b == 0
        s_c = cross_c == -1 and crt_c == 0 and res_c == 0
        l_a = res_a == 1 and crt_a == 0 and cross_a == 0
        l_b = res_b == 0 and crt_b == 0 and cross_b == 0
        l_c = cross_c == 1 and crt_c == 0 and res_c == 0
        if   s_a and s_b and s_c: direction = "short"
        elif l_a and l_b and l_c: direction = "long"
        else: continue
        bb_mid_c = row_c.get("bb_middle")
        if bb_mid_c is None or pd.isna(bb_mid_c): continue
        bb_mid_c = float(bb_mid_c)
        if direction == "short" and float(row_c["low"])  <= bb_mid_c: continue
        if direction == "long"  and float(row_c["high"]) >= bb_mid_c: continue
        entry_i = i + 3
        if entry_i >= n: continue
        if direction == "short":
            stop_px = max(float(row_a["high"]), float(row_b["high"]), float(row_c["high"]))
        else:
            stop_px = min(float(row_a["low"]),  float(row_b["low"]),  float(row_c["low"]))
        sig_time = _ts(df.iloc[i + 2])
        d_str    = "s" if direction == "short" else "l"
        outcome, ot = _scan_outcome(df, entry_i, stop_px, direction)
        signals.append({"t": sig_time, "d": d_str, "k": "4",
                         "r": "w" if outcome == "win" else ("l" if outcome else None), "ot": ot})
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_4 += 1
            else:                ls_4 += 1
        else:
            if outcome == "win": wl_4 += 1
            else:                ll_4 += 1
        recent.append({"t": sig_time, "d": d_str, "r": "w" if outcome == "win" else "l", "k": "4"})

    # ── 訊號五：ABC三棒（A無指標，B純共振，C純KDJ叉）────────────
    for i in range(n - 3):
        row_a = df.iloc[i]
        row_b = df.iloc[i + 1]
        row_c = df.iloc[i + 2]
        res_a = _iv(row_a, "resonance"); crt_a = _iv(row_a, "crt"); cross_a = _iv(row_a, "kdj_cross")
        res_b = _iv(row_b, "resonance"); crt_b = _iv(row_b, "crt"); cross_b = _iv(row_b, "kdj_cross")
        res_c = _iv(row_c, "resonance"); crt_c = _iv(row_c, "crt"); cross_c = _iv(row_c, "kdj_cross")
        s_a = res_a == 0  and crt_a == 0  and cross_a == 0
        s_b = res_b == -1 and crt_b == 0  and cross_b == 0
        s_c = cross_c == -1 and crt_c == 0 and res_c == 0
        l_a = res_a == 0 and crt_a == 0 and cross_a == 0
        l_b = res_b == 1 and crt_b == 0 and cross_b == 0
        l_c = cross_c == 1 and crt_c == 0 and res_c == 0
        if   s_a and s_b and s_c: direction = "short"
        elif l_a and l_b and l_c: direction = "long"
        else: continue
        bb_mid_c = row_c.get("bb_middle")
        if bb_mid_c is None or pd.isna(bb_mid_c): continue
        bb_mid_c = float(bb_mid_c)
        if direction == "short" and float(row_c["low"])  <= bb_mid_c: continue
        if direction == "long"  and float(row_c["high"]) >= bb_mid_c: continue
        entry_i = i + 3
        if entry_i >= n: continue
        if direction == "short":
            stop_px = max(float(row_a["high"]), float(row_b["high"]), float(row_c["high"]))
        else:
            stop_px = min(float(row_a["low"]),  float(row_b["low"]),  float(row_c["low"]))
        sig_time = _ts(df.iloc[i + 2])
        d_str    = "s" if direction == "short" else "l"
        outcome, ot = _scan_outcome(df, entry_i, stop_px, direction)
        signals.append({"t": sig_time, "d": d_str, "k": "5",
                         "r": "w" if outcome == "win" else ("l" if outcome else None), "ot": ot})
        if outcome is None: continue
        if direction == "short":
            if outcome == "win": ws_5 += 1
            else:                ls_5 += 1
        else:
            if outcome == "win": wl_5 += 1
            else:                ll_5 += 1
        recent.append({"t": sig_time, "d": d_str, "r": "w" if outcome == "win" else "l", "k": "5"})

    # ── 統計 ────────────────────────────────────────────────
    def _stats(w, l):
        t = w + l
        return {"total": t, "wins": w, "losses": l, "win_rate": round(w / t * 100, 1) if t else None}

    # 訊號一不計入總勝率（僅顯示，不影響合計）
    wins_s = ws_ab + ws_3 + ws_4 + ws_5;  losses_s = ls_ab + ls_3 + ls_4 + ls_5
    wins_l = wl_ab + wl_3 + wl_4 + wl_5;  losses_l = ll_ab + ll_3 + ll_4 + ll_5
    tot_s = wins_s + losses_s; tot_l = wins_l + losses_l
    total = tot_s + tot_l;     wins  = wins_s + wins_l
    recent.sort(key=lambda x: x["t"])
    from_date = str(df.iloc[0]["time"])[:10]

    return {
        "total":    total,
        "wins":     wins,
        "win_rate": round(wins / total * 100, 1) if total else None,
        "short":    _stats(wins_s, losses_s),
        "long":     _stats(wins_l, losses_l),
        "abc":      {"short": _stats(ws_abc, ls_abc), "long": _stats(wl_abc, ll_abc)},
        "ab":       {"short": _stats(ws_ab,  ls_ab),  "long": _stats(wl_ab,  ll_ab)},
        "s3":       {"short": _stats(ws_3,   ls_3),   "long": _stats(wl_3,   ll_3)},
        "s4":       {"short": _stats(ws_4,   ls_4),   "long": _stats(wl_4,   ll_4)},
        "s5":       {"short": _stats(ws_5,   ls_5),   "long": _stats(wl_5,   ll_5)},
        "from_date": from_date,
        "recent":   recent[-30:],
        "signals":  signals,
    }
