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

import { LUMA_LEVELS, type LumaHistogram } from '../services/datasetStats'
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

export function formatStatValue(value: number, units?: string): string {
  if (!Number.isFinite(value)) return t('analyze.stat.none')
  const text = formatNumber(value, { maximumSignificantDigits: SIGNIFICANT_DIGITS })
  return units ? t('probe.value', { value: text, units }) : text
}

/**
 * The distribution, one bar per source value, each painted the colour
 * the globe paints that value.
 *
 * A 256-bin histogram of a 256-value source is exact — the bins *are*
 * the values — so there is no bin-width choice to expose and no
 * smoothing to apply. Colouring each bar from the same LUT the shader
 * samples is what makes the chart legible without a legend: the shape
 * and the globe are visibly the same field.
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
  let peak = 0
  for (let i = 0; i < LUMA_LEVELS; i++) {
    if (hist.weights[i] > peak) peak = hist.weights[i]
  }
  if (peak <= 0) return svg

  const root = Math.sqrt(peak)
  for (let i = 0; i < LUMA_LEVELS; i++) {
    const w = hist.weights[i]
    if (w <= 0) continue
    const h = (Math.sqrt(w) / root) * VIEWBOX_H
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bar.setAttribute('x', String(i))
    bar.setAttribute('y', String(VIEWBOX_H - h))
    bar.setAttribute('width', '1')
    bar.setAttribute('height', String(h))
    const o = i * 4
    // Alpha is deliberately dropped: a bar the globe draws faintly is
    // still a real part of the distribution, and fading it here would
    // hide exactly the low-value bins these fields live in.
    bar.setAttribute('fill', `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`)
    svg.appendChild(bar)
  }
  return svg
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
