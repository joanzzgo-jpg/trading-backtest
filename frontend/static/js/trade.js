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
  const r = await fetch("/api/trade/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ key: _trdKey() }, body || {})),
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
  if (document.activeElement !== $("#trdAutoLev")) $("#trdAutoLev").value = a.lev ?? 3;
  if (document.activeElement !== $("#trdAutoMax")) $("#trdAutoMax").value = a.maxPos ?? 3;
  if ($("#trdAutoDirs").value !== a.dirs) $("#trdAutoDirs").value = a.dirs || "both";
}

let _trdAutoSaveTimer = null;
function _trdSaveAuto() {
  const pop = document.getElementById("tradePopup");
  if (!pop || !_TRD.ov) return;
  const a = _TRD.ov.auto = _TRD.ov.auto || {};
  a.sigs = [...pop.querySelectorAll(".trd-a-sig.sel")].map(x => x.dataset.sig);
  a.tfs = [...pop.querySelectorAll(".trd-a-tf.sel")].map(x => x.dataset.tf);
  a.usdt = +pop.querySelector("#trdAutoUsdt").value || 50;
  a.lev = +pop.querySelector("#trdAutoLev").value || 3;
  a.maxPos = +pop.querySelector("#trdAutoMax").value || 3;
  a.dirs = pop.querySelector("#trdAutoDirs").value;
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
      <div><label>每筆保證金 USDT</label><input id="trdAutoUsdt" type="number" min="1"></div>
      <div><label>槓桿</label><input id="trdAutoLev" type="number" min="1" max="50"></div>
      <div><label>最大同時持倉</label><input id="trdAutoMax" type="number" min="1" max="20"></div>
      <div><label>方向</label><select id="trdAutoDirs">
        <option value="both">多空都做</option><option value="long">只做多</option><option value="short">只做空</option>
      </select></div>
    </div>
    <div class="trd-sub" style="color:#b8a06a">⚠ 自動交易掃描的標的＝帳號自選清單（僅合約），且帳號需至少一台裝置啟用訊號通知。進場後停損/止盈由交易所託管，策略提前止盈止損時會同步平倉。</div>
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
    try { localStorage.setItem("tradeKey", pop.querySelector("#trdKeyInput").value.trim()); } catch (err) {}
    _trdShowKeyRow(false); _trdRefresh();
  });
  pop.querySelector(".trd-auto-toggle").addEventListener("click", async e => {
    e.stopPropagation();
    if (!_TRD.ov) return;
    const a = _TRD.ov.auto = _TRD.ov.auto || {};
    const turningOn = !a.on;
    if (turningOn) {
      const envTxt = _TRD.st && _TRD.st.env === "live" ? "【實盤・真錢】" : "【測試網】";
      if (!confirm(`${envTxt}開啟自動交易？\n勾選的訊號出現時會自動下單。`)) return;
    }
    a.on = turningOn;
    _trdRenderOverview();
    try { await _trdApi("auto", { cfg: a }); _trdMsg(turningOn ? "自動交易已開啟" : "自動交易已關閉"); }
    catch (err) { a.on = !turningOn; _trdRenderOverview(); _trdMsg(err.message, true); }
  });
  pop.querySelectorAll(".trd-a-sig, .trd-a-tf").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation(); b.classList.toggle("sel"); _trdSaveAuto();
  }));
  ["#trdAutoUsdt", "#trdAutoLev", "#trdAutoMax", "#trdAutoDirs"].forEach(id =>
    pop.querySelector(id).addEventListener("change", _trdSaveAuto));
  pop.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
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
  if (_TRD.st.locked && !_trdKey()) _trdShowKeyRow(true);
  _trdRefresh();
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

function _trdInjectEntries() {
  const envTag = _TRD.st.env === "live" ? "實盤" : "測試網";
  // 桌面：系統外觀彈窗內加入口
  const sysPop = document.getElementById("sysSettingsPopup");
  if (sysPop && !sysPop.querySelector(".trd-entry")) {
    const b = document.createElement("button");
    b.className = "btn-reset trd-entry";
    b.innerHTML = `${_TRD_ICO} 交易（${envTag}）`;
    b.addEventListener("click", e => { e.stopPropagation(); _trdOpenPopup(b); });
    sysPop.appendChild(b);
  }
  // 手機：設定分頁，插在通知列之後（沒有通知列就插在帳號列後）
  const anchor = document.querySelector("#mSettings .ntf-entry") || document.querySelector("#mSettings .m-set-acct");
  if (anchor && !document.querySelector("#mSettings .trd-entry")) {
    const sec = document.createElement("div"); sec.className = "m-set-sec"; sec.textContent = "交易";
    const row = document.createElement("button");
    row.className = "m-set-row trd-entry";
    row.innerHTML = `<span class="m-set-ico">${_TRD_ICO}</span><span class="m-set-lbl">Binance 交易<small>${envTag}</small></span><span class="m-set-arr">›</span>`;
    row.addEventListener("click", e => { e.stopPropagation(); _trdOpenPopup(row); });
    anchor.after(sec, row);
  }
}

async function initTrade() {
  try {
    const r = await fetch("/api/trade/status");
    _TRD.st = await r.json();
  } catch (e) { return; }
  if (!_TRD.st || !_TRD.st.configured) return;   // 後端未設交易金鑰 → 不顯示入口
  _trdBuildPopup();
  _trdInjectEntries();
}
