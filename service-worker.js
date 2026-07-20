// SyncPad – service-worker.js
//
// Bumps cache version any time a precached asset changes. Every fetch handler
// path either returns a real Response (via event.respondWith) or passes
// through without calling respondWith. All Supabase traffic is bypassed.
//
// IMPORTANT: do NOT cache Supabase REST, Realtime, Auth, or Storage URLs.
// Cross-origin API requests pass through directly.

const CACHE_VERSION = 'syncpad-v18';
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

const PRECACHE_ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/manifest.json`,
  `${BASE}/styles/style.css`,
  `${BASE}/src/app.js`,
  `${BASE}/src/ui.js`,
  `${BASE}/src/sync.js`,
  `${BASE}/src/rooms.js`,
  `${BASE}/src/live-broadcast.js`,
  `${BASE}/src/presence.js`,
  `${BASE}/src/files.js`,
  `${BASE}/src/file-preview.js`,
  `${BASE}/src/settings.js`,
  `${BASE}/src/encryption.js`,
  `${BASE}/src/admin.js`,
  `${BASE}/src/offline.js`,
  `${BASE}/src/supabase.js`,
  `${BASE}/src/utils.js`,
  `${BASE}/src/markdown.js`,
  `${BASE}/src/templates.js`,
  `${BASE}/src/permissions.js`,
  `${BASE}/src/theme.js`,
  `${BASE}/src/icons.js`,
  `${BASE}/src/shortcuts.js`,
  `${BASE}/assets/icon-192.png`,
  `${BASE}/assets/icon-512.png`,
];

// ── Install: precache core assets (tolerant of individual misses) ──────────

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(
      PRECACHE_ASSETS.map((url) =>
        cache.add(url).catch(() => {
          // One missing asset must not block install.
          // (e.g. an optional source file that's not yet deployed)
        })
      )
    );
  })());
});

// ── Activate: prune old caches, take control ───────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── Fetch: bypass Supabase + cross-origin, network-first for same-origin ──

function _isSupabase(urlString) {
  try {
    const u = new URL(urlString);
    return u.hostname.endsWith('.supabase.co')
        || u.hostname.endsWith('.supabase.in')
        || u.hostname.endsWith('.supabase.io');
  } catch { return false; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET. POST/PUT/PATCH/DELETE/OPTIONS pass through to the network
  // by NOT calling respondWith.
  if (req.method !== 'GET') return;

  const url = req.url;

  // Skip Supabase entirely (REST, Realtime/WebSocket, Storage, Auth).
  if (_isSupabase(url)) return;

  // Skip all cross-origin requests (CDN scripts, fonts, third-party APIs).
  // We don't cache them; let the browser/CDN handle it.
  if (!url.startsWith(self.location.origin)) return;

  // SPA navigation fallback: serve index.html if offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match(`${BASE}/index.html`);
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Same-origin assets: network-first with cache fallback.
  event.respondWith((async () => {
    try {
      const networkResponse = await fetch(req);
      if (networkResponse && networkResponse.ok) {
        const clone = networkResponse.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return networkResponse;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});

// ── Messages: SKIP_WAITING for clean update transitions ────────────────────

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
