/* 守門員：配色跨裝置同步的四條行為。需本機服務跑著；約 40 秒。
 *
 * 2026-09-23 使用者：「我的 qwer 線上 railway 一直跳回紅色背景主背景」
 *                     「而且我改完配色到黑色，下次還是跳紅色」。
 * 實測他帳號快照裡：`chartColors.chartBg = #000000`（電腦那份）、
 *                   `chartColors_m.chartBg = #eb4747`（手機那份，iPad 讀的就是它）。
 * 兩個獨立的環節串起來才會「改了又變回去」——
 *  ①**兩份色盤**：舊 `savePrefs/loadPrefs` 用 `_prefKey()` 依 isMobileUI() 決定讀寫
 *    `chartColors` 還是 `chartColors_m`。iPad 一律手機款 → 永遠讀到紅的那份。
 *  ②★★ **電腦會把紅的復活**：`_acctSnapshot()` 推的是**整包 localStorage**。
 *    電腦上那顆 `chartColors_m`（早年從手機同步下來的紅）電腦自己永遠不會改它，
 *    卻每次 flush 都原封不動再推一次 → iPad 改成黑、下次開機下行又把紅的蓋回來。
 *    **使用者看到的就是「我明明改成黑色，下次又是紅的」**，而且畫面零跡象。
 *    ★ 通則：整包快照同步時，**任何一台留著的死 key 都會被它一直復活** ——
 *      廢棄 key 一定要同時做三件事：本機刪、列入 _PULL_SKIP、讀取端改讀新 key。
 *  ③ 切到背景時的推送**必須用 `navigator.sendBeacon`**：iOS 把 app 切到背景會殺掉
 *    進行中的 `fetch` → `_acctFlush()` 送不出去；而下次開啟是全新開機、`_acctSeenTs` 是 0
 *    → 下行**一定會套用雲端那份** → 剛改的顏色被雲端舊值蓋回去，同樣是「下次又變回來」。
 *
 * 判準（一律問產品自己的狀態，不看程式碼）：
 *   ① 本機同時有黑 `chartColors` 與紅 `chartColors_m` → 開機後 `C.chartBg` 必須是**黑**
 *   ② 開機後 `chartColors_m` 必須已從 localStorage **刪掉**（不刪就會一直被推上雲端）
 *   ③ 雲端快照帶著紅 `chartColors_m` → 下行**不可以**把它寫回 localStorage
 *   ④ 改成黑色後切到背景 → 要有一次 **sendBeacon** 打 /api/account/sync 且內容是黑的，
 *      而且資料庫裡真的變黑（＝這條路從前端到後端是通的）
 * ⚠ ④ 沒辦法在 headless 裡真的重現「iOS 殺掉 fetch」（桌面 Chrome 的 fetch 會正常完成）
 *   → 判準只能落在**送出的機制**上：用 fetch 的舊寫法 sendBeacon 次數＝0 就是紅的。
 *   這是刻意的取捨，不是偷懶：差別本來就只在「背景化時會不會被殺」，而那正是機制決定的。
 * ⚠ 一律用假帳號名（見 memory feedback_never-use-real-account-in-tests）；測完刪掉那一列。
 * ⚠ 回傳碼 2＝進不了場／開不了瀏覽器／假帳號建不起來（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const { execFileSync } = require("child_process");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8000";
const FAKE = "__gk_palette_test__";
const RED = "#eb4747", BLACK = "#000000";
const PY = "/Users/noah/trading/.venv312/bin/python";
const DB = "/Users/noah/trading/backend/.accounts.db";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 直接對 .accounts.db 動那一列（本機沒設 ACCOUNT_ADMIN_KEY，開不了 admin/create）
function dbRun(code) {
  return execFileSync(PY, ["-c", `
import sqlite3, json, time, sys
db = sqlite3.connect(${JSON.stringify(DB)})
${code}
db.commit()
`], { encoding: "utf-8" }).trim();
}

(async () => {
  const bad = [];
  let browser;
  try {
    // 種一份「雲端快照」：兩份色盤都是紅的（模擬使用者帳號裡的實況）
    dbRun(`
data = {"chartColors": json.dumps({"chartBg": "${RED}"}),
        "chartColors_m": json.dumps({"chartBg": "${RED}"})}
db.execute("INSERT OR REPLACE INTO accounts(name,data,updated_at) VALUES(?,?,?)",
           (${JSON.stringify(FAKE)}, json.dumps(data), time.time()))
`);

    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--window-size=1440,900"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const ev = src => page.evaluate(src);

    /* ── ①② 本機黑 vs 本機紅 `_m`：黑的要贏，且 `_m` 要被刪掉 ───────────────
       （這一段**不登入**，單純驗 loadPrefs 的合併，避免下行插手混淆判斷） */
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.evaluate((black, red) => {
      localStorage.removeItem("acctName");
      localStorage.setItem("chartColors", JSON.stringify({ chartBg: black }));
      localStorage.setItem("chartColors_m", JSON.stringify({ chartBg: red }));
      sessionStorage.setItem("landingDismissedAt", String(Date.now()));
    }, BLACK, RED);
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    await page.evaluate(() => {
      document.getElementById("announceOverlay")?.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await sleep(2500);
    if (!(await ev("typeof C === 'object' && !!C"))) {
      console.error("⚠ 測試不成立：進不了場（C 不存在）"); process.exit(2);
    }
    const bg1 = await ev("C.chartBg");
    console.log(`① 開機採用的主圖背景：${bg1}（應為 ${BLACK}）`);
    if (bg1 !== BLACK) bad.push(`① 手機那份紅色贏了：C.chartBg=${bg1}`);

    const mLeft = await ev("localStorage.getItem('chartColors_m')");
    console.log(`② 開機後 chartColors_m：${mLeft === null ? "已刪除" : mLeft}（應為已刪除）`);
    if (mLeft !== null) bad.push(`② chartColors_m 沒被刪掉 → 會一直被推上雲端再被別台拉回來`);

    /* ── ③ 下行不可以把雲端的 `_m` 寫回來 ───────────────────────────────── */
    await page.evaluate(n => {
      localStorage.setItem("acctName", n);
      localStorage.removeItem("chartColors");
      localStorage.removeItem("chartColors_m");
      sessionStorage.setItem("landingDismissedAt", String(Date.now()));
      sessionStorage.setItem("_acctBootReloaded", "1");   // 擋掉下行觸發的整頁重載
    }, FAKE);
    await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
    await page.evaluate(() => {
      document.getElementById("announceOverlay")?.remove();
      if (window._landingEnter) window._landingEnter();
    });
    await sleep(4000);
    const pulled = await ev("localStorage.getItem('chartColors')");
    const pulledM = await ev("localStorage.getItem('chartColors_m')");
    console.log(`③ 下行後 chartColors：${pulled}　chartColors_m：${pulledM === null ? "(沒寫回來)" : pulledM}`);
    if (pulled === null) { console.error("⚠ 測試不成立：下行根本沒套用（假帳號沒登入成功？）"); process.exit(2); }
    if (pulledM !== null) bad.push(`③ 下行把死 key chartColors_m 寫回來了 → 永遠收斂不了`);

    /* ── ④ 改成黑色 → 切到背景要用 sendBeacon 送出，且資料庫真的變黑 ────── */
    await page.evaluate(() => {
      window.__beacons = [];
      const orig = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url, data) {
        window.__beacons.push(String(url));
        try { if (data && data.text) data.text().then(t => window.__beaconBody = t); } catch (e) {}
        return orig(url, data);
      };
    });
    await page.evaluate(black => { C.chartBg = black; savePrefs(); }, BLACK);
    await sleep(300);
    // 切到背景（離開前景那一刻的推送）
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await sleep(2500);
    const beacons = await ev("window.__beacons || []");
    const hitSync = beacons.filter(u => /\/api\/account\/sync/.test(u)).length;
    console.log(`④a 切到背景時的 sendBeacon(/api/account/sync)：${hitSync} 次（應 ≥1）`);
    if (hitSync < 1) bad.push("④a 切到背景時沒用 sendBeacon → iOS 背景化會殺掉 fetch，改的顏色送不出去");

    const dbBg = dbRun(`
row = db.execute("SELECT data FROM accounts WHERE name=?", (${JSON.stringify(FAKE)},)).fetchone()
d = json.loads(row[0]) if row else {}
print(json.loads(d.get("chartColors", "{}")).get("chartBg"))
`);
    console.log(`④b 資料庫裡的 chartBg：${dbBg}（應為 ${BLACK}）`);
    if (dbBg !== BLACK) bad.push(`④b 背景推送沒有真的寫進資料庫（仍是 ${dbBg}）→ 下次開機會被舊值蓋回去`);

  } catch (e) {
    console.error("⚠ 測試不成立：" + (e && e.message || e));
    try { dbRun(`db.execute("DELETE FROM accounts WHERE name=?", (${JSON.stringify(FAKE)},))`); } catch (e2) {}
    if (browser) await browser.close();
    process.exit(2);
  }

  try { dbRun(`db.execute("DELETE FROM accounts WHERE name=?", (${JSON.stringify(FAKE)},))`); } catch (e) {}
  if (browser) await browser.close();

  if (bad.length) { console.error("\n✗ 失敗：\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("\n✓ 配色同步四項全過");
})();
