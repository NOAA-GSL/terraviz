#!/usr/bin/env tsx
/**
 * Fetch the Earth basemap textures into `public/assets/basemaps/`.
 *
 * Runs from `postinstall`, beside `tokens` and `locales` — the other
 * two build artifacts that are generated rather than committed. That
 * placement is deliberate: `npm run build` stays runnable offline,
 * because by the time anyone builds, `npm install` has already put the
 * files on disk. A fetch in `prebuild` would have made every build
 * depend on the network.
 *
 *   npm run fetch:basemaps            # fetch what is missing
 *   npm run fetch:basemaps -- --check # report, change nothing
 *   npm run fetch:basemaps -- --force # re-fetch everything
 *
 * ## Skipped when the operator has their own CDN
 *
 * `VITE_EARTH_ASSET_BASE` means "serve the textures from here
 * instead", so a build that sets it has no use for local copies and
 * this exits without touching the network. That is also the escape
 * hatch for an air-gapped install: point the variable at whatever host
 * you do have.
 *
 * ## Failure is loud, and that is the point
 *
 * The predecessor to this script was a CDN URL baked in as a default,
 * and the failure mode it replaced was worse than a failed build: a
 * node that deployed clean and served somebody else's bandwidth. The
 * one before *that* was Git LFS, where a clone without `git lfs pull`
 * produced text files wearing `.jpg` names and shipped them. Both fail
 * silently. A missing texture here stops `npm install` with the
 * filename and the reason.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BASEMAP_DIR,
  BASEMAP_FILES,
  looksLikeImage,
  UPSTREAM_BASEMAP_BASE,
} from './lib/basemaps.ts'
import { isInvokedAsScript } from './lib/cli.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface FetchDeps {
  argv: string[]
  env: Record<string, string | undefined>
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  fetchImpl: typeof fetch
  /** Absolute directory the files land in. */
  dir: string
}

/** Bytes already on disk for `name`, or null when absent or empty. */
function existingSize(dir: string, name: string): number | null {
  try {
    const size = statSync(resolve(dir, name)).size
    return size > 0 ? size : null
  } catch {
    return null
  }
}

export async function fetchBasemaps(deps: FetchDeps): Promise<number> {
  const check = deps.argv.includes('--check')
  const force = deps.argv.includes('--force')

  const override = deps.env.VITE_EARTH_ASSET_BASE?.trim()
  if (override) {
    deps.stdout.write(
      `  basemaps: skipped — VITE_EARTH_ASSET_BASE points at ${override}\n`,
    )
    return 0
  }

  const missing = BASEMAP_FILES.filter(f => force || existingSize(deps.dir, f) === null)

  if (!missing.length) {
    deps.stdout.write(`  basemaps: ${BASEMAP_FILES.length} present\n`)
    return 0
  }

  if (check) {
    deps.stderr.write(
      `\n  ✘ ${missing.length} basemap texture(s) missing from ${BASEMAP_DIR}:\n` +
        missing.map(f => `      ${f}\n`).join('') +
        '\n    Run: npm run fetch:basemaps\n\n',
    )
    return 1
  }

  mkdirSync(deps.dir, { recursive: true })
  deps.stdout.write(`  basemaps: fetching ${missing.length} file(s)\n`)

  for (const name of missing) {
    const url = `${UPSTREAM_BASEMAP_BASE}/${name}`
    let bytes: Uint8Array
    try {
      const res = await deps.fetchImpl(url)
      if (!res.ok) {
        deps.stderr.write(`\n  ✘ ${name}: ${res.status} from ${url}\n\n`)
        return 1
      }
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      deps.stderr.write(
        `\n  ✘ ${name}: ${detail}\n` +
          '\n    No network? Point VITE_EARTH_ASSET_BASE at a host you can\n' +
          '    reach and this step is skipped entirely.\n\n',
      )
      return 1
    }

    // A captive portal or an S3 error document answers 200 with HTML.
    // Writing that under a .jpg name reproduces exactly the LFS
    // failure this script exists to end, so it is rejected here rather
    // than discovered on the globe.
    if (!looksLikeImage(bytes, name)) {
      deps.stderr.write(
        `\n  ✘ ${name}: ${bytes.length} bytes that are not an image.\n` +
          `    Fetched from ${url} — a proxy or portal may have answered.\n\n`,
      )
      return 1
    }

    writeFileSync(resolve(deps.dir, name), bytes)
  }

  deps.stdout.write(`  basemaps: ${missing.length} fetched into ${BASEMAP_DIR}\n`)
  return 0
}

/* c8 ignore start — entry-point wiring, exercised by running it */
if (isInvokedAsScript(import.meta.url)) {
  const code = await fetchBasemaps({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    fetchImpl: fetch,
    dir: resolve(ROOT, BASEMAP_DIR),
  })
  process.exit(code)
}
/* c8 ignore stop */
