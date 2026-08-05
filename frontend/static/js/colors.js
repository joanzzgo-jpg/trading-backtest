/* ══════════════════════════════════════════
   顏色 / 樣式
══════════════════════════════════════════ */
// 將任意色強制轉為深色版本（保留色相＋飽和度，壓低亮度到 ~8% L）
// 這樣 picker 顯示原色，但實際套到圖表是低亮度版（保證天氣動畫看得見）
function _darkenForChart(hex) {
  const m = String(hex || "").match(/^#?([a-f\d]{6})$/i);
  if (!m) return hex;
  let r = parseInt(m[1].slice(0,2), 16) / 255;
  let g = parseInt(m[1].slice(2,4), 16) / 255;
  let b = parseInt(m[1].slice(4,6), 16) / 255;
  // RGB → HSL
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l_orig = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l_orig > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h /= 6;
  }
  /* ★ 2026-08-05：暗色系濾鏡由「一律壓暗」改成「只封頂」。
     舊版 `Math.min(l_orig * 0.30, 0.18)` 是無條件縮放＋硬上限 → 連本來就很暗的選色
     也被再壓一次，色盤上看得出差別的顏色，上到圖上全變成一團差不多的深色。
     新版 `Math.min(l_orig * 0.45, 0.16)`（2026-08-05 使用者說「不夠暗」再調深一階）：縮放溫和很多、上限放寬，
       → 仍是明確的暗色系看盤環境，但不同選色之間看得出差別（S 完全保留＝色相辨識度不變）。
     ⚠ 別回到 0.30/0.18 那組：壓太狠 → 所有選色殊途同歸，體感就是「主圖背景色改不了」。
     ⚠ ★ 這個濾鏡**只准做在背景色本身**（#mainPane / .charts-container 的 background，
       位置在所有 LWC canvas 與繪圖疊加 canvas 之下）。**絕不可以改成蓋一層半透明暗色**：
       那會連 K 棒、標記、使用者畫的線一起壓暗。要調暗只調這裡的 L。
     ⚠ 順帶一提，真正讓顏色完全無效的是 style.css 那條 `.charts-container … !important`
       （已移除），不是這裡；查這類問題要先確認行內樣式有沒有被 !important 壓掉。 */
  const L = Math.min(l_orig * 0.45, 0.16);
  const S = s;                             // S 完全保留（hue 區辨力 +++）
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const R = hue2rgb(p, q, h + 1/3);
  const G = hue2rgb(p, q, h);
  const B = hue2rgb(p, q, h - 1/3);
  const toHex = v => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(R)}${toHex(G)}${toHex(B)}`;
}

// 相對亮度（0~255）：格線自動配色用
function _lum(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return 128;
  return 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16);
}

// 格線自動配色：判斷「圖表實際襯的背景」明暗 → 亮底給深暖棕格線、暗底給亮奶油格線，永遠有對比、不被吃掉。
//   背景三態：極簡=白底(亮)／天氣開(sky-show)=天氣層透出(夜暗·日被 stage 調暗成中暗)／天氣關=使用者暗色主圖底。
function _gridColorForBg() {
  const el = document.documentElement;
  let lum;
  if (el.classList.contains("perf-mode")) lum = 245;                       // 極簡白底
  else if (el.classList.contains("sky-show"))
    lum = el.classList.contains("sky-night") ? 22 : 90;                    // 天氣透出：夜暗／日(被 stage 半透調暗)偏中暗
  else lum = _lum(_darkenForChart((typeof C !== "undefined" && (C.chartBg || C.bg)) || "#131722"));
  return lum < 128 ? "rgba(255,216,176,0.13)"                              // 暗底 → 亮暖奶油格線(淡、不搶戲)
                   : "rgba(64,42,24,0.24)";                               // 亮底 → 深暖棕格線
}

// 把自動格線色套到四張圖（主圖＋KDJ/RSI/MACD）。背景變(天氣/主題/日夜)時呼叫。
function _applyAutoGrid() {
  const gc = _gridColorForBg();
  [typeof mainChart !== "undefined" && mainChart, typeof kdjChart !== "undefined" && kdjChart,
   typeof rsiChart !== "undefined" && rsiChart, typeof macdChart !== "undefined" && macdChart]
    .forEach(c => { try { c && c.applyOptions({ grid: { vertLines: { color: gc }, horzLines: { color: gc } } }); } catch (e) {} });
}

function _applyChartBgGradient(color) {
  const pane = document.getElementById("mainPane");
  if (!pane) return;
  _applyAutoGrid();   // 格線依當前背景明暗自動反轉（天氣/主題/日夜切換都會經過這裡）
  const _perf = document.documentElement.classList.contains("perf-mode");
  if (_perf) {
    pane.style.background = "";   // 極簡模式不上色，浮水印才看得到
    ["kdjPane", "rsiPane", "macdPane"].forEach(id => { const el = document.getElementById(id); if (el) el.style.background = ""; });
    document.querySelector(".charts-container")?.style.removeProperty("background");   // 同上：交回 CSS 的白底
    return;
  }
  if (color == null) color = (typeof C !== "undefined" && (C.chartBg || C.bg)) || "#131722";  // 無參數→用目前主圖色（給 effects.js 夜空切換重套用）
  const dark = _darkenForChart(color);
  // ⚠ 主圖天氣色帶濾鏡依使用者要求「移除」：主圖背景一律純色不透明漸層、不隨天氣染色 →
  //   漸層/「系統背景↔主圖色」混接保留、K 棒清晰不被天氣染。天氣 accent 仍寫進 CSS 變數供側欄用。
  const base = dark;   // 不透明純色（不再 color-mix 透明 → 不被後方天氣透染）
  // 天氣聯動色：中央色帶混入當前天氣 accent（上/下兩色 → 雙色斜向漸層），
  // 雨天透藍灰、晴天透暖金、夜透靛紫…看盤瞄一眼底色就知道外面天氣
  const _WX_ACCENT = {
    sunny:["#FFB347","#3E7BD6"], partly:["#F2B45C","#4A7FD0"], cloudy:["#7C93B5","#8B7BB8"],
    windy:["#7FA8C9","#88A0C0"], night:["#7B6BD8","#3FB6DE"], rain:["#4E8BC4","#5C6FD0"],
    drizzle:["#6E97BC","#7C88C4"], storm:["#5470B8","#7C66B8"], thunder:["#6E7BFF","#9A66D8"],
    snow:["#8FBCE8","#B8A8E8"], fog:["#9AAEC4","#AAB4CC"], overcast:["#7E8EA8","#988EB0"],
    leaves:["#E89045","#C06438"], spring:["#E895B8","#9CB8E8"], mahjong:["#52B584","#3E9EC4"],
    hail:["#7AA0C8","#90A4D0"],
  };
  const wxt = (typeof window._getWeatherType === "function" && window._getWeatherType()) || null;
  const AC = _WX_ACCENT[wxt] || null;
  const show = document.documentElement.classList.contains("sky-show");
  // 小熊磁磚牆紙也算「背後有東西要透出來」的模式 → 與天氣同一條路（半透明底而非全透明），
  // 否則使用者選的主圖色在磁磚模式下完全看不到（見 style.css 該處註解）。
  const tiles = document.documentElement.classList.contains("bear-tiles-show");
  const seeThru = show || tiles;
  /* ★ 2026-08-05 天氣模式的暗色系濾鏡（使用者：「我需要暗色系濾鏡，要小心不要疊到 K 棒
     跟繪圖物件上，放置在下」）。
     原本 sky-show 時主圖 background 直接 "transparent" → 天氣天空整片透上來、看盤區很亮，
     使用者說的「濾鏡沒回來、還是很亮」就是這個。
     ★ 作法：把濾鏡做成 **pane 自己的半透明暗色背景**。它在 DOM 上是所有 LWC canvas 與
       繪圖疊加 canvas 的**父層背景** → 天氣被壓暗，K 棒/標記/使用者畫的線完全不受影響
       （已用像素驗證：換背景色時漲跌柱像素數與純色皆一模一樣）。
     ⚠ 絕不可改成在上層蓋一片半透明黑：那才會把 K 棒與繪圖一起壓暗。
     WX_DIM 就是濾鏡濃度：要更暗調高、要天氣更清楚調低。 */
  const WX_DIM = 84;   // %：天氣模式下主圖底色的不透明度（0=全透明→天氣最亮，100=完全遮住天氣）
  const veil = `color-mix(in srgb, ${base} ${WX_DIM}%, transparent)`;
  /* ★ 2026-08-05：非天氣時改成「單一純色、零漸層」。
     原本疊了五層：右緣、上緣、下緣、右上角 radial 三種都是往 var(--bg) 混接，加一層極輕暗角。
     那些混接的用意是讓主圖與系統背景看不出邊界 —— 但使用者要的正好相反：
     「主圖背景要跟系統外觀的主背景色**不同**」「合約行情跟主圖中間不要用漸層」「上下漸層也拿掉」。
     邊界分明 = 一律 base 純色。⚠ 別再加回任何 var(--bg) 混接層。 */
  pane.style.background = seeThru ? veil : base;
  // 天氣 accent 仍寫進 CSS 變數（側欄等元件用）；指標區(KDJ/RSI/MACD)不再隨天氣染色(濾鏡已移除)。
  document.documentElement.style.setProperty("--wxA", AC ? AC[0] : "transparent");
  document.documentElement.style.setProperty("--wxB", AC ? AC[1] : "transparent");
  /* ★ 使用者定調「下方副圖也算主圖一部分」→ 副圖(KDJ/RSI/MACD)與主圖同一個背景色。
     作法是把顏色上在 .charts-container、副圖自己保持透明去吃它：
     這樣連 pane 之間 3px 的 .pane-divider(transparent) 也一起變同色，
     不會在主圖與副圖之間留一條系統色的細縫。 */
  const cc = document.querySelector(".charts-container");
  if (cc) {
    // ⚠ 磁磚牆紙(bear-tiles-show)必須維持 transparent+important（同 _applyOffBlack 的寫法）：
    //   否則使用者在磁磚開著時改顏色，這裡會把 base 蓋上去、把小熊牆紙整個遮掉。
    cc.style.removeProperty("background");
    if (document.documentElement.classList.contains("bear-tiles-show"))
      cc.style.setProperty("background", "transparent", "important");
    else if (!show) cc.style.background = base;   // 天氣模式留空 → 吃 CSS 的 var(--bg)
  }
  ["kdjPane", "rsiPane", "macdPane"].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    // 非天氣：透明 → 吃 container 的主圖色（副圖＝主圖的一部分，同色）
    // 天氣：跟主圖一樣上那層暗色濾鏡，否則副圖會比主圖亮一截
    el.style.background = seeThru ? veil : "transparent";
  });
}

function applyAllColors() {
  // 極簡模式：背景強制純白、文字深色；不受 C.chartBg（使用者暗色設定）影響
  const _perf = document.documentElement.classList.contains("perf-mode");
  const bg = _perf ? "#FFFFFF" : (C.chartBg || C.bg);
  // 軸刻度數字調淡（與 makeBaseOpts 一致），降低存在感
  const _txt = _perf ? "rgba(31,31,31,0.55)" : "rgba(209,212,220,0.55)";
  // LWC canvas 保持透明，讓浮水印顯示在 K棒下方；背景色由 CSS 提供
  [mainChart, kdjChart, rsiChart, macdChart].forEach(c =>
    c?.applyOptions({ layout: { background:{ color:"rgba(0,0,0,0)" }, textColor: _txt } })
  );
  // body 維持 var(--bg)（CSS 預設）；charts-container(含主圖+副圖) 的使用者色由 _applyChartBgGradient 負責
  document.body.style.background = "";
  _applyChartBgGradient(bg);

  {
    const bodyUp   = S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)";
    const bodyDown = S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)";
    candleSeries.applyOptions({
      upColor: bodyUp, downColor: bodyDown,
      // 同色邊框跳過(白畫兩次)；不同色/空心K照畫 — 見 charts.js _candleBorderVisible
      borderVisible: (typeof _candleBorderVisible === "function") ? _candleBorderVisible() : (S.borderVisible !== false),
      borderUpColor: C.borderUp, borderDownColor: C.borderDown,
      wickVisible: S.wickVisible !== false,
      wickUpColor: C.wickUp, wickDownColor: C.wickDown,
    });
    // ★這裡是無條件把蠟燭顏色寫回去的，會蓋掉「線型圖模式」設的全透明 →
    //   開著線型圖時重開頁面，還原顏色偏好之後蠟燭又冒出來，變成 K 棒與折線疊在一起。
    //   套完顏色再讓 applyChartType 重新裁決一次（它是圖型的唯一真相）。
    if (typeof applyChartType === "function") applyChartType();
  }
  bbU.applyOptions({ color:C.bbU }); bbM.applyOptions({ color:C.bbM }); bbL.applyOptions({ color:C.bbL });
  kdjK.applyOptions({ color:C.kdjK }); kdjD.applyOptions({ color:C.kdjD }); kdjJ.applyOptions({ color:C.kdjJ });
  kdjH20.applyOptions({ color:C.kdjH20, lineWidth:S.kdjHLWidth });
  kdjH50.applyOptions({ color:C.kdjH50, lineWidth:S.kdjHLWidth });
  kdjH80.applyOptions({ color:C.kdjH80, lineWidth:S.kdjHLWidth });
  rsiLine14.applyOptions({ color:C.rsi14 }); rsiLine7.applyOptions({ color:C.rsi7 });
  rsiH30.applyOptions({ color:C.rsiH30, lineWidth:S.rsiHLWidth });
  rsiH50.applyOptions({ color:C.rsiH50, lineWidth:S.rsiHLWidth });
  rsiH70.applyOptions({ color:C.rsiH70, lineWidth:S.rsiHLWidth });
  macdLine.applyOptions({ color:C.macd }); macdSignal.applyOptions({ color:C.macdSig }); macdHist?.applyOptions({ color:C.macdHist });
  volMaSeries?.applyOptions({ color:C.volMa });

  if (ohlcvData.length > 0) { renderVolume(ohlcvData); }

  document.getElementById("legK").style.color      = C.kdjK;
  document.getElementById("legD").style.color      = C.kdjD;
  document.getElementById("legJ").style.color      = C.kdjJ;
  document.getElementById("legRsi14").style.color  = C.rsi14;
  document.getElementById("legRsi7").style.color   = C.rsi7;
  document.getElementById("legMacd").style.color   = C.macd;
  document.getElementById("legMacdSig").style.color = C.macdSig;

  savePrefs();
}


/* ══════════════════════════════════════════
   自訂調色盤
══════════════════════════════════════════ */
function initColorPicker() {
  /* ── 色盤定義 ── */
  const GRAYS = ["#ffffff","#e8e8e8","#d0d0d0","#b0b0b0","#888888","#666666","#444444","#2c2c2c","#1a1a1a","#000000"];
  const HUES  = [0, 30, 60, 120, 160, 185, 210, 240, 270, 330];
  // [saturation%, lightness%]
  const ROWS  = [[60,90],[70,80],[75,70],[80,60],[85,50],[80,40],[75,30],[65,20]];

  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2,"0")).join("");
  }

  /* ── 建立 popup ── */
  const popup = document.createElement("div");
  popup.id = "cpPopup"; popup.className = "cp-popup";

  // Tab row for multi-section (K-bar mode) – inserted before color grid
  const tabRow = document.createElement("div"); tabRow.className = "cp-tab-row";
  tabRow.style.display = "none";
  popup.appendChild(tabRow);

  // 色塊格
  const grid = document.createElement("div"); grid.className = "cp-grid";
  const grayRow = document.createElement("div"); grayRow.className = "cp-row";
  GRAYS.forEach(c => grayRow.appendChild(makeSwatch(c)));
  grid.appendChild(grayRow);
  const hr = document.createElement("div"); hr.className = "cp-divider";
  grid.appendChild(hr);
  ROWS.forEach(([s, l]) => {
    const row = document.createElement("div"); row.className = "cp-row";
    HUES.forEach(h => row.appendChild(makeSwatch(hsl2hex(h, s, l))));
    grid.appendChild(row);
  });
  popup.appendChild(grid);

  // 底部列：「+」自訂色
  const footer = document.createElement("div"); footer.className = "cp-footer";
  const addBtn = document.createElement("button"); addBtn.className = "cp-add-btn"; addBtn.type = "button"; addBtn.textContent = "+";
  const nativeInput = document.createElement("input"); nativeInput.type = "color"; nativeInput.style.display = "none";
  addBtn.addEventListener("click", () => { nativeInput.value = currentHex; nativeInput.click(); });
  nativeInput.addEventListener("input", () => { currentHex = nativeInput.value; applyColor(); });
  footer.append(addBtn, nativeInput);
  popup.appendChild(footer);

  // 透明度列
  const opWrap  = document.createElement("div"); opWrap.className = "cp-opacity-wrap";
  const opLabel = document.createElement("div"); opLabel.className = "cp-opacity-label"; opLabel.textContent = "不透明度";
  const opRow   = document.createElement("div"); opRow.className = "cp-opacity-row";
  const opSlider = document.createElement("input"); opSlider.type = "range";
  opSlider.className = "cp-opacity-slider"; opSlider.min = 0; opSlider.max = 100; opSlider.value = 100;
  const opNum = document.createElement("input"); opNum.type = "number";
  opNum.className = "cp-opacity-num"; opNum.min = 0; opNum.max = 100; opNum.value = 100;
  const opPct = document.createElement("span"); opPct.className = "cp-opacity-pct"; opPct.textContent = "%";
  opSlider.addEventListener("input", () => { opNum.value = opSlider.value; applyColor(); });
  opNum.addEventListener("input",   () => { opSlider.value = opNum.value; applyColor(); });
  opRow.append(opSlider, opNum, opPct);
  opWrap.append(opLabel, opRow);
  popup.appendChild(opWrap);

  // 厚度選擇
  const thickWrap = document.createElement("div"); thickWrap.className = "cp-section";
  const thickLabel = document.createElement("div"); thickLabel.className = "cp-opacity-label"; thickLabel.textContent = "厚度";
  const thickRow = document.createElement("div"); thickRow.className = "cp-btn-row";
  const WIDTHS = [1, 2, 3, 4];
  let activeWidthBtn = null;
  const widthBtns = WIDTHS.map(w => {
    const btn = document.createElement("button"); btn.className = "cp-line-btn"; btn.type = "button";
    btn.dataset.value = w;
    const inner = document.createElement("div");
    inner.style.cssText = `height:${w * 2}px;background:#d1d4dc;border-radius:1px;margin:auto;width:70%`;
    btn.appendChild(inner);
    btn.addEventListener("click", () => {
      activeWidthBtn?.classList.remove("active");
      btn.classList.add("active"); activeWidthBtn = btn;
      applyColor();
    });
    thickRow.appendChild(btn); return btn;
  });
  thickWrap.append(thickLabel, thickRow);
  popup.appendChild(thickWrap);

  // 線條樣式選擇（solid / dashed / dotted）
  const styleWrap = document.createElement("div"); styleWrap.className = "cp-section";
  const styleLabel = document.createElement("div"); styleLabel.className = "cp-opacity-label"; styleLabel.textContent = "線條樣式";
  const styleRow = document.createElement("div"); styleRow.className = "cp-btn-row";
  // LWC lineStyle: 0=Solid, 2=Dashed, 1=Dotted
  const STYLES = [
    { value: 0, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2"/></svg>` },
    { value: 2, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2" stroke-dasharray="6,4"/></svg>` },
    { value: 1, svg: `<svg width="44" height="8"><line x1="2" y1="4" x2="42" y2="4" stroke="#d1d4dc" stroke-width="2" stroke-dasharray="2,3"/></svg>` },
  ];
  let activeStyleBtn = null;
  const styleBtns = STYLES.map(({ value, svg }) => {
    const btn = document.createElement("button"); btn.className = "cp-line-btn"; btn.type = "button";
    btn.dataset.value = value; btn.innerHTML = svg;
    btn.addEventListener("click", () => {
      activeStyleBtn?.classList.remove("active");
      btn.classList.add("active"); activeStyleBtn = btn;
      applyColor();
    });
    styleRow.appendChild(btn); return btn;
  });
  styleWrap.append(styleLabel, styleRow);
  popup.appendChild(styleWrap);

  // 額外動作列（繪圖用：鎖定/編輯文字等，由 extraActions 動態填按鈕）
  const extraRow = document.createElement("div"); extraRow.className = "cp-extra-row";
  extraRow.style.cssText = "display:none;gap:6px;padding:6px 8px 0;flex-wrap:wrap;";
  popup.appendChild(extraRow);

  // 刪除按鈕列（繪圖直接模式用）
  const delRow = document.createElement("div"); delRow.className = "cp-del-row";
  delRow.style.display = "none";
  const delBtn = document.createElement("button"); delBtn.className = "dcp-delete";
  delBtn.type = "button"; delBtn.textContent = "刪除線條";
  delRow.appendChild(delBtn);
  popup.appendChild(delRow);

  document.body.appendChild(popup);

  /* ── 狀態 ── */
  let currentInput  = null;
  let currentHex    = "#ffffff";
  let currentSwatch = null;
  let currentWidth  = null;   // null = 不覆寫（此 input 不支援寬度）
  let currentStyle  = null;
  let _directSecs           = null;
  let _activeSecIdx         = 0;
  let _directOnDelete       = null;
  let _directOnStyleChange  = null;

  function makeSwatch(color) {
    const sw = document.createElement("div"); sw.className = "cp-swatch";
    sw.style.background = color; sw.dataset.color = color;
    sw.addEventListener("click", () => {
      currentHex = color;
      applyColor();
      if (currentSwatch) currentSwatch.classList.remove("selected");
      currentSwatch = sw; sw.classList.add("selected");
    });
    return sw;
  }

  function applyColor() {
    const pct = parseInt(opSlider.value);
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    const finalColor = pct >= 100 ? currentHex : hexAlpha(currentHex, pct);

    if (_directSecs) {
      const sec = _directSecs[_activeSecIdx];
      sec.currentColor = finalColor;
      sec.apply(finalColor, pct);
      const dots = tabRow.querySelectorAll(".cp-tab-dot");
      if (dots[_activeSecIdx]) dots[_activeSecIdx].style.background = finalColor;
      if (_directOnStyleChange && activeWidthBtn && activeStyleBtn)
        _directOnStyleChange(parseInt(activeWidthBtn.dataset.value), parseInt(activeStyleBtn.dataset.value));
      return;
    }
    if (!currentInput) return;
    currentInput._cpColor = finalColor;
    currentInput.value    = currentHex;
    const tr = currentInput.previousElementSibling;
    if (tr?.classList.contains("cp-trigger")) tr.style.background = finalColor;
    const inputId = currentInput.id;
    if (INPUT_SERIES_MAP[inputId]) {
      const w = activeWidthBtn ? parseInt(activeWidthBtn.dataset.value) : null;
      const s = activeStyleBtn ? parseInt(activeStyleBtn.dataset.value) : null;
      currentInput._cpWidth = w; currentInput._cpStyle = s;
      LINE_STYLES[inputId] = { width: w, style: s };
      applyLineStyle(inputId);
      savePrefs();
    }
    currentInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function show(input, triggerEl) {
    if (currentInput && currentInput !== input) closePicker();
    currentInput = input;
    currentHex   = (input.value || "#ffffff").substring(0, 7);
    opSlider.value = 100; opNum.value = 100;
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    // 標記已選色塊
    if (currentSwatch) currentSwatch.classList.remove("selected");
    currentSwatch = null;
    popup.querySelectorAll(".cp-swatch").forEach(sw => {
      if (sw.dataset.color.toLowerCase() === currentHex.toLowerCase()) {
        sw.classList.add("selected"); currentSwatch = sw;
      }
    });
    // 線寬 / 線型：只對支援的 series 顯示，並恢復儲存狀態
    const supportsStyle = !!INPUT_SERIES_MAP[input.id];
    thickWrap.style.display = supportsStyle ? "" : "none";
    styleWrap.style.display = supportsStyle ? "" : "none";
    if (supportsStyle) {
      const saved = LINE_STYLES[input.id] || {};
      activeWidthBtn?.classList.remove("active"); activeWidthBtn = null;
      activeStyleBtn?.classList.remove("active"); activeStyleBtn = null;
      const w = saved.width ?? 1;
      const s = saved.style ?? 0;
      widthBtns.forEach(b => { if (parseInt(b.dataset.value) === w) { b.classList.add("active"); activeWidthBtn = b; } });
      styleBtns.forEach(b => { if (parseInt(b.dataset.value) === s) { b.classList.add("active"); activeStyleBtn = b; } });
    }
    // 定位
    const rect = triggerEl.getBoundingClientRect();
    let top  = rect.bottom + 6;
    let left = rect.left;
    if (left + 232 > window.innerWidth)  left = window.innerWidth - 236;
    if (top  + 380 > window.innerHeight) top  = rect.top - 380 - 6;
    popup.style.top  = top  + "px";
    popup.style.left = left + "px";
    popup.classList.add("open");
    triggerEl.classList.add("cp-open");
  }

  function closePicker() {
    popup.classList.remove("open");
    document.querySelectorAll(".cp-trigger.cp-open").forEach(t => t.classList.remove("cp-open"));
    currentInput = null;
    _directSecs = null; _directOnDelete = null; _directOnStyleChange = null;
    tabRow.style.display = "none";
    delRow.style.display = "none";
  }

  function showDirect(clientX, clientY, { sections, onDelete, showStyle, currentWidth, currentLineStyle, onStyleChange, extraActions }) {
    closePicker();
    // 額外動作按鈕(鎖定/編輯文字…):每次重建
    extraRow.innerHTML = "";
    if (extraActions && extraActions.length) {
      extraActions.forEach(a => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.style.cssText = "flex:1;min-width:64px;padding:5px 8px;border-radius:6px;border:1px solid " +
          (a.active ? "#ffb300" : "#3a3f4d") + ";background:" + (a.active ? "#4a3b00" : "#262a36") +
          ";color:" + (a.active ? "#ffd54f" : "#d1d4dc") + ";font-size:12px;cursor:pointer;";
        b.addEventListener("mousedown", ev => { ev.stopPropagation(); });
        b.addEventListener("click", ev => { ev.stopPropagation(); try { a.onClick(); } catch (e) {} closePicker(); });
        extraRow.appendChild(b);
      });
      extraRow.style.display = "flex";
    } else {
      extraRow.style.display = "none";
    }
    _directSecs = sections; _activeSecIdx = 0;
    _directOnDelete = onDelete || null;
    _directOnStyleChange = onStyleChange || null;
    currentInput = null;

    tabRow.innerHTML = "";
    tabRow.style.display = sections.length > 1 ? "flex" : "none";
    sections.forEach((sec, i) => {
      const btn = document.createElement("button");
      btn.className = "cp-tab-btn" + (i === 0 ? " active" : "");
      btn.type = "button";
      const dot = document.createElement("span"); dot.className = "cp-tab-dot";
      dot.style.background = (sec.currentColor || "#fff").substring(0, 7);
      btn.appendChild(dot);
      if (sec.label) btn.appendChild(document.createTextNode(" " + sec.label));
      btn.addEventListener("mousedown", e => {
        e.stopPropagation();
        _activeSecIdx = i;
        tabRow.querySelectorAll(".cp-tab-btn").forEach((b, j) => b.classList.toggle("active", j === i));
        currentHex = (sections[i].currentColor || "#ffffff").substring(0, 7);
        opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
        popup.querySelectorAll(".cp-swatch").forEach(sw =>
          sw.classList.toggle("selected", sw.dataset.color.toLowerCase() === currentHex.toLowerCase()));
      });
      tabRow.appendChild(btn);
    });

    currentHex = (sections[0].currentColor || "#ffffff").substring(0, 7);
    opSlider.value = 100; opNum.value = 100;
    opSlider.style.background = `linear-gradient(to right, transparent, ${currentHex})`;
    if (currentSwatch) currentSwatch.classList.remove("selected");
    currentSwatch = null;
    popup.querySelectorAll(".cp-swatch").forEach(sw => {
      if (sw.dataset.color.toLowerCase() === currentHex.toLowerCase()) {
        sw.classList.add("selected"); currentSwatch = sw;
      }
    });

    thickWrap.style.display = showStyle ? "" : "none";
    styleWrap.style.display = showStyle ? "" : "none";
    if (showStyle) {
      activeWidthBtn?.classList.remove("active"); activeWidthBtn = null;
      activeStyleBtn?.classList.remove("active"); activeStyleBtn = null;
      const w = currentWidth || 1, s = currentLineStyle ?? 0;
      widthBtns.forEach(b => { if (parseInt(b.dataset.value) === w) { b.classList.add("active"); activeWidthBtn = b; } });
      styleBtns.forEach(b => { if (parseInt(b.dataset.value) === s) { b.classList.add("active"); activeStyleBtn = b; } });
    }
    delRow.style.display = onDelete ? "flex" : "none";
    delBtn.onclick = () => { if (_directOnDelete) _directOnDelete(); closePicker(); };

    let left = clientX + 12, top = clientY - 10;
    if (left + 234 > window.innerWidth)  left = clientX - 234 - 12;
    if (top  + 420 > window.innerHeight) top  = window.innerHeight - 420 - 8;
    if (top < 4) top = 4;
    popup.style.left = left + "px";
    popup.style.top  = top  + "px";
    popup.classList.add("open");
  }

  window._cpShowDirect = showDirect;   // 掛 window：draw.js 為延遲載入(晚於此)，用 let 會被其 `let _cpShowDirect=null` 蓋掉→色盤開不了

  document.addEventListener("mousedown", e => {
    if (!popup.classList.contains("open")) return;
    if (popup.contains(e.target) || e.target.classList.contains("cp-trigger")) return;
    closePicker();
  });

  /* ── 替換 .color-panel 內所有 input[type=color] ── */
  document.querySelectorAll(".color-panel input[type='color']").forEach(inp => {
    const trigger = document.createElement("div");
    trigger.className = "cp-trigger";
    trigger.style.background = inp.value;
    inp.classList.add("cp-hidden");
    inp.parentElement.insertBefore(trigger, inp);
    trigger.addEventListener("click", e => {
      e.stopPropagation();
      if (popup.classList.contains("open") && currentInput === inp) { closePicker(); return; }
      show(inp, trigger);
    });
  });
}

/* ══════════════════════════════════════════
   事件綁定
══════════════════════════════════════════ */
function _updateStarBtn() {
  const btn    = document.getElementById("watchlistStarBtn");
  if (!btn) return;
  const symbol   = document.getElementById("symbolInput")?.value?.trim();
  const market   = document.getElementById("marketSelect")?.value || "crypto";
  const exchange = document.getElementById("exchangeSelect")?.value || "pionex";
  if (!symbol) { btn.classList.remove("active", "starred"); return; }
  const key  = `${market}:${exchange}:${symbol}`;
  const inWl = _watchlist.some(w => `${w.market}:${w.exchange || ""}:${w.symbol}` === key);
  btn.classList.toggle("active",  inWl);
  btn.classList.toggle("starred", inWl);
}

