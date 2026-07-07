// 小啊（橘子熊吉祥物）對話卡 — 手機「設定」分頁、天氣卡下方。
//   笑話與天氣預報都跟「電腦版橘子熊」共用同一來源（effects.js 暴露的
//   window._bearNextLine / window._bearForecastLine）→ 手機/桌面一致。
//   點泡泡換一句；天氣預報(若有定位資料)會不時穿插，沒有就退回笑話。
(function () {
  // 後備笑話（effects.js 尚未載入時，例如極簡模式不載特效 → 仍有話講）
  const _FB = [
    "我做價值投資。我的價值——已經貶到剩零點三了。",
    "停損不是認輸，是替下一單留子彈。",
    "看不懂的時候，空手就是最好的部位。",
    "我說『再加倉一次就賺回來』。我已經加七次了。我數學不錯。",
  ];
  let _fbPos = (Math.random() * _FB.length) | 0;
  let _lastLine = "";

  // 抽一句笑話：優先用桌面同一批（effects.js 的 _nextLine），否則用後備池
  function _joke() {
    if (typeof window._bearNextLine === "function") {
      try { const s = window._bearNextLine(); if (s) return s; } catch (e) {}
    }
    return _FB[(_fbPos++) % _FB.length];
  }

  // 天氣句：優先「完整報告」(附近雨區多情況+溫度，同桌面小啊)，退回精簡預報。需 weather.js 有定位資料。
  function _forecast() {
    if (typeof window._bearWeatherReport === "function") {
      try { const s = window._bearWeatherReport(); if (s) return s; } catch (e) {}
    }
    if (typeof window._bearForecastLine === "function") {
      try { return window._bearForecastLine(); } catch (e) {}
    }
    return null;
  }

  // 抽一句：開卡/初次優先講天氣，之後多半講笑話、偶爾再帶天氣（跟電腦版氛圍一致）
  function _pick(preferWeather) {
    let s = null;
    const wx = _forecast();
    if (wx && (preferWeather || Math.random() < 0.3)) s = wx;   // 有天氣資料 → 初次必講、之後 3 成機率
    if (!s) s = _joke();
    if (s === _lastLine) s = _joke();                            // 避免連兩句一樣
    _lastLine = s;
    return s;
  }

  // 換一句（帶淡出淡入）
  function _swap() {
    const card = document.getElementById("mXiaoa");
    const el = document.getElementById("mXiaoaText");
    if (!card || !el) return;
    card.classList.add("swapping");
    setTimeout(() => {
      el.textContent = _pick(false);
      card.classList.remove("swapping");
    }, 180);
  }

  function init() {
    const card = document.getElementById("mXiaoa");
    const el = document.getElementById("mXiaoaText");
    if (!card || !el) return;
    el.textContent = _pick(true);                      // 初始優先講天氣（有定位資料時）
    card.addEventListener("click", _swap);             // 點泡泡 → 換一句
    card.addEventListener("keydown", (e) => {          // 鍵盤可用（Enter/Space）
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); _swap(); }
    });
    // 「天氣如何？」按鈕：先講現有天氣+附近雨區，再抓最新回來更新一次（不觸發整卡換笑話）
    let _wxPending = false;
    document.getElementById("mXiaoaWxBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      el.textContent = _forecast() || _pick(true);
      _wxPending = true;
      if (typeof window._wxRefreshNow === "function") window._wxRefreshNow();
    });
    window.addEventListener("wx:updated", () => {
      if (_wxPending) { _wxPending = false; el.textContent = _forecast() || _joke(); }
    });
    // 每次切到「設定」分頁時刷新一句（情境可能已變：時間/天氣）→ 優先帶天氣
    document.querySelectorAll('.m-tab[data-mtab="settings"]').forEach(b => {
      b.addEventListener("click", () => setTimeout(() => { el.textContent = _pick(true); }, 50));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
