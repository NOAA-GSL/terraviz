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
  /** Title of the dataset the numbers came from, so a tool result can
   *  say what it measured rather than leaving the model to assume. */
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

function precisionNote(scale: ColorScale): string {
  const step = round3(quantisationStep(scale))
  return scale.units
    ? `Values are quantised to about ${step} ${scale.units}; do not state more precision than that.`
    : `Values are quantised to about ${step}; do not state more precision than that.`
}

export interface ProbeValueResult {
  ok: boolean
  error?: string
  dataset?: string
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
export function executeProbeValue(args: Record<string, unknown>): ProbeValueResult {
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
    dataset: source?.datasetTitle() ?? undefined,
    lat: round3(lat),
    lon: round3(lon),
    value: round3(lumaToValue(luma, scale)),
    units: scale.units,
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
function resolveScope(
  args: Record<string, unknown>,
): { bounds: LatLonBounds | null; label: string } | { error: string } {
  const name = typeof args.region_name === 'string' ? args.region_name.trim() : ''
  if (name) {
    const entry = resolveRegion(name)
    if (!entry) {
      return { error: `Unknown region "${name}". Use a bbox, or omit the region for the whole dataset.` }
    }
    const [w, s, e, n] = entry.bounds
    return { bounds: { n, s, w, e }, label: entry.name }
  }
  const bbox = args.bbox as Record<string, unknown> | undefined
  if (bbox && typeof bbox === 'object') {
    const n = Number(bbox.north ?? bbox.n)
    const s = Number(bbox.south ?? bbox.s)
    const w = Number(bbox.west ?? bbox.w)
    const e = Number(bbox.east ?? bbox.e)
    if ([n, s, w, e].every(Number.isFinite)) {
      return { bounds: { n, s, w, e }, label: 'the requested area' }
    }
    return { error: 'bbox needs finite north, south, west and east.' }
  }
  if (args.region === 'view') {
    const visible = source?.visibleBounds() ?? null
    if (visible) return { bounds: visible, label: 'the current view' }
  }
  return { bounds: null, label: 'the whole dataset' }
}

export interface SummarizeRegionResult {
  ok: boolean
  error?: string
  dataset?: string
  region?: string
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
export function executeSummarizeRegion(args: Record<string, unknown>): SummarizeRegionResult {
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
    dataset: source?.datasetTitle() ?? undefined,
    region: scope.label,
    units: stats.units,
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
  error?: string
  dataset?: string
  region?: string
  kind?: 'max' | 'min'
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
export function executeFindExtremum(args: Record<string, unknown>): FindExtremumResult {
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
    dataset: source?.datasetTitle() ?? undefined,
    region: scope.label,
    kind,
    lat: round3(found.lat),
    lon: round3(found.lon),
    value: round3(found.value),
    units: scale.units,
    precision: precisionNote(scale),
  }
}
