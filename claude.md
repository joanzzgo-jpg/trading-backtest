# trading Claude Instructions

## 語言規範
- **所有回覆請使用繁體中文**，包含說明、建議、程式碼注釋（非英文關鍵字）。

## 專案概覽
- `trading` 是回測系統：FastAPI 後端（`backend/`）+ 靜態前端（`frontend/`）+ 資料模組 + 策略引擎。
- 部署於 Railway，推送 `main` branch 自動觸發部署（GitHub repo: `joanzzgo-jpg/trading-backtest`）。
- Railway 用 `Procfile`／`railway.toml` 直接跑 `cd backend && uvicorn main:app`，**沒有跑 `start.sh`**。前端 JS 打包改由 `backend/main.py` 的 `_build_js_bundle()` 在 import 時自動執行（偵測來源 JS 比 bundle 新就重建）→ **修改前端 JS 後不需手動跑 `start.sh`**。

### 快速啟動
```bash
cd /Users/noah/trading && ./start.sh
# 或直接進後端：
cd /Users/noah/trading/backend && uvicorn main:app --reload
```

## 📚 詳細文件（做相關工作時再讀，避免每輪載入吃 context）
> 架構細節已從本檔拆到 `docs/`，需要時用下方路徑讀取對應檔案即可。
- **後端**：環境變數、資料夾結構、資料源、即時行情疊加（台股分鐘K）、天氣資料源、背景載入策略、Pionex 限流、已知問題 → [docs/backend.md](docs/backend.md)
- **前端**：JS 模組表、視覺特效、音效、極簡模式（perf-mode）完整說明、版面配置、圖片資源、星號按鈕、標記視窗化 → [docs/frontend.md](docs/frontend.md)
- **CRT 勝率/回測**：S1~S12 訊號邏輯、新增訊號 checklist、勝率 HUD、各時框回測天數、後端 `crt.py` 結構與效能 → [docs/crt-winrate.md](docs/crt-winrate.md)

## ⚠️ 關鍵鐵則（違反會造成 bug，務必遵守）

### 時間戳
- 所有圖表時間戳 **+8 小時**（Taiwan Time），由 `toTime()` 處理。
- **後端傳前端的時間戳一律用 `.isoformat()`，禁止 `str(pd.Timestamp)`**：空格格式會讓 `toTime()` 產出 NaN → 餵 `setMarkers()` 後 Lightweight Charts 內部損壞 → **十字線鉛垂線全面斷裂**。已封裝於 `_ts(row)`。
- 台股 yfinance（`fetch_tw_intraday_yf`）：naive timestamp 先 `tz_localize("Asia/Taipei")` 再 `tz_convert("UTC")`，且 localize 前必須 `if df.index.tz is None`（否則 double-localize／小時線位移 +8h）。

### 前端 bundle 打包
- bundle 串接順序＝ `main.py` `_build_js_bundle()` 的 `names` 串列。**新增 bundle 檔務必同步加入 `names`**，否則不會被打包。
- 拆 bundle 檔：依行邊界切、在 `names` 同位置插入 → minify 後位元組相同（零行為風險），拆檔走這條路。
- 動態載入檔（`effects.js`/`weather.js`，不在 bundle）：拆/改後要更新 `main.js` 的 `_loadFx` 與 `main.py` 的 `_asset_ver`（mtime 版號，否則 `/static` 長快取吃到舊檔）。

### 非同步競態
- `_bgLoadGen`：每次新背景載入前 `++`，所有 async loop 每輪比對 `myGen === _bgLoadGen`，不符即退出。
- `replayActive`：replay 中任何改圖表的操作（含 `_bgScheduleIndicators`／`_bgLoadOlderBars`）必須先檢查此旗標。

### 極簡模式（perf-mode）不可污染正常模式
- `savePrefs()`（utils.js）在 perf-mode 直接 `return` — 否則 in-memory perf palette 會被寫回 `localStorage.chartColors`。
- `showLegColorPopup()`（draw.js）在 perf-mode 直接 `return`。
- topbar 相關覆寫必須用 `!important`（壓過 style.css 末段「橘子熊可愛風格」的 `!important`）。完整機制見 [docs/frontend.md](docs/frontend.md)。

### Pionex 限流
- Pionex API：10 次/秒/IP，超過封鎖 60s 且重試會 +10s 永遠清不掉。行情/價格走 Binance，Pionex 僅用於標的清單（硬碟快取 24hr）與獨有標的 klines。詳見 [docs/backend.md](docs/backend.md)。

### 不可更改的設定
- `startTickerRefresh()` 的 `setInterval(fetchTickers, 2000)` 固定 **2 秒**（行情即時性需求），**禁止以「減輕伺服器負擔」為由更改**。

## 圖片資源
所有原始圖片存放於 **桌面 `Claude-分類/虛擬貨幣/`**，已複製至 `frontend/static/img/`。對應表與前端使用位置見 [docs/frontend.md](docs/frontend.md)。
