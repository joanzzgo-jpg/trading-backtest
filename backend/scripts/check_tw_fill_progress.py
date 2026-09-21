"""守門員：台股收盤補齊的「進度」只能記真的問出答案的代號。

不需服務跑著；約 10 秒（會打 cnyes 幾次）。

為什麼要這支（2026-09-21 實際事故）：
  opendata 基底**永遠落後一個交易日** → 疊價鏈是台股唯一的真值來源。收盤補齊靠
  `_fill["seen"]` 記「哪些檔補過了」，湊滿整份清單就 `done`，當天不再補。
  原本記的是 `_asked`＝**我打算問的那批**，不是來源真的回答的那批 →

    本機睡醒後 DNS 解不到 mis.twse.com.tw、cnyes 也連不上 → 整批抓失敗 →
    照樣被記成「補過了」，一輪就湊滿 2698 檔 → done → **203 檔興櫃整晚停在前一個交易日**。

  日誌上寫的是「收盤補齊完成：2698 檔／1 輪」——看起來完全正常。畫面上零跡象，
  使用者只看得出「本機跟線上的價不一樣」。★ 這就是本專案最毒的形狀：**失敗被記成有效狀態**。

判準＝注入上游失敗，`fetch_tw_quotes_bulk` 回填的 `answered` **不可以**涵蓋那些檔：
  ① 正常       → answered 涵蓋問到的檔（>0，且不多於問的數量）
  ② 整批連線失敗 → answered 必須是 **0 檔**（舊寫法會是全部）
  ③ 一半 chunk 失敗 → answered 必須 < 問的數量（舊寫法會是全部）

⚠ 「確定的答案」有三種，都算問到了，否則長尾永遠補不完＝無限打上游：
  回應裡有它／兩種前綴都問到了都沒有／剛確認過查無還在 _TW_NOQ 內。
⚠ 回傳碼 2＝測試不成立（連不上 cnyes，無法判斷），不是通過。
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

SYMS = ["2330", "2317", "2454", "6812", "6638", "7789", "7930", "7939", "8458", "2255"]


def main():
    try:
        from data import cnyes_futures as C
    except Exception as e:
        print(f"⊘ 匯入不了 cnyes_futures：{e} → 測試不成立")
        return 2

    orig = C._quote_req
    bad = []

    # ① 正常：至少要問出東西，否則後面兩項沒有對照組
    a1 = set()
    out1 = C.fetch_tw_quotes_bulk(SYMS, answered=a1)
    print(f"① 正常          ：有價 {len(out1)} 檔、answered {len(a1)}/{len(SYMS)} 檔")
    if not a1:
        print("⊘ 正常情況下一檔都問不到（cnyes 連不上？）→ 測試不成立")
        return 2
    if len(a1) > len(SYMS):
        bad.append(f"answered({len(a1)}) 比問的還多({len(SYMS)})")

    # ② 每個 chunk 都連線失敗 → 一檔都沒問到
    try:
        C._quote_req = lambda pref, batch: (None, False)
        a2 = set()
        C.fetch_tw_quotes_bulk(SYMS, answered=a2)
    finally:
        C._quote_req = orig
    print(f"② 整批連線失敗  ：answered {len(a2)}/{len(SYMS)} 檔（必須是 0）")
    if a2:
        bad.append(f"整批連線失敗卻記了 {len(a2)} 檔「問到了」"
                   f" —— 收盤補齊會據此宣告完成，那些檔整天停在前一個交易日的價")

    # ③ 一半的 chunk 失敗 → 只能記成功的那半
    _batch_save = C.CNYES_QUOTE_BATCH
    calls = {"n": 0}

    def flaky(pref, batch):
        calls["n"] += 1
        return (None, False) if calls["n"] % 2 == 0 else orig(pref, batch)

    try:
        C.CNYES_QUOTE_BATCH = 3            # 切小 → 同一批會分成多個 chunk
        C._quote_req = flaky
        a3 = set()
        C.fetch_tw_quotes_bulk(SYMS, answered=a3)
    finally:
        C._quote_req = orig
        C.CNYES_QUOTE_BATCH = _batch_save
    print(f"③ 一半 chunk 失敗：answered {len(a3)}/{len(SYMS)} 檔（必須少於 {len(SYMS)}）")
    if len(a3) >= len(SYMS):
        bad.append(f"有 chunk 失敗卻記了全部 {len(a3)} 檔「問到了」"
                   f" —— 那幾百檔從沒送出去，卻被當成補過了")

    if bad:
        print("\n✗ " + "\n✗ ".join(bad))
        return 1
    print("\n★ 補齊進度只記「來源真的給了答案」的代號；上游失敗時進度不前進（下一輪會重問）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
