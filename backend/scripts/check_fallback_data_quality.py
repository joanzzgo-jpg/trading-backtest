#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""守門員：降級來源的 K 棒必須跟主來源對得上（防「假 FVG」）。

用法（不需要服務跑著，直接打交易所）：
    cd backend && ../.venv312/bin/python scripts/check_fallback_data_quality.py

為什麼需要這支
    這個專案被這個 bug 咬過一次，而且**完全不報錯**：Binance 熔斷 → 降級 Pionex →
    Pionex 的日線有損毀殘棒（BTC 2025-08-14 收盤 121583，Binance 是 118242，差 **2.86%**）
    → 那根假棒跟前後棒之間生出一個**假的 2.86% FVG**、還有錯的收盤價，
    然後被烤進 7 天長效快取持久化。使用者看到的是「策略標記怪怪的」，圖上什麼都正常。
    現行防線是「只有來源＝Binance 才寫長效快取」（見 CLAUDE.md），但那只是限縮汙染範圍，
    **沒有人在檢查降級來源的數值本身對不對**。

判準（刻意分三級，不做「有差就叫」）
    ・逐欄比 open/high/low/close，**按時間戳嚴格對齊**（不是第 N 根對第 N 根 ——
      位置對齊在兩邊最後一根不同步時會整排錯開，看起來卻很像通過）。
    ・去掉最後一根（可能還在形成，本來就會不一樣）。
    ・門檻**依欄位分開**（開/收 0.30%、影線 1.50%），數字怎麼來的見下方 THRESH_PCT 的註解。
      ⚠ 第一版用單一 0.30% 就被一根**真影線**叫起來了（BTC 日線 04-23，幣安被掃到比
        Bybit 深 0.517%，但同一根開/高/收吻合到 0.02% 內）→ 那是市場微結構不是壞資料。
    ・另驗**硬不變式** low ≤ min(open,close) 且 high ≥ max(open,close)：
      違反就是那根棒由兩份快照縫出來的，沒有別的可能，不必跟誰比對就能判死。
    ・某個來源在這個標的上根本不會被用到（例如 .P 永續一律走 Binance）→ 回報
      「無法比對」，**不算通過也不算失敗**（測試不成立要跟通過分開，見 repair_klines5m 的教訓）。

回傳碼：0 全部對得上 / 1 有來源數值對不上或違反硬不變式 / 2 測試不成立（連主來源都拿不到）
"""
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ★ 門檻**依欄位分開**，數字從實測分布推出來，不是調到變綠為止：
#   ・open/close 是「某一刻的成交價」，跨交易所貼得極近 —— 實測中位 0.005%、
#     連影線差 0.5% 的那天 close 也只差 0.0032% → 0.30% 已是中位的 60 倍，很鬆了。
#     而且出事那次打壞的正是 **close**（差 2.86%）→ 這欄要抓得緊。
#   ・high/low 是**影線極值**，本來就會因為「哪一家被掃得比較深」而不同：
#     實測 BTC 日線 2026-04-23（當日振幅 2.80% 的快速下殺）幣安 low 76504、Bybit 76900，
#     差 0.517%，但同一根的開/高/收都吻合到 0.02% 以內 → 那是真的插針，不是壞資料。
#     low 差異分布：中位 0.0138%、90 分位 0.048%、最大 0.517%。
#     → 門檻取 1.50%：約是實測最大真影線的 3 倍，同時仍比事故的 2.86% 低一截。
#   ⚠ 用單一 0.30% 門檻的第一版就是被這根真影線叫起來的。會叫狼來了的守門員比沒有更糟。
THRESH_PCT = {"open": 0.30, "close": 0.30, "high": 1.50, "low": 1.50}
FIELDS = ("open", "high", "low", "close")
CASES = [("BTC/USDT.P", "1h"), ("BTC/USDT.P", "1d"), ("ETH/USDT.P", "1h")]
FALLBACKS = ("bybit", "pionex")


def _keyed(df):
    """{epoch 秒: (o,h,l,c)}。★ 一定要用 `time` 欄 —— 這些 DataFrame 的 index 是
    RangeIndex（0,1,2…），拿 index 當時間就變成「第 N 根對第 N 根」的位置比對。"""
    out = {}
    if df is None or len(df) == 0 or "time" not in df.columns:
        return out
    for _, r in df.iterrows():
        t = r["time"]
        ts = int(t.timestamp()) if hasattr(t, "timestamp") else int(t)
        if ts > 1e12:
            ts //= 1000
        out[ts] = tuple(float(r[f]) for f in FIELDS)
    return out


def _bad_ohlc(v):
    o, h, l, c = v
    return (l > min(o, c) + 1e-9) or (h < max(o, c) - 1e-9)


def main() -> int:
    try:
        from data.crypto import fetch_crypto_ohlcv, last_fetch_source
    except Exception as e:
        print(f"✗ 匯入 data.crypto 失敗（{type(e).__name__}: {e}）→ 測試不成立")
        return 2

    def grab(sym, tf, ex):
        try:
            df = fetch_crypto_ohlcv(sym, tf, exchange_id=ex, limit=150)
        except Exception as e:
            return None, f"{type(e).__name__}: {str(e)[:50]}"
        return (_keyed(df), last_fetch_source())

    bad, compared, skipped = [], 0, 0
    for sym, tf in CASES:
        print(f"── {sym} {tf} ──")
        base, bsrc = grab(sym, tf, "binance")
        if not base:
            print(f"   主來源(binance) 拿不到（{bsrc}）→ 這組略過，不算失敗")
            continue
        for ex in FALLBACKS:
            got, src = grab(sym, tf, ex)
            if not got:
                print(f"   {ex:7s} 拿不到（{src}）→ 略過，不算失敗")
                continue
            if src == bsrc:
                print(f"   {ex:7s} 實際回的是 {src}（此標的不會用到 {ex}）→ 無法比對，不計分")
                skipped += 1
                continue
            common = sorted(set(base) & set(got))
            if common:
                common = common[:-1]          # 最後一根可能還在形成
            if len(common) < 20:
                print(f"   {ex:7s} 共同時間戳只有 {len(common)} 根 → 樣本不足，不計分")
                skipped += 1
                continue
            worst_f, worst_pct, worst_ts = None, 0.0, None
            meds, per_field_worst = {}, []
            for fi, fname in enumerate(FIELDS):
                ds = [abs(got[t][fi] - base[t][fi]) / base[t][fi] * 100 for t in common if base[t][fi]]
                meds[fname] = statistics.median(ds) if ds else 0.0
                fw, fwt = 0.0, None
                for t, d in zip(common, ds):
                    if d > fw:
                        fw, fwt = d, t
                    if d > worst_pct:
                        worst_f, worst_pct, worst_ts = fname, d, t
                per_field_worst.append((fname, fw, fwt))
            broken = [t for t in common if _bad_ohlc(got[t])]
            over = [(f, p, t) for f, p, t in per_field_worst if p > THRESH_PCT[f]]
            ok = (not over) and (not broken)
            import datetime as _dt
            wt = _dt.datetime.utcfromtimestamp(worst_ts).strftime("%m-%d %H:%M") if worst_ts else "-"
            print(f"   {'✓' if ok else '✗'} {ex:7s}(實得 {src:7s}) {len(common):3d} 根　"
                  f"中位差 c={meds['close']:.4f}% h={meds['high']:.4f}%　"
                  f"最大 {worst_pct:.3f}%({worst_f} @{wt} UTC)")
            compared += 1
            for f, pct, t in over:
                ts = _dt.datetime.utcfromtimestamp(t).strftime("%m-%d %H:%M")
                bad.append((sym, tf, ex, f"{f} 差 {pct:.2f}% > 門檻 {THRESH_PCT[f]}%（@{ts} UTC）"))
            if broken:
                t0 = _dt.datetime.utcfromtimestamp(broken[0]).strftime("%m-%d %H:%M")
                print(f"      ✗ 有 {len(broken)} 根違反 low≤min(o,c)≤max(o,c)≤high（第一根 @{t0} UTC）")
                bad.append((sym, tf, ex, f"{len(broken)} 根不可能的 K 棒（兩份快照縫出來的）"))

    print()
    if bad:
        print("★ 降級來源的數值對不上主來源 —— 這正是「假 FVG／錯收盤」的來源：")
        for sym, tf, ex, why in bad:
            print(f"   {sym} {tf} {ex}: {why}")
        return 1
    if compared == 0:
        print(f"✗ 一組都沒比到（{skipped} 組無法比對）→ 測試不成立，不是通過")
        return 2
    print(f"★ {compared} 組降級來源與主來源逐欄對得上"
          f"（開/收 {THRESH_PCT['open']}%、影線 {THRESH_PCT['high']}%），"
          f"且沒有不可能的 K 棒{f'；另有 {skipped} 組無法比對' if skipped else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
