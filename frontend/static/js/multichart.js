// 多圖分割佈局（桌面版）：主圖完全不動（全功能），右側加「迷你圖欄」。
//   模式：1（單圖，預設＝現狀）→ 2（主圖＋1 迷你）→ 4（主圖＋3 迷你）循環，topbar 田字鈕切換。
//   迷你圖＝獨立輕量 LWC 實例：K 棒＋標題列（標的/時框/現價/漲跌%），無策略層/繪圖（省效能）。
//   互動：點迷你圖標題 → 與主圖「交換標的」（主圖 loadData 有本機快照 → 近乎秒切）；
//         點時框章 → 循環 15m/1h/4h/1d。設定存 localStorage.multiChart（帳號快照自動帶走）。
//   更新：初載 /api/ohlcv(320根)、之後每 5s /api/latest 補尾巴；背景分頁暫停（省電規範）。
//   手機（isMobileUI）不啟用；⚠ 新檔已加入 main.py _build_js_bundle names（bundle 鐵則）。
(function () {
  const TF_CYCLE = ["15m", "1h", "4h", "1d"];
  const DEF = [
    { market: "crypto", symbol: "ETH/USDT", exchange: "pionex", tf: "1h" },
    { market: "crypto", symbol: "SOL/USDT", exchange: "pionex", tf: "1h" },
    { market: "crypto", symbol: "BNB/USDT", exchange: "pionex", tf: "1h" },
  ];
  let _mode = 1, _minis = [];
  try {
    const s = JSON.parse(localStorage.getItem("multiChart") || "null");
    if (s && typeof s === "object") { _mode = [1, 2, 4].includes(s.mode) ? s.mode : 1; _minis = Array.isArray(s.minis) ? s.minis : []; }
  } catch (e) {}
  for (let i = 0; i < 3; i++) if (!_minis[i] || !_minis[i].symbol) _minis[i] = { ...DEF[i] };
  const _save = () => { try { localStorage.setItem("multiChart", JSON.stringify({ mode: _mode, minis: _minis })); } catch (e) {} };

  let _grid = null;
  const _cells = [];   // idx → {el, chart, series, symEl, tfEl, pxEl, ro, gen, lastC, prevC}

  function _mkCell(i) {
    const el = document.createElement("div");
    el.className = "mini-cell";
    el.innerHTML =
      '<div class="mini-head" title="點標的名稱 ⇄ 與主圖交換">' +
      '<span class="mini-sym"></span><button type="button" class="mini-tf" title="切換這格的時框"></button>' +
      '<span class="mini-px"></span></div><div class="mini-body"></div>';
    _grid.appendChild(el);
    const body = el.querySelector(".mini-body");
    const chart = LightweightCharts.createChart(body, (typeof makeBaseOpts === "function") ? makeBaseOpts(null, true) : {});
    chart.applyOptions({ handleScroll: true, handleScale: true, rightPriceScale: { minimumWidth: 56 } });
    const series = chart.addCandlestickSeries({
      upColor: (typeof C !== "undefined" && C.up) || "#26a69a",
      downColor: (typeof C !== "undefined" && C.down) || "#ef5350",
      borderVisible: false,
      wickUpColor: (typeof C !== "undefined" && C.up) || "#26a69a",
      wickDownColor: (typeof C !== "undefined" && C.down) || "#ef5350",
      priceLineVisible: true, lastValueVisible: true,
    });
    const ro = new ResizeObserver(() => { try { chart.resize(body.clientWidth, body.clientHeight); } catch (e) {} });
    ro.observe(body);
    const cell = { el, chart, series, symEl: el.querySelector(".mini-sym"), tfEl: el.querySelector(".mini-tf"), pxEl: el.querySelector(".mini-px"), ro, gen: 0, lastC: null, prevC: null };
    el.querySelector(".mini-sym").addEventListener("click", () => _swap(i));
    cell.tfEl.addEventListener("click", (e) => { e.stopPropagation(); _cycleTf(i); });
    return cell;
  }

  function _destroyCell(cell) {
    try { cell.ro.disconnect(); } catch (e) {}
    try { cell.chart.remove(); } catch (e) {}
    try { cell.el.remove(); } catch (e) {}
  }

  function _updHeader(i) {
    const m = _minis[i], cell = _cells[i];
    if (!cell) return;
    cell.symEl.textContent = m.symbol;
    cell.tfEl.textContent = (typeof TF_LABELS !== "undefined" && TF_LABELS[m.tf]) || m.tf;
    if (cell.lastC != null && cell.prevC != null && cell.prevC > 0) {
      const pct = (cell.lastC - cell.prevC) / cell.prevC * 100;
      cell.pxEl.textContent = `${(typeof _fmtPx === "function") ? _fmtPx(cell.lastC) : cell.lastC}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      cell.pxEl.className = "mini-px " + (pct >= 0 ? "up" : "down");
    } else { cell.pxEl.textContent = ""; }
  }

  async function _loadMini(i) {
    const m = _minis[i], cell = _cells[i];
    if (!cell) return;
    const gen = ++cell.gen;
    _updHeader(i);
    try {
      const res = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: m.market, symbol: m.symbol, timeframe: m.tf, exchange: m.exchange || "pionex", limit: 320, indicators: false }),
      });
      const j = await res.json();
      if (gen !== cell.gen || !res.ok || !Array.isArray(j.data) || !j.data.length) return;
      cell.series.setData(j.data.map(b => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
      const n = j.data.length;
      cell.lastC = j.data[n - 1].close; cell.prevC = n > 1 ? j.data[n - 2].close : null;
      cell.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n + 3 });
      _updHeader(i);
    } catch (e) {}
  }

  async function _tickMini(i) {
    const m = _minis[i], cell = _cells[i];
    if (!cell || cell.lastC == null) return;         // 初載還沒好
    const gen = cell.gen;
    try {
      const res = await fetch("/api/latest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: m.market, symbol: m.symbol, timeframe: m.tf, exchange: m.exchange || "pionex" }),
      });
      const j = await res.json();
      if (gen !== cell.gen || !j || !Array.isArray(j.data) || !j.data.length) return;
      const tail = j.data.slice(-2);
      for (const b of tail) cell.series.update({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
      if (tail.length >= 2) cell.prevC = tail[tail.length - 2].close;
      cell.lastC = tail[tail.length - 1].close;
      _updHeader(i);
    } catch (e) {}
  }

  function _swap(i) {
    const symEl = document.getElementById("symbolInput");
    const mktEl = document.getElementById("marketSelect");
    const excEl = document.getElementById("exchangeSelect");
    if (!symEl || !mktEl) return;
    const cur = { market: mktEl.value, symbol: symEl.value.trim(), exchange: excEl?.value || "pionex", tf: _minis[i].tf };
    const m = _minis[i];
    mktEl.value = m.market; symEl.value = m.symbol; if (excEl && m.exchange) excEl.value = m.exchange;
    _minis[i] = { market: cur.market, symbol: cur.symbol, exchange: cur.exchange, tf: cur.tf };
    _save();
    if (typeof loadData === "function") loadData(true);   // 主圖載入（本機快照 → 近乎秒切）
    _loadMini(i);
  }

  function _cycleTf(i) {
    const cur = TF_CYCLE.indexOf(_minis[i].tf);
    _minis[i].tf = TF_CYCLE[(cur + 1) % TF_CYCLE.length];
    _save();
    _loadMini(i);
  }

  function _applyMode() {
    if (!_grid) return;
    document.documentElement.classList.toggle("mc-2", _mode === 2);
    document.documentElement.classList.toggle("mc-4", _mode === 4);
    const want = _mode === 1 ? 0 : (_mode === 2 ? 1 : 3);
    while (_cells.length > want) _destroyCell(_cells.pop());
    while (_cells.length < want) { const i = _cells.length; _cells.push(_mkCell(i)); _loadMini(i); }
    const btn = document.getElementById("tbLayoutBtn");
    if (btn) btn.classList.toggle("active", _mode !== 1);
    if (typeof resizeAll === "function") requestAnimationFrame(() => requestAnimationFrame(resizeAll));
  }

  window._cycleLayout = function () {
    _mode = _mode === 1 ? 2 : (_mode === 2 ? 4 : 1);
    _save();
    _applyMode();
    return _mode;
  };

  function _init() {
    if (typeof isMobileUI === "function" && isMobileUI()) return;   // 手機不啟用（按鈕亦由 CSS 藏）
    const cc = document.getElementById("chartsContainer");
    if (!cc || !cc.parentElement) return;
    _grid = document.createElement("div");
    _grid.id = "miniGrid";
    cc.parentElement.insertBefore(_grid, cc.nextSibling);   // .body-layout(flex row)內、主圖右側
    _applyMode();
    // 每 5s 更新尾巴（背景分頁暫停＝省電規範；錯開避免同秒齊發）
    setInterval(() => {
      if (document.hidden || !_cells.length) return;
      _cells.forEach((c, i) => setTimeout(() => _tickMini(i), i * 400));
    }, 5000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(_init, 800));
  else setTimeout(_init, 800);
})();
