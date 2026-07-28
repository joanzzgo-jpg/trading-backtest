/* ═══════════════════════════════════════════════════════════════════════════
   交易紀錄「貼上解析」——把交易所畫面複製出來的純文字轉成結構化紀錄
   （給主圖「我的實際交易」圖層用，見 draw.js `_drawMyTrades`）

   ★為什麼是「貼上文字」而不是上傳圖片辨識：
     手機作業系統本來就有 OCR（iPhone 實況文字 / Android Google Lens）——長按截圖就能
     選取複製。讓 OS 做辨識、app 只收文字：零費用、零下載、圖片不離開使用者的手機，
     準確度還是 Apple/Google 的引擎。比在 app 內塞 OCR（付費 API 或幾十 MB 的 wasm）都好。

   ★解析策略（依真實輸出定的，不是猜的）：
     實況文字的輸出順序**是亂的**（三欄版面被它拆成一欄一欄吐出來），但
     **每個標籤後面緊接著就是它的值** → 所以用「找到標籤 → 取值」而不是靠行號/順序。
     值可能與標籤同一行（被黏住，如「70x 做空成交數量ETH」），也可能在下一行。
   ═══════════════════════════════════════════════════════════════════════════ */

/* 從整份文字裡取某個標籤的值：
   ①先找含該標籤的行，取標籤後面的殘餘；②殘餘是空的就往下一行拿。
   ⚠ 殘餘可能黏著「下一個標籤」（實測「70x 做空成交數量ETH」＝方向的值＋下個標籤），
     故取到值後再用 stopRe 把後面黏住的標籤切掉。 */
// ⚠ 標籤後面通常黏著「單位」（開倉均價**USDT**、成交數量**ETH**）→ 取到的殘餘會是單位而不是值。
//   規則:殘餘若為空、或只是純英文的單位代碼 → 往下一行拿（最多跳兩行,避免無限往下抓到別人的值）。
const _TP_UNIT = /^[A-Za-z]{1,10}$/;
function _tpVal(lines, labelRe, stopRe) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(labelRe);
    if (!m) continue;
    let rest = lines[i].slice(m.index + m[0].length).trim();
    for (let k = 1; k <= 2 && (!rest || _TP_UNIT.test(rest)); k++) {
      rest = (lines[i + k] || "").trim();
    }
    if (!rest || _TP_UNIT.test(rest)) continue;
    if (stopRe) {
      const c = rest.match(stopRe);
      if (c && c.index > 0) rest = rest.slice(0, c.index).trim();
    }
    return rest;
  }
  return "";
}

// 數字：去千分位逗號與貨幣符號；「+5.79」「-1.46」保留正負號
function _tpNum(s) {
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/[-+]?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/* 「07/24 15:23:19」→「2026-07-24T15:23:19」
   ★Pionex 手機版不給年份 → 用當年；若換算出來比今天還晚（例如今天 7/28 看到 12/15），
     那一定是去年的單 → 減一年。時間本身照抄（畫面顯示的就是手機當地時間，
     draw.js `_myTradeT()` 會處理與圖表軸的對齊，這裡不做時區換算）。 */
function _tpTime(s, nowMs) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return "";
  const now = new Date(nowMs || Date.now());
  const [, mo, d, hh, mm, ss] = m;
  let y = now.getFullYear();
  const p = n => String(n).padStart(2, "0");
  const mk = yy => `${yy}-${p(mo)}-${p(d)}T${p(hh)}:${mm}:${ss || "00"}`;
  // 比「今天結束」還晚 → 判定為去年（跨年時的唯一歧義，用未來性解掉）
  if (new Date(mk(y)).getTime() > now.getTime() + 86400000) y -= 1;
  return mk(y);
}

/* 解析 Pionex「倉位詳情」頁複製出來的文字 → 一筆紀錄（給 _myTradesAdd 用）。
   回傳 { rec, warnings }：warnings 是「該讓使用者確認」的欄位，一定要顯示出來——
   OCR 錯一個數字畫到圖上很難發現，寧可多問一句。 */
function parsePionexPosition(text, nowMs) {
  const lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const warnings = [];
  const LBL = /(方向|開倉類型|掛單價格|掛單數量|成交數量|開倉均價|平倉均價|平倉盈虧|手續費|資金費|累積倉位盈虧|平倉原因|開倉時間|完全平倉時間|倉位ID)/;

  const dirRaw = _tpVal(lines, /方向/, /成交數量|開倉類型/);
  const dir = /做空|賣出|SHORT/i.test(dirRaw) ? "short" : (/做多|買入|LONG/i.test(dirRaw) ? "long" : "");
  const lev = (dirRaw.match(/(\d+(?:\.\d+)?)\s*x/i) || [])[1];

  // 標的：從「成交數量ETH / 掛單數量ETH」的單位標抓 base，從「均價USDT」抓 quote
  //   （詳情頁本身沒寫 ETH/USDT，只有欄位單位有）
  const baseM = String(text).match(/(?:成交|掛單)數量\s*([A-Z]{2,10})/);
  const quoteM = String(text).match(/均價\s*([A-Z]{2,10})/);
  const base = baseM ? baseM[1] : "", quote = quoteM ? quoteM[1] : "USDT";

  const ep = _tpNum(_tpVal(lines, /開倉均價/, LBL));
  const xp = _tpNum(_tpVal(lines, /平倉均價/, LBL));
  const qty = _tpNum(_tpVal(lines, /成交數量/, LBL));
  const fee = _tpNum(_tpVal(lines, /手續費/, LBL));
  const fund = _tpNum(_tpVal(lines, /資金費/, LBL));
  const pnlNet = _tpNum(_tpVal(lines, /累積倉位盈虧/, LBL));   // 含手續費/資金費 → 與列表「總利潤」一致
  const pnlGross = _tpNum(_tpVal(lines, /平倉盈虧/, LBL));
  const et = _tpTime(_tpVal(lines, /開倉時間/, LBL), nowMs);
  const xt = _tpTime(_tpVal(lines, /完全平倉時間/, LBL), nowMs);
  const reason = _tpVal(lines, /平倉原因/, LBL);
  const posId = (String(text).match(/倉位ID[:：]\s*([A-Za-z0-9.…]+)/) || [])[1] || "";

  if (!base) warnings.push("讀不到標的（詳情頁只有欄位單位有幣別，請確認截圖含「成交數量ETH」這類文字）");
  if (!dir) warnings.push("讀不到方向（做多/做空）");
  if (ep == null) warnings.push("讀不到開倉均價");
  if (!et) warnings.push("讀不到開倉時間");
  if (xp != null && xt === "") warnings.push("有平倉價但讀不到平倉時間");
  // 自洽檢查：方向 × 價差 應與盈虧同號（抓 OCR 把數字讀錯的最有效方法）
  if (dir && ep != null && xp != null && pnlNet != null) {
    const expWin = dir === "long" ? xp >= ep : xp <= ep;
    if (expWin !== (pnlNet >= 0)) {
      warnings.push(`數字對不上：${dir === "long" ? "做多" : "做空"} ${ep}→${xp} 應該是`
        + `${expWin ? "獲利" : "虧損"}，但盈虧是 ${pnlNet}，請確認是否有欄位讀錯`);
    }
  }

  return {
    rec: {
      sym: base ? base + quote : "",
      dir, lev: lev ? +lev : null,
      et, ep, xt, xp,
      qty: qty != null ? Math.abs(qty) : null,
      pnl: pnlNet != null ? pnlNet : pnlGross,
      fee, fund, reason, posId,
      src: "pionex-position",
    },
    warnings,
  };
}

if (typeof window !== "undefined") window.parsePionexPosition = parsePionexPosition;
if (typeof module !== "undefined" && module.exports) module.exports = { parsePionexPosition, _tpVal, _tpNum, _tpTime };
