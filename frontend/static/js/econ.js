/* ═══════════════════════════════════════════════
   經濟事件標記（NFP / CPI / FOMC）— 主圖垂直線
   資料來源：GET /api/econ_events（回 UTC unix 秒）。
   對齊：事件 UTC 秒 +8h = 圖表軸時間（與 toTime 同慣例）。
   放置：吸附到「該時刻所在(或之前最近)的 K 棒」→ timeToCoordinate 必得有效座標
        （事件時刻多半不等於某根 K 的時戳，直接換算會拿到 null）。
   預設關（圖例「經濟事件」）；開才抓一次。
═══════════════════════════════════════════════ */
let _econPrim = null;
let _econEvents = [];                 // [{ ct: 軸時間秒(=UTC+8h), type }]
let _econLoaded = false, _econLoading = false;
const _ECON_COLOR = { NFP: "255,152,0", CPI: "38,198,218", FOMC: "239,83,80" };
const _ECON_YOFF  = { NFP: 3, CPI: 15, FOMC: 27 };   // 標籤垂直錯位(*vrr)避免不同事件擠一起

function _fetchEconEvents() {
  if (_econLoaded || _econLoading) return;
  _econLoading = true;
  fetch("/api/econ_events")
    .then(r => r.json())
    .then(j => {
      _econEvents = (j.events || []).map(e => ({ ct: e.t + 8 * 3600, type: e.type }));
      _econLoaded = true; _econLoading = false;
      if (_econPrim) _econPrim.requestUpdate();
    })
    .catch(() => { _econLoading = false; });
}

// 二分找「軸時間 <= ct 的最後一根 K」的軸時間；找不到回 null。
function _econSnapTime(ct) {
  if (typeof ohlcvData === "undefined" || !ohlcvData.length) return null;
  let lo = 0, hi = ohlcvData.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toTime(ohlcvData[mid].time) <= ct) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans < 0) return null;                 // 事件早於第一根 K → 不畫
  return toTime(ohlcvData[ans].time);
}

function _makeEconPrimitive() {
  let _chart = null, _series = null, _req = null, _settleT = null;
  const renderer = {
    draw(target) {
      if (!window._econOn || !_chart || !_series || !_econEvents.length) return;
      // 平移中略過(垂直全高虛線最貴)、停手補畫
      const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (window._chartMoveTs && _nowP - window._chartMoveTs < 220) { clearTimeout(_settleT); _settleT = setTimeout(() => { if (_req) _req(); }, 240); return; }
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        const H = scope.bitmapSize.height;
        ctx.font = `bold ${Math.round(9 * vrr)}px sans-serif`;
        ctx.textAlign = "left";
        for (const e of _econEvents) {
          const st = _econSnapTime(e.ct);
          if (st == null || st < lo || st > hi) continue;
          const x = ts.timeToCoordinate(st);
          if (x == null) continue;
          const bx = x * hr;
          const rgb = _ECON_COLOR[e.type] || "200,200,200";
          ctx.strokeStyle = `rgba(${rgb},0.5)`; ctx.lineWidth = Math.max(1, 1 * hr);
          ctx.setLineDash([2 * hr, 3 * hr]);
          ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H); ctx.stroke();
          ctx.setLineDash([]);
          const ly = (_ECON_YOFF[e.type] || 3) * vrr;
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = Math.max(2, 2 * hr);
          ctx.strokeText(e.type, bx + 2 * hr, ly);
          ctx.fillStyle = `rgba(${rgb},1)`; ctx.fillText(e.type, bx + 2 * hr, ly);
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; }, zOrder() { return "bottom"; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {}, paneViews() { return [paneView]; }, requestUpdate() { if (_req) _req(); },
  };
}

window.toggleEcon = function (on) {
  window._econOn = (on === undefined) ? !window._econOn : !!on;
  if (window._econOn) _fetchEconEvents();
  if (_econPrim) _econPrim.requestUpdate();
  return window._econOn;
};
