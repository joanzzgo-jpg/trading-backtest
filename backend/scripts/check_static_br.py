"""守門員：靜態檔的 brotli 預壓產物，內容必須與原始檔**逐位元相同**。

需本機服務跑著；約 5 秒。

為什麼要這支：`main.py` 開機時把 /static 的 .js/.css 預壓成 `.br`（比即時 gzip 少 20.3%），
請求帶 `Accept-Encoding: br` 就直接送那份。這條路的壞法**全都是無聲的**——

  ① `.br` 過期（改了原始檔、預壓沒重跑）→ 瀏覽器拿到的是**舊程式碼**，而 `?v=` 版號是即時算的，
     看起來像已經更新。使用者會回報「改的東西沒生效」，而且重新整理也沒用（immutable 一年）。
  ② 壓錯／截斷 → 整支 JS 解不開，app 直接白畫面。
  ③ Content-Type 跟原路不一致（.js 應為 text/javascript）→ 某些嚴格環境會拒絕執行。
  ④ 被 GZipMiddleware 重複壓一次 → 內容是 gzip(brotli(...))，瀏覽器解不開。

判準＝**同一支檔案，br 解壓後必須等於 identity 的位元組**。這一條同時涵蓋上面四種。

⚠ 回傳碼 2＝測試不成立（服務沒跑／沒有 brotli 套件），不是通過。
"""
import os
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..",
                                    "frontend", "static"))
MIN_SIZE = 2048          # 與 main.py `_BR_MIN_SIZE` 同一個門檻


def fetch(path, enc):
    req = urllib.request.Request(BASE + path, headers={"Accept-Encoding": enc,
                                                       "User-Agent": "check_static_br"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.headers.get("Content-Encoding"), r.headers.get("Content-Type"), r.read()


def main():
    try:
        import brotli
    except Exception:
        print("⊘ 沒有 brotli 套件 → 這台不會產生預壓檔，測試不成立")
        return 2
    try:
        urllib.request.urlopen(BASE + "/static/manifest.json", timeout=10).read()
    except Exception as e:
        print(f"⊘ 連不到 {BASE}（服務沒跑？）：{e} → 測試不成立")
        return 2

    targets = []
    for dirpath, _dirs, files in os.walk(ROOT):
        for f in files:
            if not (f.endswith(".js") or f.endswith(".css")):
                continue
            full = os.path.join(dirpath, f)
            if os.path.getsize(full) < MIN_SIZE:
                continue
            targets.append("/static/" + os.path.relpath(full, ROOT).replace(os.sep, "/"))
    if len(targets) < 5:
        print(f"⊘ 只找到 {len(targets)} 支靜態文字檔（預期數十支）→ 測試不成立")
        return 2

    bad, checked, br_n, saved = [], 0, 0, 0
    for path in sorted(targets):
        try:
            ce_b, ct_b, body_b = fetch(path, "br, gzip")
            ce_i, ct_i, body_i = fetch(path, "identity")
        except Exception as e:
            bad.append(f"{path}：抓不到（{type(e).__name__}）")
            continue
        checked += 1
        if ce_b != "br":
            continue                       # 這支沒有預壓檔（太小／來源比較新）→ 走原路，正常
        br_n += 1
        saved += max(0, len(body_i) - len(body_b))
        try:
            dec = brotli.decompress(body_b)
        except Exception as e:
            bad.append(f"{path}：br 解不開（{type(e).__name__}）—— 可能被重複壓縮或截斷")
            continue
        if dec != body_i:
            bad.append(f"{path}：br 解壓後與原始檔不同（{len(dec)} vs {len(body_i)} bytes）"
                       f" —— 預壓檔過期或壓錯")
        if ct_b != ct_i:
            bad.append(f"{path}：Content-Type 兩條路不一致（br={ct_b} / 原路={ct_i}）")

    print(f"檢查 {checked} 支靜態文字檔，其中 {br_n} 支走預壓 brotli"
          f"（未壓縮共省 {saved / 1024:.0f}KB）")
    if bad:
        print("\n✗ " + "\n✗ ".join(bad))
        return 1
    if br_n == 0:
        print("⊘ 沒有任何一支走到 brotli（預壓沒產生？）→ 測試不成立")
        return 2
    print("\n★ 預壓 brotli 與原始檔逐位元相同、Content-Type 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
