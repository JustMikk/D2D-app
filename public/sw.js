// Canvass service worker. Plain JavaScript, no build step.
//
// Offline rules (PRD REP-3, REP-7; backend spec §1):
//  - The app's own API is never cached here: the app keeps its data and an outbox in IndexedDB.
//  - Built assets (/_next/static, icons) are immutable, so they are cached on first use and served from the cache.
//  - The Today page is network-first with a 4 second timeout, falling back to the last copy, so a rep with
//    poor signal still gets the app in about a second.
//  - Map tiles are cached (cache-first, newest 800 kept) so the route map works with no signal.
//  - Push notifications show a notification and open the app on tap.

const VERSION = "v1";
const STATIC = `canvass-static-${VERSION}`;
const PAGES = `canvass-pages-${VERSION}`;
const TILES = `canvass-tiles-${VERSION}`;
const TILE_HOSTS = ["tiles.openfreemap.org"];
const SHELL = "/today";
const MAX_TILES = 800;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("canvass-") && ![STATIC, PAGES, TILES].includes(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

const isImmutable = (url) => url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/");

async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    await cache.put(request, response.clone());
    if (max) trim(cache, max);
  }
  return response;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

const offlinePage = () =>
  new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvass</title>' +
      '<body style="font-family:system-ui;padding:24px;line-height:1.5"><h1>You\'re offline</h1>' +
      "<p>Open Canvass once with a connection to use it offline. Anything you've logged is saved on this phone and will sync later.</p>",
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function networkFirstShell(request, url) {
  const cache = await caches.open(PAGES);
  // The home page redirects to Today, so both share one cached copy of Today.
  const key = new Request(url.origin + SHELL);
  try {
    const response = await fetchWithTimeout(request, 4000);
    // Only a real Today page is kept: not a redirect to sign-in, and not an error.
    if (url.pathname === SHELL && response.ok && !response.redirected) await cache.put(key, response.clone());
    return response;
  } catch {
    return (await cache.match(key)) || offlinePage();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, TILES, MAX_TILES).catch(() => Response.error()));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (isImmutable(url)) {
    event.respondWith(cacheFirst(request, STATIC).catch(() => Response.error()));
    return;
  }
  if (request.mode === "navigate" && (url.pathname === SHELL || url.pathname === "/")) {
    event.respondWith(networkFirstShell(request, url));
  }
});

// The page asks the worker to keep the files it just loaded, so the app also opens offline the very first
// time it was visited (before this worker was controlling the page).
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "WARM" && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const statics = await caches.open(STATIC);
        const pages = await caches.open(PAGES);
        for (const raw of data.urls) {
          try {
            const url = new URL(raw, self.location.origin);
            if (url.origin !== self.location.origin) continue;
            if (isImmutable(url)) {
              if (!(await statics.match(url.href))) await statics.add(url.href);
            } else if (url.pathname === SHELL) {
              const response = await fetch(url.href, { credentials: "same-origin" });
              if (response.ok && !response.redirected) await pages.put(new Request(url.origin + SHELL), response);
            }
          } catch {
            // A file that cannot be fetched now is simply not cached.
          }
        }
      })(),
    );
  }
  if (data.type === "CLEAR") {
    // On sign-out: the cached Today page belongs to the person who just left.
    event.waitUntil(caches.delete(PAGES));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Canvass", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || SHELL },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SHELL;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
