#!/usr/bin/env node
/* 守門員：行情列那一行的價格不可以「往回跳」（2026-09-25；約 3~5 分鐘）
 *
 * 使用者回報：「當我按標的 a 切回標的 b，b 的合約行情價格會跳回上一秒之前的再回來」。
 *
 * 根因是**兩件各自看都正常的事湊起來**的：
 *   ① `/api/ohlcv` 的 limit 查詢有 **30 秒 TTL 快取** → 切走再切回同一檔會吃到快取，
 *      而最後那根是**形成中**的 K 棒 → 它的收盤是當初抓的。
 *      實測 ARK 1m：等 24 秒再要一次，ohlcv 末根 0.2389、同一刻 /api/latest 0.2379，**差 0.42%**。
 *   ② 前端 `_mainChartPrice` 無條件拿主圖末根當「現價」寫進那一列
 *      （`_paintTickerRow` 還會 `t.price = _mp` 寫回資料）。
 *   → 畫面上就是「跳回幾秒前的價，下一拍再回來」。**零錯誤、零跡象**。
 *   ★ 原本那道年齡閘門擋不住：它看的是**棒的時間**（1m 就是整分鐘、日線是今天 00:00），
 *     量不到「這批資料是幾點抓的」。修法＝後端 /api/ohlcv 回 `ts`（放在 cache.set 之前，
 *     快取命中時回的是當初那一刻），前端只有 1.5 秒內才准拿末根當現價。
 *
 * 判準（兩項）：
 *   ① 穩定狀態：現價線標籤 == 行情列那一行（2026-08-23 收斂成「單一現價」的成果，
 *      修 ② 時很容易順手弄壞 → 一起守著）。
 *   ② 切走→切回：那一列不可以顯示「這次吃到的那批舊 ohlcv 的末根」。
 *
 * ★★ 判準踩過的四個坑（都會讓它說謊，別改回去）：
 *   (a) **不可以拿 `_tickerData` 當參照**：`_paintTickerRow` 會把主圖價寫回那一筆
 *       ＝自己測自己（第一版量到 0.0000% 全過）。參照一律取網路上的 `/api/tickers` 回應。
 *   (b) **不可以用「這個數字上次出現在幾秒前」判斷**：小數 4 位的幣價只在幾個檔位之間來回，
 *       「現在顯示的剛好也是 5.7 秒前出現過的」是巧合（第二版誤報）。要鎖定**兇手本人**：
 *       這次那份 ohlcv 回應的末根值。
 *   (c) **標的要挑高價、流動性好的**（照「量」排序取第一檔）：小幣一個跳動就佔 0.04%，
 *       比要偵測的偏離還大，量到的全是量化雜訊。門檻另外依實測跳動值自動放大。
 *   (d) 主圖那批資料的新舊**從網路回應量**（後端回的 ts），不可以讀 `window._ohlcvTs` ——
 *       下面植回舊行為的手法就是去蓋那個變數，讀它等於量到自己灌的值。
 *
 * ★★ 自帶「測試成立性」檢查：跑完現行程式後，把新鮮度閘門灌成永遠通過（＝植回舊行為）
 *    再跑；舊行為若重現不出來（那幾輪沒吃到快取、或價格剛好沒漂），回傳 2＝測試不成立。
 *    ⚠ 快取命中是**隔輪才成立**的（命中不會刷新 TTL）→ 沒命中的那輪不算數、自動重跑。
 *
 * ⚠ 回傳碼 2＝測試不成立，不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = parseFloat(String(s).replace(/,/g, "")); return isFinite(v) ? v : null; };

(async () => {
  const fails = [];
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=1680,950", "--incognito"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1680, height: 950, deviceScaleFactor: 1 });
  const errs = []; p.on("pageerror", e => errs.push(String(e).slice(0, 160)));

  const hist = new Map();        // 行情來源自己說的價（含時間）
  const ohlcvSeen = [];          // 主圖每次拿到的那批（含後端的取樣時刻）
  p.on("response", async (res) => {
    try {
      const u = res.url();
      if (u.includes("/api/ohlcv")) {
        const j = await res.json(); const d = j.data || [];
        if (d.length && j.ts) ohlcvSeen.push({ at: Date.now(), ts: +j.ts, close: +d[d.length - 1].close });
        return;
      }
      if (!u.includes("/api/tickers")) return;
      const j = await res.json(); const now = Date.now();
      for (const t of (j.tickers || [])) {
        const id = t.display || t.symbol; if (!id || t.price == null) continue;
        if (!hist.has(id)) hist.set(id, []);
        const a = hist.get(id); a.push({ price: +t.price, t: now });
        if (a.length > 600) a.shift();
      }
    } catch (e) {}
  });

  try {
    await p.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.evaluate(() => { try { localStorage.setItem("announceSeenVer", "__gk__");
      sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {} });
    await p.goto(BASE, { waitUntil: "networkidle2", timeout: 90000 });
    await p.evaluate(() => { document.getElementById("announceOverlay")?.remove();
      if (window._landingEnter) window._landingEnter(); });   // ⚠ 唯一正解，見 claude.md
    await p.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 90000 });
    await sleep(5000);

    // 照「量」排序 → 取到的是高價、流動性好的（見坑 (c)）
    await p.evaluate(() => document.querySelector('.tk-seg-btn[data-sort="vol"]')?.click());
    await sleep(2500);
    const rows = await p.evaluate(() => [...document.querySelectorAll("#tickerList .ticker-item")]
      .slice(0, 4).map(e => e.dataset.display || e.dataset.sym));
    if (rows.length < 2) { console.log("⚠ 行情清單少於 2 列 → 測試不成立"); await b.close(); process.exit(2); }
    const B = rows[0], A = rows[1];
    console.log(`標的（照量排序）：B（切走再切回）=${B}　A（中途去的）=${A}\n`);

    const pick = (s) => p.evaluate((s) => {
      const el = [...document.querySelectorAll("#tickerList .ticker-item")]
        .find(e => (e.dataset.display || e.dataset.sym) === s); if (el) el.click();
    }, s);
    const read = (s) => p.evaluate((s) => {
      const el = [...document.querySelectorAll("#tickerList .ticker-item")]
        .find(e => (e.dataset.display || e.dataset.sym) === s);
      const lbl = document.querySelector(".current-price-label");
      return { row: el ? (el.querySelector(".tk-price-val") || {}).textContent : null,
               line: lbl ? lbl.textContent : null };
    }, s);

    /* ── ① 穩定狀態：現價線 == 那一行 ── */
    await pick(B); await sleep(7000);
    let same = 0, diff = 0, ex = null;
    for (let i = 0; i < 60; i++) {
      const r = await read(B);
      const a = num(r.row), l = num(r.line);
      if (a != null && l != null) { if (Math.abs(a - l) / l < 1e-6) same++; else { diff++; if (!ex) ex = r; } }
      await sleep(150);
    }
    if (!(same + diff)) { console.log("⚠ 量不到現價線或那一行 → 測試不成立"); await b.close(); process.exit(2); }
    console.log(`① 穩定狀態 現價線 == 行情列那一行：${same}/${same + diff}` + (ex ? `　例外：列=${ex.row} 線=${ex.line}` : ""));
    if (diff) fails.push(`現價線與行情列不一致 ${diff} 拍（例：列=${ex.row} 線=${ex.line}）`);

    /* 這檔的最小跳動＝門檻的基準（見坑 (c)）：門檻取 3 個跳動與 0.02% 的大者 */
    const tickPct = (() => {
      const a = (hist.get(B) || []).map(x => x.price);
      let m = Infinity;
      for (let i = 1; i < a.length; i++) { const d = Math.abs(a[i] - a[i-1]); if (d > 0 && d < m) m = d; }
      const px = a.length ? a[a.length - 1] : 0;
      return (isFinite(m) && px) ? m / px * 100 : 0;
    })();
    const THR = Math.max(0.02, tickPct * 3);
    console.log(`   實測最小跳動 ${tickPct.toFixed(4)}% → 偏離門檻取 ${THR.toFixed(4)}%\n`);

    /* ── ② 切走再切回不可以顯示那批舊 ohlcv 的末根 ── */
    async function round() {
      await pick(B); await sleep(4000);
      await pick(A); await sleep(20000);          // TTL 30 秒：卡在「快取還在、價格已漂」那段
      const t0 = Date.now(); const seen0 = ohlcvSeen.length;
      await pick(B);
      let stale = null, age = null; const bad = [];
      while (Date.now() - t0 < 2500) {
        if (stale == null && ohlcvSeen.length > seen0) {
          const r0 = ohlcvSeen[seen0];
          stale = r0.close; age = r0.at / 1000 - r0.ts;   // 到貨當下它已經幾秒大了
        }
        const d = num((await read(B)).row);
        const a = hist.get(B) || [];
        const cur = a.length ? a[a.length - 1] : null;
        if (stale != null && age >= 2 && d != null && cur) {
          const devNow = Math.abs(d - cur.price) / cur.price * 100;
          // 行情來源最近 3 秒內也報過這個數字 → 那就是「現在的價」，不是往回跳
          const quotedNow = a.some(x => Date.now() - x.t <= 3000 && Math.abs(x.price - d) / d < 1e-9);
          if (Math.abs(d - stale) / stale < 1e-9 && devNow > THR && !quotedNow)
            bad.push({ ms: Date.now() - t0, d, cur: cur.price, devNow, age });
        }
        await sleep(50);
      }
      return { bad, cached: age != null && age >= 2 && age < 600, age: age == null ? -1 : age, stale };
    }

    // 沒吃到快取的那輪不算數（命中不會刷新 TTL → 命中是隔輪才成立）→ 自動重跑
    const runUntil = async (wantHits, maxTries, stopOnBad) => {
      let hits = 0, bad = [];
      for (let i = 0; i < maxTries && hits < wantHits; i++) {
        const r = await round();
        console.log(`   第 ${i + 1} 次：${r.cached ? `吃到快取（那批 ${r.age.toFixed(1)} 秒大，末根 ${r.stale}）` : "沒吃到快取＝這輪不算"}　往回跳 ${r.bad.length} 拍` +
          (r.bad.length ? `　最嚴重＝切換後 ${r.bad[0].ms}ms 顯示 ${r.bad[0].d}，當下行情 ${r.bad[0].cur}（差 ${r.bad[0].devNow.toFixed(3)}%）` : ""));
        if (!r.cached) continue;
        hits++; bad = bad.concat(r.bad);
        if (stopOnBad && bad.length) break;
      }
      return { hits, bad };
    };

    console.log("② 現行程式：");
    const now = await runUntil(2, 5, false);
    if (!now.hits) { console.log("\n⚠ 五次都沒吃到 /api/ohlcv 快取 → 測試不成立"); await b.close(); process.exit(2); }
    if (now.bad.length) {
      const w = now.bad.sort((x, y) => y.devNow - x.devNow)[0];
      fails.push(`切回後把 ${w.age.toFixed(1)} 秒前那批 ohlcv 的末根 ${w.d} 當成現價（當下行情 ${w.cur}，差 ${w.devNow.toFixed(3)}%）`);
    }

    console.log("\n   植回舊行為（新鮮度閘門永遠通過＝無條件拿主圖末根當現價）：");
    await p.evaluate(`(() => { window.__gkOld = setInterval(() => { window._ohlcvTs = Date.now()/1000; }, 20); })()`);
    const old = await runUntil(3, 6, true);
    await p.evaluate(`clearInterval(window.__gkOld)`);
    if (!old.bad.length) {
      console.log(`\n⚠ 植回舊行為也沒重現（吃到快取 ${old.hits} 輪；價格在那幾輪剛好沒漂超過 ${THR.toFixed(3)}%）→ 測試不成立`);
      await b.close(); process.exit(2);
    }

    if (errs.length) fails.push(`JS 錯誤 ${errs.length} 個：${errs[0]}`);
    console.log("");
    if (fails.length) { fails.forEach(f => console.log("✗ " + f)); await b.close(); process.exit(1); }
    console.log("★ 切走再切回不會跳回舊值，且現價線與行情列仍然完全一致");
    await b.close(); process.exit(0);
  } catch (e) {
    console.log("⚠ 測試不成立：" + String(e).slice(0, 200));
    await b.close(); process.exit(2);
  }
})();
