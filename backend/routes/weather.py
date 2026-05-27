"""
天氣 API 路由 — 一律使用中央氣象署 (CWA) O-A0001-001 自動氣象站資料
需設定環境變數 CWA_API_KEY（申請：https://opendata.cwa.gov.tw/）
無 key / CWA 失敗 → 回 503，不再 fallback Open-Meteo。
（_from_omt / OMT_URL 保留為未使用程式碼，未來如需回退快速恢復）
"""
import os, math, time
from datetime import date, datetime
import aiohttp
from fastapi import APIRouter, Query

router = APIRouter(prefix="/api", tags=["weather"])

CWA_KEY  = os.getenv("CWA_API_KEY", "")
CWA_URL  = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001"
OMT_URL  = "https://api.open-meteo.com/v1/forecast"
NOM_URL  = "https://nominatim.openstreetmap.org/reverse"

# 站點資料快取（10 分鐘）
_STATION_CACHE: dict = {"data": None, "ts": 0.0}
# 反向地理編碼快取（lat/lon 取小數後2位 ≈ 1km 格）
_GEOCODE_CACHE: dict = {}

# ─── 共用工具 ────────────────────────────────────────────────

def _safe_float(val, default: float = 0.0) -> float:
    try:
        f = float(val)
        return default if f <= -98 else f   # CWA 以 -99 代表缺值
    except (TypeError, ValueError):
        return default

def _parse_vis(val) -> float:
    """CWA 能見度：'十公里以上'、'5公里' 或純數字 → 公尺"""
    s = str(val or "")
    if not s or s == "-":
        return 10000.0
    s = s.replace("以上", "").replace("十", "10")
    if "公里" in s:
        try:
            return float(s.replace("公里", "").strip()) * 1000
        except ValueError:
            return 10000.0
    try:
        return float(s)
    except ValueError:
        return 10000.0

def _nearest_station(stations: list, lat: float, lon: float):
    best, bd = None, float("inf")
    for s in stations:
        for c in s.get("GeoInfo", {}).get("Coordinates", []):
            if c.get("CoordinateName") != "WGS84":
                continue
            try:
                slat = float(c["StationLatitude"])
                slon = float(c["StationLongitude"])
            except (KeyError, ValueError):
                continue
            d = math.hypot(slat - lat, slon - lon)
            if d < bd:
                bd, best = d, s
    return best

# ─── 反向地理編碼（鄉/區層級）──────────────────────────────────

async def _reverse_geocode(lat: float, lon: float) -> str:
    """用 Nominatim 取得鄉/區層級地名（快取、5秒 timeout）"""
    key = (round(lat, 2), round(lon, 2))
    if key in _GEOCODE_CACHE:
        return _GEOCODE_CACHE[key]
    try:
        headers = {"User-Agent": "trading-backtest-weather/1.0 (contact: joanzzgo@gmail.com)"}
        params  = {"lat": lat, "lon": lon, "format": "json", "zoom": 10, "accept-language": "zh-TW"}
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get(NOM_URL, params=params, headers=headers) as r:
                data = await r.json(content_type=None)
        addr     = data.get("address", {})
        district = (addr.get("city_district") or addr.get("suburb")
                    or addr.get("town") or addr.get("village") or "")
        city     = addr.get("city") or addr.get("county") or addr.get("state") or ""
        location = (city + district) if (city and district) else (district or city or "")
        _GEOCODE_CACHE[key] = location
        return location
    except Exception:
        return ""

# ─── CWA 描述 → 動畫類型 ─────────────────────────────────────

def _desc_to_type(desc: str, is_day: bool) -> str:
    d = desc or ""
    if any(k in d for k in ["雷", "閃電"]):
        return "thunder"
    if any(k in d for k in ["豪雨", "大雨", "暴雨"]):
        return "storm"
    if any(k in d for k in ["雨", "陣雨", "毛毛雨", "細雨"]):
        return "rain"
    if any(k in d for k in ["雪", "霰", "冰雹"]):
        return "snow"
    if any(k in d for k in ["霧", "靄", "霾"]):
        return "fog"
    if any(k in d for k in ["陰", "多雲"]):
        return "cloudy"
    return "sunny" if is_day else "night"

def _desc_to_cloud(desc: str) -> int:
    d = desc or ""
    if any(k in d for k in ["雷", "暴雨", "豪雨"]):   return 95
    if any(k in d for k in ["大雨", "陣雨", "雨"]):    return 85
    if "陰" in d:                                       return 80
    if "多雲" in d and "晴" in d:                      return 35
    if "多雲" in d:                                     return 65
    if "霧" in d or "靄" in d:                         return 90
    if "晴" in d:                                       return 10
    return 50

# ─── CWA 資料源 ──────────────────────────────────────────────

async def _fetch_stations() -> list:
    now = time.time()
    if _STATION_CACHE["data"] and now - _STATION_CACHE["ts"] < 600:
        return _STATION_CACHE["data"]
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(CWA_URL, params={"Authorization": CWA_KEY, "format": "JSON"}) as r:
            data = await r.json(content_type=None)
    stations = data.get("records", {}).get("Station", [])
    _STATION_CACHE.update({"data": stations, "ts": now})
    return stations

async def _from_cwa(lat: float, lon: float) -> dict:
    stations = await _fetch_stations()
    s = _nearest_station(stations, lat, lon)
    if not s:
        raise RuntimeError("no_station")

    we   = s.get("WeatherElement", {})
    desc = we.get("Weather") or ""
    temp = _safe_float(we.get("AirTemperature"), 20.0)
    precip = _safe_float((we.get("Now") or {}).get("Precipitation"), 0.0)
    wind_ms = _safe_float(we.get("WindSpeed"), 0.0)
    humidity = _safe_float(we.get("RelativeHumidity"), 0.0)
    vis = _parse_vis(we.get("Visibility"))
    # SunshineDuration: past-10-min sunshine in hours (max ≈ 0.1667 h)
    # multiply by 6 to get 0-1 fraction; -1.0 sentinel = sensor absent
    sun_h = _safe_float(we.get("SunshineDuration"), -1.0)

    obs_str = s.get("ObsTime", {}).get("DateTime", "")
    is_day = True
    if obs_str:
        from datetime import datetime
        try:
            hour = datetime.fromisoformat(obs_str).hour
            is_day = 6 <= hour < 19
        except ValueError:
            pass

    geo          = s.get("GeoInfo", {})
    county       = geo.get("CountyName", "")
    town         = geo.get("TownName", "")
    station_name = s.get("StationName", "")
    # 縣市＋鄉鎮市區，例如「台北市中正區」；缺 TownName 時退回站名
    location = (county + town) if (county and town) else (town or county or station_name)

    # Cloud cover: prefer sunshine sensor; fall back to text when night or sensor absent
    if sun_h >= 0 and is_day:
        cloud_cover = max(0, round((1 - min(1.0, sun_h * 6)) * 100))
    else:
        cloud_cover = _desc_to_cloud(desc)

    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "cwa",
        "weather_type": _desc_to_type(desc, is_day),
        "temperature":  round(temp),
        "description":  desc,
        "precipitation": round(precip, 1),
        "cloud_cover":  cloud_cover,
        "wind_speed":   round(wind_ms * 3.6, 1),   # m/s → km/h
        "visibility":   vis,
        "humidity":     round(humidity),
        "is_day":       is_day,
        "location":     location,
        "station":      station_name,
        "sun_rise_min":  sr,
        "sun_set_min":   ss,
        "moon_phase":    round(mp, 3),
        "moon_rise_min": mr,
        "moon_set_min":  ms,
    }

# ─── Open-Meteo fallback ─────────────────────────────────────

_WMO_DESC = {
    0:"晴天",1:"晴時多雲",2:"局部多雲",3:"陰天",
    45:"霧",48:"霧凇",
    51:"毛毛雨",53:"毛毛雨",55:"濃毛毛雨",
    61:"小雨",63:"中雨",65:"大雨",
    71:"小雪",73:"中雪",75:"大雪",
    80:"陣雨",81:"中陣雨",82:"暴雨",
    85:"小陣雪",86:"大陣雪",
    95:"雷暴",96:"冰雹雷暴",99:"冰雹雷暴",
}
_TZ_CITY = {
    "Taipei":"台北","Hong_Kong":"香港","Tokyo":"東京","Seoul":"首爾",
    "Shanghai":"上海","Beijing":"北京","Singapore":"新加坡",
    "Bangkok":"曼谷","New_York":"紐約","Los_Angeles":"洛杉磯",
    "London":"倫敦","Paris":"巴黎","Dubai":"杜拜",
    "Sydney":"雪梨","Melbourne":"墨爾本",
}

def _wmo_type(c: int, is_day: bool) -> str:
    if c <= 1:                              return "sunny" if is_day else "night"
    if c <= 3:                              return "cloudy"
    if 45 <= c <= 48:                       return "fog"
    if 51 <= c <= 57:                       return "rain"
    if 61 <= c <= 67:                       return "storm" if c >= 65 else "rain"
    if (71 <= c <= 77) or c in (85, 86):   return "snow"
    if 80 <= c <= 82:                       return "storm" if c == 82 else "rain"
    if c in (95, 96, 99):                  return "thunder"
    return "storm"

async def _from_omt(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat, "longitude": lon, "timezone": "auto",
        "current": "weather_code,temperature_2m,is_day,precipitation,"
                   "cloud_cover,wind_speed_10m,visibility",
    }
    timeout = aiohttp.ClientTimeout(total=12)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(OMT_URL, params=params) as r:
            data = await r.json(content_type=None)

    c    = data.get("current", {})
    code = int(c.get("weather_code") or 0)
    is_day = int(c.get("is_day") or 1) == 1

    # 優先用 Nominatim 取得鄉/區層級地名；失敗時退回時區城市名
    location = await _reverse_geocode(lat, lon)
    if not location:
        tzp = (data.get("timezone") or "").split("/")[-1]
        location = _TZ_CITY.get(tzp) or tzp.replace("_", " ") or None

    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "openmeteo",
        "weather_type": _wmo_type(code, is_day),
        "temperature":  round(float(c.get("temperature_2m") or 20)),
        "description":  _WMO_DESC.get(code, ""),
        "precipitation": round(float(c.get("precipitation") or 0), 1),
        "cloud_cover":  int(c.get("cloud_cover") or 0),
        "wind_speed":   round(float(c.get("wind_speed_10m") or 0), 1),
        "visibility":   float(c.get("visibility") or 10000),
        "humidity":     0,
        "is_day":       is_day,
        "location":     location,
        "station":      None,
        "sun_rise_min":  sr,
        "sun_set_min":   ss,
        "moon_phase":    round(mp, 3),
        "moon_rise_min": mr,
        "moon_set_min":  ms,
    }

# ─── 天文計算 ────────────────────────────────────────────────

def _sun_times_local(lat: float, lon: float) -> tuple[int, int]:
    """日出日沒（分鐘，當地午夜起算）。簡易 NOAA 公式，精度 ±2 分鐘。"""
    n = date.today().timetuple().tm_yday
    B = math.radians((360 / 365) * (n - 81))
    eq_time = 9.87 * math.sin(2 * B) - 7.53 * math.cos(B) - 1.5 * math.sin(B)
    decl    = math.radians(23.45 * math.sin(math.radians((360 / 365) * (n - 81))))
    lat_r   = math.radians(lat)
    cos_ha  = (math.sin(math.radians(-0.833)) - math.sin(lat_r) * math.sin(decl)) / \
              (math.cos(lat_r) * math.cos(decl))
    cos_ha  = max(-1.0, min(1.0, cos_ha))
    ha      = math.degrees(math.acos(cos_ha))
    noon_utc = 720 - 4 * lon - eq_time
    # Use the location's natural timezone (lon/15 h) instead of the server's
    # timezone so sun times are in the user's local time regardless of where
    # the server is deployed.
    tz_off = round(lon / 15) * 60
    return (int((noon_utc - ha * 4 + tz_off) % 1440),
            int((noon_utc + ha * 4 + tz_off) % 1440))

def _moon_phase() -> float:
    """月相 0-1（0=新月、0.5=滿月）。"""
    days = (date.today() - date(2000, 1, 6)).days
    return (days % 29.53058770576) / 29.53058770576

def _moon_times(sun_rise: int, sun_set: int, phase: float) -> tuple[int, int]:
    """由太陽升落時間＋月相估算月出月沒（分鐘）。"""
    return (int((sun_rise + phase * 1440) % 1440),
            int((sun_set  + phase * 1440) % 1440))

# ─── 端點 ────────────────────────────────────────────────────

@router.get("/weather")
async def weather(
    lat: float = Query(25.04, description="緯度"),
    lon: float = Query(121.51, description="經度"),
):
    """天氣 API — 一律使用中央氣象署 (CWA) O-A0001-001 自動氣象站資料。
    需設定環境變數 CWA_API_KEY；申請：https://opendata.cwa.gov.tw/
    無 key 或 CWA 失敗時回 503（不再 fallback Open-Meteo）。"""
    from fastapi import HTTPException
    if not CWA_KEY:
        raise HTTPException(status_code=503, detail="未設定 CWA_API_KEY（中央氣象署授權碼）")
    try:
        return await _from_cwa(lat, lon)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"CWA 資料取得失敗：{e}")
