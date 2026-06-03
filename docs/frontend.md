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
| `backtest.js` | ~230 | 策略回測 UI（📊 鈕 #backtestBtn）：注入 modal，CRT 訊號模式→/api/crt_backtest、通用技術模式→/api/backtest；績效卡 + canvas 資金曲線 |
| `main.js` | ~252 | DOMContentLoaded 初始化入口（呼叫所有 init、initBacktest、loadData）、字體大小 IIFE、延遲載入特效 |

**B. 動態載入檔（不在 bundle，由 `main.js` 閒置後注入 `<script async=false>`，版號走 `_asset_ver` 的 mtime）**
| 檔案 | 行數 | 內容 |
|------|------|------|
| `effects.js` | ~702 | initClickSparks、initPeekBear、initTickerKeyNav、initButtonRipple、SFX 音效引擎、initFxPanel（背景音樂已移除） |
| `weather.js` | ~1938 | **天氣/天文背景動畫 Canvas**（2026-06 從 effects.js 拆出）：initWeatherBg 單一 IIFE，含各天氣繪製、天然災害、極光/晚霞/流星雨。完全自足、不引用 effects 全域 |

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
- 手機 `@media (max-width:768px)`：`.tb-winrate { display:none }`
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
