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
  const PUB_ID   = "2026-09-18-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-09-18";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明, 分類標籤(選填)]
  //   分類標籤＝卡片右上角的小晶片：新功能／更快了／修好了／調整（沒寫就不顯示晶片）。
  //   說明的排版：空行分段；行首「・」會自動排成條列（自動縮排對齊，不會在第二行掉回行首）。
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-09-18", "🎨", "上方那行放大了，數值會跟著 K 棒顏色",
     "・**放大**：快捷繪圖的圖示大了約 15%，開高低收那一行跟著加高、字也放大（紅綠的漲跌值維持原本大小）。\n・**顏色**：開高低收與漲跌值改用你自己色盤裡「K 棒邊框」的那組顏色 —— 漲的棒用上漲色、跌的棒用下跌色，十字線移到哪根就跟著哪根。\n・換色盤、或開「上下顛倒」看圖時，這些數值都會跟著一起變，不會出現紅棒配綠字。", "調整"],

    ["2026-09-18", "🎯", "現價線的顏色可以自己挑了",
     "主圖左上角 ⚙（主圖設定）多了一列「**現價線**」：改的是右側那個現價標籤，還有圖上那條現價虛線。\n\n預設跟以前一樣是琥珀色，沒去動的話畫面完全不變；改過之後會記住，也會跟著帳號同步到別台裝置。", "新功能"],

    ["2026-09-18", "🚀", "第一次打開更輕：少傳 38KB、少一個檔案",
     "同樣是第一次打開（還沒有快取）時要下載的量，壓縮後：\n・首頁 33 → **24.3KB**\n・樣式表 44.5 → **32.2KB**\n・主程式 107.5 → **99.8KB**\n・另外少一支 9KB 的檔案請求\n\n做法是把早就沒在用的程式與樣式整批清掉（約 7000 行），送給瀏覽器的網頁也不再夾帶開發用的註解。", "更快了"],

    ["2026-09-18", "🧹", "清掉「看不到卻還在」的東西",
     "・**訊號詳情抽屜**：它的三個入口早就隨勝率欄一起移除了，整支刪掉。\n・**自動交易的 SS 子設定**：SS 訊號來源 8/5 就移除了，這個設定開著也永遠不會下單 —— 留著只會讓人以為它在跑，所以拿掉；FVG 那套完全不受影響。\n・伺服器端也清掉沒人呼叫的端點、以及一個每 20 分鐘跑一次的背景工作。\n・訊號資料裡不再夾帶那包「永遠是 0」的勝率統計。", "調整"],
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
/* 捲動區：上下各留一段漸層淡出，暗示「還有內容」（2026-09-18 排版改版） */
.ann-scroll{position:relative;flex:1;min-height:0;overflow-y:auto;margin:2px -2px 14px;padding:0 2px;
  -webkit-mask-image:linear-gradient(180deg,transparent 0,#000 14px,#000 calc(100% - 14px),transparent 100%);
  mask-image:linear-gradient(180deg,transparent 0,#000 14px,#000 calc(100% - 14px),transparent 100%)}
.ann-scroll::-webkit-scrollbar{width:6px}
.ann-scroll::-webkit-scrollbar-thumb{background:rgba(150,110,60,.35);border-radius:4px}
.ann-list{list-style:none;padding:0;margin:0}
/* 每則＝一張小卡（原本是虛線分隔的長條，長內容會糊成一片文字牆） */
.ann-item{position:relative;margin:0 0 10px;padding:11px 13px 12px 14px;border-radius:14px;
  background:rgba(255,252,240,.62);border:1.5px solid rgba(150,110,55,.26);
  box-shadow:0 2px 6px rgba(140,95,35,.08);animation:annItem .5s ease both}
.ann-item:last-child{margin-bottom:2px}
.ann-item::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;
  background:var(--ann-accent,#d79a4a)}
@keyframes annItem{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ann-item-hd{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.ann-emoji{font-size:17px;line-height:1;flex-shrink:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.8),rgba(255,236,198,.6));
  border:1.5px solid rgba(150,110,55,.3);border-radius:50%;box-shadow:0 2px 5px rgba(140,90,30,.14)}
.ann-name{flex:1;min-width:0;font-size:14.5px;font-weight:800;color:#5f4324;line-height:1.35}
/* 分類晶片：一眼看出這則是新功能還是修好了 */
.ann-tag{flex-shrink:0;align-self:flex-start;margin-top:1px;font-size:10.5px;font-weight:800;letter-spacing:.02em;
  padding:2px 8px;border-radius:999px;color:#fff;background:var(--ann-accent,#d79a4a);
  box-shadow:0 1px 3px rgba(120,75,20,.25)}
.ann-desc{font-size:12.5px;line-height:1.62;color:#7c6142}
.ann-desc p{margin:0 0 7px}
.ann-desc p:last-child{margin-bottom:0}
/* 行首「・」排成真正的條列：折行時對齊，不會掉回行首 */
.ann-bul{list-style:none;margin:0 0 7px;padding:0}
.ann-bul:last-child{margin-bottom:0}
.ann-bul li{position:relative;padding-left:13px;margin:0 0 3px}
.ann-bul li:last-child{margin-bottom:0}
.ann-bul li::before{content:"・";position:absolute;left:-1px;top:0;color:#bf9350}
.ann-desc b{color:#63482a}
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
    //   換行/條列由 _descHtml 排版（見下）。
    const _md = t => String(t)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");   // 不跨行：粗體不該跨段落
    /* 說明排版（2026-09-18）：空行分段；行首「・」的連續幾行併成一個條列。
       原本整段丟進 white-space:pre-line → 長條目糊成一片，條列折行還會掉回行首。 */
    const _descHtml = (desc) => {
      const out = [];
      let bul = null;
      const flush = () => { if (bul) { out.push(`<ul class="ann-bul">${bul.join("")}</ul>`); bul = null; } };
      for (const par of String(desc).split(/\n{2,}/)) {
        for (const line of par.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith("・")) { (bul = bul || []).push(`<li>${_md(t.slice(1).trim())}</li>`); }
          else { flush(); out.push(`<p>${_md(t)}</p>`); }
        }
        flush();
      }
      return out.join("");
    };
    const _TAGC = { "新功能": "#e0872f", "更快了": "#2f9e8f", "修好了": "#6f9e3a", "調整": "#a67c4a" };
    const items = _recentUpdates().map(([date, emo, name, desc, tag], i) => {
      const col = _TAGC[tag] || "#d79a4a";
      return `<li class="ann-item" style="animation-delay:${0.12 + i * 0.06}s;--ann-accent:${col}">` +
      `<div class="ann-item-hd"><span class="ann-emoji">${emo}</span>` +
      `<div class="ann-name">${_md(name)}</div>` +
      (tag ? `<span class="ann-tag">${_md(tag)}</span>` : "") + `</div>` +
      `<div class="ann-desc">${_descHtml(desc)}</div></li>`;
    }).join("");
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新公告">` +
      `<span class="ann-ver">${PUB_DATE.replace(/-/g, ".")}</span>` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="${_v("/static/img/bear.png")}" alt="">` +
      `<div class="ann-head-txt"><div class="ann-title">熊報 · 最新消息</div>` +
      `<div class="ann-sub">小啊幫你整理了 ${_recentUpdates().length} 則更新 🍊</div></div></div>` +
      `<div class="ann-scroll"><ul class="ann-list">${items}</ul></div>` +
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
