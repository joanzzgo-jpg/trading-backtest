"""
天氣 API 路由 — 地理分流：
  • 台灣範圍內 → 中央氣象署 (CWA) O-A0001-001 自動氣象站（測站精準到鄉/區）
  • 台灣以外（如香港）→ Open-Meteo 全球預報（_from_omt）
需設定環境變數 CWA_API_KEY（申請：https://opendata.cwa.gov.tw/）。
CWA 無 key 或失敗時，一律回退 Open-Meteo。
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

def _station_has_temp(s: dict) -> bool:
    """測站溫度感測器是否在線（CWA 以 -99 代表離線/缺值）。"""
    try:
        return float(s.get("WeatherElement", {}).get("AirTemperature")) > -98
    except (TypeError, ValueError):
        return False

def _nearest_station(stations: list, lat: float, lon: float):
    """挑最近測站。優先挑「溫度感測器在線」的最近站，避免選到離線站
    （全台約 23/853 站溫度為 -99）而退化成假的 20°C 預設；
    若附近完全沒有在線站，才退回最近的任一站。"""
    best, bd = None, float("inf")             # 最近且溫度在線
    best_any, bd_any = None, float("inf")     # 最近任一站（fallback）
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
            if d < bd_any:
                bd_any, best_any = d, s
            if d < bd and _station_has_temp(s):
                bd, best = d, s
    return best or best_any

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
    if any(k in d for k in ["毛毛雨", "細雨", "微雨"]):   # 細分：毛毛雨 → drizzle
        return "drizzle"
    if any(k in d for k in ["雨", "陣雨"]):
        return "rain"
    if any(k in d for k in ["雪", "霰", "冰雹"]):
        return "snow"
    if any(k in d for k in ["霧", "靄", "霾"]):
        return "fog"
    if any(k in d for k in ["大風", "強風"]):              # 細分：大風 → windy
        return "windy"
    if ("晴" in d) and ("多雲" in d):                      # 細分：晴時多雲 → partly
        return "partly"
    if "陰" in d:                                          # 細分：陰天 → overcast
        return "overcast"
    if "多雲" in d:
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
    desc = str(we.get("Weather") or "").strip()
    if desc in ("-99", "-990", "-"):   # CWA 自動站常以 "-99" 表示「無天氣文字」
        desc = ""
    temp = _safe_float(we.get("AirTemperature"), 20.0)
    precip = _safe_float((we.get("Now") or {}).get("Precipitation"), 0.0)
    wind_ms = _safe_float(we.get("WindSpeed"), 0.0)
    wind_deg = _safe_float(we.get("WindDirection"), -1.0)   # 風向（度，來向）；-99/缺值 → None
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

    # 無天氣文字（CWA 自動站 "-99"）→ 用雲量推回描述，避免前端顯示空白/"-99"
    if not desc:
        if cloud_cover < 20:   desc = "晴" if is_day else "晴朗"
        elif cloud_cover < 50: desc = "晴時多雲"
        elif cloud_cover < 80: desc = "多雲"
        else:                  desc = "陰"

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
        "wind_dir":     (None if wind_deg < 0 else round(wind_deg)),
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
    if c == 0:                              return "sunny" if is_day else "night"
    if c in (1, 2):                         return "partly"      # 晴時多雲/局部多雲
    if c == 3:                              return "overcast"    # 陰天
    if 45 <= c <= 48:                       return "fog"
    if 51 <= c <= 57:                       return "drizzle"     # 毛毛雨
    if 61 <= c <= 67:                       return "storm" if c >= 65 else "rain"
    if (71 <= c <= 77) or c in (85, 86):   return "snow"
    if 80 <= c <= 82:                       return "storm" if c == 82 else "rain"
    if c in (95, 96, 99):                  return "thunder"
    return "storm"

async def _from_omt(lat: float, lon: float) -> dict:
    params = {
        "latitude": lat, "longitude": lon, "timezone": "auto",
        "current": "weather_code,temperature_2m,is_day,precipitation,"
                   "cloud_cover,wind_speed_10m,wind_direction_10m,visibility",
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
        "wind_dir":     (None if c.get("wind_direction_10m") is None else round(float(c.get("wind_direction_10m")))),
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

# ─── 香港天文台 (HKO) 資料源 ─────────────────────────────────
# 即時天氣報告 rhrread（免金鑰、繁中）。香港在地官方資料，等同台灣的 CWA。
HKO_URL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php"

# HKO 天氣圖示碼 → (描述, 動畫類型)。參考官方 weather icon 對照表。
_HKO_ICON = {
    50: ("晴朗", "sunny"),     51: ("間有陽光", "partly"),  52: ("短暫陽光", "partly"),
    53: ("短暫陽光 有驟雨", "rain"), 54: ("間有陽光 有幾陣驟雨", "rain"),
    60: ("多雲", "cloudy"),    61: ("密雲", "overcast"),
    62: ("微雨", "drizzle"),   63: ("雨", "rain"),          64: ("大雨", "storm"),
    65: ("雷暴", "thunder"),
    70: ("天色良好", "night"), 71: ("部分多雲", "night"),   72: ("部分多雲", "night"),
    73: ("大致多雲", "night"), 74: ("大致多雲", "night"),   75: ("天色良好", "night"),
    76: ("大致多雲", "cloudy"),77: ("天色良好", "night"),
    80: ("大風", "windy"),     81: ("乾燥", "sunny"),       82: ("潮濕", "cloudy"),
    83: ("霧", "fog"),         84: ("薄霧", "fog"),         85: ("大霧", "fog"),
    90: ("酷熱", "sunny"),     91: ("炎熱", "sunny"),       92: ("寒冷", "cloudy"),
    93: ("嚴寒", "cloudy"),
}

async def _from_hko(lat: float, lon: float) -> dict:
    timeout = aiohttp.ClientTimeout(total=12)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(HKO_URL, params={"dataType": "rhrread", "lang": "tc"}) as r:
            data = await r.json(content_type=None)

    # 溫度：優先用「香港天文台」總部站，否則取各區平均
    temps = data.get("temperature", {}).get("data", []) or []
    hq = next((t for t in temps if t.get("place") == "香港天文台"), None)
    if hq:
        temp = float(hq.get("value", 20))
    elif temps:
        temp = sum(float(t.get("value", 0)) for t in temps) / len(temps)
    else:
        temp = 20.0

    hums = data.get("humidity", {}).get("data", []) or []
    humidity = float(hums[0].get("value", 0)) if hums else 0.0
    # 降雨：取各區最大值（mm）
    rains = data.get("rainfall", {}).get("data", []) or []
    precip = max((float(rr.get("max") or 0) for rr in rains), default=0.0)

    icons = data.get("icon", []) or []
    code  = int(icons[0]) if icons else 50
    desc, wtype = _HKO_ICON.get(code, ("", "cloudy"))

    # is_day：用記錄時間的小時判定（rhrread 時間含 +08:00）
    is_day = True
    rec = data.get("temperature", {}).get("recordTime") or data.get("updateTime") or ""
    if rec:
        try:
            is_day = 6 <= datetime.fromisoformat(rec).hour < 19
        except ValueError:
            pass
    if wtype == "night" and is_day:
        wtype = "sunny"   # 白天卻拿到夜間碼 → 修正

    # 區級地名（如「香港油尖旺區」）；失敗時退回「香港」
    location = await _reverse_geocode(lat, lon) or "香港"

    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "hko",
        "weather_type": wtype,
        "temperature":  round(temp),
        "description":  desc,
        "precipitation": round(precip, 1),
        "cloud_cover":  _desc_to_cloud(desc),
        "wind_speed":   0.0,            # rhrread 不含風速
        "visibility":   10000.0,        # rhrread 不含能見度
        "humidity":     round(humidity),
        "is_day":       is_day,
        "location":     location,
        "station":      "香港天文台",
        "sun_rise_min":  sr,
        "sun_set_min":   ss,
        "moon_phase":    round(mp, 3),
        "moon_rise_min": mr,
        "moon_set_min":  ms,
    }

# ─── 日本氣象廳 (JMA / 気象庁) 資料源 ────────────────────────
# AMeDAS 自動觀測網（免金鑰）。JMA API 不吃經緯度 → 用站點座標表找最近站。
JMA_TABLE_URL  = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json"
JMA_LATEST_URL = "https://www.jma.go.jp/bosai/amedas/data/latest_time.txt"
JMA_MAP_URL    = "https://www.jma.go.jp/bosai/amedas/data/map/{ts}.json"
_JMA_TABLE_CACHE = {"data": None, "ts": 0.0}              # 站點座標表（快取 24h）
_JMA_MAP_CACHE   = {"key": "", "data": None}              # 觀測資料（依時間戳）

_JMA_DESC  = {"sunny":"晴","night":"晴朗","partly":"晴時多雲","cloudy":"多雲",
              "overcast":"陰","drizzle":"毛毛雨","rain":"雨","storm":"大雨","windy":"大風"}
_JMA_CLOUD = {"sunny":10,"night":10,"partly":35,"cloudy":65,"overcast":85,
              "drizzle":70,"rain":85,"storm":95,"windy":55}

def _jma_decimal(coord):
    """JMA 座標 [度, 分] → 十進位度。"""
    try:
        return float(coord[0]) + float(coord[1]) / 60.0
    except (TypeError, ValueError, IndexError):
        return None

async def _from_jma(lat: float, lon: float) -> dict:
    now = time.time()
    timeout = aiohttp.ClientTimeout(total=12)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        # 站點座標表（24h 快取，內容極少變動）
        if _JMA_TABLE_CACHE["data"] and now - _JMA_TABLE_CACHE["ts"] < 86400:
            table = _JMA_TABLE_CACHE["data"]
        else:
            async with sess.get(JMA_TABLE_URL) as r:
                table = await r.json(content_type=None)
            _JMA_TABLE_CACHE.update({"data": table, "ts": now})
        # 最新觀測時間 → 檔名時間戳（每 10 分鐘更新一次）
        async with sess.get(JMA_LATEST_URL) as r:
            latest = (await r.text()).strip()
        ts = "".join(ch for ch in latest.split("+")[0] if ch.isdigit())
        if _JMA_MAP_CACHE["key"] == ts and _JMA_MAP_CACHE["data"] is not None:
            obs = _JMA_MAP_CACHE["data"]
        else:
            async with sess.get(JMA_MAP_URL.format(ts=ts)) as r:
                obs = await r.json(content_type=None)
            _JMA_MAP_CACHE.update({"key": ts, "data": obs})

    # 找最近且有溫度觀測的站（AMeDAS 部分站只測雨量/風，無溫度）
    best, bd = None, float("inf")
    for sid, info in table.items():
        slat = _jma_decimal(info.get("lat")); slon = _jma_decimal(info.get("lon"))
        if slat is None or slon is None:
            continue
        rec = obs.get(sid)
        if not rec or "temp" not in rec:
            continue
        d = math.hypot(slat - lat, slon - lon)
        if d < bd:
            bd, best = d, (info, rec)
    if not best:
        raise RuntimeError("no_jma_station")
    info, rec = best

    def _v(key):
        x = rec.get(key)
        return float(x[0]) if isinstance(x, list) and x and x[0] is not None else None

    temp = _v("temp"); humidity = _v("humidity"); wind_ms = _v("wind")
    precip = _v("precipitation1h"); sun1h = _v("sun1h")

    is_day = True
    try:
        is_day = 6 <= datetime.fromisoformat(latest).hour < 19
    except ValueError:
        pass

    # 天氣類型：先看雨量，無雨再用日照/風推斷（AMeDAS 無雲量/天氣文字）
    if   precip is not None and precip >= 4:   wtype = "storm"
    elif precip is not None and precip >= 1:   wtype = "rain"
    elif precip is not None and precip >= 0.2: wtype = "drizzle"
    elif wind_ms is not None and wind_ms >= 9 and (sun1h is None or sun1h < .3): wtype = "windy"
    elif not is_day:                            wtype = "night"
    elif sun1h is None:                         wtype = "cloudy"
    elif sun1h >= .6:                           wtype = "sunny"
    elif sun1h >= .3:                           wtype = "partly"
    elif sun1h >= .1:                           wtype = "cloudy"
    else:                                       wtype = "overcast"

    location = await _reverse_geocode(lat, lon) or info.get("kjName") or "日本"
    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "jma",
        "weather_type": wtype,
        "temperature":  round(temp) if temp is not None else 20,
        "description":  _JMA_DESC.get(wtype, ""),
        "precipitation": round(precip, 1) if precip is not None else 0.0,
        "cloud_cover":  _JMA_CLOUD.get(wtype, 50),
        "wind_speed":   round(wind_ms * 3.6, 1) if wind_ms is not None else 0.0,  # m/s→km/h
        "visibility":   10000.0,
        "humidity":     round(humidity) if humidity is not None else 0,
        "is_day":       is_day,
        "location":     location,
        "station":      info.get("kjName"),
        "sun_rise_min":  sr, "sun_set_min": ss,
        "moon_phase":    round(mp, 3), "moon_rise_min": mr, "moon_set_min": ms,
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

def _in_taiwan(lat: float, lon: float) -> bool:
    """座標是否落在台灣（含金門/馬祖/澎湖）大致範圍內。
    香港(22.3,114.2)、東京(35,139)、首爾(37,127) 等皆在範圍外。"""
    return 21.5 <= lat <= 26.5 and 118.0 <= lon <= 122.5


def _in_hong_kong(lat: float, lon: float) -> bool:
    """座標是否落在香港範圍內（含離島）。"""
    return 22.13 <= lat <= 22.58 and 113.82 <= lon <= 114.45


def _in_japan(lat: float, lon: float) -> bool:
    """座標是否落在日本範圍內（北海道至沖繩）。
    經度 ≥122.5 與台灣(≤122.5)不重疊；香港(114)在範圍外。
    排除朝鮮半島（韓國/北韓，經度與日本西側重疊但非日本）→ 走 Open-Meteo。"""
    if not (24.0 <= lat <= 46.0 and 122.5 <= lon <= 154.0):
        return False
    if 33.0 <= lat <= 43.0 and 124.0 <= lon <= 129.5:   # 朝鮮半島
        return False
    return True


async def _fetch_omt_pop(lat: float, lon: float):
    """Open-Meteo 當前小時降雨機率 %（全球、免金鑰）。
    觀測源（CWA/HKO/JMA）多半沒有降雨機率 → 用這支補上。"""
    params = {"latitude": lat, "longitude": lon, "timezone": "auto",
              "hourly": "precipitation_probability", "forecast_days": 1}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(OMT_URL, params=params) as r:
            data = await r.json(content_type=None)
    probs = (data.get("hourly", {}) or {}).get("precipitation_probability", []) or []
    if not probs:
        return None
    from datetime import datetime, timedelta
    off = int(data.get("utc_offset_seconds", 0) or 0)
    hr = (datetime.utcnow() + timedelta(seconds=off)).hour     # 當地當前小時
    v = probs[hr] if hr < len(probs) else probs[-1]
    return None if v is None else int(round(float(v)))


@router.get("/weather")
async def weather(
    lat: float = Query(25.04, description="緯度"),
    lon: float = Query(121.51, description="經度"),
):
    """天氣 API — 在地化分流：
      • 台灣 → 中央氣象署 (CWA) 自動氣象站
      • 香港 → 香港天文台 (HKO) 即時天氣
      • 日本 → 日本氣象廳 (JMA) AMeDAS 觀測
      • 其他 → Open-Meteo 全球預報
    各在地源失敗時一律回退 Open-Meteo，全部失敗才回 503。
    降雨機率（pop）一律以 Open-Meteo 當前小時補上（觀測源無此欄）。"""
    from fastapi import HTTPException
    res = None
    if CWA_KEY and _in_taiwan(lat, lon):           # 台灣 → CWA（精準到鄉/區）
        try: res = await _from_cwa(lat, lon)
        except Exception: pass
    if res is None and _in_hong_kong(lat, lon):    # 香港 → HKO
        try: res = await _from_hko(lat, lon)
        except Exception: pass
    if res is None and _in_japan(lat, lon):        # 日本 → JMA
        try: res = await _from_jma(lat, lon)
        except Exception: pass
    if res is None:                                # 其他/在地源失敗 → Open-Meteo
        try: res = await _from_omt(lat, lon)
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"天氣取得失敗：{e}")
    # 補降雨機率（各源未提供時）
    if res.get("pop") is None:
        try: res["pop"] = await _fetch_omt_pop(lat, lon)
        except Exception: res["pop"] = None
    return res
