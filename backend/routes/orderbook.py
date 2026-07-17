# 掛單牆（Order Book Wall）：即時盤口大掛單偵測 + 假單判定
#
# footprint 記錄「已成交」的量（測謊機：假單不會留下成交）；本模組補上另一半——
# 「還掛著、尚未成交」的大單（牆），並在牆消失時判斷是「被市價吃掉」還是「被撤走（疑似假單）」：
#   - 牆價位被行情掃到後才消失 → eaten（真防守，有真金白銀成交）
#   - 行情根本沒碰到、牆卻不見了 → pulled（撤單，spoof 特徵）
#
# 資料源：fapi /depth?limit=100（權重 5）。掛單簿只有即時、沒有歷史 → 僅 crypto 即時可用。
# 多人共用：整包計算結果快取 1.5s（熱門幣一次抓服務所有觀看者）＋權重閘門（全站上限）。
from fastapi import APIRouter, Query
import threading
import time

from data import crypto as _crypto

router = APIRouter(tags=["orderbook"])

_DEPTH_W = 5                 # /depth?limit=100 權重
_OB_W_CAP = 400             # 掛單牆整體權重上限（60s 滑動窗）
_OB_W_LOG: list = []
_lock = threading.Lock()

_ob_cache: dict = {}        # sym -> (ts, payload)：整包結果 1.5s 快取（多觀看者共用一次抓取）
_wall_store: dict = {}      # sym -> { (side, priceStr): {first, last, qty} } 追蹤牆生命週期
_last_mid: dict = {}        # sym -> (mid, ts) 上次中價（判斷牆消失時行情有沒有掃到）
_events: dict = {}          # sym -> [ {ts, side, price, qty, kind} ] 近 90s 假單/被吃事件
_WALL_MIN_LIFE = 2.5        # 牆至少存活幾秒才納入 eaten/pulled 判定（濾掉正常盤口抖動）


def _ob_gate(cost: int) -> bool:
    now = time.time()
    with _lock:
        while _OB_W_LOG and now - _OB_W_LOG[0][0] > 60:
            _OB_W_LOG.pop(0)
        if sum(c for _, c in _OB_W_LOG) + cost > _OB_W_CAP:
            return False
        _OB_W_LOG.append((now, cost))
        return True


def _find_walls(levels, mid, window=0.02):
    """近價窗（±window）內，掛單金額 ≥ 5×中位數的價位＝牆；回 [(price, qty, notional)] 依金額降序，最多 8 檔"""
    near = [(p, q) for p, q in levels if q > 0 and mid > 0 and abs(p - mid) / mid <= window]
    if len(near) < 3:
        near = [(p, q) for p, q in levels[:60] if q > 0]
    if not near:
        return []
    notionals = sorted(p * q for p, q in near)
    med = notionals[len(notionals) // 2] or (notionals[0] if notionals else 0)
    total = sum(notionals)
    thr = max(med * 6, total * 0.04)   # ≥6×中位數 且 ≥近價窗總掛額 4% → 濾掉貼盤正常流動性
    walls = [(p, q, p * q) for p, q in near if p * q >= thr]
    walls.sort(key=lambda x: -x[2])
    return walls[:6]


def _track(sym: str, walls, mid: float, now: float):
    """更新牆生命週期，牆消失時判 eaten / pulled，寫入 _events"""
    store = _wall_store.setdefault(sym, {})
    cur = {}
    for side, p, q, _ in walls:
        cur[(side, f"{p}")] = q
    # 新出現 / 持續存在
    for key, q in cur.items():
        rec = store.get(key)
        if rec is None:
            store[key] = {"first": now, "last": now, "qty": q}
        else:
            rec["last"] = now
            rec["qty"] = max(rec["qty"], q)   # 記最大掛量（撤單前的規模）
    prev_mid = _last_mid.get(sym, (mid, now))[0]
    lo, hi = min(prev_mid, mid), max(prev_mid, mid)
    evs = _events.setdefault(sym, [])
    # 消失的牆（上次在、這次不在）
    for key, rec in list(store.items()):
        if key in cur:
            continue
        side, ps = key
        p = float(ps)
        lived = rec["last"] - rec["first"]
        # 剛消失（last 就是上一輪 now 附近）且活夠久才判定
        if now - rec["last"] <= 3.5 and lived >= _WALL_MIN_LIFE:
            touched = lo - p * 1e-4 <= p <= hi + p * 1e-4  # 行情區間掃到牆價（含微容差）
            evs.append({"ts": now, "side": side, "price": p,
                        "qty": round(rec["qty"], 3),
                        "kind": "eaten" if touched else "pulled"})
        store.pop(key, None)
    _last_mid[sym] = (mid, now)
    # 事件保留 90s
    _events[sym] = [e for e in evs if now - e["ts"] <= 90]


def _build(sym: str) -> dict:
    if not _ob_gate(_DEPTH_W):
        return {"ok": False, "busy": True, "err": "盤口權重繁忙，稍後重試"}
    url = f"{_crypto.BINANCE_FAPI_BASE}/fapi/v1/depth?symbol={sym}&limit=100"
    d = _crypto._binance_get(url, timeout=8, retries=0)
    bids = [(float(p), float(q)) for p, q in d.get("bids", [])]
    asks = [(float(p), float(q)) for p, q in d.get("asks", [])]
    if not bids or not asks:
        return {"ok": False, "err": "盤口為空"}
    mid = (bids[0][0] + asks[0][0]) / 2
    now = time.time()
    bw = [("bid", p, q, n) for p, q, n in _find_walls(bids, mid)]
    aw = [("ask", p, q, n) for p, q, n in _find_walls(asks, mid)]
    _track(sym, bw + aw, mid, now)
    dec = 8
    walls = [{"side": s, "p": round(p, dec), "q": round(q, 3), "n": round(n)}
             for s, p, q, n in sorted(bw + aw, key=lambda x: -x[3])]
    # 買賣壓力比（近價窗掛單總額）：>1 買方掛得多
    bid_sum = sum(p * q for p, q in bids)
    ask_sum = sum(p * q for p, q in asks)
    events = [{"ts_age": round(now - e["ts"], 1), "side": e["side"],
               "p": round(e["price"], dec), "q": e["qty"], "kind": e["kind"]}
              for e in _events.get(sym, [])]
    return {"ok": True, "symbol": sym, "mid": round(mid, dec), "walls": walls,
            "imbalance": round(bid_sum / ask_sum, 2) if ask_sum else None,
            "events": events}


@router.get("/api/orderbook")
def get_orderbook(symbol: str = Query(...)):
    sym = symbol.replace(".P", "").replace("/", "").upper()
    if not sym.isalnum():
        return {"ok": False, "err": "標的格式不正確"}
    now = time.time()
    hit = _ob_cache.get(sym)
    if hit and now - hit[0] < 1.5:
        return hit[1]
    try:
        payload = _build(sym)
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}"}
    if payload.get("ok"):
        _ob_cache[sym] = (time.time(), payload)
        if len(_ob_cache) > 200:
            _ob_cache.pop(next(iter(_ob_cache)), None)
    return payload
