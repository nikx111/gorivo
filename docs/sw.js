// Работа без интернет: страницата и библиотеките се пазят в кеша, а данните се взимат от мрежата,
// когато има, и от кеша, когато няма (тогава се виждат последните заредени цени).
const VERSION = 'gorivo-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './logos/omv.svg', './logos/lukoil.svg', './logos/rompetrol.svg',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Данни и самата страница: първо мрежата, за да са цените винаги последни
  if (url.pathname.includes('/data/') || req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(url.pathname.includes('/data/') ? url.origin + url.pathname : req, copy)); }
      return r;
    }).catch(() => caches.match(url.pathname.includes('/data/') ? url.origin + url.pathname : req).then((m) => m || caches.match('./index.html'))));
    return;
  }
  // Всичко останало: от кеша, а на заден план се обновява
  e.respondWith(caches.match(req).then((m) => {
    const net = fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; }).catch(() => m);
    return m || net;
  }));
});
