/* 守門員：盈虧比工具（longpos/shortpos）的六條行為。需本機服務跑著；約 60 秒。
 *
 * 2026-09-21 使用者：「盈虧比不好用」。實測抓到三個結構性缺陷，這支把它們釘住 ——
 *  ①★★ **整個盒子搬不動**：`_drawingHitPart` 取「離哪條線最近」且**沒有距離門檻**
 *     → 色塊內每一點都被 entry/tp/sl 瓜分，永遠回某條線、從不回 "move"。
 *     實測從色塊中間往下拖 48px：只有停利線被拉走，**RR 1:1 → 1:0.31**。
 *     想平移卻在拉線，而且畫面上沒有任何錯誤——只是你的盈虧比被拖爛了。
 *  ② 建立時第二點的語意會翻轉（點上面＝停利、點下面＝停損），另一邊鏡射成 1:1。
 *     現在固定＝**停損**，停利照 RR_DEFAULT 放，方向由停損在哪一邊決定。
 *  ③ 盒子上只有 `1 : x.xx`，看不到風險/報酬各是幾 %。
 *
 * 判準都是**真的用滑鼠操作**再問 `drawings` 的內容，不看程式碼：
 *   ①做多工具+停損在下 → longpos、RR=2　②做多工具+停損在上 → 自動 shortpos
 *   ③色塊空白處拖曳 → 三條線位移相同且 RR 不變　④靠近線才拉線、離線遠＝move
 *   ⑤風險/報酬% 有產生
 *   ⑥拖進場線 → **上下停利停損釘住不動**、只有進場動、RR 跟著變；拖過頭要被夾在兩線之間
 *     （2026-09-21 使用者：「我要能固定上下止盈止損線，能調整中間進場線」——
 *      壓力位當停利、支撐位當停損都已經在圖上了，剩下的問題是「進場放哪裡划算」。）
 * ⚠ 判準要問**位移量與 RR**，不是「有沒有動」：拉單線時也「有東西在動」。
 * ⚠⚠ ⑥b（夾限）**每次按下前都要重新量進場線的螢幕位置**：⑥ 已經把它移走了，
 *    沿用舊座標會落在線外 >_POS_HIT → 判成 move ＝整盒平移，夾限根本沒被測到
 *    而 `entry > sl` 照樣成立＝**假通過**（我第一版就是，SL 跟著變了才看出來）。
 * ⚠ 一律用假帳號名（見 memory feedback_never-use-real-account-in-tests）。
 * ⚠ 回傳碼 2＝進不了場/開不了瀏覽器（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8000";
const FAKE_ACCT = "__gk_rr_test__";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=1440,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on("pageerror", e => errs.push(String(e).slice(0, 140)));
  const ev = src => page.evaluate(src);
  const bad = [];

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

  const rect = await page.evaluate(() => {
    const r = document.getElementById("mainChart").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  // ⚠ 不要叫 renderAll（這情境下它會拋錯，是測試腳本的問題不是產品的）：只清陣列，
  //   下一次互動自然會重畫；判準本來就是直接讀 drawings。
  const clearAll = () => ev(`(() => { drawings.length = 0; selectedId = null; return 1; })()`);
  const last = () => ev(`(() => {
    const d = drawings[drawings.length - 1];
    return d ? { type: d.type, entry: d.p1.price, tp: d.tp, sl: d.sl } : null;
  })()`);

  const make = async (tool, ex, ey, sx, sy) => {
    await clearAll();
    await page.evaluate(t => document.querySelector(`[data-tool="${t}"]`).click(), tool);
    await sleep(250);
    await page.mouse.click(ex, ey); await sleep(220);
    await page.mouse.click(sx, sy); await sleep(450);
    return last();
  };

  const cx = Math.round(rect.x + rect.w * 0.35);
  const cy = Math.round(rect.y + rect.h * 0.45);

  // ① 做多工具，停損點在下面
  let d = await make("longpos", cx, cy, cx + 90, cy + 60);
  let rr = (d.tp - d.entry) / (d.entry - d.sl);
  console.log(`① 做多工具・停損點在下方 → type=${d.type}  RR=1:${rr.toFixed(2)}`);
  console.log(`   entry ${d.entry.toFixed(1)}  SL ${d.sl.toFixed(1)}(=第二點)  TP ${d.tp.toFixed(1)}`);
  if (d.type !== "longpos") bad.push(`停損在下方卻做成 ${d.type}`);
  if (Math.abs(rr - 2) > 0.02) bad.push(`預設 RR 應為 2，實得 ${rr.toFixed(2)}`);
  if (!(d.sl < d.entry && d.tp > d.entry)) bad.push("做多的 SL/TP 站錯邊");

  // ② 做多工具，但停損點在上面 → 應自動成做空
  d = await make("longpos", cx, cy, cx + 90, cy - 60);
  rr = (d.entry - d.tp) / (d.sl - d.entry);
  console.log(`\n② 做多工具・停損點在上方 → type=${d.type}  RR=1:${rr.toFixed(2)}`);
  if (d.type !== "shortpos") bad.push(`停損在上方應自動成 shortpos，實得 ${d.type}`);
  if (!(d.sl > d.entry && d.tp < d.entry)) bad.push("自動轉做空後 SL/TP 站錯邊");

  // ③ 重建一張做多，測「色塊空白處拖曳＝整體搬移」
  d = await make("longpos", cx, cy, cx + 90, cy + 60);
  const before = { ...d };
  const rrBefore = (d.tp - d.entry) / (d.entry - d.sl);
  await page.mouse.click(cx + 20, cy); await sleep(350);     // 選取
  const grab = await ev(`(() => {
    const d = drawings[drawings.length - 1];
    const ey = candleSeries.priceToCoordinate(d.p1.price);
    const ty = candleSeries.priceToCoordinate(d.tp);
    const r = document.getElementById("mainChart").getBoundingClientRect();
    return { x: r.x + _timeToX(d.p1.time) + 40, y: r.y + (ey + ty) / 2 };
  })()`);
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(grab.x, grab.y + i * 6); await sleep(30); }
  await page.mouse.up(); await sleep(400);
  const after = await last();
  const dE = after.entry - before.entry, dT = after.tp - before.tp, dS = after.sl - before.sl;
  const rrAfter = (after.tp - after.entry) / (after.entry - after.sl);
  console.log(`\n③ 從色塊空白處往下拖 48px（整體搬移）：`);
  console.log(`   entry ${dE.toFixed(1)}  TP ${dT.toFixed(1)}  SL ${dS.toFixed(1)}   RR 1:${rrBefore.toFixed(2)} → 1:${rrAfter.toFixed(2)}`);
  const moved = Math.abs(dE) > 1;
  const together = moved && Math.abs(dT - dE) < Math.abs(dE) * 0.02 && Math.abs(dS - dE) < Math.abs(dE) * 0.02;
  if (!moved) bad.push("色塊空白處拖曳沒有移動任何東西");
  else if (!together) bad.push(`三條線沒有一起走（entry ${dE.toFixed(1)} / TP ${dT.toFixed(1)} / SL ${dS.toFixed(1)}）`);
  if (Math.abs(rrAfter - rrBefore) > 0.02) bad.push(`整體搬移後 RR 變了（${rrBefore.toFixed(2)} → ${rrAfter.toFixed(2)}）`);

  // ④ 命中判定：靠近線→拉線，離線遠→move
  const parts = await ev(`(() => {
    const d = drawings[drawings.length - 1];
    const ey = candleSeries.priceToCoordinate(d.p1.price);
    const ty = candleSeries.priceToCoordinate(d.tp);
    const sy = candleSeries.priceToCoordinate(d.sl);
    const ex = _timeToX(d.p1.time);
    return [["停利線上", ty], ["進場線上", ey], ["停損線上", sy],
            ["獲利區中間", (ty+ey)/2], ["風險區中間", (ey+sy)/2]]
      .map(([n, yy]) => [n, _drawingHitPart(d, ex + 40, yy)]);
  })()`);
  console.log(`\n④ 按在各處會拖到什麼：`);
  parts.forEach(([n, p]) => console.log(`   ${n.padEnd(12)} → ${p}`));
  const want = { "停利線上": "tp", "進場線上": "entry", "停損線上": "sl",
                 "獲利區中間": "move", "風險區中間": "move" };
  parts.forEach(([n, p]) => { if (want[n] !== p) bad.push(`「${n}」應為 ${want[n]}，實得 ${p}`); });

  // ⑤ 風險/報酬% 文字
  const pct = await ev(`_posPctTxt(drawings[drawings.length - 1])`);
  console.log(`\n⑤ 盒子上的第二行小字：「${pct}」`);
  if (!/報酬.*%.*風險.*%/.test(pct)) bad.push(`風險/報酬% 沒產生（得到「${pct}」）`);

  // ⑥ 拖「進場線」→ 上下停利停損釘住不動，只有進場動（使用者：固定上下、調中間）
  d = await make("longpos", cx, cy, cx + 90, cy + 60);
  const b6 = { ...d };
  const rr6a = (d.tp - d.entry) / (d.entry - d.sl);
  await page.mouse.click(cx + 20, cy); await sleep(350);
  const eLine = await ev(`(() => {
    const d = drawings[drawings.length - 1];
    const r = document.getElementById("mainChart").getBoundingClientRect();
    return { x: r.x + _timeToX(d.p1.time) + 40,
             y: r.y + candleSeries.priceToCoordinate(d.p1.price) };
  })()`);
  await page.mouse.move(eLine.x, eLine.y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(eLine.x, eLine.y + i * 5); await sleep(30); }
  await page.mouse.up(); await sleep(400);
  const a6 = await last();
  const rr6b = (a6.tp - a6.entry) / (a6.entry - a6.sl);
  console.log(`\n⑥ 拖「進場線」往下 30px（上下應釘住）：`);
  console.log(`   entry ${(a6.entry - b6.entry).toFixed(1)}  TP ${(a6.tp - b6.tp).toFixed(1)}  SL ${(a6.sl - b6.sl).toFixed(1)}`);
  console.log(`   RR 1:${rr6a.toFixed(2)} → 1:${rr6b.toFixed(2)}（進場往停損靠 → RR 應變大）`);
  if (Math.abs(a6.tp - b6.tp) > 1e-6) bad.push(`拖進場線時停利跟著跑了（${(a6.tp - b6.tp).toFixed(2)}）`);
  if (Math.abs(a6.sl - b6.sl) > 1e-6) bad.push(`拖進場線時停損跟著跑了（${(a6.sl - b6.sl).toFixed(2)}）`);
  if (!(a6.entry < b6.entry - 1)) bad.push(`拖進場線時進場沒往下動（${(a6.entry - b6.entry).toFixed(2)}）`);
  if (!(rr6b > rr6a + 0.05)) bad.push(`進場往停損靠，RR 應變大（${rr6a.toFixed(2)} → ${rr6b.toFixed(2)}）`);

  // ⑥b 進場不可以被拖到停損之外（風險會變成負的）
  // ⚠ 一定要**重新量**進場線的螢幕位置：⑥ 已經把它往下移了 30px，沿用舊座標會落在
  //   線外 8px 以上 → 判成 move ＝整盒平移，夾限根本沒被測到（`entry > sl` 會假通過）。
  const eLine2 = await ev(`(() => {
    const d = drawings[drawings.length - 1];
    const r = document.getElementById("mainChart").getBoundingClientRect();
    return { x: r.x + _timeToX(d.p1.time) + 40,
             y: r.y + candleSeries.priceToCoordinate(d.p1.price) };
  })()`);
  const slBefore = a6.sl, tpBefore = a6.tp;
  await page.mouse.move(eLine2.x, eLine2.y); await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(eLine2.x, eLine2.y + i * 12); await sleep(12); }
  await page.mouse.up(); await sleep(400);
  const a6c = await last();
  console.log(`   用力往下拖過頭 480px → entry ${a6c.entry.toFixed(1)}  SL ${a6c.sl.toFixed(1)}  TP ${a6c.tp.toFixed(1)}`);
  if (Math.abs(a6c.sl - slBefore) > 1e-6 || Math.abs(a6c.tp - tpBefore) > 1e-6)
    bad.push(`拖過頭時上下線沒釘住（SL ${(a6c.sl - slBefore).toFixed(2)} / TP ${(a6c.tp - tpBefore).toFixed(2)}）`);
  if (!(a6c.entry > a6c.sl)) bad.push(`進場被拖到停損之外（entry ${a6c.entry.toFixed(1)} ≤ SL ${a6c.sl.toFixed(1)}）＝風險變負的`);
  if (!(a6c.entry < a6c.tp)) bad.push(`進場被拖到停利之外（entry ${a6c.entry.toFixed(1)} ≥ TP ${a6c.tp.toFixed(1)}）`);

  if (errs.length) bad.push(`JS 錯誤 ${errs.length}：${errs[0]}`);
  console.log(bad.length ? "\n✗ " + bad.join("\n✗ ") : "\n★ 盈虧比六項全部符合預期（含「上下釘住、只動進場」）");
  await browser.close();
  process.exit(bad.length ? 1 : 0);
})();
