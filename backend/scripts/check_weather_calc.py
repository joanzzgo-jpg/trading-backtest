#!/usr/bin/env python3
"""守門員：天氣端點算出來的東西必須合法、而且彼此不矛盾（2026-09-26；需服務跑著，約 40 秒）

使用者：「幫我檢測天氣部分計算都沒問題」。既有兩支只顧別的面向 ——
`check_weather_swr` 驗「過期時先回舊值、不卡請求」、`check_rain_eta` 驗雨區幾何 ——
**沒有人驗過「回給前端的那些數值本身對不對」**。而天氣壞掉的形狀全都是靜默的：
畫面照樣有天氣、零錯誤，只是數字錯了（背景還會照著錯的數字去畫日夜）。

實際抓到的（2026-09-26，就是這支的由來）：
  ① `is_day = int(c.get("is_day") or 1) == 1` —— **0 是合法值**（夜晚就是 0），
     `0 or 1` 讓 Open-Meteo 來源**永遠白天**。實測紐約當地 23:27、倫敦 04:27 都回 is_day=True
     → 晴朗的夜晚會被畫成白天的天空。台灣/香港/日本用的是各自的氣象局，所以自己測永遠測不到。
  ② `temperature_2m or 20` —— 剛好 0°C 會變成 20°C。
  ③ `visibility or 10000` —— 濃霧 0m 會變成 10 公里。
  ④ `"humidity": 0` 寫死，參數也沒要 relative_humidity_2m
     → 非台/港/日的使用者，天氣卡上的濕度**永遠 0%**。

判準（全部問「端點實際回了什麼」，不看程式碼）：
  ⓪ 四個來源都要驗到（cwa / hko / jma / openmeteo）—— 少一個就會像①那樣漏掉
  ① 數值落在物理範圍：溫度 −60~60、濕度/雲量/降雨機率 0~100、日出日沒 0~1439
  ② **is_day 必須與「當地此刻是否在日出日沒之間」一致**（晨昏各給 25 分鐘寬容）← 抓得到①
  ③ 日出早於日沒（|緯度|<60 才成立，極區另當別論）
  ④ weather_type 在已知清單內；`night` 只能出現在 is_day=False 的時候
  ⑤ tz_offset_min 要等於該地真實時區（用 Python zoneinfo 當權威，含日光節約）
  ⑥ 濕度不可以「整組來源都是 0」← 抓得到④（單一地點可能真的很乾，但一整個來源全 0 不可能）

⚠ 回傳碼 2＝測試不成立（服務沒跑、或上游取不到資料），不是通過。
⚠ 上游（CWA/HKO/JMA/Open-Meteo）有時會慢或短暫失敗 → 單一地點取不到只記為「略過」，
  但四個來源各自至少要有一個地點成功，否則回 2。
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000")
TYPES = {"sunny", "night", "partly", "cloudy", "overcast", "fog", "drizzle", "rain",
         "storm", "thunder", "snow", "hail", "windy", "leaves", "spring", "mahjong",
         "tornado", "quake", "aurora", "sunset", "sunrise", "meteor"}
# (名稱, 緯度, 經度, IANA 時區, 期望來源)
LOCS = [
    ("台北",        25.03, 121.57, "Asia/Taipei",       "cwa"),
    ("高雄",        22.63, 120.30, "Asia/Taipei",       "cwa"),
    ("香港",        22.30, 114.17, "Asia/Hong_Kong",    "hko"),
    ("東京",        35.68, 139.69, "Asia/Tokyo",        "jma"),
    ("紐約",        40.71, -74.01, "America/New_York",  "openmeteo"),
    ("倫敦",        51.51,  -0.13, "Europe/London",     "openmeteo"),
    ("雪梨",       -33.87, 151.21, "Australia/Sydney",  "openmeteo"),
    ("新德里",      28.61,  77.21, "Asia/Kolkata",      "openmeteo"),
]
TWILIGHT_TOL = 25        # 晨昏交界的寬容（分鐘）


def fetch(lat, lon):
    q = urllib.parse.urlencode({"lat": lat, "lon": lon})
    with urllib.request.urlopen(f"{BASE}/api/weather?{q}", timeout=45) as r:
        return json.load(r)


def main():
    bad, seen_src, skipped = [], set(), []
    hum_by_src = {}
    print(f"{'地點':<10}{'來源':<11}{'溫度':>5}{'濕度':>5}{'雲':>4}{'雨機':>5}  當地時間  日出   日沒   白天?  類型")
    for name, lat, lon, tzname, exp_src in LOCS:
        try:
            j = fetch(lat, lon)
        except Exception as e:
            skipped.append(f"{name}（{str(e)[:40]}）")
            continue
        src = j.get("source")
        seen_src.add(src)
        t, h, cc = j.get("temperature"), j.get("humidity"), j.get("cloud_cover")
        pop, pn = j.get("pop"), j.get("pop_now")
        sr, ss = j.get("sun_rise_min"), j.get("sun_set_min")
        tz, isd, wt = j.get("tz_offset_min"), j.get("is_day"), j.get("weather_type")
        mp = j.get("moon_phase")
        hum_by_src.setdefault(src, []).append(h)

        # 當地此刻（用端點自己回的時區）
        now_min = None
        if tz is not None:
            lt = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(minutes=tz)
            now_min = lt.hour * 60 + lt.minute
        f = lambda m: "—" if m is None else f"{m // 60:02d}:{m % 60:02d}"
        print(f"{name:<10}{str(src):<11}{('—' if t is None else round(t)):>5}"
              f"{('—' if h is None else h):>5}{('—' if cc is None else cc):>4}"
              f"{('—' if pop is None else pop):>5}  {f(now_min):>7}  {f(sr)}  {f(ss)}"
              f"  {str(isd):>5}  {wt}")

        # ① 物理範圍
        if t is None:
            bad.append(f"{name}：沒有溫度")
        elif not (-60 <= t <= 60):
            bad.append(f"{name}：溫度 {t} 超出 −60~60")
        for k, v in (("濕度", h), ("雲量", cc), ("今日降雨機率", pop), ("當前降雨機率", pn)):
            if v is not None and not (0 <= v <= 100):
                bad.append(f"{name}：{k} {v} 超出 0~100")
        for k, v in (("日出", sr), ("日沒", ss),
                     ("月出", j.get("moon_rise_min")), ("月沒", j.get("moon_set_min"))):
            if v is not None and not (0 <= v < 1440):
                bad.append(f"{name}：{k} {v} 不在 0~1439")
        if mp is not None and not (0 <= mp < 1):
            bad.append(f"{name}：月相 {mp} 不在 [0,1)")

        # ② is_day 與日出日沒一致（★ 這條就是為了抓 falsy-zero 那種「永遠白天」）
        if None not in (isd, sr, ss, now_min) and abs(lat) < 60:
            should_day = sr <= now_min < ss
            near_edge = min(abs(now_min - sr), abs(now_min - ss)) <= TWILIGHT_TOL
            if bool(isd) != should_day and not near_edge:
                bad.append(f"{name}：is_day={isd} 但當地 {f(now_min)} 在日出 {f(sr)}～日沒 {f(ss)} "
                           f"之{'內' if should_day else '外'}（來源 {src}）")

        # ③ 日出早於日沒
        if None not in (sr, ss) and abs(lat) < 60 and not sr < ss:
            bad.append(f"{name}：日出 {f(sr)} 不早於日沒 {f(ss)}")

        # ④ 天氣類型
        if wt not in TYPES:
            bad.append(f"{name}：天氣類型「{wt}」不在已知清單")
        if wt == "night" and isd:
            bad.append(f"{name}：類型是 night 但 is_day=True")

        # ⑤ 時區（zoneinfo 當權威，含日光節約）
        if tz is not None and ZoneInfo is not None:
            try:
                real = int(datetime.now(ZoneInfo(tzname)).utcoffset().total_seconds()) // 60
                if tz != real:
                    bad.append(f"{name}：tz_offset_min {tz} ≠ 真實 {real}（{tzname}）")
            except Exception:
                pass

    # ⓪ 四個來源都要驗到
    want = {"cwa", "hko", "jma", "openmeteo"}
    missing = want - seen_src
    if missing:
        print(f"\n⚠ 測試不成立：這些來源一個地點都沒成功 → {', '.join(sorted(missing))}"
              f"（略過 {len(skipped)} 個地點：{'；'.join(skipped) if skipped else '無'}）")
        sys.exit(2)

    # ⑥ 濕度不可整組來源皆 0
    for src, vals in hum_by_src.items():
        got = [v for v in vals if v is not None]
        if got and all(v == 0 for v in got):
            bad.append(f"來源 {src} 的濕度**整組都是 0**（{len(got)} 個地點）→ 多半是沒去要那個欄位")

    print()
    if skipped:
        print(f"（略過 {len(skipped)} 個地點：{'；'.join(skipped)}）")
    if bad:
        print("✗ 失敗：")
        for b in bad:
            print("   " + b)
        sys.exit(1)
    print("★ 四個來源的天氣數值都在物理範圍內，且 is_day／日出日沒／時區／天氣類型彼此一致")
    sys.exit(0)


if __name__ == "__main__":
    main()
