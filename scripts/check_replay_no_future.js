#!/usr/bin/env node
/**
 * 守門員：重播模式中，圖上絕不可以出現「未來」的 K 棒。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_replay_no_future.js [BASE_URL]
 *
 * 為什麼需要這支
 *   這是**回測工具最嚴重的一種錯誤**：重播時如果看得到游標之後的 K 棒，
 *   你做的每一個判斷都是作弊，而回測結論會全部無效 —— 而且畫面上完全看不出來
 *   （K 棒就是 K 棒，不會有任何提示說「這根其實還沒發生」）。
 *
 *   CLAUDE.md 把它列為鐵則：「replay 中任何改圖表的操作（含 `_bgScheduleIndicators`／
 *   `_bgLoadOlderBars`）必須先檢查 `replayActive`」。那條規則靠人記，一直沒有測試守著 ——
 *   而會破壞它的路徑有好幾條、都是**非同步**的：
 *     ・即時更新輪詢（`/api/latest` 每秒一次，會 push 新棒）
 *     ・背景補載（拖曳/縮放觸發，會整段 setData）
 *     ・重播「之前」發出、重播「之後」才回來的 in-flight 請求
 *   所以判準必須**在做了那些動作之後**才驗，不能只驗剛進重播那一刻。
 *
 * 判準（★一定要問**圖表**，不是問資料陣列）
 *   令 cut = replayData[replayIdx] 的時間（游標所在那根）。
 *   `candleSeries.data()`（LWC 回傳「實際畫在圖上」的序列）裡不可以有 time > cut 的棒，
 *   而且序列最後一根的收盤必須等於游標那根的收盤。
 *   ⚠ **不可以拿 `ohlcvData` 當判準**（我第一版就是，結果報出 5488 根假的「未來棒」）：
 *     `enterReplay()` 是把 ohlcvData **複製**成 replayData，再把前 N 根畫上去 ——
 *     `ohlcvData` 本來就還留著完整資料，它是**來源**不是**畫面**。
 *     而且重播期間背景補載還會繼續往 ohlcvData 加舊棒（實測 1150 → 2533 根），
 *     拿它當判準只會一直誤報。
 *   分四個時點檢查：剛進重播／前進數十根之後／拖曳 6 秒之後／再等一輪即時輪詢之後。
 *   最後驗離開重播能回到完整資料（否則使用者會以為資料掉了）。
 *
 * 回傳碼：0 沒洩漏 / 1 洩漏了未來 K 棒 / 2 測試不成立（服務沒起來、進不了場、沒有重播 UI）
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fails = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--window-size=1440,900"],
    });
  } catch (e) {
    console.log(`✗ 開不了瀏覽器（${e.message.slice(0, 60)}）→ 測試不成立`);
    return 2;
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on("pageerror", e => errs.push(String(e).slice(0, 140)));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.evaluate(() => sessionStorage.setItem("landingDismissedAt", String(Date.now())));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    // ⚠ headless 進場唯一正解＝window._landingEnter()
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 300, { timeout: 45000 });
    await sleep(4000);
    await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  // ⚠ 用 1m：它同時有「即時輪詢」和「背景補載」，正是會踩破 replayActive 的那兩條路。
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".tf-btn")].find(b => b.dataset && b.dataset.tf === "1m");
    if (el) el.click();
  });
  await sleep(9000);

  const entered = await page.evaluate(() => {
    if (typeof enterReplay !== "function") return null;
    enterReplay();
    return { active: replayActive, idx: replayIdx, total: replayData.length };
  });
  if (!entered || !entered.active) {
    console.log("✗ 進不了重播模式（沒有 enterReplay 或沒生效）→ 測試不成立");
    await browser.close();
    return 2;
  }
  console.log(`   進入重播：游標在第 ${entered.idx} 根 / 共 ${entered.total} 根`);

  const probe = () => page.evaluate(() => {
    const cut = toTime(replayData[replayIdx].time);
    const d = candleSeries.data();                     // ★ 實際畫在圖上的序列
    const _t = x => (typeof x.time === "number" ? x.time : toTime(x.time));
    const future = d.filter(x => _t(x) > cut);
    return {
      idx: replayIdx, active: replayActive,
      cutISO: new Date(cut * 1000).toISOString().slice(0, 16),
      n: d.length, futureN: future.length,
      firstFuture: future.length ? new Date(_t(future[0]) * 1000).toISOString().slice(0, 16) : null,
      cutClose: +replayData[replayIdx].close,
      shownClose: d.length ? +d[d.length - 1].close : null,
    };
  });
  const check = (label, s) => {
    const okFuture = s.futureN === 0;
    const okPrice = s.shownClose === s.cutClose;
    console.log(`   ${okFuture && okPrice ? "✓" : "✗"} ${label.padEnd(22)} 游標 ${s.cutISO}　`
      + `未來棒 ${s.futureN} 根` + (s.firstFuture ? `（最早 ${s.firstFuture}）` : "")
      + `　圖上 ${s.n} 根、收盤 ${s.shownClose}（游標那根 ${s.cutClose}）`);
    if (!okFuture) fails.push(`${label}：圖上有 ${s.futureN} 根未來 K 棒（最早 ${s.firstFuture}）`);
    else if (!okPrice) fails.push(`${label}：圖上顯示的收盤 ${s.shownClose} 不是游標那根的 ${s.cutClose}`);
  };

  check("剛進重播", await probe());

  // ① 前進數十根（走真正的按鈕，不要自己動 replayIdx —— 那會繞過所有防護，等於沒測）
  await page.evaluate(() => {
    const btn = document.getElementById("replayStepF");
    for (let i = 0; i < 40 && btn; i++) btn.click();
  });
  await sleep(2500);
  check("前進 40 根後", await probe());

  // ② 真的拖曳（會觸發背景補載與指標排程）
  const r = await page.evaluate(() => {
    const b = document.getElementById("mainChart").getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  await page.mouse.move(r.x + r.w * 0.6, r.y + r.h / 2);
  await page.mouse.down();
  for (let i = 0; i < 12; i++) { await page.mouse.move(r.x + r.w * 0.6 + i * 25, r.y + r.h / 2); await sleep(30); }
  await page.mouse.up();
  await sleep(7000);
  check("往舊拖曳 7 秒後", await probe());

  // ③ 縮到很小（觸發補載）＋ 等超過一輪即時輪詢
  await page.evaluate(() => {
    const ts = mainChart.timeScale(); const v = ts.getVisibleLogicalRange();
    if (v) ts.setVisibleLogicalRange({ from: v.from - 500, to: v.to });
  });
  await sleep(10000);
  check("縮小＋等 10 秒輪詢", await probe());

  // ④ 離開重播 → 圖上要回到「比重播時多」（游標之後那段要長回來），且旗標關掉
  const inReplayN = (await probe()).n;
  await page.evaluate(() => exitReplay());
  await sleep(5000);
  const after = await page.evaluate(() => ({ active: replayActive, n: candleSeries.data().length }));
  const okExit = !after.active && after.n > inReplayN;
  console.log(`   ${okExit ? "✓" : "✗"} 離開重播　　　　　　  replayActive=${after.active}　圖上 ${after.n} 根（重播中 ${inReplayN} 根）`);
  if (!okExit) fails.push(`離開重播後 replayActive=${after.active}、圖上 ${after.n} 根（應 >${inReplayN}）`);

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 重播洩漏了未來（畫面上看不出來，但回測結論會全部無效）：");
    fails.forEach(f => console.log(`   ${f}`));
    return 1;
  }
  console.log("★ 重播全程沒有未來 K 棒，離開後資料完整");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
