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
  const data = { fvg, sweeps, events, ob: _computeOB(bars, fvg), model: _computeICT2022(bars, fvg, sweeps, events) };
  _ictCache = { key, data };
  return data;
}

// ── Order Block：位移(FVG)前最後一根「反向」K 棒；被回測(mitigated)前有效 ──
//   多方位移前的最後一根「陰線」= 多方 OB(支撐)；空方位移前的最後一根「陽線」= 空方 OB(壓力)
function _computeOB(bars, fvgs) {
  const out = [], seen = new Set();
  for (const f of fvgs) {
    let k = -1;
    for (let m = f.i - 1; m >= Math.max(0, f.i - 6); m--) {
      const up = bars[m].close >= bars[m].open;
      if ((f.dir === 1 && !up) || (f.dir === -1 && up)) { k = m; break; }
    }
    if (k < 0 || seen.has(k)) continue;
    seen.add(k);
    const o = { i: k, lo: bars[k].low, hi: bars[k].high, dir: f.dir, mit: false, mitIdx: bars.length - 1 };
    for (let j = k + 2; j < bars.length; j++) {                      // 價格回到 OB 區 = 已回測
      if ((f.dir === 1 && bars[j].low <= o.hi) || (f.dir === -1 && bars[j].high >= o.lo)) { o.mit = true; o.mitIdx = j; break; }
    }
    out.push(o);
  }
  return out;
}

// ── ICT 2022 模型：掃流動性 → 反向位移破結構(MSS) → 同段位移留 FVG → 回補進場 ──
//   止損放被掃端、目標打對向流動性(前低/前高)；記「進場是否觸發 + 先到TP或SL + 結束棒」。
//   框「循序長出」(同三盤框邏輯)：框從 FVG 起、隨 K 棒長到結束棒(打到TP/SL)或最新棒(尚未結束)，
//   不是「結束後才整塊冒出」。
function _computeICT2022(bars, fvgs, sweeps, events) {
  const GAP = 10, N = bars.length, out = [], seen = new Set();
  // 擺動高/低(W=3) — 找對向流動性目標(前低/前高)用
  const W = 3, swH = [], swL = [];
  for (let i = W; i < N - W; i++) {
    let isH = true, isL = true;
    for (let k = i - W; k <= i + W; k++) {
      if (bars[k].high > bars[i].high) isH = false;
      if (bars[k].low  < bars[i].low)  isL = false;
    }
    if (isH) swH.push({ idx: i, p: bars[i].high });
    if (isL) swL.push({ idx: i, p: bars[i].low });
  }
  for (const s of sweeps) {
    const j = s.idx;
    if (s.dir === "H") {                                  // 掃買方流動性(舊高) → 空單
      const mss = events.find(e => e.dir === -1 && e.idx > j && e.idx <= j + GAP); // 掃後向下破結構(MSS)
      if (!mss) continue;
      const f = fvgs.find(g => g.dir === -1 && g.i > j && g.i <= mss.idx + 1);      // FVG 須在「掃→MSS」同段位移
      if (!f || seen.has(f.i)) continue;
      let stop = bars[j].high;
      for (let k = j; k <= f.i; k++) stop = Math.max(stop, bars[k].high);           // 止損=被掃端最高
      const entry = (f.lo + f.hi) / 2, risk = stop - entry;
      if (risk <= 0) continue;
      let tgt = entry - risk * 2;                                                   // 預設 2R
      for (let m = swL.length - 1; m >= 0; m--)                                     // 對向流動性=下方最近前低(≥1R)
        if (swL[m].idx < f.i && swL[m].p <= entry - risk) { tgt = swL[m].p; break; }
      seen.add(f.i);
      out.push({ dir: -1, sweepIdx: j, mssIdx: mss.idx, fvg: f, entry, stop, target: tgt,
                 ..._ict22Outcome(bars, f.i, entry, stop, tgt, -1) });
    } else {                                              // 掃賣方流動性(舊低) → 多單
      const mss = events.find(e => e.dir === 1 && e.idx > j && e.idx <= j + GAP);
      if (!mss) continue;
      const f = fvgs.find(g => g.dir === 1 && g.i > j && g.i <= mss.idx + 1);
      if (!f || seen.has(f.i)) continue;
      let stop = bars[j].low;
      for (let k = j; k <= f.i; k++) stop = Math.min(stop, bars[k].low);
      const entry = (f.lo + f.hi) / 2, risk = entry - stop;
      if (risk <= 0) continue;
      let tgt = entry + risk * 2;
      for (let m = swH.length - 1; m >= 0; m--)
        if (swH[m].idx < f.i && swH[m].p >= entry + risk) { tgt = swH[m].p; break; }
      seen.add(f.i);
      out.push({ dir: 1, sweepIdx: j, mssIdx: mss.idx, fvg: f, entry, stop, target: tgt,
                 ..._ict22Outcome(bars, f.i, entry, stop, tgt, 1) });
    }
  }
  return out;
}

// 進場是否觸發 + 先到 TP 或 SL（框「循序長出」到結束棒；未結束→延到最新棒）
function _ict22Outcome(bars, fi, entry, stop, tgt, dir) {
  let entered = false;
  for (let k = fi + 1; k < bars.length; k++) {
    const b = bars[k];
    if (dir === -1) {                          // 空：價格回踩「上沿」進場(high≥entry)
      if (!entered && b.high >= entry) entered = true;
      if (entered) {
        if (b.high >= stop) return { entered, outcome: "loss", endIdx: k };
        if (b.low  <= tgt)  return { entered, outcome: "win",  endIdx: k };
      }
    } else {                                   // 多：價格回踩「下沿」進場(low≤entry)
      if (!entered && b.low <= entry) entered = true;
      if (entered) {
        if (b.low  <= stop) return { entered, outcome: "loss", endIdx: k };
        if (b.high >= tgt)  return { entered, outcome: "win",  endIdx: k };
      }
    }
  }
  return { entered, outcome: "open", endIdx: bars.length - 1 };
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

  // FVG：全部都畫。未填補→畫到右緣(明顯+框+標籤)；已填補→只畫到填補棒(淡、無框標)
  for (const f of d.fvg) {
    const yT = Y(f.hi), yB = Y(f.lo);
    if (yT == null || yB == null) continue;
    const x1 = X(f.i);
    let xa, xb;
    if (f.filled) {
      if (x1 == null) continue;                   // 已填補舊缺口：起點不在畫面就不畫
      const x2 = X(f.fillIdx); if (x2 == null || x2 <= x1) continue;
      xa = x1; xb = x2;
    } else {
      xa = (x1 == null) ? 0 : x1; xb = W;          // 未填補：延伸到右緣
      if (xb <= xa) continue;
    }
    const green = f.dir === 1;
    drawCtx.save();
    drawCtx.fillStyle = green ? `rgba(38,166,154,${f.filled ? 0.06 : 0.15})` : `rgba(239,83,80,${f.filled ? 0.06 : 0.15})`;
    drawCtx.fillRect(xa, yT, xb - xa, yB - yT);
    if (!f.filled) {
      drawCtx.strokeStyle = green ? "rgba(38,166,154,0.45)" : "rgba(239,83,80,0.45)";
      drawCtx.lineWidth = 1; drawCtx.strokeRect(xa, yT, xb - xa, yB - yT);
      drawCtx.fillStyle = green ? "rgba(38,166,154,0.85)" : "rgba(239,83,80,0.85)";
      drawCtx.font = "9px sans-serif"; drawCtx.fillText("FVG", xa + 2, (yT + yB) / 2 + 3);
    }
    drawCtx.restore();
  }

  // Order Block：未被回測的 OB（位移前的反向 K 棒）→ 紫框延伸到右緣
  for (const o of d.ob) {
    if (o.mit) continue;
    const yT = Y(o.hi), yB = Y(o.lo), x1 = X(o.i);
    if (yT == null || yB == null) continue;
    const xa = (x1 == null) ? 0 : x1;
    if (W <= xa) continue;
    drawCtx.save();
    drawCtx.fillStyle = "rgba(126,87,194,0.16)";
    drawCtx.fillRect(xa, yT, W - xa, yB - yT);
    drawCtx.strokeStyle = "rgba(149,117,205,0.6)"; drawCtx.lineWidth = 1;
    drawCtx.strokeRect(xa, yT, W - xa, yB - yT);
    drawCtx.fillStyle = "rgba(179,157,219,0.95)"; drawCtx.font = "9px sans-serif";
    drawCtx.fillText("OB", xa + 2, (yT + yB) / 2 + 3);
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

// ── ICT 2022 模型繪製：進場 FVG 框 + 止損/目標線 + 標籤 ──
//   框「循序長出」：xs=FVG 棒、xe=結束棒(打到TP/SL)或最新棒(進行中)；隨平移/新棒自然延伸。
//   配色＝結果：贏綠 ✓ / 輸紅 ✗ / 進行中琥珀。
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
    let xs = X(f.i), xe = X(m.endIdx);
    if (xs == null && xe == null) continue;
    if (xs == null) xs = 0;                          // 起點在左畫面外 → 裁到左緣(框仍延續)
    if (xe == null) xe = W;                          // 結束棒在右畫面外 → 延到右緣
    if (xe <= xs) xe = xs + 2;                       // 同棒結束 → 至少給一點寬
    const yS = Y(m.stop), yT = Y(m.target);
    const yTop = Y(f.hi), yBot = Y(f.lo);
    if (yS == null || yT == null || yTop == null || yBot == null) continue;
    const long = m.dir === 1;
    const win = m.outcome === "win", loss = m.outcome === "loss";
    drawCtx.save();
    // 進場 FVG 區（延伸到結束棒）
    drawCtx.fillStyle = (long ? "rgba(38,166,154," : "rgba(239,83,80,") + "0.18)";
    drawCtx.fillRect(xs, yTop, xe - xs, yBot - yTop);
    drawCtx.strokeStyle = long ? "#26a69a" : "#ef5350"; drawCtx.lineWidth = 1.2;
    drawCtx.strokeRect(xs, yTop, xe - xs, yBot - yTop);
    // 止損(紅) / 目標(綠) 水平線（延伸到結束棒）
    drawCtx.setLineDash([4, 3]); drawCtx.lineWidth = 1;
    drawCtx.strokeStyle = "rgba(239,83,80,0.85)";
    drawCtx.beginPath(); drawCtx.moveTo(xs, yS); drawCtx.lineTo(xe, yS); drawCtx.stroke();
    drawCtx.strokeStyle = "rgba(38,208,124,0.85)";
    drawCtx.beginPath(); drawCtx.moveTo(xs, yT); drawCtx.lineTo(xe, yT); drawCtx.stroke();
    drawCtx.setLineDash([]);
    // 標籤：方向（含結果色）
    drawCtx.fillStyle = win ? "#26d07c" : loss ? "#ef5350" : "#ffb74d";
    drawCtx.font = "bold 10px sans-serif";
    drawCtx.fillText((long ? "2022多" : "2022空") + (win ? " ✓" : loss ? " ✗" : ""), xs + 2, (yTop + yBot) / 2 + 3);
    drawCtx.fillStyle = "rgba(239,83,80,0.95)"; drawCtx.font = "8px sans-serif";
    drawCtx.fillText("SL", xe - 14, yS + (long ? 9 : -3));
    drawCtx.fillStyle = "rgba(38,208,124,0.95)";
    drawCtx.fillText("TP", xe - 14, yT + (long ? -3 : 9));
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
