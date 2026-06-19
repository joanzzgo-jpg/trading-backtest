/* ══════════════════════════════════════════════════════════════
   帳號 + 跨裝置同步（設定與自選）—— 名稱-only、無密碼、無註冊、後台建立
   - 登入入口：封面大門上的「鎖」（點門 → 放大 → 跳鎖 → 輸帳號 → 解鎖 → 開門進場）
   - 登出：系統外觀設定裡
   - 大小寫敏感（"Abc" ≠ "abc"）；查無帳號 → 提示向管理員索取
   - 同步單位：整包 localStorage 快照（設定/顏色/自選/繪圖…）
   ══════════════════════════════════════════════════════════════ */
const _ACCT = { name: null, enabled: false };
let _acctSyncTimer = null;
let _acctLSHooked = false;
// 不跨裝置同步、也不可觸發同步的「裝置本地」key：
//  wxCoords=各裝置本地天氣座標；notifyFeedSeen=訊號分頁已讀時間（高頻寫入，會頻繁觸發整包推送
//  → 把這台的自選蓋掉另一台，造成自選不同步）。
// tradeKey=交易口令改走伺服器寫穿表（/api/trade/savekey|mykey）當唯一真相，不進整包快照
// （快照 last-write-wins 會被別台舊快照蓋掉、換裝置帶不到）。
// watchlist=自選改走伺服器寫穿表（/api/account/savewatch|mywatch）當唯一真相，不進整包快照
// （快照 last-write-wins 會被別台舊快照蓋掉 → 多裝置自選不同步、換裝置帶不到，與 tradeKey 同理）。
const _ACCT_SKIP = new Set(["acctName", "wxCoords", "notifyFeedSeen", "tradeKey", "watchlist"]);
// 每個帳號各自保存、切換帳號時要「乾淨換成該帳號的」設定 key：
//   chartColors=K棒+指標顏色 / chartStyles=指標參數·線寬·樣式 / chartLineStyles=各線寬樣式 /
//   sysColors=系統外觀色 / mobileTFs=手機顯示的時間框
// （這些本就含在整包快照同步內；列出來是為了切帳號時「取代而非合併」，避免殘留前一帳號的設定）
// 含手機端專屬 _m 變體（顏色/樣式手機與電腦各自獨立）→ 切帳號時也要一併清掉殘留
const _ACCT_THEME_KEYS = ["chartColors", "chartStyles", "chartLineStyles",
                          "chartColors_m", "chartStyles_m", "chartLineStyles_m",
                          "sysColors", "mobileTFs",
                          // 繪圖（各標的分桶）跟著帳戶移動：切帳號採「取代」→ 對方帳號沒繪圖就清空，
                          // 不殘留前一帳號的線/斐波那契。tv_drawings 為舊版單一全域 key（一併清掉）。
                          "tv_drawings_v2", "tv_drawings",
                          // 自選 + 通知偏好＝每帳號專屬：切帳號必須「取代」→ 否則前一帳號的自選會殘留、
                          // 被當成新帳號的自選同步上去（曾發生：Abc 的自選灌進 qwer，通知/自動交易跳錯標的）。
                          "watchlist", "notifyPrefs"];
// 登入「種子」不可帶的每帳號專屬 key：避免把上一個帳號的自選/偏好灌進「剛登入的空帳號」。
const _ACCT_SEED_SKIP = new Set(["watchlist", "notifyPrefs",
                                 "tv_drawings_v2", "tv_drawings"]);

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
    // 完全隔離：登入時先清掉裝置上「所有會同步」的 key（只保留 _ACCT_SKIP 裝置本地），
    // 再完全用此帳號雲端那一列重建 → 裝置狀態 == 此帳號資料，前一帳號殘留一律歸零，
    // 杜絕跨帳號污染（自選/通知/繪圖/顏色都各自獨立）。
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !_ACCT_SKIP.has(k)) toRemove.push(k);
    }
    for (const k of toRemove) { try { localStorage.removeItem(k); } catch (e) {} }
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
  // 種子（給雲端為空的新帳號用本機現值初始化）剔除每帳號專屬 key → 不把上一個帳號的自選/偏好
  // 灌進剛登入的帳號（跨帳號污染根因）。雲端已有資料的帳號不受影響（會直接套雲端的）。
  const seed = _acctSnapshot();
  for (const k of _ACCT_SEED_SKIP) delete seed[k];
  const j = await _acctApi("login", { name, data: seed });
  _acctSaveSession(j.name || name);
  // 自選走寫穿表：登入即拉雲端最新覆蓋本機（含舊快照自選遷移）。在套快照前先設好。
  await _acctPullWatch(j.name || name, j.data, true);
  const hasData = j.data && typeof j.data === "object" && Object.keys(j.data).length > 0;
  if (hasData) {
    _acctApplySnapshot(j.data);
    try { sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {}
    return { applied: true };
  }
  // 雲端空：不 reload → 即時刷新自選清單（可能已遷移/清空）
  if (typeof window._acctReloadWatch === "function") window._acctReloadWatch();
  return { applied: false };
}

async function _acctLogout() {
  // ① 先把目前帳號的資料完整存回伺服器（不遺失）→ ② 清空裝置上所有「會同步」的 key
  //    （避免殘留渲染到下一個登入帳號）→ ③ 回封面頁。與登入時的完全隔離對稱。
  const hadName = !!_ACCT.name;
  try { if (hadName) await _acctFlush(); } catch (e) {}     // 存檔（等它完成再清）
  _acctSaveSession(null);
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !_ACCT_SKIP.has(k)) toRemove.push(k);        // 保留裝置本地 key
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch (e) {}
  _acctRenderSys();
  document.getElementById("sysSettingsPopup")?.classList.remove("open");   // 收掉系統外觀彈窗
  // 手機：先把分頁切回「圖表」，收掉設定面板（#mSettings）背景，否則會跟封面圖重疊
  if (typeof window._mSetTab === "function") window._mSetTab("chart");
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

// ── 自選寫穿（唯一真相，不進快照）──────────────────────────────
let _acctWatchTimer = null;
window._acctSaveWatch = function (wl) {
  if (!_ACCT.name) return;
  clearTimeout(_acctWatchTimer);
  const arr = Array.isArray(wl) ? wl : [];
  _acctWatchTimer = setTimeout(() => {
    _acctApi("savewatch", { name: _ACCT.name, wl: arr }).catch(() => {});
  }, 600);
};
// 從雲端拉自選覆蓋本機。snapData=登入快照（供遷移舊自選）；clearIfEmpty=雲端與快照皆無時是否清本機
// （登入用 true 防跨帳號汙染；切回前景用 false 以免誤清本機未及上傳的自選）。
async function _acctPullWatch(name, snapData, clearIfEmpty) {
  if (!name) return;
  try {
    const r = await _acctApi("mywatch", { name });
    if (r && r.exists && Array.isArray(r.wl)) {
      try { localStorage.setItem("watchlist", JSON.stringify(r.wl)); } catch (e) {}
    } else if (snapData && snapData.watchlist) {
      // 寫穿表尚無此帳號 → 用登入快照裡的舊自選遷移過去（既有使用者不遺失）
      try { localStorage.setItem("watchlist", String(snapData.watchlist)); } catch (e) {}
      let wl = []; try { wl = JSON.parse(snapData.watchlist); } catch (e) {}
      if (Array.isArray(wl) && wl.length) _acctApi("savewatch", { name, wl }).catch(() => {});
    } else if (clearIfEmpty) {
      // 空帳號（登入時）：清掉本機殘留，避免上一帳號自選汙染
      try { localStorage.removeItem("watchlist"); } catch (e) {}
    }
  } catch (e) {}
}

function _acctSetMsg(msg, isErr) {
  const el = document.getElementById("landingAcctMsg");
  if (el) { el.textContent = msg || ""; el.classList.toggle("acct-err", !!isErr); }
}

/* ── 顯示登入狀態 + 登出（系統外觀[桌面] + 手機設定分頁）── */
function _acctRenderSys() {
  const label = _ACCT.name ? ("帳號：" + _ACCT.name)
              : (_ACCT.enabled ? "未登入（封面登入）" : "未登入");
  // 系統外觀（桌面）
  const row = document.getElementById("sysAcctRow");
  const nameEl = document.getElementById("sysAcctName");
  if (row) {
    if (!_ACCT.enabled) { row.style.display = "none"; }
    else {
      row.style.display = "flex";
      if (nameEl) nameEl.textContent = label;
      row.classList.toggle("sys-acct-out", !_ACCT.name);
    }
  }
  // 手機「設定」分頁
  const mName = document.getElementById("mSetAcctName");
  const mOut = document.getElementById("mSetLogoutBtn");
  if (mName) mName.textContent = label;
  if (mOut) mOut.style.display = (_ACCT.enabled && _ACCT.name) ? "" : "none";
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
  document.getElementById("mSetLogoutBtn")?.addEventListener("click", e => { e.stopPropagation(); _acctLogout(); });

  // 全面自動儲存：攔截 localStorage.setItem → 任何設定/自選變更都觸發雲端同步（debounce）。
  // 確保「不論哪台裝置，設定或自選一改就自動存」，不必逐一在每個設定函式掛 hook。
  try {
    if (!_acctLSHooked) {
      _acctLSHooked = true;
      const _origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) {
        _origSet(k, v);
        // 裝置本地 key（_ACCT_SKIP）不觸發雲端同步 → 否則高頻寫入會把整包設定（含自選）
        // 反覆推上雲端、覆蓋其他裝置的自選。
        if (!_ACCT_SKIP.has(k) && window._acctTouch) window._acctTouch();
      };
    }
  } catch (e) {}
  document.addEventListener("visibilitychange", () => {
    if (!_ACCT.name) return;
    if (document.hidden) { _acctFlush(); }
    else {
      // 切回前景 → 拉雲端最新自選覆蓋本機並刷新（讓另一台改的自選即時跟上）
      _acctPullWatch(_ACCT.name, null, false).then(() => {
        if (typeof window._acctReloadWatch === "function") window._acctReloadWatch();
      });
    }
  });
}
