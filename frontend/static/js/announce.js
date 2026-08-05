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
  const PUB_ID   = "2026-08-05-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-08-05";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [

    ["2026-08-05", "📊", "修好：最新那根 K 棒會出現小跳空，要重新整理才會好",
     "這是你回報的問題，根因找到了。系統每秒會拿回兩根 K 棒：一根是「剛收盤那根的最終數值」，一根是「還在跳動的當下這根」。但程式在合併時漏掉一種情況——當新的一根已經出現，那個「上一根的最終數值」就會被默默丟掉。結果是那根 K 棒永遠停在「下一根剛出現那一瞬間」的未完成價格，而下一根卻是用真正的最終價開盤，兩者對不上，中間就留下一道小跳空。實測 3 分鐘內有 179 根被丟掉，其中一根存的收盤是 63507.6、真正的最終值是 63504.3，而畫面上量到的跳空正好是 3.3——數字完全吻合。重新整理會好，正是因為重整會整條重新抓。現在補上了那個遺漏的處理，並讓每次多回傳一根當作緩衝（交易所定案有時稍慢一點，只回兩根的話補正窗口太短）。修正後三分鐘內跳空 0 次。"],

    ["2026-08-05", "🖌", "繪圖：新增「連續箭頭」與「圓／橢圓」",
     "連續箭頭就是 TradingView 的「路徑」——可以轉折的箭頭。連續點擊加轉折點，雙擊或按 Esc 收尾，箭頭畫在最後一段的末端；畫好之後每個轉折點都可以單獨拖，也可以整條平移。圓／橢圓則是拖出一個框、畫出框內接的橢圓，用來圈區域或標記形態。兩個工具的框內都不會整片攔截點擊（只有邊框附近才選得到），所以不會擋住底下的 K 棒。"],

    ["2026-08-05", "🎨", "繪圖顏色：每個時間級別一種顏色，而且保證不重複",
     "每個時間級別都有自己的畫筆顏色（1 分紅、5 分橘、15 分琥珀、30 分綠、1 小時紫、2 小時青、4 小時藍、日線金、週線粉、月線棕），切過去畫筆就自動換好，不用每次手動調。時間級別按鈕的底部現在直接標著那個顏色，整張對照表一眼看完。\n\n重點是加了防呆：任何兩個時間級別都不可以用同一個顏色。舉例來說，你人在 5 分線、想把畫筆改成 1 分線的紅色，會被擋下並提示「這個顏色是 1m 在用的」。因為整套設計的前提就是「看顏色就知道這條線是在哪個級別畫的」，一旦借用就再也分不出來，而且是安靜地失效。這個規則不只擋新設定，每次讀取設定時也會強制化解衝突，所以就算之前存過重複的值也會自動修正。\n\n跨級別的可見性完全不變：在 1 分線畫的線，切到 5 分線一樣看得到、顏色也不變。"],

    ["2026-08-05", "⚡", "繪圖工具搬到手邊：開高低收量右邊多了一排快捷鍵",
     "左側的繪圖工具島要把滑鼠滑到螢幕最左緣才會彈出來。現在在「開＝高＝低＝收＝量＝」右邊的空白處補了一排常用工具：游標、趨勢線、水平線、矩形、圓、連續箭頭、文字，末端接上畫筆顏色框（顯示目前是哪支筆、屬於哪個級別，點它可以改）。兩排是同一套狀態，點哪邊另一邊都會跟著亮。"],

    ["2026-08-05", "🚀", "切回看過的標的不再重算一次",
     "背景有個「教練掃描」每分鐘會掃前 60 檔幣，它需要的資料量遠超過快取容量，結果每輪都把整個快取洗掉一次——包括你剛看過的勝率結果。於是你切走再切回同一個標的，明明幾十秒前才算過，卻要重新計算並重新跟交易所要資料。現在教練有自己獨立的快取，不會再洗掉別人的。實測：跨過一輪教練掃描後再打開同一個勝率，從「要重算 300 毫秒起跳」變成「命中快取 54 毫秒」。使用者變多時，這也直接減少了對交易所的重複請求。"],

    ["2026-08-04", "🇹🇼", "修好：台股漲停／跌停的股票，報價顯示的是昨天收盤價",
     "這是這批裡最嚴重的一個。漲停鎖死的股票，因為當下沒有成交，即時報價來源會回一個「沒有成交價」的空值，而程式在拿不到成交價時，竟然是拿「昨天的收盤價」頂替上去——結果就是：一檔今天漲停 10% 的股票，報價列顯示昨收、漲跌幅顯示 0.00%，而且這個假的「即時價」還會反過來把原本正確的今日價蓋掉。整張表看起來就像沒在更新。實測 2337 旺宏顯示 100.5（實際 110.5 漲停）、3006 晶豪科顯示 180（實際 198 漲停）。現在改成：拿不到成交價時，會依照當下的買賣掛單判斷是漲停鎖死還是跌停鎖死，取正確的價位；真的判斷不出來就寧可不覆蓋，也不會拿昨天的價來充數。"],

    ["2026-08-04", "⚡", "台股報價列不再每隔幾秒卡一下",
     "先前台股報價列每 3 秒左右就會頓一下，最慢會停到將近 3 秒。原因是台指期的報價被寫在「使用者要資料的當下才去抓」——快取一過期，就由那個倒楣撞上的人替所有人去外部抓一次，他那次的請求就整個卡住。現在改成背景先更新、使用者永遠拿現成的（最多差幾秒，而報價列本來就是每 3 秒更新一次）。實測從「每 429 次有 40 次超過 150 毫秒、最慢 2.8 秒」變成「209 次全部低於 150 毫秒、最慢 0.12 秒」。"],

    ["2026-08-04", "📏", "新增：在小時間級別上看得到「日開盤價」和「4 小時開盤價」",
     "圖例多了一個「日/4H開」開關（預設關）。打開之後，即使你在看 5 分鐘或 15 分鐘線，也會畫出當天日 K 棒與 4 小時 K 棒的開盤價水平線（橘色是日開、藍色是 4H 開）——那是很多人拿來當多空分界的價位。只畫比你目前時間級別大的，所以在 4 小時線上就不會再重複畫 4H 開。線的邊界跟 app 自己的大時框 K 棒完全一致（加密貨幣走 UTC 換日，所以在圖上是台北早上 8 點換日，不是半夜 12 點）。只畫已經收盤的區段，還在形成中的不畫，畫面不會跳來跳去。"],

    ["2026-08-04", "🎨", "新增：每個時間級別有自己的繪圖顏色，切過去就自動換筆",
     "以前在不同時間級別畫線，全部都是同一個顏色，事後根本分不出哪條是在 4 小時畫的、哪條是 15 分鐘畫的。現在每個時間級別都有自己的預選色（1 小時紫、4 小時藍、15 分鐘琥珀…），切過去畫筆就自動換好，不用每次手動調。左側繪圖工具列也多了一個顏色框，直接顯示「目前是哪支筆、屬於哪個時間級別」，點它就能改該時間級別的顏色，改完會被記住。已經畫好的線不受影響。"],

    ["2026-08-04", "📐", "繪圖：按住 Shift 畫線會鎖成水平",
     "畫趨勢線／射線／箭頭時按住 Shift，第二點的價位會自動對齊第一點，畫出完全水平的線（跟 TradingView 一樣）。拖動已經畫好的線的端點時按住 Shift 也一樣會鎖水平。放開就恢復正常。"],

    ["2026-08-04", "🔧", "修好：畫好的矩形／線，移動它的時候大小會變",
     "拖動已經畫好的圖形時，形狀會被扯歪——尤其開著磁鐵吸附的時候特別明顯。原因是移動時程式把圖形的兩個角「各自」重新吸附一次，兩個角吸到不同的 K 棒上，形狀自然就變了。實測開著磁鐵時，超過七成的拖動都會變形，最嚴重的高度誤差到八成。現在改成只計算一個基準點、另一點照原本的相對距離跟著走，移動時形狀完全不變。所有雙點圖形（矩形、趨勢線、射線、箭頭、費波那契）都一起修好了。"],

    ["2026-08-04", "🖱", "修好：點副圖指標的圓點想切顯示／隱藏，卻跳出調色盤",
     "副圖那幾個指標（KDJ、RSI、MACD）的圓點，本來是拿來切顯示或隱藏的，但點下去會同時跳出調色盤擋住畫面。這些顏色在齒輪的設定面板裡本來就調得到，所以現在點圓點只切顯示隱藏、不再跳色盤（跟主圖的布林通道、成交量早就是這樣處理的）。超買／超賣那幾條水平線沒有顯示切換、不衝突，仍然可以點著調色。"],

    ["2026-08-04", "📊", "K 棒版面：上下留白收緊，整塊往下移一點",
     "先前 K 棒只佔圖表高度的一半，上下都是大片空白，看起來又高又空。調整後 K 棒佔的比例提高，整塊也往下移了一些，成交量柱跟著縮到底部一小條、不會跟 K 棒重疊。"],

    ["2026-08-04", "🚀", "開啟速度：慢速網路下進場快了約 0.7 秒",
     "針對網路較慢的情況做了一輪。首頁文字出現從 1.24 秒縮到 0.95 秒、可以按下大門的時間從 3.08 秒縮到 2.34 秒、K 棒出現從 3.77 秒縮到 2.91 秒。做法包括：把進場真正必要的程式提高下載優先權（原本它被城堡圖壓在後面）、封面用不到的圖片不再搶頻寬、已經看過封面的人不再重複下載城堡圖、以及把兩塊進場後才用得到的功能移出首屏。整包下載量也從 1190KB 降到 1058KB。"],

    ["2026-08-03", "📈", "美股／港股的 4 小時線，可以往回看一年了",
     "以前美股和港股切到 4 小時線只有大約兩個月的歷史（80 根 K 棒），比 2 小時線的一年還短——越大的時框反而看得越短，完全反過來。原因是 4 小時線是直接跟資料來源要的，而它對 4 小時只提供 60 天；2 小時線則是用 1 小時線自己組出來的，能拿到兩年。現在 4 小時線也改用同樣的方式組。換之前有先逐根比對過：同一段期間 36 根 K 棒的時間、開高低收、成交量全部一模一樣，所以圖上不會有任何一根改變，純粹是能往回看更久。蘋果從 80 根變 543 根（回到 2025 年 6 月），騰訊從 80 根變 531 根。"],
    ["2026-08-03", "👥", "多人同時使用時，不再重複跟交易所要同一份資料",
     "使用者變多時，最先撞到的其實不是伺服器效能，而是交易所的流量限制（每秒只能問 10 次，而且全站所有人共用同一個對外位址，被擋就是全站行情一起停）。實測發現兩個地方會「同一份資料被重複要很多次」：8 個人同時打開同一個標的的圖表，會各自去跟交易所要一次（8 次）；要一年的深度歷史更誇張，8 個人就是 48 次。掛單牆和訂單簿因為每 1.2 秒就更新一次，頻率最高、風險最大。現在同一份資料同一時間只會有一個人去拿，其他人直接共用結果——上面三種情況分別降到 1 次、6 次、1 次。你自己看到的內容和即時性完全沒變。"],
    ["2026-08-03", "🛡", "修好：網路瞬斷會讓台股清單整批停更 30 秒",
     "先前為了加速，程式改成重複使用已建立的網路連線。但對方的伺服器可能早就把閒置的連線關掉了，我們再拿來用就會斷——這是「重複使用連線」才會有的狀況，而當時沒有任何補救，那一輪的台股全量清單就整批沒更新，要等 30 秒後的下一輪。現在遇到這種「請求根本沒送出去」的斷線會自動重試。刻意只對「查詢類」的請求重試，下單相關的一律不重試（避免同一張單被送出兩次）。另外策略計算也做了一點加速，同樣的結果少花約 6% 的時間。"],
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
