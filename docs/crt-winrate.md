# 策略標記計算（/api/crt_winrate）

> 從 claude.md 拆出的參考文件。檔名沿用舊稱「CRT 勝率」，但**勝率統計功能已全部移除**，
> 這支端點現在的實際工作是「算主圖的 FVG 與方向標記」。

## 現況（2026-09-17 整理）

### 呼叫路徑
- 前端 `winrate.js` `_fetchWinRateNow()` → `GET /api/crt_winrate`
  → `routes/data.py` `crt_winrate_api()`（ETag/304、差量、跳過圖層、單飛）
  → `get_crt_winrate()`（抓 K 線＋快取）→ `utils/crt.py` `_calc_crt_winrate()`。
- 其他呼叫者：`main.py` 開機預熱（`get_crt_winrate(..., vw=8000)`）、`notify_monitor.py` 直接呼叫
  `_calc_crt_winrate` 取 `fvg_sigs`（FVG 進場通知／自動交易）、`multichart.js` 迷你圖用 `lite=ms`。

### 輸出（前端真正會用的）
| 鍵 | 用途 |
|---|---|
| `fvg` | 失衡缺口色塊 |
| `fvg_ms` | 多/空方向標記（proto 缺口，見 claude.md 的方向標記說明） |
| `fvg_break` | 破多/破空 |
| `fvg_shun` | 順多/順空 |
| `fvg_special` | 特多/特空（圖例已移除、預設不送） |
| `fvg_trades`、`fvg_bb`/`fvg_bb_a`/`fvg_bb_m` | 研究用進出場標記，預設隱藏、不送（主控台 toggle 打開才補抓） |
| `vwap`、`pd_ranges` | VWAP／折價溢價區，開關打開才送 |
| `fvg_sigs` | 收盤確認進場訊號 → 後端 `notify_monitor`／自動交易用，前端一律不送 |
| `_h` | 內容指紋（ETag／差量 base） |

- 2026-09-17：已移除的 S1~S12／SS 訊號統計鍵（`win_rate/total/short/long/abc/s3…/band/rr/recent/signals/
  stop_strategy…`，恆為空或零）連同產生它們的統計機器一併刪除 → 輸出只剩上表那些鍵。

### 參數
- `vw`：標記視窗根數，前端依已載根數走階梯 `[8000, 20000, 45000, 100000, 250000]`（`_WR_VW_LADDER`）。
  往歷史滑會升階，`_wrWarmNextTier` 在接近門檻時先 `warm=1` 預熱下一階。
- `proto_min`、`no_proto_ms`、`no_proto_break`：方向標記研究參數（UI 已拿掉，localStorage 仍會套用）。
- `skip`：前端依圖層開關列出不需要的鍵，後端白名單 `_WR_SKIPPABLE` 取交集後省略。
- `base_h`：升階時請後端只回差量（`_WR_DELTA_KEYS`），前端 `_wrApplyDelta` 拼回；拼不起來就整包重抓。
- `lite=ms`：迷你圖只回 `fvg_ms/fvg_break` 各最近 250 筆。
- `stop_buffer_pct`、`band_ratio`：只影響已移除的訊號統計；前端 2026-09-17 起不再傳。
- `solve`：止損求解模式，2026-09-17 移除（傳了會被忽略）。
- ⚠ 輸出結構變更要升 `crt_wrNNN` 快取鍵版號（現為 v107），否則部署後 30 分鐘內會送出舊格式。

### 快取
- 記憶體 `data_cache` 鍵 `crt_wr106:...`（輸出結構變更就遞增版號），TTL 30 分；crypto 另有
  bar-aware 新鮮度（落後超過 1 根就重算＋補抓尾巴）；Redis 共享快取（有設 `REDIS_URL` 才啟用）。
- 降級資料來源（Bybit/Pionex）不寫長效快取，見 claude.md「降級來源防污染」。

### 守門員
- `backend/scripts/check_crt_golden.py`（守門員之二十）：固定歷史區段 × 參數變體的**整份輸出雜湊**。
  改 `crt.py` 一律先跑；刻意改標記邏輯才可 `--update`。
- `scripts/check_wr_cache_layers.js`：網路／快取命中兩條路重繪的圖層必須一致。
- `scripts/check_tf_switch_layers.js`：切時框瞬間不可畫出上一個時框的線。

## 時間戳格式規範（重要）
- 後端傳給前端的所有時間戳必須用 `.isoformat()`，**不能用 `str(pd.Timestamp)`**
  - `str()` → `"2024-01-15 00:00:00"`（空格），`toTime()` 找不到 T → 拼出無效字串 → NaN
  - NaN 時間戳餵給 `setMarkers()` → Lightweight Charts 內部狀態損壞 → **十字線鉛垂線全面斷裂**
  - 正確：`raw_t.isoformat() if hasattr(raw_t, "isoformat") else str(raw_t)`（已封裝於 `_ts(row)`）

## 已移除（考古用，細節看 git 歷史）
- **S1~S12 CRT 訊號**（2026-07）、**SS1/SS2 布林軌道反轉**（2026-08-05）：偵測與勝負掃描整段刪除。
  2026-09-17 再刪掉殘留的 `_push_signal/_scan_dual/_rr_at` 等掃描函式與 `_solve` 求解模式。
- **勝率統計**（中軌/帶軌/1:1 三套、連敗、敗後停手、近期勝率、per-signal RR）：2026-09-17 刪除，`_calc_crt_winrate` 少 900 行。
- **勝率欄 HUD**（上方三段式勝率列、十字線 hover 勝率小卡、中軌/上下軌切換、停損緩衝、前三名列）、
  **訊號詳情抽屜** `signal_info.js`：2026-09-17 隨勝率欄移除。
- **CRT 訊號回測** `/api/crt_backtest`、`backtest.js`，以及更早的通用技術策略回測引擎。
- 本檔 2026-09-17 以前的版本詳列了 S1~S12 各訊號條件、新增訊號 checklist、勝率欄設計，
  要考古請 `git log -p -- docs/crt-winrate.md`。
