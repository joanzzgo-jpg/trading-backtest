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
const _NTF_SIG_ORDER = ["ab", "3", "4", "5", "6", "7", "8", "9", "10", "11", "abc", "12", "ss1", "ss2"];

// 偏好讀寫：存 localStorage["notifyPrefs"]，帳號登入時會自動同步到雲端、跨裝置一致
function _ntfLoadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("notifyPrefs") || "null");
    if (p && (p.tfs || p.sigs)) return { tfs: p.tfs || _NTF_DEFAULT.tfs.slice(), sigs: p.sigs || _NTF_DEFAULT.sigs.slice(), sigNotify: p.sigNotify !== false };
  } catch (e) {}
  return { tfs: _NTF_DEFAULT.tfs.slice(), sigs: _NTF_DEFAULT.sigs.slice(), sigNotify: true };
}

// 訊號鍵 → 顯示名（abc=S1, ab=S2, "3".."12"=S3..S12）
function _ntfSigLabel(k) {
  if (k === "abc") return "S1";
  if (k === "ab")  return "S2";
  if (k === "ss1") return "SS1";
  if (k === "ss2") return "SS2";
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

// 存偏好：localStorage（UI 顯示/快照相容）+ 立即寫穿到伺服器 notify_prefs 表。
// 寫穿是單一真相來源：不等帳號快照 debounce，也不會被別台裝置的整包舊快照蓋回
// （以前純靠快照同步 → 後端讀到舊偏好 → 收到沒設定的策略）。
let _ntfPrefsPushTimer = null;
function _ntfSavePrefs() {
  const _p = { tfs: _NTF.prefs.tfs, sigs: _NTF.prefs.sigs,
               sigNotify: _NTF.prefs.sigNotify !== false,
               atNotify: _NTF.prefs.atNotify !== false,        // 自動交易通知
               coachNotify: _NTF.prefs.coachNotify !== false }; // 教練通知
  try { localStorage.setItem("notifyPrefs", JSON.stringify(_p)); } catch (e) {}
  if (!window._acctName) return;
  clearTimeout(_ntfPrefsPushTimer);
  _ntfPrefsPushTimer = setTimeout(() => {
    _ntfApi("POST", "prefs", { name: window._acctName, prefs: _p }).catch(() => {});
  }, 600);
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
  // 訊號通知總開關狀態（關＝只停訊號推播、淡化時框/訊號選項；自動交易通知不受影響）
  const sigOn = p.sigNotify !== false;
  const sigBtn = pop.querySelector(".ntf-signotify");
  if (sigBtn) { sigBtn.textContent = sigOn ? "🔔 訊號通知：開" : "🔕 訊號通知：關"; sigBtn.classList.toggle("off", !sigOn); }
  const sigWrap = pop.querySelector(".ntf-sigwrap");
  if (sigWrap) sigWrap.classList.toggle("dim", !sigOn);
  // 自動交易 / 教練 通知獨立開關
  const atOn = p.atNotify !== false;
  const atBtn = pop.querySelector(".ntf-atnotify");
  if (atBtn) { atBtn.textContent = atOn ? "🔔 自動交易通知：開" : "🔕 自動交易通知：關"; atBtn.classList.toggle("off", !atOn); }
  const coachOn = p.coachNotify !== false;
  const coachBtn = pop.querySelector(".ntf-coachnotify");
  if (coachBtn) { coachBtn.textContent = coachOn ? "🔔 教練通知：開" : "🔕 教練通知：關"; coachBtn.classList.toggle("off", !coachOn); }
}

function _ntfBuildPopup() {
  if (document.getElementById("notifyPopup")) return;
  const css = document.createElement("style");
  css.textContent = `
    #notifyPopup { max-width: 320px; }
    #notifyPopup .ntf-toggle { width:100%; padding:8px; margin:4px 0 8px; border-radius:8px; border:1px solid var(--border,#445);
      background:transparent; color:var(--text,#ddd); cursor:pointer; font-size:13px; }
    #notifyPopup .ntf-toggle.ntf-on { background:var(--blue,#4a90d9); color:#fff; border-color:transparent; }
    #notifyPopup .ntf-signotify, #notifyPopup .ntf-atnotify, #notifyPopup .ntf-coachnotify {
      width:100%; padding:8px; margin:2px 0 3px; border-radius:8px; border:1px solid transparent;
      background:var(--blue,#4a90d9); color:#fff; cursor:pointer; font-size:13px; font-weight:700; }
    #notifyPopup .ntf-signotify.off, #notifyPopup .ntf-atnotify.off, #notifyPopup .ntf-coachnotify.off {
      background:transparent; color:var(--muted,#99a); border-color:var(--border,#445); }
    #notifyPopup .ntf-signotify-hint { font-size:10.5px; color:var(--muted,#889); margin:0 0 9px; line-height:1.45; }
    #notifyPopup .ntf-sigwrap.dim { opacity:.4; pointer-events:none; }
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
      <button class="ntf-signotify">🔔 訊號通知：開</button>
      <div class="ntf-signotify-hint">各類通知獨立開關；關掉只停該類推播，不影響其他類</div>
      <div class="ntf-sigwrap">
        <div class="ntf-sub">監控時框</div>
        <div class="ntf-chips ntf-tf-grid">${tfChips}</div>
        <div class="ntf-sub">通知訊號</div>
        <div class="ntf-chips ntf-sig-grid">${sigChips}</div>
      </div>
      <button class="ntf-atnotify">🔔 自動交易通知：開</button>
      <button class="ntf-coachnotify">🔔 教練通知：開</button>
      <button class="ntf-test">發送測試通知</button>
    </div>
    <div class="ntf-msg"></div>`;
  document.body.appendChild(pop);

  pop.querySelector(".ntf-toggle").addEventListener("click", e => {
    e.stopPropagation();
    _NTF.enabled ? _ntfDisable() : _ntfEnable();
  });
  pop.querySelector(".ntf-test").addEventListener("click", e => { e.stopPropagation(); _ntfTest(); });
  pop.querySelector(".ntf-signotify").addEventListener("click", e => {
    e.stopPropagation();
    _NTF.prefs = _NTF.prefs || _ntfLoadPrefs();
    _NTF.prefs.sigNotify = (_NTF.prefs.sigNotify === false);   // 切換：off→on / on→off
    _ntfSavePrefs();
    _ntfRender();
  });
  pop.querySelector(".ntf-atnotify").addEventListener("click", e => {
    e.stopPropagation();
    _NTF.prefs = _NTF.prefs || _ntfLoadPrefs();
    _NTF.prefs.atNotify = (_NTF.prefs.atNotify === false);     // 自動交易通知切換
    _ntfSavePrefs();
    _ntfRender();
  });
  pop.querySelector(".ntf-coachnotify").addEventListener("click", e => {
    e.stopPropagation();
    _NTF.prefs = _NTF.prefs || _ntfLoadPrefs();
    _NTF.prefs.coachNotify = (_NTF.prefs.coachNotify === false); // 教練通知切換
    _ntfSavePrefs();
    _ntfRender();
  });
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
  if (opening && anchorBtn && !isMobileUI()) {
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
    if (sub) {
      _NTF.endpoint = sub.endpoint;
      _NTF.enabled = true;
      // 重綁帳號（冪等 upsert）：換帳號登入後，這台裝置的訂閱仍綁前一帳號 →
      // 會照「別的帳號」的自選/策略推播。每次啟動把訂閱綁回目前帳號，
      // 也順便復活被伺服器清掉（404/410）的訂閱列。
      if (window._acctName) {
        _ntfApi("POST", "subscribe", { name: window._acctName, subscription: sub.toJSON() }).catch(() => {});
      }
    }
  } catch (e) {}
  _ntfBuildPopup();
  _ntfInjectEntries();
  _ntfRender();

  // 訊號分頁頭的「設定」鈕 → 開通知設定彈窗
  document.getElementById("mSigSettingsBtn")?.addEventListener("click", e => {
    e.stopPropagation(); _ntfOpenPopup(e.currentTarget);
  });

  // 分類過濾列：全部 / 訊號 / 自動交易（記住上次選擇）
  document.querySelectorAll("#mSigFilter .m-sig-fchip").forEach(chip => {
    chip.classList.toggle("on", (chip.dataset.f || "all") === _ntfFilter);   // 還原上次篩選
    chip.addEventListener("click", () => {
      _ntfFilter = chip.dataset.f || "all";
      try { localStorage.setItem("notifyFeedFilter", _ntfFilter); } catch (e) {}
      document.querySelectorAll("#mSigFilter .m-sig-fchip").forEach(c => c.classList.toggle("on", c === chip));
      _ntfRenderFeed({ force: true, toBottom: true });   // 切換後重畫並回到最新
    });
  });
  // 盈虧月曆：一鍵收起/展開（收起只藏日曆格、保留本月總計；狀態記 localStorage）
  (function () {
    const wrap = document.getElementById("mSigCalWrap");
    const toggle = document.getElementById("mSigCalToggle");
    if (!wrap || !toggle) return;
    let collapsed = false;
    try { collapsed = localStorage.getItem("sigCalCollapsed") === "1"; } catch (e) {}
    wrap.classList.toggle("collapsed", collapsed);            // 還原上次狀態
    toggle.addEventListener("click", () => {
      const now = !wrap.classList.contains("collapsed");
      wrap.classList.toggle("collapsed", now);
      try { localStorage.setItem("sigCalCollapsed", now ? "1" : "0"); } catch (e) {}
    });
  })();
  // 盈虧月曆：點「有交易的那天」→ 跳出當天進出場詳情
  document.getElementById("mSigCal")?.addEventListener("click", (e) => {
    const cell = e.target.closest(".m-sig-cal-has[data-d]");
    if (cell) _ntfShowCalDetail(cell.dataset.d);
  });
  document.getElementById("mSigCalDetail")?.addEventListener("click", (e) => {
    if (e.target.id === "mSigCalDetail" || e.target.closest(".m-sig-caldt-x"))
      document.getElementById("mSigCalDetail").hidden = true;   // 點背景或✕ 關閉
  });
  // 盈虧月曆：上/下月切換（用已抓資料重畫，不再打交易所）
  document.querySelectorAll("#mSigCalWrap .m-sig-cal-nav").forEach(b => b.addEventListener("click", () => {
    _ntfCalMonth = _ntfMonthStart(new Date((_ntfCalMonth || _ntfMonthStart(new Date())).getFullYear(),
      (_ntfCalMonth || _ntfMonthStart(new Date())).getMonth() + Number(b.dataset.cal), 1));
    _ntfRenderCal();
  }));
  // 「↓ 新訊息」提示：點了捲到底並隱藏
  document.getElementById("mSigNewPill")?.addEventListener("click", () => {
    const list = document.getElementById("mSigList");
    if (list) list.scrollTop = list.scrollHeight;
    _ntfHideNewPill();
  });
  // 捲到底時自動收起「新訊息」提示；捲到接近頂端 → 載入更早一批（分頁）
  document.getElementById("mSigList")?.addEventListener("scroll", () => {
    const list = document.getElementById("mSigList");
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 60) _ntfHideNewPill();
    if (list.scrollTop < 80) _ntfLoadOlder();
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

// 往上滑載入更早一批（用最舊一筆的 id 當游標）→ 自動交易量大也找得到整天紀錄。
let _ntfLoadingOlder = false, _ntfNoMoreOlder = false;
async function _ntfLoadOlder() {
  if (_ntfLoadingOlder || _ntfNoMoreOlder || !window._acctName) return;
  const items = _ntfFeed.items;
  const oldestId = items.length ? items[0].id : 0;
  if (!oldestId) return;
  _ntfLoadingOlder = true;
  try {
    const j = await _ntfApi("GET", "feed?name=" + encodeURIComponent(window._acctName) +
                            "&limit=80&before_id=" + oldestId);
    const older = j.items || [];
    if (older.length < 1) { _ntfNoMoreOlder = true; return; }
    if (older.length < 80) _ntfNoMoreOlder = true;   // 不足一頁 → 到底了
    const list = document.getElementById("mSigList");
    const dfb = list ? (list.scrollHeight - list.scrollTop) : 0;   // 距底距離 → 載入後維持視覺位置
    _ntfFeed.items = older.concat(items);            // older 在前（由舊到新）
    _ntfRenderFeed({ force: true, prependDFB: dfb });
  } catch (e) {} finally { _ntfLoadingOlder = false; }
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

// 事件 → 分類（篩選用）：signal=訊號通知 / auto=自動交易
function _ntfCat(ev) {
  return (ev === "entry" || ev === "tp" || ev === "sl") ? "signal" : "auto";
}
// 篩選比對：all=全部、signal=策略訊號、auto=自動交易(進+出)、entry=自動進場、exit=自動出場(止盈/止損)
function _ntfMatch(ev, f) {
  switch (f) {
    case "coach":  return ev === "coach";     // 教練可進場
    case "signal": return ev === "entry" || ev === "tp" || ev === "sl";
    case "auto":   return ev === "atrade_open" || ev === "atrade_tp" || ev === "atrade_sl";
    case "entry":  return ev === "atrade_open";
    case "exit":   return ev === "atrade_tp" || ev === "atrade_sl";
    default:       return true;   // all
  }
}
// 事件 → 種類標籤（顯示用）：label=標籤字 / cls=標籤色 / bub=泡泡邊色
function _ntfType(ev) {
  switch (ev) {
    case "coach":       return { label: "🎯 可進場", cls: "t-tp",      bub: "evt-entry" };
    case "entry":       return { label: "進場",     cls: "t-entry",   bub: "evt-entry" };
    case "tp":          return { label: "止盈",     cls: "t-tp",      bub: "evt-tp" };
    case "sl":          return { label: "止損",     cls: "t-sl",      bub: "evt-sl" };
    case "atrade_open": return { label: "🤖 進場",  cls: "t-auto",    bub: "evt-auto" };
    case "atrade_tp":   return { label: "✅ 止盈",  cls: "t-auto-tp", bub: "evt-auto" };
    case "atrade_sl":   return { label: "👎 止損",  cls: "t-auto-sl", bub: "evt-auto" };
    default:            return { label: "🤖 自動",  cls: "t-auto",    bub: "evt-auto" };  // atrade(取消/其他)
  }
}
let _ntfFilter = (() => { try { const f = localStorage.getItem("notifyFeedFilter") || "all"; return f === "signal" ? "all" : f; } catch (e) { return "all"; } })();   // 「訊號」分類已移除 → 舊存值遷移成 all
let _ntfRenderSig = "";   // 上次渲染內容簽章（篩選+筆數+末筆ts）→ 沒變就不重畫（消除每 20 秒閃爍/捲動跳）

// 事件 ts → 日期分隔標籤：今天 / 昨天 / M/D
function _ntfDayLabel(ts) {
  const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 今日摘要：訊號數 / 自動勝敗 / 已實現盈虧（盈虧由自動平倉 body 解析）
// 資料源優先用 _ntfTodayItems（後端自當地午夜起抓、不被 feed 80 筆截斷）；未載入則退回顯示用 feed。
let _ntfTodayItems = null;
let _ntfTodayStatsSrv = null;   // 後端 SQL 算好的今日統計(量再大都準，不靠撈全部筆數)
function _ntfTodayMidnight() { const x = new Date(); x.setHours(0, 0, 0, 0); return x.getTime() / 1000; }
async function _ntfRefreshToday() {
  if (!window._acctName) { _ntfTodayItems = null; _ntfTodayStatsSrv = null; return; }
  try {
    const j = await _ntfApi("GET", "feed?name=" + encodeURIComponent(window._acctName) +
                            "&since=" + _ntfTodayMidnight() + "&limit=200");
    _ntfTodayItems = j.items || [];
    _ntfTodayStatsSrv = j.stats || null;
  } catch (e) { _ntfTodayItems = null; _ntfTodayStatsSrv = null; }
  _ntfRenderSummary();
}
function _ntfTodayStats() {
  // 優先用後端 SQL 聚合(自動交易繁忙一天上萬筆也準)；沒有才退回前端逐筆數(後備)
  if (_ntfTodayStatsSrv) {
    const s = _ntfTodayStatsSrv;
    return { sigN: s.sig_n || 0, aWin: s.win_n || 0, aLoss: s.loss_n || 0,
             autoN: (s.win_n || 0) + (s.loss_n || 0), pnl: s.pnl || 0, hasPnl: !!s.has_pnl };
  }
  const t0 = _ntfTodayMidnight();
  let sigN = 0, aWin = 0, aLoss = 0, pnl = 0, hasPnl = false;
  for (const it of (_ntfTodayItems || _ntfFeed.items)) {
    if (it.ts < t0) continue;
    if (it.event === "entry") sigN++;
    else if (it.event === "atrade_tp") aWin++;
    else if (it.event === "atrade_sl") aLoss++;
    if (it.event === "atrade_tp" || it.event === "atrade_sl") {
      const m = String(it.body || "").match(/已實現盈虧\s*([+-]?[\d,.]+)\s*USDT/);
      if (m) { pnl += parseFloat(m[1].replace(/,/g, "")); hasPnl = true; }
    }
  }
  return { sigN, aWin, aLoss, autoN: aWin + aLoss, pnl, hasPnl };
}

function _ntfRenderSummary() {
  const wrap = document.getElementById("mSigSummary");
  if (!wrap) return;
  const s = _ntfTodayStats();
  if (!window._acctName || (!s.sigN && !s.autoN)) { wrap.innerHTML = ""; return; }
  // 盈虧優先取月曆今天那格（Binance 帳務淨額＝已實現+手續費+資金費，與月曆一致）；
  // 月曆未載入才退回通知文字湊的估值（只 REALIZED_PNL、漏手續費/資金費 → 會跟月曆對不上）。
  const _p = (n) => String(n).padStart(2, "0");
  const _t = new Date();
  const _todayKey = `${_t.getFullYear()}-${_p(_t.getMonth() + 1)}-${_p(_t.getDate())}`;
  const _calToday = (_ntfCalData && (_todayKey in _ntfCalData)) ? _ntfCalData[_todayKey] : null;
  const _pnl = _calToday != null ? _calToday : s.pnl;
  const _hasPnl = _calToday != null || s.hasPnl;
  const pnlTxt = _hasPnl
    ? `<span class="${_pnl >= 0 ? "sc-pos" : "sc-neg"}">${_pnl >= 0 ? "+" : ""}${_pnl.toFixed(2)}</span>`
    : "—";
  wrap.innerHTML = `<div class="m-sig-summary">
    <span class="sc-day">今日</span>
    <div class="sc-cell"><div class="sc-v">${s.sigN}</div><div class="sc-k">訊號</div></div>
    <div class="sc-cell"><div class="sc-v"><span class="sc-pos">${s.aWin}</span><span class="sc-sep">/</span><span class="sc-neg">${s.aLoss}</span></div><div class="sc-k">自動勝敗</div></div>
    <div class="sc-cell"><div class="sc-v">${pnlTxt}</div><div class="sc-k">盈虧</div></div>
  </div>`;
}

// 找此「平倉」要引用的「進場」index：訊號 tp/sl→entry；自動 tp/sl→atrade_open（用 sig/dir/t 精配）
function _ntfQuoteIdx(items, it) {
  if (!it.sig) return -1;
  const target = (it.event === "tp" || it.event === "sl") ? "entry"
               : (it.event === "atrade_tp" || it.event === "atrade_sl") ? "atrade_open" : null;
  if (!target) return -1;
  return items.findIndex(o => o.event === target && o.sig === it.sig && o.dir === it.dir &&
                              o.symbol === it.symbol && o.tf === it.tf && o.t === it.t);
}

function _ntfShowNewPill() { const p = document.getElementById("mSigNewPill"); if (p) p.hidden = false; }
function _ntfHideNewPill() { const p = document.getElementById("mSigNewPill"); if (p) p.hidden = true; }

function _ntfRenderFeed(opts) {
  opts = opts || {};
  const list = document.getElementById("mSigList");
  if (!list) return;
  let items = _ntfFeed.items;
  if (_ntfFilter !== "all") items = items.filter(it => _ntfMatch(it.event, _ntfFilter));

  if (!items.length) {
    _ntfRenderSig = _ntfFilter + ":0:0";
    _ntfRenderSummary();
    const why = !window._acctName ? "請先登入帳號"
              : (_ntfFilter === "entry") ? "尚無自動進場紀錄"
              : (_ntfFilter === "exit") ? "尚無自動出場紀錄"
              : (_ntfFilter === "auto") ? "尚無自動交易紀錄" : "尚無訊號通知";
    list.innerHTML = `<div class="m-sig-empty">${why}</div>`;
    _ntfHideNewPill();
    return;
  }

  // 內容簽章：篩選+筆數+末筆ts 沒變 → 完全不動 DOM（避免每 20 秒整批重畫造成閃爍/捲動跳）
  const sig = _ntfFilter + ":" + items.length + ":" + items[items.length - 1].ts;
  if (!opts.force && sig === _ntfRenderSig) return;
  const prevCount = parseInt(_ntfRenderSig.split(":")[1] || "0", 10);
  const grew = _ntfRenderSig.split(":")[0] === _ntfFilter && items.length > prevCount;
  _ntfRenderSig = sig;
  _ntfRenderSummary();   // 內容有變才重建摘要卡

  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const prevTop = list.scrollTop;

  let html = ""; let lastDay = "";
  items.forEach((it, i) => {
    const day = _ntfDayLabel(it.ts);
    if (day !== lastDay) { html += `<div class="m-sig-day"><span>${day}</span></div>`; lastDay = day; }
    const ty = _ntfType(it.event);
    // 平倉 → 引用對應進場（LINE/Messenger「回覆」感）：訊號 tp/sl→entry、自動 tp/sl→atrade_open
    let quote = "";
    const qi = _ntfQuoteIdx(items, it);
    if (qi >= 0) {
      const lines = String(items[qi].body || "").split("\n");
      quote = `<div class="m-sig-quote" data-qi="${qi}">
        <div class="m-sig-q-t">${_ntfEsc(lines[0] || items[qi].title)}</div>
        ${lines[1] ? `<div class="m-sig-q-b">${_ntfEsc(lines[1])}</div>` : ""}
      </div>`;
    }
    // 標題統一成「標的 · 時框」（不管後端 title 怎麼帶）→ 種類由左側 tag 標示
    const headline = (it.symbol || "") + (it.tf ? " · " + it.tf : "");
    html += `<div class="m-sig-msg" id="mSigMsg${i}">
      <img class="m-sig-avatar" src="/static/img/bear.png" alt="小啊">
      <div class="m-sig-col">
        <div class="m-sig-name">小啊</div>
        <div class="m-sig-bubble ${ty.bub}" data-sym="${it.symbol || ""}" data-mkt="${it.market || ""}" data-exch="${it.exchange || ""}"
             data-tf="${it.tf || ""}" data-t="${_ntfEsc(it.t || "")}">
          <div class="m-sig-b-head">
            <span class="m-sig-tag ${ty.cls}">${ty.label}</span>
            <span class="m-sig-b-title">${_ntfEsc(headline)}</span>
          </div>
          ${quote}
          <div class="m-sig-b-body">${_ntfEsc(it.body)}</div>
          <div class="m-sig-b-time">${_ntfFmtTime(it.ts)}</div>
        </div>
      </div>
    </div>`;
  });
  list.innerHTML = html;

  list.querySelectorAll(".m-sig-bubble").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.sym) _ntfGoSymbol({ symbol: b.dataset.sym, market: b.dataset.mkt, exchange: b.dataset.exch,
                                      tf: b.dataset.tf, t: b.dataset.t });
  }));
  // 點引用塊 → 捲到原進場訊息並短暫高亮（不觸發跳圖）
  list.querySelectorAll(".m-sig-quote").forEach(q => q.addEventListener("click", e => {
    e.stopPropagation();
    const el = document.getElementById("mSigMsg" + q.dataset.qi);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("m-sig-hl");
      setTimeout(() => el.classList.remove("m-sig-hl"), 1400);
    }
  }));

  // 捲動策略：往上載入更早(prepend) → 維持「距底距離」不變(視覺不跳)；原本在底部(或強制) → 跟到最新；
  // 否則保持原位、有新訊息時給「↓ 新訊息」提示（不打斷閱讀）
  if (opts.prependDFB != null) { list.scrollTop = Math.max(0, list.scrollHeight - opts.prependDFB); }
  else if (atBottom || opts.toBottom) { list.scrollTop = list.scrollHeight; _ntfHideNewPill(); }
  else { list.scrollTop = prevTop; if (grew) _ntfShowNewPill(); }
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

// 合併最新一批進現有清單（依 id 去重、由舊到新）→ 輪詢不會洗掉「往前載入的更早筆」。
function _ntfMergeFeed(latest) {
  const cur = _ntfFeed.items;
  if (!cur.length) return latest || [];
  const have = new Set(cur.map(x => x.id));
  const add = (latest || []).filter(x => x.id && !have.has(x.id));
  if (!add.length) return cur;
  return cur.concat(add).sort((a, b) => (a.id || 0) - (b.id || 0));
}

async function _ntfBgPoll() {
  _ntfFeed.items = _ntfMergeFeed(await _ntfFetchFeed());
  if (document.body.classList.contains("m-tab-signals")) {
    _ntfRenderFeed();
    if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
  }
  _ntfUpdateBadge();
}

// 切到訊號分頁時呼叫（main.js）：載入清單 + 標記已讀 + 開快輪詢
// ── 每日盈虧月曆（訊號頁頂部）──────────────────────────────────────────
//   資料＝/api/trade/pnl_daily（Binance 已實現損益+手續費+資金費，按台北日加總）。
//   需綁定交易帳號(有交易口令)才有資料；沒綁定→顯示提示、不報錯。
let _ntfCalMonth = null, _ntfCalData = null, _ntfCalByday = null;
function _ntfMonthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function _ntfCalFmt(v, dp) { return (Number(v) || 0).toFixed(dp == null ? 2 : dp); }

async function _ntfLoadCal(force) {
  const cal = document.getElementById("mSigCal");
  if (!cal) return;
  if (!_ntfCalMonth) _ntfCalMonth = _ntfMonthStart(new Date());
  if (_ntfCalData && !force) { _ntfRenderCal(); return; }   // 有快取→直接重畫（切月也走這）
  cal.innerHTML = `<div class="m-sig-cal-empty">載入中…</div>`;
  try {
    const r = await _trdApi("pnl_daily");                    // 與交易面板共用同一交易口令
    _ntfCalData = r.days || {};
    _ntfCalByday = r.byday || {};                            // 每日明細（點那天看進出場詳情）
    _ntfRenderCal();
  } catch (e) {
    _ntfCalData = null;
    const need = /口令|403|登入|綁定|金鑰|key/i.test(e.message || "");
    cal.innerHTML = `<div class="m-sig-cal-empty">${need ? "綁定交易帳號後顯示每日盈虧" : "盈虧載入失敗"}</div>`;
    const totalEl = document.getElementById("mSigCalTotal");
    if (totalEl) totalEl.textContent = "";
  }
}

function _ntfRenderCal() {
  const cal = document.getElementById("mSigCal");
  const titleEl = document.querySelector("#mSigCalWrap .m-sig-cal-title");
  const totalEl = document.getElementById("mSigCalTotal");
  if (!cal) return;
  const days = _ntfCalData || {};
  const m = _ntfCalMonth || _ntfMonthStart(new Date());
  const y = m.getFullYear(), mo = m.getMonth();
  const pad = (n) => String(n).padStart(2, "0");
  if (titleEl) titleEl.textContent = `${y} / ${pad(mo + 1)} 盈虧月曆`;
  const dim = new Date(y, mo + 1, 0).getDate();
  const lead = new Date(y, mo, 1).getDay();                  // 該月一號星期幾（日=0）
  const t = new Date();
  const todayKey = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  let sum = 0, td = 0;
  const cells = ["日", "一", "二", "三", "四", "五", "六"].map(w => `<div class="m-sig-cal-wd">${w}</div>`);
  for (let i = 0; i < lead; i++) cells.push(`<div class="m-sig-cal-cell m-sig-cal-x"></div>`);
  for (let d = 1; d <= dim; d++) {
    const key = `${y}-${pad(mo + 1)}-${pad(d)}`;
    const v = days[key];
    let cls = "m-sig-cal-cell", pnl = "", attr = "";
    if (v != null && Math.abs(v) > 1e-9) {
      sum += v; td++;
      cls += v >= 0 ? " m-sig-cal-up" : " m-sig-cal-dn";
      cls += " m-sig-cal-has";                               // 有交易 → 可點看詳情
      attr = ` data-d="${key}"`;
      pnl = `<span class="m-sig-cal-pnl">${v >= 0 ? "+" : ""}${_ntfCalFmt(v, Math.abs(v) >= 100 ? 0 : 1)}</span>`;
    }
    if (key === todayKey) cls += " m-sig-cal-today";
    cells.push(`<div class="${cls}"${attr}><span class="m-sig-cal-d">${d}</span>${pnl}</div>`);
  }
  cal.innerHTML = cells.join("");
  if (totalEl) totalEl.innerHTML =
    `本月 <b class="${sum >= 0 ? "m-sig-up" : "m-sig-dn"}">${sum >= 0 ? "+" : ""}${_ntfCalFmt(sum, 2)}</b> USDT · ${td} 交易日`;
  try { _ntfRenderSummary(); } catch (e) {}     // 月曆載入後同步今日摘要盈虧（取月曆今天淨額→與月曆一致）
}
window._ntfLoadCal = _ntfLoadCal;

// 點某天 → 跳出當天進出場詳情（平倉已實現/手續費/資金費，逐筆）
function _ntfShowCalDetail(dateKey) {
  const ov = document.getElementById("mSigCalDetail");
  if (!ov) return;
  const rows = ((_ntfCalByday && _ntfCalByday[dateKey]) || []).filter(r => r.type !== "COMMISSION");  // 不顯示手續費列
  const sum = (_ntfCalData && _ntfCalData[dateKey]) || 0;
  const TY = { REALIZED_PNL: "平倉", COMMISSION: "手續費", FUNDING_FEE: "資金費" };
  const hhmm = (ts) => {
    const d = new Date(ts * 1000 + 8 * 3600 * 1000);          // 台北
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };
  ov.querySelector(".m-sig-caldt-date").textContent = dateKey.replace(/-/g, "/");
  const sEl = ov.querySelector(".m-sig-caldt-sum");
  sEl.textContent = `${sum >= 0 ? "+" : ""}${_ntfCalFmt(sum, 2)} USDT`;
  sEl.className = "m-sig-caldt-sum " + (sum >= 0 ? "m-sig-up" : "m-sig-dn");
  const list = ov.querySelector(".m-sig-caldt-list");
  list.innerHTML = rows.length ? rows.map(r => `
    <div class="m-sig-caldt-row">
      <span class="m-sig-caldt-t">${hhmm(r.ts)}</span>
      <span class="m-sig-caldt-sym">${r.sym || "—"}</span>
      <span class="m-sig-caldt-ty">${TY[r.type] || r.type || ""}</span>
      <span class="m-sig-caldt-pnl ${r.pnl >= 0 ? "m-sig-up" : "m-sig-dn"}">${r.pnl >= 0 ? "+" : ""}${_ntfCalFmt(r.pnl, 4)}</span>
    </div>`).join("") : `<div class="m-sig-cal-empty">當天無明細</div>`;
  ov.hidden = false;
}

window._ntfLoadFeed = async function () {
  _ntfLoadCal();                                     // 進訊號頁 → 載入/重畫每日盈虧月曆
  _ntfNoMoreOlder = false;                           // 重新進頁 → 重置「已到底」，可再往前載入
  _ntfFeed.items = await _ntfFetchFeed();            // 初次進頁：重置成最新一批
  _ntfRefreshToday();                                // 今日摘要：抓自當地午夜起的全部（不被 80 筆截斷）
  _ntfRenderFeed({ force: true, toBottom: true });   // 進分頁：重畫並捲到最新
  if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
  _ntfUpdateBadge();
  clearInterval(_ntfFeed.pollTimer);
  _ntfFeed.pollTimer = setInterval(async () => {
    _ntfFeed.items = _ntfMergeFeed(await _ntfFetchFeed());   // 輪詢：合併新訊息、保留往前載入的更早筆
    _ntfRefreshToday();
    _ntfRenderFeed();
    if (_ntfFeed.items.length) _ntfSetSeen(_ntfFeed.items[_ntfFeed.items.length - 1].ts);
    _ntfUpdateBadge();
  }, 20000);
};
window._ntfStopFeedPoll = function () { clearInterval(_ntfFeed.pollTimer); _ntfFeed.pollTimer = null; };

// best-effort：切到通知標的＋對應時框，載入後捲到訊號時間（對不到格式只是圖不變，不會壞）
function _ntfGoSymbol(info) {
  try {
    const mktEl = document.getElementById("marketSelect");
    const mkt = info.market === "tw" ? "tw" : info.market === "us" ? "us" : "crypto";
    if (mktEl && mktEl.value !== mkt) { mktEl.value = mkt; if (typeof updateMarketUI === "function") updateMarketUI(); }
    const inp = document.getElementById("symbolInput");
    if (inp) inp.value = info.symbol;
    // 切到通知對應的時框（1h/30m/15m…）：與 tf-btn 點擊行為一致
    if (info.tf && document.querySelector(`.tf-btn[data-tf="${info.tf}"]`) && typeof currentTF !== "undefined") {
      currentTF = info.tf;
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.toggle("active", b.dataset.tf === info.tf));
      if (typeof applyMobileTFVisibility === "function") applyMobileTFVisibility();
    }
    const p = (typeof loadData === "function") ? loadData(false) : null;
    if (typeof window._mSetTab === "function") window._mSetTab("chart");
    if (p && p.then && info.t) p.then(() => _ntfScrollToTime(info.t, info.tf)).catch(() => {});
  } catch (e) {}
}

// 圖表捲到訊號時間附近（圖表時間 = UTC+8，與 toTime 慣例一致）；
// 超出已載入歷史時 Lightweight Charts 會自動夾在最舊處，不會壞。
const _NTF_TF_SEC = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
                      "4h": 14400, "8h": 28800, "1d": 86400, "1w": 604800, "1M": 2592000 };
function _ntfScrollToTime(t, tf) {
  try {
    if (typeof mainChart === "undefined" || !mainChart || !t) return;
    let iso = String(t).trim().replace(" ", "T");
    if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += "Z";   // 後端為 UTC naive ISO
    const ep = Date.parse(iso);
    if (!isFinite(ep)) return;
    const sec = _NTF_TF_SEC[tf] || _NTF_TF_SEC[(typeof currentTF !== "undefined" && currentTF) || ""] || 86400;
    const tgt = Math.floor(ep / 1000) + 8 * 3600;
    mainChart.timeScale().setVisibleRange({ from: tgt - 90 * sec, to: tgt + 30 * sec });
  } catch (e) {}
}
