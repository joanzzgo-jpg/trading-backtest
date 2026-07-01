"""SMC 多時框快照（給「SR+SMC 多空教練」步驟狀態機用）。
把 crt.py 階段1-5 的 SMC 偵測抽成 per-df 純函式，供 4H/1H/15M/日 各自呼叫。
不改動已提交的 _calc_crt_winrate；此處為獨立、可重用的輕量版偵測。"""
from __future__ import annotations
import math


def _to_lists(df):
    H = df["high"].astype(float).tolist()
    L = df["low"].astype(float).tolist()
    C = df["close"].astype(float).tolist()
    O = df["open"].astype(float).tolist() if "open" in df.columns else C[:]
    try:
        T = df["time"].to_numpy("datetime64[s]").astype(str).tolist()
    except Exception:
        T = [(_t.isoformat() if hasattr(_t, "isoformat") else str(_t)) for _t in df["time"]]
    return H, L, C, O, T


def _atr(H, L, C, n=14):
    N = len(C)
    tr = [float("nan")] * N
    for i in range(N):
        tr[i] = (H[i] - L[i]) if i == 0 else max(H[i] - L[i], abs(H[i] - C[i - 1]), abs(L[i] - C[i - 1]))
    atr = [float("nan")] * N
    a = float("nan")
    for i in range(N):
        if a != a:
            if i >= n - 1:
                a = sum(tr[i - n + 1:i + 1]) / n
        else:
            a = (a * (n - 1) + tr[i]) / n
        atr[i] = a
    return atr


def _is_ph(H, p, PL):
    v = H[p]
    return v == v and all(v >= H[p + d] for d in range(-PL, PL + 1))


def _is_pl(L, p, PL):
    v = L[p]
    return v == v and all(v <= L[p + d] for d in range(-PL, PL + 1))


def _gaps(H, L, MS=0.0001):
    """三根 FVG 缺口序列：(cf_bar, top, bot, dir)。"""
    N = len(H)
    out = []
    for g in range(1, N - 1):
        h0, l0, h2, l2 = H[g - 1], L[g - 1], H[g + 1], L[g + 1]
        if any(v != v for v in (h0, l0, h2, l2)):
            continue
        if l2 > h0 and (l2 - h0) / h0 > MS:
            out.append((g + 1, l2, h0, "l"))
        elif h2 < l0 and (l0 - h2) / l0 > MS:
            out.append((g + 1, l0, h2, "s"))
    return out


def _trend_and_struct(H, L, C, T, PL=5):
    """對齊 Pine f_htfStructureSnapshot：BOS/CHoCH 定趨勢；未破時用 HH+HL→多 / LH+LL→空 補判。
    回傳 (最終趨勢, 最後事件dict)。趨勢 1多/-1空/0未定。"""
    N = len(C)
    lastSH = lastSL = prevSH = prevSL = None
    shBroken = slBroken = False
    highType = lowType = 0          # 新擺高/低相對前一個：1=抬高 / -1=降低
    trend = 0
    last_ev = None
    for i in range(N):
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL):
                prevSH = lastSH; lastSH = H[p]; shBroken = False
                highType = 0 if prevSH is None else (1 if lastSH > prevSH else -1)
            if _is_pl(L, p, PL):
                prevSL = lastSL; lastSL = L[p]; slBroken = False
                lowType = 0 if prevSL is None else (1 if lastSL > prevSL else -1)
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        if ci != ci:
            continue
        if lastSH is not None and not shBroken and ci > lastSH and (cp != cp or cp <= lastSH):
            k = "choch_up" if trend == -1 else "bos_up"
            last_ev = {"t": T[i], "p": lastSH, "k": k}
            trend = 1; shBroken = True
        elif lastSL is not None and not slBroken and ci < lastSL and (cp != cp or cp >= lastSL):
            k = "choch_dn" if trend == 1 else "bos_dn"
            last_ev = {"t": T[i], "p": lastSL, "k": k}
            trend = -1; slBroken = True
        if trend == 0:                                   # Pine：尚無破時用擺動結構補判
            if highType == 1 and lowType == 1:
                trend = 1
            elif highType == -1 and lowType == -1:
                trend = -1
    return trend, last_ev


def _alive_fvg(H, L, C, T, PL=5):
    """未填補(到中線)的 FVG：回傳 {"l":[...], "s":[...]}，各元素 {top,bot,mid,t}。最新在後。"""
    gaps = _gaps(H, L)
    N = len(C)
    out = {"l": [], "s": []}
    for (ci, tp, bt, dr) in gaps:
        mid = (tp + bt) / 2.0
        filled = False
        for j in range(ci + 1, N):
            if dr == "l" and L[j] <= mid: filled = True; break
            if dr == "s" and H[j] >= mid: filled = True; break
        if not filled:
            out[dr].append({"top": tp, "bot": bt, "mid": mid, "t": T[ci]})
    return out


def _alive_ob(H, L, C, O, T, PL=5, LB=20):
    """存活 OB（結構破往回找最後反向實體K；收盤穿越另側失效）。回傳 {"l":[...], "s":[...]}，元素 {top,bot}。"""
    N = len(C)
    lastSH = lastSL = None; shB = slB = False
    bull = []; bear = []
    for i in range(N):
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL): lastSH = H[p]; shB = False
            if _is_pl(L, p, PL): lastSL = L[p]; slB = False
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        if ci != ci:
            continue
        bull[:] = [z for z in bull if ci >= z["bot"]]         # 收盤跌破下緣→失效
        bear[:] = [z for z in bear if ci <= z["top"]]
        if lastSH is not None and not shB and ci > lastSH and (cp != cp or cp <= lastSH):
            shB = True
            off = next((j for j in range(1, LB + 1) if i - j >= 0 and C[i - j] < O[i - j]), None)
            if off is not None:
                b = i - off; bull.append({"top": max(O[b], C[b]), "bot": min(O[b], C[b])})
        if lastSL is not None and not slB and ci < lastSL and (cp != cp or cp >= lastSL):
            slB = True
            off = next((j for j in range(1, LB + 1) if i - j >= 0 and C[i - j] > O[i - j]), None)
            if off is not None:
                b = i - off; bear.append({"top": max(O[b], C[b]), "bot": min(O[b], C[b])})
    return {"l": bull, "s": bear}


def _alive_sr(H, L, C, T, PL=8, ZW=0.20, MRG=1.25, BUF=0.15, MAXZ=3, ATRN=14):
    """存活 SR（pivot8+ATR寬+就近合併+突破緩衝確認+角色互換）。回傳 {"res":[...], "sup":[...]}，元素 {top,bot}。"""
    N = len(C)
    atr = _atr(H, L, C, ATRN)
    res = []; sup = []
    mid = lambda z: (z["top"] + z["bot"]) / 2.0

    def push(lst, z):
        lst.append(z)
        if len(lst) > MAXZ: lst.pop(0)
    for i in range(N):
        p = i - PL
        if p - PL >= 0 and atr[p] == atr[p]:
            hw = atr[p] * ZW; md = atr[p] * MRG
            if _is_ph(H, p, PL):
                ph = H[p]; nz = next((z for z in res if abs(mid(z) - ph) <= md), None)
                if nz: nz["top"] = max(nz["top"], ph + hw); nz["bot"] = min(nz["bot"], ph - hw)
                else: push(res, {"top": ph + hw, "bot": ph - hw})
            if _is_pl(L, p, PL):
                pl = L[p]; nz = next((z for z in sup if abs(mid(z) - pl) <= md), None)
                if nz: nz["top"] = max(nz["top"], pl + hw); nz["bot"] = min(nz["bot"], pl - hw)
                else: push(sup, {"top": pl + hw, "bot": pl - hw})
        ci = C[i]; an = atr[i]
        if ci == ci and an == an:
            buf = an * BUF; cp = C[i - 1] if i > 0 else float("nan")
            bufP = (atr[i - 1] if i > 0 and atr[i - 1] == atr[i - 1] else an) * BUF
            for z in list(res):
                if ci > z["top"] + buf and cp == cp and cp > z["top"] + bufP:
                    res.remove(z); push(sup, {"top": z["top"], "bot": z["bot"]})   # 角色互換
            for z in list(sup):
                if ci < z["bot"] - buf and cp == cp and cp < z["bot"] - bufP:
                    sup.remove(z); push(res, {"top": z["top"], "bot": z["bot"]})
    return {"res": res, "sup": sup}


def _swing_targets(H, L, C, T, PL=5):
    """回傳目前『尚未被破的最近擺高/擺低』(掃蕩目標)。{"sh":價,"sl":價}。"""
    N = len(C)
    lastSH = lastSL = None; shB = slB = False
    for i in range(N):
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL): lastSH = H[p]; shB = False
            if _is_pl(L, p, PL): lastSL = L[p]; slB = False
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        if ci != ci:
            continue
        if lastSH is not None and not shB and ci > lastSH and (cp != cp or cp <= lastSH): shB = True
        if lastSL is not None and not slB and ci < lastSL and (cp != cp or cp >= lastSL): slB = True
    return {"sh": (lastSH if not shB else None), "sl": (lastSL if not slB else None)}


def _channel(H, L, C, T, PL=5, ATRN=14, MINW=1.20):
    """當前擺動平行通道（同 crt.py 階段5）。回傳 dict 或 None。"""
    N = len(C)
    atr = _atr(H, L, C, ATRN)
    pH = lH = pL = lL = None
    pHt = lHt = pLt = lLt = None
    for i in range(N):
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL):
                pH, pHt, lH, lHt = lH, lHt, H[p], p
            if _is_pl(L, p, PL):
                pL, pLt, lL, lLt = lL, lLt, L[p], p
    up = pL is not None and lL is not None and lL > pL and pLt is not None and lLt is not None and lLt > pLt
    dn = pH is not None and lH is not None and lH < pH and pHt is not None and lHt is not None and lHt > pHt
    if up and dn:
        d = 1 if lLt >= lHt else -1
    else:
        d = 1 if up else (-1 if dn else 0)
    if d == 0:
        return None
    a1t, a1p, a2t, a2p = (pLt, pL, lLt, lL) if d == 1 else (pHt, pH, lHt, lH)
    aref = atr[N - 1 - PL] if N - 1 - PL >= 0 and atr[N - 1 - PL] == atr[N - 1 - PL] else atr[N - 1]
    w = max((aref if aref == aref else 0.0) * MINW, 1e-9)

    def lv(t1, q1, t2, q2, tt):
        return q1 if t2 == t1 else q1 + (q2 - q1) * (tt - t1) / (t2 - t1)
    if d == 1 and lH is not None and lHt >= a1t:
        cw = lH - lv(a1t, a1p, a2t, a2p, lHt)
        if cw == cw and cw > 0: w = max(w, cw)
    if d == -1 and lL is not None and lLt >= a1t:
        cw = lv(a1t, a1p, a2t, a2p, lLt) - lL
        if cw == cw and cw > 0: w = max(w, cw)
    # 當前(最後一根)上下軌值：把基準線外推到最後一根
    base_last = lv(a1t, a1p, a2t, a2p, N - 1)
    lower = base_last if d == 1 else base_last - w
    upper = base_last + w if d == 1 else base_last
    return {"dir": d, "lower": lower, "upper": upper, "mid": (lower + upper) / 2.0}


def _recent_sweep(H, L, C, T, PL=5):
    """最後一個掃頂/掃底事件：回傳 {"d":"s"/"l","p":擺點價,"t":..} 或 None。"""
    N = len(C)
    lastSH = lastSL = None
    shSwept = slSwept = False
    last = None
    for i in range(N):
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL):
                if lastSH is None or H[p] != lastSH: shSwept = False
                lastSH = H[p]
            if _is_pl(L, p, PL):
                if lastSL is None or L[p] != lastSL: slSwept = False
                lastSL = L[p]
        hi, lo, ci = H[i], L[i], C[i]
        if ci != ci:
            continue
        if lastSH is not None and not shSwept and hi > lastSH and ci < lastSH:
            last = {"d": "s", "p": lastSH, "t": T[i]}; shSwept = True
        if lastSL is not None and not slSwept and lo < lastSL and ci > lastSL:
            last = {"d": "l", "p": lastSL, "t": T[i]}; slSwept = True
    return last


def run_coach(df15, htf_bull_zones, htf_bear_zones, direction, touch_mode=True,
              PL=5, LB=20, MAXWAIT=120):
    """15M 逐棒步驟狀態機（移植 Pine coachLong/ShortStage）。direction:1多/-1空。
    htf_*_zones：4H/1H 方向側未填補區 [(top,bot),...]（步驟2「進入HTF區」用）。
    回傳當前 setup 狀態（stage 與各關鍵價/區）。"""
    if df15 is None or len(df15) < PL * 2 + 3 or direction == 0:
        return {"stage": 0}
    H, L, C, O, T = _to_lists(df15)
    N = len(C)
    zones = htf_bull_zones if direction == 1 else htf_bear_zones   # 元素 (top,bot,name)

    def _htf_touch(i):
        for z in zones:
            zt, zb = z[0], z[1]
            if H[i] >= min(zt, zb) and L[i] <= max(zt, zb):
                return (max(zt, zb), min(zt, zb), z[2] if len(z) > 2 else "")
        return None

    # 逐棒共用：擺高/低(as-of)、掃頂/掃底、結構破、pivot、OB、FVG
    stage = 0; startBar = None
    zoneTop = zoneBot = None; zoneName = ""
    sweepBar = None; sweepPx = None; turnTrig = None; turnBar = None
    bosTrig = None; bosTrigSetBar = None; bosBar = None
    entTop = entBot = None; entName = ""
    lastSH = lastSL = None; lastSHb = lastSLb = None
    shBroken = slBroken = False; shSwept = slSwept = False
    trend15 = 0

    def reset(to=0):
        nonlocal stage, startBar, zoneTop, zoneBot, zoneName, sweepBar, sweepPx, turnTrig, turnBar
        nonlocal bosTrig, bosTrigSetBar, bosBar, entTop, entBot, entName
        stage = to; startBar = None if to == 0 else i
        if to <= 1: zoneTop = zoneBot = None; zoneName = ""
        if to <= 2:
            sweepBar = sweepPx = turnTrig = turnBar = None
            bosTrig = bosTrigSetBar = bosBar = None
        if to <= 5:
            entTop = entBot = None; entName = ""

    for i in range(N):
        # 更新已確認 pivot（落點 i-PL）
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL):
                lastSH = H[p]; lastSHb = p; shBroken = False
            if _is_pl(L, p, PL):
                lastSL = L[p]; lastSLb = p; slBroken = False
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        if ci != ci:
            continue
        # 15M 結構破（判 CHoCH 反向失效用）
        bullBreak = lastSH is not None and not shBroken and ci > lastSH and (cp != cp or cp <= lastSH)
        bearBreak = lastSL is not None and not slBroken and ci < lastSL and (cp != cp or cp >= lastSL)
        if bullBreak: shBroken = True; _pt = trend15; trend15 = 1
        if bearBreak: slBroken = True; _pt2 = trend15; trend15 = -1
        # 掃頂/掃底
        bullSweep = lastSL is not None and not slSwept and L[i] < lastSL and ci > lastSL
        bearSweep = lastSH is not None and not shSwept and H[i] > lastSH and ci < lastSH
        if bullSweep: slSwept = True
        if bearSweep: shSwept = True
        if lastSL is not None and L[i] >= lastSL: slSwept = False
        if lastSH is not None and H[i] <= lastSH: shSwept = False

        # 失效：反向 CHoCH 或超時 → 重置本方向 setup
        if stage > 0:
            opp_choch = (bearBreak and direction == 1) or (bullBreak and direction == -1)
            expired = startBar is not None and stage < 7 and i - startBar > MAXWAIT
            if opp_choch or expired:
                reset(0)

        # 步驟推進
        if stage == 0:
            stage = 1; startBar = i
        if stage <= 1:
            tz = _htf_touch(i)
            if tz is not None:
                stage = 2; startBar = i; zoneTop, zoneBot, zoneName = tz
        if stage == 2 and ((direction == 1 and bullSweep) or (direction == -1 and bearSweep)):
            stage = 3; startBar = i; sweepBar = i; sweepPx = (L[i] if direction == 1 else H[i])
            turnTrig = (lastSH if direction == 1 else lastSL)
        if stage == 3 and turnTrig is None:
            turnTrig = (lastSH if direction == 1 else lastSL)
        # MSS：掃蕩後收盤站上/跌破反向擺點
        if stage == 3 and sweepBar is not None and i > sweepBar and turnTrig is not None and \
           ((direction == 1 and ci > turnTrig) or (direction == -1 and ci < turnTrig)):
            stage = 4; startBar = i; turnBar = i; bosTrig = None; bosTrigSetBar = None
        # BOS：MSS 後新 pivot 形成為觸發價、收盤突破/跌破
        if stage == 4 and bosTrig is None and turnBar is not None and p - PL >= 0 and p >= turnBar:
            if direction == 1 and _is_ph(H, p, PL):
                bosTrig = H[p]; bosTrigSetBar = i
            if direction == -1 and _is_pl(L, p, PL):
                bosTrig = L[p]; bosTrigSetBar = i
        if stage == 4 and bosTrig is not None and bosTrigSetBar is not None and i > bosTrigSetBar and \
           ((direction == 1 and ci > bosTrig) or (direction == -1 and ci < bosTrig)):
            stage = 5; startBar = i; bosBar = i
        # 掛單區：BOS 後回踩本方向 15M OB / FVG
        if stage == 5 and bosBar is not None and i > bosBar:
            zone = _last_dir_zone_15m(H, L, C, O, T, i, bosBar, direction, LB)
            if zone is not None and H[i] >= zone[1] and L[i] <= zone[0]:   # 觸碰
                stage = 6; startBar = i; entTop, entBot, entName = zone[0], zone[1], zone[2]
                if touch_mode:
                    stage = 7
        # 反應K模式（非觸碰）：步驟6→7
        if stage == 6 and not touch_mode and entTop is not None:
            mid = (entTop + entBot) / 2.0
            if direction == 1 and ci > O[i] and ci > mid:
                stage = 7
            if direction == -1 and ci < O[i] and ci < mid:
                stage = 7

    return {"stage": stage, "zone_top": zoneTop, "zone_bot": zoneBot, "zone_name": zoneName,
            "sweep_px": sweepPx, "mss_px": turnTrig, "bos_px": bosTrig,
            "entry_top": entTop, "entry_bot": entBot, "entry_name": entName}


def _last_dir_zone_15m(H, L, C, O, T, i, since_bar, direction, LB=20):
    """在 [since_bar, i] 內找最近一個本方向 15M FVG 或 OB 當掛單區。回傳 (top,bot,name) 或 None。
    多：多FVG(l) / 多OB(結構破前最後空實體K)；空鏡像。優先 FVG。"""
    # 最近本方向 FVG（三根）
    best = None
    for g in range(max(1, since_bar), i):
        if g + 1 > i:
            break
        h0, l0, h2, l2 = H[g - 1], L[g - 1], H[g + 1] if g + 1 < len(H) else H[g], L[g + 1] if g + 1 < len(L) else L[g]
        if direction == 1 and l2 > h0 and (l2 - h0) / h0 > 0.0001:
            best = (l2, h0, "多方缺口")
        elif direction == -1 and h2 < l0 and (l0 - h2) / l0 > 0.0001:
            best = (l0, h2, "空方缺口")
    return best


def snapshot(df, pivot_len=5):
    """單一時框 SMC 快照，給教練狀態機用。"""
    if df is None or len(df) < pivot_len * 2 + 3:
        return None
    H, L, C, O, T = _to_lists(df)
    trend, last_ev = _trend_and_struct(H, L, C, T, pivot_len)
    fvg = _alive_fvg(H, L, C, T, pivot_len)
    ob = _alive_ob(H, L, C, O, T, pivot_len)
    sr = _alive_sr(H, L, C, T)
    ch = _channel(H, L, C, T)
    sweep = _recent_sweep(H, L, C, T, pivot_len)
    targets = _swing_targets(H, L, C, T, pivot_len)
    return {
        "trend": trend,               # 1 多 / -1 空 / 0 未定
        "last_event": last_ev,        # 最後 BOS/CHoCH
        "fvg": fvg,                    # 未填補缺口 {"l":[...], "s":[...]}
        "ob": ob,                     # 存活訂單區 {"l":[...], "s":[...]}
        "sr": sr,                     # 存活支撐/阻力 {"res":[...], "sup":[...]}
        "channel": ch,                # 平行通道(含當前上/下/中軌)
        "sweep": sweep,               # 最後掃頂/掃底
        "targets": targets,           # 待掃擺高/擺低
        "price": C[-1],               # 最新收盤
        "high": H[-1], "low": L[-1],
        "time": T[-1],
    }
