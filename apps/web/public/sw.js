/*
 * YÖNESİST service worker: uygulamanin ana ekrana eklenebilmesi ve zayif baglantida kabugun
 * acilmasi icin. Yalnizca AYNI KOKENDEKI GET isteklerine dokunur; API (execute-api), Cognito
 * ve diger kokenler hic onbelleklenmez (kisisel veri ve oturum tarayicida kalmaz).
 *   - Sayfa gecisleri (navigate): once ag; ag yoksa onbellekteki son HTML sayfa (yalnizca
 *     `text/html`, yonlendirmesiz yanitlar saklanir). Her HTML dosyasi kendi adresini tasir ve on-render
 *     icerigi baska adreste satir ici betikle gizlenir, bu yuzden cevrimdisi /admin de uygulamayi acar
 *     (v3: tanitim + hukuki metinler ayri on-render HTML).
 *   - Ana ekrana eklenen uygulama `/login`'den acilir (manifest start_url): giris yapmis kullanici
 *     oradan paneline yonlenir, tanitim sayfasi gorulmez.
 *   - /assets/* (Vite, icerik ozetli adlar): once onbellek; degismeyen dosyalar.
 *   - Diger statik dosyalar (logo, ikon, manifest): onbellek + arka planda yenileme.
 * Surum degisince (CACHE) eski onbellekler silinir.
 */
const CACHE = 'yonesist-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/brand/mark.png', '/brand/mark-dark.png', '/brand/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API ileride ayni kokenden sunulsa bile asla onbelleklenmez.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Yalnizca HTML sayfa kabuk olarak saklanir (hata sayfasi, yonlendirme veya baska tur degil).
          const html = (res.headers.get('content-type') || '').toLowerCase().includes('text/html');
          if (res.ok && html && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
