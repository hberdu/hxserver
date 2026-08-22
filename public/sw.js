// Service worker: código vai à rede primeiro (deploy chega na hora); cache cobre o offline.
// Estáticos raros (ícones/manifest) ficam em stale-while-revalidate.
const CACHE = 'hx-v17'; // v17: emojis (memes ficam em cache sob demanda via stale-while-revalidate)
const ASSETS = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/socket.io/socket.io.js', '/vendor/gsap.min.js', '/vendor/mediasoup-client.min.js', '/icons/icon-192.png', '/icons/icon-512.png'];
const NETWORK_FIRST = ['/', '/index.html', '/app.js', '/style.css', '/socket.io/socket.io.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Só o transporte tempo real fica fora ('/socket.io/' exato); o script do cliente É cacheado —
  // sem ele offline, io() explode na linha 2 do app.js e a tela fica morta
  if (e.request.method !== 'GET' || url.pathname === '/socket.io/') return;

  const cachePut = (res) => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
    }
    return res;
  };

  if (e.request.mode === 'navigate' || NETWORK_FIRST.includes(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(cachePut)
        .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const fresh = fetch(e.request).then(cachePut).catch(() => hit || Response.error());
        return hit || fresh;
      })
    );
  }
});
