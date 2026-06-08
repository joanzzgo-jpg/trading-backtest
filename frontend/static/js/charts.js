function makeBaseOpts(scaleMargins = null, showTime = false) {
  // 極簡模式用亮色系，其他維持原本暗色
  const _perf = document.documentElement.classList.contains("perf-mode");
  const _txt  = _perf ? "#2A2620" : "#d1d4dc";
  const _grd  = _perf ? "#ECECEC" : "#2a2e39";
  const _cx   = _perf ? "#9C9C9C" : "#758696";
  const _brd  = _perf ? "#D9D9D9" : "#2a2e39";
  const _lbg  = _perf ? "#F5F5F5" : "#2a2e39";
  // 圖表背景維持透明，由 body 的純白底襯出（讓浮水印也能透過 -1 z-index 顯現）
  const opts = {
    layout:    { background:{ color: "rgba(0,0,0,0)" }, textColor: _txt },
    grid:      { vertLines:{ color: _grd }, horzLines:{ color: _grd } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { style: 3, width: 1, color: _cx, labelBackgroundColor: _lbg },
      horzLine: { style: 3, width: 1, color: _cx, labelBackgroundColor: _lbg },
    },
    rightPriceScale: { borderColor: _brd, minimumWidth: 80 },
    timeScale: {
      borderColor: _brd,
      timeVisible: true,
      secondsVisible: false,
      visible: showTime,          // 只有最下方面板顯示時間座標
    },
  };
  if (scaleMargins) opts.rightPriceScale.scaleMargins = scaleMargins;
  return opts;
}

/* ══════════════════════════════════════════
   初始化
══════════════════════════════════════════ */

/* ── 建立 / 重建主圖 series ── */
function createCandleSeries() {
  if (candleSeries) { try { mainChart.removeSeries(candleSeries); } catch {} candleSeries = null; }
  latestPriceLine = null;
  candleSeries = mainChart.addCandlestickSeries({
    upColor:   S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)",
    downColor: S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)",
    borderVisible:   S.borderVisible !== false,
    borderUpColor:   C.borderUp,   borderDownColor: C.borderDown,
    wickVisible:     S.wickVisible  !== false,
    wickUpColor:     C.wickUp,      wickDownColor:   C.wickDown,
    priceLineVisible: false, lastValueVisible: false,
  });
}

/* ── 將 ohlcv 資料套用到目前 series ── */
function applyOhlcvToSeries(data) {
  if (!candleSeries || !data.length) return;
  {
    candleSeries.setData(data.map(d => ({
      time: d.time ? toTime(d.time) : d, open: d.open, high: d.high, low: d.low, close: d.close,
    })));
  }
  updateLatestPriceLine(data[data.length - 1].close);
}

function updateLatestPriceLine(price) {
  if (!candleSeries || price == null) return;
  if (latestPriceLine) {
    try { latestPriceLine.applyOptions({ price }); return; } catch { latestPriceLine = null; }
  }
  latestPriceLine = candleSeries.createPriceLine({
    price,
    color: "rgba(255,145,71,.80)",
    lineWidth: 1,
    lineStyle: 2,        /* 2 = Dashed */
    axisLabelVisible: true,
    axisLabelColor: "rgba(255,145,71,.90)",
    axisLabelTextColor: "#fff",
    title: "",
  });
}

/* ── 建立圖表 ── */
function buildCharts() {
  const base  = makeBaseOpts(null,                   false);
  const sub   = makeBaseOpts({ top:0.08, bottom:0.08 }, false);
  const volSM = makeBaseOpts({ top:0.05, bottom:0 },    false);
  const subT  = makeBaseOpts({ top:0.08, bottom:0.08 }, true);  // 最下方，顯示時間軸

  mainChart = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  createCandleSeries();
  bbU = mainChart.addLineSeries({ color:C.bbU, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });
  bbM = mainChart.addLineSeries({ color:C.bbM, lineWidth:S.bbMWidth??1, lineStyle:S.bbMStyle??2, priceLineVisible:false, lastValueVisible:false });
  bbL = mainChart.addLineSeries({ color:C.bbL, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });

  // 成交量疊在主圖下方（獨立 priceScaleId，不影響 K 棒價格軸）
  volSeries   = mainChart.addHistogramSeries({ priceScaleId:"volume", priceLineVisible:false, lastValueVisible:false });
  volMaSeries = mainChart.addLineSeries({ priceScaleId:"volume", color:"#ffcc02", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });

  kdjChart = LightweightCharts.createChart(document.getElementById("kdjChart"), sub);
  kdjAnchor = kdjChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  kdjK  = kdjChart.addLineSeries({ color:C.kdjK, lineWidth:S.kdjKWidth??1, lineStyle:S.kdjKStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjD  = kdjChart.addLineSeries({ color:C.kdjD, lineWidth:S.kdjDWidth??1, lineStyle:S.kdjDStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjJ  = kdjChart.addLineSeries({ color:C.kdjJ, lineWidth:S.kdjJWidth??1, lineStyle:S.kdjJStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjH20 = kdjChart.addLineSeries({ color:C.kdjH20, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH50 = kdjChart.addLineSeries({ color:C.kdjH50, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  kdjH80 = kdjChart.addLineSeries({ color:C.kdjH80, lineWidth:S.kdjHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), sub);
  rsiAnchor = rsiChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  rsiLine14 = rsiChart.addLineSeries({ color:C.rsi14, lineWidth:S.rsi14Width??1, lineStyle:S.rsi14Style??0, priceLineVisible:false, lastValueVisible:false });
  rsiLine7  = rsiChart.addLineSeries({ color:C.rsi7,  lineWidth:S.rsi7Width??1,  lineStyle:S.rsi7Style??0,  priceLineVisible:false, lastValueVisible:false });
  rsiH30 = rsiChart.addLineSeries({ color:C.rsiH30, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH50 = rsiChart.addLineSeries({ color:C.rsiH50, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });
  rsiH70 = rsiChart.addLineSeries({ color:C.rsiH70, lineWidth:S.rsiHLWidth, lineStyle:1, priceLineVisible:false, lastValueVisible:true });

  macdChart = LightweightCharts.createChart(document.getElementById("macdChart"), subT);
  macdAnchor = macdChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdLine   = macdChart.addLineSeries({ color:C.macd,    lineWidth:S.macdWidth??1,    lineStyle:S.macdStyle??0,    priceLineVisible:false, lastValueVisible:false });
  macdSignal = macdChart.addLineSeries({ color:C.macdSig, lineWidth:S.macdSigWidth??1, lineStyle:S.macdSigStyle??0, priceLineVisible:false, lastValueVisible:false });
  macdHist   = macdChart.addHistogramSeries({ priceScaleId:"right", priceLineVisible:false, lastValueVisible:false });

  const ro = new ResizeObserver(() => resizeAll());
  ro.observe(document.getElementById("chartsContainer"));
  // 等 DOM 完成 layout 後再 resize（rAF 兩次確保 flex 已計算完畢）
  requestAnimationFrame(() => requestAnimationFrame(resizeAll));
}

function resizeAll() {
  const container = document.getElementById("chartsContainer");
  const w = container.clientWidth;
  const charts = [
    [mainChart,   "mainChart"],
    [kdjChart,    "kdjChart"],
    [rsiChart,    "rsiChart"],
    [macdChart,   "macdChart"],
  ];
  charts.forEach(([chart, id]) => {
    const el = document.getElementById(id);
    if (!el || !chart) return;
    const h = el.clientHeight;
    if (h > 10) chart.resize(w, h);
  });
}

/* ── 時間軸 & 鉛直線同步 ── */
let _blockSync = false; // 重播渲染期間暫停雙向同步，防止 setData 觸發 range 抖動

function syncTimeScales() {
  // 捲動 / 縮放：以 logical range 同步（anchor series 確保各圖索引一致）
  const allCharts = [mainChart, kdjChart, rsiChart, macdChart];
  let syncing = false;
  let _scrollLoadTs = 0; // throttle scroll-triggered loading
  // 跨圖同步用 rAF 合併：一次拖曳/縮放每幀可能觸發多次 range-change，若每次都同步 3 張子圖
  // → 主執行緒被重繪塞滿，連帶把背景天氣動畫的 rAF 擠掉（拖曳時背景凍結）。改成「每幀最多
  // 同步一次」：把最新 range 記下來，用單一 rAF 在下一幀統一推給其它圖，負載大降、背景有空檔更新。
  let _pendingSync = null;      // { range, si } 最新待同步狀態
  let _syncRaf = 0;
  let _lastFlushTs = 0;
  function _flushSync() {
    _syncRaf = 0;
    const p = _pendingSync;
    if (!p || _blockSync) { _pendingSync = null; return; }
    // 平移/縮放/慣性進行中：子圖同步降到 ~30fps（主圖維持全速；盤中上萬根時 4 張圖每幀重排太重）。
    // 節流時保留 _pendingSync、下一幀再試，確保停手時以「最新 range」做最後一次同步、子圖補正。
    const _now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const _moving = window._chartMoveTs && (_now - window._chartMoveTs < 220);
    if (_moving && _now - _lastFlushTs < 33) { _syncRaf = requestAnimationFrame(_flushSync); return; }
    _lastFlushTs = _now;
    _pendingSync = null;
    syncing = true;
    allCharts.forEach((dst, di) => { if (di !== p.si) dst.timeScale().setVisibleLogicalRange(p.range); });
    syncing = false;
    // 平移/縮放 → 重算可見範圍的標記視窗（debounced，避免長範圍時 setMarkers 拖慢）
    if (typeof _scheduleMarkerRewindow === "function") _scheduleMarkerRewindow();
    // 接近左側邊界就提前預抓下一塊歷史（門檻拉大 → 還沒滑到空白就先載好，補資料更快不卡頓）
    if (p.range.from < 600 && !_bgLoadInProgress && ohlcvData.length) {
      const now = Date.now();
      if (now - _scrollLoadTs > 250) { // 節流縮短 → 連續往回滑時下一塊能更快接上
        _scrollLoadTs = now;
        _bgLoadOlderBars(true); // 滑動觸發，分頁載入更早的資料（一次一塊）
      }
    }
  }
  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      // 標記「圖表正在移動」（平移/縮放/慣性）→ 供其它模組參考（背景天氣等）
      window._chartMoveTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (syncing || !range || _blockSync) return;
      _pendingSync = { range, si };               // 只記最新，丟棄同幀內較舊的中間值
      if (!_syncRaf) _syncRaf = requestAnimationFrame(_flushSync);
    });
  });

  /* ── 鉛直線：線段統一放在 chartsContainer，動態計算每段的 top/height
     這樣每段可同時覆蓋 chart-pane + 下方的 pane-divider，完全無縫 ── */
  const panesConf = [
    { elId: "mainPane", chart: mainChart },
    { elId: "kdjPane",  chart: kdjChart  },
    { elId: "rsiPane",  chart: rsiChart  },
    { elId: "macdPane", chart: macdChart },
  ];
  const container = document.getElementById("chartsContainer");
  const lineEls = panesConf.map(() => {
    const ln = document.createElement("div");
    ln.className = "pane-vline";
    container.appendChild(ln);
    return ln;
  });

  // 底部時間標籤（鼠標在任意面板都顯示）
  const timeLabel = document.createElement("div");
  timeLabel.className = "crosshair-time-label";
  container.appendChild(timeLabel);

  let hideTimer = null;

  function positionLines(time, fallbackX) {
    // 時間轉 x 座標；timeToCoordinate 只對「繪圖區內的時間」回座標 [0, plotW]。
    // 往左滑時十字線時間捲出繪圖區 → 回 null，此時直接隱藏標籤（不可退回游標 x，
    // 否則游標在右側價格軸區時，時間框會跑到右邊）。
    const mainX = mainChart.timeScale().timeToCoordinate(time);
    if (mainX == null || mainX < 0) {
      lineEls.forEach(l => l.style.display = "none");
      timeLabel.style.display = "none";
      return;
    }

    // 底部時間標籤
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    let timeStr;
    if (["8h","4h","2h","1h","30m","15m","5m"].includes(currentTF)) {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    } else {
      timeStr = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    }
    timeLabel.textContent = timeStr;
    timeLabel.style.display = "block";
    timeLabel.style.left   = Math.round(mainX) + "px";
    timeLabel.style.bottom = replayActive ? "42px" : "0";

    const cRect = container.getBoundingClientRect();
    panesConf.forEach(({ elId, chart }, i) => {
      const pane = document.getElementById(elId);
      const ln   = lineEls[i];
      if (!pane || pane.classList.contains("hidden")) { ln.style.display = "none"; return; }
      if (pane.querySelector(".pane-body")?.style.display === "none") { ln.style.display = "none"; return; }

      const paneX = chart.timeScale().timeToCoordinate(time) ?? mainX;
      if (paneX == null) { ln.style.display = "none"; return; }

      const pRect = pane.getBoundingClientRect();
      let height  = pRect.height;

      // 往下延伸，覆蓋緊接的 pane-divider（若可見）
      const nextSib = pane.nextElementSibling;
      if (nextSib?.classList.contains("pane-divider") && !nextSib.classList.contains("hidden")) {
        height += nextSib.getBoundingClientRect().height;
      }

      ln.style.display = "block";
      ln.style.left    = Math.round(paneX) + "px";
      ln.style.top     = Math.round(pRect.top - cRect.top) + "px";
      ln.style.height  = Math.round(height) + "px";
    });
  }

  panesConf.forEach(({ chart }) => {
    chart.subscribeCrosshairMove(param => {
      clearTimeout(hideTimer);
      if (!param.time || !param.point) {
        hideTimer = setTimeout(() => {
          lineEls.forEach(l => l.style.display = "none");
          timeLabel.style.display = "none";
        }, 60);
        if (typeof _updateHoverWR === "function") _updateHoverWR(null);   // 離開圖表 → 清 hover 勝率/RR 盒
        return;
      }
      positionLines(param.time, param.point.x);
      updateAllLegends(param.time);
      // 十字線移到該 K 棒 → 上方 S1-S12 區顯示該棒訊號勝率 + 圖上畫 RR 盒
      if (typeof _updateHoverWR === "function") _updateHoverWR(param.time);
    });
  });

  // 所有圖停用 LWC 原生鉛直線（改用自訂 pane-vline），並關掉原生時間軸標籤——
  // 否則底部會同時冒出原生「2026-05-20 00:00」與自訂「2026-05-20」兩個標籤互相重疊。
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => {
    c?.applyOptions({ crosshair: { vertLine: { visible: false, labelVisible: false } } });
  });
}

/* ══════════════════════════════════════════
   繪圖工具（Canvas Overlay）
══════════════════════════════════════════ */
