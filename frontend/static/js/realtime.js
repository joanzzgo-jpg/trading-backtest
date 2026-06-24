function startRealtime() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }  // 防計時器疊加洩漏（對齊 startTickerRefresh）
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

// 即時更新布林通道：/api/latest 只回裸價格、不含 BB → 隨時間進來的新棒布林不會延伸
// （「布林不會畫、K棒怪怪的，要刷新才好」）。這裡用前端最後 N 根收盤即時重算 BB 補上，
// 對齊後端 indicators/engine.py：period=20、std=2.0、pandas .std() 的樣本標準差(ddof=1)。
function _updateBBTail() {
  const period = 20;
  const n = ohlcvData.length;
  if (n < period || typeof bbU === "undefined" || !bbU) return;
  let sum = 0;
  for (let i = n - period; i < n; i++) sum += ohlcvData[i].close;
  const mean = sum / period;
  let sq = 0;
  for (let i = n - period; i < n; i++) { const d = ohlcvData[i].close - mean; sq += d * d; }
  const std = Math.sqrt(sq / (period - 1));
  const up = mean + 2 * std, lo = mean - 2 * std;
  const up1 = mean + std, lo1 = mean - std;                    // 1σ 內帶
  const bar = ohlcvData[n - 1];
  bar.bb_upper = up; bar.bb_middle = mean; bar.bb_lower = lo;   // 寫回 ohlcvData，後續 renderBB/重算才一致
  bar.bb_upper_1 = up1; bar.bb_lower_1 = lo1;
  const t = toTime(bar.time);
  try { bbU.update({ time: t, value: up }); bbM.update({ time: t, value: mean }); bbL.update({ time: t, value: lo }); } catch (e) {}
  try { bbU1?.update({ time: t, value: up1 }); bbL1?.update({ time: t, value: lo1 }); } catch (e) {}
}

async function fetchLatest() {
  if (replayActive) return;
  // 捕捉本次輪詢的標的脈絡；await 回來後若已切換標的/市場/時框 → 整筆丟棄，
  // 避免「舊標的還在飛的 /api/latest」回來把舊價格畫到剛切換的新標的名下（數值亂跳）
  const _sym0 = document.getElementById("symbolInput")?.value.trim();
  const _mkt0 = document.getElementById("marketSelect")?.value;
  const _tf0  = currentTF;
  try {
    const res  = await fetch("/api/latest", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(buildPayload()),
    });
    if (!res.ok) return;
    const json = await res.json();
    // 標的/市場/時框已切換 → 此結果屬於舊標的，丟棄不畫
    if (document.getElementById("symbolInput")?.value.trim() !== _sym0
        || document.getElementById("marketSelect")?.value !== _mkt0
        || currentTF !== _tf0) return;
    if (!json.data?.length) return;
    const dot = document.getElementById("realtimeDot");
    if (dot) dot.classList.toggle("hidden", json.live === false);
    const _tfSec = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"1h":3600,"15m":900,"5m":300 };
    let _dirty = false;   // 本輪是否真的改了 K → 決定要不要重畫疊加層(三盤色塊)
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
      _dirty = true;
      const _va2 = Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
      volSeries.update({ time:t, value:bar.volume||0, color: bar.close>=bar.open ? C.volUp+_va2 : C.volDown+_va2 });
      const _maPeriod = S.volMaPeriod || 5;
      const _maIdx = ohlcvData.length - 1;
      if (_maIdx >= _maPeriod - 1) {
        const _maAvg = ohlcvData.slice(_maIdx - _maPeriod + 1, _maIdx + 1).reduce((s, d) => s + (d.volume || 0), 0) / _maPeriod;
        volMaSeries.update({ time: t, value: _maAvg });
      }
      updateLatestPriceLine(bar.close);
      _updateBBTail();   // 即時補畫布林（否則新棒沒布林、刷新才出現）
    });
    updateSymbolBar(ohlcvData);
    // 同一根 K 即時更新時時間軸不變 → 不會自動觸發 renderDrawings；這裡手動重畫疊加層，
    // 讓三盤色塊隨「當前 K 的高低」即時長大（否則要等換新棒或平移才更新）。
    if (_dirty && typeof renderDrawings === "function") requestAnimationFrame(renderDrawings);
  } catch {}
}

/* ══════════════════════════════════════════
   統一更新所有面板圖例（鉛直線跨圖同步）
══════════════════════════════════════════ */
// 符號列欄位節點快取：crosshair 60Hz 熱路徑省掉每次 getElementById
const _symElCache = {};
function _symEl(id) {
  let e = _symElCache[id];
  if (!e || !e.isConnected) { e = document.getElementById(id); _symElCache[id] = e; }
  return e;
}
function _setSym(id, text) { const e = _symEl(id); if (e && e.textContent !== text) e.textContent = text; }

// 切標的時把上方報價數字歸零成 placeholder，避免新標的名稱卻殘留舊標的價格（看起來像亂跳）
function _resetSymbolBarQuote() {
  ["symO", "symH", "symL", "symC", "symV"].forEach(id => _setSym(id, "—"));
  const chg = _symEl("symChg");
  if (chg) { chg.textContent = ""; chg.className = "sym-chg"; }
}

// 切標的瞬間先用已知現價填上方「價格」（取代「—」），避免價格閃一下再回來。
// 與 loadData 同一個 tick 內呼叫 → 不會先 paint 出「—」。資料載入後 updateSymbolBar 會精修為同值。
// 只填價格(symC)：ticker 的漲跌幅是 24h、上方欄是「棒對棒」漲跌，metric 不同 → 不填、留給資料載入算，
// 否則會先顯示 24h% 再翻成棒漲跌% 反而像跳動。
function _paintSymbolQuote(price) {
  if (price == null) return;
  _setSym("symC", fmt(price));
}

function updateAllLegends(t) {
  // 熱路徑（每次 crosshair 移動觸發 60Hz）：O(1) Map 查 idx 共用，避免後續 indexOf O(n)
  let idx = (_secToIdx && _secToIdx.has(t)) ? _secToIdx.get(t) : -1;
  let d = idx >= 0 ? ohlcvData[idx] : ohlcvData.find(r => toTime(r.time) === t);
  if (!d) return;
  if (idx < 0) idx = ohlcvData.indexOf(d);   // fallback（罕見路徑）

  // 符號列
  _setSym("symO", fmt(d.open));
  _setSym("symH", fmt(d.high));
  _setSym("symL", fmt(d.low));
  _setSym("symC", fmt(d.close));
  _setSym("symV", fmtVol(d.volume));
  if (idx > 0) _updateSymChg(d.close, ohlcvData[idx - 1].close);

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
// 手機無滑鼠 → 改用 touchstart/move/end 維護同一旗標，否則每秒 realtime 會把上方價
// 蓋成最新價（使用者明明按著舊 K，卻顯示最新一根的價）。
let _mouseOverChart = false;
let _chartTouchClearTimer = null;
// 觸控點是否落在任一圖表窗格內（用座標幾何判斷，不依賴事件目標——手機上觸控目標常是 LWC
// 內部 canvas 或 body，掛在窗格元素的 listener 不一定收得到）
function _pointInCharts(x, y) {
  const ids = ["mainChart", "kdjPane", "rsiPane", "macdPane", "winratePane"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const b = el.getBoundingClientRect();
    if (b.width && b.height && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return true;
  }
  return false;
}
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
  // ── 觸控（手機）：document 層捕獲 + 座標落在圖表內 → 視為「正在看」，realtime 不覆寫上方價 ──
  if (!window._chartTouchBound) {
    window._chartTouchBound = true;
    const _touchOn = (e) => {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      if (_pointInCharts(t.clientX, t.clientY)) { clearTimeout(_chartTouchClearTimer); _mouseOverChart = true; }
    };
    document.addEventListener("touchstart", _touchOn, { passive: true, capture: true });
    document.addEventListener("touchmove",  _touchOn, { passive: true, capture: true });
    document.addEventListener("touchend", () => {
      // 放開後延遲再恢復 realtime 覆寫，留時間看十字線停留那根價（也避開放開瞬間的假 crosshair）
      clearTimeout(_chartTouchClearTimer);
      _chartTouchClearTimer = setTimeout(() => { _mouseOverChart = false; _hoveredTime = null; }, 1200);
    }, { passive: true, capture: true });
  }
}
function onMainCrosshair(param) {
  _hoveredTime = param.time || null;
  if (!param.time) return;
  const c = param.seriesData.get(candleSeries);
  if (c) {
    _setSym("symO", fmt(c.open));
    _setSym("symH", fmt(c.high));
    _setSym("symL", fmt(c.low));
    _setSym("symC", fmt(c.close));
    // O(1) Map 取代 O(n) findIndex（70k 根 × 60Hz mouseMove = 每秒 4M 次 toTime 字串轉換的主因）
    const idx = (_secToIdx && _secToIdx.has(param.time)) ? _secToIdx.get(param.time) : -1;
    if (idx >= 0) {
      _setSym("symV", fmtVol(ohlcvData[idx].volume));
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
  const el   = _symEl("symChg");
  if (!el) return;
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
  _setSym("symO", fmt(last.open));
  _setSym("symH", fmt(last.high));
  _setSym("symL", fmt(last.low));
  _setSym("symC", fmt(last.close));
  _setSym("symV", fmtVol(last.volume));
  _updateSymChg(last.close, prev.close);
  // 主圖 BB 數值：手機沒有 hover crosshair，這裡用最新一根 K 棒把布林通道數值填進
  // 圖例（桌面未 hover 時也順便顯示最新值，行為更像專業看盤 app）
  if (last.bb_upper != null)
    _setLegText("legBB", `BB  U:${fmt(last.bb_upper)}  M:${fmt(last.bb_middle)}  L:${fmt(last.bb_lower)}`);
}

/* ══════════════════════════════════════════
   重播 (Bar Replay)
══════════════════════════════════════════ */
