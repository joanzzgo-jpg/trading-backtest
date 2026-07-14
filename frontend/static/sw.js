/* AHH Trading service worker — 保守策略：只快取靜態資源，API/HTML 一律走網路。
 *
 * 設計重點（避免吃到舊資料）：
 *  - /api/*       → 不攔截（即時行情/勝率永遠走網路）
 *  - 導覽/HTML    → 不攔截（每次拿最新的 ?v= 資產版號）
 *  - /static/*、CDN → cache-first。靜態 URL 都帶 ?v=版號，改版即換 URL → 不會吃到舊檔。
 * 換快取策略時把 CACHE 版號 +1 即可讓舊快取在 activate 時清掉。
 */
const CACHE = "ahh-static-v19";  // v19:移除 unpkg CDN 快取(庫已全自架,同步 CSP 收緊)

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
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

  // 導覽(HTML)＝離線外殼：連得上**永遠走網路**（絕不吃舊頁），成功順手存一份；
  // 連不上（斷網/伺服器掛）→ 退回上次存的外殼 → 配合本機快照(IndexedDB)，
  // 斷網重開 App 也進得去、看得到最後一份圖（API 照樣失敗，行情不更新屬預期）。
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put("/__shell__", copy)).catch(() => {});
        }
        return resp;
      }).catch(() =>
        caches.match("/__shell__").then((hit) => hit || Response.error())
      )
    );
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
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      });
    })
  );
});
