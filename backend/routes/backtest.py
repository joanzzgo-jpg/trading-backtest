"""回測 API 路由

目前只提供 CRT 訊號回測（S1~S12）。原「通用技術策略」（均線/RSI/MACD…）那套
向量化引擎已於前端移除入口後一併清除（commit「回測面板僅留 CRT」）；若日後要復活，
需連同 backtest/engine.py、strategies/builtin.py、routes/strategies.py 一起重建，
並修掉當年的 NaN→None 序列化與做空帳務兩個 bug。
"""
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["backtest"])


def _dur_secs(t_iso, ot_iso):
    """兩個 ISO 時間戳的秒差（進場→結算）；任一缺失/解析失敗回 None。"""
    if not t_iso or not ot_iso:
        return None
    try:
        return (datetime.fromisoformat(ot_iso) - datetime.fromisoformat(t_iso)).total_seconds()
    except (ValueError, TypeError):
        return None


# ══════════════════════════════════════════════════════════════
#  CRT 訊號回測（S1~S12）— 重用勝率引擎已算好的 signals，做資金曲線/績效
# ══════════════════════════════════════════════════════════════
class CrtBacktestRequest(BaseModel):
    market: str
    symbol: str
    timeframe: str = "1d"
    exchange: str = "pionex"
    signal: str = "all"        # abc / ab / s3~s12 / all(=S2~S11 合計) / all11(=S1~S11 合計)；合計皆去重
    direction: str = "both"    # short / long / both
    target: str = "mid"        # mid / band（rr 倍數以 mid 預估值為準，band 為近似）
    stop_buffer_pct: float = 0.0
    initial_capital: float = 100_000   # 本金（使用者決定多少錢）
    risk_pct: float = 0.02     # 每筆交易風險佔資金比例（輸/止損 = -1R）
    tp_mode: str = "real"      # 止盈基準：real=已實現(動態目標,勝負/盈虧比皆用實際出場,含號)
                               #          est =預計止盈(進場固定目標,勝負=有沒有到est目標、盈虧比=預估值恆正)
    lookback_days: int = 0     # 回測期間（往前回測多久；0=全部可用歷史）
    one_position: bool = False # True=一次一筆（直到上一筆結算才接下一個訊號；跳過重疊）
    stop_after_loss: bool = False  # True=敗後停手（逐方向：輸了停手、旁觀同向到紙上會贏或反向訊號才回場；SS 套同根K放行新規則；已內含一次一筆＝持倉中不接單，比照實盤）
    finmind_token: str = ""


# UI 的 signal key（s3..）↔ signal record 的 k（"3"..）；abc/ab 同名
_CRT_AGG   = {"ab", "3", "4", "5", "6", "7", "8", "9", "10", "11"}          # all：S2~S11（與總勝率口徑一致）
_CRT_AGG11 = {"abc", "ab", "3", "4", "5", "6", "7", "8", "9", "10", "11"}   # all11：S1~S11（多含 S1/ABC）
_SS_AGG    = {"ss1", "ss2"}                                                  # ssall：SS 系列合計（軌道反轉，獨立於 S）
_AGG_SETS  = {"all": _CRT_AGG, "all11": _CRT_AGG11, "ssall": _SS_AGG}


def _filter_stop_after_loss(picked, rkey, otkey, one_pos=True):
    """敗後停手：依訊號棒時間 t 跑逐方向狀態機，回「實際會進場」的子集。
    與圖表 crt._calc_stop_strategy / _ss_stop_strategy 同邏輯：某方向進場中遇敗→停手、
    旁觀同向直到紙上會贏或出現反方向訊號才回場。SS 另套『被停損出場那根 K 又有同向
    SS 訊號（出場棒==訊號棒）→放行』新規則。picked 內皆已結算（rkey∈w/l）。
    one_pos=True（預設）：再疊「一次一筆」——前筆未結算（持倉中）期間出現的訊號『不進場、
    也不計入停手輸贏』（沒實際下單就沒輸贏），比照實盤同標的同時只持一倉。"""
    active  = {"s": True, "l": True}
    stop_ot = {"s": None, "l": None}   # 讓該方向停手的那筆敗單「止損出場棒」
    busy_until = ""                    # one_pos：目前持倉的結算時間(ISO，全域一倉)；空＝無持倉
    taken = []
    for s in sorted(picked, key=lambda x: x.get("t") or ""):
        d = s.get("d")
        if d not in ("s", "l"):
            continue
        ent = s.get("t") or ""
        if one_pos and busy_until and ent < busy_until:
            continue                               # 持倉中 → 完全略過（開不了倉，不進場/不回穩/不解除反向）
        is_ss = s.get("k") in ("ss1", "ss2")
        # SS 新規則：被停損出場的那根 K，同時又冒出同向 SS 訊號 → 視同回場、放行
        if is_ss and not active[d] and stop_ot[d] is not None and str(s.get("t")) == str(stop_ot[d]):
            active[d] = True
        if active[d]:
            taken.append(s)
            if one_pos:
                busy_until = s.get(otkey) or ent   # 開倉 → 鎖到此筆結算為止
            if s.get(rkey) != "w":
                active[d] = False                  # 遇敗 → 該方向停手
                stop_ot[d] = s.get(otkey)          # 記下止損出場棒（供 SS 新規則比對）
        elif s.get(rkey) == "w":
            active[d] = True                       # 停手中、同向紙上會贏 → 回場
        active["l" if d == "s" else "s"] = True    # 反向訊號出現 → 解除反向停手
    return taken


def _fmt_dur(seconds: float) -> str:
    """秒數 → 人類可讀（天/時/分）。"""
    if seconds is None or seconds < 0:
        return "—"
    d = seconds / 86400
    if d >= 1:
        return f"{d:.1f}天"
    h = seconds / 3600
    if h >= 1:
        return f"{h:.1f}時"
    return f"{seconds / 60:.0f}分"


def _simulate(picked, rkey, rrkey, est_key, otkey, init_cap, risk_pct, tp_mode, from_date):
    """跑一遍資金模擬：定額風險、單利——每筆風險金額固定 = 初始本金 × risk_pct（不複利）。
    止盈基準 tp_mode：
      real：已實現——勝負依「已實現 rr>0」、盈虧比＝實際出場(動態目標,含號)。
      est ：預計止盈——勝負依「有沒有到進場固定目標」(est_r)、盈虧比＝預估值(恆正)；
            無 est 的訊號(如 abc)退回已實現。
    回傳 (stats, trades, equity)。"""
    def _score(s):
        """回傳 (trade_r, win)。"""
        if tp_mode == "est":
            est = s.get(est_key)
            if est in ("w", "l"):
                win = est == "w"
                return (float(s.get("rr") or 1.0) if win else -1.0), win
            # 無 est（abc 等）→ 退回已實現
        realized = s.get(rrkey)
        if realized is None:
            realized = float(s.get("rr") or 1.0) if s.get(rkey) == "w" else -1.0
        return float(realized), float(realized) > 0

    cap = float(init_cap)
    risk_amt = float(init_cap) * risk_pct   # 單利：每筆固定金額（1R），以初始本金計、不複利
    trades, equity = [], []
    if picked:
        equity.append({"time": picked[0].get("t"), "equity": round(cap, 2)})
    wins = losses = 0
    gross_win = gross_loss = 0.0
    r_sum = 0.0
    peak = cap
    max_dd = 0.0
    use_fracs = []     # 資金用量：每筆部位佔資金比例（風險% ÷ 風險距離%）
    hold_secs = []     # 持倉時間：進場→結算秒數
    for s in picked:
        trade_r, win = _score(s)   # 依 tp_mode 取勝負與盈虧比（real=已實現／est=預計止盈）
        rr = trade_r               # 顯示用：該筆盈虧比（real 含號／est 恆正）
        pnl = risk_amt * trade_r
        cap += pnl
        if win:
            wins += 1; gross_win += pnl
        else:
            losses += 1; gross_loss += abs(pnl)
        r_sum += trade_r
        peak = max(peak, cap)
        if peak > 0:
            max_dd = min(max_dd, (cap - peak) / peak)

        # 資金用量：部位/資金 = 風險% ÷ (|進場-止損|/進場)。止損越近 → 部位（名目）越大
        use_frac = None
        entry_px = s.get("entry"); stop_px = s.get("stop")
        if entry_px and stop_px and entry_px > 0:
            risk_frac = abs(entry_px - stop_px) / entry_px
            if risk_frac > 1e-9:
                use_frac = risk_pct / risk_frac
                use_fracs.append(use_frac)
        hold = _dur_secs(s.get("t"), s.get(otkey))
        if hold is not None:
            hold_secs.append(hold)

        trades.append({
            "time": s.get("t"), "exit": s.get(otkey),
            "dir": s.get("d"), "sig": s.get("k"),
            "result": "win" if win else "loss",
            "rr": round(rr, 2), "pnl": round(pnl, 2), "equity": round(cap, 2),
            "use": round(use_frac * 100, 1) if use_frac is not None else None,   # 該筆資金用量 %
            "hold": _fmt_dur(hold),                                              # 該筆持倉時間
        })
        equity.append({"time": s.get(otkey) or s.get("t"), "equity": round(cap, 2)})

    total = wins + losses
    span_secs = None
    if picked:
        span_secs = _dur_secs(picked[0].get("t"), picked[-1].get(otkey) or picked[-1].get("t"))
    stats = {
        "total_trades": total,
        "wins": wins, "losses": losses,
        "win_rate":     round(wins / total * 100, 1) if total else 0,
        "total_return": round((cap - init_cap) / init_cap * 100, 2),
        "final_equity": round(cap, 2),
        "max_drawdown": round(abs(max_dd) * 100, 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else (999.0 if gross_win > 0 else 0),
        "avg_r":  round(r_sum / total, 3) if total else 0,
        "net_r":  round(r_sum, 2),
        # 資金用量（部位佔資金 %）：平均 / 峰值；峰值 >100% 代表該筆需用到槓桿
        "avg_use":  round(sum(use_fracs) / len(use_fracs) * 100, 1) if use_fracs else None,
        "max_use":  round(max(use_fracs) * 100, 1) if use_fracs else None,
        # 持倉時間：平均 / 最長（人類可讀字串）
        "avg_hold": _fmt_dur(sum(hold_secs) / len(hold_secs)) if hold_secs else "—",
        "max_hold": _fmt_dur(max(hold_secs)) if hold_secs else "—",
        "span":     _fmt_dur(span_secs),
        "from_date": from_date,
    }
    return stats, trades, equity


@router.post("/crt_backtest")
def run_crt_backtest(req: CrtBacktestRequest):
    """用 CRT 訊號(S1~S12) 的勝負序列 + 每筆預估盈虧比(rr) 模擬資金曲線。
    重用 /api/crt_winrate 的計算（已深歷史 + 1hr 快取），不另抓資料。"""
    from routes.data import get_crt_winrate
    try:
        wr = get_crt_winrate(
            market=req.market, symbol=req.symbol, timeframe=req.timeframe,
            exchange=req.exchange, stop_buffer_pct=req.stop_buffer_pct,
            finmind_token=req.finmind_token,
        )
    except Exception as e:
        raise HTTPException(400, f"勝率計算失敗: {e}")

    sigs = (wr or {}).get("signals") or []
    rkey   = "r_b"       if req.target == "band" else "r"
    otkey  = "ot_b"      if req.target == "band" else "ot"
    rrkey  = "rr_b_real" if req.target == "band" else "rr_real"   # 已實現盈虧比（含號）
    estkey = "est_r_b"   if req.target == "band" else "est_r"     # 預計止盈：固定目標勝負
    tp_mode = req.tp_mode if req.tp_mode in ("real", "est") else "real"

    want = req.signal
    if want.startswith("s") and want[1:].isdigit():
        want = want[1:]          # s3 → 3

    agg_set = _AGG_SETS.get(req.signal)   # all / all11 → 對應合計集合；單一訊號為 None

    def _match(s):
        k = s.get("k")
        if agg_set is not None:
            if k not in agg_set:
                return False
        elif k != want:
            return False
        d = s.get("d")
        if req.direction == "short" and d != "s":
            return False
        if req.direction == "long" and d != "l":
            return False
        return s.get(rkey) in ("w", "l")   # 只取已結算

    picked = [s for s in sigs if _match(s)]
    picked.sort(key=lambda s: s.get(otkey) or s.get("t") or "")

    # 合計（all / all11）：同一根 K(同 t,d) 可能多訊號重疊 → 去重，與總勝率口徑一致
    if agg_set is not None:
        seen = set(); dedup = []
        for s in picked:
            key = (s.get("t"), s.get("d"))
            if key in seen:
                continue
            seen.add(key); dedup.append(s)
        picked = dedup

    # 回測期間：只取進場時間 ≥ 現在往前推 lookback_days 的訊號（0=全部）。
    # 用「滾動時間窗」（精確到秒）而非整天截斷 → 近24小時(=1天)/近1週 等短窗才準。
    # ISO 字串同格式 → 字典序＝時間序，可直接比較。
    lookback = max(0, int(req.lookback_days or 0))
    if lookback > 0:
        cutoff = (datetime.now() - timedelta(days=lookback)).replace(microsecond=0).isoformat()
        picked = [s for s in picked if (s.get("t") or "") >= cutoff]

    # 一次一筆：直到上一筆結算（otkey）才接受下一個「進場時間 ≥ 前筆結算時間」的訊號，
    # 持倉期間出現的訊號全部跳過。依進場時間順序貪婪挑選。
    n_all = len(picked)
    if req.stop_after_loss and picked:
        # 敗後停手（已內含「一次一筆」，比照實盤）：逐方向停手狀態機 + 持倉中不接單，篩出實際會進場的訊號
        picked = _filter_stop_after_loss(picked, rkey, otkey)
        picked.sort(key=lambda s: s.get(otkey) or s.get("t") or "")
    elif req.one_position and picked:
        by_entry = sorted(picked, key=lambda s: (s.get("t") or "", s.get(otkey) or ""))
        kept = []
        busy_until = ""   # 目前持倉的結算時間（ISO）；空＝無持倉
        for s in by_entry:
            ent = s.get("t") or ""
            if ent >= busy_until:            # 無持倉 or 此筆在前筆結算後才進場
                kept.append(s)
                busy_until = s.get(otkey) or ent
        picked = sorted(kept, key=lambda s: s.get(otkey) or s.get("t") or "")

    risk_pct = max(0.001, min(1.0, float(req.risk_pct or 0.02)))
    # from_date 用實際首筆交易日（比資料起始日更精準；回測期間有限縮時也對得上）
    from_date = (picked[0].get("t") or "")[:10] if picked else (wr or {}).get("from_date")

    stats, trades, equity = _simulate(picked, rkey, rrkey, estkey, otkey, req.initial_capital, risk_pct, tp_mode, from_date)

    return {
        "stats":        stats,
        "trades":       trades,
        "equity_curve": equity,
        "tp_mode":      tp_mode,
        "entry_rule":   "stop" if req.stop_after_loss else ("single" if req.one_position else "all"),
        "n_all":        n_all,             # 該條件/期間內的全部訊號數
        "n_taken":      len(picked),       # 實際納入回測的筆數（一次一筆會少於 n_all）
    }
