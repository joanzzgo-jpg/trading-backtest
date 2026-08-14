#!/usr/bin/env node
/**
 * 守門員：繪圖圖層 A/B/C —— 隱藏一層不可以弄丟資料，也不可以還能被摸到。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_draw_layers.js [BASE_URL]
 *
 * 為什麼需要這支
 *   繪圖是**使用者自己畫的資料**，弄丟了救不回來（2026-08-12 我就用測試腳本
 *   把使用者本機 118 個 BTC 繪圖清掉過，見 memory feedback_never-use-real-account-in-tests）。
 *   圖層是 2026-08-11 才加的，而它動到的正好是「哪些繪圖要存進 localStorage」與
 *   「哪些繪圖可以被點到」這兩條路徑 —— 兩邊都是靜默失敗：
 *     ・存檔時把隱藏層濾掉 → 重新整理後那層**永遠消失**，沒有任何提示
 *     ・命中判定沒濾掉隱藏層 → 使用者會拖到／刪到**看不見的線**（memory 記過這條）
 *
 * ★★ 一律用假帳號名（`__gk_draw_test__`）。設成真實帳號名的話，account.js 會把整包
 *    localStorage 快照同步進後端 → 測試就會寫壞真實資料。假名字查無帳號 → /api/account/sync
 *    回 404、什麼都不寫（本測試預期會看到那個 404，那是正確行為）。
 *
 * 判準
 *   ① 隱藏某層後：記憶體裡的繪圖數不變，**且 localStorage 存的也不變**
 *   ② 重新整理後：隱藏狀態記得住，三層的繪圖都還在
 *   ③ 用與滑鼠同一條命中判定（findNearest）去戳每一層線的中點：
 *      顯示中的層要命中自己、**隱藏的層必須沒命中**
 *
 * 回傳碼：0 全對 / 1 圖層壞了 / 2 測試不成立（服務沒起來、進不了場）
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAKE_ACCT = "__gk_draw_test__";
const HIDE = "B";
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

  const enter = async () => {
    await page.evaluate(n => {
      localStorage.setItem("acctName", n);                       // ★ 假帳號，見檔頭
      sessionStorage.setItem("landingDismissedAt", String(Date.now()));
    }, FAKE_ACCT);
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    // ⚠ headless 進場唯一正解＝window._landingEnter()
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 45000 });
    await sleep(4000);
    // draw.js 是延遲載入的 → 一定要等它的公開介面出現，不能只等 K 棒
    await page.waitForFunction(() => typeof window._drawLayerState === "function", { timeout: 20000 });
    await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
  };

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await enter();
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  // 乾淨起點：三層各一條斜線，端點用**真的存在的 K 棒時間**
  // ⚠ LWC 的 timeToCoordinate 對「不是某根 K 棒的時間」回 null（我第一版用 t±7200 秒，
  //   在日線上不落在任何一根上 → 三層座標全算不出來、③ 整段等於沒測到）。
  const built = await page.evaluate(() => {
    localStorage.removeItem("drawLayerState");
    drawings.length = 0;
    const i = Math.floor(ohlcvData.length / 2);
    const t1 = toTime(ohlcvData[i - 30].time), t2 = toTime(ohlcvData[i + 30].time);
    const px = +ohlcvData[i].close;
    ["A", "B", "C"].forEach((L, k) => {
      window._setDrawLayer(L);
      _pushDraw({ id: _did(), type: "trend",
                  p1: { time: t1, price: px * (1 + k * 0.02) },
                  p2: { time: t2, price: px * (1 + k * 0.02) },
                  color: "#ff8800", width: 2 });
    });
    saveDrawings();
    mainChart.timeScale().setVisibleLogicalRange({ from: i - 60, to: i + 60 });   // 讓線在畫面內
    return drawings.map(d => d.layer);
  });
  await sleep(1200);
  if (String(built) !== "A,B,C") {
    console.log(`✗ 建不出三層測試繪圖（拿到 ${JSON.stringify(built)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  const storedCount = () => page.evaluate(() => {
    const key = `${document.getElementById("marketSelect").value}:`
      + `${document.getElementById("exchangeSelect").value}:`
      + `${document.getElementById("symbolInput").value}`.toUpperCase();
    const st = JSON.parse(localStorage.getItem("tv_drawings_v2") || "{}");
    return (st[key.toUpperCase()] || []).length;
  });

  // ── ① 隱藏一層：記憶體與存檔的數量都不可以變 ──
  const before = { mem: 3, disk: await storedCount() };
  const r1 = await page.evaluate(L => {
    const vis = window._toggleDrawLayer(L);
    saveDrawings();
    return { vis, state: window._drawLayerState(), mem: drawings.length };
  }, HIDE);
  const disk1 = await storedCount();
  const ok1 = r1.vis === false && r1.mem === 3 && disk1 === before.disk && disk1 === 3;
  console.log(`   ${ok1 ? "✓" : "✗"} 隱藏 ${HIDE} 層　可見=${r1.vis}　記憶體 ${r1.mem} 個　存檔 ${before.disk}→${disk1} 個（都應維持 3）`);
  if (!ok1) fails.push(`隱藏 ${HIDE} 層後資料變了：記憶體 ${r1.mem}、存檔 ${disk1}（應都是 3）→ 重新整理後那層會消失`);

  // ── ③ 命中判定：顯示中的要命中自己，隱藏的必須摸不到 ──
  const hit = await page.evaluate(() => {
    const ts = mainChart.timeScale();
    const out = {};
    for (const L of ["A", "B", "C"]) {
      const d = drawings.find(z => z.layer === L);
      const x1 = ts.timeToCoordinate(d.p1.time), x2 = ts.timeToCoordinate(d.p2.time);
      const y1 = candleSeries.priceToCoordinate(d.p1.price), y2 = candleSeries.priceToCoordinate(d.p2.price);
      if (x1 == null || x2 == null || y1 == null || y2 == null) { out[L] = { err: "座標算不出來" }; continue; }
      const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
      _findNearestCache.x = -1e9;                 // 清掉 4px 短距快取，避免重用上一次的結果
      const near = findNearest(x, y, 12);
      out[L] = { x: Math.round(x), y: Math.round(y), id: d.id,
                 hitId: near && near.id, hitLayer: near && near.layer };
    }
    return out;
  });
  for (const L of ["A", "B", "C"]) {
    const h = hit[L];
    if (h.err) { console.log(`   ✗ ${L} 層 ${h.err}`); fails.push(`${L} 層座標算不出來 → ③ 沒測到`); continue; }
    const self = h.hitId === h.id, want = L !== HIDE;
    const ok = self === want;
    console.log(`   ${ok ? "✓" : "✗"} ${L} 層命中判定 @(${h.x},${h.y}) → `
      + (self ? "命中自己" : h.hitId ? `命中 ${h.hitLayer} 層` : "沒命中")
      + (L === HIDE ? "（已隱藏，應摸不到）" : ""));
    if (!ok) {
      fails.push(L === HIDE
        ? `隱藏的 ${L} 層還是被 findNearest 命中 → 使用者會拖到／刪到看不見的線`
        : `顯示中的 ${L} 層命中不到自己 → 這層變成不能選取`);
    }
  }

  // ── ② 重新整理：隱藏狀態要記住、三層資料都要在 ──
  await enter();
  const after = await page.evaluate(() => ({
    state: window._drawLayerState(), layers: drawings.map(d => d.layer).sort().join(","),
  }));
  const ok2 = after.layers === "A,B,C" && after.state.hidden.join() === HIDE;
  console.log(`   ${ok2 ? "✓" : "✗"} 重新整理後　繪圖 [${after.layers}]（應 A,B,C）　隱藏 ${JSON.stringify(after.state.hidden)}（應 ["${HIDE}"]）`);
  if (after.layers !== "A,B,C") fails.push(`重新整理後只剩 [${after.layers}] → 隱藏層的繪圖被弄丟了`);
  else if (!ok2) fails.push(`重新整理後隱藏狀態沒記住（${JSON.stringify(after.state.hidden)}）`);

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 繪圖圖層壞了（使用者自己畫的資料，弄丟救不回來，而且全程不報錯）：");
    fails.forEach(f => console.log(`   ${f}`));
    return 1;
  }
  console.log("★ 隱藏圖層不會弄丟資料、狀態記得住、看不見的線也摸不到");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
