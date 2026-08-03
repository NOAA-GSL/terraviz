import { describe, expect, it } from 'vitest'
import {
  CHECKED_ON,
  D1_PRICING,
  estimateStorage,
  freeDatasets,
  TYPICAL_SECONDS,
  R2_PRICING,
  VIDEO_MB_PER_SOURCE_MINUTE,
} from './pricing'

describe('estimateStorage', () => {
  it('costs nothing for a small catalog', () => {
    const e = estimateStorage(20, TYPICAL_SECONDS)
    expect(e.storageGb).toBeCloseTo((20 * 0.75 * VIDEO_MB_PER_SOURCE_MINUTE) / 1024, 5)
    expect(e.billableGb).toBe(0)
    expect(e.monthlyUsd).toBe(0)
  })

  // The point of the section, and the thing the first draft got wrong
  // by measuring in hours: at the scale this app actually runs at,
  // storage is pocket change rather than a budget line.
  it('keeps a large catalog under a few dollars a month', () => {
    expect(estimateStorage(200, TYPICAL_SECONDS).monthlyUsd).toBeLessThan(1)
    expect(estimateStorage(1000, TYPICAL_SECONDS).monthlyUsd).toBeLessThan(3)
  })

  it('bills only the excess', () => {
    const e = estimateStorage(1000, TYPICAL_SECONDS)
    expect(e.freeGb).toBe(R2_PRICING.freeStorageGb)
    expect(e.billableGb).toBeCloseTo(e.storageGb - R2_PRICING.freeStorageGb, 5)
    expect(e.monthlyUsd).toBeCloseTo(e.billableGb * R2_PRICING.storagePerGbMonth, 5)
  })

  it('treats nonsense input as zero rather than NaN', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateStorage(bad, TYPICAL_SECONDS)).toEqual({
        storageGb: 0, freeGb: 0, billableGb: 0, monthlyUsd: 0,
      })
      expect(estimateStorage(100, bad)).toEqual({
        storageGb: 0, freeGb: 0, billableGb: 0, monthlyUsd: 0,
      })
    }
  })

  it('agrees with freeDatasets() at the boundary', () => {
    const n = freeDatasets(TYPICAL_SECONDS)
    expect(estimateStorage(n, TYPICAL_SECONDS).billableGb).toBe(0)
    expect(estimateStorage(n + 1, TYPICAL_SECONDS).billableGb).toBeGreaterThan(0)
  })

  it('scales the free count with clip length', () => {
    expect(freeDatasets(30)).toBeGreaterThan(freeDatasets(60))
    expect(freeDatasets(0)).toBe(0)
  })
})

describe('the rate constants', () => {
  // Not a check that the prices are right — nothing here can know
  // that. A check that they are the shape the arithmetic assumes, so a
  // botched edit fails loudly instead of quietly producing $0.
  it('are positive numbers with a free allowance', () => {
    expect(R2_PRICING.storagePerGbMonth).toBeGreaterThan(0)
    expect(R2_PRICING.freeStorageGb).toBeGreaterThan(0)
    expect(D1_PRICING.paidStoragePerGbMonth).toBeGreaterThan(0)
    expect(VIDEO_MB_PER_SOURCE_MINUTE).toBeGreaterThan(0)
  })

  // R2's headline advantage over S3. If this ever stops being zero the
  // page's "serving it adds nothing" claim has to change with it.
  it('still records egress as free', () => {
    expect(R2_PRICING.egressPerGb).toBe(0)
  })

  it('carries a checked-on date the page can show', () => {
    expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
