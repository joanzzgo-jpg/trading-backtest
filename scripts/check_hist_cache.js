/* 守門員：深度歷史本機快取（IndexedDB `ahh_hist`）。需本機服務跑著；約 90 秒。
 *
 * 2026-09-24 使用者：「如果一個使用者常常打開只看 a,b 等標的，就設計成下載歷史資料在該
 * 使用者的裝置，這樣歷史 api 不用另外打」。實測切到 5m 時往回補載那一發是 **140.2 KB**，
 * 而那些是**永遠不會再變的歷史 K 棒** —— 每次開同一個標的都重抓一次。
 * 快取接在 `_histFetchJson`（擋在 fetch 前面的一層），呼叫端契約不變 →
 * `_bgLoadGen` 世代守衛／接縫檢查／修剪遮罩全部沒動。
 *
 * ★★ 這支真正要守的是「**快取永遠不可以比網路少**」，不是「有沒有省到流量」。
 *   我第一版就踩了：`from`/`to` 用 `toTime()`（圖表時間 +8 小時）存，卻拿 `Date.parse()`
 *   的 UTC 去比 → 同一個區間網路回 4032 根、快取只回 3457 根，**最舊那端被削掉 8 小時**，
 *   而畫面上完全看不出來（沒有破洞、沒有錯誤，只是歷史少了一截）。
 *   → 判準一定要同時驗**根數**與**最舊那根的時間**，只驗流量會是綠的。
 *
 * 判準：同一個(標的|時框)連載兩次 ——
 *   ① 第二次要真的命中本機（_histHits > 0）
 *   ② 第二次 /api/ohlcv 流量要明顯下降
 *   ③★ K 棒根數不可以變少
 *   ④★ 最舊那根的時間不可以變晚（回溯深度不可以縮水）
 *   ⑤ 不可以生出破洞（window._dataHoles）
 * ⚠ 要用**同一個瀏覽器情境**連跑兩次（IndexedDB 才會留著）；不可用 --incognito 開兩個。
 * ⚠ 回傳碼 2＝進不了場／切不到 5m／第一次就沒觸發補載（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(page, cdp, label) {
  const R = new Map();
  const onReq = e => { if (e.request.url.includes("/api/ohlcv")) R.set(e.requestId, { b: 0 }); };
  const onFin = e => { const r = R.get(e.requestId); if (r) r.b = e.encodedDataLength; };
  cdp.on("Network.requestWillBeSent", onReq);
  cdp.on("Network.loadingFinished", onFin);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 80000 });
  await page.evaluate(() => { sessionStorage.setItem("landingDismissedAt", String(Date.now()));
    if (window._landingEnter) window._landingEnter(); });
  await page.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 80000 });
  const ok = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".tf-btn")].find(x => x.textContent.trim() === "5m");
    if (b) { b.click(); return true; } return false;
  });
  if (!ok) return null;
  await sleep(25000);                       // 讓往回補載跑完
  const st = await page.evaluate(() => ({
    bars: ohlcvData.length,
    first: ohlcvData[0] && ohlcvData[0].time,
    hits: window._histHits || 0, miss: window._histMiss || 0,
    holes: (window._dataHoles || []).length,
  }));
  cdp.off("Network.requestWillBeSent", onReq); cdp.off("Network.loadingFinished", onFin);
  st.kb = [...R.values()].reduce((s, r) => s + r.b, 0) / 1024;
  console.log(`${label}：K棒 ${st.bars} 根　最舊 ${st.first}　/api/ohlcv ${st.kb.toFixed(1)} KB`
            + `　本機命中 ${st.hits} / 打網路 ${st.miss}　破洞 ${st.holes}`);
  return st;
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--window-size=1440,900"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errs = []; page.on("pageerror", e => errs.push(String(e).slice(0, 140)));
    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 80000 });
    await page.evaluate(() => { try { indexedDB.deleteDatabase("ahh_hist"); } catch (e) {} });
    const a = await run(page, cdp, "第一次（空快取）");
    if (!a) { console.error("⚠ 測試不成立：切不到 5m"); await browser.close(); process.exit(2); }
    if (a.miss < 1) {
      console.error("⚠ 測試不成立：第一次就沒觸發往回補載（沒東西可快取）");
      await browser.close(); process.exit(2);
    }
    const b2 = await run(page, cdp, "第二次（有快取）");
    await browser.close(); browser = null;

    const bad = [];
    if (b2.hits < 1) bad.push(`① 第二次沒命中本機（_histHits=${b2.hits}）→ 快取等於沒作用`);
    if (!(b2.kb < a.kb * 0.8)) bad.push(`② 流量沒降：${a.kb.toFixed(1)} → ${b2.kb.toFixed(1)} KB`);
    if (b2.bars < a.bars) bad.push(`③★ K 棒變少了：${a.bars} → ${b2.bars} 根（快取比網路給得少）`);
    const ta = Date.parse(a.first + "Z"), tb = Date.parse(b2.first + "Z");
    if (Number.isFinite(ta) && Number.isFinite(tb) && tb > ta)
      bad.push(`④★ 回溯深度縮水：最舊那根從 ${a.first} 變成 ${b2.first}`
             + `（差 ${((tb - ta) / 3600000).toFixed(1)} 小時 —— 時間基準混用的典型症狀）`);
    if (b2.holes > a.holes) bad.push(`⑤ 多出破洞：${a.holes} → ${b2.holes}`);
    if (errs.length) bad.push("JS 錯誤：" + errs.join(" / "));

    console.log(`\n流量 ${a.kb.toFixed(1)} → ${b2.kb.toFixed(1)} KB`
              + `（省 ${(a.kb - b2.kb).toFixed(1)} KB, ${((a.kb - b2.kb) / a.kb * 100).toFixed(0)}%）`);
    if (bad.length) { console.error("\n✗ 失敗：\n  " + bad.join("\n  ")); process.exit(1); }
    console.log("✓ 命中本機、流量下降，且 K 棒根數與回溯深度都沒有縮水");
  } catch (e) {
    if (browser) await browser.close();
    console.error("⚠ 測試不成立：" + (e && e.message || e)); process.exit(2);
  }
})();
