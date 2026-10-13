// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pins the scope of `public/sw.js`, which lives outside `src/` (it is
 * served as-is, and a test beside it would ship in the deploy) and is
 * therefore evaluated here against a fake worker global.
 *
 * The worker is cache-first with no expiry, so the property worth
 * pinning is what it must *not* claim: anything whose bytes change.
 * The cloud texture is a live feed rewritten about every ten minutes,
 * and serving it cache-first froze every returning visitor's clouds
 * at their first visit.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getCloudTextureUrl } from './utils/deviceCapability'

const SW_SOURCE = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf-8')
const ORIGIN = 'https://node.example'
const S3_BUCKET = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov'
const TILE_URL =
  `${ORIGIN}/api/tile/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg`
const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'

type Listener = (event: Record<string, unknown>) => void

function loadWorker(existingCaches: string[] = []) {
  const listeners = new Map<string, Listener>()
  const cache = {
    match: vi.fn(async (): Promise<Response | undefined> => undefined),
    put: vi.fn(async () => {}),
  }
  const caches = {
    open: vi.fn(async (_name: string) => cache),
    keys: vi.fn(async () => existingCaches),
    delete: vi.fn(async (_name: string) => true),
  }
  const fetchFn = vi.fn(async () => new Response('tile', { status: 200 }))
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
  }
  new Function('self', 'caches', 'fetch', SW_SOURCE)(self, caches, fetchFn)

  const dispatchFetch = async (url: string) => {
    const respondWith = vi.fn()
    const request = { method: 'GET', url, cache: 'default', clone: () => request }
    listeners.get('fetch')!({ request, respondWith })
    if (respondWith.mock.calls.length > 0) await respondWith.mock.calls[0][0]
    return respondWith
  }

  const dispatchLifecycle = async (type: 'install' | 'activate') => {
    const pending: Promise<unknown>[] = []
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => pending.push(p) })
    await Promise.all(pending)
  }

  return { cache, caches, fetchFn, dispatchFetch, dispatchLifecycle }
}

describe('public/sw.js', () => {
  it('fetches and stores a proxied GIBS tile it does not hold', async () => {
    // The positive anchor: without it, a worker that failed to register
    // a fetch listener at all would pass every "not intercepted" case.
    const { cache, dispatchFetch, fetchFn } = loadWorker()
    const respondWith = await dispatchFetch(TILE_URL)
    expect(respondWith).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it('answers a stored tile without the network', async () => {
    const { cache, dispatchFetch, fetchFn } = loadWorker()
    const stored = new Response('stored', { status: 200 })
    cache.match.mockResolvedValueOnce(stored)
    const respondWith = await dispatchFetch(TILE_URL)
    expect(await respondWith.mock.calls[0][0]).toBe(stored)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    ['Blue Marble', `${GIBS_WMTS}/BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg`],
    ['Black Marble', `${GIBS_WMTS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/0/0/0.png`],
  ])('intercepts a direct %s tile from GIBS', async (_label, url) => {
    const { dispatchFetch } = loadWorker()
    expect(await dispatchFetch(url)).toHaveBeenCalledTimes(1)
  })

  it.each([
    // Daily imagery: the same URL shape as the basemaps, different bytes each day.
    ['a daily GIBS layer', `${GIBS_WMTS}/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-10-13/GoogleMapsCompatible_Level9/0/0/0.jpg`],
    ['the cloud texture this device loads', getCloudTextureUrl()],
    ['the desktop cloud texture', `${S3_BUCKET}/clouds_8192.jpg`],
    ['the mobile cloud texture', `${S3_BUCKET}/clouds_4096.jpg`],
    // Changes on every upstream publish; a frozen copy defeats dataService's TTL.
    ['the SOS catalog', `${S3_BUCKET}/dataset.json`],
  ])('leaves %s to the browser HTTP cache', async (_label, url) => {
    const { dispatchFetch } = loadWorker()
    const respondWith = await dispatchFetch(url)
    expect(respondWith).not.toHaveBeenCalled()
  })

  it('evicts the v4 cache, which holds frozen cloud textures', async () => {
    const { caches, dispatchLifecycle } = loadWorker(['gibs-tiles-v4'])
    await dispatchLifecycle('install')
    const current = caches.open.mock.calls[0][0]
    expect(current).not.toBe('gibs-tiles-v4')

    caches.keys.mockResolvedValue(['gibs-tiles-v4', current])
    await dispatchLifecycle('activate')
    expect(caches.delete).toHaveBeenCalledWith('gibs-tiles-v4')
    expect(caches.delete).not.toHaveBeenCalledWith(current)
  })
})
