let _wrCache = {};
let _wrCacheLast = null;  // 保留最近一次資料，給 toggle target 重渲用

// 目標切換（中軌 ↔ 帶軌）狀態
const _WR_VIEW_KEY = "wrTargetView";
let _wrTargetView = "mid";
try { _wrTargetView = localStorage.getItem(_WR_VIEW_KEY) || "mid"; } catch (e) {}

// 停損緩衝（%；UI 顯示 0.5 表示 0.5%，API 收 decimal 0.005）
const _WR_BUFFER_KEY = "wrStopBuffer";
let _wrStopBuffer = 0;
try { _wrStopBuffer = parseFloat(localStorage.getItem(_WR_BUFFER_KEY)) || 0; } catch (e) {}

function _initWrTargetBtn() {
  const btn = document.getElementById("wrTargetToggle");
  if (!btn) return;
  btn.textContent = _wrTargetView === "band" ? "帶" : "中";
  btn.classList.toggle("band", _wrTargetView === "band");
}

function _initWrStopBuffer() {
  const inp = document.getElementById("wrStopBuffer");
  if (!inp) return;
  inp.value = _wrStopBuffer;
  inp.addEventListener("change", () => {
    const v = Math.max(0, Math.min(10, parseFloat(inp.value) || 0));
    inp.value = v;
    _wrStopBuffer = v;
    try { localStorage.setItem(_WR_BUFFER_KEY, String(v)); } catch (e) {}
    // 緩衝變更要清掉 cache 重新抓
    _wrCache = {};
    fetchWinRate();
  });
}

function _toggleWrTarget() {
  _wrTargetView = _wrTargetView === "mid" ? "band" : "mid";
  try { localStorage.setItem(_WR_VIEW_KEY, _wrTargetView); } catch (e) {}
  _initWrTargetBtn();
  if (_wrCacheLast) _renderWinRate(_wrCacheLast);
}

async function fetchWinRate() {
  const market    = document.getElementById("marketSelect")?.value || "crypto";
  const symbol    = document.getElementById("symbolInput")?.value?.trim() || "";
  const exchange  = document.getElementById("exchangeSelect")?.value || "pionex";
  const timeframe = currentTF || "1d";
  if (!symbol) return;
  const bufDec = (_wrStopBuffer || 0) / 100;
  const cacheKey = `${market}:${symbol}:${exchange}:${timeframe}:${bufDec.toFixed(4)}`;
  if (_wrCache[cacheKey]) {
    _renderWinRate(_wrCache[cacheKey]);
    _renderWRSignals(_wrCache[cacheKey].signals);
    return;
  }
  const statusEl = document.getElementById("wrStatus");
  if (statusEl) statusEl.textContent = "計算中…";
  try {
    const p   = new URLSearchParams({ market, symbol, exchange, timeframe, stop_buffer_pct: bufDec.toFixed(4) });
    const res = await fetch("/api/crt_winrate?" + p);
    const d   = await res.json();
    if (!res.ok) throw new Error(d.detail || "failed");
    _wrCache[cacheKey] = d;
    _renderWinRate(d);
    _renderWRSignals(d.signals);
  } catch(e) {
    if (statusEl) statusEl.textContent = "—";
    lastWRSignalMarkers = [];
    _applyMainMarkers();
  }
}

function _renderWRSignals(signals) {
  if (signals !== undefined) _lastWRSignals = signals || [];
  const list = _lastWRSignals;
  const chartTimeSet = new Set(ohlcvData.map(d => toTime(d.time)));

  const allMarkers = [];

  for (const s of list) {
    const et = toTime(s.t);
    if (!chartTimeSet.has(et)) continue;

    const isShort = s.d === "s";
    const k = s.k || "abc";

    // ── 進場標記 ──
    const eColor = k === "abc" ? (isShort ? "#ff6b6b" : "#4fc3f7")
                 : k === "ab"  ? (isShort ? "#ff9800" : "#26c6da")
                 : k === "3"   ? (isShort ? "#ce93d8" : "#b39ddb")
                 : k === "4"   ? (isShort ? "#80cbc4" : "#4db6ac")
                 : k === "5"   ? (isShort ? "#ffb74d" : "#ffa726")
                 :                (isShort ? "#9fa8da" : "#7986cb");
    const eShape = k === "abc" ? "circle"
                 : k === "ab"  ? "square"
                 :                (isShort ? "arrowDown" : "arrowUp");
    const eText  = k === "abc" ? (isShort ? "空" : "多")
                 : k === "ab"  ? (isShort ? "空²" : "多²")
                 : k === "3"   ? (isShort ? "空³" : "多³")
                 : k === "4"   ? (isShort ? "空⁴" : "多⁴")
                 : k === "5"   ? (isShort ? "空⁵" : "多⁵")
                 :                (isShort ? "空⁶" : "多⁶");
    allMarkers.push({
      time: et, position: isShort ? "aboveBar" : "belowBar",
      color: eColor, shape: eShape, size: 1.2, text: eText,
    });

    // ── 結果標記（在結算那根K棒上顯示 ✓ 或 ✗）──
    if (s.r != null && s.ot) {
      const ot = toTime(s.ot);
      if (chartTimeSet.has(ot)) {
        const isWin = s.r === "w";
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

  const entryCount = list.filter(s => chartTimeSet.has(toTime(s.t))).length;
  const ss = document.getElementById("wrStatus");
  if (ss) ss.textContent = entryCount > 0 ? `${entryCount}筆` : "";
  _applyMainMarkers();
}

function _renderWinRate(d) {
  _wrCacheLast = d;
  // 依目標切換取 mid（頂層）或 band（巢狀）
  const view = (_wrTargetView === "band" && d && d.band) ? d.band : d;
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
    el.innerHTML = `<i class="tb-wr-arr ${dir}">${arrow}</i><span class="tb-wr-pct">${s.win_rate}%</span><span class="tb-wr-cnt">${s.wins}/${losses}</span>`;
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

  const sa = document.getElementById("wrAll");
  if (sa) {
    if (d.win_rate != null) {
      const good = d.win_rate >= 60, bad = d.win_rate < 45;
      sa.className = `tb-wr-total${good ? " good" : bad ? " bad" : ""}`;
      sa.textContent = `${d.win_rate}%`;
      sa.title = `${d.wins}勝 ${d.total - d.wins}負 共${d.total}筆`;
    } else {
      sa.textContent = "—"; sa.className = "tb-wr-total"; sa.removeAttribute("title");
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

  const ss = document.getElementById("wrStatus");
  if (ss) ss.textContent = "";
}

/* ══════════════════════════════════════════
   資料載入
══════════════════════════════════════════ */
