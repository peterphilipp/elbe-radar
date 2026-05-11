/* Elbe Radar – Service Worker
 * Strategie: Shell (HTML/CSS/JS/Leaflet) aus Cache, API-Calls immer live.
 * Version: muss bei jedem Deploy erhöht werden damit der SW sich aktualisiert.
 */
const CACHE   = 'elbe-radar-v0.5.1';
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
