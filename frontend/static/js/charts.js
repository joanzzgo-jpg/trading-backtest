function makeBaseOpts(scaleMargins = null, showTime = false) {
  // 極簡模式用亮色系，其他維持原本暗色
  const _perf = document.documentElement.classList.contains("perf-mode");
  // 軸刻度數字（右側價格軸／底部時間軸）調淡一些，降低存在感
  const _txt  = _perf ? "rgba(42,38,32,0.55)" : "rgba(209,212,220,0.55)";
  // 格子線初始預設：暗底(暗色主題)→亮暖奶油格線、亮底(極簡)→深暖棕格線。
  //   ⚠ 圖表背後是 #weatherStage 天氣層(日亮夜暗、多變)，故實際格線色由 colors.js 的
  //   _applyChartBgGradient()「依有效背景明暗自動反轉」動態覆寫(天氣切換自動更新)，這裡只給首幀預設。
  const _grd  = _perf ? "rgba(64,42,24,0.24)" : "rgba(255,216,176,0.13)";
  const _cx   = _perf ? "#9C9C9C" : "#758696";
  const _brd  = _perf ? "#D9D9D9" : "#2a2e39";
  const _lbg  = _perf ? "#F5F5F5" : "#2a2e39";
  // 圖表背景維持透明，由 body 的純白底襯出（讓浮水印也能透過 -1 z-index 顯現）
  const opts = {
    // attributionLogo:false = 關掉 LWC 4.2 起預設顯示的左下角 TradingView logo；
    // 授權要求的出處署名改放封面頁角落（index.html .landing-credit），合規且不擋圖
    layout:    { background:{ color: "rgba(0,0,0,0)" }, textColor: _txt, attributionLogo: false },
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
/* K 棒邊框實際要不要畫：LWC 畫邊框=先填邊框矩形、再填內縮實體 → 實體像素畫兩次。
   邊框色與實體色完全相同(本專案預設)時兩次填色像素一模一樣 → 跳過邊框省近半 K 棒填充
   (Retina 填充率是平移/縮放瓶頸,最有感)。使用者把邊框調成不同色、或隱藏實體(空心K)時照常畫。 */
function _candleBorderVisible() {
  if (S.borderVisible === false) return false;               // 使用者關閉邊框
  if (S.bodyVisible === false) return true;                  // 實體隱藏(空心K)→ 邊框是主角、必畫
  return !(C.borderUp === C.up && C.borderDown === C.down);  // 同色=白畫兩次 → 跳過(像素零差異)
}

function createCandleSeries() {
  if (candleSeries) { try { mainChart.removeSeries(candleSeries); } catch {} candleSeries = null; }
  if (lineSeries)   { try { mainChart.removeSeries(lineSeries);   } catch {} lineSeries = null; }
  latestPriceLine = null;
  candleSeries = mainChart.addCandlestickSeries({
    upColor:   S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)",
    downColor: S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)",
    borderVisible:   _candleBorderVisible(),
    borderUpColor:   C.borderUp,   borderDownColor: C.borderDown,
    wickVisible:     S.wickVisible  !== false,
    wickUpColor:     C.wickUp,      wickDownColor:   C.wickDown,
    priceLineVisible: false, lastValueVisible: false,
  });
  // 線型圖：收盤價折線，與蠟燭並存（切換時只改可見性＋把蠟燭設透明）。標記/FVG 主圖仍依附 candleSeries 不動。
  lineSeries = mainChart.addLineSeries({
    color: (C.lineChart || "#2196f3"), lineWidth: 2,
    priceLineVisible: false, lastValueVisible: false, visible: false,
  });
  // FVG 失衡缺口色塊（自訂 primitive）：蠟燭重建時一併重掛，沿用全域 _fvgZones
  try {
    _fvgPrimitive = _makeFVGPrimitive();
    candleSeries.attachPrimitive(_fvgPrimitive);
    _fvgTLPrim = _makeFVGTradeLinePrimitive();       // FVG 逐筆止損/止盈價位線
    candleSeries.attachPrimitive(_fvgTLPrim);
    // 策略方向標記(多/空·破多空·順多空)：改用 primitive → 與 K 棒同一次繪製、縮放時不游移(不抖)、又能隨 barSpacing 縮放
    _stratMarkersPrim = _makeStratMarkersPrimitive();
    candleSeries.attachPrimitive(_stratMarkersPrim);
    // Footprint 足跡圖（footprint.js；bundle 串接順序在 charts 之後，但本函式於整包載完才執行）
    if (typeof _makeFootprintPrimitive === "function") {
      _fpPrim = _makeFootprintPrimitive();
      candleSeries.attachPrimitive(_fpPrim);
    }
    // 掛單牆（orderbook.js）：即時盤口大掛單畫在右緣
    if (typeof _makeOrderbookPrimitive === "function") {
      _obPrim = _makeOrderbookPrimitive();
      candleSeries.attachPrimitive(_obPrim);
    }
    // 大時框 FVG 疊加（htffvg.js）：在小時框圖上畫 1h/4h/1d/1w 的 FVG 缺口
    if (typeof _makeHtfFvgPrimitive === "function") {
      _htfFvgPrim = _makeHtfFvgPrimitive();
      candleSeries.attachPrimitive(_htfFvgPrim);
    }
    // 前一日高低(PDH/PDL)水平線
    _pdhlPrim = _makePDHLPrimitive();
    candleSeries.attachPrimitive(_pdhlPrim);
    // 外包吞噬掃蕩(第2根上下兩側都吃掉第1根+方向相反)
    _engulfPrim = _makeEngulfPrimitive();
    candleSeries.attachPrimitive(_engulfPrim);
    // Swing point 擺動點(3根:中間根的高=三根最高、或低=三根最低)
    _swingPrim = _makeSwingPrimitive();
    candleSeries.attachPrimitive(_swingPrim);
    // 經濟事件垂直線(NFP/CPI/FOMC)
    if (typeof _makeEconPrimitive === "function") {
      _econPrim = _makeEconPrimitive();
      candleSeries.attachPrimitive(_econPrim);
    }
  } catch (e) { /* 舊版 LWC 無 attachPrimitive 時靜默略過 */ }
  applyChartType();   // 建好後套用目前圖型（蠟燭/線型）
}

// 蠟燭正常顏色選項（切回蠟燭時還原用；與 createCandleSeries 定義一致）
function _candleColorOpts() {
  return {
    upColor:   S.bodyVisible !== false ? C.up   : "rgba(0,0,0,0)",
    downColor: S.bodyVisible !== false ? C.down : "rgba(0,0,0,0)",
    borderVisible: _candleBorderVisible(),
    wickVisible:   S.wickVisible !== false,
    wickUpColor:   C.wickUp,   wickDownColor: C.wickDown,   // 還原紅綠影線色(線型時被改成折線色)
  };
}

// 套用目前圖型：線型＝蠟燭全透明(標記仍在、依附 candleSeries 不變)＋顯示收盤折線；蠟燭＝還原顏色、隱藏折線。
function applyChartType() {
  const line = !!window._chartTypeLine;
  try {
    // 線型:純收盤折線——蠟燭實體/邊框/影線全隱藏(使用者:修回一開始那樣、只有一條線)。
    if (candleSeries) candleSeries.applyOptions(line
      ? { upColor: "rgba(0,0,0,0)", downColor: "rgba(0,0,0,0)", borderVisible: false, wickVisible: false }
      : _candleColorOpts());
    if (lineSeries) lineSeries.applyOptions({ visible: line });
  } catch (e) {}
  const btn = document.getElementById("chartTypeBtn");
  if (btn) {
    btn.classList.toggle("active", line);
    btn.textContent = line ? "🕯️ K線" : "📈 線型";
  }
}

// 切換圖型（按鈕）：記住偏好；只改可見性，不重載資料。
window.toggleChartType = function (on) {
  window._chartTypeLine = (on === undefined) ? !window._chartTypeLine : !!on;
  try { localStorage.setItem("chartTypeLine", window._chartTypeLine ? "1" : "0"); } catch (e) {}
  applyChartType();
  return window._chartTypeLine;
};

/* ── FVG 失衡缺口：在主圖蠟燭上畫半透明色塊（青=多頭/支撐、紅=空頭/壓力）── */
let _fvgZones = [];        // [{t1, t2|null, top, bot, d}]（已轉成圖表時間）
let _fvgPrimitive = null;
let _stratMarkersPrim = null;   // 策略方向標記 primitive（多/空·破多空·順多空，隨 K 棒縮放、同步不抖）
const _STRAT_MAX_SCALE = 2.5;   // 策略標籤放大倍率上限：放大主圖時標籤到此倍率就不再變大（避免過大）
let _fvgShow = true;
let _fvgLevelsShow = true;   // FVG 交易位階線主開關（預設開＝允許顯示，但只畫「被點選」那個缺口）
let _fvgSelected = null;     // 目前點選的缺口（只有它畫止損/止盈線；null＝全部隱藏）
let _fvgMinW = 0;            // FVG 最小寬度%（使用者自定）：寬度 < 此值的缺口不畫（純顯示過濾，不影響策略）
function _makeFVGPrimitive() {
  let _chart = null, _series = null, _req = null;
  let _fvgSettleT = null;   // 平移中跳過文字/菱形後，停手補畫一次（否則沒有重繪事件、細節不回來）
  const renderer = {
    draw(target) {
      if (!_fvgShow || !_fvgZones.length || !_chart || !_series) return;
      const ts = _chart.timeScale();
      // 可視時間範圍：整盒在視窗外就略過（廉價數值判斷、在任何 timeToCoordinate 之前）→
      // 平移時不再對「全部缺口」逐個算座標/跑 pens/畫標籤，只處理螢幕上看得到的那幾個（大幅去卡）。
      let _vrng = null; try { _vrng = ts.getVisibleRange(); } catch (e) {}
      const _lo = _vrng ? _vrng.from : -Infinity, _hi = _vrng ? _vrng.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        const wpx = scope.mediaSize.width;
        const hpx = scope.mediaSize.height;   // 垂直 cull 用：整盒價格在可視區外就不畫
        // 平移/縮放進行中 → 只畫方框，跳過寬度%文字與進場菱形（canvas 文字與逐點路徑最貴）→ 平移更順。
        //   停手後沒有重繪事件會讓細節不回來 → 用 debounce timer 在停手補畫一次（那時 _mv=false→全細節）。
        const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const _mv = !!(window._chartMoveTs && _nowP - window._chartMoveTs < 220);
        if (_mv) { clearTimeout(_fvgSettleT); _fvgSettleT = setTimeout(() => { if (_req) _req(); }, 240); }
        else { ctx.font = `${Math.round(10 * vr)}px sans-serif`; ctx.textBaseline = "middle"; ctx.textAlign = "left"; }
        const _fltGopp = !!window._fvgFilterGopp, _fltGvol = !!window._fvgFilterGvol;
        for (const z of _fvgZones) {
          if (z.t1 > _hi) continue;                       // 整盒在視窗右側外
          if (z.t2 != null && z.t2 < _lo) continue;       // 整盒在視窗左側外（t2=null＝延伸到右緣，永不判為左外）
          if (_fltGopp && !z.go) continue;                // 只顯示 g 逆兩側方向的缺口
          if (_fltGvol && !z.gv) continue;                // 只顯示 g 量 < g+1 量的缺口
          // 使用者自定最小寬度過濾：寬度% = 多(top−bot)/bot、空(top−bot)/top（對齊標籤定義）
          if (_fvgMinW > 0) {
            const _zw = (z.d === "l" ? (z.top - z.bot) / z.bot : (z.top - z.bot) / z.top) * 100;
            if (_zw < _fvgMinW) continue;
          }
          let x1 = ts.timeToCoordinate(z.t1);
          // 形成點(t1)捲出左邊界外→timeToCoordinate 回 null。已排除「整盒右外(t1>_hi)」「整盒左外(t2<_lo)」，
          //   此時 null＝t1 在畫面左側外但盒延伸進畫面 → 夾到左緣 0，讓「更早前的老缺口」仍往近期畫出帶狀(否則整盒消失)。
          if (x1 == null) x1 = 0;
          let x2 = (z.t2 != null) ? ts.timeToCoordinate(z.t2) : null;
          if (x2 == null) x2 = wpx;                      // 未填補(或 t2 落在右界外) → 延伸到右緣
          if (x2 <= x1) x2 = x1 + 1;
          const yT = _series.priceToCoordinate(z.top);
          const yB = _series.priceToCoordinate(z.bot);
          if (yT == null || yB == null) continue;
          if (Math.max(yT, yB) < 0 || Math.min(yT, yB) > hpx) continue;   // 整盒價格在畫面上/下方外 → 不畫(省 fillRect)
          const bx = x1 * hr, bw = (x2 - x1) * hr;
          const byTop = Math.min(yT, yB) * vr, bh = Math.abs(yB - yT) * vr;
          const _faint = false;      // 不再淡化任何缺口(使用者要求全部照常顯示；dim/used 皆不影響顯示)
          if (_faint) ctx.globalAlpha = 0.38;
          ctx.fillStyle   = z.d === "l" ? "rgba(38,198,166,0.08)" : "rgba(255,82,82,0.08)";   // 收斂:太亮→降淡(0.14→0.08)
          ctx.fillRect(bx, byTop, bw, bh);
          // 虛線邊框已移除(使用者:FVG 不要有虛線匡)→ 只留填色色塊。
          // 寬度% 數字：使用者要求不再顯示（缺口盒保留、只是不標寬度百分比文字）。
          // 「吃到 FVG 的點位」(pens 突破菱形) 使用者要求隱藏 → 不再畫。
          // 交易位階線：止盈(綠=2W)、止損(紅=g-1頂端)，沿盒寬 x1→x2 畫水平虛線。
          //   預設隱藏（缺口太多會洗版）→ 只有「被點選」的缺口才畫，避免主圖滿屏線。
          if (_fvgLevelsShow && z === _fvgSelected) {
            ctx.lineWidth = Math.max(1, hr);
            ctx.setLineDash([5 * hr, 4 * hr]);
            if (z.tp != null) {
              const yTP = _series.priceToCoordinate(z.tp);
              if (yTP != null) {
                ctx.strokeStyle = "rgba(38,198,166,0.8)";
                ctx.beginPath(); ctx.moveTo(bx, yTP * vr); ctx.lineTo(bx + bw, yTP * vr); ctx.stroke();
              }
            }
            if (z.sl != null) {
              const ySL = _series.priceToCoordinate(z.sl);
              if (ySL != null) {
                ctx.strokeStyle = "rgba(239,83,80,0.8)";
                ctx.beginPath(); ctx.moveTo(bx, ySL * vr); ctx.lineTo(bx + bw, ySL * vr); ctx.stroke();
              }
            }
            ctx.setLineDash([]);
          }
          if (_faint) ctx.globalAlpha = 1;               // 復原 alpha，不影響下一個缺口
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) {
      _chart = p.chart; _series = p.series; _req = p.requestUpdate;
      // 點選缺口 → 只顯示它的止損/止盈線；再點同一個或點空白 → 取消。
      try {
        _chart.subscribeClick(param => {
          if (!param || !param.point || param.time == null) { _fvgSelected = null; if (_req) _req(); return; }
          const price = _series.coordinateToPrice(param.point.y);
          if (price == null) { _fvgSelected = null; if (_req) _req(); return; }
          const cands = _fvgZones.filter(z => {
            const lo = Math.min(z.bot, z.top), hi = Math.max(z.bot, z.top);
            if (price < lo || price > hi) return false;
            const t2 = (z.t2 != null) ? z.t2 : Infinity;       // 未填補→延伸到右緣
            return param.time >= z.t1 && param.time <= t2;
          });
          // 多個缺口重疊時，挑「盒高最小」那個（最貼近你點的那條缺口）
          let hit = null;
          for (const z of cands) {
            if (!hit || Math.abs(z.top - z.bot) < Math.abs(hit.top - hit.bot)) hit = z;
          }
          _fvgSelected = (hit && hit === _fvgSelected) ? null : hit;   // 再點同一個→取消
          if (_req) _req();
        });
      } catch (e) { /* 舊版 LWC 無 subscribeClick 時略過 */ }
    },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 餵入後端 fvg 陣列 [{t, top, bot, d, t2}] → 轉圖表時間並重繪
function setFVGZones(list) {
  _fvgZones = (Array.isArray(list) ? list : []).map(z => ({
    t1: toTime(z.t), t2: (z.t2 != null ? toTime(z.t2) : null),
    top: z.top, bot: z.bot, d: z.d, inv: !!z.inv,   // inv=IFVG(反轉缺口,反方向換色)
    go: z.go === true, gv: z.gv === true,           // go=g逆兩側方向、gv=g量<g+1量（前端可選過濾用）
    dim: !!z.dim,                                   // dim=同向缺口堆疊(下方0.5W帶內)→無效(淺色、不採用)
    used: z.used !== false,                          // used=false→沒被任何標記用到→淡化(舊資料無此欄→預設true不淡化)
    sl: (z.sl != null ? z.sl : null), tp: (z.tp != null ? z.tp : null),  // 止損(g-1頂端)/止盈(2W)
    ett: (z.ett != null ? toTime(z.ett) : null),   // 進場-上緣觸及
    etm: (z.etm != null ? toTime(z.etm) : null),   // 進場-中線觸及
    etb: (z.etb != null ? toTime(z.etb) : null),   // 進場-下緣觸及
    pens: (Array.isArray(z.pens)                    // 每被突破一次的點 {t,p}：轉圖表時間、濾掉壞值
      ? z.pens.map(e => ({ t: toTime(e.t), p: e.p })).filter(e => e.t != null && e.p != null) : []),
  })).filter(z => z.t1 != null && z.top != null && z.bot != null && !z.inv);   // IFVG(inv) 先關閉：不顯示反轉缺口色塊
  _fvgSelected = null;                       // 資料重載→清除點選(舊物件已不在新陣列裡)
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
}
// 開關（預設開）：window.toggleFVG() 切換
function toggleFVG(on) {
  _fvgShow = (on === undefined) ? !_fvgShow : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgShow;
}
// FVG 可選過濾開關：只顯示符合條件的缺口（純顯示、不影響偵測/勝率）。
window.toggleFvgFilterGopp = function (on) {   // g 方向與 g-1、g+1 皆相反
  window._fvgFilterGopp = (on === undefined) ? !window._fvgFilterGopp : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return window._fvgFilterGopp;
};
window.toggleFvgFilterGvol = function (on) {   // g 成交量 < g+1 成交量
  window._fvgFilterGvol = (on === undefined) ? !window._fvgFilterGvol : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return window._fvgFilterGvol;
};

// ── 前一日高低(PDH/PDL)：小時框圖上，每個日段畫『前一交易日(UTC)日內最高/最低』水平線 ──
//   紅虛線=前日高(壓力 PDH)、綠虛線=前日低(支撐 PDL)；隨捲動每天更新(當日看昨日、往回看各自前日)。
let _pdhlPrim = null;
let _pdhlCache = { sig: "", days: null };
function _pdhlDays() {
  const n = (typeof ohlcvData !== "undefined" && ohlcvData) ? ohlcvData.length : 0;
  if (!n) return null;
  const dv = (typeof _dataVersion !== "undefined") ? _dataVersion : 0;
  const sig = dv + ":" + n + ":" + ohlcvData[n - 1].time;
  if (_pdhlCache.sig === sig && _pdhlCache.days) return _pdhlCache.days;
  const days = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const b = ohlcvData[i];
    const ct = toTime(b.time);
    const dk = Math.floor((ct - 8 * 3600) / 86400);   // UTC 日(對齊日K換日)
    if (!cur || cur.dk !== dk) { cur = { dk, t0: ct, t1: ct, hi: b.high, lo: b.low }; days.push(cur); }
    else { cur.t1 = ct; if (b.high > cur.hi) cur.hi = b.high; if (b.low < cur.lo) cur.lo = b.low; }
  }
  _pdhlCache = { sig, days };
  return days;
}
function _makePDHLPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!window._pdhlOn || !_chart || !_series) return;
      const days = _pdhlDays();
      if (!days || days.length < 2) return;
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        ctx.font = `${Math.round(10 * vrr)}px sans-serif`; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
        for (let i = 1; i < days.length; i++) {
          const d = days[i], prev = days[i - 1];
          if (d.t1 < lo || d.t0 > hi) continue;
          const x0 = ts.timeToCoordinate(d.t0), x1 = ts.timeToCoordinate(d.t1);
          if (x0 == null || x1 == null) continue;
          const bx0 = x0 * hr, bx1 = Math.max(x1 * hr, bx0 + 2 * hr);
          const lines = [[prev.hi, "255,82,82"], [prev.lo, "38,198,166"]];   // 紅=前日高、綠=前日低
          for (const [price, rgb] of lines) {
            const y = _series.priceToCoordinate(price);
            if (y == null) continue;
            const yy = y * vrr;
            ctx.strokeStyle = `rgba(${rgb},0.85)`; ctx.lineWidth = Math.max(1, 1.3 * hr);
            ctx.setLineDash([6 * hr, 4 * hr]);
            ctx.beginPath(); ctx.moveTo(bx0, yy); ctx.lineTo(bx1, yy); ctx.stroke();
            ctx.setLineDash([]);
            const lbl = (price === prev.hi ? "前日高" : "前日低");
            const lx = Math.max(bx0 + 3 * hr, 3 * hr);
            ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = Math.max(2, 2 * hr); ctx.strokeStyle = "rgba(0,0,0,0.5)";
            ctx.strokeText(lbl, lx, yy - 2 * vrr);
            ctx.fillStyle = `rgba(${rgb},1)`; ctx.fillText(lbl, lx, yy - 2 * vrr);
          }
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {}, paneViews() { return [paneView]; }, requestUpdate() { if (_req) _req(); },
  };
}
window.togglePDHL = function (on) {
  window._pdhlOn = (on === undefined) ? !window._pdhlOn : !!on;
  if (_pdhlPrim) _pdhlPrim.requestUpdate();
  return window._pdhlOn;
};

// ── 外包吞噬掃蕩(engulf sweep)──
// 第2根同時吃掉第1根的上影高與下影低(high2>high1 且 low2<low1)、且兩根方向相反(異色)：
// 第2根一根就掃掉前一根上下兩側流動性 → 反轉訊號。方向＝第2根(收多=吞多▲下、收空=吞空▼上)。
let _engulfPrim = null;
let _engulfCache = { sig: "", pts: null };
function _engulfPts() {
  const n = (typeof ohlcvData !== "undefined" && ohlcvData) ? ohlcvData.length : 0;
  if (n < 2) return null;
  const dv = (typeof _dataVersion !== "undefined") ? _dataVersion : 0;
  const sig = dv + ":" + n + ":" + ohlcvData[n - 1].time;
  if (_engulfCache.sig === sig && _engulfCache.pts) return _engulfCache.pts;
  const pts = [];
  for (let i = 1; i < n; i++) {
    const a = ohlcvData[i - 1], b = ohlcvData[i];
    if (!(b.high > a.high && b.low < a.low)) continue;          // 第2根上下兩側都超過第1根
    const da = a.close > a.open ? 1 : (a.close < a.open ? -1 : 0);
    const db = b.close > b.open ? 1 : (b.close < b.open ? -1 : 0);
    if (da === 0 || db === 0 || da === db) continue;            // 兩根方向須相反(排除十字)
    pts.push({ t: toTime(b.time), dir: db, hi: b.high, lo: b.low });   // dir: +1=吞多、-1=吞空
  }
  _engulfCache = { sig, pts };
  return pts;
}
function _makeEngulfPrimitive() {
  let _chart = null, _series = null, _req = null, _settleT = null;
  const renderer = {
    draw(target) {
      if (!window._engulfOn || !_chart || !_series) return;
      const pts = _engulfPts();
      if (!pts || !pts.length) return;
      const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (window._chartMoveTs && _nowP - window._chartMoveTs < 220) { clearTimeout(_settleT); _settleT = setTimeout(() => { if (_req) _req(); }, 240); return; }
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        ctx.font = `bold ${Math.round(10 * vrr)}px sans-serif`; ctx.textAlign = "center";
        for (const p of pts) {
          if (p.t < lo || p.t > hi) continue;
          const x = ts.timeToCoordinate(p.t);
          if (x == null) continue;
          const bx = x * hr;
          const bull = p.dir > 0;
          const rgb = bull ? "38,198,166" : "239,83,80";
          const y = _series.priceToCoordinate(bull ? p.lo : p.hi);
          if (y == null) continue;
          const yy = y * vrr;
          const s = 6 * hr;                                     // 三角尺寸
          const ty = yy + (bull ? 1 : -1) * 10 * vrr;           // 多在低點下方、空在高點上方
          ctx.fillStyle = `rgba(${rgb},1)`;
          ctx.beginPath();
          if (bull) { ctx.moveTo(bx, ty); ctx.lineTo(bx - s, ty + s * 1.4); ctx.lineTo(bx + s, ty + s * 1.4); }   // ▲ 指上
          else      { ctx.moveTo(bx, ty); ctx.lineTo(bx - s, ty - s * 1.4); ctx.lineTo(bx + s, ty - s * 1.4); }   // ▼ 指下
          ctx.closePath(); ctx.fill();
          const lbl = bull ? "吞多" : "吞空";
          const lty = bull ? (ty + s * 1.4 + 11 * vrr) : (ty - s * 1.4 - 3 * vrr);
          ctx.textBaseline = bull ? "top" : "bottom";
          ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = Math.max(2, 2 * hr);
          ctx.strokeText(lbl, bx, lty);
          ctx.fillStyle = `rgba(${rgb},1)`; ctx.fillText(lbl, bx, lty);
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {}, paneViews() { return [paneView]; }, requestUpdate() { if (_req) _req(); },
  };
}
window.toggleEngulf = function (on) {
  window._engulfOn = (on === undefined) ? !window._engulfOn : !!on;
  if (_engulfPrim) _engulfPrim.requestUpdate();
  return window._engulfOn;
};

// ── Swing point 擺動點(3根分形)──
// 連續三根,中間根的高是三根最高(high2>high1 且 high2>high3)＝擺動高(紅點在高點上方);
// 中間根的低是三根最低(low2<low1 且 low2<low3)＝擺動低(綠點在低點下方)。可同時成立(外包棒)。
// 最後一根不算(需右鄰確認,收盤才定;非 repaint)。
let _swingPrim = null;
let _swingCache = { sig: "", pts: null };
function _swingPts() {
  const n = (typeof ohlcvData !== "undefined" && ohlcvData) ? ohlcvData.length : 0;
  if (n < 3) return null;
  const dv = (typeof _dataVersion !== "undefined") ? _dataVersion : 0;
  const sig = dv + ":" + n + ":" + ohlcvData[n - 1].time;
  if (_swingCache.sig === sig && _swingCache.pts) return _swingCache.pts;
  const pts = [];
  for (let i = 1; i < n - 1; i++) {                     // 中間根 i；最後一根(n-1)無右鄰→不算
    const a = ohlcvData[i - 1], b = ohlcvData[i], c = ohlcvData[i + 1];
    const hiSw = b.high > a.high && b.high > c.high;    // 擺動高
    const loSw = b.low  < a.low  && b.low  < c.low;     // 擺動低
    if (!hiSw && !loSw) continue;
    pts.push({ t: toTime(b.time), hiSw, loSw, hi: b.high, lo: b.low });
  }
  _swingCache = { sig, pts };
  return pts;
}
function _makeSwingPrimitive() {
  let _chart = null, _series = null, _req = null, _settleT = null;
  const renderer = {
    draw(target) {
      if (!window._swingOn || !_chart || !_series) return;
      const pts = _swingPts();
      if (!pts || !pts.length) return;
      // 平移/縮放中：略過整層點,停手後補畫一次（與 FVG 同機制→開著也不拖慢平移）
      const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (window._chartMoveTs && _nowP - window._chartMoveTs < 220) { clearTimeout(_settleT); _settleT = setTimeout(() => { if (_req) _req(); }, 240); return; }
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        const r = 2.6 * Math.max(hr, vrr);               // 圓點半徑
        for (const p of pts) {
          if (p.t < lo || p.t > hi) continue;
          const x = ts.timeToCoordinate(p.t);
          if (x == null) continue;
          const bx = x * hr;
          if (p.hiSw) {                                  // 擺動高:紅點在高點上方
            const y = _series.priceToCoordinate(p.hi);
            if (y != null) _dot(ctx, bx, y * vrr - 7 * vrr, r, "239,83,80");
          }
          if (p.loSw) {                                  // 擺動低:綠點在低點下方
            const y = _series.priceToCoordinate(p.lo);
            if (y != null) _dot(ctx, bx, y * vrr + 7 * vrr, r, "38,198,166");
          }
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {}, paneViews() { return [paneView]; }, requestUpdate() { if (_req) _req(); },
  };
}
function _dot(ctx, cx, cy, r, rgb) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${rgb},1)`; ctx.fill();
  ctx.lineWidth = Math.max(1, r * 0.5); ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.stroke();
}
window.toggleSwing = function (on) {
  window._swingOn = (on === undefined) ? !window._swingOn : !!on;
  if (_swingPrim) _swingPrim.requestUpdate();
  return window._swingOn;
};

// ── 策略方向標記 primitive（多/空·破多空·順多空）──
//   資料源＝全域 lastFVGBreakMarkers/lastFVGMSMarkers/lastFVGShunMarkers（{time,position,color,text}）。
//   在圖表自身繪製流程畫箭頭+文字，縮放時與 K 棒同步(不像 overlay 慢一幀游移)，尺寸依 barSpacing 連續縮放。
//   開關(_fvgBreakHidden/_fvgMSHidden/_fvgShunHidden)、大棒淡化(_dimBigBarOn/_dimHex)、上下定位(該棒 high/low)、同棒同側堆疊。
// 策略標記文字「貼圖快取」：fillText 每幀每標記很貴 → 每個(文字+顏色+字級)烤一次小 sprite，
//   之後改 drawImage 貼上(便宜很多)。字級量化到 2px 桶 → 縮放時多半命中快取、不必每幀重烤。文字全程顯示。
const _stratGlyphCache = new Map();
let _stratGlyphMeas = null;
function _stratGlyph(text, color, fpx) {
  const key = text + "|" + color + "|" + fpx;
  let e = _stratGlyphCache.get(key);
  if (e) return e;
  if (!_stratGlyphMeas) _stratGlyphMeas = document.createElement("canvas").getContext("2d");
  const font = `bold ${fpx}px sans-serif`;
  _stratGlyphMeas.font = font;
  const padg = Math.ceil(fpx * 0.35);
  const w = Math.ceil(_stratGlyphMeas.measureText(text).width) + padg * 2;
  const h = fpx + padg * 2;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const g = cv.getContext("2d");
  g.font = font; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = color;
  g.fillText(text, w / 2, h / 2);
  e = { cv, w, h };
  _stratGlyphCache.set(key, e);
  return e;
}

// 大時框順勢過濾：用「當前時框的滾動 VWAP」逼近『更高時框』的公平價/成本線（回看期 =
//   20×時框倍數，同 wall-clock 跨度逼近高時框）。價在 VWAP 之上=大時框多頭偏、之下=空頭偏
//   （VWAP=成交量加權,反映大家實際成交的平均價,比純均線更有機構成本線意義）。
//   逆勢的策略標記(空/破多在多頭、多/破空在空頭)淡化。純視覺過濾、不改勝率計算。
const _HTF_MULT = { "1m": 15, "5m": 6, "15m": 4, "30m": 4, "1h": 4, "2h": 4, "4h": 6, "1d": 7, "1w": 4, "1M": 3 };
let _ctTrendCache = { sig: "", arr: null };
function _getHtfTrend() {
  const n = (typeof ohlcvData !== "undefined" && ohlcvData) ? ohlcvData.length : 0;
  if (!n) return null;
  const tf = (typeof currentTF !== "undefined" && currentTF) || "";
  const mult = _HTF_MULT[tf] || 4;
  const period = Math.max(40, Math.min(300, mult * 20));
  const dv = (typeof _dataVersion !== "undefined") ? _dataVersion : 0;
  const sig = `${dv}|${tf}|${n}|${period}|vwap`;
  if (_ctTrendCache.sig === sig && _ctTrendCache.arr) return _ctTrendCache.arr;
  const arr = new Array(n).fill(0);
  // 前綴和 O(n)：滾動 VWAP = 窗內 Σ(典型價 HLC/3 × 量) / Σ(量)
  const pv = new Float64Array(n + 1), vv = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const bar = ohlcvData[i];
    const tp = (bar.high + bar.low + bar.close) / 3;
    const vol = bar.volume || 0;
    pv[i + 1] = pv[i] + tp * vol;
    vv[i + 1] = vv[i] + vol;
  }
  for (let i = period; i < n; i++) {   // 暖機 period 根後才給方向
    const j = i - period + 1;          // 窗 = [j, i] 共 period 根
    const wv = vv[i + 1] - vv[j];
    if (wv <= 0) continue;
    const vwap = (pv[i + 1] - pv[j]) / wv;
    const c = ohlcvData[i].close;
    arr[i] = c > vwap ? 1 : (c < vwap ? -1 : 0);
  }
  _ctTrendCache = { sig, arr };
  return arr;
}

function _makeStratMarkersPrimitive() {
  let _chart = null, _series = null, _req = null;
  const _visSlice = (arr, lo, hi) => {   // arr 依 time 升序 → 二分找可見區段
    let a = 0, b = arr.length;
    while (a < b) { const m = (a + b) >> 1; arr[m].time < lo ? a = m + 1 : b = m; }
    const start = a; b = arr.length;
    while (a < b) { const m = (a + b) >> 1; arr[m].time <= hi ? a = m + 1 : b = m; }
    return [start, a];
  };
  const renderer = {
    draw(target) {
      if (!_chart || !_series || typeof ohlcvData === "undefined" || !ohlcvData.length) return;
      if (typeof _secToIdx === "undefined" || _secToIdx.size === 0) return;
      const groups = [];   // 依原生合併順序(破→多空→順)決定同棒堆疊先後
      if (!window._fvgBreakHidden && typeof lastFVGBreakMarkers !== "undefined") groups.push(lastFVGBreakMarkers);
      if (!window._fvgMSHidden    && typeof lastFVGMSMarkers    !== "undefined") groups.push(lastFVGMSMarkers);
      if (!window._fvgShunHidden  && typeof lastFVGShunMarkers  !== "undefined") groups.push(lastFVGShunMarkers);
      if (!window._fvgSpecialHidden && typeof lastFVGSpecialMarkers !== "undefined") groups.push(lastFVGSpecialMarkers);
      if (!groups.length) return;
      const ts = _chart.timeScale();
      const bs = ts.options().barSpacing;
      if (!bs || !isFinite(bs) || bs <= 0) return;
      // 以 barSpacing≈8(常態)為 1x；放大上限 _STRAT_MAX_SCALE(放大主圖時標籤到此倍率就不再變大)、縮小下限 0.7x
      const scale = Math.max(0.7, Math.min(_STRAT_MAX_SCALE, bs / 8));
      let vrng = null; try { vrng = ts.getVisibleRange(); } catch (e) {}
      const lo = vrng ? vrng.from : -Infinity, hi = vrng ? vrng.to : Infinity;
      const dimOn = !!window._dimBigBarOn;
      const dimVolOn = !!window._dimVolOn;
      const dimCTOn = !!window._dimCounterTrendOn;
      const _htfTrend = dimCTOn ? _getHtfTrend() : null;
      const n = ohlcvData.length;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        const arrowH = 9 * scale * vr, arrowW = 8 * scale * hr;
        // 字級固定 11px(與繪圖工具標籤同級、不隨縮放)：繪圖文字全是固定字級,策略字若隨縮放
        // 連續變大(舊版 7.7~27.5px)會與畫的線/框標籤失衡 → 只有箭頭隨縮放,文字恆定。
        const fontPx = 11 * vr;
        const gap = 3 * scale * vr, pad = 2 * scale * vr;
        const glyphH = arrowH + fontPx + gap + pad + 2 * vr;   // 單一標記縱向佔用(堆疊用)
        const stepAbove = new Map(), stepBelow = new Map();
        // 貼圖烤在「8px 粗桶(向上取)」、繪製時 drawImage 縮放到即時 fontPx →
        //   文字跟縮放平滑連續變大小(比 2px 跳桶更順)、且縮放全程幾乎不會重烤貼圖(重烤=縮放小卡頓源)。
        //   向上取桶=永遠縮小繪製(不放大) → 不會糊。
        const fpx = Math.max(8, Math.ceil(fontPx / 8) * 8);
        const _gk = fontPx / fpx;   // 每幀連續縮放比(≤1)
        for (const arr of groups) {
          if (!arr.length) continue;
          const [s, e] = _visSlice(arr, lo, hi);
          for (let i = s; i < e; i++) {
            const m = arr[i];
            const idx = _secToIdx.get(m.time);
            if (idx == null || idx >= n) continue;
            const bar = ohlcvData[idx];
            if (!bar) continue;
            const xc = ts.timeToCoordinate(m.time);
            if (xc == null) continue;
            const above = m.position === "aboveBar";
            const yc = _series.priceToCoordinate(above ? bar.high : bar.low);
            if (yc == null) continue;
            let color = m.color;
            let _dim = false;
            // 大棒淡化：標記棒全長(high-low) > 前 10 根平均全長的 2 倍 → 淡化
            if (dimOn && idx >= 10) {
              const range = bar.high - bar.low; let sum = 0;
              for (let k = idx - 10; k < idx; k++) sum += (ohlcvData[k].high - ohlcvData[k].low);
              if (range > (sum / 10) * 2) _dim = true;
            }
            // 量淡化(測驗)：標記棒成交量「小於前三根其中一根」→ 保留；否則(≥前三根全部＝量能高點)→ 淡化
            if (!_dim && dimVolOn && idx >= 3) {
              const v = bar.volume || 0;
              const v1 = ohlcvData[idx-1].volume || 0, v2 = ohlcvData[idx-2].volume || 0, v3 = ohlcvData[idx-3].volume || 0;
              if (!(v < v1 || v < v2 || v < v3)) _dim = true;   // 沒有一根比它大 → 它≥前三根全部 → 淡化
            }
            // 大時框順勢過濾：逆大時框趨勢的標記淡化。方向看 position（aboveBar=空方(含破多)、
            //   belowBar=多方(含破空)）——不能用文字「多/空」，因為「破多」是看空、「破空」是看多。
            if (!_dim && dimCTOn && _htfTrend) {
              const tr = _htfTrend[idx];
              if (tr > 0 && above) _dim = true;         // 大時框多頭、卻是空方標記 → 淡化
              else if (tr < 0 && !above) _dim = true;   // 大時框空頭、卻是多方標記 → 淡化
            }
            if (_dim && typeof _dimHex === "function") color = _dimHex(color);
            ctx.fillStyle = color;
            // 暫定(未收盤)訊號：半透明+空心箭頭(描邊不填滿)→ 一眼看出「未確認、收盤才算」
            const prov = !!m.prov;
            if (prov) { ctx.globalAlpha = 0.5; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, 1.4 * scale) * hr; }
            const x = xc * hr, yBar = yc * vr;
            if (above) {
              const off = stepAbove.get(idx) || 0;
              const tipY = yBar - gap - off;                 // 尖端朝下、貼近 high 上方
              ctx.beginPath();
              ctx.moveTo(x, tipY);
              ctx.lineTo(x - arrowW / 2, tipY - arrowH);
              ctx.lineTo(x + arrowW / 2, tipY - arrowH);
              ctx.closePath(); if (prov) ctx.stroke(); else ctx.fill();
              const glA = _stratGlyph(m.text, color, fpx);   // 貼圖文字（取代 fillText）；縮放比 _gk 隨縮放連續縮
              const _wA = glA.w * _gk, _hA = glA.h * _gk;
              ctx.drawImage(glA.cv, Math.round(x - _wA / 2), Math.round(tipY - arrowH - pad - _hA), Math.round(_wA), Math.round(_hA));
              stepAbove.set(idx, off + glyphH);
            } else {
              const off = stepBelow.get(idx) || 0;
              const tipY = yBar + gap + off;                 // 尖端朝上、貼近 low 下方
              ctx.beginPath();
              ctx.moveTo(x, tipY);
              ctx.lineTo(x - arrowW / 2, tipY + arrowH);
              ctx.lineTo(x + arrowW / 2, tipY + arrowH);
              ctx.closePath(); if (prov) ctx.stroke(); else ctx.fill();
              const glB = _stratGlyph(m.text, color, fpx);   // 貼圖文字（取代 fillText）；縮放比 _gk 隨縮放連續縮
              const _wB = glB.w * _gk, _hB = glB.h * _gk;
              ctx.drawImage(glB.cv, Math.round(x - _wB / 2), Math.round(tipY + arrowH + pad), Math.round(_wB), Math.round(_hB));
              stepBelow.set(idx, off + glyphH);
            }
            if (prov) ctx.globalAlpha = 1;                   // 復原,不影響下一個標記
          }
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; }, zOrder() { return "top"; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 策略標記資料/開關/淡化變動時觸發重畫（由 render.js 的 _applyMainMarkers 呼叫）
function _stratMarkersUpdate() { if (_stratMarkersPrim) _stratMarkersPrim.requestUpdate(); }

// 交易位階線開關：window.toggleFVGLevels() 切換（止盈2W／止損g-1頂端）
function toggleFVGLevels(on) {
  _fvgLevelsShow = (on === undefined) ? !_fvgLevelsShow : !!on;
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgLevelsShow;
}
// FVG 最小寬度%（使用者自定）：寬度小於 pct 的缺口不顯示。0＝全顯示。即時重繪。
function setFVGMinWidth(pct) {
  _fvgMinW = Math.max(0, +pct || 0);
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgMinW;
}
window.setFVGZones = setFVGZones;
window.setFVGMinWidth = setFVGMinWidth;
window.toggleFVG = toggleFVG;
window.toggleFVGLevels = toggleFVGLevels;

/* ── FVG 逐筆止損/止盈價位線：每筆從進場(et)→出場(xt)畫水平線段（紅虛=止損、綠虛=止盈；
      深檔拉近會在 tp2t 階梯下移到近靶）。隨 window._fvgTradesHidden 與 FVG 標記同步開關。── */
let _fvgTradeLines = [];   // [{et, xt, sl, tpf, tpn, tp2t}]（時間已轉圖表時間）
let _fvgTLPrim = null;
function _makeFVGTradeLinePrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (window._fvgTradesHidden || !_fvgTradeLines.length || !_chart || !_series) return;
      const ts = _chart.timeScale();
      let _vrng = null; try { _vrng = ts.getVisibleRange(); } catch (e) {}
      const _lo = _vrng ? _vrng.from : -Infinity, _hi = _vrng ? _vrng.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        for (const t of _fvgTradeLines) {
          if (t.et > _hi) continue;                       // 整段在視窗右側外
          if (t.xt != null && t.xt < _lo) continue;       // 整段在視窗左側外
          const x1 = ts.timeToCoordinate(t.et);
          if (x1 == null) continue;
          let x2 = (t.xt != null) ? ts.timeToCoordinate(t.xt) : null;
          if (x2 == null) x2 = x1 + 6;                  // 出場在畫面外 → 短殘段
          if (x2 <= x1) x2 = x1 + 1;
          ctx.lineWidth = Math.max(1, hr);
          ctx.setLineDash([4 * hr, 3 * hr]);
          // 止損線（紅）
          const ySL = _series.priceToCoordinate(t.sl);
          if (ySL != null) {
            ctx.strokeStyle = "rgba(239,83,80,0.85)";
            ctx.beginPath(); ctx.moveTo(x1 * hr, ySL * vr); ctx.lineTo(x2 * hr, ySL * vr); ctx.stroke();
          }
          // 止盈線（綠）：tp2t(深檔拉近)之前用 tpf、之後階梯到 tpn
          ctx.strokeStyle = "rgba(38,198,166,0.85)";
          const yF = _series.priceToCoordinate(t.tpf);
          const hasStep = (t.tp2t != null && t.tpn != null && t.tpn !== t.tpf);
          const xStep = hasStep ? ts.timeToCoordinate(t.tp2t) : null;
          if (xStep != null) {
            const yN = _series.priceToCoordinate(t.tpn);
            const xs = Math.max(x1, Math.min(xStep, x2));
            if (yF != null) { ctx.beginPath(); ctx.moveTo(x1 * hr, yF * vr); ctx.lineTo(xs * hr, yF * vr); ctx.stroke(); }
            if (yN != null) {
              if (yF != null) { ctx.beginPath(); ctx.moveTo(xs * hr, yF * vr); ctx.lineTo(xs * hr, yN * vr); ctx.stroke(); }
              ctx.beginPath(); ctx.moveTo(xs * hr, yN * vr); ctx.lineTo(x2 * hr, yN * vr); ctx.stroke();
            }
          } else if (yF != null) {
            ctx.beginPath(); ctx.moveTo(x1 * hr, yF * vr); ctx.lineTo(x2 * hr, yF * vr); ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 餵入後端 fvg_trades；rpCut（replay 當下圖表時間）→ 只畫已發生的、出場裁切到當下
function setFVGTradeLines(list, rpCut) {
  let arr = (Array.isArray(list) ? list : []).map(t => ({
    et: toTime(t.et), xt: (t.xt != null ? toTime(t.xt) : null),
    sl: t.sl, tpf: t.tpf, tpn: t.tpn, tp2t: (t.tp2t != null ? toTime(t.tp2t) : null),
  })).filter(t => t.et != null && t.sl != null && t.tpf != null);
  if (rpCut != null) {
    arr = arr.filter(t => t.et <= rpCut).map(t => ({
      ...t,
      xt: (t.xt == null || t.xt > rpCut) ? rpCut : t.xt,
      tp2t: (t.tp2t != null && t.tp2t > rpCut) ? null : t.tp2t,
    }));
  }
  _fvgTradeLines = arr;
  if (_fvgTLPrim) _fvgTLPrim.requestUpdate();
}
window.setFVGTradeLines = setFVGTradeLines;

/* ── 將 ohlcv 資料套用到目前 series ── */
function applyOhlcvToSeries(data) {
  if (!candleSeries || !data.length) return;
  {
    candleSeries.setData(data.map(d => ({
      time: d.time ? toTime(d.time) : d, open: d.open, high: d.high, low: d.low, close: d.close,
    })));
  }
  if (lineSeries) lineSeries.setData(   // 線型圖收盤折線；濾掉 null close(否則 LWC Line 拋「Value is null」)
    data.filter(d => d.close != null).map(d => ({ time: d.time ? toTime(d.time) : d, value: d.close })));
  updateLatestPriceLine(data[data.length - 1].close);
}

let _curPriceLabelEl = null;   // 現價的自訂 DOM 標籤（與十字線價格標籤同風格）

function updateLatestPriceLine(price) {
  if (!candleSeries || price == null) return;
  if (latestPriceLine) {
    try { latestPriceLine.applyOptions({ price }); }
    catch { latestPriceLine = null; }
  }
  if (!latestPriceLine) {
    latestPriceLine = candleSeries.createPriceLine({
      price,
      color: "rgba(255,145,71,.80)",
      lineWidth: 1,
      lineStyle: 2,            /* 2 = Dashed */
      axisLabelVisible: false, /* 關掉原生橘色標籤，改用下方自訂 DOM 標籤 */
      title: "",
    });
  }
  updateCurrentPriceLabel();
}

// 現價在右軸的標示：改成跟十字線價格標籤同款（圓角小卡、等寬字），不再用 LWC 原生方塊標籤。
function updateCurrentPriceLabel() {
  if (typeof candleSeries === "undefined" || !candleSeries) return;
  const mainEl = document.getElementById("mainChart");
  if (!mainEl) return;
  if (!_curPriceLabelEl || !_curPriceLabelEl.isConnected) {
    if (getComputedStyle(mainEl).position === "static") mainEl.style.position = "relative";
    _curPriceLabelEl = document.createElement("div");
    _curPriceLabelEl.className = "current-price-label";
    mainEl.appendChild(_curPriceLabelEl);
  }
  const lbl = _curPriceLabelEl;
  const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
  if (!n) { lbl.style.display = "none"; return; }
  let idx = n - 1;
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    idx = Math.min(idx, replayIdx);
  const price = ohlcvData[idx] && ohlcvData[idx].close;
  if (price == null) { lbl.style.display = "none"; return; }
  const y = candleSeries.priceToCoordinate(price);
  if (y == null) { lbl.style.display = "none"; return; }
  lbl.textContent = (typeof _fmtPx === "function") ? _fmtPx(price) : price.toFixed(2);
  lbl.style.top = Math.round(y) + "px";
  lbl.style.display = "block";
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
  // 布林 1σ 內帶已移除（使用者要求）：bbU1/bbL1 series 與相關引用皆已刪除（前後端皆不再計算/輸出）

  // 成交量疊在主圖下方（獨立 priceScaleId，不影響 K 棒價格軸）
  volSeries   = mainChart.addHistogramSeries({ priceScaleId:"volume", priceLineVisible:false, lastValueVisible:false });
  volMaSeries = mainChart.addLineSeries({ priceScaleId:"volume", color:(C.volMa||"#ffcc02"), lineWidth:1, priceLineVisible:false, lastValueVisible:false });
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
  window._invalidatePaneRects?.();   // 版面變動 → 作廢十字線 pane 座標快取
  const container = document.getElementById("chartsContainer");
  const w = container.clientWidth;
  // 訂單簿 DOM 開啟時，主圖 canvas 讓出右側面板寬度（副圖不受影響）
  const domP = document.getElementById("domPanel");
  const domW = (domP && domP.classList.contains("on")) ? domP.offsetWidth : 0;
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
    const cw = (id === "mainChart") ? Math.max(60, w - domW) : w;
    if (h > 10) chart.resize(cw, h);
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
    //   ⚠ 方向搶佔:若正在跑「補新」而使用者回頭往左→中止補新、立刻改補舊(否則共用旗標會擋掉→沒往舊補)
    if (p.range.from < 600 && ohlcvData.length) {
      const now = Date.now();
      const busyNewer = _bgLoadInProgress && window._bgLoadDir === "newer";
      if ((!_bgLoadInProgress || busyNewer) && now - _scrollLoadTs > 250) {
        _scrollLoadTs = now;
        if (busyNewer) _bgLoadInProgress = false;  // 放行補舊;補舊啟動時 ++_bgLoadGen 會令補新迴圈自行中止
        _bgLoadOlderBars(true); // 滑動觸發，分頁載入更早的資料（一次一塊）
      }
    }
    // 接近右側邊界 + 有往後缺口(捲歷史抓的有界視窗未到現在)→ 往「新(現在方向)」補;補完滾動修剪左側→常駐有界
    //   ⚠ 門檻用「n−60」(視野右緣真的貼近最新載入棒)而非 n−600:小的有界視窗(切換初態)下 n−600 會恆成立
    //     → 一進場就誤觸補新、與補舊互相觸發成迴圈把視野搞垮(span→1)。只在使用者真的滑到右牆才補。
    else if (window._hasFwdGap && p.range.to > ohlcvData.length - 60 && ohlcvData.length) {
      const now = Date.now();
      const busyOlder = _bgLoadInProgress && window._bgLoadDir === "older";
      if ((!_bgLoadInProgress || busyOlder) && now - _scrollLoadTs > 250) {
        _scrollLoadTs = now;
        if (busyOlder) _bgLoadInProgress = false;  // 搶佔:中止補舊改補新
        if (typeof _bgLoadNewerBars === "function") _bgLoadNewerBars(true);
      }
    }
  }
  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      // 標記「圖表正在移動」（平移/縮放/慣性）→ 供其它模組參考（背景天氣等；_uxMark 另追蹤連續互動 session）
      if (window._uxMark) window._uxMark();
      else window._chartMoveTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
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

  // 年份：固定顯示在價格軸下方的右下角（取右側可見範圍的年份），不再塞進游標時間標籤
  const yearLabel = document.createElement("div");
  yearLabel.className = "time-axis-year";
  container.appendChild(yearLabel);
  function updateYearLabel() {
    let yr = "";
    try {
      const r = mainChart.timeScale().getVisibleRange();
      if (r && r.to != null) yr = new Date(r.to * 1000).getUTCFullYear();
      else if (typeof ohlcvData !== "undefined" && ohlcvData.length)
        yr = new Date(toTime(ohlcvData[ohlcvData.length - 1].time) * 1000).getUTCFullYear();
    } catch (e) {}
    yearLabel.textContent = yr || "";
  }
  mainChart.timeScale().subscribeVisibleTimeRangeChange(updateYearLabel);
  setTimeout(updateYearLabel, 0);

  let hideTimer = null;

  // ── pane 版面座標快取 ──
  // 十字線每次滑鼠移動都要 3~4 個 getBoundingClientRect（強制重排）,但這些座標只在
  // 版面變動(視窗縮放/開關副圖)時才會變 → 快取 400ms + resizeAll 主動失效。
  // 實測平移中 gBCR 佔 CPU 取樣 4.4%,快取後歸零;數值完全相同、無視覺變化。
  let _prCache = null;
  window._invalidatePaneRects = () => { _prCache = null; };
  function _paneRects() {
    const now = performance.now();
    if (_prCache && now - _prCache.t < 400) return _prCache;
    const cRect = container.getBoundingClientRect();
    const panes = panesConf.map(({ elId }) => {
      const pane = document.getElementById(elId);
      if (!pane || pane.classList.contains("hidden")) return { hidden: true };
      if (pane.querySelector(".pane-body")?.style.display === "none") return { hidden: true };
      const rect = pane.getBoundingClientRect();
      let divH = 0;
      const nextSib = pane.nextElementSibling;
      if (nextSib?.classList.contains("pane-divider") && !nextSib.classList.contains("hidden")) {
        divH = nextSib.getBoundingClientRect().height;
      }
      return { hidden: false, rect, divH };
    });
    _prCache = { t: now, cRect, panes };
    return _prCache;
  }

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

    // ── 版面座標走 _paneRects() 快取（平移中零 getBoundingClientRect / 零強制重排）──
    const { cRect, panes } = _paneRects();
    let maxPaneBottom = cRect.top;        // 最底可見 pane 的底緣＝時間軸所在位置
    const plans = panesConf.map(({ chart }, i) => {
      const ln = lineEls[i];
      const pr = panes[i];
      if (!pr || pr.hidden) return { ln, hide: true };
      const paneX = chart.timeScale().timeToCoordinate(time) ?? mainX;   // canvas 座標，非版面讀取
      if (paneX == null) return { ln, hide: true };
      if (pr.rect.bottom > maxPaneBottom) maxPaneBottom = pr.rect.bottom;
      return { ln, hide: false, left: Math.round(paneX),
               top: Math.round(pr.rect.top - cRect.top),
               height: Math.round(pr.rect.height + pr.divH) };   // divH＝緊接的 pane-divider 高
    });

    // 底部時間標籤文字（月-日 (時:分)；年份改固定顯示在價格軸下方右下角）
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    const timeStr = ["4h","2h","1h","30m","15m","5m"].includes(currentTF)
      ? `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
      : `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;

    // ── 集中寫入 ──
    timeLabel.textContent = timeStr;
    timeLabel.style.display = "block";
    timeLabel.style.left    = Math.round(mainX) + "px";
    for (const p of plans) {
      if (p.hide) { p.ln.style.display = "none"; continue; }
      p.ln.style.display = "block";
      p.ln.style.left    = p.left + "px";
      p.ln.style.top     = p.top + "px";
      p.ln.style.height  = p.height + "px";
    }
    // 時間標籤錨定到時間軸（最底可見 pane 底緣），而非容器底。
    // 桌面容器底＝圖表底 → offset≈0；手機容器延伸到底部分頁列後方 → offset≈分頁列高，
    // 否則標籤會被推到時間軸下方、藏進 m-tabbar 後面而看不到。
    const axisOffset = Math.max(0, Math.round(cRect.bottom - maxPaneBottom));
    timeLabel.style.bottom = (axisOffset + (replayActive ? 42 : 0)) + "px";
  }

  // 用游標 x 直接定位鉛直線（給「最後一根K棒右側空白區」用：該處無對應時間，
  // 原生會把十字線時間 snap 到最後一根 → 線卡在最後一根不動。改用游標 x 讓線跟著進入空白）。
  function positionLinesByX(px) {
    timeLabel.style.display = "none";          // 空白區無對應時間 → 不顯示時間標籤
    const { cRect, panes } = _paneRects();     // 版面座標快取，同 positionLines
    panesConf.forEach((_, i) => {
      const ln = lineEls[i];
      const pr = panes[i];
      if (!pr || pr.hidden) { ln.style.display = "none"; return; }
      ln.style.display = "block";
      ln.style.left    = Math.round(px) + "px";
      ln.style.top     = Math.round(pr.rect.top - cRect.top) + "px";
      ln.style.height  = Math.round(pr.rect.height + pr.divH) + "px";
    });
  }

  panesConf.forEach(({ chart }) => {
    chart.subscribeCrosshairMove(param => {
      clearTimeout(hideTimer);
      // 游標在「最後一根K棒右側空白區」：用游標 x 直接定位鉛直線，跟著游標進入空白、不卡在最後一根
      if (param.point) {
        const ts = mainChart.timeScale();
        const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
        const lastX = n ? ts.logicalToCoordinate(n - 1) : null;
        let pw = ts.width();
        if (lastX != null && param.point.x > lastX + 0.5 && param.point.x <= pw) {
          positionLinesByX(param.point.x);
          if (typeof _updateHoverWR === "function") _updateHoverWR(null);
          return;
        }
      }
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

  // ── 主圖右側價格標籤：游標所在價格 + 距離「目前價(最新價線)」幾 % ──
  // 取代主圖原生橫線價格標籤（只在主圖；副圖維持原生數值標籤）。
  (function setupCrosshairPriceLabel() {
    const mainEl = document.getElementById("mainChart");
    if (!mainEl) return;
    if (getComputedStyle(mainEl).position === "static") mainEl.style.position = "relative";
    const lbl = document.createElement("div");
    lbl.className = "crosshair-price-label";
    mainEl.appendChild(lbl);
    mainChart.applyOptions({ crosshair: { horzLine: { labelVisible: false } } });

    mainChart.subscribeCrosshairMove(param => {
      if (!param.point || !candleSeries) { lbl.style.display = "none"; return; }
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null) { lbl.style.display = "none"; return; }
      // 參考價＝目前價（最新價線；重播時取「已揭曉」那根的收盤）
      const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
      let refIdx = n - 1;
      if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
        refIdx = Math.min(refIdx, replayIdx);
      const ref = (n && refIdx >= 0) ? ohlcvData[refIdx].close : null;
      const pct = (ref && ref !== 0) ? (price - ref) / ref * 100 : null;
      const priceStr = (typeof _fmtPx === "function") ? _fmtPx(price) : price.toFixed(2);
      // 高於現價=綠(漲)、低於=紅(跌)，寫死避免被任何設定反轉
      const pctCol = (pct == null) ? "" : (pct >= 0 ? "#93cf7e" : "#ec8463");
      const pctStr = (pct == null) ? "" :
        `<span class="cpl-pct" style="color:${pctCol}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
      lbl.innerHTML = pctStr ? `${priceStr}<br>${pctStr}` : priceStr;   // 上價下%（兩行）
      lbl.style.top = Math.round(param.point.y) + "px";
      lbl.style.display = "block";
    });
  })();
}

/* ══════════════════════════════════════════
   繪圖工具（Canvas Overlay）
══════════════════════════════════════════ */
