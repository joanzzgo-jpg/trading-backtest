#!/usr/bin/env node
/**
 * 守門員：重新整理之後，圖表要停在**同一個畫面** —— 同樣的縮放、同樣的時間區間。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_view_restore.js [BASE_URL]
 *
 * 為什麼需要這支
 *   使用者（2026-08-16）：「需要記憶上次看的畫面是什麼，包含大小跟時區，就是重整後要一樣」。
 *   當時實測：捲回 7/20 看盤 → 重整 → 跳回 8/14（最新）。對回測工具來說這是每天都在踩的
 *   摩擦 —— 而且**完全不報錯**，只是「我剛剛那頁不見了」。
 *
 *   這條路上有三個各自獨立、都會靜默失效的環節，缺一個畫面就回不去：
 *     ① 存：只存了 barSpacing + 「距最新棒幾根」→ 只描述得了「貼在最新」的畫面。
 *     ② 讀：`_applyUrlState()` 只要網址有 s/tf/m 就把本機視角丟掉。但 `_syncUrlState()`
 *          每次切標的/時框都會 replaceState 把 s/tf/m 寫進**自己的**網址 → 這個條件
 *          重整時**永遠成立** → 連縮放還原都等於從來沒生效過。
 *     ③ 還原後守住：`_placeAtAnchor` 用**邏輯索引**只設一次，之後背景補載往 ohlcvData
 *          塞進幾千根舊棒（實測 420 → 14,040 根），同一個索引指到的時間就整個位移 ——
 *          還原到 2026-07-22 的畫面，幾秒後自己跑到 2025-09-01（差 11 個月）。
 *
 * 判準（★一定要比**時間**，不可以比 logical index）
 *   logical index 會隨背景補載整段位移，時間才是使用者眼睛看到的東西。
 *   ・可見範圍右緣的時間（`getVisibleRange().to`）重整前後必須一模一樣
 *   ・可見根數（＝縮放）差不可超過 1 根
 *   ・★ 還原後要連續盯 20 秒：③ 那種漂移是**重整後好幾秒**才發生的，
 *     只驗「剛還原那一刻」會是綠的（我第一版就是）。
 *   兩個情境都要測：看最新時重整（不可以反而被釘在過去）／捲在歷史時重整。
 *
 * 回傳碼：0 兩個情境都還原 / 1 沒還原 / 2 測試不成立
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TF = "1h";
const BACK = 600;                 // 往舊捲幾根（1h × 600 ≈ 25 天，夠遠到一眼看得出跳掉）
const fails = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const snap = page => page.evaluate(`(() => {
  const ts = mainChart.timeScale(), vr = ts.getVisibleRange(), lr = ts.getVisibleLogicalRange();
  const iso = t => (t == null ? null : new Date(t * 1000).toISOString().slice(0, 16));
  return {
    from: iso(vr && vr.from), to: iso(vr && vr.to),
    bars: lr ? Math.round(lr.to - lr.from) : null,
    bs: +ts.options().barSpacing.toFixed(2),
    n: candleSeries.data().length, src: ohlcvData.length,
    last: ohlcvData.length ? iso(toTime(ohlcvData[ohlcvData.length - 1].time)) : null,
  };
})()`);

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

  // ⚠ headless 進場唯一正解＝window._landingEnter()
  const enter = async () => {
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 45000 });
  };

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.evaluate(() => sessionStorage.setItem("landingDismissedAt", String(Date.now())));
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await enter();
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }
  await page.evaluate(tf => {
    const el = [...document.querySelectorAll(".tf-btn")].find(b => b.dataset && b.dataset.tf === tf);
    if (el) el.click();
  }, TF);
  await sleep(12000);

  // ── ① 看最新時重整：縮放要一樣，而且**不可以**反而被釘在過去 ──
  await page.evaluate(() => mainChart.timeScale().applyOptions({ barSpacing: 22 }));
  await sleep(2500);
  const a1 = await snap(page);
  await page.evaluate(() => saveLastSymbol());
  await sleep(800);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 70000 });
  await enter();
  await sleep(13000);
  const a2 = await snap(page);
  const aBars = Math.abs(a1.bars - a2.bars) <= 1;
  const aLatest = a2.to === a2.last;                       // 看最新 → 重整後仍要貼著最新那根
  console.log(`   ① 看最新時重整`);
  console.log(`      前 ${a1.to}（${a1.bars} 根, bs=${a1.bs}）　後 ${a2.to}（${a2.bars} 根, bs=${a2.bs}）`);
  console.log(`      ${aBars ? "✓" : "✗"} 縮放一致　${aLatest ? "✓" : "✗"} 仍貼著最新（最新棒 ${a2.last}）`);
  if (!aBars)   fails.push(`看最新重整：可見根數 ${a1.bars} → ${a2.bars}（縮放沒還原）`);
  if (!aLatest) fails.push(`看最新重整：右緣停在 ${a2.to}、最新棒卻是 ${a2.last}（被釘在過去）`);

  // ── ② 捲在歷史時重整 ──
  const moved = await page.evaluate(back => {
    const ts = mainChart.timeScale(), v = ts.getVisibleLogicalRange();
    if (!v || v.from - back < 0) return false;
    ts.setVisibleLogicalRange({ from: v.from - back, to: v.to - back });
    return true;
  }, BACK);
  if (!moved) {
    console.log(`✗ 捲不到 ${BACK} 根之前（資料不夠）→ 測試不成立`);
    await browser.close();
    return 2;
  }
  await sleep(6000);
  const b1 = await snap(page);
  if (b1.to === b1.last) {
    console.log(`✗ 捲完右緣還在最新（${b1.to}）→ 測不到「捲在歷史」這個情境，測試不成立`);
    await browser.close();
    return 2;
  }
  await page.evaluate(() => saveLastSymbol());
  await sleep(800);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 70000 });
  await enter();

  /* ★ 連續盯 20 秒：漂移是「重整後好幾秒、背景補載把幾千根舊棒塞進來」才發生的，
     只驗剛還原那一刻會是綠的。同時記錄圖上根數，證明這段期間資料真的長大了
     ——沒長大就代表這次沒觸發到會漂移的那條路，判定不算數。 */
  console.log(`   ② 捲到 ${b1.to} 後重整（往舊 ${BACK} 根）`);
  /* n0＝「進場那一刻」的根數，不是第一次取樣的：本機後端快取是熱的，2.5 秒後補載早就做完了，
     等到第一次取樣才取基準會量到 0 成長。 */
  let worst = null, grew = false;
  const n0 = (await snap(page)).n;
  for (let i = 1; i <= 8; i++) {
    await sleep(2500);
    const s = await snap(page);
    /* ⚠ 成長要跟「重整後」的起點比，不是跟重整前比：重整後是先拿錨點附近的有界視窗
       （數百根）再往兩側補回去，永遠補不「超過」重整前那個數字 —— 拿重整前當基準
       會永遠判定成「沒長大」＝這支永遠不成立（我第一版就是）。 */
    if (s.n > n0) grew = true;
    if (s.to !== b1.to && !worst) worst = s;
    if (i === 8 || (worst && i >= 4)) {
      console.log(`      +${(i * 2.5).toFixed(0).padStart(2)}s  右緣 ${s.to}　${s.bars} 根　圖上 ${s.n} 根`);
    }
  }
  const bFin = await snap(page);
  const bSame = bFin.to === b1.to;
  const bBars = Math.abs(b1.bars - bFin.bars) <= 1;
  console.log(`      前 ${b1.to}（${b1.bars} 根, 圖上 ${b1.n}）　後 ${bFin.to}（${bFin.bars} 根, 圖上 ${bFin.n}）`);
  console.log(`      ${bSame ? "✓" : "✗"} 時間區間一致　${bBars ? "✓" : "✗"} 縮放一致`
    + `　${grew ? "✓ 期間背景補載真的有塞新資料進來（漂移那條路有被走到）" : "⚠ 期間資料沒長大"}`);
  if (!bSame) fails.push(`捲歷史重整：右緣 ${b1.to} → ${bFin.to}`
    + (worst ? `（重整後第 ${Math.round((worst ? 1 : 0))} 次取樣就跑掉了）` : ""));
  if (!bBars) fails.push(`捲歷史重整：可見根數 ${b1.bars} → ${bFin.bars}`);

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (!grew && bSame) {
    console.log("✗ 重整後背景補載沒有塞任何新資料進來 → 最會出事的那條路沒被走到，測試不成立");
    return 2;
  }
  if (fails.length) {
    console.log("★ 重整後的畫面跟重整前不一樣（不報錯，只是「我剛剛那頁不見了」）：");
    fails.forEach(f => console.log(`   ${f}`));
    console.log("   三個環節逐一檢查：utils.js saveLastSymbol 的 anchorT（存）／");
    console.log("   loadLastSymbol 的網址判斷（讀）／render.js _holdAnchorByTime（還原後守住）。");
    return 1;
  }
  console.log("★ 兩個情境重整後都回到同一個畫面（縮放與時間區間都一致）");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
