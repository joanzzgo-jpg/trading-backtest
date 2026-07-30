"""暖機 K 線倉庫(BTC/ETH/SOL/XAUT × 5m/4h/1d)。手動跑,存到 backend/data/klines5m/(版控)。

用法(在專案根)：
    backend/.venv312/bin/python scripts/warm_5m.py                 # 全標的 × 全時框(5m 1年、4h/1d 全歷史)
    backend/.venv312/bin/python scripts/warm_5m.py 12              # 只把尾巴補到今天(所有時框,最快)
    backend/.venv312/bin/python scripts/warm_5m.py 370 BTC        # 只 BTC
    backend/.venv312/bin/python scripts/warm_5m.py 370 ALL 4h,1d  # 只暖 4h/1d(快,幾MB)

放慢節奏避開限流;可重複跑(只補新的、自動去重)。暖完 commit 一次即可(隨 git 部署到 Railway、全用戶共用)。
"""
import os
import sys
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from data.crypto import fetch_crypto_ohlcv          # noqa: E402
from data import klines_store                        # noqa: E402

ALL = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XAUT/USDT"]
# 每時框:抓多深(天)、每塊多大(天)。
# ★塊不能大(2026-07-30 教訓):原本 4h 一塊 700 天。塊只要**跨過該幣的永續上線日**
#   (BTC 2019-09-08 / ETH 2019-11-27),fapi 會回「非空、但只有上線後那一小截」→
#   fetch_crypto_ohlcv 的 fallback 只在完全空時才觸發 → 前面整段被靜默丟掉、洞就這樣被
#   固化進版控檔(BTC/ETH 4h 各因此少了 10 個月,上線後才被深滑 E2E 抓到)。
#   → 每塊壓到約 500~1500 根:跨界時受害範圍小,且暖完的自動補洞能把它補乾淨。
TF_CFG = {"5m": (370, 5), "4h": (4000, 120), "1d": (4500, 1000)}
PAUSE = 1.2          # 每塊間隔秒(避限流)


def warm(sym: str, tf: str, days: int, chunk_days: int):
    start_limit = datetime.now(timezone.utc) - timedelta(days=days)
    end = datetime.now(timezone.utc)
    total = 0
    empty_run = 0
    while end > start_limit:
        start = max(end - timedelta(days=chunk_days), start_limit)
        s, e = start.strftime("%Y-%m-%d"), (end + timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            df = fetch_crypto_ohlcv(sym, tf, s, e, "binance", limit=0)
        except Exception as ex:
            print(f"  {sym} {tf} {s}~{e} 失敗: {str(ex)[:80]}")
            df = None
        if df is not None and not df.empty:
            n = klines_store.save(sym, tf, df)
            total += len(df)
            empty_run = 0
            print(f"  {sym} {tf} {s}~{e}: +{len(df):>5} 根  (倉庫共 {n})")
        else:
            empty_run += 1
            print(f"  {sym} {tf} {s}~{e}: 空")
            if empty_run >= 6:       # 連續空＝已抓到該幣上線前,再往前也是空 → 提早收工
                print(f"  {sym} {tf}: 連續 {empty_run} 塊皆空,判定已到資料起點,停止往前")
                break
        end = start
        time.sleep(PAUSE)
    return total


if __name__ == "__main__":
    days_override = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
    want = (sys.argv[2].upper() if len(sys.argv) > 2 else "ALL")
    syms = ALL if want == "ALL" else [x for x in ALL if x.startswith(want)]
    tfs = (sys.argv[3].split(",") if len(sys.argv) > 3 else list(TF_CFG.keys()))
    print(f"暖機倉庫:{syms} × {tfs}  → backend/data/klines5m/")
    for sym in syms:
        for tf in tfs:
            if tf not in TF_CFG:
                continue
            d, ck = TF_CFG[tf]
            # days 覆寫對所有時框生效(2026-07-30 改):save() 只做「合併+去重」,淺暖不會刪掉既有深歷史
            #   → 「只把尾巴補到今天」可以用 `warm_5m.py 12` 一次刷完全部時框,不必整包重抓。
            d = days_override or d
            print(f"=== {sym} {tf} (最近 {d} 天) ===")
            warm(sym, tf, d, ck)
            # ★暖完立刻自我驗證+補洞:別再讓「缺一塊」靜默固化進版控檔(見 TF_CFG 註)。
            #   補不回來的(標的上線前/交易所停機)會列出但不當失敗。
            holes = klines_store.find_holes(klines_store.load_all(sym, tf), tf)
            if holes:
                print(f"  ⚠ 暖完仍有 {len(holes)} 個破洞 → 自動補抓")
                _, left = klines_store.repair_holes(sym, tf, log=lambda m: print("  " + m))
                print(f"  → 補完剩餘破洞 {left}" + ("（皆為資料源本身沒有）" if left else " ✓"))
            else:
                print("  破洞 0 ✓")
    print("完成。commit 前先跑 backend/scripts/repair_klines5m.py 確認破洞數;"
          "commit 後隨 git 部署到 Railway、所有用戶共用,本機重啟即讀新庫。")
