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

  // ── 繪圖工具欄 ──────────────────────────────
  document.querySelectorAll(".dt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".dt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      setDrawTool(btn.dataset.tool);
    });
  });
  // 弱磁鐵切換
  document.getElementById("btnMagnet")?.addEventListener("click", () => {
    _magnetMode = !_magnetMode;
    document.getElementById("btnMagnet").classList.toggle("active", _magnetMode);
  });
  // Esc 回到 pointer / 取消進行中的繪圖
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("symOverlay").classList.contains("hidden")) return;
    if (e.key === "Escape") {
      if (replayActive) { exitReplay(); return; }
      if (drawingWIP) { drawingWIP = null; requestAnimationFrame(renderDrawings); }
      document.querySelectorAll(".dt-btn").forEach(b => b.classList.remove("active"));
      document.querySelector(".dt-btn[data-tool='pointer']")?.classList.add("active");
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
    if ((e.key === "m" || e.key === "M") && document.activeElement.tagName !== "INPUT") {
      _magnetMode = !_magnetMode;
      document.getElementById("btnMagnet")?.classList.toggle("active", _magnetMode);
    }
  });

  // indicatorsToggle 保留（無操作，設定改由各 pane 的 ⚙ 按鈕開啟）

  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTF = btn.dataset.tf;
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
  const map = [
    // legBB / legVol / legCRT 不掛色盤：點圖例只切顯隱（由 leg-toggle 處理）；
    // 顏色改用齒輪「主圖設定」面板（BB 上/下·中、量柱漲跌）設定，避免點到就跳色盤。
    { id:"legK",       key:"kdjK",    apply: c => { C.kdjK = c; kdjK?.applyOptions({color:c}); const el=document.getElementById("legK");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legD",       key:"kdjD",    apply: c => { C.kdjD = c; kdjD?.applyOptions({color:c}); const el=document.getElementById("legD");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legJ",       key:"kdjJ",    apply: c => { C.kdjJ = c; kdjJ?.applyOptions({color:c}); const el=document.getElementById("legJ");       if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi14",   key:"rsi14",   apply: c => { C.rsi14   = c; rsiLine14?.applyOptions({color:c});  const el=document.getElementById("legRsi14");  if(el) el.style.color=c; savePrefs(); } },
    { id:"legRsi7",    key:"rsi7",    apply: c => { C.rsi7    = c; rsiLine7?.applyOptions({color:c});   const el=document.getElementById("legRsi7");   if(el) el.style.color=c; savePrefs(); } },
    { id:"legKdjH20",  key:"kdjH20",  apply: c => { C.kdjH20  = c; kdjH20?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH50",  key:"kdjH50",  apply: c => { C.kdjH50  = c; kdjH50?.applyOptions({color:c}); savePrefs(); } },
    { id:"legKdjH80",  key:"kdjH80",  apply: c => { C.kdjH80  = c; kdjH80?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH30",  key:"rsiH30",  apply: c => { C.rsiH30  = c; rsiH30?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH50",  key:"rsiH50",  apply: c => { C.rsiH50  = c; rsiH50?.applyOptions({color:c}); savePrefs(); } },
    { id:"legRsiH70",  key:"rsiH70",  apply: c => { C.rsiH70  = c; rsiH70?.applyOptions({color:c}); savePrefs(); } },
    { id:"legMacd",    key:"macd",    apply: c => { C.macd    = c; macdLine?.applyOptions({color:c});   const el=document.getElementById("legMacd");    if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdSig", key:"macdSig", apply: c => { C.macdSig = c; macdSignal?.applyOptions({color:c}); const el=document.getElementById("legMacdSig"); if(el) el.style.color=c; savePrefs(); } },
    { id:"legMacdHist",key:"macdHist",apply: c => { C.macdHist = c; macdHist?.applyOptions({color:c}); savePrefs(); } },
  ];
  map.forEach(({ id, key, apply }) => {
    const legEl = document.getElementById(id);
    if (!legEl) return;
    const dot = legEl.querySelector(".leg-dot");
    if (!dot) return;
    dot.style.cursor = "pointer";
    dot.addEventListener("click", e => {
      e.stopPropagation();   // 不要觸發 leg-toggle 的顯隱切換
      const cur = (C[key] || "#888").substring(0, 7);
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
        { divider: true },
        { label:"CRT 看多", colorKey:"crtBull", onColor: ()=>{ if(ohlcvData.length) renderCRT(ohlcvData); } },
        { label:"CRT 看空", colorKey:"crtBear", onColor: ()=>{ if(ohlcvData.length) renderCRT(ohlcvData); } },
        { divider: true },
        { label:"共振 看多", colorKey:"resonanceBull", onColor: ()=>{ if(ohlcvData.length) renderResonance(ohlcvData); } },
        { label:"共振 看空", colorKey:"resonanceBear", onColor: ()=>{ if(ohlcvData.length) renderResonance(ohlcvData); } },
        { divider: true },
        { label:"KDJ金叉",  colorKey:"kdjCrossBull", onColor: ()=>{ if(ohlcvData.length) renderKDJCross(ohlcvData); } },
        { label:"KDJ死叉",  colorKey:"kdjCrossBear", onColor: ()=>{ if(ohlcvData.length) renderKDJCross(ohlcvData); } },
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
        { label:"超買", colorKey:"rsiH70", onColor: c=>{rsiH70?.applyOptions({color:c}); _syncLegDot("legRsiH70",c);}, numKey:"rsiH70val", numSeries:()=>rsiH70, widKey:"rsiHLWidth", onWidth: w=>{ [rsiH30,rsiH50,rsiH70].forEach(s=>s?.applyOptions({lineWidth:w})); } },
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
            currentColor: (C[key]||"#888").substring(0,7),
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
            currentColor: (C[key]||"#888").substring(0,7),
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
          currentColor: (C[row.colorKey] || "#888").substring(0, 7),
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
        S[row.lsKey] = next; row.series()?.applyOptions({ lineStyle: next }); savePrefs();
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
    { id: "legBB",       series: () => [bbU, bbM, bbL, bbU1, bbL1] },
    { id: "legCRT",      series: null,  action: () => _applyMainMarkers() },
    { id: "legKDJCross", series: null,  action: () => _applyMainMarkers() },
    { id: "legResonance",series: null,  action: () => _applyMainMarkers() },
    { id: "legVol",      series: () => [volSeries, volMaSeries] },
    { id: "legFVG",      series: null,  action: (hidden) => { if (typeof toggleFVG === "function") toggleFVG(!hidden); } },
    { id: "legFVGMS",    series: null,  action: (hidden) => { if (typeof toggleFVGMS === "function") toggleFVGMS(!hidden); } },
    { id: "legFVGBreak", series: null,  action: (hidden) => { if (typeof toggleFVGBreak === "function") toggleFVGBreak(!hidden); } },
    { id: "legFVGShun",  series: null,  action: (hidden) => { if (typeof toggleFVGShun === "function") toggleFVGShun(!hidden); } },
    // 大棒淡化：line-off(dim)=關閉、亮=啟用 → hidden 為 false 時啟用
    { id: "legDimBigBar",series: null,  action: (hidden) => { if (typeof toggleDimBigBar === "function") toggleDimBigBar(!hidden); } },
    { id: "legK",        series: () => [kdjK] },
    { id: "legD",        series: () => [kdjD] },
    { id: "legJ",        series: () => [kdjJ] },
    { id: "legRsi14",    series: () => [rsiLine14] },
    { id: "legRsi7",     series: () => [rsiLine7] },
    { id: "legMacd",     series: () => [macdLine] },
    { id: "legMacdSig",  series: () => [macdSignal] },
    { id: "legMacdHist", series: () => [macdHist] },
  ];
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

  // 面板收合：點擊「−」縮至只剩圖例列；點「+」展開
  document.querySelectorAll(".pane-collapse-btn").forEach(btn => {
    btn.dataset.collapsed = "false";  // 初始化屬性
    const paneId = btn.dataset.pane;
    btn.addEventListener("click", () => {
      const pane = document.getElementById(paneId);
      const body = pane.querySelector(".pane-body");
      const collapsed = btn.dataset.collapsed === "true";
      if (collapsed) {
        pane.style.flex = paneCollapseFlex[paneId] || "1";
        body.style.display = "";
        btn.dataset.collapsed = "false";
        btn.textContent = "\u2212";  // −
      } else {
        paneCollapseFlex[paneId] = pane.style.flex || "1";
        pane.style.flex = "0";
        body.style.display = "none";
        btn.dataset.collapsed = "true";
        btn.textContent = "+";
      }
      updateBottomTimeAxis();
      resizeAll();
      saveVisibilityPrefs();
      savePaneFlexes();
    });
  });
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
  const MKTS  = ["crypto", "tw", "us", "hk"];
  const LBL   = { crypto: "Crypto", tw: "TW", us: "US", hk: "HK" };

  const setMarket = (mkt) => {
    if (!LBL[mkt]) return;
    pill.dataset.mkt = mkt;            // 觸發 CSS 變色（不同市場不同漸層）
    label.textContent = LBL[mkt];
  };
  // 初始同步 select → pill 顯示
  setMarket(sel.value || "crypto");

  pill.addEventListener("click", () => {
    const cur  = sel.value || "crypto";
    const next = MKTS[(MKTS.indexOf(cur) + 1) % MKTS.length];
    // 1) 舊文字上滑淡出
    pill.classList.add("cycling");
    setTimeout(() => {
      // 2) 切換 select.value + 觸發 change（既有市場切換流程接手）
      sel.value = next;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      // 3) 換新文字 + 瞬時放到下方
      pill.classList.remove("cycling");
      pill.classList.add("cycling-in");
      setMarket(next);
      // 4) 強制 reflow → 移除 cycling-in → 文字從下方 slide 回中央
      void label.offsetWidth;
      requestAnimationFrame(() => pill.classList.remove("cycling-in"));
    }, 280);
  });

  // 別處改變 select 時也同步 pill
  sel.addEventListener("change", () => setMarket(sel.value || "crypto"));
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
  // 主背景（sc-bg）強制變暗：任何 picker 色經 _darkenForChart 壓到接近黑
  // 這樣天氣動畫、weather canvas 永遠有對比可見
  const applied = (id === "sc-bg" && typeof _darkenForChart === "function")
    ? _darkenForChart(color)
    : color;
  vars.forEach(v => document.documentElement.style.setProperty(v, applied));
  if (id === "sc-bg") document.body.style.background = applied;
}
function applyAllSystemColors() {
  for (const [id, color] of Object.entries(SC)) applySystemColor(id, color);
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
      const cur = (SC[id] || "#888").slice(0, 7);
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
