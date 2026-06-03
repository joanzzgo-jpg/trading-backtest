/* ══════════════════════════════════════════════════════════════
   策略回測 UI（backtest.js）
   兩種策略來源：
     CRT 訊號（S1~S12 / 合計）→ /api/crt_backtest（重用勝率引擎）
     通用技術（均線/RSI/MACD…）→ /api/backtest（向量化引擎）
   用目前圖表的標的/市場/交易所/時框；結果顯示績效卡 + 資金曲線（canvas）。
   ══════════════════════════════════════════════════════════════ */
(function () {
  let _built = false;

  const CRT_SIGNALS = [
    { v: "all", label: "合計（S2~S11）" },
    { v: "all11", label: "綜合（S1~S11）" },
    { v: "abc", label: "S1 訊號一（ABC）" },
    { v: "ab",  label: "S2 訊號二（AB）" },
    { v: "s3",  label: "S3 訊號三" }, { v: "s4", label: "S4 訊號四" },
    { v: "s5",  label: "S5 訊號五" }, { v: "s6", label: "S6 訊號六" },
    { v: "s7",  label: "S7 訊號七" }, { v: "s8", label: "S8 訊號八" },
    { v: "s9",  label: "S9 訊號九" }, { v: "s10", label: "S10 訊號十" },
    { v: "s11", label: "S11 訊號十一" }, { v: "s12", label: "S12 訊號十二" },
  ];

  // signal record 的 k（abc/ab/3~12）→ 顯示標籤（S1~S12）
  const _SIG_LBL = { abc: "S1", ab: "S2" };
  function _sigLabel(k) { return _SIG_LBL[k] || ("S" + k); }

  function _injectStyle() {
    if (document.getElementById("bt-style")) return;
    const s = document.createElement("style");
    s.id = "bt-style";
    s.textContent = `
    .bt-overlay{position:fixed;inset:0;z-index:60;background:rgba(8,6,4,.55);backdrop-filter:blur(4px);
      display:flex;align-items:center;justify-content:center;opacity:0;pointer-events:none;transition:opacity .2s}
    .bt-overlay.open{opacity:1;pointer-events:auto}
    .bt-modal{width:min(94vw,560px);max-height:90vh;overflow-y:auto;background:var(--panel,#1b1b1f);
      border:1px solid var(--border,#333);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);
      color:var(--text,#eee);transform:translateY(8px) scale(.98);transition:transform .2s}
    .bt-overlay.open .bt-modal{transform:none}
    .bt-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border,#333)}
    .bt-hd b{font-size:15px}
    .bt-sym{font-size:12px;color:var(--muted,#999);margin-left:8px;font-weight:400}
    .bt-x{background:none;border:none;color:var(--muted,#999);font-size:18px;cursor:pointer;line-height:1;padding:4px 8px}
    .bt-body{padding:14px 16px;display:flex;flex-direction:column;gap:12px}
    .bt-row{display:flex;align-items:center;gap:10px}
    .bt-row label{font-size:12.5px;color:var(--text,#eee);flex:0 0 84px}
    .bt-row select,.bt-row input{flex:1;background:var(--bg3,#111);border:1px solid var(--border,#333);
      color:var(--text,#eee);border-radius:7px;padding:7px 9px;font-size:13px;outline:none;min-width:0}
    .bt-row select:focus,.bt-row input:focus{border-color:var(--accent,#FF6A1A)}
    .bt-seg{display:flex;gap:4px;flex:1}
    .bt-seg button{flex:1;padding:6px;border-radius:6px;border:1px solid var(--border,#333);background:transparent;
      color:var(--muted,#999);font-size:12px;cursor:pointer}
    .bt-seg button.on{background:rgba(255,106,26,.18);border-color:var(--accent,#FF6A1A);color:var(--accent,#FF6A1A)}
    .bt-run{margin-top:2px;padding:11px;border-radius:9px;border:none;background:var(--accent,#FF6A1A);
      color:#fff;font-size:14px;font-weight:700;cursor:pointer}
    .bt-run:disabled{opacity:.6;cursor:default}
    .bt-hint{font-size:11px;color:var(--muted,#999);line-height:1.5}
    .bt-res{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--border,#333);padding-top:12px}
    .bt-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
    .bt-card{background:var(--bg3,#111);border:1px solid var(--border,#333);border-radius:9px;padding:9px 10px;text-align:center}
    .bt-card .v{font-size:16px;font-weight:800}
    .bt-card .k{font-size:10.5px;color:var(--muted,#999);margin-top:2px}
    .bt-card .v.good{color:#26d07c}.bt-card .v.bad{color:#ff6b6b}
    .bt-eq{width:100%;height:140px;background:var(--bg3,#111);border:1px solid var(--border,#333);border-radius:9px}
    .bt-err{color:#ff7a7a;font-size:13px}
    .bt-overlay .btn-ripple-wave{display:none!important}
    .bt-tbl-hd{font-size:11.5px;color:var(--muted,#999);margin-top:6px}
    .bt-tblwrap{max-height:240px;overflow:auto;border:1px solid var(--border,#333);border-radius:8px;margin-top:4px;-webkit-overflow-scrolling:touch}
    .bt-tbl{width:100%;border-collapse:collapse;font-size:11px}
    .bt-tbl th{color:var(--muted,#999);font-weight:600;text-align:right;padding:5px 6px;white-space:nowrap;
      position:sticky;top:0;background:var(--panel,#1b1b1f);border-bottom:1px solid var(--border,#333)}
    .bt-tbl td{padding:3px 6px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.05)}
    .bt-tbl tr:last-child td{border-bottom:none}
    .bt-tbl th:first-child,.bt-tbl td:first-child{text-align:left}
    .bt-w{color:#26a69a}.bt-l{color:#ef5350}
    @media(max-width:768px){.bt-row label{flex-basis:72px;font-size:12px}}
    `;
    document.head.appendChild(s);
  }

  function _build() {
    if (_built) return;
    _injectStyle();
    const ov = document.createElement("div");
    ov.className = "bt-overlay";
    ov.id = "btOverlay";
    ov.innerHTML = `
      <div class="bt-modal" role="dialog" aria-label="策略回測">
        <div class="bt-hd"><div><b>策略回測</b><span class="bt-sym" id="btSym"></span></div>
          <button class="bt-x" id="btClose" aria-label="關閉">✕</button></div>
        <div class="bt-body">
          <!-- CRT 訊號回測 -->
          <div id="btCrt">
            <div class="bt-row"><label>訊號</label>
              <select id="btCrtSig">${CRT_SIGNALS.map(s => `<option value="${s.v}">${s.label}</option>`).join("")}</select></div>
            <div class="bt-row"><label>本金</label><input id="btCap" type="number" value="100000" min="1" step="1000"></div>
            <div class="bt-row"><label>回測期間</label>
              <select id="btLookback">
                <option value="0">全部歷史</option>
                <option value="1">近 24 小時</option>
                <option value="7">近 1 週</option>
                <option value="30">近 1 個月</option>
                <option value="365">近 1 年</option>
                <option value="730">近 2 年</option>
                <option value="1095">近 3 年</option>
                <option value="1825">近 5 年</option>
              </select></div>
            <div class="bt-row"><label>方向</label>
              <div class="bt-seg" id="btDir">
                <button data-v="both" class="on">多空</button><button data-v="long">只多</button><button data-v="short">只空</button></div></div>
            <div class="bt-row"><label>目標</label>
              <div class="bt-seg" id="btTgt"><button data-v="mid" class="on">中軌</button><button data-v="band">上/下軌</button></div></div>
            <div class="bt-row"><label>止損緩衝%</label><input id="btBuf" type="number" value="0" min="0" max="10" step="0.1"></div>
            <div class="bt-row"><label>每筆風險%</label><input id="btRisk" type="number" value="2" min="0.1" max="100" step="0.5"></div>
            <div class="bt-row"><label>進場規則</label>
              <div class="bt-seg" id="btRule"><button data-v="all" class="on">全部訊號</button><button data-v="single">一次一筆</button></div></div>
            <div class="bt-hint">用 CRT 訊號的勝負序列 × 每筆預估盈虧比模擬資金曲線（重用勝率引擎，深歷史）。定額風險、單利：每筆固定冒險「本金 × 每筆風險%」。</div>
          </div>
          <button class="bt-run" id="btRun">執行回測</button>
          <div class="bt-res" id="btRes" style="display:none"></div>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.addEventListener("click", e => { if (e.target === ov) _close(); });
    ov.querySelector("#btClose").addEventListener("click", _close);
    _bindSeg("btDir"); _bindSeg("btTgt"); _bindSeg("btRule");
    ov.querySelector("#btRun").addEventListener("click", _run);
    _built = true;
  }

  function _bindSeg(id) {
    const seg = document.getElementById(id);
    if (!seg) return;
    seg.addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    });
  }
  function _segVal(id) { return document.querySelector("#" + id + " button.on")?.dataset.v; }

  function _open() {
    _build();
    const sym = document.getElementById("symbolInput")?.value || "";
    const tf = (typeof currentTF !== "undefined" ? currentTF : "1d");
    document.getElementById("btSym").textContent = `${sym} · ${tf}`;
    document.getElementById("btOverlay").classList.add("open");
  }
  function _close() { document.getElementById("btOverlay")?.classList.remove("open"); _clearTradeMarkers(); }

  function _ctx() {
    return {
      market: document.getElementById("marketSelect")?.value || "crypto",
      symbol: document.getElementById("symbolInput")?.value?.trim() || "",
      exchange: document.getElementById("exchangeSelect")?.value || "pionex",
      timeframe: (typeof currentTF !== "undefined" ? currentTF : "1d"),
    };
  }

  async function _run() {
    const btn = document.getElementById("btRun");
    const res = document.getElementById("btRes");
    const c = _ctx();
    if (!c.symbol) { return; }
    btn.disabled = true; btn.textContent = "回測中…";
    res.style.display = "block"; res.innerHTML = `<div class="bt-hint">計算中…（CRT 首次需算勝率，約數秒）</div>`;
    try {
      const body = {
        ...c,
        signal: document.getElementById("btCrtSig").value,
        direction: _segVal("btDir"),
        target: _segVal("btTgt"),
        stop_buffer_pct: (parseFloat(document.getElementById("btBuf").value) || 0) / 100,
        risk_pct: (parseFloat(document.getElementById("btRisk").value) || 2) / 100,
        initial_capital: parseFloat(document.getElementById("btCap").value) || 100000,
        lookback_days: parseInt(document.getElementById("btLookback").value, 10) || 0,
        one_position: _segVal("btRule") === "single",
      };
      const data = await _post("/api/crt_backtest", body);
      _renderResult(data);
      _applyTradeMarkers(data.trades || []);
    } catch (e) {
      res.innerHTML = `<div class="bt-err">❌ ${e.message || "回測失敗"}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = "執行回測";
    }
  }

  async function _post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "請求失敗");
    return j;
  }

  function _renderResult(d) {
    const res = document.getElementById("btRes");
    const s = d.stats || {};
    if (!s.total_trades) {
      res.innerHTML = `<div class="bt-hint">此條件下沒有交易紀錄（試試其他訊號/方向，或拉長日期範圍）。</div>`;
      return;
    }
    const ret = s.total_return ?? 0;
    const cards = [
      { k: "報酬率", v: (ret >= 0 ? "+" : "") + ret + "%", c: ret >= 0 ? "good" : "bad" },
      { k: "勝率", v: (s.win_rate ?? 0) + "%", c: (s.win_rate >= 50) ? "good" : "" },
      { k: "交易數", v: s.total_trades, c: "" },
      { k: "最大回撤", v: "-" + (s.max_drawdown ?? 0) + "%", c: "bad" },
      { k: "獲利因子", v: s.profit_factor ?? "—", c: (s.profit_factor >= 1) ? "good" : "bad" },
      { k: "平均R", v: s.avg_r ?? "—", c: "" },
      { k: "資金用量(峰)", v: s.max_use != null ? s.max_use + "%" : "—", c: (s.max_use > 100) ? "bad" : "" },
      { k: "平均持倉", v: s.avg_hold ?? "—", c: "" },
    ];
    const useLine = (s.avg_use != null)
      ? `資金用量 均${s.avg_use}% / 峰${s.max_use}%${s.max_use > 100 ? "（峰>100%需槓桿）" : ""}　持倉 均${s.avg_hold} / 最長${s.max_hold}`
      : "";
    const ruleLine = (d.entry_rule === "single")
      ? `進場規則：一次一筆（${d.n_all}筆訊號中取${d.n_taken}筆不重疊，跳過${(d.n_all ?? 0) - (d.n_taken ?? 0)}筆）`
      : "";
    res.innerHTML = `
      <div class="bt-cards">${cards.map(c => `<div class="bt-card"><div class="v ${c.c}">${c.v}</div><div class="k">${c.k}</div></div>`).join("")}</div>
      <canvas class="bt-eq" id="btEq"></canvas>
      ${ruleLine ? `<div class="bt-hint">${ruleLine}</div>` : ""}
      <div class="bt-hint">${s.from_date ? "回測自 " + s.from_date + "　" : ""}涵蓋 ${s.span ?? "—"}　最終淨值 ${(s.final_equity ?? 0).toLocaleString()}</div>
      ${useLine ? `<div class="bt-hint">${useLine}</div>` : ""}
      ${_tradesTable(d.trades || [])}`;
    _drawEquity(d.equity_curve || []);
  }

  // 最近 30 筆交易明細（trades 依結算時間升冪 → 取末 30、反轉成最新在上）
  function _tradesTable(trades) {
    if (!trades.length) return "";
    const recent = trades.slice(-30).reverse();
    const num = v => (v == null ? "—" : Math.round(v).toLocaleString());
    // 時間 +8（台灣時間，與圖表 toTime 一致）；後端時間戳為 UTC naive → 視為 UTC 再加 8 時
    const fmtT = iso => {
      if (!iso) return "—";
      const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
      d.setUTCHours(d.getUTCHours() + 8);
      const p = n => String(n).padStart(2, "0");
      return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    };
    const rows = recent.map(t => {
      const short = t.dir === "s", win = t.result === "win";
      const pnlPos = (t.pnl ?? 0) >= 0;
      return `<tr>
        <td>${fmtT(t.time)}</td>
        <td>${_sigLabel(t.sig)}</td>
        <td class="${short ? "bt-l" : "bt-w"}">${short ? "空" : "多"}</td>
        <td class="${win ? "bt-w" : "bt-l"}">${win ? "✓" : "✗"}</td>
        <td>${t.rr ?? "—"}</td>
        <td class="${pnlPos ? "bt-w" : "bt-l"}">${pnlPos ? "+" : ""}${num(t.pnl)}</td>
        <td>${t.use != null ? t.use + "%" : "—"}</td>
        <td>${t.hold || "—"}</td>
        <td>${num(t.equity)}</td>
      </tr>`;
    }).join("");
    return `
      <div class="bt-tbl-hd">最近 ${recent.length} 筆明細（新→舊）</div>
      <div class="bt-tblwrap"><table class="bt-tbl">
        <thead><tr><th>時間</th><th>訊號</th><th>向</th><th>結</th><th>R</th><th>損益</th><th>用量</th><th>持倉</th><th>淨值</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function _drawEquity(curve) {
    const cv = document.getElementById("btEq");
    if (!cv || !curve.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const vals = curve.map(p => p.equity);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = 10;
    const x = i => pad + (W - 2 * pad) * (i / Math.max(1, vals.length - 1));
    const y = v => H - pad - (H - 2 * pad) * ((v - lo) / ((hi - lo) || 1));
    const base = vals[0];
    // 基準線
    ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad, y(base)); ctx.lineTo(W - pad, y(base)); ctx.stroke(); ctx.setLineDash([]);
    // 資金曲線：依漲跌綠/紅、實線 + 填充
    const up = vals[vals.length - 1] >= base;
    ctx.strokeStyle = up ? "#26d07c" : "#ff6b6b"; ctx.lineWidth = 1.8;
    ctx.beginPath(); vals.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
    // 填充
    ctx.lineTo(x(vals.length - 1), H - pad); ctx.lineTo(x(0), H - pad); ctx.closePath();
    ctx.fillStyle = up ? "rgba(38,208,124,.12)" : "rgba(255,107,107,.12)"; ctx.fill();
  }

  // 把回測交易畫成主圖進出場標記（多/空 + 勝/負）。只取已載入 K 棒範圍內的（與勝率標記一致）。
  function _applyTradeMarkers(trades) {
    if (typeof lastBacktestMarkers === "undefined" || typeof candleSeries === "undefined") return;
    const inChart = (sec) => (typeof _secToIdx !== "undefined" && _secToIdx.size)
      ? _secToIdx.has(sec)
      : (typeof ohlcvData !== "undefined" && ohlcvData.some(d => toTime(d.time) === sec));
    const m = [];
    for (const t of (trades || [])) {
      const isShort = t.dir === "s";               // CRT 訊號方向：s=空 / l=多
      const win = t.result === "win";
      const et = t.time;                           // 進場時間
      const xt = t.exit;                           // 結算時間
      if (et) { const s = toTime(et); if (inChart(s)) m.push({ time: s, position: isShort ? "aboveBar" : "belowBar", color: isShort ? "#ef5350" : "#26a69a", shape: isShort ? "arrowDown" : "arrowUp", size: 1.3, text: isShort ? "空" : "多" }); }
      if (xt) { const s = toTime(xt); if (inChart(s)) m.push({ time: s, position: win ? (isShort ? "belowBar" : "aboveBar") : (isShort ? "aboveBar" : "belowBar"), color: win ? "#26a69a" : "#ef5350", shape: win ? (isShort ? "arrowDown" : "arrowUp") : (isShort ? "arrowUp" : "arrowDown"), size: 1.0, text: win ? "✓" : "✗" }); }
    }
    m.sort((a, b) => a.time - b.time);
    lastBacktestMarkers = m;
    if (typeof _applyMainMarkers === "function") _applyMainMarkers();
  }
  function _clearTradeMarkers() {
    if (typeof lastBacktestMarkers === "undefined") return;
    if (!lastBacktestMarkers.length) return;
    lastBacktestMarkers = [];
    if (typeof _applyMainMarkers === "function") _applyMainMarkers();
  }

  function initBacktest() {
    const btn = document.getElementById("backtestBtn");
    if (btn) btn.addEventListener("click", _open);
  }
  window.initBacktest = initBacktest;
})();
