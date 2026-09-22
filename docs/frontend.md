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
| `winrate.js` | ~870 | `_wrCache`、fetchWinRate（網路/快取命中兩條路重繪同一組圖層）、升階差量、跳過不顯示的圖層、FVG 各標記層 render、加速器預熱、本機快照（2026-09-17 勝率欄相關的填值/hover 勝率/盈虧比盒/止損緩衝已刪） |
| `footprint.js` | ~200 | **Footprint 足跡圖**（2026-07-17）：`toggleFootprint`/`_fpFetch`/`_makeFootprintPrimitive`。打 `/api/footprint`，primitive 畫每根棒各價位買賣量（左紅賣/右綠買、金框 POC、棒底 Δ+總量）。僅 crypto、tf∈1m~1h（逐筆精確、漸進補齊：`pending_min>0` 時 5s 快輪詢 `_fpFastT`＋右上角顯示「剩 N 分鐘」）＋4h/1d（`kagg` 1m聚合）；開關=主圖右上 #footprintBtn（chart-order-btn 同款、.fp-btn right:166，crypto 才顯示）預設關；barSpacing<14 只顯提示、≥52 才畫數字；抓失敗不記 `_fpKey`→draw() 5s 退避自癒（`_fpNextTryTs`）；primitive 於 `charts.js createCandleSeries()` 掛載 |
| `orderbook.js` | ~200 | **掛單牆 Order Book Wall**（2026-07-17）：`toggleOrderbook`/`_obFetch`/`_makeOrderbookPrimitive`。打 `/api/orderbook`（僅 crypto 即時），primitive 畫右緣掛單牆橫條（綠買/紅賣、長∝金額）＋牆消失事件標「✓吃掉/⚠撤走」（假單判定）＋左上掛單買賣比；2.5s 輪詢；開關=右上 `#orderbookBtn`（.ob-btn right:246）。足跡另有失衡標示 `_FP_IMB=2`（買/賣 ≥2倍高亮該格）在 footprint.js |
| `render.js` | ~582 | loadData、_applyPriceFormat、renderAll、renderCandles/BB/CRT/KDJCross/Resonance/Volume/KDJ/RSI/MACD、_bgApplyChunk、_bgScheduleIndicators、_bgLoadOlderBars |
| `realtime.js` | ~317 | startRealtime、stopRealtime、fetchLatest（含切標的丟棄守衛）、_resetSymbolBarQuote、updateAllLegends、onXxxCrosshair、updateSymbolBar |
| `replay.js` | ~459 | replayData 狀態、_rpCal 日曆 IIFE、enterReplay/exitReplay、replayPlay/Step、bindReplayBar |
| `ui.js` | ~947 | bindEvents、updateMarketUI、bindPaneDividers、bindIndicatorPanel、bindLegendColors、bindLegendToggles、bindSystemColors、手機底部分頁切換（淡入淡出） |
| `ai_research.js` | ~233 | AI 研究面板 |
| `notify.js` | ~393 | **訊號通知中心**（聊天室式底部分頁）+ Web Push 訂閱（VAPID）：偏好（監控時框/通知事件）帳號級同步、`/api/notify/feed` 訊號歷史、測試通知。詳見「訊號通知中心」節 |
| `trade.js` | ~300 | **Binance 永續交易面板**（手動下單/持倉/平倉/撤單 + 自動交易設定）：後端未設交易金鑰時入口自動隱藏；testnet/實盤徽章；交易口令存 localStorage["tradeKey"]；面板開著時每 5s 刷新持倉。後端見 docs/backend.md「Binance 永續交易」節 |
| `account.js` | ~197 | 帳號系統（登入/登出、雲端同步 _acctTouch）+ landing 帳號鎖（`_initLandingLock`） |
| `backtest.js` | ~324 | 策略回測 UI（📊 鈕 #backtestBtn）：注入 modal，CRT 訊號模式→/api/crt_backtest；績效卡 + canvas 資金曲線 |
| `main.js` | ~271 | DOMContentLoaded 初始化入口（呼叫所有 init、initBacktest、loadData）、字體大小 IIFE、延遲載入特效、**landing 封面進場/重跳邏輯（`initLanding`）** |

> bundle `names` 順序（main.py `_build_js_bundle`）：`config, utils, charts, colors, ticker, winrate, footprint, orderbook, htffvg, econ, render, realtime, replay, ui, account, hotkeys, main`；其餘（draw/trade/notify/weather/effects…）走 `_FX_DEFER` 延遲載入。
> **已移除功能**：ICT 工具（FVG/BOS/CHoCH/Order Block/2022 模型）與 SnR 支撐壓力曾加入後又於 commit f1d0f25 整組移除（視覺太雜），現已無相關程式碼。

**B. 動態載入檔（不在 bundle，由 `main.js` 閒置後注入 `<script async=false>`，版號走 `_asset_ver` 的 mtime）**
| 檔案 | 行數 | 內容 |
|------|------|------|
| `effects.js` | ~702 | initClickSparks、initPeekBear、initTickerKeyNav、initButtonRipple、SFX 音效引擎、initFxPanel（背景音樂已移除） |
| `weather.js` | ~2000 | **天氣/天文背景動畫 Canvas**（2026-06 從 effects.js 拆出）：initWeatherBg 單一 IIFE，含各天氣繪製、天然災害、極光/晚霞/流星雨。完全自足、不引用 effects 全域。**2026-06 改 CSS3D 分層**：`#weatherStage`(perspective:1200) 內 6 層 canvas（sky -1600/astro -1400/far -900/mid -450/near -150/fore 0，手機 4 層）依 translateZ 排景深，相機驅 perspective-origin → GPU 真透視視差，閒置 3s 自動運鏡（李薩茹）；太陽/月亮/行星/星空在 astro 深景層（全解析不糊、前方雲雨真遮擋）；16 種天氣有天色底漸層（`_SKY_BD`，sky 層）。一般層解析度縮 1/s、基準變換烤進 ctx（繪製仍用螢幕座標、**勿對層 ctx 用絕對 setTransform**）。**透景**：非 off 天氣掛 `html.sky-show` → charts-container 透明 + mainPane 中央色帶 74%（colors.js color-mix；sky-night 52%）→ 天氣從 K 線後方透出；舞台 opacity 四態 .28(off)/.45(sky-show)/.6(sky-night)/.9(landing) 掛 `#weatherStage`。規格/分層原則見 [docs/weather-3d-spec.md](weather-3d-spec.md) |

> **原單體 `app.js` 早已拆分為多個模組並刪除（不復存在）。新增功能請編輯對應的模組檔案。**
> **拆檔注意**：bundle 檔拆完要更新 `names`；動態檔（effects/weather）拆完要更新 `main.js` 的 `_loadFx` 與 `main.py` 的 `_asset_ver`。`effects.js` / `weather.js` 為 classic script（非 module），頂層 `const`/`let` 走「全域語彙環境」跨檔共享，故拆檔後仍可互相引用（被引用者需先載入）。

## 快捷繪圖列可自選工具（`ui.js`，2026-09-19）

上方那排快捷繪圖（`#symQuickDraw`）的工具按鈕改成**依 `localStorage.qdTools` 動態產生**，
使用者按列尾的 `⋯`（`#sqdEdit`）開面板自己挑：加入／移除／上下排序／還原預設，改完立刻套用。

- **圖示從左側工具島（`#drawToolbar`）同 `data-tool` 的按鈕複製**，不另外寫一份 SVG
  —— 寫兩份的話改了圖示只會改到一邊。可用工具清單也以工具島為準（那裡就是完整的 18 個）。
- ⚠ **`[data-tool]` 的點擊改成事件委派**：按鈕現在是動態產生的，開機時逐顆綁定的話，
  之後新增的那幾顆全都沒反應**而且不會報錯**。
- ⚠ 動態容器 `#sqdTools` 必須 `display: contents`：它是 `<span>`（inline），
  裡面的按鈕會被當文字折行 —— 實測整排從一列變成 **164×194 的六列方塊**。
- ⚠ 面板的工具名稱只取 `：`／`（` 之前那段：`title` 後面接的是用法說明，整句拿來當名稱會把面板撐爆。
- ⚠ 符號列是 `overflow:hidden` → 多一顆按鈕就可能被**安靜切掉**；1280~1920 六種寬度都量過
  （沒折行、沒被切、編輯鈕 `elementFromPoint` 命中）。
- `qdTools` 不在 `_ACCT_SKIP` → 跟著帳號快照跨裝置，且列在 `_LIVE`：拉下來時呼叫
  `window._qdRender()` **當場重畫**，不必為了這個整頁重載。

## 快速提示（`utils.js` `.ui-tip`，2026-09-21）

原生 `title` 的顯示延遲是瀏覽器寫死的（約 1~2 秒），CSS/HTML 改不了 → 自己畫一個。
延遲 **800ms**（使用者定）：260ms 實測「滑過去就會閃一下」→ 使用者回「太快了」→ 550 → 最後定 800。

- **事件委派 + 單一節點**：光 index.html 就有 87 個 `title`，還有一堆是 JS 動態設的 →
  逐一綁定不可行，也接不到後來才出現的元素。
- ⚠ 顯示期間必須把 `title` 拿掉，否則原生提示會在 1.5 秒後**疊上來變成兩個**。
  但 title 常被 JS 更新（連線四格每 2 秒重寫）→ 兩個保險：①顯示中定期回讀，變了就跟著更新
  ②離開時若 JS 已重新設過 title 就不要用舊值蓋掉。離開一定要把 title 還回去（無障礙）。
- ⚠ 觸控裝置整段跳過（`hover: none`）：沒有 hover，長按本來就會叫出系統選單。
- ⚠ **按著滑鼠的期間一律不出提示**（2026-09-22 使用者：「我拖移快捷時 會跳出提示文字 多餘了」）。
  拖曳中冒出說明沒有意義，而且正擋在你要放的位置上。
  拖快捷繪圖列時那排會被搬到 body（見 memory `project_reparent-releases-pointer-capture`）
  → 游標下的元素換了 → 重新 `mouseover` → 又開始算 800ms；只靠「mousedown 時 hide」擋不住，
  因為問題出在**之後**才重新開始計時。
  ★ 用 `e.buttons` 判斷當下有沒有按著，**不要自己維護 dragging 旗標** —— 放開時若剛好沒收到
  mouseup（拖到視窗外放手、被別人 stopPropagation），旗標會永遠卡在 true ＝ 提示從此再也不出來，
  比原本的問題更糟。`e.buttons` 每個事件都自帶、不會卡住。
- ★ 游標座標用**短命監聽**取得：`mousemove` 只在「等待 800ms」那段掛在 `document` 上，
  一顯示或一離開就拿掉（CDP `getEventListeners` 實測：閒置 0 個／等待中 1 個／顯示中 0 個／移開後 0 個）。
  主圖拖曳每秒觸發上百次 `mousemove`，常駐一個 handler 等於長在全站最熱的路徑上。
  代價是**顯示後不跟著游標跑** —— 原生提示也不跟，行為一致。
- ⚠ 800ms 是很長的窗口，**元素可能在這中間被換掉**（行情列每秒重繪）→ 計時器到點要先檢查
  `host.isConnected`，否則會對著一個已經離開 DOM 的元素定位，提示浮在無關的地方。

## 連線四格 ＋ 即時綠點＝一個符號（`#netSig`，2026-09-22 合併）

狀態列順序：`[● ▁▃▅▇] → K 棒倒數 → 已儲存到雲端 → 訊號失敗提示`。
一個符號、兩種功能：**綠點**＝資料有沒有在進來（收到新報價就閃）／**四格**＝連線品質（往返時間）。
綠點寬度與格子同為 3px、貼齊同一條基線、間距同為 2px → 讀起來是連貫的一條漸高斜坡。

- ⚠⚠ 綠點成為 `.net-sig` 的子元素後，**有兩個地方會被「多出來的第 0 個子元素」弄錯**，
  兩個都不報錯、只是畫面怪怪的：
  1. CSS 格子高度：`.net-sig i:nth-child(N)` → 必須改 **`nth-of-type(N)`**，
     否則四格高度整組位移一格（第 1 格變 8px、第 4 格沒有規則）。
  2. JS 點亮格數（utils.js `_paintSig`）：`[...el.children]` → 必須改
     **`el.querySelectorAll("i")`**，否則綠點被當成第 0 格 → **q=4 只亮 3 格**，
     而且綠點會被加上 `.on`。★ 這個是看放大截圖才發現的（數字判準全綠）。
- ⚠ 「隱藏時仍佔位」的選擇器要跟著搬：`.net-sig > .realtime-dot.hidden`
  （原本是 `.tb-status > .realtime-dot.hidden`）。不改的話綠點一消失整組符號就縮、旁邊全部左移。

## 十字線的時間標籤（`.crosshair-time-label`，charts.js）

盤中時框顯示 **`MM-DD HH:mm`**，日線以上只顯示 `MM-DD`（沒有時分可看）。

- ⚠⚠ 判準是「**不是**日線以上」（`_TF_DAILY_UP = {1d, 1w, 1M}`），**不是**「有沒有列在盤中清單裡」。
  舊版寫死 `["4h","2h","1h","30m","15m","5m"]` —— **漏了 `1m`**（還留著早就移除的 2h/30m）→
  1m 掉到「只顯示日期」那條，hover 一根只看得到 `09-22`，完全看不出幾點幾分
  （2026-09-22 使用者：「1m下方對其時間都是寫9/22 我看不出幾分」）。
  ★ 同 claude.md 一直在講的「對照表漏列 → 靜默退回」。**反過來列**之後，漏列的預設方向
  就變成安全的那邊：新增任何盤中時框自動有時分，只有明確列為日線以上的才不顯示。
- ⚠ 這顆標籤是 **charts.js 自繪的 DOM**，不是 LWC 原生的。
  LWC 這版**不吃 `localization.timeFormatter`**（實測掛上去 **0 次呼叫**），
  `timeScale.tickMarkFormatter` 只管刻度、管不到這顆 —— 別再去試那個選項。
- ⚠ `time` 是圖表時間（`toTime()` 產出、已 +8 小時）→ 取時分必須用 **UTC getter**。

## 最新 K 棒倒數（`#barCountdown`，2026-09-22）

狀態列順序：`綠點 → 連線四格 → **K 棒倒數** → 已儲存到雲端 → 訊號失敗提示`。
「最新那根還有多久收」，依**目前時間框架**算（5m 就是 5 分鐘的倒數）。

- ⚠⚠ **時間一律走 `_barOpenMs()`（realtime.js）**，兩個看起來可用的都是錯的：
  - `Date.parse(raw)` —— 後端送的是 **naive ISO**（`"2026-09-21T00:00:00"`，沒有時區，值代表 UTC），
    JS 規格把它當成**瀏覽器本地時間** → 台灣早 8 小時，**每個時區錯的量還不一樣**。
  - `toTime(raw)` —— 那是**圖表時間**，刻意 +8 小時給 LWC 用，比真值晚 8 小時。
  ★ 這個錯誤原本也躺在 `_chartStaleCheck` 裡（休眠醒來會誤報「圖表已中斷」），
    是被 K 棒倒數量出 `-8929 秒`＝整整 8 小時才發現的。**兩處現在共用同一支 `_barOpenMs`。**
- 算出來不在 `0 ~ 一個時框` 之間就**不顯示**（休市／資料中斷）：寧可空著，也不要端出負數或假倒數 ——
  那種情況該說話的是 `#chartStale`。
- ⚠ **寬度固定**（使用者：「已儲存到雲端左邊要留白不被倒數影響到位置」）：`tabular-nums`（數字等寬）
  ＋ `min-width: 54px`（空字串與 `23:59:59` 同寬）。實測 7 種長度下 `#acctSyncState` 的 x 都是 516.7。
- ⚠ 日線以上用的是「開盤時間＋一個時框」：加密精確；**股市的日線不等於收盤時刻**（台股 13:30 收，
  但這裡會算到隔天同一時刻）。盤中時框都是準的。

## 上下顛倒的提示（`#invertFrame` / `#invertBadge`，2026-09-22 改設計）

開著時：**整張主圖描一圈琥珀外框** ＋ 左上角小標籤「⇅ 上下顛倒中」附一顆實心「恢復」鈕。

- ★ **「刻意醒目」不可退讓**：倒過來的圖若被當成正常的看，漲跌會整個讀反 —— 所以改設計是
  把提示範圍**放大成整張圖**，不是把標籤縮小變低調。
- 舊版是圖頂正中一顆**實心不透明橘色膠囊**、整顆就是按鈕、顏色寫死 —— 跟全站其他圖上提示
  （`.chart-stale` 半透明色底＋同色細框、`.go-latest` 深色半透明）不同調。
  現在顏色全走 `var(--accent)` ＋ `color-mix`，跟著使用者的配色與極簡模式變。
- ⚠ 外框必須 `pointer-events: none`：`#mainChart` 上有 draw.js 的 capture 階段滑鼠處理，
  外框一旦吃事件，連繪圖都不能用。
- ⚠ 兩個元素（框＋標籤）都要在 `applyChartInvert` 裡一起切，少切一個就會出現
  「有框沒標籤」的半套狀態。
- ★ 兩者都放 **`#mainChart` 裡面**才對得準（放外面要靠 `--legend-h` 推算，手機圖例列較高會錯位）。
  舊註解說「放裡面按鈕會被 draw.js 吃掉」—— 實測**不成立**（同 `#chartStale` 的重整鈕），
  已用真實滑鼠點擊驗過：`elementFromPoint` 命中 `#invertRestore`，點下去真的關掉顛倒。

## 盈虧比盒（`draw.js` `longpos`/`shortpos`，2026-09-21 改版）

**兩次點擊：①進場 ②停損**。停利不用點，自動放在 `RR_DEFAULT`(=2) 倍風險處，之後拖停利再調。

- **方向由停損在哪一邊決定**，不是看按了哪顆工具（`_mkPosDraw`）：停損在進場下方＝做多、
  上方＝做空。按了做多卻把停損點在上面，那實際上是做空的單 —— 照按鈕硬做只會生出
  「做多但停損在上面」的盒子（風險為負、RR 無意義）。
- **拖曳**（離三條線 `_POS_HIT`(8px) 以內才算拉那條線，再遠＝色塊空白處）：
  | 拖哪裡 | 結果 |
  |---|---|
  | **進場線** | 只動進場，**上下停利停損釘住不動** → RR 跟著變。夾在停損與停利之間（留 2% 縫，避免風險＝0 讓 RR 變 ∞） |
  | **色塊空白處** | 整體搬移，三條線一起走、RR 不變 |
  | **停利／停損線** | 只動那一條，其餘不動 |
  ★ 用法：壓力位當停利、支撐位當停損都已經在圖上了 → 滑動進場線看「進場放哪裡划算」。
  ⚠ 整體搬移原本掛在進場線上；搬到「色塊空白處」才空得出進場線來調（也才有地方抓整體，見守門員之二十三①）。
- 盒子中央第二行顯示「報酬 +x.x%　風險 −x.x%」（`_posPctTxt`）。用**百分比**不用點數：
  跨商品才比得出來（BTC 的 500 點跟 2330 的 500 點不是同一回事）。
- ⚠ `drawPreview` 要跟 `_mkPosDraw` 用同一套語意，否則放手後盒子會變形（舊版預覽是鏡射成 1:1）。
- 守門員 `node scripts/check_pos_tool.js`（見 claude.md 守門員之二十三）。

## 數字鍵 1~0 ＝快捷繪圖工具（2026-09-22 改）

原本是切時框，使用者：「用不太到」→ 改成選**快捷繪圖列由左到右第 1~10 顆**（0＝第 10 顆），
按鈕右下角標上對應數字（`.sqd-num`）。時框仍可用 `[` `]` 與左右方向鍵切。

- ★ `window._qdPick(n)`（ui.js）內部走 **`btn.click()`** 重用既有的 `[data-tool]` 事件委派
  → 鍵盤與滑鼠**必然一致**（工具高亮、狀態切換全都同一條路）。
  **別在 hotkeys.js 另外寫一份「設定工具」的邏輯**：兩份一定會分家。
- ⚠ 沒選到（那一格沒工具／`_qdPick` 還沒就緒）就**不要** `preventDefault` —— 讓鍵回到瀏覽器，
  否則會變成「按了沒反應、也沒人處理」。
- ⚠ 標號只標前 10 顆：第 11 顆起沒有鍵可綁，標了卻按不出來會更難用。
- ⚠ `.sqd-num` 走**絕對定位、不佔空間**：符號列那排的高度一動整列就會跳
  （見 memory `project_symbol-bar-blocks`，那排使用者調過很多輪）。實測按鈕仍是 27.72px、列高 28px。

## 鍵盤快捷鍵（`hotkeys.js`，自訂於 2026-09-19）

派送是**表格驅動**：`ACTIONS`（id／預設鍵／說明）＋ 使用者覆寫 `localStorage.hotkeyMap`。
可自訂的有 8 個：搜尋 `/`、重播 `R`、上下顛倒 `A`、復原 `V`、圖層 `Z/X/C`、說明 `?`。

- **存的是實體鍵代號**（`_physKey()` 產出的小寫字母／符號），不是 `e.key`：
  否則中文輸入法下綁出來的會是「ㄈ」這種字元，換回英數輸入法就失效。
- **可指定的鍵只有 a~z 與 `/` `?`**：數字 0-9 是切時框、`[` `]` 是上/下一個時框、
  **`m` 是 ui.js 的磁吸**、方向鍵/Esc/Shift 各有固定用途 → `RESERVED` 擋掉並說明原因。
  衝突時也擋下、指出被誰用了。
  ⚠ ★ **新增任何全域單鍵時，`RESERVED` 要一起加**：漏掉的話使用者可以把動作綁到那顆鍵，
  按一下會**同時**觸發兩件事，而且兩邊都「正常運作」、零錯誤（`m` 就是這樣漏掉過一次）。
- **顯示清單由綁定即時產生**（`_rows()`），不另外寫死一份 —— 兩份會分家（改了鍵、表上還是舊的）。
  不可改的那些集中在 `FIXED`，UI 直接列；⚠ **不要讓 UI 用字串規則去挑固定列**
  （第一版那樣寫，「↑ ↓ / 空白」因為含 `/` 被誤濾掉整列消失）。
- 編輯 UI 在「更新資訊 → 快捷鍵」分頁（`announce.js` `_keysHtml`/`_wireKeys`），
  只透過 `window._HOTKEY_EDIT / _hkBind / _hkResetAll / _hkDisp / _hkPhysKey / _HOTKEY_FIXED` 溝通，
  不自己讀 localStorage（綁定規則只能有一份）。
  ⚠ 錄製時的 keydown 必須走 **capture 階段並 stopPropagation**：hotkeys.js 對「說明鍵」的處理
  排在「有彈窗就讓路」之前 → 不攔的話，按到說明鍵會在錄製中把整個面板關掉。
- `hotkeyMap` 不在 `_ACCT_SKIP` → 跟著帳號快照跨裝置，且列在 `_LIVE`：拉下來時呼叫
  `window._hkReload()` 重讀 `_override` 並刷新顯示清單 —— ⚠ 不重讀的話，**localStorage 已是新的、
  派送用的仍是開機時那份**，畫面顯示新鍵但按了沒反應。

## 前端圖表標記視窗化（效能，`render.js` / `charts.js`）
- 小時/4H 背景載入上千根 → CRT+KDJ叉+共振+多空訊號可達**數千標記**（4h 滑到底 ~8500），全丟 `setMarkers` 會讓每次平移/縮放重繪全部 → 卡。
- `_applyMainMarkers` 只渲染「**可見範圍 ±一屏**」（`_windowMarkers` 用 `getVisibleRange` 過濾）；平移/縮放時 `_scheduleMarkerRewindow`（debounce 100ms）重算（掛在 `syncTimeScales` 的範圍變化）。
- 安全網：標記 <400 個或取不到可見範圍 → 照舊全顯示（短範圍不受影響、無功能損失）。

## 主圖上下顛倒（多空翻轉看法，`charts.js` `toggleChartInvert`，2026-09-11）
- 使用者的「多空翻轉看法／K 棒翻轉」＝**整張圖上下倒過來、上漲顯示成下跌**（不是反轉型態訊號）。
- 做法：`mainChart.priceScale("right")` 的 `invertScale` ＋ 漲跌色對調。K 棒色唯一出口是 `_candleColorOpts()`（`createCandleSeries`／`applyAllColors` 最後都經 `applyChartType()` 回到它）；量柱色統一走 `_volColor(isUp)`（render/realtime/replay 共 5 處）。
- 入口：主圖圖例列 ⚙ 左邊的 ⇅ 鈕 `#invertBtn`（使用者要求從 ⚙ 面板移出來；開著時亮橘色）、Alt/Option+I（看 `e.code`；焦點在勾選框上也要能用）、手機「設定」分頁 `#mSetInvert`（手機 ⇅ 跟 ⚙ 一起藏）。顛倒中主圖上方掛 `#invertBadge`，點了恢復。**刻意不存檔**（忘了關會把倒過來的圖當真）。
- ⚠ `#invertBtn` 不可用 `.ind-gear-btn` class：那個在極簡模式會被藏（它管配色），⇅ 不是配色。
- ⚠ 圖例列最後的 `.pane-btns` 是 sticky 貼右緣＋≤1320px 間距 8→4：多一顆鈕就會在窄的桌面款（1181px＋BB 開）把 ⚙ 擠到隱藏捲軸外。
- ⚠ LWC 4.2 原生標記的 aboveBar/belowBar 不看座標是否反轉 → 顛倒時 `_applyMainMarkersNow` 把原生標記清掉、改放 `_invNativeMarkers` 由策略標記 primitive 代畫；primitive 用 `drawUp = above !== inv` 決定畫在錨點上方或下方。
- ⚠ **LWC 自己的影線在反轉座標下會穿過實體**（2026-09-12 使用者：「空心K中間有直線穿過」）：renderer 畫影線是 `fillRect(x, highY, w, 實體上緣−highY)`＋`fillRect(x, 實體下緣+1, w, lowY−實體下緣)`，反轉後兩段高度變負 → 往回畫穿過實體（實心 K 被蓋住看不出來）。顛倒時 `_candleColorOpts` 關掉 `wickVisible`、改由 `_makeInvWickPrimitive` 畫（寬度公式/像素對齊照抄 LWC，只畫實體外兩段；用 `dataByIndex` 取實際序列 → 重播安全）。⚠ 它必須 zOrder normal 且**最後才掛**：用 bottom 時 FVG 8% 填色會蓋在影線上（61 段有 17 段被染色）。驗法＝讀 `#mainChart table canvas`（不是最大那張，那是 draw.js 覆蓋層）實體中央像素。
- ⚠ 任何「以為 yHigh < yLow」的繪圖在顛倒時會出錯：`_drawSessionWatermark` 原本 `boxH = yL - yH; if (!(boxH > 0)) return` → 盤名浮水印整個消失，已改成先換成畫面上/下緣。新寫的圖層一律用 `Math.min/abs`。
- 同批修：`renderVolume(ohlcvData)` 在重播中會畫出游標之後的量柱（天氣「無↔有」切換、換色盤、主圖設定量柱都走這條）→ 入口改成重播中自動切到游標為止。

## 星號按鈕
- **頂部工具列**：`#watchlistStarBtn`，class `starred` 控制填滿，JS 用 `classList.toggle("starred", inWl)` 而非 `textContent`
- **行情列表（合約/台股）**：使用 `_STAR_SVG` 常數注入相同 SVG，`tk-star.active` CSS 控制填滿效果

---

## 版面配置

### 頂部工具列（topbar）結構
```
[左：Logo + 標的選擇 + 同步狀態/訊號計算失敗]   [TF 按鈕（能放下就置中）]   [icon 按鈕]
```
- 上方勝率欄（`.tb-winrate`）2026-09-17 整條移除 → 上方只剩一列；同步狀態 `#acctSyncState` 與
  「訊號計算失敗」`#wrFailNote` 搬到左側 `.tb-status`。
- TF 置中改成**實際量**（ui.js `_tbFitTf`）：置中後左右都不壓到才加 `.tf-centered`，否則退回一般排列；
  盯 resize／左側與 TF 尺寸／右側按鈕增減。原本用 CSS 寫死 `min-width:1500px`，1500~1600 寬會壓到右側按鈕。
- 守門員：`check_topbar_reachable.js`（每顆按鈕點得到）、`check_topbar_rows.js`（各寬度維持單列）。
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
