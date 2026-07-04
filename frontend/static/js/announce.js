// 桌面版「更新公告」彈窗：進到圖表後彈一次，條列近期更新；按「不再顯示」→ 該裝置永久關閉。
//   - 手機版不顯示（isMobileUI）：公告是給電腦板看的。
//   - 以 localStorage 記「已看過的版本」→ 日後改 VERSION 發新公告時，舊裝置會再自動跳一次。
//   - 封面/城門頁顯示中先不跳（避免與封面重疊，對齊農民曆卡的處理）。
//   - 設計：橘子熊頭像 + 頂部漸層條 + 卡片式條列(逐項滑入) + 按鈕 hover 浮起/按下回彈的觸覺回饋。
(function () {
  const VERSION = "2026-07-04";        // ⚠ 每次要發新公告就更新此字串 → 已看過舊版的裝置會再跳一次
  const KEY = "announceSeenVer";
  const UPDATES = [
    ["🇭🇰", "新增港股", "市場切換多了「HK」，可看港股 K 線 ＋ 即時報價（代號如 0700.HK、9988.HK）"],
    ["🔎", "港股搜尋", "代號搜尋框可用名稱或代號搜港股（例：tencent、0700）"],
    ["📈", "股票跳空缺口", "台股／美股／港股新增「隔盤跳空」FVG 缺口標記（影線對影線）"],
    ["⚡", "台股即時", "台股即時行情持續優化中"],
  ];

  function _seen()     { try { return localStorage.getItem(KEY) === VERSION; } catch (e) { return false; } }
  function _markSeen() { try { localStorage.setItem(KEY, VERSION); } catch (e) {} }

  function _injectStyle() {
    if (document.getElementById("announceStyle")) return;
    const st = document.createElement("style");
    st.id = "announceStyle";
    st.textContent = `
#announceOverlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;
  padding:20px;background:rgba(8,10,18,.58);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  animation:annFade .28s ease both}
@keyframes annFade{from{opacity:0}to{opacity:1}}
.ann-card{width:min(460px,92vw);position:relative;overflow:hidden;padding:26px 26px 20px;font-family:inherit;
  background:linear-gradient(180deg,#232b3d,#1a2030);border:1px solid rgba(255,255,255,.10);border-radius:20px;
  box-shadow:0 26px 72px rgba(0,0,0,.55);animation:annPop .44s cubic-bezier(.22,1.2,.36,1) both}
@keyframes annPop{from{opacity:0;transform:translateY(20px) scale(.93)}to{opacity:1;transform:none}}
.ann-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,#ff8a3d,#ffc14d,#ff6a3d)}
.ann-head{display:flex;align-items:center;gap:11px;margin-bottom:18px}
.ann-bear{width:40px;height:40px;border-radius:50%;object-fit:cover;background:radial-gradient(circle at 30% 30%,#ff9a4d,#ff6a3d);
  box-shadow:0 4px 15px rgba(255,106,61,.42);padding:3px}
.ann-title{font-size:17px;font-weight:800;color:#fff;letter-spacing:.5px}
.ann-sub{font-size:11.5px;color:#93b0ff;margin-top:1px}
.ann-ver{margin-left:auto;align-self:flex-start;font-size:11px;color:#9aa4b2;
  background:rgba(255,255,255,.06);padding:3px 10px;border-radius:20px}
.ann-close{position:absolute;top:15px;right:15px;width:28px;height:28px;border-radius:50%;border:none;
  background:rgba(255,255,255,.06);color:#aab3c0;font-size:16px;line-height:1;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:.18s;-webkit-tap-highlight-color:transparent}
.ann-close:hover{background:rgba(255,255,255,.15);color:#fff;transform:rotate(90deg)}
.ann-close:active{transform:rotate(90deg) scale(.88)}
.ann-list{list-style:none;padding:0;margin:0 0 20px}
.ann-item{display:flex;gap:11px;align-items:flex-start;padding:11px 13px;margin:8px 0;border-radius:13px;
  background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.05);
  transition:background .18s,border-color .18s,transform .18s;animation:annItem .5s ease both}
.ann-item:hover{background:rgba(255,138,61,.09);border-color:rgba(255,138,61,.22);transform:translateX(2px)}
@keyframes annItem{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
.ann-emoji{font-size:19px;line-height:1.35;flex-shrink:0}
.ann-txt{min-width:0}
.ann-name{font-size:13.5px;font-weight:700;color:#fff;margin-bottom:2px}
.ann-desc{font-size:12.5px;line-height:1.5;color:#c2cad6}
.ann-foot{display:flex;gap:10px;justify-content:flex-end}
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
      `<li class="ann-item" style="animation-delay:${0.12 + i * 0.07}s">` +
      `<span class="ann-emoji">${emo}</span>` +
      `<span class="ann-txt"><div class="ann-name">${name}</div><div class="ann-desc">${desc}</div></span></li>`
    ).join("");
    ov.innerHTML =
      `<div class="ann-card" role="dialog" aria-label="更新公告">` +
      `<button class="ann-close" id="_annX" aria-label="關閉">×</button>` +
      `<div class="ann-head">` +
      `<img class="ann-bear" src="/static/img/bear.png" alt="">` +
      `<div><div class="ann-title">更新公告</div><div class="ann-sub">What's New</div></div>` +
      `<span class="ann-ver">${VERSION}</span></div>` +
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
