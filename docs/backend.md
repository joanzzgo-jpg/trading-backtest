# 後端架構

> 從 CLAUDE.md 拆出的後端詳細參考。CLAUDE.md 只留關鍵鐵則，細節在此。

## 環境變數
- `ANTHROPIC_API_KEY`：橘子熊台詞生成（routes/bear.py 用 Claude Haiku）
- `FINNHUB_TOKEN`：美股即時（免費 https://finnhub.io、免 KYC、60 req/min）。`/api/latest`
  US 分鐘(5m/15m/1h/4h)用 Finnhub `/quote` 即時價**累積出「當下這根」**(`_finnhub_accumulate`,
  同 MIS 思路) → 無 ~15 分延遲；**即時棒無成交量**(Finnhub quote 無量, yfinance 之後回補)。
  報價過期/日線 → 退回疊加最後一根(_finnhub_overlay)。不設就純 yfinance(15min 延遲)。
- `TWELVEDATA_TOKEN`：美股即時**含成交量**的可選升級（免費 email 申請 https://twelvedata.com、
  免 KYC；免費版 8 req/min → **可逗號分隔多把**輪替分散、429 冷卻）。設定後 US `/api/latest`
  優先用 Twelve Data time_series 即時(含量) > Finnhub 累積器。`data/twelvedata.py`。
- `ALPACA_KEY`/`ALPACA_SECRET`：美股 Alpaca IEX 即時(含量)（`data/alpaca.py`，已接好但**需券商
  KYC+2FA、且常引導付費** → 通常不用；設了就優先）。
- 美股即時優先序：Alpaca > Twelve Data > Finnhub 累積器 > yfinance。`/api/_diag` 可查各金鑰是否生效。
- `CWA_API_KEY`：中央氣象署授權碼（天氣 routes/weather.py 的台灣資料源；申請
  https://opendata.cwa.gov.tw/）。未設定時台灣座標也會 fallback 到 Open-Meteo。
- `FUGLE_TOKEN`：Fugle 富果 Marketdata 即時行情金鑰（免費申請 https://developer.fugle.tw）。
  設定後台股**分鐘線(5m/15m/1h)改用 Fugle 即時 candles**（突破 yfinance/Yahoo 對台股的
  ~20 分鐘強制延遲）：`/api/latest` 回今日即時 candles tail（最新棒=當下、無空隙）、
  `/api/ohlcv` 在查詢含今日時把今日改用 Fugle、歷史仍 yfinance（< 當日開盤切點合併）。
  未設定 → 自動 fallback 回 yfinance + TWSE MIS 累積（`data/fugle.py`；金鑰只從環境變數讀）。
- `DATABASE_URL`：Railway Postgres 連線字串（帳號系統 + Web Push 訂閱/通知狀態的持久層）。
  有 → 用 Postgres（跨重啟/多實例持久）；本機無 → SQLite 檔（`backend/.accounts.db`，已 gitignore）；
  在 Railway 卻沒設 → 帳號功能停用（避免寫到會被清空的臨時檔造成假性遺失）。詳見 `routes/account.py`。
- `VAPID_PRIVATE_KEY`（PEM）/`VAPID_SUBJECT`（`mailto:`）：Web Push 訊號通知的 VAPID 金鑰。
  未設定 → 通知功能停用（`notify_enabled()` 回 False），其餘功能不受影響。`routes/notify.py` 啟動時載入、
  推導 applicationServerKey 給前端 subscribe。詳見「Web Push 訊號通知」節。
- `BINANCE_TRADE_API_KEY`/`BINANCE_TRADE_API_SECRET`：Binance USDⓈ-M 永續**下單**金鑰
  （`utils/binance_trade.py`）。未設定 → 交易功能整組停用、前端入口自動隱藏。
- `BINANCE_TRADE_ENV`：`testnet`（預設，https://testnet.binancefuture.com，金鑰到
  https://testnet.binancefuture.com 登入後 API Key 頁產生）或 `live`（實盤真錢）。
- `TRADE_ACCESS_KEY`：交易口令。站是公開多人用 → 除 `/api/trade/status` 外所有交易端點都要求
  此口令（前端輸入一次存 localStorage["tradeKey"]）。**Railway 上沒設此值 → 交易端點一律 403**
  （避免任何訪客動到下單）；本機開發無此值可直用。

## Binance 永續交易（`routes/trade.py` + `utils/binance_trade.py`）
- **手動交易**：前端交易面板（`trade.js`，桌面系統外觀彈窗/手機設定分頁入口）→
  `/api/trade/order|close|cancel|overview|history`。保證金×槓桿=名目，數量/價格依 exchangeInfo
  stepSize/tickSize 量化（快取 1hr）；停損/止盈用 `closePosition=true` 條件市價單交易所託管。
- **自動交易**：設定存 DB 單列 `trade_auto`（10s 快取）。`notify_monitor._process_combo` 偵測到
  新進場訊號 → `execute_signal_trade()`（市價進場+掛 SL/TP；逐事件去重 `atrade:*` 走 notify_seen，
  先標記再下單=只試一次）；策略判定止盈/止損 → `settle_signal_trade()` 平掉對應倉位（與回測邏輯
  對齊；交易所端先出場則冪等跳過）。**前提**：標的在帳號自選 + 帳號至少一台裝置有啟用通知訂閱
  （監控器以訂閱者的 watchlist 組掃描清單）。
- 符號解析：圖表符號 `BTC/USDT(.P)` → `BTCUSDT`；找不到時試 `1000`+base（圖上 1000 倍合約已
  ÷1000 顯示 → 下單價格 ×scale 換回）。每筆下單記 `trade_log`（含 testnet/live 標記）。
- 單向持倉模式（One-way）。同合約已有持倉 → 自動交易跳過（不加倉不對沖）。

## 資料夾用途（後端）

### 後端核心
- `backend/main.py` - FastAPI 主程式、路由註冊、模板與靜態檔案設定、啟動預熱
- `backend/routes/` - API 路由模組化
  - `data.py` - OHLCV、最新行情、CRT 勝率（`/api/crt_winrate`）API
  - `search.py` - 標的搜尋、tickers、Pionex symbols
  - `backtest.py` - CRT 訊號回測（`/api/crt_backtest`，重用勝率 signals）
  - `account.py` - 帳號系統（登入/雲端同步，Postgres/SQLite）
  - `notify.py` - Web Push 訊號通知（VAPID、訂閱、feed；見專節）
  - `ai_research.py` - AI 研究面板
  - `bear.py` - 橘子熊台詞（Claude Haiku）
  - `weather.py` - 天氣/天文資料源（見專節）
- `backend/utils/` - 共用工具
  - `cache.py` - TTL + LRU 快取
  - `data.py` - 指標富集、DataFrame 序列化
  - `crt.py` - CRT 訊號掃描與勝率計算（`_ts`, `_scan_outcome`, `_calc_crt_winrate`）

### 資料與指標
- `backend/data/` - 資料獲取與整合
  - `crypto.py` - 加密貨幣數據（Binance / Bybit / OKX / Pionex），含動態 max_candles 計算
  - `taiwan.py` - 台股數據（FinMind 日線、yfinance 分鐘線、TWSE MIS 即時）
  - `us_stock.py` - 美股數據
- `backend/indicators/` - 技術指標計算
  - `engine.py` - 指標計算引擎（BB, KDJ, RSI, MACD, CRT 等）

### 回測（只剩 CRT 訊號回測）
- `routes/backtest.py` `run_crt_backtest` - **重用 `/api/crt_winrate` 已算好的 `signals`**（不另抓），把選定訊號的勝負序列 × 每筆預估盈虧比做資金模擬。詳見 [docs/crt-winrate.md](crt-winrate.md) 的「回測功能」。
- **已移除**：`backend/strategies/`（`builtin.py` 7 個通用策略）、`backend/backtest/`（`engine.py` 向量化引擎）、`routes/strategies.py`、`/api/backtest`、`/api/strategies` 皆已刪除（前端拿掉入口後一併清掉，且 engine 有未修的做空帳務/NaN bug）。日後若要復活須一併重建並修 bug，見 crt-winrate.md。

## 重要技術細節
- **時間戳**：所有圖表時間戳 +8 小時（Taiwan Time），`toTime()` 函數處理
- **台股 yfinance 時區**：`fetch_tw_intraday_yf()` 中，naive timestamp 一律先 `tz_localize("Asia/Taipei")` 再 `tz_convert("UTC")`，否則小時線會位移 +8h。在 tz_localize 前必須確認 `if df.index.tz is None` 否則有 double-localize 風險
- **max_candles**：按時間框架動態計算，避免長日期範圍資料截斷；`_TF_MAX_CANDLES`：4h=12000、1h/15m/5m=20000（已調高以支援 CRT 勝率 retry loop）
- **即時更新**：`fetchLatest()` 有間距保護（>5 根週期差距不插入），防止歷史圖表被今日資料污染
- **Ticker 刷新間隔**：`startTickerRefresh()` 中 `setInterval(fetchTickers, 2000)` 固定 **2 秒**，不可調整（行情即時性需求），禁止以「減輕伺服器負擔」為由更改
- **重播日期選擇**：`<input type="date">` 讓使用者跳至指定日期
- **價格軸精度**：`_applyPriceFormat(data)` 依最後收盤價動態設定 `priceFormat.precision`（2–8 位），套用於 candleSeries + BB 三線

## 非同步與競態條件
- **`_bgLoadGen`**：全局整數計數器，每次新背景載入前 `++_bgLoadGen`。所有非同步 loop 在每次迭代開頭比對 `myGen === _bgLoadGen`，不符即退出，防止舊請求污染新圖表
- **`replayActive` 旗標**：replay 中任何修改圖表的操作必須先檢查此旗標；`_bgScheduleIndicators()` 與 `_bgLoadOlderBars()` 的圖表更新區塊均需 `if (replayActive) return/skip`
- **double-setVisibleLogicalRange**：replay 每步進時，在 `_replayStep()` 前後各呼叫一次 `setVisibleLogicalRange`，防止 LWT 內部 timescale 重置覆蓋視窗位置

## 背景載入策略
- **初始自動載入目標**（`_bgLoadOlderBars(false)`）：5m=180天, 15m=180天, 1h=365天, 4h=1825天
- **滑動觸發目標**（`_bgLoadOlderBars(true)`）：5m=730天, 15m=730天, 1h=1825天, 4h=3650天
- **觸發門檻**：`range.from < 120`（距左邊 120 根開始預載），節流 1500ms

## Pionex 限流防護（`data/crypto.py`）
Pionex API：**10 次/秒/IP**，超過回 **429 封鎖 60s**，且**封鎖期間每多打一次 +10s**（持續重試會永遠清不掉）。對策（行情/價格本來就走 Binance，Pionex 僅用於標的清單與獨有標的 klines）：
- **標的清單硬碟快取 24hr**（`.pionex_syms_cache.json`，已 gitignore）：24h 內讀檔、**完全不打 Pionex**；重啟也讀檔不重抓 → 一天約 1 次。`_load_disk_syms` / `_save_disk_syms`。
- **全域熔斷 `_pionex_get`**：任一 Pionex 呼叫吃到 429 → `_PIONEX_COOLDOWN_UNTIL` 設 5 分鐘，期間所有 Pionex 呼叫**直接拋例外不發請求**；呼叫端 fallback/stale 降級。
- **失敗退避 300s + stale-serve**：`_fetch_pionex_symbols` / `_fetch_pionex_perp_symbols` 失敗時沿用上次成功清單（perp 另有 `PIONEX_PERP_FALLBACK` 硬編碼）。
- **只顯示 Pionex 標的**：`fetch_crypto_markets`（搜尋）與 `fetch_tickers`（列表）用 `psyms = 現貨清單 or perp 備援`、嚴格 `base in psyms`，**絕不**回退成全 Binance。
- **錯誤訊息正名**：`fetch_crypto_ohlcv` 區分 429（限流）與真的找不到，不再誤導「請確認代號」。

## 已知問題
- **台股月線**：`resample_tw()` 使用 `"MS"`（月初），台股月K應為最後交易日收盤，技術上應改 `"ME"` 但需測試相容性
- **台股 yfinance `dropna` 可能跳空**：`fetch_tw_intraday_yf` 在重新取樣後 dropna 可能刪除假日邊界的 K 棒，造成小時/15 分鐘視圖出現不連續缺口

---

## 即時行情疊加（台股分鐘K）

### `_mis_overlay(df, rt, minutes)` in `routes/data.py`
- 從 TWSE MIS 抓到即時價後疊加到 yfinance 最新 K 棒
- MIS 時間為台灣本地時間（UTC+8），需先 `-timedelta(hours=8)` 轉 UTC
- K 棒對齊：用 `last_ts.floor(f"{minutes}min")` 比對，避免 yfinance 不完整棒造成跳空
- 若 `bar_ts == last_bar_ts`：更新最後一棒的 close/high/low
- 若 `bar_ts > last_bar_ts`：新增一根合成棒（volume=0）
- 適用 5m / 15m / 1h；4h 及以上不做疊加

### `fetch_tw_intraday_yf` 時間戳修正
- yfinance 不完整棒時間戳可能錯誤（如 1h K 出現 11:40）
- 修正：`df["time"] = df["time"].dt.floor(freq)`，再 `drop_duplicates(subset=["time"], keep="last")`

### TW 1h 與 4h 內部用 15m 重採樣
- yfinance 直接抓台股 1h 有兩個 bug：
  - **成交量缺漏 ~37%**（少最後 30 分鐘 + 集合競價量）
  - **開盤錯位**：第一根 1h 落在「10:00」而非「09:00」（少了第一個交易小時）
- **修法**：`fetch_tw_intraday_yf(symbol, "1h", ...)` 內部改成「抓 15m → resample
  `1h` with `origin="start_day", offset="1h"`」對齊到 UTC 01:00（台北 09:00）。
  4h 同理：`offset="1h"` 對齊 09:00、第一個 4h bin 為 TPE 09:00-13:00。
- **副作用**：1h 可回溯範圍從 730 天降為 60 天（受 15m 限制，`TW_YF_MAX_DAYS["1h"] = 60`）。
- **開盤集合競價 vol=0 棒過濾**：yfinance 對台股 15m/1h 在 09:00 有時放一根
  vol=0 的「集合競價快照」棒，影線會誤導圖表。一律 `df = df[df["volume"] > 0]` 過濾。

---

## 天氣資料源（`routes/weather.py`）

`/api/weather?lat=&lon=` 依座標**地理分流**到在地官方氣象源，各源失敗一律
回退 Open-Meteo（全部失敗才回 503）。前端 `weather.js` 用 `navigator.geolocation`
取裝置真實座標，所以裝置移到不同地區會自動切換對應氣象源。

| 地區 | 來源 | 函式 | 備註 |
|------|------|------|------|
| 台灣 | 中央氣象署 CWA | `_from_cwa` | O-A0001 自動站，需 `CWA_API_KEY`；`_nearest_station` 會**跳過溫度 -99 的離線站** |
| 香港 | 香港天文台 HKO | `_from_hko` | rhrread 免金鑰、繁中；圖示碼 `_HKO_ICON` |
| 日本 | 日本氣象廳 JMA | `_from_jma` | AMeDAS 最近觀測站（座標 [度,分]）；無天氣文字 → 用日照/雨量推類型 |
| 其他 | Open-Meteo | `_from_omt` | 全球；WMO 碼 `_wmo_type` |

- 範圍判斷：`_in_taiwan` / `_in_hong_kong` / `_in_japan`（日本範圍排除朝鮮半島，避免首爾/釜山誤判）。
- **天氣動畫類型**（前端 `weather.js` `dXxx`，2026-06 從 effects.js 拆出）：`sunny/night/cloudy/fog/rain/snow/storm/thunder`
  + 細分 `partly`(晴時多雲)/`overcast`(陰)/`drizzle`(毛毛雨)/`windy`(大風)。三源各自 mapping
  （CWA `_desc_to_type`、WMO `_wmo_type`、HKO `_HKO_ICON`、JMA 日照雨量推斷）。
- **CWA `Weather="-99"`**：自動站常不報天氣文字（缺值碼 -99）→ 視為空、改用雲量推回描述
  （晴/晴時多雲/多雲/陰），避免前端顯示 "-99"。非氣象站故障。
- **`_asset_ver`（main.py）含 `effects.js` + `weather.js` mtime**：兩者皆由 main.js 動態獨立載入（不在 bundle），
  版號須隨它們變，否則 `/static` 的 immutable 長快取會吃到舊檔。

### `_sun_times_local(lat, lon)` 太陽升落時間
- 使用 **地理位置自然時區**（`round(lon/15)*60` 分鐘）而非伺服器時區
- 台灣（lon≈121.5）→ UTC+8 → tz_off=480 分鐘
- 若用伺服器 `astimezone().utcoffset()`，部署到不同時區後太陽位置會錯

## Web Push 訊號通知（`routes/notify.py` + `notify_monitor.py`）
CRT 訊號的瀏覽器/PWA 推播（多使用者）。**未設 VAPID 金鑰或無 DATABASE_URL → 整套停用**（`notify_enabled()`），其餘功能不受影響。前端細節見 [docs/frontend.md](frontend.md) 的「訊號通知中心」。

### 啟用條件與 VAPID
- 啟動時 `_load_vapid()` 從 `VAPID_PRIVATE_KEY`（PEM）載入 `py_vapid.Vapid02`、推導 `applicationServerKey`（base64url）給前端 subscribe。失敗則 `_vapid=None` → 停用。
- `send_push()` 用 `pywebpush.webpush`，`vapid_claims={"sub": VAPID_SUBJECT}`；推送失敗（410/404）→ `_delete_sub()` 清掉死訂閱。

### 路由（prefix `/api/notify`）
- `GET /status`：`{enabled, has_vapid}` | `GET /vapid_public`：applicationServerKey
- `POST /subscribe`：存訂閱（endpoint + 帳號 + 偏好）| `POST /unsubscribe`
- `GET /feed?name=&limit=`：帳號的通知歷史（entry/tp）| `POST /test`：發測試通知（也寫入 feed 當擬真範例）
- 偏好 `_clean_prefs`：監控時框（`DEFAULT_TFS = 1h/4h/1d`，允許集合 `_ALL_TFS` 含 5m~1M）、是否收止盈通知等，**存帳號**（跨裝置同步）。

### 資料表（Postgres/SQLite，`_ensure_db`）
`push_subs`（訂閱端點）、`notify_state`（每 scope 最後通知時間，`last_notified`/`mark_notified` 去重）、`notify_seen`/`notify_log`（事件級去重 `seen_event`/`mark_event` + 訊號歷史 `log_signal`）。

### 背景監控 `notify_monitor.py`（main.py 啟動時 `notify_monitor.start()`）
- **無訂閱自動空轉**（極低成本）；有訂閱才逐 (市場×交易所×標的×時框) 掃描。
- **即時、不吃 30 分勝率快取**：用短窗 df（`fetch_crt_df` + `MONITOR_BARS=320` 根的小 days）即時抓最新棒，重用 `_calc_crt_winrate` **只取 signals**（勝率統計不重要）。
- **進場通知（entry）**：最新收盤棒剛出現訊號 → 推一次（`last_notified` 去重）。
- **止盈通知（tp）**：訊號在最近數根收盤棒「結算為 win」（`sig.r=='w'`，停損前先碰動態中軌）→ 推一次。結算順序未必同進場順序 → 用 `seen_event`/`mark_event` 逐事件精確去重。停損（l）依使用者偏好預設不推。
- 各時框掃描間隔由 `_TF_SEC` / `_interval_sec(tf)` 控制（依時框長度節流）。
