let replayData     = [];   // 完整資料快照
let replayIdx      = 0;    // 目前顯示到第幾根
let replaySpeed    = 500;  // ms per bar
let replayTimer    = null;
let replayActive   = false;
let _replaySpan    = 50;   // 進入重播時保存的可視 bar 數
let _replayLastIdx = -1;   // 上一幀渲染的 idx，用於增量更新判斷

const _rpCal = (() => {
  const pad = n => String(n).padStart(2, "0");
  const toYmd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  let _min = "", _max = "", _sel = "", _vy = 2024, _vm = 0, _mode = "month";

  function _render() {
    _mode === "year" ? _renderYear() : _renderMonth();
  }

  function _renderMonth() {
    const titleEl = document.getElementById("rpCalTitle");
    const gridEl  = document.getElementById("rpCalGrid");
    if (!titleEl || !gridEl) return;
    titleEl.textContent = `${_vy}年 ${pad(_vm+1)}月`;
    gridEl.className = "rp-cal-grid";
    const today    = toYmd(new Date());
    const startDow = new Date(Date.UTC(_vy, _vm, 1)).getUTCDay();
    const daysInM  = new Date(Date.UTC(_vy, _vm + 1, 0)).getUTCDate();
    let html = "";
    for (let i = 0; i < startDow; i++) html += `<div class="rp-cal-day empty"></div>`;
    for (let d = 1; d <= daysInM; d++) {
      const ymd = `${_vy}-${pad(_vm+1)}-${pad(d)}`;
      let cls = "rp-cal-day";
      if (ymd === today) cls += " today";
      if (ymd === _sel)  cls += " selected";
      if ((_min && ymd < _min) || (_max && ymd > _max)) cls += " disabled";
      html += `<div class="${cls}" data-date="${ymd}">${d}</div>`;
    }
    gridEl.innerHTML = html;
    gridEl.querySelectorAll(".rp-cal-day[data-date]:not(.disabled)").forEach(el =>
      el.addEventListener("click", () => { setValue(el.dataset.date); close(); })
    );
  }

  function _renderYear() {
    const titleEl = document.getElementById("rpCalTitle");
    const gridEl  = document.getElementById("rpCalGrid");
    if (!titleEl || !gridEl) return;
    const base = Math.floor(_vy / 12) * 12;
    titleEl.textContent = `${base} – ${base + 11}`;
    gridEl.className = "rp-cal-grid rp-cal-grid--year";
    const minY = _min ? parseInt(_min) : 0;
    const maxY = _max ? parseInt(_max) : 9999;
    const selY = _sel ? parseInt(_sel) : -1;
    let html = "";
    for (let y = base; y < base + 12; y++) {
      let cls = "rp-cal-day rp-cal-year";
      if (y === _vy)  cls += " selected";
      if (y === selY && y !== _vy) cls += " today";
      if (y < minY || y > maxY) cls += " disabled";
      html += `<div class="${cls}" data-year="${y}">${y}</div>`;
    }
    gridEl.innerHTML = html;
    gridEl.querySelectorAll(".rp-cal-year[data-year]:not(.disabled)").forEach(el =>
      el.addEventListener("click", () => {
        _vy = parseInt(el.dataset.year);
        _mode = "month"; _render();
      })
    );
  }

  function _updateDisplay() {
    const el = document.getElementById("rpCalText");
    if (el) el.textContent = _sel || "請選擇日期";
  }

  function setRange(min, max) {
    _min = min; _max = max;
    const ref = _sel && _sel >= _min && _sel <= _max ? _sel : (_sel > _max ? _max : _min);
    const d = new Date((ref || max) + "T12:00:00Z");
    _vy = d.getUTCFullYear(); _vm = d.getUTCMonth();
    _render();
  }

  function setValue(ymd) {
    if (!ymd) return;
    if (_min && ymd < _min) ymd = _min;
    if (_max && ymd > _max) ymd = _max;
    _sel = ymd;
    const inp = document.getElementById("replayStartDate");
    if (inp) inp.value = ymd;
    const d = new Date(ymd + "T12:00:00Z");
    _vy = d.getUTCFullYear(); _vm = d.getUTCMonth();
    _mode = "month";
    _updateDisplay(); _render();
  }

  function getValue() { return _sel; }

  function toggle() {
    document.getElementById("rpCalPanel")?.classList.toggle("hidden");
  }

  function close() {
    _mode = "month";
    document.getElementById("rpCalPanel")?.classList.add("hidden");
  }

  function toggleMode() {
    _mode = _mode === "year" ? "month" : "year";
    _render();
  }

  function prev() {
    if (_mode === "year") { _vy -= 12; _render(); }
    else { _vm--; if (_vm < 0) { _vm = 11; _vy--; } _render(); }
  }

  function next() {
    if (_mode === "year") { _vy += 12; _render(); }
    else { _vm++; if (_vm > 11) { _vm = 0; _vy++; } _render(); }
  }

  return { setRange, setValue, getValue, toggle, close, toggleMode, prev, next };
})();

function _openReplayPicker() {
  const overlay  = document.getElementById("replayPickerOverlay");
  const dateInp  = document.getElementById("replayStartDate");
  const _toYmd = ts => {
    const d = new Date(ts * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
  };
  const _TF_HIST = { "1m":20,"5m":365,"15m":365,"1h":730,"4h":1825,"1d":3650,"1w":3650,"1M":3650 };
  const minYmd = _toYmd(Math.floor(Date.now()/1000) - (_TF_HIST[currentTF] || 365) * 86400);
  const maxYmd = _toYmd(toTime(ohlcvData[ohlcvData.length - 1].time));
  dateInp.min = minYmd; dateInp.max = maxYmd;
  const curVal = _rpCal.getValue();
  const defaultYmd = (!curVal || curVal < minYmd || curVal > maxYmd)
    ? _toYmd(toTime(ohlcvData[Math.floor(ohlcvData.length * 0.2)].time))
    : curVal;
  _rpCal.setRange(minYmd, maxYmd);
  _rpCal.setValue(defaultYmd);
  overlay.classList.remove("hidden");
  dateInp.focus();
}

async function _replayPreload(targetTs) {
  const snapMarket   = document.getElementById("marketSelect").value;
  const snapSymbol   = document.getElementById("symbolInput").value.trim();
  const snapTf       = currentTF;
  const snapExchange = document.getElementById("exchangeSelect").value;
  const CHUNK_DAYS   = { "1m":5,"5m":25,"15m":80,"1h":240,"4h":950 };
  const chunkDays    = CHUNK_DAYS[snapTf] || 60;
  const toIso        = ts => new Date(ts * 1000).toISOString().slice(0, 10);

  const myGen = ++_bgLoadGen;
  _bgLoadInProgress = true;
  try {
    while (myGen === _bgLoadGen && _bgLoadInProgress) {
      if (!ohlcvData.length) break;
      const earliest = toTime(ohlcvData[0].time);
      if (earliest <= targetTs) break;
      const endTs   = earliest - 1;
      const startTs = Math.max(endTs - chunkDays * 86400, targetTs - 86400);
      const res = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market:snapMarket, symbol:snapSymbol,
          timeframe:snapTf, exchange:snapExchange,
          start:toIso(startTs), end:toIso(endTs), limit:0 }),
      });
      if (myGen !== _bgLoadGen || !res.ok) break;
      const json = await res.json();
      if (!json.data?.length || myGen !== _bgLoadGen) break;
      const newBars = json.data.filter(b => toTime(b.time) < toTime(ohlcvData[0].time));
      if (!newBars.length) break;
      ohlcvData = newBars.concat(ohlcvData);
      if (typeof _rebuildTimeIndex === "function") _rebuildTimeIndex();
      if (_lastWRSignals.length) _renderWRSignals();  // 重新過濾顯示新範圍內的訊號
    }
  } catch { /* silent */ } finally {
    if (myGen === _bgLoadGen) _bgLoadInProgress = false;
  }
}

function enterReplay(startDate = null) {
  if (replayActive) return;
  replayActive = true;
  ++_bgLoadGen; _bgLoadInProgress = false; // 取消任何正在進行的背景載入
  clearTimeout(_bgIndicatorTimer);
  stopRealtime();
  replayData = [...ohlcvData];

  // 記住使用者目前的縮放（可視 bar 數），重播期間維持此比例
  const curRange = mainChart.timeScale().getVisibleLogicalRange();
  _replaySpan = curRange ? Math.max(10, Math.round(curRange.to - curRange.from)) : 50;

  if (startDate) {
    const targetTs = Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000);
    let idx = replayData.findIndex(b => toTime(b.time) >= targetTs);
    if (idx < 0) idx = replayData.length - 1;
    replayIdx = Math.max(_replaySpan, idx);
  } else {
    replayIdx = Math.max(_replaySpan, Math.floor(replayData.length * 0.2));
  }
  _replayLastIdx = -1;

  const scrubber = document.getElementById("replayScrubber");
  scrubber.min   = 0;
  scrubber.max   = replayData.length - 1;
  scrubber.value = replayIdx;

  const _toYmd = bar => {
    const d = new Date(toTime(bar.time) * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`;
  };
  const picker = document.getElementById("replayDatePicker");
  picker.min = _toYmd(replayData[0]);
  picker.max = _toYmd(replayData[replayData.length - 1]);

  // 讓圖表區為重播列騰出空間
  document.getElementById("chartsContainer").style.paddingBottom = "42px";
  resizeAll();

  // 進入重播：禁止自動捲動，鎖定滾輪縮放（避免 LWT 內部 reset 視圖）
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: false } })
  );

  document.getElementById("replayBar").classList.remove("hidden");
  document.getElementById("replayModeBtn").classList.add("active");
  _replayRender();
}

function exitReplay() {
  replayActive = false;
  replayTimer && clearInterval(replayTimer);
  replayTimer = null;

  document.getElementById("chartsContainer").style.paddingBottom = "";
  resizeAll();

  // 離開重播：恢復自動捲到最新 bar
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: true } })
  );

  document.getElementById("replayBar").classList.add("hidden");
  document.getElementById("replayModeBtn").classList.remove("active");
  document.getElementById("replayPlay").classList.remove("playing");
  document.getElementById("replayPlay").textContent = "▶";
  renderAll(ohlcvData.length ? ohlcvData : replayData);
}

/* 重播：以台灣時間格式化 bar 的日期，並同步日期選擇器 */
function _replayRenderDate(bar) {
  if (!bar) return;
  const t = toTime(bar.time);
  const d = new Date(t * 1000);
  const pad = n => String(n).padStart(2, "0");
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
  document.getElementById("replayDatePicker").value = ymd;
  const intraday = ["4h","1h","15m","5m","1m"].includes(currentTF);
  document.getElementById("replayTime").textContent = intraday
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : "";
}

/* 日期字串 "YYYY-MM-DD" → replayData 中第一個 >= 該日的索引 */
function _findIdxByDate(ymd) {
  for (let i = 0; i < replayData.length; i++) {
    const t = toTime(replayData[i].time);
    const d = new Date(t * 1000);
    const pad = n => String(n).padStart(2, "0");
    const barYmd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
    if (barYmd >= ymd) return Math.max(i, _replaySpan);
  }
  return replayData.length - 1;
}

/* 重播：僅更新新增的一根 K 棒（增量 update，避免全量 setData 造成閃爍） */
function _replayStep(bar) {
  const t  = toTime(bar.time);
  const _va = (typeof _volAlphaHex === "function") ? _volAlphaHex() : Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");

  candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });

  if (bar.bb_upper != null) {
    bbU.update({ time:t, value:bar.bb_upper });
    bbM.update({ time:t, value:bar.bb_middle });
    bbL.update({ time:t, value:bar.bb_lower });
    if (bar.bb_upper_1 != null) { bbU1?.update({ time:t, value:bar.bb_upper_1 }); bbL1?.update({ time:t, value:bar.bb_lower_1 }); }
  }

  kdjAnchor.update({ time:t, value:50 });
  rsiAnchor.update({ time:t, value:50 });
  macdAnchor.update({ time:t, value:0 });

  volSeries.update({ time:t, value:bar.volume||0,
    color: bar.close >= bar.open ? C.volUp + _va : C.volDown + _va });
  const period = Math.max(1, S.volMaPeriod);
  if (replayIdx >= period - 1) {
    const s = Math.max(0, replayIdx - period + 1);
    let volSum = 0;
    for (let i = s; i <= replayIdx; i++) volSum += replayData[i].volume || 0;
    volMaSeries.update({ time:t, value: volSum / period });
  }

  if (bar.kdj_k != null) {
    kdjK.update({ time:t, value:bar.kdj_k });
    kdjD.update({ time:t, value:bar.kdj_d });
    kdjJ.update({ time:t, value:bar.kdj_j });
  }
  if (bar.rsi_14 != null) rsiLine14.update({ time:t, value:bar.rsi_14 });
  if (bar.rsi_7  != null) rsiLine7.update({ time:t, value:bar.rsi_7 });
  if (bar.macd   != null) {
    macdLine.update({ time:t, value:bar.macd });
    macdSignal.update({ time:t, value:bar.macd_signal });
    macdHist.update({ time:t, value:bar.macd_hist,
      color: bar.macd_hist >= 0 ? C.up + "cc" : C.down + "cc" });
  }

  // 累積標記（增量加入，不重建）
  _applyMainMarkers();

  const _prevBar = replayIdx > 0 ? replayData[replayIdx - 1] : bar;
  updateSymbolBar([_prevBar, bar]);
}

function _replayRender() {
  const n     = replayIdx + 1;
  const range = { from: Math.max(0, n - _replaySpan - 1), to: n - 1 };
  const _setRange = () =>
    [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c?.timeScale().setVisibleLogicalRange(range));

  _blockSync = true;

  if (_replayLastIdx >= 0 && replayIdx === _replayLastIdx + 1) {
    // 逐格前進：不建陣列，直接 update 單根 K 棒
    _setRange();
    _replayStep(replayData[replayIdx]);
  } else {
    // 跳躍或倒退：只在這裡建一次 slice
    const slice = replayData.slice(0, n);
    const anchorTimes = slice.map(d => ({ time:toTime(d.time), value:50 }));
    kdjAnchor.setData(anchorTimes);
    rsiAnchor.setData(anchorTimes);
    macdAnchor.setData(anchorTimes.map(d => ({ ...d, value:0 })));
    renderCandles(slice);
    renderBB(slice);
    renderVolume(slice);
    renderKDJ(slice);
    renderRSI(slice);
    renderMACD(slice);
    updateSymbolBar(slice);
  }

  // 雙保險：update/setData 後再確認一次視圖（LWT 可能在 setData 後重設 timescale）
  _setRange();
  _blockSync = false;
  _replayLastIdx = replayIdx;

  // 重播：把 S1~S12 訊號的「多/空進場 + 已揭曉勝負」標到目前重播點為止（視覺化回測）
  if (typeof _renderWRSignals === "function" && typeof _lastWRSignals !== "undefined" && _lastWRSignals.length) {
    _renderWRSignals();
  }

  _replayRenderDate(replayData[replayIdx]);
  const pct = replayData.length > 1 ? Math.round((replayIdx / (replayData.length - 1)) * 100) : 100;
  document.getElementById("replayProgressBar").style.width = pct + "%";
  document.getElementById("replayProgress").textContent = pct + "%";
  document.getElementById("replayScrubber").value = replayIdx;

  // 重畫疊加層 → 三盤色塊/開盤標記隨重播逐根長大（_setRange 雖會觸發，這裡明確再保險一次）。
  if (typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
}

function replayPlay() {
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
    document.getElementById("replayPlay").classList.remove("playing");
    document.getElementById("replayPlay").textContent = "▶";
    return;
  }
  document.getElementById("replayPlay").classList.add("playing");
  document.getElementById("replayPlay").textContent = "⏸";
  replayTimer = setInterval(() => {
    if (replayIdx >= replayData.length - 1) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
      return;
    }
    replayIdx++;
    _replayRender();
  }, replaySpeed);
}

function replayStepForward() {
  if (replayIdx < replayData.length - 1) { replayIdx++; _replayRender(); }
}

function replayStepBack() {
  if (replayIdx > 0) { replayIdx--; _replayRender(); }
}

function bindReplayBar() {
  document.getElementById("replayExit").addEventListener("click", exitReplay);
  document.getElementById("replayPlay").addEventListener("click", replayPlay);
  document.getElementById("replayStepF").addEventListener("click", replayStepForward);
  document.getElementById("replayStepB").addEventListener("click", replayStepBack);

  document.getElementById("replayScrubber").addEventListener("input", e => {
    if (replayTimer) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
    }
    replayIdx = parseInt(e.target.value);
    _replayRender();
  });

  document.getElementById("replayDatePicker").addEventListener("change", e => {
    if (!e.target.value || !replayData.length) return;
    if (replayTimer) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById("replayPlay").classList.remove("playing");
      document.getElementById("replayPlay").textContent = "▶";
    }
    replayIdx = _findIdxByDate(e.target.value);
    _replayLastIdx = -1;
    _replayRender();
  });

  document.querySelectorAll(".rp-speed").forEach(btn => {
    btn.addEventListener("click", () => {
      replaySpeed = parseInt(btn.dataset.speed);
      document.querySelectorAll(".rp-speed").forEach(b => b.classList.toggle("active", b === btn));
      // 若正在播放，重啟 interval
      if (replayTimer) {
        clearInterval(replayTimer); replayTimer = null;
        document.getElementById("replayPlay").classList.remove("playing");
        document.getElementById("replayPlay").textContent = "▶";
        replayPlay();
      }
    });
  });
}

/* ══════════════════════════════════════════
   系統外觀顏色
══════════════════════════════════════════ */
