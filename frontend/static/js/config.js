/* ═══════════════════════════════════════════════
   回測系統 — 前端  v8
   面板：主圖 | 成交量 | KDJ | RSI | MACD | 資金曲線(回測)
═══════════════════════════════════════════════ */

/* ── 預設顏色 ── */
const DEFAULT_COLORS = {
  up:      "#ef5350", down:    "#26a69a",
  borderUp:"#ef5350", borderDown:"#26a69a",
  wickUp:  "#ef5350", wickDown:  "#26a69a",
  volUp:   "#ef5350", volDown:   "#26a69a",
  bbU:     "#42a5f5", bbM:     "#ffcc02", bbL: "#42a5f5",
  kdjK:    "#f23645", kdjD:    "#1e88e5", kdjJ: "#ff9800",
  kdjH20:  "#4a4a6a", kdjH50:  "#666688", kdjH80:  "#4a4a6a",
  kdjCrossBull: "#26a69a", kdjCrossBear: "#ef5350",
  rsi14:   "#7e57c2", rsi7:    "#ef5350",
  rsiH30:  "#4a4a6a", rsiH50:  "#666688", rsiH70:  "#4a4a6a",
  macd:    "#2196f3", macdSig: "#ff9800", macdHist: "#888888",
  crtBull: "#26a69a", crtBear: "#ef5350",
  resonanceBull: "#26c6da", resonanceBear: "#ff9800",
  bg:      "#131722",
  chartBg: "#131722",
};

const DEFAULT_STYLES = {
  bodyVisible: true, borderVisible: true, wickVisible: true,
  volAlpha: 0.67,
  kdjHLWidth: 1,
  rsiHLWidth: 1,
  volMaPeriod: 5,
  kdjH80val: 80, kdjH20val: 20,
  rsiH70val: 70, rsiH30val: 30,
  kdjKStyle: 0, kdjDStyle: 0, kdjJStyle: 0,
  kdjKWidth: 1, kdjDWidth: 1, kdjJWidth: 1,
  rsi14Style: 0, rsi7Style: 0,
  rsi14Width: 1, rsi7Width: 1,
  macdStyle: 0, macdSigStyle: 0,
  macdWidth: 1, macdSigWidth: 1,
  bbWidth: 1, bbMWidth: 1,
};

let C = { ...DEFAULT_COLORS };
let S = { ...DEFAULT_STYLES };

/* 每條線的寬度 / 樣式（由調色盤設定，key = input id） */
const LINE_STYLES = {};

/* input id → 取得對應 LWC series 的 getter（buildCharts 建立後才能呼叫） */
const INPUT_SERIES_MAP = {
  "c-bbU":    () => bbU,     "c-bbM":    () => bbM,    "c-bbL":    () => bbL,
  "c-kdjK":   () => kdjK,    "c-kdjD":   () => kdjD,   "c-kdjJ":   () => kdjJ,
  "c-kdjH20": () => kdjH20,  "c-kdjH50": () => kdjH50, "c-kdjH80": () => kdjH80,
  "c-rsi14":  () => rsiLine14, "c-rsi7": () => rsiLine7,
  "c-rsiH30": () => rsiH30,  "c-rsiH50": () => rsiH50, "c-rsiH70": () => rsiH70,
  "c-macd":   () => macdLine, "c-macdSig": () => macdSignal,
};

/* ── 圖表物件 ── */
let mainChart,   candleSeries, bbU, bbM, bbL;
let latestPriceLine = null;
let volSeries, volMaSeries;          // 成交量放在 mainChart 的獨立價格軸
let kdjChart,    kdjK, kdjD, kdjJ, kdjH20, kdjH50, kdjH80;
let rsiChart,    rsiLine14, rsiLine7, rsiH30, rsiH50, rsiH70;
let macdChart,   macdLine, macdSignal, macdHist;
let kdjAnchor, rsiAnchor, macdAnchor;   // 透明錨定系列，確保時間軸對齊

/* ── 狀態 ── */
const currentChartType = "candlestick";
let ohlcvData       = [];
let currentTF       = "1d";
let realtimeTimer   = null;
let lastCRTMarkers       = [];
let lastKDJCrossMarkers  = [];
let lastResonanceMarkers = [];
let lastWRSignalMarkers  = [];
let _lastWRSignals       = [];   // 完整訊號列表（背景載入後重新過濾用）
let paneCollapseFlex = {};  // 面板收合前的 flex 值（module-level，供 loadVisibilityPrefs 使用）
let _restoringPrefs  = false; // 還原偏好設定時，暫停自動儲存
let _savedBarCount      = null;  // 切換標的前保存的可見 K 棒數量，載入後還原
let _savedTimeRange     = null;  // 已捲到歷史時保存的可見「時間範圍」{from,to}，切標的/時框後對齊同一時間
let _pendingRestoreRange = null; // 重整後要還原的畫面位置 { barCount, toOffset }
let _bgLoadInProgress   = false; // 背景分段載入舊 K 棒中
let _bgLoadGen          = 0;     // 每次新的載入任務遞增，用於取消舊的非同步迴圈
let _bgIndicatorTimer   = null;  // 指標 debounce timer
let _bgAnchorCache      = null;  // 增量錨點陣列（KDJ/RSI）
let _bgMacdCache        = null;  // 增量錨點陣列（MACD）

// 效能快取：時間 ISO 字串 → ohlcvData 索引（O(1) 取代 findIndex 線性掃描）
// 由 render.js 的 _rebuildTimeIndex() 在每次 ohlcvData 更新後重建
let _timeToIdx          = new Map();
// UNIX seconds → idx：LWC crosshair param.time 是秒，給 updateAllLegends 用
let _secToIdx           = new Map();
let _dataVersion        = 0;     // ohlcvData 變更時 ++，給 memo cache 用

const PANE_FLEX_DEFAULTS = { mainPane:5, kdjPane:1, rsiPane:1, macdPane:1 };

const TF_LABELS = { "1M":"月","1w":"週","1d":"日","8h":"8H","4h":"4H","2h":"2H","1h":"1H","30m":"30m","15m":"15m","5m":"5m" };

