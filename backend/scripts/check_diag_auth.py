#!/usr/bin/env python
"""守門員：內部/診斷端點一律要管理金鑰，而且新增的自動涵蓋。

用法（不需要服務跑著；它自己起一份 app）：
    cd backend && ../.venv312/bin/python scripts/check_diag_auth.py

為什麼需要這支
  這些端點是「開瀏覽器就能看」的除錯窗口，很好用，所以會一直長出新的 —— 而每一支新的
  都可能忘記加守衛，忘了也**完全不會有任何跡象**（自己開起來一樣好好的）。
  2026-08-16 稽核就抓到：`_diag_trade` 早就因為「會列出帳號名」擋起來了，隔壁做同一件事的
  `_diag_fvg` 卻是全開的 —— 它會回**帳號名稱＋各帳號的掛單記錄**，而且每次呼叫都真的去打
  fapi 抓價＋逐帳號跑閘門（＝任何人都能從外面消耗我們的 Binance 權重，
  見 memory binance-weight-self-lockout）。同一批還有 `_diag_fugle`（拿我們每一把金鑰各打
  一次富果）、`_diag_mem`（快取鍵會列出此刻有人在看哪些標的）、
  以及 `POST /reset_pionex_cooldown` —— 全站**唯一**沒有身分就能改伺服器狀態的端點，
  而它改的正好是限流保護。

判準（★不看程式碼、直接對 app 發請求）
  ・端點清單**從 OpenAPI schema 自動列舉**，不寫死：路徑裡有 `_diag` / `_perf_report` 這種
    底線開頭的內部段落 → 就該擋。以後新增的自動被涵蓋，不會像人工守則一樣被忘記。
    ⚠ 不可以走 `app.routes`：這版 FastAPI 的 include_router 會把子路由包成 _IncludedRouter
      （沒有 .routes、.path 是空字串）→ 只列得到 1 個，這支就會「因為沒東西可測而通過」
      （我第一版就是；所以下面還加了「列舉到 <5 個就算測試不成立」的保險）。
  ・沒帶金鑰 → 必須 403；帶對金鑰 → 必須**不是** 403（證明擋得掉、也放得進來）。
  ・★ 不可以用「原始碼裡有沒有 _require_admin」當判準：那是 CLAUDE.md 講的靜態啟發式，
    寫了卻放在 return 後面、或參數名打錯，照樣是綠的。

回傳碼：0 全部要金鑰 / 1 有端點沒擋 / 2 測試不成立
"""
import os
import sys
import secrets

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

KEY = "gk_" + secrets.token_hex(8)
os.environ["ACCOUNT_ADMIN_KEY"] = KEY          # ⚠ 必須在 import 之前：_ADMIN_KEY 是 import 期讀的

# 這幾支「內部端點」刻意公開，各有理由 —— 要加進來必須寫清楚為什麼
_EXEMPT = {
    ("POST", "/api/_perf_report"):
        "前端的效能探針要寫進來（純數字+開關名稱、無個資）；讀回來的 GET 那支有擋",
}
# 不是底線開頭、但會改伺服器狀態的管理操作 → 一樣要擋
_EXTRA_MUST_GUARD = [("POST", "/api/reset_pionex_cooldown")]


def _is_internal(path: str) -> bool:
    """路徑裡有任何一段是底線開頭 → 視為內部/診斷端點。"""
    return any(seg.startswith("_") for seg in path.split("/") if seg)


def main() -> int:
    try:
        from fastapi.testclient import TestClient
        import main as app_main
    except Exception as e:  # noqa: BLE001
        print(f"✗ 起不了 app（{type(e).__name__}: {e}）→ 測試不成立")
        return 2

    import routes.data as _d
    if _d._ADMIN_KEY != KEY:
        print(f"✗ _ADMIN_KEY 沒吃到測試金鑰（拿到 {_d._ADMIN_KEY!r}）→ 擋不擋都測不準，測試不成立")
        return 2

    client = TestClient(app_main.app)

    # ★ 列舉走 OpenAPI schema，不走 app.routes（理由見檔頭）
    try:
        paths = app_main.app.openapi().get("paths", {}) or {}
    except Exception as e:  # noqa: BLE001
        print(f"✗ 產不出 openapi schema（{type(e).__name__}: {e}）→ 列舉不到端點，測試不成立")
        return 2
    targets = []
    for path, ops in paths.items():
        if not _is_internal(path):
            continue
        for m in ops:
            if m.upper() in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                targets.append((m.upper(), path))
    targets += _EXTRA_MUST_GUARD
    targets = sorted(set(targets))

    if len(targets) < 5:
        print(f"✗ 只列舉到 {len(targets)} 個內部端點（預期 ≥5）→ 列舉壞了，測試不成立")
        return 2

    fails, checked, exempt = [], 0, 0
    print(f"   從 OpenAPI schema 列舉到 {len(targets)} 個內部端點：\n")
    for method, path in targets:
        if (method, path) in _EXEMPT:
            exempt += 1
            print(f"   ○ {method:5} {path:34} 刻意公開 — {_EXEMPT[(method, path)]}")
            continue
        try:
            no_key = client.request(method, path)
            with_key = client.request(method, path, params={"key": KEY})
        except Exception as e:  # noqa: BLE001
            fails.append(f"{method} {path}：請求本身就爆了（{type(e).__name__}: {e}）")
            print(f"   ✗ {method:5} {path:34} 請求爆了：{type(e).__name__}")
            continue
        checked += 1
        ok_block = no_key.status_code == 403
        ok_pass = with_key.status_code != 403
        mark = "✓" if (ok_block and ok_pass) else "✗"
        print(f"   {mark} {method:5} {path:34} 無金鑰 {no_key.status_code}（應 403）　帶金鑰 {with_key.status_code}（不可 403）")
        if not ok_block:
            fails.append(f"{method} {path}：沒帶金鑰卻回 {no_key.status_code} — 任何人都讀/呼叫得到")
        elif not ok_pass:
            fails.append(f"{method} {path}：帶了正確金鑰仍被擋（403）— 自己也進不去了")

    print(f"\n   實際比對 {checked} 個端點（另有 {exempt} 個列在刻意公開名單）")
    if fails:
        print("\n★ 有內部端點沒有守衛（開瀏覽器就讀得到，而且完全不會有跡象）：")
        for f in fails:
            print(f"   {f}")
        print("   修法：在 routes/data.py 的該函式簽章加 `key: str = \"\"`，函式體第一行呼叫 `_require_admin(key)`。")
        print("   真的該公開就加進本檔 _EXEMPT，並寫清楚理由。")
        return 1
    print("\n★ 所有內部/診斷端點都要管理金鑰，且帶對金鑰進得去")
    return 0


if __name__ == "__main__":
    sys.exit(main())
