const CACHE_NAME = "tokyo-shadowing-mobile-v15";
const BASE_URL = new URL("./", self.location.href);
const APP_SHELL_PATHS = [
  "mobile.html",
  "mobile.css?v=20260915-03",
  "mobile-package.js?v=20260915-02",
  "mobile.js?v=20260915-03",
  "mobile-player.html",
  "mobile-player.css?v=20260915-09",
  "mobile-player.js?v=20260915-09",
  "manifest.webmanifest",
  "favicon.svg",
];
const APP_SHELL = APP_SHELL_PATHS.map((path) => new URL(path, BASE_URL).href);
const APP_SHELL_URLS = new Set(APP_SHELL);
const MOBILE_URL = new URL("mobile.html", BASE_URL);
const PLAYER_URL = new URL("mobile-player.html", BASE_URL);
const NAVIGATION_PATHS = new Set([MOBILE_URL.pathname, PLAYER_URL.pathname]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && NAVIGATION_PATHS.has(url.pathname)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request, { ignoreSearch: true })
          .then((response) => response || caches.match(MOBILE_URL.href))),
    );
    return;
  }
  if (APP_SHELL_URLS.has(url.href)) {
    event.respondWith(caches.match(event.request).then((response) => response || fetch(event.request)));
  }
});
