/* ═══════════════════════════════════════════════
   回測系統 — 前端  v8
   面板：主圖 | 成交量 | KDJ | RSI | MACD | 資金曲線(回測)
═══════════════════════════════════════════════ */

/* ── 預設顏色 ── */
const DEFAULT_COLORS = {
  up:      "#ef5350", down:    "#26a69a",
  bbU:     "#42a5f5", bbM:     "#ffcc02", bbL: "#42a5f5",
  kdjK:    "#f23645", kdjD:    "#1e88e5", kdjJ: "#ff9800",
  kdjH20:  "#4a4a6a", kdjH50:  "#666688", kdjH80:  "#4a4a6a",
  rsi14:   "#7e57c2", rsi7:    "#ef5350",
  rsiH30:  "#4a4a6a", rsiH50:  "#666688", rsiH70:  "#4a4a6a",
  macd:    "#2196f3", macdSig: "#ff9800",
  crtBull: "#26a69a", crtBear: "#ef5350",
  bg:      "#131722",
};

const DEFAULT_STYLES = {
  kdjHLWidth: 1,
  rsiHLWidth: 1,
  volMaPeriod: 5,
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
let volSeries, volMaSeries;          // 成交量放在 mainChart 的獨立價格軸
let kdjChart,    kdjK, kdjD, kdjJ, kdjH20, kdjH50, kdjH80;
let rsiChart,    rsiLine14, rsiLine7, rsiH30, rsiH50, rsiH70;
let macdChart,   macdLine, macdSignal, macdHist;
let kdjAnchor, rsiAnchor, macdAnchor;   // 透明錨定系列，確保時間軸對齊

/* ── 狀態 ── */
let currentChartType = "candlestick"; // candlestick | bar | line | area
let ohlcvData       = [];
let currentTF       = "1d";
let realtimeTimer   = null;
let lastCRTMarkers       = [];
let lastKDJCrossMarkers  = [];
let lastResonanceMarkers = [];
let paneCollapseFlex = {};  // 面板收合前的 flex 值（module-level，供 loadVisibilityPrefs 使用）
let _restoringPrefs  = false; // 還原偏好設定時，暫停自動儲存

const PANE_FLEX_DEFAULTS = { mainPane:5, kdjPane:1, rsiPane:1, macdPane:1 };

const TF_LABELS = { "1M":"月","1w":"週","1d":"日","4h":"4H","1h":"1H","15m":"15m" };

/* ── 時間轉 Unix 秒 ── */
function toTime(s) {
  if (!s) return 0;
  const iso = s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000);
}

/* ── hex + 透明度 ── */
function hexAlpha(hex, opacity) {
  const a = Math.round(Math.max(0, Math.min(100, opacity)) / 100 * 255)
    .toString(16).padStart(2, "0");
  return hex + a;
}

/* ── localStorage ── */
function savePrefs() {
  try {
    localStorage.setItem("chartColors",     JSON.stringify(C));
    localStorage.setItem("chartStyles",     JSON.stringify(S));
    localStorage.setItem("chartLineStyles", JSON.stringify(LINE_STYLES));
  } catch {}
}
function loadPrefs() {
  try {
    Object.assign(C, JSON.parse(localStorage.getItem("chartColors") || "{}"));
    Object.assign(S, JSON.parse(localStorage.getItem("chartStyles") || "{}"));
    Object.assign(LINE_STYLES, JSON.parse(localStorage.getItem("chartLineStyles") || "{}"));
  } catch {}
}

function saveLastSymbol() {
  try {
    localStorage.setItem("lastSymbol", JSON.stringify({
      symbol:   document.getElementById("symbolInput")?.value  || "",
      exchange: document.getElementById("exchangeSelect")?.value || "pionex",
      market:   document.getElementById("marketSelect")?.value  || "crypto",
      tf:       currentTF,
    }));
  } catch {}
}

function loadLastSymbol() {
  try {
    const last = JSON.parse(localStorage.getItem("lastSymbol") || "null");
    if (!last || !last.symbol) return;
    document.getElementById("symbolInput").value = last.symbol;
    if (last.exchange) document.getElementById("exchangeSelect").value = last.exchange;
    if (last.market)   document.getElementById("marketSelect").value   = last.market;
    if (last.tf && TF_LABELS[last.tf]) {
      currentTF = last.tf;
      document.querySelectorAll(".tf-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tf === currentTF));
    }
  } catch {}
}

/* 將 LINE_STYLES 中儲存的線寬 / 樣式套用到對應 series */
function applyLineStyle(inputId) {
  const getter = INPUT_SERIES_MAP[inputId];
  if (!getter) return;
  const series = getter();
  if (!series) return;
  const ls = LINE_STYLES[inputId];
  if (!ls) return;
  const opts = {};
  if (ls.width != null) opts.lineWidth  = ls.width;
  if (ls.style != null) opts.lineStyle  = ls.style;
  if (Object.keys(opts).length) series.applyOptions(opts);
}

/* 頁面載入後重新套用所有儲存的線條樣式 */
function applyAllLineStyles() {
  Object.keys(LINE_STYLES).forEach(applyLineStyle);
}

function savePaneFlexes() {
  if (_restoringPrefs) return;
  const flexes = {};
  Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
    const el  = document.getElementById(id);
    if (!el) return;
    const btn = document.querySelector(`.pane-collapse-btn[data-pane="${id}"]`);
    const isCollapsed = btn?.dataset.collapsed === "true";
    // 收合時儲存收合前的 flex；否則儲存目前 flex
    flexes[id] = isCollapsed
      ? (parseFloat(paneCollapseFlex[id]) || PANE_FLEX_DEFAULTS[id])
      : (parseFloat(el.style.flex)        || PANE_FLEX_DEFAULTS[id]);
  });
  try { localStorage.setItem("paneFlexes", JSON.stringify(flexes)); } catch {}
}

function loadPaneFlexes() {
  try {
    const saved = JSON.parse(localStorage.getItem("paneFlexes") || "{}");
    Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const flex = saved[id] ?? PANE_FLEX_DEFAULTS[id];
      el.style.flex = flex;
    });
  } catch {}
}

function saveVisibilityPrefs() {
  if (_restoringPrefs) return;  // 還原中不觸發儲存
  try {
    const hiddenLegs = [];
    document.querySelectorAll(".leg-toggle.line-off").forEach(el => {
      if (el.id) hiddenLegs.push(el.id);
    });
    const collapsedPanes = {};
    document.querySelectorAll(".pane-collapse-btn").forEach(btn => {
      if (btn.dataset.collapsed === "true")
        collapsedPanes[btn.dataset.pane] = paneCollapseFlex[btn.dataset.pane] || "1";
    });
    localStorage.setItem("hiddenLegs",     JSON.stringify(hiddenLegs));
    localStorage.setItem("collapsedPanes", JSON.stringify(collapsedPanes));
  } catch {}
}

function loadVisibilityPrefs() {
  _restoringPrefs = true;
  try {
    // 恢復隱藏的圖例線條
    const hiddenLegs = JSON.parse(localStorage.getItem("hiddenLegs") || "[]");
    hiddenLegs.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("line-off")) el.click();
    });
    // 恢復收合的面板
    const collapsedPanes = JSON.parse(localStorage.getItem("collapsedPanes") || "{}");
    for (const [paneId, flex] of Object.entries(collapsedPanes)) {
      paneCollapseFlex[paneId] = flex;
      const btn = document.querySelector(`.pane-collapse-btn[data-pane="${paneId}"]`);
      if (btn && btn.dataset.collapsed !== "true") btn.click();  // 未收合則點擊收合
    }
  } catch {}
  _restoringPrefs = false;
  saveVisibilityPrefs();  // 還原完成後統一儲存一次
}

/* ── 基礎圖表選項（showTime=true 才顯示時間軸，只有最下方的圖顯示）── */
function makeBaseOpts(scaleMargins = null, showTime = false) {
  const opts = {
    layout:    { background:{ color: C.bg }, textColor:"#d1d4dc" },
    grid:      { vertLines:{ color:"#2a2e39" }, horzLines:{ color:"#2a2e39" } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { style: 0, width: 1, color: "#758696", labelBackgroundColor: "#2a2e39" },
      horzLine: { style: 0, width: 1, color: "#758696", labelBackgroundColor: "#2a2e39" },
    },
    rightPriceScale: { borderColor:"#2a2e39" },
    timeScale: {
      borderColor: "#2a2e39",
      timeVisible: true,
      secondsVisible: false,
      visible: showTime,          // 只有最下方面板顯示時間座標
    },
  };
  if (scaleMargins) opts.rightPriceScale.scaleMargins = scaleMargins;
  return opts;
}

/* ══════════════════════════════════════════
   初始化
══════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  loadPrefs();

  const today = new Date();
  const ymd = d => [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-");
  const yearAgo = new Date(today); yearAgo.setFullYear(today.getFullYear() - 1);
  document.getElementById("endDate").value   = ymd(today);
  document.getElementById("startDate").value = ymd(yearAgo);

  loadLastSymbol();     // 還原上次標的、交易所、市場、時間框架
  loadSystemColors();
  applyAllSystemColors();
  loadSymHistory();
  loadPaneFlexes();   // 套用儲存的面板比例（在 buildCharts 前，讓第一次 resize 即正確）
  buildCharts();
  syncColorInputsToState();
  bindEvents();
  bindTickerPanel();
  bindSystemColors();
  initSymSearch();
  syncTimeScales();
  initDrawTools();
  updateMarketUI();
  applyAllColors();
  startTickerRefresh();
  loadData(true)
    .then(() => { loadVisibilityPrefs(); applyAllLineStyles(); })
    .catch(() => showToast("⚠️ 載入失敗，請點「載入」重試"));
});

/* ── 建立 / 重建主圖 series ── */
function createCandleSeries() {
  if (candleSeries) { try { mainChart.removeSeries(candleSeries); } catch {} candleSeries = null; }
  if (currentChartType === "candlestick") {
    candleSeries = mainChart.addCandlestickSeries({
      upColor: C.up, downColor: C.down,
      borderUpColor: C.up, borderDownColor: C.down,
      wickUpColor: C.up, wickDownColor: C.down,
    });
  } else if (currentChartType === "bar") {
    candleSeries = mainChart.addBarSeries({ upColor: C.up, downColor: C.down });
  } else if (currentChartType === "line") {
    candleSeries = mainChart.addLineSeries({ color: C.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  } else if (currentChartType === "area") {
    candleSeries = mainChart.addAreaSeries({
      lineColor: C.up, topColor: C.up + "30", bottomColor: C.up + "00",
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
  }
}

/* ── 將 ohlcv 資料套用到目前 series ── */
function applyOhlcvToSeries(data) {
  if (!candleSeries || !data.length) return;
  if (currentChartType === "candlestick" || currentChartType === "bar") {
    candleSeries.setData(data.map(d => ({
      time: d.time ? toTime(d.time) : d, open: d.open, high: d.high, low: d.low, close: d.close,
    })));
  } else {
    candleSeries.setData(data.map(d => ({ time: d.time ? toTime(d.time) : d, value: d.close })));
  }
}

/* ── 建立圖表 ── */
function buildCharts() {
  const base  = makeBaseOpts(null,                   false);
  const sub   = makeBaseOpts({ top:0.08, bottom:0.08 }, false);
  const volSM = makeBaseOpts({ top:0.05, bottom:0 },    false);
  const subT  = makeBaseOpts({ top:0.08, bottom:0.08 }, true);  // 最下方，顯示時間軸

  mainChart = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  createCandleSeries();
  bbU = mainChart.addLineSeries({ color:C.bbU, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  bbM = mainChart.addLineSeries({ color:C.bbM, lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });
  bbL = mainChart.addLineSeries({ color:C.bbL, lineWidth:1, priceLineVisible:false, lastValueVisible:false });

  // 成交量疊在主圖下方（獨立 priceScaleId，不影響 K 棒價格軸）
  volSeries   = mainChart.addHistogramSeries({ priceScaleId:"volume", priceLineVisible:false, lastValueVisible:false });
  volMaSeries = mainChart.addLineSeries({ priceScaleId:"volume", color:"#ffcc02", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.78, bottom:0 }, visible:false });

  kdjChart = LightweightCharts.createChart(document.getElementById("kdjChart"), sub);
  kdjAnchor = kdjChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjK  = kdjChart.addLineSeries({ color:C.kdjK, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjD  = kdjChart.addLineSeries({ color:C.kdjD, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjJ  = kdjChart.addLineSeries({ color:C.kdjJ, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjH20 = kdjChart.addLineSeries({ color:C.kdjH20, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH50 = kdjChart.addLineSeries({ color:C.kdjH50, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH80 = kdjChart.addLineSeries({ color:C.kdjH80, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), sub);
  rsiAnchor = rsiChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiLine14 = rsiChart.addLineSeries({ color:C.rsi14, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiLine7  = rsiChart.addLineSeries({ color:C.rsi7,  lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiH30 = rsiChart.addLineSeries({ color:C.rsiH30, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH50 = rsiChart.addLineSeries({ color:C.rsiH50, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH70 = rsiChart.addLineSeries({ color:C.rsiH70, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  macdChart = LightweightCharts.createChart(document.getElementById("macdChart"), subT);
  macdAnchor = macdChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdLine   = macdChart.addLineSeries({ color:C.macd,    lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdSignal = macdChart.addLineSeries({ color:C.macdSig, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdHist   = macdChart.addHistogramSeries({ priceScaleId:"right", priceLineVisible:false, lastValueVisible:false });

  const ro = new ResizeObserver(() => resizeAll());
  ro.observe(document.getElementById("chartsContainer"));
  // 等 DOM 完成 layout 後再 resize（rAF 兩次確保 flex 已計算完畢）
  requestAnimationFrame(() => requestAnimationFrame(resizeAll));
}

function resizeAll() {
  const container = document.getElementById("chartsContainer");
  const w = container.clientWidth;
  const charts = [
    [mainChart,   "mainChart"],
    [kdjChart,    "kdjChart"],
    [rsiChart,    "rsiChart"],
    [macdChart,   "macdChart"],
  ];
  charts.forEach(([chart, id]) => {
    const el = document.getElementById(id);
    if (!el || !chart) return;
    const h = el.clientHeight;
    if (h > 10) chart.resize(w, h);
  });
}

/* ── 時間軸 & 鉛直線同步 ── */
function syncTimeScales() {
  // 捲動 / 縮放：以 logical range 同步（anchor series 確保各圖索引一致）
  const allCharts = [mainChart, kdjChart, rsiChart, macdChart];
  let syncing = false;
  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      allCharts.forEach((dst, di) => { if (di !== si) dst.timeScale().setVisibleLogicalRange(range); });
      syncing = false;
    });
  });

  /* ── 鉛直線：線段統一放在 chartsContainer，動態計算每段的 top/height
     這樣每段可同時覆蓋 chart-pane + 下方的 pane-divider，完全無縫 ── */
  const panesConf = [
    { elId: "mainPane", chart: mainChart },
    { elId: "kdjPane",  chart: kdjChart  },
    { elId: "rsiPane",  chart: rsiChart  },
    { elId: "macdPane", chart: macdChart },
  ];
  const container = document.getElementById("chartsContainer");
  const lineEls = panesConf.map(() => {
    const ln = document.createElement("div");
    ln.className = "pane-vline";
    container.appendChild(ln);
    return ln;
  });

  // 底部時間標籤（鼠標在任意面板都顯示）
  const timeLabel = document.createElement("div");
  timeLabel.className = "crosshair-time-label";
  container.appendChild(timeLabel);

  let hideTimer = null;

  function positionLines(time, crosshairX) {
    // 優先用事件提供的 crosshairX（param.point.x），即十字線實際位置
    // 各子圖 price scale 寬度不同，若用 mainChart.timeToCoordinate 會有偏移
    const x = crosshairX ?? mainChart.timeScale().timeToCoordinate(time);
    if (x == null || x < 0) {
      lineEls.forEach(l => l.style.display = "none");
      timeLabel.style.display = "none";
      return;
    }

    // 底部時間標籤
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    let timeStr;
    if (currentTF === "4h" || currentTF === "1h" || currentTF === "15m") {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    } else {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    }
    timeLabel.textContent = timeStr;
    timeLabel.style.display = "block";
    timeLabel.style.left = Math.round(x) + "px";

    const cRect = container.getBoundingClientRect();
    panesConf.forEach(({ elId }, i) => {
      const pane = document.getElementById(elId);
      const ln   = lineEls[i];
      if (!pane || pane.classList.contains("hidden")) { ln.style.display = "none"; return; }
      if (pane.querySelector(".pane-body")?.style.display === "none") { ln.style.display = "none"; return; }

      const pRect = pane.getBoundingClientRect();
      let height  = pRect.height;

      // 往下延伸，覆蓋緊接的 pane-divider（若可見）
      const nextSib = pane.nextElementSibling;
      if (nextSib?.classList.contains("pane-divider") && !nextSib.classList.contains("hidden")) {
        height += nextSib.getBoundingClientRect().height;
      }

      ln.style.display = "block";
      ln.style.left    = Math.round(x) + "px";
      ln.style.top     = Math.round(pRect.top - cRect.top) + "px";
      ln.style.height  = Math.round(height) + "px";
    });
  }

  panesConf.forEach(({ chart }) => {
    chart.subscribeCrosshairMove(param => {
      clearTimeout(hideTimer);
      if (!param.time || !param.point) {
        hideTimer = setTimeout(() => {
          lineEls.forEach(l => l.style.display = "none");
          timeLabel.style.display = "none";
        }, 60);
        return;
      }
      positionLines(param.time, param.point.x);
      updateAllLegends(param.time);
    });
  });

  // 所有圖停用 LWC 原生鉛直線，改用 chartsContainer 內的自訂 pane-vline
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => {
    c.applyOptions({ crosshair: { vertLine: { visible: false } } });
  });
}

/* ══════════════════════════════════════════
   繪圖工具（Canvas Overlay）
══════════════════════════════════════════ */
let drawings    = [];
let drawingWIP  = null;
let drawCanvas  = null;
let drawCtx     = null;
let drawTool    = "pointer";
let selectedId  = null;
let hoveredId   = null;
let dragState   = null;   // { id, startX, startY, moved, snapshot }
let _mx = 0, _my = 0;
let _drawColor  = "#f5c518";  // 目前繪圖顏色

const DCP_COLORS = ["#f5c518","#ef5350","#26a69a","#2962ff","#ff9800","#7e57c2","#ec407a","#26c6da","#ffffff","#787b86"];
const DRAW_WIDTH  = 1.5;

function _did() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

function saveDrawings() {
  try { localStorage.setItem("tv_drawings", JSON.stringify(drawings)); } catch {}
}
function loadDrawings() {
  try {
    const s = JSON.parse(localStorage.getItem("tv_drawings") || "[]");
    drawings = Array.isArray(s) ? s.filter(d => d.id && d.type) : [];
  } catch { drawings = []; }
}

function findNearest(x, y, maxDist = 12) {
  let best = maxDist, found = null;
  drawings.forEach(d => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; found = d; }
  });
  return found;
}

function initDrawTools() {
  loadDrawings();

  const chartEl = document.getElementById("mainChart");
  chartEl.style.position = "relative";

  drawCanvas = document.createElement("canvas");
  // canvas 只做渲染，pointer-events 永遠 none，事件交給父容器
  drawCanvas.style.cssText = "position:absolute;top:0;left:0;z-index:20;pointer-events:none;";
  chartEl.appendChild(drawCanvas);
  drawCtx = drawCanvas.getContext("2d");

  const resize = () => {
    drawCanvas.width  = chartEl.clientWidth;
    drawCanvas.height = chartEl.clientHeight;
    requestAnimationFrame(renderDrawings);
  };
  resize();
  new ResizeObserver(resize).observe(chartEl);

  mainChart.timeScale().subscribeVisibleTimeRangeChange(() => requestAnimationFrame(renderDrawings));
  mainChart.subscribeCrosshairMove(() => requestAnimationFrame(renderDrawings));

  // 事件監聽全部掛在父容器（capture 優先），不攔截時讓 LWC 正常處理
  chartEl.addEventListener("mousemove",   _onChartMouseMove,   { capture: true });
  chartEl.addEventListener("mousedown",   _onChartMouseDown,   { capture: true });
  chartEl.addEventListener("click",       _onChartClick,       { capture: true });
  chartEl.addEventListener("dblclick",    _onChartDblClick,    { capture: true });
  chartEl.addEventListener("contextmenu", _onChartContextMenu, { capture: true });
  window.addEventListener("mouseup", _onChartMouseUp);

  // 點擊 popup 外部關閉（一般 bubble 即可）
  document.addEventListener("mousedown", e => {
    const popup = document.getElementById("drawColorPicker");
    if (popup && !popup.classList.contains("hidden") && !popup.contains(e.target)) {
      popup.classList.add("hidden");
    }
  });
}

function _canvasXY(e) {
  const r = drawCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function _updateCursor() {
  const chartEl = document.getElementById("mainChart");
  if (!chartEl) return;
  if (dragState) { chartEl.style.cursor = "grabbing"; return; }
  if (drawTool === "pointer") {
    chartEl.style.cursor = hoveredId ? "grab" : "";   // "" → 交回 LWC
  } else if (drawTool === "crosshair") {
    chartEl.style.cursor = "";
  } else if (drawTool === "eraser") {
    chartEl.style.cursor = "crosshair";
  } else {
    chartEl.style.cursor = "crosshair";
  }
}

function setDrawTool(tool) {
  drawTool = tool;
  selectedId = null;
  drawingWIP = null;
  document.getElementById("drawColorPicker")?.classList.add("hidden");
  _updateCursor();
  requestAnimationFrame(renderDrawings);
}

/* ── 事件處理（掛在 chartEl capture 上） ── */
function _onChartMouseMove(e) {
  const { x, y } = _canvasXY(e);
  _mx = x; _my = y;

  if (dragState) {
    e.stopPropagation();   // 拖移時不讓 LWC 處理 pan
    _updateDrag(x, y);
    return;
  }

  if (drawTool === "pointer" || drawTool === "eraser") {
    const near = findNearest(x, y);
    const nid  = near?.id ?? null;
    if (nid !== hoveredId) { hoveredId = nid; _updateCursor(); requestAnimationFrame(renderDrawings); }
  } else if (drawTool !== "crosshair") {
    requestAnimationFrame(renderDrawings);   // 預覽線
  }
  // crosshair / pointer 無 hover → 不攔截，LWC 正常顯示十字
}

function _onChartMouseDown(e) {
  if (e.button !== 0) return;
  const { x, y } = _canvasXY(e);

  // 只有 pointer 模式且滑鼠在線上才啟動拖移
  if (drawTool === "pointer") {
    const near = findNearest(x, y);
    if (near) {
      e.stopPropagation();   // 阻止 LWC pan
      selectedId = near.id;
      dragState  = { id: near.id, startX: x, startY: y, moved: false,
                     snapshot: JSON.parse(JSON.stringify(near)) };
      _updateCursor();
      requestAnimationFrame(renderDrawings);
    }
  }
  // 其他工具：讓 LWC 正常處理
}

function _onChartMouseUp() {
  if (!dragState) return;
  if (dragState.moved) saveDrawings();
  dragState = null;
  _updateCursor();
  requestAnimationFrame(renderDrawings);
}

function _onChartClick(e) {
  const { x, y } = _canvasXY(e);

  if (drawTool === "pointer") {
    if (dragState?.moved) return;
    const near = findNearest(x, y);
    if (near) {
      if (near.id === selectedId) {
        // 第二次點擊同一條線 → 開啟顏色面板
        showDrawColorPicker(near, e.clientX, e.clientY);
      } else {
        // 第一次點擊 → 選取，關閉舊面板
        document.getElementById("drawColorPicker")?.classList.add("hidden");
      }
      selectedId = near.id;
    } else {
      selectedId = null;
      document.getElementById("drawColorPicker")?.classList.add("hidden");
    }
    requestAnimationFrame(renderDrawings);
    return;
  }

  if (drawTool === "crosshair") return;

  // 繪圖工具：攔截 click 讓 LWC 不處理
  e.stopPropagation();

  const pt = screenToChart(x, y);
  if (!pt) return;

  if (drawTool === "eraser") { eraseNear(x, y); return; }

  if (drawTool === "hline") {
    drawings.push({ id:_did(), type:"hline", price:pt.price, color:_drawColor });
    saveDrawings(); requestAnimationFrame(renderDrawings); return;
  }
  if (drawTool === "vline") {
    drawings.push({ id:_did(), type:"vline", time:pt.time, color:_drawColor });
    saveDrawings(); requestAnimationFrame(renderDrawings); return;
  }
  if (drawTool === "text") {
    const txt = window.prompt("輸入文字：");
    if (txt?.trim()) {
      drawings.push({ id:_did(), type:"text", time:pt.time, price:pt.price, text:txt.trim(), color:_drawColor });
      saveDrawings();
    }
    requestAnimationFrame(renderDrawings); return;
  }

  // 雙點工具（trendline / ray / fib）
  if (!drawingWIP) {
    drawingWIP = { type:drawTool, p1:pt };
  } else {
    drawings.push({ id:_did(), type:drawTool, p1:drawingWIP.p1, p2:pt, color:_drawColor });
    drawingWIP = null;
    saveDrawings();
    requestAnimationFrame(renderDrawings);
  }
}

function _onChartDblClick(e) {
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (!near) return;
  e.stopPropagation();
  selectedId = near.id;
  showDrawColorPicker(near, e.clientX, e.clientY);
  requestAnimationFrame(renderDrawings);
}

function _onChartContextMenu(e) {
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (near) {
    e.preventDefault();
    e.stopPropagation();
    selectedId = near.id;
    showDrawColorPicker(near, e.clientX, e.clientY);
    requestAnimationFrame(renderDrawings);
    return;
  }
  if (drawTool === "crosshair" || drawTool === "pointer") return;
  e.preventDefault();
  e.stopPropagation();
  drawingWIP = null;
  requestAnimationFrame(renderDrawings);
}

/* ── 拖移 ── */
function _updateDrag(x, y) {
  if (!dragState) return;
  const d = drawings.find(d => d.id === dragState.id);
  if (!d) return;
  const dx = x - dragState.startX, dy = y - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) > 3) dragState.moved = true;
  if (!dragState.moved) return;
  const orig = dragState.snapshot;

  if (d.type === "hline") {
    const oy = candleSeries?.priceToCoordinate(orig.price);
    if (oy != null) d.price = candleSeries?.coordinateToPrice(oy + dy) ?? orig.price;
  } else if (d.type === "vline") {
    const ox = mainChart.timeScale().timeToCoordinate(orig.time);
    if (ox != null) { const nt = mainChart.timeScale().coordinateToTime(ox + dx); if (nt != null) d.time = nt; }
  } else if (d.type === "text") {
    const op = chartToScreen(orig.time, orig.price);
    if (op) { const np = screenToChart(op.x + dx, op.y + dy); if (np) { d.time = np.time; d.price = np.price; } }
  } else if (d.p1 && d.p2) {
    const a = chartToScreen(orig.p1.time, orig.p1.price);
    const b = chartToScreen(orig.p2.time, orig.p2.price);
    if (a && b) {
      const na = screenToChart(a.x + dx, a.y + dy);
      const nb = screenToChart(b.x + dx, b.y + dy);
      if (na) d.p1 = { time:na.time, price:na.price };
      if (nb) d.p2 = { time:nb.time, price:nb.price };
    }
  }
  requestAnimationFrame(renderDrawings);
}

/* ── 顏色 Popup ── */
function showDrawColorPicker(drawing, clientX, clientY) {
  const popup = document.getElementById("drawColorPicker");
  if (!popup) return;
  popup.dataset.drawingId = drawing.id;

  // 重建色塊（避免 listener 累積）
  const grid = popup.querySelector(".dcp-colors");
  const newGrid = document.createElement("div");
  newGrid.className = "dcp-colors";
  DCP_COLORS.forEach(c => {
    const sw = document.createElement("div");
    sw.className = "dcp-swatch" + (drawing.color === c ? " active" : "");
    sw.style.background = c;
    sw.addEventListener("mousedown", e => {
      e.stopPropagation();
      const d = drawings.find(d => d.id === popup.dataset.drawingId);
      if (!d) return;
      d.color = c;
      _drawColor = c;
      newGrid.querySelectorAll(".dcp-swatch").forEach(s => s.classList.toggle("active", s === sw));
      saveDrawings();
      requestAnimationFrame(renderDrawings);
    });
    newGrid.appendChild(sw);
  });
  grid.replaceWith(newGrid);

  // 重建刪除按鈕
  const delBtn = popup.querySelector(".dcp-delete");
  const newDel = delBtn.cloneNode(true);
  newDel.addEventListener("mousedown", e => {
    e.stopPropagation();
    const id = popup.dataset.drawingId;
    drawings = drawings.filter(d => d.id !== id);
    if (selectedId === id) selectedId = null;
    saveDrawings();
    popup.classList.add("hidden");
    requestAnimationFrame(renderDrawings);
  });
  delBtn.replaceWith(newDel);

  // 定位
  const pw = 190, ph = 110;
  let left = clientX + 12, top = clientY - 10;
  if (left + pw > window.innerWidth)  left = clientX - pw - 12;
  if (top  + ph > window.innerHeight) top  = window.innerHeight - ph - 8;
  if (top < 4) top = 4;
  popup.style.left = left + "px";
  popup.style.top  = top  + "px";
  popup.classList.remove("hidden");
}

function screenToChart(x, y) {
  const time  = mainChart.timeScale().coordinateToTime(x);
  const price = candleSeries?.coordinateToPrice(y);
  if (time == null || price == null) return null;
  return { x, y, time, price };
}

function chartToScreen(time, price) {
  const x = mainChart.timeScale().timeToCoordinate(time);
  const y = candleSeries?.priceToCoordinate(price);
  return (x != null && y != null && isFinite(x) && isFinite(y)) ? { x, y } : null;
}

function eraseNear(x, y) {
  let best = 14, idx = -1;
  drawings.forEach((d, i) => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; idx = i; }
  });
  if (idx >= 0) { drawings.splice(idx, 1); requestAnimationFrame(renderDrawings); }
}

function drawingDist(d, x, y) {
  if (d.type === "hline") {
    const py = candleSeries?.priceToCoordinate(d.price);
    return py != null ? Math.abs(py - y) : Infinity;
  }
  if (d.type === "vline") {
    const px = mainChart.timeScale().timeToCoordinate(d.time);
    return px != null ? Math.abs(px - x) : Infinity;
  }
  if (d.type === "text") {
    const p = chartToScreen(d.time, d.price);
    return p ? Math.hypot(p.x - x, p.y - y) : Infinity;
  }
  if (d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x-a.x)*dx+(y-a.y)*dy)/len2)) : 0;
    return Math.hypot(x-(a.x+t*dx), y-(a.y+t*dy));
  }
  return Infinity;
}

function renderDrawings() {
  if (!drawCtx || !drawCanvas) return;
  const W = drawCanvas.width, H = drawCanvas.height;
  drawCtx.clearRect(0, 0, W, H);

  // Draw non-selected first, then hovered, then selected on top
  drawings.filter(d => d.id !== selectedId && d.id !== hoveredId).forEach(d => drawOne(d, W, H, false, false));
  drawings.filter(d => d.id === hoveredId && d.id !== selectedId).forEach(d => drawOne(d, W, H, true, false));
  drawings.filter(d => d.id === selectedId).forEach(d => drawOne(d, W, H, false, true));

  if (drawingWIP) {
    const p1s = chartToScreen(drawingWIP.p1.time, drawingWIP.p1.price);
    if (p1s) drawPreview(drawingWIP.type, p1s, { x:_mx, y:_my }, W, H);
  }

  if (drawTool !== "pointer" && drawTool !== "crosshair") {
    drawCtx.save();
    drawCtx.strokeStyle = "rgba(200,200,200,0.22)";
    drawCtx.lineWidth = 1;
    drawCtx.setLineDash([4, 4]);
    drawCtx.beginPath();
    drawCtx.moveTo(_mx, 0); drawCtx.lineTo(_mx, H);
    drawCtx.moveTo(0, _my); drawCtx.lineTo(W, _my);
    drawCtx.stroke();
    drawCtx.restore();
  }
}

function _applyGlow(ctx, color, isSelected, isHovered) {
  if (isSelected) {
    ctx.shadowColor = color || "#f5c518";
    ctx.shadowBlur = 10;
    ctx.lineWidth = DRAW_WIDTH + 1;
  } else if (isHovered) {
    ctx.shadowColor = color || "#f5c518";
    ctx.shadowBlur = 5;
    ctx.lineWidth = DRAW_WIDTH + 0.5;
  }
}

function drawOne(d, W, H, isHovered, isSelected) {
  const col = d.color || DRAW_COLOR;
  drawCtx.save();
  drawCtx.strokeStyle = col;
  drawCtx.fillStyle   = col;
  drawCtx.lineWidth   = DRAW_WIDTH;
  drawCtx.setLineDash([]);
  _applyGlow(drawCtx, col, isSelected, isHovered);

  if (d.type === "hline") {
    const y = candleSeries?.priceToCoordinate(d.price);
    if (y == null || y < -5 || y > H + 5) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(W, y); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    drawCtx.font = "10px monospace";
    drawCtx.fillText(d.price.toFixed(4), 5, y - 3);
    if (isSelected) {
      drawCtx.fillStyle = "rgba(255,255,255,0.15)";
      drawCtx.fillRect(0, y - 6, W, 12);
      drawCtx.fillStyle = col;
      [W * 0.25, W * 0.5, W * 0.75].forEach(hx => {
        drawCtx.beginPath(); drawCtx.arc(hx, y, 4, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "vline") {
    const x = mainChart.timeScale().timeToCoordinate(d.time);
    if (x == null || x < -5 || x > W + 5) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(x, 0); drawCtx.lineTo(x, H); drawCtx.stroke();
    if (isSelected) {
      drawCtx.shadowBlur = 0;
      drawCtx.fillStyle = "rgba(255,255,255,0.15)";
      drawCtx.fillRect(x - 6, 0, 12, H);
      drawCtx.fillStyle = col;
      [H * 0.25, H * 0.5, H * 0.75].forEach(hy => {
        drawCtx.beginPath(); drawCtx.arc(x, hy, 4, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "trendline" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const dotR = isSelected ? 5 : 3;
    [a, b].forEach(p => { drawCtx.beginPath(); drawCtx.arc(p.x, p.y, dotR, 0, Math.PI*2); drawCtx.fill(); });
  }
  else if (d.type === "ray" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const dx = b.x - a.x, dy = b.y - a.y;
    const t  = dx ? (W - a.x) / dx : 0;
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const dotR = isSelected ? 5 : 3;
    drawCtx.beginPath(); drawCtx.arc(a.x, a.y, dotR, 0, Math.PI*2); drawCtx.fill();
  }
  else if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const priceRange = d.p2.price - d.p1.price;
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const extraW = isSelected ? W : 0;
    [[0,"#ef5350"],[0.236,"#ff9800"],[0.382,"#ffcc02"],[0.5,"#26a69a"],[0.618,"#26a69a"],[0.786,"#ff9800"],[1,"#ef5350"]].forEach(([lvl, lcol]) => {
      const price = d.p1.price + priceRange * (1 - lvl);
      const y = candleSeries?.priceToCoordinate(price);
      if (y == null) return;
      drawCtx.strokeStyle = lcol; drawCtx.lineWidth = (lvl===0||lvl===1) ? 1.5 : 1;
      drawCtx.setLineDash((lvl===0||lvl===1) ? [] : [5,3]);
      drawCtx.shadowBlur = isSelected ? 6 : 0; drawCtx.shadowColor = lcol;
      drawCtx.beginPath(); drawCtx.moveTo(x1, y); drawCtx.lineTo(x2 + extraW * 0.3, y); drawCtx.stroke();
      drawCtx.setLineDash([]); drawCtx.shadowBlur = 0;
      drawCtx.font = "10px monospace"; drawCtx.fillStyle = lcol;
      drawCtx.fillText(`${(lvl*100).toFixed(1)}%  ${price.toFixed(2)}`, x2+4, y+4);
    });
  }
  else if (d.type === "text") {
    const p = chartToScreen(d.time, d.price);
    if (!p) { drawCtx.restore(); return; }
    drawCtx.font = `bold ${isSelected ? 13 : 12}px sans-serif`;
    drawCtx.fillText(d.text, p.x + 5, p.y - 5);
    drawCtx.shadowBlur = 0;
    drawCtx.beginPath(); drawCtx.arc(p.x, p.y, isSelected ? 4 : 3, 0, Math.PI*2); drawCtx.fill();
    if (isSelected) {
      const m = drawCtx.measureText(d.text);
      drawCtx.strokeStyle = col; drawCtx.lineWidth = 1; drawCtx.setLineDash([3,2]);
      drawCtx.strokeRect(p.x + 3, p.y - 18, m.width + 6, 16);
      drawCtx.setLineDash([]);
    }
  }

  drawCtx.restore();
}

function drawPreview(type, a, b, W, H) {
  drawCtx.save();
  drawCtx.strokeStyle = "rgba(255,255,255,0.55)";
  drawCtx.lineWidth   = 1;
  drawCtx.setLineDash([5, 4]);
  drawCtx.beginPath();
  if (type === "ray") {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t  = dx ? (W - a.x) / dx : 0;
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy);
  } else {
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y);
  }
  drawCtx.stroke();
  drawCtx.restore();
}

/* ══════════════════════════════════════════
   顏色 / 樣式
══════════════════════════════════════════ */
function applyAllColors() {
  const bgOpt = { layout: { background:{ color: C.bg }, textColor:"#d1d4dc" } };
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c?.applyOptions(bgOpt));
  document.body.style.background = C.bg;

  if (currentChartType === "candlestick") {
    candleSeries.applyOptions({ upColor:C.up, downColor:C.down, borderUpColor:C.up, borderDownColor:C.down, wickUpColor:C.up, wickDownColor:C.down });
  } else if (currentChartType === "bar") {
    candleSeries.applyOptions({ upColor:C.up, downColor:C.down });
  } else if (currentChartType === "line") {
    candleSeries.applyOptions({ color:C.up });
  } else if (currentChartType === "area") {
    candleSeries.applyOptions({ lineColor:C.up, topColor:C.up+"30", bottomColor:C.up+"00" });
  }
  bbU.applyOptions({ color:C.bbU }); bbM.applyOptions({ color:C.bbM }); bbL.applyOptions({ color:C.bbL });
  kdjK.applyOptions({ color:C.kdjK }); kdjD.applyOptions({ color:C.kdjD }); kdjJ.applyOptions({ color:C.kdjJ });
  kdjH20.applyOptions({ color:C.kdjH20, lineWidth:S.kdjHLWidth });
  kdjH50.applyOptions({ color:C.kdjH50, lineWidth:S.kdjHLWidth });
  kdjH80.applyOptions({ color:C.kdjH80, lineWidth:S.kdjHLWidth });
  rsiLine14.applyOptions({ color:C.rsi14 }); rsiLine7.applyOptions({ color:C.rsi7 });
  rsiH30.applyOptions({ color:C.rsiH30, lineWidth:S.rsiHLWidth });
  rsiH50.applyOptions({ color:C.rsiH50, lineWidth:S.rsiHLWidth });
  rsiH70.applyOptions({ color:C.rsiH70, lineWidth:S.rsiHLWidth });
  macdLine.applyOptions({ color:C.macd }); macdSignal.applyOptions({ color:C.macdSig });

  if (ohlcvData.length > 0) { renderCRT(ohlcvData); renderVolume(ohlcvData); }

  document.getElementById("legK").style.color      = C.kdjK;
  document.getElementById("legD").style.color      = C.kdjD;
  document.getElementById("legJ").style.color      = C.kdjJ;
  document.getElementById("legRsi14").style.color  = C.rsi14;
  document.getElementById("legRsi7").style.color   = C.rsi7;
  document.getElementById("legCRT").style.color    = C.crtBull;
  document.getElementById("legMacd").style.color   = C.macd;
  document.getElementById("legMacdSig").style.color = C.macdSig;

  savePrefs();
}

function syncColorInputsToState() {
  const colorMap = {
    "c-up":C.up,"c-down":C.down,"c-bbU":C.bbU,"c-bbM":C.bbM,"c-bbL":C.bbL,
    "c-kdjK":C.kdjK,"c-kdjD":C.kdjD,"c-kdjJ":C.kdjJ,
    "c-kdjH20":C.kdjH20,"c-kdjH50":C.kdjH50,"c-kdjH80":C.kdjH80,
    "c-rsi14":C.rsi14,"c-rsi7":C.rsi7,
    "c-rsiH30":C.rsiH30,"c-rsiH50":C.rsiH50,"c-rsiH70":C.rsiH70,
    "c-macd":C.macd,"c-macdSig":C.macdSig,
    "c-crtBull":C.crtBull,"c-crtBear":C.crtBear,"c-bg":C.bg,
  };
  for (const [id, val] of Object.entries(colorMap)) {
    const el = document.getElementById(id); if (el) el.value = val;
  }
  const styleMap = { "w-kdjHL":S.kdjHLWidth, "w-rsiHL":S.rsiHLWidth, "volMaPeriod":S.volMaPeriod };
  for (const [id, val] of Object.entries(styleMap)) {
    const el = document.getElementById(id); if (el) el.value = val;
  }
}

function bindColorInputs() {
  const colorKeys = {
    "c-up":"up","c-down":"down","c-bbU":"bbU","c-bbM":"bbM","c-bbL":"bbL",
    "c-kdjK":"kdjK","c-kdjD":"kdjD","c-kdjJ":"kdjJ",
    "c-kdjH20":"kdjH20","c-kdjH50":"kdjH50","c-kdjH80":"kdjH80",
    "c-rsi14":"rsi14","c-rsi7":"rsi7",
    "c-rsiH30":"rsiH30","c-rsiH50":"rsiH50","c-rsiH70":"rsiH70",
    "c-macd":"macd","c-macdSig":"macdSig",
    "c-crtBull":"crtBull","c-crtBear":"crtBear","c-bg":"bg",
  };
  // _cpColor 由自訂調色盤設置（含透明度），fallback 回 input.value
  for (const [id, key] of Object.entries(colorKeys))
    document.getElementById(id)?.addEventListener("input", e => { C[key] = e.target._cpColor || e.target.value; applyAllColors(); });

  const styleKeys = { "w-kdjHL":"kdjHLWidth", "w-rsiHL":"rsiHLWidth", "volMaPeriod":"volMaPeriod" };
  for (const [id, key] of Object.entries(styleKeys))
    document.getElementById(id)?.addEventListener("input", e => {
      S[key] = parseInt(e.target.value);
      applyAllColors();
      if (key === "volMaPeriod" && ohlcvData.length) renderVolume(ohlcvData);
    });

  document.getElementById("resetColors")?.addEventListener("click", () => {
    C = { ...DEFAULT_COLORS }; S = { ...DEFAULT_STYLES };
    syncColorInputsToState();
    syncTriggerColors();
    applyAllColors();
  });
}

/* 同步自訂調色盤觸發器的顏色（重設後呼叫） */
function syncTriggerColors() {
  document.querySelectorAll(".color-panel input[type='color'].cp-hidden").forEach(inp => {
    inp._cpColor = null;
    const tr = inp.previousElementSibling;
    if (tr?.classList.contains("cp-trigger")) tr.style.background = inp.value;
  });
}

/* ══════════════════════════════════════════
   自訂調色盤
══════════════════════════════════════════ */
function initColorPicker() {
  /* ── 色盤定義 ── */
  const GRAYS = ["#ffffff","#e8e8e8","#d0d0d0","#b0b0b0","#888888","#666666","#444444","#2c2c2c","#1a1a1a","#000000"];
  const HUES  = [0, 30, 60, 120, 160, 185, 210, 240, 270, 330];
  // [saturation%, lightness%]
  const ROWS  = [[60,90],[70,80],[75,70],[80,60],[85,50],[80,40],[75,30],[65,20]];

  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2,"0")).join("");
  }

  /* ── 建立 popup ── */
  const popup = document.createElement("div");
  popup.id = "cpPopup"; popup.className = "cp-popup";

  // 色塊格
  const grid = document.createElement("div"); grid.className = "cp-grid";
  const grayRow = document.createElement("div"); grayRow.className = "cp-row";
  GRAYS.forEach(c => grayRow.appendChild(makeSwatch(c)));
  grid.appendChild(grayRow);
  const hr = document.createElement("div"); hr.className = "cp-divider";
  grid.appendChild(hr);
  ROWS.forEach(([s, l]) => {
    const row = document.createElement("div"); row.className = "cp-row";
    HUES.forEach(h => row.appendChild(makeSwatch(hsl2hex(h, s, l))));
    grid.appendChild(row);
  });
  popup.appendChild(grid);

  // 底部列：「+」自訂色
  const footer = document.createElement("div"); footer.className = "cp-footer";
  const addBtn = document.createElement("button"); addBtn.className = "cp-add-btn"; addBtn.type = "button"; addBtn.textContent = "+";
  const nativeInput = document.createElement("input"); nativeInput.type = "color"; nativeInput.style.display = "none";
  addBtn.addEventListener("click", () => { nativeInput.value = currentHex; nativeInput.click(); });
  nativeInput.addEventListener("input", () => { currentHex = nativeInput.value; applyColor(); });
  footer.append(addBtn, nativeInput);
  popup.appendChild(footer);

  // 透明度列
  const opWrap  = document.createElement("div"); opWrap.className = "cp-opacity-wrap";
  const opLabel = document.createElement("div"); opLabel.className = "cp-opacity-label"; opLabel.textContent = "不透明度";
  const opRow   = document.createElement("div"); opRow.className = "cp-opacity-row";
  const opSlider = document.createElement("input"); opSlider.type = "range";
  opSlider.className = "cp-opacity-slider"; opSlider.min = 0; opSlider.max = 100; opSlider.value = 100;
  const opNum = document.createElement("input"); opNum.type = "number";
  opNum.className = "cp-opacity-num"; opNum.min = 0; opNum.max = 100; opNum.value = 100;
  const opPct = document.createElement("span"); opPct.className = "cp-opacity-pct"; opPct.textContent = "%";
  opSlider.addEventListener("input", () => { opNum.value = opSlider.value; applyColor(); });
  opNum.addEventListener("input",   () => { opSlider.value = opNum.value; applyColor(); });
  opRow.append(opSlider, opNum, opPct);
  opWrap.append(opLabel, opRow);
  popup.appendChild(opWrap);

  // 厚度選擇
  const thickWrap = document.createElement("div"); thickWrap.className = "cp-section";
  const thickLabel = document.createElement("div"); thickLabel.className = "cp-opacity-label"; thickLabel.textContent = "厚度";
  const thickRow = document.createElement("div"); thickRow.className = "cp-btn-row";
  const WIDTHS = [1, 2, 3, 4];
  let activeWidthBtn = null;
  const widthBtns = WIDTHS.map(w => {
    const btn = document.createElement("button"); btn.className = "cp-line-btn"; btn.type = "button";
    btn.dataset.value = w;
    const inner = document.createElement("div");
    inner.style.cssText = `height:${w * 2}px;background:#d1d4dc;border-radius:1px;margin:auto;width:70%`;
    btn.appendChild(inner);
    btn.addEventListener("click", () => {
      activeWidthBtn?.classList.remove("active");
      btn.classList.add("active"); activeWidthBtn = btn;
      applyColor();
    });
    thickRow.appendChild(btn); return btn;
  });
  thickWrap.append(thickLabel, thickRow);
  popup.appendChild(thickWrap);

  // 線條樣式選擇（solid / dashed / dotted）
  const styleWrap = document.createElement("div"); styleWrap.className = "cp-section";
  const styleLabel = document.createElement("div"); styleLabel.className = "cp-opacity-label"; styleLabel.textContent = "線條樣式";
  const styleRow = document.createElement("div"); styleRow.className = "cp-btn-row";
  // LWC lineStyle: 0=Solid, 2=Dashed, 1=Dotted
  const STYLES = [
    { value: 0, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2"/></svg>` },
    { value: 2, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2" stroke-dasharray="6,4"/></svg>` },
    { value: 1, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2" stroke-dasharray="2,3"/></svg>` },
  ];
  let activeStyleBtn = null;
  const styleBtns = STYLES.map(({ value, svg }) => {
    const btn = document.createElement("button"); btn.className = "cp-line-btn"; btn.type = "button";
    btn.dataset.value = value; btn.innerHTML = svg;
    btn.addEventListener("click", () => {
      activeStyleBtn?.classList.remove("active");
      btn.classList.add("active"); activeStyleBtn = btn;
      applyColor();
    });
    styleRow.appendChild(btn); return btn;
  });
  styleWrap.append(styleLabel, styleRow);
  popup.appendChild(styleWrap);

  document.body.appendChild(popup);

  /* ── 狀態 ── */
  let currentInput  = null;
  let currentHex    = "#ffffff";
  let currentSwatch = null;
  let currentWidth  = null;   // null = 不覆寫（此 input 不支援寬度）
  let currentStyle  = null;

  function makeSwatch(color) {
    const sw = document.createElement("div"); sw.className = "cp-swatch";
    sw.style.background = color; sw.dataset.color = color;
    sw.addEventListener("click", () => {
      currentHex = color;
      applyColor();
      if (currentSwatch) currentSwatch.classList.remove("selected");
      currentSwatch = sw; sw.classList.add("selected");
    });
    return sw;
  }

  function applyColor() {
    if (!currentInput) return;
    const pct = parseInt(opSlider.value);
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    const finalColor = pct >= 100 ? currentHex : hexAlpha(currentHex, pct);
    currentInput._cpColor = finalColor;
    currentInput.value    = currentHex;
    const tr = currentInput.previousElementSibling;
    if (tr?.classList.contains("cp-trigger")) tr.style.background = finalColor;
    // 線寬 / 線型
    const inputId = currentInput.id;
    if (INPUT_SERIES_MAP[inputId]) {
      const w = activeWidthBtn ? parseInt(activeWidthBtn.dataset.value) : null;
      const s = activeStyleBtn ? parseInt(activeStyleBtn.dataset.value) : null;
      currentInput._cpWidth = w; currentInput._cpStyle = s;
      LINE_STYLES[inputId] = { width: w, style: s };
      applyLineStyle(inputId);
      savePrefs();
    }
    currentInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function show(input, triggerEl) {
    if (currentInput && currentInput !== input) closePicker();
    currentInput = input;
    currentHex   = (input.value || "#ffffff").substring(0, 7);
    opSlider.value = 100; opNum.value = 100;
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    // 標記已選色塊
    if (currentSwatch) currentSwatch.classList.remove("selected");
    currentSwatch = null;
    popup.querySelectorAll(".cp-swatch").forEach(sw => {
      if (sw.dataset.color.toLowerCase() === currentHex.toLowerCase()) {
        sw.classList.add("selected"); currentSwatch = sw;
      }
    });
    // 線寬 / 線型：只對支援的 series 顯示，並恢復儲存狀態
    const supportsStyle = !!INPUT_SERIES_MAP[input.id];
    thickWrap.style.display = supportsStyle ? "" : "none";
    styleWrap.style.display = supportsStyle ? "" : "none";
    if (supportsStyle) {
      const saved = LINE_STYLES[input.id] || {};
      activeWidthBtn?.classList.remove("active"); activeWidthBtn = null;
      activeStyleBtn?.classList.remove("active"); activeStyleBtn = null;
      const w = saved.width ?? 1;
      const s = saved.style ?? 0;
      widthBtns.forEach(b => { if (parseInt(b.dataset.value) === w) { b.classList.add("active"); activeWidthBtn = b; } });
      styleBtns.forEach(b => { if (parseInt(b.dataset.value) === s) { b.classList.add("active"); activeStyleBtn = b; } });
    }
    // 定位
    const rect = triggerEl.getBoundingClientRect();
    let top  = rect.bottom + 6;
    let left = rect.left;
    if (left + 232 > window.innerWidth)  left = window.innerWidth - 236;
    if (top  + 380 > window.innerHeight) top  = rect.top - 380 - 6;
    popup.style.top  = top  + "px";
    popup.style.left = left + "px";
    popup.classList.add("open");
    triggerEl.classList.add("cp-open");
  }

  function closePicker() {
    popup.classList.remove("open");
    document.querySelectorAll(".cp-trigger.cp-open").forEach(t => t.classList.remove("cp-open"));
    currentInput = null;
  }

  document.addEventListener("mousedown", e => {
    if (!popup.classList.contains("open")) return;
    if (popup.contains(e.target) || e.target.classList.contains("cp-trigger")) return;
    closePicker();
  });

  /* ── 替換 .color-panel 內所有 input[type=color] ── */
  document.querySelectorAll(".color-panel input[type='color']").forEach(inp => {
    const trigger = document.createElement("div");
    trigger.className = "cp-trigger";
    trigger.style.background = inp.value;
    inp.classList.add("cp-hidden");
    inp.parentElement.insertBefore(trigger, inp);
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      if (popup.classList.contains("open") && currentInput === inp) { closePicker(); return; }
      show(inp, trigger);
    });
  });
}

/* ══════════════════════════════════════════
   事件綁定
══════════════════════════════════════════ */
function bindEvents() {
  document.getElementById("marketSelect").addEventListener("change", updateMarketUI);
  document.getElementById("loadBtn").addEventListener("click", () => loadData(false));

  // ── 側欄 / 行情列表 ──────────────────────────────
  const isMobile = () => window.innerWidth <= 768;
  function openSidebar()  { document.getElementById("sidebar").classList.add("sidebar-open");     showOverlay(); }
  function closeSidebar() { document.getElementById("sidebar").classList.remove("sidebar-open"); checkOverlay(); }
  function openTicker()   { document.getElementById("tickerPanel").classList.add("ticker-open");  showOverlay(); }
  function closeTicker()  { document.getElementById("tickerPanel").classList.remove("ticker-open"); checkOverlay(); }
  function showOverlay()  { document.getElementById("panelOverlay").classList.remove("hidden"); }
  function checkOverlay() {
    const sideOpen   = document.getElementById("sidebar").classList.contains("sidebar-open");
    const tickerOpen = document.getElementById("tickerPanel").classList.contains("ticker-open");
    if (!sideOpen && !tickerOpen) document.getElementById("panelOverlay").classList.add("hidden");
  }
  function closeAllPanels() { closeSidebar(); closeTicker(); }

  // sidebar toggle：手機版為抽屜，桌面版為摺疊
  document.getElementById("sidebarToggle").addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    if (isMobile()) {
      sidebar.classList.contains("sidebar-open") ? closeSidebar() : openSidebar();
    } else {
      sidebar.classList.toggle("sidebar-collapsed");
      setTimeout(resizeAll, 220);
    }
  });
  document.getElementById("tickerToggle")?.addEventListener("click", () => {
    if (isMobile()) {
      const open = document.getElementById("tickerPanel").classList.contains("ticker-open");
      open ? closeTicker() : openTicker();
    } else {
      document.getElementById("tickerPanel").classList.toggle("ticker-collapsed");
      setTimeout(resizeAll, 50);
    }
  });
  document.getElementById("panelOverlay").addEventListener("click", closeAllPanels);

  document.getElementById("tickerList").addEventListener("click", () => {
    if (isMobile()) closeTicker();
  }, true);

  // 重播模式切換
  document.getElementById("replayModeBtn").addEventListener("click", () => {
    if (!ohlcvData.length) return alert("請先載入資料再使用重播");
    enterReplay();
  });

  // ── 圖表類型切換 ──────────────────────────────
  document.querySelectorAll(".ct-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.ct;
      if (type === currentChartType) return;
      currentChartType = type;
      document.querySelectorAll(".ct-btn").forEach(b => b.classList.toggle("active", b.dataset.ct === type));
      createCandleSeries();
      if (ohlcvData.length) {
        applyOhlcvToSeries(ohlcvData);
        candleSeries.setMarkers(lastCRTMarkers);
      }
      syncTimeScales();
    });
  });

  // ── 繪圖工具欄 ──────────────────────────────
  document.querySelectorAll(".dt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      setDrawTool(btn.dataset.tool);
    });
  });
  // Esc 回到 pointer / 取消進行中的繪圖
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("symOverlay").classList.contains("hidden")) return;
    if (e.key === "Escape") {
      if (replayActive) { exitReplay(); return; }
      if (drawingWIP) { drawingWIP = null; requestAnimationFrame(renderDrawings); }
      document.querySelectorAll(".dt-btn").forEach(b => b.classList.remove("active"));
      document.querySelector(".dt-btn[data-tool='pointer']")?.classList.add("active");
      setDrawTool("pointer");
    }
    if (e.key === " " && replayActive && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      replayPlay();
    }
    if (e.key === "ArrowRight" && replayActive) { e.preventDefault(); replayStepForward(); }
    if (e.key === "ArrowLeft"  && replayActive) { e.preventDefault(); replayStepBack(); }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      drawings = drawings.filter(d => d.id !== selectedId);
      selectedId = null;
      document.getElementById("drawColorPicker")?.classList.add("hidden");
      saveDrawings();
      requestAnimationFrame(renderDrawings);
    }
  });

  // ── 指標按鈕（展開/收合外觀顏色面板）──────────────────
  document.getElementById("indicatorsToggle")?.addEventListener("click", () => {
    const btn    = document.getElementById("indicatorsToggle");
    const sidebar = document.getElementById("sidebar");
    const panel  = document.getElementById("colorPanel");
    const arrow  = document.getElementById("colorToggle")?.querySelector(".toggle-arrow");
    // 展開 sidebar（桌面版）
    sidebar.classList.remove("sidebar-collapsed");
    // 展開顏色面板
    if (panel.classList.contains("hidden")) {
      panel.classList.remove("hidden");
      if (arrow) arrow.classList.add("open");
    }
    btn.classList.toggle("active", !panel.classList.contains("hidden"));
    setTimeout(resizeAll, 220);
  });

  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTF = btn.dataset.tf;
      loadData(false);   // 切換時區自動載入，不需手動按「載入」
    });
  });

  document.getElementById("colorToggle").addEventListener("click", () => {
    document.getElementById("colorPanel").classList.toggle("hidden");
    document.querySelector(".toggle-arrow").classList.toggle("open");
  });

  bindColorInputs();
  bindPaneDividers();
  bindLegendToggles();
  initColorPicker();
  bindReplayBar();
}

function updateMarketUI() {
  const market   = document.getElementById("marketSelect").value;
  const isCrypto = market === "crypto";
  const isUS     = market === "us";
  const isTW     = market === "tw";

  document.getElementById("exchangeSelect").style.display = isCrypto ? "" : "none";

  if (isCrypto) {
    document.getElementById("symbolInput").placeholder = "BTC/USDT";
    document.getElementById("symbolInput").value       = "BTC/USDT";
  } else if (isUS) {
    document.getElementById("symbolInput").placeholder = "AAPL";
    document.getElementById("symbolInput").value       = "AAPL";
  } else {
    document.getElementById("symbolInput").placeholder = "2330";
    document.getElementById("symbolInput").value       = "2330";
  }

  // 美股與台股都不支援 4h/15m（yfinance 4h 僅限 60 天）
  document.querySelectorAll(".tf-btn").forEach(btn => {
    const off = (isTW && ["4h","1h","15m"].includes(btn.dataset.tf)) ||
                (isUS && ["15m"].includes(btn.dataset.tf));
    btn.disabled = off;
    if (off && btn.classList.contains("active")) {
      btn.classList.remove("active");
      document.querySelector(".tf-btn[data-tf='1d']").classList.add("active");
      currentTF = "1d";
    }
  });

  // 符號搜尋 modal tabs：crypto 顯示 futures/spot，美股顯示 us tab，台股隱藏
  const tabFutures = document.querySelector(".sym-tab[data-market='futures']");
  const tabSpot    = document.querySelector(".sym-tab[data-market='spot']");
  const tabUS      = document.querySelector(".sym-tab[data-market='us']");
  if (tabFutures) tabFutures.style.display = isCrypto ? "" : "none";
  if (tabSpot)    tabSpot.style.display    = isCrypto ? "" : "none";
  if (tabUS)      tabUS.style.display      = isUS ? "" : "none";
}

/* ── 面板拖曳分隔 ── */
function bindPaneDividers() {
  document.querySelectorAll(".pane-divider").forEach(divider => {
    let startY, startFlex, nextFlex, pane, nextPane;
    divider.addEventListener("mousedown", e => {
      e.preventDefault();
      pane     = document.getElementById(divider.dataset.target);
      nextPane = nextVisiblePane(pane);
      if (!nextPane) return;
      startY    = e.clientY;
      startFlex = parseFloat(pane.style.flex)     || 1;
      nextFlex  = parseFloat(nextPane.style.flex) || 1;
      divider.classList.add("dragging");
      const onMove = e => {
        const dy    = e.clientY - startY;
        const total = pane.parentElement.clientHeight;
        const delta = (dy / total) * (startFlex + nextFlex);
        pane.style.flex     = Math.max(0.2, startFlex + delta);
        nextPane.style.flex = Math.max(0.2, nextFlex  - delta);
        resizeAll();
      };
      const onUp = () => {
        divider.classList.remove("dragging");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
        savePaneFlexes();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });
  });
}

/* ── 動態把時間軸移到最下方可見面板 ── */
function updateBottomTimeAxis() {
  // 由下而上排列（第一個找到的 = 當前最底部可見面板）
  const panels = [
    { paneId: "macdPane",   chart: macdChart   },
    { paneId: "rsiPane",    chart: rsiChart    },
    { paneId: "kdjPane",    chart: kdjChart    },
    { paneId: "mainPane",   chart: mainChart   },
  ];
  let bottomChart = null;
  for (const { paneId, chart } of panels) {
    const pane = document.getElementById(paneId);
    if (!pane || pane.classList.contains("hidden")) continue;
    const body = pane.querySelector(".pane-body");
    if (body && body.style.display === "none") continue; // 已收合
    bottomChart = chart;
    break;
  }
  panels.forEach(({ chart }) => {
    chart.applyOptions({ timeScale: { visible: chart === bottomChart } });
  });
}

/* ── 圖例點擊切換線條 + 面板收合 ── */
function bindLegendToggles() {
  // 線條切換：點擊 leg-item 顯示/隱藏對應系列
  const lineMap = [
    { id: "legBB",       series: () => [bbU, bbM, bbL] },
    { id: "legCRT",      series: null,  action: () => _applyMainMarkers() },
    { id: "legKDJCross", series: null,  action: () => _applyMainMarkers() },
    { id: "legResonance",series: null,  action: () => _applyMainMarkers() },
    { id: "legVol",      series: () => [volSeries, volMaSeries] },
    { id: "legK",        series: () => [kdjK] },
    { id: "legD",        series: () => [kdjD] },
    { id: "legJ",        series: () => [kdjJ] },
    { id: "legRsi14",    series: () => [rsiLine14] },
    { id: "legRsi7",     series: () => [rsiLine7] },
    { id: "legMacd",     series: () => [macdLine] },
    { id: "legMacdSig",  series: () => [macdSignal] },
    { id: "legMacdHist", series: () => [macdHist] },
  ];
  lineMap.forEach(({ id, series, action }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      const hidden = el.classList.toggle("line-off");
      if (action) action(hidden);
      else series()?.forEach(s => s.applyOptions({ visible: !hidden }));
      saveVisibilityPrefs();
    });
  });

  // 面板收合：點擊「−」縮至只剩圖例列；點「+」展開
  document.querySelectorAll(".pane-collapse-btn").forEach(btn => {
    btn.dataset.collapsed = "false";  // 初始化屬性
    const paneId = btn.dataset.pane;
    btn.addEventListener("click", () => {
      const pane = document.getElementById(paneId);
      const body = pane.querySelector(".pane-body");
      const collapsed = btn.dataset.collapsed === "true";
      if (collapsed) {
        pane.style.flex = paneCollapseFlex[paneId] || "1";
        body.style.display = "";
        btn.dataset.collapsed = "false";
        btn.textContent = "\u2212";  // −
      } else {
        paneCollapseFlex[paneId] = pane.style.flex || "1";
        pane.style.flex = "0";
        body.style.display = "none";
        btn.dataset.collapsed = "true";
        btn.textContent = "+";
      }
      updateBottomTimeAxis();
      resizeAll();
      saveVisibilityPrefs();
      savePaneFlexes();
    });
  });
}

function nextVisiblePane(el) {
  let sib = el.nextElementSibling;
  while (sib) {
    if (sib.classList.contains("pane-divider")) { sib = sib.nextElementSibling; continue; }
    if (sib.classList.contains("chart-pane") && !sib.classList.contains("hidden")) return sib;
    sib = sib.nextElementSibling;
  }
  return null;
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
async function loadData(autoLoad = false) {
  stopRealtime();

  // 子日線時區資料量大，自動縮短起始日避免逾時
  if (!autoLoad) {
    const TF_MAX_DAYS = { "4h": 365, "1h": 90, "15m": 30 };
    const maxDays = TF_MAX_DAYS[currentTF];
    if (maxDays) {
      const startEl = document.getElementById("startDate");
      const endEl   = document.getElementById("endDate");
      if (startEl.value && endEl.value) {
        const endMs   = new Date(endEl.value).getTime();
        const startMs = new Date(startEl.value).getTime();
        if ((endMs - startMs) / 86400000 > maxDays) {
          const newStart = new Date(endMs - maxDays * 86400000).toISOString().slice(0, 10);
          startEl.value = newStart;
          showToast(`⚠️ ${TF_LABELS[currentTF]} 時區最多載入 ${maxDays} 天，起始日已調整為 ${newStart}`);
        }
      }
    }
  }

  showLoading(true);
  try {
    const res  = await fetch("/api/ohlcv", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(buildPayload(autoLoad)),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "載入失敗");
    ohlcvData = json.data;
    renderAll(json.data);
    startRealtime();
    saveLastSymbol();   // 載入成功後記憶此次標的
  } catch(e) {
    if (!autoLoad) alert("❌ " + e.message);
    throw e;
  } finally { showLoading(false); }
}


/* ══════════════════════════════════════════
   渲染
══════════════════════════════════════════ */
function renderAll(data) {
  // 先把錨定系列設到完整時間範圍，確保各子圖時間軸對齊
  const anchorTimes = data.map(d => ({ time: toTime(d.time), value: 50 }));
  kdjAnchor.setData(anchorTimes);
  rsiAnchor.setData(anchorTimes);
  macdAnchor.setData(anchorTimes.map(d => ({ ...d, value: 0 })));

  renderCandles(data);
  renderBB(data);
  renderCRT(data);
  renderKDJCross(data);
  renderResonance(data);
  renderVolume(data);
  renderKDJ(data);
  renderRSI(data);
  renderMACD(data);
  updateSymbolBar(data);

  // fit 讓各子圖時間範圍對齊
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().fitContent());

  // 顯示最後 50 根（logical range，anchor series 確保各圖索引對齊）
  if (data.length > 50) {
    mainChart.timeScale().setVisibleLogicalRange({ from: data.length - 50, to: data.length - 1 });
  }

  resizeAll();
}

function renderCandles(data) {
  applyOhlcvToSeries(data);
  lastCRTMarkers = []; lastKDJCrossMarkers = []; lastResonanceMarkers = [];
  candleSeries.setMarkers([]);
}

function renderBB(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  bbU.setData(line("bb_upper")); bbM.setData(line("bb_middle")); bbL.setData(line("bb_lower"));
}

function _applyMainMarkers() {
  const crtHidden       = document.getElementById("legCRT")?.classList.contains("line-off");
  const kdjCrossHidden  = document.getElementById("legKDJCross")?.classList.contains("line-off");
  const resonanceHidden = document.getElementById("legResonance")?.classList.contains("line-off");
  const all = [
    ...(crtHidden       ? [] : lastCRTMarkers),
    ...(kdjCrossHidden  ? [] : lastKDJCrossMarkers),
    ...(resonanceHidden ? [] : lastResonanceMarkers),
  ].sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(all);
}

function renderCRT(data) {
  const markers = [];
  data.forEach(d => {
    if (d.crt === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.crtBull, shape:"arrowUp",   size:1.5, text:"" });
    if (d.crt === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.crtBear, shape:"arrowDown", size:1.5, text:"" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastCRTMarkers = markers;
  _applyMainMarkers();
}

function renderKDJCross(data) {
  const markers = [];
  data.forEach(d => {
    if (d.kdj_cross === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:"#26a69a", shape:"arrowUp",   size:1.5, text:"金叉" });
    if (d.kdj_cross === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:"#ef5350", shape:"arrowDown", size:1.5, text:"死叉" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastKDJCrossMarkers = markers;
  _applyMainMarkers();
}

function renderResonance(data) {
  const markers = [];
  data.forEach(d => {
    if (d.resonance === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:"#26c6da", shape:"arrowUp",   size:1.5, text:"超賣" });
    if (d.resonance === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:"#ff9800", shape:"arrowDown", size:1.5, text:"超買" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastResonanceMarkers = markers;
  _applyMainMarkers();
}

function renderVolume(data) {
  volSeries.setData(data.map(d => ({
    time:toTime(d.time), value:d.volume||0,
    color: d.close >= d.open ? C.up+"aa" : C.down+"aa",
  })));
  const period = Math.max(1, S.volMaPeriod);
  const maData = [];
  for (let i = period - 1; i < data.length; i++) {
    const avg = data.slice(i - period + 1, i + 1).reduce((s,d) => s + (d.volume||0), 0) / period;
    maData.push({ time:toTime(data[i].time), value:avg });
  }
  volMaSeries.setData(maData);
}

function renderKDJ(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  kdjK.setData(line("kdj_k")); kdjD.setData(line("kdj_d")); kdjJ.setData(line("kdj_j"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    kdjH20.setData([{time:f,value:20},{time:l,value:20}]);
    kdjH50.setData([{time:f,value:50},{time:l,value:50}]);
    kdjH80.setData([{time:f,value:80},{time:l,value:80}]);
  }
}

function renderRSI(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  rsiLine14.setData(line("rsi_14")); rsiLine7.setData(line("rsi_7"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    rsiH30.setData([{time:f,value:30},{time:l,value:30}]);
    rsiH50.setData([{time:f,value:50},{time:l,value:50}]);
    rsiH70.setData([{time:f,value:70},{time:l,value:70}]);
  }
}

function renderMACD(data) {
  const valid = data.filter(d => d.macd != null);
  macdLine.setData(valid.map(d => ({ time:toTime(d.time), value:d.macd })));
  macdSignal.setData(valid.map(d => ({ time:toTime(d.time), value:d.macd_signal })));
  macdHist.setData(valid.map(d => ({
    time:toTime(d.time), value:d.macd_hist,
    color: d.macd_hist >= 0 ? C.up+"cc" : C.down+"cc",
  })));
}

/* ══════════════════════════════════════════
   即時更新
══════════════════════════════════════════ */
function startRealtime() {
  const dot    = document.getElementById("realtimeDot");
  const market = document.getElementById("marketSelect").value;
  if (market === "tw" || market === "us") { dot.classList.add("hidden"); return; }
  dot.classList.remove("hidden");
  realtimeTimer = setInterval(fetchLatest, 1000);
}

function stopRealtime() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  document.getElementById("realtimeDot").classList.add("hidden");
}

async function fetchLatest() {
  try {
    const res  = await fetch("/api/latest", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(buildPayload()),
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.data?.length) return;
    json.data.forEach(bar => {
      const t     = toTime(bar.time);
      const last  = ohlcvData[ohlcvData.length - 1];
      const lastT = last ? toTime(last.time) : 0;
      if (t === lastT) ohlcvData[ohlcvData.length - 1] = { ...last, ...bar };
      else if (t > lastT) ohlcvData.push(bar);
      else return;
      if (currentChartType === "candlestick" || currentChartType === "bar") {
        candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
      } else {
        candleSeries.update({ time:t, value:bar.close });
      }
      volSeries.update({ time:t, value:bar.volume||0, color: bar.close>=bar.open ? C.up+"aa" : C.down+"aa" });
    });
    updateSymbolBar(ohlcvData);
  } catch {}
}

/* ══════════════════════════════════════════
   統一更新所有面板圖例（鉛直線跨圖同步）
══════════════════════════════════════════ */
function updateAllLegends(t) {
  const d = ohlcvData.find(r => toTime(r.time) === t);
  if (!d) return;

  // 符號列
  document.getElementById("symO").textContent = fmt(d.open);
  document.getElementById("symH").textContent = fmt(d.high);
  document.getElementById("symL").textContent = fmt(d.low);
  document.getElementById("symC").textContent = fmt(d.close);
  document.getElementById("symV").textContent = fmtVol(d.volume);

  // BB
  if (d.bb_upper != null)
    document.getElementById("legBB").textContent =
      `BB  U:${fmt(d.bb_upper)}  M:${fmt(d.bb_middle)}  L:${fmt(d.bb_lower)}`;

  // 成交量
  document.getElementById("legVol").textContent = `VOL  ${fmtVol(d.volume)}`;

  // KDJ
  document.getElementById("legK").textContent = `K ${n2(d.kdj_k)}`;
  document.getElementById("legD").textContent = `D ${n2(d.kdj_d)}`;
  document.getElementById("legJ").textContent = `J ${n2(d.kdj_j)}`;

  // RSI
  document.getElementById("legRsi14").textContent = `RSI 14  ${n2(d.rsi_14)}`;
  document.getElementById("legRsi7").textContent  = `RSI 7  ${n2(d.rsi_7)}`;

  // MACD
  document.getElementById("legMacd").textContent      = `MACD ${n2(d.macd)}`;
  document.getElementById("legMacdSig").textContent   = `Signal ${n2(d.macd_signal)}`;
  document.getElementById("legMacdHist").textContent  = `Hist ${n2(d.macd_hist)}`;
}

/* ══════════════════════════════════════════
   圖例 crosshair（單圖 hover 仍保留）
══════════════════════════════════════════ */
function onMainCrosshair(param) {
  if (!param.time) return;
  const c = param.seriesData.get(candleSeries);
  if (c) {
    document.getElementById("symO").textContent = fmt(c.open);
    document.getElementById("symH").textContent = fmt(c.high);
    document.getElementById("symL").textContent = fmt(c.low);
    document.getElementById("symC").textContent = fmt(c.close);
    const idx = ohlcvData.findIndex(r => toTime(r.time) === param.time);
    if (idx >= 0) document.getElementById("symV").textContent = fmtVol(ohlcvData[idx].volume);
  }
  const bu = param.seriesData.get(bbU)?.value;
  const bm = param.seriesData.get(bbM)?.value;
  const bl = param.seriesData.get(bbL)?.value;
  if (bu != null) document.getElementById("legBB").textContent = `BB  U:${fmt(bu)}  M:${fmt(bm)}  L:${fmt(bl)}`;
}
function onVolCrosshair(param) {
  const v = param.seriesData.get(volSeries)?.value;
  if (v != null) document.getElementById("legVol").textContent = `VOL  ${fmtVol(v)}`;
}
function onKdjCrosshair(param) {
  const k = param.seriesData.get(kdjK)?.value;
  const d = param.seriesData.get(kdjD)?.value;
  const j = param.seriesData.get(kdjJ)?.value;
  if (k != null) {
    document.getElementById("legK").textContent = `K ${n2(k)}`;
    document.getElementById("legD").textContent = `D ${n2(d)}`;
    document.getElementById("legJ").textContent = `J ${n2(j)}`;
  }
}
function onRsiCrosshair(param) {
  const r14 = param.seriesData.get(rsiLine14)?.value;
  const r7  = param.seriesData.get(rsiLine7)?.value;
  if (r14 != null) {
    document.getElementById("legRsi14").textContent = `RSI 14  ${n2(r14)}`;
    document.getElementById("legRsi7").textContent  = `RSI 7  ${n2(r7)}`;
  }
}
function onMacdCrosshair(param) {
  const m  = param.seriesData.get(macdLine)?.value;
  const sg = param.seriesData.get(macdSignal)?.value;
  const h  = param.seriesData.get(macdHist)?.value;
  if (m != null) {
    document.getElementById("legMacd").textContent     = `MACD ${n2(m)}`;
    document.getElementById("legMacdSig").textContent  = `Signal ${n2(sg)}`;
    document.getElementById("legMacdHist").textContent = `Hist ${n2(h)}`;
  }
}

/* ══════════════════════════════════════════
   符號資訊 + 統計 + 明細
══════════════════════════════════════════ */
function updateSymbolBar(data) {
  const symbol  = document.getElementById("symbolInput").value.trim();
  const market  = document.getElementById("marketSelect").value;
  const exch    = document.getElementById("exchangeSelect").value;
  const tfLabel = TF_LABELS[currentTF] || currentTF;
  document.getElementById("symbolName").textContent =
    market === "tw" ? symbol : market === "us" ? symbol : symbol.replace("/", " / ");
  document.getElementById("symExchange").textContent =
    market === "tw" ? `台股 · ${tfLabel}` :
    market === "us" ? `美股 · ${tfLabel}` :
    `${exch} · ${tfLabel}`;
  if (!data.length) return;
  const last = data[data.length-1], prev = data.length>1 ? data[data.length-2] : last;
  document.getElementById("symO").textContent = fmt(last.open);
  document.getElementById("symH").textContent = fmt(last.high);
  document.getElementById("symL").textContent = fmt(last.low);
  document.getElementById("symC").textContent = fmt(last.close);
  document.getElementById("symV").textContent = fmtVol(last.volume);
  const chg = ((last.close - prev.close) / prev.close * 100).toFixed(2);
  const el  = document.getElementById("symChg");
  el.textContent = `${chg >= 0 ? "+" : ""}${chg}%`;
  el.className   = "sym-chg " + (chg >= 0 ? "up" : "dn");
}

/* ══════════════════════════════════════════
   重播 (Bar Replay)
══════════════════════════════════════════ */
let replayData    = [];   // 完整資料快照
let replayIdx     = 0;    // 目前顯示到第幾根
let replaySpeed   = 500;  // ms per bar
let replayTimer   = null;
let replayActive  = false;

function enterReplay() {
  if (replayActive) return;
  replayActive = true;
  stopRealtime();
  replayData = [...ohlcvData];
  // 預設從 20% 處開始（讓左側有足夠歷史）
  replayIdx  = Math.max(5, Math.floor(replayData.length * 0.2));
  document.getElementById("replayBar").classList.remove("hidden");
  document.getElementById("replayModeBtn").classList.add("active");
  _replayRender();
}

function exitReplay() {
  replayActive = false;
  replayTimer && clearInterval(replayTimer);
  replayTimer = null;
  document.getElementById("replayBar").classList.add("hidden");
  document.getElementById("replayModeBtn").classList.remove("active");
  document.getElementById("replayPlay").classList.remove("playing");
  document.getElementById("replayPlay").textContent = "▶";
  // 還原完整資料
  if (replayData.length) renderAll(replayData);
}

function _replayRender() {
  const slice = replayData.slice(0, replayIdx + 1);
  renderAll(slice);
  // 讓最新一根在畫面右側
  mainChart.timeScale().scrollToPosition(-2, false);
  // 更新狀態列
  const bar = slice[slice.length - 1];
  if (bar) {
    const d = new Date(bar.time);
    document.getElementById("replayDate").textContent =
      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  document.getElementById("replayProgress").textContent =
    `${replayIdx + 1} / ${replayData.length}`;
}

function replayPlay() {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
    document.getElementById("replayPlay").classList.remove("playing");
    document.getElementById("replayPlay").textContent = "▶";
    return;
  }
  document.getElementById("replayPlay").classList.add("playing");
  document.getElementById("replayPlay").textContent = "⏸";
  replayTimer = setInterval(() => {
    if (replayIdx >= replayData.length - 1) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
      return;
    }
    replayIdx++;
    _replayRender();
  }, replaySpeed);
}

function replayStepForward() {
  if (replayIdx < replayData.length - 1) { replayIdx++; _replayRender(); }
}

function replayStepBack() {
  if (replayIdx > 0) { replayIdx--; _replayRender(); }
}

function bindReplayBar() {
  document.getElementById("replayExit").addEventListener("click", exitReplay);
  document.getElementById("replayPlay").addEventListener("click", replayPlay);
  document.getElementById("replayStepF").addEventListener("click", replayStepForward);
  document.getElementById("replayStepB").addEventListener("click", replayStepBack);
  document.querySelectorAll(".rp-speed").forEach(btn => {
    btn.addEventListener("click", () => {
      replaySpeed = parseInt(btn.dataset.speed);
      document.querySelectorAll(".rp-speed").forEach(b => b.classList.toggle("active", b === btn));
      // 若正在播放，重啟 interval
      if (replayTimer) {
        clearInterval(replayTimer); replayTimer = null;
        document.getElementById("replayPlay").classList.remove("playing");
        document.getElementById("replayPlay").textContent = "▶";
        replayPlay();
      }
    });
  });
}

/* ══════════════════════════════════════════
   系統外觀顏色
══════════════════════════════════════════ */
const SC_DEFAULTS = {
  "sc-bg":     "#1e222d",
  "sc-panel":  "#2a2e39",
  "sc-border": "#2a2e39",
  "sc-text":   "#d1d4dc",
  "sc-muted":  "#787b86",
  "sc-blue":   "#2962ff",
};
const SC_CSS_MAP = {
  "sc-bg":     ["--bg", "--bg2"],
  "sc-panel":  ["--bg3"],
  "sc-border": ["--border"],
  "sc-text":   ["--text"],
  "sc-muted":  ["--muted"],
  "sc-blue":   ["--blue"],
};
let SC = { ...SC_DEFAULTS };

function applySystemColor(id, color) {
  const vars = SC_CSS_MAP[id];
  if (!vars) return;
  vars.forEach(v => document.documentElement.style.setProperty(v, color));
  if (id === "sc-bg") document.body.style.background = color;
}
function applyAllSystemColors() {
  for (const [id, color] of Object.entries(SC)) applySystemColor(id, color);
}
function saveSystemColors() {
  try { localStorage.setItem("sysColors", JSON.stringify(SC)); } catch {}
}
function loadSystemColors() {
  try { Object.assign(SC, JSON.parse(localStorage.getItem("sysColors") || "{}")); } catch {}
}
function bindSystemColors() {
  // 同步 input 值
  for (const [id, color] of Object.entries(SC)) {
    const el = document.getElementById(id);
    if (el) el.value = color.slice(0, 7); // hex only, no alpha
  }
  // 監聽 input 事件（自訂調色盤也會觸發）
  for (const id of Object.keys(SC_DEFAULTS)) {
    document.getElementById(id)?.addEventListener("input", e => {
      const color = e.target._cpColor || e.target.value;
      SC[id] = color;
      applySystemColor(id, color);
      saveSystemColors();
    });
  }
  // 重設按鈕
  document.getElementById("resetSysColors")?.addEventListener("click", () => {
    SC = { ...SC_DEFAULTS };
    for (const [id, color] of Object.entries(SC)) {
      const el = document.getElementById(id);
      if (el) { el.value = color; el._cpColor = null; }
    }
    applyAllSystemColors();
    saveSystemColors();
    // 同步 cp-trigger 顯示色
    document.querySelectorAll("#sysColorPanel input[type='color'].cp-hidden").forEach(inp => {
      const tr = inp.previousElementSibling;
      if (tr?.classList.contains("cp-trigger")) tr.style.background = inp.value;
    });
  });
  // 收合 toggle
  document.getElementById("sysColorToggle")?.addEventListener("click", () => {
    document.getElementById("sysColorPanel")?.classList.toggle("hidden");
    document.querySelector("#sysColorToggle .toggle-arrow")?.classList.toggle("open");
  });
}

/* ══════════════════════════════════════════
   右側合約行情列表
══════════════════════════════════════════ */
let _tickerData     = [];
let _spotTickerData = [];
let _tickerSort     = "desc";   // desc=漲幅 asc=跌幅 vol=成交量
let _tickerTimer    = null;

async function fetchTickers() {
  try {
    const [futRes, spotRes] = await Promise.all([
      fetch("/api/tickers?market=futures"),
      fetch("/api/tickers?market=spot"),
    ]);
    if (futRes.ok)  { const j = await futRes.json();  _tickerData     = j.tickers || []; }
    if (spotRes.ok) { const j = await spotRes.json(); _spotTickerData = j.tickers || []; }
    renderTickers();
    renderSymSearch();   // 同步更新搜尋列表的漲跌幅
  } catch {}
}

function updatePageTitle() {
  const sym = (document.getElementById("symbolInput")?.value || "").trim().toUpperCase();
  if (!sym) { document.title = "回測系統"; return; }
  // 在 _tickerData 或 _spotTickerData 中找到目前標的的即時價格
  const all  = [..._tickerData, ..._spotTickerData];
  const hit  = all.find(t =>
    t.symbol.toUpperCase() === sym.replace("/","").replace(".P","") ||
    (t.spot  || "").toUpperCase() === sym ||
    (t.display || "").toUpperCase() === sym
  );
  if (hit) {
    const chg  = hit.change_pct >= 0 ? `+${hit.change_pct.toFixed(2)}%` : `${hit.change_pct.toFixed(2)}%`;
    document.title = `${hit.display || sym} ${fmtTickerPrice(hit.price)} ${chg}`;
  } else {
    document.title = sym;
  }
}

function renderTickers() {
  const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
  let list = _tickerData.filter(t =>
    !search ||
    t.display.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().replace("usdt","").includes(search)
  );
  if (_tickerSort === "asc") list = [...list].reverse();
  else if (_tickerSort === "vol") list = [...list].sort((a, b) => b.volume - a.volume);

  const container = document.getElementById("tickerList");
  if (!container) return;

  const currentSym = document.getElementById("symbolInput")?.value.trim().toUpperCase();

  container.innerHTML = list.map(t => {
    const cls  = t.change_pct >= 0 ? "up" : "dn";
    const sign = t.change_pct >= 0 ? "+" : "";
    const active = (t.display.toUpperCase() === currentSym || t.symbol.toUpperCase() === currentSym) ? " tk-active" : "";
    return `<div class="ticker-item${active}" data-symbol="${t.symbol}" data-display="${t.display}" data-spot="${t.spot || t.display}">
      <div class="tk-row1">
        <span class="tk-sym">${t.display}</span>
        <span class="tk-chg ${cls}">${sign}${t.change_pct.toFixed(2)}%</span>
      </div>
      <div class="tk-row2">${fmtTickerPrice(t.price)}</div>
    </div>`;
  }).join("");

  container.querySelectorAll(".ticker-item").forEach(el => {
    el.addEventListener("click", () => {
      // symbolInput 顯示合約格式（BTC/USDT.P），後端自動去除 .P 後綴
      document.getElementById("symbolInput").value = el.dataset.display;
      const exchEl = document.getElementById("exchangeSelect");
      if (exchEl && !["pionex","binance"].includes(exchEl.value)) exchEl.value = "pionex";
      loadData(false);
      container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
      el.classList.add("tk-active");
    });
  });
  updatePageTitle();  // 每次重繪都更新分頁標題
}

function fmtTickerPrice(p) {
  if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(5);
  return p.toFixed(6);
}

function startTickerRefresh() {
  fetchTickers();
  _tickerTimer = setInterval(fetchTickers, 1000);   // 每秒更新
}

function bindTickerPanel() {
  document.querySelectorAll(".tk-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tk-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _tickerSort = btn.dataset.sort;
      renderTickers();
    });
  });
  document.getElementById("tickerSearch")?.addEventListener("input", renderTickers);
}

/* ══════════════════════════════════════════
   Symbol Search Modal
══════════════════════════════════════════ */
const SYM_ICON_COLORS = ["#f23645","#2196f3","#ff9800","#26a69a","#7e57c2","#e91e63","#00bcd4","#8bc34a"];
let _symSearchMarket   = "futures";
let _symSearchFocusIdx = -1;
let _symHistory        = [];   // 最近搜尋紀錄

function loadSymHistory() {
  try { _symHistory = JSON.parse(localStorage.getItem("symSearchHistory") || "[]"); } catch { _symHistory = []; }
}
function saveSymHistory() {
  try { localStorage.setItem("symSearchHistory", JSON.stringify(_symHistory.slice(0, 10))); } catch {}
}
function addToSymHistory(t) {
  _symHistory = _symHistory.filter(h => h.symbol !== t.symbol);
  _symHistory.unshift({ symbol: t.symbol, display: t.display, spot: t.spot || t.display,
                        change_pct: t.change_pct, price: t.price });
  _symHistory = _symHistory.slice(0, 10);
  saveSymHistory();
}

function symIconColor(base) {
  return SYM_ICON_COLORS[base.charCodeAt(0) % SYM_ICON_COLORS.length];
}

function renderSymSearch() {
  const list = document.getElementById("symModalList");
  if (!list || !document.getElementById("symOverlay").classList.contains("hidden") === false) return;
  if (!document.getElementById("symOverlay") || document.getElementById("symOverlay").classList.contains("hidden")) return;
  _renderSymSearchList();
}

function _symItemHTML(t, idx) {
  // 從 symbol 推算 base（BTCUSDT → BTC）
  const rawSym = t.symbol || "";
  const base   = rawSym.endsWith("USDT") ? rawSym.slice(0, -4) : rawSym.replace("USDT", "");
  const color  = symIconColor(base);
  const chg    = t.change_pct != null ? t.change_pct : 0;
  const cls    = chg >= 0 ? "up" : "dn";
  const sign   = chg >= 0 ? "+" : "";
  // 依當前 tab 決定顯示名稱，不依賴後端回傳的 display 欄位（防止 tab 切換時顯示錯誤格式）
  const isFut  = _symSearchMarket === "futures";
  const name   = isFut ? `${base}/USDT.P` : `${base}/USDT`;
  const desc   = isFut ? `${base} USDT 永續合約` : `${base} / USDT`;
  // 現貨代號（供 OHLCV API 使用）
  const spot   = t.spot || `${base}/USDT`;
  return `<div class="sym-result-item" data-idx="${idx}"
    data-symbol="${rawSym}" data-display="${name}"
    data-spot="${spot}"
    data-change_pct="${chg}" data-price="${t.price || 0}">
    <div class="sym-icon" style="background:${color}">${base.slice(0,2)}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${name}</span>
      <span class="sym-result-desc">${desc}</span>
    </div>
    <div class="sym-result-right">
      <span class="sym-result-chg ${cls}">${sign}${chg.toFixed(2)}%</span>
      <span class="sym-result-tag">Pionex</span>
    </div>
  </div>`;
}

function _bindSymItems(list) {
  list.querySelectorAll(".sym-result-item").forEach(el => {
    el.addEventListener("click", () => _selectSymbol(el));
  });
  document.getElementById("symHistClear")?.addEventListener("click", e => {
    e.stopPropagation();
    _symHistory = [];
    saveSymHistory();
    _renderSymSearchList();
  });
}

function _renderSymSearchList() {
  const list  = document.getElementById("symModalList");
  const query = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();

  // 美股：用 API 搜尋
  if (_symSearchMarket === "us") {
    if (!query) {
      list.innerHTML = `<div class="sym-empty">輸入股票代號或名稱搜尋（如 AAPL、Tesla）</div>`;
      return;
    }
    list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    fetch(`/api/us/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 AAPL）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => `
          <div class="sym-result-item" data-symbol="${r.symbol}" data-display="${r.symbol}" tabindex="${i}">
            <div class="sym-icon" style="background:${_iconColor(r.symbol)}">
              ${r.symbol.slice(0,2).toUpperCase()}
            </div>
            <div class="sym-result-info">
              <span class="sym-result-name">${r.symbol}</span>
              <span class="sym-result-desc">${r.name} · ${r.exchange}</span>
            </div>
            <span class="sym-result-tag">${r.type || "Stock"}</span>
          </div>`).join("");
        _bindSymItems(list);
      })
      .catch(() => {
        list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 AAPL）</div>`;
      });
    return;
  }

  const data = _symSearchMarket === "futures" ? _tickerData : _spotTickerData;

  let html = "";

  // 無搜尋詞時顯示歷史紀錄
  if (!query && _symHistory.length) {
    html += `<div class="sym-section-hd">最近搜尋 <span class="sym-hist-clear" id="symHistClear">清除</span></div>`;
    html += _symHistory.map((t, i) => _symItemHTML(t, "h" + i)).join("");
    html += `<div class="sym-section-divider"></div>`;
  }

  if (!data.length) {
    list.innerHTML = html + `<div class="sym-loading">${_symSearchMarket === "futures" ? "合約行情載入中，請稍候…" : "現貨資料載入中…"}</div>`;
    _bindSymItems(list);
    return;
  }

  // 先按 volume 排（熱門在前），再依查詢過濾
  let items = [...data].sort((a, b) => b.volume - a.volume);
  if (query) {
    items = items.filter(t =>
      t.display.toLowerCase().includes(query) ||
      t.symbol.toLowerCase().includes(query)
    );
  }
  items = items.slice(0, 100);

  if (!items.length) {
    list.innerHTML = html + `<div class="sym-empty">沒有符合的標的</div>`;
    _bindSymItems(list);
    return;
  }

  html += items.map((t, i) => _symItemHTML(t, i)).join("");
  list.innerHTML = html;
  _bindSymItems(list);
}

function _selectSymbol(el) {
  const display = el.dataset.display || el.dataset.spot || el.dataset.symbol;
  // 加入搜尋歷史
  addToSymHistory({
    symbol:     el.dataset.symbol,
    display:    display,
    spot:       el.dataset.spot || el.dataset.display,
    change_pct: parseFloat(el.dataset.change_pct) || 0,
    price:      parseFloat(el.dataset.price) || 0,
  });
  // symbolInput 顯示合約格式（BTC/USDT.P），後端會自動去除 .P 後綴
  document.getElementById("symbolInput").value = display;
  closeSymSearch();
  loadData(false);
  renderTickers();  // 更新右側高亮
}

function openSymSearch() {
  const market = document.getElementById("marketSelect").value;
  document.getElementById("symOverlay").classList.remove("hidden");
  const inp = document.getElementById("symModalInput");
  inp.value = "";
  document.getElementById("symModalClear").classList.add("hidden");
  _symSearchFocusIdx = -1;
  // 依市場決定預設 tab
  _symSearchMarket = market === "us" ? "us" : "futures";
  document.querySelectorAll(".sym-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.market === _symSearchMarket);
  });
  _renderSymSearchList();
  setTimeout(() => inp.focus(), 50);
}

function closeSymSearch() {
  document.getElementById("symOverlay").classList.add("hidden");
}

function initSymSearch() {
  // 點擊 symbolInput 開啟 modal
  const symInp = document.getElementById("symbolInput");
  symInp.readOnly = true;
  symInp.addEventListener("click", openSymSearch);

  // 關閉按鈕、overlay 背景點擊
  document.getElementById("symOverlay").addEventListener("click", e => {
    if (e.target === document.getElementById("symOverlay")) closeSymSearch();
  });

  // 搜尋輸入（美股加 debounce 300ms）
  const modalInp = document.getElementById("symModalInput");
  let _searchTimer = null;
  modalInp.addEventListener("input", () => {
    const clear = document.getElementById("symModalClear");
    clear.classList.toggle("hidden", !modalInp.value);
    _symSearchFocusIdx = -1;
    clearTimeout(_searchTimer);
    if (_symSearchMarket === "us") {
      _searchTimer = setTimeout(_renderSymSearchList, 300);
    } else {
      _renderSymSearchList();
    }
  });
  document.getElementById("symModalClear")?.addEventListener("click", () => {
    modalInp.value = "";
    document.getElementById("symModalClear").classList.add("hidden");
    modalInp.focus();
    _renderSymSearchList();
  });

  // 鍵盤：↑↓ 選、Enter 確認、ESC 關閉
  modalInp.addEventListener("keydown", e => {
    const items = document.querySelectorAll(".sym-result-item");
    if (e.key === "Escape") { closeSymSearch(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _symSearchFocusIdx = Math.min(_symSearchFocusIdx + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _symSearchFocusIdx = Math.max(_symSearchFocusIdx - 1, 0);
    } else if (e.key === "Enter") {
      if (_symSearchFocusIdx >= 0 && items[_symSearchFocusIdx])
        _selectSymbol(items[_symSearchFocusIdx]);
      return;
    } else { return; }
    items.forEach((el, i) => el.classList.toggle("sym-focused", i === _symSearchFocusIdx));
    items[_symSearchFocusIdx]?.scrollIntoView({ block: "nearest" });
  });

  // 市場 tab 切換
  document.querySelectorAll(".sym-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sym-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _symSearchMarket = btn.dataset.market;
      _symSearchFocusIdx = -1;
      _renderSymSearchList();
    });
  });
}

/* ══════════════════════════════════════════
   工具函式
══════════════════════════════════════════ */
function buildPayload(useLimit = false) {
  // 去除 .P 後綴（後端 fetch_crypto_ohlcv 也會處理，雙重保險）
  let sym = document.getElementById("symbolInput").value.trim();
  if (sym.toUpperCase().endsWith(".P")) sym = sym.slice(0, -2);
  return {
    market:    document.getElementById("marketSelect").value,
    symbol:    sym,
    start:     useLimit ? "" : document.getElementById("startDate").value,
    end:       useLimit ? "" : document.getElementById("endDate").value,
    limit:     useLimit ? 300 : 0,
    timeframe: currentTF,
    exchange:  document.getElementById("exchangeSelect").value,
  };
}

function fmt(v)    { return v!=null ? Number(v).toLocaleString(undefined,{maximumFractionDigits:4}) : "—"; }
function n2(v)     { return v!=null ? Number(v).toFixed(2) : "—"; }
function fmtVol(v) {
  if (v==null) return "—";
  if (v>=1e9) return (v/1e9).toFixed(2)+"B";
  if (v>=1e6) return (v/1e6).toFixed(2)+"M";
  if (v>=1e3) return (v/1e3).toFixed(1)+"K";
  return Number(v).toLocaleString();
}
function fmtT(s)   { return s ? s.replace("T"," ").substring(0,16) : "—"; }

function showToast(msg, ms = 4000) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#2a2e39;border:1px solid #ef5350;color:#d1d4dc;padding:8px 18px;border-radius:6px;z-index:9999;font-size:12px;pointer-events:none";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function showLoading(show) {
  let el = document.getElementById("loadingOverlay");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "loadingOverlay"; el.className = "loading-overlay";
      el.innerHTML = `<span class="realtime-dot"></span> 處理中...`;
      document.body.appendChild(el);
    }
  } else { el?.remove(); }
}
