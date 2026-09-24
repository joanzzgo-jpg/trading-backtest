#!/usr/bin/env node
/* 守門員：報價列的 change_pct「推導」不可以算錯（2026-09-25）
 *
 * 背景：change_pct 對 crypto 是可推導的（(price-open)/open*100，實測 futures 728/728 誤差 0.0000），
 *       所以前端帶 np=1 後後端不再送它，省下差量 25.3%（同刻 A/B、8 輪 2587 列）。
 * ★★ 但**只有 crypto 成立**：台股的 change_pct 是「對前一日收盤」算的 ——
 *    同一條公式套台股，實測 2700 檔裡 2672 檔對不上。
 *    而這個壞法**完全靜默**：漲跌幅欄照樣有數字、照樣有紅綠、零 JS 錯誤，只是整欄都是錯的。
 *    既有的 check_ticker_delta_fields 對 change_pct 只驗「是不是數字」→ 抓不到。
 *
 * 判準（都要問「產品手上真正在用的那份資料」，不在測試裡複製公式）：
 *   ① crypto：前端 _tickerData 的 change_pct 必須等於同一刻後端整包(不帶 np)的值
 *      ⚠ 只比對 **price 完全相同** 的列 —— 價格不同就是不同時刻的報價，拿來比等於沒有比較
 *        （claude.md：拿會變動的量做比較，取樣時刻不同就等於沒有比較）。
 *   ② crypto：不可以有列缺 change_pct（缺了畫面上就是空白）。
 *   ③ 台股：前端 _twTickerData 的 change_pct 必須等於後端送來的值，
 *      且不可以有任何一列剛好等於 (price-open)/open*100（那就是被 crypto 公式蓋掉了）。
 *
 * ⚠ 回傳碼 2＝測試不成立（進不了場／可比對的列太少），不是通過。
 * ⚠ _tickerData / _twTickerData 是 bundle 頂層的 let、不在 window 上 → 必須用
 *   page.evaluate(**字串**)。站台 CSP 沒有 unsafe-eval，函式內呼叫 eval() 會被擋。
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fails = [];
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=1440,900", "--incognito"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errs = []; p.on("pageerror", e => errs.push(String(e).slice(0, 160)));
  try {
    await p.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.evaluate(() => { try { localStorage.setItem("announceSeenVer", "__gk__");
      sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {} });
    await p.goto(BASE, { waitUntil: "networkidle2", timeout: 90000 });
    await p.evaluate(() => { document.getElementById("announceOverlay")?.remove();
      if (window._landingEnter) window._landingEnter(); });
    await p.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 90000 });
    // 跑滿 >30 輪差量（跨過整包自癒），確保驗到的是「差量合併出來的」那份
    await sleep(40000);

    const r1 = await p.evaluate(`(async () => {
      const res = await fetch("/api/tickers?market=futures&nd=1");   // 不帶 np → 後端照送 change_pct
      const j = await res.json();
      const srv = new Map(j.tickers.map(t => [t.display || t.symbol, t]));
      const mine = _tickerData || [];
      let cmp = 0, same = 0, missing = 0; const bad = [];
      for (const t of mine) {
        const s = srv.get(t.display || t.symbol);
        if (!s) continue;
        if (t.change_pct === undefined || t.change_pct === null) { missing++; continue; }
        if (s.price !== t.price) continue;
        cmp++;
        if (Math.abs(s.change_pct - t.change_pct) <= 0.011) same++;
        else if (bad.length < 5) bad.push({ k: t.display || t.symbol, srv: s.change_pct, mine: t.change_pct });
      }
      return { n: mine.length, cmp, same, missing, bad };
    })()`);
    console.log(`   ① crypto：前端 ${r1.n} 檔　可比對(price 完全相同) ${r1.cmp} 檔　相符 ${r1.same}　缺 change_pct ${r1.missing}`);
    if (r1.cmp < 50) { console.log("✗ 可比對的列太少 → 測試不成立"); await b.close(); process.exit(2); }
    if (r1.same !== r1.cmp) fails.push(`crypto 推導值與後端不符 ${r1.cmp - r1.same} 檔：${JSON.stringify(r1.bad)}`);
    if (r1.missing) fails.push(`crypto 有 ${r1.missing} 檔缺 change_pct（畫面上會是空白）`);

    // 切到台股分頁
    await p.evaluate(() => { const b = document.querySelector('.tk-mkt-btn[data-mkt="tw"]'); if (b) b.click(); });
    await sleep(22000);
    const r2 = await p.evaluate(`(async () => {
      const res = await fetch("/api/tickers?market=tw&nd=1");
      const j = await res.json();
      const srv = new Map(j.tickers.map(t => [t.display || t.symbol, t]));
      const mine = _twTickerData || [];
      let cmp = 0, same = 0, wrongFormula = 0, missing = 0; const bad = [];
      for (const t of mine) {
        const s = srv.get(t.display || t.symbol);
        if (!s || s.change_pct == null) continue;
        // 後端有送、前端卻沒有 → 漲跌幅整欄空白（後端誤把 np 套到台股就是這個形狀）
        if (t.change_pct == null) { missing++; continue; }
        if (s.price !== t.price) continue;
        cmp++;
        if (Math.abs(s.change_pct - t.change_pct) <= 0.011) same++;
        else {
          if (bad.length < 5) bad.push({ k: t.display || t.symbol, srv: s.change_pct, mine: t.change_pct });
          if (t.open && Math.abs((t.price - t.open) / t.open * 100 - t.change_pct) < 0.02) wrongFormula++;
        }
      }
      return { n: mine.length, cmp, same, wrongFormula, missing, bad };
    })()`);
    console.log(`   ② 台股：前端 ${r2.n} 檔　可比對 ${r2.cmp} 檔　相符 ${r2.same}　` +
                `被 crypto 公式蓋掉 ${r2.wrongFormula}　後端有送但前端沒有 ${r2.missing}`);
    /* ⚠ 「可比對太少」要分兩種：真的沒資料＝測試不成立；**後端有送而前端沒有**＝那正是 bug
       （台股漲跌幅整欄空白）。第一版把兩者都當成 exit 2，等於把一種真實壞法藏起來。 */
    if (r2.missing > 50) fails.push(`台股有 ${r2.missing} 檔後端有送 change_pct、前端卻沒有（漲跌幅整欄空白）`);
    else if (r2.cmp < 50) { console.log("✗ 台股可比對的列太少 → 測試不成立"); await b.close(); process.exit(2); }
    if (r2.same !== r2.cmp) fails.push(`台股 change_pct 與後端不符 ${r2.cmp - r2.same} 檔（其中 ${r2.wrongFormula} 檔是被 (price-open)/open 蓋掉）：${JSON.stringify(r2.bad)}`);

    console.log(`   ③ 全程 JS 錯誤：${errs.length ? errs.join(" | ") : "0"}`);
    if (errs.length) fails.push("有 JS 錯誤：" + errs.join(" | "));
  } catch (e) {
    console.log("✗ 測試本身出錯：" + e.message + " → 測試不成立");
    await b.close(); process.exit(2);
  }
  await b.close();
  if (fails.length) { console.log("\n✗ 失敗："); fails.forEach(f => console.log("   - " + f)); process.exit(1); }
  console.log("\n★ crypto 的 change_pct 推導與後端逐筆相符；台股的沒有被那條公式碰到");
  process.exit(0);
})();
