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

// proto 缺口(B)最小寬度門檻(decimal)：控制「多/空」「破多空」標記寬鬆度，可切換比較(越大越保守、標記越少)。
// 後端預設 0.0005(0.05%)；改值→cacheKey 帶 pm tag → 後端另分流重算。
let _wrProtoMin = 0.0005;
try { const _pm = parseFloat(localStorage.getItem("wrProtoMin")); if (_pm > 0) _wrProtoMin = _pm; } catch (e) {}
window._PROTO_MIN_STEPS = [0.0005, 0.001, 0.002, 0.003];   // 循環切換值：0.05 / 0.1 / 0.2 / 0.3 %
function _syncProtoMinLabel() {
  const el = document.getElementById("legProtoBVal");
  if (el) el.textContent = +(_wrProtoMin * 100).toFixed(2);   // 0.0005→0.05、0.001→0.1
}
window._syncProtoMinLabel = _syncProtoMinLabel;
window._cycleProtoMin = function () {
  const steps = window._PROTO_MIN_STEPS;
  let i = steps.findIndex(v => Math.abs(v - _wrProtoMin) < 1e-9);
  _wrProtoMin = steps[(i + 1) % steps.length];
  try { localStorage.setItem("wrProtoMin", String(_wrProtoMin)); } catch (e) {}
  _syncProtoMinLabel();
  fetchWinRate();   // 重抓→後端用新門檻重算 多空/破多空（首次該值會重算，之後走快取）
};

// 「不用proto」：多/空 與 破多/破空 的 B 觸發改用正常 3 根 FVG(g+1 確認)取代單根 proto。
// 兩者獨立開關；開→cacheKey 帶 npm/npb tag → 後端各自分流重算。預設關(用 proto)。
let _wrNoProtoMs = false;      // 多/空
let _wrNoProtoBreak = false;   // 破多/破空
let _wrMsBNarrow = false;      // 多/空 加「B寬<A寬」過濾(回測比較用;現行預設無此條件)
try { _wrNoProtoMs = localStorage.getItem("wrNoProtoMs") === "1"; } catch (e) {}
try { _wrNoProtoBreak = localStorage.getItem("wrNoProtoBreak") === "1"; } catch (e) {}
try { _wrMsBNarrow = localStorage.getItem("wrMsBNarrow") === "1"; } catch (e) {}
function _syncNoProtoLabel() {
  const bM = document.getElementById("noProtoMsBtn");
  if (bM) bM.classList.toggle("active", _wrNoProtoMs);
  const lM = document.getElementById("noProtoMsLbl");
  if (lM) lM.textContent = _wrNoProtoMs ? "多空=正常FVG" : "多空=proto";
  const bB = document.getElementById("noProtoBreakBtn");
  if (bB) bB.classList.toggle("active", _wrNoProtoBreak);
  const lB = document.getElementById("noProtoBreakLbl");
  if (lB) lB.textContent = _wrNoProtoBreak ? "破=正常FVG" : "破=proto";
  const bN = document.getElementById("msBNarrowBtn");
  if (bN) bN.classList.toggle("active", _wrMsBNarrow);
  const lN = document.getElementById("msBNarrowLbl");
  if (lN) lN.textContent = _wrMsBNarrow ? "B窄於A" : "B寬不限";
}
window._syncNoProtoLabel = _syncNoProtoLabel;
window._toggleNoProtoMs = function (on) {
  _wrNoProtoMs = (on === undefined) ? !_wrNoProtoMs : !!on;
  try { localStorage.setItem("wrNoProtoMs", _wrNoProtoMs ? "1" : "0"); } catch (e) {}
  _syncNoProtoLabel();
  fetchWinRate();
  return _wrNoProtoMs;
};
window._toggleMsBNarrow = function (on) {
  _wrMsBNarrow = (on === undefined) ? !_wrMsBNarrow : !!on;
  try { localStorage.setItem("wrMsBNarrow", _wrMsBNarrow ? "1" : "0"); } catch (e) {}
  _syncNoProtoLabel();
  fetchWinRate();
  return _wrMsBNarrow;
};
window._toggleNoProtoBreak = function (on) {
  _wrNoProtoBreak = (on === undefined) ? !_wrNoProtoBreak : !!on;
  try { localStorage.setItem("wrNoProtoBreak", _wrNoProtoBreak ? "1" : "0"); } catch (e) {}
  _syncNoProtoLabel();
  fetchWinRate();
  return _wrNoProtoBreak;
};


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
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal, cache: "no-cache" });
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

// FVG/策略標記「近段窗」階梯：初始用小窗(快)，往歷史滑載入更多 K 棒後升級到更大窗 → 補算舊區標記。
// 回傳能覆蓋目前已載入 K 棒數(+緩衝)的最小階梯值。勝率統計不受 vw 影響。
const _WR_VW_LADDER = [8000, 20000, 45000, 100000, 250000];
function _wrVwFor(loaded) {
  const need = (loaded || 0) + 2000;
  for (const v of _WR_VW_LADDER) if (v >= need) return v;
  return _WR_VW_LADDER[_WR_VW_LADDER.length - 1];
}
window._wrCurVw = 0;   // 目前這份勝率結果算標記用的 vw；背景載入更深時比對是否要升級重取

let _wrFetchCtrl = null;   // 切標的時取消舊勝率請求
let _wrInFlight = false;   // 勝率請求飛行中(加速器預熱讓路用;完成/失敗於 finally 清除)
async function _fetchWinRateNow() {
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) return;
  // 台指期（TXF/MXF/TMF）現在後端 fetch_crt_df 已接 futopt 資料（cnyes即時+自建DB歷史/期貨日線）
  //  → 照常打 /api/crt_winrate 算 FVG/策略（勝率統計視資料深度而定，標記照畫；期貨可做空）。
  const bufDec = (_wrStopBuffer || 0) / 100;
  const _vw = _wrVwFor(typeof ohlcvData !== "undefined" ? ohlcvData.length : 0);
  window._wrCurVw = _vw;
  const cacheKey = `${market}:${symbol}:${exchange}:${timeframe}:${bufDec.toFixed(4)}:vw${_vw}:pm${_wrProtoMin}:npm${_wrNoProtoMs ? 1 : 0}:npb${_wrNoProtoBreak ? 1 : 0}:bn${_wrMsBNarrow ? 1 : 0}`;
  if (_wrCache[cacheKey]) {
    // 快取命中也要取消上一個還在飛的勝率請求，否則它稍後成功回來會用「舊標的」的
    // 訊號覆寫 _lastWRSignals → 訊號時間不存在於新標的 ohlcv → markers 全被過濾 → 策略不顯示。
    if (_wrFetchCtrl) { _wrFetchCtrl.abort(); _wrFetchCtrl = null; }
    const c = _wrCache[cacheKey];
    _renderWinRate(c);
    _renderWRSignals(c.signals);
    // 快取命中也要把「這個標的」的 FVG/SMC 各層重繪回來——否則沿用上一個標的的舊標記
    // （例：BTC→SOL→BTC 切回來，主圖 FVG 多/空、破多/破空還是 SOL 的 → 大段沒有標記/位置亂掉）
    _renderFVGTrades(c.fvg_trades);
    _renderFVGBB(c.fvg_bb, c.fvg_bb_a, c.fvg_bb_m);
    _renderFVGBreak(c.fvg_break);
    _renderFVGMS(c.fvg_ms);
    _renderFVGShun(c.fvg_shun);
    _renderSMCSweep(c.smc_sweep);
    _renderSMCStruct(c.smc_struct);
    _renderSMCOB(c.smc_ob);
    _renderSMCSR(c.smc_sr);
    _renderCoachVWAP(c.vwap);
    _renderCoachChannel(c.channel);
    _updateCoachPanel();
    if (typeof setFVGZones === "function") setFVGZones(c.fvg);
    _setFVGData(c.fvg);
    window._pdRanges = c.pd_ranges || (c.pd_range ? [c.pd_range] : []);
    if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    // 快取命中也要刷新左抽屜（含敗後停手求解），否則切回已載入過的標的時抽屜不更新
    if (typeof window._refreshSignalDrawer === "function") window._refreshSignalDrawer();
    return;
  }
  // 取消上次未完成的勝率請求
  if (_wrFetchCtrl) _wrFetchCtrl.abort();
  _wrFetchCtrl = new AbortController();
  _wrInFlight = true;                    // 加速器讓路用(fetch 完成/失敗都會在 finally 清)
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
    const p   = new URLSearchParams({ market, symbol, exchange, timeframe, stop_buffer_pct: bufDec.toFixed(4), vw: String(_vw), proto_min: String(_wrProtoMin), no_proto_ms: _wrNoProtoMs ? "1" : "0", no_proto_break: _wrNoProtoBreak ? "1" : "0", ms_bnarrow: _wrMsBNarrow ? "1" : "0" });
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal, cache: "no-cache" });
    const d   = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    _wrCacheSet(cacheKey, d);   // 結果照常進快取，下次切回直接命中
    // 世代守衛：成功回來時若已被更新的請求 / 快取命中取代，丟棄此陳舊結果，
    // 否則舊標的的訊號會覆寫當前標的 → markers 全被過濾 → 切標的後策略消失。
    if (myCtrl !== _wrFetchCtrl) return;
    if (typeof window._snapSave === "function") window._snapSave(d);   // 本機快照(開app秒出圖,見檔尾模組)
    _renderWinRate(d);
    _renderWRSignals(d.signals);
    _renderFVGTrades(d.fvg_trades);   // FVG「接1次」進出場標記（主圖）
    _renderFVGBB(d.fvg_bb, d.fvg_bb_a, d.fvg_bb_m);   // FVG 進出場標記:D(青/粉)+A(橘/紫)+M中軌分側順勢(黃/藍)（研究·主圖）
    _renderFVGBreak(d.fvg_break);     // 破多/破空 結構轉破（proto 缺口序列、標在 g）（主圖）
    _renderFVGMS(d.fvg_ms);           // 多/空方向標記:吃 setup FVG 後窗內首次同向 proto 缺口 B（標在 g）（主圖）
    _renderFVGShun(d.fvg_shun);       // 順多/順空:吃同向FVG後影線穿透既存反向FVG（主圖）
    _renderSMCSweep(d.smc_sweep);     // SMC 掃頂/掃底（階段1：SR+SMC 教練疊加層，右上開關 coachToggleBtn）
    _renderSMCStruct(d.smc_struct);   // SMC BOS/CHoCH 結構破線段（階段2，畫布層，右上開關）
    _renderSMCOB(d.smc_ob);           // SMC 訂單區 OB 框（階段3，畫布層，右上開關）
    _renderSMCSR(d.smc_sr);           // SMC 支撐/阻力區（階段4，畫布層，右上開關）
    _renderCoachVWAP(d.vwap);         // VWAP 成交量加權均價（階段5，畫布層，右上開關）
    _renderCoachChannel(d.channel);   // 自動平行通道（階段5，畫布層，右上開關）
    _updateCoachPanel();              // SR+SMC 教練面板（階段6，左下摘要）
    if (typeof setFVGZones === "function") setFVGZones(d.fvg);
    _setFVGData(d.fvg);
    window._pdRanges = d.pd_ranges || (d.pd_range ? [d.pd_range] : []);   // 每段歷史折價/溢價區(主圖畫)
    if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
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
    if (myCtrl === _wrFetchCtrl) _wrInFlight = false;   // 只有最新請求結束才視為「沒請求在飛」
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

// 結構轉破標記：破多/破空（proto 缺口序列、標在 g）（橘色箭頭+「破多」標在棒上方）
function _renderFVGBreak(items) {
  if (items !== undefined) _lastFVGBreak = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const src = _lastFVGBreak || [];
  const out = [];
  for (const it of src) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    // 一律全亮不淡化(使用者要求)——原「weak」依折價/溢價位置,該區已關閉、依據不再可見
    const _pv = !!it.prov;   // 未收盤那根的暫定破(收盤才確認)→ 文字加「?」、primitive 半透明+空心
    if (it.d === "s") {
      // 破空（看多轉破）→ 棒下方 賽博霓虹青↑
      out.push({ time: tm, position: "belowBar", color: "#05d9e8",
                 shape: "arrowUp", size: 1.6, text: _pv ? "破空?" : "破空", prov: _pv });
    } else {
      // 破多（看空轉破）→ 棒上方 賽博霓虹橘↓
      out.push({ time: tm, position: "aboveBar", color: "#ff901f",
                 shape: "arrowDown", size: 1.6, text: _pv ? "破多?" : "破多", prov: _pv });
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

// 多/空方向標記：吃 setup FVG 後、窗內首次同向 proto 缺口 B（B 用 g 收盤定緣、標在 g）
//（空=棒上紅↓「空」、多=棒下綠↑「多」）
function _renderFVGMS(items) {
  if (items !== undefined) _lastFVGMS = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const src = _lastFVGMS || [];
  const out = [];
  for (const it of src) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    // 一律全亮不淡化(使用者要求)——原「weak」淡化依折價/溢價位置,該區已關閉、依據不再可見
    // prov=未收盤那根的暫定訊號(收盤才確認)→ 文字加「?」、primitive 以半透明+空心箭頭畫,明顯區隔已確認
    const _pv = !!it.prov;
    if (it.d === "l") {
      out.push({ time: tm, position: "belowBar", color: "#39ff14",
                 shape: "arrowUp", size: 2, text: _pv ? "多?" : "多", prov: _pv });
    } else {
      out.push({ time: tm, position: "aboveBar", color: "#ff2a6d",
                 shape: "arrowDown", size: 2, text: _pv ? "空?" : "空", prov: _pv });
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

// 順多/順空方向標記：第一步同多/空(吃到未觸碰同向FVG)，第二步=影線穿透既存反向FVG(順勢延續)
// （順多=棒下藍↑「順多」、順空=棒上桃紅↓「順空」；weak=位置不對→淡化）
function _renderFVGShun(items) {
  if (items !== undefined) _lastFVGShun = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const it of (_lastFVGShun || [])) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    // 一律全亮不淡化(使用者要求)——原「weak」依折價/溢價位置,該區已關閉、依據不再可見
    const _pv = !!it.prov;   // 未收盤那根的暫定順(收盤才確認)→ 文字加「?」、primitive 半透明+空心
    if (it.d === "l") {
      out.push({ time: tm, position: "belowBar", color: "#00b8ff",
                 shape: "arrowUp", size: 2, text: _pv ? "順多?" : "順多", prov: _pv });
    } else {
      out.push({ time: tm, position: "aboveBar", color: "#d400ff",
                 shape: "arrowDown", size: 2, text: _pv ? "順空?" : "順空", prov: _pv });
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastFVGShunMarkers = out;
  _applyMainMarkers();
}
window._renderFVGShun = _renderFVGShun;
// 開關：window.toggleFVGShun() 切換順多/順空標記顯示
window.toggleFVGShun = function (on) {
  window._fvgShunHidden = (on === undefined) ? !window._fvgShunHidden : !on;
  _applyMainMarkers();
  return !window._fvgShunHidden;
};

// 策略止損線資料：time → {sl,d}。sl＝該策略「生成的第一個 FVG 的 g-1 頂端」(後端帶入)。
//   hover 到策略訊號棒(多/空·破·順)時，由 draw.js 的 _renderStratSLLine 畫一條止損線。取代原「自動盈虧比盒」。
window._stratSlByTime = new Map();
window._rebuildStratSL = function () {
  const m = new Map();
  const add = (arr) => { for (const it of (arr || [])) { if (it && it.sl != null) m.set(toTime(it.t), { sl: it.sl, tp: (it.tp != null ? it.tp : null), d: it.d }); } };
  add(typeof _lastFVGMS !== "undefined" ? _lastFVGMS : null);
  add(typeof _lastFVGBreak !== "undefined" ? _lastFVGBreak : null);
  add(typeof _lastFVGShun !== "undefined" ? _lastFVGShun : null);
  window._stratSlByTime = m;
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

// 教練步驟5(BOS 延續)達成點：主圖箭頭標記(多↑綠棒下／空↓紅棒上，text「步驟5 BOS」)。
// 與計畫線同源：15m 圖用 default、5m 圖用 fast（其他時框 bos_time 不對齊棒、自然不顯示）。
// 由 _coachOn 控制（併入 _applyMainMarkers 的 lastCoachBOSMarkers）。資料來自 _coachData(按標的鍵)+bos_time。
function _renderCoachBOS() {
  lastCoachBOSMarkers = [];
  const _tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const d = _tf === "15m" ? (_coachData && _coachData.def)
          : _tf === "5m"  ? (_coachData && _coachData.fast) : null;
  if (d && d.ok && d.bos_time && (d.stage || 0) >= 5 && typeof ohlcvData !== "undefined" && ohlcvData) {
    const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
    const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(x => toTime(x.time)));
    const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
    const _rpCut = (typeof replayActive !== "undefined" && replayActive
      && typeof replayData !== "undefined" && replayData[replayIdx])
      ? toTime(replayData[replayIdx].time) : null;
    const tm = toTime(d.bos_time);
    if (_has(tm) && (_rpCut == null || tm <= _rpCut)) {
      const up = d.direction === 1;
      lastCoachBOSMarkers.push({
        time: tm,
        position: up ? "belowBar" : "aboveBar",
        color: up ? "#26a69a" : "#ef5350",
        shape: up ? "arrowUp" : "arrowDown",
        size: 2,
        text: "步驟5 BOS",
      });
    }
  }
  _applyMainMarkers();
}
window._renderCoachBOS = _renderCoachBOS;

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

// SR+SMC 多空教練面板（多時框步驟狀態機）：抓 /api/smc_coach 兩版(default 1d/4h/1h/15m + fast 4h/1h/15m/5m)。
//   展開＝兩版並列全表；收合＝只顯示選中那版＋按鈕切換。由 _coachOn 控制。
let _coachData = null, _coachFetching = false;   // _coachData = { def, fast, _key, _ts }
try { window._coachWhich = localStorage.getItem("coachWhich") === "fast" ? "fast" : "default"; } catch (e) { window._coachWhich = "default"; }
function _coachSel() {   // 目前選中(收合顯示/HTF投影用)那版資料
  if (!_coachData) return null;
  return window._coachWhich === "fast" ? _coachData.fast : _coachData.def;
}
function _fetchCoachData(force) {
  if (!window._coachOn) { _renderCoachPanel(); return; }   // 關閉→隱藏面板（_renderCoachPanel 內會 display:none）
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
  if (!symbol) return;
  const key = market + "|" + symbol + "|" + exchange;
  if (!force && _coachData && _coachData._key === key && (Date.now() - _coachData._ts < 20000)) {
    _renderCoachPanel(); _renderCoachBOS(); return;   // 快取命中(含切時框reload)：同標的資料→重建步驟5標記
  }
  if (_coachFetching) return;
  _coachFetching = true;
  _renderCoachPanel();   // 先顯示載入中
  const _one = tfset => fetch("/api/smc_coach?" + new URLSearchParams({ market, symbol, exchange, tfset }), { cache: "no-store" })
    .then(r => r.json()).catch(() => null);
  Promise.all([_one("default"), _one("fast")])
    .then(([dd, df]) => {
      if (dd && dd.ok) _coachAlertOnAdvance(key + "|d", dd);   // 兩版各自的步驟前進鬧鐘
      if (df && df.ok) _coachAlertOnAdvance(key + "|f", df);
      _coachData = { def: dd, fast: df, _key: key, _ts: Date.now() };
      _renderCoachPanel();
      const sel = _coachSel();   // HTF 投影只畫選中那版(避免兩版疊圖)
      window._coachHTF = (sel && sel.ok && sel.htf_zones) ? sel.htf_zones : [];
      window._coachHTFCh = (sel && sel.ok && sel.htf_channels) ? sel.htf_channels : [];
      // 交易計畫線畫主圖：15m 圖用 default(執行15m)、5m 圖用 fast(執行5m)，BOS(stage≥5)確認起就給
      // (stage5 進場區=HTF區、6=掛單區、≥7=已觸碰；提前畫讓使用者 BOS 一到就看得到計畫)
      window._coachPlanByTf = {
        "15m": (dd && dd.ok && dd.stage >= 5) ? dd.plan : null,
        "5m": (df && df.ok && df.stage >= 5) ? df.plan : null,
      };
      _renderCoachBOS();   // 步驟5(BOS)達成點主圖標記
      if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    })
    .catch(() => {})
    .finally(() => { _coachFetching = false; });
}
window._fetchCoachData = _fetchCoachData;

// 步驟前進鬧鐘（Pine「步驟 1～7 響鈴」）：同標的步驟數變大 → toast + 瀏覽器通知。
const _coachLastStage = {};
function _coachAlertOnAdvance(key, d) {
  const prev = _coachLastStage[key];
  _coachLastStage[key] = d.stage;
  if (prev === undefined || d.stage <= prev) return;   // 首次載入或未前進 → 不叫
  const st = (d.steps || []).find(x => x.n === d.stage);
  const dirTxt = d.direction === 1 ? "多單" : d.direction === -1 ? "空單" : "";
  const msg = `🎯 ${d.symbol}｜${dirTxt}｜步驟 ${d.stage}${st ? "｜" + st.title : ""} 完成`;
  if (typeof showToast === "function") showToast(msg + (st ? "：" + st.text : ""), 7000);
  try {
    if (window.Notification && Notification.permission === "granted")
      new Notification("SR+SMC 教練", { body: msg, tag: "coach-" + key });
  } catch (e) {}
}

function _renderCoachPanel() {
  const el = document.getElementById("coachPanel");
  if (!el) return;
  if (!window._coachOn) { el.style.display = "none"; return; }
  el.style.display = "block";
  const dd = _coachData && _coachData.def, df = _coachData && _coachData.fast;
  if ((!dd || !dd.ok) && (!df || !df.ok)) {
    el.innerHTML = `<div style="font-weight:700;color:#ffca28">SR+SMC 教練</div><div style="color:#9aa">${_coachFetching ? "載入中…" : "無資料"}</div>`;
    return;
  }
  const fmt = v => v == null ? "—" : (Math.abs(v) >= 1000 ? Number(v).toFixed(0) : Number(v).toFixed(4));
  const tflabel = d => (d && d.tfset === "fast") ? "4h/1h/15m/5m" : "1d/4h/1h/15m";
  const dcOf = d => (d && d.direction === 1) ? "#26a69a" : (d && d.direction === -1) ? "#ef5350" : "#9aa";
  const dtOf = d => (d && d.direction === 1) ? "多單" : (d && d.direction === -1) ? "空單" : "待定";
  // 單一版本的內容（不含最外層標題列）
  const bodyFor = (d, collapsed, compact) => {
    if (!d || !d.ok) return `<div style="color:#9aa">（此版無資料）</div>`;
    const dc = dcOf(d);
    const mp = d.market_pos;
    const mpTxt = mp ? `${mp.inside ? "目前位於" : "最近"}：${mp.kind} ${fmt(mp.bot)} ~ ${fmt(mp.top)}` : "—";
    const pl = d.plan;
    const tps = (pl && Array.isArray(pl.tps) && pl.tps.length) ? pl.tps : (pl && pl.tp != null ? [pl.tp] : []);
    const planParts = pl ? [
      pl.entry ? ["進場", fmt(pl.entry[0]) + "~" + fmt(pl.entry[1]), "#4fc3f7"] : null,
      pl.sl != null ? ["止損", fmt(pl.sl), "#ef5350"] : null,
      ...tps.map((v, i) => ["止盈" + (i + 1), fmt(v), "#26a69a"]),   // TP1～TP4
    ].filter(Boolean) : [];
    const planTxt = planParts.length
      ? planParts.map(p => `<span style="color:${p[2]}">${p[0]} ${p[1]}</span>`).join(`<span style="color:#667">｜</span>`)
      : "—";
    if (collapsed) {
      const planLine = `<div style="font-weight:600;background:rgba(255,255,255,0.05);border-radius:5px;padding:3px 6px">${planTxt}</div>`;
      if (compact) return planLine;   // 手機收合：只留交易計畫一行（省掉 progress 敘述那行）
      return `<div style="color:#cdd;max-width:390px;margin-bottom:3px">${d.progress}</div>` + planLine;
    }
    const row = (k, v, c) => `<div style="display:flex;gap:8px;padding:1px 0"><span style="color:#9aa;min-width:76px">${k}</span><span style="color:${c || '#e6e6e6'};flex:1">${v}</span></div>`;
    const stepRow = s => `<div style="display:flex;gap:6px;padding:2px 0;border-top:1px solid rgba(255,255,255,0.07)"><span style="color:${s.done ? dc : '#8a95a5'};min-width:104px;font-weight:600">${s.done ? '✓' : '○'} 步驟${s.n}｜${s.title}</span><span style="color:${s.done ? '#e6e6e6' : '#9aa'};flex:1">${s.text}</span></div>`;
    return row("持倉狀態", d.position_status || "無持倉")
      + row("市場位置", mpTxt)
      + row("通道", d.channel_1h)
      + row("交易計畫", planTxt, "#ffd54f")
      + `<div style="margin-top:3px">` + (d.steps || []).map(stepRow).join("") + `</div>`;
  };
  const sym = (dd && dd.symbol) || (df && df.symbol) || "";
  const collapsed = window._coachCollapsed !== false;
  // 進場狀態徽章：與「可進場」清單同一套定義(stage≥5 起顯示)——階梯 stage5=BOS完成·準備掛單 →
  //   stage6=掛單中 → stage≥7 還要看「現價距掛單區」:區內=🎯可進場(綠)、≤3%=🎯可進場·距x%(綠)、>3%=已觸碰·價已離區(黃灰)
  const entryBadge = d => {
    if (!d || !d.ok) return "";
    if (d.stage >= 7) {
      const ent = d.plan && d.plan.entry; let dist = null;
      if (ent && ent.length >= 2 && ent[0] != null && d.price != null) {
        const lo = Math.min(ent[0], ent[1]), hi = Math.max(ent[0], ent[1]);
        dist = (d.price >= lo && d.price <= hi) ? 0 : Math.min(Math.abs(d.price - lo), Math.abs(d.price - hi)) / d.price * 100;
      }
      if (dist != null && dist > 3)
        return `<span style="background:#4a3b00;color:#d8c07a;border-radius:3px;padding:0 5px;margin-left:5px">已觸碰·價已離區${dist.toFixed(1)}%</span>`;
      const t = (dist != null && dist > 0) ? `·距${dist.toFixed(1)}%` : "";
      return `<span style="background:#1b5e20;color:#b6ffbf;border-radius:3px;padding:0 5px;margin-left:5px;font-weight:700">🎯可進場${t}</span>`;
    }
    if (d.stage >= 6) return `<span style="background:#4a3b00;color:#ffd54f;border-radius:3px;padding:0 5px;margin-left:5px">掛單中</span>`;
    // stage5：BOS 延續完成，setup 成立、下一步就是去掛單 → 提前顯示的核心狀態
    if (d.stage >= 5) return `<span style="background:#0d3b52;color:#8fd3ff;border-radius:3px;padding:0 5px;margin-left:5px;font-weight:700">✅BOS完成·準備掛單</span>`;
    return "";
  };
  const subhead = d => `<div style="color:#ffca28;font-weight:600;margin:3px 0 1px;font-size:10.5px">〔${tflabel(d)}〕<b style="color:${dcOf(d)}">${dtOf(d)}</b>｜步驟 ${d ? d.stage : 0}/8${entryBadge(d)}</div>`;
  // 從「可進場」清單點進來的期望檢查:命中版本若已失效退階(<5)→紅色提示+立即刷新清單
  // (5m/15m 執行時框設定壽命短,點開瞬間剛失效是週期本質——明講,而不是讓使用者以為清單亂給)
  let expectWarn = "";
  try {
    const ex = window._coachClickExpect;
    if (ex && sym === ex.sym && Date.now() - ex.ts < 30000) {
      const dv = ex.ver === "fast" ? df : dd;
      if (dv && dv.ok) {
        if ((dv.stage || 0) < 5) {
          expectWarn = `<div style="background:#4a1414;color:#ffb3ab;border-radius:4px;padding:2px 6px;margin-bottom:3px;font-size:11px">⚠ 此設定剛失效退階（${ex.ver === "fast" ? "⚡5m" : "15m"} 週期變化快）— 清單已同步更新</div>`;
          if (typeof _fetchCoachScan === "function") setTimeout(() => _fetchCoachScan(true), 300);
        }
        window._coachClickExpect = null;   // 評過一次就清掉
      }
    }
  } catch (e) {}
  if (collapsed) {   // 收合：桌機兩版同時顯示；手機只顯示選中那版＋精簡（收得更小）
    const first  = window._coachWhich === "fast" ? df : dd;
    const second = window._coachWhich === "fast" ? dd : df;
    const _mob = (typeof isMobileUI === "function" && isMobileUI());
    const head = `<div style="display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:3px;margin-bottom:3px">`
      + `<span style="font-weight:700;color:#ffca28;flex:1">教練 · ${sym}</span>`
      + (_mob ? `<button onclick="window._coachToggleWhich&&window._coachToggleWhich()" style="pointer-events:auto;cursor:pointer;background:rgba(79,195,247,0.18);border:0;border-radius:4px;color:#8fd3ff;font-size:11px;padding:1px 6px" title="切換時框組">切 ⇄</button>` : ``)
      + `<button onclick="window._coachToggleCollapse&&window._coachToggleCollapse()" style="pointer-events:auto;cursor:pointer;background:rgba(255,255,255,0.1);border:0;border-radius:4px;color:#cfd;font-size:11px;padding:1px 6px">展開 ▾</button></div>`;
    el.innerHTML = _mob
      ? head + expectWarn + subhead(first) + bodyFor(first, true, true)   // 手機：單版＋compact（只留計畫一行）
      : head + expectWarn
        + subhead(first) + bodyFor(first, true)
        + `<div style="height:6px;border-top:1px dashed rgba(255,255,255,0.14);margin-top:4px"></div>`
        + subhead(second) + bodyFor(second, true);
    return;
  }
  // 展開：只顯示選中那版全表 + 按鈕切換
  const sel = _coachSel() || dd || df;
  const head = `<div style="display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:3px;margin-bottom:4px">`
    + `<span style="font-weight:700;color:#ffca28;flex:1">教練 · ${sym}｜〔${tflabel(sel)}〕｜<b style="color:${dcOf(sel)}">${dtOf(sel)}</b>｜步驟 ${sel ? sel.stage : 0}/8${entryBadge(sel)}</span>`
    + `<button onclick="window._coachToggleWhich&&window._coachToggleWhich()" style="pointer-events:auto;cursor:pointer;background:rgba(79,195,247,0.18);border:0;border-radius:4px;color:#8fd3ff;font-size:11px;padding:1px 6px" title="切換時框組">切 ⇄</button>`
    + `<button onclick="window._coachToggleCollapse&&window._coachToggleCollapse()" style="pointer-events:auto;cursor:pointer;background:rgba(255,255,255,0.1);border:0;border-radius:4px;color:#cfd;font-size:11px;padding:1px 6px">收合 ▴</button></div>`;
  el.innerHTML = head + expectWarn + bodyFor(sel, false);
}
window._renderCoachPanel = _renderCoachPanel;
// 收合/展開（唯一可互動處，因面板整體 pointer-events:none）
window._coachToggleCollapse = function () {
  window._coachCollapsed = !(window._coachCollapsed !== false);
  try { localStorage.setItem("coachCollapsed", window._coachCollapsed ? "1" : "0"); } catch (e) {}
  _renderCoachPanel();
};
// 收合時切換顯示哪一版（default⇄fast）；HTF 投影跟著換
window._coachToggleWhich = function () {
  window._coachWhich = window._coachWhich === "fast" ? "default" : "fast";
  try { localStorage.setItem("coachWhich", window._coachWhich); } catch (e) {}
  const sel = _coachSel();
  window._coachHTF = (sel && sel.ok && sel.htf_zones) ? sel.htf_zones : [];
  window._coachHTFCh = (sel && sel.ok && sel.htf_channels) ? sel.htf_channels : [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  _renderCoachPanel();
};
try { window._coachCollapsed = localStorage.getItem("coachCollapsed") !== "0"; } catch (e) {}

function _updateCoachPanel() { _fetchCoachData(false); }
window._updateCoachPanel = _updateCoachPanel;

// 教練面板定時刷新（15M 新棒收盤後狀態會變）：開啟時每 20s 抓一次。
if (typeof window !== "undefined" && !window._coachPollStarted) {
  window._coachPollStarted = true;
  setInterval(() => { if (window._coachOn && !document.hidden) _fetchCoachData(false); }, 20000);
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
  // 自動盈虧比盒已移除（使用者要求）：hover 不再畫 RR 盒／FVG 盒。若殘留先清掉。
  clearTimeout(_hoverRRTimer);
  if (_hoverRRSigs.length || _hoverFVGZones.length) {
    _hoverRRSigs = []; _hoverFVGZones = [];
    if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  }
  // ── 改成：hover 到策略訊號棒（多/空·破·順，帶 sl）→ 在「第一個 FVG 的 g-1 頂端」畫止損線；換棒/離開即移除 ──
  const _slInfo = (time != null && window._stratSlByTime) ? window._stratSlByTime.get(time) : null;
  const _slVal = _slInfo ? _slInfo.sl : null;
  if (_slVal !== window._curSlLineVal) {
    window._curSlLineVal = _slVal;
    if (window._slPriceLine) { try { candleSeries.removePriceLine(window._slPriceLine); } catch (e) {} window._slPriceLine = null; }
    if (_slVal != null && typeof candleSeries !== "undefined" && candleSeries) {
      try {
        window._slPriceLine = candleSeries.createPriceLine({
          price: _slVal, color: "#ff3b6b", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "止損",
        });
      } catch (e) {}
    }
  }
  // 止盈線（量>標記棒且同色確認棒的收盤價；僅 fvg_ms 帶 tp，破/順無 tp→不顯示）
  const _tpVal = _slInfo ? _slInfo.tp : null;
  if (_tpVal !== window._curTpLineVal) {
    window._curTpLineVal = _tpVal;
    if (window._tpPriceLine) { try { candleSeries.removePriceLine(window._tpPriceLine); } catch (e) {} window._tpPriceLine = null; }
    if (_tpVal != null && typeof candleSeries !== "undefined" && candleSeries) {
      try {
        window._tpPriceLine = candleSeries.createPriceLine({
          price: _tpVal, color: "#26c6da", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "止盈",
        });
      } catch (e) {}
    }
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

/* ══════════════════════════════════════════
   加速器：閒置預載（伺服器快取預熱）
   切到「沒算過」的標的最慢要等後端抓K線+算勝率 5~8s → 瀏覽器閒置時把
   自選清單的標的先悄悄打一次 /api/crt_winrate 讓後端算好+快取。
   ・純預熱：收到回應頭就取消 body（省手機流量），不塞前端 _wrCache（勝率物件大，
     _WR_CACHE_MAX=5 會被擠爆）→ 切過去時走網路但秒回（伺服器快取命中 ~0.1s）。
   ・溫和節流：每 8s 最多預熱 1 檔、同(標的×時框×參數) 25 分內不重打、
     使用者自己的勝率請求在飛/背景補載中/重播中/分頁在背景 → 本輪跳過。
   ・參數對齊：新標的初載必為 vw=8000（_wrVwFor(初始棒數)），預熱用同值 → 後端快取鍵一致。
══════════════════════════════════════════ */
let _accelOn = (() => { try { return localStorage.getItem("accelOn") !== "0"; } catch (e) { return true; } })();
const _accelDone = {};                 // 預熱鍵 → ts
function _accelCandidates() {
  let wl = [];
  try { wl = JSON.parse(localStorage.getItem("watchlist") || "[]"); } catch (e) {}
  const curMkt = document.getElementById("marketSelect")?.value || "crypto";
  const curSym = (document.getElementById("symbolInput")?.value || "").trim();
  const same = [], other = [];
  for (const w of wl) {
    if (!w || !w.symbol || w.symbol === curSym) continue;
    ((w.market || "crypto") === curMkt ? same : other).push(w);
  }
  return same.concat(other).slice(0, 8);   // 同市場優先、最多 8 檔
}
async function _accelTick() {
  if (!_accelOn || document.hidden) return;
  if (typeof replayActive !== "undefined" && replayActive) return;
  if (_wrInFlight) return;                                             // 使用者請求優先
  if (typeof _bgLoadInProgress !== "undefined" && _bgLoadInProgress) return;
  // 互動讓路：平移/縮放/捲動中(或剛結束 3s 內)不預熱 —— 預熱會踢後端重算,
  // 本機開發(前後端同一台)會跟瀏覽器搶 CPU、線上也搶使用者頻寬 → 等真的閒下來再暖。
  const _n = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (window._chartMoveTs && _n - window._chartMoveTs < 3000) return;
  const timeframe = (typeof currentTF !== "undefined" && currentTF) || "1d";
  const bufDec = ((_wrStopBuffer || 0) / 100).toFixed(4);
  for (const w of _accelCandidates()) {
    const mkt = w.market || "crypto", exch = w.exchange || "pionex";
    const key = `${mkt}:${w.symbol}:${exch}:${timeframe}:${bufDec}:${_wrProtoMin}:${_wrNoProtoMs ? 1 : 0}:${_wrNoProtoBreak ? 1 : 0}`;
    if (Date.now() - (_accelDone[key] || 0) < 25 * 60 * 1000) continue;   // 後端快取~30分 → 25分內不重打
    _accelDone[key] = Date.now();
    try {
      const p = new URLSearchParams({ market: mkt, symbol: w.symbol, exchange: exch, timeframe,
        stop_buffer_pct: bufDec, vw: "8000", proto_min: String(_wrProtoMin),
        no_proto_ms: _wrNoProtoMs ? "1" : "0", no_proto_break: _wrNoProtoBreak ? "1" : "0", ms_bnarrow: _wrMsBNarrow ? "1" : "0" });
      const res = await fetch("/api/crt_winrate?" + p, { cache: "no-cache" });
      try { if (res.body) res.body.cancel(); } catch (e) {}              // 只要後端算完，body 不用下載
    } catch (e) { /* 預熱失敗靜默（下輪 25 分後再試） */ }
    break;                                                               // 每輪只預熱 1 檔（溫和）
  }
}
window.toggleAccel = function (on) {
  _accelOn = (on === undefined) ? !_accelOn : !!on;
  try { localStorage.setItem("accelOn", _accelOn ? "1" : "0"); } catch (e) {}
  const st = document.getElementById("mSetAccelState");
  if (st) st.textContent = _accelOn ? "開啟" : "關閉";
  const row = document.getElementById("mSetAccel");
  if (row) row.classList.toggle("m-set-on", _accelOn);
  return _accelOn;
};
setTimeout(() => {
  window.toggleAccel(_accelOn);                    // 同步設定列初始標示
  setInterval(_accelTick, 8000);                   // 進場穩定後才開始，避免搶首屏
}, 15000);

/* ══════════════════════════════════════════
   本機快照（開 app／切標的 秒出圖）— IndexedDB，最近 5 個標的(LRU)
   存：勝率新鮮結果落地時(唯一寫入點在 _fetchWinRateNow 成功路徑呼叫 _snapSave)，
       每個標的一筆：近 1500 根 K 棒 + 整份勝率 payload；LRU 只留 5 筆。
   畫：loadData 每次啟動呼叫 _snapPaint()（開機與切標的同一條路）→ 有該標的快照就先畫；
       真資料落地時 loadData 呼叫 _snapInvalidate() 作廢未完成的快照繪製（世代守衛）。
       ⚠ 不寫進 _wrCache（快取命中會 return 跳過網路）→ 正常載入照跑、到貨自動覆蓋。
   斷網開 app：SW 離線外殼進得來 + loadData 失敗不作廢 → 照樣畫出最後一份圖。
══════════════════════════════════════════ */
(function () {
  const STORE = "kv";
  const MAX_SNAPS = 5;   // 最近 5 個標的
  function _idb() {
    return new Promise((res, rej) => {
      const q = indexedDB.open("ahh_snapshot", 1);
      q.onupgradeneeded = () => q.result.createObjectStore(STORE);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  const _put = (key, v) => _idb().then(db => new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    os.put(v, key);
    os.delete("last");                        // 清掉舊版單筆遺留
    const gk = os.get("__keys__");            // LRU 索引：最近用的在前，同一交易內修剪
    gk.onsuccess = () => {
      let ks = Array.isArray(gk.result) ? gk.result : [];
      ks = [key].concat(ks.filter(k => k !== key));
      for (const k of ks.slice(MAX_SNAPS)) os.delete(k);
      os.put(ks.slice(0, MAX_SNAPS), "__keys__");
    };
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  }));
  const _get = key => _idb().then(db => new Promise(res => {
    const q = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result || null); q.onerror = () => res(null);
  })).catch(() => null);
  const _uiKey = () => [
    document.getElementById("marketSelect")?.value || "crypto",
    document.getElementById("symbolInput")?.value?.trim() || "",
    document.getElementById("exchangeSelect")?.value || "pionex",
    currentTF || "1d",
  ].join("|");

  let _saveTimer = null;
  window._snapSave = function (wr) {
    const key = _uiKey();                     // 呼叫當下的標的（勝率結果屬於它）
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      const run = () => {
        try {
          if (key !== _uiKey()) return;       // 使用者已切標的 → K棒與 payload 不再配對，放棄
          if (typeof ohlcvData === "undefined" || !ohlcvData.length || !wr) return;
          _put(key, { key, bars: ohlcvData.slice(-1500), wr, at: Date.now() }).catch(() => {});
        } catch (e) {}
      };
      // IDB 內部 clone 大 payload ~10-30ms → 等瀏覽器閒了再存,不搶標記重建
      ("requestIdleCallback" in window) ? requestIdleCallback(run, { timeout: 5000 }) : run();
    }, 1200);
  };

  // 世代守衛：_snapPaint 每次 ++（新載入取代舊的）、真資料落地 _snapInvalidate() 也 ++
  // → IDB 讀取比較慢時，晚到的快照絕不會蓋掉真資料或畫到別的標的上。
  let _gen = 0;
  window._snapInvalidate = function () { _gen++; };
  window._snapPaint = function () {
    const myGen = ++_gen;
    const key = _uiKey();
    _get(key).then(s => {
      try {
        if (myGen !== _gen) return;                                        // 已被真資料/新載入取代
        if (!s || !s.bars || !s.bars.length || !s.wr) return;
        if (Date.now() - (s.at || 0) > 7 * 86400000) return;               // 超過 7 天太舊，不畫
        if (typeof candleSeries === "undefined" || !candleSeries) return;
        if (key !== _uiKey()) return;                                      // 期間又切了標的
        ohlcvData = s.bars;
        if (typeof _rebuildTimeIndex === "function") _rebuildTimeIndex();
        renderAll(ohlcvData);
        const c = s.wr;   // 與 _fetchWinRateNow 快取命中分支同一組層,少一層就是舊標記殘留
        _renderWinRate(c);
        _renderWRSignals(c.signals);
        _renderFVGTrades(c.fvg_trades);
        _renderFVGBB(c.fvg_bb, c.fvg_bb_a, c.fvg_bb_m);
        _renderFVGBreak(c.fvg_break);
        _renderFVGMS(c.fvg_ms);
        _renderFVGShun(c.fvg_shun);
        _renderSMCSweep(c.smc_sweep);
        _renderSMCStruct(c.smc_struct);
        _renderSMCOB(c.smc_ob);
        _renderSMCSR(c.smc_sr);
        _renderCoachVWAP(c.vwap);
        _renderCoachChannel(c.channel);
        if (typeof setFVGZones === "function") setFVGZones(c.fvg);
        _setFVGData(c.fvg);
        window._pdRanges = c.pd_ranges || (c.pd_range ? [c.pd_range] : []);
        if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
        if (typeof showLoading === "function") showLoading(false);   // 圖已可看,收掉載入遮罩(勝率列仍顯示計算中)
      } catch (e) {}
    });
  };
})();
