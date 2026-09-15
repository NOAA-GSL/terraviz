// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's media ownership.
 *
 * Every case here is a way a sphere in a gallery misbehaves: a stutter
 * on a palette change, a black flash between datasets, the wrong
 * dataset winning a race, or a decoder left running after teardown.
 */

import { describe, it, expect, vi } from 'vitest'

import {
  createDatasetMirror,
  isHlsManifest,
  needsReload,
  type MediaLoader,
  type MediaSource,
} from './datasetMirror'
import { until } from '../test-utils'
import type { MirroredDataset } from '../services/multiOutput/protocol'

function dataset(over: Partial<MirroredDataset> = {}): MirroredDataset {
  return {
    id: 'SST',
    url: 'https://cdn.example/sst.m3u8',
    kind: 'video',
    overlay: { datasetId: 'SST' },
    startTime: null,
    endTime: null,
    ...over,
  }
}

/** A loader whose every load is resolved by hand, so the race is real. */
function deferredLoader() {
  const pending: { url: string; resolve: (s: MediaSource) => void; reject: (e: Error) => void }[] = []
  const disposed: string[] = []
  const loader: MediaLoader = {
    load: ds =>
      new Promise<MediaSource>((resolve, reject) => {
        pending.push({ url: ds.url, resolve, reject })
      }),
  }
  const source = (tag: string): MediaSource => ({
    kind: 'video',
    element: { tag } as unknown as HTMLVideoElement,
    video: null,
    dispose: () => disposed.push(tag),
  })
  return { loader, pending, disposed, source }
}

/** A loader that resolves immediately, tagged by URL. */
function instantLoader() {
  const disposed: string[] = []
  const loads: string[] = []
  const loader: MediaLoader = {
    load: async ds => {
      loads.push(ds.url)
      return {
        kind: ds.kind,
        element: {} as HTMLVideoElement,
        video: null,
        dispose: () => disposed.push(ds.url),
      }
    },
  }
  return { loader, disposed, loads }
}

describe('needsReload', () => {
  it('is false when only the overlay changed', () => {
    // The palette lives in `overlay.colorScale`, which the shader reads
    // and the decoder does not. Reloading for it stutters the sphere.
    const a = dataset()
    const b = dataset({ overlay: { datasetId: 'SST', datasetTitle: 'Renamed' } })
    expect(needsReload(a, b)).toBe(false)
  })

  it('is true when the url or kind changed', () => {
    expect(needsReload(dataset(), dataset({ url: 'https://cdn.example/other.m3u8' }))).toBe(true)
    expect(needsReload(dataset(), dataset({ kind: 'image' }))).toBe(true)
  })

  it('handles the empty transitions', () => {
    expect(needsReload(null, dataset())).toBe(true)
    expect(needsReload(dataset(), null)).toBe(true)
    expect(needsReload(null, null)).toBe(false)
  })
})

describe('reloading', () => {
  it('does not reload for a metadata-only change, but takes the metadata', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(dataset({ overlay: { datasetId: 'SST', datasetTitle: 'Renamed' } }))

    expect(loads).toHaveLength(1)
    expect(mirror.currentDataset()?.overlay.datasetTitle).toBe('Renamed')
  })

  it('reloads when the URL changes', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(dataset({ id: 'CHL', url: 'https://cdn.example/chl.m3u8' }))

    expect(loads).toEqual(['https://cdn.example/sst.m3u8', 'https://cdn.example/chl.m3u8'])
    expect(mirror.currentDataset()?.id).toBe('CHL')
  })
})

describe('swapping', () => {
  it('keeps the old picture up until the new one is ready', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const first = mirror.apply(dataset())
    pending[0].resolve(source('first'))
    await first

    const second = mirror.apply(dataset({ url: 'https://cdn.example/chl.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')

    // Mid-load: the outgoing source is still installed and undisposed.
    // Disposing here is what gives a black flash on a projector.
    expect(mirror.current()?.element).toEqual({ tag: 'first' })
    expect(disposed).toEqual([])

    pending[1].resolve(source('second'))
    await second

    expect(mirror.current()?.element).toEqual({ tag: 'second' })
    expect(disposed).toEqual(['first'])
  })

  it('keeps the last good picture when a load fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const first = mirror.apply(dataset())
    pending[0].resolve(source('first'))
    await first

    const second = mirror.apply(dataset({ url: 'https://cdn.example/gone.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')
    pending[1].reject(new Error('404'))

    // Resolves rather than rejecting: an output has no caller to report
    // to, so a failure must not escape into the render loop.
    await expect(second).resolves.toBeUndefined()
    expect(mirror.current()?.element).toEqual({ tag: 'first' })
    expect(mirror.currentDataset()?.id).toBe('SST')
    expect(disposed).toEqual([])
  })

  it('clears on a null dataset', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(null)

    expect(mirror.current()).toBeNull()
    expect(mirror.currentDataset()).toBeNull()
    expect(disposed).toEqual(['https://cdn.example/sst.m3u8'])
  })
})

describe('racing loads', () => {
  it('lets the newest apply win, whatever order they resolve in', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })

    const a = mirror.apply(dataset({ id: 'A', url: 'https://cdn.example/a.m3u8' }))
    await until(() => pending.length === 1, 'the first load to start')
    const b = mirror.apply(dataset({ id: 'B', url: 'https://cdn.example/b.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')

    // B resolves first, then the slower A. Without a generation the
    // late A would install and the operator would be left on whichever
    // dataset happened to be slowest.
    pending[1].resolve(source('B'))
    pending[0].resolve(source('A'))
    await Promise.all([a, b])

    expect(mirror.currentDataset()?.id).toBe('B')
    expect(mirror.current()?.element).toEqual({ tag: 'B' })
    // The loser is released rather than leaked — it holds a decoder.
    expect(disposed).toEqual(['A'])
  })
})

describe('dispose', () => {
  it('releases the current source', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    mirror.dispose()

    expect(mirror.current()).toBeNull()
    expect(disposed).toEqual(['https://cdn.example/sst.m3u8'])
  })

  it('releases a load that lands after teardown', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const inFlight = mirror.apply(dataset())
    await until(() => pending.length === 1, 'the load to start')

    mirror.dispose()
    pending[0].resolve(source('late'))
    await inFlight

    // The window may be gone, but the decoder it built is real.
    expect(disposed).toEqual(['late'])
    expect(mirror.current()).toBeNull()
  })

  it('ignores an apply after teardown', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    mirror.dispose()

    await mirror.apply(dataset())

    expect(loads).toEqual([])
  })

  it('is idempotent', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    mirror.dispose()
    mirror.dispose()

    expect(disposed).toHaveLength(1)
  })

  it('survives a dispose that throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader: MediaLoader = {
      load: async () => ({
        kind: 'video',
        element: {} as HTMLVideoElement,
        video: null,
        dispose: () => {
          throw new Error('decoder stuck')
        },
      }),
    }
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    expect(() => mirror.dispose()).not.toThrow()
    expect(mirror.current()).toBeNull()
  })
})

describe('sync', () => {
  it('is inert for an image, which has no playhead', async () => {
    const loader: MediaLoader = {
      load: async () => ({
        kind: 'image',
        element: {} as HTMLImageElement,
        video: null,
        dispose: () => {},
      }),
    }
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset({ kind: 'image', url: 'https://cdn.example/x.jpg' }))

    const out = mirror.sync({
      dataset: mirror.currentDataset(),
      primary: { duration: 10, rangeMs: 1000 },
      playback: { date: '2026-01-01T00:00:00.000Z', positionRatio: 0.5, paused: false, playbackRate: 1 },
    })

    expect(out.kind).toBe('not-ready')
  })

  it('is inert with nothing loaded', () => {
    const mirror = createDatasetMirror({ loader: instantLoader().loader })
    expect(mirror.sync({ dataset: null, primary: null, playback: null }).kind).toBe('not-ready')
  })
})

describe('isHlsManifest', () => {
  it('recognises a manifest', () => {
    expect(isHlsManifest('https://cdn.example/a.m3u8')).toBe(true)
    expect(isHlsManifest('https://cdn.example/A.M3U8')).toBe(true)
  })

  it('looks past a query string, as a signed CDN URL has', () => {
    // `…m3u8?token=…` is the normal shape from a signing CDN. A bare
    // `endsWith('.m3u8')` sends every one of them down the progressive
    // path, where hls.js never sees the manifest.
    expect(isHlsManifest('https://cdn.example/a.m3u8?token=abc&exp=1')).toBe(true)
    expect(isHlsManifest('https://cdn.example/a.m3u8#t=10')).toBe(true)
  })

  it('rejects a progressive file', () => {
    expect(isHlsManifest('https://cdn.example/a.mp4')).toBe(false)
    expect(isHlsManifest('https://cdn.example/m3u8.mp4')).toBe(false)
  })
})
