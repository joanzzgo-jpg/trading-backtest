function startRealtime() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }  // 防計時器疊加洩漏（對齊 startTickerRefresh）
  const dot    = document.getElementById("realtimeDot");
  const market = document.getElementById("marketSelect").value;
  dot.classList.remove("hidden");
  // 各市場 polling 間隔：
  // - crypto: 1s（24/7 高波動，要每秒）
  // - tw    : 5s（MIS 即時報價，盤中夠快）
  // - us    : 5s（Finnhub overlay；無 token 時走 yfinance 15min 延遲，5s 已過剩）
  const interval = { tw: 5000, us: 5000, hk: 5000, crypto: 1000 }[market] || 1000;
  realtimeTimer = setInterval(fetchLatest, interval);
  /* ★ 2026-09-25 立刻先發一次，不要等滿一個週期。
     `setInterval` 的第一發在**一個週期之後**（實測切標的後 1060ms 才送出、1132ms 才到貨）——
     那段時間主圖的現價線與形成中那根 K 棒，吃的是 `/api/ohlcv` 那批的收盤，
     而那批可能是**快取裡 30 秒前**抓的（TTL 30 秒，實測 BTC 差到 76 點）。
     台股/美股更久：週期 5 秒＝整整 5 秒都拿著舊值。
     → 開始輪詢就先問一次，修正時間縮到一個來回（實測 ~70ms）。
     ⚠ 成本＝每次切標的多一發 `/api/latest`，而它後端有 1 秒 TTL＋單飛 → 幾乎不花上游。
     ⚠ 三個呼叫點（切標的、切回前景、離開重播）都受惠，而 `fetchLatest` 自己開頭就有
       replay／離線／標的脈絡三道守衛，不必在這裡再判一次。 */
  try { fetchLatest(); } catch (e) {}
}

function stopRealtime() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  document.getElementById("realtimeDot").classList.add("hidden");
}

/* ── 形成中那根跟著「單一現價」走 ────────────────────────────────────────────
   2026-08-24 使用者：「最新Ｋ棒的即時實體跟不太上最新價格線」。
   根因＝**兩者的更新來源不同**：現價線吃的是收斂後的單一現價（報價列每秒一次 ＋
   /api/latest 每秒一次，誰新用誰，見 ticker.js _pushCurPrice），但 K 棒實體只有
   /api/latest 那一路會動。兩支請求各自有快取與來回時間 → 現價線先跳、實體慢半拍才追上。
   → 讓形成中那根的 close 直接跟著**同一個數字**走：結構上不可能不一致。
   ⚠ 鐵則（對應 check_bar_stability.js 的判準，缺一條就會被它抓到）：
     ・只動「最後一根、且現在確實落在它的週期內」的棒；**絕不新增棒**（開新棒是 /api/latest 的事，
       這裡憑一個報價價格開棒就會生出時間錯位的假棒）。
     ・**open 永遠不動**（使用者早就講過「開盤價不是都固定位置嗎」）。
     ・high 只更高、low 只更低 → low ≤ min(open,close)、high ≥ max(open,close) 自動成立，
       不可能縫出「不可能 K 棒」。
     ・replayActive 中一律不動（守門員十二：重播看得到未來＝所有回測結論作廢）。
     ・_hasFwdGap（在看歷史、和「現在」中間還有缺口）時最後一根不是「現在」→ 不動。 */
window._tickFormingBar = function (price) {
  try {
    if (typeof replayActive !== "undefined" && replayActive) return;
    if (window._hasFwdGap) return;
    if (typeof candleSeries === "undefined" || !candleSeries) return;
    if (typeof ohlcvData === "undefined" || !Array.isArray(ohlcvData) || !ohlcvData.length) return;
    const p = +price;
    if (!isFinite(p) || p <= 0) return;
    const last = ohlcvData[ohlcvData.length - 1];
    if (!last) return;
    const t = toTime(last.time);
    const per = (typeof tfSec === "function") ? tfSec(currentTF) : 0;
    if (!t || !per) return;
    /* 「現在」要落在這根的週期內才算形成中。⚠ toTime() 是 +8 小時的圖表時間軸，
       比較的另一邊也必須換算到同一個軸上（拿 Date.now() 直接比會永遠不成立——踩過一次）。 */
    const nowChart = Math.floor(Date.now() / 1000) + 8 * 3600;
    if (nowChart < t || nowChart >= t + per) return;   // 已收盤／還沒開始 → 不碰
    const hi = Math.max(+last.high, p), lo = Math.min(+last.low, p);
    if (+last.close === p && +last.high === hi && +last.low === lo) return;   // 沒變就不畫
    last.close = p; last.high = hi; last.low = lo;
    candleSeries.update({ time: t, open: +last.open, high: hi, low: lo, close: p });
    if (typeof lineSeries !== "undefined" && lineSeries) {
      lineSeries.update({ time: t, value: p });
      try { const _g = window._lineGradTail; if (typeof _g === "function") _g(t, p); } catch (e) {}
    }
    // 量能柱顏色是看 close 跟 open 的關係 → close 越過 open 時要跟著翻色，否則「紅K配綠量」。
    if (typeof volSeries !== "undefined" && volSeries) {
      const _va = (typeof _volAlphaHex === "function") ? _volAlphaHex()
                : Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
      volSeries.update({ time: t, value: last.volume || 0,
                         color: _volColor(p >= +last.open) + _va });
    }
  } catch (e) {}
};

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
  const bar = ohlcvData[n - 1];
  bar.bb_upper = up; bar.bb_middle = mean; bar.bb_lower = lo;   // 寫回 ohlcvData，後續 renderBB/重算才一致
  const t = toTime(bar.time);
  try { bbU.update({ time: t, value: up }); bbM.update({ time: t, value: mean }); bbL.update({ time: t, value: lo }); } catch (e) {}
}

/* 即時更新 RSI / KDJ / MACD：與 _updateBBTail 同一個問題 ——
   `/api/latest` 只回裸價格、不含指標 → 隨時間進來的新棒，副圖那幾條線**不會延伸**，
   使用者：「rsi 不會自己補，要刷新才有」（刷新＝重抓 /api/ohlcv，那支才帶指標）。
   ⚠ 為什麼可以在前端算：這些都是**遞迴 EMA**（RSI 用 Wilder 的 ewm(com=n-1)、
     KDJ 用 ewm(com=2)、MACD 用 ewm(span=n)），初始條件的影響會指數衰減 →
     只要用夠長的窗口從頭跑一次就會收斂到與後端相同的值。
     RSI-14 的 alpha=1/14，跑 300 根後初始誤差約 (13/14)^300 ≈ 1e-10，完全可忽略。
   ⚠ 公式必須逐字對齊後端 indicators/engine.py，差一點就會與重新整理後的值對不上：
     RSI   = 100 - 100/(1+rs)，rs = ewm(com=p-1) 的平均漲幅 / 平均跌幅
     KDJ   = rsv 用 9 根的最高/最低；k = ewm(com=2)(rsv)、d = ewm(com=2)(k)、j = 3k-2d
     MACD  = ema12 - ema26；signal = ema9(macd)；hist = macd - signal
   ⚠ 只寫「最後一根」：LWC 的 update() 只能動最後一個點。 */
const _IND_WIN = 300;   // 重算窗口（夠長讓遞迴 EMA 收斂）
function _updateIndicatorTail() {
  // 副圖收起來時（**預設就是收起來**）直接跳過：
  //   ①那時 buildPayload 送 indicators:false → 後端根本沒回指標，只往最後一根寫值
  //     會造成「只有一根有指標、其餘沒有」的不一致陣列；
  //   ②畫面上也沒有東西在看它（每秒 0.054ms 的純白工）。
  //   打開副圖會重新載入帶指標的資料，不會漏。
  if (typeof _subchartsHidden === "function" && _subchartsHidden()) return;
  const n = ohlcvData.length;
  if (n < 30) return;
  const s = Math.max(0, n - _IND_WIN);
  const c = [], hi = [], lo = [];
  for (let i = s; i < n; i++) { const b = ohlcvData[i]; c.push(+b.close); hi.push(+b.high); lo.push(+b.low); }
  const m = c.length;
  const bar = ohlcvData[n - 1];
  const t = toTime(bar.time);
  const _upd = (ser, v) => { if (ser && isFinite(v)) { try { ser.update({ time: t, value: v }); } catch (e) {} } };

  // ── RSI（Wilder：ewm(com=p-1, adjust=false) ⇒ alpha = 1/p）──
  const _rsi = p => {
    const a = 1 / p;
    let ag = 0, al = 0;
    for (let i = 1; i < m; i++) {
      const d = c[i] - c[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      ag = a * g + (1 - a) * ag;
      al = a * l + (1 - a) * al;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  };
  const r14 = _rsi(14), r7 = _rsi(7);
  bar.rsi_14 = r14; bar.rsi_7 = r7;
  _upd(typeof rsiLine14 !== "undefined" ? rsiLine14 : null, r14);
  _upd(typeof rsiLine7  !== "undefined" ? rsiLine7  : null, r7);

  // ── KDJ（k_period=9、ewm(com=2) ⇒ alpha = 1/3）──
  {
    const a = 1 / 3;
    let k = 50, d = 50, started = false;
    for (let i = 8; i < m; i++) {
      let mn = Infinity, mx = -Infinity;
      for (let j = i - 8; j <= i; j++) { if (lo[j] < mn) mn = lo[j]; if (hi[j] > mx) mx = hi[j]; }
      const rng = mx - mn;
      if (!(rng > 0)) continue;                 // 對齊後端 replace(0, nan)：整段同價 → 跳過
      const rsv = 100 * (c[i] - mn) / rng;
      if (!started) { k = rsv; d = rsv; started = true; }   // 收斂型初值，300 根後影響 ~0
      else { k = a * rsv + (1 - a) * k; d = a * k + (1 - a) * d; }
    }
    if (started) {
      const j = 3 * k - 2 * d;
      bar.kdj_k = k; bar.kdj_d = d; bar.kdj_j = j;
      _upd(typeof kdjK !== "undefined" ? kdjK : null, k);
      _upd(typeof kdjD !== "undefined" ? kdjD : null, d);
      _upd(typeof kdjJ !== "undefined" ? kdjJ : null, j);
    }
  }

  // ── MACD（ema(span) ⇒ alpha = 2/(span+1)）──
  {
    const A12 = 2 / 13, A26 = 2 / 27, A9 = 2 / 10;
    let e12 = c[0], e26 = c[0], sig = 0, first = true;
    for (let i = 1; i < m; i++) {
      e12 = A12 * c[i] + (1 - A12) * e12;
      e26 = A26 * c[i] + (1 - A26) * e26;
      const ml = e12 - e26;
      if (first) { sig = ml; first = false; } else sig = A9 * ml + (1 - A9) * sig;
    }
    const ml = e12 - e26, hist = ml - sig;
    bar.macd = ml; bar.macd_signal = sig; bar.macd_hist = hist;
    _upd(typeof macdLine !== "undefined" ? macdLine : null, ml);
    _upd(typeof macdSignal !== "undefined" ? macdSignal : null, sig);
    if (typeof macdHist !== "undefined" && macdHist && isFinite(hist)) {
      try { macdHist.update({ time: t, value: hist, color: hist >= 0 ? C.macdHist : C.macdHist }); } catch (e) {}
    }
  }
}

/* 偵測到 K 棒不連續 → 觸發「往新方向補」。節流：補載本身是非同步且會自我終止
   （_bgLoadNewerBars 補到現在就把 _hasFwdGap 清掉），這裡只避免每秒重複發動。 */
let _gapFillAt = 0;
function _scheduleGapFill() {
  // 補不動就要老實回 false —— 背景補載只支援 window._BG_TF 那幾個時框（1w/1M 不在內）。
  // ⚠ 這個回傳值很重要：呼叫端靠它決定「交給補載」還是「退回舊行為照接」。
  //   若這裡補不動、呼叫端又不接，圖表會**整個凍住**（比留一個洞更糟）。
  const _tfs = (typeof window !== "undefined" && window._BG_TF) || null;
  if (!_tfs || !_tfs.has(currentTF) || typeof _bgLoadNewerBars !== "function") return false;
  const now = Date.now();
  if (now - _gapFillAt >= 5000) {            // 5 秒內只發動一次（補載本身是非同步且會自我終止）
    _gapFillAt = now;
    try {
      window._hasFwdGap = true;              // _bgLoadNewerBars 的入口條件
      _bgLoadNewerBars();
    } catch (e) { return false; }
  }
  return true;                               // 已有人在處理（這次或 5 秒內那次）
}

/* ── 連續性自我檢查（2026-08-02）──────────────────────────────────────────────
   ★為什麼還要這一層：上面修的是「即時輪詢中斷」這條路徑，但 K 棒的洞不是只有那一個來源
     ——背景補載接合、切時框、重播進出、資料源本身缺一段都可能留下洞，而且**全都不會報錯**，
     使用者只看到「圖上少一段、重整才好」。與其逐條路徑防守，不如定期驗一次結果。
   做法：每 30 秒掃尾段（只掃最近 300 根，成本可忽略），發現不連續就叫補載修。
   ⚠ 只掃尾段是刻意的：深歷史的洞多半是資料源真的沒有（標的上市前、交易所停機），
     修不回來，掃了只會反覆觸發補載。近端的洞才是「我們自己漏接」的那種。
   ⚠ 只對 crypto 判斷：台股/美股/港股有休市（夜間、週末、假日），K 棒本來就不等距。 */
const _CONT_SCAN_BARS = 300;
function _checkContinuity() {
  try {
    if (typeof replayActive !== "undefined" && replayActive) return;
    if (typeof ohlcvData === "undefined" || ohlcvData.length < 3) return;
    if ((document.getElementById("marketSelect")?.value || "crypto") !== "crypto") return;
    const per = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"2h":7200,"1h":3600,
                  "30m":1800,"15m":900,"5m":300,"1m":60 }[currentTF];
    if (!per) return;
    const from = Math.max(1, ohlcvData.length - _CONT_SCAN_BARS);
    for (let i = from; i < ohlcvData.length; i++) {
      if (toTime(ohlcvData[i].time) - toTime(ohlcvData[i - 1].time) > per * 1.5) {
        window._hasFwdGap = true;
        _scheduleGapFill();
        return;
      }
    }
    // 沒有時間洞，但即時輪詢發現來源換了 → 排一次整段重對齊（見 fetchLatest 的 _srcRealign）
    if (window._srcRealign) _scheduleGapFill();
  } catch (e) {}
}
if (typeof window !== "undefined" && !window._contTimer) {
  window._contTimer = setInterval(_checkContinuity, 30000);
}

let _lastTickDraw = 0;   // 手機：上次「tick 觸發整層重畫」時刻(節流用)
async function fetchLatest() {
  if (replayActive) return;
  // 離線時不送註定失敗的請求（理由與恢復方式見 ticker.js fetchTickers 開頭的說明）
  try { if (window._netIsOffline && window._netIsOffline()) return; } catch (e) {}
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
    // 標的/市場/時框已切換、或 await 期間進了重播 → 此結果作廢，丟棄不畫。
    //   ★replayActive 必須在 await 之後再檢一次：入口(line 41)只擋「重播中才發起」的輪詢，
    //   但「重播前發起、重播後才回來」的 in-flight 會續跑到 candleSeries.update() 補一根「當下」的棒
    //   → series 最後一根變成現在時間 → 重播逐根 update 歷史棒時報「Cannot update oldest data」而卡死。
    if (document.getElementById("symbolInput")?.value.trim() !== _sym0
        || document.getElementById("marketSelect")?.value !== _mkt0
        || currentTF !== _tf0
        || (typeof replayActive !== "undefined" && replayActive)) return;
    /* ★ 2026-08-06 來源換手偵測。各來源對同一根已收盤 K 棒的數值差幾點（實測換源那次
       20 根裡 19 根全變），把兩份混在一起就是使用者看到的小跳空。
       這裡不當場改資料（即時路徑要輕），只標記；由 _checkContinuity 觸發一次整段重對齊。 */
    /* ⚠ 要**連續兩次**看到同一個新來源才算換手（2026-08-08）。
       `/api/ohlcv`（整批載入）與 `/api/latest`（每秒）是兩個獨立端點、各自有快取，
       其中一支偶爾漏一拍退到 Bybit，就會讓兩邊的 src 對不上一拍。
       單次就觸發整段重對齊的話，那幾根定案棒會被整批改寫＝畫面上「K 棒自己在動」
       （實測 180 秒內 16 次、幅度到 7.5 點）。連續兩次才動 → 真的換手才對齊，抖一下不算。 */
    if (json.src && window._ohlcvSrc && json.src !== window._ohlcvSrc) {
      if (window._srcCand === json.src) { window._srcRealign = true; window._srcCand = null; }
      else window._srcCand = json.src;
    } else if (json.src) {
      window._srcCand = null;
      if (!window._ohlcvSrc) window._ohlcvSrc = json.src;
    }
    if (json.ts) window._chartPriceTs = +json.ts;   // 這份主圖現價是幾點的（跟報價列比新舊用）
    /* 主圖這份也推進「單一現價」（見 ticker.js _pushCurPrice）：
       誰新用誰，然後同一個數字同時寫進現價線與行情列那一列 → 結構上不可能不一致。 */
    try {
      const _d = json.data || [];
      if (_d.length && window._chartDataKey && window._pushCurPrice)
        window._pushCurPrice(window._chartDataKey, +_d[_d.length - 1].close, +json.ts || 0, "chart");
    } catch (e) {}
    if (!json.data?.length) return;
    const dot = document.getElementById("realtimeDot");
    if (dot) dot.classList.toggle("hidden", json.live === false);
    // ⚠ 這張表要「每個時框都有」：缺的時框會退成 86400（見下方 || 86400），
    //   等於把週期當成一天 → 缺口判斷整個失效。原本缺 1m / 30m / 2h。
    const _tfSec = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"2h":7200,"1h":3600,
                     "30m":1800,"15m":900,"5m":300,"1m":60 };
    let _dirty = false;   // 本輪是否真的改了 K → 決定要不要重畫疊加層(三盤色塊)
    let _needRedraw = false;  // 本輪有沒有「改到非最後一根」→ 需要整張重畫（LWC update 只能動最後一根）
    let _newBar = false;  // 本輪是否有「新收盤棒」出現 → 觸發勝率重抓讓 FVG 延伸到最新棒
    json.data.forEach(bar => {
      const t     = toTime(bar.time);
      const last  = ohlcvData[ohlcvData.length - 1];
      const lastT = last ? toTime(last.time) : 0;
      // 歷史資料模式：若新 bar 與最後一根差太多，不插入（避免 2024→2026 跳躍）。
      // ★2026-08-02：原本這裡是「> 5 根週期就 return」，而且 return 得比下面的缺口補載更早
      //   → 停超過 5 根週期（1m 只要 5 分鐘）就**每一輪都被擋掉、圖表整個凍住不再前進**，
      //   使用者只能重整。實測停 8 分鐘再恢復：根數與最後一根時間完全沒動。
      //   改成分流：差距在「可以補回來」的範圍內 → 交給 _bgLoadNewerBars 補；
      //   真的差到離譜（＝在看很久以前的歷史）才維持原本的忽略。
      const _per = _tfSec[currentTF] || 0;
      const _gapSec = t - lastT;
      if (t > lastT && _per && _gapSec > _per * 1.5) {
        // 7 天以內視為「輪詢中斷造成的落後」（休眠/背景分頁/斷線）→ 補回來。
        // 超過就當作歷史模式，維持原本行為不接上去。
        // 補得動 → 交給補載，這根先不接（接了中間就是永久的洞）。
        if (_gapSec <= 7 * 86400 && _scheduleGapFill()) return;
        // 補不動（1w/1M 不在背景補載範圍）或差太多（＝在看歷史）：
        //   差太多 → 維持忽略；補不動但差距合理 → **退回舊行為照接**，
        //   寧可留一個洞，也不要讓圖表凍在那裡不動。
        if (_gapSec > 7 * 86400) return;
      }
      if (t < lastT) {
        /* ── 剛收盤那根的「最終值」補回去（2026-08-04）──────────────────────────
           使用者回報「最新一根會有小跳空，要重新整理才會好」。實測抓到根因：
             /api/latest 固定回 **2 根**＝[剛收盤那根, 形成中那根]。第一根的用途正是
             「把上一根補成最終值」，但這個 forEach 只有 t===lastT(更新)與 t>lastT(新增)
             兩個分支 —— 一旦下一根已經被 push，它就落到**沒有分支、被靜默丟棄**。
           後果：那根永遠停在「下一根出現那一瞬間」的未完成值，而下一根用真正的最終價開盤
             → 兩者對不上，畫面留下一道小跳空；重整才好，因為重整會整條重抓。
           實測（BTC 1m、180 秒）：**179 根被丟棄**，其中那根 close 存的是 63507.6、
             實際最終值是 63504.3，而畫面上量到的跳空正好 3.3。
           ⚠ LWC 的 series.update() 只能更新最後一根，改不了倒數第二根 → 要用 setData 重畫。
             但這只在「值真的不同」時才做，而且一根 K 棒週期內至多發生一次（補正後就相等了），
             不是每輪都重畫。 */
        /* ⚠ 索引一定要回頭驗證時間相符，不能直接信 _secToIdx：
             補舊/修剪/重建索引都會讓它一時對不上，信了就會把「這根的值」寫到「別根」身上
             —— 實測就是這樣：兩組四欄全不同的數值在同一根上來回蓋，畫面反覆重畫。
             驗不過就退回小範圍線性掃描（只可能在尾端幾根，成本可忽略）。 */
        let _i = -1;
        if (typeof _secToIdx !== "undefined" && _secToIdx.has(t)) {
          const _c = _secToIdx.get(t);
          if (ohlcvData[_c] && toTime(ohlcvData[_c].time) === t) _i = _c;
        }
        if (_i < 0) for (let k = ohlcvData.length - 1; k >= 0 && k >= ohlcvData.length - 8; k--) {
          if (ohlcvData[k] && toTime(ohlcvData[k].time) === t) { _i = k; break; }
        }
        if (_i < 0 || _i >= ohlcvData.length - 1) return;   // 找不到、或它其實是最後一根 → 不處理
        const _cur = ohlcvData[_i];
        /* ★ 2026-08-08：四欄一起比、一起換（含 open）——**絕不混兩份快照**。
           舊版保留 open 只換 h/l/c，若這份快照來自另一次抓取/另一個交易所，就會縫出
           `open` 在 [low, high] 之外的**不可能 K 棒**（連續性守門員實測傾印到 O65082/L65084.1）。
           已收盤那根本來就該「整根定案」，整根換才是對的；完全相同時一個欄位都不碰。 */
        if (+_cur.open === +bar.open && +_cur.high === +bar.high
            && +_cur.low === +bar.low && +_cur.close === +bar.close) return;
        /* ⚠ 這裡刻意「照單全收」，不要加「只在能讓接縫變小時才補」的閘門。
             試過那樣做，結果更糟：/api/latest 每次回的是**一份內部一致的快照**，
             選擇性套用會把兩份快照混在一起 → 接縫又冒出來（實測跳空 1.6/4.7 點回歸）。
             照單全收的話尾端永遠等於最後一份快照、內部一致 → 沒有接縫；
             代價只是已收盤棒會隨快照微調 0.007% 等級（肉眼不可見），
             而使用者真正看得到的是跳空。 */
        /* ★ 單調閘門（2026-08-08）：只有「權威值涵蓋我們這根」才補（high 只更高、low 只更低）。
           同一家交易所的**最終值**必然涵蓋我們記到的**半路值** → 該補的一定補得到；
           而另一份快照（另一次抓取／另一個交易所）通常是平移或更窄 → 一定被擋掉。
           沒有這道閘門時實測會**來回打架**：同一根 01:01 在 65057.8 ↔ 65056.1 之間反覆跳，
           因為兩個寫入端各拿著自己的快照互相蓋。加上它之後已收盤棒只會單向定案、不再抖。
           ⚠ 這跟下面「別加閘門」的舊教訓不衝突：那裡擋的是**逐欄挑著補**（會縫出混血棒），
             這裡是**整根補或整根不補**，永遠只有一份快照落在一根上。 */
        if (!(+bar.high >= +_cur.high && +bar.low <= +_cur.low)) return;
        /* ⚠ 整根換（含 open）：保留 open 只換 h/l/c 會縫出不可能的 K 棒（low 比 open 高）。 */
        ohlcvData[_i] = { ..._cur, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
                          volume: bar.volume != null ? bar.volume : _cur.volume, _t: t };
        _dirty = true;
        _needRedraw = true;   // ⚠ 只標記，重畫留到整批處理完再做一次（見迴圈之後）
        return;
      }
      if (t === lastT) {
        // 性能：若 OHLC 完全沒變，跳過 LWC update 與 indicator 重算（省 CPU）
        // ⚠ 不比 open 也不覆寫 open：那根開出來時 open 就定了，之後任何一輪都不該再動它。
        //   覆寫的話（浮點瘦身的量化差異、或來源微調）整根會在畫面上跳一下
        //   —— 使用者：「最新 K 棒會因為你的計算而動一下，開盤價不是都固定位置嗎」。
        if (last.close === bar.close && last.high === bar.high && last.low === bar.low) return;
        /* ★ 形成中那根：open 對不上＝這是**另一份快照**，整拍跳過（2026-08-08）。
           開盤價在該根開出來那一刻就定了（使用者：「開盤價不是都固定位置嗎」）。
           同一個來源不可能改它 → 只要 open 不同，就代表這一拍換了快照；
           此時「保留自己的 open + 吃它的 h/l/c」會縫出不可能的 K 棒，「整根吃下去」則是開盤價跳動。
           兩個都不要：這一拍什麼都不做，等下一拍同源的資料。後端有來源黏著，這種情況很少。
           ⚠ 保險絲：真的換源（黏著期過了、對方永久接手）時不能永遠凍住 →
             連續跳過 10 拍就整根收下（一次乾淨的定案，而不是每秒抖一下）。 */
        if (+last.open !== +bar.open) {
          window._fbOpenSkip = (window._fbOpenSkip || 0) + 1;
          if (window._fbOpenSkip < 10) return;
        }
        window._fbOpenSkip = 0;
        ohlcvData[ohlcvData.length - 1] = { ...last, open: bar.open, high: bar.high, low: bar.low,
                                            close: bar.close,
                                            volume: bar.volume != null ? bar.volume : last.volume };
        // 同時間不需重建 Map（key 不變）
      }
      else if (t > lastT) {
        /* ── 中間漏掉的棒要補回來，不能直接接上去（2026-08-02）──────────────────
           使用者回報「網頁開太久 K 棒會斷掉，要重整才會好」。實測重現：
             /api/latest 每次只回 **2 根**，所以只要輪詢中斷超過 2 根的時間
             （分頁被瀏覽器凍結、電腦休眠、網路斷一下、行情中斷…），中間那幾根就永遠不會到。
             舊寫法直接 push 最新這根 → ohlcvData 裡就留下一個**永久的洞**，
             而且不報錯、只有圖上少一段。重整才好，正是因為重整會整條重抓。
           實測（1m、停掉輪詢 4 分鐘再恢復）：斷點數 0 → 1，16:46 直接跳到 16:49、缺 2 根。
           → 偵測到不連續就**不要接**，改叫 _bgLoadNewerBars 從我們的尾巴往新的方向補
             （它已有接合檢查與中段補洞，見 render.js），補完自然包含這一根。 */
        bar._t = t;       // 圖表秒數快取（同 _rebuildTimeIndex 的 _t；這裡 t 已經算好了，順手存）
        ohlcvData.push(bar);
        _newBar = true;   // 出現新棒＝前一根剛收盤 → 稍後重抓勝率補上它的 FVG
        // 副圖指標窗化(render.js _renderSubcharts)：窗是依「當下的視野+資料長度」算的，新棒不會
        //   產生視野變動事件 → 不通知的話副圖會少最後一根（實測正好差 1 根）。這裡主動叫它重評估。
        if (typeof window._scheduleSubRewindow === "function") window._scheduleSubRewindow();
        if (typeof _timeToIdx !== "undefined") {
          _timeToIdx.set(bar.time, ohlcvData.length - 1);
          _secToIdx.set(t, ohlcvData.length - 1);
        }
      }
      else return;
      candleSeries.update({ time:t, open:bar.open, high:bar.high, low:bar.low, close:bar.close });
      if (typeof lineSeries !== "undefined" && lineSeries && bar.close != null) {
        lineSeries.update({ time:t, value:bar.close });   // 線型圖同步
        // 漸層線 primitive 的資料是獨立一份 → 新棒/更新最後一根時要跟著補，否則線的尾端會停住
        try {
          const _g = window._lineGradTail;
          if (typeof _g === "function") _g(t, bar.close);
        } catch (e) {}
      }
      _dirty = true;
      const _va2 = (typeof _volAlphaHex === "function") ? _volAlphaHex() : Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
      volSeries.update({ time:t, value:bar.volume||0, color: _volColor(bar.close >= bar.open) + _va2 });
      const _maPeriod = S.volMaPeriod || 5;
      const _maIdx = ohlcvData.length - 1;
      if (_maIdx >= _maPeriod - 1) {
        const _maAvg = ohlcvData.slice(_maIdx - _maPeriod + 1, _maIdx + 1).reduce((s, d) => s + (d.volume || 0), 0) / _maPeriod;
        volMaSeries.update({ time: t, value: _maAvg });
      }
      updateLatestPriceLine(bar.close);
      _updateBBTail();   // 即時補畫布林（否則新棒沒布林、刷新才出現）
      _updateIndicatorTail();   // 同理補 RSI/KDJ/MACD（使用者：「rsi 不會自己補、要刷新才有」）
    });
    /* 補正到「非最後一根」時的重畫：LWC 的 series.update() 只能動最後一根，
       改到更早的棒必須整張 setData。⚠ 一定要放在迴圈**外面**做一次 —— 放在迴圈裡的話，
       一次回應有幾根要補就重畫幾次，補載追進度時更會連續狂畫（實測 6777 根一次 11.4ms）。 */
    if (_needRedraw) {
      try { if (typeof applyOhlcvToSeries === "function") applyOhlcvToSeries(ohlcvData); } catch (e) {}
    }
    updateSymbolBar(ohlcvData);
    // ★ 行情列「你正在看的那一檔」跟主圖同一拍更新（使用者：「要小到毫秒等級都相同」）。
    //   放在 updateSymbolBar 旁邊＝主圖價寫進畫面的同一個 tick，兩邊讀的都是剛更新完的
    //   ohlcvData 最後一根 → 不會有「一邊已經跳、另一邊還在等下次輪詢」的空窗。
    if (typeof window._tkSyncChartRow === "function") { try { window._tkSyncChartRow(); } catch (e) {} }
    // 新收盤棒出現 → 重抓勝率，讓 FVG 缺口盒/策略標記延伸到最新棒(realtime 不會自己重算勝率，
    //   否則最近一段永遠沒 FVG)。debounce 在 _wrRefreshCurrent 內；非當前標的不受影響。
    if (_newBar && typeof window._wrRefreshCurrent === "function") window._wrRefreshCurrent();
    // 同一根 K 即時更新時時間軸不變 → 不會自動觸發 renderDrawings；這裡手動重畫疊加層，
    // 讓三盤色塊隨「當前 K 的高低」即時長大（否則要等換新棒或平移才更新）。
    // 手機：crypto 每秒 tick 都整層重畫(VWAP/通道/量能分佈/教練…)很吃 CPU → 節流到 ~2.5s 一次
    //   (背景疊加層不需每秒；十字線/互動觸發的重畫不受此限)；桌面維持每 tick。
    if (_dirty && typeof renderDrawings === "function") {
      const _mob = (typeof isMobileUI === "function" && isMobileUI());
      if (!_mob) {
        requestAnimationFrame(renderDrawings);
      } else {
        const _now = Date.now();
        if (_now - _lastTickDraw > 2500) { _lastTickDraw = _now; requestAnimationFrame(renderDrawings); }
      }
    }
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
// ★ 拖曳符號列積木（繪圖快捷）時凍結這排數字（2026-09-17）：十字線掃過不同 K 棒會改寫開高低收/漲跌幅，
//   位數一變寬度就變 → 符號列上的「放這裡」虛線框跟著左右跳、很難對準。放開後下一次十字線/即時更新就會補回。
const _symFrozen = () => document.body.classList.contains("sqd-dragging");
// ★ 寬度只增不減（2026-09-17 使用者：「現價的浮動會讓經濟倒數日動來動去」）：tabular-nums 只擋住「同位數」的晃動，
//   位數一變（漲跌 +99.5 ↔ +100.2、滑過不同 K 棒）寬度照樣變 → 後面的經濟倒數/繪圖快捷整排左右跳。
//   實測十字線掃一趟：倒數位置改變 68 次、在 11 個位置間跳、範圍 35px。
//   → 每次改完量一次寬，變寬就撐開 min-width、變窄不收；換標的（_resetSymbolBarQuote）才歸零。
function _symHold(e) {
  const w = Math.ceil(e.getBoundingClientRect().width);
  if (w > (e._symMinW || 0)) { e._symMinW = w; e.style.minWidth = w + "px"; }
}
/* ★ 預留寬度（2026-09-17 使用者：「是左邊的現在價格變化推到它左邊基準位」）：
   只增不減還是會在「第一次出現更長的數字」時把後面的經濟倒數往右推（切時框又重來一次）。
   → 新標的第一次填進真實收盤價時，就用「同位數、數字全換成 8」的樣板把每格撐到可能的最寬：
     開高低收＝收盤價的樣板、量＝888.88M、漲跌＝「-(收盤價 15% 的位數)  (-88.88%)」。
     tabular-nums 下每個數字等寬 → 樣板寬＝同位數的最寬 → 之後價格怎麼跳，倒數的左邊都不動。
   超出樣板（價格跨位數、漲跌超過 15%）時仍由 _symHold 只增不減接手。 */
let _symReservedDone = false;
function _symReserveOne(id, tmpl) {
  const e = _symEl(id);
  if (!e) return;
  const old = e.textContent;
  e.textContent = tmpl;                                   // 同一個 task 內換回來 → 不會被畫出來
  const w = Math.ceil(e.getBoundingClientRect().width);
  e.textContent = old;
  if (w > (e._symMinW || 0)) { e._symMinW = w; e.style.minWidth = w + "px"; }
}
function _symReserveAll(closeText) {
  const d8 = t => String(t).replace(/\d/g, "8");
  const px = d8(closeText);
  ["symO", "symH", "symL", "symC"].forEach(id => _symReserveOne(id, px));
  _symReserveOne("symV", "888.88M");
  const n = parseFloat(String(closeText).replace(/,/g, ""));
  const amt = isFinite(n) ? d8(fmt(n * 0.15)) : px;
  _symReserveOne("symChg", `-${amt}  (-88.88%)`);
  _symReservedDone = true;
}
/* ★ 開高低收數值跟著 K 棒邊框顏色（2026-09-18 使用者：「開高低收那行數值 顏色跟著Ｋ棒邊匡顏色」）。
   ⚠ 取的是 C.borderUp/borderDown（使用者色盤的「邊框」那一組，跟著色盤即時改），不是寫死的紅綠。
   ⚠ 上下顛倒（window._chartInverted）時 K 棒本身的邊框色就是對調的（charts.js 建 series 時交換）
     → 這裡跟著對調，否則畫面上紅棒配綠字。
   記住最後一次的方向 _symLastUp：換色盤/切顛倒時 window._symRetint() 重新上色（colors.js 末段呼叫）。 */
let _symLastUp = null, _symChgLastUp = null;
function _symDirCol(up) {
  const inv = !!window._chartInverted;   // 顛倒時 K 棒邊框色本身就對調 → 字跟著對調
  return (up !== inv) ? (C.borderUp || DEFAULT_COLORS.borderUp)
                      : (C.borderDown || DEFAULT_COLORS.borderDown);
}
function _symTint(up) {
  _symLastUp = up;
  if (up == null) return;
  const col = _symDirCol(up);
  // ⚠ 一定要 important：style.css 末段「橘子熊可愛風格」有 `.symbol-bar .sym-val { color: … !important }`，
  //   普通 inline 樣式壓不過它（實測 inline 設了、computed 仍是原色）。同 claude.md 提過的 topbar 覆寫規則。
  ["symO", "symH", "symL", "symC"].forEach(id => { const e = _symEl(id); if (e) e.style.setProperty("color", col, "important"); });
}
function _symChgTint(up) {
  _symChgLastUp = up;
  const el = _symEl("symChg");
  if (!el) return;
  if (up == null) el.style.removeProperty("color");
  else el.style.setProperty("color", _symDirCol(up), "important");   // 同上：要 important 才壓得過 .sym-chg 的色
}
window._symRetint = () => { _symTint(_symLastUp); _symChgTint(_symChgLastUp); };

function _setSym(id, text) {
  if (_symFrozen()) return;
  const e = _symEl(id);
  if (e && e.textContent !== text) {
    e.textContent = text;
    if (!_symReservedDone && id === "symC" && /\d/.test(text)) _symReserveAll(text);
    _symHold(e);
  }
}

// 切標的時把上方報價數字歸零成 placeholder，避免新標的名稱卻殘留舊標的價格（看起來像亂跳）
function _resetSymbolBarQuote() {
  // 換標的：保留的最小寬歸零（價位級距可能完全不同，例如 BTC 76,000 → PEPE 0.0000123）
  ["symO", "symH", "symL", "symC", "symV", "symChg"].forEach(id => { const e = _symEl(id); if (e) { e._symMinW = 0; e.style.minWidth = ""; } });
  _symReservedDone = false;          // 新標的/時框第一次填真實價時重新預留（見 _symReserveAll）
  ["symO", "symH", "symL", "symC", "symV"].forEach(id => _setSym(id, "—"));
  ["symO", "symH", "symL", "symC"].forEach(id => { const e = _symEl(id); if (e) e.style.removeProperty("color"); });   // 顏色回預設（新標的還沒有方向）
  _symLastUp = null;
  const chg = _symEl("symChg");
  if (chg) { chg.textContent = ""; chg.className = "sym-chg"; chg.style.removeProperty("color"); }
  _symChgLastUp = null;
}

// 切標的瞬間先用已知現價填上方「價格」（取代「—」），避免價格閃一下再回來。
// 與 loadData 同一個 tick 內呼叫 → 不會先 paint 出「—」。資料載入後 updateSymbolBar 會精修為同值。
// 只填價格(symC)：ticker 的漲跌幅是 24h、上方欄是「棒對棒」漲跌，metric 不同 → 不填、留給資料載入算，
// 否則會先顯示 24h% 再翻成棒漲跌% 反而像跳動。
function _paintSymbolQuote(price) {
  if (price == null) return;
  _setSym("symC", fmt(price));
}

/* BB 圖例文字。⚠ 三個呼叫點（十字線 hover／移開後補最新值／重播）都要走這裡。
   BB 關掉時圖上根本沒有那三條線，數字卻照樣佔著整排 **22%** 的寬度（實測 249px → 64px），
   而這排在 1024px 以下本來就放不下 → 關掉就只留 "BB"。
   值另外記在 _bbLegVals：切換顯隱時要能就地重畫，不必等下一次滑鼠移動。 */
let _bbLegVals = null;
function _setBBLeg(u, m, l) {
  if (u != null) _bbLegVals = [u, m, l];
  const off = document.getElementById("legBB")?.classList.contains("line-off");
  const v = _bbLegVals;
  _setLegText("legBB", (off || !v) ? "BB" : `BB  U:${fmt(v[0])}  M:${fmt(v[1])}  L:${fmt(v[2])}`);
}
window._refreshBBLeg = () => _setBBLeg();

/* 填滿上方 OHLCV 與**所有**圖例（主圖 BB/VOL ＋ 副圖 KDJ/RSI/MACD）。
   ★ 2026-09-24 使用者：「rsi 顯示數據的那一行整個空白看起來怪怪的，要有融合感」。
     實測：資料明明有（kdj_k=77.21 / rsi_14=63.59），但副圖圖例在載入後一直是
     `K —` `RSI 14 —`，連 `VOL` 都沒數字 —— **要等第一次 hover 才填**，
     而且滑鼠移開後就**停在最後 hover 的那根**，不會回到最新。
     主圖的 BB 不會這樣，是因為 renderCandles 的「沒在 hover」那段有單獨補
     `_setBBLeg(last.bb_upper…)`（註解寫著「行為更像專業看盤 app」）——
     那段**只補了 BB，沒補副圖**。這個不對稱就是使用者說的「主圖在動、副圖是死的」。
   → 讓「沒在 hover」那條路也走這支，hover 與非 hover 結構上不可能再長不一樣。
   ⚠ `dOverride`/`prevOverride`：renderCandles 手上已經有 last/prev，直接餵進來，
     不必回頭用時間去 `ohlcvData` 查（重播時 data 與 ohlcvData 不是同一個陣列，
     查不到就會整段靜默不填 —— 那正是這個 bug 的形狀，別再造一個）。 */
function updateAllLegends(t, dOverride, prevOverride) {
  // 熱路徑（每次 crosshair 移動觸發 60Hz）：O(1) Map 查 idx 共用，避免後續 indexOf O(n)
  let idx = -1, d = dOverride;
  if (!d) {
    idx = (_secToIdx && _secToIdx.has(t)) ? _secToIdx.get(t) : -1;
    d = idx >= 0 ? ohlcvData[idx] : ohlcvData.find(r => toTime(r.time) === t);
  }
  if (!d) return;
  if (!dOverride && idx < 0) idx = ohlcvData.indexOf(d);   // fallback（罕見路徑）

  // 符號列
  _setSym("symO", fmt(d.open));
  _setSym("symH", fmt(d.high));
  _setSym("symL", fmt(d.low));
  _setSym("symC", fmt(d.close));
  _setSym("symV", fmtVol(d.volume));
  if (!_symFrozen()) _symTint(d.close >= d.open);
  const _prev = prevOverride || (idx > 0 ? ohlcvData[idx - 1] : null);
  if (_prev) _updateSymChg(d.close, _prev.close);

  // BB
  if (d.bb_upper != null) _setBBLeg(d.bb_upper, d.bb_middle, d.bb_lower);

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
function _updateSymChg(close, prevClose) {
  if (_symFrozen()) return;                 // 拖曳積木中不改寬度（見 _setSym）
  const el   = _symEl("symChg");
  if (!el) return;
  const amt  = close - prevClose;
  const pct  = prevClose ? (amt / prevClose * 100) : 0;
  const sign = amt >= 0 ? "+" : "";
  const _t = `${sign}${fmt(amt)}  (${sign}${pct.toFixed(2)}%)`;
  if (el.textContent !== _t) { el.textContent = _t; _symHold(el); }
  el.className   = "sym-chg " + (amt >= 0 ? "up" : "dn");
  _symChgTint(amt >= 0);   // 2026-09-18 使用者：「+165.6 那個要跟著邊框顏色」
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
    (market === "tw" || market === "us" || market === "hk") ? symbol : symbol.replace("/", " / ");
  /* ★ 2026-08-11 來源標示要標**真的來源**（使用者：「來源標示不要全標 pionex，標正確的」）。
     舊碼對非台美港一律印 `exchangeSelect.value`，而那個 select **只有 pionex 一個選項**
     → 加密與外匯全被標成 pionex，實際上加密可能來自 Binance/Bybit、外匯來自 Yahoo。
     ⚠ 加密的實際來源由後端回傳的 `src` 決定（window._ohlcvSrc，就是修「K 棒自己動」時加的
       那個欄位）；還沒拿到就先印 exchangeSelect 的值當回退，不要顯示空白。 */
  const _srcName = (() => {
    if (market === "tw") return "台股";
    if (market === "us") return "美股";
    if (market === "hk") return "港股";
    if (market === "fx") {
      // 外匯：貴金屬走幣安代幣化商品（PAXG/XAG 永續），其餘貨幣對走 Yahoo
      const _s = symbol.toUpperCase();
      return (_s === "XAU/USD" || _s === "XAG/USD") ? "Binance" : "Yahoo";
    }
    const _m = { binance: "Binance", bybit: "Bybit", pionex: "Pionex", okx: "OKX" };
    return _m[String(window._ohlcvSrc || "").toLowerCase()] || _m[String(exch).toLowerCase()] || exch;
  })();
  document.getElementById("symExchange").textContent = `${_srcName} · ${tfLabel}`;
  if (!data.length) return;
  // 滑鼠在任一圖表內時，不要覆寫上方 OHLCV——避免 realtime poll 每秒
  // 打斷使用者觀看歷史 K 棒。滑鼠離開圖表後下次 poll 才會更新回最新。
  // 用 _mouseOverChart（mouseenter/leave）比 _hoveredTime 可靠，不會因為
  // LWC 重畫時 fire 假 crosshair 事件就誤清狀態。
  if (_mouseOverChart) return;
  const last = data[data.length-1], prev = data.length>1 ? data[data.length-2] : last;
  /* ★ 走跟 hover 完全同一支：上方 OHLCV ＋ 主圖 BB/VOL ＋ 副圖 KDJ/RSI/MACD 一次到位。
     原本這裡只手抄了上方 OHLCV 與 BB，副圖那幾個沒補 → 載入後一直是 `K —`、
     滑鼠移開後又停在最後 hover 的那根（見 updateAllLegends 上方的說明）。
     手機沒有 hover crosshair，所以這條路正是手機唯一會填到值的地方。 */
  updateAllLegends(null, last, prev);
}

/* ── 電腦休眠/分頁凍結太久 → K 棒補不回來時，明講「請重新整理」（2026-09-21）────────
   使用者：「K 棒若太久沒動會有斷掉問題，告訴使用者要重整」「就是使用者太久沒用電腦導致」。

   ★ 為什麼需要這一層：`/api/latest` 每次只回 2 根，輪詢一中斷（休眠/凍結/斷線）中間那幾根
     就永遠不到，而且**完全不報錯**——使用者只看到「K 棒斷掉、要重整才好」。
     `_scheduleGapFill()` 會自動補，但它只支援 `window._BG_TF` 那幾個時框（1w/1M 補不動），
     其餘情況也可能補不回來 —— 補不回來時目前**沒有任何人告訴使用者**。

   偵測「電腦睡過」＝**計時器漂移**：每 5 秒跑一次，若兩次之間的真實間隔遠超過 5 秒，
   就代表這個分頁被凍結/機器休眠了。這個判準與市場開收盤無關，也不必猜使用者行為。

   ⚠⚠ 只有在「**真的沒修好**」時才出聲，否則就是狼來了。醒來後給 12 秒讓輪詢與補載追，
     然後才驗三個條件，缺一不報：
       ① 剛剛真的睡過（漂移 > 90 秒）
       ② 最新一根 K 棒的年齡 > 2.5 個時框（＝該有新棒卻沒有）
       ③ **價格正在動**（最近 60 秒內現價變過）→ 排除「市場休市本來就沒有新棒」
     沒有 ③ 的話，台股/美股收盤後或週末一睡醒就會誤報。
   ⚠ 比對 K 棒時間要用**原始 ISO 時間**：`toTime()` 回的是圖表時間（已 +8 小時），
     直接拿去跟 Date.now() 比會差 8 小時（claude.md 記過這個坑）。 */
const _CS_INT = 5000, _CS_SUSPEND = 90000, _CS_GRACE = 12000;
const _cs = { last: Date.now(), checkAt: 0, shown: false };
function _chartStaleHide() {
  if (!_cs.shown) return;
  _cs.shown = false;
  document.getElementById("chartStale")?.classList.add("hidden");
}
/* K 棒的「真正發生時刻」(ms)。★★ 兩個都不能直接用：
     ・`Date.parse(raw)` —— 後端送的是 **naive ISO**（`"2026-09-21T00:00:00"`，沒有時區，
       值代表 UTC）。JS 規格把「沒有時區的日期時間」當成**瀏覽器本地時間** →
       台灣(UTC+8)會早 8 小時，紐約又是另一個偏移＝**每個使用者錯的量還不一樣**。
     ・`toTime(raw)` —— 那是**圖表時間**，刻意 +8 小時給 LWC 顯示用，比真值晚 8 小時。
   → 沒帶時區就補上 "Z" 當 UTC 解析。數字型的直接當 epoch 秒。
   （2026-09-22 由 K 棒倒數量出來：1d 的倒數算出 -8929 秒＝差整整 8 小時。
     同一個錯誤原本也在 _chartStaleCheck 裡，會讓休眠醒來後誤報「圖表已中斷」。） */
function _barOpenMs(raw) {
  if (typeof raw === "number") return raw * 1000;
  if (typeof raw !== "string" || !raw) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + "Z");
}

function _chartStaleCheck() {
  try {
    if (typeof replayActive !== "undefined" && replayActive) return;   // 重播中本來就不會有新棒
    if (typeof ohlcvData === "undefined" || !Array.isArray(ohlcvData) || !ohlcvData.length) return;
    const per = { "1M":2592000,"1w":604800,"1d":86400,"4h":14400,"2h":7200,"1h":3600,
                  "30m":1800,"15m":900,"5m":300,"1m":60 }[currentTF];
    if (!per) return;
    const lastMs = _barOpenMs(ohlcvData[ohlcvData.length - 1].time);
    if (!isFinite(lastMs)) return;
    const ageSec = (Date.now() - lastMs) / 1000;
    if (ageSec <= per * 2.5) { _chartStaleHide(); return; }            // 已經補回來了 → 不出聲
    const moveAt = (typeof window !== "undefined" && window._lastPxMoveTs) || 0;
    if (!moveAt || Date.now() - moveAt > 60000) { _chartStaleHide(); return; }  // 價格沒在動＝休市
    const el = document.getElementById("chartStale"), txt = document.getElementById("chartStaleTxt");
    if (!el || !txt) return;
    const mins = Math.round(ageSec / 60);
    const human = mins >= 1440 ? `${Math.round(mins / 1440)} 天`
                : mins >= 60   ? `${Math.round(mins / 60)} 小時` : `${mins} 分鐘`;
    txt.textContent = `圖表已中斷約 ${human}（電腦休眠或分頁被凍結），K 棒沒有補回來`;
    el.classList.remove("hidden");
    _cs.shown = true;
  } catch (e) {}
}
function _chartStaleTick() {
  const now = Date.now();
  const drift = now - _cs.last - _CS_INT;
  _cs.last = now;
  if (drift > _CS_SUSPEND) _cs.checkAt = now + _CS_GRACE;     // 睡過 → 等追進度再驗
  if (_cs.checkAt && now >= _cs.checkAt) { _cs.checkAt = 0; _chartStaleCheck(); }
  else if (_cs.shown) _chartStaleCheck();                     // 已顯示 → 每輪重驗（補回來就自動收）
}
/* ══ 最新 K 棒倒數（狀態列：訊號四格 ↔ 已儲存到雲端 之間）═══════════════════════
   2026-09-22 使用者：「新增Ｋ棒倒數，就是最新Ｋ幾分後收，在哪個時間級別就用哪個」。
   ⚠ 時間一律走 `_barOpenMs()`：`Date.parse(naive)` 會被當成瀏覽器本地時間、`toTime()` 是
     +8 小時的圖表時間，兩個拿去跟 `Date.now()` 比都是錯的（見 _barOpenMs 的說明）。
   ⚠ 算出來不在 0~一個時框之間就**不顯示**（休市、資料中斷、時鐘怪怪的）：
     寧可空著，也不要端出一個負數或假的倒數 —— 那種情況該說話的是 #chartStale。
   ⚠ 寬度固定由 CSS `.tb-countdown` 負責，這裡只管內容。 */
const _BC_PER = { "1M":2592000, "1w":604800, "1d":86400, "4h":14400, "2h":7200,
                  "1h":3600, "30m":1800, "15m":900, "5m":300, "1m":60 };
let _bcSec = -1;              // 上一次算出的剩餘秒數（-1＝沒有倒數）
/* 收盤後最多停在 0:00 幾毫秒 —— 實測新棒到貨延遲中位 4.1 秒、最大 5 秒，
   20 秒給足餘裕；超過就當成「這根不會換了」（休市／中斷）回到正常倒數。 */
const _BC_HOLD_MS = 20000;
function _barCountdownTxt() {
  if (typeof replayActive !== "undefined" && replayActive) return "";   // 重播中沒有「還有多久收」
  if (typeof ohlcvData === "undefined" || !Array.isArray(ohlcvData) || !ohlcvData.length) return "";
  const per = _BC_PER[currentTF];
  if (!per) return "";
  const lastMs = _barOpenMs(ohlcvData[ohlcvData.length - 1].time);
  if (!isFinite(lastMs)) return "";
  const now = Date.now();
  /* 這個市場現在有沒有在產生新棒？落後超過兩根就當成休市／資料中斷 → 空著不顯示。
     （那種情況該說話的是 #chartStale，不是端一個假倒數出來。） */
  if (now - lastMs > per * 2000) return "";
  /* ★ 收盤那一刻**不可以變空白**（2026-09-22 使用者：「倒數結束後會自己消失」）：
     最後一根要等下一次輪詢回來才會換，中間那幾秒 `lastMs + per` 已經是過去式 →
     舊寫法算出負數就 return "" ＝ 倒數整個消失，直到新棒到貨才復活（實測空白約 3 秒）。
     → 從最後一根的開盤時間往前推「下一個收盤時刻」，過去了就再加一根，直到落在未來。
     這樣換棒是無縫的：歸零後直接跳回一整根的長度。
     ⚠ 不可以改用 `Math.ceil(now / per)` 那種「時間格線」：1w 的格線起點是星期四
       （epoch），但幣安的週線從星期一開始；1M 更不是固定長度。錨點一定要來自真實資料。 */
  let closeMs = lastMs + per * 1000;
  /* ★★ 2026-09-25 使用者：「倒數太快，下一根Ｋ棒出現時間慢了」。
     實測（1m、5 輪）：倒數的**錨點完全正確**（歸零時刻與新棒開盤時間誤差 5/5 都是 0 秒），
     但新棒**實際到貨**比收盤時刻晚 **3~5 秒**（中位 4.1）—— 後端本身就慢 2.2 秒
     （Binance 產生新棒＋快取），前端再加一次輪詢。
     舊寫法一到收盤時刻就 `while` 跳回一整根 → 畫面上「倒數歸零了，K 棒卻還沒來」，
     看起來就是倒數跑太快。
     → 收盤時刻已過但新棒還沒換 → **停在 0:00 等它**，新棒一到自然開始下一輪。
     ⚠ 一定要有保險絲 `_BC_HOLD_MS`：休市／資料中斷時最後一根永遠不會換，
       沒有它就會永遠卡在 0:00。超時就回到原本的行為（跳回一整根）。
     ⚠ 用 `Math.ceil` 不用 `Math.round`：剩 0.3 秒該顯示 0:01（還沒收），
       round 會提早半秒顯示 0:00 —— 同樣是「看起來比實際快」。 */
  const overdue = now - closeMs;
  if (overdue >= 0) {
    if (overdue <= _BC_HOLD_MS) { _bcSec = 0; return "0:00"; }
    while (closeMs <= now) closeMs += per * 1000;
  }
  const s = Math.max(0, Math.ceil((closeMs - now) / 1000));
  _bcSec = s;                                   // 給 _barCountdownTick 判斷「快收了」用
  const p2 = (n) => String(n).padStart(2, "0");
  if (s < 3600)  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
  if (s < 86400) return `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  return `${Math.floor(s / 86400)}天${Math.floor(s / 3600) % 24}時`;
}
function _barCountdownTick() {
  const el = document.getElementById("barCountdown");
  if (!el || document.hidden) return;              // 背景時不必重算（純本機計算，但沒人看）
  _bcSec = -1;
  const t = _barCountdownTxt();
  if (el.textContent !== t) el.textContent = t;    // 只有真的變了才寫 DOM
  // 最後 10 秒轉強調色（CSS `.tb-countdown[data-soon="1"]`）。
  // ⚠ 同樣只有真的變了才寫屬性：每秒無條件寫 DOM 會讓 transition 一直重跑。
  const soon = (t && _bcSec >= 0 && _bcSec <= 10) ? "1" : "";
  if ((el.dataset.soon || "") !== soon) {
    if (soon) el.dataset.soon = soon; else delete el.dataset.soon;
  }
}
if (typeof window !== "undefined" && !window._bcTimer) {
  window._bcTimer = setInterval(_barCountdownTick, 1000);
  window._barCountdownTxt = _barCountdownTxt;                 // 測試用
  document.addEventListener("visibilitychange", _barCountdownTick);
}

if (typeof window !== "undefined" && !window._csTimer) {
  window._csTimer = setInterval(_chartStaleTick, _CS_INT);
  window._chartStaleCheck = _chartStaleCheck;                 // 測試用
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("chartStaleBtn")?.addEventListener("click", () => location.reload());
  });
  document.getElementById("chartStaleBtn")?.addEventListener("click", () => location.reload());
}

/* ══════════════════════════════════════════
   重播 (Bar Replay)
══════════════════════════════════════════ */
