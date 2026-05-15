function toTime(s) {
  if (!s) return 0;
  const iso = s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000) + 8 * 3600;
}

/* ── hex + 透明度 ── */
function hexAlpha(hex, opacity) {
  const a = Math.round(Math.max(0, Math.min(100, opacity)) / 100 * 255)
    .toString(16).padStart(2, "0");
  return hex + a;
}

/* ── localStorage ── */
function savePrefs() {
  try {
    localStorage.setItem("chartColors",     JSON.stringify(C));
    localStorage.setItem("chartStyles",     JSON.stringify(S));
    localStorage.setItem("chartLineStyles", JSON.stringify(LINE_STYLES));
  } catch {}
}
function loadPrefs() {
  try {
    Object.assign(C, JSON.parse(localStorage.getItem("chartColors") || "{}"));
    Object.assign(S, JSON.parse(localStorage.getItem("chartStyles") || "{}"));
    Object.assign(LINE_STYLES, JSON.parse(localStorage.getItem("chartLineStyles") || "{}"));
  } catch {}
}

function saveLastSymbol() {
  try {
    const r = mainChart?.timeScale().getVisibleLogicalRange();
    const rangeBarCount = r ? Math.max(1, Math.round(r.to - r.from)) : null;
    const rangeToOffset = (r && ohlcvData.length) ? Math.max(0, ohlcvData.length - 1 - Math.round(r.to)) : null;
    localStorage.setItem("lastSymbol", JSON.stringify({
      symbol:   document.getElementById("symbolInput")?.value  || "",
      exchange: document.getElementById("exchangeSelect")?.value || "pionex",
      market:   document.getElementById("marketSelect")?.value  || "crypto",
      tf:       currentTF,
      rangeBarCount, rangeToOffset,
    }));
  } catch {}
}

function loadLastSymbol() {
  try {
    const last = JSON.parse(localStorage.getItem("lastSymbol") || "null");
    if (!last || !last.symbol) return;
    document.getElementById("symbolInput").value = last.symbol;
    if (last.exchange) document.getElementById("exchangeSelect").value = last.exchange;
    if (last.market)   document.getElementById("marketSelect").value   = last.market;
    if (last.tf && TF_LABELS[last.tf]) {
      currentTF = last.tf;
      document.querySelectorAll(".tf-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tf === currentTF));
    }
    if (last.rangeBarCount != null) {
      _pendingRestoreRange = { barCount: last.rangeBarCount, toOffset: last.rangeToOffset ?? 0 };
    }
  } catch {}
}

/* 將 LINE_STYLES 中儲存的線寬 / 樣式套用到對應 series */
function applyLineStyle(inputId) {
  const getter = INPUT_SERIES_MAP[inputId];
  if (!getter) return;
  const series = getter();
  if (!series) return;
  const ls = LINE_STYLES[inputId];
  if (!ls) return;
  const opts = {};
  if (ls.width != null) opts.lineWidth  = ls.width;
  if (ls.style != null) opts.lineStyle  = ls.style;
  if (Object.keys(opts).length) series.applyOptions(opts);
}

/* 頁面載入後重新套用所有儲存的線條樣式 */
function applyAllLineStyles() {
  Object.keys(LINE_STYLES).forEach(applyLineStyle);
  // ⚙ popup 的設定（S）優先，覆蓋 LINE_STYLES 可能帶來的舊值
  rsiLine14?.applyOptions({ lineWidth: S.rsi14Width,    lineStyle: S.rsi14Style });
  rsiLine7?.applyOptions({  lineWidth: S.rsi7Width,     lineStyle: S.rsi7Style  });
  kdjK?.applyOptions({      lineWidth: S.kdjKWidth,     lineStyle: S.kdjKStyle  });
  kdjD?.applyOptions({      lineWidth: S.kdjDWidth,     lineStyle: S.kdjDStyle  });
  kdjJ?.applyOptions({      lineWidth: S.kdjJWidth,     lineStyle: S.kdjJStyle  });
  bbU?.applyOptions({       lineWidth: S.bbWidth  });
  bbL?.applyOptions({       lineWidth: S.bbWidth  });
  bbM?.applyOptions({       lineWidth: S.bbMWidth });
  macdLine?.applyOptions({  lineWidth: S.macdWidth,    lineStyle: S.macdStyle    });
  macdSignal?.applyOptions({ lineWidth: S.macdSigWidth, lineStyle: S.macdSigStyle });
}

function savePaneFlexes() {
  if (_restoringPrefs) return;
  const flexes = {};
  Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
    const el  = document.getElementById(id);
    if (!el) return;
    const btn = document.querySelector(`.pane-collapse-btn[data-pane="${id}"]`);
    const isCollapsed = btn?.dataset.collapsed === "true";
    // 收合時儲存收合前的 flex；否則儲存目前 flex
    flexes[id] = isCollapsed
      ? (parseFloat(paneCollapseFlex[id]) || PANE_FLEX_DEFAULTS[id])
      : (parseFloat(el.style.flex)        || PANE_FLEX_DEFAULTS[id]);
  });
  try { localStorage.setItem("paneFlexes", JSON.stringify(flexes)); } catch {}
}

function loadPaneFlexes() {
  try {
    const saved = JSON.parse(localStorage.getItem("paneFlexes") || "{}");
    Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const flex = saved[id] ?? PANE_FLEX_DEFAULTS[id];
      el.style.flex = flex;
    });
  } catch {}
}

function saveVisibilityPrefs() {
  if (_restoringPrefs) return;  // 還原中不觸發儲存
  try {
    const hiddenLegs = [];
    document.querySelectorAll(".leg-toggle.line-off").forEach(el => {
      if (el.id) hiddenLegs.push(el.id);
    });
    const collapsedPanes = {};
    document.querySelectorAll(".pane-collapse-btn").forEach(btn => {
      if (btn.dataset.collapsed === "true")
        collapsedPanes[btn.dataset.pane] = paneCollapseFlex[btn.dataset.pane] || "1";
    });
    localStorage.setItem("hiddenLegs",     JSON.stringify(hiddenLegs));
    localStorage.setItem("collapsedPanes", JSON.stringify(collapsedPanes));
  } catch {}
}

function loadVisibilityPrefs() {
  _restoringPrefs = true;
  try {
    // 恢復隱藏的圖例線條
    const hiddenLegs = JSON.parse(localStorage.getItem("hiddenLegs") || "[]");
    hiddenLegs.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("line-off")) el.click();
    });
    // 恢復收合的面板
    const collapsedPanes = JSON.parse(localStorage.getItem("collapsedPanes") || "{}");
    for (const [paneId, flex] of Object.entries(collapsedPanes)) {
      paneCollapseFlex[paneId] = flex;
      const btn = document.querySelector(`.pane-collapse-btn[data-pane="${paneId}"]`);
      if (btn && btn.dataset.collapsed !== "true") btn.click();  // 未收合則點擊收合
    }
  } catch {}
  _restoringPrefs = false;
  saveVisibilityPrefs();  // 還原完成後統一儲存一次
}

/* ── 基礎圖表選項（showTime=true 才顯示時間軸，只有最下方的圖顯示）── */

function buildPayload() {
  const sym = document.getElementById("symbolInput").value.trim();
  return {
    market:    document.getElementById("marketSelect").value,
    symbol:    sym,
    start:     "",
    end:       "",
    limit:     { "1M":120,"1w":520,"1d":1095,"4h":2190,"1h":2160,"15m":2000,"5m":2000 }[currentTF] ?? 500,
    timeframe: currentTF,
    exchange:  document.getElementById("exchangeSelect").value,
  };
}

/* 更新圖例文字，只改 .leg-val，dot 完全不碰 */
function _setLegText(id, text) {
  const val = document.querySelector(`#${id} .leg-val`);
  if (val) val.textContent = text;
}

function fmt(v)    { return v!=null ? Number(v).toLocaleString(undefined,{maximumFractionDigits:4}) : "—"; }
function n2(v)     { return v!=null ? Number(v).toFixed(2) : "—"; }
function _fmtPx(p) {
  if (!isFinite(p)) return "—";
  const a = Math.abs(p);
  if (a >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 100)   return p.toFixed(2);
  if (a >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}
function fmtVol(v) {
  if (v==null) return "—";
  if (v>=1e9) return (v/1e9).toFixed(2)+"B";
  if (v>=1e6) return (v/1e6).toFixed(2)+"M";
  if (v>=1e3) return (v/1e3).toFixed(1)+"K";
  return Number(v).toLocaleString();
}
function fmtT(s)   { return s ? s.replace("T"," ").substring(0,16) : "—"; }

function showToast(msg, ms = 4000) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#2a2e39;border:1px solid #ef5350;color:#d1d4dc;padding:8px 18px;border-radius:6px;z-index:9999;font-size:12px;pointer-events:none";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function showLoading(show) {
  let el = document.getElementById("loadingOverlay");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "loadingOverlay"; el.className = "loading-overlay";
      el.innerHTML = `<div class="loading-inner"><img src="/static/img/bear.png" class="loading-bear"/><span class="loading-text">處理中...</span></div>`;
      document.body.appendChild(el);
    }
  } else { el?.remove(); }
}

