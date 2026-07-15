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
  const PUB_ID   = "2026-07-15-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-15";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-07-15", "📱", "手機版兩個 bug 修正", "① 在「設定」或「訊號」分頁按登出（或封面重新跳出）時，設定/訊號內容會透出來跟封面重疊、糊成一團 → 已修，封面重跳時這兩頁會正確隱藏。② 圖表頁頂部的開/高/低/收/量資訊列在手機上會換行、第二行（量＋漲跌%）被裁一半又壓到下方 BB 均線圖例 → 已修，資訊列高度自動撐開、兩行完整可讀。"],
    ["2026-07-14", "🎯", "新增策略標記：特多／特空", "主圖新增「特多／特空」市場結構標記（圖例可開關，預設開）：在多空・破多空標記的時間序列上抓 A→B→C 三連結構——特空＝A 看空、B 反彈但實體高不過 A、C 再轉弱且跌破 B 低點（標在 C，金紫箭頭）；特多為鏡像。B 對 A 的『不過／不破』看實體（開收），影線戳過不算。A、B、C 三根 K 可不連續，但之間不夾其他多空／破多空標記。"],
    ["2026-07-14", "📊", "合約行情排列修正", "修正「合約清單有時排列怪怪的」：同一個幣在不同行情來源代號格式不同，當主來源(Binance)暫時限流、切到備援來源時，清單會誤把同一個幣當成新標的重複加入 → 排序被幽靈重複頂歪（漲跌幅高的卻卡在下面）。改用穩定的顯示名稱辨識，重複自動清除，排序恢復正確。"],
    ["2026-07-14", "🪟", "迷你圖價格修好了", "修正多圖分割的迷你圖「價格不會跳」：更新程式誤把已收盤的舊 K 棒也丟給圖表引擎（引擎只接受最新棒）、錯誤被靜默吞掉導致價格凍結。現在每 5 秒正常跳動、與最新成交一致。"],
    ["2026-07-14", "🎯", "畫的線平移不再漂", "修正「畫上去的線／框在平移主圖時會漂移、慢半拍追趕」：圖表引擎的舊事件只在可見 K 棒換了才通知（細微平移不會發）、加上重繪慢一幀，兩個根因都修掉——現在繪圖跟 K 棒同一幀逐像素貼緊（實測漂移 13.7px → 0.3px）。"],
    ["2026-07-14", "⚡", "打雷動畫大優化", "雷雨／暴風背景的閃電改「烤貼圖」：每道閃電的多層光暈與分支原本亮著的 1.5 秒內每一幀都要重算多次高斯模糊（背景最貴的瞬間），現在生成當下算一次、之後只貼圖淡出 → 打雷瞬間不再搶主圖效能，畫面完全不變。"],
    ["2026-07-14", "↩️", "繪圖有「返回鍵」了", "繪圖工具列（橡皮擦旁）新增復原鍵：畫錯、不小心拖歪、誤刪都可以一步步退回原狀（最多 50 步），鍵盤 Ctrl／⌘+Z 同樣有效。沒有可復原的操作時按鈕會轉灰。"],
    ["2026-07-14", "📌", "切標的不再跳走（記住縮放＋位置）", "切換標的時，主圖會保持你目前的縮放與平移到的時間位置——每個標的看到同一段時間，不再每切一次就被拉回最右邊。新標的歷史不夠早（例如新幣才上市半年）就自動貼到它的最早資料處、縮放照樣保持。順手修正「秒出圖」上線後偶發「切標的跳回最新 50 根」的問題。"],
    ["2026-07-14", "⏪", "重播復盤大修（縮放＋策略標記）", "① 重播中按「下一根」不再跳回預設縮放——你設定的縮放與位置全程保持，往回翻歷史時視角也不會被拉走；② 重播現在會顯示策略標記（多空／破多空／順多空），而且「逐根揭曉」——只顯示重播進度之前已成立的訊號、絕不劇透未來，拉到最後與正常模式完全一致。"],
    ["2026-07-14", "🖐️", "主圖平移不再被「劫持」", "修正「平移到歷史後畫面自己彈回、左側又冒出一條黃線」：成交量分佈的截止線原本整條直線都能被滑鼠抓到，靠近價格軸平移時會被誤判成拖曳截止線 → 現在只保留右上角的小把手可拖，平移拖曳完全不受影響。"],
    ["2026-07-14", "🪟", "新功能：多圖分割佈局（桌面）", "頂部工具列新增「分割」鈕：單圖 → 主圖＋1 迷你圖 → 主圖＋3 迷你圖 循環。迷你圖即時跳動（現價＋漲跌%、每 5 秒更新 K 棒）、有多空／破多空策略標記（與主圖同色同規則）、可各自切時框（15m/1H/4H/1D）；點迷你圖的標的名稱＝與主圖「交換」——主圖維持全功能（策略標記／繪圖／勝率），迷你圖走輕量模式不搶效能。佈局與清單會記住。"],
    ["2026-07-14", "📡", "斷網也能開、切標的也秒回", "「秒出圖」再升級：① 記住的標的從 1 個變成最近 5 個——切回最近看過的標的，先瞬間畫出上次的圖再背景更新（實測 0.02 秒）；② 完全斷網時重開 App 也進得去，照樣看得到最後一份圖（行情與勝率會待恢復連線後自動更新）。連線正常時一律拿最新網頁，絕不吃舊版。"],
    ["2026-07-14", "🧹", "縮小主圖更乾淨（週標籤／黃線）", "① 主圖縮得很小時，上方「週一～週日」標籤會擠成一坨 → 現在每天寬度不夠顯示一個標籤時整排自動收起（週框也同理，縮太小不再變成密集柵欄），拉近就恢復；② 修正「畫面左邊莫名一條黃色直線」——那是成交量分佈的截止線，原本錨在最後一根 K 棒，把圖往右滑留空白時會孤零零立在左側 → 改為未拖動時固定貼在右緣。"],
    ["2026-07-14", "⚡", "開 App 秒出圖（本機快照）", "打開網頁不再盯著空白圖等載入——上次看的標的會存一份在你的裝置裡（K 棒＋全部策略標記），開啟瞬間先畫出來（實測 0.2 秒），最新資料到了再無縫換上。網路慢、甚至暫時斷網也看得到最後一份圖。"],
    ["2026-07-14", "📲", "一鍵安裝到電腦／手機", "頂部工具列新增下載圖示（可安裝時才出現）、手機設定分頁新增「安裝 App」——點一下就把 AHH Trading 裝成獨立視窗＋桌面圖示，跟裝軟體一樣但免下載安裝包，更新永遠自動。iPhone／iPad 會顯示「分享→加入主畫面」指引。"],
    ["2026-07-14", "📉", "流量大瘦身（報價／勝率／載入）", "三刀合一：① 報價列改「差量更新」——每秒只傳有變動的標的（原本整包重傳），加密行情流量省約 8 成、台股盤外省 99%，報價照樣每秒跳；② 勝率結果沒變時（刷新、同根 K 棒內切回）伺服器直接回「沒變」，省掉整包 ~200KB 重傳；③ 首屏程式移除看不到的舊公告歷史。手機流量與電量最有感。"],
    ["2026-07-14", "🖱️", "十字線滑動再省一截", "滑鼠在主圖上移動時的三個隱形成本已消除：① 十字線鉛垂線原本每次移動都重新量測版面座標（強制瀏覽器重排）→ 改快取；② 價格／數值格式化改手寫千分位（比內建快約 60 倍、輸出完全相同）；③ 手機/桌面版型判斷不再重複建立查詢。畫面與數字完全不變，低階裝置與電池模式下滑動更省力。"],
    ["2026-07-14", "🐻", "小啊跳出來更順", "右下角小啊每 10 分鐘跳出來播天氣時，滑上滑下的動畫改走 GPU 合成（原本會逼瀏覽器每一幀重新排版，頁面忙碌時跳出來一頓一頓）——連同旁邊的天氣浮動卡一起改，動畫更滑、完全不搶主圖效能。外觀與行為不變。"],
    ["2026-07-13", "🚀", "新功能：加速器（預載自選）", "瀏覽器閒置時，悄悄把你自選清單的標的先算好放進伺服器快取——切到自選標的時從原本可能等 5～8 秒變成幾乎秒開。很省流量（只預熱不下載結果）、每 8 秒最多預熱一檔不搶效能。預設開啟，手機「設定」分頁可關。"],
    ["2026-07-13", "📱", "手機刷新留在原分頁", "手機版下拉刷新／重新開啟後，不再一律跳回主圖——會記住你上次停留的分頁（自選／訊號／交易／設定…），刷新後留在原地。"],
    ["2026-07-13", "🛰️", "雨帶移動推算大升級", "『雨會不會往你這來』的推算改用氣象標準做法：① 雨帶移動優先用雨量站快照位移，並新增兩道防呆（雨胞突然生成／消散造成的假移動、與連續兩段方向打架的雜訊都不再誤報）；② 推不出時改用 850hPa『引導氣流』（雲層高度的風）取代地面風——地面風受地形摩擦常偏弱偏轉（實測台北：地面 3.6km/h vs 雲層 9.6km/h、方向差 60°），用雲層的風推雨帶去向準得多。"],
    ["2026-07-13", "🌧️", "下雨反映更快", "開始下雨／雨停的顯示速度大幅改善：雨天時天氣改為快節奏更新（約 1.5～3 分內反映，原本最慢要 10 分鐘以上）。晴天維持原本節奏，不多耗電、也不多打氣象署 API。"],
    ["2026-07-13", "🌦️", "下雨預估看得更遠", "『附近的雨會不會往你這來』的偵測範圍從 20 公里擴大到 50 公里（顯示清單仍只講 20 公里內的雨）——雨帶還在遠處就能提前警示，預估到達時間最遠可報到約 45 分鐘前（原本上限 30 分）。"],
    ["2026-07-13", "☁️", "雲飄移跨裝置一致", "背景天氣的雲改成以真實時間計算飄移：手機或效能吃緊降幀時，雲不再變成慢動作、跟桌機速度一致；飄出畫面外的雲也不再白白耗效能。"],
    ["2026-07-13", "⚡", "切標的更順、勝率載入更快", "① 勝率標記載入原本會連續重建十幾次圖層，已合併成一次 → 切標的、勝率回來那瞬間的卡頓明顯下降，成交量重繪一併優化。② 伺服器升級（Python 3.12＋更快的資料序列化、回應瘦身）→ 已快取的標的勝率幾乎秒回、傳輸量更小。③ 順手修正：重播模式中成交量不再顯示未來的量。"],
    ["2026-07-13", "🎯", "多空・破多空止損線改版", "hover 到多／空／破多／破空箭頭時的止損線，改成『從標記往回推到連續反色 K 棒的波段極值』——做多＝回推到連續綠 K 的最低、做空＝連續紅 K 的最高，更貼近實際下單的結構止損。另外新增『止盈線』：往後第一根『成交量大於標記棒、且同方向』的確認棒收盤價（做多找紅棒、做空找綠棒）。"],
    ["2026-07-13", "🔀", "多空・破多空可切 proto／正常FVG", "主圖圖例列新增兩個獨立切換：『多空＝proto／正常FVG』與『破＝proto／正常FVG』。proto＝單根收盤突破前根高／低即成立（即時、當根定案）；正常FVG＝需三根 g+1 確認的標準失衡缺口（較保守、標記較少、勝率較高）。兩者可各自切換比較，會重算勝率。"],
    ["2026-07-13", "▭", "新增矩形框繪圖工具", "繪圖工具列新增『矩形框』：點兩個對角即可畫框，選取後拖角可自由調整大小，也能換色。"],
    ["2026-07-13", "🌀", "颱風離台灣太遠就不顯示", "天氣卡颱風資訊改為：颱風中心離台灣超過約 1500 公里、且沒有台灣陸上警報時就不再顯示，避免被離台灣很遠的西太平洋颱風洗版；有台灣警報時一律顯示。"],
    ["2026-07-13", "🌧️", "附近雨掃描半徑改 20km", "小啊的『附近雨區偵測』掃描半徑由 30 公里縮小為 20 公里 → 更貼近你所在地、少報遠處的雨。"],
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
