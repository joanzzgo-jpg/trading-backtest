// LRU 上限避免切大量標的時記憶體無限累積（每筆結果 ~50KB，5 個夠用）
const _WR_CACHE_MAX = 5;
let _wrCache = {};
function _wrCacheSet(key, value) {
  const keys = Object.keys(_wrCache);
  if (keys.length >= _WR_CACHE_MAX && !(key in _wrCache)) {
    delete _wrCache[keys[0]];   // 移除最舊（插入順序）
  }
  _wrCache[key] = value;
}
let _wrCacheLast = null;  // 保留最近一次資料，給 toggle target 重渲用
let _wrFetchTimer = null; // 切換標的時 debounce，避免連續觸發後端重算

// 目標切換（中軌 ↔ 上/下軌）狀態。1:1（rr）已移除 → 舊設定正規化回中軌
const _WR_VIEW_KEY = "wrTargetView";
let _wrSeries = "s";   // "s"=S1~S12 / "ss"=SS 系列（軌道反轉，獨立合計/敗後停手）
let _wrTargetView = "mid";
try { _wrTargetView = localStorage.getItem(_WR_VIEW_KEY) || "mid"; } catch (e) {}
if (_wrTargetView === "rr") { _wrTargetView = "mid"; try { localStorage.setItem(_WR_VIEW_KEY, "mid"); } catch (e) {} }

// 強化版（variant）功能已整個移除（前後端皆無）；以下清掉殘留設定鍵
try { localStorage.removeItem("wrVariantView"); } catch (e) {}

// 點擊訊號 K 棒展開的自動盈虧比盒：Set<signal.t>
const _autoRRSet = new Set();
let _autoRRHintShown = false;
try { _autoRRHintShown = localStorage.getItem("wrAutoRRHintShown") === "1"; } catch (e) {}

// 停損緩衝（%；UI 顯示 0.5 表示 0.5%，API 收 decimal 0.005）
const _WR_BUFFER_KEY = "wrStopBuffer";
let _wrStopBuffer = 0;
try { _wrStopBuffer = parseFloat(localStorage.getItem(_WR_BUFFER_KEY)) || 0; } catch (e) {}

function _wrViewLabel(v) {
  return v === "band" ? "上/下軌" : v === "band80" ? "8成軌" : v === "rr" ? "1:1" : "中軌";
}
function _initWrTargetBtn() {
  const btn = document.getElementById("wrTargetToggle");
  if (!btn) return;
  // 四種目標：中軌（BB middle）／上下軌（方向相關極端）／8成軌（下↔上 80%）／1:1
  if (!btn.querySelector(".tb-wr-toggle-inner")) {
    btn.innerHTML = `<span class="tb-wr-toggle-inner">${_wrViewLabel(_wrTargetView)}</span>`;
  } else {
    btn.querySelector(".tb-wr-toggle-inner").textContent = _wrViewLabel(_wrTargetView);
  }
  btn.classList.toggle("band",   _wrTargetView === "band");
  btn.classList.toggle("band80", _wrTargetView === "band80");
  btn.classList.toggle("rr",     _wrTargetView === "rr");
}

// 取當前目標 view（mid 在頂層、band/band80/rr 在巢狀子物件）
// band80：8成軌統計來自 band_ratio=0.8 那份的 .band，前端載入後掛成 d.band80（見 _ensureBand80）。
function _wrPickView(d) {
  if (!d) return d;
  if (_wrTargetView === "band80") return d.band80 || d.band || d;   // 未載入時暫退上下軌/中軌
  if (_wrTargetView === "band" && d.band) return d.band;
  if (_wrTargetView === "rr"   && d.rr)   return d.rr;
  return d;
}
// SS 系列的當前目標 view：mid 在 d.ss、上下軌在 d.ss.band、8成軌在 d.ss.band80（切換時 SS 也跟著變）
function _wrSsView(d) {
  const ss = d && d.ss;
  if (!ss) return ss;
  if (_wrTargetView === "band80") return ss.band80 || ss.band || ss;
  return (_wrTargetView === "band" && ss.band) ? ss.band : ss;
}
// 當前目標對應的「訊號結果 / 結算時間」欄位名（band80 暫沿用 band 的 r_b/ot_b 做圖上標記）
function _wrResultKey() {
  return (_wrTargetView === "band" || _wrTargetView === "band80") ? "r_b" : _wrTargetView === "rr" ? "r_rr" : "r";
}
function _wrOtKey() {
  return (_wrTargetView === "band" || _wrTargetView === "band80") ? "ot_b" : _wrTargetView === "rr" ? "ot_rr" : "ot";
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
  const btn = document.getElementById("wrTargetToggle");

  // 三段循環：中軌 → 上/下軌 → 8成軌 → 中軌（1:1 已移除）
  _wrTargetView = _wrTargetView === "mid" ? "band" : _wrTargetView === "band" ? "band80" : "mid";
  try { localStorage.setItem(_WR_VIEW_KEY, _wrTargetView); } catch (e) {}

  // 動畫：rapid-click 安全 — 先清除所有殘留 inner、取消舊 timer 再開新動畫
  if (btn) {
    btn.classList.toggle("band",   _wrTargetView === "band");
    btn.classList.toggle("band80", _wrTargetView === "band80");
    btn.classList.toggle("rr",     _wrTargetView === "rr");

    // 取消上一輪未完成的清理 timer（避免殘留 inner 累積）
    if (btn._wrAnimTimer) { clearTimeout(btn._wrAnimTimer); btn._wrAnimTimer = null; }
    // 找出當前「實際顯示」的 inner（最後一個非 slide-out）；其餘殘留全部立即移除
    const inners = btn.querySelectorAll(".tb-wr-toggle-inner");
    let active = null;
    for (let i = inners.length - 1; i >= 0; i--) {
      const el = inners[i];
      if (!active && !el.classList.contains("tb-wr-slide-out")) { active = el; continue; }
      el.remove();
    }
    if (active) {
      active.classList.remove("tb-wr-slide-in");   // 強制停止 slide-in 動畫
      // 強制 reflow 讓瀏覽器接受重啟動畫
      void active.offsetWidth;
      active.classList.add("tb-wr-slide-out");
    }
    const newInner = document.createElement("span");
    newInner.className = "tb-wr-toggle-inner tb-wr-slide-in";
    newInner.textContent = _wrViewLabel(_wrTargetView);
    btn.appendChild(newInner);
    btn.classList.remove("tb-wr-flash");
    void btn.offsetWidth;   // 重啟閃光動畫
    btn.classList.add("tb-wr-flash");

    btn._wrAnimTimer = setTimeout(() => {
      btn._wrAnimTimer = null;
      if (active && active.parentNode) active.remove();
      newInner.classList.remove("tb-wr-slide-in");
      btn.classList.remove("tb-wr-flash");
    }, 280);
  } else {
    _initWrTargetBtn();
  }

  // 8成軌：需另抓 band_ratio=0.8 那份並掛成 d.band80（首次有短暫延遲，未載入時暫顯示上下軌）
  if (_wrCacheLast && _wrTargetView === "band80" && !_wrCacheLast.band80) {
    _ensureBand80(_wrCacheLast, () => { if (_wrCacheLast) _renderWinRate(_wrCacheLast); });
  }
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
  _renderWRSignals();
  if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
}

// 載入 8成軌統計：抓 band_ratio=0.8 的勝率，把其 .band / .ss.band 掛到當前 payload 的 band80 欄位。
// 同一 payload 物件只抓一次（存進 _wrCache → 切回該標的免重抓）。symbol 期間若已切換則丟棄。
let _band80Ctrl = null;
async function _ensureBand80(d, cb) {
  if (!d || d.band80) { cb && cb(); return; }
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) { cb && cb(); return; }
  const bufDec = (_wrStopBuffer || 0) / 100;
  if (_band80Ctrl) _band80Ctrl.abort();
  _band80Ctrl = new AbortController();
  const myCtrl = _band80Ctrl;
  try {
    const p = new URLSearchParams({ market, symbol, exchange, timeframe,
      stop_buffer_pct: bufDec.toFixed(4), band_ratio: "0.8" });
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal });
    const v80 = await res.json();
    if (!res.ok) throw new Error(v80.detail || "failed");
    if (myCtrl !== _band80Ctrl) return;          // 已被新請求/切標的取代 → 丟棄
    d.band80 = v80.band || null;                 // 8成軌 = 0.8 那份的 .band（含 s6/stop_strategy/recent…）
    if (d.ss && v80.ss) d.ss.band80 = v80.ss.band || v80.ss;
    cb && cb();
  } catch (e) {
    if (e.name !== "AbortError") { d.band80 = d.band || null; cb && cb(); }   // 失敗 → 暫退上下軌
  }
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
  for (const s of _lastWRSignals) {
    if (toTime(s.t) === barTime) return s;
    const exitT = s[otKey];
    if (exitT && toTime(exitT) === barTime) return s;
  }
  return null;
}

// 點擊訊號棒 toggle 顯示盈虧比盒；回傳是否成功 toggle
function _toggleAutoRR(barTime) {
  // S1~S12 訊號一鍵隱藏時：點擊訊號棒不展開盈虧比盒（與主圖 marker / hover 一致）
  if ((typeof _wrSignalsHidden !== "undefined") && _wrSignalsHidden) return false;
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

  const useBand = _wrTargetView === "band" || _wrTargetView === "band80";  // 帶軌目標（非中軌/1:1）
  const is80    = _wrTargetView === "band80";                              // 8成軌＝下軌↔上軌 80% 處
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
  // 某棒的帶軌止盈目標：滿軌(空=下軌、多=上軌)；8成軌=下軌↔上軌 80% 處(空=下軌+20%、多=下軌+80%)
  const bandTgt = (bar) => {
    if (!is80) return isShort ? bar.bb_lower : bar.bb_upper;
    const u = bar.bb_upper, l = bar.bb_lower;
    if (u == null || l == null) return null;
    return isShort ? (l + 0.2 * (u - l)) : (l + 0.8 * (u - l));
  };
  const buf = (_wrStopBuffer || 0) / 100;
  // 止損價優先用後端實際值（含 buffer、多棒取極值）；缺漏時退回單根訊號棒（舊資料相容）
  let tp, sl, type, color;
  if (isShort) {
    sl = (sig.stop != null) ? sig.stop : sigBar.high * (1 + buf);
    // 1:1：止盈距離 = 止損距離（進場價 - 風險）；否則中軌/下軌
    tp = isRR ? (entryBar.open - (sl - entryBar.open))
       : useBand ? bandTgt(entryBar) : entryBar.bb_middle;
    type = "shortpos"; color = "#ef5350";
  } else {
    sl = (sig.stop != null) ? sig.stop : sigBar.low * (1 - buf);
    tp = isRR ? (entryBar.open + (entryBar.open - sl))
       : useBand ? bandTgt(entryBar) : entryBar.bb_middle;
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
      tpAct = useBand ? bandTgt(exitBar) : exitBar.bb_middle;
    }
  }

  // 盒寬：到結算棒，沒結算就 8 根
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
//  - _autoRRSet：點擊釘選的盒（常駐）
//  - _hoverRRSigs：十字線目前所在 K 棒的訊號盒（hover，未釘選才畫，避免重複）
function _renderAutoRRBoxes(W, H) {
  if (typeof drawOne !== "function") return;
  // S1~S12 訊號一鍵隱藏時：釘選/hover 的盈虧比盒都不畫（與主圖 marker 一致）
  if ((typeof _wrSignalsHidden !== "undefined") && _wrSignalsHidden) return;
  for (const t of _autoRRSet) {
    const sig = _lastWRSignals && _lastWRSignals.find(s => s.t === t);
    if (!sig) continue;
    const box = _computeAutoRRBox(sig);
    if (box) drawOne(box, W, H, false, false);
  }
  for (const sig of (_hoverRRSigs || [])) {
    if (_autoRRSet.has(sig.t)) continue;   // 已釘選 → 不重複畫
    const box = _computeAutoRRBox(sig);
    if (box) drawOne(box, W, H, false, false);
  }
}

// 切換標的/時框時清空已展開的盒（舊訊號的時間在新資料中不存在）
function _clearAutoRR() {
  _autoRRBoxCache.clear();  // 清 memo cache
  _hoverRRSigs = [];
  _hoverCurSigs = [];
  _lastHoverBarTime = undefined;
  clearTimeout(_hoverRRTimer);
  if (typeof _stopHoverAutoCycle === "function") _stopHoverAutoCycle();
  _sigTimeIndex = null; _sigTimeIndexSrc = null;
  const host = document.getElementById("wrHover");
  if (host) host.innerHTML = `<span class="tb-wr-hover-hint">十字線移到訊號 K 棒 → 顯示該棒勝率</span>`;
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

let _wrFetchCtrl = null;   // 切標的時取消舊勝率請求
async function _fetchWinRateNow() {
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) return;
  const bufDec = (_wrStopBuffer || 0) / 100;
  const cacheKey = `${market}:${symbol}:${exchange}:${timeframe}:${bufDec.toFixed(4)}`;
  if (_wrCache[cacheKey]) {
    // 快取命中也要取消上一個還在飛的勝率請求，否則它稍後成功回來會用「舊標的」的
    // 訊號覆寫 _lastWRSignals → 訊號時間不存在於新標的 ohlcv → markers 全被過濾 → 策略不顯示。
    if (_wrFetchCtrl) { _wrFetchCtrl.abort(); _wrFetchCtrl = null; }
    _renderWinRate(_wrCache[cacheKey]);
    _renderWRSignals(_wrCache[cacheKey].signals);
    // 快取命中也要刷新左抽屜（含敗後停手求解），否則切回已載入過的標的時抽屜不更新
    if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
    return;
  }
  // 取消上次未完成的勝率請求
  if (_wrFetchCtrl) _wrFetchCtrl.abort();
  _wrFetchCtrl = new AbortController();
  const myCtrl = _wrFetchCtrl;
  const timeoutId = setTimeout(() => myCtrl.abort(), 45000);   // 勝率計算較重，45s 上限
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
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal });
    const d   = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    _wrCacheSet(cacheKey, d);   // 結果照常進快取，下次切回直接命中
    // 世代守衛：成功回來時若已被更新的請求 / 快取命中取代，丟棄此陳舊結果，
    // 否則舊標的的訊號會覆寫當前標的 → markers 全被過濾 → 切標的後策略消失。
    if (myCtrl !== _wrFetchCtrl) return;
    _renderWinRate(d);
    _renderWRSignals(d.signals);
    if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
  } catch(e) {
    console.error("[fetchWinRate] error:", e.name, e.message);
    // Abort / TypeError(Failed to fetch) / 被新請求取代 → 全部視為中斷，靜默
    const isAbortLike = e.name === "AbortError"
                     || myCtrl.signal.aborted
                     || /failed to fetch/i.test(e.message || "")
                     || myCtrl !== _wrFetchCtrl;
    if (!isAbortLike) {
      if (statusEl) statusEl.textContent = "—";
      lastWRSignalMarkers = [];
      _applyMainMarkers();
    }
  } finally {
    clearTimeout(timeoutId);
    if (myCtrl === _wrFetchCtrl && bar) bar.classList.remove("calculating");
  }
}

function _renderWRSignals(signals) {
  if (signals !== undefined) {
    _lastWRSignals = signals || [];
  }
  let list = _lastWRSignals;
  // 雙擊隱藏的策略 marker 過濾掉
  const _hidden = window._hiddenWrSigs;
  if (_hidden && _hidden.size) list = list.filter(s => !_hidden.has(s.k));
  // 主圖右上「S/SS 標記」鈕：依系列過濾圖上標記（all=全部、s=只S、ss=只SS）
  const _sf = window._wrSigSeries || "all";
  if (_sf === "s")  list = list.filter(s => !(s.k || "").startsWith("ss"));
  else if (_sf === "ss") list = list.filter(s =>  (s.k || "").startsWith("ss"));
  // 用 _secToIdx Map（O(1)）取代每次重建 Set（O(n)）
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const rKey = _wrResultKey();
  const otKey = _wrOtKey();

  // 重播截點：重播時只顯示「到目前重播棒為止」的訊號（進場 ≤ 現在；結果要等出場 ≤ 現在才顯示）
  // → 重播=看當下訊號、往前推進才揭曉勝負（視覺化回測）。
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;

  const allMarkers = [];

  for (const s of list) {
    const et = toTime(s.t);
    if (!_has(et)) continue;
    if (_rpCut != null && et > _rpCut) continue;   // 未到的進場不顯示

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
                 : k === "11"  ? (isShort ? "#aed581" : "#c5e1a5")
                 : k === "ss1" ? (isShort ? "#ff2a6d" : "#05d9e8")   // SS1 軌道反轉（深）：賽博龐克霓虹（空=霓虹粉、多=霓虹青）
                 : k === "ss2" ? (isShort ? "#c724b1" : "#39ff14")   // SS2 軌道反轉（淺）：霓虹紫 / 霓虹綠
                 : k === "ss3" ? (isShort ? "#ffd000" : "#ffea00")   // SS3 群聚(2個SS相隔2棒、第二更優)：霓虹金/黃
                 :                (isShort ? "#ffab91" : "#ffccbc");  // k=12
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
                 : k === "11"  ? (isShort ? "空¹¹" : "多¹¹")
                 : k === "ss1" ? (isShort ? "空ˢ" : "多ˢ")
                 : k === "ss2" ? (isShort ? "空ˢ²" : "多ˢ²")
                 : k === "ss3" ? (isShort ? "空ˢ³" : "多ˢ³")
                 :                (isShort ? "空¹²" : "多¹²");
    allMarkers.push({
      time: et, position: isShort ? "aboveBar" : "belowBar",
      color: eColor, shape: eShape, size: 1.2, text: eText,
    });

    // ── 結果標記（在結算那根K棒上顯示 ✓ 或 ✗）──
    if (sr != null && sot) {
      const ot = toTime(sot);
      if (_has(ot) && (_rpCut == null || ot <= _rpCut)) {   // 重播：出場尚未到 → 先不揭曉勝負
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
  // 依目標切換取 mid（頂層）/ band（巢狀）
  let view = _wrPickView(d);
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
    el.innerHTML = `<i class="tb-wr-arr ${dir}">${arrow}</i><span class="tb-wr-pct">${s.win_rate}%</span><span class="tb-wr-cnt">${s.wins}勝${losses}負</span>`;
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
  setRow("wrS12S", d.s12?.short);
  setRow("wrS12L", d.s12?.long);
  // SS 系列：中軌在 ss、上下軌在 ss.band → 跟著目標切換
  const ssView = _wrSsView(_wrCacheLast);
  setRow("wrSS1S", ssView?.ss1?.short);
  setRow("wrSS1L", ssView?.ss1?.long);
  setRow("wrSS2S", ssView?.ss2?.short);
  setRow("wrSS2L", ssView?.ss2?.long);

  // 系列切換：SS 系列時，右側「合計 / 敗後停手 / 近期」改用 ssView（含上下軌）；S 系列維持 view
  _applySeriesVisibility();
  const agg = (_wrSeries === "ss") ? (ssView || {}) : d;
  const aggStop = (_wrSeries === "ss") ? (ssView && ssView.stop_strategy) : view?.stop_strategy;

  const sa = document.getElementById("wrAll");
  if (sa) {
    if (agg.win_rate != null) {
      const good = agg.win_rate >= 60, bad = agg.win_rate < 45;
      sa.className = `tb-wr-total${good ? " good" : bad ? " bad" : ""}`;
      sa.textContent = `${agg.win_rate}%`;
      sa.title = `${agg.wins}勝 ${agg.total - agg.wins}負 共${agg.total}筆`;
    } else {
      sa.textContent = "—"; sa.className = "tb-wr-total"; sa.removeAttribute("title");
    }
  }

  // 敗後停手勝率（常駐顯示，不必點連敗按鈕循環）：取當前系列/目標的 stop_strategy
  const sr = document.getElementById("wrStopRate");
  if (sr) {
    const ss0 = aggStop;
    if (ss0 && ss0.win_rate != null) {
      const good = ss0.win_rate >= 60, bad = ss0.win_rate < 45;
      sr.className = `tb-wr-stoprate${good ? " good" : bad ? " bad" : ""}`;
      sr.textContent = `敗後 ${ss0.win_rate}%`;
      sr.title = `敗後停手：${ss0.wins != null ? ss0.wins + "勝 / " + (ss0.total - ss0.wins) + "負 共" : "共"}${ss0.total}筆（輸了停手、旁觀同方向直到會贏才回場）`;
    } else {
      sr.textContent = "—"; sr.className = "tb-wr-stoprate"; sr.removeAttribute("title");
    }
  }

  // 近 ~100 筆勝率（合併時間軸去重後最近 100 筆，看近期表現）
  const r100 = document.getElementById("wrRecent100");
  if (r100) {
    const rc = agg.recent100;
    if (rc && rc.win_rate != null) {
      const good = rc.win_rate >= 60, bad = rc.win_rate < 45;
      r100.className = `tb-wr-recent${good ? " good" : bad ? " bad" : ""}`;
      r100.textContent = `近${rc.total} ${rc.win_rate}%`;
      r100.title = `最近 ${rc.total} 筆：${rc.wins}勝 / ${rc.total - rc.wins}負（${rc.win_rate}%）`;
    } else {
      r100.textContent = "—"; r100.className = "tb-wr-recent"; r100.removeAttribute("title");
    }
  }

  // 近 ~200 筆「敗後停手」勝率（取最近 200 筆套敗後停手狀態機，看近期照實單表現）
  const rs = document.getElementById("wrRecentStop");
  if (rs) {
    const rcs = agg.recent_stop200;
    if (rcs && rcs.win_rate != null) {
      const good = rcs.win_rate >= 60, bad = rcs.win_rate < 45;
      rs.className = `tb-wr-recstop${good ? " good" : bad ? " bad" : ""}`;
      rs.textContent = `近${rcs.total}敗後 ${rcs.win_rate}%`;
      rs.title = `最近約 200 筆套敗後停手：實際進場 ${rcs.total} 筆，${rcs.wins}勝 / ${rcs.total - rcs.wins}負（${rcs.win_rate}%）`;
    } else {
      rs.textContent = "—"; rs.className = "tb-wr-recstop"; rs.removeAttribute("title");
    }
  }

  // 「打到一開始預估止盈位子」機率（用固定目標掃描）
  const eh = document.getElementById("wrEstHit");
  if (eh) {
    if (agg.est_win_rate != null) {
      eh.textContent = `預估 ${agg.est_win_rate}%`;
      eh.title = `打到「進場時 BB 預估止盈」機率：${agg.est_wins}勝 / ${agg.est_total - agg.est_wins}負 共${agg.est_total}筆`;
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
  if (ss) ss.textContent = (agg && agg.total != null) ? `${agg.total}筆` : "";

  _renderWrTop3();
}

// 系列區塊顯示切換：S 模式顯示 S1~S12、SS 模式只顯示 SS 區塊
function _applySeriesVisibility() {
  const ssMode = _wrSeries === "ss";
  document.querySelectorAll("#wrScroll .tb-wr-block").forEach(b => {
    const isSS = (b.dataset.sig || "").startsWith("ss");
    b.style.display = (ssMode === isSS) ? "" : "none";
  });
  document.querySelectorAll("#wrScroll .tb-wr-divider").forEach(dv => {
    // SS 模式只有單一區塊 → 隱藏所有分隔線；S 模式 → 只隱藏 SS 專用分隔線
    dv.style.display = ssMode ? "none" : (dv.classList.contains("wr-ss-div") ? "none" : "");
  });
}

// 切換系列按鈕（index.html onclick）
window._toggleWrSeries = function () {
  _wrSeries = _wrSeries === "ss" ? "s" : "ss";
  const btn = document.getElementById("wrSeriesToggle");
  if (btn) { btn.textContent = _wrSeries === "ss" ? "SS" : "S"; btn.classList.toggle("active", _wrSeries === "ss"); }
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
  else _applySeriesVisibility();
};

// 初始：預設 S 系列 → 先隱藏 SS 區塊，避免資料載入前閃現
try { _applySeriesVisibility(); } catch (e) {}

/* ══════════════════════════════════════════
   訊號顯示對照表（hover 勝率小卡用）
══════════════════════════════════════════ */
const _SIG_LABEL = {
  abc:"S1", ab:"S2", s3:"S3", s4:"S4", s5:"S5",
  s6:"S6", s7:"S7", s8:"S8", s9:"S9", s10:"S10", s11:"S11", s12:"S12", ss1:"SS1", ss2:"SS2", ss3:"SS3",
};
const _SIG_ICON = {
  abc:"●", ab:"■", s3:"▲", s4:"◆", s5:"★",
  s6:"◇", s7:"⬢", s8:"⬡", s9:"✦", s10:"✪", s11:"✸", s12:"❖", ss1:"⇋", ss2:"⇌", ss3:"⇶",
};
// signal.k（"3"…）→ stat key（"s3"…），給 hover 顯示該棒訊號勝率用
const _SIGK_TO_STATKEY = {
  abc:"abc", ab:"ab", "3":"s3", "4":"s4", "5":"s5",
  "6":"s6", "7":"s7", "8":"s8", "9":"s9", "10":"s10", "11":"s11", "12":"s12", ss1:"ss1", ss2:"ss2", ss3:"ss3",
};

/* ══════════════════════════════════════════
   十字線 hover：移到 K 棒 → 上方 S1-S12 區顯示「該棒訊號的勝率」（多個並列）
   + 圖上同步畫出該棒訊號的盈虧比 RR 盒。取代常駐 S1-S12 清單。
══════════════════════════════════════════ */
// time(秒) → 該棒上的訊號陣列（marker 落在 s.t）。_lastWRSignals 變更時自動重建。
let _sigTimeIndex = null, _sigTimeIndexSrc = null;
function _buildSigTimeIndex() {
  if (_sigTimeIndexSrc === _lastWRSignals && _sigTimeIndex) return _sigTimeIndex;
  const m = new Map();
  for (const s of (_lastWRSignals || [])) {
    const t = toTime(s.t);
    let arr = m.get(t);
    if (!arr) { arr = []; m.set(t, arr); }
    arr.push(s);
  }
  _sigTimeIndex = m; _sigTimeIndexSrc = _lastWRSignals;
  return m;
}

let _lastHoverBarTime = undefined;   // 上次 hover 的棒時間（秒）；只在換棒時重算
let _hoverRRSigs = [];               // 已通過 dwell、要在圖上畫 RR 盒的訊號
let _hoverCurSigs = [];              // 目前 hover 棒上的訊號（給卡片切換重渲用）
let _hoverCardIdx = 0;               // 卡片切換模式目前顯示第幾張（手機 3+ 訊號）
let _hoverRRTimer = null;            // RR 盒 dwell 計時器（停留 0.5s 才顯示，避免掃動時狂閃）
const _HOVER_RR_DWELL = 500;         // ms

// 由 charts.js 的 crosshair 訂閱呼叫（每次移動）；time=null 表示離開圖表
function _updateHoverWR(time) {
  if (time === _lastHoverBarTime) return;   // 同一根棒不重算（避免 60Hz 重繪）
  _lastHoverBarTime = time;
  const idx = _buildSigTimeIndex();
  // S1~S12 訊號一鍵隱藏時（topbar #wrSignalsToggleBtn）：hover 也不顯示勝率/RR 盒，與主圖 marker 一致
  const sigHidden = (typeof _wrSignalsHidden !== "undefined") && _wrSignalsHidden;
  let sigs = (!sigHidden && time != null && idx.has(time)) ? idx.get(time) : [];
  // 雙擊隱藏 過濾（與主圖 marker 一致）
  const hidden = window._hiddenWrSigs;
  if (sigs.length && hidden && hidden.size) {
    sigs = sigs.filter(s => !hidden.has(s.k));
  }
  // 上方勝率文字：立即更新（不延遲）
  _hoverCurSigs = sigs;
  _hoverCardIdx = 0;                 // 換棒 → 回到第一張卡
  const host = document.getElementById("wrHover");
  if (host) host.innerHTML = _hoverWRHtml(sigs);
  // 手機 3+ 訊號（卡片模式）→ 啟動自動輪播；否則停止
  const isCardMode = isMobileUI() && sigs.length >= 3;
  if (isCardMode) _startHoverAutoCycle(); else _stopHoverAutoCycle();
  // 圖上 RR 盒：停留 0.5s 才顯示（換棒先清掉前一根的盒，避免掃動時盒子狂閃）
  clearTimeout(_hoverRRTimer);
  if (_hoverRRSigs.length) {
    _hoverRRSigs = [];
    if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  }
  if (sigs.length) {
    _hoverRRTimer = setTimeout(() => {
      _hoverRRSigs = sigs;
      if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
    }, _HOVER_RR_DWELL);
  }
}

// 單一訊號的勝率小卡 HTML
function _hoverItemHtml(s) {
  const view    = _wrPickView(_wrCacheLast);
  const rKey    = _wrResultKey();
  const statKey = _SIGK_TO_STATKEY[s.k] || "abc";
  const dirKey  = s.d === "s" ? "short" : "long";
  const dirSym  = s.d === "s" ? "空" : "多";
  // SS 系列只算 mid，資料在 _wrCacheLast.ss.*；其餘走目前 view（mid/band/rr）
  const stat    = statKey.startsWith("ss")
    ? (_wrCacheLast?.ss?.[statKey] ? _wrCacheLast.ss[statKey][dirKey] : null)
    : (view && view[statKey] ? view[statKey][dirKey] : null);
  const wr      = (stat && stat.win_rate != null) ? stat.win_rate : null;
  const wrCls   = wr == null ? "" : wr >= 60 ? " good" : wr < 45 ? " bad" : "";
  const cnt     = stat ? `${stat.wins}勝${stat.total - stat.wins}負` : "";
  const r       = s[rKey];
  const resTxt  = r === "w" ? "✓ 勝" : r === "l" ? "✗ 敗" : "進行中";
  const resCls  = r === "w" ? "win" : r === "l" ? "loss" : "open";
  const icon    = _SIG_ICON[statKey] || "●";
  const label   = _SIG_LABEL[statKey] || "";
  // 點擊 → 開該訊號詳情抽屜（保留原 block 的功能）
  return `<span class="tb-wr-hover-item" onclick="window._showSignalInfoByStatKey&&window._showSignalInfoByStatKey('${statKey}')">`
    + `<span class="tb-wr-hover-ic wr-${statKey}">${icon}</span>`
    + `<span class="tb-wr-hover-lbl">${label}<i class="tb-wr-hover-dir ${dirKey === "short" ? "s" : "l"}">${dirSym}</i></span>`
    + `<span class="tb-wr-hover-pct${wrCls}">${wr == null ? "—" : wr + "%"}</span>`
    + (cnt ? `<span class="tb-wr-hover-cnt">${cnt}</span>` : "")
    + `<span class="tb-wr-hover-res ${resCls}">${resTxt}</span>`
    + `</span>`;
}

function _hoverWRHtml(sigs) {
  if (!sigs || !sigs.length) {
    return `<span class="tb-wr-hover-hint">十字線移到訊號 K 棒 → 顯示該棒勝率</span>`;
  }
  // 手機 + 3 個以上訊號：一列塞不下 → 改「圖卡切換」一次顯示一張 + ‹ N/M › 切換
  const isMobile = isMobileUI();
  if (isMobile && sigs.length >= 3) {
    if (_hoverCardIdx >= sigs.length || _hoverCardIdx < 0) _hoverCardIdx = 0;
    return `<div class="tb-wr-hover-cardwrap">`
      + `<button class="tb-wr-hover-nav" onclick="event.stopPropagation();window._hoverCardCycle&&window._hoverCardCycle(-1)" aria-label="上一個">‹</button>`
      + _hoverItemHtml(sigs[_hoverCardIdx])
      + `<button class="tb-wr-hover-nav" onclick="event.stopPropagation();window._hoverCardCycle&&window._hoverCardCycle(1)" aria-label="下一個">›</button>`
      + `<span class="tb-wr-hover-pager">${_hoverCardIdx + 1}/${sigs.length}</span>`
      + `</div>`;
  }
  // 桌面 / 2 個以內：並列
  return sigs.map(_hoverItemHtml).join(`<span class="tb-wr-hover-sep"></span>`);
}

// 卡片切換（手機 3+ 訊號）：淡出當前 → 換下一張 → 淡入（新卡片由 CSS 動畫淡入）
let _hoverAutoTimer = null;
function _stopHoverAutoCycle() { if (_hoverAutoTimer) { clearInterval(_hoverAutoTimer); _hoverAutoTimer = null; } }
function _startHoverAutoCycle() { _stopHoverAutoCycle(); _hoverAutoTimer = setInterval(() => _hoverDoCycle(1), 2400); }
function _hoverDoCycle(delta) {
  const sigs = _hoverCurSigs || [];
  if (sigs.length < 2) { _stopHoverAutoCycle(); return; }
  const host = document.getElementById("wrHover");
  const cur = host && host.querySelector(".tb-wr-hover-item");
  const advance = () => {
    _hoverCardIdx = (_hoverCardIdx + delta + sigs.length) % sigs.length;
    if (host) host.innerHTML = _hoverWRHtml(sigs);   // 新卡片自帶 fade-in 動畫
  };
  if (cur) { cur.classList.add("wr-card-out"); setTimeout(advance, 150); }  // 先淡出再換
  else advance();
}
// 手動切換：立即切 + 重置自動輪播計時（避免剛點完馬上又自動跳）
window._hoverCardCycle = function (delta) {
  _hoverDoCycle(delta);
  if (_hoverAutoTimer) _startHoverAutoCycle();
};

function _renderWrTop3() {
  const root = document.getElementById("wrTop3");
  if (!root) return;
  const d = _wrCacheLast;
  if (!d) { root.innerHTML = ""; return; }

  // 取當前 view：SS 系列 → SS 獨立統計（含上下軌 ss.band、連敗/敗後停手含 SS 新規則）；S 系列 → S2~S11 綜合（mid/band）
  const view = (_wrSeries === "ss") ? (_wrSsView(d) || {}) : _wrPickView(d);
  const _scopeLbl = (_wrSeries === "ss") ? "SS 系列獨立" : "S2~S11 去重綜合";

  // 連敗按鈕（畫在 TOP3 上列）：關 → 2連 → 3連 → 4連 → 敗後停手策略 → 關
  //   2/3/4 連 = 同方向連敗 N-1 根後再敗機率（合併時間軸，中間夾反方向不算連續）
  //   敗後停手 = 輸了停手、旁觀同方向直到會贏才回場，顯示套用後的總/空/多勝率
  const _streakLabel = _wrStreakN === 0 ? "連敗 關"
                     : _wrStreakN === 5 ? "敗後停手"
                     : `連敗 ${_wrStreakN}`;
  const streakBtn = `<button class="wr-streak-btn${_wrStreakN ? " on" : ""}" onclick="_cycleStreakN()" title="連敗風險 / 再進場策略（${_scopeLbl}）：關 → 2連 → 3連 → 4連 → 敗後停手。&#10;2/3/4連=同方向連敗 N-1 根後、下一筆也敗的機率（合併時間軸，兩敗中間夾反方向不算連續）。&#10;敗後停手=輸了就停手、旁觀同方向直到會贏才回場，顯示套用後的總勝率。">${_streakLabel}</button>`;
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
  // TOP3 元件已移除，只保留敗後停手按鈕（+條件數字）。
  // （原本還會蒐集 top3、跑遍所有訊號算合計勝率、組 itemsHtml，但輸出只用 streakHtml
  //   → 全是死碼，每次 _renderWinRate 白跑一遍含 O(n) 掃訊號，已於 2026-06 移除）
  root.innerHTML = `<span class="wr-streak-wrap">${streakBtn}${condNums}</span>`;
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
