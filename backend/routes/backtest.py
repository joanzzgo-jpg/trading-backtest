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
    target: str = "mid"        # mid / band / band80 / band98（止盈目標位：中軌 / 上下軌 / 下↔上 80% / 98%）
    stop_buffer_pct: float = 0.0
    initial_capital: float = 100_000   # 本金（使用者決定多少錢）
    risk_pct: float = 0.02     # 每筆交易風險佔資金比例（輸/止損 = -1R）
    tp_mode: str = "real"      # 止盈基準：real=已實現(動態目標,勝負/盈虧比皆用實際出場,含號)
                               #          est =預計止盈(進場固定目標,勝負=有沒有到est目標、盈虧比=預估值恆正)
    lookback_days: int = 0     # 回測期間（往前回測多久；0=全部可用歷史）
    one_position: bool = False # True=一次一筆（直到上一筆結算才接下一個訊號；跳過重疊）
    stop_after_loss: bool = False  # True=敗後停手（逐方向：輸了停手、旁觀同向到紙上會贏或反向訊號才回場；SS 套同根K放行新規則；已內含一次一筆＝持倉中不接單，比照實盤）
    pyramid: bool = False      # True=加倉（同向訊號持倉中再現就加倉，合併均價、單一停損=最新筆、止盈走上下軌動態目標；獨立模式）
    max_adds: int = 5          # 加倉上限筆數（含首筆；超過則略過不加）
    max_use_cap: float = 0     # 自動最佳化：資金用量峰值上限%（0=不限；如 100=只列免槓桿組合）
    fee_pct: float = 0.0       # 手續費（單邊小數，0.0005=0.05%；進出各收一次）→ 真實淨損益
    leverage: float = 0.0      # 槓桿上限倍數（0=不限；如 10=部位最多 10×本金，超過的吃不下→該筆等比縮小）
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


def _simulate(picked, rkey, rrkey, est_key, otkey, init_cap, risk_pct, tp_mode, from_date,
              fee_pct=0.0, leverage=0.0):
    """跑一遍資金模擬：定額風險、單利——每筆風險金額固定 = 初始本金 × risk_pct（不複利）。
    止盈基準 tp_mode：
      real：已實現——勝負依「已實現 rr>0」、盈虧比＝實際出場(動態目標,含號)。
      est ：預計止盈——勝負依「有沒有到進場固定目標」(est_r)、盈虧比＝預估值(恆正)；
            無 est 的訊號(如 abc)退回已實現。
    真實化：
      leverage>0：部位佔資金(use_frac=風險%÷風險距%)超過槓桿上限的部分『吃不下』→ 該筆等比縮小
                 (實際 R 與盈虧同步縮)，max_use 也被壓到 ≤ leverage，貼近實盤能下的單。
      fee_pct>0 ：每筆進出各收一次手續費(名目×fee_pct×2)，從淨損益扣 → 高頻策略才看得出真實侵蝕。
    勝負(win_rate)仍以『策略有沒有到目標』計；報酬/PF/淨R/回撤皆為扣費+槓桿縮放後的真實值。
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
    use_fracs = []     # 資金用量：每筆部位佔資金比例（槓桿縮放後的實際 eff_frac）
    hold_secs = []     # 持倉時間：進場→結算秒數
    fee_pct = max(0.0, float(fee_pct or 0.0))
    lev = max(0.0, float(leverage or 0.0))      # 0 = 不限槓桿
    fees_total = 0.0; capped_n = 0
    for s in picked:
        trade_r, win = _score(s)   # 策略勝負 + 毛盈虧比（尚未含費/槓桿縮放）
        # 部位/槓桿：use_frac = 部位佔資金 = 風險% ÷ 風險距%。lev>0 時超過上限的部分吃不下 → 該筆等比縮小。
        use_frac = None; eff_frac = None
        entry_px = s.get("entry"); stop_px = s.get("stop")
        if entry_px and stop_px and entry_px > 0:
            risk_frac = abs(entry_px - stop_px) / entry_px
            if risk_frac > 1e-9:
                # 部位＝風險% ÷（停損距% ＋ 來回手續費）→ 手續費算進倉位(同自動交易「止損算槓桿」)，
                # 不含費時退回純停損距。lev>0 時超過上限的部分吃不下 → 該筆等比縮小。
                use_frac = risk_pct / (risk_frac + 2.0 * fee_pct)
                eff_frac = min(use_frac, lev) if lev > 0 else use_frac
        scale = (eff_frac / use_frac) if (use_frac and eff_frac is not None and use_frac > 0) else 1.0
        if scale < 0.999:
            capped_n += 1
        notional = (eff_frac if eff_frac is not None else (use_frac or 0.0)) * float(init_cap)
        fee = 2.0 * fee_pct * notional            # 進出各收一次
        fees_total += fee
        pnl = risk_amt * trade_r * scale - fee     # 淨損益（含槓桿縮放 + 手續費）
        net_r = (pnl / risk_amt) if risk_amt > 0 else 0.0   # 淨 R
        cap += pnl
        if win:
            wins += 1
        else:
            losses += 1
        if pnl >= 0:
            gross_win += pnl
        else:
            gross_loss += -pnl
        r_sum += net_r
        peak = max(peak, cap)
        if peak > 0:
            max_dd = min(max_dd, (cap - peak) / peak)
        if eff_frac is not None:
            use_fracs.append(eff_frac)
        hold = _dur_secs(s.get("t"), s.get(otkey))
        if hold is not None:
            hold_secs.append(hold)

        trades.append({
            "time": s.get("t"), "exit": s.get(otkey),
            "dir": s.get("d"), "sig": s.get("k"),
            "result": "win" if win else "loss",
            "rr": round(net_r, 2), "pnl": round(pnl, 2), "equity": round(cap, 2),
            "use": round(eff_frac * 100, 1) if eff_frac is not None else None,   # 該筆資金用量 %（已套槓桿上限）
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
        # 真實化資訊：總手續費、被槓桿上限縮小的筆數（讓使用者知道扣了多少費 / 有幾筆吃不滿）
        "fees_total": round(fees_total, 2) if fee_pct > 0 else None,
        "capped_n":   capped_n if lev > 0 else None,
        "leverage":   lev if lev > 0 else None,
    }
    return stats, trades, equity


def _build_pyramid_clusters(bars: dict, picked: list, max_adds: int, target: str = "band", tp_mode: str = "real"):
    """加倉（金字塔）模擬：把同向、持倉中重疊的訊號合併成一個『加倉群』，重走 K 棒結算。
    規則（方案 B，合併均價／單一停損）：
      • 加倉：某方向可進場時，第一筆開倉；倉位還活著（未碰共用停損/止盈）期間再出現同向訊號 → 加一筆，
        到 max_adds 為止（超過略過不加）。反向訊號只解除反向『敗後停手』、不動現有倉（單向不能反手）。
      • 均價：等量加倉 → 進場價 = 各加倉價算術平均。
      • 共用停損 S：每次加倉後移到『最新那筆的停損』（順勢收緊）。
      • 共用止盈 T：上下軌動態目標（空→下軌 bb_lower、多→上軌 bb_upper）。
      • 重走 K 棒：從首筆進場棒往後逐棒掃，部位數量隨加倉 +1、同步更新均價與 S；先碰 T→全倉止盈、
        先碰 S→全倉止損、同根都碰用收盤價判（沿用 crt 保守規則）；NaN 軌道棒整根跳過。
      • 盈虧（R）：每單位風險=|均價−S|=1R，N=加倉筆數 → 止盈群組 = N×(|T−均價|/|均價−S|) R、止損 = −N R。
      • 敗後停手：群組淨虧（碰 S）→ 該方向停手；淨賺（碰 T）不停手。停手期間同向訊號用其自身 r_b 當
        『紙上會不會贏』判回場；反向訊號解除反向停手。
    回傳『加倉群』list（每群一個 dict，欄位相容 _simulate：t/ot/d/k/entry/stop/r/rr_real）。
    """
    if not bars or not picked:
        return []
    from utils.crt import _SCAN_MAX_HOLD
    import math as _m
    times = bars.get("time") or []
    n = len(times)
    if n == 0:
        return []
    highs = bars.get("high") or []
    lows  = bars.get("low")  or []
    closes = bars.get("close") or []
    bbu = bars.get("bb_upper") or []
    bbl = bars.get("bb_lower") or []
    bbm = bars.get("bb_middle") or []
    t2i = {t: i for i, t in enumerate(times)}   # 訊號棒時間 → 棒索引（首筆出現為準）

    def _nan(x):
        return x is None or (isinstance(x, float) and _m.isnan(x))

    _ratio = _BAND_RATIO.get(target, (None, None))[0]   # 比例軌→0.8/0.98；mid/band→None
    def _tval(direction, j):
        """第 j 棒、此方向的止盈目標價（依所選目標 mid/band/比例軌）。缺軌→None。
        target=mid→中軌；band→多上軌/空下軌；比例軌→下軌+ratio×寬(多)、下軌+(1−ratio)×寬(空,鏡像)。"""
        if target == "mid":
            m = bbm[j] if j < len(bbm) else None
            return None if _nan(m) else m
        u = bbu[j] if j < len(bbu) else None
        dn = bbl[j] if j < len(bbl) else None
        if _nan(u) or _nan(dn):
            return None
        if _ratio is None:                              # band：多→上軌、空→下軌
            return u if direction == "l" else dn
        w = u - dn
        return (dn + _ratio * w) if direction == "l" else (dn + (1.0 - _ratio) * w)

    # 進場棒索引：訊號棒(t) 的下一根開盤（與 crt entry_i = 訊號 i + 1 一致）
    cand = []
    for s in picked:
        d = s.get("d")
        if d not in ("s", "l"):
            continue
        si = t2i.get(s.get("t"))
        if si is None:
            continue
        ei = si + 1
        if ei >= n:
            continue
        ent = s.get("entry")
        if ent is None or _nan(ent):
            continue
        cand.append({"d": d, "ei": ei, "entry": float(ent), "stop": float(s.get("stop")),
                     "t": s.get("t"), "k": s.get("k"), "rb": s.get("r_b")})
    cand.sort(key=lambda x: x["ei"])

    def _scan_exit(direction, avg_entry, shop, from_i, to_i, tp_fix=None):
        """從 from_i 掃到 to_i-1，回 (exit_idx, result, exit_px)；result∈win/loss；無出場回 (None,None,None)。
        止盈目標：tp_fix!=None→固定(預計止盈/est)；否則逐棒動態(_tval，已實現/real)。止損=shop(共用)；
        同根都碰用收盤判；動態時 NaN 軌道棒整根跳過（與 crt _scan 一致）。"""
        end = min(to_i, n)
        for j in range(from_i, end):
            tgt = tp_fix if tp_fix is not None else _tval(direction, j)
            if tgt is None or _nan(tgt):
                continue                          # 無軌道目標的棒：止損也跳過（與 crt _scan NaN 行為一致）
            hi = highs[j]; lo = lows[j]
            if direction == "s":
                hit_stop = (not _nan(hi)) and hi >= shop
                hit_tgt  = (not _nan(lo)) and lo <= tgt
            else:
                hit_stop = (not _nan(lo)) and lo <= shop
                hit_tgt  = (not _nan(hi)) and hi >= tgt
            if hit_stop and hit_tgt:
                cl = closes[j]
                if direction == "s":
                    win = (not _nan(cl)) and cl <= tgt
                else:
                    win = (not _nan(cl)) and cl >= tgt
                return j, ("win" if win else "loss"), (tgt if win else shop)
            if hit_stop:
                return j, "loss", shop
            if hit_tgt:
                return j, "win", tgt
        return None, None, None

    clusters = []
    active = {"s": True, "l": True}
    cur = None   # 現開倉群：{d, tranches:[cand...], scan_i, end_cap}

    def _finalize(cl, exit_idx, result, exit_px):
        """把一個加倉群結算成 _simulate 相容的 dict，並回傳是否淨虧（供敗後停手）。"""
        N = len(cl["tranches"])
        avg = sum(x["entry"] for x in cl["tranches"]) / N
        shop = cl["tranches"][-1]["stop"]            # 共用停損 = 最新筆
        risk = abs(avg - shop)
        d = cl["d"]; k0 = cl["tranches"][0]["k"]
        if result == "win" and risk > 1e-12:
            # 帶號：上下軌動態目標會漂到進場均價的錯邊（多單軌跌破均價／空單軌漲過均價）→ 雖判 win
            # 但實際在均價錯邊出場＝虧損 → rew 為負。比照 crt._rr_real，不可用 abs() 把虧損號吃掉
            # （舊 bug：加倉一律算正報酬 → 與敗後停手走的 realized 路徑一賺一賠、差很多）。封頂 ±10 防 outlier。
            rew = (exit_px - avg) if d == "l" else (avg - exit_px)
            ratio = max(-10.0, min(rew / risk, 10.0))
            group_r = round(N * ratio, 3)
        else:
            group_r = float(-N)                       # 止損：加幾筆賠幾倍
        clusters.append({
            "t": cl["tranches"][0]["t"], "ot": times[exit_idx] if 0 <= exit_idx < n else None,
            "d": d, "k": (k0 if N == 1 else f"{k0}×{N}"),
            "entry": round(avg, 8), "stop": round(shop, 8),
            "r": "w" if group_r > 0 else "l",
            "rr_real": group_r,
        })
        return group_r <= 0

    for s in cand:
        d = s["d"]; ei = s["ei"]
        # 先把現有開倉群推進到此訊號進場棒前，看是否已先出場
        if cur is not None:
            exit_idx, result, exit_px = _scan_exit(
                cur["d"], None, cur["tranches"][-1]["stop"], cur["scan_i"], min(ei, cur["end_cap"]),
                cur.get("tp_fix"))
            if exit_idx is not None:                  # 群在加倉前就出場 → 結算
                lost = _finalize(cur, exit_idx, result, exit_px)
                if lost:
                    active[cur["d"]] = False
                cur = None
            elif ei >= cur["end_cap"]:                # 持倉已逾上限仍未出場 → 視為未結算丟棄（不計、不停手）
                cur = None
        # 同方向、且群還開著 → 嘗試加倉
        if cur is not None and cur["d"] == d:
            if len(cur["tranches"]) < max(1, int(max_adds)):
                cur["tranches"].append(s)
                cur["scan_i"] = ei                    # 之後從此棒續掃（停損已換最新筆）
            continue                                  # 超過上限：略過不加（不另開群）
        # 反向訊號：解除反向停手；現有反向群續開（單向不能反手）
        if cur is not None and cur["d"] != d:
            active["l" if d == "s" else "s"] = True
            continue
        # 無開倉群 → 視敗後停手決定開新群
        if active.get(d, True):
            # 預計止盈(est)：止盈目標固定在「首筆進場棒」的目標價（不隨棒漂移）；已實現(real)→逐棒動態(None)
            _tf = _tval(d, ei) if tp_mode == "est" else None
            cur = {"d": d, "tranches": [s], "scan_i": ei, "end_cap": ei + _SCAN_MAX_HOLD, "tp_fix": _tf}
        elif s.get("rb") == "w":
            active[d] = True                          # 停手中、同向紙上會贏 → 回場（此筆不開、下一筆才開）
        active["l" if d == "s" else "s"] = True        # 反向停手解除

    if cur is not None:                                # 收尾：最後一個群掃到底
        exit_idx, result, exit_px = _scan_exit(
            cur["d"], None, cur["tranches"][-1]["stop"], cur["scan_i"], cur["end_cap"], cur.get("tp_fix"))
        if exit_idx is not None:
            _finalize(cur, exit_idx, result, exit_px)   # 未結算（掃不到出場）→ 丟棄（同單筆未結算不計）

    clusters.sort(key=lambda c: c.get("ot") or c.get("t") or "")
    return clusters


# 比例軌目標 → (ratio, 欄位後綴)。下軌↔上軌的 ratio 處止盈（多靠上軌、空鏡像靠下軌）。
# band98=0.98 與自動交易 _AUTO_TP_BAND_RATIO 一致 → 回測貼合實盤止盈。
_BAND_RATIO = {"band80": (0.8, "80"), "band98": (0.98, "98")}


def _inject_band_ratio(bars: dict, sigs: list, ratio: float, sfx: str):
    """比例軌止盈：重走 K 棒，把每筆訊號對「下軌↔上軌 ratio 處」目標的勝負/出場/RR 注入 sig（就地，傳入須為副本）。
    目標（逐棒動態）：多＝下軌+ratio×(上軌−下軌)；空＝下軌+(1−ratio)×(上軌−下軌)（＝上軌往下 ratio 處，鏡像）。
    sfx＝欄位後綴（"80"→8成軌、"98"→98%軌…）→ 寫入 r{sfx}/ot{sfx}/rr{sfx}_real/est_r{sfx}；並覆寫該副本
    rr(=此比例軌預估RR，供 _simulate 預計止盈模式的勝場倍數用)。重用 crt 向量化掃描，NaN 軌道棒整根跳過。"""
    if not bars or not sigs:
        return
    import numpy as np
    from utils.crt import _scan_outcome_np, _scan_outcome_fixed
    kr, kot, krr, kest = f"r{sfx}", f"ot{sfx}", f"rr{sfx}_real", f"est_r{sfx}"
    times = bars.get("time") or []
    n = len(times)
    if n == 0:
        return
    H = np.asarray(bars.get("high")  or [], dtype=float)
    L = np.asarray(bars.get("low")   or [], dtype=float)
    C = np.asarray(bars.get("close") or [], dtype=float)
    U = np.asarray(bars.get("bb_upper") or [], dtype=float)
    Dn = np.asarray(bars.get("bb_lower") or [], dtype=float)
    if min(len(H), len(L), len(C), len(U), len(Dn)) < n:
        return
    width = U - Dn
    tgt_long  = Dn + ratio * width             # 多：下軌 → 上軌 ratio
    tgt_short = Dn + (1.0 - ratio) * width      # 空：上軌 → 下軌 ratio（鏡像）
    t2i = {t: i for i, t in enumerate(times)}
    for s in sigs:
        si = t2i.get(s.get("t"))
        ent = s.get("entry")
        s[kr] = None; s[kot] = None; s[krr] = None; s[kest] = None
        if si is None or ent is None:
            continue
        ei = si + 1
        if ei >= n:
            continue
        direction = "short" if s.get("d") == "s" else "long"
        tgt = tgt_short if direction == "short" else tgt_long
        stop = float(s.get("stop"))
        ent = float(ent)
        risk = abs(ent - stop)
        # 動態目標（已實現）
        res, ot, xi = _scan_outcome_np(H, L, C, tgt, times, ei, n, stop, direction)
        s[kr] = "w" if res == "win" else ("l" if res == "loss" else None)
        s[kot] = ot
        if res == "loss":
            s[krr] = -1.0
        elif res == "win" and xi is not None and 0 <= xi < n and risk > 1e-9 and not np.isnan(tgt[xi]):
            rew = (tgt[xi] - ent) if direction == "long" else (ent - tgt[xi])
            s[krr] = round(max(-10.0, min(float(rew) / risk, 10.0)), 3)   # 帶號 + 封頂 ±10（同 _rr_real）
        # 固定目標（預計止盈）＋ 預估 RR
        tfix = tgt[ei]
        if not np.isnan(tfix):
            o = _scan_outcome_fixed(H, L, C, ei, n, stop, float(tfix), direction)
            s[kest] = "w" if o == "win" else ("l" if o == "loss" else None)
            if risk > 1e-9:
                s["rr"] = round(min(abs(ent - float(tfix)) / risk, 10.0), 3)   # 覆寫副本：此比例軌預估 RR（_simulate est 用）；封頂 10 同 _rr_at


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
            with_bars=req.pyramid or req.target in _BAND_RATIO,   # 加倉/比例軌要重走 K 棒 → 附帶 K 棒陣列
        )
    except Exception as e:
        raise HTTPException(400, f"勝率計算失敗: {e}")

    sigs = (wr or {}).get("signals") or []
    bars = (wr or {}).get("_bars")
    # 比例軌（8成/98%…）：下軌↔上軌 ratio 處止盈。crt 沒預算此目標 → 用 with_bars 的 K 棒即時重走，
    # 注入 r{sfx}/ot{sfx}/rr{sfx}_real/est_r{sfx}（在副本上，勿污染勝率快取）。加倉模式由 cluster 自行算目標。
    if req.target in _BAND_RATIO and not req.pyramid:
        ratio, sfx = _BAND_RATIO[req.target]
        sigs = [dict(s) for s in sigs]
        _inject_band_ratio(bars, sigs, ratio, sfx)
    return _compute_backtest(req, sigs, bars, (wr or {}).get("from_date"))


def _compute_backtest(req: CrtBacktestRequest, sigs: list, bars, wr_from_date=None):
    """給定訊號(已含對應目標的結算欄位；比例軌須先 _inject_band_ratio) + K 棒 → 過濾／進場規則／資金模擬 → 回結果 dict。
    從 run_crt_backtest 抽出，讓『自動最佳化』重用同一份勝率/訊號跑上百組合（不重抓、band80 只注入一次）。"""
    # 結算欄位組：加倉/上下軌→band；8成軌→band80；中軌→mid。決定 picked 過濾、敗後停手、_simulate 取哪組勝負/RR。
    if req.pyramid or req.target == "band":
        rkey, otkey, rrkey, estkey = "r_b", "ot_b", "rr_b_real", "est_r_b"
    elif req.target in _BAND_RATIO:                       # 比例軌(8成/98%…)：用對應後綴欄位
        _, _sfx = _BAND_RATIO[req.target]
        rkey, otkey, rrkey, estkey = f"r{_sfx}", f"ot{_sfx}", f"rr{_sfx}_real", f"est_r{_sfx}"
    else:
        rkey, otkey, rrkey, estkey = "r", "ot", "rr_real", "est_r"
    tp_mode = req.tp_mode if req.tp_mode in ("real", "est") else "real"   # 加倉也尊重止盈基準(real/est)

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

    n_all = len(picked)
    risk_pct = max(0.001, min(1.0, float(req.risk_pct or 0.02)))

    # ── 加倉（金字塔）：獨立模式，合併均價＋單一停損＋所選目標止盈，重走 K 棒結算 ──
    if req.pyramid:
        cand = sorted(picked, key=lambda s: (s.get("t") or "", s.get("ot_b") or ""))
        clusters = _build_pyramid_clusters(bars, cand, req.max_adds, req.target, tp_mode)   # 尊重所選目標/基準
        from_date = (clusters[0].get("t") or "")[:10] if clusters else wr_from_date
        stats, trades, equity = _simulate(clusters, "r", "rr_real", "est_r", "ot",
                                          req.initial_capital, risk_pct, "real", from_date,
                                          fee_pct=getattr(req, "fee_pct", 0.0), leverage=getattr(req, "leverage", 0.0))
        return {
            "stats": stats, "trades": trades, "equity_curve": equity,
            "tp_mode": tp_mode, "entry_rule": "pyramid", "target": req.target,
            "n_all": n_all,             # 候選進場訊號數
            "n_taken": len(clusters),   # 實際加倉群數（一群=一筆交易，含多次加倉）
        }

    # 一次一筆：直到上一筆結算（otkey）才接受下一個「進場時間 ≥ 前筆結算時間」的訊號，
    # 持倉期間出現的訊號全部跳過。依進場時間順序貪婪挑選。
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

    # from_date 用實際首筆交易日（比資料起始日更精準；回測期間有限縮時也對得上）
    from_date = (picked[0].get("t") or "")[:10] if picked else wr_from_date

    stats, trades, equity = _simulate(picked, rkey, rrkey, estkey, otkey, req.initial_capital, risk_pct, tp_mode, from_date,
                                      fee_pct=getattr(req, "fee_pct", 0.0), leverage=getattr(req, "leverage", 0.0))

    return {
        "stats":        stats,
        "trades":       trades,
        "equity_curve": equity,
        "tp_mode":      tp_mode,
        "target":       req.target,
        "entry_rule":   "stop" if req.stop_after_loss else ("single" if req.one_position else "all"),
        "n_all":        n_all,             # 該條件/期間內的全部訊號數
        "n_taken":      len(picked),       # 實際納入回測的筆數（一次一筆會少於 n_all）
    }


# 自動最佳化搜尋空間（用面板當下的 標的/時框/止損緩衝/風險%/本金/回測天數，不變動這些）
_OPT_SIGNALS = ["all", "all11", "ssall", "abc", "ab", "s3", "s4", "s5", "s6",
                "s7", "s8", "s9", "s10", "s11", "s12", "ss1", "ss2"]
_OPT_DIRS    = ["both", "long", "short"]
_OPT_PLAIN   = [(rule, tgt) for rule in ("all", "single", "stop")
                for tgt in ("mid", "band", "band80", "band98")]   # 一般規則 × 目標(含 98%軌)
_OPT_PYR_TGTS = ("band", "band98")   # 加倉最佳化跑的目標（上下軌 + 98%軌，貼合實盤）
_OPT_MIN_TRADES = 20   # 樣本太少（<20 筆）的組合不列入排名，避免幸運小樣本灌爆報酬率


@router.post("/crt_backtest_optimize")
def run_crt_optimize(req: CrtBacktestRequest):
    """自動最佳化：固定面板當下的 標的/時框/止損緩衝/風險%/本金/回測天數，窮舉
    訊號 × 方向 × (進場規則 × 目標) ＋ 加倉，依『報酬率』排名回前 N 名。
    只抓一次勝率、band80 只注入一次 → 上百組合共用，幾秒內跑完。"""
    from types import SimpleNamespace
    from routes.data import get_crt_winrate
    import time as _t
    t0 = _t.time()
    try:
        wr = get_crt_winrate(
            market=req.market, symbol=req.symbol, timeframe=req.timeframe,
            exchange=req.exchange, stop_buffer_pct=req.stop_buffer_pct,
            finmind_token=req.finmind_token, with_bars=True)
    except Exception as e:
        raise HTTPException(400, f"勝率計算失敗: {e}")
    base_sigs = (wr or {}).get("signals") or []
    bars = (wr or {}).get("_bars")
    wr_from = (wr or {}).get("from_date")
    sigs80 = [dict(s) for s in base_sigs]   # 8成軌專用：整份注入一次，所有 band80 組合共用
    _inject_band_ratio(bars, sigs80, 0.8, "80")
    sigs98 = [dict(s) for s in base_sigs]   # 98%軌專用：同理注入一次共用
    _inject_band_ratio(bars, sigs98, 0.98, "98")
    def _sigset(tgt):
        return {"band80": sigs80, "band98": sigs98}.get(tgt, base_sigs)

    base_fields = req.dict()
    def _mk(**over):
        d = dict(base_fields); d.update(over); return SimpleNamespace(**d)

    rows = []
    def _add(combo_req, sigset, label_rule):
        try:
            r = _compute_backtest(combo_req, sigset, bars, wr_from)
        except Exception:
            return
        st = r.get("stats") or {}
        rows.append({
            "signal": combo_req.signal, "direction": combo_req.direction,
            "target": r.get("target"),     # 加倉也尊重所選目標 → 直接用回傳值
            "entry_rule": label_rule,
            "ret": st.get("total_return"), "win_rate": st.get("win_rate"),
            "trades": st.get("total_trades"), "max_dd": st.get("max_drawdown"),
            "pf": st.get("profit_factor"), "max_use": st.get("max_use"),
            "net_r": st.get("net_r"), "n_taken": r.get("n_taken"),
        })

    for sig in _OPT_SIGNALS:
        for d in _OPT_DIRS:
            for rule, tgt in _OPT_PLAIN:
                _add(_mk(signal=sig, direction=d, target=tgt, tp_mode="real",
                         one_position=(rule == "single"), stop_after_loss=(rule == "stop"),
                         pyramid=False), _sigset(tgt), rule)
            # 加倉：跨目標（含 98%軌）→ 用 base_sigs（cluster 自行算目標，不需注入）
            for tgt in _OPT_PYR_TGTS:
                _add(_mk(signal=sig, direction=d, target=tgt, tp_mode="real",
                         one_position=False, stop_after_loss=False, pyramid=True), base_sigs, "pyramid")

    valid = [x for x in rows if (x.get("trades") or 0) >= _OPT_MIN_TRADES and x.get("ret") is not None]
    # 資金用量上限：>0 時只保留「資金用量峰 ≤ cap」的組合（濾掉靠高槓桿灌報酬的假象）。
    cap = float(req.max_use_cap or 0)
    if cap > 0:
        valid = [x for x in valid if (x.get("max_use") or 0) <= cap]
    valid.sort(key=lambda x: x["ret"], reverse=True)
    return {
        "top": valid[:25], "tested": len(rows), "qualified": len(valid),
        "min_trades": _OPT_MIN_TRADES, "max_use_cap": cap, "from_date": wr_from,
        "elapsed": round(_t.time() - t0, 2),
    }
