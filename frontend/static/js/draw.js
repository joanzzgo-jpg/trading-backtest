let drawings    = [];
let drawingWIP  = null;

/* ── 繪圖圖層 A/B/C（2026-08-11）─────────────────────────────────────────────
   把繪圖分成三層，可以個別隱藏、切換「作用層」（新畫的線進哪一層）。
   用途：例如 A 放長線結構、B 放當日進出場、C 放實驗性的線 —— 想專心看某一組時
   把其他層關掉，不必真的把線刪掉再重畫。

   資料相容性（重要）
   ・圖層就是繪圖物件上的一個 `layer` 欄位。**沒有這個欄位的一律視為 A** →
     所有既有繪圖不必遷移、不會消失，舊版前端讀到新資料也只是忽略這個欄位。
   ・因此存檔格式沒變，`tv_drawings_v2` 照舊，帳號同步／上傳 Railway 那條路也不用改。

   ⚠ 隱藏的層**連命中判定一起跳過**：看不見的線不能被選取、拖曳、或被橡皮擦刪掉 ——
     否則會出現「拖到一條看不見的線」這種找不出原因的怪事。
   ⚠ 顯示狀態是**跨標的共用**（存 localStorage）：它是「我現在想看哪一組」的檢視偏好，
     不是某個標的的資料；跟著標的走的話，切個標的圖層就自己變了，反而難預期。 */
const DRAW_LAYERS = ["A", "B", "C"];
let _drawLayer  = "A";              // 作用層：新畫的繪圖進這一層
let _drawHidden = new Set();        // 被隱藏的層

function _layerOf(d) { return (d && d.layer) || "A"; }          // 沒有 layer 欄位＝A（既有繪圖）
function _layerOn(d) { return !_drawHidden.has(_layerOf(d)); }  // 這個繪圖現在看得見嗎

/* 堆疊順序：**上到下是 A → B → C**（A 蓋在最上面、C 在最底下）。
   Canvas 是「後畫的蓋在上面」→ 要先畫 C、再 B、最後 A。
   ⚠ 不能只靠陣列順序（那是建立順序）：不然後畫的 C 會蓋掉先畫的 A。
   ⚠ 排序要**穩定**：同一層內仍照建立順序，後畫的蓋先畫的（跟原本行為一致）。
     Array.prototype.sort 在現代瀏覽器保證穩定，可以直接用。 */
const _LAYER_Z = { C: 0, B: 1, A: 2 };
function _layerRank(d) { return _LAYER_Z[_layerOf(d)] ?? 2; }
function _byLayer(list) { return list.slice().sort((x, y) => _layerRank(x) - _layerRank(y)); }

function _loadLayerState() {
  try {
    const s = JSON.parse(localStorage.getItem("drawLayerState") || "null");
    if (s && DRAW_LAYERS.includes(s.active)) _drawLayer = s.active;
    if (s && Array.isArray(s.hidden)) _drawHidden = new Set(s.hidden.filter(x => DRAW_LAYERS.includes(x)));
  } catch (e) {}
}
function _saveLayerState() {
  try {
    localStorage.setItem("drawLayerState",
      JSON.stringify({ active: _drawLayer, hidden: [..._drawHidden] }));
  } catch (e) {}
}

/* 新增繪圖的**唯一**入口：蓋上目前的作用層。
   ⚠ 一定要在建立時蓋章，不能在存檔時補 —— 存檔時補會把「沒有 layer 的既有繪圖」
     一起蓋成當下的作用層，等於把使用者以前畫的線整批搬到別層。
   ⚠ 若作用層正被隱藏 → 自動取消隱藏：不然使用者會對著空白畫半天，畫完什麼也沒出現。 */
function _pushDraw(d) {
  d.layer = _drawLayer;
  if (_drawHidden.has(_drawLayer)) { _drawHidden.delete(_drawLayer); _saveLayerState(); _syncLayerBtns(); }
  drawings.push(d);
  return d;
}

/* 把三顆按鈕的外觀同步成目前狀態（作用層＝橘色實心、隱藏＝灰掉加刪除線）。 */
function _syncLayerBtns() {
  document.querySelectorAll("[data-layer]").forEach(b => {
    const n = b.dataset.layer;
    b.classList.toggle("active", n === _drawLayer);
    b.classList.toggle("hidden-layer", _drawHidden.has(n));
  });
}

/* 切換某一層的顯示／隱藏（快捷鍵 Z/X/C 與「再點一次作用層」都走這裡）。
   回傳切換後是否可見，讓呼叫端可以提示。 */
function _toggleDrawLayer(name) {
  if (!DRAW_LAYERS.includes(name)) return null;
  if (_drawHidden.has(name)) _drawHidden.delete(name); else _drawHidden.add(name);
  _saveLayerState(); _syncLayerBtns();
  // ⚠ 隱藏中的層若有東西被選著／滑鼠正懸在上面，要清掉 —— 否則會留下一個
  //   「看不見卻仍可被鍵盤刪除、仍在畫控制點」的幽靈選取。
  const gone = d => d && !_layerOn(d);
  if (gone(drawings.find(d => d.id === selectedId))) selectedId = null;
  if (gone(drawings.find(d => d.id === hoveredId)))  hoveredId  = null;
  _scheduleRenderDrawings();
  if (typeof _renderAllSub === "function") { try { _renderAllSub(); } catch (e) {} }
  return !_drawHidden.has(name);
}

/* 設為作用層；已經是作用層時再點一次＝切換顯示／隱藏。
   ⚠ 切到某一層時若它是隱藏的 → 順手取消隱藏：使用者的意圖顯然是「要來畫這層」。 */
function _setDrawLayer(name) {
  if (!DRAW_LAYERS.includes(name)) return;
  if (_drawLayer === name) { _toggleDrawLayer(name); return; }
  _drawLayer = name;
  if (_drawHidden.has(name)) _drawHidden.delete(name);
  _saveLayerState(); _syncLayerBtns(); _scheduleRenderDrawings();
  if (typeof _renderAllSub === "function") { try { _renderAllSub(); } catch (e) {} }
}

/* ⚠ draw.js 是延遲載入的，bundle（hotkeys.js 等）拿不到這裡的函式 →
     一律掛 window（見 memory：延遲載入檔勿用 let 宣告 bundle 會寫入的共享變數）。 */
window._toggleDrawLayer = _toggleDrawLayer;
window._setDrawLayer    = _setDrawLayer;
window._drawLayerState  = () => ({ active: _drawLayer, hidden: [..._drawHidden] });

/* 把「目前選中的繪圖」移到別的圖層（Shift+Z/X/C）。
   回傳移到哪一層；沒選中東西回 null（呼叫端據此提示，別假裝有做事）。
   ⚠ 移到**隱藏中的層**會讓那個繪圖當場消失 → 自動取消該層隱藏（同 _pushDraw 的處理）。
   ⚠ 走 saveDrawings()：它會把變更推進 undo 堆疊 → 移錯層可以用 V 復原，也會存檔＋同步。 */
function _moveSelectedToLayer(name) {
  if (!DRAW_LAYERS.includes(name)) return null;
  const d = drawings.find(x => x.id === selectedId);
  if (!d) return null;
  if (_layerOf(d) !== name) {
    d.layer = name;
    if (_drawHidden.has(name)) { _drawHidden.delete(name); _saveLayerState(); _syncLayerBtns(); }
    saveDrawings();
    _scheduleRenderDrawings();
    if (typeof _renderAllSub === "function") { try { _renderAllSub(); } catch (e) {} }
  }
  return name;
}
window._moveSelectedToLayer = _moveSelectedToLayer;

window._syncDrawLayerBtns = _syncLayerBtns;   // 勝率列每次重繪後由 winrate.js 呼叫，把外觀套回來
_loadLayerState();
/* ⚠ draw.js 是**延遲載入**的 → 它跑起來時 DOMContentLoaded 多半早就發生過了，
     掛 DOMContentLoaded 監聽器等於永遠不會執行（實測：點按鈕完全沒反應）。
     → 已經載入完就直接跑，否則才等。 */
function _initLayerUI() {
  _syncLayerBtns();
  const host = document.getElementById("drawLayers");
  if (host && !host._bound) {
    host._bound = true;
    host.addEventListener("click", e => {
      const b = e.target.closest("[data-layer]");
      if (b) _setDrawLayer(b.dataset.layer);
    });
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _initLayerUI);
else _initLayerUI();

/* ── Shift＝水平約束（2026-08-03）────────────────────────────────────────────
   畫線時按住 Shift → 第二點的價格鎖成第一點的價格，畫出完全水平的線（TradingView 同款）。
   ⚠ 只給「兩點線型」工具：trendline／ray／arrow。rect 與 fib 水平化會退化成零高度、
     longpos/shortpos 的第二點是停利停損位，套上去都沒有意義，故不納入。
   ⚠ 必須用「追蹤按鍵狀態」而不是只讀事件的 e.shiftKey：預覽虛線是由 renderDrawings()
     畫的、手上沒有事件物件。也因此按下/放開 Shift 當下要主動重畫一次，
     否則滑鼠不動時預覽不會跟著切換。
   ⚠ window 失焦要清掉：切去別的視窗時放開 Shift 收不到 keyup，會一直卡在水平模式。 */
const _H_SNAP_TYPES = new Set(["trendline", "ray", "arrow"]);
let _shiftDown = false;
function _hSnapOn(type) { return _shiftDown && _H_SNAP_TYPES.has(type); }
window.addEventListener("keydown", e => {
  if (e.key !== "Shift" || _shiftDown) return;
  _shiftDown = true;
  if (drawingWIP || dragState) _scheduleRenderDrawings();
});
window.addEventListener("keyup", e => {
  if (e.key !== "Shift") return;
  _shiftDown = false;
  if (drawingWIP || dragState) _scheduleRenderDrawings();
});
window.addEventListener("blur", () => { _shiftDown = false; });
let drawCanvas  = null;
let drawCtx     = null;
let drawTool    = "pointer";
let selectedId  = null;
let hoveredId   = null;
let dragState      = null;   // { id, startX, startY, moved, snapshot }
let _dragJustMoved = false;  // 拖移結束後抑制下一個 click，避免開啟顏色面板
let _mx = 0, _my = 0;
let _drawColor  = "#f5c518";  // 目前繪圖顏色

/* ── 各時框專屬的繪圖預選色（2026-08-04）─────────────────────────────────────
   切到哪個時框，畫筆就自動換成該時框的顏色 → 不必每次手動切色，
   而且日後一眼就看得出「這條線是在哪個時框畫的」。
   ⚠ 使用者用色盤改過顏色 → 記成「該時框的偏好」寫進 localStorage，下次切回來就是它。
     所以這是「預選」不是「鎖死」，改了會被記住。
   ⚠ 只影響**接下來要畫的**東西；已經畫好的線一律保留自己的 color，不會被追溯改掉。 */
const _TF_DRAW_COLOR_DEF = {
  "1m": "#ef5350",   // 紅
  "5m": "#ff9800",   // 橘
  "15m": "#ffd54f",  // 琥珀
  "30m": "#66bb6a",  // 綠
  "1h": "#ab47bc",   // 紫
  "2h": "#26c6da",   // 青
  "4h": "#2962ff",   // 藍
  "1d": "#f5c518",   // 金（沿用原本的預設色）
  "1w": "#ec407a",   // 粉
  "1M": "#8d6e63",   // 棕
};
/* 撞色化解時的備用色（都與上面的預設色不重複；不夠用時就維持原樣，不會亂配） */
const _TF_SPARE_COLORS = ["#00bcd4", "#7e57c2", "#9ccc65", "#ff7043", "#5c6bc0",
                          "#26a69a", "#d4e157", "#f06292", "#78909c", "#ffa726"];

function _tfDrawColors() {
  let m;
  try { m = { ..._TF_DRAW_COLOR_DEF, ...(JSON.parse(localStorage.getItem("drawColorByTf") || "{}") || {}) }; }
  catch (e) { m = { ..._TF_DRAW_COLOR_DEF }; }
  /* ★硬規則：任何兩個時框都不得同色。
     只在「設定當下」擋是不夠的 —— 防呆是後來才加的，之前存進 localStorage 的重複值
     會一直留著；而且使用者可能手改儲存內容。這裡在**每次讀取**就化解衝突：
     自訂值優先保留，撞到的那個退回它自己的預設色；若預設色也被佔走，就從備用盤挑一個沒人用的。
     ⚠ 一定要用固定順序（_TF_ORDER）走訪，否則同一份資料每次解出來的結果可能不同。 */
  const used = new Map();                 // 正規化色 → 已佔用的時框
  const norm = x => String(x || "").trim().toLowerCase();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("drawColorByTf") || "{}") || {}; } catch (e) {}
  // 自訂過的先卡位（使用者明確選過的優先），其餘再依固定順序填
  const order = [...Object.keys(m).filter(tf => saved[tf]), ...Object.keys(m).filter(tf => !saved[tf])];
  for (const tf of order) {
    let c = norm(m[tf]);
    if (!used.has(c)) { used.set(c, tf); continue; }
    const def = norm(_TF_DRAW_COLOR_DEF[tf]);
    if (def && !used.has(def)) { m[tf] = _TF_DRAW_COLOR_DEF[tf]; used.set(def, tf); continue; }
    const spare = _TF_SPARE_COLORS.find(x => !used.has(norm(x)));
    if (spare) { m[tf] = spare; used.set(norm(spare), tf); }
  }
  return m;
}
/* 工具列顏色框：顯示「當前畫筆色 + 它屬於哪個時框」。
   各時框有各自的預選色、切時框會自動換筆 → 沒有這個標記就看不出現在拿的是哪支筆。 */
/* 把每個時框的畫筆色寫進它自己的按鈕（--tf-pen）→ 時框列本身就是一張顏色對照表。
   使用者要「一眼看出各時框顏色」，做在按鈕上就不必點開任何東西。
   ⚠ 改過色、切時框、初次載入都要重跑：色表存在 localStorage，任何一處改了都要同步整列。 */
function _syncTfPenColors() {
  try {
    const m = _tfDrawColors();
    document.querySelectorAll(".tf-btn").forEach(b => {
      const c = m[b.dataset.tf];
      if (c) b.style.setProperty("--tf-pen", c);
      else b.style.removeProperty("--tf-pen");
    });
  } catch (e) {}
}

/* ⚠ 掛上 window：account.js 的跨裝置下行同步在把 drawColorByTf 從雲端寫回 localStorage 後，
   要重算「當前時框的預選色」並更新左側工具島與上方快捷列兩處色框。
   draw.js 是延遲載入、account.js 在 bundle 裡 → 只能靠 window 溝通。 */
function _syncDrawColorChip() {
  // ⚠ 色框有兩處（左側工具島 + 開高低收量右側快捷列）→ 一起更新，否則會各說各話
  const tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const _t = `繪圖顏色：${tf || "目前時框"} 的預選色 ${_drawColor}。點擊可更改（會記住成這個時框的偏好）`;
  for (const [swId, tfId, btnId] of [["dtcSwatch", "dtcTf", "btnDrawColor"],
                                      ["dtcSwatch2", "dtcTf2", "btnDrawColor2"]]) {
    const sw = document.getElementById(swId), tfEl = document.getElementById(tfId), btn = document.getElementById(btnId);
    if (sw) sw.style.background = _drawColor;
    if (tfEl) tfEl.textContent = tf || "—";
    if (btn) btn.title = _t;
  }
  _syncTfPenColors();      // 色框與時框列的色表永遠一起更新
}
window._syncTfPenColors = _syncTfPenColors;
window._syncDrawColorChip = _syncDrawColorChip;
/* 切時框後由 ui.js 呼叫：把畫筆換成該時框的顏色 */
window._syncDrawColorForTf = function () {
  const tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const c = _tfDrawColors()[tf];
  if (c) _drawColor = c;
  _syncDrawColorChip();
};
/* 使用者改了顏色 → 記成該時框的偏好。
   recolorExisting=true 時，連「已經畫在盤面上、用著這個時框舊色」的線一起換過去。
   ⚠ 兩個入口要分清楚，否則會誤傷：
     ・工具列色框 = 「改這個時框的顏色」→ 連動已畫的線（使用者要求）
     ・點單一條線的色盤 = 「只改這一條」→ 不連動，否則改一條會把同色的全部改掉
   ⚠ 用「舊色比對」而不是替繪圖加時框標記：既有的繪圖沒有標記、補標會標錯
     （舊圖會被標成當下的時框）。比對舊色的語意剛好就是使用者要的「那些藍線變成綠線」，
     而且個別手動改過色的線（已經不是舊色）會自動被排除，不會被連坐。 */
/* 顏色撞號防呆：不讓某個時框的畫筆設成「別的時框已經在用」的顏色。
   ⚠ 為什麼要擋：整套設計是「看顏色就知道這條線是在哪個時框畫的」。
     如果在 1m 把畫筆設成 5m 的橘色，之後 1m 畫出來的線跟 5m 的長得一模一樣，
     這個對照關係就整個失效了 —— 而且是安靜失效，事後根本分不出來。
   回傳撞到的時框（沒撞回 null）。 */
function _penColorClash(c, myTf) {
  const m = _tfDrawColors();
  const norm = x => String(x || "").trim().toLowerCase();
  for (const tf in m) {
    if (tf === myTf) continue;
    if (norm(m[tf]) === norm(c)) return tf;
  }
  return null;
}

function _rememberDrawColor(c, recolorExisting) {
  const _tfNow = (typeof currentTF !== "undefined") ? currentTF : "";
  const _clash = _penColorClash(c, _tfNow);
  if (_clash) {
    if (typeof showToast === "function")
      showToast(`⚠ 這個顏色是 ${_clash} 在用的 —— 換一個，才能一眼分出線是哪個時框畫的`);
    _syncDrawColorChip();      // 色盤可能已經先變色 → 拉回實際值
    return;
  }
  const prev = _drawColor;
  _drawColor = c;
  const tf = (typeof currentTF !== "undefined") ? currentTF : "";
  if (tf) {
    try {
      const m = JSON.parse(localStorage.getItem("drawColorByTf") || "{}") || {};
      m[tf] = c;
      localStorage.setItem("drawColorByTf", JSON.stringify(m));
    } catch (e) {}
  }
  // ⚠ 一定要「寫完 localStorage 才同步」：時框列的色表是從 localStorage 讀的，
  //   先同步的話會讀到舊值 —— 改了 4h 的顏色，時框列上的 4h 色帶卻不動。
  _syncDrawColorChip();
  if (!recolorExisting || !prev || prev === c) return;
  let n = 0;
  for (const d of drawings) {
    if (d && d.color === prev) { d.color = c; n++; }
  }
  if (n) { saveDrawings(); _scheduleRenderDrawings(); }
}
// ⚠ 在「宣告處」還原偏好，不能只在 ui.js 還原：draw.js 是延遲載入的，
//   它的 `let _magnetMode = ...` 會在 ui.js(bundle) 跑完之後才執行 → 直接把已還原的值蓋回 false
//   （本專案記錄過的同類陷阱：延遲載入檔用 let 蓋掉 bundle 已設好的共享變數）。
//   實測症狀：按鈕亮著（ui.js 設的 class 還在）但磁鐵其實沒作用。
let _magnetMode = (() => { try { return localStorage.getItem("magnetMode") === "1"; } catch (e) { return false; } })();

const DCP_COLORS = ["#f5c518","#ef5350","#26a69a","#2962ff","#ff9800","#7e57c2","#ec407a","#26c6da","#ffffff","#787b86"];
const DRAW_WIDTH  = 1.5;
// _cpShowDirect 由 colors.js 的 initColorPicker() 設在 window 上（draw.js 為延遲載入、晚於 initColorPicker，
// 若在此用 `let _cpShowDirect=null` 會於載入時把已設好的值蓋回 null → 色盤永遠開不了）。一律走 window._cpShowDirect。

function _did() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

/* ═══════════════════════════════════════════════════════════════════════════
   我的實際交易（進場/出場標在主圖上）
   資料來源不限：交易所匯出 CSV、手動輸入、或截圖經 macOS 內建 OCR(scripts/ocr_table.swift)
   解析而來——這層只吃「結構化紀錄」，跟來源解耦。
   一筆紀錄：{ sym, dir:"long"|"short", et, ep, xt, xp, qty, lev, pnl, reason, note }
     ・et/xt = 進場/出場時間，**照抄交易所畫面上顯示的當地時間**（如 "2026-07-24T15:23:19"）
     ・xt/xp 可省略 → 未平倉，只畫進場點
   ★時間換算(踩過)：圖表軸顯示的就是台北時間（`toTime()` 已對 UTC 資料 +8h）。交易所 App 顯示的
     也是手機當地(台北)時間 → 若再套一次 toTime() 會**整整多加 8 小時**（實測進場點被畫到 23:23
     而不是 15:23）。故這裡用 `_myTradeT()`＝toTime(s)−8h，把「畫面上的當地時間」直接對到軸上，
     使用者匯入時照抄畫面數字即可、不必自己換時區。
   ★只畫「當下這個標的」的紀錄；時間用 _timeToX（已處理 LWC 只吃整數 logical 的雷 + 內插/外推），
     價格用 candleSeries.priceToCoordinate → 縮放/平移都跟著走。
   ═══════════════════════════════════════════════════════════════════════════ */
let _myTrades = [];
let _myTradesOn = true;
try { _myTrades = JSON.parse(localStorage.getItem("myTrades_v1") || "[]") || []; } catch (e) { _myTrades = []; }
try { _myTradesOn = localStorage.getItem("myTradesOn") !== "0"; } catch (e) {}

function _myTradesSave() {
  try { localStorage.setItem("myTrades_v1", JSON.stringify(_myTrades)); } catch (e) {}
}
// 標的正規化:交易所寫法百百種(ETH/USDT、ETH_USDT_PERP、ETHUSDT)→ 去掉分隔與 PERP 尾綴再比
function _myTradeSymKey(s) {
  return String(s || "").toUpperCase().replace(/[\/\-_\s]/g, "").replace(/PERP$/, "");
}
// 畫面上的當地時間字串 → 圖表軸時間（見上方「時間換算」註解：不能直接用 toTime，會多加 8h）
function _myTradeT(s) { const t = toTime(s); return t ? t - 8 * 3600 : 0; }

function _myTradesForCurrentSymbol() {
  const cur = _myTradeSymKey(document.getElementById("symbolInput")?.value || "");
  if (!cur) return [];
  return _myTrades.filter(t => _myTradeSymKey(t.sym) === cur);
}

function _drawMyTrades(W, H) {
  if (!_myTradesOn || !_myTrades.length || typeof candleSeries === "undefined" || !candleSeries) return;
  const rows = _myTradesForCurrentSymbol();
  if (!rows.length) return;
  const ctx = drawCtx;

  for (const t of rows) {
    const et = _myTradeT(t.et), xt = t.xt ? _myTradeT(t.xt) : null;
    const ex = _timeToX(et), ey = candleSeries.priceToCoordinate(+t.ep);
    if (ex == null || ey == null || !isFinite(ex) || !isFinite(ey)) continue;
    const xx = (xt != null) ? _timeToX(xt) : null;
    const xy = (t.xp != null) ? candleSeries.priceToCoordinate(+t.xp) : null;
    const long = (t.dir === "long");
    const win = (t.pnl != null) ? (+t.pnl >= 0) : (xy != null ? (long ? (+t.xp >= +t.ep) : (+t.xp <= +t.ep)) : true);
    // ★顏色依「買/賣」分,且直接取 K 棒的調色盤(C.up/C.down)→ 與使用者自訂的漲跌顏色永遠同色系;
    //   盈虧則靠標籤的正負號表示(不再用顏色表示賺賠,否則會跟買賣色打架)。
    const _C = (typeof C !== "undefined" && C) ? C : {};
    const col = long ? (_C.up || "#26a69a") : (_C.down || "#ef5350");

    ctx.save();
    // 進場→出場連線(虛線;未平倉則不畫)
    if (xx != null && xy != null && isFinite(xx) && isFinite(xy)) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(xx, xy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // 進場三角(多=上、空=下)，出場方塊
    ctx.fillStyle = col; ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.lineWidth = 1;
    const s = 7;
    ctx.beginPath();
    if (long) { ctx.moveTo(ex, ey - s); ctx.lineTo(ex - s, ey + s * 0.8); ctx.lineTo(ex + s, ey + s * 0.8); }
    else      { ctx.moveTo(ex, ey + s); ctx.lineTo(ex - s, ey - s * 0.8); ctx.lineTo(ex + s, ey - s * 0.8); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (xx != null && xy != null && isFinite(xx) && isFinite(xy)) {
      ctx.beginPath(); ctx.rect(xx - 5, xy - 5, 10, 10); ctx.fill(); ctx.stroke();
    }
    // 標籤:方向×槓桿 + 盈虧(放在進場點旁,避免蓋住 K 棒)
    const lev = t.lev ? `${t.lev}x` : "";
    const head = `${long ? "多" : "空"}${lev}`;
    const pnl = (t.pnl != null) ? `${+t.pnl >= 0 ? "+" : ""}${(+t.pnl).toFixed(2)}` : "";
    const txt = pnl ? `${head} ${pnl}` : head;
    ctx.font = "bold 11px sans-serif";
    const tw = ctx.measureText(txt).width;
    const bx = Math.min(Math.max(ex + 10, 2), W - tw - 8), by = long ? ey - 14 : ey + 6;
    ctx.fillStyle = "rgba(0,0,0,.62)";
    ctx.fillRect(bx - 3, by - 10, tw + 6, 14);
    ctx.fillStyle = col;
    ctx.fillText(txt, bx, by);
    ctx.restore();
  }
}

/* ── 對外 API（匯入/清除/開關；資料來源不限，見上方註解）── */
window._myTradesAdd = (recs) => {
  const arr = Array.isArray(recs) ? recs : [recs];
  _myTrades = _myTrades.concat(arr.filter(r => r && r.sym && r.et && r.ep != null));
  _myTradesSave();
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return _myTrades.length;
};
window._myTradesClear = () => { _myTrades = []; _myTradesSave(); if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings(); };
window._myTradesList = () => _myTrades.slice();
window._myTradesToggle = (on) => {
  _myTradesOn = (on == null) ? !_myTradesOn : !!on;
  try { localStorage.setItem("myTradesOn", _myTradesOn ? "1" : "0"); } catch (e) {}
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return _myTradesOn;
};

// 繪圖按「標的」分桶儲存（market:exchange:symbol）→ 各標的繪圖互不干擾。
function _drawSymKey() {
  const sym = document.getElementById("symbolInput")?.value || "";
  const mkt = document.getElementById("marketSelect")?.value || "crypto";
  const exc = document.getElementById("exchangeSelect")?.value || "pionex";
  return `${mkt}:${exc}:${sym}`.toUpperCase();
}
function _loadDrawStore() {
  try { return JSON.parse(localStorage.getItem("tv_drawings_v2") || "{}") || {}; } catch { return {}; }
}
// ── 繪圖復原（返回鍵）────────────────────────────────────────
// 所有繪圖變動（新畫/拖移/改大小/改色/刪除）最後都會呼叫 saveDrawings() → 在此
// 自動累積「變動前」快照，零漏網。堆疊上限 50、切標的重置（不跨標的復原）。
let _drawSaveWarned = false;   // 儲存失敗提示去重（見 saveDrawings）
let _undoStack = [];
let _undoBase  = "[]";   // 最後一次已儲存狀態(JSON)＝下一次變動的「變動前」
function _undoBtnSync() {
  // 兩顆：左側工具島 #btnDrawUndo、上方快捷列 #btnDrawUndo2（2026-08-05 新增）。
  // ⚠ 新增第三處入口時要一併加進來，否則會出現「有的能按有的不能按」。
  const on = !_undoStack.length;
  ["btnDrawUndo", "btnDrawUndo2"].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = on;
  });
}
/* 回傳「這次有沒有真的復原」→ 快捷鍵據此決定要不要跳提示（沒東西可復原就別騙人說復原了）。 */
function _drawUndo() {
  if (!_undoStack.length) return false;
  const prev = _undoStack.pop();
  try { drawings = JSON.parse(prev); } catch (e) { _undoBtnSync(); return false; }
  _undoBase = prev;   // 還原後＝基準 → 下方 saveDrawings 比對相同、不會再推疊
  if (selectedId && !drawings.some(d => d.id === selectedId)) selectedId = null;
  if (hoveredId  && !drawings.some(d => d.id === hoveredId))  hoveredId  = null;
  saveDrawings();
  _undoBtnSync();
  _scheduleRenderDrawings();
  if (typeof showToast === "function") showToast("↩ 已復原繪圖");
  return true;
}
window._drawUndo = _drawUndo;

function saveDrawings() {
  try {
    const cur = JSON.stringify(drawings);
    if (cur !== _undoBase) {
      _undoStack.push(_undoBase);
      if (_undoStack.length > 50) _undoStack.shift();
      _undoBase = cur;
      _undoBtnSync();
    }
  } catch (e) {}
  try {
    const store = _loadDrawStore();
    const key = _drawSymKey();
    if (drawings.length) store[key] = drawings; else delete store[key];
    localStorage.setItem("tv_drawings_v2", JSON.stringify(store));
    _drawSaveWarned = false;
  } catch (e) {
    // ★別再靜默吞掉(2026-07-31):原本 `catch {}` → 瀏覽器儲存空間滿時繪圖**存不進去卻毫無提示**,
    //   使用者以為畫好了,重新整理就全沒了。這是資料遺失,一定要講。
    //   實測:localStorage 上限約 10MB;繪圖即使 30 標的 × 300 個也才 1MB,正常用不會撞到 →
    //   真的撞到多半是別的資料(帳號快照等)吃滿,所以提示要引導使用者去清。
    console.warn("[繪圖] 儲存失敗:", e && e.name, e && e.message);
    if (!_drawSaveWarned) {
      _drawSaveWarned = true;   // 同一次連續失敗只提示一次,不洗版
      if (typeof showToast === "function")
        showToast("⚠ 繪圖沒能存起來（瀏覽器儲存空間已滿）— 重新整理後會消失，請先清掉一些標的的繪圖");
    }
  }
}
function loadDrawings() {
  try {
    const store = _loadDrawStore();
    const key = _drawSymKey();
    // 舊版單一全域 key → 一次性遷移到目前標的（避免遺失既有繪圖），遷移後刪除舊 key
    if (!(key in store)) {
      const legacy = JSON.parse(localStorage.getItem("tv_drawings") || "[]");
      if (Array.isArray(legacy) && legacy.length) {
        store[key] = legacy;
        localStorage.setItem("tv_drawings_v2", JSON.stringify(store));
      }
    }
    if (localStorage.getItem("tv_drawings") != null) localStorage.removeItem("tv_drawings");
    const arr = store[key];
    drawings = Array.isArray(arr) ? arr.filter(d => d.id && d.type) : [];
  } catch { drawings = []; }
  // 換標的載入 → 復原堆疊重置（復原不跨標的）
  _undoStack.length = 0;
  try { _undoBase = JSON.stringify(drawings); } catch (e) { _undoBase = "[]"; }
  _undoBtnSync();
}

/* ── 自選標的 ── */

// canvas 的 CSS 邏輯寬/高（backing store 是 device px，要除以 dpr）
function _cssW() { return drawCanvas ? drawCanvas.width  / (window.devicePixelRatio || 1) : 800; }
function _cssH() { return drawCanvas ? drawCanvas.height / (window.devicePixelRatio || 1) : 600; }

// 繪圖區寬度（扣掉右側價格軸）→ 用來判斷「最新K棒右邊空白處」與「價格軸」的界線
function _plotW() {
  try { const tw = mainChart.timeScale().width(); if (tw > 0) return tw; } catch (e) {}
  try { const pw = mainChart.priceScale("right").width(); if (pw > 0) return _cssW() - pw; } catch (e) {}
  return _cssW();
}

// 最後一根 K 棒的參考：logical index、時間、平均 bar 間隔（秒）
function _barRef() {
  const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
  if (!n) return null;
  const lastTime = toTime(ohlcvData[n - 1].time);
  let interval = 60;
  if (n >= 2) { const d = lastTime - toTime(ohlcvData[n - 2].time); if (d > 0) interval = d; }
  return { lastLogical: n - 1, lastTime, interval };
}

// time → x。原生 timeToCoordinate 只在「時間剛好落在某根 K 棒」時回座標，否則回 null。
//   ① 未來(右側空白)→ 有界外推 ② 早於資料起點 → 回 null(不外推,否則爆長線) ③ 落在兩棒之間
//   (小時框畫的端點切到大時框常不對齊任一棒)→ 相鄰棒內插(修「大時框線消失」)。
//   一律做「非有限值→null」保險,杜絕無限長線;整段 try 包住,永不因換算丟例外而弄壞整個 overlay。
function _timeToX(time) {
  try {
    const ts = mainChart.timeScale();
    const x = ts.timeToCoordinate(time);
    if (x != null) return x;
    // ⚠ LWC 的 logicalToCoordinate 只吃「整數」logical(給小數回 0/垃圾→線跳到 x=0)。
    //   所以一律取相鄰「整數棒」的座標,再自己在「像素空間」內插/外推。
    const r = _barRef();
    if (r && time > r.lastTime) {                          // 未來空白 → 用每根像素寬外推
      const cLast = ts.logicalToCoordinate(r.lastLogical);
      const cPrev = ts.logicalToCoordinate(r.lastLogical - 1);
      if (cLast == null || cPrev == null || !isFinite(cLast) || !isFinite(cPrev)) return null;
      const c = cLast + ((time - r.lastTime) / r.interval) * (cLast - cPrev);
      return isFinite(c) ? c : null;
    }
    const n = (typeof ohlcvData !== "undefined") ? ohlcvData.length : 0;
    if (!n) return null;
    const t0 = toTime(ohlcvData[0].time);
    if (time < t0) {              // 早於資料起點(大時框切小時框、小時框初載較短時常見)→ 往左像素外推
      const c0 = ts.logicalToCoordinate(0), c1 = ts.logicalToCoordinate(1);   // 整數 logical → 可靠
      if (c0 == null || c1 == null || !isFinite(c0) || !isFinite(c1)) return null;
      const int0 = (n >= 2) ? (toTime(ohlcvData[1].time) - t0) : 60;   // 首兩棒間隔(秒)
      if (!(int0 > 0)) return null;
      const c = c0 - ((t0 - time) / int0) * (c1 - c0);   // 往左每根像素寬外推(端點在範圍外仍定位正確、不再整條消失)
      return isFinite(c) ? c : null;
    }
    let lo = 0, hi = n - 1;        // 二分找相鄰兩棒
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (toTime(ohlcvData[mid].time) <= time) lo = mid; else hi = mid;
    }
    const tLo = toTime(ohlcvData[lo].time), tHi = toTime(ohlcvData[hi].time);
    const frac = tHi > tLo ? (time - tLo) / (tHi - tLo) : 0;
    const cLo = ts.logicalToCoordinate(lo), cHi = ts.logicalToCoordinate(hi);   // 整數 logical → 可靠(含離屏)
    if (cLo == null || cHi == null || !isFinite(cLo) || !isFinite(cHi)) return null;
    const c = cLo + frac * (cHi - cLo);   // 像素空間內插(不再餵小數 logical)
    return isFinite(c) ? c : null;
  } catch (e) { return null; }
}

// x → time：落在右側未來空白區時，回推一個外推時間戳（以平均 bar 間隔換算）。
// 價格軸區域（x > plotW）與左側空白不外推 → 回 null，維持原行為。
function _xToTime(x) {
  const ts = mainChart.timeScale();
  const t = ts.coordinateToTime(x);
  if (t != null) return t;
  const r = _barRef();
  if (!r || x > _plotW()) return null;
  const lg = ts.coordinateToLogical(x);
  if (lg == null || lg <= r.lastLogical) return null;   // 左側空白不外推
  return Math.round(r.lastTime + (lg - r.lastLogical) * r.interval);
}

// 短距離 cache：mousemove 60+ Hz，4px 內位移直接重用上次結果
// 拖移時 drawings 內容變但長度不變、被拖那筆仍是同物件 → 命中也正確
let _findNearestCache = { x: -1e9, y: -1e9, maxDist: 0, len: -1, result: null };
function findNearest(x, y, maxDist = 12) {
  const c = _findNearestCache;
  if (c.maxDist === maxDist && c.len === drawings.length
      && Math.abs(c.x - x) < 4 && Math.abs(c.y - y) < 4) {
    return c.result;
  }
  let best = maxDist, found = null;
  // ⚠ 用 _byLayer 反過來掃（A 先）：兩條線重疊時要抓到**看得見的那一條**，
  //   也就是堆疊在上面的層 —— 否則會出現「點到的是被蓋住的線」。
  _byLayer(drawings).reverse().forEach(d => {
    if (d.pane && d.pane !== "main") return;   // 副圖繪圖由副圖自己的命中處理
    if (!_layerOn(d)) return;                  // 隱藏層：看不見就不能被選取/拖曳
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; found = d; }
  });
  _findNearestCache = { x, y, maxDist, len: drawings.length, result: found };
  return found;
}

/* 偵測游標是否靠近 p1 或 p2 端點 */
function _endpointHit(d, x, y, thresh = 10) {
  if (d.type === "path" && Array.isArray(d.pts)) {      // 連續箭頭：每個轉折點都是把手
    for (let i = 0; i < d.pts.length; i++) {
      const c = chartToScreen(d.pts[i].time, d.pts[i].price);
      if (c && Math.hypot(c.x - x, c.y - y) <= thresh) return "pt" + i;
    }
    return null;
  }
  if (!d.p1 || !d.p2) return null;
  const a = chartToScreen(d.p1.time, d.p1.price);
  const b = chartToScreen(d.p2.time, d.p2.price);
  if (a && Math.hypot(a.x - x, a.y - y) <= thresh) return "p1";
  if (b && Math.hypot(b.x - x, b.y - y) <= thresh) return "p2";
  return null;
}

/* 目前主圖每根 K 棒的像素寬（barSpacing）；縮放時會變 */
function _emojiBarSp() {
  try { const b = mainChart.timeScale().options().barSpacing; return (b && isFinite(b) && b > 0) ? b : null; }
  catch (e) { return null; }
}
/* emoji 貼圖的實際顯示邊長：儲存尺寸 × (目前縮放 / 建立時縮放)，但比例限幅 → 隨 K 棒變、
   但放大主圖時到上限就不再變大(避免蓋住 K 棒)、縮小也有下限。 */
const _EMOJI_MAX_ZOOM = 2.0;   // 放大上限：最多長到放置時的 2 倍(放大主圖也不再更大→不蓋住 K 棒)
const _EMOJI_MIN_ZOOM = 0.5;   // 縮小下限：最小為放置時的 0.5 倍
function _emojiSize(d) {
  const base = d.size || 24;
  const cur = _emojiBarSp();
  if (cur == null) return base;
  if (!d.barRef || !isFinite(d.barRef) || d.barRef <= 0) { d.barRef = cur; return base; }   // 首次錨定當下縮放
  const ratio = Math.max(_EMOJI_MIN_ZOOM, Math.min(_EMOJI_MAX_ZOOM, cur / d.barRef));
  return Math.max(4, base * ratio);
}

/* 對 longpos/shortpos 判斷拖移的是哪一條線 */
function _drawingHitPart(d, x, y) {
  if (d.type === "emoji") {   // 右下角縮放把手優先
    const p = chartToScreen(d.time, d.price);
    if (p) {
      const sz = _emojiSize(d);
      if (Math.hypot((p.x + sz / 2 + 3) - x, (p.y + sz / 2 + 3) - y) <= 10) return "size";
    }
    return "move";
  }
  if (d.type !== "longpos" && d.type !== "shortpos") {
    const ep = _endpointHit(d, x, y);
    return ep || "move";
  }
  if (!d.p1) return "move";
  const ey = candleSeries?.priceToCoordinate(d.p1.price);
  const ty = candleSeries?.priceToCoordinate(d.tp);
  const sy = candleSeries?.priceToCoordinate(d.sl);
  // 左邊緣寬度把手優先偵測
  const ex = _timeToX(d.p1.time);
  if (ex != null && ty != null && sy != null) {
    const W2 = _cssW();
    const visR = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const ZW = Math.max(20, Math.min(W2 * 0.4, Math.round(W2 * (d.barWidth ?? 3) / barsV)));
    const rx2 = Math.min(W2, ex + ZW);
    if (Math.abs(x - rx2) < 10 && y >= Math.min(ty, sy) - 8 && y <= Math.max(ty, sy) + 8) return "width";
  }
  let bestDist = Infinity, bestPart = "entry";
  [["entry", ey], ["tp", ty], ["sl", sy]].forEach(([part, py]) => {
    if (py == null) return;
    const dist = Math.abs(py - y);
    if (dist < bestDist) { bestDist = dist; bestPart = part; }
  });
  return bestPart;
}

/* ═══════════════════════════════════════════════════════════════════════════
   副圖繪圖(KDJ / RSI / MACD)——step1:水平線 / 趨勢線 / 文字,可拖曳。
   ★X 與主圖共用時間軸(同步同寬)→ 沿用 _timeToX/_xToTime;Y 用各副圖 anchor series。
   自成一套、完全不動主圖那條路;drawings 共用(帶 pane 欄位)、工具狀態(drawTool/_drawColor)共用。
   ═══════════════════════════════════════════════════════════════════════════ */
const _SUB_DEFS = [
  { id:"kdj",  elId:"kdjChart",  getChart:()=>(typeof kdjChart !=="undefined")?kdjChart :null, getSeries:()=>(typeof kdjAnchor !=="undefined")?kdjAnchor :null },
  { id:"rsi",  elId:"rsiChart",  getChart:()=>(typeof rsiChart !=="undefined")?rsiChart :null, getSeries:()=>(typeof rsiAnchor !=="undefined")?rsiAnchor :null },
  { id:"macd", elId:"macdChart", getChart:()=>(typeof macdChart!=="undefined")?macdChart:null, getSeries:()=>(typeof macdAnchor!=="undefined")?macdAnchor:null },
];
const _subReg = {};          // id -> { el, canvas, ctx, def }
let _subDrag = null;         // 副圖拖曳中
const _SUB_TWO = { trendline:1 };   // step1 副圖支援的兩點型別

function _subXY(e, id)     { const r=_subReg[id].canvas.getBoundingClientRect(); return { x:e.clientX-r.left, y:e.clientY-r.top }; }
function _subV2Y(id, v)    { const s=_subReg[id].def.getSeries(); const y=s?s.priceToCoordinate(v):null; return (y!=null&&isFinite(y))?y:null; }
function _subY2V(id, y)    { const s=_subReg[id].def.getSeries(); const v=s?s.coordinateToPrice(y):null; return (v!=null&&isFinite(v))?v:null; }

// 螢幕點到繪圖的距離(副圖;X 用 _timeToX、Y 用該副圖)
function _subDist(d, x, y, id) {
  if (d.type==="hline") { const ly=_subV2Y(id,d.price); return ly==null?1e9:Math.abs(y-ly); }
  if (d.type==="text")  { const tx=_timeToX(d.time), ty=_subV2Y(id,d.price); return (tx==null||ty==null)?1e9:Math.hypot(x-tx,y-ty); }
  if (d.type==="trendline") {
    const x1=_timeToX(d.p1.time), y1=_subV2Y(id,d.p1.price), x2=_timeToX(d.p2.time), y2=_subV2Y(id,d.p2.price);
    if(x1==null||y1==null||x2==null||y2==null) return 1e9;
    const dx=x2-x1, dy=y2-y1, L2=dx*dx+dy*dy;
    let t = L2? ((x-x1)*dx+(y-y1)*dy)/L2 : 0; t=Math.max(0,Math.min(1,t));
    return Math.hypot(x-(x1+t*dx), y-(y1+t*dy));
  }
  return 1e9;
}
function _subFindNearest(id, x, y, tol) {
  let best=null, bd=tol;
  drawings.filter(d=>d.pane===id&&_layerOn(d)).forEach(d=>{ const dd=_subDist(d,x,y,id); if(dd<bd){bd=dd;best=d;} });
  return best;
}
function _subHitPart(d, x, y, id) {
  if (d.type==="trendline") {
    const x1=_timeToX(d.p1.time), y1=_subV2Y(id,d.p1.price), x2=_timeToX(d.p2.time), y2=_subV2Y(id,d.p2.price);
    if(x1!=null&&y1!=null&&Math.hypot(x-x1,y-y1)<10) return "p1";
    if(x2!=null&&y2!=null&&Math.hypot(x-x2,y-y2)<10) return "p2";
  }
  return "body";
}

function _renderSub(id) {
  const reg=_subReg[id]; if(!reg) return;
  const ctx=reg.ctx, dpr=window.devicePixelRatio||1;
  const W=reg.canvas.width/dpr, H=reg.canvas.height/dpr;
  ctx.clearRect(0,0,W,H);
  const s=reg.def.getSeries(); if(!s) return;
  _byLayer(drawings).filter(d=>d.pane===id&&_layerOn(d)).forEach(d=>{
    const col=d.color||_drawColor, sel=(d.id===selectedId);
    ctx.save(); ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineWidth=d.width||1.5;
    ctx.setLineDash(d.lineStyle===2?[6,4]:d.lineStyle===1?[2,3]:[]);
    try {
      if (d.type==="hline") {
        const y=_subV2Y(id,d.price); if(y==null){ctx.restore();return;}
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
        ctx.setLineDash([]); ctx.font="10px monospace";
        const _pTxt=(+d.price).toFixed(2);                       // 同主圖：價格標籤靠右
        ctx.fillText(_pTxt, Math.max(4, W - ctx.measureText(_pTxt).width - 5), y-3);
        if(sel){ ctx.fillStyle="rgba(255,255,255,.13)"; ctx.fillRect(0,y-5,W,10); ctx.fillStyle=col; ctx.beginPath(); ctx.arc(W*0.5,y,4,0,7); ctx.fill(); }
      } else if (d.type==="trendline") {
        const x1=_timeToX(d.p1.time), y1=_subV2Y(id,d.p1.price), x2=_timeToX(d.p2.time), y2=_subV2Y(id,d.p2.price);
        if(x1==null||y1==null||x2==null||y2==null){ctx.restore();return;}
        ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
        if(sel){ ctx.fillStyle=col; [[x1,y1],[x2,y2]].forEach(pt=>{ctx.beginPath();ctx.arc(pt[0],pt[1],4,0,7);ctx.fill();}); }
      } else if (d.type==="text") {
        const x=_timeToX(d.time), y=_subV2Y(id,d.price); if(x==null||y==null){ctx.restore();return;}
        ctx.setLineDash([]); ctx.font="12px sans-serif"; ctx.fillText(d.text||"", x, y);
      }
    } catch(e){}
    ctx.restore();
  });
  // 繪製中預覽(第一點已下、跟游標)
  if (drawingWIP && drawingWIP.pane===id && drawingWIP._mx!=null) {
    const x1=_timeToX(drawingWIP.p1.time), y1=_subV2Y(id,drawingWIP.p1.price);
    if(x1!=null&&y1!=null){ ctx.save(); ctx.strokeStyle=_drawColor; ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(drawingWIP._mx,drawingWIP._my); ctx.stroke(); ctx.restore(); }
  }
}
function _renderAllSub(){ for(const id in _subReg) _renderSub(id); }
window._renderAllSub = _renderAllSub;

function _subDown(e, id) {
  if (e.button!==0 || !_subReg[id]) return;
  const {x,y}=_subXY(e,id);
  if (drawTool==="pointer") {
    const near=_subFindNearest(id, x, y, 12);
    if (near && !near.locked) {
      e.stopPropagation();
      selectedId=near.id;
      _subDrag={ id:near.id, pane:id, sx:x, sy:y, moved:false, snap:JSON.parse(JSON.stringify(near)), part:_subHitPart(near,x,y,id) };
      _renderSub(id);
    }
  }
}
function _subMove(e, id) {
  if (drawingWIP && drawingWIP.pane===id) { const {x,y}=_subXY(e,id); drawingWIP._mx=x; drawingWIP._my=y; _renderSub(id); return; }
  if (!_subDrag || _subDrag.pane!==id) return;
  const d=drawings.find(z=>z.id===_subDrag.id); if(!d){_subDrag=null;return;}
  e.stopPropagation();
  const {x,y}=_subXY(e,id);
  const dx=x-_subDrag.sx, dy=y-_subDrag.sy;
  if(Math.abs(dx)>2||Math.abs(dy)>2) _subDrag.moved=true;
  const snap=_subDrag.snap, part=_subDrag.part;
  const shiftPt=(op)=>{ const ox=_timeToX(op.time), oy=_subV2Y(id,op.price); if(ox==null||oy==null)return{time:op.time,price:op.price}; return { time:_xToTime(ox+dx)??op.time, price:_subY2V(id,oy+dy)??op.price }; };
  if (d.type==="hline") { const oy=_subV2Y(id,snap.price); if(oy!=null){ const nv=_subY2V(id,oy+dy); if(nv!=null)d.price=nv; } }
  else if (d.type==="text") { const p=shiftPt(snap); d.time=p.time; d.price=p.price; }
  else if (d.type==="trendline") {
    if (part==="p1") { const p=shiftPt(snap.p1); d.p1={time:p.time,price:p.price}; }
    else if (part==="p2") { const p=shiftPt(snap.p2); d.p2={time:p.time,price:p.price}; }
    else { const a=shiftPt(snap.p1), b=shiftPt(snap.p2); d.p1={time:a.time,price:a.price}; d.p2={time:b.time,price:b.price}; }
  }
  _renderSub(id);
}
function _subClick(e, id) {
  if (!_subReg[id]) return;
  const {x,y}=_subXY(e,id);
  if (drawTool==="pointer") {
    if (_subDrag && _subDrag.moved) return;
    const near=_subFindNearest(id,x,y,12);
    selectedId = near?near.id:selectedId;
    if (near) e.stopPropagation();
    _renderSub(id); return;
  }
  if (drawTool==="crosshair") return;
  const time=_xToTime(x), price=_subY2V(id,y);
  if (time==null||price==null) return;
  e.stopPropagation();
  if (drawTool==="eraser") { const n=_subFindNearest(id,x,y,14); if(n){ drawings=drawings.filter(z=>z.id!==n.id); saveDrawings(); _renderSub(id);} return; }
  if (drawTool==="hline") { _pushDraw({id:_did(),type:"hline",pane:id,price,color:_drawColor}); saveDrawings(); _returnToPointer(); _renderSub(id); return; }
  if (drawTool==="text") {
    _showTextInput(e.clientX, e.clientY, txt=>{ if(txt&&txt.trim()){ _pushDraw({id:_did(),type:"text",pane:id,time,price,text:txt.trim(),color:_drawColor}); saveDrawings(); } _returnToPointer(); _renderSub(id); });
    return;
  }
  if (_SUB_TWO[drawTool]) {
    if (!drawingWIP || drawingWIP.pane!==id) { drawingWIP={ type:drawTool, pane:id, p1:{time,price} }; }
    else { _pushDraw({id:_did(),type:drawTool,pane:id,p1:drawingWIP.p1,p2:{time,price},color:_drawColor}); drawingWIP=null; saveDrawings(); _returnToPointer(); _renderSub(id); }
    return;
  }
  // 其他工具(框/測量/部位…)step1 副圖尚未支援:給提示、不建立
  if (typeof showToast==="function") showToast("副圖目前支援:水平線 / 趨勢線 / 文字");
}
function _subDbl(e, id) {
  const {x,y}=_subXY(e,id); const near=_subFindNearest(id,x,y,16);
  if (near) { e.stopPropagation(); selectedId=near.id; showDrawColorPicker(near, e.clientX, e.clientY); _renderSub(id); }
}
function _subCtx(e, id) {
  const {x,y}=_subXY(e,id); const near=_subFindNearest(id,x,y,16);
  if (near) { e.preventDefault(); e.stopPropagation(); selectedId=near.id; showDrawColorPicker(near, e.clientX, e.clientY); _renderSub(id); }
}

function _initSubDraw() {
  _SUB_DEFS.forEach(def=>{
    const el=document.getElementById(def.elId);
    if(!el || _subReg[def.id]) return;
    el.style.position="relative";
    const canvas=document.createElement("canvas");
    canvas.style.cssText="position:absolute;top:0;left:0;z-index:20;pointer-events:none;";
    el.appendChild(canvas);
    const ctx=canvas.getContext("2d");
    _subReg[def.id]={ el, canvas, ctx, def };
    const resize=()=>{ const dpr=window.devicePixelRatio||1, w=el.clientWidth, h=el.clientHeight;
      canvas.width=Math.round(w*dpr); canvas.height=Math.round(h*dpr); canvas.style.width=w+"px"; canvas.style.height=h+"px";
      ctx.setTransform(dpr,0,0,dpr,0,0); _renderSub(def.id); };
    resize();
    try{ new ResizeObserver(resize).observe(el); }catch(e){}
    const ch=def.getChart();
    if(ch){ try{ ch.timeScale().subscribeVisibleLogicalRangeChange(()=>_renderSub(def.id)); }catch(e){}
            try{ ch.subscribeCrosshairMove(()=>{ if((drawingWIP&&drawingWIP.pane===def.id)||(drawTool!=="pointer"&&drawTool!=="crosshair")) _renderSub(def.id); }); }catch(e){} }
    el.addEventListener("mousedown",  e=>_subDown(e,def.id),  {capture:true});
    el.addEventListener("mousemove",  e=>_subMove(e,def.id),  {capture:true});
    el.addEventListener("click",      e=>_subClick(e,def.id), {capture:true});
    el.addEventListener("dblclick",   e=>_subDbl(e,def.id),   {capture:true});
    el.addEventListener("contextmenu",e=>_subCtx(e,def.id),   {capture:true});
  });
  window.addEventListener("mouseup", ()=>{ if(_subDrag){ if(_subDrag.moved) saveDrawings(); _subDrag=null; } });
}
window._initSubDraw = _initSubDraw;

function initDrawTools() {
  // 初次載入也要套用該時框的預選色：deep link / 還原上次時框都不會經過 tf-btn 的點擊事件
  if (typeof window._syncDrawColorForTf === "function") window._syncDrawColorForTf();
  // 顏色框：點擊 → 改「當前時框」的預選色（不動任何已畫好的線）
  ["btnDrawColor", "btnDrawColor2"].forEach(id => document.getElementById(id)?.addEventListener("click", e => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showLegColorPopup(r.right + 6, r.top, [{
      label: null,
      currentColor: (_drawColor || "#f5c518").substring(0, 7),
      apply: c => { _rememberDrawColor(c, true); },   // 從色框改 → 已畫的同色線一起換
    }]);
  }));
  loadDrawings();

  const chartEl = document.getElementById("mainChart");
  chartEl.style.position = "relative";

  drawCanvas = document.createElement("canvas");
  // canvas 只做渲染，pointer-events 永遠 none，事件交給父容器
  drawCanvas.style.cssText = "position:absolute;top:0;left:0;z-index:20;pointer-events:none;";
  chartEl.appendChild(drawCanvas);
  drawCtx = drawCanvas.getContext("2d");

  const resize = () => {
    // 高 DPI（Retina）清晰化：backing store 用 devicePixelRatio 倍數，CSS 維持邏輯尺寸
    const dpr = window.devicePixelRatio || 1;
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    drawCanvas.width  = Math.round(w * dpr);
    drawCanvas.height = Math.round(h * dpr);
    drawCanvas.style.width  = w + "px";
    drawCanvas.style.height = h + "px";
    drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);  // 之後所有繪圖座標都用 CSS px
    _scheduleRenderDrawings();
  };
  resize();
  new ResizeObserver(resize).observe(chartEl);

  // ⚠ 用 LogicalRange 不用 TimeRange：TimeRange 只在「可見K棒集合」變了才發，
  //   次棒級的像素平移不觸發（實測 18 步平移只發 10 次）→ 繪圖每隔幾步停一拍＝平移浮動。
  //   LogicalRange 是小數、任何像素級平移/縮放都發 → 繪圖逐像素跟緊 K 棒。
  mainChart.timeScale().subscribeVisibleLogicalRangeChange(() => _scheduleRenderDrawings());
  // 滾輪縮放（可能縮放價格軸或時間軸）→ 開短追蹤窗,確保繪圖精準跟隨,不偏離原價位。
  chartEl.addEventListener("wheel", () => _watchAxis(700), { capture: true, passive: true });
  // 游標移動時的 overlay 重畫：hover 高亮/拖移由 _onChartMouseMove(DOM capture) 自行排程，
  // 故此處只在「正在繪製中／有手繪工具啟用」時補畫預覽線。預設十字線/指標模式下游標移動
  // 不需重畫整個 overlay（現價標籤/交易時段帶只隨價軸與可見範圍變化）→ 省電、減少拖動卡頓。
  mainChart.subscribeCrosshairMove(() => {
    if (drawingWIP || (drawTool !== "pointer" && drawTool !== "crosshair")) _scheduleRenderDrawings();
  });

  // 事件監聽全部掛在父容器（capture 優先），不攔截時讓 LWC 正常處理
  chartEl.addEventListener("mousemove",   _onChartMouseMove,   { capture: true });
  chartEl.addEventListener("mousedown",   _onChartMouseDown,   { capture: true });
  chartEl.addEventListener("click",       _onChartClick,       { capture: true });
  chartEl.addEventListener("dblclick",    _onChartDblClick,    { capture: true });
  chartEl.addEventListener("contextmenu", _onChartContextMenu, { capture: true });
  window.addEventListener("mouseup", _onChartMouseUp);

  // 繪圖復原：工具列返回鍵 + Ctrl/⌘+Z（打字中不攔；Shift+Z=redo 不支援、放行）
  ["btnDrawUndo", "btnDrawUndo2"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", _drawUndo));
  document.addEventListener("keydown", e => {
    // ⚠ 中文輸入法下 e.key 會是 "Process" → 走 window._physKey 取實體按鍵（見 hotkeys.js）
    const _uk = (typeof window._physKey === "function") ? window._physKey(e) : (e.key || "");
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (_uk === "z" || _uk === "Z")) {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
      if (_undoStack.length) { e.preventDefault(); _drawUndo(); }
    }
  });

  /* ── 觸控支援（手機繪圖）──
     ★ 2026-08-06 手機改成「長按才抓得動繪圖」（使用者：「手機版主圖上的繪製內容太容易誤觸，
       螢幕小不好調整」）。原本 touchstart 直接呼叫 _onChartMouseDown → 手指落點 12px 內
       有繪圖就**立刻**進入拖曳；但手指接觸面積遠大於 12px，於是在繪圖附近平移圖表
       十之八九會抓到線。
     作法：手指按住不動 _TOUCH_HOLD_MS 才進入拖曳；期間移動超過 _TOUCH_SLOP px 就取消
       （＝使用者是要平移圖表，照常交給 LWC）。判定半徑同時放寬到 _TOUCH_HIT px，
       長按之後反而更好抓 —— 「不易誤觸」與「好調整」是同一個改動的兩面。
     ⚠ 只影響觸控；桌面滑鼠仍是按下即拖（滑鼠是精準輸入，不需要這道關卡）。 */
  /* 調校紀錄：380ms/10px 之後使用者仍回報「還是太容易動到繪圖」→ 調到 650ms/8px。
     650ms 對「刻意要調整」不算久，但足以把「按著看盤／捲動前的短暫停頓」擋在外面。 */
  const _TOUCH_HOLD_MS = 650;   // 長按門檻
  const _TOUCH_SLOP    = 8;     // 超過這個位移就取消長按（＝使用者要平移）
  const _TOUCH_HIT     = 22;    // 觸控的判定半徑（比滑鼠的 12 寬）
  let _holdTimer = null, _holdFrom = null;
  const _cancelHold = () => { if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; } _holdFrom = null; };

  chartEl.addEventListener("touchstart", e => {
    const touch = e.touches[0]; if (!touch) return;
    /* ⚠ 一定要補 stopPropagation／preventDefault：_onChartMouseDown 進入拖曳時會呼叫
       e.stopPropagation() 擋掉 LWC 平移。假事件物件沒有這兩個方法就會拋
       TypeError，而且是在 `dragState = {...}` **之前**拋 → 手機從來就拖不動繪圖
       （既有 bug，touchend 那個假物件早就補了、touchstart 這個沒有）。 */
    const fake = { clientX: touch.clientX, clientY: touch.clientY, button: 0,
                   stopPropagation: () => {}, preventDefault: () => {} };
    if (drawTool === "pointer") {
      _cancelHold();
      const { x, y } = _canvasXY(fake);
      if (e.touches.length > 1) return;         // 多指（縮放）一律不進拖曳
      const near = findNearest(x, y, _TOUCH_HIT);
      if (!near || near.locked) return;         // 附近沒東西（或已鎖定）→ 完全不攔，LWC 正常平移
      _holdFrom = { x: touch.clientX, y: touch.clientY };
      _holdTimer = setTimeout(() => {
        _holdTimer = null;
        // 長按成立 → 這時才真的進入拖曳（_onChartMouseDown 內會 stopPropagation 擋掉 LWC 平移）
        _onChartMouseDown(fake);
        _scheduleRenderDrawings();
      }, _TOUCH_HOLD_MS);
      return;
    }
    if (drawTool === "crosshair") return;
    e.preventDefault();
    _onChartMouseMove(fake);
  }, { capture: true, passive: false });

  chartEl.addEventListener("touchmove", e => {
    const touch = e.touches[0]; if (!touch) return;
    const fake = { clientX: touch.clientX, clientY: touch.clientY,
                   stopPropagation: () => {}, preventDefault: () => {} };   // 同上：補齊方法
    // 長按還沒成立就先滑動 → 使用者是要平移圖表，取消長按（不要抓線）
    if (e.touches.length > 1) _cancelHold();   // 中途變成多指 → 使用者要縮放，放棄長按
    if (_holdTimer && _holdFrom &&
        Math.hypot(touch.clientX - _holdFrom.x, touch.clientY - _holdFrom.y) > _TOUCH_SLOP) _cancelHold();
    if (_vpDrag)   { e.preventDefault(); _onChartMouseMove(fake); return; }
    if (dragState) { e.preventDefault(); _onChartMouseMove(fake); return; }
    if (drawTool === "crosshair") return;
    if (drawTool !== "pointer") e.preventDefault();
    _onChartMouseMove(fake);
  }, { capture: true, passive: false });

  chartEl.addEventListener("touchend", e => {
    const touch = e.changedTouches[0]; if (!touch) return;
    _cancelHold();
    const fake = { clientX: touch.clientX, clientY: touch.clientY,
                   stopPropagation: () => {}, preventDefault: () => {} };
    if (_vpDrag)   { _onChartMouseUp(); return; }
    if (dragState) { _onChartMouseUp(); return; }
    if (drawTool === "pointer") {
      // 點擊選取繪圖，帶出顏色選擇器
      /* ★ 2026-08-06 手機不再跳色盤（使用者：「手機版設計成不支援調色板跳出好了，
         只能移動線，所以我點到他最多只能移動」）。
         小螢幕上「輕點就跳色盤」是誤觸的大宗：手指一碰到線就彈出面板擋住畫面。
         改成輕點什麼都不做；要調整位置＝長按後拖曳（見 touchstart 的 _TOUCH_HOLD_MS）。
         ⚠ 顏色仍可在桌面版或工具列的畫筆顏色改；這裡只是拿掉觸控的彈出入口。 */
      return;
    }
    if (drawTool === "crosshair") return;
    e.preventDefault(); e.stopPropagation();
    _onChartMouseUp();
    _onChartClick(fake);
  }, { capture: true });

  // cpPopup close is handled by initColorPicker()'s own mousedown listener

  // 副圖繪圖層(KDJ/RSI/MACD)——各自 canvas + 事件 + 座標(Y 用該副圖、X 沿用主圖)
  try { _initSubDraw(); } catch (e) {}
}

function _canvasXY(e) {
  const r = drawCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function _updateCursor() {
  const chartEl = document.getElementById("mainChart");
  if (!chartEl) return;
  if (dragState) { chartEl.style.cursor = "grabbing"; return; }
  if (drawTool === "pointer") {
    if (hoveredId) {
      const hd = drawings.find(d => d.id === hoveredId);
      if (hd) {
        const part = _drawingHitPart(hd, _mx, _my);
        if (part === "p1" || part === "p2" || part === "size") chartEl.style.cursor = "nwse-resize";
        else if (part === "tp" || part === "sl") chartEl.style.cursor = "ns-resize";
        else if (part === "width") chartEl.style.cursor = "ew-resize";
        else chartEl.style.cursor = "grab";
      }
    } else {
      chartEl.style.cursor = "";   // "" → 交回 LWC
    }
  } else if (drawTool === "crosshair") {
    chartEl.style.cursor = "";
  } else if (drawTool === "eraser") {
    chartEl.style.cursor = "crosshair";
  } else {
    chartEl.style.cursor = "crosshair";
  }
}

function _showTextInput(clientX, clientY, onConfirm) {
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:${clientX}px;top:${clientY - 36}px;z-index:9999;display:flex;gap:4px;`;
  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "文字 Enter 確認";
  inp.style.cssText = "background:#1e222d;color:#d1d4dc;border:1px solid #758696;padding:3px 8px;border-radius:4px;font-size:12px;width:150px;outline:none;font-family:sans-serif;";
  const ok = document.createElement("button");
  ok.textContent = "✓";
  ok.style.cssText = "background:#2962ff;color:#fff;border:none;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:12px;";
  wrap.append(inp, ok);
  document.body.appendChild(wrap);
  inp.focus();
  const confirm = () => { document.body.removeChild(wrap); onConfirm(inp.value); };
  const cancel  = () => { document.body.removeChild(wrap); onConfirm(null); };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirm(); } if (e.key === "Escape") cancel(); });
  ok.addEventListener("click", confirm);
  inp.addEventListener("blur", () => setTimeout(() => { if (document.body.contains(wrap)) cancel(); }, 200));
}

// ── emoji 貼圖選擇器（分類版，仿系統：底部分類頁籤 + 各系列大量 emoji + 最近使用）──
const _EMOJI_CATS = [
  { icon: "🕐", name: "最近使用", key: "recent", list: [] },
  { icon: "😀", name: "笑臉和人物", list: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐","😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","💩","🤡","👻","👽","🤖","👍","👎","👏","🙌","🙏","💪","🤝","👊","✊","🤞","✌️","🤟","🤘","👌","🤏","👈","👉","👆","👇","☝️","✋","👋","🤙","🫶","👀","🧠","👑"] },
  { icon: "🐻", name: "動物與自然", list: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🕷️","🐢","🐍","🦎","🦖","🐙","🦑","🦐","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🐘","🦏","🐪","🦒","🐐","🦌","🐕","🐈","🐓","🦃","🦚","🦜","🕊️","🐇","🌵","🎄","🌲","🌳","🌴","🌱","🌿","☘️","🍀","🎍","🍃","🍂","🍁","🌾","🌺","🌻","🌹","🌷","🌼","🌸","💐","🍄","🌰","🌍","🌕","🌙","⭐","🌟","✨","⚡","☄️","💥","🔥","🌪️","🌈","☀️","⛅","☁️","🌧️","⛈️","🌨️","❄️","☃️","⛄","💨","💧","💦","🌊"] },
  { icon: "🍔", name: "食物與飲料", list: ["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥒","🌽","🥕","🧄","🧅","🥔","🍠","🥐","🍞","🥖","🧀","🥚","🍳","🥞","🥓","🥩","🍗","🍖","🌭","🍔","🍟","🍕","🥪","🌮","🌯","🥗","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🍤","🍙","🍚","🍘","🍥","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🥜","🍯","🥛","🍼","☕","🍵","🧃","🥤","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🍾","🧊","🥄","🍴","🍽️"] },
  { icon: "⚽", name: "活動", list: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🏒","🏑","🏏","⛳","🏹","🎣","🥊","🥋","🎽","🛹","⛸️","🎿","⛷️","🏂","🏋️","🤼","🤸","⛹️","🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🚣","🧗","🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎫","🎪","🤹","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🎻","🎲","♟️","🎯","🎳","🎮","🎰","🧩"] },
  { icon: "🚗", name: "旅行與地點", list: ["🚗","🚕","🚙","🚌","🚎","🏎️","🚓","🚑","🚒","🚐","🚚","🚛","🚜","🛴","🚲","🛵","🏍️","🚨","🚔","🚍","🚘","🚖","🚡","🚠","🚟","🚃","🚋","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊","🚉","✈️","🛫","🛬","🛩️","💺","🛰️","🚀","🛸","🚁","🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","⚓","⛽","🚧","🚦","🚥","🗺️","🗿","🗽","🗼","🏰","🏯","🏟️","🎡","🎢","🎠","⛲","🏖️","🏝️","🏜️","🌋","⛰️","🏔️","🗻","🏕️","⛺","🏠","🏡","🏘️","🏭","🏢","🏬","🏥","🏦","🏨","🏪","🏫","⛪","🕌","🌁","🌃","🏙️","🌄","🌅","🌆","🌇","🌉","🌌","🎆","🎇","🌈"] },
  { icon: "💡", name: "物品", list: ["⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🕹️","💽","💾","💿","📀","📷","📸","📹","🎥","📽️","🎞️","📞","☎️","📟","📠","📺","📻","🎙️","⏱️","⏰","🕰️","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯️","🧯","💸","💵","💴","💶","💷","💰","💳","💎","⚖️","🧰","🔧","🔨","🛠️","⛏️","🔩","⚙️","⛓️","🧲","🔫","💣","🧨","🔪","🗡️","⚔️","🛡️","🚬","⚰️","🏺","🔮","📿","💊","💉","🩸","🧬","🦠","🧪","🌡️","🧹","🧻","🚽","🚿","🛁","🧼","🧴","🔑","🗝️","🚪","🛋️","🛏️","🧸","🖼️","🛍️","🛒","🎁","🎈","🎏","🎀","🎊","🎉","🏮","🧧","✉️","📩","📨","📧","💌","📦","🏷️","📪","📮","📜","📃","📄","📑","📊","📈","📉","🗒️","📆","📅","🗃️","📋","📁","📂","🗞️","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🔗","📎","📐","📏","🧮","📌","📍","✂️","🖊️","🖋️","✒️","🖌️","🖍️","📝","✏️","🔍","🔎","🔒","🔓","🔑"] },
  { icon: "❤️", name: "符號", list: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","☮️","✝️","☪️","🕉️","☸️","✡️","🔯","🕎","☯️","⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","🆔","⚛️","☢️","☣️","✴️","🆚","❌","⭕","🛑","⛔","🚫","💯","💢","🚭","❗","❕","❓","❔","‼️","⁉️","⚠️","🚸","🔱","⚜️","🔰","♻️","✅","❇️","✳️","❎","💠","♾️","🌀","💤","🏧","🚾","♿","🅿️","🚹","🚺","🚻","🚮","📶","🔣","ℹ️","🔤","🔡","🔠","🆖","🆗","🆙","🆒","🆕","🆓","🔟","🔢","▶️","⏸️","⏹️","⏺️","⏭️","⏮️","⏩","⏪","🔀","🔁","🔂","🔄","➡️","⬅️","⬆️","⬇️","↗️","↘️","↙️","↖️","↕️","↔️","↪️","↩️","🔼","🔽","➕","➖","➗","✖️","💲","™️","©️","®️","🔚","🔙","🔛","🔝","✔️","☑️","🔘","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🟤","🔺","🔻","🔸","🔹","🔶","🔷","🔳","🔲","⬛","⬜","🟥","🟧","🟨","🟩","🟦","🟪","🟫","🔔","🔕","📣","📢","💬","💭","🗯️","♠️","♣️","♥️","♦️"] },
  { icon: "🚩", name: "旗幟", list: ["🚩","🏁","🏴","🏳️","🏳️‍🌈","🏴‍☠️","🇹🇼","🇺🇸","🇯🇵","🇰🇷","🇨🇳","🇭🇰","🇬🇧","🇫🇷","🇩🇪","🇮🇹","🇪🇸","🇨🇦","🇦🇺","🇷🇺","🇧🇷","🇮🇳","🇸🇬","🇹🇭","🇻🇳","🇵🇭","🇲🇾","🇮🇩","🇳🇱","🇨🇭","🇸🇪","🇦🇪"] },
];
const _EMOJI_RECENT_KEY = "drawEmojiRecent";
function _emojiRecent() { try { return JSON.parse(localStorage.getItem(_EMOJI_RECENT_KEY) || "[]") || []; } catch (e) { return []; } }
function _emojiPushRecent(em) {
  try {
    let r = _emojiRecent().filter(x => x !== em);
    r.unshift(em);
    localStorage.setItem(_EMOJI_RECENT_KEY, JSON.stringify(r.slice(0, 32)));
  } catch (e) {}
}
function _showEmojiPicker(clientX, clientY, onPick) {
  const PW = 300, PH = 306, vw = window.innerWidth || 400, vh = window.innerHeight || 600;
  const left = Math.min(Math.max(6, clientX - PW / 2), vw - PW - 6);
  const top  = Math.min(Math.max(6, clientY - PH - 12), vh - PH - 6);
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${PW}px;height:${PH}px;z-index:9999;` +
    `display:flex;flex-direction:column;background:#1e222d;border:1px solid #758696;border-radius:12px;` +
    `box-shadow:0 14px 40px rgba(0,0,0,.6);overflow:hidden;font-family:sans-serif;`;
  let done = false;
  const close = (val) => {
    if (done) return; done = true;
    document.removeEventListener("pointerdown", off, true);
    document.removeEventListener("keydown", esc, true);
    if (document.body.contains(wrap)) document.body.removeChild(wrap);
    onPick(val);
  };
  const off = (e) => { if (!wrap.contains(e.target)) close(null); };
  const esc = (e) => { if (e.key === "Escape") close(null); };
  // 標題（目前分類名）
  const head = document.createElement("div");
  head.style.cssText = "padding:7px 10px 4px;font-size:11px;color:#8b93a3;flex-shrink:0;";
  // emoji 格
  const grid = document.createElement("div");
  grid.style.cssText = "flex:1;overflow-y:auto;padding:2px 6px 6px;display:grid;grid-template-columns:repeat(8,1fr);gap:1px;align-content:start;";
  const renderCat = (cat) => {
    head.textContent = cat.name;
    grid.innerHTML = "";
    const list = cat.key === "recent" ? _emojiRecent() : cat.list;
    if (!list.length) {
      const e = document.createElement("div");
      e.textContent = "（尚無最近使用）";
      e.style.cssText = "grid-column:1/-1;color:#6b7280;font-size:12px;padding:20px;text-align:center;";
      grid.appendChild(e); return;
    }
    list.forEach(em => {
      const b = document.createElement("button");
      b.textContent = em;
      b.style.cssText = "background:transparent;border:none;font-size:22px;cursor:pointer;padding:2px;border-radius:6px;line-height:1.2;";
      b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,.13)");
      b.addEventListener("mouseleave", () => b.style.background = "transparent");
      b.addEventListener("click", () => { _emojiPushRecent(em); close(em); });
      grid.appendChild(b);
    });
    grid.scrollTop = 0;
  };
  // 底部分類頁籤
  const tabs = document.createElement("div");
  tabs.style.cssText = "display:flex;border-top:1px solid rgba(255,255,255,.08);background:#171a23;flex-shrink:0;";
  _EMOJI_CATS.forEach(cat => {
    const t = document.createElement("button");
    t.textContent = cat.icon; t.title = cat.name;
    t.style.cssText = "flex:1;background:transparent;border:none;font-size:17px;cursor:pointer;padding:6px 0;opacity:.55;border-top:2px solid transparent;";
    t.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach(b => { b.style.opacity = ".55"; b.style.borderTopColor = "transparent"; });
      t.style.opacity = "1"; t.style.borderTopColor = "#2962ff";
      renderCat(cat);
    });
    tabs.appendChild(t);
  });
  wrap.append(head, grid, tabs);
  document.body.appendChild(wrap);
  const startIdx = _emojiRecent().length ? 0 : 1;   // 有最近→最近分頁,否則笑臉
  tabs.children[startIdx].click();
  document.addEventListener("keydown", esc, true);
  setTimeout(() => document.addEventListener("pointerdown", off, true), 0);   // 延一拍避開這次點擊
}

function setDrawTool(tool) {
  drawTool = tool;
  selectedId = null;
  drawingWIP = null;
  document.getElementById("cpPopup")?.classList.remove("open");
  _updateCursor();
  _scheduleRenderDrawings();
}

function _returnToPointer() {
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.remove("active"));
  document.querySelectorAll("[data-tool='pointer']").forEach(b => b.classList.add("active"));
  setDrawTool("pointer");
}

/* ── 事件處理（掛在 chartEl capture 上） ── */
function _onChartMouseMove(e) {
  const { x, y } = _canvasXY(e);
  _mx = x; _my = y;

  // VP 截止線拖動中：x → 最近 K 棒時間，更新統計範圍
  if (_vpDrag) {
    e.stopPropagation?.();
    const lg = mainChart.timeScale().coordinateToLogical(x);
    if (lg != null && ohlcvData.length) {
      let idx = Math.round(lg);
      idx = Math.max(0, Math.min(ohlcvData.length - 1, idx));
      _vpCutTime = toTime(ohlcvData[idx].time);
      _scheduleRenderDrawings();
    }
    return;
  }

  if (dragState) {
    e.stopPropagation();   // 拖移時不讓 LWC 處理 pan
    _updateDrag(x, y);
    return;
  }

  // 靠近 VP 截止線「頂端把手」(pointer 模式)→ 游標提示可左右拖。
  // ⚠ 限 y≤24(頂端把手區)：全高判定會劫持靠近線的「平移」(主圖拖不動+誤拖出黃線)。
  if (drawTool === "pointer" && _vpOn && _vpLineLastX != null && Math.abs(x - _vpLineLastX) <= 8 && y <= 24) {
    const chartEl = document.getElementById("mainChart");
    if (chartEl) chartEl.style.cursor = "ew-resize";
    if (hoveredId !== null) { hoveredId = null; _scheduleRenderDrawings(); }
    return;
  }

  if (drawTool === "pointer" || drawTool === "eraser") {
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    const nid  = near?.id ?? null;
    if (nid !== hoveredId) { hoveredId = nid; _updateCursor(); _scheduleRenderDrawings(); }
  } else if (drawTool !== "crosshair") {
    _scheduleRenderDrawings();   // 預覽線
  }
  // crosshair / pointer 無 hover → 不攔截，LWC 正常顯示十字（鉛直線由 charts.js 的 pane-vline 處理）
}

function _onChartMouseDown(e) {
  if (e.button !== 0) return;
  _watchAxis(1200);   // 按下可能拖動價格軸/平移 → 開追蹤窗,期間軸一動繪圖即跟隨(不偏離原價位)
  const { x, y } = _canvasXY(e);

  // VP 截止線拖動：只認「頂端把手」(y≤24)——全高判定會劫持平移(使用者回報主圖拖不動/黃線亂跑)
  if (_vpOn && _vpLineLastX != null && (drawTool === "pointer" || drawTool === "crosshair")
      && Math.abs(x - _vpLineLastX) <= 8 && y <= 24) {
    e.stopPropagation?.();
    _vpDrag = true;
    _updateCursor();
    _scheduleRenderDrawings();
    return;
  }

  // 只有 pointer 模式且滑鼠在線上才啟動拖移
  if (drawTool === "pointer") {
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    // ⚠ 鎖定的繪圖:不攔截點擊(讓 LWC 正常平移穿過)、不啟動拖移 → 「鎖住」不會被誤拖。右鍵/雙擊仍可開選單解鎖。
    if (near && !near.locked) {
      e.stopPropagation();   // 阻止 LWC pan
      selectedId = near.id;
      dragState  = { id: near.id, startX: x, startY: y, moved: false,
                     snapshot: JSON.parse(JSON.stringify(near)),
                     part: _drawingHitPart(near, x, y) };
      _updateCursor();
      _scheduleRenderDrawings();
    }
  }
  // 其他工具：讓 LWC 正常處理
}

function _onChartMouseUp() {
  if (_vpDrag) { _vpDrag = false; _updateCursor(); _scheduleRenderDrawings(); return; }
  if (!dragState) return;
  if (dragState.moved) {
    saveDrawings();
    _dragJustMoved = true;  // 抑制緊接的 click 事件，避免意外開啟顏色面板
  }
  dragState = null;
  _updateCursor();
  _scheduleRenderDrawings();
}

function _onChartClick(e) {
  if (_dragJustMoved) { _dragJustMoved = false; return; }
  const { x, y } = _canvasXY(e);

  if (drawTool === "pointer") {
    if (dragState?.moved) return;
    const near = findNearest(x, y, _magnetMode ? 20 : 12);
    if (near) {
      // 單擊：只選取繪圖（顯示控制點），不自動開色盤——避免點到文字/盈虧比盒就跳調色盤
      // 改色請用右鍵 context menu 或 dblclick
      selectedId = near.id;
      e.stopPropagation();
      document.getElementById("cpPopup")?.classList.remove("open");
    } else {
      // 沒命中既有繪圖 → 取消選取（點擊訊號棒的自動盈虧比已移除，改為 hover 策略棒顯示止損線）
      selectedId = null;
      document.getElementById("cpPopup")?.classList.remove("open");
    }
    _scheduleRenderDrawings();
    return;
  }

  if (drawTool === "crosshair") return;

  // 繪圖工具：攔截 click 讓 LWC 不處理
  e.stopPropagation();

  const pt = screenToChart(x, y);
  if (!pt) return;

  if (drawTool === "eraser") { eraseNear(x, y); return; }

  if (drawTool === "hline") {
    _pushDraw({ id:_did(), type:"hline", price:pt.price, color:_drawColor });
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "vline") {
    _pushDraw({ id:_did(), type:"vline", time:pt.time, color:_drawColor });
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "avwap") {
    // 錨定 VWAP：點一根 K 棒起算(往後累積);曲線在 drawOne 依 ohlcvData 現算
    _pushDraw({ id:_did(), type:"avwap", time:pt.time, color:_drawColor });
    saveDrawings(); _returnToPointer(); return;
  }
  if (drawTool === "text") {
    _showTextInput(e.clientX, e.clientY, txt => {
      if (txt?.trim()) {
        _pushDraw({ id:_did(), type:"text", time:pt.time, price:pt.price, text:txt.trim(), color:_drawColor });
        saveDrawings();
      }
      _returnToPointer();
    });
    return;
  }
  if (drawTool === "emoji") {
    _showEmojiPicker(e.clientX, e.clientY, em => {
      if (em) {
        _pushDraw({ id:_did(), type:"emoji", time:pt.time, price:pt.price, text:em, size:28, barRef:_emojiBarSp() });
        saveDrawings();
      }
      _returnToPointer();
    });
    return;
  }

  // 做多盈虧比（longpos）
  if (drawTool === "longpos") {
    if (!drawingWIP) {
      drawingWIP = { type:"longpos", p1:pt };
    } else {
      const entry = drawingWIP.p1.price;
      const clicked = pt.price;
      let tp, sl;
      if (clicked >= entry) {
        tp = clicked;
        sl = entry - (tp - entry);
      } else {
        sl = clicked;
        tp = entry + (entry - sl);
      }
      // 色塊寬度 = 兩次點擊的水平距離（換算成 K棒數）
      const _ex1 = _timeToX(drawingWIP.p1.time);
      const _ex2 = _timeToX(pt.time);
      const _vr  = mainChart.timeScale().getVisibleLogicalRange();
      const _bv  = _vr ? Math.max(10, _vr.to - _vr.from) : 50;
      const _ppb = _cssW() / _bv;
      const _bw  = Math.max(3, Math.round(Math.abs((_ex2 ?? 0) - (_ex1 ?? 0)) / _ppb));
      _pushDraw({ id:_did(), type:"longpos", p1:drawingWIP.p1, tp, sl, color:_drawColor, barWidth:_bw });
      drawingWIP = null;
      saveDrawings(); _returnToPointer();
    }
    return;
  }

  // 做空盈虧比（shortpos）
  if (drawTool === "shortpos") {
    if (!drawingWIP) {
      drawingWIP = { type:"shortpos", p1:pt };
    } else {
      const entry = drawingWIP.p1.price;
      const clicked = pt.price;
      let tp, sl;
      if (clicked <= entry) {
        tp = clicked;
        sl = entry + (entry - tp);
      } else {
        sl = clicked;
        tp = entry - (sl - entry);
      }
      const _ex1s = _timeToX(drawingWIP.p1.time);
      const _ex2s = _timeToX(pt.time);
      const _vrs  = mainChart.timeScale().getVisibleLogicalRange();
      const _bvs  = _vrs ? Math.max(10, _vrs.to - _vrs.from) : 50;
      const _ppbs = _cssW() / _bvs;
      const _bws  = Math.max(3, Math.round(Math.abs((_ex2s ?? 0) - (_ex1s ?? 0)) / _ppbs));
      _pushDraw({ id:_did(), type:"shortpos", p1:drawingWIP.p1, tp, sl, color:_drawColor, barWidth:_bws });
      drawingWIP = null;
      saveDrawings(); _returnToPointer();
    }
    return;
  }

  /* 連續箭頭（path）：多點累積，雙擊或按 Esc 收尾（TradingView 的「路徑」）。
     ⚠ 與雙點工具分開處理：雙點工具第二下就結束，path 要一直收點直到使用者說停。 */
  if (drawTool === "path") {
    if (!drawingWIP || drawingWIP.type !== "path") drawingWIP = { type: "path", pts: [pt] };
    else {
      /* ★ 2026-08-05「路徑還是不能雙擊完成」：不要只靠 dblclick 事件收尾。
         dblclick 在觸控裝置（iPad 雙擊）與「兩下間隔稍慢」時根本不會發出 → 路徑永遠結束不了。
         改成看**位置**：這一點落在上一點 12px 內就當作收尾。
         這同時把雙擊也一起修好了 —— 雙擊的第二下必然落在第一下附近，
         不管瀏覽器有沒有真的派送 dblclick，都會走到這裡。原本的 dblclick 分支保留（先到先算）。 */
      const prev = drawingWIP.pts[drawingWIP.pts.length - 1];
      const px = _timeToX(prev.time), py = candleSeries?.priceToCoordinate(prev.price);
      if (drawingWIP.pts.length >= 2 && px != null && py != null &&
          Math.hypot(x - px, y - py) <= 12) { _finishPath(); return; }
      drawingWIP.pts.push(pt);
    }
    _scheduleRenderDrawings();
    return;
  }
  // 雙點工具（trendline / ray / fib / circle）
  if (!drawingWIP) {
    drawingWIP = { type:drawTool, p1:pt };
  } else {
    // 按住 Shift → 第二點的價格取第一點的，畫出水平線
    const p2 = _hSnapOn(drawTool) ? { ...pt, price: drawingWIP.p1.price } : pt;
    _pushDraw({ id:_did(), type:drawTool, p1:drawingWIP.p1, p2, color:_drawColor });
    drawingWIP = null;
    saveDrawings(); _returnToPointer();
    _scheduleRenderDrawings();
  }
}

/* 收尾連續箭頭：<2 點就丟棄（點一下就切工具的情況），否則存成一筆 path。
   ⚠ 掛上 window 給 ui.js 的 Esc 處理器呼叫：那支在 bundle 裡、比延遲載入的 draw.js **先註冊**，
     會直接 `drawingWIP = null` —— 我原本在 draw.js 自己聽 Esc，等跑到時 WIP 早被清掉了
     （實測：WIP 明明有 3 點，Esc 後卻沒新增任何東西）。改成由那支唯一入口先問過這裡。 */
function _finishPath() {
  const w = drawingWIP;
  drawingWIP = null;
  if (!w || w.type !== "path" || !w.pts || w.pts.length < 2) { _scheduleRenderDrawings(); return; }
  _pushDraw({ id: _did(), type: "path", pts: w.pts, color: _drawColor });
  saveDrawings(); _returnToPointer(); _scheduleRenderDrawings();
}
window._finishPath = _finishPath;

function _onChartDblClick(e) {
  // 連續箭頭：雙擊＝收尾（最後那次單擊已經把點加進去了，這裡不再加）
  if (drawTool === "path" && drawingWIP && drawingWIP.type === "path") { _finishPath(); return; }
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (near) {
    // 雙擊：選取 + 開色盤（單擊不開，避免誤觸）
    e.stopPropagation();
    selectedId = near.id;
    showDrawColorPicker(near, e.clientX, e.clientY);
    _scheduleRenderDrawings();
    return;
  }
}

function _onChartContextMenu(e) {
  const { x, y } = _canvasXY(e);
  const near = findNearest(x, y, 16);
  if (near) {
    e.preventDefault();
    e.stopPropagation();
    selectedId = near.id;
    showDrawColorPicker(near, e.clientX, e.clientY);
    _scheduleRenderDrawings();
    return;
  }
  if (drawTool === "crosshair" || drawTool === "pointer") return;
  e.preventDefault();
  e.stopPropagation();
  drawingWIP = null;
  _scheduleRenderDrawings();
}

/* ── 拖移 ── */
function _updateDrag(x, y) {
  if (!dragState) return;
  const d = drawings.find(d => d.id === dragState.id);
  if (!d) return;
  const dx = x - dragState.startX, dy = y - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) > 3) dragState.moved = true;
  if (!dragState.moved) return;
  const orig = dragState.snapshot;

  if (d.type === "hline") {
    const oy = candleSeries?.priceToCoordinate(orig.price);
    if (oy != null) d.price = candleSeries?.coordinateToPrice(oy + dy) ?? orig.price;
  } else if ((d.type === "longpos" || d.type === "shortpos") && d.p1) {
    const part = dragState.part || "entry";
    if (part === "tp") {
      // 獨立拖移停利線
      const oty = candleSeries?.priceToCoordinate(orig.tp);
      if (oty != null) d.tp = candleSeries?.coordinateToPrice(oty + dy) ?? orig.tp;
    } else if (part === "sl") {
      // 獨立拖移停損線
      const osy = candleSeries?.priceToCoordinate(orig.sl);
      if (osy != null) d.sl = candleSeries?.coordinateToPrice(osy + dy) ?? orig.sl;
    } else if (part === "width") {
      // 拖移左邊緣調整色塊寬度（往左拉→變寬，往右推→變窄）
      const visR = mainChart.timeScale().getVisibleLogicalRange();
      const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
      const W2 = _cssW();
      d.barWidth = Math.max(3, (orig.barWidth ?? 3) + Math.round(dx / (W2 / barsV)));
    } else {
      // entry：整體平移（TP/SL 跟隨）
      const oy = candleSeries?.priceToCoordinate(orig.p1.price);
      if (oy != null) {
        const newEntry  = candleSeries?.coordinateToPrice(oy + dy) ?? orig.p1.price;
        const entryDiff = newEntry - orig.p1.price;
        d.p1 = { ...orig.p1, price: newEntry };
        d.tp = orig.tp + entryDiff;
        d.sl = orig.sl + entryDiff;
      }
      const ox = _timeToX(orig.p1.time);
      if (ox != null) { const nt = _xToTime(ox + dx); if (nt != null) d.p1 = { ...d.p1, time: nt }; }
    }
  } else if (d.type === "vline" || d.type === "avwap") {
    const ox = _timeToX(orig.time);
    if (ox != null) { const nt = _xToTime(ox + dx); if (nt != null) d.time = nt; }
  } else if (d.type === "emoji" && dragState.part === "size") {
    // 拖右下角把手縮放：中心到游標的最大軸距 ×2 ＝ emoji 邊長（12~300）
    const p = chartToScreen(d.time, d.price);
    if (p) { const s = Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) * 2; d.size = Math.max(12, Math.min(300, Math.round(s))); d.barRef = _emojiBarSp() || d.barRef; }   // 縮放把手拖動後重新錨定當下縮放
  } else if (d.type === "text" || d.type === "emoji") {
    const op = chartToScreen(orig.time, orig.price);
    if (op) { const np = screenToChart(op.x + dx, op.y + dy); if (np) { d.time = np.time; d.price = np.price; } }
  } else if (d.type === "path" && Array.isArray(d.pts)) {
    const part = dragState.part || "";
    const m = part.match(/^pt(\d+)$/);
    if (m) {                                   // 拖單一轉折點
      const i = +m[1];
      const np = screenToChart(x, y);
      if (np && d.pts[i]) d.pts[i] = { time: np.time, price: np.price };
    } else {
      /* 整體移動：與雙點圖形同樣的原則 —— 只換算一個參考點，其餘用原本的差量跟著走。
         各點各自 screenToChart 會被磁吸/量化扯歪形狀（見 _drawHtfOpens 上方那次的教訓）。 */
      const o0 = orig.pts && orig.pts[0];
      if (o0) {
        const a0 = chartToScreen(o0.time, o0.price);
        if (a0) {
          const na = screenToChart(a0.x + dx, a0.y + dy);
          if (na) d.pts = orig.pts.map((q, i) => i === 0
            ? { time: na.time, price: na.price }
            : { time: na.time + (q.time - o0.time), price: na.price + (q.price - o0.price) });
        }
      }
    }
  } else if (d.p1 && d.p2) {
    const part = dragState.part;
    if (part === "p1") {
      const np = screenToChart(x, y);
      // 拖端點時按住 Shift 一樣鎖水平（對齊另一端的價格）
      if (np) d.p1 = { time: np.time, price: _hSnapOn(d.type) ? d.p2.price : np.price };
    } else if (part === "p2") {
      const np = screenToChart(x, y);
      if (np) d.p2 = { time: np.time, price: _hSnapOn(d.type) ? d.p1.price : np.price };
    } else {
      /* 整體移動：只換算「一個」參考點，另一點用原本的時間/價格差量推回去。
         ★ 2026-08-03 修的 bug（使用者回報「畫好的矩形移動他大小會變」）：
           原本兩個角**各自**呼叫 screenToChart，而它會套磁吸 → 兩角各吸到不同 K 棒的
           OHLC，形狀就被扯歪；就算關掉磁吸，_xToTime 也會把兩角各自量化到最近的棒，
           拖曳過程仍會左右各差一根、寬度抖動。
           改成只有 p1 吃磁吸/量化，p2 = p1 + 原本的差量 → 移動時形狀**完全不變**。
         ⚠ 這個分支吃的是所有雙點圖形（rect / trendline / ray / arrow / fib …），
           不是只有矩形，所以全部一起修好。 */
      const a = chartToScreen(orig.p1.time, orig.p1.price);
      if (a) {
        const na = screenToChart(a.x + dx, a.y + dy);
        if (na) {
          d.p1 = { time: na.time, price: na.price };
          d.p2 = { time:  na.time  + (orig.p2.time  - orig.p1.time),
                   price: na.price + (orig.p2.price - orig.p1.price) };
        }
      }
    }
  }
  _scheduleRenderDrawings();
}

/* ── 顏色 Popup ── */
function showDrawColorPicker(drawing, clientX, clientY) {
  if (!window._cpShowDirect) return;
  const noStyle = drawing.type === "note" || drawing.type === "emoji";   // emoji 無顏色/樣式,色盤只留刪除
  window._cpShowDirect(clientX, clientY, {
    sections: [{
      label: null,
      currentColor: (drawing.color || "#2962ff").substring(0, 7),
      apply: c => {
        drawing.color = c;
        _rememberDrawColor(c, false);   // 只改這一條；同時記成「當前時框的預選色」
        saveDrawings();
        _scheduleRenderDrawings();
      }
    }],
    onDelete: () => {
      drawings = drawings.filter(d => d.id !== drawing.id);
      if (selectedId === drawing.id) selectedId = null;
      saveDrawings();
      _scheduleRenderDrawings();
    },
    showStyle: !noStyle,
    currentWidth: drawing.width || 1,
    currentLineStyle: drawing.lineStyle ?? 0,
    onStyleChange: (w, s) => {
      drawing.width = w; drawing.lineStyle = s;
      saveDrawings(); _scheduleRenderDrawings();
    },
    extraActions: [
      { label: drawing.locked ? "🔓 解鎖" : "🔒 鎖定", active: !!drawing.locked,
        onClick: () => {
          drawing.locked = !drawing.locked;
          if (drawing.locked && selectedId === drawing.id) selectedId = null;   // 鎖定即取消選取,避免殘留把手
          saveDrawings(); _scheduleRenderDrawings();
        } },
      { label: (drawing.text ? "✎ 改文字" : "✎ 加文字"),
        onClick: () => {
          const cur = drawing.text || "";
          const t = window.prompt("繪圖文字(顯示在上方;清空移除):", cur);
          if (t === null) return;                 // 取消
          drawing.text = t.trim() || undefined;   // 空字串→移除
          saveDrawings(); _scheduleRenderDrawings();
        } },
    ],
  });
}

/* ── 圖例 / K棒 顏色 Popup（無刪除按鈕）── */
// sections: [{ label, currentColor, apply }]
function showLegColorPopup(clientX, clientY, sections) {
  // 極簡模式：完全鎖住所有色票調整，使用固定的系統配色
  if (document.documentElement.classList.contains("perf-mode")) return;
  if (!window._cpShowDirect) return;
  window._cpShowDirect(clientX, clientY, { sections, onDelete: null });
}

// 磁吸(TV 風)：掃描游標附近 ±_MAG_SCAN 根,對每根的 O/H/L/C 逐點算「2D 像素距離」,
// 吸最近的那個 OHLC 點(半徑 _MAG_R px 內才吸)→ 落在兩棒間也能吸到正確候選,不再只看正下方那根、不再只比 Y。
const _MAG_SCAN = 2;    // 左右各掃幾根
const _MAG_R = 24;      // 吸附半徑(px)
function _magnetSnap(x, y) {
  if (!ohlcvData.length || !candleSeries) return null;
  const ts = mainChart.timeScale();
  const curTime = ts.coordinateToTime(x);
  if (curTime == null) return null;
  let lo = 0, hi = ohlcvData.length - 1;      // 二分找時間最近的棒
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toTime(ohlcvData[mid].time) < curTime) lo = mid + 1; else hi = mid;
  }
  let best = null, bestD = _MAG_R * _MAG_R;
  for (let i = Math.max(0, lo - _MAG_SCAN); i <= Math.min(ohlcvData.length - 1, lo + _MAG_SCAN); i++) {
    const bar = ohlcvData[i];
    const bx = ts.timeToCoordinate(toTime(bar.time));
    if (bx == null) continue;
    for (const price of [bar.open, bar.high, bar.low, bar.close]) {
      if (price == null) continue;
      const py = candleSeries.priceToCoordinate(price);
      if (py == null) continue;
      const d = (bx - x) * (bx - x) + (py - y) * (py - y);
      if (d < bestD) { bestD = d; best = { x: bx, y: py, time: toTime(bar.time), price }; }
    }
  }
  return best;
}

function screenToChart(x, y) {
  if (_magnetMode) {
    const snapped = _magnetSnap(x, y);
    if (snapped) return snapped;
  }
  const time  = _xToTime(x);
  const price = candleSeries?.coordinateToPrice(y);
  if (time == null || price == null) return null;
  return { x, y, time, price };
}

function chartToScreen(time, price) {
  const x = _timeToX(time);
  const y = candleSeries?.priceToCoordinate(price);
  return (x != null && y != null && isFinite(x) && isFinite(y)) ? { x, y } : null;
}

function eraseNear(x, y) {
  let best = 14, idx = -1;
  drawings.forEach((d, i) => {
    if (!_layerOn(d)) return;                  // 隱藏層不能被橡皮擦誤刪
    const dist = drawingDist(d, x, y);
    if (dist < best) { best = dist; idx = i; }
  });
  if (idx >= 0) { drawings.splice(idx, 1); _scheduleRenderDrawings(); }
}

function drawingDist(d, x, y) {
  if (d.type === "hline") {
    // 只在右側價格軸區域（x > 繪圖區寬）不攔截，讓 LWC 處理上下拖移；
    // 最新K棒右邊的空白處仍在繪圖區內 → 可正常命中 hline
    if (x > _plotW()) return Infinity;
    const py = candleSeries?.priceToCoordinate(d.price);
    return py != null ? Math.abs(py - y) : Infinity;
  }
  if (d.type === "vline") {
    const px = _timeToX(d.time);
    return px != null ? Math.abs(px - x) : Infinity;
  }
  if (d.type === "avwap") {
    // 命中判定：游標 x→時間→二分找曲線最近點,比 y 距離(O(log n),不掃全序列)
    const curve = _avwapCurve(d);
    if (!curve || !curve.length) return Infinity;
    const ct = _xToTime(x);
    if (ct == null || ct < curve[0].t) return Infinity;   // 錨點左側不命中
    let lo = 0, hi = curve.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (curve[mid].t < ct) lo = mid + 1; else hi = mid; }
    let pt = curve[lo];
    if (lo > 0 && Math.abs(curve[lo - 1].t - ct) < Math.abs(pt.t - ct)) pt = curve[lo - 1];
    if (pt.v == null) return Infinity;
    const py = candleSeries?.priceToCoordinate(pt.v);
    return py != null ? Math.abs(py - y) : Infinity;
  }
  if (d.type === "text" || d.type === "emoji") {
    const p = chartToScreen(d.time, d.price);
    if (!p) return Infinity;
    if (d.type === "emoji") {   // 依 emoji 方框判定,放大後整塊都點得到
      const h = _emojiSize(d) / 2;
      return Math.hypot(Math.max(Math.abs(x - p.x) - h, 0), Math.max(Math.abs(y - p.y) - h, 0));
    }
    return Math.hypot(p.x - x, p.y - y);
  }
  if ((d.type === "longpos" || d.type === "shortpos") && d.p1) {
    const W2 = _cssW();
    const startX = _timeToX(d.p1.time);
    if (startX == null) return Infinity;
    const visR  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const zw    = Math.max(20, Math.min(W2 * 0.4, Math.round(W2 * (d.barWidth ?? 3) / barsV)));
    const ex = startX, rx3 = Math.min(W2, ex + zw);
    if (x < ex - 10) return Infinity;
    if (x > rx3 + 20 && x < W2 - 100) return Infinity;
    const ey = candleSeries?.priceToCoordinate(d.p1.price);
    const ty = candleSeries?.priceToCoordinate(d.tp);
    const sy = candleSeries?.priceToCoordinate(d.sl);
    // inside the colored zone → always a hit
    if (ey != null && ty != null && sy != null) {
      const zTop = Math.min(ty, sy), zBot = Math.max(ty, sy);
      if (x >= ex && x <= rx3 && y >= zTop && y <= zBot) return 4;
    }
    const dists = [ey, ty, sy].filter(v => v != null).map(v => Math.abs(v - y));
    return dists.length ? Math.min(...dists) : Infinity;
  }
  if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    if (x < Math.min(a.x, b.x) - 10) return Infinity;
    const priceRange = d.p2.price - d.p1.price;
    const dists = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map(lvl => {
      const price = d.p1.price + priceRange * (1 - lvl);
      const ly = candleSeries?.priceToCoordinate(price);
      return ly != null ? Math.abs(ly - y) : Infinity;
    });
    return Math.min(...dists);
  }
  if ((d.type === "rect" || d.type === "measure") && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rX = Math.max(a.x, b.x), rY = Math.max(a.y, b.y);
    // 邊框附近或框內都可選：算到矩形的距離(框內=0)
    const ddx = Math.max(rx - x, 0, x - rX), ddy = Math.max(ry - y, 0, y - rY);
    const dEdge = Math.hypot(ddx, ddy);
    if (dEdge > 0) return dEdge;                       // 框外→到框距離
    // 框內：靠近邊框才算命中(避免整個大框都攔截點擊、擋住底下K棒/其他繪圖)
    const nearEdge = Math.min(x - rx, rX - x, y - ry, rY - y);
    return nearEdge <= 8 ? 2 : Infinity;
  }
  if (d.type === "path" && Array.isArray(d.pts) && d.pts.length >= 2) {
    // 逐段取「點到線段」的最短距離
    let best = Infinity, prev = null;
    for (const q of d.pts) {
      const c = chartToScreen(q.time, q.price);
      if (!c) { prev = null; continue; }
      if (prev) {
        const dx = c.x - prev.x, dy = c.y - prev.y, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - prev.x) * dx + (y - prev.y) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - (prev.x + t * dx), y - (prev.y + t * dy)));
      }
      prev = c;
    }
    return best;
  }
  if (d.type === "circle" && d.p1 && d.p2) {
    // 橢圓內接於 p1/p2 圍成的框；用「歸一化半徑」判斷離邊框多遠（框內不整片攔截，同 rect）
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (rx < 1 || ry < 1) return Infinity;
    const k = Math.hypot((x - cx) / rx, (y - cy) / ry);      // 1 = 正好在邊上
    return Math.abs(k - 1) * Math.min(rx, ry);               // 換算回大約的像素距離
  }
  if (d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) return Infinity;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx*dx + dy*dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x-a.x)*dx+(y-a.y)*dy)/len2)) : 0;
    return Math.hypot(x-(a.x+t*dx), y-(a.y+t*dy));
  }
  return Infinity;
}

// 交易時段（依市場自動切換）：
//   股票(台/美/港)：週一~五、台灣固定時間 8:00-12:00=台股、14:00-17:00=歐洲、20:00-23:00=美盤。
//   加密(24/7)：ICT/JadeCap killzone、全週、且隨日光節約(夏/冬令)平移——
//     亞洲=東京 09:00-15:00(JST 固定 UTC+9)、倫敦=倫敦當地 06:00-10:00(含法蘭克福盤前)、
//     紐約·交界=紐約當地 07:00-10:00(此時倫敦未收＝歐美兩盤重疊)。
//   三色 key(asia/europe/us)沿用，只有盤名(_SESSION_NAME/_CRYPTO)依市場不同。
const _SESSION_INTRADAY = ["1m", "5m", "15m", "30m", "1h", "2h"];
// weekend＝加密週末(傳統外匯/期貨休市)：中性灰、很淡，不當 killzone、不強調高低。
// 2026-08-14 使用者：「三盤的顏色標示在但有一些淡」→ 底色由 0.04~0.055 調到 0.065~0.10（約 1.8x）。
// ⚠ 這是**疊在 K 棒下方的大面積填色**，太濃會蓋掉影線與量柱 → 只加到「看得出分界」為止，不要再往上。
const _SESSION_COLOR = { asia: "rgba(66,133,244,0.10)", europe: "rgba(124,104,228,0.10)", us: "rgba(255,159,40,0.09)", weekend: "rgba(130,130,145,0.065)" };
const _SESSION_LINE  = { asia: "rgba(66,133,244,0.9)",  europe: "rgba(150,130,245,0.85)", us: "rgba(255,159,40,0.9)", weekend: "rgba(150,150,162,0.6)" };
const _SESSION_NAME  = { asia: "台股", europe: "歐洲", us: "美盤", weekend: "週末" };
const _SESSION_NAME_CRYPTO = { asia: "亞洲", europe: "倫敦", us: "紐約·交界", weekend: "週末薄量" };
const _SESSION_COLOR_HR = { asia: "rgba(66,133,244,0.21)", europe: "rgba(124,104,228,0.21)", us: "rgba(255,159,40,0.20)", weekend: "rgba(130,130,145,0.065)" };  // 開盤首段深底色（同步調濃，維持與底色的層次差）
const _SESSION_HL_SEC   = { asia: 3600, europe: 3600, us: 3600, weekend: 3600 };   // 開盤加深時長：三盤皆前 1 小時
const _WEEKDAY = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
// 開關（頂部按鈕；預設開）
let _sessionOn = (() => { try { return localStorage.getItem("sessionOverlay") !== "0"; } catch (e) { return true; } })();
let _weekBoxOn = (() => { try { return localStorage.getItem("weekBox") !== "0"; } catch (e) { return true; } })();   // 週框(週一~五框)獨立開關；預設開
// 目前市場（每幀繪製前由 _drawSessionOverlay 更新；換市場即清時段快取）。加密與股票同一時刻分盤不同，快取 key 必含市場。
let _curSessMkt = "crypto";
const _SESSION_NAME_OF = (sess) => (_curSessMkt === "crypto" ? _SESSION_NAME_CRYPTO : _SESSION_NAME)[sess];
// DST 感知：某時區在某 UTC 日的偏移小時（倫敦/紐約夏冬令自動跟著平移）。以「tz:UTC日」記憶化。
const _tzOffCache = new Map();
function _tzOff(u, tz) {
  const dk = Math.floor(u / 86400), key = tz + ":" + dk;
  const hit = _tzOffCache.get(key);
  if (hit !== undefined) return hit;
  let v = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date(u * 1000));
    const o = (parts.find(p => p.type === "timeZoneName") || {}).value || "GMT+0";   // 例 "GMT+1" / "GMT-4"
    const m = o.match(/GMT([+-]?\d+)(?::(\d+))?/);
    if (m) v = Number(m[1]) + (m[2] ? Math.sign(Number(m[1]) || 1) * Number(m[2]) / 60 : 0);
  } catch (e) { v = 0; }
  _tzOffCache.set(key, v);
  return v;
}
// 時段/星期只取決於時間戳（+市場） → 記憶化（同一根 K 每幀被查多遍，避免每次都 new Date/Intl）。
const _sessCache = new Map();
const _dayCache = new Map();
function _dayOf(t) {
  let v = _dayCache.get(t);
  if (v !== undefined) return v;
  v = new Date(toTime(t) * 1000).getUTCDay();   // toTime 已 +8h → UTC getter 得台北時間
  _dayCache.set(t, v);
  return v;
}
function _sessionOf(t) {
  const ck = _curSessMkt + ":" + t;
  let v = _sessCache.get(ck);
  if (v !== undefined) return v;
  if (_curSessMkt === "crypto") {
    // 加密 24/7，但週末傳統機構休市(外匯/CME 期貨關) → 週六日不畫 killzone，改標「週末薄量」。
    const u = toTime(t) - 8 * 3600;                          // 真實 UTC 秒（toTime 已 +8h）
    const dow = new Date(u * 1000).getUTCDay();              // 0=週日、6=週六（以 UTC 曆日近似市場週末）
    if (dow === 0 || dow === 6) { v = "weekend"; }
    else {
      const hUTC = (((u % 86400) + 86400) % 86400) / 3600;   // 0..24 UTC 小時
      const hTok = (hUTC + 9) % 24;                          // 東京固定 UTC+9
      if (hTok >= 9 && hTok < 15) v = "asia";
      else {
        const hLon = ((hUTC + _tzOff(u, "Europe/London")) % 24 + 24) % 24;
        if (hLon >= 6 && hLon < 10) v = "europe";           // 倫敦(含盤前)
        else {
          const hNy = ((hUTC + _tzOff(u, "America/New_York")) % 24 + 24) % 24;
          v = (hNy >= 7 && hNy < 10) ? "us" : null;         // 紐約·歐美交界
        }
      }
    }
  } else {
    // 股票：台灣固定時間、僅週一~五。
    const d = new Date(toTime(t) * 1000);
    const day = d.getUTCDay();
    if (day < 1 || day > 5) v = null;
    else {
      const h = d.getUTCHours();
      v = (h >= 8 && h < 12) ? "asia"
        : (h >= 14 && h < 17) ? "europe"
        : (h >= 20 && h < 23) ? "us" : null;
    }
  }
  _sessCache.set(ck, v);
  return v;
}
// 交易時段區段快取：把整份 ohlcvData 切成連續同盤的「區段」並預存當盤高/低點。
// 過去每幀(平移/縮放)都對可見每根 K 重算高低 → 拉遠時上千根，是盤中滑動唯一重負載。
// 改成只在資料變動(長度/首尾時戳/時框)時算一次，每幀只做座標換算 → 滑動全程也能畫且不卡。
let _sessRuns = null, _sessRunsKey = "";
function _getSessionRuns() {
  const n = ohlcvData.length;
  const key = n + "|" + (n ? ohlcvData[0].time + "_" + ohlcvData[n - 1].time : "") + "|" + (typeof currentTF !== "undefined" ? currentTF : "") + "|" + _curSessMkt;
  if (_sessRunsKey === key && _sessRuns) return _sessRuns;
  const runs = [];
  let s = -1, cur = null, hi = -Infinity, lo = Infinity;
  for (let i = 0; i < n; i++) {
    const sess = _sessionOf(ohlcvData[i].time);
    if (sess !== cur) {
      if (cur && s >= 0) runs.push({ s, e: i - 1, sess: cur, hi, lo });
      s = i; cur = sess; hi = -Infinity; lo = Infinity;
    }
    if (cur) { const b = ohlcvData[i]; if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  }
  if (cur && s >= 0) runs.push({ s, e: n - 1, sess: cur, hi, lo });
  _sessRuns = runs; _sessRunsKey = key;
  return runs;
}
// K 棒後方：①各交易時段淡色直條 ②各盤當盤高/低點虛線 ③星期標籤。只在日內時框、且開關開啟。
function _drawSessionOverlay(W, H) {
  // 星期標籤(③)永遠顯示——不受右上「交易時段」開關(_sessionOn)控制；
  // 交易時段色塊/高低線/開盤標記(①②④)只在『細日內時框』(_SESSION_INTRADAY)；
  // 星期標籤放寬到『日內時框 + 4h』(4h 每天 6 根、換日標「週X」有意義；日/週/月線不標)。
  // 市場感知：換市場時分盤定義不同 → 清時段快取並強制重算區段（在 _getSessionRuns 之前）。
  const _mk = document.getElementById("marketSelect")?.value || "crypto";
  if (_mk !== _curSessMkt) { _curSessMkt = _mk; _sessCache.clear(); _sessRuns = null; _sessRunsKey = ""; }
  const _tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const _boxTF = _SESSION_INTRADAY.includes(_tf);
  const _sessTF = _boxTF || _tf === "4h";                // 交易時段色塊：日內細時框 + 4h(每天三根對上亞/歐/美盤)；1d 不算
  const _fhTF = ["1m", "5m", "15m", "30m", "1h"].includes(_tf);   // 開盤首段深底色：僅 ≤1h 能對齊時間窗(2h/4h 一根太粗切不出)
  if (!_boxTF && _tf !== "4h" && _tf !== "1d") return;   // 星期標籤/週框：日內時框 + 4h + 日K
  if (typeof ohlcvData === "undefined" || !ohlcvData.length || typeof mainChart === "undefined") return;
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const _len = ohlcvData.length;
  const vFrom = Math.max(0, Math.floor(vr.from)), vTo = Math.min(_len - 1, Math.ceil(vr.to));
  if (vTo < vFrom) return;
  // 往兩側多算一段 buffer（涵蓋一個完整盤，最長 4h；5m=48 根）→ 邊緣盤的高低/標籤穩定，
  // 平移時不會因「最左根一直變」而閃。off-screen 的部分畫布會自然裁掉。
  const BUF = 64;
  const from = Math.max(0, vFrom - BUF);
  let to = Math.min(_len - 1, vTo + BUF);
  // 重播模式：ohlcvData 仍是全量、但圖上只到 replayIdx → 只算到「已揭曉」那根，
  // 不把未來棒算進來（否則當前盤 run 延到未來棒、其座標為 null，flush 會整塊畫不出；也避免用未來資料）。
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    to = Math.min(to, replayIdx);
  const half = (W / Math.max(1, vr.to - vr.from)) / 2;   // 半根 K 寬，讓條覆蓋到 K 邊緣
  // 裁切到繪圖區寬度（扣掉右側價格軸）→ 色塊/高低線/星期標籤平移到右側時不會蓋到右側價格軸
  let plotW = W;
  try {
    const tw = ts.width();
    if (tw > 0) plotW = tw;
    else { const pw = mainChart.priceScale("right").width(); if (pw > 0) plotW = W - pw; }
  } catch (e) {}
  // 繪圖區底（扣掉下方時間軸高）→ 直立線只畫到 K 棒區，不延伸進時間軸
  let plotBottom = H;
  try { const th = ts.height(); if (th > 0) plotBottom = H - th; } catch (e) {}
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  // ①②④ 色塊/高低線/開盤標記：受 _sessionOn 開關控制 + 日內細時框或 4h(1d 不算)。
  if (_sessionOn && _sessTF) {
  // 用預先算好的時段區段（含當盤高低）逐段畫 → 每幀只做座標換算，不再每根 K 重算高低。
  const runs = _getSessionRuns();
  for (const r of runs) {
    if (r.e < from || r.s > to) continue;       // 不在可見(+buffer)範圍 → 略過
    let endIdx = r.e, rHi = r.hi, rLo = r.lo;
    // 重播：區段若延伸到「尚未揭曉」的未來棒 → 只算到已揭曉那根（避免用未來資料/座標為 null）
    if (endIdx > to) {
      endIdx = to; rHi = -Infinity; rLo = Infinity;
      for (let i = r.s; i <= endIdx; i++) { const b = ohlcvData[i]; if (b.high > rHi) rHi = b.high; if (b.low < rLo) rLo = b.low; }
    }
    const x1 = ts.timeToCoordinate(toTime(ohlcvData[r.s].time));
    const x2 = ts.timeToCoordinate(toTime(ohlcvData[endIdx].time));
    if (x1 == null || x2 == null) continue;
    const L = x1 - half, R = x2 + half;
    const yH = candleSeries?.priceToCoordinate(rHi), yL = candleSeries?.priceToCoordinate(rLo);
    if (yH == null || yL == null) continue;
    // 色塊只填「當盤高點~低點」之間（上下緣＝高/低點，不上下無限延伸）
    /* 三盤色塊「移動中也照畫」（2026-08-05）。
       原本平移/縮放時會跳過這片半透明填色、只留上下緣線，停手 240ms 才補回
       —— 使用者回報「移動主圖時三盤中間的著色會消失」。
       ⚠ 這不是憑感覺放回去：DPR2、1600×1000、5m、三盤開著各量 100 幀，
         跳過填色 vs 一直填色 = 中位都 16.7ms、p90 17.3 vs 17.7、最長 17.9 vs 18.5，
         超過 20ms 的幀兩者都是 0。差距 0.6ms、同樣穩在 60fps → 這個犧牲已無必要
         （本輪其他優化把餘裕騰出來了）。日後若真的量到掉幀，再把條件加回來。 */
    {
      drawCtx.fillStyle = _SESSION_COLOR[r.sess];
      drawCtx.fillRect(L, yH, R - L, yL - yH);
      // 開盤首段深底色：亞/歐 前 1 小時、美 前 1.5 小時（時間窗；僅 ≤1h 時框對得齊）
      if (_fhTF) {
        const enT = toTime(ohlcvData[r.s].time) + (_SESSION_HL_SEC[r.sess] || 3600);
        let hL = null, hR = null;
        for (let i = r.s; i <= endIdx; i++) {
          if (toTime(ohlcvData[i].time) >= enT) break;
          const cx = ts.timeToCoordinate(toTime(ohlcvData[i].time));
          if (cx != null) { if (hL == null) hL = cx - half; hR = cx + half; }
        }
        if (hL != null && hR > hL) {
          drawCtx.fillStyle = _SESSION_COLOR_HR[r.sess];
          drawCtx.fillRect(hL, yH, hR - hL, yL - yH);
        }
      }
    }
    // 上下緣畫線強調高/低點
    drawCtx.save();
    drawCtx.strokeStyle = _SESSION_LINE[r.sess]; drawCtx.lineWidth = 1;
    drawCtx.beginPath(); drawCtx.moveTo(L, yH); drawCtx.lineTo(R, yH); drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.moveTo(L, yL); drawCtx.lineTo(R, yL); drawCtx.stroke();
    drawCtx.restore();
  }

  // ⑤ 亞/歐盤高低延伸線已移到獨立「關鍵高低」開關（_drawKeyLevels，gated by _pdhlOn）→
  //   不再綁在時段色塊開關，且時段疊加層更乾淨（配合「收斂色塊」需求）。

  // ④ 各盤「開盤」標記：該盤第一根 K（8:00台股 / 14:00歐洲 / 20:00美盤）一出現就標，
  //    不必等整盤收完。判定＝這根是某盤、且「真實前一根」不同盤（避免畫面左緣誤判開盤）。
  drawCtx.save();
  drawCtx.font = "bold 11px sans-serif"; drawCtx.textAlign = "left";
  //    ⚠ 直接用上面那份 runs：每個 run 的 r.s 依定義就是「該盤第一根」（前一根不同盤），
  //      與逐根重算的結果完全等價。原本每幀掃過所有可見棒、每根呼叫兩次 _sessionOf
  //      （滑動時 2000+ 根 × 2 次）→ 改成走 runs（整份資料才幾百段），_sessionOf 退出熱路徑。
  const _lo = Math.max(1, from);
  for (const r of runs) {
    if (r.s < _lo || r.s > to) continue;   // 不在可見範圍、或是第 0 根（左緣無前一根可比）
    const sess = r.sess;
    const x = ts.timeToCoordinate(toTime(ohlcvData[r.s].time));
    if (x == null || x < 0 || x > plotW) continue;
    const xL = x - half;
    drawCtx.strokeStyle = _SESSION_LINE[sess]; drawCtx.lineWidth = 1; drawCtx.globalAlpha = 0.45;
    drawCtx.beginPath(); drawCtx.moveTo(xL, 0); drawCtx.lineTo(xL, plotBottom); drawCtx.stroke();   // 開盤直線（止於時間軸上緣）
    drawCtx.globalAlpha = 1;
    drawCtx.fillStyle = _SESSION_LINE[sess];
    drawCtx.fillText(_SESSION_NAME_OF(sess), xL + 3, 30);                                   // 盤名（星期列下方）
  }
  drawCtx.restore();
  }   // end if (_sessionOn) — 以下星期標籤永遠畫

  // 每日像素寬（可見範圍前兩次換日的間距）：③b 週框 / ③ 星期標籤的密度門檻共用。
  // 縮得太小時：「週X」互相疊成一坨、週框變成密集柵欄 → 依門檻整組不畫。
  let _dayPx = Infinity;   // 只有 0~1 次換日(看單日內)→ Infinity＝照常顯示
  {
    let pd = (from > 0) ? _dayOf(ohlcvData[from - 1].time) : -1;
    let firstChg = -1;
    for (let i = from; i <= to; i++) {
      const dy = _dayOf(ohlcvData[i].time);
      if (dy !== pd) {
        pd = dy;
        if (firstChg >= 0) { _dayPx = (i - firstChg) * half * 2; break; }
        firstChg = i;
      }
    }
  }

  // ③b 週框：把每週的「週一~週五」K 棒用細框框起來（全高矩形）。
  //   crypto(24/7)週末有棒→落在框外；股票無週末棒→以「出現週一」為界起新框。只框、不填。
  //   每天 <4px（一週框剩 ~20px）→ 框變密集柵欄 → 不畫。
  if (_weekBoxOn && _dayPx >= 4) {
  drawCtx.save();
  drawCtx.strokeStyle = "rgba(255,255,255,0.6)"; drawCtx.lineWidth = 1.5;
  drawCtx.fillStyle = "rgba(255,255,255,0.055)";        // 很淡底色→整週像一個區塊、更明顯
  let _wkL = null, _wkR = null;                          // 目前週框左右 x
  const _flushWk = () => {
    if (_wkL != null && _wkR != null && _wkR > _wkL) {
      drawCtx.fillRect(_wkL, 1, _wkR - _wkL, plotBottom - 2);
      drawCtx.strokeRect(_wkL, 1, _wkR - _wkL, plotBottom - 2);
    }
    _wkL = _wkR = null;
  };
  let _wkPrevD = (from > 0) ? _dayOf(ohlcvData[from - 1].time) : -1;
  for (let i = from; i <= to; i++) {
    const d = _dayOf(ohlcvData[i].time);
    const x = ts.timeToCoordinate(toTime(ohlcvData[i].time));
    if (x == null) { _wkPrevD = d; continue; }
    if (d >= 1 && d <= 5) {                              // 週一~週五
      if (d === 1 && _wkL != null && _wkPrevD !== 1) _flushWk();   // 新的一週(股票 Fri→Mon 無週末棒)→收前框
      if (_wkL == null) _wkL = x - half;
      _wkR = x + half;
    } else {
      _flushWk();                                        // 週末(六/日)→收框
    }
    _wkPrevD = d;
  }
  _flushWk();
  drawCtx.restore();
  }   // end if (_weekBoxOn)

  // ③ 星期標籤：日期變動的那根 K 棒上方標「週X」
  // 每天寬度不足一個標籤寬(≈34px)→「週X」會疊成一坨 → 整排不畫（逐日虛線分隔一併省略）。
  if (_dayPx >= 34) {
  drawCtx.save();
  drawCtx.font = "bold 13px sans-serif"; drawCtx.fillStyle = "rgba(255,255,255,0.55)"; drawCtx.textAlign = "left";
  // prevDay 從可見範圍「前一根」起算 → 只在真正換日那根標籤（不會在最左根硬標、平移時閃）
  let prevDay = (from > 0) ? _dayOf(ohlcvData[from - 1].time) : -1;
  for (let i = from; i <= to; i++) {
    const day = _dayOf(ohlcvData[i].time);
    if (day !== prevDay) {
      prevDay = day;
      const x = ts.timeToCoordinate(toTime(ohlcvData[i].time));
      if (x != null && x >= 0 && x <= W) {
        if (i > from && _tf !== "1d") { drawCtx.strokeStyle = "rgba(255,255,255,0.10)"; drawCtx.lineWidth = 1; drawCtx.setLineDash([2, 3]); drawCtx.beginPath(); drawCtx.moveTo(x - half, 0); drawCtx.lineTo(x - half, plotBottom); drawCtx.stroke(); drawCtx.setLineDash([]); }   // 1d 每根換日→省逐日分隔線(太密)，留標籤+週框
        drawCtx.fillText(_WEEKDAY[day] || "", x - half + 4, 16);
      }
    }
  }
  drawCtx.restore();   // 星期標籤
  }   // end if (_dayPx >= 34) — 星期標籤密度門檻
  drawCtx.restore();   // 外層繪圖區裁切
}

/* ── 日開 / 4H 開盤價（獨立開關 window._htfOpenOn，＝圖例「日/4H開」）─────────────
   在小時框圖上畫出「當前日 K 的開盤價」與「當前 4H K 的開盤價」水平線，
   讓人在 5m/15m 上也看得到大時框的開盤位置（多空分界常被盯著）。

   ★ 邊界必須跟 app 自己的大時框 K 棒一致，不能用「台北日界」隨手切：
     ・加密：後端的 1d/4h 是 **UTC** 週期 → 這裡用 UTC 取整。
       ⚠ toTime() 已經 +8h，所以要先減回 8h 才是真正的 UTC 秒數。
         用台北日界會差 8 小時（UTC 日界在圖上是台北 08:00）→ 線會畫錯位置。
     ・股票(台/美/港)：後端是**依盤別**切日、4H 由盤中小時重採樣 → 日界＝當地日期變動，
       4H 段＝從當日第一根起算每 4 小時。這是貼近後端 _resample_session 的近似。

   只畫「比當前時框大」的那幾條：看 4h 圖就不再畫 4H 開（那就是它自己的開盤）。 */
function _drawHtfOpens(W, H) {
  if (!window._htfOpenOn) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData.length ||
      typeof mainChart === "undefined" || !candleSeries) return;
  const tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const cur = (typeof tfSec === "function") ? tfSec(tf) : 3600;
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const len = ohlcvData.length;
  let vFrom = Math.min(len - 1, Math.max(0, Math.floor(vr.from)));
  let vTo = Math.min(len - 1, Math.max(0, Math.ceil(vr.to)));
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number") vTo = Math.min(vTo, replayIdx);
  if (vTo < vFrom || !ohlcvData[vFrom] || !ohlcvData[vTo]) return;
  const lastIdx = (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    ? Math.min(len - 1, replayIdx) : len - 1;

  const isCrypto = (document.getElementById("marketSelect")?.value || "crypto") === "crypto";
  const utc = (bar) => toTime(bar.time) - 8 * 3600;          // toTime 已 +8h → 減回真 UTC

  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "bold 10px sans-serif";

  for (const [sec, label, color] of [[86400, "日開", "#f5a623"], [14400, "4H開", "#7aa2f7"]]) {
    if (cur >= sec) continue;                                // 不畫「不大於當前時框」的
    /* ⚠ 掃描範圍要往兩側各外擴「一整個大K」的棒數，不能只掃可見範圍：
         只掃可見範圍的話，段的起訖會被畫面邊界切斷 → 標籤（貼在右端）會隨著平移一路滑動，
         使用者回報的「他會亂動」就是這個。外擴後拿到的是**真實**邊界，平移時線與標籤都不動。 */
    const pad = Math.ceil(sec / cur) + 2;
    const a0 = Math.max(0, vFrom - pad), a1 = Math.min(lastIdx, vTo + pad);
    // 分桶（股票要依序推進「當日起點」，故在同一趟順掃裡算）
    let dayKey = null, dayStartUtc = 0;
    const bucket = (bar) => {
      const u = utc(bar);
      if (isCrypto) return Math.floor(u / sec);
      const d = Math.floor((u + 8 * 3600) / 86400);          // 股票：用當地日期切日
      if (dayKey !== d) { dayKey = d; dayStartUtc = u; }      // 當日第一根＝該日盤中起點
      return sec >= 86400 ? d : (d + ":" + Math.floor((u - dayStartUtc) / sec));
    };
    // 先算出「當前這一段」的鍵：它還沒收盤 → 不畫（使用者只要已收盤的）
    let curKey = null;
    { let dk = null, ds = 0;
      for (let i = 0; i <= lastIdx; i++) {                    // 股票需從頭推進日起點才正確
        const u = utc(ohlcvData[i]);
        if (isCrypto) { curKey = Math.floor(u / sec); continue; }
        const d = Math.floor((u + 8 * 3600) / 86400);
        if (dk !== d) { dk = d; ds = u; }
        curKey = sec >= 86400 ? d : (d + ":" + Math.floor((u - ds) / sec));
      } }

    let key = null, segStart = -1, segOpen = 0;
    const flush = (endIdx) => {
      if (segStart < 0 || key === curKey) { segStart = -1; return; }   // 未收盤那段不畫
      if (endIdx < vFrom || segStart > vTo) { segStart = -1; return; } // 完全在畫面外
      const y = candleSeries.priceToCoordinate(segOpen);
      const x1 = _timeToX(toTime(ohlcvData[segStart].time));
      const x2 = _timeToX(toTime(ohlcvData[endIdx].time));
      if (y != null && isFinite(y) && x1 != null && x2 != null) {
        drawCtx.strokeStyle = color; drawCtx.lineWidth = 1.2;
        drawCtx.setLineDash([5, 4]); drawCtx.globalAlpha = 0.85;
        drawCtx.beginPath(); drawCtx.moveTo(x1, y); drawCtx.lineTo(x2, y); drawCtx.stroke();
        drawCtx.setLineDash([]); drawCtx.globalAlpha = 1;
        /* 標籤貼在線的「真實右端」（放左端會被整段 K 棒壓住）。
           ⚠ 不可以把 x 夾到畫面邊緣：段的右端在畫面外時，夾制會讓標籤黏在螢幕右緣、
             隨著平移一路滑動 —— 使用者回報的「他不應該隨著我往左滑而有改變」就是這個。
             右端不在畫面內就乾脆不畫標籤（線本身仍被 clip 正常顯示），這樣所有東西
             都只跟著圖表一起移動，相對位置永遠不變。
           深色外框讓它壓在 K 棒上也讀得出來。 */
        if (x2 >= 24 && x2 <= plotW - 2) {
          drawCtx.textAlign = "right";
          drawCtx.lineWidth = 3; drawCtx.strokeStyle = "rgba(12,14,20,0.85)";
          drawCtx.strokeText(label, x2 - 3, y - 3);
          drawCtx.fillStyle = color;
          drawCtx.fillText(label, x2 - 3, y - 3);
        }
      }
      segStart = -1;
    };
    for (let i = a0; i <= a1; i++) {
      const k = bucket(ohlcvData[i]);
      if (k !== key) {
        if (segStart >= 0) flush(i - 1);
        key = k; segStart = i; segOpen = +ohlcvData[i].open;
      }
    }
    flush(a1);
  }
  drawCtx.restore();
}

// 關鍵高低（獨立開關 window._pdhlOn，＝圖例「關鍵高低」）：把「亞洲盤 / 歐洲盤」當盤高低
//   延伸成流動性線（等著被下一盤獵取），配「前日高低」(charts.js PDHL primitive 同一開關) 一起看。
//   不綁時段色塊開關（_sessionOn）→ 想看關鍵價位不必忍受整片色塊；加密 24/7 killzone 才有意義。
function _drawKeyLevels(W, H) {
  if (!window._pdhlOn) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData.length || typeof mainChart === "undefined" || !candleSeries) return;
  const _mk = document.getElementById("marketSelect")?.value || "crypto";
  const _tf = (typeof currentTF !== "undefined") ? currentTF : "";
  if (_mk !== "crypto" || !_SESSION_INTRADAY.includes(_tf)) return;   // 亞/歐延伸只在加密日內細時框
  if (_mk !== _curSessMkt) { _curSessMkt = _mk; _sessCache.clear(); _sessRuns = null; _sessRunsKey = ""; }
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const _len = ohlcvData.length;
  // ⚠ 切時框瞬間可視範圍可能還是「舊資料(較長)」的索引 → from/to 必須同時夾到 [0,_len-1]，
  //   否則 ohlcvData[from] 為 undefined、讀 .time 就爆(「Cannot read ... 'time'」的切時框報錯根因)。
  const from = Math.min(_len - 1, Math.max(0, Math.floor(vr.from) - 64));
  let to = Math.min(_len - 1, Math.max(0, Math.ceil(vr.to) + 64));
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number") to = Math.min(to, replayIdx);
  if (to < from || !ohlcvData[from] || !ohlcvData[to]) return;   // 索引無效(切換瞬間)→ 這幀先不畫
  const half = (W / Math.max(1, vr.to - vr.from)) / 2;
  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  const _lT = toTime(ohlcvData[from].time), _rT = toTime(ohlcvData[to].time);
  const runs = _getSessionRuns();
  const _TAG = { asia: ["亞高", "亞低"], europe: ["歐高", "歐低"] };
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "bold 10px sans-serif"; drawCtx.textAlign = "left";
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const tags = _TAG[r.sess];
    if (!tags || r.e > to) continue;                                   // 只延亞/歐；未完全揭曉(重播)不延
    const startT = toTime(ohlcvData[r.e].time);
    let endT = null;                                                    // 延到「下一個同盤(或週末)開始」
    for (let j = k + 1; j < runs.length; j++) { if (runs[j].sess === r.sess || runs[j].sess === "weekend") { endT = toTime(ohlcvData[runs[j].s].time); break; } }
    if (endT == null) endT = _rT;
    if (endT < _lT || startT > _rT) continue;                          // 延伸段完全在畫面外 → 略過
    const xS = ts.timeToCoordinate(startT), xE = ts.timeToCoordinate(endT);
    const L = (xS == null ? 0 : xS + half), R = (xE == null ? plotW : xE - half);
    if (R <= L) continue;
    const col = _SESSION_LINE[r.sess];
    for (let s = 0; s < 2; s++) {
      const price = s === 0 ? r.hi : r.lo;
      const y = candleSeries.priceToCoordinate(price);
      if (y == null) continue;
      // 線：稍粗 + 虛線 → 比色塊上下緣明顯
      drawCtx.setLineDash([5, 4]); drawCtx.globalAlpha = 0.8; drawCtx.strokeStyle = col; drawCtx.lineWidth = 1.4;
      drawCtx.beginPath(); drawCtx.moveTo(L, y); drawCtx.lineTo(R, y); drawCtx.stroke();
      drawCtx.setLineDash([]); drawCtx.globalAlpha = 1;
      // 標籤：黑描邊 + 盤色 → 任何底色上都清楚
      const lbl = tags[s], lx = Math.max(L + 3, 3), ly = y - 2;
      drawCtx.lineWidth = 2.5; drawCtx.strokeStyle = "rgba(0,0,0,0.55)"; drawCtx.strokeText(lbl, lx, ly);
      drawCtx.fillStyle = col; drawCtx.fillText(lbl, lx, ly);
    }
  }
  drawCtx.restore();
}

// 成交量分佈圖（Volume Profile）：把成交量依價格分箱，畫出三條水平線——
//   上＝VAH(價值區高)、中＝POC(控制點/量最大價位)、下＝VAL(價值區低)。價值區＝累積 70% 量。
// 另有一條「可拖動的垂直截止線」：只統計線『左邊』的 K 棒（_vpCutTime；null＝統計到可見右緣）。
// 受 legVP 圖例開關控制（_vpOn）；只在 overlay 層畫、隨可見範圍/價軸由 renderDrawings 重算。
let _vpOn = (() => { try { return localStorage.getItem("vpProfile") !== "0"; } catch (e) { return true; } })();
let _vpCutTime  = null;   // 截止垂直線的圖表時間；null＝可見右緣(統計全部可見)。只統計此線左邊
let _vpDrag     = false;  // 是否正在拖動截止線
let _vpLineLastX = null;  // 上次畫線的 x（給滑鼠 hit-test 用；VP 關閉時為 null）
function _drawVolumeProfile(W, H) {
  _vpLineLastX = null;
  if (!_vpOn) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData.length || typeof mainChart === "undefined") return;
  const ts = mainChart.timeScale();
  const vr = ts.getVisibleLogicalRange();
  if (!vr) return;
  const _len = ohlcvData.length;
  const from = Math.max(0, Math.floor(vr.from));
  let to     = Math.min(_len - 1, Math.ceil(vr.to));
  // 重播：只算到「已揭曉」那根，不用未來資料
  if (typeof replayActive !== "undefined" && replayActive && typeof replayIdx === "number")
    to = Math.min(to, replayIdx);
  if (to < from) return;
  // 截止時間超出已載入資料(換標的/時框後殘留)→ 自動歸位到右緣
  if (_vpCutTime != null) {
    const t0 = toTime(ohlcvData[0].time), tN = toTime(ohlcvData[_len - 1].time);
    if (_vpCutTime < t0 || _vpCutTime > tN) _vpCutTime = null;
  }
  // 統計右界＝截止線那根（只算它左邊）；null＝可見右緣
  let hiIdx = to;
  if (_vpCutTime != null) {
    let c = to;
    while (c > from && toTime(ohlcvData[c].time) > _vpCutTime) c--;
    hiIdx = c;
  }
  // 截止線本身畫線用的時間：自定→該時間；否則可見右緣那根
  const lineTime = (_vpCutTime != null) ? _vpCutTime : toTime(ohlcvData[to].time);
  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  const xCut  = _timeToX(lineTime);
  const xEnd  = (xCut != null && xCut < plotW && xCut > 0) ? xCut : plotW;   // 三線右端止於截止線

  // ── 價量分佈三線：只統計 [from, hiIdx]（截止線左邊的可見 K）──
  if (hiIdx >= from) {
    let pHi = -Infinity, pLo = Infinity;
    for (let i = from; i <= hiIdx; i++) {
      const b = ohlcvData[i];
      if (b.high > pHi) pHi = b.high;
      if (b.low  < pLo) pLo = b.low;
    }
    if (isFinite(pHi) && isFinite(pLo) && pHi > pLo) {
      const BINS = 48;
      const binH = (pHi - pLo) / BINS;
      const vol  = new Float64Array(BINS);
      // 每根 K 的量平均分攤到它 low~high 覆蓋的價格箱（近似價量分佈）
      for (let i = from; i <= hiIdx; i++) {
        const b = ohlcvData[i];
        const v = +b.volume || 0;
        if (v <= 0) continue;
        let lo = Math.floor((b.low  - pLo) / binH);
        let hi = Math.floor((b.high - pLo) / binH);
        if (lo < 0) lo = 0;
        if (hi > BINS - 1) hi = BINS - 1;
        const share = v / (hi - lo + 1);
        for (let k = lo; k <= hi; k++) vol[k] += share;
      }
      let maxV = 0, pocIdx = 0, total = 0;
      for (let k = 0; k < BINS; k++) { total += vol[k]; if (vol[k] > maxV) { maxV = vol[k]; pocIdx = k; } }
      if (maxV > 0 && total > 0) {
        // 價值區（70% 量）：自 POC 往上下擴張，每次併入相鄰「量較大」的一側，直到 ≥70%
        let loK = pocIdx, hiK = pocIdx, acc = vol[pocIdx];
        const VA_TARGET = total * 0.7;
        while (acc < VA_TARGET && (loK > 0 || hiK < BINS - 1)) {
          const below = loK > 0        ? vol[loK - 1] : -1;
          const above = hiK < BINS - 1 ? vol[hiK + 1] : -1;
          if (above >= below) { hiK++; acc += Math.max(0, above); }
          else                { loK--; acc += Math.max(0, below); }
        }
        const pPOC = pLo + (pocIdx + 0.5) * binH;   // 中：POC
        const pVAH = pLo + (hiK + 1) * binH;         // 上：VAH
        const pVAL = pLo + loK * binH;               // 下：VAL
        drawCtx.save();
        drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
        drawCtx.font = "11px sans-serif"; drawCtx.textBaseline = "bottom"; drawCtx.textAlign = "right";
        const _vpLine = (price, color, label) => {
          const y = candleSeries?.priceToCoordinate(price);
          if (y == null) return;
          drawCtx.strokeStyle = color; drawCtx.lineWidth = 1; drawCtx.setLineDash([6, 4]);
          drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(xEnd, y); drawCtx.stroke();
          drawCtx.setLineDash([]);
          const tx = xEnd - 4;
          drawCtx.fillStyle = "rgba(0,0,0,0.55)"; drawCtx.lineWidth = 3; drawCtx.strokeStyle = "rgba(0,0,0,0.55)";
          drawCtx.strokeText(label, tx, y - 1);
          drawCtx.fillStyle = color; drawCtx.fillText(label, tx, y - 1);
        };
        _vpLine(pVAH, "rgba(120,170,255,0.9)",  "VAH 上");
        _vpLine(pPOC, "rgba(255,193,7,0.98)",   "POC 中");
        _vpLine(pVAL, "rgba(120,170,255,0.9)",  "VAL 下");
        drawCtx.restore();
      }
    }
  }

  // ── 截止線（從頂端小把手拖動）：改變統計範圍 ──
  // 預設(_vpCutTime=null)＝統計可見全部 → 只畫「頂端小把手」釘在右緣、**不畫全高線**；
  // 使用者拖過 → 在該時間畫全高線。⚠ 兩個教訓：
  //   1) 預設錨在最後一根K → 滑進空白區時黃線孤零零立在畫面左側(像雜訊)；
  //   2) 預設畫全高線在右緣 → 靠近價格軸的「平移」被拖線判定劫持(主圖拖不動、
  //      誤拖還把黃線留在原平移處)。故預設只留頂端把手,抓取判定也限縮在頂端(見 _onChartMouse*)。
  const xLine = (_vpCutTime == null) ? (plotW - 1) : xCut;
  if (xLine != null && xLine >= 0 && xLine <= plotW) {
    let plotBottom = H;
    try { const th = ts.height(); if (th > 0) plotBottom = H - th; } catch (e) {}
    drawCtx.save();
    if (_vpCutTime != null || _vpDrag) {                   // 有自訂截止(或拖動中)才畫全高線
      drawCtx.strokeStyle = _vpDrag ? "rgba(255,213,79,0.95)" : "rgba(255,213,79,0.65)";
      drawCtx.lineWidth = _vpDrag ? 2 : 1.5;
      drawCtx.beginPath(); drawCtx.moveTo(xLine, 0); drawCtx.lineTo(xLine, plotBottom); drawCtx.stroke();
    }
    drawCtx.fillStyle = "rgba(255,213,79,0.9)";
    drawCtx.fillRect(xLine - 3, 0, 6, 12);                 // 頂端握把(拖動唯一入口)
    drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "top";
    const _lblLeft = xLine > plotW - 60;                   // 靠右緣 → 標籤畫在把手左側,免出界
    drawCtx.textAlign = _lblLeft ? "right" : "left";
    const _lx = _lblLeft ? xLine - 5 : xLine + 5;
    drawCtx.lineWidth = 3; drawCtx.strokeStyle = "rgba(0,0,0,0.55)";
    drawCtx.strokeText("量分佈←", _lx, 2);
    drawCtx.fillStyle = "rgba(255,213,79,0.95)";
    drawCtx.fillText("量分佈←", _lx, 2);
    drawCtx.restore();
    _vpLineLastX = xLine;
  }
}

// 頂部「交易時段」開關按鈕
function initSessionToggle() {
  const btn = document.getElementById("sessionToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _sessionOn);
    // 同步手機「設定」分頁列的狀態文字
    const st = document.getElementById("mSetSessionState");
    if (st) st.textContent = _sessionOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetSession");
    if (row) row.classList.toggle("m-set-on", _sessionOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    _sessionOn = !_sessionOn;
    try { localStorage.setItem("sessionOverlay", _sessionOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();
  });
}

// 頂部「週框」開關按鈕（週一~週五框；獨立於交易時段開關）
function initWeekBoxToggle() {
  const btn = document.getElementById("weekBoxToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _weekBoxOn);
    const st = document.getElementById("mSetWeekBoxState");
    if (st) st.textContent = _weekBoxOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetWeekBox");
    if (row) row.classList.toggle("m-set-on", _weekBoxOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    _weekBoxOn = !_weekBoxOn;
    try { localStorage.setItem("weekBox", _weekBoxOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();
  });
}

// 右上「成交量分佈圖」開關按鈕（VAH/POC/VAL 三線 + 可拖動截止線）
function initVPToggle() {
  const btn = document.getElementById("vpToggleBtn");
  if (!btn) return;
  const _sync = () => {
    btn.classList.toggle("active", _vpOn);
    const st = document.getElementById("mSetVPState");
    if (st) st.textContent = _vpOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetVP");
    if (row) row.classList.toggle("m-set-on", _vpOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    _vpOn = !_vpOn;
    try { localStorage.setItem("vpProfile", _vpOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();
  });
}

// 右上「SR+SMC 教練」疊加層總開關（階段1：掃頂/掃底；後續階段：BOS/CHoCH/OB/SR/通道/教練面板）
function initCoachToggle() {
  const btn = document.getElementById("coachToggleBtn");
  if (!btn) return;
  try { window._coachOn = localStorage.getItem("coachOverlay") === "1"; } catch (e) {}
  const _sync = () => {
    btn.classList.toggle("active", window._coachOn);
    const st = document.getElementById("mSetCoachState");
    if (st) st.textContent = window._coachOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetCoach");
    if (row) row.classList.toggle("m-set-on", window._coachOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    window._coachOn = !window._coachOn;
    try { localStorage.setItem("coachOverlay", window._coachOn ? "1" : "0"); } catch (e) {}
    // 開啟時請求瀏覽器通知權限（步驟前進鬧鐘用；此為使用者手勢，允許請求）
    try { if (window._coachOn && window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) {}
    _sync();
    if (typeof _applyMainMarkers === "function") _applyMainMarkers();  // 立即顯示/隱藏教練標記(掃頂掃底)
    _scheduleRenderDrawings();                                          // 立即顯示/隱藏教練畫布層(BOS/CHoCH線)
    if (typeof _updateCoachPanel === "function") _updateCoachPanel();   // 立即顯示/隱藏教練面板
    // 圖層剛打開 → 勝率回應裡若沒帶這層的資料（預設不送、省流量）就自動補抓一次
    if (typeof window._wrRefetchIfMissing === "function") window._wrRefetchIfMissing();
  });
}

// 右上「VWAP」獨立開關：與教練層解耦，資料仍來自勝率回應的 window._coachVWAP
function initVwapToggle() {
  const btn = document.getElementById("vwapToggleBtn");
  if (!btn) return;
  try { window._vwapOn = localStorage.getItem("vwapOverlay") === "1"; } catch (e) {}
  const _sync = () => {
    btn.classList.toggle("active", window._vwapOn);
    const st = document.getElementById("mSetVWAPState");
    if (st) st.textContent = window._vwapOn ? "開啟" : "關閉";
    const row = document.getElementById("mSetVWAP");
    if (row) row.classList.toggle("m-set-on", window._vwapOn);
  };
  _sync();
  btn.addEventListener("click", () => {
    window._vwapOn = !window._vwapOn;
    try { localStorage.setItem("vwapOverlay", window._vwapOn ? "1" : "0"); } catch (e) {}
    _sync();
    _scheduleRenderDrawings();   // 立即顯示/隱藏 VWAP 折線
    // 圖層剛打開 → 勝率回應裡若沒帶這層的資料（預設不送、省流量）就自動補抓一次
    if (typeof window._wrRefetchIfMissing === "function") window._wrRefetchIfMissing();
  });
}
// 開關：window.toggleVWAP() 切換 VWAP 顯示（可帶布林值強制 on/off）
window.toggleVWAP = function (on) {
  window._vwapOn = (on === undefined) ? (window._vwapOn !== true) : !!on;
  try { localStorage.setItem("vwapOverlay", window._vwapOn ? "1" : "0"); } catch (e) {}
  const btn = document.getElementById("vwapToggleBtn");
  if (btn) btn.classList.toggle("active", window._vwapOn);
  const st = document.getElementById("mSetVWAPState");
  if (st) st.textContent = window._vwapOn ? "開啟" : "關閉";
  const row = document.getElementById("mSetVWAP");
  if (row) row.classList.toggle("m-set-on", window._vwapOn);
  // 同 vwapToggleBtn：圖層剛打開時，勝率回應裡若沒帶 vwap（預設不送）就自動補抓
  if (typeof window._wrRefetchIfMissing === "function") window._wrRefetchIfMissing();
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return window._vwapOn;
};


// VWAP 成交量加權均價（黃折線）：獨立開關 _vwapOn；資料 window._coachVWAP（勝率回應每次刷新）。
// 前端自算 VWAP 折線（覆蓋『所有已載入 ohlcvData』，含背景補載的歷史棒 → 往歷史捲不再斷）。
//   錨定：盤中(非 1d/1w/1M)每日重置、日線以上每年重置，皆錨 UTC（對齊 Binance 日K換日/資金費率/
//   機構慣例——加密日 VWAP 幾乎都錨 UTC，讓大家看同一條）。toTime 已 +8h → 減回還原真實 UTC 再分桶。
//   量加權典型價 hlc3。依 (棒數:最後時間:時框) 快取，資料沒變不重算（平移/縮放不吃 CPU）。
let _vwapOverlayCache = { key: "", arr: null };
function _vwapOverlay() {
  if (typeof ohlcvData === "undefined" || !ohlcvData || !ohlcvData.length) return null;
  const n = ohlcvData.length;
  const tf = (typeof currentTF !== "undefined" && currentTF) || "";
  const yearly = (tf === "1d" || tf === "1w" || tf === "1M");
  const key = n + ":" + ohlcvData[n - 1].time + ":" + tf;
  if (_vwapOverlayCache.key === key && _vwapOverlayCache.arr) return _vwapOverlayCache.arr;
  const arr = new Array(n);
  let curKey = null, cumPV = 0, cumV = 0, cumTP = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const b = ohlcvData[i];
    const ct = toTime(b.time);               // 圖表時間(+8h)；tc 先算好 → 畫線時免逐點再 toTime
    const utc = ct - 8 * 3600;               // 還原真實 UTC，讓換日錨在 UTC 00:00
    const dkey = yearly ? new Date(utc * 1000).getUTCFullYear() : Math.floor(utc / 86400);
    if (dkey !== curKey) { curKey = dkey; cumPV = 0; cumV = 0; cumTP = 0; cnt = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    const v = +b.volume || 0;
    cumTP += tp; cnt++;
    if (v > 0) { cumPV += tp * v; cumV += v; }
    arr[i] = { t: b.time, tc: ct, v: cumV > 0 ? cumPV / cumV : (cnt > 0 ? cumTP / cnt : null) };
  }
  _vwapOverlayCache = { key, arr };
  return arr;
}

function _drawVWAP(W, H) {
  if (window._vwapOn !== true) return;
  const vw = _vwapOverlay() || window._coachVWAP;   // 前端全量自算優先，覆蓋歷史棒（不斷）
  if (!vw || !vw.length) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const ts = mainChart.timeScale();
  let plotW = W; try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}   // 裁掉右側價格軸
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  // 顏色可調（C.vwap，主圖指標設定裡設）：hex→套 0.45 透明度；已是 rgba/rgb 則原樣用
  const _vwCol = (typeof C !== "undefined" && C.vwap) ? C.vwap : "#ffc107";
  drawCtx.strokeStyle = /^#/.test(_vwCol) ? (typeof hexAlpha === "function" ? hexAlpha(_vwCol, 45) : _vwCol) : _vwCol;
  drawCtx.lineWidth = (typeof S !== "undefined" && S.vwapWidth) ? S.vwapWidth : 1;   // 可調粗細
  // 只畫「可視時間範圍」內的點：陣列依時間升序 → 左外跳過、右外(或過重播點)直接 break，
  //   避免對全歷史(15m 可達數千根)每幀逐點 timeToCoordinate（重播每步重畫 → 這是卡的主因）。
  let _loT = -Infinity, _hiT = Infinity;
  try { const _vr = ts.getVisibleRange(); if (_vr) { _loT = _vr.from; _hiT = _vr.to; } } catch (e) {}
  drawCtx.beginPath();
  let started = false;
  for (const pt of vw) {
    if (pt.v == null) { started = false; continue; }
    const t = (pt.tc != null) ? pt.tc : toTime(pt.t);
    if (t < _loT) { started = false; continue; }          // 視窗左外：不算座標
    if (_rpCut != null && t > _rpCut) break;               // 重播：只畫到當前重播點
    if (t > _hiT) break;                                    // 視窗右外(已排序)→ 結束
    const x = _timeToX(t);
    if (x == null) { started = false; continue; }
    const y = candleSeries.priceToCoordinate(pt.v);
    if (y == null) { started = false; continue; }
    if (!started) { drawCtx.moveTo(x, y); started = true; } else drawCtx.lineTo(x, y);
  }
  drawCtx.stroke();
  drawCtx.restore();
}

// 錨定 VWAP（AVWAP）：從錨點 d.time 那根起、往後逐根累積 (H+L+C)/3 × 量 / Σ量。
// 結果依 d.id 快取；資料筆數／最後一根／錨點任一變動才重算（避免每次 hover／重繪都掃全序列）。
// 整段皆無量的市場（少數指數）→退化為典型價累積平均，仍可畫出線。
const _avwapCache = new Map();
function _avwapCurve(d) {
  if (typeof ohlcvData === "undefined" || !ohlcvData || !ohlcvData.length) return null;
  const lastT = toTime(ohlcvData[ohlcvData.length - 1].time);
  const key = ohlcvData.length + ":" + lastT + ":" + d.time;
  const hit = _avwapCache.get(d.id);
  if (hit && hit.key === key) return hit.curve;
  let start = -1;
  for (let i = 0; i < ohlcvData.length; i++) {
    if (toTime(ohlcvData[i].time) >= d.time) { start = i; break; }   // 第一根 ≥ 錨點的 K 棒
  }
  let curve = null;
  if (start >= 0) {
    curve = [];
    let cumPV = 0, cumV = 0, cumTP = 0, n = 0;
    for (let i = start; i < ohlcvData.length; i++) {
      const b = ohlcvData[i];
      const tp = (b.high + b.low + b.close) / 3;    // 典型價
      const v = +b.volume || 0;
      cumTP += tp; n++;
      if (v > 0) { cumPV += tp * v; cumV += v; }
      curve.push({ t: toTime(b.time), v: cumV > 0 ? cumPV / cumV : (n > 0 ? cumTP / n : null) });
    }
  }
  _avwapCache.set(d.id, { key, curve });
  return curve;
}

// SR+SMC 教練疊加層繪製（階段2：BOS/CHoCH 結構破線段）。畫布在 K 棒之上、不限時框。
// 由後端 smc_struct 提供線段端點：t0=擺點K、t1=收破K、p=擺點價、k=事件型別。
const _COACH_STRUCT_STYLE = {
  bos_up:   { c: "#26a69a", dash: false, t: "BOS↑" },   // 多方延續
  choch_up: { c: "#26a69a", dash: true,  t: "CHoCH↑" }, // 轉多（虛線）
  bos_dn:   { c: "#ef5350", dash: false, t: "BOS↓" },   // 空方延續
  choch_dn: { c: "#ef5350", dash: true,  t: "CHoCH↓" }, // 轉空（虛線）
};
// 折價/溢價區（ICT/SMC dealing range）：以「畫面右緣那根」為當下，只用到它為止的 K 棒現算(非重繪、不看未來)。
//   捲到哪、右緣就是那個歷史時點→看到的是「當時」的折價/溢價。溢價=EQ→top(紅上)、折價=bot→EQ(綠下)、EQ=50%(黃虛)。
let _pdCache = null;   // 折價/溢價區全棒掃描結果快取 { len, E, rHi, rLo, legStart, ts }（平移時節流重算）
function _drawPDZones(W, H) {
  if (window._pdOn !== true) return;   // 預設關（使用者要求）；window.togglePDZones(true) 可重新開啟
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  if (typeof ohlcvData === "undefined" || !ohlcvData || ohlcvData.length < 30) return;
  const ts = mainChart.timeScale();
  let plotW = W; try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}
  // 右緣可視時點＝「當下」。找到 ≤ 它的最後一根 → 只用 [0..E] 算(不看未來)
  let endT = null; try { const vr = ts.getVisibleRange(); if (vr && vr.to != null) endT = vr.to; } catch (e) {}
  const bars = ohlcvData; let E = bars.length - 1;
  if (endT != null) { for (let i = bars.length - 1; i >= 0; i--) { if (toTime(bars[i].time) <= endT) { E = i; break; } } }
  if (E < 20) return;
  // ── 全棒掃描節流：O(E×17) 每幀跑很貴 → 結果快取，平移時最多每 120ms 重算一次(慢移的 dealing
  //    range 差幾根肉眼無感)；其餘幀沿用快取的 rHi/rLo/legStart。線條每幀仍用當前座標重畫→不脫離K棒、不閃爍。 ──
  const _pc = _pdCache;
  const _nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  let rHi, rLo, legStart;
  if (_pc && _pc.len === bars.length && Math.abs(_pc.E - E) <= 2 && (_nowMs - _pc.ts) < 120) {
    rHi = _pc.rHi; rLo = _pc.rLo; legStart = _pc.legStart;   // 命中快取：跳過掃描
  } else {
    const PL = 8;                                   // 半窗定擺動 pivot(j 於 i=j+PL 確認，只用 ≤i 資料)
    let sh = null, sl = null, cur = 0; rHi = null; rLo = null; legStart = 0;
    for (let i = 0; i <= E; i++) {
      const j = i - PL;
      if (j >= PL) {
        const hj = bars[j].high, lj = bars[j].low; let mh = true, ml = true;
        for (let k = j - PL; k <= j + PL; k++) { if (bars[k].high > hj) mh = false; if (bars[k].low < lj) ml = false; }
        if (mh) sh = hj; if (ml) sl = lj;
      }
      const c = bars[i].close;
      if (sh != null && c > sh) { if (cur !== 1) { rLo = sl; legStart = i; } cur = 1; }
      else if (sl != null && c < sl) { if (cur !== -1) { rHi = sh; legStart = i; } cur = -1; }
      if (cur === 1) rHi = (rHi == null) ? bars[i].high : Math.max(rHi, bars[i].high);
      else if (cur === -1) rLo = (rLo == null) ? bars[i].low : Math.min(rLo, bars[i].low);
    }
    _pdCache = { len: bars.length, E, rHi, rLo, legStart, ts: _nowMs };
  }
  if (rHi == null || rLo == null || rHi <= rLo || legStart >= bars.length) return;
  const eq = (rHi + rLo) / 2;
  const yTop = candleSeries.priceToCoordinate(rHi), yEq = candleSeries.priceToCoordinate(eq), yBot = candleSeries.priceToCoordinate(rLo);
  if (yTop == null || yEq == null || yBot == null) return;
  let x0 = _timeToX(toTime(bars[legStart].time)); if (x0 == null) x0 = 0; x0 = Math.max(0, Math.min(x0, plotW));
  const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(4);
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "middle";
  if (!window._ovMoving) {   // 平移/縮放中跳過大面積半透明填色（邊界線/EQ/標籤保留）→ 停手 settle 補回
    drawCtx.fillStyle = "rgba(239,83,80,0.07)"; drawCtx.fillRect(x0, yTop, plotW - x0, yEq - yTop);   // 溢價
    drawCtx.fillStyle = "rgba(38,166,154,0.07)"; drawCtx.fillRect(x0, yEq, plotW - x0, yBot - yEq);    // 折價
  }
  drawCtx.lineWidth = 1;
  drawCtx.strokeStyle = "rgba(239,83,80,0.55)"; drawCtx.beginPath(); drawCtx.moveTo(x0, yTop); drawCtx.lineTo(plotW, yTop); drawCtx.stroke();
  drawCtx.strokeStyle = "rgba(38,166,154,0.55)"; drawCtx.beginPath(); drawCtx.moveTo(x0, yBot); drawCtx.lineTo(plotW, yBot); drawCtx.stroke();
  drawCtx.setLineDash([5, 4]); drawCtx.strokeStyle = "rgba(255,214,79,0.7)";
  drawCtx.beginPath(); drawCtx.moveTo(x0, yEq); drawCtx.lineTo(plotW, yEq); drawCtx.stroke(); drawCtx.setLineDash([]);
  drawCtx.fillStyle = "rgba(239,83,80,0.95)"; drawCtx.fillText("溢價 " + fmt(rHi), x0 + 4, yTop + 7);
  drawCtx.fillStyle = "rgba(255,214,79,0.98)"; drawCtx.fillText("EQ 50%", x0 + 4, yEq - 7);
  drawCtx.fillStyle = "rgba(38,166,154,0.95)"; drawCtx.fillText("折價 " + fmt(rLo), x0 + 4, yBot - 7);
  drawCtx.restore();
}
// 開關：window.togglePDZones() 切換折價/溢價區顯示（預設關）
window.togglePDZones = function (on) {
  window._pdOn = (on === undefined) ? (window._pdOn !== true) : !!on;
  if (typeof window._wrRefetchIfMissing === "function") window._wrRefetchIfMissing();   // 同上：缺資料就補抓
  if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
  return window._pdOn;
};

function _drawCoachOverlay(W, H) {
  if (!window._coachOn) return;
  const items = window._coachStructure;
  if (!items || !items.length) return;
  if (typeof mainChart === "undefined" || typeof candleSeries === "undefined" || !candleSeries) return;
  const ts = mainChart.timeScale();
  let plotW = W;
  try { const tw = ts.width(); if (tw > 0) plotW = tw; } catch (e) {}   // 裁掉右側價格軸
  const _rpCut = (typeof replayActive !== "undefined" && replayActive
    && typeof replayData !== "undefined" && replayData[replayIdx])
    ? toTime(replayData[replayIdx].time) : null;
  drawCtx.save();
  drawCtx.beginPath(); drawCtx.rect(0, 0, plotW, H); drawCtx.clip();
  drawCtx.font = "10px sans-serif"; drawCtx.textBaseline = "middle";   // 精簡：非粗體
  // 視覺精簡：去重疊。_boxes 記已畫框價格範圍；新框與任一舊框重疊>80%→視為重複、不再畫(降雜亂)。
  const _boxes = [];
  const _overlapDup = (top, bot) => {
    const t = Math.max(top, bot), b = Math.min(top, bot), h = (t - b) || 1e-9;
    for (const q of _boxes) {
      const ov = Math.min(t, q.t) - Math.max(b, q.b);
      if (ov > 0 && ov / Math.min(h, (q.t - q.b) || 1e-9) > 0.8) return true;
    }
    _boxes.push({ t, b }); return false;
  };
  const _labels = [];   // 已放標籤 (x,y)：太近就不重複畫(避免疊字)
  const _labelDup = (x, y) => { for (const l of _labels) if (Math.abs(l.y - y) < 10 && Math.abs(l.x - x) < 60) return true; _labels.push({ x, y }); return false; };
  // 每類只畫離現價最近的 N 個區(遠方用不到→不畫，大幅減少全寬橫條)
  const _px = (typeof ohlcvData !== "undefined" && ohlcvData && ohlcvData.length) ? ohlcvData[ohlcvData.length - 1].close : null;
  const _nearest = (arr, n = 3) => {
    if (_px == null || !arr || arr.length <= n) return arr || [];
    return arr.map(z => [z, Math.abs((z.top + z.bot) / 2 - _px)]).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
  };
  // 共用：畫一個區框(SR/OB)。z={t0,t1,top,bot}；存活(t1=null)延伸到右緣，replay 裁切。
  const _zoneBox = (z, rgb, label) => {
    const t0 = toTime(z.t0);
    if (_rpCut != null && t0 > _rpCut) return;
    const x0 = _timeToX(t0);
    if (x0 == null) return;
    const t1eff = z.t1 ? toTime(z.t1) : null;          // 右端：失效→失效K；存活→右緣(replay到揭曉點)
    let xr;
    if (_rpCut != null && (t1eff == null || t1eff > _rpCut)) xr = _timeToX(_rpCut);
    else if (t1eff != null) xr = _timeToX(t1eff);
    else xr = plotW;
    if (xr == null) xr = plotW;
    if (xr < 0 || x0 > plotW) return;
    if (_overlapDup(z.top, z.bot)) return;             // 去重疊：與已畫框幾乎重合→略過
    const yT = candleSeries.priceToCoordinate(z.top), yB = candleSeries.priceToCoordinate(z.bot);
    if (yT == null || yB == null) return;
    const L = Math.max(x0, 0), R = Math.min(xr, plotW), tp = Math.min(yT, yB), hgt = Math.abs(yB - yT);
    if (R <= L) return;
    drawCtx.fillStyle = `rgba(${rgb},0.05)`;           // 精簡：降透明度
    drawCtx.fillRect(L, tp, R - L, hgt);
    drawCtx.strokeStyle = `rgba(${rgb},0.5)`; drawCtx.lineWidth = 0.8;   // 精簡：細線+降透明
    drawCtx.strokeRect(L, tp, R - L, hgt);
    if (!_labelDup(L, tp + 7)) {                        // 去重疊：標籤太近不重畫
      drawCtx.fillStyle = `rgba(${rgb},0.85)`;
      drawCtx.fillText(label, L + 3, tp + 7);
    }
  };
  // ⓪a HTF 投影區（1H/4H 的 OB/FVG/SR，像 TV 畫在低時框圖上）：從形成K往右延伸的盒子、虛線邊、左側標籤。
  const htf = window._coachHTF;
  if (htf && htf.length) {
    drawCtx.setLineDash([5, 4]);
    for (const z of _nearest(htf)) {                // 只畫離現價最近的幾個
      if (_overlapDup(z.top, z.bot)) continue;      // 去重疊：與已畫框幾乎重合→略過
      const yT = candleSeries.priceToCoordinate(z.top), yB = candleSeries.priceToCoordinate(z.bot);
      if (yT == null || yB == null) continue;
      let x0 = z.t0 ? _timeToX(toTime(z.t0)) : 0;
      if (x0 == null) x0 = 0;                       // 形成K在畫面外→從左緣起
      x0 = Math.max(0, Math.min(x0, plotW));
      const tp = Math.min(yT, yB), hgt = Math.max(1, Math.abs(yB - yT));
      const rgb = z.kind === "ob" ? (z.dir === "l" ? "33,150,243" : "255,152,0")
        : z.kind === "fvg" ? (z.dir === "l" ? "0,188,212" : "156,39,176")
        : (z.dir === "l" ? "38,166,154" : "239,83,80");   // sr
      drawCtx.fillStyle = `rgba(${rgb},0.045)`;     // 精簡：降透明度
      drawCtx.fillRect(x0, tp, plotW - x0, hgt);
      drawCtx.strokeStyle = `rgba(${rgb},0.5)`; drawCtx.lineWidth = 0.8;   // 精簡：細線+降透明
      drawCtx.strokeRect(x0, tp, plotW - x0, hgt);
      if (!_labelDup(x0, tp + 7)) {                 // 去重疊：標籤太近不重畫
        drawCtx.fillStyle = `rgba(${rgb},0.8)`;
        drawCtx.fillText(z.name, x0 + 3, tp + 7);
      }
    }
    drawCtx.setLineDash([]);
  }
  // ⓪ SR 支撐/阻力區（最底層）：阻力紅/支撐綠
  for (const z of _nearest(window._coachSR || [])) _zoneBox(z, z.d === "res" ? "239,83,80" : "38,166,154", z.d === "res" ? "阻力" : "支撐");
  // ① OB 訂單區框：多OB藍/空OB橘
  for (const z of _nearest(window._coachOB || [])) _zoneBox(z, z.d === "l" ? "33,150,243" : "255,152,0", z.d === "l" ? "多OB" : "空OB");
  // ② 平行通道：從「錨點K(t1)」沿斜率延伸到右緣（涵蓋範圍對齊 TV）。畫 當前TF通道 + 4H靛 + 1H青。
  const _drawChan = (c, rgb) => {
    if (!c || !c.t1) return;
    const cx1 = _timeToX(toTime(c.t1)), cx2 = _timeToX(toTime(c.t2));
    const yU1 = candleSeries.priceToCoordinate(c.up1), yU2 = candleSeries.priceToCoordinate(c.up2);
    const yL1 = candleSeries.priceToCoordinate(c.lo1), yL2 = candleSeries.priceToCoordinate(c.lo2);
    if (cx1 == null || cx2 == null || cx2 === cx1 || yU1 == null || yU2 == null || yL1 == null || yL2 == null) return;
    const _ext = (xa, ya, xb, yb, xt) => ya + (yb - ya) * (xt - xa) / (xb - xa);
    const xL = Math.max(0, cx1), xR = plotW;                 // 起點=錨點K（不再拉到最左）
    const yUL = _ext(cx1, yU1, cx2, yU2, xL), yUR = _ext(cx1, yU1, cx2, yU2, xR);
    const yLL = _ext(cx1, yL1, cx2, yL2, xL), yLR = _ext(cx1, yL1, cx2, yL2, xR);
    drawCtx.fillStyle = `rgba(${rgb},0.03)`;                              // 精簡：降透明度
    drawCtx.beginPath(); drawCtx.moveTo(xL, yUL); drawCtx.lineTo(xR, yUR); drawCtx.lineTo(xR, yLR); drawCtx.lineTo(xL, yLL); drawCtx.closePath(); drawCtx.fill();
    drawCtx.strokeStyle = `rgba(${rgb},0.6)`; drawCtx.lineWidth = 1;      // 精簡：細線+降透明
    drawCtx.beginPath(); drawCtx.moveTo(xL, yUL); drawCtx.lineTo(xR, yUR); drawCtx.stroke();
    drawCtx.beginPath(); drawCtx.moveTo(xL, yLL); drawCtx.lineTo(xR, yLR); drawCtx.stroke();
  };
  for (const c of (window._coachHTFCh || [])) _drawChan(c, c.tf === "4H" ? "63,81,181" : "0,150,136");  // 4H靛 / 1H青
  _drawChan(window._coachChannel, window._coachChannel && window._coachChannel.dir === 1 ? "38,166,154" : "239,83,80");
  // ③ VWAP：改由獨立開關 _vwapOn 控制（_drawVWAP，不再綁教練層）
  // ④ BOS/CHoCH 結構破線段（精簡：整段調更淡）
  drawCtx.globalAlpha = 0.5;
  for (const it of items) {
    const st = _COACH_STRUCT_STYLE[it.k];
    if (!st) continue;
    const t1 = toTime(it.t1);
    if (_rpCut != null && t1 > _rpCut) continue;          // replay：未揭曉的不畫
    const x0 = _timeToX(toTime(it.t0)), x1 = _timeToX(t1);
    if (x0 == null || x1 == null) continue;
    if (x1 < 0 || x0 > plotW) continue;                   // 完全在畫面外→略過
    const y = candleSeries.priceToCoordinate(it.p);
    if (y == null) continue;
    drawCtx.strokeStyle = st.c; drawCtx.lineWidth = 1;    // 精簡：細線
    drawCtx.setLineDash(st.dash ? [4, 3] : []);
    drawCtx.beginPath(); drawCtx.moveTo(x0, y); drawCtx.lineTo(x1, y); drawCtx.stroke();
    drawCtx.setLineDash([]);
    if (!_labelDup(Math.min(x1 + 4, plotW), y)) {         // 去重疊：太近的結構標籤不重畫
      const tw = drawCtx.measureText(st.t).width;
      const lx = Math.min(x1 + 4, plotW - tw - 3);
      drawCtx.fillStyle = "rgba(0,0,0,0.4)";
      drawCtx.fillRect(lx - 2, y - 7, tw + 4, 14);
      drawCtx.fillStyle = st.c;
      drawCtx.fillText(st.t, lx, y + 0.5);
    }
  }
  drawCtx.globalAlpha = 1;
  // ⑤ 交易計畫線：僅 15m/5m 圖 + BOS 確認(stage≥5,由 _coachPlanByTf 篩)。進場區/止損/止盈1~4 畫成主圖水平價位線(最上層清楚)
  const _tf = (typeof currentTF !== "undefined") ? currentTF : "";
  const plan = ((_tf === "15m" || _tf === "5m") && window._coachPlanByTf) ? window._coachPlanByTf[_tf] : null;
  if (plan) {
    drawCtx.font = "bold 10px sans-serif";
    const _hline = (price, rgb, label, dash) => {
      if (price == null) return;
      const y = candleSeries.priceToCoordinate(price);
      if (y == null) return;
      drawCtx.strokeStyle = `rgba(${rgb},0.95)`; drawCtx.lineWidth = 1.2;
      drawCtx.setLineDash(dash ? [6, 4] : []);
      drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(plotW, y); drawCtx.stroke();
      drawCtx.setLineDash([]);
      if (label) {
        const tw = drawCtx.measureText(label).width;
        const lx = plotW - tw - 7;
        drawCtx.fillStyle = "rgba(0,0,0,0.65)"; drawCtx.fillRect(lx - 3, y - 7, tw + 6, 14);
        drawCtx.fillStyle = `rgba(${rgb},1)`; drawCtx.fillText(label, lx, y + 0.5);
      }
    };
    if (plan.entry && plan.entry[0] != null) {          // 進場區(淡藍band + 上下虛線)
      const y0 = candleSeries.priceToCoordinate(plan.entry[0]), y1 = candleSeries.priceToCoordinate(plan.entry[1]);
      if (y0 != null && y1 != null) { drawCtx.fillStyle = "rgba(79,195,247,0.12)"; drawCtx.fillRect(0, Math.min(y0, y1), plotW, Math.abs(y1 - y0)); }
      _hline(plan.entry[0], "79,195,247", "進場", true);
      _hline(plan.entry[1], "79,195,247", "", true);
    }
    _hline(plan.sl, "239,83,80", "SL 止損");            // 止損(紅)
    const tps = plan.tps || (plan.tp != null ? [plan.tp] : []);
    tps.forEach((v, i) => _hline(v, "38,166,154", "TP" + (i + 1)));   // 止盈1~4(綠)
    drawCtx.font = "10px sans-serif";
  }
  drawCtx.restore();
}

// renderDrawings 合併排程 —— 「領先同幀 + 尾隨合併」：
//   平移時 LWC 在同一事件裡先更新內部座標才發 subscribeVisibleTimeRangeChange → 此刻「同步」重繪，
//   繪圖與 K 棒同一幀移動＝零漂移。（先前走 rAF 排程慢一幀＋移動中 30fps 節流 → 畫的線/框
//   平移時浮動追趕，使用者回報「畫上去的東西平移會漂」→ 2026-07-14 改回同幀，節流移除。）
//   同一幀內多次觸發（range change + crosshair + 軸看門狗）用 12ms 門檻擋住，改掛一次尾隨 rAF
//   補畫最新狀態 → 每幀最多 1 領先＋1 尾隨，正常平移一幀就一次。移動中大面積填色仍由
//   renderDrawings 內的 _ovMoving 旗標跳過（停手 240ms 補回），保住平移效能。
let _rdRafPending = false, _rdLastTs = 0;
function _scheduleRenderDrawings() {
  const _n = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (_n - _rdLastTs >= 12) {           // 領先：同幀立即畫（與 K 棒同步、零浮動）
    _rdLastTs = _n;
    renderDrawings();
    return;
  }
  if (_rdRafPending) return;            // 尾隨：同幀重複觸發合併成下一幀一次
  _rdRafPending = true;
  requestAnimationFrame(() => {
    _rdRafPending = false;
    _rdLastTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    renderDrawings();
  });
}

// ── 軸變化追蹤（讓所有繪圖/overlay 精準跟隨價格軸縮放，不再「切時框後偏離原價位」）──
//   問題根源：overlay 只訂閱「可見時間範圍變化」，未訂閱「價格軸縮放」。切標的/時框後價軸
//     autoScale 到新範圍 + 還原視野需 ~220ms 才穩定；拖價格軸/滾輪縮放也會動價軸 → 這些
//     都不觸發時間範圍事件 → 線停在舊 y 座標＝偏離原價位。
//   解法：用「軸簽章」= 畫布頂/底對應的價格 + 可見邏輯範圍。在一段追蹤窗內每幀比對，一旦
//     簽章變(價/時軸任一被縮放/平移)就立即重繪 → 精準跟到落定的那一刻，非靠固定計時器猜。
//   省電：追蹤窗有時限、自動停（不常駐 rAF）；由「切換/拖軸/滾輪」等會動軸的事件觸發或延長。
let _axisSig = "";
let _axisWatchUntil = 0;
let _axisWatchRAF = 0;
function _axisSignature() {
  // 只看「價格軸」（畫布頂/底對應的價格）。時間軸的平移/縮放已由 subscribeVisibleTimeRangeChange
  // 處理 → 這裡不含時間，平移時簽章不變、看門狗不介入、零額外重繪（滑動保持順）。
  // 看門狗的唯一職責：抓「價格軸變動但時間沒變」的時點（切標的/時框的 autoScale 落定、拖價格軸）。
  try {
    if (!candleSeries) return "";
    const H = _cssH();
    const pTop = candleSeries.coordinateToPrice(0);
    const pBot = candleSeries.coordinateToPrice(H);
    return `${pTop}|${pBot}`;
  } catch (e) { return ""; }
}
function _axisWatchTick() {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (now > _axisWatchUntil) { _axisWatchRAF = 0; return; }   // 窗結束 → 停 rAF（省電）
  _axisWatchRAF = requestAnimationFrame(_axisWatchTick);
  const sig = _axisSignature();
  // 用 rAF 去重的排程重繪（非直接 renderDrawings）→ 與 LWC 可見範圍變化那條合併,每幀最多一次,
  // 避免平移/縮放時「每幀重繪兩次」拖慢滑動。
  if (sig && sig !== _axisSig) { _axisSig = sig; _scheduleRenderDrawings(); }
}
// 啟動/延長一段軸追蹤窗（ms）；期間任何價/時軸座標變化即重繪。會動軸的操作都呼叫它。
function _watchAxis(ms = 1500) {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  _axisWatchUntil = Math.max(_axisWatchUntil, now + ms);
  _axisSig = _axisSignature();
  if (!_axisWatchRAF) _axisWatchRAF = requestAnimationFrame(_axisWatchTick);
}

// 切標的/時框後：立即重繪一次(即時回饋) + 開一段較長追蹤窗涵蓋 autoScale/還原視野落定。
function _renderDrawingsAfterSettle() {
  _scheduleRenderDrawings();
  _watchAxis(1800);
}

let _ovSettleT = null;   // 平移/縮放中省略的大面積填色 → 停手 240ms 補回（同 charts.js FVG settle 模式）
/* ── 畫線/拖曳時的即時輔助：軸標籤(價格軸/時間軸) + Δ 資訊盒(TV 風) ── */
function _fmtP(v) {
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function _fmtDT(t) {
  const d = new Date(t * 1000);   // t=toTime(+8) → getUTC* 即台北時
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
// 秒數→人類可讀時長(測量工具用)
function _fmtDur(sec) {
  sec = Math.abs(Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}天${h}時` : `${d}天`;
  if (h > 0) return m > 0 ? `${h}時${m}分` : `${h}時`;
  return `${m}分`;
}
function _priceAxisTag(ctx, W, plotW, y, price, bg) {
  if (y == null || !isFinite(y)) return;
  const txt = _fmtP(price);
  ctx.save(); ctx.font = "11px sans-serif";
  const bw = Math.max(W - plotW, ctx.measureText(txt).width + 10), h = 15;
  ctx.fillStyle = bg; ctx.fillRect(plotW, y - h / 2, bw, h);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(txt, plotW + 5, y);
  ctx.restore();
}
function _timeAxisTag(ctx, H, plotBottom, x, time, bg) {
  if (x == null || !isFinite(x)) return;
  const txt = _fmtDT(time);
  ctx.save(); ctx.font = "11px sans-serif";
  const bw = ctx.measureText(txt).width + 10, h = 15;
  let bx = x - bw / 2;
  ctx.fillStyle = bg; ctx.fillRect(bx, plotBottom, bw, h);
  ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  ctx.fillText(txt, bx + 5, plotBottom + h / 2);
  ctx.restore();
}
function _deltaBox(ctx, x, y, lines, W, H) {
  ctx.save(); ctx.font = "11px sans-serif";
  let tw = 0; for (const l of lines) tw = Math.max(tw, ctx.measureText(l.t).width);
  const pad = 6, lh = 15, bw = tw + pad * 2, bh = lines.length * lh + pad;
  let bx = x + 16, by = y + 16;
  if (bx + bw > W) bx = x - 16 - bw;
  if (by + bh > H) by = y - 16 - bh;
  ctx.fillStyle = "rgba(20,24,34,0.92)"; ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  lines.forEach((l, i) => { ctx.fillStyle = l.c || "#e6e6e6"; ctx.fillText(l.t, bx + pad, by + pad / 2 + i * lh); });
  ctx.restore();
}
const _TWO_PT = ["trendline", "ray", "arrow", "rect", "circle", "fib", "longpos", "shortpos", "measure"];
// ⚠ path(連續箭頭) 是**多點**、不放進 _TWO_PT：它自己收點、雙擊/Esc 收尾，資料是 pts[] 不是 p1/p2。
function _drawDrawTags(W, H) {
  const wip = drawingWIP, dragging = dragState && dragState.moved;
  if (!wip && !dragging) return;
  let plotW = W, plotBottom = H;
  try { const tw = mainChart.timeScale().width(); if (tw > 0) plotW = tw; } catch (e) {}
  try { const th = mainChart.timeScale().height(); if (th > 0) plotBottom = H - th; } catch (e) {}
  let anchor = null, active = null, twoPt = false, dtype = null;
  if (wip) {
    dtype = wip.type;
    let cmx = _mx, cmy = _my;
    if (_magnetMode) { const s = _magnetSnap(_mx, _my); if (s) { cmx = s.x; cmy = s.y; } }
    const a = chartToScreen(wip.p1.time, wip.p1.price), cp = screenToChart(cmx, cmy);
    if (a) anchor = { x: a.x, y: a.y, time: wip.p1.time, price: wip.p1.price };
    if (cp) active = { x: cmx, y: cmy, time: cp.time, price: cp.price };
    twoPt = _TWO_PT.includes(dtype);
  } else {
    const d = drawings.find(x => x.id === dragState.id);
    if (!d) return;
    dtype = d.type;
    if (d.p1 && d.p2) {
      const a = chartToScreen(d.p1.time, d.p1.price), b = chartToScreen(d.p2.time, d.p2.price);
      if (a && b) {
        const da = Math.hypot(a.x - _mx, a.y - _my), db = Math.hypot(b.x - _mx, b.y - _my);
        active = da <= db ? { x: a.x, y: a.y, time: d.p1.time, price: d.p1.price } : { x: b.x, y: b.y, time: d.p2.time, price: d.p2.price };
        anchor = da <= db ? { x: b.x, y: b.y, time: d.p2.time, price: d.p2.price } : { x: a.x, y: a.y, time: d.p1.time, price: d.p1.price };
        twoPt = true;
      }
    } else if (d.type === "hline") {
      const y = candleSeries?.priceToCoordinate(d.price);
      active = { x: _mx, y, time: null, price: d.price };
    } else if (d.p1) {
      const a = chartToScreen(d.p1.time, d.p1.price); if (a) active = { x: a.x, y: a.y, time: d.p1.time, price: d.p1.price };
    } else if (d.time != null) {
      active = { x: _timeToX(d.time), y: _my, time: d.time, price: null };
    }
  }
  const tag = (pt, activeTag) => {
    if (!pt) return;
    const bg = activeTag ? "rgba(41,98,255,0.95)" : "rgba(110,113,124,0.92)";
    if (pt.price != null && dtype !== "vline") _priceAxisTag(drawCtx, W, plotW, pt.y, pt.price, bg);
    if (pt.time != null && dtype !== "hline") _timeAxisTag(drawCtx, H, plotBottom, pt.x, pt.time, bg);
  };
  tag(anchor, false); tag(active, true);
  if (twoPt && anchor && active) {
    const dP = active.price - anchor.price;
    const pct = anchor.price ? dP / anchor.price * 100 : 0;
    const r = _barRef();
    const bars = (r && anchor.time != null && active.time != null) ? Math.round((active.time - anchor.time) / r.interval) : null;
    const sg = dP >= 0 ? "+" : "";
    const col = dP >= 0 ? "#26a69a" : "#ef5350";
    const lines = [{ t: `${sg}${_fmtP(dP)}  ${sg}${pct.toFixed(2)}%`, c: col }];
    if (bars != null) lines.push({ t: `${Math.abs(bars)} 根`, c: "#c8c8c8" });
    if (dtype === "trendline" || dtype === "ray") {
      const ang = Math.atan2(-(active.y - anchor.y), (active.x - anchor.x)) * 180 / Math.PI;
      lines.push({ t: `${ang.toFixed(1)}°`, c: "#c8c8c8" });
    }
    _deltaBox(drawCtx, active.x, active.y, lines, W, H);
  }
}

// 繪圖上方的文字標籤(非文字型;text/emoji/note 的 text 是本體不另畫)。錨點:hline=左緣該價、vline=該時間頂、其餘=p1。
// (鎖定不在主圖畫圖示——狀態看右鍵選單按鈕變「🔓 解鎖」即可,避免污染主圖。)
function _drawDrawingBadge(d, W, H) {
  const TEXT_TYPES = { text: 1, emoji: 1, note: 1 };
  if (!d.text || TEXT_TYPES[d.type]) return;
  let x, y;
  try {
    if (d.type === "hline") { x = W / 2; y = candleSeries.priceToCoordinate(d.price); }   // 水平置中
    else if (d.type === "vline") { x = _timeToX(d.time); y = H / 2; }
    else {
      // 錨在線的「正中間」(兩點中點)→ 文字置中顯示在線的中央
      const s1 = (d.p1 && d.p1.time != null) ? chartToScreen(d.p1.time, d.p1.price) : null;
      const s2 = (d.p2 && d.p2.time != null) ? chartToScreen(d.p2.time, d.p2.price) : null;
      if (s1 && s2) { x = (s1.x + s2.x) / 2; y = (s1.y + s2.y) / 2; }
      else if (s1 || s2) { const s = s1 || s2; x = s.x; y = s.y; }
      else if (d.time != null && d.price != null) { const s0 = chartToScreen(d.time, d.price); if (s0) { x = s0.x; y = s0.y; } }
    }
  } catch (e) { return; }
  if (x == null || y == null || !isFinite(x) || !isFinite(y) || y < -20 || y > H + 20) return;
  const col = d.color || _drawColor;
  drawCtx.save();
  drawCtx.setLineDash([]);
  drawCtx.shadowBlur = 0;
  drawCtx.textBaseline = "alphabetic";
  drawCtx.font = "12px sans-serif";
  const tw = drawCtx.measureText(d.text).width;
  // 垂直：對齊線的中點高度(上面算的 y);水平：靠右貼主圖右緣。
  const lx = Math.max(3, W - tw - 8);
  if (y < 8 || y > H - 2) { drawCtx.restore(); return; }   // 線中點在畫面外→不畫
  drawCtx.fillStyle = "rgba(20,24,34,0.82)";
  drawCtx.fillRect(lx - 4, y - 9, tw + 8, 17);
  drawCtx.fillStyle = col;
  drawCtx.fillText(d.text, lx, y + 4);
  drawCtx.restore();
}

function renderDrawings() {
  if (!drawCtx || !drawCanvas) return;
  // 圖表移動中旗標：給 _drawSessionOverlay 等跳過大面積半透明填色（overlay 2x 畫布最貴的像素工作）
  {
    const _n = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    window._ovMoving = !!(window._chartMoveTs && _n - window._chartMoveTs < 220);
    clearTimeout(_ovSettleT);
    if (window._ovMoving) _ovSettleT = setTimeout(renderDrawings, 240);   // 停手補畫（那時旗標=false→全細節）
  }
  // W/H 用 CSS 邏輯尺寸（backing store 是 device px，已由 setTransform(dpr) 縮放）
  const dpr = window.devicePixelRatio || 1;
  const W = drawCanvas.width / dpr, H = drawCanvas.height / dpr;
  drawCtx.clearRect(0, 0, W, H);

  // 現價標籤位置跟著價格軸縮放/平移/即時更新（renderDrawings 是 overlay 重畫的共同入口）
  if (typeof updateCurrentPriceLabel === "function") updateCurrentPriceLabel();

  // 成交量分佈圖（VPVR）：最底層先畫（避免蓋住時段高低線/繪圖/標記）；可開關
  _drawVolumeProfile(W, H);

  // 交易時段 overlay（背景帶=當盤高低範圍 + 上下緣高低線 + 星期標籤；可開關）
  _drawSessionOverlay(W, H);
  _drawKeyLevels(W, H);
  _drawHtfOpens(W, H);      // 日開 / 4H 開盤價水平線（小時框上看大時框開盤位置）

  // 折價/溢價區（ICT/SMC dealing range：溢價紅上半、折價綠下半、EQ 50%線；開關 _pdOn 預設開）
  _drawPDZones(W, H);

  // SR+SMC 教練疊加層（階段2：BOS/CHoCH 結構破線段+標籤；全時框；右上開關 _coachOn）
  _drawCoachOverlay(W, H);

  // VWAP 成交量加權均價（黃折線；獨立開關 _vwapOn）
  _drawVWAP(W, H);

  // （策略方向標記 多/空·破多空·順多空 已改為 charts.js 的 series primitive，與 K 棒同步繪製、不再走 overlay → 縮放不游移）

  // Draw non-selected first, then hovered, then selected on top
  // 單一繪圖 render 丟例外時只跳過它、不拖垮整塊 overlay(catch 內補 restore 平衡 save 堆疊)。
  const _safeDraw = (d, hov, sel) => { try { drawOne(d, W, H, hov, sel); } catch (e) { try { drawCtx.restore(); } catch (_) {} } };
  // ⚠ 圖層過濾跟 _isMain 一起做：被隱藏的層不畫（下面命中判定也要跳過，見 _layerOn）
  const _isMain = d => (!d.pane || d.pane === "main") && _layerOn(d);   // 副圖繪圖不在主圖畫(交給 _renderSub)
  _byLayer(drawings).filter(d => _isMain(d) && d.id !== selectedId && d.id !== hoveredId).forEach(d => _safeDraw(d, false, false));
  _byLayer(drawings).filter(d => _isMain(d) && d.id === hoveredId && d.id !== selectedId).forEach(d => _safeDraw(d, true, false));
  _byLayer(drawings).filter(d => _isMain(d) && d.id === selectedId).forEach(d => _safeDraw(d, false, true));

  // 繪圖文字標籤(非文字型)+ 鎖定圖示:畫在繪圖錨點上方
  _byLayer(drawings).forEach(d => { if (d.text && _isMain(d)) { try { _drawDrawingBadge(d, W, H); } catch (e) { try { drawCtx.restore(); } catch (_) {} } } });

  // （策略棒止損線改由 realtime.js onMainCrosshair 用 LWC 原生 price line 畫，不再走 overlay）

  // Compute snapped cursor position when magnet is active
  let _cmx = _mx, _cmy = _my;
  if (_magnetMode && drawTool !== "pointer" && drawTool !== "crosshair" && drawTool !== "eraser") {
    const snp = _magnetSnap(_mx, _my);
    if (snp) { _cmx = snp.x; _cmy = snp.y; }
  }

  if (drawingWIP && drawingWIP.type === "path" && Array.isArray(drawingWIP.pts)) {
    // 連續箭頭預覽：已收的折線 + 從最後一點拉到游標的那一段（虛線），並標出已收的轉折點
    const ps = drawingWIP.pts.map(q => chartToScreen(q.time, q.price)).filter(Boolean);
    if (ps.length) {
      drawCtx.save();
      drawCtx.strokeStyle = _drawColor; drawCtx.fillStyle = _drawColor;
      drawCtx.lineWidth = DRAW_WIDTH; drawCtx.lineJoin = "round"; drawCtx.lineCap = "round";
      drawCtx.beginPath(); drawCtx.moveTo(ps[0].x, ps[0].y);
      for (let i = 1; i < ps.length; i++) drawCtx.lineTo(ps[i].x, ps[i].y);
      drawCtx.stroke();
      drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath();
      drawCtx.moveTo(ps[ps.length - 1].x, ps[ps.length - 1].y);
      drawCtx.lineTo(_cmx, _cmy);
      drawCtx.stroke();
      drawCtx.setLineDash([]);
      ps.forEach(q => { drawCtx.beginPath(); drawCtx.arc(q.x, q.y, 3.5, 0, Math.PI * 2); drawCtx.fill(); });
      drawCtx.restore();
    }
  }
  else if (drawingWIP) {
    const p1s = chartToScreen(drawingWIP.p1.time, drawingWIP.p1.price);
    // 預覽要跟著 Shift 走，否則放手前看到的線跟畫出來的不一樣
    if (p1s) drawPreview(drawingWIP.type, p1s,
                         { x:_cmx, y: _hSnapOn(drawingWIP.type) ? p1s.y : _cmy }, W, H);
  }

  if (drawTool !== "pointer" && drawTool !== "crosshair") {
    drawCtx.save();
    drawCtx.strokeStyle = "rgba(200,200,200,0.22)";
    drawCtx.lineWidth = 1;
    drawCtx.setLineDash([4, 4]);
    drawCtx.beginPath();
    drawCtx.moveTo(_cmx, 0); drawCtx.lineTo(_cmx, H);
    drawCtx.moveTo(0, _cmy); drawCtx.lineTo(W, _cmy);
    drawCtx.stroke();
    drawCtx.restore();
    // Snap indicator circle
    if (_magnetMode && (_cmx !== _mx || _cmy !== _my)) {
      drawCtx.save();
      drawCtx.strokeStyle = "rgba(38,198,218,0.8)";
      drawCtx.lineWidth = 1.5;
      drawCtx.beginPath();
      drawCtx.arc(_cmx, _cmy, 5, 0, Math.PI * 2);
      drawCtx.stroke();
      drawCtx.restore();
    }
  }

  // 我的實際交易（進場/出場）——畫在最上層，丟例外只跳過不拖垮 overlay
  try { _drawMyTrades(W, H); } catch (e) {}

  // 畫線/拖曳時的即時軸標籤 + Δ 資訊盒（TV 風；丟例外只跳過不拖垮 overlay）
  try { _drawDrawTags(W, H); } catch (e) {}

  // 副圖繪圖層同步重畫(涵蓋載入/undo/切標的等 drawings 變動)
  if (typeof _renderAllSub === "function") { try { _renderAllSub(); } catch (e) {} }
}

// 自動盈虧比的 RR 數值：盒夠寬 → 置中盒內；縮小到盒太窄 → 移到盒旁並加深色底，
// 確保任何縮放都看得見（不必放大才顯示）。
function _drawRRLabel(ctx, txt, color, ex, rx, cy, W) {
  ctx.save();
  ctx.font = "bold 12px sans-serif";
  const tw = ctx.measureText(txt).width;
  const y = cy + 4;
  if (rx - ex > tw + 10) {
    ctx.fillStyle = color;
    ctx.fillText(txt, ex + (rx - ex - tw) / 2, y);
  } else {
    let x = rx + 5;                        // 預設放盒右側
    if (x + tw > W - 2) x = ex - tw - 5;   // 會超出右緣 → 改放盒左側
    if (x < 2) x = 2;                      // 仍超出 → 貼齊左緣
    ctx.fillStyle = "rgba(20,22,28,0.82)"; // 深色底襯，落在 K 棒上也清楚
    ctx.fillRect(x - 4, y - 12, tw + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }
  ctx.restore();
}

function _applyGlow(ctx, color, isSelected, isHovered) {
  if (isSelected) {
    ctx.shadowColor = color || "#f5c518";
    ctx.shadowBlur = 10;
    ctx.lineWidth = DRAW_WIDTH + 1;
  } else if (isHovered) {
    ctx.shadowColor = color || "#f5c518";
    ctx.shadowBlur = 5;
    ctx.lineWidth = DRAW_WIDTH + 0.5;
  }
}

function drawOne(d, W, H, isHovered, isSelected) {
  const col = d.color || _drawColor;
  drawCtx.save();
  drawCtx.strokeStyle = col;
  drawCtx.fillStyle   = col;
  drawCtx.lineWidth   = d.width || DRAW_WIDTH;
  const _dash = d.lineStyle === 2 ? [6,4] : d.lineStyle === 1 ? [2,3] : [];
  drawCtx.setLineDash(_dash);
  _applyGlow(drawCtx, col, isSelected, isHovered);

  if (d.type === "hline") {
    const y = candleSeries?.priceToCoordinate(d.price);
    if (y == null || y < -5 || y > H + 5) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(0, y); drawCtx.lineTo(W, y); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    drawCtx.font = "10px monospace";
    const _hp = d.price;
    /* 價格標籤靠右（2026-08-20 使用者：「放右邊比較順眼」）。
       原本寫死 x=5＝貼在左緣；價軸在右邊，標籤放右緣才跟 LWC 自己的價格標籤同側、視線不用來回跑。
       ⚠ 用 timeScale().width()（繪圖區右緣）不是畫布寬 W：W 含價軸，貼 W 會被價軸蓋住。
       ⚠ 量完文字寬再往左退，否則長數字（如 5 位數價格）會超出繪圖區被切掉。 */
    const _hpTxt = _hp >= 1000 ? _hp.toFixed(1) : _hp >= 10 ? _hp.toFixed(2) : _hp >= 1 ? _hp.toFixed(3) : _hp.toFixed(4);
    let _hpRight = W;
    try { const _tw = mainChart.timeScale().width(); if (_tw > 0) _hpRight = _tw; } catch (e) {}
    drawCtx.fillText(_hpTxt, Math.max(5, _hpRight - drawCtx.measureText(_hpTxt).width - 5), y - 3);
    if (isSelected) {
      drawCtx.fillStyle = "rgba(255,255,255,0.15)";
      drawCtx.fillRect(0, y - 6, W, 12);
      drawCtx.fillStyle = col;
      [W * 0.25, W * 0.5, W * 0.75].forEach(hx => {
        drawCtx.beginPath(); drawCtx.arc(hx, y, 4, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "vline") {
    const x = _timeToX(d.time);
    if (x == null || x < -5 || x > W + 5) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(x, 0); drawCtx.lineTo(x, H); drawCtx.stroke();
    if (isSelected) {
      drawCtx.shadowBlur = 0;
      drawCtx.fillStyle = "rgba(255,255,255,0.15)";
      drawCtx.fillRect(x - 6, 0, 12, H);
      drawCtx.fillStyle = col;
      [H * 0.25, H * 0.5, H * 0.75].forEach(hy => {
        drawCtx.beginPath(); drawCtx.arc(x, hy, 4, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "avwap") {
    const curve = _avwapCurve(d);
    if (!curve || curve.length < 2) { drawCtx.restore(); return; }
    drawCtx.beginPath();
    let started = false, lastX = null, lastY = null;
    for (const pt of curve) {
      if (pt.v == null) { started = false; continue; }
      const px = _timeToX(pt.t);
      if (px == null || px < -50 || px > W + 50) { started = false; continue; }
      const py = candleSeries?.priceToCoordinate(pt.v);
      if (py == null) { started = false; continue; }
      if (!started) { drawCtx.moveTo(px, py); started = true; } else drawCtx.lineTo(px, py);
      lastX = px; lastY = py;
    }
    drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    // 錨點標記：倒三角落在起算那根上方
    const ax = _timeToX(curve[0].t), ay = candleSeries?.priceToCoordinate(curve[0].v);
    if (ax != null && ay != null) {
      drawCtx.beginPath();
      drawCtx.moveTo(ax, ay - 6); drawCtx.lineTo(ax - 4, ay - 12); drawCtx.lineTo(ax + 4, ay - 12);
      drawCtx.closePath(); drawCtx.fill();
      if (isSelected) {   // 選中→錨點加大控制點(可拖移改起算點)
        drawCtx.beginPath(); drawCtx.arc(ax, ay, 5, 0, Math.PI * 2); drawCtx.fill();
      }
    }
    if (lastX != null && lastY != null) {   // 末端標籤
      drawCtx.font = "10px monospace";
      drawCtx.fillText("AVWAP", Math.min(lastX + 5, W - 46), lastY - 4);
    }
  }
  else if (d.type === "trendline" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const hoverPart = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
      const r = isSelected ? (hoverPart === ep ? 7 : 5) : 3;
      drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
    });
  }
  else if (d.type === "rect" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    drawCtx.save(); drawCtx.globalAlpha *= 0.12; drawCtx.fillStyle = d.color || _drawColor; drawCtx.fillRect(rx, ry, rw, rh); drawCtx.restore();   // 半透明底
    /* ★ 2026-08-06 平時不畫邊框（使用者：「矩形不要有邊框，會擋到 K 棒」）。
       只留半透明底標示範圍，K 棒完全看得見。
       ⚠ 但 hover/選取時要畫回來：矩形的可抓區域**就是邊框**（中間抓不到，
         這點 2026-08-03 已踩過 —— 拖矩形中心完全不動、只有邊框 8px 內抓得到），
         完全沒有邊框的話使用者不知道要拖哪裡。 */
    if (isSelected || isHovered) drawCtx.strokeRect(rx, ry, rw, rh);          // 邊框(承 strokeStyle/lineWidth)
    drawCtx.shadowBlur = 0;
    // 中線(0.5 高度)水平虛線：一眼看出方框的中間價位
    drawCtx.save();
    drawCtx.setLineDash([5, 4]); drawCtx.globalAlpha *= 0.65;
    const _midY = ry + rh / 2;
    drawCtx.beginPath(); drawCtx.moveTo(rx, _midY); drawCtx.lineTo(rx + rw, _midY); drawCtx.stroke();
    drawCtx.restore();
    // 四角把手：選取時可拖(p1/p2 對角＝拖任一角即改大小)；hover/選取才顯示
    const hoverPartR = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    if (isSelected || isHovered) {
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        const r = isSelected ? (hoverPartR === ep ? 7 : 5) : 3;
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "measure" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    const dpr = d.p2.price - d.p1.price, up = dpr >= 0, col = up ? "38,198,166" : "255,82,82";
    drawCtx.save(); drawCtx.globalAlpha *= 0.12; drawCtx.fillStyle = `rgb(${col})`; drawCtx.fillRect(rx, ry, rw, rh); drawCtx.restore();  // 半透明底(綠漲/紅跌)
    drawCtx.save();
    drawCtx.strokeStyle = `rgba(${col},0.9)`; drawCtx.lineWidth = 1.4; drawCtx.setLineDash([]);
    drawCtx.strokeRect(rx, ry, rw, rh);
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();   // 對角方向線
    drawCtx.restore();
    drawCtx.shadowBlur = 0;
    // 標籤:漲跌%、點數、K棒數、時長
    const pct = d.p1.price ? (dpr / d.p1.price * 100) : 0;
    const _int = (ohlcvData.length >= 2) ? (toTime(ohlcvData[ohlcvData.length - 1].time) - toTime(ohlcvData[ohlcvData.length - 2].time)) : 0;
    const bars = _int > 0 ? Math.round(Math.abs(d.p2.time - d.p1.time) / _int) : 0;
    const _tc = up ? "#7effd9" : "#ff9a9a";
    _deltaBox(drawCtx, b.x, b.y, [
      { t: `${up ? "▲" : "▼"} ${(pct >= 0 ? "+" : "")}${pct.toFixed(2)}%`, c: _tc },
      { t: `${(dpr >= 0 ? "+" : "")}${_fmtP(dpr)}`, c: "#e6e6e6" },
      { t: `${bars} 根 · ${_fmtDur(Math.abs(d.p2.time - d.p1.time))}`, c: "#b8bcc8" },
    ], W, H);
    const hoverPartM = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    if (isSelected || isHovered) {
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        const r = isSelected ? (hoverPartM === ep ? 7 : 5) : 3;
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "ray" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) { drawCtx.restore(); return; }
    const t = dx > 0 ? (W - a.x) / dx : -a.x / dx;
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy); drawCtx.stroke();
    drawCtx.shadowBlur = 0;
    const hoverPartRay = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
    [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
      const r = isSelected ? (hoverPartRay === ep ? 7 : 5) : 3;
      drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
    });
  }
  else if (d.type === "arrow" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    // 主線 p1→p2
    drawCtx.lineCap = "round";
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    // 箭頭（尖端在 p2、朝 p1→p2 方向）
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const hl  = 12 + (d.width || DRAW_WIDTH) * 2;   // 箭頭邊長隨線寬
    const ha  = Math.PI / 7;                        // 箭頭張角
    drawCtx.beginPath();
    drawCtx.moveTo(b.x, b.y);
    drawCtx.lineTo(b.x - hl * Math.cos(ang - ha), b.y - hl * Math.sin(ang - ha));
    drawCtx.lineTo(b.x - hl * Math.cos(ang + ha), b.y - hl * Math.sin(ang + ha));
    drawCtx.closePath(); drawCtx.fill();            // 實心箭頭
    drawCtx.shadowBlur = 0;
    // 端點小圓點只在「選取時」當拖移把手顯示；平時箭頭乾淨、兩端不出現圓點。
    if (isSelected) {
      const hoverPartArr = _endpointHit(d, _mx, _my);
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, hoverPartArr === ep ? 7 : 5, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "circle" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    drawCtx.beginPath(); drawCtx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    drawCtx.stroke();
    if (isSelected) {   // 兩個對角把手（沿用 p1/p2 的拖曳邏輯）
      const hp = _endpointHit(d, _mx, _my);
      [[a, "p1"], [b, "p2"]].forEach(([q, ep]) => {
        drawCtx.beginPath(); drawCtx.arc(q.x, q.y, hp === ep ? 7 : 5, 0, Math.PI * 2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "path" && Array.isArray(d.pts) && d.pts.length >= 2) {
    const ps = d.pts.map(q => chartToScreen(q.time, q.price)).filter(Boolean);
    if (ps.length < 2) { drawCtx.restore(); return; }
    drawCtx.lineCap = "round"; drawCtx.lineJoin = "round";
    drawCtx.beginPath(); drawCtx.moveTo(ps[0].x, ps[0].y);
    for (let i = 1; i < ps.length; i++) drawCtx.lineTo(ps[i].x, ps[i].y);
    drawCtx.stroke();
    // 箭頭在最後一段的末端，方向沿最後一段
    const q1 = ps[ps.length - 2], q2 = ps[ps.length - 1];
    const ang = Math.atan2(q2.y - q1.y, q2.x - q1.x);
    const hl = 12 + (d.width || DRAW_WIDTH) * 2, ha = Math.PI / 7;
    drawCtx.beginPath();
    drawCtx.moveTo(q2.x, q2.y);
    drawCtx.lineTo(q2.x - hl * Math.cos(ang - ha), q2.y - hl * Math.sin(ang - ha));
    drawCtx.lineTo(q2.x - hl * Math.cos(ang + ha), q2.y - hl * Math.sin(ang + ha));
    drawCtx.closePath(); drawCtx.fill();
    drawCtx.shadowBlur = 0;
    if (isSelected) {   // 每個轉折點都是把手
      const hp = _endpointHit(d, _mx, _my);
      ps.forEach((q, i) => {
        drawCtx.beginPath(); drawCtx.arc(q.x, q.y, hp === ("pt" + i) ? 7 : 5, 0, Math.PI * 2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "fib" && d.p1 && d.p2) {
    const a = chartToScreen(d.p1.time, d.p1.price);
    const b = chartToScreen(d.p2.time, d.p2.price);
    if (!a || !b) { drawCtx.restore(); return; }
    const priceRange = d.p2.price - d.p1.price;
    const xLeft  = Math.min(a.x, b.x);
    const xRight = Math.max(a.x, b.x);   // 線只畫到右端點，不再無限延伸到畫布右緣
    const _fibPriceFmt = p => p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4);
    // hex → rgba（線條／底色淡化用）
    const _fibRgba = (hex, al) => {
      const m = String(hex).match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
      return m ? `rgba(${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)},${al})` : hex;
    };
    const _fibLevels = [[0,"#ef5350"],[0.236,"#ff9800"],[0.382,"#ffcc02"],[0.5,"#26a69a"],[0.618,"#26a69a"],[0.786,"#ff9800"],[1,"#ef5350"]];
    // 先算每層級的 y 座標
    const _fibYs = _fibLevels.map(([lvl, lcol]) => {
      const price = d.p1.price + priceRange * (1 - lvl);
      return { lvl, lcol, price, y: candleSeries?.priceToCoordinate(price) };
    });
    // ① 各層級之間填半透明底色（仿台歐美三盤），底色取下緣層級的色
    for (let i = 0; i < _fibYs.length - 1; i++) {
      const top = _fibYs[i], bot = _fibYs[i + 1];
      if (top.y == null || bot.y == null) continue;
      drawCtx.fillStyle = _fibRgba(bot.lcol, 0.04);
      drawCtx.fillRect(xLeft, top.y, xRight - xLeft, bot.y - top.y);
    }
    // ② 各層級線（色淡一些）＋ 右側標籤
    _fibYs.forEach(({ lvl, lcol, price, y }) => {
      if (y == null) return;
      const edge = (lvl === 0 || lvl === 1);
      drawCtx.strokeStyle = _fibRgba(lcol, edge ? 0.75 : 0.5);   // 線條淡化
      drawCtx.lineWidth = edge ? 1.5 : 1;
      drawCtx.setLineDash(edge ? [] : [5,3]);
      drawCtx.shadowBlur = isSelected ? 6 : 0; drawCtx.shadowColor = lcol;
      drawCtx.beginPath(); drawCtx.moveTo(xLeft, y); drawCtx.lineTo(xRight, y); drawCtx.stroke();
      drawCtx.setLineDash([]); drawCtx.shadowBlur = 0;
      drawCtx.font = "10px monospace"; drawCtx.fillStyle = _fibRgba(lcol, 0.85);
      const _fibTxt = `${(lvl*100).toFixed(1)}%  ${_fibPriceFmt(price)}`;
      // 預設標籤放右端點外側；若太靠畫布右緣會被裁切 → 改放右端點內側靠右對齊
      if (xRight + 90 > W) {
        drawCtx.textAlign = "right"; drawCtx.fillText(_fibTxt, xRight - 4, y - 3); drawCtx.textAlign = "left";
      } else {
        drawCtx.fillText(_fibTxt, xRight + 4, y - 3);
      }
    });
    // endpoint handles at p1 / p2
    if (isHovered || isSelected) {
      const hoverPartFib = (isHovered || isSelected) ? _endpointHit(d, _mx, _my) : null;
      drawCtx.fillStyle = col;
      [[a, "p1"], [b, "p2"]].forEach(([p, ep]) => {
        const r = isSelected ? (hoverPartFib === ep ? 7 : 5) : 3;
        drawCtx.beginPath(); drawCtx.arc(p.x, p.y, r, 0, Math.PI*2); drawCtx.fill();
      });
    }
  }
  else if (d.type === "text") {
    const p = chartToScreen(d.time, d.price);
    if (!p) { drawCtx.restore(); return; }
    drawCtx.font = `bold ${isSelected ? 13 : 12}px sans-serif`;
    drawCtx.fillText(d.text, p.x + 5, p.y - 5);
    drawCtx.shadowBlur = 0;
    drawCtx.beginPath(); drawCtx.arc(p.x, p.y, isSelected ? 4 : 3, 0, Math.PI*2); drawCtx.fill();
    if (isSelected) {
      const m = drawCtx.measureText(d.text);
      drawCtx.strokeStyle = col; drawCtx.lineWidth = 1; drawCtx.setLineDash([3,2]);
      drawCtx.strokeRect(p.x + 3, p.y - 18, m.width + 6, 16);
      drawCtx.setLineDash([]);
    }
  }
  else if (d.type === "emoji") {
    const p = chartToScreen(d.time, d.price);
    if (!p) { drawCtx.restore(); return; }
    drawCtx.shadowBlur = 0;
    const sz = _emojiSize(d);   // 隨 K 棒縮放,已限幅(放大上限 _EMOJI_MAX_ZOOM)
    drawCtx.font = `${sz}px sans-serif`;
    drawCtx.textAlign = "center";
    // ⚠ textBaseline="middle" 對 emoji 字形不是真的置中,偏差還會隨字級放大而變大 → 放大時 emoji 往上位移
    //   ＝「位置跑掉」。改用實際字形邊界(measureText)把「視覺中心」對準錨點,與字級無關、放大縮小都不位移。
    drawCtx.textBaseline = "alphabetic";
    const _em = drawCtx.measureText(d.text || "❓");
    const _asc = _em.actualBoundingBoxAscent || sz * 0.75;
    const _desc = _em.actualBoundingBoxDescent || sz * 0.1;
    drawCtx.fillText(d.text || "❓", p.x, p.y + (_asc - _desc) / 2);   // 邊界中心 = 錨點 p.y
    drawCtx.textAlign = "start";
    if (isSelected) {   // 選中框 + 右下角縮放把手
      drawCtx.strokeStyle = "#2962ff"; drawCtx.lineWidth = 1; drawCtx.setLineDash([3,2]);
      drawCtx.strokeRect(p.x - sz/2 - 3, p.y - sz/2 - 3, sz + 6, sz + 6);
      drawCtx.setLineDash([]);
      drawCtx.fillStyle = "#2962ff";
      drawCtx.beginPath(); drawCtx.arc(p.x + sz/2 + 3, p.y + sz/2 + 3, 5, 0, Math.PI*2); drawCtx.fill();
    }
  }
  else if (d.type === "longpos" && d.p1) {
    const entryRefP = d.p1.price;
    const entryY = candleSeries?.priceToCoordinate(entryRefP);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);
    const slY    = candleSeries?.priceToCoordinate(d.sl);
    const startX = _timeToX(d.p1.time);
    if (entryY == null || tpY == null || slY == null || startX == null) { drawCtx.restore(); return; }

    // 色塊寬度隨縮放動態計算（約 18 根 K 棒的寬度）
    const visR  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV = visR ? Math.max(10, visR.to - visR.from) : 50;
    const ZONE_W = Math.max(20, Math.min(W * 0.4, Math.round(W * (d.barWidth ?? 3) / barsV)));
    const ex  = startX;
    const rx  = Math.min(W, ex + ZONE_W);
    const lw  = d.width || 1;

    drawCtx.shadowBlur = 0;
    drawCtx.font = "11px sans-serif";

    // 右側標籤 helper
    const rightLabel = (y, text, bg, fg) => {
      const tw = drawCtx.measureText(text).width;
      const pad = 6, lh = 17, lw2 = tw + pad * 2;
      drawCtx.fillStyle = bg;
      drawCtx.fillRect(W - lw2 - 1, y - 9, lw2, lh);
      drawCtx.fillStyle = fg;
      drawCtx.fillText(text, W - lw2 - 1 + pad, y + 4);
    };

    // 色塊（entry → rx）
    if (rx > ex) {
      drawCtx.fillStyle = "rgba(38,166,154,0.18)";
      drawCtx.fillRect(ex, tpY, rx - ex, entryY - tpY);
      drawCtx.fillStyle = "rgba(239,83,80,0.18)";
      drawCtx.fillRect(ex, entryY, rx - ex, slY - entryY);
    }

    // 進場虛線（entry 垂直線）
    if (ex >= 0 && ex <= W) {
      drawCtx.strokeStyle = "rgba(255,255,255,0.4)";
      drawCtx.lineWidth = 1;
      drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(ex, slY); drawCtx.stroke();
      drawCtx.setLineDash([]);
    }

    // 水平線（ex → rx）：預估 TP 主線
    drawCtx.strokeStyle = "#26a69a";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();

    // 實際 TP（虛線，僅 _isAutoRR 且有 tpAct 才畫）
    let tpActY = null;
    if (d.tpAct != null) {
      tpActY = candleSeries?.priceToCoordinate(d.tpAct);
      if (tpActY != null) {
        drawCtx.save();
        drawCtx.strokeStyle = "rgba(38,166,154,0.8)";
        drawCtx.lineWidth = 1;
        drawCtx.setLineDash([5, 3]);
        drawCtx.beginPath(); drawCtx.moveTo(ex, tpActY); drawCtx.lineTo(rx, tpActY); drawCtx.stroke();
        drawCtx.setLineDash([]);
        drawCtx.restore();
      }
    }

    drawCtx.strokeStyle = col;
    drawCtx.lineWidth = isSelected ? lw * 1.5 : lw * 1.2;
    drawCtx.beginPath(); drawCtx.moveTo(ex, entryY); drawCtx.lineTo(rx, entryY); drawCtx.stroke();

    drawCtx.strokeStyle = "#ef5350";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(rx, slY); drawCtx.stroke();

    // 進場三角（在 entry 左側，指向右進入色塊）
    if (ex >= 0 && ex <= W) {
      const ts = 7;
      drawCtx.fillStyle = col;
      drawCtx.beginPath();
      drawCtx.moveTo(ex, entryY - ts / 2);
      drawCtx.lineTo(ex + ts, entryY);
      drawCtx.lineTo(ex, entryY + ts / 2);
      drawCtx.closePath(); drawCtx.fill();
    }

    // R:R — 長單 reward = tp-entry、risk = entry-sl；正負號保留
    const refEntry = d.p1.price;
    const reward    = d.tp - refEntry;           // long: 正 = 對 / 負 = 反向（不利）
    const risk      = refEntry - d.sl;           // 預期為正
    const rrEst     = (risk !== 0) ? (reward / risk).toFixed(2) : "∞";
    const rewardAct = (d.tpAct != null) ? (d.tpAct - refEntry) : null;
    const rrAct     = (rewardAct != null && risk !== 0) ? (rewardAct / risk).toFixed(2) : null;
    const tpCY      = (tpY + entryY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt = (rrAct != null && d._isAutoRR)
      ? `預估 1:${rrEst}  ⇢  實際 1:${rrAct}`
      : `1 : ${rrEst}`;
    _drawRRLabel(drawCtx, rrTxt, (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)", ex, rx, tpCY, W);

    // 右側標籤
    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const entryLabel = `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(tpY,    tpLabel,    "rgba(38,166,154,0.9)", "#fff");
    if (tpActY != null) rightLabel(tpActY, `實際 ${_fmtPx(d.tpAct)}`, "rgba(38,166,154,0.55)", "#fff");
    rightLabel(entryY, entryLabel, "rgba(55,55,55,0.9)", "#ddd");
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,         "rgba(239,83,80,0.9)",  "#fff");

    // 選中時：TP/SL 拖移把手 + 右邊緣寬度把手
    if (isSelected) {
      [[ex, entryY, "#ffffff"], [ex, tpY, "#26a69a"], [ex, slY, "#ef5350"]].forEach(([px, py, fc]) => {
        if (px >= 0 && px <= W) {
          drawCtx.fillStyle = fc;
          drawCtx.beginPath(); drawCtx.arc(px, py, 5, 0, Math.PI * 2); drawCtx.fill();
        }
      });
      // 右邊緣寬度把手
      const midY = (tpY + slY) / 2;
      drawCtx.strokeStyle = "rgba(255,255,255,0.75)";
      drawCtx.lineWidth = 2; drawCtx.setLineDash([]);
      drawCtx.beginPath(); drawCtx.moveTo(rx, tpY); drawCtx.lineTo(rx, slY); drawCtx.stroke();
      drawCtx.fillStyle = "rgba(255,255,255,0.9)";
      [-7, 0, 7].forEach(oy => { drawCtx.beginPath(); drawCtx.arc(rx, midY + oy, 2.5, 0, Math.PI * 2); drawCtx.fill(); });
      // TP / SL 拖移提示箭頭（↕）
      drawCtx.font = "bold 11px sans-serif";
      drawCtx.fillStyle = "rgba(255,255,255,0.7)";
      const midX = ex + (rx - ex) / 2;
      if (rx - ex > 30) {
        drawCtx.fillText("↕", midX - 5, tpY - 4);
        drawCtx.fillText("↕", midX - 5, slY + 12);
      }
    }
  }
  else if (d.type === "shortpos" && d.p1) {
    // shortpos: SL 在 entry 上方（紅），TP 在 entry 下方（綠）
    const entryRefP = d.p1.price;
    const entryY = candleSeries?.priceToCoordinate(entryRefP);
    const tpY    = candleSeries?.priceToCoordinate(d.tp);   // tp < entry → tpY > entryY
    const slY    = candleSeries?.priceToCoordinate(d.sl);   // sl > entry → slY < entryY
    const startX = _timeToX(d.p1.time);
    if (entryY == null || tpY == null || slY == null || startX == null) { drawCtx.restore(); return; }

    const visR2  = mainChart.timeScale().getVisibleLogicalRange();
    const barsV2 = visR2 ? Math.max(10, visR2.to - visR2.from) : 50;
    const ZONE_W = Math.max(20, Math.min(W * 0.4, Math.round(W * (d.barWidth ?? 3) / barsV2)));
    const ex  = startX;
    const rx  = Math.min(W, ex + ZONE_W);
    const lw  = d.width || 1;

    drawCtx.shadowBlur = 0;
    drawCtx.font = "11px sans-serif";

    const rightLabel = (y, text, bg, fg) => {
      const tw = drawCtx.measureText(text).width;
      const pad = 6, lh = 17, lw2 = tw + pad * 2;
      drawCtx.fillStyle = bg;
      drawCtx.fillRect(W - lw2 - 1, y - 9, lw2, lh);
      drawCtx.fillStyle = fg;
      drawCtx.fillText(text, W - lw2 - 1 + pad, y + 4);
    };

    // 色塊（entry → rx）
    if (rx > ex) {
      drawCtx.fillStyle = "rgba(239,83,80,0.18)";
      drawCtx.fillRect(ex, slY, rx - ex, entryY - slY);
      drawCtx.fillStyle = "rgba(38,166,154,0.18)";
      drawCtx.fillRect(ex, entryY, rx - ex, tpY - entryY);
    }

    // 進場虛線
    if (ex >= 0 && ex <= W) {
      drawCtx.strokeStyle = "rgba(255,255,255,0.4)";
      drawCtx.lineWidth = 1;
      drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(ex, tpY); drawCtx.stroke();
      drawCtx.setLineDash([]);
    }

    drawCtx.strokeStyle = "#ef5350";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, slY); drawCtx.lineTo(rx, slY); drawCtx.stroke();

    drawCtx.strokeStyle = col;
    drawCtx.lineWidth = isSelected ? lw * 1.5 : lw * 1.2;
    drawCtx.beginPath(); drawCtx.moveTo(ex, entryY); drawCtx.lineTo(rx, entryY); drawCtx.stroke();

    drawCtx.strokeStyle = "#26a69a";
    drawCtx.lineWidth = isSelected ? lw + 0.5 : lw;
    drawCtx.beginPath(); drawCtx.moveTo(ex, tpY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();

    // 實際 TP（虛線；shortpos：tpAct 通常在 tp 上下方）
    let tpActY = null;
    if (d.tpAct != null) {
      tpActY = candleSeries?.priceToCoordinate(d.tpAct);
      if (tpActY != null) {
        drawCtx.save();
        drawCtx.strokeStyle = "rgba(38,166,154,0.8)";
        drawCtx.lineWidth = 1;
        drawCtx.setLineDash([5, 3]);
        drawCtx.beginPath(); drawCtx.moveTo(ex, tpActY); drawCtx.lineTo(rx, tpActY); drawCtx.stroke();
        drawCtx.setLineDash([]);
        drawCtx.restore();
      }
    }

    // 進場三角
    if (ex >= 0 && ex <= W) {
      const ts = 7;
      drawCtx.fillStyle = col;
      drawCtx.beginPath();
      drawCtx.moveTo(ex, entryY - ts / 2);
      drawCtx.lineTo(ex + ts, entryY);
      drawCtx.lineTo(ex, entryY + ts / 2);
      drawCtx.closePath(); drawCtx.fill();
    }

    // R:R — 空單 reward = entry-tp、risk = sl-entry；正負號保留
    const refEntry = d.p1.price;
    const reward    = refEntry - d.tp;           // short: 正 = 對 / 負 = 反向
    const risk      = d.sl - refEntry;
    const rrEst     = (risk !== 0) ? (reward / risk).toFixed(2) : "∞";
    const rewardAct = (d.tpAct != null) ? (refEntry - d.tpAct) : null;
    const rrAct     = (rewardAct != null && risk !== 0) ? (rewardAct / risk).toFixed(2) : null;
    const tpCY      = (entryY + tpY) / 2;
    drawCtx.font = "bold 12px sans-serif";
    const rrTxt = (rrAct != null && d._isAutoRR)
      ? `預估 1:${rrEst}  ⇢  實際 1:${rrAct}`
      : `1 : ${rrEst}`;
    _drawRRLabel(drawCtx, rrTxt, (parseFloat(rrEst) < 0) ? "rgba(239,83,80,0.95)" : "rgba(38,166,154,0.95)", ex, rx, tpCY, W);

    drawCtx.font = "11px sans-serif";
    const tpLabel = d._isAutoRR ? `預估 ${_fmtPx(d.tp)}` : `TP  ${_fmtPx(d.tp)}`;
    const entryLabel = `▶  ${_fmtPx(d.p1.price)}`;
    rightLabel(slY,    `SL  ${_fmtPx(d.sl)}`,      "rgba(239,83,80,0.9)",  "#fff");
    rightLabel(entryY, entryLabel, "rgba(55,55,55,0.9)", "#ddd");
    rightLabel(tpY,    tpLabel,                    "rgba(38,166,154,0.9)", "#fff");
    if (tpActY != null) rightLabel(tpActY, `實際 ${_fmtPx(d.tpAct)}`, "rgba(38,166,154,0.55)", "#fff");

    if (isSelected) {
      [[ex, entryY, "#ffffff"], [ex, slY, "#ef5350"], [ex, tpY, "#26a69a"]].forEach(([px, py, fc]) => {
        if (px >= 0 && px <= W) {
          drawCtx.fillStyle = fc;
          drawCtx.beginPath(); drawCtx.arc(px, py, 5, 0, Math.PI * 2); drawCtx.fill();
        }
      });
      // 右邊緣寬度把手
      const midY2 = (slY + tpY) / 2;
      drawCtx.strokeStyle = "rgba(255,255,255,0.75)";
      drawCtx.lineWidth = 2; drawCtx.setLineDash([]);
      drawCtx.beginPath(); drawCtx.moveTo(rx, slY); drawCtx.lineTo(rx, tpY); drawCtx.stroke();
      drawCtx.fillStyle = "rgba(255,255,255,0.9)";
      [-7, 0, 7].forEach(oy => { drawCtx.beginPath(); drawCtx.arc(rx, midY2 + oy, 2.5, 0, Math.PI * 2); drawCtx.fill(); });
      drawCtx.font = "bold 11px sans-serif";
      drawCtx.fillStyle = "rgba(255,255,255,0.7)";
      const midX = ex + (rx - ex) / 2;
      if (rx - ex > 30) {
        drawCtx.fillText("↕", midX - 5, slY - 4);
        drawCtx.fillText("↕", midX - 5, tpY + 12);
      }
    }
  }

  drawCtx.restore();
}

function drawPreview(type, a, b, W, H) {
  drawCtx.save();

  if (type === "circle") {
    drawCtx.strokeStyle = _drawColor; drawCtx.lineWidth = DRAW_WIDTH; drawCtx.setLineDash([4, 3]);
    drawCtx.beginPath();
    drawCtx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
                    Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
    drawCtx.stroke(); drawCtx.setLineDash([]);
    drawCtx.restore(); return;
  }

  if (type === "longpos" || type === "shortpos") {
    const mirrorY = 2 * a.y - b.y;
    const isLong  = type === "longpos";
    const tpY     = isLong ? Math.min(b.y, mirrorY) : Math.max(b.y, mirrorY);
    const slY     = isLong ? Math.max(b.y, mirrorY) : Math.min(b.y, mirrorY);
    const lineW   = Math.min(100, W - a.x);
    // 色塊
    drawCtx.fillStyle = "rgba(38,166,154,0.13)";
    drawCtx.fillRect(a.x, isLong ? tpY : a.y, lineW, isLong ? a.y - tpY : slY - a.y);
    drawCtx.fillStyle = "rgba(239,83,80,0.13)";
    drawCtx.fillRect(a.x, isLong ? a.y : tpY, lineW, isLong ? slY - a.y : a.y - tpY);
    // TP / Entry / SL 線
    [[isLong ? tpY : slY, "#26a69a"], [a.y, "rgba(255,255,255,0.7)"], [isLong ? slY : tpY, "#ef5350"]].forEach(([ly, lc]) => {
      drawCtx.strokeStyle = lc; drawCtx.lineWidth = 1; drawCtx.setLineDash([4, 3]);
      drawCtx.beginPath(); drawCtx.moveTo(a.x, ly); drawCtx.lineTo(a.x + lineW, ly); drawCtx.stroke();
    });
    drawCtx.restore();
    return;
  }

  if (type === "rect") {
    const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    drawCtx.strokeStyle = "rgba(255,255,255,0.7)"; drawCtx.lineWidth = 1; drawCtx.setLineDash([5, 4]);
    drawCtx.strokeRect(rx, ry, rw, rh);
    const _midY = ry + rh / 2;                                    // 中線(0.5)虛線:畫的過程也顯示
    drawCtx.beginPath(); drawCtx.moveTo(rx, _midY); drawCtx.lineTo(rx + rw, _midY); drawCtx.stroke();
    drawCtx.restore();
    return;
  }
  if (type === "measure") {   // 測量拖曳預覽:綠漲/紅跌框(Δ資訊由 _drawDrawTags 顯示)
    const cp = screenToChart(b.x, b.y), ap = screenToChart(a.x, a.y);
    const up = (cp && ap) ? (cp.price >= ap.price) : true;
    const col = up ? "38,198,166" : "255,82,82";
    const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    drawCtx.save(); drawCtx.globalAlpha *= 0.10; drawCtx.fillStyle = `rgb(${col})`; drawCtx.fillRect(rx, ry, rw, rh); drawCtx.restore();
    drawCtx.strokeStyle = `rgba(${col},0.9)`; drawCtx.lineWidth = 1.3; drawCtx.setLineDash([5, 4]);
    drawCtx.strokeRect(rx, ry, rw, rh);
    drawCtx.beginPath(); drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y); drawCtx.stroke();
    drawCtx.restore();
    return;
  }

  drawCtx.strokeStyle = "rgba(255,255,255,0.55)";
  drawCtx.lineWidth   = 1;
  drawCtx.setLineDash([5, 4]);
  drawCtx.beginPath();
  if (type === "ray") {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) { drawCtx.restore(); return; }
    const t = dx > 0 ? (W - a.x) / dx : -a.x / dx;
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(a.x + t*dx, a.y + t*dy);
  } else {
    drawCtx.moveTo(a.x, a.y); drawCtx.lineTo(b.x, b.y);
  }
  drawCtx.stroke();
  drawCtx.restore();
}


// ── 自我初始化：draw.js 已移出首屏 bundle，由 main.js 於首屏後閒置時動態載入。──
//   core(main.js) 對 initDrawTools 及各 toggle 皆以 typeof guard 呼叫；延遲載入時那些呼叫被跳過
//   (當下函式尚未定義)，故在此檔載入完成後自我啟動一次。旗標防重複(萬一又被併回 bundle)。
//   延遲載入必在 main.init() 之後(=_loadFx 於 init 末段排程)，故 mainChart 等 core 全域此時已就緒。
if (!window._drawBooted) {
  window._drawBooted = true;
  try {
    initDrawTools();
    initSessionToggle(); initWeekBoxToggle(); initVPToggle(); initCoachToggle(); initVwapToggle();
  } catch (e) { console.warn("draw self-init failed", e); }
}
