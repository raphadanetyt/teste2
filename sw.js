// Service worker: recebe os alertas mesmo com o app fechado e mantém o app abrindo offline.
const CACHE = 'mikrotik-shell-v1';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Só os arquivos do app (nunca a API): rede primeiro, cache se estiver sem internet
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!SHELL.includes(url.pathname) && !url.pathname.startsWith('/icons/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'MikroTik Manager', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/favicon-48.png',
      tag: d.tag,          // mesma tag: "voltou ao normal" substitui o aviso de problema
      renotify: !!d.tag,   // e ainda assim avisa o usuário de novo
      data: d.data || {},
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.mikrotik_id;
  const target = id ? `/#/painel/${encodeURIComponent(id)}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'abrir', hash: id ? `#/painel/${encodeURIComponent(id)}` : '#/' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
