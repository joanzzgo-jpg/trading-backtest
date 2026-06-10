# 混合式 3D 天氣背景 — 實作規格（給 Fable 執行）

> 路線：**Canvas 2D 粒子 + CSS 3D 分層**（不用 WebGL）。
> 範圍：**先做共用 3D 基礎層 + 1~2 個旗艦場景**驗證手感，確認方向對了再逐步把其餘天氣接上。
> 規格作者：Opus。執行者：Fable。延續 [weather.js](../frontend/static/js/weather.js) 既有架構，**漸進改造、不重寫**。

> **進度（2026-06-10）**：✅ Phase 1 + Phase 2 已實作完成（Fable）。
> 與規格的實作差異：①各層 canvas 解析度縮小 1/s、`scale(1/s)` 烤進 ctx 基準變換 → 繪製程式照舊用螢幕座標、省填充率（優於原規格的「全尺寸 backing」）；②未分層的天氣預設畫在 **mid** 層（非 sky）→ 螢幕位置/天文弧線與既往一致、保有中等視差；③ `_parX/_parY` 直接移除（含 dSnow/玻璃水珠引用點），未走「回傳 0」過渡；④ dMahjong 的絕對 `setTransform` 改 save/translate/rotate（絕對變換會蓋掉層基準縮放）；⑤ dOvercast 傳第 9 參數 `layerZ` 保留近景漸層但按 z 分層。
> 已驗證（headless CDP）：桌面/手機層結構與 transform 正確、相機 perspective-origin 對 mousemove 有反應、無 JS 例外、landing/雨天/主圖截圖正常。Phase 3（其餘天氣逐個接 `_ctxFor`）未做。
>
> **追加（同日，依使用者要求「背景要 3D／太陽月亮行星也要」）**：
> - **閒置自動運鏡**：3 秒無滑鼠/陀螺儀輸入 → 相機沿李薩茹軌跡緩慢繞行（`_applyCamera` 內建）→ 不互動也隨時看得出層層分離的縱深；有輸入即暫停跟手。振幅 `_CAM_AMP` 提高為桌面 10% / 手機 7%。
> - **astro 天體深景層**（translateZ -900，桌面第 6 層/手機第 4 層）：太陽（dSunny 本體/光束/光暈/鏡頭光斑）、月亮（_drawAstro/_drawMoonPhase）、八大行星（_drawPlanets）、夜空星雲/星星/流星（dNight/dMeteor）全數遷入 → 天體在最深處大幅視差、前方雲雨真遮擋。
> - **高解析層旗標**（`_LAYER_DEFS` 第 3 元素）：astro/fore backing 不縮 1/s——「透視縮小 k」與「補償縮放 s」相乘恰為 1，全解析 backing 即 1:1 顯示 → 月面/行星細節在深景層也不糊。其餘層仍縮 1/s 省填充率。
>
> **第二次追加（同日，「背景要更 3D、設計更亮麗、主圖背景只是濾鏡」）**：
> - **Z 軸展開加深**：sky -1600 / astro -1400 / far -900 / mid -450 / near -150 / fore 0；`_CAM_AMP` 桌面 12% / 手機 8% → 層間視差差距更大、運鏡更有縱深。
> - **天色底 `_SKY_BD`**：16 種天氣各一條全幅漸層「天色」（深藍晴空→暖金地平線、靛藍夜空、鐵灰雨幕…）畫在 sky 最深層、所有元素之後面 → 場景有設計感而非零散光暈（自帶天空的 aurora/sunset/sunrise/meteor/tornado/quake 不在表內、自動跳過）。
> - **全天氣透景 `sky-show`**（generalize 自 sky-night）：weather.js 對任何非 off 天氣掛 `html.sky-show` → `.charts-container` 轉透明 + mainPane 中央色帶 `color-mix 74%`（colors.js，夜空仍 52% 透更多）+ 舞台 opacity .45（夜 .6、封面 .9）→ **主圖背後是真實 3D 天氣場景（雲在 K 線後面飄），不再是疊在圖上的濾鏡**。注意 colors.js 在 bundle 內，改動需 bundle 重建（本機重啟 uvicorn 自動觸發）。
>
> **第三次追加（同日，「更有天文設計、漸層符合天氣」）**：
> - **天色日夜混色**：`_SKY_BD` 改為每天氣「白天/黑夜」雙色票（各 3 stop 的 [r,g,b,a]），`_dayK()` 依當地真實日出日落 ±40min 平滑過渡 → 雨天鐵灰藍、雨夜深墨藍、黃昏黎明自動轉色；漸層快取鍵含夜化量化階。
> - **銀河帶 `_milkyWay`**：斜跨夜空的三層柔光帶＋中央暗塵帶＋260 顆星塵，離屏半解析預烤、每幀一次 drawImage；只在較晴朗夜（`_astroDim()>0.5`）出現。
> - **真實星座 `_CONSTS`/_drawConstellations**：北斗七星/獵戶座/仙后座/夏季大三角/天蠍座，J2000 赤經赤緯 → `_lstDeg` 地方恆星時 → 地平座標（與行星同 `_skyXY` 投影），淡光連線＋依星等/色溫著色（參宿四/心宿二偏紅、織女星藍白），2 分鐘快取。
> - **星空/行星全夜間天氣**：原本只有晴夜（dNight）才有星，現在 `_drawAstro` 夜間分支對所有天氣畫 星空+星座+行星+銀河，亮度由 `_astroDim()`（天氣種類 × 雲量）統一減光；dNight 不再自畫行星（避免雙重）。
> - **白天淡月**：月亮在地平線上且天氣晴朗時，白晝也掛一輪 alpha~0.16 的真實月相（`_moonProg` 共用日夜分支）。
>
> **第四次追加（同日，「行星軌道/立體雲/星星更亮更科技/雲要透」）**：
> - **行星軌道 `_drawEcliptic`**：黃道帶投影成發光青色虛線弧（黃道→赤道→地平座標，與行星同管線，2 分快取）——行星天然全部落在這條弧上；每顆行星加旋轉虛線 HUD 鎖定環（亮行星雙環）。
> - **立體雲 `_bakeCloud`/`_cloudSpr`**：雲改離屏 sprite 烘焙（基底剪影 → 逐球 source-atop 頂光 → 底部陰影）→ 球狀體積感且每幀只 drawImage（比舊版每幀重畫更快）。**雲整體半透 ×0.62（上限 .78）**＋陰天灰天幕減半 → 後方星空/月亮/軌道透得出來（使用者要求「雲要透、背景清楚」）。
> - **星星加亮＋科技感**：兩處星空基礎亮度上調，亮星加 `_starSpike` 十字繞射光芒；星座連線改青色發光（shadowBlur）＋一等星節點細環；相機滑鼠跟隨已移除（桌面恆自動運鏡、手機陀螺儀保留）；`_astroDim` 有可見下限（天文永遠看得到，天氣只調高低）。
>
> **第五次追加（2026-06-11，邊緣破圖/精確 HUD/日月 3D/流動配色/清晰度）**：
> - **邊緣破圖修復**：補償縮放只剛好鋪滿 → 相機一移就露邊。每層 transform 再乘出血放大 `ov = 1 + 2·(−d/(P−d))·AMP% + 0.01`（fore 除外）→ 任何運鏡幅度下層永遠蓋滿視窗。`_CAM_AMP` 宣告上移至層建立處共用。
> - **黃道儀表化**：軌道走廊底光＋流動虛線資料流（lineDashOffset 動畫）＋每 12° 小刻度/每 30° 宮界大刻度＋黃道十二宮符號（♈ 起春分點，3° 取樣讓刻度落在整黃經）＋沿軌道巡航的脈衝光點 ×2。
> - **行星鎖定環精確化**：內圈旋轉虛線環＋外圈反向旋轉目標括號（4 段弧）＋固定四向刻線＋45° 引線標籤（中文名＋視星等讀數，monospace）。`_computePlanets` 輸出加 `zh`。
> - **3D 太陽 `_drawSun3D`**：限邊減光球體＋兩層反向慢轉電漿表面紋理（烤 sprite），dSunny（R28）與 _drawAstro 日間（R17）共用。**3D 月球**：暗面地照（藍灰微透）、球面高光朝太陽側（waxing 右/waning 左）、3 層漸縮橢圓柔化明暗交界線（terminator）——全烤進月相快取。
> - **流動配色 `_SKY_AC`**：每天氣一對互補色光暈緩慢繞行（lighter 疊加）→ 背景色彩隨時間變化。
> - **清晰度**：天色底＋流動光暈在主圖模式（非 landing-active）強度 ×0.5 → K 線區不蒙霧；封面全濃。雲半透係數 ×0.42（上限 .55）。

---

## 0. 一句話設計理念
把現在「單一 `#weatherBg` canvas + 軟體手動模擬視差（`_parX/_parY` 逐粒子位移）」，
改成「**一個帶 `perspective` 的 3D 舞台 `#weatherStage`，內含數張依 `translateZ` 排在不同景深的 canvas 層**」。
相機（滑鼠/陀螺儀）改去驅動舞台的 `perspective-origin`，**讓瀏覽器 GPU 自動算出真實透視視差**（近層動很多、遠層動很少，且有透視收斂感），主執行緒只負責在各層畫粒子。

好處：真深度、GPU 合成、零新依賴、可漸進；風險點集中在「層數」與「補償縮放公式」，本規格已給定。

---

## 1. 現況關鍵事實（動工前先讀）
- `#weatherBg` 在 [index.html:992](../frontend/templates/index.html#L992)，CSS 在 [style.css:3179](../frontend/static/css/style.css#L3179)：`position:fixed; inset:0; pointer-events:none; z-index:1; opacity:0.28`。
- 三種 opacity 狀態**必須保留**：平時 `0.28`；`html.sky-night` 夜空 `0.52`（[style.css:3191](../frontend/static/css/style.css#L3191)）；`html.landing-active` 封面 `0.9` + `z-index:2`（[style.css:5916](../frontend/static/css/style.css#L5916)）。
- weather.js 是**動態載入檔**（不在 bundle），由 [main.js:258](../frontend/static/js/main.js#L258) `_loadFx` 注入；版號 `_asset_ver()`（[main.py:94](../backend/main.py#L94)）讀 weather.js 的 mtime → **改檔即自動更新版號**（Railway 端）。⚠️ 但**本機 dev server 啟動時凍結 `?v=`**，改完要重啟 uvicorn 或硬重整才看得到（見記憶 `local-dev-asset-cache`）。
- **perf-mode 不載 weather.js** → 本改造天然不影響極簡模式，不必特別處理。
- 既有視差機制 `_parX/_parY/_parX()/_parY()`（[weather.js:309-329](../frontend/static/js/weather.js#L309-L329)）會在改造後**退役/改接** perspective-origin（見 §5），避免「CSS 透視 + 手動位移」雙重視差。
- 既有效能護欄要沿用：`_lowFx` 手機降載、`_frameMin` 幀率、`window._chartMoveTs` 圖表移動中降頻、`prefers-reduced-motion`。

---

## 2. 目標層結構（5 層，手機可降為 3 層）

| 層 id | 內容 | translateZ | 補償 scale（P=1200） |
|---|---|---|---|
| `wx-l-sky`  | 天空漸層、星空、極光/晚霞天幕、霧 vignette | `-1000px` | `1.833` |
| `wx-l-far`  | 遠景雲、遠雨/遠雪（z<0.33）、遠山輪廓 | `-600px` | `1.500` |
| `wx-l-mid`  | 太陽/月亮/行星、中景雲、中景粒子（0.33≤z<0.66） | `-300px` | `1.250` |
| `wx-l-near` | 近景雲、近雨/近雪（z≥0.66）、漣漪/水花 | `-100px` | `1.083` |
| `wx-l-fore` | 前景玻璃水珠、前景落葉/花瓣、地震落塵 | `0px` | `1.000` |

**補償縮放公式**（務必照用，否則層會錯位/露邊）：
對 `perspective: P`、層在 `translateZ(d)`（本案 d≤0，全部往螢幕後方推），
視覺需保持鋪滿 → `scale = (P - d) / P = 1 - d/P`。
→ 每層 CSS：`transform: translateZ(d) scale(1 - d/P);`（d 為負 → scale>1 放大補償）。

全部 d≤0（都往遠推、scale≥1）是刻意的：層 canvas 被放大覆蓋螢幕，相機轉動時**不會露出邊緣**。

---

## 3. HTML / CSS 改動

### 3.1 HTML（index.html）
把單行 `<canvas id="weatherBg"></canvas>` 換成舞台 + 層容器：
```html
<div id="weatherStage" aria-hidden="true">
  <canvas id="weatherBg" class="wx-layer" data-z="-1000"></canvas>   <!-- 相容用：見 §5 Phase 1 -->
  <!-- Phase 2 起拆出： -->
  <!-- <canvas class="wx-layer" data-z="-1000"></canvas> ...每層一張 -->
</div>
```
> ⚠️ 保留 `id="weatherBg"` 不可刪：landing/sky-night 的 CSS 與 `html.perf-mode #weatherBg`（[style.css:21](../frontend/static/css/style.css#L21)）、JS `document.getElementById("weatherBg")` 都靠它。Phase 1 先讓 `#weatherBg` 當唯一層掛進 stage（見 §5）。

### 3.2 CSS（style.css，#weatherBg 區塊附近）
```css
#weatherStage{
  position:fixed; inset:0; z-index:1; pointer-events:none;
  perspective:1200px;                /* = JS 的 P，兩處要一致 */
  perspective-origin:50% 50%;        /* 相機由 JS 改這個值做視差 */
  opacity:.28;                       /* 三態 opacity 改掛在 stage（取代原 #weatherBg） */
  transform:translateZ(0);           /* 提示合成層 */
}
.wx-layer{
  position:absolute; inset:0; width:100%; height:100%;
  pointer-events:none; backface-visibility:hidden;
  transform-origin:50% 50%;
  /* translateZ + scale 由 JS 依 data-z 套上（§4.1）；避免硬寫死層數 */
}
/* opacity 三態：改成作用在 stage（把原本 3 條 #weatherBg 規則一併遷移） */
html:not(.perf-mode).sky-night #weatherStage{ opacity:.52; }
html.landing-active #weatherStage{ opacity:.9 !important; z-index:2 !important; }
html.perf-mode #weatherStage{ display:none; }   /* 對齊原 perf-mode #weatherBg 行為 */

@media (prefers-reduced-motion: reduce){
  #weatherStage{ perspective-origin:50% 50% !important; }  /* 不做相機運動 */
}
```
> 遷移檢查：原 [style.css:21](../frontend/static/css/style.css#L21)、[3191](../frontend/static/css/style.css#L3191)、[5916](../frontend/static/css/style.css#L5916) 三處 `#weatherBg` 規則，凡是控制 opacity/z-index/display 的都改成 `#weatherStage`；只控制「canvas 畫布本身」的可留在 `.wx-layer`。

---

## 4. JS 改動（weather.js）

### 4.1 層管理（新增，放 IIFE 頂部 resize 附近）
```js
const _P = 1200;                              // 必須 === CSS perspective
const _LAYER_DEFS = _lowFx
  ? [['sky',-1000],['mid',-300],['fore',0]]   // 手機降為 3 層（少 2 次合成）
  : [['sky',-1000],['far',-600],['mid',-300],['near',-100],['fore',0]];
const _layers = {};   // name -> { canvas, ctx }
function _buildLayers(){
  const stage = document.getElementById('weatherStage');
  // Phase 1：沿用既有 #weatherBg 當唯一層；Phase 2 起依 _LAYER_DEFS 動態建 canvas
  _LAYER_DEFS.forEach(([name,d])=>{
    let cv = (name==='sky') ? document.getElementById('weatherBg') : null;
    if(!cv){ cv=document.createElement('canvas'); cv.className='wx-layer'; stage.appendChild(cv); }
    cv.style.transform = `translateZ(${d}px) scale(${(1 - d/_P).toFixed(4)})`;
    _layers[name] = { canvas:cv, ctx:cv.getContext('2d') };
  });
}
```
- `resize()` 內：每層 canvas 的 `width/height` 設為 `window.innerWidth/innerHeight`（**不**乘 scale；放大由 CSS transform 處理，canvas 像素仍 1:1 → 不增加填充成本）。
- 每層 `ctx` 取代原本單一 `ctx`。繪製時依粒子 `z` 落到對應層的 ctx（見 §4.2）。

### 4.2 分層渲染（draw 主迴圈改造）
現在 `draw(t)` 對單一 `ctx` 從遠到近畫所有東西。改成：
1. 每層 `ctx.clearRect`。
2. 各 `dXxx(t)` 函數把「畫在哪個 ctx」依粒子景深選擇：
   - 天空/天幕/vignette → `_layers.sky.ctx`
   - 遠粒子(z<0.33) → `far`（手機併入 sky）
   - 太陽/月亮/行星、中粒子 → `mid`
   - 近粒子(z≥0.66) → `near`（手機併入 mid）
   - 前景水珠/葉/花 → `fore`
3. 提供小工具 `_ctxFor(z)` 回傳該景深的 ctx；`dRain/dSnow/dCloudy` 等 `forEach` 內把 `ctx.` 換成 `_ctxFor(p.z).`。

> **漸進關鍵**：Phase 1 先**全部畫在 `sky` 層**（即現況單 canvas，只是被放進 stage），驗證相機/透視/效能無回歸。Phase 2 才把旗艦場景的 `dXxx` 改用 `_ctxFor(z)` 真正分層。

### 4.3 相機系統（取代 _parX/_parY 對粒子的手動位移）
```js
let _camX=0,_camY=0,_camTX=0,_camTY=0;        // 平滑值/目標(-1~1)，沿用原滑鼠/陀螺儀來源
const _CAM_AMP = 6;                            // perspective-origin 位移幅度(%)；手機可調小
function _applyCamera(){
  _camX += (_camTX-_camX)*0.07; _camY += (_camTY-_camY)*0.07;
  const ox = (50 - _camX*_CAM_AMP).toFixed(2), oy = (50 - _camY*_CAM_AMP).toFixed(2);
  document.getElementById('weatherStage').style.perspectiveOrigin = ox+'% '+oy+'%';
}
```
- `_initParallax()` 的 `mousemove`/`deviceorientation` 改成寫 `_camTX/_camTY`（公式同原本）。
- `loop()` 每幀（或圖表移動中降頻時）呼叫 `_applyCamera()`。
- **移除**各 `dXxx` 內的 `_parX(p.z)/_parY(p.z)` 逐粒子位移（雙重視差會晃過頭）；視差改由 perspective-origin 統一提供。
- `prefers-reduced-motion` → `_applyCamera` 直接 return（CSS 也已鎖死，雙保險）。
- 圖表移動中（`window._chartMoveTs`）→ 相機更新降到每 3~4 幀一次。

---

## 5. 分階段實作步驟（每階段都應能獨立 commit、可驗收）

### Phase 1 — 把現況裝進 3D 舞台（視覺幾乎不變，驗證地基）
1. HTML：`#weatherBg` 包進 `#weatherStage`。
2. CSS：新增 §3.2 規則；把 opacity/z-index 三態從 `#weatherBg` 遷到 `#weatherStage`。
3. JS：`_buildLayers()` 只建 `sky` 層（=既有 #weatherBg），套 `translateZ(-1000) scale(1.833)`；`resize` 沿用。
4. JS：接上 `_applyCamera()`（perspective-origin），`_initParallax` 改寫 `_camTX/Y`；**先保留** `_parX/_parY` 不刪（同時存在會雙重視差 → Phase 1 先把 `_CAM_AMP` 設 0 或把 `_parX/_parY` 回傳 0，二選一，確保只有一套視差生效）。
   - 建議：Phase 1 直接讓 `_parX/_parY` 回傳 0、啟用相機，眼睛確認新視差感正常。
- ✅ **驗收**：晴天/夜空/雨任一場景，畫面與改造前幾乎一致；滑鼠移動有整片天空的透視位移；無錯位、無露邊；FPS 不低於改造前；perf-mode 仍正常（不載入）。

### Phase 2 — 旗艦場景多層化（晴天 + 雨）
1. JS：`_LAYER_DEFS` 啟用全 5 層，`_buildLayers` 動態建其餘 canvas。
2. `_ctxFor(z)` 完成；把 **dSunny / dCloudy / dRain（含漣漪/水花/玻璃水珠）** 的繪製依景深拆到對應層：
   - 太陽本體/光暈/god-rays → `mid`；背景暖暈 → `sky`。
   - 雲：依 `c.z` 落 far/mid/near。
   - 雨絲：依 `p.z` 落 far/mid/near；漣漪/水花 → `near`；玻璃水珠 → `fore`。
3. 移除這些函數內的 `_parX/_parY`（深度視差已由 CSS 層提供）。
- ✅ **驗收**：晴天雲有明顯前後分離的透視；雨有「近雨快掠過、遠雨幾乎不動、玻璃水珠貼在最前」的真深度；手機 3 層版不卡、不掉幀；電量無異常發熱。

### Phase 3 —（之後，非本次）其餘 20 種天氣逐步接 `_ctxFor(z)`
- 每種天氣獨立一個小 commit；雪/霧/極光/晚霞/流星雨/天然災害比照旗艦場景的分層原則。
- 天文（`_drawAstro`/`_drawPlanets`）固定走 `mid` 層。

---

## 6. 效能與相容護欄（驗收必查）
- **層數即合成成本**：桌面 5 層、手機 3 層為上限，勿再加。
- canvas 像素維持 1:1 螢幕大小（放大交給 CSS scale）；勿用 `scale` 去放大 canvas 解析度。
- `.wx-layer` 用 `transform`（已是合成層）；**勿**對每層加 `will-change:transform`（×5 會吃顯存）；必要時只給 stage。
- 沿用 `_lowFx`（粒子數倍率、關 shadowBlur）、`_frameMin`、`document.hidden` 暫停、`window._chartMoveTs` 降頻。
- `prefers-reduced-motion`：相機靜止（CSS + JS 雙鎖）。
- opacity 三態（.28/.52/.9）作用在 `#weatherStage`，子層繼承 → 一處控制。
- perf-mode：`#weatherStage{display:none}` 且 weather.js 本就不載入 → 雙重不影響。
- 改完 weather.js：Railway 靠 mtime 自動 bust；**本機要重啟 uvicorn / 硬重整**才生效。

## 7. 風險與回退
- 單檔改造（weather.js + index.html 一行 + style.css 一段），易 `git checkout` 回退。
- 每個 Phase 可獨立 commit；Phase 1 若視覺/效能不如預期，可只回退 Phase 1 而不影響其它。
- 已知陷阱：①CSS `perspective` 與 JS `_P` 不一致 → 層錯位（兩處都 1200）。②忘了補償 scale → 遠層變小露出黑邊。③沒移除 `_parX/_parY` → 雙重視差晃過頭。④opacity 沒從 `#weatherBg` 遷到 stage → 夜空/封面亮度跑掉。
