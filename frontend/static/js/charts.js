/* ── 主圖價格軸/量軸的上下留白：**單一來源**（2026-08-04）───────────────────────
   ⚠ 這兩行原本在 charts.js 與 render.js 各寫一份一模一樣的。render.js 那份在每次
     重繪成交量時執行 → 會把 charts.js 的設定蓋回去。我改了 charts.js 卻「完全沒效果」，
     就是撞到這個。本專案已經吃過好幾次「兩份表各自漂移」的虧（BG_TF ×2、台股 resample ×2、
     時框秒數 ×5），這裡直接收斂成一份，兩邊都呼叫這支。
   ⚠ 為什麼要收緊：使用者回報「整個 K 棒圖太高的感覺」。實測 1600×900、主圖畫布 746px 時
     K 棒只佔 388px＝52%，上方空 115px、下方空 243px —— 近一半是留白，看起來又高又空。
     下緣是留給成交量疊圖的（量柱自己用 volume 軸的 top 值佔住底部）→ 兩者必須一起調，
     只改一邊會讓量柱和價格區重疊或留下空隙。 */
//   ⚠ top / bottom 是「一起決定位置與高度」的：top 加大＝整塊 K 棒往下移，
//     bottom 加大＝往上移。要「往下移但不變矮」，就得同時把 bottom 縮回來，
//     而 bottom 是留給量柱的 → 量軸的 top 也要跟著加大，否則量柱會跟價格區疊在一起。
const MAIN_SCALE_MARGINS = { top: 0.12, bottom: 0.10 };   // 價格區 = 畫布的 12%~90%
const VOL_SCALE_MARGINS  = { top: 0.90, bottom: 0 };      // 量柱佔底部 10%
function applyMainScaleMargins() {
  if (typeof mainChart === "undefined" || !mainChart) return;
  try {
    mainChart.priceScale("volume").applyOptions({ scaleMargins: VOL_SCALE_MARGINS, visible: false });
    mainChart.priceScale("right").applyOptions({ scaleMargins: MAIN_SCALE_MARGINS });
  } catch (e) {}
}


/* ── 副圖的上下界參考線（KDJ 20/50/80、RSI 30/50/70）──────────────────────────
   ★ 2026-09-24 使用者：「下方副圖的水平線要延伸到右邊，就算右邊 K 棒還沒出來也要先畫好」
     「上下限還是斷的」。
   原本是**只有兩個點的 LineSeries**（第一根 K 棒 → 最後一根）→ 必然停在最後一根，
   右側那段留白（rightOffset）完全沒有線。
   → 改用 LWC 的 `createPriceLine`：它本來就**橫跨整個繪圖區寬度**，含右側留白。
   ⚠ **不可以**改成「在未來時間塞一個資料點」把線拉長：那會把整個圖表的時間範圍往後撐，
     破壞 rightOffset 的計算，也違反重播的「不可看到未來」不變式（守門員之十二）。
   ⚠ 掛在 **anchor**（透明的佔位序列）上，不掛 kdjK/rsiLine14：
     使用者從圖例把 K 線關掉時，掛在它上面的 price line 會跟著消失。anchor 永遠不會被關。
   ⚠ 回傳一層**薄殼**，介面與 LineSeries 相同（applyOptions / setData / options）→
     colors.js 的配色套用、config.js 的圖例開關對照表、render.js 的 setData 一行都不用改。
     setData 收到的是 [{time,value},{time,value}]，取其 value 當價位（兩點本來就同一個值）。 */
function _mkHLine(anchor, price, opts) {
  let cur = Object.assign({ price, visible: true }, opts);
  let pl = null;
  const _sync = () => {
    const o = { price: cur.price, color: cur.color, lineWidth: cur.lineWidth,
                lineStyle: cur.lineStyle, axisLabelVisible: cur.visible !== false,
                lineVisible: cur.visible !== false, title: "" };
    if (!pl) { try { pl = anchor.createPriceLine(o); } catch (e) {} }
    else { try { pl.applyOptions(o); } catch (e) {} }
  };
  _sync();
  return {
    applyOptions(o) { Object.assign(cur, o || {}); _sync(); },
    setData(d) {
      if (Array.isArray(d) && d.length) {
        const v = d[d.length - 1] && d[d.length - 1].value;
        if (Number.isFinite(v)) { cur.price = v; _sync(); }
      }
    },
    options() { return Object.assign({}, cur); },
    priceToCoordinate(v) { try { return anchor.priceToCoordinate(v); } catch (e) { return null; } },
    _isHLine: true,
  };
}

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
    /* ★ 2026-09-24 使用者：「價格的右邊留白好多」。
       這裡原本寫死 `minimumWidth: 64`，但灰色刻度實際只需要約 56px（實測文字佔 44px、
       左緣 11~19、右緣 53~55）→ 軸被撐到 80 之後 LWC 把刻度靠左排，**右邊空出 25~27px**，
       佔整條軸的三分之一。那 80 是為了「橘色現價標籤（我們自己的 DOM，min-width 66 + right 8）
       放得下」而訂的。→ 兩邊一起瘦（標籤 66→56、right 8→4），軸就能收到 64。
       ⚠ 不可以只降 minimumWidth：橘色標籤會超出軸、壓到 K 棒上。
       ⚠ 也不可以降太多：minimumWidth 的用意是**避免價格位數變化時軸寬跳動**
         （BTC 5 位變 6 位會讓整張圖重排）。64 仍容得下常見的 7~8 字價格；
         低價幣那種 12 字的價 LWC 會自己把軸撐開，本來就是這樣設計的。
       ★ 實測結果：軸 81 → **71px**（繪圖區 1270 → 1280），灰刻度右側空白溝 25~27 → **15~17px**。
       ⚠ 再往下沒有用：minimumWidth 設 52 或 40 量到的軸寬**都還是 71** ——
         71 是「內容本身」決定的（LWC 量標籤文字 + 它自己的內距），
         剩下那 16px 是 **LWC 內部的右內距**，不是這個選項能動的。別再花時間調這個數字。 */
    rightPriceScale: { borderColor: _brd, minimumWidth: 64 },
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

/* ── RSI 超買/超賣填色（2026-08-03，依使用者提供的參考圖）───────────────────
   只填「曲線**超出門檻線**的那一小塊」——跟著曲線走、頭尾自然收在交叉點上。
   超買(>70)＝綠、超賣(<30)＝紅。線本身維持單色，不做任何著色。
   ★這版是把前兩次做過頭的東西拿掉：
     ・第一版：畫成矩形色塊 → 硬邊、跟曲線無關，像貼上去的
     ・第二版：整條線做溫度漸層 + 對中線 50 填色 → 太花，不是參考圖的樣子
     參考圖的重點就是「小、貼合曲線、只在越界處出現」，所以刻意不加底色、不加描邊。
   ⚠ 邊界要內插到「與門檻線的交點」，不能直接用越界那根的 x：
     否則色塊會從前一根就開始（或晚一根才開始），看起來與線對不齊。
   ★填色跟著「**目前顯示中**的那幾條 RSI」：
     副圖可畫 RSI(14) 與 RSI(7)，兩條都能由圖例各自開關，而 RSI(7) 波動大得多
     —— 實測同一份資料 RSI7 跌破 30 有 19 根、RSI14 只有 1 根。
     若寫死只跟 RSI(14) 算，看 RSI(7) 的人會發現「線明明破了卻沒填色」，
     以為填色用了不同的計算。故每次繪製時讀兩條 series 的 visible 狀態，
     只用開著的那幾條算包絡（超買取較高、超賣取較低）→ 填色永遠貼合你看得到的線。
     兩條都關 → 不畫任何填色。
   ⚠ 只掃可見範圍（二分搜尋）：避免「每幀掃全陣列 → 放大就卡」。 */
let _rsiBands = [];        // [{t, hi, lo}] hi=兩條 RSI 取大、lo=取小，升序
function _rsiLowerBound(t) {
  let lo = 0, hi = _rsiBands.length;
  while (lo < hi) { const m = (lo + hi) >> 1; _rsiBands[m].t < t ? lo = m + 1 : hi = m; }
  return lo;
}

/* ── 兩個 primitive 共用的省算工具（2026-08-04 降負擔）──────────────────────────
   LWC 依「邏輯索引」等距排列 K 棒 → 陣列若是連續的棒，x 座標就是索引的線性函數，
   可由頭尾兩點推出全部 x，省掉每點一次 timeToCoordinate。實測（BTC 5m、19487 棒、
   全縮出去 2339 可見點）timeToCoordinate 與 priceToCoordinate 各佔 0.45／0.47ms，
   等距推算等於直接省掉其中一半。
   ⚠ 不能無條件假設：陣列中間若缺棒就不成立 → 抽 4 個點驗證，誤差超過 1px 就回 null，
     呼叫端退回逐點換算。正確性優先，驗證本身只花 6 次換算。 */
function _linearX(ts, arr, i0, i1) {
  const n = i1 - i0;
  if (n < 3) return null;
  const xa = ts.timeToCoordinate(arr[i0].t), xb = ts.timeToCoordinate(arr[i1 - 1].t);
  if (xa == null || xb == null) return null;
  const step = (xb - xa) / (n - 1);
  for (let k = 1; k <= 4; k++) {
    const i = i0 + Math.round(n * k / 5);
    if (i <= i0 || i >= i1 - 1) continue;
    const x = ts.timeToCoordinate(arr[i].t);
    if (x == null || Math.abs(x - (xa + (i - i0) * step)) > 1) return null;
  }
  return { x0: xa, step };
}
/* 每幀重複使用的暫存區：避免每幀替可見點各配一個 {x,y,v} 物件（放大時是數千個 → GC 壓力）。
   ⚠ RSI 與線型兩個 primitive 共用這組陣列。可以共用是因為 canvas 繪製是同步的：
     每個 draw() 在回傳前就把暫存區用完了，不會交錯。若日後有人把繪製改成非同步／延後，
     這裡必須先改成各自持有。 */
let _sX = new Float64Array(0), _sHi = new Float64Array(0), _sLo = new Float64Array(0);
function _ensureScratch(n) {
  if (_sX.length >= n) return;
  const cap = n + 512;
  _sX = new Float64Array(cap); _sHi = new Float64Array(cap); _sLo = new Float64Array(cap);
}
/* 某條 RSI 目前是否顯示（圖例可各自開關）。讀不到就當作顯示，寧可多畫也不要無故消失。 */
function _rsiVisible(series) {
  try { return series ? series.options().visible !== false : false; } catch (e) { return !!series; }
}
function _makeRSIZonePrimitive() {
  let _chart = null, _series = null, _req = null;
  const OB = 70, OS = 30;
  const renderer = {
    draw(target) {
      if (!_chart || !_series || !_rsiBands.length) return;
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      if (!vr) return;
      const yOB = _series.priceToCoordinate(OB), yOS = _series.priceToCoordinate(OS);
      if (yOB == null || yOS == null) return;
      const i0 = Math.max(0, _rsiLowerBound(vr.from) - 1);
      const i1 = Math.min(_rsiBands.length, _rsiLowerBound(vr.to) + 2);
      if (i1 - i0 < 2) return;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vp = scope.verticalPixelRatio;
        // 讀「目前哪幾條 RSI 開著」→ 只用開著的算包絡
        const vis14 = _rsiVisible(rsiLine14), vis7 = _rsiVisible(rsiLine7);
        if (!vis14 && !vis7) return;                     // 兩條都關 → 不畫
        /* 單趟掃描把可見點的 x／上包絡／下包絡填進暫存區。
           ⚠ 這裡刻意「不算 y」：y 只有越界（>70 或 <30）的點才畫得到，門檻內的點僅供
             內插交點用，而交點只吃 x 與值。實測 2339 個可見點裡只有 601 點越界 →
             原本 4×2339 次座標換算縮到 2 次(x 兩端) + 601 次(y)。 */
        const lin = _linearX(ts, _rsiBands, i0, i1);
        const n0 = i1 - i0;
        _ensureScratch(n0);
        let m = 0, nHi = 0, nLo = 0;
        for (let i = i0; i < i1; i++) {
          const p = _rsiBands[i];
          const a = vis14 ? p.v14 : null, b = vis7 ? p.v7 : null;
          let hi, lo;
          if (a == null) { if (b == null) continue; hi = lo = b; }
          else if (b == null) { hi = lo = a; }
          else if (a > b) { hi = a; lo = b; }
          else { hi = b; lo = a; }
          const x = lin ? lin.x0 + (i - i0) * lin.step : ts.timeToCoordinate(p.t);
          if (x == null) continue;
          _sX[m] = x; _sHi[m] = hi; _sLo[m] = lo; m++;
          if (hi > OB) nHi++;
          if (lo < OS) nLo++;
        }
        if (!nHi && !nLo) return;                        // 整段都在 30~70 之間 → 沒東西可畫

        // 畫某一側越界的所有段落。lvl=門檻值、yLvl=門檻線 y、above=是否取「高於門檻」
        //   ⚠ 填色用漸層而非單一色：貼著門檻線較淡、越往極端越深（越極端＝越濃），
        //     且整體不透明度給足，看起來要是「填滿」而不是一層薄膜。
        const band = (lvl, yLvl, above, rgb, V) => {
          const yFar = _series.priceToCoordinate(above ? 100 : 0);
          const yTip = (yFar == null) ? yLvl + (above ? -60 : 60) : yFar;
          // 細分漸層：只給 3 個停點會看得出「一階一階」的分界，改成 9 段連續加深
          //   （曲線是 ease-in：貼著門檻線變化慢、越靠極端加深越快 → 越極端越明顯）
          const g = ctx.createLinearGradient(0, yLvl * vp, 0, yTip * vp);
          const A0 = 0.10, A1 = 0.74;                  // 門檻處 → 最極端
          for (let k = 0; k <= 8; k++) {
            const t = k / 8;
            const a = A0 + (A1 - A0) * (t * t * (3 - 2 * t));   // smoothstep，避免線性看起來呆板
            g.addColorStop(t, `rgba(${rgb},${a.toFixed(3)})`);
          }
          ctx.fillStyle = g;
          // poly 存的是「暫存區索引」而非物件 → 段落通常只有幾十點，且不必先配一整批物件
          let poly = null, xStart = 0;
          const cross = (ka, kb) => {         // ka、kb 之間與門檻線的交點 x（線性內插）
            const va = V[ka], d = V[kb] - va;
            if (!d) return _sX[kb];
            return _sX[ka] + (_sX[kb] - _sX[ka]) * ((lvl - va) / d);
          };
          const close = (xEnd) => {
            if (poly && poly.length) {
              ctx.beginPath();
              ctx.moveTo(xStart * hr, yLvl * vp);
              for (const k of poly) {
                const y = _series.priceToCoordinate(V[k]);   // ★只有越界點才換算 y
                if (y != null) ctx.lineTo(_sX[k] * hr, y * vp);
              }
              ctx.lineTo(xEnd * hr, yLvl * vp);
              ctx.closePath(); ctx.fill();
            }
            poly = null;
          };
          for (let k = 0; k < m; k++) {
            const out = above ? V[k] > lvl : V[k] < lvl;
            if (out) {
              if (!poly) {                    // 起點：從與門檻線的交點開始
                xStart = k > 0 ? cross(k - 1, k) : _sX[k];
                poly = [];
              }
              poly.push(k);
            } else if (poly) {
              close(cross(k - 1, k));         // 終點：收在交點上
            }
          }
          if (poly) close(_sX[poly[poly.length - 1]]);
        };
        // 配色沿用全站既有調色盤（C.down 青綠 #26a69a / C.up 紅 #ef5350）：
        // 原本用的是飽和度更高的翠綠(38,180,120)，配上近乎實色的 0.92 → 在深色副圖上很跳。
        if (nHi) band(OB, yOB, true,  "38,166,154", _sHi);   // 超買＝青綠（同 C.down）
        if (nLo) band(OS, yOS, false, "239,83,80",  _sLo);   // 超賣＝紅（同 C.up）
      });
    },
  };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [{ renderer: () => renderer, zOrder: () => "bottom" }]; },
    requestUpdate() { if (_req) _req(); },
  };
}
window._setRSIZones = function (pts) {
  _rsiBands = Array.isArray(pts) ? pts : [];
  if (_rsiZonePrim) { try { _rsiZonePrim.requestUpdate(); } catch (e) {} }
};
let _rsiZonePrim = null;

/* ── 線型圖的漸層線（2026-08-03）─────────────────────────────────────────────
   線的顏色隨「價格在畫面中的高低」變化：上方紫 → 中段藍 → 下方青。
   ⚠ 為什麼要自己畫：LWC 的 LineSeries 只接受單一 color，AreaSeries 只能填線下方，
     兩者都做不出「線本身是漸層」。故 series 設全透明（仍負責縮放/十字線/資料），
     可見的線由這個 primitive 用 canvas 漸層 strokeStyle 描出來。
   ⚠ 只描可見範圍內的點：本專案踩過「每幀掃全陣列 → 放大就卡」，這裡用二分搜尋定位。
   ⚠ 漸層綁在「窗格像素高度」而不是固定價位 → 不論縮放到哪一段，畫面上永遠是完整色譜
     （與參考圖一致）。 */
let _lineGradPts = [];      // [{t, v}] 收盤價，升序
let _lineGradPrim = null;
function _lineGradLB(t) {
  let lo = 0, hi = _lineGradPts.length;
  while (lo < hi) { const m = (lo + hi) >> 1; _lineGradPts[m].t < t ? lo = m + 1 : hi = m; }
  return lo;
}
function _makeLineGradPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!window._chartTypeLine || !_lineGradPts.length || !_chart || !_series) return;
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      if (!vr) return;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vp = scope.verticalPixelRatio;
        const H = scope.bitmapSize.height;
        const i0 = Math.max(0, _lineGradLB(vr.from) - 1);
        const i1 = Math.min(_lineGradPts.length, _lineGradLB(vr.to) + 2);
        if (i1 - i0 < 2) return;
        // ★漸層要綁「這段線自己的最高/最低」而不是整個窗格高度：
        //   價格波動小的時候，線只佔窗格中間一小條，綁窗格會讓整條線都落在漸層的同一個色段
        //   → 看起來像單色。綁自身範圍才會像參考圖那樣，永遠是完整的紫→藍→青。
        //   ⚠ y 只算一趟並存進暫存區，下面描線直接重用：原本 min/max 一趟、描線又一趟，
        //     等於每點做兩次 priceToCoordinate（實測各佔 0.47ms／幀）。
        const lin = _linearX(ts, _lineGradPts, i0, i1);
        _ensureScratch(i1 - i0);
        let yMin = Infinity, yMax = -Infinity, m = 0;
        for (let i = i0; i < i1; i++) {
          const yy = _series.priceToCoordinate(_lineGradPts[i].v);
          if (yy == null) continue;
          const xx = lin ? lin.x0 + (i - i0) * lin.step : ts.timeToCoordinate(_lineGradPts[i].t);
          if (xx == null) continue;
          _sX[m] = xx; _sHi[m] = yy; m++;
          if (yy < yMin) yMin = yy;
          if (yy > yMax) yMax = yy;
        }
        if (m < 2 || !isFinite(yMin) || !isFinite(yMax)) return;
        if (yMax - yMin < 4) { yMin -= 20; yMax += 20; }   // 幾乎水平時給一點範圍，免得整條同色
        // 細分：4 個停點在大範圍下會看到色帶分界，補到 9 段讓過渡連續
        const g = ctx.createLinearGradient(0, yMin * vp, 0, yMax * vp);
        const RAMP = [[0.00,"#c06bf0"],[0.125,"#a869f2"],[0.25,"#8f66f4"],[0.375,"#7663f5"],
                      [0.50,"#5f6ff7"],[0.625,"#4a86fa"],[0.75,"#3d9dfc"],[0.875,"#37b5f6"],
                      [1.00,"#35cbef"]];
        for (const [t, c] of RAMP) g.addColorStop(t, c);
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1, 2 * hr);
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(_sX[0] * hr, _sHi[0] * vp);
        for (let k = 1; k < m; k++) ctx.lineTo(_sX[k] * hr, _sHi[k] * vp);
        ctx.stroke();
      });
    },
  };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [{ renderer: () => renderer, zOrder: () => "top" }]; },
    requestUpdate() { if (_req) _req(); },
  };
}
/* 即時更新：新棒 append、同一根就改最後一筆（realtime.js 每秒呼叫） */
window._lineGradTail = function (t, v) {
  if (!_lineGradPts.length) return;
  const last = _lineGradPts[_lineGradPts.length - 1];
  if (last.t === t) last.v = v;
  else if (t > last.t) _lineGradPts.push({ t, v });
  if (_lineGradPrim) { try { _lineGradPrim.requestUpdate(); } catch (e) {} }
};
window._setLineGradData = function (pts) {
  _lineGradPts = Array.isArray(pts) ? pts : [];
  if (_lineGradPrim) { try { _lineGradPrim.requestUpdate(); } catch (e) {} }
};


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
  // ★2026-08-03 改用 AreaSeries：線下方加 TradingView 式的漸層（線色→透明），比純折線好看也好讀
  //   （一眼看得出「價格在區間裡的位置」）。資料格式與 LineSeries 完全相同（{time,value}），
  //   所以 setData / update 的呼叫端一行都不用改。
  // ★線型圖：線**本身**是垂直漸層（高價紫 → 中段藍 → 低價青），不是線下方填色。
  //   LWC 的 LineSeries 只吃單一顏色、AreaSeries 只能填下方 → 兩者都做不到，
  //   所以線改由 primitive 自己描（見 _makeLineGradPrimitive）。
  //   這個 series 仍保留並照常餵資料：價格軸自動縮放、十字線吸附、最後價標籤都靠它，
  //   只是把顏色設成全透明、由 primitive 畫可見的那條。
  lineSeries = mainChart.addLineSeries({
    color: "rgba(0,0,0,0)", lineWidth: 2,
    priceLineVisible: false, lastValueVisible: false, visible: false,
    crosshairMarkerVisible: true,
    crosshairMarkerBorderColor: "#8b5cf6", crosshairMarkerBackgroundColor: "#8b5cf6",
  });
  try {
    _lineGradPrim = _makeLineGradPrimitive();
    lineSeries.attachPrimitive(_lineGradPrim);
  } catch (e) {}
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
    // 經濟事件垂直線(NFP/CPI/FOMC)
    if (typeof _makeEconPrimitive === "function") {
      _econPrim = _makeEconPrimitive();
      candleSeries.attachPrimitive(_econPrim);
    }
    // 上下顛倒時代替 LWC 畫影線（它的影線在反轉座標下會穿過實體）；平常 draw 直接 return。
    //   ⚠ 一定要最後掛：同為 normal 層的其他圖層（FVG 半透明填色）才會在它底下，跟原生影線一樣
    _invWickPrim = _makeInvWickPrimitive();
    candleSeries.attachPrimitive(_invWickPrim);
  } catch (e) { /* 舊版 LWC 無 attachPrimitive 時靜默略過 */ }
  applyChartType();   // 建好後套用目前圖型（蠟燭/線型）
}

// 蠟燭正常顏色選項（切回蠟燭時還原用；與 createCandleSeries 定義一致）
// ★ 這是 K 棒顏色的唯一出口：createCandleSeries 與 applyAllColors 最後都經 applyChartType() 回到這裡
//   → 上下顛倒的「漲跌色對調」只要做在這一處，換色盤／重建 series 都不會把它洗掉。
function _candleColorOpts() {
  const inv = !!window._chartInverted;
  const up = inv ? C.down : C.up, dn = inv ? C.up : C.down;
  return {
    upColor:   S.bodyVisible !== false ? up : "rgba(0,0,0,0)",
    downColor: S.bodyVisible !== false ? dn : "rgba(0,0,0,0)",
    borderVisible: _candleBorderVisible(),
    borderUpColor: inv ? C.borderDown : C.borderUp, borderDownColor: inv ? C.borderUp : C.borderDown,
    // 上下顛倒時 LWC 自己的影線會穿過實體（見 _makeInvWickPrimitive）→ 關掉、改由 primitive 畫
    wickVisible:   S.wickVisible !== false && !inv,
    wickUpColor:   inv ? C.wickDown : C.wickUp, wickDownColor: inv ? C.wickUp : C.wickDown,   // 還原紅綠影線色(線型時被改成折線色)
  };
}
// 成交量柱顏色：跟 K 棒同一套漲跌判定；上下顛倒時一起對調（上漲那根的量柱也是跌的顏色）
function _volColor(isUp) { return (isUp !== !!window._chartInverted) ? C.volUp : C.volDown; }

/* ── 上下顛倒時的影線（2026-09-12 使用者：「上下顛倒的空心Ｋ中間有直線穿過」）──────────
   LWC 4.2 畫影線（renderer 的 Ae）是兩段：
     fillRect(x, highY, w, 實體上緣 − highY)   與   fillRect(x, 實體下緣+1, w, lowY − 實體下緣)
   —— 假設 highY 在實體上方。價格軸一反轉 highY 跑到下面，兩段高度都變負的 → canvas 往回畫、
   整段穿過實體。實心 K 被實體蓋住看不出來；空心 K（主體關）或半透明實體就是一條直線。
   （實體 Ie／邊框 ze 用的是 min/max，不受影響，只有影線中。）
   → 顛倒時關掉 LWC 自己的影線（_candleColorOpts 的 wickVisible），改由這裡畫：
     K 棒寬度公式、影線寬度、像素對齊、相鄰棒防重疊都照抄 LWC，唯一差別是上下緣先取 min/max
     → 影線只畫在實體外面那兩段。
   ⚠ 圖層：用 normal、而且**最後才掛**（createCandleSeries 那串的最後一個）。實測用 bottom 時
     FVG 缺口的 8% 半透明填色會蓋在影線上（原生影線在它上面），61 段裡有 17 段被染色。
   ⚠ 棒要用 dataByIndex 取「實際畫在圖上的序列」：重播時序列只到游標，拿 ohlcvData 會畫出未來。 */
let _invWickPrim = null;
function _lwcBarWidth(bs, hr) {   // = LWC 4.2 Ht.K 的 K 棒寬度（bitmap px）
  let w;
  if (bs >= 2.5 && bs <= 4) w = Math.floor(3 * hr);
  else {
    const k = 1 - 0.2 * Math.atan(Math.max(4, bs) - 4) / (0.5 * Math.PI);
    w = Math.max(Math.floor(hr), Math.min(Math.floor(bs * k * hr), Math.floor(bs * hr)));
  }
  if (w >= 2 && Math.floor(hr) % 2 !== w % 2) w--;
  return w;
}
function _makeInvWickPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!window._chartInverted || window._chartTypeLine || S.wickVisible === false || !_chart || !_series) return;
      const ts = _chart.timeScale();
      const vr = ts.getVisibleLogicalRange();
      const bs = ts.options().barSpacing;
      if (!vr || !(bs > 0)) return;
      const o = _series.options();
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, r = scope.verticalPixelRatio;
        let lw = Math.min(Math.floor(hr), Math.floor(bs * hr));
        lw = Math.max(Math.floor(hr), Math.min(lw, _lwcBarWidth(bs, hr)));
        const half = Math.floor(0.5 * lw);
        let prevR = null, fill = "";
        const i1 = Math.ceil(vr.to) + 1;
        for (let i = Math.max(0, Math.floor(vr.from) - 1); i <= i1; i++) {
          const d = _series.dataByIndex(i);
          if (!d || d.open == null) continue;
          const x = ts.logicalToCoordinate(i);
          const yo = _series.priceToCoordinate(d.open), yc = _series.priceToCoordinate(d.close);
          const yh = _series.priceToCoordinate(d.high), yl = _series.priceToCoordinate(d.low);
          if (x == null || yo == null || yc == null || yh == null || yl == null) continue;
          const col = (d.open <= d.close) ? o.wickUpColor : o.wickDownColor;   // 同 LWC colorer 的漲跌判定
          if (col !== fill) { ctx.fillStyle = col; fill = col; }
          const top = Math.round(Math.min(yh, yl) * r), bot = Math.round(Math.max(yh, yl) * r);
          const bTop = Math.round(Math.min(yo, yc) * r), bBot = Math.round(Math.max(yo, yc) * r);
          let L = Math.round(x * hr) - half;
          const R = L + lw - 1;
          if (prevR !== null) { L = Math.max(prevR + 1, L); L = Math.min(L, R); }
          const w = R - L + 1;
          if (bTop > top) ctx.fillRect(L, top, w, bTop - top);
          if (bot > bBot) ctx.fillRect(L, bBot + 1, w, bot - bBot);
          prevR = R;
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };   // zOrder 預設 normal，見上方註解
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}

/* ── 上下顛倒（多空翻轉看法，2026-09-11）───────────────────────────────────────
   使用者：「新增多空翻轉看法」→「是指 K 棒整個上下顛倒」→「就是上漲變下跌顯示」。
   主圖價格軸反轉（高價在下）＋漲跌兩組顏色對調 → 上漲那段在畫面上就是一段下跌、顏色也是跌的，
   看起來就是一個完全相反的行情。用途：檢查自己的多空偏見（倒過來還想做同一邊，才是真的看到東西）。
   ・數字一律照實：價格軸刻度、OHLC、報價都是真的價格（只是軸倒著排）。
   ・只翻主圖價格軸：K 棒／BB／VWAP／FVG／繪圖都掛在這條軸上一起翻；成交量在自己的軸、副圖指標不動。
   ・刻意不存檔 —— 忘了關的話，下次打開看到倒過來的圖會直接看反。
     開著時**整張主圖描一圈琥珀外框**（#invertFrame）＋左上角「⇅ 上下顛倒中」標籤附「恢復」鈕
     （#invertBadge，2026-09-22 改設計；舊版是圖頂正中一顆實心橘色膠囊）。
     入口：主圖圖例列 ⚙ 旁邊的 ⇅ 鈕（#invertBtn）、快捷鍵 A（Alt/Option+I 同功能）、手機「設定」分頁。 */
window.toggleChartInvert = function (on) {
  window._chartInverted = (on === undefined) ? !window._chartInverted : !!on;
  const inv = window._chartInverted;
  try { mainChart.priceScale("right").applyOptions({ invertScale: inv }); } catch (e) {}
  applyChartType();                                   // K 棒顏色（_candleColorOpts 依旗標對調）
  if (typeof ohlcvData !== "undefined" && ohlcvData.length && typeof renderVolume === "function")
    renderVolume(ohlcvData);                          // 量柱顏色（重播中 renderVolume 自己會切到游標為止）
  if (typeof _applyMainMarkers === "function") _applyMainMarkers();   // 原生標記在顛倒時改由 primitive 畫（見 render.js）
  if (typeof window._symRetint === "function") window._symRetint();  // 上方開高低收數值：顛倒時 K 棒邊框色對調，字也要跟著
  _stratMarkersUpdate();
  // 繪圖是另一層 canvas、靠 priceToCoordinate 定位 → 價格軸一翻就要重畫；下一幀再補一次（等圖表套用新座標）
  if (typeof _scheduleRenderDrawings === "function") {
    _scheduleRenderDrawings();
    requestAnimationFrame(() => _scheduleRenderDrawings());
  }
  // 左上角標籤 ＋ 整張圖的琥珀外框（2026-09-22 改設計）：兩個都要切，少切一個就會
  // 出現「有框沒標籤／有標籤沒框」的半套狀態。
  const badge = document.getElementById("invertBadge");
  if (badge) badge.hidden = !inv;
  const frame = document.getElementById("invertFrame");
  if (frame) frame.hidden = !inv;
  const btn = document.getElementById("invertBtn");   // ⚙ 旁邊的 ⇅ 鈕（快捷鍵／點標章切換時也要同步亮暗）
  if (btn) { btn.classList.toggle("active", inv); btn.setAttribute("aria-pressed", inv ? "true" : "false"); }
  const mRow = document.getElementById("mSetInvert"), mSt = document.getElementById("mSetInvertState");   // 手機設定分頁
  if (mRow) mRow.classList.toggle("m-set-on", inv);
  if (mSt) mSt.textContent = inv ? "開啟" : "關閉";
  return inv;
};

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
    // 圖示按鈕（移到愛心右邊、純 SVG 無 emoji）：只切 class，圖示由 CSS 決定顯示哪一個。
    //   顯示的是「按下去會變成的樣子」＝沿用原本文字標籤的語意（K線模式時顯示折線圖示）。
    btn.classList.toggle("is-line", line);
    btn.title = line ? "目前：線型圖（收盤價折線）· 點擊切回 K 線圖"
                     : "目前：K 線圖 · 點擊切換為線型圖（收盤價折線）";
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
/* ⚠ 2026-09-25 移除「點 FVG → 顯示該缺口的止盈/止損線」（使用者：「fvg 點下去上下會出現線條，
   需要移除點擊會出現這些東西」）。連帶移除的有：`_fvgLevelsShow`／`_fvgSelected`、
   primitive 裡畫那兩條水平虛線的區塊、以及 `subscribeClick` 訂閱與 `toggleFVGLevels()`。
   ★ `toggleFVGLevels` 當時只掛在 window、**全站沒有任何 UI 或程式呼叫它**（死開關），
     所以整組拿掉不會讓任何按鈕失效。
   ⚠ 後端仍會送每個缺口的 tp/sl 欄位（`setFVGZones` 照常收下），只是不再畫 ——
     要連傳輸一起省的話那是另一件事，得先確認沒有別的消費者。 */
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
          // 交易位階線（止盈綠／止損紅）已於 2026-09-25 移除，見檔案上方 _fvgZones 附近的說明。
          if (_faint) ctx.globalAlpha = 1;               // 復原 alpha，不影響下一個缺口
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) {
      _chart = p.chart; _series = p.series; _req = p.requestUpdate;
      // ⚠ 原本這裡有 `subscribeClick`：點缺口會選取它並畫止盈/止損線。2026-09-25 依使用者
      //   要求整個移除 —— 點 FVG 現在不會有任何反應，主圖上也不再冒出那兩條水平虛線。
    },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
// 餵入後端 fvg 陣列 [{t, top, bot, d, t2}] → 轉圖表時間並重繪
function setFVGZones(list) {
  // 缺口進場觸及時間還原：鍵存在→用它(可能是 null=沒觸及)；鍵不存在→後端省略,代表與 t2 相同
  const _fvgEt = (z, k) => {
    const v = (k in z) ? z[k] : z.t2;
    return (v != null ? toTime(v) : null);
  };
  _fvgZones = (Array.isArray(list) ? list : []).map(z => ({
    t1: toTime(z.t), t2: (z.t2 != null ? toTime(z.t2) : null),
    top: z.top, bot: z.bot, d: z.d, inv: !!z.inv,   // inv=IFVG(反轉缺口,反方向換色)
    go: z.go === true, gv: z.gv === true,           // go=g逆兩側方向、gv=g量<g+1量（前端可選過濾用）
    dim: !!z.dim,                                   // dim=同向缺口堆疊(下方0.5W帶內)→無效(淺色、不採用)
    used: z.used !== false,                          // used=false→沒被任何標記用到→淡化(舊資料無此欄→預設true不淡化)
    sl: (z.sl != null ? z.sl : null), tp: (z.tp != null ? z.tp : null),  // 止損(g-1頂端)/止盈(2W)
    // 進場觸及時間(上緣/中線/下緣)：後端在「與 t2 相同」時省略該鍵以瘦身(實測 44% 缺口三者全等 t2)
    //   → 缺鍵=沿用 t2；明確的 null(沒觸及)仍會照送、不會被誤還原成 t2，故用 `in` 判斷不可改成 ??
    ett: _fvgEt(z, "ett"),
    etm: _fvgEt(z, "etm"),
    etb: _fvgEt(z, "etb"),
    // pens（突破點位）已不再繪製（見上方 211 行註解），後端也不再傳 →
    // 這裡原本還在逐點 toTime 轉換再丟掉，一併移除。
  })).filter(z => z.t1 != null && z.top != null && z.bot != null && !z.inv);   // IFVG(inv) 先關閉：不顯示反轉缺口色塊
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
window.toggleHtfOpen = function (on) {
  window._htfOpenOn = (on === undefined) ? !window._htfOpenOn : !!on;
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
};
/* 可見高低（畫面上這批 K 棒的最高/最低點）。畫在 overlay 畫布上 → 走 _scheduleRenderDrawings，
   不像 PDHL 那樣有自己的 primitive。 */
window.toggleVisHL = function (on) {
  window._visHLOn = (on === undefined) ? !window._visHLOn : !!on;
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return window._visHLOn;
};
window.togglePDHL = function (on) {
  window._pdhlOn = (on === undefined) ? !window._pdhlOn : !!on;
  if (_pdhlPrim) _pdhlPrim.requestUpdate();
  return window._pdhlOn;
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
      // 上下顛倒時，原生標記(setMarkers)改由這裡畫：LWC 4.2 的 aboveBar/belowBar 不管座標有沒有反轉，
      //   一律「高點往上偏移／低點往下偏移」→ 反轉後兩種都會疊進 K 棒裡（render.js _applyMainMarkersNow）
      const inv = !!window._chartInverted;
      if (inv && typeof _invNativeMarkers !== "undefined" && _invNativeMarkers.length) groups.push(_invNativeMarkers);
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
            // above＝語意（看空、錨在高點）；drawUp＝畫在錨點的上方還是下方。
            //   上下顛倒時高點在 K 棒的**下緣** → 改畫到下方、箭頭一起翻，整張圖才是真的倒過來。
            const drawUp = above !== inv;
            if (drawUp) {
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

// FVG 最小寬度%（使用者自定）：寬度小於 pct 的缺口不顯示。0＝全顯示。即時重繪。
function setFVGMinWidth(pct) {
  _fvgMinW = Math.max(0, +pct || 0);
  if (_fvgPrimitive) _fvgPrimitive.requestUpdate();
  return _fvgMinW;
}
window.setFVGZones = setFVGZones;
window.setFVGMinWidth = setFVGMinWidth;
window.toggleFVG = toggleFVG;

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
    // _bt(d) 用 _rebuildTimeIndex 已算好的秒數（見 render.js 該函式註）；重播傳進來的可能是純秒數 → 走原路
    const _tm = (typeof _bt === "function")
      ? (d => (d.time ? _bt(d) : d))
      : (d => (d.time ? toTime(d.time) : d));
    candleSeries.setData(data.map(d => ({
      time: _tm(d), open: d.open, high: d.high, low: d.low, close: d.close,
    })));
    if (lineSeries) {   // 線型圖收盤折線；濾掉 null close(否則 LWC Line 拋「Value is null」)
      const _lp = data.filter(d => d.close != null).map(d => ({ time: _tm(d), value: d.close }));
      lineSeries.setData(_lp);
      // 同一份資料餵給漸層 primitive（series 本身是透明的，可見的線由它畫）
      if (typeof window._setLineGradData === "function")
        window._setLineGradData(_lp.map(p => ({ t: p.time, v: p.value })));
    }
  }
  updateLatestPriceLine(data[data.length - 1].close);
}

let _curPriceLabelEl = null;   // 現價的自訂 DOM 標籤（與十字線價格標籤同風格）

/* 切標的時先把現價標線收起來（2026-08-23 使用者：「主圖點進去，會有一瞬間最新價格標線不對」）。
   `updateLatestPriceLine` 只在 `renderCandles` 拿到新資料時才更新 → 從點下去到新資料到達的
   這段時間，標線與右軸標籤留著**上一檔**的價。實測本機約 80ms 就顯示上一檔的 77,311.6
   （目標 2,425），慢一點的機器/網路窗口更長。
   ⚠ 只在**換標的**時收（換時框是同一檔，價仍然有效，收掉反而閃一下）。
   ⚠ 不必另外復原：新資料一畫上去，renderCandles 就會呼叫 updateLatestPriceLine 重建。 */
function hideLatestPriceLine() {
  try {
    if (latestPriceLine && candleSeries) candleSeries.removePriceLine(latestPriceLine);
  } catch (e) {}
  latestPriceLine = null;
  try {
    if (_curPriceLabelEl && _curPriceLabelEl.isConnected) _curPriceLabelEl.style.display = "none";
  } catch (e) {}
}
window.hideLatestPriceLine = hideLatestPriceLine;

/* 現價線／右側現價標籤的顏色：使用者可在「主圖設定 → 現價線」自選（C.curPrice，預設琥珀）。
   線 80%、標籤底 30%、標籤邊框 90% —— 透明度維持原本的視覺，只換色相。 */
function _curPriceCol() { return C.curPrice || DEFAULT_COLORS.curPrice; }
/* 顏色 → rgba(…, a)：吃 #rgb/#rrggbb 與 rgb()/rgba()；認不得就原樣回（不會讓標籤消失）。 */
function _colA(col, a) {
  const c = String(col || "").trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) { const p = m[1].split(",").map(x => x.trim()); return `rgba(${p[0]},${p[1]},${p[2]},${a})`; }
  return c;
}
/* 色盤改了 → 線與標籤一起重上色（colors.js applyAllColors 與設定面板 onColor 都呼叫這支）。 */
window._applyCurPriceColor = function () {
  try { if (latestPriceLine) latestPriceLine.applyOptions({ color: _colA(_curPriceCol(), .8) }); } catch (e) {}
  if (typeof updateCurrentPriceLabel === "function") updateCurrentPriceLabel();
};

function updateLatestPriceLine(price) {
  if (!candleSeries || price == null) return;
  if (latestPriceLine) {
    try { latestPriceLine.applyOptions({ price }); }
    catch { latestPriceLine = null; }
  }
  if (!latestPriceLine) {
    latestPriceLine = candleSeries.createPriceLine({
      price,
      color: _colA(_curPriceCol(), .8),
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
  if (!n) { lbl.style.display = "none"; _axisHide[0] = null; return; }
  let idx = n - 1;
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    idx = Math.min(idx, replayIdx);
  const price = ohlcvData[idx] && ohlcvData[idx].close;
  if (price == null) { lbl.style.display = "none"; _axisHide[0] = null; return; }
  const y = candleSeries.priceToCoordinate(price);
  if (y == null) { lbl.style.display = "none"; _axisHide[0] = null; return; }
  lbl.textContent = (typeof _fmtPx === "function") ? _fmtPx(price) : price.toFixed(2);
  const _cpc = _curPriceCol();
  // 底色 90%（2026-09-19 使用者：「最新價的顯示底不要透明」→「70%」）。
  // ⚠ 這顆的 alpha 有兩處要一起改：這裡是「跟著使用者選的現價色」算出來的實際值，
  //   style.css 那條是色盤還沒套用前的預設底色 —— 只改一邊會在開圖那一瞬間閃出舊的淡色。
  lbl.style.background = _colA(_cpc, .70);
  lbl.style.borderColor = _colA(_cpc, .9);
  lbl.style.top = Math.round(y) + "px";
  lbl.style.display = "block";
  _axisHideSet(0, y, 15);       // 這格刻度讓位（半高 10px + 刻度字半高 ~5px）
  _hideCurLabelIfCovered();     // 價格自己動到游標標籤下方時也要收起來（不然又疊回去）
}

let _crossLabelEl = null;   // 十字線價格標籤（建立於 setupCrosshairPriceLabel）

/* ── 被自訂標籤蓋住的那格刻度，不要畫（2026-09-20）──────────────────────────────
   現價/十字線標籤是**自訂 DOM**，LWC 不知道它們存在 → 底下的刻度照樣畫，兩個數字疊在一起
   （實測：橘色「80,343.6」上緣透出灰色「80000.0」）。使用者最早回報的「右邊價格那行會重疊
   看不清」就是這個；調標籤透明度只是遮，遮不掉**半露在標籤外**的那半截字。
   ⚠ 不能在 formatter 裡呼叫 priceToCoordinate（渲染中再進渲染）→ 改成在更新標籤時
     先把「要蓋掉的價格區間」算好存起來，formatter 只做數字比較。
   ⚠ 沒被蓋到的刻度必須**維持原本的格式**：用 series 自己的 priceFormat.precision 走 toFixed，
     跟 LWC 內建的價格格式化一致（加了千分位就會整排跟著變、看得出來）。
   ⚠ 成交量軸是 visible:false，所以這個 chart 層級的 formatter 只會影響右側價格軸。 */
const _axisHide = [];        // [{lo,hi}]：這些價格區間內的刻度不畫
function _axisHideSet(i, y, half) {
  if (y == null || !candleSeries) { _axisHide[i] = null; return; }
  try {
    const a = candleSeries.coordinateToPrice(y - half), b = candleSeries.coordinateToPrice(y + half);
    _axisHide[i] = (a != null && b != null) ? { lo: Math.min(a, b), hi: Math.max(a, b) } : null;
  } catch (e) { _axisHide[i] = null; }
}
function _axisTickText(p) {
  for (const z of _axisHide) if (z && p >= z.lo && p <= z.hi) return "";
  let prec = 2;
  try { const pf = candleSeries && candleSeries.options().priceFormat; if (pf && pf.precision != null) prec = pf.precision; } catch (e) {}
  return (+p).toFixed(prec);
}
/* 日線以上＝時間標籤只顯示「月-日」，其餘（盤中時框）都要帶「時:分」。
   ⚠ 刻意列「日線以上」而不是列「盤中」：漏列時的預設方向才是安全的那邊
     （漏列 → 顯示時分，最多多顯示一點；反過來漏列 → 整個看不出幾點幾分）。
   ⚠ LWC 這版**不吃** `localization.timeFormatter`（實測掛上去 0 次呼叫）→
     時間標籤一律由 charts.js 自繪的 `.crosshair-time-label` 產生，別再去試那個選項。 */
const _TF_DAILY_UP = new Set(["1d", "1w", "1M"]);
/* 游標價標籤壓到最新價標籤時，把最新價那顆收起來。
   ⚠ 兩顆都是自訂 DOM、各自依價格定位 → 游標移到現價附近必然重疊：實測 29px 內就疊到，
     疊到時不是整顆被蓋掉（看不到現價），就是露出一條橘邊在游標框外緣＝更糟。
   → 游標在附近時以游標那顆為準（它本來就同時顯示「游標價」與「距現價幾 %」，資訊沒少）。
   ⚠ 用 visibility 不用 display：updateCurrentPriceLabel 每次重繪都會設 display="block"，
     用 display 藏會被它立刻打開＝閃爍。 */
function _hideCurLabelIfCovered(crossLbl) {
  crossLbl = crossLbl || _crossLabelEl;
  if (!_curPriceLabelEl || !_curPriceLabelEl.isConnected) return;
  let hide = false;
  try {
    if (crossLbl && crossLbl.style.display !== "none") {
      const a = crossLbl.getBoundingClientRect(), b = _curPriceLabelEl.getBoundingClientRect();
      hide = !(a.bottom <= b.top || b.bottom <= a.top);
    }
  } catch (e) {}
  const v = hide ? "hidden" : "";
  if (_curPriceLabelEl.style.visibility !== v) _curPriceLabelEl.style.visibility = v;
}

/* ── 建立圖表 ── */
function buildCharts() {
  const base  = makeBaseOpts(null,                   false);
  const sub   = makeBaseOpts({ top:0.08, bottom:0.08 }, false);
  const volSM = makeBaseOpts({ top:0.05, bottom:0 },    false);
  const subT  = makeBaseOpts({ top:0.08, bottom:0.08 }, true);  // 最下方，顯示時間軸

  mainChart = LightweightCharts.createChart(document.getElementById("mainChart"), base);
  createCandleSeries();
  // 價格軸刻度：被自訂標籤蓋住的那格不畫（見 _axisTickText）
  mainChart.applyOptions({ localization: { priceFormatter: _axisTickText } });
  bbU = mainChart.addLineSeries({ color:C.bbU, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });
  bbM = mainChart.addLineSeries({ color:C.bbM, lineWidth:S.bbMWidth??1, lineStyle:S.bbMStyle??2, priceLineVisible:false, lastValueVisible:false });
  bbL = mainChart.addLineSeries({ color:C.bbL, lineWidth:S.bbWidth??1,  priceLineVisible:false, lastValueVisible:false });
  // 布林 1σ 內帶已移除（使用者要求）：bbU1/bbL1 series 與相關引用皆已刪除（前後端皆不再計算/輸出）

  // 成交量疊在主圖下方（獨立 priceScaleId，不影響 K 棒價格軸）
  volSeries   = mainChart.addHistogramSeries({ priceScaleId:"volume", priceLineVisible:false, lastValueVisible:false });
  volMaSeries = mainChart.addLineSeries({ priceScaleId:"volume", color:(C.volMa||"#ffcc02"), lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  applyMainScaleMargins();

  kdjChart = LightweightCharts.createChart(document.getElementById("kdjChart"), sub);
  kdjAnchor = kdjChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  /* ★ 2026-09-24 使用者：「縮放時上下跳動」——副圖各自 autoscale，一縮放就各自重算 min/max，
     跳動幅度跟主圖不一樣 → 看起來沒有連動。KDJ 本質是 0~100 的震盪指標，不該隨縮放浮動。
     → 釘成「**至少**涵蓋 0~100」，只有 J 真的超出才擴張（J 會 <0 或 >100，硬釘會被裁掉）。
     ⚠ LWC 會把同一個價格軸上**所有** series 的 autoscale 結果取聯集 → 只要在其中一條
       掛這個 provider，整個面板的刻度下限就被釘住了，不必每條線都掛。
     ⚠ 用 `original()` 拿預設結果再取聯集，不可以自己重算：那等於在測試裡複製公式，
       資料有 NaN/空洞時會跟 LWC 的判斷分岔。 */
  /* ⚠ 只做「至少涵蓋 0~100」**不夠**：J 會衝出 0~100，而它衝多高是看**可見範圍**算的
     → 一縮放又開始跳（實測五種縮放量到 4 組不同刻度）。
     → 改成用**整段已載入的資料**算 J 的極值：縮放完全不影響它（只有換標的／換時框才會變），
       而且永遠不會把 J 裁掉。
     ⚠ 要快取：autoscaleInfoProvider 每次重繪都會被呼叫，O(n) 掃描會落在熱路徑上。
       用「資料識別 + 根數」當快取鍵，資料一變就自然失效。
     ⚠ 上下各夾在 [-50,150]：極端行情出現過一次 J=300，之後整個面板會被壓成一條平線。 */
  let _kdjRangeCache = { key: "", lo: 0, hi: 100 };
  const _kdjFullRange = () => {
    const n = (typeof ohlcvData !== "undefined" && ohlcvData) ? ohlcvData.length : 0;
    const key = (window._chartDataKey || "") + "|" + n;
    if (_kdjRangeCache.key === key) return _kdjRangeCache;
    let lo = 0, hi = 100;
    for (let i = 0; i < n; i++) {
      const v = ohlcvData[i].kdj_j;
      if (typeof v !== "number" || !isFinite(v)) continue;   // NaN/空洞不可參與（Math.min 會被污染）
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    _kdjRangeCache = { key, lo: Math.max(lo, -50), hi: Math.min(hi, 150) };
    return _kdjRangeCache;
  };
  const _atLeast0to100 = () => {
    const r = _kdjFullRange();
    return { priceRange: { minValue: r.lo, maxValue: r.hi } };
  };
  kdjK  = kdjChart.addLineSeries({ color:C.kdjK, lineWidth:S.kdjKWidth??1, lineStyle:S.kdjKStyle??0, priceLineVisible:false, lastValueVisible:false, autoscaleInfoProvider:_atLeast0to100 });
  kdjD  = kdjChart.addLineSeries({ color:C.kdjD, lineWidth:S.kdjDWidth??1, lineStyle:S.kdjDStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjJ  = kdjChart.addLineSeries({ color:C.kdjJ, lineWidth:S.kdjJWidth??1, lineStyle:S.kdjJStyle??0, priceLineVisible:false, lastValueVisible:false });
  kdjH20 = _mkHLine(kdjAnchor, 20, { color:C.kdjH20, lineWidth:S.kdjHLWidth, lineStyle:1 });
  kdjH50 = _mkHLine(kdjAnchor, 50, { color:C.kdjH50, lineWidth:S.kdjHLWidth, lineStyle:1 });
  kdjH80 = _mkHLine(kdjAnchor, 80, { color:C.kdjH80, lineWidth:S.kdjHLWidth, lineStyle:1 });

  rsiChart = LightweightCharts.createChart(document.getElementById("rsiChart"), sub);
  rsiAnchor = rsiChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  /* RSI 數學上**必定**落在 0~100 → 直接釘死，縮放時刻度完全不動，30/50/70 三條參考線
     永遠在同一個高度。這是它與 KDJ 的差別（J 會超出 0~100，所以那邊只能釘下限）。 */
  rsiLine14 = rsiChart.addLineSeries({ color:C.rsi14, lineWidth:S.rsi14Width??1, lineStyle:S.rsi14Style??0, priceLineVisible:false, lastValueVisible:false,
    autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
  rsiLine7  = rsiChart.addLineSeries({ color:C.rsi7,  lineWidth:S.rsi7Width??1,  lineStyle:S.rsi7Style??0,  priceLineVisible:false, lastValueVisible:false });
  // 線型改吃 S.rsiHLStyle（使用者可在 RSI 設定裡切實線/點線/虛線/長虛線）；?? 1 維持舊外觀
  const _rhls = S.rsiHLStyle ?? 1;
  rsiH30 = _mkHLine(rsiAnchor, 30, { color:C.rsiH30, lineWidth:S.rsiHLWidth, lineStyle:_rhls });
  rsiH50 = _mkHLine(rsiAnchor, 50, { color:C.rsiH50, lineWidth:S.rsiHLWidth, lineStyle:_rhls });
  rsiH70 = _mkHLine(rsiAnchor, 70, { color:C.rsiH70, lineWidth:S.rsiHLWidth, lineStyle:_rhls });
  try {   // 超買/超賣漸層底（掛在 RSI(14) 上，畫在最底層不擋線）
    _rsiZonePrim = _makeRSIZonePrimitive();
    rsiLine14.attachPrimitive(_rsiZonePrim);
  } catch (e) {}

  macdChart = LightweightCharts.createChart(document.getElementById("macdChart"), subT);
  macdAnchor = macdChart.addLineSeries({ color:"rgba(0,0,0,0)", lineWidth:1, priceLineVisible:false, lastValueVisible:false });
  macdLine   = macdChart.addLineSeries({ color:C.macd,    lineWidth:S.macdWidth??1,    lineStyle:S.macdStyle??0,    priceLineVisible:false, lastValueVisible:false });
  macdSignal = macdChart.addLineSeries({ color:C.macdSig, lineWidth:S.macdSigWidth??1, lineStyle:S.macdSigStyle??0, priceLineVisible:false, lastValueVisible:false });
  macdHist   = macdChart.addHistogramSeries({ priceScaleId:"right", priceLineVisible:false, lastValueVisible:false });

  /* ★ 2026-09-24 使用者：「就算還沒出現Ｋ棒，後面背景格子直線也要在」「未來時間要先畫出來」。
     LWC 的**垂直格線畫在時間刻度上**，而刻度只生成在「有資料的時間範圍」內 →
     rightOffset 那段留白沒有任何資料 → 一條格線也沒有（實測留白 200px 內 0 條）。
     → 每張圖掛一條 **whitespace series（只有 time、沒有價格）**把時間軸往未來延伸，
       格線與時間標籤就由 LWC 自己按同一套節奏畫出來。
     ★ 為什麼不自繪：2026-09-24 稍早自繪過一版（在分隔線上取樣畫布補格線），使用者否決 ——
       「我縮小就壞了，而且跟不上縮放速度」。走 LWC 自己的機制就**結構上**不可能跟不上縮放。
     ⚠ 一定要**獨立的 series**、不可以塞進 candleSeries：重播守門員
       (`check_replay_no_future.js`) 的判準就是問 `candleSeries.data()` 有沒有未來棒。
       實測加了之後 candleSeries 未來棒仍是 0。
     ⚠ `priceScaleId:""`＋`autoscaleInfoProvider: () => null` → 不參與任何價格軸計算。
     ⚠ 實測加上去**不會扯走使用者的視角**：可見邏輯範圍 A/B 完全相同
       （1005.6666666666666~1190 逐位元一致）。 */
  _gridAhead = [
    [mainChart, null], [kdjChart, null], [rsiChart, null], [macdChart, null],
  ].map(([c]) => c && c.addLineSeries({
    priceScaleId: "", lastValueVisible: false, crosshairMarkerVisible: false,
    priceLineVisible: false, autoscaleInfoProvider: () => null,
  })).filter(Boolean);

  // 縮小時留白需要更多根去填 → 跟著可見範圍往上長（見 `_growGridAhead`）
  mainChart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r) _growGridAhead(r.to); });

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
  _syncAxisWidth();
  _placeWatermarkMobile();
}

/* ★ 2026-09-25 使用者：「手機版 ahh logo 位置要調整、需要縮小，目前位置擋到下方時間表」。
   桌面用純 CSS 的 `bottom` 就夠（2026-09-24 那版把 `_placeWatermark` 移掉的理由），
   但**手機解不掉**，量過就知道為什麼：
     ・手機的 `.charts-container` 延伸到底部分頁列後方 → 同一個 bottom 值落點完全不同
     ・副圖在手機上**每個只有 55px 高，而圖例就佔 38px** → 圖例與時間軸本來就已經重疊，
       中間只剩 17px 的縫，放不下 29px 的浮水印 ⇒ 副圖開著時怎麼擺都會壓到資訊
   → 手機改成跟著**主圖底緣**走：永遠落在主圖那塊（副圖開 y≈456、關 y≈621 都成立），
     不碰任何副圖的圖例，也不碰時間軸。
   ⚠ 只動手機：桌面維持 CSS 的 bottom，不寫 inline（省得跟 style.css 打架）。
   ⚠ 面板開合也要重算 → 掛在 `resizeAll()` 尾端（開合副圖本來就會走到這裡）。 */
function _placeWatermarkMobile() {
  try {
    const wm = document.querySelector(".chart-watermark");
    if (!wm) return;
    const mobile = (typeof isMobileUI === "function") ? isMobileUI()
                 : window.matchMedia("(max-width: 1180px)").matches;
    if (!mobile) { wm.style.bottom = ""; return; }        // 桌面交還給 CSS
    const cc = document.getElementById("chartsContainer");
    const mp = document.getElementById("mainPane");
    if (!cc || !mp) return;
    const cr = cc.getBoundingClientRect(), mr = mp.getBoundingClientRect();
    if (mr.height < 40) return;
    // 主圖底緣往上 6px；主圖若就是最底面板（副圖全關）還要再讓開時間軸 26px
    const isBottom = Math.abs(mr.bottom - _lowestPaneBottom()) < 2;
    const lift = Math.round(cr.bottom - mr.bottom) + 6 + (isBottom ? 26 : 0);
    wm.style.bottom = lift + "px";
  } catch (e) {}
}
function _lowestPaneBottom() {
  let b = 0;
  ["mainPane", "kdjPane", "rsiPane", "macdPane"].forEach(id => {
    const e = document.getElementById(id);
    if (!e) return;
    const r = e.getBoundingClientRect();
    if (r.height > 8 && r.bottom > b) b = r.bottom;
  });
  return b;
}

/* ★★ 2026-09-24 使用者：「主圖跟副圖的線接不起來」「是指背景的格子線」。
   根因：**每張圖的價格軸寬度不一樣** —— 主圖刻度是「92000.0」、KDJ 是「100.00」、
   MACD 是「4000.00」，LWC 依各自最寬的標籤決定軸寬 → 繪圖區寬度不同 →
   **同一個時間在四張圖上落在不同的 x**。實測四段十字線的 x 是 534 / 537 / 537 / 531，
   背景的垂直格線同理（各畫各的），所以跨面板永遠對不齊、看起來「接不起來」。
   ⚠ 這不是「線斷掉」，是**橫向錯位**——量幾何時一定要比各段的 left，只看
     「上下有沒有空隙」會全綠（我就這樣繞了好幾輪）。
   → 取四張圖裡**最寬的那個軸**，用 minimumWidth 套給全部 → 繪圖區等寬 → 時間對到同一個 x。
   ⚠ 用「取最大」不是寫死一個數字：標的換成低價幣（0.00001234）時軸會變寬，
     寫死就又錯開了。⚠ 只在真的不一致時才 applyOptions，否則每次 resize 都觸發重排。 */
function _syncAxisWidth() {
  try {
    const list = [mainChart, kdjChart, rsiChart, macdChart].filter(Boolean);
    if (list.length < 2) return;
    /* ⚠ **不可以**用 `timeScale().width()` 量繪圖區：實測它對主圖/KDJ/RSI 一律回 **0**
       （只有帶可見時間軸的 MACD 回真值）→ 用它算出來的軸寬會是整個面板寬，全錯。
       正解是問價格軸自己：`priceScale("right").width()`，四張都回真值
       （實測 main 70 / kdj 64 / rsi 64 / macd 76）。 */
    const w = list.map(c => { try { return c.priceScale("right").width() || 0; } catch (e) { return 0; } });
    const want = Math.max(...w);
    if (!want) return;
    list.forEach((c, i) => {
      if (w[i] !== want) { try { c.priceScale("right").applyOptions({ minimumWidth: want }); } catch (e) {} }
    });
  } catch (e) {}
}
window._syncAxisWidth = _syncAxisWidth;

/* 未來留白區的時間軸延伸（見上面建立 `_gridAhead` 處的說明）。
   基準一律取 **`candleSeries.data()` 的最後一根**，不是 `ohlcvData` —— 重播模式下
   前者才是「游標那根」，後者留著完整資料（含未來），拿它當基準等於把未來洩漏給重播。
   ⚠ 間隔用**最小正間隔**不用最後兩根的差：股市一天只有幾小時，跨日那一根的間隔是
     盤中的好幾倍（claude.md 守門員之十七記過同一個坑）→ 用它會把格線推到太遠的未來。
   ⚠ 只有 (最後一根, 間隔) 真的變了才 setData：renderAll 每次都會呼叫到這裡。 */
/* ★ 2026-09-24 使用者：「未來時間要留到 300K 棒距離」→ 起始 320 根（300＋餘裕）。
   ★★ 但接著：「**我每次縮小後面都不夠**」—— 寫死根數一定會不夠：留白是以**根**為單位，
      縮小時 barSpacing 變小、同樣寬的留白就要更多根去填 → 固定 320 根很快就用完，
      右邊又變回沒有格線。→ 依**實際可見範圍**動態往上長（只增不減、階梯 ×2）。
   ⚠ 用階梯不是「算多少給多少」：可見範圍每一幀都在變，那樣等於每幀 setData。
      階梯最多長 4 次（320→640→1280→2560）就到頂，之後全部 early return。
   ⚠ 上限不可無限大：whitespace 也是時間軸上的資料，太長會讓 fitContent 這類
      「把全部塞進畫面」的操作把 K 棒擠扁（已實測 320 根不會，見下）。 */
const _GRID_AHEAD_MIN = 320;
const _GRID_AHEAD_MAX = 2560;
let _gridAhead = [];
let _gridAheadKey = "";
let _gridAheadN = _GRID_AHEAD_MIN;
/* 可見範圍右緣已經超出現有的未來延伸 → 往上長一階。
   ⚠ `range.to` 是**邏輯索引**（以第一根 K 棒為 0），所以跟 `data().length-1` 相減
      才是「往未來幾根」。 */
function _growGridAhead(to) {
  try {
    if (!Number.isFinite(to)) return;
    const d = (typeof candleSeries !== "undefined" && candleSeries) ? candleSeries.data() : null;
    if (!d || !d.length) return;
    const need = Math.ceil(to) - (d.length - 1) + 60;     // 60＝餘裕，免得剛好卡在邊緣
    if (need <= _gridAheadN) return;
    let n = _gridAheadN;
    while (n < need && n < _GRID_AHEAD_MAX) n *= 2;
    n = Math.min(n, _GRID_AHEAD_MAX);
    if (n === _gridAheadN) return;
    _gridAheadN = n;
    _gridAheadKey = "";          // 強制重算
    _syncGridAhead();
  } catch (e) {}
}
function _syncGridAhead() {
  try {
    if (!_gridAhead.length) return;
    const d = (typeof candleSeries !== "undefined" && candleSeries) ? candleSeries.data() : null;
    if (!d || d.length < 3) return;
    const t0 = d[d.length - 1].time;
    let step = Infinity;
    for (let i = Math.max(1, d.length - 12); i < d.length; i++) {
      const dt = d[i].time - d[i - 1].time;
      if (dt > 0 && dt < step) step = dt;
    }
    if (!Number.isFinite(step) || step <= 0) return;
    const key = t0 + "|" + step + "|" + _gridAheadN;
    if (key === _gridAheadKey) return;
    _gridAheadKey = key;
    const ws = new Array(_gridAheadN);
    for (let i = 0; i < _gridAheadN; i++) ws[i] = { time: t0 + step * (i + 1) };
    _gridAhead.forEach(s => { try { s.setData(ws); } catch (e) {} });
  } catch (e) {}
}
window._syncGridAhead = _syncGridAhead;

/* ⚠ 2026-09-24：這裡曾經有一版「在分隔線裡用 canvas 補畫格線」的橋接（取樣畫布找格線 x）。
   **已整支移除** —— 使用者：「這樣的接法很爛，我縮小就壞了，而且跟不上縮放速度」。他是對的：
   任何「自己重畫一份格線去對齊 LWC 那份」的做法，都得跟上 LWC 每一幀的重繪，
   取樣有成本、節流就跟不上、不節流就卡頓，本質上是在追一個永遠追不到的目標。
   ★ 正解是**把縫隙本身消掉**：面板之間會斷，是因為 `.pane-divider` 佔了 7px。
     讓它只剩 1px（視覺分界仍在），相鄰面板的格線自然就接上了 ——
     那是 LWC 原生每幀畫的，永遠同步、零維護。拖曳手把改用 ::after 撐出命中區，不佔版面。
   ★ 通則：**與其補一個機制產生的縫，不如讓那個縫不要產生。** */


/* ── 時間軸 & 鉛直線同步 ── */
let _blockSync = false; // 重播渲染期間暫停雙向同步，防止 setData 觸發 range 抖動

/* 「換資料 + 補償視野」原子化：期間暫停跨圖同步。
   ★為什麼需要（2026-07-28 定位「往舊滑被帶到銜接點」的閃跳）：補舊/補新/滾動修剪會 setData，
   各圖因此各自發出 range-change，那些值是**換資料前的舊 index 空間**瞬態；跨圖同步是 rAF 延遲
   的（_flushSync），會在我們把正確 range 補償完之後才把那個舊值推回主圖 → 該幀被畫在未補償的
   位置、下一幀才彈回 ＝ 使用者看到的「被往銜接點帶一下」。
   期間 _blockSync=true：訂閱端直接不收集(不留 _pendingSync)、已排隊的 _flushSync 也會丟棄，
   正確位置由 fn 內自己設定的 range 決定（fn 必須把 4 張圖都設好）。try/finally 保證不會卡住同步。*/
function _syncSuspend(fn) {
  const prev = _blockSync;
  _blockSync = true;
  try { fn(); } finally { _blockSync = prev; }
}
window._syncSuspend = _syncSuspend;

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
    /* ★ 2026-09-24 使用者：「縮放時還是下方較慢」。
       這裡原本在平移/縮放進行中把子圖同步**降到 ~30fps**（主圖維持全速），理由寫著
       「盤中上萬根時 4 張圖每幀重排太重」—— 那個結論已經過期了。
       重量 A/B（4387 根、三個副圖全開、連續 60 次縮放，最壞情況再測一次可見 2219 根）：
         節流開：幀時間 中位 16.7ms / p90 17.4ms / 掉幀 0
         節流關：幀時間 中位 16.6ms / p90 17.2ms / 掉幀 0
       **量不出差別**，但節流會讓副圖比主圖晚最多 33ms 才跟上 —— 使用者看到的就是「下方較慢」。
       → 拿掉。主圖與副圖現在同一幀更新。
       ★ 同 claude.md：「註解裡『量過、不划算』的結論會隨相依的東西改變而過期 —— 引用它之前先重量一次」。
       ⚠ 若哪天真的量到掉幀，正解是減少**每幀重排的成本**，不是讓副圖落後主圖（那是把效能問題
         變成視覺 bug）。 */
    const _now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    _lastFlushTs = _now;
    _pendingSync = null;
    syncing = true;
    // ★只同步「真的看得見」的圖（2026-07-31）：原本無條件推給全部 4 張，隱藏/收合的副圖照樣被
    //   setVisibleLogicalRange 強制重新佈局＝純浪費（副圖預設就是隱藏，等於每個人每一幀都在付）。
    //   副圖每幀重新佈局的成本實測很可觀（開副圖時 3 張共 ~150ms/幀，見 render.js _renderSubcharts 註）。
    //   ⚠ 主圖(di=0)永遠同步；重新顯示時由 ui.js 的 toggle 補一次 _renderSubcharts + 這裡下一幀自然跟上。
    const _subHid = (typeof _subchartsHidden === "function") && _subchartsHidden();
    allCharts.forEach((dst, di) => {
      if (di === p.si) return;
      if (di !== 0) {
        if (_subHid) return;                                   // 整組隱藏（預設）→ 完全不推
        const el = _syncPaneEl(di);
        if (el && el.clientHeight < 2) return;                  // 個別收合到 0 高 → 不推
      }
      dst.timeScale().setVisibleLogicalRange(p.range);
    });
    syncing = false;
    /* 格線位置隨平移/縮放改變 → 分隔區的橋接要跟著重畫。
       ⚠ **不可以每幀畫**：它要 getImageData 取樣畫布。停手後補一次就好（線在移動中本來就看不清）。 */
    // 平移/縮放 → 重算可見範圍的標記視窗（debounced，避免長範圍時 setMarkers 拖慢）
    if (typeof _scheduleMarkerRewindow === "function") _scheduleMarkerRewindow();
    // 布林改成只畫「可見範圍±3屏」後，平移/縮放要跟著重切視窗（見 render.js _bbWindow）
    if (typeof _scheduleBBRewindow === "function") _scheduleBBRewindow();
    // 接近左側邊界就提前預抓下一塊歷史（門檻拉大 → 還沒滑到空白就先載好，補資料更快不卡頓）
    //   ⚠ 方向搶佔:若正在跑「補新」而使用者回頭往左→中止補新、立刻改補舊(否則共用旗標會擋掉→沒往舊補)
    // ⚠ 縮到最小(看見全部)時視野同時貼近左右兩端(from<2000 且 to≈最新)→ 不可觸發補舊,否則往右滑也一直誤觸
    //   補舊、位移把視野往更早拉(使用者「縮到最小往右滑一直跳到更早」)。加 to < n−300:右緣離最新還遠才是「真在看左側舊資料」。
    if (p.range.from < 2000 && p.range.to < ohlcvData.length - 300 && ohlcvData.length) {
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
    else if (window._hasFwdGap && p.range.to > ohlcvData.length - 600 && p.range.from > 300 && ohlcvData.length) {   // 提早預抓右側(from>300:縮到最小看見全部時不誤觸)
      const now = Date.now();
      const busyOlder = _bgLoadInProgress && window._bgLoadDir === "older";
      if ((!_bgLoadInProgress || busyOlder) && now - _scrollLoadTs > 250) {
        _scrollLoadTs = now;
        if (busyOlder) _bgLoadInProgress = false;  // 搶佔:中止補舊改補新
        if (typeof _bgLoadNewerBars === "function") _bgLoadNewerBars(true);
      }
    }
    // 平移中不斷排程「閒置滾動修剪」(debounce 600ms)→ 停手後把累積的常駐根數壓回有界,setData 更快、記憶體有界
    if (typeof _scheduleIdleTrim === "function") _scheduleIdleTrim();
    // 「回到最新」按鈕的顯示/隱藏(視野捲離最新才出現)。此處已節流,不必另開訂閱。
    if (typeof _updateGoLatestBtn === "function") _updateGoLatestBtn();
    // 副圖指標「可見範圍窗化」:視野快移出目前窗才重建(見 render.js _scheduleSubRewindow)。
    if (typeof _scheduleSubRewindow === "function") _scheduleSubRewindow();
  }
  // pane 元素快取（同步時要看是否收合；每幀查一次 DOM 太浪費）
  const _SYNC_PANE_IDS = ["mainPane", "kdjPane", "rsiPane", "macdPane"];
  const _syncPaneCache = [];
  function _syncPaneEl(i) {
    let e = _syncPaneCache[i];
    if (!e || !e.isConnected) { e = document.getElementById(_SYNC_PANE_IDS[i]); _syncPaneCache[i] = e; }
    return e;
  }

  // 副圖由隱藏→顯示時補一次同步：隱藏期間完全不推 range（見 _flushSync 註）→ 顯示瞬間會停在
  //   舊位置，這裡把主圖當下的可見範圍直接套上去，使用者看到的第一幀就是對的。
  window._syncSubchartsNow = function () {
    try {
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (!r) return;
      syncing = true;
      [kdjChart, rsiChart, macdChart].forEach(c => {
        try { c.timeScale().setVisibleLogicalRange(r); } catch (e) {}
      });
      syncing = false;
    } catch (e) { syncing = false; }
  };

  // 目前由誰驅動跨圖同步：0=主圖（預設）。使用者按/滾到哪個 pane，那個 pane 就成為驅動者。
  //   ⚠ 只在真的收到指標/滾輪事件時才改，程式化設定 range 不會改 → 補載/修剪的補償一律由主圖出發。
  let _syncDriver = 0;
  function _bindSyncDriver() {
    ["mainPane", "kdjPane", "rsiPane", "macdPane"].forEach((id, i) => {
      const el = document.getElementById(id);
      if (!el || el._syncDrvBound) return;
      el._syncDrvBound = true;
      ["pointerdown", "wheel", "touchstart"].forEach(ev =>
        el.addEventListener(ev, () => { _syncDriver = i; }, { passive: true, capture: true }));
    });
  }
  _bindSyncDriver();

  allCharts.forEach((src, si) => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      // 標記「圖表正在移動」（平移/縮放/慣性）→ 供其它模組參考（背景天氣等；_uxMark 另追蹤連續互動 session）
      if (window._uxMark) window._uxMark();
      else window._chartMoveTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (syncing || !range || _blockSync) return;
      // ★副圖隱藏時「副圖不得驅動主圖」(2026-07-28 修「往舊滑一直被往前帶」):
      //   副圖隱藏是預設值,此時 _bgApplyChunk 會跳過 3 條錨點 setData(省效能)→ 副圖的資料仍停在
      //   補載前的舊根數;但補舊/修剪仍會把「新 index 空間」的 range 設給副圖 → LWC 依副圖自己較短的
      //   資料把它夾住(clamp)成別的值,那個值再經 rAF 延遲同步推回主圖 → 主圖被往舊拉一段;主圖一動
      //   又觸發下一輪 → 「一直往前帶」的失控滾動。隱藏時只允許主圖→副圖單向同步。
      if (si !== 0 && typeof _subchartsHidden === "function" && _subchartsHidden()) return;
      // ★★ 只有「使用者實際在操作的那張圖」能驅動同步（2026-07-31 修「開副圖就卡成 5fps」）。
      //   原本副圖一顯示,4 張圖表**互相**都能驅動:任一張的 range-change → 設給其他 3 張 →
      //   它們各自重繪並在下一幀再發出 range-change → 又一輪 → **自我維持的同步風暴**。
      //   syncing 旗標只擋得住同步呼叫內的重入,擋不住 LWC 延後一幀才發的事件。
      //   實測(BTC/USDT.P 5m、19502 根、barSpacing 90、其餘條件完全相同):
      //     副圖關 中位 16.7ms / 0 個長幀   ←→   副圖開 中位 188.5ms / 157 個長幀
      //   且與 DPR 無關(DPR1 189.6ms、DPR2 188.5ms)、JS 只佔 0.1% → 時間全在 LWC 反覆重繪。
      //   → 改成單向:只收 _syncDriver 那張的事件,其餘一律忽略 → 迴圈斷開。
      //   _syncDriver 由「最後被指標/滾輪碰到的那個 pane」決定(見下方 _bindSyncDriver),
      //   所以在副圖上拖曳照樣能帶動主圖,不會退化成「只有主圖能拖」。
      if (si !== _syncDriver) return;
      _pendingSync = { range, si };               // 只記最新，丟棄同幀內較舊的中間值
      /* ★ 2026-09-24 使用者：「縮放時還是下方較慢」。原本一律 `requestAnimationFrame(_flushSync)`
         → 副圖固定**晚主圖一幀**才跟上。改成同一幀就套用。
         真實滾輪事件量測（4387 根、三個副圖全開、40 次滾輪、逐幀比對主圖與 RSI 的可見範圍）：
           下一幀套用：不一致的幀 80/161（50%）
           同幀套用　：不一致的幀 40/161（25%）      ← 減半，兩次複驗都一致
           幀時間兩者皆 中位 16.5ms / 掉幀 0（滾輪打在副圖上也一樣，最大 22ms）
         ⚠⚠ 量這種東西**一定要用真實滾輪事件**：我第一版用 `evaluate` 直接設 range，
           取樣 rAF 與更新的相位變成人造的 → 量出「同幀反而更差」的**反向結論**。
         ⚠ p90 不可當判準：A 自己兩次就差 22.9 → 34.3 根，雜訊比 A/B 差距還大。
           判準要用「不一致的幀數比例」。
         ⚠ 同步呼叫進 LWC 有「同步風暴」前科（2026-07-31 實測 16.7ms → 188.5ms/幀）——
           擋住它的是上面那道 `si !== _syncDriver` 單向閘門，**不是**這個 rAF。
           已驗證滾輪打在副圖上（驅動者是副圖）幀時間仍是 16.5ms、零掉幀。 */
      if (_syncRaf) { cancelAnimationFrame(_syncRaf); _syncRaf = 0; }
      _flushSync();
    });
  });

  // 虛線一個完整週期的長度（實 8px + 空 6px），必須與 style.css `.pane-vline` 的
  // repeating-linear-gradient 相同 —— 用來讓各段的虛線相位跨面板連續。
  const _VLINE_PERIOD = 14;
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

    /* 底部時間標籤文字（月-日 (時:分)；年份固定顯示在價格軸下方右下角）。
       ⚠⚠ 判準是「**不是**日線以上」，不是「有沒有列在盤中清單裡」（2026-09-22 使用者：
         「1m下方對其時間都是寫9/22 我看不出幾分」）。舊版寫死
         `["4h","2h","1h","30m","15m","5m"]` —— **漏了 1m**（而且還留著早就移除的 2h/30m）
         → 1m 掉到「只顯示日期」那條，hover 一根只看得到「09-22」，完全看不出幾點幾分。
       ★ 同 claude.md 一直在講的「對照表漏列 → 靜默退回」。**反過來寫**之後，
         漏列的預設方向就變成安全的那邊：新增任何盤中時框都自動有時分，
         只有明確列為日線以上的才不顯示。
       ⚠ `time` 是圖表時間（toTime 產出、已 +8 小時）→ 取時分必須用 UTC getter。 */
    const d = new Date(time * 1000);
    const pad = n => String(n).padStart(2, "0");
    // 盤中時框＝**日期＋時:分**（2026-09-22 使用者：「寫日期跟幾點幾分」）。
    // 日線以上沒有時分可看，只給日期。
    const md = `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    const timeStr = _TF_DAILY_UP.has(currentTF)
      ? md
      : `${md} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

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
      /* ★ 2026-09-24 使用者：「上下線條依舊不連貫」。
         線段本身早就是接在一起的（實測四段的段間空隙都是 0、同一個 x），
         但它是**虛線**，而每一段是獨立的 DOM 元素 → `repeating-linear-gradient`
         的相位在**每個面板交界重新從 0 開始** → 交界處必定出現一個長度不對的節拍，
         看起來就是「線斷掉／對不齊」。畫面上沒有任何空隙，所以量幾何量不出來。
         → 依這一段距離容器頂端的距離，把背景往上位移一個週期內的餘數，相位就接上了。
         ⚠ 週期 _VLINE_PERIOD 必須跟 style.css `.pane-vline` 的 gradient 一致（8px 實 + 6px 空）；
           改 CSS 的虛線樣式時這裡要一起改，否則交界又會錯開。 */
      p.ln.style.backgroundPositionY = (-(p.top % _VLINE_PERIOD)) + "px";
    }
    // 時間標籤錨定到時間軸（最底可見 pane 底緣），而非容器底。
    // 桌面容器底＝圖表底 → offset≈0；手機容器延伸到底部分頁列後方 → offset≈分頁列高，
    // 否則標籤會被推到時間軸下方、藏進 m-tabbar 後面而看不到。
    const axisOffset = Math.max(0, Math.round(cRect.bottom - maxPaneBottom));
    timeLabel.style.bottom = (axisOffset + (replayActive ? 42 : 0)) + "px";
  }

  // 用游標 x 直接定位鉛直線（給「K 棒序列以外的空白區」用：該處無對應時間，
  // 原生會把十字線時間 snap 到最近那根 → 線卡住不動。改用游標 x 讓線跟著進入空白）。
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
      // 游標在「K 棒序列以外的空白區」：用游標 x 直接定位鉛直線，跟著游標進入空白、不卡在邊緣那根。
      // ★ 2026-08-13 使用者：「鼠標的虛線對齊十字到沒 K 棒處就消失了」——
      //   原本只處理**右側**（最後一根之後）。左側（第一根之前）的空白 param.time 是 undefined，
      //   直接掉進下面的 `!param.time` 分支 → 四條鉛直線全隱藏，但橫線/價格標籤還在
      //   ＝十字線只剩一半。左邊空白很常見：大時框（1M/1d/8h）資料本來就少、
      //   或縮到最小看見全部時第一根左邊就是空白。
      //   ⚠ 兩側都要判：只補一邊就是把同一個 bug 留在另一邊。
      if (param.point) {
        const ts = mainChart.timeScale();
        const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
        // logicalToCoordinate 只吃整數（餵小數回 0）；0 與 n-1 都是整數，安全。
        // 邊緣那根捲出畫面時它回的是負值/超界值 → 下面的比較自然不成立，不必特判。
        const firstX = n ? ts.logicalToCoordinate(0) : null;
        const lastX  = n ? ts.logicalToCoordinate(n - 1) : null;
        const pw = ts.width(), px = param.point.x;
        const outR = lastX  != null && px > lastX + 0.5;
        const outL = firstX != null && px < firstX - 0.5;
        if ((outR || outL) && px >= 0 && px <= pw) {
          positionLinesByX(px);
          return;
        }
      }
      if (!param.time || !param.point) {
        hideTimer = setTimeout(() => {
          lineEls.forEach(l => l.style.display = "none");
          timeLabel.style.display = "none";
        }, 60);
        return;
      }
      positionLines(param.time, param.point.x);
      updateAllLegends(param.time);
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
    _crossLabelEl = lbl;                 // 給 _hideCurLabelIfCovered 用（現價自己移動時也要重判）
    mainChart.applyOptions({ crosshair: { horzLine: { labelVisible: false } } });

    mainChart.subscribeCrosshairMove(param => {
      if (!param.point || !candleSeries) { lbl.style.display = "none"; _axisHide[1] = null; _hideCurLabelIfCovered(lbl); return; }
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price == null) { lbl.style.display = "none"; _axisHide[1] = null; _hideCurLabelIfCovered(lbl); return; }
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
      _axisHideSet(1, param.point.y, 21);   // 它是兩行（價＋%），半高較大
      _hideCurLabelIfCovered(lbl);
    });
  })();
}

/* ══════════════════════════════════════════
   繪圖工具（Canvas Overlay）
══════════════════════════════════════════ */
