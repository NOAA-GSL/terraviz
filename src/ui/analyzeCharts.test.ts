/**
 * Tests for the Analyze panel's chart pieces.
 *
 * The one behaviour worth pinning here is the histogram's bar width.
 * The data path ships untagged (`cli/lib/ffmpeg-hls.ts`), so luma is
 * contracted to the limited range on encode and expanded back on
 * decode; the two cancel in value but leave roughly every seventh code
 * unreachable. Drawn one bar per code that lattice reads as a comb.
 * These tests assert the aggregation actually removes it, and that
 * doing so does not lose or move any weight.
 */
import { describe, expect, it } from 'vitest'
import {
  HISTOGRAM_BARS,
  HISTOGRAM_BUCKET,
  histogramBucketValueWidth,
  renderHistogram,
} from './analyzeCharts'
import { LUMA_LEVELS, type LumaHistogram } from '../services/datasetStats'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 5.1,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

function histogram(weights: number[]): LumaHistogram {
  const w = Float64Array.from(weights)
  const total = weights.reduce((a, b) => a + b, 0)
  return {
    weights: w,
    counts: new Uint32Array(LUMA_LEVELS),
    totalWeight: total,
    dataCount: 0,
    examined: LUMA_LEVELS,
  }
}

/** A smooth decay, the shape these skewed fields actually have. */
function smoothField(): number[] {
  return Array.from({ length: LUMA_LEVELS }, (_, i) =>
    i < 12 ? 0 : 1_000_000 * Math.exp(-(i - 12) / 40),
  )
}

/**
 * The same field after the limited-range round trip: contract to
 * 16..235, expand back. Weight lands on the reachable codes only.
 */
function throughTransport(source: number[]): number[] {
  const out = new Array<number>(LUMA_LEVELS).fill(0)
  for (let i = 0; i < LUMA_LEVELS; i++) {
    const contracted = Math.round((i * 219) / 255 + 16)
    const expanded = Math.max(0, Math.min(255, Math.round(((contracted - 16) * 255) / 219)))
    out[expanded] += source[i]
  }
  return out
}

/** Heights indexed by bar, so an empty bar reads as 0 rather than
 *  shifting its neighbours along. */
function barHeights(svg: SVGSVGElement): number[] {
  const h = new Array<number>(HISTOGRAM_BARS).fill(0)
  for (const r of svg.querySelectorAll('rect')) {
    h[Number(r.getAttribute('x')) / HISTOGRAM_BUCKET] = Number(r.getAttribute('height'))
  }
  return h
}

/**
 * Mean bar-to-bar ripple: how far each bar sits from the mean of its
 * neighbours, relative to that mean. This is what the eye reads as a
 * comb. The *mean* rather than the worst, because the worst bar is
 * always the leading edge next to the nodata band — real structure, and
 * present losslessly too.
 */
function meanRipple(h: number[]): number {
  let sum = 0
  let n = 0
  for (let i = 1; i < h.length - 1; i++) {
    const local = (h[i - 1] + h[i + 1]) / 2
    if (local <= 0) continue
    sum += Math.abs(h[i] - local) / local
    n++
  }
  return n ? sum / n : 0
}

/** What the chart would look like drawn one bar per luma code. */
function unbucketedHeights(weights: number[]): number[] {
  const peak = Math.max(...weights)
  return weights.map((w) => (Math.sqrt(w) / Math.sqrt(peak)) * 64)
}

describe('renderHistogram', () => {
  it('draws one bar per bucket of luma codes, spanning the full axis', () => {
    const svg = renderHistogram(histogram(smoothField()), SCALE, DEFAULT_DISPLAY)
    const rects = [...svg.querySelectorAll('rect')]
    expect(rects.length).toBeLessThanOrEqual(HISTOGRAM_BARS)
    for (const r of rects) {
      expect(Number(r.getAttribute('width'))).toBe(HISTOGRAM_BUCKET)
      expect(Number(r.getAttribute('x')) % HISTOGRAM_BUCKET).toBe(0)
    }
    const last = rects[rects.length - 1]
    expect(Number(last.getAttribute('x')) + HISTOGRAM_BUCKET).toBeLessThanOrEqual(LUMA_LEVELS)
  })

  it('reads the same through the transport as it does losslessly', () => {
    const source = smoothField()
    const lossless = barHeights(renderHistogram(histogram(source), SCALE, DEFAULT_DISPLAY))
    const transported = barHeights(
      renderHistogram(histogram(throughTransport(source)), SCALE, DEFAULT_DISPLAY),
    )
    // The round trip moves a sample by at most one code, so a bar wider
    // than that keeps nearly all of the redistribution internal.
    let sum = 0
    let n = 0
    for (let i = 0; i < lossless.length; i++) {
      if (lossless[i] < 1) continue
      sum += Math.abs(transported[i] - lossless[i]) / lossless[i]
      n++
    }
    expect(n).toBeGreaterThan(20)
    expect(sum / n).toBeLessThan(0.06)
  })

  it('does not draw the transport lattice as a comb', () => {
    const transported = throughTransport(smoothField())
    const drawn = meanRipple(
      barHeights(renderHistogram(histogram(transported), SCALE, DEFAULT_DISPLAY)),
    )
    const oneBarPerCode = meanRipple(unbucketedHeights(transported))
    // Measured on a real published frame: 0.66 at one code per bar
    // against 0.10 at this bucket width. This synthetic field lands in
    // the same place (0.57 → 0.10), so the ratio is the assertion and
    // the absolute value is a guard against the ratio being met by a
    // chart that is merely noisy at both widths.
    expect(oneBarPerCode / drawn).toBeGreaterThan(4)
    expect(drawn).toBeLessThan(0.15)
  })

  it('empties the chart rather than dividing by zero when nothing carries data', () => {
    const svg = renderHistogram(histogram(new Array(LUMA_LEVELS).fill(0)), SCALE, DEFAULT_DISPLAY)
    expect(svg.querySelectorAll('rect')).toHaveLength(0)
  })
})

describe('histogramBucketValueWidth', () => {
  it('reports a bar as its bucket of luma steps, in the scale units', () => {
    expect(histogramBucketValueWidth(SCALE)).toBeCloseTo((5.1 / 255) * HISTOGRAM_BUCKET, 12)
  })

  it('is positive for an inverted scale', () => {
    expect(histogramBucketValueWidth({ ...SCALE, vmin: 5.1, vmax: 0 })).toBeGreaterThan(0)
  })
})
