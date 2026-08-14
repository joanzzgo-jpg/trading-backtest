#!/usr/bin/env node
/**
 * 守門員：勝率「快取命中」那條路，必須重繪出與「網路成功」那條路**完全一樣的圖層**。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_wr_cache_layers.js [BASE_URL]
 *
 * 為什麼需要這支
 *   `fetchWinRate()` 有兩條路：網路成功、與 `_wrCache` 命中。兩條都要把 FVG/SMC/VWAP/通道…
 *   各層重繪回來。**少寫一層，那一層就會留著「上一個標的」的資料** —— 圖上照樣有標記、
 *   不會報錯，只是位置全錯（使用者：切 BTC→SOL→BTC 回來，主圖的多/空標記還是 SOL 的）。
 *   本專案已經因為這件事修過兩次（02b429a 補載完成後漏重繪、ca8ec0f 快取命中分支漏重繪），
 *   CLAUDE.md 也寫了「之後在勝率回應新增圖層時，兩條路徑都要加」—— 但那條規則**只靠人記**。
 *
 * 判準（比內容指紋，不比「有沒有東西」）
 *   A（網路）→ B → A（快取命中）：**同一個標的、同一個時框**，所以每一層的內容必須完全相同。
 *   ★ 只驗「有沒有值」是不夠的：漏重繪時那一層裝的是 B 的資料 —— 有值、但是錯的。
 *   ★ 圖層清單**從 winrate.js 原始碼抽**（regex `_last(FVG|SMC|Coach)*`），不寫死：
 *     以後有人加新圖層，這支自動就涵蓋到，不會像那條人工守則一樣被忘記。
 *
 * 回傳碼：0 兩條路一致 / 1 有圖層沒被重繪（留著別的標的的資料）/ 2 測試不成立
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const A = "BTC/USDT.P", B = "SOL/USDT.P";
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
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 45000 });
    await sleep(4000);
    await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
  } catch (e) {
    console.log(`✗ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return 2;
  }

  const setSym = s => page.evaluate(v => {
    const el = document.getElementById("symbolInput"); el.value = v;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (typeof loadData === "function") loadData();
  }, s);

  /* 圖層清單**從原始碼抽**（不寫死）：以後有人在勝率回應加新圖層，這支自動涵蓋，
     不會像 CLAUDE.md 那條人工守則一樣被忘記。 */
  const LAYER_VARS = (() => {
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "frontend", "static", "js", "winrate.js"), "utf8");
    const set = new Set((src.match(/_last(?:FVG|SMC|Coach)[A-Za-z]*/g) || []));
    set.add("_pdRanges");
    return [...set].sort();
  })();

  /* 圖層指紋。
     ⚠ 這些變數是 **bundle 頂層的 `let`，不在 `window` 上** —— 用 `Object.keys(window)` 找
       會一個都找不到（我第一版就是，只列舉到 1 個）。要用 `page.evaluate(字串)` ＋ `eval(名字)`，
       才會在全域詞法環境裡解析得到（同 check_tf_switch_layers.js 的做法）。
     指紋＝筆數 + JSON 長度 + 開頭片段：足以分辨「換成別的標的的資料」，
     又不會因為浮點尾數之類的無關差異誤報。 */
  const fingerprint = () => page.evaluate(`(() => {
    const names = ${JSON.stringify(LAYER_VARS)};
    const out = {};
    for (const k of names) {
      let v; try { v = eval(k); } catch (e) { out[k] = "未定義"; continue; }
      if (v == null) { out[k] = "null"; continue; }
      let s; try { s = JSON.stringify(v); } catch (e) { s = String(v); }
      out[k] = (Array.isArray(v) ? v.length : "obj") + "/" + s.length + "/" + s.slice(0, 48);
    }
    return out;
  })()`);

  // ── ① A：網路路徑（第一次載入這個標的）──
  await setSym(A);
  await sleep(13000);
  const fpNet = await fingerprint();
  const nLayers = Object.keys(fpNet).length;
  const undef = Object.entries(fpNet).filter(([, v]) => v === "未定義").map(([k]) => k);
  const filled = Object.entries(fpNet).filter(([, v]) => v !== "null" && !/^0\//.test(v)).length;
  console.log(`   ① ${A} 網路路徑：從原始碼抽出 ${nLayers} 個圖層變數，其中 ${filled} 個有資料`
    + (undef.length ? `（${undef.length} 個讀不到：${undef.slice(0, 3).join(",")}）` : ""));
  if (filled < 3) {
    console.log("✗ 有資料的圖層太少（勝率可能沒回來）→ 測試不成立");
    await browser.close();
    return 2;
  }

  // ── ② 切到 B（把各層灌成 B 的資料）──
  await setSym(B);
  await sleep(13000);
  const fpB = await fingerprint();
  const diffAB = Object.keys(fpNet).filter(k => fpNet[k] !== fpB[k]).length;
  console.log(`   ② 切到 ${B}：${diffAB}/${nLayers} 個圖層的內容變了（確認 B 真的把各層蓋掉了）`);
  if (diffAB === 0) {
    console.log("✗ 切標的後沒有任何圖層變化 → 測不到東西，測試不成立");
    await browser.close();
    return 2;
  }

  // ── ③ 切回 A：這次會命中 _wrCache ──
  // ⚠ 必須先關掉「本機快照秒畫」(_snapPaint)，否則測不到東西（我第一版就是）：
  //   loadData 開頭會用 IndexedDB 裡這個標的上次的快照把各層先畫回來 →
  //   即使快取分支漏了某個 _render*，那一層也已經被快照填成**正確的 A 資料**。
  //   關掉之後才是「第一次造訪 / 清過瀏覽器資料」的人真正會走的路 ——
  //   而那正是快取分支唯一負責的情境。
  await page.evaluate(() => { window._snapPaint = function () {}; });
  await setSym(A);
  await sleep(13000);
  const fpCache = await fingerprint();
  const cacheHit = await page.evaluate(() => !!window.__wrLastWasCache);   // 若有埋旗標就用，沒有也不影響判定

  let bad = 0;
  for (const k of Object.keys(fpNet)) {
    if (fpNet[k] === fpCache[k]) continue;
    bad++;
    const looksLikeB = fpCache[k] === fpB[k];
    console.log(`   ✗ ${k}：網路路徑=${fpNet[k].slice(0, 40)}　快取路徑=${String(fpCache[k]).slice(0, 40)}`
      + (looksLikeB ? "　← 還是 " + B + " 的資料" : ""));
    fails.push(looksLikeB
      ? `${k} 在快取命中時沒被重繪 → 留著 ${B} 的資料`
      : `${k} 兩條路徑內容不一致（網路 ${fpNet[k].slice(0, 24)} / 快取 ${String(fpCache[k]).slice(0, 24)}）`);
  }
  console.log(`   ③ 切回 ${A}（快取命中${cacheHit ? "，已確認" : ""}）：${nLayers - bad}/${nLayers} 個圖層與網路路徑一致`);

  if (errs.length) { console.log(`   ✗ ${errs.length} 個 JS 錯誤：${errs[0]}`); fails.push(`${errs.length} 個 JS 錯誤`); }
  else console.log("   ✓ 全程零 JS 錯誤");

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 快取命中時有圖層沒被重繪（圖上照樣有標記、不報錯，但那是別的標的的）：");
    fails.forEach(f => console.log(`   ${f}`));
    console.log("   修法：在 winrate.js 的 `if (_wrCache[cacheKey])` 分支補上對應的 _render*，");
    console.log("         要與網路成功那條路徑**逐一對齊**（CLAUDE.md 有列清單）。");
    return 1;
  }
  console.log("★ 快取命中與網路路徑重繪出完全相同的圖層");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
