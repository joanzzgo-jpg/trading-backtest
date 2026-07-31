"""共用 HTTP 連線池（2026-08-01）。

**為什麼**：`requests.get(...)` / `requests.post(...)` 這種模組層函式，每呼叫一次就
**新建一個 Session 用完丟掉** → 每一發都重做一輪 TCP+TLS 交握。實測各來源省下的時間：

    TWSE MIS（即時疊價 worker，每 3 秒一輪）  85ms → 13ms   省 72ms
    TWSE opendata（全量清單，每 30 秒）        98ms → 51ms   省 46ms
    鉅亨 cnyes（台股當日分鐘 K，主來源）        59ms → 25ms   省 34ms

台股即時疊價 worker 每 3 秒要抓「量最大前 120 檔」，交握省下來的時間直接變成
「報價更新得完、而且更新得快」。

**這個池刻意不留 cookie**：mis.twse.com.tw 會發 JSESSIONID，共用 Session 預設會把它
存起來一路帶著走 —— 那是行為改變（可能牽動對方的 session/限流計算），不是我們要的。
封掉 cookie 之後，行為與現況 `requests.get()` 完全相同，唯一差別就是「連線重用」。

**max_retries=0**：重試策略一律留給呼叫端自己決定。各來源的限流規則差很多
（Pionex 封鎖期間每多打一次 +10s、Binance 429 會升級成 418），傳輸層自作主張重試
會把那些防線繞過去。

⚠ 交易下單（utils/binance_trade.py）與行情抓取（data/crypto.py）各自持有獨立的池，
  **不要**為了整齊把它們併進來：下單那個的 max_retries=0 是「不可重複下單」的安全性質，
  必須跟這個通用池解耦，免得哪天有人調寬這裡的設定就順手影響到下單。
"""
from http.cookiejar import DefaultCookiePolicy

import requests

SESSION = requests.Session()
SESSION.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))   # 不存任何 cookie（見上）
_adapter = requests.adapters.HTTPAdapter(pool_connections=16, pool_maxsize=64, max_retries=0)
SESSION.mount("https://", _adapter)
SESSION.mount("http://", _adapter)
