/* Elbe Radar – Service Worker
 * Strategie: Shell (HTML/CSS/JS/Leaflet) aus Cache, API-Calls immer live.
 * Version: muss bei jedem Deploy erhöht werden damit der SW sich aktualisiert.
 */
const CACHE   = 'elbe-radar-v0.8.1';
const SHELL   = [
  '/',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap',
];

/* ── Install: Shell cachen ─────────────────────────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: Alte Caches löschen ────────────────────────────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch-Strategie ───────────────────────────────────────────────────────── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-Calls, WebSockets, externe Fotos → immer live, kein Cache
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket') ||
      url.hostname === 'photos.marinetraffic.com' ||
      url.hostname === 'photos.vesseltracker.com') {
    return; // browser handles natively
  }

  // Tiles (OpenStreetMap/CartoDB) → Cache-first mit 7-Tage-Expiry
  if (url.hostname.includes('tile') ||
      url.hostname.includes('basemaps.cartocdn.com') ||
      url.hostname.includes('openstreetmap.org')) {
    e.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        const fresh = await fetch(e.request).catch(() => null);
        if (fresh && fresh.ok) cache.put(e.request, fresh.clone());
        return fresh || new Response('', { status: 503 });
      })
    );
    return;
  }

  // App-Shell → Cache-first, Hintergrund-Update
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request)
        .then(fresh => {
          if (fresh && fresh.ok && e.request.method === 'GET') {
            cache.put(e.request, fresh.clone());
          }
          return fresh;
        })
        .catch(() => null);
      return cached || await fetchPromise ||
             new Response('Offline – bitte App neu starten', { status: 503 });
    })
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ── Push Notifications ───────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  let data = { title: '🚢 Elbe Radar', body: 'Neue Benachrichtigung' };
  try { if (event.data) data = event.data.json(); } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || '🚢 Elbe Radar', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag:  data.tag || 'elbr',
      data: data.url ? { url: data.url } : {},
      vibrate: [200, 100, 200],
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.postMessage({ type: 'notification-click', url });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
