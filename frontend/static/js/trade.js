/* ══════════════════════════════════════════════════════════════
   Binance 永續交易面板（手動下單 + 自動交易設定）
   - 後端 /api/trade/*：金鑰只在伺服器 env；前端只帶「交易口令」（TRADE_ACCESS_KEY，
     輸入一次存 localStorage["tradeKey"]）。後端未設 Binance 金鑰 → 入口自動隱藏。
   - 預設 testnet 測試網：面板頂部明確顯示 測試網/實盤 徽章。
   - 自動交易：勾選策略訊號 + 時框 + 每筆保證金/槓桿 → 後端訊號監控器自動下單，
     交易所託管停損/止盈 + 策略止盈止損訊號同步平倉。
   - 入口：桌面「系統外觀」彈窗 + 手機設定分頁（沿用 notify.js 模式）
   ══════════════════════════════════════════════════════════════ */
const _TRD = { st: null, ov: null, pollTimer: null, busy: false };

const _TRD_SIG_ORDER = ["ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "abc", "12", "ss1"];
const _TRD_ALL_TFS = ["5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w"];

const _TRD_ICO = `<svg class="trd-ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 9.5h-6.5L13 2Z"/></svg>`;

function _trdKey() { try { return localStorage.getItem("tradeKey") || ""; } catch (e) { return ""; } }
function _trdSigLabel(k) { return k === "abc" ? "S1" : k === "ab" ? "S2" : k === "ss1" ? "SS1" : "S" + k; }

async function _trdApi(path, body) {
  // 一律帶上 key（口令）+ name（登入帳號，供後端 owner 白名單檢查）；body 同名欄位可覆寫
  const r = await fetch("/api/trade/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ key: _trdKey(), name: window._acctName || "" }, body || {})),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || ("錯誤 " + r.status));
  return j;
}

function _trdMsg(t, isErr) {
  const el = document.querySelector("#tradePopup .trd-msg");
  if (el) { el.textContent = t || ""; el.classList.toggle("trd-err", !!isErr); }
}

function _trdFmt(n, dp) {
  if (n === null || n === undefined || !isFinite(n)) return "-";
  const v = +n;
  if (dp !== undefined) return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1) return String(+v.toPrecision(5));
  return String(+v.toPrecision(4));
}

// ── 資料載入 ──────────────────────────────────────────────────
async function _trdRefresh() {
  if (_TRD.busy) return;
  _TRD.busy = true;
  try {
    _TRD.ov = await _trdApi("overview");
    _trdRenderOverview();
    _trdMsg("");
  } catch (e) {
    _trdMsg(e.message, true);
    if (/口令/.test(e.message)) _trdShowKeyRow(true);
  } finally { _TRD.busy = false; }
}

function _trdRenderOverview() {
  const ov = _TRD.ov;
  if (!ov) return;
  const pop = document.getElementById("tradePopup");
  if (!pop) return;
  const b = ov.balance || {};
  pop.querySelector(".trd-bal").innerHTML =
    `餘額 <b>${_trdFmt(b.total, 2)}</b> · 可用 <b>${_trdFmt(b.available, 2)}</b> USDT` +
    (b.unrealized ? ` · 未實現 <b class="${b.unrealized >= 0 ? "trd-up" : "trd-dn"}">${_trdFmt(b.unrealized, 2)}</b>` : "");

  // 持倉
  const posEl = pop.querySelector(".trd-pos");
  const pos = ov.positions || [];
  posEl.innerHTML = !pos.length ? `<div class="trd-empty">無持倉</div>` : pos.map(p => `
    <div class="trd-row">
      <span class="trd-side ${p.side === "long" ? "trd-up" : "trd-dn"}">${p.side === "long" ? "多" : "空"}</span>
      <span class="trd-sym">${p.symbol}<small>×${p.lev}</small></span>
      <span class="trd-nums">${_trdFmt(p.qty)} @ ${_trdFmt(p.entry)}</span>
      <span class="trd-pnl ${p.upnl >= 0 ? "trd-up" : "trd-dn"}">${p.upnl >= 0 ? "+" : ""}${_trdFmt(p.upnl, 2)}</span>
      <button class="trd-x" data-bsym="${p.symbol}">平倉</button>
    </div>`).join("");
  posEl.querySelectorAll(".trd-x").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    if (!confirm(`確定市價平倉 ${btn.dataset.bsym}？`)) return;
    try { await _trdApi("close", { bsym: btn.dataset.bsym }); _trdMsg("已平倉"); _trdRefresh(); }
    catch (err) { _trdMsg(err.message, true); }
  }));

  // 掛單（限價 / TP / SL）
  const ordEl = pop.querySelector(".trd-ord");
  const ords = ov.orders || [];
  ordEl.innerHTML = !ords.length ? "" : `<div class="trd-sub">掛單</div>` + ords.map(o => `
    <div class="trd-row trd-row-sm">
      <span class="trd-sym">${o.symbol}</span>
      <span class="trd-nums">${o.type.replace("_MARKET", "")} ${o.side === "BUY" ? "買" : "賣"} ${o.stopPrice ? "@" + _trdFmt(o.stopPrice) : "@" + _trdFmt(o.price)}</span>
      <button class="trd-x" data-bsym="${o.symbol}" data-oid="${o.orderId}">撤</button>
    </div>`).join("");
  ordEl.querySelectorAll(".trd-x").forEach(btn => btn.addEventListener("click", async e => {
    e.stopPropagation();
    try { await _trdApi("cancel", { bsym: btn.dataset.bsym, orderId: +btn.dataset.oid }); _trdRefresh(); }
    catch (err) { _trdMsg(err.message, true); }
  }));

  // 自動交易設定
  const a = ov.auto || {};
  pop.querySelector(".trd-auto-toggle").classList.toggle("trd-on", !!a.on);
  pop.querySelector(".trd-auto-toggle").textContent = a.on ? "自動交易：開" : "自動交易：關";
  pop.querySelectorAll(".trd-a-sig").forEach(x => x.classList.toggle("sel", (a.sigs || []).includes(x.dataset.sig)));
  pop.querySelectorAll(".trd-a-tf").forEach(x => x.classList.toggle("sel", (a.tfs || []).includes(x.dataset.tf)));
  const $ = id => pop.querySelector(id);
  if (document.activeElement !== $("#trdAutoUsdt")) $("#trdAutoUsdt").value = a.usdt ?? 50;
  if (document.activeElement !== $("#trdAutoRisk")) $("#trdAutoRisk").value = a.riskUsd ?? 0;
  if (document.activeElement !== $("#trdAutoLev")) $("#trdAutoLev").value = a.lev ?? 3;
  if (document.activeElement !== $("#trdAutoMax")) $("#trdAutoMax").value = a.maxPos ?? 3;
  if ($("#trdAutoDirs").value !== a.dirs) $("#trdAutoDirs").value = a.dirs || "both";
  if (document.activeElement !== $("#trdAutoSl")) $("#trdAutoSl").value = a.slPct ?? 0;
  const sal = $("#trdAutoSal");
  if (sal) { sal.classList.toggle("sel", !!a.stopAfterLoss); sal.textContent = a.stopAfterLoss ? "開" : "關"; }
  _trdRenderPerSym();
}

// 各「標的×時間框」止損緩衝%：列出合約自選標的，依選的自動交易時框各一個輸入框（留空＝用全域）。
// key 格式：「標的|時框」（有選時框時）或「標的」（沒選時框時，全時框共用）。
let _trdPerSymSig = "";
function _trdRenderPerSym() {
  const box = document.getElementById("trdPerSym");
  if (!box) return;
  const wl = (typeof _watchlist !== "undefined" ? _watchlist : []);
  const syms = [...new Set(wl.filter(w => w.market === "crypto").map(w => w.symbol))];
  const a = (_TRD.ov && _TRD.ov.auto) || {};
  const ps = a.perSym || {};
  const tfs = (a.tfs || []).slice();
  const sig = syms.join(",") + "#" + tfs.join(",");
  if (sig === _trdPerSymSig) {   // 標的/時框集合沒變 → 只更新非聚焦輸入的值（不重建、不打斷輸入）
    box.querySelectorAll(".trd-ps-in").forEach(inp => {
      if (document.activeElement !== inp) { const v = ps[inp.dataset.key]; inp.value = (v != null ? v : ""); }
    });
    return;
  }
  _trdPerSymSig = sig;
  if (!syms.length) { box.innerHTML = `<div class="trd-empty">自選清單沒有合約標的</div>`; return; }
  const cell = key => `<input class="trd-ps-in" data-key="${key}" type="number" min="0" max="50" step="0.1" placeholder="預設" value="${ps[key] != null ? ps[key] : ""}">`;
  box.innerHTML = syms.map(s => {
    if (!tfs.length) {   // 沒選時框 → 每標的一個（全時框共用）
      return `<div class="trd-ps-row"><span class="trd-ps-sym" title="${s}">${s}</span>${cell(s)}</div>`;
    }
    // 有選時框 → 標的標頭 + 各時框一格
    return `<div class="trd-ps-sym-hd">${s}</div>`
      + `<div class="trd-ps-tfs">` + tfs.map(t =>
          `<span class="trd-ps-tf"><b>${t}</b>${cell(s + "|" + t)}</span>`).join("") + `</div>`;
  }).join("");
  box.querySelectorAll(".trd-ps-in").forEach(inp => inp.addEventListener("change", e => {
    e.stopPropagation();
    const a2 = _TRD.ov.auto = _TRD.ov.auto || {};
    a2.perSym = a2.perSym || {};
    const v = +inp.value;
    if (v > 0) a2.perSym[inp.dataset.key] = v; else delete a2.perSym[inp.dataset.key];
    _trdSaveAuto();
  }));
}

let _trdAutoSaveTimer = null;
function _trdSaveAuto() {
  const pop = document.getElementById("tradePopup");
  if (!pop || !_TRD.ov) return;
  const a = _TRD.ov.auto = _TRD.ov.auto || {};
  a.sigs = [...pop.querySelectorAll(".trd-a-sig.sel")].map(x => x.dataset.sig);
  a.tfs = [...pop.querySelectorAll(".trd-a-tf.sel")].map(x => x.dataset.tf);
  a.usdt = +pop.querySelector("#trdAutoUsdt").value || 50;
  a.riskUsd = Math.max(0, +pop.querySelector("#trdAutoRisk").value || 0);
  a.lev = +pop.querySelector("#trdAutoLev").value || 3;
  a.maxPos = +pop.querySelector("#trdAutoMax").value || 3;
  a.dirs = pop.querySelector("#trdAutoDirs").value;
  a.slPct = Math.max(0, +pop.querySelector("#trdAutoSl").value || 0);
  a.stopAfterLoss = pop.querySelector("#trdAutoSal").classList.contains("sel");
  a.owner = window._acctName || "";   // 綁定擁有者帳號 → 只自動交易此帳號的自選（防別人自選下你的單）
  clearTimeout(_trdAutoSaveTimer);
  _trdAutoSaveTimer = setTimeout(async () => {
    try { await _trdApi("auto", { cfg: a }); _trdMsg("自動交易設定已儲存"); }
    catch (e) { _trdMsg(e.message, true); }
  }, 500);
}

// ── 下單 ─────────────────────────────────────────────────────
async function _trdSubmit() {
  const pop = document.getElementById("tradePopup");
  const sym = pop.querySelector("#trdSym").value.trim();
  const side = pop.querySelector(".trd-side-btn.sel")?.dataset.side || "long";
  const type = pop.querySelector(".trd-type-btn.sel")?.dataset.type || "MARKET";
  const usdt = +pop.querySelector("#trdUsdt").value;
  const lev = +pop.querySelector("#trdLev").value || 3;
  const price = +pop.querySelector("#trdPrice").value || null;
  const sl = +pop.querySelector("#trdSl").value || null;
  const tp = +pop.querySelector("#trdTp").value || null;
  if (!sym) { _trdMsg("請輸入標的", true); return; }
  if (!usdt || usdt <= 0) { _trdMsg("請輸入保證金（USDT）", true); return; }
  if (type === "LIMIT" && !price) { _trdMsg("限價單需要價格", true); return; }
  const envTxt = _TRD.st && _TRD.st.env === "live" ? "【實盤】" : "【測試網】";
  if (!confirm(`${envTxt}${side === "long" ? "做多" : "做空"} ${sym}\n保證金 ${usdt} USDT × ${lev}x = 名目 ${usdt * lev} USDT\n確定下單？`)) return;
  _trdMsg("下單中…");
  try {
    const j = await _trdApi("order", { symbol: sym, side, type, usdt, lev, price, sl, tp });
    _trdMsg(`已下單 ${j.bsym} ×${j.qty}` + (j.warn && j.warn.length ? `（⚠ ${j.warn.join("；")}）` : ""), j.warn && j.warn.length);
    _trdRefresh();
  } catch (e) { _trdMsg(e.message, true); }
}

// ── UI 建構 ───────────────────────────────────────────────────
function _trdShowKeyRow(show) {
  const row = document.querySelector("#tradePopup .trd-key-row");
  if (row) row.style.display = show ? "flex" : "none";
}

function _trdBuildPopup() {
  if (document.getElementById("tradePopup")) return;
  const css = document.createElement("style");
  css.textContent = `
    #tradePopup { max-width: 340px; max-height: 78vh; overflow-y: auto; }
    #tradePopup .trd-env { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; margin-left:6px; vertical-align:1px; }
    #tradePopup .trd-env-test { background:#2a6f4e33; color:#4cc38a; border:1px solid #4cc38a66; }
    #tradePopup .trd-env-live { background:#7f1d1d44; color:#f87171; border:1px solid #f8717188; }
    #tradePopup .trd-bal { font-size:12px; color:var(--muted,#99a); margin:6px 0; }
    #tradePopup .trd-bal b { color:var(--text,#ddd); font-weight:600; }
    #tradePopup .trd-up { color:#4cc38a; } #tradePopup .trd-dn { color:#f06a6a; }
    #tradePopup .trd-sub { font-size:11px; color:var(--muted,#889); margin:8px 0 3px; }
    #tradePopup .trd-seg { display:flex; gap:5px; margin:4px 0; }
    #tradePopup .trd-seg button { flex:1; padding:5px 0; border-radius:8px; border:1px solid var(--border,#445);
      background:transparent; color:var(--muted,#99a); cursor:pointer; font-size:12px; }
    #tradePopup .trd-side-btn.sel[data-side="long"] { background:#2a6f4e; color:#fff; border-color:transparent; }
    #tradePopup .trd-side-btn.sel[data-side="short"] { background:#9f3a3a; color:#fff; border-color:transparent; }
    #tradePopup .trd-type-btn.sel, #tradePopup .trd-chip.sel { background:var(--blue,#4a90d9); color:#fff; border-color:transparent; }
    #tradePopup .trd-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin:4px 0; }
    #tradePopup .trd-grid label { font-size:10px; color:var(--muted,#889); display:block; margin-bottom:2px; }
    #tradePopup input, #tradePopup select { width:100%; box-sizing:border-box; padding:5px 7px; border-radius:7px;
      border:1px solid var(--border,#445); background:transparent; color:var(--text,#ddd); font-size:12px; }
    #tradePopup .trd-go { width:100%; padding:8px; margin:6px 0 2px; border-radius:8px; border:none;
      background:var(--blue,#4a90d9); color:#fff; cursor:pointer; font-size:13px; font-weight:600; }
    #tradePopup .trd-row { display:flex; align-items:center; gap:6px; padding:4px 0; font-size:12px;
      border-bottom:1px dashed var(--border,#3a3a50); }
    #tradePopup .trd-row-sm { font-size:11px; }
    #tradePopup .trd-row .trd-sym { flex:1; color:var(--text,#ddd); } #tradePopup .trd-sym small { color:var(--muted,#889); margin-left:3px; }
    #tradePopup .trd-row .trd-nums { color:var(--muted,#99a); font-size:11px; }
    #tradePopup .trd-x { padding:2px 8px; border-radius:7px; border:1px solid var(--border,#445);
      background:transparent; color:#f06a6a; cursor:pointer; font-size:11px; }
    #tradePopup .trd-empty { font-size:11px; color:var(--muted,#778); padding:4px 0; }
    #tradePopup .trd-chips { display:flex; flex-wrap:wrap; gap:4px; }
    #tradePopup .trd-chip { padding:2px 8px; border-radius:11px; border:1px solid var(--border,#445);
      background:transparent; color:var(--muted,#99a); cursor:pointer; font-size:11px; }
    #tradePopup .trd-auto-toggle { width:100%; padding:7px; margin:4px 0; border-radius:8px; border:1px solid var(--border,#445);
      background:transparent; color:var(--text,#ddd); cursor:pointer; font-size:12px; }
    #tradePopup .trd-auto-toggle.trd-on { background:#2a6f4e; color:#fff; border-color:transparent; }
    #tradePopup .trd-msg { font-size:11px; color:var(--muted,#889); margin-top:6px; min-height:14px; white-space:pre-wrap; }
    #tradePopup .trd-msg.trd-err { color:#e57; }
    #tradePopup .trd-key-row { display:none; gap:5px; margin:4px 0; }
    #tradePopup hr { border:none; border-top:1px solid var(--border,#3a3a50); margin:8px 0; }
    .trd-ico { vertical-align:-2px; }
    .trd-entry .trd-ico { margin-right:4px; }
    /* 桌面：完整交易面板嵌在合約行情面板底部，可收合 */
    #trdDock { flex:0 0 auto; display:flex; flex-direction:column; min-height:0;
      border-top:1px solid var(--border,#3a3a50); background:var(--bg2,#1a1a28); }
    #trdDock .trd-dock-hd { flex:0 0 auto; display:flex; align-items:center; gap:5px;
      padding:4px 10px; cursor:pointer; font-size:12px; font-weight:700; color:var(--text,#ddd);
      user-select:none; -webkit-tap-highlight-color:transparent; }
    #trdDock .trd-dock-hd:hover { background:rgba(255,255,255,.04); }
    #trdDock .trd-dock-hd .trd-ico { width:13px; height:13px; }
    #trdDock .trd-dock-hd .trd-env { padding:0 6px; font-size:10px; }
    #trdDock .trd-dock-hd .trd-dock-caret { margin-left:auto; color:var(--muted,#889);
      transition:transform .18s ease; font-size:10px; }
    #trdDock.trd-collapsed .trd-dock-caret { transform:rotate(-90deg); }
    #trdDock .trd-dock-body { flex:1 1 auto; min-height:0; overflow-y:auto; max-height:46vh; }
    #tradePopup .trd-bind { display:none; }
    #tradePopup.trd-need-bind .trd-bind { display:block; }
    #tradePopup.trd-need-bind .trd-main { display:none; }
    #tradePopup .trd-bind .trd-bsub { font-size:11px; color:var(--muted,#889); margin:8px 0 4px; }
    #tradePopup .trd-bind input, #tradePopup .trd-bind select { margin-bottom:6px; }
    #tradePopup .trd-bind .trd-go { margin-top:2px; }
    #tradePopup .trd-persym { display:flex; flex-direction:column; gap:3px; max-height:160px; overflow-y:auto; margin-bottom:4px; }
    #tradePopup .trd-ps-row { display:flex; align-items:center; gap:6px; }
    #tradePopup .trd-ps-sym { flex:1; font-size:11px; color:var(--muted,#99a); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #tradePopup .trd-ps-in { width:74px; flex:0 0 auto; padding:3px 6px; font-size:11px; }
    #tradePopup .trd-ps-sym-hd { font-size:11px; color:var(--text,#ddd); font-weight:700; margin-top:5px; }
    #tradePopup .trd-ps-tfs { display:flex; flex-wrap:wrap; gap:6px 8px; margin:2px 0 2px 4px; }
    #tradePopup .trd-ps-tf { display:flex; align-items:center; gap:3px; font-size:10px; color:var(--muted,#99a); }
    #tradePopup .trd-ps-tf .trd-ps-in { width:50px; }
    #trdDock.trd-collapsed .trd-dock-body { display:none; }
    /* 嵌入態的交易面板：取消浮窗定位，貼齊面板寬度 */
    #tradePopup.trd-docked { display:block !important; position:static !important;
      width:auto !important; max-width:none !important; max-height:none !important;
      border:none !important; border-radius:0 !important; box-shadow:none !important;
      background:transparent !important; padding:4px 12px 12px !important; z-index:auto !important; }
    #tradePopup.trd-docked .sys-sp-title { display:none; }
  `;
  document.head.appendChild(css);

  const pop = document.createElement("div");
  pop.id = "tradePopup";
  pop.className = "sys-settings-popup";
  const envBadge = _TRD.st.env === "live"
    ? `<span class="trd-env trd-env-live">實盤</span>`
    : `<span class="trd-env trd-env-test">測試網</span>`;
  const sigChips = _TRD_SIG_ORDER.map(s => `<button class="trd-chip trd-a-sig" data-sig="${s}">${_trdSigLabel(s)}</button>`).join("");
  const tfChips = _TRD_ALL_TFS.map(t => `<button class="trd-chip trd-a-tf" data-tf="${t}">${t}</button>`).join("");
  pop.innerHTML = `
    <div class="sys-sp-title">${_TRD_ICO} 交易${envBadge}</div>
    <div class="trd-key-row">
      <input id="trdKeyInput" type="password" placeholder="交易口令（TRADE_ACCESS_KEY）">
      <button class="trd-x trd-key-save" style="color:var(--text,#ddd)">確定</button>
    </div>
    <div class="trd-bind">
      <div class="trd-bsub">綁定你自己的 Binance 永續金鑰（只存伺服器、加密保存；交易進你自己的帳戶）</div>
      <input id="trdBindKey" type="text" placeholder="API Key" autocomplete="off">
      <input id="trdBindSec" type="password" placeholder="API Secret" autocomplete="off">
      <select id="trdBindEnv"><option value="testnet">測試網（假錢）</option><option value="live">實盤（真錢）</option></select>
      <button class="trd-go" id="trdBindBtn">驗證並綁定</button>
      <div class="trd-bsub">提示：API 金鑰請開「合約交易」權限、勿開提現權限。</div>
    </div>
    <div class="trd-main">
    <div class="trd-bal">載入中…</div>
    <div class="trd-sub">手動下單</div>
    <input id="trdSym" type="text" placeholder="標的（如 BTC/USDT.P）" style="margin-bottom:4px">
    <div class="trd-seg">
      <button class="trd-side-btn sel" data-side="long">做多</button>
      <button class="trd-side-btn" data-side="short">做空</button>
    </div>
    <div class="trd-seg">
      <button class="trd-type-btn sel" data-type="MARKET">市價</button>
      <button class="trd-type-btn" data-type="LIMIT">限價</button>
    </div>
    <div class="trd-grid">
      <div><label>保證金 USDT</label><input id="trdUsdt" type="number" min="1" value="50"></div>
      <div><label>槓桿</label><input id="trdLev" type="number" min="1" max="50" value="3"></div>
      <div><label>限價（限價單）</label><input id="trdPrice" type="number" step="any" placeholder="-"></div>
      <div><label>&nbsp;</label><span></span></div>
      <div><label>停損價（選填）</label><input id="trdSl" type="number" step="any" placeholder="-"></div>
      <div><label>止盈價（選填）</label><input id="trdTp" type="number" step="any" placeholder="-"></div>
    </div>
    <button class="trd-go">下單</button>
    <div class="trd-sub">持倉</div>
    <div class="trd-pos"></div>
    <div class="trd-ord"></div>
    <hr>
    <button class="trd-auto-toggle">自動交易：關</button>
    <div class="trd-sub">自動交易訊號</div>
    <div class="trd-chips">${sigChips}</div>
    <div class="trd-sub">自動交易時框</div>
    <div class="trd-chips">${tfChips}</div>
    <div class="trd-grid">
      <div><label>每筆風險 $（0=用保證金）</label><input id="trdAutoRisk" type="number" min="0" step="1" placeholder="0"></div>
      <div><label>槓桿（風險模式=上限）</label><input id="trdAutoLev" type="number" min="1" max="50"></div>
      <div><label>每筆保證金 USDT（風險=0時用）</label><input id="trdAutoUsdt" type="number" min="1"></div>
      <div><label>最大同時持倉</label><input id="trdAutoMax" type="number" min="1" max="20"></div>
      <div><label>方向</label><select id="trdAutoDirs">
        <option value="both">多空都做</option><option value="long">只做多</option><option value="short">只做空</option>
      </select></div>
      <div><label>止損緩衝 %（策略停損外推；0=用策略停損）</label><input id="trdAutoSl" type="number" min="0" max="50" step="0.1" placeholder="0"></div>
      <div><label>敗後停手</label><button id="trdAutoSal" class="trd-chip" style="width:100%;padding:6px 0">關</button></div>
    </div>
    <div class="trd-sub">各標的×時框 止損緩衝 %（留空＝用上方預設；選了自動交易時框才分時框）</div>
    <div class="trd-persym" id="trdPerSym"></div>
    <div class="trd-sub" style="color:#b8a06a">⚠ 自動交易掃描的標的＝帳號自選清單（僅合約），且帳號需至少一台裝置啟用訊號通知。進場後停損/止盈由交易所託管，策略提前止盈止損時會同步平倉。</div>
    </div>
    <div class="trd-msg"></div>`;
  document.body.appendChild(pop);

  pop.querySelectorAll(".trd-side-btn").forEach(b => b.addEventListener("click", () => {
    pop.querySelectorAll(".trd-side-btn").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel");
  }));
  pop.querySelectorAll(".trd-type-btn").forEach(b => b.addEventListener("click", () => {
    pop.querySelectorAll(".trd-type-btn").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel");
  }));
  pop.querySelector(".trd-go").addEventListener("click", e => { e.stopPropagation(); _trdSubmit(); });
  pop.querySelector(".trd-key-save").addEventListener("click", e => {
    e.stopPropagation();
    const v = pop.querySelector("#trdKeyInput").value.trim();
    try { localStorage.setItem("tradeKey", v); } catch (err) {}
    // 口令跟著帳戶：寫穿伺服器（/savekey）→ 換裝置登入用 /mykey 取回、不必再輸。
    // 不靠整包 localStorage 快照（會被別台舊快照蓋掉、登入時機不對就帶不到）。
    if (window._acctName) {
      _trdApi("savekey", { name: window._acctName, tkey: v }).catch(() => {});
    } else {
      _trdMsg("已存本機。提醒：登入帳號後口令才會跟著帳戶、換裝置免再輸", false);
    }
    _trdShowKeyRow(false); _trdRefresh();
  });
  // 綁定自己的 Binance 金鑰
  pop.querySelector("#trdBindBtn").addEventListener("click", async e => {
    e.stopPropagation();
    if (!window._acctName) { _trdMsg("請先登入帳號", true); return; }
    const api_key = pop.querySelector("#trdBindKey").value.trim();
    const api_secret = pop.querySelector("#trdBindSec").value.trim();
    const env = pop.querySelector("#trdBindEnv").value;
    if (!api_key || !api_secret) { _trdMsg("請填入 API Key 與 Secret", true); return; }
    if (env === "live" && !confirm("綁定【實盤】金鑰？之後下單會動用真錢。確定？")) return;
    _trdMsg("驗證金鑰中…");
    try {
      const j = await _trdApi("bind", { name: window._acctName, api_key, api_secret, env });
      _trdMsg(`綁定成功（${env === "live" ? "實盤" : "測試網"}）餘額 ${(+j.balance.total).toFixed(2)} USDT`);
      pop.querySelector("#trdBindSec").value = "";
      // 重抓 status → 切到交易介面
      try { _TRD.st = await (await fetch("/api/trade/status?name=" + encodeURIComponent(window._acctName))).json(); } catch (er) {}
      _trdApplyMode(); _trdRefresh();
    } catch (er) { _trdMsg(er.message, true); }
  });
  pop.querySelector(".trd-auto-toggle").addEventListener("click", async e => {
    e.stopPropagation();
    if (!_TRD.ov) return;
    const a = _TRD.ov.auto = _TRD.ov.auto || {};
    const turningOn = !a.on;
    if (turningOn) {
      if (!window._acctName) { _trdMsg("請先登入帳號再開自動交易（自動交易只會下你帳號自選的標的）", true); return; }
      const envTxt = _TRD.st && _TRD.st.env === "live" ? "【實盤・真錢】" : "【測試網】";
      if (!confirm(`${envTxt}開啟自動交易？\n只會自動交易「${window._acctName}」自選清單裡的標的，訊號出現就下單。`)) return;
    }
    a.on = turningOn;
    a.owner = window._acctName || "";   // 綁定擁有者帳號（同上）
    _trdRenderOverview();
    try { await _trdApi("auto", { cfg: a }); _trdMsg(turningOn ? "自動交易已開啟" : "自動交易已關閉"); }
    catch (err) { a.on = !turningOn; _trdRenderOverview(); _trdMsg(err.message, true); }
  });
  pop.querySelectorAll(".trd-a-sig, .trd-a-tf").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation(); b.classList.toggle("sel"); _trdSaveAuto();
  }));
  ["#trdAutoUsdt", "#trdAutoRisk", "#trdAutoLev", "#trdAutoMax", "#trdAutoDirs", "#trdAutoSl"].forEach(id =>
    pop.querySelector(id).addEventListener("change", _trdSaveAuto));
  pop.querySelector("#trdAutoSal").addEventListener("click", e => {
    e.stopPropagation();
    const b = e.currentTarget;
    b.classList.toggle("sel"); b.textContent = b.classList.contains("sel") ? "開" : "關";
    _trdSaveAuto();
  });
  pop.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
    // 手機「交易」分頁、桌面嵌入態 → 面板常駐，不因點外面而關閉
    if (document.body.classList.contains("m-tab-trade")) return;
    if (pop.classList.contains("trd-docked")) return;
    if (!pop.contains(e.target) && !e.target.closest(".trd-entry")) {
      pop.classList.remove("open");
      _trdStopPoll();
    }
  });
}

function _trdStopPoll() { clearInterval(_TRD.pollTimer); _TRD.pollTimer = null; }

function _trdOpenPopup(anchorBtn) {
  const pop = document.getElementById("tradePopup");
  if (!pop) return;
  if (typeof window._closeAllFloatPanels === "function") window._closeAllFloatPanels("");
  const opening = !pop.classList.contains("open");
  pop.classList.toggle("open");
  if (!opening) { _trdStopPoll(); return; }
  // 標的預填目前圖表（僅 crypto）
  try {
    const mkt = document.getElementById("marketSelect")?.value;
    const sym = document.getElementById("symbolInput")?.value?.trim();
    if (mkt === "crypto" && sym && !pop.querySelector("#trdSym").value) pop.querySelector("#trdSym").value = sym;
  } catch (e) {}
  // 口令跟著帳戶：已登入 → 先從伺服器取回此帳號綁定的口令（換裝置免再輸），取到才刷新。
  if (window._acctName) {
    _trdApi("mykey", { name: window._acctName })
      .then(j => { if (j && j.tkey) { try { localStorage.setItem("tradeKey", j.tkey); } catch (e) {} } })
      .catch(() => {})
      .finally(() => { if (_TRD.st.locked && !_trdKey()) _trdShowKeyRow(true); _trdRefresh(); });
  } else {
    if (_TRD.st.locked && !_trdKey()) _trdShowKeyRow(true);
    _trdRefresh();
  }
  _trdStopPoll();
  _TRD.pollTimer = setInterval(_trdRefresh, 5000);   // 開著時每 5s 刷新持倉/盈虧
  if (anchorBtn && !isMobileUI()) {
    requestAnimationFrame(() => {
      const r = anchorBtn.getBoundingClientRect();
      let left = r.right - pop.offsetWidth; if (left < 4) left = 4;
      let top = r.bottom + 4;
      if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(4, r.top - pop.offsetHeight - 4);
      pop.style.left = left + "px"; pop.style.top = top + "px";
    });
  }
}

// 桌面：把完整交易面板嵌進「合約行情」面板底部，可收合（標題列點擊展開/收合，偏好存 localStorage）
function _trdInjectDesktopDock() {
  const panel = document.getElementById("tickerPanel");
  const pop = document.getElementById("tradePopup");
  if (!panel || !pop || document.getElementById("trdDock")) return;
  const envTag = _TRD.st.env === "live" ? "實盤" : "測試網";
  const envCls = _TRD.st.env === "live" ? "trd-env-live" : "trd-env-test";
  const dock = document.createElement("div");
  dock.id = "trdDock";
  dock.innerHTML =
    `<div class="trd-dock-hd">${_TRD_ICO}<span>交易</span>`
    + `<span class="trd-env ${envCls}">${envTag}</span>`
    + `<span class="trd-dock-caret">▼</span></div>`
    + `<div class="trd-dock-body"></div>`;
  panel.appendChild(dock);
  // 把交易面板本體搬進 dock body（保留所有事件處理器），切成嵌入態
  const body = dock.querySelector(".trd-dock-body");
  body.appendChild(pop);
  pop.classList.add("open", "trd-docked");
  // 收合狀態（預設展開）
  let collapsed = false;
  try { collapsed = localStorage.getItem("trdDockCollapsed") === "1"; } catch (e) {}
  const applyCollapsed = () => {
    dock.classList.toggle("trd-collapsed", collapsed);
    if (collapsed) { _trdStopPoll(); }
    else { _trdLoadPanel(); }
  };
  dock.querySelector(".trd-dock-hd").addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem("trdDockCollapsed", collapsed ? "1" : "0"); } catch (e) {}
    applyCollapsed();
  });
  applyCollapsed();
}

// 依 canTrade 切換「綁金鑰表單」或「交易介面」；同步環境徽章文字
function _trdApplyMode() {
  const pop = document.getElementById("tradePopup");
  if (!pop) return;
  const need = !(_TRD.st && _TRD.st.canTrade);   // 沒金鑰 → 顯示綁定表單
  pop.classList.toggle("trd-need-bind", need);
  const badge = pop.querySelector(".sys-sp-title .trd-env");
  if (badge && _TRD.st) {
    const live = _TRD.st.env === "live";
    badge.textContent = live ? "實盤" : "測試網";
    badge.className = "trd-env " + (live ? "trd-env-live" : "trd-env-test");
  }
}

// 手機「交易」分頁：把交易面板撐成滿版頁（CSS body.m-tab-trade 控制）→ 進頁載入、離頁停輪詢
function _trdLoadPanel() {
  const pop = document.getElementById("tradePopup");
  if (!pop) return;
  _trdApplyMode();
  if (!(_TRD.st && _TRD.st.canTrade)) return;   // 未綁金鑰 → 只顯示綁定表單，不查倉位
  try {
    const mkt = document.getElementById("marketSelect")?.value;
    const sym = document.getElementById("symbolInput")?.value?.trim();
    if (mkt === "crypto" && sym && !pop.querySelector("#trdSym").value) pop.querySelector("#trdSym").value = sym;
  } catch (e) {}
  if (window._acctName) {
    _trdApi("mykey", { name: window._acctName })
      .then(j => { if (j && j.tkey) { try { localStorage.setItem("tradeKey", j.tkey); } catch (e) {} } })
      .catch(() => {})
      .finally(() => { if (_TRD.st.usingEnv && _TRD.st.locked && !_trdKey()) _trdShowKeyRow(true); _trdRefresh(); });
  } else {
    _trdRefresh();
  }
  _trdStopPoll();
  _TRD.pollTimer = setInterval(_trdRefresh, 5000);
}

async function initTrade() {
  if (!window._acctName) return;   // 未登入 → 不顯示交易（交易須綁帳號）
  try {
    const r = await fetch("/api/trade/status?name=" + encodeURIComponent(window._acctName));
    _TRD.st = await r.json();
  } catch (e) { return; }
  // 只有「白名單帳號」才顯示交易入口（其他帳號完全看不到，避免誤入共用戶頭）
  if (!_TRD.st || !_TRD.st.allowed) return;
  _trdBuildPopup();

  // 依裝置分流（決定於載入時）：
  //  手機 → 底部「交易」分頁（面板留在 body、滿版頁顯示）；不可注入到 #tickerPanel，
  //         否則會出現在「自選」分頁下方（#tickerPanel 即自選頁內容）。
  //  桌面 → 把完整面板嵌進合約行情面板底部、可收合。
  if (typeof isMobileUI === "function" && isMobileUI()) {
    const tab = document.getElementById("mTabTrade");
    if (tab) tab.style.display = "";   // 顯示手機底部「交易」分頁
    window._trdEnterTab = function () {
      const pop = document.getElementById("tradePopup");
      if (pop) pop.classList.add("open");
      _trdLoadPanel();
    };
    window._trdLeaveTab = function () {
      const pop = document.getElementById("tradePopup");
      if (pop) pop.classList.remove("open");
      _trdStopPoll();
    };
  } else {
    _trdInjectDesktopDock();
  }
}
