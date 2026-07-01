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
            out[dr].append({"top": tp, "bot": bt, "mid": mid, "t0": T[max(0, ci - 2)]})
    out["l"] = out["l"][-3:]; out["s"] = out["s"][-3:]    # 每側最多 3（對齊 TV maxFVGZones）
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
                b = i - off; bull.append({"top": max(O[b], C[b]), "bot": min(O[b], C[b]), "t0": T[b]})
        if lastSL is not None and not slB and ci < lastSL and (cp != cp or cp >= lastSL):
            slB = True
            off = next((j for j in range(1, LB + 1) if i - j >= 0 and C[i - j] > O[i - j]), None)
            if off is not None:
                b = i - off; bear.append({"top": max(O[b], C[b]), "bot": min(O[b], C[b]), "t0": T[b]})
    return {"l": bull[-3:], "s": bear[-3:]}


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
                else: push(res, {"top": ph + hw, "bot": ph - hw, "t0": T[p]})
            if _is_pl(L, p, PL):
                pl = L[p]; nz = next((z for z in sup if abs(mid(z) - pl) <= md), None)
                if nz: nz["top"] = max(nz["top"], pl + hw); nz["bot"] = min(nz["bot"], pl - hw)
                else: push(sup, {"top": pl + hw, "bot": pl - hw, "t0": T[p]})
        ci = C[i]; an = atr[i]
        if ci == ci and an == an:
            buf = an * BUF; cp = C[i - 1] if i > 0 else float("nan")
            bufP = (atr[i - 1] if i > 0 and atr[i - 1] == atr[i - 1] else an) * BUF
            for z in list(res):
                if ci > z["top"] + buf and cp == cp and cp > z["top"] + bufP:
                    res.remove(z); push(sup, {"top": z["top"], "bot": z["bot"], "t0": z.get("t0", T[i])})   # 角色互換
            for z in list(sup):
                if ci < z["bot"] - buf and cp == cp and cp < z["bot"] - bufP:
                    sup.remove(z); push(res, {"top": z["top"], "bot": z["bot"], "t0": z.get("t0", T[i])})
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
    # 當前(最後一根)上下軌值：給面板判定通道內/外
    base_last = lv(a1t, a1p, a2t, a2p, N - 1)
    lower = base_last if d == 1 else base_last - w
    upper = base_last + w if d == 1 else base_last
    # 斜率錨點：上/下軌在兩個錨點K的價（給前端從錨點畫斜線、涵蓋範圍對齊 TV）
    if d == 1:
        lo1, lo2, up1, up2 = a1p, a2p, a1p + w, a2p + w
    else:
        up1, up2, lo1, lo2 = a1p, a2p, a1p - w, a2p - w
    return {"dir": d, "lower": lower, "upper": upper, "mid": (lower + upper) / 2.0,
            "t1": T[a1t], "t2": T[a2t], "lo1": lo1, "lo2": lo2, "up1": up1, "up2": up2}


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


def htf_series(df, sr_pl=8, ob_pl=5, ZW=0.20, MRG=1.25, BUF=0.15, MAXZ=3,
               LB=20, ATRN=14, MS=0.0001):
    """忠實移植 f_htfVisibleZones + f_htfStructureSnapshot 為「逐棒時間序列」。
    每根 HTF 棒回傳當時的：趨勢、以及每型別「離收盤最近」的單一區(sup/res/bull_ob/bear_ob/bull_fvg/bear_fvg)。
    供 run_coach 對齊到每根 15M（取用『收盤時間 ≤ 該15M時間』的最後一根HTF）→ 復刻 request.security 逐棒對齊。
    每個 zone = (top, bot) 或 None。回傳 [{t, trend, sup, res, bull_ob, bear_ob, bull_fvg, bear_fvg}]。"""
    if df is None or len(df) < sr_pl * 2 + 3:
        return []
    H, L, C, O, T = _to_lists(df)
    N = len(C)
    atr = _atr(H, L, C, ATRN)

    def _near(pool, price, below):
        best = None; bd = 1e30
        for (zt, zb) in pool:
            zu = max(zt, zb); zl = min(zt, zb)
            side = (zl < price) if below else (zu > price)
            if not side:
                continue
            d = max(price - zu, 0.0) if below else max(zl - price, 0.0)
            if d < bd: bd = d; best = (zu, zl)
        return best

    # 趨勢狀態(f_htfStructureSnapshot)
    tSH = tSL = pSH = pSL = None; tHb = tLb = False; highType = lowType = 0; trend = 0
    # SR 池(merge/flip)、OB 池、FVG 池
    res_pool = []; sup_pool = []           # dict {top,bot}
    bull_ob = []; bear_ob = []             # (top,bot)
    bull_fvg = []; bear_fvg = []           # (top,bot)
    # OB 結構破用的擺點
    oSH = oSL = None; oHb = oLb = False
    out = []
    _mid = lambda z: (z["top"] + z["bot"]) / 2.0

    def _push_sr(pool, top, bot, md):
        nz = next((z for z in pool if abs(_mid(z) - (top + bot) / 2.0) <= md), None)
        if nz: nz["top"] = max(nz["top"], top); nz["bot"] = min(nz["bot"], bot)
        else:
            pool.append({"top": top, "bot": bot})
            if len(pool) > MAXZ: pool.pop(0)
    for i in range(N):
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        # ── 趨勢(pivot=ob_pl，對齊 coachPivotLen=5) ──
        p = i - ob_pl
        if p - ob_pl >= 0:
            if _is_ph(H, p, ob_pl):
                pSH = tSH; tSH = H[p]; tHb = False
                highType = 0 if pSH is None else (1 if tSH > pSH else -1)
            if _is_pl(L, p, ob_pl):
                pSL = tSL; tSL = L[p]; tLb = False
                lowType = 0 if pSL is None else (1 if tSL > pSL else -1)
        if ci == ci:
            if tSH is not None and not tHb and ci > tSH and (cp != cp or cp <= tSH):
                trend = 1; tHb = True
            elif tSL is not None and not tLb and ci < tSL and (cp != cp or cp >= tSL):
                trend = -1; tLb = True
            if trend == 0:
                if highType == 1 and lowType == 1: trend = 1
                elif highType == -1 and lowType == -1: trend = -1
        # ── SR(pivot=sr_pl=8) ──
        ps = i - sr_pl
        if ps - sr_pl >= 0 and atr[ps] == atr[ps]:
            hw = max(atr[ps] * ZW, 1e-9); md = atr[ps] * MRG
            if _is_ph(H, ps, sr_pl): _push_sr(res_pool, H[ps] + hw, H[ps] - hw, md)
            if _is_pl(L, ps, sr_pl): _push_sr(sup_pool, L[ps] + hw, L[ps] - hw, md)
        if ci == ci and atr[i] == atr[i]:
            buf = atr[i] * BUF; bufP = (atr[i - 1] if i > 0 and atr[i - 1] == atr[i - 1] else atr[i]) * BUF
            for z in list(res_pool):
                if ci > z["top"] + buf and cp == cp and cp > z["top"] + bufP:
                    res_pool.remove(z); _push_sr(sup_pool, z["top"], z["bot"], buf)
            for z in list(sup_pool):
                if ci < z["bot"] - buf and cp == cp and cp < z["bot"] - bufP:
                    sup_pool.remove(z); _push_sr(res_pool, z["top"], z["bot"], buf)
        # ── OB(結構破 pivot=ob_pl=5、往回 LB) ──
        if p - ob_pl >= 0:
            if _is_ph(H, p, ob_pl): oSH = H[p]; oHb = False
            if _is_pl(L, p, ob_pl): oSL = L[p]; oLb = False
        if ci == ci:
            bull_ob[:] = [z for z in bull_ob if ci >= min(z)]
            bear_ob[:] = [z for z in bear_ob if ci <= max(z)]
            if oSH is not None and not oHb and ci > oSH and (cp != cp or cp <= oSH):
                oHb = True
                off = next((j for j in range(1, LB + 1) if i - j >= 0 and C[i - j] < O[i - j]), None)
                if off is not None:
                    b = i - off; bull_ob.append((max(O[b], C[b]), min(O[b], C[b])))
                    if len(bull_ob) > MAXZ: bull_ob.pop(0)
            if oSL is not None and not oLb and ci < oSL and (cp != cp or cp >= oSL):
                oLb = True
                off = next((j for j in range(1, LB + 1) if i - j >= 0 and C[i - j] > O[i - j]), None)
                if off is not None:
                    b = i - off; bear_ob.append((max(O[b], C[b]), min(O[b], C[b])))
                    if len(bear_ob) > MAXZ: bear_ob.pop(0)
        # ── FVG(3根) ──
        if i >= 2:
            if L[i] > H[i - 2] and (L[i] - H[i - 2]) >= 0.0 and (H[i - 2] > 0 and (L[i] - H[i - 2]) / H[i - 2] > MS):
                bull_fvg.append((L[i], H[i - 2]))
                if len(bull_fvg) > MAXZ: bull_fvg.pop(0)
            if H[i] < L[i - 2] and (L[i - 2] > 0 and (L[i - 2] - H[i]) / L[i - 2] > MS):
                bear_fvg.append((L[i - 2], H[i]))
                if len(bear_fvg) > MAXZ: bear_fvg.pop(0)
        # 部分/完全回補
        bull_fvg[:] = [(min(zt, L[i]) if L[i] < zt else zt, zb) for (zt, zb) in bull_fvg if L[i] > zb]
        bear_fvg[:] = [(zt, max(zb, H[i]) if H[i] > zb else zb) for (zt, zb) in bear_fvg if H[i] < zt]
        # ── 記錄本棒最近區 ──
        px = ci
        out.append({
            "t": T[i], "trend": trend,
            "sup": _near([(z["top"], z["bot"]) for z in sup_pool], px, True),
            "res": _near([(z["top"], z["bot"]) for z in res_pool], px, False),
            "bull_ob": _near(bull_ob, px, True), "bear_ob": _near(bear_ob, px, False),
            "bull_fvg": _near(bull_fvg, px, True), "bear_fvg": _near(bear_fvg, px, False),
        })
    return out


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


def run_coach2(df15, series_4h, series_1h, target_dir, touch_mode=True,
               PL=5, LB=20, MAXWAIT=120):
    """忠實版狀態機：逐 15M 棒對齊 1H/4H HTF series(request.security 復刻)+完整失效退階。
    target_dir：目前主方向(1多/-1空)。回傳當前 setup 狀態(同 run_coach 欄位)。"""
    if df15 is None or len(df15) < PL * 2 + 3 or target_dir == 0 or not series_4h:
        return {"stage": 0}
    H, L, C, O, T = _to_lists(df15)
    N = len(C)
    d = target_dir

    # HTF 對齊：每根 15M → 取「上一根『已收盤』HTF」（復刻 Pine f_htfVisibleZones/StructureSnapshot 回傳的 [1]）。
    #   關鍵：不能用「正在形成」的 HTF 棒（會用到它收盤後才知道的趨勢/區）——那正是 IN 鎖到暴跌棒的 bug。
    def _align(series):
        idx = [None] * N; j = 0; prev = None; cur = None
        for i in range(N):
            while j < len(series) and series[j]["t"] <= T[i]:
                prev = cur; cur = series[j]; j += 1
            idx[i] = prev
        return idx
    a4 = _align(series_4h); a1 = _align(series_1h)

    # 步驟2 候選槽（固定 6 槽、優先序）：(series, key, name)。空單/多單各一組。
    if d == -1:
        SLOTS = [("1h", "bear_ob", "1H 空方訂單區"), ("4h", "bear_ob", "4H 空方訂單區"),
                 ("1h", "bear_fvg", "1H 空方缺口"), ("4h", "bear_fvg", "4H 空方缺口"),
                 ("1h", "res", "1H 阻力區"), ("4h", "res", "4H 阻力區")]
    else:
        SLOTS = [("1h", "bull_ob", "1H 多方訂單區"), ("4h", "bull_ob", "4H 多方訂單區"),
                 ("1h", "bull_fvg", "1H 多方缺口"), ("4h", "bull_fvg", "4H 多方缺口"),
                 ("1h", "sup", "1H 支撐區"), ("4h", "sup", "4H 支撐區")]
    # precision zone life：每槽追蹤 center/tests/wasInside（f_updatePrecisionZoneLife）
    _pcC = [None] * 6; _pcT = [0] * 6; _pcW = [False] * 6

    # 15M 逐棒狀態
    stage = 0; startBar = None
    zTop = zBot = None; zName = ""
    sweepPx = None; sweepBar = None; turnTrig = None; turnBar = None
    bosTrig = None; bosSetBar = None; bosBar = None
    entTop = entBot = None; entName = ""
    lastSH = lastSL = None; shBroken = slBroken = False; shSwept = slSwept = False

    def reset(to):
        nonlocal stage, startBar, zTop, zBot, zName, sweepPx, sweepBar, turnTrig, turnBar
        nonlocal bosTrig, bosSetBar, bosBar, entTop, entBot, entName
        stage = to; startBar = None if to == 0 else _i
        if to <= 1: zTop = zBot = None; zName = ""
        if to <= 2:
            sweepPx = sweepBar = turnTrig = turnBar = None
            bosTrig = bosSetBar = bosBar = None
        if to <= 5:
            entTop = entBot = None; entName = ""

    for _i in range(N):
        i = _i
        e4 = a4[i]; e1 = a1[i]
        t4 = e4["trend"] if e4 else 0
        ci = C[i]; cp = C[i - 1] if i > 0 else float("nan")
        # 15M 擺點/破/掃
        p = i - PL
        if p - PL >= 0:
            if _is_ph(H, p, PL): lastSH = H[p]; shBroken = False
            if _is_pl(L, p, PL): lastSL = L[p]; slBroken = False
        if ci != ci:
            continue
        bullBreak = lastSH is not None and not shBroken and ci > lastSH and (cp != cp or cp <= lastSH)
        bearBreak = lastSL is not None and not slBroken and ci < lastSL and (cp != cp or cp >= lastSL)
        if bullBreak: shBroken = True
        if bearBreak: slBroken = True
        bullSweep = lastSL is not None and not slSwept and L[i] < lastSL and ci > lastSL
        bearSweep = lastSH is not None and not shSwept and H[i] > lastSH and ci < lastSH
        if bullSweep: slSwept = True
        if bearSweep: shSwept = True
        if lastSL is not None and L[i] >= lastSL: slSwept = False
        if lastSH is not None and H[i] <= lastSH: shSwept = False

        biasPass = (t4 == d)
        # ── 失效退階(f_pathInvalidCode + 全域) ──
        if stage > 0:
            inv = 0
            if not biasPass or (bearBreak and d == 1) or (bullBreak and d == -1):
                inv = 1                                    # 方向規則不過/反向結構 → 重置
            elif startBar is not None and stage < 7 and i - startBar > MAXWAIT:
                inv = 2                                    # 超時 → 重置
            else:
                htfEdge = (zBot if d == 1 else zTop)
                if stage >= 2 and htfEdge is not None and (ci < htfEdge if d == 1 else ci > htfEdge):
                    inv = 3
                elif stage >= 3 and sweepPx is not None and (ci < sweepPx if d == 1 else ci > sweepPx):
                    inv = 4
                elif stage >= 6 and entTop is not None and (ci < entBot if d == 1 else ci > entTop):
                    inv = 5
            if inv:
                reset(0 if inv <= 2 else 1 if inv == 3 else 2 if inv == 4 else 5)

        # ── precision zone 生命週期（每根都更新；f_updatePrecisionZoneLife）：
        #   同一區被進入(inside 由外變內) tests+1；區被換掉(center 大位移)→ tests 歸零；tests≥3 該區用盡不再是有效進入。
        entryValid = [False] * 6
        for k in range(6):
            se, key, _nm = SLOTS[k]
            ent = e1 if se == "1h" else e4
            z = ent.get(key) if ent else None
            if not z:
                _pcC[k] = None; _pcT[k] = 0; _pcW[k] = False
                continue
            zu = max(z); zl = min(z); center = (zu + zl) / 2.0
            changed = (_pcC[k] is None) or abs(center - _pcC[k]) > max(zu - zl, 1e-12)
            tests = 0 if changed else _pcT[k]
            wasIn = False if changed else _pcW[k]
            inside = (H[i] >= zl and L[i] <= zu)
            if inside and not wasIn:
                tests += 1
            _pcC[k] = center; _pcT[k] = min(tests, 3); _pcW[k] = inside
            entryValid[k] = inside and tests < 3

        # ── 步驟推進 ──
        if stage == 0 and biasPass:
            stage = 1; startBar = i
        if stage <= 1 and biasPass:
            for k in range(6):                              # 依優先序取第一個「有效進入」的區
                if entryValid[k]:
                    se, key, nm = SLOTS[k]
                    ent = e1 if se == "1h" else e4
                    z = ent.get(key)
                    stage = 2; startBar = i; zTop, zBot, zName = max(z), min(z), nm
                    break
        if stage == 2 and ((d == 1 and bullSweep) or (d == -1 and bearSweep)):
            stage = 3; startBar = i; sweepBar = i
            sweepPx = (L[i] if d == 1 else H[i]); turnTrig = (lastSH if d == 1 else lastSL)
        if stage == 3 and turnTrig is None:
            turnTrig = (lastSH if d == 1 else lastSL)
        if stage == 3 and sweepBar is not None and i > sweepBar and turnTrig is not None and \
           ((d == 1 and ci > turnTrig) or (d == -1 and ci < turnTrig)):
            stage = 4; startBar = i; turnBar = i; bosTrig = None; bosSetBar = None
        if stage == 4 and bosTrig is None and turnBar is not None and p - PL >= 0 and p >= turnBar:
            if d == 1 and _is_ph(H, p, PL): bosTrig = H[p]; bosSetBar = i
            if d == -1 and _is_pl(L, p, PL): bosTrig = L[p]; bosSetBar = i
        if stage == 4 and bosTrig is not None and bosSetBar is not None and i > bosSetBar and \
           ((d == 1 and ci > bosTrig) or (d == -1 and ci < bosTrig)):
            stage = 5; startBar = i; bosBar = i
        if stage == 5 and bosBar is not None and i > bosBar:
            zone = _last_dir_zone_15m(H, L, C, O, T, i, bosBar, d, LB)
            if zone is not None and H[i] >= zone[1] and L[i] <= zone[0]:
                stage = 6; startBar = i; entTop, entBot, entName = zone[0], zone[1], zone[2]
                if touch_mode: stage = 7
        if stage == 6 and not touch_mode and entTop is not None:
            mid = (entTop + entBot) / 2.0
            if (d == 1 and ci > O[i] and ci > mid) or (d == -1 and ci < O[i] and ci < mid):
                stage = 7
    return {"stage": stage, "zone_top": zTop, "zone_bot": zBot, "zone_name": zName,
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
