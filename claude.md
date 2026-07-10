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
- 殘留的 `unpkg`／`gstatic` 只在 `sw.js` 快取白名單與 `main.py` CSP `script-src`，無害；如再引入其他庫，同樣放 `/static/vendor/`。

### 非同步競態
- `_bgLoadGen`：每次新背景載入前 `++`，所有 async loop 每輪比對 `myGen === _bgLoadGen`，不符即退出。
- `replayActive`：replay 中任何改圖表的操作（含 `_bgScheduleIndicators`／`_bgLoadOlderBars`）必須先檢查此旗標。

### 主圖標記（FVG/SMC 等）重繪要完整
- 標記經 `_has()` 過濾＝**只顯示時間存在於當下 `ohlcvData` 的棒** → 任何「資料變多／換內容」的時點都必須用暫存重繪，否則整段沒標記。已因漏重繪出過兩次 bug：
  1. `_bgLoadOlderBars` 補載歷史完成後（02b429a）；
  2. `_fetchWinRateNow` **快取命中分支**——必須與網路成功路徑重繪**同一組層**（fvg_ms/fvg_break/fvg_trades/fvg_bb/SMC 掃蕩·結構·OB·SR/VWAP/通道/pd_ranges），少一個就是切標的回來沿用舊標的標記（ca8ec0f）。
- 之後在勝率回應新增圖層時，**兩條路徑都要加**。
- 各時框可看深度：背景補載僅 1m/5m/15m/1h/4h；**8h/2h/30m/1d 一次載入**（如 8h 僅 ~500 根）→ 舊區段「沒 K 棒也沒標記」是設計、不是 bug。

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
- `startTickerRefresh()`（`ticker.js`）的 `setInterval(fetchTickers, …)` 間隔依市場固定：**crypto 1 秒、台股 3 秒**（行情即時性需求；2026-07-09 台股 10 秒→3 秒，配合後端 `_tw_rt_overlay_worker` 每 3 秒 MIS bulk 疊「量最大前 120 檔」即時價 → 報價列即時跳動），**禁止以「減輕伺服器負擔」為由改慢**。台股全量清單仍由 `_tw_ticker_worker` 每 30 秒抓 TWSE/TPEX opendata 維護。

## 圖片資源
所有原始圖片存放於 **桌面 `Claude-分類/虛擬貨幣/`**，已複製至 `frontend/static/img/`。對應表與前端使用位置見 [docs/frontend.md](docs/frontend.md)。
