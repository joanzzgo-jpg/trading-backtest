document.addEventListener("DOMContentLoaded", async () => {
  loadPrefs();

  // ── 全域互動讓路：任何捲動/觸控拖曳/滾輪 → 標記 _chartMoveTs → 背景天氣動畫降到 ~15fps 讓出主執行緒。
  //    原本只有「圖表平移/縮放」會觸發降幀；滑行情列、切分頁、頁面捲動時天氣仍全速跑而搶主執行緒＝卡。
  //    這裡補上全域覆蓋(snoop 現成 _chartMoveTs 機制，零新系統)。scroll 用 capture 才抓得到內層容器捲動。
  {
    const _mark = () => { if (window._uxMark) window._uxMark(); else window._chartMoveTs = (performance.now ? performance.now() : Date.now()); };
    document.addEventListener("scroll", _mark, { capture: true, passive: true });
    window.addEventListener("touchmove", _mark, { passive: true });
    window.addEventListener("wheel", _mark, { passive: true });
  }

  // 開場首頁：按「開始」淡出進入圖表（圖表已在背景照常載入，按下時已就緒）
  (function initLanding() {
    const scr = document.getElementById("landingScreen");
    const btn = document.getElementById("landingStartBtn");
    if (!scr || !btn) return;
    const DAY = 86400000;
    let timer = null;
    const seenAt = () => { try { return parseInt(sessionStorage.getItem("landingDismissedAt") || "0", 10); } catch (e) { return 0; } };
    const art = scr.querySelector(".landing-art");
    const hide = () => {   // 點大門 → 進場序列：換開門圖 → 門內漸變放大 + 暖光鋪滿 → 進圖表
      if (scr.classList.contains("landing-entering")) return;          // 防重複觸發
      try { sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {}
      if (art && art.dataset.open) art.src = art.dataset.open;          // 換成「開門」圖
      scr.classList.add("landing-entering");                           // 觸發 zoom + 暖光動畫
      setTimeout(() => {                                               // 暖光快鋪滿後才還原圖表（避免邊緣穿幫）
        document.documentElement.classList.remove("landing-active");
        if (typeof resizeAll === "function") resizeAll();
      }, 1050);
      setTimeout(() => {                                               // 動畫結束 → 收掉首頁、還原關門圖
        scr.style.display = "none";
        scr.classList.remove("landing-entering", "landing-hide");
        if (art && art.dataset.closed) art.src = art.dataset.closed;
      }, 1300);
      armReshow();
    };
    const show = () => {
      if (typeof window._lunarHide === "function") window._lunarHide();  // 先關掉已開著的農民曆卡，避免封面圖跳出來重疊
      document.documentElement.classList.remove("landing-skip");
      document.documentElement.classList.add("landing-active");       // 重新露出天氣背景、隱藏圖表 UI
      scr.classList.remove("landing-entering", "landing-hide", "landing-locking");
      if (art && art.dataset.closed) art.src = art.dataset.closed;    // 還原關門圖
      scr.style.display = "";
      void scr.offsetWidth;                 // reflow → 讓淡入 transition 生效
    };
    window._landingShow = show;   // 登出 → 跳回封面頁（account.js 呼叫）
    const checkExpiry = () => {                // 一直開著超過 24h → 自動重新跳首頁
      const ts = seenAt();
      if (ts && Date.now() - ts >= DAY) {
        if (timer) { clearInterval(timer); timer = null; }
        try { sessionStorage.removeItem("landingDismissedAt"); } catch (e) {}
        show();
      }
    };
    const armReshow = () => { if (timer) clearInterval(timer); timer = setInterval(checkExpiry, 60000); };
    window._landingEnter = hide;   // 帳號鎖解鎖後接續開門進場（account.js 呼叫）
    btn.addEventListener("click", () => {
      if (scr.classList.contains("landing-entering")) return;
      // 未登入 → 點門先放大、跳鎖要求輸入帳號（未登入不能直接用主圖）。
      // _acctEnabled !== false：連狀態未知時也先擋，避免快速點擊繞過；確認停用才放行。
      if (!window._acctName && window._acctEnabled !== false) {
        if (!scr.classList.contains("landing-locking")) {
          scr.classList.add("landing-locking");
          setTimeout(() => document.getElementById("landingAcctInput")?.focus(), 420);
        }
        return;
      }
      // 已登入 或 帳號功能確認停用 → 直接開門進主圖
      hide();
    });
    // 鎖開著時點門外暗區 → 取消、縮回（不進場）
    scr.addEventListener("click", e => {
      if (!scr.classList.contains("landing-locking")) return;
      if (e.target.closest("#landingAcct") || e.target === btn) return;
      scr.classList.remove("landing-locking");
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkExpiry(); });
    // 首屏已被 head script 跳過（同 session reload）→ landing 已隱藏，仍要排程 24h 後重跳
    if (document.documentElement.classList.contains("landing-skip")) { scr.style.display = "none"; armReshow(); }
  })();

  // 極簡模式：覆蓋 C（指標／線條／蠟燭顏色）為純白底專用配色（in-memory only，savePrefs 已擋）
  // 黃色、淡青、淡藍在白底上看不見，這份 palette 全部換成在白底上對比夠的深色
  if (document.documentElement.classList.contains("perf-mode")) {
    Object.assign(C, {
      up: "#ef5350", down: "#26a69a",
      borderUp: "#ef5350", borderDown: "#26a69a",
      wickUp: "#ef5350", wickDown: "#26a69a",
      volUp: "#ef5350", volDown: "#26a69a",
      bbU: "#1976d2", bbM: "#f57c00", bbL: "#1976d2", bb1: "#64b5f6",   // 黃色換成深橘；1σ 淺藍
      kdjK: "#d32f2f", kdjD: "#1565c0", kdjJ: "#ef6c00",
      kdjH20: "#9e9e9e", kdjH50: "#bdbdbd", kdjH80: "#9e9e9e",
      kdjCrossBull: "#16a34a", kdjCrossBear: "#dc2626",
      rsi14: "#6a1b9a", rsi7: "#d32f2f",
      rsiH30: "#9e9e9e", rsiH50: "#bdbdbd", rsiH70: "#9e9e9e",
      macd: "#1565c0", macdSig: "#ef6c00", macdHist: "#9e9e9e",
      crtBull: "#16a34a", crtBear: "#dc2626",
      resonanceBull: "#00838f", resonanceBear: "#ef6c00",  // 淡青換成深青
      bg: "#FFFFFF", chartBg: "#FFFFFF",
    });
  }

  _loadWatchlist();
  loadLastSymbol();     // 還原上次標的、交易所、市場、時間框架
  loadSystemColors();
  applyAllSystemColors();
  // 極簡模式：覆蓋成純白系極簡配色（蓋掉 applyAllSystemColors 寫入的暗色 inline style）
  // 這份 palette 是極簡模式專屬、固定不可調整；正常模式的使用者自訂色仍存在 localStorage.sysColors
  if (document.documentElement.classList.contains("perf-mode")) {
    const _lightPalette = {
      "sc-bg":     "#FFFFFF",  // 主背景＋topbar
      "sc-panel":  "#FAFAFA",  // 面板內部
      "sc-border": "#E5E5E5",  // 邊框淡灰
      "sc-text":   "#1F1F1F",  // 近黑文字
      "sc-muted":  "#8B8B8B",  // 中灰次要文字
      "sc-blue":   "#FF6A1A",  // 保留橘色品牌色作 accent
    };
    for (const [id, color] of Object.entries(_lightPalette)) applySystemColor(id, color);
    const _ds = document.documentElement.style;
    _ds.setProperty("--bg4",    "#F0F0F0");
    _ds.setProperty("--green",  "#16a34a");
    _ds.setProperty("--red",    "#dc2626");
    _ds.setProperty("--accent", "#FF6A1A");
  }
  loadSymHistory();
  loadPaneFlexes();   // 套用儲存的面板比例（在 buildCharts 前，讓第一次 resize 即正確）
  buildCharts();
  _bindChartHoverTracking();  // 綁定圖表 hover 偵測，hover 時 realtime poll 不打斷
  bindEvents();
  _renderWatchlist();
  bindTickerPanel();
  bindSystemColors();
  initSymSearch();
  syncTimeScales();
  if (typeof initDrawTools === "function") initDrawTools();   // draw.js 已延遲載入時→由 draw.js 末段自我初始化
  updateMarketUI();
  applyAllColors();
  startTickerRefresh();
  _initWrTargetBtn();   // 勝率欄目標切換按鈕初始狀態
  _initWrStopBuffer();  // 勝率欄停損緩衝輸入
  _initSubChartsToggle();  // 副圖指標 顯示/隱藏 toggle（左下浮按鈕）
  _initMarketPill();       // 市場切換動畫 pill（Crypto / TW / US）
  if (typeof initAccount === "function") initAccount();   // 帳號 + 跨裝置同步（後端未啟用會自動隱藏入口）
  if (typeof initSessionToggle === "function") initSessionToggle();  // 交易時段標記開關
  if (typeof initWeekBoxToggle === "function") initWeekBoxToggle();  // 週框開關
  if (typeof initVPToggle === "function") initVPToggle();  // 成交量分佈圖開關（右上）
  if (typeof initCoachToggle === "function") initCoachToggle();  // SR+SMC 教練疊加層開關（右上·階段1:掃頂掃底）
  if (typeof initVwapToggle === "function") initVwapToggle();  // VWAP 成交量加權均價 獨立開關（右上）
  if (typeof initWRSignalsToggle === "function") initWRSignalsToggle();  // S1~S12 訊號標記 一鍵開關
  if (typeof initMobileTF === "function") initMobileTF();            // 手機 TF 選擇器（自選最多4個顯示）
  if (typeof initNotify === "function") initNotify();                // CRT 訊號 Web Push 通知（後端未設 VAPID 會自動隱藏入口）
  if (typeof initTrade === "function") initTrade();                  // Binance 永續交易面板（後端未設交易金鑰會自動隱藏入口）
  window.addEventListener("beforeunload", () => { saveLastSymbol(); });

  // 手機底部分頁：切換 圖表 / 勝率 / 自選 三個畫面（用 body class 控制各畫面顯示）
  (function initMobileTabs() {
    const bar = document.getElementById("mTabbar");
    if (!bar) return;
    const setTab = (t) => {
      if (t === "chart") t = "wr";   // 「圖表」分頁已併入「勝率」（勝率頁本就含圖表）→ 舊呼叫一律導向 wr
      document.body.classList.remove("m-tab-chart", "m-tab-wr", "m-tab-watch", "m-tab-signals", "m-tab-settings", "m-tab-trade");
      document.body.classList.add("m-tab-" + t);
      bar.querySelectorAll(".m-tab").forEach(b => b.classList.toggle("active", b.dataset.mtab === t));
      // 交易分頁：把交易面板撐成滿版（_trdEnterTab 載入持倉/口令並開輪詢）；離開即收掉輪詢
      if (t === "trade" && window._trdEnterTab) window._trdEnterTab();
      if (t !== "trade" && window._trdLeaveTab) window._trdLeaveTab();
      // 自選分頁：標記 ticker 面板為「開啟」狀態，fetchTickers/renderTickers 才會渲染（手機判斷需要）
      const tp = document.getElementById("tickerPanel");
      if (tp) tp.classList.toggle("ticker-open", t === "watch");
      if (t === "watch" && typeof fetchTickers === "function") fetchTickers();
      // 切到「設定」分頁 → 立即更新頂部天氣卡（重新定位+抓天氣，weather.js 內建 10s 節流）
      if (t === "settings" && window._wxRefreshNow) window._wxRefreshNow();
      // 切到「訊號」分頁 → 載入訊號通知中心（聊天室）並開始輪詢
      if (t === "signals" && window._ntfLoadFeed) window._ntfLoadFeed();
      if (t !== "signals" && window._ntfStopFeedPoll) window._ntfStopFeedPoll();
      if (typeof resizeAll === "function") setTimeout(resizeAll, 80);
      try { localStorage.setItem("mLastTab", t); } catch (e) {}   // 記住目前分頁 → 刷新/重開留在原地
    };
    bar.querySelectorAll(".m-tab").forEach(b => b.addEventListener("click", () => {
      setTab(b.dataset.mtab);
      // 點選圖標動畫：移除→強制 reflow→加回 class，確保每次點都重播一次
      const ico = b.querySelector(".m-tab-ico");
      if (ico) { ico.classList.remove("m-ico-anim"); void ico.offsetWidth; ico.classList.add("m-ico-anim"); }
    }));
    // 暴露給其他模組：在自選分頁點標的後切回圖表分頁（ticker.js 用）
    window._mSetTab = setTab;
    // 初始分頁：?mtab= 可指定（方便測試）＞ 上次停留的分頁(mLastTab，刷新/重開留在原地) ＞ 預設勝率
    const _VALID_TABS = ["chart", "wr", "watch", "signals", "settings", "trade"];
    const _mt = new URLSearchParams(location.search).get("mtab");
    let _init = _VALID_TABS.includes(_mt) ? _mt : null;
    if (!_init) { try { _init = localStorage.getItem("mLastTab"); } catch (e) {} }
    setTab(_VALID_TABS.includes(_init) ? _init : "wr");
  })();

  // 手機版：整體頁面下拉刷新（pull-to-refresh）。body overflow:hidden、各分頁滿版內層捲動 →
  // 原生下拉刷新不會觸發，故自訂：捲動容器在頂端時往下拉超過門檻即 location.reload()。
  (function initPullRefresh() {
    if (typeof isMobileUI === "function" && !isMobileUI()) return;   // 桌面版不裝
    const ind = document.createElement("div");
    ind.id = "mPullRefresh";
    ind.innerHTML = '<div class="mpr-spinner"></div>';
    document.body.appendChild(ind);

    const THRESH = 68;    // 觸發刷新的下拉距離(px)
    const MAX = 96;       // 指示器最大下移
    let startY = 0, startX = 0, scroller = null, pulling = false, decided = false, dist = 0;

    // 找觸控點所在、真正可「垂直」捲動的祖先；沒有就用根捲動元素
    function _vscrollerOf(el) {
      while (el && el !== document.body && el.nodeType === 1) {
        if (el.scrollHeight > el.clientHeight) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") return el;
        }
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }
    function _reset() {
      pulling = false; decided = false; dist = 0;
      ind.classList.remove("visible", "ready", "loading");
      ind.style.transform = "";
    }

    // 觸控點是否落在圖表區矩形內（用幾何範圍判，因城門頁/標記層等會蓋在圖表上，
    // 用 closest("#chartsContainer") 選擇器判不到 → 改用 getBoundingClientRect）。
    function _inChart(x, y) {
      const cc = document.getElementById("chartsContainer");
      if (!cc) return false;
      const r = cc.getBoundingClientRect();
      return r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }
    window.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { _reset(); return; }
      const t = e.touches[0];
      startY = t.clientY; startX = t.clientX;
      // 圖表（拖曳/縮放）與畫布、標記 data-no-ptr 的區塊不攔截 → 只從圖表以外(頂欄/清單/設定)下拉
      if (_inChart(startX, startY) || (e.target.closest && e.target.closest("canvas, [data-no-ptr]"))) {
        pulling = false; scroller = null; return;
      }
      scroller = _vscrollerOf(e.target);
      pulling = (scroller.scrollTop <= 0);   // 只有已捲到頂才可能是下拉刷新
      decided = false; dist = 0;
    }, { passive: true });

    window.addEventListener("touchmove", (e) => {
      if (!pulling || !scroller) return;
      const t = e.touches[0];
      const dy = t.clientY - startY, dx = t.clientX - startX;
      if (!decided) {                        // first move 決定方向：主要是水平 or 往上 → 交還原生
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) { pulling = false; return; }
        decided = true;
      }
      if (scroller.scrollTop > 0) { _reset(); return; }   // 中途捲離頂端 → 取消
      dist = Math.min(MAX, dy * 0.5);        // 阻尼
      if (dist > 2) {
        e.preventDefault();                  // 接手：擋掉原生 overscroll
        ind.classList.add("visible");
        ind.classList.toggle("ready", dist >= THRESH);
        ind.style.transform = `translateX(-50%) translateY(${dist}px)`;
      }
    }, { passive: false });

    function _end() {
      if (!pulling || !decided) { _reset(); return; }
      if (dist >= THRESH) {                  // 過門檻 → 刷新
        ind.classList.remove("ready"); ind.classList.add("loading");
        ind.style.transform = `translateX(-50%) translateY(${THRESH}px)`;
        setTimeout(() => location.reload(), 240);
      } else {
        _reset();
      }
    }
    window.addEventListener("touchend", _end, { passive: true });
    window.addEventListener("touchcancel", () => _reset(), { passive: true });
  })();

  // 手機版：勝率欄（頂部整塊）顯示/隱藏 —— 設定頁開關，關閉可把上方勝率 HUD 收起、圖表變大。
  // body.m-hide-wr 由 CSS 隱藏 #winrateBar+#wrTop3；狀態存 localStorage。只在手機款套用（桌面有自己版面）。
  (function initWrBarToggle() {
    const KEY = "mHideWr";
    const _read = () => { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } };
    const apply = (hide, resize) => {
      const mob = (typeof isMobileUI !== "function") || isMobileUI();
      document.body.classList.toggle("m-hide-wr", hide && mob);   // 桌面款不套用,避免 localStorage 帶到桌面隱藏勝率
      const st = document.getElementById("mSetWrBarState");
      if (st) st.textContent = hide ? "隱藏" : "顯示";
      const row = document.getElementById("mSetWrBar");
      if (row) row.classList.toggle("m-set-on", !hide);          // 顯示中=亮橘條
      if (resize && typeof resizeAll === "function") setTimeout(resizeAll, 80);   // 版面變動→圖表重算尺寸
    };
    apply(_read(), false);
    window._toggleWrBar = () => {
      const hide = !_read();
      try { localStorage.setItem(KEY, hide ? "1" : "0"); } catch (e) {}
      apply(hide, true);
    };
  })();

  // 手機字體大小（標準 / 大 / 特大）：body class 控制，存 localStorage（隨帳號同步）
  (function initMFontScale() {
    const apply = (v) => {
      document.body.classList.toggle("m-font-lg", v === "lg");
      document.body.classList.toggle("m-font-xl", v === "xl");
      const lbl = document.getElementById("mSetFontState");
      if (lbl) lbl.textContent = v === "lg" ? "大" : v === "xl" ? "特大" : "標準";
    };
    let v = ""; try { v = localStorage.getItem("mFontScale") || ""; } catch (e) {}
    apply(v);
    window._cycleMFontScale = () => {
      let cur = ""; try { cur = localStorage.getItem("mFontScale") || ""; } catch (e) {}
      const next = cur === "" ? "lg" : cur === "lg" ? "xl" : "";
      try { localStorage.setItem("mFontScale", next); } catch (e) {}
      apply(next);
      if (typeof resizeAll === "function") setTimeout(resizeAll, 60);
    };
  })();

  // 手機/PWA 省電：app 切到背景（鎖屏、切 app、切分頁）時暫停每秒輪詢（行情 + ticker），
  // 回到前景再恢復。避免背景持續打 API 耗電、也減輕伺服器負擔。
  // （天氣 canvas 動畫在 document.hidden 時本就跳過繪製、瀏覽器也會暫停 rAF，故不需另外處理）
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRealtime();
      if (typeof stopTickerRefresh === "function") stopTickerRefresh();
    } else {
      if (typeof startTickerRefresh === "function") startTickerRefresh();
      if (!replayActive && Array.isArray(ohlcvData) && ohlcvData.length) startRealtime();
    }
  });

  const _afterLoad = () => { loadVisibilityPrefs(); applyAllLineStyles(); };
  loadData(true).then(_afterLoad).catch(() => {
    // 失敗後 2 秒自動重試一次（Railway 冷啟動約需 1-3 秒）
    showToast("⚠️ 連線中，2 秒後自動重試…");
    setTimeout(() => {
      loadData(true).then(_afterLoad).catch(() => showToast("⚠️ 載入失敗，請點「載入」重試"));
    }, 2000);
  });

  // 極簡模式按鈕：開/關後重新整理頁面（最乾淨）
  const _perfBtn = document.getElementById("perfModeBtn");
  if (_perfBtn) {
    const _isPerf = document.documentElement.classList.contains("perf-mode");
    if (_isPerf) {
      _perfBtn.classList.add("active");
      _perfBtn.textContent = "☀️ 恢復完整特效";
    }
    // 手機「設定 → 極簡模式」列：開啟時高亮 + 狀態字（切換會 reload，故只需 init 設定）
    const _perfRow = document.getElementById("mSetPerf");
    if (_perfRow) _perfRow.classList.toggle("m-set-on", _isPerf);
    const _perfSt = document.getElementById("mSetPerfState");
    if (_perfSt) _perfSt.textContent = _isPerf ? "開啟中 · 關閉特效最省電" : "關閉 · 點擊開啟最省電模式";
    _perfBtn.addEventListener("click", () => {
      try {
        if (localStorage.getItem("perfMode") === "1") {
          localStorage.removeItem("perfMode");
        } else {
          localStorage.setItem("perfMode", "1");
        }
      } catch (e) {}
      location.reload();
    });
  }

  // 極簡模式：跳過 effects.js（SFX、BGM、天氣動畫、點擊特效），改用最小化的 FX 面板開關
  if (document.documentElement.classList.contains("perf-mode")) {
    const _panel = document.getElementById("fxPanel");
    const _btn   = document.getElementById("fxToggleBtn");
    if (_panel && _btn) {
      _btn.addEventListener("click", e => {
        e.stopPropagation();
        const open = _panel.classList.toggle("hidden");
        _btn.classList.toggle("fx-open", !open);
      });
      document.addEventListener("click", e => {
        if (!_panel.contains(e.target) && e.target !== _btn) {
          _panel.classList.add("hidden");
          _btn.classList.remove("fx-open");
        }
      });
    }
    return; // 不載入 effects.js
  }

  // 延遲載入特效（點擊特效/SFX 在 effects.js；天氣動畫在 weather.js），等瀏覽器閒置後再執行
  // 兩支皆獨立 IIFE，async=false 保留插入順序（互不依賴，順序僅為穩妥）
  const _loadFx = () => {
    const ver = window._APP_VER || "1";
    // draw / trade 也在此延遲載入（已移出首屏 bundle，省 ~42% 首屏 JS）；async=false 保留插入順序。
    // 兩者末段各自 initDrawTools()/initTrade() 自我初始化 → 載入完成即接手繪圖工具/交易面板。
    // 載入 *.min.js（後端 _build_fx_min 壓縮版；來源改動後版號 ?v= 會破快取重抓）。
    ["effects.min.js", "weather.min.js", "draw.min.js", "trade.min.js"].forEach(name => {
      const s = document.createElement("script");
      s.src = "/static/js/" + name + "?v=" + ver;
      s.async = false;
      document.head.appendChild(s);
    });
  };
  "requestIdleCallback" in window
    ? requestIdleCallback(_loadFx, { timeout: 1200 })   // 縮短:天氣背景早點出現(刷新後別空白5秒);仍讓出首屏給圖表
    : setTimeout(_loadFx, 500);
});


/* ── PWA 安裝入口（「在別人電腦/手機弄安裝包」的免安裝包做法）──
   條件(manifest+SW+HTTPS)本來就齊 → 這裡只是把安裝入口做顯眼：
   - 桌面：topbar 下載圖示(#tbInstallBtn)，可安裝時才出現、裝完自動消失
   - 手機：設定分頁「安裝 App」列(#mSetInstall)
   - iOS 沒有 beforeinstallprompt → 顯示「分享→加入主畫面」指引
   已在獨立視窗(standalone)跑＝已安裝 → 兩個入口都不顯示。 */
(function () {
  let _deferred = null;
  const _iOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
               (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const _installed = () =>
    (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  function _show(stateTxt) {
    if (_installed()) return;
    const row = document.getElementById("mSetInstall");
    if (row) {
      row.style.display = "";
      const s = document.getElementById("mSetInstallState");
      if (s && stateTxt) s.textContent = stateTxt;
    }
    const tb = document.getElementById("tbInstallBtn");
    if (tb) tb.style.display = "";
  }
  function _hide() {
    const row = document.getElementById("mSetInstall"); if (row) row.style.display = "none";
    const tb  = document.getElementById("tbInstallBtn"); if (tb) tb.style.display = "none";
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // 攔下瀏覽器自動提示 → 由我們的按鈕觸發
    _deferred = e;
    _show("免下載安裝包");
  });
  window.addEventListener("appinstalled", () => { _deferred = null; _hide(); });
  window._pwaInstall = async function () {
    if (_deferred) {
      _deferred.prompt();
      try {
        const r = await _deferred.userChoice;
        if (r && r.outcome === "accepted") { _hide(); showToast("✅ 已安裝！之後從桌面／主畫面直接開啟", 6000); }
      } catch (e) {}
      _deferred = null;
      return;
    }
    if (_iOS) { showToast("iPhone／iPad：用 Safari 開啟本站 → 點「分享」按鈕 → 「加入主畫面」", 9000); return; }
    showToast("點瀏覽器網址列右側的「安裝」圖示；或瀏覽器選單 → 「安裝應用程式」", 8000);
  };
  // iOS 永遠不發 beforeinstallprompt → 未安裝時直接露出入口（點了給指引）
  if (_iOS && !_installed()) {
    const arm = () => _show("加入主畫面指引");
    (document.readyState === "loading") ? document.addEventListener("DOMContentLoaded", arm) : arm();
  }
})();
