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
let _magnetMode = false;

const DCP_COLORS = ["#f5c518","#ef5350","#26a69a","#2962ff","#ff9800","#7e57c2","#ec407a","#26c6da","#ffffff","#787b86"];
const DRAW_WIDTH  = 1.5;
let _cpShowDirect = null; // set by initColorPicker()

function _did() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

// 繪圖按「標的」分桶儲存（market:exchange:symbol）→ 各標的繪圖互不干擾。
function _drawSymKey() {
  const sym = document.getElementById("symbolInput")?.value || "";
  const mkt = document.getElementById("marketSelect")?.value || "crypto";
  const exc = document.getElementById("exchangeSelect")?.value || "pionex";
  return `${mkt}:${exc}:${sym}`.toUpperCase();
}
function _loadDrawStore() {
  try { return JSON.parse(localStorage.getItem("tv_drawings_v2") || "{}") || {}; } catch { return {}; }
}
function saveDrawings() {
  try {
    const store = _loadDrawStore();
    const key = _drawSymKey();
    if (drawings.length) store[key] = drawings; else delete store[key];
    localStorage.setItem("tv_drawings_v2", JSON.stringify(store));
  } catch {}
}
function loadDrawings() {
  try {
    const store = _loadDrawStore();
    const key = _drawSymKey();
    // 舊版單一全域 key → 一次性遷移到目前標的（避免遺失既有繪圖），遷移後刪除舊 key
    if (!(key in store)) {
      const legacy = JSON.parse(localStorage.getItem("tv_drawings") || "[]");
      if (Array.isArray(legacy) && legacy.length) {
        store[key] = legacy;
        localStorage.setItem("tv_drawings_v2", JSON.stringify(store));
      }
    }
    if (localStorage.getItem("tv_drawings") != null) localStorage.removeItem("tv_drawings");
    const arr = store[key];
    drawings = Array.isArray(arr) ? arr.filter(d => d.id && d.type) : [];
  } catch { drawings = []; }
}

/* ── 自選標的 ── */

// canvas 的 CSS 邏輯寬/高（backing store 是 device px，要除以 dpr）
function _cssW() { return drawCanvas ? drawCanvas.width  / (window.devicePixelRatio || 1) : 800; }
function _cssH() { return drawCanvas ? drawCanvas.height / (window.devicePixelRatio || 1) : 600; }

// 繪圖區寬度（扣掉右側價格軸）→ 用來判斷「最新K棒右邊空白處」與「價格軸」的界線
function _plotW() {
  try { const tw = mainChart.timeScale().width(); if (tw > 0) return tw; } catch (e) {}
  try { const pw = mainChart.priceScale("right").width(); if (pw > 0) return _cssW() - pw; } catch (e) {}
  return _cssW();
}

// 最後一根 K 棒的參考：logical index、時間、平均 bar 間隔（秒）
function _barRef() {
  const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
  if (!n) return null;
  const lastTime = toTime(ohlcvData[n - 1].time);
  let interval = 60;
  if (n >= 2) { const d = lastTime - toTime(ohlcvData[n - 2].time); if (d > 0) interval = d; }
  return { lastLogical: n - 1, lastTime, interval };
}

// time → x。原生 timeToCoordinate 只在「時間剛好落在某根 K 棒」時回座標，否則回 null。
//   ① 未來(右側空白)→ 有界外推 ② 早於資料起點 → 回 null(不外推,否則爆長線) ③ 落在兩棒之間
//   (小時框畫的端點切到大時框常不對齊任一棒)→ 相鄰棒內插(修「大時框線消失」)。
//   一律做「非有限值→null」保險,杜絕無限長線;整段 try 包住,永不因換算丟例外而弄壞整個 overlay。
function _timeToX(time) {
  try {
    const ts = mainChart.timeScale();
    const x = ts.timeToCoordinate(time);
    if (x != null) return x;
    const r = _barRef();
    if (r && time > r.lastTime) {
      const c = ts.logicalToCoordinate(r.lastLogical + (time - r.lastTime) / r.interval);   // 未來空白外推
      return (c != null && isFinite(c)) ? c : null;
    }
    const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
    if (!n) return null;
    const t0 = toTime(ohlcvData[0].time);
    if (time < t0) return null;   // 早於資料起點 → 不外推(避免端點被推到極遠→線無限長)
    let lo = 0, hi = n - 1;        // 二分找相鄰兩棒,內插分數 logical index
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (toTime(ohlcvData[mid].time) <= time) lo = mid; else hi = mid;
    }
    const tLo = toTime(ohlcvData[lo].time), tHi = toTime(ohlcvData[hi].time);
    const frac = tHi > tLo ? (time - tLo) / (tHi - tLo) : 0;
    const c = ts.logicalToCoordinate(lo + frac * (hi - lo));
    return (c != null && isFinite(c)) ? c : null;
  } catch (e) { return null; }
}

// x → time：落在右側未來空白區時，回推一個外推時間戳（以平均 bar 間隔換算）。
// 價格軸區域（x > plotW）與左側空白不外推 → 回 null，維持原行為。
function _xToTime(x) {
  const ts = mainChart.timeScale();
  const t = ts.coordinateToTime(x);
  if (t != null) return t;
  const r = _barRef();
  if (!r || x > _plotW()) return null;
  const lg = ts.coordinateToLogical(x);
  if (lg == null || lg <= r.lastLogical) return null;   // 左側空白不外推
  return Math.round(r.lastTime + (lg - r.lastLogical) * r.interval);
}

// 短距離 cache：mousemove 60+ Hz，4px 內位移直接重用上次結果
// 拖移時 drawings 內容變但長度不變、被拖那筆仍是同物件 → 命中也正確
let _findNearestCache = { x: -1e9, y: -1e9, maxDist: 0, len: -1, result: null };
function findNearest(x, y, maxDist = 12) {
  const c = _findNearestCache;
  if (c.maxDist === maxDist && c.len === drawings.length
      && Math.abs(c.x - x) < 4 && Math.abs(c.y - y) < 4) {
    return c.result;
  }
  let best = maxDist, found = null;
  drawings.forEach(d => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; found = d; }
  });
  _findNearestCache = { x, y, maxDist, len: drawings.length, result: found };
  return found;
}

/* 偵測游標是否靠近 p1 或 p2 端點 */
function _endpointHit(d, x, y, thresh = 10) {
  if (!d.p1 || !d.p2) return null;
  const a = chartToScreen(d.p1.time, d.p1.price);
  const b = chartToScreen(d.p2.time, d.p2.price);
  if (a && Math.hypot(a.x - x, a.y - y) <= thresh) return "p1";
  if (b && Math.hypot(b.x - x, b.y - y) <= thresh) return "p2";
  return null;
}

/* 目前主圖每根 K 棒的像素寬（barSpacing）；縮放時會變 */
function _emojiBarSp() {
  try { const b = mainChart.timeScale().options().barSpacing; return (b && isFinite(b) && b > 0) ? b : null; }
  catch (e) { return null; }
}
/* emoji 貼圖的實際顯示邊長：儲存尺寸 × (目前縮放 / 建立時縮放) → 隨 K 棒大小變 */
function _emojiSize(d) {
  const base = d.size || 24;
  const cur = _emojiBarSp();
  if (cur == null) return base;
  if (!d.barRef || !isFinite(d.barRef) || d.barRef <= 0) { d.barRef = cur; return base; }   // 首次錨定當下縮放
  return Math.max(4, base * (cur / d.barRef));
}

/* 對 longpos/shortpos 判斷拖移的是哪一條線 */
function _drawingHitPart(d, x, y) {
  if (d.type === "emoji") {   // 右下角縮放把手優先
    const p = chartToScreen(d.time, d.price);
    if (p) {
      const sz = _emojiSize(d);
      if (Math.hypot((p.x + sz / 2 + 3) - x, (p.y + sz / 2 + 3) - y) <= 10) return "size";
    }
    return "move";
  }
  if (d.type !== "longpos" && d.type !== "shortpos") {
    const ep = _endpointHit(d, x, y);
    return ep || "move";
  }
  if (!d.p1) return "move";
  const ey = candleSeries?.priceToCoordinate(d.p1.price);
  const ty = candleSeries?.priceToCoordinate(d.tp);
  const sy = candleSeries?.priceToCoordinate(d.sl);
  // 左邊緣寬度把手優先偵測
  const ex = _timeToX(d.p1.time);
  if (ex != null && ty != null && sy != null) {
    const W2 = _cssW();
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
    // 高 DPI（Retina）清晰化：backing store 用 devicePixelRatio 倍數，CSS 維持邏輯尺寸
    const dpr = window.devicePixelRatio || 1;
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    drawCanvas.width  = Math.round(w * dpr);
    drawCanvas.height = Math.round(h * dpr);
    drawCanvas.style.width  = w + "px";
    drawCanvas.style.height = h + "px";
    drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);  // 之後所有繪圖座標都用 CSS px
    _scheduleRenderDrawings();
  };
  resize();
  new ResizeObserver(resize).observe(chartEl);

  mainChart.timeScale().subscribeVisibleTimeRangeChange(() => _scheduleRenderDrawings());
  // 滾輪縮放（可能縮放價格軸或時間軸）→ 開短追蹤窗,確保繪圖精準跟隨,不偏離原價位。
  chartEl.addEventListener("wheel", () => _watchAxis(700), { capture: true, passive: true });
  // 游標移動時的 overlay 重畫：hover 高亮/拖移由 _onChartMouseMove(DOM capture) 自行排程，
  // 故此處只在「正在繪製中／有手繪工具啟用」時補畫預覽線。預設十字線/指標模式下游標移動
  // 不需重畫整個 overlay（現價標籤/交易時段帶只隨價軸與可見範圍變化）→ 省電、減少拖動卡頓。
  mainChart.subscribeCrosshairMove(() => {
    if (drawingWIP || (drawTool !== "pointer" && drawTool !== "crosshair")) _scheduleRenderDrawings();
  });

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
    if (_vpDrag)   { e.preventDefault(); _onChartMouseMove(fake); return; }
    if (dragState) { e.preventDefault(); _onChartMouseMove(fake); return; }
    if (drawTool === "crosshair") return;
    if (drawTool !== "pointer") e.preventDefault();
    _onChartMouseMove(fake);
  }, { capture: true, passive: false });

  chartEl.addEventListener("touchend", e => {
    const touch = e.changedTouches[0]; if (!touch) return;
    const fake = { clientX: touch.clientX, clientY: touch.clientY, stopPropagation: () => {} };
    if (_vpDrag)   { _onChartMouseUp(); return; }
    if (dragState) { _onChartMouseUp(); return; }
    if (drawTool === "pointer") {
      // 點擊選取繪圖，帶出顏色選擇器
      const { x, y } = _canvasXY(fake);
      const near = findNearest(x, y, _magnetMode ? 20 : 12);
      if (near) {
        e.preventDefault(); e.stopPropagation();
        selectedId = near.id;
        showDrawColorPicker(near, touch.clientX, touch.clientY);
        _scheduleRenderDrawings();
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
      if (hd) {
        const part = _drawingHitPart(hd, _mx, _my);
        if (part === "p1" || part === "p2" || part === "size") chartEl.style.cursor = "nwse-resize";
        else if (part === "tp" || part === "sl") chartEl.style.cursor = "ns-resize";
        else if (part === "width") chartEl.style.cursor = "ew-resize";
        else chartEl.style.cursor = "grab";
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

function _showTextInput(clientX, clientY, onConfirm) {
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:${clientX}px;top:${clientY - 36}px;z-index:9999;display:flex;gap:4px;`;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "文字 Enter 確認";
  inp.style.cssText = "background:#1e222d;color:#d1d4dc;border:1px solid #758696;padding:3px 8px;border-radius:4px;font-size:12px;width:150px;outline:none;font-family:sans-serif;";
  const ok = document.createElement("button");
  ok.textContent = "✓";
  ok.style.cssText = "background:#2962ff;color:#fff;border:none;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:12px;";
  wrap.append(inp, ok);
  document.body.appendChild(wrap);
  inp.focus();
  const confirm = () => { document.body.removeChild(wrap); onConfirm(inp.value); };
  const cancel  = () => { document.body.removeChild(wrap); onConfirm(null); };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirm(); } if (e.key === "Escape") cancel(); });
  ok.addEventListener("click", confirm);
  inp.addEventListener("blur", () => setTimeout(() => { if (document.body.contains(wrap)) cancel(); }, 200));
}

// ── emoji 貼圖選擇器（分類版，仿系統：底部分類頁籤 + 各系列大量 emoji + 最近使用）──
const _EMOJI_CATS = [
  { icon: "🕐", name: "最近使用", key: "recent", list: [] },
  { icon: "😀", name: "笑臉和人物", list: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","💩","🤡","👻","👽","🤖","👍","👎","👏","🙌","🙏","💪","🤝","👊","✊","🤞","✌️","🤟","🤘","👌","🤏","👈","👉","👆","👇","☝️","✋","👋","🤙","🫶","👀","🧠","👑"] },
  { icon: "🐻", name: "動物與自然", list: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🕷️","🐢","🐍","🦎","🦖","🐙","🦑","🦐","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🐘","🦏","🐪","🦒","🐐","🦌","🐕","🐈","🐓","🦃","🦚","🦜","🕊️","🐇","🌵","🎄","🌲","🌳","🌴","🌱","🌿","☘️","🍀","🎍","🍃","🍂","🍁","🌾","🌺","🌻","🌹","🌷","🌼","🌸","💐","🍄","🌰","🌍","🌕","🌙","⭐","🌟","✨","⚡","☄️","💥","🔥","🌪️","🌈","☀️","⛅","☁️","🌧️","⛈️","🌨️","❄️","☃️","⛄","💨","💧","💦","🌊"] },
  { icon: "🍔", name: "食物與飲料", list: ["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥒","🌽","🥕","🧄","🧅","🥔","🍠","🥐","🍞","🥖","🧀","🥚","🍳","🥞","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🥪","🌮","🌯","🥗","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🍤","🍙","🍚","🍘","🍥","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🥜","🍯","🥛","🍼","☕","🍵","🧃","🥤","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🍾","🧊","🥄","🍴","🍽️"] },
  { icon: "⚽", name: "活動", list: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🏒","🏑","🏏","⛳","🏹","🎣","🥊","🥋","🎽","🛹","⛸️","🎿","⛷️","🏂","🏋️","🤼","🤸","⛹️","🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🚣","🧗","🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎫","🎪","🤹","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🎲","♟️","🎯","🎳","🎮","🎰","🧩"] },
  { icon: "🚗", name: "旅行與地點", list: ["🚗","🚕","🚙","🚌","🚎","🏎️","🚓","🚑","🚒","🚐","🚚","🚛","🚜","🛴","🚲","🛵","🏍️","🚨","🚔","🚍","🚘","🚖","🚡","🚠","🚟","🚃","🚋","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊","🚉","✈️","🛫","🛬","🛩️","💺","🛰️","🚀","🛸","🚁","🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","⚓","⛽","🚧","🚦","🚥","🗺️","🗿","🗽","🗼","🏰","🏯","🏟️","🎡","🎢","🎠","⛲","🏖️","🏝️","🏜️","🌋","⛰️","🏔️","🗻","🏕️","⛺","🏠","🏡","🏘️","🏭","🏢","🏬","🏥","🏦","🏨","🏪","🏫","⛪","🕌","🌁","🌃","🏙️","🌄","🌅","🌆","🌇","🌉","🌌","🎆","🎇","🌈"] },
  { icon: "💡", name: "物品", list: ["⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🕹️","💽","💾","💿","📀","📷","📸","📹","🎥","📽️","🎞️","📞","☎️","📟","📠","📺","📻","🎙️","⏱️","⏰","🕰️","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯️","🧯","💸","💵","💴","💶","💷","💰","💳","💎","⚖️","🧰","🔧","🔨","🛠️","⛏️","🔩","⚙️","⛓️","🧲","🔫","💣","🧨","🔪","🗡️","⚔️","🛡️","🚬","⚰️","🏺","🔮","📿","💊","💉","🩸","🧬","🦠","🧪","🌡️","🧹","🧻","🚽","🚿","🛁","🧼","🧴","🔑","🗝️","🚪","🛋️","🛏️","🧸","🖼️","🛍️","🛒","🎁","🎈","🎏","🎀","🎊","🎉","🏮","🧧","✉️","📩","📨","📧","💌","📦","🏷️","📪","📮","📜","📃","📄","📑","📊","📈","📉","🗒️","📆","📅","🗃️","📋","📁","📂","🗞️","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🔗","📎","📐","📏","🧮","📌","📍","✂️","🖊️","🖋️","✒️","🖌️","🖍️","📝","✏️","🔍","🔎","🔒","🔓","🔑"] },
  { icon: "❤️", name: "符號", list: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","☮️","✝️","☪️","🕉️","☸️","✡️","🔯","🕎","☯️","⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","🆔","⚛️","☢️","☣️","✴️","🆚","❌","⭕","🛑","⛔","🚫","💯","💢","🚭","❗","❕","❓","❔","‼️","⁉️","⚠️","🚸","🔱","⚜️","🔰","♻️","✅","❇️","✳️","❎","💠","♾️","🌀","💤","🏧","🚾","♿","🅿️","🚹","🚺","🚻","🚮","📶","🔣","ℹ️","🔤","🔡","🔠","🆖","🆗","🆙","🆒","🆕","🆓","🔟","🔢","▶️","⏸️","⏹️","⏺️","⏭️","⏮️","⏩","⏪","🔀","🔁","🔂","🔄","➡️","⬅️","⬆️","⬇️","↗️","↘️","↙️","↖️","↕️","↔️","↪️","↩️","🔼","🔽","➕","➖","➗","✖️","💲","™️","©️","®️","🔚","🔙","🔛","🔝","✔️","☑️","🔘","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔺","🔻","🔸","🔹","🔶","🔷","🔳","🔲","⬛","⬜","🟥","🟧","🟨","🟩","🟦","🟪","🟫","🔔","🔕","📣","📢","💬","💭","🗯️","♠️","♣️","♥️","♦️"] },
  { icon: "🚩", name: "旗幟", list: ["🚩","🏁","🏴","🏳️","🏳️‍🌈","🏴‍☠️","🇹🇼","🇺🇸","🇯🇵","🇰🇷","🇨🇳","🇭🇰","🇬🇧","🇫🇷","🇩🇪","🇮🇹","🇪🇸","🇨🇦","🇦🇺","🇷🇺","🇧🇷","🇮🇳","🇸🇬","🇹🇭","🇻🇳","🇵🇭","🇲🇾","🇮🇩","🇳🇱","🇨🇭","🇸🇪","🇦🇪"] },
];
const _EMOJI_RECENT_KEY = "drawEmojiRecent";
function _emojiRecent() { try { return JSON.parse(localStorage.getItem(_EMOJI_RECENT_KEY) || "[]") || []; } catch (e) { return []; } }
function _emojiPushRecent(em) {
  try {
    let r = _emojiRecent().filter(x => x !== em);
    r.unshift(em);
    localStorage.setItem(_EMOJI_RECENT_KEY, JSON.stringify(r.slice(0, 32)));
  } catch (e) {}
}
function _showEmojiPicker(clientX, clientY, onPick) {
  const PW = 300, PH = 306, vw = window.innerWidth || 400, vh = window.innerHeight || 600;
  const left = Math.min(Math.max(6, clientX - PW / 2), vw - PW - 6);
  const top  = Math.min(Math.max(6, clientY - PH - 12), vh - PH - 6);
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${PW}px;height:${PH}px;z-index:9999;` +
    `display:flex;flex-direction:column;background:#1e222d;border:1px solid #758696;border-radius:12px;` +
    `box-shadow:0 14px 40px rgba(0,0,0,.6);overflow:hidden;font-family:sans-serif;`;
  let done = false;
  const close = (val) => {
    if (done) return; done = true;
    document.removeEventListener("pointerdown", off, true);
    document.removeEventListener("keydown", esc, true);
    if (document.body.contains(wrap)) document.body.removeChild(wrap);
    onPick(val);
  };
  const off = (e) => { if (!wrap.contains(e.target)) close(null); };
  const esc = (e) => { if (e.key === "Escape") close(null); };
  // 標題（目前分類名）
  const head = document.createElement("div");
  head.style.cssText = "padding:7px 10px 4px;font-size:11px;color:#8b93a3;flex-shrink:0;";
  // emoji 格
  const grid = document.createElement("div");
  grid.style.cssText = "flex:1;overflow-y:auto;padding:2px 6px 6px;display:grid;grid-template-columns:repeat(8,1fr);gap:1px;align-content:start;";
  const renderCat = (cat) => {
    head.textContent = cat.name;
    grid.innerHTML = "";
    const list = cat.key === "recent" ? _emojiRecent() : cat.list;
    if (!list.length) {
      const e = document.createElement("div");
      e.textContent = "（尚無最近使用）";
      e.style.cssText = "grid-column:1/-1;color:#6b7280;font-size:12px;padding:20px;text-align:center;";
      grid.appendChild(e); return;
    }
    list.forEach(em => {
      const b = document.createElement("button");
      b.textContent = em;
      b.style.cssText = "background:transparent;border:none;font-size:22px;cursor:pointer;padding:2px;border-radius:6px;line-height:1.2;";
      b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,.13)");
      b.addEventListener("mouseleave", () => b.style.background = "transparent");
      b.addEventListener("click", () => { _emojiPushRecent(em); close(em); });
      grid.appendChild(b);
    });
    grid.scrollTop = 0;
  };
  // 底部分類頁籤
  const tabs = document.createElement("div");
  tabs.style.cssText = "display:flex;border-top:1px solid rgba(255,255,255,.08);background:#171a23;flex-shrink:0;";
  _EMOJI_CATS.forEach(cat => {
    const t = document.createElement("button");
    t.textContent = cat.icon; t.title = cat.name;
    t.style.cssText = "flex:1;background:transparent;border:none;font-size:17px;cursor:pointer;padding:6px 0;opacity:.55;border-top:2px solid transparent;";
    t.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach(b => { b.style.opacity = ".55"; b.style.borderTopColor = "transparent"; });
      t.style.opacity = "1"; t.style.borderTopColor = "#2962ff";
      renderCat(cat);
    });
    tabs.appendChild(t);
  });
  wrap.append(head, grid, tabs);
  document.body.appendChild(wrap);
  const startIdx = _emojiRecent().length ? 0 : 1;   // 有最近→最近分頁,否則笑臉
  tabs.children[startIdx].click();
  document.addEventListener("keydown", esc, true);
  setTimeout(() => document.addEventListener("pointerdown", off, true), 0);   // 延一拍避開這次點擊
}

function setDrawTool(tool) {
  drawTool = tool;
  selectedId = null;
  drawingWIP = null;
  document.getElementById("cpPopup")?.classList.remove("open");
  _updateCursor();
  _scheduleRenderDrawings();
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

  // VP 截止線拖動中：x → 最近 K 棒時間，更新統計範圍
  if (_vpDrag) {
    e.stopPropagation?.();
    const lg = mainChart.timeScale().coordinateToLogical(x);
    if (lg != null && ohlcvData.length) {
      let idx = Math.round(lg);
      idx = Math.max(0, Math.min(ohlcvData.length - 1, idx));
      _vpCutTime = toTime(ohlcvData[idx].time);
      _scheduleRenderDrawings();
    }
    return;
  }

  if (dragState) {
    e.stopPropagation();   // 拖移時不讓 LWC 處理 pan
    _updateDrag(x, y);
    return;
  }

  // 靠近 VP 截止線（pointer 模式）→ 游標提示可左右拖
  if (drawTool === "pointer" && _vpOn && _vpLineLastX != null && Math.abs(x - _vpLineLastX) <= 6) {
    const chartEl = document.getElementById("mainChart");
    if (chartEl) chartEl.style.cursor = "ew-resize";
    if (hoveredId !== null) { hoveredId = null; _scheduleRenderDrawings(); }
    return;
  }

  if (drawTool === "pointer" || drawTool === "eraser") {
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    const nid  = near?.id ?? null;
    if (nid !== hoveredId) { hoveredId = nid; _updateCursor(); _scheduleRenderDrawings(); }
  } else if (drawTool !== "crosshair") {
    _scheduleRenderDrawings();   // 預覽線
  }
  // crosshair / pointer 無 hover → 不攔截，LWC 正常顯示十字（鉛直線由 charts.js 的 pane-vline 處理）
}

function _onChartMouseDown(e) {
  if (e.button !== 0) return;
  _watchAxis(1200);   // 按下可能拖動價格軸/平移 → 開追蹤窗,期間軸一動繪圖即跟隨(不偏離原價位)
  const { x, y } = _canvasXY(e);

  // VP 截止線拖動：pointer/crosshair 模式、滑鼠靠近線 → 優先於繪圖拖移與 LWC pan
  if (_vpOn && _vpLineLastX != null && (drawTool === "pointer" || drawTool === "crosshair")
      && Math.abs(x - _vpLineLastX) <= 6) {
    e.stopPropagation?.();
    _vpDrag = true;
    _updateCursor();
    _scheduleRenderDrawings();
    return;
  }

  // 只有 pointer 模式且滑鼠在線上才啟動拖移
  if (drawTool === "pointer") {
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    if (near) {
      e.stopPropagation();   // 阻止 LWC pan
      selectedId = near.id;
      dragState  = { id: near.id, startX: x, startY: y, moved: false,
                     snapshot: JSON.parse(JSON.stringify(near)),
                     part: _drawingHitPart(near, x, y) };
      _updateCursor();
      _scheduleRenderDrawings();
    }
  }
  // 其他工具：讓 LWC 正常處理
}

function _onChartMouseUp() {
  if (_vpDrag) { _vpDrag = false; _updateCursor(); _scheduleRenderDrawings(); return; }
  if (!dragState) return;
  if (dragState.moved) {
    saveDrawings();
    _dragJustMoved = true;  // 抑制緊接的 click 事件，避免意外開啟顏色面板
  }
  dragState = null;
  _updateCursor();
  _scheduleRenderDrawings();
}

function _onChartClick(e) {
  if (_dragJustMoved) { _dragJustMoved = false; return; }
  const { x, y } = _canvasXY(e);

  if (drawTool === "pointer") {
    if (dragState?.moved) return;
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    if (near) {
      // 單擊：只選取繪圖（顯示控制點），不自動開色盤——避免點到文字/盈虧比盒就跳調色盤
      // 改色請用右鍵 context menu 或 dblclick
      selectedId = near.id;
      e.stopPropagation();
      document.getElementById("cpPopup")?.classList.remove("open");
    } else {
      // 沒命中既有繪圖 → 取消選取（點擊訊號棒的自動盈虧比已移除，改為 hover 策略棒顯示止損線）
      selectedId = null;
      document.getElementById("cpPopup")?.classList.remove("open");
    }
    _scheduleRenderDrawings();
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
  if (drawTool === "avwap") {
    // 錨定 VWAP：點一根 K 棒起算(往後累積);曲線在 drawOne 依 ohlcvData 現算
    drawings.push({ id:_did(), type:"avwap", time:pt.time, color:_drawColor });
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "text") {
    _showTextInput(e.clientX, e.clientY, txt => {
      if (txt?.trim()) {
        drawings.push({ id:_did(), type:"text", time:pt.time, price:pt.price, text:txt.trim(), color:_drawColor });
        saveDrawings();
      }
      _returnToPointer();
    });
    return;
  }
  if (drawTool === "emoji") {
    _showEmojiPicker(e.clientX, e.clientY, em => {
      if (em) {
        drawings.push({ id:_did(), type:"emoji", time:pt.time, price:pt.price, text:em, size:28, barRef:_emojiBarSp() });
        saveDrawings();
      }
      _returnToPointer();
    });
    return;
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
      const _ex1 = _timeToX(drawingWIP.p1.time);
      const _ex2 = _timeToX(pt.time);
      const _vr  = mainChart.timeScale().getVisibleLogicalRange();
      const _bv  = _vr ? Math.max(10, _vr.to - _vr.from) : 50;
      const _ppb = _cssW() / _bv;
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
      const _ex1s = _timeToX(drawingWIP.p1.time);
      const _ex2s = _timeToX(pt.time);
      const _vrs  = mainChart.timeScale().getVisibleLogicalRange();
      const _bvs  = _vrs ? Math.max(10, _vrs.to - _vrs.from) : 50;
      const _ppbs = _cssW() / _bvs;
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
    _scheduleRenderDrawings();
  }
}

function _onChartDblClick(e) {
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (near) {
    // 雙擊：選取 + 開色盤（單擊不開，避免誤觸）
    e.stopPropagation();
    selectedId = near.id;
    showDrawColorPicker(near, e.clientX, e.clientY);
    _scheduleRenderDrawings();
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
    _scheduleRenderDrawings();
    return;
  }
  if (drawTool === "crosshair" || drawTool === "pointer") return;
  e.preventDefault();
  e.stopPropagation();
  drawingWIP = null;
  _scheduleRenderDrawings();
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
      const W2 = _cssW();
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
      const ox = _timeToX(orig.p1.time);
      if (ox != null) { const nt = _xToTime(ox + dx); if (nt != null) d.p1 = { ...d.p1, time: nt }; }
    }
  } else if (d.type === "vline" || d.type === "avwap") {
    const ox = _timeToX(orig.time);
    if (ox != null) { const nt = _xToTime(ox + dx); if (nt != null) d.time = nt; }
  } else if (d.type === "emoji" && dragState.part === "size") {
    // 拖右下角把手縮放：中心到游標的最大軸距 ×2 ＝ emoji 邊長（12~300）
    const p = chartToScreen(d.time, d.price);
    if (p) { const s = Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) * 2; d.size = Math.max(12, Math.min(300, Math.round(s))); d.barRef = _emojiBarSp() || d.barRef; }   // 縮放把手拖動後重新錨定當下縮放
  } else if (d.type === "text" || d.type === "emoji") {
    const op = chartToScreen(orig.time, orig.price);
    if (op) { const np = screenToChart(op.x + dx, op.y + dy); if (np) { d.time = np.time; d.price = np.price; } }
  } else if (d.p1 && d.p2) {
    const part = dragState.part;
    if (part === "p1") {
      const np = screenToChart(x, y);
      if (np) d.p1 = { time: np.time, price: np.price };
    } else if (part === "p2") {
      const np = screenToChart(x, y);
      if (np) d.p2 = { time: np.time, price: np.price };
    } else {
      const a = chartToScreen(orig.p1.time, orig.p1.price);
      const b = chartToScreen(orig.p2.time, orig.p2.price);
      if (a && b) {
        const na = screenToChart(a.x + dx, a.y + dy);
        const nb = screenToChart(b.x + dx, b.y + dy);
        if (na) d.p1 = { time:na.time, price:na.price };
        if (nb) d.p2 = { time:nb.time, price:nb.price };
      }
    }
  }
  _scheduleRenderDrawings();
}

/* ── 顏色 Popup ── */
function showDrawColorPicker(drawing, clientX, clientY) {
  if (!_cpShowDirect) return;
  const noStyle = drawing.type === "note" || drawing.type === "emoji";   // emoji 無顏色/樣式,色盤只留刪除
  _cpShowDirect(clientX, clientY, {
    sections: [{
      label: null,
      currentColor: (drawing.color || "#2962ff").substring(0, 7),
      apply: c => {
        drawing.color = c;
        _drawColor = c;
        saveDrawings();
        _scheduleRenderDrawings();
      }
    }],
    onDelete: () => {
      drawings = drawings.filter(d => d.id !== drawing.id);
      if (selectedId === drawing.id) selectedId = null;
      saveDrawings();
      _scheduleRenderDrawings();
    },
    showStyle: !noStyle,
    currentWidth: drawing.width || 1,
    currentLineStyle: drawing.lineStyle ?? 0,
    onStyleChange: (w, s) => {
      drawing.width = w; drawing.lineStyle = s;
      saveDrawings(); _scheduleRenderDrawings();
    }
  });
}

/* ── 圖例 / K棒 顏色 Popup（無刪除按鈕）── */
// sections: [{ label, currentColor, apply }]
function showLegColorPopup(clientX, clientY, sections) {
  // 極簡模式：完全鎖住所有色票調整，使用固定的系統配色
  if (document.documentElement.classList.contains("perf-mode")) return;
  if (!_cpShowDirect) return;
  _cpShowDirect(clientX, clientY, { sections, onDelete: null });
}

function _magnetSnap(x, y) {
  if (!ohlcvData.length || !candleSeries) return null;
  const curTime  = mainChart.timeScale().coordinateToTime(x);
  const curPrice = candleSeries.coordinateToPrice(y);
  if (curTime == null || curPrice == null) return null;
  // Binary search for the bar with time closest to curTime
  let lo = 0, hi = ohlcvData.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toTime(ohlcvData[mid].time) < curTime) lo = mid + 1;
    else hi = mid;
  }
  let bar = ohlcvData[lo];
  if (lo > 0) {
    const prev = ohlcvData[lo - 1];
    if (Math.abs(toTime(prev.time) - curTime) < Math.abs(toTime(bar.time) - curTime)) bar = prev;
  }
  const barX = mainChart.timeScale().timeToCoordinate(toTime(bar.time));
  if (barX == null || Math.abs(barX - x) > 50) return null;
  // Compare OHLC to cursor price numerically
  const prices = [bar.open, bar.high, bar.low, bar.close].filter(p => p != null);
  if (!prices.length) return null;
  const snapPrice = prices.reduce((best, p) =>
    Math.abs(p - curPrice) < Math.abs(best - curPrice) ? p : best, prices[0]);
  // Derive snapY from price scale ratio — avoids priceToCoordinate null issue
  const pRef = candleSeries.coordinateToPrice(y + 20);
  let snapY = y;
  if (pRef != null && pRef !== curPrice) {
    // 20 pixels → (curPrice - pRef) price units; so px per price = 20/(curPrice-pRef)
    snapY = y + (curPrice - snapPrice) * 20 / (curPrice - pRef);
  }
  // Only snap if close enough in Y (within 20px of nearest OHLC price)
  if (Math.abs(snapY - y) > 20) return null;
  return { x: barX, y: snapY, time: toTime(bar.time), price: snapPrice };
}

function screenToChart(x, y) {
  if (_magnetMode) {
    const snapped = _magnetSnap(x, y);
    if (snapped) return snapped;
  }
  const time  = _xToTime(x);
  const price = candleSeries?.coordinateToPrice(y);
  if (time == null || price == null) return null;
  return { x, y, time, price };
}

function chartToScreen(time, price) {
  const x = _timeToX(time);
  const y = candleSeries?.priceToCoordinate(price);
  return (x != null && y != null && isFinite(x) && isFinite(y)) ? { x, y } : null;
}

function eraseNear(x, y) {
  let best = 14, idx = -1;
  drawings.forEach((d, i) => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; idx = i; }
  });
  if (idx >= 0) { drawings.splice(idx, 1); _scheduleRenderDrawings(); }
}

function drawingDist(d, x, y) {
  if (d.type === "hline") {
    // 只在右側價格軸區域（x > 繪圖區寬）不攔截，讓 LWC 處理上下拖移；
    // 最新K棒右邊的空白處仍在繪圖區內 → 可正常命中 hline
    if (x > _plotW()) return Infinity;
    const py = candleSeries?.priceToCoordinate(d.price);
    return py != null ? Math.abs(py - y) : Infinity;
  }
  if (d.type === "vline") {
    const px = _timeToX(d.time);
    return px != null ? Math.abs(px - x) : Infinity;
  }
  if (d.type === "avwap") {
    // 命中判定：游標 x→時間→二分找曲線最近點,比 y 距離(O(log n),不掃全序列)
    const curve = _avwapCurve(d);
    if (!curve || !curve.length) return Infinity;
    const ct = _xToTime(x);
    if (ct == null || ct < curve[0].t) return Infinity;   // 錨點左側不命中
    let lo = 0, hi = curve.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (curve[mid].t < ct) lo = mid + 1; else hi = mid; }
    let pt = curve[lo];
    if (lo > 0 && Math.abs(curve[lo - 1].t - ct) < Math.abs(pt.t - ct)) pt = curve[lo - 1];
    if (pt.v == null) return Infinity;
    const py = candleSeries?.priceToCoordinate(pt.v);
    return py != null ? Math.abs(py - y) : Infinity;
  }
  if (d.type === "text" || d.type === "emoji") {
    const p = chartToScreen(d.time, d.price);
    if (!p) return Infinity;
    if (d.type === "emoji") {   // 依 emoji 方框判定,放大後整塊都點得到
      const h = _emojiSize(d) / 2;
      return Math.hypot(Math.max(Math.abs(x - p.x) - h, 0), Math.max(Math.abs(y - p.y) - h, 0));
    }
    return Math.hypot(p.x - x, p.y - y);
  }
  if ((d.type === "longpos" || d.type === "shortpos") && d.p1) {
    const W2 = _cssW();
    const startX = _timeToX(d.p1.time);
    if (startX == null) return Infinity;
    const visR  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const zw    = Math.max(20, Math.min(W2 * 0.4, Math.round(W2 * (d.barWidth ?? 3) / barsV)));
    const ex = startX, rx3 = Math.min(W2, ex + zw);
    if (x < ex - 10) return Infinity;
    if (x > rx3 + 20 && x < W2 - 100) return Infinity;
    const ey = candleSeries?.priceToCoordinate(d.p1.price);
    const ty = candleSeries?.priceToCoordinate(d.tp);
    const sy = candleSeries?.priceToCoordinate(d.sl);
    // inside the colored zone → always a hit
    if (ey != null && ty != null && sy != null) {
      const zTop = Math.min(ty, sy), zBot = Math.max(ty, sy);
      if (x >= ex && x <= rx3 && y >= zTop && y <= zBot) return 4;
    }
    const dists = [ey, ty, sy].filter(v => v != null).map(v => Math.abs(v - y));
    return dists.length ? Math.min(...dists) : Infinity;
  }
  if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    if (x < Math.min(a.x, b.x) - 10) return Infinity;
    const priceRange = d.p2.price - d.p1.price;
    const dists = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map(lvl => {
      const price = d.p1.price + priceRange * (1 - lvl);
      const ly = candleSeries?.priceToCoordinate(price);
      return ly != null ? Math.abs(ly - y) : Infinity;
    });
    return Math.min(...dists);
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

// 交易時段（用 K 棒的台灣時間 = toTime 已 +8h，UTC getter 即台北時）：
//   週一~五 8:00-12:00=台股、14:00-17:00=歐洲、20:00-23:00=美盤
const _SESSION_INTRADAY = ["1m", "5m", "15m", "30m", "1h", "2h"];
const _SESSION_COLOR = { asia: "rgba(66,133,244,0.10)", europe: "rgba(124,104,228,0.10)", us: "rgba(255,159,40,0.09)" };
const _SESSION_LINE  = { asia: "rgba(66,133,244,0.9)",  europe: "rgba(150,130,245,0.85)", us: "rgba(255,159,40,0.9)" };
const _SESSION_NAME  = { asia: "台股", europe: "歐洲", us: "美盤" };
const _WEEKDAY = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
// 開關（頂部按鈕；預設開）
let _sessionOn = (() => { try { return localStorage.getItem("sessionOverlay") !== "0"; } catch (e) { return true; } })();
// 時段/星期只取決於時間戳 → 記憶化（同一根 K 每幀被查多遍，避免每次都 new Date）。
// key 用原始 time 值；跨標的/重載皆有效（同時刻必同時段/星期），無需失效。
const _sessCache = new Map();
const _dayCache = new Map();
function _dayOf(t) {
  let v = _dayCache.get(t);
  if (v !== undefined) return v;
  v = new Date(toTime(t) * 1000).getUTCDay();   // toTime 已 +8h → UTC getter 得台北時間
  _dayCache.set(t, v);
  return v;
}
function _sessionOf(t) {
  let v = _sessCache.get(t);
  if (v !== undefined) return v;
  const d = new Date(toTime(t) * 1000);
  const day = d.getUTCDay();
  if (day < 1 || day > 5) v = null;        // 只標週一~週五
  else {
    const h = d.getUTCHours();
    v = (h >= 8 && h < 12) ? "asia"
      : (h >= 14 && h < 17) ? "europe"
      : (h >= 20 && h < 23) ? "us" : null;
  }
  _sessCache.set(t, v);
  return v;
}
// 交易時段區段快取：把整份 ohlcvData 切成連續同盤的「區段」並預存當盤高/低點。
// 過去每幀(平移/縮放)都對可見每根 K 重算高低 → 拉遠時上千根，是盤中滑動唯一重負載。
// 改成只在資料變動(長度/首尾時戳/時框)時算一次，每幀只做座標換算 → 滑動全程也能畫且不卡。
let _sessRuns = null, _sessRunsKey = "";
function _getSessionRuns() {
  const n = ohlcvData.length;
  const key = n + "|" + (n ? ohlcvData[0].time + "_" + ohlcvData[n - 1].time : "") + "|" + (typeof currentTF !== "undefined" ? currentTF : "");
  if (_sessRunsKey === key && _sessRuns) return _sessRuns;
  const runs = [];
  let s = -1, cur = null, hi = -Infinity, lo = Infinity;
  for (let i = 0; i < n; i++) {
    const sess = _sessionOf(ohlcvData[i].time);
    if (sess !== cur) {
      if (cur && s >= 0) runs.push({ s, e: i - 1, sess: cur, hi, lo });
      s = i; cur = sess; hi = -Infinity; lo = Infinity;
    }
    if (cur) { const b = ohlcvData[i]; if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  }
  if (cur && s >= 0) runs.push({ s, e: n - 1, sess: cur, hi, lo });
  _sessRuns = runs; _sessRunsKey = key;
  return runs;
}
// K 棒後方：①各交易時段淡色直條 ②各盤當盤高/低點虛線 ③星期標籤。只在日內時框、且開關開啟。
function _drawSessionOverlay(W, H) {
  // 星期標籤(③)永遠顯示——不受右上「交易時段」開關(_sessionOn)控制；
  // 僅色塊/高低線/開盤標記(①②④)受開關控制。兩者皆只在日內時框出現。
  if (!_SESSION_INTRADAY.includes(typeof currentTF !== "undefined" ? currentTF : "")) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData.length || typeof mainChart === "undefined") return;
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const _len = ohlcvData.length;
  const vFrom = Math.max(0, Math.floor(vr.from)), vTo = Math.min(_len - 1, Math.ceil(vr.to));
  if (vTo < vFrom) return;
  // 往兩側多算一段 buffer（涵蓋一個完整盤，最長 4h；5m=48 根）→ 邊緣盤的高低/標籤穩定，
  // 平移時不會因「最左根一直變」而閃。off-screen 的部分畫布會自然裁掉。
  const BUF = 64;
  const from = Math.max(0, vFrom - BUF);
  let to = Math.min(_len - 1, vTo + BUF);
  // 重播模式：ohlcvData 仍是全量、但圖上只到 replayIdx → 只算到「已揭曉」那根，
  // 不把未來棒算進來（否則當前盤 run 延到未來棒、其座標為 null，flush 會整塊畫不出；也避免用未來資料）。
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    to = Math.min(to, replayIdx);
  const half = (W / Math.max(1, vr.to - vr.from)) / 2;   // 半根 K 寬，讓條覆蓋到 K 邊緣
  // 裁切到繪圖區寬度（扣掉右側價格軸）→ 色塊/高低線/星期標籤平移到右側時不會蓋到右側價格軸
  let plotW = W;
  try {
    const tw = ts.width();
    if (tw > 0) plotW = tw;
    else { const pw = mainChart.priceScale("right").width(); if (pw > 0) plotW = W - pw; }
  } catch (e) {}
  // 繪圖區底（扣掉下方時間軸高）→ 直立線只畫到 K 棒區，不延伸進時間軸
  let plotBottom = H;
  try { const th = ts.height(); if (th > 0) plotBottom = H - th; } catch (e) {}
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  // ①②④ 色塊/高低線/開盤標記：受 _sessionOn 開關控制（星期標籤③在其後、不受控）。
  if (_sessionOn) {
  // 用預先算好的時段區段（含當盤高低）逐段畫 → 每幀只做座標換算，不再每根 K 重算高低。
  const runs = _getSessionRuns();
  for (const r of runs) {
    if (r.e < from || r.s > to) continue;       // 不在可見(+buffer)範圍 → 略過
    let endIdx = r.e, rHi = r.hi, rLo = r.lo;
    // 重播：區段若延伸到「尚未揭曉」的未來棒 → 只算到已揭曉那根（避免用未來資料/座標為 null）
    if (endIdx > to) {
      endIdx = to; rHi = -Infinity; rLo = Infinity;
      for (let i = r.s; i <= endIdx; i++) { const b = ohlcvData[i]; if (b.high > rHi) rHi = b.high; if (b.low < rLo) rLo = b.low; }
    }
    const x1 = ts.timeToCoordinate(toTime(ohlcvData[r.s].time));
    const x2 = ts.timeToCoordinate(toTime(ohlcvData[endIdx].time));
    if (x1 == null || x2 == null) continue;
    const L = x1 - half, R = x2 + half;
    const yH = candleSeries?.priceToCoordinate(rHi), yL = candleSeries?.priceToCoordinate(rLo);
    if (yH == null || yL == null) continue;
    // 色塊只填「當盤高點~低點」之間（上下緣＝高/低點，不上下無限延伸）
    drawCtx.fillStyle = _SESSION_COLOR[r.sess];
    drawCtx.fillRect(L, yH, R - L, yL - yH);
    // 上下緣畫線強調高/低點
    drawCtx.save();
    drawCtx.strokeStyle = _SESSION_LINE[r.sess]; drawCtx.lineWidth = 1;
    drawCtx.beginPath(); drawCtx.moveTo(L, yH); drawCtx.lineTo(R, yH); drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.moveTo(L, yL); drawCtx.lineTo(R, yL); drawCtx.stroke();
    drawCtx.restore();
  }

  // ④ 各盤「開盤」標記：該盤第一根 K（8:00台股 / 14:00歐洲 / 20:00美盤）一出現就標，
  //    不必等整盤收完。判定＝這根是某盤、且「真實前一根」不同盤（避免畫面左緣誤判開盤）。
  drawCtx.save();
  drawCtx.font = "bold 11px sans-serif"; drawCtx.textAlign = "left";
  for (let i = Math.max(1, from); i <= to; i++) {
    const sess = _sessionOf(ohlcvData[i].time);
    if (!sess || _sessionOf(ohlcvData[i - 1].time) === sess) continue;   // 非該盤、或不是開盤那根
    const x = ts.timeToCoordinate(toTime(ohlcvData[i].time));
    if (x == null || x < 0 || x > plotW) continue;
    const xL = x - half;
    drawCtx.strokeStyle = _SESSION_LINE[sess]; drawCtx.lineWidth = 1; drawCtx.globalAlpha = 0.45;
    drawCtx.beginPath(); drawCtx.moveTo(xL, 0); drawCtx.lineTo(xL, plotBottom); drawCtx.stroke();   // 開盤直線（止於時間軸上緣）
    drawCtx.globalAlpha = 1;
    drawCtx.fillStyle = _SESSION_LINE[sess];
    drawCtx.fillText(_SESSION_NAME[sess], xL + 3, 30);                                      // 盤名（星期列下方）
  }
  drawCtx.restore();
  }   // end if (_sessionOn) — 以下星期標籤永遠畫

  // ③ 星期標籤：日期變動的那根 K 棒上方標「週X」
  drawCtx.save();
  drawCtx.font = "bold 13px sans-serif"; drawCtx.fillStyle = "rgba(255,255,255,0.55)"; drawCtx.textAlign = "left";
  // prevDay 從可見範圍「前一根」起算 → 只在真正換日那根標籤（不會在最左根硬標、平移時閃）
  let prevDay = (from > 0) ? _dayOf(ohlcvData[from - 1].time) : -1;
  for (let i = from; i <= to; i++) {
    const day = _dayOf(ohlcvData[i].time);
    if (day !== prevDay) {
      prevDay = day;
      const x = ts.timeToCoordinate(toTime(ohlcvData[i].time));
      if (x != null && x >= 0 && x <= W) {
        if (i > from) { drawCtx.strokeStyle = "rgba(255,255,255,0.10)"; drawCtx.lineWidth = 1; drawCtx.setLineDash([2, 3]); drawCtx.beginPath(); drawCtx.moveTo(x - half, 0); drawCtx.lineTo(x - half, plotBottom); drawCtx.stroke(); drawCtx.setLineDash([]); }
        drawCtx.fillText(_WEEKDAY[day] || "", x - half + 4, 16);
      }
    }
  }
  drawCtx.restore();   // 星期標籤
  drawCtx.restore();   // 外層繪圖區裁切
}

// 成交量分佈圖（Volume Profile）：把成交量依價格分箱，畫出三條水平線——
//   上＝VAH(價值區高)、中＝POC(控制點/量最大價位)、下＝VAL(價值區低)。價值區＝累積 70% 量。
// 另有一條「可拖動的垂直截止線」：只統計線『左邊』的 K 棒（_vpCutTime；null＝統計到可見右緣）。
// 受 legVP 圖例開關控制（_vpOn）；只在 overlay 層畫、隨可見範圍/價軸由 renderDrawings 重算。
let _vpOn = (() => { try { return localStorage.getItem("vpProfile") !== "0"; } catch (e) { return true; } })();
let _vpCutTime  = null;   // 截止垂直線的圖表時間；null＝可見右緣(統計全部可見)。只統計此線左邊
let _vpDrag     = false;  // 是否正在拖動截止線
let _vpLineLastX = null;  // 上次畫線的 x（給滑鼠 hit-test 用；VP 關閉時為 null）
function _drawVolumeProfile(W, H) {
  _vpLineLastX = null;
  if (!_vpOn) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData.length || typeof mainChart === "undefined") return;
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const _len = ohlcvData.length;
  const from = Math.max(0, Math.floor(vr.from));
  let to     = Math.min(_len - 1, Math.ceil(vr.to));
  // 重播：只算到「已揭曉」那根，不用未來資料
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    to = Math.min(to, replayIdx);
  if (to < from) return;
  // 截止時間超出已載入資料(換標的/時框後殘留)→ 自動歸位到右緣
  if (_vpCutTime != null) {
    const t0 = toTime(ohlcvData[0].time), tN = toTime(ohlcvData[_len - 1].time);
    if (_vpCutTime < t0 || _vpCutTime > tN) _vpCutTime = null;
  }
  // 統計右界＝截止線那根（只算它左邊）；null＝可見右緣
  let hiIdx = to;
  if (_vpCutTime != null) {
    let c = to;
    while (c > from && toTime(ohlcvData[c].time) > _vpCutTime) c--;
    hiIdx = c;
  }
  // 截止線本身畫線用的時間：自定→該時間；否則可見右緣那根
  const lineTime = (_vpCutTime != null) ? _vpCutTime : toTime(ohlcvData[to].time);
  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  const xCut  = _timeToX(lineTime);
  const xEnd  = (xCut != null && xCut < plotW && xCut > 0) ? xCut : plotW;   // 三線右端止於截止線

  // ── 價量分佈三線：只統計 [from, hiIdx]（截止線左邊的可見 K）──
  if (hiIdx >= from) {
    let pHi = -Infinity, pLo = Infinity;
    for (let i = from; i <= hiIdx; i++) {
      const b = ohlcvData[i];
      if (b.high > pHi) pHi = b.high;
      if (b.low  < pLo) pLo = b.low;
    }
    if (isFinite(pHi) && isFinite(pLo) && pHi > pLo) {
      const BINS = 48;
      const binH = (pHi - pLo) / BINS;
      const vol  = new Float64Array(BINS);
      // 每根 K 的量平均分攤到它 low~high 覆蓋的價格箱（近似價量分佈）
      for (let i = from; i <= hiIdx; i++) {
        const b = ohlcvData[i];
        const v = +b.volume || 0;
        if (v <= 0) continue;
        let lo = Math.floor((b.low  - pLo) / binH);
        let hi = Math.floor((b.high - pLo) / binH);
        if (lo < 0) lo = 0;
        if (hi > BINS - 1) hi = BINS - 1;
        const share = v / (hi - lo + 1);
        for (let k = lo; k <= hi; k++) vol[k] += share;
      }
      let maxV = 0, pocIdx = 0, total = 0;
      for (let k = 0; k < BINS; k++) { total += vol[k]; if (vol[k] > maxV) { maxV = vol[k]; pocIdx = k; } }
      if (maxV > 0 && total > 0) {
        // 價值區（70% 量）：自 POC 往上下擴張，每次併入相鄰「量較大」的一側，直到 ≥70%
        let loK = pocIdx, hiK = pocIdx, acc = vol[pocIdx];
        const VA_TARGET = total * 0.7;
        while (acc < VA_TARGET && (loK > 0 || hiK < BINS - 1)) {
          const below = loK > 0        ? vol[loK - 1] : -1;
          const above = hiK < BINS - 1 ? vol[hiK + 1] : -1;
          if (above >= below) { hiK++; acc += Math.max(0, above); }
          else                { loK--; acc += Math.max(0, below); }
        }
        const pPOC = pLo + (pocIdx + 0.5) * binH;   // 中：POC
        const pVAH = pLo + (hiK + 1) * binH;         // 上：VAH
        const pVAL = pLo + loK * binH;               // 下：VAL
        drawCtx.save();
        drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
        drawCtx.font = "11px sans-serif"; drawCtx.textBaseline = "bottom"; drawCtx.textAlign = "right";
        const _vpLine = (price, color, label) => {
          const y = candleSeries?.priceToCoordinate(price);
          if (y == null) return;
          drawCtx.strokeStyle = color; drawCtx.lineWidth = 1; drawCtx.setLineDash([6, 4]);
          drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(xEnd, y); drawCtx.stroke();
          drawCtx.setLineDash([]);
          const tx = xEnd - 4;
          drawCtx.fillStyle = "rgba(0,0,0,0.55)"; drawCtx.lineWidth = 3; drawCtx.strokeStyle = "rgba(0,0,0,0.55)";
          drawCtx.strokeText(label, tx, y - 1);
          drawCtx.fillStyle = color; drawCtx.fillText(label, tx, y - 1);
        };
        _vpLine(pVAH, "rgba(120,170,255,0.9)",  "VAH 上");
        _vpLine(pPOC, "rgba(255,193,7,0.98)",   "POC 中");
        _vpLine(pVAL, "rgba(120,170,255,0.9)",  "VAL 下");
        drawCtx.restore();
      }
    }
  }

  // ── 截止垂直線（可拖動）：滑鼠靠近可左右拖 → 改變統計範圍 ──
  if (xCut != null && xCut >= 0 && xCut <= plotW) {
    let plotBottom = H;
    try { const th = ts.height(); if (th > 0) plotBottom = H - th; } catch (e) {}
    drawCtx.save();
    drawCtx.strokeStyle = _vpDrag ? "rgba(255,213,79,0.95)" : "rgba(255,213,79,0.65)";
    drawCtx.lineWidth = _vpDrag ? 2 : 1.5;
    drawCtx.beginPath(); drawCtx.moveTo(xCut, 0); drawCtx.lineTo(xCut, plotBottom); drawCtx.stroke();
    drawCtx.fillStyle = "rgba(255,213,79,0.9)";
    drawCtx.fillRect(xCut - 3, 0, 6, 10);                  // 頂端握把
    drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "top"; drawCtx.textAlign = "left";
    drawCtx.lineWidth = 3; drawCtx.strokeStyle = "rgba(0,0,0,0.55)";
    drawCtx.strokeText("量分佈←", xCut + 5, 2);
    drawCtx.fillStyle = "rgba(255,213,79,0.95)";
    drawCtx.fillText("量分佈←", xCut + 5, 2);
    drawCtx.restore();
    _vpLineLastX = xCut;
  }
}

// 頂部「交易時段」開關按鈕
function initSessionToggle() {
  const btn = document.getElementById("sessionToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _sessionOn);
    // 同步手機「設定」分頁列的狀態文字
    const st = document.getElementById("mSetSessionState");
    if (st) st.textContent = _sessionOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetSession");
    if (row) row.classList.toggle("m-set-on", _sessionOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    _sessionOn = !_sessionOn;
    try { localStorage.setItem("sessionOverlay", _sessionOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();
  });
}

// 右上「成交量分佈圖」開關按鈕（VAH/POC/VAL 三線 + 可拖動截止線）
function initVPToggle() {
  const btn = document.getElementById("vpToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _vpOn);
    const st = document.getElementById("mSetVPState");
    if (st) st.textContent = _vpOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetVP");
    if (row) row.classList.toggle("m-set-on", _vpOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    _vpOn = !_vpOn;
    try { localStorage.setItem("vpProfile", _vpOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();
  });
}

// 右上「SR+SMC 教練」疊加層總開關（階段1：掃頂/掃底；後續階段：BOS/CHoCH/OB/SR/通道/教練面板）
function initCoachToggle() {
  const btn = document.getElementById("coachToggleBtn");
  if (!btn) return;
  try { window._coachOn = localStorage.getItem("coachOverlay") === "1"; } catch (e) {}
  const _sync = () => {
    btn.classList.toggle("active", window._coachOn);
    const st = document.getElementById("mSetCoachState");
    if (st) st.textContent = window._coachOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetCoach");
    if (row) row.classList.toggle("m-set-on", window._coachOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    window._coachOn = !window._coachOn;
    try { localStorage.setItem("coachOverlay", window._coachOn ? "1" : "0"); } catch (e) {}
    // 開啟時請求瀏覽器通知權限（步驟前進鬧鐘用；此為使用者手勢，允許請求）
    try { if (window._coachOn && window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
    _sync();
    if (typeof _applyMainMarkers === "function") _applyMainMarkers();  // 立即顯示/隱藏教練標記(掃頂掃底)
    _scheduleRenderDrawings();                                          // 立即顯示/隱藏教練畫布層(BOS/CHoCH線)
    if (typeof _updateCoachPanel === "function") _updateCoachPanel();   // 立即顯示/隱藏教練面板
  });
}

// 右上「VWAP」獨立開關：與教練層解耦，資料仍來自勝率回應的 window._coachVWAP
function initVwapToggle() {
  const btn = document.getElementById("vwapToggleBtn");
  if (!btn) return;
  try { window._vwapOn = localStorage.getItem("vwapOverlay") === "1"; } catch (e) {}
  const _sync = () => {
    btn.classList.toggle("active", window._vwapOn);
    const st = document.getElementById("mSetVWAPState");
    if (st) st.textContent = window._vwapOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetVWAP");
    if (row) row.classList.toggle("m-set-on", window._vwapOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    window._vwapOn = !window._vwapOn;
    try { localStorage.setItem("vwapOverlay", window._vwapOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();   // 立即顯示/隱藏 VWAP 折線
  });
}
// 開關：window.toggleVWAP() 切換 VWAP 顯示（可帶布林值強制 on/off）
window.toggleVWAP = function (on) {
  window._vwapOn = (on === undefined) ? (window._vwapOn !== true) : !!on;
  try { localStorage.setItem("vwapOverlay", window._vwapOn ? "1" : "0"); } catch (e) {}
  const btn = document.getElementById("vwapToggleBtn");
  if (btn) btn.classList.toggle("active", window._vwapOn);
  const st = document.getElementById("mSetVWAPState");
  if (st) st.textContent = window._vwapOn ? "開啟" : "關閉";
  const row = document.getElementById("mSetVWAP");
  if (row) row.classList.toggle("m-set-on", window._vwapOn);
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return window._vwapOn;
};


// VWAP 成交量加權均價（黃折線）：獨立開關 _vwapOn；資料 window._coachVWAP（勝率回應每次刷新）。
function _drawVWAP(W, H) {
  if (window._vwapOn !== true) return;
  const vw = window._coachVWAP;
  if (!vw || !vw.length) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const ts = mainChart.timeScale();
  let plotW = W; try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}   // 裁掉右側價格軸
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  // 顏色可調（C.vwap，主圖指標設定裡設）：hex→套 0.45 透明度；已是 rgba/rgb 則原樣用
  const _vwCol = (typeof C !== "undefined" && C.vwap) ? C.vwap : "#ffc107";
  drawCtx.strokeStyle = /^#/.test(_vwCol) ? (typeof hexAlpha === "function" ? hexAlpha(_vwCol, 45) : _vwCol) : _vwCol;
  drawCtx.lineWidth = (typeof S !== "undefined" && S.vwapWidth) ? S.vwapWidth : 1;   // 可調粗細
  drawCtx.beginPath();
  let started = false;
  for (const pt of vw) {
    if (pt.v == null) { started = false; continue; }
    const t = toTime(pt.t);
    if (_rpCut != null && t > _rpCut) break;
    const x = _timeToX(t);
    if (x == null || x < -50 || x > plotW + 50) { started = false; continue; }
    const y = candleSeries.priceToCoordinate(pt.v);
    if (y == null) { started = false; continue; }
    if (!started) { drawCtx.moveTo(x, y); started = true; } else drawCtx.lineTo(x, y);
  }
  drawCtx.stroke();
  drawCtx.restore();
}

// 錨定 VWAP（AVWAP）：從錨點 d.time 那根起、往後逐根累積 (H+L+C)/3 × 量 / Σ量。
// 結果依 d.id 快取；資料筆數／最後一根／錨點任一變動才重算（避免每次 hover／重繪都掃全序列）。
// 整段皆無量的市場（少數指數）→退化為典型價累積平均，仍可畫出線。
const _avwapCache = new Map();
function _avwapCurve(d) {
  if (typeof ohlcvData === "undefined" || !ohlcvData || !ohlcvData.length) return null;
  const lastT = toTime(ohlcvData[ohlcvData.length - 1].time);
  const key = ohlcvData.length + ":" + lastT + ":" + d.time;
  const hit = _avwapCache.get(d.id);
  if (hit && hit.key === key) return hit.curve;
  let start = -1;
  for (let i = 0; i < ohlcvData.length; i++) {
    if (toTime(ohlcvData[i].time) >= d.time) { start = i; break; }   // 第一根 ≥ 錨點的 K 棒
  }
  let curve = null;
  if (start >= 0) {
    curve = [];
    let cumPV = 0, cumV = 0, cumTP = 0, n = 0;
    for (let i = start; i < ohlcvData.length; i++) {
      const b = ohlcvData[i];
      const tp = (b.high + b.low + b.close) / 3;    // 典型價
      const v = +b.volume || 0;
      cumTP += tp; n++;
      if (v > 0) { cumPV += tp * v; cumV += v; }
      curve.push({ t: toTime(b.time), v: cumV > 0 ? cumPV / cumV : (n > 0 ? cumTP / n : null) });
    }
  }
  _avwapCache.set(d.id, { key, curve });
  return curve;
}

// SR+SMC 教練疊加層繪製（階段2：BOS/CHoCH 結構破線段）。畫布在 K 棒之上、不限時框。
// 由後端 smc_struct 提供線段端點：t0=擺點K、t1=收破K、p=擺點價、k=事件型別。
const _COACH_STRUCT_STYLE = {
  bos_up:   { c: "#26a69a", dash: false, t: "BOS↑" },   // 多方延續
  choch_up: { c: "#26a69a", dash: true,  t: "CHoCH↑" }, // 轉多（虛線）
  bos_dn:   { c: "#ef5350", dash: false, t: "BOS↓" },   // 空方延續
  choch_dn: { c: "#ef5350", dash: true,  t: "CHoCH↓" }, // 轉空（虛線）
};
// 折價/溢價區（ICT/SMC dealing range）：以「畫面右緣那根」為當下，只用到它為止的 K 棒現算(非重繪、不看未來)。
//   捲到哪、右緣就是那個歷史時點→看到的是「當時」的折價/溢價。溢價=EQ→top(紅上)、折價=bot→EQ(綠下)、EQ=50%(黃虛)。
function _drawPDZones(W, H) {
  if (window._pdOn !== true) return;   // 預設關（使用者要求）；window.togglePDZones(true) 可重新開啟
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData || ohlcvData.length < 30) return;
  const ts = mainChart.timeScale();
  let plotW = W; try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  // 右緣可視時點＝「當下」。找到 ≤ 它的最後一根 → 只用 [0..E] 算(不看未來)
  let endT = null; try { const vr = ts.getVisibleRange(); if (vr && vr.to != null) endT = vr.to; } catch (e) {}
  const bars = ohlcvData; let E = bars.length - 1;
  if (endT != null) { for (let i = bars.length - 1; i >= 0; i--) { if (toTime(bars[i].time) <= endT) { E = i; break; } } }
  if (E < 20) return;
  const PL = 8;                                   // 半窗定擺動 pivot(j 於 i=j+PL 確認，只用 ≤i 資料)
  let sh = null, sl = null, cur = 0, rHi = null, rLo = null, legStart = 0;
  for (let i = 0; i <= E; i++) {
    const j = i - PL;
    if (j >= PL) {
      const hj = bars[j].high, lj = bars[j].low; let mh = true, ml = true;
      for (let k = j - PL; k <= j + PL; k++) { if (bars[k].high > hj) mh = false; if (bars[k].low < lj) ml = false; }
      if (mh) sh = hj; if (ml) sl = lj;
    }
    const c = bars[i].close;
    if (sh != null && c > sh) { if (cur !== 1) { rLo = sl; legStart = i; } cur = 1; }
    else if (sl != null && c < sl) { if (cur !== -1) { rHi = sh; legStart = i; } cur = -1; }
    if (cur === 1) rHi = (rHi == null) ? bars[i].high : Math.max(rHi, bars[i].high);
    else if (cur === -1) rLo = (rLo == null) ? bars[i].low : Math.min(rLo, bars[i].low);
  }
  if (rHi == null || rLo == null || rHi <= rLo) return;
  const eq = (rHi + rLo) / 2;
  const yTop = candleSeries.priceToCoordinate(rHi), yEq = candleSeries.priceToCoordinate(eq), yBot = candleSeries.priceToCoordinate(rLo);
  if (yTop == null || yEq == null || yBot == null) return;
  let x0 = _timeToX(toTime(bars[legStart].time)); if (x0 == null) x0 = 0; x0 = Math.max(0, Math.min(x0, plotW));
  const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(4);
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "middle";
  drawCtx.fillStyle = "rgba(239,83,80,0.07)"; drawCtx.fillRect(x0, yTop, plotW - x0, yEq - yTop);   // 溢價
  drawCtx.fillStyle = "rgba(38,166,154,0.07)"; drawCtx.fillRect(x0, yEq, plotW - x0, yBot - yEq);    // 折價
  drawCtx.lineWidth = 1;
  drawCtx.strokeStyle = "rgba(239,83,80,0.55)"; drawCtx.beginPath(); drawCtx.moveTo(x0, yTop); drawCtx.lineTo(plotW, yTop); drawCtx.stroke();
  drawCtx.strokeStyle = "rgba(38,166,154,0.55)"; drawCtx.beginPath(); drawCtx.moveTo(x0, yBot); drawCtx.lineTo(plotW, yBot); drawCtx.stroke();
  drawCtx.setLineDash([5, 4]); drawCtx.strokeStyle = "rgba(255,214,79,0.7)";
  drawCtx.beginPath(); drawCtx.moveTo(x0, yEq); drawCtx.lineTo(plotW, yEq); drawCtx.stroke(); drawCtx.setLineDash([]);
  drawCtx.fillStyle = "rgba(239,83,80,0.95)"; drawCtx.fillText("溢價 " + fmt(rHi), x0 + 4, yTop + 7);
  drawCtx.fillStyle = "rgba(255,214,79,0.98)"; drawCtx.fillText("EQ 50%", x0 + 4, yEq - 7);
  drawCtx.fillStyle = "rgba(38,166,154,0.95)"; drawCtx.fillText("折價 " + fmt(rLo), x0 + 4, yBot - 7);
  drawCtx.restore();
}
// 開關：window.togglePDZones() 切換折價/溢價區顯示（預設關）
window.togglePDZones = function (on) {
  window._pdOn = (on === undefined) ? (window._pdOn !== true) : !!on;
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return window._pdOn;
};

function _drawCoachOverlay(W, H) {
  if (!window._coachOn) return;
  const items = window._coachStructure;
  if (!items || !items.length) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const ts = mainChart.timeScale();
  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}   // 裁掉右側價格軸
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "middle";   // 精簡：非粗體
  // 視覺精簡：去重疊。_boxes 記已畫框價格範圍；新框與任一舊框重疊>80%→視為重複、不再畫(降雜亂)。
  const _boxes = [];
  const _overlapDup = (top, bot) => {
    const t = Math.max(top, bot), b = Math.min(top, bot), h = (t - b) || 1e-9;
    for (const q of _boxes) {
      const ov = Math.min(t, q.t) - Math.max(b, q.b);
      if (ov > 0 && ov / Math.min(h, (q.t - q.b) || 1e-9) > 0.8) return true;
    }
    _boxes.push({ t, b }); return false;
  };
  const _labels = [];   // 已放標籤 (x,y)：太近就不重複畫(避免疊字)
  const _labelDup = (x, y) => { for (const l of _labels) if (Math.abs(l.y - y) < 10 && Math.abs(l.x - x) < 60) return true; _labels.push({ x, y }); return false; };
  // 每類只畫離現價最近的 N 個區(遠方用不到→不畫，大幅減少全寬橫條)
  const _px = (typeof ohlcvData !== "undefined" && ohlcvData && ohlcvData.length) ? ohlcvData[ohlcvData.length - 1].close : null;
  const _nearest = (arr, n = 3) => {
    if (_px == null || !arr || arr.length <= n) return arr || [];
    return arr.map(z => [z, Math.abs((z.top + z.bot) / 2 - _px)]).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
  };
  // 共用：畫一個區框(SR/OB)。z={t0,t1,top,bot}；存活(t1=null)延伸到右緣，replay 裁切。
  const _zoneBox = (z, rgb, label) => {
    const t0 = toTime(z.t0);
    if (_rpCut != null && t0 > _rpCut) return;
    const x0 = _timeToX(t0);
    if (x0 == null) return;
    const t1eff = z.t1 ? toTime(z.t1) : null;          // 右端：失效→失效K；存活→右緣(replay到揭曉點)
    let xr;
    if (_rpCut != null && (t1eff == null || t1eff > _rpCut)) xr = _timeToX(_rpCut);
    else if (t1eff != null) xr = _timeToX(t1eff);
    else xr = plotW;
    if (xr == null) xr = plotW;
    if (xr < 0 || x0 > plotW) return;
    if (_overlapDup(z.top, z.bot)) return;             // 去重疊：與已畫框幾乎重合→略過
    const yT = candleSeries.priceToCoordinate(z.top), yB = candleSeries.priceToCoordinate(z.bot);
    if (yT == null || yB == null) return;
    const L = Math.max(x0, 0), R = Math.min(xr, plotW), tp = Math.min(yT, yB), hgt = Math.abs(yB - yT);
    if (R <= L) return;
    drawCtx.fillStyle = `rgba(${rgb},0.05)`;           // 精簡：降透明度
    drawCtx.fillRect(L, tp, R - L, hgt);
    drawCtx.strokeStyle = `rgba(${rgb},0.5)`; drawCtx.lineWidth = 0.8;   // 精簡：細線+降透明
    drawCtx.strokeRect(L, tp, R - L, hgt);
    if (!_labelDup(L, tp + 7)) {                        // 去重疊：標籤太近不重畫
      drawCtx.fillStyle = `rgba(${rgb},0.85)`;
      drawCtx.fillText(label, L + 3, tp + 7);
    }
  };
  // ⓪a HTF 投影區（1H/4H 的 OB/FVG/SR，像 TV 畫在低時框圖上）：從形成K往右延伸的盒子、虛線邊、左側標籤。
  const htf = window._coachHTF;
  if (htf && htf.length) {
    drawCtx.setLineDash([5, 4]);
    for (const z of _nearest(htf)) {                // 只畫離現價最近的幾個
      if (_overlapDup(z.top, z.bot)) continue;      // 去重疊：與已畫框幾乎重合→略過
      const yT = candleSeries.priceToCoordinate(z.top), yB = candleSeries.priceToCoordinate(z.bot);
      if (yT == null || yB == null) continue;
      let x0 = z.t0 ? _timeToX(toTime(z.t0)) : 0;
      if (x0 == null) x0 = 0;                       // 形成K在畫面外→從左緣起
      x0 = Math.max(0, Math.min(x0, plotW));
      const tp = Math.min(yT, yB), hgt = Math.max(1, Math.abs(yB - yT));
      const rgb = z.kind === "ob" ? (z.dir === "l" ? "33,150,243" : "255,152,0")
        : z.kind === "fvg" ? (z.dir === "l" ? "0,188,212" : "156,39,176")
        : (z.dir === "l" ? "38,166,154" : "239,83,80");   // sr
      drawCtx.fillStyle = `rgba(${rgb},0.045)`;     // 精簡：降透明度
      drawCtx.fillRect(x0, tp, plotW - x0, hgt);
      drawCtx.strokeStyle = `rgba(${rgb},0.5)`; drawCtx.lineWidth = 0.8;   // 精簡：細線+降透明
      drawCtx.strokeRect(x0, tp, plotW - x0, hgt);
      if (!_labelDup(x0, tp + 7)) {                 // 去重疊：標籤太近不重畫
        drawCtx.fillStyle = `rgba(${rgb},0.8)`;
        drawCtx.fillText(z.name, x0 + 3, tp + 7);
      }
    }
    drawCtx.setLineDash([]);
  }
  // ⓪ SR 支撐/阻力區（最底層）：阻力紅/支撐綠
  for (const z of _nearest(window._coachSR || [])) _zoneBox(z, z.d === "res" ? "239,83,80" : "38,166,154", z.d === "res" ? "阻力" : "支撐");
  // ① OB 訂單區框：多OB藍/空OB橘
  for (const z of _nearest(window._coachOB || [])) _zoneBox(z, z.d === "l" ? "33,150,243" : "255,152,0", z.d === "l" ? "多OB" : "空OB");
  // ② 平行通道：從「錨點K(t1)」沿斜率延伸到右緣（涵蓋範圍對齊 TV）。畫 當前TF通道 + 4H靛 + 1H青。
  const _drawChan = (c, rgb) => {
    if (!c || !c.t1) return;
    const cx1 = _timeToX(toTime(c.t1)), cx2 = _timeToX(toTime(c.t2));
    const yU1 = candleSeries.priceToCoordinate(c.up1), yU2 = candleSeries.priceToCoordinate(c.up2);
    const yL1 = candleSeries.priceToCoordinate(c.lo1), yL2 = candleSeries.priceToCoordinate(c.lo2);
    if (cx1 == null || cx2 == null || cx2 === cx1 || yU1 == null || yU2 == null || yL1 == null || yL2 == null) return;
    const _ext = (xa, ya, xb, yb, xt) => ya + (yb - ya) * (xt - xa) / (xb - xa);
    const xL = Math.max(0, cx1), xR = plotW;                 // 起點=錨點K（不再拉到最左）
    const yUL = _ext(cx1, yU1, cx2, yU2, xL), yUR = _ext(cx1, yU1, cx2, yU2, xR);
    const yLL = _ext(cx1, yL1, cx2, yL2, xL), yLR = _ext(cx1, yL1, cx2, yL2, xR);
    drawCtx.fillStyle = `rgba(${rgb},0.03)`;                              // 精簡：降透明度
    drawCtx.beginPath(); drawCtx.moveTo(xL, yUL); drawCtx.lineTo(xR, yUR); drawCtx.lineTo(xR, yLR); drawCtx.lineTo(xL, yLL); drawCtx.closePath(); drawCtx.fill();
    drawCtx.strokeStyle = `rgba(${rgb},0.6)`; drawCtx.lineWidth = 1;      // 精簡：細線+降透明
    drawCtx.beginPath(); drawCtx.moveTo(xL, yUL); drawCtx.lineTo(xR, yUR); drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.moveTo(xL, yLL); drawCtx.lineTo(xR, yLR); drawCtx.stroke();
  };
  for (const c of (window._coachHTFCh || [])) _drawChan(c, c.tf === "4H" ? "63,81,181" : "0,150,136");  // 4H靛 / 1H青
  _drawChan(window._coachChannel, window._coachChannel && window._coachChannel.dir === 1 ? "38,166,154" : "239,83,80");
  // ③ VWAP：改由獨立開關 _vwapOn 控制（_drawVWAP，不再綁教練層）
  // ④ BOS/CHoCH 結構破線段（精簡：整段調更淡）
  drawCtx.globalAlpha = 0.5;
  for (const it of items) {
    const st = _COACH_STRUCT_STYLE[it.k];
    if (!st) continue;
    const t1 = toTime(it.t1);
    if (_rpCut != null && t1 > _rpCut) continue;          // replay：未揭曉的不畫
    const x0 = _timeToX(toTime(it.t0)), x1 = _timeToX(t1);
    if (x0 == null || x1 == null) continue;
    if (x1 < 0 || x0 > plotW) continue;                   // 完全在畫面外→略過
    const y = candleSeries.priceToCoordinate(it.p);
    if (y == null) continue;
    drawCtx.strokeStyle = st.c; drawCtx.lineWidth = 1;    // 精簡：細線
    drawCtx.setLineDash(st.dash ? [4, 3] : []);
    drawCtx.beginPath(); drawCtx.moveTo(x0, y); drawCtx.lineTo(x1, y); drawCtx.stroke();
    drawCtx.setLineDash([]);
    if (!_labelDup(Math.min(x1 + 4, plotW), y)) {         // 去重疊：太近的結構標籤不重畫
      const tw = drawCtx.measureText(st.t).width;
      const lx = Math.min(x1 + 4, plotW - tw - 3);
      drawCtx.fillStyle = "rgba(0,0,0,0.4)";
      drawCtx.fillRect(lx - 2, y - 7, tw + 4, 14);
      drawCtx.fillStyle = st.c;
      drawCtx.fillText(st.t, lx, y + 0.5);
    }
  }
  drawCtx.globalAlpha = 1;
  // ⑤ 交易計畫線：僅 15m/5m 圖 + BOS 確認(stage≥5,由 _coachPlanByTf 篩)。進場區/止損/止盈1~4 畫成主圖水平價位線(最上層清楚)
  const _tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const plan = ((_tf === "15m" || _tf === "5m") && window._coachPlanByTf) ? window._coachPlanByTf[_tf] : null;
  if (plan) {
    drawCtx.font = "bold 10px sans-serif";
    const _hline = (price, rgb, label, dash) => {
      if (price == null) return;
      const y = candleSeries.priceToCoordinate(price);
      if (y == null) return;
      drawCtx.strokeStyle = `rgba(${rgb},0.95)`; drawCtx.lineWidth = 1.2;
      drawCtx.setLineDash(dash ? [6, 4] : []);
      drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(plotW, y); drawCtx.stroke();
      drawCtx.setLineDash([]);
      if (label) {
        const tw = drawCtx.measureText(label).width;
        const lx = plotW - tw - 7;
        drawCtx.fillStyle = "rgba(0,0,0,0.65)"; drawCtx.fillRect(lx - 3, y - 7, tw + 6, 14);
        drawCtx.fillStyle = `rgba(${rgb},1)`; drawCtx.fillText(label, lx, y + 0.5);
      }
    };
    if (plan.entry && plan.entry[0] != null) {          // 進場區(淡藍band + 上下虛線)
      const y0 = candleSeries.priceToCoordinate(plan.entry[0]), y1 = candleSeries.priceToCoordinate(plan.entry[1]);
      if (y0 != null && y1 != null) { drawCtx.fillStyle = "rgba(79,195,247,0.12)"; drawCtx.fillRect(0, Math.min(y0, y1), plotW, Math.abs(y1 - y0)); }
      _hline(plan.entry[0], "79,195,247", "進場", true);
      _hline(plan.entry[1], "79,195,247", "", true);
    }
    _hline(plan.sl, "239,83,80", "SL 止損");            // 止損(紅)
    const tps = plan.tps || (plan.tp != null ? [plan.tp] : []);
    tps.forEach((v, i) => _hline(v, "38,166,154", "TP" + (i + 1)));   // 止盈1~4(綠)
    drawCtx.font = "10px sans-serif";
  }
  drawCtx.restore();
}

// renderDrawings 合併排程：滑動時 subscribeVisibleTimeRangeChange / crosshairMove 一幀會觸發多次，
// 若每次都 _scheduleRenderDrawings() → 同一幀把疊加層(交易時段 overlay 等)重畫好幾遍。
// 用 pending 旗標收斂成「每幀最多畫一次」，盤中時框滑動大幅減負。
let _rdRafPending = false;
function _scheduleRenderDrawings() {
  if (_rdRafPending) return;
  _rdRafPending = true;
  requestAnimationFrame(() => {
    _rdRafPending = false;
    renderDrawings();
  });
}

// ── 軸變化追蹤（讓所有繪圖/overlay 精準跟隨價格軸縮放，不再「切時框後偏離原價位」）──
//   問題根源：overlay 只訂閱「可見時間範圍變化」，未訂閱「價格軸縮放」。切標的/時框後價軸
//     autoScale 到新範圍 + 還原視野需 ~220ms 才穩定；拖價格軸/滾輪縮放也會動價軸 → 這些
//     都不觸發時間範圍事件 → 線停在舊 y 座標＝偏離原價位。
//   解法：用「軸簽章」= 畫布頂/底對應的價格 + 可見邏輯範圍。在一段追蹤窗內每幀比對，一旦
//     簽章變(價/時軸任一被縮放/平移)就立即重繪 → 精準跟到落定的那一刻，非靠固定計時器猜。
//   省電：追蹤窗有時限、自動停（不常駐 rAF）；由「切換/拖軸/滾輪」等會動軸的事件觸發或延長。
let _axisSig = "";
let _axisWatchUntil = 0;
let _axisWatchRAF = 0;
function _axisSignature() {
  // 只看「價格軸」（畫布頂/底對應的價格）。時間軸的平移/縮放已由 subscribeVisibleTimeRangeChange
  // 處理 → 這裡不含時間，平移時簽章不變、看門狗不介入、零額外重繪（滑動保持順）。
  // 看門狗的唯一職責：抓「價格軸變動但時間沒變」的時點（切標的/時框的 autoScale 落定、拖價格軸）。
  try {
    if (!candleSeries) return "";
    const H = _cssH();
    const pTop = candleSeries.coordinateToPrice(0);
    const pBot = candleSeries.coordinateToPrice(H);
    return `${pTop}|${pBot}`;
  } catch (e) { return ""; }
}
function _axisWatchTick() {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (now > _axisWatchUntil) { _axisWatchRAF = 0; return; }   // 窗結束 → 停 rAF（省電）
  _axisWatchRAF = requestAnimationFrame(_axisWatchTick);
  const sig = _axisSignature();
  // 用 rAF 去重的排程重繪（非直接 renderDrawings）→ 與 LWC 可見範圍變化那條合併,每幀最多一次,
  // 避免平移/縮放時「每幀重繪兩次」拖慢滑動。
  if (sig && sig !== _axisSig) { _axisSig = sig; _scheduleRenderDrawings(); }
}
// 啟動/延長一段軸追蹤窗（ms）；期間任何價/時軸座標變化即重繪。會動軸的操作都呼叫它。
function _watchAxis(ms = 1500) {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  _axisWatchUntil = Math.max(_axisWatchUntil, now + ms);
  _axisSig = _axisSignature();
  if (!_axisWatchRAF) _axisWatchRAF = requestAnimationFrame(_axisWatchTick);
}

// 切標的/時框後：立即重繪一次(即時回饋) + 開一段較長追蹤窗涵蓋 autoScale/還原視野落定。
function _renderDrawingsAfterSettle() {
  _scheduleRenderDrawings();
  _watchAxis(1800);
}

function renderDrawings() {
  if (!drawCtx || !drawCanvas) return;
  // W/H 用 CSS 邏輯尺寸（backing store 是 device px，已由 setTransform(dpr) 縮放）
  const dpr = window.devicePixelRatio || 1;
  const W = drawCanvas.width / dpr, H = drawCanvas.height / dpr;
  drawCtx.clearRect(0, 0, W, H);

  // 現價標籤位置跟著價格軸縮放/平移/即時更新（renderDrawings 是 overlay 重畫的共同入口）
  if (typeof updateCurrentPriceLabel === "function") updateCurrentPriceLabel();

  // 成交量分佈圖（VPVR）：最底層先畫（避免蓋住時段高低線/繪圖/標記）；可開關
  _drawVolumeProfile(W, H);

  // 交易時段 overlay（背景帶=當盤高低範圍 + 上下緣高低線 + 星期標籤；可開關）
  _drawSessionOverlay(W, H);

  // 折價/溢價區（ICT/SMC dealing range：溢價紅上半、折價綠下半、EQ 50%線；開關 _pdOn 預設開）
  _drawPDZones(W, H);

  // SR+SMC 教練疊加層（階段2：BOS/CHoCH 結構破線段+標籤；全時框；右上開關 _coachOn）
  _drawCoachOverlay(W, H);

  // VWAP 成交量加權均價（黃折線；獨立開關 _vwapOn）
  _drawVWAP(W, H);

  // （策略方向標記 多/空·破多空·順多空 已改為 charts.js 的 series primitive，與 K 棒同步繪製、不再走 overlay → 縮放不游移）

  // Draw non-selected first, then hovered, then selected on top
  // 單一繪圖 render 丟例外時只跳過它、不拖垮整塊 overlay(catch 內補 restore 平衡 save 堆疊)。
  const _safeDraw = (d, hov, sel) => { try { drawOne(d, W, H, hov, sel); } catch (e) { try { drawCtx.restore(); } catch (_) {} } };
  drawings.filter(d => d.id !== selectedId && d.id !== hoveredId).forEach(d => _safeDraw(d, false, false));
  drawings.filter(d => d.id === hoveredId && d.id !== selectedId).forEach(d => _safeDraw(d, true, false));
  drawings.filter(d => d.id === selectedId).forEach(d => _safeDraw(d, false, true));

  // emoji 字形由 primitive 畫 → drawings 變動(建立/刪除/拖曳/縮放/選取)後通知它同步重畫
  if (typeof _emojiPrimUpdate === "function") _emojiPrimUpdate();

  // （策略棒止損線改由 realtime.js onMainCrosshair 用 LWC 原生 price line 畫，不再走 overlay）

  // Compute snapped cursor position when magnet is active
  let _cmx = _mx, _cmy = _my;
  if (_magnetMode && drawTool !== "pointer" && drawTool !== "crosshair" && drawTool !== "eraser") {
    const snp = _magnetSnap(_mx, _my);
    if (snp) { _cmx = snp.x; _cmy = snp.y; }
  }

  if (drawingWIP) {
    const p1s = chartToScreen(drawingWIP.p1.time, drawingWIP.p1.price);
    if (p1s) drawPreview(drawingWIP.type, p1s, { x:_cmx, y:_cmy }, W, H);
  }

  if (drawTool !== "pointer" && drawTool !== "crosshair") {
    drawCtx.save();
    drawCtx.strokeStyle = "rgba(200,200,200,0.22)";
    drawCtx.lineWidth = 1;
    drawCtx.setLineDash([4, 4]);
    drawCtx.beginPath();
    drawCtx.moveTo(_cmx, 0); drawCtx.lineTo(_cmx, H);
    drawCtx.moveTo(0, _cmy); drawCtx.lineTo(W, _cmy);
    drawCtx.stroke();
    drawCtx.restore();
    // Snap indicator circle
    if (_magnetMode && (_cmx !== _mx || _cmy !== _my)) {
      drawCtx.save();
      drawCtx.strokeStyle = "rgba(38,198,218,0.8)";
      drawCtx.lineWidth = 1.5;
      drawCtx.beginPath();
      drawCtx.arc(_cmx, _cmy, 5, 0, Math.PI * 2);
      drawCtx.stroke();
      drawCtx.restore();
    }
  }
}

// 自動盈虧比的 RR 數值：盒夠寬 → 置中盒內；縮小到盒太窄 → 移到盒旁並加深色底，
// 確保任何縮放都看得見（不必放大才顯示）。
function _drawRRLabel(ctx, txt, color, ex, rx, cy, W) {
  ctx.save();
  ctx.font = "bold 12px sans-serif";
  const tw = ctx.measureText(txt).width;
  const y = cy + 4;
  if (rx - ex > tw + 10) {
    ctx.fillStyle = color;
    ctx.fillText(txt, ex + (rx - ex - tw) / 2, y);
  } else {
    let x = rx + 5;                        // 預設放盒右側
    if (x + tw > W - 2) x = ex - tw - 5;   // 會超出右緣 → 改放盒左側
    if (x < 2) x = 2;                      // 仍超出 → 貼齊左緣
    ctx.fillStyle = "rgba(20,22,28,0.82)"; // 深色底襯，落在 K 棒上也清楚
    ctx.fillRect(x - 4, y - 12, tw + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }
  ctx.restore();
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
    const _hp = d.price;
    drawCtx.fillText(_hp >= 1000 ? _hp.toFixed(1) : _hp >= 10 ? _hp.toFixed(2) : _hp >= 1 ? _hp.toFixed(3) : _hp.toFixed(4), 5, y - 3);
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
    const x = _timeToX(d.time);
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
  else if (d.type === "avwap") {
    const curve = _avwapCurve(d);
    if (!curve || curve.length < 2) { drawCtx.restore(); return; }
    drawCtx.beginPath();
    let started = false, lastX = null, lastY = null;
    for (const pt of curve) {
      if (pt.v == null) { started = false; continue; }
      const px = _timeToX(pt.t);
      if (px == null || px < -50 || px > W + 50) { started = false; continue; }
      const py = candleSeries?.priceToCoordinate(pt.v);
      if (py == null) { started = false; continue; }
      if (!started) { drawCtx.moveTo(px, py); started = true; } else drawCtx.lineTo(px, py);
      lastX = px; lastY = py;
    }
    drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    // 錨點標記：倒三角落在起算那根上方
    const ax = _timeToX(curve[0].t), ay = candleSeries?.priceToCoordinate(curve[0].v);
    if (ax != null && ay != null) {
      drawCtx.beginPath();
      drawCtx.moveTo(ax, ay - 6); drawCtx.lineTo(ax - 4, ay - 12); drawCtx.lineTo(ax + 4, ay - 12);
      drawCtx.closePath(); drawCtx.fill();
      if (isSelected) {   // 選中→錨點加大控制點(可拖移改起算點)
        drawCtx.beginPath(); drawCtx.arc(ax, ay, 5, 0, Math.PI * 2); drawCtx.fill();
      }
    }
    if (lastX != null && lastY != null) {   // 末端標籤
      drawCtx.font = "10px monospace";
      drawCtx.fillText("AVWAP", Math.min(lastX + 5, W - 46), lastY - 4);
    }
  }
  else if (d.type === "trendline" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const hoverPart = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
      const r = isSelected ? (hoverPart === ep ? 7 : 5) : 3;
      drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
    });
  }
  else if (d.type === "ray" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) { drawCtx.restore(); return; }
    const t = dx > 0 ? (W - a.x) / dx : -a.x / dx;
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const hoverPartRay = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
      const r = isSelected ? (hoverPartRay === ep ? 7 : 5) : 3;
      drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
    });
  }
  else if (d.type === "arrow" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    // 主線 p1→p2
    drawCtx.lineCap = "round";
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    // 箭頭（尖端在 p2、朝 p1→p2 方向）
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const hl  = 12 + (d.width || DRAW_WIDTH) * 2;   // 箭頭邊長隨線寬
    const ha  = Math.PI / 7;                        // 箭頭張角
    drawCtx.beginPath();
    drawCtx.moveTo(b.x, b.y);
    drawCtx.lineTo(b.x - hl * Math.cos(ang - ha), b.y - hl * Math.sin(ang - ha));
    drawCtx.lineTo(b.x - hl * Math.cos(ang + ha), b.y - hl * Math.sin(ang + ha));
    drawCtx.closePath(); drawCtx.fill();            // 實心箭頭
    drawCtx.shadowBlur = 0;
    // 端點小圓點只在「選取時」當拖移把手顯示；平時箭頭乾淨、兩端不出現圓點。
    if (isSelected) {
      const hoverPartArr = _endpointHit(d, _mx, _my);
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, hoverPartArr === ep ? 7 : 5, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const priceRange = d.p2.price - d.p1.price;
    const xLeft  = Math.min(a.x, b.x);
    const xRight = Math.max(a.x, b.x);   // 線只畫到右端點，不再無限延伸到畫布右緣
    const _fibPriceFmt = p => p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4);
    // hex → rgba（線條／底色淡化用）
    const _fibRgba = (hex, al) => {
      const m = String(hex).match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
      return m ? `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${al})` : hex;
    };
    const _fibLevels = [[0,"#ef5350"],[0.236,"#ff9800"],[0.382,"#ffcc02"],[0.5,"#26a69a"],[0.618,"#26a69a"],[0.786,"#ff9800"],[1,"#ef5350"]];
    // 先算每層級的 y 座標
    const _fibYs = _fibLevels.map(([lvl, lcol]) => {
      const price = d.p1.price + priceRange * (1 - lvl);
      return { lvl, lcol, price, y: candleSeries?.priceToCoordinate(price) };
    });
    // ① 各層級之間填半透明底色（仿台歐美三盤），底色取下緣層級的色
    for (let i = 0; i < _fibYs.length - 1; i++) {
      const top = _fibYs[i], bot = _fibYs[i + 1];
      if (top.y == null || bot.y == null) continue;
      drawCtx.fillStyle = _fibRgba(bot.lcol, 0.04);
      drawCtx.fillRect(xLeft, top.y, xRight - xLeft, bot.y - top.y);
    }
    // ② 各層級線（色淡一些）＋ 右側標籤
    _fibYs.forEach(({ lvl, lcol, price, y }) => {
      if (y == null) return;
      const edge = (lvl === 0 || lvl === 1);
      drawCtx.strokeStyle = _fibRgba(lcol, edge ? 0.75 : 0.5);   // 線條淡化
      drawCtx.lineWidth = edge ? 1.5 : 1;
      drawCtx.setLineDash(edge ? [] : [5,3]);
      drawCtx.shadowBlur = isSelected ? 6 : 0; drawCtx.shadowColor = lcol;
      drawCtx.beginPath(); drawCtx.moveTo(xLeft, y); drawCtx.lineTo(xRight, y); drawCtx.stroke();
      drawCtx.setLineDash([]); drawCtx.shadowBlur = 0;
      drawCtx.font = "10px monospace"; drawCtx.fillStyle = _fibRgba(lcol, 0.85);
      const _fibTxt = `${(lvl*100).toFixed(1)}%  ${_fibPriceFmt(price)}`;
      // 預設標籤放右端點外側；若太靠畫布右緣會被裁切 → 改放右端點內側靠右對齊
      if (xRight + 90 > W) {
        drawCtx.textAlign = "right"; drawCtx.fillText(_fibTxt, xRight - 4, y - 3); drawCtx.textAlign = "left";
      } else {
        drawCtx.fillText(_fibTxt, xRight + 4, y - 3);
      }
    });
    // endpoint handles at p1 / p2
    if (isHovered || isSelected) {
      const hoverPartFib = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
      drawCtx.fillStyle = col;
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        const r = isSelected ? (hoverPartFib === ep ? 7 : 5) : 3;
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
      });
    }
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
  else if (d.type === "emoji") {
    const p = chartToScreen(d.time, d.price);
    if (!p) { drawCtx.restore(); return; }
    drawCtx.shadowBlur = 0;
    const sz = _emojiSize(d);
    // 字形平時由 charts.js 的 emoji primitive 畫(與 K 棒同步不游移)；只有「正在拖曳/縮放此 emoji」時
    // 由疊加層即時畫(primitive 會略過它)，避免拖曳慢一幀。
    const _dragging = (typeof dragState !== "undefined" && dragState && dragState.id === d.id);
    if (_dragging) {
      drawCtx.font = `${sz}px sans-serif`;
      drawCtx.textAlign = "center"; drawCtx.textBaseline = "middle";
      drawCtx.fillText(d.text || "❓", p.x, p.y);
      drawCtx.textAlign = "start"; drawCtx.textBaseline = "alphabetic";
    }
    if (isSelected) {   // 選中框 + 右下角縮放把手
      drawCtx.strokeStyle = "#2962ff"; drawCtx.lineWidth = 1; drawCtx.setLineDash([3,2]);
      drawCtx.strokeRect(p.x - sz/2 - 3, p.y - sz/2 - 3, sz + 6, sz + 6);
      drawCtx.setLineDash([]);
      drawCtx.fillStyle = "#2962ff";
      drawCtx.beginPath(); drawCtx.arc(p.x + sz/2 + 3, p.y + sz/2 + 3, 5, 0, Math.PI*2); drawCtx.fill();
    }
  }
  else if (d.type === "longpos" && d.p1) {
    const entryRefP = d.p1.price;
    const entryY = candleSeries?.priceToCoordinate(entryRefP);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);
    const slY    = candleSeries?.priceToCoordinate(d.sl);
    const startX = _timeToX(d.p1.time);
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

    // 水平線（ex → rx）：預估 TP 主線
    drawCtx.strokeStyle = "#26a69a";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();

    // 實際 TP（虛線，僅 _isAutoRR 且有 tpAct 才畫）
    let tpActY = null;
    if (d.tpAct != null) {
      tpActY = candleSeries?.priceToCoordinate(d.tpAct);
      if (tpActY != null) {
        drawCtx.save();
        drawCtx.strokeStyle = "rgba(38,166,154,0.8)";
        drawCtx.lineWidth = 1;
        drawCtx.setLineDash([5, 3]);
        drawCtx.beginPath(); drawCtx.moveTo(ex, tpActY); drawCtx.lineTo(rx, tpActY); drawCtx.stroke();
        drawCtx.setLineDash([]);
        drawCtx.restore();
      }
    }

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

    // R:R — 長單 reward = tp-entry、risk = entry-sl；正負號保留
    const refEntry = d.p1.price;
    const reward    = d.tp - refEntry;           // long: 正 = 對 / 負 = 反向（不利）
    const risk      = refEntry - d.sl;           // 預期為正
    const rrEst     = (risk !== 0) ? (reward / risk).toFixed(2) : "∞";
    const rewardAct = (d.tpAct != null) ? (d.tpAct - refEntry) : null;
    const rrAct     = (rewardAct != null && risk !== 0) ? (rewardAct / risk).toFixed(2) : null;
    const tpCY      = (tpY + entryY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt = (rrAct != null && d._isAutoRR)
      ? `預估 1:${rrEst}  ⇢  實際 1:${rrAct}`
      : `1 : ${rrEst}`;
    _drawRRLabel(drawCtx, rrTxt, (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)", ex, rx, tpCY, W);

    // 右側標籤
    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const entryLabel = `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(tpY,    tpLabel,    "rgba(38,166,154,0.9)", "#fff");
    if (tpActY != null) rightLabel(tpActY, `實際 ${_fmtPx(d.tpAct)}`, "rgba(38,166,154,0.55)", "#fff");
    rightLabel(entryY, entryLabel, "rgba(55,55,55,0.9)", "#ddd");
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,         "rgba(239,83,80,0.9)",  "#fff");

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
    const entryRefP = d.p1.price;
    const entryY = candleSeries?.priceToCoordinate(entryRefP);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);   // tp < entry → tpY > entryY
    const slY    = candleSeries?.priceToCoordinate(d.sl);   // sl > entry → slY < entryY
    const startX = _timeToX(d.p1.time);
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

    // 實際 TP（虛線；shortpos：tpAct 通常在 tp 上下方）
    let tpActY = null;
    if (d.tpAct != null) {
      tpActY = candleSeries?.priceToCoordinate(d.tpAct);
      if (tpActY != null) {
        drawCtx.save();
        drawCtx.strokeStyle = "rgba(38,166,154,0.8)";
        drawCtx.lineWidth = 1;
        drawCtx.setLineDash([5, 3]);
        drawCtx.beginPath(); drawCtx.moveTo(ex, tpActY); drawCtx.lineTo(rx, tpActY); drawCtx.stroke();
        drawCtx.setLineDash([]);
        drawCtx.restore();
      }
    }

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

    // R:R — 空單 reward = entry-tp、risk = sl-entry；正負號保留
    const refEntry = d.p1.price;
    const reward    = refEntry - d.tp;           // short: 正 = 對 / 負 = 反向
    const risk      = d.sl - refEntry;
    const rrEst     = (risk !== 0) ? (reward / risk).toFixed(2) : "∞";
    const rewardAct = (d.tpAct != null) ? (refEntry - d.tpAct) : null;
    const rrAct     = (rewardAct != null && risk !== 0) ? (rewardAct / risk).toFixed(2) : null;
    const tpCY      = (entryY + tpY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt = (rrAct != null && d._isAutoRR)
      ? `預估 1:${rrEst}  ⇢  實際 1:${rrAct}`
      : `1 : ${rrEst}`;
    _drawRRLabel(drawCtx, rrTxt, (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)", ex, rx, tpCY, W);

    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const entryLabel = `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,      "rgba(239,83,80,0.9)",  "#fff");
    rightLabel(entryY, entryLabel, "rgba(55,55,55,0.9)", "#ddd");
    rightLabel(tpY,    tpLabel,                    "rgba(38,166,154,0.9)", "#fff");
    if (tpActY != null) rightLabel(tpActY, `實際 ${_fmtPx(d.tpAct)}`, "rgba(38,166,154,0.55)", "#fff");

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

  if (type === "longpos" || type === "shortpos") {
    const mirrorY = 2 * a.y - b.y;
    const isLong  = type === "longpos";
    const tpY     = isLong ? Math.min(b.y, mirrorY) : Math.max(b.y, mirrorY);
    const slY     = isLong ? Math.max(b.y, mirrorY) : Math.min(b.y, mirrorY);
    const lineW   = Math.min(100, W - a.x);
    // 色塊
    drawCtx.fillStyle = "rgba(38,166,154,0.13)";
    drawCtx.fillRect(a.x, isLong ? tpY : a.y, lineW, isLong ? a.y - tpY : slY - a.y);
    drawCtx.fillStyle = "rgba(239,83,80,0.13)";
    drawCtx.fillRect(a.x, isLong ? a.y : tpY, lineW, isLong ? slY - a.y : a.y - tpY);
    // TP / Entry / SL 線
    [[isLong ? tpY : slY, "#26a69a"], [a.y, "rgba(255,255,255,0.7)"], [isLong ? slY : tpY, "#ef5350"]].forEach(([ly, lc]) => {
      drawCtx.strokeStyle = lc; drawCtx.lineWidth = 1; drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(a.x, ly); drawCtx.lineTo(a.x + lineW, ly); drawCtx.stroke();
    });
    drawCtx.restore();
    return;
  }

  drawCtx.strokeStyle = "rgba(255,255,255,0.55)";
  drawCtx.lineWidth   = 1;
  drawCtx.setLineDash([5, 4]);
  drawCtx.beginPath();
  if (type === "ray") {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) { drawCtx.restore(); return; }
    const t = dx > 0 ? (W - a.x) / dx : -a.x / dx;
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy);
  } else {
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y);
  }
  drawCtx.stroke();
  drawCtx.restore();
}

