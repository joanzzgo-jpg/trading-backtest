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
  const PUB_ID   = "2026-08-10-1";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-08-10";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 累積更新（依日期）：[日期 YYYY-MM-DD, emoji, 標題, 說明]
  //   彈窗只顯示「當日（＝PUB_DATE）」的項目（發公告時把當天新增項目標上今天日期即可）。
  //   ⚠ 舊條目使用者永遠看不到、卻整包跟著首屏 bundle 下載 → 發公告時順手把「超過 ~3 天」
  //     的舊條目移到 docs/announce-history.md 歸檔（此檔只留近幾天 + 至少一天的退路項目）。
  const UPDATES = [
    ["2026-08-10", "💱", "主圖和合約行情終於是同一個數字了（差 28 點的元兇找到了）",
     "你說「主圖跟合約行情數值有時候對不上」。這次不是延遲、也不是誰凍住——**主圖拿到的是現貨資料**。\n\n同一時間把五個來源排開比就一目了然：我們的主圖顯示 64980.26，Binance 現貨是 64980.25（一模一樣），而永續合約各家都是 64952~64953。差 28 點。原因是前端送出的交易所參數讓永續走不進「永續專用」那條資料鏈，落到一般路徑後，第一步抓永續是對的，但一失敗第二步就退去抓現貨了。最惡毒的地方是**完全不報錯**——圖上有 K 棒、時間也對，只是那是另一個商品；而且現貨的棒混進永續序列，還會生出假的缺口訊號、錯的收盤價。\n\n現在永續一律只走永續來源，寧可回報錯誤也不給現貨。修後連續 12 次取樣，主圖與合約行情最大差 0.10（修前 28~33）。"],

    ["2026-08-10", "📊", "最新 K 棒不會再自己動，也不會出現「不可能的 K 棒」",
     "「修好主圖最新 K 棒還是會動」——這次用程式盯著資料逐欄比對，量出來 180 秒內**已經定案的棒被改寫 38 次**，幅度 4~15 點，連形成中那根的開盤價都在變。\n\n真兇是資料來源在 Binance 和 Bybit 之間反覆跳。兩家對同一根已收盤 K 棒的數值差幾點，而系統為了不留接縫，換來源時會重寫尾端幾根——跳一次、畫面就動一次。最直接的證據是檢查程式傾印出一根「最低價比開盤價還高」的 K 棒，那在數學上不可能存在，只可能是兩份不同來源的資料被縫在同一根上。\n\n修了四個地方：來源短時間內釘住不換、來源標記跟著資料本身走、補正一律「整根換或整根不動」而且只在新資料真的涵蓋舊資料時才補、以及要連續兩次確認才認定換手。實測：定案棒被改寫 38 次 → **0 次**，不可能的 K 棒 → **0 根**，形成中那根的開盤價變動 → **0 次**。剩下會動的只有「形成中那根的最高最低收盤」和「剛收盤那根補最終值」，那兩個本來就該動。"],

    ["2026-08-10", "🧹", "切換時間級別不會再冒出一堆線條",
     "你回報「切時框會出現很多線條」。原因是切換時，畫面為了避免「標記突然消失」會把上一次的策略圖層重畫回來——但那份暫存在切換當下裝的還是**上一個時間級別**的資料。\n\n標記類的看不出來，因為它們有過濾機制（時間對不上當下 K 棒就不畫）。但 FVG 每一筆的止損／止盈**線**沒有這層過濾，是直接按時間座標畫下去——大時間級別的進場時間在小級別上找得到位置，於是上百條紅綠虛線一次全冒出來。\n\n現在只要標的或時間級別一變，就先把這些暫存清空，寧可空白幾百毫秒等新資料，也不畫別的級別的東西。"],

    ["2026-08-10", "🇹🇼", "台股日 K 最新那根不會再被畫成大陰線",
     "你說「台股日 K 最新顯示有 bug、會變成像下大 K 棒」。抓到了：當交易所的即時介面回報「目前沒有最新成交價」時，舊程式直接拿**最佳委買價**當現價。委買永遠低於委賣，所以當日 K 的收盤被系統性壓低，畫出來就是陰線。\n\n而且這個狀況不是一瞬間——實測台積電在盤中連續一分多鐘都沒有最新成交價。現場數據：買 2380／賣 2385、當天開盤 2390，主圖收在 2380 畫成大陰線，同一時間右邊報價列卻顯示 2385。\n\n其實系統本來就有一套為報價列寫的估價規則（處理漲跌停鎖死、只有單邊掛單、用當日高低取落在買賣區間內的那一個等七種情況），但圖表這條路沒用它、自己猜了一套。現在兩邊統一。另外也加了保險：估出來的收盤若落在當日高低之外，會自動撐開高低，不會畫出自相矛盾的 K 棒。"],

    ["2026-08-10", "📈", "RSI 的 30／50／70 線可以自己選線型了",
     "RSI 設定（齒輪）的「超買」那一列多了一顆線型按鈕，點一下循環：實線 → 點線 → 虛線 → 長虛線，三條水平線一起套用。預設維持原本的點線，不會突然變樣，選擇也會跟著帳號同步到其他裝置。\n\n同時把圖例上那三個「30 50 70」拿掉了（你說沒啥用）——現在 RSI 圖例只剩 RSI 14 和 RSI 7，顏色、位置、線寬、線型全部從齒輪調。"],

    ["2026-08-10", "🔧", "拿掉 2 小時與 30 分鐘兩個時間級別",
     "時間級別列、手機版級別列、訊號通知與自動交易的級別清單全部移除。如果你之前停在這兩個級別，或收到別人分享的連結指向它們，會自動退回預設級別，不會卡住。"],

    ["2026-08-10", "⚡", "圖表資料變穩定的真正原因（背景做的事）",
     "上面幾條的共同上游其實是同一件事：我們對交易所的請求額度被吃光了。加了用量監測才看到——永續那條額度被用到 100%，於是系統自我保護擋掉所有請求，主圖和報價只好全部降級到備援交易所，接著就是 K 棒抖動、數字對不上。\n\n裡面疊了四個問題，其中最惡毒的是「自己把自己鎖在門外」：用量一超標就不再送出請求，但不送請求就收不到交易所回報的最新用量，計數器於是凍在高點，硬生生鎖死 70 秒。另外背景的掃描工作和你當下在看的圖表在搶同一份額度，而且沒有優先權概念。\n\n現在背景工作有較低的用量上限、永遠留一半給你正在看的畫面。實測用量中位數從 95% 降到 42%，資料來源留在主要交易所的比例從 17% 提升到 **100%**——主圖不再換源，前面那些症狀也就沒有源頭了。"],
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
