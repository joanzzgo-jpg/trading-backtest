"""經濟事件發佈時間 → 主圖垂直線標記（NFP / CPI / FOMC）。

時間一律以 America/New_York 定義 → 自動處理美國日光節約 → 轉成 UTC unix 秒給前端。
  NFP 非農就業：每月第一個星期五 08:30 ET（公式，真自動、免抓；偶爾落第二個週五，屬近似）。
  CPI 消費者物價：08:30 ET。BLS 擋爬蟲(403)；改走 FRED release/dates（需 FRED_API_KEY，免費）
                 → 有金鑰就自動延伸，沒金鑰退回內建日期表(需定期核對)。
  FOMC 利率聲明：14:00 ET（會議第二天）。Fed 官網可抓 → 自動更新，內建 2025–26 當 fallback。

Fed 抓取採「保守採用」：某年**剛好**解析出 8 場(FOMC 固定一年 8 場)才採用該年，
否則忽略該年、退回內建 → 官網改版/解析壞掉也不會標錯，只是不自動延伸。
"""
import re
import os
import json
import time
import tempfile
import urllib.request
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter

router = APIRouter()

_ET = ZoneInfo("America/New_York")
_UTC = ZoneInfo("UTC")


def _unix(d: date, hh: int, mm: int) -> int:
    """某 ET 日期時刻 → UTC unix 秒（自動 DST）。"""
    return int(datetime(d.year, d.month, d.day, hh, mm, tzinfo=_ET).astimezone(_UTC).timestamp())


def _first_friday(y: int, m: int) -> date:
    d = date(y, m, 1)
    return d + timedelta(days=(4 - d.weekday()) % 7)   # weekday: Mon=0..Fri=4


# FOMC 決策日（會議第二天）內建 fallback。已由 Fed 官網核對。
_FOMC_FALLBACK = {
    2025: [(1, 29), (3, 19), (5, 7), (6, 18), (7, 30), (9, 17), (10, 29), (12, 10)],
    2026: [(1, 28), (3, 18), (4, 29), (6, 17), (7, 29), (9, 16), (10, 28), (12, 9)],
}
# CPI 發佈日 08:30 ET。內建表是**底**；設了 FRED_API_KEY 就會自動延伸（見 _cpi_by_year）。
# ★ 沒有金鑰時這張表就是全部 → 表用完那天起 CPI 標記會**安靜消失**（不報錯）。
#   check_econ_events.py 會在剩不到 120 天時叫。
# ⚠ 不要用「第 N 個週幾」外推：實測 2025-26 這 24 筆落在週二 8／週三 8／週四 6／週五 2，
#   而且 2025-10-24 差了整整兩週（當年政府停擺順延）→ 外推出來的線看起來很權威、其實是錯的。
_CPI = {
    2025: [(1, 15), (2, 12), (3, 12), (4, 10), (5, 13), (6, 11), (7, 15), (8, 12), (9, 11), (10, 24), (11, 13), (12, 18)],
    2026: [(1, 13), (2, 11), (3, 11), (4, 10), (5, 12), (6, 10), (7, 14), (8, 12), (9, 15), (10, 13), (11, 12), (12, 10)],
}

_MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June",
     "July", "August", "September", "October", "November", "December"], start=1)}

_FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
_CACHE_FILE = os.path.join(tempfile.gettempdir(), "econ_fomc_cache.json")
_FETCH_TTL = 7 * 86400   # Fed 抓取快取 7 天（FOMC 日期一年只公告一次）


def _parse_fed(html: str) -> dict:
    """解析 Fed 行事曆 → {year: [(month, decision_day), ...]}。只收「剛好 8 場」的年份。"""
    out = {}
    marks = [(m.start(), int(m.group(1))) for m in re.finditer(r"(20\d\d)\s+FOMC Meetings", html)]
    if not marks:
        return out
    marks.append((len(html), None))
    for i in range(len(marks) - 1):
        s, y = marks[i]
        e = marks[i + 1][0]
        seg = html[s:e]
        months = re.findall(r'fomc-meeting__month[^>]*>\s*(?:<strong>\s*)?([A-Za-z]{3,9})', seg)
        dates = re.findall(r'fomc-meeting__date[^>]*>\s*([0-9]{1,2})(?:-([0-9]{1,2}))?', seg)
        if len(months) != len(dates):
            continue
        got = []
        ok = True
        for mo, (d1, d2) in zip(months, dates):
            mi = _MONTHS.get(mo)
            if not mi:
                ok = False
                break
            dd = int(d2) if (d2 and int(d2) >= int(d1)) else int(d1)   # 決策日=範圍第二天(同月才採)
            got.append((mi, dd))
        if ok and len(got) == 8:      # FOMC 固定一年 8 場 → 剛好 8 場才信
            out[y] = got
    return out


def _fomc_by_year() -> dict:
    """FOMC 決策日：Fed 官網(快取)為主、內建為底；抓不到/解析不過就用內建。"""
    fetched = {}
    try:
        cache = None
        if os.path.exists(_CACHE_FILE) and (time.time() - os.path.getmtime(_CACHE_FILE) < _FETCH_TTL):
            with open(_CACHE_FILE, "r") as f:
                cache = json.load(f)
        if cache is None:
            req = urllib.request.Request(_FED_URL, headers={"User-Agent": "Mozilla/5.0"})
            html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
            cache = _parse_fed(html)
            try:
                with open(_CACHE_FILE, "w") as f:
                    json.dump(cache, f)
            except Exception:
                pass
        fetched = {int(k): v for k, v in cache.items()}
    except Exception:
        fetched = {}
    # 內建為底，抓到的年份覆蓋/延伸（內建已核對的年份也讓 Fed 覆蓋——同源、Fed 為準）
    merged = {y: list(v) for y, v in _FOMC_FALLBACK.items()}
    for y, v in fetched.items():
        if len(v) == 8:
            merged[y] = [(int(a), int(b)) for a, b in v]
    return merged


# ── CPI 自動延伸：FRED 的官方發布行事曆（release_id 10＝Consumer Price Index）──
# 為什麼走 FRED 而不是 BLS：BLS 對這台機器一律 403（curl 與真瀏覽器都是），繞不過去也不該繞。
# FRED 是聖路易聯準銀行的官方轉載，`release/dates` 帶 include_release_dates_with_no_data=true
# 會**連未來已排定的日期一起回**，正是我們缺的東西 → 接上去之後 CPI 就跟 FOMC 一樣自己長。
# 需要一把免費金鑰（環境變數 FRED_API_KEY）；沒設就完全走內建表，行為與以前一模一樣。
_FRED_URL = ("https://api.stlouisfed.org/fred/release/dates?release_id=10&file_type=json"
             "&include_release_dates_with_no_data=true&limit=1000&sort_order=asc"
             "&realtime_start={rt}&api_key={key}")
_CPI_CACHE_FILE = os.path.join(tempfile.gettempdir(), "econ_cpi_fred_cache.json")


def _parse_fred_cpi(payload: dict) -> dict:
    """FRED release/dates → {year: [(month, day), ...]}。**只收剛好 12 筆的年份**。

    ⚠ 這條「剛好 12 筆才採用」跟 FOMC 的「剛好 8 場才採用」是同一個保險：
      上游改版／解析壞掉時寧可退回內建表，也不要標出殘缺或錯位的日期
      —— 圖上多一條或少一條垂直線都不會報錯，但使用者會照著它做決策。
    """
    by_year: dict = {}
    for row in (payload.get("release_dates") or []):
        try:
            d = date.fromisoformat(str(row.get("date"))[:10])
        except Exception:
            continue
        by_year.setdefault(d.year, []).append((d.month, d.day))
    out = {}
    for y, lst in by_year.items():
        lst = sorted(set(lst))
        if len(lst) == 12 and len({m for m, _ in lst}) == 12:   # 一年 12 個月各一次
            out[y] = lst
    return out


def _cpi_by_year() -> dict:
    """CPI 發佈日：FRED（快取 7 天）為主、內建為底；沒金鑰或抓不到就完全用內建。"""
    fetched = {}
    key = os.getenv("FRED_API_KEY", "").strip()
    if key:
        try:
            cache = None
            if (os.path.exists(_CPI_CACHE_FILE)
                    and (time.time() - os.path.getmtime(_CPI_CACHE_FILE) < _FETCH_TTL)):
                with open(_CPI_CACHE_FILE, "r") as f:
                    cache = json.load(f)
            if cache is None:
                url = _FRED_URL.format(rt=(date.today() - timedelta(days=800)).isoformat(), key=key)
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                raw = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
                cache = _parse_fred_cpi(json.loads(raw))
                try:
                    with open(_CPI_CACHE_FILE, "w") as f:
                        json.dump(cache, f)
                except Exception:
                    pass
            fetched = {int(k): v for k, v in cache.items()}
        except Exception:
            fetched = {}
    merged = {y: list(v) for y, v in _CPI.items()}
    for y, v in fetched.items():
        if len(v) == 12:
            merged[y] = [(int(a), int(b)) for a, b in v]
    return merged


@router.get("/api/econ_events")
def econ_events():
    """回傳視窗內(過去約 13 個月 ~ 未來約 8 個月)的美國經濟事件發佈時刻(UTC unix 秒)。"""
    now = time.time()
    lo = now - 400 * 86400
    hi = now + 250 * 86400
    years = sorted({date.fromtimestamp(lo).year, date.fromtimestamp(hi).year,
                    date.fromtimestamp(now).year})
    events = []
    # NFP：每月第一個週五 08:30 ET
    for y in years:
        for m in range(1, 13):
            fd = _first_friday(y, m)
            events.append(("NFP", _unix(fd, 8, 30)))
    # CPI：FRED/內建 日期表 08:30 ET
    cpi = _cpi_by_year()
    for y in years:
        for (m, d) in cpi.get(y, []):
            events.append(("CPI", _unix(date(y, m, d), 8, 30)))
    # FOMC：Fed/內建 決策日 14:00 ET
    fomc = _fomc_by_year()
    for y in years:
        for (m, d) in fomc.get(y, []):
            events.append(("FOMC", _unix(date(y, m, d), 14, 0)))
    out = [{"t": ts, "type": typ} for (typ, ts) in events if lo <= ts <= hi]
    out.sort(key=lambda e: e["t"])
    return {"events": out}
