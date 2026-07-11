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
  const PUB_ID   = "2026-07-11-3";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-11";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   舊日期項目保留為歷史紀錄、平時不顯示（PUB_DATE 找不到當日項目時才退回顯示最新一天）。
  const UPDATES = [
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
