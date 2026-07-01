// ============================================================
//  PRODENI v4 — Service Worker
//  Caché offline + Background Sync
//  Cambiar CACHE_NAME al subir nueva versión → v4.1, v4.2...
// ============================================================

const CACHE_NAME = 'prodeni-v4.7'; // re-integrar PostHog (perdido en v4.6) + agregar desarrollos.html al cache
const SYNC_TAG   = 'prodeni-sync';

const CACHE_FILES = [
  './',
  './index.html',
  './tecnico.html',
  './admin.html',
  './session.js',
  './manifest.json',
  './Logo.png',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ── INSTALL ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(CACHE_FILES.map(url => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Apps Script: NO interceptar — el browser hace fetch nativo (fix móviles)
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    return;
  }
  
  // Todo lo demás: caché primero, red en segundo plano (stale-while-revalidate)
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => null);
      return cached || networkFetch || caches.match('./index.html');
    })
  );
});

// ── BACKGROUND SYNC ──────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) e.waitUntil(syncPending());
});

async function syncPending() {
  const db      = await openDB();
  const pending = await getAll(db, 'pending');
  if (!pending.length) return;

  const cfg       = await getAll(db, 'config');
  const scriptUrl = (cfg.find(c => c.key === 'scriptUrl') || {}).value ||
    localStorage.getItem('prodeni_script_url') || '';
  if (!scriptUrl) return;

  for (const item of pending) {
    try {
      const p = new URLSearchParams({ ...item.data, action: 'saveData' }).toString();
      const u = scriptUrl + '?' + p;
      if (u.length <= 2000) {
        await fetch(u, { method: 'GET', mode: 'no-cors' });
      } else {
        await fetch(scriptUrl, {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ ...item.data, action: 'saveData' }),
        });
      }
      await del(db, 'pending', item.id);
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'SYNCED', id: item.id }));
    } catch(e) {}
  }
}

// ── IndexedDB helpers ─────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('prodeni-db', 2);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      // Crear stores si no existen (safe en cualquier versión)
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
    };
    r.onblocked = () => {
      // Otra pestaña tiene la DB abierta — esperar
      console.warn('IndexedDB blocked — waiting');
    };
    r.onsuccess = e => {
      const db = e.target.result;
      // Verificar que los stores existen antes de resolver
      if (db.objectStoreNames.contains('pending') && db.objectStoreNames.contains('config')) {
        res(db);
      } else {
        // Forzar upgrade cerrando y reabriendo con versión mayor
        db.close();
        const r2 = indexedDB.open('prodeni-db', db.version + 1);
        r2.onupgradeneeded = ev => {
          const db2 = ev.target.result;
          if (!db2.objectStoreNames.contains('pending')) {
            db2.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
          }
          if (!db2.objectStoreNames.contains('config')) {
            db2.createObjectStore('config', { keyPath: 'key' });
          }
        };
        r2.onsuccess = ev => res(ev.target.result);
        r2.onerror   = ev => rej(ev.target.error);
      }
    };
    r.onerror = e => rej(e.target.error);
  });
}
function getAll(db, store) {
  return new Promise(res => {
    try {
      if (!db.objectStoreNames.contains(store)) { res([]); return; }
      const r = db.transaction(store, 'readonly').objectStore(store).getAll();
      r.onsuccess = e => res(e.target.result || []);
      r.onerror   = () => res([]);
    } catch(e) { res([]); }
  });
}
function del(db, store, id) {
  return new Promise(res => {
    try {
      if (!db.objectStoreNames.contains(store)) { res(); return; }
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id).onsuccess = res;
    } catch(e) { res(); }
  });
}

// ── Mensajes desde la app ─────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SAVE_CONFIG') {
    openDB().then(db => {
      try {
        if (!db.objectStoreNames.contains('config')) return;
        const tx = db.transaction('config', 'readwrite');
        Object.entries(e.data.config).forEach(([key, value]) => {
          tx.objectStore('config').put({ key, value });
        });
      } catch(err) { console.warn('SW config save error:', err); }
    }).catch(err => console.warn('SW openDB error:', err));
  }
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
