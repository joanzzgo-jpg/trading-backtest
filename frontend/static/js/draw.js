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

// canvas 的 CSS 邏輯寬/高（backing store 是 device px，要除以 dpr）
function _cssW() { return drawCanvas ? drawCanvas.width  / (window.devicePixelRatio || 1) : 800; }
function _cssH() { return drawCanvas ? drawCanvas.height / (window.devicePixelRatio || 1) : 600; }

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

/* 對 longpos/shortpos 判斷拖移的是哪一條線 */
function _drawingHitPart(d, x, y) {
  if (d.type !== "longpos" && d.type !== "shortpos") {
    const ep = _endpointHit(d, x, y);
    return ep || "move";
  }
  if (!d.p1) return "move";
  const ey = candleSeries?.priceToCoordinate(d.p1.price);
  const ty = candleSeries?.priceToCoordinate(d.tp);
  const sy = candleSeries?.priceToCoordinate(d.sl);
  // 左邊緣寬度把手優先偵測
  const ex = mainChart.timeScale().timeToCoordinate(d.p1.time);
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
      const near = findNearest(x, y, _magnetMode ? 20 : 12);
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
      if (hd) {
        const part = _drawingHitPart(hd, _mx, _my);
        if (part === "p1" || part === "p2") chartEl.style.cursor = "nwse-resize";
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
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
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
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
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
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    if (near) {
      // 單擊：只選取繪圖（顯示控制點），不自動開色盤——避免點到文字/盈虧比盒就跳調色盤
      // 改色請用右鍵 context menu 或 dblclick
      selectedId = near.id;
      e.stopPropagation();
      document.getElementById("cpPopup")?.classList.remove("open");
    } else {
      // 沒命中既有繪圖 → 試試點到訊號 K 棒 toggle 自動盈虧比
      const pt = screenToChart(x, y);
      if (pt && typeof _toggleAutoRR === "function" && _toggleAutoRR(pt.time)) {
        e.stopPropagation();
        return;
      }
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
    _showTextInput(e.clientX, e.clientY, txt => {
      if (txt?.trim()) {
        drawings.push({ id:_did(), type:"text", time:pt.time, price:pt.price, text:txt.trim(), color:_drawColor });
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
      const _ex1 = mainChart.timeScale().timeToCoordinate(drawingWIP.p1.time);
      const _ex2 = mainChart.timeScale().timeToCoordinate(pt.time);
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
      const _ex1s = mainChart.timeScale().timeToCoordinate(drawingWIP.p1.time);
      const _ex2s = mainChart.timeScale().timeToCoordinate(pt.time);
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
    requestAnimationFrame(renderDrawings);
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
    if (mainChart.timeScale().coordinateToTime(x) == null && x > _cssW() * 0.6) return Infinity;
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
    const W2 = _cssW();
    const startX = mainChart.timeScale().timeToCoordinate(d.p1.time);
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
const _SESSION_INTRADAY = ["5m", "15m", "30m", "1h", "2h"];
const _SESSION_COLOR = { asia: "rgba(66,133,244,0.10)", europe: "rgba(124,104,228,0.10)", us: "rgba(255,159,40,0.09)" };
const _SESSION_LINE  = { asia: "rgba(66,133,244,0.9)",  europe: "rgba(150,130,245,0.85)", us: "rgba(255,159,40,0.9)" };
const _SESSION_NAME  = { asia: "台股", europe: "歐洲", us: "美盤" };
const _WEEKDAY = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
// 開關（頂部按鈕；預設開）
let _sessionOn = (() => { try { return localStorage.getItem("sessionOverlay") !== "0"; } catch (e) { return true; } })();
function _sessionOf(t) {
  const d = new Date(toTime(t) * 1000);   // toTime 已 +8h → 用 UTC getter 得台北時間
  const day = d.getUTCDay();
  if (day < 1 || day > 5) return null;     // 只標週一~週五
  const h = d.getUTCHours();
  if (h >= 8  && h < 12) return "asia";
  if (h >= 14 && h < 17) return "europe";
  if (h >= 20 && h < 23) return "us";
  return null;
}
// K 棒後方：①各交易時段淡色直條 ②各盤當盤高/低點虛線 ③星期標籤。只在日內時框、且開關開啟。
function _drawSessionOverlay(W, H) {
  if (!_sessionOn) return;
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
  const from = Math.max(0, vFrom - BUF), to = Math.min(_len - 1, vTo + BUF);
  const half = (W / Math.max(1, vr.to - vr.from)) / 2;   // 半根 K 寬，讓條覆蓋到 K 邊緣
  // 裁切到繪圖區寬度（扣掉右側價格軸）→ 色塊/高低線/星期標籤平移到右側時不會蓋到右側價格軸
  let plotW = W;
  try {
    const tw = ts.width();
    if (tw > 0) plotW = tw;
    else { const pw = mainChart.priceScale("right").width(); if (pw > 0) plotW = W - pw; }
  } catch (e) {}
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  let runStart = -1, runSess = null;
  const flush = (endIdx) => {
    if (!runSess || runStart < 0) return;
    const x1 = ts.timeToCoordinate(toTime(ohlcvData[runStart].time));
    const x2 = ts.timeToCoordinate(toTime(ohlcvData[endIdx].time));
    if (x1 == null || x2 == null) return;
    const L = x1 - half, R = x2 + half;
    // 當盤高/低點
    let hi = -Infinity, lo = Infinity;
    for (let i = runStart; i <= endIdx; i++) { const b = ohlcvData[i]; if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    const yH = candleSeries?.priceToCoordinate(hi), yL = candleSeries?.priceToCoordinate(lo);
    if (yH == null || yL == null) return;
    // 色塊只填「當盤高點~低點」之間（上下緣＝高/低點，不上下無限延伸）
    drawCtx.fillStyle = _SESSION_COLOR[runSess];
    drawCtx.fillRect(L, yH, R - L, yL - yH);
    // 上下緣畫線強調高/低點
    drawCtx.save();
    drawCtx.strokeStyle = _SESSION_LINE[runSess]; drawCtx.lineWidth = 1;
    drawCtx.beginPath(); drawCtx.moveTo(L, yH); drawCtx.lineTo(R, yH); drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.moveTo(L, yL); drawCtx.lineTo(R, yL); drawCtx.stroke();
    drawCtx.restore();
  };
  for (let i = from; i <= to; i++) {
    const sess = _sessionOf(ohlcvData[i].time);
    if (sess !== runSess) { flush(i - 1); runStart = i; runSess = sess; }
  }
  flush(to);

  // ③ 星期標籤：日期變動的那根 K 棒上方標「週X」
  drawCtx.save();
  drawCtx.font = "bold 13px sans-serif"; drawCtx.fillStyle = "rgba(255,255,255,0.55)"; drawCtx.textAlign = "left";
  // prevDay 從可見範圍「前一根」起算 → 只在真正換日那根標籤（不會在最左根硬標、平移時閃）
  let prevDay = (from > 0) ? new Date(toTime(ohlcvData[from - 1].time) * 1000).getUTCDay() : -1;
  for (let i = from; i <= to; i++) {
    const day = new Date(toTime(ohlcvData[i].time) * 1000).getUTCDay();
    if (day !== prevDay) {
      prevDay = day;
      const x = ts.timeToCoordinate(toTime(ohlcvData[i].time));
      if (x != null && x >= 0 && x <= W) {
        if (i > from) { drawCtx.strokeStyle = "rgba(255,255,255,0.10)"; drawCtx.lineWidth = 1; drawCtx.setLineDash([2, 3]); drawCtx.beginPath(); drawCtx.moveTo(x - half, 0); drawCtx.lineTo(x - half, H); drawCtx.stroke(); drawCtx.setLineDash([]); }
        drawCtx.fillText(_WEEKDAY[day] || "", x - half + 4, 16);
      }
    }
  }
  drawCtx.restore();   // 星期標籤
  drawCtx.restore();   // 外層繪圖區裁切
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
    requestAnimationFrame(renderDrawings);
  });
}

/* ══════════════════════════════════════════════════════════════
   支撐壓力（SnR）：擺動高/低點(局部峰谷) → 群聚成水平線
   研究顯示：訊號貼著 SnR 勝率/中位R 明顯較高（沒貼的中位 −0.2R）。
   ══════════════════════════════════════════════════════════════ */
let _snrOn = false;
let _snrLines = [];               // candleSeries.createPriceLine 物件
const _SNR_W = 3;                 // 擺動視窗（左右各 N 根）
const _SNR_CLUSTER = 0.004;       // 價格相近 0.4% 內視為同一條
const _SNR_MAX = 14;              // 最多畫幾條（取觸碰數最強）

function _clearSnR() {
  if (typeof candleSeries === "undefined" || !candleSeries) { _snrLines = []; return; }
  for (const l of _snrLines) { try { candleSeries.removePriceLine(l); } catch (e) {} }
  _snrLines = [];
}

function _computeSnR(bars) {
  // 用「收盤價」找擺動點（影線多為插針/掃損雜訊，收盤才是真正被接受/拒絕的價位）
  const W = _SNR_W, n = bars.length, hi = [], lo = [];
  for (let i = W; i < n - W; i++) {
    let isH = true, isL = true;
    for (let k = i - W; k <= i + W; k++) {
      if (bars[k].close > bars[i].close) isH = false;
      if (bars[k].close < bars[i].close) isL = false;
    }
    if (isH) hi.push(bars[i].close);
    if (isL) lo.push(bars[i].close);
  }
  const levels = hi.concat(lo).sort((a, b) => a - b);
  const clusters = [];
  for (const p of levels) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(p - last.sum / last.n) / p < _SNR_CLUSTER) { last.sum += p; last.n++; }
    else clusters.push({ sum: p, n: 1 });
  }
  let strong = clusters.filter(c => c.n >= 2);     // ≥2 次觸碰＝較有效
  if (strong.length < 4) strong = clusters.slice(); // 太少就全放
  strong.sort((a, b) => b.n - a.n);
  return strong.slice(0, _SNR_MAX).map(c => ({ price: c.sum / c.n, touches: c.n }));
}

// 主要擺動點（大視窗 MW，左右各 MW 根都沒超過）→ 前高/前低與趨勢線用
const _SNR_MW = 8;
// startIdx/endIdx 可限定掃描範圍（趨勢線用「可見右緣」當 endIdx → 回看當時樣子）。
// swing 需左右各 MW 根才確認，故 i 只到 endIdx-MW（右緣當下還沒成形的不算）。
function _majorSwings(bars, MW, startIdx, endIdx) {
  const highs = [], lows = [], n = bars.length;
  const s = Math.max(MW, startIdx == null ? MW : startIdx);
  const e = (endIdx == null ? n - 1 : Math.min(n - 1, endIdx)) - MW;
  for (let i = s; i <= e; i++) {
    let isH = true, isL = true;
    for (let k = i - MW; k <= i + MW; k++) {
      if (bars[k].close > bars[i].close) isH = false;   // 收盤價基準
      if (bars[k].close < bars[i].close) isL = false;
    }
    if (isH) highs.push({ i, price: bars[i].close });
    if (isL) lows.push({ i, price: bars[i].close });
  }
  return { highs, lows };
}

function _drawSnR() {
  _clearSnR();
  if (!_snrOn) return;
  if (typeof candleSeries === "undefined" || !candleSeries) return;
  if (typeof ohlcvData === "undefined" || ohlcvData.length < 2 * _SNR_W + 5) return;
  const bars = ohlcvData;
  const lastClose = bars[bars.length - 1].close;
  for (const lv of _computeSnR(bars)) {
    const isRes = lv.price >= lastClose;            // 在現價上方＝壓力，下方＝支撐
    try {
      _snrLines.push(candleSeries.createPriceLine({
        price: lv.price,
        color: isRes ? "rgba(239,83,80,0.62)" : "rgba(38,166,154,0.62)",
        lineWidth: Math.min(3, lv.touches),
        lineStyle: 2,                               // 虛線
        axisLabelVisible: true,
        title: (isRes ? "壓" : "撐") + (lv.touches >= 3 ? "×" + lv.touches : ""),
      }));
    } catch (e) {}
  }
  // 前高/前低：最近的「主要」擺動高/低（大視窗）→ 粗實線、明確標籤
  const ms = _majorSwings(bars, _SNR_MW);
  if (ms.highs.length) {
    const h = ms.highs[ms.highs.length - 1].price;
    try { _snrLines.push(candleSeries.createPriceLine({ price: h, color: "rgba(239,83,80,0.95)", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "前高" })); } catch (e) {}
  }
  if (ms.lows.length) {
    const l = ms.lows[ms.lows.length - 1].price;
    try { _snrLines.push(candleSeries.createPriceLine({ price: l, color: "rgba(38,166,154,0.95)", lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "前低" })); } catch (e) {}
  }
}

// 趨勢線（斜線）：畫在 draw 畫布上，由 renderDrawings 呼叫（隨平移/縮放重畫）。
// 支撐線＝最近兩個遞增的主要低點；壓力線＝最近兩個遞減的主要高點。各向右延伸。
function _drawSnRTrendlines(W, H) {
  if (!_snrOn) return;
  if (typeof ohlcvData === "undefined" || ohlcvData.length < 2 * _SNR_MW + 5) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const bars = ohlcvData;
  const ts = mainChart.timeScale();
  // 只用「可見右緣」以前的 K 棒算擺動點 → 向左捲動＝回到當時、新棒尚未出現時的趨勢線
  let rightIdx = bars.length - 1;
  const vr = ts.getVisibleLogicalRange();
  if (vr) rightIdx = Math.max(0, Math.min(bars.length - 1, Math.floor(vr.to)));
  const ms = _majorSwings(bars, _SNR_MW, rightIdx - 300, rightIdx);   // 近300根內找趨勢結構
  const proj = (pt) => {
    const x = ts.timeToCoordinate(toTime(bars[pt.i].time));
    const y = candleSeries.priceToCoordinate(pt.price);
    return (x == null || y == null) ? null : { x, y };
  };
  const drawTL = (a, b, color) => {
    const pa = proj(a), pb = proj(b);
    if (!pa || !pb || pb.x === pa.x) return;
    const m = (pb.y - pa.y) / (pb.x - pa.x);
    const yEnd = pb.y + m * (W - pb.x);            // 向右延伸到圖右緣
    drawCtx.save();
    drawCtx.strokeStyle = color; drawCtx.lineWidth = 1.4; drawCtx.setLineDash([6, 4]);
    drawCtx.beginPath(); drawCtx.moveTo(pa.x, pa.y); drawCtx.lineTo(W, yEnd); drawCtx.stroke();
    drawCtx.restore();
  };
  const lows = ms.lows, highs = ms.highs;
  if (lows.length >= 2) {
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    if (b.price > a.price) drawTL(a, b, "rgba(38,166,154,0.9)");   // 上升支撐
  }
  if (highs.length >= 2) {
    const a = highs[highs.length - 2], b = highs[highs.length - 1];
    if (b.price < a.price) drawTL(a, b, "rgba(239,83,80,0.9)");    // 下降壓力
  }
}
function refreshSnR() {                               // 換標的/時框後由 renderAll 呼叫重畫
  if (!_snrOn) return;
  _drawSnR();
  requestAnimationFrame(renderDrawings);             // 趨勢線（畫布）也重畫
}

function initSnR() {
  const btn = document.getElementById("snrToggleBtn");
  if (!btn) return;
  try { _snrOn = localStorage.getItem("snrLevels") === "1"; } catch (e) {}
  btn.classList.toggle("active", _snrOn);
  if (_snrOn) _drawSnR();
  btn.addEventListener("click", () => {
    _snrOn = !_snrOn;
    try { localStorage.setItem("snrLevels", _snrOn ? "1" : "0"); } catch (e) {}
    btn.classList.toggle("active", _snrOn);
    _drawSnR();
    requestAnimationFrame(renderDrawings);           // 趨勢線（畫布）開關時立即重畫
  });
}
window.initSnR = initSnR;
window.refreshSnR = refreshSnR;

function renderDrawings() {
  if (!drawCtx || !drawCanvas) return;
  // W/H 用 CSS 邏輯尺寸（backing store 是 device px，已由 setTransform(dpr) 縮放）
  const dpr = window.devicePixelRatio || 1;
  const W = drawCanvas.width / dpr, H = drawCanvas.height / dpr;
  drawCtx.clearRect(0, 0, W, H);

  // 交易時段 overlay（背景帶=當盤高低範圍 + 上下緣高低線 + 星期標籤；可開關）
  _drawSessionOverlay(W, H);

  // SnR 趨勢線（斜線：上升支撐 / 下降壓力；水平 S/R 與前高前低走 createPriceLine）
  if (typeof _drawSnRTrendlines === "function") _drawSnRTrendlines(W, H);

  // Draw non-selected first, then hovered, then selected on top
  drawings.filter(d => d.id !== selectedId && d.id !== hoveredId).forEach(d => drawOne(d, W, H, false, false));
  drawings.filter(d => d.id === hoveredId && d.id !== selectedId).forEach(d => drawOne(d, W, H, true, false));
  drawings.filter(d => d.id === selectedId).forEach(d => drawOne(d, W, H, false, true));

  // 點擊訊號 K 棒展開的自動盈虧比盒（由 winrate.js 提供）
  if (typeof _renderAutoRRBoxes === "function") _renderAutoRRBoxes(W, H);

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
  else if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const priceRange = d.p2.price - d.p1.price;
    const xLeft = Math.min(a.x, b.x);
    const _fibPriceFmt = p => p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4);
    [[0,"#ef5350"],[0.236,"#ff9800"],[0.382,"#ffcc02"],[0.5,"#26a69a"],[0.618,"#26a69a"],[0.786,"#ff9800"],[1,"#ef5350"]].forEach(([lvl, lcol]) => {
      const price = d.p1.price + priceRange * (1 - lvl);
      const y = candleSeries?.priceToCoordinate(price);
      if (y == null) return;
      drawCtx.strokeStyle = lcol; drawCtx.lineWidth = (lvl===0||lvl===1) ? 1.5 : 1;
      drawCtx.setLineDash((lvl===0||lvl===1) ? [] : [5,3]);
      drawCtx.shadowBlur = isSelected ? 6 : 0; drawCtx.shadowColor = lcol;
      drawCtx.beginPath(); drawCtx.moveTo(xLeft, y); drawCtx.lineTo(W, y); drawCtx.stroke();
      drawCtx.setLineDash([]); drawCtx.shadowBlur = 0;
      drawCtx.font = "10px monospace"; drawCtx.fillStyle = lcol;
      drawCtx.fillText(`${(lvl*100).toFixed(1)}%  ${_fibPriceFmt(price)}`, W - 88, y - 3);
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
  else if (d.type === "longpos" && d.p1) {
    const entryRefP = d.p1.price;
    const entryY = candleSeries?.priceToCoordinate(entryRefP);
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

