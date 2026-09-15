// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Externally-hosted endpoint configuration.
 *
 * Terraviz is designed so each deployed node operates **independently**
 * of every other node. A handful of runtime dependencies were
 * historically hardcoded to the upstream `zyra-project` node's
 * infrastructure — the Vimeo / caption proxy worker and the
 * CloudFront-fronted Earth basemap bucket. Hardcoding them silently
 * coupled every fork to upstream's uptime and bandwidth.
 *
 * Each base is now resolved here from a build-time `VITE_*` env var,
 * defaulting to the upstream URL so an un-configured build still
 * works out of the box (a quick demo fork). To run a fully
 * independent node, set the corresponding variable at build time
 * (Cloudflare Pages → Settings → Environment variables) and host the
 * proxy / assets yourself. See `docs/SELF_HOSTING.md` Reference C.
 *
 * These are read at module load; Vite inlines `import.meta.env.VITE_*`
 * as string literals at build time, so each export is effectively a
 * compile-time constant in the shipped bundle.
 *
 * Note: the NASA GIBS tile base, the NOAA "Science On a Sphere"
 * metadata snapshot, and the cloud-texture bucket are third-party
 * **public data sources** shared by all nodes — not upstream-Terraviz
 * infrastructure — so they are deliberately not parameterised here.
 */

/**
 * Public origin of the production Pages deployment, and the fallback
 * host for **this node's own** `/api/...` calls in Tauri builds.
 *
 * A desktop webview is served from `tauri://localhost/` (or
 * `http://tauri.localhost/` on Windows) with no Pages Functions
 * backend behind it, so a relative `/api/...` path does not resolve to
 * anything useful — it either fails to parse as a URL in the Rust HTTP
 * plugin or returns the bundled `index.html`.
 *
 * Override at build time via `VITE_API_ORIGIN` to point a fork's
 * desktop builds at its own deployment. See `docs/SELF_HOSTING.md`
 * §15.3, which is also where the consequence of *not* setting it is
 * spelled out.
 */
const DEFAULT_API_ORIGIN = 'https://terraviz.zyra-project.org'

/**
 * Resolve the active API origin.
 *
 * Reads `VITE_API_ORIGIN` and normalises it to just
 * `<scheme>://<host>[:port]` via the URL constructor — anything past
 * the origin (path, query, fragment) is dropped, which matches the
 * variable's name and prevents a misconfigured
 * `https://staging.example.com/foo` from producing
 * `https://staging.example.com/foo/api/v1/catalog`. Non-URL or
 * non-http(s) values fall back to `DEFAULT_API_ORIGIN` rather than
 * throwing, so a typo cannot take desktop builds offline.
 *
 * **This lives here rather than in `catalogSource.ts`, where it was
 * written, because it has a second consumer that cannot import that
 * module.** `analytics/transport.ts` needs the same origin for
 * `/api/ingest`, and `catalogSource` imports `reportError` from the
 * analytics barrel — so reaching across would close a cycle
 * (transport → catalogSource → analytics → emitter → transport).
 * This module imports nothing at all, which is what makes it the safe
 * home; `catalogSource` re-exports it so its existing callers are
 * unchanged. Two copies of the fallback rule was the alternative, and
 * a node whose catalog and telemetry disagreed about where "here" is
 * would be a genuinely confusing thing to debug.
 */
export function getApiOrigin(): string {
  const override = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim()
  if (!override) return DEFAULT_API_ORIGIN
  try {
    const u = new URL(override)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return DEFAULT_API_ORIGIN
    return u.origin
  } catch {
    return DEFAULT_API_ORIGIN
  }
}

/** Trim a single trailing slash so callers can always append `/x`. */
function normalizeBase(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, '')
}

/**
 * Base for the video proxy that resolves legacy `vimeo:` dataset
 * refs into HLS / MP4 manifests. Consumers append `/{vimeoId}`.
 * Override with `VITE_VIDEO_PROXY_BASE`.
 */
export const VIDEO_PROXY_BASE = normalizeBase(
  import.meta.env.VITE_VIDEO_PROXY_BASE,
  'https://video-proxy.zyra-project.org/video',
)

/**
 * Base for the caption proxy — a CORS shim in front of `sos.noaa.gov`
 * `.srt` files. Consumers append `?url=<encoded caption url>`.
 * Override with `VITE_CAPTION_PROXY_BASE`.
 */
export const CAPTION_PROXY_BASE = normalizeBase(
  import.meta.env.VITE_CAPTION_PROXY_BASE,
  'https://video-proxy.zyra-project.org/captions',
)

/**
 * Base for the Earth basemap textures used by the photoreal Earth
 * (VR + Orbit character) and the 2D globe overlays: diffuse, night
 * lights, normal map, and country-borders PNG. Consumers append
 * `/earth_diffuse_4096.jpg`, `/country-borders-black-8192.png`, etc.
 *
 * Same-origin by default. The eleven files are committed under
 * `public/assets/basemaps/`, so a build serves them from the node's
 * own domain with nothing configured, no install-time network, and
 * nothing that can be missing when the globe first paints.
 *
 * This used to default to upstream's CloudFront distribution, which
 * meant every fork's visitors pulled the Earth from upstream's
 * bandwidth unless its operator noticed Reference C and mirrored the
 * files by hand. Almost none did — it was the only entry in that
 * table applying to every node, and the only one with no tooling.
 *
 * Override with `VITE_EARTH_ASSET_BASE` to serve them from a CDN
 * instead — an optimisation now, not a workaround. `.gitattributes`
 * carries the note on why these are plain blobs rather than LFS.
 */
export const EARTH_ASSET_BASE = normalizeBase(
  import.meta.env.VITE_EARTH_ASSET_BASE,
  '/assets/basemaps',
)
