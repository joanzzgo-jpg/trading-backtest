// 切標的時 abort 上一筆未完成請求；30s timeout 防止後端卡住前端
let _loadDataCtrl = null;
let _pendingAlignRange = null; // 看歷史切小時框:目標時間段初次還沒載到→先記著,背景補到涵蓋時再拉回視野

/* ── 換標的/時框 → 清掉上一個脈絡的策略圖層快取（2026-08-08）────────────────────────
   使用者回報「切時框會冒出很多線條」。根因：renderAll 為了修好「切換後標記消失」，會在
   renderCandles 清空之後，用 _lastFVG* 這幾份快取把圖層「重畫回來」——但切換的當下那幾份
   裝的還是**上一個時框**的資料（要等新的勝率回應才被換掉）。
     ・標記層看不出來：_renderFVG* 都經過 _has() 過濾（時間不在當下 K 棒裡的標記會被丟掉）。
     ・FVG 逐筆止損/止盈**線**（setFVGTradeLines）沒有這層過濾 —— 它是直接
       timeToCoordinate 畫下去。大時框的進場時間（如 1d 的 00:00）在小時框上**找得到**
       對應座標 → 上一個時框最多 600 筆交易的紅綠虛線一次全冒出來＝使用者看到的「很多線條」。
   → 脈絡（市場|標的|交易所|時框）一變就把快取清空：寧可空白到新資料回來，也不要畫別的時框的東西。
   ⚠ 一定要在 fetchWinRate() 之前呼叫：勝率快取命中是**同步**填好這幾份的，
     清在它後面會把剛填好的正確資料一起洗掉（切回看過的時框就整片沒標記）。 */
let _layerCtxKey = "";
function _resetLayerCacheOnCtxChange() {
  let ctx = "";
  try {
    ctx = [document.getElementById("marketSelect")?.value,
           document.getElementById("symbolInput")?.value.trim(),
           document.getElementById("exchangeSelect")?.value,
           currentTF].join("|");
  } catch (e) { return; }
  if (ctx === _layerCtxKey) return;      // 同一個脈絡（背景補載/即時重建）→ 快取要留著，正是它們的用途
  _layerCtxKey = ctx;
  _lastWRSignals = []; _lastFVGTrades = []; _lastFVGBreak = [];
  _lastFVGMS = []; _lastFVGShun = []; _lastFVGSpecial = [];
  try { _lastFVGBB = []; _lastFVGBBA = []; _lastFVGBBM = []; } catch (e) {}
  try { _lastSMCSweep = []; } catch (e) {}
  if (typeof setFVGTradeLines === "function") setFVGTradeLines([]);   // 已畫上去的線也要收掉
  if (typeof setFVGZones === "function") setFVGZones([]);             // FVG 色塊同理（也是純時間定位）
}
async function loadData(autoLoad = false, forceLatest = false) {
  if (replayActive) exitReplay();
  /* ★ 2026-08-11 由代號自動判斷市場（使用者：「不再用上方按鈕切市場，會自動分辨」）。
     放在 loadData 開頭是因為**所有進入點都會經過這裡**（手動輸入、搜尋選取、網址參數、
     記住的上次標的、快捷鍵切時框…），只改這一處就全涵蓋，不必逐個路徑補
     ——先前 fx 就是因為要「逐處補」而漏了 _selectSymbol，害使用者一直看到「找不到」。
     ⚠ 判不出來（_detectMarket 回 null）就保持現狀，不猜。 */
  try {
    const _mkEl = document.getElementById("marketSelect");
    const _det = (typeof window._detectMarket === "function")
      ? window._detectMarket(document.getElementById("symbolInput")?.value) : null;
    if (_mkEl && _det && _mkEl.value !== _det) {
      _mkEl.value = _det;
      if (typeof updateMarketUI === "function") updateMarketUI(true);   // true＝別覆寫 symbolInput
    }
    /* ⚠ 標籤要**無條件**同步，不能只在「值有變」時才做（使用者：「左上標籤我剛剛試還是沒有」）。
       原因：從搜尋視窗點選標的時，_selectSymbol() 自己就先把 marketSelect.value 設好了，
       等 loadData 跑到這裡時「值已經是對的」→ 上面那個 if 不成立 → 標籤永遠不更新，
       只有重整（pill 初始化時讀一次 select）才會對。
       所以這行放在 if 外面，以當下的 select 值為準同步顯示。 */
    if (_mkEl && typeof window._setMarketPill === "function") window._setMarketPill(_mkEl.value);
  } catch (e) {}
  _pendingAlignRange = null;   // 新載入作廢上一次未完成的歷史對齊目標
  window._loadRangeStart = null;   // 預設抓最近 N 根;下方「捲歷史切換」設成目標時間附近的有界視窗(start+end)直接範圍抓取
  window._loadRangeEnd = null;
  window._hasFwdGap = false;   // 捲歷史抓有界視窗時=true(資料未到現在)→ 近右緣往右拖時 _bgLoadNewerBars 往「新」方向補
  /* 記住切換前的可見 K 棒數量，載入後還原相同縮放比例 */
  if (mainChart) {
    const _r = mainChart.timeScale().getVisibleLogicalRange();
    if (_r) _savedBarCount = Math.round(_r.to - _r.from);
    // 若視窗已捲到歷史（右緣不貼最新棒）→ 另存可見「時間範圍」，切標的/時框後對齊同一時間段；
    // 仍在看最新（_atLatest）→ 不存，照舊貼齊最新 N 根（realtime 才會接續更新）
    // forceLatest＝「回到最新」按鈕：即使現在在看歷史，也走 at-latest 這條（保留縮放、貼齊最新），
    //   而不是把當前歷史視窗記下來再對齊回去（那是切標的/切時框要的行為，剛好相反）。
    const _atLatest = forceLatest || !_r || !ohlcvData.length || _r.to >= ohlcvData.length - 2;
    _savedTimeRange = null;
    _savedRightOffset = null;
    _savedBarSpacing = null;
    if (!_atLatest) {
      try {
        const _tr = mainChart.timeScale().getVisibleRange();
        if (_tr && _tr.from != null && _tr.to != null) {
          _savedTimeRange = { from: _tr.from, to: _tr.to };
          // ⚠ 捲歷史切換:抓「目標右緣時間(_tr.to)附近的有界視窗」——
          //   ✗ 不抓「目標~至今」(半年前切5m會抓5萬根→超卡、且對齊常落到最新變7/21)
          //   ✗ 不抓「最新再回填」(對齊落空、停在錯時間)
          //   ✓ 抓目標左約300根、右約120根 → 目標時間落在視窗內、第一次畫就對齊(_placeAtAnchor 必中);
          //     視窗僅數百根 → 任何時框都秒回、無 row-cap 風險;背景再往兩側補供拖曳。
          //   後端:end 在過去→倉庫直接切片 _k_load(快)/API 範圍抓;end≥今天(錨點接近現在)→量本來就小。
          const _ntfSec = tfSec(currentTF);
          window._loadRangeStart = Math.floor(_tr.to - 300 * _ntfSec);
          window._loadRangeEnd   = Math.floor(_tr.to + 120 * _ntfSec);
          window._hasFwdGap = true;   // 有界視窗未到現在 → 往右拖到近右緣時 _bgLoadNewerBars 往「新」方向補
        }
      } catch (e) {}
    } else if (_r && ohlcvData.length) {
      // 看最新（切標的 or 純切時框皆同路）：記住「縮放(barSpacing)」+「最新棒水平位置(rightOffset)」。
      //   ⚠ 切時框刻意「保持縮放」(TradingView 式)：切完 K 棒大小不變、貼最新、顯示差不多同樣根數
      //   → 一次到位、不重算時長、大切小不爆量(切 5m 只看最近那幾根而非塞滿全歷史=「滑動/縮小」感的根因)。
      //   最新棒出現在使用者選的同一位置（而非每次貼回最右）。用持久選項還原，跨資料更新不會被沖掉。
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

  /* ── 重整還原「上次看的那個時間區間」(2026-08-16 使用者：「重整後要一樣」)────────────
     開機那一次由 loadLastSymbol() 放下 window._pendingRestoreAnchor（右緣時間＋可見根數），
     這裡把它翻譯成「捲在歷史切換」那條路已經在用的三樣東西：_savedTimeRange（對齊目標）、
     _savedBarCount（＝縮放）、有界視窗 _loadRangeStart/_loadRangeEnd（只抓錨點附近數百根）。
     ⚠ 一定要放在上面那段**之後**：那段是從「現在的圖表」推算的，而開機時 ohlcvData 還是空的
       → `!ohlcvData.length` 讓 _atLatest 恆為 true → 它剛好會把 _savedTimeRange 清成 null。
     ⚠ 只用一次（用完清掉）：之後切標的/時框要走各自的邏輯，不能一直被開機那個錨點綁住。 */
  if (window._pendingRestoreAnchor) {
    try {
      const _pa = window._pendingRestoreAnchor;
      const _paSec = tfSec(currentTF);
      _savedBarCount  = Math.max(5, _pa.bars || 50);
      _savedTimeRange = { from: _pa.t - _savedBarCount * _paSec, to: _pa.t };
      window._loadRangeStart = Math.floor(_pa.t - 300 * _paSec);
      window._loadRangeEnd   = Math.floor(_pa.t + 120 * _paSec);
      window._hasFwdGap = true;      // 有界視窗未到現在 → 往右拖時 _bgLoadNewerBars 往「新」補
      _pendingRestoreRange = null;   // 與時間錨點互斥：有錨點就不要再套「貼最新」那組
      window._bootAnchorHold = _pa.t;   // 還原之後要按住幾秒（見 _holdAnchorByTime）
      /* 還原完成前禁止 saveLastSymbol 寫入（見該函式）。
         ⚠ 保險絲不可省：錨點若落在已載資料之外，走的是 _pendingAlignRange / _restoreByBarCount，
           那兩條**不會**呼叫 _holdAnchorByTime → 旗標沒人解除＝從此再也不存檔（比原本的 bug 更糟）。 */
      window._viewRestoreBusy = true;
      clearTimeout(window._viewRestoreFuse);
      window._viewRestoreFuse = setTimeout(() => { window._viewRestoreBusy = false; }, 9000);
    } catch (e) {}
    window._pendingRestoreAnchor = null;
  }

  // 快照秒畫(_snapPaint→renderAll)會先消耗上面保存的視野變數(renderAll 結尾歸 null)→
  // 真資料到貨的第二次 renderAll 拿到 null、跳回「最新50根」。先留副本，真資料 renderAll 前還原，
  // 讓快照與真資料兩次都套用同一個視野（切標的記得縮放+平移位置）。
  const _vSave = { bc: _savedBarCount, tr: _savedTimeRange, ro: _savedRightOffset, bs: _savedBarSpacing };

  stopRealtime();

  _resetLayerCacheOnCtxChange();   // 換標的/時框 → 丟掉上一個脈絡的策略圖層快取（見該函式註）

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

  // TV 式過場：切時框/標的時先讓主圖 K 棒淡暗，真資料畫好再淡回(見 utils _chartDimOn/Off)。
  //   僅在「已有圖」時(=切換,非首次載入)才暗場;首次載入走城門/全屏 loading。
  //   ⚠ 必須在 _snapPaint 之前開暗場 → 連「快照秒畫→真資料→背景補載」的內容抽換都藏在暗場下，才不會先閃舊圖。
  const _isSwitch = !!(mainChart && ohlcvData && ohlcvData.length);
  if (_isSwitch && typeof window._chartDimOn === "function") window._chartDimOn();

  showLoading(true);
  // ★「行情列與主圖數值要一致」用的鑰匙（2026-08-14）：標記**主圖上這批 K 棒到底是哪一檔**。
  //   載入期間先清成 null → 行情列該列這段時間退回用它自己的價。
  //   ⚠ 這一步是關鍵：不能拿 symbolInput 的值當依據（點下去就變了，但 ohlcvData 還是前一檔）
  //     —— 舊版就是這樣才出現「點下去跳成別的標的的價、再跳回」，那次因此整個拿掉。
  /* 換標的 → 先收掉現價標線（見 charts.js hideLatestPriceLine）：
     它會留著上一檔的價，直到新資料畫上去為止。換時框不收（同一檔，價仍有效）。 */
  try {
    const _prevKey = window._chartDataKey;
    const _newKey = window._mkChartDataKey
      ? window._mkChartDataKey(document.getElementById("marketSelect")?.value,
                              document.getElementById("symbolInput")?.value)
      : null;
    if (_prevKey && _newKey && _prevKey !== _newKey && typeof window.hideLatestPriceLine === "function")
      window.hideLatestPriceLine();
    if (window._resetCurPrice) window._resetCurPrice();   // 換標的：清掉上一檔的現價
  } catch (e) {}
  window._chartDataKey = null;
  // ⚡ 速度：先「發射」ohlcv 網路請求(不 await)→ 讓 TCP/後端往返與下面的快照渲染「平行」跑，
  //    不再讓快照渲染(~50-100ms 主執行緒)擋在網路請求前面(舊順序是先畫快照才發網路＝白等)。
  const _ohlcvP = fetch("/api/ohlcv", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(buildPayload()),
    signal: myCtrl.signal,
  });
  // 本機快照：這個標的最近看過(IndexedDB 有存)→ 秒畫上次的圖(K棒+策略層)，趁網路飛行中畫、不阻塞請求。
  // 真資料/勝率到貨自動覆蓋（世代守衛在下方 _snapInvalidate）。開機與切標的同一條路。
  // ⚠ 捲在歷史切換(_savedTimeRange 有值)時「不畫快照」：快照是上次的視野(多半在最新/別處)，
  //   畫出來就是使用者說的「先跳一張(最新)才到目標」的中間畫面；歷史切換直接讓真資料一次畫在目標段。
  if (typeof window._snapPaint === "function" && !_savedTimeRange) window._snapPaint();
  // 智慧並行：Pionex 獨有標的（.P）ohlcv 走 Pionex API 較慢，提前發 winrate 省 2-6s；
  // Binance 標的 ohlcv 已 <1s，提前發只會讓「計算中…」動畫多顯示 0.5s 反而看起來變慢
  const _isPerpSym = /\.P$/i.test(document.getElementById("symbolInput").value.trim());
  if (_isPerpSym) fetchWinRate();
  try {
    let res  = await _ohlcvP;
    let json = await res.json();
    // ★「看歷史時切到較晚上市的標的」救援(2026-07-30)：
    //   捲在歷史時切標的,會拿「你正在看的那個時間窗」去抓新標的(見上方 _loadRangeStart 註)。
    //   若該標的當時還沒上市(XAUT 2026-03、SOL 2020-09 才有永續),後端回 400,而訊息是
    //   「找不到 XXX 的行情資料,請確認標的代號是否正確」→ 標的明明沒錯,使用者只看到載入失敗。
    //   → 偵測到「這次是帶時間窗的請求」且失敗,就退成「抓最近 N 根」重試一次(對齊自然放棄)。
    if (!res.ok && window._loadRangeStart && !myCtrl.signal.aborted) {
      window._loadRangeStart = null;
      window._loadRangeEnd = null;
      window._hasFwdGap = false;
      _savedTimeRange = null; _vSave.tr = null;   // 別再嘗試對齊到那個不存在的時間
      _pendingAlignRange = null;
      res  = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()), signal: myCtrl.signal,
      });
      json = await res.json();
      if (res.ok && typeof showToast === "function")
        showToast("此標的沒有你正在看的那段歷史，已跳到最近的資料");
    }
    if (!res.ok) throw new Error(json.detail || "載入失敗");
    ohlcvData = json.data;
    /* ★ 2026-08-06 記下這批資料的來源（crypto 才有 src）。
       各來源（Binance/Bybit/Pionex）對同一根**已收盤** K 棒的數值差幾點：
       實測來源由 binance 換成 bybit 那一次，20 根裡 19 根全變（同來源時 0 根變）。
       每份快照內部都連續，混在一起才會在接合處留下跳空 → 接合前要先比對來源。 */
    window._ohlcvSrc = json.src || null;
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
    // 真資料已經畫上去了 → 這時才敢說「主圖上的 K 棒＝這一檔」（見上方 _chartDataKey 說明）
    window._chartDataKey = window._mkChartDataKey
      ? window._mkChartDataKey(document.getElementById("marketSelect")?.value,
                               document.getElementById("symbolInput")?.value)
      : null;
    // 主圖資料一就位就立刻同步行情列那一列，不要等它下一次輪詢（否則切標的後會有 <1 秒的
    // 空窗：主圖已是新價、行情列還是自己那份）。使用者：「要小到毫秒等級都相同」。
    if (typeof window._tkSyncChartRow === "function") { try { window._tkSyncChartRow(); } catch (e) {} }
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
    // ⚠ 切時框/標的太快時,前一個請求會被 abort()＝正常行為,不是錯誤。
    //   原本無條件 console.error 把「被接手/被中止」也印成錯誤 →「切時框有錯誤」的假象(net::ERR_ABORTED)。
    const superseded = (myCtrl !== _loadDataCtrl);   // 已被更新的切換接手 → 完全靜默
    const isAbortLike = e.name === "AbortError" || /failed to fetch/i.test(e.message || "") || myCtrl.signal.aborted;
    if (superseded) {
      // 靜默 — 新請求接手(切太快的正常中止,不記錯誤、不提示)
    } else if (isAbortLike) {
      // 本請求被中止但無人接手(多半是 30s 逾時)→ 僅提示可重試,不 console.error(非程式錯誤)
      if (!autoLoad && typeof showToast === "function") showToast("⏱ 載入中斷，請再試一次");
    } else {
      console.error("[loadData] error:", e.name, e.message, e);   // 真正的錯誤才記
      // 第三個參數 true＝真的顯示。showToast 預設靜音（使用者：操作類提示不要，
      // 只有「找不到標的」這種需要知道的才跳）—— 這是目前唯一開啟的呼叫端。
      if (!autoLoad && typeof showToast === "function") showToast("❌ " + (e.message || "載入失敗"), 4000, true);
    }
    // 不再重拋:所有呼叫端都是 fire-and-forget(無 await/.catch),重拋只會變
    // unhandled rejection 雜訊(每次打錯標的/斷網都冒一顆 pageerror)。錯誤已 toast+console。
  } finally {
    clearTimeout(timeoutId);
    clearTimeout(slowHint);
    if (myCtrl === _loadDataCtrl) {
      showLoading(false);
      // 收掉 TV 式過場暗場(僅本請求仍是最新時;被更新切換接手則交給那一筆收，避免提前露內容)。
      // ⚠ 若捲在歷史切小時框、目標段比初次載入更早(_pendingAlignRange 已設)→ 暫不收：
      //   真正把視野「拉回目標段」是在背景補到涵蓋時(_bgLoadOlderBars 的 align 分支)才發生，
      //   暗場撐到那時才淡出＝那段「滑動到目標」藏在暗場下(2.5s 失效保險兜底)。
      if (typeof window._chartDimOff === "function" && !_pendingAlignRange) window._chartDimOff();
    }
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
    const b = ohlcvData[i];
    const t = b.time;
    const s = toTime(t);
    // ★把算好的圖表秒數存回棒上(_t)：這裡本來就要為每一根算一次 toTime()(建 _secToIdx)，
    //   算完就丟掉太浪費——toTime() 對字串是 new Date() 解析 ISO，是熱路徑的主要成本。
    //   存下來後 renderBB(×3 條線)/renderVolume/applyOhlcvToSeries 都直接讀，同一份資料
    //   34k 根時原本要重複解析 ~17 萬次。⚠ 只是快取欄位，來源資料不變；資料一換就重建。
    b._t = s;
    _timeToIdx.set(t, i);
    _secToIdx.set(s, i);
  }
  ++_dataVersion;
}
// 取棒的圖表秒數：優先用 _rebuildTimeIndex 算好的 _t，沒有(例如剛 fetch 還沒建索引)才現算。
function _bt(d) { return d._t !== undefined ? d._t : toTime(d.time); }

/* 夾住可見時間範圍在資料內:右緣超過最後一根→整段往左夾(保持span)、左緣超過第一根→夾住。
   還原視野前套用→杜絕「右緣跑到資料外=右邊空白斷掉的Ｋ棒/閃」。回 null 表不合理不還原。 */
function _clampVisT(vt) {
  if (!vt || !ohlcvData.length) return vt;
  try {
    const firstT = toTime(ohlcvData[0].time);
    const lastT  = toTime(ohlcvData[ohlcvData.length - 1].time);
    let from = vt.from, to = vt.to;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    if (to > lastT) { const span = to - from; to = lastT; from = to - span; }
    if (from < firstT) from = firstT;
    if (to <= from) return null;
    return { from, to };
  } catch (e) { return vt; }
}

// 時間(秒)→ ohlcvData 中最接近的 bar index(二分查找;資料依時間升冪)。
// 歷史切換「保持縮放定位在目標時間」用:右緣放這根、往左顯示同樣根數。
function _nearestIdxByTime(sec) {
  const n = ohlcvData.length;
  if (!n || sec == null) return null;
  if (sec <= toTime(ohlcvData[0].time)) return 0;
  if (sec >= toTime(ohlcvData[n - 1].time)) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = toTime(ohlcvData[mid].time);
    if (t === sec) return mid;
    if (t < sec) lo = mid + 1; else hi = mid - 1;
  }
  // lo=首個>sec、hi=末個<sec → 取較近者
  const dLo = Math.abs(toTime(ohlcvData[lo].time) - sec);
  const dHi = Math.abs(toTime(ohlcvData[hi].time) - sec);
  return dLo < dHi ? lo : hi;
}

/* 開機還原到歷史錨點後，把「右緣＝那個時間」按住幾秒（2026-08-16）。
   ★ 為什麼需要：_placeAtAnchor 用的是**邏輯索引**，只設一次；設完之後背景補載會往
     ohlcvData 塞進成千上萬根舊棒（實測 420 → 14,040 根），同一個邏輯索引指到的時間就整個
     位移 —— 實測還原到 2026-07-22 的畫面，幾秒後自己跑到 2025-09-01（差 11 個月），
     而且過程沒有任何錯誤、使用者只覺得「重整後看到的不是我剛剛那頁」。
     旁邊的 _guardRestore 救不了：它只看**span 有沒有被壓爛**、而且只守 380ms。
   ⚠ 使用者一動（滾輪/按下/觸控）就立刻放手，絕不跟使用者搶圖表。
   ⚠ 判準用時間差 > 半根，不用相等：LWC 的可見範圍是連續值，要求相等會每輪都重設。 */
/* 開機還原出來的視野選項，在載入還沒完全落定的這幾秒內「按住」。
   ⚠ 一定要有保險絲＋使用者一動就放手：不然使用者接下來的縮放/平移會被下一次 renderAll
     重設回開機那組，變成「圖表自己彈回去」。 */
function _bootViewHold(opt) {
  window._bootViewOpt = opt;
  const _release = () => {
    window._bootViewOpt = null;
    clearTimeout(window._bootViewFuse);
  };
  ["mousedown", "wheel", "touchstart", "keydown"].forEach(e =>
    window.addEventListener(e, _release, { once: true, passive: true }));
  clearTimeout(window._bootViewFuse);
  window._bootViewFuse = setTimeout(_release, 9000);
}

function _holdAnchorByTime(anchorT, bc) {
  let stop = false;
  const _off = () => { stop = true; window._viewRestoreBusy = false; };
  ["mousedown", "wheel", "touchstart", "keydown"].forEach(e =>
    window.addEventListener(e, _off, { once: true, passive: true }));
  const t0 = Date.now();
  const tick = () => {
    if (stop || replayActive || Date.now() - t0 > 8000) { window._viewRestoreBusy = false; return; }
    try {
      const ts = mainChart.timeScale();
      const vr = ts.getVisibleRange();
      if (vr && vr.to != null && Math.abs(vr.to - anchorT) > tfSec(currentTF) / 2) {
        const idx = _nearestIdxByTime(anchorT);
        if (idx != null) ts.setVisibleLogicalRange({ from: idx - bc, to: idx });
      }
    } catch (e) {}
    setTimeout(tick, 400);
  };
  setTimeout(tick, 400);
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
  const _hasRestoreTarget = _pendingRestoreRange || _savedTimeRange || _savedBarSpacing != null;
  if (!_hasRestoreTarget) {
    [mainChart, kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().fitContent());
  }

  // 還原畫面位置：
  //  1. 重整後 → _pendingRestoreRange（bar 數 + 右緣偏移）
  //  2. 切標的/時框且原本捲在歷史 → _savedTimeRange（對齊同一時間段，與新標的有重疊才用）
  //  3. 其他（看最新）→ _savedBarCount 貼齊最新 N 根，預設 50
  /* 右緣留白(rightOffset)的上限。
     ★ 2026-08-16 使用者：「最新框會右貼」——存的是對的(實測存進 20 根)，是**這裡把它砍掉的**：
       還原發生在圖表還沒完成佈局的那一刻，`ts.width()` 回 0 → _visN 掉到下限 10 →
       上限變成 5 → 使用者原本 20 根的留白被夾成 5 根＝K 棒幾乎貼著右邊。
     → 量不到寬度時**不要夾**（只留絕對上限 60）。夾限是為了治「已存進垃圾值」的舊狀態，
       用一個還沒準備好的寬度去夾，等於每次重整都吃掉使用者的留白 —— 治病治成了病。 */
  const _visNFor = (bs) => {
    let w = 0;
    try { w = mainChart.timeScale().width(); } catch (e) {}
    if (!(w > 50)) { try { w = document.getElementById("mainChart")?.clientWidth || 0; } catch (e) {} }
    return (w > 50) ? Math.max(10, Math.round(w / Math.max(0.5, bs))) : null;   // null＝量不到
  };
  /* rightOffset 的上限。原本是「可見根數的一半、絕對 60」——那是為了治「已存進垃圾值」的舊狀態
     （大 rightOffset 會被重申機制保護、每次切換複發「最右邊沒 K 棒」）。
     ★ 2026-08-17 使用者：「有留白，但跟原本不同」——實測把留白拉到 35 根，重整後被砍成 27（789px→79px）。
       一半太緊了：想把最後一根推到偏左看延伸(畫趨勢線/等突破)是很常見的用法。
     → 放寬到可見根數的 80%（畫面上一定還留得下兩成 K 棒，不會變成整片空白），絕對上限 200。 */
  const _roCapFor = (bs) => {
    const visN = _visNFor(bs);
    return visN == null ? 200 : Math.min(Math.max(5, Math.round(visN * 0.8)), 200);
  };
  /* 看最新時，最後一根 K 棒與右緣之間的**預設留白**（單位＝K 棒數）。
     ★ 2026-08-17 使用者：「右邊無留白」。LWC 預設 rightOffset=0 ＝最後一根貼著價格軸：
       最新那根被切在邊上、也沒有空間看「接下來要往哪走」。本專案一直沒有預設值，
       之前的 rightOffset 邏輯全都只是「保住使用者自己拉出來的位置」而已。
     ⚠ 用**比例**不用固定根數：固定根數在放大時會變成半個畫面、縮小時又等於沒有；
       依可見根數等比例算，不論縮放到哪一級，看起來的留白寬度都差不多。
     ⚠ 只當**下限**（跟已存的值取大）：使用者自己拉出更大的留白要保留得住。 */
  const _defaultRightPad = (bs) => {
    const visN = _visNFor(bs) || (_savedBarCount || 50);
    return Math.min(20, Math.max(3, Math.round(visN * 0.06)));
  };
  const _restoreByBarCount = () => {
    const ts = mainChart.timeScale();
    /* ★ 開機還原剛套好的那組值，在這個載入週期內優先重套（2026-08-17）。
       loadData 一次載入會跑**不只一次** renderAll（本機快照秒畫一次、真資料到貨再一次），
       而 _pendingRestoreRange 是一次性的 —— 第二次進來時它已經是 null、_savedBarSpacing 在
       開機時也還是 null → 掉到最下面那條「貼最新 N 根」，把剛剛還原好的位置整個蓋掉。
       實測：使用者把留白拉到 35 根，重整後 options().rightOffset 確實是 35（還原成功了），
       但畫面上只剩 3 根 —— 就是被第二次 renderAll 的 setVisibleLogicalRange 蓋掉的。 */
    if (window._bootViewOpt) {
      try { ts.applyOptions(window._bootViewOpt); _bgPosAnchor = window._bootViewOpt; return; } catch (e) {}
    }
    // 有保存縮放(barSpacing) → 用持久選項還原縮放 + 最新棒水平位置(rightOffset)。
    // 持久選項跨 setData/fitContent/背景載入都不會被沖掉（解決「切幾次後黏回右邊」）。
    if (_savedBarSpacing != null) {
      // 還原端同樣夾限 rightOffset(治「已存進垃圾值」的舊狀態:半屏K棒下限+絕對60)
      const _ro = Math.max(_savedRightOffset || 0, _defaultRightPad(_savedBarSpacing));
      const opt = { barSpacing: _savedBarSpacing, rightOffset: Math.min(_ro, _roCapFor(_savedBarSpacing)) };
      ts.applyOptions(opt);
      _bgPosAnchor = opt;   // 背景分頁載入每段後重套此錨點，防縮放被 fitContent 壓回 0.5
      return;
    }
    // 否則（首次、無保存）→ 預設貼最新 N 根，右側留一段空白（見 _defaultRightPad）
    const _prevRange = ts.getVisibleLogicalRange();
    const _barCount  = (_prevRange && _savedBarCount != null) ? _savedBarCount : 50;
    if (data.length > _barCount) {
      const _pad = Math.min(20, Math.max(3, Math.round(_barCount * 0.06)));
      ts.setVisibleLogicalRange({ from: data.length - _barCount + _pad, to: data.length - 1 + _pad });
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
        const _ro = Math.max(pr.rightOffset || 0, _defaultRightPad(pr.barSpacing));
        const opt = { barSpacing: pr.barSpacing, rightOffset: Math.min(_ro, _roCapFor(pr.barSpacing)) };
        _ts.applyOptions(opt);
        _bgPosAnchor = opt;
        _bootViewHold(opt);   // 這個載入週期內的後續 renderAll 一律重套同一組（見 _restoreByBarCount）
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
    const _anchorT = _savedTimeRange.to;             // 使用者切換前「右緣」所在的時間(要對齊的點)
    const _bc = Math.max(5, _savedBarCount || 50);   // 原可見根數＝縮放
    // ⚠ 保持縮放(TradingView式)：右緣放在目標時間、往左顯示「同樣根數」→ 大切小不再塞整段日曆時間
    //   (舊「保持時長」setVisibleRange 會把幾千根小K擠成一片＝使用者說的「塞滿/滑動/跳好幾張才到」的根因)。
    // 防踩重申：延遲的 fitContent/resize 可能晚一幀把縮放壓爛(span 爆掉)→ span 偏離目標 >60% 才重申。
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
    const _placeAtAnchor = () => {
      const idx = _nearestIdxByTime(_anchorT);
      if (idx == null) { _restoreByBarCount(); return; }
      _guardRestore(() => { try { mainChart.timeScale().setVisibleLogicalRange({ from: idx - _bc, to: idx }); } catch (e) {} });
      if (window._bootAnchorHold === _anchorT) { window._bootAnchorHold = null; _holdAnchorByTime(_anchorT, _bc); }
    };
    if (_anchorT >= _first && _anchorT <= _last + 1) {
      // 目標時間已在載入資料內 → 一次定位到目標段、保持原縮放(單張畫面直達,不跳不滑)
      _placeAtAnchor();
    } else if (_anchorT < _first) {
      // 目標比已載最早還早(小時框初次只載近段)→ 先貼最舊;記下目標,背景補到涵蓋時再定位到目標(仍保持縮放)。
      _pendingAlignRange = { anchorT: _anchorT, bc: _bc };
      _guardRestore(() => { try { mainChart.timeScale().setVisibleLogicalRange({ from: 0, to: _bc }); } catch (e) {} });
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
  // _bt(d)：用 _rebuildTimeIndex 已算好的秒數（見該函式註）；3 條線 × 34k 根原本是 10 萬次 ISO 解析
  const line = k => data.filter(d => Number.isFinite(d[k])).map(d => ({ time:_bt(d), value:d[k] }));   // Number.isFinite 擋 null/undefined/NaN(否則 LWC paint 拋「Value is null」)
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

// 2026-08-05 移除「S1~S12 訊號標記一鍵隱藏」（_wrSignalsHidden / #wrSignalsToggleBtn）：
// S1~S12 與 SS 系列都已刪除，開關控制的東西不存在了 → 標記固定顯示。

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
      ...lastWRSignalMarkers,
      ...(window._fvgTradesHidden ? [] : lastFVGTradeMarkers),
      ...((window._fvgBBHidden || window._fvgBBHideD) ? [] : lastFVGBBMarkers),
      ...((window._fvgBBHidden || window._fvgBBHideA) ? [] : lastFVGBBMarkersA),
      // M版(順多/順空/順平)已從主圖移除——不再合併進標記，console 也叫不出來
      // 破多/破空·多/空·順多/順空 三組已改由 charts.js 的 _makeStratMarkersPrimitive 自畫(隨 K 棒縮放、與棒同步)→ 不再走原生 setMarkers
      ...(window._coachOn ? lastSMCSweepMarkers : []),           // SMC 掃頂/掃底(階段1:SR+SMC 教練疊加層,右上開關)
      ...(window._coachOn ? lastCoachBOSMarkers : []),           // 教練步驟5(BOS)達成點箭頭(右上開關)
    ].sort((a, b) => a.time - b.time);
    /* 這裡原本會「標記一變就整份重畫成交量」，唯一目的是套上面那個淡化。
       淡化拿掉後成交量與標記完全無關 → 連帶省掉每次標記更新的一次全量 setData。 */
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
// 開關：window.toggleDimCounterTrend() 切換「大時框順勢過濾」→ 逆大時框趨勢標記淡化(primitive draw 內即時判定)
window.toggleDimCounterTrend = function (on) {
  window._dimCounterTrendOn = (on === undefined) ? !window._dimCounterTrendOn : !!on;
  _applyMainMarkers();
  return window._dimCounterTrendOn;
};

/* 2026-08-05 移除 initWRSignalsToggle()（頂部「S1~S12 訊號標記」一鍵開關）。
   S1~S12 與 SS 都已刪除，按鈕、手機設定列(#mSetWrSig)、localStorage "wrSignalsHidden"
   與 winrate.js 的 signals 跳過群組一併清掉。
   ⚠ window._wrSigSeries 仍被 winrate.js 讀取（標記系列過濾，現固定 "all"）→ 保留設值。 */
window._wrSigSeries = "all";


// 成交量棒透明度(hex)：天氣模式(sky-show)強制不透明，否則用使用者 volAlpha。
//   原因：主圖背景透明讓天氣透出後，半透明量條會被後面持續動的天氣動畫透出→「最新棒一閃一閃/跳」。
//   不透明就擋住後面的天氣，量條穩定(天氣仍在量條間空隙與上方透出)。
function _volAlphaHex() {
  if (document.documentElement.classList.contains("sky-show")) return "ff";
  return Math.round((S.volAlpha ?? 0.67) * 255).toString(16).padStart(2, "0");
}

/* 成交量一律用使用者的 volAlpha，不做任何淡化（2026-08-16 使用者：「我不要淡化」）。
   ★ 原本這裡會在「有多/空・破多空標記」時，把**沒有標記的棒**壓到 alpha 1f（12%）——
     沒有任何開關可以關，使用者看到的就是「有些成交量被淡化」。
     而且 replay.js / realtime.js 那兩條更新路徑從來都用 _va → 最新那根永遠全亮、
     旁邊的歷史棒卻是淡的，同一張圖上兩種亮度。
   ⚠ 別再加回來：真要「顯化某些棒」請走獨立開關，預設關。 */
function renderVolume(data) {
  const _va = _volAlphaHex();
  volSeries.setData(data.map(d => ({
    time: _bt(d),
    value: d.volume || 0,
    color: (d.close >= d.open ? C.volUp : C.volDown) + _va,
  })));
  // 每次重新套用 scale 設定，避免切換標的或市場後比例跑掉。
  // ⚠ 數值統一放 charts.js 的 MAIN_SCALE_MARGINS / VOL_SCALE_MARGINS，別在這裡再寫一份
  //   （原本兩邊各一份，這份會蓋掉那份 → 改了 charts.js 卻沒效果）。
  applyMainScaleMargins();
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
/* ── 副圖指標「可見範圍窗化」(2026-07-31) ───────────────────────────────────────
   ★為什麼:使用者回報「放大後滑動卡」,真機+重現實測(BTC/USDT.P 5m、19,500 根、bs 90):
       副圖關 中位 16.7ms / 0 個長幀   ←→   副圖開 中位 188.5ms / 157 個長幀（11 倍）
     且與 DPR 無關(DPR1 189.6 / DPR2 188.5)、與 backdrop-filter 無關(關掉沒改善)、
     **JS 只佔 0.1%** → 時間全在 LWC 內部重繪。
     主圖自己同樣 19,500 根卻只要 16.7ms:主圖拖曳走 LWC 內部捲動快速路徑,副圖是每幀被
     setVisibleLogicalRange 強制**重新佈局**,成本隨該圖 series 的總點數走。
     決定性實驗(同 session 背對背):副圖 series 19,495 點 → 216.9ms;砍到 2,000 點 → 90.1ms(2.4x)。
   → 指標線只餵「可見範圍 ± 緩衝」。⚠ 錨點(kdjAnchor 等)必須維持全長:副圖的 logical index
     空間靠它與主圖對齊,截斷錨點會讓跨圖同步的 range 對不上(這是 07-28「一直往前帶」的成因)。
   ・視野移出目前窗(留 25% 邊際)才重算 → 一般拖曳不會每幀重建。 */
let _subWin = null;          // {lo, hi} 目前指標線涵蓋的 ohlcvData 索引範圍
let _subWinTimer = null;

function _subWindowFor(n) {
  let vr = null;
  try { vr = mainChart.timeScale().getVisibleLogicalRange(); } catch (e) {}
  if (!vr || !Number.isFinite(vr.from) || !Number.isFinite(vr.to)) return { lo: Math.max(0, n - 4000), hi: n };
  const span = Math.max(50, vr.to - vr.from);
  const pad = Math.max(1500, Math.round(span * 2));      // 左右各留兩屏
  return { lo: Math.max(0, Math.floor(vr.from) - pad), hi: Math.min(n, Math.ceil(vr.to) + pad) };
}

/* 時框 → 秒數（**唯一定義**）。
   ⚠ 這張表原本在本檔被複製了 5 份、CHUNK_DAYS 複製了 2 份。同一份對照表散在多處，
     只要有人新增時框卻漏改其中一份就會出事 —— 本專案已因此連續踩過三次
     （BG_TF 兩份、台股分桶規則兩份、台股解析兩份）。一律收斂成單一來源。
   ⚠ 刻意**不含 1w / 1M**，維持原本「查不到就當 3600」的行為：其中三個呼叫端
     （loadData / _trimRollingWindow / _scheduleIdleTrim）沒有 BG_TF 閘門、1w/1M 走得到，
     現在把它們補進表裡等於偷改行為。要改的話單獨一次改、單獨驗。 */
const CHUNK_DAYS = { "1m": 5, "5m": 25, "15m": 80, "1h": 240, "4h": 950, "30m": 240, "2h": 730, "1d": 4000 };
const TF_SEC = { "1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600,"2h":7200,"4h":14400,"1d":86400 };
function tfSec(tf) { return TF_SEC[tf] || 3600; }

/* 背景補載支援的時框（**唯一定義**）。
   ⚠ 原本這份 Set 在本檔被複製了兩份，realtime.js 判斷「缺口補不補得動」也要用同一份 —
   抄多份必然分歧（台股才因此出過兩次事）。掛在 window 上讓跨檔共用同一個來源。 */
const BG_TF = new Set(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);   // 8h 已移除
window._BG_TF = BG_TF;

let _subAnchorSig = "";   // 錨點目前對應的時間軸簽章（見 _renderSubcharts）

function _renderSubcharts(data) {
  if (_subchartsHidden()) return;
  // 濾掉壞棒(缺 time/算出 NaN 時間)→ 否則 anchor/指標線的時間為 NaN,LWC paint 會拋「Value is null」(切時框報錯)
  const _valid = data.filter(d => d && Number.isFinite(_bt(d)));
  // ★時間軸沒變就不重設錨點（2026-07-31）：錨點只帶「時間」、值是固定的 50/0，完全不含價格
  //   → 只要時間軸一樣，重設出來的東西逐格相同，純屬白做。
  //   而 _scheduleSubRewindow（平移到窗緣時重開窗）每次都會走到這裡，那條路徑底層資料根本沒動，
  //   等於每次平移都白重建三條全長 series。實測 4382 根時錨點佔整個 _renderSubcharts 的 34%
  //   （3.21ms / 9.35ms），根數越多越貴。
  //   簽章＝根數＋首尾時間：append/prepend/修剪/切標的/切時框 任一種都會改到其中之一。
  const _sig = _valid.length + "|" + (_valid.length ? _bt(_valid[0]) + "|" + _bt(_valid[_valid.length - 1]) : "");
  if (_sig !== _subAnchorSig) {
    const anchorTimes = _valid.map(d => ({ time: _bt(d), value: 50 }));
    kdjAnchor.setData(anchorTimes);        // ★錨點維持全長(對齊用,見上方註)
    rsiAnchor.setData(anchorTimes);
    macdAnchor.setData(anchorTimes.map(d => ({ ...d, value: 0 })));
    _subAnchorSig = _sig;
  }
  _subWin = _subWindowFor(_valid.length);
  const _slice = _valid.slice(_subWin.lo, _subWin.hi);
  renderKDJ(_slice);
  renderRSI(_slice);
  renderMACD(_slice);
}

/* 視野移動 → 需要時重建指標線的窗（debounce；在窗內就完全不做事）。由 charts.js 同步流程呼叫。 */
function _scheduleSubRewindow() {
  if (_subchartsHidden() || replayActive || !ohlcvData.length) return;
  if (!_subWin) return;
  let vr = null;
  try { vr = mainChart.timeScale().getVisibleLogicalRange(); } catch (e) {}
  if (!vr || !Number.isFinite(vr.from)) return;
  const span = Math.max(50, vr.to - vr.from);
  const margin = Math.max(300, span * 0.5);              // 距窗緣 25% 內就提前重建 → 不會滑出空白
  if (vr.from > _subWin.lo + margin && vr.to < _subWin.hi - margin) return;
  clearTimeout(_subWinTimer);
  _subWinTimer = setTimeout(() => {
    if (_subchartsHidden() || replayActive || !ohlcvData.length) return;
    try { _renderSubcharts(ohlcvData); } catch (e) {}
  }, 90);
}
window._scheduleSubRewindow = _scheduleSubRewindow;

function renderKDJ(data) {
  data = data.filter(d => d && Number.isFinite(_bt(d)));   // 自我防禦:濾壞時間棒(NaN 時間→LWC paint「Value is null」);所有呼叫點(含背景排程用未濾 ohlcvData)都安全
  // _bt(d)：用 _rebuildTimeIndex 已算好的秒數（見該函式註）；3 條線 × 34k 根原本是 10 萬次 ISO 解析
  const line = k => data.filter(d => Number.isFinite(d[k])).map(d => ({ time:_bt(d), value:d[k] }));   // Number.isFinite 擋 null/undefined/NaN(否則 LWC paint 拋「Value is null」)
  kdjK.setData(line("kdj_k")); kdjD.setData(line("kdj_d")); kdjJ.setData(line("kdj_j"));
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    const _k20 = Number.isFinite(S.kdjH20val) ? S.kdjH20val : 20, _k80 = Number.isFinite(S.kdjH80val) ? S.kdjH80val : 80;
    kdjH20.setData([{time:f,value:_k20},{time:l,value:_k20}]);
    kdjH50.setData([{time:f,value:50},{time:l,value:50}]);
    kdjH80.setData([{time:f,value:_k80},{time:l,value:_k80}]);
  }
}

function renderRSI(data) {
  data = data.filter(d => d && Number.isFinite(_bt(d)));   // 自我防禦:濾壞時間棒
  // _bt(d)：用 _rebuildTimeIndex 已算好的秒數（見該函式註）；3 條線 × 34k 根原本是 10 萬次 ISO 解析
  const line = k => data.filter(d => Number.isFinite(d[k])).map(d => ({ time:_bt(d), value:d[k] }));   // Number.isFinite 擋 null/undefined/NaN(否則 LWC paint 拋「Value is null」)
  const _r14 = line("rsi_14"), _r7 = line("rsi_7");
  rsiLine14.setData(_r14); rsiLine7.setData(_r7);
  // 超買/超賣填色：兩條 RSI 的值都餵過去，實際用哪幾條由 primitive 依「目前顯示中的線」
  // 決定（見 charts.js _makeRSIZonePrimitive）——看 RSI(7) 的人才不會覺得填色對不上。
  if (typeof window._setRSIZones === "function") {
    const m7 = new Map(_r7.map(p => [p.time, p.value]));
    window._setRSIZones(_r14.map(p => ({ t: p.time, v14: p.value, v7: m7.get(p.time) ?? null })));
  }
  if (data.length) {
    const f = toTime(data[0].time), l = toTime(data[data.length-1].time);
    const _r30 = Number.isFinite(S.rsiH30val) ? S.rsiH30val : 30, _r70 = Number.isFinite(S.rsiH70val) ? S.rsiH70val : 70;
    rsiH30.setData([{time:f,value:_r30},{time:l,value:_r30}]);
    rsiH50.setData([{time:f,value:50},{time:l,value:50}]);
    rsiH70.setData([{time:f,value:_r70},{time:l,value:_r70}]);
  }
}

function renderMACD(data) {
  data = data.filter(d => d && Number.isFinite(_bt(d)));   // 自我防禦:濾壞時間棒
  // ⚠ macd/signal/hist 各自可能為 null(signal 是 macd 的 EMA、更晚才有值)→ 必須各欄位獨立過濾,
  //   否則「有 macd 但 signal 還沒有」的棒會餵 {value:null} 給 LWC Line → 拋「Value is null」(切時框報錯)。
  macdLine.setData(data.filter(d => Number.isFinite(d.macd)).map(d => ({ time:toTime(d.time), value:d.macd })));
  macdSignal.setData(data.filter(d => Number.isFinite(d.macd_signal)).map(d => ({ time:toTime(d.time), value:d.macd_signal })));
  macdHist.setData(data.filter(d => Number.isFinite(d.macd_hist)).map(d => ({
    time:toTime(d.time), value:d.macd_hist,
    color: d.macd_hist >= 0 ? C.up+"cc" : C.down+"cc",
  })));
}

/* ══════════════════════════════════════════
   即時更新
══════════════════════════════════════════ */

function _bgApplyChunk(data, nPrepended) {
  // ⚡ 副圖隱藏(預設)時:3 條錨點 series 在 display:none 的圖上、setData 純白工 → 跳過(每塊補載省 3 條全量
  //    setData + 2 次全量 map,把切 chunk 的 ~100ms 頓砍掉大半)。副圖打開時由 renderAll 重建錨點,不影響。
  if (!(typeof _subchartsHidden === "function" && _subchartsHidden())) {
    // 增量建錨點（只 map 新的那段，不重建全量）
    const _vf = arr => arr.filter(d => d && Number.isFinite(_bt(d)));   // 濾壞時間棒→anchor 不含 NaN 時間(否則 LWC paint「Value is null」)
    if (_bgAnchorCache && nPrepended > 0) {
      const slice   = _vf(data.slice(0, nPrepended));
      _bgAnchorCache = [...slice.map(d => ({ time: toTime(d.time), value: 50 })), ..._bgAnchorCache];
      _bgMacdCache   = [...slice.map(d => ({ time: toTime(d.time), value: 0  })), ..._bgMacdCache];
    } else {
      const _v = _vf(data);
      _bgAnchorCache = _v.map(d => ({ time: toTime(d.time), value: 50 }));
      _bgMacdCache   = _v.map(d => ({ time: toTime(d.time), value: 0  }));
    }
    kdjAnchor.setData(_bgAnchorCache);
    rsiAnchor.setData(_bgAnchorCache);
    macdAnchor.setData(_bgMacdCache);
    _subAnchorSig = "";   // 這裡繞過 _renderSubcharts 直接改了錨點 → 讓它的快取簽章失效
  }
  // applyOhlcvToSeries：直接更新 candleSeries，不呼叫 setMarkers（避免 marker 清空閃爍）
  applyOhlcvToSeries(data);
  // 輕量 volume 更新（跳過 priceScale.applyOptions 避免 layout thrashing）
  // 透明度與 renderVolume 一致（都是純 _va，不淡化）
  const _va = _volAlphaHex();
  volSeries.setData(data.map(d => ({
    time: _bt(d),
    value: d.volume || 0,
    color: (d.close >= d.open ? C.volUp : C.volDown) + _va,
  })));
}

// 指標 debounce：每段 chunk 後重設計時器，最後一段完成 800ms 後才計算
function _bgScheduleIndicators() {
  if (replayActive) return;
  clearTimeout(_bgIndicatorTimer);
  _bgIndicatorTimer = setTimeout(() => {
    if (!ohlcvData.length) return;
    renderBB(ohlcvData);
    if (!_subchartsHidden()) setTimeout(() => { _renderSubcharts(ohlcvData); }, 0);   // 走 _renderSubcharts 才有窗化(見該函式註)
    if (_lastWRSignals.length) _renderWRSignals();
  }, 800);
}

async function _bgLoadOlderBars(scrollTriggered = false) {
  if (!BG_TF.has(currentTF) || _bgLoadInProgress || !ohlcvData.length) return;

  const snapMarket   = document.getElementById("marketSelect").value;
  const snapSymbol   = document.getElementById("symbolInput").value.trim();
  const snapTf       = currentTF;
  const snapExchange = document.getElementById("exchangeSelect").value;

  // 初始自動載入目標：只預載適量緩衝（約數千根），其餘可視範圍外的舊資料延後 → 滑動時再分頁抓
  // （scrollTriggered 走 SCROLL_DAYS）。常駐根數大降 → 縮放/平移順（5m 原 180d≈5.2萬根 → 14d≈4千根）。
  // 代價：較舊的訊號標記要滑到才顯示；勝率 HUD 統計走後端、不受影響。
  const INIT_DAYS   = { "1m": 3, "5m": 14, "15m": 45, "1h": 120, "4h": 730, "30m": 60, "2h": 180, "1d": 730 };
  // 連續往舊滑的深度上限:滾動修剪讓常駐根數有界後,可放深到資料源極限(Binance 5m 約 2020 起≈2200天;
  //   抓到沒資料自然停)。小時框大幅放深→往舊滑看更久之前的回測(不再 2 年就停)。
  // ★ 2026-08-15 日線 5000 → 20000 天（約 54.8 年）：使用者要「台股日K 拉到最舊」。
  //   5000 天只到 2012 左右，但資料源其實更深 —— 實測 2330 的 yfinance 日線可回到
  //   **2000-01-04**（6617 根）、AAPL 可回到 **1980-12-12**（11510 根）。日線很輕（54 年也才約 13600 根，
  //   加密 5m 深滑常駐都 25000 根了）→ 直接放到資料源自己沒資料為止。
  const SCROLL_DAYS = { "1m": 60, "5m": 2400, "15m": 2400, "1h": 3000, "4h": 4000, "30m": 2400, "2h": 3000, "1d": 20000 };
  const totalDays   = scrollTriggered ? (SCROLL_DAYS[snapTf] || 365) : (INIT_DAYS[snapTf] || 30);
  let   targetStartTs = Math.floor(Date.now() / 1000) - totalDays * 86400;
  // 看歷史切時框:分頁串流必須補到「你正在看的那段」才停,否則對齊落空(切不到同一天)。
  //   把目標深度延伸到待對齊起點前 1 天(近段仍先載、含現在→不會往最新斷)。
  const _tfSec = tfSec(snapTf);
  if (_pendingAlignRange) {
    // 補到「目標時間 − 可見根數×時框」再前 1 天 → 確保目標右緣左側有足夠根數(保持縮放)
    targetStartTs = Math.min(targetStartTs, _pendingAlignRange.anchorT - _pendingAlignRange.bc * _tfSec - 86400);
  }

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
  window._bgLoadDir = "older";            // 方向標記:供 scroll 觸發器判斷是否需搶佔(反向時中止本次改跑對向)
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
      let newBars = json.data.filter(b => toTime(b.time) < existingEarliest);
      if (!newBars.length) break;

      // ★接合檢查(與 _bgLoadNewerBars 對稱):原本只判斷「比開頭舊」就 prepend,只要抓回來的區塊
      //   結尾比我們的開頭早一截,就會**靜默接出一個洞**——K 棒只是少一段、不報錯,極難察覺。
      //   接不上先補中間那段一次;補不到才照接(資料源真的沒有),並記入 window._dataHoles 供診斷。
      const _lastNew = toTime(newBars[newBars.length - 1].time);
      if (_lastNew < existingEarliest - _tfSec * 1.5) {
        try {
          const gRes = await fetch("/api/ohlcv", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              market: snapMarket, symbol: snapSymbol, timeframe: snapTf, exchange: snapExchange,
              start: toIso(_lastNew), end: toIso(existingEarliest + 86400), limit: 0, indicators: false,
            }),
          });
          if (gRes.ok && guard() && myGen === _bgLoadGen) {
            const gj = await gRes.json();
            const patch = (gj.data || []).filter(b => toTime(b.time) < existingEarliest);
            if (patch.length) {
              const seen = new Set();
              newBars = newBars.concat(patch)
                .filter(b => { const t = toTime(b.time); if (seen.has(t)) return false; seen.add(t); return true; })
                .sort((a, b) => toTime(a.time) - toTime(b.time));
            }
          }
        } catch (e) { /* 補洞失敗就照原樣接,可用性優先 */ }
        const _l2 = toTime(newBars[newBars.length - 1].time);
        if (_l2 < existingEarliest - _tfSec * 1.5) {
          const miss = Math.round((existingEarliest - _l2) / _tfSec) - 1;
          (window._dataHoles = window._dataHoles || []).push(
            { sym: snapSymbol, tf: snapTf, from: newBars[newBars.length - 1].time, to: ohlcvData[0].time, miss });
          console.warn(`[補舊] 資料源缺 ${miss} 根(${snapSymbol} ${snapTf}) → 照接,已記入 window._dataHoles`);
        }
      }

      const nPrepended = newBars.length;
      ohlcvData = newBars.concat(ohlcvData);
      _rebuildTimeIndex();  // 效能：背景載入舊 K 棒後重建 Map

      // 看歷史切小時框:初次載入太短→對齊落空(先貼最舊);背景補到涵蓋目標時間時,把視野拉回目標(保持縮放)。
      let _alignPa = null;
      if (_pendingAlignRange && ohlcvData.length && toTime(ohlcvData[0].time) <= _pendingAlignRange.anchorT + 1) {
        _alignPa = _pendingAlignRange; _pendingAlignRange = null;
      }

      if (replayActive) {
        // 重播中：靜默累積，不碰圖表
      } else if (_alignPa) {
        // 對齊到歷史目標:右緣放目標時間、往左顯示同樣根數(保持縮放,與初次還原一致);多套幾次防延遲 fitContent 壓回。
        const _applyAlign = () => {
          try {
            const idx = _nearestIdxByTime(_alignPa.anchorT);
            if (idx == null) return;
            mainChart.timeScale().setVisibleLogicalRange({ from: idx - _alignPa.bc, to: idx });
            const lr = mainChart.timeScale().getVisibleLogicalRange();
            if (lr) [kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().setVisibleLogicalRange(lr); } catch (e) {} });
          } catch (e) {}
        };
        _syncSuspend(() => { _bgApplyChunk(ohlcvData, nPrepended); _applyAlign(); });   // 換資料+對齊原子化(對齊目標依新資料算 index,無法前置)
        requestAnimationFrame(_applyAlign);
        setTimeout(_applyAlign, 130);
        setTimeout(_applyAlign, 380);
        // 視野已拉回目標段 → 收掉一路撐著的過場暗場(那段「滑動到」就藏在暗場下、使用者看不到)
        setTimeout(() => { if (typeof window._chartDimOff === "function") window._chartDimOff(); }, 400);
        _bgScheduleIndicators();
      } else if (scrollTriggered) {
        // ★看歷史滑動補舊:確定性 logical 位移——prepend nPrepended 根→視野同步 +nPrepended(數學上停在同幾根,
        //   不用時間軸捕捉→不會捕到瞬間退化視野而縮到1根/亂跳)。子圖同步。★不套「貼最新」錨點(那會貼回最新)。
        const vr = mainChart.timeScale().getVisibleLogicalRange();
        const _incAnchor = nPrepended;
        // ⚠ 這裡曾經有「補舊時順手把右側最新那批剪掉」讓 n 有界的程式碼,2026-07-30 停用、
        //   2026-07-31 刪除(留這段說明避免有人再實作一次):
        //   ・它剪的正是右緣 = LWC 捲動定位(rightOffset)的基準 → 剪完視野必被往舊帶,一定跳。
        //   ・想在同一批用 setVisibleLogicalRange 補償也沒用:setData 排到繪製才生效、補償立刻生效,
        //     中間必然畫錯一幀(逐幀量到 −317/−458 根的往返)。這條路已窮盡,別再試。
        //   ★記憶體改由 _scheduleIdleTrim 在「停手且滑回最新附近」時回收——那時剪的是左側、
        //     右緣不動 → 不跳。代價是一路往舊滑的過程中常駐根數會超過 TRIM_MAX,滑回來才收掉。
        const shifted = vr ? { from: vr.from + nPrepended, to: vr.to + nPrepended } : null;
        // ★這裡若剛剪過右側,也要把 LWC 真正用來捲動的位置一起設對(同 _scheduleIdleTrim 的說明):
        //   只設 logical range 的話,換資料那一幀 LWC 會拿舊 rightOffset 重算 → 畫面整整偏掉一個
        //   緩衝區(實測 −4500 根,正好等於保留緩衝 BUF)。⚠ 一樣要夾上界,否則會被拉到最新 K。
        // ⚠ withScroll 只能在 setData **之後**傳 true:ro 是用 ohlcvData.length(新長度)算的,
        //   但 setData 前圖表裡還是舊資料 → 把「新空間的偏移」套到舊資料上會整整偏掉一個緩衝區
        //   (實測 −4500 根,正好等於 BUF;這是 2026-07-30 追出來的真正原因)。
        const _setShifted = (withScroll) => {
          try {
            if (!shifted) return;
            mainChart.timeScale().setVisibleLogicalRange(shifted);
            [kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().setVisibleLogicalRange(shifted); } catch (e) {} });
            if (withScroll) {
              const ro = Math.min(0, shifted.to - (ohlcvData.length - 1));   // 夾上界:正值會被拉到最新K
              [mainChart, kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().scrollToPosition(ro, false); } catch (e) {} });
            }
          } catch (e) {}
        };
        // ★換資料+補償視野必須原子化(_syncSuspend):否則 setData 期間各圖發出的「舊 index 空間」range
        //   會被 rAF 延遲的跨圖同步(_flushSync)在補償之後推回主圖 → 該幀畫在未補償位置、下一幀才彈回
        //   ＝ 往舊滑「被帶到銜接點」的閃跳(2026-07-28 逐幀量到 −194/−317 根)。
        _syncSuspend(() => {
          if (shifted) _setShifted(false);     // setData 前:只設 logical range(此時圖表仍是舊資料)
          _bgApplyChunk(ohlcvData, _incAnchor);
          if (shifted) _setShifted(true);      // setData 後:連 LWC 的捲動位置一起設對
        });
        // 只在被延遲操作壓回最右緣時才搶回(條件式,不無腦覆寫、不干擾使用者續滑)
        if (shifted) {
          const _reassert = () => {
            if (myGen !== _bgLoadGen) return;
            try { const cur = mainChart.timeScale().getVisibleLogicalRange(); if (cur && shifted.to < ohlcvData.length - 3 && cur.to >= ohlcvData.length - 3) _setShifted(true); } catch (e) {}
          };
          requestAnimationFrame(_reassert);
          setTimeout(_reassert, 120);
          setTimeout(_reassert, 350);
        }
        _bgScheduleIndicators();
      } else {
        // 看最新的自動預載(非滑動):用 logical shifted 補償 prepend + 重套「貼最新」錨點,維持最新棒位置。
        const visRange = mainChart.timeScale().getVisibleLogicalRange();
        const shifted  = visRange
          ? { from: visRange.from + nPrepended, to: visRange.to + nPrepended }
          : null;
        const _setShifted = () => {
          try {
            mainChart.timeScale().setVisibleLogicalRange(shifted);
            [kdjChart, rsiChart, macdChart].forEach(c => c.timeScale().setVisibleLogicalRange(shifted));
          } catch (e) {}
        };
        _syncSuspend(() => {                    // 同上:換資料+補償原子化,不讓延遲同步推回舊 range
          if (shifted) _setShifted();
          _bgApplyChunk(ohlcvData, nPrepended);
          if (shifted) _setShifted();
        });
        if (_bgPosAnchor) { try { mainChart.timeScale().applyOptions(_bgPosAnchor); } catch (e) {} }
        _bgScheduleIndicators();
      }

      // 往歷史載入更多 K 棒後，若已超過目前「標記近段窗(vw)」→ 觸發勝率重取(debounced)：
      //   後端用更大的 vw 補算舊區的 FVG/多空·破多空·順多空 標記，讓往回滑也看得到策略。(勝率統計不變)
      if (!replayActive && typeof fetchWinRate === "function" && typeof _wrVwFor === "function"
          && _wrVwFor(ohlcvData.length) > (window._wrCurVw || 0)) {
        fetchWinRate();
      }
      // 快接近下一階 vw 時,先在背景把它算進後端快取(warm=1,只回幾十 bytes)
      //   → 真的升階時是命中快取(16ms)而不是冷算(~2.5s),消掉「越滑越久才出標記」
      if (!replayActive && typeof _wrWarmNextTier === "function") _wrWarmNextTier();
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
          if (!_subchartsHidden()) setTimeout(() => { _renderSubcharts(ohlcvData); }, 0);   // 走 _renderSubcharts 才有窗化(見該函式註)
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

/* 滾動視窗修剪:總根數超過上限時,只保留「可見範圍 ± 緩衝」、刪掉離開視野太遠的兩側資料 →
   往一邊一直補時另一邊自動丟棄,常駐根數維持有界(避免半年前往右補回現在又累積成幾萬根→卡)。
   回傳「左側被刪的根數」供呼叫端補償視野位移(刪左側→既有 index 下移)。重播中不修。 */
/* 修剪門檻(2026-07-28 調高 15000→40000)。
   ★為什麼:LWC 內部的捲動定位點是 **rightOffset(距離最後一根幾根)**。往左補舊只是往左加棒子、
   右緣不動 → 定位點語意不變、安全(往右滑補新只剪左側,實測從頭到尾 0 跳動);但「剪掉右側最新棒」
   會把右緣往左移 → 同一個 rightOffset 指到更舊的位置 → 視野被往舊帶(=使用者回報的『一直往舊跳』)。
   實測:關掉修剪 → 往舊/往右滑跳動全 0;開著 → 每次修剪那幀就跳一次。
   我們雖然有 logical range 補償,但 LWC 那一幀的重算仍用舊 rightOffset(見 _scheduleIdleTrim 註)。
   → 策略:門檻大幅拉高讓修剪變罕見,且只在真的停手(_scheduleIdleTrim debounce 1.5s)時做。
   代價:常駐根數上限 15k→40k(約 4MB、setData 略慢),換掉滑動中被亂帶。*/
const TRIM_MAX = 40000;

function _trimRollingWindow() {
  const MAX = TRIM_MAX, BUF = 4500;   // 保留視窗放大→往右滑一段後回頭往左仍在已載範圍內、不用重抓(消除「停一下才出來」)
  if (ohlcvData.length <= MAX || replayActive) return 0;
  let vr;
  try { vr = mainChart.timeScale().getVisibleLogicalRange(); } catch (e) { return 0; }
  // ⚠ 防呆:背景載入/切換途中視野可能是異常值(NaN 或 from>to 顛倒)→ 若不擋,slice(lo,hi) 在 hi<lo
  //   時會切成空陣列、把 ohlcvData 清空(series 卻還在)＝資料憑空消失的 bug。異常一律不修。
  if (!vr || !Number.isFinite(vr.from) || !Number.isFinite(vr.to) || vr.to <= vr.from) return 0;
  const lo = Math.max(0, Math.floor(vr.from) - BUF);
  const hi = Math.min(ohlcvData.length - 1, Math.ceil(vr.to) + BUF);
  if (hi <= lo || (hi - lo + 1) < 200) return 0;                 // 範圍不合理/會留太少→不修
  if (hi - lo + 1 >= ohlcvData.length) return 0;                 // 視野±緩衝已涵蓋全部→不修
  ohlcvData = ohlcvData.slice(lo, hi + 1);
  _rebuildTimeIndex();
  // 修剪後動態更新往後缺口旗標:若最新棒不到現在(右側被剪掉,如從看最新往左滑很多後)→標記有缺口,
  //   讓使用者往右滑時 _bgLoadNewerBars 能重新補回現在(否則回不去最新)。反之補到現在則清除。
  try {
    const _lastT = toTime(ohlcvData[ohlcvData.length - 1].time);
    const _nowSec = Math.floor(Date.now() / 1000) + 8 * 3600;
    const _tfS = tfSec(currentTF);
    window._hasFwdGap = _lastT < _nowSec - _tfS * 2;
  } catch (e) {}
  return lo;
}

/* 閒置滾動修剪:平移停手後,若常駐根數過多(往兩側補載累積)→ 只留可見±緩衝、其餘丟棄,
   讓 setData 成本與記憶體維持有界(往右補新的整包 setData 更快、頓幀更少)。
   ・debounce 600ms:只在真的停手才修,連續操作不打斷。
   ・時間軸還原:修剪改 index 但畫面停在「一模一樣的那幾根」上→修的當下畫面不動、無感。
   ・載入中/重播中不修。 */
/* ── 修剪遮罩 ────────────────────────────────────────────────────────────────
   修剪那一瞬 LWC 會用「舊 rightOffset × 新資料」畫錯一幀(逐幀實測 ±4500 根＝正好一個保留
   緩衝,下一幀才彈回;70 輪深滑抓到 5 次修剪 × 2 幀 = 10 次位移)。補償先設/後設/兩者都設/
   scrollToPosition/改用時間全部試過都擋不掉——根因是 LWC 的 setData 延後到繪製才生效、
   而補償是立刻生效,兩者天生不同步。
   → 不再跟它的幀序纏鬥:修剪前把每個 pane 的畫布內容拷成一張靜態圖蓋在原位,修完等三幀
     (補償確定生效)、驗位置對了才撤掉。使用者全程看到「完全靜止且正確」的畫面。
   ・只蓋 .pane-body(圖表畫布區),不蓋圖例/HUD → 那些 DOM 不受影響、不會閃。
   ・只在停手 1.5s 後的閒置修剪走這條;一場深滑最多幾次 → 拷貝成本(數 ms)無感。
   ・★保險絲:1 秒後無論如何強制撤掉。任何例外都不可能把圖表永久凍住。 */
function _trimMaskShow() {
  const out = [];
  try {
    const bodies = document.querySelectorAll("#chartsContainer .pane-body");
    for (const host of bodies) {
      const r = host.getBoundingClientRect();
      if (!r.width || !r.height) continue;                 // 收合/隱藏的 pane 跳過
      const dpr = window.devicePixelRatio || 1;
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      cv.style.cssText = `position:absolute;left:0;top:0;width:${r.width}px;height:${r.height}px;z-index:40;pointer-events:none`;
      const ctx = cv.getContext("2d");
      ctx.scale(dpr, dpr);
      let n = 0;
      for (const c of host.querySelectorAll("canvas")) {
        const cr = c.getBoundingClientRect();
        if (!cr.width || !cr.height) continue;
        try { ctx.drawImage(c, cr.left - r.left, cr.top - r.top, cr.width, cr.height); n++; } catch (e) {}
      }
      if (!n) continue;
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      host.appendChild(cv);
      out.push(cv);
    }
  } catch (e) {}
  if (out.length) {
    window._trimMaskOn = true;
    clearTimeout(_trimMaskFuse);
    _trimMaskFuse = setTimeout(() => _trimMaskHide(out), 1000);   // ★保險絲
  }
  return out;
}
let _trimMaskFuse = null;
function _trimMaskHide(masks) {
  clearTimeout(_trimMaskFuse);
  try { for (const m of (masks || [])) m.remove(); } catch (e) {}
  window._trimMaskOn = false;
}

/* ── 回到最新（⏭）───────────────────────────────────────────────────────────
   修剪為了壓住記憶體會把「現在」那一段丟掉 → 從深歷史滑回來只能靠背景補新，實測要拖 13~14 次
   （每補一塊又多出好幾千根要拖過去）。這顆是唯一的捷徑。
   ・資料仍到現在（只是視野捲走了）→ scrollToRealTime()，零成本、瞬間。
   ・資料被修剪掉了（_hasFwdGap）→ 走 loadData(forceLatest) 重載近段（保留縮放）。 */
function _goLatest() {
  try {
    if (typeof replayActive !== "undefined" && replayActive) return;
    if (window._hasFwdGap) { loadData(false, true); return; }
    [mainChart, kdjChart, rsiChart, macdChart].forEach(c => {
      try { c.timeScale().scrollToRealTime(); } catch (e) {}
    });
  } catch (e) {}
}
window._goLatest = _goLatest;

/* 按鈕顯示條件：有往後缺口(資料被修剪掉、回不到現在) 或 視野右緣離最新棒 > 一屏。
   由 charts.js 的 _flushSync 每次視野變動時呼叫（已節流），零額外訂閱。 */
function _updateGoLatestBtn() {
  const btn = document.getElementById("btnGoLatest");
  if (!btn) return;
  let show = false;
  try {
    if (!(typeof replayActive !== "undefined" && replayActive) && ohlcvData.length) {
      const r = mainChart.timeScale().getVisibleLogicalRange();
      if (r) {
        const span = Math.max(1, r.to - r.from);
        show = !!window._hasFwdGap || (r.to < ohlcvData.length - 1 - span);
      }
    }
  } catch (e) {}
  if (btn.hidden === show) btn.hidden = !show;
}
window._updateGoLatestBtn = _updateGoLatestBtn;

let _idleTrimTimer = null;
function _scheduleIdleTrim() {
  clearTimeout(_idleTrimTimer);
  _idleTrimTimer = setTimeout(() => {
    if (replayActive || _bgLoadInProgress || !ohlcvData.length || ohlcvData.length <= TRIM_MAX) return;
    // 真的停手才修(見 TRIM_MAX 註):互動中修剪會動到右緣=LWC 定位點 → 視野被往舊帶
    if (window._chartMoveTs && performance.now() - window._chartMoveTs < 900) { _scheduleIdleTrim(); return; }
    // ★確定性 logical:捕捉一次可見範圍 vr,同時用它算「保留區」+「位移補償」→數學上保證
    //   ①span 不變(vr.to-lo)-(vr.from-lo)=原span→不會縮到1根 ②視野一定在保留區內(vr.to≤hi)→右緣不空。
    let vr;
    try { vr = mainChart.timeScale().getVisibleLogicalRange(); } catch (e) { return; }
    if (!vr || !Number.isFinite(vr.from) || !Number.isFinite(vr.to) || (vr.to - vr.from) < 3) return;
    const BUF = 4500;
    const lo = Math.max(0, Math.floor(vr.from) - BUF);
    const hi = Math.min(ohlcvData.length - 1, Math.ceil(vr.to) + BUF);
    if (hi - lo + 1 >= ohlcvData.length) return;   // 已涵蓋全部→不修
    // ★看歷史時也要修剪(2026-07-30 復原,靠上方 _trimMaskShow 遮罩擋掉那一幀)。
    //   為什麼一定要修:不修剪＝常駐根數無界。5m 深滑實測 90 輪長到 18 萬根、JS heap 破 1GB、
    //   單幀最長 1127ms(中位 224ms);開修剪後穩在 2.6~4 萬根、heap 95~353MB、最長 228ms。
    //   為什麼要遮罩:往歷史滑時能省的只有「右端」,而右端正是 LWC 的捲動基準(rightOffset) →
    //   動它必錯一幀。遮罩把那一幀蓋住,是唯一不必跟 LWC 幀序纏鬥的解。
    const _mask = _trimMaskShow();
    ohlcvData = ohlcvData.slice(lo, hi + 1);
    _rebuildTimeIndex();
    // 修剪後動態更新往後缺口(右側被剪→標記,右滑可補回)
    try {
      const _lastT = toTime(ohlcvData[ohlcvData.length - 1].time);
      const _nowSec = Math.floor(Date.now() / 1000) + 8 * 3600;
      const _tfS = tfSec(currentTF);
      window._hasFwdGap = _lastT < _nowSec - _tfS * 2;
    } catch (e) {}
    // ★換資料+補償原子化:修剪 setData 期間各圖發出的舊 index range 若被延遲同步推回主圖,
    //   會出現「畫在未補償位置一幀、下一幀彈回」的閃跳(實測 ±317 根,見 _bgLoadOlderBars 註)。
    const sh = { from: vr.from - lo, to: vr.to - lo };       // 確定性位移補償(刪左 lo 根)

    // 修剪那一幀,LWC 會拿「舊 rightOffset」配新資料重算一次(實測 9510−4822−508=4180=畫錯的那幀),
    //   所以除了 logical range,也要把它真正用來捲動的位置一起設對 → 那一幀就不會錯位。
    //   ⚠ **必須夾住上界 Math.min(0, …)**:2026-07-28 第一次試沒夾,視野若已捲過資料右緣(vr.to > n−1)
    //     算出來會是正值＝往「未來」捲 → 整個被拉到最新 K(比閃一下嚴重得多)。夾住後才安全。
    const _applyTrim = (withScroll) => {
      try {
        mainChart.timeScale().setVisibleLogicalRange(sh);
        [kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().setVisibleLogicalRange(sh); } catch (e) {} });
        if (withScroll) {
          const ro = Math.min(0, sh.to - (ohlcvData.length - 1));
          [mainChart, kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().scrollToPosition(ro, false); } catch (e) {} });
        }
      } catch (e) {}
    };
    _syncSuspend(() => {
      // ★★ setData 之「前」也要先設一次(2026-07-28 逐幀追出來的關鍵):只在 setData 後補償的話,
      //   LWC 會在處理完資料更新後自己冒出一個瞬態 range(實測差 317 根、無任何 set 呼叫)、**那一幀就被畫出來**,
      //   下一幀才回到我們設的值 → 使用者看到閃跳。先設好、再 setData：LWC 沿用既有 logical range,
      //   換完資料就已經在正確位置,不產生瞬態。(補舊那條路本來就前後各設一次,故無此問題)
      // ★修剪**不能**像補舊那樣「setData 前先設一次」:資料已 slice 但圖表還是舊資料,
      //   把新座標(如 [4500,5009])設上去會指到**舊陣列**的第 4500 根＝更早很多的內容
      //   → 那一幀就整整偏掉一個緩衝區(實測 −4500 根,2026-07-30 追出來的真正原因)。
      //   補舊(prepend)可以先設是因為位移是 +nPrepended、方向相反且會被 setData 立刻蓋掉。
      _bgApplyChunk(ohlcvData, 0);
      _applyTrim(true);
    });
    // ★同步重算指標:BB 用 debounce 會被載入殘留的大 n renderBB 蓋掉→BB series 停在 6 萬根+破洞(與修剪後 K 線對不上=「銜接斷掉」)。
    //   修剪後直接 renderBB(當前 ohlcvData) 保證同步;副圖仍走 debounce。
    if (typeof renderBB === "function") renderBB(ohlcvData);
    _bgScheduleIndicators();
    if (typeof _renderFVGMS === "function") _renderFVGMS();
    if (typeof _renderFVGShun === "function") _renderFVGShun();
    if (typeof _renderFVGBreak === "function") _renderFVGBreak();
    if (typeof _renderFVGSpecial === "function") _renderFVGSpecial();
    if (typeof _renderFVGTrades === "function") _renderFVGTrades();
    // ★所有 series setData / setMarkers 做完後「再補一次視野」:每次資料更新 LWC 都會依自己保留的
    //   捲動位置重推可見範圍,補償之後才做的那些 setData(BB/指標/標記)會把視野推歪一幀(逐幀量到的
    //   瞬態就落在這個空檔)。最後補這一次 → 換資料整段結束時位置一定是對的。
    _syncSuspend(() => _applyTrim(true));
    // ★等三幀讓補償真的落地,驗位置對了才撤遮罩;沒到位就再補一次(而不是把錯位露出來)。
    let _f = 0;
    const _settle = () => {
      if (++_f < 3) { requestAnimationFrame(_settle); return; }
      try {
        const cur = mainChart.timeScale().getVisibleLogicalRange();
        if (cur && (Math.abs(cur.from - sh.from) > 1 || Math.abs(cur.to - sh.to) > 1)) {
          _syncSuspend(() => _applyTrim(true));
          requestAnimationFrame(() => _trimMaskHide(_mask));
          return;
        }
      } catch (e) {}
      _trimMaskHide(_mask);
    };
    requestAnimationFrame(_settle);
  }, 1500);
}
window._scheduleIdleTrim = _scheduleIdleTrim;

/* 往「新(未來/現在)」方向背景補載(捲歷史抓的有界視窗未到現在時,往右拖到近右緣觸發)。
   與 _bgLoadOlderBars 對稱:往右 append、不改既有 index;補完順手滾動修剪左側 → 常駐根數有界。 */
async function _bgLoadNewerBars(scrollTriggered = false) {
  /* ⚠ 入口多一個 _srcRealign：即時輪詢發現「來源換了」時，時間軸其實沒有洞
     （_hasFwdGap 是 false），但整串數值已經和我們手上這份差幾點 → 也要進來重對齊一次。 */
  if (!BG_TF.has(currentTF) || _bgLoadInProgress || !ohlcvData.length
      || !(window._hasFwdGap || window._srcRealign)) return;

  const snapMarket   = document.getElementById("marketSelect").value;
  const snapSymbol   = document.getElementById("symbolInput").value.trim();
  const snapTf       = currentTF;
  const snapExchange = document.getElementById("exchangeSelect").value;
  const _tfSec   = tfSec(snapTf);
    const chunkDays  = CHUNK_DAYS[snapTf] || 30;
  const nowSec = Math.floor(Date.now() / 1000) + 8 * 3600;   // chart-time(+8h)的「現在」
  const toIso  = ts => new Date(ts * 1000).toISOString().slice(0, 10);
  const guard  = () =>
    document.getElementById("marketSelect").value === snapMarket &&
    document.getElementById("symbolInput").value.trim() === snapSymbol &&
    currentTF === snapTf;

  const myGen = ++_bgLoadGen;
  _bgLoadInProgress = true;
  window._bgLoadDir = "newer";
  let loadedThisRun = 0;
  const SCROLL_BUDGET = 10000;

  try {
    while (myGen === _bgLoadGen && _bgLoadInProgress && guard()) {
      const latestTs = toTime(ohlcvData[ohlcvData.length - 1].time);
      // 已補到現在 → 正常情況直接收工；但若是「來源換手要重對齊」，仍需抓一次來覆蓋數值。
      if (latestTs >= nowSec - _tfSec && !window._srcRealign) { window._hasFwdGap = false; break; }

      const startTs = latestTs + 1;
      const endTs   = Math.min(startTs + chunkDays * 86400, nowSec + 86400);

      const res = await fetch("/api/ohlcv", {
        method: "POST", headers: { "Content-Type": "application/json" },
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

      const existingLatest = toTime(ohlcvData[ohlcvData.length - 1].time);
      /* ★ 2026-08-06 邊界那根要用抓回來的權威值蓋掉 —— 不能只接它後面的。
         輪詢中斷（休眠／背景分頁／斷線）時，我們的最後一根往往停在「中斷當下的未完成值」；
         補載若只 append 它之後的棒，那根就永遠停在半路 → 與下一根的開盤價對不上，
         就是使用者回報的「有時候還是要重新整理，K 棒才不會有小跳空」。
         ⚠ 這種洞的**時間軸是連續的** → _checkContinuity（只驗時間間隔）永遠抓不到；
           realtime.js 的 `t < lastT` 補正也搆不到（那只覆蓋 /api/latest 回的最後 3 根，
           中斷若久於此，邊界那根早就不在回應裡了）。這是第三條路徑，要在這裡收。
         ⚠ 不必額外發請求：start 用 toIso() 截到日界，回應本來就含這根。
         ⚠ 也不用額外重畫：它就是 ohlcvData 最後一根，下面 concat 後會整張 _bgApplyChunk。 */
      /* ★ 來源換手時要整段重對齊（2026-08-06）。
         只補尾端 5 根是為了修「停在半路的棒」；但若這批資料來自**另一個來源**，
         整串數值都會差幾點 —— 只換尾端等於把接縫往前挪一格，換多少根就挪多少格。
         → 不同源時，把「回應涵蓋範圍內我們已經有的每一根」全部換成這份快照，
           整個近端視窗就是同一份、內部連續，接縫消失（殘留的接縫落在回應涵蓋的最左端，
           通常是一天以前、視野外）。
         ⚠ 成本可忽略：只是 Map 查表 + 覆寫，而且後面本來就要整張 setData。 */
      const _srcNow = json.src || null;
      const _srcDiff = (!!_srcNow && !!window._ohlcvSrc && _srcNow !== window._ohlcvSrc)
                       || !!window._srcRealign;      // 即時輪詢已偵測到換源 → 這次一定整段對齊
      window._srcRealign = false;                    // 一次就好，避免每輪重抓
      if (_srcNow) window._ohlcvSrc = _srcNow;
      /* ⚠ 不能只校正**最後一根**：中斷時「還沒收到最終值」的往往不只一根。
         實測（1m、中斷 4 分鐘）：只蓋最後一根之後，接縫從邊界後一格移到邊界那格
         —— 因為它前一根也還停在半路。realtime 的 `t < lastT` 補正只覆蓋 /api/latest
         回的最後 3 根，中斷期間那幾根根本沒機會被補到。
         → 尾端 5 根只要在抓回來的資料裡有對應時間且值不同，一律用權威值蓋掉。
         5 根是刻意的上限：realtime 只碰得到尾端，再往前的棒不可能是半路值，
         全掃只會白花時間（而且會把使用者正在看的歷史段一起重寫）。 */
      const _auth = new Map();
      for (const b2 of json.data) _auth.set(toTime(b2.time), b2);
      /* ⚠ 效能：來源換手時 _fixFrom=0，這個迴圈會掃整個 ohlcvData（TRIM_MAX 上限 4 萬根）。
         兩個必要的優化，實測 40000 根 8.9ms → 0.13ms（66x）：
         ① 用每根快取好的 _t，不要每根都 toTime()（那是 new Date(iso) 完整解析）。
         ② 一旦掃到比「回應涵蓋的最舊那根」還舊，後面不可能有對應 → 直接 break。
         沒有這兩點的話，換源當下會多出 ~9ms 的同步工作（正好卡在使用者看得到的那一刻）。 */
      const _oldestAuth = json.data.length ? toTime(json.data[0].time) : Infinity;
      const _fixFrom = _srcDiff ? 0 : Math.max(0, ohlcvData.length - 5);
      for (let k = ohlcvData.length - 1; k >= _fixFrom; k--) {
        const _cur = ohlcvData[k];
        const _ct = _cur._t != null ? _cur._t : toTime(_cur.time);
        if (_ct < _oldestAuth) break;
        const _a = _auth.get(_ct);
        if (!_a) continue;
        /* ★ 2026-08-08 改成「整根換，或完全不動」——**絕不混兩份快照**。
           舊版是「保留 open、只換 h/l/c」（為了修使用者說的「最新 K 棒會動一下」）。
           那在同一份快照裡沒事，但這裡的權威資料可能來自**另一次抓取／另一個交易所**，
           於是 open 來自 A、h/l/c 來自 B → 縫出**不可能的 K 棒**：連續性守門員實測傾印到
           `O65082 但 L65084.1`（低點比開盤還高）。畫出來就是使用者說的「K 棒怪怪的、會動」。
           新規則：四欄有任何一欄不同 → **整根用權威值**（內部一定一致）；
                   完全相同 → 一個欄位都不碰（浮點量化差異也不會讓它抖，比舊版更穩）。 */
        const _same = +_cur.open === +_a.open && +_cur.high === +_a.high
                   && +_cur.low === +_a.low && +_cur.close === +_a.close;
        if (_same) continue;
        /* ★ 2026-08-08 只補「我們手上這根是半路值」的情況。
           判準＝權威值的範圍**涵蓋**我們這根（high 只會更高、low 只會更低）——
           那正是「還沒收完就被我們記下來」的形狀，補上去是把它補完整。
           反過來若權威值比較窄或整根平移，代表那是**另一份快照**（另一次抓取/另一個交易所），
           拿它去蓋一根早就定案的棒，畫面上就是使用者說的「K 棒自己在動」
           （實測 age=5 的棒四欄一起位移 3.2 點，就是這樣來的）。
           ⚠ 這跟 realtime.js 那個「別加閘門」的教訓不衝突：那裡擋的是「只補一半欄位」，
             這裡是**整根補或整根不補**，永遠不會把兩份快照縫在一起。
           ⚠ 來源真的換手（_srcDiff）時不套這個閘門：那時整段本來就該對齊到新來源。 */
        if (!_srcDiff && !(+_a.high >= +_cur.high && +_a.low <= +_cur.low)) continue;
        ohlcvData[k] = { ..._cur, ..._a, _t: _ct };
      }
      let newBars = json.data.filter(b => toTime(b.time) > existingLatest);
      if (!newBars.length) { window._hasFwdGap = false; break; }   // 沒有更新的→已到現在

      // ★接合檢查(2026-07-30 加):原本只判斷「比尾巴新」就 concat,只要抓回來的區塊起點比我們的
      //   尾巴晚一截,就會**靜默接出一個洞**——K 棒只是少一段、不報錯,極難察覺(這次就是倉庫檔缺
      //   434 根,一路到深滑 E2E 才抓到)。→ 接不上先補中間那段一次;補不到就照接(資料源真的沒有,
      //   例如標的上市前/交易所停機),但把洞記到 window._dataHoles 供診斷。
      if (toTime(newBars[0].time) > existingLatest + _tfSec * 1.5) {
        try {
          const gRes = await fetch("/api/ohlcv", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              market: snapMarket, symbol: snapSymbol, timeframe: snapTf, exchange: snapExchange,
              start: toIso(existingLatest), end: toIso(toTime(newBars[0].time) + 86400),
              limit: 0, indicators: false,
            }),
          });
          if (gRes.ok && guard() && myGen === _bgLoadGen) {
            const gj = await gRes.json();
            const patch = (gj.data || []).filter(b => toTime(b.time) > existingLatest);
            if (patch.length) {
              // 併回去重排序:補到的中段 + 原本那塊
              const seen = new Set();
              newBars = patch.concat(newBars)
                .filter(b => { const t = toTime(b.time); if (seen.has(t)) return false; seen.add(t); return true; })
                .sort((a, b) => toTime(a.time) - toTime(b.time));
            }
          }
        } catch (e) { /* 補洞失敗就照原樣接,可用性優先 */ }
        if (toTime(newBars[0].time) > existingLatest + _tfSec * 1.5) {
          const miss = Math.round((toTime(newBars[0].time) - existingLatest) / _tfSec) - 1;
          (window._dataHoles = window._dataHoles || []).push(
            { sym: snapSymbol, tf: snapTf, from: ohlcvData[ohlcvData.length - 1].time, to: newBars[0].time, miss });
          console.warn(`[補新] 資料源缺 ${miss} 根(${snapSymbol} ${snapTf}) → 照接,已記入 window._dataHoles`);
        }
      }

      // ★確定性 logical:append 不改既有 index;只修剪「左側」(往右看時最舊在畫面外)、用捕捉的 vr 算保留區
      //   → 絕不剪到剛 append 的右側最新棒(舊版 _trimRollingWindow 讀瞬態 vr 會誤剪右側→資料右緣前進又倒退)。
      //   刪左 _cut 根→既有 index −_cut。
      const vr = mainChart.timeScale().getVisibleLogicalRange();
      ohlcvData = ohlcvData.concat(newBars);        // 往右 append
      _rebuildTimeIndex();
      let _cut = 0;
      // ⚠ 重播中不修剪（2026-07-31 補上，其他修剪路徑本來就有守 replayActive、只有這裡漏了）：
      //   重播期間圖上畫的是 replayData 的前綴，vr 是**重播座標**；而 ohlcvData 是另一個還在
      //   成長、而且可能已被往前補過舊資料（index 整體位移）的陣列。拿重播座標去切 ohlcvData
      //   等於切錯位置。平常 vr.from 很小（keepLo 算出 0）所以看不出來，但只要復盤到 4550 根
      //   之後、且 ohlcvData 超過 TRIM_MAX，就會剪掉不該剪的一段。
      //   重播中本來就「靜默累積、不碰圖表」（見下方 if (!replayActive)），退出時 renderAll
      //   會整包重畫 → 不修剪只是常駐根數多一點，退出後閒置修剪會收掉。
      if (!replayActive && vr && Number.isFinite(vr.from) && ohlcvData.length > TRIM_MAX) {
        const keepLo = Math.max(0, Math.floor(vr.from) - 4500);   // 保留視野左側 4500 根,其餘(更舊)丟棄
        if (keepLo > 50) { _cut = keepLo; ohlcvData = ohlcvData.slice(_cut); _rebuildTimeIndex(); }
      }

      if (!replayActive) {
        const shifted = vr ? { from: vr.from - _cut, to: vr.to - _cut } : null;
        const _apply = () => { try { if (shifted) { mainChart.timeScale().setVisibleLogicalRange(shifted); [kdjChart, rsiChart, macdChart].forEach(c => { try { c.timeScale().setVisibleLogicalRange(shifted); } catch (e) {} }); } } catch (e) {} };
        // 同上:剪掉左側後不可先設(會指到舊陣列的別處),只在 setData 後設
        _syncSuspend(() => { _bgApplyChunk(ohlcvData, 0); _apply(); });
        requestAnimationFrame(() => {
          try {
            const cur = mainChart.timeScale().getVisibleLogicalRange();
            if (cur && shifted && shifted.to < ohlcvData.length - 3 && cur.to >= ohlcvData.length - 3) _apply();
          } catch (e) {}
        });
        _bgScheduleIndicators();
      }

      loadedThisRun += newBars.length;
      if (scrollTriggered && loadedThisRun >= SCROLL_BUDGET) break;
      await new Promise(r => setTimeout(r, 100));
    }
  } catch { /* 背景失敗靜默 */ } finally {
    if (myGen === _bgLoadGen) {
      _bgLoadInProgress = false;
      _bgAnchorCache = null;
      _bgMacdCache   = null;
      if (!replayActive) {
        clearTimeout(_bgIndicatorTimer);
        if (guard() && ohlcvData.length) {
          renderBB(ohlcvData);
          if (!_subchartsHidden()) setTimeout(() => { _renderSubcharts(ohlcvData); }, 0);   // 走 _renderSubcharts 才有窗化(見該函式註)
          if (_lastWRSignals.length) _renderWRSignals();
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
