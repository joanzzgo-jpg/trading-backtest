// 桌面版「更新公告」彈窗：進到圖表後彈一次，條列近期更新；按「不再顯示」→ 該裝置永久關閉。
//   - 手機版不顯示（isMobileUI）：公告是給電腦板看的。
//   - 以 localStorage 記「已看過的版本」→ 日後改 VERSION 發新公告時，舊裝置會再自動跳一次。
//   - 封面/城門頁顯示中先不跳（避免與封面重疊，對齊農民曆卡的處理）。
(function () {
  const VERSION = "2026-07-04";        // ⚠ 每次要發新公告就更新此字串 → 已看過舊版的裝置會再跳一次
  const KEY = "announceSeenVer";
  const UPDATES = [
    "🇭🇰 新增港股：市場切換多了「HK」，可看港股 K 線 ＋ 即時報價（代號如 0700.HK、9988.HK）",
    "🔎 港股搜尋：代號搜尋框可用名稱或代號搜港股（例：tencent、0700）",
    "📈 股票跳空缺口：台股／美股／港股新增「隔盤跳空」FVG 缺口標記（影線對影線）",
    "⚡ 台股即時行情持續優化中",
  ];

  function _seen()     { try { return localStorage.getItem(KEY) === VERSION; } catch (e) { return false; } }
  function _markSeen() { try { localStorage.setItem(KEY, VERSION); } catch (e) {} }

  function _build() {
    const ov = document.createElement("div");
    ov.id = "announceOverlay";
    ov.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px)";
    const items = UPDATES.map(t =>
      `<li style="margin:9px 0;line-height:1.55;color:#d8dee9;font-size:14px">${t}</li>`).join("");
    ov.innerHTML =
      `<div style="width:min(460px,92vw);background:#1c2230;border:1px solid rgba(255,255,255,.12);` +
      `border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);padding:22px 24px;font-family:inherit">` +
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">` +
      `<span style="font-size:20px">📢</span>` +
      `<span style="font-size:17px;font-weight:700;color:#fff">更新公告</span>` +
      `<span style="margin-left:auto;font-size:12px;color:#8a95a5">${VERSION}</span></div>` +
      `<ul style="list-style:none;padding:0;margin:0 0 18px">${items}</ul>` +
      `<div style="display:flex;gap:10px;justify-content:flex-end">` +
      `<button id="_annLater" style="padding:8px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.18);` +
      `background:transparent;color:#c7cfdb;cursor:pointer;font-size:13px">知道了</button>` +
      `<button id="_annNever" style="padding:8px 16px;border-radius:9px;border:none;` +
      `background:linear-gradient(135deg,#ff8a3d,#ff6a3d);color:#fff;cursor:pointer;font-size:13px;font-weight:600">` +
      `不再顯示</button></div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });                 // 點背景＝這次先關(下次還會跳)
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
