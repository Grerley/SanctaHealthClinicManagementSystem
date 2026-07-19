/**
 * Service worker: caches the versioned application shell so the PWA opens and
 * renders after the internet is disconnected and the device restarts (SYN-001).
 * It does NOT cache API responses — clinical/finance data is always fetched
 * fresh and is served by the LAN edge, which stays reachable during an internet
 * outage. This SW gives the offline SHELL, never an uncontrolled data store.
 */
const SHELL_CACHE = 'sancta-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Never cache the API — always fresh, edge-served (no-store, like CLD-011).
  if (url.pathname.startsWith('/api/')) return;

  // App shell + built assets: cache-first, revalidate in the background.
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: false });
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200 && url.origin === self.location.origin) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached || cache.match('/'));
      return cached || network;
    }),
  );
});
