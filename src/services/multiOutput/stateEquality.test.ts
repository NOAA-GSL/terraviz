// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the equality both ends of the link share.
 *
 * The properties here are not general-purpose deep-equal properties.
 * Each one is a specific way the multi-output link fails if it is
 * wrong, so they are written against that failure rather than against
 * the algorithm.
 */

import { describe, it, expect } from 'vitest'

import { hasOwn, sameValue } from './stateEquality'

describe('sameValue', () => {
  it('ignores key order', () => {
    // The failure this prevents: the control window and the output
    // build the same bundle from different call sites, in different
    // orders. A key-order-sensitive compare (`JSON.stringify`) calls
    // them different and re-broadcasts forever.
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameValue({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } })).toBe(true)
  })

  it('compares all the way down', () => {
    const overlay = { datasetId: 'd', boundingBox: { n: 1, s: -1, w: -2, e: 2 } }
    expect(sameValue({ overlay }, { overlay: structuredClone(overlay) })).toBe(true)
    expect(
      sameValue({ overlay }, { overlay: { ...overlay, boundingBox: { n: 9, s: -1, w: -2, e: 2 } } }),
    ).toBe(false)
  })

  it('separates a missing key from a present one', () => {
    // An object with fewer keys is not equal to one with more, even
    // when every shared key matches — otherwise a dataset that gained
    // `startTime` would compare equal to one without it.
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(false)
  })

  it('does not treat null as an object', () => {
    expect(sameValue(null, {})).toBe(false)
    expect(sameValue({}, null)).toBe(false)
    expect(sameValue(null, null)).toBe(true)
  })

  it('keeps arrays and objects distinct', () => {
    // `layers` is an array whose *order is z-order*. An implementation
    // that compared it as a plain object would call `[a, b]` equal to
    // `{0: a, 1: b}` and, worse, miss a reorder.
    expect(sameValue([], {})).toBe(false)
    expect(sameValue({}, [])).toBe(false)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue(['a'], ['a', 'b'])).toBe(false)
  })

  it('is true for a value compared with itself', () => {
    const held = { dataset: { id: 'x' } }
    expect(sameValue(held, held)).toBe(true)
  })

  it('distinguishes primitives that coerce to each other', () => {
    expect(sameValue(0, '0')).toBe(false)
    expect(sameValue(0, false)).toBe(false)
    expect(sameValue('', null)).toBe(false)
  })
})

describe('hasOwn', () => {
  it('reads own properties only', () => {
    // `in` would find `toString` on every object, so a patch would
    // "contain" keys it never set.
    expect(hasOwn({ a: 1 }, 'a')).toBe(true)
    expect(hasOwn({ a: 1 }, 'toString')).toBe(false)
    expect('toString' in { a: 1 }).toBe(true)
  })

  it('finds a key whose value is undefined', () => {
    // Present-but-undefined is a real distinction on the wire: it is
    // what a spread of an optional field produces, and the aggregator
    // must not read it as "clear this".
    expect(hasOwn({ a: undefined }, 'a')).toBe(true)
  })
})
