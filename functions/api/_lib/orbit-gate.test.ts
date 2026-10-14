// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The `orbit` feature gate: when it closes, and — the half that
 * matters more — every way it stays open. A node that never touched
 * the toggle, a cached map written before `orbit` existed, and a
 * storage failure must all leave Orbit running.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../../../src/types/node-features'
import { NODE_FEATURES_CACHE_KEY } from '../v1/_lib/node-settings-store'
import { makeKV } from '../v1/_lib/test-helpers'
import {
  ORBIT_GATE_MEMO_MS,
  isOrbitEnabled,
  orbitDisabledResponse,
  resetOrbitGateForTests,
} from './orbit-gate'

function kvWith(features: Record<string, boolean>) {
  const kv = makeKV()
  kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify(features))
  return kv
}

const failingDb = {
  prepare: () => {
    throw new Error('d1 down')
  },
} as unknown as D1Database

beforeEach(resetOrbitGateForTests)

describe('isOrbitEnabled', () => {
  it('is on for a node with no catalog bindings at all', async () => {
    expect(await isOrbitEnabled({})).toBe(true)
  })

  it('is off when the node turned it off', async () => {
    const kv = kvWith({ ...defaultFeatures(), orbit: false })
    expect(await isOrbitEnabled({ CATALOG_KV: kv })).toBe(false)
  })

  it('is on when the node turned only other features off', async () => {
    const kv = kvWith({ ...defaultFeatures(), blog: false, events: false })
    expect(await isOrbitEnabled({ CATALOG_KV: kv })).toBe(true)
  })

  it('is on for a map cached before `orbit` existed', async () => {
    // A deploy that adds the key meets KV entries written by the one
    // before it, which never mention orbit. Absence means on.
    const kv = kvWith({ blog: false })
    expect(await isOrbitEnabled({ CATALOG_KV: kv })).toBe(true)
  })

  it('is on when storage fails on an isolate that has never read the map', async () => {
    const kv = makeKV()
    ;(kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'))
    expect(await isOrbitEnabled({ CATALOG_KV: kv, CATALOG_DB: failingDb })).toBe(true)
  })

  it('keeps its last real answer through a storage failure', async () => {
    const off = kvWith({ ...defaultFeatures(), orbit: false })
    expect(await isOrbitEnabled({ CATALOG_KV: off }, 0)).toBe(false)
    // Past the memo, storage is down: the default would say "on".
    const broken = makeKV()
    ;(broken.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'))
    expect(await isOrbitEnabled({ CATALOG_KV: broken, CATALOG_DB: failingDb }, ORBIT_GATE_MEMO_MS + 1)).toBe(false)
  })

  it('reuses a read for the memo window, then reads again', async () => {
    const kv = kvWith({ ...defaultFeatures(), orbit: false })
    expect(await isOrbitEnabled({ CATALOG_KV: kv }, 0)).toBe(false)
    expect(await isOrbitEnabled({ CATALOG_KV: kv }, ORBIT_GATE_MEMO_MS - 1)).toBe(false)
    expect(kv.get).toHaveBeenCalledTimes(1)
    // Re-enabled meanwhile: picked up once the memo lapses.
    kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify(defaultFeatures()))
    expect(await isOrbitEnabled({ CATALOG_KV: kv }, ORBIT_GATE_MEMO_MS)).toBe(true)
    expect(kv.get).toHaveBeenCalledTimes(2)
  })
})

describe('orbitDisabledResponse', () => {
  it('is a no-store 403 carrying the feature and both reason fields', async () => {
    const res = orbitDisabledResponse({ 'Access-Control-Allow-Origin': 'https://node.example' })
    expect(res.status).toBe(403)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://node.example')
    expect(await res.json()).toMatchObject({
      error: 'feature_disabled',
      code: 'feature_disabled',
      feature: 'orbit',
    })
  })
})
