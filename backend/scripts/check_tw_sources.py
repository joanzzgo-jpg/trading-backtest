#!/usr/bin/env python3
"""股票資料來源守門員（台股為主，兼驗美股/港股同類坑）——
動到 data/taiwan.py、data/us_stock.py 或 routes/data.py 的股票段就跑這支。

用法：
    cd backend && ../.venv312/bin/python scripts/check_tw_sources.py
    有任何一項失敗 → 回傳碼 1。

★為什麼需要這支（2026-08-01）：
  台股這塊接連出過兩次「安靜壞掉」的問題，共同點是**跑一輪看起來完全正常**，
  要跨輪、跨呼叫端的順序才會現形：
    ① 30m/2h 拿到的其實是日線（時框閘門漏列）——切過去圖還是有東西，不報錯。
    ② 條件式抓取的 ETag 與解析結果分家 → 清單從 1972 檔掉到 50 檔，而且因為來源檔案
       內容真的沒變會一直 304，**自己不會好**。
  兩個都是「單輪測試」抓不到的，所以這支專測「多輪 + 不同呼叫順序」。
"""
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import data.taiwan as TW                                    # noqa: E402
from routes.data import fetch_crt_df                        # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'✓' if ok else '✗'} {name}{('  — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def skip(name, reason):
    print(f"  ⊘ {name}  — 跳過：{reason}")


def _src_dates():
    """讀兩包 opendata 各自的交易日。回 {url: date}，抓不到的不列入。"""
    out = {}
    for url in (TW.TWSE_DAY_ALL_URL, TW.TPEX_DAY_ALL_URL):
        d = (TW._TW_DAY_SRC.get(url) or {}).get("date")
        if d:
            out[url] = d
    return out


def reset():
    TW._TW_DAY_ALL.update({"ts": 0.0, "date": None, "rows": {}})
    TW._TW_DAY_SRC.clear()
    TW._TW_DUMP.clear()
    TW._TW_TICKER_PEAK["n"] = 0


print("① 清單基本盤")
reset()
tk = TW.fetch_tw_tickers()
n0 = len(tk)
check("抓得到全台股清單", n0 > 1500, f"{n0} 檔")
# ⚠ 判準只看「有報價的」那些：2026-09-06 起清單會多收一批**有掛牌但當天沒有行情**的股票
#   （price/change 皆為 None、volume 0；如 6949 沛爾生醫*-創），那是合法狀態，不該叫警報。
#   原本要抓的 bug 是「上櫃欄位名寫錯 → 約 900 檔**有價卻量全 0**」——限定在有報價的範圍內
#   一樣抓得到，偵測力沒有降低。實測：量=0 的 34 檔全部都是沒報價的，有報價的 0 檔。
zero = [x for x in tk if x.get("price") is not None and not x.get("volume")]
_noq = [x for x in tk if x.get("price") is None]
check("成交量不得整批為 0（上櫃欄位名曾寫錯）", len(zero) == 0,
      f"有報價卻量=0 的 {len(zero)} 檔（另有 {len(_noq)} 檔無行情、量本來就是 0）")

print("\n② 條件式抓取：連跑多輪不得縮水（304 快速路徑）")
reset()          # ★必須先清掉，否則第 1 輪已經是 304，等於拿 304 比 304
# ★ 2026-09-17：原本判「第 2 輪耗時 < 第 1 輪一半」→ 那一輪還包含 MIS 即時報價與公司名單請求，
#   對方一慢就不準（實測 2.11s→1.17s 差一點被判失敗，而 304 其實有生效）＝叫狼來了。
#   要驗的是「有沒有走 304」→ 直接記錄三份 opendata 每輪回的狀態碼。耗時只印出來參考。
_OPEN = {TW.TWSE_DAY_ALL_URL: "上市", TW.TPEX_DAY_ALL_URL: "上櫃", TW.TPEX_ESB_URL: "興櫃"}
_st_orig = TW.SESSION.get
_rounds = []


def _st_spy(url, *a, **k):
    r = _st_orig(url, *a, **k)
    if url in _OPEN and _rounds:
        _rounds[-1][_OPEN[url]] = r.status_code
    return r


sizes, times = [], []
TW.SESSION.get = _st_spy
try:
    for _ in range(3):
        _rounds.append({})
        t = time.perf_counter()
        sizes.append(len(TW.fetch_tw_tickers()))
        times.append(time.perf_counter() - t)
finally:
    TW.SESSION.__dict__.pop("get", None)
check("三輪筆數一致", len(set(sizes)) == 1, f"{sizes}")
_r2 = _rounds[1] if len(_rounds) > 1 else {}
_n304 = sum(1 for v in _r2.values() if v == 304)
# ≥2 份就算：上游剛好在兩輪之間更新某一份時回 200 是合法的；壞掉的形狀是「全部 200」
check("第 2 輪走 304（沒有重新下載整包）", _n304 >= 2,
      f"第 2 輪狀態 {_r2}；耗時 {times[0]:.2f}s → {times[1]:.2f}s（僅供參考）")

print("\n③ 兩個呼叫端交錯（ETag 與解析結果分家會在這裡爆）")
# ⚠ 上游「兩包日期不同」時要換一組斷言，不是放寬（2026-08-04）：
#   TWSE(上市) 與 TPEX(上櫃) 的 opendata 發布時間不同步，收盤後有一段時間兩包分屬不同交易日。
#   這時我們的程式會**正確地排除舊的那包** → 日線只剩單一市場（實測 859 檔），
#   舊斷言「日線 >1500」就會失敗 —— 程式做對了事卻被判壞，正是 CLAUDE.md 講的「狼來了」。
#   對策：偵測到上游日期不一致時，改測「真實情境下該有的行為」——日線必須是**單一日期、
#   且等於較新那包的日期**（這才是我們真正在意的「不得混用日期」保證），而清單仍必須完整。
for order in (("備援", "清單"), ("清單", "備援")):
    reset()
    for who in order:
        TW._tw_day_all_refresh() if who == "備援" else TW.fetch_tw_tickers()
    n = len(TW.fetch_tw_tickers())
    d = len(TW._TW_DAY_ALL["rows"])
    sd = _src_dates()
    mixed = len(set(sd.values())) > 1
    if mixed:
        newest = max(sd.values())
        # ⚠ 斷言必須包含「檔數等於較新那包」：光驗 date==newest 是**擋不住 bug 的**——
        #   把兩包混在一起時 date 照樣等於較新的那個（實測混用會是 1950 檔、正確是 859 檔）。
        #   第一版我就是只驗 date，模擬植入壞碼後直接放行，等於白做。
        n_new = sum(len((TW._TW_DAY_SRC.get(u) or {}).get("rows") or {})
                    for u, dt in sd.items() if dt == newest)
        check(f"順序 {order[0]}→{order[1]}：上游日期不一致時只採較新那包",
              n > 1500 and TW._TW_DAY_ALL["date"] == newest and d == n_new,
              f"清單 {n} 檔 / 日線 {d} 檔（較新那包 {n_new} 檔）/ 採用 {TW._TW_DAY_ALL['date']}"
              f"（上游 {sorted(str(x) for x in set(sd.values()))}）")
    else:
        check(f"順序 {order[0]}→{order[1]}：清單與日線都完整", n > 1500 and d > 1500,
              f"清單 {n} 檔 / 日線 {d} 檔")

print("\n④ 日線快取：兩包分屬不同交易日時不得混用日期")
reset()
TW.fetch_tw_tickers()
import datetime                                              # noqa: E402
_sd4 = _src_dates()
if len(set(_sd4.values())) > 1:
    # 這項是「人工把上櫃標成舊日期，驗它會被排除」。前提是當下兩包同日期；
    # 上游正在發布造成日期不一致時，前提不成立（real 已經是排除後的結果）→ 測了也沒意義。
    # 上面 ③ 在同一情境下已經用真實資料驗過「只採較新那包」，保護沒有缺口。
    skip("舊日期那包被排除（不會補出日期錯的 K 棒）",
         f"上游兩包分屬不同交易日 {sorted(str(x) for x in set(_sd4.values()))}，"
         f"③ 已用真實情境驗過同一保證")
elif TW._TW_DAY_SRC.get(TW.TPEX_DAY_ALL_URL):
    real = TW._TW_DAY_ALL["date"]
    TW._TW_DAY_SRC[TW.TPEX_DAY_ALL_URL]["date"] = real - datetime.timedelta(days=1)
    TW._day_commit()
    otc = any(c in TW._TW_DAY_ALL["rows"] for c in ("6488", "5483"))
    check("舊日期那包被排除（不會補出日期錯的 K 棒）",
          TW._TW_DAY_ALL["date"] == real and not otc,
          f"date={TW._TW_DAY_ALL['date']} 含上櫃={otc}")

print("\n⑤ 縮水自我復原守門")
reset()
TW.fetch_tw_tickers()
peak = TW._TW_TICKER_PEAK["n"]
_fake = {"0001": {"symbol": "0001", "display": "0001", "name": "假的",
                  "price": 1.0, "change_pct": 0.0, "change_amt": 0.0, "volume": 0.0}}
TW._TW_DUMP[(TW.TWSE_DAY_ALL_URL, TW.DUMP_TICKERS)]["payload"] = _fake
TW._TW_DUMP[(TW.TPEX_DAY_ALL_URL, TW.DUMP_TICKERS)]["payload"] = {}
small = len(TW.fetch_tw_tickers())
check("偵測到縮水並清掉條件式快取", not TW._TW_DUMP, f"高水位 {peak} → 這輪 {small} 檔")
recovered = len(TW.fetch_tw_tickers())
check("下一輪自動復原", recovered > 1500, f"{recovered} 檔")

# ── 盤中「最後交易日＝今天」時，預期根數要按已過的盤中時間縮放（2026-08-04）──────────
# ⚠ 原本三組 EXPECT 都寫死「完整交易日」的根數。盤中跑這支時最後交易日就是今天、只走了一部分
#   （實測台北 11:05 跑：5m 只有 25 根，而寫死的下限是 40）→ 程式好好的卻被判失敗，
#   跟 ③④ 的「上游發布不同步」同一類「狼來了」。
# ⚠ 不是放寬：這支要抓的是「30m/2h 拿到的其實是日線」——那種情況根數會掉到 1，
#   等比縮放後的下限仍遠大於 1，照樣抓得到（見下方 _expect 的下限計算）。
_SESSIONS = {   # 市場 → (開盤分鐘, 收盤分鐘, 時區偏移小時)
    "tw": (9 * 60, 13 * 60 + 30, 8),
    "hk": (9 * 60 + 30, 16 * 60, 8),
    "us": (9 * 60 + 30, 16 * 60, -4),      # 夏令 EDT；冬令差一小時，只影響縮放比例、不影響判定方向
}


def _expect(mkt, lo, hi, last_date, last_ts=None, tf_min=None):
    """回 (lo, hi, 說明)。最後交易日不是今天（＝完整的一天）→ 原樣；是今天且盤中未收 → 等比縮放。

    ★ 2026-09-17：縮放比例改用「資料自己最後一根的時間」而不是「現在幾點」（有給 last_ts/tf_min 時）。
      原本用現在時刻 → 主來源（鉅亨）一陣錯誤、當日 K 暫時退回落後約 20 分鐘的 yfinance 時，
      根數「比現在該有的少」就被判失敗（實測開盤 48 分只有 6 根＝只到 09:25）＝叫狼來了。
      這一段要抓的是「30m/2h 其實拿到日線」，跟資料新不新無關 → 用資料自己的時間縮放，
      落後另外印提示、不算失敗（新鮮度有別的守門員管）。
      ⚠ 仍抓得到日線：日線棒的時間戳在開盤前（台股 00:00 UTC＝08:00），會直接判失敗。"""
    import datetime as _dt
    o, c, tzh = _SESSIONS.get(mkt, _SESSIONS["tw"])
    now = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=tzh)))
    if last_date != now.date():
        return lo, hi, ""
    mins = now.hour * 60 + now.minute - o
    total = c - o
    if mins >= total or mins <= 0:
        return lo, hi, ""
    _lag = ""
    if last_ts is not None and tf_min:
        _loc = (pd.Timestamp(last_ts) + pd.Timedelta(hours=tzh))
        _mins_data = _loc.hour * 60 + _loc.minute - o + tf_min      # 最後一根涵蓋到它的結束
        if _mins_data <= 0:
            return 0, 0, f"最後一根 {_loc:%H:%M} 在開盤前 —— 不是盤中棒（像是拿到日線）"
        if mins - _mins_data > 2 * tf_min:
            _lag = f"  ⚠ 資料落後現在 {mins - _mins_data} 分（主來源暫時錯誤時會退回延遲來源；只提示、不算失敗）"
        mins = min(_mins_data, mins)
    r = mins / total
    _lo, _hi = max(1, int(lo * r)), int(hi * r) + 1
    # ⚠ 開盤沒多久時縮放後的下限會掉到 1 → 這時「其實拿到日線」(根數也是 1) 會被放行，
    #   檢查等於失去鑑別力。與其假裝有驗，不如明確回報跳過（原本就該 >1 根才驗得出來）。
    if lo > 1 and _lo <= 1:
        return None, None, f"盤中僅過 {mins}/{total} 分，預期根數縮到 1 以下、驗不出『拿到日線』{_lag}"
    return _lo, _hi, f"盤中已過 {mins}/{total} 分，預期按 {r:.0%} 縮放{_lag}"

print("\n⑥ 各時框分桶（30m/2h 曾經拿到的是日線）")
EXPECT = {"5m": (40, 60), "15m": (15, 22), "30m": (8, 12), "1h": (4, 6), "2h": (2, 4), "4h": (1, 3), "1d": (1, 1)}
import pandas as pd                                          # noqa: E402
for tf, (lo, hi) in EXPECT.items():
    try:
        df = fetch_crt_df("tw", "2330", tf, 60)
        if df is None or df.empty:
            check(f"{tf} 有資料", False, "空")
            continue
        t = pd.to_datetime(df["time"])
        last = t.dt.date.max()
        cnt = int((t.dt.date == last).sum())
        _TFM = {"5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240}
        _lo, _hi, _note = _expect("tw", lo, hi, last, t.max() if tf in _TFM else None, _TFM.get(tf))
        if _lo is None:
            skip(f"{tf} 最後交易日根數", _note)
        else:
            check(f"{tf} 最後交易日 {cnt} 根（預期 {_lo}~{_hi}）", _lo <= cnt <= _hi,
                  f"{last}{('  ' + _note) if _note else ''}")
    except Exception as e:
        check(f"{tf} 有資料", False, f"{type(e).__name__}: {e}")

print("\n⑦ 美股／港股同一個坑（30m/2h 曾經也是日線）")
US_EXPECT = {"15m": (20, 30), "30m": (11, 15), "1h": (6, 8), "2h": (3, 5), "4h": (2, 3), "1d": (1, 1)}
for mkt, sym in (("us", "AAPL"), ("hk", "0700.HK")):
    for tf, (lo, hi) in US_EXPECT.items():
        try:
            df = fetch_crt_df(mkt, sym, tf, 30)
            if df is None or df.empty:
                check(f"{mkt} {tf} 有資料", False, "空")
                continue
            t = pd.to_datetime(df["time"])
            last = t.dt.date.max()
            cnt = int((t.dt.date == last).sum())
            _TFM7 = {"15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240}
            # 同 ⑥：用資料自己的最後一根縮放（yfinance 港股本來就延遲，實測 30m 被誤判 6 根 < 7）
            _lo, _hi, _note = _expect(mkt, lo, hi, last, t.max() if tf in _TFM7 else None, _TFM7.get(tf))
            if _lo is None:
                skip(f"{mkt} {tf} 最後交易日根數", _note)
            else:
                check(f"{mkt} {tf} 最後交易日 {cnt} 根（預期 {_lo}~{_hi}）", _lo <= cnt <= _hi,
                      f"{last}{('  ' + _note) if _note else ''}")
        except Exception as e:
            check(f"{mkt} {tf} 有資料", False, f"{type(e).__name__}: {e}")

print("\n⑧ 上游下載途中斷線（上櫃 opendata 實測約 1/6 會斷；不可以讓清單少掉一整個市場）")
# ★ 2026-09-17：這支的 ② 在真實網路下時紅時綠（[1689, 2681, 2681]）——根因是上櫃那份
#   約 3.9MB 的回應下載到一半被對方關掉（ChunkedEncodingError），http_pool 的重試管不到
#   「內容下載」這段 → 那一輪上櫃一千多檔整批不見。
#   靠真實網路碰運氣驗不出修好沒有 → 這裡直接注入斷線，結果是確定的。
import requests as _rq
_orig_get = TW.SESSION.get
_calls = {"n": 0}


def _flaky(fail_times):
    def _g(url, *a, **k):
        if url == TW.TPEX_DAY_ALL_URL:
            _calls["n"] += 1
            if _calls["n"] <= fail_times:
                raise _rq.exceptions.ChunkedEncodingError("模擬：內容下載到一半連線被關")
        return _orig_get(url, *a, **k)
    return _g


try:
    # A. 冷啟動（手上沒有上一份）只斷一次 → 內容重試要救回完整清單
    reset(); _calls["n"] = 0
    TW.SESSION.get = _flaky(1)
    _nA = len(TW.fetch_tw_tickers())
    check("斷一次 → 重試救回完整清單", _nA >= n0 * 0.95 and _calls["n"] >= 2,
          f"{_nA} 檔（基準 {n0}）、上櫃請求 {_calls['n']} 次")
    # B. 手上有上一份、這輪怎麼重試都斷 → 沿用上一份，上櫃那批一檔都不能少
    TW.SESSION.__dict__.pop("get", None)
    reset()
    TW.fetch_tw_tickers()
    _prev_otc = set((TW._dump_cached(TW.TPEX_DAY_ALL_URL, TW.DUMP_TICKERS) or {}).keys())
    _calls["n"] = 0
    TW.SESSION.get = _flaky(99)
    _symsB = {x["symbol"] for x in TW.fetch_tw_tickers()}
    _lost = _prev_otc - _symsB
    check("一直斷 → 沿用上一份，上櫃不縮水", len(_prev_otc) > 500 and not _lost,
          f"上一份上櫃 {len(_prev_otc)} 檔，這輪少了 {len(_lost)} 檔（上櫃請求 {_calls['n']} 次）")
finally:
    TW.SESSION.__dict__.pop("get", None)   # 還原成類別上的方法

print("\n⑨ 鉅亨回 HTTP 200 但內容是伺服器錯誤（statusCode 5031「Redis連線錯誤」，實測約 5~10%）")
# ★ 2026-09-17：原本只看 HTTP 狀態 → 5031 被當成「沒資料」→ 台股當日 K 退回落後約 20 分鐘的 yfinance。
#   規則：statusCode≥500 重試 1 次；「真的沒資料」（statusCode 200 ＋ t 空陣列）不可重試（會白打一倍）。
import data.cnyes_futures as CN   # noqa: E402


class _FakeResp:
    status_code = 200
    def __init__(self, body): self._b = body
    def raise_for_status(self): pass
    def json(self): return self._b


_ERR = {"statusCode": 5031, "message": "Redis連線錯誤", "data": []}
_now = int(time.time())
_OK = {"statusCode": 200, "message": "OK", "data": {"s": "ok", "t": [_now - 120, _now - 60],
       "o": [1, 2], "h": [1, 2], "l": [1, 2], "c": [1, 2], "v": [1, 1]}}
_EMPTY = {"statusCode": 200, "message": "OK", "data": {"s": "ok", "t": [], "o": [], "h": [], "l": [], "c": [], "v": []}}
_cn = {"n": 0}


def _script(bodies):
    def _g(url, *a, **k):
        if url != CN._BASE:
            return _orig_get(url, *a, **k)
        _cn["n"] += 1
        return _FakeResp(bodies[min(_cn["n"] - 1, len(bodies) - 1)])
    return _g


try:
    for _name, _bodies, _want_df, _want_calls in (
        ("一次 5031 → 重試後拿到資料", [_ERR, _OK], True, 2),
        ("真的沒資料（200＋空）→ 不重試", [_EMPTY], False, 1),
        ("連續 5031 → 只重試 1 次就放棄（不在請求裡死等）", [_ERR, _ERR, _ERR], False, 2),
    ):
        CN._stock_cache.clear(); _cn["n"] = 0
        CN.SESSION.get = _script(_bodies)
        _df = CN.fetch_cnyes_stock_intraday("2330", "1m")
        _got = _df is not None and not _df.empty
        check(_name, _got == _want_df and _cn["n"] == _want_calls, f"拿到資料={_got}、請求 {_cn['n']} 次")
finally:
    CN.SESSION.__dict__.pop("get", None)
    CN._stock_cache.clear()

print("\n⑩ 對方「慢慢吐」的下載要有總時限（上櫃實測一次拖 685 秒、清單背景更新整個卡住）")
# ★ requests 的 timeout 是「兩次收到資料之間」的上限，不是整個下載 → 用本機假伺服器每 0.2 秒吐 64 bytes，
#   舊寫法 12 秒後還卡著（逾時從沒觸發）。這項不打外部網路、結果確定。
import json as _json                                          # noqa: E402
import threading as _thr                                      # noqa: E402
from http.server import ThreadingHTTPServer as _HS, BaseHTTPRequestHandler as _BH   # noqa: E402
_BODY = _json.dumps([{"Code": f"{i:04d}"} for i in range(20000)]).encode()


class _Trickle(_BH):
    def log_message(self, *a): pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(_BODY)))
        self.end_headers()
        try:
            if self.path.startswith("/fast"):
                self.wfile.write(_BODY)
                return
            for i in range(0, len(_BODY), 64):
                self.wfile.write(_BODY[i:i + 64]); self.wfile.flush(); time.sleep(0.2)
        except Exception:
            pass


_srv = _HS(("127.0.0.1", 0), _Trickle)
_thr.Thread(target=_srv.serve_forever, daemon=True).start()
_base = f"http://127.0.0.1:{_srv.server_address[1]}"
# ⚠ 在背景執行緒裡跑、最多等 6 秒：程式若退化回「沒有總時限」，這一呼叫會真的卡 19 分鐘，
#   守門員自己被拖垮（等於沒回報）。用模組常數設時限（不用參數）→ 植回舊碼時照樣呼叫得起來、照樣卡住＝叫得出狼。
_budget_orig = TW._TW_BODY_BUDGET if hasattr(TW, "_TW_BODY_BUDGET") else None
TW._TW_BODY_BUDGET = 2
try:
    _res = {}

    def _slow_call():
        _t0 = time.monotonic()
        try:
            TW._get_body_retry(_base + "/slow")
            _res["v"] = ("拿到內容", time.monotonic() - _t0)
        except Exception as _e:
            _res["v"] = (type(_e).__name__, time.monotonic() - _t0)

    _th = _thr.Thread(target=_slow_call, daemon=True)
    _th.start()
    _th.join(6)
    if _th.is_alive():
        check("慢慢吐 → 總時限到點切斷", False, "6 秒後還卡在下載裡（沒有總時限）")
    else:
        _kind, _dt = _res["v"]
        check("慢慢吐 → 總時限到點切斷", _kind == "Timeout" and _dt < 3.5,
              f"時限 2s、{_kind} 於 {_dt:.2f}s（完整下載要 {len(_BODY)//64*0.2:.0f}s）")
    _r = TW._get_body_retry(_base + "/fast")
    check("正常回應不受影響（內容完整、r.json() 可用）", len(_r.json()) == 20000, f"{len(_r.content)//1024}KB")
finally:
    if _budget_orig is not None:
        TW._TW_BODY_BUDGET = _budget_orig
    _srv.shutdown()

print()
if FAILS:
    print(f"★ 失敗 {len(FAILS)} 項：{FAILS}")
    sys.exit(1)
print("★ 台股來源全部通過")
