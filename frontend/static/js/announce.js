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
  const PUB_ID   = "2026-09-24-4";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-09-24";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明, 分類標籤(選填)]
  //   分類標籤＝卡片右上角的小晶片：新功能／更快了／修好了／調整（沒寫就不顯示晶片）。
  //   說明的排版：空行分段；行首「・」會自動排成條列（自動縮排對齊，不會在第二行掉回行首）。
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-09-25", "🖼", "主圖多了一圈線框，跟主背景的交界不再是「糊在一起」",
     "主圖與周圍的主背景以前是**直接相接、沒有形狀** —— 兩側底色只差幾個色階，分界感其實來自「圖表 vs 列表」內容不同，看起來就鬆散。\n\n・現在主圖右上角是一道**流線型的圓角細線**（暖色、只有上緣與右緣：左下貼著螢幕邊，沒有對象可分隔）。\n・上緣往下讓了一點，跟上方的標的列之間留出呼吸空間。\n・圓角外那一小塊缺角，以前露出的是沒被任何面板蓋過的天氣層，**比旁邊的合約行情亮一截**（實測差 22 個色階），看起來像主圖的延伸；現在跟主背景同一個值，逐點完全相同。\n・手機版不畫（那裡沒有需要分隔的對象）。", "調整"],

    ["2026-09-25", "💹", "合約行情：切走再切回來，價格會先跳回舊值",
     "點開另一檔再切回來，那一列的價格會**先跳回幾十秒前的數字、下一拍才彈回來**。\n\n・根因是切回同一檔時圖表資料吃到快取，而那批的最後一根是**形成中的 K 棒** —— 它的收盤是當初抓的（實測 BTC 上差到 **76 點**）。前端卻無條件把它當成「現價」寫進那一列。\n・現在只有**確定是剛抓的**資料才會被當成現價；不新鮮就用那一列自己的即時報價（每秒更新，不可能往回走）。\n・原本用來擋這件事的檢查看的是「這根 K 棒是幾點的」，而不是「這批資料是幾點抓的」—— 兩者是不同的事。", "修好了"],

    ["2026-09-25", "⚡", "切標的之後，價格更新快了 5 倍",
     "切到另一檔之後，主圖的現價線與最新那根 K 棒要等**滿一個輪詢週期**才會校正 —— 加密是 1 秒、台股/美股是 5 秒，那段時間拿的是載入時那批資料的值。\n\n・現在一開始輪詢就先問一次：實測**1132 毫秒 → 201 毫秒**，台股/美股從 5 秒縮到 0.2 秒。", "更快了"],

    ["2026-09-24", "📅", "右邊還沒出現 K 棒的地方，格線跟日期先畫好了",
     "以前**最後一根 K 棒之後那片留白是全空的** —— 沒有格線、沒有日期，看起來像圖被切掉一半。\n\n・現在時間軸會**往未來延伸 300 根**，背景格線、週框、日期刻度都照常畫到最右邊。\n・未來那段的週框沿用 K 棒區同一套（每週一～週五一格）→ **間距完全一致**，不會前面密、後面疏。\n・**縮到很小也夠用**：留白是以「根」算的，縮小時同樣寬度要更多根去填 —— 延伸長度會跟著你的縮放自動增加，不會縮一縮後面又空掉。", "更新"],

    ["2026-09-24", "🐻", "AHH 浮水印移到左下角",
     "左上角的 logo 改成**左下角的浮水印**，墊在圖層下面、不擋 K 棒，位置也抬高到不會蓋住下方的日期。\n\n・副圖全部收起來、或只單獨開其中一個，浮水印都固定在同一個位置。", "調整"],

    ["2026-09-24", "🎨", "主背景調透明會變白、而且重整後又不一樣",
     "把系統外觀的**主背景**不透明度調低，畫面會整片變白；就算調好了，**重新整理後又變回另一個樣子**。\n\n・根因是最底層的頁面底色跟著透明度一起變透明了 —— 透到最後露出的是**瀏覽器自己的白色畫布**。\n・現在最底層一律不透明，而上面那些面板（上方列、行情列）**仍然保有你選的透明度**，天氣照樣從它們透出來。\n・重整前後完全一致了。\n・順帶修掉：只要主背景帶一點透明度，圖表的格線配色就會反過來（暗底配深色格線，等於看不見）。", "修好了"],

    ["2026-09-24", "📐", "主圖跟副圖的格線終於對得上，而且會貫穿",
     "主圖與下方 KDJ/RSI/MACD 的**背景格線一直對不齊**，看起來像四張各自獨立的圖。\n\n・原因是每張圖的右側價格軸寬度不一樣（因為刻度數字長短不同）→ 同一個時間點落在不同的位置，最多差 **11.6 像素**。現在四張圖的價格軸統一寬度，時間點完全對齊。\n・面板之間的縫隙縮到只剩那條分界線（1px），上下的格線因此成為**同一條直線**；「中間仍有區隔」也還在。", "修好了"],

    ["2026-09-24", "📊", "下方副圖大翻修",
     "・**數值不再是「—」**：以前 KDJ/RSI/MACD 那排數字要等滑鼠移上去才第一次出現，移開後又停在最後停留的位置。現在載入就有最新值，移開自動回到最新。\n・**縮放時不再上下跳**：RSI 固定 0~100、KDJ 依整段資料算 —— 縮放時那幾條參考線穩穩不動（實測五種縮放量，刻度完全沒變）。\n・**上下不再落後主圖**：副圖以前比主圖晚一幀才跟上，現在同一幀更新。\n・**上下界線延伸到底**：20/50/80、30/50/70 那幾條橫線會一路畫到最右邊，不再停在最後一根 K 棒。\n・圖例那排改成浮在圖上，線條從文字背後連貫穿過，每個副圖多拿回一些高度。", "更新"],

    ["2026-09-24", "✨", "整體介面更一致了",
     "圓角、字級、間距、陰影以前是**每個元件各自為政**（光圓角就有 28 種、字級 24 種還混著 8.5 / 10.5 / 12.5px 這種半像素）。現在收斂成一組固定刻度 —— 橘子熊的配色與手繪風格完全保留，只是排列更有節奏。\n\n・上方列右側十幾顆圖示改成**分組**排列（視窗模式／圖表疊加／面板…），中間留白隔開，不再是一整片。\n・圖片全部重新無損壓縮，載入更快。", "調整"],

    ["2026-09-24", "📱", "手機上方可以選 5 個時間級別了",
     "原本最多只能選 4 個，現在是 **5 個**（預設 日 / 4H / 1H / 15m / 5m）。三種手機寬度都確認過每一顆都點得到、不會被擠出畫面。", "調整"],











  ];

  function _seen()     { try { return localStorage.getItem(KEY) === PUB_ID; } catch (e) { return false; } }
  function _markSeen() { try { localStorage.setItem(KEY, PUB_ID); } catch (e) {} }

  function _injectStyle() {
    if (document.getElementById("announceStyle")) return;
    const st = document.createElement("style");
    st.id = "announceStyle";
    st.textContent = `
/* 更新資訊面板：跟 app 其他面板同一套語言（深色面板＋系統配色變數＋圓角晶片）。
   2026-09-18 改版：原本是封面城堡的「羊皮紙佈告」（米紙底、紙紋、手繪虛線框、草寫日期貼紙），
   跟 app 介面差太多（使用者：「太鮮艷是指跟整體風格不同」）。
   ★ 顏色一律走 var(--bg2/--bg3/--border/--text/--muted/--accent) → 使用者改系統配色、
     或切極簡(白)模式時，這張卡自動跟著，不會再有一張「不屬於這個 app」的卡片。 */
#announceOverlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  padding:22px;background:rgba(8,5,3,.62);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  animation:annFade .22s ease both}
@keyframes annFade{from{opacity:0}to{opacity:1}}
.ann-card{position:relative;width:min(470px,93vw);max-height:88vh;display:flex;flex-direction:column;
  padding:15px 15px 13px;color:var(--text);
  font-family:"M PLUS Rounded 1c",-apple-system,"PingFang TC",system-ui,sans-serif;
  background:var(--bg2);border:1px solid var(--border);border-radius:20px;
  box-shadow:0 24px 80px rgba(0,0,0,.7),0 0 0 1px rgba(255,145,71,.08);
  animation:annPop .26s cubic-bezier(.2,.9,.3,1) both}
@keyframes annPop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.ann-close{position:absolute;top:11px;right:12px;width:26px;height:26px;border-radius:50%;
  border:1px solid var(--border);background:transparent;color:var(--muted);font-size:15px;line-height:1;
  cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.16s;
  -webkit-tap-highlight-color:transparent;z-index:3}
.ann-close:hover{background:var(--bg3);color:var(--text)}
.ann-close:active{transform:scale(.9)}
.ann-head{display:flex;align-items:center;gap:10px;margin:0 34px 12px 0;flex-shrink:0}
.ann-bear{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;padding:2px;
  background:var(--bg3);border:1px solid var(--border)}
.ann-head-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.ann-title{font-size:15.5px;font-weight:800;color:var(--text);letter-spacing:.01em}
.ann-sub{font-size:11.5px;color:var(--muted)}
/* 日期：改成跟 .sym-tag 同款的小晶片（原本是歪斜的草寫貼紙） */
.ann-ver{margin-left:auto;flex-shrink:0;align-self:center;font-size:11px;font-weight:700;color:var(--muted);
  background:var(--bg3);border:1px solid var(--border);border-radius:99px;padding:3px 10px;
  font-variant-numeric:tabular-nums}
/* 分頁：沿用時框按鈕那組手感（未選＝透明+邊框、選中＝強調色+深字） */
.ann-tabs{display:flex;gap:5px;flex-shrink:0;margin-bottom:10px}
.ann-tab{flex:1;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--muted);background:transparent;
  border:1px solid var(--border);border-radius:10px;padding:7px 0;cursor:pointer;
  -webkit-tap-highlight-color:transparent;transition:background .12s,color .12s,border-color .12s}
.ann-tab:hover{background:var(--bg3);color:var(--text)}
.ann-tab.on{background:var(--accent);border-color:transparent;color:#2C1607}
.ann-scroll{position:relative;flex:1;min-height:0;overflow-y:auto;margin:0 -2px 12px;padding:0 2px}
.ann-scroll::-webkit-scrollbar{width:6px}
.ann-scroll::-webkit-scrollbar-thumb{background:rgba(255,145,71,.38);border-radius:99px}
.ann-list{list-style:none;padding:0;margin:0}
.ann-item{position:relative;margin:0 0 8px;padding:11px 12px;border-radius:14px;
  background:var(--bg3);border:1px solid var(--border);animation:annItem .4s ease both}
.ann-item:last-child{margin-bottom:2px}
.ann-item::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;
  background:var(--ann-accent,var(--accent));opacity:.55}
@keyframes annItem{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.ann-item-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ann-emoji{font-size:15px;line-height:1;flex-shrink:0;width:27px;height:27px;display:flex;align-items:center;justify-content:center;
  background:var(--bg4);border:1px solid var(--border);border-radius:9px}
.ann-name{flex:1;min-width:0;font-size:13.5px;font-weight:800;color:var(--text);line-height:1.35}
.ann-tag{flex-shrink:0;align-self:flex-start;margin-top:1px;font-size:10.5px;font-weight:700;letter-spacing:.02em;
  padding:2px 8px;border-radius:99px;color:var(--ann-accent,var(--muted));background:transparent;
  border:1px solid color-mix(in srgb,var(--ann-accent,var(--border)) 45%,transparent)}
.ann-desc{font-size:12px;line-height:1.6;color:var(--muted)}
.ann-desc p{margin:0 0 6px}
.ann-desc p:last-child{margin-bottom:0}
.ann-desc b{color:var(--text);font-weight:700}
/* 行首「・」排成真正的條列：折行時對齊，不會掉回行首 */
.ann-bul{list-style:none;margin:0 0 6px;padding:0}
.ann-bul:last-child{margin-bottom:0}
.ann-bul li{position:relative;padding-left:13px;margin:0 0 3px}
.ann-bul li:last-child{margin-bottom:0}
.ann-bul li::before{content:"・";position:absolute;left:-1px;top:0;color:var(--accent);opacity:.65}
/* 快捷鍵 */
.ann-kbd-hint{font-size:11px;color:var(--muted);margin:0 2px 9px;opacity:.85}
.ann-kbd{display:flex;gap:10px;align-items:baseline;padding:8px 11px;margin-bottom:6px;border-radius:12px;
  background:var(--bg3);border:1px solid var(--border)}
.ann-kbd-k{flex:0 0 116px;display:flex;flex-wrap:wrap;gap:4px}
.ann-kbd-k span{font-size:11.5px;font-weight:700;color:var(--text);background:var(--bg4);
  border:1px solid var(--border);border-bottom-width:2px;border-radius:6px;padding:2px 7px;white-space:nowrap}
.ann-kbd-d{flex:1;min-width:0;font-size:12px;line-height:1.55;color:var(--muted)}
/* 可自訂的按鍵晶片：長得跟固定那顆一樣，只是可點（hover 才看得出來可互動） */
.ann-kbd-btn{font:inherit;font-size:11.5px;font-weight:700;color:var(--text);background:var(--bg4);
  border:1px solid var(--border);border-bottom-width:2px;border-radius:6px;padding:2px 9px;
  white-space:nowrap;cursor:pointer;transition:border-color .12s,color .12s}
.ann-kbd-btn:hover{border-color:var(--accent);color:var(--accent)}
.ann-kbd-custom{border-color:var(--accent);color:var(--accent)}      /* 已改過的 */
.ann-kbd-rec{border-color:var(--accent);color:#2C1607;background:var(--accent)}  /* 錄製中 */
.ann-kbd-err{font-size:11.5px;color:#e5836a;margin:0 2px 8px;display:none}
.ann-kbd-err.on{display:block}
.ann-kbd-sec{font-size:11px;color:var(--muted);opacity:.7;margin:14px 2px 7px}
.ann-kbd-foot{margin-top:12px;text-align:right}
.ann-kbd-reset{font:inherit;font-size:11.5px;color:var(--muted);background:transparent;
  border:1px solid var(--border);border-radius:9px;padding:5px 12px;cursor:pointer}
.ann-kbd-reset:hover{color:var(--text);border-color:var(--accent)}
/* 更新紀錄：只列標題、點了才展開 */
.ann-hist-sum{font-size:11px;color:var(--muted);margin:0 2px 9px;opacity:.85}
.ann-hist-day{display:flex;align-items:center;gap:8px;margin:6px 0 7px;font-size:11.5px;font-weight:700;
  color:var(--muted);font-variant-numeric:tabular-nums}
.ann-hist-day::after{content:"";flex:1;height:1px;background:var(--border)}
.ann-hist-item{margin-bottom:6px;border-radius:12px;background:var(--bg3);border:1px solid var(--border);overflow:hidden}
.ann-hist-t{display:flex;align-items:center;gap:7px;width:100%;box-sizing:border-box;
  font-family:inherit;text-align:left;background:transparent;border:none;cursor:pointer;
  padding:9px 11px;font-size:12.5px;font-weight:700;color:var(--text);line-height:1.4;
  -webkit-tap-highlight-color:transparent;transition:background .12s}
.ann-hist-t:hover{background:var(--bg4)}
.ann-hist-tx{flex:1;min-width:0}
.ann-hist-arr{flex-shrink:0;font-size:9px;color:var(--muted);transition:transform .18s ease}
.ann-hist-item.open .ann-hist-arr{transform:rotate(180deg)}
.ann-hist-d{font-size:12px;line-height:1.55;color:var(--muted);padding:0 11px 10px}
.ann-hist-d p{margin:0 0 5px}
.ann-hist-d p:last-child{margin-bottom:0}
.ann-more{display:block;width:100%;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--muted);
  background:transparent;border:1px dashed var(--border);border-radius:12px;
  padding:9px 0;margin:4px 0 2px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:.16s}
.ann-more:hover{background:var(--bg3);color:var(--text);border-style:solid}
.ann-empty{padding:24px 6px;text-align:center;font-size:12.5px;color:var(--muted)}
.ann-foot{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-shrink:0}
.ann-btn{font-family:inherit;padding:8px 16px;border-radius:10px;font-size:12.5px;font-weight:700;cursor:pointer;
  -webkit-tap-highlight-color:transparent;user-select:none;transition:background .14s,color .14s,border-color .14s,transform .1s}
.ann-btn:active{transform:scale(.97)}
.ann-btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}
.ann-btn-ghost:hover{background:var(--bg3);color:var(--text)}
.ann-btn-primary{background:var(--accent);border:1px solid transparent;color:#2C1607}
.ann-btn-primary:hover{filter:brightness(1.06)}
`;
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
  const _TAGC = { "新功能": "#E8A05C", "更快了": "#6FBFB1", "修好了": "#9DC271", "調整": "#B79770" };
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
  /* 快捷鍵分頁：可自訂的那幾顆做成可點的晶片（點了按新鍵就改），其餘列出來但標明固定。
     ⚠ 只透過 window._hk* 那幾支跟 hotkeys.js 溝通，不自己讀 localStorage ——
       綁定規則（哪些鍵不給綁、衝突怎麼判）只能有一份，散到兩邊一定會分家。 */
  function _keysHtml() {
    const edit = (typeof window._HOTKEY_EDIT === "function") ? window._HOTKEY_EDIT() : [];
    const rows = (typeof window !== "undefined" && window._HOTKEY_ROWS) || [];
    if (!edit.length && !rows.length) return `<div class="ann-empty">快捷鍵清單還在載入…稍等一下再開這個分頁</div>`;
    const chip = a =>
      `<button class="ann-kbd-btn${a.custom ? " ann-kbd-custom" : ""}" data-hk="${a.id}" ` +
      `title="點一下再按新的鍵；Esc 取消">${_md(window._hkDisp ? window._hkDisp(a.key) : a.key)}</button>`;
    const editable = edit.map(a =>
      `<div class="ann-kbd"><div class="ann-kbd-k">${chip(a)}</div>` +
      `<div class="ann-kbd-d">${_md(a.label)}</div></div>`).join("");
    // 固定的那些：hotkeys.js 直接給（⚠ 別在這裡用字串規則挑，「↑ ↓ / 空白」會因為含 "/" 被誤濾掉）
    const fixed = ((window._HOTKEY_FIXED) || []).map(([k, d]) =>
        `<div class="ann-kbd"><div class="ann-kbd-k">` +
        (String(k).split(/\s{2,}|　/).map(x => x.trim()).filter(Boolean).map(x => `<span>${_md(x)}</span>`).join("")
          || `<span>${_md(k)}</span>`) +
        `</div><div class="ann-kbd-d">${_md(d)}</div></div>`).join("");
    const helpK = (edit.find(a => a.id === "help") || {}).key || "?";
    return `<div class="ann-kbd-hint">點下面的按鍵晶片就能改成自己順手的鍵（按 Esc 取消）。` +
      `中文輸入法下也能用——認的是<b>實體按鍵位置</b>，不是打出來的字。` +
      // ⚠ 顯示「目前的」說明鍵而不是寫死 "?"：使用者可以把它改掉，寫死就會教錯
      `<br>隨時按 <b>${_md(window._hkDisp ? window._hkDisp(helpK) : helpK)}</b> 可以直接打開這一頁。</div>` +
      `<div class="ann-kbd-err" id="_hkErr"></div>` + editable +
      `<div class="ann-kbd-sec">以下固定不可更改</div>` + fixed +
      `<div class="ann-kbd-foot"><button class="ann-kbd-reset" id="_hkReset">還原成預設快捷鍵</button></div>`;
  }

  /* 綁定互動：點晶片 → 下一個按鍵就是新綁定。
     ⚠ 一定要用 capture 階段並 stopPropagation：hotkeys.js 的全域 keydown 對「說明鍵」的處理
       排在「有彈窗就讓路」之前 → 不攔的話，按到說明鍵會在錄製中把整個面板關掉。 */
  function _wireKeys(ov) {
    const box = ov.querySelector(".ann-scroll");
    if (!box) return;
    const err = box.querySelector("#_hkErr");
    let armed = null;                         // 正在錄製的動作 id
    const say = m => { if (err) { err.textContent = m || ""; err.classList.toggle("on", !!m); } };
    const disarm = () => {
      if (!armed) return;
      box.querySelectorAll(".ann-kbd-btn").forEach(b => b.classList.remove("ann-kbd-rec"));
      armed = null;
      document.removeEventListener("keydown", onKey, true);
    };
    function onKey(e) {
      if (!armed) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { disarm(); say(""); return; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;   // 修飾鍵本身不算
      const k = (window._hkPhysKey ? window._hkPhysKey(e) : e.key);
      const id = armed;
      disarm();
      const r = window._hkBind ? window._hkBind(id, k) : { ok: false, why: "快捷鍵模組還沒載入" };
      if (!r.ok) { say(`「${window._hkDisp ? window._hkDisp(k) : k}」不能用：${r.why}`); return; }
      say("");
      box.innerHTML = _keysHtml();            // 重畫（鍵顯示會變）
      _wireKeys(ov);
    }
    box.querySelectorAll(".ann-kbd-btn").forEach(b => {
      b.addEventListener("click", () => {
        const was = armed === b.dataset.hk;
        disarm();
        if (was) { say(""); return; }         // 再點一次＝取消
        armed = b.dataset.hk;
        b.classList.add("ann-kbd-rec");
        say("按下想用的鍵…（Esc 取消）");
        document.addEventListener("keydown", onKey, true);
      });
    });
    box.querySelector("#_hkReset")?.addEventListener("click", () => {
      if (window._hkResetAll) window._hkResetAll();
      box.innerHTML = _keysHtml();
      _wireKeys(ov);
    });
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
    if (tab === "keys") _wireKeys(ov);
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
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="${_v("/static/img/bear.png")}" alt="">` +
      `<div class="ann-head-txt"><div class="ann-title">熊報 · 更新資訊</div>` +
      `<div class="ann-sub">小啊幫你整理了 ${_recentUpdates().length} 則更新</div></div>` +
      `<span class="ann-ver">${PUB_DATE.replace(/-/g, ".")}</span></div>` +
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
