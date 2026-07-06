// 桌面版「更新公告」彈窗：進到圖表後彈一次，條列近期更新；按「不再顯示」→ 該裝置永久關閉。
//   - 手機版不顯示（isMobileUI）：公告是給電腦板看的。
//   - 封面/城門頁顯示中先不跳（避免與封面重疊）。
//
// ── 發布流程（重要）──────────────────────────────────────────────
//   平時：有新更新就「累積」寫進 UPDATES，但 **不要動 PUB_ID** → 已看過的人不會被重複打擾。
//   發布：使用者說「發公告」時，才把 PUB_ID 換成新值（並更新 PUB_DATE 顯示日期）
//         → 所有裝置的 localStorage 版本不符 → 全部重新跳一次這份最新公告。
//   （PUB_ID 是內部版本鍵、只管「要不要重跳」；PUB_DATE 是卡片右上顯示給人看的日期，兩者分開。）
(function () {
  const PUB_ID   = "2026-07-06-2";     // ⚠ 只有「發公告」時才 bump（換任意新字串即可）→ 觸發全裝置重跳
  const PUB_DATE = "2026-07-06";       // 卡片右上顯示的日期
  const KEY = "announceSeenVer";
  // 近三天累積更新（依分類）：[emoji, 標題, 說明]
  const UPDATES = [
    ["⚓", "錨定 VWAP（AVWAP）", "左側繪圖工具新增「錨定 VWAP」：點任一根 K 棒即從那根起算成交量加權均價，可同時放多條、可拖移錨點、換標的自動保留"],
    ["📊", "VWAP 指標開關", "新增 VWAP 成交量加權均價（每日錨定黃色折線）；右上工具列與手機設定頁都有獨立開關，可單獨開關、不必開整組教練層"],
    ["🔧", "多空門檻可切換比較", "圖例列新增「B≥」開關：一鍵循環 proto 缺口門檻 0.05→0.1→0.2→0.3%，即時比較「多／空・破多空」標記密度"],
    ["🐛", "修復不合理 FVG 缺口", "修正資料出現時間斷層時，會把跨數月/年的兩根 K 誤當相鄰、畫出 100%+ 超大假缺口的問題"],
    ["🇭🇰", "港股上線", "新增港股市場（市場鍵 Crypto→TW→US→HK）：K 線 ＋ 每分鐘即時報價；搜尋框可用名稱或代號搜（如 tencent、0700）"],
    ["📈", "股票跳空缺口 FVG", "台股／美股／港股新增「隔盤跳空」缺口標記（影線對影線）"],
    ["🧭", "方向策略整套升級", "多／空、破多／破空、順多／順空 全面改版（proto 缺口·收盤定緣·影線穿透）；主圖新增 ICT 折價／溢價區；逆勢弱信號自動淡化"],
    ["🎯", "SR＋SMC 教練大升級", "新增「可進場清單」（現價正在掛單區才列）、步驟 5 BOS 延續顯示、5m 短效版、掃描 1 分鐘級即時、對齊 TradingView 原版語意"],
    ["🎨", "視覺更新", "三組策略改賽博龐克霓虹配色；新增「大棒淡化」開關"],
    ["📱", "手機／iPad", "整頁下拉刷新；設定頁加勝率欄收合／成交量分佈／教練三開關；iPad 直屏＝手機版、橫屏＝電腦版"],
    ["🌦️", "小啊天氣", "改以各國官方氣象署為主（台 CWA／日 JMA／港 HKO），降雨機率就近取所在區"],
    ["⚡", "效能", "策略／FVG 計算加速約 70%；K 線中段斷開自動修復；往歷史滑自動補回策略標記"],
    ["🐛", "修復", "封面與農民曆重疊、切標的／捲歷史時策略標記重繪等多項修正"],
  ];

  function _seen()     { try { return localStorage.getItem(KEY) === PUB_ID; } catch (e) { return false; } }
  function _markSeen() { try { localStorage.setItem(KEY, PUB_ID); } catch (e) {} }

  function _injectStyle() {
    if (document.getElementById("announceStyle")) return;
    const st = document.createElement("style");
    st.id = "announceStyle";
    st.textContent = `
#announceOverlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(8,10,18,.58);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  animation:annFade .28s ease both}
@keyframes annFade{from{opacity:0}to{opacity:1}}
.ann-card{width:min(470px,93vw);max-height:88vh;display:flex;flex-direction:column;position:relative;overflow:hidden;
  padding:24px 24px 18px;font-family:inherit;background:linear-gradient(180deg,#232b3d,#1a2030);
  border:1px solid rgba(255,255,255,.10);border-radius:20px;box-shadow:0 26px 72px rgba(0,0,0,.55);
  animation:annPop .44s cubic-bezier(.22,1.2,.36,1) both}
@keyframes annPop{from{opacity:0;transform:translateY(20px) scale(.93)}to{opacity:1;transform:none}}
.ann-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,#ff8a3d,#ffc14d,#ff6a3d)}
.ann-head{display:flex;align-items:center;gap:11px;margin-bottom:16px;flex-shrink:0}
.ann-bear{width:40px;height:40px;border-radius:50%;object-fit:cover;padding:3px;
  background:radial-gradient(circle at 30% 30%,#ff9a4d,#ff6a3d);box-shadow:0 4px 15px rgba(255,106,61,.42)}
.ann-title{font-size:17px;font-weight:800;color:#fff;letter-spacing:.5px}
.ann-sub{font-size:11.5px;color:#93b0ff;margin-top:1px}
.ann-ver{margin-left:auto;align-self:flex-start;font-size:11px;color:#9aa4b2;
  background:rgba(255,255,255,.06);padding:3px 10px;border-radius:20px}
.ann-close{position:absolute;top:15px;right:15px;width:28px;height:28px;border-radius:50%;border:none;
  background:rgba(255,255,255,.06);color:#aab3c0;font-size:16px;line-height:1;cursor:pointer;display:flex;
  align-items:center;justify-content:center;transition:.18s;-webkit-tap-highlight-color:transparent;z-index:2}
.ann-close:hover{background:rgba(255,255,255,.15);color:#fff;transform:rotate(90deg)}
.ann-close:active{transform:rotate(90deg) scale(.88)}
.ann-list{list-style:none;padding:2px 4px 2px 0;margin:0 0 16px;overflow-y:auto;flex:1;min-height:0}
.ann-list::-webkit-scrollbar{width:7px}
.ann-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:4px}
.ann-item{display:flex;gap:11px;align-items:flex-start;padding:10px 12px;margin:7px 0;border-radius:13px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.05);
  transition:background .18s,border-color .18s,transform .18s;animation:annItem .5s ease both}
.ann-item:hover{background:rgba(255,138,61,.09);border-color:rgba(255,138,61,.22);transform:translateX(2px)}
@keyframes annItem{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
.ann-emoji{font-size:19px;line-height:1.3;flex-shrink:0}
.ann-name{font-size:13.5px;font-weight:700;color:#fff;margin-bottom:2px}
.ann-desc{font-size:12.5px;line-height:1.5;color:#c2cad6}
.ann-foot{display:flex;gap:10px;justify-content:flex-end;flex-shrink:0}
.ann-btn{padding:10px 20px;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer;
  -webkit-tap-highlight-color:transparent;user-select:none;
  transition:transform .12s ease,box-shadow .2s ease,background .2s ease,border-color .2s ease,color .2s ease}
.ann-btn:active{transform:translateY(1px) scale(.955)}
.ann-btn-ghost{background:transparent;border:1px solid rgba(255,255,255,.18);color:#c7cfdb}
.ann-btn-ghost:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.38);color:#fff}
.ann-btn-primary{border:none;color:#fff;background:linear-gradient(135deg,#ff9a4d,#ff6a3d);
  box-shadow:0 6px 18px rgba(255,106,61,.36)}
.ann-btn-primary:hover{transform:translateY(-1px);box-shadow:0 9px 26px rgba(255,106,61,.52)}
.ann-btn-primary:active{transform:translateY(1px) scale(.955);box-shadow:0 3px 10px rgba(255,106,61,.42)}`;
    document.head.appendChild(st);
  }

  function _build() {
    _injectStyle();
    const ov = document.createElement("div");
    ov.id = "announceOverlay";
    const items = UPDATES.map(([emo, name, desc], i) =>
      `<li class="ann-item" style="animation-delay:${0.1 + i * 0.05}s">` +
      `<span class="ann-emoji">${emo}</span>` +
      `<span><div class="ann-name">${name}</div><div class="ann-desc">${desc}</div></span></li>`
    ).join("");
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新公告">` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="/static/img/bear.png" alt="">` +
      `<div><div class="ann-title">更新公告</div><div class="ann-sub">What's New · 近三天</div></div>` +
      `<span class="ann-ver">${PUB_DATE}</span></div>` +
      `<ul class="ann-list">${items}</ul>` +
      `<div class="ann-foot">` +
      `<button class="ann-btn ann-btn-ghost" id="_annLater">知道了</button>` +
      `<button class="ann-btn ann-btn-primary" id="_annNever">不再顯示</button></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });                 // 點背景＝這次先關(下次還會跳)
    ov.querySelector("#_annX").addEventListener("click", close);
    ov.querySelector("#_annLater").addEventListener("click", close);                      // 知道了＝這次先關
    ov.querySelector("#_annNever").addEventListener("click", () => { _markSeen(); close(); });  // 不再顯示＝此裝置永久關
  }

  function _maybeShow(tries) {
    if (_seen()) return;
    if (typeof isMobileUI === "function" && isMobileUI()) return;                         // 手機版不顯示
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
