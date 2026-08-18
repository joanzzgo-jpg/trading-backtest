# trading Claude Instructions

## 語言規範
- **所有回覆請使用繁體中文**，包含說明、建議、程式碼注釋（非英文關鍵字）。

## 專案概覽
- `trading` 是回測系統：FastAPI 後端（`backend/`）+ 靜態前端（`frontend/`）+ 資料模組 + 策略引擎。
- 部署於 Railway，推送 `main` branch 自動觸發部署（GitHub repo: `joanzzgo-jpg/trading-backtest`）。
- Railway 用 `Procfile`／`railway.toml` 直接跑 `cd backend && uvicorn main:app`，**沒有跑 `start.sh`**。前端 JS 打包由 `backend/main.py` 的 `_build_js_bundle()` 在 **import 時**自動執行（偵測來源 JS 比 bundle 新就重建）→ Railway 部署開機時自動重建，不需 `start.sh`。
- ⚠ **本機**改前端 JS 後：執行中的 uvicorn **不會**重建 bundle（`--reload` 只看 .py）→ 重啟服務，或 `cd backend && python3 -c "import main"` 手動重建（執行中的服務每次請求直接讀磁碟 bundle＋即時算 `?v=` mtime 版號，重建完重新整理即可，不必重啟）。

### 快速啟動
```bash
cd /Users/noah/trading && ./start.sh
# 或直接進後端：
cd /Users/noah/trading/backend && uvicorn main:app --reload
```

### 推送前冒煙測試（守門員）
```bash
node scripts/smoke_e2e.js   # 需本機服務跑著；於裝過 puppeteer-core 的目錄執行
```
進場→K棒/標記→真拖曳平移(驗範圍有變)→縮放→切4H→零JS錯誤。**改前端/圖表相關程式後、推送前必跑**。⚠ headless 進場唯一正解=`window._landingEnter()`（點城門按鈕會被登入鎖擋、互動全打在城門頁上＝假測試）。⚠ 寫拖曳測試要先讀 `#mainChart` 的 rect 把幅度夾在圖內（主圖實際只有 ~1150px，用 ±500 當起點會落到圖外＝空操作，曾據此得出錯誤結論）。

### 動到 K 線倉庫後（守門員之二）
```bash
cd backend && python scripts/repair_klines5m.py     # 只掃描；出現「新」破洞才回傳碼 1
```
⚠ 2026-07-31 起：現存 15 個洞全是**永久性**的（2018-19 幣安中斷、XAUT 永續上市日之前）→ 舊版「有洞就回 1」等於**永遠回 1**、當守門員是狼來了。改成只有不在腳本 `_KNOWN_HOLES` 白名單裡的洞才算失敗（`--strict` 可看原始全貌）。新增白名單項目前，先跑 `--fix` 確認它真的補不回來。

**倉庫也會「落後」，那是另一回事**（2026-08-18 加 `--extend`）：`--fix` 只補**已存區間內**的洞，
補不了「倉庫停在 8/12、今天是 8/18」。落後的代價實測 **9.6 倍**：同一段 5m，倉庫涵蓋 8.0ms、
落到 API 77.0ms。定期跑：
```bash
cd backend && ../.venv312/bin/python scripts/repair_klines5m.py --extend   # 補到今天
../.venv312/bin/python scripts/repair_klines5m.py                          # 再確認沒有新破洞
git add backend/data/klines5m/   # ★ 是版控檔，要 commit 才會上 Railway
```
⚠ 5m 的「淨增」會顯示 **0**：`_KEEP_DAYS["5m"]=370`，尾巴長多少頭就被砍多少 →
**判斷有沒有補到要看尾端日期，不是看根數**。

### 動到即時更新／背景補載後（守門員之四）
```bash
node scripts/check_continuity.js     # 需本機服務跑著；約 14 分鐘（要等真實 K 棒收盤，別縮短）
```
⚠ `/api/latest` 每次只回 **2 根** → 即時輪詢一中斷（分頁凍結／電腦休眠／斷線）中間那幾根就永遠不到，
**且完全不報錯**：使用者只看到「K 棒斷掉、要重整才好」。一般冒煙測試（載入→拖曳→切時框）
再跑幾次都碰不到，因為它從不「中斷再恢復」——這支專門製造中斷，是唯一抓得到這形狀的測試。
已驗證它**抓得到**（植回舊碼 → 4 分鐘/8 分鐘兩項失敗、回傳 1）。
⚠ 缺口補回靠 `_bgLoadNewerBars`，它只支援 `window._BG_TF` 那幾個時框；**1w/1M 補不動 →
必須退回「照接」**（寧可留洞也別讓圖表凍住）。`_scheduleGapFill()` 的回傳值就是在講這件事，別改成無回傳。

### K 棒不可以「自己動」（守門員之七）
```bash
node scripts/check_bar_stability.js            # 需本機服務跑著；預設 1m / 150 秒
```
盯 `ohlcvData` 逐欄比對，**判準一定要分級**（不分級會把正常行為誤判成 bug，我第一版就踩了）：
age=0 形成中（h/l/c 本來就會變＝正常，但 **open 永遠不該變**）／age=1 剛收盤補最終值＝正常／
**age≥2 早就定案的棒動了＝bug**／外加硬不變式 **low ≤ min(open,close) 且 high ≥ max(open,close)**
（違反＝那根是兩份快照縫出來的，沒有別的可能）。
⚠ 根因與修法（2026-08-08，使用者：「最新 K 棒還是會動」）：資料來源在 binance/bybit 之間反覆跳，
兩家對同一根已收盤 K 棒差 4~15 點。四道防線缺一不可 ——
①後端 `_sticky_source`（來源黏著 60 秒，**換源那一拍回空**、不可回舊快照：回舊的會讓新舊值輪流蓋，
實測同一根 ±9.9 來回跳）②`/api/latest` 的 `src` 存進快取跟著資料走（`last_fetch_source()` 是
**thread-local**，走快取時回的是別的請求的來源→假換源）③前端補正一律**整根換或整根不動**＋
**單調閘門**（權威值的範圍要涵蓋我們這根才補：同源的最終值必然涵蓋半路值，跨快照的替換必然被擋）
④`_srcRealign` 要**連續兩次**看到新來源才觸發整段重對齊。
實測 180 秒：定案棒改寫 38 → **0**、不可能 K 棒 → **0**、形成中 open 變動 → **0**。

### 新增/移除時框、或改任何資料源後（守門員之八）
```bash
cd backend && ../.venv312/bin/python scripts/check_tf_spacing.py
```
每個時框實際請求一次，驗**回來的 K 棒間隔中位數真的等於那個時框**（crypto/us/tw 共 16 個組合）。
專治本檔一直在講的那個坑：「對照表漏列 → `.get(tf, 預設)` 靜默退回日線」——圖上有東西、不報錯。
★ 這支**不看程式碼、不看對照表**，直接問「你回給我的資料間隔對不對」→ 不論哪張表漏列、
哪個 fallback 退化都抓得到。已驗證：把 `us_stock.TF_MAP` 的 1h 拿掉 → 立刻報
`us 1h: 間隔 86400s ≠ 3600s`。
⚠ 別改成「檢查對照表有沒有這個 key」那種啟發式：實測**會誤報**（Pionex 沒有 1m 是回空表讓上層
fallback、`YF_TF_MAP` 是盤中專用函式本來就不管日/週/月）。會叫狼來了的守門員比沒有更糟。

### 動到 crypto fallback 鏈後（守門員之五）
```bash
cd backend && ../.venv312/bin/python scripts/check_perp_not_spot.py
```
⚠ **永續（`.P`）絕不可降級成現貨**。2026-08-08 抓到：前端送 `exchange=binance`，`.P` 就走不進
`fetch_crypto_ohlcv` 的永續專用鏈，落到「無 .P」那段 → fapi 一失敗**第二步就是 `_fetch_binance`＝現貨**。
實測主圖 BTC/USDT.P 顯示 64980.26＝Binance **現貨** 64980.25，永續各家 64952~64953（**差 28 點／4.3bps**）。
使用者的回報是「主圖跟合約行情數值有時候對不上」——**完全不報錯**，圖上有 K 棒、時間也對，只是換了商品；
而且現貨棒混進永續序列會生出假 FVG／錯收盤／接縫，還會被倉庫固化。這支專測「主要來源掛掉時降級到哪」，
已驗證抓得到（植回舊條件 → 拿到的值距現貨 0.00）。⚠ 基差 <1 時它回 2＝**測試不成立**，不是通過。

### 切時框/標的後圖層殘留（守門員之六）
```bash
node scripts/check_tf_switch_layers.js     # 需本機服務跑著
```
⚠ `renderAll` 會用 `_lastFVG*` 把圖層重畫回來（修「切換後標記消失」用的），但切換當下那幾份裝的還是
**上一個時框**的資料。標記層看不出來（`_has()` 會過濾），但 FVG 逐筆止損/止盈**線**沒有這層過濾
（直接 `timeToCoordinate`）→ 大時框的進場時間在小時框上找得到座標，上百條紅綠虛線一次冒出來
（使用者：「切時框會出現很多線條」）。修法＝`loadData` 開頭 `_resetLayerCacheOnCtxChange()`，
**必須在 `fetchWinRate()` 之前**（勝率快取命中是同步填好那幾份的，清在後面會把正確資料一起洗掉）。
⚠ 判準要看**內容指紋**不能只數條數：切完本來就會有線（本機快照 `_snapPaint` 秒畫的是**這個**時框的資料，
那是對的），只有畫成舊時框那一批才是 bug。一般冒煙測試抓不到——它只驗最終狀態，而這個 bug 活在
「切換瞬間～新勝率回來」那段窗口裡，最後會被正確資料蓋掉。

### 動到股票資料來源後（守門員之三）
```bash
cd backend && ../.venv312/bin/python scripts/check_tw_sources.py
```
**台股為主，兼驗美股/港股**（同一個坑三個市場都中過，見下）。
⚠ 台股接連出過兩次「安靜壞掉」：①30m/2h 時框閘門漏列 → 拿到的其實是**日線**（圖上有東西、不報錯）；
②條件式抓取的 ETag 與解析結果分家 → 清單從 1972 檔掉到 **50 檔**，且來源檔案內容沒變會一直 304、
**自己不會好**。兩個都「跑一輪看起來完全正常」，要跨輪／跨呼叫端順序才現形 → 這支專測多輪＋交錯順序，
並驗各時框分桶根數。已驗證它**抓得到**該 bug（植回舊碼會失敗、回傳 1）。
⚠ 「時框對照表漏列 → `.get(tf, 預設)` 靜默退回日線」這個坑，**台股/美股/港股三個市場都中過**：
台股漏 30m/2h（`resample_tw` 退回 1d）、美股/港股漏 30m/2h（`TF_MAP.get(tf,"1d")` 退回日線）。
新增時框或改資料源時，先確認每個市場的對照表都有該時框、且沒有靜默 fallback。

### 往 topbar 加任何元素後（守門員之九）
```bash
node scripts/check_topbar_reachable.js   # 需本機服務跑著；360/375/390/820/1200 五種寬度
```
`.topbar-right` 是一排**只會越加越多**的圖示按鈕。它自己不是捲動區時，排在最後的那幾顆會直接
落在視窗外 —— `.topbar` 不捲、`body` 又 `overflow-x:hidden` → **永遠點不到，畫面上零異常、零錯誤**。
2026-08-13 我加 `#netSig`+`#drawLayers`（+114px）就把「我的交易」「VWAP」推出去了；
⚠ 而且修正前只剩 **6px** 餘裕 → 360px 的 Android 早就中了 → 修法要對任何寬度成立，
**不是把新元素藏起來**（下一顆按鈕又會把它推出去）。判準＝每顆可見按鈕 `elementFromPoint` 命中。
⚠ ★★ 這支的判準**不可以用 `scrollIntoView()`**（我第一版就是，植回舊碼照樣通過＝叫不出狼）：
`overflow-x:hidden` 只擋使用者、不擋程式改 `scrollLeft`。只捲「overflow-x 是 auto/scroll 且真有溢出」
的祖先，量之前把 `documentElement.scrollLeft` 歸零。詳見 memory `project_topbar-right-overflow`。

### 新增任何 `/api/_diag*` 或內部端點後（守門員之十五）
```bash
cd backend && ../.venv312/bin/python scripts/check_diag_auth.py   # 不需服務跑著
```
診斷端點是「開瀏覽器就能看」的除錯窗口，很好用所以會一直長出新的 —— 每支新的都可能忘記加
`_require_admin`，**忘了也完全沒有跡象**（自己開起來一樣好好的）。2026-08-16 稽核抓到：
`_diag_trade` 早就因為「會列出帳號名」擋起來，隔壁做同一件事的 `_diag_fvg` 卻全開 —— 它回
**帳號名稱＋各帳號掛單記錄**，而且每次呼叫都真的打 fapi 抓價＋逐帳號跑閘門（＝外人可以消耗
我們的 Binance 權重）。同批還有 `_diag_fugle`（拿我們每把金鑰各打一次富果，429 一撞台股即時
報價整批壞）、`_diag_mem`（快取鍵列出此刻有人在看哪些標的）、以及 `POST
/reset_pionex_cooldown` —— 全站**唯一**不需身分就能改伺服器狀態的端點，改的正好是限流保護。
⚠ `_require_admin` 是「設了 `ACCOUNT_ADMIN_KEY` 才擋」→ 本機開發完全不受影響，線上才生效。
⚠ 端點清單**從 OpenAPI schema 自動列舉**（路徑含底線開頭的段落＝內部），新增的自動涵蓋；
**不可以走 `app.routes`**：這版 FastAPI 的 include_router 會包成 `_IncludedRouter`（無 `.routes`、
`.path` 空字串）→ 只列得到 1 個、這支就「因為沒東西可測而通過」（我第一版就是，故另加
「列舉到 <5 個算測試不成立」的保險）。真的要公開就加進腳本的 `_EXEMPT` 並寫明理由。
已植回舊碼證明會失敗（拿掉 `_diag_fvg` 的守衛 → 立刻報「無金鑰 200」、回傳 1）。

### 動到任何資料源／重採樣後（守門員之十七）
```bash
cd backend && ../.venv312/bin/python scripts/check_bar_invariants.py   # 需本機服務跑著；約 1 分鐘
```
K 棒本身錯了，上面所有 FVG／勝率／訊號**全部無效** —— 而畫面上完全看不出來。既有守門員各顧一塊：
`check_tf_spacing` 只驗「間隔對不對」、`check_bar_stability` 只盯 1m 即時那幾根、冒煙只驗一個組合；
**沒人驗過「每個市場每個時框拿回來的整段資料本身合不合法」**。判準都是硬不變式：
`low ≤ min(open,close) 且 high ≥ max(open,close)`（違反＝兩份快照縫出來的，沒有別的可能）／
`high ≥ low` ／時間嚴格遞增（重複的棒會讓回測算兩次）／沒有未來棒／無 NaN/inf/負值。
⚠ **不驗「有沒有洞」**：假日、停牌、永續上市日之前本來就有洞，驗了一定叫狼來了（那是
`repair_klines5m` 的守備範圍）。已驗證五種植入的壞資料全抓到、且「資料有洞」不誤報。
⚠ 時框清單**從 `config.js` 的 `TF_LABELS` 抽**，不寫死（我第一版寫死 8h/2h/30m → 9 個組合回 400，
印成一排「抓不到」）。
★ 間隔判準用**最小正間隔**不用中位數：美股一天只有 6.5 小時 → 4h 每天只有 2 根，盤中間隔 4h、
跨日 20h **各佔一半** → 中位數是擲骰子（實測 us/hk 4h 被誤判）。`check_tf_spacing` 註解寫著
「中位數判準通用」，但它從來沒測過股市的 4h —— 同 session 內相鄰棒必然剛好差一個時框，
最小間隔對 24 小時與有收盤的市場都成立。

### 自選是**混市場**清單 —— 別假設「另一個市場有人在更新」（2026-08-19）
報價輪詢一次只抓「目前分頁那個市場」，但自選同時放著加密/台股/美股/港股。
使用者：「我在台股所以他不動，這樣很怪，要都可以動」—— 停在台股分頁時 `_tickerData`（加密）
沒有任何人更新 → 自選裡的加密價格全部定格，**而且完全不報錯**。
⚠ `_refreshWlPrices` 沒接住是因為它**刻意跳過 crypto**，註解寫著「加密那些本來就跟著每秒的
報價輪詢在跳」—— 那個前提只在「人在加密分頁」時成立。**註解裡的前提要當成會過期的東西看。**
修法＝`_fetchCrossMarket()`：另一個市場只要自選裡真的有它的標的就順便抓一份差量
（節流 3 秒＋走差量，一次約 1~2KB；沒有的話完全不打）。
同批修：自選的**台股**改成優先讀台股清單（它本來就有價/漲跌幅），原本一律走 `_wlPriceCache`
逐檔打 `/api/latest` —— 但收盤後它只回 **1 根**，而那條路要求 `>= 2`（要前一根算漲跌幅）→
什麼都不存 → 自選的台股永遠 `---`，即使清單裡明明有 2380.0。`>= 1` 就收（漲跌幅拿不到留空）。

### 動到報價列差量（`/api/tickers`）後（守門員之十六）
```bash
node scripts/check_ticker_delta_fields.js   # 需本機服務跑著；約 2 分鐘
```
報價輪詢是**全站最高頻的請求**（crypto 每秒一輪／人）。2026-08-17 差量從「這個標的變了就整列
重送」細到**只送真的變了的欄位**（`_track` 的 `sym_rev` 由 `{sym: rev}` 改成 `{sym: {欄位: rev}}`）
→ 實測 **−55%**。動機：crypto 每秒有 672/689 檔在動，列級差量幾乎等於整包（17.4KB vs 17.9KB），
但一列 6 個欄位裡 `symbol`/`display` **永遠不變**（佔 40%）、`open` 一整天不變（13%）。
⚠⚠ **必須由前端帶 `fd=1` 明講「我看得懂」，後端預設回舊格式（整列）**。2026-08-19 使用者回報
「合約行情不動了」就是漏了這層：他的分頁還跑著改版前的 JS（`_tkMerge` 是**整列覆蓋**），後端卻
已經在送部分欄位 → `symbol`/`open`/`volume` 被洗掉、排序崩掉、畫面凍住，**而且零 JS 錯誤**。
★ 全新 profile 永遠測不到（它拿的是新 JS）—— 但線上每次部署都會有一批「開著沒重整」的分頁中招。
**通則：改動「後端送什麼、前端才看得懂」的格式時，一律由前端宣告能力、後端預設走舊格式。**
⚠ 差量是相對**客戶端的 token**（不是伺服器的上一版）→ 每個欄位都要各自記最後變動版本。
⚠ 前端 `_tkMerge` 的 delta 分支必須是**合併** `{...old, ...t}`，不可覆蓋（覆蓋＝沒送來的欄位消失，
而 symbol/open 不再送＝清單變空殼）；`_tkFill` 要在**合併之後**（它算 change_amt 需要 price＋open
兩個）；推導欄位（change_amt/spot）只在**後端沒送**時才作廢重算 —— 台股的 change_amt 是對前一日
收盤算的、由後端送來，清掉會被錯誤公式蓋掉。
判準＝跑滿 **>60 輪**（跨過整包自癒）後，把前端手上的清單跟**同一刻的整包**逐欄位比：慢變欄位
（symbol/display/open/volume）必須完全相同，每秒在跳的（price/change_pct）只驗是數字。

### 「上次看的畫面」跨裝置同步（2026-08-17）
`lastSymbol`（標的/時框/縮放/看到哪個時間段）已從 `_PULL_SKIP` 拿掉 → 跟著帳號快照跨裝置。
⚠ 它同時被加進 **`_ACCT_NO_TOUCH`**：它每次平移停手 1.2 秒就寫一次，若跟著觸發 `_acctTouch`，
2.5 秒的 debounce 會被一直重新計時、`_acctFlush` 幾乎不會執行 ＝**整包雲端同步等於失效**
（`_tc` 當初就是踩這個才被加進 `_ACCT_SKIP`）。放 NO_TOUCH＝照樣進快照，但等別的變更或切背景
flush 時才上去。⚠ 下行**只在開機那一次**套用（切回前景也套的話，另一台一動你這台的圖就被扯走）；
且必須 `loadLastSymbol(true)` 跳過網址（網址的 ?s=&tf= 是這台自己 replaceState 寫的，會蓋回雲端值）。
⚠ 測這個功能**一定要用假帳號名**（見 memory `feedback_never-use-real-account-in-tests`）；
本機沒設 `ACCOUNT_ADMIN_KEY` 開不了 `admin/create` → 直接往 `backend/.accounts.db` 插一列、測完刪掉。

### 動到「重整後回到上次的畫面」後（守門員之十四）
```bash
node scripts/check_view_restore.js   # 需本機服務跑著；約 2 分鐘
```
使用者 2026-08-16：「記憶上次看的畫面，包含大小跟時區，重整後要一樣」。這條路有**三個各自
獨立、都靜默失效**的環節，缺一個畫面就回不去 ——
①**存**：`lastSymbol` 只存 barSpacing ＋「距最新棒幾根」→ 只描述得了「貼在最新」的畫面；
捲回 7/20 重整就跳回今天。改成捲在歷史時另存右緣的**時間** `anchorT`。
★ 錨點一律問 `getVisibleRange()`（直接回時間），**不可以拿 logical index 去索引 `ohlcvData`**
（index 指的是畫在圖上的序列、`ohlcvData` 是來源，兩者長度不同 → 實測把「看 7/20」存成 4/30）。
②**讀**：`loadLastSymbol()` 原本「網址有 s/tf/m 就丟掉本機視角」，但 `_syncUrlState()` 每次切
標的/時框都 replaceState 把 s/tf/m 寫進**自己的**網址 → 重整時這條件**永遠成立**＝連縮放還原
都從來沒生效過。改成比對「網址指的是不是同一個畫面」。
③**還原後守住**：`_placeAtAnchor` 用邏輯索引只設一次，之後背景補載往 `ohlcvData` 塞進幾千根
舊棒（實測 420→14,040）→ 同一個索引指到的時間整個位移，還原到 7/22 的畫面幾秒後自己跑到
**2025-09-01**（差 11 個月）。修法＝`_holdAnchorByTime()` 按時間重申 8 秒、使用者一動就放手。
旁邊的 `_guardRestore` 救不了：它只看 span 有沒有被壓爛、而且只守 380ms。
⑥**自訂的留白被砍掉**（第四輪：「有留白，但跟原本不同」）。兩個獨立原因：
(a) rightOffset 上限原本是「可見根數的一半、絕對 60」→ 拉到 35 根被砍成 27。放寬到 **80%**
（畫面上一定還留得下兩成 K 棒）、絕對 200。
(b) ★ 一次 `loadData` 會跑**不只一次** `renderAll`（本機快照秒畫一次、真資料到貨再一次），
而 `_pendingRestoreRange` 是**一次性**的 → 第二次進來時它已是 null、`_savedBarSpacing` 開機時也是
null → 掉到「貼最新 N 根」把剛還原好的位置整個蓋掉。症狀極具誤導性：`options().rightOffset`
**確實是 35**（還原成功了），畫面上卻只剩 3 根。修法＝`_bootViewHold()` 讓這個載入週期內的後續
`renderAll` 一律重套同一組（同樣要保險絲＋使用者一動就放手，否則之後的縮放會被彈回去）。
⚠ 守門員的自訂留白值要**大到踩得到夾限**：原本用 20 根，在 49 根可見時剛好落在舊上限（一半＝25）
以內 → 這個 bug 測不出來；35 才會踩到。

⑤**根本沒有預設留白**（第三輪：「還是一樣右邊無留白」）：LWC 預設 `rightOffset=0` ＝最後一根貼著
價格軸，本專案從來沒設過預設值 —— 既有的 rightOffset 邏輯全都只是「保住使用者自己拉出來的位置」。
修法＝`_defaultRightPad()`：依可見根數 6%（夾在 3~20 根）當**下限**，跟已存值取大。
⚠ 用比例不用固定根數（固定根數放大時變半個畫面、縮小時等於沒有）。
⚠ 守門員判準用**像素**且門檻要以 barSpacing 為基準：`rightOffset=0` 量到的仍有 ~12px（半根 K 棒＋
內距），拿 8px 當門檻舊碼照樣通過＝叫不出狼；要求「比兩根 K 棒還寬」才算數。
⚠ 這項必須在動任何東西**之前**測（後面情境會自己設 rightOffset=20，那之後再問「有沒有留白」是必然成立）。

④**右緣留白被夾掉**（使用者第二輪回報：「歷史沒錯，最新框會右貼」）：存進去的 `scrollPos` 是對的
（實測 20 根），是**還原端的夾限**砍的 —— 還原發生在圖表還沒完成佈局那一刻，`ts.width()` 回 0
→ `_visN` 掉到下限 10 → 上限崩成 5 → 20 根留白被夾成 5＝K 棒幾乎貼著右邊。修法＝`_roCapFor()`：
量不到寬度就**不要夾**（只留絕對上限 60）。⚠ 只驗「縮放」和「有沒有貼最新」看不出來，那時它們都是綠的。
另：`saveLastSymbol` 在還原完成前禁止寫入（`_viewRestoreBusy`）—— `loadData` 在 `renderAll()` 後
**立刻**呼叫它，但 LWC 的 `setVisibleLogicalRange` 要下一幀才生效 → 讀到還原**前**的範圍 →
把錨點當場洗成 null（1.2 秒後 debounce 會補救，所以「偶爾才失靈」）。⚠ 旗標**必須有保險絲**：
錨點落在已載資料外會走 `_pendingAlignRange`/`_restoreByBarCount`，那兩條不呼叫 `_holdAnchorByTime`
→ 沒人解除＝從此再也不存檔（比原 bug 更糟）。
⚠ 判準要比**時間**不可比 logical index；⚠ 還原後要**連續盯 20 秒**（漂移是重整後好幾秒才發生，
只驗剛還原那一刻會是綠的）；⚠ 「資料有沒有長大」要跟**重整後**的起點比（重整後是先拿有界視窗
再補回去，永遠補不「超過」重整前那個數字 → 拿重整前當基準這支永遠不成立）。已植回舊碼證明會失敗。

### 在勝率回應新增圖層後（守門員之十三）
```bash
node scripts/check_wr_cache_layers.js   # 需本機服務跑著；約 1 分鐘
```
`fetchWinRate()` 有兩條路（網路成功／`_wrCache` 命中），兩條都要重繪 FVG/SMC/VWAP/通道…各層。
**少寫一層，那層就留著「上一個標的」的資料** —— 圖上照樣有標記、不報錯，只是位置全錯
（已修過兩次：02b429a 補載完成後漏重繪、ca8ec0f 快取命中分支漏重繪）。本檔上面那條
「兩條路徑都要加」的守則原本**只靠人記**，這支把它變成測得到的。
判準＝A（網路）→B→A（快取）後，每一層的**內容指紋**必須完全相同（只驗「有沒有值」不夠：
漏重繪時那層裝的是 B 的資料，有值但是錯的）。圖層清單**從 winrate.js 原始碼 regex 抽**，
不寫死 → 以後新增圖層自動涵蓋。
⚠ 兩個坑（我都踩了）：①`_last*` 是 **bundle 頂層的 `let`、不在 `window` 上** →
`Object.keys(window)` 一個都找不到，要用 `page.evaluate(字串)`＋`eval(名字)`。
②驗之前**必須先關掉 `_snapPaint`**：本機快照秒畫會把該標的的圖層先畫回來（正確的資料），
把漏重繪蓋掉 → 不關就永遠是綠的。關掉之後才是「第一次造訪／清過瀏覽器資料」的人走的路，
而那正是快取分支唯一負責的情境。

### 動到重播模式／即時更新／背景補載後（守門員之十二）
```bash
node scripts/check_replay_no_future.js   # 需本機服務跑著；約 1 分鐘
```
**回測工具最嚴重的一種錯誤**：重播時若看得到游標之後的 K 棒，你做的每個判斷都是作弊、
結論全部無效 —— 而畫面上完全看不出來（K 棒就是 K 棒，不會標示「這根還沒發生」）。
本檔的鐵則「replay 中任何改圖表的操作必須先檢查 `replayActive`」原本**只靠人記**。
判準在做完「前進 40 根／真拖曳／縮放＋等一輪輪詢」之後才驗（那些非同步路徑才是會踩破的地方）。
★★ 判準一定要問 **`candleSeries.data()`（實際畫在圖上的序列）**，
**不可以拿 `ohlcvData`**（我第一版就是，報出 5488 根假的「未來棒」）：`enterReplay()` 是把
ohlcvData **複製**成 replayData 再畫前 N 根，`ohlcvData` 本來就留著完整資料、它是來源不是畫面；
而且重播中背景補載還會繼續往它加舊棒（實測 1150→2533 根）。
⚠ 這條路有**三層**防護（`enterReplay` 的 `stopRealtime()`／`fetchLatest` 入口／`await` 之後再檢一次），
拿掉任一層都還擋得住 —— 植回舊碼時要三層一起拿掉才叫得出狼（實測就會漏出真實世界當下那根）。

### 動到繪圖圖層 A/B/C 後（守門員之十一）
```bash
node scripts/check_draw_layers.js   # 需本機服務跑著
```
繪圖是**使用者自己畫的資料，弄丟救不回來**（2026-08-12 我用測試腳本清掉過使用者 118 個繪圖）。
圖層動到的正好是兩條靜默失敗的路徑：①存檔時若把隱藏層濾掉 → 重新整理後那層**永遠消失**、
零提示；②命中判定若沒濾掉隱藏層 → 使用者會拖到／刪到**看不見的線**。
判準＝隱藏一層後記憶體與 localStorage 的繪圖數都不變／重新整理後三層都在且隱藏狀態記得住／
`findNearest` 對顯示層命中自己、對隱藏層必須沒命中。已植回舊碼證明會失敗。
★★ **測試一律用假帳號名 `__gk_draw_test__`**：設成真實帳號名的話 account.js 會把整包
localStorage 快照同步進後端 → 測試就會寫壞真實資料。假名字查無帳號 → `/api/account/sync`
回 404 什麼都不寫（**測試過程會看到那個 404，那是正確行為**）。
⚠ 造測試繪圖時端點時間要用**真的存在的 K 棒時間**：LWC 的 `timeToCoordinate` 對不存在的時間
回 null（我第一版用 `t±7200` 秒，日線上不落在任何一根 → 命中判定那段整個沒測到卻「通過」）。

### 動到十字線／crosshair 相關後（守門員之十）
```bash
node scripts/check_crosshair_blank.js    # 需本機服務跑著
```
鉛直線**不是 LWC 原生的**（原生已關掉），是 `charts.js` 自繪的四個 `.pane-vline`，靠
`subscribeCrosshairMove` 的 `param.time` 定位 → **空白區沒有對應時間**就會整批隱藏，
但橫線／價格標籤走另一條路徑還在 ＝ 使用者看到「十字線只剩一半」（2026-08-13 回報）。
⚠ **空白區有兩邊、程式路徑不同**：右側（最後一根之後）一直有 `positionLinesByX`，左側漏了；
左側空白很常見（1M/1d/8h 資料少、或縮到最小看見全部時）。修邊界外的行為**先問「另一邊呢」**。
判準＝左空白/K棒區/右空白三處線都在、在空白區內**會跟著游標動**、離開圖表要收掉。

倉庫檔（`backend/data/klines5m/*.pkl.gz`）是**版控、會隨 git 上 Railway** 的。暖機/回填只要缺一塊，洞就被固化進檔案，之後所有讀倉庫的請求都拿到有洞的資料——**不報錯、K 線只是少一段**。2026-07-30 實測抓到 BTC 5m 缺 434 根、BTC/ETH 4h 各缺 10 個月，全都已上線才被深滑 E2E 發現。`--fix` 會分段補抓（**必須分段**：跨永續上線日的長區間，fapi 回「非空但只有上線後那截」→ fallback 不觸發 → 前段被靜默丟掉）。詳見 memory `project_klines-store-holes`。

## 📚 詳細文件（做相關工作時再讀，避免每輪載入吃 context）
> 架構細節已從本檔拆到 `docs/`，需要時用下方路徑讀取對應檔案即可。
- **後端**：環境變數、資料夾結構、資料源、即時行情疊加（台股分鐘K）、天氣資料源、背景載入策略、Pionex 限流、已知問題 → [docs/backend.md](docs/backend.md)
- **前端**：JS 模組表、視覺特效、音效、極簡模式（perf-mode）完整說明、版面配置、圖片資源、星號按鈕、標記視窗化 → [docs/frontend.md](docs/frontend.md)
- **CRT 勝率/回測**：S1~S12 訊號邏輯、新增訊號 checklist、勝率 HUD、各時框回測天數、後端 `crt.py` 結構與效能 → [docs/crt-winrate.md](docs/crt-winrate.md)
- **FVG 策略定版規格（v2.3，參數已鎖定）**：止損/止盈檔位、雙槽多空、多幣組合、止盈先到撤殘單 → [docs/fvg-strategy.md](docs/fvg-strategy.md)
  - ⚠ 主圖方向多空/破多空標記（`crt.py` `_calc_crt_winrate` 的 `_pseq` proto 缺口）**2026-07-10 拿掉 g+1「沒填回」檢查** → proto 純「g 收盤站上前根高/破前根低」即定案、**不再被下一根收盤回頭撤掉（非 repaint）**；代價破多空標記約 2x。**未收盤最後一根**另出「暫定」標記（半透明+空心+?，`_prov_proto`，收盤才轉正式、會 repaint、使用者已同意）。auto-trade 進場 `_fvg_sigs` 是另一套、不受這些影響。
- **3D 天氣背景實作規格**：Canvas 2D 粒子＋CSS 3D 分層、Phase 進度與實作差異 → [docs/weather-3d-spec.md](docs/weather-3d-spec.md)
- **自動交易引擎**（Binance USDⓈ-M 永續，testnet 預設、逐帳號自有金鑰）：`routes/trade.py`＝下單/對帳/生命週期，`notify_monitor.py`＝背景偵測訊號→下單。三個訊號源子設定 `{ss, fvg, coach}`：ss=SR/SMC 反轉、fvg=失衡缺口、**coach=SR+SMC 多空教練（2026-07-10 接入，限價/市價進場+訊號止損+單一固定TP，方向 edge 未回測、testnet 先跑）**。核心 `execute_signal_trade`／`_exec_signal_for_account`（市價）、`place_coach_limit`／`place_fvg_limit_ladder`（限價）＋各自 `reconcile_*`。詳見 memory `project_coach-system`。

## ⚠️ 關鍵鐵則（違反會造成 bug，務必遵守）

### 時間戳
- 所有圖表時間戳 **+8 小時**（Taiwan Time），由 `toTime()` 處理。
- **後端傳前端的時間戳一律用 `.isoformat()`，禁止 `str(pd.Timestamp)`**：空格格式會讓 `toTime()` 產出 NaN → 餵 `setMarkers()` 後 Lightweight Charts 內部損壞 → **十字線鉛垂線全面斷裂**。已封裝於 `_ts(row)`。
- 台股 yfinance（`fetch_tw_intraday_yf`）：naive timestamp 先 `tz_localize("Asia/Taipei")` 再 `tz_convert("UTC")`，且 localize 前必須 `if df.index.tz is None`（否則 double-localize／小時線位移 +8h）。

### 前端 bundle 打包
- bundle 串接順序＝ `main.py` `_build_js_bundle()` 的 `names` 串列。**新增 bundle 檔務必同步加入 `names`**，否則不會被打包。
- 拆 bundle 檔：依行邊界切、在 `names` 同位置插入 → minify 後位元組相同（零行為風險），拆檔走這條路。
- 動態載入檔（`effects.js`/`weather.js`，不在 bundle）：拆/改後要更新 `main.js` 的 `_loadFx` 與 `main.py` 的 `_asset_ver`（mtime 版號，否則 `/static` 長快取吃到舊檔）。

### 前端關鍵庫一律自架、勿用外部 CDN（2026-07-10 重大教訓）
- **圖表庫 LightweightCharts、字型（M PLUS Rounded 1c／Caveat）已自架於 `frontend/static/vendor/`**，`index.html` 從同源載入（`/static/vendor/...?v={{ ver }}`）。**不要改回 unpkg / Google Fonts CDN**。
- 為什麼：CDN 對某些使用者網路不可達（iPad、部分 Windows／公司網／ISP）→ `LightweightCharts` undefined → bundle 早期 `makeBaseOpts` 拋錯 → 整包後續（建圖表/城門/登入）全不執行 → 整個 app「進不去」。開發者本機因 CDN 已快取而永遠正常、極難自測發現。
- 診斷「某裝置進不去但我這正常」→ 首疑「未快取的外部資源載入失敗」：CDP 開**清空 localStorage/快取的全新 profile** 抓 `Runtime.exceptionThrown`，一抓就中。
- 2026-07-13 起 CSP 已**完全移除** `unpkg`／`googleapis`／`gstatic` 白名單、`sw.js` 快取只留同源 `/static/`；如再引入其他庫，放 `/static/vendor/` 並確認 CSP 不需回加外部域。

### 非同步競態
- `_bgLoadGen`：每次新背景載入前 `++`，所有 async loop 每輪比對 `myGen === _bgLoadGen`，不符即退出。
- `replayActive`：replay 中任何改圖表的操作（含 `_bgScheduleIndicators`／`_bgLoadOlderBars`）必須先檢查此旗標。

### 主圖標記（FVG/SMC 等）重繪要完整
- 標記經 `_has()` 過濾＝**只顯示時間存在於當下 `ohlcvData` 的棒** → 任何「資料變多／換內容」的時點都必須用暫存重繪，否則整段沒標記。已因漏重繪出過兩次 bug：
  1. `_bgLoadOlderBars` 補載歷史完成後（02b429a）；
  2. `_fetchWinRateNow` **快取命中分支**——必須與網路成功路徑重繪**同一組層**（fvg_ms/fvg_break/fvg_trades/fvg_bb/SMC 掃蕩·結構·OB·SR/VWAP/通道/pd_ranges），少一個就是切標的回來沿用舊標的標記（ca8ec0f）。
- 之後在勝率回應新增圖層時，**兩條路徑都要加**。
- 各時框可看深度：背景補載僅 1m/5m/15m/1h/4h；**1d/1w/1M 一次載入** → 舊區段「沒 K 棒也沒標記」是設計、不是 bug。
  ⚠ 2026-08-18 更正：**8h/2h/30m 早已移除**（`config.js` 的 `TF_LABELS` 就是可用時框白名單，那裡寫著「已移除」），
  後端對它們一律回 400。本檔上面幾處提到 30m/2h 的都是**當年的事故紀錄**、不是現況。寫測試前先從 `TF_LABELS` 抽清單，別寫死。

### 極簡模式（perf-mode）不可污染正常模式
- `savePrefs()`（utils.js）在 perf-mode 直接 `return` — 否則 in-memory perf palette 會被寫回 `localStorage.chartColors`。
- `showLegColorPopup()`（draw.js）在 perf-mode 直接 `return`。
- topbar 相關覆寫必須用 `!important`（壓過 style.css 末段「橘子熊可愛風格」的 `!important`）。完整機制見 [docs/frontend.md](docs/frontend.md)。

### Pionex 限流 / 行情資料源
- Pionex API：10 次/秒/IP，超過封鎖 60s 且重試會 +10s 永遠清不掉。**Binance fapi 同理**（418/429 全域熔斷，`_BINANCE_COOLDOWN_UNTIL`）。行情/價格走 Binance，Pionex 僅用於標的清單（硬碟快取 24hr）與獨有標的 klines。
- **crypto perp K 線 fallback 鏈（2026-07-10 定版）**：**Binance fapi → Bybit（`category=linear`）→ Pionex**。⚠ 順序重要：**Pionex 日線偶有損毀殘棒**（如 BTC 2025-08-14 收盤 121583 vs Binance 118242 → 生假 2.86% FVG、錯收盤），Bybit 則貼合 Binance → 故 Bybit 優先、Pionex 墊底（只給 Bybit 沒有的獨有幣）。Bybit v5 無原生 8h/30m → `_fetch_bybit` 由 4h/15m 重採樣（origin=epoch 對齊 UTC）。
- **降級來源防污染**：`fetch_crypto_ohlcv` 每次回傳標記實際來源（`last_fetch_source()`）；`get_crt_winrate` 只有『來源＝Binance』才寫 7 天磁碟長效快取，降級來源（Bybit/Pionex）只放記憶體＋標 `:deg`、Binance 冷卻一結束就丟棄重抓、冷卻中不做尾巴 concat → 避免髒資料被烤進長效快取而持久化（**Railway 亦會撞冷卻，非只本機**）。診斷「策略標記怪」先看 Binance 是否冷卻（`_BINANCE_COOLDOWN_UNTIL`）掉了 fallback。詳見 memory `project_fallback-source-tagging-antipoison`。
- **台股即時個股分鐘 K = cnyes**（`data/cnyes_futures.py` `fetch_cnyes_stock_intraday`，同台指期源、連續無跳號、無延遲、免金鑰）；get_latest / ohlcv 初次載入 / fetch_crt_df 三處當日主源，歷史仍 yfinance，Fugle 退為備援。詳見 [docs/backend.md](docs/backend.md)。

### 不可更改的設定
- `startTickerRefresh()`（`ticker.js`）的 `setInterval(fetchTickers, …)` 間隔依市場固定：**crypto 1 秒、台股 3 秒**（行情即時性需求；2026-07-09 台股 10 秒→3 秒，配合後端 `_tw_rt_overlay_worker` 每 5 秒 MIS bulk 疊價：前 50 高量每輪必打＋其餘 250 檔輪掃，約 40 秒覆蓋全台股 → 報價列即時跳動），**禁止以「減輕伺服器負擔」為由改慢**。台股全量清單仍由 `_tw_ticker_worker` 每 30 秒抓 TWSE/TPEX opendata 維護。

## 圖片資源
所有原始圖片存放於 **桌面 `Claude-分類/虛擬貨幣/`**，已複製至 `frontend/static/img/`。對應表與前端使用位置見 [docs/frontend.md](docs/frontend.md)。
