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
      '<div class="mini-head">' +
      '<span class="mini-sym" title="點一下換這一格的標的"></span>' +
      '<button type="button" class="mini-tf" title="切換這格的時框"></button>' +
      '<button type="button" class="mini-swap" title="與主圖交換標的">⇄</button>' +
      '<span class="mini-px"></span></div><div class="mini-body"></div>' +
      '<div class="mini-subs"></div>';
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
      /* 現價線：與主圖同一顆顏色（C.curPrice,使用者可在「主圖設定 → 現價線」改）。
         不給的話 LWC 會用「最後一根的漲跌色」,看起來就不像主圖那條橘線。 */
      priceLineVisible: true, lastValueVisible: true,
      priceLineColor: (typeof C !== "undefined" && C.curPrice) || "#FF9147", priceLineStyle: 2, priceLineWidth: 1,
    });
    /* ★ 成交量（同主圖：獨立 priceScaleId,不影響 K 棒的價格軸） */
    const vol = chart.addHistogramSeries({ priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
    try { chart.priceScale("volume").applyOptions({ scaleMargins: (typeof VOL_SCALE_MARGINS !== "undefined" ? VOL_SCALE_MARGINS : { top: 0.82, bottom: 0 }), visible: false }); } catch (e) {}
    try { chart.priceScale("right").applyOptions({ scaleMargins: (typeof MAIN_SCALE_MARGINS !== "undefined" ? MAIN_SCALE_MARGINS : { top: 0.06, bottom: 0.2 }) }); } catch (e) {}
    /* ★ 布林（bb_upper/middle/lower 一直都在 `/api/ohlcv` 的回應裡,與 `indicators` 旗標無關 ——
       那個旗標砍的是三個副圖的欄位,布林是畫在主圖上的,見守門員之二十七的警告） */
    const C0 = (typeof C !== "undefined") ? C : {};
    const bbU = chart.addLineSeries({ color: C0.bbU || "#42a5f5", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const bbM = chart.addLineSeries({ color: C0.bbM || "#ffcc02", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    const bbL = chart.addLineSeries({ color: C0.bbL || "#42a5f5", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    /* ★ 2026-09-27 使用者：「兩個標的 四個標的畫面要修,要跟一個畫面的配置都相同,包含 K 棒時間軸,
       就是移動 a 標的 b 對應標的也對」。→ 每一格都訂閱「可視時間範圍」的變化,
       任何一張圖被拖曳/縮放,其餘各張（含主圖）都套用**同一段時間**。
       ⚠ 用 `VisibleTimeRange`（時間）不用 `VisibleLogicalRange`（第幾根）：
         每一格的資料根數不同,用「第幾根」對齊會完全錯位。 */
    chart.timeScale().subscribeVisibleTimeRangeChange(r => _onRange(chart, r));
    chart.subscribeCrosshairMove(param => _onCross(chart, param));
    /* ★ 未來留白（whitespace series）：沒有它,這一格的時間軸會被「最後一根 K 棒」夾住,
       主圖拖到未來留白時對不齊（實測主圖右緣 10/10、迷你圖只能到 9/27,差 13 天）。
       做法與主圖完全相同（charts.js `_gridAhead`）：只有 time、沒有價格,不參與價格軸。 */
    const ws = chart.addLineSeries({
      priceScaleId: "", lastValueVisible: false, crosshairMarkerVisible: false,
      priceLineVisible: false, autoscaleInfoProvider: () => null,
    });
    /* ★ 線型圖：與主圖同一套做法 —— series 本身全透明（只負責價格軸自動縮放/十字線吸附）,
       可見的那條由 `_makeLineGradPrimitive` 用 canvas 漸層描。
       ⚠ 一定要傳自己的點陣列（`() => cell.linePts`）：不傳就會畫成主圖那一檔的走勢。 */
    const lineS = chart.addLineSeries({
      color: "rgba(0,0,0,0)", lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, visible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerBorderColor: "#8b5cf6", crosshairMarkerBackgroundColor: "#8b5cf6",
    });
    /* 可見高低（高/次高、低/次低）畫在自己的 overlay 畫布上,內容由 draw.js 的
       `window._mcDrawOverlay` 重用主圖那支 `_drawVisHL` 畫（見那邊的長註解）。 */
    const ov = document.createElement("canvas");
    ov.className = "mini-ov";
    body.appendChild(ov);
    const ro = new ResizeObserver(() => { try { chart.resize(body.clientWidth, body.clientHeight); } catch (e) {} _ovSize(cell); _ovPaint(cell); });
    ro.observe(body);
    const cell = { el, chart, series, ws, lineS, vol, bbU, bbM, bbL, ov, fvg: [], mkSrc: null, body, subWrap: el.querySelector(".mini-subs"), subs: [], rows: [], linePts: [], mkRaw: [], symEl: el.querySelector(".mini-sym"), tfEl: el.querySelector(".mini-tf"), pxEl: el.querySelector(".mini-px"), ro, gen: 0, lastC: null, prevC: null };
    try {
      cell.lineGrad = (typeof _makeLineGradPrimitive === "function") ? _makeLineGradPrimitive(() => cell.linePts) : null;
      if (cell.lineGrad) lineS.attachPrimitive(cell.lineGrad);
      /* 上下顛倒時 LWC 自己的影線會穿過實體（charts.js `_makeInvWickPrimitive` 的完整說明）
         → 顛倒時關掉原生影線、改由它畫。主圖有、迷你圖也要有,否則顛倒時兩邊長得不一樣。 */
      if (typeof _makeInvWickPrimitive === "function") series.attachPrimitive(_makeInvWickPrimitive());
      // FVG 失衡缺口色塊：用主圖同一支 primitive,但餵這一格自己的缺口（見 charts.js 的 getZones）
      if (typeof _makeFVGPrimitive === "function") {
        cell.fvgPrim = _makeFVGPrimitive(() => cell.fvg);
        series.attachPrimitive(cell.fvgPrim);
      }
    } catch (e) {}
    /* ★ 2026-09-27 使用者：「第二畫面標的怎麼換」。原本**只有**「跟主圖交換」一條路
       （要看 X 就得先把主圖切成 X 再點這裡）→ 點標的名改成直接開搜尋視窗挑,
       交換保留成旁邊的 ⇄ 鈕（兩個都有用：交換是「把這格拉上主圖細看」）。 */
    _ovSize(cell);
    // 這一格自己被平移/縮放時也要重畫 overlay（主圖那邊由 renderDrawings 的共同入口帶動）
    chart.timeScale().subscribeVisibleTimeRangeChange(r => { if (r) _growWs(cell, r.to); _ovQueue(cell); });
    el.querySelector(".mini-sym").addEventListener("click", (e) => { e.stopPropagation(); _pickSym(i); });
    el.querySelector(".mini-swap").addEventListener("click", (e) => { e.stopPropagation(); _swap(i); });
    cell.tfEl.addEventListener("click", (e) => { e.stopPropagation(); _cycleTf(i); });
    return cell;
  }

  /* ── 時間軸連動：一張圖動 → 其餘各張套同一段時間 ──────────────────
     ⚠ 一定要有**迴圈防護**：setVisibleRange 會再觸發對方的 change 事件,沒有旗標會無限互推
       （畫面表現是圖表抖動/卡住）。
     ⚠ 主圖也是參與者（它才是使用者主要操作的那張）,但主圖有自己的錨點還原機制
       （_holdAnchorByTime/_bootViewHold,見 charts.js）→ **開機前 1.5 秒不連動**,
       免得把還原中的視角扯走。 */
  let _syncing = false, _syncReady = 0;
  function _charts() {
    const out = [];
    if (typeof mainChart !== "undefined" && mainChart) out.push(mainChart);
    _cells.forEach(c => { if (c && c.chart) out.push(c.chart); });
    return out;
  }
  /* 某一張圖的繪圖區寬度（＝面板寬 − 價格軸寬）。
     ⚠ 不可以用 `timeScale().width()`：實測它對主圖回 0（claude.md 記過）。 */
  function _plotW(chart, el) {
    try {
      const w = (el ? el.clientWidth : 0) - (chart.priceScale("right").width() || 0);
      return w > 1 ? w : 0;
    } catch (e) { return 0; }
  }
  function _elOf(chart) {
    if (typeof mainChart !== "undefined" && chart === mainChart) return document.getElementById("mainChart");
    const c = _cells.find(x => x.chart === chart);
    return c ? c.body : null;
  }

  /* ★★ 2026-09-27 使用者：「兩邊 K 棒大小不一」。
     原本是把**同一段時間**（setVisibleRange）套給每一張 —— 但 LWC 會把 from/to **snap 到最近的
     K 棒**,兩邊各差一根,視窗內只有十幾根時就是 8% 的寬度差（實測縮放後 36.26 vs 33.56）。
     → 改成同步「**K 棒寬度（barSpacing）＋ 右緣的那個時間**」：
       ①barSpacing 直接複製 → K 棒大小必然一模一樣（這正是使用者看到的那件事）
       ②再把「來源右緣那根」平移到對方的同一個位置 → 時間軸照樣對得起來
     寬度相同時（2 格模式,見 style.css 的 flex 對分）兩者等價於同一段時間；
     寬度不同時（4 格）則是「同樣大小的 K 棒、右緣對齊」,較窄的那格自然少看幾根歷史。
     ⚠ 對方沒有那個時間時（跨市場：加密 vs 台股,K 棒時間根本不同）退回原本的 setVisibleRange。 */
  function _syncFrom(src) {
    if (_mode === 1) return;
    const sTs = src.timeScale();
    let bs = 0, r = null;
    try { bs = sTs.options().barSpacing; r = sTs.getVisibleRange(); } catch (e) {}
    if (!(bs > 0) || !r) return;
    const sw = _plotW(src, _elOf(src));
    let sx = null;
    try { sx = sTs.timeToCoordinate(r.to); } catch (e) {}
    for (const ch of _charts()) {
      if (ch === src) continue;
      const ts = ch.timeScale();
      let done = false;
      try {
        ts.applyOptions({ barSpacing: bs });
        const w = _plotW(ch, _elOf(ch));
        const x = ts.timeToCoordinate(r.to);
        if (x != null && sx != null && w && sw) {
          // 來源右緣那根距離右邊界 (sw - sx) px → 對方也要一樣；差幾根就捲幾根
          ts.scrollToPosition(ts.scrollPosition() + (x - (w - (sw - sx))) / bs, false);
          done = true;
        }
      } catch (e) {}
      if (!done) { try { ts.setVisibleRange({ from: r.from, to: r.to }); } catch (e) {} }
    }
    _cells.forEach(c => {
      try { const vr = c.chart.timeScale().getVisibleRange(); if (vr) _growWs(c, vr.to); } catch (e) {}
      _syncSubs(c); _loadOlder(c);
    });
  }

  function _onRange(src, r) {
    if (_syncing || !r || _mode === 1) return;
    if (Date.now() < _syncReady) return;
    _syncing = true;
    try { _syncFrom(src); }
    finally {
      // 下一拍才解鎖：setVisibleRange / scrollToPosition 觸發的 change 事件是非同步的
      setTimeout(() => { _syncing = false; }, 0);
    }
  }
  /* ── 十字線連動：游標在任一張圖上 → 其餘各張在**同一個時間**顯示十字線 ─────────
     ⚠ 同樣要迴圈防護：setCrosshairPosition 會觸發對方的 crosshairMove。
     ⚠ 主圖要走 `window._mcCrosshairAt`（它的鉛直線是自繪的 DOM,不是 LWC 原生）。
     ⚠ 價格用「那一格自己在該時間的收盤」→ 橫線落在自己的 K 棒上；沒有那根就退回最後價。 */
  let _crossing = false;
  function _crosshairTo(cell, tm) {
    try {
      const px = (cell.byTime && cell.byTime.get(tm)) ?? cell.lastC;
      if (px == null) return;
      cell.chart.setCrosshairPosition(px, tm, cell.series);
      cell.xhT = tm;                       // 給 _mcRanges 讀（驗證/除錯用）
    } catch (e) {}
  }
  function _onCross(src, param) {
    if (_crossing || _mode === 1) return;
    _crossing = true;
    try {
      const tm = param && param.time;
      if (tm == null) {
        _cells.forEach(c => { if (c.chart !== src) { try { c.chart.clearCrosshairPosition(); c.xhT = null; } catch (e) {} } });
        if (src !== (typeof mainChart !== "undefined" ? mainChart : null)) { try { window._mcCrosshairHide?.(); } catch (e) {} }
      } else {
        _cells.forEach(c => { if (c.chart !== src) _crosshairTo(c, tm); });
        if (src !== (typeof mainChart !== "undefined" ? mainChart : null)) { try { window._mcCrosshairAt?.(tm); } catch (e) {} }
      }
    } finally { _crossing = false; }
  }
  /* ⚠⚠ 上面這道旗標**必須同步釋放**,不可以 setTimeout(…,0)（我第一版就是,4 格模式整個不會動）：
     一次 mouse move 會讓瀏覽器在**同一個任務**裡先派「離開主圖」再派「進入格子」→
     用 setTimeout 釋放的話,第二個事件撞到還沒歸零的旗標就被丟掉,
     症狀是「從主圖直接移到格子沒反應、但從圖外移進去就正常」。
     `setCrosshairPosition` 觸發對方的 crosshairMove 是**同步**的,所以同步歸零就夠防迴圈。 */

  /* 主圖的訂閱只掛一次（_cells 會重建,主圖不會） */
  let _mainHooked = false;
  function _hookMain() {
    if (_mainHooked || typeof mainChart === "undefined" || !mainChart) return;
    try {
      mainChart.timeScale().subscribeVisibleTimeRangeChange(r => _onRange(mainChart, r));
      mainChart.subscribeCrosshairMove(param => _onCross(mainChart, param));
      _mainHooked = true;
    } catch (e) {}
  }

  /* 把主圖目前的可視範圍推給所有格子（開機對齊、載入完成後補齊用） */
  function _pushMainRange() {
    if (_mode === 1 || typeof mainChart === "undefined" || !mainChart) return;
    try {
      _syncing = true;
      _syncMiniAxis();          // 先把價格軸對齊,繪圖區寬度才是最終值（會影響下面的平移量）
      _syncFrom(mainChart);
      setTimeout(() => { _syncing = false; }, 0);
    } catch (e) { _syncing = false; }
  }

  /* 時框跟著主圖：使用者要的是「跟一個畫面的配置都相同」→ 進多圖模式與主圖換時框時,
     各格一律換成主圖的時框（時間軸才對得起來）。⚠ 每格仍可用時框章臨時改,
     但下次主圖換時框會再同步回來——那正是「配置都相同」的意思。 */
  function _syncTfFromMain(force) {
    const tf = (typeof currentTF !== "undefined" && currentTF) ? currentTF : null;
    if (!tf) return;
    let changed = false;
    _minis.forEach((m, i) => {
      if (m.tf !== tf) { m.tf = tf; changed = true; if (_cells[i]) _loadMini(i); }
      else if (force && _cells[i]) _loadMini(i);
    });
    if (changed) _save();
  }

  function _destroyCell(cell) {
    _killSubs(cell);
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
      cell.pxEl.textContent = `${(typeof _fmtPx === "function") ? _fmtPx(cell.lastC, cell.prec != null ? cell.prec : -1) : cell.lastC}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      cell.pxEl.className = "mini-px " + (pct >= 0 ? "up" : "down");
    } else { cell.pxEl.textContent = ""; }
  }

  async function _loadMini(i) {
    const m = _minis[i], cell = _cells[i];
    if (!cell) return;
    const gen = ++cell.gen;
    cell.noMoreHist = false; cell.olderBusy = false;   // 換標的/時框＝重新開始,舊的「沒有更舊」不算數
    _updHeader(i);
    try {
      const res = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: m.market, symbol: m.symbol, timeframe: m.tf, exchange: m.exchange || "pionex", limit: 320,
                               indicators: _fitSubs(cell).length > 0 }),   // 沒有副圖就別下載指標（守門員之二十七）
      });
      const j = await res.json();
      if (gen !== cell.gen || !res.ok || !Array.isArray(j.data) || !j.data.length) return;
      cell.rows = j.data;                                          // 原始列（含指標/布林欄）
      _feedMain(cell);
      _buildSubs(cell);
      _mirrorVis(cell);            // 載入是非同步的,可能比「開機還原偏好」晚 → 到貨後再對一次
      const n = j.data.length;
      cell.lastT = toTime(j.data[n - 1].time);   // 最後一根時間：_tickMini 只能 update ≥ 此時間的棒(LWC 限制)
      cell.lastC = j.data[n - 1].close; cell.prevC = n > 1 ? j.data[n - 2].close : null;
      /* ★ 每一格是**別的標的**，小數位要自己推，不可沿用主圖那份（_fmtPx 省略 prec 時會拿
         window._pxPrec）→ 否則 BTC 主圖(1 位)開著時，這格的低價幣會被壓成 "0.0"。 */
      try {
        const _v = [];
        for (const b of j.data.slice(-400)) _v.push(b.open, b.high, b.low, b.close);
        cell.prec = (typeof _pxDecInfer === "function") ? _pxDecInfer(_v, 10) : null;
      } catch (e) { cell.prec = null; }
      /* ★ 2026-09-27 使用者：「第二畫面價格被簡化了」。沒設 `priceFormat` 時 LWC 預設
         **precision 2 / minMove 0.01** → 低價幣（0.00001234）整條價格軸與現價標籤都變成 `0.00`。
         主圖是依資料推小數位的（`render.js` 那段「只進不退」）,格子也要自己推一份 ——
         ⚠ 不可以沿用主圖的 `window._pxPrec`：那是**另一檔**的位數（BTC 1 位開著時會把這格壓扁）。
         ⚠ 套給 K 棒與布林三條（同主圖那行 `[candleSeries, bbU, bbM, bbL]`）,
           否則布林的標籤會跟 K 棒不同格式。 */
      try {
        const _pv = cell.lastC;
        let _pr = cell.prec;
        if (!(_pr > 0)) {
          const _p = Math.abs(Number(_pv) || 0);
          _pr = _p >= 100 ? 2 : _p >= 1 ? 4 : _p >= 0.1 ? 5 : _p >= 0.01 ? 6 : _p >= 0.001 ? 7 : 8;
        }
        const _fmt = { type: "price", precision: _pr, minMove: Math.pow(10, -_pr) };
        [cell.series, cell.bbU, cell.bbM, cell.bbL, cell.lineS].forEach(x => { try { x.applyOptions({ priceFormat: _fmt }); } catch (e) {} });
      } catch (e) {}
      /* 未來留白（讓「後面」還沒有 K 棒的地方也有格線與時間刻度）。
         ⚠ 間隔用**最小正間隔**不用最後兩根的差：股市跨日那一根是盤中的好幾倍,
           用它會把格線推到太遠的未來（同 charts.js `_gridAhead` 的註解）。 */
      try {
        let step = Infinity;
        for (let k = Math.max(1, n - 12); k < n; k++) {
          const dt = toTime(j.data[k].time) - toTime(j.data[k - 1].time);
          if (dt > 0 && dt < step) step = dt;
        }
        if (Number.isFinite(step) && step > 0) {
          cell.wsStep = step; cell.wsT0 = cell.lastT; cell.wsN = 0;
          _growWs(cell, cell.lastT + step * 200);
        }
      } catch (e) {}
      /* ★ 剛載好的這一格要**立刻對齊主圖目前的時間範圍** —— 否則它會停在自己的預設視窗
         （實測初載時主圖 9/1~9/30、迷你圖 6/30~9/27,整整差 63 天）。 */
      let _aligned = false;
      if (_mode !== 1 && typeof mainChart !== "undefined" && mainChart) {
        try {
          const mr = mainChart.timeScale().getVisibleRange();
          if (mr) { cell.chart.timeScale().setVisibleRange({ from: mr.from, to: mr.to }); _aligned = true; }
        } catch (e) {}
      }
      if (!_aligned) cell.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n + 3 });
      _updHeader(i);
      _loadMiniMarkers(i, gen, new Set(j.data.map(b => toTime(b.time))));   // 策略標記(輕量,async 補上)
      setTimeout(() => { _syncMiniAxis(); _pushMainRange(); }, 60);   // 各格到貨時間不同 → 到貨後再對齊一次
      setTimeout(_syncMiniAxis, 400);                // 換低價幣時軸會變寬,晚一點再對一次
    } catch (e) {}
  }

  // 迷你圖策略標記：/api/crt_winrate?lite=ms 只回 fvg_ms/fvg_break 陣列(幾KB、吃後端勝率快取)。
  // 鏡射主圖的顏色/形狀(多#39ff14↑/空#ff2a6d↓/破空#05d9e8↑/破多#ff901f↓)、尺寸縮小;
  // 只畫「時間存在於迷你圖已載K棒」的標記(同主圖 _has 原則);冷門標的首算較久→到貨才補畫。
  function _refilterMarkers(cell) {     // 補完歷史後重濾（K 棒多了,原本被濾掉的標記要補上）
    const i = _cells.indexOf(cell);
    if (i < 0 || !cell.mkSrc) return;
    _loadMiniMarkers(i, cell.gen, new Set(cell.rows.map(b => toTime(b.time))), cell.mkSrc);
  }
  async function _loadMiniMarkers(i, gen, timeSet, cached) {
    const m = _minis[i], cell = _cells[i];
    if (!cell) return;
    try {
      const p = new URLSearchParams({
        market: m.market, symbol: m.symbol, exchange: m.exchange || "pionex", timeframe: m.tf,
        vw: "8000", lite: "ms",
        proto_min: String((typeof _wrProtoMin !== "undefined") ? _wrProtoMin : 0.0005),
        no_proto_ms: (typeof _wrNoProtoMs !== "undefined" && _wrNoProtoMs) ? "1" : "0",
        no_proto_break: (typeof _wrNoProtoBreak !== "undefined" && _wrNoProtoBreak) ? "1" : "0",
      });
      let d = cached;
      if (!d) {
        const res = await fetch("/api/crt_winrate?" + p, { cache: "no-cache" });
        d = await res.json();
        if (gen !== cell.gen || !res.ok) return;
      }
      if (gen !== cell.gen) return;
      cell.mkSrc = d;                       // 留著原始 payload：補完歷史後就地重濾,不必再打一次 API
      try { cell.fvg = (typeof window._fvgMapZones === "function") ? window._fvgMapZones(d.fvg || []) : []; } catch (e) { cell.fvg = []; }
      try { cell.fvgPrim && cell.fvgPrim.requestUpdate(); } catch (e) {}
      const out = [];
      for (const it of (d.fvg_ms || [])) {
        const tm = toTime(it.t);
        if (!timeSet.has(tm)) continue;
        out.push(it.d === "l"
          ? { time: tm, position: "belowBar", color: "#39ff14", shape: "arrowUp", size: 1, text: it.prov ? "多?" : "多", kind: "ms" }
          : { time: tm, position: "aboveBar", color: "#ff2a6d", shape: "arrowDown", size: 1, text: it.prov ? "空?" : "空", kind: "ms" });
      }
      for (const it of (d.fvg_break || [])) {
        const tm = toTime(it.t);
        if (!timeSet.has(tm)) continue;
        out.push(it.d === "s"
          ? { time: tm, position: "belowBar", color: "#05d9e8", shape: "arrowUp", size: 1, text: it.prov ? "破空?" : "破空", kind: "bk" }
          : { time: tm, position: "aboveBar", color: "#ff901f", shape: "arrowDown", size: 1, text: it.prov ? "破多?" : "破多", kind: "bk" });
      }
      out.sort((a, b) => a.time - b.time);
      cell.mkRaw = out;
      _applyMiniMarkers(cell);
    } catch (e) {}
  }

  /* 標記上牆：上下顛倒時**位置與箭頭一起翻**（高點在 K 棒下緣 → 「多」的箭頭要畫在下面、朝下）。
     只翻這兩個欄位,顏色/文字照舊 —— 同主圖 `_applyMainMarkers` 的原則。
     ⚠ 存的是「沒翻過」的原始清單 `mkRaw`：翻過的再翻一次就回去了,每次都從原始算才不會累積。 */
  function _applyMiniMarkers(cell) {
    if (!cell) return;
    const inv = !!window._chartInverted;
    /* ★ 2026-09-27 使用者：「我主圖關了 破高低還在」—— 圖例上關掉「多/空」或「破多空」時,
       格子也要跟著關（`winrate.js` 那兩顆開關會呼叫 `_mcApplyView` 回到這裡）。
       ⚠ 旗標是「hidden」語意（預設 false＝顯示）,別寫反。 */
    const noMs = !!window._fvgMSHidden, noBk = !!window._fvgBreakHidden;
    let out = cell.mkRaw.filter(k => k.kind === "bk" ? !noBk : !noMs);
    if (inv) out = out.map(k => ({ ...k,
      position: k.position === "aboveBar" ? "belowBar" : "aboveBar",
      shape: k.shape === "arrowUp" ? "arrowDown" : "arrowUp" }));
    try { cell.series.setMarkers(out); } catch (e) {}
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
      // 錯誤回應的 body 也是 JSON；這裡下面的 Array.isArray(j.data) 已擋得住，
      // 明寫 r.ok 讓意圖清楚（輪詢會自然重試，行為不變）。
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (gen !== cell.gen || !j || !Array.isArray(j.data) || !j.data.length) return;
      // ⚠ series.update() 只接受「時間 ≥ 目前最後一根」的棒（LWC 限制）：先前把倒數第二根也丟進去
      //   → 第一個 update 就拋錯被 catch 吞掉、最後一根永遠沒更新 → 迷你圖價格凍結。
      const tail = j.data.slice(-2);
      for (const b of tail) {
        const tm = toTime(b.time);
        if (cell.lastT != null && tm < cell.lastT) continue;   // 比已知最後一根舊 → 跳過
        cell.series.update({ time: tm, open: b.open, high: b.high, low: b.low, close: b.close });
        if (cell.lastT != null && tm > cell.lastT) cell.prevC = cell.lastC;   // 換新棒 → 舊收盤變前收
        cell.lastT = tm;
        cell.lastC = b.close;
        if (b.close != null) {   // 線型圖同步（series 給價格軸、linePts 給漸層 primitive）
          try { cell.lineS.update({ time: tm, value: b.close }); } catch (e) {}
          const lp = cell.linePts, last = lp.length ? lp[lp.length - 1] : null;
          if (!last || tm > last.t) lp.push({ t: tm, v: b.close });
          else if (tm === last.t) last.v = b.close;
          cell.byTime?.set(tm, b.close);
          try { cell.lineGrad?.requestUpdate(); } catch (e) {}
        }
      }
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

  /* 直接挑這一格的標的：把全站的搜尋視窗借過來用（ticker.js `_selectSymbol` 的借用模式）。
     ⚠ 不可以自己再做一份搜尋 UI —— 那份有合約/現貨/台股/美股/港股分頁、歷史、鍵盤操作,
       複製一份就等於多一份會走鐘的程式。 */
  function _pickSym(i) {
    if (typeof openSymSearch !== "function") return;
    openSymSearch(sel => {
      const m = _minis[i];
      m.market = sel.market || "crypto";
      m.symbol = sel.symbol;
      // 交易所只有 crypto 用得到（其餘市場後端不看）；沿用這格原本的,沒有就預設
      m.exchange = (m.market === "crypto") ? (m.exchange || "pionex") : "";
      _save();
      _loadMini(i);
    });
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
    if (typeof window._mcApplyView === "function") window._mcApplyView();   // 新建的格子要立刻套上目前的畫法
    _cells.forEach(_buildSubs);
    _syncMiniW();
    _watchLegend();
    requestAnimationFrame(() => requestAnimationFrame(_syncMiniAxis));   // applyOptions 後 LWC 下一幀才重算軸寬
    if (_mode !== 1) {
      _hookMain(); _syncTfFromMain(); _syncReady = Date.now() + 1500;
      /* ⚠ 保護期（1500ms）內主圖還在做開機視角還原（_bootViewHold/_holdAnchorByTime）,
         這段時間載好的格子只對齊到「當下」的範圍,主圖之後還會再動 → 保護期一過補推一次,
         否則畫面上會看到某一格的日期跟其他格不一樣（實測 ETH 那格差了快一個月）。 */
      setTimeout(() => _pushMainRange(), 1700);
      setTimeout(() => _pushMainRange(), 3200);
    }
    if (typeof resizeAll === "function") requestAnimationFrame(() => requestAnimationFrame(resizeAll));
  }

  /* ★ 迷你圖跟著主圖的**畫法**走（使用者：「兩個都要」→「我要全功能同步」）：
     配色、K 棒樣式（實體/邊框/影線）、線型圖、上下顛倒,一次到位。
     由 `charts.js applyChartType()` 呼叫 —— 那是這四件事共同的唯一出口。
     沒有這支的話,改完漲跌色或按下顛倒,格子會留著建立當下那組設定直到重新整理
     （不報錯,只是同一根 K 棒在主圖與格子裡長得不一樣）。 */
  window._mcApplyView = function () {
    if (!_cells.length) return;
    const line = !!window._chartTypeLine;
    const inv  = !!window._chartInverted;
    // 線型時蠟燭全透明（標記仍掛在它身上）；否則用主圖那份唯一出口算好的顏色（已含顛倒對調）
    const opts = line
      ? { upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)", borderVisible: false, wickVisible: false }
      : ((typeof _candleColorOpts === "function") ? _candleColorOpts() : null);
    const C0 = (typeof C !== "undefined") ? C : {};
    _cells.forEach(c => {
      try { c.chart.priceScale("right").applyOptions({ invertScale: inv }); } catch (e) {}
      if (opts) { try { c.series.applyOptions(opts); } catch (e) {} }
      try { c.series.applyOptions({ priceLineColor: C0.curPrice || "#FF9147" }); } catch (e) {}
      try { c.bbU.applyOptions({ color: C0.bbU }); c.bbM.applyOptions({ color: C0.bbM }); c.bbL.applyOptions({ color: C0.bbL }); } catch (e) {}
      try { c.lineS.applyOptions({ visible: line }); } catch (e) {}
      try { _feedMain(c); } catch (e) {}   // 量柱顏色是逐根寫死的 → 換色盤/上下顛倒都要重餵
      _mirrorVis(c);
      _applyMiniMarkers(c);
    });
  };

  /* ══ 每一格的 overlay（可見高低）══════════════════════════════════════════════
     畫布用 DPR 放大（同全站規範：邏輯尺寸 × DPR,再 setTransform）—— 不做的話 2x 螢幕上會糊。 */
  function _ovSize(cell) {
    try {
      const w = cell.body.clientWidth, h = cell.body.clientHeight;
      if (!(w > 0 && h > 0)) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      cell.ov.width = Math.round(w * dpr); cell.ov.height = Math.round(h * dpr);
      cell.ov.style.width = w + "px"; cell.ov.style.height = h + "px";
      cell.ovCtx = cell.ov.getContext("2d");
      cell.ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch (e) {}
  }
  function _ovPaint(cell) {
    if (!cell || !cell.ovCtx) return;
    const W = cell.ov.width / (Math.min(3, window.devicePixelRatio || 1));
    const H = cell.ov.height / (Math.min(3, window.devicePixelRatio || 1));
    if (typeof window._mcDrawOverlay !== "function") return;
    const i = _cells.indexOf(cell), m = (i >= 0) ? _minis[i] : null;
    const symKey = m ? `${m.market}:${m.exchange || "pionex"}:${m.symbol}`.toUpperCase() : "";
    window._mcDrawOverlay({ chart: cell.chart, series: cell.series, ctx: cell.ovCtx, W, H,
                            rows: cell.rows, prec: cell.prec, symKey,
                            tf: m ? m.tf : null, market: m ? m.market : null });
  }
  let _ovRaf = 0;
  function _ovQueue() {                 // 平移中每幀都會進來 → 併到下一幀畫一次就好
    if (_ovRaf) return;
    _ovRaf = requestAnimationFrame(() => { _ovRaf = 0; _cells.forEach(_ovPaint); });
  }
  window._mcPaintOv = _ovQueue;         // draw.js `renderDrawings`（overlay 重畫的共同入口）會呼叫

  /* 主圖那條圖例列（BB/VOL…）在多圖模式會換行 → 高度會變 → 各格的標題列要跟著一起變,
     否則兩邊的 K 棒區又對不齊。用 ResizeObserver 盯著它本人,不去猜什麼時候會變。 */
  let _lgRo = null;
  function _watchLegend() {
    if (_lgRo) return;
    const lg = document.querySelector("#mainPane > .pane-legend");
    if (!lg) return;
    try { _lgRo = new ResizeObserver(() => { _cells.forEach(_sizeSubs); _syncMiniW(); }); _lgRo.observe(lg); } catch (e) {}
  }

  /* ★★ 2026-09-28 使用者：「第二圖後面的時間軸沒出來」。
     未來留白原本是**寫死 150 根** —— 留白是以「根」為單位,一縮小 barSpacing 變小、
     同樣寬的留白就要更多根去填 → 很快用完,那之後「後面」就沒有格線也沒有時間刻度了。
     主圖早就處理過同一件事（`charts.js _growGridAhead`：跟著可見範圍往上長）,這裡照做。
     ⚠ 只加不減：縮回去時不必砍（砍了再縮小又要重鋪,而且 setData 不便宜）。 */
  function _growWs(cell, needT) {
    if (!cell || !cell.wsStep || cell.wsT0 == null) return;
    const have = cell.wsT0 + cell.wsStep * (cell.wsN || 0);
    if (needT == null || needT < have - cell.wsStep * 5) return;
    const add = Math.max(120, Math.ceil((needT - have) / cell.wsStep) + 120);
    const n2 = (cell.wsN || 0) + add;
    if (n2 > 20000) return;                       // 保險絲：不讓它無限長大
    const arr = new Array(n2);
    for (let k = 0; k < n2; k++) arr[k] = { time: cell.wsT0 + cell.wsStep * (k + 1) };
    try { cell.ws.setData(arr); cell.wsN = n2; } catch (e) {}
  }

  /* ★ 2026-09-27 使用者：「往歷史滑不會補」。迷你圖初載只有 320 根 —— 主圖有整套背景補載
     （`_bgLoadOlderBars`,claude.md 記過最多事故的那條路）,格子原本什麼都沒有,
     往回滑就是「K 棒到這裡就沒了」。
     → 這裡做一條**很窄的**補載：只在「可見範圍已經碰到最舊那根」時,往前再要一批同樣長度的,
       接在前面重畫。刻意**不**碰主圖那條路（世代守衛、修剪遮罩、接縫檢查全部原封不動）。
     ⚠ 一次只跑一批（`olderBusy`）；來源真的沒有更舊的就記 `noMoreHist`,不再重問。
     ⚠ 補完要把可見範圍原樣放回去：`setData` 會讓 LWC 重新決定視窗,不放回去畫面會自己跳。
     ⚠ 標記要**就地重濾**不要重打 API：原本的 payload 留在 `cell.mkSrc`,
       K 棒多了之後原本被 `timeSet` 濾掉的那些就補得回來。 */
  const _TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
  const _isoDay = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  async function _loadOlder(cell) {
    if (!cell || cell.olderBusy || cell.noMoreHist || !cell.rows.length) return;
    const i = _cells.indexOf(cell);
    if (i < 0) return;
    const m = _minis[i], step = _TF_SEC[m.tf] || 86400;
    const earliest = toTime(cell.rows[0].time);
    let r = null;
    try { r = cell.chart.timeScale().getVisibleRange(); } catch (e) {}
    if (!r || r.from > earliest + step * 2) return;        // 還沒滑到最舊那根附近 → 不用補
    cell.olderBusy = true;
    const gen = cell.gen;
    try {
      const endTs = earliest - 1, startTs = endTs - step * 400;
      const res = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: m.market, symbol: m.symbol, timeframe: m.tf, exchange: m.exchange || "pionex",
                               start: _isoDay(startTs), end: _isoDay(endTs), limit: 0,
                               indicators: cell.subs.length > 0 }),
      });
      if (gen !== cell.gen || !res.ok) return;
      const j = await res.json();
      if (gen !== cell.gen || !Array.isArray(j.data)) return;
      const older = j.data.filter(b => toTime(b.time) < earliest);
      if (!older.length) { cell.noMoreHist = true; return; }
      const keep = (() => { try { return cell.chart.timeScale().getVisibleRange(); } catch (e) { return null; } })();
      cell.rows = older.concat(cell.rows);
      _feedMain(cell);
      _feedSubs(cell);
      _refilterMarkers(cell);
      if (keep) { try { cell.chart.timeScale().setVisibleRange(keep); } catch (e) {} }
      _syncSubs(cell);
    } catch (e) {} finally { cell.olderBusy = false; }
  }

  /* K 棒／成交量／布林／折線／十字線索引：全部從 `cell.rows` 重建。
     抽成一支是因為「初載」與「往回補歷史」都要做同一件事 —— 分兩份寫,補歷史那條就會漏掉
     成交量或布林,而畫面上只是少一層、不報錯。 */
  function _feedMain(cell) {
    const rows = cell.rows;
    if (!rows || !rows.length) return;
    const R = rows.map(b => ({ time: toTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close }));
    try { cell.series.setData(R); } catch (e) {}
    cell.byTime = new Map(R.map(r => [r.time, r.close]));   // 十字線連動要給價格（見 _crosshairTo）
    // 線型圖的收盤折線（濾掉 null close：LWC 的 Line 會拋「Value is null」）
    cell.linePts = R.filter(r => r.close != null).map(r => ({ t: r.time, v: r.close }));
    try { cell.lineS.setData(cell.linePts.map(p => ({ time: p.t, value: p.v }))); } catch (e) {}
    const C0 = (typeof C !== "undefined") ? C : {};
    try {
      cell.vol.setData(rows.filter(b => Number.isFinite(b.volume)).map(b => ({
        time: toTime(b.time), value: b.volume,
        color: (b.close >= b.open) !== !!window._chartInverted ? (C0.volUp || "#26a69a") : (C0.volDown || "#ef5350"),
      })));
    } catch (e) {}
    const L = k => rows.filter(b => Number.isFinite(b[k])).map(b => ({ time: toTime(b.time), value: b[k] }));
    try { cell.bbU.setData(L("bb_upper")); cell.bbM.setData(L("bb_middle")); cell.bbL.setData(L("bb_lower")); } catch (e) {}
    _ovQueue();
  }

  /* ══ 每一格的副圖（RSI / MACD / KDJ）══════════════════════════════════════════
     使用者：「第二標地沒有附圖」——主圖開著哪幾個副圖,格子就開哪幾個（順序也照主圖：KDJ→RSI→MACD）。
     ⚠ **高度不夠就不開**：4 格模式一格只有約 290px,硬塞三張副圖只剩 100px 畫 K 棒,
       那比沒有更糟 → 以「整格 ≥ 420px、每張副圖至少 90px」當門檻,4 格自然是 0 張、2 格三張都在。
     ⚠ 時間軸只能留在**最下面那一張**（同主圖 `sub`/`subT` 的作法）,否則每張都印一排日期。
     ⚠ 指標資料要另外跟後端要（`indicators: true`）—— 迷你圖原本刻意送 false 省流量
       （守門員之二十七講的就是這件事）,所以只有「真的要畫副圖」時才要。 */
  const SUBS = [
    { key: "kdj",  pane: "kdjPane"  },
    { key: "rsi",  pane: "rsiPane"  },
    { key: "macd", pane: "macdPane" },
  ];
  function _wantSubs() {
    if (_mode === 1) return [];
    return SUBS.filter(d => {
      const el = document.getElementById(d.pane);
      if (!el) return false;
      try {
        if (getComputedStyle(el).display === "none") return false;
        if (el.classList.contains("pane-collapsed")) return false;
        return el.getBoundingClientRect().height > 8;
      } catch (e) { return false; }
    }).map(d => d.key);
  }
  const _SUB_MIN_H = 90, _CELL_MIN_H = 420;
  function _fitSubs(cell) {
    const want = _wantSubs();
    if (!want.length) return [];
    let h = 0;
    try { h = cell.el.getBoundingClientRect().height; } catch (e) {}
    if (h < _CELL_MIN_H) return [];
    // 副圖總高最多吃掉整格的 45%（其餘留給 K 棒）
    const room = Math.floor(h * 0.45);
    return want.slice(0, Math.max(0, Math.floor(room / _SUB_MIN_H)));
  }
  function _killSubs(cell) {
    cell.subs.forEach(s2 => { try { s2.chart.remove(); } catch (e) {} try { s2.el.remove(); } catch (e) {} });
    cell.subs = [];
  }
  function _mkSub(cell, key, last) {
    const el = document.createElement("div");
    el.className = "mini-sub";
    cell.subWrap.appendChild(el);
    const opts = (typeof makeBaseOpts === "function") ? makeBaseOpts({ top: 0.08, bottom: 0.08 }, last) : {};
    const chart = LightweightCharts.createChart(el, opts);
    chart.applyOptions({ handleScroll: true, handleScale: true });
    const C_ = (typeof C !== "undefined") ? C : {};
    const ln = (color, o) => chart.addLineSeries(Object.assign({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, o || {}));
    const S_ = (typeof S !== "undefined") ? S : {};
    /* ★ 參考線（RSI 30/50/70、KDJ 20/50/80）要走主圖**同一支** `_mkHLine`（2026-09-27
       使用者：「附圖 rsi 的 30/50/70 也沒有」）。我第一版自己 `createPriceLine` 掛在 RSI(14)
       那條線上、又把軸標籤關掉 —— 兩個都錯：
       ⚠ 掛在 `rsiLine14` 上的話,使用者從圖例把 RSI(14) 關掉,參考線會**跟著消失**
         （charts.js `_mkHLine` 的註解早就寫著要掛在透明 anchor 上,anchor 永遠不會被關）。
       ⚠ 線色是很暗的 `#4a4a6a`,沒有右側那個數字標籤就幾乎看不見＝使用者說的「沒有」。
       ⚠ anchor **不需要餵資料**（主圖那兩個 anchor 也從來沒有 setData）。 */
    const anchor = chart.addLineSeries({ color: "rgba(0,0,0,0)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const _HL = (price, opts) => (typeof _mkHLine === "function") ? _mkHLine(anchor, price, opts) : null;
    const sub = { key, el, chart, anchor, lines: [] };
    if (key === "rsi") {
      // RSI 數學上必落在 0~100 → 釘死,縮放時 30/50/70 永遠在同一個高度（同主圖）
      sub.main = ln(C_.rsi14 || "#7e57c2", { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      sub.second = ln(C_.rsi7 || "#ef5350");
      const _rhls = S_.rsiHLStyle ?? 1;
      sub.lines = [
        _HL(30, { color: C_.rsiH30, lineWidth: S_.rsiHLWidth, lineStyle: _rhls }),
        _HL(50, { color: C_.rsiH50, lineWidth: S_.rsiHLWidth, lineStyle: _rhls }),
        _HL(70, { color: C_.rsiH70, lineWidth: S_.rsiHLWidth, lineStyle: _rhls }),
      ].filter(Boolean);
      sub.feed = rows => {
        sub.main.setData(rows.filter(d => Number.isFinite(d.rsi_14)).map(d => ({ time: toTime(d.time), value: d.rsi_14 })));
        sub.second.setData(rows.filter(d => Number.isFinite(d.rsi_7)).map(d => ({ time: toTime(d.time), value: d.rsi_7 })));
      };
    } else if (key === "kdj") {
      sub.main = ln(C_.kdjK || "#f23645", { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      sub.second = ln(C_.kdjD || "#1e88e5");
      sub.third = ln(C_.kdjJ || "#ff9800");
      // 20/80 的值使用者可自訂（同 render.js renderKDJ 的 S.kdjH20val / S.kdjH80val）
      const _k20 = Number.isFinite(S_.kdjH20val) ? S_.kdjH20val : 20;
      const _k80 = Number.isFinite(S_.kdjH80val) ? S_.kdjH80val : 80;
      sub.lines = [
        _HL(_k20, { color: C_.kdjH20, lineWidth: S_.kdjHLWidth, lineStyle: 1 }),
        _HL(50,   { color: C_.kdjH50, lineWidth: S_.kdjHLWidth, lineStyle: 1 }),
        _HL(_k80, { color: C_.kdjH80, lineWidth: S_.kdjHLWidth, lineStyle: 1 }),
      ].filter(Boolean);
      sub.feed = rows => {
        const L = k => rows.filter(d => Number.isFinite(d[k])).map(d => ({ time: toTime(d.time), value: d[k] }));
        sub.main.setData(L("kdj_k")); sub.second.setData(L("kdj_d")); sub.third.setData(L("kdj_j"));
      };
    } else {
      sub.main = ln(C_.macd || "#2196f3");
      sub.second = ln(C_.macdSig || "#ff9800");
      sub.hist = chart.addHistogramSeries({ priceScaleId: "right", priceLineVisible: false, lastValueVisible: false });
      sub.feed = rows => {
        sub.main.setData(rows.filter(d => Number.isFinite(d.macd)).map(d => ({ time: toTime(d.time), value: d.macd })));
        sub.second.setData(rows.filter(d => Number.isFinite(d.macd_signal)).map(d => ({ time: toTime(d.time), value: d.macd_signal })));
        const up = (C_.up || "#26a69a") + "cc", dn = (C_.down || "#ef5350") + "cc";
        sub.hist.setData(rows.filter(d => Number.isFinite(d.macd_hist)).map(d => ({
          time: toTime(d.time), value: d.macd_hist, color: d.macd_hist >= 0 ? up : dn })));
      };
    }
    return sub;
  }
  function _buildSubs(cell) {
    const fit = _fitSubs(cell);
    const cur = cell.subs.map(x => x.key).join(",");
    if (cur !== fit.join(",")) {
      _killSubs(cell);
      fit.forEach((k, i) => cell.subs.push(_mkSub(cell, k, i === fit.length - 1)));
      // 有副圖時,K 棒那張就不要再畫時間軸（只留最下面那張）
      try { cell.chart.applyOptions({ timeScale: { visible: fit.length === 0 } }); } catch (e) {}
    }
    /* ⚠ 副圖是「後來才打開」的話,手上這份資料是當初用 `indicators:false` 抓的（沒有指標欄）
       → 要重抓一次,否則副圖是空的而且**完全不報錯**（三條線都沒有資料,看起來就像沒訊號）。 */
    if (cell.subs.length && !_hasInd(cell.rows)) {
      const i = _cells.indexOf(cell);
      if (i >= 0) _loadMini(i);
      return;
    }
    /* ⚠⚠ 餵資料**不可以只寫在「數量改變」那條分支裡**（2026-09-27 使用者：「一樣沒有附圖」）：
       副圖本來就開著時,流程是「建好副圖 → 重抓帶指標的資料 → 再進來一次」,而第二次進來
       數量沒變 → 舊版直接跳過餵資料 ＝ 三張副圖都在、**一條線也沒有,零錯誤**。
       我自己的測試剛好在中間多關了一個指標（觸發重建）才看起來正常 —— 典型的「測試路徑
       比使用者路徑多做了一步」。現在一律重餵：setData 是冪等的,重覆餵沒有副作用。 */
    _feedSubs(cell);
    _mirrorVis(cell);
    _sizeSubs(cell);
    _syncSubs(cell);
  }
  /* ★★ 2026-09-27 使用者：「我布林沒開」→「你要根據我有開什麼做決定」。
     格子原本是**無條件**把布林/成交量畫上去 —— 使用者在圖例上關掉的東西,格子照樣顯示。
     → 一律**鏡射主圖那條 series 自己的 `visible`**,不是去讀 localStorage、也不是看圖例的 class：
       問 series 本人最準（圖例點擊、開機還原偏好、程式呼叫,最後都落到同一個 `visible`）。
     ⚠ 對應表要涵蓋**每一條**線：漏一條就是那一條永遠跟主圖不同步,而且畫面上看起來很合理。
     ⚠ 主圖那條 series 還沒建立（副圖收著時 kdjK 等是 undefined）→ 跳過,不要當成「隱藏」。 */
  /* 把主圖那條 series 的樣式**整組**複製過來：顯示與否、顏色、線寬、線型。
     ⚠ 2026-09-27 使用者：「rsi 線看起來不一樣 應該是沒套上我的設定」—— 我第一版建立時
       寫死 `lineWidth: 1`、也沒給 `lineStyle`,所以使用者在指標設定裡調的線寬/線型全沒跟到。
       **不要自己從 `S.rsi14Width` 那些再推導一次**：那等於第二份真相（主圖以後多一個設定,
       這邊就會安靜地少一個）。直接問主圖那條線它現在長什麼樣。 */
  const _STYLE_KEYS = ["visible", "color", "lineWidth", "lineStyle"];
  function _visOf(s2) { try { return s2 ? s2.options().visible !== false : null; } catch (e) { return null; } }
  function _cpStyle(src, dst) {
    if (!src || !dst) return;
    try {
      const o = src.options(), out = {};
      for (const k of _STYLE_KEYS) if (o[k] !== undefined) out[k] = o[k];
      dst.applyOptions(out);
    } catch (e) {}
  }
  function _cpHLine(src, dst) {     // 參考線（_mkHLine 的薄殼）：多帶 price 與 axisLabel
    if (!src || !dst) return;
    try {
      const o = src.options(), out = {};
      for (const k of _STYLE_KEYS.concat(["price", "axisLabel"])) if (o[k] !== undefined) out[k] = o[k];
      dst.applyOptions(out);
    } catch (e) {}
  }
  /* ⚠⚠ 主圖那些 series 是 **bundle 頂層的 `let`**（不在 `window` 上）→ 取用只能**直接寫識別字**
     ＋`typeof` 守衛。我第一版用 `eval("typeof X !== 'undefined' ? X : null")` 想省事,
     實測在打包後的 bundle 裡**一律回 null**（`_G("bbU")=null`）→ 整個鏡射靜默失效,
     使用者看到的就是「布林通道又出現」。直接寫比較囉嗦,但它是唯一可靠的。 */
  const _M = {
    bbU:  () => (typeof bbU  !== "undefined") ? bbU  : null,
    bbM:  () => (typeof bbM  !== "undefined") ? bbM  : null,
    bbL:  () => (typeof bbL  !== "undefined") ? bbL  : null,
    vol:  () => (typeof volSeries !== "undefined") ? volSeries : null,
    kdjK: () => (typeof kdjK !== "undefined") ? kdjK : null,
    kdjD: () => (typeof kdjD !== "undefined") ? kdjD : null,
    kdjJ: () => (typeof kdjJ !== "undefined") ? kdjJ : null,
    kdjH20: () => (typeof kdjH20 !== "undefined") ? kdjH20 : null,
    kdjH50: () => (typeof kdjH50 !== "undefined") ? kdjH50 : null,
    kdjH80: () => (typeof kdjH80 !== "undefined") ? kdjH80 : null,
    rsi14: () => (typeof rsiLine14 !== "undefined") ? rsiLine14 : null,
    rsi7:  () => (typeof rsiLine7  !== "undefined") ? rsiLine7  : null,
    rsiH30: () => (typeof rsiH30 !== "undefined") ? rsiH30 : null,
    rsiH50: () => (typeof rsiH50 !== "undefined") ? rsiH50 : null,
    rsiH70: () => (typeof rsiH70 !== "undefined") ? rsiH70 : null,
    macd:   () => (typeof macdLine   !== "undefined") ? macdLine   : null,
    macdSig:() => (typeof macdSignal !== "undefined") ? macdSignal : null,
    macdHist:() => (typeof macdHist  !== "undefined") ? macdHist   : null,
  };
  function _mirrorVis(cell) {
    _cpStyle(_M.bbU(), cell.bbU); _cpStyle(_M.bbM(), cell.bbM); _cpStyle(_M.bbL(), cell.bbL);
    // 成交量是 Histogram（沒有 lineWidth/lineStyle）→ 只有顯示與否要跟
    try { const v = _visOf(_M.vol()); if (v != null) cell.vol.applyOptions({ visible: v }); } catch (e) {}
    cell.subs.forEach(x => {
      const L = x.lines || [];
      if (x.key === "kdj") {
        _cpStyle(_M.kdjK(), x.main); _cpStyle(_M.kdjD(), x.second); _cpStyle(_M.kdjJ(), x.third);
        _cpHLine(_M.kdjH20(), L[0]); _cpHLine(_M.kdjH50(), L[1]); _cpHLine(_M.kdjH80(), L[2]);
      } else if (x.key === "rsi") {
        _cpStyle(_M.rsi14(), x.main); _cpStyle(_M.rsi7(), x.second);
        _cpHLine(_M.rsiH30(), L[0]); _cpHLine(_M.rsiH50(), L[1]); _cpHLine(_M.rsiH70(), L[2]);
      } else {
        _cpStyle(_M.macd(), x.main); _cpStyle(_M.macdSig(), x.second);
        try { const v = _visOf(_M.macdHist()); if (v != null) x.hist.applyOptions({ visible: v }); } catch (e) {}
      }
    });
  }

  const _hasInd = rows => Array.isArray(rows) && rows.some(d => d && (d.rsi_14 != null || d.kdj_k != null || d.macd != null));
  function _feedSubs(cell) {
    if (!cell.subs.length || !_hasInd(cell.rows)) return;
    /* ★★ anchor **一定要餵全長資料**（2026-09-27 使用者：「附圖 rsi 的 30/50/70 也沒有」）。
       LWC **不會**在「沒有資料的 series」上畫 price line —— 參考線就這樣安靜地不見了
       （A/B 實測：掛在有資料那條線上的畫得出來、掛在空 anchor 的畫不出來,兩邊都不報錯）。
       主圖早就在做這件事（`render.js _renderSubcharts`：`rsiAnchor.setData(anchorTimes)`），
       我照抄了「掛在 anchor 上」卻漏了「餵 anchor」。值本身無所謂（同主圖：50 / MACD 用 0）,
       它只是讓那條 series 存在於價格軸上。 */
    const rows = cell.rows.filter(b => b && Number.isFinite(toTime(b.time)));
    cell.subs.forEach(x => {
      try { if (x.anchor) x.anchor.setData(rows.map(b => ({ time: toTime(b.time), value: x.key === "macd" ? 0 : 50 }))); } catch (e) {}
      try { x.feed(cell.rows); } catch (e) {}
    });
  }
  /* ★ 2026-09-27 使用者：「兩者價格高度不一」。
     2 格模式的迷你圖欄與 `.charts-container` 是**同高的兄弟** → 只要把「標題列」與「每張副圖」
     的高度設成主圖那邊對應區塊的**實際像素**,剩下給 K 棒的高度就必然等於主圖的 `#mainPane`
     （相減的結果,不是估的）。
     ⚠ 副圖高度要從「上一塊的底緣」量到「這一塊的底緣」—— 這樣**自動含進中間那條 pane-divider**,
       不必去找 divider 是掛在前面還是後面（實測它排在自己那格後面,靠猜一定會差幾 px）。
     ⚠ 量不到（主圖沒開副圖／4 格模式）就退回原本的比例算法。 */
  function _sizeSubs(cell) {
    let mirrored = false;
    if (_mode === 2 && cell.subs.length) {
      try {
        const cont = document.getElementById("chartsContainer");
        const mp = document.getElementById("mainPane");
        const cr = cont && cont.getBoundingClientRect(), mr = mp && mp.getBoundingClientRect();
        if (cr && mr && mr.height > 20) {
          /* 標題列高度＝主圖圖例列（BB/VOL 那行）的**實際**高度。
             兩邊都是「一條在版面流裡的列 ＋ 底下的圖」→ 相減之後 K 棒區必然等高,
             而且圖例換成兩行時格子會自己跟上（見 `_watchLegend`）。 */
          const lg = document.querySelector("#mainPane > .pane-legend");
          const lh = lg ? Math.round(lg.getBoundingClientRect().height) : 0;
          const hd = cell.el.querySelector(".mini-head");
          if (hd && lh > 0) { hd.style.flex = "0 0 " + lh + "px"; hd.style.height = lh + "px"; }
          let prevBottom = mr.bottom;
          cell.subs.forEach(x => {
            const def = SUBS.find(d => d.key === x.key);
            const pane = def && document.getElementById(def.pane);
            const pr = pane && pane.getBoundingClientRect();
            if (!pr || pr.height < 8) return;
            x.el.style.height = Math.max(8, Math.round(pr.bottom - prevBottom)) + "px";
            prevBottom = pr.bottom;
          });
          mirrored = true;
        }
      } catch (e) { mirrored = false; }
    }
    if (!mirrored) {
      const hd = cell.el.querySelector(".mini-head");
      if (hd) { hd.style.flex = ""; hd.style.height = ""; }
      if (cell.subs.length) {
        let h = 0;
        try { h = cell.el.getBoundingClientRect().height; } catch (e) {}
        const each = Math.max(_SUB_MIN_H, Math.floor(h * 0.45 / cell.subs.length));
        cell.subs.forEach(x => { x.el.style.height = each + "px"; });
      }
    }
    cell.subs.forEach(x => { try { x.chart.resize(x.el.clientWidth, x.el.clientHeight); } catch (e) {} });
    try { cell.chart.resize(cell.body.clientWidth, cell.body.clientHeight); } catch (e) {}
  }
  /* 副圖跟著自己那一格的 K 棒圖：**同一格寬度相同、K 棒時間也相同** →
     直接複製 barSpacing 與 scrollPosition 就是逐像素對齊,不必再做時間換算。 */
  function _syncSubs(cell) {
    if (!cell.subs.length) return;
    try {
      const ts = cell.chart.timeScale();
      const bs = ts.options().barSpacing, sp = ts.scrollPosition();
      cell.subs.forEach(x => {
        try { x.chart.timeScale().applyOptions({ barSpacing: bs }); x.chart.timeScale().scrollToPosition(sp, false); } catch (e) {}
      });
    } catch (e) {}
  }
  /* 主圖開/關副圖時重建各格的副圖（`ui.js _afterPaneToggle` 是那件事的唯一出口） */
  window._mcSyncSubs = function () { _cells.forEach(_buildSubs); };

  /* ★ 價格軸等寬（2 格模式）：面板對半分之後,兩邊的**繪圖區**還差一個價格軸的寬度
     （實測主圖軸 70 / 迷你圖軸 56 → 繪圖區差 14px ＝ K 棒還是差 2%）。
     作法與 `charts.js _syncAxisWidth()` 完全相同：取最寬的那個,用 `minimumWidth` 套給兩邊。
     ⚠ 量軸寬只能問 `priceScale("right").width()` —— `timeScale().width()` 對主圖回 0（見該處註解）。
     ⚠ 4 格不做：那時本來就不是對照用的等寬版面,硬拉軸寬只會吃掉小圖的空間。 */
  /* 把迷你圖欄的寬度量給 CSS：主圖那條 BB/VOL 圖例列要能延伸到它上方（見 style.css 的說明）。
     ⚠ 量的是**實際寬度**不是猜的百分比 —— 2 格與 4 格的欄寬不同,視窗一縮又是另一個值。 */
  function _syncMiniW() {
    try {
      const mg = document.getElementById("miniGrid");
      const w = (_mode !== 1 && mg) ? Math.round(mg.getBoundingClientRect().width) : 0;
      document.documentElement.style.setProperty("--mc-mini-w", w + "px");
      /* 標題列右內距＝那一格的價格軸寬度（2026-09-27 使用者：「標的名稱就要靠左一些 配合那一行」）。
         原本名稱那組貼著欄位最右 → 有一半壓在價格軸上方,與左邊那條 BB/VOL 行讀起來是斷開的。
         改成收到**K 棒區的右緣**（價格軸左邊）,跟主圖圖例落在同一個繪圖區裡。
         ⚠ 量實際軸寬不可寫死：換低價幣（0.00001234）軸會變寬,寫死就又對不上。 */
      let ax = 0;
      try { if (_cells[0]) ax = Math.round(_cells[0].chart.priceScale("right").width() || 0); } catch (e) {}
      document.documentElement.style.setProperty("--mc-axis-w", (ax > 0 ? ax : 0) + "px");
      // 主圖那層底墊（#chartUnderlay）原本只蓋 .charts-container → 多圖時要延伸到迷你圖欄,
      // 否則那半邊的天氣疊在系統底色上,composite 出來與主圖不同色（見 colors.js 的說明）。
      if (typeof window._chartUnderlayPos === "function") window._chartUnderlayPos();
      // 圖例列的實際高度給 CSS：兩欄之間的分隔線要從它底下才開始畫（見 style.css 的說明）
      const lg = document.querySelector("#mainPane > .pane-legend");
      if (lg) document.documentElement.style.setProperty("--mc-legend-h", Math.round(lg.getBoundingClientRect().height) + "px");
    } catch (e) {}
  }

  function _syncMiniAxis() {
    _syncMiniW();
    if (_mode !== 2 || !_cells.length || typeof mainChart === "undefined" || !mainChart) return;
    try {
      const list = [mainChart, _cells[0].chart, ..._cells[0].subs.map(x => x.chart)];
      const w = list.map(c => { try { return c.priceScale("right").width() || 0; } catch (e) { return 0; } });
      const want = Math.max(...w);
      if (!want) return;
      list.forEach((c, i) => { if (w[i] !== want) { try { c.priceScale("right").applyOptions({ minimumWidth: want }); } catch (e) {} } });
    } catch (e) {}
  }

  /* 唯讀：格子各層的顯示狀態（給驗證/除錯用；同 `_mcRanges` 的理由——chart 在 IIFE 裡） */
  window._mcVis = function () {
    const c = _cells[0];
    if (!c) return null;
    const v = s2 => { try { return s2 ? s2.options().visible : null; } catch (e) { return null; } };
    const sub = k => c.subs.find(x => x.key === k);
    return { bb: v(c.bbU), vol: v(c.vol), curLine: v(c.series),
             hl: c.subs.map(x => ({ key: x.key, n: (x.lines || []).length })),
             hlStyle: (() => {
               const r = c.subs.find(x => x.key === "rsi"); if (!r) return null;
               const k = o => o ? { color: o.color, lineWidth: o.lineWidth, lineStyle: o.lineStyle } : null;
               return { r14: k(r.main && r.main.options()), r7: k(r.second && r.second.options()),
                        h30: k(r.lines && r.lines[0] && r.lines[0].options()) };
             })(),
             kdjK: v(sub("kdj") && sub("kdj").main), rsi14: v(sub("rsi") && sub("rsi").main),
             macd: v(sub("macd") && sub("macd").main) };
  };

  /* 唯讀：各張圖目前的可視時間範圍（主圖 + 各格）。給守門員/除錯用 ——
     迷你圖的 chart 物件包在這個 IIFE 裡,外面讀不到,沒有這支就只能靠截圖猜。 */
  window._mcRanges = function () {
    const rd = ch => { try { const r = ch.timeScale().getVisibleRange(); return r ? { from: r.from, to: r.to } : null; } catch (e) { return null; } };
    return { mode: _mode,
             main: (typeof mainChart !== "undefined" && mainChart) ? rd(mainChart) : null,
             minis: _cells.map(c => rd(c.chart)),
             xh: _cells.map(c => c.xhT ?? null),
             up: _cells.map(c => { try { return c.series.options().upColor; } catch (e) { return null; } }),
             inv: _cells.map(c => { try { return !!c.chart.priceScale("right").options().invertScale; } catch (e) { return null; } }),
             line: _cells.map(c => { try { return !!c.lineS.options().visible; } catch (e) { return null; } }),
             mk: _cells.map(c => c.series.markers().length),
             prec: _cells[0] ? (() => { try { return _cells[0].series.options().priceFormat.precision; } catch (e) { return -1; } })() : -1,
             lastC: _cells[0] ? _cells[0].lastC : null,
             rows: _cells[0] ? _cells[0].rows.length : 0,
             earliest: (_cells[0] && _cells[0].rows.length) ? toTime(_cells[0].rows[0].time) : null,
             fvg: _cells[0] ? _cells[0].fvg.length : 0,
             vol: _cells[0] ? (() => { try { return _cells[0].vol.data().length; } catch (e) { return -1; } })() : 0,
             bb: _cells[0] ? (() => { try { return _cells[0].bbU.data().length; } catch (e) { return -1; } })() : 0,
             bs: _cells.map(c => { try { return +c.chart.timeScale().options().barSpacing.toFixed(2); } catch (e) { return null; } }),
             ax: _cells.map(c => { try { return Math.round(c.chart.priceScale("right").width()); } catch (e) { return null; } }),
             mkPos: _cells.map(c => { try { const m = c.series.markers(); return m.length ? m[0].position + "/" + m[0].shape : null; } catch (e) { return null; } }),
             tfs: { main: (typeof currentTF !== "undefined") ? currentTF : null, minis: _minis.slice(0, _cells.length).map(m => m.tf) } };
  };

  window._cycleLayout = function () {
    _mode = _mode === 1 ? 2 : (_mode === 2 ? 4 : 1);
    _save();
    _applyMode();
    return _mode;
  };

  /* 主圖換時框 → 各格跟上（延遲一拍等 currentTF 更新完） */
  /* ⚠⚠ 切時框之後**一定要主動補推一次**（2026-09-27 抓到）：保護期（1200ms）內 `_onRange`
     會忽略所有事件,而保護期過後**主圖不一定還會再動** → 沒有任何事件把新範圍推給格子,
     兩邊就一直停在不同的窗口（實測主圖 9/25~9/28、格子 9/16~9/25,而且 K 棒寬度也不同）。
     ⚠ 要補兩次：格子換時框是重新抓資料,到貨時間不一定在第一次補推之前。 */
  function _watchMainTf() {
    document.querySelectorAll(".tf-btn").forEach(b =>
      b.addEventListener("click", () => {
        if (_mode === 1) return;
        setTimeout(() => { _syncTfFromMain(); _syncReady = Date.now() + 1200; }, 120);
        setTimeout(_pushMainRange, 1500);
        setTimeout(_pushMainRange, 3000);
      }));
  }

  function _init() {
    if (typeof isMobileUI === "function" && isMobileUI()) return;   // 手機不啟用（按鈕亦由 CSS 藏）
    const cc = document.getElementById("chartsContainer");
    if (!cc || !cc.parentElement) return;
    _grid = document.createElement("div");
    _grid.id = "miniGrid";
    cc.parentElement.insertBefore(_grid, cc.nextSibling);   // .body-layout(flex row)內、主圖右側
    _applyMode();
    _watchMainTf();
    // 每 5s 更新尾巴（背景分頁暫停＝省電規範；錯開避免同秒齊發）
    setInterval(() => {
      if (document.hidden || !_cells.length) return;
      _cells.forEach((c, i) => setTimeout(() => _tickMini(i), i * 400));
    }, 5000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(_init, 800));
  else setTimeout(_init, 800);
})();
