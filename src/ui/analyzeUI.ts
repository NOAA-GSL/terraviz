/**
 * The Analyze panel — statistics over the frame on screen.
 *
 * `datasetProbe` answers "what is the number here"; this answers the
 * questions that need more than one texel, over a region the user
 * picks. See `docs/DATA_ANALYSIS_PLAN.md` §A3.
 *
 * Behind an explicit Tools entry rather than in the main chrome, per
 * the plan's settled audience decision: the colorbar, the threshold and
 * Orbit serve the museum floor, and a statistics table is not something
 * a casual visitor should have to dismiss to see the globe.
 *
 * Computation is user-initiated and one-shot. The whole frame is read
 * back once (~8 MB at 4096×2048) and every number here is a pure
 * function over that buffer — nothing on this surface runs per frame or
 * per pointer event.
 */

import {
  buildHistogram,
  summarize,
  windowForBounds,
  type LatLonBounds,
  type LumaHistogram,
  type RegionStats,
} from '../services/datasetStats'
import type { LumaSnapshot } from '../services/glLumaSampler'
import type { ColorScaleDisplay } from '../services/colorScaleDisplay'
import type { ColorScale } from '../types/color-scale'
import type { DatasetOverlayOptions } from '../types'
import { getRegionNames, resolveRegion } from '../data/regions'
import { formatStatValue, renderHistogram, renderStatTile } from './analyzeCharts'
import { buildCsvText, downloadCsv } from './analyzeExport'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** What the panel needs from the app to compute anything. Injected so
 *  the module never reaches for a renderer singleton, and so the tests
 *  can drive it with a fixed frame. */
export interface AnalyzeSource {
  /** The current frame plus the metadata that makes it meaningful, or
   *  null when nothing analysable is loaded. */
  frame(): {
    snapshot: LumaSnapshot
    scale: ColorScale
    options: DatasetOverlayOptions
  } | null
  /** The box currently on screen, for "what I can see". */
  visibleBounds(): LatLonBounds | null
  /** The active viewing transform, so the histogram is painted in the
   *  colours the globe is actually using. */
  display(): ColorScaleDisplay
  /** Title of the dataset being analysed, for the CSV header. */
  datasetTitle(): string | null
}

/** Which region the statistics cover. */
export type AnalyzeScope =
  | { kind: 'dataset' }
  | { kind: 'view' }
  | { kind: 'named'; name: string }

let source: AnalyzeSource | null = null
let scope: AnalyzeScope = { kind: 'dataset' }
let lastResult: { stats: RegionStats; hist: LumaHistogram; scale: ColorScale } | null = null
let lastTrigger: HTMLElement | null = null
let root: HTMLElement | null = null

/**
 * Wire the panel to the app. Call once at boot.
 *
 * Resets the picked region, because that choice belongs to the source
 * it was made against. Within one session the choice is deliberately
 * sticky across opens — someone comparing regions should not have to
 * re-pick on every open — but a new source is a new context.
 */
export function initAnalyzeUI(src: AnalyzeSource): void {
  source = src
  scope = { kind: 'dataset' }
}

/** Whether the panel is currently open. Used by tests and the scene. */
export function isAnalyzeUIOpen(): boolean {
  return root !== null
}

/** Close the panel and return focus to whatever opened it. */
export function closeAnalyzeUI(): void {
  root?.remove()
  root = null
  document.removeEventListener('keydown', onEscape, true)
  lastTrigger?.focus()
  lastTrigger = null
}

function onEscape(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation()
    closeAnalyzeUI()
  }
}

/**
 * Open the panel and compute against the current frame.
 *
 * Rebuilt from scratch on open rather than cached: the frame moves, the
 * palette moves, and a panel showing last week's numbers under this
 * week's globe is worse than no panel.
 */
export function openAnalyzeUI(triggeredBy?: HTMLElement | null): HTMLElement {
  closeAnalyzeUI()
  lastTrigger = triggeredBy ?? null

  root = document.createElement('div')
  root.className = 'analyze-panel'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'false')
  root.setAttribute('aria-label', t('analyze.title'))

  const header = document.createElement('div')
  header.className = 'analyze-header'
  const heading = document.createElement('h2')
  heading.textContent = t('analyze.title')
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'analyze-close'
  close.setAttribute('aria-label', t('analyze.close'))
  close.textContent = '×' // i18n-exempt: a glyph, not a word
  close.addEventListener('click', closeAnalyzeUI)
  header.append(heading, close)
  root.appendChild(header)

  root.appendChild(buildScopePicker())

  const body = document.createElement('div')
  body.className = 'analyze-body'
  root.appendChild(body)

  document.body.appendChild(root)
  document.addEventListener('keydown', onEscape, true)
  refresh(body)
  return root
}

function buildScopePicker(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'analyze-scope'

  const label = document.createElement('label')
  label.className = 'analyze-scope-label'
  label.htmlFor = 'analyze-scope-select'
  label.textContent = t('analyze.scope.label')

  const select = document.createElement('select')
  select.id = 'analyze-scope-select'
  select.className = 'analyze-scope-select'

  const add = (value: string, text: string): void => {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = text
    select.appendChild(opt)
  }
  add('dataset', t('analyze.scope.dataset'))
  add('view', t('analyze.scope.view'))
  // Named regions come from the same table the LLM's `<<REGION:…>>`
  // marker resolves against, so "Europe" means the same box wherever a
  // user meets it.
  //
  // Filtered by whether the display name resolves back to a box:
  // `getRegionNames` returns display names while `resolveRegion` looks
  // up lowercased *aliases*, and at least one entry's display name is
  // not among its own aliases. Offering it produced a region that
  // silently fell through to the whole dataset — the worst outcome
  // available, since the numbers were real and the label was wrong.
  for (const name of getRegionNames()) {
    if (resolveRegion(name)) add(`named:${name}`, name)
  }

  select.value = scopeToValue(scope)
  select.addEventListener('change', () => {
    scope = valueToScope(select.value)
    const body = root?.querySelector('.analyze-body') as HTMLElement | null
    if (body) refresh(body)
  })

  wrap.append(label, select)
  return wrap
}

function scopeToValue(s: AnalyzeScope): string {
  return s.kind === 'named' ? `named:${s.name}` : s.kind
}

function valueToScope(value: string): AnalyzeScope {
  if (value === 'view') return { kind: 'view' }
  if (value.startsWith('named:')) return { kind: 'named', name: value.slice(6) }
  return { kind: 'dataset' }
}

/**
 * Resolve the picked scope to a geographic box.
 *
 * Three outcomes, deliberately distinct. `null` used to mean both
 * "analyse everything" and "I could not work out what you picked",
 * which turned an unresolvable region into whole-dataset statistics
 * wearing that region's name. A wrong answer delivered confidently is
 * worse than an error, so the unknown case is now its own state.
 */
type ScopeBounds =
  | { kind: 'all' }
  | { kind: 'box'; bounds: LatLonBounds }
  | { kind: 'unknown' }

function boundsForScope(s: AnalyzeScope, src: AnalyzeSource): ScopeBounds {
  if (s.kind === 'view') {
    const bounds = src.visibleBounds()
    // No map yet is "everything", not an error: the whole dataset is a
    // truthful answer to "what can I see" before the camera exists.
    return bounds ? { kind: 'box', bounds } : { kind: 'all' }
  }
  if (s.kind === 'named') {
    const region = resolveRegion(s.name)
    if (!region) return { kind: 'unknown' }
    const [w, south, e, n] = region.bounds
    return { kind: 'box', bounds: { n, s: south, w, e } }
  }
  return { kind: 'all' }
}

function refresh(body: HTMLElement): void {
  body.replaceChildren()
  lastResult = null

  const src = source
  if (!src) {
    body.appendChild(message(t('analyze.empty.unavailable')))
    return
  }
  const frame = src.frame()
  if (!frame) {
    // No data-encoded dataset loaded, or no WebGL2. Absent rather than
    // broken, which is the availability posture the rest of the
    // data-encoded work takes.
    body.appendChild(message(t('analyze.empty.noDataset')))
    return
  }

  const { snapshot, scale, options } = frame
  const scoped = boundsForScope(scope, src)
  if (scoped.kind === 'unknown') {
    body.appendChild(message(t('analyze.empty.unknownRegion')))
    return
  }
  const window = scoped.kind === 'box'
    ? windowForBounds(snapshot, scoped.bounds, options)
    : undefined
  if (scoped.kind === 'box' && !window) {
    body.appendChild(message(t('analyze.empty.outsideDataset')))
    return
  }

  const stats = summarize(snapshot, scale, options, window ?? undefined)
  if (!stats) {
    body.appendChild(message(t('analyze.empty.noValues')))
    return
  }
  const hist = buildHistogram(snapshot, scale, options, window ?? undefined)
  lastResult = { stats, hist, scale }

  body.appendChild(renderHistogram(hist, scale, src.display()))
  body.appendChild(renderStats(stats))
  body.appendChild(renderCoverage(stats))
  body.appendChild(renderPrecisionNote(scale))
  body.appendChild(renderExport(src))
}

function message(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'analyze-message'
  p.textContent = text
  return p
}

function renderStats(stats: RegionStats): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'analyze-stats'
  const u = stats.units
  for (const [label, value] of [
    [t('analyze.stat.mean'), formatStatValue(stats.mean, u)],
    [t('analyze.stat.median'), formatStatValue(stats.median, u)],
    [t('analyze.stat.min'), formatStatValue(stats.min, u)],
    [t('analyze.stat.max'), formatStatValue(stats.max, u)],
    [t('analyze.stat.p10'), formatStatValue(stats.p10, u)],
    [t('analyze.stat.p90'), formatStatValue(stats.p90, u)],
    [t('analyze.stat.stdDev'), formatStatValue(stats.stdDev, u)],
    [t('analyze.stat.area'), formatStatValue(stats.areaKm2, t('analyze.units.km2'))],
  ] as const) {
    grid.appendChild(renderStatTile(label, value))
  }
  return grid
}

/** Coverage as prose rather than a tile, because the number that
 *  matters is what fraction of the region carried data at all — a mean
 *  over 3% of a box is a different claim from a mean over 90% of it. */
function renderCoverage(stats: RegionStats): HTMLElement {
  const p = document.createElement('p')
  p.className = 'analyze-coverage'
  p.textContent = t('analyze.coverage', {
    percent: formatNumber(stats.coverage * 100, { maximumSignificantDigits: 2 }),
    count: formatNumber(stats.count),
  })
  return p
}

/**
 * The uncertainty, stated next to the numbers rather than in a footnote.
 *
 * One luma step is the whole resolution of the transport, and the
 * measured encoder RMSE is about the same size, so that step is the
 * honest floor on any single value here. Saying so on the surface is
 * the difference between a statistic and a claim.
 */
function renderPrecisionNote(scale: ColorScale): HTMLElement {
  const step = Math.abs(scale.vmax - scale.vmin) / 255
  const p = document.createElement('p')
  p.className = 'analyze-precision'
  p.textContent = t('analyze.precision', { step: formatStatValue(step, scale.units) })
  return p
}

function renderExport(src: AnalyzeSource): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'analyze-export'
  btn.textContent = t('analyze.export')
  btn.addEventListener('click', () => {
    if (!lastResult) return
    downloadCsv(
      'terraviz-analysis.csv',
      buildCsvText(lastResult.stats, lastResult.hist, lastResult.scale, {
        datasetTitle: src.datasetTitle(),
        scopeLabel: scopeToValue(scope),
      }),
    )
  })
  return btn
}

/** Exposed for tests: the numbers currently on screen. */
export function currentResult(): RegionStats | null {
  return lastResult?.stats ?? null
}
