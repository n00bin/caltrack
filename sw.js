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
 * Anything NOT on this origin - Open Food Facts, the ZXing library - is left
 * alone entirely. Barcode lookups need the real network and should fail
 * honestly rather than quietly serving yesterday's answer.
 */

const VERSION = 'caltrack-2026-08-30.1640+b7faa37';
const TIMEOUT_MS = 3000;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './store.js',
  './scan.js',
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
      .then((cache) => cache.addAll(SHELL))
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

    fetch(request).then((response) => {
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
