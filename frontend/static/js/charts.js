function makeBaseOpts(scaleMargins = null, showTime = false) {
  // 極簡模式用亮色系，其他維持原本暗色
  const _perf = document.documentElement.classList.contains("perf-mode");
  // 軸刻度數字（右側價格軸／底部時間軸）調淡一些，降低存在感
  const _txt  = _perf ? "rgba(42,38,32,0.55)" : "rgba(209,212,220,0.55)";
  const _grd  = _perf ? "#ECECEC" : "#2a2e39";
  const _cx   = _perf ? "#9C9C9C" : "#758696";
  const _brd  = _perf ? "#D9D9D9" : "#2a2e39";
  const _lbg  = _perf ? "#F5F5F5" : "#2a2e39";
  // 圖表背景維持透明，由 body 的純白底襯出（讓浮水印也能透過 -1 z-index 顯現）
  const opts = {
    layout:    { background:{ color: "rgba(0,0,0,0)" }, textColor: _txt },
    grid:      { vertLines:{ color: _grd }, horzLines:{ color: _grd } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { style: 3, width: 1, color: _cx, labelBackgroundColor: _lbg },
      horzLine: { style: 3, width: 1, color: _cx, labelBackgroundColor: _lbg },
    },
    rightPriceScale: { borderColor: _brd, minimumWidth: 80 },
    timeScale: {
      borderColor: _brd,
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

/* ── 建立 / 重建主圖 series ── */
function createCandleSeries() {
  if (candleSeries) { try { mainChart.removeSeries(candleSeries); } catch {} candleSeries = null; }
  latestPriceLine = null;
  candleSeries = mainChart.addCandlestickSeries({
    upColor:   S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)",
    downColor: S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)",
    borderVisible:   S.borderVisible !== false,
    borderUpColor:   C.borderUp,   borderDownColor: C.borderDown,
    wickVisible:     S.wickVisible  !== false,
    wickUpColor:     C.wickUp,      wickDownColor:   C.wickDown,
    priceLineVisible: false, lastValueVisible: false,
  });
  // FVG 失衡缺口色塊（自訂 primitive）：蠟燭重建時一併重掛，沿用全域 _fvgZones
  try {
    _fvgPrimitive = _makeFVGPrimitive();
    candleSeries.attachPrimitive(_fvgPrimitive);
    _fvgTLPrim = _makeFVGTradeLinePrimitive();       // FVG 逐筆止損/止盈價位線
    candleSeries.attachPrimitive(_fvgTLPrim);
  } catch (e) { /* 舊版 LWC 無 attachPrimitive 時靜默略過 */ }
}

/* ── FVG 失衡缺口：在主圖蠟燭上畫半透明色塊（青=多頭/支撐、紅=空頭/壓力）── */
let _fvgZones = [];        // [{t1, t2|null, top, bot, d}]（已轉成圖表時間）
let _fvgPrimitive = null;
let _fvgShow = true;
let _fvgLevelsShow = true;   // FVG 交易位階線主開關（預設開＝允許顯示，但只畫「被點選」那個缺口）
let _fvgSelected = null;     // 目前點選的缺口（只有它畫止損/止盈線；null＝全部隱藏）
let _fvgMinW = 0;            // FVG 最小寬度%（使用者自定）：寬度 < 此值的缺口不畫（純顯示過濾，不影響策略）
function _makeFVGPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!_fvgShow || !_fvgZones.length || !_chart || !_series) return;
      const ts = _chart.timeScale();
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        const wpx = scope.mediaSize.width;
        for (const z of _fvgZones) {
          // 使用者自定最小寬度過濾：寬度% = 多(top−bot)/bot、空(top−bot)/top（對齊標籤定義）
          if (_fvgMinW > 0) {
            const _zw = (z.d === "l" ? (z.top - z.bot) / z.bot : (z.top - z.bot) / z.top) * 100;
            if (_zw < _fvgMinW) continue;
          }
          const x1 = ts.timeToCoordinate(z.t1);
          if (x1 == null) continue;
          let x2 = (z.t2 != null) ? ts.timeToCoordinate(z.t2) : null;
          if (x2 == null) x2 = wpx;                      // 未填補 → 延伸到右緣
          if (x2 <= x1) x2 = x1 + 1;
          const yT = _series.priceToCoordinate(z.top);
          const yB = _series.priceToCoordinate(z.bot);
          if (yT == null || yB == null) continue;
          const bx = x1 * hr, bw = (x2 - x1) * hr;
          const byTop = Math.min(yT, yB) * vr, bh = Math.abs(yB - yT) * vr;
          const _faint = z.dim || z.used === false;      // dim=同向堆疊去重；used===false=未被任何標記用到 → 皆淡化
          if (_faint) ctx.globalAlpha = 0.38;
          ctx.fillStyle   = z.d === "l" ? "rgba(38,198,166,0.14)" : "rgba(255,82,82,0.14)";
          ctx.strokeStyle = z.d === "l" ? "rgba(38,198,166,0.55)" : "rgba(255,82,82,0.55)";
          ctx.fillRect(bx, byTop, bw, bh);
          ctx.lineWidth = Math.max(1, hr);
          ctx.setLineDash([4 * hr, 3 * hr]);
          ctx.strokeRect(bx, byTop, bw, bh);
          ctx.setLineDash([]);
          // 寬度% 標籤：多=（top−bot)/bot、空=(top−bot)/top（對齊後端 _gw 定義）；畫在盒左緣、垂直置中
          const _pct = z.d === "l" ? (z.top - z.bot) / z.bot : (z.top - z.bot) / z.top;
          if (_pct > 0) {
            const _lbl = (z.inv ? "i " : "") + (_pct * 100).toFixed(2) + "%";   // IFVG 前綴 i
            ctx.font = `${Math.round(10 * vr)}px sans-serif`;
            ctx.textBaseline = "middle"; ctx.textAlign = "left";
            const _ty = byTop + bh / 2;
            // 細盒(高度<字高)→ 標到盒上方，避免疊在邊框上看不清
            const _yy = bh >= 12 * vr ? _ty : byTop - 7 * vr;
            ctx.fillStyle = "rgba(0,0,0,0.55)";                 // 描黑底邊，淺色背景也看得見
            ctx.lineWidth = Math.max(2, 2 * hr); ctx.strokeStyle = "rgba(0,0,0,0.55)";
            ctx.strokeText(_lbl, bx + 3 * hr, _yy);
            ctx.fillStyle = z.d === "l" ? "rgba(120,255,225,0.98)" : "rgba(255,150,150,0.98)";
            ctx.fillText(_lbl, bx + 3 * hr, _yy);
          }
          // 進場標記（常駐）：改為「每被突破一次就標一點」——pens=每次往區間更深處突破點(封頂/封底於邊緣)。
          //   每個突破點畫一個淡黃菱形；不再標上/中/下字。
          for (const _e of (z.pens || [])) {
            if (_e == null || _e.t == null || _e.p == null) continue;
            const ex = ts.timeToCoordinate(_e.t), eyP = _series.priceToCoordinate(_e.p);
            if (ex == null || eyP == null) continue;
            const px = ex * hr, py = eyP * vr, r = 4 * vr;
            ctx.beginPath();
            ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
            ctx.fillStyle = "rgba(255,245,160,0.95)";       // 淡黃菱形
            ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = Math.max(1, hr);
            ctx.fill(); ctx.stroke();
          }
          // 交易位階線：止盈(綠=2W)、止損(紅=g-1頂端)，沿盒寬 x1→x2 畫水平虛線。
          //   預設隱藏（缺口太多會洗版）→ 只有「被點選」的缺口才畫，避免主圖滿屏線。
          if (_fvgLevelsShow && z === _fvgSelected) {
            ctx.lineWidth = Math.max(1, hr);
            ctx.setLineDash([5 * hr, 4 * hr]);
            if (z.tp != null) {
              const yTP = _series.priceToCoordinate(z.tp);
              if (yTP != null) {
                ctx.strokeStyle = "rgba(38,198,166,0.8)";
                ctx.beginPath(); ctx.moveTo(bx, yTP * vr); ctx.lineTo(bx + bw, yTP * vr); ctx.stroke();
              }
            }
            if (z.sl != null) {
              const ySL = _series.priceToCoordinate(z.sl);
              if (ySL != null) {
                ctx.strokeStyle = "rgba(239,83,80,0.8)";
                ctx.beginPath(); ctx.moveTo(bx, ySL * vr); ctx.lineTo(bx + bw, ySL * vr); ctx.stroke();
              }
            }
            ctx.setLineDash([]);
          }
          if (_faint) ctx.globalAlpha = 1;               // 復原 alpha，不影響下一個缺口
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) {
      _chart = p.chart; _series = p.series; _req = p.requestUpdate;
      // 點選缺口 → 只顯示它的止損/止盈線；再點同一個或點空白 → 取消。
      try {
        _chart.subscribeClick(param => {
          if (!param || !param.point || param.time == null) { _fvgSelected = null; if (_req) _req(); return; }
          const price = _series.coordinateToPrice(param.point.y);
          if (price == null) { _fvgSelected = null; if (_req) _req(); return; }
          const cands = _fvgZones.filter(z => {
            const lo = Math.min(z.bot, z.top), hi = Math.max(z.bot, z.top);
            if (price < lo || price > hi) return false;
            const t2 = (z.t2 != null) ? z.t2 : Infinity;       // 未填補→延伸到右緣
            return param.time >= z.t1 && param.time <= t2;
          });
          // 多個缺口重疊時，挑「盒高最小」那個（最貼近你點的那條缺口）
          let hit = null;
          for (const z of cands) {
            if (!hit || Math.abs(z.top - z.bot) < Math.abs(hit.top - hit.bot)) hit = z;
          }
          _fvgSelected = (hit && hit === _fvgSelected) ? null : hit;   // 再點同一個→取消
          if (_req) _req();
        });
      } catch (e) { /* 舊版 LWC 無 subscribeClick 時略過 */ }
    },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 餵入後端 fvg 陣列 [{t, top, bot, d, t2}] → 轉圖表時間並重繪
function setFVGZones(list) {
  _fvgZones = (Array.isArray(list) ? list : []).map(z => ({
    t1: toTime(z.t), t2: (z.t2 != null ? toTime(z.t2) : null),
    top: z.top, bot: z.bot, d: z.d, inv: !!z.inv,   // inv=IFVG(反轉缺口,反方向換色)
    dim: !!z.dim,                                   // dim=同向缺口堆疊(下方0.5W帶內)→無效(淺色、不採用)
    used: z.used !== false,                          // used=false→沒被任何標記用到→淡化(舊資料無此欄→預設true不淡化)
    sl: (z.sl != null ? z.sl : null), tp: (z.tp != null ? z.tp : null),  // 止損(g-1頂端)/止盈(2W)
    ett: (z.ett != null ? toTime(z.ett) : null),   // 進場-上緣觸及
    etm: (z.etm != null ? toTime(z.etm) : null),   // 進場-中線觸及
    etb: (z.etb != null ? toTime(z.etb) : null),   // 進場-下緣觸及
    pens: (Array.isArray(z.pens)                    // 每被突破一次的點 {t,p}：轉圖表時間、濾掉壞值
      ? z.pens.map(e => ({ t: toTime(e.t), p: e.p })).filter(e => e.t != null && e.p != null) : []),
  })).filter(z => z.t1 != null && z.top != null && z.bot != null && !z.inv);   // IFVG(inv) 先關閉：不顯示反轉缺口色塊
  _fvgSelected = null;                       // 資料重載→清除點選(舊物件已不在新陣列裡)
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
}
// 開關（預設開）：window.toggleFVG() 切換
function toggleFVG(on) {
  _fvgShow = (on === undefined) ? !_fvgShow : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgShow;
}
// 交易位階線開關：window.toggleFVGLevels() 切換（止盈2W／止損g-1頂端）
function toggleFVGLevels(on) {
  _fvgLevelsShow = (on === undefined) ? !_fvgLevelsShow : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgLevelsShow;
}
// FVG 最小寬度%（使用者自定）：寬度小於 pct 的缺口不顯示。0＝全顯示。即時重繪。
function setFVGMinWidth(pct) {
  _fvgMinW = Math.max(0, +pct || 0);
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgMinW;
}
window.setFVGZones = setFVGZones;
window.setFVGMinWidth = setFVGMinWidth;
window.toggleFVG = toggleFVG;
window.toggleFVGLevels = toggleFVGLevels;

/* ── FVG 逐筆止損/止盈價位線：每筆從進場(et)→出場(xt)畫水平線段（紅虛=止損、綠虛=止盈；
      深檔拉近會在 tp2t 階梯下移到近靶）。隨 window._fvgTradesHidden 與 FVG 標記同步開關。── */
let _fvgTradeLines = [];   // [{et, xt, sl, tpf, tpn, tp2t}]（時間已轉圖表時間）
let _fvgTLPrim = null;
function _makeFVGTradeLinePrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (window._fvgTradesHidden || !_fvgTradeLines.length || !_chart || !_series) return;
      const ts = _chart.timeScale();
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        for (const t of _fvgTradeLines) {
          const x1 = ts.timeToCoordinate(t.et);
          if (x1 == null) continue;
          let x2 = (t.xt != null) ? ts.timeToCoordinate(t.xt) : null;
          if (x2 == null) x2 = x1 + 6;                  // 出場在畫面外 → 短殘段
          if (x2 <= x1) x2 = x1 + 1;
          ctx.lineWidth = Math.max(1, hr);
          ctx.setLineDash([4 * hr, 3 * hr]);
          // 止損線（紅）
          const ySL = _series.priceToCoordinate(t.sl);
          if (ySL != null) {
            ctx.strokeStyle = "rgba(239,83,80,0.85)";
            ctx.beginPath(); ctx.moveTo(x1 * hr, ySL * vr); ctx.lineTo(x2 * hr, ySL * vr); ctx.stroke();
          }
          // 止盈線（綠）：tp2t(深檔拉近)之前用 tpf、之後階梯到 tpn
          ctx.strokeStyle = "rgba(38,198,166,0.85)";
          const yF = _series.priceToCoordinate(t.tpf);
          const hasStep = (t.tp2t != null && t.tpn != null && t.tpn !== t.tpf);
          const xStep = hasStep ? ts.timeToCoordinate(t.tp2t) : null;
          if (xStep != null) {
            const yN = _series.priceToCoordinate(t.tpn);
            const xs = Math.max(x1, Math.min(xStep, x2));
            if (yF != null) { ctx.beginPath(); ctx.moveTo(x1 * hr, yF * vr); ctx.lineTo(xs * hr, yF * vr); ctx.stroke(); }
            if (yN != null) {
              if (yF != null) { ctx.beginPath(); ctx.moveTo(xs * hr, yF * vr); ctx.lineTo(xs * hr, yN * vr); ctx.stroke(); }
              ctx.beginPath(); ctx.moveTo(xs * hr, yN * vr); ctx.lineTo(x2 * hr, yN * vr); ctx.stroke();
            }
          } else if (yF != null) {
            ctx.beginPath(); ctx.moveTo(x1 * hr, yF * vr); ctx.lineTo(x2 * hr, yF * vr); ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 餵入後端 fvg_trades；rpCut（replay 當下圖表時間）→ 只畫已發生的、出場裁切到當下
function setFVGTradeLines(list, rpCut) {
  let arr = (Array.isArray(list) ? list : []).map(t => ({
    et: toTime(t.et), xt: (t.xt != null ? toTime(t.xt) : null),
    sl: t.sl, tpf: t.tpf, tpn: t.tpn, tp2t: (t.tp2t != null ? toTime(t.tp2t) : null),
  })).filter(t => t.et != null && t.sl != null && t.tpf != null);
  if (rpCut != null) {
    arr = arr.filter(t => t.et <= rpCut).map(t => ({
      ...t,
      xt: (t.xt == null || t.xt > rpCut) ? rpCut : t.xt,
      tp2t: (t.tp2t != null && t.tp2t > rpCut) ? null : t.tp2t,
    }));
  }
  _fvgTradeLines = arr;
  if (_fvgTLPrim) _fvgTLPrim.requestUpdate();
}
window.setFVGTradeLines = setFVGTradeLines;

/* ── 將 ohlcv 資料套用到目前 series ── */
function applyOhlcvToSeries(data) {
  if (!candleSeries || !data.length) return;
  {
    candleSeries.setData(data.map(d => ({
      time: d.time ? toTime(d.time) : d, open: d.open, high: d.high, low: d.low, close: d.close,
    })));
  }
  updateLatestPriceLine(data[data.length - 1].close);
}

let _curPriceLabelEl = null;   // 現價的自訂 DOM 標籤（與十字線價格標籤同風格）

function updateLatestPriceLine(price) {
  if (!candleSeries || price == null) return;
  if (latestPriceLine) {
    try { latestPriceLine.applyOptions({ price }); }
    catch { latestPriceLine = null; }
  }
  if (!latestPriceLine) {
    latestPriceLine = candleSeries.createPriceLine({
      price,
      color: "rgba(255,145,71,.80)",
      lineWidth: 1,
      lineStyle: 2,            /* 2 = Dashed */
      axisLabelVisible: false, /* 關掉原生橘色標籤，改用下方自訂 DOM 標籤 */
      title: "",
    });
  }
  updateCurrentPriceLabel();
}

// 現價在右軸的標示：改成跟十字線價格標籤同款（圓角小卡、等寬字），不再用 LWC 原生方塊標籤。
function updateCurrentPriceLabel() {
  if (typeof candleSeries === "undefined" || !candleSeries) return;
  const mainEl = document.getElementById("mainChart");
  if (!mainEl) return;
  if (!_curPriceLabelEl || !_curPriceLabelEl.isConnected) {
    if (getComputedStyle(mainEl).position === "static") mainEl.style.position = "relative";
    _curPriceLabelEl = document.createElement("div");
    _curPriceLabelEl.className = "current-price-label";
    mainEl.appendChild(_curPriceLabelEl);
  }
  const lbl = _curPriceLabelEl;
  const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
  if (!n) { lbl.style.display = "none"; return; }
  let idx = n - 1;
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    idx = Math.min(idx, replayIdx);
  const price = ohlcvData[idx] && ohlcvData[idx].close;
  if (price == null) { lbl.style.display = "none"; return; }
  const y = candleSeries.priceToCoordinate(price);
  if (y == null) { lbl.style.display = "none"; return; }
  lbl.textContent = (typeof _fmtPx === "function") ? _fmtPx(price) : price.toFixed(2);
  lbl.style.top = Math.round(y) + "px";
  lbl.style.display = "block";
}

/* ── 建立圖表 ── */
function buildCharts() {
  const base  = makeBaseOpts(null,                   false);
  const sub   = makeBaseOpts({ top:0.08, bottom:0.08 }, false);
  const volSM = makeBaseOpts({ top:0.05, bottom:0 },    false);
  const subT  = makeBaseOpts({ top:0.08, bottom:0.08 }, true);  // 最下方，顯示時間軸

  mainChart = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  createCandleSeries();
  bbU = mainChart.addLineSeries({ color:C.bbU, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });
  bbM = mainChart.addLineSeries({ color:C.bbM, lineWidth:S.bbMWidth??1, lineStyle:S.bbMStyle??2, priceLineVisible:false, lastValueVisible:false });
  bbL = mainChart.addLineSeries({ color:C.bbL, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });
  // 布林 1σ 內帶（虛線，較淺）：bbU1=上 1σ、bbL1=下 1σ；隨 BB 圖例開關一起顯示/隱藏
  bbU1 = mainChart.addLineSeries({ color:C.bb1, lineWidth:S.bbWidth??1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });
  bbL1 = mainChart.addLineSeries({ color:C.bb1, lineWidth:S.bbWidth??1, lineStyle:2, priceLineVisible:false, lastValueVisible:false });

  // 成交量疊在主圖下方（獨立 priceScaleId，不影響 K 棒價格軸）
  volSeries   = mainChart.addHistogramSeries({ priceScaleId:"volume", priceLineVisible:false, lastValueVisible:false });
  volMaSeries = mainChart.addLineSeries({ priceScaleId:"volume", color:(C.volMa||"#ffcc02"), lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });

  kdjChart = LightweightCharts.createChart(document.getElementById("kdjChart"), sub);
  kdjAnchor = kdjChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjK  = kdjChart.addLineSeries({ color:C.kdjK, lineWidth:S.kdjKWidth??1, lineStyle:S.kdjKStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjD  = kdjChart.addLineSeries({ color:C.kdjD, lineWidth:S.kdjDWidth??1, lineStyle:S.kdjDStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjJ  = kdjChart.addLineSeries({ color:C.kdjJ, lineWidth:S.kdjJWidth??1, lineStyle:S.kdjJStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjH20 = kdjChart.addLineSeries({ color:C.kdjH20, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH50 = kdjChart.addLineSeries({ color:C.kdjH50, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH80 = kdjChart.addLineSeries({ color:C.kdjH80, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), sub);
  rsiAnchor = rsiChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiLine14 = rsiChart.addLineSeries({ color:C.rsi14, lineWidth:S.rsi14Width??1, lineStyle:S.rsi14Style??0, priceLineVisible:false, lastValueVisible:false });
  rsiLine7  = rsiChart.addLineSeries({ color:C.rsi7,  lineWidth:S.rsi7Width??1,  lineStyle:S.rsi7Style??0,  priceLineVisible:false, lastValueVisible:false });
  rsiH30 = rsiChart.addLineSeries({ color:C.rsiH30, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH50 = rsiChart.addLineSeries({ color:C.rsiH50, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH70 = rsiChart.addLineSeries({ color:C.rsiH70, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  macdChart = LightweightCharts.createChart(document.getElementById("macdChart"), subT);
  macdAnchor = macdChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdLine   = macdChart.addLineSeries({ color:C.macd,    lineWidth:S.macdWidth??1,    lineStyle:S.macdStyle??0,    priceLineVisible:false, lastValueVisible:false });
  macdSignal = macdChart.addLineSeries({ color:C.macdSig, lineWidth:S.macdSigWidth??1, lineStyle:S.macdSigStyle??0, priceLineVisible:false, lastValueVisible:false });
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
  let _scrollLoadTs = 0; // throttle scroll-triggered loading
  // 跨圖同步用 rAF 合併：一次拖曳/縮放每幀可能觸發多次 range-change，若每次都同步 3 張子圖
  // → 主執行緒被重繪塞滿，連帶把背景天氣動畫的 rAF 擠掉（拖曳時背景凍結）。改成「每幀最多
  // 同步一次」：把最新 range 記下來，用單一 rAF 在下一幀統一推給其它圖，負載大降、背景有空檔更新。
  let _pendingSync = null;      // { range, si } 最新待同步狀態
  let _syncRaf = 0;
  let _lastFlushTs = 0;
  function _flushSync() {
    _syncRaf = 0;
    const p = _pendingSync;
    if (!p || _blockSync) { _pendingSync = null; return; }
    // 平移/縮放/慣性進行中：子圖同步降到 ~30fps（主圖維持全速；盤中上萬根時 4 張圖每幀重排太重）。
    // 節流時保留 _pendingSync、下一幀再試，確保停手時以「最新 range」做最後一次同步、子圖補正。
    const _now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const _moving = window._chartMoveTs && (_now - window._chartMoveTs < 220);
    if (_moving && _now - _lastFlushTs < 33) { _syncRaf = requestAnimationFrame(_flushSync); return; }
    _lastFlushTs = _now;
    _pendingSync = null;
    syncing = true;
    allCharts.forEach((dst, di) => { if (di !== p.si) dst.timeScale().setVisibleLogicalRange(p.range); });
    syncing = false;
    // 平移/縮放 → 重算可見範圍的標記視窗（debounced，避免長範圍時 setMarkers 拖慢）
    if (typeof _scheduleMarkerRewindow === "function") _scheduleMarkerRewindow();
    // 接近左側邊界就提前預抓下一塊歷史（門檻拉大 → 還沒滑到空白就先載好，補資料更快不卡頓）
    if (p.range.from < 600 && !_bgLoadInProgress && ohlcvData.length) {
      const now = Date.now();
      if (now - _scrollLoadTs > 250) { // 節流縮短 → 連續往回滑時下一塊能更快接上
        _scrollLoadTs = now;
        _bgLoadOlderBars(true); // 滑動觸發，分頁載入更早的資料（一次一塊）
      }
    }
  }
  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      // 標記「圖表正在移動」（平移/縮放/慣性）→ 供其它模組參考（背景天氣等）
      window._chartMoveTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (syncing || !range || _blockSync) return;
      _pendingSync = { range, si };               // 只記最新，丟棄同幀內較舊的中間值
      if (!_syncRaf) _syncRaf = requestAnimationFrame(_flushSync);
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

  // 年份：固定顯示在價格軸下方的右下角（取右側可見範圍的年份），不再塞進游標時間標籤
  const yearLabel = document.createElement("div");
  yearLabel.className = "time-axis-year";
  container.appendChild(yearLabel);
  function updateYearLabel() {
    let yr = "";
    try {
      const r = mainChart.timeScale().getVisibleRange();
      if (r && r.to != null) yr = new Date(r.to * 1000).getUTCFullYear();
      else if (typeof ohlcvData !== "undefined" && ohlcvData.length)
        yr = new Date(toTime(ohlcvData[ohlcvData.length - 1].time) * 1000).getUTCFullYear();
    } catch (e) {}
    yearLabel.textContent = yr || "";
  }
  mainChart.timeScale().subscribeVisibleTimeRangeChange(updateYearLabel);
  setTimeout(updateYearLabel, 0);

  let hideTimer = null;

  function positionLines(time, fallbackX) {
    // 時間轉 x 座標；timeToCoordinate 只對「繪圖區內的時間」回座標 [0, plotW]。
    // 往左滑時十字線時間捲出繪圖區 → 回 null，此時直接隱藏標籤（不可退回游標 x，
    // 否則游標在右側價格軸區時，時間框會跑到右邊）。
    const mainX = mainChart.timeScale().timeToCoordinate(time);
    if (mainX == null || mainX < 0) {
      lineEls.forEach(l => l.style.display = "none");
      timeLabel.style.display = "none";
      return;
    }

    // 底部時間標籤
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    // 年份不放在游標標籤裡（改固定顯示在價格軸下方右下角）→ 這裡只留 月-日 (時:分)
    let timeStr;
    if (["8h","4h","2h","1h","30m","15m","5m"].includes(currentTF)) {
      timeStr = `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    } else {
      timeStr = `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    }
    timeLabel.textContent = timeStr;
    timeLabel.style.display = "block";
    timeLabel.style.left   = Math.round(mainX) + "px";

    const cRect = container.getBoundingClientRect();
    let maxPaneBottom = cRect.top;        // 最底可見 pane 的底緣＝時間軸所在位置
    panesConf.forEach(({ elId, chart }, i) => {
      const pane = document.getElementById(elId);
      const ln   = lineEls[i];
      if (!pane || pane.classList.contains("hidden")) { ln.style.display = "none"; return; }
      if (pane.querySelector(".pane-body")?.style.display === "none") { ln.style.display = "none"; return; }

      const paneX = chart.timeScale().timeToCoordinate(time) ?? mainX;
      if (paneX == null) { ln.style.display = "none"; return; }

      const pRect = pane.getBoundingClientRect();
      let height  = pRect.height;
      if (pRect.bottom > maxPaneBottom) maxPaneBottom = pRect.bottom;

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

    // 時間標籤錨定到時間軸（最底可見 pane 底緣），而非容器底。
    // 桌面容器底＝圖表底 → offset≈0；手機容器延伸到底部分頁列後方 → offset≈分頁列高，
    // 否則標籤會被推到時間軸下方、藏進 m-tabbar 後面而看不到。
    const axisOffset = Math.max(0, Math.round(cRect.bottom - maxPaneBottom));
    timeLabel.style.bottom = (axisOffset + (replayActive ? 42 : 0)) + "px";
  }

  // 用游標 x 直接定位鉛直線（給「最後一根K棒右側空白區」用：該處無對應時間，
  // 原生會把十字線時間 snap 到最後一根 → 線卡在最後一根不動。改用游標 x 讓線跟著進入空白）。
  function positionLinesByX(px) {
    timeLabel.style.display = "none";          // 空白區無對應時間 → 不顯示時間標籤
    const cRect = container.getBoundingClientRect();
    panesConf.forEach(({ elId }, i) => {
      const pane = document.getElementById(elId);
      const ln   = lineEls[i];
      if (!pane || pane.classList.contains("hidden")) { ln.style.display = "none"; return; }
      if (pane.querySelector(".pane-body")?.style.display === "none") { ln.style.display = "none"; return; }
      const pRect = pane.getBoundingClientRect();
      let height = pRect.height;
      const nextSib = pane.nextElementSibling;
      if (nextSib?.classList.contains("pane-divider") && !nextSib.classList.contains("hidden")) {
        height += nextSib.getBoundingClientRect().height;
      }
      ln.style.display = "block";
      ln.style.left    = Math.round(px) + "px";
      ln.style.top     = Math.round(pRect.top - cRect.top) + "px";
      ln.style.height  = Math.round(height) + "px";
    });
  }

  panesConf.forEach(({ chart }) => {
    chart.subscribeCrosshairMove(param => {
      clearTimeout(hideTimer);
      // 游標在「最後一根K棒右側空白區」：用游標 x 直接定位鉛直線，跟著游標進入空白、不卡在最後一根
      if (param.point) {
        const ts = mainChart.timeScale();
        const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
        const lastX = n ? ts.logicalToCoordinate(n - 1) : null;
        let pw = ts.width();
        if (lastX != null && param.point.x > lastX + 0.5 && param.point.x <= pw) {
          positionLinesByX(param.point.x);
          if (typeof _updateHoverWR === "function") _updateHoverWR(null);
          return;
        }
      }
      if (!param.time || !param.point) {
        hideTimer = setTimeout(() => {
          lineEls.forEach(l => l.style.display = "none");
          timeLabel.style.display = "none";
        }, 60);
        if (typeof _updateHoverWR === "function") _updateHoverWR(null);   // 離開圖表 → 清 hover 勝率/RR 盒
        return;
      }
      positionLines(param.time, param.point.x);
      updateAllLegends(param.time);
      // 十字線移到該 K 棒 → 上方 S1-S12 區顯示該棒訊號勝率 + 圖上畫 RR 盒
      if (typeof _updateHoverWR === "function") _updateHoverWR(param.time);
    });
  });

  // 所有圖停用 LWC 原生鉛直線（改用自訂 pane-vline），並關掉原生時間軸標籤——
  // 否則底部會同時冒出原生「2026-05-20 00:00」與自訂「2026-05-20」兩個標籤互相重疊。
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => {
    c?.applyOptions({ crosshair: { vertLine: { visible: false, labelVisible: false } } });
  });

  // ── 主圖右側價格標籤：游標所在價格 + 距離「目前價(最新價線)」幾 % ──
  // 取代主圖原生橫線價格標籤（只在主圖；副圖維持原生數值標籤）。
  (function setupCrosshairPriceLabel() {
    const mainEl = document.getElementById("mainChart");
    if (!mainEl) return;
    if (getComputedStyle(mainEl).position === "static") mainEl.style.position = "relative";
    const lbl = document.createElement("div");
    lbl.className = "crosshair-price-label";
    mainEl.appendChild(lbl);
    mainChart.applyOptions({ crosshair: { horzLine: { labelVisible: false } } });

    mainChart.subscribeCrosshairMove(param => {
      if (!param.point || !candleSeries) { lbl.style.display = "none"; return; }
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null) { lbl.style.display = "none"; return; }
      // 參考價＝目前價（最新價線；重播時取「已揭曉」那根的收盤）
      const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
      let refIdx = n - 1;
      if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
        refIdx = Math.min(refIdx, replayIdx);
      const ref = (n && refIdx >= 0) ? ohlcvData[refIdx].close : null;
      const pct = (ref && ref !== 0) ? (price - ref) / ref * 100 : null;
      const priceStr = (typeof _fmtPx === "function") ? _fmtPx(price) : price.toFixed(2);
      // 高於現價=綠(漲)、低於=紅(跌)，寫死避免被任何設定反轉
      const pctCol = (pct == null) ? "" : (pct >= 0 ? "#93cf7e" : "#ec8463");
      const pctStr = (pct == null) ? "" :
        `<span class="cpl-pct" style="color:${pctCol}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
      lbl.innerHTML = pctStr ? `${priceStr}<br>${pctStr}` : priceStr;   // 上價下%（兩行）
      lbl.style.top = Math.round(param.point.y) + "px";
      lbl.style.display = "block";
    });
  })();
}

/* ══════════════════════════════════════════
   繪圖工具（Canvas Overlay）
══════════════════════════════════════════ */
