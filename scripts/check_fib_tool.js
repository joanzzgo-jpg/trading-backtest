/* 守門員：斐波那契工具的三條行為。需本機服務跑著；約 40 秒。
 *
 * 2026-09-22 使用者：「優化斐波」。實測抓到的問題，這支把它們釘住 ——
 *  ①★★ **右側 775px 的幽靈命中區**：`drawingDist` 只擋了左邊
 *     （`if (x < min(a.x,b.x) - 10) return Infinity`），右邊沒擋 → 線明明只畫到右端點，
 *     右側卻一路到畫布邊緣都判定「距離 0」。實測斐波畫在 x 296~416，
 *     x=596/834/1072/1167 全都抓得到 → 點畫面右邊三分之二的任何地方都會選到它。
 *     畫面上零跡象。★ 同 memory project_crosshair-blank-vline：修邊界外先問「另一邊呢」。
 *  ② 價格小數位照**價格級距**猜（`p < 1 → toFixed(4)`）→ 0.00001234 顯示成 **0.0000**，
 *     小幣的斐波標籤整排都是 0。memory project_price-decimals-from-data 記過這個坑，
 *     當時修了三支格式化函式，斐波這支是漏網的第四支。改成走全站 `_fmtPx`（問資料）。
 *  ③ 層級清單寫死在**兩個**地方（drawOne 的 _fibLevels 與 drawingDist）→ 加一條要改兩處，
 *     漏掉命中判定那份＝那條線**畫得出來卻摸不到**，完全不報錯。收斂成唯一的 FIB_LEVELS。
 *  ④ 延伸位（127.2/161.8）2026-09-22 加了又**移除**（使用者：「斐波那契延伸刪除」）。
 *     加的當天還先出過一次「畫反邊」——層級原本只存一個 `lvl` 再用 `1 - lvl` 換算，
 *     lvl>1 會落在**起點外側**（走勢來的方向），而延伸位是目標價、該在終點外側。
 *     ★ 留著這段是因為**結構上的修法有價值**：層級改存 `frac`（佔整段走勢的幾成：
 *       0＝起點／1＝終點／>1＝終點外）＋ `label`（標籤印的百分比），那個容易搞反的
 *       換算就消失了。真要再加延伸位，新增一筆 frac>1 即可，三處都讀同一份。
 *
 * 判準：
 *   ①右端點外 → 摸不到（Infinity）；左端點外 → 摸不到；線上 → 摸得到
 *   ②`_fibFmt` 對小價位不可以歸零，且要跟著資料的小數位走
 *   ③ 每一個 FIB_LEVELS 層級在它自己的 y 上都摸得到，且恰好是 7 條回調位
 *      ← 這條同時證明「繪製與命中判定讀的是同一份」：漏掉就摸不到
 * ⚠⚠ 距離是 Infinity 時 **`Infinity < 12` 是 false，但 `null < 12` 是 true**：
 *    經過 page.evaluate 的 JSON 序列化，Infinity 會變成 null → 直接拿來比大小會
 *    把「摸不到」讀成「摸得到」＝**判準反了**（我第一版就是，修好了還報失敗）。
 *    一律先把 null 正規化成 Infinity。
 * ⚠ 判準一律問**產品自己的函式**（drawingDist / _fibFmt / FIB_LEVELS），
 *   不在測試裡複製公式 —— 複製的話只是自己測自己。
 * ⚠ 一律用假帳號名；回傳碼 2＝進不了場（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8000";
const FAKE_ACCT = "__gk_fib_test__";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null ? Infinity : v);        // ⚠ 見檔頭：null 其實是 Infinity
const _f = n => (Math.round(n * 10) / 10).toLocaleString("en-US");

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--window-size=1440,900"],
    });
  } catch (e) {
    console.log(`⊘ 開不了瀏覽器（${e.message.slice(0, 60)}）→ 測試不成立`);
    return process.exit(2);
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = []; page.on("pageerror", e => errs.push(String(e).slice(0, 140)));
  const ev = s => page.evaluate(s);
  const bad = [];

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.evaluate(n => {
      localStorage.setItem("acctName", n);
      localStorage.removeItem("drawings");
      sessionStorage.setItem("landingDismissedAt", String(Date.now()));
    }, FAKE_ACCT);
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    await page.evaluate(() => {
      const o = document.getElementById("announceOverlay"); if (o) o.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await page.waitForFunction(
      () => typeof ohlcvData !== "undefined" && ohlcvData.length > 100, { timeout: 45000 });
    await sleep(4000);
    await page.waitForFunction(() => typeof window._drawLayerState === "function", { timeout: 20000 });
    await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
  } catch (e) {
    console.log(`⊘ 進不了場（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close();
    return process.exit(2);
  }

  const rect = await page.evaluate(() => {
    const r = document.getElementById("mainChart").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = Math.round(rect.x + rect.w * 0.25), cy = Math.round(rect.y + rect.h * 0.35);

  // 兩次點擊建立（fib 不是拖曳型）
  await page.evaluate(() => document.querySelector('[data-tool="fib"]').click());
  await sleep(250);
  await page.mouse.click(cx, cy); await sleep(250);
  await page.mouse.click(cx + 120, cy + 140); await sleep(500);

  const info = await ev(`(() => {
    const d = drawings.find(x => x.type === "fib");
    if (!d) return null;
    const a = chartToScreen(d.p1.time, d.p1.price), b = chartToScreen(d.p2.time, d.p2.price);
    return { xL: Math.round(Math.min(a.x, b.x)), xR: Math.round(Math.max(a.x, b.x)),
             W: Math.round(document.getElementById("mainChart").getBoundingClientRect().width) };
  })()`);
  if (!info) {
    console.log("⊘ 沒建立出 fib（工具按鈕或建立流程變了？）→ 測試不成立");
    await browser.close(); return process.exit(2);
  }
  console.log(`斐波畫在 x ${info.xL}~${info.xR}（主圖寬 ${info.W}）\n`);

  // ① 命中範圍：只有畫得到線的那一段才摸得到
  const hits = await ev(`(() => {
    const d = drawings.find(x => x.type === "fib");
    const a = chartToScreen(d.p1.time, d.p1.price), b = chartToScreen(d.p2.time, d.p2.price);
    const midY = (a.y + b.y) / 2;
    const xL = Math.min(a.x, b.x), xR = Math.max(a.x, b.x);
    return [["左端點外 80px", xL - 80], ["線段正中", (xL + xR) / 2],
            ["右端點外 80px", xR + 80], ["右端點外 300px", xR + 300],
            ["畫布最右", document.getElementById("mainChart").getBoundingClientRect().width - 20]]
      .map(([n, xx]) => [n, Math.round(xx), drawingDist(d, xx, midY)]);
  })()`);
  console.log("① 各處「離這個斐波多遠」（<12 ＝ 摸得到）：");
  hits.forEach(([n, xx, dd]) => {
    const v = num(dd);
    console.log(`   ${n.padEnd(16)} x=${String(xx).padStart(5)}  ${v === Infinity ? "摸不到" : "距離 " + v.toFixed(1)}`);
  });
  const inside = num(hits.find(h => h[0] === "線段正中")[2]);
  if (!(inside < 12)) bad.push(`線段正中應該摸得到，實得距離 ${inside}`);
  hits.filter(h => h[0] !== "線段正中").forEach(([n, xx, dd]) => {
    if (num(dd) < 12) bad.push(`「${n}」(x=${xx}) 畫面上沒有東西卻摸得到 ＝ 幽靈命中區`);
  });

  // ③④ 每個層級（含延伸位）在自己的 y 上都要摸得到 → 證明繪製與命中判定同一份清單
  const lv = await ev(`(() => {
    const d = drawings.find(x => x.type === "fib");
    const a = chartToScreen(d.p1.time, d.p1.price), b = chartToScreen(d.p2.time, d.p2.price);
    const xm = (Math.min(a.x, b.x) + Math.max(a.x, b.x)) / 2;
    return { p1: d.p1.price, p2: d.p2.price,
      rows: FIB_LEVELS.map(({ label, frac, ext }) => {
        const px = _fibPrice(d, frac);
        const y = candleSeries.priceToCoordinate(px);
        return { label, ext: !!ext, px,
                 dist: y == null ? null : drawingDist(d, xm, y), txt: _fibFmt(px) };
      }) };
  })()`);
  console.log(`\n③ 各層級在自己的 y 上摸不摸得到（走勢 ${lv.p1.toFixed(1)} → ${lv.p2.toFixed(1)}）：`);
  lv.rows.forEach(({ label, ext, px, dist, txt }) => {
    const v = num(dist);
    console.log(`   ${String(label.toFixed(1)).padStart(6)}%  ${String(txt).padStart(11)}  ${v < 12 ? "摸得到" : "✗ 摸不到"}`);
    if (!(v < 12)) bad.push(`層級 ${label.toFixed(1)}% 摸不到（繪製與命中判定的層級清單不同步？）`);
    // 2026-09-22 使用者要求拿掉延伸位 → 這份清單不該再有 frac>1 的項目
    if (ext) bad.push(`層級 ${label.toFixed(1)}% 還標著 ext（延伸位已移除）`);
  });
  if (lv.rows.length !== 7)
    bad.push(`層級應為 7 條回調位，實得 ${lv.rows.length} 條（${lv.rows.map(r => r.label).join("/")}）`);

  // ② 價格格式：小價位不可以被顯示成 0
  const fmt = await ev(`(() => {
    // 直接問產品的 _fibFmt；先把全站小數位設成「這種小幣該有的位數」再問
    const save = window._pxPrec;
    window._pxPrec = 8;
    const out = [0.00001234, 0.08312, 3.2156].map(p => [p, _fibFmt(p)]);
    window._pxPrec = save;
    return out;
  })()`);
  console.log(`\n② 小價位的標籤（小數位設 8 時）：`);
  fmt.forEach(([p, s]) => console.log(`   ${String(p).padEnd(14)}→ ${s}`));
  fmt.forEach(([p, s]) => {
    if (parseFloat(s) === 0 && p !== 0) bad.push(`${p} 被顯示成 ${s}（小數位不夠 → 小幣標籤整排是 0）`);
  });

  if (errs.length) bad.push(`JS 錯誤 ${errs.length}：${errs[0]}`);
  console.log(bad.length ? "\n✗ " + bad.join("\n✗ ") : "\n★ 斐波三項全部符合預期");
  await browser.close();
  process.exit(bad.length ? 1 : 0);
})();
