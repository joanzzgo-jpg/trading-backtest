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
  const PUB_ID   = "2026-08-14-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-08-14";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-08-14", "📊", "經濟事件的 CPI 日期錯了 5 筆——其中 3 筆是還沒發生的",
     "主圖上的經濟事件垂直線裡，CPI（美國消費者物價）的發布日期是一張**手動維護的表**，因為官方網站擋爬蟲。我去核對時發現這張表錯了 5 筆，而且錯得很安靜——線照畫、不報錯，只是畫在錯的日子上。\n\n**三筆是還沒發生的**：8 月份 CPI 是 9/11（表上寫 9/15）、9 月份是 10/14（表上 10/13）、10 月份是 11/10（表上 11/12）。如果你照著那幾條線安排部位，會全部差幾天。\n\n另外兩筆：2026 年 1 月份那場因政府停擺順延到 2/13（表上仍是 2/11）；還有一條 **2025-11-13 的線根本是假的**——那場 CPI 因停擺**直接取消、從未發布**，表上卻排著。\n\n三個獨立來源交叉核對過才改。順帶一提 2027 年的**目前全世界都拿不到**：官方要到今年年底才公告，網路上流通的 2027 日期全是別人的推估——所以我留空，不拿推估值畫線給你看。"],

    ["2026-08-14", "⚡", "最近兩週的 5 分鐘線，往回滑快了 8.8 倍",
     "BTC/ETH/SOL/XAUT 的歷史 K 線有一份存在伺服器上的本地倉庫，往回滑時直接讀，不用等交易所回應。但那份倉庫上次更新是 7/30，**最近兩週是空的**——滑到那段就得現場去問交易所。\n\n補到最新了。實測同一段（8/04~8/09）從 **82.6 毫秒降到 9.4 毫秒**。除了比較快，也省下對交易所的請求額度——那個額度被吃光正是先前「K 棒會抖、行情對不上」的源頭。"],

    ["2026-08-14", "🗂", "更新之後不用再重抓整包程式",
     "伺服器每重啟一次（平台維護、擴縮、當機重來），你的瀏覽器就會把整包前端**重抓一遍約 1MB**——即使程式一個字都沒改。\n\n原因是判斷「要不要重抓」的版本編號，在伺服器上算出來的其實是**開機時間**。所以只要重啟，編號就變，瀏覽器認定是新版本。\n\n改成用檔案內容本身算編號：內容沒變就是同一組編號，重啟不影響你的快取；真的改了才會換。手機用行動網路開的時候差最有感。"],

    ["2026-08-13", "✚", "十字線移到沒有 K 棒的地方會斷掉一半",
     "你回報「鼠標的虛線對齊十字到沒 K 棒處就消失了」。確認了，而且是穩定重現的。\n\n那條**鉛直**線是自己畫的（不是圖表庫內建的，因為要讓它跨到下面的副圖、還要帶時間標籤），靠「游標底下是哪一根 K 棒」來定位。空白處沒有 K 棒，程式就整批把線藏起來——但**橫線和右側價格標籤是另一條路徑、還留著**，所以你看到的是十字線只剩一半。\n\n最後一根右邊的空白一直有特別處理，**第一根左邊的沒有**。而左邊空白其實很常遇到：月線、日線這種資料本來就少的時框，或是縮到最小看見全部的時候。兩邊一起補上了。"],

    ["2026-08-13", "📱", "手機上「我的交易」和 VWAP 按鈕點不到",
     "這是我自己上一版加東西造成的：上方那排圖示右邊多了訊號格和圖層鈕之後，整排變寬 114 像素，**最後兩顆直接被推到螢幕外面**——而且上方那列不會捲、頁面也不會左右滑，等於**永遠點不到**，畫面上還完全看不出異常。\n\n不過查下去發現這不只是「加了新東西才壞」：修正前那排距離 390 寬的螢幕**只剩 6 像素餘裕**，360 寬的 Android 其實早就中了。所以我沒有把新東西藏起來了事（下一顆按鈕又會把它推出去），而是讓那排按鈕自己可以橫向滑動。360／375／390／820／1200 五種寬度都驗過，每一顆都點得到。"],

    ["2026-08-13", "📶", "斷線時會明講，還有訊號格；外匯資料停在三小時前也修好了",
     "上方多了**四格訊號**顯示目前連線品質，真的斷線時另外會出現紅色的「已離線」。\n\n訊號強度是直接量你本來就在跑的報價輪詢，**沒有多花任何流量**，量到的正是這個 app 實際在走的那條路。判斷斷線不能只信瀏覽器說的「有沒有連上網路」——連著 Wi-Fi 但實際沒有對外網路（最常見的那種斷網）它照樣說正常，所以另外會主動探測一次確認。\n\n另外你回報「外匯斷了，最新只到 6:55」：原因是抓資料時的日期邊界是按**該標的交易所的時區**算的，歐元掛的是倫敦時間，於是「到今天為止」被切在昨天 23:00，今天整天的資料全被排除。實測修正後 EUR/USD、USD/JPY 都只落後 2 分鐘。"],

    ["2026-08-12", "🎨", "繪圖分成 A/B/C 三層，可以各自關掉",
     "畫久了線會疊成一團——長線結構、當日進出場、還在試的想法全糊在一起。現在繪圖分成三層，想專心看某一組時把其他層關掉就好，**不必真的把線刪掉再重畫**。\n\n上方時間框右邊多了 A B C 三顆小鈕：點一下＝設成「作用層」（之後畫的線進這層，橘色實心）；再點同一顆＝隱藏／顯示（灰掉加刪除線）。鍵盤 **Z / X / C** 直接切 A / B / C 的顯示。三層各自獨立，可以同時全開，預設就是全開。\n\n已經畫好的線也能換層：**點選那條線，按 Shift+Z / Shift+X / Shift+C** 就移過去；移錯了按 V 可以復原。\n\n堆疊順序是上到下 A → B → C，A 蓋在最上面。重疊時點到的一定是看得見的那一條，不會選到被蓋住的線。\n\n⚠ 你原本所有的繪圖都算在 A 層，**不需要任何遷移、一條都不會消失**。實測你帳號裡 15 個標的、158 條線，加上圖層資訊只多 1.9KB。"],

    ["2026-08-12", "⌨️", "中文輸入法下快捷鍵全部失效——修好了，順便加了 V＝回上一步",
     "你回報「快捷無效」，追問後是「在中文輸入法時無效」。查下去發現這**不只影響新加的功能**——R（重播）、M（磁鐵）、數字切時框、[ ] 、/、? 這些原本就有的快捷鍵，**在注音輸入法下全都是壞的**，只是一直沒被發現：開發時多半掛英數輸入法，自動測試也永遠是英數，兩邊都碰不到。\n\n原因是程式判斷「你按了哪個鍵」時讀的是輸入法轉譯後的結果。改成直接讀**實體按鍵位置**，不管掛哪套輸入法、螢幕上出現什麼字元都不受影響。\n\n（第一次我還修錯：以為注音下按鍵會回傳一個特殊標記，實際上回傳的是注音符號本身——實體 Z 鍵在注音是「ㄈ」，剛好也是一個字元，所以我原本的判斷條件根本沒被觸發。你說「還是一樣要切輸入法」就是這個原因。）\n\n順帶新增 **V＝回上一步**（跟 Cmd/Ctrl+Z 一樣，但單手就按得到）。沒東西可復原時會明講「沒有可復原的繪圖」，不會假裝做了事。"],

    ["2026-08-12", "📍", "天氣跑到別的縣市——不是你的手機定位壞了",
     "你回報「我在新北新莊，為什麼有新竹的雲」，差了 60 公里。天氣資料本身沒錯（用新莊座標去問，回的就是新莊），錯的是**送出去的座標**。\n\n開啟時的流程是：先用上次成功的 GPS 位置畫一次，同時重新定位；GPS 拿不到才退回用 IP 粗略定位。問題出在退回那一步——它會**無條件覆蓋**掉剛才那個更準的位置。台灣很多電信業者的 IP 都註冊在別的縣市，所以 GPS 一逾時（要等 28 秒），畫面就從新莊跳成新竹。\n\n現在有上次的 GPS 位置就不讓 IP 蓋掉了。天氣卡地名後面的 📍 會告訴你這次的位置從哪來：`GPS ±35m`＝真的 GPS、`快取(GPS逾時)`＝沿用上次的正確位置、`IP約略`＝只能用 IP（代表你從來沒成功定位過，那要看瀏覽器的定位權限）。"],

    ["2026-08-12", "🌧", "「雨大約幾分鐘後到」以前會報不會來的雨",
     "附近雨區的到達時間算法整個換掉了。舊算法把一整片雨當成**一個點**，結果兩個方向都會錯，而且畫面上看起來都很正常（有數字、不報錯）。\n\n**誤報**：夾角 65 度的雨區其實是從 7.3 公里外斜斜掠過、永遠不會到你頭上，舊算法照樣回「約 38 分後到」。**晚報**：一整片 40 公里寬的雨帶斜壓過來，先碰到你的是它的**邊緣**不是中心，舊算法用中心距離算，實測晚報 10 分鐘（報 32 分，實際 22 分就到了）。\n\n新算法把雨區當成有寬度的一片：先算它最近會從你身邊多遠掠過，掠過距離超過那片雨的寬度就是**不會經過你**——這種只留「往你移動」不掛時間，不給你一個假的分鐘數。會經過的則從**邊緣**算，不是中心。\n\n⚠ 影線般的細節：移動方向本身有誤差、而且愈遠累積愈大，所以判斷「會不會掃到你」時留了一個誤差範圍——漏報比誤報糟，寧可多提醒。"],

    ["2026-08-12", "⚡", "天氣、附近雨區、外匯報價：不會再偶爾卡住好幾秒",
     "這幾支的共同毛病是「快取一過期，那個倒楣的使用者就得在原地等網路」。平常你開起來都是幾毫秒，但每隔幾分鐘就會有一次很慢——而且你不會知道為什麼。\n\n線上實測有多慢：天氣 **10.8 秒**、附近雨區 **6.8 秒**。（比本機慢五倍，因為伺服器離那些資料源遠。）\n\n改成「過期時先把手上的舊值給你，同時在背景重新抓」。天氣本來就允許幾分鐘誤差，拿幾分鐘前的值換「永遠不卡」很划算；雨的部分因為對新鮮度敏感，舊值只沿用 10 分鐘。另外也修掉幾個「同一時間多個人一起等」會各自去打上游的地方（外匯那支原本一個人就要打 21 檔）。\n\n線上實測：連續 35 次取樣涵蓋 283 秒、跨過兩次快取過期，**最慢 450 毫秒、超過一秒的次數是 0**。"],

    ["2026-08-12", "🔕", "操作提示框拿掉了，只留「找不到標的」",
     "你說「提示框可以拿掉，只有找不到標的時需要，操作上不用」——照做了。復原繪圖、顏色衝突、已同步、安裝提示、連線重試那些通通不跳了；你自己剛做完那個操作，不需要 app 再講一次。\n\n只有「你要的東西不存在」（例如標的查無）還會跳，因為那是你無從得知、而且需要改變下一步動作的情況。\n\n（順帶一提，這件事我一開始理解錯，花了兩版在調它的配色和樣式，你說「還是怪怪的」我才問對問題：不是設計不好看，是這東西根本不該存在。）"],

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
