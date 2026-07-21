// 切標的時 abort 上一筆未完成請求；30s timeout 防止後端卡住前端
let _loadDataCtrl = null;
let _lastSymKey = null;   // 上次載入的 市場|標的（用來分辨「純切時框」vs「切標的」）
let _savedTfSpanSec = null;   // 純切時框(看最新)時保存的「可見時長(秒)」→ 還原＝貼最新+同時長
let _pendingAlignRange = null; // 看歷史切小時框:目標時間段初次還沒載到→先記著,背景補到涵蓋時再拉回視野
async function loadData(autoLoad = false) {
  if (replayActive) exitReplay();
  _pendingAlignRange = null;   // 新載入作廢上一次未完成的歷史對齊目標
  /* 記住切換前的可見 K 棒數量，載入後還原相同縮放比例 */
  if (mainChart) {
    const _r = mainChart.timeScale().getVisibleLogicalRange();
    if (_r) _savedBarCount = Math.round(_r.to - _r.from);
    // 若視窗已捲到歷史（右緣不貼最新棒）→ 另存可見「時間範圍」，切標的/時框後對齊同一時間段；
    // 仍在看最新（_atLatest）→ 不存，照舊貼齊最新 N 根（realtime 才會接續更新）
    const _atLatest = !_r || !ohlcvData.length || _r.to >= ohlcvData.length - 2;
    // 「純切時框(同標的)」偵測：切『標的』(symbol 變) 維持原本看最新行為(縮放+右緣)。
    const _symKeyNow = (document.getElementById("marketSelect") ? document.getElementById("marketSelect").value : "") + "|" +
                       (document.getElementById("symbolInput") ? document.getElementById("symbolInput").value.trim() : "");
    const _tfSwitch = (_lastSymKey !== null && _symKeyNow === _lastSymKey);
    _lastSymKey = _symKeyNow;
    _savedTimeRange = null;
    _savedRightOffset = null;
    _savedBarSpacing = null;
    _savedTfSpanSec = null;
    if (!_atLatest) {
      try {
        const _tr = mainChart.timeScale().getVisibleRange();
        if (_tr && _tr.from != null && _tr.to != null) _savedTimeRange = { from: _tr.from, to: _tr.to };
      } catch (e) {}
    } else if (_tfSwitch && _r && ohlcvData.length) {
      // 看最新 + 純切時框 → 記住「可見時間長度(秒)」；還原時錨定最新棒、顯示同樣時長
      //   (15m→5m 就從 12h → 仍看 12h、只是根數變多)→ 原本畫面上的繪圖不被擠出、視野不跳。
      //   絕對時間範圍不適用(1d 的 60 天在 5m 上根本畫不下)→ 用「時長 + 貼最新」才穩。
      try {
        const _tr = mainChart.timeScale().getVisibleRange();
        if (_tr && _tr.from != null && _tr.to != null) _savedTfSpanSec = Math.max(0, _tr.to - _tr.from);
      } catch (e) {}
    } else if (_r && ohlcvData.length) {
      // 看最新：記住「最新棒水平位置(rightOffset)」+「縮放(barSpacing)」，切標的後讓新標的
      // 最新棒出現在使用者選的同一位置（而非每次貼回最右）。用持久選項還原，跨資料更新不會被沖掉。
      // ⚠ 右緣留白用「可見範圍幾何」算（to − 最後棒index），不可用 scrollPosition()：
      //   scrollPosition() 只反映「使用者手動捲動量」，程式用 rightOffset 設定的留白它回 0 →
      //   切到第二個標的後留白存進 rightOffset、scrollPosition 歸 0 → 第三個標的存到 0 → 黏回右緣。
      try {
        // 夾限右緣留白：拖進右側大片空白(或前一輪還原被 fitContent 踩爛)時 to 可遠超最後棒
        // → 大 rightOffset 一旦存進錨點會被重申機制保護、每次切換複發「最右邊沒K棒」。
        // 上限=可見根數一半(至少半屏是K棒)、絕對上限 60。
        const _bcNow = Math.max(5, Math.round(_r.to - _r.from));
        _savedRightOffset = Math.min(Math.max(0, _r.to - (ohlcvData.length - 1)),
                                     Math.max(5, Math.floor(_bcNow / 2)), 60);
        _savedBarSpacing  = mainChart.timeScale().options().barSpacing;
      } catch (e) {}
    }
  }

  // 快照秒畫(_snapPaint→renderAll)會先消耗上面保存的視野變數(renderAll 結尾歸 null)→
  // 真資料到貨的第二次 renderAll 拿到 null、跳回「最新50根」。先留副本，真資料 renderAll 前還原，
  // 讓快照與真資料兩次都套用同一個視野（切標的記得縮放+平移位置）。
  const _vSave = { bc: _savedBarCount, tr: _savedTimeRange, ro: _savedRightOffset, bs: _savedBarSpacing };

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
  // 本機快照：這個標的最近看過(IndexedDB 有存)→ 先秒畫上次的圖(K棒+策略層)，
  // 真資料/勝率到貨自動覆蓋（世代守衛在下方 _snapInvalidate）。開機與切標的同一條路。
  if (typeof window._snapPaint === "function") window._snapPaint();
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
    if (typeof window._snapInvalidate === "function") window._snapInvalidate();   // 真資料落地→作廢未完成的快照繪製
    ++_bgLoadGen; _bgLoadInProgress = false; // 取消舊的背景請求
    clearTimeout(_bgIndicatorTimer);
    _bgAnchorCache = null;
    _bgMacdCache   = null;
    _rebuildTimeIndex();  // 效能：重建 time→idx Map（O(1) 取代 findIndex）
    // 切換標的/時框：清空已展開的自動盈虧比盒（舊訊號時間不存在於新資料）
    if (typeof _clearAutoRR === "function") _clearAutoRR();
    // 還原視野副本（可能已被快照秒畫的 renderAll 消耗掉）→ 真資料照樣對齊使用者的縮放+平移位置
    _savedBarCount = _vSave.bc; _savedTimeRange = _vSave.tr;
    _savedRightOffset = _vSave.ro; _savedBarSpacing = _vSave.bs;
    renderAll(json.data);   // 內部 renderCandles 會清 marker，但 renderAll 結尾會重填 WR markers
    startRealtime();
    saveLastSymbol();   // 載入成功後記憶此次標的
    if (typeof loadDrawings === "function") {   // 切換標的：載入該標的專屬繪圖並重繪
      loadDrawings();
      // 用「落定重繪」(跨 settle 視窗補幾次)：價軸 autoScale 需 ~220ms 才穩定,只重繪一次會
      // 讓線停在舊 y 座標＝偏離原價位(切標的/時框都會)。見 draw.js _renderDrawingsAfterSettle。
      if (typeof _renderDrawingsAfterSettle === "function") _renderDrawingsAfterSettle();
      else if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    }
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
    // 不再重拋:所有呼叫端都是 fire-and-forget(無 await/.catch),重拋只會變
    // unhandled rejection 雜訊(每次打錯標的/斷網都冒一顆 pageerror)。錯誤已 toast+console。
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
  // 重繪期間標記「圖表忙碌」→ 背景天氣動畫降到 ~15fps，不跟切標的/時框的重繪搶幀(省卡頓)。
  // 設兩次(現在+160ms)以覆蓋 setData/fitContent/還原視野的整段(>220ms 移動視窗)。
  try {
    const _n = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    window._chartMoveTs = _n;
    setTimeout(() => { window._chartMoveTs = (performance.now ? performance.now() : Date.now()); }, 160);
  } catch (e) {}
  // 動態調整右側價格軸精度
  _applyPriceFormat(data);

  renderCandles(data);
  renderBB(data);
  renderVolume(data);
  _renderSubcharts(data);   // 副圖(KDJ/RSI/MACD)隱藏時(預設)內部直接跳過，省 8 條 series 的 setData
  updateSymbolBar(data);
  // renderCandles 會清空 lastWRSignalMarkers + setMarkers([])，必須在這裡重填
  // 否則切標的/TF 時即使 _lastWRSignals 已有資料，主圖也看不到進出場標記
  if (typeof _renderWRSignals === "function" && _lastWRSignals && _lastWRSignals.length) {
    _renderWRSignals();
  }
  if (typeof _renderFVGTrades === "function" && _lastFVGTrades && _lastFVGTrades.length) {
    _renderFVGTrades();
  }
  if (typeof _renderFVGBreak === "function" && _lastFVGBreak && _lastFVGBreak.length) {
    _renderFVGBreak();
  }
  if (typeof _renderFVGMS === "function" && _lastFVGMS && _lastFVGMS.length) {
    _renderFVGMS();
  }
  // ⚠ 順多空(_renderFVGShun)過去漏在此重繪 → renderCandles 清空 lastFVGShunMarkers 後沒還原，
  //   每次 renderAll(切標的/背景補載/realtime 重建)後順多空就消失，要刷新重抓才回來(與多空/破多空不同步)。
  if (typeof _renderFVGShun === "function" && _lastFVGShun && _lastFVGShun.length) {
    _renderFVGShun();
  }
  if (typeof _renderFVGSpecial === "function" && _lastFVGSpecial && _lastFVGSpecial.length) {
    _renderFVGSpecial();
  }

  // fit 讓各子圖時間範圍對齊。
  // ⚠ 只在「沒有明確還原目標」時 fit：fitContent 是 LWC 延遲操作，會在下方 restore 之後
  //   某一幀才執行 → 把縮放壓到最小(全部K擠進畫面)蓋掉還原。錨點路徑靠重申搶回，但
  //   「捲到歷史→切換」的 setVisibleRange 路徑沒有重申 → span 爆炸、K 棒擠到最左＝
  //   「切標的/時框後最右邊沒有K棒」的起源(2026-07-16 修)。有還原目標時 fit 純屬有害。
  const _hasRestoreTarget = _pendingRestoreRange || _savedTimeRange || _savedBarSpacing != null || _savedTfSpanSec != null;
  if (!_hasRestoreTarget) {
    [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().fitContent());
  }

  // 還原畫面位置：
  //  1. 重整後 → _pendingRestoreRange（bar 數 + 右緣偏移）
  //  2. 切標的/時框且原本捲在歷史 → _savedTimeRange（對齊同一時間段，與新標的有重疊才用）
  //  3. 其他（看最新）→ _savedBarCount 貼齊最新 N 根，預設 50
  const _restoreByBarCount = () => {
    const ts = mainChart.timeScale();
    // 有保存縮放(barSpacing) → 用持久選項還原縮放 + 最新棒水平位置(rightOffset)。
    // 持久選項跨 setData/fitContent/背景載入都不會被沖掉（解決「切幾次後黏回右邊」）。
    if (_savedBarSpacing != null) {
      // 還原端同樣夾限 rightOffset(治「已存進垃圾值」的舊狀態:半屏K棒下限+絕對60)
      const _visN = Math.max(10, Math.round(ts.width() / Math.max(0.5, _savedBarSpacing)));
      const _roCap = Math.min(Math.max(5, Math.floor(_visN / 2)), 60);
      const opt = { barSpacing: _savedBarSpacing, rightOffset: Math.min(_savedRightOffset || 0, _roCap) };
      ts.applyOptions(opt);
      _bgPosAnchor = opt;   // 背景分頁載入每段後重套此錨點，防縮放被 fitContent 壓回 0.5
      return;
    }
    // 否則（首次、無保存）→ 預設貼最新 N 根
    const _prevRange = ts.getVisibleLogicalRange();
    const _barCount  = (_prevRange && _savedBarCount != null) ? _savedBarCount : 50;
    if (data.length > _barCount) {
      ts.setVisibleLogicalRange({ from: data.length - _barCount, to: data.length - 1 });
    }
  };
  _bgPosAnchor = null;   // 預設無錨點（捲到歷史/時間範圍還原時不鎖縮放）；下方看最新分支才設
  if (_pendingRestoreRange) {
    const pr = _pendingRestoreRange;
    _pendingRestoreRange = null;
    if (pr.barSpacing != null) {
      // 重整還原：持久選項（縮放 + 最新棒水平位置，含右側留白）。rightOffset 夾限同上
      // （localStorage 可能已存有被 fitContent 競態污染的大值 → 載入即自癒）。
      try {
        const _ts = mainChart.timeScale();
        const _visN = Math.max(10, Math.round(_ts.width() / Math.max(0.5, pr.barSpacing)));
        const _roCap = Math.min(Math.max(5, Math.floor(_visN / 2)), 60);
        const opt = { barSpacing: pr.barSpacing, rightOffset: Math.min(pr.rightOffset || 0, _roCap) };
        _ts.applyOptions(opt);
        _bgPosAnchor = opt;
      } catch (e) {}
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
    const _bc = Math.max(5, _savedBarCount || 50);   // 原可見根數＝縮放
    // 防踩重申：此路徑沒有錨點保護，延遲的 fitContent/resize 可能晚一幀把縮放壓爛
    // （span 爆成整包 K → 畫面看似「最右邊沒K棒」）。span 偏離目標 >60% 才重申，
    // 正常情況一次都不會觸發、不干擾使用者切完立即拖曳。
    const _guardRestore = (applyFn) => {
      applyFn();
      let _target = null;
      try { const r = mainChart.timeScale().getVisibleLogicalRange(); _target = r ? r.to - r.from : null; } catch (e) {}
      if (!_target) return;
      const _guard = () => {
        try {
          const r = mainChart.timeScale().getVisibleLogicalRange();
          const s = r ? r.to - r.from : null;
          if (s && (s > _target * 1.6 || s < _target * 0.4)) applyFn();
        } catch (e) {}
      };
      requestAnimationFrame(() => { _guard(); requestAnimationFrame(_guard); });
      setTimeout(_guard, 150);
      setTimeout(_guard, 380);
    };
    if (from >= _first && from <= _last) {
      // 新標的有這段歷史 → 對齊同一時間段（每個標的看到同一段時間）
      try {
        const _tr2 = { from, to: Math.min(to, _last) };
        _guardRestore(() => { try { mainChart.timeScale().setVisibleRange(_tr2); } catch (e) {} });
      } catch (e) { _restoreByBarCount(); }
    } else if (from < _first) {
      // 目標時間段比目前已載入的最早資料還早(小時框初次只載近段、或切標的歷史不同)→
      //   先貼到最早處;並記下目標,待背景補載到涵蓋此段時再把視野拉回去(_bgLoadOlderBars 內)。
      _pendingAlignRange = { from, to: Math.min(to, _last) };
      try {
        _guardRestore(() => { try { mainChart.timeScale().setVisibleLogicalRange({ from: 0, to: _bc }); } catch (e) {} });
      } catch (e) { _restoreByBarCount(); }
    } else {
      _restoreByBarCount();
    }
  } else if (_savedTfSpanSec != null && data.length >= 2) {
    // 純切時框(看最新)：貼最新棒 + 顯示同樣時長(換算成新時框的根數,夾限在可用資料內)。
    const ts = mainChart.timeScale();
    const _int = Math.max(1, toTime(data[data.length - 1].time) - toTime(data[data.length - 2].time));
    let _nb = Math.round(_savedTfSpanSec / _int);
    _nb = Math.max(10, Math.min(_nb, data.length - 1));
    ts.setVisibleLogicalRange({ from: data.length - 1 - _nb, to: data.length - 1 });
  } else {
    _restoreByBarCount();
  }
  _savedBarCount = null;
  _savedTimeRange = null;
  _savedTfSpanSec = null;
  _savedRightOffset = null;
  _savedBarSpacing = null;

  // ⚠ fitContent()（上方）是 LWC「延遲」操作，可能在本次 restore 之後的某一幀才真正執行 →
  //   把 barSpacing 壓回最小值（全部 K 擠進寬度），蓋掉剛還原的縮放；ResizeObserver 觸發的 resize
  //   也可能稍後重排。這正是「切標的有機率最新棒黏回右緣（縮放也歸零）」的根因（非固定第幾個，純時序競態）。
  //   → 看最新有錨點時，於後續數幀＋數百 ms 內重套錨點，搶贏這些延遲操作；子圖由既有 range 同步跟上。
  if (_bgPosAnchor) {
    const _a = _bgPosAnchor;
    const _reassert = () => { if (_bgPosAnchor === _a) { try { mainChart.timeScale().applyOptions(_a); } catch (e) {} } };
    requestAnimationFrame(() => { _reassert(); requestAnimationFrame(_reassert); });
    setTimeout(_reassert, 120);
    setTimeout(_reassert, 350);
  }

  // 切標的/時框：強制價格軸(右)重新自動貼合可見 K 棒。
  // 否則使用者若曾手動拖曳價格軸（autoScale 會被關閉），切到價格範圍差很多的標的時
  // K 棒會落在軸外 → 整片空白。每次載入都重開 autoScale 確保「自動顯示在有 K 棒的數值」。
  try { mainChart.priceScale("right").applyOptions({ autoScale: true }); } catch (e) {}

  resizeAll();
}

function renderCandles(data) {
  applyOhlcvToSeries(data);
  lastWRSignalMarkers = []; lastFVGTradeMarkers = []; lastFVGBBMarkers = []; lastFVGBBMarkersA = []; lastFVGBBMarkersM = []; lastFVGBreakMarkers = []; lastFVGMSMarkers = []; lastFVGShunMarkers = []; lastFVGSpecialMarkers = []; lastSMCSweepMarkers = []; lastCoachBOSMarkers = [];
  if (typeof setFVGTradeLines === "function") setFVGTradeLines([]);   // 換標的/重載 → 清舊止損止盈線，避免殘留
  _sortedMarkerCache = null;   // 標記陣列已清空 → 失效快取，避免平移重切視窗時殘留舊標記
  candleSeries.setMarkers([]);
}

function renderBB(data) {
  const line = k => data.filter(d => d[k] != null).map(d => ({ time:toTime(d.time), value:d[k] }));
  bbU.setData(line("bb_upper")); bbM.setData(line("bb_middle")); bbL.setData(line("bb_lower"));
  // 1σ 內帶(bbU1/bbL1)已移除，不再繪製
}

// 標記視窗化：長範圍（小時/4H 背景載入上千根）時，CRT+KDJ+共振+多空訊號會產生數千個標記，
// 一次全丟 setMarkers 會讓 LWC 每次平移/縮放/十字線都重繪全部 → 卡。只渲染「可見範圍 ±一屏」的
// 標記（通常幾百個），平移時由 _scheduleMarkerRewindow 重算 → 大幅降低 setMarkers 負擔。
// 回傳視窗邊界 [start, end)（不直接 slice → 呼叫端可先比對邊界沒變就整段跳過）。
function _windowMarkers(all) {
  if (!mainChart || all.length <= 400) return [0, all.length];   // 少量不必視窗化
  let vr = null;
  try { vr = mainChart.timeScale().getVisibleRange(); } catch (e) {}
  if (!vr) return [0, all.length];
  const span = (vr.to - vr.from) || 0;
  const lo = vr.from - span, hi = vr.to + span;       // 左右各加一屏緩衝
  // all 已依 time 升序 → 二分找 [lo, hi] 邊界，避免整列 filter（平移時上千筆每次掃描很貴）
  let a = 0, b = all.length;
  while (a < b) { const m = (a + b) >> 1; all[m].time < lo ? a = m + 1 : b = m; }   // 第一個 >= lo
  const start = a;
  b = all.length;
  while (a < b) { const m = (a + b) >> 1; all[m].time <= hi ? a = m + 1 : b = m; }  // 第一個 > hi
  return [start, a];
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
// 「大棒淡化」開關(window._dimBigBarOn)：標記所在 K 棒全長(high-low) > 前 10 根平均全長的 2 倍 → 淡化該棒策略標記。
// 只套三組策略標記(多/空、破多空、順多空)。淡化＝把 hex 顏色轉成低透明度 rgba。
// ⚠ 三組策略標記已改由 charts.js 的 _makeStratMarkersPrimitive 自畫，淡化判定也搬過去(共用 _dimHex)；下方 _dimBigRange 目前已無呼叫者(保留備參)。
function _dimHex(color, a = 0.26) {
  if (typeof color !== "string" || color[0] !== "#") return color;
  let h = color;
  if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function _dimBigRange(markers) {
  if (!window._dimBigBarOn || !markers || !markers.length) return markers;
  const n = ohlcvData.length;
  return markers.map(m => {
    const idx = _secToIdx.get(m.time);
    if (idx == null || idx < 10 || idx >= n) return m;      // 前 10 根不足 → 不判斷
    const range = ohlcvData[idx].high - ohlcvData[idx].low;
    let sum = 0;
    for (let i = idx - 10; i < idx; i++) sum += (ohlcvData[i].high - ohlcvData[i].low);
    return (range > (sum / 10) * 2) ? { ...m, color: _dimHex(m.color) } : m;   // >前10根平均的2倍

  });
}
let _lastMarkerWin = { cache: null, start: -1, end: -1 };   // 上次套用的視窗（同快取＋同邊界 → 整段跳過）
// 全量重建合併：一次勝率回應會讓 ~13 個圖層 render 各呼叫一次 _applyMainMarkers() →
//   同一輪 task 的多次全量重建塌成一次 microtask（concat+sort+setMarkers+止損映射+成交量重繪只跑 1 次）。
//   平移的 windowOnly 路徑維持同步；快取先同步失效，期間若平移搶先會自己走全量、排程那次再覆蓋（等冪）。
let _fullMarkerScheduled = false;
function _applyMainMarkers(windowOnly) {
  if (!windowOnly) {
    _sortedMarkerCache = null;
    if (_fullMarkerScheduled) return;
    _fullMarkerScheduled = true;
    queueMicrotask(() => { _fullMarkerScheduled = false; _applyMainMarkersNow(); });
    return;
  }
  _applyMainMarkersNow(true);
}
function _applyMainMarkersNow(windowOnly) {
  if (!windowOnly || !_sortedMarkerCache) {
    _sortedMarkerCache = [
      ...(_wrSignalsHidden ? [] : lastWRSignalMarkers),
      ...(window._fvgTradesHidden ? [] : lastFVGTradeMarkers),
      ...((window._fvgBBHidden || window._fvgBBHideD) ? [] : lastFVGBBMarkers),
      ...((window._fvgBBHidden || window._fvgBBHideA) ? [] : lastFVGBBMarkersA),
      // M版(順多/順空/順平)已從主圖移除——不再合併進標記，console 也叫不出來
      // 破多/破空·多/空·順多/順空 三組已改由 charts.js 的 _makeStratMarkersPrimitive 自畫(隨 K 棒縮放、與棒同步)→ 不再走原生 setMarkers
      ...(window._coachOn ? lastSMCSweepMarkers : []),           // SMC 掃頂/掃底(階段1:SR+SMC 教練疊加層,右上開關)
      ...(window._coachOn ? lastCoachBOSMarkers : []),           // 教練步驟5(BOS)達成點箭頭(右上開關)
    ].sort((a, b) => a.time - b.time);
    // 標記(多空/破多空)變動 → 重畫成交量，讓有標記的棒顯化、其餘淡化（僅全量重建時，平移不觸發）
    // ⚠ 重播中不重畫：重播的成交量由 replay.js 管 slice/逐根 update，整列 ohlcvData 會把未來棒洩漏進圖
    if (!(typeof replayActive !== "undefined" && replayActive)
        && typeof renderVolume === "function" && typeof ohlcvData !== "undefined" && ohlcvData.length) renderVolume(ohlcvData);
  }
  const all = _sortedMarkerCache;
  const [ws, we] = _windowMarkers(all);
  // 平移/縮放的視窗重切：同一份快取＋邊界沒變(預設標記為空/少量時幾乎每次) → setMarkers、
  // 止損線映射重掃、primitive 重繪通知全是白工 → 整段跳過（省掉平移中每 100ms 的多餘 LWC 重排）。
  if (windowOnly && _lastMarkerWin.cache === all && _lastMarkerWin.start === ws && _lastMarkerWin.end === we) return;
  _lastMarkerWin.cache = all; _lastMarkerWin.start = ws; _lastMarkerWin.end = we;
  candleSeries.setMarkers((ws === 0 && we === all.length) ? all : all.slice(ws, we));
  if (typeof window._rebuildStratSL === "function") window._rebuildStratSL();   // 策略棒→止損線映射(hover 用)
  // 策略方向標記(多/空·破多空·順多空)改由 charts.js 的 series primitive 自畫 → 資料/開關/淡化任一變動都通知它重畫
  if (typeof _stratMarkersUpdate === "function") _stratMarkersUpdate();
}
// 開關：window.toggleDimBigBar() 切換「大棒淡化」→ 重建標記快取(淡化在建快取時套用)
window.toggleDimBigBar = function (on) {
  window._dimBigBarOn = (on === undefined) ? !window._dimBigBarOn : !!on;
  _applyMainMarkers();   // 全量重建(windowOnly undefined) → 重新套淡化
  return window._dimBigBarOn;
};
// 開關：window.toggleDimVol() 切換「量淡化」(測驗)→ 通知策略貼圖重畫(淡化在 primitive draw 內即時判定)
window.toggleDimVol = function (on) {
  window._dimVolOn = (on === undefined) ? !window._dimVolOn : !!on;
  _applyMainMarkers();
  return window._dimVolOn;
};
// 開關：window.toggleDimCounterTrend() 切換「大時框順勢過濾」→ 逆大時框趨勢標記淡化(primitive draw 內即時判定)
window.toggleDimCounterTrend = function (on) {
  window._dimCounterTrendOn = (on === undefined) ? !window._dimCounterTrendOn : !!on;
  _applyMainMarkers();
  return window._dimCounterTrendOn;
};

// 頂部「S1~S12 訊號標記」一鍵開關按鈕
function initWRSignalsToggle() {
  const btn = document.getElementById("wrSignalsToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _wrSignalsHidden);   // active = 目前隱藏中
    const st = document.getElementById("mSetWrSigState");
    if (st) st.textContent = _wrSignalsHidden ? "隱藏" : "顯示";
    const row = document.getElementById("mSetWrSig");
    if (row) row.classList.toggle("m-set-on", !_wrSignalsHidden);   // 顯示中＝高亮(開)
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

  // 主圖標記系列循環鈕（全/S/SS）已退役：S1~S12 標記已移除，固定顯示全部（剩 SS）。
  window._wrSigSeries = "all";
}

// 成交量棒透明度(hex)：天氣模式(sky-show)強制不透明，否則用使用者 volAlpha。
//   原因：主圖背景透明讓天氣透出後，半透明量條會被後面持續動的天氣動畫透出→「最新棒一閃一閃/跳」。
//   不透明就擋住後面的天氣，量條穩定(天氣仍在量條間空隙與上方透出)。
function _volAlphaHex() {
  if (document.documentElement.classList.contains("sky-show")) return "ff";
  return Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
}

// 有策略標記(多/空・破多/破空)的那些棒時間集合 → 成交量顯化用
function _stratVolTimes() {
  const s = new Set();
  const add = (arr) => { if (arr) for (const m of arr) s.add(m.time); };
  if (typeof lastFVGMSMarkers    !== "undefined") add(lastFVGMSMarkers);
  if (typeof lastFVGBreakMarkers !== "undefined") add(lastFVGBreakMarkers);
  return s;
}

function renderVolume(data) {
  const _va = _volAlphaHex();
  // 有多空／破多空標記的棒 → 全亮(顯化)；其餘淡化。無任何標記時(集合空)照常顯示。
  const markSet = _stratVolTimes();
  const dimOn = markSet.size > 0;
  volSeries.setData(data.map(d => {
    const t = toTime(d.time);
    const base = d.close >= d.open ? C.volUp : C.volDown;
    const a = dimOn ? (markSet.has(t) ? "ff" : "1f") : _va;
    return { time:t, value:d.volume||0, color: base + a };
  }));
  // 每次重新套用 scale 設定，避免切換標的或市場後比例跑掉
  mainChart.priceScale("volume").applyOptions({ scaleMargins:{ top:0.80, bottom:0 }, visible:false });
  mainChart.priceScale("right").applyOptions({ scaleMargins:{ top:0.05, bottom:0.22 } });
  // 均量：rolling sum O(n)（原本每根 slice+reduce 是 O(n×period)＋n 個臨時陣列）
  const period = Math.max(1, S.volMaPeriod);
  const maData = [];
  let _sum = 0;
  for (let i = 0; i < data.length; i++) {
    _sum += (data[i].volume || 0);
    if (i >= period) _sum -= (data[i - period].volume || 0);
    if (i >= period - 1) maData.push({ time: toTime(data[i].time), value: _sum / period });
  }
  volMaSeries.setData(maData);
}

// 副圖指標(KDJ/RSI/MACD)是否隱藏——預設隱藏(localStorage.subChartsHidden 預設"1")。
// 隱藏時 renderAll/背景補載/replay 都跳過對這 8 條 series 的 setData(display:none 不繪製、純白工)。
function _subchartsHidden() {
  return !!document.getElementById("chartsContainer")?.classList.contains("subcharts-hidden");
}
// 一次繪製三個副圖(含時間軸對齊用的 3 條 anchor)。副圖隱藏時直接 return。
// 副圖 toggle 打開時，ui.js 會呼叫此函式補算一次。
function _renderSubcharts(data) {
  if (_subchartsHidden()) return;
  const anchorTimes = data.map(d => ({ time: toTime(d.time), value: 50 }));
  kdjAnchor.setData(anchorTimes);
  rsiAnchor.setData(anchorTimes);
  macdAnchor.setData(anchorTimes.map(d => ({ ...d, value: 0 })));
  renderKDJ(data);
  renderRSI(data);
  renderMACD(data);
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
  // 淡化邏輯與 renderVolume 一致：否則補載每段 chunk 都把「標記棒顯化」洗回全亮、載完才被救回（閃爍）
  const _va = _volAlphaHex();
  const _mkSet = _stratVolTimes();
  const _dimOn = _mkSet.size > 0;
  volSeries.setData(data.map(d => {
    const t = toTime(d.time);
    const base = d.close >= d.open ? C.volUp : C.volDown;
    return { time: t, value: d.volume || 0, color: base + (_dimOn ? (_mkSet.has(t) ? "ff" : "1f") : _va) };
  }));
}

// 指標 debounce：每段 chunk 後重設計時器，最後一段完成 800ms 後才計算
function _bgScheduleIndicators() {
  if (replayActive) return;
  clearTimeout(_bgIndicatorTimer);
  _bgIndicatorTimer = setTimeout(() => {
    if (!ohlcvData.length) return;
    renderBB(ohlcvData);
    if (!_subchartsHidden()) setTimeout(() => { renderKDJ(ohlcvData); renderRSI(ohlcvData); renderMACD(ohlcvData); }, 0);
    if (_lastWRSignals.length) _renderWRSignals();
  }, 800);
}

async function _bgLoadOlderBars(scrollTriggered = false) {
  const BG_TF = new Set(["1m", "5m", "15m", "1h", "4h"]);
  if (!BG_TF.has(currentTF) || _bgLoadInProgress || !ohlcvData.length) return;

  const snapMarket   = document.getElementById("marketSelect").value;
  const snapSymbol   = document.getElementById("symbolInput").value.trim();
  const snapTf       = currentTF;
  const snapExchange = document.getElementById("exchangeSelect").value;

  // 初始自動載入目標：只預載適量緩衝（約數千根），其餘可視範圍外的舊資料延後 → 滑動時再分頁抓
  // （scrollTriggered 走 SCROLL_DAYS）。常駐根數大降 → 縮放/平移順（5m 原 180d≈5.2萬根 → 14d≈4千根）。
  // 代價：較舊的訊號標記要滑到才顯示；勝率 HUD 統計走後端、不受影響。
  const INIT_DAYS   = { "1m": 3, "5m": 14, "15m": 45, "1h": 120, "4h": 730 };
  const SCROLL_DAYS = { "1m": 20, "5m": 730, "15m": 730, "1h": 1825, "4h": 3650 };
  const totalDays   = scrollTriggered ? (SCROLL_DAYS[snapTf] || 365) : (INIT_DAYS[snapTf] || 30);
  const targetStartTs = Math.floor(Date.now() / 1000) - totalDays * 86400;

  const CHUNK_DAYS = { "1m": 5, "5m": 25, "15m": 80, "1h": 240, "4h": 950 };
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
          indicators: !(typeof _subchartsHidden === "function" && _subchartsHidden()),
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

      // 看歷史切小時框:初次載入太短→對齊落空(先跳最舊);背景補到涵蓋目標時間段時,把視野拉回目標。
      let _alignTr = null;
      if (_pendingAlignRange && ohlcvData.length && toTime(ohlcvData[0].time) <= _pendingAlignRange.from + 1) {
        _alignTr = _pendingAlignRange; _pendingAlignRange = null;
      }

      if (replayActive) {
        // 重播中：靜默累積，不碰圖表
      } else if (_alignTr) {
        // 對齊到歷史目標時間段(絕對時間範圍),不做「維持位置」的 shift;多套幾次防延遲 fitContent 壓回。
        _bgApplyChunk(ohlcvData, nPrepended);
        const _applyAlign = () => {
          try {
            mainChart.timeScale().setVisibleRange({ from: _alignTr.from, to: _alignTr.to });
            const lr = mainChart.timeScale().getVisibleLogicalRange();
            if (lr) [kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().setVisibleLogicalRange(lr); } catch (e) {} });
          } catch (e) {}
        };
        _applyAlign();
        requestAnimationFrame(_applyAlign);
        setTimeout(_applyAlign, 130);
        setTimeout(_applyAlign, 380);
        _bgScheduleIndicators();
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
        const _setShifted = () => {
          try {
            mainChart.timeScale().setVisibleLogicalRange(shifted);
            [kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().setVisibleLogicalRange(shifted));
          } catch (e) {}
        };
        if (shifted) _setShifted();   // 立即補償 prepend 位移
        // 看最新：重套縮放+右緣留白錨點 → 即使 setData/fitContent 把 barSpacing 壓回最小(0.5)，
        // 也立刻還原使用者的縮放與水平位置（修「切第三個標的最新棒黏回右緣」）。子圖已由 shifted 對齊。
        if (_bgPosAnchor) { try { mainChart.timeScale().applyOptions(_bgPosAnchor); } catch (e) {} }
        // 看歷史（無錨點）：setData 後 LWC 的 fitContent/內部 reset 是「延遲」操作，晚幾幀可能把
        // 視野壓回最新（=「往回看時自己跳到現在」的根因）。後續數幀偵測『確實被壓回最新』才搶回
        // shifted（用條件判斷，不無腦覆寫 → 不干擾使用者自己的捲動）。
        else if (shifted) {
          const _reassert = () => {
            if (myGen !== _bgLoadGen) return;
            const cur = mainChart.timeScale().getVisibleLogicalRange();
            if (cur && shifted.to < ohlcvData.length - 3 && cur.to >= ohlcvData.length - 3) _setShifted();
          };
          requestAnimationFrame(_reassert);
          setTimeout(_reassert, 120);
          setTimeout(_reassert, 350);
        }
        _bgScheduleIndicators();
      }

      // 往歷史載入更多 K 棒後，若已超過目前「標記近段窗(vw)」→ 觸發勝率重取(debounced)：
      //   後端用更大的 vw 補算舊區的 FVG/多空·破多空·順多空 標記，讓往回滑也看得到策略。(勝率統計不變)
      if (!replayActive && typeof fetchWinRate === "function" && typeof _wrVwFor === "function"
          && _wrVwFor(ohlcvData.length) > (window._wrCurVw || 0)) {
        fetchWinRate();
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
          renderBB(ohlcvData);
          if (!_subchartsHidden()) setTimeout(() => { renderKDJ(ohlcvData); renderRSI(ohlcvData); renderMACD(ohlcvData); }, 0);
          if (_lastWRSignals.length) _renderWRSignals();
          // 補載歷史後也要重繪 FVG 標記(多/空/破多/破空/順多/順空)——否則新載進來那段的標記被 _has() 過濾掉不顯示
          if (typeof _renderFVGMS === "function") _renderFVGMS();
          if (typeof _renderFVGShun === "function") _renderFVGShun();
          if (typeof _renderFVGSpecial === "function") _renderFVGSpecial();
          if (typeof _renderFVGBreak === "function") _renderFVGBreak();
          if (typeof _renderFVGTrades === "function") _renderFVGTrades();
        }
      }
    }
  }
}

/* ══════════════════════════════════════════
   工具函式
══════════════════════════════════════════ */
