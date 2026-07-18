/* ── 訂單簿 DOM 階梯（主圖右側獨立面板）────────────────────────────
   即時顯示各價位「等待成交」的買/賣掛單（綠=買方掛單、紅=賣方掛單，橫條長度∝掛量），
   現價置中、上方賣單下方買單 → 看出大額資金的防守位置。
   資料源 /api/dom（fapi 盤口 depth，與掛單牆共用同一份深度快取；僅 crypto 即時）。
   純視覺面板（pointer-events:none），不吃圖表互動；開關由時框行 📊 訂單簿 按鈕。 */

let _domShow = false;
let _domRows = [];          // [{p, bid, ask}] 高價在上
let _domMaxq = 0;
let _domMid = 0;
let _domBB = 0, _domBA = 0;  // best bid / best ask
let _domImb = null;
let _domBin = 0;
let _domSym = "";
let _domTimer = null;
let _domFetching = false;
let _domMsg = "";

function _domLiveSym() {
  return document.getElementById("symbolInput")?.value?.trim() || "";
}

function _domFmt(q) {
  if (q >= 1e6) return (q / 1e6).toFixed(2) + "M";
  if (q >= 1e3) return (q / 1e3).toFixed(1) + "k";
  if (q >= 100) return String(Math.round(q));
  if (q >= 10) return q.toFixed(1);
  return q.toFixed(2);
}

function _domFmtP(p) {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(p >= 100 ? 2 : 3);
  return p.toPrecision(4);
}

async function _domFetch() {
  if (!_domShow || _domFetching) return;
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = _domLiveSym();
  if (market !== "crypto" || !symbol) {
    _domRows = []; _domSym = symbol; _domMsg = "訂單簿：僅支援加密貨幣";
    _domRender();
    return;
  }
  if (symbol !== _domSym) { _domRows = []; _domMsg = "訂單簿：載入中…"; _domRender(); }
  _domFetching = true;
  try {
    const res = await fetch(`/api/dom?symbol=${encodeURIComponent(symbol)}`, { cache: "no-cache" });
    const j = await res.json();
    if (_domLiveSym() !== symbol) return;   // 抓取途中切了標的 → 丟棄
    if (j && j.ok) {
      _domRows = j.rows || [];
      _domMaxq = j.maxq || 0;
      _domMid = j.mid || 0;
      _domBB = j.best_bid || 0;
      _domBA = j.best_ask || 0;
      _domImb = j.imbalance;
      _domBin = j.bin || 0;
      _domSym = symbol;
      _domMsg = "";
    } else {
      _domMsg = _domRows.length ? "" : (j && j.busy ? "訂單簿：盤口繁忙，會自動重試…" : "訂單簿：讀取中…");
    }
  } catch (e) {
    _domMsg = _domRows.length ? "" : "訂單簿：連線失敗，會自動重試…";
  } finally {
    _domFetching = false;
    _domRender();
  }
}

function _domRender() {
  const panel = document.getElementById("domPanel");
  const cv = document.getElementById("domCanvas");
  const head = document.getElementById("domHead");
  if (!panel || !cv || !head) return;

  // 表頭：現價 + 買賣掛單比
  if (_domMid > 0) {
    const spread = _domBA > _domBB ? (_domBA - _domBB) : 0;
    const spreadPct = _domMid ? (spread / _domMid * 100) : 0;
    const imbTxt = _domImb != null
      ? `<span style="color:${_domImb >= 1 ? "#7effcf" : "#ffb0ab"}">掛單買賣比 ${_domImb}</span>`
      : "";
    head.innerHTML =
      `<div style="font-weight:600">${_domSym} <span style="opacity:.75">現價 ${_domFmtP(_domMid)}</span></div>` +
      `<div style="opacity:.7">價階 ${_domBin ? _domFmtP(_domBin) : "-"}・價差 ${spreadPct.toFixed(3)}%</div>` +
      (imbTxt ? `<div>${imbTxt}</div>` : "");
  } else {
    head.innerHTML = `<div style="opacity:.7">${_domMsg || "訂單簿"}</div>`;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth, cssH = cv.clientHeight;
  if (cssW < 2 || cssH < 2) return;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!_domRows.length) {
    ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(200,205,215,0.55)";
    ctx.fillText(_domMsg || "載入中…", cssW / 2, cssH / 2);
    return;
  }

  const n = _domRows.length;
  const rowH = cssH / n;
  const midX = cssW * 0.5;
  const priceHalf = Math.min(30, cssW * 0.22);   // 中央價格欄半寬
  const bidZone = midX - priceHalf - 2;          // 買方橫條可用寬（由中線往左）
  const askZone = cssW - (midX + priceHalf) - 2; // 賣方橫條可用寬（由中線往右）
  const maxq = _domMaxq || 1;
  const showNum = rowH >= 8;
  const fpx = Math.min(10, Math.max(7, rowH * 0.62));
  const perf = document.documentElement.classList.contains("perf-mode");

  ctx.textBaseline = "middle";
  for (let i = 0; i < n; i++) {
    const r = _domRows[i];
    const y = i * rowH;
    const cy = y + rowH / 2;
    const p = r.p;
    // 現價所在桶：高亮整列（防守/成交交界）
    const isMidRow = _domBin > 0 && Math.abs(p - _domMid) <= _domBin / 2 + 1e-9;
    if (isMidRow) {
      ctx.fillStyle = perf ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.10)";
      ctx.fillRect(0, y, cssW, rowH);
    }
    // 買方掛量（綠，往左）
    if (r.bid > 0 && bidZone > 0) {
      const len = Math.max(1, (r.bid / maxq) * bidZone);
      ctx.fillStyle = "rgba(38,198,166,0.38)";
      ctx.fillRect(midX - priceHalf - len, y + 0.5, len, rowH - 1);
      if (showNum) {
        ctx.font = `${fpx}px sans-serif`; ctx.textAlign = "right";
        ctx.fillStyle = perf ? "#0a7d63" : "rgba(150,255,235,0.95)";
        ctx.fillText(_domFmt(r.bid), midX - priceHalf - 2, cy);
      }
    }
    // 賣方掛量（紅，往右）
    if (r.ask > 0 && askZone > 0) {
      const len = Math.max(1, (r.ask / maxq) * askZone);
      ctx.fillStyle = "rgba(239,83,80,0.38)";
      ctx.fillRect(midX + priceHalf, y + 0.5, len, rowH - 1);
      if (showNum) {
        ctx.font = `${fpx}px sans-serif`; ctx.textAlign = "left";
        ctx.fillStyle = perf ? "#b32b28" : "rgba(255,175,170,0.95)";
        ctx.fillText(_domFmt(r.ask), midX + priceHalf + 2, cy);
      }
    }
    // 價格（中央）
    if (showNum) {
      ctx.font = `${isMidRow ? "bold " : ""}${fpx}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = isMidRow ? (perf ? "#111" : "#ffffff")
        : (p >= _domMid ? (perf ? "#8a3b39" : "rgba(255,190,186,0.8)")
                        : (perf ? "#1c6b57" : "rgba(170,240,225,0.8)"));
      ctx.fillText(_domFmtP(p), midX, cy);
    }
  }
  // 中線分隔（現價交界）
  const midIdx = _domRows.findIndex(r => _domBin > 0 && Math.abs(r.p - _domMid) <= _domBin / 2 + 1e-9);
  if (midIdx >= 0) {
    const yl = (midIdx + 1) * rowH;
    ctx.strokeStyle = perf ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yl); ctx.lineTo(cssW, yl); ctx.stroke();
  }
}

window.toggleDom = function (on) {
  _domShow = (on === undefined) ? !_domShow : !!on;
  clearInterval(_domTimer); _domTimer = null;
  const panel = document.getElementById("domPanel");
  if (panel) panel.classList.toggle("on", _domShow);
  const b = document.getElementById("domBtn");
  if (b) b.classList.toggle("on", _domShow);
  // 讓主圖 canvas 重新讓出/收回右側面板寬度
  if (typeof resizeAll === "function") { try { resizeAll(); } catch {} }
  else if (window.resizeAll) { try { window.resizeAll(); } catch {} }
  if (_domShow) {
    _domMsg = ""; _domSym = "";
    requestAnimationFrame(() => { _domRender(); _domFetch(); });
    _domTimer = setInterval(_domFetch, 1500);   // 盤口變化快，1.5s 一輪（後端 1.2s 快取＋權重閘門）
  } else {
    _domRows = []; _domRender();
  }
  return _domShow;
};

// 面板尺寸隨版面變動時重繪（縮放視窗/開關副圖）
window.addEventListener("resize", () => { if (_domShow) requestAnimationFrame(_domRender); });

// ── 「訂單簿」開關按鈕（靜態放在時框行 .tf-group，index.html）───────
function _domBtnRefresh() {
  const b = document.getElementById("domBtn");
  if (!b) return;
  const isCrypto = (document.getElementById("marketSelect")?.value || "crypto") === "crypto";
  b.style.display = isCrypto ? "" : "none";
  if (!isCrypto && _domShow) window.toggleDom(false);
  b.classList.toggle("on", _domShow);
}

function _domBtnInit() {
  const b = document.getElementById("domBtn");
  if (b && !b._domBound) { b._domBound = true; b.addEventListener("click", () => window.toggleDom()); }
  _domBtnRefresh();
  document.getElementById("marketSelect")?.addEventListener("change", () => setTimeout(_domBtnRefresh, 0));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _domBtnInit);
else _domBtnInit();
