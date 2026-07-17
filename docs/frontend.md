# 前端架構

> 從 CLAUDE.md 拆出的前端詳細參考。CLAUDE.md 只留關鍵鐵則，細節在此。

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

## 資料夾用途（前端）
- `frontend/templates/index.html` - 主頁面（工具列、圖表、重播列、偷看熊）
- `frontend/static/css/style.css` - 樣式（含游標、粒子特效、偷看熊動畫）
- `frontend/static/img/` - 所有圖片（見上方圖片資源表格）

### JS 模組

**A. bundle 檔（`frontend/static/js/`，依此順序串接成 `app.bundle.js`）**
> 載入/串接順序＝ `main.py` 的 `_build_js_bundle()` 內 `names` 串列。**新增 bundle 檔時務必同步加入 `names`**，否則不會被打包。
> 因 bundle 是「依序串接後 minify」，把某檔**依行邊界切成數檔、並在 `names` 同位置插入**，產出的 minify bundle 位元組完全相同（零行為風險）——拆檔請走這條路。

| 檔案 | 行數 | 內容 |
|------|------|------|
| `config.js` | ~107 | 全域常數（DEFAULT_COLORS/STYLES）、狀態變數（ohlcvData、currentTF、_savedTimeRange 等） |
| `utils.js` | ~267 | toTime、hexAlpha、偏好設定存取（savePrefs/loadPrefs）、格式化工具（fmt/fmtVol/fmtT）、showToast、showLoading |
| `charts.js` | ~416 | makeBaseOpts、createCandleSeries、applyOhlcvToSeries、updateLatestPriceLine、buildCharts、resizeAll、syncTimeScales |
| `draw.js` | ~1470 | **繪圖工具核心**：drawings 狀態、initDrawTools（懸浮島工具欄）、滑鼠/觸控事件（含主圖空白區可繪圖）、hit-test（findNearest/_drawingHitPart）、renderDrawings、drawOne（含 longpos/shortpos 盈虧比盒、斐波那契）、drawPreview。繪圖按標的/帳戶隔離 |
| `colors.js` | ~442 | **顏色/樣式系統**（2026-06 從 draw.js 拆出）：_darkenForChart、_applyChartBgGradient、applyAllColors、initColorPicker（色票面板）、_updateStarBtn。手機端/電腦端配色各自獨立、皆隨帳戶同步 |
| `ticker.js` | ~1069 | 自選清單、行情面板（fetchTickers/renderTickers + `_reconcileTicker` 鍵控重用）、標的搜尋（initSymSearch） |
| `winrate.js` | ~848 | `_wrCache`、fetchWinRate、_renderWRSignals、_renderWinRate、hover 勝率（_updateHoverWR）、自動盈虧比盒、**系列切換 `_wrSeries`（S↔SS）+ 主圖「標記系列」過濾（全部/只S/只SS）** |
| `footprint.js` | ~200 | **Footprint 足跡圖**（2026-07-17）：`toggleFootprint`/`_fpFetch`/`_makeFootprintPrimitive`。打 `/api/footprint`，primitive 畫每根棒各價位買賣量（左紅賣/右綠買、金框 POC、棒底 Δ+總量）。僅 crypto、tf∈1m~1h（逐筆精確、漸進補齊：`pending_min>0` 時 5s 快輪詢 `_fpFastT`＋右上角顯示「剩 N 分鐘」）＋4h/1d（`kagg` 1m聚合）；圖例「足跡」預設關；barSpacing<14 只顯提示、≥52 才畫數字；抓失敗不記 `_fpKey`→draw() 5s 退避自癒（`_fpNextTryTs`）；primitive 於 `charts.js createCandleSeries()` 掛載 |
| `render.js` | ~582 | loadData、_applyPriceFormat、renderAll、renderCandles/BB/CRT/KDJCross/Resonance/Volume/KDJ/RSI/MACD、_bgApplyChunk、_bgScheduleIndicators、_bgLoadOlderBars |
| `realtime.js` | ~317 | startRealtime、stopRealtime、fetchLatest（含切標的丟棄守衛）、_resetSymbolBarQuote、updateAllLegends、onXxxCrosshair、updateSymbolBar |
| `replay.js` | ~459 | replayData 狀態、_rpCal 日曆 IIFE、enterReplay/exitReplay、replayPlay/Step、bindReplayBar |
| `ui.js` | ~947 | bindEvents、updateMarketUI、bindPaneDividers、bindIndicatorPanel、bindLegendColors、bindLegendToggles、bindSystemColors、手機底部分頁切換（淡入淡出） |
| `ai_research.js` | ~233 | AI 研究面板 |
| `signal_info.js` | ~732 | 訊號詳情左抽屜（SIGNAL_INFO metadata、統計列、敗後停手細節） |
| `notify.js` | ~393 | **訊號通知中心**（聊天室式底部分頁）+ Web Push 訂閱（VAPID）：偏好（監控時框/通知事件）帳號級同步、`/api/notify/feed` 訊號歷史、測試通知。詳見「訊號通知中心」節 |
| `trade.js` | ~300 | **Binance 永續交易面板**（手動下單/持倉/平倉/撤單 + 自動交易設定）：後端未設交易金鑰時入口自動隱藏；testnet/實盤徽章；交易口令存 localStorage["tradeKey"]；面板開著時每 5s 刷新持倉。後端見 docs/backend.md「Binance 永續交易」節 |
| `account.js` | ~197 | 帳號系統（登入/登出、雲端同步 _acctTouch）+ landing 帳號鎖（`_initLandingLock`） |
| `backtest.js` | ~324 | 策略回測 UI（📊 鈕 #backtestBtn）：注入 modal，CRT 訊號模式→/api/crt_backtest；績效卡 + canvas 資金曲線 |
| `main.js` | ~271 | DOMContentLoaded 初始化入口（呼叫所有 init、initBacktest、loadData）、字體大小 IIFE、延遲載入特效、**landing 封面進場/重跳邏輯（`initLanding`）** |

> bundle `names` 順序（main.py）：`config, utils, charts, draw, colors, ticker, winrate, render, realtime, replay, ui, ai_research, signal_info, account, notify, trade, backtest, main`。
> **已移除功能**：ICT 工具（FVG/BOS/CHoCH/Order Block/2022 模型）與 SnR 支撐壓力曾加入後又於 commit f1d0f25 整組移除（視覺太雜），現已無相關程式碼。

**B. 動態載入檔（不在 bundle，由 `main.js` 閒置後注入 `<script async=false>`，版號走 `_asset_ver` 的 mtime）**
| 檔案 | 行數 | 內容 |
|------|------|------|
| `effects.js` | ~702 | initClickSparks、initPeekBear、initTickerKeyNav、initButtonRipple、SFX 音效引擎、initFxPanel（背景音樂已移除） |
| `weather.js` | ~2000 | **天氣/天文背景動畫 Canvas**（2026-06 從 effects.js 拆出）：initWeatherBg 單一 IIFE，含各天氣繪製、天然災害、極光/晚霞/流星雨。完全自足、不引用 effects 全域。**2026-06 改 CSS3D 分層**：`#weatherStage`(perspective:1200) 內 6 層 canvas（sky -1600/astro -1400/far -900/mid -450/near -150/fore 0，手機 4 層）依 translateZ 排景深，相機驅 perspective-origin → GPU 真透視視差，閒置 3s 自動運鏡（李薩茹）；太陽/月亮/行星/星空在 astro 深景層（全解析不糊、前方雲雨真遮擋）；16 種天氣有天色底漸層（`_SKY_BD`，sky 層）。一般層解析度縮 1/s、基準變換烤進 ctx（繪製仍用螢幕座標、**勿對層 ctx 用絕對 setTransform**）。**透景**：非 off 天氣掛 `html.sky-show` → charts-container 透明 + mainPane 中央色帶 74%（colors.js color-mix；sky-night 52%）→ 天氣從 K 線後方透出；舞台 opacity 四態 .28(off)/.45(sky-show)/.6(sky-night)/.9(landing) 掛 `#weatherStage`。規格/分層原則見 [docs/weather-3d-spec.md](weather-3d-spec.md) |

> **原單體 `app.js` 早已拆分為多個模組並刪除（不復存在）。新增功能請編輯對應的模組檔案。**
> **拆檔注意**：bundle 檔拆完要更新 `names`；動態檔（effects/weather）拆完要更新 `main.js` 的 `_loadFx` 與 `main.py` 的 `_asset_ver`。`effects.js` / `weather.js` 為 classic script（非 module），頂層 `const`/`let` 走「全域語彙環境」跨檔共享，故拆檔後仍可互相引用（被引用者需先載入）。

## 前端圖表標記視窗化（效能，`render.js` / `charts.js`）
- 小時/4H 背景載入上千根 → CRT+KDJ叉+共振+多空訊號可達**數千標記**（4h 滑到底 ~8500），全丟 `setMarkers` 會讓每次平移/縮放重繪全部 → 卡。
- `_applyMainMarkers` 只渲染「**可見範圍 ±一屏**」（`_windowMarkers` 用 `getVisibleRange` 過濾）；平移/縮放時 `_scheduleMarkerRewindow`（debounce 100ms）重算（掛在 `syncTimeScales` 的範圍變化）。
- 安全網：標記 <400 個或取不到可見範圍 → 照舊全顯示（短範圍不受影響、無功能損失）。

## 星號按鈕
- **頂部工具列**：`#watchlistStarBtn`，class `starred` 控制填滿，JS 用 `classList.toggle("starred", inWl)` 而非 `textContent`
- **行情列表（合約/台股）**：使用 `_STAR_SVG` 常數注入相同 SVG，`tk-star.active` CSS 控制填滿效果

---

## 版面配置

### 頂部工具列（topbar）結構
```
[左：Logo + 標的選擇] [勝率欄 flex:1 撐滿] [TF按鈕] [icon 按鈕]
```
- `.topbar` 用 `display: flex; justify-content: flex-start`
- `.topbar-left` `flex: 0 0 auto`（不主動 grow，保護內容空間）
- `.tb-winrate` `flex: 1 1 auto`（佔滿可用空間），內部三段式（見 [docs/crt-winrate.md](crt-winrate.md) 的「勝率顯示欄」章節）
- `.topbar-tf` 與 `.topbar-right` `flex-shrink: 0`（固定不縮）
- 注：舊版用 `position:absolute; left:50%` 居中，但會擋到 TF 按鈕，改為 flex 佈局後解決
- 手機 `@media (max-width:1180px), (hover:none) and (pointer:coarse)`：`.tb-winrate { display:none }`
- **手機/桌面斷點（2026-06 起全站統一）**：UI 只分兩款——手機款＝寬 ≤1180px（涵蓋手機＋所有 iPad＋桌機縮窄視窗）或觸控無 hover 裝置（補 12.9" iPad 橫向 1366px）；JS 端用 `isMobileUI()`（utils.js，全站唯一準則），CSS 端所有手機斷點同步用上述雙條件。769~1100 平板專屬區塊已移除。
- TF 按鈕（`.topbar-tf`）在 HTML 中排在 winrate 之後，視覺上靠右

### 主圖背景漸層（`_applyChartBgGradient`）
使用者可在主圖設定（齒輪 →「主圖背景」色點）自選顏色，**只套到 `#mainPane`**，並在上下邊緣自動漸層至系統背景 `var(--bg)`，視覺上像浮在系統色之上的有色面板。

- **helper**：`_applyChartBgGradient(color)` 在 [draw.js](../frontend/static/js/draw.js)，緊接 `applyAllColors` 之前
- **CSS 漸層**：`linear-gradient(to bottom, var(--bg) 0%, ${color} 15%, ${color} 85%, var(--bg) 100%)`
  - 中央 70% 是實色、上下各 15% 漸層；可依視覺需求調整 stop（更柔和 → 拉到 40%/60%；只在底部淡出 → 0% 改成 user color）
- **呼叫點**：
  - `applyAllColors()`（初始化 / 切換 perf-mode 時）
  - 主圖設定 picker 的 `onColor`（[ui.js:379-384](../frontend/static/js/ui.js#L379-L384)）
- **重要：不再改 body / .charts-container 背景**——原本舊版會把整頁 body 染色，造成「主圖背景」名實不符。改版後 body 與 charts-container 維持 CSS 預設 `var(--bg)`，名稱才對應行為
- **perf-mode 跳過**：`pane.style.background = ""` 清空，讓浮水印（z-index:-1）能透過 mainPane 顯示。perf-mode 本來就鎖色票，不需要這個漸層

### chartBg 預設值
- `config.js` 預設 `C.chartBg = "#131722"`（深藍）。第一次載入時主圖會是深藍漸層，使用者可改成系統色 `#170F0C`（暖褐底）或其他偏好色
- 存於 `localStorage.chartColors.chartBg`，由 `savePrefs()` 持久化

---

## 訊號通知中心（`notify.js` + 後端 Web Push）
聊天室式的 CRT 訊號通知中心，掛在手機底部分頁；支援瀏覽器/PWA Web Push（多使用者）。後端細節（VAPID、`notify_monitor` 背景掃描、資料表）見 [docs/backend.md](backend.md) 的「Web Push 訊號通知」節。

- **訂閱**：`/api/notify/vapid_public` 取 applicationServerKey → `serviceWorker` `pushManager.subscribe` → `POST /api/notify/subscribe`（帶 endpoint + 帳號名 + 偏好）。`/api/notify/status` 查是否啟用。
- **偏好帳號級同步**：監控時框（預設 1h/4h/1d，已開放 5m）、要不要收「止盈達成」通知等，存後端帳號（隨帳戶跨裝置同步），不只存 localStorage。
- **訊號歷史 feed**：`GET /api/notify/feed?name=&limit=` 回最近通知（entry 進場 / tp 止盈達成），通知中心分頁以聊天室氣泡呈現（含小啊頭像）。**測試通知**（`/api/notify/test`）也會寫入 feed，當作擬真範例（多行：訊號／盈虧比／進場→目標/停損·時間）。
- **未讀紅點**：`notifyFeedSeen` 記最後已讀時間戳。⚠️ 注意此值**高頻寫入**曾觸發帳號整包覆蓋、造成自選跨裝置不同步（commit e00d9ae 已修）——改動已讀邏輯時別讓它連帶把整個帳號 payload 寫回雲端。

## 首頁封面（landing，`main.js` `initLanding` + `account.js`）
進站先顯示城堡門封面（`#landingScreen`），點「開始」開門進場（zoom + 暖光動畫），未登入則先彈帳號鎖（`landingAcct`）。

- **狀態類別**（掛在 `<html>`）：`landing-active`（封面中，露出天氣背景、隱藏圖表 UI）、`landing-skip`（同 session reload 已看過→head script 直接跳過）、`landing-entering`/`landing-locking`/`landing-hide`（動畫過場）。
- **跳過記錄**：`sessionStorage.landingDismissedAt`（**session 級**，非 localStorage→每次新開分頁會再看到封面；同 session reload 才跳過，並排程 24h 後重跳 `armReshow`）。
- **帳號鎖**：`account.js` `_initLandingLock` 綁定 `landingAcctInput/Btn`；解鎖後呼叫 `window._landingEnter()` 接續開門。登出 → `window._landingShow()` 跳回封面。
- 封面圖：`frontend/static/img/landing-castle-gate.png`（國名門上框位置、手機時間軸等微調散見近期 commit）。
