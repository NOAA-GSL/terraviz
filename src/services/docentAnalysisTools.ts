/**
 * The data behind Orbit's answers about values (`docs/DATA_ANALYSIS_PLAN.md`
 * §A6, Group D).
 *
 * Orbit has always been able to talk *about* a dataset — its title, its
 * abstract, what the legend image seemed to say — and has been forbidden,
 * correctly, from saying what any number is. The prompt carries "never
 * invent or estimate color scales or value ranges from general
 * knowledge", because until the data-encoded path shipped there was no
 * way for it to know one.
 *
 * There is now. The client holds every texel of the displayed frame on a
 * known grid with an exact mapping to physical units, so a question like
 * "how bad is the smoke over Colorado?" has a real answer that can be
 * computed locally, in a few milliseconds, with no server round-trip.
 * These are the executors that compute it.
 *
 * **The availability gate is the whole safety story.** These tools are
 * offered to the model only when `isAnalysisAvailable()` is true, which
 * requires a registered source *and* a frame — which in turn requires a
 * data-encoded dataset and a working WebGL2 sampler. With either absent
 * the tools are not in the array at all and Orbit behaves exactly as it
 * does today, which is CONTRIBUTING §LLM Integrations rule 2. That is
 * asserted by tests rather than assumed.
 *
 * Everything here is synchronous and local. No network, no new endpoint,
 * and no `await` — which is what lets an executor branch sit in the
 * round-trip loop next to `search_datasets` without changing its shape.
 */

import {
  findExtremum,
  summarize,
  windowForBounds,
  type LatLonBounds,
  type RegionStats,
} from './datasetStats'
import { latLonToTexelUv, uvToTexelInSize } from './datasetProbe'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import type { LumaSnapshot } from './glLumaSampler'
import type { DatasetOverlayOptions } from '../types'
import { resolveRegion } from '../data/regions'
import { logger } from '../utils/logger'

/**
 * What the executors need from the app, narrowed to the three things
 * they actually read.
 *
 * Deliberately not `AnalyzeSource` from `src/ui/analyzeUI.ts`, though
 * `main.ts` satisfies both from the same renderer: that one carries the
 * panel's picking and drawing seams, and a service reaching into a UI
 * module for a type would invert the dependency for no gain.
 */
export interface DocentAnalysisSource {
  /** The displayed frame plus the metadata that makes it meaningful,
   *  or null when nothing analysable is loaded. */
  frame(): {
    snapshot: LumaSnapshot
    scale: ColorScale
    options: DatasetOverlayOptions
  } | null
  /** Fallback title, used only when the frame carries no identity of
   *  its own (a dataset published before `datasetTitle` was stamped on
   *  its overlay options). Prefer `frame().options.datasetTitle`: app
   *  state and the primary renderer are separate facts, and reporting
   *  one dataset's numbers under another's name is worse than
   *  reporting no name. */
  datasetTitle(): string | null
  /** The box currently on screen, for questions scoped to the view. */
  visibleBounds(): LatLonBounds | null
}

let source: DocentAnalysisSource | null = null

/** Wire the executors to the globe. Pass null to unwire (tests, and a
 *  teardown that should not leave a stale renderer reachable). */
export function registerAnalysisSource(src: DocentAnalysisSource | null): void {
  source = src
}

/**
 * Can Orbit answer questions about values right now?
 *
 * Asks for the frame rather than trusting registration, because every
 * reason the answer might be no lives downstream of it: a picture
 * dataset has no `colorScale`, a browser without WebGL2 has no sampler,
 * and a dataset mid-load has no decoded frame. One call covers all
 * three, and it is the same call the executors make.
 */
export function isAnalysisAvailable(): boolean {
  try {
    return source?.frame() != null
  } catch (err) {
    // A renderer torn down between registration and the check. Absent
    // beats throwing inside prompt assembly.
    logger.warn('[Docent] analysis source threw during availability check:', err)
    return false
  }
}

/**
 * Coordinates round to a fixed number of decimals, never to
 * significant digits.
 *
 * `round3` is right for a *value*, whose precision is capped by the
 * transport. It is wrong for a coordinate: three significant figures
 * turns -119.53 into -120, half a degree and about 50 km out, while
 * leaving -9.53 untouched. Precision that varies with magnitude is not
 * precision. Three decimals is ~111 m, matching the rounding
 * `src/analytics/camera.ts` already applies to lat/lon.
 */
function roundCoord(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value
}

/** Three significant digits, matching `formatProbeReading` — the
 *  measured encoder RMSE is about one luma step, so more digits than
 *  the hover readout shows would be false precision in a sentence the
 *  model may well quote back. */
function round3(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value
  const magnitude = Math.ceil(Math.log10(Math.abs(value)))
  const factor = 10 ** (3 - magnitude)
  return Math.round(value * factor) / factor
}

/** The uncertainty that travels with every number these tools return.
 *  One luma step is the whole resolution of the transport, and the
 *  parent plan measured the encoder's own RMSE at about the same size,
 *  so this is the honest floor on any single value. */
function quantisationStep(scale: ColorScale): number {
  return (scale.vmax - scale.vmin) / 255
}

/**
 * A finished, ready-to-quote rendering of one value.
 *
 * `units` alone was not enough. Asked where the smoke was worst with a
 * column-integrated dataset loaded — units `kg m-2` — the model
 * answered "150 micrograms per cubic metre", which is a *concentration*
 * unit belonging to the near-surface dataset it went on to recommend in
 * the same message. It substituted a familiar unit for the real one.
 * The prompt already said to quote units verbatim; the instruction lost
 * to the pull of a unit it had seen a thousand times for smoke.
 *
 * So the number and its units arrive pre-joined, exactly as they should
 * be said, and the prompt asks for this string rather than for a
 * faithful re-rendering of two separate fields. Same lesson as the
 * fly-to: hand over the finished artifact instead of the parts.
 */
function valueText(value: number, scale: ColorScale, atLeast = false): string {
  const prefix = atLeast ? 'at least ' : ''
  return scale.units
    ? `${prefix}${value} ${scale.units}`
    : `${prefix}${value}`
}

/**
 * What to call the dataset these numbers came from.
 *
 * The frame's own stamp wins. `datasetTitle()` reads
 * `appState.currentDataset`, which is a different fact from whatever
 * texture the primary renderer is holding — a multi-globe layout, a
 * tour switching panels, or a load landing between the two can leave
 * them describing different datasets. When that happens the honest
 * answer is the dataset the frame came from, because that is the one
 * the numbers are of.
 *
 * This matters most where the two datasets are siblings. The shipped
 * smoke rows share a bounding box exactly, so a mix-up cannot be seen
 * in the coordinates — but one is a column loading in `kg m-2` and the
 * other a near-surface concentration in `kg m-3`, three orders of
 * magnitude apart. Same place, same grid, entirely different quantity.
 */
function frameDatasetTitle(options: DatasetOverlayOptions): string | undefined {
  return options.datasetTitle ?? source?.datasetTitle() ?? undefined
}

function precisionNote(scale: ColorScale): string {
  const step = round3(quantisationStep(scale))
  return scale.units
    ? `Values are quantised to about ${step} ${scale.units}; do not state more precision than that.`
    : `Values are quantised to about ${step}; do not state more precision than that.`
}

export interface ProbeValueResult {
  ok: boolean
  /** The value and its units, already joined and ready to quote. The
   *  model is asked for this rather than for a faithful re-rendering of
   *  `value` and `units`, because it substituted a plausible-looking
   *  unit from a different dataset when left to compose them. */
  valueText?: string
  error?: string
  dataset?: string
  /** Which frame this measures. These datasets are animations — an
   *  85-frame forecast for the shipped rows — so a value without a time
   *  is a claim about an unnamed instant. Sourced from the same label
   *  the globe shows, so the answer and the screen agree. */
  frameTime?: string
  lat?: number
  lon?: number
  value?: number
  units?: string
  /** True when the point falls in the palette's no-data band. Distinct
   *  from `ok: false` — the dataset covers this point and reports
   *  nothing there, which is a real answer and a different sentence
   *  from "that is outside the coverage". */
  noData?: boolean
  precision?: string
}

/** The value at one point of the displayed frame. */
export function executeProbeValue(
  args: Record<string, unknown>,
  frameTime?: string | null,
): ProbeValueResult {
  const frame = source?.frame()
  if (!frame) return { ok: false, error: 'No dataset carrying values is loaded.' }
  const lat = Number(args.lat)
  const lon = Number(args.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: 'lat and lon are required numbers.' }
  }

  const { snapshot, scale, options } = frame
  const uv = latLonToTexelUv(lat, lon, options)
  if (!uv) {
    return { ok: false, error: 'That point is outside this dataset’s coverage.' }
  }
  const texel = uvToTexelInSize(snapshot.width, snapshot.height, uv)
  if (!texel) return { ok: false, error: 'The frame has no readable size.' }
  const luma = snapshot.data[texel.sy * snapshot.width + texel.sx]
  if (luma === undefined) return { ok: false, error: 'That point is outside the frame.' }

  return {
    ok: true,
    dataset: frameDatasetTitle(options),
    ...(frameTime ? { frameTime } : {}),
    lat: roundCoord(lat),
    lon: roundCoord(lon),
    value: round3(lumaToValue(luma, scale)),
    units: scale.units,
    valueText: valueText(round3(lumaToValue(luma, scale)), scale),
    noData: isTransparentLuma(luma, scale),
    precision: precisionNote(scale),
  }
}

/**
 * Resolve the region argument shared by `summarize_region` and
 * `find_extremum`.
 *
 * Accepts a named region from the same table Orbit's `<>` marker
 * already uses, an explicit bbox, or nothing — which means the whole
 * dataset. A name that does not resolve is an error rather than a
 * silent fall back to the whole dataset: the model asked about
 * somewhere specific, and answering about everywhere under that
 * region's name would be a wrong answer rather than a missing one.
 */
export interface ResolvedScope {
  /** Which surface the Analyze panel would need to select to show the
   *  same thing. `bbox` has no equivalent in the panel's picker, which
   *  is why the chip is not offered for it. */
  kind: 'dataset' | 'view' | 'named' | 'bbox'
  /** Display name, when `kind === 'named'` — resolved through the
   *  region table, so the chip and the panel agree on the spelling. */
  name?: string
}

function resolveScope(
  args: Record<string, unknown>,
): { bounds: LatLonBounds | null; label: string; scope: ResolvedScope } | { error: string } {
  const name = typeof args.region_name === 'string' ? args.region_name.trim() : ''
  if (name) {
    const entry = resolveRegion(name)
    if (!entry) {
      return { error: `Unknown region "${name}". Use a bbox, or omit the region for the whole dataset.` }
    }
    const [w, s, e, n] = entry.bounds
    return { bounds: { n, s, w, e }, label: entry.name, scope: { kind: 'named', name: entry.name } }
  }
  const bbox = args.bbox as Record<string, unknown> | undefined
  if (bbox && typeof bbox === 'object') {
    const n = Number(bbox.north ?? bbox.n)
    const s = Number(bbox.south ?? bbox.s)
    const w = Number(bbox.west ?? bbox.w)
    const e = Number(bbox.east ?? bbox.e)
    if ([n, s, w, e].every(Number.isFinite)) {
      return { bounds: { n, s, w, e }, label: 'the requested area', scope: { kind: 'bbox' } }
    }
    return { error: 'bbox needs finite north, south, west and east.' }
  }
  if (args.region === 'view') {
    const visible = source?.visibleBounds() ?? null
    if (visible) return { bounds: visible, label: 'the current view', scope: { kind: 'view' } }
  }
  return { bounds: null, label: 'the whole dataset', scope: { kind: 'dataset' } }
}

export interface SummarizeRegionResult {
  ok: boolean
  /** The value and its units, already joined and ready to quote. The
   *  model is asked for this rather than for a faithful re-rendering of
   *  `value` and `units`, because it substituted a plausible-looking
   *  unit from a different dataset when left to compose them. */
  meanText?: string
  error?: string
  dataset?: string
  /** Which frame this measures. These datasets are animations — an
   *  85-frame forecast for the shipped rows — so a value without a time
   *  is a claim about an unnamed instant. Sourced from the same label
   *  the globe shows, so the answer and the screen agree. */
  frameTime?: string
  region?: string
  /** Not sent to the model — consumed by `docentService` to decide
   *  whether the Analyze chip can be offered for this answer. */
  scope?: ResolvedScope
  units?: string
  mean?: number
  median?: number
  min?: number
  max?: number
  p10?: number
  p90?: number
  /** Fraction of the region's texels that carry data, 0–1. A mean over
   *  3% of a box is a different claim from a mean over 90% of it, and
   *  the model needs the number to say so. */
  coverage?: number
  areaWithDataKm2?: number
  precision?: string
  /** Present when coverage is low enough that a bare mean would
   *  mislead. Prose rather than a flag, because it goes into a prompt. */
  caveat?: string
}

/** Coverage below this and the mean describes a scattering rather than
 *  a region, so the result says so in words the model can repeat. */
const LOW_COVERAGE = 0.25

/** Area-weighted statistics over a region of the displayed frame. */
export function executeSummarizeRegion(
  args: Record<string, unknown>,
  frameTime?: string | null,
): SummarizeRegionResult {
  const frame = source?.frame()
  if (!frame) return { ok: false, error: 'No dataset carrying values is loaded.' }
  const scope = resolveScope(args)
  if ('error' in scope) return { ok: false, error: scope.error }

  const { snapshot, scale, options } = frame
  const window = scope.bounds ? windowForBounds(snapshot, scope.bounds, options) : undefined
  if (scope.bounds && !window) {
    return { ok: false, error: `${scope.label} falls outside this dataset’s coverage.` }
  }
  const stats: RegionStats | null = summarize(snapshot, scale, options, window ?? undefined)
  if (!stats) {
    return { ok: false, error: `No texels in ${scope.label} carry data in the displayed frame.` }
  }

  return {
    ok: true,
    dataset: frameDatasetTitle(options),
    ...(frameTime ? { frameTime } : {}),
    region: scope.label,
    scope: scope.scope,
    units: stats.units,
    meanText: valueText(round3(stats.mean), scale),
    mean: round3(stats.mean),
    median: round3(stats.median),
    min: round3(stats.min),
    max: round3(stats.max),
    p10: round3(stats.p10),
    p90: round3(stats.p90),
    coverage: round3(stats.coverage),
    areaWithDataKm2: round3(stats.areaKm2),
    precision: precisionNote(scale),
    ...(stats.coverage < LOW_COVERAGE
      ? {
          caveat:
            `Only ${Math.round(stats.coverage * 100)}% of ${scope.label} carries data in this frame. ` +
            'Say so — these statistics describe that part, not the whole area.',
        }
      : {}),
  }
}

export interface FindExtremumResult {
  ok: boolean
  /** The value and its units, already joined and ready to quote. The
   *  model is asked for this rather than for a faithful re-rendering of
   *  `value` and `units`, because it substituted a plausible-looking
   *  unit from a different dataset when left to compose them. */
  valueText?: string
  error?: string
  dataset?: string
  /** Which frame this measures. These datasets are animations — an
   *  85-frame forecast for the shipped rows — so a value without a time
   *  is a claim about an unnamed instant. Sourced from the same label
   *  the globe shows, so the answer and the screen agree. */
  frameTime?: string
  region?: string
  /** Not sent to the model — consumed by `docentService` to decide
   *  whether the Analyze chip can be offered for this answer. */
  scope?: ResolvedScope
  kind?: 'max' | 'min'
  /** Present when the extremum lands on the top of the colour scale.
   *  A field that clips there reports its maximum as exactly `vmax`,
   *  which is a floor rather than a measurement, and quoting it as an
   *  exact figure overstates what the encoding can carry. */
  saturated?: string
  /** Present when the extreme value is shared by more than one texel,
   *  which for a clipping field is the normal case. Without it the
   *  answer reads as though one specific spot were the worst, when the
   *  reported point is only a representative of a wider area. */
  plateau?: string
  lat?: number
  lon?: number
  value?: number
  units?: string
  precision?: string
}

/**
 * Where the field is at its highest or lowest, and by how much.
 *
 * The plan flags this as the most noise-sensitive statistic available
 * and the one most likely to be quoted back, which is why `precision`
 * rides along with every result: a single extreme texel sits at the top
 * of the compression noise, not above it.
 */
export function executeFindExtremum(
  args: Record<string, unknown>,
  frameTime?: string | null,
): FindExtremumResult {
  const frame = source?.frame()
  if (!frame) return { ok: false, error: 'No dataset carrying values is loaded.' }
  const scope = resolveScope(args)
  if ('error' in scope) return { ok: false, error: scope.error }

  const kind = args.kind === 'min' ? 'min' : 'max'
  const { snapshot, scale, options } = frame
  const window = scope.bounds ? windowForBounds(snapshot, scope.bounds, options) : undefined
  if (scope.bounds && !window) {
    return { ok: false, error: `${scope.label} falls outside this dataset’s coverage.` }
  }
  const found = findExtremum(snapshot, scale, kind, options, window ?? undefined)
  if (!found) {
    return { ok: false, error: `No texels in ${scope.label} carry data in the displayed frame.` }
  }

  return {
    ok: true,
    dataset: frameDatasetTitle(options),
    ...(frameTime ? { frameTime } : {}),
    region: scope.label,
    scope: scope.scope,
    kind,
    lat: roundCoord(found.lat),
    lon: roundCoord(found.lon),
    value: round3(found.value),
    units: scale.units,
    valueText: valueText(round3(found.value), scale, kind === 'max' && found.value >= scale.vmax),
    precision: precisionNote(scale),
    ...(found.plateau
      ? {
          plateau:
            `This value is shared by ${found.tieCount} grid cells covering about ` +
            `${round3(found.tieAreaKm2)} km²` +
            (found.patchCount > 1 ? ` in ${found.patchCount} separate patches` : '') +
            '. The coordinates are the middle of the largest patch, not a uniquely ' +
            'worst point — say that it is worst across an area rather than at a spot.',
        }
      : {}),
    ...(kind === 'max' && found.value >= scale.vmax
      ? {
          saturated:
            `This sits at the very top of the dataset's scale (${scale.vmax}${scale.units ? ` ${scale.units}` : ''}), ` +
            'so it is a floor, not a measurement — the true value is at least this and may be higher. Say "at least".',
        }
      : {}),
  }
}
