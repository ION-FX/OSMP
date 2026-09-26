/* OSMP service worker — cache-first app shell so the UI loads instantly and
 * even works when the server is briefly unreachable. API calls and audio
 * streams are NEVER cached here (offline playback is served by the server
 * library or the Android native layer). */

const CACHE = 'osmp-shell-v2';
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
  '/js/components/icons.js',
  '/js/components/toast.js',
  '/js/components/dialog.js',
  '/js/components/tracklist.js',
  '/js/views/home.js',
  '/js/views/search.js',
  '/js/views/library.js',
  '/js/views/playlist.js',
  '/js/views/radio.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // never touch API/streams

  // same-origin shell: stale-while-revalidate
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => {
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
