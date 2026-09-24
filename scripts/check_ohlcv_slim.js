/* 守門員：/api/ohlcv 的「副圖指標瘦身」三條。需本機服務跑著；約 40 秒。
 *
 * 2026-09-24 量出來的現況：KDJ / RSI / MACD 三個副圖**預設是 display:none、0×0**
 * （全新造訪時 `collapsedPanes` 是 `{}`＝這是預設，不是使用者收起來的），
 * 而回應裡 8 個只給它們用的欄位（rsi_14 / rsi_7 / macd·signal·hist / kdj_k·d·j）
 * 佔整包 **brotli 後 26.11 → 12.05 KB＝54%**。
 * 前端已經用 `indicators: !_subchartsHidden()` 告訴後端不要送 —— **但這件事沒有任何測試守著**。
 * ★ 它壞掉的形狀是最毒的那種：圖表完全正常、零錯誤，只是**每次載入圖表都多下載一倍**，
 *   而 `/api/ohlcv` 不只冷載會打，**每次換標的、每次換時框都打一次**。
 *
 * 判準（一律問實際的請求與回應，不看程式碼）：
 *   ① 後端要照做：`indicators:false` → 剛好少掉那 8 個欄位
 *   ②★★ `bb_upper/bb_middle/bb_lower` **必須留著**：布林通道畫在**主圖**上、
 *      實測預設 `visible=true`（1132 點）—— 跟三個副圖不同類，一起砍掉就是主圖少三條線。
 *   ③ 前端開機真的有送 `indicators:false`（攔真實請求，不是讀原始碼）
 *   ④ 沒帶旗標時後端**預設回完整版**：舊分頁／舊版 JS 讀不懂瘦身格式，
 *      預設必須是舊行為（claude.md 守門員之十六的教訓：前端宣告能力、後端預設舊格式）。
 * ⚠ 回傳碼 2＝服務沒跑／進不了場（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8000";
const SUB = ["rsi_14", "rsi_7", "macd", "macd_signal", "macd_hist", "kdj_k", "kdj_d", "kdj_j"];
const BB = ["bb_upper", "bb_middle", "bb_lower"];
const CORE = ["time", "open", "high", "low", "close", "volume"];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(extra) {
  const r = await fetch(BASE + "/api/ohlcv", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "BTC/USDT.P", timeframe: "1h",
                           market: "crypto", exchange: "binance", ...extra }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.data && j.data.length > 50) ? j.data : null;
}

(async () => {
  const bad = [];
  let rowsSlim, rowsFull, rowsDefault;
  try {
    rowsSlim = await ask({ indicators: false });
    rowsFull = await ask({ indicators: true });
    rowsDefault = await ask({});
  } catch (e) {
    console.error("⚠ 測試不成立：打不到 /api/ohlcv（服務沒跑？）" + e.message); process.exit(2);
  }
  if (!rowsSlim || !rowsFull || !rowsDefault) {
    console.error("⚠ 測試不成立：/api/ohlcv 沒回足夠的 K 棒"); process.exit(2);
  }
  const keys = rs => new Set(Object.keys(rs[Math.floor(rs.length / 2)]));   // 取中間那根：頭幾根指標還沒算出來
  const kSlim = keys(rowsSlim), kFull = keys(rowsFull), kDef = keys(rowsDefault);

  const leaked = SUB.filter(f => kSlim.has(f));
  console.log(`① indicators:false 的欄位：${[...kSlim].length} 個　殘留的副圖欄位：${leaked.length}（應為 0）`);
  if (leaked.length) bad.push(`① 瘦身沒生效，還在送：${leaked.join(", ")}`);
  for (const f of CORE) if (!kSlim.has(f)) bad.push(`① 瘦身把核心欄位 ${f} 也砍掉了`);

  const lostBB = BB.filter(f => !kSlim.has(f));
  console.log(`② 布林三欄有沒有留著：${BB.length - lostBB.length}/3（應為 3）`);
  if (lostBB.length) bad.push(`②★ 布林被砍掉了：${lostBB.join(", ")} —— 它畫在主圖、預設就看得到`);

  const missFull = SUB.filter(f => !kFull.has(f));
  console.log(`   indicators:true 的欄位：${[...kFull].length} 個　缺的副圖欄位：${missFull.length}（應為 0）`);
  if (missFull.length) bad.push(`   要指標時卻沒送：${missFull.join(", ")}`);

  const missDef = SUB.filter(f => !kDef.has(f));
  console.log(`④ 沒帶旗標時的欄位：${[...kDef].length} 個（應與 indicators:true 相同＝舊行為）`);
  if (missDef.length) bad.push(`④ 沒帶旗標時就瘦身了 → 舊分頁/舊版 JS 會少掉 ${missDef.join(", ")}`);

  // ③ 前端開機真的有送 indicators:false
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
      args: ["--no-sandbox", "--window-size=1440,900", "--incognito"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    const sent = [];
    cdp.on("Network.requestWillBeSent", e => {
      if (!e.request.url.includes("/api/ohlcv")) return;
      try { sent.push(JSON.parse(e.request.postData || "{}").indicators); } catch (x) { sent.push("解析失敗"); }
    });
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 70000 });
    await page.evaluate(() => { sessionStorage.setItem("landingDismissedAt", String(Date.now()));
      if (window._landingEnter) window._landingEnter(); });
    await page.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 70000 });
    await sleep(2500);
    const hidden = await page.evaluate(() =>
      !!document.getElementById("chartsContainer")?.classList.contains("subcharts-hidden"));
    await browser.close(); browser = null;
    console.log(`③ 開機時副圖是收起來的：${hidden}　送出的 indicators 旗標：${JSON.stringify(sent)}`);
    if (!sent.length) { console.error("⚠ 測試不成立：開機期間沒攔到任何 /api/ohlcv"); process.exit(2); }
    if (!hidden) { console.error("⚠ 測試不成立：副圖沒有收起來（預設變了？）此時送 true 是對的"); process.exit(2); }
    if (sent.some(v => v !== false)) bad.push(`③ 副圖收起來了，前端卻還是要了指標：${JSON.stringify(sent)}`);
  } catch (e) {
    if (browser) await browser.close();
    console.error("⚠ 測試不成立：" + (e && e.message || e)); process.exit(2);
  }

  if (bad.length) { console.error("\n✗ 失敗：\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("\n✓ ohlcv 瘦身四項全過");
})();
