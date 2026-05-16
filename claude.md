# trading Claude Instructions

## 語言規範
- **所有回覆請使用繁體中文**，包含說明、建議、程式碼注釋（非英文關鍵字）。

## 專案概覽
- `trading` 是一個回測系統，包含 FastAPI 後端、靜態前端、資料模組與策略引擎。
- 後端位於 `backend/`，前端位於 `frontend/`。
- `start.sh` 安裝依賴並啟動 `backend/main.py`。
- 部署於 Railway，推送 `main` branch 自動觸發部署（GitHub repo: `joanzzgo-jpg/trading-backtest`）。
- Railway 用 `Procfile`／`railway.toml` 直接跑 `cd backend && uvicorn main:app`，**沒有跑 `start.sh`**。前端 JS 打包改由 `backend/main.py` 的 `_build_js_bundle()` 在 import 時自動執行（偵測來源 JS 比 bundle 新就重建）。修改前端 JS 後**不需要**手動跑 `start.sh`。

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

## 音效與背景音樂（`effects.js`）
- **SFX**：`SFX` 物件含 `click / load / success / error / tick / boop / switch_` 七種 Web Audio 音效
- **音樂面板**：`initMusicPlayer()` IIFE，右上角 `#musicToggleBtn` 開關
- **主題**（`THEMES`）：`lofi / bull / bear / scalp / ghibli / merry / inochi / totoro / mononoke / sanpo / auto`
  - `merry` = 人生のメリーゴーランド（100 BPM 圓舞曲）
  - `inochi` = いのちの名前（58 BPM 溫柔）
  - `totoro` = となりのトトロ（88 BPM 歡快）
  - `mononoke` = もののけ姫（78 BPM 史詩）
  - `sanpo` = さんぽ（132 BPM 進行曲）
  - `auto` = 依 `symChg` 漲跌幅每 5 秒自動切換主題

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

#### JS 模組（`frontend/static/js/`，按 `<script>` 載入順序）
| 檔案 | 行數 | 內容 |
|------|------|------|
| `config.js` | ~90 | 全域常數（DEFAULT_COLORS/STYLES）、狀態變數（ohlcvData、currentTF 等） |
| `utils.js` | ~218 | toTime、hexAlpha、偏好設定存取（savePrefs/loadPrefs）、格式化工具（fmt/fmtVol/fmtT）、showToast、showLoading |
| `charts.js` | ~254 | makeBaseOpts、createCandleSeries、applyOhlcvToSeries、updateLatestPriceLine、buildCharts、resizeAll、syncTimeScales |
| `draw.js` | ~1455 | 繪圖工具全部（drawings 狀態、initDrawTools、renderDrawings、drawOne、initColorPicker、_updateStarBtn） |
| `ticker.js` | ~846 | 自選清單（_loadWatchlist/_saveWatchlist/_renderWatchlist）、行情面板（fetchTickers/renderTickers）、標的搜尋（initSymSearch） |
| `winrate.js` | ~154 | `_wrCache`、`fetchWinRate`、`_renderWRSignals`、`_renderWinRate` |
| `render.js` | ~354 | loadData、_applyPriceFormat、renderAll、renderCandles/BB/CRT/KDJCross/Resonance/Volume/KDJ/RSI/MACD、_bgApplyChunk、_bgScheduleIndicators、_bgLoadOlderBars |
| `realtime.js` | ~180 | startRealtime、stopRealtime、fetchLatest、updateAllLegends、onXxxCrosshair、updateSymbolBar |
| `replay.js` | ~450 | replayData 狀態、_rpCal 日曆 IIFE、enterReplay/exitReplay、replayPlay/Step、bindReplayBar |
| `ui.js` | ~771 | bindEvents、updateMarketUI、bindPaneDividers、bindIndicatorPanel、bindLegendColors、bindLegendToggles、bindSystemColors |
| `effects.js` | ~2075 | initClickSparks、initButtonRipple IIFE、SFX 音效引擎、BGM 背景音樂、YouTube 播放器、天氣動畫 Canvas |
| `main.js` | ~32 | DOMContentLoaded 初始化入口（呼叫所有 init 函數、loadData） |

> **原 `app.js` 已拆分為上述 12 個檔案，不再使用。**  
> **新增功能時請編輯對應的模組檔案，不要修改 app.js。**

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

## 已知問題
- **台股月線**：`resample_tw()` 使用 `"MS"`（月初），台股月K應為最後交易日收盤，技術上應改 `"ME"` 但需測試相容性
- **台股 yfinance `dropna` 可能跳空**：`fetch_tw_intraday_yf` 在重新取樣後 dropna 可能刪除假日邊界的 K 棒，造成小時/15 分鐘視圖出現不連續缺口

## 星號按鈕
- **頂部工具列**：`#watchlistStarBtn`，class `starred` 控制填滿，JS 用 `classList.toggle("starred", inWl)` 而非 `textContent`
- **行情列表（合約/台股）**：使用 `_STAR_SVG` 常數注入相同 SVG，`tk-star.active` CSS 控制填滿效果

## CRT 策略自動回測（`/api/crt_winrate`）

### 五種訊號並行計算

> **訊號一（S1/ABC）僅獨立顯示，不計入總勝率合計；`_sufficient` 也不要求 S1 達最低案例數。**

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
- 停損：**B 棒**最高價（做空）/ 最低價（做多）

#### 訊號三（S3）：連續三棒，放寬版（每棒最多 2 個指標）
- **A 棒（i）**：有 resonance，但 CRT 與 KDJ叉 不能同時出現（最多兩個指標）
- **B 棒（i+1）**：同 A 棒規則（有 resonance，最多兩個）
- **C 棒（i+2）**：有 KDJ叉，但 CRT 與 resonance 不能同時出現（最多兩個）
- **排除條件**：C 棒影線觸及布林上/下軌（`high >= bb_upper*0.995` 做空 / `low <= bb_lower*1.005` 做多）→ 跳過
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

#### 訊號六（S6）：CRT 先行二棒版（A=純 CRT，B=KDJ 叉＋共振 同方向）
與 S2 對稱互補——S2 是「共振先行」、S6 是「CRT 結構先行 + 雙重動能/過熱確認」。
- **A 棒（i）**：**只有** CRT（CRT=±1、KDJ叉=0、resonance=0）
- **B 棒（i+1）**：**同時要** KDJ叉 + 共振（同方向），且 B 不能有 CRT
- **排除條件**：B 棒 low(空)/high(多) 碰至 BB 中軌 → 跳過（目標已提前觸及）
- 進場：B 棒下一根（`entry_i = i + 2`）
- 停損：**A/B 兩棒**最高高點（做空）/ 最低低點（做多）
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
```python
# 共用 helper（模組層級）
_ts(row)                                           # pd.Timestamp → isoformat 字串
_scan_outcome(df, entry_i, stop_px, dir)           # 回傳 ('win'/'loss'/None, bar_time/None)

# 回傳結構
{
  "total", "wins", "win_rate",   # S2~S6 合計（S1 不計入）
  "short": {...}, "long": {...}, # S2~S6 空/多合計
  "abc": {"short":{}, "long":{}},# 訊號一（僅顯示）
  "ab":  {"short":{}, "long":{}},# 訊號二
  "s3":  {"short":{}, "long":{}},# 訊號三
  "s4":  {"short":{}, "long":{}},# 訊號四
  "s5":  {"short":{}, "long":{}},# 訊號五
  "s6":  {"short":{}, "long":{}},# 訊號六（CRT 先行版）
  "from_date": "YYYY-MM-DD",     # 回測起始日（最早 K 棒日期）
  "recent": [...],               # 最近30筆（k: "abc"/"ab"/"3"/"4"/"5"/"6"）
  "signals": [{"t","d","k","r","ot"}]  # 所有訊號（含進場時間、方向、種類、結果）
}
# _stats(w, l) → {"total", "wins", "losses", "win_rate"}
```

### 最低案例數保證（S2~S6 各空/多各≥10筆）
- `MIN_CASES = 10`；`_sufficient(r)` 檢查 S2/S3/S4/S5/S6 各空/多共 **10 個**子統計（S1 不在內）
- 若不足，自動加倍 `days` 重新抓資料（上限 `TF_MAX`），直到足夠或抵達上限為止
- cache key：`crt_wr8:market:symbol:exchange:timeframe`（每次訊號邏輯變更時遞增版號）

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
- **結果標記**（`s.r` + `s.ot` 欄位，所有訊號通用）：
  - `s.r = "w"` → 綠色 `#26a69a`，文字 `✓`，位置在目標方向
  - `s.r = "l"` → 紅色 `#ef5350`，文字 `✗`，位置在止損方向
  - 結算棒時間 = `s.ot`；`s.r/s.ot` 為 null 表示末端尚未結算
- 透過 `lastWRSignalMarkers` 合入 `_applyMainMarkers()`；切換標的/時框時清除

### 勝率顯示欄（topbar 正中央，Tech HUD 設計）
- 共 6 組訊號（S1~S6），各有空/多兩行，▼=做空（紅），▲=做多（綠），顯示 `勝率% W/L筆數`
- 元素 ID：`wrAbcS/L`（S1）、`wrAbS/L`（S2）、`wrS3S/L`（S3）、`wrS4S/L`（S4）、`wrS5S/L`（S5）、`wrS6S/L`（S6）
- `wrAll`：**S2~S5** 合計勝率（S1 不計入）；`wrFromDate`：回測起始日（`←YYYY/MM/DD`）；`wrStatus`：「N筆」
- 勝率 ≥60% → 亮綠（`.good`），<45% → 淡紅（`.bad`）
- 圖示顏色：S1=紅●、S2=橘■、S3=紫▲、S4=青綠◆、S5=橘黃★、S6=紫藍◇
- 風格：毛玻璃背景 + 橘色漸層邊框 + SF Mono 字型 + glow 效果（`backdrop-filter: blur(18px)`）；無 CRT 文字標籤

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

---

## 天文計算（`routes/weather.py`）

### `_sun_times_local(lat, lon)` 太陽升落時間
- 使用 **地理位置自然時區**（`round(lon/15)*60` 分鐘）而非伺服器時區
- 台灣（lon≈121.5）→ UTC+8 → tz_off=480 分鐘
- 若用伺服器 `astimezone().utcoffset()`，部署到不同時區後太陽位置會錯

---

## 版面配置

### 頂部工具列（topbar）結構
```
[左：Logo + 標的選擇] [絕對居中：勝率 tb-winrate] [右：TF按鈕 + 圖示按鈕]
```
- `.tb-winrate` 用 `position:absolute; left:50%; transform:translateX(-50%)` 居中
- `.topbar` 需有 `position:relative`
- 手機 `@media (max-width:768px)`：`.tb-winrate { display:none }`
- TF 按鈕（`.topbar-tf`）在 HTML 中排在 winrate 之後，視覺上靠右

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
