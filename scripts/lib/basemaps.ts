/**
 * The Earth basemap textures, and where a build gets them.
 *
 * These eleven files are the diffuse / night-lights / normal maps at
 * three resolutions each, plus two country-border overlays. Every node
 * loads them — they are the 2D globe's surface and the photoreal
 * Earth's, not an optional extra — and they are the only large static
 * assets the app does not ship in its own bundle.
 *
 * ## Why they are fetched rather than committed
 *
 * 18.5 MB across eleven files is small for a CDN and large for a git
 * repository, and LFS has already proved a poor fit for assets a build
 * silently needs: a clone without `git lfs pull` produces text files
 * wearing `.jpg` names, the build passes, the deploy passes, and the
 * globe comes up missing its stars. Fetching into a gitignored
 * directory has neither failure mode — the file is either there or the
 * fetch failed loudly.
 *
 * ## Why they are not left on upstream's CDN
 *
 * They used to be. `EARTH_ASSET_BASE` defaulted to upstream's
 * CloudFront distribution, so every fork's visitors pulled the Earth
 * from upstream's bandwidth forever, and `SELF_HOSTING.md` Reference C
 * told every operator to mirror them somewhere and repoint the
 * variable. Almost nobody did: it was the one entry in that table that
 * applied to every node, and the only one with no tooling behind it.
 *
 * Serving them from the node's own origin makes the default correct
 * instead of merely documented. `VITE_EARTH_ASSET_BASE` still exists
 * for anyone who wants a CDN, and setting it skips the fetch.
 */

/** Upstream's distribution — the source of truth for the files. */
export const UPSTREAM_BASEMAP_BASE =
  'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps'

/**
 * Where the fetched copies land, relative to the repo root.
 *
 * Under `public/` so Vite copies them verbatim into `dist/`, which is
 * what makes them same-origin at runtime and is why no build variable
 * has to be set for the default to work.
 */
export const BASEMAP_DIR = 'public/assets/basemaps'

/** The path the app requests them from, once they are in `dist/`. */
export const BASEMAP_PUBLIC_PATH = '/assets/basemaps'

/**
 * Every file the app asks for.
 *
 * Hand-written, and checked against the source rather than trusted:
 * `fetch-basemaps.test.ts` scans `src/` for the URLs actually built
 * from `EARTH_ASSET_BASE` and fails when this list and those
 * references disagree. A file added to a renderer and forgotten here
 * would otherwise 404 only on a node that had never warmed its cache
 * — which is to say, on somebody else's install.
 */
export const BASEMAP_FILES: readonly string[] = [
  'earth_diffuse_2048.jpg',
  'earth_diffuse_4096.jpg',
  'earth_diffuse_8192.jpg',
  'earth_lights_2048.jpg',
  'earth_lights_4096.jpg',
  'earth_lights_8192.jpg',
  'earth_normal_2048.jpg',
  'earth_normal_4096.jpg',
  'earth_normal_8192.jpg',
  'country-borders-black-4096.png',
  'country-borders-black-8192.png',
]

/**
 * Basemap filenames referenced from a blob of TypeScript source.
 *
 * Matches a template literal whose base is one of the constants
 * `endpoints.ts` feeds — the renderers alias `EARTH_ASSET_BASE` to
 * their own name before interpolating, so matching the import alone
 * would find nothing.
 */
export function referencedBasemaps(source: string): string[] {
  const pattern = /\$\{(?:EARTH_ASSET_BASE|EARTH_TEXTURE_BASE|BORDERS_TEXTURE_BASE)\}\/([\w.-]+)/g
  return [...source.matchAll(pattern)].map(m => m[1])
}

/** Is a downloaded file plausibly the image it claims to be? */
export function looksLikeImage(bytes: Uint8Array, filename: string): boolean {
  if (filename.endsWith('.png')) {
    // \x89PNG
    return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50
  }
  // JPEG SOI marker.
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
}
