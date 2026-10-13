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

type Listener = (event: Record<string, unknown>) => void

function loadWorker(existingCaches: string[] = []) {
  const listeners = new Map<string, Listener>()
  const cache = {
    match: vi.fn(async () => undefined),
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

  return { caches, fetchFn, dispatchFetch, dispatchLifecycle }
}

describe('public/sw.js', () => {
  it('serves a proxied GIBS tile cache-first', async () => {
    // The positive anchor: without it, a worker that failed to register
    // a fetch listener at all would pass every "not intercepted" case.
    const { dispatchFetch, fetchFn } = loadWorker()
    const respondWith = await dispatchFetch(TILE_URL)
    expect(respondWith).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the cloud texture this device loads', getCloudTextureUrl()],
    ['the desktop cloud texture', `${S3_BUCKET}/clouds_8192.jpg`],
    ['the mobile cloud texture', `${S3_BUCKET}/clouds_4096.jpg`],
    // Expired on its own TTL by dataService.ts; a frozen copy defeats it.
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
