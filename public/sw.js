// Service worker: makes the app installable and keeps the static shell available offline.
// It never caches pages or API responses: they depend on the signed-in user and can contain private keys.
const CACHE = 'cw-static-v1';
const PRECACHE = ['offline.html', 'style.css', 'theme.js', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const STATIC_DESTINATIONS = new Set(['style', 'script', 'image', 'font', 'manifest']);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/healthz') return;

  // Pages: always from the network (they need a session); a small offline page when there is no connection.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('offline.html')));
    return;
  }

  // Static files: network first so a new release shows up at once, cached copy when offline.
  if (STATIC_DESTINATIONS.has(request.destination) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(hit => hit || Response.error()))
    );
  }
});
