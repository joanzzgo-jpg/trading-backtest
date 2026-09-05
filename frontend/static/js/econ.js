/* ═══════════════════════════════════════════════
   經濟事件標記（NFP / CPI / FOMC）— 主圖垂直線
   資料來源：GET /api/econ_events（回 UTC unix 秒）。
   對齊：事件 UTC 秒 +8h = 圖表軸時間（與 toTime 同慣例）。
   放置：吸附到「該時刻所在(或之前最近)的 K 棒」→ timeToCoordinate 必得有效座標
        （事件時刻多半不等於某根 K 的時戳，直接換算會拿到 null）。
   ⚠ **未來事件一律不畫**：吸附找的是「時間 ≤ 事件時刻的最後一根」，對還沒發生的事件
     來說答案永遠是**最新那根 K** → 18 個未來事件全疊在同一根上（同 x 同 y，畫面上就是
     「最新 K 掛著 NFP/CPI/FOMC 三個標籤」）。見 _econDataEndT()。
   預告：即將到來的事件**不畫在圖上**，改寫進圖例 #legEcon 的文字（提早 _ECON_LEAD_DAYS 天）。
   圖上標記預設關；但預告需要資料 → 閒置時無條件抓一次（gzip 僅 344 bytes）。
═══════════════════════════════════════════════ */
let _econPrim = null;
let _econEvents = [];                 // [{ ct: 軸時間秒(=UTC+8h), type }]
let _econLoaded = false, _econLoading = false;
const _ECON_COLOR = { NFP: "255,152,0", CPI: "38,198,218", FOMC: "239,83,80" };
const _ECON_YOFF  = { NFP: 3, CPI: 15, FOMC: 27 };   // 標籤垂直錯位(*vrr)避免不同事件擠一起
const _ECON_LEAD_DAYS = 2;                           // 提早幾天在圖例預告（使用者要求：兩天）
const _ECON_NAME  = { NFP: "非農", CPI: "CPI", FOMC: "FOMC" };

function _fetchEconEvents() {
  if (_econLoaded || _econLoading) return;
  _econLoading = true;
  fetch("/api/econ_events")
    // ⚠ 一定要看 r.ok：錯誤回應的 body 也是 JSON，直接 .json() 會把 {"detail":...} 當成合法答案
    //   → j.events 是 undefined → _econEvents=[] 但同時 _econLoaded=true，
    //   而 _fetchEconEvents 開頭就被 _econLoaded 擋住 → 連關掉再開都救不回來，只能重整頁面。
    //   丟給下面的 .catch（它只清 _econLoading、保留 _econLoaded=false）→ 下次開啟會重試。
    .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
    .then(j => {
      _econEvents = (j.events || []).map(e => ({ ct: e.t + 8 * 3600, type: e.type }));
      _econLoaded = true; _econLoading = false;
      _econRefreshLegend(); _econRefreshBar();
      if (_econPrim) _econPrim.requestUpdate();
    })
    .catch(() => { _econLoading = false; });
}

// 「圖上資料涵蓋到哪個時刻」＝最後一根 K 的時間 + 一根的長度。
// ⚠ 一根的長度取「最後幾根裡的**最小正間隔**」，不取最後一根的差：股市跨週末那一根差三天，
//   拿它當一根的長度，兩天後的事件就仍會被畫進來（同 check_bar_invariants 的教訓）。
let _econEndCache = { n: -1, t: -1, end: null };
function _econDataEndT() {
  if (typeof ohlcvData === "undefined" || !ohlcvData.length) return null;
  const n = ohlcvData.length, lastT = toTime(ohlcvData[n - 1].time);
  if (_econEndCache.n === n && _econEndCache.t === lastT) return _econEndCache.end;   // 每幀每事件都會問
  let step = Infinity;
  for (let i = Math.max(1, n - 5); i < n; i++) {
    const d = toTime(ohlcvData[i].time) - toTime(ohlcvData[i - 1].time);
    if (d > 0 && d < step) step = d;
  }
  const end = lastT + (isFinite(step) ? step : 0);
  _econEndCache = { n, t: lastT, end };
  return end;
}

// 二分找「軸時間 <= ct 的最後一根 K」的軸時間；找不到回 null。
function _econSnapTime(ct) {
  if (typeof ohlcvData === "undefined" || !ohlcvData.length) return null;
  // ⚠ 未來事件（超出已載入資料的範圍）不可以吸附到最新那根 —— 否則全部疊在同一根上。
  //   容許落在「形成中那根的區間內」的事件：那是真的發生在畫面最右緣。
  const endT = _econDataEndT();
  if (endT != null && ct >= endT) return null;
  let lo = 0, hi = ohlcvData.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toTime(ohlcvData[mid].time) <= ct) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans < 0) return null;                 // 事件早於第一根 K → 不畫
  return toTime(ohlcvData[ans].time);
}

function _makeEconPrimitive() {
  let _chart = null, _series = null, _req = null;
  const renderer = {
    draw(target) {
      if (!window._econOn || !_chart || !_series || !_econEvents.length) return;
      // ⚠ 這裡原本會「平移/縮放中整批略過、停手才補畫」，理由寫的是「垂直全高虛線最貴」。
      //   2026-09-05 使用者：「經濟事件會在縮放圖表時不見，停了才出現」。實際量過：
      //   典型視野只有 **4 條線**，每幀 **0.011ms ＝ 60fps 預算的 0.1%**（就算把全部 34 條
      //   已發生事件都畫出來也只有 ~0.09ms）。那個節流在保護一個不存在的成本，卻讓圖層
      //   在每次互動時消失 → 拿掉。
      //   ★ 通則：註解裡「這個最貴」的結論會過期，引用它之前先重量一次。
      const ts = _chart.timeScale();
      let vr = null; try { vr = ts.getVisibleRange(); } catch (e) {}
      const lo = vr ? vr.from : -Infinity, hi = vr ? vr.to : Infinity;
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context, hr = scope.horizontalPixelRatio, vrr = scope.verticalPixelRatio;
        const H = scope.bitmapSize.height;
        ctx.font = `bold ${Math.round(9 * vrr)}px sans-serif`;
        ctx.textAlign = "left";
        for (const e of _econEvents) {
          const st = _econSnapTime(e.ct);
          if (st == null || st < lo || st > hi) continue;
          const x = ts.timeToCoordinate(st);
          if (x == null) continue;
          const bx = x * hr;
          const rgb = _ECON_COLOR[e.type] || "200,200,200";
          ctx.strokeStyle = `rgba(${rgb},0.5)`; ctx.lineWidth = Math.max(1, 1 * hr);
          ctx.setLineDash([2 * hr, 3 * hr]);
          ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H); ctx.stroke();
          ctx.setLineDash([]);
          const ly = (_ECON_YOFF[e.type] || 3) * vrr;
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = Math.max(2, 2 * hr);
          ctx.strokeText(e.type, bx + 2 * hr, ly);
          ctx.fillStyle = `rgba(${rgb},1)`; ctx.fillText(e.type, bx + 2 * hr, ly);
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; }, zOrder() { return "bottom"; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {}, paneViews() { return [paneView]; }, requestUpdate() { if (_req) _req(); },
  };
}

/* ── 即將到來的事件：不畫在圖上，改寫進圖例 #legEcon 的文字 ───────────────
   使用者 2026-09-05：「經濟事件顯示太慢，我要提早兩天知道，而且不用在圖上標」。
   分工：圖上只畫「已經發生、K 棒資料涵蓋得到」的；還沒發生的一律用文字預告。
   ⚠ 這是**狀態**不是事件 → 就地寫在圖例上，不用提示框（見 memory
     feedback_no-operational-toasts）。                                        */
function _econUpcoming(days) {
  const nowAxis = Date.now() / 1000 + 8 * 3600;          // 與 e.ct 同慣例（UTC+8h）
  const lim = nowAxis + days * 86400;
  return _econEvents.filter(e => e.ct >= nowAxis && e.ct <= lim).sort((a, b) => a.ct - b.ct);
}

// 「還有多久」文字。使用者 2026-09-05：要「幾天幾小時後」，不要 6.2 天這種小數。
// ⚠ 一律用 floor 不用 round：「還有 6 天 23 小時」被進位成「7 天」會讓人以為還很久。
//   次級單位為 0 就省略（「6天後」比「6天0小時後」乾淨）。
function _econLeadText(sec) {
  if (sec < 60) return "即將發布";
  if (sec < 3600) return Math.floor(sec / 60) + "分後";
  if (sec < 86400) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h + "小時" + (m ? m + "分" : "") + "後";
  }
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d + "天" + (h ? h + "小時" : "") + "後";
}

/* 符號列上的「距離下個經濟事件多久」（使用者：顯示在快捷小工具旁）。
   跟圖例預告的差別：這欄**永遠顯示下一場**（不限兩天內），兩天內才加粗高亮。 */
function _econNextOne() {
  const nowAxis = Date.now() / 1000 + 8 * 3600;
  let best = null;
  for (const e of _econEvents) if (e.ct >= nowAxis && (!best || e.ct < best.ct)) best = e;
  return best;
}

function _econRefreshBar() {
  const el = document.getElementById("econNext");
  if (!el) return;
  const e = _econNextOne();
  if (!e) { el.hidden = true; return; }              // 資料還沒到／表已用完 → 整欄收起，不佔位
  const nowAxis = Date.now() / 1000 + 8 * 3600;
  const left = e.ct - nowAxis;
  const nm = _ECON_NAME[e.type] || e.type;
  el.hidden = false;
  el.classList.toggle("soon", left <= _ECON_LEAD_DAYS * 86400);
  const html = '<span class="se-dot" style="background:rgba(' + (_ECON_COLOR[e.type] || "200,200,200") + ',.9)"></span>'
             + '<span class="se-txt">' + nm + " " + _econLeadText(left) + "</span>"
             + '<span class="se-more">▾</span>';   // 提示可以點開看三場
  if (el.innerHTML !== html) el.innerHTML = html;    // 值未變不寫，免 repaint
  const d = new Date(e.ct * 1000), p2 = n => String(n).padStart(2, "0");
  el.title = "下一個經濟事件：" + nm + " " + d.getUTCFullYear() + "/" + p2(d.getUTCMonth() + 1) + "/" + p2(d.getUTCDate())
           + " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + "（台灣時間）";
}

let _econLegBase = null;    // index.html 原本那段說明文字，別被洗掉
function _econRefreshLegend() {
  const el = document.getElementById("legEcon");
  if (!el) return;                                   // bundle 執行時 DOM 可能還沒好 → 交給下面的計時器
  if (_econLegBase == null) _econLegBase = el.getAttribute("title") || "";
  const up = _econUpcoming(_ECON_LEAD_DAYS);
  const nowAxis = Date.now() / 1000 + 8 * 3600;
  const nm = e => _ECON_NAME[e.type] || e.type;
  if (typeof _setLegText === "function") {
    _setLegText("legEcon", up.length
      ? "經濟事件 " + nm(up[0]) + " " + _econLeadText(up[0].ct - nowAxis)
      : "經濟事件");
  }
  // ⚠ 時間用 getUTC*：e.ct 已經是「軸時間」(UTC+8)，用 UTC 取值才等於台灣時間，
  //   用 getHours() 會變成看的人自己的時區，跟圖上的 K 棒對不起來。
  const p2 = n => String(n).padStart(2, "0");
  const lines = up.map(e => {
    const d = new Date(e.ct * 1000);
    return nm(e) + " " + p2(d.getUTCMonth() + 1) + "/" + p2(d.getUTCDate()) + " "
         + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + "（" + _econLeadText(e.ct - nowAxis) + "）";
  });
  el.setAttribute("title", lines.length ? "即將發布：\n" + lines.join("\n") + "\n\n" + _econLegBase : _econLegBase);
}

// 預告需要資料，但圖上標記**預設是關的** → 閒置時無條件抓一次（gzip 僅 344 bytes）。
// 圖上畫不畫仍然只看 _econOn，這裡只餵圖例文字。
function _econBootNotice() { _fetchEconEvents(); _econRefreshLegend(); _econRefreshBar(); }
if (typeof requestIdleCallback === "function") requestIdleCallback(_econBootNotice, { timeout: 8000 });
else setTimeout(_econBootNotice, 3000);
setInterval(() => { _econRefreshLegend(); _econRefreshBar(); _econRenderPop(); }, 60000);   // 倒數保鮮；純本地計算，不打網路

/* ── 點擊展開：NFP / CPI / FOMC 各自的下一場 ─────────────────────────────
   使用者 2026-09-05：「點擊後三個經濟事件倒數都會出來，若沒點就只有最近的」。
   ⚠ 用 fixed 浮層而不是把三列攤在符號列上：三列並排約 255px，1200px 以下會被
     .symbol-bar 的 overflow:hidden 安靜切掉（同「量=/漲跌幅在手機看不到」那個坑）。 */
function _econNextByType() {
  const nowAxis = Date.now() / 1000 + 8 * 3600;
  const best = {};
  for (const e of _econEvents) {
    if (e.ct < nowAxis) continue;
    if (!best[e.type] || e.ct < best[e.type].ct) best[e.type] = e;
  }
  return Object.values(best).sort((a, b) => a.ct - b.ct);   // 最近的排最上面
}

function _econRenderPop() {
  const pop = document.getElementById("econPop");
  if (!pop || pop.hidden) return;
  const list = _econNextByType();
  const nowAxis = Date.now() / 1000 + 8 * 3600;
  const p2 = n => String(n).padStart(2, "0");
  let h = '<div class="econ-pop-title">接下來的經濟事件</div>';
  if (!list.length) h += '<div class="econ-pop-empty">目前沒有排定的事件</div>';
  for (const e of list) {
    const d = new Date(e.ct * 1000), left = e.ct - nowAxis;
    h += '<div class="econ-pop-row' + (left <= _ECON_LEAD_DAYS * 86400 ? " soon" : "") + '">'
       + '<span class="ep-dot" style="background:rgba(' + (_ECON_COLOR[e.type] || "200,200,200") + ',.9)"></span>'
       + '<span class="ep-nm">' + (_ECON_NAME[e.type] || e.type) + '</span>'
       + '<span class="ep-at">' + p2(d.getUTCMonth() + 1) + "/" + p2(d.getUTCDate()) + " "
       + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + '</span>'
       + '<span class="ep-when">' + _econLeadText(left) + '</span></div>';
  }
  pop.innerHTML = h;
}

function _econClosePop() {
  const pop = document.getElementById("econPop");
  if (pop) pop.hidden = true;
}

function _econTogglePop() {
  const pop = document.getElementById("econPop"), btn = document.getElementById("econNext");
  if (!pop || !btn) return;
  if (!pop.hidden) { pop.hidden = true; return; }
  pop.hidden = false;
  _econRenderPop();
  // 定位：貼在倒數欄正下方；右緣超出視窗就往左收（不夾就會被切掉）。
  const r = btn.getBoundingClientRect();
  pop.style.left = "0px"; pop.style.top = "0px";          // 先歸零才量得到真實寬度
  const w = pop.offsetWidth;
  pop.style.left = Math.max(6, Math.min(r.left, innerWidth - w - 6)) + "px";
  pop.style.top  = (r.bottom + 6) + "px";
}

document.addEventListener("click", e => {
  const btn = document.getElementById("econNext");
  if (btn && btn.contains(e.target)) { e.stopPropagation(); _econTogglePop(); return; }
  const pop = document.getElementById("econPop");
  if (pop && !pop.hidden && !pop.contains(e.target)) _econClosePop();   // 點外面關掉
});
document.addEventListener("keydown", e => { if (e.key === "Escape") _econClosePop(); });

window.toggleEcon = function (on) {
  window._econOn = (on === undefined) ? !window._econOn : !!on;
  if (window._econOn) _fetchEconEvents();
  if (_econPrim) _econPrim.requestUpdate();
  return window._econOn;
};
