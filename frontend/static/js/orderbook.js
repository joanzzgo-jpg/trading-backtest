/* ── 掛單牆 Order Book Wall ────────────────────────────────────────
   即時盤口大掛單畫在主圖右緣：綠=買方支撐牆、紅=賣方壓力牆，橫條長度∝掛單金額。
   牆消失時後端判定並在該價位標：✓吃掉（行情掃到才消失＝真防守）/ ⚠撤走（沒碰到就不見＝疑似假單）。
   資料源 /api/orderbook（fapi 盤口，僅 crypto 即時）；圖例外的右上按鈕開關，預設關。 */

let _obShow = false;
let _obWalls = [];         // [{side, p, q, n}]
let _obEvents = [];        // [{ts_age, side, p, q, kind}]（後端回傳時的秒齡）
let _obImb = null;
let _obMid = 0;
let _obKey = "";
let _obTimer = null;
let _obPrim = null;
let _obFetching = false;
let _obMsg = "";
let _obNextTryTs = 0;
let _obStamp = 0;          // 本地收到事件的時間戳（用來讓事件標籤淡出）

function _obLiveKey() {
  const sym = document.getElementById("symbolInput")?.value?.trim() || "";
  return sym;   // 掛單牆與時框無關（價位基準）
}

function _obFmtN(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(Math.round(n));
}

async function _obFetch() {
  if (!_obShow || _obFetching) return;
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
  if (market !== "crypto" || !symbol) {
    _obWalls = []; _obEvents = []; _obKey = _obLiveKey();
    _obMsg = "掛單牆：僅支援加密貨幣";
    if (_obPrim) _obPrim.requestUpdate();
    return;
  }
  _obFetching = true;
  const key = symbol;
  try {
    const res = await fetch(`/api/orderbook?symbol=${encodeURIComponent(symbol)}`, { cache: "no-cache" });
    const j = await res.json();
    if (_obLiveKey() !== key) return;
    if (j && j.ok) {
      _obWalls = j.walls || [];
      _obEvents = j.events || [];
      _obImb = j.imbalance;
      _obMid = j.mid || 0;
      _obKey = key;
      _obStamp = Date.now();
      _obMsg = "";
    } else {
      _obMsg = _obWalls.length && _obKey === key ? "" : (j && j.busy ? "掛單牆：盤口繁忙，會自動重試…" : "掛單牆：讀取中…");
    }
  } catch (e) {
    _obMsg = _obWalls.length ? "" : "掛單牆：連線失敗，會自動重試…";
  } finally {
    _obFetching = false;
    if (_obPrim) _obPrim.requestUpdate();
  }
}

window.toggleOrderbook = function (on) {
  _obShow = (on === undefined) ? !_obShow : !!on;
  clearInterval(_obTimer); _obTimer = null;
  if (_obShow) {
    _obMsg = "";
    _obFetch();
    _obTimer = setInterval(_obFetch, 2500);   // 盤口變化快，2.5s 一輪（後端 1.5s 快取＋權重閘門保護）
  }
  const b = document.getElementById("orderbookBtn");
  if (b) b.classList.toggle("on", _obShow);
  if (_obPrim) _obPrim.requestUpdate();
  return _obShow;
};

function _makeOrderbookPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!_obShow || !_chart || !_series) return;
      const mismatch = _obKey !== _obLiveKey();
      if (mismatch && !_obFetching && Date.now() > _obNextTryTs) { _obNextTryTs = Date.now() + 500; setTimeout(_obFetch, 0); }
      const noData = mismatch || !_obWalls.length;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        const W = scope.bitmapSize.width;
        if (noData) {
          ctx.font = `${Math.round(11 * vr)}px sans-serif`;
          ctx.textAlign = "left"; ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillText(_obMsg || "掛單牆：讀取中…", 8 * hr, 44 * vr);
          return;
        }
        const maxN = Math.max(..._obWalls.map(w => w.n)) || 1;
        const maxBar = Math.min(W * 0.22, 150 * hr);   // 最長橫條像素
        const fpx = Math.round(10 * vr);
        ctx.font = `${fpx}px sans-serif`;
        ctx.textBaseline = "middle";
        for (const w of _obWalls) {
          if (w.n < 0.08 * maxN) continue;   // 跳過相對過小的牆（畫面乾淨）
          const y = _series.priceToCoordinate(w.p);
          if (y == null) continue;
          const yy = y * vr;
          const len = Math.max(3 * hr, maxBar * (w.n / maxN));
          const x1 = W - len, x2 = W;
          const green = w.side === "bid";
          ctx.fillStyle = green ? "rgba(38,198,166,0.42)" : "rgba(239,83,80,0.42)";
          ctx.fillRect(x1, yy - 6 * vr, len, 12 * vr);
          ctx.strokeStyle = green ? "rgba(38,198,166,0.9)" : "rgba(239,83,80,0.9)";
          ctx.lineWidth = Math.max(1, hr);
          ctx.strokeRect(x1, yy - 6 * vr, len, 12 * vr);
          // 金額標籤（條左側）
          ctx.textAlign = "right";
          ctx.fillStyle = green ? "rgba(150,255,235,0.98)" : "rgba(255,170,165,0.98)";
          const lbl = _obFmtN(w.n) + "$";
          ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.strokeStyle = "rgba(0,0,0,0.55)";
          ctx.lineWidth = Math.max(2, 2 * hr);
          ctx.strokeText(lbl, x1 - 4 * hr, yy);
          ctx.fillStyle = green ? "rgba(150,255,235,0.98)" : "rgba(255,170,165,0.98)";
          ctx.fillText(lbl, x1 - 4 * hr, yy);
        }
        // 假單/被吃事件標籤（右緣、隨秒齡淡出）
        const localAge = (Date.now() - _obStamp) / 1000;
        ctx.textAlign = "right";
        for (const e of _obEvents) {
          const age = e.ts_age + localAge;
          if (age > 12) continue;                 // 只顯示近 12s
          const y = _series.priceToCoordinate(e.p);
          if (y == null) continue;
          const op = Math.max(0, 1 - age / 12);
          const eaten = e.kind === "eaten";
          const txt = (eaten ? "✓ 吃掉 " : "⚠ 撤走 ") + _obFmtN(e.q);
          ctx.globalAlpha = op;
          ctx.font = `bold ${fpx}px sans-serif`;
          ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = Math.max(2, 2 * hr);
          ctx.strokeText(txt, W - 4 * hr, y * vr - 12 * vr);
          ctx.fillStyle = eaten ? "rgba(120,255,210,1)" : "rgba(255,205,90,1)";
          ctx.fillText(txt, W - 4 * hr, y * vr - 12 * vr);
          ctx.globalAlpha = 1;
        }
        // 買賣壓力比（左上）
        if (_obImb != null) {
          ctx.font = `${Math.round(10 * vr)}px sans-serif`;
          ctx.textAlign = "left"; ctx.textBaseline = "top";
          const strong = _obImb >= 1;
          ctx.fillStyle = strong ? "rgba(120,255,210,0.85)" : "rgba(255,170,165,0.85)";
          ctx.fillText(`掛單買賣比 ${_obImb}（${strong ? "買方掛得多" : "賣方掛得多"}）`, 8 * hr, 44 * vr);
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

// ── 「掛單牆」開關按鈕（靜態放在時框行 .tf-group，index.html）───────
function _obBtnRefresh() {
  const b = document.getElementById("orderbookBtn");
  if (!b) return;
  const isCrypto = (document.getElementById("marketSelect")?.value || "crypto") === "crypto";
  b.style.display = isCrypto ? "" : "none";
  if (!isCrypto && _obShow) window.toggleOrderbook(false);
  b.classList.toggle("on", _obShow);
}

function _obBtnInit() {
  const b = document.getElementById("orderbookBtn");
  if (b && !b._obBound) { b._obBound = true; b.addEventListener("click", () => window.toggleOrderbook()); }
  _obBtnRefresh();
  document.getElementById("marketSelect")?.addEventListener("change", () => setTimeout(_obBtnRefresh, 0));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _obBtnInit);
else _obBtnInit();
