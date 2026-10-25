// 「更新公告」彈窗：進到圖表後彈一次，條列近期更新；按「不再顯示」→ 該裝置永久關閉。
//   - 桌面與手機都會顯示（卡片 width:min(470px,93vw) 響應式、清單可捲動，手機不爆版）。
//   - 封面/城門頁顯示中先不跳（避免與封面重疊）。
//
// ── 發布流程（重要）──────────────────────────────────────────────
//   平時：有新更新就「累積」寫進 UPDATES（每條**帶當天日期**），但 **不要動 PUB_ID**
//         → 已看過的人不會被重複打擾。彈窗**顯示近 48 小時（PUB_DATE 前 48h＝今天＋昨天）**的項目（更舊留作歷史、不顯示）。
//   ★ 寫法（2026-09-26 使用者：「公告的撰寫需簡潔有力好懂」）：
//     標題一句話講**使用者看得到的結果**，不要寫我們做了什麼；內文最多 2~4 條，
//     每條一行講完；技術原因只在「能幫助理解」時留一句，數字挑最有感的一個就好。
//     ⚠ 別把 commit 訊息搬過來 —— 那是寫給開發者的。
//   發布：使用者說「發公告」時，才：① 把當天新增項目標上今天日期 ② 設 PUB_DATE＝今天
//         ③ 把 PUB_ID 換成新值 → 所有裝置版本不符 → 全部重跳，且只看到「近兩天」這批更新。
//   （PUB_ID 是內部版本鍵、只管「要不要重跳」；PUB_DATE 同時是卡片顯示日期＋「近 48h」過濾錨點。）
(function () {
  const PUB_ID   = "2026-10-25-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-10-25";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明, 分類標籤(選填)]
  //   分類標籤＝卡片右上角的小晶片：新功能／更快了／修好了／調整（沒寫就不顯示晶片）。
  //   說明的排版：空行分段；行首「・」會自動排成條列（自動縮排對齊，不會在第二行掉回行首）。
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-10-25", "📈", "台股看得到的歷史，從兩個月變成兩年",
     "1 小時與 4 小時以前只看得到 **57 天**，現在是 **728 天**（約兩年，1h 有 2413 根）。\n\n・5 分鐘 12 → 29 天、15 分鐘 36 → 57 天（一次載入 366 → 941 根）。\n・以前 1h/4h 是從 15 分鐘併出來的，被它的 60 天上限綁死；現在更舊的那段改用原生 1 小時接上去。\n・728 天是資料來源的硬牆（它的錯誤訊息自己寫明），不是我們設的。", "新功能"],

    ["2026-10-25", "🔙", "台股往回滑不再「補一次就停住」",
     "拉到最左邊會補一次歷史，然後**不管再拉幾次都沒反應**，而且完全不報錯。\n\n・我們算下限時用「你要的那一天」去推，但分鐘資料的可取範圍是相對**今天**滾動的 → 送出了來源根本搆不到的區間，它回「最近那一段」，一濾就全丟掉。\n・修好後同一檔從 46 天滑到 **57 天（到頂才停）**，1516 → 1986 根。", "修好了"],

    ["2026-10-25", "⚡", "台股報價刷新快一倍",
     "你正在看的那一檔、自選裡的台股、成交量前 50 名，從 **5 秒刷新一次變成 2.5 秒**。\n\n・**對上游的請求量一模一樣**（每秒 0.4 次）—— 只是把「一次問 1000 檔、間隔久」改成「一次問 500 檔、問得勤」。\n・以前清單價會比即時價慢 **6 秒**（只差一個檔位，但看起來就是兩個數字）；改完量不到落後樣本了。", "更快了"],

    ["2026-10-25", "🔢", "右方行情跟主圖的價格，終於印成同一個樣子",
     "台股實測 6 檔全中：主圖 **2,407.50**、右邊那列 **2,407.5**；4,185.00 / 4,185 —— 同一個數字兩種樣子，看起來像兩個價。\n\n・數值本來就是對的（連續取樣 70 秒，70/70 完全相同），差的只有小數位：主圖與報價列各自累積「看過最多幾位」，而兩邊吃的資料流不同。\n・現在那一列會跟著主圖的位數走（只限你正在看的那一檔）。", "修好了"],

    ["2026-10-25", "⇅", "上下顛倒：浮水印鋪滿整張圖，下面的指標也跟著倒，而且會記住",
     "・「上下顛倒中」改成**像小熊磁磚那樣的小字鋪滿全版**，墊在 K 棒下方，不擋線。\n・下面的 KDJ/RSI/MACD **以前不會跟著翻** —— 等於上半倒了、下半沒倒。\n・重新整理或關掉重開，**會記得你上次的狀態**（這是每台裝置自己的設定，手機跟電腦互不影響）。", "調整"],

    ["2026-10-25", "🗑", "一鍵清空這個標的的所有繪圖",
     "上方快捷繪圖列多一顆垃圾桶，清掉 A/B/C 三層的全部繪圖（含畫在副圖上的）。只清**這一檔**，不動其他標的。\n\n・**按一次會先轉紅等你確認，3.5 秒內再按一次才真的清** —— 繪圖弄丟救不回來。\n・清掉之後按 **V 可以救回來**。\n・位置就在「復原」鍵旁邊：清錯了，救命的那顆在手邊。", "新功能"],

    ["2026-10-25", "🎛", "上方的時框列重新設計",
     "那排 1m/5m/15m… 原本的凹陷軌道**只做了一半** —— 選中那顆的底色跟軌道幾乎一樣，凹槽裡等於空的，夾在 8 條飽和色帶之中反而最不顯眼。\n\n・現在選中的是一塊**真的浮起來的滑塊**；未選中的筆色帶變細變淡、兩端內縮，整列安靜下來。\n・按鈕圓角改成跟外框同心（外 8 − 內距 2 ＝ 內 4）。\n・極簡模式（白底）改成白滑塊＋深色字 —— 原本那個組合小字只有 2.9:1，讀不清。", "調整"],

    ["2026-10-25", "🌫", "天氣會跟著真實的天氣資料動了",
     "後端一直有給、但畫面從來沒用到的幾個欄位，現在都在驅動動畫：\n\n・**空氣品質／濕度／能見度 → 天空的霾**：髒空氣偏褐、潮濕偏乳白，乾淨的天就**完全不畫**（新德里 AQI 152 明顯偏暖，台北 AQI 48 看不出差別）。太陽月亮星星疊在霾後面，自然就偏紅變暗。\n・**鳥群與熱氣球吃真實的風**：順風飛得快、逆風慢；**風超過 22 km/h 就不放熱氣球**（真實的飛行限制）。\n・**飛機雲的長度看濕度**：乾空氣幾秒就散（158px），潮濕能拖成長雲（857px）。", "新功能"],

    ["2026-10-25", "☁️", "雲的輪廓與星星的閃爍更細緻",
     "・雲緣以前是**純反鋸齒的硬切**（過渡只有 1 像素）→ 讀起來像一團團硬邊泡泡。現在輪廓先成形再整體柔化（過渡 3~13 像素），並沿雲緣撒小團打斷完美圓弧＝絮狀邊。雲核的濃度沒有變淡。\n・星星以前是**單一正弦＋大小硬跳一階**，看到的是「啵」一下。現在兩個不同頻率疊加（永不同相，像真的大氣擾動），而且**低空的星星閃得更兇**（穿過的大氣比較厚）。半徑變化從只有 2 種變成 154 種。", "調整"],

    ["2026-10-25", "🖼", "移動 K 棒時，背景動畫不再降速",
     "拖曳主圖時天氣會明顯變頓。量出來**主圖本身一直是滿幀的（每幀 16.9ms）**，掉的只有天氣：更新間隔從停手的 50ms 掉到 **100ms** —— 那是程式裡刻意寫的「互動中降速」。\n\n・桌機已拿掉：現在**拖曳中跟停手一樣快**（100 → 50ms），而主圖一點沒變差。\n・順手把夜空行星的儀表烤成貼圖，那一項的成本降 **82%**。\n・手機維持原本的節奏 —— 那邊是電池考量，不是順不順的問題。", "更快了"],

    ["2026-10-25", "🩹", "週線最後一根的壞棒修好了",
     "港股與美股**本週那根週線**，資料來源給的「最低價」有時候比收盤價還高（實測 0700.HK 收 412、最低卻寫 415.8）—— 那是一根不可能存在的 K 棒，而畫面上完全看不出來。\n\n・K 棒錯了，上面所有 FVG／訊號就都無效 → 改在出口統一修掉（把最高最低撐開到涵蓋開收，四個價格一個都不丟）。\n・是**上游**的毛病（本週還沒走完的週線），不是我們算的。", "修好了"],

    ["2026-10-25", "🌙", "國外的夜晚不再被畫成白天",
     "台灣、香港、日本三地官方來源以前用的是**寫死的時鐘窗**（6 點到 19 點算白天）—— 在「夏天太晚天黑、冬天太早天黑」的地方一定錯，而且每天只有日出日沒前後那一段會現形。\n\n・實測東京當地 17:46（日沒 17:02 早就過了）畫面還是白天。\n・現在一律用**真正的日出日沒**。連帶入夜後的雲量也對了（原本用日照感測器推，天黑之後那個值沒有意義）。", "修好了"],

    ["2026-10-25", "📱", "手機兩個修正",
     "・**時框列會從 5 個跳到 4 個，而且再也回不到 5m** —— 那是一扇單向門（只能進設定改）。現在會把「你最近用過、但不在自選裡」的那個**黏著顯示**。\n・**圖表類型一直跳回線型圖**：電腦那台用線型、手機切成 K 線，下次開手機又被雲端蓋回去。現在圖表類型算「每台裝置自己的看法」，不再被蓋。", "修好了"],
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
/* 命中區撐到 44×44（Apple 下限）：外觀維持 26，偽元素伸出去 —— 它在卡片角落，沒有鄰居可搶。 */
.ann-close::after{content:"";position:absolute;inset:-10px}
.ann-close:hover{background:var(--bg3);color:var(--text)}
.ann-close:active{transform:scale(.9)}
.ann-head{display:flex;align-items:center;gap:10px;margin:0 34px 12px 0;flex-shrink:0}
.ann-bear{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;padding:2px;
  background:var(--bg3);border:1px solid var(--border)}
.ann-head-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.ann-title{font-size:15.5px;font-weight:800;color:var(--text);letter-spacing:.01em}
.ann-sub{font-size:11.5px;color:var(--muted)}
/* ⚠ 360px 的手機上，頭像(36)+標題+日期晶片+關閉鈕留白(34) 擠不下 → 標題會斷成「更新資/訊」。
   收一級字並禁止斷行；副標太長時以刪節號收尾（寧可少幾個字，不要把詞切開）。 */
@media (max-width:400px){
  .ann-head{gap:8px;margin-right:30px}
  .ann-bear{width:32px;height:32px}
  .ann-title{font-size:14px;white-space:nowrap}
  .ann-sub{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ann-ver{font-size:10px;padding:3px 8px}
}
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
