# CRT 策略自動回測 / 勝率

> 從 CLAUDE.md 拆出的 CRT 勝率與回測詳細參考。

## 回測功能（兩種策略來源，2026-06）
- **通用技術**：`/api/backtest`（routes/backtest.py `run_backtest`）→ 7 個內建策略 + 向量化引擎，用使用者給的起訖日抓資料。
- **CRT 訊號(S1~S12)**：`/api/crt_backtest`（`run_crt_backtest`）→ **重用 `/api/crt_winrate` 已算好的 `signals`**
  （深歷史+1hr快取，不另抓），把選定訊號(或 all=S2~S11 合計，去重)的勝負序列 × 每筆預估盈虧比(`rr`)
  做資金模擬：每筆風險 `risk_pct`、win→+rr R、loss→-1R（複利）。支援 direction(多/空/both)、target(mid/band)、stop_buffer。
- **前端**：`backtest.js` 的 📊 鈕開 modal（用目前圖表的標的/市場/交易所/時框），兩模式切換，結果顯示績效卡 + canvas 資金曲線。

## 效能優化：後端勝率計算（`utils/crt.py`）
- **時間戳向量化**：`times_iso = df["time"].to_numpy("datetime64[s]").astype(str).tolist()`，取代逐根 `_ts_val` + pandas 慢速 `__iter__`。tz-naive 秒精度下與 `.isoformat()` 完全一致，**省整體 ~30%**。
- **`signals` 排序一次**：`signals_sorted` 共用給 `_calc_streaks` / `_build_combined`（原本各自 `sorted` ~16 次）。
- **`_build_combined` memoize**：cond/stop/recent 會重複要同組合（24 呼叫、12 種唯一）→ `_combined_memo` 快取免重算。
- **`_solve` 精簡模式**：`_calc_crt_winrate(_solve=target)`（target 字串 mid/band）——每訊號只掃選定目標、跳過 est/RR/全部統計，只跑敗後停手模擬回 `{win_rate, total}`。求解（達標止損）13× 掃描用此模式（偵測 mask 與完整版共用，~4-6× 快）。
- **df 快取**（`crt_df2:...`，不含 buffer，存於 `data_cache` 池）：換 SL 緩衝免重抓（抓資料佔總時間 90%+）。`utils/cache.py` 為真 LRU，重量級 CRT 產物（df/wr/solve）走 `data_cache`、與揮發性 `ohlcv` 的 `cache` 分池。
- > 兩目標（中/帶）+ recent100 的計算成本中等，且有 1hr 快取，非使用者可感瓶頸。剩餘最大塊是每訊號數次掃描（mid/帶/est），屬功能必要、不再硬壓。（原第三目標 1:1 已移除，省一輪固定目標掃描。）

---

## 🔧 新增訊號（Sxx）的完整 checklist（降低維修成本）
目前已有 S1(abc)、S2(ab)、S3~S12（**S1 與 S12 皆不計入總勝率合計**）。新增一個訊號（下例假設新增 S13）要改這些地方（缺一就會壞）：

**後端 `backend/utils/crt.py`**
1. `SIG_KEYS` 串列加入新 key（無前綴字串，如 `"13"`）
2. 在對應的 `if n>=X` 區塊算出 `sXX_short` / `sXX_long` mask
3. 呼叫 `_process_3bar(...)`（3 棒）或自寫迴圈（4 棒，仿 S10/S11）+ `_push_signal(... "13" ...)`
4. `_build_target_stats` 的 `out` dict 加 `"sXX": per_sig["13"]`
5. **若要計入總勝率**：合計 tuple `_AGG`（在 `_build_target_stats` 內）加入 `"13"`（目前 `_AGG` = ab,3~11，即 S2~S11；S1/S12 刻意不在內）

**後端 `backend/routes/data.py`**
6. `_sufficient` 的 sig 迴圈加入 `"sXX"`
7. `cache_key` 版號 +1（`crt_wrNN` → `crt_wrNN+1`）強制重算

**前端**
8. `templates/index.html`：勝率欄加一個 `.tb-wr-block`（data-sig + icon + wrSXXS/wrSXXL）。注意這些 block 預設由 CSS 隱藏（改用 hover 顯示，見下方 HUD），但仍需存在供 `setRow` 寫值
9. `winrate.js`：`setRow("wrSXXS", d.sXX?.short)`；marker 的 `eColor`/`eShape`/`eText` 加 `k==="13"` 分支；`_SIG_LABEL`/`_SIG_ICON`/`_SIGK_TO_STATKEY` 各加一項（hover 小卡用）
10. `signal_info.js`：`_S_KEY_MAP` 加 `sXX:"13"`；`SIGNAL_INFO` 加該訊號 metadata
11. `style.css`：`.wr-sXX { color }` + perf-mode 版

> **變數命名**：stat key 用 `s3`~`s12`（有 s 前綴），但 signal record 的 `s.k` 與 `SIG_KEYS` 用 `"3"`~`"12"`（無前綴）。`_SIGK_TO_STATKEY` 負責 `"3"`→`s3` 轉換（hover 用）。abc/ab 兩者同名。
> **強化版（variant）已完全移除**（後端 2026-05、前端死碼 2026-06）。後端無 `_v`/`out["variant"]`、`signals` 不帶 `v`、`_solve` 為單純 target 字串；前端 `winrate.js`/`signal_info.js` 的 variant 殘留亦已清除。新增訊號**不需**處理 variant。

## 訊號並行計算（S1~S12）

> 目前共 12 種訊號（S1=abc、S2=ab、S3~S12）。下方詳列 S1~S6；S7~S12 的條件見各自 mask 與 `signal_info.js` 的 `SIGNAL_INFO`。新增訊號照上方 checklist。
> **訊號一（S1/ABC）與訊號十二（S12）僅獨立顯示，不計入總勝率合計（`_AGG` = S2~S11）。** 注意 `_sufficient`（決定抓多少天資料）要求 `abc/ab/s3~s11`（即 S1~S11）各空/多達 `MIN_CASES`，但**不含 S12**——兩者範圍不同，別搞混。

### 訊號一（ABC）：同一棒三條件同時成立
| 方向 | CRT | KDJ 交叉 | 共振（resonance） |
|------|-----|---------|-----------------|
| 做空 | -1（看跌完成棒） | -1（死叉） | -1（超買） |
| 做多 | +1（看漲完成棒） | +1（金叉） | +1（超賣） |

- 進場：訊號棒（i）下一根開盤（`entry_i = i + 1`）
- 停損：訊號棒 i 的最高價（做空）/ 最低價（做多）
- **不計入總勝率**，僅作參考顯示

### 訊號二（AB）：連續兩棒接力
- **A 棒（i）**：`resonance == ±1`（超買或超賣共振）
- **B 棒（i+1）**：`crt == ±1` 且 `kdj_cross == ±1`（同方向）
- **排除條件①**：B 棒同時有 resonance（等同訊號一）→ 跳過
- **排除條件②**：B 棒的 low（做空）/ high（做多）已碰至 BB 中軌 → 目標已提前觸及，跳過
- 進場：B 棒下一根（`entry_i = i + 2`）
- 停損：**A、B 兩棒**取最高價（做空）/ 最低價（做多）

### 訊號三（S3）：連續三棒，放寬版（每棒最多 2 個指標）
- **A 棒（i）**：有 resonance，但 CRT 與 KDJ叉 不能同時出現（最多兩個指標）
- **B 棒（i+1）**：同 A 棒規則（有 resonance，最多兩個）
- **C 棒（i+2）**：有 KDJ叉，但 CRT 與 resonance 不能同時出現（最多兩個）
- **排除條件**：僅排除「C 棒碰中軌」（做空 `c_low > bb_middle`／做多 `c_high < bb_middle`，留出回歸空間）。**不再排除「C 棒觸上/下軌」**——均值回歸時死叉棒刺到上軌（超買後反轉）正是最佳進場點，排除它會漏掉強訊號（例：超賣叢集→金叉、叉棒刺破下軌）。
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

### 訊號四（S4）：連續三棒，嚴格純淨版（A=純共振，B=無，C=純叉）
- **A 棒（i）**：**只有** resonance（CRT=0、KDJ叉=0）
- **B 棒（i+1）**：**三個指標全無**（CRT=0、KDJ叉=0、resonance=0）
- **C 棒（i+2）**：**只有** KDJ叉（CRT=0、resonance=0）
- **排除條件**：C 棒 low/high 碰至 BB 中軌 → 跳過
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

### 訊號五（S5）：連續三棒，嚴格純淨版（A=無，B=純共振，C=純叉）
- **A 棒（i）**：**三個指標全無**（CRT=0、KDJ叉=0、resonance=0）
- **B 棒（i+1）**：**只有** resonance（CRT=0、KDJ叉=0）
- **C 棒（i+2）**：**只有** KDJ叉（CRT=0、resonance=0）
- **排除條件**：C 棒 low/high 碰至 BB 中軌 → 跳過（同 S4）
- 進場：C 棒下一根（`entry_i = i + 3`）
- 停損：三棒最高高點（做空）/ 最低低點（做多）

### 訊號六（S6）：ABC 三棒觸軌反轉
邏輯：2 根「安靜」棒後突然出現觸軌反轉 K → 高品質的「轉折開始」訊號。
> **2024 改版**：原為「3 安靜棒 + 第 4 根反轉」（4 棒），但前 3 根全乾淨太嚴格、
> 實戰復盤常漏（D 棒明明是漂亮的觸軌反轉，只因前 3 根有一根雜訊指標就不出）。
> 改為「2 安靜棒 + 第 3 根反轉」（3 棒），更貼近實際所見。
- **A 棒（i）**：crt=0、kdj_cross=0、resonance=0（全無指標）
- **B 棒（i+1）**：同 A，全無指標
- **C 棒（i+2）**（訊號棒）：
  - 做空：`crt == -1` 且 `high >= bb_upper`（影線或本體觸上軌）
  - 做多：`crt ==  1` 且 `low  <= bb_lower`
  - 排除：C 棒已碰中軌（做空 `low > bb_middle`／做多 `high < bb_middle`）
- 進場：C 棒下一根（`entry_i = i + 3`）開盤
- 停損：**A、B、C 三棒**取最高（做空）/ 最低（做多）
- 前端圖示：◇（紫藍 `#9fa8da`，極簡模式 `#3949AB`）；標籤：空⁶／多⁶

### 共同勝負條件（全部訊號適用）
- **獲勝**：後續 K 棒 `low ≤ BB中軌`（做空）或 `high ≥ BB中軌`（做多）
- **失敗**：後續 K 棒觸及停損位
- **同棒雙觸**：以收盤價判定先後（收在獲利側 → 成功）

### 指標欄位說明
- **CRT**：`crt_markers()`，信號落在完成棒（第二根），`signals[bearish.shift(1)] = -1`
- **共振**：`bb_kdj_rsi_resonance()`，高觸布林上軌 + KD>80 + RSI7>65 → -1；低觸下軌 + KD<20 + RSI7<35 → +1
- **`enrich_df()`** 中共振使用 `rsi_7`（7 期 RSI），閾值 `rsi_ob=65, rsi_os=35`

## 後端結構（`backend/utils/crt.py`）
- **共用 helper（模組層級）**：
  - `_ts_val(t)` → ISO 字串（`.isoformat()` 等價，給單一時間戳用；批次轉換已向量化，見效能優化）
  - `_scan_outcome_np(...)` 動態目標掃描，回 `('win'/'loss'/None, 結算時間, exit_idx)`
  - `_scan_outcome_fixed(...)` / `_scan_outcome_fixed_t(...)` 固定目標掃描（後者另回結算時間，原供 1:1 用，1:1 移除後僅 est 系列仍用 `_fixed`）
- **主函數** `_calc_crt_winrate(df, stop_buffer_pct=0, long_only=False, _solve=None)`，**兩目標各一份完整統計**（原三目標，1:1 已移除）：
  - **頂層 = 中軌(mid)**；`"band"` = 上下軌（多→上軌、空→下軌）。兩者結構相同。
  - **`"rr"`（1:1，止盈距離 = 止損距離）已於 2026-06 從前端移除** → `_scan_rr()` 短路回 `None`、`rr` 結構保留但為空、`signals` 的 `r_rr/ot_rr=None`，前端不讀（`_wrTargetView` 載入時把舊存的 `"rr"` 正規化成 `"mid"`）。省下每訊號一次固定目標掃描。
  - 每個 target 含：`total/wins/win_rate`、`short/long`、各訊號 `abc/ab/s3~s12`、`stop_strategy`（敗後停手，內含 `.est`）、`recent100`（近 ~100 筆勝率）、`est_*`（預估盈虧比達標）、`max_loss_streak`、cond（連敗機率，在 short/long 內）。
  - `signals`：每筆 `{t, d, k, r/ot(中軌), r_b/ot_b(帶軌), r_rr/ot_rr(=None,1:1已移除), est_r/est_r_b, rr(預估盈虧比值,供前端顯示), stop(實際止損價,含 buffer/多棒取極值)}`。
  - 另含 `from_date`、`recent`（最近 30 筆）、`long_only`。
- **`_solve=target`**（字串 mid/band）：求解專用精簡模式——只掃選定 target、跳過 est/RR/全部統計，只跑敗後停手模擬回傳 `{win_rate, total}`（偵測 mask 與完整版共用）。詳見「效能優化」。

## 最低案例數保證
- `MIN_CASES = 40`；`_sufficient(r)` 檢查 abc/ab/s3~s11 各空/多是否達標（**不含 S12**）。
- **不再 doubling**：直接一次抓 `TF_MAX` 天（過去 doubling 對 S1/S5/S7 等稀有訊號永遠達不到、浪費 80% 時間）。
- cache key：`crt_wr70:market:symbol:exchange:timeframe:buffer:long_only`（訊號邏輯／輸出結構變更時遞增版號）；solve 另用 `crt_solve5:...`；enrich 後的 df 另快取 `crt_df2:...`（不含 buffer，換 SL 緩衝免重抓，抓資料佔總時間 90%+）。以上三者皆存於 `data_cache` 池（見「效能優化」）。

## 各時間框架資料來源與回測天數
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

## 訊號棒視覺化（`_renderWRSignals`）
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
  | `"7"` | arrowDown/Up | `#4dd0e1` | `#80deea` | 空⁷/多⁷ |
  | `"8"` | arrowDown/Up | `#f06292` | `#f48fb1` | 空⁸/多⁸ |
  | `"9"` | arrowDown/Up | `#fff176` | `#fff59d` | 空⁹/多⁹ |
  | `"10"` | arrowDown/Up | `#90caf9` | `#bbdefb` | 空¹⁰/多¹⁰ |
  | `"11"` | arrowDown/Up | `#aed581` | `#c5e1a5` | 空¹¹/多¹¹ |
  | `"12"` | arrowDown/Up | `#ffab91` | `#ffccbc` | 空¹²/多¹² |
- **結果標記 + 目標切換**：結果欄位依目標鈕（中軌/上下軌）取 `s.r/s.ot` 或 `s.r_b/s.ot_b`（前端 `_wrResultKey()`/`_wrOtKey()` 幫手；1:1 的 `s.r_rr/s.ot_rr` 已移除、恆為 null）：
  - `= "w"` → 綠色 `#26a69a`，文字 `✓`，位置在目標方向
  - `= "l"` → 紅色 `#ef5350`，文字 `✗`，位置在止損方向
  - 結算棒時間 = 對應 ot 欄位；為 null 表示末端尚未結算
- **標記視窗化**（效能）：見 [docs/frontend.md](frontend.md) 的「前端圖表標記視窗化」——只渲染可見範圍 ±一屏的標記。
- 透過 `lastWRSignalMarkers` 合入 `_applyMainMarkers()`；切換標的/時框時清除

## 勝率顯示欄（topbar，三段式 HUD 設計）
**佈局：** `flex: 1 1 auto` 佔滿 `topbar-left` 與 `topbar-tf` 之間所有可用空間。內部三段：

```
┌─────────────────────────────────────────────────────────────┐
│ [中軌|0%]    [十字線 hover → 該棒訊號勝率並列]    [↕75% ←date筆數] │
│ ↑ tb-wr-fixed-left  ↑ tb-wr-scroll(#wrHover)     ↑ tb-wr-fixed-right
└─────────────────────────────────────────────────────────────┘
```

> **2026 改版**：中央區原本是「常駐 S1~S6 橫向滾動勝率塊」，已改為**十字線 hover 顯示**——滑鼠/十字線移到某根 K 棒，`#wrHover` 顯示「該棒上所有訊號的勝率」並列（手機 3+ 訊號用卡片自動輪播）。`templates/index.html` 內 12 個 `.tb-wr-block`（abc~s12）**仍存在但被 CSS `#wrScroll > .tb-wr-block{display:none}` 隱藏**（保留供 `setRow` 寫值與相容），實際顯示走 `#wrHover`。詳見 winrate.js 的 `_updateHoverWR`。

- **左固定區 `.tb-wr-fixed-left`**（z-index:3 不隨滾動移動）
  - `#wrTargetToggle`：單鍵 toggle 切換目標（**兩段** 中軌 ↔ 上/下軌；原第三段 1:1 已於 2026-06 移除）
    - 「中軌」（預設）= BB middle target
    - 「上/下軌」= 多→BB upper、空→BB lower（方向相關的極端反向目標）
    - 點擊呼叫 `_toggleWrTarget()`（`mid` ↔ `band`），state 存 `localStorage.wrTargetView`；載入時若讀到舊值 `"rr"` 會正規化成 `"mid"`
    - 後端兩種目標各算一份完整統計：mid 放頂層、band 在 `d.band`（結構相同：總/各訊號/連敗/敗後停手）。前端用 `_wrPickView(d)`/`_wrResultKey()`/`_wrOtKey()` 三幫手依 view 取值
  - `#wrStopBuffer`：number input 0~10，止損緩衝百分比
    - 多單 `stop = base_low × (1 - buffer)`、空單 `stop = base_high × (1 + buffer)`
    - state 存 `localStorage.wrStopBuffer`（decimal 字串）
    - 變更 → 清前端 `_wrCache` → re-fetch
- **中央區 `.tb-wr-scroll`**：實際內容為 `#wrHover`（hover 勝率小卡，見上方改版說明）。被隱藏的 `.tb-wr-block` 元素 ID 仍為 `wrAbcS/L`、`wrAbS/L`、`wrS3S/L`~`wrS12S/L`（hover 小卡用 `_SIG_LABEL`/`_SIG_ICON` 對照表上色）
- **右固定區 `.tb-wr-fixed-right`**（z-index:3 不隨滾動移動）
  - `#wrAll`：**S2~S11** 合計勝率（`_AGG`；S1、S12 皆不計入），CSS gradient text + drop-shadow glow
  - `#wrRecent100`：**近 ~100 筆**勝率（合併時間軸去重後最近 100 筆，看近期表現 vs 全期）。後端各 target 存 `recent100`（由 `_build_combined` 取末 100 筆算）；跟目標鈕切換
  - `#wrFromDate`：回測起始日 `←YYYY/MM/DD`
  - `#wrStatus`：「N筆」目前圖表可見訊號數

**漸層流線視覺：**
- 主背景 5-stop 對角漸層（深褐→暖橘→深褐）+ `backdrop-filter: blur(18px)`
- `::before` 動畫 `wr-flow` 6s loop 橘色微光由左掃到右
- `::after` 1px 暖色漸層細線於頂部（HUD 細節）
- 圓角 10px、雙層 outer glow（30px + 60px halo）

**計算中狀態 `.calculating`：**
- 全資料變暗 32% opacity（提示「舊資料」）
- 中央 `.tb-wr-loading`（小熊頭 `bear.png` + 「計算中…」）淡入，z-index:6
  - 熊頭 `bear-bounce` 0.9s loop（上下彈跳 + 左右搖擺 + 微縮放）
  - 文字 `wr-loading-pulse` 1.4s loop（opacity 75%↔100%）
- 底部 `.tb-wr-progress` 進度條 — 水流動態漸層：
  - 8-stop 漸層 + `background-size: 200%`
  - 雙動畫：`wr-progress-fill`（2.5s 寬度 0→95%）+ `wr-progress-flow`（1.6s 漸層位置 200%→0%）
  - 像液態金屬/燃料條流動

**hover 狀態保護：**
- `_mouseOverChart`（DOM `mouseenter/leave`，比 LWC crosshair 可靠）
- 滑鼠在任一圖表內 → `updateSymbolBar` 跳過，上方 OHLCV 不被 realtime poll 跳回

**極簡模式：**
- 所有橘色 glow / 漸層改成純白底 + 橘 `#FF6A1A` solid active
- 動畫保留（不顯著影響效能）但色彩淡化

## 時間戳格式規範（重要）
- 後端傳給前端的所有時間戳必須用 `.isoformat()`，**不能用 `str(pd.Timestamp)`**
  - `str()` → `"2024-01-15 00:00:00"`（空格），`toTime()` 找不到 T → 拼出無效字串 → NaN
  - NaN 時間戳餵給 `setMarkers()` → Lightweight Charts 內部狀態損壞 → **十字線鉛垂線全面斷裂**
  - 正確：`raw_t.isoformat() if hasattr(raw_t, "isoformat") else str(raw_t)`（已封裝於 `_ts(row)`）
