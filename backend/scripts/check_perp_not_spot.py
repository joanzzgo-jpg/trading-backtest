#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：永續（`.P`）在主要來源失敗時，**絕不可**降級成「現貨」資料。

用法（本機服務不用跑）：
    cd backend && ../.venv312/bin/python scripts/check_perp_not_spot.py

為什麼需要這支（2026-08-08）
    使用者回報「主圖跟合約行情數值有時候對不上」。查下去不是延遲、不是誰凍住 ——
    前端送的是 exchange=binance，於是 `.P` 走不進 fetch_crypto_ohlcv 的永續專用鏈，
    落到「無 .P」那段：第一步 fapi（對的），但 fapi 一失敗**第二步就是現貨**。
    實測主圖 BTC/USDT.P 顯示 64980.26，恰好等於 Binance 現貨 64980.25，
    而永續各家都是 64952~64953 —— 差 28 點（4.3bps）。

    這個坑最惡毒的地方是**完全不報錯**：圖上有 K 棒、時間對、看起來一切正常，
    只是那是另一個商品。而且現貨棒一旦被混進永續序列，就會生出 Binance 上不存在的
    假 FVG／錯收盤／接縫，還會被寫進倉庫固化下來。

測法
    把 _fetch_binance_fapi 打掉（模擬熔斷/限流），看降級後拿到的收盤價貼近「永續」還是「現貨」。
    ⚠ 需要當下永續與現貨有可分辨的基差（<1 就判定測試不成立，回傳 2，不是通過）。
    ⚠ 已驗證抓得到：把條件植回舊版 `ex == "pionex" and is_perp` → 拿到的值距現貨 0.00。

回傳碼：0 通過 / 1 抓到降級成現貨 / 2 測試不成立（基差太小或抓不到真值）
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data import crypto  # noqa: E402

SYMBOL = "BTC/USDT.P"


def _truth():
    """直接跟交易所要「永續」與「現貨」的現價當基準（不經過我們自己的程式碼）。"""
    def g(u):
        return json.load(urllib.request.urlopen(u, timeout=10))
    perp = float(g("https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT")["price"])
    spot = float(g("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT")["price"])
    return perp, spot


def main() -> int:
    try:
        perp_px, spot_px = _truth()
    except Exception as e:
        print(f"✗ 取不到真值（{type(e).__name__}: {str(e)[:80]}）→ 測試不成立")
        return 2
    basis = spot_px - perp_px
    print(f"真值：永續 {perp_px}　現貨 {spot_px}　基差 {basis:+.2f}")
    if abs(basis) < 1:
        print("✗ 此刻基差 <1，兩者分辨不出來 → 測試不成立（不是通過），換時間再跑")
        return 2

    _orig = crypto._fetch_binance_fapi

    def _boom(*a, **k):
        raise RuntimeError("模擬 Binance fapi 熔斷/限流")

    crypto._fetch_binance_fapi = _boom
    try:
        df = crypto.fetch_crypto_ohlcv(SYMBOL, "1m", exchange_id="binance", limit=3)
        src = crypto.last_fetch_source()
        got = float(df.iloc[-1]["close"])
    except Exception as e:
        # 全部永續來源都掛 → 拋錯是**正確**行為（寧可沒有，也不要給現貨）
        print(f"✓ 永續來源全掛時直接拋錯，沒有偷渡現貨（{str(e)[:60]}）")
        return 0
    finally:
        crypto._fetch_binance_fapi = _orig

    d_perp, d_spot = abs(got - perp_px), abs(got - spot_px)
    print(f"fapi 失敗後拿到：{got}（來源 {src}）　距永續 {d_perp:.2f}　距現貨 {d_spot:.2f}")
    bad = []
    if src == "binance":
        bad.append("來源仍標 binance —— fapi 已被打掉，只可能是走了現貨路徑")
    if d_spot < d_perp:
        bad.append(f"數值貼近『現貨』而非永續（{d_spot:.2f} vs {d_perp:.2f}）")
    if bad:
        print("✗ 失敗：" + "；".join(bad))
        return 1
    print("✓ 永續降級後仍是永續資料（未被現貨污染）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
