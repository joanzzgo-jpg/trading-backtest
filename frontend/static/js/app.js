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
let currentChartType = "candlestick"; // candlestick | bar | line | area
let ohlcvData       = [];
let currentTF       = "1d";
let realtimeTimer   = null;
let lastCRTMarkers       = [];
let lastKDJCrossMarkers  = [];
let lastResonanceMarkers = [];
let paneCollapseFlex = {};  // 面板收合前的 flex 值（module-level，供 loadVisibilityPrefs 使用）
let _restoringPrefs  = false; // 還原偏好設定時，暫停自動儲存
let _savedBarCount   = null;  // 切換標的前保存的可見 K 棒數量，載入後還原

const PANE_FLEX_DEFAULTS = { mainPane:5, kdjPane:1, rsiPane:1, macdPane:1 };

const TF_LABELS = { "1M":"月","1w":"週","1d":"日","4h":"4H","1h":"1H","15m":"15m","5m":"5m" };

/* ── 時間轉 Unix 秒（所有時間戳均以台灣時間 UTC+8 顯示） ── */
function toTime(s) {
  if (!s) return 0;
  const iso = s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000) + 8 * 3600;
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
    layout:    { background:{ color: "rgba(0,0,0,0)" }, textColor:"#d1d4dc" },
    grid:      { vertLines:{ color:"#2a2e39" }, horzLines:{ color:"#2a2e39" } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { style: 0, width: 1, color: "#758696", labelBackgroundColor: "#2a2e39" },
      horzLine: { style: 0, width: 1, color: "#758696", labelBackgroundColor: "#2a2e39" },
    },
    rightPriceScale: { borderColor:"#2a2e39", minimumWidth: 80 },
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

  _loadWatchlist();
  loadLastSymbol();     // 還原上次標的、交易所、市場、時間框架
  loadSystemColors();
  applyAllSystemColors();
  loadSymHistory();
  loadPaneFlexes();   // 套用儲存的面板比例（在 buildCharts 前，讓第一次 resize 即正確）
  buildCharts();
  bindEvents();
  _renderWatchlist();
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
  latestPriceLine = null;
  if (currentChartType === "candlestick") {
    candleSeries = mainChart.addCandlestickSeries({
      upColor:   S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)",
      downColor: S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)",
      borderVisible:   S.borderVisible !== false,
      borderUpColor:   C.borderUp,   borderDownColor: C.borderDown,
      wickVisible:     S.wickVisible  !== false,
      wickUpColor:     C.wickUp,      wickDownColor:   C.wickDown,
      priceLineVisible: false, lastValueVisible: false,
    });
  } else if (currentChartType === "bar") {
    candleSeries = mainChart.addBarSeries({ upColor: C.up, downColor: C.down, priceLineVisible: false, lastValueVisible: false });
  } else if (currentChartType === "line") {
    candleSeries = mainChart.addLineSeries({ color: C.up, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  } else if (currentChartType === "area") {
    candleSeries = mainChart.addAreaSeries({
      lineColor: C.up, topColor: C.up + "30", bottomColor: C.up + "00",
      lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
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
  updateLatestPriceLine(data[data.length - 1].close);
}

function updateLatestPriceLine(price) {
  if (!candleSeries || price == null) return;
  if (latestPriceLine) {
    try { latestPriceLine.applyOptions({ price }); return; } catch { latestPriceLine = null; }
  }
  latestPriceLine = candleSeries.createPriceLine({
    price,
    color: "rgba(255,145,71,.80)",
    lineWidth: 1,
    lineStyle: 2,        /* 2 = Dashed */
    axisLabelVisible: true,
    axisLabelColor: "rgba(255,145,71,.90)",
    axisLabelTextColor: "#fff",
    title: "",
  });
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
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });

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
let _blockSync = false; // 重播渲染期間暫停雙向同步，防止 setData 觸發 range 抖動

function syncTimeScales() {
  // 捲動 / 縮放：以 logical range 同步（anchor series 確保各圖索引一致）
  const allCharts = [mainChart, kdjChart, rsiChart, macdChart];
  let syncing = false;
  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range || _blockSync) return;
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

  function positionLines(time, fallbackX) {
    // 主圖 x 作為時間標籤和 fallback
    const mainX = mainChart.timeScale().timeToCoordinate(time) ?? fallbackX;
    if (mainX == null || mainX < 0) {
      lineEls.forEach(l => l.style.display = "none");
      timeLabel.style.display = "none";
      return;
    }

    // 底部時間標籤
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    let timeStr;
    if (["4h","1h","15m","5m"].includes(currentTF)) {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    } else {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    }
    timeLabel.textContent = timeStr;
    timeLabel.style.display = "block";
    timeLabel.style.left   = Math.round(mainX) + "px";
    timeLabel.style.bottom = replayActive ? "42px" : "0";

    const cRect = container.getBoundingClientRect();
    panesConf.forEach(({ elId, chart }, i) => {
      const pane = document.getElementById(elId);
      const ln   = lineEls[i];
      if (!pane || pane.classList.contains("hidden")) { ln.style.display = "none"; return; }
      if (pane.querySelector(".pane-body")?.style.display === "none") { ln.style.display = "none"; return; }

      const paneX = chart.timeScale().timeToCoordinate(time) ?? mainX;
      if (paneX == null) { ln.style.display = "none"; return; }

      const pRect = pane.getBoundingClientRect();
      let height  = pRect.height;

      // 往下延伸，覆蓋緊接的 pane-divider（若可見）
      const nextSib = pane.nextElementSibling;
      if (nextSib?.classList.contains("pane-divider") && !nextSib.classList.contains("hidden")) {
        height += nextSib.getBoundingClientRect().height;
      }

      ln.style.display = "block";
      ln.style.left    = Math.round(paneX) + "px";
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
    c?.applyOptions({ crosshair: { vertLine: { visible: false } } });
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
let dragState      = null;   // { id, startX, startY, moved, snapshot }
let _dragJustMoved = false;  // 拖移結束後抑制下一個 click，避免開啟顏色面板
let _mx = 0, _my = 0;
let _drawColor  = "#f5c518";  // 目前繪圖顏色

const DCP_COLORS = ["#f5c518","#ef5350","#26a69a","#2962ff","#ff9800","#7e57c2","#ec407a","#26c6da","#ffffff","#787b86"];
const DRAW_WIDTH  = 1.5;
let _cpShowDirect = null; // set by initColorPicker()

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

/* ── 自選標的 ── */
let _watchlist = [];
let _wlPriceCache = {}; // key: "market:exchange:symbol" → {price, change_pct, volume, ts}
function _loadWatchlist() {
  try { _watchlist = JSON.parse(localStorage.getItem("watchlist") || "[]"); } catch { _watchlist = []; }
}
function _saveWatchlist() {
  try { localStorage.setItem("watchlist", JSON.stringify(_watchlist)); } catch {}
}
function _renderWatchlist() {
  renderTickers();   // wl tab 在 renderTickers 內處理，其餘 tab 更新星號狀態
  _updateStarBtn();
}

function _toggleWatchlist(symbol, market, exchange) {
  const key = `${market}:${exchange || ""}:${symbol}`;
  const idx = _watchlist.findIndex(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  if (idx >= 0) {
    _watchlist.splice(idx, 1);
  } else {
    _watchlist.unshift({ market, symbol, exchange });
  }
  _saveWatchlist();
  _renderWatchlist();  // calls renderTickers() internally
}
function _addToWatchlist() {
  const symbol   = document.getElementById("symbolInput")?.value?.trim();
  const market   = document.getElementById("marketSelect")?.value || "crypto";
  const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
  if (!symbol) return;
  const key = `${market}:${exchange}:${symbol}`;
  if (_watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key)) return;
  _watchlist.unshift({ market, symbol, exchange });
  _saveWatchlist();
  _renderWatchlist();
}

function findNearest(x, y, maxDist = 12) {
  let best = maxDist, found = null;
  drawings.forEach(d => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; found = d; }
  });
  return found;
}

/* 對 longpos/shortpos 判斷拖移的是哪一條線 */
function _drawingHitPart(d, x, y) {
  if (d.type !== "longpos" && d.type !== "shortpos") return "move";
  if (!d.p1) return "move";
  const ey = candleSeries?.priceToCoordinate(d.p1.price);
  const ty = candleSeries?.priceToCoordinate(d.tp);
  const sy = candleSeries?.priceToCoordinate(d.sl);
  // 左邊緣寬度把手優先偵測
  const ex = mainChart.timeScale().timeToCoordinate(d.p1.time);
  if (ex != null && ty != null && sy != null) {
    const W2 = drawCanvas?.width || 800;
    const visR = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const ZW = Math.max(20, Math.min(W2 * 0.4, Math.round(W2 * (d.barWidth ?? 3) / barsV)));
    const rx2 = Math.min(W2, ex + ZW);
    if (Math.abs(x - rx2) < 10 && y >= Math.min(ty, sy) - 8 && y <= Math.max(ty, sy) + 8) return "width";
  }
  let bestDist = Infinity, bestPart = "entry";
  [["entry", ey], ["tp", ty], ["sl", sy]].forEach(([part, py]) => {
    if (py == null) return;
    const dist = Math.abs(py - y);
    if (dist < bestDist) { bestDist = dist; bestPart = part; }
  });
  return bestPart;
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

  // ── 觸控支援（手機繪圖）──
  chartEl.addEventListener("touchstart", e => {
    const touch = e.touches[0]; if (!touch) return;
    const fake = { clientX: touch.clientX, clientY: touch.clientY, button: 0 };
    if (drawTool === "pointer") {
      // pointer 模式：可拖移既有繪圖
      _onChartMouseDown(fake);
      return;
    }
    if (drawTool === "crosshair") return;
    e.preventDefault();
    _onChartMouseMove(fake);
  }, { capture: true, passive: false });

  chartEl.addEventListener("touchmove", e => {
    const touch = e.touches[0]; if (!touch) return;
    const fake = { clientX: touch.clientX, clientY: touch.clientY };
    if (dragState) { e.preventDefault(); _onChartMouseMove(fake); return; }
    if (drawTool === "crosshair") return;
    if (drawTool !== "pointer") e.preventDefault();
    _onChartMouseMove(fake);
  }, { capture: true, passive: false });

  chartEl.addEventListener("touchend", e => {
    const touch = e.changedTouches[0]; if (!touch) return;
    const fake = { clientX: touch.clientX, clientY: touch.clientY, stopPropagation: () => {} };
    if (dragState) { _onChartMouseUp(); return; }
    if (drawTool === "pointer") {
      // 點擊選取繪圖，帶出顏色選擇器
      const { x, y } = _canvasXY(fake);
      const near = findNearest(x, y, 20);
      if (near) {
        e.preventDefault(); e.stopPropagation();
        selectedId = near.id;
        showDrawColorPicker(near, touch.clientX, touch.clientY);
        requestAnimationFrame(renderDrawings);
      }
      return;
    }
    if (drawTool === "crosshair") return;
    e.preventDefault(); e.stopPropagation();
    _onChartMouseUp();
    _onChartClick(fake);
  }, { capture: true });

  // cpPopup close is handled by initColorPicker()'s own mousedown listener
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
    if (hoveredId) {
      const hd = drawings.find(d => d.id === hoveredId);
      if (hd && (hd.type === "longpos" || hd.type === "shortpos")) {
        const part = _drawingHitPart(hd, _mx, _my);
        chartEl.style.cursor = (part === "tp" || part === "sl") ? "ns-resize" : part === "width" ? "ew-resize" : "grab";
      } else {
        chartEl.style.cursor = "grab";
      }
    } else {
      chartEl.style.cursor = "";   // "" → 交回 LWC
    }
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
  document.getElementById("cpPopup")?.classList.remove("open");
  _updateCursor();
  requestAnimationFrame(renderDrawings);
}

function _returnToPointer() {
  document.querySelectorAll(".dt-btn").forEach(b => b.classList.remove("active"));
  document.querySelector(".dt-btn[data-tool='pointer']")?.classList.add("active");
  setDrawTool("pointer");
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
                     snapshot: JSON.parse(JSON.stringify(near)),
                     part: _drawingHitPart(near, x, y) };
      _updateCursor();
      requestAnimationFrame(renderDrawings);
    }
  }
  // 其他工具：讓 LWC 正常處理
}

function _onChartMouseUp() {
  if (!dragState) return;
  if (dragState.moved) {
    saveDrawings();
    _dragJustMoved = true;  // 抑制緊接的 click 事件，避免意外開啟顏色面板
  }
  dragState = null;
  _updateCursor();
  requestAnimationFrame(renderDrawings);
}

function _onChartClick(e) {
  if (_dragJustMoved) { _dragJustMoved = false; return; }
  const { x, y } = _canvasXY(e);

  if (drawTool === "pointer") {
    if (dragState?.moved) return;
    const near = findNearest(x, y);
    if (near) {
      selectedId = near.id;
      e.stopPropagation();
      showDrawColorPicker(near, e.clientX, e.clientY);
    } else {
      selectedId = null;
      document.getElementById("cpPopup")?.classList.remove("open");
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
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "vline") {
    drawings.push({ id:_did(), type:"vline", time:pt.time, color:_drawColor });
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "text") {
    const txt = window.prompt("輸入文字：");
    if (txt?.trim()) {
      drawings.push({ id:_did(), type:"text", time:pt.time, price:pt.price, text:txt.trim(), color:_drawColor });
      saveDrawings();
    }
    _returnToPointer(); return;
  }

  // 做多盈虧比（longpos）
  if (drawTool === "longpos") {
    if (!drawingWIP) {
      drawingWIP = { type:"longpos", p1:pt };
    } else {
      const entry = drawingWIP.p1.price;
      const clicked = pt.price;
      let tp, sl;
      if (clicked >= entry) {
        tp = clicked;
        sl = entry - (tp - entry);
      } else {
        sl = clicked;
        tp = entry + (entry - sl);
      }
      // 色塊寬度 = 兩次點擊的水平距離（換算成 K棒數）
      const _ex1 = mainChart.timeScale().timeToCoordinate(drawingWIP.p1.time);
      const _ex2 = mainChart.timeScale().timeToCoordinate(pt.time);
      const _vr  = mainChart.timeScale().getVisibleLogicalRange();
      const _bv  = _vr ? Math.max(10, _vr.to - _vr.from) : 50;
      const _ppb = (drawCanvas?.width || 800) / _bv;
      const _bw  = Math.max(3, Math.round(Math.abs((_ex2 ?? 0) - (_ex1 ?? 0)) / _ppb));
      drawings.push({ id:_did(), type:"longpos", p1:drawingWIP.p1, tp, sl, color:_drawColor, barWidth:_bw });
      drawingWIP = null;
      saveDrawings(); _returnToPointer();
    }
    return;
  }

  // 做空盈虧比（shortpos）
  if (drawTool === "shortpos") {
    if (!drawingWIP) {
      drawingWIP = { type:"shortpos", p1:pt };
    } else {
      const entry = drawingWIP.p1.price;
      const clicked = pt.price;
      let tp, sl;
      if (clicked <= entry) {
        tp = clicked;
        sl = entry + (entry - tp);
      } else {
        sl = clicked;
        tp = entry - (sl - entry);
      }
      const _ex1s = mainChart.timeScale().timeToCoordinate(drawingWIP.p1.time);
      const _ex2s = mainChart.timeScale().timeToCoordinate(pt.time);
      const _vrs  = mainChart.timeScale().getVisibleLogicalRange();
      const _bvs  = _vrs ? Math.max(10, _vrs.to - _vrs.from) : 50;
      const _ppbs = (drawCanvas?.width || 800) / _bvs;
      const _bws  = Math.max(3, Math.round(Math.abs((_ex2s ?? 0) - (_ex1s ?? 0)) / _ppbs));
      drawings.push({ id:_did(), type:"shortpos", p1:drawingWIP.p1, tp, sl, color:_drawColor, barWidth:_bws });
      drawingWIP = null;
      saveDrawings(); _returnToPointer();
    }
    return;
  }

  // 雙點工具（trendline / ray / fib）
  if (!drawingWIP) {
    drawingWIP = { type:drawTool, p1:pt };
  } else {
    drawings.push({ id:_did(), type:drawTool, p1:drawingWIP.p1, p2:pt, color:_drawColor });
    drawingWIP = null;
    saveDrawings(); _returnToPointer();
    requestAnimationFrame(renderDrawings);
  }
}

function _onChartDblClick(e) {
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (near) {
    // 顏色面板由 _onChartClick 計時器負責開啟，此處只確保選中
    e.stopPropagation();
    selectedId = near.id;
    requestAnimationFrame(renderDrawings);
    return;
  }
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
  } else if ((d.type === "longpos" || d.type === "shortpos") && d.p1) {
    const part = dragState.part || "entry";
    if (part === "tp") {
      // 獨立拖移停利線
      const oty = candleSeries?.priceToCoordinate(orig.tp);
      if (oty != null) d.tp = candleSeries?.coordinateToPrice(oty + dy) ?? orig.tp;
    } else if (part === "sl") {
      // 獨立拖移停損線
      const osy = candleSeries?.priceToCoordinate(orig.sl);
      if (osy != null) d.sl = candleSeries?.coordinateToPrice(osy + dy) ?? orig.sl;
    } else if (part === "width") {
      // 拖移左邊緣調整色塊寬度（往左拉→變寬，往右推→變窄）
      const visR = mainChart.timeScale().getVisibleLogicalRange();
      const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
      const W2 = drawCanvas?.width || 800;
      d.barWidth = Math.max(3, (orig.barWidth ?? 3) + Math.round(dx / (W2 / barsV)));
    } else {
      // entry：整體平移（TP/SL 跟隨）
      const oy = candleSeries?.priceToCoordinate(orig.p1.price);
      if (oy != null) {
        const newEntry  = candleSeries?.coordinateToPrice(oy + dy) ?? orig.p1.price;
        const entryDiff = newEntry - orig.p1.price;
        d.p1 = { ...orig.p1, price: newEntry };
        d.tp = orig.tp + entryDiff;
        d.sl = orig.sl + entryDiff;
      }
      const ox = mainChart.timeScale().timeToCoordinate(orig.p1.time);
      if (ox != null) { const nt = mainChart.timeScale().coordinateToTime(ox + dx); if (nt != null) d.p1 = { ...d.p1, time: nt }; }
    }
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
  if (!_cpShowDirect) return;
  const noStyle = drawing.type === "note";
  _cpShowDirect(clientX, clientY, {
    sections: [{
      label: null,
      currentColor: (drawing.color || "#2962ff").substring(0, 7),
      apply: c => {
        drawing.color = c;
        _drawColor = c;
        saveDrawings();
        requestAnimationFrame(renderDrawings);
      }
    }],
    onDelete: () => {
      drawings = drawings.filter(d => d.id !== drawing.id);
      if (selectedId === drawing.id) selectedId = null;
      saveDrawings();
      requestAnimationFrame(renderDrawings);
    },
    showStyle: !noStyle,
    currentWidth: drawing.width || 1,
    currentLineStyle: drawing.lineStyle ?? 0,
    onStyleChange: (w, s) => {
      drawing.width = w; drawing.lineStyle = s;
      saveDrawings(); requestAnimationFrame(renderDrawings);
    }
  });
}

/* ── 圖例 / K棒 顏色 Popup（無刪除按鈕）── */
// sections: [{ label, currentColor, apply }]
function showLegColorPopup(clientX, clientY, sections) {
  if (!_cpShowDirect) return;
  _cpShowDirect(clientX, clientY, { sections, onDelete: null });
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
    // price scale 區域（右側，coordinateToTime 回傳 null）不攔截，讓 LWC 處理上下拖移
    if (mainChart.timeScale().coordinateToTime(x) == null && x > (drawCanvas?.width ?? 0) * 0.6) return Infinity;
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
  if ((d.type === "longpos" || d.type === "shortpos") && d.p1) {
    const W2 = drawCanvas?.width || 800;
    const startX = mainChart.timeScale().timeToCoordinate(d.p1.time);
    if (startX == null) return Infinity;
    const visR  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const zw    = Math.max(20, Math.min(W2 * 0.4, Math.round(W2 * (d.barWidth ?? 3) / barsV)));
    const ex = startX, rx3 = Math.min(W2, ex + zw);
    // 只有在色塊區（ex..rx3）或右側標籤區（W-100..W）才命中
    if (x < ex - 10) return Infinity;
    if (x > rx3 + 20 && x < W2 - 100) return Infinity;
    const ey = candleSeries?.priceToCoordinate(d.p1.price);
    const ty = candleSeries?.priceToCoordinate(d.tp);
    const sy = candleSeries?.priceToCoordinate(d.sl);
    const dists = [ey, ty, sy].filter(v => v != null).map(v => Math.abs(v - y));
    return dists.length ? Math.min(...dists) : Infinity;
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
  const col = d.color || _drawColor;
  drawCtx.save();
  drawCtx.strokeStyle = col;
  drawCtx.fillStyle   = col;
  drawCtx.lineWidth   = d.width || DRAW_WIDTH;
  const _dash = d.lineStyle === 2 ? [6,4] : d.lineStyle === 1 ? [2,3] : [];
  drawCtx.setLineDash(_dash);
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
  else if (d.type === "longpos" && d.p1) {
    const entryY = candleSeries?.priceToCoordinate(d.p1.price);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);
    const slY    = candleSeries?.priceToCoordinate(d.sl);
    const startX = mainChart.timeScale().timeToCoordinate(d.p1.time);
    if (entryY == null || tpY == null || slY == null || startX == null) { drawCtx.restore(); return; }

    // 色塊寬度隨縮放動態計算（約 18 根 K 棒的寬度）
    const visR  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const ZONE_W = Math.max(20, Math.min(W * 0.4, Math.round(W * (d.barWidth ?? 3) / barsV)));
    const ex  = startX;
    const rx  = Math.min(W, ex + ZONE_W);
    const lw  = d.width || 1;

    drawCtx.shadowBlur = 0;
    drawCtx.font = "11px sans-serif";

    // 右側標籤 helper
    const rightLabel = (y, text, bg, fg) => {
      const tw = drawCtx.measureText(text).width;
      const pad = 6, lh = 17, lw2 = tw + pad * 2;
      drawCtx.fillStyle = bg;
      drawCtx.fillRect(W - lw2 - 1, y - 9, lw2, lh);
      drawCtx.fillStyle = fg;
      drawCtx.fillText(text, W - lw2 - 1 + pad, y + 4);
    };

    // 色塊（entry → rx）
    if (rx > ex) {
      drawCtx.fillStyle = "rgba(38,166,154,0.18)";
      drawCtx.fillRect(ex, tpY, rx - ex, entryY - tpY);
      drawCtx.fillStyle = "rgba(239,83,80,0.18)";
      drawCtx.fillRect(ex, entryY, rx - ex, slY - entryY);
    }

    // 進場虛線（entry 垂直線）
    if (ex >= 0 && ex <= W) {
      drawCtx.strokeStyle = "rgba(255,255,255,0.4)";
      drawCtx.lineWidth = 1;
      drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(ex, slY); drawCtx.stroke();
      drawCtx.setLineDash([]);
    }

    // 水平線（ex → rx）
    drawCtx.strokeStyle = "#26a69a";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();

    drawCtx.strokeStyle = col;
    drawCtx.lineWidth = isSelected ? lw * 1.5 : lw * 1.2;
    drawCtx.beginPath(); drawCtx.moveTo(ex, entryY); drawCtx.lineTo(rx, entryY); drawCtx.stroke();

    drawCtx.strokeStyle = "#ef5350";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(rx, slY); drawCtx.stroke();

    // 進場三角（在 entry 左側，指向右進入色塊）
    if (ex >= 0 && ex <= W) {
      const ts = 7;
      drawCtx.fillStyle = col;
      drawCtx.beginPath();
      drawCtx.moveTo(ex, entryY - ts / 2);
      drawCtx.lineTo(ex + ts, entryY);
      drawCtx.lineTo(ex, entryY + ts / 2);
      drawCtx.closePath(); drawCtx.fill();
    }

    // R:R 置中（綠色區塊中央）
    const reward = Math.abs(d.tp - d.p1.price);
    const risk   = Math.abs(d.p1.price - d.sl);
    const rr     = risk > 0 ? (reward / risk).toFixed(2) : "∞";
    const tpCY   = (tpY + entryY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt  = `1 : ${rr}`;
    const rrW    = drawCtx.measureText(rrTxt).width;
    drawCtx.fillStyle = "rgba(38,166,154,0.95)";
    if (rx - ex > rrW + 10) drawCtx.fillText(rrTxt, ex + (rx - ex - rrW) / 2, tpCY + 4);

    // 右側標籤
    drawCtx.font = "11px sans-serif";
    rightLabel(tpY,    `TP  ${_fmtPx(d.tp)}`,      "rgba(38,166,154,0.9)", "#fff");
    rightLabel(entryY, `▶  ${_fmtPx(d.p1.price)}`, "rgba(55,55,55,0.9)",   "#ddd");
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,      "rgba(239,83,80,0.9)",  "#fff");

    // 選中時：TP/SL 拖移把手 + 右邊緣寬度把手
    if (isSelected) {
      [[ex, entryY, "#ffffff"], [ex, tpY, "#26a69a"], [ex, slY, "#ef5350"]].forEach(([px, py, fc]) => {
        if (px >= 0 && px <= W) {
          drawCtx.fillStyle = fc;
          drawCtx.beginPath(); drawCtx.arc(px, py, 5, 0, Math.PI * 2); drawCtx.fill();
        }
      });
      // 右邊緣寬度把手
      const midY = (tpY + slY) / 2;
      drawCtx.strokeStyle = "rgba(255,255,255,0.75)";
      drawCtx.lineWidth = 2; drawCtx.setLineDash([]);
      drawCtx.beginPath(); drawCtx.moveTo(rx, tpY); drawCtx.lineTo(rx, slY); drawCtx.stroke();
      drawCtx.fillStyle = "rgba(255,255,255,0.9)";
      [-7, 0, 7].forEach(oy => { drawCtx.beginPath(); drawCtx.arc(rx, midY + oy, 2.5, 0, Math.PI * 2); drawCtx.fill(); });
      // TP / SL 拖移提示箭頭（↕）
      drawCtx.font = "bold 11px sans-serif";
      drawCtx.fillStyle = "rgba(255,255,255,0.7)";
      const midX = ex + (rx - ex) / 2;
      if (rx - ex > 30) {
        drawCtx.fillText("↕", midX - 5, tpY - 4);
        drawCtx.fillText("↕", midX - 5, slY + 12);
      }
    }
  }
  else if (d.type === "shortpos" && d.p1) {
    // shortpos: SL 在 entry 上方（紅），TP 在 entry 下方（綠）
    const entryY = candleSeries?.priceToCoordinate(d.p1.price);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);   // tp < entry → tpY > entryY
    const slY    = candleSeries?.priceToCoordinate(d.sl);   // sl > entry → slY < entryY
    const startX = mainChart.timeScale().timeToCoordinate(d.p1.time);
    if (entryY == null || tpY == null || slY == null || startX == null) { drawCtx.restore(); return; }

    const visR2  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV2 = visR2 ? Math.max(10, visR2.to - visR2.from) : 50;
    const ZONE_W = Math.max(20, Math.min(W * 0.4, Math.round(W * (d.barWidth ?? 3) / barsV2)));
    const ex  = startX;
    const rx  = Math.min(W, ex + ZONE_W);
    const lw  = d.width || 1;

    drawCtx.shadowBlur = 0;
    drawCtx.font = "11px sans-serif";

    const rightLabel = (y, text, bg, fg) => {
      const tw = drawCtx.measureText(text).width;
      const pad = 6, lh = 17, lw2 = tw + pad * 2;
      drawCtx.fillStyle = bg;
      drawCtx.fillRect(W - lw2 - 1, y - 9, lw2, lh);
      drawCtx.fillStyle = fg;
      drawCtx.fillText(text, W - lw2 - 1 + pad, y + 4);
    };

    // 色塊（entry → rx）
    if (rx > ex) {
      drawCtx.fillStyle = "rgba(239,83,80,0.18)";
      drawCtx.fillRect(ex, slY, rx - ex, entryY - slY);
      drawCtx.fillStyle = "rgba(38,166,154,0.18)";
      drawCtx.fillRect(ex, entryY, rx - ex, tpY - entryY);
    }

    // 進場虛線
    if (ex >= 0 && ex <= W) {
      drawCtx.strokeStyle = "rgba(255,255,255,0.4)";
      drawCtx.lineWidth = 1;
      drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(ex, tpY); drawCtx.stroke();
      drawCtx.setLineDash([]);
    }

    drawCtx.strokeStyle = "#ef5350";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(rx, slY); drawCtx.stroke();

    drawCtx.strokeStyle = col;
    drawCtx.lineWidth = isSelected ? lw * 1.5 : lw * 1.2;
    drawCtx.beginPath(); drawCtx.moveTo(ex, entryY); drawCtx.lineTo(rx, entryY); drawCtx.stroke();

    drawCtx.strokeStyle = "#26a69a";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();

    // 進場三角
    if (ex >= 0 && ex <= W) {
      const ts = 7;
      drawCtx.fillStyle = col;
      drawCtx.beginPath();
      drawCtx.moveTo(ex, entryY - ts / 2);
      drawCtx.lineTo(ex + ts, entryY);
      drawCtx.lineTo(ex, entryY + ts / 2);
      drawCtx.closePath(); drawCtx.fill();
    }

    // R:R 置中
    const reward = Math.abs(d.p1.price - d.tp);
    const risk   = Math.abs(d.sl - d.p1.price);
    const rr     = risk > 0 ? (reward / risk).toFixed(2) : "∞";
    const tpCY   = (entryY + tpY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt  = `1 : ${rr}`;
    const rrW    = drawCtx.measureText(rrTxt).width;
    drawCtx.fillStyle = "rgba(38,166,154,0.95)";
    if (rx - ex > rrW + 10) drawCtx.fillText(rrTxt, ex + (rx - ex - rrW) / 2, tpCY + 4);

    drawCtx.font = "11px sans-serif";
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,      "rgba(239,83,80,0.9)",  "#fff");
    rightLabel(entryY, `▶  ${_fmtPx(d.p1.price)}`, "rgba(55,55,55,0.9)",   "#ddd");
    rightLabel(tpY,    `TP  ${_fmtPx(d.tp)}`,      "rgba(38,166,154,0.9)", "#fff");

    if (isSelected) {
      [[ex, entryY, "#ffffff"], [ex, slY, "#ef5350"], [ex, tpY, "#26a69a"]].forEach(([px, py, fc]) => {
        if (px >= 0 && px <= W) {
          drawCtx.fillStyle = fc;
          drawCtx.beginPath(); drawCtx.arc(px, py, 5, 0, Math.PI * 2); drawCtx.fill();
        }
      });
      // 右邊緣寬度把手
      const midY2 = (slY + tpY) / 2;
      drawCtx.strokeStyle = "rgba(255,255,255,0.75)";
      drawCtx.lineWidth = 2; drawCtx.setLineDash([]);
      drawCtx.beginPath(); drawCtx.moveTo(rx, slY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();
      drawCtx.fillStyle = "rgba(255,255,255,0.9)";
      [-7, 0, 7].forEach(oy => { drawCtx.beginPath(); drawCtx.arc(rx, midY2 + oy, 2.5, 0, Math.PI * 2); drawCtx.fill(); });
      drawCtx.font = "bold 11px sans-serif";
      drawCtx.fillStyle = "rgba(255,255,255,0.7)";
      const midX = ex + (rx - ex) / 2;
      if (rx - ex > 30) {
        drawCtx.fillText("↕", midX - 5, slY - 4);
        drawCtx.fillText("↕", midX - 5, tpY + 12);
      }
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
  const bg = C.chartBg || C.bg;
  // LWC canvas 保持透明，讓浮水印顯示在 K棒下方；背景色由 CSS 提供
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ layout: { background:{ color:"rgba(0,0,0,0)" }, textColor:"#d1d4dc" } })
  );
  document.body.style.background = bg;
  const _cc = document.querySelector(".charts-container");
  if (_cc) _cc.style.background = bg;

  if (currentChartType === "candlestick") {
    const bodyUp   = S.bodyVisible   !== false ? C.up        : "rgba(0,0,0,0)";
    const bodyDown = S.bodyVisible   !== false ? C.down      : "rgba(0,0,0,0)";
    candleSeries.applyOptions({
      upColor: bodyUp, downColor: bodyDown,
      borderVisible: S.borderVisible !== false,
      borderUpColor: C.borderUp, borderDownColor: C.borderDown,
      wickVisible: S.wickVisible !== false,
      wickUpColor: C.wickUp, wickDownColor: C.wickDown,
    });
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
  macdLine.applyOptions({ color:C.macd }); macdSignal.applyOptions({ color:C.macdSig }); macdHist?.applyOptions({ color:C.macdHist });

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

  // Tab row for multi-section (K-bar mode) – inserted before color grid
  const tabRow = document.createElement("div"); tabRow.className = "cp-tab-row";
  tabRow.style.display = "none";
  popup.appendChild(tabRow);

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

  // 刪除按鈕列（繪圖直接模式用）
  const delRow = document.createElement("div"); delRow.className = "cp-del-row";
  delRow.style.display = "none";
  const delBtn = document.createElement("button"); delBtn.className = "dcp-delete";
  delBtn.type = "button"; delBtn.textContent = "刪除線條";
  delRow.appendChild(delBtn);
  popup.appendChild(delRow);

  document.body.appendChild(popup);

  /* ── 狀態 ── */
  let currentInput  = null;
  let currentHex    = "#ffffff";
  let currentSwatch = null;
  let currentWidth  = null;   // null = 不覆寫（此 input 不支援寬度）
  let currentStyle  = null;
  let _directSecs           = null;
  let _activeSecIdx         = 0;
  let _directOnDelete       = null;
  let _directOnStyleChange  = null;

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
    const pct = parseInt(opSlider.value);
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    const finalColor = pct >= 100 ? currentHex : hexAlpha(currentHex, pct);

    if (_directSecs) {
      const sec = _directSecs[_activeSecIdx];
      sec.currentColor = finalColor;
      sec.apply(finalColor, pct);
      const dots = tabRow.querySelectorAll(".cp-tab-dot");
      if (dots[_activeSecIdx]) dots[_activeSecIdx].style.background = finalColor;
      if (_directOnStyleChange && activeWidthBtn && activeStyleBtn)
        _directOnStyleChange(parseInt(activeWidthBtn.dataset.value), parseInt(activeStyleBtn.dataset.value));
      return;
    }
    if (!currentInput) return;
    currentInput._cpColor = finalColor;
    currentInput.value    = currentHex;
    const tr = currentInput.previousElementSibling;
    if (tr?.classList.contains("cp-trigger")) tr.style.background = finalColor;
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
    _directSecs = null; _directOnDelete = null; _directOnStyleChange = null;
    tabRow.style.display = "none";
    delRow.style.display = "none";
  }

  function showDirect(clientX, clientY, { sections, onDelete, showStyle, currentWidth, currentLineStyle, onStyleChange }) {
    closePicker();
    _directSecs = sections; _activeSecIdx = 0;
    _directOnDelete = onDelete || null;
    _directOnStyleChange = onStyleChange || null;
    currentInput = null;

    tabRow.innerHTML = "";
    tabRow.style.display = sections.length > 1 ? "flex" : "none";
    sections.forEach((sec, i) => {
      const btn = document.createElement("button");
      btn.className = "cp-tab-btn" + (i === 0 ? " active" : "");
      btn.type = "button";
      const dot = document.createElement("span"); dot.className = "cp-tab-dot";
      dot.style.background = (sec.currentColor || "#fff").substring(0, 7);
      btn.appendChild(dot);
      if (sec.label) btn.appendChild(document.createTextNode(" " + sec.label));
      btn.addEventListener("mousedown", e => {
        e.stopPropagation();
        _activeSecIdx = i;
        tabRow.querySelectorAll(".cp-tab-btn").forEach((b, j) => b.classList.toggle("active", j === i));
        currentHex = (sections[i].currentColor || "#ffffff").substring(0, 7);
        opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
        popup.querySelectorAll(".cp-swatch").forEach(sw =>
          sw.classList.toggle("selected", sw.dataset.color.toLowerCase() === currentHex.toLowerCase()));
      });
      tabRow.appendChild(btn);
    });

    currentHex = (sections[0].currentColor || "#ffffff").substring(0, 7);
    opSlider.value = 100; opNum.value = 100;
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    if (currentSwatch) currentSwatch.classList.remove("selected");
    currentSwatch = null;
    popup.querySelectorAll(".cp-swatch").forEach(sw => {
      if (sw.dataset.color.toLowerCase() === currentHex.toLowerCase()) {
        sw.classList.add("selected"); currentSwatch = sw;
      }
    });

    thickWrap.style.display = showStyle ? "" : "none";
    styleWrap.style.display = showStyle ? "" : "none";
    if (showStyle) {
      activeWidthBtn?.classList.remove("active"); activeWidthBtn = null;
      activeStyleBtn?.classList.remove("active"); activeStyleBtn = null;
      const w = currentWidth || 1, s = currentLineStyle ?? 0;
      widthBtns.forEach(b => { if (parseInt(b.dataset.value) === w) { b.classList.add("active"); activeWidthBtn = b; } });
      styleBtns.forEach(b => { if (parseInt(b.dataset.value) === s) { b.classList.add("active"); activeStyleBtn = b; } });
    }
    delRow.style.display = onDelete ? "flex" : "none";
    delBtn.onclick = () => { if (_directOnDelete) _directOnDelete(); closePicker(); };

    let left = clientX + 12, top = clientY - 10;
    if (left + 234 > window.innerWidth)  left = clientX - 234 - 12;
    if (top  + 420 > window.innerHeight) top  = window.innerHeight - 420 - 8;
    if (top < 4) top = 4;
    popup.style.left = left + "px";
    popup.style.top  = top  + "px";
    popup.classList.add("open");
  }

  _cpShowDirect = showDirect;

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
function _updateStarBtn() {
  const btn    = document.getElementById("watchlistStarBtn");
  if (!btn) return;
  const symbol   = document.getElementById("symbolInput")?.value?.trim();
  const market   = document.getElementById("marketSelect")?.value || "crypto";
  const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
  if (!symbol) { btn.textContent = "☆"; btn.classList.remove("active"); return; }
  const key  = `${market}:${exchange}:${symbol}`;
  const inWl = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  btn.textContent = inWl ? "★" : "☆";
  btn.classList.toggle("active", inWl);
}

function bindEvents() {
  document.getElementById("marketSelect").addEventListener("change", updateMarketUI);
  document.getElementById("loadBtn").addEventListener("click", () => loadData(false));
  document.getElementById("loadBtnMob")?.addEventListener("click", () => loadData(false));

  // ── 自選星號按鈕 ──────────────────────────────
  document.getElementById("watchlistStarBtn")?.addEventListener("click", () => {
    const symbol   = document.getElementById("symbolInput")?.value?.trim();
    const market   = document.getElementById("marketSelect")?.value || "crypto";
    const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
    if (!symbol) return;
    _toggleWatchlist(symbol, market, exchange);
    _updateStarBtn();
  });

  // ── 側欄 / 行情列表 ──────────────────────────────
  const isMobile = () => window.innerWidth <= 768;
  function openTicker()   { document.getElementById("tickerPanel").classList.add("ticker-open");  showOverlay(); }
  function closeTicker()  { document.getElementById("tickerPanel").classList.remove("ticker-open"); checkOverlay(); }
  function showOverlay()  { document.getElementById("panelOverlay").classList.remove("hidden"); }
  function checkOverlay() {
    const tickerOpen = document.getElementById("tickerPanel").classList.contains("ticker-open");
    if (!tickerOpen) document.getElementById("panelOverlay").classList.add("hidden");
  }

  document.getElementById("tickerToggle")?.addEventListener("click", () => {
    if (isMobile()) {
      const open = document.getElementById("tickerPanel").classList.contains("ticker-open");
      open ? closeTicker() : openTicker();
    } else {
      document.getElementById("tickerPanel").classList.toggle("ticker-collapsed");
      setTimeout(resizeAll, 50);
    }
  });
  document.getElementById("panelOverlay").addEventListener("click", closeTicker);

  // 系統外觀設定按鈕
  const _sysBtn = document.getElementById("sysSettingsBtn");
  const _sysPop = document.getElementById("sysSettingsPopup");
  _sysBtn?.addEventListener("click", e => {
    e.stopPropagation();
    const opening = !_sysPop.classList.contains("open");
    _sysPop.classList.toggle("open");
    if (opening) {
      syncSysSwatches();
      requestAnimationFrame(() => {
        const rect = _sysBtn.getBoundingClientRect();
        const pw = _sysPop.offsetWidth, ph = _sysPop.offsetHeight;
        let left = rect.right - pw;
        let top  = rect.bottom + 4;
        if (left < 4) left = 4;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
        _sysPop.style.left = left + "px";
        _sysPop.style.top  = top  + "px";
      });
    }
  });
  document.addEventListener("click", e => {
    if (_sysPop && !_sysPop.contains(e.target) && e.target !== _sysBtn) {
      _sysPop.classList.remove("open");
    }
  });

  document.getElementById("tickerList").addEventListener("click", () => {
    if (isMobile()) closeTicker();
  }, true);

  // 重播模式切換
  document.getElementById("replayModeBtn").addEventListener("click", () => {
    if (replayActive) { exitReplay(); return; }
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
      document.getElementById("cpPopup")?.classList.remove("open");
      saveDrawings();
      requestAnimationFrame(renderDrawings);
    }
  });

  // indicatorsToggle 保留（無操作，設定改由各 pane 的 ⚙ 按鈕開啟）

  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTF = btn.dataset.tf;
      loadData(false);   // 切換時區自動載入，不需手動按「載入」
    });
  });

  bindPaneDividers();
  bindLegendToggles();
  bindLegendColors();
  initColorPicker();
  bindReplayBar();
  bindIndicatorPanel();
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

  // 台股：不支援 4h（盤中僅 4.5 小時）；美股：只支援日/週/月線
  document.querySelectorAll(".tf-btn").forEach(btn => {
    const off = (isTW && ["4h"].includes(btn.dataset.tf)) ||
                (isUS && ["4h","1h","15m","5m"].includes(btn.dataset.tf));
    btn.disabled = off;
    if (off && btn.classList.contains("active")) {
      btn.classList.remove("active");
      document.querySelector(".tf-btn[data-tf='1d']").classList.add("active");
      currentTF = "1d";
    }
  });

  // 符號搜尋 modal tabs
  const tabFutures = document.querySelector(".sym-tab[data-market='futures']");
  const tabSpot    = document.querySelector(".sym-tab[data-market='spot']");
  const tabUS      = document.querySelector(".sym-tab[data-market='us']");
  const tabTW      = document.querySelector(".sym-tab[data-market='tw']");
  if (tabFutures) tabFutures.style.display = isCrypto ? "" : "none";
  if (tabSpot)    tabSpot.style.display    = isCrypto ? "" : "none";
  if (tabUS)      tabUS.style.display      = isUS ? "" : "none";
  if (tabTW)      tabTW.style.display      = isTW ? "" : "none";
}

/* ── 面板拖曳分隔 ── */
function bindPaneDividers() {
  document.querySelectorAll(".pane-divider").forEach(divider => {
    let startY, startFlex, nextFlex, pane, nextPane;

    function startDrag(clientY) {
      pane     = document.getElementById(divider.dataset.target);
      nextPane = nextVisiblePane(pane);
      if (!nextPane) return false;
      startY    = clientY;
      startFlex = parseFloat(pane.style.flex)     || 1;
      nextFlex  = parseFloat(nextPane.style.flex) || 1;
      divider.classList.add("dragging");
      return true;
    }
    function doMove(clientY) {
      const dy    = clientY - startY;
      const total = pane.parentElement.clientHeight;
      const delta = (dy / total) * (startFlex + nextFlex);
      pane.style.flex     = Math.max(0.2, startFlex + delta);
      nextPane.style.flex = Math.max(0.2, nextFlex  - delta);
      resizeAll();
    }
    function endDrag() {
      divider.classList.remove("dragging");
      savePaneFlexes();
    }

    divider.addEventListener("mousedown", e => {
      e.preventDefault();
      if (!startDrag(e.clientY)) return;
      const onMove = e => doMove(e.clientY);
      const onUp   = () => { endDrag(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });

    divider.addEventListener("touchstart", e => {
      e.preventDefault();
      if (!startDrag(e.touches[0].clientY)) return;
      const onMove = e => doMove(e.touches[0].clientY);
      const onEnd  = () => { endDrag(); divider.removeEventListener("touchmove", onMove); divider.removeEventListener("touchend", onEnd); };
      divider.addEventListener("touchmove", onMove, { passive: false });
      divider.addEventListener("touchend",  onEnd);
    }, { passive: false });
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

/* ── 圖例顏色點（點色點即可改色）── */
function bindLegendColors() {
  const map = [
    { id:"legBB",      key:"bbU",     apply: c => { C.bbU = C.bbL = c; bbU?.applyOptions({color:c}); bbL?.applyOptions({color:c}); savePrefs(); } },
    { id:"legCRT",     key:"crtBull", apply: c => { C.crtBull = c; if (ohlcvData.length) renderCRT(ohlcvData); savePrefs(); } },
    { id:"legVol",     key:"up",      apply: c => { if (ohlcvData.length) renderVolume(ohlcvData); savePrefs(); } },
    { id:"legK",       key:"kdjK",    apply: c => { C.kdjK = c; kdjK?.applyOptions({color:c}); const el=document.getElementById("legK");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legD",       key:"kdjD",    apply: c => { C.kdjD = c; kdjD?.applyOptions({color:c}); const el=document.getElementById("legD");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legJ",       key:"kdjJ",    apply: c => { C.kdjJ = c; kdjJ?.applyOptions({color:c}); const el=document.getElementById("legJ");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi14",   key:"rsi14",   apply: c => { C.rsi14   = c; rsiLine14?.applyOptions({color:c});  const el=document.getElementById("legRsi14");  if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi7",    key:"rsi7",    apply: c => { C.rsi7    = c; rsiLine7?.applyOptions({color:c});   const el=document.getElementById("legRsi7");   if(el) el.style.color=c; savePrefs(); } },
    { id:"legKdjH20",  key:"kdjH20",  apply: c => { C.kdjH20  = c; kdjH20?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH50",  key:"kdjH50",  apply: c => { C.kdjH50  = c; kdjH50?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH80",  key:"kdjH80",  apply: c => { C.kdjH80  = c; kdjH80?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH30",  key:"rsiH30",  apply: c => { C.rsiH30  = c; rsiH30?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH50",  key:"rsiH50",  apply: c => { C.rsiH50  = c; rsiH50?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH70",  key:"rsiH70",  apply: c => { C.rsiH70  = c; rsiH70?.applyOptions({color:c}); savePrefs(); } },
    { id:"legMacd",    key:"macd",    apply: c => { C.macd    = c; macdLine?.applyOptions({color:c});   const el=document.getElementById("legMacd");    if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdSig", key:"macdSig", apply: c => { C.macdSig = c; macdSignal?.applyOptions({color:c}); const el=document.getElementById("legMacdSig"); if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdHist",key:"macdHist",apply: c => { C.macdHist = c; macdHist?.applyOptions({color:c}); savePrefs(); } },
  ];
  map.forEach(({ id, key, apply }) => {
    const legEl = document.getElementById(id);
    if (!legEl) return;
  });
}

/* ── 指標設定面板 ── */
function bindIndicatorPanel() {
  const LS_CHARS = ["—", "···", "- -", "──"];
  const popup = document.getElementById("indSettingsPopup");
  if (!popup) return;

  // 點外部關閉
  document.addEventListener("mousedown", e => {
    if (!popup.contains(e.target) && !e.target.closest(".ind-gear-btn"))
      popup.classList.remove("open");
  }, true);

  // 各指標設定定義
  const IND_CONFIGS = {
    main: {
      title: "主圖設定",
      rows: [
        { candleRow: true, label:"主體", visKey:"bodyVisible",   upKey:"up",        downKey:"down"      },
        { candleRow: true, label:"邊框", visKey:"borderVisible", upKey:"borderUp",  downKey:"borderDown" },
        { candleRow: true, label:"燭芯", visKey:"wickVisible",   upKey:"wickUp",    downKey:"wickDown"   },
        { divider: true },
        { label:"BB 上/下", colorKey:"bbU", onColor: c=>{ C.bbL=c; bbU?.applyOptions({color:c}); bbL?.applyOptions({color:c}); _syncLegDot("legBB",c); }, widKey:"bbWidth", onWidth: w=>{ bbU?.applyOptions({lineWidth:w}); bbL?.applyOptions({lineWidth:w}); } },
        { label:"BB 中",    colorKey:"bbM", onColor: c=>{ bbM?.applyOptions({color:c}); }, widKey:"bbMWidth", serW:()=>bbM },
        { divider: true },
        { label:"CRT 看多", colorKey:"crtBull", onColor: ()=>{ if(ohlcvData.length) renderCRT(ohlcvData); } },
        { label:"CRT 看空", colorKey:"crtBear", onColor: ()=>{ if(ohlcvData.length) renderCRT(ohlcvData); } },
        { divider: true },
        { label:"共振 看多", colorKey:"resonanceBull", onColor: ()=>{ if(ohlcvData.length) renderResonance(ohlcvData); } },
        { label:"共振 看空", colorKey:"resonanceBear", onColor: ()=>{ if(ohlcvData.length) renderResonance(ohlcvData); } },
        { divider: true },
        { label:"KDJ金叉",  colorKey:"kdjCrossBull", onColor: ()=>{ if(ohlcvData.length) renderKDJCross(ohlcvData); } },
        { label:"KDJ死叉",  colorKey:"kdjCrossBear", onColor: ()=>{ if(ohlcvData.length) renderKDJCross(ohlcvData); } },
        { divider: true },
        { label:"主圖背景", colorKey:"chartBg", bgPresets: true, onColor: c=>{
            C.chartBg = c;
            document.body.style.background = c;
            const _cc = document.querySelector(".charts-container");
            if (_cc) _cc.style.background = c;
            savePrefs();
          }
        },
        { divider: true },
        { volRow: true, label:"量柱", upKey:"volUp", downKey:"volDown", alphaKey:"volAlpha",
          onColor: ()=>{ if (ohlcvData.length) renderVolume(ohlcvData); },
          onAlpha: ()=>{ if (ohlcvData.length) renderVolume(ohlcvData); }
        },
      ]
    },
    kdj: {
      title: "KDJ 設定",
      rows: [
        { label:"K", colorKey:"kdjK",    onColor: c=>{kdjK?.applyOptions({color:c}); _syncLegDot("legK",c);},    lsKey:"kdjKStyle",   series:()=>kdjK,    widKey:"kdjKWidth",   serW:()=>kdjK },
        { label:"D", colorKey:"kdjD",    onColor: c=>{kdjD?.applyOptions({color:c}); _syncLegDot("legD",c);},    lsKey:"kdjDStyle",   series:()=>kdjD,    widKey:"kdjDWidth",   serW:()=>kdjD },
        { label:"J", colorKey:"kdjJ",    onColor: c=>{kdjJ?.applyOptions({color:c}); _syncLegDot("legJ",c);},    lsKey:"kdjJStyle",   series:()=>kdjJ,    widKey:"kdjJWidth",   serW:()=>kdjJ },
        { divider: true },
        { label:"超買", colorKey:"kdjH80", onColor: c=>{kdjH80?.applyOptions({color:c}); _syncLegDot("legKdjH80",c);}, numKey:"kdjH80val", numSeries:()=>kdjH80, widKey:"kdjHLWidth", onWidth: w=>{ [kdjH20,kdjH50,kdjH80].forEach(s=>s?.applyOptions({lineWidth:w})); } },
        { label:"超賣", colorKey:"kdjH20", onColor: c=>{kdjH20?.applyOptions({color:c}); _syncLegDot("legKdjH20",c);}, numKey:"kdjH20val", numSeries:()=>kdjH20 },
      ]
    },
    rsi: {
      title: "RSI 設定",
      rows: [
        { label:"RSI 14", colorKey:"rsi14", onColor: c=>{rsiLine14?.applyOptions({color:c}); _syncLegDot("legRsi14",c);}, lsKey:"rsi14Style", series:()=>rsiLine14, widKey:"rsi14Width", serW:()=>rsiLine14 },
        { label:"RSI 7",  colorKey:"rsi7",  onColor: c=>{rsiLine7?.applyOptions({color:c});  _syncLegDot("legRsi7",c);},  lsKey:"rsi7Style",  series:()=>rsiLine7,  widKey:"rsi7Width",  serW:()=>rsiLine7  },
        { divider: true },
        { label:"超買", colorKey:"rsiH70", onColor: c=>{rsiH70?.applyOptions({color:c}); _syncLegDot("legRsiH70",c);}, numKey:"rsiH70val", numSeries:()=>rsiH70, widKey:"rsiHLWidth", onWidth: w=>{ [rsiH30,rsiH50,rsiH70].forEach(s=>s?.applyOptions({lineWidth:w})); } },
        { label:"超賣", colorKey:"rsiH30", onColor: c=>{rsiH30?.applyOptions({color:c}); _syncLegDot("legRsiH30",c);}, numKey:"rsiH30val", numSeries:()=>rsiH30 },
      ]
    },
    macd: {
      title: "MACD 設定",
      rows: [
        { label:"MACD",   colorKey:"macd",    onColor: c=>{macdLine?.applyOptions({color:c});   _syncLegDot("legMacd",c);},    lsKey:"macdStyle",    series:()=>macdLine,   widKey:"macdWidth",    serW:()=>macdLine   },
        { label:"Signal", colorKey:"macdSig", onColor: c=>{macdSignal?.applyOptions({color:c}); _syncLegDot("legMacdSig",c);}, lsKey:"macdSigStyle", series:()=>macdSignal, widKey:"macdSigWidth", serW:()=>macdSignal },
        { label:"Hist",   colorKey:"macdHist",onColor: c=>{macdHist?.applyOptions({color:c}); _syncLegDot("legMacdHist",c);} },
      ]
    },
  };

  function buildRow(row) {
    if (row.divider) {
      const el = document.createElement("div");
      el.className = "ind-sp-divider";
      return el;
    }
    if (row.candleRow) {
      const rowEl = document.createElement("div");
      rowEl.className = "ind-sp-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = S[row.visKey] !== false;
      cb.style.cssText = "width:14px;height:14px;cursor:pointer;flex-shrink:0;margin:0;accent-color:#2962ff;";
      cb.addEventListener("change", () => { S[row.visKey] = cb.checked; applyAllColors(); savePrefs(); });
      rowEl.appendChild(cb);
      const lbl = document.createElement("span");
      lbl.className = "ind-sp-lbl"; lbl.textContent = row.label;
      rowEl.appendChild(lbl);
      ["up","dn"].forEach(side => {
        const key = side === "up" ? row.upKey : row.downKey;
        const dot = document.createElement("div");
        dot.title = side === "up" ? "漲" : "跌";
        dot.style.cssText = `width:16px;height:16px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[key]||"#888").substring(0,7)}`;
        dot.addEventListener("click", e => {
          e.stopPropagation();
          showLegColorPopup(e.clientX, e.clientY, [{
            label: null,
            currentColor: (C[key]||"#888").substring(0,7),
            apply: c => { dot.style.background = c; C[key] = c; applyAllColors(); savePrefs(); }
          }]);
        });
        rowEl.appendChild(dot);
      });
      return rowEl;
    }
    if (row.volRow) {
      const rowEl = document.createElement("div");
      rowEl.className = "ind-sp-row";
      const lbl = document.createElement("span");
      lbl.className = "ind-sp-lbl"; lbl.textContent = row.label;
      rowEl.appendChild(lbl);
      ["up","dn"].forEach(side => {
        const key = side === "up" ? row.upKey : row.downKey;
        const dot = document.createElement("div");
        dot.title = side === "up" ? "漲" : "跌";
        dot.style.cssText = `width:16px;height:16px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[key]||"#888").substring(0,7)}`;
        dot.addEventListener("click", e => {
          e.stopPropagation();
          showLegColorPopup(e.clientX, e.clientY, [{
            label: null,
            currentColor: (C[key]||"#888").substring(0,7),
            apply: c => { dot.style.background = c; C[key] = c; row.onColor?.(); savePrefs(); }
          }]);
        });
        rowEl.appendChild(dot);
      });
      const opLbl = document.createElement("span");
      opLbl.className = "ind-sp-wlbl"; opLbl.textContent = "透";
      rowEl.appendChild(opLbl);
      const opInp = document.createElement("input");
      opInp.type = "number"; opInp.className = "ind-sp-num";
      opInp.min = 0; opInp.max = 100; opInp.step = 5;
      opInp.value = Math.round((S[row.alphaKey] ?? 0.67) * 100);
      opInp.style.width = "42px";
      opInp.addEventListener("change", e => {
        const v = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        opInp.value = v; S[row.alphaKey] = v / 100;
        row.onAlpha?.();
        savePrefs();
      });
      rowEl.appendChild(opInp);
      return rowEl;
    }
    const rowEl = document.createElement("div");
    rowEl.className = "ind-sp-row";

    // 標籤
    const lbl = document.createElement("span");
    lbl.className = "ind-sp-lbl";
    lbl.textContent = row.label;
    rowEl.appendChild(lbl);

    // 顏色色塊 → 點擊開 cpPopup
    if (row.colorKey) {
      const dot = document.createElement("div");
      dot.style.cssText = `width:18px;height:18px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[row.colorKey]||"#888").substring(0,7)}`;
      dot.addEventListener("click", e => {
        e.stopPropagation();
        showLegColorPopup(e.clientX, e.clientY, [{
          label: null,
          currentColor: (C[row.colorKey] || "#888").substring(0, 7),
          apply: c => {
            dot.style.background = c;
            C[row.colorKey] = c;
            row.onColor?.(c);
            savePrefs();
          }
        }]);
      });
      rowEl.appendChild(dot);

      // 背景色快速預設色塊
      if (row.bgPresets) {
        const presets = ["#131722","#0d1117","#1a1a2e","#0f2027","#1b2838",
                         "#1e1e1e","#0a0a0a","#ffffff","#f5f5f0","#fdf6e3"];
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;margin-left:6px;";
        presets.forEach(hex => {
          const sw = document.createElement("div");
          sw.style.cssText = `width:14px;height:14px;border-radius:2px;cursor:pointer;background:${hex};border:1px solid rgba(255,255,255,0.15);flex-shrink:0;`;
          sw.title = hex;
          sw.addEventListener("click", e => {
            e.stopPropagation();
            dot.style.background = hex;
            row.onColor?.(hex);
          });
          wrap.appendChild(sw);
        });
        rowEl.appendChild(wrap);
      }
    }

    // 線型按鈕
    if (row.lsKey) {
      const lsBtn = document.createElement("button");
      lsBtn.className = "ind-sp-ls";
      const cur = S[row.lsKey] ?? 0;
      lsBtn.textContent = LS_CHARS[cur]; lsBtn.dataset.ls = cur;
      lsBtn.title = "線型";
      lsBtn.addEventListener("click", e => {
        e.stopPropagation();
        const next = ((parseInt(lsBtn.dataset.ls) || 0) + 1) % 4;
        lsBtn.dataset.ls = next; lsBtn.textContent = LS_CHARS[next];
        S[row.lsKey] = next; row.series()?.applyOptions({ lineStyle: next }); savePrefs();
      });
      rowEl.appendChild(lsBtn);
    }

    // 線寬輸入
    if (row.widKey) {
      const wlbl = document.createElement("span");
      wlbl.className = "ind-sp-wlbl"; wlbl.textContent = "粗";
      rowEl.appendChild(wlbl);
      const wInput = document.createElement("input");
      wInput.type = "number"; wInput.className = "ind-sp-num";
      wInput.min = 1; wInput.max = 5; wInput.step = 1;
      wInput.value = S[row.widKey] ?? 1;
      wInput.style.width = "34px";
      wInput.addEventListener("change", e => {
        const v = Math.max(1, Math.min(5, parseInt(e.target.value) || 1));
        wInput.value = v; S[row.widKey] = v;
        if (row.onWidth) row.onWidth(v);
        else row.serW?.()?.applyOptions({ lineWidth: v });
        savePrefs();
      });
      rowEl.appendChild(wInput);
    }

    // 數值輸入（H 水平線位置）
    if (row.numKey) {
      const nInput = document.createElement("input");
      nInput.type = "number"; nInput.className = "ind-sp-num";
      nInput.min = 1; nInput.max = 99; nInput.value = S[row.numKey] ?? 50;
      nInput.addEventListener("change", e => {
        const val = parseFloat(e.target.value); if (isNaN(val)) return;
        S[row.numKey] = val;
        if (ohlcvData.length) {
          const f = toTime(ohlcvData[0].time), l = toTime(ohlcvData[ohlcvData.length-1].time);
          row.numSeries()?.setData([{time:f,value:val},{time:l,value:val}]);
        }
        savePrefs();
      });
      rowEl.appendChild(nInput);
    }

    return rowEl;
  }

  function openPopup(triggerEl, indKey) {
    const cfg = IND_CONFIGS[indKey]; if (!cfg) return;
    popup.innerHTML = "";

    const title = document.createElement("div");
    title.className = "ind-sp-title"; title.textContent = cfg.title;
    popup.appendChild(title);

    cfg.rows.forEach(row => popup.appendChild(buildRow(row)));
    popup.classList.add("open");

    // 定位：在 trigger 下方，靠右
    requestAnimationFrame(() => {
      const rect = triggerEl.getBoundingClientRect();
      const pw = popup.offsetWidth, ph = popup.offsetHeight;
      let left = rect.right - pw;
      let top  = rect.bottom + 4;
      if (left < 4) left = 4;
      if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
      popup.style.left = left + "px";
      popup.style.top  = top  + "px";
    });
  }

  document.querySelectorAll(".ind-gear-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const indKey = btn.dataset.ind;
      if (popup.classList.contains("open")) { popup.classList.remove("open"); return; }
      openPopup(btn, indKey);
    });
  });
}

function _syncLegDot(legId, color) {
  const dot = document.querySelector(`#${legId} .leg-dot`);
  if (dot) { dot.style.background = color; dot.style.borderColor = color; }
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
    el.addEventListener("click", e => {
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
  /* 記住切換前的可見 K 棒數量，載入後還原相同縮放比例 */
  if (mainChart) {
    const _r = mainChart.timeScale().getVisibleLogicalRange();
    if (_r) _savedBarCount = Math.round(_r.to - _r.from);
  }

  stopRealtime();

  // 各時間級別依市場實際 API 限制回溯天數（加密貨幣無限制）
  if (!autoLoad) {
    const mkt = document.getElementById("marketSelect").value;
    const TF_MAX_DAYS =
      mkt === "crypto" ? {} :
      mkt === "us"     ? { "4h": 60, "1h": 730, "15m": 60, "5m": 60 } :
      mkt === "tw"     ? { "5m": 60, "15m": 60, "1h": 730 } : {};
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
          showToast(`⚠️ ${TF_LABELS[currentTF]} 資料來源最多回溯 ${maxDays} 天，起始日調整為 ${newStart}`);
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
    _updateStarBtn();
  } catch(e) {
    if (!autoLoad) alert("❌ " + e.message);
    throw e;
  } finally { showLoading(false); }
}


/* ══════════════════════════════════════════
   渲染
══════════════════════════════════════════ */
/* 根據最後成交價動態設定主圖右側價格軸精度 */
function _applyPriceFormat(data) {
  if (!data || !data.length) return;
  const p = Math.abs(data[data.length - 1]?.close || 0);
  let precision, minMove;
  if      (p >= 100)    { precision = 2; minMove = 0.01; }
  else if (p >= 1)      { precision = 4; minMove = 0.0001; }
  else if (p >= 0.1)    { precision = 5; minMove = 0.00001; }
  else if (p >= 0.01)   { precision = 6; minMove = 0.000001; }
  else if (p >= 0.001)  { precision = 7; minMove = 0.0000001; }
  else                  { precision = 8; minMove = 0.00000001; }
  const fmt = { type: "price", precision, minMove };
  [candleSeries, bbU, bbM, bbL].forEach(s => s?.applyOptions({ priceFormat: fmt }));
}

function renderAll(data) {
  // 動態調整右側價格軸精度
  _applyPriceFormat(data);

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

  // 保留切換前的 K 棒顯示數量；若無紀錄（首次載入）預設 50 根
  const _prevRange = mainChart.timeScale().getVisibleLogicalRange();
  const _barCount  = (_prevRange && _savedBarCount != null)
    ? _savedBarCount
    : 50;
  if (data.length > _barCount) {
    mainChart.timeScale().setVisibleLogicalRange({
      from: data.length - _barCount,
      to:   data.length - 1,
    });
  }
  _savedBarCount = null;   // 用完清除，讓使用者自由縮放

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
    if (d.kdj_cross === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.kdjCrossBull, shape:"arrowUp",   size:1.5, text:"金叉" });
    if (d.kdj_cross === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.kdjCrossBear, shape:"arrowDown", size:1.5, text:"死叉" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastKDJCrossMarkers = markers;
  _applyMainMarkers();
}

function renderResonance(data) {
  const markers = [];
  data.forEach(d => {
    if (d.resonance === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.resonanceBull, shape:"arrowUp",   size:1.5, text:"超賣" });
    if (d.resonance === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.resonanceBear, shape:"arrowDown", size:1.5, text:"超買" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastResonanceMarkers = markers;
  _applyMainMarkers();
}

function renderVolume(data) {
  const _va = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
  volSeries.setData(data.map(d => ({
    time:toTime(d.time), value:d.volume||0,
    color: d.close >= d.open ? C.volUp + _va : C.volDown + _va,
  })));
  // 每次重新套用 scale 設定，避免切換標的或市場後比例跑掉
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });
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
    kdjH20.setData([{time:f,value:S.kdjH20val},{time:l,value:S.kdjH20val}]);
    kdjH50.setData([{time:f,value:50},{time:l,value:50}]);
    kdjH80.setData([{time:f,value:S.kdjH80val},{time:l,value:S.kdjH80val}]);
  }
}

function renderRSI(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  rsiLine14.setData(line("rsi_14")); rsiLine7.setData(line("rsi_7"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    rsiH30.setData([{time:f,value:S.rsiH30val},{time:l,value:S.rsiH30val}]);
    rsiH50.setData([{time:f,value:50},{time:l,value:50}]);
    rsiH70.setData([{time:f,value:S.rsiH70val},{time:l,value:S.rsiH70val}]);
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
  if (market === "us") { dot.classList.add("hidden"); return; }
  dot.classList.remove("hidden");
  const interval = market === "tw" ? 5000 : 1000;
  realtimeTimer = setInterval(fetchLatest, interval);
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
    const dot = document.getElementById("realtimeDot");
    if (dot) dot.classList.toggle("hidden", json.live === false);
    const _tfSec = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"1h":3600,"15m":900,"5m":300 };
    json.data.forEach(bar => {
      const t     = toTime(bar.time);
      const last  = ohlcvData[ohlcvData.length - 1];
      const lastT = last ? toTime(last.time) : 0;
      // 歷史資料模式：若新 bar 與最後一根相差 > 5 根週期，不插入（避免 2024→2026 跳躍）
      if (t > lastT && (t - lastT) > (_tfSec[currentTF] || 86400) * 5) return;
      if (t === lastT) ohlcvData[ohlcvData.length - 1] = { ...last, ...bar };
      else if (t > lastT) ohlcvData.push(bar);
      else return;
      if (currentChartType === "candlestick" || currentChartType === "bar") {
        candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
      } else {
        candleSeries.update({ time:t, value:bar.close });
      }
      const _va2 = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
      volSeries.update({ time:t, value:bar.volume||0, color: bar.close>=bar.open ? C.volUp+_va2 : C.volDown+_va2 });
      updateLatestPriceLine(bar.close);
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
    _setLegText("legBB", `BB  U:${fmt(d.bb_upper)}  M:${fmt(d.bb_middle)}  L:${fmt(d.bb_lower)}`);

  // 成交量
  _setLegText("legVol",     `VOL  ${fmtVol(d.volume)}`);

  // KDJ
  _setLegText("legK",       `K ${n2(d.kdj_k)}`);
  _setLegText("legD",       `D ${n2(d.kdj_d)}`);
  _setLegText("legJ",       `J ${n2(d.kdj_j)}`);

  // RSI
  _setLegText("legRsi14",   `RSI 14  ${n2(d.rsi_14)}`);
  _setLegText("legRsi7",    `RSI 7  ${n2(d.rsi_7)}`);

  // MACD
  _setLegText("legMacd",    `MACD ${n2(d.macd)}`);
  _setLegText("legMacdSig", `Signal ${n2(d.macd_signal)}`);
  _setLegText("legMacdHist",`Hist ${n2(d.macd_hist)}`);
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
  if (bu != null) _setLegText("legBB", `BB  U:${fmt(bu)}  M:${fmt(bm)}  L:${fmt(bl)}`);
}
function onVolCrosshair(param) {
  const v = param.seriesData.get(volSeries)?.value;
  if (v != null) _setLegText("legVol", `VOL  ${fmtVol(v)}`);
}
function onKdjCrosshair(param) {
  const k = param.seriesData.get(kdjK)?.value;
  const d = param.seriesData.get(kdjD)?.value;
  const j = param.seriesData.get(kdjJ)?.value;
  if (k != null) {
    _setLegText("legK", `K ${n2(k)}`);
    _setLegText("legD", `D ${n2(d)}`);
    _setLegText("legJ", `J ${n2(j)}`);
  }
}
function onRsiCrosshair(param) {
  const r14 = param.seriesData.get(rsiLine14)?.value;
  const r7  = param.seriesData.get(rsiLine7)?.value;
  if (r14 != null) {
    _setLegText("legRsi14", `RSI 14  ${n2(r14)}`);
    _setLegText("legRsi7",  `RSI 7  ${n2(r7)}`);
  }
}
function onMacdCrosshair(param) {
  const m  = param.seriesData.get(macdLine)?.value;
  const sg = param.seriesData.get(macdSignal)?.value;
  const h  = param.seriesData.get(macdHist)?.value;
  if (m != null) {
    _setLegText("legMacd",    `MACD ${n2(m)}`);
    _setLegText("legMacdSig", `Signal ${n2(sg)}`);
    _setLegText("legMacdHist",`Hist ${n2(h)}`);
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
let replayData     = [];   // 完整資料快照
let replayIdx      = 0;    // 目前顯示到第幾根
let replaySpeed    = 500;  // ms per bar
let replayTimer    = null;
let replayActive   = false;
let _replaySpan    = 50;   // 進入重播時保存的可視 bar 數
let _replayLastIdx = -1;   // 上一幀渲染的 idx，用於增量更新判斷

function enterReplay() {
  if (replayActive) return;
  replayActive = true;
  stopRealtime();
  replayData = [...ohlcvData];

  // 記住使用者目前的縮放（可視 bar 數），重播期間維持此比例
  const curRange = mainChart.timeScale().getVisibleLogicalRange();
  _replaySpan = curRange ? Math.max(10, Math.round(curRange.to - curRange.from)) : 50;

  replayIdx = Math.max(_replaySpan, Math.floor(replayData.length * 0.2));
  _replayLastIdx = -1;

  const scrubber = document.getElementById("replayScrubber");
  scrubber.min   = 0;
  scrubber.max   = replayData.length - 1;
  scrubber.value = replayIdx;

  const _toYmd = bar => {
    const d = new Date(toTime(bar.time) * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`;
  };
  const picker = document.getElementById("replayDatePicker");
  picker.min = _toYmd(replayData[0]);
  picker.max = _toYmd(replayData[replayData.length - 1]);

  // 讓圖表區為重播列騰出空間
  document.getElementById("chartsContainer").style.paddingBottom = "42px";
  resizeAll();

  // 進入重播：禁止 series.update() 自動捲到最新 bar
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: false } })
  );

  document.getElementById("replayBar").classList.remove("hidden");
  document.getElementById("replayModeBtn").classList.add("active");
  _replayRender();
}

function exitReplay() {
  replayActive = false;
  replayTimer && clearInterval(replayTimer);
  replayTimer = null;

  document.getElementById("chartsContainer").style.paddingBottom = "";
  resizeAll();

  // 離開重播：恢復自動捲到最新 bar
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: true } })
  );

  document.getElementById("replayBar").classList.add("hidden");
  document.getElementById("replayModeBtn").classList.remove("active");
  document.getElementById("replayPlay").classList.remove("playing");
  document.getElementById("replayPlay").textContent = "▶";
  if (replayData.length) renderAll(replayData);
}

/* 重播：以台灣時間格式化 bar 的日期，並同步日期選擇器 */
function _replayRenderDate(bar) {
  if (!bar) return;
  const t = toTime(bar.time);
  const d = new Date(t * 1000);
  const pad = n => String(n).padStart(2, "0");
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  document.getElementById("replayDatePicker").value = ymd;
  const intraday = ["4h","1h","15m","5m"].includes(currentTF);
  document.getElementById("replayTime").textContent = intraday
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "";
}

/* 日期字串 "YYYY-MM-DD" → replayData 中第一個 >= 該日的索引 */
function _findIdxByDate(ymd) {
  for (let i = 0; i < replayData.length; i++) {
    const t = toTime(replayData[i].time);
    const d = new Date(t * 1000);
    const pad = n => String(n).padStart(2, "0");
    const barYmd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    if (barYmd >= ymd) return Math.max(i, _replaySpan);
  }
  return replayData.length - 1;
}

/* 重播：僅更新新增的一根 K 棒（增量 update，避免全量 setData 造成閃爍） */
function _replayStep(bar) {
  const t  = toTime(bar.time);
  const _va = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");

  if (currentChartType === "candlestick" || currentChartType === "bar")
    candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
  else
    candleSeries.update({ time:t, value:bar.close });

  if (bar.bb_upper != null) {
    bbU.update({ time:t, value:bar.bb_upper });
    bbM.update({ time:t, value:bar.bb_middle });
    bbL.update({ time:t, value:bar.bb_lower });
  }

  kdjAnchor.update({ time:t, value:50 });
  rsiAnchor.update({ time:t, value:50 });
  macdAnchor.update({ time:t, value:0 });

  volSeries.update({ time:t, value:bar.volume||0,
    color: bar.close >= bar.open ? C.volUp + _va : C.volDown + _va });
  const period = Math.max(1, S.volMaPeriod);
  if (replayIdx >= period - 1) {
    const s = Math.max(0, replayIdx - period + 1);
    const avg = replayData.slice(s, replayIdx + 1).reduce((a,d) => a + (d.volume||0), 0) / period;
    volMaSeries.update({ time:t, value:avg });
  }

  if (bar.kdj_k != null) {
    kdjK.update({ time:t, value:bar.kdj_k });
    kdjD.update({ time:t, value:bar.kdj_d });
    kdjJ.update({ time:t, value:bar.kdj_j });
  }
  if (bar.rsi_14 != null) rsiLine14.update({ time:t, value:bar.rsi_14 });
  if (bar.rsi_7  != null) rsiLine7.update({ time:t, value:bar.rsi_7 });
  if (bar.macd   != null) {
    macdLine.update({ time:t, value:bar.macd });
    macdSignal.update({ time:t, value:bar.macd_signal });
    macdHist.update({ time:t, value:bar.macd_hist,
      color: bar.macd_hist >= 0 ? C.up + "cc" : C.down + "cc" });
  }

  // 累積標記（增量加入，不重建）
  if (bar.crt === 1)  lastCRTMarkers.push({ time:t, position:"belowBar", color:C.crtBull, shape:"arrowUp",   size:1.5, text:"" });
  if (bar.crt === -1) lastCRTMarkers.push({ time:t, position:"aboveBar", color:C.crtBear, shape:"arrowDown", size:1.5, text:"" });
  if (bar.kdj_cross === 1)  lastKDJCrossMarkers.push({ time:t, position:"belowBar", color:C.kdjCrossBull, shape:"arrowUp",   size:1.5, text:"金叉" });
  if (bar.kdj_cross === -1) lastKDJCrossMarkers.push({ time:t, position:"aboveBar", color:C.kdjCrossBear, shape:"arrowDown", size:1.5, text:"死叉" });
  if (bar.resonance === 1)  lastResonanceMarkers.push({ time:t, position:"belowBar", color:C.resonanceBull, shape:"arrowUp",   size:1.5, text:"超賣" });
  if (bar.resonance === -1) lastResonanceMarkers.push({ time:t, position:"aboveBar", color:C.resonanceBear, shape:"arrowDown", size:1.5, text:"超買" });
  _applyMainMarkers();

  updateSymbolBar(replayData.slice(0, replayIdx + 1));
}

function _replayRender() {
  const slice = replayData.slice(0, replayIdx + 1);
  const n     = slice.length;
  const range = { from: n - _replaySpan - 1, to: n - 1 };

  _blockSync = true;

  if (_replayLastIdx >= 0 && replayIdx === _replayLastIdx + 1) {
    // 逐格前進：只更新新 bar，避免全量 setData 閃爍
    _replayStep(replayData[replayIdx]);
  } else {
    // 跳躍或倒退：全量重繪
    const anchorTimes = slice.map(d => ({ time:toTime(d.time), value:50 }));
    kdjAnchor.setData(anchorTimes);
    rsiAnchor.setData(anchorTimes);
    macdAnchor.setData(anchorTimes.map(d => ({ ...d, value:0 })));
    renderCandles(slice);
    renderBB(slice);
    renderCRT(slice);
    renderKDJCross(slice);
    renderResonance(slice);
    renderVolume(slice);
    renderKDJ(slice);
    renderRSI(slice);
    renderMACD(slice);
    updateSymbolBar(slice);
  }

  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c?.timeScale().setVisibleLogicalRange(range));
  _blockSync = false;
  _replayLastIdx = replayIdx;

  _replayRenderDate(replayData[replayIdx]);
  document.getElementById("replayProgress").textContent = `${n} / ${replayData.length}`;
  document.getElementById("replayScrubber").value = replayIdx;
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

  document.getElementById("replayScrubber").addEventListener("input", e => {
    if (replayTimer) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
    }
    replayIdx = parseInt(e.target.value);
    _replayRender();
  });

  document.getElementById("replayDatePicker").addEventListener("change", e => {
    if (!e.target.value || !replayData.length) return;
    if (replayTimer) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
    }
    replayIdx = _findIdxByDate(e.target.value);
    _replayLastIdx = -1;
    _replayRender();
  });

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
function syncSysSwatches() {
  document.querySelectorAll(".sys-color-swatch").forEach(sw => {
    sw.style.background = (SC[sw.dataset.sc] || "#888").slice(0, 7);
  });
}

function bindSystemColors() {
  syncSysSwatches();

  document.querySelectorAll(".sys-color-swatch").forEach(sw => {
    sw.addEventListener("click", e => {
      e.stopPropagation();
      const id  = sw.dataset.sc;
      const cur = (SC[id] || "#888").slice(0, 7);
      showLegColorPopup(e.clientX, e.clientY, [{
        label: null,
        currentColor: cur,
        apply: c => {
          SC[id] = c;
          sw.style.background = c;
          applySystemColor(id, c);
          saveSystemColors();
        }
      }]);
    });
  });

  document.getElementById("resetSysColors")?.addEventListener("click", () => {
    SC = { ...SC_DEFAULTS };
    syncSysSwatches();
    applyAllSystemColors();
    saveSystemColors();
  });
}

/* ══════════════════════════════════════════
   右側合約行情列表
══════════════════════════════════════════ */
let _tickerData     = [];
let _spotTickerData = [];
let _tickerSort     = "desc";   // desc=漲幅 asc=跌幅 vol=成交量
let _tickerTimer    = null;
let _lastTickerKey  = "";       // 追蹤目前渲染的 ticker 結構，避免不必要的 DOM 重建

/* 只更新價格文字，不重建 DOM */
function _updateTickerPrices() {
  const container = document.getElementById("tickerList");
  if (!container) return;
  container.querySelectorAll(".ticker-item[data-display]").forEach(el => {
    const t = _tickerData.find(x => x.display === el.dataset.display || x.symbol === el.dataset.display);
    if (!t) return;
    const chgEl   = el.querySelector(".tk-chg");
    const priceEl = el.querySelector(".tk-row2");
    if (chgEl) {
      chgEl.textContent = `${t.change_pct >= 0 ? "+" : ""}${t.change_pct.toFixed(2)}%`;
      chgEl.className   = `tk-chg ${t.change_pct >= 0 ? "up" : "dn"}`;
    }
    if (priceEl) priceEl.textContent = fmtTickerPrice(t.price);
  });
  updatePageTitle();
}

async function fetchTickers() {
  try {
    const [futRes, spotRes] = await Promise.all([
      fetch("/api/tickers?market=futures"),
      fetch("/api/tickers?market=spot"),
    ]);
    if (futRes.ok)  { const j = await futRes.json();  _tickerData     = j.tickers || []; }
    if (spotRes.ok) { const j = await spotRes.json(); _spotTickerData = j.tickers || []; }

    /* 計算目前應渲染的結構 key（排序 + 篩選 + 標的順序） */
    if (_tickerSort !== "wl") {
      const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
      let list = _tickerData.filter(t =>
        !search ||
        t.display.toLowerCase().includes(search) ||
        t.symbol.toLowerCase().includes(search) ||
        t.symbol.toLowerCase().replace("usdt","").includes(search)
      );
      if (_tickerSort === "asc")  list = [...list].reverse();
      if (_tickerSort === "vol")  list = [...list].sort((a, b) => b.volume - a.volume);
      const newKey = `${_tickerSort}|${search}|${list.map(t => t.display).join(",")}`;
      if (newKey === _lastTickerKey) {
        _updateTickerPrices();   // 結構不變→只刷新數字
      } else {
        renderTickers();
        _lastTickerKey = newKey;
      }
    } else {
      renderTickers();
    }

    _saveTickerCache();

    /* 搜尋 Modal 只在開啟時才更新 */
    if (!document.getElementById("symOverlay")?.classList.contains("hidden")) {
      renderSymSearch();
    }
  } catch {}
}

async function _refreshWlPrices() {
  const items = _watchlist.filter(w => w.market === "us" || w.market === "tw");
  await Promise.all(items.map(async item => {
    const key = `${item.market}:${item.exchange || ""}:${item.symbol}`;
    const cached = _wlPriceCache[key];
    if (cached && Date.now() - cached.ts < 60000) return;
    try {
      const res = await fetch("/api/latest", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ market: item.market, symbol: item.symbol, timeframe: "1d", exchange: item.exchange || "" }),
      });
      if (!res.ok) return;
      const data = (await res.json()).data || [];
      if (data.length >= 2) {
        const prev = data[data.length - 2], last = data[data.length - 1];
        const change_pct = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
        _wlPriceCache[key] = { price: last.close, change_pct, volume: last.volume, ts: Date.now() };
      }
    } catch {}
  }));
  if (_tickerSort === "wl") renderTickers();
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

/* ── ticker 輔助 ── */
const _LOGO_COLORS = ["#e8845a","#7b9ee8","#5bbf8a","#e87a7a","#b88ae8",
                      "#e8c45a","#5ab8e8","#e87ab8","#8ae8c4","#e8a45a",
                      "#7ae87a","#c45ae8","#e8d05a","#5a8ae8","#e85a5a"];
/* 手繪 blob 路徑（六種不規則圓形） */
const _LOGO_BLOBS = [
  "M50,13 C68,9 89,24 91,47 C93,69 78,90 56,92 C34,94 10,80 10,57 C10,34 24,15 46,13 Z",
  "M50,11 C74,9 93,29 92,53 C91,75 70,93 47,94 C24,95 7,75 8,51 C9,27 25,12 48,11 Z",
  "M48,14 C70,8 94,27 93,51 C92,73 72,93 49,94 C26,95 7,76 8,52 C9,30 22,16 46,14 Z",
  "M52,12 C77,10 94,33 91,57 C88,77 68,92 46,93 C24,94 7,73 9,49 C11,27 27,13 50,11 Z",
  "M50,10 C73,7 96,31 95,55 C94,77 73,96 49,95 C25,94 4,73 6,49 C8,27 25,11 48,10 Z",
  "M46,15 C66,9 91,25 92,49 C93,71 77,92 53,93 C31,94 8,78 9,54 C10,32 23,18 44,14 Z",
];
function _coinLogoHtml(display) {
  const base = (display.split("/")[0] || display).toUpperCase();
  const hash = base.split("").reduce((s,c) => s + c.charCodeAt(0), 0);
  const bg   = _LOGO_COLORS[hash % _LOGO_COLORS.length];
  const path = _LOGO_BLOBS[hash % _LOGO_BLOBS.length];
  const lbl  = base.length <= 3 ? base : base.slice(0,3);
  const rot  = (hash % 17) - 8;            /* −8 ~ +8 度歪斜 */
  const fs   = lbl.length > 2 ? 27 : 33;  /* 字體大小 */
  return `<div class="tk-logo" style="transform:rotate(${rot}deg)">
    <svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="${bg}" stroke="rgba(255,255,255,0.28)" stroke-width="3" stroke-linejoin="round"/>
      <text x="50" y="55" text-anchor="middle" dominant-baseline="middle"
            font-family="Caveat,cursive" font-size="${fs}" font-weight="700" fill="white"
            transform="rotate(${-rot},50,50)">${lbl}</text>
    </svg>
  </div>`;
}
function _coinFullName(display) {
  const d = display.toUpperCase();
  const isPerp = d.endsWith(".P");
  const parts  = d.replace(".P","").split("/");
  if (parts.length === 2)
    return isPerp ? `${parts[0]} ${parts[1]} PERPETUAL` : `${parts[0]} / ${parts[1]}`;
  return display;
}
function _fmtAmt(amt, price) {
  if (amt == null) return "";
  const abs = Math.abs(amt);
  if (price >= 1000) return amt.toFixed(1);
  if (price >= 10)   return amt.toFixed(2);
  if (price >= 1)    return amt.toFixed(3);
  return amt.toFixed(4);
}

function renderTickers() {
  const container = document.getElementById("tickerList");
  if (!container) return;

  const currentSym = document.getElementById("symbolInput")?.value.trim().toUpperCase();
  const exchVal    = document.getElementById("exchangeSelect")?.value || "pionex";

  // ── 自選標的 tab ──────────────────────────────────────
  if (_tickerSort === "wl") {
    if (!_watchlist.length) {
      container.innerHTML = '<div class="tk-loading">尚無自選，點 ☆ 加入</div>';
      return;
    }
    container.innerHTML = _watchlist.map((item, i) => {
      const mktLabel = item.market === "crypto" ? (item.exchange || "crypto").toUpperCase() : item.market.toUpperCase();
      const active   = item.symbol.toUpperCase() === currentSym ? " tk-active" : "";
      let price = null, change_pct = null;
      if (item.market === "crypto") {
        const td = _tickerData.find(t =>
          t.display?.toUpperCase() === item.symbol.toUpperCase() ||
          t.symbol?.toUpperCase() === item.symbol.toUpperCase());
        if (td) { price = td.price; change_pct = td.change_pct; }
      } else {
        const key = `${item.market}:${item.exchange || ""}:${item.symbol}`;
        const c = _wlPriceCache[key];
        if (c) { price = c.price; change_pct = c.change_pct; }
      }
      const priceStr = price != null ? fmtTickerPrice(price) : "---";
      const chgCls   = change_pct != null ? (change_pct >= 0 ? "up" : "dn") : "";
      const pctStr   = change_pct != null ? (change_pct >= 0 ? "+" : "") + change_pct.toFixed(2) + "%" : mktLabel;
      const amtStr   = change_pct != null && price != null
        ? (change_pct >= 0 ? "+" : "") + _fmtAmt(price * change_pct / 100 / (1 + change_pct / 100), price) : "";
      const logo     = _coinLogoHtml(item.symbol);
      const fullName = item.market === "crypto" ? _coinFullName(item.symbol) : item.market.toUpperCase();
      return `<div class="ticker-item${active}" data-wl-idx="${i}">
        ${logo}
        <div class="tk-info">
          <span class="tk-sym">${item.symbol}</span>
          <span class="tk-full">${fullName}</span>
        </div>
        <div class="tk-prices">
          <span class="tk-price-val">${priceStr}</span>
          <div class="tk-chg-row">
            <span class="tk-chg-amt ${chgCls}">${amtStr}</span>
            <span class="tk-chg ${chgCls}">${pctStr}</span>
          </div>
        </div>
        <div class="tk-action"><button class="wl-del" title="移除">🗑</button></div>
      </div>`;
    }).join("");
    container.querySelectorAll(".ticker-item").forEach((el, i) => {
      el.querySelector(".wl-del")?.addEventListener("click", e => {
        e.stopPropagation();
        _watchlist.splice(i, 1);
        _saveWatchlist();
        renderTickers();
      });
      el.addEventListener("click", e => {
        if (e.target.closest(".wl-del")) return;
        const item = _watchlist[i];
        if (!item) return;
        document.getElementById("symbolInput").value = item.symbol;
        document.getElementById("marketSelect").value = item.market;
        if (item.market === "crypto") document.getElementById("exchangeSelect").value = item.exchange || "pionex";
        updateMarketUI();
        loadData(false);
        container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
        el.classList.add("tk-active");
      });
    });
    return;
  }

  // ── 合約行情 tab ──────────────────────────────────────
  const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
  let list = _tickerData.filter(t =>
    !search ||
    t.display.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().replace("usdt","").includes(search)
  );
  if (_tickerSort === "asc") list = [...list].reverse();
  else if (_tickerSort === "vol") list = [...list].sort((a, b) => b.volume - a.volume);

  container.innerHTML = list.map(t => {
    const cls    = t.change_pct >= 0 ? "up" : "dn";
    const sign   = t.change_pct >= 0 ? "+" : "";
    const active = (t.display.toUpperCase() === currentSym || t.symbol.toUpperCase() === currentSym) ? " tk-active" : "";
    const key    = `crypto:${exchVal}:${t.display}`;
    const inWl   = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
    const logo   = _coinLogoHtml(t.display);
    const full   = _coinFullName(t.display);
    const amt    = t.change_amt != null ? t.change_amt : t.price * t.change_pct / 100 / (1 + t.change_pct / 100);
    const amtStr = sign + _fmtAmt(amt, t.price);
    return `<div class="ticker-item${active}" data-symbol="${t.symbol}" data-display="${t.display}" data-spot="${t.spot || t.display}">
      ${logo}
      <div class="tk-info">
        <span class="tk-sym">${t.display}</span>
        <span class="tk-full">${full}</span>
      </div>
      <div class="tk-prices">
        <span class="tk-price-val">${fmtTickerPrice(t.price)}</span>
        <div class="tk-chg-row">
          <span class="tk-chg-amt ${cls}">${amtStr}</span>
          <span class="tk-chg ${cls}">${sign}${t.change_pct.toFixed(2)}%</span>
        </div>
      </div>
      <div class="tk-action"><button class="tk-star${inWl ? " active" : ""}" title="${inWl ? "移除自選" : "加入自選"}">${inWl ? "★" : "☆"}</button></div>
    </div>`;
  }).join("");

  container.querySelectorAll(".ticker-item").forEach(el => {
    el.querySelector(".tk-star")?.addEventListener("click", e => {
      e.stopPropagation();
      _toggleWatchlist(el.dataset.display, "crypto", exchVal);
    });
    el.addEventListener("click", e => {
      if (e.target.closest(".tk-star")) return;
      document.getElementById("symbolInput").value = el.dataset.display;
      const exchEl = document.getElementById("exchangeSelect");
      if (exchEl && !["pionex","binance"].includes(exchEl.value)) exchEl.value = "pionex";
      loadData(false);
      container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
      el.classList.add("tk-active");
    });
  });
  updatePageTitle();
}

function fmtTickerPrice(p) {
  if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(5);
  return p.toFixed(6);
}

function _saveTickerCache() {
  try {
    localStorage.setItem("_tc", JSON.stringify({ f: _tickerData, s: _spotTickerData, ts: Date.now() }));
  } catch {}
}

function _loadTickerCache() {
  try {
    const c = JSON.parse(localStorage.getItem("_tc") || "null");
    if (c && Array.isArray(c.f) && c.f.length) {
      _tickerData     = c.f;
      _spotTickerData = c.s || [];
      renderTickers();   // 立即顯示上次快取
    }
  } catch {}
}

function startTickerRefresh() {
  if (_tickerTimer) clearInterval(_tickerTimer);
  _loadTickerCache();   // ← 先從 localStorage 即時渲染
  fetchTickers();       // ← 背景拉新資料
  _tickerTimer = setInterval(fetchTickers, 2000);
}

function bindTickerPanel() {
  document.querySelectorAll(".tk-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tk-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _tickerSort = btn.dataset.sort;
      _lastTickerKey = "";   // 強制完整重建
      renderTickers();
      if (btn.dataset.sort === "wl") _refreshWlPrices();
    });
  });
  document.getElementById("tickerSearch")?.addEventListener("input", () => {
    _lastTickerKey = "";   // 搜尋條件改變→強制完整重建
    renderTickers();
  });
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
  // 從 symbol 推算 base（BTC_USDT_PERP → BTC, BTC_USDT → BTC, BTCUSDT → BTC）
  const rawSym = t.symbol || "";
  const base   = rawSym.includes("_") ? rawSym.split("_")[0]
                 : rawSym.endsWith("USDT") ? rawSym.slice(0, -4) : rawSym;
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
    // 不立即清空，避免閃爍；只在第一次搜尋時顯示 loading
    if (!list.querySelector(".sym-result-item")) {
      list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    }
    const _thisQuery = query;
    fetch(`/api/us/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        // 若 query 已改變則丟棄舊結果
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 AAPL）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => `
          <div class="sym-result-item" data-symbol="${r.symbol}" data-display="${r.symbol}" tabindex="${i}">
            <div class="sym-icon" style="background:${symIconColor(r.symbol)}">
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

  // 台股：用後端 /api/search?market=tw 搜尋
  if (_symSearchMarket === "tw") {
    if (!query) {
      list.innerHTML = `<div class="sym-empty">輸入股票代號或名稱（如 2330、台積電）</div>`;
      return;
    }
    if (!list.querySelector(".sym-result-item")) {
      list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    }
    const _thisQuery = query;
    fetch(`/api/search?market=tw&keyword=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 2330）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => `
          <div class="sym-result-item" data-symbol="${r.stock_id || r.symbol || r}" data-display="${r.stock_id || r.symbol || r}" tabindex="${i}">
            <div class="sym-icon" style="background:${symIconColor(String(r.stock_id || r.symbol || r))}">${String(r.stock_id || r.symbol || r).slice(0,2)}</div>
            <div class="sym-result-info">
              <span class="sym-result-name">${r.stock_id || r.symbol || r}</span>
              <span class="sym-result-desc">${r.stock_name || r.name || ""}</span>
            </div>
            <span class="sym-result-tag">台股</span>
          </div>`).join("");
        _bindSymItems(list);
      })
      .catch(() => {
        list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 2330）</div>`;
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
  // 選擇後確保 market 與 tab 一致
  if (_symSearchMarket === "tw") {
    document.getElementById("marketSelect").value = "tw";
    updateMarketUI();
  } else if (_symSearchMarket === "us") {
    document.getElementById("marketSelect").value = "us";
    updateMarketUI();
  } else {
    // futures / spot → 確保切到 crypto market
    const mktEl = document.getElementById("marketSelect");
    if (mktEl.value !== "crypto") {
      mktEl.value = "crypto";
      updateMarketUI();  // 會先把 symbolInput 設為 "BTC/USDT"，下方再覆蓋為選到的標的
    }
  }
  // 加入搜尋歷史（台股/美股不記入 crypto 歷史）
  if (_symSearchMarket !== "tw") {
    addToSymHistory({
      symbol:     el.dataset.symbol,
      display:    display,
      spot:       el.dataset.spot || el.dataset.display,
      change_pct: parseFloat(el.dataset.change_pct) || 0,
      price:      parseFloat(el.dataset.price) || 0,
    });
  }
  document.getElementById("symbolInput").value = display;
  closeSymSearch();
  loadData(false);
  renderTickers();
}

function openSymSearch() {
  const market = document.getElementById("marketSelect").value;
  document.getElementById("symOverlay").classList.remove("hidden");
  const inp = document.getElementById("symModalInput");
  inp.value = "";
  document.getElementById("symModalClear").classList.add("hidden");
  _symSearchFocusIdx = -1;
  // 依市場決定預設 tab
  _symSearchMarket = market === "us" ? "us" : market === "tw" ? "tw" : "futures";
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
    if (_symSearchMarket === "us" || _symSearchMarket === "tw") {
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
    limit:     useLimit ? ({ "1M":120,"1w":520,"1d":1095,"4h":2190,"1h":2160,"15m":300,"5m":300 }[currentTF] ?? 300) : 0,
    timeframe: currentTF,
    exchange:  document.getElementById("exchangeSelect").value,
  };
}

/* 更新圖例文字，只改 .leg-val，dot 完全不碰 */
function _setLegText(id, text) {
  const val = document.querySelector(`#${id} .leg-val`);
  if (val) val.textContent = text;
}

function fmt(v)    { return v!=null ? Number(v).toLocaleString(undefined,{maximumFractionDigits:4}) : "—"; }
function n2(v)     { return v!=null ? Number(v).toFixed(2) : "—"; }
function _fmtPx(p) {
  if (!isFinite(p)) return "—";
  const a = Math.abs(p);
  if (a >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 100)   return p.toFixed(2);
  if (a >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}
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
      el.innerHTML = `<div class="loading-inner"><img src="/static/img/bear.png" class="loading-bear"/><span class="loading-text">處理中...</span></div>`;
      document.body.appendChild(el);
    }
  } else { el?.remove(); }
}

/* ── 點擊特效（依天氣型別：落葉 / 雨滴 / 雪花 / 花瓣 / 預設魔法粒子） ── */
(function initClickSparks() {
  let _lastClick = 0;

  /* ── 建立暫時 Canvas ── */
  function makeCanvas(cx, cy, size) {
    const cvs = document.createElement("canvas");
    cvs.width = size; cvs.height = size;
    cvs.style.cssText = `position:fixed;left:${cx-size/2}px;top:${cy-size/2}px;pointer-events:none;z-index:9999;`;
    document.body.appendChild(cvs);
    return cvs;
  }

  /* ── 落葉（邊緣橘棕發光） ── */
  function spawnLeaves(cx, cy) {
    const C = ["#8B4513","#CD853F","#D2691E","#A0522D","#6B8E23","#9ACD32","#DAA520","#FF8C00"];
    const SIZE = 240, N = 11;
    const cvs = makeCanvas(cx, cy, SIZE);
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd = 2+Math.random()*3.5;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-1.2,
               g:0.08+Math.random()*.05, rot:Math.random()*Math.PI*2,
               rs:(Math.random()-.5)*.15, sw:3+Math.random()*3, sh:1.5+Math.random()*2,
               col:C[Math.floor(Math.random()*C.length)], life:1 };
    });
    function draw(lf) {
      ctx.save(); ctx.globalAlpha=lf.life*.9; ctx.translate(lf.x,lf.y); ctx.rotate(lf.rot);
      ctx.shadowColor="rgba(255,160,50,0.9)"; ctx.shadowBlur=10;
      ctx.beginPath(); ctx.ellipse(0,0,lf.sw,lf.sh,0,0,Math.PI*2);
      ctx.fillStyle=lf.col; ctx.fill();
      ctx.shadowBlur=0;
      ctx.beginPath(); ctx.moveTo(-lf.sw,0); ctx.lineTo(lf.sw,0);
      ctx.strokeStyle="rgba(0,0,0,.18)"; ctx.lineWidth=.8; ctx.stroke();
      ctx.restore();
    }
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const lf of pts) {
        lf.x+=lf.vx; lf.y+=lf.vy; lf.vy+=lf.g; lf.vx*=.98; lf.rot+=lf.rs; lf.life-=.013;
        if(lf.life>0){alive=true;draw(lf);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs.remove();}
    } loop();
  }

  /* ── 雨滴（藍白發光線條） ── */
  function spawnRain(cx, cy) {
    const SIZE = 240, N = 16;
    const cvs = makeCanvas(cx, cy, SIZE);
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, (_,i) => {
      const a = (i/N)*Math.PI*2+(Math.random()-.5)*.5, spd=3+Math.random()*4;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd, g:.12, len:3+Math.random()*4, life:1 };
    });
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const d of pts) {
        d.x+=d.vx; d.y+=d.vy; d.vy+=d.g; d.vx*=.97; d.life-=.02;
        if(d.life>0){
          alive=true;
          const spd=Math.hypot(d.vx,d.vy)||1, nx=d.vx/spd, ny=d.vy/spd;
          ctx.save(); ctx.globalAlpha=d.life*.85;
          ctx.shadowColor="rgba(120,200,255,0.95)"; ctx.shadowBlur=8;
          ctx.strokeStyle="rgba(180,225,255,1)"; ctx.lineWidth=2; ctx.lineCap="round";
          ctx.beginPath();
          ctx.moveTo(d.x-nx*d.len*.5,d.y-ny*d.len*.5); ctx.lineTo(d.x+nx*d.len*.5,d.y+ny*d.len*.5);
          ctx.stroke(); ctx.restore();
        }
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs.remove();}
    } loop();
  }

  /* ── 雪花（冰藍發光晶體） ── */
  function spawnSnow(cx, cy) {
    const SIZE = 240, N = 9;
    const cvs = makeCanvas(cx, cy, SIZE);
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd=1.5+Math.random()*2.5;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-.5,
               g:.03, rot:Math.random()*Math.PI*2, rs:(Math.random()-.5)*.06,
               r:2.5+Math.random()*2.5, life:1 };
    });
    function drawFlake(f) {
      ctx.save(); ctx.globalAlpha=f.life*.9;
      ctx.shadowColor="rgba(180,225,255,1)"; ctx.shadowBlur=9;
      ctx.strokeStyle="rgba(220,242,255,1)"; ctx.lineWidth=Math.max(.8,f.r*.18); ctx.lineCap="round";
      ctx.translate(f.x,f.y); ctx.rotate(f.rot); ctx.beginPath();
      for(let i=0;i<6;i++){
        const a=(i/6)*Math.PI*2, ax=Math.cos(a)*f.r, ay=Math.sin(a)*f.r;
        ctx.moveTo(0,0); ctx.lineTo(ax,ay);
        [.45,.68].forEach(t=>{
          const bx=ax*t,by=ay*t,len=f.r*.3;
          [a+Math.PI/4,a-Math.PI/4].forEach(ba=>{
            ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ba)*len,by+Math.sin(ba)*len);
          });
        });
      }
      ctx.stroke(); ctx.restore();
    }
    let raf; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false;
      for (const f of pts) {
        f.x+=f.vx; f.y+=f.vy; f.vy+=f.g; f.vx*=.99; f.rot+=f.rs; f.life-=.014;
        if(f.life>0){alive=true;drawFlake(f);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs.remove();}
    } loop();
  }

  /* ── 花瓣（粉紅螢光邊緣） ── */
  function spawnPetals(cx, cy) {
    const C = ["#FFB7C5","#FF91A4","#FFD1DC","#FF69B4","#FFC0CB","#FFFFFF","#FFE4E1"];
    const SIZE = 240, N = 13;
    const cvs = makeCanvas(cx, cy, SIZE);
    const ctx = cvs.getContext("2d");
    const ox = SIZE/2, oy = SIZE/2;
    const pts = Array.from({length:N}, () => {
      const a = Math.random()*Math.PI*2, spd=1.8+Math.random()*3;
      return { x:ox, y:oy, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd-1,
               g:.06, rot:Math.random()*Math.PI*2, rs:(Math.random()-.5)*.12,
               w:2.5+Math.random()*2.5, h:2+Math.random()*2, seed:Math.random()*100,
               col:C[Math.floor(Math.random()*C.length)], life:1 };
    });
    function drawPetal(p) {
      ctx.save(); ctx.globalAlpha=p.life*.9;
      ctx.translate(p.x,p.y); ctx.rotate(p.rot);
      ctx.shadowColor="rgba(255,100,160,0.9)"; ctx.shadowBlur=11;
      ctx.beginPath();
      ctx.moveTo(0,p.h*.5);
      ctx.bezierCurveTo( p.w,-p.h*.2, p.w,-p.h*.8, 0,-p.h*.5);
      ctx.bezierCurveTo(-p.w,-p.h*.8,-p.w,-p.h*.2, 0, p.h*.5);
      ctx.fillStyle=p.col; ctx.fill();
      ctx.shadowBlur=0;
      ctx.strokeStyle="rgba(255,100,150,.3)"; ctx.lineWidth=.5; ctx.stroke();
      ctx.restore();
    }
    let raf, t=0; function loop() {
      ctx.clearRect(0,0,SIZE,SIZE); let alive=false; t++;
      for (const p of pts) {
        p.x+=p.vx; p.y+=p.vy; p.vy+=p.g;
        p.vx+=Math.sin(t*.04+p.seed)*.025;
        p.rot+=p.rs; p.life-=.013;
        if(p.life>0){alive=true;drawPetal(p);}
      }
      if(alive) raf=requestAnimationFrame(loop); else{cancelAnimationFrame(raf);cvs.remove();}
    } loop();
  }

  /* ── 預設魔法粒子（非天氣模式） ── */
  const DEF_COLORS = ["#4ECDC4","#8B5CF6","#FCD34D","#A78BFA","#67E8F9","#F472B6","#FBBF24","#34D399","#FB923C"];
  function spawnEl(cls, x, y, extra) {
    const el = document.createElement("div");
    el.className = cls;
    el.style.cssText = `left:${x}px;top:${y}px;${extra}`;
    document.body.appendChild(el);
    return el;
  }
  function spawnDefault(cx, cy) {
    const BIG=6;
    for(let i=0;i<BIG;i++){
      const a=(i/BIG)*Math.PI*2, dist=50+Math.random()*40;
      const w=8+Math.random()*8, h=w*(.35+Math.random()*.55);
      const col=DEF_COLORS[Math.floor(Math.random()*DEF_COLORS.length)];
      const el=spawnEl("spark-big",cx,cy,
        `width:${w}px;height:${h}px;background:${col};`+
        `--sx:${(Math.cos(a)*dist).toFixed(1)}px;--sy:${(Math.sin(a)*dist).toFixed(1)}px;`+
        `animation-delay:${i*20}ms;`);
      setTimeout(()=>el.remove(),1250);
    }
    const DUST=8;
    for(let i=0;i<DUST;i++){
      const a=Math.random()*Math.PI*2, dist=65+Math.random()*70;
      const sz=3+Math.random()*5, delay=40+Math.random()*100;
      const col=DEF_COLORS[Math.floor(Math.random()*DEF_COLORS.length)];
      const el=spawnEl("spark-dust",cx,cy,
        `width:${sz}px;height:${sz}px;background:${col};`+
        `--sx:${(Math.cos(a)*dist).toFixed(1)}px;--sy:${(Math.sin(a)*dist).toFixed(1)}px;`+
        `animation-delay:${delay.toFixed(0)}ms;`);
      setTimeout(()=>el.remove(),1500);
    }
  }

  document.addEventListener("click", e => {
    const now = Date.now();
    if (now - _lastClick < 50) return;
    _lastClick = now;
    const cx = e.clientX, cy = e.clientY;
    const wt = window._getWeatherType ? window._getWeatherType() : null;
    if      (wt === "leaves")              spawnLeaves(cx, cy);
    else if (wt === "rain" || wt === "storm") spawnRain(cx, cy);
    else if (wt === "snow")                spawnSnow(cx, cy);
    else if (wt === "spring")              spawnPetals(cx, cy);
    else                                   spawnDefault(cx, cy);
  });
})();

/* ── 右下角橘子熊偷看 ── */
(function initPeekBear() {
  const bear   = document.getElementById("peekBear");
  const bubble = document.getElementById("bearBubble");
  if (!bear) return;

  const LINES = [
    // ── 博恩風：先捧後逗，特定細節重框為荒謬 ──
    "我今天效率非常高。泡了咖啡、打開電腦、調整椅背、把手機翻面——然後就中午了。",
    "我有一個非常好的習慣，就是每天早上列待辦清單。清單第一條永遠是「列清單」。這樣我每天都有完成一件事。",
    "我買了一個很貴的筆記本，說這次要好好記錄想法。現在裡面寫了三行，前兩行在測試筆有沒有水。",
    "我失眠。我數羊。我數到一千。然後開始替每隻羊想名字。凌晨三點，第四百二十七隻羊叫做小明。",
    "我最有創意的時候，是任何一個手邊沒有紙的時候。",
    "手搖飲是個哲學問題。全糖代表你對人生妥協。微糖代表你還在抵抗。無糖代表你已放棄享受。我每次都點微糖，意思是我還沒決定好。",
    "我計畫了一個完整的旅遊行程。做了表格，分早中晚，備注每個景點的評分和距離。然後我說太麻煩了，不去了。那個表格現在還在，非常完整。",
    "我的飲食計畫是：週一到週五說要健康。週六說今天是例外。週日說明天開始。週一說上週已經很健康了，要犒賞自己。這個循環我跑了兩年，非常穩定。",
    "颱風假是台灣人最重視的假日，因為它是突然的。計畫中的假你覺得該做點什麼。颱風假你可以正大光明什麼都不做，因為是天氣叫你這樣的。",
    "台灣便利商店真的很神奇。你可以在裡面繳費、吃飯、印東西、寄包裹。我唯一搞不清楚的是，我每次進去買一個東西，出來都是三個。這不是我的問題。這是架子設計的問題。",
    "我說今天要做一件非常重要的事。後來我想不起來是什麼事。那件事就消失了。它可能比我還先想開了。",
    "我研究了一個小時要訂哪間餐廳，查評論、看照片、問朋友。最後說那算了，吃便利商店好了。那一個小時，我用來決定放棄決定。",
    "我有個習慣，把東西放在「等一下會用到的地方」。然後我找不到它。那個地方非常合理，但我不記得我的邏輯了。",
    "我說要練一個技能，每天十分鐘。第一天做了。第二天做了。第三天忘了。第四天說那就從第一天重新算。現在已經是第一天的第十七次了。",
    "超商店員問我要不要加購飲料。我說不用。她說現在兩個有優惠。我說好。我到現在還不清楚我在那一刻做了什麼決定。",
    "台灣人買東西一定要問「可以便宜一點嗎」，對方說不行，我們說好謝謝，然後買了。這句話的作用，是讓自己覺得有努力過。",
    "我說要學吉他。我買了吉他。吉他放在房間角落。我每天都看到它。我覺得這算是一種陪伴。",
    // ── Jim 風：冷面邏輯推到底，反勵志 ──
    "大家都說要早睡早起。對，就是那種你設了鬧鐘之前叫做早起的那種。",
    "我每天告訴自己今天是新的開始。今天是我兩年來第七百三十個新的開始。我很一致。",
    "有人說失敗是成功之母。我失敗了很多次。我媽說那不叫成功之母，那叫習慣。",
    "大家說要對自己好一點。我很努力。我每週至少一次告訴自己今天不要太努力了。我做到了。",
    "我說要少看手機，下載了一個記錄使用時間的app。那個app通知我說我今天看了五個小時。我點開通知，又多看了十分鐘。我不覺得這是矛盾。",
    "人家說要走出舒適圈。我走出去了。外面沒有比較好。我回來了。",
    "我有個夢想，就是有一天可以睡到自然醒。自然醒的意思是，不是鬧鐘把我叫起來，是餓把我叫起來。",
    "我朋友說他在減脂，不吃澱粉。然後說薯條是配件，不算食物。這個邏輯在他自己的體系裡非常自洽。我沒有反駁。",
    // ── 對話型（博恩觀察→揭露荒謬 ／ Jim 冷面推到底）──
    "「你今天做了什麼？」\n「思考了一些問題。」\n「什麼問題？」\n「為什麼會累但睡不著。」\n「有答案嗎？」\n「我想到凌晨兩點，沒有。」",
    "「你有在準備嗎？」\n「有。」\n「準備什麼？」\n「準備開始準備。」",
    "「你說要早點睡。」\n「我睡了。」\n「幾點？」\n「比前天早。」\n「前天幾點？」\n「三點。」\n「所以昨天幾點睡？」\n「……兩點五十八。」",
    "「你說要省錢。」\n「我有省。」\n「省了多少？」\n「我本來要買兩個，只買了一個。」\n「這叫省錢？」\n「這叫自制力。」",
    "「你去看醫生了嗎？」\n「沒有。」\n「為什麼不去？」\n「很麻煩。」\n「你說痛了好幾天了。」\n「但掛號也很麻煩。」\n「……」\n「我覺得它會自己好。」",
    "「你在哪？快到了嗎？」\n「快了。」\n「你還在家吧。」\n「……我在出門的路上。」\n「你還沒穿鞋吧。」\n「……我找不到另一隻。」",
    "「你說不買了。」\n「這個不一樣。」\n「哪裡不一樣？」\n「功能不一樣。」\n「什麼功能？」\n「……顏色也不一樣。」",
    "「你有沒有回那個人的訊息？」\n「有。」\n「有嗎？」\n「……我有看。」\n「看了沒回也算？」\n「我在想怎麼回。」\n「想多久了？」\n「四天。」\n「他已經收回了。」",
    "「你最近在忙什麼？」\n「很多事。」\n「什麼事？」\n「生活上的事。」\n「具體一點。」\n「……活著。」",
    "「你說要戒手搖。」\n「對。」\n「那你手上拿的是什麼？」\n「這是最後一杯。」\n「你上週也這樣說。」\n「上週的最後一杯已經結束了。這是新的最後一杯。」",
    "「你在減肥嗎？」\n「對。」\n「那你吃什麼？」\n「沙拉。」\n「那旁邊是什麼？」\n「獎勵。」\n「你才吃了一口。」\n「我很努力。」",
    "「你說這週要存錢。」\n「對。」\n「你剛剛在買什麼？」\n「這個是投資。」\n「買衣服算投資？」\n「投資自己。形象就是生產力。」",
    "「你說要早起晨跑。」\n「對。」\n「你跑了嗎？」\n「我有起來。」\n「然後？」\n「我評估了一下氣候，覺得今天不適合。」\n「晴天。」\n「太曬了。」",
    "「你在幹嘛？」\n「沒什麼。」\n「你在滑什麼？」\n「沒什麼。」\n「看了多久了？」\n「不知道。」\n「兩個小時了。」\n「……沒有那麼久。」\n「你的app說兩小時十三分。」\n「那個app不準。」",
    "「你說今年要做一件大事。」\n「對。」\n「做了嗎？」\n「還在評估。」\n「評估了多久了？」\n「……從年初。」\n「現在十一月了。」\n「所以我很謹慎。」",
  ];
  /* Fisher-Yates shuffle, reshuffles when exhausted */
  let _shuffled = [], _shufflePos = 0;
  function _nextLine() {
    if (_shufflePos >= _shuffled.length) {
      _shuffled = [...LINES];
      for (let i = _shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [_shuffled[i], _shuffled[j]] = [_shuffled[j], _shuffled[i]];
      }
      _shufflePos = 0;
    }
    return _shuffled[_shufflePos++];
  }

  let _bubbleTimer = null;

  function showBubble() {
    if (!bubble) return;
    bubble.textContent = _nextLine();
    bubble.classList.add("visible");
    clearTimeout(_bubbleTimer);
    _bubbleTimer = setTimeout(() => bubble.classList.remove("visible"), 3500);
  }

  setTimeout(() => { bear.classList.add("peeking"); }, 2800);

  bear.addEventListener("click", e => {
    e.stopPropagation();
    bear.classList.remove("wave");
    void bear.offsetWidth;
    bear.classList.add("wave");
    showBubble();
  });

  /* 定時隨機冒出全身並說話 */
  function scheduleVisit() {
    const wait = 35000 + Math.random() * 40000; // 35~75 秒後出現
    setTimeout(() => {
      if (!bear.classList.contains("peeking")) { scheduleVisit(); return; }
      bear.classList.add("peek-visit");
      showBubble();
      const stay = 2800 + Math.random() * 2200; // 停留 2.8~5 秒
      setTimeout(() => {
        bear.classList.remove("peek-visit");
        scheduleVisit();
      }, stay);
    }, wait);
  }
  scheduleVisit();
})();

/* ── 合約行情鍵盤快捷鍵（↓/↑ 切換標的） ── */
(function initTickerKeyNav() {
  document.addEventListener("keydown", e => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (document.activeElement?.isContentEditable) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== " ") return;

    const container = document.getElementById("tickerList");
    if (!container) return;
    const items = [...container.querySelectorAll(".ticker-item")];
    if (!items.length) return;

    e.preventDefault();

    /* 空白鍵：直接跳到列表第一個標的 */
    if (e.key === " ") {
      const first = items[0];
      items.forEach(x => x.classList.remove("tk-active"));
      first.classList.add("tk-active");
      first.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (first.dataset.display) {
        document.getElementById("symbolInput").value = first.dataset.display;
        const exchEl = document.getElementById("exchangeSelect");
        if (exchEl && !["pionex", "binance"].includes(exchEl.value)) exchEl.value = "pionex";
        loadData(false);
      } else if (first.dataset.wlIdx !== undefined) {
        first.click();
      }
      return;
    }

    const activeIdx = items.findIndex(el => el.classList.contains("tk-active"));
    const nextIdx = e.key === "ArrowDown"
      ? (activeIdx < 0 ? 0 : (activeIdx + 1) % items.length)
      : (activeIdx <= 0 ? items.length - 1 : activeIdx - 1);
    const next = items[nextIdx];

    items.forEach(x => x.classList.remove("tk-active"));
    next.classList.add("tk-active");
    next.scrollIntoView({ block: "nearest", behavior: "smooth" });

    /* 載入標的 */
    if (next.dataset.display) {
      document.getElementById("symbolInput").value = next.dataset.display;
      const exchEl = document.getElementById("exchangeSelect");
      if (exchEl && !["pionex", "binance"].includes(exchEl.value)) exchEl.value = "pionex";
      loadData(false);
    } else if (next.dataset.wlIdx !== undefined) {
      next.click();
    }
  });
})();

/* ══════════════════════════════════════════
   按鈕漣漪效果
══════════════════════════════════════════ */
(function initButtonRipple() {
  const TARGETS = "button,.tf-btn,.ct-btn,.rp-btn,.dt-btn,.music-theme-btn,.tk-seg-btn,.sym-tab";
  document.addEventListener("pointerdown", e => {
    const btn = e.target.closest(TARGETS);
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const x    = e.clientX - rect.left  - size / 2;
    const y    = e.clientY - rect.top   - size / 2;
    const wave = document.createElement("span");
    wave.className = "btn-ripple-wave";
    wave.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    btn.appendChild(wave);
    wave.addEventListener("animationend", () => wave.remove(), { once: true });
  });
})();

/* ══════════════════════════════════════════
   音效引擎 (Web Audio API)
══════════════════════════════════════════ */
const SFX = (() => {
  let _ctx = null, _master = null;

  function _getCtx() {
    if (!_ctx) {
      _ctx    = new (window.AudioContext || window.webkitAudioContext)();
      _master = _ctx.createGain();
      _master.gain.value = 0.22;
      _master.connect(_ctx.destination);
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  function _tone(freq, type, vol, dur, delay = 0, detune = 0) {
    const ctx  = _getCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(_master);
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value    = detune;
    const t = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  return {
    /* 按鈕輕點 */
    click()   { _tone(1100, "sine",   0.18, 0.055); },
    /* 載入資料 */
    load()    {
      [523.3, 659.3, 784.0].forEach((f, i) => _tone(f, "sine", 0.14, 0.14, i * 0.09));
    },
    /* 載入成功 */
    success() {
      [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => _tone(f, "sine", 0.13, 0.18, i * 0.07));
    },
    /* 載入失敗 */
    error()   {
      [400, 320, 240].forEach((f, i) => _tone(f, "square", 0.1, 0.12, i * 0.10));
    },
    /* 重播步進 tick */
    tick()    { _tone(880,  "sine",   0.10, 0.04); },
    /* 橘子熊波動音 */
    boop()    { _tone(660,  "sine",   0.15, 0.08); _tone(880, "sine", 0.10, 0.06, 0.06); },
    /* 切換音效 */
    switch_()  { _tone(740,  "triangle", 0.12, 0.08); },
  };
})();

/* 把音效掛上常用按鈕 */
(function wireSFX() {
  /* 載入按鈕 */
  ["loadBtn", "loadBtnMob"].forEach(id => {
    document.getElementById(id)?.addEventListener("click", () => SFX.load(), { capture: true });
  });
  /* TF / 圖表類型 切換 */
  document.querySelectorAll(".tf-btn, .ct-btn").forEach(b =>
    b.addEventListener("click", () => SFX.switch_(), { capture: true })
  );
  /* 重播控制欄 step tick */
  ["replayStepB","replayStepF"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", () => SFX.tick(), { capture: true })
  );
  /* 橘子熊點擊音 */
  document.getElementById("peekBear")?.addEventListener("click", () => SFX.boop(), { capture: true });

  /* 攔截 loadData 完成後的音效（monkey-patch fetch） */
  const _origFetch = window.fetch;
  let _loadPending = false;
  document.getElementById("loadBtn")?.addEventListener("click", () => { _loadPending = true; });
  document.getElementById("loadBtnMob")?.addEventListener("click", () => { _loadPending = true; });
  window.fetch = async function(...args) {
    const res = await _origFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    if (_loadPending && url.includes("/api/ohlcv")) {
      _loadPending = false;
      if (res.ok) setTimeout(() => SFX.success(), 180);
      else        setTimeout(() => SFX.error(),   180);
    }
    return res;
  };
})();

/* ══════════════════════════════════════════
   背景音樂播放器
══════════════════════════════════════════ */
(function initMusicPlayer() {
  let _ctx = null, _masterGain = null, _musicGain = null;
  let _schedulerTimer = null, _autoTimer = null;
  let _nextNoteTime  = 0;
  let _step          = 0;
  let _activeTheme   = "off";
  let _autoActual    = "lofi";

  /* ── 音符頻率 ── */
  const N = {
    A2:110.0, Bb2:116.5, B2:123.5,
    C3:130.8, D3:146.8, Eb3:155.6, E3:164.8, F3:174.6, G3:196.0, Ab3:207.7, Bb3:233.1,
    B3:246.9, A3:220.0,
    C4:261.6, D4:293.7, Eb4:311.1, E4:329.6, F4:349.2, G4:392.0, Ab4:415.3,
    A4:440.0, Bb4:466.2, B4:493.9,
    C5:523.3, D5:587.3, E5:659.3, F5:698.5, G5:784.0, A5:880.0,
  };

  /* ── 主題定義 ──
     每個 step: { n:[freqs], b:beats, v:vol }  n=[] → 休止符 */
  const THEMES = {
    lofi: {
      bpm: 72, wave: "sine", fType: "lowpass", fFreq: 760, fQ: 0.8,
      steps: [
        // ── Cm  ──
        {n:[N.C3,N.Eb4,N.G4],  b:1,   v:0.055},
        {n:[N.Bb4],             b:0.5, v:0.028},
        {n:[N.G4],              b:0.5, v:0.025},
        {n:[N.C3,N.Eb4],        b:1,   v:0.04 },
        // ── Bb  ──
        {n:[N.Bb3,N.F4,N.Bb4], b:1,   v:0.052},
        {n:[N.G4],              b:0.5, v:0.026},
        {n:[N.F4],              b:0.5, v:0.024},
        {n:[N.Bb3,N.Eb4],       b:1,   v:0.038},
        // ── Ab  ──
        {n:[N.Ab3,N.C4,N.Eb4], b:1,   v:0.05 },
        {n:[N.G4],              b:0.5, v:0.028},
        {n:[N.Bb4],             b:0.5, v:0.025},
        {n:[N.Ab3,N.C4],        b:1,   v:0.04 },
        // ── G dominant  ──
        {n:[N.G3,N.G4,N.Bb4],  b:1,   v:0.052},
        {n:[N.G4],              b:0.5, v:0.026},
        {n:[N.Eb4],             b:0.5, v:0.024},
        {n:[N.G3,N.D4],         b:1,   v:0.038},
      ],
    },
    bull: {
      bpm: 128, wave: "triangle", fType: "highpass", fFreq: 220, fQ: 0.7,
      steps: [
        {n:[N.C4],       b:0.5, v:0.075},
        {n:[N.E4],       b:0.5, v:0.075},
        {n:[N.G4],       b:0.5, v:0.075},
        {n:[N.C5],       b:0.5, v:0.08 },
        {n:[N.G4],       b:0.5, v:0.07 },
        {n:[N.E4],       b:0.5, v:0.065},
        {n:[N.G4],       b:0.5, v:0.07 },
        {n:[N.C5,N.E5],  b:1.0, v:0.085},
        {n:[N.A4],       b:0.5, v:0.07 },
        {n:[N.C5],       b:0.5, v:0.075},
        {n:[N.E5],       b:0.5, v:0.08 },
        {n:[N.G5],       b:0.5, v:0.085},
        {n:[N.E5],       b:0.5, v:0.075},
        {n:[N.C5],       b:0.5, v:0.07 },
        {n:[N.G4],       b:0.5, v:0.065},
        {n:[N.C5,N.E5],  b:1.0, v:0.085},
      ],
    },
    bear: {
      bpm: 58, wave: "sine", fType: "lowpass", fFreq: 520, fQ: 1.2,
      steps: [
        {n:[N.D4,N.F4],  b:2,   v:0.06 },
        {n:[],           b:1,   v:0    },
        {n:[N.C4],       b:1,   v:0.05 },
        {n:[N.D3,N.A4],  b:2,   v:0.055},
        {n:[],           b:2,   v:0    },
        {n:[N.Bb3,N.F4], b:2,   v:0.055},
        {n:[N.Eb4],      b:1,   v:0.045},
        {n:[],           b:1,   v:0    },
        {n:[N.D4,N.Ab4], b:1.5, v:0.05 },
        {n:[N.C4],       b:1.5, v:0.045},
        {n:[],           b:1,   v:0    },
      ],
    },
    scalp: {
      bpm: 162, wave: "square", fType: "bandpass", fFreq: 900, fQ: 2.5,
      steps: [
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[N.C5],  b:0.25, v:0.065},
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.G4],  b:0.25, v:0.05 },
        {n:[N.A4],  b:0.25, v:0.06 },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[N.E5],  b:0.5,  v:0.07 },
        {n:[N.D5],  b:0.25, v:0.06 },
        {n:[N.C5],  b:0.25, v:0.055},
        {n:[N.A4],  b:0.25, v:0.055},
        {n:[],      b:0.25, v:0    },
      ],
    },
    ghibli: {
      /* 宮崎風鋼琴：F大調，64 BPM，三角波模擬鋼琴音色 */
      bpm: 64, wave: "triangle", fType: "lowpass", fFreq: 2400, fQ: 0.5,
      steps: [
        // ── Bar 1：F major ──
        {n:[N.F3, N.C5, N.F5],       b:1,   v:0.065},
        {n:[N.C4, N.E5],              b:1,   v:0.052},
        {n:[N.A3, N.D5],              b:1,   v:0.050},
        {n:[N.F3, N.C5],              b:1,   v:0.048},
        // ── Bar 2：Dm ──
        {n:[N.D3, N.D5],              b:1,   v:0.062},
        {n:[N.A2, N.C5],              b:1,   v:0.050},
        {n:[N.F3, N.A4],              b:1,   v:0.048},
        {n:[N.D3, N.F4],              b:1.5, v:0.050},
        {n:[N.A4],                    b:0.5, v:0.036},
        // ── Bar 3：Bb ──
        {n:[N.Bb2, N.D5],             b:1.5, v:0.062},
        {n:[N.C5],                    b:0.5, v:0.050},
        {n:[N.Bb3, N.Bb4],            b:1,   v:0.050},
        {n:[N.G3, N.A4],              b:1,   v:0.044},
        // ── Bar 4：C dominant ──
        {n:[N.C3, N.E3, N.C5],        b:1,   v:0.065},
        {n:[N.G3, N.G4],              b:1,   v:0.050},
        {n:[N.E3, N.A4],              b:1,   v:0.050},
        {n:[N.C3, N.E4, N.G4],        b:1,   v:0.055},
        // ── Bar 5：F resolve ──
        {n:[N.F3, N.F4, N.A4, N.C5], b:2.5, v:0.060},
        {n:[N.D5],                    b:0.5, v:0.048},
        {n:[N.C5],                    b:0.5, v:0.044},
        {n:[N.A4],                    b:0.5, v:0.040},
      ],
    },
    merry: {
      /* 人生のメリーゴーランド — Howl's Moving Castle, waltz 3/4, C major */
      bpm: 100, wave: "triangle", fType: "lowpass", fFreq: 2200, fQ: 0.5,
      steps: [
        {n:[N.C3,N.E4],         b:1,   v:0.068},
        {n:[N.G3,N.D4],         b:1,   v:0.050},
        {n:[N.G3,N.C4],         b:1,   v:0.045},
        {n:[N.G3,N.B3],         b:1,   v:0.065},
        {n:[N.D3,N.A3],         b:1,   v:0.048},
        {n:[N.D3,N.B3],         b:1,   v:0.045},
        {n:[N.C3,N.C4],         b:1,   v:0.068},
        {n:[N.G3,N.E4],         b:1,   v:0.055},
        {n:[N.G3,N.D4],         b:1,   v:0.050},
        {n:[N.C3,N.G4],         b:1,   v:0.072},
        {n:[N.F3,N.F4],         b:1,   v:0.060},
        {n:[N.F3,N.E4],         b:1,   v:0.055},
        {n:[N.G3,N.D4],         b:1,   v:0.060},
        {n:[N.G3,N.E4],         b:0.5, v:0.050},
        {n:[N.G3,N.D4],         b:0.5, v:0.048},
        {n:[N.G3,N.B3],         b:1,   v:0.055},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
        {n:[N.C3,N.C4],         b:1,   v:0.058},
      ],
    },
    inochi: {
      /* いのちの名前 — Spirited Away, Am→F→C→G, gentle 4/4 */
      bpm: 58, wave: "sine", fType: "lowpass", fFreq: 1800, fQ: 0.5,
      steps: [
        {n:[N.A3,N.A4],         b:1.5, v:0.058},
        {n:[N.A3,N.C5],         b:1,   v:0.052},
        {n:[N.A3,N.B4],         b:1.5, v:0.048},
        {n:[N.F3,N.A4],         b:1.5, v:0.055},
        {n:[N.F3,N.G4],         b:1,   v:0.048},
        {n:[N.F3,N.F4],         b:1.5, v:0.044},
        {n:[N.C3,N.G4],         b:1,   v:0.052},
        {n:[N.C3,N.A4],         b:1,   v:0.055},
        {n:[N.G3,N.C5],         b:1.5, v:0.062},
        {n:[N.G3,N.B4],         b:1,   v:0.052},
        {n:[N.G3,N.A4],         b:1,   v:0.048},
        {n:[N.G3,N.G4],         b:1,   v:0.044},
        {n:[N.A3,N.A4],         b:2,   v:0.058},
        {n:[N.F3,N.C5],         b:1.5, v:0.062},
        {n:[N.C3,N.B4],         b:1,   v:0.052},
        {n:[N.C3,N.G4],         b:1.5, v:0.045},
        {n:[N.A3,N.A4,N.C5],    b:2,   v:0.062},
      ],
    },
    totoro: {
      /* となりのトトロ — My Neighbor Totoro, C major, cheerful */
      bpm: 88, wave: "triangle", fType: "lowpass", fFreq: 2600, fQ: 0.4,
      steps: [
        {n:[N.C3,N.E4],         b:0.5, v:0.065},
        {n:[N.C3,N.E4],         b:0.5, v:0.060},
        {n:[N.C3,N.F4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.072},
        {n:[N.G3,N.G4],         b:0.5, v:0.068},
        {n:[N.G3,N.F4],         b:0.5, v:0.062},
        {n:[N.G3,N.E4],         b:0.5, v:0.058},
        {n:[N.G3,N.D4],         b:0.5, v:0.055},
        {n:[N.C3,N.C4],         b:1.5, v:0.065},
        {n:[N.C3,N.D4],         b:0.5, v:0.055},
        {n:[N.F3,N.E4],         b:1.5, v:0.062},
        {n:[N.F3,N.D4],         b:0.5, v:0.050},
        {n:[N.G3,N.G4],         b:0.5, v:0.068},
        {n:[N.G3,N.A4],         b:0.5, v:0.072},
        {n:[N.G3,N.Bb4],        b:1,   v:0.068},
        {n:[N.C3,N.G4],         b:1,   v:0.060},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
      ],
    },
    mononoke: {
      /* もののけ姫 — Princess Mononoke, Dm, epic & solemn */
      bpm: 78, wave: "sine", fType: "lowpass", fFreq: 1600, fQ: 0.8,
      steps: [
        {n:[N.D3,N.D4],         b:0.5, v:0.060},
        {n:[N.D3,N.F4],         b:0.5, v:0.065},
        {n:[N.D3,N.A4],         b:0.5, v:0.068},
        {n:[N.D3,N.D5],         b:1,   v:0.075},
        {n:[N.Bb2,N.C5],        b:0.5, v:0.065},
        {n:[N.Bb2,N.A4],        b:0.5, v:0.060},
        {n:[N.Bb2,N.G4],        b:0.5, v:0.055},
        {n:[N.Bb2,N.F4],        b:0.5, v:0.050},
        {n:[N.A2,N.E4],         b:0.5, v:0.052},
        {n:[N.A2,N.G4],         b:0.5, v:0.055},
        {n:[N.A2,N.A4],         b:1,   v:0.058},
        {n:[N.F3,N.F4],         b:2,   v:0.065},
        {n:[N.D3,N.D4],         b:0.5, v:0.058},
        {n:[N.D3,N.F4],         b:0.5, v:0.062},
        {n:[N.D3,N.G4],         b:0.5, v:0.062},
        {n:[N.D3,N.Bb4],        b:0.5, v:0.065},
        {n:[N.C3,N.A4],         b:0.5, v:0.060},
        {n:[N.C3,N.G4],         b:0.5, v:0.055},
        {n:[N.C3,N.F4],         b:0.5, v:0.050},
        {n:[N.C3,N.E4],         b:0.5, v:0.048},
        {n:[N.D3,N.A3,N.D4],    b:2,   v:0.068},
      ],
    },
    sanpo: {
      /* さんぽ — My Neighbor Totoro, C major march, upbeat */
      bpm: 132, wave: "triangle", fType: "highpass", fFreq: 200, fQ: 0.5,
      steps: [
        {n:[N.C3,N.G4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.062},
        {n:[N.C3,N.A4],         b:0.5, v:0.070},
        {n:[N.C3,N.G4],         b:0.5, v:0.065},
        {n:[N.F3,N.F4],         b:0.5, v:0.060},
        {n:[N.F3,N.E4],         b:0.5, v:0.058},
        {n:[N.G3,N.D4],         b:0.5, v:0.055},
        {n:[N.C3,N.C4],         b:1,   v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.068},
        {n:[N.C3,N.G4],         b:0.5, v:0.062},
        {n:[N.C3,N.A4],         b:0.5, v:0.070},
        {n:[N.C3,N.G4],         b:0.5, v:0.065},
        {n:[N.Bb2,N.Bb4],       b:0.5, v:0.072},
        {n:[N.Bb2,N.A4],        b:1.5, v:0.068},
        {n:[N.C3,N.C5],         b:0.5, v:0.075},
        {n:[N.C3,N.C5],         b:0.5, v:0.072},
        {n:[N.C3,N.D5],         b:0.5, v:0.075},
        {n:[N.C3,N.C5],         b:0.5, v:0.072},
        {n:[N.Bb2,N.Bb4],       b:0.5, v:0.068},
        {n:[N.F3,N.A4],         b:0.5, v:0.062},
        {n:[N.G3,N.G4],         b:0.5, v:0.060},
        {n:[N.F3,N.F4],         b:0.5, v:0.055},
        {n:[N.C3,N.E4,N.G4],    b:2,   v:0.072},
      ],
    },
  };

  function _getCtx() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
      _masterGain = _ctx.createGain(); _masterGain.gain.value = 1;
      _masterGain.connect(_ctx.destination);
      _musicGain  = _ctx.createGain(); _musicGain.gain.value = 0.25;
      _musicGain.connect(_masterGain);
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  function _playNote(freq, startT, dur, vol, wave, fType, fFreq, fQ) {
    const ctx  = _getCtx();
    const osc  = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type         = wave;
    osc.frequency.value = freq;
    filt.type        = fType;
    filt.frequency.value = fFreq;
    filt.Q.value     = fQ;
    osc.connect(filt); filt.connect(gain); gain.connect(_musicGain);
    gain.gain.setValueAtTime(0, startT);
    gain.gain.linearRampToValueAtTime(vol, startT + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, startT + dur * 0.88);
    osc.start(startT);
    osc.stop(startT + dur + 0.01);
  }

  function _scheduleChunk(themeKey) {
    const theme = THEMES[themeKey];
    if (!theme) return;
    const ctx       = _getCtx();
    const beatSec   = 60 / theme.bpm;
    const LOOK_AHEAD = 2.2;
    if (_nextNoteTime < ctx.currentTime) _nextNoteTime = ctx.currentTime;

    while (_nextNoteTime < ctx.currentTime + LOOK_AHEAD) {
      const step    = theme.steps[_step % theme.steps.length];
      const stepDur = step.b * beatSec;
      if (step.n.length > 0 && step.v > 0) {
        step.n.forEach(f =>
          _playNote(f, _nextNoteTime, stepDur * 0.82, step.v,
                    theme.wave, theme.fType, theme.fFreq, theme.fQ)
        );
      }
      _nextNoteTime += stepDur;
      _step++;
    }
  }

  function _reset() { _nextNoteTime = 0; _step = 0; }

  function _stopAll() {
    clearInterval(_schedulerTimer); _schedulerTimer = null;
    clearInterval(_autoTimer);      _autoTimer      = null;
    const ytF = document.getElementById("ytFrame");
    if (ytF) ytF.innerHTML = "";   // 停止 YouTube 播放
  }

  function _startTheme(key) {
    _stopAll(); _reset();
    _activeTheme = key;
    if (key === "off") return;

    const actual = key === "auto" ? _autoActual : key;
    _scheduleChunk(actual);
    _schedulerTimer = setInterval(() => {
      const run = _activeTheme === "auto" ? _autoActual : _activeTheme;
      _scheduleChunk(run);
    }, 500);

    if (key === "auto") {
      _autoTimer = setInterval(_updateAutoTheme, 5000);
    }
  }

  function _updateAutoTheme() {
    const chgEl   = document.getElementById("symChg");
    const txt     = chgEl?.textContent || "";
    const m       = txt.match(/([-+]?\d+\.?\d*)/);
    const chg     = m ? parseFloat(m[1]) : 0;
    let next;
    if      (chg >=  3.5) next = "bull";
    else if (chg <= -3.5) next = "bear";
    else if (Math.abs(chg) >= 1.5) next = "scalp";
    else                  next = "lofi";
    if (next !== _autoActual) {
      _autoActual = next; _reset();
    }
  }

  /* ── 音量控制 ── */
  function _setVol(v) {
    if (_musicGain) _musicGain.gain.value = v * 0.5;
  }

  /* ── 建立面板邏輯 ── */
  const panel     = document.getElementById("musicPanel");
  const toggleBtn = document.getElementById("musicToggleBtn");
  const volSlider = document.getElementById("musicVol");
  const volLabel  = document.getElementById("musicVolLabel");

  if (!panel || !toggleBtn) return;

  toggleBtn.addEventListener("click", e => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
  });
  document.addEventListener("click", e => {
    if (!panel.contains(e.target) && e.target !== toggleBtn)
      panel.classList.add("hidden");
  });

  panel.querySelectorAll(".music-theme-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".music-theme-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const key = btn.dataset.theme;
      _startTheme(key);
      /* 按鈕 icon 狀態 */
      toggleBtn.classList.toggle("playing", key !== "off");
    });
  });

  volSlider?.addEventListener("input", () => {
    const pct = parseInt(volSlider.value, 10);
    _setVol(pct / 100);
    if (volLabel) volLabel.textContent = pct + "%";
  });

  /* ── YouTube 播放器 ── */
  const ytInput = document.getElementById("ytUrlInput");
  const ytBtn   = document.getElementById("ytPlayBtn");
  const ytFrame = document.getElementById("ytFrame");

  function _parseYT(url) {
    const vM = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    const sM = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    const lM = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
    return { vid: (vM || sM)?.[1], lid: lM?.[1] };
  }

  ytBtn?.addEventListener("click", () => {
    const { vid, lid } = _parseYT(ytInput?.value?.trim() || "");
    if (!vid && !lid) { ytInput?.focus(); return; }

    /* 停合成音樂 */
    _stopAll();
    _activeTheme = "yt";
    panel.querySelectorAll(".music-theme-btn").forEach(b => b.classList.remove("active"));
    toggleBtn.classList.add("playing");

    /* 建立 iframe src（只允許 youtube.com embed，防 XSS） */
    let src;
    if (lid && vid) src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?list=${encodeURIComponent(lid)}&autoplay=1&loop=1`;
    else if (lid)   src = `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(lid)}&autoplay=1&loop=1`;
    else            src = `https://www.youtube.com/embed/${encodeURIComponent(vid)}?autoplay=1&loop=1`;

    if (ytFrame) {
      const iframe = document.createElement("iframe");
      iframe.width  = "100%";
      iframe.height = "112";
      iframe.src    = src;
      iframe.setAttribute("frameborder", "0");
      iframe.setAttribute("allow", "autoplay; encrypted-media");
      iframe.setAttribute("allowfullscreen", "");
      ytFrame.innerHTML = "";
      ytFrame.appendChild(iframe);
    }
  });

  /* Enter 鍵也可觸發播放 */
  ytInput?.addEventListener("keydown", e => { if (e.key === "Enter") ytBtn?.click(); });
})();

/* ── 天氣背景動畫（華麗版）── */
(function initWeatherBg() {
  const canvas = document.getElementById("weatherBg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, type = "sunny", rafId = null;

  /* shared state */
  let sunAngle = 0, moonGlow = 0;
  let flashAlpha = 0, lightningTimer = 80, lightningPath = [];
  let shootTimer = 200, shootX = 0, shootY = 0, shootDX = 0, shootDY = 0, shootLen = 0;
  let stars = [], sparks = [], rainP = [], ripples = [], snowP = [], cloudP = [], leafP = [], petalP = [];
  let _autoType = "sunny";

  function wmoType(c, d) {
    if (c === 0) return d ? "sunny" : "night";
    if (c <= 3)  return "cloudy";
    if (c <= 48) return "fog";
    if (c <= 67 || (c >= 80 && c <= 82)) return "rain";
    if (c <= 77 || c === 85 || c === 86) return "snow";
    return "storm";
  }

  function resize() {
    W = canvas.width  = window.innerWidth  || 1200;
    H = canvas.height = window.innerHeight || 700;
    _init();
  }

  function _newSpark() {
    const a = Math.random()*Math.PI*2, d = 28 + Math.random()*Math.min(W,H)*.32;
    return { x: W*.85+Math.cos(a)*d, y: H*.08+Math.sin(a)*d, r: .8+Math.random()*2.2, life: 0, maxLife: 50+Math.random()*80 };
  }

  function _init() {
    stars  = Array.from({length:200}, () => ({ x:Math.random()*W, y:Math.random()*H*.88, r:.3+Math.random()*1.8, ph:Math.random()*Math.PI*2, sp:.8+Math.random()*1.5 }));
    sparks = Array.from({length:22}, _newSpark);
    rainP  = [
      ...Array.from({length:130}, () => ({ x:Math.random()*W, y:Math.random()*H, spd:3+Math.random()*2.5, len:6+Math.random()*8,  a:.09+Math.random()*.13 })),
      ...Array.from({length:80},  () => ({ x:Math.random()*W, y:Math.random()*H, spd:9+Math.random()*6,   len:14+Math.random()*16, a:.34+Math.random()*.44 })),
    ];
    ripples = [];
    snowP  = Array.from({length:55}, () => ({ x:Math.random()*W, y:Math.random()*H, r:2+Math.random()*5, spd:.4+Math.random()*1.2, drift:(Math.random()-.5)*.6, rot:Math.random()*Math.PI/3, rotSpd:(Math.random()-.5)*.022, a:.5+Math.random()*.5 }));
    cloudP = Array.from({length:8}, (_, i) => ({ x:Math.random()*W, y:H*(.05+i*.11), sc:.12+Math.random()*.14, al:.20+Math.random()*.16, sp:.04+Math.random()*.12 }));
    leafP  = Array.from({length:65}, () => { const lf=_newLeaf(); lf.y=Math.random()*H; return lf; });
    petalP = Array.from({length:55}, () => { const p=_newPetal(); p.y=Math.random()*H; return p; });
    shootTimer = 200+Math.floor(Math.random()*250);
  }

  /* ── smooth bezier cloud ── */
  function _cloud(cx, cy, w, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    const h = w * 0.44;
    /* organic silhouette traced with bezier curves */
    ctx.beginPath();
    ctx.moveTo(cx - w*.40, cy + h*.55);
    ctx.bezierCurveTo(cx - w*.40, cy + h*.92, cx + w*.40, cy + h*.92, cx + w*.40, cy + h*.55); /* flat bottom */
    ctx.bezierCurveTo(cx + w*.60, cy + h*.55, cx + w*.62, cy + h*.06, cx + w*.36, cy - h*.04); /* right up */
    ctx.bezierCurveTo(cx + w*.30, cy - h*.52, cx + w*.08, cy - h*.56, cx + w*.04, cy - h*.08); /* top-right puff */
    ctx.bezierCurveTo(cx + w*.06, cy - h*.90, cx - w*.20, cy - h*.94, cx - w*.16, cy - h*.08); /* tallest center puff */
    ctx.bezierCurveTo(cx - w*.20, cy - h*.58, cx - w*.50, cy - h*.50, cx - w*.44, cy - h*.04); /* top-left puff */
    ctx.bezierCurveTo(cx - w*.62, cy + h*.06, cx - w*.60, cy + h*.55, cx - w*.40, cy + h*.55); /* left down */
    ctx.closePath();
    /* volumetric gradient: bright white top → blue-grey bottom */
    const g = ctx.createRadialGradient(cx - w*.07, cy - h*.18, 0, cx, cy + h*.30, w*.72);
    g.addColorStop(0.00, "rgba(250,253,255,.96)");
    g.addColorStop(0.38, "rgba(232,243,252,.92)");
    g.addColorStop(0.75, "rgba(200,222,242,.82)");
    g.addColorStop(1.00, "rgba(168,198,226,.60)");
    ctx.fillStyle = g; ctx.fill();
    /* subtle bright edge highlight */
    ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }

  /* ── 6-arm snowflake crystal (optimised: single path per flake, no shadowBlur) ── */
  function _snowflake(x, y, r, angle, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(210,232,255,1)";
    ctx.lineWidth = Math.max(.5, r*.2); ctx.lineCap = "round";
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a=(i/6)*Math.PI*2, ax=Math.cos(a)*r, ay=Math.sin(a)*r;
      ctx.moveTo(0,0); ctx.lineTo(ax,ay);
      [.45,.68].forEach(t => {
        const bx=ax*t, by=ay*t, len=r*.3;
        [a+Math.PI/4, a-Math.PI/4].forEach(ba => {
          ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ba)*len, by+Math.sin(ba)*len);
        });
      });
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ── recursive midpoint-displacement lightning ── */
  function _bolt(x1,y1,x2,y2,d) {
    if (d === 0) return [[x2,y2]];
    const mx=(x1+x2)/2+(Math.random()-.5)*55*(d/5), my=(y1+y2)/2;
    return [..._bolt(x1,y1,mx,my,d-1), ..._bolt(mx,my,x2,y2,d-1)];
  }

  /* ═══════════════ per-weather draw ═══════════════ */

  function dSunny(t) {
    const sx=W*.85, sy=H*.08;
    sunAngle += .0035;
    /* background warm glow */
    const bg=ctx.createRadialGradient(sx,sy,0,sx,sy,W*.85);
    bg.addColorStop(0,"rgba(255,240,110,.38)"); bg.addColorStop(.45,"rgba(255,165,30,.11)"); bg.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    /* 16 rotating rays */
    ctx.save(); ctx.translate(sx,sy);
    for (let i=0;i<16;i++) {
      const a=sunAngle+(i/16)*Math.PI*2, even=i%2===0;
      const len=W*(.32+.06*Math.sin(t*.7+i));
      const gr=ctx.createLinearGradient(0,0,Math.cos(a)*len,Math.sin(a)*len);
      gr.addColorStop(0,`rgba(255,230,80,${even?.19:.10})`); gr.addColorStop(1,"rgba(255,180,20,0)");
      ctx.strokeStyle=gr; ctx.lineWidth=even?2.5:1.2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a)*30,Math.sin(a)*30); ctx.lineTo(Math.cos(a)*len,Math.sin(a)*len); ctx.stroke();
    }
    ctx.restore();
    /* pulsing halo rings */
    [55,85,120].forEach((r,i) => {
      ctx.strokeStyle=`rgba(255,220,80,${.22-i*.06})`; ctx.lineWidth=2;
      ctx.shadowBlur=14; ctx.shadowColor="rgba(255,200,0,.7)";
      ctx.beginPath(); ctx.arc(sx,sy,r+Math.sin(t*1.1+i)*7,0,Math.PI*2); ctx.stroke();
    });
    /* sun disc */
    ctx.shadowBlur=42; ctx.shadowColor="rgba(255,200,0,1)";
    const sg=ctx.createRadialGradient(sx,sy,0,sx,sy,28);
    sg.addColorStop(0,"#FFFCD0"); sg.addColorStop(1,"#FFD700");
    ctx.fillStyle=sg; ctx.beginPath(); ctx.arc(sx,sy,28,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
    /* sparkles */
    sparks.forEach((p,i) => {
      p.life++;
      if (p.life>p.maxLife) { sparks[i]=_newSpark(); return; }
      const a=Math.sin((p.life/p.maxLife)*Math.PI)*.88;
      if (a>.5) { ctx.shadowBlur=7; ctx.shadowColor="rgba(255,220,0,.9)"; }
      ctx.fillStyle=`rgba(255,242,120,${a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    });
  }

  function dNight(t) {
    moonGlow = Math.sin(t*.5)*.12+.5;
    /* nebula blobs */
    [[.38,.28,.55,"rgba(75,25,115,.09)"],[.72,.55,.45,"rgba(18,52,118,.07)"]].forEach(([cx,cy,rr,c]) => {
      const g=ctx.createRadialGradient(W*cx,H*cy,0,W*cx,H*cy,W*rr);
      g.addColorStop(0,c); g.addColorStop(1,"rgba(0,0,0,0)");
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    });
    /* twinkling stars */
    stars.forEach(p => {
      const a=.15+.75*Math.sin(t*p.sp+p.ph);
      if (a>.72) { ctx.shadowBlur=7; ctx.shadowColor="rgba(200,220,255,.9)"; }
      ctx.fillStyle=`rgba(222,232,255,${a})`;
      ctx.beginPath(); ctx.arc(p.x,p.y,a>.6?p.r*1.3:p.r,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
    });
    /* shooting star */
    shootTimer--;
    if (shootTimer<=0) {
      shootTimer=160+Math.floor(Math.random()*280);
      shootX=Math.random()*W*.75; shootY=Math.random()*H*.35;
      const ang=Math.PI/5+(Math.random()-.5)*.4;
      shootDX=Math.cos(ang)*13; shootDY=Math.sin(ang)*13; shootLen=90+Math.random()*120;
    }
    if (shootLen>0) {
      const tl=ctx.createLinearGradient(shootX,shootY,shootX-shootDX*7,shootY-shootDY*7);
      tl.addColorStop(0,"rgba(255,255,255,.93)"); tl.addColorStop(1,"rgba(255,255,255,0)");
      ctx.strokeStyle=tl; ctx.lineWidth=1.8; ctx.shadowBlur=10; ctx.shadowColor="white";
      ctx.beginPath(); ctx.moveTo(shootX,shootY); ctx.lineTo(shootX-shootDX*6,shootY-shootDY*6); ctx.stroke();
      ctx.shadowBlur=0;
      shootX+=shootDX; shootY+=shootDY; shootLen-=Math.hypot(shootDX,shootDY);
    }
    /* moon with crescent shadow */
    ctx.shadowBlur=34; ctx.shadowColor=`rgba(200,232,255,${moonGlow*.72})`;
    ctx.fillStyle="#EAF5FF"; ctx.beginPath(); ctx.arc(W*.82,H*.09,23,0,Math.PI*2); ctx.fill();
    ctx.fillStyle="rgba(10,12,24,1)"; ctx.beginPath(); ctx.arc(W*.82+9,H*.09-4,20,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur=0;
  }

  function dCloudy(t) {
    cloudP.forEach((c, i) => {
      c.x += c.sp;
      if (c.x - W*c.sc > W) c.x = -W*c.sc*1.5;
      _cloud(c.x, c.y + Math.sin(t*.18 + i*1.3)*3.5, W*c.sc, c.al);
    });
  }

  function dFog(t) {
    for (let i=0;i<8;i++) {
      const y=H*(.10+i*.12)+Math.sin(t*(.2+i*.04)+i)*H*.04;
      const dn=.05+(i===3||i===4?.04:0);
      const gr=ctx.createLinearGradient(0,y-65,0,y+65);
      gr.addColorStop(0,"rgba(180,200,228,0)"); gr.addColorStop(.5,`rgba(180,200,228,${dn})`); gr.addColorStop(1,"rgba(180,200,228,0)");
      ctx.fillStyle=gr; ctx.fillRect(0,y-65,W,130);
    }
    const vg=ctx.createRadialGradient(W/2,H/2,H*.22,W/2,H/2,W*.8);
    vg.addColorStop(0,"rgba(0,0,0,0)"); vg.addColorStop(1,"rgba(150,175,205,.08)");
    ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
  }

  function dRain() {
    /* stormy sky overlay */
    const sky=ctx.createLinearGradient(0,0,0,H);
    sky.addColorStop(0,"rgba(28,42,66,.26)"); sky.addColorStop(1,"rgba(8,18,38,.06)");
    ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);

    ctx.lineCap="round";
    const near=p=>p.a>0.3;
    rainP.forEach(p => {
      const n=near(p);
      ctx.strokeStyle=n?`rgba(185,225,255,${p.a})`:`rgba(130,175,225,${p.a})`;
      ctx.lineWidth=n?1.1:.55;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-p.len*.13,p.y+p.len); ctx.stroke();
      p.y+=p.spd; p.x-=p.spd*.13;
      if (p.y>H+p.len) {
        if (n && ripples.length<45)
          ripples.push({x:p.x, y:H*.968, r:0, maxR:7+Math.random()*13, a:.42});
        p.y=-p.len; p.x=Math.random()*(W+60)-30;
      }
    });

    /* puddle ripple rings */
    for (let i=ripples.length-1;i>=0;i--) {
      const rp=ripples[i];
      ctx.strokeStyle=`rgba(165,215,255,${rp.a})`; ctx.lineWidth=.8;
      ctx.beginPath(); ctx.ellipse(rp.x,rp.y,rp.r,rp.r*.28,0,0,Math.PI*2); ctx.stroke();
      rp.r+=.85; rp.a-=.026;
      if (rp.a<=0) ripples.splice(i,1);
    }

    /* wet ground sheen */
    const gnd=ctx.createLinearGradient(0,H*.88,0,H);
    gnd.addColorStop(0,"rgba(100,160,220,0)"); gnd.addColorStop(1,"rgba(80,130,200,.09)");
    ctx.fillStyle=gnd; ctx.fillRect(0,H*.88,W,H*.12);

    /* bottom mist */
    const mist=ctx.createLinearGradient(0,H*.62,0,H);
    mist.addColorStop(0,"rgba(140,195,245,0)");
    mist.addColorStop(.55,"rgba(140,195,245,.035)");
    mist.addColorStop(1,"rgba(140,195,245,.10)");
    ctx.fillStyle=mist; ctx.fillRect(0,H*.62,W,H*.38);
  }

  function dSnow(t) {
    snowP.forEach(p => {
      _snowflake(p.x,p.y,p.r,p.rot,p.a);
      p.y+=p.spd; p.x+=p.drift+Math.sin(t*.5+p.x*.01)*.3; p.rot+=p.rotSpd;
      if (p.y>H+p.r*2) { p.y=-p.r*2; p.x=Math.random()*W; }
      if (p.x<-10) p.x=W+10; if (p.x>W+10) p.x=-10;
    });
    const sa=ctx.createLinearGradient(0,0,0,H*.35);
    sa.addColorStop(0,"rgba(200,218,240,.07)"); sa.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle=sa; ctx.fillRect(0,0,W,H*.35);
  }

  function dStorm() {
    /* heavy angled rain */
    rainP.forEach(p => {
      ctx.strokeStyle=`rgba(130,180,255,${p.a*.75})`; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x-5,p.y+p.len*1.3); ctx.stroke();
      p.y+=p.spd*1.6; p.x-=2.2;
      if (p.y>H+p.len) { p.y=-p.len; p.x=Math.random()*W; }
    });
    /* lightning */
    lightningTimer--;
    if (lightningTimer<=0) {
      lightningTimer=45+Math.floor(Math.random()*90);
      flashAlpha=.24;
      const lx=W*.1+Math.random()*W*.8;
      lightningPath=[[lx,0], ..._bolt(lx,0,lx+(Math.random()-.5)*W*.35,H*.82,5)];
    }
    if (lightningPath.length>1) {
      ctx.shadowBlur=24; ctx.shadowColor="rgba(255,255,200,1)";
      ctx.strokeStyle="rgba(255,255,235,.95)"; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(lightningPath[0][0],lightningPath[0][1]);
      lightningPath.slice(1).forEach(([x,y]) => ctx.lineTo(x,y)); ctx.stroke();
      /* inner bright core */
      ctx.strokeStyle="rgba(255,255,255,.7)"; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.moveTo(lightningPath[0][0],lightningPath[0][1]);
      lightningPath.slice(1).forEach(([x,y]) => ctx.lineTo(x,y)); ctx.stroke();
      ctx.shadowBlur=0;
    }
    if (flashAlpha>0) {
      ctx.fillStyle=`rgba(210,225,255,${flashAlpha})`; ctx.fillRect(0,0,W,H);
      flashAlpha=Math.max(0,flashAlpha-.024);
      if (flashAlpha<=0) lightningPath=[];
    }
    /* dark storm vignette */
    const vg=ctx.createRadialGradient(W/2,H/2,H*.15,W/2,H/2,W*.88);
    vg.addColorStop(0,"rgba(0,0,0,0)"); vg.addColorStop(1,"rgba(12,12,32,.20)");
    ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
  }

  /* ── falling leaves ── */
  const LCOLS = ["#C0392B","#E74C3C","#E67E22","#D35400","#F39C12","#D4AC0D","#8B4513","#A04000","#CB4335","#922B21"];
  function _newLeaf() {
    return { x:(Math.random()-.05)*(W+80)-40, y:-20-Math.random()*100,
             vx:(Math.random()-.5)*1.0, vy:.5+Math.random()*1.4,
             rot:Math.random()*Math.PI*2, rotV:(Math.random()-.5)*.04,
             swing:Math.random()*Math.PI*2, swingSpd:.016+Math.random()*.022,
             swingAmp:.8+Math.random()*2.2, sz:7+Math.random()*13,
             col:LCOLS[Math.floor(Math.random()*LCOLS.length)],
             a:.6+Math.random()*.4, shadow:Math.random()>.5 };
  }
  function _drawLeaf(lf) {
    const {x,y,rot,sz,col,a,shadow}=lf;
    ctx.save(); ctx.globalAlpha=a; ctx.translate(x,y); ctx.rotate(rot);
    if (shadow) { ctx.shadowBlur=7; ctx.shadowColor="rgba(0,0,0,.18)"; }
    /* leaf body */
    ctx.fillStyle=col;
    ctx.beginPath();
    ctx.moveTo(0,-sz);
    ctx.bezierCurveTo( sz*.72,-sz*.5,  sz*.68, sz*.5,  0, sz);
    ctx.bezierCurveTo(-sz*.68, sz*.5, -sz*.72,-sz*.5,  0,-sz);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur=0;
    /* specular highlight */
    const hl=ctx.createRadialGradient(-sz*.22,-sz*.32,0,0,0,sz*.9);
    hl.addColorStop(0,"rgba(255,255,255,.17)"); hl.addColorStop(1,"rgba(255,255,255,0)");
    ctx.fillStyle=hl;
    ctx.beginPath();
    ctx.moveTo(0,-sz);
    ctx.bezierCurveTo( sz*.72,-sz*.5,  sz*.68, sz*.5,  0, sz);
    ctx.bezierCurveTo(-sz*.68, sz*.5, -sz*.72,-sz*.5,  0,-sz);
    ctx.closePath(); ctx.fill();
    /* midrib */
    ctx.strokeStyle="rgba(0,0,0,.20)"; ctx.lineWidth=Math.max(.5,sz*.08); ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(0,-sz*.88); ctx.quadraticCurveTo(sz*.07,0,0,sz*.9); ctx.stroke();
    /* side veins (3 pairs) */
    ctx.lineWidth=Math.max(.3,sz*.032); ctx.strokeStyle="rgba(0,0,0,.12)";
    [[-0.45,.44],[-0.05,.38],[0.32,.30]].forEach(([ty,sp]) => {
      const by=ty*sz;
      for (const s of [1,-1]) {
        ctx.beginPath(); ctx.moveTo(0,by);
        ctx.quadraticCurveTo(s*sz*sp*.6,by-sz*.07,s*sz*sp,by-sz*.14); ctx.stroke();
      }
    });
    /* stem */
    ctx.strokeStyle="rgba(80,40,10,.7)"; ctx.lineWidth=Math.max(.5,sz*.065);
    ctx.beginPath(); ctx.moveTo(0,sz*.88); ctx.quadraticCurveTo(sz*.04,sz*1.05,0,sz*1.18); ctx.stroke();
    ctx.restore();
  }
  function dLeaves(t) {
    /* warm autumn ambient */
    const amb=ctx.createRadialGradient(W*.82,0,0,W*.82,0,H*.78);
    amb.addColorStop(0,"rgba(255,148,28,.09)"); amb.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle=amb; ctx.fillRect(0,0,W,H);
    const gnd=ctx.createLinearGradient(0,H*.82,0,H);
    gnd.addColorStop(0,"rgba(0,0,0,0)"); gnd.addColorStop(1,"rgba(55,28,8,.06)");
    ctx.fillStyle=gnd; ctx.fillRect(0,H*.82,W,H*.18);
    /* wind: multiple sine waves for gust feel */
    const wind=Math.sin(t*.28)*1.5+Math.sin(t*.73)*.7+Math.sin(t*1.6)*.22;
    leafP.forEach((lf,i) => {
      lf.swing+=lf.swingSpd;
      lf.x+=lf.vx+Math.sin(lf.swing)*lf.swingAmp+wind*.35;
      lf.y+=lf.vy+Math.sin(lf.swing*.5)*.14;
      lf.rot+=lf.rotV+Math.cos(lf.swing*.9)*.008;
      if (lf.y>H*.85) { lf.vy=Math.max(0,lf.vy-.04); lf.a=Math.max(0,lf.a-.008); }
      if (lf.y>H+30||lf.x<-90||lf.x>W+90||lf.a<=0) leafP[i]=_newLeaf();
      else _drawLeaf(lf);
    });
  }

  /* ── spring cherry blossom ── */
  function _newPetal() {
    return { x:(Math.random()-.05)*(W+80)-40, y:-10-Math.random()*60,
             vx:(Math.random()-.5)*.7, vy:.35+Math.random()*.9,
             rot:Math.random()*Math.PI*2, rotV:(Math.random()-.5)*.03,
             swing:Math.random()*Math.PI*2, swingSpd:.013+Math.random()*.018,
             swingAmp:.7+Math.random()*2.0, sz:4+Math.random()*7,
             a:.55+Math.random()*.45 };
  }
  function _petal(x, y, sz, rot, alpha) {
    ctx.save(); ctx.globalAlpha=alpha; ctx.translate(x,y); ctx.rotate(rot);
    /* sakura petal: heart-notched wide end, tapered bottom tip */
    ctx.beginPath();
    ctx.moveTo(0, sz*.80);
    ctx.bezierCurveTo(-sz*.60, sz*.30, -sz*.70,-sz*.40, -sz*.30,-sz*.60);
    ctx.bezierCurveTo(-sz*.12,-sz*.92,  0,-sz*.76,  0,-sz*.56);
    ctx.bezierCurveTo(  0,-sz*.76,  sz*.12,-sz*.92, sz*.30,-sz*.60);
    ctx.bezierCurveTo( sz*.70,-sz*.40,  sz*.60, sz*.30,  0, sz*.80);
    ctx.closePath();
    const g=ctx.createRadialGradient(0,-sz*.10,0, 0,sz*.30,sz);
    g.addColorStop(0.00,"rgba(255,240,250,.95)");
    g.addColorStop(0.45,"rgba(255,198,220,.90)");
    g.addColorStop(1.00,"rgba(255,158,192,.66)");
    ctx.fillStyle=g; ctx.fill();
    ctx.strokeStyle="rgba(255,130,170,.20)"; ctx.lineWidth=.5;
    ctx.beginPath(); ctx.moveTo(0,sz*.72); ctx.quadraticCurveTo(sz*.04,-sz*.05,0,-sz*.52); ctx.stroke();
    ctx.restore();
  }
  function dSpring(t) {
    const sky=ctx.createLinearGradient(0,0,0,H*.7);
    sky.addColorStop(0,"rgba(255,210,232,.07)"); sky.addColorStop(1,"rgba(255,240,248,.02)");
    ctx.fillStyle=sky; ctx.fillRect(0,0,W,H*.7);
    const wind=Math.sin(t*.22)*1.0+Math.sin(t*.61)*.4;
    petalP.forEach((p,i)=>{
      p.swing+=p.swingSpd;
      p.x+=p.vx+Math.sin(p.swing)*p.swingAmp+wind*.28;
      p.y+=p.vy+Math.sin(p.swing*.5)*.12;
      p.rot+=p.rotV+Math.cos(p.swing*.7)*.006;
      if (p.y>H*.86) { p.vy=Math.max(0,p.vy-.025); p.a=Math.max(0,p.a-.009); }
      if (p.y>H+20||p.x<-80||p.x>W+80||p.a<=0) petalP[i]=_newPetal();
      else _petal(p.x,p.y,p.sz,p.rot,p.a);
    });
  }

  /* ── main loop ── */
  function draw() {
    ctx.clearRect(0,0,W,H);
    const t=Date.now()*.001;
    ({sunny:dSunny,night:dNight,cloudy:dCloudy,fog:dFog,rain:dRain,snow:dSnow,storm:dStorm,leaves:dLeaves,spring:dSpring})[type]?.(t);
  }
  function loop() { draw(); rafId=requestAnimationFrame(loop); }
  function start(wt) { type=wt; _init(); if (!rafId) loop(); }

  function fetchWeather(lat,lon) {
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`)
      .then(r=>r.json())
      .then(d=>{ const cw=d.current_weather; _autoType=wmoType(cw.weathercode,cw.is_day===1); if(type!=="leaves") start(_autoType); })
      .catch(()=>{ _autoType="sunny"; if(type!=="leaves") start("sunny"); });
  }
  function _clearWeatherBtns() {
    document.getElementById("leafToggleBtn")  ?.classList.remove("leaf-active");
    document.getElementById("rainToggleBtn")  ?.classList.remove("rain-active");
    document.getElementById("snowToggleBtn")  ?.classList.remove("snow-active");
    document.getElementById("springToggleBtn")?.classList.remove("spring-active");
  }
  window._getWeatherType = () => type;

  window._leafToggle = function() {
    const btn=document.getElementById("leafToggleBtn");
    if (type==="leaves") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("leaves"); btn&&btn.classList.add("leaf-active"); }
  };
  window._rainToggle = function() {
    const btn=document.getElementById("rainToggleBtn");
    if (type==="rain") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("rain"); btn&&btn.classList.add("rain-active"); }
  };
  window._snowToggle = function() {
    const btn=document.getElementById("snowToggleBtn");
    if (type==="snow") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("snow"); btn&&btn.classList.add("snow-active"); }
  };
  window._springToggle = function() {
    const btn=document.getElementById("springToggleBtn");
    if (type==="spring") { start(_autoType); _clearWeatherBtns(); }
    else { _clearWeatherBtns(); start("spring"); btn&&btn.classList.add("spring-active"); }
  };

  window.addEventListener("resize", resize);
  resize();
  start("sunny");

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      p=>fetchWeather(p.coords.latitude,p.coords.longitude),
      ()=>fetchWeather(25.04,121.51)
    );
  } else {
    fetchWeather(25.04,121.51);
  }
})();
