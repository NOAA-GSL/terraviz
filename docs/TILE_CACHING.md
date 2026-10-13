# Tile Caching Architecture

NASA GIBS tiles (Blue Marble, Black Marble) are static imagery that never changes, making them ideal for aggressive, multi-layer caching. This document describes the caching strategies used to minimize tile loading latency during globe rotation.

## Caching Layers

Requests flow through up to three cache layers before hitting the GIBS origin:

```
Browser ──> Service Worker ──> Cloudflare Edge ──> GIBS Origin
            (Cache API)        (CF cache, 1yr)     (gibs.earthdata.nasa.gov)
```

### 1. Service Worker (client-side, persistent)

**File:** `public/sw.js`

A cache-first service worker intercepts tile requests and serves them from the browser's Cache API. On cache miss, it fetches from the network and stores the response for future use. Cache-first has **no expiry**: once a URL is stored, every later request is answered from the cache until the cache name changes. So the worker may only claim URLs whose bytes never change.

**What it caches:**
- `/api/tile/*` — proxied GIBS tile requests (same-origin)
- `gibs.earthdata.nasa.gov/wmts/epsg3857/best/*` — direct GIBS requests (if any; the app currently goes through `/api/tile/`)
- `/assets/skybox/*`, `/assets/Earth_Specular_2K.jpg`

**What it deliberately does not cache:** the `metadata.sosexplorer.gov` bucket on S3. Every object the app fetches there changes:

| Object | Changes |
|---|---|
| `clouds_8192.jpg` / `clouds_4096.jpg` (the cloud texture, via `getCloudTextureUrl()`) | Live feed, rewritten about every 10 minutes |
| `dataset.json` (the SOS catalog, legacy catalog source only) | On every upstream publish. `dataService.ts` expires it on its own TTL |

Up to `gibs-tiles-v4` the worker claimed that bucket, so a returning visitor saw the clouds (and, on a legacy-source node, the catalog) from their first visit until they hard-reloaded. These requests now go to the browser's HTTP cache. S3 sends an `ETag` and `Last-Modified` but no `Cache-Control`, so the browser treats a copy as fresh for only a fraction of its age, then revalidates: a `304` when nothing changed, the new bytes when it has. The desktop app never registers the worker, so it was never affected.

**Cache name:** `gibs-tiles-v5`. Old versions are deleted on activate. Bump the name whenever cached bytes must be discarded: a rule removed, an asset changed, or a bad response that may already be stored. The changelog is the header comment in `sw.js`.

**What gets written:** only a `200` that was not redirected, and only when the request was not `no-store`. That rules out:

| Response | Why it is not stored |
|---|---|
| `206 Partial Content` | A range response is a truncated body. Stored, it would decode to a grey/white band on the globe and persist across normal reloads |
| Redirected (`response.redirected`) | A node behind Cloudflare Access answers an unauthenticated request with a redirect to its login page. If that lands on a same-origin `200`, the worker would store login HTML under a tile URL and serve it to the visitor until the cache name moves |
| Opaque (status `0`) | No way to tell a good body from an error page |
| Any other status, including other `2xx` | Not expected for a static asset, so not trusted |

The worker follows redirects and then declines to store the result. It does not use `redirect: 'manual'`, because that yields an `opaqueredirect`, which `respondWith` refuses for a non-navigation request. The visitor would see a confusing `TypeError` instead of the CORS error that explains the problem.

**Hard reload:** a request whose `cache` mode is `reload` (Ctrl+Shift+R / Cmd+Shift+R), `no-cache` (some browsers' normal Reload) or `no-store` skips the cached entry and goes to the network. `reload` and `no-cache` responses are written back, so a hard reload replaces a bad stored copy for later loads; `no-store` responses are not written. This is the visitor's recovery path for a poisoned entry. It does not purge anything the page did not request, so bumping the cache name is still the fix to ship.

**Credentials:** every network fetch is `fetch(request.clone())`, which keeps the caller's own credentials mode. Do not force `credentials: 'include'` in the worker. GIBS answers with `Access-Control-Allow-Origin: *`, which a browser rejects on a credentialed request. A same-origin caller that needs the Access cookie sets it at the call site (see `tilePreloader.ts`, and `docs/SELF_HOSTING.md` on Access-protected nodes).

**Registration:** `src/main.ts` registers the SW before `DOMContentLoaded`, on the web only. The Tauri desktop app skips it. The SW uses `skipWaiting()` and `clients.claim()` to activate immediately.

**Error handling:** if the Cache API cannot be opened, the request falls through to the network unchanged. `cache.put()` failures (quota exceeded, or a body stream that errored mid-read) are caught silently. The response is still returned to the caller.

**Headers:** `public/_headers` sets `Cache-Control: no-cache` on `/sw.js` so the browser always checks for SW updates.

**Tests:** `src/serviceWorker.test.ts` runs `sw.js` against a fake worker global. It checks that tiles are served cache-first, that the cloud texture and SOS catalog are not, and that the previous cache is evicted.

### 2. Cloudflare Edge Proxy

**File:** `functions/api/tile/[[path]].ts`

A Cloudflare Pages Function proxies tile requests to GIBS and caches them at the nearest Cloudflare PoP. This reduces first-visit latency from ~200ms (GIBS origin) to ~20ms (edge).

**URL mapping:**
```
/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg
  --> https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/...
```

**Cache behavior:**
- Cloudflare edge: `cf.cacheEverything: true, cf.cacheTtl: 31536000` (1 year)
- Browser: `Cache-Control: public, max-age=31536000, immutable`

**Security:**
- Only `BlueMarble_NextGeneration/` and `VIIRS_Black_Marble/` prefixes are allowed (prevents open-proxy abuse)
- Path traversal (`..`, `.`, `/`, `\`) is rejected
- Malformed percent-encoding returns 400
- No CORS headers (same-origin only)

### 3. MapLibre In-Memory Tile Cache

**File:** `src/services/mapRenderer.ts`

MapLibre's built-in tile cache is increased from the default (~512 tiles) to reduce re-fetching during interactive rotation within a single session.

| Device  | `maxTileCacheSize` |
|---------|--------------------|
| Desktop | 2000               |
| Mobile  | 750                |

## Tile Preloader

**File:** `src/services/tilePreloader.ts`

After the map loads, low-zoom tiles (z0-z3) are eagerly fetched in the background. This is only 170 tiles (~5-6 MB) covering the entire globe at the default view zoom.

| Setting            | Desktop                  | Mobile                            |
|--------------------|--------------------------|-----------------------------------|
| Concurrency        | 6 parallel fetches       | 2 parallel fetches                |
| Trigger            | After map `load` event   | After map `idle` event            |
| Slow network (2g)  | Skipped entirely         | Skipped entirely                  |

The preloader populates both the SW cache (via the fetch event handler) and the Cloudflare edge cache.

## Device Capability Detection

**File:** `src/utils/deviceCapability.ts`

Exports:
- `isMobile()` — true when viewport is narrow (<=768px) or device has touch input
- `isSlowNetwork()` — true when Network Information API reports 2g/slow-2g
- `getCloudTextureUrl()` — returns 4K cloud texture URL on mobile, 8K on desktop. The texture is a live feed, so it is cached by the browser's HTTP cache, not the service worker (see above)

## Deferred Texture Loading

**File:** `src/services/earthTileLayer.ts`

Non-critical textures are loaded via `requestIdleCallback` (with timeout fallbacks) so they don't compete with tile bandwidth during initial load:

| Texture       | Defer method                                    |
|---------------|-------------------------------------------------|
| Skybox faces  | `requestIdleCallback` with `{ timeout: 2000 }`  |
| Specular map  | `requestIdleCallback` with `{ timeout: 1000 }`  |
| Normal map    | `requestIdleCallback` with `{ timeout: 1500 }`  |
| Cloud texture | Loaded eagerly (visible on the globe immediately)|

All texture `onload`/`onerror` handlers check a `disposed` flag to prevent WebGL calls on deleted resources if the layer is removed before loading completes.

## Tile Sources

Both tile layers use GIBS WMTS endpoints via the Cloudflare edge proxy:

| Layer         | Format | Max Zoom | Tiles at z0-z3 |
|---------------|--------|----------|----------------|
| Blue Marble   | JPG    | 8        | 85             |
| Black Marble  | PNG    | 8        | 85             |

**Total preloaded:** 170 tiles across both layers.
