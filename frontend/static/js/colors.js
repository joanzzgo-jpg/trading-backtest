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
  // 比例縮放 + 軟上限：L 按 30% 縮放（保留同色相深淺差），但極亮的不超過 18%
  // 例：#FF0000(L=50%)→15%、#CC0000(L=40%)→12%、#660000(L=20%)→6%
  // 任何同色相不同深淺的色都會保留相對亮度差，不會被壓成同一個值
  const L = Math.min(l_orig * 0.30, 0.18);
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

function _applyChartBgGradient(color) {
  const pane = document.getElementById("mainPane");
  if (!pane) return;
  const _perf = document.documentElement.classList.contains("perf-mode");
  if (_perf) { pane.style.background = ""; return; }   // 極簡模式不上色，浮水印才看得到
  if (color == null) color = (typeof C !== "undefined" && (C.chartBg || C.bg)) || "#131722";  // 無參數→用目前主圖色（給 effects.js 夜空切換重套用）
  const dark = _darkenForChart(color);
  // 透景：中央色帶轉半透明 → 天氣/天文 3D 場景從 K 線後方透出，
  // 但「系統背景 ↔ 主圖色」上下漸層的形狀保留（不再整片 transparent 把漸層蓋掉）。
  // sky-night（晴朗夜空）透最多 52%；sky-show（其餘所有天氣，weather.js 掛）較含蓄 74% 保白天可讀性。
  const night = document.documentElement.classList.contains("sky-night");
  const show  = document.documentElement.classList.contains("sky-show");
  const mid = night ? `color-mix(in srgb, ${dark} 52%, transparent)`
            : show  ? `color-mix(in srgb, ${dark} 74%, transparent)`
            : dark;
  // 下方時間軸區：底緣改成半透明（不再實色蓋到 var(--bg)）→ 時間軸漸層透一些、背景/天氣淡淡透出
  const botFade = `color-mix(in srgb, var(--bg) 38%, transparent)`;
  pane.style.background =
    `radial-gradient(circle 200px at 100% 0%, var(--bg) 0%, transparent 70%), ` +
    `linear-gradient(to right, transparent 0%, transparent 96%, var(--bg) 100%), ` +
    `linear-gradient(to bottom, var(--bg) 0%, ${mid} 6%, ${mid} 90%, ${botFade} 100%)`;
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
  // body / charts-container 維持 var(--bg)（CSS 預設），只有主圖 pane 套使用者色 + 漸層
  document.body.style.background = "";
  const _cc = document.querySelector(".charts-container");
  if (_cc) _cc.style.background = "";
  _applyChartBgGradient(bg);

  {
    const bodyUp   = S.bodyVisible   !== false ? C.up   : "rgba(0,0,0,0)";
    const bodyDown = S.bodyVisible   !== false ? C.down : "rgba(0,0,0,0)";
    candleSeries.applyOptions({
      upColor: bodyUp, downColor: bodyDown,
      borderVisible: S.borderVisible !== false,
      borderUpColor: C.borderUp, borderDownColor: C.borderDown,
      wickVisible: S.wickVisible !== false,
      wickUpColor: C.wickUp, wickDownColor: C.wickDown,
    });
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

  if (ohlcvData.length > 0) { renderCRT(ohlcvData); renderVolume(ohlcvData); }

  document.getElementById("legK").style.color      = C.kdjK;
  document.getElementById("legD").style.color      = C.kdjD;
  document.getElementById("legJ").style.color      = C.kdjJ;
  document.getElementById("legRsi14").style.color  = C.rsi14;
  document.getElementById("legRsi7").style.color   = C.rsi7;
  document.getElementById("legCRT").style.color    = C.crtBull;
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

  function showDirect(clientX, clientY, { sections, onDelete, showStyle, currentWidth, currentLineStyle, onStyleChange }) {
    closePicker();
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

  _cpShowDirect = showDirect;

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

