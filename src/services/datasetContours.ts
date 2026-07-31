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
}

function buildCodeTable(scale: ColorScale): CodeTable {
  const value = new Float64Array(LUMA_LEVELS)
  const absent = new Uint8Array(LUMA_LEVELS)
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    value[luma] = lumaToValue(luma, scale)
    absent[luma] = isTransparentLuma(luma, scale) ? 1 : 0
  }
  return { value, absent }
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
 */
type EdgeKey = string

/** Horizontal edge between texel centres `(x, y)` and `(x + 1, y)`. */
function hKey(x: number, y: number): EdgeKey {
  return `h${x},${y}`
}

/** Vertical edge between texel centres `(x, y)` and `(x, y + 1)`. */
function vKey(x: number, y: number): EdgeKey {
  return `v${x},${y}`
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

function linkNodes(nodes: Map<EdgeKey, Node>, a: EdgeKey, b: EdgeKey): void {
  const na = nodes.get(a)
  const nb = nodes.get(b)
  if (!na || !nb || a === b) return
  if (!na.links.includes(b)) na.links.push(b)
  if (!nb.links.includes(a)) nb.links.push(a)
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

  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      // Corners clockwise from the top-left, in image space (y grows
      // downward), matching the snapshot's own row order.
      const c0 = data[y * width + x]
      const c1 = data[y * width + x + 1]
      const c2 = data[(y + 1) * width + x + 1]
      const c3 = data[(y + 1) * width + x]

      // Rule 1: one absent corner and the cell says nothing at all, at
      // any level.
      if (table.absent[c0] || table.absent[c1] || table.absent[c2] || table.absent[c3]) continue

      const v0 = table.value[c0]
      const v1 = table.value[c1]
      const v2 = table.value[c2]
      const v3 = table.value[c3]

      // The cell's own range, computed once. A level outside it cannot
      // cross this cell, which is the early-out that makes the extra
      // levels nearly free: on a typical frame the overwhelming majority
      // of cells are crossed by no level at all.
      const cellMin = Math.min(v0, v1, v2, v3)
      const cellMax = Math.max(v0, v1, v2, v3)
      if (highest <= cellMin || lowest > cellMax) continue

      for (let li = 0; li < wanted.length; li++) {
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

        const nodeAt = (key: EdgeKey, nx: number, ny: number): EdgeKey => {
          if (!nodes.has(key)) nodes.set(key, { x: nx, y: ny, links: [] })
          return key
        }
        const top = (): EdgeKey =>
          nodeAt(hKey(x, y), x + crossFraction(v0, v1, level), y)
        const right = (): EdgeKey =>
          nodeAt(vKey(x + 1, y), x + 1, y + crossFraction(v1, v2, level))
        const bottom = (): EdgeKey =>
          nodeAt(hKey(x, y + 1), x + crossFraction(v3, v2, level), y + 1)
        const left = (): EdgeKey =>
          nodeAt(vKey(x, y), x, y + crossFraction(v0, v3, level))

        switch (code) {
          case 1: case 14: linkNodes(nodes, left(), top()); break
          case 2: case 13: linkNodes(nodes, top(), right()); break
          case 3: case 12: linkNodes(nodes, left(), right()); break
          case 4: case 11: linkNodes(nodes, right(), bottom()); break
          case 6: case 9: linkNodes(nodes, top(), bottom()); break
          case 7: case 8: linkNodes(nodes, left(), bottom()); break
          // Saddles. Two opposite corners are above and two below, and
          // the cell alone cannot say whether the high ground is joined
          // or the low ground is. Resolved by the cell's own mean, the
          // usual convention: whichever side the centre falls on is the
          // side that stays connected.
          case 5: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              linkNodes(nodes, left(), bottom())
              linkNodes(nodes, top(), right())
            } else {
              linkNodes(nodes, left(), top())
              linkNodes(nodes, right(), bottom())
            }
            break
          }
          case 10: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              linkNodes(nodes, left(), top())
              linkNodes(nodes, right(), bottom())
            } else {
              linkNodes(nodes, left(), bottom())
              linkNodes(nodes, top(), right())
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
