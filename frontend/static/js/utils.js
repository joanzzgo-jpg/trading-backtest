function toTime(s) {
  if (!s) return 0;
  const iso = s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000) + 8 * 3600;
}

/* ── 手機 TF 選擇器（使用者自選最多 4 個要顯示的時間框） ── */
function loadMobileTFs() {
  try {
    const raw = JSON.parse(localStorage.getItem("mobileTFs") || "null");
    if (Array.isArray(raw) && raw.length) {
      const valid = raw.filter(tf => MOBILE_TF_ALL.includes(tf)).slice(0, MOBILE_TF_MAX);
      if (valid.length) _mobileTFs = valid;
    }
  } catch (e) {}
  return _mobileTFs;
}
function saveMobileTFs(arr) {
  // 依「按鈕列固定順序」排序，避免顯示順序跳動
  _mobileTFs = MOBILE_TF_ALL.filter(tf => (arr || []).includes(tf)).slice(0, MOBILE_TF_MAX);
  if (!_mobileTFs.length) _mobileTFs = ["1d"];
  try { localStorage.setItem("mobileTFs", JSON.stringify(_mobileTFs)); } catch (e) {}
}

/* ── hex + 透明度 ── */
function hexAlpha(hex, opacity) {
  const a = Math.round(Math.max(0, Math.min(100, opacity)) / 100 * 255)
    .toString(16).padStart(2, "0");
  return hex + a;
}

/* ── localStorage ── */
// 顏色/樣式設定「手機端與電腦端各自獨立」：手機用 _m 後綴的 key。
// 兩套 key 都在帳戶快照內 → 都隨帳戶同步，但各平台讀寫自己那份、互不影響。
/* 手機版 UI 判斷（全站唯一準則）。介面只分兩種：手機款 / 桌面款。三種情形走手機款：
   ① 桌機(fine pointer)窄視窗 ≤1180（沿用；使用者縮窗測手機版）；
   ② 觸控裝置「直屏」＝iPad 直放 + 手機直放 → 手機款；
   ③ 觸控裝置「橫屏但矮」＝手機橫放(視窗高 ≤599) → 手機款。
   其餘 = 桌面款：iPad「橫放」(觸控橫屏且高 ≥600) → 桌面款；桌機寬視窗 → 桌面款。
   → iPad：直屏手機版、橫屏電腦版。CSS 端(style.css 各斷點)用完全相同的三段條件，兩邊必須一致。 */
let _mqMobile = null;   // MediaQueryList 快取：matches 是即時值，建一次即可（isMobileUI 在滑鼠移動路徑被高頻呼叫）
function isMobileUI() {
  try {
    if (!window.matchMedia) return window.innerWidth <= 1180;
    if (!_mqMobile) _mqMobile = [
      window.matchMedia("(max-width: 1180px) and (pointer: fine)"),
      window.matchMedia("(hover: none) and (pointer: coarse) and (orientation: portrait)"),
      window.matchMedia("(hover: none) and (pointer: coarse) and (orientation: landscape) and (max-height: 599px)"),
    ];
    return _mqMobile[0].matches || _mqMobile[1].matches || _mqMobile[2].matches;
  } catch (e) { return window.innerWidth <= 1180; }
}
/* iPad 直↔橫旋轉會跨越手機款/桌面款門檻 → 旋轉且模式翻轉時重載一次，讓整站佈局(手機/桌面面板)套對。
   只聽 orientationchange（真實裝置旋轉才觸發；桌機拖窗只發 resize，仍走 CSS 即時切換、不重載）。
   手機旋轉不跨門檻(兩向都手機款)→模式不變→不重載。 */
(function _watchUIModeFlip() {
  try {
    let _built = isMobileUI();
    window.addEventListener("orientationchange", () => {
      setTimeout(() => { if (isMobileUI() !== _built) location.reload(); }, 300);
    });
  } catch (e) {}
})();
function _isMobilePrefs() {
  return isMobileUI();
}
function _prefKey(base) { return _isMobilePrefs() ? base + "_m" : base; }
function savePrefs() {
  // 極簡模式禁止寫入 chart 偏好——避免暫時套上的純白配色汙染使用者的正常模式設定
  if (document.documentElement.classList.contains("perf-mode")) return;
  try {
    localStorage.setItem(_prefKey("chartColors"),     JSON.stringify(C));
    localStorage.setItem(_prefKey("chartStyles"),     JSON.stringify(S));
    localStorage.setItem(_prefKey("chartLineStyles"), JSON.stringify(LINE_STYLES));
  } catch {}
  if (window._acctTouch) window._acctTouch();   // 登入中 → debounce 同步到雲端
}
function loadPrefs() {
  // 讀平台專屬 key；手機首次（尚無 _m）沿用既有(電腦)設定當起點，之後一改即分流。
  const _get = base => {
    const k = _prefKey(base);
    let raw = localStorage.getItem(k);
    if (raw == null && k !== base) raw = localStorage.getItem(base);
    return raw || "{}";
  };
  try {
    Object.assign(C, JSON.parse(_get("chartColors")));
    Object.assign(S, JSON.parse(_get("chartStyles")));
    Object.assign(LINE_STYLES, JSON.parse(_get("chartLineStyles")));
  } catch {}
}

function saveLastSymbol() {
  try {
    const ts = mainChart?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    const rangeBarCount = r ? Math.max(1, Math.round(r.to - r.from)) : null;
    const rangeToOffset = (r && ohlcvData.length) ? Math.max(0, ohlcvData.length - 1 - Math.round(r.to)) : null;
    // 持久選項：barSpacing(縮放) + scrollPos(最新棒水平位置,可為正=右側留白) → 重整後完整還原
    // （取代會被 Math.max(0) 夾掉右側留白的 rangeToOffset，故重整不再黏右邊）
    // ⚠ scrollPos 用「可見範圍幾何」算(to − 最後棒index)，不可用 scrollPosition()：後者只反映手動捲動量，
    //   程式以 rightOffset 設定的留白會回 0 → 切標的數次後留白歸零黏回右緣（與 render.js 同因）。
    let barSpacing = null, scrollPos = null;
    try { barSpacing = ts?.options().barSpacing; scrollPos = (r && ohlcvData.length) ? Math.max(0, r.to - (ohlcvData.length - 1)) : 0; } catch (e) {}
    localStorage.setItem("lastSymbol", JSON.stringify({
      symbol:   document.getElementById("symbolInput")?.value  || "",
      exchange: document.getElementById("exchangeSelect")?.value || "pionex",
      market:   document.getElementById("marketSelect")?.value  || "crypto",
      tf:       currentTF,
      rangeBarCount, rangeToOffset, barSpacing, scrollPos,
    }));
  } catch {}
}

function loadLastSymbol() {
  try {
    const last = JSON.parse(localStorage.getItem("lastSymbol") || "null");
    if (!last || !last.symbol) return;
    document.getElementById("symbolInput").value = last.symbol;
    if (last.exchange) document.getElementById("exchangeSelect").value = last.exchange;
    if (last.market)   document.getElementById("marketSelect").value   = last.market;
    if (last.tf && TF_LABELS[last.tf]) {
      currentTF = last.tf;
      document.querySelectorAll(".tf-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.tf === currentTF));
    }
    if (last.barSpacing != null) {
      // 持久選項還原（含右側留白）→ 重整不黏右邊
      _pendingRestoreRange = { barSpacing: last.barSpacing, rightOffset: last.scrollPos ?? 0 };
    } else if (last.rangeBarCount != null) {
      _pendingRestoreRange = { barCount: last.rangeBarCount, toOffset: last.rangeToOffset ?? 0 };
    }
  } catch {}
}

/* 將 LINE_STYLES 中儲存的線寬 / 樣式套用到對應 series */
function applyLineStyle(inputId) {
  const getter = INPUT_SERIES_MAP[inputId];
  if (!getter) return;
  const series = getter();
  if (!series) return;
  const ls = LINE_STYLES[inputId];
  if (!ls) return;
  const opts = {};
  if (ls.width != null) opts.lineWidth  = ls.width;
  if (ls.style != null) opts.lineStyle  = ls.style;
  if (Object.keys(opts).length) series.applyOptions(opts);
}

/* 頁面載入後重新套用所有儲存的線條樣式 */
function applyAllLineStyles() {
  Object.keys(LINE_STYLES).forEach(applyLineStyle);
  // ⚙ popup 的設定（S）優先，覆蓋 LINE_STYLES 可能帶來的舊值
  rsiLine14?.applyOptions({ lineWidth: S.rsi14Width,    lineStyle: S.rsi14Style });
  rsiLine7?.applyOptions({  lineWidth: S.rsi7Width,     lineStyle: S.rsi7Style  });
  kdjK?.applyOptions({      lineWidth: S.kdjKWidth,     lineStyle: S.kdjKStyle  });
  kdjD?.applyOptions({      lineWidth: S.kdjDWidth,     lineStyle: S.kdjDStyle  });
  kdjJ?.applyOptions({      lineWidth: S.kdjJWidth,     lineStyle: S.kdjJStyle  });
  bbU?.applyOptions({       lineWidth: S.bbWidth  });
  bbL?.applyOptions({       lineWidth: S.bbWidth  });
  bbM?.applyOptions({       lineWidth: S.bbMWidth });
  macdLine?.applyOptions({  lineWidth: S.macdWidth,    lineStyle: S.macdStyle    });
  macdSignal?.applyOptions({ lineWidth: S.macdSigWidth, lineStyle: S.macdSigStyle });
}

function savePaneFlexes() {
  if (_restoringPrefs) return;
  const flexes = {};
  Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
    const el  = document.getElementById(id);
    if (!el) return;
    const btn = document.querySelector(`.pane-collapse-btn[data-pane="${id}"]`);
    const isCollapsed = btn?.dataset.collapsed === "true";
    // 收合時儲存收合前的 flex；否則儲存目前 flex
    flexes[id] = isCollapsed
      ? (parseFloat(paneCollapseFlex[id]) || PANE_FLEX_DEFAULTS[id])
      : (parseFloat(el.style.flex)        || PANE_FLEX_DEFAULTS[id]);
  });
  try { localStorage.setItem("paneFlexes", JSON.stringify(flexes)); } catch {}
  if (window._acctTouch) window._acctTouch();   // 登入中 → 版面比例同步到雲端
}

function loadPaneFlexes() {
  try {
    const saved = JSON.parse(localStorage.getItem("paneFlexes") || "{}");
    Object.keys(PANE_FLEX_DEFAULTS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const flex = saved[id] ?? PANE_FLEX_DEFAULTS[id];
      el.style.flex = flex;
    });
  } catch {}
}

function saveVisibilityPrefs() {
  if (_restoringPrefs) return;  // 還原中不觸發儲存
  try {
    const hiddenLegs = [];
    document.querySelectorAll(".leg-toggle.line-off").forEach(el => {
      if (el.id) hiddenLegs.push(el.id);
    });
    // 預設關(data-defoff)但被開起來的圖例 → 也記下來，否則重開會忘記(hiddenLegs 只記「被關掉」的)
    const shownDefOff = [];
    document.querySelectorAll(".leg-toggle[data-defoff]:not(.line-off)").forEach(el => {
      if (el.id) shownDefOff.push(el.id);
    });
    localStorage.setItem("shownDefOff", JSON.stringify(shownDefOff));
    const collapsedPanes = {};
    document.querySelectorAll(".pane-collapse-btn").forEach(btn => {
      if (btn.dataset.collapsed === "true")
        collapsedPanes[btn.dataset.pane] = paneCollapseFlex[btn.dataset.pane] || "1";
    });
    localStorage.setItem("hiddenLegs",     JSON.stringify(hiddenLegs));
    localStorage.setItem("collapsedPanes", JSON.stringify(collapsedPanes));
  } catch {}
}

function loadVisibilityPrefs() {
  _restoringPrefs = true;
  try {
    // 恢復隱藏的圖例線條
    const hiddenLegs = JSON.parse(localStorage.getItem("hiddenLegs") || "[]");
    hiddenLegs.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.classList.contains("line-off")) el.click();
    });
    // 預設關但上次開著的 → 點開(還原勾選)：如「大時框FVG」等
    const shownDefOff = JSON.parse(localStorage.getItem("shownDefOff") || "[]");
    shownDefOff.forEach(id => {
      const el = document.getElementById(id);
      if (el && el.classList.contains("line-off")) el.click();
    });
    // 恢復收合的面板
    const collapsedPanes = JSON.parse(localStorage.getItem("collapsedPanes") || "{}");
    for (const [paneId, flex] of Object.entries(collapsedPanes)) {
      paneCollapseFlex[paneId] = flex;
      const btn = document.querySelector(`.pane-collapse-btn[data-pane="${paneId}"]`);
      if (btn && btn.dataset.collapsed !== "true") btn.click();  // 未收合則點擊收合
    }
  } catch {}
  _restoringPrefs = false;
  saveVisibilityPrefs();  // 還原完成後統一儲存一次
}

/* ── 基礎圖表選項（showTime=true 才顯示時間軸，只有最下方的圖顯示）── */

function buildPayload() {
  const sym = document.getElementById("symbolInput").value.trim();
  // 初次只抓「填滿螢幕＋少量緩衝」的量 → 圖表秒出；更深歷史由 _bgLoadOlderBars() 於載入後背景補到 INIT_DAYS。
  //   ⚠ 只有會背景補載的時框(1m/5m/15m/1h/4h)才縮；8h/2h/30m/1d/1w/1M 一次載入、不補 → 維持原量不可縮。
  //   最終可見深度與標記完全不變(背景一塊就補到位)，只是首次繪製從抓 2000 根降到 ~700 根、每次切標的/時框都更快。
  // 看歷史切時框(TV式)：window._loadRangeStart(秒) 設定時,直接抓「該段~至今」→ 資料一次到位、切完瞬間對齊,免等背景補。
  const _rs = window._loadRangeStart;
  const _rangeMode = (typeof _rs === "number" && isFinite(_rs));
  return {
    market:    document.getElementById("marketSelect").value,
    symbol:    sym,
    start:     _rangeMode ? new Date(_rs * 1000).toISOString().slice(0, 10) : "",
    end:       "",
    limit:     _rangeMode ? 0 : ({ "1M":120,"1w":520,"1d":1095,"4h":800,"1h":700,"15m":700,"5m":700,"1m":700 }[currentTF] ?? 500),
    timeframe: currentTF,
    exchange:  document.getElementById("exchangeSelect").value,
    // 副圖(KDJ/RSI/MACD)隱藏時(預設)不要後端算指標→省計算+payload 少 8 欄；打開副圖時帶 true 重抓
    indicators: !(typeof _subchartsHidden === "function" && _subchartsHidden()),
  };
}

/* 更新圖例文字，只改 .leg-val，dot 完全不碰 */
// 圖例值節點快取：crosshair 每動呼叫 ~10 次 × 60Hz，省掉每次 querySelector
const _legValCache = {};
function _setLegText(id, text) {
  let val = _legValCache[id];
  if (!val || !val.isConnected) { val = document.querySelector(`#${id} .leg-val`); _legValCache[id] = val; }
  if (val && val.textContent !== text) val.textContent = text;   // 值未變不寫，免 repaint
}

/* 手寫千分位（取代 toLocaleString）：十字線/圖例每次滑鼠移動都在格式化，
   toLocaleString 每次呼叫貴 ~10 倍（要查 locale 表）；輸出與原本相同（含負號/小數）。 */
function _thousands(s) {
  const i = s.indexOf(".");
  let head = i < 0 ? s : s.slice(0, i);
  const tail = i < 0 ? "" : s.slice(i);
  let sign = "";
  if (head.charCodeAt(0) === 45) { sign = "-"; head = head.slice(1); }
  if (head.length > 3) head = head.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + head + tail;
}
function fmt(v)    { const n = Number(v); return (v != null && isFinite(n)) ? _thousands(String(+n.toFixed(4))) : "—"; }
function n2(v)     { return v!=null ? Number(v).toFixed(2) : "—"; }
function _fmtPx(p) {
  if (!isFinite(p)) return "—";
  const a = Math.abs(p);
  if (a >= 10000) return _thousands(String(+p.toFixed(1)));
  if (a >= 100)   return p.toFixed(2);
  if (a >= 1)     return p.toFixed(4);
  return p.toFixed(6);
}
function fmtVol(v) {
  if (v==null) return "—";
  if (v>=1e9) return (v/1e9).toFixed(2)+"B";
  if (v>=1e6) return (v/1e6).toFixed(2)+"M";
  if (v>=1e3) return (v/1e3).toFixed(1)+"K";
  return Number(v).toLocaleString();
}

function showToast(msg, ms = 4000) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#2a2e39;border:1px solid #ef5350;color:#d1d4dc;padding:8px 18px;border-radius:6px;z-index:9999;font-size:12px;pointer-events:none";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function showLoading(show) {
  let el = document.getElementById("loadingOverlay");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "loadingOverlay"; el.className = "loading-overlay";
      el.innerHTML = `<div class="loading-inner"><img src="/static/img/bear.png" class="loading-bear"/><span class="loading-text">處理中...</span></div>`;
      document.body.appendChild(el);
    }
  } else { el?.remove(); }
}


/* ── 互動偵測器(UX Governor)：偵測「使用者正在操作」與強度，供各模組漸進讓幀 ──
   訊號源=現成 window._chartMoveTs(圖表平移/縮放/慣性+全域捲動/觸控/滾輪都會標記,
   寫入端統一走 _uxMark 以追蹤「連續互動 session」:相鄰標記 ≤600ms 視為同一段)。
   ・_uxBusy()      互動中(最後標記 400ms 內)
   ・_uxSustained() 持續互動(同一段連續操作已 ≥800ms,如長距離拖曳/連續縮放)
   原則(使用者定調):取得平衡、不全讓——背景動畫漸進降檔(45→66→90ms)、
   報價列/行情照常更新不受影響。 */
(function () {
  let _sess = 0;
  const _now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  window._uxMark = function () {
    const n = _now();
    const prev = window._chartMoveTs || 0;
    if (!prev || n - prev > 600) _sess = n;   // 距上次互動 >600ms → 新的一段
    window._chartMoveTs = n;
  };
  window._uxBusy = function () {
    const t = window._chartMoveTs || 0;
    return !!t && (_now() - t) < 400;
  };
  window._uxSustained = function () {
    const t = window._chartMoveTs || 0;
    const n = _now();
    return !!t && (n - t) < 400 && _sess > 0 && (n - _sess) >= 800;
  };
})();
