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
  const PUB_ID   = "2026-09-05-2";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-09-05";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-09-05", "🧹", "擺動點和吞噬掃蕩拿掉了，那排圖例順便瘦身",
     "你要求刪掉這兩個標記，已經**完整移除**（不是藏起來）：圖層、開關、狀態列標記、圖例項全部清掉，程式少了 151 行。\n\n順便量了一下那排圖例（BB / VOL / FVG …）：少兩項之後，**1280 和 1200 像素寬的螢幕從「要橫向捲才看得完」變成一次全放得下**。\n\n量的過程還找到真正的空間大戶：**BB 那一項自己就佔了整排的 22%**，因為它常駐顯示三個價格。現在你把 BB 關掉時就只留「BB」兩個字——那三條線都不畫了，三個數字也沒有意義。1024 像素的螢幕因此剛好也放得下整排。開回來數值立刻回來。"],

    ["2026-09-05", "🔍", "經濟事件在縮放圖表時會消失，停下來才出現",
     "你回報的。原因是程式在你平移或縮放時會把經濟事件**整批跳過不畫**，停手才補回來，當初寫的理由是「垂直全高虛線最貴」。\n\n我實際量了一下：典型畫面只有 **4 條線**，每一幀花 **0.011 毫秒——是 60fps 預算的 0.1%**。就算把所有已發生的事件全部畫出來也只有 0.09 毫秒。\n\n也就是說，它在保護一個**不存在的成本**，代價卻是你每次動圖表它就不見。拿掉了，現在縮放全程都看得到。"],

    ["2026-09-05", "🎯", "改過的指標顏色，重整後圖例那顆點會忘記",
     "你回報 RSI 的標記點顏色有問題。查下去發現**不只 RSI**：你在設定裡改任何指標的顏色（BB／KDJ／RSI／MACD 共 12 個），**線會記住，但圖例文字前面那顆小方塊重整後會跳回預設色**。\n\n因為同步那顆點的程式只在「你當下改色」的瞬間跑，開機時從來沒跑過。所以重整之後你會看到線是綠的、點卻還是原本的紫色——而且完全不報錯，那顆點只是在說謊。\n\n修好了，文字顏色也一起跟上（不然會變成點是新色、字是舊色）。"],

    ["2026-09-05", "🔴", "有一顆圖例的點，顏色是假的",
     "順著上面那件事，把 11 顆圖例點全部對照圖上真正畫出來的顏色核了一遍，抓到一顆：\n\n**「關鍵高低」**那顆點寫的是 #ef5350，但圖上「前日高」實際畫的是 **#ff5252**——是另一種紅。改正了。\n\n另外把「用 1 像素邊框偷偷帶第二個顏色」的舊做法拿掉：9 像素的小方塊上那圈邊框根本看不出來，卻讓「關鍵高低」和「可見高低」兩顆點長得**一模一樣**。現在 11 顆點沒有任何兩顆完全撞色。\n\n（中間我試過把多色圖層做成分色點，你說太醜，已經改回單色。）"],
    ["2026-09-05", "📅", "最新那根 K 棒上掛著的三個經濟事件，是錯的",
     "開著「經濟事件」時，主圖**最新那根 K 棒**上會同時出現 NFP、CPI、FOMC 三個標籤。那不是「這根 K 棒同時發生三件事」——是**所有還沒發生的事件**（目前 18 個）全部被擠到那一根上面。\n\n程式在放標記時找的是「事件時刻所在的那根 K 棒」，但對**還沒發生**的事件來說，這個答案永遠是最後一根。所以那三個標籤畫在那裡，跟它們真正的日期毫無關係——而畫面上完全看不出來，K 棒就是 K 棒，不會標示「這件事還沒發生」。\n\n現在還沒發生的事件不畫在圖上了。已經發生的照舊。"],

    ["2026-09-05", "⏱", "距離下一個經濟事件還有多久，現在看得到了",
     "還沒發生的事件不畫在圖上，但你還是需要知道它快到了——所以改用文字告訴你。\n\n開高低收量右邊、快捷繪圖工具旁多了一欄：**「● CPI 6天5小時後」**，永遠顯示最近的那一場，兩天內會特別標出來。\n\n**點一下會展開**，同時看到 NFP、CPI、FOMC 各自的下一場、確切時間、還有多久：\n\n・CPI　09/11 20:30　6天5小時後\n・FOMC　09/17 02:00　11天11小時後\n・非農　10/02 20:30　27天5小時後\n\n再點一下、點旁邊、或按 Esc 都可以收起來。時間都是台灣時間。"],

    ["2026-09-05", "🎨", "格線顏色可以自己挑了",
     "以前主圖的格線色**只有「自動」一條路**：程式看你的背景是亮是暗，自動給深色或淺色格線，你沒得選。\n\n現在主圖設定（⚙）多了「格線」一列，旁邊一顆「自動」開關加一個色塊。挑了顏色就會自動關掉「自動」——不然你挑半天畫面沒反應。想回去按一下「自動」就好。自動開著的時候色塊會淡掉，表示那個顏色現在沒在用。\n\n四張圖（主圖＋KDJ／RSI／MACD）會一起換，透明度也可以調，選好跨重整、跨裝置都記得。\n\n極簡模式維持自動——那是暫時套上的純白配色，用你為暗底挑的深色格線會很突兀。"],

    ["2026-09-05", "🇹🇼", "台股自選終於有中文名稱",
     "自選清單裡的台股只看得到數字編號（2330、2426），底下那行寫的是「TW」——完全看不出是哪一家公司。\n\n現在會顯示中文名：**2330 台積電**、**2426 鼎元**、**TXF 台指期(大台)**。\n\n名稱其實一直都在（台股分頁本來就在顯示），只有自選那份漏了接上去。順帶修掉一個會讓它時好時壞的問題：台股清單常常比自選列晚到，原本只在第一次畫的時候寫一次名稱，晚到就永遠補不上了。"],

    ["2026-09-05", "⚠", "「取不到資料」不會再假裝成一個答案",
     "網頁跟伺服器要資料時，如果伺服器回的是錯誤，那個錯誤訊息**本身也是一份格式合法的資料**。程式沒特別檢查的話，就會把它當成正常答案往下用——結果是每個欄位都空的，但畫面上看起來像一個很有自信的結論。\n\n全站掃過一遍，修了 8 處。你可能遇過的：\n\n・**天氣**取不到時，整份資料（溫度、地名、降雨機率、預報）會被清空，背景直接變**晴天**，而且還標記成「剛更新」。現在取不到就留著上一份，絕不假裝晴天。\n・**颱風**資訊取不到時，警報會安靜消失，跟「沒有颱風」分不出來。\n・**經濟事件**取不到時**永遠不會再試**——連把圖層關掉再開都救不回來，只能整頁重新整理。\n・**止損求解**失敗時顯示「—」，跟「算不出結果」長得一模一樣。\n\n這類壞法最麻煩的地方是它不報錯、畫面也正常，只是答案是編的。"],
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
/* white-space:pre-line → 條目說明裡的 \n\n 才會真的換段落。
   沒有它的話 innerHTML 會把換行摺成空白，長條目變成一整片文字牆（2026-08-07 發現）。 */
.ann-desc{font-size:12.5px;line-height:1.6;color:#7c6142;white-space:pre-line}
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
    // ⚠ 內文一直是用 **粗體** 這種標記寫的，但這裡是直接塞 innerHTML、從來沒做轉換
    //   → 星號**照字面顯示**給使用者看（既有公告全都是這樣，2026-09-05 才發現）。
    //   先逃脫 HTML 特殊字元（內容是我們自己寫的，但別留下注入的形狀），再轉粗體。
    //   換行不用處理：.ann-desc 是 white-space:pre-line。
    const _md = t => String(t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");   // 不跨行：粗體不該跨段落
    const items = _recentUpdates().map(([date, emo, name, desc], i) =>
      `<li class="ann-item" style="animation-delay:${0.12 + i * 0.06}s">` +
      `<span class="ann-emoji">${emo}</span>` +
      `<div class="ann-item-body"><div class="ann-name">${_md(name)}</div><div class="ann-desc">${_md(desc)}</div></div></li>`
    ).join("");
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新公告">` +
      `<span class="ann-ver">${PUB_DATE.replace(/-/g, ".")}</span>` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="${_v("/static/img/bear.png")}" alt="">` +
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
