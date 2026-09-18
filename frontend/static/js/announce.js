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
/* 歪歪的日期貼紙(草寫)，微微翹出紙緣。2026-09-18 降飽和：原本亮橘貼紙太跳 */
.ann-ver{position:absolute;top:-10px;left:22px;z-index:4;transform:rotate(-4deg);
  font-family:"Caveat",cursive;font-weight:700;font-size:16px;color:#7d5f33;
  background:linear-gradient(180deg,#f6e6c4,#ecd6a8);padding:2px 13px 3px;border-radius:5px;
  border:1px solid rgba(150,110,55,.32);box-shadow:0 2px 7px rgba(120,80,25,.18)}
.ann-close{position:absolute;top:12px;right:13px;width:27px;height:27px;border-radius:50%;
  border:1.5px solid rgba(122,88,46,.35);background:rgba(255,250,236,.65);color:#8a6a3e;font-size:15px;line-height:1;
  cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.18s;-webkit-tap-highlight-color:transparent;z-index:3}
.ann-close:hover{background:#e0c08a;color:#5f4324;border-color:rgba(122,88,46,.5);transform:rotate(90deg)}
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
  background:color-mix(in srgb,var(--ann-accent,#d79a4a) 62%,transparent)}
@keyframes annItem{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ann-item-hd{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.ann-emoji{font-size:17px;line-height:1;flex-shrink:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.8),rgba(255,236,198,.6));
  border:1.5px solid rgba(150,110,55,.3);border-radius:50%;box-shadow:0 2px 5px rgba(140,90,30,.14)}
.ann-name{flex:1;min-width:0;font-size:14.5px;font-weight:800;color:#5f4324;line-height:1.35}
/* 分類晶片。2026-09-18 從「實心亮色＋白字」改成淡底同色字（不搶內容） */
.ann-tag{flex-shrink:0;align-self:flex-start;margin-top:1px;font-size:10.5px;font-weight:800;letter-spacing:.02em;
  padding:2px 8px;border-radius:999px;color:var(--ann-accent,#a67c4a);
  background:color-mix(in srgb,var(--ann-accent,#d79a4a) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--ann-accent,#d79a4a) 34%,transparent)}
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
/* 分頁列（2026-09-18 使用者：「更新資訊設計成可以看快捷鍵設置跟之前的更新資訊」） */
.ann-tabs{display:flex;gap:6px;flex-shrink:0;margin:2px 0 10px;padding:3px;border-radius:12px;
  background:rgba(160,120,60,.13);border:1.5px solid rgba(150,110,55,.2)}
.ann-tab{flex:1;font-family:inherit;font-size:12.5px;font-weight:800;color:#8a6c42;background:transparent;
  border:none;border-radius:9px;padding:7px 0;cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background .16s ease,color .16s ease,box-shadow .16s ease}
.ann-tab:hover{color:#6b4f2a;background:rgba(255,252,240,.5)}
.ann-tab.on{color:#5f4324;background:linear-gradient(180deg,#f2e2c1,#e6d1a5);
  box-shadow:0 2px 6px rgba(150,110,55,.2),0 1px 0 rgba(255,255,255,.55) inset}
/* 快捷鍵表 */
.ann-kbd-hint{font-size:11.5px;color:#9a7c4e;margin:0 2px 9px}
.ann-kbd{display:flex;gap:11px;align-items:baseline;padding:8px 11px;margin-bottom:7px;border-radius:11px;
  background:rgba(255,252,240,.62);border:1.5px solid rgba(150,110,55,.22)}
.ann-kbd-k{flex:0 0 118px;display:flex;flex-wrap:wrap;gap:4px}
.ann-kbd-k span{font-size:11.5px;font-weight:800;color:#5f4324;background:linear-gradient(180deg,#fffaf0,#f0ddb9);
  border:1.5px solid rgba(150,110,55,.38);border-bottom-width:2.5px;border-radius:6px;padding:2px 7px;white-space:nowrap}
.ann-kbd-d{flex:1;min-width:0;font-size:12.5px;line-height:1.55;color:#7c6142}
/* 歷史更新 */
.ann-hist-day{display:flex;align-items:center;gap:8px;margin:4px 0 8px;font-size:12px;font-weight:800;color:#8a6c42}
.ann-hist-day::after{content:"";flex:1;height:1.5px;background:repeating-linear-gradient(90deg,rgba(150,110,55,.3) 0 6px,transparent 6px 11px)}
/* 只列標題、點了才展開（2026-09-18 使用者：「更新紀錄字太多了」） */
.ann-hist-item{margin-bottom:6px;border-radius:11px;background:rgba(255,252,240,.5);
  border:1.5px solid rgba(150,110,55,.2);overflow:hidden}
.ann-hist-t{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;
  font-family:inherit;text-align:left;background:transparent;border:none;cursor:pointer;
  padding:9px 11px;font-size:12.5px;font-weight:800;color:#5f4324;line-height:1.4;
  -webkit-tap-highlight-color:transparent}
.ann-hist-t:hover{background:rgba(255,255,255,.45)}
.ann-hist-tx{flex:1;min-width:0}
.ann-hist-arr{flex-shrink:0;font-size:10px;color:#a8875a;transition:transform .18s ease}
.ann-hist-item.open .ann-hist-arr{transform:rotate(180deg)}
.ann-hist-d{font-size:12px;line-height:1.55;color:#84694a;padding:0 11px 10px}
.ann-hist-d p{margin:0 0 5px}
.ann-hist-d p:last-child{margin-bottom:0}
.ann-hist-sum{font-size:11.5px;color:#9a7c4e;margin:0 2px 9px}
.ann-more{display:block;width:100%;font-family:inherit;font-size:12.5px;font-weight:800;color:#8a6c42;
  background:rgba(255,252,240,.55);border:1.5px dashed rgba(150,110,55,.4);border-radius:12px;
  padding:9px 0;margin:4px 0 2px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:.16s}
.ann-more:hover{background:rgba(242,221,180,.7);color:#6b4f2a;border-style:solid}
.ann-empty{padding:24px 6px;text-align:center;font-size:12.5px;color:#9a7c4e}
.ann-foot{display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-shrink:0;padding-top:4px}
.ann-btn{font-family:inherit;padding:10px 20px;border-radius:13px;font-size:13.5px;font-weight:700;cursor:pointer;
  -webkit-tap-highlight-color:transparent;user-select:none;
  transition:transform .12s ease,box-shadow .2s ease,background .2s ease,border-color .2s ease,color .2s ease}
.ann-btn:active{transform:translateY(1px) scale(.96)}
.ann-btn-ghost{background:transparent;border:1.5px solid rgba(130,95,50,.42);color:#8a6c42}
.ann-btn-ghost:hover{background:rgba(130,95,50,.1);border-color:rgba(130,95,50,.66);color:#6b4f2a}
.ann-btn-primary{border:1.5px solid rgba(160,115,55,.6);color:#4e3a1f;background:linear-gradient(180deg,#eedab3,#e2c692);
  box-shadow:0 3px 10px rgba(150,105,40,.22),0 1px 0 rgba(255,255,255,.5) inset}
.ann-btn-primary:hover{transform:translateY(-1px);background:linear-gradient(180deg,#f3e2c1,#e7cf9f);
  box-shadow:0 5px 14px rgba(150,105,40,.26),0 1px 0 rgba(255,255,255,.5) inset}
.ann-btn-primary:active{transform:translateY(1px) scale(.96);box-shadow:0 2px 7px rgba(150,105,40,.24)}`;
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

  /* HTML 逃脫 + **粗體**（內文一直用 ** 寫，2026-09-05 前是照字面顯示給使用者看的）。 */
  const _md = t => String(t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");   // 不跨行：粗體不該跨段落

  /* 說明排版（2026-09-18）：空行分段；行首「・」的連續幾行併成一個條列。
     原本整段丟進 white-space:pre-line → 長條目糊成一片，條列折行還會掉回行首。 */
  function _descHtml(desc) {
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
  }

  // 低飽和（2026-09-18 使用者：「更新版面設計太鮮艷」）
  const _TAGC = { "新功能": "#bf8340", "更快了": "#4a8a80", "修好了": "#6d8f4b", "調整": "#9b7b52" };
  function _newsHtml() {
    const list = _recentUpdates();
    if (!list.length) return `<div class="ann-empty">目前沒有新消息</div>`;
    return `<ul class="ann-list">` + list.map(([date, emo, name, desc, tag], i) => {
      const col = _TAGC[tag] || "#d79a4a";
      return `<li class="ann-item" style="animation-delay:${0.1 + i * 0.05}s;--ann-accent:${col}">` +
        `<div class="ann-item-hd"><span class="ann-emoji">${emo}</span>` +
        `<div class="ann-name">${_md(name)}</div>` +
        (tag ? `<span class="ann-tag">${_md(tag)}</span>` : "") + `</div>` +
        `<div class="ann-desc">${_descHtml(desc)}</div></li>`;
    }).join("") + `</ul>`;
  }

  /* 快捷鍵：直接用 hotkeys.js 的那份清單（window._HOTKEY_ROWS）→ 只有一份來源，加新鍵不必兩邊改。 */
  function _keysHtml() {
    const rows = (typeof window !== "undefined" && window._HOTKEY_ROWS) || [];
    if (!rows.length) return `<div class="ann-empty">快捷鍵清單還在載入…稍等一下再開這個分頁</div>`;
    return `<div class="ann-kbd-hint">在輸入框打字時快捷鍵不作用；中文輸入法下也能用（認的是實體按鍵位置）。</div>` +
      rows.map(([k, d]) =>
        `<div class="ann-kbd"><div class="ann-kbd-k">` +
        // ⚠ 只用「兩個以上空白／全形空白」切成多顆鍵；不可以用 "/" 切 ——
        //   "/"（開啟搜尋）本身就是一個快捷鍵，切完會變成一顆空白晶片（2026-09-18 踩到）。
        (String(k).split(/\s{2,}|　/).map(x => x.trim()).filter(Boolean).map(x => `<span>${_md(x)}</span>`).join("")
          || `<span>${_md(k)}</span>`) +
        `</div><div class="ann-kbd-d">${_md(d)}</div></div>`).join("");
  }

  /* 歷史更新：90KB 的 docs/announce-history.md 不進 bundle → 點開這個分頁才跟後端要（最近 30 天）。 */
  /* 歸檔時說明被壓成一行（換行換成空白）→ 這裡把「・」還原成條列，讀起來跟最新消息一致。 */
  function _histDesc(d) {
    const parts = String(d).split("・").map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) return `<p>${_md(d)}</p>`;
    const lead = String(d).trim().startsWith("・") ? "" : `<p>${_md(parts.shift())}</p>`;
    return lead + `<ul class="ann-bul">${parts.map(x => `<li>${_md(x)}</li>`).join("")}</ul>`;
  }
  /* 預設只載「近 7 天」（2026-09-18 使用者：「更新紀錄字太多了」→ 除了改成只列標題，
     也不要一次倒 150 則出來）；要看更早的按下面那顆再抓。 */
  const _HIST_FIRST = 7, _HIST_ALL = 120;
  let _histDays = _HIST_FIRST, _histCache = {}, _histLoading = 0;
  function _renderHist(ov, days) {
    const box = ov.querySelector(".ann-scroll");
    if (!box) return;
    days = days || _histDays;
    _histDays = days;
    const cached = _histCache[days];
    if (cached) { box.innerHTML = cached; return; }
    box.innerHTML = `<div class="ann-empty">載入中…</div>`;
    if (_histLoading === days) return;
    _histLoading = days;
    fetch("/api/announce_history?days=" + days, { cache: "no-cache" })
      .then(r => { if (!r.ok) throw new Error("http " + r.status); return r.json(); })   // ⚠ 先看 r.ok：錯誤回應也是 JSON
      .then(j => {
        const secs = (j && j.sections) || [];
        const n = secs.reduce((a, s2) => a + ((s2.items || []).length), 0);
        _histCache[days] = secs.length
          ? `<div class="ann-hist-sum">${days >= _HIST_ALL ? "全部" : "最近 " + days + " 天"}共 ${n} 則 · 點標題看細節</div>` +
            secs.map(sec => `<div class="ann-hist-day">${_md(sec.date)}</div>` +
              (sec.items || []).map(it =>
                `<div class="ann-hist-item">` +
                `<button class="ann-hist-t" type="button">` +
                `<span class="ann-hist-tx">${it.e ? it.e + " " : ""}${_md(it.t)}</span>` +
                (it.d ? `<span class="ann-hist-arr">▼</span>` : "") + `</button>` +
                (it.d ? `<div class="ann-hist-d" hidden>${_histDesc(it.d)}</div>` : "") + `</div>`).join("")).join("") +
            (days < _HIST_ALL ? `<button class="ann-more" type="button" data-days="${_HIST_ALL}">看更早的更新</button>` : "")
          : `<div class="ann-empty">還沒有歷史紀錄</div>`;
      })
      .catch(() => { _histCache[days] = `<div class="ann-empty">拿不到歷史更新（可能離線）；稍後再試。</div>`; })
      .finally(() => {
        _histLoading = 0;
        const cur = document.getElementById("announceOverlay");
        if (cur && cur.dataset.tab === "hist") _renderHist(cur, days);
      });
  }

  const _TABS = [["news", "最新消息"], ["keys", "快捷鍵"], ["hist", "更新紀錄"]];
  function _showTab(ov, tab) {
    ov.dataset.tab = tab;
    ov.querySelectorAll(".ann-tab").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
    const box = ov.querySelector(".ann-scroll");
    if (tab === "hist") { _renderHist(ov); return; }
    box.innerHTML = tab === "keys" ? _keysHtml() : _newsHtml();
    box.scrollTop = 0;
  }

  function _build(opts) {
    _injectStyle();
    const auto = !(opts && opts.manual);            // 自動彈出 vs 使用者自己打開（決定要不要給「不再提醒」）
    const tab = (opts && opts.tab) || "news";
    const ov = document.createElement("div");
    ov.id = "announceOverlay";
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新資訊">` +
      `<span class="ann-ver">${PUB_DATE.replace(/-/g, ".")}</span>` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="${_v("/static/img/bear.png")}" alt="">` +
      `<div class="ann-head-txt"><div class="ann-title">熊報 · 更新資訊</div>` +
      `<div class="ann-sub">小啊幫你整理了 ${_recentUpdates().length} 則更新 🍊</div></div></div>` +
      `<div class="ann-tabs">` + _TABS.map(([id, label]) =>
        `<button class="ann-tab" data-tab="${id}">${label}</button>`).join("") + `</div>` +
      `<div class="ann-scroll"></div>` +
      `<div class="ann-foot">` +
      (auto ? `<button class="ann-btn ann-btn-ghost" id="_annNever">不再提醒</button>` : "") +
      `<button class="ann-btn ann-btn-primary" id="_annLater">${auto ? "我知道了！" : "關閉"}</button></div></div>`;
    document.body.appendChild(ov);
    _showTab(ov, tab);
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });                 // 點背景＝這次先關(下次還會跳)
    ov.querySelectorAll(".ann-tab").forEach(b => b.addEventListener("click", () => _showTab(ov, b.dataset.tab)));
    // 更新紀錄：點標題展開/收合說明（內容是非同步塞進去的 → 用事件委派）
    ov.querySelector(".ann-scroll").addEventListener("click", e => {
      const more = e.target.closest(".ann-more");
      if (more) { _renderHist(ov, +more.dataset.days || _HIST_ALL); return; }
      const t = e.target.closest(".ann-hist-t");
      if (!t) return;
      const box = t.parentElement;
      const d = box.querySelector(".ann-hist-d");
      if (!d) return;
      const open = d.hidden;
      d.hidden = !open;
      box.classList.toggle("open", open);
    });
    ov.querySelector("#_annX").addEventListener("click", close);
    ov.querySelector("#_annLater").addEventListener("click", close);
    const never = ov.querySelector("#_annNever");
    if (never) never.addEventListener("click", () => { _markSeen(); close(); });          // 不再顯示＝此裝置永久關
  }

  /* 隨時打開（設定列的「更新資訊」、按 ? 看快捷鍵都走這支）。已開著就切分頁，不疊第二層。 */
  window._annOpen = function (tab) {
    const cur = document.getElementById("announceOverlay");
    if (cur) { if (cur.dataset.tab === tab) cur.remove(); else _showTab(cur, tab || "news"); return; }
    _build({ manual: true, tab: tab || "news" });
  };

  function _maybeShow(tries) {
    if (_seen()) return;
    if (document.documentElement.classList.contains("landing-active")) {                 // 封面中 → 等進圖表再跳
      if (tries > 0) setTimeout(() => _maybeShow(tries - 1), 1000);
      return;
    }
    if (document.getElementById("announceOverlay")) return;
    _build({});
  }

  function init() { setTimeout(() => _maybeShow(30), 1500); }   // 進站稍等再跳，最多等封面 30 秒
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
