/* ═══════════════════════════════════════════════
   回測系統 — 前端  v6
   面板：主圖(K線+BB+CRT) | 成交量(MA可調) | KDJ | RSI
   配色：紅漲綠跌 + 用戶可自訂（含持久化）
═══════════════════════════════════════════════ */

/* ── 預設顏色 ── */
const DEFAULT_COLORS = {
  up:      "#ef5350",
  down:    "#26a69a",
  bbU:     "#42a5f5",
  bbM:     "#ffcc02",
  bbL:     "#42a5f5",
  kdjK:    "#f23645",
  kdjD:    "#1e88e5",
  kdjJ:    "#ff9800",
  rsi14:   "#7e57c2",
  rsi7:    "#ef5350",
  crtBull: "#26a69a",
  crtBear: "#ef5350",
  bg:      "#1e222d",
  kdjHL:   "#aaaaaa",
  rsiHL:   "#aaaaaa",
};

/* ── 預設樣式（粗細、透明度、MA 期數）── */
const DEFAULT_STYLES = {
  kdjHLOpacity: 25,   // KDJ 水平線透明度 0-100
  kdjHLWidth:   1,    // KDJ 水平線粗細 px
  rsiHLOpacity: 25,   // RSI 水平線透明度 0-100
  rsiHLWidth:   1,    // RSI 水平線粗細 px
  volMaPeriod:  5,    // 成交量 MA 期數
};

let C = { ...DEFAULT_COLORS };
let S = { ...DEFAULT_STYLES };

/* ── 圖表物件 ── */
let mainChart, candleSeries, bbU, bbM, bbL;
let volChart,  volSeries, volMaSeries;
let kdjChart,  kdjK, kdjD, kdjJ, kdjH20, kdjH50, kdjH80;
let rsiChart,  rsiLine14, rsiLine7, rsiH30, rsiH50, rsiH70;

/* ── 應用狀態 ── */
let strategies     = {};
let ohlcvData      = [];
let currentTF      = "1d";
let realtimeTimer  = null;
let lastCRTMarkers = [];

const TF_LABELS = { "1M":"月","1w":"週","1d":"日","4h":"4H","1h":"1H","15m":"15m" };

/* ── 工具：時間轉 Unix 秒（支援日線/分線）── */
function toTime(s) {
  if (!s) return 0;
  // 如果只有日期部份 "YYYY-MM-DD"，補足 UTC 時間
  const iso = s.includes("T")
    ? (s.endsWith("Z") ? s : s + "Z")
    : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000);
}

/* ── 工具：hex 顏色 + 透明度 → 8位hex ── */
function hexAlpha(hex, opacity) {
  // opacity: 0-100
  const a = Math.round(Math.max(0, Math.min(100, opacity)) / 100 * 255)
    .toString(16).padStart(2, "0");
  return hex + a;
}

/* ── localStorage 持久化 ── */
function savePrefs() {
  try {
    localStorage.setItem("chartColors", JSON.stringify(C));
    localStorage.setItem("chartStyles", JSON.stringify(S));
  } catch {}
}

function loadPrefs() {
  try {
    const cc = JSON.parse(localStorage.getItem("chartColors") || "{}");
    const ss = JSON.parse(localStorage.getItem("chartStyles") || "{}");
    Object.assign(C, cc);
    Object.assign(S, ss);
  } catch {}
}

/* ── 圖表基本設定（動態使用 C.bg）── */
function makeBaseOpts() {
  return {
    layout:    { background:{ color: C.bg }, textColor:"#d1d4dc" },
    grid:      { vertLines:{ color:"#2a2e39" }, horzLines:{ color:"#2a2e39" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor:"#2a2e39" },
    timeScale: { borderColor:"#2a2e39", timeVisible:true, secondsVisible:false },
  };
}

/* ══════════════════════════════════════════
   初始化
══════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  loadPrefs();

  // 動態設今天日期
  const today = new Date();
  const yyyy  = today.getFullYear();
  const mm    = String(today.getMonth() + 1).padStart(2, "0");
  const dd    = String(today.getDate()).padStart(2, "0");
  document.getElementById("endDate").value   = `${yyyy}-${mm}-${dd}`;
  document.getElementById("startDate").value = `${yyyy - 1}-${mm}-${dd}`;

  buildCharts();
  syncColorInputsToState();
  await loadStrategies();
  bindEvents();
  syncTimeScales();
  updateMarketUI();
  applyAllColors();
  loadData(true).catch(() => {});
});

/* ── 建立圖表 ── */
function buildCharts() {
  const base = makeBaseOpts();

  mainChart = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  candleSeries = mainChart.addCandlestickSeries({
    upColor: C.up, downColor: C.down,
    borderUpColor: C.up, borderDownColor: C.down,
    wickUpColor:   C.up, wickDownColor:   C.down,
  });
  bbU = mainChart.addLineSeries({ color: C.bbU, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  bbM = mainChart.addLineSeries({ color: C.bbM, lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });
  bbL = mainChart.addLineSeries({ color: C.bbL, lineWidth:1, priceLineVisible:false, lastValueVisible:false });

  volChart = LightweightCharts.createChart(document.getElementById("volChart"), {
    ...base,
    rightPriceScale:{ borderColor:"#2a2e39", scaleMargins:{ top:0.05, bottom:0 } },
  });
  volSeries   = volChart.addHistogramSeries({ priceScaleId:"right" });
  volMaSeries = volChart.addLineSeries({
    color:"#ffcc02", lineWidth:1, priceLineVisible:false, lastValueVisible:false,
  });

  const kdjHLColor = hexAlpha(C.kdjHL, S.kdjHLOpacity);
  kdjChart = LightweightCharts.createChart(document.getElementById("kdjChart"), {
    ...base,
    rightPriceScale:{ borderColor:"#2a2e39", scaleMargins:{ top:0.08, bottom:0.08 } },
  });
  kdjK   = kdjChart.addLineSeries({ color: C.kdjK, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjD   = kdjChart.addLineSeries({ color: C.kdjD, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjJ   = kdjChart.addLineSeries({ color: C.kdjJ, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjH20 = kdjChart.addLineSeries({ color: kdjHLColor, lineWidth: S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH50 = kdjChart.addLineSeries({ color: kdjHLColor, lineWidth: S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH80 = kdjChart.addLineSeries({ color: kdjHLColor, lineWidth: S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  const rsiHLColor = hexAlpha(C.rsiHL, S.rsiHLOpacity);
  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), {
    ...base,
    rightPriceScale:{ borderColor:"#2a2e39", scaleMargins:{ top:0.08, bottom:0.08 } },
  });
  rsiLine14 = rsiChart.addLineSeries({ color: C.rsi14, lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiLine7  = rsiChart.addLineSeries({ color: C.rsi7,  lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiH30 = rsiChart.addLineSeries({ color: rsiHLColor, lineWidth: S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH50 = rsiChart.addLineSeries({ color: rsiHLColor, lineWidth: S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH70 = rsiChart.addLineSeries({ color: rsiHLColor, lineWidth: S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  const ro = new ResizeObserver(() => resizeAll());
  ro.observe(document.getElementById("chartsContainer"));
  setTimeout(resizeAll, 50);
}

function resizeAll() {
  const container = document.getElementById("chartsContainer");
  const w = container.clientWidth;
  [
    [mainChart, "mainChart"],
    [volChart,  "volChart"],
    [kdjChart,  "kdjChart"],
    [rsiChart,  "rsiChart"],
  ].forEach(([chart, id]) => {
    const el = document.getElementById(id);
    if (!el || !chart) return;
    const h = el.clientHeight;
    if (h > 10) chart.resize(w, h);
  });
}

/* ── 時間軸同步 ── */
function syncTimeScales() {
  const charts = [mainChart, volChart, kdjChart, rsiChart];
  let syncing = false;
  charts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      charts.forEach((dst, di) => { if (di !== si) dst.timeScale().setVisibleLogicalRange(range); });
      syncing = false;
    });
  });

  mainChart.subscribeCrosshairMove(onMainCrosshair);
  kdjChart.subscribeCrosshairMove(onKdjCrosshair);
  rsiChart.subscribeCrosshairMove(onRsiCrosshair);
  volChart.subscribeCrosshairMove(onVolCrosshair);
}

/* ══════════════════════════════════════════
   顏色／樣式設定
══════════════════════════════════════════ */
function applyAllColors() {
  // 背景（全部圖表）
  const bgOpt = { layout: { background:{ color: C.bg }, textColor:"#d1d4dc" } };
  [mainChart, volChart, kdjChart, rsiChart].forEach(c => c && c.applyOptions(bgOpt));
  document.body.style.background = C.bg;

  // K 棒
  candleSeries.applyOptions({
    upColor: C.up, downColor: C.down,
    borderUpColor: C.up, borderDownColor: C.down,
    wickUpColor:   C.up, wickDownColor:   C.down,
  });
  // BB
  bbU.applyOptions({ color: C.bbU });
  bbM.applyOptions({ color: C.bbM });
  bbL.applyOptions({ color: C.bbL });
  // KDJ 線
  kdjK.applyOptions({ color: C.kdjK });
  kdjD.applyOptions({ color: C.kdjD });
  kdjJ.applyOptions({ color: C.kdjJ });
  // KDJ 水平線
  const kdjHLColor = hexAlpha(C.kdjHL, S.kdjHLOpacity);
  [kdjH20, kdjH50, kdjH80].forEach(s => s.applyOptions({ color: kdjHLColor, lineWidth: S.kdjHLWidth }));
  // RSI 線
  rsiLine14.applyOptions({ color: C.rsi14 });
  rsiLine7.applyOptions({ color: C.rsi7 });
  // RSI 水平線
  const rsiHLColor = hexAlpha(C.rsiHL, S.rsiHLOpacity);
  [rsiH30, rsiH50, rsiH70].forEach(s => s.applyOptions({ color: rsiHLColor, lineWidth: S.rsiHLWidth }));

  // 重繪有顏色 embedded 的系列
  if (ohlcvData.length > 0) {
    renderCRT(ohlcvData);
    renderVolume(ohlcvData);
  }
  // 圖例顏色
  document.getElementById("legK").style.color     = C.kdjK;
  document.getElementById("legD").style.color     = C.kdjD;
  document.getElementById("legJ").style.color     = C.kdjJ;
  document.getElementById("legRsi14").style.color = C.rsi14;
  document.getElementById("legRsi7").style.color  = C.rsi7;
  document.getElementById("legCRT").style.color   = C.crtBull;

  savePrefs();
}

/* 將已儲存的 C/S 同步回 HTML 輸入元素 */
function syncColorInputsToState() {
  const colorMap = {
    "c-up":      "up",      "c-down":    "down",
    "c-bbU":     "bbU",     "c-bbM":     "bbM",     "c-bbL":     "bbL",
    "c-kdjK":    "kdjK",    "c-kdjD":    "kdjD",    "c-kdjJ":    "kdjJ",
    "c-rsi14":   "rsi14",   "c-rsi7":    "rsi7",
    "c-crtBull": "crtBull", "c-crtBear": "crtBear",
    "c-bg":      "bg",
    "c-kdjHL":   "kdjHL",   "c-rsiHL":   "rsiHL",
  };
  for (const [id, key] of Object.entries(colorMap)) {
    const el = document.getElementById(id);
    if (el) el.value = C[key];
  }
  const styleMap = {
    "o-kdjHL":      ["kdjHLOpacity", false],
    "w-kdjHL":      ["kdjHLWidth",   false],
    "o-rsiHL":      ["rsiHLOpacity", false],
    "w-rsiHL":      ["rsiHLWidth",   false],
    "volMaPeriod":  ["volMaPeriod",  false],
  };
  for (const [id, [key]] of Object.entries(styleMap)) {
    const el = document.getElementById(id);
    if (el) el.value = S[key];
  }
}

function bindColorInputs() {
  const colorMap = {
    "c-up":      "up",      "c-down":    "down",
    "c-bbU":     "bbU",     "c-bbM":     "bbM",     "c-bbL":     "bbL",
    "c-kdjK":    "kdjK",    "c-kdjD":    "kdjD",    "c-kdjJ":    "kdjJ",
    "c-rsi14":   "rsi14",   "c-rsi7":    "rsi7",
    "c-crtBull": "crtBull", "c-crtBear": "crtBear",
    "c-bg":      "bg",
    "c-kdjHL":   "kdjHL",   "c-rsiHL":   "rsiHL",
  };

  for (const [id, key] of Object.entries(colorMap)) {
    document.getElementById(id)?.addEventListener("input", e => {
      C[key] = e.target.value;
      applyAllColors();
    });
  }

  // 樣式輸入（透明度、粗細、MA期數）
  const styleHandler = (id, key, isInt = true) => {
    document.getElementById(id)?.addEventListener("input", e => {
      S[key] = isInt ? parseInt(e.target.value) : parseFloat(e.target.value);
      applyAllColors();
      // MA期數改變時重新渲染成交量
      if (key === "volMaPeriod" && ohlcvData.length > 0) renderVolume(ohlcvData);
    });
  };
  styleHandler("o-kdjHL",     "kdjHLOpacity");
  styleHandler("w-kdjHL",     "kdjHLWidth");
  styleHandler("o-rsiHL",     "rsiHLOpacity");
  styleHandler("w-rsiHL",     "rsiHLWidth");
  styleHandler("volMaPeriod", "volMaPeriod");

  // 重設
  document.getElementById("resetColors")?.addEventListener("click", () => {
    C = { ...DEFAULT_COLORS };
    S = { ...DEFAULT_STYLES };
    syncColorInputsToState();
    applyAllColors();
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
    document.getElementById("tradeDrawer").classList.add("hidden")
  );

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
    const panel = document.getElementById("colorPanel");
    const arrow = document.querySelector(".toggle-arrow");
    panel.classList.toggle("hidden");
    arrow.classList.toggle("open");
  });

  bindColorInputs();
  bindPaneDividers();
}

function updateMarketUI() {
  const isCrypto = document.getElementById("marketSelect").value === "crypto";
  document.getElementById("exchangeSelect").style.display = isCrypto ? "" : "none";
  document.getElementById("symbolInput").placeholder = isCrypto ? "BTC/USDT" : "2330";
  document.getElementById("symbolInput").value       = isCrypto ? "BTC/USDT" : "2330";
  document.querySelectorAll(".tf-btn").forEach(btn => {
    const disabled = !isCrypto && ["4h","1h","15m"].includes(btn.dataset.tf);
    btn.disabled = disabled;
    if (disabled && btn.classList.contains("active")) {
      btn.classList.remove("active");
      document.querySelector(".tf-btn[data-tf='1d']").classList.add("active");
      currentTF = "1d";
    }
  });
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

function nextVisiblePane(el) {
  let sib = el.nextElementSibling;
  while (sib) {
    if (sib.classList.contains("pane-divider")) { sib = sib.nextElementSibling; continue; }
    if (sib.classList.contains("chart-pane"))   return sib;
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
    const lbl = document.createElement("label");
    lbl.textContent = p.label;
    const inp = document.createElement("input");
    inp.type = "number"; inp.id = `param_${p.key}`; inp.value = p.default;
    if (p.min !== undefined) inp.min = p.min;
    if (p.max !== undefined) inp.max = p.max;
    if (p.type === "float")  inp.step = "0.1";
    box.append(lbl, inp);
  });
}

/* ══════════════════════════════════════════
   資料載入 & 回測
══════════════════════════════════════════ */
async function loadData(autoLoad = false) {
  stopRealtime();
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
    const btn = document.getElementById("backtestBtn");
    if (btn) btn.disabled = false;
    startRealtime();
  } catch(e) {
    if (!autoLoad) alert("❌ " + e.message);
    throw e;
  } finally {
    showLoading(false);
  }
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
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "回測失敗");
    ohlcvData = json.ohlcv;
    renderAll(json.ohlcv);
    renderBacktestMarkers(json.trades);
    renderStats(json.stats);
    renderTradeTable(json.trades);
  } catch(e) {
    alert("❌ " + e.message);
  } finally {
    showLoading(false);
  }
}

/* ══════════════════════════════════════════
   渲染
══════════════════════════════════════════ */
function renderAll(data) {
  renderCandles(data);
  renderBB(data);
  renderCRT(data);
  renderVolume(data);
  renderKDJ(data);
  renderRSI(data);
  updateSymbolBar(data);

  // 先 fitContent，再縮放到最近 120 根（讓用戶能往前滑）
  [mainChart, volChart, kdjChart, rsiChart].forEach(c => c.timeScale().fitContent());
  if (data.length > 120) {
    mainChart.timeScale().setVisibleLogicalRange({
      from: data.length - 120,
      to:   data.length - 1,
    });
  }
}

function renderCandles(data) {
  candleSeries.setData(data.map(d => ({
    time: toTime(d.time), open:d.open, high:d.high, low:d.low, close:d.close,
  })));
  lastCRTMarkers = [];
  candleSeries.setMarkers([]);
}

function renderBB(data) {
  const line = key => data.filter(d => d[key] != null).map(d => ({ time: toTime(d.time), value: d[key] }));
  bbU.setData(line("bb_upper"));
  bbM.setData(line("bb_middle"));
  bbL.setData(line("bb_lower"));
}

function renderCRT(data) {
  const markers = [];
  data.forEach(d => {
    if (d.crt === 1)
      markers.push({ time: toTime(d.time), position:"belowBar", color: C.crtBull, shape:"arrowUp",   size:1.5, text:"" });
    else if (d.crt === -1)
      markers.push({ time: toTime(d.time), position:"aboveBar", color: C.crtBear, shape:"arrowDown", size:1.5, text:"" });
  });
  markers.sort((a, b) => a.time - b.time);
  lastCRTMarkers = markers;
  candleSeries.setMarkers(markers);
}

function renderVolume(data) {
  volSeries.setData(data.map(d => ({
    time:  toTime(d.time),
    value: d.volume || 0,
    color: d.close >= d.open ? C.up + "aa" : C.down + "aa",
  })));
  // 成交量 MA（期數可調）
  const period = Math.max(1, S.volMaPeriod);
  const maData = [];
  for (let i = period - 1; i < data.length; i++) {
    const avg = data.slice(i - period + 1, i + 1).reduce((s, d) => s + (d.volume || 0), 0) / period;
    maData.push({ time: toTime(data[i].time), value: avg });
  }
  volMaSeries.setData(maData);
}

function renderKDJ(data) {
  const line = key => data.filter(d => d[key] != null).map(d => ({ time: toTime(d.time), value: d[key] }));
  kdjK.setData(line("kdj_k"));
  kdjD.setData(line("kdj_d"));
  kdjJ.setData(line("kdj_j"));
  if (data.length > 0) {
    const f = toTime(data[0].time), l = toTime(data[data.length - 1].time);
    kdjH20.setData([{ time:f, value:20 }, { time:l, value:20 }]);
    kdjH50.setData([{ time:f, value:50 }, { time:l, value:50 }]);
    kdjH80.setData([{ time:f, value:80 }, { time:l, value:80 }]);
  }
}

function renderRSI(data) {
  const line = key => data.filter(d => d[key] != null).map(d => ({ time: toTime(d.time), value: d[key] }));
  rsiLine14.setData(line("rsi_14"));
  rsiLine7.setData(line("rsi_7"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length - 1].time);
    rsiH30.setData([{ time:f, value:30 }, { time:l, value:30 }]);
    rsiH50.setData([{ time:f, value:50 }, { time:l, value:50 }]);
    rsiH70.setData([{ time:f, value:70 }, { time:l, value:70 }]);
  }
}

function renderBacktestMarkers(trades) {
  const markers = [];
  trades.forEach(t => {
    markers.push({ time: toTime(t.entry_time), position:"belowBar", color: C.up,   shape:"arrowUp",   size:1, text:"" });
    if (t.exit_time)
      markers.push({ time: toTime(t.exit_time), position:"aboveBar", color: C.down, shape:"arrowDown", size:1, text:"" });
  });
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

/* ══════════════════════════════════════════
   即時更新（每秒）
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

      if (t === lastT) {
        ohlcvData[ohlcvData.length - 1] = { ...last, ...bar };
      } else if (t > lastT) {
        ohlcvData.push(bar);
      } else return;

      candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
      volSeries.update({
        time:t, value: bar.volume || 0,
        color: bar.close >= bar.open ? C.up + "aa" : C.down + "aa",
      });
    });

    updateSymbolBar(ohlcvData);
  } catch {}
}

/* ══════════════════════════════════════════
   圖例（crosshair 回呼）
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
  if (bu != null)
    document.getElementById("legBB").textContent = `BB  U:${fmt(bu)}  M:${fmt(bm)}  L:${fmt(bl)}`;
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
  const last = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : last;
  document.getElementById("symO").textContent = fmt(last.open);
  document.getElementById("symH").textContent = fmt(last.high);
  document.getElementById("symL").textContent = fmt(last.low);
  document.getElementById("symC").textContent = fmt(last.close);
  document.getElementById("symV").textContent = fmtVol(last.volume);
  const chg   = ((last.close - prev.close) / prev.close * 100).toFixed(2);
  const chgEl = document.getElementById("symChg");
  chgEl.textContent = `${chg >= 0 ? "+" : ""}${chg}%`;
  chgEl.className   = "sym-chg " + (chg >= 0 ? "up" : "dn");
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
    ["總損益",    `$${stats.total_pnl}`, stats.total_pnl >= 0],
    ["最終資金",  `$${stats.final_equity.toLocaleString()}`, null],
  ];
  document.getElementById("statsContent").innerHTML = rows.map(([lbl, val, pos]) =>
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
      <td>${t.side === "long" ? "多" : "空"}</td>
      <td>${fmt(t.entry_price)}</td><td>${t.exit_price ? fmt(t.exit_price) : "—"}</td>
      <td>${t.size}</td>
      <td class="${cls}">${t.pnl ?? "—"}</td>
      <td class="${cls}">${t.pnl_pct != null ? t.pnl_pct+"%" : "—"}</td>
      <td>${t.exit_reason}</td>
    </tr>`;
  }).join("");
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

function fmt(v)    { return v != null ? Number(v).toLocaleString(undefined,{maximumFractionDigits:4}) : "—"; }
function n2(v)     { return v != null ? Number(v).toFixed(2) : "—"; }
function fmtVol(v) {
  if (v == null) return "—";
  if (v >= 1e9) return (v/1e9).toFixed(2)+"B";
  if (v >= 1e6) return (v/1e6).toFixed(2)+"M";
  if (v >= 1e3) return (v/1e3).toFixed(1)+"K";
  return Number(v).toLocaleString();
}
function fmtT(s)   { return s ? s.replace("T"," ").substring(0,16) : "—"; }

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
