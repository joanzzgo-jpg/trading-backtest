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
  const PUB_ID   = "2026-07-13-2";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-13";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   舊日期項目保留為歷史紀錄、平時不顯示（PUB_DATE 找不到當日項目時才退回顯示最新一天）。
  const UPDATES = [
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
    ["2026-07-12", "🎨", "繪圖色盤修好", "修正繪圖工具『雙擊／右鍵改色時色盤打不開、不能變色』的問題（載入時序造成色盤函式被蓋掉）。現在畫線、畫框後雙擊或右鍵即可正常換色、改粗細。"],
    ["2026-07-12", "▦", "主圖週框可開關", "主圖『週框』（把每週一～五框起來）新增獨立開關：頂部工具列與手機設定分頁都可切換，與星期標籤、交易時段色塊互不影響。"],
    ["2026-07-12", "🖱️", "主圖縮放／平移更順", "又做了一輪主圖流暢度優化：① K 棒在預設配色下原本邊框與實體同色、卻被畫兩次 → 改成同色時跳過邊框，K 棒填色近乎砍半（放大看盤時最有感、畫面完全不變）；② 縮放時策略文字改為隨縮放平滑連續縮放（不再一格一格跳）；③ 平移／縮放中大面積的交易時段色塊、折價溢價區暫時只留輪廓線，停手即補回。整體滑動與縮放更順，尤其 MacBook 等高解析度螢幕。"],
    ["2026-07-12", "⚡", "合約報價每秒即時跳動", "合約行情改用即時串流維護報價，每秒更新、權重更省；期貨（部分地區串流被交易所限制時）自動改用每秒即時價補上，報價不再卡住。淡盤時數字 2～3 秒才變是「當下真的沒有新成交」的正常現象，市場活絡時就會每秒跳。"],
    ["2026-07-12", "🌀", "颱風警報「解除」顯示修正", "先前颱風警報『解除』時，天氣卡會因為文字含「颱風」而誤顯示成仍有警報。已修正 → 警報解除後正確顯示為「暫無陸上警報」；多筆警報（海上＋海上陸上）也會正確彙整地區。另外非台灣的使用者看西太平洋颱風時，不再顯示對他們無意義的「台灣暫無警報」那行。"],
    ["2026-07-12", "🐻", "小啊天氣報告更精簡", "小啊的附近雨區報告排版潤飾：把『覆蓋率』與『下雨的區』併成同一行（不再連兩行都是 🌧️）、接近中的雨句子也更精簡，一眼看完。"],
    ["2026-07-12", "⚡", "策略計算再加速", "勝率與策略標記(FVG 缺口偵測等)的深歷史計算做了向量化優化 → 切標的、切時框時策略標記算得更快，背景預熱也更省。計算結果完全不變（已逐案做位元級驗證，含缺棒邊界情況）。"],
    ["2026-07-12", "⚡", "切標的・載入再加速＋精簡", "副圖指標(KDJ／RSI／MACD)預設是隱藏的——現在隱藏時，切標的／切時框就不再多算、也不再多傳這些資料 → 載入更快、更省流量；後端勝率計算一併精簡。另外清掉了一批已不再使用的舊程式碼，整體更輕更穩。（若你手動打開副圖指標，第一次會重新載入一次把資料補上，屬正常）"],
    ["2026-07-12", "🌧️", "深夜降雨機率修正", "台灣接近午夜時，天氣卡的『此刻降雨機率』偶爾會跳出像 47% 這種怪數字（其實是中央氣象署當下沒有『今日』時段資料、退回了備援來源）。已修正為改用氣象署最近一個時段的官方值 → 深夜也維持整十階的官方降雨機率。"],
    ["2026-07-11", "⚠️", "颱風警報顯示修正", "天氣資訊卡的颱風警報先前因資料格式抓錯、一律顯示「暫無警報」；已修正 → 現在會正確顯示中央氣象署發布的『海上／陸上颱風警報』。背景仍維持照你所在地的真實天氣顯示（不會因為附近有颱風就硬把畫面轉成雷雨）。"],
    ["2026-07-11", "🌧️", "暴風雨勢跟著風斜＋主圖平移優化", "① 暴風／雷雨的雨改成隨風速明顯傾斜（原本風大也近乎直落），並補滿上風側角落；② 主圖平移／縮放再做一輪省負擔（策略文字改快取貼圖、折價溢價區掃描快取、疊加層移動中降載）——低階裝置較有感。"],
    ["2026-07-11", "🌀", "颱風資訊", "有颱風接近時，天氣資訊卡會顯示：颱風名稱／編號、在你哪個方向多遠、往哪移動、台灣有無陸上颱風警報、近中心風速（資料來自日本氣象廳 JMA 全球颱風＋中央氣象署 CWA 台灣警報）。背景一律照你所在地的真實天氣顯示。"],
    ["2026-07-11", "🟦", "FVG 平移更順＋背景不降速", "拖動主圖時，FVG 缺口色塊照樣跟著 K 棒顯示，但會暫時省略『寬度%數字』與『黃色進場菱形』(canvas 文字/圖形是平移時最吃效能的)，放手後自動補回——方框不會消失，這是刻意的、不是 bug。另外桌機平移時背景天氣不再降速(維持順暢)，靠的是這幾波把主圖每幀成本壓低後騰出的餘裕"],
    ["2026-07-11", "🖱️", "主圖平移再更順(第二波)", "續前一波，再修掉幾個平移時每幀重算的熱點：①折價/溢價區(ICT)原本每幀對全部 K 棒重掃結構→改成掃描結果快取、平移時只重畫不重算；②十字線鉛垂線改『先讀後寫』減少版面強制重排；③背景天氣流動光暈烤成 sprite 免每幀重建漸層。畫面與數字完全不變，開著折價/溢價區時最有感"],
    ["2026-07-11", "✅", "教練掃描改收盤確認", "教練「可進場」掃描清單原本連未收盤那根的影線也算，常常掃到 stage 5、點進去卻退回第 3 步。已改為只認『已收盤棒』——收盤確認 stage 真的到 5(BOS 完成)才列出，點進去不會再退階。代價：最多晚半根棒(15m/5m)才出現在清單、清單步數比即時面板保守一階"],
    ["2026-07-11", "🖱️", "主圖滑動更順", "修正主圖左右滑動一頓一頓的問題：FVG 缺口色塊與逐筆止損／止盈線原本每一幀都會把『全部』缺口重畫一遍（含畫面外看不到的），缺口一多就卡。已改為只重畫螢幕上看得到的那幾個 → 平移更順，缺口多、歷史長時最有感。標記位置與外觀完全不變"],
    ["2026-07-11", "🎯", "破多／破空標記修正", "破多／破空的判定改為貼合實際策略：以「最近一道確認 FVG 牆」被 K 棒影線穿破牆頂／底、隨即出現同向 proto 那根為準（只認最近一道牆、不再標到很久以前的舊牆）。原本標記位置會跑掉的問題已修正，圖上破多／破空會標在對的位置"],
    ["2026-07-11", "⚡", "切標的・切時框更快", "初次載入只抓「填滿畫面所需」的 K 棒先秒出圖，更深的歷史在背景自動補上 → 切標的、切時框反應更快（不只第一次）。可看的深度與策略標記完全不變"],
    ["2026-07-11", "🚀", "開啟更快（第二波）", "首屏再瘦身：樣式檔壓縮（傳輸量少一半）、把「繪圖工具・自動交易面板」等首次用不到的程式移出首屏改閒置後載入、其餘閒置載入的動畫程式也一併壓縮 → 開啟／進場更快，手機與較慢網路最有感"],
    ["2026-07-11", "🌧️", "斜雨補滿畫面角落", "起風把雨吹斜時，原本上風側的角落（往右吹時的左下角）會沒有雨、背景沒佔滿 → 已修正為斜雨完整覆蓋整個畫面，並隨風速維持雨量密度"],
    ["2026-07-11", "🇭🇰", "港股搜尋修好、可用中文搜", "港股搜尋原本打中文名（騰訊／美團／匯豐／京東…）一律查無、只能打數字或英文。已改用新的搜尋來源：中文名、英文、代號都搜得到，且代號統一為港交所標準 5 碼（如 商湯＝00020、騰訊＝00700）"],
    ["2026-07-11", "⚡", "搜尋整體變快", "台股與港股搜尋大幅加速：台股清單原本每次搜尋都重抓一整包、港股每次多繞一次較慢的來源 → 已改為就近快取／只在必要時才查備援，打字搜尋從『要等 ~1 秒』降到幾乎即時"],
    ["2026-07-11", "⚡", "切標的策略標記更快", "切標的／時框後，多空・破多空等策略標記從『要等幾秒』改成『幾乎秒出』——低時框(5m~1h)初始只算近段(如 1h 約近 2 年)先把標記畫出來；往歷史滑回時再自動把更舊的標記補上。4h/1d 維持一次全畫。勝率統計樣本仍充足、數字不受影響"],
    ["2026-07-11", "🌧️", "下雨更順、雨勢跟著風", "① 下雨時的卡頓大幅改善（移除雨滴陰影模糊、雨滴改批次繪製；雨量與樣子不變）；② 雨絲會隨風速明顯傾斜、雲也跟著風速快慢飄動——不再『雨吹得急、雲卻慢吞吞』"],
    ["2026-07-11", "🚀", "開啟更快", "精簡了字型設定檔（570KB→5KB，移除大量用不到的線上字型）、並讓圖表庫不再擋住首屏 → 開啟／進場更快，尤其手機與較慢的網路"],
    ["2026-07-10", "🕯️", "修正部分合約 K 線收盤/假訊號", "少數情況下（主源 Binance 短暫限流、改用備援時），部分合約日 K 會出現『收盤價怪怪的／某根憑空多出一段大缺口 FVG』——原因是某個備援資料源的少數 K 棒不完整。已改為備援優先使用 Bybit（實測與 Binance 幾乎一致），並確保這類暫時資料不會被長期快取 → K 線與策略標記維持正確，冷卻結束會自動換回主源"],
    ["2026-07-10", "🔎", "修「有些合約標的找不到」", "合約行情有些幣（如 KORU）點下去顯示『找不到』——那些是 Binance 獨有、Pionex 沒有的幣，遇到 Binance 限流就兩邊落空。已加 Bybit 備援，抓不到時自動改由 Bybit 補上，不再找不到"],
    ["2026-07-10", "⌨️", "合約行情上下鍵修正", "用 ↑↓ 選標的的兩個問題：① 按到清單底不再『繞回第一個』，改成自動載下一批續選；② 按一下停頓看盤再按時，清單不再在腳下依漲跌幅重排（凍結拉長到 2 分鐘）→ 不會突然捲回頂或跳到很遠的標的"],
    ["2026-07-10", "🔧", "修正部分裝置進不去", "修正 iPad、部分 Windows／電腦『打不開、白畫面、進不去』的問題（原因是圖表庫與字型走外部 CDN，某些網路連不到就整個卡住）。已全部改為自架、同源載入 → 只要連得到網站就一定進得去"],
    ["2026-07-10", "📌", "策略標記當根定案、不再消失", "方向多空・破多空改為『K 棒收盤那根就定案』，之後不會再被下一根收盤回頭撤掉（修正先前『已出現的標記過一陣子又消失』的困擾）。代價：破多空標記會比之前多一些"],
    ["2026-07-10", "🇹🇼", "台股即時大升級", "① 盤中即時 K 改用連續資料源（同台指期），不再『10:10 直接跳 10:30』的斷層；② 報價列熱門／高量股每幾秒即時跳動、顯示今日即時價（原本顯示前一日收盤）"],
    ["2026-07-09", "🔮", "未收盤就看得到策略", "最新一根還沒收盤時，就先用『半透明空心＋?』標出暫定的多/空・破多空・順多空；收盤確認後才轉成正式實心標記。暫定標記會隨價格跳動而出現/消失/翻多空，屬正常（提早看趨勢用，進場仍以收盤確認為準）"],
    ["2026-07-09", "🇹🇼", "台股即時K更完整", "台股盤中『正在形成』那根不再只顯示現價一條線——開盤價沿用前一根收盤，價格一動當下就有實體與上下影線，看盤更貼近真實"],
    ["2026-07-09", "⚡", "手機更順不卡", "行情列改為漸進載入（先出前 120 檔、往下捲自動補下一批），大幅減少記憶體與每秒重繪負擔 → 滑動、切分頁、報價更新都更順，整體卡頓明顯下降"],
    ["2026-07-08", "🏹", "繪圖工具升級", "左側繪圖列新增「箭頭」與「emoji 貼圖」：emoji 有分類選擇器（笑臉／動物／食物／符號／旗幟…＋最近使用），放上後選取可拖右下角把手縮放；箭頭可改色／刪除"],
    ["2026-07-08", "📐", "繪圖不再跑掉＋滑動更順", "修正切換時間框後繪圖線偏離原價位、切大時框線消失、線變無限長橫跨畫面等問題；並修好加了繪圖後左右滑動變卡的問題，滑動恢復順暢"],
    ["2026-07-08", "🧹", "主圖精簡＋更快更穩", "移除已無實測優勢的舊 CRT 訊號與 KDJ/共振/ATR/回測標記，主圖只留 FVG 與 SS 軌道反轉；勝率計算與深歷史抓取加速、切回舊標的更順；後端效能與安全性一併強化"],
    ["2026-07-08", "🚪", "新增訪客登入", "封面大門點開後多一顆「訪客登入 · 先逛逛」，免帳號直接進場試用（設定只存本機、不跨裝置同步；通知與自動交易仍需登入帳號）。重開瀏覽器會回封面，隨時可改用帳號登入"],
    ["2026-07-07", "🇹🇼", "台指期上線", "台股市場最上排新增台指期三兄弟（大台 TXF／小台 MXF／微台 TMF 近月）：即時報價（含夜盤）＋全時框 K 線圖，點報價牆置頂那排即可看盤"],
    ["2026-07-07", "🔻", "假設順空開關", "圖例列新增「假設順空」：開啟後『順空』標記那根必須本身是 bear proto 缺口（收盤破前根低點）才算 → 做空假設下更嚴格的順空篩選（順多不受影響）"],
    ["2026-07-07", "📶", "台股即時更順", "台股改伺服器端持續累積分鐘 K：切到別的標的再切回來，中間不再出現一段空白斷層"],
    ["2026-07-07", "🌦️", "小啊天氣", "改以各國官方氣象署為主（台 CWA／日 JMA／港 HKO），降雨機率就近取所在區；新增『附近雨區偵測』（騎車避雨用）"],
    ["2026-07-06", "📊", "VWAP 修正＋可調", "修正周／日／月線 VWAP 錨定退化（改年度錨定、不再貼著 K 棒跳）；VWAP 折線粗細（1–5）與顏色皆可調；計算向量化加速 5×"],
    ["2026-07-06", "📉", "布林通道精簡", "布林通道移除 ±1σ 內帶、只留主帶，主圖更乾淨"],
    ["2026-07-06", "📐", "ATR 停損帶", "右上新增「ATR 停損帶」開關：主圖疊 close ± 2×ATR(14) 上下停損帶（上紅=空單停損、下綠=多單停損），一眼看波動與停損距離"],
    ["2026-07-06", "⚓", "錨定 VWAP（AVWAP）", "左側繪圖工具新增「錨定 VWAP」：點任一根 K 棒即從那根起算成交量加權均價，可同時放多條、可拖移錨點、換標的自動保留"],
    ["2026-07-06", "📊", "VWAP 指標開關", "新增 VWAP 成交量加權均價（每日錨定黃色折線）；右上工具列與手機設定頁都有獨立開關，可單獨開關、不必開整組教練層"],
    ["2026-07-06", "🔧", "多空門檻可切換比較", "圖例列新增「B≥」開關：一鍵循環 proto 缺口門檻 0.05→0.1→0.2→0.3%，即時比較「多／空・破多空」標記密度"],
    ["2026-07-06", "🐛", "修復不合理 FVG 缺口", "修正資料出現時間斷層時，會把跨數月/年的兩根 K 誤當相鄰、畫出 100%+ 超大假缺口的問題"],
    ["2026-07-04", "📈", "股票跳空缺口 FVG", "台股／美股／港股新增「隔盤跳空」缺口標記（影線對影線）"],
    ["2026-07-02", "🇭🇰", "港股上線", "新增港股市場（市場鍵 Crypto→TW→US→HK）：K 線 ＋ 每分鐘即時報價；搜尋框可用名稱或代號搜（如 tencent、0700）"],
    ["2026-07-02", "🧭", "方向策略整套升級", "多／空、破多／破空、順多／順空 全面改版（proto 缺口·收盤定緣·影線穿透）；主圖新增 ICT 折價／溢價區；逆勢弱信號自動淡化"],
    ["2026-07-01", "🎯", "SR＋SMC 教練大升級", "新增「可進場清單」（現價正在掛單區才列）、步驟 5 BOS 延續顯示、5m 短效版、掃描 1 分鐘級即時、對齊 TradingView 原版語意"],
    ["2026-07-01", "🎨", "視覺更新", "三組策略改賽博龐克霓虹配色；新增「大棒淡化」開關"],
    ["2026-07-01", "📱", "手機／iPad", "整頁下拉刷新；設定頁加勝率欄收合／成交量分佈／教練三開關；iPad 直屏＝手機版、橫屏＝電腦版"],
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
