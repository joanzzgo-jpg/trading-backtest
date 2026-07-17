# Footprint（足跡圖）指標：每根 K 棒內「各價位的主動買量 / 主動賣量」——全時框逐筆精確
#
# 架構（2026-07-17 精確化改版）：
#   「分鐘級足跡倉」_minute_store：aggTrades（m=isBuyerMaker 給主動方向）逐筆算出
#   每個已收盤分鐘的 {細桶idx: [買,賣]}，永久快取（記憶體、LRU 上限）。
#   任何時框的棒 = 其分鐘格子的聚合 → 15m/30m/1h 也是逐筆精確、且跨時框共用快取
#   （看過 15m 再切 1h，重疊的分鐘直接命中不重抓）。
#
# 限流防護（aggTrades 權重 20/次，貴）：
#   - 每次請求「呼叫預算」_CALL_BUDGET=40（≈800 權重）；抓不完 → 回應帶 pending_min
#     （尚缺的分鐘數），前端輪詢下次續抓 → 漸進補齊，補完就全精確、之後只重抓未收盤分鐘。
#   - 逐棒「整段連續翻頁」而非逐分鐘打（冷門幣一根 1h 棒可能只要 1~2 次呼叫）。
#   - 全走 data.crypto._binance_get → 繼承 418/429 全域熔斷＋權重軟節流。
#
# 價位桶：細桶 fine_bin 依標的黏著（近 60 根 1m 平均全長/5 取漂亮階梯；價格劇變 >50% 才重算並清倉）；
#   顯示桶 bin = fine_bin 的整數倍（貼近該時框平均全長/12）→ 聚合無縫、無浮點錯位。
from fastapi import APIRouter, Query
import math
import threading
import time
from datetime import datetime, timezone

from data import crypto as _crypto

router = APIRouter(tags=["footprint"])

_TF_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
          "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
# 近端「逐筆精確」窗口（aggTrades，權重貴 → 漸進補齊）
_BARS_CAP = {"1m": 20, "5m": 12, "15m": 12, "30m": 10, "1h": 8, "4h": 0, "1d": 0}
# 歷史總深度（近端之外用「細 K 線聚合」補：量=交易所實數 takerBuy、價位歸屬到細K的高低區；
# 算一次就進快取，之後零成本）。全歷史逐筆物理上不可行（1d 一根數百萬筆 aggTrades）。
_HIST_CAP = {"1m": 360, "5m": 360, "15m": 360, "30m": 240, "1h": 240, "4h": 240, "1d": 240}
# 歷史聚合用的細 K 線時框：≤1h 用 1m；4h 用 5m（48 子棒/根）；1d 用 15m（96 子棒/根）
_SUB_TF = {"1m": "1m", "5m": "1m", "15m": "1m", "30m": "1m", "1h": "1m", "4h": "5m", "1d": "15m"}
_SUB_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000}
_KLINE_TFS = {"4h", "1d"}          # 全程走細K聚合（近端逐筆窗口=0）
_HIST_KLINE_BUDGET = 16            # 每次請求最多幾次「歷史細K」呼叫（1500 根/次、權重個位數）

# ── 足跡專屬權重閘門（滑動 60s 窗）──────────────────────────────
# Railway 全站共用一個出口 IP → fapi 權重 2400/分是「所有使用者+所有功能」共用。
# 足跡冷啟動很吃 aggTrades（20/次）→ 不設上限的話，多人同開就會把報價/勝率/教練
# 擠到被軟節流跳過。這裡把足跡整體限制在 800 權重/分（全站 1/3）：超過就本輪不抓、
# 回 pending/partial 讓前端下輪輪詢續補（補齊變慢，但其他功能永遠有 2/3 額度）。
_FP_W_CAP = 800
_FP_W_LOG: list = []               # [(ts, cost), ...] 60s 滑動窗
_W_AGG, _W_KL_BIG, _W_KL_SMALL = 20, 10, 2   # aggTrades / klines(1500) / klines(小)


def _fp_gate(cost: int) -> bool:
    """足跡權重閘門：60s 窗內累計 + cost 不超過 _FP_W_CAP 才放行（放行即記帳）"""
    now = time.time()
    with _lock:
        while _FP_W_LOG and now - _FP_W_LOG[0][0] > 60:
            _FP_W_LOG.pop(0)
        used = sum(c for _, c in _FP_W_LOG)
        if used + cost > _FP_W_CAP:
            return False
        _FP_W_LOG.append((now, cost))
        return True
_CALL_BUDGET = 40            # 每次請求最多幾次 aggTrades 呼叫（×20 權重）
_MIN_MS = 60_000

_lock = threading.Lock()
_minute_store: dict = {}     # (sym, minuteTs) -> {fineIdx: [buy, sell]}（僅完整覆蓋的已收盤分鐘）
_minute_order: list = []     # FIFO 清理
_MINUTE_MAX = 6000           # ≈ 100 小時·標的 混合上限
_sym_fine: dict = {}         # sym -> (fine_bin, ref_close)
_resp_cache: dict = {}       # key -> (ts, payload)：短 TTL 吸收多分頁；漸進補齊要新鮮 → 2s


def _nice_step(x: float) -> float:
    """把任意正數收斂到 1/2/2.5/5×10^k 的漂亮階梯（價位桶大小用）"""
    if x <= 0:
        return 1.0
    exp = math.floor(math.log10(x))
    base = x / (10 ** exp)
    for m in (1, 2, 2.5, 5, 10):
        if base <= m:
            return m * (10 ** exp)
    return 10.0 ** (exp + 1)


def _iso_utc(ms: int) -> str:
    # 鐵則：後端傳前端的時間戳一律 isoformat（naive UTC，前端 toTime() 統一 +8）
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None).isoformat()


def _fetch_tf_klines(sym: str, tf: str, limit: int) -> list:
    # klines 權重個位數 → 給一次重試吃掉偶發 timeout（aggTrades 權重 20 就不重試）
    url = f"{_crypto.BINANCE_FAPI_BASE}/fapi/v1/klines?symbol={sym}&interval={tf}&limit={limit}"
    return _crypto._binance_get(url, timeout=10, retries=1)


def _fine_bin_for(sym: str) -> float:
    """細桶大小（黏著）：近 60 根 1m 平均全長/5；價格劇變 >50% 重算並清該標的分鐘倉"""
    cur = _sym_fine.get(sym)
    kl = None
    if cur is None:
        kl = _fetch_tf_klines(sym, "1m", 60)
    else:
        return cur[0]
    if not kl:
        raise RuntimeError("無 1m K 線資料")
    ranges = [float(k[2]) - float(k[3]) for k in kl if float(k[2]) > float(k[3])]
    close = float(kl[-1][4])
    avg = (sum(ranges) / len(ranges)) if ranges else close * 0.0005
    fine = _nice_step(max(avg / 5, close * 5e-7))
    _sym_fine[sym] = (fine, close)
    return fine


def _fine_regime_check(sym: str, last_close: float):
    """價格量級劇變（>50%）→ 細桶失真 → 重算並清掉該標的舊分鐘格"""
    cur = _sym_fine.get(sym)
    if cur and cur[1] > 0 and abs(last_close - cur[1]) / cur[1] > 0.5:
        _sym_fine.pop(sym, None)
        with _lock:
            for k in [k for k in _minute_store if k[0] == sym]:
                _minute_store.pop(k, None)
            _minute_order[:] = [k for k in _minute_order if k[0] != sym]


def _store_get(sym: str, mts: int):
    return _minute_store.get((sym, mts))


def _store_put(sym: str, mts: int, rows: dict):
    with _lock:
        key = (sym, mts)
        if key not in _minute_store:
            _minute_order.append(key)
        _minute_store[key] = rows
        while len(_minute_order) > _MINUTE_MAX:
            _minute_store.pop(_minute_order.pop(0), None)


class _Budget:
    def __init__(self, n): self.left = n
    def take(self):
        if self.left <= 0:
            return False
        self.left -= 1
        return True


def _fetch_span_minutes(sym: str, span_s: int, span_e: int, fine: float,
                        budget: "_Budget", now_ms: int, overlay: dict) -> None:
    """連續翻頁抓 [span_s, span_e) 的 aggTrades，切成分鐘格：
    - 完整覆蓋的已收盤分鐘 → 進永久倉
    - 未收盤（正在走的）分鐘 → 只放 overlay 給本次回應用，不進倉
    預算不夠翻到底 → 只提交「確定完整」的分鐘（覆蓋到最後一筆成交的時間為準），其餘留給下輪。"""
    acc: dict = {}          # mts -> {fineIdx: [b, s]}
    covered_to = span_s     # 已確定完整覆蓋到（exclusive）
    t0 = span_s
    while t0 < span_e:
        if not budget.take() or not _fp_gate(_W_AGG):
            break           # 每請求預算或全站足跡權重閘門到頂 → 下輪續補
        url = (f"{_crypto.BINANCE_FAPI_BASE}/fapi/v1/aggTrades?symbol={sym}"
               f"&startTime={t0}&endTime={span_e - 1}&limit=1000")
        chunk = _crypto._binance_get(url, timeout=10, retries=0)
        if not chunk:
            covered_to = span_e
            break
        for t in chunk:
            ts = int(t["T"])
            mts = ts // _MIN_MS * _MIN_MS
            cell = acc.setdefault(mts, {})
            idx = math.floor(float(t["p"]) / fine)
            bs = cell.setdefault(idx, [0.0, 0.0])
            if t["m"]:
                bs[1] += float(t["q"])
            else:
                bs[0] += float(t["q"])
        if len(chunk) < 1000:
            covered_to = span_e
            break
        covered_to = int(chunk[-1]["T"]) + 1
        t0 = covered_to
    # 提交：分鐘完整覆蓋（m_end <= covered_to）才算數
    for mts, rows in acc.items():
        m_end = mts + _MIN_MS
        if m_end > covered_to:
            continue            # 尾巴沒翻完的分鐘 → 丟棄，下輪重抓（浪費 ≤1 頁）
        if m_end <= now_ms:
            _store_put(sym, mts, rows)
        overlay[mts] = rows      # 已收盤進倉；未收盤分鐘只給本次用
    # 也把「時間已走完但這段根本沒成交」的分鐘記為空格（否則冷門幣永遠 pending）
    if covered_to >= span_e:
        mts = span_s
        while mts + _MIN_MS <= min(span_e, now_ms):
            if mts not in acc and _store_get(sym, mts) is None:
                _store_put(sym, mts, {})
            mts += _MIN_MS


def _pack_bar(bar_ts: int, rows: dict, bin_size: float, exact: bool) -> dict:
    dec = max(0, -math.floor(math.log10(bin_size))) if bin_size < 1 else 0
    out_rows, delta, total = [], 0.0, 0.0
    poc_p, poc_v = None, -1.0
    for idx in sorted(rows.keys()):
        b, s = rows[idx]
        if b <= 0 and s <= 0:
            continue
        p = round(idx * bin_size, dec + 2)
        out_rows.append([p, round(b, 3), round(s, 3)])
        delta += b - s
        total += b + s
        if b + s > poc_v:
            poc_v, poc_p = b + s, p
    return {"t": _iso_utc(bar_ts), "rows": out_rows, "x": exact,
            "d": round(delta, 3), "v": round(total, 3), "poc": poc_p}


_hist_cache: dict = {}      # (sym, tf, barTs, bin) -> 打包好的歷史棒（已收盤、聚合一次永久快取）
_hist_order: list = []
_HIST_MAX = 20000


def _hist_cache_put(key, bar):
    with _lock:
        if key not in _hist_cache:
            _hist_order.append(key)
        _hist_cache[key] = bar
        while len(_hist_order) > _HIST_MAX:
            _hist_cache.pop(_hist_order.pop(0), None)


def _fetch_sub_paged(sym: str, sub_tf: str, start_ms: int, end_ms: int, budget: list) -> list:
    """分頁抓 [start,end) 的細 K 線（1500 根/頁、權重個位數）；budget=[剩餘呼叫數]"""
    out, t0 = [], start_ms
    sub_ms = _SUB_MS[sub_tf]
    while t0 < end_ms and budget[0] > 0:
        if not _fp_gate(_W_KL_BIG):
            break           # 足跡權重閘門到頂 → partial，下輪續補
        budget[0] -= 1
        url = (f"{_crypto.BINANCE_FAPI_BASE}/fapi/v1/klines?symbol={sym}&interval={sub_tf}"
               f"&startTime={t0}&endTime={end_ms - 1}&limit=1500")
        chunk = _crypto._binance_get(url, timeout=10, retries=1)
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < 1500:
            break
        t0 = int(chunk[-1][0]) + sub_ms
    return out


def _rows_add_subkline(rows: dict, k: list, bin_size: float):
    """細 K 線 → 顯示桶：量依 takerBuy 比例（交易所實數＝量精確）、攤進該細棒高低區覆蓋的桶"""
    hi, lo = float(k[2]), float(k[3])
    vol = float(k[5]); tb = float(k[9])
    if vol <= 0:
        return
    i0 = math.floor(lo / bin_size)
    i1 = math.floor(hi / bin_size)
    m = max(1, i1 - i0 + 1)
    b, s = tb / m, (vol - tb) / m
    for idx in range(i0, i1 + 1):
        bs = rows.setdefault(idx, [0.0, 0.0])
        bs[0] += b
        bs[1] += s


def _bars_via_subklines(sym: str, tf: str, starts: list, now_ms: int, bin_size: float):
    """歷史棒（含 4h/1d 全程）：細 K 線聚合。已收盤棒快取（鍵含 bin → bin 漂移自動重算）；
    缺的棒取連續缺口逐段抓、每請求呼叫上限 _HIST_KLINE_BUDGET → 首次深歷史也不會爆權重。
    回 (bars, partial)。"""
    if not starts:
        return [], False
    tf_ms = _TF_MS[tf]
    sub_tf = _SUB_TF[tf]
    budget = [_HIST_KLINE_BUDGET]
    partial = False
    fetched: dict = {}
    need = []
    for ts in starts:
        closed = ts + tf_ms <= now_ms
        if closed and (sym, tf, ts, bin_size) in _hist_cache:
            continue
        need.append(ts)
    i = 0
    while i < len(need):
        j = i
        while j + 1 < len(need) and need[j + 1] == need[j] + tf_ms:
            j += 1
        span_s, span_e = need[i], min(need[j] + tf_ms, now_ms)
        if budget[0] <= 0:
            partial = True
            break
        kl = _fetch_sub_paged(sym, sub_tf, span_s, span_e, budget)
        for k in kl:
            bts = int(k[0]) // tf_ms * tf_ms
            if span_s <= bts < span_e:
                _rows_add_subkline(fetched.setdefault(bts, {}), k, bin_size)
        cov = (int(kl[-1][0]) + _SUB_MS[sub_tf]) if kl else span_s
        if cov < span_e and budget[0] <= 0:
            partial = True     # 預算切在段中間 → 下次請求續補（沒快取的棒會重列 need）
        for ts in need[i:j + 1]:
            if ts in fetched and ts + tf_ms <= now_ms and ts + tf_ms <= cov:
                _hist_cache_put((sym, tf, ts, bin_size),
                                _pack_bar(ts, fetched[ts], bin_size, True))
        i = j + 1
    # 只要還有「該收而未快取」的棒就標 partial（含被權重閘門擋下的情況）→ 前端下輪續補
    for ts in need:
        if ts + tf_ms <= now_ms and (sym, tf, ts, bin_size) not in _hist_cache:
            partial = True
            break
    bars = []
    for ts in starts:
        closed = ts + tf_ms <= now_ms
        cached = _hist_cache.get((sym, tf, ts, bin_size)) if closed else None
        if cached is not None:
            bars.append(cached)
        elif fetched.get(ts):
            bars.append(_pack_bar(ts, fetched[ts], bin_size, True))
    return bars, partial


def _build(sym: str, tf: str, n: int) -> dict:
    tf_ms = _TF_MS[tf]
    now_ms = int(time.time() * 1000)
    cur_start = now_ms // tf_ms * tf_ms
    starts = [cur_start - i * tf_ms for i in range(n - 1, -1, -1)]

    # 顯示桶：該時框近 n 根平均全長/12
    kl = _fetch_tf_klines(sym, tf, n)
    if not kl:
        return {"ok": False, "err": "無K線資料"}
    last_close = float(kl[-1][4])
    ranges = [float(k[2]) - float(k[3]) for k in kl if float(k[2]) > float(k[3])]
    avg_rng = (sum(ranges) / len(ranges)) if ranges else last_close * 0.002

    # 4h/1d：全程細 K 線聚合（4h←5m、1d←15m；量精確、已收盤棒快取）
    if tf in _KLINE_TFS:
        bin_size = _nice_step(max(avg_rng / 12, last_close * 1e-6))
        bars, hpart = _bars_via_subklines(sym, tf, starts, now_ms, bin_size)
        return {"ok": True, "symbol": sym, "tf": tf, "bin": bin_size,
                "approx": False, "kagg": True, "partial": hpart, "pending_min": 0,
                "bars": bars}

    # 1m~1h：近端 aggTrades 逐筆精確 + 更早歷史 1m K 線聚合
    _fine_regime_check(sym, last_close)
    fine = _fine_bin_for(sym)
    k_mult = max(1, round((avg_rng / 12) / fine))
    bin_size = fine * k_mult
    recent_n = min(_BARS_CAP[tf], n)
    recent_starts = starts[-recent_n:] if recent_n else []
    hist_starts = starts[:-recent_n] if recent_n < n else []
    hist_bars, hpart = _bars_via_subklines(sym, tf, hist_starts, now_ms, bin_size)
    starts = recent_starts

    budget = _Budget(_CALL_BUDGET)
    overlay: dict = {}       # 本次抓到的分鐘（含未收盤分鐘）
    # 新的棒優先補（使用者看的是最近），棒內缺的分鐘取連續缺口逐段翻頁
    for ts in reversed(starts):
        bar_end = min(ts + tf_ms, now_ms)
        span_s = None
        mts = ts
        while mts < bar_end:
            closed = mts + _MIN_MS <= now_ms
            have = (_store_get(sym, mts) is not None) if closed else (mts in overlay)
            if not have and span_s is None:
                span_s = mts
            elif have and span_s is not None:
                _fetch_span_minutes(sym, span_s, mts, fine, budget, now_ms, overlay)
                span_s = None
            if budget.left <= 0:
                break
            mts += _MIN_MS
        if span_s is not None and budget.left > 0:
            _fetch_span_minutes(sym, span_s, bar_end, fine, budget, now_ms, overlay)
        if budget.left <= 0:
            break

    # 組棒：分鐘格聚合到顯示桶；缺分鐘的棒標 x=false（用已有的先畫）
    bars, pending_min = [], 0
    for ts in starts:
        bar_end = min(ts + tf_ms, now_ms)
        rows: dict = {}
        missing = 0
        mts = ts
        while mts < bar_end:
            closed = mts + _MIN_MS <= now_ms
            cell = _store_get(sym, mts) if closed else overlay.get(mts)
            if cell is None and closed:
                missing += 1
            elif cell:
                # 細桶 idx → 顯示桶 idx（bin = fine × k_mult，整除無縫）
                for fidx, (b, s) in cell.items():
                    didx = fidx // k_mult if k_mult > 1 else fidx
                    bs = rows.setdefault(didx, [0.0, 0.0])
                    bs[0] += b
                    bs[1] += s
            mts += _MIN_MS
        pending_min += missing
        if rows or missing == 0:
            bars.append(_pack_bar(ts, rows, bin_size, missing == 0))

    return {"ok": True, "symbol": sym, "tf": tf, "bin": bin_size,
            "approx": False, "partial": pending_min > 0 or hpart,
            "pending_min": pending_min, "bars": hist_bars + bars}


@router.get("/api/footprint")
def get_footprint(symbol: str = Query(...), tf: str = Query("1m"), bars: int = Query(0)):
    tf = tf.lower()
    if tf not in _TF_MS:
        return {"ok": False, "err": f"footprint 不支援 {tf}（限 1m/5m/15m/30m/1h）"}
    sym = symbol.replace(".P", "").replace("/", "").upper()
    if not sym.isalnum():
        return {"ok": False, "err": "標的格式不正確"}
    n = max(4, min(bars or _HIST_CAP[tf], _HIST_CAP[tf]))
    key = f"{sym}:{tf}:{n}"
    now = time.time()
    hit = _resp_cache.get(key)
    if hit and now - hit[0] < 2:      # 漸進補齊需要新鮮 → 只擋同秒內的重複請求
        return hit[1]
    try:
        payload = _build(sym, tf, n)
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {e}"}
    if payload.get("ok"):
        _resp_cache[key] = (time.time(), payload)
        if len(_resp_cache) > 200:
            _resp_cache.pop(next(iter(_resp_cache)), None)
    return payload
