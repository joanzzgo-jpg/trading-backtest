// 守門員：切時框時，主圖不可殘留「上一個時框」的策略圖層。
//
// 用法：node scripts/check_tf_switch_layers.js [URL]（本機服務要跑著）
//
// 為什麼需要這支：使用者回報「切時框會冒出很多線條」。renderAll 為了修好「切換後標記消失」，
// 會用 _lastFVG* 這幾份快取把圖層重畫回來 —— 但切換當下它們裝的還是上一個時框的資料。
// 標記層看不出來（_has() 會過濾掉時間不存在於當下 K 棒的標記），但 FVG 逐筆止損/止盈**線**
// 沒有這層過濾（直接 timeToCoordinate），大時框的進場時間在小時框上找得到座標 → 一次冒出上百條。
// ⚠ 一般冒煙測試抓不到：它只驗「切完之後」的最終狀態，而這個 bug 活在「切換瞬間～新勝率回來」
//   那段窗口裡，最後會被正確資料蓋掉。這支專測那個窗口。
// ⚠ 進場唯一正解＝window._landingEnter()（點城門按鈕會被登入鎖擋，互動全打在城門頁上＝假測試）。

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--window-size=1400,900"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.setViewport({ width: 1400, height: 900 });
  let failed = 0;
  const ok   = (n, d) => console.log(`  ✓ ${n}  — ${d}`);
  const bad  = (n, d) => { failed++; console.log(`  ✗ ${n}  — ${d}`); };

  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(() => typeof window._landingEnter === "function", { timeout: 30000 });
  await page.evaluate(() => window._landingEnter());
  await sleep(2000);
  await page.evaluate(() => { document.querySelectorAll(".ann-ok,#annOkBtn").forEach(b => b.click()); });

  // 讀圖層狀態：_lastFVGTrades / _fvgTradeLines 都是 bundle 頂層 let → 全域詞法環境讀得到
  // ⚠ 判準必須看「內容」不能只看「條數」：切完之後本來就會有線（本機快照 _snapPaint 會把
  //   *這個* 時框上次的圖層秒畫回來，那是對的）。只有「畫的是上一個時框那一批」才是 bug。
  //   → 取內容指紋（筆數 + 頭尾進場時間），拿去跟切換前那一批比對。
  const stat = () => page.evaluate(`(() => {
    const g = n => { try { return eval(n); } catch (e) { return null; } };
    const lt = g("_lastFVGTrades"), fl = g("_fvgTradeLines");
    const sig = a => (a && a.length)
      ? a.length + ":" + (a[0].et != null ? a[0].et : "?") + ":" + (a[a.length-1].et != null ? a[a.length-1].et : "?")
      : "";
    return { tf: (typeof currentTF !== "undefined" ? currentTF : null),
             bars: (typeof ohlcvData !== "undefined" ? ohlcvData.length : 0),
             lastTrades: lt ? lt.length : -1,
             drawnLines: fl ? fl.length : -1,
             sig: sig(lt), drawnSig: sig(fl) };
  })()`);

  const switchTf = async tf => page.evaluate(t => {
    const b = document.querySelector(`.tf-btn[data-tf="${t}"]`);
    if (b) b.click(); return !!b;
  }, tf);

  // 找一個「這個時框有 FVG 逐筆交易線」的起點：沒有的話這個 bug 根本不會發生，測了也是假的
  let from = null;
  for (const tf of ["1h", "4h", "1d", "15m"]) {
    await switchTf(tf);
    await page.waitForFunction(`(() => { try { return _lastFVGTrades && _lastFVGTrades.length > 0; } catch(e){ return false; } })()`,
      { timeout: 45000 }).catch(() => {});
    const s = await stat();
    if (s.lastTrades > 0) { from = { tf, ...s }; break; }
  }
  if (!from) { console.log("✗ 找不到任何「有 FVG 交易線」的時框 → 測試不成立（不是通過）"); process.exit(2); }
  ok("起點時框有 FVG 交易線可殘留", `${from.tf}：${from.lastTrades} 筆、已畫 ${from.drawnLines} 條（指紋 ${from.drawnSig}）`);

  // 切到另一個時框，在「新勝率還沒回來」的窗口裡連續取樣
  const to = from.tf === "1d" ? "4h" : "1d";
  await switchTf(to);
  let hit = null, hitAt = 0;
  for (let i = 0; i < 14; i++) {           // 約 2.1 秒，涵蓋整個空窗
    const s = await stat();
    // 已經切到新時框了，畫出來的卻還是舊時框那一批 → 就是使用者看到的「很多線條」
    if (s.tf === to && s.drawnLines > 0 && s.drawnSig === from.drawnSig && !hit) { hit = s; hitAt = i * 150; }
    await sleep(150);
  }
  if (hit) bad("切時框途中沒有殘留上一個時框的線",
               `${from.tf}→${to} 第 ${hitAt}ms 畫的還是 ${from.tf} 那批 ${hit.drawnLines} 條（指紋 ${hit.drawnSig}）`);
  else ok("切時框途中沒有殘留上一個時框的線", `${from.tf}→${to} 全程沒出現舊指紋 ${from.drawnSig}`);

  // 新時框的資料回來後，該有的還是要有（別把「清乾淨」做成「永遠空白」）
  await page.waitForFunction(`(() => { try { return typeof _wrInFlight === "undefined" || !_wrInFlight; } catch(e){ return true; } })()`,
    { timeout: 45000 }).catch(() => {});
  await sleep(2500);
  const after = await stat();
  if (after.bars > 0) ok("新時框正常載入", `${after.tf}：${after.bars} 根、_lastFVGTrades=${after.lastTrades}`);
  else bad("新時框正常載入", "沒有 K 棒");

  // 切回原時框：快取命中路徑必須把圖層填回來（清除不能誤傷這條）
  await switchTf(from.tf);
  await sleep(3000);
  const back = await stat();
  if (back.lastTrades > 0) ok("切回原時框圖層有回來（沒被清除誤傷）", `${back.tf}：_lastFVGTrades=${back.lastTrades}`);
  else bad("切回原時框圖層有回來（沒被清除誤傷）", `${back.tf}：_lastFVGTrades=${back.lastTrades}（清過頭了）`);

  if (errors.length) bad("零 JS 錯誤", errors.slice(0, 5).join(" | "));
  else ok("零 JS 錯誤", "");

  await browser.close();
  console.log(failed ? `\n★ 失敗 ${failed} 項` : "\n★ 切時框圖層檢查全部通過");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("執行失敗:", e.message); process.exit(2); });
