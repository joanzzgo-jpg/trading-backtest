/* ── Footprint 足跡圖 ─────────────────────────────────────────────
   每根 K 棒內各價位的主動買/賣量：左半格=主動賣(紅)、右半格=主動買(綠)，
   顏色深淺=該列量佔比；金框=POC(最大量價位)；棒底下標 Δ(買-賣) 與總量。
   資料源 /api/footprint：1m/5m=aggTrades 精確、15m/30m/1h=1m K 線近似(標 ≈)。
   僅 crypto；預設關閉，圖例「足跡」開啟。K 棒間距要夠寬才畫（<14px 顯示提示）。 */

let _fpShow = false;
let _fpBars = [];          // [{t(圖表秒), rows:[[price,buy,sell],...], d, v, poc}]
let _fpBin = 0;
let _fpKagg = false;       // 4h/1d = 1m K線聚合（量精確、價位分鐘級）
let _fpPending = 0;        // 尚缺的分鐘數（漸進補齊中）
let _fpFastT = null;       // pending>0 時的 5s 快速補抓 timer
let _fpKey = "";           // 目前資料對應的 symbol|tf
let _fpTimer = null;
let _fpPrim = null;
let _fpFetching = false;
let _fpNextTryTs = 0;      // draw() 補抓的最早時間：成功後 +0.8s 防抖、失敗後 +5s 退避
let _fpMsg = "";           // 沒資料時顯示的狀態訊息（載入中/忙碌重試/不支援）——「開了卻沒畫面」必有回饋
const _FP_TFS = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
const _FP_IMB = 2;   // 失衡倍率：一側主動量 ≥ 另一側 ×此值 → 高亮該格（市價壓倒性打贏）
const _FP_DBOT = 6;       // 棒底 Δ/總量往下位移(px)：一般棒（棒下無箭頭）
const _FP_DBOT_MARK = 40; // 該棒有下方策略箭頭（多/破空/順多…）時的位移，讓開箭頭+字

function _fpLiveKey() {
  const sym = document.getElementById("symbolInput")?.value?.trim() || "";
  const tf = (typeof currentTF !== "undefined" && currentTF) || "";
  return sym + "|" + tf;
}

function _fpFmt(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k";
  if (v >= 100) return Math.round(v).toString();
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

async function _fpFetch() {
  if (!_fpShow || _fpFetching) return;
  const market = document.getElementById("marketSelect")?.value || "crypto";
  const symbol = document.getElementById("symbolInput")?.value?.trim() || "";
  const tf = (typeof currentTF !== "undefined" && currentTF) || "";
  if (market !== "crypto" || !symbol || !_FP_TFS.has(tf)) {
    _fpBars = []; _fpKey = _fpLiveKey();
    _fpMsg = market !== "crypto" ? "足跡：僅支援加密貨幣" : "足跡：不支援此時框（限 1m~1d）";
    if (_fpPrim) _fpPrim.requestUpdate();
    return;
  }
  _fpFetching = true;
  const key = symbol + "|" + tf;
  try {
    const res = await fetch(`/api/footprint?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`, { cache: "no-cache" });
    const j = await res.json();
    if (_fpLiveKey() !== key) return;   // 抓回來時已切標的/時框 → 丟棄
    if (j && j.ok) {
      _fpBin = j.bin || 0;
      _fpKagg = !!j.kagg;
      _fpPending = j.pending_min || 0;
      _fpBars = (j.bars || [])
        .map(b => ({ t: toTime(b.t), rows: b.rows || [], d: b.d, v: b.v, poc: b.poc, x: b.x !== false }))
        .filter(b => b.t != null && !Number.isNaN(b.t));
      _fpKey = key;   // 成功才記 key；失敗留舊 key → draw() 會走「key 不符」路徑重試
      _fpNextTryTs = Date.now() + 800;
      _fpMsg = "";
      // 還有分鐘/歷史棒沒補完 → 3.5s 快速接續（近似已先畫，逐筆逐輪覆蓋上去）
      clearTimeout(_fpFastT);
      if ((_fpPending > 0 || j.partial) && _fpShow) _fpFastT = setTimeout(_fpFetch, 3500);
    } else {
      // ⚠ 不清 _fpBars：畫面上的舊足跡（同標的）仍正確——清了會「出現一下就消失」。
      //   只有 key 相符時舊資料才會被畫；切標的中的舊資料由 draw() 的 key 檢查擋住。
      _fpMsg = _fpBars.length && _fpKey === key ? "" : "足跡：行情源忙碌中，會自動重試…";
      _fpNextTryTs = Date.now() + 5000;   // 後端回 ok:false（多半是 Binance 忙碌）→ 5s 退避
      clearTimeout(_fpFastT);
      if (_fpShow) _fpFastT = setTimeout(_fpFetch, 5200);   // 失敗也持續自動重試（不乾等 20s 輪詢）
    }
  } catch (e) {
    _fpMsg = _fpBars.length ? "" : "足跡：連線失敗，會自動重試…";
    _fpNextTryTs = Date.now() + 5000;     // 網路失敗 → 保留舊資料，5s 後再試
    clearTimeout(_fpFastT);
    if (_fpShow) _fpFastT = setTimeout(_fpFetch, 5200);
  }
  finally {
    _fpFetching = false;
    if (_fpPrim) _fpPrim.requestUpdate();
  }
}

window.toggleFootprint = function (on) {
  _fpShow = (on === undefined) ? !_fpShow : !!on;
  clearInterval(_fpTimer); _fpTimer = null;
  clearTimeout(_fpFastT); _fpFastT = null;
  if (_fpShow) {
    _fpMsg = "";
    _fpFetch();
    // 未收盤棒持續更新（後端已收盤棒有快取＋整包 10s 回應快取 → 便宜）
    _fpTimer = setInterval(_fpFetch, 20000);
  }
  const _b = document.getElementById("footprintBtn");
  if (_b) _b.classList.toggle("on", _fpShow);
  if (_fpPrim) _fpPrim.requestUpdate();
  return _fpShow;
};

// ── 主圖右上「足跡」開關按鈕（與限價單同款、排在它左邊）─────────────
function _fpEnsureBtn() {
  let b = document.getElementById("footprintBtn");
  if (b) return b;
  const host = document.getElementById("mainChart");
  if (!host) return null;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  b = document.createElement("button");
  b.id = "footprintBtn";
  b.type = "button";
  b.className = "chart-order-btn fp-btn";
  b.title = "Footprint 足跡圖：每根K棒內各價位的主動買/賣量（左紅=主動賣、右綠=主動買、金框=POC最大量價位、棒底Δ=買賣差）。1m~1h=逐筆成交精確（首次開啟漸進補齊，右上角顯示進度）；4h/1d=1m聚合（買賣量精確）。K棒間距放大後才顯示";
  b.innerHTML = '<span class="co-ico">👣</span><span class="co-txt">足跡</span>';
  b.addEventListener("click", () => window.toggleFootprint());
  host.appendChild(b);
  return b;
}

function _fpBtnRefresh() {
  const b = _fpEnsureBtn();
  if (!b) return;
  const isCrypto = (document.getElementById("marketSelect")?.value || "crypto") === "crypto";
  b.style.display = isCrypto ? "" : "none";
  if (!isCrypto && _fpShow) window.toggleFootprint(false);   // 切去台股/美股 → 自動關
  b.classList.toggle("on", _fpShow);
}

function _fpBtnInit() {
  _fpBtnRefresh();
  document.getElementById("marketSelect")?.addEventListener("change", () => setTimeout(_fpBtnRefresh, 0));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _fpBtnInit);
else _fpBtnInit();

function _makeFootprintPrimitive() {
  let _chart = null, _series = null, _req = null;
  let _settleT = null;
  const renderer = {
    draw(target) {
      if (!_fpShow || !_chart || !_series) return;
      // 標的/時框變了或上次抓失敗 → 舊資料不畫（畫了會貼錯棒），到時間就補抓（切換/失敗自癒，不等 20s 輪詢）
      const _mismatch = _fpKey !== _fpLiveKey();
      if (_mismatch && !_fpFetching && Date.now() > _fpNextTryTs) setTimeout(_fpFetch, 0);
      const _noData = _mismatch || !_fpBars.length || !_fpBin;
      const ts = _chart.timeScale();
      let bs = 10;
      try { bs = ts.options().barSpacing || 10; } catch (e) {}
      target.useBitmapCoordinateSpace(scope => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
        // 開著但還沒有資料 → 一定給狀態回饋（否則看起來像「打不開」）
        if (_noData) {
          ctx.font = `${Math.round(11 * vr)}px sans-serif`;
          ctx.textAlign = "left"; ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillText(_fpMsg || "足跡：載入中…", 8 * hr, 26 * vr);
          return;
        }
        // 間距太窄畫不下 → 只給一行提示（左上角）
        if (bs < 14) {
          ctx.font = `${Math.round(11 * vr)}px sans-serif`;
          ctx.textAlign = "left"; ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillText("足跡：放大 K 棒間距後顯示", 8 * hr, 26 * vr);
          return;
        }
        let _vrng = null; try { _vrng = ts.getVisibleRange(); } catch (e) {}
        const _lo = _vrng ? _vrng.from : -Infinity, _hi = _vrng ? _vrng.to : Infinity;
        const _nowP = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const _mv = !!(window._chartMoveTs && _nowP - window._chartMoveTs < 220);
        if (_mv) { clearTimeout(_settleT); _settleT = setTimeout(() => { if (_req) _req(); }, 240); }
        const textMode = bs >= 52 && !_mv;   // 夠寬且非平移中才畫數字
        // 有「棒下方箭頭」（多/破空/順多 等 belowBar 策略標記）的棒 → Δ 多讓一段避免疊字
        const _belowT = new Set();
        for (const arr of [window.lastFVGMSMarkers, window.lastFVGBreakMarkers,
                           window.lastFVGShunMarkers, window.lastFVGSpecialMarkers,
                           window.lastWRSignalMarkers]) {
          if (Array.isArray(arr)) for (const m of arr) if (m && m.position === "belowBar") _belowT.add(m.time);
        }
        const halfW = Math.max(4, bs * 0.46) * hr;
        const fpx = Math.round(10 * vr);
        if (textMode) { ctx.font = `${fpx}px sans-serif`; ctx.textBaseline = "middle"; }
        for (const b of _fpBars) {
          if (b.t < _lo || b.t > _hi || !b.rows.length) continue;
          const x = ts.timeToCoordinate(b.t);
          if (x == null) continue;
          const bx = x * hr;
          let rowMax = 0;
          for (const r of b.rows) { const tot = r[1] + r[2]; if (tot > rowMax) rowMax = tot; }
          if (rowMax <= 0) continue;
          let yBotMax = -Infinity;
          for (const r of b.rows) {
            const p = r[0], buy = r[1], sell = r[2];
            const yT = _series.priceToCoordinate(p + _fpBin);
            const yB = _series.priceToCoordinate(p);
            if (yT == null || yB == null) continue;
            const top = Math.min(yT, yB) * vr;
            const h = Math.max(1, Math.abs(yB - yT) * vr - Math.max(1, vr)); // 列間留 1px 縫
            if (yB * vr > yBotMax) yBotMax = yB * vr;
            // 左=賣(紅)、右=買(綠)，深淺依佔比
            ctx.fillStyle = `rgba(239,83,80,${(0.10 + 0.42 * (sell / rowMax)).toFixed(3)})`;
            ctx.fillRect(bx - halfW, top, halfW, h);
            ctx.fillStyle = `rgba(38,198,166,${(0.10 + 0.42 * (buy / rowMax)).toFixed(3)})`;
            ctx.fillRect(bx, top, halfW, h);
            // 失衡標示：某一側主動量 ≥ 另一側 _FP_IMB 倍（且該格夠大）＝市價單壓倒性打贏。
            //   買失衡→右側亮綠實心＋外框；賣失衡→左側亮紅。這就是「市價吃穿對手」的價位。
            if ((buy + sell) >= 0.28 * rowMax) {
              if (buy >= _FP_IMB * Math.max(sell, rowMax * 0.02)) {
                ctx.fillStyle = "rgba(38,255,200,0.55)";
                ctx.fillRect(bx, top, halfW, h);
                ctx.strokeStyle = "rgba(120,255,225,0.95)"; ctx.lineWidth = Math.max(1.5, 1.5 * hr);
                ctx.strokeRect(bx, top, halfW, h);
              } else if (sell >= _FP_IMB * Math.max(buy, rowMax * 0.02)) {
                ctx.fillStyle = "rgba(255,60,55,0.5)";
                ctx.fillRect(bx - halfW, top, halfW, h);
                ctx.strokeStyle = "rgba(255,140,135,0.95)"; ctx.lineWidth = Math.max(1.5, 1.5 * hr);
                ctx.strokeRect(bx - halfW, top, halfW, h);
              }
            }
            // POC：金色外框
            if (b.poc != null && p === b.poc) {
              ctx.strokeStyle = "rgba(255,209,26,0.9)";
              ctx.lineWidth = Math.max(1, hr);
              ctx.strokeRect(bx - halfW, top, halfW * 2, h);
            }
            if (textMode && h >= fpx + 2 * vr) {
              ctx.fillStyle = "rgba(255,190,185,0.95)"; ctx.textAlign = "right";
              ctx.fillText(_fpFmt(sell), bx - 3 * hr, top + h / 2);
              ctx.fillStyle = "rgba(170,255,235,0.95)"; ctx.textAlign = "left";
              ctx.fillText(_fpFmt(buy), bx + 3 * hr, top + h / 2);
            }
          }
          // 棒底：Δ(買-賣，染色) 與總量。有下方箭頭的棒多讓一段避免疊字
          if (!_mv && yBotMax > -Infinity && bs >= 26) {
            const dy = yBotMax + (_belowT.has(b.t) ? _FP_DBOT_MARK : _FP_DBOT) * vr;
            ctx.font = `${fpx}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "top";
            ctx.fillStyle = b.d >= 0 ? "rgba(38,198,166,0.95)" : "rgba(239,83,80,0.95)";
            ctx.fillText((b.d >= 0 ? "Δ+" : "Δ-") + _fpFmt(Math.abs(b.d)), bx, dy);
            if (textMode) {
              ctx.fillStyle = "rgba(255,255,255,0.55)";
              ctx.fillText(_fpFmt(b.v), bx, dy + fpx + 2 * vr);
            }
            if (textMode) ctx.textBaseline = "middle";   // 還原給下一根的列文字
          }
        }
        // 資料狀態註記（右上角小字）：漸進補齊進度 / 4h·1d 聚合說明
        if (_fpPending > 0 || _fpKagg) {
          ctx.font = `${Math.round(10 * vr)}px sans-serif`;
          ctx.textAlign = "right"; ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillText(
            _fpPending > 0 ? `足跡逐筆補齊中…剩 ${_fpPending} 分鐘` : "足跡：1m聚合（量精確）",
            scope.bitmapSize.width - 8 * hr, 26 * vr
          );
        }
      });
    },
  };
  const paneView = { renderer() { return renderer; } };
  return {
    attached(p) { _chart = p.chart; _series = p.series; _req = p.requestUpdate; },
    detached() { _chart = _series = _req = null; },
    updateAllViews() {},
    paneViews() { return [paneView]; },
    requestUpdate() { if (_req) _req(); },
  };
}
