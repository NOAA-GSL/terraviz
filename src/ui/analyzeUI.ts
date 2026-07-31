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
  areaAboveKm2,
  buildHistogram,
  sampleTransect,
  summarize,
  summarizeTransect,
  transectSampleCount,
  windowForBounds,
  type LatLonBounds,
  type LumaHistogram,
  type RegionStats,
  type TexelWindow,
  type TransectEndpoints,
  type TransectSample,
} from '../services/datasetStats'
import { extractContourSet, type ContourLevel } from '../services/datasetContours'
import type { LumaSnapshot } from '../services/glLumaSampler'
import {
  DEFAULT_DISPLAY,
  buildDisplayLut,
  colorbarTicks,
  displayColorAtValue,
  type ColorScaleDisplay,
} from '../services/colorScaleDisplay'
import type { ColorScale } from '../types/color-scale'
import type { DatasetOverlayOptions } from '../types'
import { getRegionNames, resolveRegion } from '../data/regions'
import {
  formatStatValue,
  histogramBucketValueWidth,
  renderHistogram,
  renderStatTile,
  renderTransectChart,
} from './analyzeCharts'
import { buildCsvText, buildTransectCsvText, downloadCsv } from './analyzeExport'
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
  /** Identity of that dataset, so the panel can tell when the globe
   *  underneath it has been replaced. Title is not enough — two rows
   *  can share one. */
  datasetId(): string | null
  /** Two-point picking on the globe, or null where there is no map to
   *  pick on. Optional so a caller can wire the statistics without the
   *  transect, and so the tests can drive the panel with no map. */
  transect?(): TransectPicker | null
  /** Drawing the analysed box on the globe. Same optionality, same
   *  reason. */
  regionOutline?(): RegionOutline | null
  /** Drawing isolines on the globe. Same optionality, same reason. */
  contours?(): ContourOverlay | null
}

/**
 * The globe's side of the contours: draw the isoline, and take it away.
 *
 * Same seam shape as `RegionOutline` and `TransectPicker`, for the same
 * reason — the panel computes geometry and never learns that MapLibre
 * exists, and a test can drive the contour section with no map.
 */
export interface ContourOverlay {
  show(levels: ContourLevel[]): void
  clear(): void
}

/**
 * The globe's side of the region picker: show where the numbers came
 * from.
 *
 * "Alabama, 180,000 km² with data" is unfalsifiable on a globe that
 * gives no indication of which box was measured — the panel names a
 * region and the map says nothing back. This is the same seam shape as
 * `TransectPicker`, for the same reason: the panel should not know that
 * MapLibre exists.
 */
export interface RegionOutline {
  show(bounds: LatLonBounds): void
  clear(): void
}

/**
 * The globe's side of the transect: pick two points, keep them
 * draggable, draw the line between them.
 *
 * A seam rather than a direct call into the renderer, for the same
 * reason `AnalyzeSource` is one — the panel should not know that
 * MapLibre exists, and a test should be able to drive a transect
 * without a map.
 */
export interface TransectPicker {
  /** Arm picking. `onChange` fires when the pair completes, on every
   *  drag of an endpoint, and with null when cleared. */
  begin(onChange: (ends: TransectEndpoints | null) => void): void
  /** How many of the two points have been placed. */
  progress(): number
  clear(): void
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
/** The dataset the numbers on screen were computed from. */
let openedFor: string | null = null
/** The transect section's own container, so a drag can redraw it
 *  without recomputing the region statistics above it. */
let transectHost: HTMLElement | null = null
let transectEnds: TransectEndpoints | null = null
let transectArmed = false
/** The contour section's own container, so changing the threshold
 *  redraws the isoline without recomputing the histogram above it. */
let contourHost: HTMLElement | null = null
/** Whether lines are currently on the globe, so the section can offer
 *  Draw or Clear rather than inferring it from the threshold. */
let contourDrawn = false
/**
 * How many isolines to aim for.
 *
 * Passed to `colorbarTicks`, which rounds to a 1/2/5 × 10^k step and so
 * returns near this rather than exactly it. Five is a starting point,
 * not a measurement: on a smoke plume at low zoom, much past a dozen
 * lines reads as hatching rather than as structure, and the right
 * number is the sort of thing that only settles by looking at real
 * fields.
 */
const CONTOUR_LEVEL_TARGET = 5
/** The texel window the region statistics used, so the isoline covers
 *  exactly the region the numbers beside it describe. */
let contourWindow: TexelWindow | undefined
let lastTransect: { samples: TransectSample[]; scale: ColorScale } | null = null
/**
 * The frame everything on screen was computed from.
 *
 * Held so a drag re-samples the transect against the same frame the
 * histogram describes, rather than calling `frame()` per drag event: on
 * a playing video that would be a full readback at pointer rate, which
 * is the failure `glLumaSampler`'s docstring is emphatic about. It also
 * makes the panel internally consistent — one frame, one set of numbers.
 */
let lastFrame: {
  snapshot: LumaSnapshot
  scale: ColorScale
  options: DatasetOverlayOptions
} | null = null

/**
 * Wire the panel to the app. Call once at boot.
 *
 * Resets the picked region, because that choice belongs to the source
 * it was made against. Within one session the choice is deliberately
 * sticky across opens — someone comparing regions should not have to
 * re-pick on every open — but a new source is a new context.
 */
export function initAnalyzeUI(src: AnalyzeSource): void {
  source?.transect?.()?.clear()
  source?.regionOutline?.()?.clear()
  clearContours()
  source = src
  scope = { kind: 'dataset' }
  transectEnds = null
  transectArmed = false
}

/** Whether the panel is currently open. Used by tests and the scene. */
export function isAnalyzeUIOpen(): boolean {
  return root !== null
}

/** Close the panel and return focus to whatever opened it. */
export function closeAnalyzeUI(): void {
  // The line and the region box are drawn on the globe, not in the
  // panel, so closing has to take them with it — either left behind
  // would be an annotation with nothing on screen left to explain or
  // remove it.
  clearTransect()
  clearContours()
  source?.regionOutline?.()?.clear()
  root?.remove()
  root = null
  openedFor = null
  transectHost = null
  contourHost = null
  lastFrame = null
  document.removeEventListener('keydown', onEscape, true)
  lastTrigger?.focus()
  lastTrigger = null
}

function clearTransect(): void {
  source?.transect?.()?.clear()
  transectEnds = null
  transectArmed = false
  lastTransect = null
}

/**
 * Close the panel when the globe under it changes to a different
 * dataset.
 *
 * The numbers are computed once, on open, against one frame of one
 * dataset. Swapping the dataset while the panel stays open leaves a
 * statistics table describing something that is no longer on screen —
 * every figure real, every figure about the wrong thing, and nothing
 * saying so. That is precisely the failure this module's own docstring
 * names, and it survived because the existing teardown only fired when
 * *no* panel had a data-encoded dataset left; swapping one for another
 * kept it open.
 *
 * Closed rather than recomputed on purpose. Recomputing would spend a
 * full-frame readback the viewer did not ask for, and the region they
 * picked belonged to the dataset that just left.
 */
export function notifyAnalyzeDatasetChanged(datasetId: string | null): void {
  if (root && openedFor !== datasetId) closeAnalyzeUI()
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
export function openAnalyzeUI(
  triggeredBy?: HTMLElement | null,
  /** §A6 — open already scoped to a region, for the chip on an Orbit
   *  message that just described one. Overrides the sticky choice from
   *  the last open, because arriving here from "the smoke is worst over
   *  Colorado" and landing on the previous region would be the one
   *  wrong answer available. */
  presetScope?: AnalyzeScope,
): HTMLElement {
  closeAnalyzeUI()
  lastTrigger = triggeredBy ?? null
  if (presetScope) scope = presetScope

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
  openedFor = source?.datasetId() ?? null
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
  lastFrame = null
  transectHost = null
  contourHost = null

  const src = source
  if (!src) {
    body.appendChild(message(t('analyze.empty.unavailable')))
    return
  }
  const frame = src.frame()
  lastFrame = frame
  if (!frame) {
    // No data-encoded dataset loaded, or no WebGL2. Absent rather than
    // broken, which is the availability posture the rest of the
    // data-encoded work takes. The box goes with the numbers it was
    // explaining.
    src.regionOutline?.()?.clear()
    clearContours()
    body.appendChild(message(t('analyze.empty.noDataset')))
    return
  }

  renderRegionBlock(body, src, frame)

  // Appended whatever the region block decided, and deliberately so: a
  // named region can be empty while the dataset is full, and the line a
  // viewer wants to draw is very often the one that leaves that box.
  // Only the globe's absence removes this — availability, not state.
  if (src.transect?.()) {
    transectHost = document.createElement('section')
    transectHost.className = 'analyze-transect-section'
    body.appendChild(transectHost)
    renderTransectSection()
  }

  // Same availability-not-state rule as the transect: present whenever
  // there is a globe to draw on. Unlike the transect it needs the
  // region block to have produced a histogram, which `renderContourSection`
  // checks for itself rather than being gated here — the two reasons a
  // section can be absent should not be spelled in two places.
  if (src.contours?.()) {
    contourHost = document.createElement('section')
    contourHost.className = 'analyze-contour-section'
    body.appendChild(contourHost)
    renderContourSection()
  }
}

function renderRegionBlock(
  body: HTMLElement,
  src: AnalyzeSource,
  frame: { snapshot: LumaSnapshot; scale: ColorScale; options: DatasetOverlayOptions },
): void {
  const { snapshot, scale, options } = frame
  const scoped = boundsForScope(scope, src)
  syncRegionOutline(src, scoped)
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
  contourWindow = window ?? undefined

  body.appendChild(renderHistogram(hist, scale, src.display()))
  body.appendChild(renderHistogramCaption(scale))
  body.appendChild(renderStats(stats))
  body.appendChild(renderCoverage(stats))
  body.appendChild(renderPrecisionNote(scale))
  body.appendChild(renderExport(src))
}

/**
 * The transect block: a control, and a profile once there is one.
 *
 * Redrawn on its own rather than through `refresh`, because a drag
 * changes only this and `refresh` would recompute the histogram and
 * every region statistic above it on each pointer frame.
 */
function renderTransectSection(): void {
  const host = transectHost
  const picker = source?.transect?.()
  if (!host || !picker) return
  host.replaceChildren()

  const head = document.createElement('div')
  head.className = 'analyze-transect-head'
  const label = document.createElement('h3')
  label.textContent = t('analyze.transect.title')
  head.appendChild(label)
  host.appendChild(head)

  if (transectArmed) {
    head.appendChild(
      actionButton(t('analyze.transect.cancel'), () => {
        clearTransect()
        renderTransectSection()
      }),
    )
    host.appendChild(
      message(
        picker.progress() >= 1
          ? t('analyze.transect.pickSecond')
          : t('analyze.transect.pickFirst'),
      ),
    )
    return
  }

  if (!transectEnds) {
    head.appendChild(
      actionButton(t('analyze.transect.draw'), () => {
        transectArmed = true
        transectEnds = null
        picker.begin((ends) => {
          transectEnds = ends
          transectArmed = false
          renderTransectSection()
        })
        renderTransectSection()
      }),
    )
    host.appendChild(message(t('analyze.transect.hint')))
    return
  }

  head.appendChild(
    actionButton(t('analyze.transect.clear'), () => {
      clearTransect()
      renderTransectSection()
    }),
  )

  const frame = lastFrame
  if (!frame) {
    host.appendChild(message(t('analyze.empty.noDataset')))
    return
  }
  const { snapshot, scale, options } = frame
  const samples = sampleTransect(
    snapshot,
    scale,
    transectEnds.from,
    transectEnds.to,
    transectSampleCount(snapshot, transectEnds.from, transectEnds.to, options),
    options,
  )
  const summary = summarizeTransect(samples)
  if (!summary) {
    host.appendChild(message(t('analyze.transect.noData')))
    return
  }
  lastTransect = { samples, scale }

  host.appendChild(renderTransectChart(samples, scale, source?.display() ?? DEFAULT_DISPLAY))
  host.appendChild(caption(t('analyze.transect.caption')))

  const grid = document.createElement('div')
  grid.className = 'analyze-stats'
  const u = scale.units
  grid.appendChild(
    renderStatTile(
      t('analyze.transect.stat.length'),
      formatStatValue(summary.lengthKm, t('analyze.units.km')),
    ),
  )
  grid.appendChild(renderStatTile(t('analyze.stat.min'), formatStatValue(summary.min, u)))
  grid.appendChild(renderStatTile(t('analyze.stat.max'), formatStatValue(summary.max, u)))
  grid.appendChild(renderStatTile(t('analyze.stat.mean'), formatStatValue(summary.mean, u)))
  host.appendChild(grid)

  host.appendChild(
    coverageNote(
      t('analyze.transect.coverage', {
        withData: formatNumber(summary.withData),
        samples: formatNumber(summary.samples),
        spacing: formatStatValue(
          summary.samples > 1 ? summary.lengthKm / (summary.samples - 1) : 0,
          t('analyze.units.km'),
        ),
      }),
    ),
  )

  const exportBtn = actionButton(t('analyze.transect.export'), () => {
    if (!lastTransect) return
    downloadCsv(
      'terraviz-transect.csv',
      buildTransectCsvText(lastTransect.samples, lastTransect.scale, {
        datasetTitle: source?.datasetTitle() ?? null,
        scopeLabel: t('analyze.transect.title'),
      }),
    )
  })
  // The same full-width control the region export uses, not the small
  // inline action in the header row.
  exportBtn.className = 'analyze-export'
  host.appendChild(exportBtn)
}

/**
 * The contour block: outline whatever the colorbar's threshold is
 * isolating, and say how much area that is.
 *
 * The threshold is A1's, not one of this panel's own. That makes the
 * line and the colour agree by construction — what the globe is
 * isolating is what gets outlined and what gets measured — at the cost
 * of the contour being tied to a viewing control, so resetting the
 * palette takes it away. That tradeoff was chosen deliberately.
 *
 * Read at Draw time rather than subscribed to, which is this panel's
 * standing doctrine: computation is user-initiated and one-shot. Moving
 * the colorbar afterwards leaves the drawn lines where they were until
 * Draw is pressed again, and the caption says so rather than leaving
 * someone to discover it.
 */
function renderContourSection(): void {
  const host = contourHost
  const overlay = source?.contours?.()
  const src = source
  if (!host || !overlay || !src) return
  host.replaceChildren()

  const head = document.createElement('div')
  head.className = 'analyze-contour-head'
  const label = document.createElement('h3')
  label.textContent = t('analyze.contour.title')
  head.appendChild(label)
  host.appendChild(head)

  const frame = lastFrame
  const result = lastResult
  if (!frame || !result) {
    host.appendChild(message(t('analyze.empty.noValues')))
    return
  }

  const display = src.display()
  const { min, max } = display.threshold
  const { scale } = result

  // Levels are the colour bar's own round-number ticks, not an even
  // division of min..max. Two reasons: a tick lands on 1/2/5 × 10^k
  // rather than on 3.47e-5, which is what every paper contour map does
  // and what a reader can hold in their head; and because they are
  // *the same* ticks the bar is labelled with, a line on the globe can
  // be read against the legend without interpolating between labels.
  //
  // The threshold scopes rather than sets them. With no threshold the
  // contours span the whole range; with one, they subdivide only the
  // band the globe is isolating — which is the colour bar saying which
  // part of the range is worth subdividing.
  const inScope = (v: number): boolean =>
    (min === null || v >= min) && (max === null || v <= max)
  const lut = buildDisplayLut(scale, display)
  const levels = colorbarTicks(scale, display, CONTOUR_LEVEL_TARGET)
    .map(tick => tick.value)
    .filter(v => Number.isFinite(v) && inScope(v))

  if (!levels.length) {
    // Can happen with a narrow threshold band that no round tick falls
    // inside. Say which control moves it rather than showing a dead
    // button.
    host.appendChild(message(t('analyze.contour.noLevels')))
    return
  }

  head.appendChild(
    actionButton(
      contourDrawn ? t('analyze.contour.clear') : t('analyze.contour.draw'),
      () => {
        if (contourDrawn) {
          clearContours()
        } else {
          const set = extractContourSet(
            frame.snapshot, frame.scale, levels, frame.options, contourWindow)
          // Each line painted in the colour the globe is already using
          // at that level, so the map and its own contours cannot
          // disagree. A level the ramp hides gets no colour back and
          // falls through to the default rather than being drawn in a
          // colour that appears nowhere on the surface.
          overlay.show(set.map((level): ContourLevel => {
            const color = displayColorAtValue(lut, scale, level.value)
            return color ? { ...level, color } : level
          }))
          contourDrawn = true
        }
        renderContourSection()
      },
    ),
  )

  // Area at each level, from the histogram rather than from the polygons
  // the lines enclose — see `datasetContours`' header for why the counted
  // number is the one to quote. This is the newsroom question asked at
  // every line rather than at one.
  const list = document.createElement('ul')
  list.className = 'analyze-contour-levels'
  for (const value of levels) {
    const row = document.createElement('li')
    const swatch = document.createElement('span')
    swatch.className = 'analyze-contour-swatch'
    const color = displayColorAtValue(lut, scale, value)
    if (color) swatch.style.background = color
    row.appendChild(swatch)
    const text = document.createElement('span')
    text.textContent = t('analyze.contour.levelRow', {
      level: formatStatValue(value, scale.units),
      km2: formatNumber(Math.round(areaAboveKm2(result.hist, scale, value))),
    })
    row.appendChild(text)
    list.appendChild(row)
  }
  host.appendChild(list)

  host.appendChild(
    caption(
      min !== null || max !== null
        ? t('analyze.contour.scopedCaption', { count: formatNumber(levels.length) })
        : t('analyze.contour.rangeCaption', { count: formatNumber(levels.length) }),
    ),
  )
  host.appendChild(caption(t('analyze.contour.staleNote')))
}

function clearContours(): void {
  source?.contours?.()?.clear()
  contourDrawn = false
}

function actionButton(text: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'analyze-action'
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}

function caption(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'analyze-caption'
  p.textContent = text
  return p
}

function coverageNote(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'analyze-coverage'
  p.textContent = text
  return p
}

/**
 * Longitude span past which a box is not worth outlining.
 *
 * "What I can see" on a zoomed-out globe resolves to most of the world,
 * and a ring at the antimeridian and the poles is noise rather than an
 * answer to "where did these numbers come from". Named regions are
 * never this wide.
 */
const OUTLINE_MAX_LON_SPAN = 300

/**
 * Keep the drawn box in step with the picked region.
 *
 * The *requested* region is outlined, not the part of it the dataset
 * covers — including when the region misses the dataset entirely, which
 * is the one case where seeing the box is the whole explanation of the
 * message beside it. Coverage already reports how much of the box
 * carried data, so the two together say more than either alone.
 */
function syncRegionOutline(src: AnalyzeSource, scoped: ScopeBounds): void {
  const outline = src.regionOutline?.()
  if (!outline) return
  if (scoped.kind !== 'box') {
    outline.clear()
    return
  }
  const { w, e } = scoped.bounds
  const span = w <= e ? e - w : 360 - w + e
  if (span >= OUTLINE_MAX_LON_SPAN) outline.clear()
  else outline.show(scoped.bounds)
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
 * How wide a bar is, in the dataset's own units.
 *
 * The chart aggregates several luma codes per bar (see
 * `analyzeCharts.renderHistogram` for why the transport makes that the
 * honest resolution), so the reader is told what a bar actually covers
 * rather than left to infer it from an unlabelled axis.
 */
function renderHistogramCaption(scale: ColorScale): HTMLElement {
  const p = document.createElement('p')
  p.className = 'analyze-caption'
  p.textContent = t('analyze.histogram.caption', {
    width: formatStatValue(histogramBucketValueWidth(scale), scale.units),
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
