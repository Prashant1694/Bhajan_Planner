// ============================================================
// Service Worker — Bhajan Planner PWA v6.2
// Single-DOM App Shell aware:
// - Cache-first for Google Fonts & Acoustic Tanpura samples
// - Network-first with cache fallback for CSS & JS (guarantees instant updates)
// - Cache-first for images & static assets
// - Network-first for HTML & App Shell fragments (never injects HTML offline page into fragment JSON/pane fetches)
// ============================================================

const CACHE_VERSION = "v6.5";
const CACHE_NAME = `bhajan-planner-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/offline.html",
  "/css/native.css?v=6.5",
  "/css/style.css?v=6.5",
  "/css/app-shell.css?v=6.5",
  "/css/dashboard-glass.css?v=6.5",
  "/css/loading.css?v=6.5",
  "/css/pwa.css?v=6.5",
  "/css/notifications.css?v=6.5",
  "/css/bulletin.css?v=6.5",
  "/css/tanpura.css?v=6.5",
  "/css/session-audio.css?v=6.5",
  "/js/native-ui.js?v=6.5",
  "/js/haptics.js?v=6.5",
  "/js/app-shell-router.js?v=6.5",
  "/js/script.js?v=6.5",
  "/js/loading.js?v=6.5",
  "/js/pwa.js?v=6.5",
  "/js/notifications.js?v=6.5",
  "/js/tanpura.js?v=6.5",
  "/js/session-audio-player.js?v=6.5",
  "/images/logo_birthday.png",
  "/images/logo.png",
  "/images/icons/icon-192x192.png",
  "/images/icons/icon-512x512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. Google Fonts: cache-first
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then(
          (cached) =>
            cached ||
            fetch(request).then((response) => {
              if (response.ok) cache.put(request, response.clone());
              return response;
            })
        )
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 2. App Shell Fragment Requests (X-App-Shell: 1): network-first, clean 503 on offline
  if (request.headers.get("X-App-Shell") === "1") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ offline: true, error: "Network offline" }), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          })
      )
    );
    return;
  }

  // 3. Acoustic Tanpura Drone Samples: cache-first for instant Mandir offline playback
  if (url.pathname.startsWith("/audio/tanpura/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request, { ignoreSearch: true }).then(
          (cached) =>
            cached ||
            fetch(request).then((response) => {
              if (response.ok && response.status === 200) {
                cache.put(request, response.clone());
              }
              return response;
            })
        )
      )
    );
    return;
  }

  // 4. Document Navigation: network-first with offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        try {
          const cachedFallback = await caches.match("/offline.html");
          if (cachedFallback) return cachedFallback;
        } catch (_) {}
        return new Response(
          '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bhajan Planner - Offline</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:56px 20px;background:#faf7f2;color:#1c1917;}button{padding:12px 24px;border:none;border-radius:999px;background:#c85a17;color:#fff;font-weight:700;font-size:15px;cursor:pointer;margin-top:20px;}</style></head><body><h2>Prashanti Satsang</h2><p>You appear to be offline. Please check your connection and try again.</p><button onclick="location.reload()">Retry Connection</button></body></html>',
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          }
        );
      })
    );
    return;
  }

  // 5. CSS & Scripts: Network-first with cache fallback (instant style & logic updates)
  if (request.destination === "style" || request.destination === "script") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(request);
          if (cached) return cached;
          const fallback = await cache.match(request, { ignoreSearch: true });
          if (fallback) return fallback;
          return new Response("/* Offline / asset unavailable */", {
            status: 200,
            headers: {
              "Content-Type":
                request.destination === "style" ? "text/css" : "application/javascript"
            }
          });
        })
    );
    return;
  }

  // 6. Static Images & Fonts: Cache-first
  if (request.destination === "image" || request.destination === "font") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cache.match(request, { ignoreSearch: true }));
      })
    );
    return;
  }

  // 7. APIs & other GETs: network-first
  event.respondWith(
    fetch(request).catch(async () => {
      try {
        const cached = await caches.match(request);
        if (cached) return cached;
      } catch (_) {}
      return new Response("", { status: 408, statusText: "Network timeout or offline" });
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.action === "skipWaiting") {
    self.skipWaiting();
  }
  if (event.data && event.data.action === "clearCache") {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});

self.addEventListener("push", (event) => {
  let data = { title: "Bhajan Planner", body: "You have a new notification", url: "/" };

  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    console.warn("[SW] Push data parse error:", e);
  }

  const options = {
    body: data.body || "",
    icon: data.icon || "/images/icons/icon-192x192.png",
    badge: data.badge || "/images/icons/icon-192x192.png",
    data: { url: data.url || "/" },
    vibrate: [200, 100, 200],
    tag: data.tag || "bhajan-planner-notification",
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(data.title || "Bhajan Planner", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          client.postMessage({ type: "BP_NAVIGATE", url });
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
