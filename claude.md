# trading Claude Instructions

## 專案概覽
- `trading` 是一個回測系統，包含 FastAPI 後端、靜態前端、資料模組與策略引擎。
- 後端位於 `backend/`，前端位於 `frontend/`。
- `start.sh` 安裝依賴並啟動 `backend/main.py`。
- 部署於 Railway，推送 `main` branch 自動觸發部署（GitHub repo: `joanzzgo-jpg/trading-backtest`）。

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

## 音效與背景音樂（app.js）
- **SFX**：`SFX` 物件含 `click / load / success / error / tick / boop / switch_` 七種 Web Audio 音效
- **音樂面板**：`initMusicPlayer()` IIFE，右上角 `#musicToggleBtn` 開關
- **主題**（`THEMES`）：`lofi / bull / bear / scalp / ghibli / merry / inochi / totoro / mononoke / sanpo / auto`
  - `merry` = 人生のメリーゴーランド（100 BPM 圓舞曲）
  - `inochi` = いのちの名前（58 BPM 溫柔）
  - `totoro` = となりのトトロ（88 BPM 歡快）
  - `mononoke` = もののけ姫（78 BPM 史詩）
  - `sanpo` = さんぽ（132 BPM 進行曲）
  - `auto` = 依 `symChg` 漲跌幅每 5 秒自動切換主題

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
- `frontend/static/js/app.js` - 主 JS（圖表邏輯、重播、點擊特效、偷看熊初始化）
- `frontend/static/css/style.css` - 樣式（含游標、粒子特效、偷看熊動畫）
- `frontend/static/img/` - 所有圖片（見上方圖片資源表格）

## 重要技術細節
- **時間戳**：所有圖表時間戳 +8 小時（Taiwan Time），`toTime()` 函數處理
- **台股 yfinance 時區**：`fetch_tw_intraday_yf()` 中，naive timestamp 一律先 `tz_localize("Asia/Taipei")` 再 `tz_convert("UTC")`，否則小時線會位移 +8h
- **max_candles**：按時間框架動態計算，避免長日期範圍資料截斷（4h 上限 8000 根）
- **即時更新**：`fetchLatest()` 有間距保護（>5 根週期差距不插入），防止歷史圖表被今日資料污染
- **Ticker 刷新間隔**：`startTickerRefresh()` 中 `setInterval(fetchTickers, 2000)` 固定 **2 秒**，不可調整（行情即時性需求），禁止以「減輕伺服器負擔」為由更改
- **重播日期選擇**：`<input type="date">` 讓使用者跳至指定日期
- **價格軸精度**：`_applyPriceFormat(data)` 依最後收盤價動態設定 `priceFormat.precision`（2–8 位），套用於 candleSeries + BB 三線

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
