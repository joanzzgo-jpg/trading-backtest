function toTime(s) {
  if (!s) return 0;
  // 後端大列表(勝率標記/缺口/VWAP…)的時間戳改送 **epoch 秒整數** 以瘦身(一個 ISO 字串 21B → 整數 10B,
  // 實測時間戳佔勝率回應 4 成)。ISO 字串仍全面支援(舊快取/其他端點/K棒 time 欄位) → 兩種都吃。
  // ⚠ 仍禁止 `str(pd.Timestamp)` 的空格格式(會 NaN → 餵 setMarkers 弄壞十字線),後端一律 isoformat 或 epoch。
  if (typeof s === "number") return Number.isFinite(s) ? Math.floor(s) + 8 * 3600 : 0;
  const iso = s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s + "T00:00:00Z";
  return Math.floor(new Date(iso).getTime() / 1000) + 8 * 3600;
}

/* 靜態資源路徑加上版號。JS 裡引用 /static/img/... 一律走這支。
   ⚠ 不加的話會跟 index.html 裡帶 ?v= 的同一張圖變成兩個不同 URL → 抓兩次、兩份快取，
     而且沒版號那份長快取永遠不會被新版沖掉（改了圖也不會更新）。
   版號由 index.html 的 window.__V 提供；讀不到就原樣回傳（不影響功能，只是少了破快取）。 */
function _v(path) {
  const v = window.__V;
  if (!v) return path;
  return path + (path.includes("?") ? "&" : "?") + "v=" + v;
}
window._v = _v;

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
  _syncUrlState();      // 網址同步反映現況 → 可直接複製分享／加書籤
}

/* ── 網址帶狀態（deep link，2026-08-02）────────────────────────────────────────
   ?s=BTC/USDT.P&tf=4h&m=crypto
   為什麼：原本網址永遠是 "/"，等於
     ・沒辦法把「BTC 4h 這個設定」加書籤或傳給別人
     ・重開只能靠 localStorage 那**唯一一組** lastSymbol，多分頁想各看各的就會互相覆蓋
   規則：網址有指定 → 網址優先（分享出去的連結必須忠實重現）；沒指定 → 完全照舊用 lastSymbol。
   ⚠ 只覆蓋標的/市場/時框，**不覆蓋縮放與視窗位置** —— 那是「我自己上次看到哪」的本機偏好，
     別人分享給你的連結不該連他的捲動位置一起搬過來。 */
function _applyUrlState() {
  try {
    const q = new URLSearchParams(location.search);
    const m = q.get("m"), sym = q.get("s"), tf = q.get("tf");
    if (m && ["crypto", "us", "tw", "hk"].includes(m)) document.getElementById("marketSelect").value = m;
    if (sym) document.getElementById("symbolInput").value = sym.trim();
    if (tf && TF_LABELS[tf]) {
      currentTF = tf;
      document.querySelectorAll(".tf-btn").forEach(b => b.classList.toggle("active", b.dataset.tf === currentTF));
    }
    return !!(sym || tf || m);
  } catch (e) { return false; }
}

/* 標的/時框變動時把網址同步成目前狀態。
   ⚠ 用 replaceState 不用 pushState：每切一次時框就塞一筆上一頁，會把返回鍵變成
     「倒退時框」——想離開這個頁面得按十幾次。網址只要「反映現況、可複製」就夠了。
   ⚠ 保留既有的其他參數（例如 ?mtab= 指定分頁），只動 s/tf/m。 */
function _syncUrlState() {
  try {
    const q = new URLSearchParams(location.search);
    const sym = document.getElementById("symbolInput")?.value?.trim();
    if (!sym) return;
    q.set("s", sym);
    q.set("tf", currentTF);
    q.set("m", document.getElementById("marketSelect")?.value || "crypto");
    const url = location.pathname + "?" + q.toString();
    if (url !== location.pathname + location.search) history.replaceState(null, "", url);
  } catch (e) {}
}

function loadLastSymbol() {
  try {
    const last = JSON.parse(localStorage.getItem("lastSymbol") || "null");
    if (!last || !last.symbol) { _applyUrlState(); return; }
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
  // 網址優先（放在最後：先讓 lastSymbol 還原縮放等本機偏好，再讓網址覆蓋標的/時框）
  if (_applyUrlState()) _pendingRestoreRange = null;   // 別人分享的連結 → 不套用我上次的縮放
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
    // 收合狀態改看 pane 自己的 class（每個 pane 上的「−」鈕已移除，改用左側工具列的勾選選單）
    const isCollapsed = el.classList.contains("pane-collapsed");
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
    ["kdjPane", "rsiPane", "macdPane"].forEach(id => {
      const p = document.getElementById(id);
      if (p && p.classList.contains("pane-collapsed"))
        collapsedPanes[id] = paneCollapseFlex[id] || "1";
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
      // 每個 pane 上的「−」鈕已移除(改成左側工具列的 hover 勾選選單) → 直接呼叫收合
      if (typeof _hidePane === "function") _hidePane(paneId);
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
  // 看歷史切時框「一次到位」：window._loadRangeStart(秒) 設定時直接抓「該段~至今」→ 第一次畫就對齊、不滑動。
  //   只在後端能一次供完整(BTC/ETH/SOL 5m 倉庫+新尾巴)時才設(render.js 有把關),避免往最新斷。
  const _rs = window._loadRangeStart;
  const _re = window._loadRangeEnd;
  const _rangeMode = (typeof _rs === "number" && isFinite(_rs));
  return {
    market:    document.getElementById("marketSelect").value,
    symbol:    sym,
    start:     _rangeMode ? new Date(_rs * 1000).toISOString().slice(0, 10) : "",
    // 捲歷史切換：end 也帶(目標右緣+少量緩衝)→ 後端只切「目標附近有界視窗」數百根、秒回不卡;end 空=抓到現在(舊行為)
    end:       (_rangeMode && typeof _re === "number" && isFinite(_re)) ? new Date(_re * 1000).toISOString().slice(0, 10) : "",
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
// 把字串塞進 innerHTML 樣板前一律先過這裡。
// 為什麼需要：標的搜尋清單的公司名／代號是**外部 API 回來的**（Finnhub / TwelveData /
//   yfinance / TWSE / cnyes），我們既把它放進文字節點、也放進 data-symbol="..." 屬性。
//   ・功能面：名稱裡只要有一個 " 就會提前關掉屬性 → data-symbol 被截斷 → 點下去載錯標的。
//   ・安全面：上游若回 <img onerror=...> 就直接在使用者頁面上執行。
// 兩種位置共用一份（連 " 和 ' 一起跳脫）→ 文字與屬性都安全。
// 報價列每秒重繪上百列 → 先用一次 test() 判有沒有危險字元，絕大多數（純代號）直接原樣回，
// 不跑那 5 趟 replace。
const _ESC_RE = /[&<>"']/;
const _ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escHtml(s) {
  const str = (typeof s === "string") ? s : (s == null ? "" : String(s));
  return _ESC_RE.test(str) ? str.replace(/[&<>"']/g, c => _ESC_MAP[c]) : str;
}
/* 價格顯示格式（符號列 OHLC、BB 圖例共用）。
   ★2026-08-02 改成隨價格級距調整小數位。原本一律 toFixed(4)，兩頭都不對：
     ・大價位 → BTC 顯示 65,089.7364，後面兩位是雜訊、又佔掉圖例橫向空間
     ・小價位 → **直接變成 0**：0.00001234 → "0"、8.12e-7 → "0"
       （報價列用的是另一個 fmtTickerPrice 所以看起來正常，只有主圖這條壞掉）
       低價幣（SHIB/PEPE 這類）的開高低收與布林值等於完全看不到。
   規則：≥100 兩位；1~100 四位；<1 則「第一個有效數字之後再取 4 位」→ 再小都看得到數字。 */
function fmt(v) {
  const n = Number(v);
  if (v == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  let d;
  if (a >= 100)   d = 2;
  else if (a >= 1) d = 4;
  else if (a > 0)  d = Math.min(12, Math.max(4, Math.ceil(-Math.log10(a)) + 3));
  else             d = 2;
  // ⚠ 不可用 +n.toFixed(d) 轉回 Number 再轉字串：JS 在小於 1e-6 時會切成科學記號
  //   （8.12e-7 會原樣顯示成 "8.12e-7"，看盤時完全不能用）。改成直接修剪字串尾端的 0。
  let out = n.toFixed(d);
  if (out.indexOf(".") >= 0) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return _thousands(out);
}
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

/* 全站浮動提示 —— **預設靜音**。
   使用者 2026-08-11：「提示框可以拿掉，只有找不到標的時需要，操作上不用」。
   ★ 為什麼是「預設靜音 + 呼叫端明確開啟」而不是刪掉函式或用關鍵字過濾：
     ・呼叫端有 20 幾處（繪圖復原/顏色衝突/儲存已滿/同步/PWA 安裝/時框數量…），
       刪函式要全部改一遍、還會漏掉 draw.js 那種 `typeof showToast === "function"` 的動態呼叫。
     ・用關鍵字猜「哪些算找不到標的」很脆弱，訊息一改就默默失效。
   ★ 靜音的也還是 console.debug 出來 —— 這個專案吃過太多次「錯誤被靜默吞掉」的虧
     （後端 500 因為前端 .catch 而隱形好幾天），不要為了畫面乾淨連診斷線索都沒了。
   目前唯一會顯示的：render.js 載入失敗那支（後端回的「查無標的」等訊息）。
   樣式在 style.css 的 #toastHost / .app-toast。 */
function showToast(msg, ms = 4000, show = false) {
  if (!show) {
    try { console.debug("[toast 靜音]", msg); } catch (e) {}
    return;
  }
  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    document.body.appendChild(host);
  }
  const s = String(msg == null ? "" : msg);
  // 依訊息語意分色。★ 刻意用「讀訊息內容」而不是加參數：呼叫端散在 20 幾處
  //   （繪圖/載入/安裝/同步…），加參數就得全部改一遍還容易漏，而這些訊息本來就帶
  //   ⚠ ✅ ↩ ✏️ 這類前綴與「失敗/已復原」等字眼，直接判就夠準。
  const kind = /失敗|錯誤|無法|已滿|沒能/.test(s) ? "t-err"
             : /^[✅✔🎉↩✏]|已安裝|已同步|已復原|已存/.test(s) ? "t-ok"
             : "t-warn";
  const el = document.createElement("div");
  el.className = "app-toast " + kind;
  el.textContent = s;
  host.appendChild(el);
  while (host.children.length > 3) host.firstChild.remove();   // 別堆成一面牆
  requestAnimationFrame(() => el.classList.add("on"));
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => { el.remove(); if (!host.children.length) host.remove(); }, 260);
  }, ms);
}

/* ── 切時框/標的：TV 式主圖過場暗場(只蓋 #mainChart 的 K 棒區，非整頁) ──
   _chartDimOn 進場立刻淡暗;_chartDimOff 淡回，但保證整段至少維持 ~0.24s，
   讓「快照秒畫→真資料 renderAll→背景補載」的內容抽換都藏在暗場下＝像 TV 一次乾淨換圖，不再看到舊圖先閃。 */
let _chartDimT0 = 0;
let _chartDimFailsafe = null;
window._chartDimOn = function () {
  const body = document.getElementById("mainChart");   // .pane-body(position:relative)
  if (!body) return;
  let el = document.getElementById("chartDimVeil");
  if (!el) { el = document.createElement("div"); el.id = "chartDimVeil"; body.appendChild(el); void el.offsetWidth; }
  el.classList.add("on");
  _chartDimT0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  // 失效保險：即使呼叫端漏收(如捲歷史切換的 align 補載一直沒涵蓋目標)，最多 2.5s 也強制淡回，絕不卡黑。
  if (_chartDimFailsafe) clearTimeout(_chartDimFailsafe);
  _chartDimFailsafe = setTimeout(() => { const e = document.getElementById("chartDimVeil"); if (e) e.classList.remove("on"); }, 2500);
};
window._chartDimOff = function () {
  const el = document.getElementById("chartDimVeil");
  if (!el) return;
  if (_chartDimFailsafe) { clearTimeout(_chartDimFailsafe); _chartDimFailsafe = null; }
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const wait = Math.max(0, 160 - (now - _chartDimT0));   // 至少維持 ~0.16s(圖畫好即呼叫本函式;floor 只保證過場可辨識、不多壓死時間)
  setTimeout(() => { const e = document.getElementById("chartDimVeil"); if (e) e.classList.remove("on"); }, wait);
};

function showLoading(show) {
  let el = document.getElementById("loadingOverlay");
  if (show) {
    if (!el) {
      el = document.createElement("div");
      el.id = "loadingOverlay"; el.className = "loading-overlay";
      el.innerHTML = `<div class="loading-inner"><img src="${_v("/static/img/bear.png")}" class="loading-bear"/><span class="loading-text">處理中...</span></div>`;
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

/* ── 效能探針 window._perfProbe(秒) ────────────────────────────────────────────
   為什麼要有：headless 測試永遠只反映「測試環境的設定」。2026-07-30 使用者回報「放大就卡」，
   我用 12 個縮放等級 × DPR 1/2 × 足跡開關全測不出來——因為卡的原因是某個**預設關閉、
   但使用者開著**的疊加層。與其猜，不如讓使用者在自己的機器、自己的設定下按一下就給出數據。
   用法：在瀏覽器 console 打 `_perfProbe(8)` → 邊拖曳邊量 8 秒 → 印出逐幀統計 + 各圖層成本
   + 目前開了哪些疊加層 + DPR/根數。把輸出貼回來就能直接定位。
   ⚠ 純診斷：不呼叫就完全沒有成本（只是掛一個函式）。 */
window._perfProbe = function (sec, silent) {
  sec = Math.max(2, Math.min(30, sec || 8));
  const P = {}, orig = {};
  const wrap = (nm) => {
    const f = window[nm];
    if (typeof f !== "function") return;
    orig[nm] = f;
    P[nm] = { n: 0, ms: 0, max: 0 };
    window[nm] = function (...a) {
      const t = performance.now();
      try { return f.apply(this, a); }
      finally { const d = performance.now() - t, s = P[nm]; s.n++; s.ms += d; if (d > s.max) s.max = d; }
    };
  };
  ["renderDrawings", "_drawSessionOverlay", "_drawVolumeProfile", "_drawKeyLevels", "_drawPDZones",
   "_drawCoachOverlay", "_drawVWAP", "_drawMyTrades", "_applyMainMarkersNow", "renderVolume",
   "renderBB", "_bgApplyChunk", "_rebuildTimeIndex"].forEach(wrap);

  const frames = [];
  let last = performance.now(), stop = false;
  const tick = () => { const n = performance.now(); frames.push(n - last); last = n; if (!stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  if (!silent) console.log(`%c[效能探針] 開始量測 ${sec} 秒 — 現在請重現你覺得卡的操作（拖曳/縮放）`,
                           "color:#2962ff;font-weight:bold");

  setTimeout(() => {
    stop = true;
    for (const nm in orig) window[nm] = orig[nm];
    const f = frames.filter(x => x > 4).sort((a, b) => a - b);
    const q = p => f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * p))].toFixed(1) : 0;
    let bs = 0; try { bs = +mainChart.timeScale().options().barSpacing.toFixed(1); } catch (e) {}
    let vis = 0; try { const r = mainChart.timeScale().getVisibleLogicalRange(); vis = r ? Math.round(r.to - r.from) : 0; } catch (e) {}
    const on = [];
    const flag = (v, name) => { try { if (v) on.push(name); } catch (e) {} };
    flag(typeof _fpShow !== "undefined" && _fpShow, "足跡");
    flag(window._coachOn, "教練"); flag(window._vwapOn, "VWAP");
    flag(typeof _htfFvgOn !== "undefined" && _htfFvgOn, "大時框FVG");
    flag(typeof _domShow !== "undefined" && _domShow, "訂單簿");
    flag(typeof _obShow !== "undefined" && _obShow, "掛單");
    flag(window._pdhlOn, "關鍵高低"); flag(window._econOn, "經濟事件");
    flag(window._engulfOn, "吞噬"); flag(window._swingOn, "轉折");
    flag(window._dimBigBarOn, "大棒淡化"); flag(window._dimVolOn, "量淡化");
    flag(document.documentElement.classList.contains("sky-show"), "天氣背景");
    flag(document.documentElement.classList.contains("perf-mode"), "極簡模式");
    flag(!(typeof _subchartsHidden === "function" && _subchartsHidden()), "副圖指標");

    // ⚠ rows 必須宣告在 if 外面:下方組回報也要用(第一版誤包進 if 內 → silent 模式拋
    //   「rows is not defined」,自動回報整條掛掉、後端收不到任何東西)。
    const rows = Object.entries(P).filter(([, v]) => v.n).sort((a, b) => b[1].ms - a[1].ms);
    if (!silent) {
      console.log("%c[效能探針] 結果", "color:#2962ff;font-weight:bold");
      console.log(`  幀：中位 ${q(0.5)}ms · p95 ${q(0.95)}ms · 最長 ${q(1)}ms · >50ms ${frames.filter(x => x > 50).length} 個 · >100ms ${frames.filter(x => x > 100).length} 個`);
      console.log(`  環境：DPR ${window.devicePixelRatio} · ${(typeof ohlcvData !== "undefined" ? ohlcvData.length : 0)} 根 · barSpacing ${bs} · 可見 ${vis} 根 · ${(typeof currentTF !== "undefined" ? currentTF : "?")}`);
      console.log(`  開著的疊加層：${on.length ? on.join("、") : "（都沒開）"}`);
      console.log("  各圖層（總 ms／次數／每次／最長）：");
      for (const [k, v] of rows)
        console.log(`     ${k.padEnd(22)} ${v.ms.toFixed(0).padStart(6)}ms  ${String(v.n).padStart(5)}次  ${(v.ms / v.n).toFixed(2).padStart(6)}ms  最長 ${v.max.toFixed(1)}ms`);
    }
    // ★同時回傳後端（使用者無法把 console 貼回來 → 開發端用 GET /api/_perf_report 讀）
    const report = {
      frames: { p50: q(0.5), p95: q(0.95), max: q(1),
                over50: frames.filter(x => x > 50).length,
                over100: frames.filter(x => x > 100).length, n: frames.length },
      auto: !!silent,
      env: { dpr: window.devicePixelRatio, bars: (typeof ohlcvData !== "undefined" ? ohlcvData.length : 0),
             barSpacing: bs, visible: vis, tf: (typeof currentTF !== "undefined" ? currentTF : "?"),
             sym: document.getElementById("symbolInput")?.value || "?",
             w: window.innerWidth, h: window.innerHeight, sec },
      on,
      layers: rows.map(([k, v]) => ({ f: k, ms: +v.ms.toFixed(1), n: v.n,
                                      per: +(v.ms / v.n).toFixed(3), max: +v.max.toFixed(1) })),
    };
    fetch("/api/_perf_report", { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify(report) })
      .then(r => { if (r.ok && !silent) console.log("%c  ✓ 結果已回傳，不用複製貼上", "color:#26a69a;font-weight:bold"); })
      .catch(() => { if (!silent) console.log("%c  ↑ 回傳失敗，請把以上整段貼回對話", "color:#888"); });
  }, sec * 1000);
  return `量測中… ${sec} 秒後在 console 印出結果`;
};

/* ── 自動卡頓回報 ─────────────────────────────────────────────────────────────
   為什麼:使用者環境無法複製貼上、也不方便開 console(2026-07-30)。而 headless 測不出他機器上的
   卡頓——卡的原因通常是「某個預設關閉、但他開著」的疊加層(足跡那個 bug 就是這樣才找到的)。
   → 讓 app 自己發現卡頓、自己量、自己回報,使用者只要正常操作。
   機制:
     ・只在「圖表互動中」才跑取樣迴圈(停手 1.2s 自動停)→ 閒置時零成本、不阻止瀏覽器節流 rAF。
     ・一次互動內出現 ≥4 個 >50ms 的幀 → 判定卡頓 → 靜默啟動詳細探針 5 秒(包裝各圖層計時),
       量完自動 POST /api/_perf_report。
     ・節流:每 3 分鐘最多一次、整個分頁最多 5 次 → 不會洗版、不影響效能。 */
(function autoJankReport() {
  let sampling = false, probing = false, sent = 0, lastSent = 0;
  const MAX_SENT = 5, COOLDOWN = 180000, JANK_MS = 50, JANK_MIN = 4;

  function evaluate(frames) {
    const slow = frames.filter(x => x > JANK_MS).length;
    if (slow < JANK_MIN) return;
    const now = Date.now();
    if (probing || sent >= MAX_SENT || now - lastSent < COOLDOWN) return;
    probing = true; sent++; lastSent = now;
    try { window._perfProbe(5, true); } catch (e) {}
    setTimeout(() => { probing = false; }, 6000);
  }

  function start() {
    if (sampling || probing) return;
    if (typeof window._perfProbe !== "function") return;
    sampling = true;
    const frames = [];
    let last = performance.now();
    const t0 = last;
    const tick = () => {
      const n = performance.now(), d = n - last; last = n;
      if (d < 4000) frames.push(d);          // 忽略分頁被切走/睡眠造成的巨大間隔
      // ★至少量 2.5 秒再看「是否停手」:pointerdown 當下 _chartMoveTs 還沒被設(要 move 才更新),
      //   只看 moving 會在第一幀就退出 → 永遠取樣不到(2026-07-30 第一版就是這樣沒觸發)。
      const warmup = (n - t0) < 2500;
      const moving = window._chartMoveTs && (n - window._chartMoveTs) < 1200;
      if ((warmup || moving) && frames.length < 900) { requestAnimationFrame(tick); return; }
      sampling = false;
      evaluate(frames);
    };
    requestAnimationFrame(tick);
  }

  function bind() {
    const el = document.getElementById("mainChart");
    if (!el) { setTimeout(bind, 1500); return; }
    ["wheel", "pointerdown", "touchstart"].forEach(ev =>
      el.addEventListener(ev, start, { passive: true, capture: true }));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
