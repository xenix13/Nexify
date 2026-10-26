// Service worker Nexify : garde l'appli disponible hors connexion.
//  - Coquille de l'appli (HTML, CSS, JS, icônes) : préchargée à l'installation, servie depuis le cache.
//  - Pochettes (/api/img) : servies depuis le cache, avec un cache dédié aux titres téléchargés.
//  - Le reste de l'API n'est jamais mis en cache ici : l'appli gère ses données dans IndexedDB.
// BUILD et ASSETS sont injectés par le serveur (empreinte du dossier public).
const BUILD = '__BUILD__';
const ASSETS = __ASSETS__;
const SHELL = `nexify-shell-${BUILD}`;
const ART = 'nexify-art';
const ART_PINNED = 'nexify-art-pinned';
const ART_MAX = 1500;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    // nouvelle version : elle prend la main tout de suite (l'appli se recharge d'elle-même)
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('nexify-shell-') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'build') event.source?.postMessage({ build: BUILD });
});

async function trimArt() {
  const cache = await caches.open(ART);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - ART_MAX))) await cache.delete(k);
}

async function artwork(request) {
  const pinned = await caches.match(request, { cacheName: ART_PINNED });
  if (pinned) return pinned;
  const cache = await caches.open(ART);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) {
      await cache.put(request, res.clone());
      trimArt();
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/img') { event.respondWith(artwork(req)); return; }
  if (url.pathname.startsWith('/api/')) return;

  // navigation : toujours la coquille de l'appli (routage côté client)
  if (req.mode === 'navigate') {
    event.respondWith((async () => (await caches.match('/', { cacheName: SHELL })) || fetch(req))());
    return;
  }
  event.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: SHELL, ignoreSearch: true });
    return hit || fetch(req);
  })());
});
