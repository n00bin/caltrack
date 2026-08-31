/* sw.js — the service worker. It makes the app open without a connection.
 *
 * Strategy: NETWORK FIRST for our own files, falling back to the cache.
 *
 * The obvious alternative, cache-first, loads faster but goes stale: you
 * would push a fix and the phone would keep running last week's code until
 * something happened to evict it. This app is about 100 KB in total, so
 * fetching it fresh costs almost nothing, and the cache is there purely so
 * the app still opens in a lift or a supermarket basement.
 *
 * A slow connection is worse than no connection, so the network only gets
 * three seconds before the cached copy is served instead.
 *
 * IMPORTANT: every fetch here is `cache: 'no-store'`. GitHub Pages serves
 * these files with `Cache-Control: max-age=600`, and a plain fetch() honours
 * the browser's own HTTP cache - so "network first" was really "up to ten
 * minutes stale first", and pushed fixes appeared not to arrive. The worker
 * keeps its own copy for offline use; it does not want a second, invisible
 * one underneath it.
 *
 * Anything NOT on this origin - Open Food Facts, the ZXing library - is left
 * alone entirely. Barcode lookups need the real network and should fail
 * honestly rather than quietly serving yesterday's answer.
 */

const VERSION = 'caltrack-2026-08-31.1445+3c1986d';
const TIMEOUT_MS = 3000;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './store.js',
  './scan.js',
  './usda.js',
  './audit.js',
  './trend.js',
  './app.js',
  './manifest.json',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map(fresh)))
      // A missing file must not wedge the install; the app still works online.
      .catch((err) => console.warn('[sw] precache incomplete', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== VERSION).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* A request that genuinely goes to the network, bypassing the browser's
 * HTTP cache. Only ever used for our own files.
 */
function fresh(input) {
  const url = (typeof input === 'string') ? input : input.url;
  try {
    return new Request(url, { cache: 'no-store', credentials: 'same-origin' });
  } catch (err) {
    return input;   // very old browsers: better stale than broken
  }
}

function putInCache(request, response) {
  // Opaque and error responses are not worth keeping.
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(VERSION).then((cache) => cache.put(request, copy));
}

function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    // If the network is just slow, stop waiting and use what we have.
    const timer = setTimeout(() => {
      caches.match(request).then((cached) => { if (cached) finish(cached); });
    }, TIMEOUT_MS);

    fetch(fresh(request)).then((response) => {
      clearTimeout(timer);
      putInCache(request, response);
      finish(response);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(request).then((cached) => {
        if (cached) return finish(cached);
        // A navigation with nothing cached for that exact URL still wants
        // the app shell rather than a browser error page.
        if (request.mode === 'navigate') {
          caches.match('./').then((shell) => {
            finish(shell || new Response(
              'This app is not available offline yet. Open it once with a connection.',
              { status: 503, headers: { 'Content-Type': 'text/plain' } }
            ));
          });
          return;
        }
        finish(new Response('', { status: 504 }));
      });
    });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // not ours, not our business

  event.respondWith(networkFirst(request));
});
