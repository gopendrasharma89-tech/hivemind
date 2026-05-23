// Hivemind Service Worker — offline-friendly cache for static assets
const VERSION = 'hm-v1.0.0';
const STATIC_ASSETS = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(STATIC_ASSETS).catch(() => null)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Always go to network for API + WebSocket
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // Network-first for HTML, cache-first for assets
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.svg')) {
    e.respondWith(
      caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, clone));
        return res;
      }))
    );
  }
});
