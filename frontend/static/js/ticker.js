let _watchlist = [];
let _wlPriceCache = {}; // key: "market:exchange:symbol" → {price, change_pct, volume, ts}
function _loadWatchlist() {
  try { _watchlist = JSON.parse(localStorage.getItem("watchlist") || "[]"); } catch { _watchlist = []; }
}
function _saveWatchlist() {
  try { localStorage.setItem("watchlist", JSON.stringify(_watchlist)); } catch {}
}
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
let _tickerMkt      = "crypto";  // "crypto" | "tw"
let _tickerSort     = "desc";    // desc=漲幅 asc=跌幅 vol=成交量
let _tickerTimer    = null;
let _lastTickerKey  = "";        // 追蹤目前渲染的 ticker 結構，避免不必要的 DOM 重建
let _lastPageTitle  = "";        // 快取上次 title，避免重複寫 DOM

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

function _updateTickerPrices() {
  const container = document.getElementById("tickerList");
  if (!container) return;
  const src = _tickerMkt === "tw" ? _twTickerData : _tickerData;
  // Map 查表取代 O(n) find，整體從 O(n²) 降為 O(n)
  const srcMap = new Map();
  src.forEach(x => { srcMap.set(x.display || x.symbol, x); srcMap.set(x.symbol, x); });
  const chartLastClose = ohlcvData.length ? ohlcvData[ohlcvData.length - 1]?.close : null;
  container.querySelectorAll(".ticker-item[data-display]").forEach(el => {
    const t = srcMap.get(el.dataset.display);
    if (!t) return;
    const sign    = t.change_pct >= 0 ? "+" : "";
    const cls     = t.change_pct >= 0 ? "up" : "dn";
    const priceEl = el.querySelector(".tk-price-val");
    const chgEl   = el.querySelector(".tk-chg");
    const amtEl   = el.querySelector(".tk-chg-amt");
    const displayPrice = (el.classList.contains("tk-active") && chartLastClose != null)
      ? chartLastClose : t.price;
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
    const isMobile = window.innerWidth <= 900;
    const panelOpen = !isMobile || document.getElementById("tickerPanel").classList.contains("ticker-open");
    if (!panelOpen) { updatePageTitle(); return; }

    if (_tickerSort !== "wl") {
      const search  = (document.getElementById("tickerSearch")?.value || "").toLowerCase();
      const srcList = _tickerMkt === "tw" ? _twTickerData : _tickerData;
      let list = srcList.filter(t =>
        !search ||
        (t.display || t.symbol).toLowerCase().includes(search) ||
        (t.name || "").toLowerCase().includes(search) ||
        t.symbol.toLowerCase().includes(search)
      );
      if (_tickerSort === "asc")  list = [...list].reverse();
      if (_tickerSort === "vol")  list = [...list].sort((a, b) => b.volume - a.volume);
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
    container.innerHTML = _watchlist.map((item, i) => {
      const mktLabel = item.market === "crypto" ? (item.exchange || "crypto").toUpperCase() : item.market.toUpperCase();
      const active   = item.symbol.toUpperCase() === currentSym ? " tk-active" : "";
      let price = null, change_pct = null;
      if (item.market === "crypto") {
        const td = _tickerData.find(t =>
          t.display?.toUpperCase() === item.symbol.toUpperCase() ||
          t.symbol?.toUpperCase() === item.symbol.toUpperCase());
        if (td) { price = td.price; change_pct = td.change_pct; }
      } else {
        const key = `${item.market}:${item.exchange || ""}:${item.symbol}`;
        const c = _wlPriceCache[key];
        if (c) { price = c.price; change_pct = c.change_pct; }
      }
      const priceStr = price != null ? fmtTickerPrice(price) : "---";
      const chgCls   = change_pct != null ? (change_pct >= 0 ? "up" : "dn") : "";
      const pctStr   = change_pct != null ? (change_pct >= 0 ? "+" : "") + change_pct.toFixed(2) + "%" : mktLabel;
      const amtStr   = change_pct != null && price != null
        ? (change_pct >= 0 ? "+" : "") + _fmtAmt(price * change_pct / 100 / (1 + change_pct / 100), price) : "";
      const logo     = _coinLogoHtml(item.symbol);
      const fullName = item.market === "crypto" ? _coinFullName(item.symbol) : item.market.toUpperCase();
      return `<div class="ticker-item${active}" data-wl-idx="${i}">
        ${logo}
        <div class="tk-info">
          <span class="tk-sym">${item.symbol}</span>
          <span class="tk-full">${fullName}</span>
        </div>
        <div class="tk-prices">
          <span class="tk-price-val">${priceStr}</span>
          <div class="tk-chg-row">
            <span class="tk-chg-amt ${chgCls}">${amtStr}</span>
            <span class="tk-chg ${chgCls}">${pctStr}</span>
          </div>
        </div>
        <div class="tk-action"><button class="wl-del" title="移除">🗑</button></div>
      </div>`;
    }).join("");
    container.querySelectorAll(".ticker-item").forEach((el, i) => {
      el.querySelector(".wl-del")?.addEventListener("click", e => {
        e.stopPropagation();
        _watchlist.splice(i, 1);
        _saveWatchlist();
        renderTickers();
      });
      el.addEventListener("click", e => {
        if (e.target.closest(".wl-del")) return;
        const item = _watchlist[i];
        if (!item) return;
        document.getElementById("marketSelect").value = item.market;
        if (item.market === "crypto") document.getElementById("exchangeSelect").value = item.exchange || "pionex";
        updateMarketUI();
        document.getElementById("symbolInput").value = item.symbol;
        loadData(false);
        container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
        el.classList.add("tk-active");
      });
    });
    return;
  }

  const search = (document.getElementById("tickerSearch")?.value || "").toLowerCase();

  // ── 台股 tab ──────────────────────────────────────────
  if (_tickerMkt === "tw") {
    let list = _twTickerData.filter(t =>
      !search ||
      t.symbol.includes(search) ||
      (t.name || "").toLowerCase().includes(search)
    );
    if (_tickerSort === "asc")  list = [...list].reverse();
    if (_tickerSort === "vol")  list = [...list].sort((a, b) => b.volume - a.volume);

    container.innerHTML = list.map(t => {
      const cls       = t.change_pct >= 0 ? "up" : "dn";
      const sign      = t.change_pct >= 0 ? "+" : "";
      const active    = t.symbol === currentSym ? " tk-active" : "";
      const key       = `tw::${t.symbol}`;
      const inWl      = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
      const isLimitUp = t.change_pct >= 9.7;
      const isLimitDn = t.change_pct <= -9.7;
      const limitCls  = isLimitUp ? " tk-limit-up" : isLimitDn ? " tk-limit-dn" : "";
      const limitBadge = isLimitUp
        ? '<span class="tk-limit-badge">漲停</span>'
        : isLimitDn ? '<span class="tk-limit-badge">跌停</span>' : "";
      return `<div class="ticker-item${active}${limitCls}" data-symbol="${t.symbol}" data-display="${t.symbol}" data-mkt="tw">
        ${_twLogoHtml(t.symbol, t.name)}
        <div class="tk-info">
          <span class="tk-sym">${t.symbol}</span>
          <span class="tk-full">${t.name || ""}</span>
        </div>
        <div class="tk-prices">
          <span class="tk-price-val">${fmtTickerPrice(t.price)}</span>
          <div class="tk-chg-row">
            <span class="tk-chg-amt ${cls}">${sign}${Math.abs(t.change_amt).toFixed(2)}</span>
            <span class="tk-chg ${cls}">${sign}${t.change_pct.toFixed(2)}%</span>
            ${limitBadge}
          </div>
        </div>
        <div class="tk-action"><button class="tk-star${inWl ? " active" : ""}" title="${inWl ? "移除自選" : "加入自選"}">${_STAR_SVG}</button></div>
      </div>`;
    }).join("");

    container.querySelectorAll(".ticker-item").forEach(el => {
      el.querySelector(".tk-star")?.addEventListener("click", e => {
        e.stopPropagation();
        _toggleWatchlist(el.dataset.symbol, "tw", "");
      });
      el.addEventListener("click", e => {
        if (e.target.closest(".tk-star")) return;
        const mktEl = document.getElementById("marketSelect");
        if (mktEl.value !== "tw") { mktEl.value = "tw"; updateMarketUI(); }
        document.getElementById("symbolInput").value = el.dataset.symbol;
        loadData(false);
        container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
        el.classList.add("tk-active");
      });
    });
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
  if (_tickerSort === "asc") list = [...list].reverse();
  else if (_tickerSort === "vol") list = [...list].sort((a, b) => b.volume - a.volume);

  container.innerHTML = list.map(t => {
    const cls    = t.change_pct >= 0 ? "up" : "dn";
    const sign   = t.change_pct >= 0 ? "+" : "";
    const active = (t.display.toUpperCase() === currentSym || t.symbol.toUpperCase() === currentSym) ? " tk-active" : "";
    const key    = `crypto:${exchVal}:${t.display}`;
    const inWl   = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
    const logo   = _coinLogoHtml(t.display);
    const full   = _coinFullName(t.display);
    const amt    = t.change_amt != null ? t.change_amt : t.price * t.change_pct / 100 / (1 + t.change_pct / 100);
    const amtStr = sign + _fmtAmt(amt, t.price);
    return `<div class="ticker-item${active}" data-symbol="${t.symbol}" data-display="${t.display}" data-spot="${t.spot || t.display}">
      ${logo}
      <div class="tk-info">
        <span class="tk-sym">${t.display}</span>
        <span class="tk-full">${full}</span>
      </div>
      <div class="tk-prices">
        <span class="tk-price-val">${fmtTickerPrice(t.price)}</span>
        <div class="tk-chg-row">
          <span class="tk-chg-amt ${cls}">${amtStr}</span>
          <span class="tk-chg ${cls}">${sign}${t.change_pct.toFixed(2)}%</span>
        </div>
      </div>
      <div class="tk-action"><button class="tk-star${inWl ? " active" : ""}" title="${inWl ? "移除自選" : "加入自選"}">${_STAR_SVG}</button></div>
    </div>`;
  }).join("");

  container.querySelectorAll(".ticker-item").forEach(el => {
    el.querySelector(".tk-star")?.addEventListener("click", e => {
      e.stopPropagation();
      _toggleWatchlist(el.dataset.display, "crypto", exchVal);
    });
    el.addEventListener("click", e => {
      if (e.target.closest(".tk-star")) return;
      const mktEl  = document.getElementById("marketSelect");
      const exchEl = document.getElementById("exchangeSelect");
      if (mktEl.value !== "crypto") { mktEl.value = "crypto"; updateMarketUI(); }
      if (exchEl) exchEl.value = "pionex";
      document.getElementById("symbolInput").value = el.dataset.display;
      loadData(false);
      container.querySelectorAll(".ticker-item").forEach(x => x.classList.remove("tk-active"));
      el.classList.add("tk-active");
    });
  });
  updatePageTitle();
}

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

function bindTickerPanel() {
  // 市場切換 tab（合約 / 台股）
  document.querySelectorAll(".tk-mkt-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.mkt === _tickerMkt) return;
      document.querySelectorAll(".tk-mkt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _tickerMkt     = btn.dataset.mkt;
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
      _lastTickerKey = "";
      renderTickers();
      if (btn.dataset.sort === "wl") _refreshWlPrices();
    });
  });
  document.getElementById("tickerSearch")?.addEventListener("input", () => {
    _lastTickerKey = "";   // 搜尋條件改變→強制完整重建
    renderTickers();
  });
}

/* ══════════════════════════════════════════
   Symbol Search Modal
══════════════════════════════════════════ */
const SYM_ICON_COLORS = ["#f23645","#2196f3","#ff9800","#26a69a","#7e57c2","#e91e63","#00bcd4","#8bc34a"];
let _symSearchMarket   = "futures";
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
  _renderSymSearchList();
}

function _symItemHTML(t, idx) {
  // 從 symbol 推算 base（BTC_USDT_PERP → BTC, BTC_USDT → BTC, BTCUSDT → BTC）
  const rawSym = t.symbol || "";
  const base   = rawSym.includes("_") ? rawSym.split("_")[0]
                 : rawSym.endsWith("USDT") ? rawSym.slice(0, -4) : rawSym;
  const color  = symIconColor(base);
  const chg    = t.change_pct != null ? t.change_pct : 0;
  const cls    = chg >= 0 ? "up" : "dn";
  const sign   = chg >= 0 ? "+" : "";
  // 依當前 tab 決定顯示名稱，不依賴後端回傳的 display 欄位（防止 tab 切換時顯示錯誤格式）
  const isFut  = _symSearchMarket === "futures";
  const name   = isFut ? `${base}/USDT.P` : `${base}/USDT`;
  const desc   = isFut ? `${base} USDT 永續合約` : `${base} / USDT`;
  // 現貨代號（供 OHLCV API 使用）
  const spot   = t.spot || `${base}/USDT`;
  return `<div class="sym-result-item" data-idx="${idx}"
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

function _renderSymSearchList() {
  const list  = document.getElementById("symModalList");
  const query = (document.getElementById("symModalInput")?.value || "").toLowerCase().trim();

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
        list.innerHTML = results.map((r, i) => `
          <div class="sym-result-item" data-symbol="${r.symbol}" data-display="${r.symbol}" tabindex="${i}">
            <div class="sym-icon" style="background:${symIconColor(r.symbol)}">
              ${r.symbol.slice(0,2).toUpperCase()}
            </div>
            <div class="sym-result-info">
              <span class="sym-result-name">${r.symbol}</span>
              <span class="sym-result-desc">${r.name} · ${r.exchange}</span>
            </div>
            <span class="sym-result-tag">${r.type || "Stock"}</span>
          </div>`).join("");
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
        list.innerHTML = results.map((r, i) => `
          <div class="sym-result-item" data-symbol="${r.stock_id || r.symbol || r}" data-display="${r.stock_id || r.symbol || r}" tabindex="${i}">
            <div class="sym-icon" style="background:${symIconColor(String(r.stock_id || r.symbol || r))}">${String(r.stock_id || r.symbol || r).slice(0,2)}</div>
            <div class="sym-result-info">
              <span class="sym-result-name">${r.stock_id || r.symbol || r}</span>
              <span class="sym-result-desc">${r.stock_name || r.name || ""}</span>
            </div>
            <span class="sym-result-tag">台股</span>
          </div>`).join("");
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
  // 選擇後確保 market 與 tab 一致
  if (_symSearchMarket === "tw") {
    document.getElementById("marketSelect").value = "tw";
    updateMarketUI();
  } else if (_symSearchMarket === "us") {
    document.getElementById("marketSelect").value = "us";
    updateMarketUI();
  } else {
    // futures / spot → 確保切到 crypto market
    const mktEl = document.getElementById("marketSelect");
    if (mktEl.value !== "crypto") {
      mktEl.value = "crypto";
      updateMarketUI();  // 會先把 symbolInput 設為 "BTC/USDT"，下方再覆蓋為選到的標的
    }
  }
  // 加入搜尋歷史（台股/美股不記入 crypto 歷史）
  if (_symSearchMarket !== "tw") {
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
  renderTickers();
}

function openSymSearch() {
  const market = document.getElementById("marketSelect").value;
  document.getElementById("symOverlay").classList.remove("hidden");
  const inp = document.getElementById("symModalInput");
  inp.value = "";
  document.getElementById("symModalClear").classList.add("hidden");
  _symSearchFocusIdx = -1;
  // 依市場決定預設 tab
  _symSearchMarket = market === "us" ? "us" : market === "tw" ? "tw" : "futures";
  document.querySelectorAll(".sym-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.market === _symSearchMarket);
  });
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
    if (_symSearchMarket === "us" || _symSearchMarket === "tw") {
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
      _renderSymSearchList();
    });
  });
}

/* ══════════════════════════════════════════
   背景分段載入（progressive loading）
══════════════════════════════════════════ */


// 每段 chunk 更新：只動 K線/量/錨點，不碰 markers 或指標
