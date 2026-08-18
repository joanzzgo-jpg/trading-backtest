#!/usr/bin/env python3
"""K 線倉庫「破洞」掃描與修補（薄 CLI，邏輯在 data/klines_store.py）。

為什麼需要：倉庫檔（backend/data/klines5m/*.pkl.gz）是版控的、會一起上 Railway。
一旦某次暖機/回填在中途缺一塊，那個洞就被**固化進檔案**，之後所有讀倉庫的請求都拿到有洞的
資料 —— 不報錯、不拋例外，K 線只是「少一段」。2026-07-30 實測抓到 BTC 5m 缺 434 根、
BTC/ETH 4h 各缺 10 個月，全都已 commit 上線才被深滑 E2E 發現。

★診斷提醒：只有「請求範圍完全落在倉庫涵蓋內」時洞才會露出來。超出倉庫尾端的範圍會整段退 API
（API 沒洞）→ 查起來像沒事。所以「我查過沒事」不代表沒事。

用法（在 backend/ 下）：
    python scripts/repair_klines5m.py               # 只掃描（出現**新**破洞才回傳碼 1，可當推送前守門）
    python scripts/repair_klines5m.py --strict      # 已知破洞也算失敗（要看原始全貌時用）
    python scripts/repair_klines5m.py --fix         # 掃描並補抓後存回
    python scripts/repair_klines5m.py --fix --tf 5m # 只處理 5m

補不回來的（資料源本身就沒有：標的上線前、交易所長時間停機）會列出但不當失敗——
掃描模式下由下面的 _KNOWN_HOLES 白名單認定。

★ 為什麼要有白名單（2026-07-31 加）：現存 15 個洞全是**永久性**的（2018-19 幣安中斷、
  XAUT 永續上市日之前），所以原本的「有洞就回 1」等於**永遠回 1** → 當守門員是狼來了，
  真的多出新洞時完全分辨不出來。改成只有「不在白名單裡的洞」才算失敗。
  新增一個洞前請先確認它真的補不回來（跑 --fix 補過還在），再把它加進白名單並註明原因。
"""
import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data.klines_store import (  # noqa: E402
    save, load_all, find_holes, repair_holes,
                               SYMBOLS, STORE_TFS)

# 已確認補不回來的破洞（資料源本身就沒有）。鍵＝(標的, 時框, 洞前最後一根, 洞後第一根)。
# 洞若「變寬」，洞後第一根會位移 → tuple 對不上 → 照樣會被當成新洞抓出來。
_KNOWN_HOLES = {
    # ── 2018-2019 幣安現貨的實際停機（BTC/ETH 同時缺、缺在同樣的時間點）──────────
    ("BTC/USDT", "4h", "2018-02-08 00:00:00", "2018-02-09 08:00:00"),
    ("BTC/USDT", "4h", "2018-06-26 00:00:00", "2018-06-26 12:00:00"),
    ("BTC/USDT", "4h", "2018-07-04 00:00:00", "2018-07-04 08:00:00"),
    ("BTC/USDT", "4h", "2018-11-14 00:00:00", "2018-11-14 08:00:00"),
    ("BTC/USDT", "4h", "2019-03-12 00:00:00", "2019-03-12 08:00:00"),
    ("BTC/USDT", "4h", "2019-05-15 00:00:00", "2019-05-15 12:00:00"),
    ("BTC/USDT", "4h", "2019-08-15 00:00:00", "2019-08-15 08:00:00"),
    ("ETH/USDT", "4h", "2018-02-08 00:00:00", "2018-02-09 08:00:00"),
    ("ETH/USDT", "4h", "2018-06-26 00:00:00", "2018-06-26 12:00:00"),
    ("ETH/USDT", "4h", "2018-07-04 00:00:00", "2018-07-04 08:00:00"),
    ("ETH/USDT", "4h", "2018-11-14 00:00:00", "2018-11-14 08:00:00"),
    ("ETH/USDT", "4h", "2019-03-12 00:00:00", "2019-03-12 08:00:00"),
    ("ETH/USDT", "4h", "2019-05-15 00:00:00", "2019-05-15 12:00:00"),
    ("ETH/USDT", "4h", "2019-08-15 00:00:00", "2019-08-15 08:00:00"),
    # ── XAUT 永續 2026-03-26 才上市，之前不存在（不是壞掉）────────────────────
    ("XAUT/USDT", "5m", "2026-03-25 23:55:00", "2026-03-26 14:00:00"),
}


def _is_known(sym, tf, a, b):
    return (sym, tf, str(a), str(b)) in _KNOWN_HOLES


def _extend(args) -> int:
    """把每個 (標的, 時框) 的倉庫從「最後一根」續抓到今天。

    為什麼要有這個：`--fix` 只補**已存區間內**的洞，補不了「倉庫停在 8/12、今天是 8/18」。
    而倉庫落後的代價是實測 **9 倍**：同樣一段 5m，倉庫涵蓋 8.6ms、要走 API 77.0ms。
    ⚠ 一定要**分段**抓：跨永續上線日的長區間，fapi 會回「非空但只有上線後那截」→ fallback
      不觸發 → 前段被靜默丟掉（見 CLAUDE.md 倉庫那段）。這裡一次只抓 ~7 天，天然分段。
    ⚠ 最後一根**要重抓**（從 last 當起點，不是 last+1）：它可能是當時還沒收盤的半成品，
      save() 會 drop_duplicates 保留後到的那一份。
    """
    import datetime as _dt
    from data.crypto import fetch_crypto_ohlcv
    today = _dt.date.today()
    grand = 0
    for sym in sorted(SYMBOLS):
        if args.symbol and not sym.upper().startswith(args.symbol.upper()):
            continue
        for tf in sorted(STORE_TFS):
            if args.tf and tf != args.tf:
                continue
            df = load_all(sym, tf)
            if df is None or df.empty:
                print(f"  {sym} {tf}: 倉庫是空的，跳過（先跑暖機）")
                continue
            last = df["time"].iloc[-1].date()
            if last >= today:
                print(f"  {sym} {tf}: 已到 {last}，不用補")
                continue
            added = 0
            cur = last
            while cur < today:
                nxt = min(cur + _dt.timedelta(days=7), today)
                try:
                    part = fetch_crypto_ohlcv(sym, tf, str(cur), str(nxt + _dt.timedelta(days=1)),
                                              exchange_id="binance")
                except Exception as e:  # noqa: BLE001
                    print(f"     {cur}~{nxt} 抓取失敗（{type(e).__name__}: {str(e)[:50]}）")
                    part = None
                if part is not None and not part.empty:
                    _cur_df = load_all(sym, tf)          # ⚠ DataFrame 不可用 `or`（真值判定會拋）
                    before = 0 if _cur_df is None else len(_cur_df)
                    total = save(sym, tf, part)
                    added += total - before
                cur = nxt
            after = load_all(sym, tf)
            _end = "(空)" if after is None or after.empty else str(after['time'].iloc[-1].date())
            # ⚠ 「新增」是**淨值**：5m 的 _KEEP_DAYS=370 → 尾巴長多少、頭就被 save() 砍多少
            #   → 這個數字會是 0，但尾端日期確實有前進。要判斷有沒有補到，看的是日期不是根數。
            print(f"  {sym} {tf}: {last} → {_end}　淨增 {added} 根（共 {0 if after is None else len(after)}）")
            grand += added
    print(f"\n★ 共新增 {grand} 根。接著跑一次不帶參數的掃描確認沒有新破洞，然後把 "
          f"backend/data/klines5m/ 一起 commit（它是版控檔、會隨 git 上 Railway）。")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="實際補抓並寫回檔案（預設只掃描）")
    ap.add_argument("--strict", action="store_true", help="已知（補不回來的）破洞也算失敗")
    ap.add_argument("--tf", default="", help="只處理指定時框（如 5m）")
    ap.add_argument("--symbol", default="", help="只處理指定標的（如 BTC）")
    ap.add_argument("--extend", action="store_true",
                    help="把倉庫尾巴補到今天（--fix 只補「範圍內」的洞，補不了「還沒存到現在」）")
    args = ap.parse_args()

    if args.extend:
        return _extend(args)

    total = 0
    known_n = 0
    for sym in sorted(SYMBOLS):
        if args.symbol and not sym.upper().startswith(args.symbol.upper()):
            continue
        for tf in sorted(STORE_TFS):
            if args.tf and tf != args.tf:
                continue
            df = load_all(sym, tf)
            holes = find_holes(df, tf)
            n = 0 if df is None else len(df)
            rng = "" if df is None or df.empty else f" {df['time'].iloc[0]} ~ {df['time'].iloc[-1]}"
            print(f"  {sym} {tf}: {n} 根{rng}  破洞 {len(holes)}")
            if not holes:
                continue
            if not args.fix:
                new = [h for h in holes if not _is_known(sym, tf, h[0], h[1])]
                known_n += len(holes) - len(new)
                for a, b, c in holes[:8]:
                    tag = "" if _is_known(sym, tf, a, b) else "  ★新破洞"
                    print(f"     {a} → {b}  缺 {c} 根{tag}")
                total += len(holes) if args.strict else len(new)
                continue
            before, left = repair_holes(sym, tf)
            after = load_all(sym, tf)
            print(f"     → 修補後 {0 if after is None else len(after)} 根，剩餘破洞 {left}")
            total += left

    if args.fix:
        print(f"\n修補後剩餘破洞總數: {total}")
    elif args.strict:
        print(f"\n破洞總數: {total}（--strict：已知的也算）")
    else:
        print(f"\n★新破洞: {total}　（另有 {known_n} 個已知補不回來的，不計入 — 明細見腳本裡的 _KNOWN_HOLES）")
    return 1 if (total and not args.fix) else 0


if __name__ == "__main__":
    sys.exit(main())
