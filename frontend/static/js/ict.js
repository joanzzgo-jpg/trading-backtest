/* ══════════════════════════════════════════════════════════════
   ICT 工具（Inner Circle Trader）：
     · FVG 失衡缺口（3 棒缺口，未填補者畫框）
     · 市場結構 BOS / CHoCH（收盤突破擺動高/低）
     · 流動性掃損（舊高/低被插破影線後收回 = stop hunt）
   全部前端從 ohlcvData 算、畫在 draw 畫布上（renderDrawings 呼叫，隨平移更新）。
   計算有快取（資料沒變不重算）。獨立開關鈕。
   ══════════════════════════════════════════════════════════════ */
let _ictOn = false;
let _ictCache = { key: "", data: null };

// 取（快取的）ICT 計算結果；資料長度或末棒時間變了才重算
function _ictData() {
  if (typeof ohlcvData === "undefined" || ohlcvData.length < 10) return null;
  const bars = ohlcvData;
  const key = bars.length + "|" + bars[bars.length - 1].time + "|" + bars[0].time;
  if (_ictCache.key === key && _ictCache.data) return _ictCache.data;
  const fvg = _computeFVG(bars), sweeps = _computeSweeps(bars), events = _computeStructure(bars);
  const data = { fvg, sweeps, events, model: _computeICT2022(bars, fvg, sweeps, events) };
  _ictCache = { key, data };
  return data;
}

// ── ICT 2022 模型：掃流動性 → 反向位移留 FVG → 回補 FVG 進場、止損放被掃端、目標打對向 ──
function _computeICT2022(bars, fvgs, sweeps, events) {
  const GAP = 8, LOOK = 20, out = [];
  for (const s of sweeps) {
    const j = s.idx;
    if (s.dir === "H") {                                  // 掃買方流動性(舊高) → 找空單
      const mss = events.some(e => e.dir === -1 && e.idx > j && e.idx <= j + GAP);  // 必須向下破結構
      if (!mss) continue;
      const f = fvgs.find(g => g.dir === -1 && g.i > j && g.i <= j + GAP);          // 位移段空方 FVG
      if (!f) continue;
      let stop = bars[j].high;
      for (let k = j; k <= f.i; k++) stop = Math.max(stop, bars[k].high);    // 止損=被掃端最高
      const entry = (f.lo + f.hi) / 2, risk = stop - entry;
      if (risk <= 0) continue;
      let tgt = entry - risk * 2, lowest = Infinity;                          // 預設 2R
      for (let k = Math.max(0, f.i - LOOK); k < f.i; k++) lowest = Math.min(lowest, bars[k].low);
      if (lowest < tgt) tgt = lowest;                                         // 對向流動性更遠就用它
      out.push({ dir: -1, sweepIdx: j, fvg: f, entry, stop, target: tgt });
    } else {                                              // 掃賣方流動性(舊低) → 找多單
      const mss = events.some(e => e.dir === 1 && e.idx > j && e.idx <= j + GAP); // 必須向上破結構
      if (!mss) continue;
      const f = fvgs.find(g => g.dir === 1 && g.i > j && g.i <= j + GAP);
      if (!f) continue;
      let stop = bars[j].low;
      for (let k = j; k <= f.i; k++) stop = Math.min(stop, bars[k].low);
      const entry = (f.lo + f.hi) / 2, risk = entry - stop;
      if (risk <= 0) continue;
      let tgt = entry + risk * 2, highest = -Infinity;
      for (let k = Math.max(0, f.i - LOOK); k < f.i; k++) highest = Math.max(highest, bars[k].high);
      if (highest > tgt) tgt = highest;
      out.push({ dir: 1, sweepIdx: j, fvg: f, entry, stop, target: tgt });
    }
  }
  return out;
}

// ── FVG（失衡缺口）：bullish = 前棒high < 後棒low；bearish = 前棒low > 後棒high ──
function _computeFVG(bars) {
  const out = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const a = bars[i - 1], c = bars[i + 1];
    if (a.high < c.low)      out.push({ i, lo: a.high, hi: c.low,  dir: 1 });   // 多方缺口
    else if (a.low > c.high) out.push({ i, lo: c.high, hi: a.low,  dir: -1 });  // 空方缺口
  }
  // 是否已被填補：之後有 K 棒價格回到缺口中點 → filled，記填補棒
  for (const f of out) {
    f.filled = false; f.fillIdx = bars.length - 1;
    const mid = (f.lo + f.hi) / 2;
    for (let j = f.i + 2; j < bars.length; j++) {
      if ((f.dir === 1 && bars[j].low <= mid) || (f.dir === -1 && bars[j].high >= mid)) {
        f.filled = true; f.fillIdx = j; break;
      }
    }
  }
  return out;
}

// ── 市場結構 BOS / CHoCH：收盤突破「最近確認的擺動高/低」 ──
function _computeStructure(bars) {
  const W = 2, sw = [];
  for (let i = W; i < bars.length - W; i++) {
    let isH = true, isL = true;
    for (let k = i - W; k <= i + W; k++) {
      if (bars[k].high > bars[i].high) isH = false;
      if (bars[k].low  < bars[i].low)  isL = false;
    }
    if (isH) sw.push({ idx: i, price: bars[i].high, type: "H" });
    if (isL) sw.push({ idx: i, price: bars[i].low,  type: "L" });
  }
  sw.sort((a, b) => a.idx - b.idx);
  const events = [];
  let activeHigh = null, activeLow = null, trend = 0, si = 0;
  for (let j = 0; j < bars.length; j++) {
    while (si < sw.length && sw[si].idx + W <= j) {            // 確認(右側W根)後才生效
      const s = sw[si++];
      if (s.type === "H") activeHigh = s; else activeLow = s;
    }
    const c = bars[j].close;
    if (activeHigh && c > activeHigh.price) {
      events.push({ idx: j, kind: trend === -1 ? "CHoCH" : "BOS", dir: 1, price: activeHigh.price, from: activeHigh.idx });
      trend = 1; activeHigh = null;
    } else if (activeLow && c < activeLow.price) {
      events.push({ idx: j, kind: trend === 1 ? "CHoCH" : "BOS", dir: -1, price: activeLow.price, from: activeLow.idx });
      trend = -1; activeLow = null;
    }
  }
  return events;
}

// ── 流動性掃損：擺動高被插破影線(high>舊高)但收回(close<舊高) = 掃買方流動性；反之掃賣方 ──
function _computeSweeps(bars) {
  const W = 3, out = [], LOOK = 60;
  for (let i = W; i < bars.length - W; i++) {
    let isH = true, isL = true;
    for (let k = i - W; k <= i + W; k++) {
      if (bars[k].high > bars[i].high) isH = false;
      if (bars[k].low  < bars[i].low)  isL = false;
    }
    if (isH) {
      for (let j = i + W + 1; j < bars.length && j < i + LOOK; j++) {
        if (bars[j].close > bars[i].high) break;                                   // 真突破→非掃損
        if (bars[j].high > bars[i].high && bars[j].close < bars[i].high) { out.push({ idx: j, price: bars[i].high, dir: "H" }); break; }
      }
    }
    if (isL) {
      for (let j = i + W + 1; j < bars.length && j < i + LOOK; j++) {
        if (bars[j].close < bars[i].low) break;
        if (bars[j].low < bars[i].low && bars[j].close > bars[i].low) { out.push({ idx: j, price: bars[i].low, dir: "L" }); break; }
      }
    }
  }
  return out;
}

// ── 繪製（由 renderDrawings 呼叫）──
function _drawICT(W, H) {
  if (!_ictOn) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const d = _ictData();
  if (!d) return;
  const bars = ohlcvData;
  const ts = mainChart.timeScale();
  const X = (idx) => ts.timeToCoordinate(toTime(bars[idx].time));
  const Y = (p) => candleSeries.priceToCoordinate(p);

  // FVG：畫全部未填補缺口（畫到填補棒或右緣）
  const openFvg = d.fvg.filter(f => !f.filled);
  for (const f of openFvg) {
    let x1 = X(f.i); const x2r = (f.fillIdx < bars.length - 1) ? X(f.fillIdx) : W;
    const yT = Y(f.hi), yB = Y(f.lo);
    if (yT == null || yB == null) continue;
    if (x1 == null) x1 = 0;                       // 起點在畫面外 → 從左緣畫
    const x2 = (x2r == null) ? W : x2r;
    if (x2 <= x1) continue;
    drawCtx.save();
    drawCtx.fillStyle = f.dir === 1 ? "rgba(38,166,154,0.13)" : "rgba(239,83,80,0.13)";
    drawCtx.fillRect(x1, yT, x2 - x1, yB - yT);
    drawCtx.strokeStyle = f.dir === 1 ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)";
    drawCtx.lineWidth = 1; drawCtx.strokeRect(x1, yT, x2 - x1, yB - yT);
    drawCtx.fillStyle = f.dir === 1 ? "rgba(38,166,154,0.85)" : "rgba(239,83,80,0.85)";
    drawCtx.font = "9px sans-serif"; drawCtx.fillText("FVG", x1 + 2, (yT + yB) / 2 + 3);
    drawCtx.restore();
  }

  // 市場結構 BOS / CHoCH：全部事件（從被破的擺動點畫水平線到突破棒 + 標籤）
  for (const e of d.events) {
    const xa = X(e.from), xb = X(e.idx), y = Y(e.price);
    if (y == null || (xa == null && xb == null)) continue;
    const x1 = (xa == null) ? 0 : xa, x2 = (xb == null) ? W : xb;
    const col = e.kind === "CHoCH" ? "#ffb74d" : (e.dir === 1 ? "#26a69a" : "#ef5350");
    drawCtx.save();
    drawCtx.strokeStyle = col; drawCtx.lineWidth = 1; drawCtx.setLineDash([3, 3]);
    drawCtx.beginPath(); drawCtx.moveTo(x1, y); drawCtx.lineTo(x2, y); drawCtx.stroke();
    drawCtx.setLineDash([]);
    drawCtx.fillStyle = col; drawCtx.font = "9px sans-serif";
    drawCtx.fillText(e.kind, x2 + 2, y + (e.dir === 1 ? -3 : 10));
    drawCtx.restore();
  }

  // 流動性掃損：全部（在掃損棒上/下畫小標記 + 細線到被掃價位）
  for (const s of d.sweeps) {
    const x = X(s.idx), y = Y(s.price);
    if (x == null || y == null) continue;
    const up = s.dir === "H";                      // 掃買方流動性(舊高) → 上方
    drawCtx.save();
    drawCtx.strokeStyle = "rgba(255,213,79,0.9)"; drawCtx.fillStyle = "rgba(255,213,79,0.95)";
    drawCtx.lineWidth = 1.2;
    drawCtx.beginPath(); drawCtx.moveTo(x - 4, y); drawCtx.lineTo(x + 4, y); drawCtx.stroke();   // 被掃價位短線
    drawCtx.font = "8px sans-serif";
    drawCtx.fillText("✗", x - 2, up ? y - 3 : y + 9);
    drawCtx.restore();
  }
}

// ── ICT 2022 模型繪製：進場 FVG 框 + 止損/目標線 + 標籤（只畫最近 ~5 個 setup）──
let _ict22On = false;
function _drawICT2022(W, H) {
  if (!_ict22On) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const d = _ictData();
  if (!d || !d.model) return;
  const bars = ohlcvData, ts = mainChart.timeScale();
  const X = (idx) => ts.timeToCoordinate(toTime(bars[idx].time));
  const Y = (p) => candleSeries.priceToCoordinate(p);
  for (const m of d.model) {
    const f = m.fvg;
    const xs = X(f.i); if (xs == null) continue;     // 起點在畫面外 → 不畫(避免擠在左緣畫錯位)
    const xEnd = Math.min(W, xs + 120);              // 線往右延伸一段
    const yE = Y(m.entry), yS = Y(m.stop), yT = Y(m.target);
    const yTop = Y(f.hi), yBot = Y(f.lo);
    if (yE == null || yS == null || yT == null) continue;
    const long = m.dir === 1;
    drawCtx.save();
    // 進場 FVG 區（較醒目）
    if (yTop != null && yBot != null) {
      drawCtx.fillStyle = long ? "rgba(38,166,154,0.22)" : "rgba(239,83,80,0.22)";
      drawCtx.fillRect(xs, yTop, xEnd - xs, yBot - yTop);
      drawCtx.strokeStyle = long ? "#26a69a" : "#ef5350"; drawCtx.lineWidth = 1.2;
      drawCtx.strokeRect(xs, yTop, xEnd - xs, yBot - yTop);
    }
    // 止損(紅) / 目標(綠) 水平線
    drawCtx.setLineDash([4, 3]); drawCtx.lineWidth = 1;
    drawCtx.strokeStyle = "rgba(239,83,80,0.9)";
    drawCtx.beginPath(); drawCtx.moveTo(xs, yS); drawCtx.lineTo(xEnd, yS); drawCtx.stroke();
    drawCtx.strokeStyle = "rgba(38,208,124,0.9)";
    drawCtx.beginPath(); drawCtx.moveTo(xs, yT); drawCtx.lineTo(xEnd, yT); drawCtx.stroke();
    drawCtx.setLineDash([]);
    // 標籤
    drawCtx.fillStyle = long ? "#26a69a" : "#ef5350"; drawCtx.font = "bold 10px sans-serif";
    drawCtx.fillText(long ? "2022多" : "2022空", xs + 2, (yTop + yBot) / 2 + 3);
    drawCtx.fillStyle = "rgba(239,83,80,0.95)"; drawCtx.font = "8px sans-serif";
    drawCtx.fillText("SL", xEnd - 14, yS + (long ? 9 : -3));
    drawCtx.fillStyle = "rgba(38,208,124,0.95)";
    drawCtx.fillText("TP", xEnd - 14, yT + (long ? -3 : 9));
    drawCtx.restore();
  }
}

function initICT2022() {
  const btn = document.getElementById("ict22ToggleBtn");
  if (!btn) return;
  try { _ict22On = localStorage.getItem("ict2022") === "1"; } catch (e) {}
  btn.classList.toggle("active", _ict22On);
  btn.addEventListener("click", () => {
    _ict22On = !_ict22On;
    try { localStorage.setItem("ict2022", _ict22On ? "1" : "0"); } catch (e) {}
    btn.classList.toggle("active", _ict22On);
    requestAnimationFrame(renderDrawings);
  });
}
window.initICT2022 = initICT2022;

function refreshICT() { _ictCache.key = ""; if (_ictOn || _ict22On) requestAnimationFrame(renderDrawings); }

function initICT() {
  const btn = document.getElementById("ictToggleBtn");
  if (!btn) return;
  try { _ictOn = localStorage.getItem("ictTools") === "1"; } catch (e) {}
  btn.classList.toggle("active", _ictOn);
  btn.addEventListener("click", () => {
    _ictOn = !_ictOn;
    try { localStorage.setItem("ictTools", _ictOn ? "1" : "0"); } catch (e) {}
    btn.classList.toggle("active", _ictOn);
    requestAnimationFrame(renderDrawings);
  });
}
window.initICT = initICT;
window.refreshICT = refreshICT;
