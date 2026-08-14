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
  const bar = ohlcvData[n - 1];
  bar.bb_upper = up; bar.bb_middle = mean; bar.bb_lower = lo;   // 寫回 ohlcvData，後續 renderBB/重算才一致
  const t = toTime(bar.time);
  try { bbU.update({ time: t, value: up }); bbM.update({ time: t, value: mean }); bbL.update({ time: t, value: lo }); } catch (e) {}
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
