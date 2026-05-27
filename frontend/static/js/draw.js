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

function findNearest(x, y, maxDist = 12) {
  let best = maxDist, found = null;
  drawings.forEach(d => {
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; found = d; }
  });
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

function renderDrawings() {
  if (!drawCtx || !drawCanvas) return;
  // W/H 用 CSS 邏輯尺寸（backing store 是 device px，已由 setTransform(dpr) 縮放）
  const dpr = window.devicePixelRatio || 1;
  const W = drawCanvas.width / dpr, H = drawCanvas.height / dpr;
  drawCtx.clearRect(0, 0, W, H);

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
    // 加碼後入場線改用均價（avgEntry）動態調整；綠/紅色塊以均價為界
    const entryRefP = (d._isAutoRR && !d._rrFixed && d.avgEntry != null) ? d.avgEntry : d.p1.price;
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

    // R:R — 用 avg_entry（含加碼）；長單 reward = tp-avg、risk = avg-sl；正負號保留
    const refEntry = (d._isAutoRR && !d._rrFixed && d.avgEntry != null) ? d.avgEntry : d.p1.price;
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
    const rrW   = drawCtx.measureText(rrTxt).width;
    drawCtx.fillStyle = (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)";
    if (rx - ex > rrW + 10) drawCtx.fillText(rrTxt, ex + (rx - ex - rrW) / 2, tpCY + 4);

    // 加碼點：在進場後出現的小圓點 + + 號
    if (d._isAutoRR && !d._rrFixed && d.pyramids && d.pyramids.length) {
      drawCtx.save();
      drawCtx.shadowBlur = 0;
      for (const p of d.pyramids) {
        const ppx = mainChart.timeScale().timeToCoordinate(p.time);
        const ppy = candleSeries?.priceToCoordinate(p.price);
        if (ppx == null || ppy == null) continue;
        drawCtx.fillStyle = "rgba(255,193,7,0.95)";
        drawCtx.beginPath(); drawCtx.arc(ppx, ppy, 5, 0, Math.PI*2); drawCtx.fill();
        drawCtx.fillStyle = "#1a1a1a";
        drawCtx.font = "bold 8px sans-serif";
        drawCtx.fillText("+", ppx - 2.5, ppy + 3);
      }
      drawCtx.restore();
      // 初始進場位（均價已成為主入場線）用小灰點標示，方便對照漂移
      if (d.avgEntry != null && d.avgEntry !== d.p1.price) {
        const initY = candleSeries?.priceToCoordinate(d.p1.price);
        if (initY != null && ex >= 0 && ex <= W) {
          drawCtx.save();
          drawCtx.fillStyle = "rgba(180,180,180,0.7)";
          drawCtx.beginPath(); drawCtx.arc(ex, initY, 3, 0, Math.PI*2); drawCtx.fill();
          drawCtx.restore();
        }
      }
    }

    // 右側標籤（入場線標籤：有加碼顯示「均」+均價，無加碼顯示原入場價）
    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const hasPyr  = d._isAutoRR && !d._rrFixed && d.pyramids && d.pyramids.length;
    const entryLabel = hasPyr
      ? `均 ${_fmtPx(entryRefP)}（+${d.pyramids.length}）`
      : `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(tpY,    tpLabel,    "rgba(38,166,154,0.9)", "#fff");
    if (tpActY != null) rightLabel(tpActY, `實際 ${_fmtPx(d.tpAct)}`, "rgba(38,166,154,0.55)", "#fff");
    rightLabel(entryY, entryLabel, hasPyr ? "rgba(255,193,7,0.9)" : "rgba(55,55,55,0.9)", hasPyr ? "#1a1a1a" : "#ddd");
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
    // 加碼後入場線改用均價動態調整
    const entryRefP = (d._isAutoRR && !d._rrFixed && d.avgEntry != null) ? d.avgEntry : d.p1.price;
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

    // R:R — 用 avg_entry（含加碼）；空單 reward = avg-tp、risk = sl-avg；正負號保留
    const refEntry = (d._isAutoRR && !d._rrFixed && d.avgEntry != null) ? d.avgEntry : d.p1.price;
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
    const rrW   = drawCtx.measureText(rrTxt).width;
    drawCtx.fillStyle = (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)";
    if (rx - ex > rrW + 10) drawCtx.fillText(rrTxt, ex + (rx - ex - rrW) / 2, tpCY + 4);

    // 加碼點 + 均減進場線
    if (d._isAutoRR && !d._rrFixed && d.pyramids && d.pyramids.length) {
      drawCtx.save();
      drawCtx.shadowBlur = 0;
      for (const p of d.pyramids) {
        const ppx = mainChart.timeScale().timeToCoordinate(p.time);
        const ppy = candleSeries?.priceToCoordinate(p.price);
        if (ppx == null || ppy == null) continue;
        drawCtx.fillStyle = "rgba(255,193,7,0.95)";
        drawCtx.beginPath(); drawCtx.arc(ppx, ppy, 5, 0, Math.PI*2); drawCtx.fill();
        drawCtx.fillStyle = "#1a1a1a";
        drawCtx.font = "bold 8px sans-serif";
        drawCtx.fillText("+", ppx - 2.5, ppy + 3);
      }
      drawCtx.restore();
      // 初始進場位用小灰點標示
      if (d.avgEntry != null && d.avgEntry !== d.p1.price) {
        const initY = candleSeries?.priceToCoordinate(d.p1.price);
        if (initY != null && ex >= 0 && ex <= W) {
          drawCtx.save();
          drawCtx.fillStyle = "rgba(180,180,180,0.7)";
          drawCtx.beginPath(); drawCtx.arc(ex, initY, 3, 0, Math.PI*2); drawCtx.fill();
          drawCtx.restore();
        }
      }
    }

    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const hasPyr  = d._isAutoRR && !d._rrFixed && d.pyramids && d.pyramids.length;
    const entryLabel = hasPyr
      ? `均 ${_fmtPx(entryRefP)}（+${d.pyramids.length}）`
      : `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,      "rgba(239,83,80,0.9)",  "#fff");
    rightLabel(entryY, entryLabel, hasPyr ? "rgba(255,193,7,0.9)" : "rgba(55,55,55,0.9)", hasPyr ? "#1a1a1a" : "#ddd");
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

/* ══════════════════════════════════════════
   顏色 / 樣式
══════════════════════════════════════════ */
// 將任意色強制轉為深色版本（保留色相＋飽和度，壓低亮度到 ~8% L）
// 這樣 picker 顯示原色，但實際套到圖表是低亮度版（保證天氣動畫看得見）
function _darkenForChart(hex) {
  const m = String(hex || "").match(/^#?([a-f\d]{6})$/i);
  if (!m) return hex;
  let r = parseInt(m[1].slice(0,2), 16) / 255;
  let g = parseInt(m[1].slice(2,4), 16) / 255;
  let b = parseInt(m[1].slice(4,6), 16) / 255;
  // RGB → HSL
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l_orig = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l_orig > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h /= 6;
  }
  // 比例縮放 + 軟上限：L 按 30% 縮放（保留同色相深淺差），但極亮的不超過 18%
  // 例：#FF0000(L=50%)→15%、#CC0000(L=40%)→12%、#660000(L=20%)→6%
  // 任何同色相不同深淺的色都會保留相對亮度差，不會被壓成同一個值
  const L = Math.min(l_orig * 0.30, 0.18);
  const S = s;                             // S 完全保留（hue 區辨力 +++）
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const R = hue2rgb(p, q, h + 1/3);
  const G = hue2rgb(p, q, h);
  const B = hue2rgb(p, q, h - 1/3);
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

// 主圖背景套用：picker 任何色都會經 _darkenForChart 強制變暗
// 三層 background：
//   ① 右上角 radial — 圓弧化拐角，視覺上「包覆」主圖右上
//   ② 右側水平淡入 var(--bg) 過渡到合約行情面板
//   ③ 上下垂直淡入 var(--bg)（user color 在中間）
function _applyChartBgGradient(color) {
  const pane = document.getElementById("mainPane");
  if (!pane) return;
  const _perf = document.documentElement.classList.contains("perf-mode");
  if (_perf) { pane.style.background = ""; return; }   // 極簡模式不上色，浮水印才看得到
  const dark = _darkenForChart(color);
  pane.style.background =
    `radial-gradient(circle 200px at 100% 0%, var(--bg) 0%, transparent 70%), ` +
    `linear-gradient(to right, transparent 0%, transparent 96%, var(--bg) 100%), ` +
    `linear-gradient(to bottom, var(--bg) 0%, ${dark} 6%, ${dark} 94%, var(--bg) 100%)`;
}

function applyAllColors() {
  // 極簡模式：背景強制純白、文字深色；不受 C.chartBg（使用者暗色設定）影響
  const _perf = document.documentElement.classList.contains("perf-mode");
  const bg = _perf ? "#FFFFFF" : (C.chartBg || C.bg);
  const _txt = _perf ? "#1F1F1F" : "#d1d4dc";
  // LWC canvas 保持透明，讓浮水印顯示在 K棒下方；背景色由 CSS 提供
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ layout: { background:{ color:"rgba(0,0,0,0)" }, textColor: _txt } })
  );
  // body / charts-container 維持 var(--bg)（CSS 預設），只有主圖 pane 套使用者色 + 漸層
  document.body.style.background = "";
  const _cc = document.querySelector(".charts-container");
  if (_cc) _cc.style.background = "";
  _applyChartBgGradient(bg);

  {
    const bodyUp   = S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)";
    const bodyDown = S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)";
    candleSeries.applyOptions({
      upColor: bodyUp, downColor: bodyDown,
      borderVisible: S.borderVisible !== false,
      borderUpColor: C.borderUp, borderDownColor: C.borderDown,
      wickVisible: S.wickVisible !== false,
      wickUpColor: C.wickUp, wickDownColor: C.wickDown,
    });
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
  if (!symbol) { btn.classList.remove("active", "starred"); return; }
  const key  = `${market}:${exchange}:${symbol}`;
  const inWl = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  btn.classList.toggle("active",  inWl);
  btn.classList.toggle("starred", inWl);
}

