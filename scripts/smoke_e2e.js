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
  // 關公告：點「我知道了」會 markSeen → 不再被 _maybeShow 的重試迴圈(每秒、最多30s)重跳；
  //   只 .remove() DOM 不會 markSeen → 1 秒後又冒出來蓋住互動(2026-07-22 滾輪假失敗即此因)。
  const dismissAnn = () => page.evaluate(() => {
    const b = document.getElementById("_annLater"); if (b) b.click();
    document.getElementById("announceOverlay")?.remove();
  });
  // ★一定要「等到真的點過一次」才算關掉（2026-07-31）：只呼叫一次 dismissAnn 是有race 的 ——
  //   彈窗若晚於這次呼叫才渲染，_annLater 當下不存在 → 沒有 markSeen → _maybeShow 的每秒重試
  //   迴圈(最多30s)之後照樣把它跳出來蓋住圖表，拖曳就打在彈窗上＝假失敗。
  //   （實測今天就這樣掛過一次：主圖中心點的 elementFromPoint 是 DIV.ann-name。）
  //   點到 _annLater 才會 markSeen，之後重試迴圈才會真的停。
  const dismissAnnSure = async (ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const clicked = await page.evaluate(() => {
        const b = document.getElementById("_annLater");
        if (b) { b.click(); return true; }
        return !document.getElementById("announceOverlay") ? null : false;   // null＝本來就沒公告
      });
      if (clicked === true || clicked === null) { await dismissAnn(); return; }
      await new Promise(r => setTimeout(r, 250));
    }
    await dismissAnn();
  };
  await dismissAnnSure();
  console.log("✓ 進場");

  // 2) K 棒 + 勝率標記
  await page.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 60000 }).catch(() => fail("K 棒沒載入"));
  await page.waitForFunction(() => typeof lastFVGMSMarkers !== "undefined" && lastFVGMSMarkers.length > 0, { timeout: 120000 }).catch(() => fail("策略標記沒出現（勝率回應失敗？）"));
  const bars0 = await page.evaluate(() => ohlcvData.length);
  console.log("✓ K棒", bars0, "根 + 策略標記");

  // 3) 真拖曳平移（必驗可視範圍有變，否則測試無效）
  //    公告彈窗可能晚於進場後 1.8s 才渲染（fresh profile 必跳）→ 拖曳前再清一次，
  //    否則互動打在彈窗上＝偶發假失敗（2026-07-16 兩次 flake 皆此因）。
  await dismissAnn();
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
  await dismissAnn();   // 公告重試迴圈可能在拖曳後又跳一次 → 滾輪前再關一次，避免滾輪打在彈窗上
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

  // 6) 資料完整性：K 棒不可有重複 / 亂序 / 破洞
  //    ★為什麼進冒煙(2026-07-30)：版控的 K 線倉庫曾缺 434 根上線,K 棒只是「少一段」不報錯,
  //      一路到深滑 E2E 才被抓到。這裡用「當前已載入的資料」做最低成本的把關。
  //      倉庫檔本身另有 backend/scripts/repair_klines5m.py 全量掃描（動到倉庫後必跑）。
  const integ = await page.evaluate(() => {
    const tfS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400 }[currentTF] || 3600;
    let dup = 0, ooo = 0, holes = 0, maxHole = 0;
    for (let i = 1; i < ohlcvData.length; i++) {
      const a = toTime(ohlcvData[i - 1].time), c = toTime(ohlcvData[i].time);
      if (c === a) dup++;
      else if (c < a) ooo++;
      else { const g = Math.round((c - a) / tfS); if (g > 1) { holes++; if (g > maxHole) maxHole = g; } }
    }
    return { n: ohlcvData.length, dup, ooo, holes, maxHole, tf: currentTF };
  });
  if (integ.dup || integ.ooo || integ.holes)
    fail(`K棒資料不完整（${integ.tf}）：重複 ${integ.dup} / 亂序 ${integ.ooo} / 破洞 ${integ.holes}（最大缺 ${integ.maxHole - 1} 根）`);
  console.log(`✓ 資料完整性（${integ.n} 根：無重複/亂序/破洞）`);

  // 7) 錯誤總結（favicon / 網路類噪音排除）
  const real = errors.filter(e => !e.includes("favicon") && !e.includes("net::") && !e.includes("ERR_"));
  if (real.length) fail("有 JS 錯誤 " + real.length + " 筆");
  console.log("✓ 零 JS 錯誤 — 冒煙通過");
  await browser.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(2); });
