// 守門員：上方列不可以「突然變兩行」。
//
// 用法：node scripts/check_topbar_rows.js [URL]（本機服務要跑著）
//
// 這支在抓什麼
//   上方列刻意開著 flex-wrap（勝率欄靠它獨立成第二列）。只要第一列的內容總寬超過視窗，
//   右側那排按鈕就會整組被擠到下一列的最左邊 —— 使用者回報過兩次：
//     ①「螢幕較小的人，右上的那幾個按鈕會跑到左邊第二行」
//     ②「有時候會突然變兩行，明明還有空間」← 這個更陰險：內容是**非同步**長出來的
//        （勝率前三名那條資料到貨才變寬），所以載入當下看起來好好的，過幾秒才壞。
//
// ★ 判準：量「第一列的元素分佈在幾個 y」。同一列的元素 y 會相近（垂直置中差幾 px），
//   換行的話 y 會差一整個列高 → 用 y 分群，群數 >2（第一列 + 勝率欄）就是換行了。
// ★ 這支會**等到前三名那條真的有內容**才判定：那正是「突然變兩行」的觸發時機，
//   一載入就判定會漏掉（我第一版就是這樣，量到的都是還沒填資料的狀態）。
// ⚠ 別把判準寫成「topbar 高度 > 60」：正常就是 74px（第一列 + 勝率欄兩列），會永遠回失敗。

let puppeteer = null;
{
  const path = require("path");
  for (const c of ["puppeteer-core",
                   path.join(process.cwd(), "node_modules", "puppeteer-core"),
                   path.join(process.env.HOME || "", "node_modules", "puppeteer-core")]) {
    try { puppeteer = require(c); break; } catch (e) {}
  }
  if (!puppeteer) { console.error("缺 puppeteer-core：在裝過的目錄執行本腳本"); process.exit(2); }
}
const BASE = process.argv[2] || "http://127.0.0.1:8000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [1920, 1600, 1440, 1366, 1280, 1200];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-first-run"] });
  const p = await br.newPage();
  let bad = 0;
  for (const w of WIDTHS) {
    await p.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
    await p.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
    await p.waitForFunction(() => typeof window._landingEnter === "function", { timeout: 30000 });
    await p.evaluate(() => window._landingEnter());
    await sleep(2200);
    await p.evaluate(() => {
      document.querySelectorAll(".ann-ok,#annOkBtn").forEach(x => x.click());
      document.getElementById("announceOverlay")?.remove();
    });
    // ★ 等前三名那條有內容（非同步）→ 那是「突然變兩行」真正的觸發時機
    const filled = await p.waitForFunction(
      () => { const e = document.getElementById("wrTop3"); return !!(e && e.children.length > 0); },
      { timeout: 25000 }).then(() => true).catch(() => false);
    await sleep(1500);
    const r = await p.evaluate(`(() => {
      const bar = document.querySelector(".topbar");
      const kids = [...bar.children].filter(e => e.offsetParent !== null &&
        getComputedStyle(e).position !== "absolute");
      const ys = kids.map(e => Math.round(e.getBoundingClientRect().y));
      // y 分群（同列的元素 y 只差幾 px）
      const rows = [];
      ys.sort((a, b) => a - b).forEach(y => {
        if (!rows.length || y - rows[rows.length - 1] > 12) rows.push(y);
      });
      const right = document.querySelector(".topbar-right").getBoundingClientRect();
      const left = document.querySelector(".topbar-left").getBoundingClientRect();
      return { rows: rows.length, h: Math.round(bar.getBoundingClientRect().height),
               rightY: Math.round(right.y), leftY: Math.round(left.y),
               top3W: Math.round(document.getElementById("wrTop3")?.getBoundingClientRect().width || 0) };
    })()`);
    // 正常＝2 群（第一列 + 勝率欄）；3 群以上代表第一列被拆開
    const wrapped = r.rows > 2 || Math.abs(r.rightY - r.leftY) > 12;
    const mark = wrapped ? "✗" : "✓";
    if (wrapped) bad++;
    console.log(`  ${mark} 寬 ${String(w).padStart(4)}　列高 ${r.h}px　分 ${r.rows} 列　` +
                `左y${r.leftY}/右y${r.rightY}　前三名寬 ${r.top3W}px${filled ? "" : "（未填資料）"}`);
  }
  await br.close();
  console.log(bad ? `\n★ ${bad} 個寬度下上方列被拆成兩行` : "\n★ 各寬度下上方列都維持單列");
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error("執行失敗:", e.message); process.exit(2); });
