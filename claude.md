# trading Claude Instructions

## 專案概覽
- `trading` 是一個回測系統，包含 FastAPI 後端、靜態前端、資料模組與策略引擎。
- 後端位於 `backend/`，前端位於 `frontend/`。
- `start.sh` 安裝依賴並啟動 `backend/main.py`。

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
  - `crypto.py` - 加密貨幣數據 (Pionex)
  - `taiwan.py` - 台股數據
  - `us_stock.py` - 美股數據
- `backend/indicators/` - 技術指標計算
  - `engine.py` - 指標計算引擎 (BB, KDJ, RSI, MACD 等)

### 策略與回測
- `backend/strategies/` - 交易策略
  - `builtin.py` - 內建策略實現
- `backend/backtest/` - 回測引擎
  - `engine.py` - 回測執行與淨值計算

### 前端
- `frontend/templates/` - HTML 模板
  - `index.html` - 主頁面
- `frontend/static/` - 靜態資源
  - `js/` - JavaScript
  - `css/` - 樣式表
  - `img/` - 圖片資源

## 注意事項
- `backend/main.py` 在啟動時會先預熱 Pionex 標的快取。
- 路由模組使用 `app.include_router(...)`，新增 API 應放在 `backend/routes/`。

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
