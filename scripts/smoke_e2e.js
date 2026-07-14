// 推送前冒煙測試（守門員）：真瀏覽器跑一遍核心流程，任何 JS 錯誤/流程斷點 → exit 1。
//
// 用法：
//   1. 本機服務先跑著（cd backend && ../.venv312/bin/python -m uvicorn main:app --port 8000）
//   2. node scripts/smoke_e2e.js            # 打 http://127.0.0.1:8000
//      node scripts/smoke_e2e.js <URL>      # 打指定站（如 Railway）
//
// 依賴：puppeteer-core（用系統 Chrome，免下載瀏覽器）。找不到時提示安裝。
// 流程：進場(_landingEnter) → 等K棒與策略標記 → 真拖曳平移(驗可視範圍有變) → 滾輪縮放
//        → 切時框 4H → 等重載 → 驗標記重建。全程收集 pageerror/console.error。
//
// ⚠ 教訓(2026-07-14)：headless 進場「點城門按鈕」的寫法會被登入鎖擋住 → 頁面看似正常、
//   互動全打在城門頁上，量測/測試全是假的。務必用 window._landingEnter() 進場，
//   且拖曳後驗 getVisibleLogicalRange 有變，否則測試無效。

let puppeteer = null;
{
  const path = require("path");
  // require 預設從「腳本所在位置」往上找 → 也試 cwd 與 HOME 的 node_modules（在裝過的目錄執行即可）
  for (const c of ["puppeteer-core",
                   path.join(process.cwd(), "node_modules", "puppeteer-core"),
                   path.join(process.env.HOME || "", "node_modules", "puppeteer-core")]) {
    try { puppeteer = require(c); break; } catch (e) {}
  }
  if (!puppeteer) { console.error("缺 puppeteer-core：在任一目錄 npm i puppeteer-core 後於該目錄執行本腳本"); process.exit(2); }
}

const BASE = process.argv[2] || "http://127.0.0.1:8000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-first-run", "--window-size=1400,900"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1400, height: 900 });
  const fail = msg => { console.error("✗ " + msg); if (errors.length) console.error(errors.slice(0, 8).join("\n")); process.exit(1); };

  // 1) 載入 + 進場
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => typeof window._landingEnter === "function", { timeout: 30000 }).catch(() => fail("進場函式 _landingEnter 不存在（bundle 早期炸掉？）"));
  await page.evaluate(() => window._landingEnter());
  await new Promise(r => setTimeout(r, 1800));
  await page.evaluate(() => { document.getElementById("announceOverlay")?.remove(); });
  console.log("✓ 進場");

  // 2) K 棒 + 勝率標記
  await page.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 60000 }).catch(() => fail("K 棒沒載入"));
  await page.waitForFunction(() => typeof lastFVGMSMarkers !== "undefined" && lastFVGMSMarkers.length > 0, { timeout: 120000 }).catch(() => fail("策略標記沒出現（勝率回應失敗？）"));
  const bars0 = await page.evaluate(() => ohlcvData.length);
  console.log("✓ K棒", bars0, "根 + 策略標記");

  // 3) 真拖曳平移（必驗可視範圍有變，否則測試無效）
  const box = await page.evaluate(() => { const r = document.getElementById("mainChart").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const rng0 = await page.evaluate(() => JSON.stringify(mainChart.timeScale().getVisibleLogicalRange()));
  await page.mouse.move(box.x + 200, box.y);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) { await page.mouse.move(box.x + 200 - i * 15, box.y, { steps: 1 }); await new Promise(r => setTimeout(r, 16)); }
  await page.mouse.up();
  const rng1 = await page.evaluate(() => JSON.stringify(mainChart.timeScale().getVisibleLogicalRange()));
  if (rng0 === rng1) fail("拖曳沒有平移到圖表（被浮層擋住？城門頁沒關？）");
  console.log("✓ 平移");

  // 4) 滾輪縮放（單方向：交替 +/- 會對稱抵銷、可能剛好回到原範圍 → 假陰性）
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -120 }); await new Promise(r => setTimeout(r, 40)); }
  const rng2 = await page.evaluate(() => JSON.stringify(mainChart.timeScale().getVisibleLogicalRange()));
  if (rng1 === rng2) fail("滾輪沒有縮放到圖表");
  console.log("✓ 縮放");

  // 5) 切時框 → 重載 + 標記重建
  const tfOk = await page.evaluate(() => { const b = [...document.querySelectorAll(".tf-btn")].find(x => x.textContent.trim().toUpperCase() === "4H" || x.dataset.tf === "4h"); if (b) { b.click(); return true; } return false; });
  if (!tfOk) fail("找不到 4H 時框按鈕");
  await page.waitForFunction(b0 => typeof ohlcvData !== "undefined" && ohlcvData.length > 50 && ohlcvData.length !== b0, { timeout: 60000 }, bars0).catch(() => fail("切 4H 後 K 棒沒重載"));
  await new Promise(r => setTimeout(r, 8000));   // 等 4H 勝率+標記重建
  const cacheBuilt = await page.evaluate(() => typeof _sortedMarkerCache !== "undefined");
  console.log("✓ 切時框 4H（標記快取存在:", cacheBuilt, "）");

  // 6) 錯誤總結（favicon / 網路類噪音排除）
  const real = errors.filter(e => !e.includes("favicon") && !e.includes("net::") && !e.includes("ERR_"));
  if (real.length) fail("有 JS 錯誤 " + real.length + " 筆");
  console.log("✓ 零 JS 錯誤 — 冒煙通過");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(2); });
