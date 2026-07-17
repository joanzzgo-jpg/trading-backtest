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
  const PUB_ID   = "2026-07-17-2";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-17";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-07-17", "🧱", "新指標：掛單牆（即時盤口 + 假單判定）", "主圖右上角新增「🧱 掛單牆」按鈕（預設關）：把即時盤口的大掛單畫在主圖右緣——綠條=買方支撐牆、紅條=賣方壓力牆，長度代表掛單金額。當一道牆消失時自動判定並標記：「✓ 吃掉」（行情真的掃到那個價位、牆才消失＝真金白銀的防守）或「⚠ 撤走」（行情根本沒碰到、牆卻不見了＝疑似假單/spoof）——這是唯一能確認「市價單吃穿假單」的即時證據。左上並顯示「掛單買賣比」。僅加密貨幣即時盤口（掛單簿無歷史）。"],
    ["2026-07-17", "⚖️", "足跡圖新增「失衡標示」", "足跡圖不再只標成交量最大的價位（金框 POC）：現在會自動高亮「市價單壓倒性打贏」的格子——某價位的主動買量 ≥ 主動賣量 2 倍（或反之）就亮框實心（買失衡=亮綠、賣失衡=亮紅）。一眼看出每根 K 棒裡是誰在哪個價位強勢吃單，配合掛單牆一起看更能抓到「市價吃穿掛單」的位置。"],
    ["2026-07-17", "👣", "新指標：Footprint 足跡圖（含歷史）", "主圖右上角新增「👣 足跡」按鈕（限價單旁，預設關）：顯示每根 K 棒內各價位的主動買/賣量分布——左紅=主動賣、右綠=主動買（深淺=量佔比）、金框=POC 最大量價位、棒底 Δ=買賣差與總量。近端 K 棒（1 分～1 小時）用逐筆成交精確計算（首次開啟會漸進補齊、右上角顯示進度；跨時框共用快取，看過 15m 再切 1h 更快）；更早的歷史與 4h／1d 用細 K 線聚合補到數百根（1m/5m/15m 細棒，買賣量為交易所實數）——15m 約 3.5 天、1h 10 天、4h 40 天、1d 8 個月，算一次就快取。僅加密貨幣；K 棒間距要放大才會顯示，拉得夠寬會出現每格數字。"],
    ["2026-07-16", "🛡️", "穩定性總檢修（五輪自動化獵蟲）", "對整站跑了五輪自動化測試（約 90 個檢查點：時框循環、連續快切、極端縮放、重整還原、手機觸控、重播、繪圖、多圖分割、斷網復網、毒存檔自癒、注入攻擊、並發轟炸、3 分鐘浸泡…），修掉三處：① 行情 API 被傳負數量時會回整段歷史（約 8 萬根 K 的巨量回應）→ 已加防護；② 未登入時進「訊號」分頁會白打一次注定失敗的請求 → 已免除；③ 打錯標的代號或斷網載入失敗時，內部會多冒一顆未處理的錯誤雜訊 → 已清除。其餘檢查全數通過——包含確認「舊版殘留的壞視角存檔」重新整理即自動復原。"],
    ["2026-07-16", "🖼️", "修正：切標的/時框後畫面跑到沒 K 棒的地方", "修正「切換標的或時框後，主圖切到最右邊一片空白、K 棒全擠到最左看不見」：內部有個縮放還原與圖表引擎延遲重排的競態——先捲到歷史再切換時，還原的視角會被晚一步執行的自動縮放踩爛，且爛掉的位置還會被記住、之後每次切換都複發。已從根源修掉（有還原目標時不再觸發自動縮放＋還原後加防踩保護），已經中招的裝置切一次標的即自動復原。五種情境（看最新/捲歷史/拖進右側空白 × 切時框/切標的）全數實測通過。"],
    ["2026-07-16", "📡", "雷達偵測：雨雲在你正上方（含到達倒數）", "「即將降雨預警」再加一層雷達，抓「雨直接在你頭頂生成」的情境——周圍雨量站全乾、雨卻馬上落下。三個重點：① 台灣接的是**氣象署官方雷達合成圖**（你座標正上方約 1 公里精度），比第三方雷達源在台灣準確得多；② 預警經過全台 1327 個雨量站實測校準——回波強度、近地濕度、周邊降雨三重確認才發「雨很快落下」（量測準確率約 85%），條件不足只給軟性「雨雲醞釀中」提醒，不會狼來了；③ 新增**雷達移動倒數**：用前後兩幀雷達算雨帶移動方向與速度，直接外推「雨的前緣約 X 分鐘後到你上空」，比用地面雨量站推算更早、更準。"],
    ["2026-07-16", "🌦️", "新功能：即將降雨預警", "附近雨區偵測新增「即將降雨」判斷：你這還沒下、雨帶也還沒有明確朝你移動，但 10 公里內的對流「正在長」——雨勢增強中、新雨胞剛冒出、或周邊多點同時開下（大雨／豪雨胞範圍大、放寬到 15 公里）→ 天氣卡與小啊會提前提醒「你這區可能快下了，出門帶傘」。台灣午後雷陣雨常「就地擴散」而不是平移過來，這正是原本移動推算抓不到的空窗。"],
    ["2026-07-16", "🌧️", "天氣卡漏報下雨修正", "修正「人在外面淋雨、天氣卡卻顯示陰／多雲」：氣象站常不提供天氣文字，系統改用雲量推斷時永遠推不出「雨」→ 正在下雨也顯示陰。現在會同時參考你 5 公里內最近的自動雨量站（全台 1310 站、十分鐘雨量停雨即歸零，判「現在正在下」最準）：測到正在下就強制轉為雨——毛毛雨／小雨／中雨／大雨分級顯示、背景動畫同步下雨；氣象署官方描述本來就有雨時仍以官方為準。另外剛開始下雨時不再等快取過期——偵測到立刻更新，反映時間從最壞約 15~25 分縮到約 2~10 分（受氣象署雨量資料 10 分鐘更新頻率限制）。"],
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
