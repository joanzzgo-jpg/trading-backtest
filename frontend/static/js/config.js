/* ═══════════════════════════════════════════════
   回測系統 — 前端  v8
   面板：主圖 | 成交量 | KDJ | RSI | MACD | 資金曲線(回測)
═══════════════════════════════════════════════ */

/* ── 預設顏色 ── */
const DEFAULT_COLORS = {
  up:      "#ef5350", down:    "#26a69a",
  borderUp:"#ef5350", borderDown:"#26a69a",
  wickUp:  "#ef5350", wickDown:  "#26a69a",
  volUp:   "#ef5350", volDown:   "#26a69a", volMa: "#ffcc02",
  bbU:     "#42a5f5", bbM:     "#ffcc02", bbL: "#42a5f5",
  bb1:     "#90caf9",   // 布林 1σ 內帶（已移除，保留鍵不影響）
  vwap:    "#ffc107",   // VWAP 折線顏色（畫布層，可調色；繪製時套 0.45 透明度）
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
  vwapWidth: 1,   // VWAP 折線粗細（畫布層，可調）
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
let lastWRSignalMarkers  = [];
let lastFVGTradeMarkers  = [];   // FVG「接1次」cascade 進出場標記（主圖）
let lastFVGBBMarkers     = [];   // D版(三根止損+1.5R)進出場標記（研究用·主圖）
let lastFVGBBMarkersA    = [];   // A版(g-1止損+布林軌外1W)進出場標記（同場對比·主圖）
let lastFVGBBMarkersM    = [];   // M版(中軌分側順勢+止損g/g-1+止盈3W)進出場標記（主圖）
let lastFVGBreakMarkers  = [];   // 「破多/破空」結構轉破標記（主圖）
window._fvgBreakHidden = false;  // 預設顯示結構轉破標記；切換:toggleFVGBreak()
let lastFVGMSMarkers     = [];   // 「多/空」方向標記（吃 setup FVG 後、窗內首次同向 proto 缺口 B，標在 g）（主圖）
window._fvgMSHidden = false;     // 預設顯示多/空方向標記；切換:toggleFVGMS()
let lastFVGShunMarkers   = [];   // 「順多/順空」：吃同向FVG後影線穿透既存反向FVG（主圖）
window._fvgShunHidden = true;    // 預設隱藏順多/順空標記（使用者要求關掉）；切換:toggleFVGShun()
let lastFVGSpecialMarkers = [];  // 「特多/特空」：多空/破多空序列 A→B→C 三連市場結構（標在 C）（主圖）
window._fvgSpecialHidden = true;  // 特多/特空標記已從圖例移除(使用者要求刪除)→ 永久隱藏、不再顯示
window._dimBigBarOn = false;     // 「大棒淡化」：標記棒全長>前10根平均→淡化該棒三組策略標記；切換:toggleDimBigBar()
window._dimVolOn = false;        // 「量淡化」(測驗)：標記棒成交量小於前三根其中一根→保留,否則(≥前三根全部)淡化；切換:toggleDimVol()
window._dimCounterTrendOn = false;  // 「大時框順勢」：逆大時框(滾動VWAP)偏向的策略標記淡化；切換:toggleDimCounterTrend()
window._fvgFilterGopp = false;   // FVG 過濾：只顯示「g 方向與 g-1、g+1 皆相反」的缺口；切換:toggleFvgFilterGopp()
window._fvgFilterGvol = false;   // FVG 過濾：只顯示「g 成交量 < g+1 成交量」的缺口；切換:toggleFvgFilterGvol()
window._pdhlOn = false;          // 前一日高低(PDH/PDL)水平線；切換:togglePDHL()
window._engulfOn = false;        // 外包吞噬掃蕩(第2根上下兩側都吃第1根+方向相反)；切換:toggleEngulf()
window._econOn = false;          // 經濟事件垂直線(NFP/CPI/FOMC)；切換:toggleEcon()
window._swingOn = false;         // Swing point 擺動點(3根中間根為區域高/低)；切換:toggleSwing()
let lastSMCSweepMarkers  = [];   // SMC 掃頂/掃底標記（階段1：SR+SMC 教練疊加層）
let lastCoachBOSMarkers  = [];   // 教練步驟5(BOS 延續)達成點：主圖箭頭標記（15m用default/5m用fast）
window._coachOn = false;         // SR+SMC 教練疊加層總開關（右上 coachToggleBtn）；預設關，開才顯示
window._vwapOn  = false;         // VWAP 成交量加權均價 獨立開關（右上 vwapToggleBtn）；預設關，開才顯示
window._fvgTradesHidden = true;  // 預設隱藏舊「多F/空F」cascade 標記+止損止盈線（使用者要求移掉，只留布多/布空）
window._fvgBBHideD = true;       // 預設隱藏 D版(三根止損+1.5R)標記；切換:toggleFVGBB('D')
window._fvgBBHideA = true;       // 預設隱藏 A版(g-1止損+布林軌外1W)標記；切換:toggleFVGBB('A')
window._fvgBBHideM = true;       // 預設隱藏 M版(中軌分側順勢=順多/順空)標記（使用者要求從主圖移除）；切換:toggleFVGBB('M')
let _lastWRSignals       = [];   // 完整訊號列表（背景載入後重新過濾用）
let _lastFVGTrades       = [];   // FVG「接1次」cascade 進出場（背景重畫用）
let _lastFVGBreak        = [];   // 結構轉破:多FVG→空FVG→收破前一個多FVG（背景重畫用）
let _lastFVGMS           = [];   // 多/空方向標記:吃到未填補反向FVG→收破同向FVG（背景重畫用）
let _lastFVGShun         = [];   // 順多/順空:吃同向FVG後影線穿透既存反向FVG（背景重畫用）
let _lastFVGSpecial      = [];   // 特多/特空:多空/破多空序列 A→B→C 三連市場結構（背景重畫用）
let paneCollapseFlex = {};  // 面板收合前的 flex 值（module-level，供 loadVisibilityPrefs 使用）
let _restoringPrefs  = false; // 還原偏好設定時，暫停自動儲存
let _savedBarCount      = null;  // 切換標的前保存的可見 K 棒數量，載入後還原
let _savedTimeRange     = null;  // 已捲到歷史時保存的可見「時間範圍」{from,to}，切標的/時框後對齊同一時間
let _savedRightOffset   = null;  // 看最新時保存「最新棒距右緣的空白(rightOffset, 單位:棒)」，切標的後沿用同一水平位置
let _savedBarSpacing    = null;  // 看最新時保存縮放(barSpacing, px/棒)；用持久選項還原，比邏輯範圍穩健
let _pendingRestoreRange = null; // 重整後要還原的畫面位置 { barCount, toOffset }
let _bgPosAnchor        = null;  // 看最新時的「縮放+右緣留白」錨點 {barSpacing,rightOffset}；背景分頁載入每段後重套，避免 fitContent/setVisibleLogicalRange 把縮放壓回 0.5（切第三個標的黏回右緣的根因）
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

const TF_LABELS = { "1M":"月","1w":"週","1d":"日","4h":"4H","2h":"2H","1h":"1H","30m":"30m","15m":"15m","5m":"5m","1m":"1m" };   // 8h 已移除

/* ── 手機 TF 選擇器：使用者自選最多 4 個要顯示的時間框（設定分頁設定；桌面顯示全部） ── */
const MOBILE_TF_MAX = 4;
const MOBILE_TF_ALL = ["1M","1w","1d","4h","2h","1h","30m","15m","5m","1m"];   // 順序＝按鈕列順序（8h 已移除）
let _mobileTFs = ["1d","4h","1h","15m"];   // 預設顯示的 4 個；由 loadMobileTFs() 從 localStorage 載入

