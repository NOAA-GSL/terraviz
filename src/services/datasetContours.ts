/**
 * Isolines over a data-encoded frame — the A5 half of
 * `docs/DATA_ANALYSIS_PLAN.md`.
 *
 * `datasetStats` answers "how much is above this line" as a single
 * number. This answers "and *where* is that line", by marching squares
 * over the luma array at one physical threshold and handing back
 * lat/lon polylines a map can draw.
 *
 * Pure, like every other reducer here: a `LumaSnapshot` in, geometry
 * out, no GL context and no MapLibre. See `datasetStats.ts` for why that
 * matters — the arithmetic that is easiest to get subtly wrong is the
 * arithmetic that has to be testable on its own.
 *
 * Three things this module is careful about:
 *
 *  1. **Absent data breaks the cell, it does not bound it.** A texel the
 *     sidecar calls "nothing measured here" is not a low value, and a
 *     cell touching one emits no segment. Skip this and the contour
 *     traces the coastline of the no-data region as though it were a
 *     real gradient — a confident, beautifully smooth, entirely
 *     fictional isoline. This is the same mistake `datasetStats` refuses
 *     to make when it excludes absent texels from the mean rather than
 *     counting them as `vmin`.
 *  2. **Values come from `lumaToValue`, never from an inverse of it.**
 *     The threshold is not converted into a luma code; instead a
 *     256-entry table is built *through* `lumaToValue` and the
 *     comparison happens in physical units. A separate value→luma
 *     inverse would be a second copy of the mapping that has to be kept
 *     in step with the first one forever, in a different file, and the
 *     day it drifts the contour and the readout disagree while both look
 *     right.
 *  3. **The antimeridian splits a line rather than crossing it.** A
 *     polyline whose longitudes jump from +179 to −179 is drawn by
 *     MapLibre as a stripe straight back across the globe. Lines are cut
 *     where they wrap.
 *
 * What this does **not** claim: the polygon enclosed by these lines is
 * not where the area figure comes from. `areaAboveKm2` counts whole
 * texels by their own spherical cell area; the isoline is interpolated
 * between texel centres. They agree to within about one texel around the
 * perimeter, and the area number is the one to quote, because it does
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
 * Where along an edge the threshold falls, as a fraction from the first
 * corner to the second.
 *
 * `lumaToValue` is linear in luma, so interpolating in physical units
 * and interpolating in luma give the same point — this works in values
 * because that is what the caller reasons about. Equal corner values
 * cannot produce a crossing (the cell case would not have selected this
 * edge), but the guard keeps a degenerate frame from returning NaN.
 */
function crossFraction(va: number, vb: number, threshold: number): number {
  const span = vb - va
  if (span === 0) return 0.5
  const f = (threshold - va) / span
  return f < 0 ? 0 : f > 1 ? 1 : f
}

/**
 * Trace the isoline at `threshold` and return it as lat/lon polylines.
 *
 * The grid marched over is the lattice of texel *centres*, so a frame of
 * `w × h` texels contributes `(w − 1) × (h − 1)` cells and the outermost
 * half-texel is not contoured. That is the honest extent: there is no
 * data beyond the last centre to interpolate against, and extending to
 * the texel edge would mean inventing it.
 */
export function extractContours(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  threshold: number,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ContourLine[] {
  const { data, width, height } = snapshot
  if (width < 2 || height < 2) return []
  if (!Number.isFinite(threshold)) return []

  const win = window ?? fullWindow(snapshot)
  const x0 = Math.max(0, Math.floor(win.x0))
  const y0 = Math.max(0, Math.floor(win.y0))
  const x1 = Math.min(width, Math.ceil(win.x1))
  const y1 = Math.min(height, Math.ceil(win.y1))
  if (x1 - x0 < 2 || y1 - y0 < 2) return []

  const table = buildCodeTable(scale)
  const nodes = new Map<EdgeKey, Node>()

  /** Register (or fetch) the crossing on one edge, then return its key. */
  const nodeAt = (key: EdgeKey, x: number, y: number): EdgeKey => {
    if (!nodes.has(key)) nodes.set(key, { x, y, links: [] })
    return key
  }

  for (let y = y0; y < y1 - 1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      // Corners clockwise from the top-left, in image space (y grows
      // downward), matching the snapshot's own row order.
      const c0 = data[y * width + x]
      const c1 = data[y * width + x + 1]
      const c2 = data[(y + 1) * width + x + 1]
      const c3 = data[(y + 1) * width + x]

      // Rule 1: one absent corner and the cell says nothing at all.
      if (table.absent[c0] || table.absent[c1] || table.absent[c2] || table.absent[c3]) continue

      const v0 = table.value[c0]
      const v1 = table.value[c1]
      const v2 = table.value[c2]
      const v3 = table.value[c3]

      const b0 = v0 >= threshold ? 1 : 0
      const b1 = v1 >= threshold ? 1 : 0
      const b2 = v2 >= threshold ? 1 : 0
      const b3 = v3 >= threshold ? 1 : 0
      const code = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3)
      if (code === 0 || code === 15) continue

      // The four edges a segment can land on, as lazily-created nodes.
      const top = (): EdgeKey =>
        nodeAt(hKey(x, y), x + crossFraction(v0, v1, threshold), y)
      const right = (): EdgeKey =>
        nodeAt(vKey(x + 1, y), x + 1, y + crossFraction(v1, v2, threshold))
      const bottom = (): EdgeKey =>
        nodeAt(hKey(x, y + 1), x + crossFraction(v3, v2, threshold), y + 1)
      const left = (): EdgeKey =>
        nodeAt(vKey(x, y), x, y + crossFraction(v0, v3, threshold))

      switch (code) {
        case 1: case 14: linkNodes(nodes, left(), top()); break
        case 2: case 13: linkNodes(nodes, top(), right()); break
        case 3: case 12: linkNodes(nodes, left(), right()); break
        case 4: case 11: linkNodes(nodes, right(), bottom()); break
        case 6: case 9: linkNodes(nodes, top(), bottom()); break
        case 7: case 8: linkNodes(nodes, left(), bottom()); break
        // Saddles. Two opposite corners are above and two below, and the
        // cell alone cannot say whether the high ground is joined or the
        // low ground is. Resolved by the cell's own mean, the usual
        // convention: whichever side the centre falls on is the side
        // that stays connected.
        case 5: {
          const centreAbove = (v0 + v1 + v2 + v3) / 4 >= threshold
          if (centreAbove) {
            linkNodes(nodes, left(), bottom())
            linkNodes(nodes, top(), right())
          } else {
            linkNodes(nodes, left(), top())
            linkNodes(nodes, right(), bottom())
          }
          break
        }
        case 10: {
          const centreAbove = (v0 + v1 + v2 + v3) / 4 >= threshold
          if (centreAbove) {
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

  return assemble(nodes, snapshot, options)
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
 * The contour lines as a GeoJSON MultiLineString feature.
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
