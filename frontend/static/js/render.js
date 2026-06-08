// 切標的時 abort 上一筆未完成請求；30s timeout 防止後端卡住前端
let _loadDataCtrl = null;
async function loadData(autoLoad = false) {
  if (replayActive) exitReplay();
  /* 記住切換前的可見 K 棒數量，載入後還原相同縮放比例 */
  if (mainChart) {
    const _r = mainChart.timeScale().getVisibleLogicalRange();
    if (_r) _savedBarCount = Math.round(_r.to - _r.from);
    // 若視窗已捲到歷史（右緣不貼最新棒）→ 另存可見「時間範圍」，切標的/時框後對齊同一時間段；
    // 仍在看最新（_atLatest）→ 不存，照舊貼齊最新 N 根（realtime 才會接續更新）
    const _atLatest = !_r || !ohlcvData.length || _r.to >= ohlcvData.length - 2;
    _savedTimeRange = null;
    _savedRightOffset = null;
    _savedBarSpacing = null;
    if (!_atLatest) {
      try {
        const _tr = mainChart.timeScale().getVisibleRange();
        if (_tr && _tr.from != null && _tr.to != null) _savedTimeRange = { from: _tr.from, to: _tr.to };
      } catch (e) {}
    } else if (_r && ohlcvData.length) {
      // 看最新：記住「最新棒水平位置(rightOffset)」+「縮放(barSpacing)」，切標的後讓新標的
      // 最新棒出現在使用者選的同一位置（而非每次貼回最右）。用持久選項還原，跨資料更新不會被沖掉。
      try {
        _savedRightOffset = mainChart.timeScale().scrollPosition();
        _savedBarSpacing  = mainChart.timeScale().options().barSpacing;
      } catch (e) {}
    }
  }

  stopRealtime();

  // 切標的瞬間：上方報價列立即換成新標的名稱、價格數字暫清成「—」，
  // 等 ohlcv 載入完才填新價（否則新標的名稱下會殘留舊標的價格，看起來像數值亂跳）
  if (typeof updateSymbolBar === "function") updateSymbolBar([]);   // 只更新名稱（空陣列在填價前 return）
  if (typeof _resetSymbolBarQuote === "function") _resetSymbolBarQuote();

  // 取消上次未完成的請求（連續切標的時避免疊加）
  if (_loadDataCtrl) _loadDataCtrl.abort();
  _loadDataCtrl = new AbortController();
  const myCtrl = _loadDataCtrl;
  const timeoutId = setTimeout(() => myCtrl.abort(), 30000);   // 30s 上限
  // 等 > 5s 提示「仍在載入中…」（給使用者回饋避免誤以為當機）
  const slowHint = setTimeout(() => {
    const el = document.querySelector("#loadingOverlay .loading-text");
    if (el) el.textContent = "仍在載入中… 後端可能繁忙";
  }, 5000);

  showLoading(true);
  // 智慧並行：Pionex 獨有標的（.P）ohlcv 走 Pionex API 較慢，提前發 winrate 省 2-6s；
  // Binance 標的 ohlcv 已 <1s，提前發只會讓「計算中…」動畫多顯示 0.5s 反而看起來變慢
  const _isPerpSym = /\.P$/i.test(document.getElementById("symbolInput").value.trim());
  if (_isPerpSym) fetchWinRate();
  try {
    const res  = await fetch("/api/ohlcv", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(buildPayload()),
      signal: myCtrl.signal,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "載入失敗");
    ohlcvData = json.data;
    ++_bgLoadGen; _bgLoadInProgress = false; // 取消舊的背景請求
    clearTimeout(_bgIndicatorTimer);
    _bgAnchorCache = null;
    _bgMacdCache   = null;
    _rebuildTimeIndex();  // 效能：重建 time→idx Map（O(1) 取代 findIndex）
    // 切換標的/時框：清空已展開的自動盈虧比盒（舊訊號時間不存在於新資料）
    if (typeof _clearAutoRR === "function") _clearAutoRR();
    renderAll(json.data);   // 內部 renderCandles 會清 marker，但 renderAll 結尾會重填 WR markers
    startRealtime();
    saveLastSymbol();   // 載入成功後記憶此次標的
    _updateStarBtn();
    if (!_isPerpSym) fetchWinRate();   // Binance 標的：照舊在 ohlcv 後跑
    _bgLoadOlderBars(); // 背景靜默載入更早的 K 棒
  } catch(e) {
    console.error("[loadData] error:", e.name, e.message, e);   // 給 user 看實際錯誤類型
    if (myCtrl !== _loadDataCtrl) {
      // 靜默 — 新請求接手
    } else if (!autoLoad) {
      const isAbortLike = e.name === "AbortError" || /failed to fetch/i.test(e.message || "") || myCtrl.signal.aborted;
      if (typeof showToast === "function") {
        showToast(isAbortLike ? "⏱ 載入中斷，請再試一次" : ("❌ " + (e.message || "載入失敗")));
      }
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(slowHint);
    if (myCtrl === _loadDataCtrl) showLoading(false);
  }
}


/* ══════════════════════════════════════════
   效能：time-string → ohlcvData idx Map
   給 hot path（auto-RR box、updateAllLegends、wr signals 過濾）用，
   省 findIndex 的 O(n) 線性掃描。每次 ohlcvData 變更後呼叫一次。
══════════════════════════════════════════ */
function _rebuildTimeIndex() {
  _timeToIdx = new Map();
  _secToIdx  = new Map();
  for (let i = 0; i < ohlcvData.length; i++) {
    const t = ohlcvData[i].time;
    _timeToIdx.set(t, i);
    _secToIdx.set(toTime(t), i);
  }
  ++_dataVersion;
}

/* ══════════════════════════════════════════
   渲染
══════════════════════════════════════════ */
/* 根據最後成交價動態設定主圖右側價格軸精度 */
function _applyPriceFormat(data) {
  if (!data || !data.length) return;
  const p = Math.abs(data[data.length - 1]?.close || 0);
  let precision, minMove;
  if      (p >= 100)    { precision = 2; minMove = 0.01; }
  else if (p >= 1)      { precision = 4; minMove = 0.0001; }
  else if (p >= 0.1)    { precision = 5; minMove = 0.00001; }
  else if (p >= 0.01)   { precision = 6; minMove = 0.000001; }
  else if (p >= 0.001)  { precision = 7; minMove = 0.0000001; }
  else                  { precision = 8; minMove = 0.00000001; }
  const fmt = { type: "price", precision, minMove };
  [candleSeries, bbU, bbM, bbL].forEach(s => s?.applyOptions({ priceFormat: fmt }));
}

function renderAll(data) {
  // 動態調整右側價格軸精度
  _applyPriceFormat(data);

  // 先把錨定系列設到完整時間範圍，確保各子圖時間軸對齊
  const anchorTimes = data.map(d => ({ time: toTime(d.time), value: 50 }));
  kdjAnchor.setData(anchorTimes);
  rsiAnchor.setData(anchorTimes);
  macdAnchor.setData(anchorTimes.map(d => ({ ...d, value: 0 })));

  renderCandles(data);
  renderBB(data);
  renderCRT(data);
  renderKDJCross(data);
  renderResonance(data);
  renderVolume(data);
  renderKDJ(data);
  renderRSI(data);
  renderMACD(data);
  updateSymbolBar(data);
  // renderCandles 會清空 lastWRSignalMarkers + setMarkers([])，必須在這裡重填
  // 否則切標的/TF 時即使 _lastWRSignals 已有資料，主圖也看不到進出場標記
  if (typeof _renderWRSignals === "function" && _lastWRSignals && _lastWRSignals.length) {
    _renderWRSignals();
  }

  // fit 讓各子圖時間範圍對齊
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().fitContent());

  // 還原畫面位置：
  //  1. 重整後 → _pendingRestoreRange（bar 數 + 右緣偏移）
  //  2. 切標的/時框且原本捲在歷史 → _savedTimeRange（對齊同一時間段，與新標的有重疊才用）
  //  3. 其他（看最新）→ _savedBarCount 貼齊最新 N 根，預設 50
  const _restoreByBarCount = () => {
    const ts = mainChart.timeScale();
    // 有保存縮放(barSpacing) → 用持久選項還原縮放 + 最新棒水平位置(rightOffset)。
    // 持久選項跨 setData/fitContent/背景載入都不會被沖掉（解決「切幾次後黏回右邊」）。
    if (_savedBarSpacing != null) {
      ts.applyOptions({ barSpacing: _savedBarSpacing, rightOffset: _savedRightOffset || 0 });
      return;
    }
    // 否則（首次、無保存）→ 預設貼最新 N 根
    const _prevRange = ts.getVisibleLogicalRange();
    const _barCount  = (_prevRange && _savedBarCount != null) ? _savedBarCount : 50;
    if (data.length > _barCount) {
      ts.setVisibleLogicalRange({ from: data.length - _barCount, to: data.length - 1 });
    }
  };
  if (_pendingRestoreRange) {
    const pr = _pendingRestoreRange;
    _pendingRestoreRange = null;
    if (pr.barSpacing != null) {
      // 重整還原：持久選項（縮放 + 最新棒水平位置，含右側留白）
      try { mainChart.timeScale().applyOptions({ barSpacing: pr.barSpacing, rightOffset: pr.rightOffset || 0 }); } catch (e) {}
    } else {
      const { barCount, toOffset } = pr;
      const to   = data.length - 1 - toOffset;
      const from = to - barCount;
      if (to >= 0 && to < data.length) {
        mainChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, from), to });
      }
      // to 超出資料範圍（儲存的資料比現在多）→ 維持 fitContent 顯示最新 K 棒
    }
  } else if (_savedTimeRange && data.length) {
    const _first = toTime(data[0].time), _last = toTime(data[data.length - 1].time);
    const { from, to } = _savedTimeRange;
    // 新標的/時框需與原時間段有重疊才對齊（否則該標的根本沒這段資料 → 退回 bar 數避免空白）
    if (to >= _first && from <= _last) {
      try {
        mainChart.timeScale().setVisibleRange({ from: Math.max(from, _first), to: Math.min(to, _last) });
      } catch (e) { _restoreByBarCount(); }
    } else {
      _restoreByBarCount();
    }
  } else {
    _restoreByBarCount();
  }
  _savedBarCount = null;
  _savedTimeRange = null;
  _savedRightOffset = null;
  _savedBarSpacing = null;

  // 切標的/時框：強制價格軸(右)重新自動貼合可見 K 棒。
  // 否則使用者若曾手動拖曳價格軸（autoScale 會被關閉），切到價格範圍差很多的標的時
  // K 棒會落在軸外 → 整片空白。每次載入都重開 autoScale 確保「自動顯示在有 K 棒的數值」。
  try { mainChart.priceScale("right").applyOptions({ autoScale: true }); } catch (e) {}

  resizeAll();
}

function renderCandles(data) {
  applyOhlcvToSeries(data);
  lastCRTMarkers = []; lastKDJCrossMarkers = []; lastResonanceMarkers = []; lastWRSignalMarkers = []; lastBacktestMarkers = [];
  _sortedMarkerCache = null;   // 標記陣列已清空 → 失效快取，避免平移重切視窗時殘留舊標記
  candleSeries.setMarkers([]);
}

function renderBB(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  bbU.setData(line("bb_upper")); bbM.setData(line("bb_middle")); bbL.setData(line("bb_lower"));
}

// 標記視窗化：長範圍（小時/4H 背景載入上千根）時，CRT+KDJ+共振+多空訊號會產生數千個標記，
// 一次全丟 setMarkers 會讓 LWC 每次平移/縮放/十字線都重繪全部 → 卡。只渲染「可見範圍 ±一屏」的
// 標記（通常幾百個），平移時由 _scheduleMarkerRewindow 重算 → 大幅降低 setMarkers 負擔。
function _windowMarkers(all) {
  if (!mainChart || all.length <= 400) return all;   // 少量不必視窗化
  let vr = null;
  try { vr = mainChart.timeScale().getVisibleRange(); } catch (e) {}
  if (!vr) return all;
  const span = (vr.to - vr.from) || 0;
  const lo = vr.from - span, hi = vr.to + span;       // 左右各加一屏緩衝
  // all 已依 time 升序 → 二分找 [lo, hi] 邊界再 slice，避免整列 filter（平移時上千筆每次掃描很貴）
  let a = 0, b = all.length;
  while (a < b) { const m = (a + b) >> 1; all[m].time < lo ? a = m + 1 : b = m; }   // 第一個 >= lo
  const start = a;
  b = all.length;
  while (a < b) { const m = (a + b) >> 1; all[m].time <= hi ? a = m + 1 : b = m; }  // 第一個 > hi
  return all.slice(start, a);
}

let _markerWinTimer = null;
function _scheduleMarkerRewindow() {
  clearTimeout(_markerWinTimer);
  _markerWinTimer = setTimeout(() => _applyMainMarkers(true), 100);   // 平移：只重切視窗，不重建/重排
}

// S1~S12 訊號標記一鍵開關（topbar 按鈕 #wrSignalsToggleBtn）；true=隱藏
let _wrSignalsHidden = (() => { try { return localStorage.getItem("wrSignalsHidden") === "1"; } catch (e) { return false; } })();

// 合併+排序後的全部標記快取：只在「資料/圖層開關變動」時重建；平移只重切視窗時沿用，
// 省掉每次平移都 concat 五陣列 + 整列 sort（上千筆時很貴）。
let _sortedMarkerCache = null;
function _applyMainMarkers(windowOnly) {
  if (!windowOnly || !_sortedMarkerCache) {
    const crtHidden       = document.getElementById("legCRT")?.classList.contains("line-off");
    const kdjCrossHidden  = document.getElementById("legKDJCross")?.classList.contains("line-off");
    const resonanceHidden = document.getElementById("legResonance")?.classList.contains("line-off");
    _sortedMarkerCache = [
      ...(crtHidden       ? [] : lastCRTMarkers),
      ...(kdjCrossHidden  ? [] : lastKDJCrossMarkers),
      ...(resonanceHidden ? [] : lastResonanceMarkers),
      ...(_wrSignalsHidden ? [] : lastWRSignalMarkers),
      ...lastBacktestMarkers,
    ].sort((a, b) => a.time - b.time);
  }
  candleSeries.setMarkers(_windowMarkers(_sortedMarkerCache));
}

// 頂部「S1~S12 訊號標記」一鍵開關按鈕
function initWRSignalsToggle() {
  const btn = document.getElementById("wrSignalsToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _wrSignalsHidden);   // active = 目前隱藏中
    const st = document.getElementById("mSetWrSigState");
    if (st) st.textContent = _wrSignalsHidden ? "隱藏" : "顯示";
    const row = document.getElementById("mSetWrSig");
    if (row) row.classList.toggle("m-set-on", _wrSignalsHidden);
  };
  _sync();
  btn.addEventListener("click", () => {
    _wrSignalsHidden = !_wrSignalsHidden;
    try { localStorage.setItem("wrSignalsHidden", _wrSignalsHidden ? "1" : "0"); } catch (e) {}
    _sync();
    _applyMainMarkers();
    // 切換瞬間若正 hover 某根棒，清掉已展開的 hover 勝率/RR 盒（否則殘留到下次移動才更新）
    if (typeof _updateHoverWR === "function") _updateHoverWR(null);
  });
}

function renderCRT(data) {
  const markers = [];
  data.forEach(d => {
    if (d.crt === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.crtBull, shape:"arrowUp",   size:1.5, text:"" });
    if (d.crt === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.crtBear, shape:"arrowDown", size:1.5, text:"" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastCRTMarkers = markers;
  _applyMainMarkers();
}

function renderKDJCross(data) {
  const markers = [];
  data.forEach(d => {
    if (d.kdj_cross === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.kdjCrossBull, shape:"arrowUp",   size:1.5, text:"金叉" });
    if (d.kdj_cross === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.kdjCrossBear, shape:"arrowDown", size:1.5, text:"死叉" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastKDJCrossMarkers = markers;
  _applyMainMarkers();
}

function renderResonance(data) {
  const markers = [];
  data.forEach(d => {
    if (d.resonance === 1)  markers.push({ time:toTime(d.time), position:"belowBar", color:C.resonanceBull, shape:"arrowUp",   size:1.5, text:"超賣" });
    if (d.resonance === -1) markers.push({ time:toTime(d.time), position:"aboveBar", color:C.resonanceBear, shape:"arrowDown", size:1.5, text:"超買" });
  });
  markers.sort((a,b) => a.time - b.time);
  lastResonanceMarkers = markers;
  _applyMainMarkers();
}

function renderVolume(data) {
  const _va = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
  volSeries.setData(data.map(d => ({
    time:toTime(d.time), value:d.volume||0,
    color: d.close >= d.open ? C.volUp + _va : C.volDown + _va,
  })));
  // 每次重新套用 scale 設定，避免切換標的或市場後比例跑掉
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });
  const period = Math.max(1, S.volMaPeriod);
  const maData = [];
  for (let i = period - 1; i < data.length; i++) {
    const avg = data.slice(i - period + 1, i + 1).reduce((s,d) => s + (d.volume||0), 0) / period;
    maData.push({ time:toTime(data[i].time), value:avg });
  }
  volMaSeries.setData(maData);
}

function renderKDJ(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  kdjK.setData(line("kdj_k")); kdjD.setData(line("kdj_d")); kdjJ.setData(line("kdj_j"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    kdjH20.setData([{time:f,value:S.kdjH20val},{time:l,value:S.kdjH20val}]);
    kdjH50.setData([{time:f,value:50},{time:l,value:50}]);
    kdjH80.setData([{time:f,value:S.kdjH80val},{time:l,value:S.kdjH80val}]);
  }
}

function renderRSI(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  rsiLine14.setData(line("rsi_14")); rsiLine7.setData(line("rsi_7"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    rsiH30.setData([{time:f,value:S.rsiH30val},{time:l,value:S.rsiH30val}]);
    rsiH50.setData([{time:f,value:50},{time:l,value:50}]);
    rsiH70.setData([{time:f,value:S.rsiH70val},{time:l,value:S.rsiH70val}]);
  }
}

function renderMACD(data) {
  const valid = data.filter(d => d.macd != null);
  macdLine.setData(valid.map(d => ({ time:toTime(d.time), value:d.macd })));
  macdSignal.setData(valid.map(d => ({ time:toTime(d.time), value:d.macd_signal })));
  macdHist.setData(valid.map(d => ({
    time:toTime(d.time), value:d.macd_hist,
    color: d.macd_hist >= 0 ? C.up+"cc" : C.down+"cc",
  })));
}

/* ══════════════════════════════════════════
   即時更新
══════════════════════════════════════════ */

function _bgApplyChunk(data, nPrepended) {
  // 增量建錨點（只 map 新的那段，不重建全量）
  if (_bgAnchorCache && nPrepended > 0) {
    const slice   = data.slice(0, nPrepended);
    _bgAnchorCache = [...slice.map(d => ({ time: toTime(d.time), value: 50 })), ..._bgAnchorCache];
    _bgMacdCache   = [...slice.map(d => ({ time: toTime(d.time), value: 0  })), ..._bgMacdCache];
  } else {
    _bgAnchorCache = data.map(d => ({ time: toTime(d.time), value: 50 }));
    _bgMacdCache   = data.map(d => ({ time: toTime(d.time), value: 0  }));
  }
  kdjAnchor.setData(_bgAnchorCache);
  rsiAnchor.setData(_bgAnchorCache);
  macdAnchor.setData(_bgMacdCache);
  // applyOhlcvToSeries：直接更新 candleSeries，不呼叫 setMarkers（避免 marker 清空閃爍）
  applyOhlcvToSeries(data);
  // 輕量 volume 更新（跳過 priceScale.applyOptions 避免 layout thrashing）
  const _va = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
  volSeries.setData(data.map(d => ({
    time: toTime(d.time), value: d.volume || 0,
    color: d.close >= d.open ? C.volUp + _va : C.volDown + _va,
  })));
}

// 指標 debounce：每段 chunk 後重設計時器，最後一段完成 800ms 後才計算
function _bgScheduleIndicators() {
  if (replayActive) return;
  clearTimeout(_bgIndicatorTimer);
  _bgIndicatorTimer = setTimeout(() => {
    if (!ohlcvData.length) return;
    renderBB(ohlcvData);
    renderCRT(ohlcvData);
    renderKDJCross(ohlcvData);
    renderResonance(ohlcvData);
    setTimeout(() => { renderKDJ(ohlcvData); renderRSI(ohlcvData); renderMACD(ohlcvData); }, 0);
    if (_lastWRSignals.length) _renderWRSignals();
  }, 800);
}

async function _bgLoadOlderBars(scrollTriggered = false) {
  const BG_TF = new Set(["5m", "15m", "1h", "4h"]);
  if (!BG_TF.has(currentTF) || _bgLoadInProgress || !ohlcvData.length) return;

  const snapMarket   = document.getElementById("marketSelect").value;
  const snapSymbol   = document.getElementById("symbolInput").value.trim();
  const snapTf       = currentTF;
  const snapExchange = document.getElementById("exchangeSelect").value;

  // 初始自動載入目標：只預載適量緩衝（約數千根），其餘可視範圍外的舊資料延後 → 滑動時再分頁抓
  // （scrollTriggered 走 SCROLL_DAYS）。常駐根數大降 → 縮放/平移順（5m 原 180d≈5.2萬根 → 14d≈4千根）。
  // 代價：較舊的訊號標記要滑到才顯示；勝率 HUD 統計走後端、不受影響。
  const INIT_DAYS   = { "5m": 14, "15m": 45, "1h": 120, "4h": 730 };
  const SCROLL_DAYS = { "5m": 730, "15m": 730, "1h": 1825, "4h": 3650 };
  const totalDays   = scrollTriggered ? (SCROLL_DAYS[snapTf] || 365) : (INIT_DAYS[snapTf] || 30);
  const targetStartTs = Math.floor(Date.now() / 1000) - totalDays * 86400;

  const CHUNK_DAYS = { "5m": 25, "15m": 80, "1h": 240, "4h": 950 };
  const chunkDays  = CHUNK_DAYS[snapTf] || 30;

  const toIso = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  const guard = () =>
    document.getElementById("marketSelect").value === snapMarket &&
    document.getElementById("symbolInput").value.trim() === snapSymbol &&
    currentTF === snapTf;

  // 以現有資料初始化錨點快取
  _bgAnchorCache = ohlcvData.map(d => ({ time: toTime(d.time), value: 50 }));
  _bgMacdCache   = ohlcvData.map(d => ({ time: toTime(d.time), value: 0  }));

  const myGen = ++_bgLoadGen;
  _bgLoadInProgress = true;
  let loadedThisRun = 0;                 // 本次滑動載入累計根數
  const SCROLL_BUDGET = 10000;           // 滑動每次約載這麼多根就停（5m≈35天），滑到左緣再載下一批

  try {
    while (myGen === _bgLoadGen && _bgLoadInProgress && guard()) {
      const currentEarliestTs = toTime(ohlcvData[0].time);
      if (currentEarliestTs <= targetStartTs) break;

      const endTs   = currentEarliestTs - 1;
      const startTs = Math.max(endTs - chunkDays * 86400, targetStartTs);

      const res = await fetch("/api/ohlcv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: snapMarket, symbol: snapSymbol,
          timeframe: snapTf,  exchange: snapExchange,
          start: toIso(startTs), end: toIso(endTs), limit: 0,
        }),
      });
      if (myGen !== _bgLoadGen || !res.ok) break;
      const json = await res.json();
      if (!json.data?.length || !guard() || myGen !== _bgLoadGen) break;

      const existingEarliest = toTime(ohlcvData[0].time);
      const newBars = json.data.filter(b => toTime(b.time) < existingEarliest);
      if (!newBars.length) break;

      const nPrepended = newBars.length;
      ohlcvData = newBars.concat(ohlcvData);
      _rebuildTimeIndex();  // 效能：背景載入舊 K 棒後重建 Map

      if (replayActive) {
        // 重播中：靜默累積，不碰圖表
      } else {
        // 先鎖定視圖位置，再更新資料，再確認一次（雙保險防 LWT 內部 reset）
        const visRange = mainChart.timeScale().getVisibleLogicalRange();
        const shifted  = visRange
          ? { from: visRange.from + nPrepended, to: visRange.to + nPrepended }
          : null;
        if (shifted) {
          mainChart.timeScale().setVisibleLogicalRange(shifted);
          [kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().setVisibleLogicalRange(shifted));
        }
        _bgApplyChunk(ohlcvData, nPrepended);
        if (shifted) {
          mainChart.timeScale().setVisibleLogicalRange(shifted);
          [kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().setVisibleLogicalRange(shifted));
        }
        _bgScheduleIndicators();
      }

      // 滑動觸發：累計載到 SCROLL_BUDGET 根就停（夠深、感覺連續），滑到左緣再載下一批；不一口氣
      // cascade 到 SCROLL_DAYS 把常駐撐爆。自動預載(非 scroll)仍照舊把 INIT_DAYS 緩衝補滿。
      loadedThisRun += nPrepended;
      if (scrollTriggered && loadedThisRun >= SCROLL_BUDGET) break;
      await new Promise(r => setTimeout(r, 100));
    }
  } catch { /* 背景失敗靜默 */ } finally {
    if (myGen === _bgLoadGen) {
      _bgLoadInProgress = false;
      _bgAnchorCache    = null;
      _bgMacdCache      = null;
      // 確保指標在載入完成後一定會算（重播中不算，離開重播時 exitReplay 會 renderAll）
      if (!replayActive) {
        clearTimeout(_bgIndicatorTimer);
        if (guard() && ohlcvData.length) {
          renderBB(ohlcvData); renderCRT(ohlcvData); renderKDJCross(ohlcvData); renderResonance(ohlcvData);
          setTimeout(() => { renderKDJ(ohlcvData); renderRSI(ohlcvData); renderMACD(ohlcvData); }, 0);
          if (_lastWRSignals.length) _renderWRSignals();
        }
      }
    }
  }
}

/* ══════════════════════════════════════════
   工具函式
══════════════════════════════════════════ */
