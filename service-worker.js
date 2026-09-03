// service-worker.js — Iron Log offline support
const CACHE_NAME = 'iron-log-v4';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/db.js',
  './js/app.js',
  './icons/app-icon-192.png',
  './icons/app-icon-512.png',
  './icons/bench-press.svg',
  './icons/lat-pulldown.svg',
  './icons/machine-row.svg',
  './icons/machine-shoulder-press.svg',
  './icons/preacher-curl.svg',
  './icons/pec-deck.svg',
  './icons/triceps-extension.svg',
  './icons/romanian-deadlift.svg',
  './icons/squat.svg',
  './icons/leg-press.svg',
  './icons/hip-abductor.svg',
  './icons/leg-extension.svg',
  './icons/hamstring-curl.svg',
  './icons/crunches.svg',
  './icons/barbell-generic.svg',
  './icons/dumbbell-generic.svg',
  './icons/machine-generic.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for app shell + same-origin assets.
// Network-first with cache fallback for cross-origin (CDN) scripts, so
// updates to those libraries are picked up when online, but the app still
// works offline once they've been fetched at least once.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return res;
      }))
    );
  } else {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
