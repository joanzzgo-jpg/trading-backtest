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

const _HTF_FVG_LADDER = ["1h", "4h", "1d", "1w"];
const _HTF_TF_RANK = { "1m": 1, "5m": 2, "15m": 3, "30m": 4, "1h": 5, "2h": 6, "4h": 7, "8h": 8, "1d": 9, "1w": 10, "1M": 11 };
const _HTF_FVG_COLOR = { "1h": "#26c6a6", "4h": "#42a5f5", "1d": "#ab47bc", "1w": "#ff9800" };  // 每時框一色(區分)

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
        // 只留「未填補(open/未緩解)」的缺口(z.t2 == null → 延伸到現在,仍是有效 HTF 支撐/壓力)；
        //   已填補的歷史缺口是過去式、且量極大會糊掉畫面 → 不疊。
        const zones = raw
          .filter(z => !z.inv && z.t2 == null && z.top != null && z.bot != null && z.t != null)
          .map(z => ({ t1: toTime(z.t), t2: null, top: z.top, bot: z.bot, d: z.d }))
          .filter(z => z.t1 != null && !Number.isNaN(z.t1));
        return { tf, zones };
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
        for (const grp of _htfFvgData) {
          const col = _HTF_FVG_COLOR[grp.tf] || "#888";
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
            // 方向色極淡填底(支撐綠/壓力紅) + 時框色實線框
            ctx.fillStyle = z.d === "l" ? "rgba(38,198,166,0.07)" : "rgba(255,82,82,0.07)";
            ctx.fillRect(bx, byTop, bw, bh);
            ctx.strokeStyle = _htfHexA(col, 0.8);
            ctx.lineWidth = Math.max(1, 1.5 * hr);
            ctx.strokeRect(bx, byTop, bw, bh);
            // 時框標籤(左緣、垂直置中)：例 "4h ↑"（支撐）/ "1d ↓"（壓力）
            if (!_mv) {
              const lbl = grp.tf + (z.d === "l" ? " ↑" : " ↓");
              const _ty = byTop + bh / 2;
              const _yy = bh >= 12 * vrr ? _ty : byTop - 7 * vrr;
              ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.strokeStyle = "rgba(0,0,0,0.55)";
              ctx.lineWidth = Math.max(2, 2 * hr);
              ctx.strokeText(lbl, bx + 3 * hr, _yy);
              ctx.fillStyle = _htfHexA(col, 0.98);
              ctx.fillText(lbl, bx + 3 * hr, _yy);
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
