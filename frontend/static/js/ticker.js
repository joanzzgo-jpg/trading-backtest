let _watchlist = [];
// key: "market:exchange:symbol" → {price, change_pct, volume, ts}
// ★ 2026-08-15 使用者：「美股的自選一樣要繃一下才有」。原因有兩個，兩個都修：
//   ①價只在「點進自選那一刻」才開始抓 → 第一次一定看到 `---`，要等一趟網路。
//     → 開機後就先抓一次（見 _wlPrefetch），你點進去時多半已經有了。
//   ②快取只在記憶體 → 重新整理就全空，每次都要重繃一次。
//     → 存進 localStorage，開頁就先用上次的值填上（畫面立刻有東西），新值到了再蓋掉。
//   ⚠ 存起來的值會標 ts，讀回來時**不當成新鮮的**（照樣會被下一輪更新蓋掉），
//     只是讓畫面不要空白 —— 跟主圖的本機快照秒畫同一個思路。
const _WL_CACHE_KEY = "_wlpx";
let _wlPriceCache = (() => {
  try {
    const o = JSON.parse(localStorage.getItem(_WL_CACHE_KEY) || "{}");
    return (o && typeof o === "object") ? o : {};
  } catch (e) { return {}; }
})();
function _wlCacheSave() {
  try { localStorage.setItem(_WL_CACHE_KEY, JSON.stringify(_wlPriceCache)); } catch (e) {}
}
function _loadWatchlist() {
  try { _watchlist = JSON.parse(localStorage.getItem("watchlist") || "[]"); } catch { _watchlist = []; }
}
function _saveWatchlist() {
  try { localStorage.setItem("watchlist", JSON.stringify(_watchlist)); } catch {}
  // 自選走「寫穿伺服器」當唯一真相 → 多裝置/換裝置即時一致，不被整包快照 last-write-wins 蓋掉。
  if (window._acctSaveWatch) window._acctSaveWatch(_watchlist);
}
// 給帳號模組在「登入 / 切回前景拉到雲端最新自選」後即時刷新清單
window._acctReloadWatch = function () { _loadWatchlist(); _renderWatchlist(); };
function _renderWatchlist() {
  renderTickers();   // wl tab 在 renderTickers 內處理，其餘 tab 更新星號狀態
  _updateStarBtn();
}

function _toggleWatchlist(symbol, market, exchange) {
  const key = `${market}:${exchange || ""}:${symbol}`;
  const idx = _watchlist.findIndex(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  if (idx >= 0) {
    _watchlist.splice(idx, 1);
  } else {
    _watchlist.unshift({ market, symbol, exchange });
  }
  _saveWatchlist();
  _renderWatchlist();  // calls renderTickers() internally
}
let _tickerData     = [];
let _spotTickerData = [];
let _twTickerData   = [];   // 含台指期三兄弟（後端 /api/tickers?market=tw 已置頂 is_future 列）
// 記住使用者選的市場分頁與排序（重刷新/下次回來還原）
let _tickerMkt      = (() => { try { return localStorage.getItem("tkMkt") || "crypto"; } catch (e) { return "crypto"; } })();   // "crypto" | "tw"
let _tickerSort     = (() => { try { return localStorage.getItem("tkSort") || "desc"; } catch (e) { return "desc"; } })();      // desc=漲幅 asc=跌幅 vol=量 wl=自選
let _tickerTimer    = null;
let _lastTickerKey  = "";        // 追蹤目前渲染的 ticker 結構，避免不必要的 DOM 重建
let _lastPageTitle  = "";        // 快取上次 title，避免重複寫 DOM
let _kbNavLockUntil = 0;         // 鍵盤導航凍結期：使用者用 ↑↓ 切標的時不重排清單，避免每 2 秒重排讓位置在腳下變動

// 鍵盤導航時呼叫：凍結清單順序 120 秒，避免使用者「按一下→停頓看盤(常 15 秒甚至 1 分鐘)→再按」時
//   清單在腳下依漲跌幅重排→剛選標的位置大洗牌→再按↓跳到很遠標的、scrollIntoView 把清單捲回最上面。
//   每次按鍵重新計時。凍結只在鍵盤導航時啟動(不影響一般使用者即時排序)；期間價格仍就地更新、只是不重排。
function _markKbNav() { _kbNavLockUntil = Date.now() + 120000; }
window._markKbNav = _markKbNav;

// ── 行情列漸進渲染（不卡）─────────────────────────────────────
// 合約/台股清單常有 500~1000+ 檔，全塞進 DOM → 上萬節點 → style/layout 重算爆量、
// 主圖平移與切分頁全被拖慢。改為只渲染前 N 列（依現有排序＝最相關），捲到底再加載一批。
// 每秒價格更新只需更新這 N 列 → 每秒重繪成本同步下降。
const _TK_CAP_STEP = 120;
let _tkCap    = _TK_CAP_STEP;   // 目前渲染上限（捲到底 +STEP）
let _tkCapKey = "";             // 市場|排序|搜尋 變了就重置上限（回到頂端）
// 依目前上限切片 items；記錄是否還有更多（供捲動加載判斷）。標題/分組列不吃上限。
function _tkSlice(items) {
  const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
  const key = `${_tickerMkt}|${_tickerSort}|${search}`;
  if (key !== _tkCapKey) { _tkCapKey = key; _tkCap = _TK_CAP_STEP; }
  window._tkHasMore = items.length > _tkCap;
  return items.length > _tkCap ? items.slice(0, _tkCap) : items;
}
// 鍵盤 ↑↓ 導航到清單底(cap 邊界)時：載入下一批再繼續 → 不會因 cap 讓 ↑↓ 卡在第 120 列或繞回第一個。
window._tkGrowMore = function () {
  if (!window._tkHasMore) return false;
  _tkCap += _TK_CAP_STEP;
  _lastTickerKey = "";
  if (typeof renderTickers === "function") renderTickers();
  return true;
};

// ── 搜尋欄鍵盤導航（↑↓ 選列、Enter 載入該標的）──────────────
let _tkSearchFocusIdx = -1;
function _tkRows() { return document.querySelectorAll("#tickerList .ticker-item"); }
function _tkHighlight() {
  const rows = _tkRows();
  if (_tkSearchFocusIdx >= rows.length) _tkSearchFocusIdx = rows.length - 1;
  rows.forEach((el, i) => el.classList.toggle("tk-kbfocus", i === _tkSearchFocusIdx));
  if (_tkSearchFocusIdx >= 0) rows[_tkSearchFocusIdx]?.scrollIntoView({ block: "nearest" });
}

// 排序 helper：鍵盤導航期間用上次的順序（透過 prevOrder 索引），其他時候照 _tickerSort 排
function _sortTickerList(list) {
  if (Date.now() < _kbNavLockUntil && _lastTickerKey) {
    const prevOrder = _lastTickerKey.split("|").pop().split(",");
    const idxMap = new Map(prevOrder.map((s, i) => [s, i]));
    return [...list].sort((a, b) => {
      const ia = idxMap.get(a.display || a.symbol);
      const ib = idxMap.get(b.display || b.symbol);
      return (ia ?? 9999) - (ib ?? 9999);
    });
  }
  if (_tickerSort === "asc")      return [...list].sort((a, b) => a.change_pct - b.change_pct);
  if (_tickerSort === "vol")      return [...list].sort((a, b) => b.volume - a.volume);
  return [...list].sort((a, b) => b.change_pct - a.change_pct);
}


// 子元素 ref 快取（key: ticker-item el）— DOM 被移除時 WeakMap 會自動釋放
const _tickerChildCache = new WeakMap();
function _tkChildren(el) {
  let c = _tickerChildCache.get(el);
  if (!c) {
    c = {
      price: el.querySelector(".tk-price-val"),
      chg:   el.querySelector(".tk-chg"),
      amt:   el.querySelector(".tk-chg-amt"),
    };
    _tickerChildCache.set(el, c);
  }
  return c;
}

/* 行情列與主圖的數值一致：市場/交易所/標的三者都對得上，才拿主圖的價。
   鑰匙由 render.js 維護（loadData 開頭清空、真資料畫上去之後才寫）→ 載入中一律回 null。 */
// ⚠ 鑰匙**只用「市場＋標的」，不含交易所**（2026-08-14 修）：
//   `exchangeSelect` 實際上只有 pionex 一個選項，把它放進鑰匙沒有任何辨識力，
//   卻會讓某些列永遠對不上 —— 自選(watchlist)列的 `data-exch` 是**空字串**，
//   合約列是 "pionex" → 同一檔 BTC 在自選裡就配不起來，於是自選那列永遠退回
//   /api/tickers 的整批快照（另一個來源、另一個節奏）＝使用者看到的「合約行情會慢」。
window._mkChartDataKey = (mkt, sym) =>
  `${(mkt || "").trim()}|${(sym || "").trim()}`.toUpperCase();

function _mainChartPrice(el) {
  const key = window._chartDataKey;
  if (!key) return null;                       // 沒載完／載入中 → 不冒用
  const d = el.dataset;
  // 行情列的 data-sym 就是使用者點下去會送進 symbolInput 的字串，兩邊用同一把 key 產生器
  const rowKey = window._mkChartDataKey(d.mkt, d.display || d.sym);
  if (rowKey !== key) return null;
  if (typeof ohlcvData === "undefined" || !Array.isArray(ohlcvData) || !ohlcvData.length) return null;
  const v = +ohlcvData[ohlcvData.length - 1].close;   // 主圖最後一根（形成中那根）的收盤＝畫面上的現價
  return (isFinite(v) && v > 0) ? v : null;
}

function _updateTickerPrices() {
  const container = document.getElementById("tickerList");
  if (!container) return;
  const src = _tickerMkt === "tw" ? _twTickerData : _tickerData;
  // Map 查表取代 O(n) find，整體從 O(n²) 降為 O(n)
  const srcMap = new Map();
  src.forEach(x => { srcMap.set(x.display || x.symbol, x); srcMap.set(x.symbol, x); });
  container.querySelectorAll(".ticker-item[data-display]").forEach(el => {
    const t = srcMap.get(el.dataset.display);
    if (t) _paintTickerRow(el, t);
  });
  updatePageTitle();
}

/* 畫一列。抽出來是為了「主圖價一變就只重畫那一列」（見 _tkSyncChartRow）。 */
function _paintTickerRow(el, t) {
  const { price: priceEl, chg: chgEl, amt: amtEl } = _tkChildren(el);
  // 「你正在看的那一檔」用主圖的價，其餘用該標的自己的即時價（使用者：「我希望他們是一致的」）。
  // 兩支 API 本來就同源（Binance 永續，實測同刻中位差 0.10 點），差別只在取樣時刻不同 →
  // 對齊成同一個數字即可，不必動任何資料來源。
  // ⚠ 這件事以前做過一次、失敗後整個拿掉：舊版用 tk-active 判斷，但切標的瞬間 ohlcvData
  //   還是**前一個標的**的 → 該列閃現前一檔的價（「點下去跳成別的、再跳回」）。
  //   這次改用 `_chartDataKey`：loadData 開頭清空、真資料 renderAll 之後才寫入
  //   → 載入中一律對不上、退回自己的價，結構上不可能再閃到別檔。
  const _mp = _mainChartPrice(el);
  const displayPrice = (_mp != null) ? _mp : t.price;
  // ⚠ 漲跌幅/漲跌額必須跟著**顯示的那個價**一起算，否則會出現「價是主圖的、%卻是行情列的」
  //   這種自己跟自己對不上的列。基準價優先用該標的的開盤(24h open)，沒有才退回原本的欄位。
  let pct = t.change_pct, amt = (t.change_amt != null)
    ? t.change_amt : t.price * t.change_pct / 100 / (1 + t.change_pct / 100);
  if (_mp != null) {
    const base = (t.open != null && +t.open > 0) ? +t.open : (t.price - amt);
    if (isFinite(base) && base > 0) { amt = _mp - base; pct = amt / base * 100; }
  }
  const sign = pct >= 0 ? "+" : "";
  const cls  = pct >= 0 ? "up" : "dn";
  // 比對後再寫，值相同不觸發 repaint
  if (priceEl) {
    const v = fmtTickerPrice(displayPrice);
    if (priceEl.textContent !== v) priceEl.textContent = v;
  }
  if (chgEl) {
    const v = `${sign}${pct.toFixed(2)}%`, c = `tk-chg ${cls}`;
    if (chgEl.textContent !== v) chgEl.textContent = v;
    if (chgEl.className   !== c) chgEl.className   = c;
  }
  if (amtEl) {
    const v = _tickerMkt === "tw" ? sign + Math.abs(amt).toFixed(2) : sign + _fmtAmt(amt, t.price);
    const c = `tk-chg-amt ${cls}`;
    if (amtEl.textContent !== v) amtEl.textContent = v;
    if (amtEl.className   !== c) amtEl.className   = c;
  }
}

/* ★ 主圖價一更新就同步那一列（使用者：「要小到毫秒等級都相同」）。
   只靠各自的輪詢是不夠的：行情列 1 秒一次、主圖 /api/latest 另一套節奏 →
   兩次更新之間必然有一段時間顯示不同的數字。改由 realtime.js 在把新價寫進 ohlcvData
   之後**立刻**呼叫這支 → 兩邊讀同一個 `ohlcvData` 最後一根、在同一拍寫入，永遠一致。
   ⚠ 只動「主圖那一檔」那一列，其他列不碰（成本＝一次 querySelector + 三個字串比對）。*/
window._tkSyncChartRow = function () {
  const key = window._chartDataKey;
  if (!key) return;
  const container = document.getElementById("tickerList");
  if (!container) return;
  const src = _tickerMkt === "tw" ? _twTickerData : _tickerData;
  if (!Array.isArray(src) || !src.length) return;
  // ⚠ 查詢用 `.ticker-item` 而不是 `.ticker-item[data-display]`：
  //   **自選列沒有 data-display**（只有 data-sym）→ 用後者會整批漏掉自選，
  //   那正是「同一檔 BTC 在自選裡就是跟主圖對不上」的原因。
  for (const el of container.querySelectorAll(".ticker-item")) {
    const d = el.dataset;
    const rowSym = d.display || d.sym;
    if (!rowSym || window._mkChartDataKey(d.mkt, rowSym) !== key) continue;
    const t = src.find(x => (x.display || x.symbol) === rowSym) || src.find(x => x.symbol === rowSym);
    if (t) _paintTickerRow(el, t);
    return;   // 一次只會有一列命中
  }
};

// ── 報價 delta 輪詢：帶上次 rev token → 後端只回「有變動的標的」,本地按 symbol 合併 ──
//    頻寬大減但「報價照樣每秒報」(變動的每檔都在 delta 裡)。每 ~60 輪拿一次整包
//    (新上架/下架/排序基準自癒);後端重啟/token 失效自動回整包,永不出錯。
const _tkRev = { futures: null, spot: null, tw: null };
let _tkPollN = 0;
// ⚠ 合併鍵＝display(不是 symbol)：同一幣在 Binance(EVAAUSDT)與 Pionex(EVAA_USDT_PERP)
//   symbol 格式不同、display 一致。Binance 冷卻降級 Pionex 時 symbol 一翻，若用 symbol 當鍵
//   會把整包當「新標的」push 進去 → _tickerData 翻倍(660→1218)、display 全撞名 → 排序被幽靈
//   重複污染、殘留不散(降級源舊格式再也不出現在後續 delta) → 「合約排列有時候怪怪的」根因。
//   display 是 render(_k=c::display)/排序(display||symbol) 一致採用的穩定識別，故合併也用它。
//   用 Map 重建：既有同鍵後者覆蓋前者＝順帶清掉既有重複(自癒已污染的清單)。
/* 後端為了省流量省略掉的欄位，在**唯一的合併點**補回來 → 所有既有消費者不必改。
   ★ 2026-08-15：報價輪詢是全站最高頻的請求（crypto 每秒一輪），實測整包 gzip 25.0KB/秒/人。
     `change_amt` 純粹是 price−open、`spot` 純粹是 display 去掉 ".P" —— 送這兩個等於在傳
     算得出來的東西。省掉它們＋浮點瘦身後 25.0 → 17.5KB（-29.9%）。
   ⚠ **不可以連 `symbol` 一起省**（那還能再省 9.6%）：跨源時 symbol 格式不同
     （Binance `EVAAUSDT` vs Pionex `EVAA_USDT_PERP`），從 display 推導只在「來源是 Binance」
     時剛好成立 —— 幣安一冷卻降級就全錯，而那正是最不該出錯的時候。見 memory
     project_ticker-merge-key-display。 */
function _tkFill(t) {
  if (t.spot === undefined && typeof t.display === "string") t.spot = t.display.replace(".P", "");
  if (t.change_amt === undefined && typeof t.price === "number" && typeof t.open === "number")
    t.change_amt = t.price - t.open;
  return t;
}
function _tkMerge(cur, j, key) {
  if (j.rev) _tkRev[key] = j.rev;
  const _id = t => t.display || t.symbol;
  if (!j.delta) {                                                           // 整包(或舊後端/冷啟動空包→保留舊資料)
    if (!j.tickers || !j.tickers.length) return cur;
    for (const t of j.tickers) _tkFill(t);
    const m = new Map();
    for (const t of j.tickers) m.set(_id(t), t);                            // 去重(降級來源殘留/保險)
    return [...m.values()];
  }
  if (!j.tickers || !j.tickers.length) return cur;                          // delta 空=真的沒變動
  const m = new Map();
  for (const t of cur) m.set(_id(t), t);                                    // 既有(同鍵去重)
  /* ★ 2026-08-17 差量細到**欄位級**（後端只送真的變了的欄位）→ 這裡必須「合併」不能「覆蓋」。
     覆蓋的話沒送來的欄位會整個消失（symbol/open 一整天不變＝永遠不會再送）→ 清單瞬間變空殼。
     ⚠ _tkFill 要在**合併之後**才做：它推導的 change_amt 需要 price 與 open 兩個，
       在只帶 price 的差量列上算不出來。
     ⚠ change_amt/spot 是推導欄位，來源欄位一變就得作廢重算 —— 但**只在後端沒送**時才清：
       台股的 change_amt 是「對前一日收盤」算的、不是 price−open，是後端算好送來的，
       清掉會被 _tkFill 用錯公式蓋掉（見 _slim_crypto_rows 的註解：推導只對 crypto 成立）。 */
  for (const t of j.tickers) {
    const k = _id(t);
    const old = m.get(k);
    if (!old) { m.set(k, _tkFill(t)); continue; }
    const row = { ...old, ...t };
    if (t.change_amt === undefined && (t.price !== undefined || t.open !== undefined)) delete row.change_amt;
    if (t.spot === undefined && t.display !== undefined) delete row.spot;
    m.set(k, _tkFill(row));
  }
  return [...m.values()];
}
function _tkUrl(m, key, useSince) {
  return "/api/tickers?market=" + m + ((useSince && _tkRev[key]) ? "&since=" + encodeURIComponent(_tkRev[key]) : "");
}

/* ── 現貨清單改「需要時才每秒」(2026-07-31) ───────────────────────────────────
   報價輪詢是全站最高頻的請求(crypto 每秒一輪)，而每輪其實抓「合約＋現貨」兩包。
   ★但 _spotTickerData 全站只有兩個消費者：
     ① 標的搜尋視窗切到「現貨」分頁(_symSearchMarket === "spot") — 視窗多數時間是關的
     ② updatePageTitle() 在「目前看的就是現貨標的」時要拿現貨價 — 多數人看的是 .P 永續
     （「全部」分頁只吃 _tickerData，見 _renderAllSearchList；報價列本身也只用合約/台股）
   實測 gzip 後現貨包 9.5KB/秒/人，佔報價流量 28% —— 平常整份下載完沒有任何東西讀它。
   → 平時只留 15 秒心跳保鮮(開視窗時不會是舊資料)，真的要用時才回到每秒。
   ⚠ 心跳這種低頻抓法一律走整包不帶 since：delta 的自癒是「每 60 輪整包一次」，
     低頻後幾乎輪不到那一輪 → 差量會一路疊下去無從校正。而現貨整包 gzip 9.5KB
     vs delta 9.2KB 差異可忽略(幣價每秒幾乎全動，差量本來就省不到)，直接整包最穩。*/
const _SPOT_IDLE_MS = 15000;
let _spotLastTs = 0;
function _spotNeeded() {
  try {
    const ov = document.getElementById("symOverlay");
    if (ov && !ov.classList.contains("hidden") && _symSearchMarket === "spot") return true;
    if ((document.getElementById("marketSelect")?.value || "crypto") === "crypto") {
      const sym = (document.getElementById("symbolInput")?.value || "").trim().toUpperCase();
      if (sym && !sym.endsWith(".P")) return true;   // 現貨標的 → 分頁標題要現貨價
    }
  } catch (e) {}
  return false;
}

/* ── 行情中斷提示（2026-08-01）─────────────────────────────────────────────
   ★為什麼：實測把 /api/ 全部切斷後，畫面**完全沒有任何跡象**——報價列、主圖、
     連分頁標題都停在最後一次的價格，30 秒後依然理直氣壯寫著「BTC/USDT.P 63,057.2」。
     94 個請求失敗全被 `catch {}` 吃掉。對回測/交易工具來說這是最危險的一種壞法：
     使用者以為自己在看即時價，其實是一張凍住的截圖。
   → 連續數輪抓不到就明講。抓到就立刻收起（收起條件只看「有沒有成功過」，不做遲滯，
     免得網路一恢復還卡著紅字反而更令人懷疑）。
   ⚠ 看門狗要獨立於 fetchTickers 的 setInterval：請求若是**卡住**(不是失敗)，
     fetchTickers 會停在 await 上不返回，靠它自己回報等於永遠不會亮。 */
const _TK_STALE_MS = { crypto: 10000, tw: 15000 };   // 輪詢 1s / 3s → 約 10 輪 / 5 輪沒消息
let _tkLastOkTs = 0;
let _tkStaleOn  = false;
function _tkStaleCheck() {
  try {
    if (!_tkLastOkTs) return;                        // 還沒成功過(初次載入中) → 不亂報
    const lim  = _TK_STALE_MS[_tickerMkt === "tw" ? "tw" : "crypto"];
    const gone = Date.now() - _tkLastOkTs;
    const bad  = gone > lim;
    if (bad === _tkStaleOn) {                        // 狀態沒變 → 只更新秒數
      if (bad) { const t = document.getElementById("tkStaleTxt");
                 if (t) t.textContent = `⚠ 行情中斷 ${Math.round(gone / 1000)} 秒 — 畫面上的價格已非即時`; }
      return;
    }
    _tkStaleOn = bad;
    document.getElementById("tkStale")?.classList.toggle("hidden", !bad);
    const t = document.getElementById("tkStaleTxt");
    if (t && bad) t.textContent = `⚠ 行情中斷 ${Math.round(gone / 1000)} 秒 — 畫面上的價格已非即時`;
    _lastPageTitle = "";                             // 讓 updatePageTitle 重寫(加/去掉標題前綴)
    updatePageTitle();
  } catch (e) {}
}
if (typeof window !== "undefined" && !window._tkStaleTimer) {
  window._tkStaleTimer = setInterval(_tkStaleCheck, 2000);
}

let _tkRttMs = null;          // 最近一次報價請求的往返時間 → 給訊號格數用（見 utils.js 的連線指示）
async function fetchTickers() {
  const _rt0 = (performance && performance.now) ? performance.now() : Date.now();
  try {
    _tkPollN++;
    const useSince = (_tkPollN % 60 !== 1);   // 每 60 輪第 1 次拿整包,其餘走 delta
    if (_tickerMkt === "tw") {
      const res = await fetch(_tkUrl("tw", "tw", useSince));
      if (res.ok) { const j = await res.json(); _twTickerData = _tkMerge(_twTickerData, j, "tw"); _tkLastOkTs = Date.now(); _tkRttMs = ((performance&&performance.now)?performance.now():Date.now()) - _rt0; }
    } else {
      const wantSpot = _spotNeeded() || (Date.now() - _spotLastTs >= _SPOT_IDLE_MS);
      if (wantSpot) _spotLastTs = Date.now();
      const [futRes, spotRes] = await Promise.all([
        fetch(_tkUrl("futures", "futures", useSince)),
        wantSpot ? fetch(_tkUrl("spot", "spot", false)) : null,
      ]);
      if (futRes.ok)  { const j = await futRes.json();  _tickerData     = _tkMerge(_tickerData, j, "futures"); _tkLastOkTs = Date.now(); _tkRttMs = ((performance&&performance.now)?performance.now():Date.now()) - _rt0; }
      if (spotRes && spotRes.ok) { const j = await spotRes.json(); _spotTickerData = _tkMerge(_spotTickerData, j, "spot"); }
    }
    if (_tkStaleOn) _tkStaleCheck();   // 恢復了 → 不等下一次看門狗，立刻收起紅字

    // 手機版面板未滑出時跳過 DOM 更新；桌面版面板永遠可見
    const isMobile = window.innerWidth <= 900 || isMobileUI();
    const panelOpen = !isMobile || document.getElementById("tickerPanel").classList.contains("ticker-open");
    if (!panelOpen) { updatePageTitle(); return; }

    if (_tickerSort !== "wl" && _tickerSort !== "coach") {
      const search  = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
      const srcList = _tickerMkt === "tw" ? _twTickerData : _tickerData;
      let list = srcList.filter(t =>
        !search ||
        (t.display || t.symbol).toLowerCase().includes(search) ||
        (t.name || "").toLowerCase().includes(search) ||
        t.symbol.toLowerCase().includes(search)
      );
      // 顯式排序（鍵盤導航期間沿用上次順序，避免使用者按↓時清單在腳下重排）
      list = _sortTickerList(list);
      const newKey = `${_tickerMkt}|${_tickerSort}|${search}|${list.map(t => t.display || t.symbol).join(",")}`;
      if (newKey === _lastTickerKey) {
        _updateTickerPrices();
      } else {
        renderTickers();
        _lastTickerKey = newKey;
        _updateTickerPrices();
        _saveTickerCache(); // 只在結構改變時存 localStorage
      }
    } else {
      renderTickers();
    }

    if (!document.getElementById("symOverlay")?.classList.contains("hidden")) {
      // 滑鼠 hover 在搜尋列上時跳過週期性重渲（避免 innerHTML 重建讓 hover 一閃一閃）
      if (!window._symListHovered) renderSymSearch();
    }
  } catch {}
}

/* 自選裡的美股/台股/港股報價。
   ★ 2026-08-15 使用者：「我只要加到自選 他會出現價格並跳動就好」。
     原本這支**只在點「自選」分頁那一下被呼叫一次**，加上每檔 60 秒快取
     → 價格出現一次之後就再也不動。改成停在自選分頁時持續輪詢（見 _wlTimer）。
   ⚠ 快取 TTL 跟輪詢間隔要配套：TTL 若 ≥ 間隔，每輪都命中快取＝等於沒輪詢。
     這裡 TTL 12s / 輪詢 15s。
   ⚠ 為什麼不做更快：這支是**逐檔**打 /api/latest（美股沒有像加密那樣一次回全市場的免費端點）。
     自選 10 檔 × 每 15 秒 ≈ 40 次/分，還在 Finnhub 免費額度（60 次/分）內；
     再快就會開始撞限流，而限流一撞就是整批報價一起壞（見 memory binance-weight-self-lockout 同一種病）。 */
const _WL_PRICE_TTL = 12000;
async function _refreshWlPrices() {
  const items = _watchlist.filter(w => w.market === "us" || w.market === "tw" || w.market === "hk");
  let _dirty = false;
  await Promise.all(items.map(async item => {
    const key = `${item.market}:${item.exchange || ""}:${item.symbol}`;
    const cached = _wlPriceCache[key];
    if (cached && Date.now() - cached.ts < _WL_PRICE_TTL) return;
    try {
      const res = await fetch("/api/latest", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ market: item.market, symbol: item.symbol, timeframe: "1d", exchange: item.exchange || "" }),
      });
      if (!res.ok) return;
      const data = (await res.json()).data || [];
      if (data.length >= 2) {
        const prev = data[data.length - 2], last = data[data.length - 1];
        const change_pct = prev.close ? (last.close - prev.close) / prev.close * 100 : 0;
        _wlPriceCache[key] = { price: last.close, change_pct, volume: last.volume, ts: Date.now() };
        _dirty = true;
      }
    } catch {}
  }));
  if (_dirty) _wlCacheSave();
  if (_tickerSort === "wl") renderTickers();
}

/* 開機後先抓一次自選裡的非加密報價：使用者點進「自選」時多半已經有值，不必當場等一趟網路。
   ⚠ 延後 3 秒：別跟首屏的 K 棒/勝率搶頻寬與主執行緒。
   ⚠ 沒有非加密自選就完全不打（大多數人是這種）。 */
function _wlPrefetch() {
  setTimeout(() => {
    try {
      if (_watchlist.some(w => w.market !== "crypto")) _refreshWlPrices();
    } catch (e) {}
  }, 3000);
}

/* 停在「自選」分頁時持續更新非加密標的的報價（加密那些本來就跟著每秒的報價輪詢在跳）。
   ⚠ 分頁被切走 / 瀏覽器分頁在背景 → 不打：使用者看不到的東西不值得消耗上游額度，
     而且背景分頁被瀏覽器節流後會排隊、回前景時一次爆發。 */
let _wlTimer = null;
function _startWlPriceLoop() {
  if (_wlTimer) return;
  _wlTimer = setInterval(() => {
    if (_tickerSort !== "wl" || document.hidden) return;
    if (!_watchlist.some(w => w.market !== "crypto")) return;   // 自選裡沒有非加密標的 → 不必打
    _refreshWlPrices();
  }, 15000);
}
_startWlPriceLoop();
_wlPrefetch();

function updatePageTitle() {
  const sym = (document.getElementById("symbolInput")?.value || "").trim().toUpperCase();
  if (!sym) { document.title = "回測系統"; return; }
  const all = [..._tickerData, ..._spotTickerData];
  const hit = all.find(t =>
    t.symbol.toUpperCase() === sym.replace("/","").replace(".P","") ||
    (t.spot  || "").toUpperCase() === sym ||
    (t.display || "").toUpperCase() === sym
  );
  // 行情中斷時標題加前綴：使用者常把這個分頁丟在背景當報價看板，那時分頁標題是唯一的訊息通道
  const pre = _tkStaleOn ? "⚠ 已中斷 " : "";
  const newTitle = hit
    ? `${pre}${hit.display || sym} ${fmtTickerPrice(hit.price)} ${hit.change_pct >= 0 ? "+" : ""}${hit.change_pct.toFixed(2)}%`
    : pre + sym;
  if (newTitle !== _lastPageTitle) { _lastPageTitle = newTitle; document.title = newTitle; }
}

/* ── ticker 輔助 ── */
const _LOGO_COLORS = ["#e8845a","#7b9ee8","#5bbf8a","#e87a7a","#b88ae8",
                      "#e8c45a","#5ab8e8","#e87ab8","#8ae8c4","#e8a45a",
                      "#7ae87a","#c45ae8","#e8d05a","#5a8ae8","#e85a5a"];
/* 手繪 blob 路徑（六種不規則圓形） */
const _LOGO_BLOBS = [
  "M50,13 C68,9 89,24 91,47 C93,69 78,90 56,92 C34,94 10,80 10,57 C10,34 24,15 46,13 Z",
  "M50,11 C74,9 93,29 92,53 C91,75 70,93 47,94 C24,95 7,75 8,51 C9,27 25,12 48,11 Z",
  "M48,14 C70,8 94,27 93,51 C92,73 72,93 49,94 C26,95 7,76 8,52 C9,30 22,16 46,14 Z",
  "M52,12 C77,10 94,33 91,57 C88,77 68,92 46,93 C24,94 7,73 9,49 C11,27 27,13 50,11 Z",
  "M50,10 C73,7 96,31 95,55 C94,77 73,96 49,95 C25,94 4,73 6,49 C8,27 25,11 48,10 Z",
  "M46,15 C66,9 91,25 92,49 C93,71 77,92 53,93 C31,94 8,78 9,54 C10,32 23,18 44,14 Z",
];
function _coinLogoHtml(display) {
  const base = (display.split("/")[0] || display).toUpperCase();
  const hash = base.split("").reduce((s,c) => s + c.charCodeAt(0), 0);
  const bg   = _LOGO_COLORS[hash % _LOGO_COLORS.length];
  const path = _LOGO_BLOBS[hash % _LOGO_BLOBS.length];
  const lbl  = base.length <= 3 ? base : base.slice(0,3);
  const rot  = (hash % 17) - 8;            /* −8 ~ +8 度歪斜 */
  const fs   = lbl.length > 2 ? 27 : 33;  /* 字體大小 */
  return `<div class="tk-logo" style="transform:rotate(${rot}deg)">
    <svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="${bg}" stroke="rgba(255,255,255,0.28)" stroke-width="3" stroke-linejoin="round"/>
      <text x="50" y="55" text-anchor="middle" dominant-baseline="middle"
            font-family="Caveat,cursive" font-size="${fs}" font-weight="700" fill="white"
            transform="rotate(${-rot},50,50)">${lbl}</text>
    </svg>
  </div>`;
}
function _coinFullName(display) {
  const d = display.toUpperCase();
  const isPerp = d.endsWith(".P");
  const parts  = d.replace(".P","").split("/");
  if (parts.length === 2)
    return isPerp ? `${parts[0]} ${parts[1]} PERPETUAL` : `${parts[0]} / ${parts[1]}`;
  return display;
}
function _fmtAmt(amt, price) {
  if (amt == null) return "";
  const abs = Math.abs(amt);
  if (price >= 1000) return amt.toFixed(1);
  if (price >= 10)   return amt.toFixed(2);
  if (price >= 1)    return amt.toFixed(3);
  return amt.toFixed(4);
}

/* 台股 Blob Logo — 依股票族群配色，以中文名首字為標籤 */
const _TW_SECTOR_COLORS = [
  [7000, "#3d7ab8"],  // 其他
  [6000, "#5b3de8"],  // 科技服務
  [5000, "#8B6540"],  // 建設
  [4000, "#c83dde"],  // 生技電信
  [3000, "#2aaa58"],  // 電子零組件
  [2900, "#d05060"],  // 運輸貿易
  [2800, "#c4a030"],  // 金融保險
  [2500, "#7a5de8"],  // 電子零件
  [2300, "#1aadad"],  // 半導體
  [2000, "#4e6ef2"],  // 電子製造
  [0,    "#c17340"],  // 傳統產業
];
function _twLogoHtml(symbol, name) {
  const num = parseInt(symbol) || 0;
  const bg  = (_TW_SECTOR_COLORS.find(([threshold]) => num >= threshold) || _TW_SECTOR_COLORS[0])[1];
  const hash = symbol.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const path = _LOGO_BLOBS[hash % _LOGO_BLOBS.length];
  const rot  = (hash % 15) - 7;
  const lbl  = name ? name.slice(0, 1) : symbol.slice(0, 2);
  return `<div class="tk-logo" style="transform:rotate(${rot}deg)">
    <svg viewBox="0 0 100 100" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="${bg}" stroke="rgba(255,255,255,0.25)" stroke-width="3" stroke-linejoin="round"/>
      <text x="50" y="55" text-anchor="middle" dominant-baseline="middle"
            font-size="44" font-weight="700" fill="white"
            transform="rotate(${-rot},50,50)">${lbl}</text>
    </svg>
  </div>`;
}

const _STAR_SVG = `<svg class="star-svg" width="16" height="16" viewBox="0 0 18 18" fill="none"><path class="star-outline" d="M9 15.5C8.7 15.3 2 10.8 2 6.8C2 4.6 3.7 3 5.7 3C7 3 8.2 3.7 9 4.8C9.8 3.7 11 3 12.3 3C14.3 3 16 4.6 16 6.8C16 10.8 9.3 15.3 9 15.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/><path class="star-fill" d="M9 15.5C8.7 15.3 2 10.8 2 6.8C2 4.6 3.7 3 5.7 3C7 3 8.2 3.7 9 4.8C9.8 3.7 11 3 12.3 3C14.3 3 16 4.6 16 6.8C16 10.8 9.3 15.3 9 15.5Z" fill="currentColor" opacity="0"/></svg>`;

/* ── 原地協調列表：重用既有 row 節點（只改變動值 + 依序搬移），避免每秒全量重建 innerHTML
   → 每秒更新順暢：不閃、不重置捲動位置、click 監聽只在建立時綁一次（重排不失效，讀 dataset）── */
function _reconcileTicker(container, items, build, update) {
  const existing = new Map();
  for (let i = container.children.length - 1; i >= 0; i--) {
    const el = container.children[i];
    if (el.dataset && el.dataset.rkey != null) existing.set(el.dataset.rkey, el);
    else el.remove();   // 清掉 loading / empty 佔位
  }
  let prev = null;
  const seen = new Set();
  for (const it of items) {
    const k = it._k;
    seen.add(k);
    let el = existing.get(k);
    if (el) { update(el, it); }
    else {
      const tpl = document.createElement("template");
      tpl.innerHTML = build(it).trim();
      el = tpl.content.firstElementChild;
      el.dataset.rkey = k;
      _bindTickerRow(el);
    }
    const ref = prev ? prev.nextSibling : container.firstChild;
    if (el !== ref) container.insertBefore(el, ref);   // 只在位置不對時搬移
    prev = el;
  }
  for (const [k, el] of existing) if (!seen.has(k)) el.remove();
}

// 每個 row 建立時綁一次 click（讀 dataset，重排/重用都有效）
function _bindTickerRow(el) {
  if (el.classList.contains("tk-wl-hdr")) return;   // 市場分組標題：不綁點擊
  el.addEventListener("click", e => {
    if (e.target.closest(".tk-star")) {           // 星號 → 加入/移除自選
      e.stopPropagation();
      _toggleWatchlist(el.dataset.sym, el.dataset.mkt, el.dataset.exch || "");
      return;
    }
    if (e.target.closest(".wl-del")) {            // 自選列 → 刪除
      e.stopPropagation();
      _removeWatchlistByKey(el.dataset.rkey);
      return;
    }
    _selectTickerRow(el);                         // 其餘 → 選此標的
  });
}

function _selectTickerRow(el) {
  const mkt = el.dataset.mkt;
  const mktEl = document.getElementById("marketSelect");
  if (mktEl && mktEl.value !== mkt) mktEl.value = mkt;
  if (mkt === "crypto") {
    const x = document.getElementById("exchangeSelect");
    if (x) x.value = el.dataset.exch || "pionex";
  }
  // 先設 symbol：台指期(TXF/MXF/TMF)的時框限制依 symbol 判定，需先就位
  document.getElementById("symbolInput").value = el.dataset.sym;
  // 立即用該列已知現價填上方價格 → 切換時上方價格不會閃「—」再回來（資料載入後會精修為同值）
  const _q = _quoteForRow(el);
  if (_q && typeof _paintSymbolQuote === "function") _paintSymbolQuote(_q.price);
  el.parentNode?.querySelector(".ticker-item.tk-active")?.classList.remove("tk-active");
  el.classList.add("tk-active");
  window._mSetTab && window._mSetTab("chart");    // 手機：先跳圖表分頁(立即切換，不等資料)
  // 重的 updateMarketUI + loadData 延到下一幀 → 分頁切換先 paint、消除「卡一下才切」
  requestAnimationFrame(() => { updateMarketUI(); loadData(false); });
}

// 取該列的已知現價（給切換瞬間先填上方價格、避免閃「—」）。
// 優先直接讀「該列顯示中的價格」(.tk-price-val)＝使用者所見即所得，任何清單（合約/自選/台股）都有；
// 讀不到才退回 _tickerData 查找。
function _quoteForRow(el) {
  const txt = el.querySelector(".tk-price-val")?.textContent || "";
  const shown = parseFloat(txt.replace(/[, ]/g, ""));
  if (shown > 0) return { price: shown };
  const disp = (el.dataset.display || el.dataset.sym || "").toUpperCase();
  const sym  = (el.dataset.symbol  || "").toUpperCase();
  const t = (_tickerData || []).find(x =>
    (x.display || "").toUpperCase() === disp || (x.symbol || "").toUpperCase() === sym);
  if (t && t.price) return { price: t.price };
  return null;
}

function _removeWatchlistByKey(key) {
  const idx = _watchlist.findIndex(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  if (idx >= 0) { _watchlist.splice(idx, 1); _saveWatchlist(); renderTickers(); }
}

// 🎯 教練可進場 tab：抓 /api/coach_scan（前60、stage≥5），列出可進場標的（點擊載入）。60s 自刷。
let _coachScan = { ts: 0, loading: false, data: [] };
async function _fetchCoachScan(force) {
  const cs = _coachScan;
  if (cs.loading) return;
  if (!force && cs.data.length && Date.now() - cs.ts < 15000) return;   // 15s:伺服器即回+每次複驗,常刷不卡
  cs.loading = true;
  if (_tickerSort === "coach") renderTickers();     // 顯示「掃描中…」
  try {
    // min_stage=5+at_entry=1：BOS(步驟5)一確認就列——步驟5=setup成立、步驟6=去掛限價單、步驟7=觸碰成交,
    // 對限價單交易者提前到「還來得及掛單」的時點(第7步壽命僅幾分鐘,等到7就晚了)。
    // 兩版都列(使用者要 5m)。每次回應已複驗+點擊後5s刷新,把退階落差壓到最小。
    const r = await fetch("/api/coach_scan?n=60&min_stage=5&at_entry=1", { cache: "no-store" });
    const j = await r.json();
    if (j && j.warming) {
      // 伺服器冷啟動暖機中(背景掃描跑著) → 8 秒後自動重試,期間顯示「掃描中」
      cs.warming = true;
      setTimeout(() => { _coachScan.ts = 0; _fetchCoachScan(true); }, 8000);
    } else {
      cs.warming = false;
      // 優雅退場:上一輪還在、這輪消失的(退階/離區)不直接不見 → 變灰標「已失效」停留2分鐘再移除
      const fresh = (j && j.results) || [];
      const freshSyms = new Set(fresh.map(r => r.symbol));
      const now = Date.now();
      const ghosts = (cs.data || [])
        .filter(r => !freshSyms.has(r.symbol))
        .map(r => ({ ...r, _gone: r._gone || now }))
        .filter(r => now - r._gone < 120000);
      cs.data = fresh.concat(ghosts);
      cs.ts = now;
    }
  } catch (e) {} finally {
    cs.loading = false;
    if (_tickerSort === "coach") renderTickers();
  }
}
function _renderCoachList(container, currentSym) {
  const cs = _coachScan;
  if (!cs.loading && (!cs.data.length || Date.now() - cs.ts > 15000)) _fetchCoachScan();   // 陳舊→背景刷新
  if ((cs.loading || cs.warming) && !cs.data.length) { container.innerHTML = '<div class="tk-loading">教練掃描中…</div>'; return; }
  if (!cs.data.length) {
    container.innerHTML = '<div class="tk-loading">目前無標的正在進場價位<br><span style="font-size:11px;color:#889">自動掃前60檔·現價進掛單區才列出</span></div>';
    return;
  }
  const html = cs.data.map(r => {
    const sym = r.symbol;                            // 'BTC/USDT.P'
    const disp = sym.replace(".P", "");
    const active = sym.toUpperCase() === (currentSym || "").toUpperCase();
    let bestVer = "default", bestStage = -1;         // 命中版本(取最高stage那版)→點擊時教練面板切到這版
    const vers = Object.entries(r.hits || {}).map(([ver, h]) => {
      if ((h.stage || 0) > bestStage) { bestStage = h.stage || 0; bestVer = ver; }
      const dl = h.direction === 1 ? "多" : "空";
      const dc = h.direction === 1 ? "#26a69a" : "#ef5350";
      const tf = ver === "fast" ? "⚡5m" : "15m";   // ⚡=短效提示:5m 第7步壽命僅幾分鐘,點開可能剛失效
      // 依步驟分級標示(門檻已下修到 stage≥5)——避免把「還沒到進場」的步驟5/6 誤標成「進場中」:
      //   步驟5=BOS·待掛單(藍) / 步驟6=掛單中(黃) / 步驟≥7=依 near_pct:區內●進場中(亮黃)、距區近x%(灰)
      const st = h.stage || 0;
      const np = h.near_pct;
      let tag;
      if (st >= 7) {
        tag = (np === 0) ? '<span style="color:#ffd54f;font-size:10px">●進場中</span>'
            : (np > 0 ? `<span style="color:#889;font-size:10px">近${np}%</span>` : "");
      } else if (st === 6) {
        tag = `<span style="color:#ffd54f;font-size:10px">掛單中${np > 0 ? `·近${np}%` : ""}</span>`;
      } else {   // st === 5
        tag = `<span style="color:#8fd3ff;font-size:10px">BOS·待掛單${np > 0 ? `·近${np}%` : ""}</span>`;
      }
      return `<span style="color:${dc};font-weight:700">${tf}${dl}</span>${tag}`;
    }).join('<span style="color:#556">·</span>');
    const gone = !!r._gone;   // 已失效(退階/離區):灰化停留2分鐘,標「已失效」
    return `<div class="ticker-item coach-item${active ? " tk-active" : ""}" data-mkt="crypto" data-exch="pionex" data-sym="${escHtml(sym)}" data-symbol="${escHtml(sym.replace("/", "").replace(".P", ""))}" data-display="${escHtml(disp)}" data-ver="${bestVer}" style="cursor:pointer${gone ? ";opacity:.42" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:3px 2px">
        <span style="font-weight:700">${gone ? "💤" : "🎯"} ${escHtml(disp)}${gone ? '<span style="color:#98a;font-size:10px;margin-left:4px">已失效</span>' : ""}</span><span style="font-size:12px;display:flex;gap:4px;align-items:center">${vers}</span>
      </div></div>`;
  }).join("");
  container.innerHTML = html;
  container.querySelectorAll(".coach-item").forEach(el => el.addEventListener("click", () => {
    // 面板切到「命中的那一版」再載標的——否則清單是 fast(5m) 到第7步、面板卻顯示 default(15m) 第4步 → 看似「沒到第7步就放上來」
    const ver = el.dataset.ver === "fast" ? "fast" : "default";
    window._coachWhich = ver;
    window._coachClickExpect = { sym: el.dataset.sym, ver, ts: Date.now() };   // 面板載入後驗證仍在第7步,失效即提示
    try { localStorage.setItem("coachWhich", ver); } catch (e) {}
    // 教練面板關著就自動打開（點「可進場」就是要看教練步驟）
    if (!window._coachOn) { try { document.getElementById("coachToggleBtn")?.click(); } catch (e) {} }
    _selectTickerRow(el);
    setTimeout(() => _fetchCoachScan(true), 5000);   // 點擊後強制刷新清單:剛失效的標的快速掉出
  }));
}

function renderTickers() {
  const container = document.getElementById("tickerList");
  if (!container) return;

  const currentSym = document.getElementById("symbolInput")?.value.trim().toUpperCase();
  const exchVal    = document.getElementById("exchangeSelect")?.value || "pionex";

  // ── 自選標的 tab ──────────────────────────────────────
  if (_tickerSort === "wl") {
    if (!_watchlist.length) {
      container.innerHTML = '<div class="tk-loading">尚無自選，點 ♡ 加入</div>';
      return;
    }
    const rows = _watchlist.map(item => {
      const mktLabel = item.market === "crypto" ? (item.exchange || "crypto").toUpperCase() : item.market.toUpperCase();
      let price = null, change_pct = null;
      if (item.market === "crypto") {
        const td = _tickerData.find(t =>
          t.display?.toUpperCase() === item.symbol.toUpperCase() ||
          t.symbol?.toUpperCase() === item.symbol.toUpperCase());
        if (td) { price = td.price; change_pct = td.change_pct; }
      } else {
        const c = _wlPriceCache[`${item.market}:${item.exchange || ""}:${item.symbol}`];
        if (c) { price = c.price; change_pct = c.change_pct; }
      }
      return {
        _k: `${item.market}:${item.exchange || ""}:${item.symbol}`,
        item, mktLabel,
        active:   item.symbol.toUpperCase() === currentSym,
        priceStr: price != null ? fmtTickerPrice(price) : "---",
        chgCls:   change_pct != null ? (change_pct >= 0 ? "up" : "dn") : "",
        pctStr:   change_pct != null ? (change_pct >= 0 ? "+" : "") + change_pct.toFixed(2) + "%" : mktLabel,
        amtStr:   (change_pct != null && price != null)
          ? (change_pct >= 0 ? "+" : "") + _fmtAmt(price * change_pct / 100 / (1 + change_pct / 100), price) : "",
      };
    });
    // 依市場分組（固定順序），每組前插一個市場標題列（保留組內原自選順序）
    const _WL_ORDER = ["crypto", "tw", "us", "hk"];
    const _WL_LABEL = { crypto: "加密貨幣", tw: "台股", us: "美股", hk: "港股" };
    const items = [];
    const _pushGroup = (mkt, label) => {
      const grp = rows.filter(r => r.item.market === mkt);
      if (!grp.length) return;
      items.push({ _k: `__wlhdr:${mkt}`, _hdr: true, label, count: grp.length });
      items.push(...grp);
    };
    _WL_ORDER.forEach(mkt => _pushGroup(mkt, _WL_LABEL[mkt]));
    rows.filter(r => !_WL_ORDER.includes(r.item.market))   // 未知市場（理論上無）→ 收尾「其他」
        .forEach((r, i, arr) => { if (i === 0) items.push({ _k: "__wlhdr:other", _hdr: true, label: "其他", count: arr.length }); items.push(r); });
    _reconcileTicker(container, items, _buildWlRow, _updateWlRow);
    if (typeof window._tkSyncChartRow === "function") { try { window._tkSyncChartRow(); } catch (e) {} }
    return;
  }

  // ── 🎯 教練可進場 tab ─────────────────────────────────
  if (_tickerSort === "coach") { _renderCoachList(container, currentSym); return; }

  const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();

  // ── 台股 tab ──────────────────────────────────────────
  if (_tickerMkt === "tw") {
    let list = _twTickerData.filter(t =>
      !search ||
      t.symbol.includes(search) ||
      (t.name || "").toLowerCase().includes(search)
    );
    // 台指期三兄弟（is_future）永遠置頂、不參與漲跌/量排序；其餘台股照常排序
    const futs   = list.filter(t => t.is_future);
    const stocks = _sortTickerList(list.filter(t => !t.is_future));
    list = [...futs, ...stocks];

    const items = list.map(t => {
      const sign = t.change_pct >= 0 ? "+" : "";
      return {
        _k: `tw::${t.symbol}`, t,
        cls:    t.change_pct >= 0 ? "up" : "dn",
        active: t.symbol === currentSym,
        inWl:   _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === `tw::${t.symbol}`),
        limitCls: t.change_pct >= 9.7 ? "tk-limit-up" : t.change_pct <= -9.7 ? "tk-limit-dn" : "",
        limitTxt: t.change_pct >= 9.7 ? "漲停" : t.change_pct <= -9.7 ? "跌停" : "",
        priceStr: fmtTickerPrice(t.price),
        amtStr:   sign + Math.abs(t.change_amt).toFixed(2),
        pctStr:   sign + t.change_pct.toFixed(2) + "%",
      };
    });
    _reconcileTicker(container, _tkSlice(items), _buildTwRow, _updateTwRow);
    updatePageTitle();
    return;
  }

  // ── 合約行情 tab ──────────────────────────────────────
  let list = _tickerData.filter(t =>
    !search ||
    t.display.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().includes(search) ||
    t.symbol.toLowerCase().replace("usdt","").includes(search)
  );
  list = _sortTickerList(list);

  const items = list.map(t => {
    const sign = t.change_pct >= 0 ? "+" : "";
    const amt  = t.change_amt != null ? t.change_amt : t.price * t.change_pct / 100 / (1 + t.change_pct / 100);
    return {
      _k: `c::${t.display}`, t, exch: exchVal,
      cls:    t.change_pct >= 0 ? "up" : "dn",
      active: (t.display.toUpperCase() === currentSym || t.symbol.toUpperCase() === currentSym),
      inWl:   _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === `crypto:${exchVal}:${t.display}`),
      logo:   _coinLogoHtml(t.display),
      full:   _coinFullName(t.display),
      priceStr: fmtTickerPrice(t.price),
      amtStr:   sign + _fmtAmt(amt, t.price),
      pctStr:   sign + t.change_pct.toFixed(2) + "%",
    };
  });
  _reconcileTicker(container, _tkSlice(items), _buildCryptoRow, _updateCryptoRow);
  // ⚠ 整批重畫/協調走的是 _buildCryptoRow / _updateCryptoRow（HTML 樣板），那條路用的是
  //   該標的自己的 t.price → 重畫完那一瞬間「主圖那一檔」會退回不同的數字。
  //   實測抓到過（列 1881.99 vs 主圖 1882.33）→ 重畫後立刻補一次同步。
  if (typeof window._tkSyncChartRow === "function") { try { window._tkSyncChartRow(); } catch (e) {} }
  updatePageTitle();
}

/* ── 三種 row 的 build（建立）/ update（重用時只改變動值）── */
function _buildWlRow(it) {
  if (it._hdr)   // 市場分組標題列（不可點選，_bindTickerRow 會略過）
    return `<div class="tk-wl-hdr"><span class="tk-wl-hdr-t">${escHtml(it.label)}</span><span class="tk-wl-hdr-n">${it.count}</span></div>`;
  const m = it.item;
  return `<div class="ticker-item${it.active ? " tk-active" : ""}" data-mkt="${escHtml(m.market)}" data-exch="${escHtml(m.exchange || "")}" data-sym="${escHtml(m.symbol)}">
    ${_coinLogoHtml(m.symbol)}
    <div class="tk-info"><span class="tk-sym">${escHtml(m.symbol)}</span><span class="tk-full">${escHtml(m.market === "crypto" ? _coinFullName(m.symbol) : m.market.toUpperCase())}</span></div>
    <div class="tk-prices">
      <span class="tk-price-val">${it.priceStr}</span>
      <div class="tk-chg-row"><span class="tk-chg-amt ${it.chgCls}">${it.amtStr}</span><span class="tk-chg ${it.chgCls}">${it.pctStr}</span></div>
    </div>
    <div class="tk-action"><button class="wl-del" title="移除"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7"/><path d="M6.2 7l.9 12.4A1.6 1.6 0 0 0 8.7 21h6.6a1.6 1.6 0 0 0 1.6-1.5L17.8 7"/><path d="M10 11v6M14 11v6"/></svg></button></div>
  </div>`;
}
function _updateWlRow(el, it) {
  if (it._hdr) { _setTxt(el, ".tk-wl-hdr-n", String(it.count)); return; }
  el.classList.toggle("tk-active", it.active);
  _setTxt(el, ".tk-price-val", it.priceStr);
  _setTxtCls(el, ".tk-chg-amt", it.amtStr, "tk-chg-amt " + it.chgCls);
  _setTxtCls(el, ".tk-chg", it.pctStr, "tk-chg " + it.chgCls);
}
function _buildTwRow(it) {
  const t = it.t;
  return `<div class="ticker-item${it.active ? " tk-active" : ""}${it.limitCls ? " " + it.limitCls : ""}" data-mkt="tw" data-exch="" data-sym="${escHtml(t.symbol)}" data-display="${escHtml(t.symbol)}">
    ${_twLogoHtml(t.symbol, t.name)}
    <div class="tk-info"><span class="tk-sym">${escHtml(t.symbol)}</span><span class="tk-full">${escHtml(t.name || "")}</span></div>
    <div class="tk-prices">
      <span class="tk-price-val">${it.priceStr}</span>
      <div class="tk-chg-row"><span class="tk-chg-amt ${it.cls}">${it.amtStr}</span><span class="tk-chg ${it.cls}">${it.pctStr}</span><span class="tk-limit-badge">${it.limitTxt}</span></div>
    </div>
    <div class="tk-action"><button class="tk-star${it.inWl ? " active" : ""}" title="${it.inWl ? "移除自選" : "加入自選"}">${_STAR_SVG}</button></div>
  </div>`;
}
function _updateTwRow(el, it) {
  const kb = el.classList.contains("tk-kbfocus") ? " tk-kbfocus" : "";   // 保留鍵盤高亮（className 整段重建會洗掉）
  el.className = "ticker-item" + (it.active ? " tk-active" : "") + (it.limitCls ? " " + it.limitCls : "") + kb;
  _setTxt(el, ".tk-price-val", it.priceStr);
  _setTxtCls(el, ".tk-chg-amt", it.amtStr, "tk-chg-amt " + it.cls);
  _setTxtCls(el, ".tk-chg", it.pctStr, "tk-chg " + it.cls);
  _setTxt(el, ".tk-limit-badge", it.limitTxt);
  _setStar(el, it.inWl);
}
function _buildCryptoRow(it) {
  const t = it.t;
  return `<div class="ticker-item${it.active ? " tk-active" : ""}" data-mkt="crypto" data-exch="${escHtml(it.exch)}" data-sym="${escHtml(t.display)}" data-symbol="${escHtml(t.symbol)}" data-display="${escHtml(t.display)}" data-spot="${escHtml(t.spot || t.display)}">
    ${it.logo}
    <div class="tk-info"><span class="tk-sym">${escHtml(t.display)}</span><span class="tk-full">${escHtml(it.full)}</span></div>
    <div class="tk-prices">
      <span class="tk-price-val">${it.priceStr}</span>
      <div class="tk-chg-row"><span class="tk-chg-amt ${it.cls}">${it.amtStr}</span><span class="tk-chg ${it.cls}">${it.pctStr}</span></div>
    </div>
    <div class="tk-action"><button class="tk-star${it.inWl ? " active" : ""}" title="${it.inWl ? "移除自選" : "加入自選"}">${_STAR_SVG}</button></div>
  </div>`;
}
function _updateCryptoRow(el, it) {
  el.classList.toggle("tk-active", it.active);
  _setTxt(el, ".tk-price-val", it.priceStr);
  _setTxtCls(el, ".tk-chg-amt", it.amtStr, "tk-chg-amt " + it.cls);
  _setTxtCls(el, ".tk-chg", it.pctStr, "tk-chg " + it.cls);
  _setStar(el, it.inWl);
}
// 小工具：只在值變了才寫 DOM（省 reflow）
function _setTxt(el, sel, txt) { const n = el.querySelector(sel); if (n && n.textContent !== txt) n.textContent = txt; }
function _setTxtCls(el, sel, txt, cls) { const n = el.querySelector(sel); if (!n) return; if (n.textContent !== txt) n.textContent = txt; if (n.className !== cls) n.className = cls; }
function _setStar(el, inWl) { const s = el.querySelector(".tk-star"); if (!s) return; s.classList.toggle("active", inWl); const tt = inWl ? "移除自選" : "加入自選"; if (s.title !== tt) s.title = tt; }

function fmtTickerPrice(p) {
  if (p >= 10000) return p.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (p >= 100)   return p.toFixed(2);
  if (p >= 1)     return p.toFixed(4);
  if (p >= 0.01)  return p.toFixed(5);
  return p.toFixed(6);
}

function _saveTickerCache() {
  try {
    localStorage.setItem("_tc", JSON.stringify({ f: _tickerData, s: _spotTickerData, ts: Date.now() }));
  } catch {}
}

function _loadTickerCache() {
  try {
    const c = JSON.parse(localStorage.getItem("_tc") || "null");
    if (c && Array.isArray(c.f) && c.f.length) {
      _tickerData     = c.f;
      _spotTickerData = c.s || [];
      renderTickers();   // 立即顯示上次快取
    }
  } catch {}
}

function startTickerRefresh() {
  if (_tickerTimer) clearInterval(_tickerTimer);
  _loadTickerCache();
  fetchTickers();
  // crypto 1秒；台股 3秒（後端 MIS 疊價 worker 每 3s 更新高量股即時價→報價列即時跳；setInterval 動態切換）
  _tickerTimer = setInterval(fetchTickers, _tickerMkt === "tw" ? 3000 : 1000);
}

function stopTickerRefresh() {
  if (_tickerTimer) { clearInterval(_tickerTimer); _tickerTimer = null; }
}

function bindTickerPanel() {
  // 點/觸控行情列表時凍結排序 3 秒（同鍵盤導航）：避免使用者點下去那瞬間清單剛好依漲跌幅重排、
  // 列在指下移位 → 看到的價格「跳成別列的值」。凍結期間價格仍就地更新、只是不重排。
  // document 層捕獲 + 座標落在清單內判斷（手機觸控目標常是內部元素/body，掛在清單上的 listener 收不到）。
  if (!window._tkFreezeBound) {
    window._tkFreezeBound = true;
    const _inList = (x, y) => {
      const el = document.getElementById("tickerList");
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.width && b.height && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    };
    const _freeze = (e) => {
      const t = (e.touches && e.touches[0]) || e;
      if (t && _inList(t.clientX, t.clientY) && typeof _markKbNav === "function") _markKbNav();
    };
    document.addEventListener("touchstart", _freeze, { passive: true, capture: true });
    document.addEventListener("mousedown",  _freeze, { passive: true, capture: true });
  }

  // 捲到接近底部 → 加載下一批（提高上限後強制重渲一次）。只在還有更多時作動。
  if (!window._tkScrollBound) {
    window._tkScrollBound = true;
    const _list = document.getElementById("tickerList");
    if (_list) _list.addEventListener("scroll", () => {
      if (!window._tkHasMore) return;
      // 提早補：捲過整批一半(或剩不到一個半螢幕)就先生成下一批 → 生成成本藏在中途、捲到底早已就緒。
      // 補完 scrollHeight 變大 → 這條件自動變 false，不會連續重觸發。
      const passedHalf = (_list.scrollTop + _list.clientHeight) > _list.scrollHeight * 0.5;
      const nearBottom = _list.scrollHeight - _list.scrollTop - _list.clientHeight < _list.clientHeight * 1.5;
      if (passedHalf || nearBottom) {
        _tkCap += _TK_CAP_STEP;
        _lastTickerKey = "";          // 下次 fetch 也會走完整重渲
        if (typeof renderTickers === "function") renderTickers();
      }
    }, { passive: true });
  }

  // 市場切換 tab（合約 / 台股）
  document.querySelectorAll(".tk-mkt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mkt === _tickerMkt) return;
      document.querySelectorAll(".tk-mkt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _tickerMkt     = btn.dataset.mkt;
      try { localStorage.setItem("tkMkt", _tickerMkt); } catch (e) {}
      _lastTickerKey = "";
      // 重設更新頻率
      if (_tickerTimer) clearInterval(_tickerTimer);
      fetchTickers();
      _tickerTimer = setInterval(fetchTickers, _tickerMkt === "tw" ? 3000 : 1000);
    });
  });

  document.querySelectorAll(".tk-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tk-seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _tickerSort = btn.dataset.sort;
      try { localStorage.setItem("tkSort", _tickerSort); } catch (e) {}
      _lastTickerKey = "";
      renderTickers();
      if (btn.dataset.sort === "wl") _refreshWlPrices();
      if (btn.dataset.sort === "coach") _fetchCoachScan(true);
    });
  });

  // 還原上次選的市場分頁 + 排序（active class 對齊；資料抓取由 startTickerRefresh 依 _tickerMkt 處理）
  document.querySelectorAll(".tk-mkt-btn").forEach(b => b.classList.toggle("active", b.dataset.mkt === _tickerMkt));
  document.querySelectorAll(".tk-seg-btn").forEach(b => b.classList.toggle("active", b.dataset.sort === _tickerSort));
  const _tkSearch = document.getElementById("tickerSearch");
  const _tkClear  = document.getElementById("tickerSearchClear");
  _tkSearch?.addEventListener("input", () => {
    if (_tkClear) _tkClear.classList.toggle("hidden", !_tkSearch.value);
    _tkSearchFocusIdx = -1;     // 搜尋詞變→重設選取
    _lastTickerKey = "";        // 搜尋條件改變→強制完整重建
    renderTickers();
  });
  // 叉叉：清空搜尋、還原完整清單、焦點留在輸入框
  _tkClear?.addEventListener("click", () => {
    _tkSearch.value = "";
    _tkClear.classList.add("hidden");
    _tkSearchFocusIdx = -1;
    _lastTickerKey = "";
    renderTickers();
    _tkSearch.focus();
  });
  // ↑↓ 即時切換高亮列（不必按 Enter）、Enter 載入第一筆、Esc 先清搜尋再取消選取
  // 對處理到的鍵 stopPropagation：避免 effects.js 的全域「↑↓ 切標的」也在搜尋框內觸發
  // （那個用「完整清單」索引、會與此處過濾清單打架）。改由此 handler 獨佔搜尋框內導航。
  _tkSearch?.addEventListener("keydown", e => {
    const rows = _tkRows();
    if (e.key === "Escape") {
      e.stopPropagation();
      if (_tkSearch.value) { _tkSearch.value = ""; _tkClear?.classList.add("hidden"); _lastTickerKey = ""; renderTickers(); }
      _tkSearchFocusIdx = -1; _tkHighlight();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault(); e.stopPropagation(); _markKbNav();
      _tkSearchFocusIdx = Math.min(_tkSearchFocusIdx + 1, rows.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation(); _markKbNav();
      _tkSearchFocusIdx = Math.max(_tkSearchFocusIdx - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      if (_tkSearchFocusIdx < 0) _tkSearchFocusIdx = 0;   // 沒選過→Enter 載第一筆
    } else {
      return;
    }
    _tkHighlight();
    const cur = _tkRows()[_tkSearchFocusIdx];
    if (cur) _selectTickerRow(cur);   // ↑↓／Enter 即時載入該標的（自動顯示，不必再按 Enter）
  });
}

/* ══════════════════════════════════════════
   Symbol Search Modal
══════════════════════════════════════════ */
const SYM_ICON_COLORS = ["#f23645","#2196f3","#ff9800","#26a69a","#7e57c2","#e91e63","#00bcd4","#8bc34a"];
let _symSearchMarket   = "all";
let _symSearchFocusIdx = -1;
let _symHistory        = [];   // 最近搜尋紀錄

function loadSymHistory() {
  try { _symHistory = JSON.parse(localStorage.getItem("symSearchHistory") || "[]"); } catch { _symHistory = []; }
}
function saveSymHistory() {
  try { localStorage.setItem("symSearchHistory", JSON.stringify(_symHistory.slice(0, 10))); } catch {}
}
function addToSymHistory(t) {
  _symHistory = _symHistory.filter(h => h.symbol !== t.symbol);
  _symHistory.unshift({ symbol: t.symbol, display: t.display, spot: t.spot || t.display,
                        change_pct: t.change_pct, price: t.price });
  _symHistory = _symHistory.slice(0, 10);
  saveSymHistory();
}

function symIconColor(base) {
  return SYM_ICON_COLORS[base.charCodeAt(0) % SYM_ICON_COLORS.length];
}

function renderSymSearch() {
  const list = document.getElementById("symModalList");
  if (!list || !document.getElementById("symOverlay").classList.contains("hidden") === false) return;
  if (!document.getElementById("symOverlay") || document.getElementById("symOverlay").classList.contains("hidden")) return;
  // 週期性刷新只對「本地即時資料」（合約/現貨）有意義——能順帶更新清單裡的即時漲跌。
  // API 模式（全部/美股/台股）每 2s 重抓重繪會清空 innerHTML → 列表跳動、loading 閃爍、
  // scroll 位置重置（手機無 hover 旗標擋不住）。這些模式只在使用者輸入時才渲染。
  if (_symSearchMarket === "all" || _symSearchMarket === "us" || _symSearchMarket === "tw"
      || _symSearchMarket === "hk" || _symSearchMarket === "fx") return;
  _renderSymSearchList();
}

function _symItemHTML(t, idx, mkt) {
  // 從 symbol 推算 base（BTC_USDT_PERP → BTC, BTC_USDT → BTC, BTCUSDT → BTC）
  const rawSym = t.symbol || "";
  const base   = rawSym.includes("_") ? rawSym.split("_")[0]
                 : rawSym.endsWith("USDT") ? rawSym.slice(0, -4) : rawSym;
  const color  = symIconColor(base);
  const chg    = t.change_pct != null ? t.change_pct : 0;
  const cls    = chg >= 0 ? "up" : "dn";
  const sign   = chg >= 0 ? "+" : "";
  // 依當前 tab 決定顯示名稱，不依賴後端回傳的 display 欄位（防止 tab 切換時顯示錯誤格式）
  // 「全部」/歷史模式一律視為永續合約格式（與預設合約 tab 一致），只有明確「現貨」tab 才用現貨格式
  const isFut  = (mkt || _symSearchMarket) !== "spot";
  const name   = isFut ? `${base}/USDT.P` : `${base}/USDT`;
  const desc   = isFut ? `${base} USDT 永續合約` : `${base} / USDT`;
  // 現貨代號（供 OHLCV API 使用）
  const spot   = t.spot || `${base}/USDT`;
  // 交易所標的清單（Binance / Pionex）也是外部來源 → 同 _usItemHTML 的理由，一律跳脫
  return `<div class="sym-result-item" data-idx="${idx}" data-market="crypto"
    data-symbol="${escHtml(rawSym)}" data-display="${escHtml(name)}"
    data-spot="${escHtml(spot)}"
    data-change_pct="${chg}" data-price="${t.price || 0}">
    <div class="sym-icon" style="background:${color}">${escHtml(base.slice(0,2))}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${escHtml(name)}</span>
      <span class="sym-result-desc">${escHtml(desc)}</span>
    </div>
    <div class="sym-result-right">
      <span class="sym-result-chg ${cls}">${sign}${chg.toFixed(2)}%</span>
      <span class="sym-result-tag">Pionex</span>
    </div>
  </div>`;
}

// 台股搜尋結果項（data-market="tw"）
function _twItemHTML(r, idx) {
  const id = String(r.stock_id || r.symbol || r);
  const eid = escHtml(id);   // TWSE/TPEX opendata 來源 → 同 _usItemHTML 的理由，一律跳脫
  return `<div class="sym-result-item" data-idx="${idx}" data-market="tw"
    data-symbol="${eid}" data-display="${eid}" tabindex="${idx}">
    <div class="sym-icon" style="background:${symIconColor(id)}">${escHtml(id.slice(0,2))}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${eid}</span>
      <span class="sym-result-desc">${escHtml(r.stock_name || r.name || "")}</span>
    </div>
    <span class="sym-result-tag">台股</span>
  </div>`;
}

// 美股搜尋結果項（data-market="us"）
function _usItemHTML(r, idx) {
  // ⚠ symbol/name/exchange/type 都是外部 API 回來的 → 進 HTML 與屬性前必須 escHtml()，
  //   否則名稱裡一個引號就會截斷 data-symbol（點了載錯標的），也擋不住上游注入。
  const sym = escHtml(r.symbol);
  return `<div class="sym-result-item" data-idx="${idx}" data-market="us"
    data-symbol="${sym}" data-display="${sym}" tabindex="${idx}">
    <div class="sym-icon" style="background:${symIconColor(r.symbol)}">${escHtml(String(r.symbol || "").slice(0,2).toUpperCase())}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${sym}</span>
      <span class="sym-result-desc">${escHtml(r.name || "")}${r.exchange ? " · " + escHtml(r.exchange) : ""}</span>
    </div>
    <span class="sym-result-tag">${escHtml(r.type || "美股")}</span>
  </div>`;
}

// 港股搜尋結果項（data-market="hk"；symbol 形如 0700.HK）
function _hkItemHTML(r, idx) {
  const sym = String(r.symbol || "");
  const esym = escHtml(sym);   // 外部來源 → 同 _usItemHTML 的理由，一律跳脫
  return `<div class="sym-result-item" data-idx="${idx}" data-market="hk"
    data-symbol="${esym}" data-display="${esym}" tabindex="${idx}">
    <div class="sym-icon" style="background:${symIconColor(sym)}">${escHtml(sym.replace(".HK","").slice(0,2))}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${esym}</span>
      <span class="sym-result-desc">${escHtml(r.name || "")}</span>
    </div>
    <span class="sym-result-tag">港股</span>
  </div>`;
}

function _bindSymItems(list) {
  list.querySelectorAll(".sym-result-item").forEach(el => {
    el.addEventListener("click", () => _selectSymbol(el));
  });
  document.getElementById("symHistClear")?.addEventListener("click", e => {
    e.stopPropagation();
    _symHistory = [];
    saveSymHistory();
    _renderSymSearchList();
  });
}

// 「全部」搜尋：合約（本地即時過濾）+ 台股 + 美股（API），合併分區顯示
function _renderAllSearchList(query) {
  const list = document.getElementById("symModalList");
  if (!query) {
    let html = "";
    if (_symHistory.length) {
      html += `<div class="sym-section-hd">最近搜尋 <span class="sym-hist-clear" id="symHistClear">清除</span></div>`;
      html += _symHistory.map((t, i) => _symItemHTML(t, "h" + i, "all")).join("");
    } else {
      html = `<div class="sym-empty">輸入代號或名稱，搜尋全部市場（合約 / 台股 / 美股）</div>`;
    }
    list.innerHTML = html;
    _bindSymItems(list);
    return;
  }

  const _thisQuery = query;
  // 1) 合約（本地即時過濾，免等 API）
  const cData = (_tickerData && _tickerData.length) ? _tickerData : [];
  const cMatches = [...cData]
    .sort((a, b) => b.volume - a.volume)
    .filter(t => (t.display || "").toLowerCase().includes(query) ||
                 (t.symbol  || "").toLowerCase().includes(query))
    .slice(0, 8);

  const renderMerged = (twResults, usResults, hkResults, loading) => {
    // query 已變則丟棄
    if (((document.getElementById("symModalInput")?.value) || "").toLowerCase().trim() !== _thisQuery) return;
    let html = "";
    if (cMatches.length) {
      html += `<div class="sym-section-hd">合約</div>`;
      html += cMatches.map((t, i) => _symItemHTML(t, "c" + i, "futures")).join("");
    }
    if (twResults && twResults.length) {
      html += `<div class="sym-section-hd">台股</div>`;
      html += twResults.slice(0, 8).map((r, i) => _twItemHTML(r, "t" + i)).join("");
    }
    if (usResults && usResults.length) {
      html += `<div class="sym-section-hd">美股</div>`;
      html += usResults.slice(0, 8).map((r, i) => _usItemHTML(r, "u" + i)).join("");
    }
    if (hkResults && hkResults.length) {
      html += `<div class="sym-section-hd">港股</div>`;
      html += hkResults.slice(0, 8).map((r, i) => _hkItemHTML(r, "hk" + i)).join("");
    }
    if (loading) html += `<div class="sym-loading">搜尋台股 / 美股 / 港股中…</div>`;
    if (!html) html = `<div class="sym-empty">查無結果</div>`;
    list.innerHTML = html;
    _bindSymItems(list);
  };

  // 先把合約結果秒顯，台股/美股/港股 API 回來後再補
  renderMerged(null, null, null, true);

  Promise.all([
    fetch(`/api/search?market=tw&keyword=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    fetch(`/api/us/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    fetch(`/api/hk/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
  ]).then(([tw, us, hk]) => renderMerged(tw?.results || [], us?.results || [], hk?.results || [], false));
}

function _renderSymSearchList() {
  const list  = document.getElementById("symModalList");
  const query = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();

  // 全部：同時搜尋合約 / 台股 / 美股，合併顯示，選取後自動切換市場
  if (_symSearchMarket === "all") { _renderAllSearchList(query); return; }

  // 美股：用 API 搜尋
  if (_symSearchMarket === "us") {
    if (!query) {
      list.innerHTML = `<div class="sym-empty">輸入股票代號或名稱搜尋（如 AAPL、Tesla）</div>`;
      return;
    }
    // 不立即清空，避免閃爍；只在第一次搜尋時顯示 loading
    if (!list.querySelector(".sym-result-item")) {
      list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    }
    const _thisQuery = query;
    fetch(`/api/us/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        // 若 query 已改變則丟棄舊結果
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 AAPL）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => _usItemHTML(r, i)).join("");
        _bindSymItems(list);
      })
      .catch(() => {
        list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 AAPL）</div>`;
      });
    return;
  }

  // 港股：用 /api/hk/search（Yahoo 過濾 .HK）搜尋
  /* 外匯（2026-08-11）：清單固定 21 檔 → 空字串也直接列出全部，不必先打字。
     ⚠ 後端 /api/search?market=fx 是純本機過濾、不打網路，所以可以每次輸入都查。 */
  if (_symSearchMarket === "fx") {
    const _thisQuery = query;
    fetch(`/api/search?market=fx&keyword=${encodeURIComponent(query || "")}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results || [];
        if (!results.length) {
          list.innerHTML = `<div class="sym-empty">查無結果（外匯共 21 檔，可搜 EUR、JPY、XAU…）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) =>
          `<div class="sym-result-item" data-idx="${i}" data-market="fx"
                data-symbol="${escHtml(r.symbol)}" data-display="${escHtml(r.symbol)}">
             <span class="sym-result-code">${escHtml(r.symbol)}</span>
             <span class="sym-result-name">外匯</span>
           </div>`).join("");
        _bindSymItems(list);
      })
      .catch(() => { list.innerHTML = `<div class="sym-empty">外匯清單載入失敗</div>`; });
    return;
  }

  if (_symSearchMarket === "hk") {
    if (!query) {
      list.innerHTML = `<div class="sym-empty">輸入代號或名稱搜尋（如 0700、tencent）</div>`;
      return;
    }
    if (!list.querySelector(".sym-result-item")) {
      list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    }
    const _thisQuery = query;
    fetch(`/api/hk/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 0700.HK）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => _hkItemHTML(r, i)).join("");
        _bindSymItems(list);
      })
      .catch(() => {
        list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 0700.HK）</div>`;
      });
    return;
  }

  // 台股：用後端 /api/search?market=tw 搜尋
  if (_symSearchMarket === "tw") {
    if (!query) {
      list.innerHTML = `<div class="sym-empty">輸入股票代號或名稱（如 2330、台積電）</div>`;
      return;
    }
    if (!list.querySelector(".sym-result-item")) {
      list.innerHTML = `<div class="sym-loading">搜尋中…</div>`;
    }
    const _thisQuery = query;
    fetch(`/api/search?market=tw&keyword=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const cur = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();
        if (cur !== _thisQuery) return;
        const results = data?.results;
        if (!results?.length) {
          list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 2330）</div>`;
          return;
        }
        list.innerHTML = results.map((r, i) => _twItemHTML(r, i)).join("");
        _bindSymItems(list);
      })
      .catch(() => {
        list.innerHTML = `<div class="sym-empty">查無結果，請直接輸入代號（如 2330）</div>`;
      });
    return;
  }

  const data = _symSearchMarket === "futures" ? _tickerData : _spotTickerData;

  let html = "";

  // 無搜尋詞時顯示歷史紀錄
  if (!query && _symHistory.length) {
    html += `<div class="sym-section-hd">最近搜尋 <span class="sym-hist-clear" id="symHistClear">清除</span></div>`;
    html += _symHistory.map((t, i) => _symItemHTML(t, "h" + i)).join("");
    html += `<div class="sym-section-divider"></div>`;
  }

  if (!data.length) {
    list.innerHTML = html + `<div class="sym-loading">${_symSearchMarket === "futures" ? "合約行情載入中，請稍候…" : "現貨資料載入中…"}</div>`;
    _bindSymItems(list);
    return;
  }

  // 先按 volume 排（熱門在前），再依查詢過濾
  let items = [...data].sort((a, b) => b.volume - a.volume);
  if (query) {
    items = items.filter(t =>
      t.display.toLowerCase().includes(query) ||
      t.symbol.toLowerCase().includes(query)
    );
  }
  items = items.slice(0, 100);

  if (!items.length) {
    list.innerHTML = html + `<div class="sym-empty">沒有符合的標的</div>`;
    _bindSymItems(list);
    return;
  }

  html += items.map((t, i) => _symItemHTML(t, i)).join("");
  list.innerHTML = html;
  _bindSymItems(list);
}

function _selectSymbol(el) {
  const display = el.dataset.display || el.dataset.spot || el.dataset.symbol;
  // 市場以「該項目自身」為準（全部搜尋模式各項各自帶市場），回退當前 tab
  const mkt = el.dataset.market ||
              (_symSearchMarket === "tw" ? "tw" : _symSearchMarket === "us" ? "us"
               : _symSearchMarket === "hk" ? "hk" : _symSearchMarket === "fx" ? "fx" : "crypto");
  // 選擇後切換到對應市場
  if (mkt === "tw") {
    document.getElementById("marketSelect").value = "tw";
    updateMarketUI();
  } else if (mkt === "us") {
    document.getElementById("marketSelect").value = "us";
    updateMarketUI();
  } else if (mkt === "hk") {
    document.getElementById("marketSelect").value = "hk";
    updateMarketUI();
  } else if (mkt === "fx") {
    /* ★ 2026-08-11 外匯（漏掉這一段就是使用者說的「點外匯提示找不到」的真正原因）。
       這個 if/else 鏈的 **else 是 crypto**：沒有 fx 分支時，選了 EUR/USD 會落到 crypto，
       於是送出 market=crypto & symbol=EUR/USD → 後端當然「找不到」。
       ⚠ 錯誤訊息還會說「請確認標的代號是否正確」，代號其實完全正確 → 極度誤導。
       ⚠ 守則：新增市場要同時改三處 —— market pill 的 MKTS/LBL、搜尋分頁、**這裡的分派**。 */
    document.getElementById("marketSelect").value = "fx";
    updateMarketUI();
  } else {
    // crypto（futures / spot）→ 確保切到 crypto market
    const mktEl = document.getElementById("marketSelect");
    if (mktEl.value !== "crypto") {
      mktEl.value = "crypto";
      updateMarketUI();  // 會先把 symbolInput 設為 "BTC/USDT"，下方再覆蓋為選到的標的
    }
  }
  // 只記入 crypto 搜尋歷史（歷史列以合約格式渲染，台股/美股不記入避免格式錯亂）
  if (mkt === "crypto") {
    addToSymHistory({
      symbol:     el.dataset.symbol,
      display:    display,
      spot:       el.dataset.spot || el.dataset.display,
      change_pct: parseFloat(el.dataset.change_pct) || 0,
      price:      parseFloat(el.dataset.price) || 0,
    });
  }
  document.getElementById("symbolInput").value = display;
  updateMarketUI();   // symbol 就位後再跑一次：台指期(TXF/MXF/TMF)時框限制依 symbol 判定
  closeSymSearch();
  window._mSetTab && window._mSetTab("chart");   // 手機：先跳圖表分頁(立即切換)
  // 重的 loadData + renderTickers 延一幀 → 分頁切換先 paint、不「卡一下才切」
  requestAnimationFrame(() => { loadData(false); renderTickers(); });
}

const _SYM_PLACEHOLDER = {
  all: "搜尋全部市場（合約 / 台股 / 美股）…",
  futures: "搜尋永續合約…",
  spot: "搜尋現貨…",
  tw: "搜尋台股（如 2330、台積電）…",
  us: "搜尋美股（如 AAPL、Tesla）…",
  hk: "搜尋港股（如 0700、tencent）…",
};
function _applySymPlaceholder() {
  const inp = document.getElementById("symModalInput");
  if (inp) inp.placeholder = _SYM_PLACEHOLDER[_symSearchMarket] || _SYM_PLACEHOLDER.all;
}

function openSymSearch() {
  document.getElementById("symOverlay").classList.remove("hidden");
  const inp = document.getElementById("symModalInput");
  inp.value = "";
  document.getElementById("symModalClear").classList.add("hidden");
  _symSearchFocusIdx = -1;
  // 預設一律「全部」：什麼都搜得到，選取後自動切換市場
  _symSearchMarket = "all";
  document.querySelectorAll(".sym-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.market === _symSearchMarket);
  });
  _applySymPlaceholder();
  _renderSymSearchList();
  setTimeout(() => inp.focus(), 50);
}

function closeSymSearch() {
  document.getElementById("symOverlay").classList.add("hidden");
}

function initSymSearch() {
  // 點擊 symbolInput 開啟 modal
  const symInp = document.getElementById("symbolInput");
  symInp.readOnly = true;
  symInp.addEventListener("click", openSymSearch);

  // 關閉按鈕、overlay 背景點擊
  document.getElementById("symOverlay").addEventListener("click", e => {
    if (e.target === document.getElementById("symOverlay")) closeSymSearch();
  });

  // 滑鼠在搜尋列表上時設旗標，跳過 fetchTickers 週期性 innerHTML 重建（避免 hover 一閃一閃）
  const _symList = document.getElementById("symModalList");
  if (_symList) {
    _symList.addEventListener("mouseenter", () => { window._symListHovered = true; });
    _symList.addEventListener("mouseleave", () => { window._symListHovered = false; });
  }

  // 搜尋輸入（美股加 debounce 300ms）
  const modalInp = document.getElementById("symModalInput");
  let _searchTimer = null;
  modalInp.addEventListener("input", () => {
    const clear = document.getElementById("symModalClear");
    clear.classList.toggle("hidden", !modalInp.value);
    _symSearchFocusIdx = -1;
    clearTimeout(_searchTimer);
    // 會打 API 的模式（美股/台股/全部）加 debounce，純本地（合約/現貨）即時渲染
    if (_symSearchMarket === "us" || _symSearchMarket === "tw" || _symSearchMarket === "hk" || _symSearchMarket === "all") {
      _searchTimer = setTimeout(_renderSymSearchList, 300);
    } else {
      _renderSymSearchList();
    }
  });
  document.getElementById("symModalClear")?.addEventListener("click", () => {
    modalInp.value = "";
    document.getElementById("symModalClear").classList.add("hidden");
    modalInp.focus();
    _renderSymSearchList();
  });

  // 鍵盤：↑↓ 選、Enter 確認、ESC 關閉
  modalInp.addEventListener("keydown", e => {
    const items = document.querySelectorAll(".sym-result-item");
    if (e.key === "Escape") { closeSymSearch(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _symSearchFocusIdx = Math.min(_symSearchFocusIdx + 1, items.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _symSearchFocusIdx = Math.max(_symSearchFocusIdx - 1, 0);
    } else if (e.key === "Enter") {
      if (_symSearchFocusIdx >= 0 && items[_symSearchFocusIdx])
        _selectSymbol(items[_symSearchFocusIdx]);
      return;
    } else { return; }
    items.forEach((el, i) => el.classList.toggle("sym-focused", i === _symSearchFocusIdx));
    items[_symSearchFocusIdx]?.scrollIntoView({ block: "nearest" });
  });

  // 市場 tab 切換
  document.querySelectorAll(".sym-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sym-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _symSearchMarket = btn.dataset.market;
      _symSearchFocusIdx = -1;
      // 切到「現貨」分頁：現貨清單平時只有 15 秒心跳(見 _spotNeeded) → 立刻補抓一次拿最新價，
      // 之後的每秒輪詢會自動含現貨。清單先用手上那份秒顯，不留白。
      if (_symSearchMarket === "spot") { _spotLastTs = 0; fetchTickers(); }
      _applySymPlaceholder();
      _renderSymSearchList();
    });
  });
}

/* ══════════════════════════════════════════
   背景分段載入（progressive loading）
══════════════════════════════════════════ */


// 每段 chunk 更新：只動 K線/量/錨點，不碰 markers 或指標
