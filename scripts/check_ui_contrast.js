#!/usr/bin/env node
/* 守門員：常用控制項的文字對比度不可低於 WCAG AA（2026-09-25）
 *
 * 背景：`--muted` 長期是 #787b86，對預設底 #1e222d 只有 **3.76**、對面板 #2a2e39 只有 3.21，
 *       而它用在**時框按鈕(12px)**、行情列的分頁/排序(10~11px) 這些每天都在點的小字上。
 *       根因是 `ui.js _autoTextContrast()` 給次要文字的門檻寫 **3.0** —— 那是 WCAG 給
 *       「大字」(≥18.66px，或粗體 ≥14px) 的門檻，套在小字上等於放行看不清的組合。
 * ★ 這個壞法**完全靜默**：顏色照樣顯示、零錯誤，只是使用者要瞇著眼看；
 *   而配色是會一直被調整的東西（系統配色、極簡模式、新元件），沒有守門員就會慢慢劣化回去。
 *
 * 判準：
 *   ・只驗**可互動控制項**（button / a / [role=button] 內）的文字 —— 裝飾性的分隔線、
 *     單位標籤刻意很淡，驗了會叫狼來了。
 *   ・門檻依 WCAG：粗體 ≥14px 或一般 ≥18.66px 算大字 → 3.0；其餘小字 → 4.5。
 *   ・排除 disabled 與 opacity < 0.55 的（那是「停用/次要狀態」的刻意表達）。
 *   ・背景要**往上疊算**到第一個不透明色（控制項自己常是 transparent）。
 * ⚠ 只驗**預設配色**：使用者自訂成低對比是他的選擇，`_autoTextContrast` 本來就會尊重。
 * ⚠ 回傳碼 2＝進不了場／掃到的控制項太少（測試不成立），不是通過。
 */
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--window-size=1680,950", "--incognito"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1680, height: 950, deviceScaleFactor: 1 });
  try {
    await p.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.evaluate(() => { try { localStorage.setItem("announceSeenVer", "__gk__");
      localStorage.removeItem("sysColors"); localStorage.removeItem("perfMode");
      sessionStorage.setItem("landingDismissedAt", String(Date.now())); } catch (e) {} });
    await p.goto(BASE, { waitUntil: "networkidle2", timeout: 90000 });
    await p.evaluate(() => { document.getElementById("announceOverlay")?.remove();
      if (window._landingEnter) window._landingEnter(); });
    await p.waitForFunction(() => typeof ohlcvData !== "undefined" && ohlcvData.length > 50, { timeout: 90000 });
    await sleep(7000);

    const res = await p.evaluate(() => {
      const px = c => { const m = String(c).match(/[\d.]+/g) || [0,0,0,1];
        return { r:+m[0], g:+m[1], b:+m[2], a: m[3] === undefined ? 1 : +m[3] }; };
      const lin = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
      const L = c => 0.2126*lin(c.r) + 0.7152*lin(c.g) + 0.0722*lin(c.b);
      const over = (f, bg) => ({ r: f.r*f.a + bg.r*(1-f.a), g: f.g*f.a + bg.g*(1-f.a), b: f.b*f.a + bg.b*(1-f.a), a: 1 });
      const ratio = (f, bg) => { const l1 = L(f), l2 = L(bg);
        return +(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))).toFixed(2); };
      const bgOf = e => { let n = e, acc = null;
        while (n && n !== document.documentElement) {
          const c = px(getComputedStyle(n).backgroundColor);
          if (c.a > 0) acc = acc ? over(acc, c) : c;
          if (acc && acc.a >= 0.99) break;
          n = n.parentElement; }
        return acc || { r:30, g:34, b:45, a:1 }; };
      const visible = e => { const r = e.getBoundingClientRect();
        return r.width > 3 && r.height > 3 && e.offsetParent !== null
               && getComputedStyle(e).visibility !== "hidden"; };
      const effOpacity = e => { let n = e, o = 1;
        while (n && n !== document.documentElement) { o *= parseFloat(getComputedStyle(n).opacity || "1"); n = n.parentElement; }
        return o; };

      const rows = [];
      const roots = [".topbar", ".symbol-bar", "#tickerPanel", ".ticker-panel"]
        .map(s => document.querySelector(s)).filter(Boolean);
      const seen = new Set();
      for (const root of roots) {
        for (const ctl of root.querySelectorAll('button, a, [role="button"]')) {
          if (!visible(ctl) || ctl.disabled) continue;
          if (effOpacity(ctl) < 0.55) continue;
          // 控制項自己或其子節點上的直接文字
          const nodes = [ctl, ...ctl.querySelectorAll("*")];
          for (const e of nodes) {
            const txt = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
            if (!txt || txt.length > 24) continue;
            if (!visible(e)) continue;
            const cs = getComputedStyle(e);
            const fg = px(cs.color); if (fg.a === 0) continue;
            const bg = bgOf(e);
            const cr = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
            const fs = parseFloat(cs.fontSize);
            const w = parseInt(cs.fontWeight, 10) || 400;
            const big = fs >= 18.66 || (w >= 700 && fs >= 14);
            const need = big ? 3.0 : 4.5;
            const key = txt + "|" + cs.color + "|" + fs;
            if (seen.has(key)) continue; seen.add(key);
            rows.push({ txt: txt.slice(0,16), cr, fs, need, big, color: cs.color,
                        where: (root.className || root.id || "").toString().split(" ")[0].slice(0,14) });
          }
        }
      }
      return rows;
    });

    if (res.length < 12) {
      console.log(`✗ 只掃到 ${res.length} 個控制項文字 → 測試不成立（選擇器或進場壞了）`);
      await b.close(); process.exit(2);
    }
    const bad = res.filter(r => r.cr < r.need).sort((a,b) => a.cr - b.cr);
    console.log(`   掃描 ${res.length} 個可互動控制項的文字（門檻：小字 4.5、大字 3.0）`);
    const worst = [...res].sort((a,b) => a.cr - b.cr).slice(0, 5);
    console.log("   對比度最低的 5 個：");
    for (const r of worst)
      console.log(`     ${String(r.cr).padStart(5)} / 需 ${r.need}　${String(r.fs).padStart(4)}px  ${r.where.padEnd(13)}「${r.txt}」`);
    await b.close();
    if (bad.length) {
      console.log(`\n✗ 有 ${bad.length} 個控制項文字低於門檻：`);
      for (const r of bad.slice(0, 12))
        console.log(`   ${r.cr} < ${r.need}　${r.fs}px ${r.big ? "(大字)" : "(小字)"}　${r.where}「${r.txt}」　${r.color}`);
      process.exit(1);
    }
    console.log("\n★ 上方列／符號列／行情列的可互動文字全部達 WCAG AA");
    process.exit(0);
  } catch (e) {
    console.log("✗ 測試本身出錯：" + e.message + " → 測試不成立");
    await b.close(); process.exit(2);
  }
})();
