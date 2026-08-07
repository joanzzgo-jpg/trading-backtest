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
  const PUB_ID   = "2026-08-07-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-08-07";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-08-07", "🎨", "主圖背景色終於改得動了（而且和系統外觀完全分開）",
     "你反覆回報「主圖背景色改不了」，追到最後發現不是一個原因，是三個疊在一起。\n\n第一個：樣式表裡有一條規則用最高優先級把圖表區的底色鎖成系統色，程式上什麼顏色都會被它蓋掉——實測程式明明寫進了紫色，畫面算出來仍然是原本的深藍灰。第二個：舊版的「暗色濾鏡」會把任何選色的亮度壓到最多 18%，不同深淺的顏色被壓進同一個窄區間，所以色盤上分得出來的顏色上到圖表就都差不多；這層已經整個拿掉，你選什麼就是什麼。第三個：色盤的不透明度滑桿產生的是 8 位色碼，而處理函式只認 6 位，於是帶不透明度的選色會讓整套機制失效、系統色從後面透上來，看起來像「全部一起改」。\n\n現在兩個色盤完全獨立：主圖色只管主圖與副圖，系統背景色只管上方列與右邊行情列。實測系統色連換三種，主圖顏色一個位元都沒動；反過來也一樣。兩邊選同一個顏色時，主圖與合約行情的交界處量到完全相同的色值，看不出接縫。副圖與分隔線也一起同色——你說過「下方副圖也算主圖一部分」。"],

    ["2026-08-07", "🌤", "天氣仍然透得出來，但主圖不會再被系統色汙染",
     "要「主圖不被任何東西疊加」又要「天氣看得到」，兩者本來是衝突的：主圖只要留一點透明度，後方天氣層再後面的系統背景色就會滲進來（實測主圖固定綠色時，系統色換三種，主圖跟著變成三種不同的綠）。\n\n解法是在天氣層底下、只蓋住圖表區的範圍，墊一層主圖自己的顏色。這樣天氣照樣從 K 棒後方透出來，但後面已經是主圖自己的色，系統色永遠到不了。封面頁則相反——就算你在裡面選了「無天氣＋小熊磁磚」，封面照樣顯示真實天氣，因為那是門面。小熊磁磚的金熊脈衝也調亮了（原本被一層為亮天空設計的壓暗濾鏡蓋掉，那層在磁磚模式已停用）。\n\n另外，背景選亮色時文字會自動換成深色。以前任何顏色都被壓暗，文字永遠有對比；現在你真的可以選淺色底，所以加了依實際對比度自動挑文字色的機制（淺褐底原本對比只有 1.31:1、幾乎看不見，現在 8.11:1）。"],

    ["2026-08-07", "📊", "K 棒小跳空：又找到兩個來源，都修掉了",
     "上次修的是「即時更新漏接最終值」那條，但你說「有時候還是要重新整理」。追下去發現另外兩個。\n\n第一個是補洞邏輯：分頁凍結、電腦休眠或斷線之後，系統會把中間漏掉的 K 棒補回來，但它只接「我們最後一根之後」的棒，沒有修正最後那幾根本身——而那幾根正好停在中斷當下的未完成數值，於是與後面接上的棒對不起來。時間軸完全連續，所以既有的檢查完全抓不到。\n\n第二個更根本：同一根已經收盤的 K 棒，向伺服器要兩次可能拿到不同數值。實測連抓六次，同來源時完全穩定，但其中一次來源從 Binance 換到 Bybit，20 根裡 19 根全部偏移 3~6 點。每份資料內部都是連續的，是「即時報價來自 A、補洞資料來自 B」拼在一起才產生跳空。現在系統會比對來源，發現換手就把整段重新對齊成同一份。\n\n順帶修好你說的「最新那根會動一下」——開盤價一旦定了就不該再變，但三處補正都是整根覆蓋，浮點精度的微小差異就讓那根跳一下。現在只補最高/最低/收盤。實測一分鐘內「已存在的棒開盤價被改動」次數從 1 次降到 0 次。"],

    ["2026-08-07", "💱", "合約行情的價格不再突然跳掉又卡住",
     "你說「合約行情即時價格對不上我正在看的標的」。抓到現場了：同一輪觀測裡，報價來源從 Binance 換成了 Pionex——不只價格偏掉，還會卡住不動（九秒鐘同一個數字，主圖卻一直在跳）。\n\n原因是報價清單只要 Binance 這次回空，就整份換成另一家交易所（代號格式、價格、更新頻率全都不同）。而 Binance 每秒被呼叫一次，偶發失敗很常見，一次失敗就整列跳價再凍住。現在改成短暫失敗時先沿用上一份 Binance 資料（最多 90 秒），真的長時間中斷才換家——寧可短暫沿用同源舊值，也不要把兩家的價格混在同一份清單裡。\n\n剩下的微小價差（萬分之二等級）是兩條管線各自快取一秒、取樣瞬間不同造成的，屬於結構性差異。"],

    ["2026-08-07", "☁️", "換一台裝置登入，繪圖和設定終於帶得走",
     "以前換裝置打開，看到的永遠是那台自己的舊資料。原因是開機時只把帳號名稱讀回來，從來不向雲端拉資料——要先把分頁切走再切回來才會下載，沒有人會這樣操作。\n\n現在開機就會補拉。而且不只繪圖：主背景色、K 棒配色、線寬、每個時間級別的畫筆顏色、主圖疊加層開了哪些、勝率欄設定、通知偏好等等，總共四十幾項全部跟著走。原本這些只有「登入那一刻」才會下來，一台已經登入著的裝置永遠收不到另一台的改動。手機與桌面雙向都實測過。\n\n另外抓到一個讓整個同步幾乎失效的問題：報價快取每兩秒就寫一次本機儲存，而任何寫入都會重新計時「兩秒半後上傳」——於是計時器永遠被重置，上傳幾乎不會發生。現在那份快取已排除在同步之外。\n\n勝率按鈕旁邊多了一個很淡的同步狀態，平常幾乎看不到，只有還沒存上去或斷線時才會亮起來。"],

    ["2026-08-07", "📱", "手機：不再誤觸繪圖，分頁也不會透出圖表",
     "手機上原本手指一碰到線就直接進入拖曳（判定範圍只有 12 像素，但手指接觸面積遠大於此），在繪圖附近平移十之八九會把線抓走。現在改成長按 0.65 秒才進入調整，期間手指移動超過一點就取消（＝你要平移）；判定範圍同時放寬到 22 像素，長按之後反而更好抓。輕點也不再跳出調色盤——小螢幕上那個彈窗最擋畫面，依你的要求拿掉，點到最多只能移動。\n\n順帶修好一個一直存在的問題：手機其實從來就拖不動繪圖。程式在進入拖曳時會呼叫一個觸控事件物件上不存在的方法，直接出錯，而且錯在「拖曳狀態建立之前」，所以完全沒有反應。\n\n另外你把系統背景選成半透明之後，自選／訊號／設定／交易這幾個分頁會整片透光，後面的圖表頁（標的名稱、時間級別按鈕、開高低收數字）全部看得到。現在這幾頁一律使用「同一個顏色但不透光」的底，不受不透明度影響。"],

    ["2026-08-07", "⌨️", "左右方向鍵切換時間級別；矩形不再擋住 K 棒",
     "左右方向鍵現在可以切時間級別，方向和畫面一致（按右就往右移＝切到更小的級別）。重播模式下左右鍵維持原本的「逐根前進／後退」，不會搶。打字時和彈窗開著時都不作用。順帶一提本來就有的：中括號也是上一個／下一個級別，數字鍵 1~0 直接跳到第 N 個，按問號可以叫出完整的快捷鍵表。\n\n矩形工具平時不再畫邊框，只留半透明底標示範圍——實線邊框壓在 K 棒上最礙眼。滑鼠移上去或選取時邊框才會出現，因為矩形能抓的地方就是邊框（中間是抓不到的），完全不畫的話會不知道要拖哪裡。"],


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
