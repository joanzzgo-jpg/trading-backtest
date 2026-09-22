"""守門員：本機 → 線上（Railway）的轉送語意。不需服務跑著，不碰網路（_relay_post 被換掉）。

為什麼要這支：`_relay_snapshot` 是「本機這台的資料覆蓋線上」的唯一入口，壞法全都是**靜默**的 ——
  ① 設定沒有鏡像 → 使用者在本機刪掉的設定，線上永遠留著（他以為刪了）。
  ② 鏡像做過頭 → 把「這台裝置專屬」的版面/字級推上去，弄亂另一台。
  ③ 繪圖被當成設定一起鏡像 → **手機上畫的線會被這台清掉**（繪圖弄丟救不回來）。
  ④ 繪圖與設定分成兩次讀-改-寫 → 第二次用的是第一次寫入「之前」的快照，把第一次整個蓋掉。
  ⑤ 本機是空的時候照樣鏡像 → 直接把線上清空。

判準都是「餵一組本機/線上快照進去，看送出去的 payload 長怎樣」，不看程式碼。
⚠ 回傳碼 2＝匯入不了模組（測試不成立），不是通過。
"""
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def main():
    try:
        from routes import account as A
    except Exception as e:
        print(f"⊘ 匯入不了 routes.account：{e} → 測試不成立")
        return 2

    bad = []

    def run(local, upstream):
        """跑一次轉送，回 (送出去的快照, pull 次數, sync 次數)。"""
        calls = {"pull": 0, "sync": 0}
        sent = {}

        def fake_post(path, payload, timeout=12.0):
            calls[path] = calls.get(path, 0) + 1
            if path == "pull":
                return {"exists": True, "data": json.loads(json.dumps(upstream))}
            sent.clear(); sent.update(payload.get("data") or {})
            return {"ok": True}

        real, A._relay_post = A._relay_post, fake_post
        A._relay_last.pop("acc", None)
        try:
            A._relay_snapshot("acc", local)
        finally:
            A._relay_post = real
        return sent, calls["pull"], calls["sync"]

    D = A._DRAW_KEY
    # ── ① 設定鏡像：本機刪掉的 key，線上也要消失 ──
    local = {"sysColors": "L", "chartStyles": "L"}
    up = {"sysColors": "U", "chartStyles": "U", "hiddenLegs": "只有線上有"}
    sent, np_, ns = run(local, up)
    print(f"① 設定鏡像　本機 {sorted(local)} / 線上 {sorted(up)}")
    print(f"   送出 {sorted(sent)}　pull {np_} 次、sync {ns} 次")
    if "hiddenLegs" in sent: bad.append("本機沒有的設定沒有從線上刪掉（沒有鏡像）")
    if sent.get("sysColors") != "L": bad.append("本機的設定沒有覆蓋上去")
    if np_ != 1 or ns != 1: bad.append(f"應該只有一次 pull + 一次 sync，實得 pull {np_} / sync {ns}")

    # ── ② 裝置專屬設定：不推、也不刪 ──
    local = {"sysColors": "L"}
    up = {"sysColors": "U", "paneFlexes": "線上的版面", "_tc": "線上的快取"}
    sent, *_ = run(local, up)
    print(f"\n② 裝置專屬　線上有 paneFlexes/_tc，本機沒有 → 送出 {sorted(sent)}")
    for k in ("paneFlexes", "_tc"):
        if k not in sent: bad.append(f"{k} 被鏡像刪掉了（它是這台專屬的，不該碰線上那份）")
    local2 = {"sysColors": "L", "_tc": "本機一大包快取", "paneFlexes": "本機版面"}
    sent2, *_ = run(local2, {"sysColors": "U"})
    print(f"   本機有 _tc/paneFlexes → 送出 {sorted(sent2)}")
    for k in ("paneFlexes", "_tc"):
        if k in sent2: bad.append(f"{k} 被推上去了（它是這台專屬的）")

    # ── ③ 繪圖：本機沒碰過的標的要保留（不可以被鏡像清掉）──
    local = {"sysColors": "L", D: json.dumps({"BTC": ["本機的線"]})}
    up = {"sysColors": "U", D: json.dumps({"BTC": ["線上的舊線"], "ETH": ["手機畫的線"]})}
    sent, *_ = run(local, up)
    got = json.loads(sent.get(D) or "{}")
    print(f"\n③ 繪圖合併　本機只有 BTC、線上有 BTC+ETH → 送出 {sorted(got)}")
    if "ETH" not in got: bad.append("本機沒碰過的標的(ETH)被清掉了 —— 那可能是手機畫的，弄丟救不回來")
    if got.get("BTC") != ["本機的線"]: bad.append("本機有畫的那檔沒有以本機為準")

    # ── ④ 安全閥：本機設定全空 → 什麼都不做，不可以清空線上 ──
    up = {"sysColors": "U", "chartStyles": "U", "hiddenLegs": "U"}
    sent, np2, ns2 = run({}, up)
    print(f"\n④ 安全閥　本機完全是空的 → pull {np2} 次、sync {ns2} 次（都應為 0）")
    if ns2: bad.append("本機是空的卻照樣送出 → 會把線上設定清空")

    # ⑤ 只有繪圖、沒有設定 → 不可以把線上設定鏡像掉
    local = {D: json.dumps({"BTC": ["線"]})}
    up = {"sysColors": "U", D: "{}"}
    sent, *_ = run(local, up)
    print(f"\n⑤ 只有繪圖沒有設定 → 送出 {sorted(sent)}")
    if "sysColors" not in sent: bad.append("本機沒有任何設定時，線上設定被清掉了")

    print("\n✗ " + "\n✗ ".join(bad) if bad else "\n★ 設定會鏡像、裝置專屬的不碰、繪圖只合併不清別台的、空的時候不動手")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
