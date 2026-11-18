const CACHE = 'japan-spring-419aba5c';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'favicon.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'assets/food.webp', 'assets/gorge.webp', 'assets/gujo.webp', 'assets/hero.webp', 'assets/hida.webp', 'assets/hike.webp', 'assets/kyoto.webp', 'assets/lacquer.webp', 'assets/lake.webp', 'assets/mino.webp', 'assets/naegi.webp', 'assets/narai.webp', 'assets/osaka.webp', 'assets/ryokan.webp', 'assets/sakura.webp', 'assets/shibamata.webp', 'assets/takao.webp', 'assets/tokyo.webp', 'assets/washi.webp'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // newest plan when online, saved copy when not
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); return res; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(hit => hit || fetch(req)));
});
