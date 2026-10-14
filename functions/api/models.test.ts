// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /api/models — the "Test Connection" health check, and its answer
 * while the node's `orbit` feature is off.
 */

import { describe, expect, it } from 'vitest'
import { defaultFeatures } from '../../src/types/node-features'
import { NODE_FEATURES_CACHE_KEY } from './v1/_lib/node-settings-store'
import { makeKV } from './v1/_lib/test-helpers'
import { onRequestGet } from './models'

function ctx(env: Record<string, unknown>) {
  // A stub rather than a real Request: `Origin` is a forbidden header
  // that happy-dom strips (same reason as completions.test.ts).
  const request = {
    url: 'https://node.example/api/models',
    headers: { get: (n: string) => (n.toLowerCase() === 'origin' ? 'https://node.example' : null) },
  } as unknown as Request
  return { request, env } as unknown as Parameters<typeof onRequestGet>[0]
}

function kvWith(features: Record<string, boolean>) {
  const kv = makeKV()
  kv._store.set(NODE_FEATURES_CACHE_KEY, JSON.stringify(features))
  return kv
}

describe('GET /api/models', () => {
  it('lists the models while Orbit is on', async () => {
    const res = await onRequestGet(ctx({ AI: {}, CATALOG_KV: kvWith(defaultFeatures()) }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string }> }
    expect(body.data.map(m => m.id)).toContain('llama-4-scout')
  })

  it('answers 403 feature_disabled while Orbit is off', async () => {
    const res = await onRequestGet(ctx({ AI: {}, CATALOG_KV: kvWith({ ...defaultFeatures(), orbit: false }) }))
    expect(res.status).toBe(403)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://node.example')
    expect(await res.json()).toMatchObject({ error: 'feature_disabled', feature: 'orbit' })
  })

  it('reports the missing binding, not the feature, on a node that left Orbit on', async () => {
    const res = await onRequestGet(ctx({ CATALOG_KV: kvWith(defaultFeatures()) }))
    expect(res.status).toBe(503)
  })
})
