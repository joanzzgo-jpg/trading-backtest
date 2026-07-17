# 逐筆歷史足跡：data.binance.vision 每日 aggTrades CSV（免費、零 API 權重）
#
# footprint.py 主源是「細 K 線聚合」（快、穩、量精確、價位到細K解析度）。本模組再往上補一層：
# 近幾天的「已收盤日」用官方每日成交 CSV 算出「逐筆精確」的每分鐘足跡，覆蓋掉那幾天的細K近似。
#   - 每天 CSV：BTC ~14MB（下載 ~15s）、解析 110 萬筆 ~0.6s、整天聚合結果 ~0.5MB。
#   - 硬碟永久快取（backend/cache/fp_csv/），下載+解析一次；之後零成本、零權重。
#   - 只做「已收盤日」；今天的檔案 data.binance.vision 尚未產出（隔日才有）→ 今天走細K/即時。
import gzip
import io
import math
import os
import pickle
import threading
import time
import urllib.request
import zipfile

_CSV_BASE = "https://data.binance.vision/data/futures/um/daily/aggTrades"
_DISK_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "cache", "fp_csv")
os.makedirs(_DISK_DIR, exist_ok=True)

_mem: dict = {}          # (sym, date, fine) -> {mts: {fidx:[b,s]}}（記憶體 LRU）
_mem_order: list = []
_MEM_MAX = 24            # 約 24 個 標的·日
_dl_active: dict = {}    # (sym, date, fine) -> True 下載去重
_miss: dict = {}         # (sym, date) -> ts：404/失敗的日，短期別再試
_lock = threading.Lock()


def _disk_path(sym, date, fine):
    return os.path.join(_DISK_DIR, f"{sym}-{date}-{fine:g}.pkl.gz")


def _mem_put(key, val):
    with _lock:
        if key not in _mem:
            _mem_order.append(key)
        _mem[key] = val
        while len(_mem_order) > _MEM_MAX:
            _mem.pop(_mem_order.pop(0), None)


def _parse_zip(raw: bytes, fine: float) -> dict:
    """aggTrades CSV → {minuteTs: {fineIdx:[買,賣]}}；is_buyer_maker=true 即主動賣"""
    zf = zipfile.ZipFile(io.BytesIO(raw))
    minute: dict = {}
    with zf.open(zf.namelist()[0]) as f:
        txt = io.TextIOWrapper(f, encoding="utf-8")
        first = txt.readline()
        lines = iter(txt)
        if "price" not in first.lower():        # 無表頭 → 第一行也是資料
            lines = _chain(first, txt)
        for line in lines:
            p = line.split(",")
            try:
                price = float(p[1]); qty = float(p[2]); ts = int(p[5])
                maker = p[6].strip().lower().startswith("t")
            except (IndexError, ValueError):
                continue
            mts = ts // 60000 * 60000
            cell = minute.get(mts)
            if cell is None:
                cell = minute[mts] = {}
            idx = math.floor(price / fine)
            bs = cell.get(idx)
            if bs is None:
                bs = cell[idx] = [0.0, 0.0]
            if maker:
                bs[1] += qty
            else:
                bs[0] += qty
    return minute


def _chain(first, rest):
    yield first
    for x in rest:
        yield x


def day_minutes(sym: str, date: str, fine: float):
    """回傳某已收盤日的 {minuteTs:{fineIdx:[買,賣]}}；沒有(未產出/無資料)回 None。
    記憶體→硬碟→下載解析，逐層快取。下載在呼叫端的背景執行緒中進行（此函式會阻塞該執行緒）。"""
    key = (sym, date, round(fine, 10))
    hit = _mem.get(key)
    if hit is not None:
        return hit
    dp = _disk_path(sym, date, fine)
    if os.path.exists(dp):
        try:
            with gzip.open(dp, "rb") as f:
                data = pickle.load(f)
            _mem_put(key, data)
            return data
        except Exception:
            try: os.remove(dp)
            except OSError: pass
    # 最近失敗過的日 → 10 分鐘內別再打
    m = _miss.get((sym, date))
    if m and time.time() - m < 600:
        return None
    with _lock:
        if _dl_active.get(key):
            return None                    # 別的執行緒正在下載同一天
        _dl_active[key] = True
    try:
        url = f"{_CSV_BASE}/{sym}/{sym}-aggTrades-{date}.zip"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=40).read()
        data = _parse_zip(raw, fine)
        with gzip.open(dp, "wb") as f:
            pickle.dump(data, f, protocol=4)
        _mem_put(key, data)
        return data
    except Exception:
        _miss[(sym, date)] = time.time()
        return None
    finally:
        with _lock:
            _dl_active.pop(key, None)
