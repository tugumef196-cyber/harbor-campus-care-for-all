const CACHE_NAME = "harbor-shell-v2";
const STATIC_URLS = [
  "/manifest.webmanifest",
  "/icons/harbor.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const page = await fetch("/", { cache: "reload" });
      if (!page.ok) throw new Error(`App shell returned ${page.status}.`);
      const html = await page.clone().text();
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
        .map((match) => new URL(match[1], self.location.origin))
        .filter((url) => url.origin === self.location.origin)
        .map((url) => url.pathname);
      const cache = await caches.open(CACHE_NAME);
      await cache.put("/", page);
      await cache.addAll([...STATIC_URLS, ...assets]);
      await self.skipWaiting();
    } catch (error) {
      console.error("Could not cache the Harbor app shell.", error);
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("harbor-shell-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        const cachedPage = await caches.match("/");
        if (cachedPage) return cachedPage;
        return new Response("Harbor needs an internet connection for its first visit.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })());
    return;
  }

  if (!url.pathname.startsWith("/assets/") && !url.pathname.startsWith("/icons/")
    && url.pathname !== "/manifest.webmanifest" && url.pathname !== "/styles.css" && url.pathname !== "/app.js") return;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
