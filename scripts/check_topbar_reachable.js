#!/usr/bin/env node
/**
 * 守門員：窄螢幕上，topbar 的每一顆按鈕都必須點得到。
 *
 * 用法（本機服務要跑著；在裝過 puppeteer-core 的目錄執行）：
 *     node scripts/check_topbar_reachable.js [BASE_URL]
 *
 * 為什麼需要這支
 *   `.topbar-right` 是一排會**越加越多**的圖示按鈕。它沒有自己的捲動區時，
 *   排在最後的那幾顆會直接落在視窗外 —— 而且 `.topbar` 不捲、body 又 `overflow-x:hidden`
 *   → **永遠點不到，畫面上也沒有任何異常**（不重疊、不變形、零 JS 錯誤）。
 *   使用者的回報形狀是「某個按鈕不見了 / 找不到」，開發者在桌面永遠重現不出來。
 *
 *   已經中過兩次：
 *     ・2026-08-11 使用者：「上方按鈕在螢幕縮小時不能滑動」（1181~1499px）
 *     ・2026-08-12 我自己加 netSig(26px)+drawLayers(72px) → 390px 上「我的交易」「VWAP」出界
 *       ⚠ 而且修正前只剩 6px 餘裕（313 vs 390）→ 360px 的 Android 其實早就中了。
 *
 * ★ 一般冒煙測試抓不到：它跑桌面寬度，而且從不問「這顆按鈕點得到嗎」。
 *
 * 判準（問畫面要真相，不看 CSS）
 *   對 `.topbar-right` 每一個**可見**子元素：先把它捲進視野，然後
 *   ①中心點必須落在視窗內 ②`elementFromPoint(中心)` 必須命中它自己或其子孫
 *   （②才是真正的「點得到」—— 只驗座標會漏掉被別的浮層蓋住的情況）。
 *   另外驗兩件不能為了塞按鈕而犧牲的事：標的輸入框夠寬、整頁不得橫向捲動。
 *
 * ★★ 「捲進視野」**不可以用 `scrollIntoView()`**（我第一版就是這樣寫，結果**植回舊碼照樣通過**
 *    ＝叫不出狼的守門員）。原因：`overflow-x: hidden` 只擋**使用者**捲動，
 *    程式改 `scrollLeft` 照樣有效 → `scrollIntoView` 會去捲 document，
 *    把一顆使用者永遠碰不到的按鈕「捲」進視野，然後回報一切正常。
 *    正解：只捲**使用者真的捲得動的祖先**（overflow-x 是 auto/scroll 且真的有溢出），
 *    捲完再把 document 的 scrollLeft 歸零 —— 靠 document 位移換來的「可見」不算數。
 *
 * 回傳碼：0 全部可達 / 1 有按鈕點不到 / 2 測試不成立（服務沒起來、進不了場）
 */
const puppeteer = require("puppeteer-core");

const BASE = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 涵蓋最窄的主流手機（360）到 iPad；1180 是 isMobileUI 的斷點，1200 用來守桌面窄視窗那段
const DEVICES = [
  { n: "Android 360", w: 360, h: 740, touch: true },
  { n: "iPhone SE 375", w: 375, h: 667, touch: true },
  { n: "iPhone 12 390", w: 390, h: 844, touch: true },
  { n: "iPad 820", w: 820, h: 1180, touch: true },
  { n: "桌面窄窗 1200", w: 1200, h: 800, touch: false },
];
// 標的輸入框被壓到這以下就等於不能用了。桌面窄窗 1200px 的現況剛好是 90px（既有行為，
// 非本次改動），門檻取 80 留一點餘裕 —— 貼著現況設門檻＝下次動一個 px 就叫狼來了。
const MIN_SYMBOL_W = 80;

const fails = [];

async function main() {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
    });
  } catch (e) {
    console.log(`✗ 開不了瀏覽器（${e.message.slice(0, 60)}）→ 測試不成立`);
    return 2;
  }

  for (const d of DEVICES) {
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(String(e).slice(0, 120)));
    try {
      const cdp = await page.target().createCDPSession();
      // ⚠ 一定要用 CDP 的 setDeviceMetricsOverride：--window-size 量到的 innerWidth 是錯的
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: d.w, height: d.h, deviceScaleFactor: 2, mobile: d.touch });
      if (d.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await page.goto(BASE, { waitUntil: "networkidle2", timeout: 70000 });
      // ⚠ headless 進場唯一正解＝window._landingEnter()
      await page.evaluate(() => {
        const o = document.getElementById("announceOverlay"); if (o) o.remove();
        if (window._landingEnter) window._landingEnter();
      });
      await page.waitForFunction(() => !!document.querySelector(".topbar-right"), { timeout: 45000 });
      await new Promise(r => setTimeout(r, 3500));
      await page.evaluate(() => { const o = document.getElementById("announceOverlay"); if (o) o.remove(); });
    } catch (e) {
      console.log(`✗ ${d.n}：進不了場（${e.message.slice(0, 50)}）→ 測試不成立`);
      await page.close(); await browser.close();
      return 2;
    }

    const r = await page.evaluate(async () => {
      // 只找「使用者真的捲得動」的祖先：overflow-x 是 auto/scroll、而且真的有溢出。
      // overflow:hidden 的祖先刻意不算 —— 那種只有程式捲得動，使用者碰不到。
      const userScrollable = e => {
        let p = e.parentElement;
        while (p && p !== document.documentElement) {
          const ox = getComputedStyle(p).overflowX;
          if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth + 1) return p;
          p = p.parentElement;
        }
        return null;
      };
      const tr = document.querySelector(".topbar-right");
      const vis = [...tr.children].filter(e => getComputedStyle(e).display !== "none");
      const out = [];
      for (const e of vis) {
        const sc = userScrollable(e);
        if (sc) {                       // 把它捲到那個捲動區的中央
          const eb = e.getBoundingClientRect(), sb = sc.getBoundingClientRect();
          sc.scrollLeft += (eb.left + eb.width / 2) - (sb.left + sb.width / 2);
        }
        // ⚠ document 被誰捲過都不算數 —— 使用者捲不動它（body overflow-x:hidden）
        document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const b = e.getBoundingClientRect();
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        const inView = cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
        const t = inView ? document.elementFromPoint(cx, cy) : null;
        out.push({
          id: e.id || String(e.className).slice(0, 20),
          ok: inView && !!t && (t === e || e.contains(t)),
          why: !inView ? "在視窗外" : "被別的元素蓋住",
        });
      }
      tr.scrollLeft = 0;
      const si = document.querySelector(".tb-symbol-input");
      return {
        kids: out,
        symW: si ? Math.round(si.getBoundingClientRect().width) : null,
        docScrollW: document.documentElement.scrollWidth,
        innerW: innerWidth,
        needScroll: tr.scrollWidth > tr.clientWidth + 1,
      };
    });

    const bad = r.kids.filter(k => !k.ok);
    const symOk = r.symW === null || r.symW >= MIN_SYMBOL_W;
    const pageOk = r.docScrollW <= r.innerW + 1;
    const ok = !bad.length && symOk && pageOk && !errs.length;
    console.log(`   ${ok ? "✓" : "✗"} ${d.n.padEnd(14)} 按鈕 ${r.kids.length - bad.length}/${r.kids.length} 可達`
      + `　標的框 ${r.symW}px　整頁不橫捲 ${pageOk}　按鈕列需捲動 ${r.needScroll}`);
    for (const b of bad) {
      console.log(`        ✗ ${b.id}：${b.why}`);
      fails.push(`${d.n}：${b.id} ${b.why}`);
    }
    if (!symOk) fails.push(`${d.n}：標的輸入框被壓到 ${r.symW}px（<${MIN_SYMBOL_W}）`);
    if (!pageOk) fails.push(`${d.n}：整頁橫向溢出 ${r.docScrollW} > ${r.innerW}`);
    if (errs.length) fails.push(`${d.n}：${errs.length} 個 JS 錯誤（${errs[0]}）`);
    await page.close();
  }

  await browser.close();
  console.log();
  if (fails.length) {
    console.log("★ 有按鈕在窄螢幕上點不到（畫面看起來完全正常、不報錯）：");
    fails.forEach(f => console.log(`   ${f}`));
    console.log("   修法：讓 .topbar-right 自己成為橫向捲動區（overflow-x:auto + min-width:0 +");
    console.log("         flex 可縮），不要靠「把新元素藏起來」—— 下一顆按鈕又會把它推出去。");
    return 1;
  }
  console.log("★ 五種寬度下，topbar 每一顆可見按鈕都點得到");
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.log("✗ 測試本身出錯：" + e.message.slice(0, 120) + " → 測試不成立");
  process.exit(2);
});
