#!/usr/bin/env node
/**
 * 守門員：連續快速切換時框/標的之後，圖上留下的必須是**最後那一次**的資料。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_switch_race.js [BASE_URL]
 *
 * 為什麼需要這支
 *   使用者連點時框、或在報價列上快速掃過好幾個標的，是**每天都在發生**的操作，
 *   而每一下都會發出一個新的資料請求 → 同時有好幾個請求在飛。誰先回來不一定。
 *   如果防護（render.js 的 `_loadDataCtrl` / `_bgLoadGen` 世代比對）失效，
 *   慢的那個舊請求會後到並蓋掉畫面 → **圖上是別的時框/別的標的的資料**，
 *   而按鈕高亮、輸入框顯示的都還是你最後點的那個 —— 沒有任何錯誤訊息。
 *   這個專案已經因為「切標的回來沿用舊標的標記」修過一次（ca8ec0f）。
 *
 *   ★ 一般冒煙測試抓不到：它只切**一次**時框、而且等它載完才驗，
 *     競態只存在於「上一次還沒回來就切下一次」的那個窗口裡。
 *
 * ★ 為什麼要**人工延遲第一個請求**（2026-08-12 補）
 *   第一版只是快速連點就驗最終狀態 —— 但本機回應太快（60~100ms），舊請求根本來不及
 *   變成「後到」，**把 AbortController 防護整個拆掉、測試照樣通過**＝叫不出狼的守門員。
 *   → 改成攔截 /api/ohlcv，把**第一個**請求延後 4 秒才送出：
 *     沒有防護時它會最後才回來、蓋掉正確的資料；有防護時它早就被 abort、永遠不會落地。
 *   這才是這支唯一真正抓得到東西的地方。
 *
 * 判準（比**內容**，不比狀態）
 *   ・時框：K 棒時間間隔的**中位數**必須等於最後點的那個時框
 *     （只看 currentTF 沒有用 —— 那個變數本來就會被立刻設成新值，出事的是資料）。
 *   ・標的：收盤價中位數要落在該標的的合理數量級
 *     （BTC 幾萬 / ETH 幾千 / SOL 幾百 —— 混到別的標的一眼就看得出來，
 *      用數量級而不是精確值，才不會因為行情波動而誤報）。
 *   ・全程零 JS 錯誤。
 *
 * 回傳碼：0 全對 / 1 有殘留舊資料 / 2 測試不成立（服務沒起來、進不了場）
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
// 收盤價的合理數量級（刻意給很寬 —— 只要能分辨「是不是混到別的幣」就夠）
const SYM_RANGE = {
  "BTC/USDT.P": [20000, 200000],
  "ETH/USDT.P": [800, 10000],
  "SOL/USDT.P": [20, 600],
};
const CLICK_GAP_MS = 120;   // 比一次載入快很多 → 保證多個請求同時在飛
const SETTLE_MS = 10000;    // 等所有在飛的請求塵埃落定（含慢的那些）

const fails = [];

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
  page.on("pageerror", e => errs.push(String(e).slice(0, 160)));
  page.on("console", m => { if (m.type() === "error") errs.push("console:" + m.text().slice(0, 140)); });

  try {
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    // ⚠ headless 進場唯一正解＝window._landingEnter()（點城門按鈕會被登入鎖擋）
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 45000 });
  } catch (e) {
    console.log(`✗ 進不了場或沒載到 K 棒（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });

  const medGap = () => page.evaluate(() => {
    const g = [];
    for (let i = 1; i < ohlcvData.length; i++) {
      const d = toTime(ohlcvData[i].time) - toTime(ohlcvData[i - 1].time);
      if (d > 0) g.push(d);
    }
    g.sort((a, b) => a - b);
    return g[Math.floor(g.length / 2)];
  });
  const medClose = () => page.evaluate(() => {
    const c = ohlcvData.map(x => +x.close).filter(x => x > 0).sort((a, b) => a - b);
    return c[Math.floor(c.length / 2)];
  });
  const clickTf = tf => page.evaluate(t => {
    const el = [...document.querySelectorAll(".tf-btn")]
      .find(b => (b.dataset && b.dataset.tf === t) || b.textContent.trim().toLowerCase() === t.toLowerCase());
    if (el) { el.click(); return true; } return false;
  }, tf);
  const setSym = sym => page.evaluate(s => {
    const el = document.getElementById("symbolInput"); if (!el) return false;
    el.value = s; el.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof loadData === "function") loadData();
    return true;
  }, sym);

  // ── ① 快速連點時框 ──
  const tfSeq = ["1m", "5m", "15m", "1h", "4h", "1d", "5m"];
  for (const tf of tfSeq) { await clickTf(tf); await new Promise(r => setTimeout(r, CLICK_GAP_MS)); }
  await new Promise(r => setTimeout(r, SETTLE_MS));
  {
    const gap = await medGap(), want = TF_SEC[tfSeq[tfSeq.length - 1]];
    const ok = gap === want;
    console.log(`   ${ok ? "✓" : "✗"} 連點時框 ${tfSeq.join("→")}　最後資料間隔 ${gap}s（應 ${want}s）`);
    if (!ok) fails.push(`連點時框後圖上是間隔 ${gap}s 的資料，不是最後點的 ${tfSeq[tfSeq.length - 1]}`);
  }

  // ── ①-b 舊請求後到（人工延遲第一個 /api/ohlcv 4 秒）──
  //    這是唯一能真正驗到防護的案例：沒有 abort 的話，慢的舊請求會最後才回來蓋掉畫面。
  {
    let n = 0;
    await page.setRequestInterception(true);
    const onReq = req => {
      if (/\/api\/ohlcv/.test(req.url()) && ++n === 1) {
        setTimeout(() => { try { req.continue(); } catch (e) {} }, 4000);   // 第一個慢 4 秒
      } else {
        try { req.continue(); } catch (e) {}
      }
    };
    page.on("request", onReq);
    await clickTf("1m");                       // ← 這個會慢 4 秒才送出
    await new Promise(r => setTimeout(r, 150));
    await clickTf("1h");                       // ← 這些正常速度，會先回來
    await new Promise(r => setTimeout(r, 150));
    await clickTf("5m");
    await new Promise(r => setTimeout(r, 12000));   // 等慢的那個也回來（4s + 載入）
    page.off("request", onReq);
    await page.setRequestInterception(false);
    const gap = await medGap();
    const ok = gap === TF_SEC["5m"];
    console.log(`   ${ok ? "✓" : "✗"} 舊請求後到（1m 慢 4 秒）　最後資料間隔 ${gap}s（應 300s＝5m）`);
    if (!ok) fails.push(`慢的舊請求(1m)後到時蓋掉了畫面：間隔 ${gap}s，應是最後點的 5m`);
  }

  // ── ② 快速切標的 ──
  const symSeq = ["ETH/USDT.P", "SOL/USDT.P", "BTC/USDT.P", "ETH/USDT.P"];
  for (const s of symSeq) { await setSym(s); await new Promise(r => setTimeout(r, CLICK_GAP_MS)); }
  await new Promise(r => setTimeout(r, SETTLE_MS));
  {
    const med = await medClose();
    const [lo, hi] = SYM_RANGE[symSeq[symSeq.length - 1]];
    const ok = med >= lo && med <= hi;
    console.log(`   ${ok ? "✓" : "✗"} 快速切標的 ${symSeq.join("→")}　收盤中位 ${med}（${symSeq[symSeq.length - 1]} 應 ${lo}~${hi}）`);
    if (!ok) fails.push(`切標的後收盤中位 ${med} 不在 ${symSeq[symSeq.length - 1]} 的量級 → 混到別的標的`);
  }

  // ── ③ 標的與時框交錯（兩道防護同時作用，最容易打架）──
  const mix = [["BTC/USDT.P", "1h"], ["SOL/USDT.P", "15m"], ["ETH/USDT.P", "4h"], ["BTC/USDT.P", "5m"]];
  for (const [s, tf] of mix) {
    await setSym(s); await new Promise(r => setTimeout(r, 60));
    await clickTf(tf); await new Promise(r => setTimeout(r, CLICK_GAP_MS));
  }
  await new Promise(r => setTimeout(r, SETTLE_MS));
  {
    const [wsym, wtf] = mix[mix.length - 1];
    const gap = await medGap(), med = await medClose();
    const [lo, hi] = SYM_RANGE[wsym];
    const okTf = gap === TF_SEC[wtf], okSym = med >= lo && med <= hi;
    console.log(`   ${okTf && okSym ? "✓" : "✗"} 交錯切換　最後 ${wsym} ${wtf}：間隔 ${gap}s（應 ${TF_SEC[wtf]}s）、收盤中位 ${med}（應 ${lo}~${hi}）`);
    if (!okTf) fails.push(`交錯切換後間隔 ${gap}s ≠ ${wtf}`);
    if (!okSym) fails.push(`交錯切換後收盤中位 ${med} 不是 ${wsym}`);
  }

  if (errs.length) {
    console.log(`   ✗ 有 ${errs.length} 個 JS 錯誤：${errs.slice(0, 3).join(" | ")}`);
    fails.push(`${errs.length} 個 JS 錯誤`);
  } else {
    console.log("   ✓ 全程零 JS 錯誤");
  }

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 快速切換後圖上留著舊資料（按鈕/輸入框看起來卻是對的，不會報錯）：");
    fails.forEach(f => console.log(`   ${f}`));
    return 1;
  }
  console.log("★ 三種快速切換後，圖上的資料都屬於最後那一次");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
