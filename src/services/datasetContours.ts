/**
 * Isolines over a data-encoded frame — the A5 half of
 * `docs/DATA_ANALYSIS_PLAN.md`.
 *
 * `datasetStats` answers "how much is above this line" as a single
 * number. This answers "and *where* are those lines", by marching
 * squares over the luma array at a set of physical levels, producing
 * lat/lon polylines a map can draw.
 *
 * A contour map is a *set* of lines, not one. The levels are chosen by
 * the caller — the Analyze panel passes the colour bar's own round-number
 * ticks, so every line on the globe corresponds to a labelled tick on the
 * bar and reading one against the other needs no interpolation.
 *
 * Pure, like every other reducer here: a `LumaSnapshot` in, geometry
 * out, no GL context and no MapLibre. See `datasetStats.ts` for why that
 * matters — the arithmetic that is easiest to get quietly wrong is the
 * arithmetic that has to be testable on its own.
 *
 * Four things this module is careful about:
 *
 *  1. **Absent data breaks the cell, it does not bound it.** A texel the
 *     sidecar calls "nothing measured here" is not a low value, and a
 *     cell touching one emits no segment at any level. Skip this and the
 *     contours trace the coastline of the no-data region as though it
 *     were a real gradient — a confident, beautifully smooth, entirely
 *     fictional isoline. This is the same mistake `datasetStats` refuses
 *     to make when it excludes absent texels from the mean rather than
 *     counting them as `vmin`.
 *  2. **Values come from `lumaToValue`, never from an inverse of it.**
 *     Levels are not converted into luma codes; instead a 256-entry
 *     table is built *through* `lumaToValue` and every comparison happens
 *     in physical units. A separate value→luma inverse would be a second
 *     copy of the mapping that has to be kept in step with the first one
 *     forever, in a different file, and the day it drifts the contour and
 *     the readout disagree while both look right.
 *  3. **One pass over the cells, not one pass per level.** The shipped
 *     frames are around 8.4 million texels. Re-walking that per level
 *     would put a visible stall between pressing the button and seeing
 *     lines, and the cost would grow with the number of levels rather
 *     than staying near the cost of one. Corner reads, the absent-data
 *     test and the cell's own min/max happen once; each level then costs
 *     a comparison against that range and, for the few cells it actually
 *     crosses, a marching-squares case.
 *
 *     This is a *user-initiated* pass, and it is not cheap even so.
 *     Measured on a synthetic 4096x2048 field with four plume-shaped
 *     blobs, twelve levels: **1595 ms** as first written, **376 ms** now,
 *     for byte-identical output. Almost all of that came from two places
 *     that looked free — five closures allocated on every emitting cell,
 *     and `h${x},${y}` string edge keys built and hashed once per
 *     crossing. Nine tenths of the time was in emitting segments rather
 *     than in walking 8.4 million cells, which is the opposite of where
 *     it looks like it should be. Measure before optimising this file.
 *
 *     The number that matters downstream: even at 376 ms this is about
 *     2.7 extractions per second against 30 fps playback, so contours
 *     cannot track a playing video and the Analyze panel drops them when
 *     the frame moves rather than pretending they are still current.
 *  4. **The antimeridian splits a line rather than crossing it.** A
 *     polyline whose longitudes jump from +179 to −179 is drawn by
 *     MapLibre as a stripe straight back across the globe. Lines are cut
 *     where they wrap.
 *
 * What this does **not** claim: the polygons enclosed by these lines are
 * not where the area figures come from. `areaAboveKm2` counts whole
 * texels by their own spherical cell area; an isoline is interpolated
 * between texel centres. They agree to within about one texel around the
 * perimeter, and the counted area is the one to quote, because it does
 * not depend on how the interpolation resolved an ambiguous cell.
 */

import type { DatasetOverlayOptions } from '../types'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import { texelUvToLatLon } from './datasetProbe'
import { fullWindow, LUMA_LEVELS, type TexelWindow } from './datasetStats'
import type { LumaSnapshot } from './glLumaSampler'

export interface ContourPoint {
  lat: number
  lon: number
}

/** One isoline, in order. Open at the frame's edge, closed (first point
 *  repeated last) where it encircles a region. */
export type ContourLine = ContourPoint[]

/** Every isoline at one physical level. */
export interface ContourLevel {
  /** The physical value these lines trace. */
  value: number
  lines: ContourLine[]
  /**
   * CSS colour for this level, set by the caller from the same display
   * LUT the shader samples so a line matches the palette at its own
   * value. Absent when the caller does not care — the geometry is
   * complete without it.
   */
  color?: string
}

/**
 * Most levels a single extraction will trace.
 *
 * Not a performance guard — the single pass handles more without much
 * extra cost — but a legibility one. Past about a dozen lines over a
 * smoke plume the globe reads as hatching rather than as structure, and
 * a caller asking for hundreds has almost certainly computed its levels
 * wrong.
 */
export const MAX_CONTOUR_LEVELS = 24

/**
 * Longitude jump beyond which a step is treated as a seam wrap rather
 * than real movement.
 *
 * Contour vertices are at most one texel apart, and no shipped dataset
 * has texels remotely this wide, so anything bigger is the ±180
 * discontinuity rather than a genuine stride.
 */
const SEAM_JUMP_DEGREES = 180

/** Per-luma-code physical values and absence flags, built once per
 *  extraction so the inner loop is two array reads. */
interface CodeTable {
  value: Float64Array
  absent: Uint8Array
  /**
   * Lowest code that is *not* absent, when absence is a contiguous band
   * at the bottom of the range. Both sidecar forms produce exactly that
   * — `luma < dataMinLuma` and `luma / 255 < transparentRange` are both
   * "below a cutoff" — which lets the cell walk decide rule 1 from its
   * lowest corner alone instead of testing all four.
   */
  absentBelow: number
  /**
   * Absence is that low band *and* values rise with the code, so a
   * cell's value range can be read off its code range. False sends the
   * walk down the general path: the fast tests are an optimisation, not
   * a new contract, and a table shaped differently than expected must
   * come out with the same lines rather than with quietly wrong ones.
   */
  monotone: boolean
}

function buildCodeTable(scale: ColorScale): CodeTable {
  const value = new Float64Array(LUMA_LEVELS)
  const absent = new Uint8Array(LUMA_LEVELS)
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    value[luma] = lumaToValue(luma, scale)
    absent[luma] = isTransparentLuma(luma, scale) ? 1 : 0
  }

  // Verified, not assumed. The fast path tests only the lowest corner
  // for absence, so a table with an absent code *above* a present one
  // would let absent texels into the contours — the rule-1 mistake, back
  // by a side door. 256 iterations to rule it out is free.
  let absentBelow = 0
  while (absentBelow < LUMA_LEVELS && absent[absentBelow] === 1) absentBelow++
  let monotone = true
  for (let luma = absentBelow; luma < LUMA_LEVELS; luma++) {
    if (absent[luma] === 1) { monotone = false; break }
  }
  // `lumaToValue` is affine and increasing for vmax > vmin, but an
  // inverted scale is expressible and would flip which corner is the
  // cell minimum. Read the direction off the table rather than trusting
  // the arithmetic upstream.
  if (monotone) {
    for (let luma = 1; luma < LUMA_LEVELS; luma++) {
      if (value[luma] < value[luma - 1]) { monotone = false; break }
    }
  }

  return { value, absent, absentBelow, monotone }
}

/**
 * A crossing point on one cell edge, identified by the edge rather than
 * by its coordinates.
 *
 * Two neighbouring cells share an edge and must produce the *same* node
 * there, or the polylines come out as thousands of disconnected
 * two-point stubs. Keying on the edge makes that exact. Keying on the
 * interpolated float coordinates would make it approximate, and the
 * epsilon would have to change with the frame's resolution.
 *
 * An integer rather than the `h${x},${y}` string this started as. Both
 * identify the same edge, but the string is built, hashed and collected
 * once per crossing, and there are hundreds of thousands of those on a
 * shipped frame — enough that it was most of the extraction's cost.
 * `(y * width + x) * 2 + orientation` is unique for every edge of a
 * frame and stays well inside the safe-integer range: even a
 * 16384 × 8192 frame tops out around 2.7e8.
 */
type EdgeKey = number

/** Horizontal edge between texel centres `(x, y)` and `(x + 1, y)`. */
function hKey(x: number, y: number, width: number): EdgeKey {
  return (y * width + x) * 2
}

/** Vertical edge between texel centres `(x, y)` and `(x, y + 1)`. */
function vKey(x: number, y: number, width: number): EdgeKey {
  return (y * width + x) * 2 + 1
}

interface Node {
  /** Fractional texel coordinates of the crossing, in centre space. */
  x: number
  y: number
  /** The at-most-two nodes this one connects to. A crossing sits on one
   *  edge, and an edge is shared by at most two cells, so a node cannot
   *  acquire a third neighbour on a well-formed field. */
  links: EdgeKey[]
}

/**
 * Ensure both endpoints of a segment exist and join them.
 *
 * One call rather than the create-then-link pair this replaced, because
 * the pair looked up each key twice — `has` then `set` to create, `get`
 * again to link — and the lookups are the hot path. The coordinates are
 * only used if the node is new; an edge already crossed by a
 * neighbouring cell keeps the position it was given first, which is the
 * same position, since both cells interpolate the same two corners.
 */
function connect(
  nodes: Map<EdgeKey, Node>,
  ka: EdgeKey, ax: number, ay: number,
  kb: EdgeKey, bx: number, by: number,
): void {
  if (ka === kb) return
  let na = nodes.get(ka)
  if (na === undefined) { na = { x: ax, y: ay, links: [] }; nodes.set(ka, na) }
  let nb = nodes.get(kb)
  if (nb === undefined) { nb = { x: bx, y: by, links: [] }; nodes.set(kb, nb) }
  if (!na.links.includes(kb)) na.links.push(kb)
  if (!nb.links.includes(ka)) nb.links.push(ka)
}

/**
 * Where along an edge the level falls, as a fraction from the first
 * corner to the second.
 *
 * `lumaToValue` is linear in luma, so interpolating in physical units
 * and interpolating in luma give the same point — this works in values
 * because that is what the caller reasons about. Equal corner values
 * cannot produce a crossing (the cell case would not have selected this
 * edge), but the guard keeps a degenerate frame from returning NaN.
 */
function crossFraction(va: number, vb: number, level: number): number {
  const span = vb - va
  if (span === 0) return 0.5
  const f = (level - va) / span
  return f < 0 ? 0 : f > 1 ? 1 : f
}

/**
 * Trace every level in one pass and return them as lat/lon polylines.
 *
 * The grid marched over is the lattice of texel *centres*, so a frame of
 * `w × h` texels contributes `(w − 1) × (h − 1)` cells and the outermost
 * half-texel is not contoured. That is the honest extent: there is no
 * data beyond the last centre to interpolate against, and extending to
 * the texel edge would mean inventing it.
 *
 * Levels are sorted and de-duplicated. A level with no crossings comes
 * back with an empty `lines` array rather than being dropped, so a
 * caller can tell "this level is outside the data" from "this level was
 * never asked for" — the difference between a legend entry that should
 * be greyed and one that should be absent.
 */
export function extractContourSet(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  levels: number[],
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ContourLevel[] {
  const { data, width, height } = snapshot
  const wanted = [...new Set(levels.filter(v => Number.isFinite(v)))]
    .sort((a, b) => a - b)
    .slice(0, MAX_CONTOUR_LEVELS)
  if (!wanted.length) return []

  const empty = (): ContourLevel[] => wanted.map(value => ({ value, lines: [] }))
  if (width < 2 || height < 2) return empty()

  const win = window ?? fullWindow(snapshot)
  const x0 = Math.max(0, Math.floor(win.x0))
  const y0 = Math.max(0, Math.floor(win.y0))
  const x1 = Math.min(width, Math.ceil(win.x1))
  const y1 = Math.min(height, Math.ceil(win.y1))
  if (x1 - x0 < 2 || y1 - y0 < 2) return empty()

  const table = buildCodeTable(scale)
  const nodesPerLevel = wanted.map(() => new Map<EdgeKey, Node>())
  const lowest = wanted[0]
  const highest = wanted[wanted.length - 1]

  // Hoisted out of a loop that runs once per cell — around 8.4 million
  // times on a shipped frame, where a property load per corner is not a
  // rounding error.
  const values = table.value
  const absentFlags = table.absent
  const { absentBelow, monotone } = table
  const levelCount = wanted.length

  for (let y = y0; y < y1 - 1; y++) {
    const rowA = y * width
    const rowB = rowA + width
    for (let x = x0; x < x1 - 1; x++) {
      // Corners clockwise from the top-left, in image space (y grows
      // downward), matching the snapshot's own row order.
      const c0 = data[rowA + x]
      const c1 = data[rowA + x + 1]
      const c2 = data[rowB + x + 1]
      const c3 = data[rowB + x]

      let cellMin: number
      let cellMax: number
      if (monotone) {
        // Both of the tests below answer from the *code* range, so a
        // cell crossed by no level — nearly all of them — never touches
        // the value table at all. This is the difference between the
        // extraction taking a moment and it locking the tab up.
        let lo = c0 < c1 ? c0 : c1
        if (c2 < lo) lo = c2
        if (c3 < lo) lo = c3
        // Rule 1, in one compare: absence is a contiguous low band, so
        // the lowest corner settles it for all four.
        if (lo < absentBelow) continue
        let hi = c0 > c1 ? c0 : c1
        if (c2 > hi) hi = c2
        if (c3 > hi) hi = c3
        cellMin = values[lo]
        cellMax = values[hi]
      } else {
        // Rule 1: one absent corner and the cell says nothing at all, at
        // any level.
        if (absentFlags[c0] || absentFlags[c1] || absentFlags[c2] || absentFlags[c3]) continue
        const a = values[c0]
        const b = values[c1]
        const c = values[c2]
        const d = values[c3]
        cellMin = a < b ? a : b
        if (c < cellMin) cellMin = c
        if (d < cellMin) cellMin = d
        cellMax = a > b ? a : b
        if (c > cellMax) cellMax = c
        if (d > cellMax) cellMax = d
      }

      // A level outside the cell's own range cannot cross it, which is
      // the early-out that makes the extra levels nearly free: on a
      // typical frame the overwhelming majority of cells are crossed by
      // no level at all.
      if (highest <= cellMin || lowest > cellMax) continue

      const v0 = values[c0]
      const v1 = values[c1]
      const v2 = values[c2]
      const v3 = values[c3]

      for (let li = 0; li < levelCount; li++) {
        const level = wanted[li]
        // `b = value >= level`, so every corner at or above the level
        // makes code 15 and every corner below makes code 0 — neither
        // emits a segment. These are exactly those two cases.
        if (level <= cellMin || level > cellMax) continue

        const nodes = nodesPerLevel[li]
        const code = (v0 >= level ? 1 : 0)
          | (v1 >= level ? 2 : 0)
          | (v2 >= level ? 4 : 0)
          | (v3 >= level ? 8 : 0)
        if (code === 0 || code === 15) continue

        // The cell's four edge identities and crossing positions, as
        // plain numbers. This used to be five closures, allocated on
        // every emitting cell and dead again before the switch ended;
        // measured on a 4096x2048 frame they and the string keys were
        // roughly nine tenths of the whole extraction. The two unused
        // `crossFraction` calls per cell are a subtract, a divide and a
        // clamp — far cheaper than the allocation they replace.
        const kTop = hKey(x, y, width)
        const kRight = vKey(x + 1, y, width)
        const kBottom = hKey(x, y + 1, width)
        const kLeft = vKey(x, y, width)
        const xTop = x + crossFraction(v0, v1, level)
        const yRight = y + crossFraction(v1, v2, level)
        const xBottom = x + crossFraction(v3, v2, level)
        const yLeft = y + crossFraction(v0, v3, level)
        const xRight = x + 1
        const yBottom = y + 1

        switch (code) {
          case 1: case 14: connect(nodes, kLeft, x, yLeft, kTop, xTop, y); break
          case 2: case 13: connect(nodes, kTop, xTop, y, kRight, xRight, yRight); break
          case 3: case 12: connect(nodes, kLeft, x, yLeft, kRight, xRight, yRight); break
          case 4: case 11: connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom); break
          case 6: case 9: connect(nodes, kTop, xTop, y, kBottom, xBottom, yBottom); break
          case 7: case 8: connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom); break
          // Saddles. Two opposite corners are above and two below, and
          // the cell alone cannot say whether the high ground is joined
          // or the low ground is. Resolved by the cell's own mean, the
          // usual convention: whichever side the centre falls on is the
          // side that stays connected.
          case 5: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom)
              connect(nodes, kTop, xTop, y, kRight, xRight, yRight)
            } else {
              connect(nodes, kLeft, x, yLeft, kTop, xTop, y)
              connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom)
            }
            break
          }
          case 10: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              connect(nodes, kLeft, x, yLeft, kTop, xTop, y)
              connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom)
            } else {
              connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom)
              connect(nodes, kTop, xTop, y, kRight, xRight, yRight)
            }
            break
          }
        }
      }
    }
  }

  return wanted.map((value, li) => ({
    value,
    lines: assemble(nodesPerLevel[li], snapshot, options),
  }))
}

/**
 * The isolines at a single level.
 *
 * The one-level case of `extractContourSet`, kept because a caller with
 * one threshold should not have to wrap it in an array and unwrap the
 * result.
 */
export function extractContours(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  threshold: number,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ContourLine[] {
  return extractContourSet(snapshot, scale, [threshold], options, window)[0]?.lines ?? []
}

/**
 * Walk the crossing graph into polylines.
 *
 * Open runs are traced first, from their loose ends, because starting a
 * closed loop in the middle is harmless but starting an open line in the
 * middle would split it into two. Whatever is left after that is a
 * closed loop and gets its first point repeated at the end.
 */
function assemble(
  nodes: Map<EdgeKey, Node>,
  snapshot: LumaSnapshot,
  options?: DatasetOverlayOptions,
): ContourLine[] {
  if (!nodes.size) return []
  const visited = new Set<EdgeKey>()
  const runs: EdgeKey[][] = []

  const trace = (start: EdgeKey, closed: boolean): void => {
    const run: EdgeKey[] = []
    let current: EdgeKey | undefined = start
    let previous: EdgeKey | undefined
    while (current && !visited.has(current)) {
      visited.add(current)
      run.push(current)
      const node = nodes.get(current)
      if (!node) break
      const next: EdgeKey | undefined = node.links.find(
        k => k !== previous && !visited.has(k))
      previous = current
      current = next
    }
    if (run.length < 2) return
    if (closed) run.push(run[0])
    runs.push(run)
  }

  for (const [key, node] of nodes) {
    if (node.links.length === 1 && !visited.has(key)) trace(key, false)
  }
  for (const [key] of nodes) {
    if (!visited.has(key)) trace(key, true)
  }

  const lines: ContourLine[] = []
  for (const run of runs) {
    const points = run.map((key): ContourPoint => {
      const node = nodes.get(key) as Node
      return texelUvToLatLon(
        {
          u: (node.x + 0.5) / snapshot.width,
          v: (node.y + 0.5) / snapshot.height,
        },
        options,
      )
    })
    lines.push(...splitAtSeam(points))
  }
  return lines
}

/**
 * Cut a polyline wherever consecutive longitudes jump the antimeridian.
 *
 * Exported because the same cut applies to any lat/lon path handed to
 * MapLibre, and because it is the piece most worth testing directly: a
 * line that wraps looks fine in the data and draws as a band across the
 * whole globe.
 */
export function splitAtSeam(points: ContourPoint[]): ContourLine[] {
  if (points.length < 2) return points.length ? [points] : []
  const out: ContourLine[] = []
  let run: ContourPoint[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const jumped = Math.abs(points[i].lon - points[i - 1].lon) > SEAM_JUMP_DEGREES
    if (jumped) {
      if (run.length >= 2) out.push(run)
      run = [points[i]]
    } else {
      run.push(points[i])
    }
  }
  if (run.length >= 2) out.push(run)
  return out
}

/**
 * One level's lines as a GeoJSON MultiLineString feature.
 *
 * Kept here rather than in the renderer so the shape handed to MapLibre
 * is covered by this module's tests, the same way `boundsRing` is shared
 * with `showRegionOutline`.
 */
export function contoursToGeoJson(lines: ContourLine[]): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiLineString',
      coordinates: lines.map(line => line.map((p): [number, number] => [p.lon, p.lat])),
    },
  }
}

/**
 * A whole contour set as one GeoJSON FeatureCollection, one feature per
 * level.
 *
 * `value` and `color` ride along as properties so the map can paint each
 * isoline from its own level with a data-driven expression, rather than
 * the renderer needing one source and one layer per level.
 *
 * Levels that traced nothing are omitted: an empty MultiLineString is a
 * feature MapLibre has to carry and can never draw.
 */
export function contourSetToGeoJson(levels: ContourLevel[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: levels
      .filter(level => level.lines.length > 0)
      .map(level => ({
        type: 'Feature',
        properties: { value: level.value, color: level.color ?? '#ffd166' },
        geometry: {
          type: 'MultiLineString',
          coordinates: level.lines.map(
            line => line.map((p): [number, number] => [p.lon, p.lat])),
        },
      })),
  }
}
