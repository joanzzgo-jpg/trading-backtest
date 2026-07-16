#!/usr/bin/env python3
# 雷達頭頂偵測校準閉環:比對 radar_overhead_log.jsonl 與雨量站真實結果,量測精確率。
#
# 原理:log 記錄每次 ≥35dBZ 的判斷(ts/座標/dbz/rh/near_km/grade);雨量站 Past1hr
# 涵蓋過去一小時 → 對「20~55 分鐘前」的判斷,現在抓一次雨量站就能標記真實結果
# (該座標 5km 內有沒有站真的下了)。定期跑(手動或 cron)累積標記,量測各 grade /
# dBZ 級距的精確率,朝 9 成迭代門檻。
#
# 用法:cd /Users/noah/trading && .venv312/bin/python scripts/radar_calibrate.py
#      (需 backend/.env 有 CWA_API_KEY;log 由線上服務自動累積)
import json, math, os, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, "backend", "cache", "radar_overhead_log.jsonl")
LABELED = os.path.join(ROOT, "backend", "cache", "radar_overhead_labeled.jsonl")

def cwa_key():
    for line in open(os.path.join(ROOT, "backend", ".env")):
        if line.startswith("CWA_API_KEY"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.getenv("CWA_API_KEY", "")

def hav(a, b, c, d):
    p = math.radians
    return 2 * 6371 * math.asin(math.sqrt(
        math.sin(p(c - a) / 2) ** 2 + math.cos(p(a)) * math.cos(p(c)) * math.sin(p(d - b) / 2) ** 2))

def fetch_gauges(key):
    url = f"https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization={key}&format=JSON"
    data = json.load(urllib.request.urlopen(url, timeout=30))
    pts = []
    for s in data["records"]["Station"]:
        co = None
        for c in s.get("GeoInfo", {}).get("Coordinates", []):
            if c.get("CoordinateName") == "WGS84":
                co = (float(c["StationLatitude"]), float(c["StationLongitude"]))
        if not co:
            continue
        try:
            p1h = max(0.0, float((s["RainfallElement"].get("Past1hr") or {}).get("Precipitation")))
        except (TypeError, ValueError, KeyError):
            p1h = 0.0
        pts.append((co[0], co[1], p1h))
    return pts

def main():
    if not os.path.exists(LOG):
        print("尚無 log(線上服務會在每次 ≥35dBZ 判斷時累積),過幾天再跑。")
        return
    done = set()
    if os.path.exists(LABELED):
        for line in open(LABELED):
            try:
                done.add(json.loads(line)["ts"])
            except Exception:
                pass
    now = time.time()
    todo = []
    for line in open(LOG):
        try:
            e = json.loads(line)
        except Exception:
            continue
        age = now - e["ts"]
        if 1200 <= age <= 3300 and e["ts"] not in done:   # 20~55 分前:P1h 涵蓋、又留足落地時間
            todo.append(e)
    print(f"待標記 {len(todo)} 筆(20~55 分前的判斷)")
    if todo:
        gauges = fetch_gauges(cwa_key())
        with open(LABELED, "a") as f:
            for e in todo:
                hit = any(p1h > 0 and hav(e["lat"], e["lon"], la, lo) <= 5
                          for la, lo, p1h in gauges)
                e["outcome"] = hit
                f.write(json.dumps(e) + "\n")
        print(f"已標記 {len(todo)} 筆 → {LABELED}")

    # 統計
    rows = []
    if os.path.exists(LABELED):
        for line in open(LABELED):
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    if not rows:
        return
    print(f"\n== 累積 {len(rows)} 筆已標記判斷 ==")
    def stat(name, sel):
        s = [r for r in rows if sel(r)]
        if not s:
            return
        hit = sum(r["outcome"] for r in s)
        print(f"{name:28s} n={len(s):4d} 精確率 {hit/len(s)*100:5.1f}%")
    for g in ("strong", "watch", "none"):
        stat(f"grade={g}", lambda r, g=g: r.get("grade") == g)
    for lo, hi in ((35, 40), (40, 45), (45, 99)):
        stat(f"dBZ {lo}~{hi}", lambda r, a=lo, b=hi: a <= (r.get("dbz") or 0) < b)
    stat("RH>=90", lambda r: (r.get("rh") or 0) >= 90)
    stat("near<=5km", lambda r: (r.get("near_km") or 99) <= 5)
    print("\n門檻建議:看 strong 精確率——若 <90% 提高 dBZ/RH/near 任一;若 >95% 且量少可放寬換召回。")

if __name__ == "__main__":
    main()
