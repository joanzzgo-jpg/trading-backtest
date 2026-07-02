let _watchlist = [];
let _wlPriceCache = {}; // key: "market:exchange:symbol" → {price, change_pct, volume, ts}
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
function _addToWatchlist() {
  const symbol   = document.getElementById("symbolInput")?.value?.trim();
  const market   = document.getElementById("marketSelect")?.value || "crypto";
  const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
  if (!symbol) return;
  const key = `${market}:${exchange}:${symbol}`;
  if (_watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key)) return;
  _watchlist.unshift({ market, symbol, exchange });
  _saveWatchlist();
  _renderWatchlist();
}


let _tickerData     = [];
let _spotTickerData = [];
let _twTickerData   = [];
// 記住使用者選的市場分頁與排序（重刷新/下次回來還原）
let _tickerMkt      = (() => { try { return localStorage.getItem("tkMkt") || "crypto"; } catch (e) { return "crypto"; } })();   // "crypto" | "tw"
let _tickerSort     = (() => { try { return localStorage.getItem("tkSort") || "desc"; } catch (e) { return "desc"; } })();      // desc=漲幅 asc=跌幅 vol=量 wl=自選
let _tickerTimer    = null;
let _lastTickerKey  = "";        // 追蹤目前渲染的 ticker 結構，避免不必要的 DOM 重建
let _lastPageTitle  = "";        // 快取上次 title，避免重複寫 DOM
let _kbNavLockUntil = 0;         // 鍵盤導航凍結期：使用者用 ↑↓ 切標的時不重排清單，避免每 2 秒重排讓位置在腳下變動

// 鍵盤導航時呼叫：凍結清單順序 3 秒，避免使用者按↓時清單在腳下重排
function _markKbNav() { _kbNavLockUntil = Date.now() + 3000; }
window._markKbNav = _markKbNav;

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

/* 只更新價格文字，不重建 DOM */
function _syncTickerToChart() {
  if (!ohlcvData.length) return;
  const lastBar = ohlcvData[ohlcvData.length - 1];
  if (!lastBar?.close) return;
  const sym = document.getElementById("symbolInput")?.value.trim().toUpperCase();
  if (!sym) return;
  // 在 futures / spot 資料中找到對應標的，同步最新 close 價格
  const allSrc = [..._tickerData, ..._spotTickerData, ..._twTickerData];
  const target = allSrc.find(t =>
    (t.display || t.symbol || "").toUpperCase() === sym ||
    (t.symbol || "").toUpperCase() === sym
  );
  if (target) {
    target.price = lastBar.close;
    _updateTickerPrices();
  }
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

function _updateTickerPrices() {
  const container = document.getElementById("tickerList");
  if (!container) return;
  const src = _tickerMkt === "tw" ? _twTickerData : _tickerData;
  // Map 查表取代 O(n) find，整體從 O(n²) 降為 O(n)
  const srcMap = new Map();
  src.forEach(x => { srcMap.set(x.display || x.symbol, x); srcMap.set(x.symbol, x); });
  container.querySelectorAll(".ticker-item[data-display]").forEach(el => {
    const t = srcMap.get(el.dataset.display);
    if (!t) return;
    const sign    = t.change_pct >= 0 ? "+" : "";
    const cls     = t.change_pct >= 0 ? "up" : "dn";
    const { price: priceEl, chg: chgEl, amt: amtEl } = _tkChildren(el);
    // 每列一律顯示「該標的自己的即時價」。
    // （原本對 tk-active 列改用主圖最新收盤 chartLastClose 同步，但切標的瞬間 ohlcvData 還是
    //   前一個標的 → 該列短暫顯示前一標的的價＝「點下去跳成別的、再跳回」的元兇，故移除。）
    const displayPrice = t.price;
    // 比對後再寫，值相同不觸發 repaint
    if (priceEl) {
      const v = fmtTickerPrice(displayPrice);
      if (priceEl.textContent !== v) priceEl.textContent = v;
    }
    if (chgEl) {
      const v = `${sign}${t.change_pct.toFixed(2)}%`, c = `tk-chg ${cls}`;
      if (chgEl.textContent !== v) chgEl.textContent = v;
      if (chgEl.className   !== c) chgEl.className   = c;
    }
    if (amtEl) {
      const amt = t.change_amt != null ? t.change_amt : t.price * t.change_pct / 100 / (1 + t.change_pct / 100);
      const v = _tickerMkt === "tw" ? sign + Math.abs(amt).toFixed(2) : sign + _fmtAmt(amt, t.price);
      const c = `tk-chg-amt ${cls}`;
      if (amtEl.textContent !== v) amtEl.textContent = v;
      if (amtEl.className   !== c) amtEl.className   = c;
    }
  });
  updatePageTitle();
}

async function fetchTickers() {
  try {
    if (_tickerMkt === "tw") {
      const res = await fetch("/api/tickers?market=tw");
      if (res.ok) { const j = await res.json(); _twTickerData = j.tickers || []; }
    } else {
      const [futRes, spotRes] = await Promise.all([
        fetch("/api/tickers?market=futures"),
        fetch("/api/tickers?market=spot"),
      ]);
      if (futRes.ok)  { const j = await futRes.json();  if (j.tickers?.length) _tickerData     = j.tickers; }
      if (spotRes.ok) { const j = await spotRes.json(); if (j.tickers?.length) _spotTickerData = j.tickers; }
    }

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

async function _refreshWlPrices() {
  const items = _watchlist.filter(w => w.market === "us" || w.market === "tw");
  await Promise.all(items.map(async item => {
    const key = `${item.market}:${item.exchange || ""}:${item.symbol}`;
    const cached = _wlPriceCache[key];
    if (cached && Date.now() - cached.ts < 60000) return;
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
      }
    } catch {}
  }));
  if (_tickerSort === "wl") renderTickers();
}

function updatePageTitle() {
  const sym = (document.getElementById("symbolInput")?.value || "").trim().toUpperCase();
  if (!sym) { document.title = "回測系統"; return; }
  const all = [..._tickerData, ..._spotTickerData];
  const hit = all.find(t =>
    t.symbol.toUpperCase() === sym.replace("/","").replace(".P","") ||
    (t.spot  || "").toUpperCase() === sym ||
    (t.display || "").toUpperCase() === sym
  );
  const newTitle = hit
    ? `${hit.display || sym} ${fmtTickerPrice(hit.price)} ${hit.change_pct >= 0 ? "+" : ""}${hit.change_pct.toFixed(2)}%`
    : sym;
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
  updateMarketUI();
  document.getElementById("symbolInput").value = el.dataset.sym;
  loadData(false);
  // 立即用該列已知現價填上方價格 → 切換時上方價格不會閃「—」再回來（資料載入後會精修為同值）
  const _q = _quoteForRow(el);
  if (_q && typeof _paintSymbolQuote === "function") _paintSymbolQuote(_q.price);
  window._mSetTab && window._mSetTab("chart");    // 手機：選標的後跳圖表分頁
  el.parentNode?.querySelector(".ticker-item.tk-active")?.classList.remove("tk-active");
  el.classList.add("tk-active");
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

// 🎯 教練可進場 tab：抓 /api/coach_scan（前60、stage≥7），列出可進場標的（點擊載入）。60s 自刷。
let _coachScan = { ts: 0, loading: false, data: [] };
async function _fetchCoachScan(force) {
  const cs = _coachScan;
  if (cs.loading) return;
  if (!force && cs.data.length && Date.now() - cs.ts < 30000) return;   // 30s:伺服器即回+每次複驗,常刷不卡
  cs.loading = true;
  if (_tickerSort === "coach") renderTickers();     // 顯示「掃描中…」
  try {
    // min_stage=7+at_entry=1+tfset=default：只列 15m(default)版——5m版第7步壽命僅幾分鐘,
    // 點開常已失效退階(SUI/TLM 實測);15m版壽命長、點進去穩定在第7步。fast 版仍在面板兩版並列顯示。
    const r = await fetch("/api/coach_scan?n=60&min_stage=7&at_entry=1&tfset=default", { cache: "no-store" });
    const j = await r.json();
    if (j && j.warming) {
      // 伺服器冷啟動暖機中(背景掃描跑著) → 8 秒後自動重試,期間顯示「掃描中」
      cs.warming = true;
      setTimeout(() => { _coachScan.ts = 0; _fetchCoachScan(true); }, 8000);
    } else {
      cs.warming = false;
      cs.data = (j && j.results) || [];
      cs.ts = Date.now();
    }
  } catch (e) {} finally {
    cs.loading = false;
    if (_tickerSort === "coach") renderTickers();
  }
}
function _renderCoachList(container, currentSym) {
  const cs = _coachScan;
  if (!cs.loading && (!cs.data.length || Date.now() - cs.ts > 30000)) _fetchCoachScan();   // 陳舊→背景刷新
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
      const tf = ver === "fast" ? "5m" : "15m";
      // near_pct=0＝現價正在掛單區內(亮綠「進場中」)；>0＝距區緣 x%(灰,給限價提前掛單)
      const np = h.near_pct;
      const tag = (np === 0) ? '<span style="color:#ffd54f;font-size:10px">●進場中</span>'
                : (np > 0 ? `<span style="color:#889;font-size:10px">近${np}%</span>` : "");
      return `<span style="color:${dc};font-weight:700">${tf}${dl}</span>${tag}`;
    }).join('<span style="color:#556">·</span>');
    return `<div class="ticker-item coach-item${active ? " tk-active" : ""}" data-mkt="crypto" data-exch="pionex" data-sym="${sym}" data-symbol="${sym.replace("/", "").replace(".P", "")}" data-display="${disp}" data-ver="${bestVer}" style="cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:3px 2px">
        <span style="font-weight:700">🎯 ${disp}</span><span style="font-size:12px;display:flex;gap:4px;align-items:center">${vers}</span>
      </div></div>`;
  }).join("");
  container.innerHTML = html;
  container.querySelectorAll(".coach-item").forEach(el => el.addEventListener("click", () => {
    // 面板切到「命中的那一版」再載標的——否則清單是 fast(5m) 到第7步、面板卻顯示 default(15m) 第4步 → 看似「沒到第7步就放上來」
    const ver = el.dataset.ver === "fast" ? "fast" : "default";
    window._coachWhich = ver;
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
    const items = _watchlist.map(item => {
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
    _reconcileTicker(container, items, _buildWlRow, _updateWlRow);
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
    list = _sortTickerList(list);

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
    _reconcileTicker(container, items, _buildTwRow, _updateTwRow);
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
  _reconcileTicker(container, items, _buildCryptoRow, _updateCryptoRow);
  updatePageTitle();
}

/* ── 三種 row 的 build（建立）/ update（重用時只改變動值）── */
function _buildWlRow(it) {
  const m = it.item;
  return `<div class="ticker-item${it.active ? " tk-active" : ""}" data-mkt="${m.market}" data-exch="${m.exchange || ""}" data-sym="${m.symbol}">
    ${_coinLogoHtml(m.symbol)}
    <div class="tk-info"><span class="tk-sym">${m.symbol}</span><span class="tk-full">${m.market === "crypto" ? _coinFullName(m.symbol) : m.market.toUpperCase()}</span></div>
    <div class="tk-prices">
      <span class="tk-price-val">${it.priceStr}</span>
      <div class="tk-chg-row"><span class="tk-chg-amt ${it.chgCls}">${it.amtStr}</span><span class="tk-chg ${it.chgCls}">${it.pctStr}</span></div>
    </div>
    <div class="tk-action"><button class="wl-del" title="移除"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7"/><path d="M6.2 7l.9 12.4A1.6 1.6 0 0 0 8.7 21h6.6a1.6 1.6 0 0 0 1.6-1.5L17.8 7"/><path d="M10 11v6M14 11v6"/></svg></button></div>
  </div>`;
}
function _updateWlRow(el, it) {
  el.classList.toggle("tk-active", it.active);
  _setTxt(el, ".tk-price-val", it.priceStr);
  _setTxtCls(el, ".tk-chg-amt", it.amtStr, "tk-chg-amt " + it.chgCls);
  _setTxtCls(el, ".tk-chg", it.pctStr, "tk-chg " + it.chgCls);
}
function _buildTwRow(it) {
  const t = it.t;
  return `<div class="ticker-item${it.active ? " tk-active" : ""}${it.limitCls ? " " + it.limitCls : ""}" data-mkt="tw" data-exch="" data-sym="${t.symbol}" data-display="${t.symbol}">
    ${_twLogoHtml(t.symbol, t.name)}
    <div class="tk-info"><span class="tk-sym">${t.symbol}</span><span class="tk-full">${t.name || ""}</span></div>
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
  return `<div class="ticker-item${it.active ? " tk-active" : ""}" data-mkt="crypto" data-exch="${it.exch}" data-sym="${t.display}" data-symbol="${t.symbol}" data-display="${t.display}" data-spot="${t.spot || t.display}">
    ${it.logo}
    <div class="tk-info"><span class="tk-sym">${t.display}</span><span class="tk-full">${it.full}</span></div>
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
  // crypto 1秒；台股 10秒（setInterval 動態切換）
  _tickerTimer = setInterval(fetchTickers, _tickerMkt === "tw" ? 10000 : 1000);
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
      _tickerTimer = setInterval(fetchTickers, _tickerMkt === "tw" ? 10000 : 1000);
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
  if (_symSearchMarket === "all" || _symSearchMarket === "us" || _symSearchMarket === "tw") return;
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
  return `<div class="sym-result-item" data-idx="${idx}" data-market="crypto"
    data-symbol="${rawSym}" data-display="${name}"
    data-spot="${spot}"
    data-change_pct="${chg}" data-price="${t.price || 0}">
    <div class="sym-icon" style="background:${color}">${base.slice(0,2)}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${name}</span>
      <span class="sym-result-desc">${desc}</span>
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
  return `<div class="sym-result-item" data-idx="${idx}" data-market="tw"
    data-symbol="${id}" data-display="${id}" tabindex="${idx}">
    <div class="sym-icon" style="background:${symIconColor(id)}">${id.slice(0,2)}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${id}</span>
      <span class="sym-result-desc">${r.stock_name || r.name || ""}</span>
    </div>
    <span class="sym-result-tag">台股</span>
  </div>`;
}

// 美股搜尋結果項（data-market="us"）
function _usItemHTML(r, idx) {
  return `<div class="sym-result-item" data-idx="${idx}" data-market="us"
    data-symbol="${r.symbol}" data-display="${r.symbol}" tabindex="${idx}">
    <div class="sym-icon" style="background:${symIconColor(r.symbol)}">${r.symbol.slice(0,2).toUpperCase()}</div>
    <div class="sym-result-info">
      <span class="sym-result-name">${r.symbol}</span>
      <span class="sym-result-desc">${r.name || ""}${r.exchange ? " · " + r.exchange : ""}</span>
    </div>
    <span class="sym-result-tag">${r.type || "美股"}</span>
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

  const renderMerged = (twResults, usResults, loading) => {
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
    if (loading) html += `<div class="sym-loading">搜尋台股 / 美股中…</div>`;
    if (!html) html = `<div class="sym-empty">查無結果</div>`;
    list.innerHTML = html;
    _bindSymItems(list);
  };

  // 先把合約結果秒顯，台股/美股 API 回來後再補
  renderMerged(null, null, true);

  Promise.all([
    fetch(`/api/search?market=tw&keyword=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
    fetch(`/api/us/search?q=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : { results: [] }).catch(() => ({ results: [] })),
  ]).then(([tw, us]) => renderMerged(tw?.results || [], us?.results || [], false));
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
              (_symSearchMarket === "tw" ? "tw" : _symSearchMarket === "us" ? "us" : "crypto");
  // 選擇後切換到對應市場
  if (mkt === "tw") {
    document.getElementById("marketSelect").value = "tw";
    updateMarketUI();
  } else if (mkt === "us") {
    document.getElementById("marketSelect").value = "us";
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
  closeSymSearch();
  loadData(false);
  window._mSetTab && window._mSetTab("chart");   // 手機：搜尋選標的後直接跳圖表分頁
  renderTickers();
}

const _SYM_PLACEHOLDER = {
  all: "搜尋全部市場（合約 / 台股 / 美股）…",
  futures: "搜尋永續合約…",
  spot: "搜尋現貨…",
  tw: "搜尋台股（如 2330、台積電）…",
  us: "搜尋美股（如 AAPL、Tesla）…",
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
    if (_symSearchMarket === "us" || _symSearchMarket === "tw" || _symSearchMarket === "all") {
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
      _applySymPlaceholder();
      _renderSymSearchList();
    });
  });
}

/* ══════════════════════════════════════════
   背景分段載入（progressive loading）
══════════════════════════════════════════ */


// 每段 chunk 更新：只動 K線/量/錨點，不碰 markers 或指標
