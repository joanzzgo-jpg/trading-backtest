/* 鍵盤快捷鍵（2026-08-02）
   為什麼：切時框是這個工具裡最高頻的動作，原本每次都要把游標移到上方那排按鈕。
   現有全域鍵只有 Cmd/Ctrl+Z（復原繪圖）、↑↓/空白（報價列導航）、Escape（各彈窗），
   數字鍵與 / ? [ ] 都還是空的，不會撞。

   ⚠ 一律先擋掉「正在打字」與「彈窗開著」：
     - input / textarea / select / contentEditable → 直接不處理（否則搜尋框打 1 會跳時框）
     - 有任何 overlay 開著（標的搜尋/重播選擇器/公告/農民曆…）→ 交給該彈窗自己處理
   ⚠ 帶修飾鍵（Cmd/Ctrl/Alt）一律略過：那些是瀏覽器/系統的（Cmd+1 切分頁等），搶了會很煩。 */
(function () {
  const SHEET_ID = "hotkeySheet";

  function _typing() {
    const a = document.activeElement;
    if (!a) return false;
    const t = (a.tagName || "").toLowerCase();
    return t === "input" || t === "textarea" || t === "select" || a.isContentEditable === true;
  }

  // 任何開著的全螢幕遮罩 → 讓位（它們各自有 Escape/Enter 邏輯）
  function _overlayOpen() {
    const ids = ["symOverlay", "replayPickerOverlay", "announceOverlay", "lunarOverlay", "landingScreen"];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("hidden") && el.offsetParent !== null) return true;
    }
    return false;
  }

  const tfBtns = () => [...document.querySelectorAll(".tf-btn")];

  function _gotoTf(idx) {
    const b = tfBtns();
    if (idx < 0 || idx >= b.length) return;
    b[idx].click();
    _flash(b[idx].textContent.trim());
  }

  function _stepTf(dir) {
    const b = tfBtns();
    const cur = b.findIndex(x => x.classList.contains("active"));
    if (cur < 0) return;
    const next = Math.min(b.length - 1, Math.max(0, cur + dir));
    if (next !== cur) { b[next].click(); _flash(b[next].textContent.trim()); }
  }

  // 短暫顯示切到哪個時框（鍵盤操作看不到滑鼠回饋 → 給一個確認）
  let _flashT = null;
  function _flash(txt) {
    let el = document.getElementById("hotkeyFlash");
    if (!el) {
      el = document.createElement("div");
      el.id = "hotkeyFlash";
      el.style.cssText = "position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:99998;" +
        "background:rgba(20,22,30,.88);color:#e8e4dc;border:1px solid rgba(255,255,255,.18);" +
        "padding:7px 20px;border-radius:10px;font-size:19px;font-weight:800;letter-spacing:.04em;" +
        "pointer-events:none;transition:opacity .18s ease";
      document.body.appendChild(el);
    }
    el.textContent = txt;
    el.style.opacity = "1";
    clearTimeout(_flashT);
    _flashT = setTimeout(() => { el.style.opacity = "0"; }, 700);
  }

  const ROWS = [
    ["1 – 0", "切換時間框架（依上方按鈕順序，0＝最後一個）"],
    ["[  ]　← →", "上一個／下一個時間框架（重播中 ← → 改為逐根前進/後退）"],
    ["/", "開啟標的搜尋"],
    ["R", "重播模式"],
    ["Cmd/Ctrl + Z", "復原繪圖"],
    ["↑ ↓ / 空白", "報價列上下選取"],
    ["?", "顯示／關閉這張表"],
    ["Esc", "關閉彈窗"],
  ];

  function _toggleSheet() {
    let el = document.getElementById(SHEET_ID);
    if (el) { el.remove(); return; }
    el = document.createElement("div");
    el.id = SHEET_ID;
    el.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(10,10,16,.62);backdrop-filter:blur(4px)";
    el.innerHTML =
      '<div style="min-width:min(420px,92vw);background:linear-gradient(176deg,#f8ecd3,#eddcb6);' +
      'color:#5c4526;border:2px solid #caa876;border-radius:16px;padding:20px 22px;' +
      'box-shadow:0 20px 50px rgba(34,18,4,.5);font-family:inherit">' +
      '<div style="font-size:17px;font-weight:900;margin-bottom:12px">⌨️ 鍵盤快捷鍵</div>' +
      ROWS.map(([k, d]) =>
        '<div style="display:flex;gap:12px;align-items:baseline;padding:5px 0;' +
        'border-bottom:1px dashed rgba(140,105,60,.28)">' +
        '<span style="min-width:104px;font-weight:800;font-size:13px">' + k + '</span>' +
        '<span style="font-size:12.5px;color:#7c6142">' + d + '</span></div>').join("") +
      '<div style="margin-top:12px;font-size:11.5px;color:#9a7c4e">' +
      '在輸入框打字時快捷鍵不作用；按 ? 或 Esc 關閉</div></div>';
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
  }

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;      // 交給瀏覽器/系統與既有的 Cmd+Z
    if (_typing()) return;

    // ? 與 Esc 要能關掉自己這張表（即使有其他遮罩判斷）
    const sheet = document.getElementById(SHEET_ID);
    if (sheet && (e.key === "Escape" || e.key === "?")) { e.preventDefault(); sheet.remove(); return; }
    if (e.key === "?") { e.preventDefault(); _toggleSheet(); return; }

    if (_overlayOpen()) return;

    if (e.key >= "1" && e.key <= "9") { e.preventDefault(); _gotoTf(+e.key - 1); return; }
    if (e.key === "0")                { e.preventDefault(); _gotoTf(tfBtns().length - 1); return; }
    if (e.key === "[")                { e.preventDefault(); _stepTf(-1); return; }
    if (e.key === "]")                { e.preventDefault(); _stepTf(1);  return; }
    /* ★ 2026-08-06 左右鍵也切時框（使用者要求）。方向與畫面一致：上方那排是
       1M 1W 1D 4H 2H 1H 30m 15m 5m 1m（左＝大、右＝小）→ 按右就往右移＝切到更小的時框。
       ⚠ 重播模式下左右鍵是「逐根前進/後退」（ui.js 已註冊），那時不能搶。 */
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (typeof replayActive !== "undefined" && replayActive) return;
      e.preventDefault();
      _stepTf(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === "/")                { e.preventDefault(); if (typeof openSymSearch === "function") openSymSearch(); return; }
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      document.getElementById("replayModeBtn")?.click();
    }
  });

  window._hotkeySheet = _toggleSheet;   // 供說明按鈕呼叫
})();
