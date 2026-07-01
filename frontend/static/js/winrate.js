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
let _wrSeries = "ss";  // S1~S12 已退役，固定只顯示 SS 系列（軌道反轉）。切換鈕已鎖定。
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
  _applySSCollapse();   // 載入時即套用收合狀態（避免閃一下才隱藏）
  _renderWrTop3();      // 即時渲染收合切換鈕（不需資料）→ 收起狀態下也能立刻展開
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

// 上方勝率列收合開關（取代原「連敗機率」按鈕）：收起時整條 #winrateBar 隱藏、騰出空間給圖表；
// 切換鈕畫在 wrTop3（在 winrateBar 上方、整列收起後它仍在，可再展開）。
let _ssCollapsed = false;
try { _ssCollapsed = localStorage.getItem("wrSSCollapsed") === "1"; } catch (e) {}
function _applySSCollapse() {
  const bar = document.getElementById("winrateBar");
  if (bar) bar.classList.toggle("wr-collapsed", _ssCollapsed);
}
window._toggleSSCollapse = function () {
  _ssCollapsed = !_ssCollapsed;
  try { localStorage.setItem("wrSSCollapsed", _ssCollapsed ? "1" : "0"); } catch (e) {}
  _applySSCollapse();
  _renderWrTop3();
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
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal, cache: "no-store" });
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

/* ── FVG 盈虧比盒（hover 到缺口確認棒才浮現，正常隱藏）──────────────────
   止盈止損位（W = top−bot）：定版 SL=2W、TP=6W。
   依據：1h + g+2過濾 全盈虧比掃描，2/6 報酬/DD 最佳(規格8幣5.66、19幣11.2)，DD 僅 −6.4%。 */
let _FVG_SL_W = 2;          // 止損寬（單位 W）
let _FVG_TP_W = 6;          // 止盈寬（單位 W）
let _fvgList = [];          // 後端原始 fvg 陣列 [{t, top, bot, d, t2}]
let _fvgTimeIdx = null, _fvgTimeIdxSrc = null;   // Map<圖表秒, fvg[]>（memo）
let _hoverFVGZones = [];    // 已通過 dwell、要在圖上畫盒的 fvg

// 由 fetchWinRate 在拿到勝率資料時呼叫，存一份 fvg 供 hover 用
function _setFVGData(list) {
  _fvgList = Array.isArray(list) ? list : [];
  _fvgTimeIdx = null;       // 失效 → 下次 hover 重建
}
function _buildFVGTimeIndex() {
  if (_fvgTimeIdx && _fvgTimeIdxSrc === _fvgList) return _fvgTimeIdx;
  const m = new Map();
  for (const z of _fvgList) {
    const t = toTime(z.t);                         // ISO → 圖表秒，與 crosshair time 一致
    if (t == null) continue;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(z);
  }
  _fvgTimeIdx = m; _fvgTimeIdxSrc = _fvgList;
  return m;
}
// 一個 fvg 缺口 → longpos/shortpos 盒（進場參考＝缺口中點）
function _computeFVGBox(z) {
  if (!z || z.top == null || z.bot == null) return null;
  const W = z.top - z.bot;
  if (!(W > 0)) return null;
  const isShort = z.d === "s";
  const mid = (z.top + z.bot) / 2;                 // 進場參考 = 缺口中點
  // 止盈/止損優先用後端視覺位階(止損=g-1頂端 z.sl、止盈=1W z.tp)，與框上線/IFVG 一致；缺漏才退回舊倍數
  const tp = (z.tp != null) ? z.tp : (isShort ? z.bot - _FVG_TP_W * W : z.top + _FVG_TP_W * W);
  const sl = (z.sl != null) ? z.sl : (isShort ? z.top + _FVG_SL_W * W : z.bot - _FVG_SL_W * W);
  // 盒寬：確認棒 → 回補棒（=部位了結）；未回補預設 12 根
  const t1s = toTime(z.t), t2s = (z.t2 != null) ? toTime(z.t2) : null;
  let barWidth = 12;
  if (t2s != null && typeof _secToIdx !== "undefined" && _secToIdx.has(t1s) && _secToIdx.has(t2s))
    barWidth = Math.max(3, _secToIdx.get(t2s) - _secToIdx.get(t1s));
  return {
    id: "_fvg_" + z.t,
    type: isShort ? "shortpos" : "longpos",
    color: isShort ? "#ef5350" : "#26a69a",
    barWidth,
    p1: { time: t1s, price: mid },
    tp, sl, tpAct: null,
    _isFVG: true,
  };
}
// 測試期可在 console 直接調參看效果：window.setFVGTPSL(slW, tpW)
window.setFVGTPSL = function (slW, tpW) {
  if (slW > 0) _FVG_SL_W = slW;
  if (tpW > 0) _FVG_TP_W = tpW;
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  return { sl: _FVG_SL_W, tp: _FVG_TP_W };
};

// 渲染所有展開中的自動盈虧比盒（由 draw.js 的 renderDrawings 末端呼叫）
//  - _autoRRSet：點擊釘選的盒（常駐）
//  - _hoverRRSigs：十字線目前所在 K 棒的訊號盒（hover，未釘選才畫，避免重複）
function _renderAutoRRBoxes(W, H) {
  if (typeof drawOne !== "function") return;
  // FVG 盈虧比盒（hover 觸發；獨立於 S1~S12 訊號隱藏，因為它不是 S 訊號）
  for (const z of (_hoverFVGZones || [])) {
    const box = _computeFVGBox(z);
    if (box) drawOne(box, W, H, false, false);
  }
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
  _hoverFVGZones = [];
  _fvgTimeIdx = null;       // FVG 索引隨標的/時框失效
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
    if (typeof setFVGZones === "function") setFVGZones(_wrCache[cacheKey].fvg);
    _setFVGData(_wrCache[cacheKey].fvg);
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
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal, cache: "no-store" });
    const d   = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    _wrCacheSet(cacheKey, d);   // 結果照常進快取，下次切回直接命中
    // 世代守衛：成功回來時若已被更新的請求 / 快取命中取代，丟棄此陳舊結果，
    // 否則舊標的的訊號會覆寫當前標的 → markers 全被過濾 → 切標的後策略消失。
    if (myCtrl !== _wrFetchCtrl) return;
    _renderWinRate(d);
    _renderWRSignals(d.signals);
    _renderFVGTrades(d.fvg_trades);   // FVG「接1次」進出場標記（主圖）
    _renderFVGBB(d.fvg_bb, d.fvg_bb_a, d.fvg_bb_m);   // FVG 進出場標記:D(青/粉)+A(橘/紫)+M中軌分側順勢(黃/藍)（研究·主圖）
    _renderFVGBreak(d.fvg_break);     // 結構轉破:多FVG→空FVG→收破前一個多FVG 的那根K（主圖）
    _renderFVGMS(d.fvg_ms);           // 多/空方向標記:吃到未填補反向FVG→收破同向FVG（主圖）
    _renderSMCSweep(d.smc_sweep);     // SMC 掃頂/掃底（階段1：SR+SMC 教練疊加層，右上開關 coachToggleBtn）
    _renderSMCStruct(d.smc_struct);   // SMC BOS/CHoCH 結構破線段（階段2，畫布層，右上開關）
    _renderSMCOB(d.smc_ob);           // SMC 訂單區 OB 框（階段3，畫布層，右上開關）
    _renderSMCSR(d.smc_sr);           // SMC 支撐/阻力區（階段4，畫布層，右上開關）
    _renderCoachVWAP(d.vwap);         // VWAP 成交量加權均價（階段5，畫布層，右上開關）
    _renderCoachChannel(d.channel);   // 自動平行通道（階段5，畫布層，右上開關）
    _updateCoachPanel();              // SR+SMC 教練面板（階段6，左下摘要）
    if (typeof setFVGZones === "function") setFVGZones(d.fvg);
    _setFVGData(d.fvg);
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

// FVG「接1次」cascade 進出場標記（後端 fvg_trades）：進場箭頭 + 出場 ✓勝/✗敗/⟳早平接刀/…未結。
// 與 S/SS 訊號用不同色系（多F=霓虹青、空F=霓虹粉）以資區別；獨立圖層，可隨 window._fvgTradesHidden 開關。
function _renderFVGTrades(trades) {
  if (trades !== undefined) _lastFVGTrades = trades || [];
  const list = _lastFVGTrades || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;

  const out = [];
  for (const t of list) {
    const isShort = t.d === "s";
    // ── 進場（⅓ 階梯：標出每檔成交點；第一檔帶文字、其餘小箭頭）──
    const fills = (t.fills && t.fills.length) ? t.fills : [t.et];
    fills.forEach((ft, idx) => {
      const ftime = toTime(ft);
      if (_has(ftime) && (_rpCut == null || ftime <= _rpCut)) {
        out.push({
          time: ftime, position: isShort ? "aboveBar" : "belowBar",
          color: isShort ? "#ff4081" : "#00e5ff",
          shape: isShort ? "arrowDown" : "arrowUp",
          size: idx === 0 ? 0.8 : 0.5, text: idx === 0 ? (isShort ? "空F" : "多F") : "",
        });
      }
    });
    // ── 出場（勝/敗/早平接刀/未結）──
    if (t.xt) {
      const xt = toTime(t.xt);
      if (_has(xt) && (_rpCut == null || xt <= _rpCut)) {
        const m = t.r === "win"  ? { c: "#26a69a", txt: "✓" }
                : t.r === "loss" ? { c: "#ef5350", txt: "✗" }
                : t.r === "roll" ? { c: "#ffb300", txt: "⟳" }
                :                  { c: "#9e9e9e", txt: "…" };
        const isWin = t.r === "win";
        out.push({
          time: xt,
          position: isWin ? (isShort ? "belowBar" : "aboveBar")
                          : (isShort ? "aboveBar" : "belowBar"),
          color: m.c, shape: "circle", size: 0.8, text: m.txt,
        });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastFVGTradeMarkers = out;
  if (typeof setFVGTradeLines === "function") setFVGTradeLines(_lastFVGTrades, _rpCut);   // 逐筆止損/止盈價位線
  _applyMainMarkers();
}
window._renderFVGTrades = _renderFVGTrades;

// FVG 均值回歸進出場標記（後端 fvg_bb=D版 / fvg_bb_a=A版）：研究用，目視驗證進出場點。
//   進場箭頭(多朝上/空朝下) + 出場圓點(勝綠敗紅逾期灰)。D版=青/粉「布」、A版=橘/紫「A」以利對比。
let _lastFVGBB = [];
let _lastFVGBBA = [];
function _buildFVGBBMarkers(list, lbl, colL, colS) {
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const t of (list || [])) {
    const isShort = t.d === "s";
    const tm = toTime(t.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    const tag = t.win === true ? "✓" : t.win === false ? "✗" : "·";
    out.push({
      time: tm, position: isShort ? "aboveBar" : "belowBar",
      color: isShort ? colS : colL,
      shape: isShort ? "arrowDown" : "arrowUp",
      size: 1.4, text: lbl + (isShort ? "空" : "多") + tag,
    });
    // 出場標記:出場棒位畫圓點，勝綠敗紅(逾期=灰)，位置與進場相反側
    if (t.xt) {
      const xm = toTime(t.xt);
      if (_has(xm) && !(_rpCut != null && xm > _rpCut)) {
        const xc = t.win === true ? "#26a69a" : t.win === false ? "#ef5350" : "#9e9e9e";
        out.push({
          time: xm, position: isShort ? "belowBar" : "aboveBar",
          color: xc, shape: "circle", size: 1.1,
          text: lbl + (t.win === true ? "平✓" : t.win === false ? "平✗" : "平·"),
        });
      }
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
let _lastFVGBBM = [];
function _renderFVGBB(items, itemsA, itemsM) {
  if (items  !== undefined) _lastFVGBB  = items  || [];
  if (itemsA !== undefined) _lastFVGBBA = itemsA || [];
  if (itemsM !== undefined) _lastFVGBBM = itemsM || [];
  lastFVGBBMarkers  = _buildFVGBBMarkers(_lastFVGBB,  "布", "#18ffff", "#ff80ab");  // D版:青/粉
  lastFVGBBMarkersA = _buildFVGBBMarkers(_lastFVGBBA, "A",  "#ffb74d", "#ce93d8");  // A版:橘/紫
  lastFVGBBMarkersM = _buildFVGBBMarkers(_lastFVGBBM, "順", "#ffd54f", "#4fc3f7");  // M版:黃/藍(順勢)
  _applyMainMarkers();
}
window._renderFVGBB = _renderFVGBB;
// 個別開關 D/A 版標記：toggleFVGBB('D') 或 ('A')，可帶布林值強制 on/off
window.toggleFVGBB = function (ver, on) {
  const key = ver === "A" ? "_fvgBBHideA" : ver === "M" ? "_fvgBBHideM" : "_fvgBBHideD";
  window[key] = (on === undefined) ? !window[key] : !on;
  _applyMainMarkers();
  return !window[key];   // 回傳「是否顯示」
};

// 結構轉破標記：多FVG→空FVG→收破前一個多FVG下緣 的那根 K（橘色箭頭+「破多」標在棒上方）
function _renderFVGBreak(items) {
  if (items !== undefined) _lastFVGBreak = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const it of (_lastFVGBreak || [])) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    if (it.d === "s") {
      // 破空：收盤漲破前一個空FVG上緣（看多轉破）→ 棒下方綠色↑
      out.push({ time: tm, position: "belowBar", color: "#26c6a6",
                 shape: "arrowUp", size: 1.6, text: "破空" });
    } else {
      // 破多：收盤跌破前一個多FVG下緣（看空轉破）→ 棒上方橘色↓
      out.push({ time: tm, position: "aboveBar", color: "#ff7043",
                 shape: "arrowDown", size: 1.6, text: "破多" });
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastFVGBreakMarkers = out;
  _applyMainMarkers();
}
window._renderFVGBreak = _renderFVGBreak;
// 開關：window.toggleFVGBreak() 切換結構轉破標記顯示
window.toggleFVGBreak = function (on) {
  window._fvgBreakHidden = (on === undefined) ? !window._fvgBreakHidden : !on;
  _applyMainMarkers();
  return !window._fvgBreakHidden;
};

// 多/空方向標記：吃到未填補反向FVG → 收破同向FVG（空=棒上紅↓「空」、多=棒下綠↑「多」）
function _renderFVGMS(items) {
  if (items !== undefined) _lastFVGMS = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const it of (_lastFVGMS || [])) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    if (it.d === "l") {
      out.push({ time: tm, position: "belowBar", color: "#43a047",
                 shape: "arrowUp", size: 2, text: "多" });
    } else {
      out.push({ time: tm, position: "aboveBar", color: "#e53935",
                 shape: "arrowDown", size: 2, text: "空" });
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastFVGMSMarkers = out;
  _applyMainMarkers();
}
window._renderFVGMS = _renderFVGMS;
// 開關：window.toggleFVGMS() 切換多/空方向標記顯示
window.toggleFVGMS = function (on) {
  window._fvgMSHidden = (on === undefined) ? !window._fvgMSHidden : !on;
  _applyMainMarkers();
  return !window._fvgMSHidden;
};

// SMC 掃頂/掃底標記（階段1：SR+SMC 教練疊加層）：掃頂=棒上紫「掃頂」、掃底=棒下青「掃底」。
// 由右上 coachToggleBtn（window._coachOn）決定是否顯示；此處永遠備好標記，實際顯示在 _applyMainMarkers 依 _coachOn 過濾。
let _lastSMCSweep = [];
function _renderSMCSweep(items) {
  if (items !== undefined) _lastSMCSweep = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const it of (_lastSMCSweep || [])) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    if (it.d === "s") {
      out.push({ time: tm, position: "aboveBar", color: "#ab47bc",
                 shape: "circle", size: 1, text: "掃頂" });
    } else {
      out.push({ time: tm, position: "belowBar", color: "#26c6da",
                 shape: "circle", size: 1, text: "掃底" });
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastSMCSweepMarkers = out;
  _applyMainMarkers();
}
window._renderSMCSweep = _renderSMCSweep;

// SMC BOS/CHoCH 結構破線段（階段2）：存資料給畫布層(draw.js _drawCoachOverlay)，由 _coachOn 決定是否畫。
function _renderSMCStruct(items) {
  window._coachStructure = items || [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderSMCStruct = _renderSMCStruct;

// SMC 訂單區 OB（階段3）：存資料給畫布層(draw.js _drawCoachOverlay)，由 _coachOn 決定是否畫。
function _renderSMCOB(items) {
  window._coachOB = items || [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderSMCOB = _renderSMCOB;

// SMC 支撐/阻力區（階段4）：存資料給畫布層(draw.js _drawCoachOverlay)，由 _coachOn 決定是否畫。
function _renderSMCSR(items) {
  window._coachSR = items || [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderSMCSR = _renderSMCSR;

// VWAP / 自動平行通道（階段5）：存資料給畫布層，由 _coachOn 決定是否畫。
function _renderCoachVWAP(items) {
  window._coachVWAP = items || [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderCoachVWAP = _renderCoachVWAP;
function _renderCoachChannel(ch) {
  window._coachChannel = ch || null;
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderCoachChannel = _renderCoachChannel;

// SR+SMC 教練面板（階段6）：純前端摘要，讀已存的 SMC 資料 + 現價。由 _coachOn 決定顯示。
function _updateCoachPanel() {
  const el = document.getElementById("coachPanel");
  if (!el) return;
  if (!window._coachOn) { el.style.display = "none"; return; }
  const sym = (typeof currentSymbol !== "undefined" ? currentSymbol : "");
  const tf = (typeof currentTF !== "undefined" ? currentTF : "");
  let px = null, li = -1;
  if (typeof ohlcvData !== "undefined" && ohlcvData.length) {
    li = (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
      ? Math.min(replayIdx, ohlcvData.length - 1) : ohlcvData.length - 1;
    px = ohlcvData[Math.max(0, li)].close;
  }
  // 趨勢 / 最新結構：取最後一筆結構事件（replay 時只到揭曉點）
  const _cut = (li >= 0 && typeof ohlcvData !== "undefined") ? toTime(ohlcvData[li].time) : null;
  const struct = (window._coachStructure || []).filter(s => _cut == null || toTime(s.t1) <= _cut);
  const last = struct.length ? struct[struct.length - 1] : null;
  const up = last ? (last.k === "bos_up" || last.k === "choch_up") : null;
  const STXT = { bos_up: "BOS↑ 多方延續", choch_up: "CHoCH↑ 轉多", bos_dn: "BOS↓ 空方延續", choch_dn: "CHoCH↓ 轉空" };
  // 市場階段：近 60 根高低區間定位
  let phase = "—";
  if (px != null && li >= 0) {
    let hi = -Infinity, lo = Infinity;
    for (let i = Math.max(0, li - 59); i <= li; i++) { const b = ohlcvData[i]; if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
    const mid = (hi + lo) / 2, band = (hi - lo) * 0.05;
    phase = px > mid + band ? "溢價（上半）" : px < mid - band ? "折價（下半）" : "均衡（近中線）";
  }
  // 最近存活的上方阻力 / 下方支撐（SR + OB 合併）
  const zones = [...(window._coachSR || []), ...(window._coachOB || [])].filter(z => z.t1 == null);
  let above = null, below = null;
  if (px != null) for (const z of zones) {
    const zt = Math.max(z.top, z.bot), zb = Math.min(z.top, z.bot);
    if (zb > px && (above == null || zb < above.zb)) above = { zt, zb };
    if (zt < px && (below == null || zt > below.zt)) below = { zt, zb };
  }
  const fmt = v => v == null ? "—" : (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const ch = window._coachChannel;
  const chTxt = ch ? (ch.dir === 1 ? "上升通道" : "下降通道") : "—";
  const vw = window._coachVWAP || [];
  const lastV = vw.length ? vw[vw.length - 1].v : null;
  const vwTxt = (px != null && lastV != null) ? (px >= lastV ? "價在 VWAP 之上" : "價在 VWAP 之下") : "—";
  const tc = up == null ? "#9aa" : (up ? "#26a69a" : "#ef5350");
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:10px"><span style="color:#9aa">${k}</span><span>${v}</span></div>`;
  el.innerHTML =
    `<div style="font-weight:700;margin-bottom:5px;color:#ffca28">SR+SMC 教練 · ${sym} ${tf}</div>` +
    row("趨勢", `<b style="color:${tc}">${up == null ? "待定" : (up ? "偏多" : "偏空")}</b>`) +
    row("最新結構", last ? STXT[last.k] : "—") +
    row("市場階段", phase) +
    row("上方阻力", above ? fmt(above.zb) + "~" + fmt(above.zt) : "—") +
    row("下方支撐", below ? fmt(below.zb) + "~" + fmt(below.zt) : "—") +
    row("通道", chTxt) +
    row("VWAP", vwTxt);
  el.style.display = "block";
}
window._updateCoachPanel = _updateCoachPanel;

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

// 切換系列按鈕（index.html onclick）— S1~S12 已退役，固定鎖在 SS，不再切換。
window._toggleWrSeries = function () { _wrSeries = "ss"; };

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
  // FVG 盈虧比盒：hover 到「缺口確認棒」才顯示（正常隱藏）
  const fvgIdx = _buildFVGTimeIndex();
  const fvgs = (time != null && fvgIdx.has(time)) ? fvgIdx.get(time) : [];
  // 圖上 RR 盒 / FVG 盒：停留 0.5s 才顯示（換棒先清掉前一根，避免掃動時狂閃）
  clearTimeout(_hoverRRTimer);
  if (_hoverRRSigs.length || _hoverFVGZones.length) {
    _hoverRRSigs = []; _hoverFVGZones = [];
    if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  }
  if (sigs.length || fvgs.length) {
    _hoverRRTimer = setTimeout(() => {
      _hoverRRSigs = sigs;
      _hoverFVGZones = fvgs;
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
  _applySSCollapse();   // 同步收合狀態到 winrateBar
  // 「連敗機率」按鈕已移除；改為「上方勝率列」收合按鈕（▾=展開中可點收起；▸=已收起可點展開）
  const label = _ssCollapsed ? "勝率 ▸" : "勝率 ▾";
  root.innerHTML = `<span class="wr-streak-wrap"><button class="wr-streak-btn${_ssCollapsed ? "" : " on"}" onclick="_toggleSSCollapse()" title="收起／展開上方整條勝率列">${label}</button></span>`;
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
