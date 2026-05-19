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

function _initWrTargetBtn() {
  const btn = document.getElementById("wrTargetToggle");
  if (!btn) return;
  // 帶軌目標是方向相關：多單→BB 上軌、空單→BB 下軌
  btn.textContent = _wrTargetView === "band" ? "上/下軌" : "中軌";
  btn.classList.toggle("band", _wrTargetView === "band");
}

function _initWrVariantBtn() {
  const btn = document.getElementById("wrVariantToggle");
  if (!btn) return;
  btn.textContent = _wrVariantView === "variant" ? "強化版" : "原版";
  btn.classList.toggle("variant", _wrVariantView === "variant");
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
  _wrTargetView = _wrTargetView === "mid" ? "band" : "mid";
  try { localStorage.setItem(_WR_VIEW_KEY, _wrTargetView); } catch (e) {}
  _initWrTargetBtn();
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
  // marker 與自動盈虧比盒都跟著切：止盈位置 BB 中軌 ↔ 上/下軌
  _renderWRSignals();
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
  const useBand = _wrTargetView === "band";
  // 強化版時只考慮 v=true 訊號
  const list = _wrVariantView === "variant"
    ? _lastWRSignals.filter(s => s.v)
    : _lastWRSignals;
  for (const s of list) {
    if (toTime(s.t) === barTime) return s;
    const exitT = useBand ? s.ot_b : s.ot;
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
  // O(1) Map.get 取代 findIndex 線性掃描
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
  const buf = (_wrStopBuffer || 0) / 100;
  let tp, sl, type, color;
  if (dir === "s") {
    sl = sigBar.high * (1 + buf);
    tp = useBand ? entryBar.bb_lower : entryBar.bb_middle;
    type = "shortpos"; color = "#ef5350";
  } else {
    sl = sigBar.low * (1 - buf);
    tp = useBand ? entryBar.bb_upper : entryBar.bb_middle;
    type = "longpos"; color = "#26a69a";
  }
  if (tp == null) { _autoRRBoxCache.set(cacheKey, null); return null; }

  // 實際止盈：只在贏的訊號 + 找得到結算棒時才算
  let tpAct = null;
  const exitT  = useBand ? sig.ot_b : sig.ot;
  const result = useBand ? sig.r_b  : sig.r;
  let exitIdx = -1;
  if (exitT) {
    exitIdx = (typeof _timeToIdx !== "undefined" && _timeToIdx.has(exitT))
      ? _timeToIdx.get(exitT)
      : ohlcvData.findIndex(d => d.time === exitT);
  }
  if (exitT && result === "w" && exitIdx >= 0) {
    const exitBar = ohlcvData[exitIdx];
    if (dir === "s") tpAct = useBand ? exitBar.bb_lower : exitBar.bb_middle;
    else             tpAct = useBand ? exitBar.bb_upper : exitBar.bb_middle;
  }

  // 盒寬：從進場棒到結算棒，沒結算就 8 根
  let barWidth = 8;
  if (exitIdx > sigIdx) barWidth = Math.max(3, exitIdx - sigIdx);

  const box = {
    id: "_autoRR_" + sig.t,
    type, color, barWidth,
    p1: { time: toTime(entryBar.time), price: entryBar.open },
    tp, sl, tpAct,
    _isAutoRR: true,
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
  const useBand = _wrTargetView === "band";

  const allMarkers = [];

  for (const s of list) {
    const et = toTime(s.t);
    if (!_has(et)) continue;

    const isShort = s.d === "s";
    const k = s.k || "abc";
    // 依目標切換取結果欄位：mid → r/ot；band → r_b/ot_b
    const sr  = useBand ? s.r_b  : s.r;
    const sot = useBand ? s.ot_b : s.ot;

    // ── 進場標記 ──
    const eColor = k === "abc" ? (isShort ? "#ff6b6b" : "#4fc3f7")
                 : k === "ab"  ? (isShort ? "#ff9800" : "#26c6da")
                 : k === "3"   ? (isShort ? "#ce93d8" : "#b39ddb")
                 : k === "4"   ? (isShort ? "#80cbc4" : "#4db6ac")
                 : k === "5"   ? (isShort ? "#ffb74d" : "#ffa726")
                 :                (isShort ? "#9fa8da" : "#7986cb");
    const eShape = k === "abc" ? "circle"
                 : k === "ab"  ? "square"
                 :                (isShort ? "arrowDown" : "arrowUp");
    const eText  = k === "abc" ? (isShort ? "空" : "多")
                 : k === "ab"  ? (isShort ? "空²" : "多²")
                 : k === "3"   ? (isShort ? "空³" : "多³")
                 : k === "4"   ? (isShort ? "空⁴" : "多⁴")
                 : k === "5"   ? (isShort ? "空⁵" : "多⁵")
                 :                (isShort ? "空⁶" : "多⁶");
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

  const entryCount = list.filter(s => _has(toTime(s.t))).length;
  const ss = document.getElementById("wrStatus");
  if (ss) ss.textContent = entryCount > 0 ? `${entryCount}筆` : "";
  _applyMainMarkers();
}

function _renderWinRate(d) {
  _wrCacheLast = d;
  // 依目標切換取 mid（頂層）或 band（巢狀）
  let view = (_wrTargetView === "band" && d && d.band) ? d.band : d;
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

  const ss = document.getElementById("wrStatus");
  if (ss) ss.textContent = "";
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
