// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The SPA's read of the node's feature toggles. One case reads an
 * answer; every other case is a way to fail, and each must come back
 * all-enabled — a node whose profile endpoint is slow, down, or not
 * there at all must not lose Orbit.
 */

import { describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../types/node-features'
import { fetchNodeFeatures } from './nodeFeatures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('fetchNodeFeatures', () => {
  it('reads the toggles off the public node profile', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ profile: null, features: { ...defaultFeatures(), orbit: false } }),
    )
    const features = await fetchNodeFeatures({ fetchFn })
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/node-profile', expect.anything())
    expect(features.orbit).toBe(false)
    expect(features.blog).toBe(true)
  })

  it('treats a payload without `features` (an older server) as all-enabled', async () => {
    const features = await fetchNodeFeatures({ fetchFn: async () => jsonResponse({ profile: null }) })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats a non-2xx as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => jsonResponse({ features: { orbit: false } }, 500),
    })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats an HTML body (a dev server with no functions) as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => new Response('<!doctype html><html></html>', { status: 200 }),
    })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats a network failure as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(features).toEqual(defaultFeatures())
  })

  it('gives up after the timeout, aborts the request, and answers all-enabled', async () => {
    let signal: AbortSignal | undefined
    const fetchFn = vi.fn((_path: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      // Never answers on its own — only the abort ends it.
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    })
    const features = await fetchNodeFeatures({ fetchFn, timeoutMs: 5 })
    expect(features).toEqual(defaultFeatures())
    expect(signal?.aborted).toBe(true)
  })
})
