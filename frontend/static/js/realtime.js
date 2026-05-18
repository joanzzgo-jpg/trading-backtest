function startRealtime() {
  const dot    = document.getElementById("realtimeDot");
  const market = document.getElementById("marketSelect").value;
  dot.classList.remove("hidden");
  // 各市場 polling 間隔：
  // - crypto: 1s（24/7 高波動，要每秒）
  // - tw    : 5s（MIS 即時報價，盤中夠快）
  // - us    : 5s（Finnhub overlay；無 token 時走 yfinance 15min 延遲，5s 已過剩）
  const interval = { tw: 5000, us: 5000, crypto: 1000 }[market] || 1000;
  realtimeTimer = setInterval(fetchLatest, interval);
}

function stopRealtime() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  document.getElementById("realtimeDot").classList.add("hidden");
}

async function fetchLatest() {
  if (replayActive) return;
  try {
    const res  = await fetch("/api/latest", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(buildPayload()),
    });
    if (!res.ok) return;
    const json = await res.json();
    if (!json.data?.length) return;
    const dot = document.getElementById("realtimeDot");
    if (dot) dot.classList.toggle("hidden", json.live === false);
    const _tfSec = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"1h":3600,"15m":900,"5m":300 };
    json.data.forEach(bar => {
      const t     = toTime(bar.time);
      const last  = ohlcvData[ohlcvData.length - 1];
      const lastT = last ? toTime(last.time) : 0;
      // 歷史資料模式：若新 bar 與最後一根相差 > 5 根週期，不插入（避免 2024→2026 跳躍）
      if (t > lastT && (t - lastT) > (_tfSec[currentTF] || 86400) * 5) return;
      if (t === lastT) {
        // 性能：若 OHLC 完全沒變，跳過 LWC update 與 indicator 重算（省 CPU）
        if (last.close === bar.close && last.high === bar.high && last.low === bar.low && last.open === bar.open) return;
        ohlcvData[ohlcvData.length - 1] = { ...last, ...bar };
        // 同時間不需重建 Map（key 不變）
      }
      else if (t > lastT) {
        ohlcvData.push(bar);
        if (typeof _timeToIdx !== "undefined") {
          _timeToIdx.set(bar.time, ohlcvData.length - 1);
          _secToIdx.set(t, ohlcvData.length - 1);
        }
      }
      else return;
      candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
      const _va2 = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
      volSeries.update({ time:t, value:bar.volume||0, color: bar.close>=bar.open ? C.volUp+_va2 : C.volDown+_va2 });
      const _maPeriod = S.volMaPeriod || 5;
      const _maIdx = ohlcvData.length - 1;
      if (_maIdx >= _maPeriod - 1) {
        const _maAvg = ohlcvData.slice(_maIdx - _maPeriod + 1, _maIdx + 1).reduce((s, d) => s + (d.volume || 0), 0) / _maPeriod;
        volMaSeries.update({ time: t, value: _maAvg });
      }
      updateLatestPriceLine(bar.close);
    });
    updateSymbolBar(ohlcvData);
  } catch {}
}

/* ══════════════════════════════════════════
   統一更新所有面板圖例（鉛直線跨圖同步）
══════════════════════════════════════════ */
function updateAllLegends(t) {
  // 熱路徑（每次 crosshair 移動觸發）：O(n) find 改成由 _toTimeIdxBySec 查 Map
  // 因 ohlcvData 的 time 是 ISO 字串、t 是 UNIX 秒，需另建 sec→idx 查找
  let d = null;
  if (_secToIdx && _secToIdx.has(t)) {
    d = ohlcvData[_secToIdx.get(t)];
  } else {
    d = ohlcvData.find(r => toTime(r.time) === t);
  }
  if (!d) return;

  // 符號列
  document.getElementById("symO").textContent = fmt(d.open);
  document.getElementById("symH").textContent = fmt(d.high);
  document.getElementById("symL").textContent = fmt(d.low);
  document.getElementById("symC").textContent = fmt(d.close);
  document.getElementById("symV").textContent = fmtVol(d.volume);
  const dIdx = ohlcvData.indexOf(d);
  if (dIdx > 0) _updateSymChg(d.close, ohlcvData[dIdx - 1].close);

  // BB
  if (d.bb_upper != null)
    _setLegText("legBB", `BB  U:${fmt(d.bb_upper)}  M:${fmt(d.bb_middle)}  L:${fmt(d.bb_lower)}`);

  // 成交量
  _setLegText("legVol",     `VOL  ${fmtVol(d.volume)}`);

  // KDJ
  _setLegText("legK",       `K ${n2(d.kdj_k)}`);
  _setLegText("legD",       `D ${n2(d.kdj_d)}`);
  _setLegText("legJ",       `J ${n2(d.kdj_j)}`);

  // RSI
  _setLegText("legRsi14",   `RSI 14  ${n2(d.rsi_14)}`);
  _setLegText("legRsi7",    `RSI 7  ${n2(d.rsi_7)}`);

  // MACD
  _setLegText("legMacd",    `MACD ${n2(d.macd)}`);
  _setLegText("legMacdSig", `Signal ${n2(d.macd_signal)}`);
  _setLegText("legMacdHist",`Hist ${n2(d.macd_hist)}`);
}

/* ══════════════════════════════════════════
   圖例 crosshair（單圖 hover 仍保留）
══════════════════════════════════════════ */
// 追蹤十字線是否正 hover 某根 K 棒；hover 中時 realtime poll 不覆寫上方 K 棒資訊
let _hoveredTime = null;
// 滑鼠是否在任一圖表內（mouseenter/leave 觸發；比 LWC crosshair 事件更可靠，
// 不會因為 candleSeries.update() 時短暫 fire 假事件就誤清狀態）
let _mouseOverChart = false;
function _bindChartHoverTracking() {
  ["mainChart", "kdjPane", "rsiPane", "macdPane", "winratePane"].forEach(id => {
    const el = document.getElementById(id);
    if (!el || el._hoverBound) return;
    el.addEventListener("mouseenter", () => { _mouseOverChart = true; });
    el.addEventListener("mouseleave", () => {
      _mouseOverChart = false;
      _hoveredTime = null;
    });
    el._hoverBound = true;
  });
}
function onMainCrosshair(param) {
  _hoveredTime = param.time || null;
  if (!param.time) return;
  const c = param.seriesData.get(candleSeries);
  if (c) {
    document.getElementById("symO").textContent = fmt(c.open);
    document.getElementById("symH").textContent = fmt(c.high);
    document.getElementById("symL").textContent = fmt(c.low);
    document.getElementById("symC").textContent = fmt(c.close);
    const idx = ohlcvData.findIndex(r => toTime(r.time) === param.time);
    if (idx >= 0) {
      document.getElementById("symV").textContent = fmtVol(ohlcvData[idx].volume);
      if (idx > 0) _updateSymChg(c.close, ohlcvData[idx - 1].close);
    }
  }
  const bu = param.seriesData.get(bbU)?.value;
  const bm = param.seriesData.get(bbM)?.value;
  const bl = param.seriesData.get(bbL)?.value;
  if (bu != null) _setLegText("legBB", `BB  U:${fmt(bu)}  M:${fmt(bm)}  L:${fmt(bl)}`);
}
function onVolCrosshair(param) {
  const v = param.seriesData.get(volSeries)?.value;
  if (v != null) _setLegText("legVol", `VOL  ${fmtVol(v)}`);
}
function onKdjCrosshair(param) {
  const k = param.seriesData.get(kdjK)?.value;
  const d = param.seriesData.get(kdjD)?.value;
  const j = param.seriesData.get(kdjJ)?.value;
  if (k != null) {
    _setLegText("legK", `K ${n2(k)}`);
    _setLegText("legD", `D ${n2(d)}`);
    _setLegText("legJ", `J ${n2(j)}`);
  }
}
function onRsiCrosshair(param) {
  const r14 = param.seriesData.get(rsiLine14)?.value;
  const r7  = param.seriesData.get(rsiLine7)?.value;
  if (r14 != null) {
    _setLegText("legRsi14", `RSI 14  ${n2(r14)}`);
    _setLegText("legRsi7",  `RSI 7  ${n2(r7)}`);
  }
}
function onMacdCrosshair(param) {
  const m  = param.seriesData.get(macdLine)?.value;
  const sg = param.seriesData.get(macdSignal)?.value;
  const h  = param.seriesData.get(macdHist)?.value;
  if (m != null) {
    _setLegText("legMacd",    `MACD ${n2(m)}`);
    _setLegText("legMacdSig", `Signal ${n2(sg)}`);
    _setLegText("legMacdHist",`Hist ${n2(h)}`);
  }
}

function _updateSymChg(close, prevClose) {
  const el   = document.getElementById("symChg");
  const amt  = close - prevClose;
  const pct  = prevClose ? (amt / prevClose * 100) : 0;
  const sign = amt >= 0 ? "+" : "";
  el.textContent = `${sign}${fmt(amt)}  (${sign}${pct.toFixed(2)}%)`;
  el.className   = "sym-chg " + (amt >= 0 ? "up" : "dn");
}

/* ══════════════════════════════════════════
   符號資訊 + 統計 + 明細
══════════════════════════════════════════ */
function updateSymbolBar(data) {
  const symbol  = document.getElementById("symbolInput").value.trim();
  const market  = document.getElementById("marketSelect").value;
  const exch    = document.getElementById("exchangeSelect").value;
  const tfLabel = TF_LABELS[currentTF] || currentTF;
  document.getElementById("symbolName").textContent =
    market === "tw" ? symbol : market === "us" ? symbol : symbol.replace("/", " / ");
  document.getElementById("symExchange").textContent =
    market === "tw" ? `台股 · ${tfLabel}` :
    market === "us" ? `美股 · ${tfLabel}` :
    `${exch} · ${tfLabel}`;
  if (!data.length) return;
  // 滑鼠在任一圖表內時，不要覆寫上方 OHLCV——避免 realtime poll 每秒
  // 打斷使用者觀看歷史 K 棒。滑鼠離開圖表後下次 poll 才會更新回最新。
  // 用 _mouseOverChart（mouseenter/leave）比 _hoveredTime 可靠，不會因為
  // LWC 重畫時 fire 假 crosshair 事件就誤清狀態。
  if (_mouseOverChart) return;
  const last = data[data.length-1], prev = data.length>1 ? data[data.length-2] : last;
  document.getElementById("symO").textContent = fmt(last.open);
  document.getElementById("symH").textContent = fmt(last.high);
  document.getElementById("symL").textContent = fmt(last.low);
  document.getElementById("symC").textContent = fmt(last.close);
  document.getElementById("symV").textContent = fmtVol(last.volume);
  _updateSymChg(last.close, prev.close);
}

/* ══════════════════════════════════════════
   重播 (Bar Replay)
══════════════════════════════════════════ */
