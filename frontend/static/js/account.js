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
// _tc=行情快取（ticker.js 每 ~2 秒寫一次，含期貨+現貨全清單）。★2026-08-05 加入：
//   它每 2 秒觸發一次 _acctTouch → 2.5s 的 debounce **永遠被重新計時**，_acctFlush 幾乎不會執行
//   （＝開著頁面時整包雲端同步形同失效，只剩切到背景那次 flush）；而且它是純裝置本地的快取，
//   推上雲端只是白白灌大快照。症狀：勝率欄的同步指示永遠停在「同步中…」。
const _ACCT_SKIP = new Set(["acctName", "wxCoords", "notifyFeedSeen", "tradeKey", "watchlist", "_tc"]);
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
  setTimeout(_refreshDrawingsIfStale, 300);   // 登入把快照寫進 localStorage 後，記憶體要跟上
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
  _acctSetSyncState("local");                               // 登出 → 回本機模式（勝率欄右端指示）
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

/* ── 雲端同步狀態指示（勝率欄右端 #acctSyncState，2026-08-05 使用者要求）──
   四態：
     local   沒登入帳號 → 純本機，不會跨裝置（灰）
     syncing 有變更待推送 / 推送中（橘，圓點呼吸）
     saved   已儲存至雲端（綠）
     offline 推不上去（斷網或伺服器錯誤）→ 資料仍在本機，連上會自動補傳（紅）
   ⚠ 只反映**上行**（本機→雲端）。下行是開機與切回前景各拉一次，不在這裡表示。 */
const _SYNC_TXT = { local: "本機模式", syncing: "同步中…", saved: "已儲存至雲端", offline: "離線中（未上傳）" };
let _acctSyncState = null;
function _acctSetSyncState(st) {
  if (st == null) st = _acctSyncState;      // 無參數＝重套目前狀態（勝率列重繪後補掛用）
  if (st == null) return;
  _acctSyncState = st;
  const el = document.getElementById("acctSyncState");
  if (!el) return;                       // 手機/極簡版面可能沒有這個節點
  el.dataset.state = st;
  el.textContent = _SYNC_TXT[st] || "";
  el.title = st === "offline"
    ? "連不上伺服器：資料已存在這台裝置，恢復連線後會自動補傳"
    : st === "local" ? "沒有登入帳號 → 設定與繪圖只留在這台裝置"
    : st === "saved" ? "設定與繪圖已同步到雲端，換裝置登入同一帳號就看得到"
    : "正在把變更推送到雲端…";
}
window._acctSetSyncState = _acctSetSyncState;

// 自動同步：登入中、設定/自選變更 → debounce 推送整包
window._acctTouch = function () {
  if (!_ACCT.name) return;
  _acctSetSyncState("syncing");          // 有變更待推 → 立刻讓使用者看到「還沒存完」
  clearTimeout(_acctSyncTimer);
  _acctSyncTimer = setTimeout(_acctFlush, 2500);
};
async function _acctFlush() {
  if (!_ACCT.name) return;
  _acctSetSyncState("syncing");
  try {
    await _acctApi("sync", { name: _ACCT.name, data: _acctSnapshot() });
    _acctSetSyncState("saved");
  }
  catch (e) {
    if (/查無|404/.test(e.message)) { _acctSaveSession(null); _acctSetSyncState("local"); }
    else _acctSetSyncState("offline");   // 斷網/伺服器錯誤：資料還在本機，連上會補傳
  }
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

/* ── 繪圖跨裝置同步（2026-08-02）────────────────────────────────────────────────
   ★問題：使用者回報「手機看不到電腦畫的繪圖」。查下去：
     ・繪圖確實有上雲（帳號快照裡 tv_drawings_v2 都在，實測某帳號 11 個標的、BTC 115 筆）
     ・手機也確實畫得出來（同一份 localStorage 下，手機視窗渲染像素比桌面還多）
     ・真正的斷點是**下行**：回到前景時只呼叫 _acctPullWatch，而它**只拉自選**
       （打 /mywatch、只寫 watchlist）。繪圖只有在「登入那一刻」才會隨快照下來 →
       一台已經登入著的手機，永遠看不到電腦後來新畫的線。
   → 回前景時多拉一次唯讀快照，只把繪圖那一把同步下來。
   ⚠ 只同步 tv_drawings_v2，不整包套用：chartColors_m / chartStyles_m 這些是
     「手機與電腦各自獨立」的設定，整包蓋下去會把手機的配色洗成電腦的。
   ⚠ 用 updated_at 比對，雲端不比我們新就不動 → 不會把手機剛畫的線洗掉。 */
/* 上次「已處理過的雲端版本」。⚠ 記的是**伺服器回報的 updated_at**，不是我們自己推送的時間：
   本機任何 localStorage 寫入（例如報價快取 _tc）都會觸發 debounce 推送，
   若用自己的推送時間當基準，這個閘門幾乎永遠是關的 → 別台的變更永遠拉不下來
   （第一版就是這樣寫，實測完全沒作用）。用伺服器版本比對，重複套用自己的推送也無害
   （內容相同 → _refreshDrawingsIfStale 會自己判定沒變、不重繪）。 */
let _acctSeenTs = 0;

async function _acctPullDrawings(name) {
  if (name) {
    try {
      const r = await _acctApi("pull", { name });
      if (r && r.exists && r.data) {
        const ts = Number(r.updated_at || 0);
        if (ts !== _acctSeenTs) {
          _acctSeenTs = ts;
          const remote = r.data.tv_drawings_v2;
          if (typeof remote === "string") {
            let local = null;
            try { local = localStorage.getItem("tv_drawings_v2"); } catch (e) {}
            if (remote !== local) { try { localStorage.setItem("tv_drawings_v2", remote); } catch (e) {} }
          }
        }
      }
    } catch (e) {}
  }
  // ⚠ 一定要在最後無條件跑：上面任何一步提早結束，都不該讓「儲存有、畫面沒有」的狀態留著。
  _refreshDrawingsIfStale();
}

/* 把「localStorage 裡當前標的的繪圖」與「畫面上實際畫著的」比對，不一致就重讀重畫。
   ★不能只比對 localStorage 前後有沒有變 —— 實測登入時快照**已經**把繪圖寫進 localStorage 了，
     但 draw.js 的 drawings 陣列是更早載入時讀進記憶體的、仍然是空的
     → 字串比對會相等而跳過，畫面永遠是空的（這正是「手機看不到電腦繪圖」的最後一哩）。
     所以要比的是**記憶體 vs 儲存**，不是儲存 vs 遠端。 */
function _refreshDrawingsIfStale() {
  try {
    if (typeof _drawSymKey !== "function" || typeof loadDrawings !== "function") return;
    let store = {};
    try { store = JSON.parse(localStorage.getItem("tv_drawings_v2") || "{}") || {}; } catch (e) { return; }
    const want = store[_drawSymKey()] || [];
    const have = (typeof drawings !== "undefined" && drawings) || [];
    if (want.length === have.length && JSON.stringify(want) === JSON.stringify(have)) return;
    loadDrawings();
    if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    if (want.length && typeof showToast === "function") showToast("✏️ 已同步另一台裝置的繪圖");
  } catch (e) {}
}
window._refreshDrawingsIfStale = _refreshDrawingsIfStale;

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

  // 訪客登入：不綁帳號、純本機模式進場（不同步雲端、通知/自動交易仍需登入帳號）。
  // landingDismissedAt 存 sessionStorage → 本次瀏覽略過封面，重開瀏覽器仍會回封面可再選登入。
  const guest = document.getElementById("landingGuestBtn");
  if (guest) guest.addEventListener("click", e => {
    e.stopPropagation();
    _acctSaveSession(null);           // 確保非帳號態（清掉任何殘留 session）
    _acctRenderSys();
    if (typeof window._landingEnter === "function") window._landingEnter();
  });
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
    _acctSetSyncState("local");     // 後端沒開帳號功能 → 一律本機模式
    return;
  }
  _initLandingLock();
  _acctRenderSys();

  /* ★ 2026-08-05「同一個帳號，切裝置繪圖沒被帶走」。
     根因：開機這條路只做 _acctLoadSession()（把帳號名稱從 localStorage 讀回來），
     **從來不向雲端拉快照**。_acctPullDrawings / _acctPullWatch 原本只掛在
     visibilitychange 的「切回前景」分支 → 在 B 裝置直接開啟頁面，看到的永遠是
     B 自己 localStorage 裡的舊繪圖；要先把分頁切走再切回來才會下行（沒人會這樣操作）。
     修法：已登入就在開機時補一次下行，與切回前景走完全相同的函式與參數。
     ⚠ clearIfEmpty 用 false：雲端沒有時不要清掉本機（本機可能有還沒上傳的）。
     ⚠ 上行不受影響：localStorage.setItem 的攔截器 + 2.5s debounce 照舊。 */
  _acctSetSyncState(_ACCT.name ? (navigator.onLine === false ? "offline" : "saved") : "local");
  // 斷線/回線：立刻反映，回線時把剛才沒推成功的補推上去
  window.addEventListener("offline", () => { if (_ACCT.name) _acctSetSyncState("offline"); });
  window.addEventListener("online",  () => { if (_ACCT.name) _acctFlush(); });

  if (_ACCT.name) {
    _acctPullDrawings(_ACCT.name);
    _acctPullWatch(_ACCT.name, null, false).then(() => {
      if (typeof window._acctReloadWatch === "function") window._acctReloadWatch();
    });
  }

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
      _acctPullDrawings(_ACCT.name);   // 繪圖同樣要下行（見該函式：原本只有自選會下來）
    }
  });
}
