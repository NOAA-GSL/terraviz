// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isOrbitRefusal,
  isOrbitWithdrawn,
  onOrbitWithdrawn,
  resetOrbitAvailabilityForTests,
  withdrawOrbit,
} from './orbitAvailability'

afterEach(resetOrbitAvailabilityForTests)

describe('isOrbitRefusal', () => {
  it("matches the orbit gate's envelope", () => {
    expect(isOrbitRefusal(403, { error: 'feature_disabled', code: 'feature_disabled', feature: 'orbit' })).toBe(true)
  })

  it('matches nothing else — Orbit may be pointed at another provider', () => {
    expect(isOrbitRefusal(403, { error: 'forbidden' })).toBe(false)
    expect(isOrbitRefusal(403, { error: 'feature_disabled', feature: 'blog' })).toBe(false)
    expect(isOrbitRefusal(503, { error: 'feature_disabled', feature: 'orbit' })).toBe(false)
    expect(isOrbitRefusal(403, null)).toBe(false)
    expect(isOrbitRefusal(403, 'feature_disabled')).toBe(false)
  })
})

describe('withdrawOrbit', () => {
  it('tells every listener once, and stays withdrawn', () => {
    const a = vi.fn()
    const b = vi.fn()
    onOrbitWithdrawn(a)
    onOrbitWithdrawn(b)
    expect(isOrbitWithdrawn()).toBe(false)
    withdrawOrbit('recheck')
    withdrawOrbit('chat')
    expect(isOrbitWithdrawn()).toBe(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('recheck')
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not let a throwing listener stop the others', () => {
    const after = vi.fn()
    onOrbitWithdrawn(() => {
      throw new Error('broken listener')
    })
    onOrbitWithdrawn(after)
    withdrawOrbit('voice')
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('does not call a listener that unsubscribed', () => {
    const gone = vi.fn()
    const unsubscribe = onOrbitWithdrawn(gone)
    unsubscribe()
    withdrawOrbit('chat')
    expect(gone).not.toHaveBeenCalled()
  })
})
