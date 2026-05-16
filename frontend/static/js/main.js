document.addEventListener("DOMContentLoaded", async () => {
  loadPrefs();

  _loadWatchlist();
  loadLastSymbol();     // 還原上次標的、交易所、市場、時間框架
  loadSystemColors();
  applyAllSystemColors();
  // 極簡模式：覆蓋成純白系極簡配色（蓋掉 applyAllSystemColors 寫入的暗色 inline style）
  // 這份 palette 是極簡模式專屬、固定不可調整；正常模式的使用者自訂色仍存在 localStorage.sysColors
  if (document.documentElement.classList.contains("perf-mode")) {
    const _lightPalette = {
      "sc-bg":     "#FFFFFF",  // 主背景＋topbar
      "sc-panel":  "#FAFAFA",  // 面板內部
      "sc-border": "#E5E5E5",  // 邊框淡灰
      "sc-text":   "#1F1F1F",  // 近黑文字
      "sc-muted":  "#8B8B8B",  // 中灰次要文字
      "sc-blue":   "#FF6A1A",  // 保留橘色品牌色作 accent
    };
    for (const [id, color] of Object.entries(_lightPalette)) applySystemColor(id, color);
    const _ds = document.documentElement.style;
    _ds.setProperty("--bg4",    "#F0F0F0");
    _ds.setProperty("--green",  "#16a34a");
    _ds.setProperty("--red",    "#dc2626");
    _ds.setProperty("--accent", "#FF6A1A");
  }
  loadSymHistory();
  loadPaneFlexes();   // 套用儲存的面板比例（在 buildCharts 前，讓第一次 resize 即正確）
  buildCharts();
  bindEvents();
  _renderWatchlist();
  bindTickerPanel();
  bindSystemColors();
  initSymSearch();
  syncTimeScales();
  initDrawTools();
  updateMarketUI();
  applyAllColors();
  startTickerRefresh();
  window.addEventListener("beforeunload", () => { saveLastSymbol(); });

  const _afterLoad = () => { loadVisibilityPrefs(); applyAllLineStyles(); };
  loadData(true).then(_afterLoad).catch(() => {
    // 失敗後 2 秒自動重試一次（Railway 冷啟動約需 1-3 秒）
    showToast("⚠️ 連線中，2 秒後自動重試…");
    setTimeout(() => {
      loadData(true).then(_afterLoad).catch(() => showToast("⚠️ 載入失敗，請點「載入」重試"));
    }, 2000);
  });

  // 極簡模式按鈕：開/關後重新整理頁面（最乾淨）
  const _perfBtn = document.getElementById("perfModeBtn");
  if (_perfBtn) {
    const _isPerf = document.documentElement.classList.contains("perf-mode");
    if (_isPerf) {
      _perfBtn.classList.add("active");
      _perfBtn.textContent = "☀️ 恢復完整特效";
    }
    _perfBtn.addEventListener("click", () => {
      try {
        if (localStorage.getItem("perfMode") === "1") {
          localStorage.removeItem("perfMode");
        } else {
          localStorage.setItem("perfMode", "1");
        }
      } catch (e) {}
      location.reload();
    });
  }

  // 極簡模式：跳過 effects.js（SFX、BGM、天氣動畫、點擊特效），改用最小化的 FX 面板開關
  if (document.documentElement.classList.contains("perf-mode")) {
    const _panel = document.getElementById("fxPanel");
    const _btn   = document.getElementById("fxToggleBtn");
    if (_panel && _btn) {
      _btn.addEventListener("click", e => {
        e.stopPropagation();
        const open = _panel.classList.toggle("hidden");
        _btn.classList.toggle("fx-open", !open);
      });
      document.addEventListener("click", e => {
        if (!_panel.contains(e.target) && e.target !== _btn) {
          _panel.classList.add("hidden");
          _btn.classList.remove("fx-open");
        }
      });
    }
    return; // 不載入 effects.js
  }

  // 延遲載入 effects.js（SFX、BGM、天氣動畫），等瀏覽器閒置後再執行
  const _loadFx = () => {
    const s = document.createElement("script");
    s.src = "/static/js/effects.js?v=" + (window._APP_VER || "1");
    document.head.appendChild(s);
  };
  "requestIdleCallback" in window
    ? requestIdleCallback(_loadFx, { timeout: 3000 })
    : setTimeout(_loadFx, 1500);
});

