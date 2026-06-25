/* ══════════════════════════════════════════════════════════════
   主圖快速限價單：在主圖上移動選價 → 點一下設進場 → 拖曳止損/止盈 → 確認掛單
   - 只在「Crypto 市場 + 此帳號可交易」時顯示「限價單」按鈕（右上角）。
   - 進入限價模式後：滑鼠在圖上移動 → 水平導引線跟著走（價格低於現價→做多、高於→做空）。
   - 點一下 → 進入「編輯中」：圖上出現三條可拖曳的線（進場/止損/止盈），右側把手可上下拉，
     即時更新價格與盈虧比；左側確認卡的數字同步、也可直接輸入。
   - 下單一律走後端 /api/trade/order（type=LIMIT，含 sl/tp）；金鑰只在伺服器、前端只帶口令。
   - 與 trade.js 同在 bundle：直接用其 _trdApi / _TRD / _trdRefresh 與全域 mainChart/candleSeries。
   ══════════════════════════════════════════════════════════════ */
(function () {
  let _armed = false;          // 是否在限價下單模式
  let _stCache = null;         // 交易狀態快取
  let _stTs = 0;
  let _editing = false;        // 是否在「編輯止損止盈」中（暫停導引）
  let _onMove = null, _onClick = null;   // LWC 訂閱 handler（解除用）

  // 編輯中的下單草稿
  let _draft = null;           // {side, entry, sl, tp}
  let _lines = {};             // {entry:{el,handle}, sl:{...}, tp:{...}}
  let _raf = 0;                // 重新定位線條的 rAF id

  // ── 小工具 ──────────────────────────────────────────────────
  function _mainEl() { return document.getElementById("mainChart"); }
  function _market() { const s = document.getElementById("marketSelect"); return s ? s.value : "crypto"; }
  function _symbol() { const s = document.getElementById("symbolInput"); return s ? s.value.trim() : ""; }
  function _lastPx() {
    try { return (ohlcvData && ohlcvData.length) ? ohlcvData[ohlcvData.length - 1].close : null; }
    catch (e) { return null; }
  }
  function _fx(p) { return (typeof _fmtPx === "function") ? _fmtPx(p) : (p >= 1 ? p.toFixed(2) : String(+p.toPrecision(5))); }
  function _pxStr(p) { if (p == null || !isFinite(p)) return ""; return String(+(+p).toPrecision(8)); }
  function _y2px(y) { try { return candleSeries.coordinateToPrice(y); } catch (e) { return null; } }
  function _px2y(p) { try { return candleSeries.priceToCoordinate(p); } catch (e) { return null; } }

  // ── 交易狀態（15s 快取；決定按鈕顯不顯示）─────────────────────
  async function _status() {
    if (typeof _TRD !== "undefined" && _TRD && _TRD.st) return _TRD.st;
    if (_stCache && Date.now() - _stTs < 15000) return _stCache;
    try {
      const r = await fetch("/api/trade/status?name=" + encodeURIComponent(window._acctName || ""));
      _stCache = await r.json(); _stTs = Date.now();
    } catch (e) { _stCache = null; }
    return _stCache;
  }

  // ── 右上角「限價單」按鈕 ──────────────────────────────────────
  function _ensureBtn() {
    let b = document.getElementById("chartOrderBtn");
    if (b) return b;
    const host = _mainEl();
    if (!host) return null;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    b = document.createElement("button");
    b.id = "chartOrderBtn";
    b.type = "button";
    b.className = "chart-order-btn";
    b.title = "在主圖上點價位掛限價單";
    b.innerHTML = '<span class="co-ico">⚡</span><span class="co-txt">限價單</span>';
    b.addEventListener("click", () => _toggle());
    host.appendChild(b);
    return b;
  }

  async function _refreshBtn() {
    const st = await _status();
    const ok = !!(st && st.canTrade) && _market() === "crypto";
    const b = _ensureBtn();
    if (!b) return;
    b.style.display = ok ? "" : "none";
    if (!ok && _armed) _disarm();
  }

  // ── 進入 / 離開限價模式 ───────────────────────────────────────
  function _toggle() { _armed ? _disarm() : _arm(); }

  function _arm() {
    if (typeof mainChart === "undefined" || !mainChart || !candleSeries) return;
    _armed = true;
    const b = document.getElementById("chartOrderBtn");
    if (b) b.classList.add("on");
    _ensureGuide();
    _onMove = (param) => {
      if (_editing) return;
      if (!param || !param.point || !candleSeries) { _hideGuide(); return; }
      const px = _y2px(param.point.y);
      if (px == null) { _hideGuide(); return; }
      _showGuide(param.point.y, px);
    };
    _onClick = (param) => {
      if (_editing || !_armed) return;
      if (!param || !param.point || !candleSeries) return;
      const px = _y2px(param.point.y);
      if (px == null) return;
      _openEditor(px);
    };
    mainChart.subscribeCrosshairMove(_onMove);
    mainChart.subscribeClick(_onClick);
    _toast("點一下設進場價，再拖曳止損/止盈線（再按按鈕離開）");
  }

  function _disarm() {
    _armed = false;
    const b = document.getElementById("chartOrderBtn");
    if (b) b.classList.remove("on");
    try { if (_onMove) mainChart.unsubscribeCrosshairMove(_onMove); } catch (e) {}
    try { if (_onClick) mainChart.unsubscribeClick(_onClick); } catch (e) {}
    _onMove = _onClick = null;
    _hideGuide();
    _closeEditor();
  }

  // ── 導引線（點擊前跟著滑鼠的水平虛線）─────────────────────────
  let _guideLine = null, _guideTag = null;
  function _ensureGuide() {
    const host = _mainEl(); if (!host) return;
    if (!_guideLine || !_guideLine.isConnected) {
      _guideLine = document.createElement("div"); _guideLine.className = "co-guide-line"; host.appendChild(_guideLine);
    }
    if (!_guideTag || !_guideTag.isConnected) {
      _guideTag = document.createElement("div"); _guideTag.className = "co-guide-tag"; host.appendChild(_guideTag);
    }
  }
  function _showGuide(y, px) {
    _ensureGuide();
    const last = _lastPx();
    const isLong = last == null ? true : px <= last;
    _guideLine.style.top = Math.round(y) + "px"; _guideLine.style.display = "block";
    _guideLine.classList.toggle("co-long", isLong); _guideLine.classList.toggle("co-short", !isLong);
    _guideTag.style.top = Math.round(y) + "px"; _guideTag.style.display = "block";
    _guideTag.classList.toggle("co-long", isLong); _guideTag.classList.toggle("co-short", !isLong);
    _guideTag.textContent = (isLong ? "做多 限價 " : "做空 限價 ") + _fx(px);
  }
  function _hideGuide() {
    if (_guideLine) _guideLine.style.display = "none";
    if (_guideTag) _guideTag.style.display = "none";
  }

  // ── 編輯器：三條可拖曳線 + 確認卡 ─────────────────────────────
  function _readDefault(id, key, dflt) {
    const el = document.getElementById(id);
    if (el && el.value) return el.value;
    try { const v = localStorage.getItem(key); if (v) return v; } catch (e) {}
    return dflt;
  }

  function _openEditor(entryPx) {
    _closeEditor();
    _editing = true;
    _hideGuide();
    const last = _lastPx();
    const side = (last == null || entryPx <= last) ? "long" : "short";
    // 預設止損 1%、止盈 2R（在進場價的對應側）
    const risk = entryPx * 0.01;
    const sl = side === "long" ? entryPx - risk : entryPx + risk;
    const tp = side === "long" ? entryPx + 2 * risk : entryPx - 2 * risk;
    _draft = { side, entry: entryPx, sl, tp };
    _buildLines();
    _buildCard();
    _startRepos();
  }

  function _closeEditor() {
    _editing = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    Object.values(_lines).forEach(o => { try { o.el.remove(); } catch (e) {} });
    Object.values(_zones || {}).forEach(z => { try { z.remove(); } catch (e) {} });
    _lines = {}; _zones = {};
    if (_card) { try { _card.remove(); } catch (e) {} _card = null; }
    _draft = null;
  }

  // 建損益區塊（TradingView 風格：進場↔止盈綠、進場↔止損紅）+ 三條線
  let _zones = {};
  function _buildLines() {
    const host = _mainEl(); if (!host) return;
    _zones = {};
    ["tp", "sl"].forEach(k => {
      const z = document.createElement("div");
      z.className = "co-zone co-zone-" + k;
      host.appendChild(z);
      _zones[k] = z;
    });
    const defs = [["entry", "進場"], ["sl", "止損"], ["tp", "止盈"]];
    defs.forEach(([kind, label]) => {
      const el = document.createElement("div");
      el.className = "co-line co-line-" + kind;
      const handle = document.createElement("div");
      handle.className = "co-handle";
      handle.dataset.kind = kind;
      handle.dataset.label = label;
      el.appendChild(handle);
      host.appendChild(el);
      _lines[kind] = { el, handle, label };
      handle.addEventListener("pointerdown", (e) => _startDrag(e, kind));
    });
    _repos();
  }

  // 依目前 _draft 價格把三條線定位 + 更新把手文字
  function _repos() {
    if (!_draft) return;
    const e = _draft.entry;
    [["entry", _draft.entry], ["sl", _draft.sl], ["tp", _draft.tp]].forEach(([kind, px]) => {
      const o = _lines[kind]; if (!o) return;
      const y = _px2y(px);
      if (y == null) { o.el.style.display = "none"; return; }
      o.el.style.display = "block";
      o.el.style.top = Math.round(y) + "px";
      let extra = "";
      if (kind !== "entry" && e) {
        const pct = ((px - e) / e) * 100;
        extra = "　" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
      }
      o.handle.textContent = o.label + " " + _fx(px) + extra;
    });
    // 損益區塊：夾在進場 y 與 tp/sl y 之間
    const yE = _px2y(_draft.entry);
    [["tp", _draft.tp], ["sl", _draft.sl]].forEach(([k, px]) => {
      const z = _zones[k]; if (!z) return;
      const yK = _px2y(px);
      if (yE == null || yK == null) { z.style.display = "none"; return; }
      const top = Math.min(yE, yK), h = Math.abs(yE - yK);
      z.style.display = "block";
      z.style.top = Math.round(top) + "px";
      z.style.height = Math.round(h) + "px";
    });
  }

  // rAF：圖被平移/縮放時三條線跟著貼回對應價位
  function _startRepos() {
    const loop = () => { if (!_editing) return; _repos(); _raf = requestAnimationFrame(loop); };
    _raf = requestAnimationFrame(loop);
  }

  // 拖曳把手
  function _startDrag(e, kind) {
    e.preventDefault(); e.stopPropagation();
    const host = _mainEl(); if (!host) return;
    const rect = host.getBoundingClientRect();
    const move = (ev) => {
      const y = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
      const px = _y2px(y);
      if (px == null || px <= 0) return;
      _draft[kind] = px;
      // 進場線移動時，止損/止盈維持相對距離一起平移
      _repos();
      _syncCardFromDraft();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ── 確認卡 ───────────────────────────────────────────────────
  let _card = null;
  function _buildCard() {
    const host = _mainEl(); if (!host) { _editing = false; return; }
    const st = (typeof _TRD !== "undefined" && _TRD && _TRD.st) || _stCache || {};
    const live = st.env === "live";
    const usdt = _readDefault("trdUsdt", "co_usdt", "50");
    const lev = _readDefault("trdLev", "co_lev", "3");
    _card = document.createElement("div");
    _card.className = "co-card";
    _card.innerHTML =
      '<div class="co-card-head">' +
      '  <span class="co-env ' + (live ? "co-env-live" : "co-env-test") + '">' + (live ? "實盤" : "測試網") + '</span>' +
      '  <span class="co-card-sym">' + _symbol() + '</span>' +
      '  <button class="co-card-x" title="取消">×</button>' +
      '</div>' +
      '<div class="co-seg co-side">' +
      '  <button data-side="long">做多</button>' +
      '  <button data-side="short">做空</button>' +
      '</div>' +
      '<label class="co-row"><span>進場</span><input id="coEntry" inputmode="decimal"></label>' +
      '<div class="co-row2">' +
      '  <label class="co-row"><span>止損</span><input id="coSl" inputmode="decimal"></label>' +
      '  <label class="co-row"><span>止盈</span><input id="coTp" inputmode="decimal"></label>' +
      '</div>' +
      '<div class="co-row2">' +
      '  <label class="co-row"><span>保證金</span><input id="coUsdt" inputmode="decimal" value="' + usdt + '"></label>' +
      '  <label class="co-row"><span>槓桿</span><input id="coLev" inputmode="numeric" value="' + lev + '"></label>' +
      '</div>' +
      '<div class="co-rr"></div>' +
      '<button class="co-submit">確定掛單</button>';
    host.appendChild(_card);
    // 定位：左側（避開右側把手）
    const hh = host.clientHeight, ch = _card.offsetHeight || 300;
    _card.style.left = "8px";
    _card.style.top = Math.round(Math.min(Math.max(34, (hh - ch) / 2), hh - ch - 8)) + "px";

    // 互動
    _card.querySelector(".co-card-x").addEventListener("click", () => { _editing = false; _closeEditor(); });
    _card.querySelectorAll(".co-side button").forEach(btn =>
      btn.addEventListener("click", () => _setSide(btn.dataset.side)));
    // 輸入框 → 改 draft
    const bind = (id, key) => {
      const el = _card.querySelector(id);
      el.addEventListener("input", () => {
        const v = +el.value;
        if (isFinite(v) && v > 0) { _draft[key] = v; _repos(); _updRR(); }
      });
    };
    bind("#coEntry", "entry"); bind("#coSl", "sl"); bind("#coTp", "tp");
    _card.querySelector("#coUsdt").addEventListener("input", _updRR);
    _card.querySelector("#coLev").addEventListener("input", _updRR);
    _card.querySelector(".co-submit").addEventListener("click", _submit);
    _setSide(_draft.side, true);     // 標記方向按鈕
    _syncCardFromDraft();
  }

  function _setSide(side, silent) {
    _draft.side = side;
    if (_card) _card.querySelectorAll(".co-side button").forEach(b =>
      b.classList.toggle("sel", b.dataset.side === side));
    if (!silent) {
      // 切換方向 → 止損/止盈翻到進場價的正確側（沿用原距離）
      const e = _draft.entry;
      const dSl = Math.abs(e - _draft.sl) || e * 0.01;
      const dTp = Math.abs(_draft.tp - e) || e * 0.02;
      _draft.sl = side === "long" ? e - dSl : e + dSl;
      _draft.tp = side === "long" ? e + dTp : e - dTp;
      _repos();
    }
    _syncCardFromDraft();
  }

  function _syncCardFromDraft() {
    if (!_card || !_draft) return;
    const set = (id, v) => { const el = _card.querySelector(id); if (el && document.activeElement !== el) el.value = _pxStr(v); };
    set("#coEntry", _draft.entry); set("#coSl", _draft.sl); set("#coTp", _draft.tp);
    _updRR();
  }

  function _updRR() {
    if (!_card || !_draft) return;
    const e = _draft.entry, sl = _draft.sl, tp = _draft.tp;
    const riskD = Math.abs(e - sl), rewD = Math.abs(tp - e);
    const rr = riskD > 0 ? (rewD / riskD) : 0;
    const u = +_card.querySelector("#coUsdt").value || 0;
    const l = +_card.querySelector("#coLev").value || 0;
    let txt = rr ? ("盈虧比 " + rr.toFixed(2) + "R") : "";
    if (u && l) txt += (txt ? "　·　" : "") + "名目 " + _fx(u * l) + " U";
    _card.querySelector(".co-rr").textContent = txt;
  }

  async function _submit() {
    if (!_card || !_draft) return;
    const side = _draft.side;
    const price = _draft.entry, sl = _draft.sl || null, tp = _draft.tp || null;
    const usdt = +_card.querySelector("#coUsdt").value || 0;
    const lev = +_card.querySelector("#coLev").value || 3;
    const sym = _symbol();
    if (!price) { _toast("請設定進場價", true); return; }
    if (!usdt || usdt <= 0) { _toast("請填保證金", true); return; }
    // 防呆：止損須在虧損側、止盈在獲利側
    if (sl) {
      if ((side === "long" && sl >= price) || (side === "short" && sl <= price)) {
        _toast("止損方向錯誤：做" + (side === "long" ? "多止損要低於進場" : "空止損要高於進場"), true); return;
      }
    }
    if (tp) {
      if ((side === "long" && tp <= price) || (side === "short" && tp >= price)) {
        _toast("止盈方向錯誤：做" + (side === "long" ? "多止盈要高於進場" : "空止盈要低於進場"), true); return;
      }
    }
    try { localStorage.setItem("co_usdt", String(usdt)); localStorage.setItem("co_lev", String(lev)); } catch (e) {}
    const st = (typeof _TRD !== "undefined" && _TRD && _TRD.st) || _stCache || {};
    const envTxt = st.env === "live" ? "【實盤】" : "【測試網】";
    const rr = Math.abs(price - sl) > 0 ? (Math.abs(tp - price) / Math.abs(price - sl)).toFixed(2) : "—";
    if (!confirm(envTxt + (side === "long" ? "做多" : "做空") + " " + sym + "\n限價 " + _fx(price) +
      (sl ? "　止損 " + _fx(sl) : "") + (tp ? "　止盈 " + _fx(tp) : "") +
      "\n保證金 " + usdt + " × " + lev + "x = 名目 " + _fx(usdt * lev) + " U　盈虧比 " + rr + "R\n確定掛單？")) return;
    const btn = _card.querySelector(".co-submit");
    if (btn) { btn.disabled = true; btn.textContent = "掛單中…"; }
    try {
      const j = await _trdApi("order", { symbol: sym, side, type: "LIMIT", usdt, lev, price, sl, tp });
      _toast("已掛限價單 " + j.bsym + " ×" + j.qty + ((j.warn && j.warn.length) ? "（⚠ " + j.warn.join("；") + "）" : ""), j.warn && j.warn.length);
      _closeEditor();
      if (typeof _trdRefresh === "function") _trdRefresh();
    } catch (e) {
      _toast(e.message || "掛單失敗", true);
      if (btn) { btn.disabled = false; btn.textContent = "確定掛單"; }
    }
  }

  // ── 浮動提示 ─────────────────────────────────────────────────
  let _toastEl = null, _toastTmr = null;
  function _toast(msg, isErr) {
    const host = _mainEl(); if (!host) return;
    if (!_toastEl || !_toastEl.isConnected) {
      _toastEl = document.createElement("div"); _toastEl.className = "co-toast"; host.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.toggle("co-err", !!isErr);
    _toastEl.classList.add("on");
    if (_toastTmr) clearTimeout(_toastTmr);
    _toastTmr = setTimeout(() => { if (_toastEl) _toastEl.classList.remove("on"); }, isErr ? 4200 : 2600);
  }

  // ── 初始化 ───────────────────────────────────────────────────
  function init() {
    _refreshBtn();
    const si = document.getElementById("symbolInput");
    if (si) si.addEventListener("change", () => setTimeout(_refreshBtn, 50));
    const ms = document.getElementById("marketSelect");
    if (ms) ms.addEventListener("change", () => setTimeout(_refreshBtn, 50));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _armed) _disarm(); });
    setTimeout(_refreshBtn, 1500);
    setTimeout(_refreshBtn, 5000);
  }
  window._chartOrderRefresh = _refreshBtn;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
