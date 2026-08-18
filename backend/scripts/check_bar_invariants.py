#!/usr/bin/env python
"""守門員：所有市場 × 所有時框回來的 K 棒，都必須滿足「一根 K 棒本來就該成立」的硬不變式。

用法（本機服務要跑著）：
    cd backend && ../.venv312/bin/python scripts/check_bar_invariants.py [BASE_URL]

為什麼需要這支
  這是**回測工具的地基**：K 棒本身錯了，上面所有的 FVG／勝率／訊號全部無效 —— 而畫面上
  完全看不出來（K 棒就是 K 棒，不會標示「這根是兩份快照縫出來的」）。
  現有的守門員各自只顧一塊：`check_tf_spacing` 只驗「間隔對不對」、`check_bar_stability`
  只盯 1m 即時那幾根、冒煙只驗一個組合。**沒有人驗過「每個市場每個時框拿回來的整段資料
  本身合不合法」** —— 而重採樣正是最會出事的地方：Bybit 沒有原生 8h/30m（由 4h/15m 重採樣、
  origin 要對齊 UTC）、台股/美股/港股的 30m/2h 也是自己分桶的。分桶邊界一錯，
  就會生出「低點比開盤還高」這種不可能的棒，或時間倒退／重複的棒。

判準（每一項都是「這樣就一定是壞的」，沒有模糊地帶）
  ① low ≤ min(open, close) 且 high ≥ max(open, close)
     —— 違反＝這根是兩份快照縫出來的，沒有別的可能（見 memory bar-moves-source-flapping）。
  ② high ≥ low
  ③ 時間嚴格遞增（不重複、不倒退）—— 重複的棒會讓回測把同一根算兩次。
  ④ 沒有未來棒（最後一根不可超過「現在 + 一個時框」）。
  ⑤ 價格與量都是有限數（不可 NaN／inf／負數）。
  ⑥ 間隔中位數 == 該時框（與 check_tf_spacing 重疊，但這裡順手驗，成本為零）。
  ⚠ 不驗「有沒有洞」：假日、停牌、永續上市日之前本來就有洞，那是 repair_klines5m 的守備範圍，
    在這裡驗一定會叫狼來了（見 CLAUDE.md 白名單那段）。

回傳碼：0 全部合法 / 1 有不合法的 K 棒 / 2 測試不成立（服務沒起來／全部組合都拿不到資料）
"""
import json
import sys
import time
import urllib.request
import pathlib
import statistics

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")

TF_SEC = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
          "4h": 14400, "8h": 28800, "1d": 86400, "1w": 604800, "1M": 2592000}

def _frontend_tfs():
    """★ 時框清單**從 config.js 的 TF_LABELS 抽**，不寫死。
    第一版寫死了 8h/2h/30m —— 它們早就被拿掉了（config.js:181 「8h/2h/30m 已移除」），
    結果 9 個組合回 400、印成一排「抓不到」，看起來像壞了其實是我在問不存在的東西。
    會叫狼來了的守門員比沒有更糟；從來源抽就永遠不會過期。"""
    import re
    cfg = (pathlib.Path(__file__).resolve().parents[2]
           / "frontend" / "static" / "js" / "config.js").read_text(encoding="utf-8")
    m = re.search(r"const\s+TF_LABELS\s*=\s*\{([^}]*)\}", cfg)
    if not m:
        return []
    return re.findall(r'"([^"]+)"\s*:', m.group(1))


_TFS = _frontend_tfs()
# 市場 → (標的, 交易所)。時框一律取「前端真的提供的」與本市場合理的交集。
# 分鐘級時框對日線型市場沒意義的組合由 _skip_tf 擋掉。
CASES = [
    ("crypto", "BTC/USDT.P", "binance"),
    ("crypto", "ETH/USDT.P", "binance"),
    ("tw",     "2330",       ""),
    ("us",     "AAPL",       ""),
    ("hk",     "0700.HK",    ""),
]


def _skip_tf(market, tf):
    # 1M 每根一個月、資料量小且日曆長度不一；1m 對非 crypto 的免費源多半沒有 → 不強求
    if tf == "1M":
        return True
    if market != "crypto" and tf == "1m":
        return True
    return False


def fetch(market, symbol, exchange, tf, limit=400):
    body = json.dumps({"market": market, "symbol": symbol, "exchange": exchange,
                       "timeframe": tf, "limit": limit}).encode()
    req = urllib.request.Request(BASE + "/api/ohlcv", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def to_epoch(v):
    """後端時間戳有兩種：epoch 整數（瘦身過的）與 ISO 字串。兩種都要吃。"""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    if "T" not in s:
        s += "T00:00:00"
    s = s.replace("Z", "+00:00")
    import datetime as _dt
    d = _dt.datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=_dt.timezone.utc)
    return d.timestamp()


def check_one(market, symbol, exchange, tf):
    """回 (狀態, 訊息, 根數)。狀態: ok / bad / skip"""
    try:
        j = fetch(market, symbol, exchange, tf)
    except Exception as e:  # noqa: BLE001
        return "skip", f"抓不到（{type(e).__name__}: {str(e)[:50]}）", 0
    rows = j.get("data") or []
    if len(rows) < 30:
        return "skip", f"只回 {len(rows)} 根（休市／無資料）", len(rows)

    bad = []
    ts = []
    for i, d in enumerate(rows):
        try:
            o, h, l, c = float(d["open"]), float(d["high"]), float(d["low"]), float(d["close"])
            v = float(d.get("volume") or 0)
            t = to_epoch(d["time"])
        except Exception as e:  # noqa: BLE001
            bad.append(f"第 {i} 根欄位壞掉（{type(e).__name__}）")
            continue
        ts.append(t)
        if not all(x == x and abs(x) != float("inf") for x in (o, h, l, c, v)):
            bad.append(f"第 {i} 根有 NaN/inf")
        if min(o, h, l, c) <= 0:
            bad.append(f"第 {i} 根有非正價格 O{o} H{h} L{l} C{c}")
        if v < 0:
            bad.append(f"第 {i} 根成交量為負 {v}")
        if h < l:
            bad.append(f"第 {i} 根 high({h}) < low({l})")
        if l > min(o, c) + 1e-9 or h < max(o, c) - 1e-9:
            # ★ 這一條就是「兩份快照縫在同一根」的鐵證
            bad.append(f"不可能的 K 棒 @第 {i} 根 O{o} H{h} L{l} C{c}")
        if len(bad) >= 4:
            break

    for i in range(1, len(ts)):
        if ts[i] <= ts[i - 1]:
            bad.append(f"時間沒有遞增：第 {i-1}→{i} 根 {ts[i-1]:.0f} → {ts[i]:.0f}")
            break

    sec = TF_SEC.get(tf)
    if ts and sec:
        # 未來棒：容忍「形成中那一根」+ 一點時鐘誤差
        ahead = ts[-1] - time.time()
        if ahead > sec + 120:
            bad.append(f"最後一根在未來 {ahead/60:.0f} 分鐘")
        gaps = [ts[i] - ts[i - 1] for i in range(1, len(ts)) if ts[i] > ts[i - 1]]
        if gaps:
            # ★ 判準用「**最小**正間隔」，不用中位數。
            # 中位數只在「一天塞得下很多根」時才等於時框。美股一天只有 6.5 小時 → 4h 分桶後
            # 每天 2 根：盤中那個間隔 4h、跨日那個 20h，兩種**各佔一半** → 中位數是擲骰子，
            # 實測 us/hk 4h 就被判成 72000s ≠ 14400s（我第一版就這樣誤報）。
            # 既有的 check_tf_spacing 寫著「中位數判準通用」，但它從來沒測過股市的 4h。
            # 同一個 session 內的相鄰棒必然剛好差一個時框 → 最小間隔對 24 小時市場與
            # 有收盤的市場都成立；而「比時框還小的間隔」本身就是 bug（重複/錯位的棒）。
            mn = min(gaps)
            okgap = (0.8 * sec <= mn <= 1.25 * sec) if tf in ("1M", "1w") else (abs(mn - sec) < 1)
            if not okgap:
                med = statistics.median(gaps)
                bad.append(f"最小間隔 {mn:.0f}s ≠ {sec}s（中位 {med:.0f}s）")

    if bad:
        return "bad", "；".join(bad[:3]), len(rows)
    return "ok", f"{len(rows)} 根", len(rows)


def main():
    try:
        urllib.request.urlopen(BASE + "/api/econ_events", timeout=15).read()
    except Exception as e:  # noqa: BLE001
        print(f"✗ 連不上服務（{type(e).__name__}）→ 測試不成立")
        return 2

    total = ok = skipped = 0
    fails = []
    if len(_TFS) < 5:
        print(f"✗ 從 config.js 只抽到 {len(_TFS)} 個時框（預期 ≥5）→ 抽取壞了，測試不成立")
        return 2
    print(f"   時框清單從 config.js 的 TF_LABELS 抽出：{' '.join(_TFS)}\n")
    for market, symbol, exchange in CASES:
        print(f"── {market} {symbol} ──")
        for tf in [t for t in _TFS if not _skip_tf(market, t)]:
            total += 1
            st, msg, n = check_one(market, symbol, exchange, tf)
            mark = {"ok": "✓", "bad": "✗", "skip": "○"}[st]
            print(f"   {mark} {tf:4} {msg}")
            if st == "ok":
                ok += 1
            elif st == "skip":
                skipped += 1
            else:
                fails.append(f"{market} {symbol} {tf}：{msg}")

    print()
    print(f"   {total} 個組合：{ok} 通過、{len(fails)} 不合法、{skipped} 沒資料（休市/無此商品）")
    if ok < 8:
        print("✗ 真正驗到的組合太少（<8）→ 多半是網路或休市，測試不成立")
        return 2
    if fails:
        print("\n★ 有市場/時框回了不合法的 K 棒（圖上看不出來，但上面的回測全部無效）：")
        for f in fails:
            print(f"   {f}")
        print("   「不可能的 K 棒」幾乎一定是重採樣分桶或跨來源接合出的問題：")
        print("   crypto 8h/30m 由 Bybit 4h/15m 重採樣（origin 要對齊 UTC）、台股/美股/港股 30m/2h 自己分桶。")
        return 1
    print("★ 所有市場/時框的 K 棒都滿足硬不變式（沒有不可能的棒、沒有時間倒退、沒有未來棒）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
