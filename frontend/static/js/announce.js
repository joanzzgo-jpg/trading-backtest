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
  const PUB_ID   = "2026-09-12-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-09-12";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-09-12", "🔃", "主圖可以整張倒過來看——上漲顯示成下跌",
     "新功能：**上下顛倒**。圖例列最右邊、⚙ 旁邊的 **⇅** 按鈕（快捷鍵 Alt/Option + I；手機在「設定」分頁）。\n\n整張主圖翻過來，紅綠也一起對調，所以一段上漲看起來就是一段下跌——用來檢查自己的多空偏見：同一張圖倒過來還想做同一邊，才是真的看到東西。\n\n・價格數字全部是真的（軸只是倒著排），K 棒、布林、FVG、你畫的線都跟著翻。\n・成交量和副圖指標不翻。\n・**不會記住**：重新整理就恢復正常——免得隔天打開忘了它是倒的、把漲跌整個看反。開著時圖表上方會一直掛著橘色的「上下顛倒中」提醒，點一下就恢復。"],

    ["2026-09-12", "🇹🇼", "興櫃的日 K 從 4 根變成完整歷史",
     "你回報「7887 日 K 怪怪的，其他看盤軟體都很多」。確認了：7887 宇川精材是**興櫃**，而興櫃在我們原本的資料來源幾乎沒有歷史，只拿得到最近 4 天——圖幾乎是空的。\n\n改接官方（TPEX）的興櫃歷史行情：**4 根 → 161 根**，從它今年 1/13 上興櫃那天到現在。抽查三天跟官方逐筆核對過，完全一致。\n\n⚠ 有一點要知道：興櫃公開資料**沒有開盤價和收盤價**，只有最高、最低、均價。所以歷史那段的收盤價用的是官方均價（興櫃的漲跌本來就是以前一日均價為基準算的），最近幾天則維持原本有真實開收盤的資料。"],

    ["2026-09-12", "⚡", "手機打開 App 快很多",
     "你說「手機啟動時慢，沒辦法像 app 一樣快」。量出來是三件每次開啟都要重付的成本，都處理掉了：\n\n・**每次開都要等伺服器回應**才畫得出第一個畫面 → 改成先用上次的畫面秒開，新版在背景更新、下次啟動生效。\n・**每次開都要重看城門**：本來就有「一天只看一次」的規則，但記錄存在關掉 App 就會清空的地方，等於從來沒生效過。現在真的是一天一次（未登入仍然會擋在城門）。\n・**每次更新都要重抓整包**：改成每支檔案各自的版號，只有真的改到的檔案要重抓。實測從 23 個檔案降到 1 個。\n\n手機模擬實測：第二次開啟到看見 K 棒 **0.4 秒**。"],

    ["2026-09-12", "🔔", "在圖上點一個價位，碰到就通知你",
     "新功能：**價格提示線**。畫一條水平線、選取它，快捷列會出現鈴鐺，設定好之後價格碰到就推播通知——**關掉網頁也會通知**。\n\n同批修掉三個問題：鬧鐘會跨裝置同步（別台設的不會被這台刪掉）、觸發後會留下紀錄、以及「在別的標的畫線會把這一檔的鬧鐘清光」的競態。"],

    ["2026-09-12", "🇹🇼", "台股的假崩盤修掉了",
     "股票分割或減資之後，歷史價格如果沒有跟著換算，圖上就會出現一段**根本沒發生過的崩盤**——例如 6949 沛爾生醫看起來像 −94.5%。\n\n現在會自動還原，而且不依賴會漏的來源：先用官方公告的係數，沒有登記才從資料本身推算。順帶修掉 Yahoo 把現金增資誤記成分割留下的假斷崖。"],

    ["2026-09-12", "🩹", "順手修好的幾個小地方",
     "・**外匯**：訊號和勝率以前一律顯示「訊號計算失敗」——其實是每次載入都撞到錯誤，現在正常了。\n・**即時 K 棒偶爾停住、要重新整理才好**：伺服器因為資料裡的一個空值整支出錯，畫面上完全看不出來。已經修掉，並且改成從源頭就擋。\n・**小啊**不再自己跳出來打斷看盤，改成滑鼠移過去才出現、移開立刻收回。\n・鈴鐺和經濟事件倒數該收起來的時候會真的收起來了。"],
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
