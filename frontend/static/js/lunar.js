// 今日農民曆卡 — 觸發：①系統閒置一段時間自動跳 ②連點小啊三次。畫面正中間黃曆卡。
//   資料來自後端 /api/lunar（cnlunar 算干支/節氣/宜忌/沖煞，zhconv 轉繁體），同一天只抓一次。
(function () {
  const IDLE_MS = 10 * 60 * 1000;   // 閒置多久沒操作 → 自動跳（10 分鐘）
  const TRIPLE_MS = 800;            // 連點三次的間隔上限
  let _data = null, _dataDate = "", _idleTimer = null, _open = false;
  let _clicks = [];

  function _today() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);   // 台灣時間
    return d.toISOString().slice(0, 10);
  }

  async function _fetch() {
    const day = _today();
    if (_data && _dataDate === day) return _data;
    try {
      const r = await fetch("/api/lunar", { cache: "no-store" });
      const j = await r.json();
      if (j && j.ok) { _data = j; _dataDate = day; return j; }
    } catch (e) {}
    return null;
  }

  function _ensureDom() {
    let ov = document.getElementById("lunarOverlay");
    if (ov) return ov;
    ov = document.createElement("div");
    ov.id = "lunarOverlay";
    ov.className = "lunar-overlay";
    ov.innerHTML =
      '<div class="lunar-card" role="dialog" aria-label="今日農民曆">' +
      '  <button class="lunar-close" aria-label="關閉">×</button>' +
      '  <div class="lunar-head">' +
      '    <img class="lunar-bear" src="/static/img/bear.png" alt="">' +
      '    <div class="lunar-head-txt"><div class="lunar-title">今日黃曆</div>' +
      '    <div class="lunar-solar"></div></div>' +
      '  </div>' +
      '  <div class="lunar-lunar"></div>' +
      '  <div class="lunar-meta"></div>' +
      '  <div class="lunar-yiji">' +
      '    <div class="lunar-yi"><span class="lunar-tag lunar-tag-yi">宜</span><span class="lunar-yi-txt"></span></div>' +
      '    <div class="lunar-ji"><span class="lunar-tag lunar-tag-ji">忌</span><span class="lunar-ji-txt"></span></div>' +
      '  </div>' +
      '  <div class="lunar-hours-wrap"><div class="lunar-hours-title">十二時辰吉凶</div><div class="lunar-hours"></div></div>' +
      '  <div class="lunar-gods"></div>' +
      '  <div class="lunar-foot"></div>' +
      '</div>';
    document.body.appendChild(ov);
    // 點背景 / × 關閉
    ov.addEventListener("click", (e) => { if (e.target === ov || e.target.closest(".lunar-close")) hide(); });
    return ov;
  }

  function _fill(ov, d) {
    const q = (s) => ov.querySelector(s);
    q(".lunar-solar").textContent = d.solar + "　" + d.weekday;
    q(".lunar-lunar").textContent = d.lunar;
    const meta = [];
    meta.push("干支：" + d.ganzhi);
    meta.push("生肖：" + d.zodiac);
    if (d.solarTerm) meta.push("節氣：" + d.solarTerm);
    else if (d.nextTerm) meta.push("下個節氣：" + d.nextTerm);
    meta.push("沖煞：" + d.clash);
    meta.push("星座：" + d.constellation);
    q(".lunar-meta").innerHTML = meta.map(x => '<span class="lunar-chip">' + x + "</span>").join("");
    // 宜/忌收斂：凶日「忌」可達 50 項,全列變文字牆 → 先列 12 項+「…等N項(點開)」,點一下展開全文
    const _clamp = (el, items) => {
      const arr = items || [];
      if (!arr.length) { el.textContent = "—"; return; }
      if (arr.length <= 12) { el.textContent = arr.join("、"); return; }
      const short = arr.slice(0, 12).join("、") + "…等 " + arr.length + " 項";
      let full = false;
      el.textContent = short;
      el.style.cursor = "pointer";
      el.title = "點一下展開全部";
      el.onclick = () => { full = !full; el.textContent = full ? arr.join("、") : short; };
    };
    _clamp(q(".lunar-yi-txt"), d.good);
    _clamp(q(".lunar-ji-txt"), d.bad);
    // 十二時辰吉凶 + 標出當前時辰
    const hrs = d.hours || [];
    const h = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();   // 台灣小時
    const curIdx = Math.floor(((h + 1) % 24) / 2);                    // 子時=23~00 → 0
    q(".lunar-hours").innerHTML = hrs.map((x, i) =>
      '<div class="lunar-h' + (x.luck === "吉" ? " lh-ji" : " lh-xiong") + (i === curIdx ? " lh-now" : "") + '">' +
      '<span class="lunar-h-name">' + x.name + "</span>" +
      '<span class="lunar-h-luck">' + (x.luck || "") + "</span>" +
      '<span class="lunar-h-time">' + (x.time || "") + "</span></div>"
    ).join("");
    q(".lunar-gods").textContent = (d.luckyGods || []).join("　");
    q(".lunar-foot").textContent = d.level || "";
  }

  async function show() {
    if (_open) return;
    // 封面頁(landing/城門頁)顯示中 → 不跳農民曆卡(會與封面圖重疊、不好看)；稍後再排程，等進到圖表才跳。
    if (document.documentElement.classList.contains("landing-active")) { _resetIdle(); return; }
    const d = await _fetch();
    if (!d) return;
    const ov = _ensureDom();
    _fill(ov, d);
    _open = true;
    ov.classList.add("on");
  }

  function hide() {
    const ov = document.getElementById("lunarOverlay");
    if (ov) ov.classList.remove("on");
    _open = false;
    _resetIdle();           // 關閉後重新計時
  }
  // 給封面頁(landing)重新顯示時呼叫：關掉已開著的農民曆卡，避免封面圖跳出來跟它重疊。
  window._lunarHide = hide;

  // ── 閒置偵測 ──
  function _resetIdle() {
    if (_idleTimer) clearTimeout(_idleTimer);
    if (_open) return;      // 已開著就不再排程
    _idleTimer = setTimeout(() => { show(); }, IDLE_MS);
  }
  function _onActivity() {
    if (_open) return;      // 卡片開著時的點擊由 overlay 自己處理（關閉）；不重置
    _resetIdle();
  }

  // ── 連點小啊三次 ──
  function _onBearClick() {
    const now = Date.now();
    _clicks.push(now);
    _clicks = _clicks.filter(t => now - t <= TRIPLE_MS * 2);
    if (_clicks.length >= 3) { _clicks = []; show(); }
  }

  function init() {
    ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"].forEach(ev =>
      window.addEventListener(ev, _onActivity, { passive: true })
    );
    ["mXiaoa", "peekBear"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", _onBearClick);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _open) hide(); });
    _resetIdle();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
