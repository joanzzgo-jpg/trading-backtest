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
  const PUB_ID   = "2026-08-11-2";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-08-11";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-08-11", "🎯", "不用再手動切市場了：打什麼標的，它自己判斷",
     "以前要先把左上切到對的市場，才能看那個市場的標的——切錯就是一片空白或「找不到」。現在打或點任何標的，系統會自己判斷它屬於哪個市場並切過去：EUR/USD 走外匯、2330 走台股、AAPL 走美股、0700.HK 走港股、BTC/USDT.P 走加密。\n\n左上那顆因此改成**純標示**（點不動了），只負責告訴你「現在在哪個市場」，會即時跟著標的變。想瀏覽某個市場的標的清單，用放大鏡的搜尋視窗，那裡各市場都有分頁。\n\n⚠ 判斷不出來的代號會**維持現狀不亂猜**——猜錯會把你丟到錯的市場、拿不到資料，那比「沒自動切」更糟。"],

    ["2026-08-11", "🏷", "資料來源標示終於是真的了（以前全寫 pionex）",
     "主圖上方標的列的來源標示，以前不管什麼市場都寫「pionex」——因為它讀的是一個只有單一選項的隱藏欄位，等於一個沒有意義的固定字串。\n\n現在標真實來源：加密會顯示實際供應這批 K 棒的交易所（Binance／Bybit／Pionex），外匯貨幣對顯示 Yahoo、黃金白銀顯示 Binance，台股美股港股維持中文標示。\n\n這個改動不只是好看：前陣子修「K 棒自己會動」時查出來，那些症狀的根源就是**資料默默降級到別家交易所**（兩家對同一根已收盤 K 棒差 4~15 點）。以後圖表若又怪怪的，看一眼這個標示就知道是不是降級了——以前它永遠寫 pionex，等於什麼都看不出來。"],

    ["2026-08-11", "🔧", "外匯點下去不再說「找不到」",
     "外匯剛上線時你點某些貨幣對會看到「找不到，請確認標的代號是否正確」——代號完全正確，是程式的問題。\n\n實際上有兩個獨立的原因，我第一次只修好其中一個，所以你會覺得「一樣找不到」：\n\n第一個：選取標的的分派邏輯少了外匯這條分支，於是選了 EUR/USD 卻被當成加密貨幣去查，當然查不到。這個是靠「在瀏覽器裡攔截實際送出的請求」才抓到的——先前我在伺服器端逐一測 21 個貨幣對全部通過，因為伺服器根本沒錯。\n\n第二個：快速連續切換標的時會撞到資料源的流量限制，而舊程式把任何失敗都講成「請確認代號正確」。現在會明確說「資料源限流中，請稍候幾秒」，並且暫停幾秒不再狂打（一直重試只會讓限制拖更久）。"],
    ["2026-08-11", "💱", "新增外匯市場：21 個貨幣對，黃金白銀還是即時的",
     "上方市場選單多了 FX。七大主要貨幣對（歐元、日圓、英鎊、瑞郎、澳幣、加幣、紐幣）＋十二組交叉盤＋黃金白銀，總共 21 個標的，K 線、繪圖、策略標記全部照舊可用。\n\n你問過「這個資料來源不是即時嗎」——這點對股票成立（那邊延遲 15~20 分，所以我們另外接了即時源疊價），但對外匯不成立：實測歐元、日圓、英鎊的最新一分鐘 K 棒只落後 **0.8 分鐘**，跟你看加密貨幣是同一個等級。\n\n唯一真的有延遲的是貴金屬（原本走期貨、慢 10 分鐘），後來照你的建議改走幣安的代幣化黃金白銀：延遲降到 **0.6 分鐘**，而且**有成交量**。順帶一提，兩邊價差約 1.4% 不是代幣折價——期貨對現貨本來就有升水，改用後反而更貼近真實的現貨金價。\n\n⚠ 一個要知道的限制：外匯**沒有成交量**。這不是資料源選錯，是外匯屬於店頭市場、根本不存在全市場成交量，任何來源都一樣。所以那 19 個貨幣對的量能圖會是空的（黃金白銀走幣安後才有量）。"],

    ["2026-08-11", "🖥", "螢幕小一點，上方那排按鈕不會再掉到第二行",
     "你回報「螢幕較小的人，右上那幾個按鈕會跑到左邊第二行」，還有「有時候會突然變兩行，明明還有空間」。追下去是兩件事。\n\n第一件：上方列本來就允許換行（勝率欄靠它獨立成第二列），所以第一列一塞不下，整組按鈕就從那裡斷開掉到下一行。第二件更陰險——「勝率前三名」那條資訊帶是**資料到貨才變寬**的，所以剛載入時看起來好好的，過幾秒才突然壞掉。\n\n現在時框列與按鈕都不再參與換行判斷，窄螢幕時那條資訊帶會自動收起，按鈕列則改成可以橫向滑動。⚠ 而且滑鼠滾輪也能滑了——第一版只做到「技術上可捲」，但滾輪預設不會橫向捲動，等於你實際上還是滑不動，那是我漏掉的。\n\n1920 到 1200 六個寬度全部驗過：單行、按鈕與時框永不重疊。1500px 以上時框會精準置中；以下讓位給「不重疊」，那是你指定的硬條件。"],

    ["2026-08-11", "↔️", "行情與交易兩欄都能收放了，主圖圖例也不再被擠扁",
     "右邊「行情」多了一列標題，跟「交易」同一套設計（圖示＋文字＋箭頭），點整列就收放。收起來會變成細長條、文字轉直書，所以按鈕永遠看得到、不會收了放不回來。兩欄互不影響。\n\n箭頭方向也照實際動作對齊：行情在左、收起時往左退，所以展開顯示◀；交易在最右、往右收，展開顯示▶。上方列原本那顆行情開關在桌面版已隱藏（手機版仍需要它）。\n\n另外主圖上方那排（BB、VOL、FVG、大時框FVG…共 14 個）以前螢幕一窄就被壓扁成一團，現在改成每個標籤維持原本寬度、放不下就整排橫向捲。"],

    ["2026-08-11", "🐻", "時框列的熊換成 AHH 的熊，點按鈕不再冒出圓圈",
     "熊圖示改用 AHH 品牌那隻熊的線稿——實際是從圖檔把輪廓與五官描出來的，所以形狀跟左上角 logo 完全一致，只是改用線條表現、顏色跟隔壁時框按鈕同一組（會跟著主題變）。\n\n（過程中我手繪了三版都不像熊，你說「太醜」「不像熊」都是對的：17 像素的線條圖靠細節畫不出動物辨識度，描真實輪廓才對得上。）\n\n還有你提到「點按鈕會出現圓形特效」——那其實是**兩套不同機制**疊在一起，所以我第一次修完你說「一樣有」：一個是按下去往按鈕裡塞一圈擴散動畫，另一個是在點擊位置灑天氣粒子。前者整個關掉了，後者改成只在圖表與空白處觸發，不會再蓋在按鈕上。"],
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
