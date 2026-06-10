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


def _scan_outcome_fixed(highs, lows, closes, entry_i, n, stop_px, target_px, direction):
    """向量化掃描固定目標價的勝敗（同樣有 max_hold cap）。
    用於「打到一開始預估止盈」機率。回傳 'win' / 'loss' / None"""
    end = min(n, entry_i + _SCAN_MAX_HOLD)
    if entry_i >= end:
        return None
    hi = highs[entry_i:end]
    lo = lows[entry_i:end]
    cl = closes[entry_i:end]
    if direction == "short":
        hit_stop = hi >= stop_px
        hit_tgt  = lo <= target_px
    else:
        hit_stop = lo <= stop_px
        hit_tgt  = hi >= target_px
    hit_any = hit_stop | hit_tgt
    rel_idx = np.flatnonzero(hit_any)
    if len(rel_idx) == 0:
        return None
    j = rel_idx[0]
    if hit_stop[j] and hit_tgt[j]:
        # 同棒雙觸 → 看收盤
        if direction == "short":
            return "win" if cl[j] <= target_px else "loss"
        return "win" if cl[j] >= target_px else "loss"
    return "win" if hit_tgt[j] else "loss"


def _scan_outcome_fixed_t(highs, lows, closes, times_iso, entry_i, n, stop_px, target_px, direction):
    """同 _scan_outcome_fixed，但額外回傳結算時間與索引（給 1:1 固定目標的圖表標記用）。
    回傳 ('win'/'loss', bar_time_iso, exit_idx) 或 (None, None, -1)。"""
    end = min(n, entry_i + _SCAN_MAX_HOLD)
    if entry_i >= end:
        return None, None, -1
    hi = highs[entry_i:end]
    lo = lows[entry_i:end]
    cl = closes[entry_i:end]
    if direction == "short":
        hit_stop = hi >= stop_px
        hit_tgt  = lo <= target_px
    else:
        hit_stop = lo <= stop_px
        hit_tgt  = hi >= target_px
    rel_idx = np.flatnonzero(hit_stop | hit_tgt)
    if len(rel_idx) == 0:
        return None, None, -1
    j = rel_idx[0]
    j_abs = entry_i + int(j)
    if hit_stop[j] and hit_tgt[j]:
        if direction == "short":
            result = "win" if cl[j] <= target_px else "loss"
        else:
            result = "win" if cl[j] >= target_px else "loss"
    elif hit_stop[j]:
        result = "loss"
    else:
        result = "win"
    return result, times_iso[j_abs], j_abs


_SCAN_MAX_HOLD = 500   # 單個訊號最長掃描 K 棒數（避免最近的未結算訊號掃到資料底）

def _scan_outcome_np(highs, lows, closes, target_arr, times_iso, entry_i, n, stop_px, direction):
    """向量化版本：從 entry_i 掃描動態目標，比 Python for-loop 快 ~30x。

    回傳 ('win'/'loss', bar_time_iso, exit_idx) 或 (None, None, -1)。
    target NaN 的 K 棒整根跳過（不計止損也不計目標，與原版一致）。
    最多掃 _SCAN_MAX_HOLD 根 K 棒。
    """
    end = min(n, entry_i + _SCAN_MAX_HOLD)
    if entry_i >= end:
        return None, None, -1
    hi = highs[entry_i:end]
    lo = lows[entry_i:end]
    cl = closes[entry_i:end]
    t  = target_arr[entry_i:end]
    t_valid = ~np.isnan(t)
    if direction == "short":
        hit_stop = (hi >= stop_px) & t_valid   # NaN bar 整根跳過
        hit_tgt  = (lo <= t) & t_valid
    else:
        hit_stop = (lo <= stop_px) & t_valid
        hit_tgt  = (hi >= t) & t_valid
    rel_idx = np.flatnonzero(hit_stop | hit_tgt)
    if len(rel_idx) == 0:
        return None, None, -1
    j = rel_idx[0]
    j_abs = entry_i + int(j)
    tj = t[j]
    if hit_stop[j] and hit_tgt[j]:
        # 同棒雙觸 → 看收盤
        if direction == "short":
            result = "win" if cl[j] <= tj else "loss"
        else:
            result = "win" if cl[j] >= tj else "loss"
    elif hit_stop[j]:
        result = "loss"
    else:
        result = "win"
    return result, times_iso[j_abs], j_abs


def _calc_crt_winrate(df: pd.DataFrame, stop_buffer_pct: float = 0.0, long_only: bool = False,
                      _solve=None) -> dict:
    """
    六種訊號合併計算勝率（中軌目標 + 帶軌目標雙統計）。

    stop_buffer_pct：停損緩衝百分比（decimal，例如 0.005 = 0.5%）。
    short：stop = base_high × (1 + buffer)（高於最高值幾 %）
    long ：stop = base_low  × (1 - buffer)（低於最低值幾 %）

    long_only：True 時只算多單（台股不能放空），所有 short mask 強制清空。

    _solve：求解專用精簡模式 = target 字串（"mid"/"band"/"rr"）。
        設定後：每個訊號只掃選定目標（省 3/4 掃描）、跳過 est/RR/全部統計，
        只跑「敗後停手」模擬並回傳 {"win_rate", "total"}。
        偵測 mask 與完整版完全共用，結果與完整版 stop_strategy 一致。
    """
    n = len(df)

    # ── 全部欄位一次抽成 numpy array（避免在 6 個迴圈內反覆 df.iloc）──
    # 時間戳→ISO 字串：向量化（numpy datetime64[s]→str），取代逐根 _ts_val + pandas 慢速 __iter__，
    # 省下整體計算 ~30% 時間。tz-naive 秒精度下與 _ts_val(t.isoformat()) 完全一致；異常時退回逐根。
    try:
        times_iso = df["time"].to_numpy("datetime64[s]").astype(str).tolist()
    except Exception:
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
    # SS 系列：獨立於 S1~S12 的新訊號群，自成一套合計與「敗後停手」（不與 S 的合併時間軸混搭）。
    _SS_KEYS = ("ss1",)
    SIG_KEYS = ["abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", *_SS_KEYS]
    mid_cnt   = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    band_cnt  = {k: [0, 0, 0, 0] for k in SIG_KEYS}
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
    # 1:1 目標（止盈距離 = 止損距離）：盈虧比恆為 1，RR 統計可由勝負數直接推得，不需 bucket
    rr11_cnt   = {k: [0, 0, 0, 0] for k in SIG_KEYS}
    # 所有 est 計數已改為從 signals 列表 dedupe 計算（見 _dedupe_totals）
    recent:  list = []
    signals: list = []

    # 連續去重：S9 / S10 / S12 因為是「視窗式掃描」，連續多根 K 棒會重複觸發同個 setup
    # → 只計第一筆（連續同方向 entry_i 相差 1 視為延續）
    _DEDUP_SIG_KEYS = {"9", "10", "12"}
    _last_entry_per_kd = {}   # (sig_key, direction) → 最後一次 entry_i（push 與 skip 都更新）

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
        帶軌目標：short→bb_lower、long→bb_upper（更遠的反向極端）。
        _solve 模式只掃選定目標，另一目標回 None（省一半掃描）。"""
        if _solve is not None:
            if _solve == "rr":
                return None, None, -1, None, None, -1   # 1:1 在 _push_signal 內算
            if _solve == "band":
                band_arr = bb_lo if direction == "short" else bb_up
                ob, otb, obj = _scan_outcome_np(highs, lows, closes, band_arr, times_iso, entry_i, n, stop_px, direction)
                return None, None, -1, ob, otb, obj
            om, otm, omj = _scan_outcome_np(highs, lows, closes, bb_mid, times_iso, entry_i, n, stop_px, direction)
            return om, otm, omj, None, None, -1
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

    def _scan_rr(sig_key, direction, entry_i, stop_px):
        """1:1 目標（止盈距離 = 止損距離）勝負。

        ⚠ 1:1(rr) 目標已從前端移除（2026-06）→ 不再掃描，省下每個訊號一次固定目標
        掃描（勝率計算的可觀成本）。輸出仍保留 rr 結構但為空、signals r_rr=None，前端不讀。
        若日後要恢復：掃 target = 進場價 ∓ |進場價 - 止損| 的 _scan_outcome_fixed_t。"""
        return None, None

    def _push_signal(sig_time, d_str, sig_key, direction, entry_i, stop_px,
                     om, otm, omj, ob, otb, obj):
        # 連續去重：S9 / S10 視窗式掃描，連續 entry_i 視為同一個 setup → 只保留第一筆
        # （無論是否被 skip，都更新 last_entry_i 以正確處理 N 根連續的長串）
        if sig_key in _DEDUP_SIG_KEYS:
            _kd = (sig_key, direction)
            _prev = _last_entry_per_kd.get(_kd)
            _last_entry_per_kd[_kd] = entry_i
            if _prev is not None and entry_i == _prev + 1:
                return   # 連續同方向 → 跳過（既不 push 進 signals 也不算進統計）

        # _solve 精簡模式：只存敗後停手所需欄位（t/d/k/r/r_b/r_rr），跳過 est/RR/recent
        if _solve is not None:
            r_rr = None
            if _solve == "rr":
                r_rr, _ = _scan_rr(sig_key, direction, entry_i, stop_px)
            signals.append({
                "t": sig_time, "d": d_str, "k": sig_key,
                "r":   "w" if om == "win" else ("l" if om else None),
                "r_b": "w" if ob == "win" else ("l" if ob else None),
                "r_rr": r_rr,
            })
            return
        # est_r / est_r_b：固定目標掃描結果（要存到 signal 才能算 deduped total）
        est_r = None; est_r_b = None
        if sig_key != "abc" and entry_i < n:
            tgt_mid_fix  = bb_mid[entry_i]
            tgt_band_fix = bb_lo[entry_i] if direction == "short" else bb_up[entry_i]
            if tgt_mid_fix == tgt_mid_fix:
                o = _scan_outcome_fixed(highs, lows, closes, entry_i, n,
                                         stop_px, float(tgt_mid_fix), direction)
                est_r = "w" if o == "win" else ("l" if o == "loss" else None)
            if tgt_band_fix == tgt_band_fix:
                o = _scan_outcome_fixed(highs, lows, closes, entry_i, n,
                                         stop_px, float(tgt_band_fix), direction)
                est_r_b = "w" if o == "win" else ("l" if o == "loss" else None)
        # 預估盈虧比 RR(中軌) = |進場-目標|/|進場-止損|，供前端盈虧比盒顯示
        est_rr_val = None
        if sig_key != "abc" and entry_i < n:
            entry_px = opens[entry_i]
            tgt_mid  = bb_mid[entry_i]
            if not (math.isnan(entry_px) or math.isnan(tgt_mid)):
                risk = abs(entry_px - stop_px)
                if risk > 1e-9:
                    est_rr_val = round(abs(entry_px - tgt_mid) / risk, 3)
        # 1:1 目標結果（止盈距離 = 止損距離）
        r_rr, ot_rr = _scan_rr(sig_key, direction, entry_i, stop_px)
        rr_out = "win" if r_rr == "w" else ("loss" if r_rr == "l" else None)
        # 進場價（下一根開盤）→ 回測算「資金用量」用：部位佔資金 = 風險% ÷ (|進場-止損|/進場)
        entry_px_rec = None
        if 0 <= entry_i < n:
            _ep = opens[entry_i]
            if not math.isnan(_ep):
                entry_px_rec = float(_ep)
        # 已實現盈虧比（含號）：依「實際出場棒的目標價」算。動態中軌/帶軌會漂移，趨勢拖久時
        # 出場目標可能漂到進場的錯邊 → 雖判 win 但實際是虧 → rr 為負。回測用此才貼近真實損益。
        # 出場在止損 → -1R；未結算/取不到 → None。（omj/obj 為絕對出場索引）
        rr_real = rr_b_real = None
        if entry_px_rec is not None:
            _risk = abs(entry_px_rec - stop_px)
            if _risk > 1e-9:
                def _rr_real(outcome, exit_idx, tgt_arr):
                    if outcome == "loss":
                        return -1.0
                    if outcome != "win" or exit_idx is None or exit_idx < 0 or exit_idx >= n:
                        return None
                    xpx = tgt_arr[exit_idx]
                    if math.isnan(xpx):
                        return None
                    rew = (entry_px_rec - xpx) if direction == "short" else (xpx - entry_px_rec)
                    return round(rew / _risk, 3)
                rr_real   = _rr_real(om, omj, bb_mid)
                rr_b_real = _rr_real(ob, obj, bb_lo if direction == "short" else bb_up)
        signals.append({
            "t": sig_time, "d": d_str, "k": sig_key,
            "r":   "w" if om == "win" else ("l" if om else None), "ot":   otm,
            "r_b": "w" if ob == "win" else ("l" if ob else None), "ot_b": otb,
            "r_rr": r_rr, "ot_rr": ot_rr,
            "stop": float(stop_px),   # 實際止損價（含 buffer、多棒取極值）→ 前端盈虧比盒/1:1 止盈用
            "entry": entry_px_rec,    # 進場價（含 None＝末端未進場）
            "est_r":   est_r,
            "est_r_b": est_r_b,
            "rr": est_rr_val,         # 進場預估盈虧比（恆正，供前端 RR 盒/顯示）
            "rr_real":   rr_real,     # 已實現盈虧比(中軌，含號)→ 回測用
            "rr_b_real": rr_b_real,   # 已實現盈虧比(上下軌，含號)
        })
        _bump(mid_cnt,  sig_key, direction, om)
        _bump(band_cnt, sig_key, direction, ob)
        _bump(rr11_cnt, sig_key, direction, rr_out)
        _bump_rr(mid_rr,  sig_key, direction, entry_i, omj, stop_px, om, bb_mid)
        band_arr = bb_lo if direction == "short" else bb_up
        _bump_rr(band_rr, sig_key, direction, entry_i, obj, stop_px, ob, band_arr)
        if om is not None and sig_key not in _SS_KEYS:   # SS 系列不混入 S 的近期清單
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
            ib = i + 1   # B 棒（訊號棒）
            # 止損：A、B 兩棒取最高（做空）/ 最低（做多）
            if direction == "short":
                stop_px = _stop(max(highs[i], highs[ib]), direction)
            else:
                stop_px = _stop(min(lows[i], lows[ib]), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            entry_i = i + 2
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "ab", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── 訊號六 S6（3 棒 pattern：AB 無指標 + C 觸軌 CRT 反轉）─────
    # A、B 兩根都不能有任何指標（crt=0, cross=0, res=0）
    # C 棒（訊號棒）：做空 → crt=-1 且 high >= bb_upper（影線或本體觸上軌）
    #               做多 → crt=+1 且 low  <= bb_lower
    # 邏輯：2 根「安靜」棒後突然出現觸軌反轉 K → 高品質的「轉折開始」訊號。
    #       原為「3 安靜棒 + 第 4 根反轉」，但前 3 根全乾淨太嚴格、實戰常漏；
    #       改為「2 安靜棒 + 第 3 根反轉」更貼近實際復盤所見。
    if n >= 4:
        s6_a = (crt[:n-3]  == 0) & (cross[:n-3]  == 0) & (res[:n-3]  == 0)
        s6_b = (crt[1:n-2] == 0) & (cross[1:n-2] == 0) & (res[1:n-2] == 0)
        s6c_crt = crt[2:n-1]
        s6c_hi  = highs[2:n-1]
        s6c_lo  = lows[2:n-1]
        s6c_bbu = bb_up[2:n-1]
        s6c_bbl = bb_lo[2:n-1]
        s6c_bbm = bb_mid[2:n-1]   # 排除「C 棒已碰中軌」（與其他訊號統一）
        s6_short = s6_a & s6_b \
                 & (s6c_crt == -1) & ~np.isnan(s6c_bbu) & (s6c_hi >= s6c_bbu) \
                 & ~np.isnan(s6c_bbm) & (s6c_lo > s6c_bbm)
        s6_long  = s6_a & s6_b \
                 & (s6c_crt ==  1) & ~np.isnan(s6c_bbl) & (s6c_lo <= s6c_bbl) \
                 & ~np.isnan(s6c_bbm) & (s6c_hi < s6c_bbm)
        if long_only: s6_short[:] = False
        for i in np.flatnonzero(s6_short | s6_long):
            i = int(i)
            direction = "short" if s6_short[i] else "long"
            c_bar = i + 2  # C 棒（訊號棒 = 觸軌 CRT 反轉棒）在原始 array 的索引
            # 止損：A、B、C 三棒取最高（做空）/ 最低（做多）
            if direction == "short":
                stop_px = _stop(max(highs[i], highs[i+1], highs[c_bar]), direction)
            else:
                stop_px = _stop(min(lows[i], lows[i+1], lows[c_bar]), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[c_bar]
            entry_i = c_bar + 1
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

        # 只排除「已碰中軌」（與 S2/S4/S5 統一）：c 棒影線必須在中軌的「外側」。
        # 不再排除「C 棒觸到上/下軌」——均值回歸時，死叉棒刺到上軌（超買後反轉）
        # 正是最佳進場點，排除它反而漏掉強訊號（例：超賣叢集→金叉、叉棒刺破下軌）。
        s3_short = (a_res == -1) & ~((a_crt == -1) & (a_cross == -1)) \
                 & (b_res == -1) & ~((b_crt == -1) & (b_cross == -1)) \
                 & (c_cross == -1) & ~((c_crt == -1) & (c_res == -1)) \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s3_long  = (a_res ==  1) & ~((a_crt ==  1) & (a_cross ==  1)) \
                 & (b_res ==  1) & ~((b_crt ==  1) & (b_cross ==  1)) \
                 & (c_cross ==  1) & ~((c_crt ==  1) & (c_res ==  1)) \
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

        # ── 訊號九 S9（三棒視窗：BB 觸軌 + MACD 叉，<b>但三棒都不可有 CRT</b>）──
        # S9 與 S10 區分：S10 必須含 CRT，S9 必須不含
        # 短：A/B/C 任一根碰布林上軌 AND 任一根 MACD 死叉 AND 三棒皆 CRT=0
        # 多：對稱
        a_bup = bb_up_touch[:n-3]; b_bup = bb_up_touch[1:n-2]; c_bup = bb_up_touch[2:n-1]
        a_blo = bb_lo_touch[:n-3]; b_blo = bb_lo_touch[1:n-2]; c_blo = bb_lo_touch[2:n-1]
        a_mdd = macd_dead[:n-3];   b_mdd = macd_dead[1:n-2];   c_mdd = macd_dead[2:n-1]
        a_mdg = macd_gold[:n-3];   b_mdg = macd_gold[1:n-2];   c_mdg = macd_gold[2:n-1]
        no_crt_3bar = (a_crt == 0) & (b_crt == 0) & (c_crt == 0)
        s9_short = (a_bup | b_bup | c_bup) & (a_mdd | b_mdd | c_mdd) \
                 & no_crt_3bar \
                 & ~np.isnan(c_bbm) & (c_lo_ > c_bbm)
        s9_long  = (a_blo | b_blo | c_blo) & (a_mdg | b_mdg | c_mdg) \
                 & no_crt_3bar \
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
                om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
                _push_signal(sig_time, d_str, k_str, direction, entry_i, float(stop_px),
                             om, otm, omj, ob, otb, obj)

        _process_3bar(s3_short, s3_long, "3")
        _process_3bar(s4_short, s4_long, "4")
        _process_3bar(s5_short, s5_long, "5")
        _process_3bar(s7_short, s7_long, "7")
        _process_3bar(s8_short, s8_long, "8")
        _process_3bar(s9_short, s9_long, "9")

    # ── 訊號十 S10（ABCD 四棒視窗：CRT + MACD 叉 + BB 觸軌） ──
    # 短：A/B/C/D 任一根 CRT=-1 AND 任一根 MACD 死叉 AND 任一根觸上軌
    # 多：對稱（CRT=+1 + MACD 金叉 + 觸下軌）
    # 排除：四棒任一根影線已碰中軌（短：low ≤ bbm；多：high ≥ bbm）
    if n >= 5:
        a4_crt = crt[:n-4];   b4_crt = crt[1:n-3];   c4_crt = crt[2:n-2];   d4_crt = crt[3:n-1]
        a4_bup = bb_up_touch[:n-4]; b4_bup = bb_up_touch[1:n-3]
        c4_bup = bb_up_touch[2:n-2]; d4_bup = bb_up_touch[3:n-1]
        a4_blo = bb_lo_touch[:n-4]; b4_blo = bb_lo_touch[1:n-3]
        c4_blo = bb_lo_touch[2:n-2]; d4_blo = bb_lo_touch[3:n-1]
        a4_mdd = macd_dead[:n-4]; b4_mdd = macd_dead[1:n-3]
        c4_mdd = macd_dead[2:n-2]; d4_mdd = macd_dead[3:n-1]
        a4_mdg = macd_gold[:n-4]; b4_mdg = macd_gold[1:n-3]
        c4_mdg = macd_gold[2:n-2]; d4_mdg = macd_gold[3:n-1]
        a4_hi = highs[:n-4]; b4_hi = highs[1:n-3]; c4_hi = highs[2:n-2]; d4_hi = highs[3:n-1]
        a4_lo = lows[:n-4];  b4_lo = lows[1:n-3];  c4_lo = lows[2:n-2];  d4_lo = lows[3:n-1]
        a4_bbm = bb_mid[:n-4]; b4_bbm = bb_mid[1:n-3]
        c4_bbm = bb_mid[2:n-2]; d4_bbm = bb_mid[3:n-1]

        # 任一根都不可碰到中軌（NaN bbm 的比較會回 False → 也排除）
        no_mid_short = (a4_lo > a4_bbm) & (b4_lo > b4_bbm) & (c4_lo > c4_bbm) & (d4_lo > d4_bbm)
        no_mid_long  = (a4_hi < a4_bbm) & (b4_hi < b4_bbm) & (c4_hi < c4_bbm) & (d4_hi < d4_bbm)

        s10_short = ((a4_crt == -1) | (b4_crt == -1) | (c4_crt == -1) | (d4_crt == -1)) \
                  & (a4_bup | b4_bup | c4_bup | d4_bup) \
                  & (a4_mdd | b4_mdd | c4_mdd | d4_mdd) \
                  & no_mid_short
        s10_long  = ((a4_crt ==  1) | (b4_crt ==  1) | (c4_crt ==  1) | (d4_crt ==  1)) \
                  & (a4_blo | b4_blo | c4_blo | d4_blo) \
                  & (a4_mdg | b4_mdg | c4_mdg | d4_mdg) \
                  & no_mid_long

        if long_only:
            s10_short[:] = False

        for i in np.flatnonzero(s10_short | s10_long):
            i = int(i)
            direction = "short" if s10_short[i] else "long"
            d_bar = i + 3  # D 棒（訊號棒）
            # 停損：4 棒最高/最低（保守）
            if direction == "short":
                stop_px = _stop(max(a4_hi[i], b4_hi[i], c4_hi[i], d4_hi[i]), direction)
            else:
                stop_px = _stop(min(a4_lo[i], b4_lo[i], c4_lo[i], d4_lo[i]), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[d_bar]
            entry_i = d_bar + 1
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "10", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

        # ── 訊號十一 S11（ABCD：A 純超買/超賣、BC 全無、D 純 KDJ 叉）──
        # 短：A 只 res=-1（crt=0,kdj=0）、B/C 全無、D 只 kdj=-1（crt=0,res=0）
        # 多：對稱（A res=+1、D kdj=+1）；排除：A/B/C/D 任一棒影線已碰中軌（用 no_mid）
        a4_res = res[:n-4];   b4_res = res[1:n-3];   c4_res = res[2:n-2];   d4_res = res[3:n-1]
        a4_cr  = cross[:n-4]; b4_cr  = cross[1:n-3]; c4_cr  = cross[2:n-2]; d4_cr  = cross[3:n-1]
        bc_empty = (b4_crt == 0) & (b4_cr == 0) & (b4_res == 0) \
                 & (c4_crt == 0) & (c4_cr == 0) & (c4_res == 0)
        s11_short = (a4_res == -1) & (a4_crt == 0) & (a4_cr == 0) \
                  & bc_empty \
                  & (d4_cr == -1) & (d4_crt == 0) & (d4_res == 0) \
                  & no_mid_short
        s11_long  = (a4_res ==  1) & (a4_crt == 0) & (a4_cr == 0) \
                  & bc_empty \
                  & (d4_cr ==  1) & (d4_crt == 0) & (d4_res == 0) \
                  & no_mid_long
        if long_only:
            s11_short[:] = False
        for i in np.flatnonzero(s11_short | s11_long):
            i = int(i)
            direction = "short" if s11_short[i] else "long"
            d_bar = i + 3
            if direction == "short":
                stop_px = _stop(max(a4_hi[i], b4_hi[i], c4_hi[i], d4_hi[i]), direction)
            else:
                stop_px = _stop(min(a4_lo[i], b4_lo[i], c4_lo[i], d4_lo[i]), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[d_bar]
            entry_i = d_bar + 1
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "11", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── 訊號十二 S12（10 K 棒視窗：res + cross；不計入總勝率） ──
    # 短：cross[i] == -1（死叉）+ 過去 10 棒內（含 i）有 res == -1（超買）
    #     + 訊號棒（cross 棒）不可碰中軌（low > bbm）
    #     + 共振 K 與 cross K「之間」每根都不能有任何指標（crt=0, cross=0, res=0）
    # 多：對稱（cross == 1 金叉、res == 1 超賣、high < bbm）
    # 邏輯：超賣（共振）先表態 → 中間 K 棒安靜醞釀 → 出現金叉（且未碰中軌）→ 入場
    WIN_S12 = 10
    if n >= 2:
        for i in range(n - 1):
            c_i = int(cross[i])
            if c_i not in (-1, 1):
                continue
            direction = "short" if c_i == -1 else "long"
            if long_only and direction == "short":
                continue
            # 從 i 往前找最近一根同方向 res 的位置（含 i 自己）
            lo_j = max(0, i - WIN_S12 + 1)
            res_idx = -1
            for j in range(i, lo_j - 1, -1):
                if res[j] == c_i:
                    res_idx = j
                    break
            if res_idx < 0:
                continue
            # res K 與 cross K「之間」每根都不可有任何指標
            if res_idx < i - 1:
                if (np.any(crt[res_idx+1:i] != 0)
                    or np.any(cross[res_idx+1:i] != 0)
                    or np.any(res[res_idx+1:i] != 0)):
                    continue
            # cross 棒（訊號棒）不可碰中軌
            bbm_i = bb_mid[i]
            if math.isnan(bbm_i):
                continue
            if direction == "short":
                if lows[i] <= bbm_i:
                    continue
                stop_px = _stop(float(np.max(highs[res_idx:i+1])), direction)
            else:
                if highs[i] >= bbm_i:
                    continue
                stop_px = _stop(float(np.min(lows[res_idx:i+1])), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[i]
            entry_i = i + 1
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "12", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # ── SS1（獨立系列）：布林軌道反轉 2 棒 ───────────────────────
    # 顏色：紅K=上漲(close>open)、綠K=下跌(close<open)。
    # 做多（下軌反轉）：A=綠K，B=紅K 且 收>下軌，A/B 任一觸下軌，排除 B 已碰中軌；停損取兩棒最低。
    # 做空（上軌反轉）：A=紅K，B=綠K 且 收<上軌，A/B 任一觸上軌，排除 B 已碰中軌；停損取兩棒最高。
    if n >= 3:
        bull = closes > opens        # 紅K 上漲
        bear = closes < opens        # 綠K 下跌
        a_bull = bull[:n-2]; a_bear = bear[:n-2]
        b_bull = bull[1:n-1]; b_bear = bear[1:n-1]
        b_close = closes[1:n-1]; b_high = highs[1:n-1]; b_low = lows[1:n-1]
        b_lo_band = bb_lo[1:n-1]; b_up_band = bb_up[1:n-1]; b_mid = bb_mid[1:n-1]
        # SS1 用「嚴格觸軌」：low 真的 ≤ 下軌 / high 真的 ≥ 上軌（不套用 S 系列那組 0.3% 容差，
        # 否則 low 在軌上方 0.3% 內也被算「碰」→ 出現「沒碰軌卻觸發」）。
        lo_touch = (~np.isnan(bb_lo)) & (lows <= bb_lo)
        up_touch = (~np.isnan(bb_up)) & (highs >= bb_up)
        a_lo_t = lo_touch[:n-2]; b_lo_t = lo_touch[1:n-1]
        a_up_t = up_touch[:n-2]; b_up_t = up_touch[1:n-1]
        ss_long  = a_bear & b_bull & (b_close > b_lo_band) & (a_lo_t | b_lo_t) \
                   & ~np.isnan(b_mid) & (b_high < b_mid)
        ss_short = a_bull & b_bear & (b_close < b_up_band) & (a_up_t | b_up_t) \
                   & ~np.isnan(b_mid) & (b_low > b_mid)
        if long_only:
            ss_short[:] = False
        for i in np.flatnonzero(ss_short | ss_long):
            i = int(i)
            direction = "short" if ss_short[i] else "long"
            ib = i + 1   # B 棒（訊號棒）
            if direction == "short":
                stop_px = _stop(max(highs[i], highs[ib]), direction)
            else:
                stop_px = _stop(min(lows[i], lows[ib]), direction)
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            entry_i = i + 2
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, "ss1", direction, entry_i, float(stop_px),
                         om, otm, omj, ob, otb, obj)

    # 依時間排一次，供 _solve / _calc_streaks / _build_combined 共用（原本各自 sort）
    signals_sorted = sorted(signals, key=lambda x: x["t"])

    # ── _solve 精簡模式：只跑「敗後停手」模擬後直接回傳（省下全部統計） ──
    #    與完整版 _build_combined(target, est=False) + stop_strategy 一致
    if _solve is not None:
        _rk = {"mid": "r", "band": "r_b", "rr": "r_rr"}[_solve]
        _seen = set(); _seq = []
        # S12 insertion order 排在 S11 之後 → 穩定排序下，同 t 上其他策略會先入 _seen，
        # S12 只在「(t,d) 不與其他策略重疊」時才進入敗後停手序列
        for s in signals_sorted:
            if s["k"] == "abc" or s["k"] in _SS_KEYS:   # SS 系列不混入 S 的敗後停手
                continue
            _key = (s["t"], s["d"])
            if _key in _seen:
                continue
            _seen.add(_key)
            _r = s.get(_rk)
            if _r in ("w", "l"):
                _seq.append((s["d"], _r))
        _active = {"s": True, "l": True}
        _w = {"s": 0, "l": 0}; _l = {"s": 0, "l": 0}
        for _d, _r in _seq:
            if _active[_d]:
                if _r == "w":
                    _w[_d] += 1
                else:
                    _l[_d] += 1; _active[_d] = False
            elif _r == "w":
                _active[_d] = True
            _active["l" if _d == "s" else "s"] = True
        _tot = _w["s"] + _l["s"] + _w["l"] + _l["l"]
        _win = _w["s"] + _w["l"]
        return {"win_rate": round(_win / _tot * 100, 1) if _tot else None, "total": _tot}

    # ── 統計輸出 ─────────────────────────────────────────────
    def _stats(w, l, rr=None, streak=0, cond=None):
        """rr：RR bucket；streak：最大連敗數；cond：條件連續機率 dict
        （loss_after_loss=敗後再敗%、win_after_win=勝後再勝%，含樣本數）"""
        t = w + l
        out = {"total": t, "wins": w, "losses": l, "win_rate": round(w / t * 100, 1) if t else None,
               "max_loss_streak": streak}
        if cond:
            out["loss_streak"]     = cond.get("loss_streak")
            out["loss_after_loss"] = cond.get("loss_after_loss")
            out["n_after_loss"]    = cond.get("n_after_loss", 0)
            out["win_after_win"]   = cond.get("win_after_win")
            out["n_after_win"]     = cond.get("n_after_win", 0)
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

    def _stats_rr(w, l, streak=0, cond=None):
        """1:1 目標的統計：盈虧比恆為 1，故 RR 欄位直接由勝負數推得
        （每勝 +1R、每敗 -1R）。其餘欄位與 _stats 結構一致。"""
        out = _stats(w, l, rr=None, streak=streak, cond=cond)
        t = w + l
        if t:
            out["avg_rr_est"] = 1.0
            out["avg_rr_act"] = 1.0 if w else None
            out["net_r_est"]  = round(w - l, 2)
            out["net_r_act"]  = round(w - l, 2)
            out["profit_factor"] = (round(w / l, 2) if l > 0 else ("inf" if w else None))
        return out

    def _est_stats_dict(es):
        """把 est tracker 轉成 {est_total, est_wins, est_win_rate}"""
        t = es["sw"] + es["sl"] + es["lw"] + es["ll"]
        w = es["sw"] + es["lw"]
        return {
            "est_total": t,
            "est_wins":  w,
            "est_win_rate": round(w / t * 100, 1) if t else None,
        }

    def _build_target_stats(cnt, rr_cnt, est=None, streak=None, is_rr=False):
        """從 cnt + rr_cnt + streak 算出該 target 的完整統計結構。
        is_rr=True 時為 1:1 目標：用 _stats_rr（RR 由勝負數推得），rr_cnt 可為 None。"""
        streak = streak or {}
        def _mk(v, sk):
            if is_rr:
                return {
                    "short": _stats_rr(v[0], v[1], streak=streak.get((sk, "s"), 0)),
                    "long":  _stats_rr(v[2], v[3], streak=streak.get((sk, "l"), 0)),
                }
            return {
                "short": _stats(v[0], v[1], rr_cnt[sk]["short"], streak=streak.get((sk, "s"), 0)),
                "long":  _stats(v[2], v[3], rr_cnt[sk]["long"],  streak=streak.get((sk, "l"), 0)),
            }
        per_sig = {k: _mk(v, k) for k, v in cnt.items()}
        # 訊號一、十二 不計入合計
        _AGG = ("ab", "3", "4", "5", "6", "7", "8", "9", "10", "11")
        wins_s   = sum(cnt[k][0] for k in _AGG)
        losses_s = sum(cnt[k][1] for k in _AGG)
        wins_l   = sum(cnt[k][2] for k in _AGG)
        losses_l = sum(cnt[k][3] for k in _AGG)
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
            "s10":      per_sig["10"],
            "s11":      per_sig["11"],
            "s12":      per_sig["12"],
        }
        if est is not None:
            out.update(_est_stats_dict(est))
        return out

    # ── Dedupe：同 signal_bar + 同方向 多個訊號類型只算一次（避免 S6/S10、S2/S3、S9/S10 等重複） ──
    # 5 個原本平行的 seen Set 內容完全一致（lockstep 更新），合併成單一 seen 省 4 倍 hash 查詢
    def _dedupe_totals():
        seen = set()
        # 每組: [sw, sl, lw, ll]
        m = [0, 0, 0, 0]; b = [0, 0, 0, 0]; rr = [0, 0, 0, 0]
        em = [0, 0, 0, 0]; eb = [0, 0, 0, 0]
        for s in signals:
            # 合計＝純 S2~S11（_AGG）：S1(abc)、S12、SS 系列皆不計入總勝率
            # （SS 自成一套合計；S12 僅獨立顯示。與 _build_combined 的母體一致）
            if s["k"] == "abc" or s["k"] == "12" or s["k"] in _SS_KEYS:
                continue
            key = (s["t"], s["d"])
            if key in seen:
                continue
            seen.add(key)
            d_idx_w = 0 if s["d"] == "s" else 2
            d_idx_l = 1 if s["d"] == "s" else 3
            r = s.get("r");      r_b = s.get("r_b");      r_rr = s.get("r_rr")
            est_r = s.get("est_r"); est_r_b = s.get("est_r_b")
            if r == "w":      m[d_idx_w] += 1
            elif r == "l":    m[d_idx_l] += 1
            if r_b == "w":    b[d_idx_w] += 1
            elif r_b == "l":  b[d_idx_l] += 1
            if r_rr == "w":   rr[d_idx_w] += 1
            elif r_rr == "l": rr[d_idx_l] += 1
            if est_r == "w":  em[d_idx_w] += 1
            elif est_r == "l":em[d_idx_l] += 1
            if est_r_b == "w":  eb[d_idx_w] += 1
            elif est_r_b == "l":eb[d_idx_l] += 1
        return m, b, rr, em, eb

    dedup_m,  dedup_b,  dedup_rr,  dedup_em,  dedup_eb  = _dedupe_totals()

    # target → 結果欄位 key（mid=中軌、band=上下軌、rr=1:1）
    _RKEY      = {"mid": "r",     "band": "r_b",     "rr": "r_rr"}
    _RKEY_EST  = {"mid": "est_r", "band": "est_r_b", "rr": "r_rr"}  # 1:1 目標固定，est=實際

    # ── 最大連敗數：每 (sig_key, direction) 依時間順序統計最長連續 loss ──
    def _calc_streaks(target="mid"):
        """回傳 {(sig_key, direction): max_streak}"""
        streaks = {}
        # 訊號需依時間排序（共用預排好的 signals_sorted）
        # 用每 (k, d) 自己的當前連敗值追蹤
        cur = {}
        rkey = _RKEY[target]
        for s in signals_sorted:
            key = (s["k"], s["d"])
            r = s.get(rkey)
            if key not in cur:
                cur[key] = 0
                streaks[key] = 0
            if r == "l":
                cur[key] += 1
                if cur[key] > streaks[key]:
                    streaks[key] = cur[key]
            elif r == "w":
                cur[key] = 0
        return streaks

    streak_mid    = _calc_streaks(target="mid")
    streak_band   = _calc_streaks(target="band")
    streak_rr     = _calc_streaks(target="rr")

    # ── 條件連敗機率（以「合併時間軸」為準）──
    #    連敗 = 同方向且在合併時間軸上「真正相鄰」的連續敗單。
    #    例：空敗→多敗→空敗 不算做空 2 連敗（中間夾了多敗，連續被打斷）。
    #    loss_streak[k] = 同方向連敗 k 根後、下一筆同方向也敗的機率
    #                     （k=1→2連、k=2→3連、k=3→4連）；win_after_win = 同方向勝後再勝。
    _combined_memo = {}
    # 母體＝純 S2~S11：排除 S1(abc)、S12、SS 系列（與 _dedupe_totals 的總勝率母體一致）
    _signals_base = [s for s in signals_sorted if s["k"] != "abc" and s["k"] != "12" and s["k"] not in _SS_KEYS]
    def _build_combined(target, est=False):
        """合併時間軸的已結算序列 [(d, r)]（dedupe by (t,d)、S1 不計入）。
        est=True 改用『進場時固定預估目標』的結果（est_r/est_r_b；1:1 目標固定 est=實際）。
        memoize：cond/stop/recent 會重複要同一組合 → 快取免重算。"""
        _mk = (target, est)
        _hit = _combined_memo.get(_mk)
        if _hit is not None:
            return _hit
        rk = _RKEY_EST[target] if est else _RKEY[target]
        seen = set(); seq = []
        for s in _signals_base:
            key = (s["t"], s["d"])
            if key in seen:
                continue
            seen.add(key)
            r = s.get(rk)
            if r not in ("w", "l"):
                continue
            seq.append((s["d"], r))
        _combined_memo[_mk] = seq
        return seq

    def _cond_for_dir(seq, D):
        streak = []
        for k in (1, 2, 3):
            denom = nxt_loss = 0
            for i in range(k, len(seq)):
                if seq[i][0] != D:
                    continue
                # 前 k 筆（合併時間軸上相鄰）必須都是「同方向 D 的敗單」才算連敗
                if all(seq[i-j] == (D, "l") for j in range(1, k + 1)):
                    denom += 1
                    if seq[i][1] == "l":
                        nxt_loss += 1
            streak.append({
                "after": k,
                "p":     round(nxt_loss / denom * 100, 1) if denom else None,
                "n":     denom,
            })
        after_win = win_after_win = 0
        for i in range(1, len(seq)):
            if seq[i][0] != D:
                continue
            if seq[i-1] == (D, "w"):
                after_win += 1
                if seq[i][1] == "w":
                    win_after_win += 1
        return {
            "loss_streak":     streak,
            "loss_after_loss": streak[0]["p"],
            "n_after_loss":    streak[0]["n"],
            "win_after_win":   round(win_after_win / after_win * 100, 1) if after_win else None,
            "n_after_win":     after_win,
        }

    def _calc_cond_total(target="mid"):
        seq = _build_combined(target)
        return {"s": _cond_for_dir(seq, "s"), "l": _cond_for_dir(seq, "l")}

    def _calc_stop_strategy(target="mid"):
        """「敗後停手」策略總勝率（合併時間軸）：
        - 某方向「進場中」遇敗 → 該方向「停手」（計入這一敗）
        - 「停手中」跳過該方向訊號（不計），但反方向不受影響、照自己的狀態進場
        - 解除停手（回進場中）兩種觸發：①同方向出現紙上會贏 ②反方向訊號出現（中斷連敗）
        回傳實際進場單的空/多/合計勝率。母體同總勝率（S2~S11 去重、合併時間軸）。
        另含 "est"：用『進場時固定預估目標』結果跑同一套停手模擬（到達預估盈虧比的機率）。"""
        def _run(est):
            combined = _build_combined(target, est=est)  # 依時間排序
            active = {"s": True, "l": True}
            w = {"s": 0, "l": 0}; l = {"s": 0, "l": 0}
            for d, r in combined:
                if active[d]:
                    if r == "w":
                        w[d] += 1
                    else:
                        l[d] += 1; active[d] = False              # 遇敗停手
                elif r == "w":
                    active[d] = True                              # 同方向紙上回穩
                active["l" if d == "s" else "s"] = True           # 反方向出現 → 解除其停手
            def _mk(dk):
                t = w[dk] + l[dk]
                return {"total": t, "wins": w[dk], "losses": l[dk],
                        "win_rate": round(w[dk] / t * 100, 1) if t else None}
            sr = _mk("s"); lr = _mk("l")
            tot = sr["total"] + lr["total"]; win = sr["wins"] + lr["wins"]
            return {"short": sr, "long": lr, "total": tot, "wins": win,
                    "win_rate": round(win / tot * 100, 1) if tot else None}
        out = _run(est=False)
        out["est"] = _run(est=True)   # 到達預估盈虧比（固定目標）的停手版機率
        return out

    cond_tot_mid    = _calc_cond_total(target="mid")
    cond_tot_band   = _calc_cond_total(target="band")
    cond_tot_rr     = _calc_cond_total(target="rr")

    stop_mid    = _calc_stop_strategy(target="mid")
    stop_band   = _calc_stop_strategy(target="band")
    stop_rr     = _calc_stop_strategy(target="rr")

    # _calc_s12_stop_plus / byzantine 已從前端移除，後端計算亦移除以加速


    def _dedup_total_dict(arr, cond=None):
        sw, sl, lw, ll = arr
        t = sw + sl + lw + ll
        w = sw + lw
        cond = cond or {}
        return {
            "total":    t,
            "wins":     w,
            "win_rate": round(w / t * 100, 1) if t else None,
            "short":    _stats(sw, sl, cond=cond.get("s")),
            "long":     _stats(lw, ll, cond=cond.get("l")),
        }

    def _dedup_est_dict(arr):
        sw, sl, lw, ll = arr
        t = sw + sl + lw + ll
        w = sw + lw
        return {
            "est_total":    t,
            "est_wins":     w,
            "est_win_rate": round(w / t * 100, 1) if t else None,
        }

    mid_out  = _build_target_stats(mid_cnt,  mid_rr,  streak=streak_mid)
    band_out = _build_target_stats(band_cnt, band_rr, streak=streak_band)
    rr_out   = _build_target_stats(rr11_cnt, None, streak=streak_rr, is_rr=True)
    # 頂層也存最大連敗（依當前 cnt 的合計）
    def _all_max_streak(streak_dict):
        return max((v for v in streak_dict.values()), default=0)
    mid_out["max_loss_streak"]  = _all_max_streak(streak_mid)
    band_out["max_loss_streak"] = _all_max_streak(streak_band)
    rr_out["max_loss_streak"]   = _all_max_streak(streak_rr)

    # 把 dedup 後的合計覆寫到 mid_out / band_out / rr_out 的頂層（含條件連續機率 cond + 停手策略）
    mid_out.update(_dedup_total_dict(dedup_m, cond_tot_mid))
    mid_out.update(_dedup_est_dict(dedup_em))
    mid_out["stop_strategy"] = stop_mid
    band_out.update(_dedup_total_dict(dedup_b, cond_tot_band))
    band_out.update(_dedup_est_dict(dedup_eb))
    band_out["stop_strategy"] = stop_band
    rr_out.update(_dedup_total_dict(dedup_rr, cond_tot_rr))
    rr_out.update(_dedup_est_dict(dedup_rr))   # 1:1 目標固定，est 合計 = 實際合計
    rr_out["stop_strategy"] = stop_rr

    # ── 近 N 筆勝率（合併時間軸去重後最近 N 筆，看近期表現）──
    def _recent_wr(target, n_recent=100):
        seq = _build_combined(target)   # 已依時間排序、去重、S1 不計
        tail = seq[-n_recent:]
        w = sum(1 for _d, r in tail if r == "w")
        t = len(tail)
        return {"win_rate": round(w / t * 100, 1) if t else None, "total": t, "wins": w}

    mid_out["recent100"]  = _recent_wr("mid")
    band_out["recent100"] = _recent_wr("band")
    rr_out["recent100"]   = _recent_wr("rr")

    recent.sort(key=lambda x: x["t"])
    from_date = str(df.iloc[0]["time"])[:10] if n else ""

    # ── SS 系列：獨立合計 + 敗後停手（只用 _SS_KEYS、自己的合併時間軸，不含 S）──
    def _build_combined_ss(target="mid"):
        rk = _RKEY[target]
        seen = set(); seq = []
        for s in signals_sorted:
            if s["k"] not in _SS_KEYS:
                continue
            key = (s["t"], s["d"])
            if key in seen:
                continue
            seen.add(key)
            r = s.get(rk)
            if r in ("w", "l"):
                seq.append((s["d"], r))
        return seq

    def _ss_stop_strategy(target="mid"):
        seq = _build_combined_ss(target)
        active = {"s": True, "l": True}; w = {"s": 0, "l": 0}; l = {"s": 0, "l": 0}
        for d, r in seq:
            if active[d]:
                if r == "w": w[d] += 1
                else: l[d] += 1; active[d] = False
            elif r == "w": active[d] = True
            active["l" if d == "s" else "s"] = True
        def _mk(dk):
            t = w[dk] + l[dk]
            return {"total": t, "wins": w[dk], "losses": l[dk],
                    "win_rate": round(w[dk] / t * 100, 1) if t else None}
        sr = _mk("s"); lr = _mk("l"); tot = sr["total"] + lr["total"]; win = sr["wins"] + lr["wins"]
        return {"short": sr, "long": lr, "total": tot, "wins": win,
                "win_rate": round(win / tot * 100, 1) if tot else None}

    def _ss_per_sig(k):
        return {
            "short": _stats(mid_cnt[k][0], mid_cnt[k][1], mid_rr[k]["short"], streak=streak_mid.get((k, "s"), 0)),
            "long":  _stats(mid_cnt[k][2], mid_cnt[k][3], mid_rr[k]["long"],  streak=streak_mid.get((k, "l"), 0)),
        }

    _ss_seq = _build_combined_ss("mid")
    _ss_cond = {"s": _cond_for_dir(_ss_seq, "s"), "l": _cond_for_dir(_ss_seq, "l")}
    _ss_ws = sum(mid_cnt[k][0] for k in _SS_KEYS); _ss_ls = sum(mid_cnt[k][1] for k in _SS_KEYS)
    _ss_wl = sum(mid_cnt[k][2] for k in _SS_KEYS); _ss_ll = sum(mid_cnt[k][3] for k in _SS_KEYS)
    _ss_tot = _ss_ws + _ss_ls + _ss_wl + _ss_ll; _ss_win = _ss_ws + _ss_wl
    _ss_tail = _ss_seq[-100:]
    _ss_tw = sum(1 for _d, r in _ss_tail if r == "w")
    ss_out = {
        "total": _ss_tot, "wins": _ss_win,
        "win_rate": round(_ss_win / _ss_tot * 100, 1) if _ss_tot else None,
        "short": _stats(_ss_ws, _ss_ls, cond=_ss_cond["s"]),
        "long":  _stats(_ss_wl, _ss_ll, cond=_ss_cond["l"]),
        "stop_strategy": _ss_stop_strategy("mid"),
        "recent100": {"win_rate": round(_ss_tw / len(_ss_tail) * 100, 1) if _ss_tail else None,
                      "total": len(_ss_tail), "wins": _ss_tw},
        **{k: _ss_per_sig(k) for k in _SS_KEYS},
    }

    return {
        **mid_out,                # backward compat：mid 統計放在頂層
        "ss":   ss_out,           # SS 系列（獨立合計 + 敗後停手，不與 S 混）
        "band": band_out,         # 帶軌（short=BB 下軌、long=BB 上軌）統計
        "rr":   rr_out,           # 1:1 目標（止盈距離 = 止損距離）統計
        "long_only": long_only,   # 是否只算多單（台股=True）
        "from_date": from_date,
        "recent":   recent[-30:],
        "signals":  signals,
    }
