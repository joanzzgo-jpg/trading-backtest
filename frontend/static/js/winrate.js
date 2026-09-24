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
let _wrCacheLast = null;  // 最近一次套用的勝率資料（_wrRefetchIfMissing 用來判斷缺哪些圖層）
let _wrFetchTimer = null; // 切換標的時 debounce，避免連續觸發後端重算

// proto 缺口(B)最小寬度門檻(decimal)：控制「多/空」「破多空」標記寬鬆度，可切換比較(越大越保守、標記越少)。
// 後端預設 0.0005(0.05%)；改值→cacheKey 帶 pm tag → 後端另分流重算。
let _wrProtoMin = 0.0005;
try { const _pm = parseFloat(localStorage.getItem("wrProtoMin")); if (_pm > 0) _wrProtoMin = _pm; } catch (e) {}
window._PROTO_MIN_STEPS = [0.0005, 0.001, 0.002, 0.003];   // 循環切換值：0.05 / 0.1 / 0.2 / 0.3 %
window._cycleProtoMin = function () {
  const steps = window._PROTO_MIN_STEPS;
  let i = steps.findIndex(v => Math.abs(v - _wrProtoMin) < 1e-9);
  _wrProtoMin = steps[(i + 1) % steps.length];
  try { localStorage.setItem("wrProtoMin", String(_wrProtoMin)); } catch (e) {}
  fetchWinRate();   // 重抓→後端用新門檻重算 多空/破多空（首次該值會重算，之後走快取）
};

// 「不用proto」：多/空 與 破多/破空 的 B 觸發改用正常 3 根 FVG(g+1 確認)取代單根 proto。
// 兩者獨立開關；開→cacheKey 帶 npm/npb tag → 後端各自分流重算。預設關(用 proto)。
let _wrNoProtoMs = false;      // 多/空
let _wrNoProtoBreak = false;   // 破多/破空
try { _wrNoProtoMs = localStorage.getItem("wrNoProtoMs") === "1"; } catch (e) {}
try { _wrNoProtoBreak = localStorage.getItem("wrNoProtoBreak") === "1"; } catch (e) {}
window._toggleNoProtoMs = function (on) {
  _wrNoProtoMs = (on === undefined) ? !_wrNoProtoMs : !!on;
  try { localStorage.setItem("wrNoProtoMs", _wrNoProtoMs ? "1" : "0"); } catch (e) {}
  fetchWinRate();
  return _wrNoProtoMs;
};
window._toggleNoProtoBreak = function (on) {
  _wrNoProtoBreak = (on === undefined) ? !_wrNoProtoBreak : !!on;
  try { localStorage.setItem("wrNoProtoBreak", _wrNoProtoBreak ? "1" : "0"); } catch (e) {}
  fetchWinRate();
  return _wrNoProtoBreak;
};


/* （2026-09-17 刪除）勝率欄的目標切換（中軌/上下軌/8成軌）、停損緩衝輸入、收合鈕、點訊號棒展開盈虧比盒、
   FVG hover 盈虧比盒 —— 對應的 UI 都已不在畫面上（勝率欄整條移除、SS/S1~S12 訊號後端恆為空）。 */

// 公開的進入點：debounced，避免切換標的時連續觸發
function fetchWinRate() {
  clearTimeout(_wrFetchTimer);
  _wrFetchTimer = setTimeout(_fetchWinRateNow, 250);
}

// 新 K 棒收盤 → 清「當前標的」的勝率快取並重抓，讓 FVG/策略標記延伸到最新收盤棒。
//   realtime(fetchLatest)每秒只更新 K 棒、不重算勝率 → FVG 盒凍結在上次抓勝率的時間，
//   看久了最近一段就都沒 FVG(使用者回報)。且 _wrCache 的 key 無時間成分 → 直接 fetchWinRate()
//   會命中舊快取不重算 → 必須先清掉當前 key 才會真的走網路重算(後端 fetch_crt_df crypto 無快取、即時)。
//   debounce 1.5s：新棒事件本就分鐘級、不會頻繁；只是防同一秒多次觸發。
let _wrRefreshTimer = null;
/* 訊號狀態指示（上方左側 #wrFailNote）。三態都要明講 —— 空白會讓「算不出來」長得像
   「這個標的沒有訊號」，那兩件事對回測工具意義天差地遠（claude.md 有專章）。
   ⚠ 只寫狀態、不用提示框（使用者明確表示操作類提示不要）；細節放 title，滑過去看得到。 */
const _WR_STATE_TXT = { calc: "訊號計算中…", ok: "訊號已更新", stale: "訊號未更新", fail: "訊號計算失敗" };
function _wrSetState(st, title) {
  const el = document.getElementById("wrFailNote");
  if (!el) return;                       // 手機/極簡版面可能沒有這個節點
  el.dataset.state = st;
  el.textContent = _WR_STATE_TXT[st] || "";
  el.title = title || (st === "calc"  ? "正在計算這個標的/時框的訊號與標記"
                     : st === "ok"    ? "訊號與標記已依目前標的/時框算好並畫上"
                     : st === "stale" ? "這次請求被中斷（多半是網路斷了一下）→ 圖上的標記可能不是最新的。切換時框或稍後會自動重試。"
                     : "");
}
window._wrSetState = _wrSetState;

window._wrRefreshCurrent = function () {
  clearTimeout(_wrRefreshTimer);
  _wrRefreshTimer = setTimeout(() => {
    if (typeof replayActive !== "undefined" && replayActive) return;
    const market    = document.getElementById("marketSelect")?.value || "crypto";
    const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
    const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
    const timeframe = currentTF || "1d";
    if (!symbol) return;
    const prefix = `${market}:${symbol}:${exchange}:${timeframe}:`;
    for (const k of Object.keys(_wrCache)) if (k.startsWith(prefix)) delete _wrCache[k];
    fetchWinRate();
  }, 1500);
};

// FVG/策略標記「近段窗」階梯：初始用小窗(快)，往歷史滑載入更多 K 棒後升級到更大窗 → 補算舊區標記。
// 回傳能覆蓋目前已載入 K 棒數(+緩衝)的最小階梯值。勝率統計不受 vw 影響。
const _WR_VW_LADDER = [8000, 20000, 45000, 100000, 250000];
function _wrVwFor(loaded) {
  const need = (loaded || 0) + 2000;
  for (const v of _WR_VW_LADDER) if (v >= need) return v;
  return _WR_VW_LADDER[_WR_VW_LADDER.length - 1];
}
window._wrCurVw = 0;   // 目前這份勝率結果算標記用的 vw；背景載入更深時比對是否要升級重取

/* ── 升階「範圍化補抓」：只收差量 ─────────────────────────────────────────────
   往舊滑升 vw 階時，新舊兩份的**近段標記大部分一模一樣**，整包重傳是浪費（BTC 5m 8000→20000
   實測 gzip 470KB，其中一大半前端手上就有）。→ 請求帶 base_h＝手上那份的內容指紋，後端逐筆
   比對後只回「不一樣的筆數 ＋ 一串沿用指令」，實測省 57~67%（470→156KB / 823→355KB）。
   ・內容正確性由後端保證（它算完 ops 會先自我重建驗證，不符就整包回）→ 前端只做拼接。
   ・任何一步不成立（沒 base、指紋對不上、拼接拋錯）→ 丟掉這次回應、改整包重抓一次，
     絕不半套渲染（半套＝「某段沒標記」那類最難察覺的 bug）。 */
// 找一份可當 base 的舊結果：同標的/時框/參數、只有 vw 不同的任一階都行（diff 兩個方向都成立）。
//   ⚠ 不能只認「前一階」：滑得快時 _wrVwFor 會直接跳階（實測 8000→45000），認死前一階就永遠沒 base。
//   偏好「比目前小、且最大的那階」＝重疊最多；沒有就退而取比目前大的最小那階。
function _wrPickBase(cacheKey, vw) {
  const [pre, post] = cacheKey.split(`:vw${vw}:`);
  if (post === undefined) return null;
  let best = null, bestScore = -Infinity;
  for (const k of Object.keys(_wrCache)) {
    if (k === cacheKey || !k.startsWith(pre + ":vw") || !k.endsWith(":" + post)) continue;
    const m = /:vw(\d+):/.exec(k);
    if (!m) continue;
    const v = +m[1];
    const e = _wrCache[k];
    if (!e || !e._h) continue;
    const score = (v < vw) ? v : -v;   // 小的取最大、大的取最小（負值排序自然成立）
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}
function _wrApplyDelta(base, d) {
  if (!base || !d || !d._ops) return null;
  if (d._base !== base._h) return null;      // 指紋對不上＝手上不是後端 diff 的那份
  const out = {};
  for (const k in d) if (k !== "_d" && k !== "_ops" && k !== "_base") out[k] = d[k];
  for (const k in d._ops) {
    const src = base[k];
    if (!Array.isArray(src)) return null;
    const arr = [];
    for (const op of d._ops[k]) {
      if (op[0] === 0) {
        if (op[1] < 0 || op[1] + op[2] > src.length) return null;   // 索引越界＝base 不對，放棄
        for (let i = op[1]; i < op[1] + op[2]; i++) arr.push(src[i]);
      } else {
        for (const z of op[1]) arr.push(z);
      }
    }
    out[k] = arr;
  }
  return out;
}

/* ── 下一階 vw 背景預熱 ────────────────────────────────────────────────────────
   往舊滑時 n 變大 → vw 升階 → 那一次是「冷算」：實測 ~2.5s(之後同 vw 命中僅 16ms)，
   使用者感受到的「越滑越久才出標記」幾乎全來自這一下。→ 在還沒升階前先在背景把下一階算進
   後端快取，真的滑到時就是命中。用 warm=1：後端只回 {ok:true} 幾十 bytes，不吃前端頻寬。
   ・每個 標的|時框|階梯 只預熱一次(_wrWarmed)；切標的/時框自然換 key。
   ・只在「已載根數接近下一階門檻」時觸發(離門檻 <3000 根),避免一進場就亂打。
   ・prio=low + 失敗完全忽略：純粹是加速器，壞掉不影響任何功能。 */
const _wrWarmed = new Set();
function _wrWarmNextTier() {
  try {
    if (typeof ohlcvData === "undefined" || !ohlcvData.length) return;
    const cur = _wrVwFor(ohlcvData.length);
    const idx = _WR_VW_LADDER.indexOf(cur);
    const next = (idx >= 0 && idx + 1 < _WR_VW_LADDER.length) ? _WR_VW_LADDER[idx + 1] : 0;
    if (!next) return;
    // ⚠ 別改成「一進新階就暖下一階」(2026-07-28 試過、更慢):後端沒有同鍵請求合併,預熱會與使用者
    //   自己那次同時算同一份 → 互相搶 CPU,實測使用者那次 2485ms→4381ms,還白算了 7s 的 100000 階。
    //   保守版(接近門檻才暖)實測:暖到的那階 142ms vs 沒暖到的 2485ms。
    if (ohlcvData.length + 2000 < cur * 0.5) return;        // 剛進這階就暖下一階(後端已有 single-flight)
    // 常駐根數被 TRIM_MAX(=40000,見 render.js) 壓住 → 實務上頂到 45000 階;更上面的階暖了也用不到,
    // 卻要付好幾秒後端 CPU(100000 階實測 7s) → 不暖。
    if (next > 45000) return;
    const market = document.getElementById("marketSelect")?.value || "crypto";
    const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
    const exchange = document.getElementById("exchangeSelect")?.value || "binance";
    const timeframe = currentTF || "1d";
    if (!symbol) return;
    const key = `${market}:${symbol}:${exchange}:${timeframe}:vw${next}`;
    if (_wrWarmed.has(key)) return;
    _wrWarmed.add(key);
    // ★參數必須與 _fetchWinRateNow 完全一致,否則暖到別的快取鍵＝白暖(2026-07 預熱 worker 踩過同一坑)
    const p = new URLSearchParams({
      market, symbol, exchange, timeframe,
      vw: String(next),
      proto_min: String(_wrProtoMin), no_proto_ms: _wrNoProtoMs ? "1" : "0",
      no_proto_break: _wrNoProtoBreak ? "1" : "0", warm: "1",
    });
    const _skw = _wrSkipList();                // ★必須與 _fetchWinRateNow 帶一樣的 skip，否則暖到別的形態＝白暖
    if (_skw.length) p.set("skip", _skw.join(","));
    fetch("/api/crt_winrate?" + p, { priority: "low" }).catch(() => {});
  } catch (e) {}
}
window._wrWarmNextTier = _wrWarmNextTier;

/* 「沒在顯示的圖層就不跟後端要」（2026-07-31）。
   這些圖層前端只有在對應開關打開時才畫，而三個開關預設都是關的：
     ・（當年還有教練疊加層 smc_* / channel —— 2026-09-17 隨教練移除，後端也不再計算）
     ・VWAP window._vwapOn → vwap
     ・關鍵高低 window._pdOn → pd_ranges
   實測 BTC 1h 一份回應 546KB 裡它們佔 261KB —— 預設情況下有一半傳輸從頭到尾沒被用到。
   ★開關打開時：_wrNeedRefetch() 會發現快取那份缺這個 key → 觸發重抓完整的（見 _wrRefetchIfMissing）。
   ⚠ 判定不能只看 window._vwapOn（當年還有教練的 _coachOn）：旗標是由 draw.js 從 localStorage 還原的，
     而 draw.js 是延遲載入(requestIdleCallback，最晚 DOMContentLoaded+1200ms)，第一次勝率請求
     不保證排在它後面 → 使用者明明把教練/VWAP 開著，重新整理後第一份回應卻不含這些圖層，
     疊加層空白到手動關再開才回來(靜默、很難察覺)。本機實測餘裕只有 230~440ms，不能賭。
     → 直接讀 localStorage(同一個真相來源、從第一行就讀得到)，旗標只當還沒持久化時的後備。 */
const _wrLsOn = (k, flag) => {
  try { const v = localStorage.getItem(k); if (v != null) return v === "1"; } catch (e) {}
  return flag === true;
};
const _WR_SKIP_GROUPS = [
  [() => _wrLsOn("vwapOverlay",  window._vwapOn),  ["vwap"]],
  [() => window._pdOn === true,                    ["pd_ranges"]],   // 關鍵高低沒有持久化，本來就每次重開都是關的
  // 2026-08-05 移除 signals 的跳過條件：一鍵隱藏鈕已刪，條件永遠成立（＝一律要），
  // 留著只是雜訊。要再省這 19%（gzip 607KB→493KB）得先有新的開關。

  /* 2026-09-12 追加：這幾層前端**預設就是關的**，實測預設情況下佔整份回應 29%
     （gzip 50.8KB / 172.9KB，SUI 1h）—— 換一個沒看過的標的就要多傳這些。
     ⚠ fvg_trades / fvg_bb* 連 UI 開關都沒有（只剩 window.toggleFVGxx 可從主控台開），
       fvg_special 已從圖例移除、永久隱藏 → 平常一律不送；真的打開時各自的 toggle
       會呼叫 _wrRefetchIfMissing() 補抓完整版。
     ⚠ fvg_shun 讀 localStorage 的圖例狀態（不是讀旗標）：旗標要等 loadVisibilityPrefs
       點過圖例才會變，第一份請求不保證排在它後面 —— 同教練/VWAP 那兩條的理由。 */
  //   ⚠ 兩個來源取「或」：圖例點下去時 saveVisibilityPrefs 是在 toggle **之後**才寫
  //     localStorage → 只讀 localStorage 的話，剛打開那一刻仍是舊值＝不會補抓（實測踩到）。
  //     旗標(_fvgShunHidden)是當下的真相；localStorage 負責「還沒點過圖例」的開機那一刻。
  [() => window._fvgShunHidden !== true || _wrLegOn("legFVGShun", false), ["fvg_shun"]],
  [() => window._fvgTradesHidden !== true,          ["fvg_trades"]],
  [() => (window._fvgBBHideD !== true || window._fvgBBHideA !== true
          || window._fvgBBHideM !== true),          ["fvg_bb", "fvg_bb_a", "fvg_bb_m"]],
  [() => window._fvgSpecialHidden !== true,         ["fvg_special"]],
  // fvg_sigs：前端沒有任何消費者（自動交易是後端 notify_monitor 自己算的）→ 一律不送。
  [() => false,                                     ["fvg_sigs"]],
];
/* 圖例的顯示狀態（hiddenLegs 存的是「被關掉」的 id）。沒有這筆記錄（第一次造訪）→ 用預設值。 */
const _wrLegOn = (id, defOn) => {
  try {
    const raw = localStorage.getItem("hiddenLegs");
    if (raw != null) return !JSON.parse(raw).includes(id);
  } catch (e) {}
  return defOn === true;
};
function _wrSkipList() {
  const out = [];
  for (const [needed, keys] of _WR_SKIP_GROUPS) {
    let on = false;
    try { on = needed(); } catch (e) { on = true; }   // 判斷不了就當「要」，寧可多送不要少送
    if (!on) out.push(...keys);
  }
  return out;
}
/* 某個圖層剛被打開 → 手上那份若缺它就重抓。由各開關的 toggle 呼叫（window 導出）。 */
function _wrRefetchIfMissing() {
  try {
    const c = _wrCacheLast;
    if (!c) { if (typeof fetchWinRate === "function") fetchWinRate(); return; }
    const need = [];
    for (const [needed, keys] of _WR_SKIP_GROUPS) {
      let on = false;
      try { on = needed(); } catch (e) {}
      if (on) need.push(...keys);
    }
    if (!need.some(k => c[k] === undefined)) return;   // 該有的都在 → 不必重抓
    _wrCache = {};                                     // 各階快取都是「缺圖層」的形態 → 全部作廢
    if (typeof fetchWinRate === "function") fetchWinRate();
  } catch (e) {}
}
window._wrRefetchIfMissing = _wrRefetchIfMissing;

let _wrFetchCtrl = null;   // 切標的時取消舊勝率請求
let _wrInFlight = false;   // 勝率請求飛行中(加速器預熱讓路用;完成/失敗於 finally 清除)
async function _fetchWinRateNow() {
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) return;
  // 換一次請求（含快取命中）就先清掉上一次的「訊號計算失敗」：快取命中那條會提早 return，
  // 不在這裡清的話，標記其實已經正常顯示、上方卻還掛著失敗（誤導）。
  _wrSetState("calc");
  // 台指期（TXF/MXF/TMF）現在後端 fetch_crt_df 已接 futopt 資料（cnyes即時+自建DB歷史/期貨日線）
  //  → 照常打 /api/crt_winrate 算 FVG/策略（勝率統計視資料深度而定，標記照畫；期貨可做空）。
  const _vw = _wrVwFor(typeof ohlcvData !== "undefined" ? ohlcvData.length : 0);
  window._wrCurVw = _vw;
  const cacheKey = `${market}:${symbol}:${exchange}:${timeframe}:vw${_vw}:pm${_wrProtoMin}:npm${_wrNoProtoMs ? 1 : 0}:npb${_wrNoProtoBreak ? 1 : 0}`;
  if (_wrCache[cacheKey]) {
    // 快取命中也要取消上一個還在飛的勝率請求，否則它稍後成功回來會用「舊標的」的
    // 圖層資料覆寫回去 → 標記時間不存在於新標的 ohlcv → markers 全被過濾 → 策略不顯示。
    if (_wrFetchCtrl) { _wrFetchCtrl.abort(); _wrFetchCtrl = null; }
    const c = _wrCache[cacheKey];
    _wrCacheLast = c;
    // 快取命中也要把「這個標的」的 FVG/SMC 各層重繪回來——否則沿用上一個標的的舊標記
    // （例：BTC→SOL→BTC 切回來，主圖 FVG 多/空、破多/破空還是 SOL 的 → 大段沒有標記/位置亂掉）
    _renderFVGTrades(c.fvg_trades);
    _renderFVGBB(c.fvg_bb, c.fvg_bb_a, c.fvg_bb_m);
    _renderFVGBreak(c.fvg_break);
    _renderFVGMS(c.fvg_ms);
    _renderFVGShun(c.fvg_shun);
    _renderFVGSpecial(c.fvg_special);
    _renderCoachVWAP(c.vwap);         // VWAP（教練已移除；VWAP 獨立開關仍讀這份資料）
    if (typeof setFVGZones === "function") setFVGZones(c.fvg);
    window._pdRanges = c.pd_ranges || (c.pd_range ? [c.pd_range] : []);
    if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    _wrSetState("ok", "訊號與標記已算好並畫上（這次是本機快取命中，沒有重算）");
    return;
  }
  // 取消上次未完成的勝率請求
  if (_wrFetchCtrl) _wrFetchCtrl.abort();
  _wrFetchCtrl = new AbortController();
  _wrInFlight = true;                    // 加速器讓路用(fetch 完成/失敗都會在 finally 清)
  const myCtrl = _wrFetchCtrl;
  const timeoutId = setTimeout(() => myCtrl.abort(), 45000);   // 勝率計算較重，45s 上限
  // 失敗提示寫在上方左側的 #wrFailNote（2026-09-17 勝率欄 #wrStatus 隨整條勝率列刪除）
  const statusEl = document.getElementById("wrFailNote");
  try {
    // 升階差量：手上有「前一階」且帶指紋 → 請後端只回差量（見上方 _wrApplyDelta 註解）
    const _prev = _wrPickBase(cacheKey, _vw);
    const _baseH = (_prev && _prev._h) ? _prev._h : "";
    const _q = { market, symbol, exchange, timeframe, vw: String(_vw), proto_min: String(_wrProtoMin), no_proto_ms: _wrNoProtoMs ? "1" : "0", no_proto_break: _wrNoProtoBreak ? "1" : "0" };
    const _sk = _wrSkipList();                 // 目前用不到的圖層 → 請後端別送（見 _WR_SKIP_GROUPS）
    if (_sk.length) _q.skip = _sk.join(",");
    if (_baseH) _q.base_h = _baseH;
    const p   = new URLSearchParams(_q);
    const res = await fetch("/api/crt_winrate?" + p, { signal: myCtrl.signal, cache: "no-cache" });
    let d     = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    if (d && d._d) {
      const merged = _wrApplyDelta(_prev, d);
      if (!merged) {
        // 拼不起來（base 被淘汰/指紋不符）→ 整包重抓一次，絕不半套渲染
        if (myCtrl !== _wrFetchCtrl) return;
        const _q2 = { ..._q }; delete _q2.base_h;
        const r2 = await fetch("/api/crt_winrate?" + new URLSearchParams(_q2), { signal: myCtrl.signal, cache: "no-cache" });
        d = await r2.json();
        if (!r2.ok) throw new Error(d.detail || "failed");
      } else {
        d = merged;
      }
    }
    _wrCacheSet(cacheKey, d);   // 結果照常進快取，下次切回直接命中
    // 世代守衛：成功回來時若已被更新的請求 / 快取命中取代，丟棄此陳舊結果，
    // 否則舊標的的訊號會覆寫當前標的 → markers 全被過濾 → 切標的後策略消失。
    if (myCtrl !== _wrFetchCtrl) return;
    if (typeof window._snapSave === "function") window._snapSave(d);   // 本機快照(開app秒出圖,見檔尾模組)
    _wrCacheLast = d;
    _wrSetState("ok");            // ⚠ 要在世代守衛之後：被新請求取代的舊結果不可以宣告「已更新」
    _renderFVGTrades(d.fvg_trades);   // FVG「接1次」進出場標記（主圖）
    _renderFVGBB(d.fvg_bb, d.fvg_bb_a, d.fvg_bb_m);   // FVG 進出場標記:D(青/粉)+A(橘/紫)+M中軌分側順勢(黃/藍)（研究·主圖）
    _renderFVGBreak(d.fvg_break);     // 破多/破空 結構轉破（proto 缺口序列、標在 g）（主圖）
    _renderFVGMS(d.fvg_ms);           // 多/空方向標記:吃 setup FVG 後窗內首次同向 proto 缺口 B（標在 g）（主圖）
    _renderFVGShun(d.fvg_shun);       // 順多/順空:吃同向FVG後影線穿透既存反向FVG（主圖）
    _renderFVGSpecial(d.fvg_special); // 特多/特空:多空/破多空序列 A→B→C 三連市場結構（標在 C）（主圖）
    _renderCoachVWAP(d.vwap);         // VWAP（教練已移除；VWAP 獨立開關仍讀這份資料）
    if (typeof setFVGZones === "function") setFVGZones(d.fvg);
    window._pdRanges = d.pd_ranges || (d.pd_range ? [d.pd_range] : []);   // 每段歷史折價/溢價區(主圖畫)
    if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  } catch(e) {
    // Abort / TypeError(Failed to fetch) / 被新請求取代 → 全部視為中斷，靜默（不記 console.error，
    //   否則快速連切標的/時框時會刷一排「AbortError」紅字雜訊——那是預期的取消，非錯誤）
    const isAbortLike = e.name === "AbortError"
                     || myCtrl.signal.aborted
                     || /failed to fetch/i.test(e.message || "")
                     || myCtrl !== _wrFetchCtrl;
    if (!isAbortLike) {
      console.error("[fetchWinRate] error:", e.name, e.message);
      /* ★ 2026-08-20：原本只寫「—」。實測把 /api/crt_winrate 擋成 503 → 標記全清成 0、
         HUD 顯示「—」、畫面上**沒有任何其他跡象** —— 跟「這個標的真的沒有訊號」完全分不出來。
         對回測工具來說這兩件事意義天差地遠（「算不出來」vs「這裡沒機會」），而且是本專案
         已經認定最危險的那個形狀：靜默地給一個看起來正常的答案（同 `行情中斷` 那條）。
         ⚠ 不用提示框（使用者明確表示操作類提示不要）→ 就地把狀態寫清楚＋滑過去看得到原因。 */
      _wrSetState("fail", `無法取得訊號/勝率（${e.name}: ${e.message || ""}）。`
                        + "圖上沒有標記是因為算不出來，不是這個標的沒有訊號。切換時框或稍後會自動重試。");
      _applyMainMarkers();
    }
  } finally {
    clearTimeout(timeoutId);
    if (myCtrl === _wrFetchCtrl) {
      _wrInFlight = false;   // 只有最新請求結束才視為「沒請求在飛」
      /* ★ 保證狀態不會卡在「計算中…」：abort-like（含網路斷線的 Failed to fetch）是**靜默**路徑
         （claude.md：整段斷網由 netOffline/tkStale 負責報，這裡不重複報）——
         但既然現在會常駐顯示狀態，停在「計算中」就是**宣稱有事在做卻沒有**，比空白更誤導。
         → 收尾時若仍是 calc 且自己還是最新那個請求，改寫成中性的「訊號未更新」（不是紅字告警）。
         ⚠ 被新請求取代時不可以動（myCtrl !== _wrFetchCtrl）：那時狀態屬於新請求。 */
      const _el = document.getElementById("wrFailNote");
      if (_el && _el.dataset.state === "calc") _wrSetState("stale");
    }
  }
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
  _wrRefetchIfMissing();   // 這三層預設不跟後端要（見 _WR_SKIP_GROUPS）→ 打開時補抓
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
/* 這兩層沒有 UI 開關（研究用/已移除），但旗標可以從主控台改 →
   給一個正式的 toggle，改旗標時順便補抓，不然打開了卻沒有資料（靜默空白）。 */
window.toggleFVGTrades = function (on) {
  window._fvgTradesHidden = (on === undefined) ? !window._fvgTradesHidden : !on;
  _applyMainMarkers(); _wrRefetchIfMissing();
  return !window._fvgTradesHidden;
};
window.toggleFVGSpecialLayer = function (on) {
  window._fvgSpecialHidden = (on === undefined) ? !window._fvgSpecialHidden : !on;
  _applyMainMarkers(); _wrRefetchIfMissing();
  return !window._fvgSpecialHidden;
};
window.toggleFVGShun = function (on) {
  window._fvgShunHidden = (on === undefined) ? !window._fvgShunHidden : !on;
  _applyMainMarkers();
  _wrRefetchIfMissing();      // 這層預設不跟後端要（見 _WR_SKIP_GROUPS）→ 打開時補抓
  return !window._fvgShunHidden;
};

// 特多/特空方向標記：多空/破多空序列 A→B→C 三連市場結構（標在 C；特多=棒下金↑、特空=棒上紫↓）
function _renderFVGSpecial(items) {
  if (items !== undefined) _lastFVGSpecial = items || [];
  const hasIdx = (typeof _secToIdx !== "undefined" && _secToIdx.size > 0);
  const chartTimeSet = hasIdx ? null : new Set(ohlcvData.map(d => toTime(d.time)));
  const _has = t => hasIdx ? _secToIdx.has(t) : chartTimeSet.has(t);
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  const out = [];
  for (const it of (_lastFVGSpecial || [])) {
    const tm = toTime(it.t);
    if (!_has(tm) || (_rpCut != null && tm > _rpCut)) continue;
    if (it.d === "l") {
      out.push({ time: tm, position: "belowBar", color: "#ffd11a",
                 shape: "arrowUp", size: 2, text: "特多" });
    } else {
      out.push({ time: tm, position: "aboveBar", color: "#c04cff",
                 shape: "arrowDown", size: 2, text: "特空" });
    }
  }
  out.sort((a, b) => a.time - b.time);
  lastFVGSpecialMarkers = out;
  _applyMainMarkers();
}
window._renderFVGSpecial = _renderFVGSpecial;
// 開關：window.toggleFVGSpecial() 切換特多/特空標記顯示
window.toggleFVGSpecial = function (on) {
  window._fvgSpecialHidden = (on === undefined) ? !window._fvgSpecialHidden : !on;
  _applyMainMarkers();
  return !window._fvgSpecialHidden;
};

// 策略止損線（hover 顯示）已移除（2026-08-03，使用者要求）。
// 這張 time → {sl,tp} 的對照表只餵那條線，沒有其他消費者 → 一併停止建立。
//   ⚠ 保留這個空函式與空 Map：render.js 的 _applyMainMarkersNow 每次全量重建標記都會呼叫
//     window._rebuildStratSL()，直接刪掉會變成 undefined 呼叫。留空殼最省事也最安全。
//   （後端仍會帶 sl/tp 欄位 —— 那是 charts.js「點選缺口才顯示交易位階線」在用，不受影響。）
window._stratSlByTime = new Map();
window._rebuildStratSL = function () {};

// VWAP 資料：存給畫布層（draw.js _drawVWAP，獨立開關 _vwapOn）。
//   ⚠ 2026-09-17 SR+SMC 教練整個移除，這支**刻意保留**：VWAP 還在用，名稱沿用避免牽動
//     勝率快取守門員（check_wr_cache_layers 從本檔抽圖層變數）。
function _renderCoachVWAP(items) {
  window._coachVWAP = items || [];
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
}
window._renderCoachVWAP = _renderCoachVWAP;

// （2026-09-17 SR+SMC 多空教練面板與其輪詢已移除。）

/* （2026-09-17 刪除）勝率欄填值 _renderWinRate、S/SS 系列切換、十字線 hover 勝率小卡與手機輪播、
   「勝率 ▾」收合列 _renderWrTop3 —— 對應元素隨勝率欄整條移除。 */

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
  for (const w of _accelCandidates()) {
    const mkt = w.market || "crypto", exch = w.exchange || "pionex";
    const key = `${mkt}:${w.symbol}:${exch}:${timeframe}:${_wrProtoMin}:${_wrNoProtoMs ? 1 : 0}:${_wrNoProtoBreak ? 1 : 0}`;
    if (Date.now() - (_accelDone[key] || 0) < 25 * 60 * 1000) continue;   // 後端快取~30分 → 25分內不重打
    _accelDone[key] = Date.now();
    try {
      const p = new URLSearchParams({ market: mkt, symbol: w.symbol, exchange: exch, timeframe,
        vw: "8000", proto_min: String(_wrProtoMin),
        no_proto_ms: _wrNoProtoMs ? "1" : "0", no_proto_break: _wrNoProtoBreak ? "1" : "0" });
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
  /* 最近 N 個(標的×時框)快照。2026-09-24 由 12 放大到 30：原本只快取「當前標的的常用時框」,
     現在還要容納自選(最多 8 檔)與停留前 3 名 —— 留 12 的話它們會互相踢掉,等於白抓。
     一筆約 1500 根 K 棒 + 整份勝率 ≈ 0.2MB → 30 筆約 6MB,IndexedDB 吃得下。 */
  const MAX_SNAPS = 30;
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
        /* ★ 2026-09-24：容許「只有 K 棒、沒有勝率」的快照。
           自選／常看清單的預抓只抓 K 棒（勝率 payload 單筆 101~222KB，抓一輪要 700KB，
           而使用者要的是「歷史資料存在裝置」，不是勝率）→ 這種快照照樣要能秒畫出 K 棒，
           標記層就讓它照常走網路。⚠ 沒有 wr 時**整段圖層渲染要跳過**，不可以拿 undefined
           去餵 _render*：那會把既有圖層清掉（＝「切標的後標記消失」那類 bug 的反面）。 */
        if (!s || !s.bars || !s.bars.length) return;
        if (Date.now() - (s.at || 0) > 7 * 86400000) return;               // 超過 7 天太舊，不畫
        if (typeof candleSeries === "undefined" || !candleSeries) return;
        if (key !== _uiKey()) return;                                      // 期間又切了標的
        ohlcvData = s.bars;
        if (typeof _rebuildTimeIndex === "function") _rebuildTimeIndex();
        renderAll(ohlcvData);
        if (!s.wr) {                                   // 只有 K 棒的快照：畫完就好，標記等網路
          if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
          if (typeof showLoading === "function") showLoading(false);
          return;
        }
        const c = s.wr;   // 與 _fetchWinRateNow 快取命中分支同一組層,少一層就是舊標記殘留
        _wrCacheLast = c;
        _renderFVGTrades(c.fvg_trades);
        _renderFVGBB(c.fvg_bb, c.fvg_bb_a, c.fvg_bb_m);
        _renderFVGBreak(c.fvg_break);
        _renderFVGMS(c.fvg_ms);
        _renderFVGShun(c.fvg_shun);
        _renderFVGSpecial(c.fvg_special);
        _renderCoachVWAP(c.vwap);
        if (typeof setFVGZones === "function") setFVGZones(c.fvg);
        window._pdRanges = c.pd_ranges || (c.pd_range ? [c.pd_range] : []);
        if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
        if (typeof showLoading === "function") showLoading(false);   // 圖已可看,收掉載入遮罩(勝率列仍顯示計算中)
      } catch (e) {}
    });
  };

  // ══ 背景預抓「當前標的的常用時框」→ 存成快照 → 切時框接近 TV 的瞬間 ══
  //   當你在看 BTC/ETH/XAUT,idle 時偷偷把它其他常用時框的 K棒+勝率抓好 _put 成快照;
  //   之後切過去 _snapPaint 秒畫(再由真資料更新)。只對這三個高頻標的做,避免濫抓。
  /* ★ 2026-09-24 使用者：「如果一個使用者常常打開只看 a,b 等標的，就設計成下載歷史資料
     在該使用者的裝置，這樣歷史 api 不用另外打」。
     原本這裡寫死 ["BTC/USDT","ETH/USDT","XAUT/USDT"] 且 `market !== "crypto"` 直接 return
     → **台股／美股／港股整個被排除在外**，而且不管使用者實際在看什麼。
     改成「看這台裝置上你**真的花時間在看**的前幾名」——
     ⚠ 用**停留時間**不用「開啟次數」：翻找標的時會連續點開十幾檔，用次數會把「隨手點過」
       算成常用；而 _prefetchTick 本來就每 6 秒跑一次，直接在這裡累計＝零額外掛勾、零熱路徑成本。
     ⚠ 請求量**完全不變**：照樣 idle 才抓、每個 tick 最多抓一個、只抓「當前標的」的其他時框。
       變的只是「誰有資格」，所以不會多打後端。
     ⚠ 分數要衰減，否則三個月前的習慣會永遠佔著前三名。 */
  const _USE_KEY = "symUse";        // 裝置本地（在 _ACCT_SKIP 裡，不上雲端：手機/電腦看的東西本來就不同）
  const _USE_TOP = 3;               // 只讓前 3 名有資格 —— 維持今天的請求量級
  const _USE_DECAY = 0.995;         // 每次記分全體衰減，約 140 個 tick（≈14 分鐘）半衰
  const _USE_MAX = 40;              // 表格上限，避免無限長大
  function _useLoad() {
    try { const o = JSON.parse(localStorage.getItem(_USE_KEY) || "{}"); return (o && typeof o === "object") ? o : {}; }
    catch (e) { return {}; }
  }
  function _useBump(k) {
    const o = _useLoad();
    for (const x in o) o[x] *= _USE_DECAY;
    o[k] = (o[k] || 0) + 1;
    const ks = Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, _USE_MAX);
    const out = {}; for (const x of ks) if (o[x] > 0.05) out[x] = Math.round(o[x] * 1000) / 1000;
    try { localStorage.setItem(_USE_KEY, JSON.stringify(out)); } catch (e) {}
    return out;
  }
  function _useTop(o) {
    return Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, _USE_TOP);
  }
  /* 時框也用同一套「學這台裝置真的在用什麼」。
     ★ 為什麼要有這個：勝率 payload 很大（實測 4h 222KB／1h 123KB／15m 108KB／5m 101KB），
       把「正在看的那一檔」的 5 個時框全預抓要 **581KB** —— 跟整個冷載同一個量級。
       以前只有 3 檔寫死的加密會觸發所以沒人在意；改成「你常看的標的」之後變成人人有份。
     → 只對**你真的用過的時框**抓勝率（前 2 名），其餘只抓 K 棒。
       只看日線的人從此一毛都不必付；常在 1h/4h 之間切的人照樣秒開。
     ⚠ 用「真的切過去看」當訊號，不是猜「相鄰時框」—— 猜的話對只看日線的人永遠是錯的。 */
  const _TFU_KEY = "tfUse", _TFU_TOP = 2;
  function _tfBump(tf) {
    if (!tf) return {};
    let o = {};
    try { o = JSON.parse(localStorage.getItem(_TFU_KEY) || "{}") || {}; } catch (e) { o = {}; }
    for (const x in o) o[x] *= _USE_DECAY;
    o[tf] = (o[tf] || 0) + 1;
    const out = {};
    for (const x of Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, 8))
      if (o[x] > 0.05) out[x] = Math.round(o[x] * 1000) / 1000;
    try { localStorage.setItem(_TFU_KEY, JSON.stringify(out)); } catch (e) {}
    return out;
  }
  const _tfTop = o => Object.keys(o).sort((a, b) => o[b] - o[a]).slice(0, _TFU_TOP);
  const _PREFETCH_TFS = ["1d", "4h", "1h", "15m", "5m"];
  const _preDone = {};   // key → 時戳,避免同一 key 反覆抓(5 分鐘內不重抓)
  const _WL_MAX = 8;     // 自選最多預抓前 8 檔：20 檔 ×5 時框 ×(K棒+勝率) 會排出上百個請求
  const _SNAP_FRESH = 6 * 60 * 60 * 1000;            // 快照 6 小時內算新鮮，不重抓
  function _wlForPrefetch() {
    try {
      const wl = JSON.parse(localStorage.getItem("watchlist") || "[]");
      if (!Array.isArray(wl)) return [];
      return wl.filter(w => w && w.symbol).slice(0, _WL_MAX).map(w => ({
        market: w.market || "crypto", symbol: String(w.symbol).trim(),
        exchange: w.exchange || w.exch || "pionex",
      }));
    } catch (e) { return []; }
  }
  async function _hasFreshSnap(key) {
    const v = await _get(key);
    return !!(v && v.at && Date.now() - v.at < _SNAP_FRESH);
  }
  async function _prefetchTF(market, symbol, exchange, tf, withWr) {
    const key = [market, symbol, exchange, tf].join("|");
    if (Date.now() - (_preDone[key] || 0) < 5 * 60 * 1000) return;
    _preDone[key] = Date.now();
    try {
      // K 棒(近段預設量,秒切夠用;真資料到貨會補深)
      const oRes = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, symbol, timeframe: tf, exchange, limit: 500, indicators: false }),
      });
      if (!oRes.ok) return;
      const oj = await oRes.json();
      const bars = oj.data;
      if (!bars || !bars.length) return;
      /* 只抓 K 棒就收工（自選／常看清單走這條）。實測勝率 payload 單筆 101~222KB，
         抓滿一輪 700KB —— 跟整個冷載同一個量級，不該替使用者付。 */
      if (!withWr) {
        await _put(key, { key, bars: bars.slice(-1500), at: Date.now() }).catch(() => {});
        return;
      }
      // 勝率(vw=8000＝首屏視窗;切過去初次 fetchWinRate 同 vw → 快照與之對得上)
      const p = new URLSearchParams({ market, symbol, exchange, timeframe: tf,
        vw: "8000", proto_min: String(typeof _wrProtoMin !== "undefined" ? _wrProtoMin : 0.0005),
        no_proto_ms: (typeof _wrNoProtoMs !== "undefined" && _wrNoProtoMs) ? "1" : "0",
        no_proto_break: (typeof _wrNoProtoBreak !== "undefined" && _wrNoProtoBreak) ? "1" : "0" });
      const wRes = await fetch("/api/crt_winrate?" + p, { cache: "no-cache" });
      if (!wRes.ok) return;
      const wr = await wRes.json();
      await _put(key, { key, bars: bars.slice(-1500), wr, at: Date.now() }).catch(() => {});
    } catch (e) {}
  }
  /* ⚠ 省流量／慢網路不預抓（2026-09-24 改成「任何常看的標的」之後才需要這道）：
     以前只有 3 檔加密會觸發，現在你待著的任何標的都會 → 一檔約 5 個時框 ×（K棒+勝率）≈ 275KB。
     桌面沒差，但行動網路上那是替使用者做的決定。`saveData` 是使用者自己開的「資料節省」，
     2g/3g 則是連首屏都還在吃力的情況 —— 兩者都直接跳過，功能不壞，只是少了秒切。 */
  function _prefetchAllowed() {
    try {
      const c = navigator.connection;
      if (!c) return true;                       // 不支援就當可以（桌面 Safari/Firefox）
      if (c.saveData) return false;
      return !/(^|-)(2g|slow-2g|3g)$/.test(c.effectiveType || "");
    } catch (e) { return true; }
  }
  async function _prefetchTick() {
    if (document.hidden) return;
    if (!_prefetchAllowed()) return;
    if (typeof replayActive !== "undefined" && replayActive) return;
    if (typeof _wrInFlight !== "undefined" && _wrInFlight) return;       // 使用者的勝率請求優先,不搶
    if (typeof _bgLoadInProgress !== "undefined" && _bgLoadInProgress) return;
    const _n = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (window._chartMoveTs && _n - window._chartMoveTs < 3000) return;  // 剛互動過→讓路
    const market = document.getElementById("marketSelect")?.value || "crypto";
    const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
    const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
    if (!symbol) return;
    const score = _useBump([market, symbol, exchange].join("|"));   // 標的停留計分
    const tfScore = _tfBump((typeof currentTF !== "undefined" && currentTF) ? currentTF : "");
    const wrTfs = _tfTop(tfScore);                                  // 只有這幾個時框值得連勝率一起抓

    /* 優先序（2026-09-24 使用者：「加入自選的必要做優先歷史載入下載」）：
         ① 你**正在看**的標的的其他時框 —— 切時框是最即時的回饋，先顧這個
         ② **自選**裡還沒有快照的標的（各抓 1 個時框）—— 使用者明確標記要盯的
         ③ 停留分數前 3 名裡還沒有快照的
       ⚠ 每個 tick 還是**只抓一個**、idle 才抓、省流量模式不抓 → 請求「速率」完全沒變，
         變的只是排隊順序與涵蓋範圍。
       ⚠ ②③ 只抓**一個時框**（你最後在看的那個）：整組 5 個時框只對「正在看的那一檔」做，
         否則一個 20 檔的自選會排出 100 個請求。 */
    const curTf = (typeof currentTF !== "undefined" && currentTF) ? currentTF : "1d";
    const jobs = [];
    // ① 正在看的：其他常用時框
    for (const tf of _PREFETCH_TFS) {
      // 正在看的那一檔：**你用過的時框**才連勝率一起（切過去要秒開），其餘只抓 K 棒
      if (tf !== curTf) jobs.push([market, symbol, exchange, tf, wrTfs.includes(tf)]);
    }
    // ② 自選（依清單順序＝使用者自己排的優先序），最多 _WL_MAX 檔
    for (const w of _wlForPrefetch()) {
      if (w.symbol === symbol && w.market === market) continue;     // 正在看的已在 ① 裡
      jobs.push([w.market, w.symbol, w.exchange, curTf, false]);           // 自選：只要歷史 K 棒
    }
    // ③ 停留分數前 3 名
    for (const k of _useTop(score)) {
      const [m2, s2, e2] = k.split("|");
      if (s2 === symbol && m2 === market) continue;
      jobs.push([m2, s2, e2, curTf, false]);                               // 常看的：只要歷史 K 棒
    }
    for (const [m, sy, ex, tf, wr] of jobs) {
      if (!sy) continue;
      const key = [m, sy, ex, tf].join("|");
      if (Date.now() - (_preDone[key] || 0) < 5 * 60 * 1000) continue;
      if (await _hasFreshSnap(key)) continue;        // 已經有快照就不重抓
      await _prefetchTF(m, sy, ex, tf, wr);
      break;                                          // 一個 tick 只抓一個，不轟後端
    }
  }
  // 進場穩定後開始,每 6 秒抓一個(idle 才抓、一次一個);與加速器錯開
  setTimeout(() => { setInterval(_prefetchTick, 6000); }, 18000);
})();
