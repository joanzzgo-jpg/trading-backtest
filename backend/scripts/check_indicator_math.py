#!/usr/bin/env python3
"""守門員：指標的數學必須與獨立實作一致（2026-09-26；需服務跑著，約 20 秒）

RSI / MACD / KDJ / 布林是這個回測工具畫在圖上、也餵進策略閘門的東西。
它們算錯的形狀**全都是靜默的**：線照樣畫、數字照樣跳，只是值不對 ——
而所有以它為依據的判斷（FVG 進場閘門、到價通知）跟著一起錯。
既有守門員沒有人管這塊：`check_crt_golden` 鎖的是**標記輸出的雜湊**（換了公式它會紅，
但只會說「輸出變了」，不會說「哪個指標算錯」）、`check_bar_invariants` 只管 K 棒本身。

判準＝拿端點實際回的欄位，與**獨立寫一次的參考實作**逐點比：
  ・RSI(14)/RSI(7)：Wilder 平滑（α = 1/n）
  ・MACD(12,26,9)：EMA(12) − EMA(26)、signal = EMA(9)、hist = MACD − signal（adjust=False）
  ・KDJ(9,3)：RSV =(C−Ln)/(Hn−Ln)×100、K/D 用 α=1/3 遞迴、J = 3K − 2D
  ・布林(20,2)：SMA ± 2σ
⚠ 容許 0.005% 相對誤差：**傳輸時有四捨五入**（實測最大 0.0005%）。不是算錯。

★★ 布林的標準差慣例（2026-09-26 查證）：目前用 pandas 預設的 **ddof=1（樣本）**，
   而 TradingView 等看盤軟體用 **ddof=0（母體）** → 我們的通道系統性寬 2.53%。
   實測 BTC 4h 1580 根：換成 ddof=0 會讓「碰到上下軌」的判定變動 **46 根（2.9%）**，
   而那個判定是 `crt.py` 的 FVG 進場閘門之一、也餵 `notify_monitor` 的訊號 →
   **換慣例＝改變回測輸出**，屬於產品決策，不是 bug。
   這支把現行慣例**鎖住**：哪天有人改了 ddof，這裡會紅，提醒他那是有後果的改動
   （真要改：同步跑 `check_crt_golden.py --update` 並在 commit 寫明）。

⚠ 回傳碼 2＝測試不成立（服務沒跑／拿不到指標欄位），不是通過。
"""
import json
import os
import sys
import urllib.request

import numpy as np
import pandas as pd

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:8000")
TOL_PCT = 0.005          # 相對誤差容許（傳輸四捨五入，實測 0.0005%）
CASES = [("crypto", "BTC/USDT.P", "1h", "binance"),
         ("crypto", "ETH/USDT.P", "4h", "binance")]


def fetch(market, symbol, tf, ex, limit=500):
    body = json.dumps({"market": market, "symbol": symbol, "timeframe": tf,
                       "exchange": ex, "limit": limit, "indicators": True}).encode()
    req = urllib.request.Request(f"{BASE}/api/ohlcv", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return pd.DataFrame(json.load(r)["data"])


def cmp(bad, tag, prod, ref):
    m = prod.notna() & ref.notna()
    if m.sum() < 50:
        bad.append(f"{tag}：可比對的點只有 {int(m.sum())} 個（測試不成立）")
        return None
    denom = ref[m].abs().replace(0, np.nan)
    rel = ((prod[m] - ref[m]).abs() / denom).max() * 100
    if not np.isfinite(rel):
        rel = 0.0
    if rel > TOL_PCT:
        bad.append(f"{tag}：與獨立實作最大相對差 {rel:.4f}% > 容許 {TOL_PCT}%")
    return rel


def main():
    bad, rows = [], []
    for market, symbol, tf, ex in CASES:
        try:
            df = fetch(market, symbol, tf, ex)
        except Exception as e:
            print(f"⚠ 測試不成立：{symbol} {tf} 取不到（{str(e)[:60]}）")
            sys.exit(2)
        need = ["rsi_14", "rsi_7", "macd", "macd_signal", "macd_hist",
                "kdj_k", "kdj_d", "bb_upper", "bb_middle", "bb_lower"]
        miss = [k for k in need if k not in df.columns]
        if miss:
            print(f"⚠ 測試不成立：{symbol} {tf} 少了欄位 {miss}（端點沒帶 indicators？）")
            sys.exit(2)
        c = df["close"].astype(float)
        h = df["high"].astype(float)
        lo = df["low"].astype(float)

        def wilder_rsi(s, n):
            d = s.diff()
            ag = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
            al = (-d).clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
            return 100 - 100 / (1 + ag / al)

        ema12 = c.ewm(span=12, adjust=False).mean()
        ema26 = c.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        sig = macd.ewm(span=9, adjust=False).mean()
        ll, hh = lo.rolling(9).min(), h.rolling(9).max()
        rsv = (c - ll) / (hh - ll) * 100
        k = rsv.ewm(alpha=1 / 3, adjust=False).mean()
        dd = k.ewm(alpha=1 / 3, adjust=False).mean()
        ma = c.rolling(20).mean()
        sd1 = c.rolling(20).std()          # ← 現行慣例（樣本標準差）
        sd0 = c.rolling(20).std(ddof=0)    # ← TradingView 慣例（母體）

        res = {
            "RSI 14":      cmp(bad, f"{symbol} {tf} RSI14", df["rsi_14"].astype(float), wilder_rsi(c, 14)),
            "RSI 7":       cmp(bad, f"{symbol} {tf} RSI7",  df["rsi_7"].astype(float),  wilder_rsi(c, 7)),
            "MACD":        cmp(bad, f"{symbol} {tf} MACD",  df["macd"].astype(float), macd),
            "MACD signal": cmp(bad, f"{symbol} {tf} MACDsig", df["macd_signal"].astype(float), sig),
            "MACD hist":   cmp(bad, f"{symbol} {tf} MACDhist", df["macd_hist"].astype(float), macd - sig),
            "KDJ K":       cmp(bad, f"{symbol} {tf} KDJ_K", df["kdj_k"].astype(float), k),
            "KDJ D":       cmp(bad, f"{symbol} {tf} KDJ_D", df["kdj_d"].astype(float), dd),
            "BB 中軌":      cmp(bad, f"{symbol} {tf} BBmid", df["bb_middle"].astype(float), ma),
            "BB 上軌":      cmp(bad, f"{symbol} {tf} BBup",  df["bb_upper"].astype(float), ma + 2 * sd1),
            "BB 下軌":      cmp(bad, f"{symbol} {tf} BBlo",  df["bb_lower"].astype(float), ma - 2 * sd1),
        }
        rows.append((f"{symbol} {tf}", len(df), res))

        # 慣例鎖：現行是 ddof=1；若哪天改成 ddof=0 會在這裡被指名
        m = df["bb_upper"].notna()
        d0 = ((df["bb_upper"].astype(float)[m] - (ma + 2 * sd0)[m]).abs() / (ma + 2 * sd0)[m].abs()).max() * 100
        if d0 <= TOL_PCT:
            bad.append(f"{symbol} {tf}：布林改用 ddof=0（母體標準差）了 —— 通道會窄 2.5%、"
                       f"「碰軌」判定跟著變（實測 1580 根 4h 變動 46 根）。"
                       f"這是有後果的改動：確認是刻意的就更新本守門員，並跑 check_crt_golden.py --update。")

    for tag, n, res in rows:
        print(f"{tag}（{n} 根）")
        for k2, v in res.items():
            print(f"  {'✓' if (v is not None and v <= TOL_PCT) else '✗'} {k2:<12} 最大相對差 "
                  f"{'—' if v is None else f'{v:.5f}%'}")
    print()
    if bad:
        print("✗ 失敗：")
        for b in bad:
            print("   " + b)
        sys.exit(1)
    print(f"★ RSI／MACD／KDJ／布林 與獨立實作逐點一致（容許 {TOL_PCT}% 的傳輸四捨五入）")
    sys.exit(0)


if __name__ == "__main__":
    main()
