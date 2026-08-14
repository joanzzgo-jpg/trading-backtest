#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：經濟事件的發布時刻（夏令時間）要對，而且表不能悄悄用完。

用法（本機服務要跑著）：
    cd backend && ../.venv312/bin/python scripts/check_econ_events.py [BASE_URL]

兩個都是**靜默**的壞法，圖上完全看不出來：

① 夏令時間算錯 → 每個事件標記整批偏一小時
   NFP/CPI 固定美東 **8:30** 發布、FOMC 固定 **14:00**，但那換算成 UTC 會隨夏令變：
   夏令(EDT, UTC-4) 12:30 / 冬令(EST, UTC-5) 13:30。寫死其中一個 → 半年對、半年錯，
   而且錯的那半年圖上還是有標記、位置只是差一根小時棒。
   ★ 判準＝把回來的時間**換回美東**，看是不是固定的發布時刻 —— 這樣不管中間怎麼換算，
     只要最終落點對就通過，也自動涵蓋每年不同的換季日期（zoneinfo 自己會算）。
   ⚠ 別用「3~11 月就是夏令」這種粗略判斷：2026 年 DST 是 **3/8** 才開始，
     3/6 的 NFP 仍是 EST —— 用粗判會把正確資料誤報成錯的（我第一版就這樣）。

② 表悄悄用完 → 事件標記從某天起再也不出現
   CPI 抓不到 BLS（403，curl 與真瀏覽器都是）。2026-08-13 起改走 **FRED release/dates**
   （release_id 10，聖路易聯準銀行官方轉載，會連未來已排定的日期一起回）→ 設了
   `FRED_API_KEY` 就跟 FOMC 一樣自己長；**沒設金鑰就退回手動維護的內建表**，需要年年補。
   一旦補得不夠，不會有任何錯誤訊息，只是未來沒有事件了。這裡驗「往後還剩多久」。
   ⚠ 不要改成「用第 N 個週幾外推」：實測 2025-26 那 24 筆散在週二/三/四/五，
     2025-10-24 還差了整整兩週（政府停擺順延）→ 外推的線看起來很權威、其實是錯的。

回傳碼：0 全對 / 1 時刻錯或表快用完 / 2 測試不成立（服務沒起來、拿不到資料）
"""
import datetime as dt
import json
import sys
import urllib.request
from zoneinfo import ZoneInfo

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
ET = ZoneInfo("America/New_York")
# 事件 → 美東固定發布時刻
WANT = {"NFP": (8, 30), "CPI": (8, 30), "FOMC": (14, 0)}
MIN_FUTURE_DAYS = 120          # 往後至少要還有這麼多天的事件，否則「表快用完了」


def _utc(ev):
    # ⚠ 這支端點實際回的是 `{"t": epoch 整數, "type": "CPI"}`（勝率瘦身時時間戳統一改 epoch）。
    #   `time`/`ts` 只是相容其他形狀 —— 寫植回測試時我先假設是 ISO 字串的 `time`，
    #   結果改到不存在的欄位、兩個植入都「通過」，差點誤判成守門員無效。**先印一筆看格式**。
    t = ev.get("t")
    if t is None:
        t = ev.get("time") or ev.get("ts")
    if isinstance(t, (int, float)):
        return dt.datetime.fromtimestamp(t if t < 1e12 else t / 1000, dt.timezone.utc)
    s = str(t).replace("Z", "+00:00")
    x = dt.datetime.fromisoformat(s)
    return x if x.tzinfo else x.replace(tzinfo=dt.timezone.utc)


def main() -> int:
    try:
        raw = urllib.request.urlopen(BASE + "/api/econ_events", timeout=60).read()
        d = json.loads(raw)
    except Exception as e:
        print(f"✗ 拿不到 {BASE}/api/econ_events（{type(e).__name__}）→ 測試不成立")
        return 2
    evs = d.get("events") or d.get("data") or (d if isinstance(d, list) else [])
    if not evs:
        print("✗ 事件是空的 → 測試不成立（或表真的空了，先手動確認）")
        return 2

    bad, checked = [], 0
    latest = {}
    for ev in evs:
        kind = str(ev.get("type") or ev.get("kind") or ev.get("name") or "").upper()
        key = next((k for k in WANT if k in kind), None)
        if not key:
            continue
        try:
            u = _utc(ev)
        except Exception:
            bad.append((kind, str(ev.get("time"))[:24], "時間格式看不懂"))
            continue
        et = u.astimezone(ET)
        checked += 1
        latest[key] = max(latest.get(key, u), u)
        if (et.hour, et.minute) != WANT[key]:
            bad.append((key, u.strftime("%Y-%m-%d %H:%M UTC"),
                        f"換回美東是 {et.strftime('%H:%M %Z')}，應為 {WANT[key][0]:02d}:{WANT[key][1]:02d}"))

    print(f"── 發布時刻（換回美東應固定）──　檢查 {checked} 筆")
    if bad:
        for k, when, why in bad[:10]:
            print(f"   ✗ {k} {when}：{why}")
    else:
        print("   ✓ 全部落在正確的美東發布時刻（夏令/冬令切換也對）")

    print("── 表還夠用多久 ──")
    now = dt.datetime.now(dt.timezone.utc)
    for key in WANT:
        last = latest.get(key)
        if not last:
            print(f"   {key:5s} 一筆都沒有 → 略過（可能本來就不提供）")
            continue
        days = (last - now).days
        if key == "CPI":
            # ★ CPI 不能用「往後至少 N 天」當門檻（2026-08-14 修正）：
            #   BLS **在前一年年底才公告**下一年的時程 —— 2026-08 時 2027 的日期
            #   根本還不存在，任何來源上的 2027 都只是推估。用 120 天門檻的話，
            #   每年從夏天到年底這段會一直紅，而**那段時間誰都補不了** ＝ 標準的狼來了。
            #   改成問「該有的有沒有」：隨時都要蓋到**今年年底**；到了 12 月才要求明年。
            need_year = now.year + 1 if now.month == 12 else now.year
            ok = (last.year > need_year) or (last.year == need_year and last.month == 12)
            note = f"需蓋到 {need_year} 年底"
            print(f"   {'✓' if ok else '✗'} {key:5s} 最後一筆 {last.strftime('%Y-%m-%d')}"
                  f"（往後 {days} 天）　{note}")
            if not ok:
                bad.append((key, last.strftime("%Y-%m-%d"),
                            f"表沒蓋到 {need_year} 年底 —— BLS 擋 403（curl 與真瀏覽器都是）："
                            "設 FRED_API_KEY 可自動延伸，否則手動補 routes/econ.py 的 _CPI"))
            elif last.year == now.year and now.month >= 11:
                print(f"         （提醒：{now.year + 1} 年的時程 BLS 通常此時已公告，可以先補了）")
            continue
        ok = days >= MIN_FUTURE_DAYS
        print(f"   {'✓' if ok else '✗'} {key:5s} 最後一筆 {last.strftime('%Y-%m-%d')}，"
              f"往後還有 {days} 天（需 ≥{MIN_FUTURE_DAYS}）")
        if not ok:
            bad.append((key, last.strftime("%Y-%m-%d"), f"往後只剩 {days} 天的事件 —— 表要補了"))

    print()
    if bad:
        print("★ 經濟事件有問題（圖上不會報錯，只會整批偏一小時、或從某天起就沒有標記）：")
        for k, when, why in bad:
            print(f"   {k} {when}: {why}")
        return 1
    print(f"★ {checked} 筆事件的發布時刻正確；NFP/FOMC 往後還有 ≥{MIN_FUTURE_DAYS} 天，CPI 蓋到該蓋的年底")
    return 0


if __name__ == "__main__":
    sys.exit(main())
