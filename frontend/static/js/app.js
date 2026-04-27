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
  bg:      "#1e222d",
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
let equityChart, equitySeries;

/* ── 狀態 ── */
let strategies      = {};
let ohlcvData       = [];
let lastTradeData   = [];
let currentTF       = "1d";
let realtimeTimer   = null;
let lastCRTMarkers  = [];
let paneCollapseFlex = {};  // 面板收合前的 flex 值（module-level，供 loadVisibilityPrefs 使用）
let _restoringPrefs  = false; // 還原偏好設定時，暫停自動儲存

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

  buildCharts();
  syncColorInputsToState();
  await loadStrategies();
  bindEvents();
  syncTimeScales();
  updateMarketUI();
  applyAllColors();
  loadData(true)
    .then(() => { loadVisibilityPrefs(); applyAllLineStyles(); })
    .catch(() => showToast("⚠️ 載入失敗，請點「載入」重試"));
});

/* ── 建立圖表 ── */
function buildCharts() {
  const base  = makeBaseOpts(null,                   false);
  const sub   = makeBaseOpts({ top:0.08, bottom:0.08 }, false);
  const volSM = makeBaseOpts({ top:0.05, bottom:0 },    false);
  const subT  = makeBaseOpts({ top:0.08, bottom:0.08 }, true);  // 最下方，顯示時間軸

  mainChart  = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  candleSeries = mainChart.addCandlestickSeries({
    upColor: C.up, downColor: C.down,
    borderUpColor: C.up, borderDownColor: C.down,
    wickUpColor:   C.up, wickDownColor:   C.down,
  });
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

  equityChart = LightweightCharts.createChart(document.getElementById("equityChart"), {
    ...makeBaseOpts({ top:0.05, bottom:0.05 }),
  });
  equitySeries = equityChart.addLineSeries({ color:"#26a69a", lineWidth:2, priceLineVisible:false, lastValueVisible:true });

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
    [equityChart, "equityChart"],
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
  const allCharts = [mainChart, kdjChart, rsiChart, macdChart, equityChart];
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

  function positionLines(time) {
    // 用 mainChart 的 x 座標讓所有段對齊同一條線
    // （各 sub-chart 的 price scale 寬度不同，若各自計算 x 會有偏移，看起來像斷掉）
    const x = mainChart.timeScale().timeToCoordinate(time);
    if (x === null || x < 0) {
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
      positionLines(param.time);
      updateAllLegends(param.time);
    });
  });

  // 子圖停用 LWC 原生鉛直線（主圖保留 LWC 的）
  [kdjChart, rsiChart, macdChart].forEach(c => {
    c.applyOptions({ crosshair: { vertLine: { visible: false } } });
  });
}

/* ══════════════════════════════════════════
   顏色 / 樣式
══════════════════════════════════════════ */
function applyAllColors() {
  const bgOpt = { layout: { background:{ color: C.bg }, textColor:"#d1d4dc" } };
  [mainChart, kdjChart, rsiChart, macdChart, equityChart].forEach(c => c?.applyOptions(bgOpt));
  document.body.style.background = C.bg;

  candleSeries.applyOptions({
    upColor:C.up, downColor:C.down, borderUpColor:C.up, borderDownColor:C.down,
    wickUpColor:C.up, wickDownColor:C.down,
  });
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
  document.getElementById("strategySelect").addEventListener("change", renderStrategyParams);
  document.getElementById("loadBtn").addEventListener("click", () => loadData(false));
  document.getElementById("backtestBtn").addEventListener("click", runBacktest);
  document.getElementById("drawerClose").addEventListener("click", () =>
    document.getElementById("tradeDrawer").classList.add("hidden"));
  document.getElementById("exportCsvBtn").addEventListener("click", exportCSV);

  // 側欄收合（手機）
  document.getElementById("sidebarToggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("sidebar-open");
  });

  // 回測模式切換
  document.getElementById("backtestModeBtn").addEventListener("click", () => {
    const btn   = document.getElementById("backtestModeBtn");
    const panel = document.getElementById("backtestPanel");
    const isOn  = btn.classList.toggle("active");
    panel.classList.toggle("hidden", !isOn);
    btn.textContent = isOn ? "✕ 關閉回測" : "回測模式";
    if (!isOn) {
      candleSeries.setMarkers(lastCRTMarkers);
      document.getElementById("tradeDrawer").classList.add("hidden");
      document.getElementById("statsPanel").classList.add("hidden");
      toggleEquityPane(false);
    }
  });

  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTF = btn.dataset.tf;
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
}

function updateMarketUI() {
  const isCrypto = document.getElementById("marketSelect").value === "crypto";
  document.getElementById("exchangeSelect").style.display = isCrypto ? "" : "none";
  document.getElementById("symbolInput").placeholder = isCrypto ? "BTC/USDT" : "2330";
  document.getElementById("symbolInput").value       = isCrypto ? "BTC/USDT" : "2330";
  document.querySelectorAll(".tf-btn").forEach(btn => {
    const off = !isCrypto && ["4h","1h","15m"].includes(btn.dataset.tf);
    btn.disabled = off;
    if (off && btn.classList.contains("active")) {
      btn.classList.remove("active");
      document.querySelector(".tf-btn[data-tf='1d']").classList.add("active");
      currentTF = "1d";
    }
  });
}

function toggleEquityPane(show) {
  const pane = document.getElementById("equityPane");
  const div  = document.getElementById("equityDivider");
  pane.classList.toggle("hidden", !show);
  div.classList.toggle("hidden", !show);
  setTimeout(resizeAll, 50);
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
    { paneId: "equityPane", chart: equityChart },
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
    { id: "legCRT",      series: null,  action: h => h ? candleSeries.setMarkers([]) : candleSeries.setMarkers(lastCRTMarkers) },
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
   策略
══════════════════════════════════════════ */
async function loadStrategies() {
  const res = await fetch("/api/strategies");
  strategies = await res.json();
  const sel  = document.getElementById("strategySelect");
  sel.innerHTML = "";
  for (const [id, info] of Object.entries(strategies)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = info.name;
    sel.appendChild(opt);
  }
  renderStrategyParams();
}

function renderStrategyParams() {
  const id     = document.getElementById("strategySelect").value;
  const params = strategies[id]?.params || [];
  const box    = document.getElementById("strategyParams");
  box.innerHTML = "";
  params.forEach(p => {
    const row = document.createElement("div");
    row.className = "param-row";
    const lbl = document.createElement("label"); lbl.textContent = p.label;
    const inp = document.createElement("input");
    inp.type = "number"; inp.id = `param_${p.key}`; inp.value = p.default;
    if (p.min !== undefined) inp.min = p.min;
    if (p.max !== undefined) inp.max = p.max;
    if (p.type === "float") inp.step = "0.1";
    row.append(lbl, inp); box.append(row);
  });
}

/* ══════════════════════════════════════════
   資料載入 & 回測
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
    document.getElementById("backtestBtn").disabled = false;
    startRealtime();
  } catch(e) {
    if (!autoLoad) alert("❌ " + e.message);
    throw e;
  } finally { showLoading(false); }
}

async function runBacktest() {
  const stratId  = document.getElementById("strategySelect").value;
  const stratDef = strategies[stratId];
  const params   = {};
  for (const p of stratDef.params) {
    const el = document.getElementById(`param_${p.key}`);
    params[p.key] = p.type === "float" ? parseFloat(el.value) : parseInt(el.value);
  }
  showLoading(true);
  try {
    const res  = await fetch("/api/backtest", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        ...buildPayload(),
        strategy_id:     stratId,
        strategy_params: params,
        initial_capital: parseFloat(document.getElementById("capital").value),
        size_pct:        parseFloat(document.getElementById("sizePct").value) / 100,
        commission:      parseFloat(document.getElementById("commission").value) / 100,
        slippage:        parseFloat(document.getElementById("slippage").value) / 100,
        allow_short:     document.getElementById("allowShort").checked,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "回測失敗");
    lastTradeData = json.trades;
    ohlcvData = json.ohlcv;
    renderAll(json.ohlcv);
    renderBacktestMarkers(json.trades);
    renderStats(json.stats);
    renderTradeTable(json.trades);
    renderEquityCurve(json.equity_curve);
    toggleEquityPane(true);
  } catch(e) {
    alert("❌ " + e.message);
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
  renderVolume(data);
  renderKDJ(data);
  renderRSI(data);
  renderMACD(data);
  updateSymbolBar(data);

  // 先 fit 讓 LWC 計算出正確的時間範圍（排除 equityChart，它沒有資料）
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().fitContent());

  // 顯示最後 50 根（logical range，anchor series 確保各圖索引對齊）
  if (data.length > 50) {
    mainChart.timeScale().setVisibleLogicalRange({ from: data.length - 50, to: data.length - 1 });
  }

  resizeAll();
}

function renderCandles(data) {
  candleSeries.setData(data.map(d => ({
    time:d.time?toTime(d.time):d, open:d.open, high:d.high, low:d.low, close:d.close,
  })));
  lastCRTMarkers = []; candleSeries.setMarkers([]);
}

function renderBB(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  bbU.setData(line("bb_upper")); bbM.setData(line("bb_middle")); bbL.setData(line("bb_lower"));
}

function renderCRT(data) {
  const markers = [];
  data.forEach(d => {
    if (d.crt === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.crtBull, shape:"arrowUp",   size:1.5, text:"" });
    if (d.crt === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.crtBear, shape:"arrowDown", size:1.5, text:"" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastCRTMarkers = markers;
  // 若圖例已設為隱藏，不重新顯示標記
  if (!document.getElementById("legCRT")?.classList.contains("line-off"))
    candleSeries.setMarkers(markers);
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

function renderEquityCurve(curve) {
  equitySeries.setData(curve.map(e => ({ time:toTime(e.time), value:e.equity })));
}

function renderBacktestMarkers(trades) {
  const markers = [];
  trades.forEach(t => {
    markers.push({ time:toTime(t.entry_time), position:"belowBar", color:C.up,   shape:"arrowUp",   size:1, text:"" });
    if (t.exit_time)
      markers.push({ time:toTime(t.exit_time), position:"aboveBar", color:C.down, shape:"arrowDown", size:1, text:"" });
  });
  markers.sort((a,b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

/* ══════════════════════════════════════════
   即時更新
══════════════════════════════════════════ */
function startRealtime() {
  const dot    = document.getElementById("realtimeDot");
  const market = document.getElementById("marketSelect").value;
  if (market === "tw") { dot.classList.add("hidden"); return; }
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
      candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
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
    market === "tw" ? symbol : symbol.replace("/", " / ");
  document.getElementById("symExchange").textContent =
    market === "tw" ? `台股 · ${tfLabel}` : `${exch} · ${tfLabel}`;
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

function renderStats(stats) {
  document.getElementById("statsPanel").classList.remove("hidden");
  const rows = [
    ["交易次數",  stats.total_trades,  null],
    ["勝率",      `${(stats.win_rate*100).toFixed(1)}%`, stats.win_rate >= 0.5],
    ["獲利因子",  stats.profit_factor, stats.profit_factor >= 1],
    ["總報酬",    `${stats.total_return}%`, stats.total_return >= 0],
    ["最大回撤",  `${stats.max_drawdown}%`, false],
    ["夏普比率",  stats.sharpe_ratio,  stats.sharpe_ratio >= 1],
    ["平均獲利",  `$${stats.avg_win}`, true],
    ["平均虧損",  `$${stats.avg_loss}`, false],
    ["總損益",    `$${stats.total_pnl}`, stats.total_pnl >= 0],
    ["最終資金",  `$${stats.final_equity?.toLocaleString()}`, null],
  ];
  document.getElementById("statsContent").innerHTML = rows.map(([lbl,val,pos]) =>
    `<div class="stat-row"><span class="stat-label">${lbl}</span><span class="stat-value ${pos===null?"":pos?"up":"dn"}">${val}</span></div>`
  ).join("");
}

function renderTradeTable(trades) {
  const drawer = document.getElementById("tradeDrawer");
  drawer.classList.remove("hidden");
  const wins = trades.filter(t => t.pnl > 0).length;
  document.getElementById("tradeSummary").textContent = `${trades.length}筆  ${wins}勝 ${trades.length-wins}敗`;
  document.querySelector("#tradeTable tbody").innerHTML = trades.map(t => {
    const cls = t.pnl >= 0 ? "cell-up" : "cell-dn";
    return `<tr>
      <td>${fmtT(t.entry_time)}</td><td>${fmtT(t.exit_time)}</td>
      <td>${t.side==="long"?"多":"空"}</td>
      <td>${fmt(t.entry_price)}</td><td>${t.exit_price?fmt(t.exit_price):"—"}</td>
      <td>${t.size}</td>
      <td class="${cls}">${t.pnl??"—"}</td>
      <td class="${cls}">${t.pnl_pct!=null?t.pnl_pct+"%":"—"}</td>
      <td>${t.exit_reason}</td>
    </tr>`;
  }).join("");
}

/* ══════════════════════════════════════════
   匯出功能
══════════════════════════════════════════ */
function exportCSV() {
  if (!lastTradeData.length) return alert("請先執行回測");
  const header = "進場時間,出場時間,方向,進場價,出場價,數量,損益,損益%,原因";
  const rows   = lastTradeData.map(t =>
    [t.entry_time,t.exit_time??"",t.side==="long"?"多":"空",
     t.entry_price,t.exit_price??"",t.size,t.pnl??"",t.pnl_pct??"",t.exit_reason].join(",")
  );
  const csv  = [header, ...rows].join("\n");
  const blob = new Blob(["\ufeff" + csv], { type:"text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "backtest_trades.csv"; a.click();
  URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════
   工具函式
══════════════════════════════════════════ */
function buildPayload(useLimit = false) {
  return {
    market:    document.getElementById("marketSelect").value,
    symbol:    document.getElementById("symbolInput").value.trim(),
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
