/* OSMP service worker — cache-first app shell so the UI loads instantly and
 * even works when the server is briefly unreachable. Audio streams get a
 * dedicated cache: full (non-Range) fetches are stored, and when the server
 * is down cached tracks are served so saved music keeps playing. */

const CACHE = 'osmp-shell-v19';
const AUDIO_CACHE = 'osmp-audio-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/base.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/player.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/js/player.js',
  '/js/actions.js',
  '/js/router.js',
  '/js/theme.js',
  '/js/lyrics.js',
  '/js/eq.js',
  '/js/visualizer.js',
  '/js/components/icons.js',
  '/js/components/toast.js',
  '/js/components/dialog.js',
  '/js/components/tracklist.js',
  '/js/views/home.js',
  '/js/views/search.js',
  '/js/views/library.js',
  '/js/views/playlist.js',
  '/js/views/smart.js',
  '/js/views/artist.js',
  '/js/views/import.js',
  '/js/views/radio.js',
  '/js/views/stats.js',
  '/js/views/history.js',
  '/js/views/settings.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(err => console.warn('[sw] partial precache', err)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // only stale *shell* versions die here — the audio cache holds saved
      // offline tracks and the image cache holds covers; wiping them on a
      // shell update made "saved" tracks 404 after every app update
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== AUDIO_CACHE && k !== 'osmp-imgs-v1')
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // audio streams: network-first with an offline fallback cache.
  // Full GETs (200) fill the cache — that's what "Save to this device" does
  // and what happens when a track plays end-to-end. Range requests (seeking)
  // go to the network; if it's down, Chromium slices the cached response.
  if (url.pathname.startsWith('/api/stream/') ||
      url.pathname.startsWith('/api/library/stream/')) {
    if (url.searchParams.has('osmpsave')) return; // page-side "save offline" fetch — no SW handling
    const pathname = url.pathname;
    const cachedAudio = () => caches.open(AUDIO_CACHE).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      const keys = await cache.keys();
      const k = keys.find(k => new URL(k.url).pathname === pathname);
      return k ? cache.match(k, { ignoreVary: true }) : undefined;
    });
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic' &&
            !e.request.headers.has('range')) {
          const clone = resp.clone();
          caches.open(AUDIO_CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => cachedAudio().then(hit => hit || Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return; // never touch other API calls

  // same-origin shell: stale-while-revalidate.
  // ignoreVary: the CORS middleware stamps `Vary: Origin` on everything and
  // module scripts fetch with an Origin header while precache didn't — without
  // this, offline module loads miss the cache and the app never boots.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreVary: true }).then(cached => {
        const fetchPromise = fetch(e.request).then(resp => {
          if (resp && resp.status === 200 && resp.type === 'basic') {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        }).catch(() => cached); // network down → cached copy
        return cached || fetchPromise;
      })
    );
    return;
  }

  // youtube thumbnails: cache-first with expiry-by-revalidate
  if (url.hostname === 'i.ytimg.com') {
    e.respondWith(
      caches.open('osmp-imgs-v1').then(cache =>
        cache.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
          if (resp.status === 200) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => hit))
      )
    );
  }
});
