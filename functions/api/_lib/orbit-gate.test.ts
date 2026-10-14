// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The `orbit` feature gate: when it closes, and — the half that
 * matters more — every way it stays open. A node that never touched
 * the toggle, a cached map written before `orbit` existed, and a
 * storage failure must all leave Orbit running.
 */

import { describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../../../src/types/node-features'
import { NODE_FEATURES_CACHE_KEY } from '../v1/_lib/node-settings-store'
import { makeKV } from '../v1/_lib/test-helpers'
import { isOrbitEnabled, orbitDisabledResponse } from './orbit-gate'

function kvWith(features: Record<string, boolean>) {
  const kv = makeKV()
  kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify(features))
  return kv
}

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

  it('is on when storage fails', async () => {
    const kv = makeKV()
    ;(kv.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kv down'))
    const db = {
      prepare: () => {
        throw new Error('d1 down')
      },
    } as unknown as D1Database
    expect(await isOrbitEnabled({ CATALOG_KV: kv, CATALOG_DB: db })).toBe(true)
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
