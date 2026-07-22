/* ── 大時框 FVG 疊加 ────────────────────────────────────────────────
   在當前(小)時框圖上，畫出更高時框(1h/4h/1d/1w 中高於當前者)的 FVG 缺口——
   FVG 帶絕對時間+價格，可畫在任何時框當更高階的支撐/壓力參考(多時框匯流)。
   資料重用 /api/crt_winrate?tf=<HTF> 的 fvg 欄位；每個大時框一種顏色 + 時框標籤(1h/4h/1d/1w)。
   純顯示、不影響偵測/勝率；圖例「大時框FVG」開關，預設關。切標的/時框自癒重抓(draw 內比對 key)。 */

let _htfFvgOn = false;
let _htfFvgPrim = null;      // primitive（charts.js createCandleSeries 掛載時指派）
let _htfFvgData = [];        // [{tf, zones:[{t1,t2,top,bot,d}]}]
let _htfFvgKey = "";         // 目前資料對應 symbol|market|applicableTFs
let _htfFvgFetching = false;
let _htfFvgLastAttempt = 0;

const _HTF_FVG_LADDER = ["1h", "4h", "1d"];   // 1w 移除(使用者要求：大時區 FVG 不含週線)
const _HTF_TF_RANK = { "1m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "2h": 6, "4h": 7, "8h": 8, "1d": 9, "1w": 10, "1M": 11 };
// 每時框「一種明顯不同的色相」+ 時框越大框越粗(越重要)：青→琥珀→紫→洋紅，色相分得開好辨識。
const _HTF_FVG_COLOR = { "1h": "#00bcd4", "4h": "#ffb300", "1d": "#7e57c2", "1w": "#ec407a" };
const _HTF_FVG_LW = { "1h": 1.1, "4h": 1.6, "1d": 2.1, "1w": 2.6 };   // 邊框粗細(× hr)
const _HTF_FVG_CAP = 40;   // 每時框最多取最近幾個缺口(by t1)——避免歷史過多糊畫面

function _htfHexA(hex, a) {
  const h = String(hex).replace("#", "");
  return `rgba(${parseInt(h.substr(0, 2), 16)},${parseInt(h.substr(2, 2), 16)},${parseInt(h.substr(4, 2), 16)},${a})`;
}

function _htfApplicable() {
  const cur = (typeof currentTF !== "undefined" && currentTF) || "";
  const cr = _HTF_TF_RANK[cur] || 0;
  return _HTF_FVG_LADDER.filter(tf => (_HTF_TF_RANK[tf] || 0) > cr);   // 只取嚴格高於當前的
}

function _htfLiveKey() {
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
  return symbol + "|" + market + "|" + _htfApplicable().join(",");
}

async function _htfFvgFetch() {
  if (!_htfFvgOn || _htfFvgFetching) return;
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
  const tfs = _htfApplicable();
  if (!symbol || !tfs.length) { _htfFvgData = []; _htfFvgKey = _htfLiveKey(); if (_htfFvgPrim) _htfFvgPrim.requestUpdate(); return; }
  _htfFvgFetching = true;
  _htfFvgLastAttempt = Date.now();
  const key = symbol + "|" + market + "|" + tfs.join(",");
  try {
    const results = await Promise.all(tfs.map(async tf => {
      try {
        const p = new URLSearchParams({ symbol, timeframe: tf, market }).toString();   // ⚠ 端點參數是 timeframe 非 tf
        const res = await fetch("/api/crt_winrate?" + p, { cache: "no-cache" });
        const j = await res.json();
        const raw = Array.isArray(j.fvg) ? j.fvg : [];
        // 顯示 HTF 缺口：未填補(t2==null)延伸到現在=有效待測 S/R；已填補的保留其原始盒(在過去)。
        //   只取「最近 _HTF_FVG_CAP 個(by t1)」→ 既給足夠密度、又不會被上千個歷史缺口糊掉。
        const zones = raw
          .filter(z => !z.inv && z.top != null && z.bot != null && z.t != null)
          .map(z => ({ t1: toTime(z.t), t2: (z.t2 != null ? toTime(z.t2) : null), top: z.top, bot: z.bot, d: z.d, open: z.t2 == null }))
          .filter(z => z.t1 != null && !Number.isNaN(z.t1))
          .sort((a, b) => a.t1 - b.t1);
        return { tf, zones: zones.slice(-_HTF_FVG_CAP) };
      } catch (e) { return { tf, zones: [] }; }
    }));
    if (_htfLiveKey() !== key) return;   // 抓回來已切標的/時框 → 丟棄
    _htfFvgData = results;
    _htfFvgKey = key;
  } finally {
    _htfFvgFetching = false;
    if (_htfFvgPrim) _htfFvgPrim.requestUpdate();
  }
}

window.toggleHtfFvg = function (on) {
  _htfFvgOn = (on === undefined) ? !_htfFvgOn : !!on;
  if (_htfFvgOn) _htfFvgFetch();
  else _htfFvgData = [];
  if (_htfFvgPrim) _htfFvgPrim.requestUpdate();
  return _htfFvgOn;
};

function _makeHtfFvgPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!_htfFvgOn || !_chart || !_series) return;
      // 切標的/時框自癒：資料 key 與現況不符 → 重抓（1s 節流）
      if (_htfFvgKey !== _htfLiveKey() && !_htfFvgFetching && Date.now() - _htfFvgLastAttempt > 1000) setTimeout(_htfFvgFetch, 0);
      if (!_htfFvgData.length) return;
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        const W = scope.mediaSize.width;
        const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const _mv = !!(window._chartMoveTs && _nowP - window._chartMoveTs < 220);
        if (!_mv) { ctx.font = `${Math.round(10 * vrr)}px sans-serif`; ctx.textBaseline = "middle"; ctx.textAlign = "left"; }
        // 由小到大時框畫（大時框後畫 → 疊在上層、較顯眼）
        for (const grp of _htfFvgData) {
          const col = _HTF_FVG_COLOR[grp.tf] || "#888";
          const lw = Math.max(1, (_HTF_FVG_LW[grp.tf] || 1.4) * hr);
          for (const z of grp.zones) {
            if (z.t1 > hi) continue;
            if (z.t2 != null && z.t2 < lo) continue;
            const x1 = ts.timeToCoordinate(z.t1);
            if (x1 == null) continue;
            let x2 = (z.t2 != null) ? ts.timeToCoordinate(z.t2) : null;
            if (x2 == null) x2 = W;
            if (x2 <= x1) x2 = x1 + 1;
            const yT = _series.priceToCoordinate(z.top);
            const yB = _series.priceToCoordinate(z.bot);
            if (yT == null || yB == null) continue;
            const bx = x1 * hr, bw = (x2 - x1) * hr;
            const byTop = Math.min(yT, yB) * vrr, bh = Math.abs(yB - yT) * vrr;
            // 顏色 = 時框(易辨識)；填底用同色(未填補較實 0.14、已填補較淡 0.05)、邊框同色、越大時框越粗。
            ctx.fillStyle = _htfHexA(col, z.open ? 0.14 : 0.05);
            ctx.fillRect(bx, byTop, bw, bh);
            ctx.strokeStyle = _htfHexA(col, z.open ? 0.95 : 0.6);
            ctx.lineWidth = lw;
            if (!z.open) ctx.setLineDash([4 * hr, 3 * hr]);   // 已填補=虛線、未填補=實線
            ctx.strokeRect(bx, byTop, bw, bh);
            ctx.setLineDash([]);
            // 時框標籤(左緣、垂直置中、粗體)：例 "4h ↑"（↑=支撐/多方缺口、↓=壓力/空方缺口）
            if (!_mv) {
              const lbl = grp.tf + (z.d === "l" ? " ↑" : " ↓");
              const _ty = byTop + bh / 2;
              const _yy = bh >= 13 * vrr ? _ty : byTop - 7 * vrr;
              // 盒左緣被拉到視窗外時，標籤夾回視窗內(不超過盒右緣)→ 長缺口仍看得到是哪個時框
              const _lx = Math.min(Math.max(bx + 3 * hr, 3 * hr), (bx + bw) - 30 * hr);
              ctx.font = `bold ${Math.round(10 * vrr)}px sans-serif`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
              ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.strokeStyle = "rgba(0,0,0,0.6)";
              ctx.lineWidth = Math.max(2, 2 * hr);
              ctx.strokeText(lbl, _lx, _yy);
              ctx.fillStyle = _htfHexA(col, 1);
              ctx.fillText(lbl, _lx, _yy);
            }
          }
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

// ── 「大時框FVG」圖例開關由 ui.js 綁定 legHtfFvg → window.toggleHtfFvg ─────
// 市場切換 → 若開著則重抓（切去無 FVG 的市場也讓 draw 的 key 檢查自癒）
document.getElementById("marketSelect")?.addEventListener("change", () => { if (_htfFvgOn) setTimeout(_htfFvgFetch, 50); });
