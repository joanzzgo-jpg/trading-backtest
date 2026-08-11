function bindEvents() {
  document.getElementById("marketSelect").addEventListener("change", updateMarketUI);

  // ── 自選星號按鈕 ──────────────────────────────
  document.getElementById("watchlistStarBtn")?.addEventListener("click", () => {
    const symbol   = document.getElementById("symbolInput")?.value?.trim();
    const market   = document.getElementById("marketSelect")?.value || "crypto";
    const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
    if (!symbol) return;
    _toggleWatchlist(symbol, market, exchange);
    _updateStarBtn();
  });

  // ── 側欄 / 行情列表 ──────────────────────────────
  const isMobile = () => isMobileUI();
  function openTicker()   { document.getElementById("tickerPanel").classList.add("ticker-open");  showOverlay(); }
  function closeTicker()  { document.getElementById("tickerPanel").classList.remove("ticker-open"); checkOverlay(); }
  function showOverlay()  { document.getElementById("panelOverlay").classList.remove("hidden"); }
  function checkOverlay() {
    const tickerOpen = document.getElementById("tickerPanel").classList.contains("ticker-open");
    if (!tickerOpen) document.getElementById("panelOverlay").classList.add("hidden");
  }

  /* ★ 2026-08-11 上方右側按鈕列：把「垂直滾輪」轉成「橫向捲動」（使用者：「按鈕還是不能滑動」）。
     窄螢幕時那一列已經是 overflow-x:auto、程式上捲得動（實測 scrollLeft 可到 88px），
     但**滑鼠滾輪預設不會橫向捲**（要 Shift+滾輪或觸控板橫向手勢）→ 使用者實際上滑不動。
     ⚠ 只有真的溢出時才攔截 wheel，否則會把整頁的正常捲動吃掉。
     ⚠ 用 passive:false 才能 preventDefault（不然瀏覽器會忽略）。 */
  const _tbRight = document.querySelector(".topbar-right");
  if (_tbRight) {
    _tbRight.addEventListener("wheel", (e) => {
      if (_tbRight.scrollWidth <= _tbRight.clientWidth + 1) return;   // 沒溢出 → 不攔
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      _tbRight.scrollLeft += d;
      e.preventDefault();
    }, { passive: false });
  }

  document.getElementById("tickerToggle")?.addEventListener("click", () => {
    if (isMobile()) {
      const open = document.getElementById("tickerPanel").classList.contains("ticker-open");
      open ? closeTicker() : openTicker();
    } else {
      document.getElementById("tickerPanel").classList.toggle("ticker-collapsed");
      setTimeout(resizeAll, 50);
    }
  });
  document.getElementById("panelOverlay").addEventListener("click", closeTicker);

  // 共用：關閉所有浮動面板（確保同時只開一個）
  window._closeAllFloatPanels = function(except) {
    if (except !== "fx") {
      document.getElementById("fxPanel")?.classList.add("hidden");
      document.getElementById("fxToggleBtn")?.classList.remove("fx-open");
    }
    if (except !== "sys") {
      document.getElementById("sysSettingsPopup")?.classList.remove("open");
    }
    if (except !== "tf") {
      document.getElementById("tfPopup")?.classList.remove("open");
    }
  };

  // 系統外觀設定按鈕
  const _sysBtn = document.getElementById("sysSettingsBtn");
  const _sysPop = document.getElementById("sysSettingsPopup");
  _sysBtn?.addEventListener("click", e => {
    e.stopPropagation();
    const opening = !_sysPop.classList.contains("open");
    if (opening) _closeAllFloatPanels("sys");
    _sysPop.classList.toggle("open");
    if (opening) {
      syncSysSwatches();
      requestAnimationFrame(() => {
        const rect = _sysBtn.getBoundingClientRect();
        const pw = _sysPop.offsetWidth, ph = _sysPop.offsetHeight;
        let left = rect.right - pw;
        let top  = rect.bottom + 4;
        if (left < 4) left = 4;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
        _sysPop.style.left = left + "px";
        _sysPop.style.top  = top  + "px";
      });
    }
  });
  document.addEventListener("click", e => {
    if (_sysPop && !_sysPop.contains(e.target) && e.target !== _sysBtn) {
      _sysPop.classList.remove("open");
    }
  });

  document.getElementById("tickerList").addEventListener("click", () => {
    if (isMobile()) closeTicker();
  }, true);

  // 重播模式切換
  document.getElementById("replayModeBtn").addEventListener("click", () => {
    if (replayActive) { exitReplay(); return; }
    if (!ohlcvData.length) return alert("請先載入資料再使用重播");
    _openReplayPicker();
  });
  document.getElementById("replayPickerConfirm").addEventListener("click", async () => {
    const val = document.getElementById("replayStartDate").value;
    if (val && ohlcvData.length) {
      const targetTs = Math.floor(new Date(val + "T00:00:00Z").getTime() / 1000);
      if (targetTs < toTime(ohlcvData[0].time)) {
        const btn = document.getElementById("replayPickerConfirm");
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = "載入中…";
        await _replayPreload(targetTs);
        btn.disabled = false; btn.textContent = orig;
      }
    }
    document.getElementById("replayPickerOverlay").classList.add("hidden");
    enterReplay(val || null);
  });
  document.getElementById("replayPickerCancel").addEventListener("click", () => {
    document.getElementById("replayPickerOverlay").classList.add("hidden");
  });
  document.getElementById("replayPickerOverlay").addEventListener("click", e => {
    if (e.target === document.getElementById("replayPickerOverlay"))
      document.getElementById("replayPickerOverlay").classList.add("hidden");
  });
  // 快速預設按鈕
  document.querySelectorAll(".rp-preset[data-months]").forEach(btn => {
    btn.addEventListener("click", () => {
      const months = parseInt(btn.dataset.months);
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      const p = n => String(n).padStart(2, "0");
      _rpCal.setValue(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`);
    });
  });
  document.getElementById("replayPresetEarliest")?.addEventListener("click", () => {
    _rpCal.setValue(document.getElementById("replayStartDate").min);
  });
  // Calendar nav buttons
  document.getElementById("rpCalDisplay")?.addEventListener("click", () => _rpCal.toggle());
  document.getElementById("rpCalPrev")?.addEventListener("click", e => { e.stopPropagation(); _rpCal.prev(); });
  document.getElementById("rpCalNext")?.addEventListener("click", e => { e.stopPropagation(); _rpCal.next(); });
  document.getElementById("rpCalTitle")?.addEventListener("click", e => { e.stopPropagation(); _rpCal.toggleMode(); });
  // Close calendar when clicking outside
  document.addEventListener("click", e => {
    const wrap = document.getElementById("rpCalWrap");
    if (wrap && !wrap.contains(e.target)) _rpCal.close();
  });

  /* ── 繪圖工具欄 ──────────────────────────────
     ⚠ 選擇器用 [data-tool] 而不是 .dt-btn：工具按鈕現在有**兩排**
       （左側工具島 .dt-btn、開高低收量右側的快捷列 .sqd-btn）。
       用同一個選擇器 → 綁定與 active 狀態自動涵蓋兩邊，不必維護第二份。 */
  document.querySelectorAll("[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-tool]").forEach(b => b.classList.remove("active"));
      // ⚠ 要把「同一個工具的所有按鈕」都點亮，不能只亮被點的那顆：
      //   同一個工具在兩排各有一顆，只亮一顆的話另一排看起來像沒選到。
      document.querySelectorAll(`[data-tool="${btn.dataset.tool}"]`).forEach(b => b.classList.add("active"));
      setDrawTool(btn.dataset.tool);
    });
  });
  // 弱磁鐵切換（狀態要記住 —— 使用者回報「下次開又是關的」）
  const _magnetSync = () => {
    document.getElementById("btnMagnet")?.classList.toggle("active", _magnetMode);
    try { localStorage.setItem("magnetMode", _magnetMode ? "1" : "0"); } catch (e) {}
  };
  window._magnetSync = _magnetSync;
  // 只同步按鈕外觀；變數本身由 draw.js 在宣告處還原（它延遲載入、會覆寫這裡設的值）
  try {
    document.getElementById("btnMagnet")?.classList.toggle("active",
      localStorage.getItem("magnetMode") === "1");
  } catch (e) {}
  document.getElementById("btnMagnet")?.addEventListener("click", () => {
    _magnetMode = !_magnetMode;
    _magnetSync();
  });
  // Esc 回到 pointer / 取消進行中的繪圖
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("symOverlay").classList.contains("hidden")) return;
    if (e.key === "Escape") {
      if (replayActive) { exitReplay(); return; }
      // 連續箭頭(path)是多點工具：Esc 的語意是「收尾」而不是「丟棄」→ 先交給它處理。
      // ⚠ 這裡是唯一入口：draw.js 自己再聽一個 Esc 沒用，本支在 bundle 內先註冊、
      //   會搶先把 drawingWIP 清成 null，那邊就永遠等不到東西。
      if (drawingWIP && drawingWIP.type === "path" && typeof window._finishPath === "function") {
        window._finishPath();
      } else if (drawingWIP) { drawingWIP = null; requestAnimationFrame(renderDrawings); }
      document.querySelectorAll("[data-tool]").forEach(b => b.classList.remove("active"));
      document.querySelectorAll("[data-tool='pointer']").forEach(b => b.classList.add("active"));
      setDrawTool("pointer");
    }
    if (e.key === " " && replayActive && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      replayPlay();
    }
    if (e.key === "ArrowRight" && replayActive) { e.preventDefault(); replayStepForward(); }
    if (e.key === "ArrowLeft"  && replayActive) { e.preventDefault(); replayStepBack(); }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      drawings = drawings.filter(d => d.id !== selectedId);
      selectedId = null;
      document.getElementById("cpPopup")?.classList.remove("open");
      saveDrawings();
      requestAnimationFrame(renderDrawings);
    }
    // ⚠ 中文輸入法下 e.key 會是 "Process" → 走 window._physKey 取實體按鍵（見 hotkeys.js）
    const _k = (typeof window._physKey === "function") ? window._physKey(e) : (e.key || "");
    if ((_k === "m" || _k === "M") && document.activeElement.tagName !== "INPUT") {
      _magnetMode = !_magnetMode;
      if (typeof window._magnetSync === "function") window._magnetSync();   // 同上：一併存偏好
      else document.getElementById("btnMagnet")?.classList.toggle("active", _magnetMode);
    }
  });

  // indicatorsToggle 保留（無操作，設定改由各 pane 的 ⚙ 按鈕開啟）

  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTF = btn.dataset.tf;
      // 各時框有自己的繪圖預選色（draw.js `_TF_DRAW_COLOR_DEF`）→ 切完就換筆，不必手動切色
      if (typeof window._syncDrawColorForTf === "function") window._syncDrawColorForTf();
      if (typeof applyMobileTFVisibility === "function") applyMobileTFVisibility();  // 當前 TF 一律可見
      loadData(false);   // 切換時間框自動載入，不需手動按「載入」
    });
  });

  bindPaneDividers();
  bindLegendToggles();
  bindLegendColors();
  initColorPicker();
  bindReplayBar();
  bindIndicatorPanel();
}

function updateMarketUI() {
  const market   = document.getElementById("marketSelect").value;
  const isCrypto = market === "crypto";
  const isUS     = market === "us";
  const isTW     = market === "tw";

  document.getElementById("exchangeSelect").style.display = isCrypto ? "" : "none";

  const isHK     = market === "hk";
  const _inp = document.getElementById("symbolInput");
  const _cur = _inp.value.trim();
  const _defaults = ["BTC/USDT", "AAPL", "2330", "0700.HK"];
  if (isCrypto) {
    _inp.placeholder = "BTC/USDT";
    if (!_cur || _defaults.includes(_cur)) _inp.value = "BTC/USDT";
  } else if (isUS) {
    _inp.placeholder = "AAPL";
    if (!_cur || _defaults.includes(_cur)) _inp.value = "AAPL";
  } else if (isHK) {
    _inp.placeholder = "0700.HK";
    if (!_cur || _defaults.includes(_cur)) _inp.value = "0700.HK";
  } else {
    _inp.placeholder = "2330";
    if (!_cur || _defaults.includes(_cur)) _inp.value = "2330";
  }

  // 全部 TF 都啟用：
  // - 台股 4h 後端已支援（15m → 1h → 4h 重採樣，對齊台北 09:00 開盤）
  // - 美股 1h/4h/15m/5m 後端 yfinance 都支援（5m/15m 最多 60 天、1h 最多 730 天）
  // - 台指期：盤中(分/時)走 TAIFEX MIS 累積+resample、日/週/月走 FinMind → 全時框皆支援
  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.disabled = false;
  });

  // 符號搜尋 modal tabs
  const tabFutures = document.querySelector(".sym-tab[data-market='futures']");
  const tabSpot    = document.querySelector(".sym-tab[data-market='spot']");
  const tabUS      = document.querySelector(".sym-tab[data-market='us']");
  const tabTW      = document.querySelector(".sym-tab[data-market='tw']");
  const tabHK      = document.querySelector(".sym-tab[data-market='hk']");
  if (tabFutures) tabFutures.style.display = isCrypto ? "" : "none";
  if (tabSpot)    tabSpot.style.display    = isCrypto ? "" : "none";
  if (tabUS)      tabUS.style.display      = isUS ? "" : "none";
  if (tabTW)      tabTW.style.display      = isTW ? "" : "none";
  if (tabHK)      tabHK.style.display      = isHK ? "" : "none";
}

// 台指期三兄弟（歸在台股市場底下，由 symbol 判定走 TAIFEX 資料；全時框皆支援）
function isTxfSym(s) { return /^(TXF|MXF|TMF)$/i.test((s || "").trim()); }

/* ── 面板拖曳分隔 ── */
function bindPaneDividers() {
  document.querySelectorAll(".pane-divider").forEach(divider => {
    let startY, startFlex, nextFlex, pane, nextPane;

    function startDrag(clientY) {
      pane     = document.getElementById(divider.dataset.target);
      nextPane = nextVisiblePane(pane);
      if (!nextPane) return false;
      startY    = clientY;
      startFlex = parseFloat(pane.style.flex)     || 1;
      nextFlex  = parseFloat(nextPane.style.flex) || 1;
      divider.classList.add("dragging");
      return true;
    }
    function doMove(clientY) {
      const dy    = clientY - startY;
      const total = pane.parentElement.clientHeight;
      const delta = (dy / total) * (startFlex + nextFlex);
      pane.style.flex     = Math.max(0.2, startFlex + delta);
      nextPane.style.flex = Math.max(0.2, nextFlex  - delta);
      resizeAll();
    }
    function endDrag() {
      divider.classList.remove("dragging");
      savePaneFlexes();
    }

    divider.addEventListener("mousedown", e => {
      e.preventDefault();
      if (!startDrag(e.clientY)) return;
      const onMove = e => doMove(e.clientY);
      const onUp   = () => { endDrag(); window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });

    divider.addEventListener("touchstart", e => {
      e.preventDefault();
      if (!startDrag(e.touches[0].clientY)) return;
      const onMove = e => doMove(e.touches[0].clientY);
      const onEnd  = () => { endDrag(); divider.removeEventListener("touchmove", onMove); divider.removeEventListener("touchend", onEnd); };
      divider.addEventListener("touchmove", onMove, { passive: false });
      divider.addEventListener("touchend",  onEnd);
    }, { passive: false });
  });
}

/* ── 動態把時間軸移到最下方「實際可見」面板 ──
   用渲染高度（getBoundingClientRect）判斷可見，一次涵蓋三種隱藏：
   ① .hidden class ② subcharts-hidden（CSS display:none）③ 收合（pane-body display:none）。
   原本用 class/display 字串比對會漏掉 subcharts-hidden（容器層 class），
   導致中型畫面（iPad）副圖隱藏時時間軸卡在隱藏的 MACD 面板 → 主圖時間軸消失/錯位。
   改用 rect 高度後桌面/平板/手機共用同一套邏輯，不再有寬度分支落差。 */
function updateBottomTimeAxis() {
  // 由下而上排列（第一個找到的 = 當前最底部可見面板）
  const panels = [
    { paneId: "macdPane",   chart: macdChart   },
    { paneId: "rsiPane",    chart: rsiChart    },
    { paneId: "kdjPane",    chart: kdjChart    },
    { paneId: "mainPane",   chart: mainChart   },
  ];
  let bottomChart = mainChart;   // 保底：主圖永遠存在
  for (const { paneId, chart } of panels) {
    const pane = document.getElementById(paneId);
    if (!chart || !pane) continue;
    if (pane.getBoundingClientRect().height < 2) continue;   // display:none / subcharts-hidden → rect≈0
    const body = pane.querySelector(".pane-body");
    if (body && body.style.display === "none") continue;     // 收合（pane 仍有 header 高度，故另判 body）
    bottomChart = chart;
    break;
  }
  panels.forEach(({ chart }) => {
    if (chart) chart.applyOptions({ timeScale: { visible: chart === bottomChart } });
  });
}

/* 舊名保留為別名：`updateBottomTimeAxis` 已用 rect 高度統一處理桌面/平板/手機，
   不再需要 ≤768 的專用分支。原呼叫點（副圖開關、resize）續用此名即可。 */
function _mobileTimeAxis() { updateBottomTimeAxis(); }

/* ── 圖例顏色點（點色點即可改色）── */
function bindLegendColors() {
  /* 有「顯隱切換」的圖例一律不掛色盤（2026-08-04）。
     使用者回報：點副圖指標的圓點想切顯示/隱藏，卻跳出調色盤。
     這幾個的顏色在齒輪設定面板（KDJ／RSI／MACD 設定）都能調，色盤是多餘的干擾。
     ⚠ 用「同一份清單」驅動、不要手動刪 map 裡那幾筆：本專案吃過好幾次「兩份表各自漂移」的虧
       （BG_TF ×2、台股 resample 規則 ×2…）。日後有人替某個圖例加上顯隱切換，
       只要加進下面 lineMap，色盤就會自動讓開。 */
  const _LEG_TOGGLE_IDS = new Set([
    "legK", "legD", "legJ", "legRsi14", "legRsi7", "legMacd", "legMacdSig", "legMacdHist",
  ]);
  window._LEG_TOGGLE_IDS = _LEG_TOGGLE_IDS;   // 給下方 lineMap 自我檢查用

  const map = [
    // legBB / legVol 不掛色盤：點圖例只切顯隱（由 leg-toggle 處理）；
    // 顏色改用齒輪「主圖設定」面板（BB 上/下·中、量柱漲跌）設定，避免點到就跳色盤。
    { id:"legK",       key:"kdjK",    apply: c => { C.kdjK = c; kdjK?.applyOptions({color:c}); const el=document.getElementById("legK");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legD",       key:"kdjD",    apply: c => { C.kdjD = c; kdjD?.applyOptions({color:c}); const el=document.getElementById("legD");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legJ",       key:"kdjJ",    apply: c => { C.kdjJ = c; kdjJ?.applyOptions({color:c}); const el=document.getElementById("legJ");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi14",   key:"rsi14",   apply: c => { C.rsi14   = c; rsiLine14?.applyOptions({color:c});  const el=document.getElementById("legRsi14");  if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi7",    key:"rsi7",    apply: c => { C.rsi7    = c; rsiLine7?.applyOptions({color:c});   const el=document.getElementById("legRsi7");   if(el) el.style.color=c; savePrefs(); } },
    { id:"legKdjH20",  key:"kdjH20",  apply: c => { C.kdjH20  = c; kdjH20?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH50",  key:"kdjH50",  apply: c => { C.kdjH50  = c; kdjH50?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH80",  key:"kdjH80",  apply: c => { C.kdjH80  = c; kdjH80?.applyOptions({color:c}); savePrefs(); } },
    // RSI 的 legRsiH30/50/70 圖例已移除（使用者：那三個 30/50/70 沒啥用）→ 這裡的色盤綁定一併刪掉。
    //   顏色改由 RSI 設定齒輪的「超買/超賣」兩列調整；留著也只是空跑（下方有 if(!legEl) return 保護）。
    { id:"legMacd",    key:"macd",    apply: c => { C.macd    = c; macdLine?.applyOptions({color:c});   const el=document.getElementById("legMacd");    if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdSig", key:"macdSig", apply: c => { C.macdSig = c; macdSignal?.applyOptions({color:c}); const el=document.getElementById("legMacdSig"); if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdHist",key:"macdHist",apply: c => { C.macdHist = c; macdHist?.applyOptions({color:c}); savePrefs(); } },
  ];
  map.forEach(({ id, key, apply }) => {
    if (_LEG_TOGGLE_IDS.has(id)) return;       // 有顯隱切換 → 不掛色盤（見上方說明）
    const legEl = document.getElementById(id);
    if (!legEl) return;
    const dot = legEl.querySelector(".leg-dot");
    if (!dot) return;
    dot.style.cursor = "pointer";
    dot.addEventListener("click", e => {
      e.stopPropagation();   // 不要觸發 leg-toggle 的顯隱切換
      // ⚠ 2026-08-05：這裡**不可**再 substring(0,7)。色盤要靠 currentColor 的 8 位 #RRGGBBAA
      //   還原「不透明度」滑桿；砍掉 alpha 就永遠顯示 100%，使用者一動就把選好的不透明度覆蓋掉
      //   （使用者：「不透明度的選擇要被記住」）。色盤內部自己會 substring(0,7) 取色相。
      const cur = (C[key] || "#888");
      showLegColorPopup(e.clientX, e.clientY, [{
        label: null,
        currentColor: cur,
        apply: c => {
          dot.style.background = c;
          dot.style.borderColor = c;
          apply(c);
        }
      }]);
    });
  });
}

/* ── 指標設定面板 ── */
function bindIndicatorPanel() {
  const LS_CHARS = ["—", "···", "- -", "──"];
  const popup = document.getElementById("indSettingsPopup");
  if (!popup) return;

  // 點外部關閉
  document.addEventListener("mousedown", e => {
    if (!popup.contains(e.target) && !e.target.closest(".ind-gear-btn"))
      popup.classList.remove("open");
  }, true);

  // 各指標設定定義
  const IND_CONFIGS = {
    main: {
      title: "主圖設定",
      rows: [
        { candleRow: true, label:"主體", visKey:"bodyVisible",   upKey:"up",        downKey:"down"      },
        { candleRow: true, label:"邊框", visKey:"borderVisible", upKey:"borderUp",  downKey:"borderDown" },
        { candleRow: true, label:"燭芯", visKey:"wickVisible",   upKey:"wickUp",    downKey:"wickDown"   },
        { divider: true },
        { label:"BB 上/下", colorKey:"bbU", onColor: c=>{ C.bbL=c; bbU?.applyOptions({color:c}); bbL?.applyOptions({color:c}); _syncLegDot("legBB",c); }, widKey:"bbWidth", onWidth: w=>{ bbU?.applyOptions({lineWidth:w}); bbL?.applyOptions({lineWidth:w}); } },
        { label:"BB 中",    colorKey:"bbM", onColor: c=>{ bbM?.applyOptions({color:c}); }, widKey:"bbMWidth", serW:()=>bbM },
        { label:"VWAP",     colorKey:"vwap", onColor: ()=>{ if (typeof _scheduleRenderDrawings==="function") _scheduleRenderDrawings(); }, widKey:"vwapWidth", onWidth: ()=>{ if (typeof _scheduleRenderDrawings==="function") _scheduleRenderDrawings(); } },
        { divider: true },
        { label:"主圖背景", colorKey:"chartBg", bgPresets: true, onColor: c=>{
            C.chartBg = c;
            _applyChartBgGradient(c);   // mainPane 上下漸層至系統 var(--bg)
            savePrefs();
          }
        },
        { divider: true },
        { volRow: true, label:"量柱", upKey:"volUp", downKey:"volDown", alphaKey:"volAlpha",
          onColor: ()=>{ if (ohlcvData.length) renderVolume(ohlcvData); },
          onAlpha: ()=>{ if (ohlcvData.length) renderVolume(ohlcvData); }
        },
        { label:"量均線", colorKey:"volMa", onColor: c=>{ volMaSeries?.applyOptions({color:c}); },
          numKey:"volMaPeriod", numMin:1, numMax:200, onNum: ()=>{ if (ohlcvData.length) renderVolume(ohlcvData); } },
      ]
    },
    kdj: {
      title: "KDJ 設定",
      rows: [
        { label:"K", colorKey:"kdjK",    onColor: c=>{kdjK?.applyOptions({color:c}); _syncLegDot("legK",c);},    lsKey:"kdjKStyle",   series:()=>kdjK,    widKey:"kdjKWidth",   serW:()=>kdjK },
        { label:"D", colorKey:"kdjD",    onColor: c=>{kdjD?.applyOptions({color:c}); _syncLegDot("legD",c);},    lsKey:"kdjDStyle",   series:()=>kdjD,    widKey:"kdjDWidth",   serW:()=>kdjD },
        { label:"J", colorKey:"kdjJ",    onColor: c=>{kdjJ?.applyOptions({color:c}); _syncLegDot("legJ",c);},    lsKey:"kdjJStyle",   series:()=>kdjJ,    widKey:"kdjJWidth",   serW:()=>kdjJ },
        { divider: true },
        { label:"超買", colorKey:"kdjH80", onColor: c=>{kdjH80?.applyOptions({color:c}); _syncLegDot("legKdjH80",c);}, numKey:"kdjH80val", numSeries:()=>kdjH80, widKey:"kdjHLWidth", onWidth: w=>{ [kdjH20,kdjH50,kdjH80].forEach(s=>s?.applyOptions({lineWidth:w})); } },
        { label:"超賣", colorKey:"kdjH20", onColor: c=>{kdjH20?.applyOptions({color:c}); _syncLegDot("legKdjH20",c);}, numKey:"kdjH20val", numSeries:()=>kdjH20 },
      ]
    },
    rsi: {
      title: "RSI 設定",
      rows: [
        { label:"RSI 14", colorKey:"rsi14", onColor: c=>{rsiLine14?.applyOptions({color:c}); _syncLegDot("legRsi14",c);}, lsKey:"rsi14Style", series:()=>rsiLine14, widKey:"rsi14Width", serW:()=>rsiLine14 },
        { label:"RSI 7",  colorKey:"rsi7",  onColor: c=>{rsiLine7?.applyOptions({color:c});  _syncLegDot("legRsi7",c);},  lsKey:"rsi7Style",  series:()=>rsiLine7,  widKey:"rsi7Width",  serW:()=>rsiLine7  },
        { divider: true },
        { label:"超買", colorKey:"rsiH70", onColor: c=>{rsiH70?.applyOptions({color:c}); _syncLegDot("legRsiH70",c);}, numKey:"rsiH70val", numSeries:()=>rsiH70,
          lsKey:"rsiHLStyle", onLs: v=>{ [rsiH30,rsiH50,rsiH70].forEach(s=>s?.applyOptions({lineStyle:v})); },   // 線型：三條水平線一起換
          widKey:"rsiHLWidth", onWidth: w=>{ [rsiH30,rsiH50,rsiH70].forEach(s=>s?.applyOptions({lineWidth:w})); } },
        { label:"超賣", colorKey:"rsiH30", onColor: c=>{rsiH30?.applyOptions({color:c}); _syncLegDot("legRsiH30",c);}, numKey:"rsiH30val", numSeries:()=>rsiH30 },
      ]
    },
    macd: {
      title: "MACD 設定",
      rows: [
        { label:"MACD",   colorKey:"macd",    onColor: c=>{macdLine?.applyOptions({color:c});   _syncLegDot("legMacd",c);},    lsKey:"macdStyle",    series:()=>macdLine,   widKey:"macdWidth",    serW:()=>macdLine   },
        { label:"Signal", colorKey:"macdSig", onColor: c=>{macdSignal?.applyOptions({color:c}); _syncLegDot("legMacdSig",c);}, lsKey:"macdSigStyle", series:()=>macdSignal, widKey:"macdSigWidth", serW:()=>macdSignal },
        { label:"Hist",   colorKey:"macdHist",onColor: c=>{macdHist?.applyOptions({color:c}); _syncLegDot("legMacdHist",c);} },
      ]
    },
  };

  function buildRow(row) {
    if (row.divider) {
      const el = document.createElement("div");
      el.className = "ind-sp-divider";
      return el;
    }
    if (row.candleRow) {
      const rowEl = document.createElement("div");
      rowEl.className = "ind-sp-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = S[row.visKey] !== false;
      cb.style.cssText = "width:14px;height:14px;cursor:pointer;flex-shrink:0;margin:0;accent-color:#2962ff;";
      cb.addEventListener("change", () => { S[row.visKey] = cb.checked; applyAllColors(); savePrefs(); });
      rowEl.appendChild(cb);
      const lbl = document.createElement("span");
      lbl.className = "ind-sp-lbl"; lbl.textContent = row.label;
      rowEl.appendChild(lbl);
      ["up","dn"].forEach(side => {
        const key = side === "up" ? row.upKey : row.downKey;
        const dot = document.createElement("div");
        dot.title = side === "up" ? "漲" : "跌";
        dot.style.cssText = `width:16px;height:16px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[key]||"#888").substring(0,7)}`;
        dot.addEventListener("click", e => {
          e.stopPropagation();
          showLegColorPopup(e.clientX, e.clientY, [{
            label: null,
            currentColor: (C[key]||"#888"),   // 同上：保留 alpha
            apply: c => { dot.style.background = c; C[key] = c; applyAllColors(); savePrefs(); }
          }]);
        });
        rowEl.appendChild(dot);
      });
      return rowEl;
    }
    if (row.volRow) {
      const rowEl = document.createElement("div");
      rowEl.className = "ind-sp-row";
      const lbl = document.createElement("span");
      lbl.className = "ind-sp-lbl"; lbl.textContent = row.label;
      rowEl.appendChild(lbl);
      ["up","dn"].forEach(side => {
        const key = side === "up" ? row.upKey : row.downKey;
        const dot = document.createElement("div");
        dot.title = side === "up" ? "漲" : "跌";
        dot.style.cssText = `width:16px;height:16px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[key]||"#888").substring(0,7)}`;
        dot.addEventListener("click", e => {
          e.stopPropagation();
          showLegColorPopup(e.clientX, e.clientY, [{
            label: null,
            currentColor: (C[key]||"#888"),   // 同上：保留 alpha
            apply: c => { dot.style.background = c; C[key] = c; row.onColor?.(); savePrefs(); }
          }]);
        });
        rowEl.appendChild(dot);
      });
      const opLbl = document.createElement("span");
      opLbl.className = "ind-sp-wlbl"; opLbl.textContent = "透";
      rowEl.appendChild(opLbl);
      const opInp = document.createElement("input");
      opInp.type = "number"; opInp.className = "ind-sp-num";
      opInp.min = 0; opInp.max = 100; opInp.step = 5;
      opInp.value = Math.round((S[row.alphaKey] ?? 0.67) * 100);
      opInp.style.width = "42px";
      opInp.addEventListener("change", e => {
        const v = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        opInp.value = v; S[row.alphaKey] = v / 100;
        row.onAlpha?.();
        savePrefs();
      });
      rowEl.appendChild(opInp);
      return rowEl;
    }
    const rowEl = document.createElement("div");
    rowEl.className = "ind-sp-row";

    // 標籤
    const lbl = document.createElement("span");
    lbl.className = "ind-sp-lbl";
    lbl.textContent = row.label;
    rowEl.appendChild(lbl);

    // 顏色色塊 → 點擊開 cpPopup
    if (row.colorKey) {
      const dot = document.createElement("div");
      dot.style.cssText = `width:18px;height:18px;border-radius:3px;border:1px solid #444;cursor:pointer;flex-shrink:0;background:${(C[row.colorKey]||"#888").substring(0,7)}`;
      dot.addEventListener("click", e => {
        e.stopPropagation();
        showLegColorPopup(e.clientX, e.clientY, [{
          label: null,
          currentColor: (C[row.colorKey] || "#888"),   // 保留 alpha：色盤要用它還原不透明度滑桿
          apply: c => {
            dot.style.background = c;
            C[row.colorKey] = c;
            row.onColor?.(c);
            savePrefs();
          }
        }]);
      });
      rowEl.appendChild(dot);

      // 背景色快速預設色塊
      if (row.bgPresets) {
        // 氛圍色票庫：深靛(預設)/午夜紫/深海藍綠/墨綠/暖咖啡/酒紅棕/石墨/深紫藍 + 兩款亮色
        const presets = ["#131722","#1A1430","#0E2229","#14201A","#221710",
                         "#251216","#16181D","#1E1530","#ffffff","#fdf6e3"];
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;margin-left:6px;";
        presets.forEach(hex => {
          const sw = document.createElement("div");
          sw.style.cssText = `width:14px;height:14px;border-radius:2px;cursor:pointer;background:${hex};border:1px solid rgba(255,255,255,0.15);flex-shrink:0;`;
          sw.title = hex;
          sw.addEventListener("click", e => {
            e.stopPropagation();
            dot.style.background = hex;
            row.onColor?.(hex);
          });
          wrap.appendChild(sw);
        });
        rowEl.appendChild(wrap);
      }
    }

    // 線型按鈕
    if (row.lsKey) {
      const lsBtn = document.createElement("button");
      lsBtn.className = "ind-sp-ls";
      const cur = S[row.lsKey] ?? 0;
      lsBtn.textContent = LS_CHARS[cur]; lsBtn.dataset.ls = cur;
      lsBtn.title = "線型";
      lsBtn.addEventListener("click", e => {
        e.stopPropagation();
        const next = ((parseInt(lsBtn.dataset.ls) || 0) + 1) % 4;
        lsBtn.dataset.ls = next; lsBtn.textContent = LS_CHARS[next];
        // onLs＝一顆鈕要套到多條線（如 RSI 三條水平線）；否則沿用單一 series
        S[row.lsKey] = next;
        if (row.onLs) row.onLs(next);
        else row.series()?.applyOptions({ lineStyle: next });
        savePrefs();
      });
      rowEl.appendChild(lsBtn);
    }

    // 線寬輸入
    if (row.widKey) {
      const wlbl = document.createElement("span");
      wlbl.className = "ind-sp-wlbl"; wlbl.textContent = "粗";
      rowEl.appendChild(wlbl);
      const wInput = document.createElement("input");
      wInput.type = "number"; wInput.className = "ind-sp-num";
      wInput.min = 1; wInput.max = 5; wInput.step = 1;
      wInput.value = S[row.widKey] ?? 1;
      wInput.style.width = "34px";
      wInput.addEventListener("change", e => {
        const v = Math.max(1, Math.min(5, parseInt(e.target.value) || 1));
        wInput.value = v; S[row.widKey] = v;
        if (row.onWidth) row.onWidth(v);
        else row.serW?.()?.applyOptions({ lineWidth: v });
        savePrefs();
      });
      rowEl.appendChild(wInput);
    }

    // 數值輸入（H 水平線位置）
    if (row.numKey) {
      const nInput = document.createElement("input");
      nInput.type = "number"; nInput.className = "ind-sp-num";
      nInput.min = row.numMin ?? 1; nInput.max = row.numMax ?? 99; nInput.value = S[row.numKey] ?? 50;
      nInput.addEventListener("change", e => {
        let val = parseFloat(e.target.value); if (isNaN(val)) return;
        const _lo = row.numMin ?? 1, _hi = row.numMax ?? 99;
        val = Math.min(_hi, Math.max(_lo, val)); e.target.value = val;
        S[row.numKey] = val;
        if (row.onNum) {
          row.onNum(val);                                    // 自訂回呼（如量均線週期 → 重畫量均線）
        } else if (ohlcvData.length) {
          const f = toTime(ohlcvData[0].time), l = toTime(ohlcvData[ohlcvData.length-1].time);
          row.numSeries()?.setData([{time:f,value:val},{time:l,value:val}]);   // 水平門檻線（KDJ/RSI）
        }
        savePrefs();
      });
      rowEl.appendChild(nInput);
    }

    return rowEl;
  }

  function openPopup(triggerEl, indKey) {
    const cfg = IND_CONFIGS[indKey]; if (!cfg) return;
    popup.innerHTML = "";

    const title = document.createElement("div");
    title.className = "ind-sp-title"; title.textContent = cfg.title;
    popup.appendChild(title);

    cfg.rows.forEach(row => popup.appendChild(buildRow(row)));
    popup.classList.add("open");

    // 定位：在 trigger 下方，靠右
    requestAnimationFrame(() => {
      const rect = triggerEl.getBoundingClientRect();
      const pw = popup.offsetWidth, ph = popup.offsetHeight;
      let left = rect.right - pw;
      let top  = rect.bottom + 4;
      if (left < 4) left = 4;
      if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
      popup.style.left = left + "px";
      popup.style.top  = top  + "px";
    });
  }

  document.querySelectorAll(".ind-gear-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const indKey = btn.dataset.ind;
      if (popup.classList.contains("open")) { popup.classList.remove("open"); return; }
      openPopup(btn, indKey);
    });
  });
}

function _syncLegDot(legId, color) {
  const dot = document.querySelector(`#${legId} .leg-dot`);
  if (dot) { dot.style.background = color; dot.style.borderColor = color; }
}

/* ── 圖例點擊切換線條 + 面板收合 ── */
function bindLegendToggles() {
  // 線條切換：點擊 leg-item 顯示/隱藏對應系列
  const lineMap = [
    { id: "legBB",       series: () => [bbU, bbM, bbL] },
    { id: "legVol",      series: () => [volSeries, volMaSeries] },
    { id: "legFVG",      series: null,  action: (hidden) => { if (typeof toggleFVG === "function") toggleFVG(!hidden); } },
    { id: "legFVGMS",    series: null,  action: (hidden) => { if (typeof toggleFVGMS === "function") toggleFVGMS(!hidden); } },
    { id: "legFVGBreak", series: null,  action: (hidden) => { if (typeof toggleFVGBreak === "function") toggleFVGBreak(!hidden); } },
    { id: "legFVGShun",  series: null,  action: (hidden) => { if (typeof toggleFVGShun === "function") toggleFVGShun(!hidden); } },
    { id: "legHtfFvg",   series: null,  action: (hidden) => { if (window.toggleHtfFvg) window.toggleHtfFvg(!hidden); } },
    { id: "legPDHL",     series: null,  action: (hidden) => { if (window.togglePDHL) window.togglePDHL(!hidden); } },
    { id: "legHtfOpen",  series: null,  action: (hidden) => { if (window.toggleHtfOpen) window.toggleHtfOpen(!hidden); } },
    { id: "legEngulf",   series: null,  action: (hidden) => { if (window.toggleEngulf) window.toggleEngulf(!hidden); } },
    { id: "legEcon",     series: null,  action: (hidden) => { if (window.toggleEcon) window.toggleEcon(!hidden); } },
    { id: "legSwing",    series: null,  action: (hidden) => { if (window.toggleSwing) window.toggleSwing(!hidden); } },
    { id: "legK",        series: () => [kdjK] },
    { id: "legD",        series: () => [kdjD] },
    { id: "legJ",        series: () => [kdjJ] },
    { id: "legRsi14",    series: () => [rsiLine14] },
    { id: "legRsi7",     series: () => [rsiLine7] },
    { id: "legMacd",     series: () => [macdLine] },
    { id: "legMacdSig",  series: () => [macdSignal] },
    { id: "legMacdHist", series: () => [macdHist] },
  ];
  // 自我檢查：有顯隱切換的「副圖指標」若沒登記進 _LEG_TOGGLE_IDS，色盤就會又跑出來擋路。
  // 只檢查副圖那幾個（主圖的 FVG/PDHL 等本來就沒掛色盤），開發時 console 會直接講。
  try {
    const _need = ["legK","legD","legJ","legRsi14","legRsi7","legMacd","legMacdSig","legMacdHist"];
    const _miss = _need.filter(id => lineMap.some(m => m.id === id) && !_LEG_TOGGLE_IDS.has(id));
    if (_miss.length) console.warn("[legend] 這些圖例有顯隱切換但沒登記進 _LEG_TOGGLE_IDS，色盤會擋路:", _miss);
  } catch (e) {}
  lineMap.forEach(({ id, series, action }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", e => {
      const hidden = el.classList.toggle("line-off");
      if (action) action(hidden);
      else series()?.forEach(s => s.applyOptions({ visible: !hidden }));
      saveVisibilityPrefs();
    });
  });

  // FVG 最小寬度% 輸入（使用者自定；localStorage 持久化）→ setFVGMinWidth 即時過濾主圖缺口
  const _fvgWInp = document.getElementById("fvgMinW");
  if (_fvgWInp) {
    try { const saved = localStorage.getItem("fvgMinW"); if (saved != null && saved !== "") _fvgWInp.value = saved; } catch (e) {}
    const _applyFvgW = () => {
      if (typeof setFVGMinWidth === "function") setFVGMinWidth(_fvgWInp.value);
      try { localStorage.setItem("fvgMinW", _fvgWInp.value); } catch (e) {}
    };
    _applyFvgW();   // 套用載入時的值
    _fvgWInp.addEventListener("input",  _applyFvgW);
    _fvgWInp.addEventListener("change", _applyFvgW);
    // 點輸入框不要觸發圖例切換/其他父層行為
    _fvgWInp.addEventListener("click", e => e.stopPropagation());
  }

  // proto 缺口(B)門檻切換 chip：初始標籤同步（值存在 winrate.js 的 _wrProtoMin，點擊走 _cycleProtoMin）
  if (typeof window._syncProtoMinLabel === "function") window._syncProtoMinLabel();
  // 「B=proto / 正常FVG」切換 chip：初始狀態同步（值存 winrate.js 的 _wrNoProto，點擊走 _toggleNoProto）
  if (typeof window._syncNoProtoLabel === "function") window._syncNoProtoLabel();

  // 面板收合：點擊「−」縮至只剩圖例列；點「+」展開
  // 面板收合：點「-」= 整個 pane（含圖例資訊列）+ 它下方分隔線一起隱藏 = 完全消失、不留痕跡；
  //   還原改由下方「隱藏指標還原列」(_syncHiddenIndBar) 的小晶片點回來（因為「+」也跟著消失了）。
  _initIndPopup();          // 桌機：左側工具列「指標」hover 勾選選單
  _initMobileIndChips();    // 手機：設定面板裡的 KDJ / RSI / MACD chip（工具島在手機是隱藏的）
  _syncHiddenIndBar();
}

const _PANE_LABEL = { kdjPane: "KDJ", rsiPane: "RSI", macdPane: "MACD" };

/* ── 左側工具列「指標」勾選選單（2026-07-31 依使用者要求）────────────────────
   取代原本每個副圖上的「−」收合鈕、以及圖表下方的「隱藏的指標」還原列。
   ・滑鼠移到工具列的副圖按鈕上 → 展開清單,勾選要顯示哪些指標(KDJ / RSI / MACD)。
   ・勾/取消 = 展開/收合該指標(沿用 _showPane/_hidePane,狀態一樣寫進 collapsedPanes)。
   ・按鈕本身「點擊」維持原本的「整組顯示/隱藏」→ 舊習慣與手機設定列都不受影響。
   ・離開按鈕與選單 220ms 後才收起 → 手可以從按鈕滑到選單上,不會半路消失。 */
let _indPop = null, _indPopTimer = null, _indPopOpenTimer = null;
const _IND_POP_DELAY = 1000;   // 滑鼠停留多久才跳出（使用者要求 1 秒，避免經過就閃出來）

function _syncIndPopup() {
  const chips = document.getElementById("mSetIndRow");
  for (const id of Object.keys(_PANE_LABEL)) {
    const p = document.getElementById(id);
    const on = !!p && !p.classList.contains("pane-collapsed");
    if (_indPop) {
      const row = _indPop.querySelector('[data-pane="' + id + '"]');
      if (row) {
        row.dataset.on = on ? "true" : "false";
        const box = row.querySelector(".ind-pop-box");
        if (box) box.textContent = on ? "\u2713" : "";
      }
    }
    // \u624b\u6a5f\u8a2d\u5b9a\u9762\u677f\u90a3\u6392 chip\uff08\u684c\u6a5f CSS \u96b1\u85cf\uff09\u2014\u2014\u540c\u4e00\u4efd\u6536\u5408\u72c0\u614b\uff0c\u5169\u908a\u986f\u793a\u8981\u4e00\u81f4
    if (chips) chips.querySelector('[data-pane="' + id + '"]')?.classList.toggle("on", on);
  }
  // \u6574\u7d44\u96b1\u85cf\u6642\u500b\u5225\u52fe\u9078\u6c92\u6709\u610f\u7fa9 \u2192 chip \u6574\u6392\u8b8a\u7070\u3001\u9ede\u4e86\u4e5f\u4e0d\u505a\u4e8b
  if (chips) chips.classList.toggle("all-off",
    !!document.getElementById("chartsContainer")?.classList.contains("subcharts-hidden"));
}

// \u624b\u6a5f\uff1a\u500b\u5225\u958b\u95dc\u67d0\u500b\u526f\u5716\u3002\u684c\u6a5f\u8d70\u5de5\u5177\u5cf6\u7684 hover \u9078\u55ae\uff0c\u4f46\u624b\u6a5f\u6c92\u6709 hover\u3001.draw-toolbar \u53c8\u6574\u500b
// display:none \u2192 \u90a3\u689d\u8def\u8d70\u4e0d\u5230\u3002\uff082026-07-31 \u4fee\uff1aa07369f \u62ff\u6389 pane \u4e0a\u7684\u300c\u2212\u300d\u9215\u5f8c\u624b\u6a5f\u5c31\u6c92\u6709
// \u4efb\u4f55\u300c\u53ea\u95dc\u6389 MACD\u300d\u7684\u8fa6\u6cd5\u4e86\uff0c\u53ea\u5269\u6574\u7d44\u958b/\u95dc\u3002\uff09
function _initMobileIndChips() {
  const row = document.getElementById("mSetIndRow");
  if (!row || row.dataset.bound) return;
  row.dataset.bound = "1";
  row.addEventListener("click", e => {
    const chip = e.target.closest(".m-set-indchip");
    if (!chip) return;
    e.preventDefault(); e.stopPropagation();          // \u4e0d\u8981\u9023\u5e36\u95dc\u6389\u8a2d\u5b9a\u9762\u677f
    if (row.classList.contains("all-off")) return;    // \u6574\u7d44\u96b1\u85cf\u4e2d \u2192 \u5148\u7528\u4e0a\u9762\u90a3\u9846\u6253\u958b
    const id = chip.dataset.pane;
    if (!document.getElementById(id)) return;
    if (document.getElementById(id).classList.contains("pane-collapsed")) _showPane(id);
    else _hidePane(id);
  });
  _syncIndPopup();
}

function _indPopShow() {
  clearTimeout(_indPopTimer);
  const btn = document.getElementById("subChartsToggle");
  if (!btn || !_indPop) return;
  // 整組隱藏時勾選沒有意義 → 提示先打開
  const hiddenAll = document.getElementById("chartsContainer")?.classList.contains("subcharts-hidden");
  _indPop.querySelector(".ind-pop-hint").style.display = hiddenAll ? "" : "none";
  _syncIndPopup();
  _indPop.style.visibility = "hidden";
  _indPop.style.display = "block";
  const r = btn.getBoundingClientRect();
  const ph = _indPop.offsetHeight, pw = _indPop.offsetWidth;
  let top = r.top + r.height / 2 - ph / 2;
  top = Math.max(6, Math.min(top, window.innerHeight - ph - 6));
  let left = r.right + 8;
  if (left + pw > window.innerWidth - 6) left = Math.max(6, r.left - pw - 8);
  _indPop.style.top = top + "px";
  _indPop.style.left = left + "px";
  _indPop.style.visibility = "";
  // 選單開著時固定住工具島：它平常是「滑到左緣才滑出」，滑鼠移進選單就會失去 hover 而縮回去，
  // 看起來像選單浮在半空中。加 dt-pinned 讓它維持展開，選單收起再放開。
  document.getElementById("drawToolbar")?.classList.add("dt-pinned");
}

function _indPopHideSoon() {
  clearTimeout(_indPopTimer);
  clearTimeout(_indPopOpenTimer);
  _indPopTimer = setTimeout(() => {
    if (_indPop) _indPop.style.display = "none";
    document.getElementById("drawToolbar")?.classList.remove("dt-pinned");
  }, 220);
}

function _initIndPopup() {
  const btn = document.getElementById("subChartsToggle");
  if (!btn || _indPop) return;
  _indPop = document.createElement("div");
  _indPop.id = "indPickPopup";
  _indPop.className = "ind-pop";
  _indPop.innerHTML =
    '<div class="ind-pop-title">顯示哪些指標</div>' +
    Object.keys(_PANE_LABEL).map(id =>
      '<button type="button" class="ind-pop-row" data-pane="' + id + '">' +
      '<span class="ind-pop-box"></span><span>' + _PANE_LABEL[id] + '</span></button>').join("") +
    '<div class="ind-pop-hint">副圖目前整組隱藏 — 點左側按鈕先打開</div>';
  document.body.appendChild(_indPop);

  _indPop.querySelectorAll(".ind-pop-row").forEach(row => {
    row.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const id = row.dataset.pane;
      const p = document.getElementById(id);
      if (!p) return;
      if (p.classList.contains("pane-collapsed")) _showPane(id); else _hidePane(id);
      _syncIndPopup();
    });
  });
  // ★停留 1 秒才跳出（使用者要求）：滑鼠只是「經過」按鈕不該閃出選單。
  //   離開就取消倒數；已經開著時再進來則不重複倒數（直接留著）。
  btn.addEventListener("mouseenter", () => {
    clearTimeout(_indPopTimer);
    if (_indPop && _indPop.style.display === "block") return;   // 已開著 → 不必重數
    clearTimeout(_indPopOpenTimer);
    _indPopOpenTimer = setTimeout(_indPopShow, _IND_POP_DELAY);
  });
  btn.addEventListener("mouseleave", () => { clearTimeout(_indPopOpenTimer); _indPopHideSoon(); });
  _indPop.addEventListener("mouseenter", () => { clearTimeout(_indPopTimer); clearTimeout(_indPopOpenTimer); });
  _indPop.addEventListener("mouseleave", _indPopHideSoon);
  _syncIndPopup();
}
function _paneDivider(paneId) { return document.querySelector('.pane-divider[data-target="' + paneId + '"]'); }

/* 收合＝「原地收起來」，不是整個消失（2026-07-31 依使用者要求改）。
   舊行為：display:none 讓整個 pane 不見，還原要靠 chartsContainer 底部另外長出來的
   「隱藏的指標：＋KDJ」還原列——使用者反映不要顯示在下方。
   新行為：只把圖表區(.pane-body)收起來，保留那一行圖例當標題列(上面就有 ＋ 可以點回來)，
   使用者一眼看得到「這個指標還在、只是收著」，也不需要額外的還原列。 */
function _hidePane(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  if (!pane.classList.contains("pane-collapsed")) paneCollapseFlex[paneId] = pane.style.flex || "1";
  pane.classList.add("pane-collapsed");
  pane.style.flex = "0 0 auto";
  const dv = _paneDivider(paneId); if (dv) dv.style.display = "none";
  _syncIndPopup();
  _afterPaneToggle();
}

function _showPane(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  pane.classList.remove("pane-collapsed");
  pane.style.display = "";
  pane.style.flex = paneCollapseFlex[paneId] || "1";
  const body = pane.querySelector(".pane-body"); if (body) body.style.display = "";
  const dv = _paneDivider(paneId); if (dv) dv.style.display = "";
  _syncIndPopup();
  _afterPaneToggle();
}

function _afterPaneToggle() {
  _syncHiddenIndBar();
  updateBottomTimeAxis();
  resizeAll();
  saveVisibilityPrefs();
  savePaneFlexes();
}

function _syncHiddenIndBar() {
  // 底部「隱藏的指標」還原列已移除（使用者要求不要顯示在下方）：收合改成原地保留圖例列，
  // 上面的 ＋ 就能點回來。這裡只負責把舊版可能殘留的那條列清掉。
  document.getElementById("hiddenIndBar")?.remove();
}

function nextVisiblePane(el) {
  let sib = el.nextElementSibling;
  while (sib) {
    if (sib.classList.contains("pane-divider")) { sib = sib.nextElementSibling; continue; }
    if (sib.classList.contains("chart-pane") && !sib.classList.contains("hidden")) return sib;
    sib = sib.nextElementSibling;
  }
  return null;
}


const SC_DEFAULTS = {
  "sc-bg":     "#1e222d",
  "sc-panel":  "#2a2e39",
  "sc-border": "#2a2e39",
  "sc-text":   "#d1d4dc",
  "sc-muted":  "#787b86",
  "sc-blue":   "#2962ff",
};
const SC_CSS_MAP = {
  "sc-bg":     ["--bg", "--bg2"],
  "sc-panel":  ["--bg3"],
  "sc-border": ["--border"],
  "sc-text":   ["--text"],
  "sc-muted":  ["--muted"],
  "sc-blue":   ["--blue"],
};
let SC = { ...SC_DEFAULTS };

// 市場切換單鍵循環按鈕（Crypto → TW → US → Crypto）— 帶 label slide 動畫
// hidden <select id="marketSelect"> 仍是 source-of-truth（既有 JS change handler 不動）
function _initMarketPill() {
  const pill  = document.getElementById("marketPill");
  const sel   = document.getElementById("marketSelect");
  if (!pill || !sel) return;
  const label = pill.querySelector(".mkt-cycle-label");
  // ⚠ 新增市場一定要同時加進這兩個常數：使用者是點這顆 pill 循環切market 的，
  //   只加進 index.html 那個 hidden 的 <select> 是**進不去**的（外匯上線當天就這樣漏掉，
  //   使用者回報「怎麼知道哪些是外匯」）。
  const MKTS  = ["crypto", "tw", "us", "hk", "fx"];
  const LBL   = { crypto: "Crypto", tw: "TW", us: "US", hk: "HK", fx: "FX" };

  const setMarket = (mkt) => {
    if (!LBL[mkt]) return;
    pill.dataset.mkt = mkt;            // 觸發 CSS 變色（不同市場不同漸層）
    label.textContent = LBL[mkt];
  };
  // 初始同步 select → pill 顯示
  setMarket(sel.value || "crypto");
  /* ★ 2026-08-11 對外暴露：自動判斷市場（loadData 開頭）改了 select.value 之後，
     必須連**顯示標籤**一起更新，否則資料切了、左上還寫舊市場，要重整才對
     —— 使用者：「我要重新整理才會變，不是在我點標的時」。 */
  window._setMarketPill = setMarket;

  /* ★ 2026-08-11 市場改成「純標示」，不再是可點的切換鈕（使用者要求）。
     理由：市場現在由標的自動判斷（loadData 開頭的 _detectMarket），
     點它循環切市場會馬上被下一次載入覆蓋回去 —— 那是「看起來壞掉」的互動，不如拿掉。
     ⚠ 拿掉點擊不影響瀏覽各市場：標的搜尋視窗有全部市場的分頁、行情列也有自己的分頁。
     ⚠ 保留 setMarket / _setMarketPill：標示本身仍要跟著市場變（文字＋配色）。 */
  pill.style.cursor = "default";
  pill.setAttribute("aria-disabled", "true");
  pill.title = "目前市場（依標的自動判斷）";

  // 別處改變 select 時也同步 pill
  sel.addEventListener("change", () => setMarket(sel.value || "crypto"));
}

// 「回到最新」⏭：看歷史時浮在主圖右下。修剪會把「現在」那段丟掉壓記憶體 → 從深歷史滑回來
// 實測要拖 13~14 次才回得到最新，這顆是唯一捷徑。顯示條件由 render.js `_updateGoLatestBtn` 管。
function _initGoLatestBtn() {
  const btn = document.getElementById("btnGoLatest");
  if (!btn) return;
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window._goLatest === "function") window._goLatest();
    if (typeof SFX !== "undefined" && SFX.switch_) { try { SFX.switch_(); } catch (err) {} }
  });
}

// 副圖指標 顯示/隱藏 toggle — draw-toolbar 最底部按鈕
// 預設隱藏，state 存 localStorage.subChartsHidden（"1"=隱藏、"0"=顯示）
function _initSubChartsToggle() {
  const btn = document.getElementById("subChartsToggle");
  const container = document.getElementById("chartsContainer");
  if (!btn || !container) return;
  const _syncBtn = () => {
    const hidden = container.classList.contains("subcharts-hidden");
    btn.dataset.expanded = hidden ? "false" : "true";   // 給 CSS 旋轉箭頭用
    btn.title = hidden ? "顯示副圖指標（KDJ / RSI / MACD）" : "隱藏副圖指標";
    // 手機「設定 → 副圖指標」列的狀態文字（手機無繪圖工具列，從設定開關副圖）
    const ms = document.getElementById("mSetSubchartsState");
    if (ms) ms.textContent = hidden ? "已隱藏 · 點擊顯示 KDJ / RSI / MACD" : "顯示中 · 點擊隱藏";
    const row = document.getElementById("mSetSubcharts");
    if (row) row.classList.toggle("m-set-on", !hidden);   // 顯示中＝高亮(開)
    _syncIndPopup();   // 整組開/關會改變個別 chip 是否可用（all-off）→ 一起同步
  };
  let hidden = "1";
  try { hidden = localStorage.getItem("subChartsHidden") ?? "1"; } catch (e) {}
  if (hidden === "1") container.classList.add("subcharts-hidden");
  _syncBtn();
  // 手機初始：把時間軸移到最下方「可見」面板（預設副圖隱藏 → 落在主圖，否則卡在隱藏的 MACD → 時間消失）
  setTimeout(() => { if (typeof _mobileTimeAxis === "function") _mobileTimeAxis(); }, 60);
  btn.addEventListener("click", () => {
    container.classList.toggle("subcharts-hidden");
    const nowHidden = container.classList.contains("subcharts-hidden");
    try { localStorage.setItem("subChartsHidden", nowHidden ? "1" : "0"); } catch (e) {}
    _syncBtn();
    // 由隱藏→顯示：資料在隱藏期間以 indicators=false 抓入(無 KDJ/RSI/MACD 欄) → 需重抓；
    // 若已有指標欄(之前開過)則直接補算。(replay 中交由 replay 迴圈補)
    if (!nowHidden && !replayActive && ohlcvData.length) {
      const hasInd = ohlcvData.some(d => d.kdj_k != null);
      if (hasInd) {
        if (typeof _renderSubcharts === "function") _renderSubcharts(ohlcvData);
        // 隱藏期間不推 range（見 charts.js _flushSync）→ 顯示時補一次，第一幀就對齊主圖
        if (typeof window._syncSubchartsNow === "function") window._syncSubchartsNow();
      }
      else if (typeof loadData === "function") loadData(false);   // 此時副圖已顯示→buildPayload 帶 indicators=true
    }
    // 觸發 LWC 重新計算大小（主圖會撐滿/縮回）+ 手機把時間軸移到目前最下方可見面板（桌面不受影響）
    setTimeout(() => {
      if (typeof resizeAll === "function") resizeAll();
      if (typeof _mobileTimeAxis === "function") _mobileTimeAxis();
    }, 50);
  });
  // 視窗尺寸/方向變動 → 手機重評最下方可見面板，時間軸不掉（桌面 _mobileTimeAxis 直接 return）
  window.addEventListener("resize", () => {
    if (typeof _mobileTimeAxis === "function") _mobileTimeAxis();
  });
}

function applySystemColor(id, color) {
  const vars = SC_CSS_MAP[id];
  if (!vars) return;
  // 主背景（sc-bg）仍過一次 _darkenForChart：2026-08-05 起它已不壓暗（見該函式註解），
  // 保留呼叫是因為它也負責處理色盤的 8 位 #RRGGBBAA（帶不透明度的選色）。
  const applied = (id === "sc-bg" && typeof _darkenForChart === "function")
    ? _darkenForChart(color)
    : color;
  vars.forEach(v => document.documentElement.style.setProperty(v, applied));
  if (id === "sc-bg") {
    document.body.style.background = applied;
    /* ★ 2026-08-06 另外寫一個「去掉 alpha 的系統色」--bg-solid。
       使用者可以把主背景選成半透明（色盤有不透明度滑桿）——桌面上那是特色，
       天氣會從 topbar/行情列透出來。但**手機的分頁面板背景是完全透明的**、靠 var(--bg)
       撐底，半透明就會讓後面的圖表頁整個透出來
       （使用者：「因為透明度 導致其他分頁背景有圖表」，實測設定頁可看到標的列、
        時框鈕、開高低收數字）。→ 手機分頁改吃 --bg-solid，不受不透明度影響。 */
    const _m8 = /^#?([0-9a-f]{6})[0-9a-f]{2}$/i.exec(String(applied || ""));
    const _solid = _m8 ? "#" + _m8[1] : applied;
    document.documentElement.style.setProperty("--bg-solid", _solid);
    // sc-bg 同時寫入 --bg 與 --bg2 → 兩個都要有去 alpha 版，否則用 --bg2 的漸層照樣透光
    document.documentElement.style.setProperty("--bg2-solid", _solid);
  }
}

/* ★ 2026-08-05 文字自動對比（配色優化）。
   背景壓暗濾鏡移除後，使用者第一次真的可以把背景選成亮色 —— 但 --text/--muted/--border
   是**固定的淺色**，選亮底就直接看不見字。實測對比度：
     #1E222D → 文字 10.71:1 ✓ ／ #7A4A1F → 次要文字 1.76:1 ✗
     #C8B89A → 1.31:1 ✗ ／ #FFFFFF → 1.48:1 ✗   （WCAG 內文門檻 4.5:1、次要 3:1）
   格線早就會依背景明暗自動反轉（colors.js _applyAutoGrid），文字卻不會 → 這裡補上同一套邏輯。
   ⚠ 只在使用者**沒有自己調過**文字色時才自動（＝仍是 SC_DEFAULTS）；一旦他手動選過就完全尊重，
     不要覆蓋使用者的明確選擇。 */
function _scRgb(c) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(c || ""));
  if (m) return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
  const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c || ""));
  return r ? [+r[1], +r[2], +r[3]] : null;
}
// WCAG 相對亮度與對比度（別用 _lum：那是 0~255 的感知亮度，算不出 WCAG 比值）
function _scRelLum(c) {
  const p = _scRgb(c); if (!p) return 0;
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
}
function _scContrast(a, b) {
  const l1 = _scRelLum(a), l2 = _scRelLum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
/* 從候選色裡挑「第一個達到 min 對比」的；都不到就回對比最高那個（盡力而為，不留最差解）。
   候選同時給亮、暗兩個方向 → 中間調背景（如 #7A4A1F）也找得到出路。 */
function _scPick(bg, cands, min) {
  let best = cands[0], bestC = 0;
  for (const c of cands) {
    const k = _scContrast(bg, c);
    if (k >= min) return c;
    if (k > bestC) { bestC = k; best = c; }
  }
  return best;
}
const _SC_TEXT_CANDS  = ["#d1d4dc", "#1F2328", "#FFFFFF", "#0B0E12"];
const _SC_MUTED_CANDS = ["#787b86", "#5B6270", "#A8AEBC", "#3E4450", "#C6CBD5"];
function _autoTextContrast() {
  const ds = document.documentElement.style;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!_scRgb(bg)) return;
  const untouched = (k) => SC[k] === SC_DEFAULTS[k];
  // 內文門檻 4.5:1、次要文字 3:1（WCAG AA）
  if (untouched("sc-text"))  ds.setProperty("--text",  _scPick(bg, _SC_TEXT_CANDS,  4.5));
  if (untouched("sc-muted")) ds.setProperty("--muted", _scPick(bg, _SC_MUTED_CANDS, 3.0));
  if (untouched("sc-border"))
    ds.setProperty("--border", _scRelLum(bg) >= 0.25 ? "rgba(0,0,0,0.16)" : SC_DEFAULTS["sc-border"]);
}
function applyAllSystemColors() {
  for (const [id, color] of Object.entries(SC)) applySystemColor(id, color);
  _autoTextContrast();   // ⚠ 必須在最後：要讀已套用的 --bg 才判斷得出明暗
}
function saveSystemColors() {
  try { localStorage.setItem("sysColors", JSON.stringify(SC)); } catch {}
  if (window._acctTouch) window._acctTouch();   // 登入中 → 系統色同步到雲端
}
function loadSystemColors() {
  try { Object.assign(SC, JSON.parse(localStorage.getItem("sysColors") || "{}")); } catch {}
}
function syncSysSwatches() {
  document.querySelectorAll(".sys-color-swatch").forEach(sw => {
    sw.style.background = (SC[sw.dataset.sc] || "#888").slice(0, 7);
  });
}

function bindSystemColors() {
  syncSysSwatches();

  document.querySelectorAll(".sys-color-swatch").forEach(sw => {
    sw.addEventListener("click", e => {
      e.stopPropagation();
      const id  = sw.dataset.sc;
      const cur = (SC[id] || "#888");   // 同上：保留 alpha（色塊顯示才用 slice(0,7)）
      showLegColorPopup(e.clientX, e.clientY, [{
        label: null,
        currentColor: cur,
        apply: c => {
          SC[id] = c;
          sw.style.background = c;
          applySystemColor(id, c);
          saveSystemColors();
        }
      }]);
    });
  });

  document.getElementById("resetSysColors")?.addEventListener("click", () => {
    SC = { ...SC_DEFAULTS };
    syncSysSwatches();
    applyAllSystemColors();
    saveSystemColors();
  });
}

/* ══════════════════════════════════════════
   手機 TF 選擇器（手機「設定 → 時間框」）
   使用者自選最多 MOBILE_TF_MAX 個要顯示在手機上方時間框列的時間框；桌面顯示全部。
══════════════════════════════════════════ */
// 套用手機顯示：非選取的 tf-btn 加 .tf-hidden-mobile（CSS 只在手機隱藏）。
// 「當前 TF」一律保留可見，避免還原到沒被選的時間框時看不到也選不回來。
function applyMobileTFVisibility() {
  const visible = new Set(_mobileTFs);
  if (typeof currentTF !== "undefined") visible.add(currentTF);
  document.querySelectorAll(".tf-btn").forEach(b => {
    b.classList.toggle("tf-hidden-mobile", !visible.has(b.dataset.tf));
  });
}

function initMobileTF() {
  loadMobileTFs();
  const popup   = document.getElementById("tfPopup");
  const gridEl  = document.getElementById("tfPickGrid");
  const stateEl = document.getElementById("mSetTFState");
  applyMobileTFVisibility();
  if (!popup || !gridEl) return;

  const updateState = () => { if (stateEl) stateEl.textContent = _mobileTFs.map(tf => TF_LABELS[tf] || tf).join(" / "); };
  const render = () => {
    gridEl.innerHTML = MOBILE_TF_ALL.map(tf => {
      const idx = _mobileTFs.indexOf(tf);
      const on  = idx >= 0;
      return `<button type="button" class="tf-pick-item${on ? " on" : ""}" data-tf="${tf}">${
        on ? `<span class="tf-pick-ord">${idx + 1}</span>` : ""}${TF_LABELS[tf] || tf}</button>`;
    }).join("");
  };
  render();
  updateState();

  gridEl.addEventListener("click", e => {
    const btn = e.target.closest(".tf-pick-item");
    if (!btn) return;
    // 阻止冒泡到 document 的「點外面關閉」：render() 會重建 innerHTML 把此項拆離 DOM，
    // 否則外層 popup.contains(e.target) 會誤判成點到面板外 → 一點就關。改成只有點空白處才關。
    e.stopPropagation();
    const tf  = btn.dataset.tf;
    const cur = _mobileTFs.slice();
    const at  = cur.indexOf(tf);
    if (at >= 0) {
      if (cur.length <= 1) { if (typeof showToast === "function") showToast("至少需保留一個時間框"); return; }
      cur.splice(at, 1);                                  // 取消選取
    } else {
      if (cur.length >= MOBILE_TF_MAX) { if (typeof showToast === "function") showToast(`最多選 ${MOBILE_TF_MAX} 個時間框`); return; }
      cur.push(tf);
    }
    saveMobileTFs(cur);
    render();
    updateState();
    applyMobileTFVisibility();
  });

  // 開啟（手機設定列呼叫）；同時收掉其他浮動面板
  window._openTFPopup = () => {
    if (typeof _closeAllFloatPanels === "function") _closeAllFloatPanels("tf");
    render();
    popup.classList.add("open");
  };
  // 點面板外 → 關閉
  document.addEventListener("click", e => {
    if (popup.classList.contains("open") && !popup.contains(e.target) && !e.target.closest("#mSetMobileTF")) {
      popup.classList.remove("open");
    }
  });
}

/* ══════════════════════════════════════════
   右側行情列表
══════════════════════════════════════════ */
