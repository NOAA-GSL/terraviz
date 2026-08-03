/**
 * Cloudflare's published rates, and the arithmetic the cost estimate
 * runs on them.
 *
 * ## This file goes stale and nothing here can stop it
 *
 * Every other fact on `/setup` is imported from a module the setup
 * tool uses, so the page cannot drift from the code. These numbers
 * have no such anchor: they are a third party's prices, and Cloudflare
 * changes them without telling us. `crossCheck` cannot help.
 *
 * So the mitigations are the honest ones rather than the clever ones:
 *
 *   - every rate is here, in one block, not scattered through markup
 *   - `CHECKED_ON` is rendered on the page next to the estimate
 *   - the page links Cloudflare's own pricing pages, which are
 *     authoritative in a way this file never is
 *   - the estimate is framed as an order of magnitude, because that is
 *     what it is
 *
 * When updating: re-read both pages, change the constants, move
 * `CHECKED_ON`, and run the tests — they pin the arithmetic, not the
 * rates, so they will not notice a price change on their own.
 *
 * Sources, fetched and read on the date below:
 *   https://developers.cloudflare.com/r2/pricing/
 *   https://developers.cloudflare.com/d1/platform/pricing/
 */

/** When a human last read the two pricing pages above. */
export const CHECKED_ON = '2026-08-02'

export const R2_PRICING = {
  /** Free every month, Standard storage only. */
  freeStorageGb: 10,
  freeClassA: 1_000_000,
  freeClassB: 10_000_000,
  /** USD per GB-month beyond the free allowance. */
  storagePerGbMonth: 0.015,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  /** The one that surprises people coming from S3. */
  egressPerGb: 0,
} as const

export const D1_PRICING = {
  /** Workers Free: a hard cap, not an allowance you can exceed. */
  freePlanStorageGb: 5,
  /** Workers Paid: included, then billed. */
  paidIncludedStorageGb: 5,
  paidStoragePerGbMonth: 0.75,
} as const

/**
 * Transcoded output for one minute of source video, in MB.
 *
 * The HLS ladder stores several renditions, so this is the sum of
 * them rather than the size of any one. It is the single biggest
 * lever on the estimate and the least precise number in it — real
 * output swings with resolution, motion and codec settings.
 */
export const VIDEO_MB_PER_SOURCE_MINUTE = 250

export interface Estimate {
  /** Total stored, GB. */
  storageGb: number
  /** Covered by R2's free allowance. */
  freeGb: number
  /** Charged for. */
  billableGb: number
  /** USD per month, storage only. */
  monthlyUsd: number
}

/**
 * Storage cost for a catalog of dataset videos.
 *
 * Denominated in **datasets**, not hours, because that is the unit the
 * operator actually thinks in and the scale the app works at — a
 * dataset video is a short loop, typically well under a minute, not a
 * feature film. Framing this in hours (as the first draft did)
 * overstates it by two orders of magnitude and makes a $0.40/month
 * catalog look like a budget line.
 *
 * Deliberately storage-only. Operations are the other half of an R2
 * bill, but a catalog node's read pattern sits so far inside the 10M
 * free Class B operations that including them would add noise and a
 * false sense of precision. The page says so rather than implying the
 * number is complete.
 *
 * R2's free allowance applies on both Workers plans — that is the
 * point the old copy missed by filing storage under "Workers Paid".
 */
export function estimateStorage(datasets: number, secondsEach: number): Estimate {
  const n = Number.isFinite(datasets) && datasets > 0 ? datasets : 0
  const secs = Number.isFinite(secondsEach) && secondsEach > 0 ? secondsEach : 0
  const storageGb = (n * (secs / 60) * VIDEO_MB_PER_SOURCE_MINUTE) / 1024
  const freeGb = Math.min(storageGb, R2_PRICING.freeStorageGb)
  const billableGb = Math.max(0, storageGb - R2_PRICING.freeStorageGb)
  return {
    storageGb,
    freeGb,
    billableGb,
    monthlyUsd: billableGb * R2_PRICING.storagePerGbMonth,
  }
}

/** How many videos of a given length fit inside the free allowance. */
export function freeDatasets(secondsEach: number): number {
  if (!Number.isFinite(secondsEach) || secondsEach <= 0) return 0
  const mbEach = (secondsEach / 60) * VIDEO_MB_PER_SOURCE_MINUTE
  return Math.floor((R2_PRICING.freeStorageGb * 1024) / mbEach)
}

/** Minutes of video inside the free allowance, for the prose. */
export function freeMinutes(): number {
  return (R2_PRICING.freeStorageGb * 1024) / VIDEO_MB_PER_SOURCE_MINUTE
}

/** The default the calculator opens on — "well under a minute". */
export const TYPICAL_SECONDS = 45
