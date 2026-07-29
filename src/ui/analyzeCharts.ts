/**
 * Chart pieces for the Analyze panel.
 *
 * Hand-rolled SVG, following the precedent in
 * `src/ui/publisher/analytics-charts.ts` rather than importing it: that
 * module is publisher-portal-scoped and its bar series is a categorical
 * chart with a Y-axis gutter, where this is a 256-bin distribution
 * whose bars are coloured by their own value. Sharing the file would
 * couple the public SPA bundle to the portal's chrome for one helper.
 *
 * See `docs/DATA_ANALYSIS_PLAN.md` §A3.
 */

import { LUMA_LEVELS, type LumaHistogram, type TransectSample } from '../services/datasetStats'
import { buildDisplayLut, type ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types/color-scale'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Matches `formatProbeReading` and the colorbar — the measured error
 *  budget is ~0.4% of full scale, so a fourth digit is encoder noise
 *  presented as precision. */
const SIGNIFICANT_DIGITS = 3

const VIEWBOX_W = 256
const VIEWBOX_H = 64

/**
 * How many luma codes each bar covers.
 *
 * Four, because the transport moves a sample by at most one code (see
 * `renderHistogram`), so a four-code bar keeps that redistribution
 * inside the bar. Measured on a real published frame, bar-to-bar ripple
 * falls from 0.66 at one code per bar to 0.10 at four, against 0.066 for
 * the same field read losslessly — i.e. what is left is the field's own
 * raggedness, not the lattice.
 */
export const HISTOGRAM_BUCKET = 4

/** Bars drawn. 64 at the shipped bucket width. */
export const HISTOGRAM_BARS = LUMA_LEVELS / HISTOGRAM_BUCKET

/** The value width of one bar, for the caption beside the chart. */
export function histogramBucketValueWidth(scale: ColorScale): number {
  return (Math.abs(scale.vmax - scale.vmin) / (LUMA_LEVELS - 1)) * HISTOGRAM_BUCKET
}

export function formatStatValue(value: number, units?: string): string {
  if (!Number.isFinite(value)) return t('analyze.stat.none')
  const text = formatNumber(value, { maximumSignificantDigits: SIGNIFICANT_DIGITS })
  return units ? t('probe.value', { value: text, units }) : text
}

/**
 * The distribution, each bar painted the colour the globe paints those
 * values.
 *
 * The model behind this chart is still the exact 256-bin one — the bins
 * *are* the source codes, and that is what the statistics and the CSV
 * export are computed from. The chart aggregates
 * `HISTOGRAM_BUCKET` codes per bar, and that is a display decision with
 * a specific cause.
 *
 * **The transport cannot deliver 256 populated codes.** `ffmpeg-hls.ts`
 * ships the data path untagged, so the encoder contracts luma to the
 * limited range (16..235, 219 levels) and both decoders expand it back;
 * the two cancel in *value* but not in *occupancy*. Measured on a real
 * published frame: the source PNG leaves 1 code of 244 empty, and the
 * same field through that round trip leaves 35 — about 34 codes emptied,
 * spaced roughly every 7. Drawn one bar per code that reads as a comb,
 * and it is the lattice of the transport rather than anything in the
 * data. The round trip moves any given sample by at most one code, so
 * aggregating a few codes per bar recovers the true shape almost
 * exactly; see `HISTOGRAM_BUCKET` for the measurements behind the width.
 *
 * A bar is therefore ~1.6% of full scale, against a measured error
 * budget of ~0.4% — coarser than the noise floor, finer than anything a
 * reader would draw a conclusion from, and the per-value precision is
 * stated separately beside the statistics.
 *
 * Colouring each bar from the same LUT the shader samples is what makes
 * the chart legible without a legend: the shape and the globe are
 * visibly the same field.
 *
 * Bars are square-rooted before scaling. These fields are extremely
 * skewed — most of a smoke frame sits within a few codes of the bottom
 * — and a linear height scale renders every interesting bin as a
 * sub-pixel sliver next to one full-height spike. The axis is therefore
 * deliberately not labelled with counts: it shows shape, not magnitude,
 * and the numbers that matter are in the stat tiles beside it.
 */
export function renderHistogram(
  hist: LumaHistogram,
  scale: ColorScale,
  display: ColorScaleDisplay,
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'analyze-histogram')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', t('analyze.histogram.aria'))

  const lut = buildDisplayLut(scale, display)
  const bars = new Float64Array(HISTOGRAM_BARS)
  for (let i = 0; i < LUMA_LEVELS; i++) {
    bars[Math.floor(i / HISTOGRAM_BUCKET)] += hist.weights[i]
  }
  let peak = 0
  for (let i = 0; i < HISTOGRAM_BARS; i++) {
    if (bars[i] > peak) peak = bars[i]
  }
  if (peak <= 0) return svg

  const root = Math.sqrt(peak)
  // Colour comes from the middle of the bar's code range, so a bar
  // reads as the colour the globe paints the values it covers rather
  // than as the colour of its lowest edge.
  const centre = (HISTOGRAM_BUCKET - 1) / 2
  for (let i = 0; i < HISTOGRAM_BARS; i++) {
    const w = bars[i]
    if (w <= 0) continue
    const h = (Math.sqrt(w) / root) * VIEWBOX_H
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bar.setAttribute('x', String(i * HISTOGRAM_BUCKET))
    bar.setAttribute('y', String(VIEWBOX_H - h))
    bar.setAttribute('width', String(HISTOGRAM_BUCKET))
    bar.setAttribute('height', String(h))
    const o = Math.round(i * HISTOGRAM_BUCKET + centre) * 4
    // Alpha is deliberately dropped: a bar the globe draws faintly is
    // still a real part of the distribution, and fading it here would
    // hide exactly the low-value bins these fields live in.
    bar.setAttribute('fill', `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`)
    svg.appendChild(bar)
  }
  return svg
}

const TRANSECT_W = 256
const TRANSECT_H = 72
/** Height of the colour strip along the bottom, in viewBox units. */
const RIBBON_H = 8
/** Gap between the profile and the strip. */
const RIBBON_GAP = 2
const PLOT_H = TRANSECT_H - RIBBON_H - RIBBON_GAP

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The field along a line: value against distance.
 *
 * **Deliberately not an area chart.** The vertical axis is scaled to
 * this transect's own range rather than to `[vmin, vmax]` — these
 * fields are skewed enough that a full-range axis flattens every
 * profile into a line along the bottom — and filling under a curve
 * whose baseline is not zero draws an area that encodes nothing. So the
 * profile is a stroke, and the caption says the axis is relative.
 *
 * Two coloured elements, both from the same display LUT the shader
 * samples. The profile is stroked per segment, so its colour and its
 * height say the same thing twice, which is what makes it readable
 * against the globe. Below it runs a strip of the same colours without
 * the height — a one-dimensional slice of what the transect crosses,
 * which is the thing a viewer can compare directly against the line
 * they drew.
 *
 * Gaps stay gaps. `sampleTransect` returns null where the line leaves
 * the dataset or crosses absent data, and both the stroke and the strip
 * break there rather than interpolating across — a profile drawn
 * straight through a hole is a measurement claim nobody made.
 */
export function renderTransectChart(
  samples: readonly TransectSample[],
  scale: ColorScale,
  display: ColorScaleDisplay,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${TRANSECT_W} ${TRANSECT_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'analyze-transect')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', t('analyze.transect.aria'))
  if (samples.length < 2) return svg

  const span = transectValueSpan(samples)
  if (!span) return svg

  const lut = buildDisplayLut(scale, display)
  const total = samples[samples.length - 1].distanceKm
  const xAt = (i: number): number =>
    total > 0 ? (samples[i].distanceKm / total) * TRANSECT_W : (i / (samples.length - 1)) * TRANSECT_W
  const yAt = (v: number): number => PLOT_H - ((v - span.lo) / (span.hi - span.lo)) * PLOT_H
  const colourAt = (v: number): string => {
    const o = lumaIndexFor(v, scale) * 4
    // Alpha dropped, as in the histogram: a value the globe draws
    // faintly is still on the line, and fading it here would read as
    // the gap that a genuinely absent sample gets.
    return `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`
  }

  const strip = document.createElementNS(SVG_NS, 'g')
  strip.setAttribute('class', 'analyze-transect-strip')
  // The cells abut exactly, so anti-aliasing puts a pale seam between
  // every pair and the strip reads as striped rather than continuous —
  // at 512 samples in a 256-unit viewBox that is a lot of seams.
  // Snapping their edges is the same intent as the histogram's
  // `image-rendering: pixelated`: this is a picture of the line, not a
  // set of shapes.
  strip.setAttribute('shape-rendering', 'crispEdges')
  const half = TRANSECT_W / (samples.length - 1) / 2
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i].value
    if (v == null) continue
    const x = xAt(i)
    const x0 = Math.max(0, x - half)
    const x1 = Math.min(TRANSECT_W, x + half)
    const cell = document.createElementNS(SVG_NS, 'rect')
    cell.setAttribute('x', x0.toFixed(3))
    cell.setAttribute('y', String(TRANSECT_H - RIBBON_H))
    cell.setAttribute('width', Math.max(0, x1 - x0).toFixed(3))
    cell.setAttribute('height', String(RIBBON_H))
    cell.setAttribute('fill', colourAt(v))
    strip.appendChild(cell)
  }
  svg.appendChild(strip)

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].value
    const b = samples[i].value
    if (a == null || b == null) continue
    const seg = document.createElementNS(SVG_NS, 'line')
    seg.setAttribute('x1', xAt(i - 1).toFixed(3))
    seg.setAttribute('y1', yAt(a).toFixed(3))
    seg.setAttribute('x2', xAt(i).toFixed(3))
    seg.setAttribute('y2', yAt(b).toFixed(3))
    seg.setAttribute('stroke', colourAt((a + b) / 2))
    seg.setAttribute('stroke-width', '2')
    seg.setAttribute('vector-effect', 'non-scaling-stroke')
    seg.setAttribute('stroke-linecap', 'round')
    svg.appendChild(seg)
  }
  return svg
}

/**
 * The vertical range the profile is drawn against.
 *
 * A flat transect — every sample the same value, which happens on a
 * short line inside one texel — has no range to scale to. Give it a
 * band so the line lands mid-height instead of dividing by zero.
 */
export function transectValueSpan(
  samples: readonly TransectSample[],
): { lo: number; hi: number } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const s of samples) {
    if (s.value == null) continue
    if (s.value < lo) lo = s.value
    if (s.value > hi) hi = s.value
  }
  if (!Number.isFinite(lo)) return null
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1
    return { lo: lo - pad, hi: hi + pad }
  }
  return { lo, hi }
}

/** Which LUT entry the globe would sample for this value. Inverse of
 *  `lumaToValue`, clamped, so a value at either end of the scale still
 *  lands inside the table. */
function lumaIndexFor(value: number, scale: ColorScale): number {
  const range = scale.vmax - scale.vmin
  const t = range === 0 ? 0 : (value - scale.vmin) / range
  return Math.max(0, Math.min(LUMA_LEVELS - 1, Math.round(t * (LUMA_LEVELS - 1))))
}

/** A labelled number. Mirrors the portal's `renderStatTile` shape so the
 *  two surfaces read alike, without importing across the boundary. */
export function renderStatTile(label: string, value: string): HTMLElement {
  const tile = document.createElement('div')
  tile.className = 'analyze-stat'
  const l = document.createElement('span')
  l.className = 'analyze-stat-label'
  l.textContent = label
  const v = document.createElement('span')
  v.className = 'analyze-stat-value'
  v.textContent = value
  tile.append(l, v)
  return tile
}
