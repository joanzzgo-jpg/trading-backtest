/* 【重現工具,不是守門員】`node scripts/repro_jank_deep_history.js`（需本機服務跑著,約 60 秒）
   用途：重現使用者 2026-10-25 回報的「用起來卡卡的」組態,給任何想修 `_bgApplyChunk`/`renderBB`
   的人一個**可驗證的環境** —— 那個 bug 只在常駐 2 萬根以上才出現,光把 barSpacing 設小重現不出來。
   回傳碼：0＝組態到位且已回報（結果用 `curl localhost:8000/api/_perf_report` 讀最後一筆）
           2＝到不了那個組態（測試不成立,不是「沒問題」）。
   環境變數：TARGET（預設 8000 根,見下）／SY（預設 ETH/USDT.P）／TF（預設 5m）／NOMIN=1（不檢查門檻）。

   ⚠⚠ **2026-11-01 更正門檻：預設從 20000 改成 8000 —— 2 萬根已經到不了了,那是刻意的。**
     `TRIM_MAX` 2026-10-25 從 40000 降到基準 15000 之後,閒置修剪會把常駐壓在
     「可見 ＋ 2×4500」≈ **9,501 根**（實測連拉三次最舊端：4,426 → 8,826 → 9,501 → 不再長）。
     舊門檻 20000 ⇒ 這支**必然**印「只累積到 9501 根 → 測試不成立(2)」＝永遠叫不出任何結論,
     而看到的人很容易誤讀成「組態到不了、所以沒問題」。
     ★ 這正是 claude.md 一再記的形狀：**優化縮短了某個 bug 的暴露窗口時,
       守著它的工具/守門員要跟著調**,否則它會從「抓得到」安靜退化成「永遠測試不成立」。

   實測基準（本機、1710×1035、副圖開、ETH 5m）：
     ・2026-10-25 改 TRIM_MAX **之前**：34,412 根／heap 406MB,bs 0.5 時 p95 81.9ms、max 287.8ms、
       >100ms 6 幀,layers：_bgApplyChunk 226.6ms/次、renderBB 32.5ms/次、renderDrawings 3.9ms×57。
     ・2026-11-01 **現況**：9,501 根,bs 2.8／可見 500 時 p50 16.6ms、p95 24.8、max 96.2、
       >50ms 7/279 幀、>100ms **0**,layers：_bgApplyChunk **53.4ms/次**（max 61.7）、
       renderBB 6.85、_rebuildTimeIndex 5.77、renderDrawings 1.29、_drawSessionOverlay 1.05。
     ★ 最大那兩幀（92.4／96.2ms）**我方圖層最大只有 61.7ms** → 差額在 LWC 渲染與瀏覽器繪製,
       不在我們的 JS 裡（claude.md「卡頓不在 JS 裡」第 N 次）。
     ★ `_bgApplyChunk` 仍是我方第一名,但 claude.md 已查證**沒有槓桿**：它的成本大頭是
       `setData`（原子、O(n)）,切更小塊只會呼叫更多次;而「錨點只餵頭尾兩點」被
       `render.js` 自己的註解否決（錨點必須維持全長,否則副圖的 logical index 會錯位）。

   【重現環境】使用者「用起來卡卡的」的那個組態：加密 5m、副圖開、常駐 2 萬根以上、barSpacing 0.5。
   ★ 累積根數走產品自己的觸發條件（charts.js:1863）：可見範圍 from<2000 且 to<n-300 → _bgLoadOlderBars(true),
     一次補到 SCROLL_BUDGET=10000 根 → 設兩三次就從 4.5k 長到 2 萬以上。
     （合成滾輪/拖曳重現不出來：拖不到左緣,而且滾輪在那個狀態下不動 —— 已失敗三次。）
   ★ 歸因用**產品自己的** `window._perfProbe(5)`,量完它自己 POST /api/_perf_report → 我們再 GET 回來讀。
     不自己造一份平行儀器（claude.md：判準一律問產品自己的函式）。 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TARGET = +(process.env.TARGET || 8000);   // 見檔頭：2 萬根在修剪生效後到不了,8000 才是現實的下限
(async () => {
  const b = await puppeteer.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:false, args:['--no-sandbox','--window-size=1710,1035'] });
  const p = (await b.pages())[0];
  await p.setViewport({ width:1710, height:1035 });
  await p.goto('http://127.0.0.1:8000/?s='+encodeURIComponent(process.env.SY||'ETH/USDT.P')+'&tf='+(process.env.TF||'5m')+'&m=crypto',
               { waitUntil:'domcontentloaded', timeout:60000 });
  await sleep(3500);
  await p.evaluate(()=>{ if(window._landingEnter) window._landingEnter(); });
  await sleep(1500);
  await p.evaluate(()=>{ const o=document.getElementById('announceOverlay'); if(o) o.remove(); });
  await p.evaluate(()=>{ const t=document.getElementById('subChartsToggle');
    const h=['kdjChart','rsiChart','macdChart'].map(id=>{const e=document.getElementById(id);return e?e.getBoundingClientRect().height:0;});
    if (h.every(x=>x<=0)&&t) t.click(); });
  await sleep(11000);
  const cfg = () => p.evaluate(`(()=>{ const ts=(typeof mainChart!=="undefined"&&mainChart)?mainChart.timeScale():null;
    const vr=ts?ts.getVisibleLogicalRange():null;
    return { bars:(typeof ohlcvData!=="undefined")?ohlcvData.length:-1,
             bs: ts?+ts.options().barSpacing.toFixed(2):-1, visible: vr?Math.round(vr.to-vr.from):-1,
             副圖: ['kdjChart','rsiChart','macdChart'].map(id=>{const e=document.getElementById(id);return e?Math.round(e.getBoundingClientRect().height):-1;}),
             heapMB:+(performance.memory?performance.memory.usedJSHeapSize/1048576:-1).toFixed(0) }; })()`);
  let c = await cfg();
  console.log('載入後:', JSON.stringify(c));
  if (c.副圖.some(x=>x<=0)) { console.log('✗ 副圖沒開 → 測試不成立(2)'); process.exit(2); }

  // ① 累積根數：把可見範圍設到最舊端,觸發產品自己的分頁補載
  for (let i=1;i<=10 && c.bars < TARGET;i++){
    await p.evaluate(`(()=>{ mainChart.timeScale().setVisibleLogicalRange({ from: 100, to: 600 }); })()`);
    await sleep(9000);
    const n = await cfg();
    console.log(`  第 ${i} 次拉到最舊端: ${n.bars} 根 (+${n.bars-c.bars})  heap=${n.heapMB}MB`);
    if (n.bars === c.bars && i>=3) { console.log('  ↑ 不再長了'); c=n; break; }
    c = n;
  }
  if (c.bars < TARGET) {
    if (process.env.NOMIN) console.log(`  （只累積到 ${c.bars} 根 < ${TARGET} —— NOMIN=1,當成修剪生效,繼續量）`);
    else { console.log(`✗ 只累積到 ${c.bars} 根 (<${TARGET}) → 測試不成立(2)`); process.exit(2); }
  }

  // ② 設成回報裡的縮放倍率
  await p.evaluate(`(()=>{ mainChart.timeScale().applyOptions({ barSpacing: 0.5 }); })()`);
  await sleep(6000);
  c = await cfg();
  console.log(`\n★ 組態已就位: ${JSON.stringify(c)}`);

  // ③ 用產品自己的探針量 5 秒,期間做滾輪縮放
  await p.evaluate(`(()=>{ window._perfProbe(5); })()`);
  const r = await p.evaluate(`(()=>{const x=document.getElementById('mainChart').getBoundingClientRect();
    return {x:x.x,y:x.y,w:x.width,h:x.height};})()`);
  const cx=Math.round(r.x+r.w*0.5), cy=Math.round(r.y+r.h*0.5);
  await p.mouse.move(cx,cy);
  for(let i=0;i<22;i++){ await p.mouse.wheel({deltaY:i%2?100:-100}); await sleep(55); }
  // 再拉一次最舊端,讓 _bgApplyChunk 落在量測窗內（那是最大的一筆）
  await p.evaluate(`(()=>{ mainChart.timeScale().setVisibleLogicalRange({ from: 100, to: 600 }); })()`);
  await sleep(4000);
  console.log('量測結束,組態:', JSON.stringify(await cfg()));
  process.exit(0);
})().catch(e=>{ console.log('✗ 測試自己爆掉 →(2)', e.message); process.exit(2); });
