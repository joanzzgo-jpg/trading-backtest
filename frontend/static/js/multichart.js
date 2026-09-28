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
      /* ★ 2026-09-28 使用者：「第二圖現價要蓋在所有數值上」「而且設計跟主圖不同需要修」。
         原生的最後價標籤只是一塊純色方塊,與主圖那顆（自訂 DOM、毛玻璃、圓角、等寬數字）
         長得不一樣,而且 LWC 底下的灰色刻度照畫 → 兩個數字疊在一起
         （實測橘色「2688.83」上緣透出灰色「2700.00」）。
         → 關掉原生標籤,改用**與主圖同一個 class** 的 `.current-price-label`,
           並把它蓋住的那格刻度消掉（同 `charts.js _axisTickText` 的作法）。 */
      priceLineVisible: true, lastValueVisible: false,
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
    /* 貫穿整格（K 棒區＋各副圖）的自訂鉛直線,同主圖的 `.pane-vline`（見 style.css 的說明）。
       原生鉛直線與時間標籤一律關掉,否則會變成「每張圖各畫一段、交界處斷開」。 */
    const vline = document.createElement("div");
    vline.className = "mini-vline";
    el.appendChild(vline);
    const pxLbl = document.createElement("div");      // 現價標籤：與主圖同一個 class ⇒ 設計一致
    pxLbl.className = "current-price-label";
    body.appendChild(pxLbl);
    chart.applyOptions({ crosshair: { vertLine: { visible: false, labelVisible: false } } });
    const ro = new ResizeObserver(() => { _geomBump(); try { chart.resize(body.clientWidth, body.clientHeight); } catch (e) {} _ovSize(cell); _ovPaint(cell); });
    ro.observe(body);
    /* ⚠ **不可以在 formatter 裡呼叫 `priceToCoordinate`**（渲染中再進渲染）→
         「要蓋掉的價格區間」先在 `_curLabel` 算好,formatter 只做數字比較。
       ⚠ 沒被蓋到的刻度要**維持原本格式**：用這一格自己的小數位走 `toFixed`,
         加千分位的話整排刻度都會跟著變（一眼看得出來）。 */
    chart.applyOptions({ localization: { priceFormatter: v => {
      const b = cell.axisBand;
      if (b && v > b[0] && v < b[1]) return "";
      let pr = cell.prec;
      if (!(pr >= 0)) { try { pr = series.options().priceFormat.precision; } catch (e) { pr = 2; } }
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(pr) : String(v);
    } } });
    const cell = { el, chart, series, ws, lineS, vol, bbU, bbM, bbL, ov, vline, pxLbl, fvg: [], mkSrc: null, body, drv: null, spOff: null, spCmd: null, subWrap: el.querySelector(".mini-subs"), subs: [], rows: [], linePts: [], mkRaw: [], symEl: el.querySelector(".mini-sym"), tfEl: el.querySelector(".mini-tf"), pxEl: el.querySelector(".mini-px"), ro, gen: 0, lastC: null, prevC: null };
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
    /* 碰到 K 棒區 → 驅動權交還給它（同 `_mkSub` 裡那段,以及主圖 charts.js 的 `_syncDriver`）。
       少了這半邊,使用者在副圖上滾過一次之後,副圖就永遠是驅動者。
       ⚠ 掛在 cell 建立**之後**並直接抓它本人：用 `_cells[i]` 的話,格數變動重排時索引會指到別格。 */
    ["pointerdown", "wheel", "touchstart"].forEach(ev =>
      body.addEventListener(ev, () => { cell.drv = null; }, { passive: true, capture: true }));
    _ovSize(cell);
    // 這一格自己被平移/縮放時也要重畫 overlay（主圖那邊由 renderDrawings 的共同入口帶動）
    /* ⚠ 這個事件在縮放時一秒會丟幾十個,而下面每一項都要量版面
       （`_placeVline` 三次 getBoundingClientRect、`_curLabel` 兩次座標換算）
       → 全部併到 `_ovQueue` 那一幀做一次（同樣的理由見 `_onRange` 的說明）。 */
    chart.timeScale().subscribeVisibleTimeRangeChange(r => {
      if (r) _growWs(cell, r.to);
      _ovQueue();
    });
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
  const _cellOf = ch => _cells.find(c => c && c.chart === ch) || null;

  function _charts() {
    const out = [];
    if (typeof mainChart !== "undefined" && mainChart) out.push(mainChart);
    _cells.forEach(c => { if (c && c.chart) out.push(c.chart); });
    return out;
  }
  /* 某一張圖的繪圖區寬度（＝面板寬 − 價格軸寬）。
     ⚠ 不可以用 `timeScale().width()`：實測它對主圖回 0（claude.md 記過）。 */
  /* ⚠ 繪圖區寬度要**快取**（2026-09-28 使用者：「縮放會卡卡的,縮放圖 a 圖 b 會頓頓的」）：
     `clientWidth` 會強制版面重算,而縮放時每秒幾十個事件 × 每張圖各問一次 → 一直在重排。
     版面真的變了（resize／切模式／軸寬重對）時把 `_geomDirty` 打開重量即可。 */
  let _geomDirty = true, _geomGen = 1;
  const _plotWCache = new Map();
  const _geomBump = () => { _geomDirty = true; _geomGen++; };
  function _plotW(chart, el) {
    const c = _plotWCache.get(chart);
    if (c && c.gen === _geomGen) return c.v;
    try {
      const w = (el ? el.clientWidth : 0) - (chart.priceScale("right").width() || 0);
      const out = w > 1 ? w : 0;
      _plotWCache.set(chart, { gen: _geomGen, v: out });
      return out;
    } catch (e) { return 0; }
  }
  /* 這一格的版面幾何（K 棒區相對整格的位置、加上副圖之後的總高）。
     ⚠ 縮放時 `_placeVline` 每幀都要用它 —— 不快取的話一幀三次 `getBoundingClientRect`
       ＝**強制版面重算**（實測縮放 3 秒叫了 597 次,是全站最大的一個來源）。
       版面真的變了（resize／切模式／軸寬重對）才重量。 */
  function _geom(cell) {
    if (cell._g && cell._g.gen === _geomGen) return cell._g;
    try {
      const cr = cell.el.getBoundingClientRect();
      const br = cell.body.getBoundingClientRect();
      const last = cell.subs.length ? cell.subs[cell.subs.length - 1].el.getBoundingClientRect() : br;
      cell._g = { gen: _geomGen, left: br.left - cr.left, top: br.top - cr.top, height: last.bottom - br.top };
    } catch (e) { cell._g = null; }
    return cell._g;
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
    let sx = null, sSp = 0;
    try { sx = sTs.timeToCoordinate(r.to); } catch (e) {}
    try { sSp = sTs.scrollPosition(); } catch (e) {}
    /* ★★ 2026-09-28 使用者：「切換成四格圖時 那三小格 時間上幫我對齊」。
       兩種模式要的東西不一樣,而且**在寬度不同的面板上不可能同時成立**（那是除法）：
       ・**2 格＝對照用** → 兩邊等寬（style.css 的 flex 對分）＋ 同樣大小的 K 棒
         （使用者 2026-09-27 明確要求過「只有兩個時 幫我做成同大小」）。
       ・**4 格＝掃一眼** → 右側三格比主圖窄,若維持同樣的 K 棒大小,看到的歷史就比較短
         （實測主圖 119 天、格子只有 82~83 天）→ 這裡要的是**同一段時間**,
         K 棒自然小一點。
       所以 4 格走 `setVisibleRange`（時間對齊）,2 格走「barSpacing ＋ 右緣」（大小對齊）。 */
    const _byTime = (_mode === 4);
    for (const ch of _charts()) {
      if (ch === src) continue;
      _markEcho(ch);                          // 接下來這張圖丟出來的事件是我們造成的
      const ts = ch.timeScale();
      let done = false;
      if (_byTime) { try { ts.setVisibleRange({ from: r.from, to: r.to }); done = true; } catch (e) {} }
      if (done) continue;
      try {
        if (Math.abs((ts.options().barSpacing || 0) - bs) > 1e-6) ts.applyOptions({ barSpacing: bs });
        /* ★★ 2026-09-28 使用者：「b 標的有順很多但會有不明抖動」的**第二層**根因。
           原本每一幀都用 `timeToCoordinate` 重算對齊量 —— 而那支函式在剛寫入之後回的是舊排版,
           實測修正量 `dpx` 大多是 −9/−10px（剛好一幀的位移）,但**每 4~5 幀就出現 −18/−19（兩倍）**
           ＝ 前一幀的修正沒生效、下一幀補兩份 → 畫面上就是「停一下、跳一下」。
           → 動態期間改成**純量算術**：`scrollPosition` 是「距資料右緣幾根 K 棒」,是連續值、
             不經過座標換算 → 沒有陳舊問題、也沒有像素四捨五入。
             兩張圖的最後一根不一定同時（跨市場）→ 用一個**固定差** `cell.spOff` 吸收,
             那個差只在**停手時**用座標法校正一次（見 `_runSync` 的收尾）。
           ★ 這正是格子的副圖一直以來逐像素精確的作法（`_syncSubs` 就是複製 barSpacing+scrollPosition）
             —— 同一個問題,用同一個已經證明可行的機制,不要再自創第二套。 */
        const _c = _cellOf(ch);
        if (_c && _c.spOff != null) {
          const want2 = sSp + _c.spOff;
          /* ⚠⚠ **比對「上次下達的目標」,不要比對 `scrollPosition()` 讀回的值**：
             `scrollToPosition()` 的效果要**下一幀**才反映在 `scrollPosition()` 上
             （跟 `timeToCoordinate` 同一個性質 —— 這份檔案裡我已經為這件事付過兩次學費）。
             拿讀回值比對的話,同一幀內會對同一個目標重複寫入（實測一幀寫兩次：事件一次、逐幀跟一次）。 */
          if (_c.spCmd == null || Math.abs(_c.spCmd - want2) > 1e-4) {
            _c.spCmd = want2;
            ts.scrollToPosition(want2, false);
          }
          continue;
        }
        const w = _plotW(ch, _elOf(ch));
        if (sx != null && w && sw) {
          const want = w - (sw - sx);          // 來源右緣那根距離右邊界 (sw - sx) px → 對方也要一樣
          /* ⚠⚠ **只能算一趟**：`scrollToPosition()` 之後**立刻讀 `timeToCoordinate` 是舊排版** →
             第二趟會把同一個修正再套一次＝過頭,下一個事件又修回來。
             實測寫入前/寫入後讀到的殘差完全相同（都是 8px,n=53）就是證據。
             ⚠ 這條路現在**只在「還沒校正過固定差」時才走**（校正完就換上面那條純量路徑）。 */
          const x = ts.timeToCoordinate(r.to);
          if (x != null) {
            const dpx = x - want;
            const cur = ts.scrollPosition() || 0;
            const nsp = (Math.abs(dpx) >= 0.5) ? cur + dpx / bs : cur;
            if (Math.abs(dpx) >= 0.5) ts.scrollToPosition(nsp, false);
            /* ⚠⚠ 固定差要用**我們下達的值** `nsp`,不可以寫完再讀一次 `scrollPosition()` ——
               那個讀回值要下一幀才更新（同上）,拿它算會把固定差整整算錯一個修正量。 */
            const _cc = _cellOf(ch);
            if (_cc) { _cc.spOff = nsp - sSp; _cc.spCmd = nsp; }
            done = true;
          }
        }
      } catch (e) {}
      if (!done) { try { ts.setVisibleRange({ from: r.from, to: r.to }); } catch (e) {} }
    }
    _cells.forEach(c => {
      try { const vr = c.chart.timeScale().getVisibleRange(); if (vr) _growWs(c, vr.to); } catch (e) {}
      _syncSubs(c); _loadOlder(c);
    });
  }

  /* ★ 同步**併到下一幀做一次**（2026-09-28 使用者：「在縮放圖 a 圖 b 會頓頓的縮放」）。
     原本每收到一個 `VisibleTimeRangeChange` 就同步一次 —— 滾輪縮放一秒會丟幾十個,
     每個都跑一整套（量寬度 → applyOptions(barSpacing) → scrollToPosition → 重放鉛直線
     → 重算現價標籤 → 重畫 overlay）→ 對方看起來就是一頓一頓地跟。
     併幀之後：一幀最多同步一次,而且用的是**最後一個**事件的範圍（中間那些本來就會被蓋掉）。
     ⚠ 旗標仍要有：`scrollToPosition` 會讓對方也丟事件,沒有旗標會互推。 */
  let _settleT = null, _lastSrc = null;
  /* ★★ 2026-09-28 使用者：「第二圖還是頓頓」。
     原本的防迴圈是一個**全域旗標**,而且在同步完成後「下一拍」(setTimeout 0) 才解除 →
     這段期間**主圖丟出的事件會被整個丟掉**,格子就少走一步。
     → 改成**逐張圖的回音抑制**：只忽略「我們剛剛寫進去那幾張」在極短時間內丟回來的事件,
       使用者真正在操作的那一張（主圖）**永遠不會被忽略**,每個事件都即時處理。
     ⚠ 視窗要短（100ms）：太長的話使用者中途改拖格子會有一段沒反應。

     ⚠⚠⚠ **這一輪最重要的教訓：我連續四個版本都量錯。**
     我用來判斷「格子落後主圖幾像素」的探針,是拿 `timeToCoordinate` 去問格子「同一個時間在哪」——
     而上面那段剛寫過：**`scrollToPosition` 之後讀它拿到的是舊值**。
     等於拿同一條有延遲的路去量延遲 → 那個數字量到的是 `timeToCoordinate` 的陳舊度,
     不是畫面上的落後。症狀：rAF 併幀／同步化／回音抑制／單趟修正／逐幀跟,**五種實作
     p90 全是 8px、150 幀中 47 幀 >2px,一個數字都沒動過**。
     ★ 通則（同 claude.md 那幾條「判準不可以自己測自己」）：**四個版本量出一模一樣的數字時,
       先懷疑探針,不要再往下改產品。** 真要量這個只能讀**畫出來的像素**,不能問圖表的座標函式。 */
  const _echo = new Map();
  const _ECHO_MS = 100;
  const _markEcho = ch => _echo.set(ch, performance.now());
  const _isEcho = ch => { const t = _echo.get(ch); return t != null && (performance.now() - t) < _ECHO_MS; };

  function _runSync(src) {
    if (!src || _mode === 1) return;
    _syncing = true;
    try { _syncFrom(src); }
    finally { _syncing = false; }
    /* ⚠⚠ **收尾的那一發不可以省**（2026-09-28 4 格實測抓到）：防迴圈旗標開著的那一瞬間
       收到的事件會被整個丟掉,而使用者「最後一下」滾輪剛好落在那裡的話,
       對方就停在上一個狀態 —— 畫面上就是「縮放停下來之後兩邊對不齊」。
       停手 140ms 再照來源當下的狀態同步一次（冪等,不會有副作用）。
       ★ 同本檔一再出現的形狀：**事件驅動的同步,後面一定要有一發主動的收尾。** */
    _lastSrc = src;
    clearTimeout(_settleT);
    _settleT = setTimeout(() => {
      if (_mode === 1 || !_lastSrc) return;
      _geomBump();
      /* 停手 → ①用座標法重新校正固定差 ②**釋放驅動權**。
         ⚠ 少了②的話,剛剛被使用者操作的那張副圖（驅動者刻意不被寫入）就沒有人把它拉回一致,
           手勢結束後它會跟整格差一點點（實測「停手後整格一致 false」）。 */
      _cells.forEach(c => { if (c) { c.spOff = null; c.spCmd = null; c.drv = null; } });
      _runSync(_lastSrc);
    }, 140);
  }
  /* ⚠⚠ 2026-09-28 **同步必須「同一幀」做,不可以併到下一幀**（使用者：「第二圖還是頓頓」）。
     我先前為了省工把它排進 rAF —— 結果格子永遠比主圖慢一拍,
     實測（比對兩張圖的 `getVisibleRange().from` 是否相等）拖曳中 **150 幀裡 78 幀（52%）
     兩邊不同步**,改成同幀後降到 **42%**。
     省下來的那點 CPU 完全不值得（而且量下來幀率本來就沒差）。
     ★ 通則（與「手勢中少畫一點」同一條）：**跟隨型的東西寧可多做,也不可以慢一拍。**
     現在每個事件都直接同步;成本已由①繪圖區寬度快取 ②「值沒變就不寫」壓下來。 */
  function _onRange(src, r) {
    if (_syncing || !r || _mode === 1) return;
    if (_isEcho(src)) return;                 // 這是我們剛寫進去造成的回音,不是使用者在動它
    if (Date.now() < _syncReady) return;
    _runSync(src);
    _follow(src);
  }

  /* ★★ 2026-09-28 使用者：「在 a 標的縮放 b 標的有順很多但會有不明抖動」。
     根因：**LWC 的滾輪縮放是逐幀動畫,但 `subscribeVisibleTimeRangeChange` 不是每幀都發** →
     沒收到事件的那一幀格子原地不動,下一幀補兩倍 ＝ 一頓一頓。
     實測（逐幀記 barSpacing 與 scrollPosition,兩者都不是座標函式、沒有陳舊問題）：
       ・縮放中「兩邊 barSpacing 不同」的幀：**42 / 42（每一幀都不同）**
       ・主圖每幀位移平滑單調 -0.74 -0.67 -0.61 -0.55 …
         格子卻是 -0.76 -0.72 -0.64 **-0.06** **-1.08** -0.60 -0.42 **-0.04** … ＝ 停一下跳兩倍
     → 來源真的還在動的期間,**每一幀都重新同步一次**。
     ⚠ 觸發條件用「來源的 barSpacing/scrollPosition 有沒有變」,不是 `_uxBusy()`：
       前者是「畫面真的還在動」的直接證據,後者只是「使用者最近有互動」——
       我上一版用 `_uxBusy` 而且沒有驗證儀器,量不到效果就收回了（那次是探針壞了,見下面 `_echo` 那段）。
     ⚠ 一定要有收工條件（連續 12 幀沒動就停）,否則就是一條常駐的 rAF。
     ⚠ 讀的兩個值都是純量,不碰版面（`_geom*` 的快取仍然有效）→ 每幀的額外成本很低。 */
  let _folRaf = 0, _folSrc = null;
  function _follow(src) {
    _folSrc = src;
    if (_folRaf || _mode === 1) return;
    let idle = 0, lbs = null, lsp = null;
    const step = () => {
      _folRaf = 0;
      if (_mode === 1 || !_folSrc) return;
      let bs = null, sp = null;
      try { const ts = _folSrc.timeScale(); bs = ts.options().barSpacing; sp = ts.scrollPosition(); } catch (e) { return; }
      if (bs !== lbs || sp !== lsp) { lbs = bs; lsp = sp; idle = 0; _runSync(_folSrc); }
      else if (++idle > 12) return;           // 連續 12 幀沒動＝手勢結束,收工
/* ⚠ 試過「用 setTimeout(0) 在繪製之後才登記下一幀的 rAF」（想讓寫入排在格子重繪之前）——
         實測停頓幀 25 → 26,**沒有差別**,已收回。rAF 的登記順序不是殘留停頓的原因。 */
      _folRaf = requestAnimationFrame(step);
    };
    _folRaf = requestAnimationFrame(step);
  }


  /* ⚠⚠ **試過但沒有效、已收回、別再試：把滾輪事件轉發給其餘各圖**（2026-09-28）。
     想法是「主圖之所以順是因為 LWC 自己在處理它的輸入」,那就把同一份 wheel 也餵給格子,
     讓 LWC 用自己的節奏驅動它（游標 x 按繪圖區比例換算,並標記事件避免互轉）。
     **LWC 確實吃合成 wheel 事件**（對格子畫布 dispatch → bs 23.56 → 41.74）,但 A/B 實測
     「格子沒重繪的幀數」轉發開 93/125、轉發關 93/125 —— **完全相同**。已整段移除。 */

  /* ── 十字線連動：游標在任一張圖上 → 其餘各張在**同一個時間**顯示十字線 ─────────
     ⚠ 同樣要迴圈防護：setCrosshairPosition 會觸發對方的 crosshairMove。
     ⚠ 主圖要走 `window._mcCrosshairAt`（它的鉛直線是自繪的 DOM,不是 LWC 原生）。
     ⚠ 價格用「那一格自己在該時間的收盤」→ 橫線落在自己的 K 棒上；沒有那根就退回最後價。 */
  let _crossing = false;

  /* 同一格的副圖：十字線要跟著 K 棒那張走（使用者：「鼠標十字虛線下方垂直線對不到附圖」）。
     ⚠ 價格用**那張副圖自己在該時間的值**（RSI(14)／K／MACD）→ 橫線落在自己的線上；
       拿固定值（例如 50）的話,橫線會定在一個毫無意義的高度,看起來像壞掉。 */
  /* 現價標籤：位置、文字、顏色,以及「它蓋住哪一段價格」。
     ⚠ 顏色跟主圖同一顆 `C.curPrice`,底 70%、框 90%（與 charts.js 那顆的算法一致）。
     ⚠ 標籤不顯示時要把區間清掉,否則刻度會永遠缺一格。
     ⚠ 半高取 15px（標籤半高 10 + 刻度字半高 ~5）—— 同主圖 `_axisHideSet(0, y, 15)`。 */
  /* 只有真的變了才寫進 style（見 `_placeVline` 的說明）。 */
  function _setSty(el, k, v) { if (el && el.style[k] !== v) el.style[k] = v; }
  function _curLabel(cell) {
    const lbl = cell.pxLbl;
    if (!lbl) return;
    const hide = () => { _setSty(lbl, "display", "none"); cell.axisBand = null; };
    try {
      const p = cell.lastC;
      if (p == null) return hide();
      const y = cell.series.priceToCoordinate(p);
      if (y == null) return hide();
      const txt = (typeof _fmtPx === "function") ? _fmtPx(p, cell.prec != null ? cell.prec : -1) : String(p);
      if (lbl.textContent !== txt) lbl.textContent = txt;
      const col = (typeof C !== "undefined" && C.curPrice) || "#FF9147";
      if (typeof _colA === "function" && cell._lblCol !== col) {   // 顏色只有換色盤時才變,不必每幀寫
        cell._lblCol = col;
        lbl.style.background = _colA(col, .70); lbl.style.borderColor = _colA(col, .9);
      }
      _setSty(lbl, "top", Math.round(y) + "px");
      _setSty(lbl, "display", "block");
      const a = cell.series.coordinateToPrice(y - 15), b2 = cell.series.coordinateToPrice(y + 15);
      cell.axisBand = (a == null || b2 == null) ? null : [Math.min(a, b2), Math.max(a, b2)];
    } catch (e) { hide(); }
  }

  /* 把這一格的自訂鉛直線放到「那個時間」的 x。
     ⚠ x 一律問**K 棒那張**的時間軸：整格的價格軸已經拉成同寬（`_eqAxis`）,所以同一個 x
       在每張副圖上都是同一個時間 —— 這正是「一條線貫穿」成立的前提。
     ⚠ 高度從 K 棒區頂端畫到最下面那張副圖的底部（都相對於 `.mini-cell`）。 */
  function _placeVline(cell, tm) {
    const ln = cell.vline;
    if (!ln) return;
    if (tm == null) { _setSty(ln, "display", "none"); return; }
    try {
      const x = cell.chart.timeScale().timeToCoordinate(tm);
      const g = _geom(cell);
      if (x == null || !g) { _setSty(ln, "display", "none"); return; }
      /* ⚠ **值沒變就不要寫**：每一次 style 寫入都會讓瀏覽器重算樣式/版面
         （實測縮放 3.6 秒 `UpdateLayoutTree` 112ms）。top/height 在手勢中根本不會變。 */
      _setSty(ln, "left", Math.round(g.left + x) + "px");
      _setSty(ln, "top", Math.round(g.top) + "px");
      _setSty(ln, "height", Math.round(g.height) + "px");
      _setSty(ln, "display", "block");
    } catch (e) { _setSty(ln, "display", "none"); }
  }
  function _onCross(src, param) {
    if (_crossing || _mode === 1) return;
    _crossing = true;
    try {
      const tm = param && param.time;
      if (tm == null) {
        _cells.forEach(c => { c.xhT = null; _placeVline(c, null); });
        if (src !== (typeof mainChart !== "undefined" ? mainChart : null)) { try { window._mcCrosshairHide?.(); } catch (e) {} }
      } else {
        /* ⚠ **不**在別的圖上設原生十字線（`setCrosshairPosition`）：那會多出一條橫線與圓點,
           使用者說「很亂」。主圖的作法就是只推那條鉛直線,橫線只屬於「滑鼠真的在上面」那張圖。 */
        _cells.forEach(c => { c.xhT = tm; _placeVline(c, tm); });
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
    // ⚠ 走 `_runSync` 而不是直接 `_syncFrom`：那支才會排「停手收尾」那一發
    //   （切 4 格時三格是**非同步**載入的,收尾才保證最後到貨的那一格也對齊）。
    _syncMiniAxis();            // 先把價格軸對齊,繪圖區寬度才是最終值（會影響位移量）
    _runSync(mainChart);
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
        _curLabel(cell);                    // 現價一動,標籤與被它蓋掉的那格刻度都要跟著走
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
  function _ovQueue() {                 // 平移/縮放中每幀都會進來 → 併到下一幀做一次就好
    if (_ovRaf) return;
    _ovRaf = requestAnimationFrame(() => {
      _ovRaf = 0;
      /* ⚠⚠ 2026-09-28 **試過「持續手勢時不重畫裝飾層」,使用者回報「更卡了」→ 已收回。**
         道理上省了一張 1.5M 像素的畫布重畫,但代價是**裝飾（可見高低/交易時段/繪圖…）
         會凍在原地、跟 K 棒脫節** —— 那個「不同步」讀起來比掉幾幀更像卡。
         ★ 通則（本專案第三次）：**手勢中「少畫一點」只有在使用者看不出來時才算優化**;
           只要有東西跟不上游標,感受一定更差（2026-09-24 自繪格線、2026-09-27 格子追不上,
           都是同一件事）。別再試這個方向。 */
      _cells.forEach(c => {
        if (c.xhT != null) _placeVline(c, c.xhT);   // 時間沒變但 x 變了
        _curLabel(c);                               // 價格軸跟著縮放 → 標籤與讓位的刻度要重算
        _ovPaint(c);
      });
    });
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
    cell.subs.forEach(x => { try { x.ws.setData(arr); } catch (e) {} });   // 副圖同一份（時間軸在它們身上）
  }
  function _reWs(cell) {            // 副圖是後來才建立的 → 補鋪一次目前的留白
    if (!cell || !cell.wsStep || !cell.wsN) return;
    const arr = new Array(cell.wsN);
    for (let k = 0; k < cell.wsN; k++) arr[k] = { time: cell.wsT0 + cell.wsStep * (k + 1) };
    cell.subs.forEach(x => { try { x.ws.setData(arr); } catch (e) {} });
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
    /* ★★ 2026-09-28 使用者：「縮放滑動都卡卡」「只有一張的時候很順」。
       補回來之後那段 `_feedMain`+`_feedSubs`+`_refilterMarkers` 是 **O(根數) 的整批 setData
       × 5 個序列（K 棒/成交量/布林 3 條）再加 3 張副圖**,而它原本就在**手勢進行中**跑 ——
       縮小只要滑到最舊那根附近就會一直觸發,每次都在拖曳/縮放的中間插一段長任務。
       主圖那條路（`_bgApplyChunk`）早就因為同一件事改成分塊讓路（memory
       `project_bg-chunk-apply-yield`：單次 23~76ms,錨點 setData 佔一半）,格子這份漏了。
       → 手勢中不開工,等使用者停手再補。
       ⚠ **不是取消,是延後**：`olderT` 每 200ms 再問一次,停手就補上 → 補載行為完全不變,
         使用者也看不出差別（那些 K 棒本來就還沒進畫面）。
       ⚠ 這跟「手勢中少畫一點」那條教訓不衝突：那條講的是**看得見的重畫**（少畫＝使用者看得出來,
         實測反而更卡）。這裡延後的是**畫面外的資料補載**,沒有任何一幀因此少畫東西。 */
    if (typeof window._uxBusy === "function" && window._uxBusy()) {
      clearTimeout(cell.olderT);
      cell.olderT = setTimeout(() => _loadOlder(cell), 200);
      return;
    }
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
    cell.byTime = new Map(R.map(r => [r.time, r.close]));   // time → 收盤（給需要「那一根的價」的地方用）
    cell.rowByT = new Map(rows.map((b, i) => [R[i].time, b]));   // 副圖十字線要那一根的指標值
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
    _curLabel(cell);
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
    chart.applyOptions({ handleScroll: true, handleScale: true,
                         crosshair: { vertLine: { visible: false, labelVisible: false } } });
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
    /* ⚠⚠ 副圖也要有自己的未來留白：**時間軸就印在最下面那一張副圖上**,
       而 LWC 的格線與時間刻度只生成在「有資料的時間範圍」內 → 副圖沒有留白序列的話,
       最後一根之後那一段就沒有格線、也沒有時間刻度（使用者：「第二圖後面的時間軸沒出來」）。
       主圖的 `_gridAhead` 本來就是**四張圖各掛一條**,我第一版只給了 K 棒那張。 */
    const ws = chart.addLineSeries({
      priceScaleId: "", lastValueVisible: false, crosshairMarkerVisible: false,
      priceLineVisible: false, autoscaleInfoProvider: () => null,
    });
    const sub = { key, el, chart, anchor, ws, lines: [] };
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
      /* 超買/超賣漸層底（使用者：「rsi 沒有過低過高著色」）。用主圖**同一支** primitive,
         只是餵這一格自己的包絡（見 charts.js `_makeRSIZonePrimitive` 的 getBands/getVis）。
         ⚠ 掛在 RSI(14) 上、畫在最底層（zOrder bottom）,不會擋住線。
         ⚠ `getVis` 要回「這一格的兩條線開著沒」—— 不是主圖那兩條。 */
      sub.bands = [];
      try {
        const zp = _makeRSIZonePrimitive(() => sub.bands,
          () => ({ vis14: _visOf(sub.main) !== false, vis7: _visOf(sub.second) !== false }));
        sub.main.attachPrimitive(zp);
        sub.zone = zp;
      } catch (e) {}
      sub.feed = rows => {
        const r14 = rows.filter(d => Number.isFinite(d.rsi_14)).map(d => ({ time: toTime(d.time), value: d.rsi_14 }));
        const r7 = rows.filter(d => Number.isFinite(d.rsi_7)).map(d => ({ time: toTime(d.time), value: d.rsi_7 }));
        sub.main.setData(r14);
        sub.second.setData(r7);
        const m7 = new Map(r7.map(p2 => [p2.time, p2.value]));
        sub.bands = r14.map(p2 => ({ t: p2.time, v14: p2.value, v7: m7.get(p2.time) ?? null }));
        try { sub.zone && sub.zone.requestUpdate(); } catch (e) {}
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
    chart.subscribeCrosshairMove(param => _onCross(chart, param));   // hover 副圖時也要帶動其他人
    /* ★★ 2026-09-28 使用者：「我縮放第二圖的附圖 不會跟著縮放 會卡住」。
       副圖建立時就開著 `handleScale/handleScroll`（跟主圖的副圖一樣可以直接在上面縮放/平移）,
       但這裡原本**只有「格子的 K 棒圖 → 副圖」單向同步**（`_syncSubs`）——
       在副圖上滾輪只會縮到那一條,跟上面的 K 棒錯開;下一次任何同步再把它推回去 ＝「卡住」。
       主圖那邊早就解決過同一件事（`charts.js` 的 `_syncDriver`：使用者最後碰到哪個面板,
       那個面板就是驅動者,其餘只收不發 —— 四張圖互相驅動會變成**自我維持的同步風暴**,
       2026-07-31 實測中位 16.7ms → 188.5ms）。這裡照同一套做。
       ⚠ 只有「正在被操作的那一張」能驅動;程式化的同步（`_syncing` 開著）一律不回推。 */
    ["pointerdown", "wheel", "touchstart"].forEach(ev =>
      el.addEventListener(ev, () => { cell.drv = sub; }, { passive: true, capture: true }));
    chart.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (_syncing || cell.drv !== sub) return;
      /* ⚠⚠ **值跟我們剛剛命令的一樣＝這是我們自己造成的事件,不是使用者在動它。**
         不擋的話就是自我維持的同步風暴（見 `_syncSubs` 裡的長註解與實測數字）。
         用「值比對」而不是「時間窗」：使用者連續縮放時我們每一幀也在寫,時間窗會把他的操作一起擋掉。 */
      try {
        const t = sub.chart.timeScale();
        if (sub.cmdBs != null &&
            Math.abs(t.options().barSpacing - sub.cmdBs) < 1e-6 &&
            Math.abs(t.scrollPosition() - sub.cmdSp) < 1e-6) return;
      } catch (e) { return; }
      _driveFromSub(cell, sub);
    });
    return sub;
  }

  /* 副圖被使用者直接縮放/平移 → 把它的 barSpacing/捲動位置搬到這一格的 K 棒圖上,
     之後就走原本那條路（`_onRange` → `_syncFrom` → 其餘各圖與各副圖）。 */
  function _driveFromSub(cell, sub) {
    try {
      const a = sub.chart.timeScale(), b = cell.chart.timeScale();
      const bs = a.options().barSpacing, sp = a.scrollPosition();
      let moved = false;
      if (Math.abs((b.options().barSpacing || 0) - bs) > 1e-6) { b.applyOptions({ barSpacing: bs }); moved = true; }
      if (Math.abs((b.scrollPosition() || 0) - sp) > 1e-6) { b.scrollToPosition(sp, false); moved = true; }
      if (moved) _ovQueue();
    } catch (e) {}
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
    _reWs(cell);
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
        /* ★★★ **絕對不可以寫入「使用者正在操作的那一張」**（2026-09-28 使用者：
           「我在那裡縮放 他就是整個畫面抖動」）。使用者的滾輪把這張副圖設成 X,我們又把
           格子的值寫回它 → 兩邊搶同一張圖 → 實測主圖可見跨度在 14~20 天之間來回,
           **167 幀裡方向反轉 101 次**。
           ★ 這就是 charts.js `_syncDriver` 的核心規則：**驅動者只發不收**。
             我第一版只做了「忽略自己造成的事件」,那只減少迴圈次數,止不住互打。 */
        if (x === cell.drv) return;
        try {
          const t2 = x.chart.timeScale();
          /* ★★ 記下「我們命令它待在哪」—— 副圖可以反過來驅動整格（見 `_mkSub`）,
             但**必須排除我們自己寫進去造成的那些事件**,否則就是
             `_syncSubs → 副圖事件 → _driveFromSub → 格子 → 主圖 → _syncSubs` 的自我維持迴圈。
             實測那個迴圈：滾一次滾輪 `_driveFromSub` 觸發 **479 次**、三張副圖的 barSpacing
             永遠收斂不到同一個值,而且**主圖會完全縮不動**（跨度 950400 → 950400,被格子蓋掉）
             —— 使用者的回報就是「我在那裡縮放 他就是整個畫面抖動」。 */
          x.cmdBs = bs; x.cmdSp = sp;
          /* ⚠ 值沒變就不要寫：`applyOptions({barSpacing})` 會讓那張圖**整張重畫** ——
             平移時 barSpacing 根本沒變,每幀白重畫三張副圖（畫面上的成本是瀏覽器的繪製,
             不是我們的 JS,所以 profiler 只會看到 `(program)` 變大）。 */
          if (Math.abs((t2.options().barSpacing || 0) - bs) > 1e-6) t2.applyOptions({ barSpacing: bs });
          if (Math.abs((t2.scrollPosition() || 0) - sp) > 1e-6) t2.scrollToPosition(sp, false);
        } catch (e) {}
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

  /* 一組圖的價格軸拉成同寬（同 charts.js `_syncAxisWidth`：取最寬的用 minimumWidth 套給全部）。
     ⚠ 這不只是好看：軸寬不同 → 繪圖區寬度不同 → **同一個時間落在不同的 x**,
       十字線的鉛直線就對不到下面的副圖（使用者：「鼠標十字虛線下方垂直線對不到附圖」）。 */
  function _eqAxis(list) {
    list = list.filter(Boolean);
    if (list.length < 2) return;
    try {
      const w = list.map(c => { try { return c.priceScale("right").width() || 0; } catch (e) { return 0; } });
      const want = Math.max(...w);
      if (!want) return;
      list.forEach((c, i) => { if (w[i] !== want) { try { c.priceScale("right").applyOptions({ minimumWidth: want }); } catch (e) {} } });
    } catch (e) {}
  }
  function _syncMiniAxis() {
    _geomBump();                 // 軸寬要重對 → 繪圖區寬度也跟著變
    _syncMiniW();
    if (_mode === 1 || !_cells.length) return;
    // ① 每一格內部：K 棒圖與它的副圖（4 格也要,那裡雖然目前不長副圖,但邏輯一致）
    _cells.forEach(c => _eqAxis([c.chart, ...c.subs.map(x => x.chart)]));
    // ② 2 格模式：主圖與那一格也要同寬（兩邊 K 棒才會一樣大）
    if (_mode === 2 && typeof mainChart !== "undefined" && mainChart)
      _eqAxis([mainChart, _cells[0].chart, ..._cells[0].subs.map(x => x.chart)]);
  }

  /* 唯讀除錯出口（同 `_mcRanges` 的理由：chart 物件包在 IIFE 裡,外面讀不到） */
  window._mcBands = function () {     // RSI 包絡點數（給驗證用）
    const c = _cells[0]; if (!c) return null;
    const r = c.subs.find(x => x.key === "rsi");
    return r ? (r.bands || []).length : null;
  };
  window._mcNative = function () {   // 各圖的原生鉛直線是否還開著（應全部 false）
    const c = _cells[0]; if (!c) return null;
    const g = ch => { try { return ch.options().crosshair.vertLine.visible; } catch (e) { return null; } };
    return [g(c.chart), ...c.subs.map(x => g(x.chart))];
  };
  window._mcVlineCheck = function () {   // 那條線的 x 是不是「xhT 在這一格時間軸上的座標」
    const c = _cells[0]; if (!c || c.xhT == null) return null;
    try {
      const want = c.chart.timeScale().timeToCoordinate(c.xhT);
      const cr = c.el.getBoundingClientRect(), br = c.body.getBoundingClientRect();
      const got = parseFloat(c.vline.style.left) - (br.left - cr.left);
      return { xhT: c.xhT, want: Math.round(want), got: Math.round(got), diff: Math.round(got - want) };
    } catch (e) { return null; }
  };
  window._mcAxes = function () {
    const c = _cells[0]; if (!c) return null;
    const g = ch => { try { return Math.round(ch.priceScale("right").width()); } catch (e) { return -1; } };
    return [g(c.chart), ...c.subs.map(x => g(x.chart))];
  };
  window._mcWs = function () {
    const c = _cells[0]; if (!c || !c.wsStep) return null;
    const t = c.wsT0 + c.wsStep * 40;                 // 最後一根之後第 40 根（留白區）
    const q = ch => { try { return ch.timeScale().timeToCoordinate(t) != null; } catch (e) { return false; } };
    return { n: c.wsN, future: [q(c.chart), ...c.subs.map(x => q(x.chart))] };
  };
  window._mcXhX = function () {      // 各圖「目前十字線」換算成 x（用同一個時間問各自的時間軸）
    const c = _cells[0]; if (!c || c.xhT == null) return null;
    const x = ch => { try { const v = ch.timeScale().timeToCoordinate(c.xhT); return v == null ? null : Math.round(v); } catch (e) { return null; } };
    return [x(c.chart), ...c.subs.map(s2 => x(s2.chart))];
  };

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
             /* 副圖的 barSpacing/捲動位置 —— 查「格子的附圖沒跟著縮放」只能靠這個
                （副圖的 chart 物件包在 IIFE 裡,外面讀不到）。 */
             subBs: _cells.map(c => c.subs.map(x => { try { return +x.chart.timeScale().options().barSpacing.toFixed(2); } catch (e) { return null; } })),
             subSp: _cells.map(c => c.subs.map(x => { try { return +x.chart.timeScale().scrollPosition().toFixed(2); } catch (e) { return null; } })),
             sp: _cells.map(c => { try { return +c.chart.timeScale().scrollPosition().toFixed(2); } catch (e) { return null; } }),
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
    /* 使用者碰主圖 → 各格的驅動權交還給它自己的 K 棒圖,
       否則「上次在某張副圖上滾過」會讓那張副圖一直是驅動者。 */
    const _mp = document.getElementById("mainPane");
    if (_mp) ["pointerdown", "wheel", "touchstart"].forEach(ev =>
      _mp.addEventListener(ev, () => { _cells.forEach(c => { if (c) c.drv = null; }); }, { passive: true, capture: true }));
    // 每 5s 更新尾巴（背景分頁暫停＝省電規範；錯開避免同秒齊發）
    /* ★ 2026-09-28 使用者：「第二圖 報價偏慢」。原本固定 5 秒一次,主圖是 1 秒 → 最壞差 5 秒。
       ⚠⚠ **不可以改成讀報價列那份（`_tickerData`）省流量**：那是**永續**的清單,
         `spot` 欄位只是把 `.P` 去掉的**衍生名稱**,價格仍是永續的 —— 拿去餵現貨標的
         就是「永續偷偷變成現貨」的反向版（claude.md 守門員之五記過差 28 點／4.3bps）。
         實測 `_tickerData` 裡 `spot:"ETH/USDT"` 那筆的 price 是 `ETH/USDT.P` 的價。
       → 照樣走 `/api/latest`（與主圖同一支、同一個商品）,只是問得更勤,
         並依格子數調整：2 格 1.2 秒（要拿來對照,就該跟得上）、4 格 2.5 秒（掃一眼用的,
         三格一起打沒必要那麼勤）。⚠ 背景分頁照樣完全不打（省電規範）。
       ⚠ 後端 `/api/latest` 有 1 秒 TTL ＋ 單飛 → 多打的多半吃快取,不會加重上游。 */
    const _tickDelay = () => (_cells.length <= 1 ? 1200 : 2500);
    let _tickT = null;
    const _tickLoop = () => {
      clearTimeout(_tickT);
      if (!document.hidden && _cells.length) _cells.forEach((c, i) => setTimeout(() => _tickMini(i), i * 300));
      _tickT = setTimeout(_tickLoop, _tickDelay());
    };
    _tickLoop();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(_init, 800));
  else setTimeout(_init, 800);
})();
