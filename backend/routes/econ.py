"""經濟事件發佈時間 → 主圖垂直線標記（NFP / CPI / FOMC）。

時間一律以 America/New_York 定義 → 自動處理美國日光節約 → 轉成 UTC unix 秒給前端。
  NFP 非農就業：每月第一個星期五 08:30 ET（公式，真自動、免抓；偶爾落第二個週五，屬近似）。
  CPI 消費者物價：08:30 ET。BLS 擋爬蟲(403) → 只能內建日期表(需定期核對)。
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
# CPI 發佈日 08:30 ET（BLS 擋爬蟲，只能內建；★需定期核對）。
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
    # CPI：內建日期表 08:30 ET
    for y in years:
        for (m, d) in _CPI.get(y, []):
            events.append(("CPI", _unix(date(y, m, d), 8, 30)))
    # FOMC：Fed/內建 決策日 14:00 ET
    fomc = _fomc_by_year()
    for y in years:
        for (m, d) in fomc.get(y, []):
            events.append(("FOMC", _unix(date(y, m, d), 14, 0)))
    out = [{"t": ts, "type": typ} for (typ, ts) in events if lo <= ts <= hi]
    out.sort(key=lambda e: e["t"])
    return {"events": out}
