const CACHE_NAME = "tokyo-shadowing-mobile-v24-recording-progress";
const BASE_URL = new URL("./", self.location.href);
const APP_SHELL_PATHS = [
  "textbook-phone-ui.js?v=1",
  "mobile.html",
  "mobile.css?v=20260916-02",
  "mobile-package.js?v=20260915-02",
  "mobile.js?v=20260916-02",
  "mobile-player.html",
  "mobile-player.css?v=20260915-07",
  "mobile-player.css?v=20260915-09",
  "mobile.css?v=20260915-03",
  "mobile-player.js?v=20260917-01",
  "manifest.webmanifest",
  "favicon.svg",
  "mobile-textbook-library.html",
  "mobile-textbook-library.js?v=1",
  "mobile-textbook.html",
  "mobile-textbook-marks.html",
  "mobile-textbook-tags-manage.html",
  "mobile-package.js?v=20260924-01",
  "textbook-package.js?v=1",
  "textbook-offline.js?v=1",
  "textbook-transfer.js?v=1",
  "textbook.js?v=mobile-1",
  "textbook-tags.js?v=mobile-1",
  "textbook-marks.js?v=mobile-1",
  "textbook-marked-practice.js?v=mobile-1",
  "textbook.css?v=shared-voices-1",
  "textbook-tags.css?v=2",
  "textbook-mobile.css?v=1",
  "textbook-assets/lucide.js",
];
const APP_SHELL = APP_SHELL_PATHS.map((path) => new URL(path, BASE_URL).href);
const APP_SHELL_URLS = new Set(APP_SHELL);
const MOBILE_URL = new URL("mobile.html", BASE_URL);
const PLAYER_URL = new URL("mobile-player.html", BASE_URL);
const NAVIGATION_PATHS = new Set([MOBILE_URL.pathname, PLAYER_URL.pathname,
  ...APP_SHELL_PATHS.filter(path=>path.endsWith(".html")).map(path=>new URL(path,BASE_URL).pathname)]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("tokyo-shadowing-mobile-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
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
          if(!response.ok)throw new Error("页面更新失败");
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
