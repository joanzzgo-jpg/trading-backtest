/* ══════════════════════════════════════════════════════════════
   策略回測 UI（backtest.js）
   兩種策略來源：
     CRT 訊號（S1~S12 / 合計）→ /api/crt_backtest（重用勝率引擎）
     通用技術（均線/RSI/MACD…）→ /api/backtest（向量化引擎）
   用目前圖表的標的/市場/交易所/時框；結果顯示績效卡 + 資金曲線（canvas）。
   ══════════════════════════════════════════════════════════════ */
(function () {
  let _built = false;
  let _strategies = null;   // 通用策略 metadata（/api/strategies）

  const CRT_SIGNALS = [
    { v: "all", label: "合計（S2~S11）" },
    { v: "abc", label: "S1 訊號一（ABC）" },
    { v: "ab",  label: "S2 訊號二（AB）" },
    { v: "s3",  label: "S3 訊號三" }, { v: "s4", label: "S4 訊號四" },
    { v: "s5",  label: "S5 訊號五" }, { v: "s6", label: "S6 訊號六" },
    { v: "s7",  label: "S7 訊號七" }, { v: "s8", label: "S8 訊號八" },
    { v: "s9",  label: "S9 訊號九" }, { v: "s10", label: "S10 訊號十" },
    { v: "s11", label: "S11 訊號十一" }, { v: "s12", label: "S12 訊號十二" },
  ];

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
    .bt-tabs{display:flex;gap:6px}
    .bt-tab{flex:1;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:transparent;
      color:var(--muted,#999);font-size:13px;font-weight:600;cursor:pointer}
    .bt-tab.on{background:var(--accent,#FF6A1A);border-color:var(--accent,#FF6A1A);color:#fff}
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
    .bt-gen-params{display:flex;flex-direction:column;gap:8px}
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
          <div class="bt-tabs">
            <button class="bt-tab on" data-mode="crt">CRT 訊號</button>
            <button class="bt-tab" data-mode="generic">通用技術</button>
          </div>
          <!-- CRT 模式 -->
          <div id="btCrt">
            <div class="bt-row"><label>訊號</label>
              <select id="btCrtSig">${CRT_SIGNALS.map(s => `<option value="${s.v}">${s.label}</option>`).join("")}</select></div>
            <div class="bt-row"><label>方向</label>
              <div class="bt-seg" id="btDir">
                <button data-v="both" class="on">多空</button><button data-v="long">只多</button><button data-v="short">只空</button></div></div>
            <div class="bt-row"><label>目標</label>
              <div class="bt-seg" id="btTgt"><button data-v="mid" class="on">中軌</button><button data-v="band">上/下軌</button></div></div>
            <div class="bt-row"><label>止損緩衝%</label><input id="btBuf" type="number" value="0" min="0" max="10" step="0.1"></div>
            <div class="bt-row"><label>每筆風險%</label><input id="btRisk" type="number" value="2" min="0.1" max="100" step="0.5"></div>
            <div class="bt-hint">用 CRT 訊號的勝負序列 × 每筆預估盈虧比模擬資金曲線（重用勝率引擎，深歷史）。</div>
          </div>
          <!-- 通用模式 -->
          <div id="btGen" style="display:none">
            <div class="bt-row"><label>策略</label><select id="btGenSel"></select></div>
            <div class="bt-gen-params" id="btGenParams"></div>
            <div class="bt-row"><label>起始日</label><input id="btStart" type="date"></div>
            <div class="bt-row"><label>結束日</label><input id="btEnd" type="date"></div>
            <div class="bt-row"><label>本金</label><input id="btCap" type="number" value="100000" min="1" step="1000"></div>
            <div class="bt-row"><label>手續費%</label><input id="btFee" type="number" value="0.1" min="0" max="5" step="0.01"></div>
            <div class="bt-hint">用通用技術指標策略 + 向量化引擎，依下方日期範圍回測目前標的。</div>
          </div>
          <button class="bt-run" id="btRun">執行回測</button>
          <div class="bt-res" id="btRes" style="display:none"></div>
        </div>
      </div>`;
    document.body.appendChild(ov);

    ov.addEventListener("click", e => { if (e.target === ov) _close(); });
    ov.querySelector("#btClose").addEventListener("click", _close);
    ov.querySelectorAll(".bt-tab").forEach(t => t.addEventListener("click", () => _setMode(t.dataset.mode)));
    _bindSeg("btDir"); _bindSeg("btTgt");
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

  function _setMode(mode) {
    document.querySelectorAll(".bt-tab").forEach(t => t.classList.toggle("on", t.dataset.mode === mode));
    document.getElementById("btCrt").style.display = mode === "crt" ? "" : "none";
    document.getElementById("btGen").style.display = mode === "generic" ? "" : "none";
    if (mode === "generic") _ensureStrategies();
  }
  function _curMode() { return document.querySelector(".bt-tab.on")?.dataset.mode || "crt"; }

  async function _ensureStrategies() {
    const sel = document.getElementById("btGenSel");
    if (_strategies || !sel) return;
    try {
      const r = await fetch("/api/strategies");
      _strategies = await r.json();
      sel.innerHTML = Object.entries(_strategies).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("");
      sel.addEventListener("change", _renderGenParams);
      _renderGenParams();
    } catch (e) { sel.innerHTML = `<option>載入失敗</option>`; }
  }
  function _renderGenParams() {
    const sel = document.getElementById("btGenSel");
    const box = document.getElementById("btGenParams");
    if (!sel || !box || !_strategies) return;
    const def = _strategies[sel.value];
    box.innerHTML = (def?.params || []).map(p =>
      `<div class="bt-row"><label>${p.label}</label><input class="bt-gp" data-key="${p.key}" type="number" value="${p.default}" min="${p.min ?? ""}" max="${p.max ?? ""}" step="${p.type === "float" ? "0.1" : "1"}"></div>`
    ).join("");
  }

  function _open() {
    _build();
    const sym = document.getElementById("symbolInput")?.value || "";
    const tf = (typeof currentTF !== "undefined" ? currentTF : "1d");
    document.getElementById("btSym").textContent = `${sym} · ${tf}`;
    // 通用模式日期預設：近 2 年
    const end = new Date(), start = new Date(); start.setFullYear(start.getFullYear() - 2);
    const iso = d => d.toISOString().slice(0, 10);
    const se = document.getElementById("btStart"), ee = document.getElementById("btEnd");
    if (se && !se.value) se.value = iso(start);
    if (ee && !ee.value) ee.value = iso(end);
    document.getElementById("btOverlay").classList.add("open");
  }
  function _close() { document.getElementById("btOverlay")?.classList.remove("open"); }

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
      let data;
      if (_curMode() === "crt") {
        const body = {
          ...c,
          signal: document.getElementById("btCrtSig").value,
          direction: _segVal("btDir"),
          target: _segVal("btTgt"),
          stop_buffer_pct: (parseFloat(document.getElementById("btBuf").value) || 0) / 100,
          risk_pct: (parseFloat(document.getElementById("btRisk").value) || 2) / 100,
        };
        data = await _post("/api/crt_backtest", body);
      } else {
        const params = {};
        document.querySelectorAll("#btGenParams .bt-gp").forEach(i => params[i.dataset.key] = parseFloat(i.value));
        const body = {
          ...c,
          strategy_id: document.getElementById("btGenSel").value,
          strategy_params: params,
          start: document.getElementById("btStart").value,
          end: document.getElementById("btEnd").value,
          initial_capital: parseFloat(document.getElementById("btCap").value) || 100000,
          commission: (parseFloat(document.getElementById("btFee").value) || 0) / 100,
        };
        data = await _post("/api/backtest", body);
      }
      _renderResult(data);
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
      { k: (s.sharpe_ratio != null ? "夏普" : "平均R"), v: (s.sharpe_ratio != null ? s.sharpe_ratio : s.avg_r), c: "" },
    ];
    res.innerHTML = `
      <div class="bt-cards">${cards.map(c => `<div class="bt-card"><div class="v ${c.c}">${c.v}</div><div class="k">${c.k}</div></div>`).join("")}</div>
      <canvas class="bt-eq" id="btEq"></canvas>
      <div class="bt-hint">${s.from_date ? "回測自 " + s.from_date + "　" : ""}最終淨值 ${(s.final_equity ?? 0).toLocaleString()}</div>`;
    _drawEquity(d.equity_curve || []);
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
    // 資金曲線
    const up = vals[vals.length - 1] >= base;
    ctx.strokeStyle = up ? "#26d07c" : "#ff6b6b"; ctx.lineWidth = 1.8;
    ctx.beginPath(); vals.forEach((v, i) => { const px = x(i), py = y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
    // 填充
    ctx.lineTo(x(vals.length - 1), H - pad); ctx.lineTo(x(0), H - pad); ctx.closePath();
    ctx.fillStyle = up ? "rgba(38,208,124,.12)" : "rgba(255,107,107,.12)"; ctx.fill();
  }

  function initBacktest() {
    const btn = document.getElementById("backtestBtn");
    if (btn) btn.addEventListener("click", _open);
  }
  window.initBacktest = initBacktest;
})();
