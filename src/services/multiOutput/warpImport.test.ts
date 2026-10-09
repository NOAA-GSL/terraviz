// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_WARP_MESHES,
  SOS_QUADRANT_VIEWPORTS,
  buildWarpGeometry,
  parseWarpMesh,
  type SosQuadrantId,
  type WarpSetEntry,
} from '../../output/projectorWarp'
import { crc32 } from './storedZip'
import {
  MAX_WARP_IMPORT_BYTES,
  assembleWarpSet,
  readWarpSources,
  warpSetId,
  type BundleLayout,
  type WarpImportFile,
  type WarpImportRefusal,
  type WarpSource,
} from './warpImport'

const enc = new TextEncoder()

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(__dirname, '../../output/fixtures/projectorWarp', name)))

/**
 * sphere-sim's own bundle: four 5×5 meshes, its `layout.json` placing them
 * in SOS's quadrants, and an older 4×4 `P1` under `restore/`.
 */
const BUNDLE: WarpImportFile = { name: 'sphere-sim-files.zip', bytes: fixture('sphere-sim-bundle.zip') }
/** The same archive with no layout — how every bundle from before sphere-sim#52 reads. */
const BARE: WarpImportFile = { name: 'sphere-sim-files.zip', bytes: fixture('sphere-sim-bundle-no-layout.zip') }
/** Two placed projectors, which sphere-sim splits into halves at full height. */
const PLACED: WarpImportFile = { name: 'placed.zip', bytes: fixture('sphere-sim-placed-bundle.zip') }

/** The smallest mesh the parser accepts: 2×2, 16:9, every node drawn. */
const MESH = ['2', '2 2', '-1.777778 1 0.25 0.75 1', '1.777778 1 0.75 0.75 1', '-1.777778 -1 0.25 0.25 1', '1.777778 -1 0.75 0.25 1', ''].join('\n')

function push16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff)
}
function push32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
}

/** Stored entries, UTF-8 names — sphere-sim's shape — with an optional method per entry. */
function zipOf(entries: readonly { name: string; text: string; method?: number }[]): Uint8Array {
  const local: number[] = []
  const central: number[] = []
  for (const e of entries) {
    const name = enc.encode(e.name)
    const body = enc.encode(e.text)
    const offset = local.length
    // Flags (UTF-8 names), method, the DOS epoch, CRC, sizes, name and extra lengths.
    const shared = (out: number[]): void => {
      push16(out, 0x800)
      push16(out, e.method ?? 0)
      push16(out, 0)
      push16(out, 0x21)
      push32(out, crc32(body))
      push32(out, body.length)
      push32(out, body.length)
      push16(out, name.length)
      push16(out, 0)
    }
    push32(local, 0x04034b50)
    push16(local, 20)
    shared(local)
    local.push(...name, ...body)
    push32(central, 0x02014b50)
    push16(central, 20)
    push16(central, 20)
    shared(central)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push32(central, 0)
    push32(central, offset)
    central.push(...name)
  }
  const end: number[] = []
  push32(end, 0x06054b50)
  push16(end, 0)
  push16(end, 0)
  push16(end, entries.length)
  push16(end, entries.length)
  push32(end, central.length)
  push32(end, local.length)
  push16(end, 0)
  return Uint8Array.from([...local, ...central, ...end])
}

const file = (name: string, text: string): WarpImportFile => ({ name, bytes: enc.encode(text) })
const archive = (entries: readonly { name: string; text: string; method?: number }[]): WarpImportFile => ({
  name: 'rig.zip',
  bytes: zipOf(entries),
})

function sources(files: readonly WarpImportFile[]): readonly WarpSource[] {
  const read = readWarpSources(files)
  if (!read.ok) throw new Error(`expected sources, got ${JSON.stringify(read.refusal)}`)
  return read.sources
}

function refusalOf(files: readonly WarpImportFile[]): WarpImportRefusal {
  const read = readWarpSources(files)
  if (read.ok) throw new Error('expected a refusal')
  return read.refusal
}

function layoutOf(files: readonly WarpImportFile[]): BundleLayout | null {
  const read = readWarpSources(files)
  if (!read.ok) throw new Error(`expected sources, got ${JSON.stringify(read.refusal)}`)
  return read.layout
}

/** A `layout.json` as sphere-sim writes one for a placed pair, with fields replaced by `over`. */
function layoutText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'sphere-sim/projector-layout@1',
    origin: 'bottom-left',
    framebuffer: { width: 3840, height: 1080 },
    surface: 'sphere',
    rotationOffsetDeg: 30,
    projectors: [
      { id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
      { id: 'P2', mesh: 'warp/P2.data', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    ],
    ...over,
  })
}

/** Two meshes and a layout, the layout under `name` — the root's `layout.json` unless a test moves it. */
const laidOut = (text: string, name = 'layout.json'): WarpImportFile =>
  archive([
    { name, text },
    { name: 'warp/P1.data', text: MESH },
    { name: 'warp/P2.data', text: MESH },
  ])

/**
 * A mesh made for a fisheye frame, the shape dome and mirror tools write —
 * meshmapper's, for a mirror dome, are the commonest Bourke meshes there
 * are. Synthetic, not any tool's output: 16:9 at 41×23, the raster's drawn
 * region an ellipse across 90% of its width and all of its height, mapped
 * onto an angular fisheye of a 180° hemisphere (the disc inscribed in
 * [0, 1]², the zenith at its centre) with a mirror's compression towards
 * the rim and a weight that falls with it. Every node outside the ellipse
 * reaches nothing.
 *
 * Nothing in it says fisheye: `x` spans ±aspect, `y` spans ±1, and every
 * drawn `(u, v)` is in [0, 1]. Read as equirect the disc is the whole
 * world — its centre (0°, 0°), its top and bottom the poles, its sides the
 * antimeridian — and neighbouring texels stay neighbouring directions all
 * the way round, so no triangle comes out wider than a cell.
 */
function fisheyeMesh(): string {
  const cols = 41
  const rows = 23
  const aspect = 16 / 9
  const lines = ['2', `${cols} ${rows}`]
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((2 * i) / (cols - 1) - 1) * aspect
      const y = 1 - (2 * j) / (rows - 1)
      const ex = x / (0.9 * aspect)
      const r = Math.hypot(ex, y)
      if (r > 1) {
        lines.push(`${x.toFixed(6)} ${y.toFixed(6)} -1 -1 -1`)
        continue
      }
      // Off the zenith as a fraction of 90°, compressed towards the rim.
      const zenith = r * (1.15 - 0.15 * r)
      const azimuth = Math.atan2(ex, y)
      const u = 0.5 + 0.5 * zenith * Math.sin(azimuth)
      const v = 0.5 + 0.5 * zenith * Math.cos(azimuth)
      lines.push(`${x.toFixed(6)} ${y.toFixed(6)} ${u.toFixed(6)} ${v.toFixed(6)} ${(1 - 0.3 * r * r).toFixed(6)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

const FISHEYE = fisheyeMesh()

describe('readWarpSources — a sphere-sim bundle', () => {
  it('takes the four meshes at the root, in rig order, and names where each came from', () => {
    const read = sources([BUNDLE])
    expect(read.map((s) => s.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(read.map((s) => s.sourceName)).toEqual([
      'sphere-sim-files.zip/warp/P1.data',
      'sphere-sim-files.zip/warp/P2.data',
      'sphere-sim-files.zip/warp/P3.data',
      'sphere-sim-files.zip/warp/P4.data',
    ])
    expect(read.every((s) => s.mesh.cols === 5 && s.mesh.rows === 5)).toBe(true)
  })

  it('never takes the previous calibration a restore point keeps beside it', () => {
    // The bundle's `restore/warp/P1.data` is a 4×4 export under the same name.
    expect(sources([BUNDLE])[0].text.startsWith('2\n5 5\n')).toBe(true)
    const onlyTheOld = archive([{ name: 'restore/warp/P1.data', text: MESH }])
    expect(refusalOf([onlyTheOld])).toEqual({ code: 'no-meshes', file: 'rig.zip' })
    const nested = archive([
      { name: 'warp/old/P1.data', text: MESH },
      { name: 'warp/P2.data', text: MESH },
    ])
    expect(sources([nested]).map((s) => s.id)).toEqual(['P2'])
  })

  it('reads nothing but the meshes — a compressed README beside them costs nothing', () => {
    const rig = archive([
      { name: 'README.txt', text: 'recompressed', method: 8 },
      { name: 'warp/P1.data', text: MESH },
    ])
    expect(sources([rig]).map((s) => s.id)).toEqual(['P1'])
  })

  it('refuses a mesh entry it cannot read, naming the archive and the entry', () => {
    const recompressed = archive([{ name: 'warp/P1.data', text: MESH, method: 8 }])
    expect(refusalOf([recompressed])).toMatchObject({
      code: 'archive',
      file: 'rig.zip',
      zip: { code: 'compressed', entry: 'warp/P1.data' },
    })
    expect(refusalOf([{ name: 'rig.zip', bytes: enc.encode(MESH) }])).toMatchObject({
      code: 'archive',
      zip: { code: 'not-a-zip' },
    })
  })

  it('refuses two entries for one projector, whichever case they are in', () => {
    const twice = archive([
      { name: 'warp/P1.data', text: MESH },
      { name: 'warp/P1.data', text: MESH },
    ])
    expect(refusalOf([twice])).toEqual({ code: 'duplicate-id', ids: ['P1'] })
    const cased = archive([
      { name: 'warp/P1.data', text: MESH },
      { name: 'warp/p1.data', text: MESH },
    ])
    expect(refusalOf([cased])).toEqual({ code: 'duplicate-id', ids: ['p1'] })
  })

  it('refuses an entry name that cannot be a projector id', () => {
    expect(refusalOf([archive([{ name: 'warp/\u0001.data', text: MESH }])])).toEqual({
      code: 'bad-name',
      file: 'rig.zip/warp/\u0001.data',
    })
  })
})

describe('readWarpSources — picked mesh files', () => {
  it('takes the id from each file name, in the order picked', () => {
    const read = sources([file('P3.data', MESH), file('P1.DATA', MESH), file('Projector 2.data', MESH)])
    expect(read.map((s) => s.id)).toEqual(['P3', 'P1', 'Projector 2'])
    expect(read.map((s) => s.sourceName)).toEqual(['P3.data', 'P1.DATA', 'Projector 2.data'])
    expect(read[0].text).toBe(MESH)
  })

  it('refuses a mesh that does not parse, naming the file and the line', () => {
    const broken = MESH.replace('0.75 0.25 1', '0.75 0.25')
    expect(refusalOf([file('P1.data', MESH), file('P2.data', broken)])).toMatchObject({
      code: 'mesh',
      file: 'P2.data',
      mesh: { code: 'bad-node', line: 6 },
    })
  })

  it('refuses a file that is not text', () => {
    expect(refusalOf([{ name: 'P1.data', bytes: Uint8Array.of(0x32, 0x0a, 0xff, 0xfe) }])).toEqual({
      code: 'not-text',
      file: 'P1.data',
    })
  })

  it('refuses names that cannot be ids, and ids that collide', () => {
    expect(refusalOf([file('.data', MESH)])).toEqual({ code: 'bad-name', file: '.data' })
    expect(refusalOf([file(' P1.data', MESH)])).toEqual({ code: 'bad-name', file: ' P1.data' })
    expect(refusalOf([file('P1.data', MESH), file('p1.data', MESH)])).toEqual({ code: 'duplicate-id', ids: ['p1'] })
  })
})

describe('readWarpSources — what was picked', () => {
  it('refuses nothing, too much, or an archive with company', () => {
    expect(refusalOf([])).toEqual({ code: 'nothing-picked' })
    const huge = { name: 'P1.data', bytes: new Uint8Array(MAX_WARP_IMPORT_BYTES + 1) }
    expect(refusalOf([huge])).toEqual({ code: 'too-large', bytes: MAX_WARP_IMPORT_BYTES + 1 })
    expect(refusalOf([BUNDLE, file('P1.data', MESH)])).toEqual({ code: 'mixed-selection' })
    expect(refusalOf([BUNDLE, { ...BUNDLE, name: 'again.zip' }])).toEqual({ code: 'mixed-selection' })
  })

  it('refuses a file that is neither a bundle nor a mesh', () => {
    expect(refusalOf([file('P1.data', MESH), file('notes.txt', MESH)])).toEqual({
      code: 'unsupported-file',
      file: 'notes.txt',
    })
  })

  it('refuses more meshes than an output carries, before reading any', () => {
    const many = Array.from({ length: MAX_WARP_MESHES + 1 }, (_, i) => file(`P${i + 1}.data`, 'not a mesh'))
    expect(refusalOf(many)).toEqual({ code: 'too-many', count: MAX_WARP_MESHES + 1 })
  })
})

describe('assembleWarpSet', () => {
  it('places a bundle in SOS\'s quadrants when the operator says so, and checks it whole', () => {
    const assembled = assembleWarpSet(sources([BARE]), 'sos-quadrants')
    if (!assembled.ok) throw new Error(JSON.stringify(assembled.refusal))
    expect(assembled.set.layoutFrom).toBe('sos-quadrants')
    // Nothing said what the meshes address, and nothing is guessed.
    expect(assembled.set.texture).toBeNull()
    for (const mesh of assembled.set.meshes) {
      expect(mesh.viewport).toEqual(SOS_QUADRANT_VIEWPORTS[mesh.id as SosQuadrantId])
    }
    expect(assembled.placed).toHaveLength(4)
    expect(assembled.placed[2].viewport).toEqual(SOS_QUADRANT_VIEWPORTS.P3)
    expect(assembled.placed[2].mesh.cols).toBe(5)
    expect(assembled.id).toBe(warpSetId(assembled.set.meshes))
    expect(assembled.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('refuses ids the quadrants have no place for, rather than guessing one', () => {
    const placedRig = sources([file('P1.data', MESH), file('P5.data', MESH)])
    expect(assembleWarpSet(placedRig, 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'layout', reason: 'unplaceable', ids: ['P5'] },
    })
    const named = sources([file('Projector 1.data', MESH)])
    expect(assembleWarpSet(named, 'sos-quadrants')).toMatchObject({ refusal: { code: 'layout', ids: ['Projector 1'] } })
  })

  it("places by the bundle's own layout, carrying what it says the meshes address", () => {
    const read = readWarpSources([BUNDLE])
    if (!read.ok || read.layout === null) throw new Error('the bundle carries a layout')
    const assembled = assembleWarpSet(read.sources, read.layout)
    if (!assembled.ok) throw new Error(JSON.stringify(assembled.refusal))
    expect(assembled.set.layoutFrom).toBe('bundle')
    expect(assembled.set.texture).toEqual({ surface: 'sphere', rotationOffsetDeg: 0 })
    // The same meshes in the same places are the same set, however they
    // were placed: what a set addresses changes no pixel, so no id.
    const asked = assembleWarpSet(sources([BARE]), 'sos-quadrants')
    expect(asked.ok && asked.id).toBe(assembled.id)
  })

  it('refuses a layout and sources from different reads, rather than half-placing them', () => {
    const placed = layoutOf([PLACED])!
    expect(assembleWarpSet(sources([BUNDLE]), placed)).toEqual({
      ok: false,
      refusal: { code: 'layout', reason: 'unplaceable', ids: ['P3', 'P4'] },
    })
  })

  it('refuses two meshes for one quadrant, and an empty set', () => {
    const one = sources([file('P1.data', MESH)])[0]
    expect(assembleWarpSet([one, one], 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'layout', reason: 'duplicate', ids: ['P1'] },
    })
    expect(assembleWarpSet([], 'sos-quadrants')).toEqual({ ok: false, refusal: { code: 'set', set: { code: 'no-meshes' } } })
  })
})

describe("readWarpSources — a bundle's own layout (sphere-sim#52)", () => {
  it('reads the layout sphere-sim writes, and pairs each mesh with its viewport', () => {
    const layout = layoutOf([BUNDLE])
    expect(layout).toEqual({
      framebuffer: { width: 7680, height: 4320 },
      texture: { surface: 'sphere', rotationOffsetDeg: 0 },
      projectors: (['P1', 'P2', 'P3', 'P4'] as const).map((id) => ({ id, viewport: SOS_QUADRANT_VIEWPORTS[id] })),
    })
  })

  it('places a placed pair in halves at full height, where the quadrants would misplace it', () => {
    const read = readWarpSources([PLACED])
    if (!read.ok || read.layout === null) throw new Error('the placed bundle carries a layout')
    expect(read.layout.projectors).toEqual([
      { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 1 } },
      { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    ])
    const byLayout = assembleWarpSet(read.sources, read.layout)
    if (!byLayout.ok) throw new Error(JSON.stringify(byLayout.refusal))
    expect(byLayout.set.layoutFrom).toBe('bundle')
    expect(byLayout.set.meshes.map((m) => m.viewport)).toEqual(read.layout.projectors.map((p) => p.viewport))
    // SOS's quadrants take the same two ids without complaint — and put
    // them in the bottom row. Only the layout can say they are wrong.
    const byQuadrants = assembleWarpSet(read.sources, 'sos-quadrants')
    expect(byQuadrants.ok && byQuadrants.set.meshes.map((m) => m.viewport)).toEqual([
      SOS_QUADRANT_VIEWPORTS.P1,
      SOS_QUADRANT_VIEWPORTS.P2,
    ])
  })

  it('reads no layout from a bundle without one, from loose files, or from anywhere but the root', () => {
    expect(layoutOf([BARE])).toBeNull()
    expect(layoutOf([file('P1.data', MESH)])).toBeNull()
    expect(layoutOf([laidOut(layoutText(), 'config/layout.json')])).toBeNull()
    expect(layoutOf([laidOut(layoutText(), 'restore/layout.json')])).toBeNull()
  })

  it("reads a model's layout, whose rotation is null, and ignores fields it does not know", () => {
    const text = layoutText({ surface: 'mesh', rotationOffsetDeg: null, note: 'added within @1' })
    expect(layoutOf([laidOut(text)])?.texture).toEqual({ surface: 'mesh', rotationOffsetDeg: null })
    const withExtra = JSON.parse(layoutText())
    withExtra.projectors[0].serial = 'ABC-123'
    expect(layoutOf([laidOut(JSON.stringify(withExtra))])?.projectors).toHaveLength(2)
  })

  it('reads a layout that says its meshes address an equirectangular frame, as one that says nothing', () => {
    expect(layoutOf([laidOut(layoutText({ uv: 'equirectangular' }))])).toEqual(layoutOf([laidOut(layoutText())]))
    const model = layoutText({ surface: 'mesh', rotationOffsetDeg: null, uv: 'equirectangular' })
    expect(layoutOf([laidOut(model)])?.texture).toEqual({ surface: 'mesh', rotationOffsetDeg: null })
  })

  it('refuses a layout it cannot use, and never falls back to asking', () => {
    const problem = (text: string): unknown => {
      const refusal = refusalOf([laidOut(text)])
      if (refusal.code !== 'bundle-layout') throw new Error(`expected a layout refusal, got ${refusal.code}`)
      expect(refusal.file).toBe('rig.zip/layout.json')
      return refusal.problem
    }
    const base = JSON.parse(layoutText())
    const entry = (i: number, over: Record<string, unknown>) => ({ ...base.projectors[i], ...over })

    expect(problem('{ not json')).toEqual({ code: 'not-json' })
    expect(problem('[]')).toEqual({ code: 'not-json' })
    expect(problem(layoutText({ format: 'sphere-sim/projector-layout@2' }))).toEqual({
      code: 'format',
      format: 'sphere-sim/projector-layout@2',
    })
    expect(problem(layoutText({ origin: 'top-left' }))).toEqual({ code: 'origin' })
    for (const framebuffer of [{ width: 0, height: 1080 }, { width: 3840.5, height: 1080 }, { width: 3840 }, null]) {
      expect(problem(layoutText({ framebuffer })), JSON.stringify(framebuffer)).toEqual({ code: 'framebuffer' })
    }
    // A frame other than the one this build draws, said in any way at all.
    expect(problem(layoutText({ uv: 'fisheye' }))).toEqual({ code: 'uv', uv: 'fisheye' })
    expect(problem(layoutText({ surface: 'mesh', rotationOffsetDeg: null, uv: 'model' }))).toEqual({ code: 'uv', uv: 'model' })
    expect(problem(layoutText({ uv: 'Equirectangular' }))).toEqual({ code: 'uv', uv: 'Equirectangular' })
    expect(problem(layoutText({ uv: null }))).toEqual({ code: 'uv', uv: 'null' })
    expect(problem(layoutText({ uv: { projection: 'equirectangular' } }))).toEqual({
      code: 'uv',
      uv: '{"projection":"equirectangular"}',
    })
    expect(problem(layoutText({ rotationOffsetDeg: null }))).toEqual({ code: 'texture' })
    expect(problem(layoutText({ surface: 'mesh', rotationOffsetDeg: 30 }))).toEqual({ code: 'texture' })
    expect(problem(layoutText({ surface: 'dome' }))).toEqual({ code: 'texture' })
    expect(problem(layoutText({ projectors: {} }))).toEqual({ code: 'projectors' })
    expect(problem(layoutText({ projectors: [entry(0, { viewport: { x: 0, y: 0, w: '0.5', h: 1 } }), base.projectors[1]] }))).toEqual({
      code: 'projectors',
    })
    expect(problem(layoutText({ projectors: [entry(0, { mesh: 'warp/P9.data' }), base.projectors[1]] }))).toEqual({
      code: 'unknown-mesh',
      mesh: 'warp/P9.data',
    })
    // The restore point's copy is not a mesh of this archive either.
    expect(problem(layoutText({ projectors: [entry(0, { mesh: 'restore/warp/P1.data' }), base.projectors[1]] }))).toEqual({
      code: 'unknown-mesh',
      mesh: 'restore/warp/P1.data',
    })
    expect(problem(layoutText({ projectors: [base.projectors[0], base.projectors[0]] }))).toEqual({
      code: 'listed-twice',
      mesh: 'warp/P1.data',
    })
    expect(problem(layoutText({ projectors: [base.projectors[0]] }))).toEqual({ code: 'unlisted-mesh', mesh: 'warp/P2.data' })
    expect(problem(layoutText({ projectors: [entry(0, { id: 'P2' }), entry(1, { id: 'P1' })] }))).toEqual({
      code: 'id-mismatch',
      mesh: 'warp/P1.data',
      id: 'P2',
    })
  })

  it('refuses a layout whose viewports overlap or leave the display, before the panel draws it', () => {
    const base = JSON.parse(layoutText())
    const overlap = layoutText({ projectors: [{ ...base.projectors[0], viewport: { x: 0, y: 0, w: 0.6, h: 1 } }, base.projectors[1]] })
    expect(refusalOf([laidOut(overlap)])).toEqual({ code: 'set', set: { code: 'overlap', ids: ['P1', 'P2'] } })
    const outside = layoutText({ projectors: [base.projectors[0], { ...base.projectors[1], viewport: { x: 0.6, y: 0, w: 0.5, h: 1 } }] })
    expect(refusalOf([laidOut(outside)])).toMatchObject({ code: 'set', set: { code: 'bad-viewport' } })
  })
})

describe('a mesh made for a fisheye frame', () => {
  /** A one-projector dome as a bundle's layout would place it: the whole display. */
  const domeLayout = (over: Record<string, unknown> = {}): string =>
    layoutText({
      framebuffer: { width: 1920, height: 1080 },
      projectors: [{ id: 'P1', mesh: 'warp/P1.data', viewport: { x: 0, y: 0, w: 1, h: 1 } }],
      ...over,
    })
  const domeBundle = (over: Record<string, unknown> = {}): WarpImportFile =>
    archive([
      { name: 'layout.json', text: domeLayout(over) },
      { name: 'warp/P1.data', text: FISHEYE },
    ])

  it('is what it claims: a disc of fisheye texels, reaching its rim', () => {
    const parsed = parseWarpMesh(FISHEYE)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusal))
    const radii = parsed.mesh.nodes.filter((n) => n.drawable).map((n) => Math.hypot(n.u - 0.5, n.v - 0.5))
    expect(Math.max(...radii)).toBeCloseTo(0.5, 6)
  })

  it('imports like any other, because nothing in the file says what its (u, v) address', () => {
    // Loose, under a name SOS's quadrants can place, on the operator's answer;
    // and in a bundle whose layout says nothing about (u, v), as none does yet.
    const loose = assembleWarpSet(sources([file('P1.data', FISHEYE)]), 'sos-quadrants')
    const read = readWarpSources([domeBundle()])
    if (!read.ok || read.layout === null) throw new Error('the bundle carries a layout')
    const bundled = assembleWarpSet(read.sources, read.layout)
    for (const assembled of [loose, bundled]) {
      if (!assembled.ok) throw new Error(JSON.stringify(assembled.refusal))
      // And it draws. The width bound is the one geometric screen there is,
      // and it drops nothing: neighbouring texels are neighbouring
      // directions here too, the frame they come from is just the wrong one.
      const [stats] = buildWarpGeometry(assembled.placed).meshes
      expect(stats.triangles).toBeGreaterThan(0)
      expect(stats.droppedWide).toBe(0)
    }
  })

  it("is refused from a bundle that says what its (u, v) address, and the frame isn't equirect", () => {
    expect(refusalOf([domeBundle({ uv: 'fisheye' })])).toEqual({
      code: 'bundle-layout',
      file: 'rig.zip/layout.json',
      problem: { code: 'uv', uv: 'fisheye' },
    })
  })
})

describe('warpSetId', () => {
  const entries: WarpSetEntry[] = [
    { id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS.P1, text: MESH },
    { id: 'P2', viewport: SOS_QUADRANT_VIEWPORTS.P2, text: MESH.replace('0.25 0.75', '0.26 0.75') },
  ]

  it('is the content and placement, whatever order the files were picked in', () => {
    expect(warpSetId([...entries].reverse())).toBe(warpSetId(entries))
  })

  it('changes with a byte of any mesh, a swapped placement, or a renamed projector', () => {
    const base = warpSetId(entries)
    expect(warpSetId([entries[0], { ...entries[1], text: `${entries[1].text} ` }])).not.toBe(base)
    expect(
      warpSetId([
        { ...entries[0], viewport: entries[1].viewport },
        { ...entries[1], viewport: entries[0].viewport },
      ]),
    ).not.toBe(base)
    expect(warpSetId([{ ...entries[0], id: 'P3' }, entries[1]])).not.toBe(base)
  })

  it('ignores where a mesh came from, which is not part of what it draws', () => {
    const named = entries.map((e) => ({ ...e, sourceName: `elsewhere/${e.id}.data` }))
    expect(warpSetId(named)).toBe(warpSetId(entries))
  })

  it('holds its canonical form: a change here re-keys every stored set', () => {
    // Pinned, not derived from this module: computed independently from the
    // canonical form with Python's zlib.crc32 and a textbook FNV-1a, whose
    // own check values ('a' → e40c292c, 'foobar' → bf9cf968) it reproduces.
    expect(warpSetId([{ id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS.P1, text: MESH }])).toBe('c8e6838378a11cac')
  })
})
