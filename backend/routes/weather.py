"""
天氣 API 路由 — 地理分流：
  • 台灣範圍內 → 中央氣象署 (CWA) O-A0001-001 自動氣象站（測站精準到鄉/區）
  • 台灣以外（如香港）→ Open-Meteo 全球預報（_from_omt）
需設定環境變數 CWA_API_KEY（申請：https://opendata.cwa.gov.tw/）。
CWA 無 key 或失敗時，一律回退 Open-Meteo。
"""
import os, math, time, ipaddress, asyncio
from datetime import date, datetime
import aiohttp
from fastapi import APIRouter, Query, Request
from utils.cache import SimpleCache

router = APIRouter(prefix="/api", tags=["weather"])

# 天氣快取：按 ~1km 網格(lat/lon 取 2 位小數)+ 5 分鐘 TTL。天氣不會秒變，重複定位/刷新直接秒回，
# 也省下對 CWA/Open-Meteo 的重複多請求。獨立實例，不與 ohlcv 共用快取(免互相淘汰)。
# 雨系自適應 TTL(2026-07-13「下雨中顯示太慢」)：快取內容是雨系/降雨機率高/附近雨接近 → 縮到 90s，
# 讓「開始下雨/雨停」約 1.5~3 分內反映(原本乾濕都 5 分,疊前端 5 分輪詢+觀測 10 分 → 最壞 20 分)。
# 晴天維持 300s,對 CWA/Open-Meteo 的請求量不變。
_WX_CACHE = SimpleCache(max_size=64)
_WX_TTL = 300
_WX_TTL_WET = 90
_RAINY_TYPES = frozenset({"drizzle", "rain", "storm", "thunder"})


def _wx_is_wet(res) -> bool:
    """/api/weather 結果是否「雨系或快下雨」→ 用短 TTL。
    ⚠ 不可用 precipitation>0 判斷：CWA 的 Now.Precipitation 是「當日累積」雨量，
    早上下過午後放晴仍 >0 → 會整天誤開短 TTL。只信天氣現象與當前降雨機率。"""
    try:
        return ((res.get("weather_type") or "") in _RAINY_TYPES
                or (res.get("pop_now") or 0) >= 60)
    except Exception:
        return False


def _nr_is_wet(res) -> bool:
    """/api/nearby_rain 結果是否「正在下/雨帶接近中」→ 用短 TTL(approaching=下雨前兆,提前轉快節奏)。"""
    try:
        return bool(res.get("raining_here") or res.get("approaching"))
    except Exception:
        return False

CWA_KEY  = os.getenv("CWA_API_KEY", "")
CWA_URL  = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001"
CWA_FC_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-C0032-001"  # 縣市今明36小時預報(含PoP降雨機率)
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
    # 地名以「使用者 GPS 的實際行政區」為準（反向地理編碼），而非最近測站所在鄉鎮：
    # 萬華等無自身測站的區，最近站常落在鄰區（如隔新店溪的永和），直接用站名會顯示錯區。
    # 天氣『數據』仍取自最近站（相距數 km、天氣相同）；反向地理編碼失敗才退回站名鄉鎮。
    station_town = (county + town) if (county and town) else (town or county or station_name)
    location = await _reverse_geocode(lat, lon) or station_town

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

    # ── 腳下雨量站融合（修「出門淋雨、卡片顯示陰」）──
    # 氣象站文字缺值(-99→雲量推斷推不出雨)或站遠沒淋到 → 若最近雨量站(≤5km)顯示
    # 正在下雨，主天氣強制轉雨。文字已含雨/雷/雪者不動（官方描述更細，別蓋掉）。
    rain_mmph, rain_gauge_km = await _rain_gauge_here(lat, lon)
    if rain_mmph >= 0.5 and not any(k in desc for k in ("雨", "雷", "雪", "霰", "雹")):
        lvl = ("毛毛雨" if rain_mmph < 1.0 else (_rain_level(rain_mmph) or "小雨"))
        desc = lvl if lvl == "毛毛雨" else (("陰有" if cloud_cover >= 80 else "") + lvl)
        cloud_cover = max(cloud_cover, 80)

    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "cwa",
        "country":      "Taiwan",
        "weather_type": _desc_to_type(desc, is_day),
        "temperature":  round(temp),
        "description":  desc,
        "precipitation": round(precip, 1),
        "rain_now":      round(rain_mmph, 1),     # 最近雨量站現在雨勢 mm/h(0=沒在下)
        "rain_gauge_km": rain_gauge_km,           # 該站距離；None=5km 內無站
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
        "_county":       county,   # 內部用：查 CWA 官方 PoP 降雨機率（回前端前會移除）
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
# 時區 → 英文國家名（Open-Meteo 來源用；首頁大門上的草寫國名）
_TZ_COUNTRY = {
    "Taipei":"Taiwan","Hong_Kong":"Hong Kong","Tokyo":"Japan","Seoul":"South Korea",
    "Shanghai":"China","Beijing":"China","Singapore":"Singapore","Bangkok":"Thailand",
    "New_York":"USA","Los_Angeles":"USA","Chicago":"USA","Denver":"USA",
    "London":"UK","Paris":"France","Berlin":"Germany","Madrid":"Spain","Rome":"Italy",
    "Dubai":"UAE","Sydney":"Australia","Melbourne":"Australia","Kuala_Lumpur":"Malaysia",
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
    tzp = (data.get("timezone") or "").split("/")[-1]
    if not location:
        location = _TZ_CITY.get(tzp) or tzp.replace("_", " ") or None
    _country = _TZ_COUNTRY.get(tzp) or (tzp.replace("_", " ") if tzp else "")

    sr, ss = _sun_times_local(lat, lon)
    mp = _moon_phase()
    mr, ms = _moon_times(sr, ss, mp)
    return {
        "source":       "openmeteo",
        "country":      _country,
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

# HKO rhrread 雨量分 18 區報告 → 各區近似中心座標。就近選『使用者所在區』的雨量，
# 取代原本「全港最大值」：香港陣雨很局部，別區在下不代表你這在下（避免誤報「正在下雨」）。
_HKO_RAIN_DISTRICTS = {
    "中西區": (22.287, 114.155), "東區": (22.284, 114.224), "南區": (22.246, 114.160),
    "灣仔":   (22.278, 114.173), "油尖旺": (22.312, 114.170), "深水埗": (22.330, 114.162),
    "九龍城": (22.328, 114.191), "黃大仙": (22.342, 114.194), "觀塘":   (22.310, 114.226),
    "葵青":   (22.357, 114.130), "荃灣":   (22.371, 114.114), "屯門":   (22.391, 113.973),
    "元朗":   (22.444, 114.022), "北區":   (22.494, 114.138), "大埔":   (22.451, 114.164),
    "沙田":   (22.383, 114.190), "西貢":   (22.381, 114.271), "離島區": (22.259, 113.945),
}

def _hko_local_rain(rains, lat, lon) -> float:
    """從 rhrread 各區雨量取『離使用者最近的區』的雨量(mm)。找不到對應座標才退回全港最大值。"""
    best_v, best_d = None, float("inf")
    for rr in rains:
        c = _HKO_RAIN_DISTRICTS.get((rr.get("place") or "").strip())
        if not c:
            continue
        d = math.hypot(c[0] - lat, c[1] - lon)
        if d < best_d:
            try: v = float(rr.get("max") or 0)
            except (TypeError, ValueError): v = 0.0
            best_v, best_d = v, d
    if best_v is not None:
        return best_v
    return max((float(rr.get("max") or 0) for rr in rains), default=0.0)   # 無對應區 → 退回全港最大

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
    # 降雨：就近取『使用者所在區』的雨量（mm），非全港最大 → 避免別區下雨誤報你在下雨
    rains = data.get("rainfall", {}).get("data", []) or []
    precip = _hko_local_rain(rains, lat, lon)

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
        "country":      "Hong Kong",
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

JMA_FC_URL = "https://www.jma.go.jp/bosai/forecast/data/forecast/{code}.json"  # 府縣預報(含降水確率pops)
# 47 都道府縣預報區代碼 + 代表座標(縣廳所在地)：用經緯度就近選預報區，免外部地名對應。
_JMA_OFFICES = [
    ("016000",43.06,141.35),("020000",40.82,140.74),("030000",39.70,141.15),("040000",38.27,140.87),
    ("050000",39.72,140.10),("060000",38.24,140.36),("070000",37.75,140.47),("080000",36.34,140.45),
    ("090000",36.57,139.88),("100000",36.39,139.06),("110000",35.86,139.65),("120000",35.61,140.12),
    ("130000",35.69,139.69),("140000",35.45,139.64),("150000",37.90,139.02),("160000",36.70,137.21),
    ("170000",36.59,136.63),("180000",36.07,136.22),("190000",35.66,138.57),("200000",36.65,138.18),
    ("210000",35.39,136.72),("220000",34.98,138.38),("230000",35.18,136.91),("240000",34.73,136.51),
    ("250000",35.00,135.87),("260000",35.02,135.76),("270000",34.69,135.52),("280000",34.69,135.18),
    ("290000",34.69,135.83),("300000",34.23,135.17),("310000",35.50,134.24),("320000",35.47,133.05),
    ("330000",34.66,133.93),("340000",34.40,132.46),("350000",34.19,131.47),("360000",34.07,134.56),
    ("370000",34.34,134.04),("380000",33.84,132.77),("390000",33.56,133.53),("400000",33.61,130.42),
    ("410000",33.25,130.30),("420000",32.74,129.87),("430000",32.79,130.74),("440000",33.24,131.61),
    ("450000",31.91,131.42),("460100",31.56,130.56),("471000",26.21,127.68),
]

def _nearest_jma_office(lat: float, lon: float) -> str:
    """經緯度 → 最近的 JMA 府縣預報區代碼(平面近似距離即可，預報區夠大)。"""
    best, bd = None, float("inf")
    for code, olat, olon in _JMA_OFFICES:
        d = (lat - olat) ** 2 + (lon - olon) ** 2
        if d < bd:
            bd, best = d, code
    return best

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

async def _jma_fetch_obs():
    """抓 JMA AMeDAS 站點座標表 + 最新觀測 map + 最新時間字串（共用快取）。
    回 (table, obs, latest)。天氣與『附近雨區』共用，避免重複抓取邏輯。"""
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
    return table, obs, latest


async def _from_jma(lat: float, lon: float) -> dict:
    table, obs, latest = await _jma_fetch_obs()

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
    precip10m = _v("precipitation10m")   # 過去10分鐘雨量：判「正在下雨」用(比1h窗即時,停雨約10分內歸零)

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
        "country":      "Japan",
        "weather_type": wtype,
        "temperature":  round(temp) if temp is not None else 20,
        "description":  _JMA_DESC.get(wtype, ""),
        "precipitation": round(precip, 1) if precip is not None else 0.0,
        "precip10m":    round(precip10m, 1) if precip10m is not None else None,  # 判「正在下雨」用
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
    """Open-Meteo 降雨機率 %：回 {"day": 今日整天最大, "now": 當地當前小時}（全球、免金鑰）。
    觀測源（CWA/HKO/JMA）多半沒有降雨機率 → 用這支補上。"""
    params = {"latitude": lat, "longitude": lon, "timezone": "auto",
              "hourly": "precipitation_probability", "forecast_days": 1}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(OMT_URL, params=params) as r:
            data = await r.json(content_type=None)
    probs = (data.get("hourly", {}) or {}).get("precipitation_probability", []) or []
    vals = [float(v) for v in probs if v is not None]      # 今日 24 小時各小時降雨機率
    day = int(round(max(vals))) if vals else None          # 整天最高（一般「今日降雨機率」語意）
    now = None                                             # 當地當前小時
    if probs:
        from datetime import datetime, timedelta
        off = int(data.get("utc_offset_seconds", 0) or 0)
        hr = (datetime.utcnow() + timedelta(seconds=off)).hour
        v = probs[hr] if hr < len(probs) else probs[-1]
        now = int(round(float(v))) if v is not None else None
    return {"day": day, "now": now}


async def _fetch_cwa_pop(county: str):
    """中央氣象署官方降雨機率(PoP)：F-C0032-001 今明36小時預報，12 小時分段。
    回 {"day": 今日, "now": 當前時段}。CWA App 的「今日降雨機率」即此值(如臺北 20%)，
    比 Open-Meteo 全天最大值(常灌到 80%+)貼近使用者實際看到的官方數字。"""
    if not (CWA_KEY and county):
        return None
    params = {"Authorization": CWA_KEY, "format": "JSON", "locationName": county}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(CWA_FC_URL, params=params) as r:
            data = await r.json(content_type=None)
    locs = ((data.get("records", {}) or {}).get("location", []) or [])
    if not locs:
        return None
    pop_el = next((e for e in locs[0].get("weatherElement", []) if e.get("elementName") == "PoP"), None)
    if not pop_el:
        return None
    from datetime import datetime, timedelta
    tw_now = datetime.utcnow() + timedelta(hours=8)     # CWA 時間為台灣當地(Railway 跑 UTC)
    d0 = tw_now.date()
    day = now = None
    _fr = None                                          # 今日第一個「未來」降雨時段(官方粗粒度時段起點)
    _earliest = None                                    # 整份資料最早的時段(深夜時 CWA 已無「今日」時段→用它墊底)
    for t in pop_el.get("time", []):
        try:
            st = datetime.fromisoformat(t["startTime"])
            et = datetime.fromisoformat(t["endTime"])
            v = int(round(float(t["parameter"]["parameterName"])))
        except (ValueError, KeyError, TypeError):
            continue
        if _earliest is None or st < _earliest[0]:
            _earliest = (st, v)
        # 今日：與今天日期重疊的所有時段取最大
        if st.date() == d0 or (st.date() < d0 < et.date()) or et.date() == d0:
            day = v if day is None else max(day, v)
        # 此刻：涵蓋當前時間的時段
        if st <= tw_now < et:
            now = v
        # 幾點開始下雨：今日、尚未開始、機率≥50% 的最早時段（官方 12h 粒度）
        if st > tw_now and st.date() == d0 and v >= 50 and (_fr is None or st < _fr[0]):
            _fr = (st, v)
    # 深夜(近午夜)時 CWA 的 36h 預報可能已無「今日」時段(全部從明天 00:00 起)→ day/now 皆 None。
    # 此時別回傳 None 讓上層退回 Open-Meteo(會給 47% 這種非整十值),改用「最近的下一個時段」續留 CWA。
    if day is None and _earliest is not None:
        day = _earliest[1]
    if now is None and day is not None:                 # 當前時間落在資料起點前 → 退今日
        now = day
    # 「今日」＝整天最高(2026-07-14 修)：CWA 36h 預報只含**未來**時段——早上的高 PoP 時段一過就
    # 從回應消失 → 越晚 day 的取值範圍越縮，傍晚常變成 day==now(使用者回報「今日跟此刻一樣」)。
    # 用「當日運行最大值」記住今天看過的最高 PoP(記憶體＋可選 Redis 跨實例/跨部署)，今日=歷史最高。
    day = _pop_running_max(county, d0.isoformat(), day)
    if day is None:
        return None
    out = {"day": day, "now": now}
    if _fr is not None:
        out["from_hour"] = _fr[0].hour; out["from_pop"] = _fr[1]
    return out


_POP_DAYMAX: dict = {}   # county → (date_iso, max_v)：今日 PoP 運行最大值(記憶體層)


def _pop_running_max(county: str, d0_iso: str, day_v):
    """回報「今日整天最高 PoP」：max(今天已見過的最高, 本次計算值)。跨日自動歸零(鍵含日期)。
    Redis 有設就同步(跨實例/跨部署重啟不丟早上的高值)；沒 Redis 退記憶體(重啟前有效)。"""
    try:
        prev = None
        m = _POP_DAYMAX.get(county)
        if m and m[0] == d0_iso:
            prev = m[1]
        rkey = f"wx:popmax:{county}:{d0_iso}"
        if prev is None:
            from utils import redis_cache as _rc
            r = _rc.get_json(rkey)
            if isinstance(r, (int, float)):
                prev = int(r)
        best = day_v if prev is None else (prev if day_v is None else max(prev, day_v))
        if best is not None and best != prev:
            _POP_DAYMAX[county] = (d0_iso, best)
            try:
                from utils import redis_cache as _rc
                _rc.set_json(rkey, best, 36 * 3600)
            except Exception:
                pass
        elif best is not None:
            _POP_DAYMAX[county] = (d0_iso, best)
        return best
    except Exception:
        return day_v


async def _fetch_jma_pop(lat: float, lon: float):
    """日本氣象廳(JMA)降水確率：府縣預報 pops(6小時分段, %)，回 {"day":今日, "now":當前時段}。"""
    code = _nearest_jma_office(lat, lon)
    if not code:
        return None
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(JMA_FC_URL.format(code=code)) as r:
            data = await r.json(content_type=None)
    if not data:
        return None
    ts_list = (data[0].get("timeSeries") if isinstance(data, list) else None) or []
    series = next((s for s in ts_list if (s.get("areas") or [{}])[0].get("pops")), None)
    if not series:
        return None
    tds = series.get("timeDefines", []); pops = series["areas"][0]["pops"]
    from datetime import datetime, timedelta
    jst = datetime.utcnow() + timedelta(hours=9)            # JMA 時間為日本當地(Railway 跑 UTC)
    d0 = jst.date()
    parsed = []
    for i, td in enumerate(tds):
        try:
            t = datetime.fromisoformat(td).replace(tzinfo=None)   # td 帶 +09:00 → 轉 naive
            v = int(pops[i])
        except (ValueError, IndexError, TypeError):
            continue
        parsed.append((t, v))
    day = now = None
    _fr = None                                             # 今日第一個「未來」降雨時段(6h 粒度時段起點)
    for i, (t, v) in enumerate(parsed):
        if t.date() == d0:
            day = v if day is None else max(day, v)
        nt = parsed[i + 1][0] if i + 1 < len(parsed) else t + timedelta(hours=6)
        if t <= jst < nt:
            now = v
        # 幾點開始下雨：今日、尚未開始、降水確率≥50% 的最早時段（官方 6h 粒度）
        if t > jst and t.date() == d0 and v >= 50 and (_fr is None or t < _fr[0]):
            _fr = (t, v)
    if now is None and parsed:                              # 落在資料起訖外 → 取最近端
        now = parsed[0][1] if jst < parsed[0][0] else parsed[-1][1]
    if day is None and parsed:                              # 深夜/資料無今日時段 → 用最近時段當今日
        day = parsed[0][1]                                  # （與 CWA 同修正：別退回 Open-Meteo 給非整十值）
    # 「今日」=整天最高：JMA pops 同樣只含未來時段(6h 粒度) → 套與 CWA 相同的當日運行最大值
    day = _pop_running_max(f"jma:{code}", d0.isoformat(), day)
    if day is None:
        return None
    out = {"day": day, "now": now}
    if _fr is not None:
        out["from_hour"] = _fr[0].hour; out["from_pop"] = _fr[1]
    return out


_HKO_PSR = {"極高": 95, "高": 80, "中高": 65, "中": 50, "中低": 35, "低": 20, "極低": 5}

async def _fetch_hko_pop():
    """香港天文台(HKO)九天預報 PSR(顯著降雨機率分類)→ %，回 {"day":今日, "now":今日}。
    HKO 只給每日分類(極高/高/中高/中/中低/低/極低)，無逐時 → 今日/此刻同值。"""
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(HKO_URL, params={"dataType": "fnd", "lang": "tc"}) as r:
            data = await r.json(content_type=None)
    fc = data.get("weatherForecast", []) or []
    if not fc:
        return None
    from datetime import datetime, timedelta
    d0 = (datetime.utcnow() + timedelta(hours=8)).strftime("%Y%m%d")   # 香港當地日期
    today = next((f for f in fc if str(f.get("forecastDate")) == d0), fc[0])
    v = _HKO_PSR.get((today.get("PSR") or "").strip())
    if v is None:
        return None
    return {"day": v, "now": v}


async def _fetch_pop(lat: float, lon: float, src=None, county=None):
    """降雨機率取值：儘量用當地氣象署官方 PoP(台灣CWA/日本JMA/香港HKO)，失敗或其他地區回退 Open-Meteo。"""
    try:
        if src == "cwa" and county:
            r = await _fetch_cwa_pop(county)
            if r: return r
        elif src == "jma":
            r = await _fetch_jma_pop(lat, lon)
            if r: return r
        elif src == "hko":
            r = await _fetch_hko_pop()
            if r: return r
    except Exception:
        pass
    return await _fetch_omt_pop(lat, lon)


def _wmo_zh(code) -> str:
    """WMO weather_code → 簡短中文天氣狀況（給小熊預報用）。"""
    try:
        c = int(code)
    except (TypeError, ValueError):
        return "天氣"
    if c == 0:                       return "晴"
    if c in (1, 2):                  return "多雲"
    if c == 3:                       return "陰"
    if c in (45, 48):                return "起霧"
    if c in (51, 53, 55, 56, 57):    return "毛毛雨"
    if c in (61, 63, 65, 66, 67):    return "雨"
    if c in (71, 73, 75, 77):        return "雪"
    if c in (80, 81, 82):            return "陣雨"
    if c in (85, 86):                return "陣雪"
    if c in (95, 96, 99):            return "雷雨"
    return "天氣"


async def _fetch_omt_forecast(lat: float, lon: float):
    """Open-Meteo 今明兩天預報（全球、免金鑰）：最高/最低溫、降雨機率、天氣狀況。
    另用『逐小時』判斷今日「午後(13–18時)是否有雷雨/陣雨」→ 讓小熊能準確講午後雷雨而非亂報。
    回 {"today": {...,afternoon}, "tomorrow": {...}}。"""
    params = {"latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 2,
              "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,uv_index_max",
              "hourly": "weather_code,precipitation_probability",
              "current": "apparent_temperature,relative_humidity_2m,wind_speed_10m,temperature_2m"}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(OMT_URL, params=params) as r:
            data = await r.json(content_type=None)
    d = data.get("daily") or {}
    tmax = d.get("temperature_2m_max") or []
    tmin = d.get("temperature_2m_min") or []
    pop  = d.get("precipitation_probability_max") or []
    code = d.get("weather_code") or []
    uvx  = d.get("uv_index_max") or []
    def _day(i):
        if i >= len(tmax):
            return None
        def _r(arr):
            try: return round(float(arr[i]))
            except (TypeError, ValueError, IndexError): return None
        o = {"tmax": _r(tmax), "tmin": _r(tmin),
             "pop": _r(pop), "cond": _wmo_zh(code[i] if i < len(code) else None)}
        if i < len(uvx) and uvx[i] is not None:
            try: o["uv"] = round(float(uvx[i]))
            except (TypeError, ValueError): pass
        return o
    out = {}
    t0 = _day(0); t1 = _day(1)
    if t0: out["today"] = t0
    if t1: out["tomorrow"] = t1
    # 當前體感/濕度/風速（給「悶熱/風大/體感」提醒）
    cur = data.get("current") or {}
    def _cf(k):
        try: return round(float(cur[k]))
        except (TypeError, ValueError, KeyError): return None
    nowo = {"feels": _cf("apparent_temperature"), "temp": _cf("temperature_2m"),
            "humidity": _cf("relative_humidity_2m"), "wind": _cf("wind_speed_10m")}
    if any(v is not None for v in nowo.values()):
        out["now"] = nowo
    # 逐小時：今日午後(13–18時)雷雨/陣雨偵測（timezone=auto → hourly[0] 為今日 00:00 當地）
    try:
        h = data.get("hourly") or {}
        hc = h.get("weather_code") or []
        hp = h.get("precipitation_probability") or []
        aft_codes = [int(hc[i]) for i in range(13, 19) if i < len(hc) and hc[i] is not None]
        aft_pops  = [float(hp[i]) for i in range(13, 19) if i < len(hp) and hp[i] is not None]
        thunder = any(c in (95, 96, 99) for c in aft_codes)
        shower  = any(c in (80, 81, 82, 61, 63, 65) for c in aft_codes)
        aftpop  = int(round(max(aft_pops))) if aft_pops else None
        if "today" in out:
            out["today"]["afternoon"] = {
                "thunder": thunder, "shower": shower, "pop": aftpop,
            }
        # 降雨時段：從當地當前小時起，找今天第一個降雨機率 ≥50% 的小時 + 是否正在下雨
        from datetime import datetime, timedelta
        off = int(data.get("utc_offset_seconds", 0) or 0)
        cur_h = (datetime.utcnow() + timedelta(seconds=off)).hour
        def _p(i):
            try: return float(hp[i]) if i < len(hp) and hp[i] is not None else None
            except (TypeError, ValueError): return None
        now_p = _p(cur_h)
        raining_now = (now_p is not None and now_p >= 60) or \
                      (cur_h < len(hc) and hc[cur_h] in (51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99))
        from_hour = from_pop = None
        for hh in range(cur_h, min(24, len(hp))):
            v = _p(hh)
            if v is not None and v >= 50:
                from_hour = hh; from_pop = int(round(v)); break
        out["rain"] = {"raining_now": bool(raining_now),
                       "from_hour": from_hour, "from_pop": from_pop}
    except Exception:
        pass
    return out or None


AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

async def _fetch_omt_aqi(lat: float, lon: float):
    """Open-Meteo 空氣品質（全球、免金鑰）：US AQI + PM2.5。回 {"us_aqi":, "pm25":} 或 None。"""
    params = {"latitude": lat, "longitude": lon, "current": "us_aqi,pm2_5"}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(AQI_URL, params=params) as r:
            data = await r.json(content_type=None)
    c = data.get("current") or {}
    def _r(k):
        try: return round(float(c[k]))
        except (TypeError, ValueError, KeyError): return None
    aqi = _r("us_aqi"); pm = _r("pm2_5")
    if aqi is None and pm is None:
        return None
    return {"us_aqi": aqi, "pm25": pm}


_SUN_CACHE: dict = {}   # (rlat, rlon, date) -> {"rise","set","tz_off"}（當天天文日出日落）

async def _omt_sun(lat: float, lon: float) -> dict:
    """用 Open-Meteo daily 取「該地真實時區（含日光節約）」的天文日出/日落時刻，作為各源
    日出日落的權威校正（取代 _sun_times_local 的經度近似）。回 {rise,set,tz_off}（分鐘）。
    與各國氣象局公布的日出日沒為同一天文事件、數值一致。每天每格座標只查一次（快取）。"""
    key = (round(lat, 1), round(lon, 1), date.today().isoformat())
    if key in _SUN_CACHE:
        return _SUN_CACHE[key]
    params = {"latitude": lat, "longitude": lon, "daily": "sunrise,sunset",
              "timezone": "auto", "forecast_days": 1}
    timeout = aiohttp.ClientTimeout(total=8)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(OMT_URL, params=params) as r:
            data = await r.json(content_type=None)
    daily = data.get("daily") or {}

    def _hm(iso):   # "2026-06-02T05:12" → 312（當地分鐘）
        try:
            hh, mm = iso.split("T")[1].split(":")[:2]
            return int(hh) * 60 + int(mm)
        except Exception:
            return None

    out = {
        "rise":   _hm((daily.get("sunrise") or [None])[0]),
        "set":    _hm((daily.get("sunset")  or [None])[0]),
        "tz_off": int(data.get("utc_offset_seconds", 0) or 0) // 60,
    }
    if out["rise"] is not None or out["set"] is not None:
        _SUN_CACHE[key] = out
    return out


def _client_ip(request: Request) -> str:
    """取得客戶端真實 IP：Railway/反向代理會把真實 IP 放在 X-Forwarded-For
    （逗號分隔，第一個為原始客戶端）；本機直連則用 request.client.host。"""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        ip = xff.split(",")[0].strip()
        if ip:
            return ip
    xr = request.headers.get("x-real-ip", "")
    if xr:
        return xr.strip()
    return request.client.host if request.client else ""

def _is_public_ip(ip: str) -> bool:
    """是否為可定位的公網 IP（排除 127.0.0.1 / 區域網 / 保留位址）。"""
    try:
        a = ipaddress.ip_address(ip)
        return not (a.is_private or a.is_loopback or a.is_link_local
                    or a.is_reserved or a.is_unspecified or a.is_multicast)
    except ValueError:
        return False

@router.get("/geoip")
async def geoip(request: Request):
    """IP 粗略定位 — 給「瀏覽器定位被拒/不可用」時的後援：
    用客戶端公網 IP 查 ip-api.com（免費、免金鑰、server 端 http 呼叫）取得約略經緯度，
    讓使用者至少看到所在地區而非永遠台北預設。本機/私網 IP → ok:false（前端退預設）。"""
    ip = _client_ip(request)
    if not _is_public_ip(ip):
        return {"ok": False, "reason": "private_or_local_ip", "ip": ip}
    try:
        url = f"http://ip-api.com/json/{ip}"
        params = {"fields": "status,message,lat,lon,city,regionName,country,countryCode"}
        timeout = aiohttp.ClientTimeout(total=6)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get(url, params=params) as r:
                d = await r.json(content_type=None)
        if d.get("status") != "success" or d.get("lat") is None:
            return {"ok": False, "reason": d.get("message", "lookup_failed")}
        return {"ok": True, "lat": d.get("lat"), "lon": d.get("lon"),
                "city": d.get("city"), "region": d.get("regionName"),
                "country": d.get("country"), "source": "ip-api"}
    except Exception as e:
        return {"ok": False, "reason": str(e)}

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
    _ck = f"wx:{round(lat, 2)}:{round(lon, 2)}"        # ~1km 網格快取鍵
    _cached = _WX_CACHE.get(_ck, _WX_TTL)
    if _cached is not None and (_wx_is_wet(_cached) or _nr_is_wet(_NR_CACHE.get(f"nr:{round(lat, 2)}:{round(lon, 2)}", _NR_TTL) or {})):
        _cached = _WX_CACHE.get(_ck, _WX_TTL_WET)      # 雨系/雨接近 → 90s 新鮮度重驗
    if _cached is not None and not _wx_is_wet(_cached) and CWA_KEY and _in_taiwan(lat, lon):
        # 乾天快取命中 → 順看腳下雨量站(共用 5 分快取,幾乎零成本)：剛開始下雨就作廢乾快取
        # 立刻重算，否則雨已落地、卡片還要多等乾 TTL(最壞 5 分)才轉雨（「出門淋雨卡片說沒雨」）。
        _mmph, _gkm = await _rain_gauge_here(lat, lon)
        if _mmph >= 0.5:
            _cached = None
    if _cached is not None:
        return _cached
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

    # 補充資料(pop/forecast/aqi/sun)彼此獨立 → 並行抓取，總延遲由「串行加總」降為「取最大」。
    async def _safe(coro):
        try: return await coro
        except Exception: return None
    _need_pop = res.get("pop") is None
    _county = res.pop("_county", None)                  # 內部欄位：查 CWA 官方 PoP 後移除
    _tasks = [
        _safe(_fetch_pop(lat, lon, res.get("source"), _county)) if _need_pop else _safe(_noop_none()),
        _safe(_fetch_omt_forecast(lat, lon)),
        _safe(_fetch_omt_aqi(lat, lon)),
        _safe(_omt_sun(lat, lon)),
    ]
    _pop, fc, aq, s = await asyncio.gather(*_tasks)

    # 補降雨機率（各源未提供時）：今日整天最大(pop) + 當前小時(pop_now)
    _off_frh = _off_frp = None                           # 官方「幾點開始下雨」時段起點(CWA 12h / JMA 6h)
    if _need_pop:
        if _pop:
            res["pop"] = _pop.get("day"); res["pop_now"] = _pop.get("now")
            _off_frh = _pop.get("from_hour"); _off_frp = _pop.get("from_pop")
        else:
            res["pop"] = None
    # 今明兩天預報（給小熊播報；全球免金鑰，best-effort）
    if fc: res["forecast"] = fc
    # 小啊播報改用「各國當地氣象署」為主、Open-Meteo 為備用：
    #   在官方觀測源地區（台 CWA／港 HKO／日 JMA）用官方實測『現在溫度』+ 官方『降雨機率』
    #   覆蓋 Open-Meteo 的 forecast.now / forecast.rain / forecast.today.pop；
    #   Open-Meteo 只在其他地區、或補「幾點開始下雨」的時段細節時當備用。
    _osrc = res.get("source")
    if _osrc in ("cwa", "hko", "jma"):
        # 官方源:即使 Open-Meteo 預報失敗(fc=None)也用官方資料建最小預報,別讓小啊沒天氣可講
        #（官方為主、Open-Meteo 只是備用 → 備用掛了官方仍要能播報）。
        fc = res.setdefault("forecast", {})
        _now = fc.setdefault("now", {})
        # 官方觀測沒有「體感溫度」→ 用官方實測氣溫當播報主值，清掉 Open-Meteo 模式體感避免蓋過官方
        if res.get("temperature") is not None:
            _now["temp"] = round(res["temperature"]); _now["feels"] = None
        if res.get("humidity"):   _now["humidity"] = res["humidity"]
        if res.get("wind_speed"): _now["wind"] = res["wind_speed"]
        _pn = res.get("pop_now")            # 官方此刻降雨機率
        _pd = res.get("pop")                # 官方今日降雨機率
        _today = fc.setdefault("today", {}) # 確保 today 存在(前端 !f.today 會整段放棄→連溫度都不講)
        if _pd is not None:                 # 今日降雨機率改用官方值（Open-Meteo 常灌到 80%+ 對不上官方）
            _today["pop"] = _pd
        _rain = fc.setdefault("rain", {})
        # 「正在下雨」是當下事實 → 只信官方『實測降水』(不用 pop 預報機率,避免只是機率高就誤報)。
        # 用各源手上「最短的量測窗」最即時：JMA 有 10 分鐘雨量(precip10m)→停雨約10分內歸零,
        # 比 1 小時窗少拖近一小時;CWA(現在時雨量)/HKO(就近區1h)/OMT(current)則用 precipitation。
        _pnow = res.get("precip10m")
        _rain["raining_now"] = bool(_pnow) if _pnow is not None else bool(res.get("precipitation"))
        # 幾點開始下雨 — 三國一致，完全信官方、不摻 Open-Meteo：
        #   • CWA(12h)/JMA(6h) 有官方 ≥50% 時段 → 用官方時段起點。
        #   • 官方當天沒有 ≥50% 時段(含 HKO 每日制) → 清掉，不編時間；
        #     是否下雨改由前端看官方 today.pop(≥50% 才說「今天可能會下雨」)判定。
        if _off_frh is not None:
            _rain["from_hour"] = _off_frh; _rain["from_pop"] = _off_frp
        else:
            _rain["from_hour"] = None; _rain["from_pop"] = None
        fc["wx_src"] = _osrc
    # 空氣品質（best-effort）
    if aq: res.setdefault("forecast", {})["aqi"] = aq
    # 用 Open-Meteo 天文日出/日落（含真實時區/日光節約）校正各源；並回傳該地 UTC 偏移
    # 供前端用「當地真實時間」判斷日出日落（取代經度近似）。失敗則沿用 _sun_times_local。
    if s:
        if s.get("rise") is not None: res["sun_rise_min"] = s["rise"]
        if s.get("set")  is not None: res["sun_set_min"]  = s["set"]
        if s.get("rise") is not None and s.get("set") is not None:
            res["sun_src"] = "open-meteo"
        res["tz_offset_min"] = s.get("tz_off")
    else:
        res["tz_offset_min"] = None
    _WX_CACHE.set(_ck, res)
    return res


# ─── 附近雨區偵測（Nearby Rain）────────────────────────────────
# 把使用者周圍正在下雨的測站，換算成「方位/距離/雨勢」，讓人出門前一眼看出附近哪裡有雨、
# 會不會往我這移動。地理分流同天氣，一律用『在地氣象局的測站網』(真實觀測、密度高)：
#   台灣 → CWA O-A0002-001 自動雨量站(1310 站，Past10Min/Past1hr)
#   香港 → HKO rhrread 18 區即時雨量
#   日本 → JMA AMeDAS 觀測網(precipitation10m/1h)
#   其他 → Open-Meteo 網格 + 所在點 minutely_15 臨近預報
CWA_RAIN_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001"
NEARBY_RADIUS_KM = 20.0
# 預估外圈(2026-07-13「下雨預估優化」)：顯示清單/覆蓋率維持 NEARBY_RADIUS_KM(20km)，
# 但「接近偵測/ETA」多掃 radius~50km 的雨站 → 雨帶 30km/h 時預警提前量從 ~40 分拉到 ~100 分。
# 外圈雨區不進 cells 顯示(離太遠、「附近哪裡在下雨」仍只講 20km 內)，只餵給 approaching 演算。
APPROACH_SCAN_KM = 50.0
# ETA 可信視野：雨胞(尤其台灣午後對流)壽命約 30-60 分就生消/變形、風場也會變 →
# 投射超過此值的 ETA 是假精準。原 30 分；配合預估外圈放寬到 45 分(45 分外仍只留
# approaching 旗標、nearest 行淡標「往你移動」不掛時間)。
ETA_HORIZON_MIN = 45
_8DIR = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"]
_RAIN_STATION_CACHE: dict = {"data": None, "ts": 0.0}   # CWA 雨量站(5 分鐘快取)
_RAIN_HIST: dict = {}   # source → 最近兩份「不同觀測時間」的雨量快照(估雨帶移動)
_NR_CACHE = SimpleCache(max_size=64)
_NR_TTL = 120


def _bearing_zh(brg: float) -> str:
    """羅盤方位角(度) → 八方位中文。"""
    return _8DIR[int(((brg % 360) + 22.5) % 360 // 45)]


def _haversine_km(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat); dl = math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    """從 A 到 B 的羅盤方位角(0=正北，順時針)。"""
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dl = math.radians(b_lon - a_lon)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _rain_level(mmph: float):
    """時雨量(mm/h) → 雨勢分級中文；< 0.5 視為無雨回 None。"""
    if mmph < 0.5:  return None
    if mmph < 4:    return "小雨"
    if mmph < 15:   return "中雨"
    if mmph < 40:   return "大雨"
    return "豪雨"


def _rain_trend(p10: float, p1h: float):
    """用『近10分鐘雨率(p10×6, mm/h)』vs『過去1小時雨量(p1h, 時段均值)』推雨勢趨勢——
    單次抓取即可、不必等第二份快照。近10分鐘低於整小時均值＝已過高峰正減弱；反之增強。
    回 (趨勢中文 或 None, 粗估轉小分鐘 或 None)。精準消散時間無解(對流非線性/會再生)，
    故只在『明顯減弱且已很小』時給粗略 fade。"""
    rate = p10 * 6
    if p1h < 0.5 and rate < 0.5:
        return None, None
    if p1h <= 0.3:                       # 前一小時幾乎沒有、現在才下 → 發展中
        return "增強中", None
    r = rate / p1h
    if r >= 1.3:
        return "增強中", None
    if r <= 0.6:                         # 近10分明顯低於小時均值 → 減弱
        return ("減弱中", 15 if rate < 1.0 else 30)   # 已很小→約15分內轉小；否則約30分
    return "持平", None


def _station_coord(s: dict):
    """測站 GeoInfo.Coordinates 取 WGS84 經緯度。回 (lat, lon) 或 None。"""
    for c in s.get("GeoInfo", {}).get("Coordinates", []):
        if c.get("CoordinateName") == "WGS84":
            try:
                return float(c["StationLatitude"]), float(c["StationLongitude"])
            except (KeyError, ValueError):
                return None
    return None


def _estimate_motion(src: str, lat: float, lon: float, cur_rain: dict, obs_time: str):
    """用某來源最近幾份『不同觀測時間』的雨量快照，估使用者附近(≤80km)雨帶移動向量。
    cur_rain: {station_id: (lat, lon, mmph)}。回 {"speed_kmh", "bearing"(移動去向)} 或 None
    （資料不足/太慢(生消非移動)/太快(雜訊) 一律回 None，寧可不報 ETA 也不亂報）。

    2026-07-13 預估強化（質心法的兩大假移動來源都加了防呆）：
    ① 質量守恆檢查——兩快照間總雨量暴增/暴減(>2.5×)＝雨胞生消主導、質心位移是假象 → 不信；
    ② 三快照方向一致性——連續兩段位移方向差 >60° ＝質心雜訊(如兩片獨立雨帶一生一消) → 不信、
       退回 850hPa 引導氣流；一致則取圓形平均平滑。"""
    hist = _RAIN_HIST.setdefault(src, [])
    now = time.time()
    if not hist or hist[-1]["obs"] != obs_time:     # 只在觀測時間改變時存新快照
        hist.append({"obs": obs_time, "ts": now, "rain": cur_rain})
        del hist[:-3]                               # 留最近三份 → 兩段位移做一致性驗證/平滑

    def _centroid(snap):                            # 使用者附近(≤80km) 雨量加權質心＋總雨量
        sw = sx = sy = 0.0
        for _sid, (slat, slon, mm) in snap["rain"].items():
            if _haversine_km(lat, lon, slat, slon) > 80:
                continue
            sw += mm; sx += mm * slon; sy += mm * slat
        return (sx / sw, sy / sw, sw) if sw > 0 else None

    def _vec(a, b):                                 # a→b 位移 → (speed_kmh, bearing) 或 None
        dt_h = (b["ts"] - a["ts"]) / 3600.0
        if dt_h <= 0 or dt_h > 0.75:                # 間隔<0 或 >45 分 → 不可靠
            return None
        ca, cb = _centroid(a), _centroid(b)
        if not ca or not cb:
            return None
        if max(ca[2], cb[2]) > 2.5 * max(1e-6, min(ca[2], cb[2])):
            return None                             # 質量守恆檢查：生消主導 → 質心位移是假移動
        kx = (cb[0] - ca[0]) * 111.32 * math.cos(math.radians(lat))   # 東西向位移 km
        ky = (cb[1] - ca[1]) * 110.57                                 # 南北向位移 km
        speed = math.hypot(kx, ky) / dt_h
        if speed < 3 or speed > 120:
            return None
        return speed, (math.degrees(math.atan2(kx, ky)) + 360) % 360

    if len(hist) < 2:
        return None
    v2 = _vec(hist[-2], hist[-1])                   # 最新一段
    if v2 is None:
        return None
    if len(hist) >= 3:
        v1 = _vec(hist[-3], hist[-2])               # 前一段
        if v1 is not None:
            diff = abs(((v2[1] - v1[1] + 180) % 360) - 180)
            if diff > 60:
                return None                         # 兩段方向打架＝質心雜訊 → 退回引導氣流
            bx = math.sin(math.radians(v1[1])) + math.sin(math.radians(v2[1]))
            by = math.cos(math.radians(v1[1])) + math.cos(math.radians(v2[1]))
            return {"speed_kmh": round((v1[0] + v2[0]) / 2, 1),
                    "bearing": (math.degrees(math.atan2(bx, by)) + 360) % 360}
    return {"speed_kmh": round(v2[0], 1), "bearing": v2[1]}


_STEER_CACHE = SimpleCache(max_size=32)


async def _steering_wind(lat, lon):
    """850hPa 引導氣流(Open-Meteo,免金鑰)：雨帶移動跟的是「雲層高度的風」，地面風受摩擦/地形
    影響常偏弱偏轉(2026-07-13 台北實測：地面 3.6km/h 來向240° vs 850hPa 9.6km/h 來向180°)。
    無雷達式質心位移時的首選退回；回 (wind_from_deg, speed_kmh×0.85) 或 None。
    ×0.85＝雨帶移速約 0.8~0.9× 引導氣流的經驗係數。快取 30 分(~10km 網格)。"""
    ck = f"steer:{round(lat, 1)}:{round(lon, 1)}"
    c = _STEER_CACHE.get(ck, 1800)
    if c is not None:
        return c or None                            # 失敗也快取(存 False)，避免反覆打
    try:
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.get("https://api.open-meteo.com/v1/forecast", params={
                    "latitude": lat, "longitude": lon,
                    "hourly": "wind_speed_850hPa,wind_direction_850hPa",
                    "forecast_days": 1, "timezone": "UTC"}) as r:
                d = await r.json(content_type=None)
        hh = d.get("hourly") or {}
        times = hh.get("time") or []
        cur = datetime.utcnow().strftime("%Y-%m-%dT%H:00")
        i = times.index(cur) if cur in times else 0
        ws = (hh.get("wind_speed_850hPa") or [None])[i]
        wd = (hh.get("wind_direction_850hPa") or [None])[i]
        if ws is None or wd is None:
            _STEER_CACHE.set(ck, False)
            return None
        res = (float(wd), round(float(ws) * 0.85, 1))
        _STEER_CACHE.set(ck, res)
        return res
    except Exception:
        _STEER_CACHE.set(ck, False)
        return None


def _cluster_span(cells, seed):
    """從 seed 雨區出發，把相鄰(≤15km)的有雨測站串成同一片雨區，回 (跨距km, 站數)。
    估『那片雲雨多大』：孤站=點狀雷陣雨、連成一大片=鋒面型大範圍雨。"""
    n = len(cells)
    pts = [(c["_lat"], c["_lon"]) for c in cells]
    try:
        seedi = cells.index(seed)
    except ValueError:
        return 0.0, 1
    visited = {seedi}; stack = [seedi]
    while stack:                                    # BFS 串接相鄰雨區
        i = stack.pop()
        for j in range(n):
            if j in visited:
                continue
            if _haversine_km(pts[i][0], pts[i][1], pts[j][0], pts[j][1]) <= 15:
                visited.add(j); stack.append(j)
    members = [pts[i] for i in visited]
    span = 0.0                                      # 這片雨區的最大跨距(近似直徑)
    for a in range(len(members)):
        for b in range(a + 1, len(members)):
            span = max(span, _haversine_km(members[a][0], members[a][1],
                                           members[b][0], members[b][1]))
    return span, len(members)


def _size_label(span, count):
    """雨區跨距(km)/站數 → 範圍大小中文。"""
    if count <= 1 or span < 8:  return "局部"       # 點狀/雷陣雨(小於站距)
    if span < 20:               return "小範圍"
    if span < 40:               return "中範圍"
    return "大範圍"


def _attach_scale(cells, cell):
    """幫某雨區算並掛上『範圍大小』(scale/size_km)。座標不足(如 Open-Meteo)則跳過。"""
    if not cell or "_lat" not in cell:
        return
    span, cnt = _cluster_span(cells, cell)
    cell["scale"] = _size_label(span, cnt)
    cell["size_km"] = round(span, 1)


def _finalize_nearby(lat, lon, cells, here_rate, motion, src, obs_time,
                     radius=NEARBY_RADIUS_KM, wind=None, coverage=None, far_cells=None):
    """把雨區清單 + 移動向量彙整成回應：標記各雨區是否正接近、算最近接近雨區的 ETA。
    移動向量雙軌：優先用兩份快照的雷達式質心位移(motion, by='radar')；沒有時退回
    風向推估(wind=(來向度, km/h)，雨隨風走 → 去向=來向+180°，by='wind'，馬上可用)。
    far_cells：radius~APPROACH_SCAN_KM 的「預估外圈」雨區——參與接近偵測/ETA/雨區範圍聚類，
    但不進 cells 顯示清單/nearest/覆蓋率(「附近哪裡在下雨」仍只講 radius 內)。"""
    cells.sort(key=lambda c: c["dist_km"])
    far_cells = far_cells or []
    scan = cells + far_cells                                     # 接近偵測掃描集(近+外圈)
    by = None
    if motion:
        by = "radar"
    elif wind and wind[0] is not None and wind[1] and wind[1] >= 3:
        motion = {"bearing": (wind[0] + 180) % 360, "speed_kmh": round(wind[1], 1)}
        by = "wind"
    approaching = None
    if motion:
        mb, spd = motion["bearing"], motion["speed_kmh"]
        for c in scan:
            c2u = _bearing_deg(c["_lat"], c["_lon"], lat, lon)   # 雨區→你 的方位
            diff = abs(((c2u - mb + 180) % 360) - 180)           # 與移動去向的夾角
            if diff <= 70:
                c["approaching"] = True
                v = spd * math.cos(math.radians(diff))           # 朝你的有效速度分量
                if v >= 3:
                    c["eta_min"] = int(round(c["dist_km"] / v * 60))
            else:
                c["approaching"] = False
        # 只在可信視野內(≤ETA_HORIZON_MIN)才報「約X分後到」；更久 → 雨胞可能已生消,只留 approaching 旗標
        # (前端 nearest 行會顯示「往你移動」但不掛假時間)。
        appr = [c for c in scan if c.get("approaching") and 0 <= c.get("eta_min", 1e9) <= ETA_HORIZON_MIN]
        if appr:
            c0 = min(appr, key=lambda c: c["eta_min"])
            _attach_scale(scan, c0)                              # 這片雨區多大(聚類含外圈,跨距更準)
            approaching = {"dir": c0["dir"], "dist_km": c0["dist_km"], "level": c0["level"],
                           "eta_min": c0["eta_min"], "name": c0.get("name", ""),
                           "area": c0.get("area", ""), "by": by,
                           "scale": c0.get("scale"), "size_km": c0.get("size_km"),
                           "trend": c0.get("trend"), "fade_min": c0.get("fade_min")}
    if cells:
        _attach_scale(scan, cells[0])                            # 最近雨區也標範圍大小
    for c in scan:                                               # 前端不需精確座標
        c.pop("_lat", None); c.pop("_lon", None)
    # 覆蓋率：半徑內『有雨站數 / 總站數』；≥50% 且樣本足(≥6站) → 大範圍降雨(widespread)
    cov = None; widespread = False
    if coverage and coverage[1] >= 6:
        cov = round(coverage[0] / coverage[1], 2)
        widespread = cov >= 0.5
    return {
        "source": src, "radius_km": radius,
        "raining_here": here_rate >= 0.5, "here_mmph": round(here_rate, 1),
        "cells": cells[:12], "nearest": cells[0] if cells else None,
        "approaching": approaching,
        "coverage": cov, "widespread": widespread,
        "motion": (None if not motion else {"speed_kmh": motion["speed_kmh"],
                   "to_dir": _bearing_zh(motion["bearing"]), "by": by}),
        "obs_time": obs_time,
    }


async def _nearest_weather_wind(lat, lon):
    """取最近 O-A0001 氣象站的風向(來向,度)/風速(km/h)——雨量站無風速，用氣象站補，
    給附近雨區推『雨會不會順風往你吹來』。回 (wind_from_deg, speed_kmh) 或 None。"""
    try:
        stations = await _fetch_stations()
    except Exception:
        return None
    s = _nearest_station(stations, lat, lon)
    if not s:
        return None
    we = s.get("WeatherElement", {})
    wd = _safe_float(we.get("WindDirection"), -1.0)      # 來向(度)；-99/缺值 → 無法推
    ws = _safe_float(we.get("WindSpeed"), 0.0)           # m/s
    if wd < 0:
        return None
    return (wd, ws * 3.6)


# ── CWA（台灣，1310 自動雨量站）──
async def _fetch_rain_stations() -> list:
    now = time.time()
    if _RAIN_STATION_CACHE["data"] and now - _RAIN_STATION_CACHE["ts"] < 300:
        return _RAIN_STATION_CACHE["data"]
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(CWA_RAIN_URL, params={"Authorization": CWA_KEY, "format": "JSON"}) as r:
            data = await r.json(content_type=None)
    stations = data.get("records", {}).get("Station", [])
    _RAIN_STATION_CACHE.update({"data": stations, "ts": now})
    return stations


def _rain_el(re: dict, key: str) -> float:
    """RainfallElement[key].Precipitation → float(缺值/負值當 0)。"""
    try:
        v = float((re.get(key) or {}).get("Precipitation"))
        return max(0.0, v)
    except (TypeError, ValueError):
        return 0.0


async def _rain_gauge_here(lat: float, lon: float, max_km: float = 5.0):
    """最近 O-A0002 雨量站的『現在雨勢』(mm/h, 停雨即歸零)。
    為什麼需要：主天氣的 O-A0001 氣象站常無天氣文字(-99)、雲量推斷只會出晴/多雲/陰
    （永遠推不出雨）、Now.Precipitation 又是當日累積 → 正在下雨時主天氣卡照樣顯示「陰」。
    雨量站網 1310 站比氣象站密、Past10Min 是腳下「現在正在下」最準的訊號。
    回 (mmph, dist_km)；沒有 max_km 內的站或失敗回 (0.0, None)——主天氣不能因雨量站掛掉而失敗。"""
    try:
        stations = await _fetch_rain_stations()
    except Exception:
        return 0.0, None
    best_d, best_rate = float("inf"), 0.0
    for s in stations:
        co = _station_coord(s)
        if not co:
            continue
        d = _haversine_km(lat, lon, co[0], co[1])
        if d >= best_d:
            continue
        re = s.get("RainfallElement", {})
        p10 = _rain_el(re, "Past10Min")
        p1h = _rain_el(re, "Past1hr")
        rate = p10 * 6 if p10 > 0 else p1h        # 同 nearby_rain 的換算
        active = p10 > 0 or p1h >= 0.5            # 正在下(非早上殘留)
        best_d, best_rate = d, (rate if active else 0.0)
    if best_d > max_km:
        return 0.0, None
    return best_rate, round(best_d, 1)


async def _nearby_rain_cwa(lat, lon, radius=NEARBY_RADIUS_KM) -> dict:
    stations = await _fetch_rain_stations()
    all_rain: dict = {}
    cells: list = []
    far_cells: list = []                               # 20~50km 預估外圈(只給接近偵測，不顯示)
    here_rate, here_d, obs_time = 0.0, float("inf"), ""
    tot_in = rain_in = 0                               # 半徑內 總站數 / 有雨站數（算覆蓋率）
    for s in stations:
        co = _station_coord(s)
        if not co:
            continue
        slat, slon = co
        re = s.get("RainfallElement", {})
        p10 = _rain_el(re, "Past10Min"); p1h = _rain_el(re, "Past1hr")
        rate = p10 * 6 if p10 > 0 else p1h            # 近 10 分鐘雨量換算 mm/h（停雨即歸零，最即時）
        active = p10 > 0 or p1h >= 0.5                # 現在正在下雨(非早上下過的殘留)
        d = _haversine_km(lat, lon, slat, slon)
        if d <= radius:
            tot_in += 1
            if active:
                rain_in += 1
        if d < here_d:
            here_d, here_rate = d, (rate if active else 0.0)
        if not obs_time:
            obs_time = s.get("ObsTime", {}).get("DateTime", "")
        if active and rate > 0:
            sid = s.get("StationId") or s.get("StationName") or f"{slat},{slon}"
            all_rain[sid] = (slat, slon, rate)
            lvl = _rain_level(rate)
            if d <= APPROACH_SCAN_KM and lvl:
                gi = s.get("GeoInfo", {})
                area = (gi.get("CountyName") or "") + (gi.get("TownName") or "")   # 行政區:雨從『哪一區』
                tl, fm = _rain_trend(p10, p1h)                                     # 增強/減弱趨勢
                _cell = {"dir": _bearing_zh(_bearing_deg(lat, lon, slat, slon)),
                         "dist_km": round(d, 1), "mmph": round(rate, 1), "level": lvl,
                         "name": s.get("StationName") or "", "area": area,
                         "trend": tl, "fade_min": fm, "_lat": slat, "_lon": slon}
                # 20km 內 → 顯示清單；20~50km 外圈 → 只給接近偵測/ETA(不顯示)
                (cells if d <= radius else far_cells).append(_cell)
    motion = _estimate_motion("cwa", lat, lon, all_rain, obs_time)
    wind = None
    if motion is None:   # 無快照移動 → 首選 850hPa 引導氣流(雲層高度的風)，再退地面風
        wind = await _steering_wind(lat, lon) or await _nearest_weather_wind(lat, lon)
    return _finalize_nearby(lat, lon, cells, here_rate, motion, "cwa", obs_time, radius,
                            wind=wind, coverage=(rain_in, tot_in), far_cells=far_cells)


# ── HKO（香港，18 區即時雨量；區塊粗、不估移動）──
async def _nearby_rain_hko(lat, lon, radius=NEARBY_RADIUS_KM) -> dict:
    timeout = aiohttp.ClientTimeout(total=12)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async with sess.get(HKO_URL, params={"dataType": "rhrread", "lang": "tc"}) as r:
            data = await r.json(content_type=None)
    rains = (data.get("rainfall", {}) or {}).get("data", []) or []
    obs_time = (data.get("rainfall", {}) or {}).get("startTime") or data.get("updateTime") or ""
    cells: list = []
    here_rate, here_d = 0.0, float("inf")
    tot_in = rain_in = 0                               # 半徑內 區數 / 有雨區數（覆蓋率）
    for rr in rains:
        c = _HKO_RAIN_DISTRICTS.get((rr.get("place") or "").strip())
        if not c:
            continue
        slat, slon = c
        try:
            mm = float(rr.get("max") or 0)            # 該區過去一小時最大雨量 ≈ mm/h
        except (TypeError, ValueError):
            mm = 0.0
        d = _haversine_km(lat, lon, slat, slon)
        if d <= radius:
            tot_in += 1
            if mm >= 0.5:
                rain_in += 1
        if d < here_d:
            here_d, here_rate = d, mm
        lvl = _rain_level(mm)
        if mm >= 0.5 and d <= radius and lvl:
            place = (rr.get("place") or "").strip()
            cells.append({"dir": _bearing_zh(_bearing_deg(lat, lon, slat, slon)),
                          "dist_km": round(d, 1), "mmph": round(mm, 1), "level": lvl,
                          "name": place, "area": place, "_lat": slat, "_lon": slon})
    return _finalize_nearby(lat, lon, cells, here_rate, None, "hko", obs_time, radius,
                            coverage=(rain_in, tot_in))


# ── JMA（日本，AMeDAS 觀測網）──
async def _nearby_rain_jma(lat, lon, radius=NEARBY_RADIUS_KM) -> dict:
    table, obs, latest = await _jma_fetch_obs()

    def _pv(rec, key):
        x = rec.get(key)
        return float(x[0]) if isinstance(x, list) and x and x[0] is not None else None

    all_rain: dict = {}
    cells: list = []
    here_rate, here_d, here_wind = 0.0, float("inf"), None
    tot_in = rain_in = 0                               # 半徑內 有雨量觀測站數 / 有雨站數（覆蓋率）
    for sid, info in table.items():
        slat = _jma_decimal(info.get("lat")); slon = _jma_decimal(info.get("lon"))
        if slat is None or slon is None:
            continue
        rec = obs.get(sid)
        if not rec:
            continue
        v10 = _pv(rec, "precipitation10m"); v1h = _pv(rec, "precipitation1h")
        rate = (v10 * 6) if (v10 and v10 > 0) else (v1h or 0.0)
        active = bool(v10 and v10 > 0) or bool(v1h and v1h >= 0.5)
        d = _haversine_km(lat, lon, slat, slon)
        if d <= radius and (v10 is not None or v1h is not None):   # 只算有雨量感測的站
            tot_in += 1
            if active:
                rain_in += 1
        if d < here_d:
            here_d, here_rate = d, (rate if active else 0.0)
            # 最近站風向：JMA windDirection 為 16 方位(1-16=NNE..N，×22.5°)、來向；wind 為 m/s
            wdr = _pv(rec, "windDirection"); wsp = _pv(rec, "wind")
            here_wind = (((wdr % 16) * 22.5), wsp * 3.6) if (wdr and wdr > 0 and wsp) else None
        if active and rate > 0:
            all_rain[sid] = (slat, slon, rate)
            lvl = _rain_level(rate)
            if d <= radius and lvl:
                nm = info.get("kjName") or ""
                tl, fm = _rain_trend(v10 or 0.0, v1h or 0.0)                       # 增強/減弱趨勢
                cells.append({"dir": _bearing_zh(_bearing_deg(lat, lon, slat, slon)),
                              "dist_km": round(d, 1), "mmph": round(rate, 1), "level": lvl,
                              "name": nm, "area": nm, "trend": tl, "fade_min": fm,
                              "_lat": slat, "_lon": slon})
    motion = _estimate_motion("jma", lat, lon, all_rain, latest)
    wind = None
    if motion is None:   # 首選 850hPa 引導氣流，再退最近站地面風
        wind = await _steering_wind(lat, lon) or here_wind
    return _finalize_nearby(lat, lon, cells, here_rate, motion, "jma", latest, radius,
                            wind=wind, coverage=(rain_in, tot_in))


# ── Open-Meteo（其他地區，網格 + 所在點臨近預報 ETA）──
async def _nearby_rain_omt(lat, lon, radius=NEARBY_RADIUS_KM) -> dict:
    # 使用者周圍撒兩圈(12km/25km × 八方位)＋中心點，一次請求(逗號分隔多座標)取當前降雨
    pts = [(lat, lon, 0.0, "")]
    for ring in (12.0, 25.0):
        for b in range(0, 360, 45):
            dlat = ring / 110.57 * math.cos(math.radians(b))
            dlon = ring / (111.32 * math.cos(math.radians(lat))) * math.sin(math.radians(b))
            pts.append((lat + dlat, lon + dlon, ring, _bearing_zh(b)))
    lats = ",".join(f"{p[0]:.4f}" for p in pts)
    lons = ",".join(f"{p[1]:.4f}" for p in pts)
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as sess:
        async def _grid():
            async with sess.get(OMT_URL, params={"latitude": lats, "longitude": lons,
                                                  "timezone": "auto", "current": "precipitation"}) as r:
                return await r.json(content_type=None)
        async def _eta():   # 所在點 15 分鐘臨近預報 → 幾分鐘後開始下雨
            async with sess.get(OMT_URL, params={"latitude": lat, "longitude": lon, "timezone": "auto",
                                                 "minutely_15": "precipitation", "forecast_days": 1}) as r:
                return await r.json(content_type=None)
        grid, eta_d = await asyncio.gather(_grid(), _eta())

    arr = grid if isinstance(grid, list) else [grid]
    def _prec(o):
        try: return float((o.get("current") or {}).get("precipitation") or 0)
        except (TypeError, ValueError): return 0.0
    here_rate = _prec(arr[0]) if arr else 0.0
    cells: list = []
    tot_in = rain_in = 0                               # 網格點 總數 / 有雨數（覆蓋率）
    for i in range(min(len(arr), len(pts))):
        rate = _prec(arr[i])
        if pts[i][2] <= radius:
            tot_in += 1
            if rate >= 0.5:
                rain_in += 1
        if i == 0:
            continue                                  # 中心點=所在地，不當周圍雨區 cell
        lvl = _rain_level(rate)
        if rate >= 0.5 and lvl:
            ring = pts[i][2]; dname = pts[i][3]
            cells.append({"dir": dname, "dist_km": round(ring, 1), "mmph": round(rate, 1),
                          "level": lvl, "name": "", "_lat": pts[i][0], "_lon": pts[i][1]})
    res = _finalize_nearby(lat, lon, cells, here_rate, None, "openmeteo",
                           datetime.utcnow().isoformat(), radius, coverage=(rain_in, tot_in))
    # ETA：所在點臨近預報第一個降雨時段(≥0.3mm/15min)；所在地已在下雨則不需要
    if not res["raining_here"]:
        mm = eta_d.get("minutely_15", {}) or {}
        times = mm.get("time", []) or []; vals = mm.get("precipitation", []) or []
        from datetime import timedelta
        off = int(eta_d.get("utc_offset_seconds", 0) or 0)
        now_local = datetime.utcnow() + timedelta(seconds=off)
        for t, v in zip(times, vals):
            try:
                tt = datetime.fromisoformat(t)
            except (ValueError, TypeError):
                continue
            if tt < now_local or v is None:
                continue
            if (tt - now_local).total_seconds() > ETA_HORIZON_MIN * 60:
                break                                  # 超過可信視野 → 不報(免假精準)
            if float(v) >= 0.3:
                nearest = res.get("nearest")
                res["approaching"] = {
                    "dir": nearest["dir"] if nearest else None,
                    "dist_km": nearest["dist_km"] if nearest else None,
                    "level": nearest["level"] if nearest else "雨",
                    "eta_min": max(0, int((tt - now_local).total_seconds() // 60)),
                    "area": (nearest.get("area", "") if nearest else ""),
                    "by": "nowcast",   # 所在點 15 分鐘臨近預報(非風向推估) → 不標「順風」
                }
                break
    return res


@router.get("/nearby_rain")
async def nearby_rain(
    lat: float = Query(25.04, description="緯度"),
    lon: float = Query(121.51, description="經度"),
):
    """附近雨區偵測 — 用在地氣象局測站網找出周圍正在下雨的位置(方位/距離/雨勢)，
    並估雨帶是否正往使用者移動、約幾分鐘後到。地理分流：台灣 CWA／香港 HKO／
    日本 JMA／其他 Open-Meteo，在地源失敗一律回退 Open-Meteo。"""
    ck = f"nr:{round(lat, 2)}:{round(lon, 2)}"
    cached = _NR_CACHE.get(ck, _NR_TTL)
    if cached is not None and _nr_is_wet(cached):
        cached = _NR_CACHE.get(ck, _NR_TTL_WET)        # 下雨中/雨接近 → 60s 新鮮度重驗
    if cached is not None:
        return cached
    res = None
    try:
        if CWA_KEY and _in_taiwan(lat, lon):
            res = await _nearby_rain_cwa(lat, lon)
        elif _in_hong_kong(lat, lon):
            res = await _nearby_rain_hko(lat, lon)
        elif _in_japan(lat, lon):
            res = await _nearby_rain_jma(lat, lon)
    except Exception:
        res = None
    if res is None:                                    # 其他地區/在地源失敗 → Open-Meteo 網格
        try:
            res = await _nearby_rain_omt(lat, lon)
        except Exception as e:
            from fastapi import HTTPException
            raise HTTPException(status_code=503, detail=f"附近雨區取得失敗：{e}")
    _NR_CACHE.set(ck, res)
    return res


async def _noop_none():
    return None


# ─── 颱風資訊（JMA 全球颱風，免金鑰；CWA 補台灣颱風警特報）──────────────────
JMA_TC_LIST  = "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json"
JMA_TC_FC    = "https://www.jma.go.jp/bosai/typhoon/data/{tc}/forecast.json"
JMA_TC_SPEC  = "https://www.jma.go.jp/bosai/typhoon/data/{tc}/specifications.json"
CWA_WARN_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0033-002"  # 天氣特報(含颱風警報)
_TC_CACHE: dict = {"data": None, "ts": 0.0}
_TC_TTL = 600   # 颱風報約每小時更新 → 10 分鐘快取足夠、也大降外部請求


def _tc_part_name(part) -> str:
    """JMA part 欄位有時是字串、有時是 {jp,en} dict → 統一取英文段名。"""
    p = part.get("part")
    if isinstance(p, str):
        return p
    if isinstance(p, dict):
        return p.get("en") or p.get("jp") or ""
    return ""


async def _fetch_jma_typhoons(sess) -> list:
    """JMA 現行颱風(全球、免金鑰)：回每顆的名稱/編號/強度/現在中心/歷史軌跡/預測路徑(含誤差圈)。"""
    out = []
    try:
        async with sess.get(JMA_TC_LIST) as r:
            if r.status != 200:
                return out
            lst = await r.json()
    except Exception:
        return out
    for tc in (lst or []):
        tcid = tc.get("tropicalCyclone")
        if not tcid:
            continue
        try:
            e = {"id": tcid, "number": tc.get("typhoonNumber"), "category": tc.get("category"),
                 "nameEn": None, "nameJp": None, "current": None, "past": [], "forecast": [],
                 "wind_ms": None, "gust_ms": None, "gale_km": None}
            # forecast.json：title(名稱) + Analysis(現況 track/center) + 各時預測 center/probabilityCircle
            async with sess.get(JMA_TC_FC.format(tc=tcid)) as r2:
                fc = await r2.json() if r2.status == 200 else []
            for part in (fc or []):
                nm = _tc_part_name(part)
                if nm == "title":
                    n = part.get("name", {}) or {}
                    e["nameEn"] = n.get("en"); e["nameJp"] = n.get("jp")
                    continue
                ah = part.get("advancedHours")
                ctr = part.get("center")
                tr = part.get("track")
                if tr:   # Analysis 段的歷史軌跡（preTyphoon + typhoon）
                    seq = (tr.get("preTyphoon") or []) + (tr.get("typhoon") or [])
                    e["past"] = [[float(a[0]), float(a[1])] for a in seq
                                 if isinstance(a, (list, tuple)) and len(a) >= 2]
                if ctr and isinstance(ctr, (list, tuple)) and len(ctr) >= 2:
                    if ah == 0:
                        e["current"] = [float(ctr[0]), float(ctr[1])]
                    elif isinstance(ah, int) and ah > 0:
                        pc = part.get("probabilityCircle") or {}
                        rad = pc.get("radius")
                        vt = part.get("validtime", {})
                        e["forecast"].append({
                            "h": ah, "lat": float(ctr[0]), "lon": float(ctr[1]),
                            "r_km": (round(float(rad) / 1000) if rad else None),
                            "vt": (vt.get("UTC") if isinstance(vt, dict) else vt),
                        })
            # specifications.json：強度(最大持續風/陣風) + 暴風警戒半徑
            async with sess.get(JMA_TC_SPEC.format(tc=tcid)) as r3:
                spec = await r3.json() if r3.status == 200 else []
            for part in (spec or []):
                nm = _tc_part_name(part)
                if nm == "title":
                    if not e["category"]:
                        e["category"] = (part.get("category") or {}).get("en")
                    if not e["nameEn"]:
                        n = part.get("name", {}) or {}
                        e["nameEn"] = n.get("en"); e["nameJp"] = n.get("jp")
                    continue
                if nm == "Analysis":
                    mw = part.get("maximumWind", {}) or {}
                    sus = (mw.get("sustained") or {}).get("m/s")
                    gst = (mw.get("gust") or {}).get("m/s")
                    if sus not in (None, ""): e["wind_ms"] = _safe_float(sus)
                    if gst not in (None, ""): e["gust_ms"] = _safe_float(gst)
                    gw = part.get("galeWarning") or []
                    if gw:
                        rng = (gw[0].get("range") or {})
                        if rng.get("km"): e["gale_km"] = rng["km"]
            if e["current"]:
                out.append(e)
        except Exception:
            continue
    return out


async def _fetch_cwa_typhoon_warning(sess):
    """CWA 天氣特報(W-C0033-002)：找出「颱風警報」那筆特報。實際結構為 records.record[]，每筆帶
    datasetInfo.datasetDescription(如『海上陸上颱風警報』/『海上颱風警報』) 與 hazardConditions.hazards.hazard[].info
    (phenomena『颱風』+ affectedAreas.location[].locationName)。回 {active, land(是否含陸上), headline, areas}。
    無金鑰/失敗/結構不符 → 回 None(前端只是不顯示台灣警報，JMA 颱風仍在)。"""
    if not CWA_KEY:
        return None
    try:
        async with sess.get(CWA_WARN_URL, params={"Authorization": CWA_KEY, "format": "JSON"}) as r:
            if r.status != 200:
                return None
            d = await r.json()
        recs = (((d.get("records") or {}).get("record")) or [])
        if isinstance(recs, dict):
            recs = [recs]
        found = False
        land = False
        heads = []
        areas = []
        for rec in recs:
            desc = str(((rec.get("datasetInfo") or {}).get("datasetDescription")) or "")
            hazards = ((((rec.get("hazardConditions") or {}).get("hazards")) or {}).get("hazard")) or []
            if isinstance(hazards, dict):
                hazards = [hazards]
            if "解除" in desc:      # 「解除颱風警報」＝警報已取消，非現行警報 → 不算 active
                continue
            is_ty = ("颱風" in desc) or any(
                "颱風" in str(((h.get("info") or {}).get("phenomena")) or "") for h in hazards)
            if not is_ty:
                continue
            found = True
            if "陸上" in desc:
                land = True
            if desc.strip():
                heads.append(desc.strip())
            for h in hazards:
                info = h.get("info") or {}
                if "颱風" in str(info.get("phenomena") or ""):
                    for lo in (((info.get("affectedAreas") or {}).get("location")) or []):
                        nm = lo.get("locationName")
                        if nm:
                            areas.append(nm)
        if found:
            # headline/areas 去重保序（多筆颱風記錄彙總，如海上＋海上陸上）
            heads = list(dict.fromkeys(heads))
            areas = list(dict.fromkeys(areas))
            return {"active": True, "land": land, "headline": " / ".join(heads), "areas": areas}
        return {"active": False, "land": False, "headline": "", "areas": []}
    except Exception:
        return None


@router.get("/typhoon")
async def typhoon(lat: float = Query(None), lon: float = Query(None)):
    """現行颱風資訊：JMA 全球颱風(名稱/強度/現在位置/歷史+預測路徑，免金鑰) + CWA 台灣颱風警特報(有金鑰時)。
    帶 lat/lon → 另算每顆颱風中心距使用者多遠(dist_km / nearest_km)，供前端判斷是否切颱風背景。10 分鐘快取。"""
    now = time.time()
    c = _TC_CACHE
    if c["data"] is not None and now - c["ts"] < _TC_TTL:
        base = c["data"]
    else:
        timeout = aiohttp.ClientTimeout(total=12)
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            tys = await _fetch_jma_typhoons(sess)
            tw = await _fetch_cwa_typhoon_warning(sess)
        base = {"typhoons": tys, "tw_warning": tw, "asof": now}
        c["data"] = base
        c["ts"] = now
    # 距離依 lat/lon 即時算（不進快取）
    tys = base["typhoons"]
    nearest = None
    if lat is not None and lon is not None:
        tys2 = []
        for e in tys:
            cur = e.get("current")
            if cur:
                dk = round(_haversine_km(lat, lon, cur[0], cur[1]))
                e = {**e, "dist_km": dk}
                nearest = dk if nearest is None else min(nearest, dk)
            tys2.append(e)
        tys = tys2
    return {"ok": True, "active": bool(tys), "typhoons": tys,
            "tw_warning": base.get("tw_warning"), "nearest_km": nearest, "asof": base["asof"]}
