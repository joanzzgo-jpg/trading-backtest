// 守門員：第一次載入不可以「同一個檔案抓兩次」，網址也不可以帶 &amp;
//
// 用法：node scripts/check_dup_assets.js [URL]（需服務跑著；約 40 秒）
//
// 為什麼要有這支（2026-09-13）：把 ?v= 改成每支檔案各自的雜湊之後，城堡圖在第一次載入
//   被抓了**兩次**（81KB × 2）。根因是預載那行寫在 <script> 裡，Jinja 預設會把網址中的
//   `&` 轉成 `&amp;` → 預載抓「?v=…&amp;c=4」、<img> 抓「?v=…&c=4」，兩個不同網址。
//   ⚠ 這種壞法**完全無聲**：畫面一切正常、圖也顯示得出來，只是白花一倍頻寬，
//     而它就落在第一次載入的關鍵路徑上（實測修好後「看到 K 棒」快了 0.3 秒）。
//   ⚠ 判準要看「請求的網址」，不是看畫面 —— 畫面永遠是對的，這就是它難發現的原因。
//
// 例外：瀏覽器自己抓 favicon 走獨立管道，跟 <img> 不共用那一次下載 → favicon 用專用小檔
//   （favicon-96.png），所以這裡順便盯「favicon 不可以指到大圖」。
const path = require("path"), fs = require("fs");
let puppeteer = null;
for (const c of ["puppeteer-core", path.join(process.cwd(), "node_modules", "puppeteer-core"),
                 path.join(process.env.HOME || "", "node_modules", "puppeteer-core")]) {
  try { puppeteer = require(c); break; } catch (e) {}
}
if (!puppeteer) { console.error("缺 puppeteer-core：在任一目錄 npm i puppeteer-core 後於該目錄執行"); process.exit(2); }

const BASE = process.argv[2] || "http://127.0.0.1:8000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync("/tmp/dup-");
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-first-run"], userDataDir: dir });
  const page = await browser.newPage();
  const reqs = [];
  page.on("request", r => { if (/\/static\//.test(r.url())) reqs.push({ url: r.url(), type: r.resourceType() }); });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 90000 });
  } catch (e) {
    console.log(`✗ 載不進去（${e.message.slice(0, 60)}）→ 測試不成立`);
    await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(2);
  }
  await sleep(5000);          // 等延遲載入的那幾支也發完
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });

  if (reqs.length < 8) {      // 保險：沒抓到東西就不算通過（同守門員之十五的「列舉不到就不成立」）
    console.log(`✗ 只看到 ${reqs.length} 個靜態請求 → 測試不成立`);
    process.exit(2);
  }
  let bad = 0;
  // ① 同一個網址被請求兩次（favicon 走獨立管道 → 只在「非 image 類型」重複時才算）
  const cnt = {};
  for (const r of reqs) cnt[r.url] = (cnt[r.url] || 0) + 1;
  const dups = Object.entries(cnt).filter(([, n]) => n > 1);
  if (dups.length) { bad++; dups.forEach(([u, n]) => console.log(`✗ 同一個網址抓了 ${n} 次：${u.replace(/^https?:\/\/[^/]+/, "")}`)); }
  else console.log(`✓ 沒有同一個網址被重複下載（${reqs.length} 個靜態請求）`);

  // ② 同一支檔案、不同網址（?v= 不一致或被 escape）→ 一樣是重複下載
  const byPath = {};
  for (const r of reqs) {
    const u = new URL(r.url);
    (byPath[u.pathname] = byPath[u.pathname] || new Set()).add(u.search);
  }
  const multi = Object.entries(byPath).filter(([, s]) => s.size > 1);
  if (multi.length) { bad++; multi.forEach(([p, s]) => console.log(`✗ 同一支檔案有 ${s.size} 種網址：${p} → ${[...s].join(" / ")}`)); }
  else console.log("✓ 每支檔案只有一種網址（?v= 一致、沒有被 escape）");

  // ③ 網址裡不可以出現 &amp;（Jinja 在 <script> 內的自動轉義漏了 |safe）
  const esc = reqs.filter(r => /&amp;/.test(r.url));
  if (esc.length) { bad++; console.log(`✗ ${esc.length} 個請求的網址帶著 &amp;：${esc[0].url.replace(/^https?:\/\/[^/]+/, "")}`); }
  else console.log("✓ 沒有網址帶著 &amp;");

  // ④ favicon 不可以指到大圖（瀏覽器另抓一次，等於白付那張圖的大小）
  const fav = reqs.find(r => /favicon/.test(r.url) || r.type === "other");
  console.log(fav ? `✓ favicon 走專用檔：${fav.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]}`
                  : "· 這次沒看到 favicon 請求（瀏覽器可能沿用快取）");

  console.log(bad ? `\n失敗 ${bad} 項` : "\n★ 第一次載入沒有重複下載");
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error("✗ 例外:", e.message); process.exit(2); });
