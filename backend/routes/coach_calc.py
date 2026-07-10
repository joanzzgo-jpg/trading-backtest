"""教練(SR+SMC)純計算 helper — 從 routes/data.py 抽出（零副作用、無模組全域依賴、無 router）。
純函式：吃 snapshot/價格 → 回計算結果。給教練面板(smc_coach_api)、掃描(coach_scan)、回測共用。
⚠ 純搬移、邏輯零改動。data.py 仍 `from routes.coach_calc import *` 再匯出 → 既有 import 路徑不變。"""


def _coach_pos_in_channel(ch, price):
    if not ch or price is None:
        return "—"
    trend = "上升通道" if ch["dir"] == 1 else "下降通道"
    if price > ch["upper"]:
        return trend + "·上軌外"
    if price < ch["lower"]:
        return trend + "·下軌外"
    return trend + "·通道內"


def _coach_nearest_htf_zone(snap, direction, price):
    """市場位置：方向為空取上方最近未填補空缺口；為多取下方最近未填補多缺口。"""
    if not snap or price is None:
        return None
    fvg = snap.get("fvg") or {"l": [], "s": []}
    if direction == -1:
        cands = [z for z in fvg["s"] if max(z["top"], z["bot"]) > price]
        if cands:
            z = min(cands, key=lambda z: min(z["top"], z["bot"]) - price)
            return {"side": "上方", "kind": "空方缺口", "top": z["top"], "bot": z["bot"]}
    elif direction == 1:
        cands = [z for z in fvg["l"] if min(z["top"], z["bot"]) < price]
        if cands:
            z = max(cands, key=lambda z: max(z["top"], z["bot"]) - price)
            return {"side": "下方", "kind": "多方缺口", "top": z["top"], "bot": z["bot"]}
    return None


def _coach_tp_list(snaps, direction, price, n=4):
    """多段止盈 TP1～TP4（對齊 Pine POSITION_MAX_TP=4）：用 1H/4H 支撐/阻力區，
    依離進場價由近到遠取前 n 個「近邊」出場價。多→上方阻力區(近邊=下緣)；空→下方支撐區(近邊=上緣)。
    跨時框匯總、過近(<0.1%)去重。"""
    if price is None:
        return []
    cands = []
    for snap in snaps:
        if not snap:
            continue
        sr = snap.get("sr") or {"res": [], "sup": []}
        fvg = snap.get("fvg") or {"l": [], "s": []}
        if direction == 1:                                   # 多：上方阻力區/空缺口，近邊＝下緣
            for z in sr.get("res", []) + fvg.get("s", []):   # SR 阻力 + 空FVG(反向缺口)當離場目標
                edge = min(z["top"], z["bot"])
                if edge > price:
                    cands.append((edge, edge - price))
        elif direction == -1:                                # 空：下方支撐區/多缺口，近邊＝上緣
            for z in sr.get("sup", []) + fvg.get("l", []):
                edge = max(z["top"], z["bot"])
                if edge < price:
                    cands.append((edge, price - edge))
    cands.sort(key=lambda x: x[1])                           # 依距離近→遠
    out = []
    for edge, _d in cands:
        if any(abs(edge - m) <= abs(price) * 0.001 for m in out):   # 過近去重
            continue
        out.append(edge)
        if len(out) >= n:
            break
    return out


def _coach_all_named(snap, tfname):
    """某時框全部有效區（雙向 OB/FVG + SR），帶名稱。給「市場位置」用。"""
    if not snap:
        return []
    out = []
    for side, dl in (("l", "多"), ("s", "空")):
        for z in (snap.get("ob") or {}).get(side, []):
            out.append((z["top"], z["bot"], f"{tfname} {dl}方訂單區"))
        for z in (snap.get("fvg") or {}).get(side, []):
            out.append((z["top"], z["bot"], f"{tfname} {dl}方缺口"))
    for k, kl in (("res", "阻力"), ("sup", "支撐")):
        for z in (snap.get("sr") or {}).get(k, []):
            out.append((z["top"], z["bot"], f"{tfname} {kl}區"))
    return out


def _coach_current_zone(s4h, s1h, price):
    """市場位置：目前價格所在的區（1H 優先），否則最近的區。"""
    if price is None:
        return None
    zs = _coach_all_named(s1h, "1H") + _coach_all_named(s4h, "4H")
    inside = [z for z in zs if min(z[0], z[1]) <= price <= max(z[0], z[1])]
    if inside:
        z = min(inside, key=lambda z: abs((z[0] + z[1]) / 2 - price))
        return {"inside": True, "kind": z[2], "top": z[0], "bot": z[1]}
    if zs:
        z = min(zs, key=lambda z: min(abs(price - z[0]), abs(price - z[1])))
        return {"inside": False, "kind": z[2], "top": z[0], "bot": z[1]}
    return None
