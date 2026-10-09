// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SOS_QUADRANT_VIEWPORTS } from '../../output/projectorWarp'
import { assembleWarpSet, readWarpSources, warpSetId, type WarpSet } from './warpImport'
import {
  WARP_SET_KEY_PREFIX,
  WARP_SET_VERSION,
  createWarpSetStore,
  type WarpStorageLike,
} from './warpStorage'

/** The smallest mesh the parser accepts: 2×2, 16:9, every node drawn. */
const MESH = ['2', '2 2', '-1.777778 1 0.25 0.75 1', '1.777778 1 0.75 0.75 1', '-1.777778 -1 0.25 0.25 1', '1.777778 -1 0.75 0.25 1', ''].join('\n')

const SET: WarpSet = {
  layoutFrom: 'sos-quadrants',
  texture: null,
  meshes: [
    { id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS.P1, text: MESH, sourceName: 'P1.data' },
    { id: 'P2', viewport: SOS_QUADRANT_VIEWPORTS.P2, text: MESH, sourceName: 'P2.data' },
  ],
}
const ID = warpSetId(SET.meshes)

/** `Storage`, as far as this module uses it, over a Map — insertion-ordered like the real one. */
function memoryStorage(options: { setItem?: (key: string, value: string) => void } = {}): WarpStorageLike & {
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: options.setItem ?? ((key, value) => void map.set(key, value)),
    removeItem: (key) => void map.delete(key),
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('createWarpSetStore', () => {
  it('reads back what it wrote, re-checked and placed', () => {
    const storage = memoryStorage()
    const store = createWarpSetStore(storage)

    expect(store.write(ID, SET, '2026-09-29T12:00:00.000Z')).toEqual({ ok: true })
    expect([...storage.map.keys()]).toEqual([WARP_SET_KEY_PREFIX + ID])

    const read = store.read(ID)
    if (!read.ok) throw new Error(read.reason)
    expect(read.set).toEqual({ version: WARP_SET_VERSION, importedAt: '2026-09-29T12:00:00.000Z', ...SET })
    expect(read.placed.map((p) => p.viewport)).toEqual([SOS_QUADRANT_VIEWPORTS.P1, SOS_QUADRANT_VIEWPORTS.P2])
    expect(read.placed[0].mesh.cols).toBe(2)
  })

  it("carries sphere-sim's own bundle through import, storage and back, layout and all", () => {
    const bundle = new Uint8Array(
      readFileSync(resolve(__dirname, '../../output/fixtures/projectorWarp/sphere-sim-bundle.zip')),
    )
    const sources = readWarpSources([{ name: 'sphere-sim-files.zip', bytes: bundle }])
    if (!sources.ok || sources.layout === null) throw new Error('the bundle carries a layout')
    const assembled = assembleWarpSet(sources.sources, sources.layout)
    if (!assembled.ok) throw new Error(assembled.refusal.code)
    const store = createWarpSetStore(memoryStorage())

    store.write(assembled.id, assembled.set, '2026-09-29T12:00:00.000Z')
    const read = store.read(assembled.id)

    expect(read.ok && read.placed.length).toBe(4)
    expect(read.ok && read.set.layoutFrom).toBe('bundle')
    expect(read.ok && read.set.texture).toEqual({ surface: 'sphere', rotationOffsetDeg: 0 })
  })

  it('reads a set stored before textures were as saying nothing', () => {
    const storage = memoryStorage()
    const { texture: _, ...before } = { version: WARP_SET_VERSION, importedAt: 'x', ...SET }
    storage.map.set(WARP_SET_KEY_PREFIX + ID, JSON.stringify(before))

    const read = createWarpSetStore(storage).read(ID)

    expect(read.ok && read.set.texture).toBeNull()
  })

  it('finds nothing where nothing was written, or under an id no import could write', () => {
    const store = createWarpSetStore(memoryStorage())
    expect(store.read(ID)).toEqual({ ok: false, reason: 'missing' })
    expect(store.read('../config')).toEqual({ ok: false, reason: 'missing' })
    expect(createWarpSetStore(null).read(ID)).toEqual({ ok: false, reason: 'missing' })
  })

  it('refuses a stored value it did not write, rather than half-reading it', () => {
    const storage = memoryStorage()
    const store = createWarpSetStore(storage)
    const stored = (value: unknown): void => void storage.map.set(WARP_SET_KEY_PREFIX + ID, JSON.stringify(value))
    const good = { version: WARP_SET_VERSION, importedAt: 'x', ...SET }

    storage.map.set(WARP_SET_KEY_PREFIX + ID, '{not json')
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    stored({ ...good, version: WARP_SET_VERSION + 1 })
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    stored({ ...good, layoutFrom: 'guessed' })
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    stored({ ...good, meshes: [{ ...SET.meshes[0], viewport: { x: 0, y: 0, w: '0.5', h: 0.5 } }] })
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    // A texture is not in the content id, so its shape is what is checked:
    // the two pairs sphere-sim writes, and only on a set its layout placed.
    for (const texture of [
      { surface: 'sphere', rotationOffsetDeg: null },
      { surface: 'mesh', rotationOffsetDeg: 12 },
      { surface: 'dome', rotationOffsetDeg: 0 },
      'sphere',
    ]) {
      stored({ ...good, layoutFrom: 'bundle', texture })
      expect(store.read(ID), JSON.stringify(texture)).toEqual({ ok: false, reason: 'unreadable' })
    }
    stored({ ...good, layoutFrom: 'bundle', texture: null })
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    stored({ ...good, layoutFrom: 'sos-quadrants', texture: { surface: 'sphere', rotationOffsetDeg: 0 } })
    expect(store.read(ID)).toEqual({ ok: false, reason: 'unreadable' })
    stored({ ...good, layoutFrom: 'bundle', texture: { surface: 'mesh', rotationOffsetDeg: null } })
    expect(store.read(ID).ok).toBe(true)
  })

  it('refuses a set that changed after it was written', () => {
    const storage = memoryStorage()
    const store = createWarpSetStore(storage)
    store.write(ID, SET, 'x')
    const key = WARP_SET_KEY_PREFIX + ID
    // Still valid JSON and still a mesh — a flipped digit — which only the
    // content id can see.
    storage.map.set(key, (storage.map.get(key) as string).replace('0.25 0.75', '0.26 0.75'))

    expect(store.read(ID)).toEqual({ ok: false, reason: 'altered' })
  })

  it('refuses a set the warp check refuses, and says how', () => {
    const overlapping = [
      { ...SET.meshes[0], viewport: { x: 0, y: 0, w: 0.6, h: 1 } },
      { ...SET.meshes[1], viewport: { x: 0.5, y: 0, w: 0.5, h: 1 } },
    ]
    const id = warpSetId(overlapping)
    const store = createWarpSetStore(memoryStorage())
    store.write(id, { ...SET, meshes: overlapping }, 'x')

    expect(store.read(id)).toEqual({ ok: false, reason: 'refused', refusal: { code: 'overlap', ids: ['P1', 'P2'] } })
  })

  it('reports a full quota as no room, and anything else as unavailable', () => {
    const full = memoryStorage({
      setItem: () => {
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
      },
    })
    expect(createWarpSetStore(full).write(ID, SET, 'x')).toEqual({ ok: false, reason: 'no-room' })
    const firefoxFull = memoryStorage({
      setItem: () => {
        throw Object.assign(new Error('full'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })
      },
    })
    expect(createWarpSetStore(firefoxFull).write(ID, SET, 'x')).toEqual({ ok: false, reason: 'no-room' })
    const denied = memoryStorage({
      setItem: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      },
    })
    expect(createWarpSetStore(denied).write(ID, SET, 'x')).toEqual({ ok: false, reason: 'unavailable' })
    expect(createWarpSetStore(null).write(ID, SET, 'x')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('lists and removes only its own keys', () => {
    const storage = memoryStorage()
    storage.map.set('sos-multi-output-config', '{}')
    const store = createWarpSetStore(storage)
    const other = warpSetId([SET.meshes[0]])
    store.write(ID, SET, 'x')
    store.write(other, { ...SET, meshes: [SET.meshes[0]] }, 'x')

    expect(store.list().sort()).toEqual([ID, other].sort())
    store.remove(ID)
    store.remove('sos-multi-output-config')
    expect(store.list()).toEqual([other])
    expect(storage.map.has('sos-multi-output-config')).toBe(true)
  })

  it('never throws from a removal or a listing', () => {
    const broken: WarpStorageLike = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('locked')
      },
      get length(): number {
        throw new Error('locked')
      },
      key: () => null,
    }
    const store = createWarpSetStore(broken)
    expect(() => store.remove(ID)).not.toThrow()
    expect(store.list()).toEqual([])
  })
})
