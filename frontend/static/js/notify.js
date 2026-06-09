/* ══════════════════════════════════════════════════════════════
   CRT 訊號 Web Push 通知（多使用者）
   - 訂閱：requestPermission → pushManager.subscribe → /api/notify/subscribe
   - 偏好：監控時框 + 要通知的訊號（預設 S2~S11）→ /api/notify/prefs
   - 測試：/api/notify/test
   - 入口：桌面「系統外觀」彈窗 + 手機「設定」分頁，共用單一 #notifyPopup
   - 通知綁定目前登入帳號（window._acctName）；後端監控器依帳號 watchlist 推播
   ══════════════════════════════════════════════════════════════ */
const _NTF = { enabled: false, vapidKey: null, endpoint: null, prefs: null, supported: false };

// 訊號鍵 → 顯示名（abc=S1, ab=S2, "3".."12"=S3..S12）
function _ntfSigLabel(k) {
  if (k === "abc") return "S1";
  if (k === "ab")  return "S2";
  return "S" + k;
}
const _NTF_TF_ORDER = ["5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w", "1M"];

// 手繪風鈴鐺（取代 emoji，配合站上 stroke SVG 風格）
const _NTF_BELL = `<svg class="ntf-bell" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4.2 1.8 5.3 2.3 5.7H4.2c.5-.4 2.3-1.5 2.3-5.7Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>`;
const _NTF_BELL_M = _NTF_BELL.replace('class="ntf-bell"', 'filter="url(#mSketch)"');

function _urlB64ToU8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function _ntfApi(method, path, body) {
  const opt = { method };
  if (body !== undefined) { opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(body); }
  const r = await fetch("/api/notify/" + path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || ("錯誤 " + r.status));
  return j;
}

// ── 啟用通知（請求權限 → 訂閱 → 上傳）──────────────────────────
async function _ntfEnable() {
  if (!_NTF.supported) { _ntfMsg("此瀏覽器不支援推播通知", true); return; }
  if (!window._acctName) { _ntfMsg("請先登入帳號（封面門上的鎖）再啟用通知", true); return; }
  _ntfMsg("要求通知權限中…");
  let perm;
  try { perm = await Notification.requestPermission(); }
  catch (e) { _ntfMsg("無法取得通知權限", true); return; }
  if (perm !== "granted") { _ntfMsg("通知權限被拒，請到瀏覽器/系統設定開啟", true); return; }
  try {
    if (!_NTF.vapidKey) _NTF.vapidKey = (await _ntfApi("GET", "vapid_public")).key;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlB64ToU8(_NTF.vapidKey),
      });
    }
    const prefs = _NTF.prefs || { enabled: true };
    prefs.enabled = true;
    const j = await _ntfApi("POST", "subscribe", { name: window._acctName, subscription: sub.toJSON(), prefs });
    _NTF.enabled = true;
    _NTF.endpoint = sub.endpoint;
    _NTF.prefs = j.prefs;
    _ntfMsg("通知已啟用");
    _ntfRender();
  } catch (e) {
    _ntfMsg("啟用失敗：" + e.message, true);
  }
}

async function _ntfDisable() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await _ntfApi("POST", "unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch (e) {}
  _NTF.enabled = false;
  _NTF.endpoint = null;
  _ntfMsg("通知已關閉");
  _ntfRender();
}

async function _ntfSavePrefs() {
  if (!_NTF.enabled || !_NTF.endpoint) return;
  try {
    const j = await _ntfApi("POST", "prefs", { endpoint: _NTF.endpoint, prefs: _NTF.prefs });
    _NTF.prefs = j.prefs;
  } catch (e) { _ntfMsg("儲存偏好失敗：" + e.message, true); }
}

async function _ntfTest() {
  if (!window._acctName) { _ntfMsg("請先登入帳號", true); return; }
  _ntfMsg("發送測試通知中…");
  try {
    const j = await _ntfApi("POST", "test", { name: window._acctName });
    _ntfMsg(j.sent > 0 ? `已發送（${j.sent}/${j.total} 裝置）` : "發送失敗：訂閱可能已失效，請重新啟用", j.sent === 0);
  } catch (e) { _ntfMsg("測試失敗：" + e.message, true); }
}

// ── UI ────────────────────────────────────────────────────────
function _ntfMsg(t, isErr) {
  document.querySelectorAll(".ntf-msg").forEach(el => {
    el.textContent = t || "";
    el.classList.toggle("ntf-err", !!isErr);
  });
}

function _ntfRender() {
  const pop = document.getElementById("notifyPopup");
  if (!pop) return;
  const on = _NTF.enabled;
  pop.querySelector(".ntf-toggle").textContent = on ? "關閉通知" : "啟用通知";
  pop.querySelector(".ntf-toggle").classList.toggle("ntf-on", on);
  pop.querySelector(".ntf-body").style.opacity = on ? "1" : "0.4";
  pop.querySelector(".ntf-body").style.pointerEvents = on ? "auto" : "none";
  // 勾選狀態
  const p = _NTF.prefs || {};
  pop.querySelectorAll(".ntf-tf").forEach(b => b.classList.toggle("sel", (p.tfs || []).includes(b.dataset.tf)));
  pop.querySelectorAll(".ntf-sig").forEach(b => b.classList.toggle("sel", (p.sigs || []).includes(b.dataset.sig)));
}

function _ntfBuildPopup(allTfs, allSigs) {
  if (document.getElementById("notifyPopup")) return;
  const css = document.createElement("style");
  css.textContent = `
    #notifyPopup { max-width: 320px; }
    #notifyPopup .ntf-toggle { width:100%; padding:8px; margin:4px 0 8px; border-radius:8px; border:1px solid var(--border,#445);
      background:transparent; color:var(--text,#ddd); cursor:pointer; font-size:13px; }
    #notifyPopup .ntf-toggle.ntf-on { background:var(--blue,#4a90d9); color:#fff; border-color:transparent; }
    #notifyPopup .ntf-sub { font-size:11px; color:var(--muted,#889); margin:6px 0 3px; }
    #notifyPopup .ntf-chips { display:flex; flex-wrap:wrap; gap:5px; }
    #notifyPopup .ntf-chip { padding:3px 9px; border-radius:12px; border:1px solid var(--border,#445);
      background:transparent; color:var(--muted,#99a); cursor:pointer; font-size:12px; }
    #notifyPopup .ntf-chip.sel { background:var(--blue,#4a90d9); color:#fff; border-color:transparent; }
    #notifyPopup .ntf-test { width:100%; padding:6px; margin-top:10px; border-radius:8px; border:1px dashed var(--border,#445);
      background:transparent; color:var(--muted,#99a); cursor:pointer; font-size:12px; }
    #notifyPopup .ntf-msg { font-size:11px; color:var(--muted,#889); margin-top:8px; min-height:14px; }
    #notifyPopup .ntf-msg.ntf-err { color:#e57; }
    #notifyPopup .ntf-hint { font-size:11px; color:#e9a; margin-bottom:6px; }
    .ntf-bell { vertical-align:-2px; }
    .ntf-entry .ntf-bell { margin-right:4px; }
  `;
  document.head.appendChild(css);

  const pop = document.createElement("div");
  pop.id = "notifyPopup";
  pop.className = "sys-settings-popup";
  const tfChips = (allTfs && allTfs.length ? _NTF_TF_ORDER.filter(t => allTfs.includes(t)) : ["1h","4h","1d"])
    .map(t => `<button class="ntf-chip ntf-tf" data-tf="${t}">${t}</button>`).join("");
  const sigOrder = ["ab","3","4","5","6","7","8","9","10","11","abc","12"].filter(s => !allSigs || allSigs.includes(s));
  const sigChips = sigOrder.map(s => `<button class="ntf-chip ntf-sig" data-sig="${s}">${_ntfSigLabel(s)}</button>`).join("");
  const iosHint = (_ntfIsIOS() && !navigator.standalone)
    ? `<div class="ntf-hint">iOS 需先把本站「加到主畫面」並從主畫面開啟，才能收推播。</div>` : "";
  pop.innerHTML = `
    <div class="sys-sp-title">${_NTF_BELL} 訊號通知</div>
    ${iosHint}
    <button class="ntf-toggle">啟用通知</button>
    <div class="ntf-body">
      <div class="ntf-sub">監控時框</div>
      <div class="ntf-chips ntf-tf-grid">${tfChips}</div>
      <div class="ntf-sub">通知訊號</div>
      <div class="ntf-chips ntf-sig-grid">${sigChips}</div>
      <button class="ntf-test">發送測試通知</button>
    </div>
    <div class="ntf-msg"></div>`;
  document.body.appendChild(pop);

  pop.querySelector(".ntf-toggle").addEventListener("click", e => {
    e.stopPropagation();
    _NTF.enabled ? _ntfDisable() : _ntfEnable();
  });
  pop.querySelector(".ntf-test").addEventListener("click", e => { e.stopPropagation(); _ntfTest(); });
  pop.querySelectorAll(".ntf-tf").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    _NTF.prefs = _NTF.prefs || { tfs: [], sigs: [] };
    const tfs = new Set(_NTF.prefs.tfs || []);
    tfs.has(b.dataset.tf) ? tfs.delete(b.dataset.tf) : tfs.add(b.dataset.tf);
    _NTF.prefs.tfs = [..._NTF_TF_ORDER].filter(t => tfs.has(t));
    _ntfRender(); _ntfSavePrefs();
  }));
  pop.querySelectorAll(".ntf-sig").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    _NTF.prefs = _NTF.prefs || { tfs: [], sigs: [] };
    const sigs = new Set(_NTF.prefs.sigs || []);
    sigs.has(b.dataset.sig) ? sigs.delete(b.dataset.sig) : sigs.add(b.dataset.sig);
    _NTF.prefs.sigs = [...sigs];
    _ntfRender(); _ntfSavePrefs();
  }));
  pop.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
    if (!pop.contains(e.target) && !e.target.closest(".ntf-entry")) pop.classList.remove("open");
  });
}

function _ntfIsIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function _ntfOpenPopup(anchorBtn) {
  const pop = document.getElementById("notifyPopup");
  if (!pop) return;
  if (typeof window._closeAllFloatPanels === "function") window._closeAllFloatPanels("");
  const opening = !pop.classList.contains("open");
  pop.classList.toggle("open");
  if (opening && anchorBtn && !window.matchMedia("(max-width:768px)").matches) {
    requestAnimationFrame(() => {
      const r = anchorBtn.getBoundingClientRect();
      let left = r.right - pop.offsetWidth; if (left < 4) left = 4;
      let top = r.bottom + 4;
      if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(4, r.top - pop.offsetHeight - 4);
      pop.style.left = left + "px"; pop.style.top = top + "px";
    });
  }
}

function _ntfInjectEntries() {
  // 桌面：系統外觀彈窗內加一顆入口
  const sysPop = document.getElementById("sysSettingsPopup");
  if (sysPop && !sysPop.querySelector(".ntf-entry")) {
    const b = document.createElement("button");
    b.className = "btn-reset ntf-entry";
    b.innerHTML = `${_NTF_BELL} 訊號通知`;
    b.addEventListener("click", e => { e.stopPropagation(); _ntfOpenPopup(b); });
    sysPop.appendChild(b);
  }
  // 手機：設定分頁「帳號」區之後插一列
  const acctRow = document.querySelector("#mSettings .m-set-acct");
  if (acctRow && !document.querySelector("#mSettings .ntf-entry")) {
    const sec = document.createElement("div"); sec.className = "m-set-sec"; sec.textContent = "通知";
    const row = document.createElement("button");
    row.className = "m-set-row ntf-entry";
    row.innerHTML = `<span class="m-set-ico">${_NTF_BELL_M}</span><span class="m-set-lbl">訊號通知<small class="ntf-state">未啟用</small></span><span class="m-set-arr">›</span>`;
    row.addEventListener("click", e => { e.stopPropagation(); _ntfOpenPopup(row); });
    acctRow.after(sec, row);
  }
}

async function initNotify() {
  _NTF.supported = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  let st;
  try { st = await _ntfApi("GET", "status"); } catch (e) { st = { enabled: false }; }
  if (!st.enabled || !_NTF.supported) return;   // 後端未設 VAPID / 瀏覽器不支援 → 不顯示入口

  // 取得偏好選項（all_tfs/all_sigs）；用任一已存在訂閱讀回 prefs
  let allTfs = null, allSigs = null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      _NTF.endpoint = sub.endpoint;
      try {
        const j = await _ntfApi("GET", "prefs?endpoint=" + encodeURIComponent(sub.endpoint));
        _NTF.enabled = true; _NTF.prefs = j.prefs; allTfs = j.all_tfs; allSigs = j.all_sigs;
      } catch (e) { /* 後端沒這筆（換帳號/清過 DB）→ 視為未啟用 */ }
    }
  } catch (e) {}
  _ntfBuildPopup(allTfs, allSigs);
  _ntfInjectEntries();
  _ntfRender();

  // 通知點擊 → SW postMessage（聚焦既有分頁）→ best-effort 切到該標的
  navigator.serviceWorker.addEventListener("message", ev => {
    const m = ev.data || {};
    if (m.type === "notify-open" && m.info && m.info.symbol) _ntfGoSymbol(m.info);
  });
}

// best-effort：切到通知標的（對不到格式只是圖不變，不會壞）
function _ntfGoSymbol(info) {
  try {
    const mktEl = document.getElementById("marketSelect");
    const mkt = info.market === "tw" ? "tw" : info.market === "us" ? "us" : "crypto";
    if (mktEl && mktEl.value !== mkt) { mktEl.value = mkt; if (typeof updateMarketUI === "function") updateMarketUI(); }
    const inp = document.getElementById("symbolInput");
    if (inp) inp.value = info.symbol;
    if (typeof loadData === "function") loadData(false);
    if (typeof window._mSetTab === "function") window._mSetTab("chart");
  } catch (e) {}
}
