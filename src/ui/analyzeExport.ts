/**
 * CSV export for the Analyze panel.
 *
 * The numbers on screen are a summary; the export is the evidence. It
 * carries the full 256-bin distribution alongside the summary
 * statistics, because a histogram is the one artefact here that cannot
 * be reconstructed from the tiles — and because someone checking a
 * claim about a field wants the distribution, not a mean.
 *
 * The header block records what the numbers are *of*: the dataset, the
 * region, the units, and the quantisation step. A CSV that says
 * "mean, 0.000123" and nothing else is unfalsifiable a week later.
 *
 * `buildCsvText` is pure so the format is testable without a DOM. The
 * serialisation rules match `src/ui/publisher/analytics-charts.ts`
 * (RFC-4180, CRLF, quote only when needed) rather than importing it —
 * that module is publisher-portal-scoped.
 */

import { LUMA_LEVELS, type LumaHistogram, type RegionStats } from '../services/datasetStats'
import { lumaToValue, type ColorScale } from '../types/color-scale'

type Cell = string | number | null | undefined

function cell(value: Cell): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function rows(list: readonly Cell[][]): string {
  return list.map((r) => r.map(cell).join(',')).join('\r\n')
}

export interface CsvContext {
  datasetTitle: string | null
  scopeLabel: string
}

/**
 * Serialise a summary plus its distribution.
 *
 * Values are written at full precision rather than the three
 * significant digits the panel displays: the rounding is a presentation
 * choice about what is *legible*, and re-imposing it here would destroy
 * information the file exists to carry. The quantisation step is in the
 * header so a reader can see how much of that precision is real.
 */
export function buildCsvText(
  stats: RegionStats,
  hist: LumaHistogram,
  scale: ColorScale,
  ctx: CsvContext,
): string {
  const step = Math.abs(scale.vmax - scale.vmin) / 255
  const head: Cell[][] = [
    ['dataset', ctx.datasetTitle ?? ''],
    ['region', ctx.scopeLabel],
    ['units', scale.units ?? ''],
    ['value_min', scale.vmin],
    ['value_max', scale.vmax],
    ['quantisation_step', step],
    [],
    ['statistic', 'value'],
    ['mean', stats.mean],
    ['median', stats.median],
    ['min', stats.min],
    ['max', stats.max],
    ['p10', stats.p10],
    ['p90', stats.p90],
    ['std_dev', stats.stdDev],
    ['area_km2', stats.areaKm2],
    ['texels_with_data', stats.count],
    ['texels_examined', stats.examined],
    ['coverage_fraction', stats.coverage],
    [],
    ['value', 'area_km2', 'texel_count'],
  ]

  const bins: Cell[][] = []
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    // Absent-data codes carry no area by construction; emitting them
    // would put rows in the file that the statistics above excluded.
    if (hist.weights[luma] <= 0) continue
    bins.push([lumaToValue(luma, scale), hist.weights[luma], hist.counts[luma]])
  }

  return `${rows(head)}\r\n${rows(bins)}\r\n`
}

/** Trigger a browser download. No-op-safe outside a DOM. */
export function downloadCsv(filename: string, text: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
