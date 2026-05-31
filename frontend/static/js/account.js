/* ══════════════════════════════════════════════════════════════
   帳號 + 跨裝置同步（設定與自選）—— 名稱-only、無密碼、無註冊、後台建立
   - 登入入口：封面大門上的「鎖」（點門 → 放大 → 跳鎖 → 輸帳號 → 解鎖 → 開門進場）
   - 登出：系統外觀設定裡
   - 大小寫敏感（"Abc" ≠ "abc"）；查無帳號 → 提示向管理員索取
   - 同步單位：整包 localStorage 快照（設定/顏色/自選/繪圖…）
   ══════════════════════════════════════════════════════════════ */
const _ACCT = { name: null, enabled: false };
let _acctSyncTimer = null;
const _ACCT_SKIP = new Set(["acctName"]);

function _acctLoadSession() {
  try { _ACCT.name = localStorage.getItem("acctName"); } catch (e) {}
  window._acctName = _ACCT.name;
}
function _acctSaveSession(name) {
  _ACCT.name = name || null;
  window._acctName = _ACCT.name;
  try {
    if (name) localStorage.setItem("acctName", name);
    else localStorage.removeItem("acctName");
  } catch (e) {}
}

function _acctSnapshot() {
  const o = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !_ACCT_SKIP.has(k)) o[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return o;
}
function _acctApplySnapshot(data) {
  if (!data || typeof data !== "object") return;
  try {
    for (const k in data) {
      if (_ACCT_SKIP.has(k)) continue;
      if (data[k] != null) localStorage.setItem(k, String(data[k]));
    }
  } catch (e) {}
}

async function _acctApi(path, body) {
  const r = await fetch("/api/account/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || ("錯誤 " + r.status));
  return j;
}

// 登入（帳號須已由後台建立）。雲端有資料 → 套用；雲端空 → 用本機初始化。
// 回 { applied }：applied=true → 需 reload 才生效（套了雲端設定）。
async function _acctLogin(name) {
  const j = await _acctApi("login", { name, data: _acctSnapshot() });
  _acctSaveSession(j.name || name);
  const hasData = j.data && typeof j.data === "object" && Object.keys(j.data).length > 0;
  if (hasData) {
    _acctApplySnapshot(j.data);
    try { sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {}
    return { applied: true };
  }
  return { applied: false };
}

function _acctLogout() {
  _acctSaveSession(null);
  _acctRenderSys();
  document.getElementById("sysSettingsPopup")?.classList.remove("open");   // 收掉系統外觀彈窗
  try { sessionStorage.removeItem("landingDismissedAt"); } catch (e) {}      // 不再自動跳過封面
  if (typeof window._landingShow === "function") window._landingShow();     // 登出 → 跳回封面頁
}

// 自動同步：登入中、設定/自選變更 → debounce 推送整包
window._acctTouch = function () {
  if (!_ACCT.name) return;
  clearTimeout(_acctSyncTimer);
  _acctSyncTimer = setTimeout(_acctFlush, 2500);
};
async function _acctFlush() {
  if (!_ACCT.name) return;
  try { await _acctApi("sync", { name: _ACCT.name, data: _acctSnapshot() }); }
  catch (e) { if (/查無|404/.test(e.message)) _acctSaveSession(null); }
}

function _acctSetMsg(msg, isErr) {
  const el = document.getElementById("landingAcctMsg");
  if (el) { el.textContent = msg || ""; el.classList.toggle("acct-err", !!isErr); }
}

/* ── 系統外觀裡的「登入狀態 + 登出」── */
function _acctRenderSys() {
  const row = document.getElementById("sysAcctRow");
  const nameEl = document.getElementById("sysAcctName");
  if (!row) return;
  if (!_ACCT.enabled) { row.style.display = "none"; return; }
  row.style.display = "flex";
  if (_ACCT.name) {
    if (nameEl) nameEl.textContent = "帳號：" + _ACCT.name;
    row.classList.remove("sys-acct-out");
  } else {
    if (nameEl) nameEl.textContent = "未登入（封面輸入帳號）";
    row.classList.add("sys-acct-out");
  }
}

/* ── 封面大門的鎖：解鎖 → 接續開門 ── */
function _initLandingLock() {
  const inp = document.getElementById("landingAcctInput");
  const btn = document.getElementById("landingAcctBtn");
  if (!inp || !btn) return;
  const doUnlock = async () => {
    const name = inp.value.trim();
    if (!name) { _acctSetMsg("請輸入帳號", true); inp.focus(); return; }
    _acctSetMsg("解鎖中…");
    btn.disabled = true;
    try {
      const r = await _acctLogin(name);
      _acctSetMsg("解鎖成功 🔓");
      _acctRenderSys();
      // 接續開門動畫進場；若套了雲端設定 → 動畫後 reload 讓設定生效
      if (typeof window._landingEnter === "function") window._landingEnter();
      if (r.applied) setTimeout(() => location.reload(), 1350);
    } catch (e) {
      _acctSetMsg(e.message, true);
      btn.disabled = false;
      inp.focus();
    }
  };
  btn.addEventListener("click", e => { e.stopPropagation(); doUnlock(); });
  inp.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doUnlock(); } });
}

async function initAccount() {
  _acctLoadSession();
  try { _ACCT.enabled = (await (await fetch("/api/account/status")).json()).enabled === true; }
  catch (e) { _ACCT.enabled = false; }
  window._acctEnabled = _ACCT.enabled;

  const lock = document.getElementById("landingAcct");
  if (!_ACCT.enabled) {           // 後端未啟用 → 隱藏鎖（點門直接進場）、隱藏系統外觀帳號列
    lock?.style.setProperty("display", "none");
    _acctRenderSys();
    return;
  }
  _initLandingLock();
  _acctRenderSys();
  document.getElementById("sysLogoutBtn")?.addEventListener("click", e => { e.stopPropagation(); _acctLogout(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && _ACCT.name) _acctFlush(); });
}
