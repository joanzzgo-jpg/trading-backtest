/* 守門員：報價輪詢的相位對齊，不可以在「伺服器產出週期 ≠ 我的輪詢週期」時變成狂打。
   需本機服務跑著；約 10 秒。

   舊公式是 `下次 = 我的週期 − 陳舊度 + 瞄準`，隱含假設「伺服器產出週期＝我的輪詢週期」。
   台股的產出是疊價 worker 的 **5 秒**、輪詢週期卻是 **3 秒** → 陳舊度一超過 3 秒就算出負數，
   被夾成下限 250ms ＝ **每 0.25 秒打一次後端**，而且畫面上完全看不出來（資料照樣在跳）。
   （這就是台股一直被排除在相位對齊之外的原因；2026-09-18 後端補上 ts 後改成量測產出週期。）

   判準＝直接問 `_tkNextDelay()` 排多久：
     ① 台股：資料 4 秒舊、產出 5 秒 → 下一次產出在 1 秒後 → 應排 ~1.1 秒（舊碼：250ms）
     ② 台股：資料剛更新 → 應排 ~5 秒（等下一次產出，不是每 3 秒白問一次）
     ③ 加密：產出 1 秒、輪詢 1 秒 → 行為必須與原本相同
     ④ 伺服器停更（ts 不再前進）→ 必須回固定週期，絕不可以狂打
   ⚠ 合成資料一定要把「陳舊度」餵成真的值：第一版全餵 0，舊公式照樣通過＝叫不出狼。 */
let puppeteer = null;
{
  const path = require("path");
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
                                           args: ["--no-first-run", "--window-size=1400,900"] });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(String(e)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => window._landingEnter());
  await new Promise(r => setTimeout(r, 2500));

  /* 餵一段「伺服器每 gapMs 產一次、手上這份已經 ageMs 舊」的觀測序列，再問下次排多久。
     時鐘偏差設為 0（_tkAgeMin=0）→ 表觀年齡就是真正的陳舊度。 */
  const probe = (mkt, gapMs, ageMs) => page.evaluate(`(() => {
    _tickerMkt = ${JSON.stringify(mkt)};
    _tkResetPhase();
    const now = Date.now();
    for (let i = 5; i >= 0; i--) {
      const ts = (now - ${ageMs} - i * ${gapMs}) / 1000;
      if (_tkLastTs && ts > _tkLastTs) _tkGapHist.push((ts - _tkLastTs) * 1000);
      _tkLastTs = ts;
      _tkAgeHist.push(now - ts * 1000);          // 表觀年齡（這一筆多舊）
    }
    _tkAgeMin = 0;                               // 時鐘偏差＝0
    return { delay: _tkNextDelay(), prod: _tkProdPeriod(_tickerMkt === "tw" ? 3000 : 1000) };
  })()`);

  const fails = [];
  const show = (k, v) => console.log(`  ${k}: 下次輪詢 ${v.delay}ms` +
                                    (v.prod ? `（量到產出週期 ${v.prod}ms）` : ""));

  // ① 台股：產出 5 秒、手上這份 4 秒舊 → 下一次產出在 1 秒後
  const a = await probe("tw", 5000, 4000);
  show("台股 產出5s／資料4s舊", a);
  if (a.delay < 700 || a.delay > 2000) fails.push(`① 應排 ~1.1 秒，實際 ${a.delay}ms` +
    (a.delay <= 260 ? "（＝夾在下限＝狂打）" : ""));
  if (Math.abs(a.prod - 5000) > 400) fails.push(`① 產出週期量成 ${a.prod}ms（應 ~5000）`);

  // ② 台股：剛更新 → 等下一次產出（~5 秒），不是每 3 秒白問一次
  const b = await probe("tw", 5000, 100);
  show("台股 產出5s／剛更新", b);
  if (b.delay < 3500 || b.delay > 6000) fails.push(`② 應排 ~5 秒，實際 ${b.delay}ms`);

  // ③ 加密：產出 1 秒、輪詢 1 秒 → 與原本行為相同（週期 − 陳舊度 + 瞄準）
  const c = await probe("crypto", 1000, 300);
  show("加密 產出1s／資料0.3s舊", c);
  if (Math.abs(c.delay - 820) > 150) fails.push(`③ 加密應排 ~820ms（1000−300+120），實際 ${c.delay}ms`);

  // ④ 伺服器停更 → 回固定週期，不可以狂打
  const d = await page.evaluate(`(() => {
    _tickerMkt = "tw"; _tkResetPhase();
    const ts = (Date.now() - 120000) / 1000;          // 兩分鐘前就停了
    for (let i = 0; i < 6; i++) { _tkAgeHist.push(Date.now() - ts * 1000); _tkLastTs = ts; }
    _tkAgeMin = 0; _tkGapHist.push(5000, 5000, 5000);
    return { delay: _tkNextDelay() };
  })()`);
  show("台股 伺服器停更兩分鐘", d);
  if (d.delay < 2000) fails.push(`④ 伺服器停更時排 ${d.delay}ms ＝ 狂打（應回 3000）`);

  if (errs.length) fails.push(`頁面有 JS 錯誤：${errs.slice(0, 2).join(" | ")}`);
  await browser.close();
  if (fails.length) { console.log("\n✗ " + fails.join("\n✗ ")); process.exit(1); }
  console.log("\n★ 相位對齊：台股對到 5 秒產出、加密行為不變、伺服器停更不會變成狂打");
})().catch(e => { console.error("測試本身失敗：", e); process.exit(2); });
