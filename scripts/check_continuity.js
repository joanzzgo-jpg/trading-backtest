// K 棒連續性守門員 —— 動到 realtime.js / render.js 的補載或即時更新就跑這支。
//
// 用法：
//   1. 本機服務先跑著
//   2. node scripts/check_continuity.js        # 打 http://127.0.0.1:8000
//      node scripts/check_continuity.js <URL>
//   任何一項失敗 → exit 1。
//
// ★為什麼需要：使用者回報「網頁開太久 K 棒會斷掉，要重整才好」。根因是 /api/latest 只回 2 根，
//   輪詢一中斷（分頁凍結／電腦休眠／斷線）中間那幾根就永遠不到 —— 而且**完全不報錯**，
//   一般冒煙測試（載入→拖曳→切時框）跑得再多次也碰不到，因為它從不「中斷再恢復」。
//   這支專門製造中斷，是唯一能抓到這類 bug 的形狀。
//
// ⚠ 這支會真的等好幾分鐘（要讓真實 K 棒收盤），慢是必然的，別為了快而縮短等待。

let puppeteer = null;
{
  const path = require("path");
  for (const c of ["puppeteer-core",
                   path.join(process.cwd(), "node_modules", "puppeteer-core"),
                   path.join(process.env.HOME || "", "node_modules", "puppeteer-core")]) {
    try { puppeteer = require(c); break; } catch (e) {}
  }
  if (!puppeteer) { console.error("缺 puppeteer-core"); process.exit(2); }
}
const BASE = process.argv[2] || "http://127.0.0.1:8000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAILS = [];
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) FAILS.push(name);
};

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-first-run"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction("typeof window._landingEnter === 'function'", { timeout: 30000 });
  await page.evaluate("window._landingEnter()");
  await page.waitForFunction("typeof ohlcvData !== 'undefined' && ohlcvData.length > 100", { timeout: 60000 });
  await page.evaluate(() => { document.getElementById("_annLater")?.click(); });
  // 1m：最快能觀察到「新棒進來」的時框
  await page.evaluate(`[...document.querySelectorAll(".tf-btn")].find(x=>x.dataset.tf==="1m")?.click()`);
  await sleep(14000);

  /* ★ 2026-08-06 加入「價格連續」檢查。
     原本只驗時間間隔（holes）—— 但使用者回報的「小跳空」是**時間連續、價格對不上**：
     輪詢中斷時我們的最後一根停在未完成值，補載只 append 它之後的棒、不修它
     → 那根與下一根的開盤價接不起來。時間軸完全連續，holes 永遠是 0，測不出來。
     實測 300 根 1m：open[i] !== close[i-1] 的有 **0 根** → 對 crypto 可以用嚴格相等當斷言。
     ⚠ 只掃尾段 120 根：深歷史的接縫多半是資料源本身（停機/上市），修不回來也不該讓守門員紅。 */
  const stat = () => page.evaluate(`(() => {
    const per = 60; let holes = 0;
    for (let i = 1; i < ohlcvData.length; i++)
      if (toTime(ohlcvData[i].time) - toTime(ohlcvData[i-1].time) > per * 1.5) holes++;
    /* 門檻＝單根振幅中位數的 15%。不能用「嚴格相等」：
       實測全新載入時接縫恆為 0，但用按鈕切時框（走背景補載接合）後，尾段會出現
       ~50% 的棒有 ≤0.1 的差 —— 那是浮點瘦身/接合的量化噪音（0.1/64874＝0.00015%），
       肉眼不可見，拿它當失敗會讓守門員變成狼來了。
       而真實的接縫是另一個量級：2026-08-04 那次實測 3.3 點（0.005%）。
       以本次量到的中位振幅 17.9 為例 → 門檻 2.7：噪音 0.1 過、真實 3.3 不過，分得開。 */
    const from = Math.max(1, ohlcvData.length - 120);
    const _rng = [];
    for (let i = from; i < ohlcvData.length; i++) _rng.push(Math.abs(+ohlcvData[i].high - +ohlcvData[i].low));
    _rng.sort((a, b) => a - b);
    const medRange = _rng[Math.floor(_rng.length / 2)] || 0;
    const TH = Math.max(medRange * 0.15, 1e-9);
    let seams = 0, maxSeam = 0, seamAt = null, noise = 0;
    for (let i = from; i < ohlcvData.length; i++) {
      const d = Math.abs(+ohlcvData[i].open - +ohlcvData[i-1].close);
      if (d > maxSeam) { maxSeam = d; seamAt = String(ohlcvData[i].time); }
      if (d > TH) seams++; else if (d > 0) noise++;
    }
    // 接縫附近三根的原始數值：判斷是「邊界那根沒被修正」還是「兩個資料源對不起來」的唯一依據
    let around = null;
    if (seamAt) {
      const j = ohlcvData.findIndex(d => String(d.time) === seamAt);
      // ⚠ 這段字串是塞在 page.evaluate(\`...\`) 的模板字串裡 → 內層不能再用反引號（會提前結束外層），
      //   一律用字串串接。
      if (j > 0) around = ohlcvData.slice(Math.max(0, j - 2), j + 2).map(function (d) {
        return String(d.time).slice(11,16) + " O" + d.open + " H" + d.high + " L" + d.low + " C" + d.close;
      });
    }
    return { n: ohlcvData.length, last: String(ohlcvData[ohlcvData.length-1].time), holes,
             seams, maxSeam: +maxSeam.toFixed(4), seamAt, noise, around,
             th: +TH.toFixed(3), medRange: +medRange.toFixed(2) };
  })()`);
  const seamMsg = (s) => s.seams
    ? `${s.seams} 處超過門檻，最大 ${s.maxSeam} @ ${s.seamAt}（門檻 ${s.th}＝中位振幅 ${s.medRange} 的 15%）`
      + (s.around ? `\n        接縫附近：${s.around.join("　|　")}` : "")
    : `尾段 120 根無可見接縫（最大 ${s.maxSeam} < 門檻 ${s.th}；另有 ${s.noise} 處量化噪音）`;

  const base = await stat();
  check("初始無破洞", base.holes === 0, `${base.n} 根，最後 ${base.last}`);
  check("初始無價格接縫", base.seams === 0, seamMsg(base));

  // ① 中斷 4 分鐘（< 5 根週期）→ 舊版會留洞
  console.log("\n① 模擬輪詢中斷 4 分鐘（分頁凍結／休眠）…");
  await page.evaluate("stopRealtime()");
  await sleep(240000);
  await page.evaluate("startRealtime()");
  await sleep(25000);
  let s1 = await stat();
  check("中斷 4 分鐘後無破洞", s1.holes === 0, `${s1.n} 根，最後 ${s1.last}`);
  check("中斷 4 分鐘後無價格接縫", s1.seams === 0, seamMsg(s1));
  check("有追上進度（不是凍住）", s1.n > base.n, `${base.n} → ${s1.n} 根`);

  // ② 中斷 8 分鐘（> 5 根週期）→ 舊版整個凍住不再前進
  console.log("\n② 模擬輪詢中斷 8 分鐘（超過舊版的 5 根週期上限）…");
  const b2 = await stat();
  await page.evaluate("stopRealtime()");
  await sleep(480000);
  await page.evaluate("startRealtime()");
  await sleep(30000);
  const s2 = await stat();
  check("中斷 8 分鐘後無破洞", s2.holes === 0, `${s2.n} 根，最後 ${s2.last}`);
  check("中斷 8 分鐘後無價格接縫", s2.seams === 0, seamMsg(s2));
  check("有追上進度（舊版會完全不動）", s2.n > b2.n, `${b2.n} → ${s2.n} 根`);

  // ③ 歷史模式保護：把資料砍到兩年前，不可以把「現在」接上去
  console.log("\n③ 歷史模式保護（1d 砍到兩年前）…");
  await page.evaluate(`[...document.querySelectorAll(".tf-btn")].find(x=>x.dataset.tf==="1d")?.click()`);
  await sleep(12000);
  const cut = await page.evaluate(`(() => {
    const cutTs = toTime(ohlcvData[ohlcvData.length-1].time) - 730*86400;
    let i = ohlcvData.length-1; while (i > 0 && toTime(ohlcvData[i].time) > cutTs) i--;
    ohlcvData.length = i+1;
    window._hasFwdGap = false;
    window._bgLoadNewerBars = function(){};      // 攔截背景補載，單獨驗 realtime 的判斷
    return String(ohlcvData[ohlcvData.length-1].time);
  })()`);
  await sleep(16000);
  const after = await page.evaluate(`String(ohlcvData[ohlcvData.length-1].time)`);
  check("沒把「現在」接到兩年前資料後面", after === cut, `最後仍是 ${after}`);

  check("零 JS 錯誤", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();

  console.log();
  if (FAILS.length) { console.log(`★ 失敗 ${FAILS.length} 項：${FAILS.join("、")}`); process.exit(1); }
  console.log("★ K 棒連續性全部通過");
})();
