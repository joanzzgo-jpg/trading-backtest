# trading Claude Instructions

## 語言規範
- **所有回覆請使用繁體中文**，包含說明、建議、程式碼注釋（非英文關鍵字）。

## 專案概覽
- `trading` 是一個回測系統，包含 FastAPI 後端、靜態前端、資料模組與策略引擎。
- 後端位於 `backend/`，前端位於 `frontend/`。
- `start.sh` 安裝依賴並啟動 `backend/main.py`。
- 部署於 Railway，推送 `main` branch 自動觸發部署（GitHub repo: `joanzzgo-jpg/trading-backtest`）。
- Railway 用 `Procfile`／`railway.toml` 直接跑 `cd backend && uvicorn main:app`，**沒有跑 `start.sh`**。前端 JS 打包改由 `backend/main.py` 的 `_build_js_bundle()` 在 import 時自動執行（偵測來源 JS 比 bundle 新就重建）。修改前端 JS 後**不需要**手動跑 `start.sh`。

### 環境變數
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

## 圖片資源
所有原始圖片存放於 **桌面 `Claude-分類/虛擬貨幣/`**，已複製至 `frontend/static/img/`。

### 原始圖檔對應
| 桌面原檔 | 複製至 static/img/ | 用途 |
|---|---|---|
| `IMG_0713.PNG` | `bear.png` | 橘子熊臉（favicon、頁首 Logo） |
| `IMG_0728.PNG` | `bear-full.png` | 橘子熊全身（右下角偷看角色） |
| `IMG_0719.PNG` | `bear-wand.png` | 橘子熊拿魔法棒全身（備用） |
| `IMG_0727.GIF` | `bear-wand.gif` | 橘子熊揮魔法棒動圖（讀取動畫） |
| `IMG_0730.PNG` | `cursor-wand.png` | 魔法棒游標（縮圖 64x56 px） |
| `IMG_0729.PNG` | —（參考用）| 魔法棒＋閃光效果（點擊特效設計參考） |
| `export.png` | `bear-bg.png` | 橘子熊頭部輪廓背景 |

### 前端圖片使用位置
- **`bear.png`** → `<link rel="icon">` favicon、頂部 logo、預設讀取圖示
- **`bear-full.png`** → 右下角偷看橘子熊（`#peekBear`），頁面載入 2.8 秒後出現
- **`bear-wand.gif`** → 讀取中動畫（`showLoading()` 函數）
- **`cursor-wand.png`** → 全站游標（CSS `*` selector，hotspot `14 9`）
- **`bear-bg.png`** → 背景裝飾用輪廓

## 視覺特效
- **游標**：魔法棒原圖縮圖（64x56），熱點在棒尖 `14 9`
- **點擊特效**：四層動畫 → 光暈環擴散 + 大橢圓粒子 + 小星塵 + 中心白光閃
- **偷看熊**：頁面右下角，靜止露出頭部（`bottom: -80px`），滑鼠移過露出全身（`bottom: 5px`），點擊會跳舞
- **按鈕漣漪**：`initButtonRipple()` IIFE，`pointerdown` 時動態插入 `span.btn-ripple-wave`
- **偷看熊氣泡**：Fisher-Yates 隨機排序（`_nextLine()`），耗盡後自動重洗牌

## 音效（`effects.js`）
- **SFX**：`SFX` 物件含 `click / load / success / error / tick / boop / switch_` 七種 Web Audio 音效
- **背景音樂（BGM）功能已整個移除**（原 `initMusicPlayer()` IIFE、`#musicToggleBtn`、`#musicPanel`、`THEMES`、YouTube 播放器）。`.music-panel` / `.music-panel-title` CSS class 為歷史名稱，現由 `#fxPanel` 等浮動面板共用，**勿刪**。

## 極簡模式（perf-mode）
給較舊裝置使用的純白系版本，**關掉所有特效並鎖住所有色票調整**，但保留圖表／回測／行情等核心功能。

### 啟用機制
- `localStorage.perfMode === "1"` → 啟用
- `<head>` 內 inline script 在 body 渲染前讀 localStorage 並掛 `html.perf-mode` class（避免暗色閃一下）
- FX 面板（✨）頂端「🌙 極簡模式」按鈕切換，按下後寫 localStorage 並 `location.reload()`（最乾淨）

### main.js 啟動流程
1. `loadPrefs()` 從 localStorage 讀使用者的 chart colors 進 `C`
2. **若 perf-mode：`Object.assign(C, _PERF_PALETTE)`**（in-memory only）— 把白底看不見的色（黃中軌、淡青 resonance）換成深色
3. `loadSystemColors()` + `applyAllSystemColors()` 套上使用者的系統色
4. **若 perf-mode：再次 `applySystemColor()` 覆蓋成純白系 SC palette**（蓋掉 inline style）
5. `buildCharts()`、`applyAllColors()` 等正常流程
6. **若 perf-mode：跳過載入 effects.js**，改裝最小化的 FX 面板開關

### 「不影響正常模式」三大保險
- `savePrefs()` 在 perf-mode 直接 `return`（utils.js）— 避免 `applyAllColors()` 結尾的 savePrefs 把 in-memory perf palette 寫回 `localStorage.chartColors`
- `showLegColorPopup()` 在 perf-mode 直接 `return`（draw.js）— 鎖住所有色票調整入口
- CSS 隱藏 `#sysSettingsBtn`、`.ind-gear-btn`、`.sys-color-swatch`，`.leg-dot` 設 `pointer-events: none`

### 配色 palette（純白系）
- 系統色 SC：bg=`#FFFFFF` / panel=`#FAFAFA` / border=`#E5E5E5` / text=`#1F1F1F` / muted=`#8B8B8B` / accent=`#FF6A1A`
- chart 額外變數：green=`#16a34a` / red=`#dc2626` / bg4=`#F0F0F0`
- LWC 圖表：text=`#1F1F1F` / grid=`#ECECEC` / crosshair=`#9C9C9C` / border=`#D9D9D9` / labelBg=`#F5F5F5`，背景**維持透明**讓 body 純白＋浮水印（z-index:-1）襯出
- 指標／線條（in-memory C 覆寫）：BB 中軌 `#ffcc02` 黃 → `#f57c00` 深橘、resonance bull `#26c6da` 淡青 → `#00838f` 深青、其他全部深色化

### CSS `!important` 注意事項
`style.css` 末段「橘子熊可愛風格」區塊（行 ~2288 起）對 `.topbar` / `.symbol-bar` / `.topbar-brand-name` 用 `!important` 強制套暗色漸層。所有 perf-mode 對 topbar 相關的覆寫**必須**也用 `!important` 才壓得過。

### 背景效能優化（perf-mode 專屬）
舊裝置 GPU 主要負擔來自 `backdrop-filter: blur()`，perf-mode CSS 強制：
- `html.perf-mode *` 設 `backdrop-filter: none !important`
- 浮層改實心白底＋極淡單層陰影（取代 blur）
- 關閉 `.blink`、`.tk-limitPulse` 等非必要無限動畫
- 浮層 transition 設 `none`

### 浮水印
極簡模式背景顯示橘子熊浮水印（`<img class="chart-bear-bg perf-only">` 在 `#mainChart` 內）：
- 預設 `display: none`
- `html.perf-mode` 才顯示，`opacity: 0.12`、`z-index: -1`、無 invert filter

## 資料夾用途

### 後端核心
- `backend/main.py` - FastAPI 主程式、路由註冊、模板與靜態檔案設定、啟動預熱
- `backend/routes/` - API 路由模組化
  - `data.py` - OHLCV、最新行情 API
  - `search.py` - 標的搜尋、tickers、Pionex symbols
  - `strategies.py` - 策略列表
  - `backtest.py` - 回測執行
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

### 策略與回測
- `backend/strategies/` - 交易策略
  - `builtin.py` - 內建策略實現
- `backend/backtest/` - 回測引擎
  - `engine.py` - 回測執行與淨值計算

### 前端
- `frontend/templates/index.html` - 主頁面（工具列、圖表、重播列、偷看熊）
- `frontend/static/css/style.css` - 樣式（含游標、粒子特效、偷看熊動畫）
- `frontend/static/img/` - 所有圖片（見上方圖片資源表格）

#### JS 模組

**A. bundle 檔（`frontend/static/js/`，依此順序串接成 `app.bundle.js`）**
> 載入/串接順序＝ `main.py` 的 `_build_js_bundle()` 內 `names` 串列。**新增 bundle 檔時務必同步加入 `names`**，否則不會被打包。
> 因 bundle 是「依序串接後 minify」，把某檔**依行邊界切成數檔、並在 `names` 同位置插入**，產出的 minify bundle 位元組完全相同（零行為風險）——拆檔請走這條路。

| 檔案 | 行數 | 內容 |
|------|------|------|
| `config.js` | ~98 | 全域常數（DEFAULT_COLORS/STYLES）、狀態變數（ohlcvData、currentTF、_savedTimeRange 等） |
| `utils.js` | ~225 | toTime、hexAlpha、偏好設定存取（savePrefs/loadPrefs）、格式化工具（fmt/fmtVol/fmtT）、showToast、showLoading |
| `charts.js` | ~267 | makeBaseOpts、createCandleSeries、applyOhlcvToSeries、updateLatestPriceLine、buildCharts、resizeAll、syncTimeScales |
| `draw.js` | ~1164 | **繪圖工具核心**：drawings 狀態、initDrawTools、滑鼠/觸控事件、hit-test（findNearest/_drawingHitPart）、renderDrawings、drawOne（含 longpos/shortpos 盈虧比盒）、drawPreview |
| `colors.js` | ~438 | **顏色/樣式系統**（2026-06 從 draw.js 拆出）：_darkenForChart、_applyChartBgGradient、applyAllColors、initColorPicker（色票面板）、_updateStarBtn |
| `ticker.js` | ~932 | 自選清單、行情面板（fetchTickers/renderTickers + `_reconcileTicker` 鍵控重用）、標的搜尋（initSymSearch） |
| `winrate.js` | ~836 | `_wrCache`、fetchWinRate、_renderWRSignals、_renderWinRate、hover 勝率（_updateHoverWR）、自動盈虧比盒（_computeAutoRRBox/_renderAutoRRBoxes） |
| `render.js` | ~461 | loadData、_applyPriceFormat、renderAll、renderCandles/BB/CRT/KDJCross/Resonance/Volume/KDJ/RSI/MACD、_bgApplyChunk、_bgScheduleIndicators、_bgLoadOlderBars |
| `realtime.js` | ~285 | startRealtime、stopRealtime、fetchLatest（含切標的丟棄守衛）、_resetSymbolBarQuote、updateAllLegends、onXxxCrosshair、updateSymbolBar |
| `replay.js` | ~451 | replayData 狀態、_rpCal 日曆 IIFE、enterReplay/exitReplay、replayPlay/Step、bindReplayBar |
| `ui.js` | ~851 | bindEvents、updateMarketUI、bindPaneDividers、bindIndicatorPanel、bindLegendColors、bindLegendToggles、bindSystemColors |
| `ai_research.js` | ~233 | AI 研究面板 |
| `signal_info.js` | ~715 | 訊號詳情左抽屜（SIGNAL_INFO metadata、統計列、敗後停手細節） |
| `account.js` | ~176 | 帳號系統（登入/登出、雲端同步 _acctTouch） |
| `main.js` | ~251 | DOMContentLoaded 初始化入口（呼叫所有 init、loadData）、字體大小 IIFE、延遲載入特效 |

**B. 動態載入檔（不在 bundle，由 `main.js` 閒置後注入 `<script async=false>`，版號走 `_asset_ver` 的 mtime）**
| 檔案 | 行數 | 內容 |
|------|------|------|
| `effects.js` | ~702 | initClickSparks、initPeekBear、initTickerKeyNav、initButtonRipple、SFX 音效引擎、initFxPanel（背景音樂已移除） |
| `weather.js` | ~1938 | **天氣/天文背景動畫 Canvas**（2026-06 從 effects.js 拆出）：initWeatherBg 單一 IIFE，含各天氣繪製、天然災害、極光/晚霞/流星雨。完全自足、不引用 effects 全域 |

> **原單體 `app.js` 早已拆分為多個模組並刪除（不復存在）。新增功能請編輯對應的模組檔案。**
> **拆檔注意**：bundle 檔拆完要更新 `names`；動態檔（effects/weather）拆完要更新 `main.js` 的 `_loadFx` 與 `main.py` 的 `_asset_ver`。`effects.js` / `weather.js` 為 classic script（非 module），頂層 `const`/`let` 走「全域語彙環境」跨檔共享，故拆檔後仍可互相引用（被引用者需先載入）。

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

## 效能優化

### 後端勝率計算（`utils/crt.py`）
- **時間戳向量化**：`times_iso = df["time"].to_numpy("datetime64[s]").astype(str).tolist()`，取代逐根 `_ts_val` + pandas 慢速 `__iter__`。tz-naive 秒精度下與 `.isoformat()` 完全一致，**省整體 ~30%**。
- **`signals` 排序一次**：`signals_sorted` 共用給 `_calc_streaks` / `_build_combined`（原本各自 `sorted` ~16 次）。
- **`_build_combined` memoize**：cond/stop/recent 會重複要同組合（24 呼叫、12 種唯一）→ `_combined_memo` 快取免重算。
- **`_solve` 精簡模式**：`_calc_crt_winrate(_solve=target)`（target 字串 mid/band）——每訊號只掃選定目標、跳過 est/RR/全部統計，只跑敗後停手模擬回 `{win_rate, total}`。求解（達標止損）13× 掃描用此模式（偵測 mask 與完整版共用，~4-6× 快）。
- **df 快取**（`crt_df2:...`，不含 buffer，存於 `data_cache` 池）：換 SL 緩衝免重抓（抓資料佔總時間 90%+）。`utils/cache.py` 為真 LRU，重量級 CRT 產物（df/wr/solve）走 `data_cache`、與揮發性 `ohlcv` 的 `cache` 分池。
- > 兩目標（中/帶）+ recent100 的計算成本中等，且有 1hr 快取，非使用者可感瓶頸。剩餘最大塊是每訊號數次掃描（mid/帶/est），屬功能必要、不再硬壓。（原第三目標 1:1 已移除，省一輪固定目標掃描。）

### 前端圖表標記視窗化（`render.js` / `charts.js`）
- 小時/4H 背景載入上千根 → CRT+KDJ叉+共振+多空訊號可達**數千標記**（4h 滑到底 ~8500），全丟 `setMarkers` 會讓每次平移/縮放重繪全部 → 卡。
- `_applyMainMarkers` 只渲染「**可見範圍 ±一屏**」（`_windowMarkers` 用 `getVisibleRange` 過濾）；平移/縮放時 `_scheduleMarkerRewindow`（debounce 100ms）重算（掛在 `syncTimeScales` 的範圍變化）。
- 安全網：標記 <400 個或取不到可見範圍 → 照舊全顯示（短範圍不受影響、無功能損失）。

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

## 星號按鈕
- **頂部工具列**：`#watchlistStarBtn`，class `starred` 控制填滿，JS 用 `classList.toggle("starred", inWl)` 而非 `textContent`
- **行情列表（合約/台股）**：使用 `_STAR_SVG` 常數注入相同 SVG，`tk-star.active` CSS 控制填滿效果

## CRT 策略自動回測（`/api/crt_winrate`）

### 🔧 新增訊號（Sxx）的完整 checklist（降低維修成本）
目前已有 S1(abc)、S2(ab)、S3~S12（**S1 與 S12 皆不計入總勝率合計**）。新增一個訊號（下例假設新增 S13）要改這些地方（缺一就會壞）：

**後端 `backend/utils/crt.py`**
1. `SIG_KEYS` 串列加入新 key（無前綴字串，如 `"13"`）
2. 在對應的 `if n>=X` 區塊算出 `sXX_short` / `sXX_long` mask
3. 呼叫 `_process_3bar(...)`（3 棒）或自寫迴圈（4 棒，仿 S10/S11）+ `_push_signal(... "13" ...)`
4. `_build_target_stats` 的 `out` dict 加 `"sXX": per_sig["13"]`
5. **若要計入總勝率**：合計 tuple `_AGG`（在 `_build_target_stats` 內）加入 `"13"`（目前 `_AGG` = ab,3~11，即 S2~S11；S1/S12 刻意不在內）

**後端 `backend/routes/data.py`**
6. `_sufficient` 的 sig 迴圈加入 `"sXX"`
7. `cache_key` 版號 +1（`crt_wrNN` → `crt_wrNN+1`）強制重算

**前端**
8. `templates/index.html`：勝率欄加一個 `.tb-wr-block`（data-sig + icon + wrSXXS/wrSXXL）。注意這些 block 預設由 CSS 隱藏（改用 hover 顯示，見下方 HUD），但仍需存在供 `setRow` 寫值
9. `winrate.js`：`setRow("wrSXXS", d.sXX?.short)`；marker 的 `eColor`/`eShape`/`eText` 加 `k==="13"` 分支；`_SIG_LABEL`/`_SIG_ICON`/`_SIGK_TO_STATKEY` 各加一項（hover 小卡用）
10. `signal_info.js`：`_S_KEY_MAP` 加 `sXX:"13"`；`SIGNAL_INFO` 加該訊號 metadata
11. `style.css`：`.wr-sXX { color }` + perf-mode 版

> **變數命名**：stat key 用 `s3`~`s12`（有 s 前綴），但 signal record 的 `s.k` 與 `SIG_KEYS` 用 `"3"`~`"12"`（無前綴）。`_SIGK_TO_STATKEY` 負責 `"3"`→`s3` 轉換（hover 用）。abc/ab 兩者同名。
> **強化版（variant）已完全移除**（後端 2026-05、前端死碼 2026-06）。後端無 `_v`/`out["variant"]`、`signals` 不帶 `v`、`_solve` 為單純 target 字串；前端 `winrate.js`/`signal_info.js` 的 variant 殘留亦已清除。新增訊號**不需**處理 variant。

### 訊號並行計算（S1~S12）

> 目前共 12 種訊號（S1=abc、S2=ab、S3~S12）。下方詳列 S1~S6；S7~S12 的條件見各自 mask 與 `signal_info.js` 的 `SIGNAL_INFO`。新增訊號照上方 checklist。
> **訊號一（S1/ABC）與訊號十二（S12）僅獨立顯示，不計入總勝率合計（`_AGG` = S2~S11）。** 注意 `_sufficient`（決定抓多少天資料）要求 `abc/ab/s3~s11`（即 S1~S11）各空/多達 `MIN_CASES`，但**不含 S12**——兩者範圍不同，別搞混。

#### 訊號一（ABC）：同一棒三條件同時成立
| 方向 | CRT | KDJ 交叉 | 共振（resonance） |
|------|-----|---------|-----------------|
| 做空 | -1（看跌完成棒） | -1（死叉） | -1（超買） |
| 做多 | +1（看漲完成棒） | +1（金叉） | +1（超賣） |

- 進場：訊號棒（i）下一根開盤（`entry_i = i + 1`）
- 停損：訊號棒 i 的最高價（做空）/ 最低價（做多）
- **不計入總勝率**，僅作參考顯示

#### 訊號二（AB）：連續兩棒接力
- **A 棒（i）**：`resonance == ±1`（超買或超賣共振）
- **B 棒（i+1）**：`crt == ±1` 且 `kdj_cross == ±1`（同方向）
- **排除條件①**：B 棒同時有 resonance（等同訊號一）→ 跳過
- **排除條件②**：B 棒的 low（做空）/ high（做多）已碰至 BB 中軌 → 目標已提前觸及，跳過
- 進場：B 棒下一根（`entry_i = i + 2`）
- 停損：**A、B 兩棒**取最高價（做空）/ 最低價（做多）

#### 訊號三（S3）：連續三棒，放寬版（每棒最多 2 個指標）
- **A 棒（i）**：有 resonance，但 CRT 與 KDJ叉 不能同時出現（最多兩個指標）
- **B 棒（i+1）**：同 A 棒規則（有 resonance，最多兩個）
- **C 棒（i+2）**：有 KDJ叉，但 CRT 與 resonance 不能同時出現（最多兩個）
- **排除條件**：僅排除「C 棒碰中軌」（做空 `c_low > bb_middle`／做多 `c_high < bb_middle`，留出回歸空間）。**不再排除「C 棒觸上/下軌」**——均值回歸時死叉棒刺到上軌（超買後反轉）正是最佳進場點，排除它會漏掉強訊號（例：超賣叢集→金叉、叉棒刺破下軌）。
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

#### 訊號四（S4）：連續三棒，嚴格純淨版（A=純共振，B=無，C=純叉）
- **A 棒（i）**：**只有** resonance（CRT=0、KDJ叉=0）
- **B 棒（i+1）**：**三個指標全無**（CRT=0、KDJ叉=0、resonance=0）
- **C 棒（i+2）**：**只有** KDJ叉（CRT=0、resonance=0）
- **排除條件**：C 棒 low/high 碰至 BB 中軌 → 跳過
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

#### 訊號五（S5）：連續三棒，嚴格純淨版（A=無，B=純共振，C=純叉）
- **A 棒（i）**：**三個指標全無**（CRT=0、KDJ叉=0、resonance=0）
- **B 棒（i+1）**：**只有** resonance（CRT=0、KDJ叉=0）
- **C 棒（i+2）**：**只有** KDJ叉（CRT=0、resonance=0）
- **排除條件**：C 棒 low/high 碰至 BB 中軌 → 跳過（同 S4）
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

#### 訊號六（S6）：ABC 三棒觸軌反轉
邏輯：2 根「安靜」棒後突然出現觸軌反轉 K → 高品質的「轉折開始」訊號。
> **2024 改版**：原為「3 安靜棒 + 第 4 根反轉」（4 棒），但前 3 根全乾淨太嚴格、
> 實戰復盤常漏（D 棒明明是漂亮的觸軌反轉，只因前 3 根有一根雜訊指標就不出）。
> 改為「2 安靜棒 + 第 3 根反轉」（3 棒），更貼近實際所見。
- **A 棒（i）**：crt=0、kdj_cross=0、resonance=0（全無指標）
- **B 棒（i+1）**：同 A，全無指標
- **C 棒（i+2）**（訊號棒）：
  - 做空：`crt == -1` 且 `high >= bb_upper`（影線或本體觸上軌）
  - 做多：`crt ==  1` 且 `low  <= bb_lower`
  - 排除：C 棒已碰中軌（做空 `low > bb_middle`／做多 `high < bb_middle`）
- 進場：C 棒下一根（`entry_i = i + 3`）開盤
- 停損：**A、B、C 三棒**取最高（做空）/ 最低（做多）
- 前端圖示：◇（紫藍 `#9fa8da`，極簡模式 `#3949AB`）；標籤：空⁶／多⁶

#### 共同勝負條件（全部訊號適用）
- **獲勝**：後續 K 棒 `low ≤ BB中軌`（做空）或 `high ≥ BB中軌`（做多）
- **失敗**：後續 K 棒觸及停損位
- **同棒雙觸**：以收盤價判定先後（收在獲利側 → 成功）

#### 指標欄位說明
- **CRT**：`crt_markers()`，信號落在完成棒（第二根），`signals[bearish.shift(1)] = -1`
- **共振**：`bb_kdj_rsi_resonance()`，高觸布林上軌 + KD>80 + RSI7>65 → -1；低觸下軌 + KD<20 + RSI7<35 → +1
- **`enrich_df()`** 中共振使用 `rsi_7`（7 期 RSI），閾值 `rsi_ob=65, rsi_os=35`

### 後端結構（`backend/utils/crt.py`）
- **共用 helper（模組層級）**：
  - `_ts_val(t)` → ISO 字串（`.isoformat()` 等價，給單一時間戳用；批次轉換已向量化，見效能優化）
  - `_scan_outcome_np(...)` 動態目標掃描，回 `('win'/'loss'/None, 結算時間, exit_idx)`
  - `_scan_outcome_fixed(...)` / `_scan_outcome_fixed_t(...)` 固定目標掃描（後者另回結算時間，原供 1:1 用，1:1 移除後僅 est 系列仍用 `_fixed`）
- **主函數** `_calc_crt_winrate(df, stop_buffer_pct=0, long_only=False, _solve=None)`，**兩目標各一份完整統計**（原三目標，1:1 已移除）：
  - **頂層 = 中軌(mid)**；`"band"` = 上下軌（多→上軌、空→下軌）。兩者結構相同。
  - **`"rr"`（1:1，止盈距離 = 止損距離）已於 2026-06 從前端移除** → `_scan_rr()` 短路回 `None`、`rr` 結構保留但為空、`signals` 的 `r_rr/ot_rr=None`，前端不讀（`_wrTargetView` 載入時把舊存的 `"rr"` 正規化成 `"mid"`）。省下每訊號一次固定目標掃描。
  - 每個 target 含：`total/wins/win_rate`、`short/long`、各訊號 `abc/ab/s3~s12`、`stop_strategy`（敗後停手，內含 `.est`）、`recent100`（近 ~100 筆勝率）、`est_*`（預估盈虧比達標）、`max_loss_streak`、cond（連敗機率，在 short/long 內）。
  - `signals`：每筆 `{t, d, k, r/ot(中軌), r_b/ot_b(帶軌), r_rr/ot_rr(=None,1:1已移除), est_r/est_r_b, rr(預估盈虧比值,供前端顯示), stop(實際止損價,含 buffer/多棒取極值)}`。
  - 另含 `from_date`、`recent`（最近 30 筆）、`long_only`。
- **`_solve=target`**（字串 mid/band）：求解專用精簡模式——只掃選定 target、跳過 est/RR/全部統計，只跑敗後停手模擬回傳 `{win_rate, total}`（偵測 mask 與完整版共用）。詳見「效能優化」。

### 最低案例數保證
- `MIN_CASES = 40`；`_sufficient(r)` 檢查 abc/ab/s3~s11 各空/多是否達標（**不含 S12**）。
- **不再 doubling**：直接一次抓 `TF_MAX` 天（過去 doubling 對 S1/S5/S7 等稀有訊號永遠達不到、浪費 80% 時間）。
- cache key：`crt_wr70:market:symbol:exchange:timeframe:buffer:long_only`（訊號邏輯／輸出結構變更時遞增版號）；solve 另用 `crt_solve5:...`；enrich 後的 df 另快取 `crt_df2:...`（不含 buffer，換 SL 緩衝免重抓，抓資料佔總時間 90%+）。以上三者皆存於 `data_cache` 池（見「效能優化」）。

### 各時間框架資料來源與回測天數
| TF | 初始天數 | 天數上限 | TW 來源 | US 來源 | Crypto |
|----|---------|---------|---------|---------|--------|
| 1M | 3650d | 3650d | 日線→月線重採樣 | yfinance 原生 | ccxt |
| 1W | 1825d | 3650d | 日線→週線重採樣 | yfinance 原生 | ccxt |
| 1D | 730d | 3650d | yfinance 日線 | yfinance | ccxt |
| 4H | 365d | 1825d | 1h→4h 重採樣 | yfinance | ccxt |
| 1H | 365d | 730d | yfinance 小時線 | yfinance | ccxt |
| 15m | 60d | 180d | yfinance 15分線 | yfinance | ccxt |
| 5m | 30d | 60d | yfinance 5分線 | yfinance | ccxt |

- 快取 TTL：1 小時；cache key 含 `market:symbol:exchange:timeframe` + 版號
- 最少 50 根 K 棒才能回測，不足時回傳 400

### 訊號棒視覺化（`_renderWRSignals`）
- `_lastWRSignals`：模組全域，儲存完整訊號列表（背景載入後重新過濾用）
- 只顯示圖表**已載入**時間範圍內的訊號（用 `chartTimeSet` O(1) 查詢）
- **觸發時機**：首次 winrate 回傳時、`_bgScheduleIndicators`（debounce 800ms）、`_bgLoadOlderBars` finally 區塊——任何背景載入舊 K 棒後都會重新過濾標記
- **進場標記**（`s.k` 欄位對應）：
  | k | 圖示形狀 | 做空色 | 做多色 | 文字 |
  |---|---------|-------|-------|------|
  | `"abc"` | circle | `#ff6b6b` | `#4fc3f7` | 空/多 |
  | `"ab"` | square | `#ff9800` | `#26c6da` | 空²/多² |
  | `"3"` | arrowDown/Up | `#ce93d8` | `#b39ddb` | 空³/多³ |
  | `"4"` | arrowDown/Up | `#80cbc4` | `#4db6ac` | 空⁴/多⁴ |
  | `"5"` | arrowDown/Up | `#ffb74d` | `#ffa726` | 空⁵/多⁵ |
  | `"6"` | arrowDown/Up | `#9fa8da` | `#7986cb` | 空⁶/多⁶ |
  | `"7"` | arrowDown/Up | `#4dd0e1` | `#80deea` | 空⁷/多⁷ |
  | `"8"` | arrowDown/Up | `#f06292` | `#f48fb1` | 空⁸/多⁸ |
  | `"9"` | arrowDown/Up | `#fff176` | `#fff59d` | 空⁹/多⁹ |
  | `"10"` | arrowDown/Up | `#90caf9` | `#bbdefb` | 空¹⁰/多¹⁰ |
  | `"11"` | arrowDown/Up | `#aed581` | `#c5e1a5` | 空¹¹/多¹¹ |
  | `"12"` | arrowDown/Up | `#ffab91` | `#ffccbc` | 空¹²/多¹² |
- **結果標記 + 目標切換**：結果欄位依目標鈕（中軌/上下軌）取 `s.r/s.ot` 或 `s.r_b/s.ot_b`（前端 `_wrResultKey()`/`_wrOtKey()` 幫手；1:1 的 `s.r_rr/s.ot_rr` 已移除、恆為 null）：
  - `= "w"` → 綠色 `#26a69a`，文字 `✓`，位置在目標方向
  - `= "l"` → 紅色 `#ef5350`，文字 `✗`，位置在止損方向
  - 結算棒時間 = 對應 ot 欄位；為 null 表示末端尚未結算
- **標記視窗化**（效能）：見「效能優化」——只渲染可見範圍 ±一屏的標記。
- 透過 `lastWRSignalMarkers` 合入 `_applyMainMarkers()`；切換標的/時框時清除

### 勝率顯示欄（topbar，三段式 HUD 設計）
**佈局：** `flex: 1 1 auto` 佔滿 `topbar-left` 與 `topbar-tf` 之間所有可用空間。內部三段：

```
┌─────────────────────────────────────────────────────────────┐
│ [中軌|0%]    [十字線 hover → 該棒訊號勝率並列]    [↕75% ←date筆數] │
│ ↑ tb-wr-fixed-left  ↑ tb-wr-scroll(#wrHover)     ↑ tb-wr-fixed-right
└─────────────────────────────────────────────────────────────┘
```

> **2026 改版**：中央區原本是「常駐 S1~S6 橫向滾動勝率塊」，已改為**十字線 hover 顯示**——滑鼠/十字線移到某根 K 棒，`#wrHover` 顯示「該棒上所有訊號的勝率」並列（手機 3+ 訊號用卡片自動輪播）。`templates/index.html` 內 12 個 `.tb-wr-block`（abc~s12）**仍存在但被 CSS `#wrScroll > .tb-wr-block{display:none}` 隱藏**（保留供 `setRow` 寫值與相容），實際顯示走 `#wrHover`。詳見 winrate.js 的 `_updateHoverWR`。

- **左固定區 `.tb-wr-fixed-left`**（z-index:3 不隨滾動移動）
  - `#wrTargetToggle`：單鍵 toggle 切換目標（**兩段** 中軌 ↔ 上/下軌；原第三段 1:1 已於 2026-06 移除）
    - 「中軌」（預設）= BB middle target
    - 「上/下軌」= 多→BB upper、空→BB lower（方向相關的極端反向目標）
    - 點擊呼叫 `_toggleWrTarget()`（`mid` ↔ `band`），state 存 `localStorage.wrTargetView`；載入時若讀到舊值 `"rr"` 會正規化成 `"mid"`
    - 後端兩種目標各算一份完整統計：mid 放頂層、band 在 `d.band`（結構相同：總/各訊號/連敗/敗後停手）。前端用 `_wrPickView(d)`/`_wrResultKey()`/`_wrOtKey()` 三幫手依 view 取值
  - `#wrStopBuffer`：number input 0~10，止損緩衝百分比
    - 多單 `stop = base_low × (1 - buffer)`、空單 `stop = base_high × (1 + buffer)`
    - state 存 `localStorage.wrStopBuffer`（decimal 字串）
    - 變更 → 清前端 `_wrCache` → re-fetch
- **中央區 `.tb-wr-scroll`**：實際內容為 `#wrHover`（hover 勝率小卡，見上方改版說明）。被隱藏的 `.tb-wr-block` 元素 ID 仍為 `wrAbcS/L`、`wrAbS/L`、`wrS3S/L`~`wrS12S/L`（hover 小卡用 `_SIG_LABEL`/`_SIG_ICON` 對照表上色）
- **右固定區 `.tb-wr-fixed-right`**（z-index:3 不隨滾動移動）
  - `#wrAll`：**S2~S11** 合計勝率（`_AGG`；S1、S12 皆不計入），CSS gradient text + drop-shadow glow
  - `#wrRecent100`：**近 ~100 筆**勝率（合併時間軸去重後最近 100 筆，看近期表現 vs 全期）。後端各 target 存 `recent100`（由 `_build_combined` 取末 100 筆算）；跟目標鈕切換
  - `#wrFromDate`：回測起始日 `←YYYY/MM/DD`
  - `#wrStatus`：「N筆」目前圖表可見訊號數

**漸層流線視覺：**
- 主背景 5-stop 對角漸層（深褐→暖橘→深褐）+ `backdrop-filter: blur(18px)`
- `::before` 動畫 `wr-flow` 6s loop 橘色微光由左掃到右
- `::after` 1px 暖色漸層細線於頂部（HUD 細節）
- 圓角 10px、雙層 outer glow（30px + 60px halo）

**計算中狀態 `.calculating`：**
- 全資料變暗 32% opacity（提示「舊資料」）
- 中央 `.tb-wr-loading`（小熊頭 `bear.png` + 「計算中…」）淡入，z-index:6
  - 熊頭 `bear-bounce` 0.9s loop（上下彈跳 + 左右搖擺 + 微縮放）
  - 文字 `wr-loading-pulse` 1.4s loop（opacity 75%↔100%）
- 底部 `.tb-wr-progress` 進度條 — 水流動態漸層：
  - 8-stop 漸層 + `background-size: 200%`
  - 雙動畫：`wr-progress-fill`（2.5s 寬度 0→95%）+ `wr-progress-flow`（1.6s 漸層位置 200%→0%）
  - 像液態金屬/燃料條流動

**hover 狀態保護：**
- `_mouseOverChart`（DOM `mouseenter/leave`，比 LWC crosshair 可靠）
- 滑鼠在任一圖表內 → `updateSymbolBar` 跳過，上方 OHLCV 不被 realtime poll 跳回

**極簡模式：**
- 所有橘色 glow / 漸層改成純白底 + 橘 `#FF6A1A` solid active
- 動畫保留（不顯著影響效能）但色彩淡化

### 時間戳格式規範（重要）
- 後端傳給前端的所有時間戳必須用 `.isoformat()`，**不能用 `str(pd.Timestamp)`**
  - `str()` → `"2024-01-15 00:00:00"`（空格），`toTime()` 找不到 T → 拼出無效字串 → NaN
  - NaN 時間戳餵給 `setMarkers()` → Lightweight Charts 內部狀態損壞 → **十字線鉛垂線全面斷裂**
  - 正確：`raw_t.isoformat() if hasattr(raw_t, "isoformat") else str(raw_t)`（已封裝於 `_ts(row)`）

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

---

## 版面配置

### 頂部工具列（topbar）結構
```
[左：Logo + 標的選擇] [勝率欄 flex:1 撐滿] [TF按鈕] [icon 按鈕]
```
- `.topbar` 用 `display: flex; justify-content: flex-start`
- `.topbar-left` `flex: 0 0 auto`（不主動 grow，保護內容空間）
- `.tb-winrate` `flex: 1 1 auto`（佔滿可用空間），內部三段式（見上方「勝率顯示欄」章節）
- `.topbar-tf` 與 `.topbar-right` `flex-shrink: 0`（固定不縮）
- 注：舊版用 `position:absolute; left:50%` 居中，但會擋到 TF 按鈕，改為 flex 佈局後解決
- 手機 `@media (max-width:768px)`：`.tb-winrate { display:none }`
- TF 按鈕（`.topbar-tf`）在 HTML 中排在 winrate 之後，視覺上靠右

### 主圖背景漸層（`_applyChartBgGradient`）
使用者可在主圖設定（齒輪 →「主圖背景」色點）自選顏色，**只套到 `#mainPane`**，並在上下邊緣自動漸層至系統背景 `var(--bg)`，視覺上像浮在系統色之上的有色面板。

- **helper**：`_applyChartBgGradient(color)` 在 [draw.js](frontend/static/js/draw.js)，緊接 `applyAllColors` 之前
- **CSS 漸層**：`linear-gradient(to bottom, var(--bg) 0%, ${color} 15%, ${color} 85%, var(--bg) 100%)`
  - 中央 70% 是實色、上下各 15% 漸層；可依視覺需求調整 stop（更柔和 → 拉到 40%/60%；只在底部淡出 → 0% 改成 user color）
- **呼叫點**：
  - `applyAllColors()`（初始化 / 切換 perf-mode 時）
  - 主圖設定 picker 的 `onColor`（[ui.js:379-384](frontend/static/js/ui.js#L379-L384)）
- **重要：不再改 body / .charts-container 背景**——原本舊版會把整頁 body 染色，造成「主圖背景」名實不符。改版後 body 與 charts-container 維持 CSS 預設 `var(--bg)`，名稱才對應行為
- **perf-mode 跳過**：`pane.style.background = ""` 清空，讓浮水印（z-index:-1）能透過 mainPane 顯示。perf-mode 本來就鎖色票，不需要這個漸層

### chartBg 預設值
- `config.js` 預設 `C.chartBg = "#131722"`（深藍）。第一次載入時主圖會是深藍漸層，使用者可改成系統色 `#170F0C`（暖褐底）或其他偏好色
- 存於 `localStorage.chartColors.chartBg`，由 `savePrefs()` 持久化

---

## 快速啟動
```bash
cd /Users/noah/trading
./start.sh
```

也可直接進入後端：
```bash
cd /Users/noah/trading/backend
uvicorn main:app --reload
```
