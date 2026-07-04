"""CRT 策略訊號掃描與勝率計算（numpy 向量化加速版，含中軌＋帶軌雙目標）

對比舊版以 df.iloc[i].get(col) 逐 row 取值的寫法，本版預先把所有欄位抽成 numpy array：
- 6 個主要迴圈用 vectorized mask 找出候選 index，只跑符合條件的少數幾根 K 棒
- _scan_outcome 用 array 直接取值，省下 pandas Series 介面成本（~10-50x faster）
- 每個訊號同時計算「中軌目標」與「帶軌目標」的勝負結果，前端可切換顯示
"""
import bisect
import math
import numpy as np
import pandas as pd

# FVG 視覺缺口/策略標記(多空·破·順)只在「最後 _VISUAL_WINDOW 根」上計算(勝率統計不受此限)。
# 深時框(1h~60k根)把 O(缺口×觸碰掃描) 從 N 縮到此值 → 大幅提速；標記本就截尾([-2000:]/[-12000:])，
# 取足夠大即與全量一致。可調（越大越慢越完整）。
_VISUAL_WINDOW = 20000


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
                      _solve=None, band_ratio: float = 1.0, visual_window: int = 0,
                      stock_gap: bool = False) -> dict:
    """
    六種訊號合併計算勝率（中軌目標 + 帶軌目標雙統計）。

    band_ratio：「上下軌目標」的位置比例。1.0（預設）＝原本的上/下軌；0.8＝下軌↔上軌 80% 處
        （做多＝下軌+80%寬、做空鏡像＝上軌−80%寬）。只影響「帶軌止盈目標」，訊號偵測（觸軌等）
        仍用真實 bb_up/bb_lo。整套 band 統計（band_cnt/RR/敗後停手/recent/est）都自動跟著此比例。

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
    # 帶軌「止盈目標」軌（可參數化）：band_ratio=1.0 → 原本上/下軌（完全等同舊行為）；
    #   <1.0 → 下軌往上 ratio 處（做多目標 band_up_t）/ 上軌往下 ratio 處（做空目標 band_lo_t）。
    #   只用於止盈目標，訊號偵測（bb_up_touch 等）一律仍用真實 bb_up/bb_lo。
    if band_ratio >= 0.999:
        band_lo_t = bb_lo        # 做空目標（原＝下軌）
        band_up_t = bb_up        # 做多目標（原＝上軌）
    else:
        _bw = bb_up - bb_lo
        band_lo_t = bb_lo + (1.0 - band_ratio) * _bw   # 做空：上軌往下 ratio 處（＝下軌+剩餘%）
        band_up_t = bb_lo + band_ratio * _bw            # 做多：下軌往上 ratio 處

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
    _SS_KEYS = ("ss1", "ss2")
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
                band_arr = band_lo_t if direction == "short" else band_up_t
                ob, otb, obj = _scan_outcome_np(highs, lows, closes, band_arr, times_iso, entry_i, n, stop_px, direction)
                return None, None, -1, ob, otb, obj
            om, otm, omj = _scan_outcome_np(highs, lows, closes, bb_mid, times_iso, entry_i, n, stop_px, direction)
            return om, otm, omj, None, None, -1
        om, otm, omj = _scan_outcome_np(highs, lows, closes, bb_mid, times_iso, entry_i, n, stop_px, direction)
        band_arr = band_lo_t if direction == "short" else band_up_t
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
            tgt_band_fix = band_lo_t[entry_i] if direction == "short" else band_up_t[entry_i]
            if tgt_mid_fix == tgt_mid_fix:
                o = _scan_outcome_fixed(highs, lows, closes, entry_i, n,
                                         stop_px, float(tgt_mid_fix), direction)
                est_r = "w" if o == "win" else ("l" if o == "loss" else None)
            if tgt_band_fix == tgt_band_fix:
                o = _scan_outcome_fixed(highs, lows, closes, entry_i, n,
                                         stop_px, float(tgt_band_fix), direction)
                est_r_b = "w" if o == "win" else ("l" if o == "loss" else None)
        # 預估盈虧比 RR(中軌/上下軌) = |進場-目標|/|進場-止損|，供前端盈虧比盒 + 自動交易初始 TP 用
        est_rr_val = None; est_rr_b_val = None
        if sig_key != "abc" and entry_i < n:
            entry_px = opens[entry_i]
            tgt_mid  = bb_mid[entry_i]
            tgt_band = band_lo_t[entry_i] if direction == "short" else band_up_t[entry_i]   # 帶軌目標：空→下軌、多→上軌（依 band_ratio）
            if not math.isnan(entry_px):
                risk = abs(entry_px - stop_px)
                if risk > 1e-9:
                    if not math.isnan(tgt_mid):
                        est_rr_val = round(min(abs(entry_px - tgt_mid) / risk, 10.0), 3)
                    if not math.isnan(tgt_band):
                        est_rr_b_val = round(min(abs(entry_px - tgt_band) / risk, 10.0), 3)
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
                    return round(max(-10.0, min(rew / _risk, 10.0)), 3)   # 封頂 ±10（與預估 _rr_at 一致，防停損極小→單筆 RR 爆大拉爆報酬）
                rr_real   = _rr_real(om, omj, bb_mid)
                rr_b_real = _rr_real(ob, obj, band_lo_t if direction == "short" else band_up_t)
        signals.append({
            "t": sig_time, "d": d_str, "k": sig_key,
            "r":   "w" if om == "win" else ("l" if om else None), "ot":   otm,
            "r_b": "w" if ob == "win" else ("l" if ob else None), "ot_b": otb,
            "r_rr": r_rr, "ot_rr": ot_rr,
            "stop": float(stop_px),   # 實際止損價（含 buffer、多棒取極值）→ 前端盈虧比盒/1:1 止盈用
            "entry": entry_px_rec,    # 進場價（含 None＝末端未進場）
            "est_r":   est_r,
            "est_r_b": est_r_b,
            "rr": est_rr_val,         # 進場預估盈虧比(中軌，恆正，供前端 RR 盒/顯示)
            "rr_b": est_rr_b_val,     # 進場預估盈虧比(上下軌，恆正)→ 自動交易初始 TP 用
            "rr_real":   rr_real,     # 已實現盈虧比(中軌，含號)→ 回測用
            "rr_b_real": rr_b_real,   # 已實現盈虧比(上下軌，含號)
        })
        _bump(mid_cnt,  sig_key, direction, om)
        _bump(band_cnt, sig_key, direction, ob)
        _bump(rr11_cnt, sig_key, direction, rr_out)
        _bump_rr(mid_rr,  sig_key, direction, entry_i, omj, stop_px, om, bb_mid)
        band_arr = band_lo_t if direction == "short" else band_up_t
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
        # 依 B 棒收盤價在「軌道↔中軌」的深度，把同一觸發拆成 SS1（深）/ SS2（淺）：
        #   做多：以 (下軌+中軌)/2 為界 → 收盤 < 界 → SS1（靠下軌、較深）；界 ≤ 收盤 < 中軌 → SS2（上半、較淺）
        #   做空：以 (上軌+中軌)/2 為界 → 收盤 > 界 → SS1（靠上軌）；中軌 < 收盤 ≤ 界 → SS2
        ss_mid_lo = (b_lo_band + b_mid) / 2.0   # 下半界（多用）
        ss_mid_up = (b_up_band + b_mid) / 2.0   # 上半界（空用）
        for i in np.flatnonzero(ss_short | ss_long):
            i = int(i)
            direction = "short" if ss_short[i] else "long"
            ib = i + 1   # B 棒（訊號棒）
            if direction == "short":
                stop_px = _stop(max(highs[i], highs[ib]), direction)
                ss_key = "ss1" if b_close[i] > ss_mid_up[i] else "ss2"
            else:
                stop_px = _stop(min(lows[i], lows[ib]), direction)
                ss_key = "ss1" if b_close[i] < ss_mid_lo[i] else "ss2"
            d_str = "s" if direction == "short" else "l"
            sig_time = times_iso[ib]
            entry_i = i + 2
            om, otm, omj, ob, otb, obj = _scan_dual(entry_i, float(stop_px), direction)
            _push_signal(sig_time, d_str, ss_key, direction, entry_i, float(stop_px),
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

    # ── 近 N 筆「敗後停手」勝率：取合併時間軸最後 N 筆訊號，套敗後停手狀態機，回實際進場單勝率 ──
    #    (與 _calc_stop_strategy 同邏輯，但只看近 N 筆 → 反映近期「照敗後停手實單」的表現)
    def _stop_strategy_recent(target="mid", n_recent=200):
        combined = _build_combined(target)[-n_recent:]
        active = {"s": True, "l": True}
        w = {"s": 0, "l": 0}; l = {"s": 0, "l": 0}
        for d, r in combined:
            if active[d]:
                if r == "w": w[d] += 1
                else:        l[d] += 1; active[d] = False
            elif r == "w":   active[d] = True
            active["l" if d == "s" else "s"] = True
        tot = w["s"] + w["l"] + l["s"] + l["l"]; win = w["s"] + w["l"]
        return {"win_rate": round(win / tot * 100, 1) if tot else None, "total": tot, "wins": win}

    mid_out["recent_stop200"]  = _stop_strategy_recent("mid")
    band_out["recent_stop200"] = _stop_strategy_recent("band")
    rr_out["recent_stop200"]   = _stop_strategy_recent("rr")

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
        rk = _RKEY[target]; otk = {"mid": "ot", "band": "ot_b", "rr": "ot_rr"}[target]
        # 富序列（帶訊號棒 t / 止損出場棒 ot）：SS 獨立合併時間軸、(t,d) 去重、只取已結算。
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
                seq.append((s["d"], r, s.get("t"), s.get(otk)))
        active = {"s": True, "l": True}; stop_ot = {"s": None, "l": None}
        w = {"s": 0, "l": 0}; l = {"s": 0, "l": 0}
        for d, r, st, ot in seq:
            # 新規則（僅 SS）：被停損出場的那根 K，同時又冒出同向 SS 進場訊號（出場棒==訊號棒）
            # → 視同回場、放行進場（不被敗後停手擋）。
            if not active[d] and stop_ot[d] is not None and st is not None and str(st) == str(stop_ot[d]):
                active[d] = True
            if active[d]:
                if r == "w": w[d] += 1
                else: l[d] += 1; active[d] = False; stop_ot[d] = ot   # 記下這筆敗單的出場棒
            elif r == "w": active[d] = True
            active["l" if d == "s" else "s"] = True
        def _mk(dk):
            t = w[dk] + l[dk]
            return {"total": t, "wins": w[dk], "losses": l[dk],
                    "win_rate": round(w[dk] / t * 100, 1) if t else None}
        sr = _mk("s"); lr = _mk("l"); tot = sr["total"] + lr["total"]; win = sr["wins"] + lr["wins"]
        return {"short": sr, "long": lr, "total": tot, "wins": win,
                "win_rate": round(win / tot * 100, 1) if tot else None}

    def _ss_stop_recent(target="mid", n_recent=200):
        """SS 近 N 筆「敗後停手」勝率（含 SS 專屬：出場棒==訊號棒視同回場）。取尾 N 筆套同狀態機。"""
        rk = _RKEY[target]; otk = {"mid": "ot", "band": "ot_b", "rr": "ot_rr"}[target]
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
                seq.append((s["d"], r, s.get("t"), s.get(otk)))
        seq = seq[-n_recent:]
        active = {"s": True, "l": True}; stop_ot = {"s": None, "l": None}
        w = {"s": 0, "l": 0}; l = {"s": 0, "l": 0}
        for d, r, st, ot in seq:
            if not active[d] and stop_ot[d] is not None and st is not None and str(st) == str(stop_ot[d]):
                active[d] = True
            if active[d]:
                if r == "w": w[d] += 1
                else: l[d] += 1; active[d] = False; stop_ot[d] = ot
            elif r == "w": active[d] = True
            active["l" if d == "s" else "s"] = True
        tot = w["s"] + w["l"] + l["s"] + l["l"]; win = w["s"] + w["l"]
        return {"win_rate": round(win / tot * 100, 1) if tot else None, "total": tot, "wins": win}

    # SS 系列統計：依目標(mid/band)各算一份 → 前端切「中軌/上下軌」時 SS 也能跟著變。
    def _build_ss_out(target, cnt, rr, streak):
        def _per_sig(k):
            return {
                "short": _stats(cnt[k][0], cnt[k][1], rr[k]["short"], streak=streak.get((k, "s"), 0)),
                "long":  _stats(cnt[k][2], cnt[k][3], rr[k]["long"],  streak=streak.get((k, "l"), 0)),
            }
        seq = _build_combined_ss(target)
        cond = {"s": _cond_for_dir(seq, "s"), "l": _cond_for_dir(seq, "l")}
        ws = sum(cnt[k][0] for k in _SS_KEYS); ls = sum(cnt[k][1] for k in _SS_KEYS)
        wl = sum(cnt[k][2] for k in _SS_KEYS); ll = sum(cnt[k][3] for k in _SS_KEYS)
        tot = ws + ls + wl + ll; win = ws + wl
        tail = seq[-100:]; tw = sum(1 for _d, r in tail if r == "w")
        out = {
            "total": tot, "wins": win,
            "win_rate": round(win / tot * 100, 1) if tot else None,
            "short": _stats(ws, ls, cond=cond["s"]),
            "long":  _stats(wl, ll, cond=cond["l"]),
            "stop_strategy": _ss_stop_strategy(target),
            "recent100": {"win_rate": round(tw / len(tail) * 100, 1) if tail else None,
                          "total": len(tail), "wins": tw},
            "recent_stop200": _ss_stop_recent(target),
        }
        for k in _SS_KEYS:
            out[k] = _per_sig(k)
        return out

    ss_out = _build_ss_out("mid", mid_cnt, mid_rr, streak_mid)
    ss_out["band"] = _build_ss_out("band", band_cnt, band_rr, streak_band)   # 上下軌版（前端切換用）

    # ── SS3：SS 群聚衍生訊號（主圖標記用）──────────────────────────
    # 定義：兩個「同向」SS 相隔 2 棒(中間 1 根非策略棒)、且第二個入場價更優(空→更高/多→更低)。
    # 把符合的「第二個 SS」複製一份、k 改 "ss3" 後加入 signals → 前端當獨立訊號標記在主圖。
    # (止損/出場的實盤細節由自動交易端處理；此處只負責「在哪些棒觸發 SS3」的視覺標記。)
    try:
        _t2i = {t: i for i, t in enumerate(times_iso)}
        _ssbar = {"s": {}, "l": {}}; _allbar = set()
        for _s in signals:
            if _s.get("k") in ("ss1", "ss2") and _s.get("t") is not None:
                _bi = _t2i.get(_s["t"])
                if _bi is not None and _s.get("d") in _ssbar:
                    _ssbar[_s["d"]][_bi] = _s; _allbar.add(_bi)
        _ss3 = []
        for _s in signals:
            if _s.get("k") not in ("ss1", "ss2"):
                continue
            _d = _s.get("d"); _bi = _t2i.get(_s.get("t"))
            if _bi is None or _d not in _ssbar:
                continue
            _prev = _ssbar[_d].get(_bi - 2)          # 前面相隔 2 棒、同向 SS
            if _prev is None or (_bi - 1) in _allbar:  # 中間 1 根須為非策略棒
                continue
            _e = _s.get("entry"); _oe = _prev.get("entry")
            if _e is None or _oe is None:
                continue
            if not ((_d == "s" and _e > _oe) or (_d == "l" and _e < _oe)):
                continue                              # 第二個入場須更優
            _c = dict(_s); _c["k"] = "ss3"; _ss3.append(_c)
        signals = signals + _ss3
    except Exception:
        pass

    # ── FVG（失衡缺口，主圖視覺標記用）────────────────────────────
    # 三根K [g-1],[g],[g+1]：多頭FVG(支撐) low[g+1]>high[g-1]；空頭FVG(壓力) high[g+1]<low[g-1]。
    # 缺口寬度 > 門檻(0.3%)才算。回 {t(=g+1棒時間), top, bot, d('l'/'s'), t2(被填補時間或None)}。
    #
    # _fvg_sigs：FVG「收盤確認版」進場訊號（給自動交易；定版規格見 docs/fvg-strategy.md v2.3）。
    #   進場＝缺口確認後、168 根(1h=一週)新鮮度內，第一根『收盤回到缺口區 [bot,top]』的 K（市價進場、成交確定）。
    #   止損/止盈固定 2W/6W（W=top−bot；與前端視覺盒一致，實盤定版鎖定 2/6）。r/ot=自進場後模擬先碰
    #   止損(l)/止盈(w)，皆未碰→None(live)。獨立於 signals，不污染勝率 HUD；只在 1h 由 notify_monitor 觸發。
    _fvg = []
    _fvg_sigs = []
    _gaplist = []          # (cf_bar, top, bot, dir) 給「接1次」cascade 進出場標記用
    _bbgaps  = []          # (cf_bar, top, bot, dir) 給「布林外+FVG」均值回歸研究標記（不套 g+2 過濾，對齊 fvg_bb.py 回測）
    _fvg_break = []        # 「破多/破空」結構轉破標記(跑 proto 缺口序列、標在 g) [{t,p,d}]
    _fvg_ms    = []        # 「多/空」方向標記 [{t,d}]（吃到 setup FVG 後、窗內首次同向 proto 缺口 B，標在 B 的 g）
    _fvg_shun  = []        # 「順多/順空」：第一步同多/空(吃到未觸碰同向FVG)，第二步=影線穿透既存反向FVG [{t,d}]
    _gaps_seq  = []        # (cf_bar, top, bot, dir) 依時間序的所有視覺缺口（給上面結構模式偵測用）
    try:
        _N = len(times_iso); _MS = 0.0001   # 視覺最小缺口 0.01%（自動交易訊號另設 0.3% 門檻，見下）
        _FRESH = 168          # 缺口新鮮度：確認後 168 根(1h=一週)內未回補 → 作廢、不產進場訊號
        _MAXHOLD = 200        # 最長持有：進場後 200 根仍未觸發止盈/止損 → 視為仍 live(不在此處強平)
        _last_gap = {"l": None, "s": None}  # 每方向「上一個同向缺口」(bot, W)；下方0.5W帶內的同向缺口→無效(淺色不採用)；無效缺口也連鎖往下傳
        # numpy→list 一次轉換：FVG 主迴圈逐元素存取，list(float) 遠快於 numpy 標量+float()
        #（與 _fvg_bb / _fvg_trades 區塊同一手法；NaN 轉 list 後仍 float('nan')，x!=x 判定不變）。
        _H = highs.tolist(); _L = lows.tolist(); _C = closes.tolist(); _O = opens.tolist()
        # 視覺標記只需近段窗（圖上不會回看數年）：FVG 缺口/策略(多空·破·順)只在最後 _VW 根上算，
        #   把整段 O(缺口×觸碰掃描) 從 N 縮到 _VW → 深時框(1h~60k根)大幅提速。勝率統計(S1~SS)仍走全歷史、不受此限。
        #   _VW 取足夠大(遠超可視+合理回捲)，且各標記本就截尾([-2000:]/[-12000:])，近段結果與全量一致。
        _VW = int(visual_window) if visual_window and visual_window > 0 else _VISUAL_WINDOW
        _vw0 = max(1, _N - _VW)
        for _g in range(_vw0, _N - 1):
            _h0 = _H[_g-1]; _l0 = _L[_g-1]
            _h2 = _H[_g+1]; _l2 = _L[_g+1]
            if any(_v != _v for _v in (_h0, _l0, _h2, _l2)):   # NaN
                continue
            if _l2 > _h0 and (_l2 - _h0) / _h0 > _MS:          # 多頭缺口（支撐）候選
                _dir, _top, _bot = "l", _l2, _h0
            elif _h2 < _l0 and (_l0 - _h2) / _l0 > _MS:        # 空頭缺口（壓力）候選
                _dir, _top, _bot = "s", _l0, _h2
            else:
                continue
            # 股票：缺口＝「g 實體處沒被 g-1/g+1 影線刷到」的部分。上/下緣(g-1/g+1 影線=_top/_bot)再夾進 g 的實體範圍——
            #   g-1/g+1 影線刷到的、以及 g 實體以外的都扣掉；夾完沒剩(top<=bot)＝g 實體被刷滿/實體在缺口外→非真跳空→不畫。
            #   1313 1/28：g 是十字、實體(11.25)在缺口[11.05,11.15]外→不畫；6/4：g 實體被 g+1 下影刷滿→不畫。加密不做、維持原定義。
            if stock_gap:
                _bl = _O[_g] if _O[_g] < _C[_g] else _C[_g]   # g 實體下緣
                _bh = _C[_g] if _O[_g] < _C[_g] else _O[_g]   # g 實體上緣
                if _bl > _bot: _bot = _bl
                if _bh < _top: _top = _bh
                if _top <= _bot:
                    continue
            _gw = (_top - _bot) / (_bot if _dir == "l" else _top)
            if _gw <= _MS:
                continue
            # ── 融合單趟掃描：一次算出 _t2/_midi(中線填補)、_ett/_etm/_etb(上/中/下緣首觸)、_pens(逐深突破)。
            #   原本是三個各自 range(_g+2,_N) 的掃描(其中 _t2 與 _etm 條件完全相同、重複掃)；三合一省 ~2/3 迭代。
            #   終止：觸及最遠緣(多=下緣/空=上緣)那一刻，三者本來就同時完成(_etb/_ett 定、pens 到底) → 同點 break。
            _t2 = None; _midi = None; _ett = _etm = _etb = None; _pens = []; _pm = None
            _mid = (_top + _bot) / 2.0
            for _j in range(_g + 2, _N):
                if _dir == "l":
                    _lj = _L[_j]
                    if _lj > _top: continue                          # 沒碰進區間
                    if _ett is None: _ett = times_iso[_j]            # 首觸上緣
                    if _etm is None and _lj <= _mid: _etm = times_iso[_j]; _t2 = _etm; _midi = _j   # 中線(=填補點)
                    if _etb is None and _lj <= _bot: _etb = times_iso[_j]
                    _pv = _bot if _lj < _bot else _lj                # 封底於下緣
                    if _pm is None or _pv < _pm:
                        _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                        if _pv <= _bot: break                        # 到下緣→上中下緣皆定、pens 完成
                else:
                    _hj = _H[_j]
                    if _hj < _bot: continue
                    if _etb is None: _etb = times_iso[_j]            # 首觸下緣(近端)
                    if _etm is None and _hj >= _mid: _etm = times_iso[_j]; _t2 = _etm; _midi = _j
                    if _ett is None and _hj >= _top: _ett = times_iso[_j]
                    _pv = _top if _hj > _top else _hj                # 封頂於上緣
                    if _pm is None or _pv > _pm:
                        _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                        if _pv >= _top: break
            _sweep = (_l0 < _L[_g] and _l0 < _l2) if _dir == "l" else (_h0 > _H[_g] and _h0 > _h2)
            # 交易位階(視覺)：止盈=2W(W=top−bot,多 top+2W／空 bot−2W)、止損=g-1 頂端(high[g-1]=_h0)。
            _W = _top - _bot
            _gsl = _h0                                               # g-1 的頂端(高點)
            _gtp = (_top + 2 * _W) if _dir == "l" else (_bot - 2 * _W)   # 止盈 2W
            # IFVG 反轉偵測：進場(到中線)後，先收盤穿破止損側(沒到止盈) → 反轉成反向 IFVG。
            _inv_t = None; _invi = None
            if _midi is not None:
                for _k in range(_midi, _N):
                    if _dir == "l":
                        if _H[_k] >= _gtp: break                                     # 先到止盈 → 不反轉
                        if _C[_k] < _gsl: _inv_t = times_iso[_k]; _invi = _k; break  # 收盤破止損(g-1頂端) → 反轉
                    else:
                        if _L[_k]  <= _gtp: break
                        if _C[_k] > _gsl: _inv_t = times_iso[_k]; _invi = _k; break  # 收盤破止損(g-1頂端) → 反轉
            # 原缺口色塊右緣：股票(stock_gap)＝「被後面 K 棒影線一碰到缺口(首觸緣 _ett)就結束/消失」
            #   (使用者定義：缺口被影線碰到即失效，不等碰中線)；未被碰過(_ett None)則延伸到右緣。
            #   加密維持原本：反轉延伸到反轉點、否則止於中線填補。
            _box_t2 = _ett if stock_gap else (_inv_t if _inv_t is not None else _t2)
            # (_ett/_etm/_etb 上中下緣首觸 與 _pens 逐深突破 已於上方融合掃描算好)
            # 同向缺口堆疊去重：若本缺口頂端(top)落在「上一個同向缺口下緣往下 0.5W」帶內
            #   [botA-0.5*W_A, botA] → 視為太貼近上方缺口 → 無效(dim：前端淺色、不產生交易訊號)。
            #   連鎖：基準用「上一個同向缺口」不論其有效/無效，無效缺口也讓下方0.5W內的同向缺口跟著無效。
            _A = _last_gap[_dir]            # (botA, W_A)
            _dim = (_A is not None and (_A[0] - 0.5 * _A[1]) <= _top <= _A[0])
            _last_gap[_dir] = (_bot, _W)    # 不論 dim，更新為本缺口 → 連鎖向下傳遞
            _fvg.append({"t": times_iso[_g+1], "top": _top, "bot": _bot, "d": _dir, "t2": _box_t2,
                         "sweep": _sweep, "sl": _gsl, "tp": _gtp, "dim": _dim, "gi": _g + 1,
                         "ett": _ett, "etm": _etm, "etb": _etb, "pens": _pens})    # gi=缺口索引；pens=每次更深突破點
            _gaps_seq.append((_g + 1, _top, _bot, _dir))   # 依序記錄每個視覺缺口（結構模式偵測用，含 dim）
            # IFVG：反方向換色，從反轉點續延，到自己回中線被填補(或右緣)為止；位階用反向(止盈反向1W、止損=被破對側邊)。
            #   股票：缺口一被影線碰到就消失(見上)，不做 IFVG 反轉延續 → 略過。
            if _inv_t is not None and not stock_gap:
                _idir = "s" if _dir == "l" else "l"
                _isl = _top if _dir == "l" else _bot                       # 反向止損＝被破的對側邊
                _itp = (_bot - 2 * _W) if _dir == "l" else (_top + 2 * _W)   # 反向止盈 2W
                _iett = _ietm = _ietb = None       # IFVG 進場分上中下：反向後框上/中/下緣各自首次觸及
                for _m in range(_invi + 1, _N):
                    if _idir == "l":
                        _lm = _L[_m]
                        if _iett is None and _lm <= _top: _iett = times_iso[_m]
                        if _ietm is None and _lm <= _mid: _ietm = times_iso[_m]
                        if _ietb is None and _lm <= _bot: _ietb = times_iso[_m]
                    else:
                        _hm = _H[_m]
                        if _iett is None and _hm >= _top: _iett = times_iso[_m]
                        if _ietm is None and _hm >= _mid: _ietm = times_iso[_m]
                        if _ietb is None and _hm >= _bot: _ietb = times_iso[_m]
                    if _iett and _ietm and _ietb: break
                _it2 = _ietm                       # 盒子右端＝反向回中線
                _fvg.append({"t": _inv_t, "top": _top, "bot": _bot, "d": _idir, "t2": _it2,
                             "sweep": False, "sl": _isl, "tp": _itp, "inv": True, "dim": _dim,
                             "ett": _iett, "etm": _ietm, "etb": _ietb})

            # 無效缺口(下方0.5W帶內堆疊)：不採用 → 不產生任何交易訊號/cascade 標記（僅前端淺色顯示）。
            if _dim:
                continue
            # 以下自動交易訊號 + cascade 標記維持 0.3% 最小寬度（行為不變；視覺色塊不受此限）。
            if _gw < 0.003:
                continue
            _bbgaps.append((_g + 1, _top, _bot, _dir))   # 0.3%+ 缺口全收（不套 g+2），給布林外+FVG 研究標記

            # g+2 觸框過濾：缺口後下一根(g+2)觸及上框(多)/下框(空) → 假突破，作廢。
            #   ⚠ 只用於下方自動交易訊號(_fvg_sigs)＋cascade 標記，不影響上面的純 FVG 視覺色塊。
            # 回測驗證(1h 規格8幣 + 19幣):DD 腰斬(−10%→−6%)、報酬/DD 升 30~56%、保留缺口 avgR 更高。
            if _g + 2 < _N:
                if _dir == "l" and _L[_g+2]  <= _top: continue
                if _dir == "s" and _H[_g+2] >= _bot: continue
            _gaplist.append((_g + 1, _top, _bot, _dir))

            # ── 收盤確認進場訊號（2W/6W 固定 SL/TP；與視覺盒一致）──────────────────
            _W = _top - _bot
            if _W <= 0:
                continue
            _stop = (_bot - 2 * _W) if _dir == "l" else (_top + 2 * _W)
            _tp   = (_top + 6 * _W) if _dir == "l" else (_bot - 6 * _W)
            # 進場棒：拒絕型收盤確認（對齊已驗證 sim_confirm，逐年全正/抗滑價的定版）——
            # 多：插進缺口(low≤top) 但收盤站回 bot 上方(沒插穿) → 市價收盤進場；
            #     進場前若有 K 收破止損區(close<stop) → 放棄此缺口(不追)。空為鏡像。
            _ei = None
            _jend = min(_N, _g + 2 + _FRESH)
            for _j in range(_g + 2, _jend):
                _cj = _C[_j]; _lj = _L[_j]; _hj = _H[_j]
                if _cj != _cj or _lj != _lj or _hj != _hj:      # NaN
                    continue
                if _dir == "l":
                    if _lj <= _top and _cj > _bot: _ei = _j; break   # 插進缺口、收盤站回
                    if _cj < _stop: break                            # 進場前收破止損 → 放棄
                else:
                    if _hj >= _bot and _cj < _top: _ei = _j; break
                    if _cj > _stop: break
            if _ei is None:                                     # 未回補 / 進場前已破止損 → 不產訊號
                continue
            _r = None; _ot = None                               # 自進場次根模擬：先碰止損(l)/止盈(w)
            _hend = min(_N, _g + 2 + _MAXHOLD)                  # 持有上限自確認棒(g+1)起算，對齊 sim_confirm
            for _k in range(_ei + 1, _hend):
                _hk = _H[_k]; _lk = _L[_k]
                if _hk != _hk or _lk != _lk:
                    continue
                if _dir == "l":
                    if _lk <= _stop: _r = "l"; _ot = times_iso[_k]; break   # 先看止損（保守：同棒兩中先認賠）
                    if _hk >= _tp:   _r = "w"; _ot = times_iso[_k]; break
                else:
                    if _hk >= _stop: _r = "l"; _ot = times_iso[_k]; break
                    if _lk <= _tp:   _r = "w"; _ot = times_iso[_k]; break
            _fvg_sigs.append({"k": "fvg", "d": _dir, "t": times_iso[_ei],
                              "entry": _C[_ei], "stop": _stop, "tp": _tp,
                              "r": _r, "ot": _ot})
        # ── 股票隔盤跳空缺口（2 根相鄰、影線對影線）───────────────────────────────
        #   加密 24/7 無跳空 → stock_gap=False 時整段跳過，加密行為 100% 不變（此區完全獨立於上方 3 根 FVG）。
        #   跳空本身即 FVG：向上跳空 low[g] > high[g-1](支撐)、向下跳空 high[g] < low[g-1](壓力)；
        #   缺口上下緣一律用影線(high/low) 定，不用實體。只產生「視覺缺口盒」(含首觸上/中/下緣、逐深突破、
        #   中線填補、IFVG 反轉換色)，標 gap=True；不動 多空/破/順 策略序列(要不要讓跳空驅動策略是下一步)。
        if stock_gap:
            for _g in range(_vw0, _N - 1):
                _h0 = _H[_g-1]; _l0 = _L[_g-1]; _hg = _H[_g]; _lg = _L[_g]
                if any(_v != _v for _v in (_h0, _l0, _hg, _lg)):   # NaN
                    continue
                if _lg > _h0 and (_lg - _h0) / _h0 > _MS:          # 向上跳空（支撐）
                    _dir, _top, _bot, _gsl = "l", _lg, _h0, _h0
                elif _hg < _l0 and (_l0 - _hg) / _l0 > _MS:        # 向下跳空（壓力）
                    _dir, _top, _bot, _gsl = "s", _l0, _hg, _h0
                else:
                    continue
                _mid = (_top + _bot) / 2.0; _W = _top - _bot
                # 融合單趟掃描：首觸上/中/下緣(_ett/_etm/_etb)、中線填補(_t2/_midi)、逐深突破(_pens)。掃描自 g+1 起。
                _t2 = None; _midi = None; _ett = _etm = _etb = None; _pens = []; _pm = None
                for _j in range(_g + 1, _N):
                    if _dir == "l":
                        _lj = _L[_j]
                        if _lj > _top: continue
                        if _ett is None: _ett = times_iso[_j]
                        if _etm is None and _lj <= _mid: _etm = times_iso[_j]; _t2 = _etm; _midi = _j
                        if _etb is None and _lj <= _bot: _etb = times_iso[_j]
                        _pv = _bot if _lj < _bot else _lj
                        if _pm is None or _pv < _pm:
                            _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                            if _pv <= _bot: break
                    else:
                        _hj = _H[_j]
                        if _hj < _bot: continue
                        if _etb is None: _etb = times_iso[_j]
                        if _etm is None and _hj >= _mid: _etm = times_iso[_j]; _t2 = _etm; _midi = _j
                        if _ett is None and _hj >= _top: _ett = times_iso[_j]
                        _pv = _top if _hj > _top else _hj
                        if _pm is None or _pv > _pm:
                            _pm = _pv; _pens.append({"t": times_iso[_j], "p": _pv})
                            if _pv >= _top: break
                _gtp = (_top + 2 * _W) if _dir == "l" else (_bot - 2 * _W)   # 止盈 2W（與 3 根版同位階）
                # IFVG 反轉：到中線後先收盤穿破止損側(g-1 影線緣，這裡＝缺口對側 _gsl) → 反轉換色
                _inv_t = None; _invi = None
                if _midi is not None:
                    for _k in range(_midi, _N):
                        if _dir == "l":
                            if _H[_k] >= _gtp: break
                            if _C[_k] < _gsl: _inv_t = times_iso[_k]; _invi = _k; break
                        else:
                            if _L[_k] <= _gtp: break
                            if _C[_k] > _gsl: _inv_t = times_iso[_k]; _invi = _k; break
                _box_t2 = _ett   # 股票跳空缺口：被後面 K 棒影線首觸即結束/消失(不等中線、不做反轉)
                _fvg.append({"t": times_iso[_g], "top": _top, "bot": _bot, "d": _dir, "t2": _box_t2,
                             "sweep": False, "sl": _gsl, "tp": _gtp, "dim": False, "gi": _g,
                             "ett": _ett, "etm": _etm, "etb": _etb, "pens": _pens, "gap": True})
                if False:   # 股票缺口碰到即消失 → 不畫 IFVG 反轉延續
                    _idir = "s" if _dir == "l" else "l"
                    _isl = _top if _dir == "l" else _bot
                    _itp = (_bot - 2 * _W) if _dir == "l" else (_top + 2 * _W)
                    _iett = _ietm = _ietb = None
                    for _m in range(_invi + 1, _N):
                        if _idir == "l":
                            _lm = _L[_m]
                            if _iett is None and _lm <= _top: _iett = times_iso[_m]
                            if _ietm is None and _lm <= _mid: _ietm = times_iso[_m]
                            if _ietb is None and _lm <= _bot: _ietb = times_iso[_m]
                        else:
                            _hm = _H[_m]
                            if _iett is None and _hm >= _top: _iett = times_iso[_m]
                            if _ietm is None and _hm >= _mid: _ietm = times_iso[_m]
                            if _ietb is None and _hm >= _bot: _ietb = times_iso[_m]
                        if _iett and _ietm and _ietb: break
                    _fvg.append({"t": _inv_t, "top": _top, "bot": _bot, "d": _idir, "t2": _ietm,
                                 "sweep": False, "sl": _isl, "tp": _itp, "inv": True, "dim": False,
                                 "ett": _iett, "etm": _ietm, "etb": _ietb, "gap": True})
        _fvg = _fvg[-12000:]        # 畫滿整窗（gzip 後約 ~200KB）；高保險值防病態 payload，實質不限量
        _fvg_sigs = _fvg_sigs[-200:]

        # ── 結構轉破（破多/破空）：實際計算改跑在 proto 缺口序列上（見下方 多/空 之後的區塊）──────
        # _used：被任一標記用到的 3 根缺口索引 gi；其餘前端淡化。破多/破空改跑 proto 缺口後不再貢獻 gi，
        #        由 多/空(setup A)＋順 標記決定 used。這裡只先初始化(多/空與順會 add)。
        _used = set()

        # ── 「多/空」方向標記（2026-07-01 定義；07-03 B 改 proto 缺口·g 收盤定緣、不等 g+1）──────────
        # 空/多：setup A＝一個做空/做多 3 根 FVG，被 K 棒「逐錨更深觸碰」(封頂/封底、上/下影衝過緣 _MSOVR 作廢)後，
        #       窗(_MSWIN)內「首次新產生同向 proto 缺口」(B) → 標於 B 的 g 那根(不等 g+1)。
        #   B＝proto 缺口(下方偵測)：把原本被 g+1 限制的那條緣改用 g 自己的收盤 C[g]、g 那根即成立，
        #     右邊 g+1 只檢查沒把缺口收盤填回(干擾)。⚠ 加密 24/7 連續盤不用「g.low>g-1.high」字面 2 根缺口(必 0 個)。
        # 約束：觸碰→B 之間不能夾任何反向缺口(除非觸碰棒 cf−touch≤2 順手做的)；
        #       多：B下緣>A下緣 且 B上緣>A上緣(不得完全被A包住、可部分重疊)；空：B下緣<A上緣(重疊可)。不套「B寬<A寬」。
        _MSWIN = 60
        _MSMIN = 0.0005    # 缺口寬度門檻：<0.05% 不算(視覺缺口仍保留 0.01%，不受此限)
        _MSOVR = 0.10      # 觸碰時 K 影線衝過 setup FVG 緣 10% → 該 FVG 作廢(之後不算有效觸碰)
        # 寬度%：多用下緣為分母(top-bot)/bot、空用上緣(top-bot)/top(對齊視覺 _gw 定義)
        _gseq = [(_ci, _tp, _bt, _dr) for (_ci, _tp, _bt, _dr) in _gaps_seq
                 if (_tp - _bt) / (_bt if _dr == "l" else _tp) >= _MSMIN]
        _seq_cf  = [_ci for (_ci, _tp, _bt, _dr) in _gseq]      # 缺口確認棒 cf，升序(生成序)
        _seq_dr  = [_dr for (_ci, _tp, _bt, _dr) in _gseq]      # 對應方向
        _seq_top = [_tp for (_ci, _tp, _bt, _dr) in _gseq]      # 對應上緣
        _seq_bot = [_bt for (_ci, _tp, _bt, _dr) in _gseq]      # 對應下緣
        _bear = [(_ci, _tp, _bt) for (_ci, _tp, _bt, _dr) in _gseq if _dr == "s"]
        _bull = [(_ci, _tp, _bt) for (_ci, _tp, _bt, _dr) in _gseq if _dr == "l"]
        # B＝「proto 缺口」偵測：bull＝g 收盤站上前根高點(C[g]>H[g-1])→缺口[H[g-1], C[g]]，右邊 g+1 收盤沒跌回
        #   缺口底(C[g+1]>H[g-1]＝沒干擾) → 標在 g。bear 鏡像(C[g]<L[g-1]→缺口[C[g], L[g-1]]、C[g+1]<L[g-1] 沒干擾)。
        _pseq = []             # (g, top, bot, dir) proto 缺口，依 g 升序(生成序)；同視覺窗(_vw0)
        for _g2 in range(_vw0, _N - 1):
            _hm1 = _H[_g2 - 1]; _lm1 = _L[_g2 - 1]; _cg = _C[_g2]; _cn = _C[_g2 + 1]
            if any(_v != _v for _v in (_hm1, _lm1, _cg, _cn)):        # NaN
                continue
            if _cg > _hm1 and _cn > _hm1:                             # bull proto：g 收盤站上前根高點 + g+1 收盤沒跌回缺口底
                _pt, _pb, _pd = _cg, _hm1, "l"                       # 缺口區 [H[g-1], C[g]]
                if (_pt - _pb) / _pb < _MSMIN: continue
            elif _cg < _lm1 and _cn < _lm1:                          # bear proto：g 收盤破前根低點 + g+1 收盤沒漲回缺口頂
                _pt, _pb, _pd = _lm1, _cg, "s"                       # 缺口區 [C[g], L[g-1]]
                if (_pt - _pb) / _pt < _MSMIN: continue
            else:
                continue
            _pseq.append((_g2, _pt, _pb, _pd))
        _pcf  = [_p[0] for _p in _pseq]; _pdr = [_p[3] for _p in _pseq]
        _ptop = [_p[1] for _p in _pseq]; _pbot = [_p[2] for _p in _pseq]
        _ms_seen = set()                                   # 去重：同一 B(_cf2)只標一次
        for (_cf, _top, _bot) in _bear:                    # 空：setup A 為 3 根 bear FVG、B 為 proto 缺口
            _mx = None
            for _touch in range(_cf + 1, _N):
                if _mx is not None and _mx >= _top: break
                if _H[_touch] > _top * (1 + _MSOVR): break
                if _H[_touch] < _bot: continue
                _r = _top if _H[_touch] > _top else _H[_touch]
                if _mx is not None and _r <= _mx: continue
                _mx = _r
                _p = bisect.bisect_right(_pcf, _touch)     # 觸碰後第一個 bear proto 缺口＝B
                _B = None
                for _q in range(_p, len(_pcf)):
                    if _pdr[_q] == "s": _B = _q; break
                if _B is None: continue
                _cf2 = _pcf[_B]
                # 空：B下緣<A上緣(重疊可)；不套「B寬<A寬」。
                if _cf2 in _ms_seen or _cf2 - _touch > _MSWIN or not _pbot[_B] < _top: continue
                _blk = False
                for _q in range(_p, _B):
                    if _pdr[_q] == "l" and _pcf[_q] - _touch > 2:
                        _blk = True; break
                if _blk: continue
                _fvg_ms.append({"t": times_iso[_cf2], "d": "s"}); _ms_seen.add(_cf2); _used.add(_cf)
        for (_cf, _top, _bot) in _bull:                    # 多（鏡像）
            _mn = None
            for _touch in range(_cf + 1, _N):
                if _mn is not None and _mn <= _bot: break
                if _L[_touch] < _bot * (1 - _MSOVR): break
                if _L[_touch] > _top: continue
                _r = _bot if _L[_touch] < _bot else _L[_touch]
                if _mn is not None and _r >= _mn: continue
                _mn = _r
                _p = bisect.bisect_right(_pcf, _touch)
                _B = None
                for _q in range(_p, len(_pcf)):
                    if _pdr[_q] == "l": _B = _q; break
                if _B is None: continue
                _cf2 = _pcf[_B]
                # 多：B 下緣要高於 A 下緣(_pbot>_bot)＋ B 不能完全被 A 包住→上緣要突出 A 上緣(_ptop>_top)。
                #   (可部分重疊：B 下緣容許 <A 上緣；只是不得整個縮在 A 內、也不得低於 A 下緣。)不套「B寬<A寬」。
                if (_cf2 in _ms_seen or _cf2 - _touch > _MSWIN
                        or not (_pbot[_B] > _bot) or not (_ptop[_B] > _top)): continue
                _blk = False
                for _q in range(_p, _B):
                    if _pdr[_q] == "s" and _pcf[_q] - _touch > 2:
                        _blk = True; break
                if _blk: continue
                _fvg_ms.append({"t": times_iso[_cf2], "d": "l"}); _ms_seen.add(_cf2); _used.add(_cf)
        _fvg_ms.sort(key=lambda x: x["t"])
        _fvg_ms = _fvg_ms[-2000:]

        # ── 結構轉破（破多/破空）：跑在 proto 缺口序列上 ────────────────────────────────────
        # 前一 proto 缺口→緊接反向 proto 缺口→反向缺口 g/g-1 影線破到前缺口中線 → 破多/破空。缺口全用 proto
        #   缺口(g 收盤定緣、標在 g)＝比舊 3 根 FVG 版早一根。排除(已收破在前 _broke、mitigate 二次造訪 _mit)照舊。標在觸發那根 g。
        _pprev = None
        for (_kp, _ptp, _pbt, _pdd) in _pseq:              # 依 g 升序(生成序)
            if _pprev is not None:
                _mid = (_pprev["top"] + _pprev["bot"]) / 2.0
                if _pdd == "s" and _pprev["dir"] == "l":   # 破多：前 bull proto、現 bear proto
                    _fj = next((_j for _j in range(_pprev["idx"] + 1, _kp - 1) if _L[_j] <= _mid), None)
                    _mit = _fj is not None and any(_C[_m] > _pprev["top"] for _m in range(_fj + 1, _kp))
                    _broke = any(_C[_j] < _pprev["bot"] for _j in range(_pprev["idx"] + 1, _kp - 1))
                    if not _mit and not _broke and (_L[_kp] <= _mid or _L[_kp - 1] <= _mid):
                        _fvg_break.append({"t": times_iso[_kp], "p": _pprev["top"], "d": "l"})
                elif _pdd == "l" and _pprev["dir"] == "s":  # 破空（鏡像）：前 bear proto、現 bull proto
                    _fj = next((_j for _j in range(_pprev["idx"] + 1, _kp - 1) if _H[_j] >= _mid), None)
                    _mit = _fj is not None and any(_C[_m] < _pprev["bot"] for _m in range(_fj + 1, _kp))
                    _broke = any(_C[_j] > _pprev["top"] for _j in range(_pprev["idx"] + 1, _kp - 1))
                    if not _mit and not _broke and (_H[_kp] >= _mid or _H[_kp - 1] >= _mid):
                        _fvg_break.append({"t": times_iso[_kp], "p": _pprev["bot"], "d": "s"})
            _pprev = {"dir": _pdd, "bot": _pbt, "top": _ptp, "idx": _kp}
        _fvg_break.sort(key=lambda x: x["t"]);      _fvg_break = _fvg_break[-2000:]

        # ── 「順多/順空」方向標記（2026-07-02；07-03 影線穿透＋近期兩個；07-03b 近期以「穿透點」衡量、R可晚於觸碰）──
        # 順多：第一步與「多」完全相同——未觸碰的做多FVG(A)被首次碰到(逐錨更深觸碰、下影衝過下緣10%作廢)；
        #       第二步——觸碰後(含同棒)最早、且「R比A晚生成 + R是穿透當下最近兩個做空FVG之一」的
        #       「做空FVG(R)上緣被影線穿透(high>R.top)」事件 → 標「順多」於穿透那根。
        #       （「近期兩個」以『穿透點』衡量、非觸碰點：觸碰後才形成、隨即被穿透的新做空FVG才是真正的順勢延續，
        #       例:BTC 1d 2025-01-19 觸碰後才生成的多/空FVG；不往更早回溯找「還沒破的」→ 避免抓到陳年舊缺口。）
        # 中間規則：觸碰→穿透之間不能夾雜任何其他FVG(R 本身、及觸碰棒 cf−touch≤2 順手做的除外)。
        # 順空：鏡像——做空FVG(A)被碰到後，穿透當下最近兩個做多FVG之一被影線穿透下緣(low<R.bot) → 標「順空」。
        # 效能：預算每個FVG的「首次被影線穿透」事件 (brk_idx, cf) 依 brk 升序 → 錨點/近期查詢用 bisect。
        # 用 heap 單趟掃描 O(N log G) 建事件序列（上緣/下緣最先被碰者先被穿透）。
        import heapq as _hq
        _brk_s = []                                    # 做空FVG：首次 high>top 的棒（單趟天然依 brk 升序）
        _hp = []; _bi = 0
        for _j in range(_vw0, _N):                     # 缺口皆在窗內(cf≥_vw0)→ 窗前無事可做，從 _vw0 起掃
            while _bi < len(_bear) and _bear[_bi][0] < _j:   # cf<j 的缺口自 cf+1 起可被突破 → 入堆
                _hq.heappush(_hp, (_bear[_bi][1], _bear[_bi][0])); _bi += 1
            _hj = _H[_j]
            while _hp and _hp[0][0] < _hj:             # 上緣最低者先被影線穿透（NaN 比較恆 False → 自動跳過）
                _tp0, _cf0 = _hq.heappop(_hp); _brk_s.append((_j, _cf0))
        _brk_l = []                                    # 做多FVG：首次 low<bot 的棒（鏡像，堆存 -bot）
        _hp = []; _bi = 0
        for _j in range(_vw0, _N):
            while _bi < len(_bull) and _bull[_bi][0] < _j:
                _hq.heappush(_hp, (-_bull[_bi][2], _bull[_bi][0])); _bi += 1
            _lj = _L[_j]
            while _hp and -_hp[0][0] > _lj:            # 下緣最高者先被影線穿透
                _bt0, _cf0 = _hq.heappop(_hp); _brk_l.append((_j, _cf0))
        _bear_cfs = [_c[0] for _c in _bear]            # 升序(生成序)，供 bisect 找「突破當下近期的做空FVG」
        _bull_cfs = [_c[0] for _c in _bull]
        _shun_seen = set()                             # 去重：同一(突破棒,方向)只標一次

        def _shun_scan(_gaps, _rcand_cfs, _events, _d):
            """_gaps=A候選(同向)、_rcand_cfs=反向FVG的cf清單(升序)、_events=反向FVG突破事件(bj,rcf)依bj升序、_d='l'順多/'s'順空。"""
            for (_cf, _top, _bot) in _gaps:
                _anchor = None                         # 逐錨更深觸碰(與多/空同)
                for _touch in range(_cf + 1, _N):
                    if _d == "l":
                        if _anchor is not None and _anchor <= _bot: break  # 錨達下緣→無更深觸碰(無損止掃)
                        if _L[_touch] < _bot * (1 - _MSOVR): break     # 衝過下緣10% → A作廢
                        if _L[_touch] > _top: continue                 # 沒碰進區間
                        _r = _bot if _L[_touch] < _bot else _L[_touch]
                        if _anchor is not None and _r >= _anchor: continue
                    else:
                        if _anchor is not None and _anchor >= _top: break  # 錨達上緣→無更深觸碰(無損止掃)
                        if _H[_touch] > _top * (1 + _MSOVR): break
                        if _H[_touch] < _bot: continue
                        _r = _top if _H[_touch] > _top else _H[_touch]
                        if _anchor is not None and _r <= _anchor: continue
                    _anchor = _r
                    # 觸碰後(含同棒)最早、且符合條件的「反向FVG被影線穿透」事件 → 標於穿透那根(_bk)。
                    #   條件① R 比 A 晚生成(cf(R)>cf(A))——A是「第一個」、R是「第二個」，時序不能反過來。
                    #   條件② R 是「穿透當下(_bj 那根)」字面最近兩個反向FVG之一──『近期』以穿透點衡量、非觸碰點：
                    #         觸碰後才形成、隨即被穿透的新反向FVG才是真正的順勢延續(例:BTC 1d 2025-01-19：
                    #         1/17 觸 12/19 空FVG→1/18 才生成多FVG→1/19 破其下緣；R(1/18)晚於觸碰(1/17)。)
                    #         不往更早回溯找「還沒破的」→ 避免抓到與當下結構無關的陳年舊缺口(例:BCH 2023 舊缺口)。
                    #   同棒(_bj==_touch)允許：單根大反轉棒 high 觸上方反向FVG＋low 破下方R(例:BTC 1d 2025-11-11)。
                    _p2 = bisect.bisect_left(_events, (_touch, -1))    # 第一個 bj≥touch 的事件
                    _bk = None; _rcf = None
                    for _e in range(_p2, len(_events)):
                        _bj, _c2 = _events[_e]
                        if _bj - _touch > _MSWIN: break                # 超窗(events 依 bj 升序 → 之後皆超窗)
                        if _c2 <= _cf: continue                        # 條件①：R 須晚於 A
                        _ri = bisect.bisect_right(_rcand_cfs, _bj)     # 條件②：R 為穿透當下最近兩個反向FVG之一
                        if _c2 not in _rcand_cfs[max(0, _ri - 2):_ri]: continue
                        _bk = _bj; _rcf = _c2; break
                    if _bk is None or (_bk, _d) in _shun_seen: continue
                    # 觸碰→穿透之間夾其他FVG(R 本身、及觸碰棒 cf−touch≤2 順手做的除外)→擋
                    _p = bisect.bisect_right(_seq_cf, _touch)
                    _blk = False
                    for _q in range(_p, len(_seq_cf)):
                        if _seq_cf[_q] >= _bk: break
                        if _seq_cf[_q] == _rcf: continue               # R 本身是目標、不算「夾雜」
                        if _seq_cf[_q] - _touch > 2: _blk = True; break
                    if _blk: continue
                    _fvg_shun.append({"t": times_iso[_bk], "d": _d})
                    _shun_seen.add((_bk, _d)); _used.add(_cf); _used.add(_rcf)

        _shun_scan(_bull, _bear_cfs, _brk_s, "l")      # 順多：吃做多FVG → 近期兩個做空FVG其中一個影線穿透上緣
        _shun_scan(_bear, _bull_cfs, _brk_l, "s")      # 順空：吃做空FVG → 近期兩個做多FVG其中一個影線穿透下緣
        _fvg_shun.sort(key=lambda x: x["t"])
        _fvg_shun = _fvg_shun[-2000:]
        # ── 標記「有無被用到」：未被任何標記(破多/破空/多/空)用到的主缺口 → used=False(前端淡化)。
        #     IFVG(inv)非主缺口、不在偵測序列 → 視為 used(不淡化)。
        for _z in _fvg:
            _z["used"] = True if _z.get("inv") else (_z.get("gi") in _used)
    except Exception:
        _fvg = []
        _fvg_sigs = []
        _fvg_break = []
        _fvg_ms = []
        _fvg_shun = []

    # ── SMC 擺動 pivot 遮罩（向量化，一次算好給下面 掃蕩/結構/OB/SR/通道 共用）─────────
    #   pivot high(半窗 w)＝H[p] ≥ 窗[p-w, p+w] 內全部 H(含 NaN → 該窗判 False，與原逐點 all() 完全一致：
    #   窗內任一 NaN 使 max=NaN、中心≥NaN=False)。原本 6 個區塊各自對每根做 all() 迴圈(數十萬次)→改單次向量。
    def _pivot_mask(_arr, _w, _hi):
        import numpy as _np
        _n = len(_arr); _win = 2 * _w + 1
        _m = _np.zeros(_n, dtype=bool)
        if _n >= _win:
            _sw = _np.lib.stride_tricks.sliding_window_view(_arr, _win)   # 列 i → 窗[i, i+win-1]，中心 i+w
            _ctr = _sw[:, _w]
            _ext = _sw.max(axis=1) if _hi else _sw.min(axis=1)           # NaN 傳播 → 中心比較為 False
            _m[_w:_n - _w] = (_ctr >= _ext) if _hi else (_ctr <= _ext)
        return _m
    try:
        _phM5 = _pivot_mask(highs, 5, True); _plM5 = _pivot_mask(lows, 5, False)
        _phM8 = _pivot_mask(highs, 8, True); _plM8 = _pivot_mask(lows, 8, False)
    except Exception:
        _phM5 = _plM5 = _phM8 = _plM8 = None

    # ── SMC Sweep(掃頂/掃底)偵測【階段1：移植 Pine「SR+SMC 教練」】──────────────
    #   掃頂(d=s)：high 突破最近擺高、但 close 收回其下=假突破/抓流動性；掃底(d=l)鏡像。
    #   對齊 Pine f_processStructureModule 的 bearishSweep/bullishSweep；擺動 pivot 半窗 _PL=5。
    #   pivot 於 _i-_PL 確認(需 ±_PL 兩側)，故用「已確認」擺高/低比對，不預知未來。
    _smc_sweep = []
    try:
        _sN = len(times_iso); _PL = 5
        _sH = highs.tolist(); _sL = lows.tolist(); _sC = closes.tolist()
        _lastSH = None; _lastSL = None; _shSwept = False; _slSwept = False
        for _i in range(_sN):
            _p = _i - _PL                                          # 本根能確認的 pivot 落點
            if _p - _PL >= 0:
                _ph = _sH[_p]; _pl = _sL[_p]
                if _phM5[_p]:
                    if _lastSH is None or _ph != _lastSH: _shSwept = False   # 新擺高→重置可再掃
                    _lastSH = _ph
                if _plM5[_p]:
                    if _lastSL is None or _pl != _lastSL: _slSwept = False
                    _lastSL = _pl
            _hi = _sH[_i]; _lo = _sL[_i]; _ci = _sC[_i]
            if _ci != _ci:
                continue
            if _lastSH is not None and not _shSwept and _hi > _lastSH and _ci < _lastSH:
                _smc_sweep.append({"t": times_iso[_i], "d": "s"}); _shSwept = True   # 掃頂
            if _lastSL is not None and not _slSwept and _lo < _lastSL and _ci > _lastSL:
                _smc_sweep.append({"t": times_iso[_i], "d": "l"}); _slSwept = True   # 掃底
        _smc_sweep = _smc_sweep[-2000:]
    except Exception:
        _smc_sweep = []

    # ── SMC 結構事件 BOS/CHoCH【階段2：移植 Pine f_processStructureModule】───────────
    #   收盤上穿最近擺高→多方破(趨勢原空=CHoCH↑轉多／否則BOS↑延續)；收盤下破最近擺低鏡像。
    #   每筆回傳線段端點：t0=擺點K、t1=收破K、p=擺點價、k=事件型別(給前端畫水平線+標籤)。
    _smc_struct = []
    try:
        _sN = len(times_iso); _PL = 5
        _sH = highs.tolist(); _sL = lows.tolist(); _sC = closes.tolist()
        _lastSH = None; _lastSHb = None; _lastSL = None; _lastSLb = None
        _shBroken = False; _slBroken = False; _trend = 0
        for _i in range(_sN):
            _p = _i - _PL
            if _p - _PL >= 0:
                _ph = _sH[_p]; _pl = _sL[_p]
                if _phM5[_p]:
                    _lastSH = _ph; _lastSHb = _p; _shBroken = False
                if _plM5[_p]:
                    _lastSL = _pl; _lastSLb = _p; _slBroken = False
            _ci = _sC[_i]; _cp = _sC[_i - 1] if _i > 0 else float("nan")
            if _ci != _ci:
                continue
            if _lastSH is not None and not _shBroken and _ci > _lastSH and (_cp != _cp or _cp <= _lastSH):
                _smc_struct.append({"t0": times_iso[_lastSHb], "t1": times_iso[_i], "p": _lastSH,
                                    "k": "choch_up" if _trend == -1 else "bos_up"})
                _trend = 1; _shBroken = True
            if _lastSL is not None and not _slBroken and _ci < _lastSL and (_cp != _cp or _cp >= _lastSL):
                _smc_struct.append({"t0": times_iso[_lastSLb], "t1": times_iso[_i], "p": _lastSL,
                                    "k": "choch_dn" if _trend == 1 else "bos_dn"})
                _trend = -1; _slBroken = True
        _smc_struct = _smc_struct[-1000:]
    except Exception:
        _smc_struct = []

    # ── SMC 訂單區 OB【階段3：移植 Pine f_processOrderBlockModule】────────────────
    #   結構破時往回找最近一根反向「實體」K 當 OB：多破→最後空K=多方OB(支撐)；空破→最後多K=空方OB(阻力)。
    #   OB 於「收盤穿越另側」(多OB:close<下緣／空OB:close>上緣)時失效。
    #   回傳每個 OB {t0 建立來源K, t1 失效K或None(仍存活), top, bot, d}；前端畫框(存活者延伸到右緣)。
    _smc_ob = []
    try:
        _sN = len(times_iso); _PL = 5; _LB = 20
        _sH = highs.tolist(); _sL = lows.tolist(); _sC = closes.tolist(); _sO = opens.tolist()
        _lastSH = None; _lastSL = None; _shBroken = False; _slBroken = False
        _aliveBull = []; _aliveBear = []                    # 存活OB在 _smc_ob 的索引
        for _i in range(_sN):
            _p = _i - _PL
            if _p - _PL >= 0:
                _ph = _sH[_p]; _pl = _sL[_p]
                if _phM5[_p]:
                    _lastSH = _ph; _shBroken = False
                if _plM5[_p]:
                    _lastSL = _pl; _slBroken = False
            _ci = _sC[_i]; _cp = _sC[_i - 1] if _i > 0 else float("nan")
            if _ci != _ci:
                continue
            for _oi in list(_aliveBull):                    # 多方OB：收盤跌破下緣→失效
                if _ci < _smc_ob[_oi]["bot"]:
                    _smc_ob[_oi]["t1"] = times_iso[_i]; _aliveBull.remove(_oi)
            for _oi in list(_aliveBear):                    # 空方OB：收盤突破上緣→失效
                if _ci > _smc_ob[_oi]["top"]:
                    _smc_ob[_oi]["t1"] = times_iso[_i]; _aliveBear.remove(_oi)
            if _lastSH is not None and not _shBroken and _ci > _lastSH and (_cp != _cp or _cp <= _lastSH):
                _shBroken = True
                _off = next((_j for _j in range(1, _LB + 1) if _i - _j >= 0 and _sC[_i - _j] < _sO[_i - _j]), None)
                if _off is not None:
                    _b = _i - _off
                    _smc_ob.append({"t0": times_iso[_b], "t1": None, "d": "l",
                                    "top": max(_sO[_b], _sC[_b]), "bot": min(_sO[_b], _sC[_b])})
                    _aliveBull.append(len(_smc_ob) - 1)
            if _lastSL is not None and not _slBroken and _ci < _lastSL and (_cp != _cp or _cp >= _lastSL):
                _slBroken = True
                _off = next((_j for _j in range(1, _LB + 1) if _i - _j >= 0 and _sC[_i - _j] > _sO[_i - _j]), None)
                if _off is not None:
                    _b = _i - _off
                    _smc_ob.append({"t0": times_iso[_b], "t1": None, "d": "s",
                                    "top": max(_sO[_b], _sC[_b]), "bot": min(_sO[_b], _sC[_b])})
                    _aliveBear.append(len(_smc_ob) - 1)
        _smc_ob = _smc_ob[-500:]
    except Exception:
        _smc_ob = []

    # ── SMC 支撐/阻力 SR【階段4：移植 Pine f_processSrModule】──────────────────────
    #   pivot(半窗8)高→阻力、低→支撐；區寬=ATR×0.20；就近(ATR×1.25)則併入既有區、否則新建(每側最多3)。
    #   收盤突破區緣+緩衝(ATR×0.15，需連2根確認)→該區失效；若開角色互換→翻成反向區續存。
    #   回傳 {t0 來源K, t1 失效K或None, top, bot, d('res'/'sup')}；前端畫框(存活延伸到右緣)。
    _smc_sr = []
    try:
        _sN = len(times_iso); _PL = 8; _ZW = 0.20; _MRG = 1.25; _BUF = 0.15; _MAXZ = 3; _ATRN = 14
        _sH = highs.tolist(); _sL = lows.tolist(); _sC = closes.tolist()
        _tr = [float("nan")] * _sN                          # True Range → RMA(14)=ATR，對齊 Pine ta.atr
        for _i in range(_sN):
            if _i == 0:
                _tr[_i] = _sH[_i] - _sL[_i]
            else:
                _pc = _sC[_i - 1]
                _tr[_i] = max(_sH[_i] - _sL[_i], abs(_sH[_i] - _pc), abs(_sL[_i] - _pc))
        _atr = [float("nan")] * _sN; _a = float("nan")
        for _i in range(_sN):
            _t = _tr[_i]
            if _t != _t:
                continue
            if _a != _a:
                if _i >= _ATRN - 1:
                    _a = sum(_tr[_i - _ATRN + 1:_i + 1]) / _ATRN
            else:
                _a = (_a * (_ATRN - 1) + _t) / _ATRN
            _atr[_i] = _a
        _res = []; _sup = []                                # 存活區 dict：{t0,t1,top,bot,d,...}
        def _mid(_z): return (_z["top"] + _z["bot"]) / 2.0
        def _push(_lst, _z, _i):
            _lst.append(_z); _smc_sr.append(_z)
            if len(_lst) > _MAXZ:
                _old = _lst.pop(0)
                if _old["t1"] is None: _old["t1"] = times_iso[_i]
        for _i in range(_sN):
            _atrNow = _atr[_i]
            _p = _i - _PL
            if _p - _PL >= 0 and _atr[_p] == _atr[_p]:
                _atrP = _atr[_p]; _hw = _atrP * _ZW; _md = _atrP * _MRG
                _ph = _sH[_p]
                if _phM8[_p]:
                    _nz = next((_z for _z in _res if abs(_mid(_z) - _ph) <= _md), None)
                    if _nz is not None:
                        _nz["top"] = max(_nz["top"], _ph + _hw); _nz["bot"] = min(_nz["bot"], _ph - _hw)
                    else:
                        _push(_res, {"t0": times_iso[_p], "t1": None, "top": _ph + _hw, "bot": _ph - _hw, "d": "res"}, _i)
                _pl = _sL[_p]
                if _plM8[_p]:
                    _nz = next((_z for _z in _sup if abs(_mid(_z) - _pl) <= _md), None)
                    if _nz is not None:
                        _nz["top"] = max(_nz["top"], _pl + _hw); _nz["bot"] = min(_nz["bot"], _pl - _hw)
                    else:
                        _push(_sup, {"t0": times_iso[_p], "t1": None, "top": _pl + _hw, "bot": _pl - _hw, "d": "sup"}, _i)
            _ci = _sC[_i]
            if _ci == _ci and _atrNow == _atrNow:
                _buf = _atrNow * _BUF
                _cp = _sC[_i - 1] if _i > 0 else float("nan")
                _bufP = (_atr[_i - 1] if _i > 0 and _atr[_i - 1] == _atr[_i - 1] else _atrNow) * _BUF
                for _z in list(_res):                       # 阻力破：收盤>上緣+緩衝(連2根)→失效，角色翻成支撐
                    if _ci > _z["top"] + _buf and _cp == _cp and _cp > _z["top"] + _bufP:
                        _z["t1"] = times_iso[_i]; _res.remove(_z)
                        _push(_sup, {"t0": times_iso[_i], "t1": None, "top": _z["top"], "bot": _z["bot"], "d": "sup"}, _i)
                for _z in list(_sup):                       # 支撐破：收盤<下緣-緩衝(連2根)→失效，角色翻成阻力
                    if _ci < _z["bot"] - _buf and _cp == _cp and _cp < _z["bot"] - _bufP:
                        _z["t1"] = times_iso[_i]; _sup.remove(_z)
                        _push(_res, {"t0": times_iso[_i], "t1": None, "top": _z["top"], "bot": _z["bot"], "d": "res"}, _i)
        _smc_sr = _smc_sr[-500:]
    except Exception:
        _smc_sr = []

    # ── VWAP【階段5：移植 Pine，每日錨定；當前時框計算】────────────────────────────
    #   每根 hlc3×量 累積，遇「日期變更」重置。回傳 [{t, v}]，v=尚無量時 None。
    _vwap = []
    try:
        _vol = df["volume"].to_numpy(dtype=float) if "volume" in df.columns else None
        if _vol is not None:
            _cumPV = 0.0; _cumV = 0.0; _curday = None
            for _i in range(len(times_iso)):
                _day = times_iso[_i][:10]
                if _day != _curday:
                    _cumPV = 0.0; _cumV = 0.0; _curday = _day
                _v = _vol[_i]
                if _v == _v and _v > 0:
                    _cumPV += (highs[_i] + lows[_i] + closes[_i]) / 3.0 * _v; _cumV += _v
                _vwap.append({"t": times_iso[_i], "v": (_cumPV / _cumV if _cumV > 0 else None)})
        _vwap = _vwap[-3000:]
    except Exception:
        _vwap = []

    # ── 自動平行通道【階段5：移植 Pine f_swingChannel；當前時框(取代原4H/1H/15M多時框)】───
    #   由最近兩個同向擺點定基準線(上升=兩低點/下降=兩高點)、平行線寬=max(ATR×1.2, 對側極值到基準距離)。
    #   回傳當前通道 {dir, t1,t2(錨點K), lo1,lo2,up1,up2(上下軌在兩錨點的價)}；前端畫上下軌+填色並右延。
    _channel = None
    try:
        _sN = len(times_iso); _CPL = 5; _ATRN = 14; _MINW = 1.20
        _sH = highs.tolist(); _sL = lows.tolist(); _sC = closes.tolist()
        _tr = [float("nan")] * _sN
        for _i in range(_sN):
            _tr[_i] = (_sH[_i] - _sL[_i]) if _i == 0 else max(_sH[_i] - _sL[_i], abs(_sH[_i] - _sC[_i - 1]), abs(_sL[_i] - _sC[_i - 1]))
        _atr = [float("nan")] * _sN; _a = float("nan")
        for _i in range(_sN):
            if _a != _a:
                if _i >= _ATRN - 1: _a = sum(_tr[_i - _ATRN + 1:_i + 1]) / _ATRN
            else:
                _a = (_a * (_ATRN - 1) + _tr[_i]) / _ATRN
            _atr[_i] = _a
        _pH = _lH = _pL = _lL = None; _pHt = _lHt = _pLt = _lLt = None
        for _i in range(_sN):
            _p = _i - _CPL
            if _p - _CPL >= 0:
                _ph = _sH[_p]
                if _phM5[_p]:
                    _pH, _pHt, _lH, _lHt = _lH, _lHt, _ph, _p
                _pl = _sL[_p]
                if _plM5[_p]:
                    _pL, _pLt, _lL, _lLt = _lL, _lLt, _pl, _p
        _up = _pL is not None and _lL is not None and _lL > _pL and _pLt is not None and _lLt is not None and _lLt > _pLt
        _dn = _pH is not None and _lH is not None and _lH < _pH and _pHt is not None and _lHt is not None and _lHt > _pHt
        _dir = (1 if _lLt >= _lHt else -1) if (_up and _dn) else (1 if _up else (-1 if _dn else 0))
        if _dir != 0:
            _a1t, _a1p, _a2t, _a2p = (_pLt, _pL, _lLt, _lL) if _dir == 1 else (_pHt, _pH, _lHt, _lH)
            _aref = _atr[_sN - 1 - _CPL] if _sN - 1 - _CPL >= 0 and _atr[_sN - 1 - _CPL] == _atr[_sN - 1 - _CPL] else _atr[_sN - 1]
            _w = max((_aref if _aref == _aref else 0.0) * _MINW, 1e-9)
            def _lv(_t1, _q1, _t2, _q2, _tt):
                return _q1 if _t2 == _t1 else _q1 + (_q2 - _q1) * (_tt - _t1) / (_t2 - _t1)
            if _dir == 1 and _lH is not None and _lHt >= _a1t:
                _cw = _lH - _lv(_a1t, _a1p, _a2t, _a2p, _lHt)
                if _cw == _cw and _cw > 0: _w = max(_w, _cw)
            if _dir == -1 and _lL is not None and _lLt >= _a1t:
                _cw = _lv(_a1t, _a1p, _a2t, _a2p, _lLt) - _lL
                if _cw == _cw and _cw > 0: _w = max(_w, _cw)
            if _dir == 1:
                _lo1, _lo2, _up1, _up2 = _a1p, _a2p, _a1p + _w, _a2p + _w
            else:
                _up1, _up2, _lo1, _lo2 = _a1p, _a2p, _a1p - _w, _a2p - _w
            _channel = {"dir": _dir, "t1": times_iso[_a1t], "t2": times_iso[_a2t],
                        "lo1": _lo1, "lo2": _lo2, "up1": _up1, "up2": _up2}
    except Exception:
        _channel = None

    # ── 布林通道外 + FVG 進場點（均值回歸·研究用主圖標記，讓使用者目視驗證）──────────
    #   對齊 /tmp/fvg_bb.py 回測：進場=缺口頂(top)、firsttouch 真過濾。
    #   首次觸及進場價的那根 K，若同時在布林通道外同側(多:跌破下軌 low≤bb_lower／空:突破上軌 high≥bb_upper)
    #   → 標進場；否則整筆放棄(不延後、不追)。止損 2W / 止盈 6W(W=top−bot)，模擬出勝/敗供色彩。
    #   ⚠ 純研究視覺，獨立於自動交易；bb 缺(NaN)整段退空。
    _fvg_bb = []; _fvg_bb_a = []; _fvg_bb_m = []
    try:
        _BUFb = 0.0005; _FRb = 168; _MHb = 200; _SSWIN = 3
        # numpy→list 一次轉換：純 Python 迴圈逐元素存取 list(float) 遠快於 numpy 標量+float()
        # （與下方 _fvg_trades 區塊的 _Hn/_Ln 同一手法）。NaN 轉 list 後仍為 float('nan')，x!=x 判定不變。
        _Hb = highs.tolist(); _Lb = lows.tolist(); _Cb = closes.tolist(); _Ob = opens.tolist()
        _BUb = bb_up.tolist(); _BLb = bb_lo.tolist(); _BMb = bb_mid.tolist()
        # SS1（布林軌道反轉2棒·靠軌深半）旗標，index=B棒；進場「那附近」要有同向 SS1 才算確認。對齊 crt SS1 與 fvg_bb.py。
        _ss1L = [False] * _N; _ss1S = [False] * _N
        for _b in range(1, _N):
            _a = _b - 1
            _ub = _BUb[_b]; _mb = _BMb[_b]; _lb = _BLb[_b]
            if _ub != _ub or _mb != _mb or _lb != _lb:   # NaN
                continue
            _ca = _Cb[_a]; _oa = _Ob[_a]; _la = _Lb[_a]; _ha = _Hb[_a]
            _cb = _Cb[_b]; _ob = _Ob[_b]; _lkb = _Lb[_b]; _hb = _Hb[_b]
            _lba = _BLb[_a]; _uba = _BUb[_a]
            # 多（下軌反轉）：A綠跌 B紅漲、B收>下軌、A/B任一觸下軌、B未碰中軌、SS1深(B收<(下+中)/2)
            if (_ca < _oa) and (_cb > _ob) and (_cb > _lb) \
               and ((_lba == _lba and _la <= _lba) or _lkb <= _lb) \
               and (_hb < _mb) and (_cb < (_lb + _mb) / 2.0):
                _ss1L[_b] = True
            # 空（上軌反轉）：A紅漲 B綠跌、B收<上軌、A/B任一觸上軌、B未碰中軌、SS1(B收>(上+中)/2)
            if (_ca > _oa) and (_cb < _ob) and (_cb < _ub) \
               and ((_uba == _uba and _ha >= _uba) or _hb >= _ub) \
               and (_lkb > _mb) and (_cb > (_ub + _mb) / 2.0):
                _ss1S[_b] = True
        # 出場模擬：抱到止損/止盈/超時；回 (出場棒, 勝敗, 出場價)。同棒先認止損(保守)。
        def _simx(_fb, _d, _stp, _tgt):
            _win = None; _xb = min(_N, _fb + _MHb) - 1
            for _k in range(_fb + 1, min(_N, _fb + _MHb)):
                _hk = _Hb[_k]; _lk = _Lb[_k]
                if _hk != _hk or _lk != _lk:
                    continue
                if _d == "l":
                    if _lk <= _stp: _win = False; _xb = _k; break
                    if _hk >= _tgt: _win = True;  _xb = _k; break
                else:
                    if _hk >= _stp: _win = False; _xb = _k; break
                    if _lk <= _tgt: _win = True;  _xb = _k; break
            _xp = _stp if _win is False else (_tgt if _win is True else _Cb[_xb])
            return _xb, _win, _xp

        _cands = []      # D版(三根止損+1.5R)
        _cands_a = []    # A版(g-1止損+布林軌外1W)
        for (_cf, _tp0, _bt0, _d) in _bbgaps:
            _Wb = _tp0 - _bt0
            if _Wb <= 0 or _cf < 2:
                continue
            _ep = _tp0
            # 進場棒(首次觸框 + 那附近有同向SS1)，A/D 共用；D版無布林外閘
            _fb = None
            for _j in range(_cf + 1, min(_N, _cf + 1 + _FRb)):
                _lj = _Lb[_j]; _hj = _Hb[_j]
                if _lj != _lj or _hj != _hj:
                    continue
                _touch = (_lj <= _ep * (1 - _BUFb)) if _d == "l" else (_hj >= _ep * (1 + _BUFb))
                if _touch:
                    _ssf = _ss1L if _d == "l" else _ss1S
                    if not any(_ssf[_k] for _k in range(max(0, _j - _SSWIN), _j + 1)):
                        break
                    _fb = _j
                    break
            if _fb is None:
                continue
            # ── D版：止損＝g-1/g-2/g-3 最低(多)/最高(空)、止盈＝1.5R（需 g-3=cf-4≥0）──
            if _cf >= 4:
                _stpD = min(_Lb[_cf-2], _Lb[_cf-3], _Lb[_cf-4]) if _d == "l" \
                        else max(_Hb[_cf-2], _Hb[_cf-3], _Hb[_cf-4])
                if not ((_d == "l" and _stpD >= _ep) or (_d == "s" and _stpD <= _ep)):
                    _tgtD = (_ep + 1.5*(_ep-_stpD)) if _d == "l" else (_ep - 1.5*(_stpD-_ep))
                    _xb, _win, _xp = _simx(_fb, _d, _stpD, _tgtD)
                    _cands.append((_fb, _xb, {"t": times_iso[_fb], "d": _d, "entry": _ep,
                                              "stop": _stpD, "tp": _tgtD, "win": _win,
                                              "xt": times_iso[_xb], "xp": _xp}))
            # ── A版：止損＝g-1、止盈＝布林軌外1W(1W=進場棒布林軌到g-1距離)──
            _g1 = _Lb[_cf-2] if _d == "l" else _Hb[_cf-2]
            _bandA = _BLb[_fb] if _d == "l" else _BUb[_fb]
            if _bandA == _bandA:                                   # 非 NaN
                _oneW = (_bandA - _g1) if _d == "l" else (_g1 - _bandA)
                _okstop = (_g1 < _ep) if _d == "l" else (_g1 > _ep)
                if _oneW > 0 and _okstop:
                    _tgtA = (_bandA + _oneW) if _d == "l" else (_bandA - _oneW)
                    if (_d == "l" and _tgtA > _ep) or (_d == "s" and _tgtA < _ep):
                        _xb, _win, _xp = _simx(_fb, _d, _g1, _tgtA)
                        _cands_a.append((_fb, _xb, {"t": times_iso[_fb], "d": _d, "entry": _ep,
                                                    "stop": _g1, "tp": _tgtA, "win": _win,
                                                    "xt": times_iso[_xb], "xp": _xp}))
        # busy 去重(逐方向、逐版本):一筆未出場前不開同向新單
        def _dedup(_cl):
            _cl.sort(key=lambda x: x[0])
            _out = []; _lastx = {"l": -1, "s": -1}
            for _fb, _xb, _rec in _cl:
                if _fb <= _lastx[_rec["d"]]:
                    continue
                _out.append(_rec); _lastx[_rec["d"]] = _xb
            return _out[-400:]
        # ── 中軌分側順勢版(M)：多=形成時整個FVG在中軌上、空=在中軌下；首觸即進(無SS1/布林閘)；
        #     止損=g與g-1兩根極值(多最低/空最高)；止盈=3W。分側只看FVG形成當下，之後價格跑到對側來填也算。
        _cands_m = []
        for (_cf, _tp0, _bt0, _d) in _bbgaps:
            _Wb = _tp0 - _bt0
            if _Wb <= 0 or _cf < 2:
                continue
            _m = _BMb[_cf - 1]                                  # 形成時(g棒)中軌
            if _m != _m:
                continue
            if (_d == "l" and _bt0 < _m) or (_d == "s" and _tp0 > _m):
                continue
            _ep = _tp0
            _fbm = None
            for _j in range(_cf + 1, min(_N, _cf + 1 + _FRb)):  # 首次觸框即進
                _lj = _Lb[_j]; _hj = _Hb[_j]
                if _lj != _lj or _hj != _hj:
                    continue
                if (_lj <= _ep) if _d == "l" else (_hj >= _ep):  # 影線碰邊即算(取消BUF),碰過作廢→只認首次
                    _fbm = _j; break
            if _fbm is None:
                continue
            _stpm = min(_Lb[_cf-1], _Lb[_cf-2]) if _d == "l" \
                    else max(_Hb[_cf-1], _Hb[_cf-2])
            if (_d == "l" and _stpm >= _ep) or (_d == "s" and _stpm <= _ep):
                continue
            _tgtm = (_ep + 4.0 * _Wb) if _d == "l" else (_ep - 4.0 * _Wb)  # 止盈4W(使用者要求看4W)
            _xb, _win, _xp = _simx(_fbm, _d, _stpm, _tgtm)
            _cands_m.append((_fbm, _xb, {"t": times_iso[_fbm], "d": _d, "entry": _ep,
                                         "stop": _stpm, "tp": _tgtm, "win": _win,
                                         "xt": times_iso[_xb], "xp": _xp}))
        _fvg_bb = _dedup(_cands)
        _fvg_bb_a = _dedup(_cands_a)
        _fvg_bb_m = _dedup(_cands_m)
    except Exception:
        _fvg_bb = []; _fvg_bb_a = []; _fvg_bb_m = []

    # ── FVG 進出場點（給主圖標記）──────────────────────────────────────────
    #   ⅓ 階梯版：三檔限價掛在缺口頂/中/底，影線觸及即成交；2W 止損 / 6W 止盈、抱到止損/止盈/超時。
    #   + 寬度上限 2%（濾掉抱久擋路的寬缺口）；+ 深檔拉近：三檔全成交(插到底)就把止盈改 2W 快跑。
    #   只為「視覺標記」，獨立於 _fvg_sigs（自動交易），出錯退空、不影響其他輸出。
    _fvg_trades = []
    try:
        _SMt, _TMt = 2.0, 6.0
        _Hn = highs.tolist(); _Ln = lows.tolist()   # .tolist() 比 [float(x) for x in ...] 快數倍
        _Nn = len(_Ln)
        for _wd in ("l", "s"):
            _gp = [g for g in _gaplist if g[3] == _wd]
            # 1) 每個缺口：三檔階梯成交 + 出場（不做 busy 判斷）
            _cands = []
            for (_cf, _tp0, _bt0, _d) in _gp:
                if _tp0 - _bt0 <= 0:
                    continue
                _W = _tp0 - _bt0; _mid = (_tp0 + _bt0) / 2.0
                _wr = _W / (_tp0 if _d == "l" else _bt0)          # 缺口寬度占價格比
                if _wr > 0.02:                                    # 寬度上限 2%：濾掉抱久擋路的超寬缺口
                    continue
                if _wr > 0.012:                                   # 過寬(1.2%~2%)：上框+中間兩檔、止損框−0.5W、止盈3W
                    _lv = [_tp0, _mid] if _d == "l" else [_mid, _bt0]   # 不掛最深檔(多:bot/空:top＝跑太兇那側)
                    _stp = (_bt0 - 0.5 * _W) if _d == "l" else (_tp0 + 0.5 * _W)  # 框−0.5W：同avgR但勝率26→34%、少被影線洗(2026-06-23同棒止損修正後重測)
                    _tp_far  = (_tp0 + 3.0 * _W) if _d == "l" else (_bt0 - 3.0 * _W)  # 3W：容量受限下幾乎=6W但命中率高、出場快、不堵小單
                    _tp_near = _tp_far                            # 過寬不做深檔拉近
                else:                                             # 正常窄缺口：三檔階梯 + 6W 止盈 + 深檔拉近 2W
                    _lv = [_tp0, _mid, _bt0]
                    _stp = (_bt0 - _SMt * _W) if _d == "l" else (_tp0 + _SMt * _W)
                    _tp_far  = (_tp0 + _TMt * _W) if _d == "l" else (_bt0 - _TMt * _W)
                    _tp_near = (_tp0 + 2.0 * _W) if _d == "l" else (_bt0 - 2.0 * _W)
                _tpx = _tp_far
                _deepbar = None                                   # 全成交(深檔拉近生效)的那根，給止盈價位線階梯用
                _fills = []; _filledlv = []; _res = None           # _fills=成交的K棒；_filledlv=實際成交的每一檔價(可一根多檔)
                _fe = _cf + 1 + _FRESH; _hi = min(_Nn, _cf + 1 + _FRESH + _MAXHOLD)
                for _j in range(_cf + 1, _hi):
                    _lj = _Ln[_j]; _hj = _Hn[_j]
                    if _lj != _lj or _hj != _hj:
                        continue
                    if _j <= _fe and _lv:                         # 新鮮度內 → 三檔影線觸及即成交
                        _hit = [x for x in _lv if (_lj <= x if _d == "l" else _hj >= x)]
                        if _hit:
                            _fills.append(_j)
                            _filledlv.extend(_hit)                # 一根同時穿多檔 → 全部記入(均價才正確)
                            _lv = [x for x in _lv if x not in _hit]
                            if not _lv:                           # 全檔成交(插到底) → 止盈拉近 2W 快跑
                                _tpx = _tp_near
                                if _deepbar is None: _deepbar = _j
                    if _fills:                                    # 已成交 → 檢查止損/止盈
                        # 止損：連『進場棒本身』一起算——同一根插進缺口又掃穿止損(一根突破fvg)＝當棒即止損，
                        #       不可漏算(原本 _j>_fills[0] 會把同棒止損藏掉→那筆變成拖到後面好點出場→回測虛高)。
                        if (_lj <= _stp) if _d == "l" else (_hj >= _stp): _res = ("loss", _j); break
                        # 止盈：保守起見須撐過進場棒之後才認列(同棒不認獲利，避免反向高估)。
                        if _j > _fills[0] and ((_hj >= _tpx) if _d == "l" else (_lj <= _tpx)): _res = ("win", _j); break
                    if _fills and _j >= _fills[0] + _MAXHOLD:     # 自首檔成交起算最長持有
                        break
                if not _fills:
                    continue
                _kind, _xb = _res if _res else ("live", min(_hi, _Nn) - 1)
                _cands.append({"ef": _fills[0], "xb": _xb, "d": _d, "kind": _kind, "fb": list(_fills),
                               "top": _tp0, "bot": _bt0, "sl": _stp, "tpf": _tp_far, "tpn": _tp_near,
                               "deep": _deepbar, "flv": list(_filledlv)})
            # 2) 依「進場時間」排序，貪婪選不重疊（一次一單）——修正原本用「形成時間」誤殺晚進場缺口的 bug
            #    + roll(⟳早平接刀)：持倉中價格往下碰到「下方的同向 FVG」(多:bot更低/空:top更高) →
            #      前一筆早平在新缺口進場棒、接刀進更深的同向缺口；同層/上方的新缺口仍「擋著不進」。
            #      （roll 只在深缺口落在原止損之上、價格還沒到止損就先碰到時才觸發，故天生稀少。）
            _cands.sort(key=lambda x: x["ef"])
            _busy = -1; _act = None; _act_ef = -1; _act_tp = None; _act_bt = None
            for _c in _cands:
                _ef = _c["ef"]; _xb = _c["xb"]; _d = _c["d"]
                if _act is not None and _ef < _busy:                 # 與持倉重疊
                    _below = (_c["bot"] < _act_bt) if _d == "l" else (_c["top"] > _act_tp)
                    if _ef > _act_ef and _below:                     # 價格碰到「下方(多)/上方(空)」同向缺口 → roll
                        _act["xt"] = times_iso[_ef]; _act["r"] = "roll"
                    else:                                            # 同層/上方 → 維持「擋著不進」
                        continue
                _flv = _c["flv"]
                _new = {"d": _d, "et": times_iso[_ef], "xt": times_iso[_xb],
                        "r": _c["kind"], "fills": [times_iso[b] for b in _c["fb"]],
                        "nfill": len(_flv),                                          # 實際成交檔數(可>len(fills))
                        "aentry": round(sum(_flv) / len(_flv), 8) if _flv else None, # 各檔均價(正確均價，給R/畫線用)
                        "top": round(_c["top"], 8), "bot": round(_c["bot"], 8),
                        "sl": round(_c["sl"], 8), "tpf": round(_c["tpf"], 8), "tpn": round(_c["tpn"], 8),
                        "tp2t": (times_iso[_c["deep"]] if _c["deep"] is not None else None)}
                _fvg_trades.append(_new)
                _act = _new; _act_ef = _ef; _act_tp = _c["top"]; _act_bt = _c["bot"]; _busy = _xb
        # 先依進場時間排序再截尾——否則「先全多單、後全空單」會被 [-N:] 截成只剩空單。
        _fvg_trades.sort(key=lambda x: x["et"])
        _fvg_trades = _fvg_trades[-600:]      # 上限 600：1h 約可回溯到去年底（200 只到 3 個月前）
    except Exception:
        _fvg_trades = []

    return {
        **mid_out,                # backward compat：mid 統計放在頂層
        "ss":   ss_out,           # SS 系列（獨立合計 + 敗後停手，不與 S 混）
        "band": band_out,         # 帶軌（short=BB 下軌、long=BB 上軌）統計
        "rr":   rr_out,           # 1:1 目標（止盈距離 = 止損距離）統計
        "long_only": long_only,   # 是否只算多單（台股=True）
        "from_date": from_date,
        "recent":   recent[-30:],
        "signals":  signals,
        "fvg":      _fvg,         # 失衡缺口（主圖色塊）
        "fvg_break": _fvg_break,  # 「破多/破空」結構轉破標記(跑 proto 缺口序列、標在 g)
        "fvg_ms":   _fvg_ms,      # 「多/空」方向標記(B 用 proto 缺口·g 收盤定緣、標在 g)
        "fvg_shun": _fvg_shun,    # 「順多/順空」：吃同向FVG後影線穿透既存反向FVG(順勢延續)
        "smc_sweep": _smc_sweep,  # SMC 掃頂/掃底(階段1：SR+SMC 教練移植)
        "smc_struct": _smc_struct, # SMC 結構事件 BOS/CHoCH 線段(階段2)
        "smc_ob":   _smc_ob,      # SMC 訂單區 OB 框(階段3)
        "smc_sr":   _smc_sr,      # SMC 支撐/阻力區(階段4)
        "vwap":     _vwap,        # VWAP 成交量加權均價(階段5)
        "channel":  _channel,     # 自動平行通道(階段5)
        "fvg_sigs": _fvg_sigs,    # FVG 收盤確認進場訊號（自動交易用，獨立於 signals）
        "fvg_trades": _fvg_trades,  # FVG「接1次」cascade 進出場點（主圖標記用）
        "fvg_bb":   _fvg_bb,        # D版(三根止損+1.5R)進出場點（研究用主圖標記）
        "fvg_bb_a": _fvg_bb_a,      # A版(g-1止損+布林軌外1W)進出場點（同場對比）
        "fvg_bb_m": _fvg_bb_m,      # M版(中軌分側順勢+止損g/g-1+止盈3W)進出場點
    }
