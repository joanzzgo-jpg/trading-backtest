// 守門員：主圖 K 棒不可以「自己動」。不看畫面、直接盯 ohlcvData 逐欄比對。
//
// 用法：node scripts/check_bar_stability.js [URL] [時框] [秒數]
//       （本機服務要跑著；預設 http://127.0.0.1:8000 1m 150）
//
// 分級（★ 判準一定要分級，不然會把正常行為誤判成 bug，我第一版就踩了）：
//   age=0 形成中那根 → h/l/c 本來就一直在變＝**正常**；但 open **永遠不該變**
//   age=1 剛收盤那根 → 補成最終值＝**正常**（就是修「小跳空」那套機制，見 realtime.js）
//   age≥2 早就定案的棒 → 動了就是 bug（真正的訊號）
//
// 這支在抓什麼：使用者回報「主圖最新 K 棒還是會動」。實測根因是**資料來源在
// binance / bybit 之間反覆跳**——兩家對同一根已收盤 K 棒差 4~15 點，而前端為了不留接縫，
// 換源時會整段重對齊（連 open 一起換）、同源時保留 open 只換 h/l/c → 每跳一次畫面就動一次。
// 修法在後端 routes/data.py 的 _sticky_source（來源黏著：換源那一拍回空、不是回舊快照）。
// ⚠ 一般冒煙測試抓不到：它只跑幾秒、也不逐欄比對；這種「每隔幾秒動一下」要盯上百秒才看得出來。
let puppeteer = null;
{ const path = require("path");
  for (const c of ["puppeteer-core", path.join(process.env.HOME || "", "node_modules", "puppeteer-core")]) {
    try { puppeteer = require(c); break; } catch (e) {} }
  if (!puppeteer) { console.error("缺 puppeteer-core"); process.exit(2); } }
const BASE = process.argv[2] || "http://127.0.0.1:8000";
const TF   = process.argv[3] || "1m";
const SECS = +(process.argv[4] || 100);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--window-size=1400,900"] });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => typeof window._landingEnter === "function", { timeout: 30000 });
  await page.evaluate(() => window._landingEnter());
  await sleep(2000);
  await page.evaluate(() => { document.querySelectorAll(".ann-ok,#annOkBtn").forEach(b => b.click()); });
  await page.evaluate(t => { const b = document.querySelector(`.tf-btn[data-tf="${t}"]`); if (b) b.click(); }, TF);
  await sleep(6000);

  // 頁內常駐取樣器：每 200ms 記下尾端 6 根的 OHLC，逐欄比對上一輪
  await page.evaluate(() => {
    window.__moves = [];
    window.__prev = null;
    window.__tfSec = ({"1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400})[currentTF] || 60;
    window.__tick = setInterval(() => {
      try {
        const n = ohlcvData.length; if (n < 8) return;
        const cur = {};
        for (let i = n - 6; i < n; i++) {
          const b = ohlcvData[i];
          cur[toTime(b.time)] = { o:+b.open, h:+b.high, l:+b.low, c:+b.close, isLast: i === n - 1 };
        }
        const p = window.__prev;
        if (p) for (const t in cur) {
          if (!p[t]) continue;
          for (const f of ["o","h","l","c"]) {
            if (cur[t][f] !== p[t][f]) {
              const newest = Math.max.apply(null, Object.keys(cur).map(Number));
              window.__moves.push({ t:+t, f, from:p[t][f], to:cur[t][f],
                                    age: Math.round((newest - +t) / (window.__tfSec || 60)),
                                    at:Date.now() });
            }
          }
        }
        window.__prev = cur;
      } catch (e) {}
    }, 200);
  });

  await sleep(SECS * 1000);
  // ★ 硬不變式：任何合法 K 棒都必須滿足 low ≤ min(open,close) 且 high ≥ max(open,close)。
  //   違反＝那根是「兩份快照縫出來的」（open 來自 A、h/l/c 來自 B），沒有別的可能。
  //   這是最乾淨的守門條件：不用judgement、不會誤報。
  const r = await page.evaluate(() => {
    const bad = [];
    for (let i = 0; i < ohlcvData.length; i++) {
      const b = ohlcvData[i];
      const o = +b.open, h = +b.high, l = +b.low, c = +b.close;
      if (!Number.isFinite(o + h + l + c)) continue;
      if (l > Math.min(o, c) + 1e-9 || h < Math.max(o, c) - 1e-9)
        bad.push({ t: b.time, o, h, l, c });
    }
    return { moves: window.__moves, tf: currentTF, badBars: bad.slice(0, 5), badCount: bad.length,
             sym: document.getElementById("symbolInput").value, n: ohlcvData.length };
  });
  await browser.close();

  const M = r.moves;
  // age=0 形成中 / age=1 剛收盤(補最終值,正常) / age>=2 早就定案的棒 ← 動了才是 bug
  const openLast   = M.filter(m => m.f === "o" && m.age === 0);         // 形成中那根的 open ← 不該動
  const justClosed = M.filter(m => m.age === 1);                        // 剛收盤補最終值 ← 正常
  const settled    = M.filter(m => m.age >= 2);                         // 早就定案的棒 ← 不該動
  const formingHLC = M.filter(m => m.age === 0 && m.f !== "o");         // 正常
  const closedAny  = settled;
  const mag = a => a.length ? Math.max(...a.map(m => Math.abs(m.to - m.from))).toFixed(4) : "-";
  console.log(`標的 ${r.sym} ${r.tf}，${SECS}s，共 ${r.n} 根，偵測到 ${M.length} 次欄位變動`);
  console.log(`  ① 形成中那根的 open 變動：  ${openLast.length} 次（最大 ${mag(openLast)}）  ← 應為 0`);
  console.log(`  ② **早就定案**的棒被改寫： ${settled.length} 次（最大 ${mag(settled)}）  ← 應為 0（真正的 bug 訊號）`);
  console.log(`  ③ 剛收盤那根補最終值：    ${justClosed.length} 次（最大 ${mag(justClosed)}）  ← 正常（就是修小跳空那套）`);
  console.log(`  ④ 形成中那根的 h/l/c：    ${formingHLC.length} 次（最大 ${mag(formingHLC)}）  ← 正常`);
  const iso = t => new Date(t * 1000).toISOString().slice(5, 16);
  for (const m of settled.slice(0, 8))
    console.log(`     定案棒 ${iso(m.t)}(第${m.age}根前) ${m.f}: ${m.from} → ${m.to}（差 ${(m.to - m.from).toFixed(4)}）`);
  for (const m of openLast.slice(0, 8))
    console.log(`     形成中 ${iso(m.t)} open: ${m.from} → ${m.to}（差 ${(m.to - m.from).toFixed(4)}）`);
  console.log(`  判定：${(openLast.length === 0 && settled.length === 0) ? "✓ 沒有不該發生的變動" : "✗ 仍有不該發生的變動"}`);
  console.log(`  ⑤ 不可能的 K 棒（low>開收 或 high<開收）：${r.badCount} 根  ← 應為 0（混快照的鐵證）`);
  for (const b of r.badBars)
    console.log(`     ${b.t}  O${b.o} H${b.h} L${b.l} C${b.c}`);
  if (errs.length) console.log("  JS 錯誤:", errs.slice(0, 3).join(" | "));
  const pass = openLast.length === 0 && settled.length === 0 && r.badCount === 0 && errs.length === 0;
  console.log(pass ? "\n★ K 棒穩定性全部通過" : "\n★ 失敗（見上方 ✗ 項目）");
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error("執行失敗:", e.message); process.exit(2); });
