#!/usr/bin/env node
/**
 * 守門員：十字線的鉛直線在「沒有 K 棒的空白區」也要在、也要跟著游標動。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_crosshair_blank.js [BASE_URL]
 *
 * 為什麼需要這支
 *   鉛直線不是 LWC 原生的（原生的已被 `crosshair.vertLine.visible=false` 關掉），
 *   是 charts.js 自己用 `.pane-vline` 這四個 DOM 畫的，靠 `subscribeCrosshairMove` 的
 *   `param.time` 定位。**空白區沒有對應時間** → `param.time` 是 undefined →
 *   舊碼直接走「隱藏」分支，四條線一起不見，但橫線與右側價格標籤還在
 *   ＝ 使用者看到的「十字線只剩一半」（2026-08-13 回報：「鼠標的虛線對齊十字到沒 K 棒處就消失了」）。
 *
 *   ⚠ 空白區有**兩邊**，而且兩邊走的程式路徑不同：
 *     ・右側（最後一根之後）＝ rightOffset 留白，一直都有特別處理
 *     ・左側（第一根之前）＝ 大時框（1M/1d/8h）資料少、或縮到最小看見全部時就會出現
 *   只補一邊＝把同一個 bug 留在另一邊，所以這支**兩邊都測**。
 *
 * ★ 一般冒煙測試抓不到：它把游標放在 K 棒上，而這個 bug 只活在 K 棒序列以外。
 *
 * 判準（看畫面，不看程式碼）
 *   ① 左空白 / K棒區 / 右空白：四條 `.pane-vline` 都必須 display ≠ none
 *   ② 線要**跟著游標**：同一空白區內移動 60px，線的 left 必須跟著變（不是卡在邊緣那根）
 *   ③ 游標移出圖表後必須消失（否則就是留下一條擦不掉的線）
 *
 * 回傳碼：0 全對 / 1 空白區十字線壞掉 / 2 測試不成立（服務沒起來、進不了場、造不出空白區）
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
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    // ⚠ headless 進場唯一正解＝window._landingEnter()
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 45000 });
    await sleep(3500);
    await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  const env = await page.evaluate(() => {
    const b = document.getElementById("mainChart").getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });

  // 1M：資料少、無背景補載 → 左邊留得出真正的空白區（1m/5m 會一直補舊棒把空白填掉）
  await page.evaluate(() => {
    const el = [...document.querySelectorAll(".tf-btn")]
      .find(b => (b.dataset && b.dataset.tf === "1M") || b.textContent.trim() === "1M");
    if (el) el.click();
  });
  await sleep(6000);
  await page.evaluate(() => { mainChart.timeScale().setVisibleLogicalRange({ from: -40, to: 60 }); });
  await sleep(800);

  const geo = await page.evaluate(() => {
    const ts = mainChart.timeScale();
    return { x0: ts.logicalToCoordinate(0), xN: ts.logicalToCoordinate(ohlcvData.length - 1),
             plotW: ts.width(), n: ohlcvData.length };
  });
  if (!(geo.x0 > 120)) {
    console.log(`✗ 左邊造不出夠寬的空白區（第一根在 x=${Math.round(geo.x0)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  const read = () => page.evaluate(() => {
    const lns = [...document.querySelectorAll(".pane-vline")];
    return {
      shown: lns.filter(l => getComputedStyle(l).display !== "none").length,
      total: lns.length,
      left: lns.length ? parseFloat(lns[0].style.left) : null,
      vis0: lns.length ? getComputedStyle(lns[0]).display !== "none" : false,
    };
  });
  const moveTo = async cx => { await page.mouse.move(cx, env.y + env.h / 2); await sleep(260); };

  // ── ①＋② 三個區域：線要在，而且在空白區內要跟著游標動 ──
  const zones = [
    { name: "左側空白（第一根之前）", a: env.x + 40, b: env.x + Math.min(geo.x0 - 20, 40 + 60) },
    { name: "K 棒區",              a: env.x + geo.x0 + 30, b: env.x + geo.x0 + 90 },
    { name: "右側空白（最後一根後）", a: env.x + geo.plotW - 70, b: env.x + geo.plotW - 10 },
  ];
  for (const z of zones) {
    await moveTo(z.a); const s1 = await read();
    await moveTo(z.b); const s2 = await read();
    const on = s1.shown === s1.total && s2.shown === s2.total;
    const moved = s1.left != null && s2.left != null && Math.abs(s2.left - s1.left) > 5;
    const ok = on && moved;
    console.log(`   ${ok ? "✓" : "✗"} ${z.name.padEnd(22)} 鉛直線 ${s1.shown}/${s1.total}→${s2.shown}/${s2.total}`
      + `　left ${s1.left}→${s2.left}px`);
    if (!on)    fails.push(`${z.name}：鉛直線消失（${s1.shown}/${s1.total}、${s2.shown}/${s2.total}）`);
    else if (!moved) fails.push(`${z.name}：鉛直線不跟著游標（left 都是 ${s1.left}px＝卡在邊緣那根）`);
  }

  // ── ③ 游標移出圖表 → 線必須消失 ──
  await page.mouse.move(env.x + geo.plotW / 2, env.y + env.h / 2);
  await sleep(200);
  await page.mouse.move(env.x + geo.plotW / 2, 5);       // 移到 topbar
  await sleep(500);
  const off = await read();
  const okOff = off.shown === 0;
  console.log(`   ${okOff ? "✓" : "✗"} 游標移出圖表　　　　　　　鉛直線 ${off.shown}/${off.total}（應 0）`);
  if (!okOff) fails.push(`游標離開圖表後還留著 ${off.shown} 條鉛直線`);

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 空白區的十字線壞了（橫線還在、只有鉛直線不見＝十字線剩一半，不報錯）：");
    fails.forEach(f => console.log(`   ${f}`));
    return 1;
  }
  console.log("★ 左空白／K棒區／右空白 三處鉛直線都在、都跟著游標，離開圖表就收掉");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
