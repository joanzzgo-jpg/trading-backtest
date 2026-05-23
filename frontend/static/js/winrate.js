let _wrCache = {};
let _wrCacheLast = null;  // 保留最近一次資料，給 toggle target 重渲用
let _wrFetchTimer = null; // 切換標的時 debounce，避免連續觸發後端重算

// 目標切換（中軌 ↔ 帶軌）狀態
const _WR_VIEW_KEY = "wrTargetView";
let _wrTargetView = "mid";
try { _wrTargetView = localStorage.getItem(_WR_VIEW_KEY) || "mid"; } catch (e) {}

// 訊號版本（原版 ↔ 強化版：量能 > 1.5× MA20）狀態
const _WR_VARIANT_KEY = "wrVariantView";
let _wrVariantView = "base";  // "base" | "variant"
try { _wrVariantView = localStorage.getItem(_WR_VARIANT_KEY) || "base"; } catch (e) {}

// 點擊訊號 K 棒展開的自動盈虧比盒：Set<signal.t>
const _autoRRSet = new Set();
let _autoRRHintShown = false;
try { _autoRRHintShown = localStorage.getItem("wrAutoRRHintShown") === "1"; } catch (e) {}

// 停損緩衝（%；UI 顯示 0.5 表示 0.5%，API 收 decimal 0.005）
const _WR_BUFFER_KEY = "wrStopBuffer";
let _wrStopBuffer = 0;
try { _wrStopBuffer = parseFloat(localStorage.getItem(_WR_BUFFER_KEY)) || 0; } catch (e) {}

// 加碼設定（auto-RR 盒用）：加碼量分「低於/高於入場價」兩種 + 觸發來源開關
let _pyrSizeBelow = 1.0;      // 加碼點價格 < 入場價 時的加碼量（× 初始倉）
let _pyrSizeAbove = 1.0;      // 加碼點價格 ≥ 入場價 時的加碼量（× 初始倉）
let _pyrUseIndicator = true;  // 同方向 CRT/共振/KDJ叉 觸發加碼
let _pyrUseBBrev = false;     // BB 反轉型態觸發加碼（碰下軌綠K接紅K收中軌上 / 反之）
try {
  const _old = parseFloat(localStorage.getItem("wrPyrSize"));   // 舊單一值 → 兩者預設
  const _dft = (_old > 0) ? _old : 1.0;
  const b = parseFloat(localStorage.getItem("wrPyrSizeBelow")); _pyrSizeBelow = (b > 0) ? b : _dft;
  const a = parseFloat(localStorage.getItem("wrPyrSizeAbove")); _pyrSizeAbove = (a > 0) ? a : _dft;
  _pyrUseIndicator = localStorage.getItem("wrPyrIndicator") !== "0";
  _pyrUseBBrev = localStorage.getItem("wrPyrBBrev") === "1";
} catch (e) {}

function _initWrTargetBtn() {
  const btn = document.getElementById("wrTargetToggle");
  if (!btn) return;
  // 三種目標：中軌（BB middle）／上下軌（方向相關極端，多→上軌、空→下軌）／1:1（止盈距離=止損距離）
  btn.textContent = _wrTargetView === "band" ? "上/下軌"
                  : _wrTargetView === "rr"   ? "1:1"
                  :                            "中軌";
  btn.classList.toggle("band", _wrTargetView === "band");
  btn.classList.toggle("rr",   _wrTargetView === "rr");
}

// 取當前目標 view（mid 在頂層、band/rr 在巢狀子物件）
function _wrPickView(d) {
  if (!d) return d;
  if (_wrTargetView === "band" && d.band) return d.band;
  if (_wrTargetView === "rr"   && d.rr)   return d.rr;
  return d;
}
// 當前目標對應的「訊號結果 / 結算時間」欄位名
function _wrResultKey() {
  return _wrTargetView === "band" ? "r_b" : _wrTargetView === "rr" ? "r_rr" : "r";
}
function _wrOtKey() {
  return _wrTargetView === "band" ? "ot_b" : _wrTargetView === "rr" ? "ot_rr" : "ot";
}

function _initWrVariantBtn() {
  const btn = document.getElementById("wrVariantToggle");
  if (!btn) return;
  btn.textContent = _wrVariantView === "variant" ? "強化版" : "原版";
  btn.classList.toggle("variant", _wrVariantView === "variant");
}

// 連敗風險顯示 N：0=關、2=2連(敗後再敗)、3=三連敗、4=四連敗。預設關（避免擠到 TOP3 列）
// 按鈕本身就畫在 TOP3 上列（_renderWrTop3 內），用 inline onclick 不需另外綁事件
let _wrStreakN = 0;
try { _wrStreakN = parseInt(localStorage.getItem("wrStreakN")) || 0; } catch (e) {}

function _cycleStreakN() {
  // 關 → 2連 → 3連 → 4連 → 敗後停手(5) → 關
  _wrStreakN = _wrStreakN === 0 ? 2 : _wrStreakN >= 5 ? 0 : _wrStreakN + 1;
  try { localStorage.setItem("wrStreakN", String(_wrStreakN)); } catch (e) {}
  _renderWrTop3();
}

function _toggleWrVariant() {
  _wrVariantView = _wrVariantView === "variant" ? "base" : "variant";
  try { localStorage.setItem(_WR_VARIANT_KEY, _wrVariantView); } catch (e) {}
  _initWrVariantBtn();
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
  _renderWRSignals();  // 主圖 marker 過濾改變
  if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
  // 自動盈虧比盒目標位也會改變（變強的 marker 數量變了）
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
}

// 給左側抽屜的加碼設定呼叫：更新 module 變數 + localStorage + 重畫盒子
window._setPyrSetting = function (key, val) {
  if (key === "sizeBelow") {
    _pyrSizeBelow = (val > 0 ? val : 1.0);
    try { localStorage.setItem("wrPyrSizeBelow", String(_pyrSizeBelow)); } catch (e) {}
  } else if (key === "sizeAbove") {
    _pyrSizeAbove = (val > 0 ? val : 1.0);
    try { localStorage.setItem("wrPyrSizeAbove", String(_pyrSizeAbove)); } catch (e) {}
  } else if (key === "indicator") {
    _pyrUseIndicator = !!val;
    try { localStorage.setItem("wrPyrIndicator", val ? "1" : "0"); } catch (e) {}
  } else if (key === "bbrev") {
    _pyrUseBBrev = !!val;
    try { localStorage.setItem("wrPyrBBrev", val ? "1" : "0"); } catch (e) {}
  }
  if (typeof _autoRRBoxCache !== "undefined") _autoRRBoxCache.clear();  // 重算盒子
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
};
window._getPyrSettings = function () {
  return { sizeBelow: _pyrSizeBelow, sizeAbove: _pyrSizeAbove,
           indicator: _pyrUseIndicator, bbrev: _pyrUseBBrev };
};

// 設定止損緩衝%（給左抽屜的「套用建議」鈕與止損輸入框共用）→ 同步上方 SL 框 + 重算
window._setStopBuffer = function (pct) {
  const v = Math.max(0, Math.min(10, parseFloat(pct) || 0));
  _wrStopBuffer = v;
  const inp = document.getElementById("wrStopBuffer");
  if (inp) inp.value = v;
  try { localStorage.setItem(_WR_BUFFER_KEY, String(v)); } catch (e) {}
  _wrCache = {};
  fetchWinRate();
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
};

function _initWrStopBuffer() {
  const inp = document.getElementById("wrStopBuffer");
  if (!inp) return;
  inp.value = _wrStopBuffer;
  inp.addEventListener("change", () => {
    const v = Math.max(0, Math.min(10, parseFloat(inp.value) || 0));
    inp.value = v;
    _wrStopBuffer = v;
    try { localStorage.setItem(_WR_BUFFER_KEY, String(v)); } catch (e) {}
    _wrCache = {};
    fetchWinRate();
    // 已展開的自動盈虧比盒也跟著新 buffer 重畫止損位
    if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  });
}

function _toggleWrTarget() {
  // 三段循環：中軌 → 上/下軌 → 1:1 → 中軌
  _wrTargetView = _wrTargetView === "mid" ? "band"
                : _wrTargetView === "band" ? "rr"
                : "mid";
  try { localStorage.setItem(_WR_VIEW_KEY, _wrTargetView); } catch (e) {}
  _initWrTargetBtn();
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
  // marker 與自動盈虧比盒都跟著切：止盈位置 BB 中軌 ↔ 上/下軌 ↔ 1:1
  _renderWRSignals();
  if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
}

/* ══════════════════════════════════════════
   點擊訊號 K 棒 → 自動畫盈虧比盒（功能類似左邊 longpos/shortpos 工具）
   - 切換中軌/上下軌時自動重算目標位
   - 點擊已展開的訊號 → 收回
   - 多個訊號可同時顯示
══════════════════════════════════════════ */

// 找出與點擊時間（K 棒）對應的訊號：可命中進場棒（s.t）或結算棒（s.ot/s.ot_b）
function _findSignalAtTime(barTime) {
  if (!barTime || !_lastWRSignals) return null;
  const otKey = _wrOtKey();
  // 強化版時只考慮 v=true 訊號
  const list = _wrVariantView === "variant"
    ? _lastWRSignals.filter(s => s.v)
    : _lastWRSignals;
  for (const s of list) {
    if (toTime(s.t) === barTime) return s;
    const exitT = s[otKey];
    if (exitT && toTime(exitT) === barTime) return s;
  }
  return null;
}

// 點擊訊號棒 toggle 顯示盈虧比盒；回傳是否成功 toggle
function _toggleAutoRR(barTime) {
  const sig = _findSignalAtTime(barTime);
  if (!sig) return false;
  const key = sig.t;  // 用進場棒時間當 key
  if (_autoRRSet.has(key)) {
    _autoRRSet.delete(key);
  } else {
    _autoRRSet.add(key);
    if (!_autoRRHintShown && typeof showToast === "function") {
      showToast("📊 已展開盈虧比；切換中軌/上下軌會自動更新；再點一次收回");
      _autoRRHintShown = true;
      try { localStorage.setItem("wrAutoRRHintShown", "1"); } catch (e) {}
    }
  }
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  return true;
}

// 由訊號 + 目前 view 算出盈虧比盒參數
// tp     = 預估止盈（進場時 BB 位置）→ 主線
// tpAct  = 實際止盈（結算棒 BB 位置）→ 副線（僅 win 有）
// memo 結果以 (sig.t, view, buf, dataVersion) 為 key 快取，避免每幀重算 findIndex
const _autoRRBoxCache = new Map();
function _autoRRCacheKey(sig) {
  const buf = (typeof _wrStopBuffer !== "undefined") ? _wrStopBuffer : 0;
  const view = (typeof _wrTargetView !== "undefined") ? _wrTargetView : "mid";
  const ver = (typeof _dataVersion !== "undefined") ? _dataVersion : 0;
  return `${sig.t}|${view}|${buf}|${ver}`;
}

function _computeAutoRRBox(sig) {
  if (!sig || !ohlcvData || !ohlcvData.length) return null;
  const cacheKey = _autoRRCacheKey(sig);
  if (_autoRRBoxCache.has(cacheKey)) return _autoRRBoxCache.get(cacheKey);

  const useBand = _wrTargetView === "band";
  const isRR    = _wrTargetView === "rr";
  const sigIdx = (typeof _timeToIdx !== "undefined" && _timeToIdx.has(sig.t))
    ? _timeToIdx.get(sig.t)
    : ohlcvData.findIndex(d => d.time === sig.t);
  if (sigIdx < 0 || sigIdx >= ohlcvData.length - 1) {
    _autoRRBoxCache.set(cacheKey, null); return null;
  }
  const sigBar   = ohlcvData[sigIdx];
  const entryBar = ohlcvData[sigIdx + 1];
  if (entryBar == null || entryBar.open == null) {
    _autoRRBoxCache.set(cacheKey, null); return null;
  }
  const dir = sig.d;
  const isShort = dir === "s";
  const buf = (_wrStopBuffer || 0) / 100;
  // 止損價優先用後端實際值（含 buffer、多棒取極值）；缺漏時退回單根訊號棒（舊資料相容）
  let tp, sl, type, color;
  if (isShort) {
    sl = (sig.stop != null) ? sig.stop : sigBar.high * (1 + buf);
    // 1:1：止盈距離 = 止損距離（進場價 - 風險）；否則中軌/下軌
    tp = isRR ? (entryBar.open - (sl - entryBar.open))
       : useBand ? entryBar.bb_lower : entryBar.bb_middle;
    type = "shortpos"; color = "#ef5350";
  } else {
    sl = (sig.stop != null) ? sig.stop : sigBar.low * (1 - buf);
    tp = isRR ? (entryBar.open + (entryBar.open - sl))
       : useBand ? entryBar.bb_upper : entryBar.bb_middle;
    type = "longpos"; color = "#26a69a";
  }
  if (tp == null) { _autoRRBoxCache.set(cacheKey, null); return null; }

  // 結算位置
  let tpAct = null;
  const exitT  = sig[_wrOtKey()];
  const result = sig[_wrResultKey()];
  let exitIdx = -1;
  if (exitT) {
    exitIdx = (typeof _timeToIdx !== "undefined" && _timeToIdx.has(exitT))
      ? _timeToIdx.get(exitT)
      : ohlcvData.findIndex(d => d.time === exitT);
  }
  if (exitT && result === "w" && exitIdx >= 0) {
    if (isRR) {
      tpAct = tp;  // 1:1 目標固定，實際止盈 = 預估止盈
    } else {
      const exitBar = ohlcvData[exitIdx];
      if (isShort) tpAct = useBand ? exitBar.bb_lower : exitBar.bb_middle;
      else         tpAct = useBand ? exitBar.bb_upper : exitBar.bb_middle;
    }
  }

  // 加碼系統：進場後到 TP/SL 之前，每次出現加碼訊號，下根用開盤價加碼
  // 觸發來源（可在抽屜設定）：
  //   (a) 同方向 CRT/共振/KDJ叉
  //   (b) BB 反轉型態：多→前根碰下軌+綠K(跌)、當根紅K(漲)且收中軌上；空→對稱
  const entryIdx = sigIdx + 1;
  // 未結算訊號不可掃到資料尾端（會讓加碼點散落整張圖）→ 設 50 根上限
  const PYR_CAP = 50;
  // 已結算的單：加碼點必須嚴格落在「結算棒之前」→ 掃到 exitIdx-1（加碼點 j+1 最多 exitIdx-1）。
  // 否則交易已於結算棒平倉，卻還在同根補一個無效加碼部位。
  const lastIdx = (exitIdx > entryIdx) ? (exitIdx - 1) : Math.min(ohlcvData.length - 1, entryIdx + PYR_CAP);
  const pyramids = [];   // {time, price, idx}
  const indCond = isShort
    ? (b) => b.crt === -1 || b.kdj_cross === -1 || b.resonance === -1
    : (b) => b.crt === 1  || b.kdj_cross === 1  || b.resonance === 1;
  const bbRevCond = (j) => {
    if (j < 1) return false;
    const prev = ohlcvData[j - 1], cur = ohlcvData[j];
    if (!prev || !cur) return false;
    if (isShort) {
      // 碰上軌 + 前根紅K(漲) + 當根綠K(跌) 且收中軌下
      return prev.bb_upper != null && cur.bb_middle != null
        && prev.high >= prev.bb_upper
        && prev.close > prev.open && cur.close < cur.open
        && cur.close < cur.bb_middle;
    }
    // 碰下軌 + 前根綠K(跌) + 當根紅K(漲) 且收中軌上
    return prev.bb_lower != null && cur.bb_middle != null
      && prev.low <= prev.bb_lower
      && prev.close < prev.open && cur.close > cur.open
      && cur.close > cur.bb_middle;
  };
  const entryPx = entryBar.open;
  const szBelow = (_pyrSizeBelow > 0 ? _pyrSizeBelow : 1.0);
  const szAbove = (_pyrSizeAbove > 0 ? _pyrSizeAbove : 1.0);
  // 已結算單的結算棒時間（秒）。用時間比對當保險：即使 exitIdx 在已載入資料中
  // 找不到（結算棒未載入 / band 視圖未結算），也不會把加碼掃到結算之後。
  const exitSec = exitT ? toTime(exitT) : null;
  for (let j = entryIdx; j < lastIdx; j++) {
    const bar = ohlcvData[j];
    if (!bar) continue;
    const hit = (_pyrUseIndicator && indCond(bar)) || (_pyrUseBBrev && bbRevCond(j));
    if (hit) {
      const next = ohlcvData[j + 1];
      if (!next || next.open == null) continue;
      // 加碼點必須嚴格在結算棒之前；到達結算棒(含)就停止加碼
      if (exitSec != null && toTime(next.time) >= exitSec) break;
      // 加碼量依「加碼價 vs 入場價」決定：低於入場價用 szBelow、否則 szAbove
      const sz = next.open < entryPx ? szBelow : szAbove;
      pyramids.push({ idx: j + 1, time: toTime(next.time), price: next.open, sz });
    }
  }
  // 均減進場價（初始 1 單位 + 每加碼 p.sz 單位，加權平均）
  const totalUnits = 1 + pyramids.reduce((a, p) => a + p.sz, 0);
  const weightedSum = entryPx + pyramids.reduce((a, p) => a + p.price * p.sz, 0);
  const avgEntry = weightedSum / totalUnits;

  // 盒寬：到結算棒，沒結算就 8 根；並確保涵蓋所有加碼點
  let barWidth = 8;
  if (exitIdx > sigIdx) barWidth = Math.max(3, exitIdx - sigIdx);
  if (pyramids.length) {
    const lastPyrIdx = pyramids[pyramids.length - 1].idx;
    barWidth = Math.max(barWidth, lastPyrIdx - sigIdx);
  }

  const box = {
    id: "_autoRR_" + sig.t,
    type, color, barWidth,
    p1: { time: toTime(entryBar.time), price: entryBar.open },
    tp, sl, tpAct,
    pyramids: pyramids,
    avgEntry: avgEntry,
    _isAutoRR: true,
    // 1:1 目標：止盈/止損以「原始進場價」等距定義，盒子的區塊/RR 須用原始進場價當基準
    // （不可用加碼均價 avgEntry，否則紅綠區塊不對稱、標示看起來不是 1:1）
    _rrFixed: isRR,
  };
  _autoRRBoxCache.set(cacheKey, box);
  return box;
}

// 渲染所有展開中的自動盈虧比盒（由 draw.js 的 renderDrawings 末端呼叫）
function _renderAutoRRBoxes(W, H) {
  if (!_autoRRSet.size || typeof drawOne !== "function") return;
  for (const t of _autoRRSet) {
    const sig = _lastWRSignals && _lastWRSignals.find(s => s.t === t);
    if (!sig) continue;
    const box = _computeAutoRRBox(sig);
    if (box) drawOne(box, W, H, false, false);
  }
}

// 切換標的/時框時清空已展開的盒（舊訊號的時間在新資料中不存在）
function _clearAutoRR() {
  _autoRRBoxCache.clear();  // 清 memo cache
  if (_autoRRSet.size) {
    _autoRRSet.clear();
    if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  }
}

// 公開的進入點：debounced，避免切換標的時連續觸發
function fetchWinRate() {
  clearTimeout(_wrFetchTimer);
  _wrFetchTimer = setTimeout(_fetchWinRateNow, 250);
}

async function _fetchWinRateNow() {
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) return;
  const bufDec = (_wrStopBuffer || 0) / 100;
  const cacheKey = `${market}:${symbol}:${exchange}:${timeframe}:${bufDec.toFixed(4)}`;
  if (_wrCache[cacheKey]) {
    _renderWinRate(_wrCache[cacheKey]);
    _renderWRSignals(_wrCache[cacheKey].signals);
    // 快取命中也要刷新左抽屜（含敗後停手求解），否則切回已載入過的標的時抽屜不更新
    if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
    return;
  }
  // 進入「計算中」狀態：舊數據變暗、進度條動畫 0→95%，避免使用者誤判前一個 symbol 的數據
  const bar = document.getElementById("winrateBar");
  const statusEl = document.getElementById("wrStatus");
  if (bar) {
    bar.classList.remove("calculating"); // 強制重啟動畫
    void bar.offsetWidth;                // 強制 reflow
    bar.classList.add("calculating");
  }
  // 不寫 "計算中…" 到 wrStatus，由中央 .tb-wr-loading（小熊 + 文字）顯示
  if (statusEl) statusEl.textContent = "";
  try {
    const p   = new URLSearchParams({ market, symbol, exchange, timeframe, stop_buffer_pct: bufDec.toFixed(4) });
    const res = await fetch("/api/crt_winrate?" + p);
    const d   = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    _wrCache[cacheKey] = d;
    _renderWinRate(d);
    _renderWRSignals(d.signals);
    if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
  } catch(e) {
    if (statusEl) statusEl.textContent = "—";
    lastWRSignalMarkers = [];
    _applyMainMarkers();
  } finally {
    if (bar) bar.classList.remove("calculating");
  }
}

function _renderWRSignals(signals) {
  if (signals !== undefined) _lastWRSignals = signals || [];
  // 強化版時只顯示 s.v=true 的訊號
  const list = _wrVariantView === "variant"
    ? _lastWRSignals.filter(s => s.v)
    : _lastWRSignals;
  // 用 _secToIdx Map（O(1)）取代每次重建 Set（O(n)）
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const rKey = _wrResultKey();
  const otKey = _wrOtKey();

  const allMarkers = [];

  for (const s of list) {
    const et = toTime(s.t);
    if (!_has(et)) continue;

    const isShort = s.d === "s";
    const k = s.k || "abc";
    // 依目標切換取結果欄位：mid → r/ot；band → r_b/ot_b；1:1 → r_rr/ot_rr
    const sr  = s[rKey];
    const sot = s[otKey];

    // ── 進場標記 ──
    const eColor = k === "abc" ? (isShort ? "#ff6b6b" : "#4fc3f7")
                 : k === "ab"  ? (isShort ? "#ff9800" : "#26c6da")
                 : k === "3"   ? (isShort ? "#ce93d8" : "#b39ddb")
                 : k === "4"   ? (isShort ? "#80cbc4" : "#4db6ac")
                 : k === "5"   ? (isShort ? "#ffb74d" : "#ffa726")
                 : k === "6"   ? (isShort ? "#9fa8da" : "#7986cb")
                 : k === "7"   ? (isShort ? "#4dd0e1" : "#80deea")
                 : k === "8"   ? (isShort ? "#f06292" : "#f48fb1")
                 : k === "9"   ? (isShort ? "#fff176" : "#fff59d")
                 : k === "10"  ? (isShort ? "#90caf9" : "#bbdefb")
                 :                (isShort ? "#aed581" : "#c5e1a5");  // k=11
    const eShape = k === "abc" ? "circle"
                 : k === "ab"  ? "square"
                 :                (isShort ? "arrowDown" : "arrowUp");
    const eText  = k === "abc" ? (isShort ? "空" : "多")
                 : k === "ab"  ? (isShort ? "空²" : "多²")
                 : k === "3"   ? (isShort ? "空³" : "多³")
                 : k === "4"   ? (isShort ? "空⁴" : "多⁴")
                 : k === "5"   ? (isShort ? "空⁵" : "多⁵")
                 : k === "6"   ? (isShort ? "空⁶" : "多⁶")
                 : k === "7"   ? (isShort ? "空⁷" : "多⁷")
                 : k === "8"   ? (isShort ? "空⁸" : "多⁸")
                 : k === "9"   ? (isShort ? "空⁹" : "多⁹")
                 : k === "10"  ? (isShort ? "空¹⁰" : "多¹⁰")
                 :                (isShort ? "空¹¹" : "多¹¹");
    allMarkers.push({
      time: et, position: isShort ? "aboveBar" : "belowBar",
      color: eColor, shape: eShape, size: 1.2, text: eText,
    });

    // ── 結果標記（在結算那根K棒上顯示 ✓ 或 ✗）──
    if (sr != null && sot) {
      const ot = toTime(sot);
      if (_has(ot)) {
        const isWin = sr === "w";
        // 勝：標在目標方向（空→下方，多→上方）；敗：標在止損方向（空→上方，多→下方）
        const oPos = isWin
          ? (isShort ? "belowBar" : "aboveBar")
          : (isShort ? "aboveBar" : "belowBar");
        const oShape = isWin
          ? (isShort ? "arrowDown" : "arrowUp")
          : (isShort ? "arrowUp"   : "arrowDown");
        allMarkers.push({
          time: ot, position: oPos,
          color: isWin ? "#26a69a" : "#ef5350",
          shape: oShape, size: 1.0,
          text: isWin ? "✓" : "✗",
        });
      }
    }
  }

  // Lightweight Charts 要求按時間升序排列
  allMarkers.sort((a, b) => a.time - b.time);
  lastWRSignalMarkers = allMarkers;

  // wrStatus 顯示由 _renderWinRate 管理（後端總筆數），這裡不覆寫
  _applyMainMarkers();
}

function _renderWinRate(d) {
  _wrCacheLast = d;
  // 依目標切換取 mid（頂層）/ band / rr（巢狀）
  let view = _wrPickView(d);
  // 再依強化版切換：若 variant view 且該層有 .variant 子物件，使用之
  if (_wrVariantView === "variant" && view && view.variant) view = view.variant;
  // 台股 long_only：把勝率欄加上 class 隱藏空單 row
  const bar = document.getElementById("winrateBar");
  if (bar) bar.classList.toggle("long-only", !!d.long_only);
  d = view;
  const setRow = (id, s) => {
    const el = document.getElementById(id);
    if (!el) return;
    const dir = el.dataset.dir || "";
    const arrow = dir === "s" ? "▼" : "▲";
    if (!s || s.win_rate == null) {
      el.className = "tb-wr-v";
      el.innerHTML = `<i class="tb-wr-arr ${dir}">${arrow}</i><span class="tb-wr-pct">—</span>`;
      el.removeAttribute("title"); return;
    }
    const good = s.win_rate >= 60, bad = s.win_rate < 45;
    const losses = s.losses ?? (s.total - s.wins);
    el.className = `tb-wr-v${good ? " good" : bad ? " bad" : ""}`;
    el.innerHTML = `<i class="tb-wr-arr ${dir}">${arrow}</i><span class="tb-wr-pct">${s.win_rate}%</span><span class="tb-wr-cnt">${s.wins}/${losses}</span>`;
    el.title = `${s.wins}勝 ${losses}負 共${s.total}筆`;
  };

  setRow("wrAbcS", d.abc?.short);
  setRow("wrAbcL", d.abc?.long);
  setRow("wrAbS",  d.ab?.short);
  setRow("wrAbL",  d.ab?.long);
  setRow("wrS3S",  d.s3?.short);
  setRow("wrS3L",  d.s3?.long);
  setRow("wrS4S",  d.s4?.short);
  setRow("wrS4L",  d.s4?.long);
  setRow("wrS5S",  d.s5?.short);
  setRow("wrS5L",  d.s5?.long);
  setRow("wrS6S",  d.s6?.short);
  setRow("wrS6L",  d.s6?.long);
  setRow("wrS7S",  d.s7?.short);
  setRow("wrS7L",  d.s7?.long);
  setRow("wrS8S",  d.s8?.short);
  setRow("wrS8L",  d.s8?.long);
  setRow("wrS9S",  d.s9?.short);
  setRow("wrS9L",  d.s9?.long);
  setRow("wrS10S", d.s10?.short);
  setRow("wrS10L", d.s10?.long);
  setRow("wrS11S", d.s11?.short);
  setRow("wrS11L", d.s11?.long);

  const sa = document.getElementById("wrAll");
  if (sa) {
    if (d.win_rate != null) {
      const good = d.win_rate >= 60, bad = d.win_rate < 45;
      sa.className = `tb-wr-total${good ? " good" : bad ? " bad" : ""}`;
      sa.textContent = `${d.win_rate}%`;
      sa.title = `${d.wins}勝 ${d.total - d.wins}負 共${d.total}筆`;
    } else {
      sa.textContent = "—"; sa.className = "tb-wr-total"; sa.removeAttribute("title");
    }
  }

  // 「打到一開始預估止盈位子」機率（用固定目標掃描）
  const eh = document.getElementById("wrEstHit");
  if (eh) {
    if (d.est_win_rate != null) {
      eh.textContent = `預估 ${d.est_win_rate}%`;
      eh.title = `打到「進場時 BB 預估止盈」機率：${d.est_wins}勝 / ${d.est_total - d.est_wins}負 共${d.est_total}筆`;
    } else {
      eh.textContent = "—";
      eh.removeAttribute("title");
    }
  }

  const fd = document.getElementById("wrFromDate");
  if (fd) {
    if (d.from_date) {
      const [y, m, day] = d.from_date.split("-");
      fd.textContent = `←${y}/${m}/${day}`;
      fd.title = `回測自 ${d.from_date}`;
    } else {
      fd.textContent = "";
    }
  }

  // wrStatus 顯示「後端回測總筆數」（跟 wrAll tooltip 的「共 Z 筆」一致）
  const ss = document.getElementById("wrStatus");
  if (ss) ss.textContent = (d && d.total != null) ? `${d.total}筆` : "";

  _renderWrTop3();
}

/* ══════════════════════════════════════════
   勝率欄上方 TOP 3 列：當前標的最高勝率前 3 個 (sig × dir) + 合計（dedupe）
══════════════════════════════════════════ */
const _SIG_KEYS = ["abc", "ab", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11"];
const _SIG_LABEL = {
  abc:"S1", ab:"S2", s3:"S3", s4:"S4", s5:"S5",
  s6:"S6", s7:"S7", s8:"S8", s9:"S9", s10:"S10", s11:"S11",
};
const _SIG_ICON = {
  abc:"●", ab:"■", s3:"▲", s4:"◆", s5:"★",
  s6:"◇", s7:"⬢", s8:"⬡", s9:"✦", s10:"✪", s11:"✸",
};
// signal.k 對應到 stat key（去掉 s 前綴的 3-10）
const _STATKEY_TO_SIGK = {
  abc:"abc", ab:"ab", s3:"3", s4:"4", s5:"5",
  s6:"6", s7:"7", s8:"8", s9:"9", s10:"10", s11:"11",
};

function _renderWrTop3() {
  const root = document.getElementById("wrTop3");
  if (!root) return;
  const d = _wrCacheLast;
  if (!d) { root.innerHTML = ""; return; }

  // 取當前 view（mid / band / rr / variant）
  let view = _wrPickView(d);
  if (_wrVariantView === "variant" && view && view.variant) view = view.variant;

  // 連敗按鈕（畫在 TOP3 上列）：關 → 2連 → 3連 → 4連 → 敗後停手策略 → 關
  //   2/3/4 連 = 同方向連敗 N-1 根後再敗機率（合併時間軸，中間夾反方向不算連續）
  //   敗後停手 = 輸了停手、旁觀同方向直到會贏才回場，顯示套用後的總/空/多勝率
  const _streakLabel = _wrStreakN === 0 ? "連敗 關"
                     : _wrStreakN === 5 ? "敗後停手"
                     : `連敗 ${_wrStreakN}`;
  const streakBtn = `<button class="wr-streak-btn${_wrStreakN ? " on" : ""}" onclick="_cycleStreakN()" title="連敗風險 / 再進場策略（S2~S11 去重綜合）：關 → 2連 → 3連 → 4連 → 敗後停手。&#10;2/3/4連=同方向連敗 N-1 根後、下一筆也敗的機率（合併時間軸，兩敗中間夾反方向不算連續）。&#10;敗後停手=輸了就停手、旁觀同方向直到會贏才回場，顯示套用後的總勝率。">${_streakLabel}</button>`;
  let condNums = "";
  if (_wrStreakN >= 2 && _wrStreakN <= 4) {
    const _pick = (st) => (st?.loss_streak || []).find(x => x.after === _wrStreakN - 1) || null;
    const _condItem = (lbl, st) => {
      const e = _pick(st);
      if (!e || e.p == null) return `<span class="wr-cond-i">${lbl}<b>—</b></span>`;
      const c = e.p >= 60 ? " bad" : e.p <= 40 ? " good" : "";
      return `<span class="wr-cond-i${c}">${lbl}<b>${e.p}%</b><small>(${e.n})</small></span>`;
    };
    condNums = _condItem("空", view?.short) + _condItem("多", view?.long);
  } else if (_wrStreakN === 5) {
    const ss = view?.stop_strategy;
    const _si = (lbl, o) => {
      if (!o || o.win_rate == null) return `<span class="wr-cond-i">${lbl}<b>—</b></span>`;
      const c = o.win_rate >= 60 ? " good" : o.win_rate < 45 ? " bad" : "";
      return `<span class="wr-cond-i${c}">${lbl}<b>${o.win_rate}%</b><small>(${o.total})</small></span>`;
    };
    let inner;
    if (ss && ss.win_rate != null) {
      const tc = ss.win_rate >= 60 ? " good" : ss.win_rate < 45 ? " bad" : "";
      const est = ss.est;
      const estHtml = (est && est.win_rate != null)
        ? `<span class="wr-cond-i${est.win_rate >= 60 ? " good" : est.win_rate < 45 ? " bad" : ""}">預估<b>${est.win_rate}%</b><small>(${est.total})</small></span>`
        : "";
      inner = `<span class="wr-cond-i${tc}">總<b>${ss.win_rate}%</b><small>(${ss.total})</small></span>`
            + estHtml + _si("空", ss.short) + _si("多", ss.long);
    } else {
      inner = `<span class="wr-cond-i">總<b>—</b></span>`;
    }
    // 點數字 → 開敗後停手細節抽屜
    condNums = `<span class="wr-stop-detail" title="點擊看敗後停手策略細節" onclick="window._showStopStrategyDrawer&&window._showStopStrategyDrawer()">${inner}</span>`;
  }
  const streakHtml = `<span class="wr-streak-wrap">${streakBtn}${condNums}</span>`;

  // 蒐集所有 (sig, dir) 且樣本 >= 10
  const items = [];
  for (const k of _SIG_KEYS) {
    const ss = view?.[k];
    if (!ss) continue;
    for (const dir of ["short", "long"]) {
      const stat = ss[dir];
      if (!stat || stat.win_rate == null || (stat.total || 0) < 10) continue;
      items.push({ k, dir, wr: stat.win_rate, total: stat.total, wins: stat.wins });
    }
  }
  items.sort((a, b) => b.wr - a.wr);
  const top3 = items.slice(0, 3);
  if (top3.length === 0) { root.innerHTML = streakHtml; return; }

  // 合計勝率（dedupe by (t, d) 只算 top3 的 (sig, dir)）
  const topSet = new Set(top3.map(t => `${_STATKEY_TO_SIGK[t.k]}|${t.dir === "short" ? "s" : "l"}`));
  const sigs = _lastWRSignals || [];
  const rKey = _wrResultKey();
  const useVariant = _wrVariantView === "variant";
  const seen = new Set();
  let w = 0, l = 0;
  for (const s of sigs) {
    if (useVariant && !s.v) continue;
    if (!topSet.has(`${s.k}|${s.d}`)) continue;
    const key = s.t + "|" + s.d;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = s[rKey];
    if (r === "w") w++;
    else if (r === "l") l++;
  }
  const cTot = w + l;
  const cWr  = cTot > 0 ? (w / cTot * 100).toFixed(1) : null;

  // 精簡：去掉筆數(n)與分隔點、勝率取整數，完整數字移到 tooltip，讓出連敗顯示空間
  const itemsHtml = top3.map(t => {
    const dirSym = t.dir === "short" ? "空" : "多";
    const dirCls = t.dir === "short" ? "s" : "l";
    return `<span class="wr-top3-item" title="${_SIG_LABEL[t.k]} ${dirSym} ${t.wr.toFixed(1)}%（${t.wins}勝/${t.total - t.wins}負，共${t.total}筆）">`
      + `<span class="wr-top3-name wr-${t.k}">${_SIG_LABEL[t.k]}</span>`
      + `<span class="wr-top3-dir ${dirCls}">${dirSym}</span>`
      + `<span class="wr-top3-wr">${Math.round(t.wr)}%</span>`
      + `</span>`;
  }).join("");

  const sumHtml = (cWr != null)
    ? `<span class="wr-top3-sum" title="只計入這 3 個 (訊號×方向) 且同 signal-bar+同方向去重，共 ${cTot} 筆">${Math.round(cWr)}%</span>`
    : "";

  root.innerHTML = `<span class="wr-top3-label">T3</span><span class="wr-top3-items">${itemsHtml}</span>${sumHtml}${streakHtml}`;
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
