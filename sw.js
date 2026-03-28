// ════════════════════════════════════════════════════════════════
//  FENIX CRM — SERVICE WORKER
//  Handles background GPS location pings for Field Marketing
//  Runs even when screen is locked or browser is minimized
// ════════════════════════════════════════════════════════════════

const SW_VERSION = 'fenix-crm-v1';
const FIREBASE_PROJECT = 'fenix-tours-crm';
const FIREBASE_API_KEY = 'AIzaSyDudr9WtoxVXEduqlCKU4g1P3THlEUrY_k';
const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Install ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installed:', SW_VERSION);
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activated');
  event.waitUntil(self.clients.claim());
});

// ── Message from main page ────────────────────────────────────────
// Main page sends messages to start/stop pings
self.addEventListener('message', event => {
  const { type, employeeId, employeeName } = event.data || {};

  if(type === 'START_PINGS') {
    console.log('[SW] Starting background pings for', employeeName);
    // Store employee info in SW scope
    self._fmktEmployeeId   = employeeId;
    self._fmktEmployeeName = employeeName;
    self._fmktPinging      = true;
    // Send first ping immediately
    _sendLocationPing();
    // Schedule recurring pings
    if(self._fmktPingTimer) clearInterval(self._fmktPingTimer);
    self._fmktPingTimer = setInterval(() => {
      if(self._fmktPinging) _sendLocationPing();
    }, PING_INTERVAL_MS);
    // Confirm back to page
    event.source?.postMessage({ type: 'PINGS_STARTED' });
  }

  if(type === 'STOP_PINGS') {
    console.log('[SW] Stopping background pings');
    self._fmktPinging = false;
    if(self._fmktPingTimer) {
      clearInterval(self._fmktPingTimer);
      self._fmktPingTimer = null;
    }
    event.source?.postMessage({ type: 'PINGS_STOPPED' });
  }

  if(type === 'PING_NOW') {
    // Manual ping request from page
    _sendLocationPing();
  }
});

// ── Background Sync (fires when network available) ────────────────
self.addEventListener('sync', event => {
  if(event.tag === 'fmkt-location-ping') {
    event.waitUntil(_sendLocationPing());
  }
});

// ── Periodic Background Sync (Chrome Android) ────────────────────
// This is the key feature — fires even when screen is locked
self.addEventListener('periodicsync', event => {
  if(event.tag === 'fmkt-location-ping') {
    console.log('[SW] Periodic sync fired — sending location ping');
    event.waitUntil(_sendLocationPing());
  }
});

// ── Core: Get GPS and send to Firestore ──────────────────────────
async function _sendLocationPing() {
  const employeeId   = self._fmktEmployeeId;
  const employeeName = self._fmktEmployeeName;

  if(!employeeId) {
    console.log('[SW] No employee set — skipping ping');
    return;
  }

  try {
    // Get GPS position
    const position = await _getPosition();
    const { latitude: lat, longitude: lng } = position.coords;

    // Reverse geocode for address
    let address = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    let area = '', road = '', city = '';
    try {
      const geoRes = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const geoData = await geoRes.json();
      const a = geoData.address || {};
      area    = a.suburb || a.neighbourhood || a.residential || '';
      road    = a.road   || a.street        || '';
      city    = a.city   || a.town          || a.municipality || '';
      address = [road, area, city].filter(Boolean).slice(0,2).join(', ') || address;
    } catch(geoErr) {
      console.warn('[SW] Geocode failed, using coords');
    }

    // Write to Firestore via REST API (no SDK needed in SW)
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/fieldPings/${employeeId}?key=${FIREBASE_API_KEY}`;

    const body = {
      fields: {
        lat:          { doubleValue: lat },
        lng:          { doubleValue: lng },
        address:      { stringValue: address },
        area:         { stringValue: area },
        road:         { stringValue: road },
        city:         { stringValue: city },
        employeeId:   { integerValue: String(employeeId) },
        employeeName: { stringValue: employeeName || '' },
        updatedAt:    { stringValue: new Date().toISOString() },
        source:       { stringValue: 'service-worker' },
      }
    };

    const res = await fetch(firestoreUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if(res.ok) {
      console.log(`[SW] ✅ Ping sent: ${address}`);
      // Notify any open pages
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({
        type: 'PING_SENT',
        address,
        lat,
        lng,
        time: new Date().toISOString()
      }));
    } else {
      const err = await res.text();
      console.error('[SW] Firestore write failed:', err);
    }

  } catch(err) {
    console.error('[SW] Ping failed:', err.message);
  }
}

// ── GPS helper (works in service worker) ─────────────────────────
function _getPosition() {
  return new Promise((resolve, reject) => {
    // Service workers don't have direct geolocation access
    // We request it via the page client
    self.clients.matchAll().then(clients => {
      if(!clients.length) {
        reject(new Error('No active clients to request GPS'));
        return;
      }
      // Ask the main page for its GPS position
      const client = clients[0];
      const channel = new MessageChannel();
      channel.port1.onmessage = event => {
        if(event.data.type === 'GPS_RESULT') {
          if(event.data.error) reject(new Error(event.data.error));
          else resolve({ coords: { latitude: event.data.lat, longitude: event.data.lng } });
        }
      };
      client.postMessage({ type: 'GET_GPS' }, [channel.port2]);
      // Timeout after 15 seconds
      setTimeout(() => reject(new Error('GPS timeout')), 15000);
    });
  });
}

// ── Fetch handler (cache-first for app shell) ─────────────────────
self.addEventListener('fetch', event => {
  // Only cache same-origin requests
  if(!event.request.url.startsWith(self.location.origin)) return;
  // Don't cache Firestore/API calls
  if(event.request.url.includes('firestore.googleapis') ||
     event.request.url.includes('nominatim') ||
     event.request.url.includes('firebase')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        // Cache the index.html for offline use
        if(event.request.url.includes('index.html') || event.request.url.endsWith('/')) {
          const clone = response.clone();
          caches.open(SW_VERSION).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback
      if(event.request.destination === 'document') {
        return caches.match('/fenix-crm/index.html');
      }
    })
  );
});
