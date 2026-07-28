/* ═══════════════════════════════════════════════════════════════════════════
   「我的實際交易」貼上視窗
   流程：貼上交易所文字 → 解析(tradeparse.js) → **顯示結果讓使用者確認/修正** → 畫到主圖(draw.js)

   ★確認這一步不能省：資料來自 OCR，錯一個數字畫到 K 線圖上很難發現。解析器的自洽檢查
     （方向×價差 vs 盈虧）會把可疑處列出來，這裡一定要顯示給使用者看。
   ★手機取得文字的方式：長按截圖 →「選取文字」→ 全選 → 拷貝（iPhone 實況文字 / Android Lens）。
     辨識由作業系統做 → 零費用、圖片不離開裝置。
   ═══════════════════════════════════════════════════════════════════════════ */

let _mtWrap = null;
let _mtPending = null;   // 已解析、待確認的紀錄

function _mtFmtT(s) { return String(s || "").replace("T", " "); }

/* 跳到某筆交易：需要時先切標的，等資料涵蓋那段時間後把視野移過去。
   ★為什麼一定要有這個（第一版漏掉、使用者回報「主圖上沒看到標記」）：
     匯入的多半是幾天前的舊單，而小時框預設只顯示最近幾根 → 標記在畫面外好幾天遠的地方，
     使用者按了「標在主圖」卻什麼都沒看到，會以為功能壞了。
   ⚠ 時間換算與 draw.js `_myTradeT()` 同一套（畫面上的當地時間 = 圖表軸時間，不可再 +8h）。 */
async function _mtGoTo(rec) {
  if (!rec || !rec.et) return;
  const inp = document.getElementById("symbolInput");
  const want = String(rec.sym || "").toUpperCase();
  const cur = String(inp?.value || "").toUpperCase().replace(/[\/\-_\s]/g, "");
  if (want && cur !== want.replace(/[\/\-_\s]/g, "")) {
    inp.value = want;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const t = toTime(rec.et) - 8 * 3600;
  const tEnd = rec.xt ? (toTime(rec.xt) - 8 * 3600) : t;

  // 時框：持倉 15 分鐘的單畫在日線上只是一個點、等於看不到 → 挑一個讓持倉至少跨 3 根 K 的時框。
  //   ★只往「更小」的時框換，不會把使用者從 1m 拉到 1d（那反而失去他原本在看的細節）。
  try {
    const dur = Math.max(60, tEnd - t);
    const TFS = [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400], ["1d", 86400]];
    let pick = TFS[0][0];
    // 取「持倉還能跨 ≥2 根」中最大的時框。⚠ 用 2 不用 3:15 分鐘的單用 3 會掉到 1m,
    //   而 1m 資料重、可回溯天數也短(見 render.js INIT/SCROLL_DAYS) → 5m 才是這種短單的合理落點。
    for (const [name, sec] of TFS) { if (dur / sec >= 2) pick = name; }
    const curTf = (typeof currentTF !== "undefined") ? currentTF : "";
    const idx = n => TFS.findIndex(x => x[0] === n);
    if (curTf && idx(pick) >= 0 && idx(curTf) > idx(pick)) {
      document.querySelector(`.tf-btn[data-tf="${pick}"]`)?.click();
    }
  } catch (e) {}
  // 等資料真的涵蓋到那段時間才移動視野（切標的/補載都是非同步的）
  for (let i = 0; i < 60; i++) {
    try {
      if (typeof ohlcvData !== "undefined" && ohlcvData.length
          && toTime(ohlcvData[0].time) <= t && toTime(ohlcvData[ohlcvData.length - 1].time) >= t) break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  const pad = Math.max(3600, (tEnd - t) * 3);     // 前後留白：至少 1 小時，或持倉時長的 3 倍
  const apply = () => {
    try {
      mainChart.timeScale().setVisibleRange({ from: t - pad, to: tEnd + pad });
      if (typeof _scheduleRenderDrawings === "function") _scheduleRenderDrawings();
    } catch (e) {}
  };
  // ★補設兩次:切標的/切時框的載入完成後,render.js 會做自己的「視野還原」,可能把我們剛設的蓋掉
  //   (第一版就是這樣:交易明明在資料裡,視野卻沒停在交易上)。多套幾次是這個專案既有的處理方式。
  apply();
  setTimeout(apply, 600);
  setTimeout(apply, 1600);
}
window._myTradesGoTo = _mtGoTo;

function _mtRender() {
  if (!_mtWrap) return;
  const body = _mtWrap.querySelector("#mtBody");
  const rec = _mtPending;
  const list = (typeof window._myTradesList === "function") ? window._myTradesList() : [];
  const cur = (document.getElementById("symbolInput")?.value || "").toUpperCase();

  let html = "";
  if (rec) {
    const w = rec.__warnings || [];
    const row = (k, v) => `<div class="mt-k">${k}</div><div class="mt-v">${v ?? "—"}</div>`;
    html += `<div class="mt-card">
      <div class="mt-title">解析結果（請確認後再匯入）</div>
      <div class="mt-grid">
        ${row("標的", rec.sym || '<span class="mt-bad">讀不到</span>')}
        ${row("方向", rec.dir === "long" ? "做多" : rec.dir === "short" ? "做空" : '<span class="mt-bad">讀不到</span>')}
        ${row("槓桿", rec.lev ? rec.lev + "x" : "—")}
        ${row("進場", `${_mtFmtT(rec.et)} @ ${rec.ep ?? "—"}`)}
        ${row("出場", rec.xt ? `${_mtFmtT(rec.xt)} @ ${rec.xp ?? "—"}` : "未平倉")}
        ${row("數量", rec.qty ?? "—")}
        ${row("盈虧", rec.pnl != null ? (rec.pnl >= 0 ? "+" : "") + rec.pnl : "—")}
        ${row("平倉原因", rec.reason || "—")}
      </div>
      ${w.length ? `<div class="mt-warn">⚠ 請確認：<br>${w.map(x => "・" + x).join("<br>")}</div>` : ""}
      <button class="mt-btn mt-ok" id="mtConfirm">確認匯入並標在主圖</button>
    </div>`;
  }

  html += `<div class="mt-card">
    <div class="mt-title">已匯入 ${list.length} 筆${cur ? `（目前標的 ${cur}）` : ""}</div>`;
  if (!list.length) {
    html += `<div class="mt-empty">還沒有紀錄。把交易所「倉位詳情」的文字貼到上面即可。</div>`;
  } else {
    html += `<div class="mt-list">` + list.map((t, i) =>
      `<div class="mt-item"><span class="${t.pnl >= 0 ? "mt-up" : "mt-dn"}">${t.dir === "long" ? "多" : "空"}</span>
        <b>${t.sym}</b> ${_mtFmtT(t.et).slice(5, 16)} @${t.ep}
        ${t.xp != null ? `→ @${t.xp}` : "（未平）"}
        <span class="${t.pnl >= 0 ? "mt-up" : "mt-dn"}">${t.pnl != null ? (t.pnl >= 0 ? "+" : "") + t.pnl : ""}</span>
        <button class="mt-go" data-i="${i}" title="跳到這筆交易的時間">跳至</button>
        <button class="mt-del" data-i="${i}" title="刪除這筆">✕</button></div>`).join("") + `</div>
      <button class="mt-btn mt-clear" id="mtClear">清除全部</button>`;
  }
  html += `</div>`;
  body.innerHTML = html;

  body.querySelector("#mtConfirm")?.addEventListener("click", () => {
    if (!_mtPending) return;
    const r = { ..._mtPending }; delete r.__warnings;
    window._myTradesAdd(r);
    _mtPending = null;
    _mtWrap.querySelector("#mtText").value = "";
    _mtRender();
    // 匯入後直接帶使用者去看（關窗 + 切標的 + 移動視野）——否則舊單在畫面外好幾天遠、等於沒反應
    _mtClose();
    _mtGoTo(r);
  });
  body.querySelector("#mtClear")?.addEventListener("click", () => {
    if (!confirm("確定清除全部交易紀錄？（只影響本機瀏覽器儲存的紀錄）")) return;
    window._myTradesClear(); _mtRender();
  });
  body.querySelectorAll(".mt-go").forEach(b => b.addEventListener("click", () => {
    const t = window._myTradesList()[+b.dataset.i];
    if (t) { _mtClose(); _mtGoTo(t); }
  }));
  body.querySelectorAll(".mt-del").forEach(b => b.addEventListener("click", () => {
    const i = +b.dataset.i, all = window._myTradesList();
    all.splice(i, 1); window._myTradesClear(); if (all.length) window._myTradesAdd(all);
    _mtRender();
  }));
}

function _mtBuild() {
  if (_mtWrap) return _mtWrap;
  const w = document.createElement("div");
  w.id = "myTradesOverlay";
  w.innerHTML = `
    <div class="mt-panel">
      <div class="mt-head">
        <span>我的實際交易</span>
        <button class="mt-x" id="mtClose" title="關閉">✕</button>
      </div>
      <div class="mt-hint">
        手機：長按交易所截圖 →「選取文字」→ 全選 → 拷貝 → 貼到下面。<br>
        電腦：交易所網頁上把那塊表格選取複製即可。<span class="mt-dim">（辨識由你的手機/電腦完成，圖片不會上傳）</span>
      </div>
      <textarea id="mtText" placeholder="在這裡貼上交易所的「倉位詳情」文字…"></textarea>
      <button class="mt-btn" id="mtParse">解析</button>
      <div id="mtBody"></div>
    </div>`;
  document.body.appendChild(w);
  const css = document.createElement("style");
  css.textContent = `
    #myTradesOverlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;
      align-items:center;justify-content:center;padding:16px}
    #myTradesOverlay .mt-panel{background:#1b2027;color:#d1d4dc;border:1px solid #2a2e39;border-radius:12px;
      width:min(560px,100%);max-height:88vh;overflow:auto;padding:16px;font-size:13px;line-height:1.6}
    #myTradesOverlay .mt-head{display:flex;justify-content:space-between;align-items:center;font-size:15px;
      font-weight:700;margin-bottom:8px}
    #myTradesOverlay .mt-x{background:none;border:none;color:#8b949e;font-size:16px;cursor:pointer}
    #myTradesOverlay .mt-hint{color:#8b949e;font-size:12px;margin-bottom:8px}
    #myTradesOverlay .mt-dim{color:#6b7280}
    #myTradesOverlay textarea{width:100%;height:120px;background:#0f1419;color:#d1d4dc;border:1px solid #2a2e39;
      border-radius:8px;padding:8px;font:12px/1.5 ui-monospace,monospace;resize:vertical}
    #myTradesOverlay .mt-btn{width:100%;margin-top:8px;padding:9px;border:none;border-radius:8px;
      background:#2a2e39;color:#d1d4dc;font-size:13px;font-weight:600;cursor:pointer}
    #myTradesOverlay .mt-ok{background:#26a69a;color:#06231f}
    #myTradesOverlay .mt-clear{background:#3a2226;color:#ef9a9a}
    #myTradesOverlay .mt-card{margin-top:12px;border:1px solid #2a2e39;border-radius:8px;padding:10px}
    #myTradesOverlay .mt-title{font-weight:700;margin-bottom:6px}
    #myTradesOverlay .mt-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 10px}
    #myTradesOverlay .mt-k{color:#8b949e}
    #myTradesOverlay .mt-bad{color:#ef5350}
    #myTradesOverlay .mt-warn{margin-top:8px;padding:8px;border-radius:6px;background:#3a2f16;color:#ffcc80;font-size:12px}
    #myTradesOverlay .mt-empty{color:#6b7280;font-size:12px}
    #myTradesOverlay .mt-item{display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid #21262d}
    #myTradesOverlay .mt-up{color:#26a69a}
    #myTradesOverlay .mt-dn{color:#ef5350}
    #myTradesOverlay .mt-go{margin-left:auto;background:#2a2e39;border:none;color:#8ab4f8;border-radius:5px;
      padding:2px 8px;font-size:11px;cursor:pointer}
    #myTradesOverlay .mt-del{background:none;border:none;color:#6b7280;cursor:pointer}
  `;
  document.head.appendChild(css);

  w.addEventListener("click", e => { if (e.target === w) _mtClose(); });
  w.querySelector("#mtClose").addEventListener("click", _mtClose);
  w.querySelector("#mtParse").addEventListener("click", () => {
    const txt = w.querySelector("#mtText").value.trim();
    if (!txt) return;
    if (typeof window.parsePionexPosition !== "function") { alert("解析模組未載入"); return; }
    const { rec, warnings } = window.parsePionexPosition(txt);
    if (!rec.et || rec.ep == null) {
      _mtPending = { ...rec, __warnings: warnings.concat("必要欄位不足，無法匯入（至少要有開倉時間與開倉均價）") };
    } else {
      _mtPending = { ...rec, __warnings: warnings };
    }
    _mtRender();
  });
  _mtWrap = w;
  return w;
}

function _mtClose() { if (_mtWrap) _mtWrap.style.display = "none"; }
function _mtOpen() { _mtBuild().style.display = "flex"; _mtRender(); }
window._myTradesOpen = _mtOpen;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnMyTrades")?.addEventListener("click", _mtOpen);
});
