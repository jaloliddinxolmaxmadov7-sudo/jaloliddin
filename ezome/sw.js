// ezome service worker: ilova qobig'ini keshlaydi, internet uzilsa ham ochiladi.
// Yo'llar nisbiy — sayt istalgan manzil yoki papkada ishlaydi.
const V = 'ezome-v3';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'config.js', 'vendor/supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png'];
const FRESH = ['index.html', 'config.js', 'sw.js', 'firebase-config.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/') || u.pathname.includes('/.well-known/')) return;
  const net = () => fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(r, c)); } return res; });
  const last = u.pathname.split('/').pop();
  if (r.mode === 'navigate' || FRESH.includes(last)) {
    e.respondWith(net().catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(r).then(m => m || net()));
  }
});
