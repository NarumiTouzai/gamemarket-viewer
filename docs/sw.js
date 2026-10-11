// 圏外でも使えるようにするための Service Worker。
//  - ページ本体（HTML）とブース一覧データ: 通信できれば最新を取りに行き、4秒で返らなければ保存した分を使う
//  - CSS・JS・アイコン: 保存した分をすぐ使い、裏で最新に入れ替える（版番号付きなので新しい版は別物として取りに行く）
//  - 公式サーバーの画像（地図・ブース画像）と QR コードのライブラリ: 一度取ったら保存した分を使う
const SHELL = "gm-shell-v1"; // ページ本体・CSS・JS・データ
const IMG = "gm-img-v1";     // 地図とブースの画像

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, IMG]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === "navigate" || url.pathname.endsWith("/booths.json")) e.respondWith(networkFirst(req, 4000));
    else e.respondWith(staleWhileRevalidate(req));
  } else if (url.hostname === "img.gamemarket.jp" || url.hostname === "cdnjs.cloudflare.com") {
    e.respondWith(cacheFirst(req));
  }
});

// 通信を優先。timeout ミリ秒たっても返らないときや失敗したときは保存した分を返す
async function networkFirst(req, timeout) {
  const cache = await caches.open(SHELL);
  const key = req.mode === "navigate" ? new URL("./", location).href : req.url.split("?")[0];
  const net = fetch(req).then(async (res) => {
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });
  const cached = await cache.match(key);
  if (!cached) return net;
  const timer = new Promise((r) => setTimeout(() => r(cached), timeout));
  return Promise.race([net.catch(() => cached), timer]);
}

// 保存した分をすぐ返し、裏で取り直す。同じファイルの古い版（?v= 違い）は消す
async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req);
  const net = fetch(req).then(async (res) => {
    if (res.ok) {
      const path = new URL(req.url).pathname;
      for (const k of await cache.keys()) {
        const u = new URL(k.url);
        if (u.pathname === path && k.url !== req.url) await cache.delete(k);
      }
      await cache.put(req, res.clone());
    }
    return res;
  }).catch(() => cached);
  return cached || net;
}

// 保存した分があればそれを使う（画像など、URL が変わらない限り中身も変わらないもの）
async function cacheFirst(req) {
  const cache = await caches.open(IMG);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") await cache.put(req, res.clone());
  return res;
}
