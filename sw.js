// FENIX CRM SERVICE WORKER v202603310611
// Cache Strategy: HTML=Network-first | Assets=Cache-first

const SW_VERSION = 'fenix-crm-202603310611';
const CACHE_NAME = 'fenix-crm-cache-202603310611';
const FIREBASE_PROJECT = 'fenix-tours-crm';
const FIREBASE_API_KEY = 'AIzaSyDudr9WtoxVXEduqlCKU4g1P3THlEUrY_k';
const PING_INTERVAL_MS = 5 * 60 * 1000;

// ── Install ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing:', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(['/fenix-crm/', '/fenix-crm/index.html']))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: DELETE ALL OLD CACHES ─────────────────────────────
// This is the key fix — every new deployment gets a new version,
// activate deletes old cache so users get fresh files on next load
self.addEventListener('activate', event => {
  console.log('[SW] Activating:', SW_VERSION, '— clearing old caches');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Skip Firebase, Nominatim, CDN requests — never cache these
  const skipDomains = ['firestore.googleapis', 'firebase', 'nominatim',
    'openstreetmap', 'tile.openstreet', 'cdnjs', 'googleapis'];
  if(skipDomains.some(d => url.href.includes(d))) return;

  // HTML navigation: NETWORK FIRST → cache fallback
  // This ensures Ctrl+R always gets the latest HTML from GitHub
  if(event.request.mode === 'navigate' ||
     url.pathname.endsWith('.html') ||
     url.pathname === '/fenix-crm/' ||
     url.pathname === '/fenix-crm') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(response => {
          if(response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request)
            .then(cached => cached || caches.match('/fenix-crm/index.html'))
        )
    );
    return;
  }

  // Static assets (manifest, sw itself): cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(response => {
        if(response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Messages ─────────────────────────────────────────────────────
self.addEventListener('message', event => {
  const { type, employeeId, employeeName } = event.data || {};

  if(type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'SW_VERSION', version: SW_VERSION });
    return;
  }
  if(type === 'START_PINGS') {
    self._fmktEmployeeId = employeeId;
    self._fmktEmployeeName = employeeName;
    self._fmktPinging = true;
    _sendLocationPing();
    if(self._fmktPingTimer) clearInterval(self._fmktPingTimer);
    self._fmktPingTimer = setInterval(() => {
      if(self._fmktPinging) _sendLocationPing();
    }, PING_INTERVAL_MS);
    event.source?.postMessage({ type: 'PINGS_STARTED' });
  }
  if(type === 'STOP_PINGS') {
    self._fmktPinging = false;
    if(self._fmktPingTimer) { clearInterval(self._fmktPingTimer); self._fmktPingTimer = null; }
    event.source?.postMessage({ type: 'PINGS_STOPPED' });
  }
  if(type === 'PING_NOW') _sendLocationPing();
});

self.addEventListener('sync', event => {
  if(event.tag === 'fmkt-location-ping') event.waitUntil(_sendLocationPing());
});

self.addEventListener('periodicsync', event => {
  if(event.tag === 'fmkt-location-ping') event.waitUntil(_sendLocationPing());
});

// ── GPS + Firestore ───────────────────────────────────────────────
async function _sendLocationPing() {
  const employeeId = self._fmktEmployeeId;
  if(!employeeId) return;
  try {
    const pos = await _getPosition();
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    let address = lat.toFixed(4) + ', ' + lng.toFixed(4);
    let area='', road='', city='';
    try {
      const g = await fetch(
        'https://nominatim.openstreetmap.org/reverse?lat='+lat+'&lon='+lng+'&format=json&zoom=18&addressdetails=1',
        { headers: { 'Accept-Language':'en' } }
      ).then(r=>r.json());
      const a = g.address||{};
      area = a.suburb||a.neighbourhood||a.residential||'';
      road = a.road||a.street||'';
      city = a.city||a.town||a.municipality||'';
      address = [road,area,city].filter(Boolean).slice(0,2).join(', ')||address;
    } catch(e){}
    await fetch(
      'https://firestore.googleapis.com/v1/projects/'+FIREBASE_PROJECT+'/databases/(default)/documents/fieldPings/'+employeeId+'?key='+FIREBASE_API_KEY,
      { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ fields:{
          lat:{doubleValue:lat}, lng:{doubleValue:lng},
          address:{stringValue:address}, area:{stringValue:area},
          road:{stringValue:road}, city:{stringValue:city},
          employeeId:{integerValue:String(employeeId)},
          employeeName:{stringValue:self._fmktEmployeeName||''},
          updatedAt:{stringValue:new Date().toISOString()},
          source:{stringValue:'service-worker'}
        }})
      }
    );
    const clients = await self.clients.matchAll();
    clients.forEach(c => c.postMessage({type:'PING_SENT',address,lat,lng,time:new Date().toISOString()}));
  } catch(e) { console.error('[SW] Ping failed:',e.message); }
}

function _getPosition() {
  return new Promise((resolve,reject) => {
    self.clients.matchAll().then(clients => {
      if(!clients.length) { reject(new Error('No clients')); return; }
      const ch = new MessageChannel();
      ch.port1.onmessage = e => {
        if(e.data.type==='GPS_RESULT') {
          e.data.error ? reject(new Error(e.data.error))
                       : resolve({coords:{latitude:e.data.lat,longitude:e.data.lng}});
        }
      };
      clients[0].postMessage({type:'GET_GPS'},[ch.port2]);
      setTimeout(()=>reject(new Error('GPS timeout')),15000);
    });
  });
}
