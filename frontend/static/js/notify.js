/* ══════════════════════════════════════════════════════════════
   CRT 訊號 Web Push 通知（多使用者）
   - 訂閱：requestPermission → pushManager.subscribe → /api/notify/subscribe（每裝置各自開）
   - 偏好：監控時框 + 要通知的訊號（預設 S2~S11）存 localStorage["notifyPrefs"]，
     沿用帳號快照同步機制 → 跨裝置一致；後端監控器以 account_prefs(name) 讀取
   - 測試：/api/notify/test
   - 入口：桌面「系統外觀」彈窗 + 手機「設定」分頁，共用單一 #notifyPopup
   - 通知綁定目前登入帳號（window._acctName）；後端監控器依帳號 watchlist 推播
   ══════════════════════════════════════════════════════════════ */
const _NTF = { enabled: false, vapidKey: null, endpoint: null, prefs: null, supported: false };

// 偏好預設與可選清單（前端固定；後端 _ALL_SIGS/_ALL_TFS 同義）
const _NTF_DEFAULT  = { tfs: ["1h", "4h", "1d"], sigs: ["ab", "3", "4", "5", "6", "7", "8", "9", "10", "11"] };
const _NTF_ALL_TFS  = ["5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "1w"];
const _NTF_SIG_ORDER = ["ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "abc", "12"];

// 偏好讀寫：存 localStorage["notifyPrefs"]，帳號登入時會自動同步到雲端、跨裝置一致
function _ntfLoadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("notifyPrefs") || "null");
    if (p && (p.tfs || p.sigs)) return { tfs: p.tfs || _NTF_DEFAULT.tfs.slice(), sigs: p.sigs || _NTF_DEFAULT.sigs.slice() };
  } catch (e) {}
  return { tfs: _NTF_DEFAULT.tfs.slice(), sigs: _NTF_DEFAULT.sigs.slice() };
}

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
    await _ntfApi("POST", "subscribe", { name: window._acctName, subscription: sub.toJSON() });
    _NTF.enabled = true;
    _NTF.endpoint = sub.endpoint;
    if (!_NTF.prefs) _NTF.prefs = _ntfLoadPrefs();
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

// 存偏好到 localStorage → account.js 的 setItem hook 會自動 debounce 同步到雲端（跨裝置一致）
function _ntfSavePrefs() {
  try { localStorage.setItem("notifyPrefs", JSON.stringify({ tfs: _NTF.prefs.tfs, sigs: _NTF.prefs.sigs })); } catch (e) {}
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
  document.querySelectorAll(".ntf-state").forEach(el => { el.textContent = on ? "已啟用" : "未啟用"; });
  // 勾選狀態
  const p = _NTF.prefs || {};
  pop.querySelectorAll(".ntf-tf").forEach(b => b.classList.toggle("sel", (p.tfs || []).includes(b.dataset.tf)));
  pop.querySelectorAll(".ntf-sig").forEach(b => b.classList.toggle("sel", (p.sigs || []).includes(b.dataset.sig)));
}

function _ntfBuildPopup() {
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
  const tfChips = _NTF_ALL_TFS
    .map(t => `<button class="ntf-chip ntf-tf" data-tf="${t}">${t}</button>`).join("");
  const sigChips = _NTF_SIG_ORDER
    .map(s => `<button class="ntf-chip ntf-sig" data-sig="${s}">${_ntfSigLabel(s)}</button>`).join("");
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

  // 偏好來自 localStorage（登入時由帳號快照同步而來）；是否啟用 = 此裝置是否有訂閱
  _NTF.prefs = _ntfLoadPrefs();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { _NTF.endpoint = sub.endpoint; _NTF.enabled = true; }
  } catch (e) {}
  _ntfBuildPopup();
  _ntfInjectEntries();
  _ntfRender();

  // 訊號分頁頭的「設定」鈕 → 開通知設定彈窗
  document.getElementById("mSigSettingsBtn")?.addEventListener("click", e => {
    e.stopPropagation(); _ntfOpenPopup(e.currentTarget);
  });

  // 背景輪詢（每 60s）：更新未讀紅點；在訊號分頁時也即時刷新清單
  _ntfFeed.bgTimer = setInterval(_ntfBgPoll, 60000);
  _ntfBgPoll();

  // 通知點擊 → SW postMessage（聚焦既有分頁）→ best-effort 切到該標的
  navigator.serviceWorker.addEventListener("message", ev => {
    const m = ev.data || {};
    if (m.type === "notify-open" && m.info && m.info.symbol) _ntfGoSymbol(m.info);
  });
}

// ── 訊號通知中心（聊天室式歷史清單）──────────────────────────
const _ntfFeed = { items: [], pollTimer: null, bgTimer: null };

function _ntfSeenTs() { try { return parseFloat(localStorage.getItem("notifyFeedSeen") || "0") || 0; } catch (e) { return 0; } }
function _ntfSetSeen(ts) { try { localStorage.setItem("notifyFeedSeen", String(ts || 0)); } catch (e) {} }

async function _ntfFetchFeed() {
  if (!window._acctName) return [];
  try {
    const j = await _ntfApi("GET", "feed?name=" + encodeURIComponent(window._acctName) + "&limit=80");
    return j.items || [];
  } catch (e) { return []; }
}

function _ntfFmtTime(ts) {
  const d = new Date(ts * 1000), now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "剛剛";
  if (diff < 3600) return Math.floor(diff / 60) + " 分鐘前";
  const p = n => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}`
                 : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function _ntfRenderFeed() {
  const list = document.getElementById("mSigList");
  if (!list) return;
  const items = _ntfFeed.items;
  if (!items.length) {
    list.innerHTML = `<div class="m-sig-empty">${window._acctName ? "尚無訊號通知" : "請先登入帳號"}</div>`;
    return;
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = items.map(it => {
    const cls = it.event === "tp" ? "m-sig-bubble evt-tp" : "m-sig-bubble";
    return `<div class="m-sig-msg">
      <img class="m-sig-avatar" src="/static/img/bear.png" alt="小啊">
      <div class="m-sig-col">
        <div class="m-sig-name">小啊</div>
        <div class="${cls}" data-sym="${it.symbol || ""}" data-mkt="${it.market || ""}" data-exch="${it.exchange || ""}">
          <div class="m-sig-b-title">${_ntfEsc(it.title)}</div>
          <div class="m-sig-b-body">${_ntfEsc(it.body)}</div>
          <div class="m-sig-b-time">${_ntfFmtTime(it.ts)}</div>
        </div>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".m-sig-bubble").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.sym) _ntfGoSymbol({ symbol: b.dataset.sym, market: b.dataset.mkt, exchange: b.dataset.exch });
  }));
  if (atBottom) list.scrollTop = list.scrollHeight;   // 新訊息時保持在底部（聊天室行為）
}

function _ntfEsc(s) { return String(s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function _ntfUpdateBadge() {
  const badge = document.getElementById("mSignalsBadge");
  if (!badge) return;
  const seen = _ntfSeenTs();
  const n = _ntfFeed.items.filter(it => it.ts > seen).length;
  const onTab = document.body.classList.contains("m-tab-signals");
  if (n > 0 && !onTab) { badge.style.display = "flex"; badge.textContent = n > 99 ? "99+" : String(n); }
  else { badge.style.display = "none"; }
}

async function _ntfBgPoll() {
  _ntfFeed.items = await _ntfFetchFeed();
  if (document.body.classList.contains("m-tab-signals")) {
    _ntfRenderFeed();
    if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
  }
  _ntfUpdateBadge();
}

// 切到訊號分頁時呼叫（main.js）：載入清單 + 標記已讀 + 開快輪詢
window._ntfLoadFeed = async function () {
  _ntfFeed.items = await _ntfFetchFeed();
  _ntfRenderFeed();
  if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
  _ntfUpdateBadge();
  const list = document.getElementById("mSigList");
  if (list) list.scrollTop = list.scrollHeight;
  clearInterval(_ntfFeed.pollTimer);
  _ntfFeed.pollTimer = setInterval(async () => {
    _ntfFeed.items = await _ntfFetchFeed();
    _ntfRenderFeed();
    if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
    _ntfUpdateBadge();
  }, 20000);
};
window._ntfStopFeedPoll = function () { clearInterval(_ntfFeed.pollTimer); _ntfFeed.pollTimer = null; };

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
