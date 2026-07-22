// 「更新公告」彈窗：進到圖表後彈一次，條列近期更新；按「不再顯示」→ 該裝置永久關閉。
//   - 桌面與手機都會顯示（卡片 width:min(470px,93vw) 響應式、清單可捲動，手機不爆版）。
//   - 封面/城門頁顯示中先不跳（避免與封面重疊）。
//
// ── 發布流程（重要）──────────────────────────────────────────────
//   平時：有新更新就「累積」寫進 UPDATES（每條**帶當天日期**），但 **不要動 PUB_ID**
//         → 已看過的人不會被重複打擾。彈窗**顯示近 48 小時（PUB_DATE 前 48h＝今天＋昨天）**的項目（更舊留作歷史、不顯示）。
//   發布：使用者說「發公告」時，才：① 把當天新增項目標上今天日期 ② 設 PUB_DATE＝今天
//         ③ 把 PUB_ID 換成新值 → 所有裝置版本不符 → 全部重跳，且只看到「近兩天」這批更新。
//   （PUB_ID 是內部版本鍵、只管「要不要重跳」；PUB_DATE 同時是卡片顯示日期＋「近 48h」過濾錨點。）
(function () {
  const PUB_ID   = "2026-07-23-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-23";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-07-23", "⚡", "切換時框更快（BTC/ETH/XAUT 秒切）＋ 深歷史全用戶共用", "切換時框大幅加速：①瀏覽器背景預抓——看 BTC／ETH／XAUT 時，閒置時會偷偷把其他常用時框（日線／4h／2h／1h／30m／15m／5m）的資料先備好，切過去幾乎瞬間（接近 TradingView 的體感）；②伺服器端歷史庫擴充——BTC／ETH／SOL／XAUT 的日線／4h／5m 深歷史存在伺服器、所有用戶共用，切這些時框直接秒回、不用各自去打交易所（更快也更穩，日線深到 2015、4h 到 2016）。"],
    ["2026-07-23", "📏", "新繪圖工具：測量 ＋ 矩形中線", "繪圖工具升級：①新增「測量」工具（工具列，尺規圖示）——點兩點拉一段，綠框（漲）／紅框（跌）即時顯示漲跌幅 %、價差點數、K 棒根數、時間長度，跟 TradingView 一樣；②矩形框新增「中線」——畫方框時垂直中點自動畫一條水平虛線，一眼看出方框的中間價位。"],
    ["2026-07-23", "📈", "新增「線型圖」切換（收盤折線）", "頂部時框列新增「📈 線型 ／ 🕯️ K線」按鈕：一鍵切換 K 線圖 ↔ 收盤價折線圖，會記住你的偏好。策略標記（多空／破多空）、FVG 缺口、BB、成交量等照樣顯示。"],
    ["2026-07-23", "🧱", "FVG 缺口盒多項優化", "FVG 缺口盒優化：①沒被「完全填補」的老缺口會一路延伸到現在（帶狀，看它有沒有被回補）；②形成點被捲出畫面左邊時，整條缺口帶仍畫得出來、往近期延伸；③自動修復「最近 K 棒沒有 FVG」——內部資料落後時會自動重算補上（不再卡住）；④拿掉虛線邊框、寬度 % 數字、突破雜點，畫面更乾淨；⑤週線（1w）不再顯示 FVG。"],
    ["2026-07-23", "🗂️", "下載歷史 K 線（離線回測用）", "新增歷史 K 線下載：瀏覽器開 /api/export_klines?symbol=BTC/USDT&timeframe=1d 就會把完整歷史下載成 CSV 檔到電腦（time,open,high,low,close,volume），給你離線跑自己的回測程式用、不必一直連線打 API。標的換 BTC/USDT、ETH/USDT…，時框換 1m～1M 皆可；Railway 線上版也能用。"],
    ["2026-07-23", "🎛️", "副圖一鍵完全隱藏 ＋ 移除 8h ＋ 修正切時框紅字", "①副圖指標（KDJ／RSI／MACD）收合改成「完全消失、不留資訊列與框線」，下方會出現小晶片一鍵叫回；②移除少用的 8h 時框；③修正「快速切換時框偶爾跳紅色錯誤」——那其實是正常取消上一個請求被誤報成錯誤，已靜默處理（真正的錯誤照常提示）。"],
    ["2026-07-22", "🎯", "新功能：關鍵高低（前日／亞洲／歐洲高低一鍵）", "圖例把「前日高低」升級成「關鍵高低」一顆開關，一次畫出三組主力盯著的流動性價位：①前日高低（紅／綠虛線，每個日段畫前一交易日的日內高／低）；②亞洲盤高低（藍色「亞高／亞低」）；③歐洲盤高低（紫色「歐高／歐低」）。亞／歐盤的高低會延伸到下一個同盤，讓你一眼看出歐美盤有沒有回來獵取亞洲／歐洲的高低流動性（掃流動性正是進場關鍵）。亞／歐限加密貨幣的日內細時框（5m～2h）；前日高低所有市場都畫。"],
    ["2026-07-22", "⚡", "切時框改「保持縮放」瞬間切換（像 TradingView）", "修正「切換時框有滑動、不是馬上切到」的感覺：以前大時框切小時框（例如日線切 5m）會硬要保持同一段時間長度，換算成小時框的根數暴增、把 K 棒擠扁、看起來像縮小滑過去。現在改成跟 TradingView 一樣——切完 K 棒大小不變、貼齊最新、顯示差不多同樣根數，一次到位、不縮放不爆量。"],
    ["2026-07-22", "🧊", "最近 K 棒即時補上 FVG ＋ 整體配色收斂", "①修正「看盤看久了、最近幾根 K 棒都沒有 FVG 缺口盒」：即時報價每秒只更新 K 棒、不會重算，FVG 會凍結在上次計算的時間 → 現在新棒收盤時自動重抓，FVG 缺口盒延伸到最新棒。②整體配色收斂、降低眼花：FVG 缺口盒的填色／邊框／標籤調淡、交易時段的大色塊與 killzone 底色透明度下修 → 圖面更乾淨、關鍵標記更突出。"],
    ["2026-07-22", "🧱", "大時框 FVG 缺口盒可往回看更多（日線／8h／2h／30m）", "修正「日線、8h、2h、30m 這些大時框，往回拖看不到比較久以前的 FVG 缺口方框」：這些時框以前只載入最近約 500 根 K 棒就停住（日線只看得到約 1.4 年），再舊的區段連 K 棒都沒有、FVG 缺口盒自然也不顯示。現在改成跟 1h／4h 一樣——往左拖曳就會在背景繼續補載更早的 K 棒，FVG 缺口盒一路往回長出來（日線可拖到約 11 年、8h 約 10 年、2h 約 5 年、30m 約 2 年）。不是一次全部鋪滿（那樣載入太重、平移會卡），而是拖到哪、補到哪，跟 1h／4h 體驗一致。僅加密貨幣。"],
  ];

  function _seen()     { try { return localStorage.getItem(KEY) === PUB_ID; } catch (e) { return false; } }
  function _markSeen() { try { localStorage.setItem(KEY, PUB_ID); } catch (e) {} }

  function _injectStyle() {
    if (document.getElementById("announceStyle")) return;
    const st = document.createElement("style");
    st.id = "announceStyle";
    st.textContent = `
/* 城堡羊皮紙佈告：暖米紙+紙紋+手繪虛線內框，配合封面城堡繪本風(非冷藍玻璃卡) */
#announceOverlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  padding:22px;background:radial-gradient(130% 110% at 50% 24%,rgba(52,32,12,.5),rgba(16,10,4,.74));
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);animation:annFade .3s ease both}
@keyframes annFade{from{opacity:0}to{opacity:1}}
.ann-card{position:relative;width:min(440px,92vw);max-height:88vh;display:flex;flex-direction:column;
  padding:24px 22px 20px;font-family:"M PLUS Rounded 1c",-apple-system,"PingFang TC",system-ui,sans-serif;color:#5c4526;
  background:radial-gradient(100% 55% at 28% 4%,rgba(255,251,238,.9),transparent 55%),
    linear-gradient(176deg,#f8ecd3,#f0ddb5 58%,#e6cd97);
  border:2px solid #caa876;border-radius:20px 15px 22px 16px/16px 21px 15px 20px;
  box-shadow:0 26px 66px rgba(34,18,4,.52),0 2px 0 rgba(255,255,255,.45) inset;
  animation:annPop .5s cubic-bezier(.22,1.16,.36,1) both}
@keyframes annPop{from{opacity:0;transform:translateY(18px) scale(.94) rotate(-.6deg)}to{opacity:1;transform:none}}
/* 紙紋(SVG 雜訊·multiply 淡疊) */
.ann-card::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:.05;mix-blend-mode:multiply;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23n)'/%3E%3C/svg%3E");background-size:150px}
/* 手繪虛線內框 */
.ann-card::after{content:"";position:absolute;inset:7px;border-radius:15px 11px 16px 12px/12px 15px 11px 15px;
  pointer-events:none;border:1.5px dashed rgba(122,88,46,.4)}
/* 歪歪的日期貼紙(草寫)，微微翹出紙緣 */
.ann-ver{position:absolute;top:-10px;left:22px;z-index:4;transform:rotate(-4deg);
  font-family:"Caveat",cursive;font-weight:700;font-size:16px;color:#7a4d1a;
  background:linear-gradient(180deg,#ffe7b1,#f6c878);padding:2px 13px 3px;border-radius:5px;
  border:1px solid rgba(150,100,30,.4);box-shadow:0 3px 9px rgba(120,70,10,.3)}
.ann-close{position:absolute;top:12px;right:13px;width:27px;height:27px;border-radius:50%;
  border:1.5px solid rgba(122,88,46,.35);background:rgba(255,250,236,.65);color:#8a6a3e;font-size:15px;line-height:1;
  cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.18s;-webkit-tap-highlight-color:transparent;z-index:3}
.ann-close:hover{background:#e8a24d;color:#fff;border-color:#c47f2c;transform:rotate(90deg)}
.ann-close:active{transform:rotate(90deg) scale(.88)}
.ann-head{display:flex;align-items:center;gap:13px;margin:8px 0 14px;flex-shrink:0}
.ann-bear{width:46px;height:46px;border-radius:50%;object-fit:cover;padding:3px;flex-shrink:0;transform:rotate(-4deg);
  background:radial-gradient(circle at 32% 28%,#ffce8a,#f39a3d);
  box-shadow:0 4px 12px rgba(210,120,40,.4),0 0 0 2px rgba(255,255,255,.55)}
.ann-head-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.ann-title{font-size:19px;font-weight:900;color:#6b4d27;letter-spacing:.02em;text-shadow:0 1px 0 rgba(255,252,244,.6)}
.ann-sub{font-size:12px;font-weight:500;color:#9a7c4e}
.ann-list{list-style:none;padding:0;margin:2px 0 15px;overflow-y:auto;flex:1;min-height:0}
.ann-list::-webkit-scrollbar{width:6px}
.ann-list::-webkit-scrollbar-thumb{background:rgba(150,110,60,.35);border-radius:4px}
.ann-item{display:flex;gap:12px;align-items:flex-start;padding:12px 6px 13px;
  border-bottom:1.5px dashed rgba(140,105,60,.32);animation:annItem .5s ease both}
.ann-item:last-child{border-bottom:none}
@keyframes annItem{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:none}}
.ann-emoji{font-size:21px;line-height:1;flex-shrink:0;width:38px;height:38px;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.75),rgba(255,236,198,.55));
  border:1.5px solid rgba(150,110,55,.32);border-radius:50%;box-shadow:0 2px 5px rgba(140,90,30,.16)}
.ann-item-body{flex:1;min-width:0}
.ann-name{font-size:14.5px;font-weight:800;color:#5f4324;margin-bottom:3px}
.ann-desc{font-size:12.5px;line-height:1.6;color:#7c6142}
.ann-foot{display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-shrink:0;padding-top:4px}
.ann-btn{font-family:inherit;padding:10px 20px;border-radius:13px;font-size:13.5px;font-weight:700;cursor:pointer;
  -webkit-tap-highlight-color:transparent;user-select:none;
  transition:transform .12s ease,box-shadow .2s ease,background .2s ease,border-color .2s ease,color .2s ease}
.ann-btn:active{transform:translateY(1px) scale(.96)}
.ann-btn-ghost{background:transparent;border:1.5px solid rgba(130,95,50,.42);color:#8a6c42}
.ann-btn-ghost:hover{background:rgba(130,95,50,.1);border-color:rgba(130,95,50,.66);color:#6b4f2a}
.ann-btn-primary{border:1.5px solid #c47f2c;color:#fff;background:linear-gradient(180deg,#f2ab52,#e0872f);
  box-shadow:0 5px 14px rgba(200,115,35,.4),0 1px 0 rgba(255,255,255,.4) inset}
.ann-btn-primary:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(200,115,35,.5),0 1px 0 rgba(255,255,255,.4) inset}
.ann-btn-primary:active{transform:translateY(1px) scale(.96);box-shadow:0 3px 10px rgba(200,115,35,.42)}`;
    document.head.appendChild(st);
  }

  // 取「近 48 小時」項目＝日期在 PUB_DATE 前 48 小時內（＝今天＋昨天）。
  //   以 PUB_DATE 為錨（發布快照，之後幾天再開仍顯示同一批，不會隨真實時間縮成空白）。
  //   若都沒有（例如忘了標日期）→ 退回顯示「最新一天」，避免彈出空白公告。
  const _WINDOW_H = 48;
  function _recentUpdates() {
    const pub = Date.parse(PUB_DATE + "T00:00:00");
    let list = UPDATES.filter(u => {
      const d = Date.parse(u[0] + "T00:00:00");
      return !isNaN(d) && d <= pub && (pub - d) < _WINDOW_H * 3600 * 1000;   // 0h(今)、24h(昨)保留；48h(前天)起排除
    });
    if (!list.length && UPDATES.length) {
      const latest = UPDATES.reduce((m, u) => (u[0] > m ? u[0] : m), UPDATES[0][0]);
      list = UPDATES.filter(u => u[0] === latest);
    }
    return list;
  }

  function _build() {
    _injectStyle();
    const ov = document.createElement("div");
    ov.id = "announceOverlay";
    const items = _recentUpdates().map(([date, emo, name, desc], i) =>
      `<li class="ann-item" style="animation-delay:${0.12 + i * 0.06}s">` +
      `<span class="ann-emoji">${emo}</span>` +
      `<div class="ann-item-body"><div class="ann-name">${name}</div><div class="ann-desc">${desc}</div></div></li>`
    ).join("");
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新公告">` +
      `<span class="ann-ver">${PUB_DATE.replace(/-/g, ".")}</span>` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="/static/img/bear.png" alt="">` +
      `<div class="ann-head-txt"><div class="ann-title">熊報 · 最新消息</div>` +
      `<div class="ann-sub">小啊幫你整理了近兩天的更新 🍊</div></div></div>` +
      `<ul class="ann-list">${items}</ul>` +
      `<div class="ann-foot">` +
      `<button class="ann-btn ann-btn-ghost" id="_annNever">不再提醒</button>` +
      `<button class="ann-btn ann-btn-primary" id="_annLater">我知道了！</button></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });                 // 點背景＝這次先關(下次還會跳)
    ov.querySelector("#_annX").addEventListener("click", close);
    ov.querySelector("#_annLater").addEventListener("click", close);                      // 知道了＝這次先關
    ov.querySelector("#_annNever").addEventListener("click", () => { _markSeen(); close(); });  // 不再顯示＝此裝置永久關
  }

  function _maybeShow(tries) {
    if (_seen()) return;
    if (document.documentElement.classList.contains("landing-active")) {                 // 封面中 → 等進圖表再跳
      if (tries > 0) setTimeout(() => _maybeShow(tries - 1), 1000);
      return;
    }
    if (document.getElementById("announceOverlay")) return;
    _build();
  }

  function init() { setTimeout(() => _maybeShow(30), 1500); }   // 進站稍等再跳，最多等封面 30 秒
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
