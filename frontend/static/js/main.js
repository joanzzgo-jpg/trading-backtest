document.addEventListener("DOMContentLoaded", async () => {
  loadPrefs();

  _loadWatchlist();
  loadLastSymbol();     // 還原上次標的、交易所、市場、時間框架
  loadSystemColors();
  applyAllSystemColors();
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
});

