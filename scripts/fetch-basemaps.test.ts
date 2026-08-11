import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { fetchBasemaps, type FetchDeps } from './fetch-basemaps'
import {
  BASEMAP_FILES,
  BASEMAP_PUBLIC_PATH,
  looksLikeImage,
  referencedBasemaps,
  UPSTREAM_BASEMAP_BASE,
} from './lib/basemaps'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])

function bodyFor(name: string): Uint8Array {
  return name.endsWith('.png') ? PNG : JPEG
}

interface Harness {
  deps: FetchDeps
  out: string[]
  err: string[]
  requested: string[]
  dir: string
}

function harness(over: Partial<FetchDeps> & { fail?: string } = {}): Harness {
  const out: string[] = []
  const err: string[] = []
  const requested: string[] = []
  const dir = mkdtempSync(resolve(tmpdir(), 'basemaps-'))
  const deps: FetchDeps = {
    argv: [],
    env: {},
    stdout: { write: (s: string) => void out.push(s) },
    stderr: { write: (s: string) => void err.push(s) },
    dir,
    fetchImpl: (async (url: string) => {
      requested.push(String(url))
      const name = String(url).split('/').pop()!
      if (over.fail === name) throw new Error('ECONNREFUSED')
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bodyFor(name).buffer,
      }
    }) as unknown as typeof fetch,
    ...over,
  }
  return { deps, out, err, requested, dir }
}

/**
 * The list and the code that requests it must not drift.
 *
 * `BASEMAP_FILES` is what the fetcher downloads; the renderers build
 * their own URLs from `EARTH_ASSET_BASE`. Nothing connects those two
 * except this test. A texture added to `photorealEarth.ts` and not to
 * the list would 404 — but only on a node whose cache had never been
 * warmed, which is to say on somebody else's install rather than on
 * the machine of whoever added it.
 */
describe('the basemap list', () => {
  const SOURCES = [
    'src/services/photorealEarth.ts',
    'src/services/earthTileLayer.ts',
    'src/utils/deviceCapability.ts',
  ]

  it('covers every basemap src/ actually asks for', () => {
    const referenced = new Set(SOURCES.flatMap(f => referencedBasemaps(read(f))))
    expect(referenced.size, 'no basemap URLs found — did the alias change?')
      .toBeGreaterThan(0)

    const unlisted = [...referenced].filter(f => !BASEMAP_FILES.includes(f))
    expect(
      unlisted,
      'src/ requests these and fetch-basemaps does not download them, so they 404',
    ).toEqual([])
  })

  it('downloads nothing src/ has stopped asking for', () => {
    const referenced = new Set(SOURCES.flatMap(f => referencedBasemaps(read(f))))
    const orphaned = BASEMAP_FILES.filter(f => !referenced.has(f))
    expect(orphaned, 'downloaded on every install and requested by nothing').toEqual([])
  })

  // The default has to be same-origin for the fetch to be worth doing:
  // an absolute CDN URL would make the downloaded copies dead weight.
  it('is what the app resolves to by default', () => {
    const endpoints = read('src/config/endpoints.ts')
    expect(endpoints).toContain(`'${BASEMAP_PUBLIC_PATH}'`)
    expect(
      endpoints,
      'the CloudFront default is what this change exists to remove',
    ).not.toContain('d3sik7mbbzunjo.cloudfront.net')
  })

  // Upstream's distribution is still the *source*; only the runtime
  // default moved. Losing this would leave nothing to fetch from.
  it('still knows where to fetch from', () => {
    expect(UPSTREAM_BASEMAP_BASE).toMatch(/^https:\/\//)
  })
})

describe('fetch-basemaps', () => {
  it('downloads every file into the target directory', async () => {
    const h = harness()
    expect(await fetchBasemaps(h.deps)).toBe(0)
    expect(readdirSync(h.dir).sort()).toEqual([...BASEMAP_FILES].sort())
    expect(h.requested).toHaveLength(BASEMAP_FILES.length)
  })

  it('skips files already on disk', async () => {
    const h = harness()
    mkdirSync(h.dir, { recursive: true })
    for (const f of BASEMAP_FILES) writeFileSync(resolve(h.dir, f), bodyFor(f))

    expect(await fetchBasemaps(h.deps)).toBe(0)
    expect(h.requested, 'a warm cache must not re-download 18 MB').toEqual([])
    expect(h.out.join('')).toContain('present')
  })

  // A zero-byte file is what a killed download leaves behind. Treating
  // it as present would cache the failure forever.
  it('re-fetches a truncated file', async () => {
    const h = harness()
    mkdirSync(h.dir, { recursive: true })
    writeFileSync(resolve(h.dir, BASEMAP_FILES[0]), new Uint8Array())

    expect(await fetchBasemaps(h.deps)).toBe(0)
    expect(h.requested.some(u => u.endsWith(BASEMAP_FILES[0]))).toBe(true)
  })

  it('re-fetches everything under --force', async () => {
    const h = harness({ argv: ['--force'] })
    mkdirSync(h.dir, { recursive: true })
    for (const f of BASEMAP_FILES) writeFileSync(resolve(h.dir, f), bodyFor(f))

    expect(await fetchBasemaps(h.deps)).toBe(0)
    expect(h.requested).toHaveLength(BASEMAP_FILES.length)
  })

  /**
   * The escape hatch, and the reason this can sit in `postinstall`
   * without stranding an air-gapped install: an operator with their
   * own CDN sets the variable and nothing here touches the network.
   */
  it('does nothing when VITE_EARTH_ASSET_BASE is set', async () => {
    const h = harness({ env: { VITE_EARTH_ASSET_BASE: 'https://cdn.example.org/b' } })
    expect(await fetchBasemaps(h.deps)).toBe(0)
    expect(h.requested).toEqual([])
    expect(h.out.join('')).toContain('skipped')
  })

  it('reports missing files under --check without downloading', async () => {
    const h = harness({ argv: ['--check'] })
    expect(await fetchBasemaps(h.deps)).toBe(1)
    expect(h.requested).toEqual([])
    expect(h.err.join('')).toContain('npm run fetch:basemaps')
  })

  it('passes --check once the files are there', async () => {
    const h = harness({ argv: ['--check'] })
    mkdirSync(h.dir, { recursive: true })
    for (const f of BASEMAP_FILES) writeFileSync(resolve(h.dir, f), bodyFor(f))
    expect(await fetchBasemaps(h.deps)).toBe(0)
  })

  it('fails loudly on a network error, naming the escape hatch', async () => {
    const h = harness({ fail: BASEMAP_FILES[0] })
    expect(await fetchBasemaps(h.deps)).toBe(1)
    expect(h.err.join('')).toContain('VITE_EARTH_ASSET_BASE')
  })

  it('fails on a non-200 rather than writing the error body', async () => {
    const h = harness({
      fetchImpl: (async () => ({
        ok: false,
        status: 403,
        arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
    })
    expect(await fetchBasemaps(h.deps)).toBe(1)
    expect(readdirSync(h.dir)).toEqual([])
  })

  /**
   * The failure this whole script exists to end.
   *
   * Git LFS shipped text files wearing `.jpg` names, the build passed,
   * the deploy passed, and the globe came up missing its stars. A
   * captive portal answering 200 with HTML reproduces that exactly, so
   * the bytes are checked before they are written.
   */
  it('refuses HTML served with a 200 under a .jpg name', async () => {
    const h = harness({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('<!doctype html><html>').buffer,
      })) as unknown as typeof fetch,
    })
    expect(await fetchBasemaps(h.deps)).toBe(1)
    expect(readdirSync(h.dir), 'a portal response must not reach disk').toEqual([])
    expect(h.err.join('')).toContain('not an image')
  })
})

describe('looksLikeImage', () => {
  it('accepts real magic bytes', () => {
    expect(looksLikeImage(JPEG, 'earth_diffuse_2048.jpg')).toBe(true)
    expect(looksLikeImage(PNG, 'country-borders-black-4096.png')).toBe(true)
  })

  it('rejects markup, and a PNG body under a .jpg name', () => {
    const html = new TextEncoder().encode('<!doctype html>')
    expect(looksLikeImage(html, 'earth_diffuse_2048.jpg')).toBe(false)
    expect(looksLikeImage(html, 'country-borders-black-4096.png')).toBe(false)
    expect(looksLikeImage(PNG, 'earth_diffuse_2048.jpg')).toBe(false)
  })

  it('rejects a body too short to carry a signature', () => {
    expect(looksLikeImage(new Uint8Array([0xff]), 'a.jpg')).toBe(false)
    expect(looksLikeImage(new Uint8Array([0x89]), 'a.png')).toBe(false)
  })
})

describe('referencedBasemaps', () => {
  it('finds names behind each alias the renderers use', () => {
    expect(referencedBasemaps('`${EARTH_ASSET_BASE}/a_1.jpg`')).toEqual(['a_1.jpg'])
    expect(referencedBasemaps('`${EARTH_TEXTURE_BASE}/b-2.png`')).toEqual(['b-2.png'])
    expect(referencedBasemaps('`${BORDERS_TEXTURE_BASE}/c.png`')).toEqual(['c.png'])
  })

  it('ignores interpolations of something else', () => {
    expect(referencedBasemaps('`${VIDEO_PROXY_BASE}/x.mp4`')).toEqual([])
  })
})
