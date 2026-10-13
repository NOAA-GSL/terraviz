// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// Service Worker — cache-first strategy for static GIBS tiles and textures.
// Everything matched below is fixed imagery (Blue Marble 2004, Black Marble
// 2016, the skybox, the specular map), so we cache indefinitely and serve
// from cache on every subsequent request. Cache-first has no expiry: a URL
// whose bytes change must never be added to the lists below, or each visitor
// keeps the copy from their first visit until CACHE_NAME moves.

// v2 — dropped Earth_Normal_2K.jpg (dead asset, no longer shipped).
// v3 — honor user-driven cache bypass (Ctrl+Shift+R) in the fetch handler;
//      reject 206 Partial Content from cache writes so a truncated cloud
//      texture can't poison the cache and persist across normal reloads.
//      Bumping the name evicts any caches already holding bad bytes.
// v4 — reject redirected responses from cache writes, so a node behind
//      Cloudflare Access can never store a login page under a tile URL.
//      Bumped for the same reason as v3: it gives an operator debugging
//      an Access-protected node a floor they can trust.
// v5 — stopped caching s3.dualstack.us-east-1.amazonaws.com
//      /metadata.sosexplorer.gov/. Everything the app fetches through that
//      path changes: the cloud texture (clouds_8192.jpg / clouds_4096.jpg)
//      is a live feed rewritten about every 10 minutes, and dataset.json is
//      the SOS catalog, which changes on every upstream publish.
//      Cache-first served a returning visitor the clouds and catalog from
//      their first visit. Also narrowed the direct-GIBS rule from every
//      layer to the two the tile proxy allows: daily GIBS layers change.
//      Bumped so the frozen copies are evicted rather than left as dead
//      weight in every returning visitor's Cache Storage.
const CACHE_NAME = 'gibs-tiles-v5'

// External URLs to cache — scoped to specific paths, not entire hostnames.
//
// The S3 path behind the cloud texture is deliberately absent (see v5).
// Those requests go to the browser's HTTP cache instead. S3 sends an ETag
// and Last-Modified with no Cache-Control, so the browser treats a copy as
// fresh for about a tenth of the time since Last-Modified, then revalidates:
// a 304 when nothing changed, the new bytes when it has. For the clouds that
// window is well under a minute.
//
// GIBS is scoped to the two fixed basemap layers, the same two the
// /api/tile/ proxy allows. Most GIBS layers are daily imagery, and a rule
// for the whole WMTS tree would freeze them. GIBS sends no-store, which
// this worker does not read.
const CACHEABLE_EXTERNAL = [
  { hostname: 'gibs.earthdata.nasa.gov', pathPrefix: '/wmts/epsg3857/best/BlueMarble_NextGeneration/' },
  { hostname: 'gibs.earthdata.nasa.gov', pathPrefix: '/wmts/epsg3857/best/VIIRS_Black_Marble/' },
]

// Same-origin paths to cache (proxied tiles, skybox, specular map, etc.)
// These are static textures that rarely change. If they do, bump CACHE_NAME above.
const CACHEABLE_LOCAL_PATHS = [
  '/api/tile/',
  '/assets/skybox/',
  '/assets/Earth_Specular_2K.jpg',
]

function shouldCache(url) {
  const parsed = new URL(url)

  // Match external cacheable origins + path prefixes
  if (CACHEABLE_EXTERNAL.some(
    rule => parsed.hostname === rule.hostname && parsed.pathname.startsWith(rule.pathPrefix)
  )) {
    return true
  }

  // Match local asset paths
  if (parsed.origin === self.location.origin &&
      CACHEABLE_LOCAL_PATHS.some(p => parsed.pathname.startsWith(p))) {
    return true
  }

  return false
}

self.addEventListener('install', event => {
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting()
  event.waitUntil(caches.open(CACHE_NAME))
})

self.addEventListener('activate', event => {
  // Claim all open clients so the SW starts intercepting immediately
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean up any old cache versions
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name => name !== CACHE_NAME)
            .map(name => caches.delete(name))
        )
      ),
    ])
  )
})

self.addEventListener('fetch', event => {
  const { request } = event

  // Only intercept GET requests for cacheable URLs
  if (request.method !== 'GET' || !shouldCache(request.url)) {
    return
  }

  event.respondWith(
    (async () => {
      let cache
      try {
        cache = await caches.open(CACHE_NAME)
      } catch {
        // Cache API unavailable — let the browser handle the request normally
        return fetch(request.clone())
      }

      // Honor a request that asks to bypass caches: skip the stored
      // entry and, for 'reload' / 'no-cache', write the fresh copy back.
      //
      // This is NOT a recovery path a visitor can reach, whatever v3
      // assumed. Measured in Chromium: a normal Reload sends the page's
      // subresources here with cache mode 'default', and Ctrl+Shift+R
      // loads the page uncontrolled, so the worker sees none of its
      // requests and the stored entry survives to be served on the
      // next normal load. Nothing in the app sets one of these modes
      // either. Bumping CACHE_NAME is the only fix that reaches every
      // visitor holding a bad entry.
      const bypass =
        request.cache === 'reload' ||
        request.cache === 'no-cache' ||
        request.cache === 'no-store'

      if (!bypass) {
        const cached = await cache.match(request)
        if (cached) {
          return cached
        }
      }

      // Not cached (or bypass requested) — fetch from network.
      //
      // The clone carries the caller's own credentials mode, which is
      // the correct behaviour and must stay that way. Forcing
      // `credentials: 'include'` here would apply to the cross-origin
      // rule above too, and GIBS answers with
      // `Access-Control-Allow-Origin: *` — a wildcard the browser
      // rejects outright on a credentialed request — so that "fix"
      // would fail every direct GIBS fetch, and every cross-origin
      // rule added after it. A same-origin caller that needs the
      // Access cookie asks for it at the call site instead; see
      // tilePreloader.ts.
      const response = await fetch(request.clone())

      // Cache only verified-complete, unredirected 200 responses.
      // Specifically reject 206 Partial Content (range responses are
      // truncated bodies that would silently decode to a gray/white
      // band on the globe) and opaque cross-origin responses (status
      // 0). 'no-store' opts out of writing too. response.ok would also
      // accept 201-299, but those don't apply to static assets and
      // aren't safe to cache.
      //
      // `redirected` is the Cloudflare Access guard. If this node's
      // hostname is behind Access and a request arrives without the
      // CF_Authorization cookie, Access answers 302 to the login
      // origin. Following that usually fails the CORS check and
      // throws before we get here — but an Access configuration that
      // lands on a same-origin 200 would hand us login HTML wearing a
      // tile URL, and cache-first would then serve it to everyone
      // until CACHE_NAME moves. One flag closes that.
      //
      // Deliberately not `redirect: 'manual'` on the fetch above:
      // that yields an opaqueredirect response, which respondWith
      // refuses for a non-navigation request, turning a legible CORS
      // error into a confusing TypeError. Follow, then decline to
      // store.
      const writable =
        response.status === 200 &&
        !response.redirected &&
        request.cache !== 'no-store'

      if (writable) {
        try {
          await cache.put(request, response.clone())
        } catch {
          // Cache write failed (e.g. quota exceeded, or the body
          // stream errored mid-read because the connection dropped) —
          // still return the response we already have headers for.
        }
      }

      return response
    })()
  )
})
