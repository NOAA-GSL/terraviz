// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

import { gotoApp, isSameOrigin } from './browser'

describe('isSameOrigin', () => {
  const base = 'https://terraviz.zyra-project.org'

  it('is true for same-origin URLs (any path/query)', () => {
    expect(isSameOrigin('https://terraviz.zyra-project.org/', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/publish/datasets', base)).toBe(true)
    expect(isSameOrigin('https://terraviz.zyra-project.org/api/v1/publish/me?x=1', base)).toBe(true)
  })

  it('is false for third-party origins (so the token never leaks)', () => {
    expect(isSameOrigin('https://tiles.openfreemap.org/planet', base)).toBe(false)
    expect(isSameOrigin('https://gibs.earthdata.nasa.gov/x.png', base)).toBe(false)
    // A look-alike host must not match (exact origin, not prefix).
    expect(isSameOrigin('https://terraviz.zyra-project.org.evil.com/', base)).toBe(false)
  })

  it('distinguishes scheme and port', () => {
    expect(isSameOrigin('http://terraviz.zyra-project.org/', base)).toBe(false)
    expect(isSameOrigin('https://terraviz.zyra-project.org:8443/', base)).toBe(false)
  })

  it('is false for a malformed URL rather than throwing', () => {
    expect(isSameOrigin('not a url', base)).toBe(false)
  })
})

describe('gotoApp', () => {
  it('waits for the boot splash before handing back', async () => {
    // The wait is the whole reason a capture is not of a loading
    // screen. Asserting it happens is not fussiness: the fake Page in
    // these tests used to carry only `goto`, so the call threw a
    // TypeError that `settleBootSplash`'s bare catch swallowed — every
    // case here passed while the behaviour was never once exercised.
    const goto = vi.fn().mockResolvedValue(null)
    const waitForFunction = vi.fn().mockResolvedValue(null)

    await gotoApp({ goto, waitForFunction } as unknown as Page, '/')

    expect(waitForFunction).toHaveBeenCalledTimes(1)
  })

  it('carries on when the splash never finishes', async () => {
    // Boot genuinely does not complete offline on some routes, and a
    // splash is the honest shot there. Failing the capture would turn
    // "this page did not boot" into "there is no screenshot".
    const goto = vi.fn().mockResolvedValue(null)
    const waitForFunction = vi
      .fn()
      .mockRejectedValue(new Error('page.waitForFunction: Timeout 10000ms exceeded.'))

    await expect(
      gotoApp({ goto, waitForFunction } as unknown as Page, '/'),
    ).resolves.toBeUndefined()
  })

  it('does not swallow a non-timeout failure', async () => {
    // The bug this file taught: a bare catch turns a missing method
    // into a silently inert helper.
    const goto = vi.fn().mockResolvedValue(null)
    const waitForFunction = vi.fn().mockRejectedValue(new TypeError('not a function'))

    await expect(
      gotoApp({ goto, waitForFunction } as unknown as Page, '/'),
    ).rejects.toThrow(TypeError)
  })


  it('uses a 60s ceiling and waits only for domcontentloaded', async () => {
    const goto = vi.fn().mockResolvedValue(null)
    const waitForFunction = vi.fn().mockResolvedValue(null)
    await gotoApp({ goto, waitForFunction } as unknown as Page, '/?catalog=true')
    expect(goto).toHaveBeenCalledTimes(1)
    expect(goto).toHaveBeenCalledWith('/?catalog=true', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
  })

  it('retries once when the first navigation times out (the catalog flake)', async () => {
    const waitForFunction = vi.fn().mockResolvedValue(null)
    const goto = vi
      .fn()
      .mockRejectedValueOnce(new Error('page.goto: Timeout 60000ms exceeded.'))
      .mockResolvedValueOnce(null)
    await gotoApp({ goto, waitForFunction } as unknown as Page, '/?catalog=true')
    expect(goto).toHaveBeenCalledTimes(2)
  })

  it('does not retry — and rethrows — a non-timeout navigation error', async () => {
    const waitForFunction = vi.fn().mockResolvedValue(null)
    const goto = vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
    await expect(
      gotoApp({ goto, waitForFunction } as unknown as Page, '/?catalog=true'),
    ).rejects.toThrow('ERR_CONNECTION_REFUSED')
    expect(goto).toHaveBeenCalledTimes(1)
  })
})
