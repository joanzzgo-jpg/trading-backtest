/* AHH Trading service worker — 保守策略：只快取靜態資源，API/HTML 一律走網路。
 *
 * 設計重點（避免吃到舊資料）：
 *  - /api/*       → 不攔截（即時行情/勝率永遠走網路）
 *  - 導覽/HTML    → 不攔截（每次拿最新的 ?v= 資產版號）
 *  - /static/*、CDN → cache-first。靜態 URL 都帶 ?v=版號，改版即換 URL → 不會吃到舊檔。
 * 換快取策略時把 CACHE 版號 +1 即可讓舊快取在 activate 時清掉。
 */
const CACHE = "ahh-static-v20";  // v20:靜態資源改「存新的就刪同檔舊版號」(見 _pruneOldVersions)
const SHELL = "/__shell__";      // 離線外殼(HTML)的快取鍵；導覽走 stale-while-revalidate(見 fetch)
// ⚠ 改導覽策略時**不要**動 CACHE 版號：一改名，activate 會把使用者已經存好的整包靜態資源
//   全部刪掉 → 下一次啟動反而要重抓 600KB+，跟「開得更快」的目的相反。

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    /* 先把外殼存起來：第一次造訪時 SW 還沒接管那次導覽，不補這一手的話「第二次啟動」
       仍然要等網路（要到第三次才秒開）。抓失敗就算了，下次導覽會補存。 */
    try {
      const cache = await caches.open(CACHE);
      if (!(await cache.match(SHELL))) {
        const r = await fetch("/", { cache: "reload" });
        if (r && r.status === 200) await cache.put(SHELL, r.clone());
      }
    } catch (_) {}
  })());
});

// ── Web Push：收到推播 → 顯示系統通知 ──────────────────────────
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {
    try { d = { title: "AHH Trading", body: e.data && e.data.text() }; } catch (_) {}
  }
  const title = d.title || "AHH Trading 訊號";
  const opts = {
    body: d.body || "",
    icon: "/static/img/icon-192.png",
    badge: "/static/img/icon-192.png",
    tag: d.tag || undefined,            // 同 tag 會取代舊通知，避免堆疊
    renotify: !!d.tag,
    data: d.data || {},                 // {symbol, market, exchange, tf}
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 點通知 → 聚焦既有分頁（帶標的資訊）或開新視窗
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const info = e.notification.data || {};
  const qs = info.symbol
    ? ("?notify_sym=" + encodeURIComponent(info.symbol) +
       "&notify_mkt=" + encodeURIComponent(info.market || "") +
       "&notify_exch=" + encodeURIComponent(info.exchange || ""))
    : "";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ("focus" in c) {
          if (info.symbol && "postMessage" in c) c.postMessage({ type: "notify-open", info });
          return c.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow("/" + qs) : null;
    })
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // manifest 一律走網路、永不快取：否則快取住舊 manifest 會害 PWA 模式（WCO/standalone）
  // 與圖示更新不到（Chrome 讀到 SW 回的舊 manifest → 一直維持舊安裝模式）。
  if (url.pathname === "/static/manifest.json") return;

  /* 導覽(HTML)＝離線外殼。**先端出上次那份、同時在背景抓新的**（stale-while-revalidate）。
   *
   * 2026-09-12 改：原本是「永遠走網路，連不上才退快取」。理由是要拿最新的 ?v= 資產版號 ——
   * 但代價是**每次打開 App 都要先等伺服器回 HTML 才畫得出第一個像素**。手機上這段是
   * 「開啟很慢、不像 app」的主因：行動網路 RTT 動輒 100~300ms，Railway 冷啟動更久，
   * 而這段時間畫面是全白的（靜態檔明明都在快取裡）。
   * 換成 SWR 之後：開 App＝直接用快取那份，0 網路等待；新版在背景抓好存起來，下一次啟動生效。
   *
   * 為什麼「晚一次啟動才換新版」是安全的：
   *  ・?v= 只是破快取用的網址參數，伺服器不看它 —— 舊網址照樣拿到現在的檔案內容。
   *  ・舊外殼要的資產都還在快取裡（新版資產要等新外殼上場才會被抓、才會觸發 _pruneOldVersions）。
   *  ・真的要立刻拿到新版：重新整理一次即可（第二次進來時快取裡已經是新的）。
   * 斷網時照樣退回這份外殼，配合本機快照(IndexedDB) 仍進得去、看得到最後一份圖。 */
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(SHELL);
      const net = fetch(req).then((resp) => {
        if (resp && resp.status === 200) cache.put(SHELL, resp.clone()).catch(() => {});
        return resp;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }     // 有存過 → 秒開，背景更新
      return (await net) || Response.error();        // 第一次（還沒存過）→ 只能等網路
    })());
    return;
  }

  // 只處理同源 /static/ 靜態資源；其餘（/api/）交給瀏覽器預設走網路。
  // （unpkg CDN 已移出快取白名單：庫全數自架同源，CSP 亦已封鎖外部腳本域。）
  const isStatic =
    url.origin === self.location.origin && url.pathname.startsWith("/static/");
  if (!isStatic) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        // 只快取成功回應
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) =>
            c.put(req, copy).then(() => _pruneOldVersions(c, url))
          ).catch(() => {});
        }
        return resp;
      });
    })
  );
});

// 存進新版本後，把「同一支檔案的其他 ?v=」清掉。
//
// 為什麼需要（2026-07-31 修）：這裡是 cache-first + 靠 ?v= 換 URL 破快取，但舊版號的條目
// 從來沒有人刪 —— 版號是 git hash+時間戳，**每次部署都會變** → 每部署一次就永久多存一整包
// app.bundle.js(≈420KB)＋style.min.css(≈195KB)＋所有改過的資產。實測重新載入後快取裡同時
// 躺著 4 個版本的 app.bundle.js。累積到瀏覽器配額上限時，整個來源的儲存(含 App 離線用的
// IndexedDB 快照)都可能被一起清掉 → 反而變成「離線就進不去」。
// 舊版號被刪掉後若真有人要（例如還開著的舊分頁），退回走網路即可，不影響正確性。
function _pruneOldVersions(cache, url) {
  return cache.keys().then((keys) => Promise.all(
    keys.filter((r) => {
      let u;
      try { u = new URL(r.url); } catch (_) { return false; }
      return u.origin === url.origin && u.pathname === url.pathname && u.search !== url.search;
    }).map((r) => cache.delete(r))
  )).catch(() => {});
}
