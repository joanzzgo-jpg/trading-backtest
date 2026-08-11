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
    ["Shift（輕點）", "切換 K 棒圖／線型圖（按住 Shift 仍是繪圖鎖水平，不受影響）"],
    ["Cmd/Ctrl + Z", "復原繪圖"],
    ["Z / X / C", "顯示／隱藏繪圖圖層 A / B / C（點圖層鈕＝切換要畫在哪一層）"],
    ["V", "回上一步（復原繪圖；與 Cmd/Ctrl + Z 相同）"],
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

  /* ── 中文輸入法下的實體按鍵（2026-08-11 使用者回報「在中文輸入法時無效」）──────
     注音/拼音等 IME 開著時，瀏覽器會先把按鍵交給輸入法 → keydown 的 `e.key` 變成
     "Process"（keyCode 229），**所有用 e.key 判斷的快捷鍵一律失效**。
     這不只影響新加的 Z/X/C —— R（重播）、M（磁鐵）、數字切時框、[ ] / 全都中。
     `e.code` 是**實體按鍵位置**，不受輸入法與鍵盤配置影響 → e.key 認不出來時退回它。
     ⚠ 只在 e.key 不是單一字元時才退回，正常（英數輸入法）路徑完全不動。
     ⚠ 不需要排除 e.isComposing：真的在輸入文字時 `_typing()` 已經先擋掉了；
       焦點在圖表上時 IME 不會真的組字，那正是要救的情況。 */
  function _physKey(e) {
    const k = e.key || "";
    if (k.length === 1) return k;                      // 英數輸入法：照原本
    const c = e.code || "";
    if (/^Key[A-Z]$/.test(c))   return c.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    const M = { BracketLeft: "[", BracketRight: "]", Slash: e.shiftKey ? "?" : "/" };
    return M[c] || k;
  }
  window._physKey = _physKey;                          // 給 ui.js 的 M 鍵共用

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;      // 交給瀏覽器/系統與既有的 Cmd+Z
    if (_typing()) return;
    const K = _physKey(e);          // 中文輸入法下 e.key 會是 "Process"，一律走 K

    // ? 與 Esc 要能關掉自己這張表（即使有其他遮罩判斷）
    const sheet = document.getElementById(SHEET_ID);
    if (sheet && (e.key === "Escape" || K === "?")) { e.preventDefault(); sheet.remove(); return; }
    if (K === "?") { e.preventDefault(); _toggleSheet(); return; }

    if (_overlayOpen()) return;

    if (K >= "1" && K <= "9") { e.preventDefault(); _gotoTf(+K - 1); return; }
    if (K === "0")                { e.preventDefault(); _gotoTf(tfBtns().length - 1); return; }
    /* Z/X/C＝顯示／隱藏繪圖圖層 A/B/C。三層各自獨立，可以同時全開。
       ⚠ 走 window._toggleDrawLayer：draw.js 是延遲載入的，bundle 這裡拿不到它的區域函式。
       ⚠ 只認沒有修飾鍵的單鍵：Cmd/Ctrl+Z 是「復原繪圖」，不能被吃掉。 */
    /* V＝回上一步（復原繪圖）。與 Cmd/Ctrl+Z 同一個實作，只是單鍵更順手。
       ⚠ 只在真的有東西可復原時才提示：_drawUndo() 回 false 就不跳，別騙人說復原了。
       ⚠ 走 window._drawUndo：draw.js 是延遲載入的，這裡拿不到它的區域函式。 */
    if (K === "v" || K === "V") {
      if (typeof window._drawUndo === "function") {
        e.preventDefault();
        _flash(window._drawUndo() ? "↩ 已復原繪圖" : "沒有可復原的繪圖");
      }
      return;
    }
    if ("zxc".includes(K.toLowerCase())) {
      const layer = { z: "A", x: "B", c: "C" }[K.toLowerCase()];
      if (typeof window._toggleDrawLayer === "function") {
        const on = window._toggleDrawLayer(layer);
        if (on !== null) { e.preventDefault(); _flash("圖層 " + layer + (on ? " 顯示" : " 隱藏")); }
      }
      return;
    }
    if (K === "[")                { e.preventDefault(); _stepTf(-1); return; }
    if (K === "]")                { e.preventDefault(); _stepTf(1);  return; }
    /* ★ 2026-08-06 左右鍵也切時框（使用者要求）。方向與畫面一致：上方那排是
       1M 1W 1D 4H 2H 1H 30m 15m 5m 1m（左＝大、右＝小）→ 按右就往右移＝切到更小的時框。
       ⚠ 重播模式下左右鍵是「逐根前進/後退」（ui.js 已註冊），那時不能搶。 */
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (typeof replayActive !== "undefined" && replayActive) return;
      e.preventDefault();
      _stepTf(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (K === "/")                { e.preventDefault(); if (typeof openSymSearch === "function") openSymSearch(); return; }
    /* ★ 2026-08-10 輕點 Shift＝切換 K 棒／線型圖（使用者要求）。
       ⚠ 不能直接在 keydown 就切：Shift **已經被繪圖用掉了**——按住 Shift 畫線是「鎖水平」
         （draw.js `_shiftDown`／`_hSnapOn`）。若一按下就切，使用者每畫一條水平線圖型就翻一次。
       → 用「輕點」語義：按下時只記下候選，出現下列任一情況就取消候選：
           ① 按住期間又按了別的鍵（Shift+X 之類的組合）
           ② 按住期間有滑鼠動作（正在畫圖／拖曳）
           ③ 按住超過 400ms（＝在「按住」而不是「輕點」）
         放開時候選還在才切換。這樣畫水平線完全不受影響。 */
    if (K === "r" || K === "R") {
      e.preventDefault();
      document.getElementById("replayModeBtn")?.click();
    }
  });

  /* 輕點 Shift → 切換 K 棒／線型圖（見上方 keydown 內的說明）。
     ⚠ 用獨立的監聽器（capture=false、掛 window）而不是塞進上面那個 keydown：
       Shift 的 keydown 會**連發**（按住不放時作業系統重複送），要靠 e.repeat 擋掉；
       而且真正觸發的時機在 keyup，混在同一個 handler 裡反而難讀。 */
  let _shTap = false, _shAt = 0;
  const _shCancel = () => { _shTap = false; };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") {
      if (e.repeat) { _shTap = false; return; }        // 按住連發＝不是輕點
      if (e.metaKey || e.ctrlKey || e.altKey) { _shTap = false; return; }
      if (_typing() || _overlayOpen()) { _shTap = false; return; }
      _shTap = true; _shAt = Date.now();
      return;
    }
    _shCancel();                                        // 按住 Shift 期間又按別的鍵 → 組合鍵，不算輕點
  }, false);
  // 有「真的在操作」才取消：按住 Shift 拖曳/畫線是鎖水平，不能被當成切圖型。
  // ⚠ mousemove 必須加 buttons>0 的條件：純粹移動滑鼠不該取消（手在圖上飄一下就取消＝按了沒反應）。
  ["mousedown", "wheel", "touchstart"].forEach(ev =>
    window.addEventListener(ev, _shCancel, { passive: true }));
  window.addEventListener("mousemove", (e) => { if (e.buttons > 0) _shCancel(); }, { passive: true });
  window.addEventListener("blur", _shCancel);
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    const tap = _shTap && (Date.now() - _shAt) < 400;   // 400ms 內放開才算輕點
    _shTap = false;
    if (!tap) return;
    if (_typing() || _overlayOpen()) return;
    if (typeof window.toggleChartType !== "function") return;
    const isLine = window.toggleChartType();
    if (typeof showToast === "function") showToast(isLine ? "線型圖" : "K 棒圖");
  }, false);

  window._hotkeySheet = _toggleSheet;   // 供說明按鈕呼叫
})();
