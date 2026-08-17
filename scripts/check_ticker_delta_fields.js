#!/usr/bin/env node
/**
 * 守門員：報價列跑了上百輪「欄位級差量」之後，前端手上的清單必須仍等於整包。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_ticker_delta_fields.js [BASE_URL]
 *
 * 為什麼需要這支
 *   報價輪詢是全站最高頻的請求（crypto 每秒一輪／人）。2026-08-17 把差量從「這個標的變了就
 *   整列重送」細到「只送真的變了的**欄位**」（實測 −55%）—— 代價是前端的合併從「覆蓋」變成
 *   「合併」，而這條路上的每一種錯法**都不會報錯**，只會讓畫面上的數字悄悄不對：
 *     ・合併寫成覆蓋 → 沒送來的欄位整個消失。`symbol`／`open` 一整天不變＝永遠不會再送 →
 *       清單瞬間變空殼（排序、標題、跳轉全壞）。
 *     ・後端漏記某個欄位的變動 → 那個欄位**永遠停在第一次載入的值**，最多要等 60 輪的
 *       整包自癒才會被蓋回來。
 *     ・推導欄位（change_amt／spot）沒跟著來源欄位作廢 → 漲跌額停在舊值。
 *   一般冒煙測試碰不到：它只跑幾秒、而且只看「有沒有資料」。
 *
 * 判準（★拿「同一刻的整包」當真值，逐欄位比對）
 *   ・**慢變欄位**（symbol／display／open／volume）必須**完全相同** —— 它們正是「不再送就會
 *     悄悄變舊」的那些，也是這次改動風險最集中的地方。
 *   ・**每秒在跳的**（price／change_pct）只驗「存在且是數字」：兩次抓取之間本來就會動，
 *     要求相等會變成叫狼來了。
 *   ・筆數必須一致，且沒有任何一列缺欄位（缺欄位＝合併把它洗掉了）。
 *   ⚠ 要先跑滿 **> 60 輪**：整包自癒是每 60 輪一次，跑不到就會被自癒蓋掉、什麼都測不到。
 *
 * 回傳碼：0 差量累積後仍與整包一致 / 1 有欄位走鐘 / 2 測試不成立
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROUNDS_SEC = 95;                      // crypto 1 輪/秒 → 95 輪，跨過 60 輪的整包自癒
const SLOW = ["symbol", "display", "open", "volume"];
const FAST = ["price", "change_pct"];
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
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof _tickerData !== "undefined" && _tickerData.length > 50, { timeout: 45000 });
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  const n0 = await page.evaluate("_tickerData.length");
  console.log(`   進場：${n0} 檔。開始跑 ${ROUNDS_SEC} 秒的每秒輪詢（跨過 60 輪的整包自癒）…`);
  await sleep(ROUNDS_SEC * 1000);

  /* 前端手上的清單 vs 同一刻的整包。★ 整包必須在**頁面裡**抓（同一個網路路徑、同一刻），
     從腳本外面另開連線抓會多出好幾百毫秒的時差，快變欄位的差異會被放大成假警報。 */
  const r = await page.evaluate(`(async () => {
    const mine = JSON.parse(JSON.stringify(_tickerData));
    const j = await (await fetch("/api/tickers?market=futures")).json();
    return { mine, full: j.tickers || [], delta: !!j.delta };
  })()`);
  if (r.delta || !r.full.length) {
    console.log("✗ 對照用的整包沒拿到（回的是差量或空）→ 測試不成立");
    await browser.close();
    return 2;
  }

  const mine = new Map(r.mine.map(t => [t.display || t.symbol, t]));
  const full = new Map(r.full.map(t => [t.display || t.symbol, t]));
  console.log(`   前端 ${mine.size} 檔　整包 ${full.size} 檔`);
  if (mine.size !== full.size) fails.push(`筆數不一致：前端 ${mine.size} vs 整包 ${full.size}`);

  const bad = {};       // 欄位 → 筆數
  const sample = {};
  let missing = 0, compared = 0;
  for (const [k, f] of full) {
    const m = mine.get(k);
    if (!m) { missing++; continue; }
    for (const key of SLOW) {
      if (f[key] === undefined) continue;          // 整包本來就沒有這欄 → 不比
      compared++;
      if (m[key] !== f[key]) {
        bad[key] = (bad[key] || 0) + 1;
        if (!sample[key]) sample[key] = `${k}: 前端 ${JSON.stringify(m[key])} vs 整包 ${JSON.stringify(f[key])}`;
      }
    }
    for (const key of FAST) {
      if (f[key] === undefined) continue;
      compared++;
      if (typeof m[key] !== "number" || !Number.isFinite(m[key])) {
        bad[key] = (bad[key] || 0) + 1;
        if (!sample[key]) sample[key] = `${k}: 前端 ${JSON.stringify(m[key])}（不是數字）`;
      }
    }
  }
  if (compared < 1000) {
    console.log(`✗ 只比對到 ${compared} 個欄位（預期上千）→ 沒測到東西，測試不成立`);
    await browser.close();
    return 2;
  }
  console.log(`   逐欄位比對 ${compared} 項（慢變欄位要完全相同、每秒在跳的只驗是數字）`);
  if (missing) fails.push(`${missing} 檔整包有、前端沒有`);
  for (const [key, n] of Object.entries(bad)) {
    console.log(`   ✗ ${key}：${n} 檔不符　例：${sample[key]}`);
    fails.push(`${key} 有 ${n} 檔與整包不符（${sample[key]}）`);
  }
  if (!Object.keys(bad).length && !missing) console.log("   ✓ 每一檔的每一個欄位都與整包一致");

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 欄位級差量把資料弄丟了（畫面上照樣有數字，只是不對）：");
    fails.forEach(f => console.log(`   ${f}`));
    console.log("   兩端逐一檢查：live_data.py `_track`／`get_delta`（有沒有記錄/送出該欄位的變動）、");
    console.log("   ticker.js `_tkMerge` 的 delta 分支（必須是合併 `{...old, ...t}`，不是覆蓋）。");
    return 1;
  }
  console.log("★ 跑滿差量之後，前端手上的清單仍與整包完全一致");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
