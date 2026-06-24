"""今日農民曆 API — 用 cnlunar 算干支/生肖/節氣/宜忌/沖煞，zhconv 轉繁體。
前端閒置一段時間會自動跳出今日黃曆卡。結果以台灣時間每日快取一份。"""
import datetime
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["lunar"])

_TW_TZ = datetime.timezone(datetime.timedelta(hours=8))
_cache: dict = {}   # {"YYYY-MM-DD": payload}


def _tw_today() -> datetime.date:
    return datetime.datetime.now(_TW_TZ).date()


def _to_tw(s):
    """簡體轉繁體（台灣用字）；輸入可為字串或字串清單。"""
    try:
        from zhconv import convert
    except Exception:
        return s
    # zhconv 會把「凶」過度轉成「兇」；農民曆吉凶用字應為「凶」→ 修回
    fix = lambda x: convert(str(x), "zh-tw").replace("兇", "凶")
    if isinstance(s, (list, tuple)):
        return [fix(x) for x in s]
    return fix(s)


# 十二時辰：名稱 + 時間範圍（對應 cnlunar 雙時辰清單前 12 格：子→亥）
_SHICHEN = [
    ("子", "23–01"), ("丑", "01–03"), ("寅", "03–05"), ("卯", "05–07"),
    ("辰", "07–09"), ("巳", "09–11"), ("午", "11–13"), ("未", "13–15"),
    ("申", "15–17"), ("酉", "17–19"), ("戌", "19–21"), ("亥", "21–23"),
]


def _hours(L) -> list:
    """十二時辰吉凶：干支 + 吉/凶。"""
    try:
        gz = L.get_twohour8CharList()      # 13 格（早子+晚子），取前 12 對應子→亥
        lk = L.get_twohourLuckyList()
    except Exception:
        return []
    out = []
    for i, (name, tm) in enumerate(_SHICHEN):
        out.append({
            "name": name, "time": tm,
            "gz": _to_tw(gz[i]) if i < len(gz) else "",
            "luck": _to_tw(lk[i]) if i < len(lk) else "",
        })
    return out


def _build(d: datetime.date) -> dict:
    import cnlunar
    L = cnlunar.Lunar(datetime.datetime(d.year, d.month, d.day, 12, 0), godType="8char")
    term = L.todaySolarTerms
    payload = {
        "solar": d.isoformat(),
        "weekday": _to_tw(L.weekDayCn),
        "lunar": _to_tw("%s年 %s%s" % (L.lunarYearCn, L.lunarMonthCn, L.lunarDayCn)),
        "ganzhi": _to_tw("%s年 %s月 %s日" % (L.year8Char, L.month8Char, L.day8Char)),
        "zodiac": _to_tw(L.chineseYearZodiac),
        "solarTerm": "" if term in ("无", "無") else _to_tw(term),
        "nextTerm": _to_tw(L.nextSolarTerm),
        "clash": _to_tw(L.chineseZodiacClash),
        "star28": _to_tw(L.today28Star),
        "constellation": _to_tw(L.starZodiac),
        "good": _to_tw(list(L.goodThing)),
        "bad": _to_tw(list(L.badThing)),
        "level": _to_tw(L.todayLevelName),
        "luckyGods": _to_tw(list(L.get_luckyGodsDirection())),
        "hours": _hours(L),
    }
    return payload


@router.get("/lunar")
def get_lunar(date: str = ""):
    try:
        d = datetime.date.fromisoformat(date) if date else _tw_today()
    except ValueError:
        d = _tw_today()
    key = d.isoformat()
    if key not in _cache:
        try:
            _cache[key] = _build(d)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, **_cache[key]}
