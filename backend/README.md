## Trading 回測系統結構

### 目錄結構

```
backend/
├── main.py              # FastAPI 應用主程式、路由註冊 (55 行)
├── data/                # 數據模塊 (已存在)
│   ├── crypto.py
│   ├── taiwan.py
│   └── us_stock.py
├── indicators/          # 指標計算 (已存在)
├── backtest/            # 回測引擎 (已存在)
├── strategies/          # 交易策略 (已存在)
├── routes/              # API 路由
│   ├── __init__.py
│   ├── data.py          # OHLCV 數據 API (~170 行)
│   ├── search.py        # 搜索 API (~60 行)
│   ├── strategies.py    # 策略列表 API (~12 行)
│   └── backtest.py      # 回測 API (~85 行)
└── utils/               # 工具模塊
    ├── __init__.py
    ├── cache.py         # 緩存管理 (~40 行)
    └── data.py          # 數據處理 (~50 行)
```

### 模塊功能

#### main.py (55 行)
- FastAPI 應用初始化
- 靜態文件和模板配置
- 所有路由註冊
- 啟動時緩存預熱
- 版本管理 (Git 版本控制)

#### utils/cache.py
- `SimpleCache` 類：TTL 和 LRU 淘汰機制
- 自動管理記憶體（Railway 限制）

#### utils/data.py
- `enrich_df()` - 統一計算指標 (BB, KDJ, RSI, MACD)
- `df_to_records()` - 轉換為 JSON 格式

#### routes/data.py (~170 行)
- `/api/ohlcv` - 取得 OHLCV 數據
  - 支持：台股、加密貨幣、美股
  - 支持日線和分鐘線
  - 自動緩存
- `/api/latest` - 取得最新 K 棒（即時數據）

#### routes/search.py (~60 行)
- `/api/search` - 搜索標的 (台股、加密貨幣)
- `/api/us/search` - 美股搜索
- `/api/tickers` - 取得標的列表
- `/api/pionex/symbols` - 診斷用 Pionex 標的

#### routes/strategies.py (~12 行)
- `/api/strategies` - 列出所有可用策略

#### routes/backtest.py (~85 行)
- `/api/backtest` - 執行回測
  - 返回回測統計、交易紀錄、淨值曲線
  - 返回 OHLCV 和所有技術指標

### 好處

✅ **模塊化** - API 路由獨立維護  
✅ **清晰分工** - 數據、搜索、策略、回測各司其職  
✅ **工具集中** - 緩存和數據處理集中  
✅ **記憶體優化** - 自動 TTL 和 LRU 淘汰  
✅ **快速查詢** - 從 402 行縮減為 55 行主程式  
✅ **易於擴展** - 新增 API 只需新建路由文件  

### 數據流

```
用戶請求
  ↓
FastAPI 路由匹配
  ↓
route handler (data.py / search.py / backtest.py)
  ↓
檢查緩存 (utils/cache.py)
  ↓
數據獲取 (data/*.py)
  ↓
指標計算 (utils/data.py → enrich_df)
  ↓
JSON 序列化 (utils/data.py → df_to_records)
  ↓
響應 + 緩存
```

### 運行

```bash
cd backend
python3 main.py
# 或使用 uvicorn
uvicorn main:app --reload
```

### API 端點

| 方法 | 端點 | 功能 |
|------|------|------|
| POST | `/api/ohlcv` | 取得 OHLCV 數據 |
| POST | `/api/latest` | 取得最新 K 棒 |
| GET | `/api/search` | 搜索標的 |
| GET | `/api/us/search` | 美股搜索 |
| GET | `/api/tickers` | 標的列表 |
| GET | `/api/strategies` | 策略列表 |
| POST | `/api/backtest` | 執行回測 |

### 緩存策略

- OHLCV 數據：30 秒 (limit 模式) / 5 分鐘 (日期範圍模式)
- 搜索結果：1 小時
- 標的列表：2 秒 (近即時)
- 最大記憶體：12 筆記錄
- 自動淘汰：TTL > 600 秒 或 LRU
