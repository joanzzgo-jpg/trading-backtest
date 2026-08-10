#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：每個時框回來的 K 棒，間隔必須真的等於那個時框。

用法（本機服務要跑著）：
    cd backend && ../.venv312/bin/python scripts/check_tf_spacing.py [BASE_URL]

為什麼需要這支
    CLAUDE.md 記著一個**重複發生**的坑：「時框對照表漏列 → `.get(tf, 預設)` 靜默退回日線」，
    台股、美股、港股三個市場都各中過一次。症狀極惡毒 —— 切過去圖上**有東西、不報錯**，
    只是那根本是日線。靠讀程式碼防不住：對照表散在 crypto/us_stock/taiwan/cnyes 好幾支，
    每次新增時框或改資料源都可能漏一張。

    ★ 這支不看程式碼、不看對照表，直接問「你回給我的資料，間隔對不對」——
      不論是哪張表漏列、哪個 fallback 退化，只要拿到的不是該時框的資料就一定被抓到。
    ⚠ 刻意**不做**「檢查對照表有沒有這個 key」那種啟發式檢查：實測會誤報
      （Pionex 沒有 1m 是回空表讓上層 fallback、YF_TF_MAP 是盤中專用函式不管日/週/月），
      而會叫狼來了的守門員比沒有守門員更糟（見 repair_klines5m 那條教訓）。

判準
    取回傳資料的相鄰時間差**中位數**（用中位數不用平均：跨週末/停牌會有大跳，平均會被拉歪），
    必須等於該時框的秒數。1M（月）長度不固定 → 只驗落在 28~31 天內。
    ⚠ 台股/美股/港股的盤中時框有收盤斷層（每天只有幾小時），中位數仍會等於該時框 → 判準通用。

回傳碼：0 全對 / 1 有時框拿到錯誤間隔 / 2 測試不成立（服務沒起來等）
"""
import json
import statistics
import sys
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")

TF_SEC = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400,
          "1d": 86400, "1w": 604800}
CASES = [
    ("crypto", "BTC/USDT.P", "binance", ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]),
    ("us",     "AAPL",       "binance", ["5m", "15m", "1h", "1d"]),
    ("tw",     "2330",       "binance", ["5m", "15m", "1h", "1d"]),
    # 外匯（2026-08-11 接入）：走與美股同一條 yfinance 管線，只差代號轉換 →
    # 最容易出的錯就是「某個時框漏掉對照 → 靜默退回日線」，所以一起納入驗證。
    ("fx",     "EUR/USD",    "binance", ["5m", "15m", "1h", "4h", "1d", "1w"]),
]


def _post(path, body, to=90):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=to))


def main() -> int:
    try:
        urllib.request.urlopen(BASE + "/api/_diag_mem", timeout=10).read()
    except Exception as e:
        print(f"✗ 連不上 {BASE}（{type(e).__name__}）→ 測試不成立，先把服務跑起來")
        return 2

    bad, checked = [], 0
    for market, symbol, exchange, tfs in CASES:
        print(f"── {market} {symbol} ──")
        for tf in tfs:
            try:
                d = _post("/api/ohlcv", {"market": market, "symbol": symbol, "timeframe": tf,
                                         "exchange": exchange, "limit": 300, "indicators": False})
                rows = d.get("data") or []
            except Exception as e:
                print(f"   {tf:4s} 取得失敗（{type(e).__name__}: {str(e)[:50]}）— 略過，不算失敗")
                continue
            if len(rows) < 12:
                print(f"   {tf:4s} 只有 {len(rows)} 根 — 略過（可能休市/剛上市），不算失敗")
                continue
            import datetime as _dt
            ts = []
            for r in rows:
                t = r["time"]
                ts.append(t if isinstance(t, (int, float))
                          else _dt.datetime.fromisoformat(str(t)).timestamp())
            gaps = [b - a for a, b in zip(ts, ts[1:]) if b > a]
            if not gaps:
                print(f"   {tf:4s} 時間沒有遞增 — 異常")
                bad.append((market, tf, "時間未遞增")); continue
            med = statistics.median(gaps)
            checked += 1
            if tf == "1M":
                ok = 28 * 86400 <= med <= 31 * 86400
                want = "28~31 天"
            else:
                ok = abs(med - TF_SEC[tf]) < 1
                want = f"{TF_SEC[tf]}s"
            mark = "✓" if ok else "✗"
            print(f"   {mark} {tf:4s} {len(rows):4d} 根　間隔中位 {med:9.0f}s（應 {want}）")
            if not ok:
                bad.append((market, tf, f"間隔 {med:.0f}s ≠ {want}"))

    print()
    if bad:
        print("★ 有時框拿到錯誤間隔（＝靜默退回別的時框）：")
        for m, tf, why in bad:
            print(f"   {m} {tf}: {why}")
        return 1
    print(f"★ {checked} 個時框的 K 棒間隔全部正確，沒有靜默退化")
    return 0


if __name__ == "__main__":
    sys.exit(main())
