// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The geometry build for a `projector-warp` output
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16 — a sphere-sim warp bundle on
 * one output"): sphere-sim's warp meshes in, triangles an output can
 * draw out.
 *
 * A sphere-sim export carries one Paul Bourke type-2 mesh per lit
 * projector — `2`, then `cols rows`, then one `x y u v i` line per node,
 * row by row. `x` spans ±the projector's aspect and `y` ±1, y up;
 * `(u, v)` is the equirect texel that belongs at the node, v up; `i` is
 * its blend weight. The output's quad is already the degenerate case of
 * that file — a 2×2 mesh with the identity mapping — so a warp replaces
 * the geometry and one line of the fragment's contract, and nearly all
 * of the rung's correctness lives in the build below. It needs no GL, no
 * DOM and no Three, which is why every rule is a unit test.
 *
 * **The parse is fail-closed.** A mesh in the wrong place, the wrong
 * orientation or the wrong units still draws a plausible picture, so
 * anything this module cannot read with certainty is refused whole,
 * with a code the panel words and a line to point at. It is also the
 * *only* parse: a set is persisted as the files' own text and re-read
 * through this function on restore, so there is one set of refusals.
 *
 * **Directions are interpolated, not texels.** `u` is wrapped to [0, 1)
 * at every node, so a cell straddling the ±180° meridian has corners at
 * u ≈ 1 and u ≈ 0 and, interpolated as written, sweeps backwards through
 * the whole texture — 38 of 620 cells on the Boulder rig's P3. Unwrapping
 * `u` per triangle mends that and fails at a pole, whose triangles go all
 * the way round in longitude. Each node therefore becomes a unit
 * direction in the shader's own frame, through `equirectRtt`'s
 * `latLonToDirection` rather than a restatement of it, and the fragment
 * normalizes the interpolated vector and recovers `(u, v)`. Neighbours
 * on the sphere are neighbours in direction whichever side of the seam
 * or pole they sit, so both cases are one rule. Measured against
 * sphere-sim's own tracer the two interpolations are a wash where
 * `(u, v)` works, and around a pole directions stay within 2 px where
 * unwrapped `(u, v)` lands tens of pixels out — up to 66 in the fixture
 * generator's survey. The parity test pins both sides.
 *
 * **The silhouette is reconstructed, not staircased.** A node whose ray
 * reaches nothing has no texel, so no triangle may use it: a `-1` node
 * interpolated towards its neighbours smears texel (0, 0) across the
 * cell. A player that simply drops those triangles ends each projector's
 * picture at its last nodes, in a staircase up to a cell short of where
 * its light really ends — 96×54 px at the 41×41 grid sphere-sim's page
 * exports for Boulder's 3840×2160 projectors. The grid holds enough to do
 * better. Near a smooth silhouette the angle a ray sweeps grows like the
 * square root of its distance from the edge, so the ratio of the last two
 * steps along a grid line says how far past the last node the edge lies:
 * on Boulder a median 1.1 px from sphere-sim's own trace, p90 9 px.
 * Each cell the silhouette crosses is drawn out to those
 * crossings, with the texels continued along the same law, and the
 * weight follows the nodes' own trend and fades to zero at the edge
 * (`edgeBand` says why each). Where a grid line runs along the edge the
 * law has nothing to read, and the crossing goes halfway.
 *
 * **So is the blend's zero line.** A blend that reaches zero inside the
 * picture — a sector crossfade, a polar mask — writes 0 at every node
 * past its fall, and interpolated from those the picture ends at a
 * node, in a staircase a cell wide down the side of each disc. Where a
 * blend does this, as Boulder's does, that line and not the silhouette
 * is the edge an operator sees. A 0 node beside a lit one therefore
 * draws with the value its lit neighbours' trend reaches there, below
 * zero, and the shader's clamp ends the picture where the trend crosses
 * zero (`drawnWeight`). On Boulder that cuts the light drawn where the
 * blend has none from 17k px·w to 0.11k. A fall between the last node
 * and the silhouette is out of reach: no node says it happens, and the
 * band carries the last node's light out towards the edge.
 *
 * **One drop, counted.** A triangle wider than `WIDE_TRIANGLE_FACTOR`
 * times the mesh's own median width is dropped and counted for the HUD,
 * because nothing on a sphere reaches it — the widest measured on Boulder
 * or on either placed rig is 3.6 times the median, reconstructed edge
 * included — so a drop means a cell straddling two UV islands of a mesh
 * surface, whose corners are neighbours on the model and strangers in the
 * texture.
 *
 * **The weight is linear light.** sphere-sim's `i` multiplies radiance
 * and is encoded afterwards (its conventions.ts §B, clause 4). A player
 * that multiplies the encoded pixel instead leaves two half-weight
 * projectors emitting about 22% each: a band at 44% of target along
 * every seam. `blendFactor` is the multiplier that applies it correctly
 * to an encoded colour, per fragment, after `i` is interpolated.
 *
 * **Placement is never inferred from a projector id.** `nominalRig`
 * names a projector after its SOS slot, `placedRig` after its placement
 * order, and the two reuse the same names for different places. So this
 * module takes each mesh's viewport as an input, and the one table it
 * holds — SOS's quadrants — is applied only when the operator chose it,
 * with an id it cannot place refused rather than guessed at.
 */

import {
  directionToLatLon,
  latLonToDirection,
  latLonToSphereUv,
  outputUvToLatLon,
  type Vec3,
} from './equirectRtt'
import { DEFAULT_BLEND_GAMMA } from '../services/multiOutput/protocol'

/** One node as the file states it. */
export interface WarpNode {
  /** Raster position: `x` across ±the file's aspect, `y` up across ±1. */
  readonly x: number
  readonly y: number
  /** The equirect texel that belongs here, v up. `NaN` when not drawable. */
  readonly u: number
  readonly v: number
  /** Blend weight in linear light, [0, 1]. `0` when not drawable. */
  readonly weight: number
  /**
   * False for a node whose ray reached nothing. The format marks that two
   * ways — texture coordinates outside [0, 1], or a negative intensity —
   * and sphere-sim writes both (`-1 -1 -1`), but a reader that honoured
   * only one would draw a node written `0 0 -1` at texel (0, 0), so
   * either marker is enough.
   */
  readonly drawable: boolean
}

export interface WarpMesh {
  readonly cols: number
  readonly rows: number
  /**
   * The raster's aspect ratio, read from the file's own `x` span, which
   * the format defines as ±aspect: ±1.778 is 16:9. A writer that places
   * nodes at pixel centres rather than corners understates it by a cell;
   * sphere-sim spans corner to corner.
   */
  readonly aspect: number
  /** Row-major, in file order. */
  readonly nodes: readonly WarpNode[]
}

/**
 * Why a file was refused. The panel words its own message from `code`,
 * which is why this is a closed set rather than a string.
 */
export type WarpRefusalCode =
  /** Nothing but whitespace. */
  | 'empty'
  /** The first line is not `2`: a polar or unknown mesh type. */
  | 'not-rectangular'
  /** The second line is not two whole numbers in [2, `MAX_WARP_GRID`]. */
  | 'bad-dimensions'
  /** A node line that is not five finite numbers. */
  | 'bad-node'
  /** More or fewer node lines than `cols × rows` — truncated, or not this format. */
  | 'node-count'
  /** A drawable node's weight above 1, which no blend of shares produces. */
  | 'weight-out-of-range'
  /** Positions that do not run monotonically along rows and down columns. */
  | 'not-a-grid'
  /** A raster span other than the format's ±aspect by ±1. */
  | 'bad-extent'
  /**
   * No triangle reaches the surface — no node does, or none meet three to
   * a cell — so the file would draw a black projector.
   */
  | 'nothing-drawable'
  /** Triangles reach the surface, but every corner of every one weighs 0: a black projector again. */
  | 'unlit'

export interface WarpRefusal {
  readonly code: WarpRefusalCode
  /** 1-based line of the file, where one line is to blame. */
  readonly line?: number
  /** For a developer reading a log. */
  readonly detail: string
}

export type WarpParseResult =
  | { readonly ok: true; readonly mesh: WarpMesh }
  | { readonly ok: false; readonly refusal: WarpRefusal }

/**
 * The largest grid read, per axis. sphere-sim's default is 41; a finer
 * export is legitimate, and 1,024 is two orders past it — the bound is
 * against a file that is not a mesh at all claiming a grid that would
 * exhaust memory before the node count could refuse it.
 */
export const MAX_WARP_GRID = 1024

/**
 * How far the `y` extent may fall short of ±1. Wide enough for a writer
 * that places nodes at pixel centres down to ~20 rows, and far too
 * narrow for the failure it exists to catch: a file normalized to
 * [0, 1], whose mesh would otherwise land in a quarter of its viewport.
 */
const Y_EXTENT_TOLERANCE = 0.05
/** An `x` span centred to within rounding, as ±aspect must be. */
const X_CENTRE_TOLERANCE = 1e-3
/** Portrait projectors reach 0.5; nothing real is a sliver or a strip. */
const MIN_ASPECT = 0.2
const MAX_ASPECT = 5
/** Weights are written to six decimals; a sum of shares may round just past 1. */
const WEIGHT_EPSILON = 1e-6

/** A decimal number, exponent allowed. `Number()` alone accepts `''`, `'0x1f'` and `' '`. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const WHOLE = /^\d+$/

function refuse(code: WarpRefusalCode, detail: string, line?: number): WarpParseResult {
  return { ok: false, refusal: line === undefined ? { code, detail } : { code, line, detail } }
}

/**
 * Read one Bourke type-2 mesh, or say exactly why not.
 *
 * Tolerated because they cannot move a node: CRLF line endings, a
 * leading byte-order mark, and blank lines — the format is positional in
 * nodes, and a blank line holds none. Everything else that is not the
 * format is refused, including trailing lines past the last node, since
 * a file with more nodes than its header states was written for a
 * different grid.
 */
export function parseWarpMesh(text: string): WarpParseResult {
  const lines: { n: number; s: string }[] = []
  // `trim` strips a byte-order mark too \u2014 ECMAScript counts U+FEFF as
  // whitespace \u2014 so the first line needs no special case.
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim()
    if (s !== '') lines.push({ n: i + 1, s })
  })
  if (lines.length === 0) return refuse('empty', 'the file holds nothing')

  const type = lines[0]
  if (type.s !== '2') {
    return refuse('not-rectangular', `mesh type "${type.s}"; only a rectangular mesh (type 2) is read`, type.n)
  }

  const dims = lines[1]
  const dimTokens = dims?.s.split(/\s+/) ?? []
  if (dims === undefined || dimTokens.length !== 2 || !dimTokens.every((t) => WHOLE.test(t))) {
    return refuse('bad-dimensions', 'the second line must be "<cols> <rows>"', dims?.n)
  }
  const cols = Number(dimTokens[0])
  const rows = Number(dimTokens[1])
  if (cols < 2 || rows < 2 || cols > MAX_WARP_GRID || rows > MAX_WARP_GRID) {
    return refuse('bad-dimensions', `a ${cols}×${rows} grid; each side must be 2 to ${MAX_WARP_GRID}`, dims.n)
  }

  const nodeLines = lines.slice(2)
  const expected = cols * rows
  if (nodeLines.length !== expected) {
    const last = nodeLines[nodeLines.length - 1]
    const blame = nodeLines.length > expected ? nodeLines[expected].n : (last?.n ?? dims.n)
    return refuse('node-count', `${nodeLines.length} node lines for a ${cols}×${rows} grid of ${expected}`, blame)
  }

  const nodes: WarpNode[] = new Array<WarpNode>(expected)
  let drawableCount = 0
  for (let k = 0; k < expected; k++) {
    const { n, s } = nodeLines[k]
    const tokens = s.split(/\s+/)
    if (tokens.length !== 5 || !tokens.every((t) => NUMBER.test(t))) {
      return refuse('bad-node', `expected "x y u v i", found "${s}"`, n)
    }
    const [x, y, u, v, i] = tokens.map(Number)
    if (![x, y, u, v, i].every(Number.isFinite)) {
      return refuse('bad-node', `a value too large to be a coordinate in "${s}"`, n)
    }
    const drawable = u >= 0 && u <= 1 && v >= 0 && v <= 1 && i >= 0
    if (drawable && i > 1 + WEIGHT_EPSILON) {
      return refuse('weight-out-of-range', `weight ${i} above 1`, n)
    }
    if (drawable) drawableCount++
    nodes[k] = drawable
      ? { x, y, u, v, weight: Math.min(i, 1), drawable }
      : { x, y, u: Number.NaN, v: Number.NaN, weight: 0, drawable }
  }

  // A grid that folds, or a file whose rows and columns were swapped by
  // its writer, still parses as numbers. Positions must run the same way
  // along every row and down every column; which way is the file's own,
  // since the triangles are built from its positions either way.
  const lineOf = (i: number, j: number): number => nodeLines[j * cols + i].n
  const at = (i: number, j: number): WarpNode => nodes[j * cols + i]
  const xStep = Math.sign(at(1, 0).x - at(0, 0).x)
  const yStep = Math.sign(at(0, 1).y - at(0, 0).y)
  if (xStep === 0 || yStep === 0) {
    return refuse('not-a-grid', 'the first row or column does not move', lineOf(1, 1))
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i > 0 && Math.sign(at(i, j).x - at(i - 1, j).x) !== xStep) {
        return refuse('not-a-grid', `x does not run one way along row ${j}`, lineOf(i, j))
      }
      if (j > 0 && Math.sign(at(i, j).y - at(i, j - 1).y) !== yStep) {
        return refuse('not-a-grid', `y does not run one way down column ${i}`, lineOf(i, j))
      }
    }
  }

  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const { x, y } of nodes) {
    xMin = Math.min(xMin, x)
    xMax = Math.max(xMax, x)
    yMin = Math.min(yMin, y)
    yMax = Math.max(yMax, y)
  }
  if (Math.abs(yMax - 1) > Y_EXTENT_TOLERANCE || Math.abs(yMin + 1) > Y_EXTENT_TOLERANCE) {
    return refuse('bad-extent', `y spans [${yMin}, ${yMax}]; the format's vertical range is ±1`)
  }
  const aspect = (xMax - xMin) / 2
  if (Math.abs(xMax + xMin) > X_CENTRE_TOLERANCE * aspect || aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    return refuse('bad-extent', `x spans [${xMin}, ${xMax}]; the format's horizontal range is ±the aspect ratio`)
  }
  if (drawableCount === 0) {
    return refuse('nothing-drawable', 'no node reaches the surface')
  }
  // Reaching the surface is a property of a node, drawing one of a
  // triangle: the build keeps a triangle only when all three corners
  // reach the surface. So a mesh whose drawable nodes never meet three to
  // a cell draws nothing, and one whose triangles all weigh 0 draws black.
  // Either would read on the sphere as a dead lamp rather than a refused
  // file, which is the confusion this parse exists to prevent.
  const light = meshLight(cols, rows, nodes)
  if (light === 'none') {
    return refuse('nothing-drawable', 'no three neighbouring nodes reach the surface, so no triangle is drawn')
  }
  if (light === 'unlit') {
    return refuse('unlit', 'every triangle that reaches the surface weighs 0, so the projector would emit nothing')
  }

  return { ok: true, mesh: { cols, rows, aspect, nodes } }
}

type Tri = [number, number, number]

/**
 * The two triangles a grid cell is drawn as, by node index. One
 * definition for the build and the parse, so that "this mesh draws
 * something" is asked of the triangles the build will actually draw.
 *
 * A full cell splits along b–c, the diagonal the parity fixtures were
 * measured on. A cell missing b or c splits along a–d instead, so the
 * triangle of its three good corners is kept whole. The part of the cell
 * past that triangle is the reconstructed edge's (`edgeBand`), which
 * joins it along the diagonal, so the region between measured nodes is
 * interpolated between them exactly as before the edge existed.
 */
function cellTriangles(
  cols: number,
  i: number,
  j: number,
  drawable: (node: number) => boolean,
): [Tri, Tri] {
  const a = j * cols + i
  const b = a + 1
  const c = a + cols
  const d = c + 1
  if (!drawable(b) || !drawable(c)) {
    return [
      [a, b, d],
      [a, d, c],
    ]
  }
  return [
    [a, b, c],
    [b, d, c],
  ]
}

/**
 * Whether any triangle the build would keep can emit light: `lit` once
 * one has three drawable corners and a positive weight at one of them —
 * the weight is interpolated, so one corner is enough — `unlit` when
 * complete triangles exist but all weigh 0, `none` when none exist.
 *
 * The wide-triangle drop is not consulted. It keeps every triangle no
 * wider than the median, so it never empties a mesh, and a lit triangle
 * it does drop is counted on the HUD rather than lost silently. Nor is
 * the reconstructed edge, which cannot change the answer: it carries only
 * its corners' own weights outwards, and it draws a triangle only where
 * the nodes behind those corners are drawn too, which puts every one of
 * them in a complete grid triangle already counted here.
 */
function meshLight(cols: number, rows: number, nodes: readonly WarpNode[]): 'lit' | 'unlit' | 'none' {
  let found: 'unlit' | 'none' = 'none'
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      for (const tri of cellTriangles(cols, i, j, (k) => nodes[k].drawable)) {
        if (!tri.every((k) => nodes[k].drawable)) continue
        if (tri.some((k) => nodes[k].weight > 0)) return 'lit'
        found = 'unlit'
      }
    }
  }
  return found
}

/** A mesh's share of the framebuffer, as fractions with the origin at bottom-left. */
export interface WarpViewport {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PlacedWarpMesh {
  readonly mesh: WarpMesh
  readonly viewport: WarpViewport
}

export interface WarpMeshStats {
  /** Triangles drawn, the reconstructed edge's included. */
  readonly triangles: number
  /** Of those, the ones past the last nodes, out to the silhouette. */
  readonly edgeTriangles: number
  /**
   * Grid edges the silhouette crosses — from a node that reaches the
   * surface to a neighbour that does not — and how each was extended: by
   * the square-root law, halfway where the law had nothing to read, or
   * not at all where no node behind the edge was drawn either.
   */
  readonly silhouette: { readonly edges: number; readonly byLaw: number; readonly halfway: number }
  /** Dropped for exceeding `WIDE_TRIANGLE_FACTOR` × the median width — never on a sphere. */
  readonly droppedWide: number
  /** The median width of the grid's own triangles, which that bound is relative to, in radians. */
  readonly medianWidthRad: number
}

/**
 * Everything a draw needs, flat and non-indexed: three vertices per
 * triangle, each carrying a clip-space position, a unit direction in
 * the shader's frame, and a blend weight. Non-indexed because a vertex
 * is shared only by triangles that agree on it — a dropped neighbour
 * changes nothing — and indexing would buy a few kilobytes on a mesh
 * this size.
 */
export interface WarpGeometry {
  /** Clip space, three components per vertex, `z = 0`. */
  readonly positions: Float32Array
  /** Unit direction per vertex, three components. */
  readonly directions: Float32Array
  /** Blend weight per vertex, linear light. */
  readonly weights: Float32Array
  readonly vertexCount: number
  /** One entry per placed mesh, in input order. */
  readonly meshes: readonly WarpMeshStats[]
}

/**
 * How many times the median width a triangle may span before it is
 * treated as straddling UV islands. The widest measured on a sphere is
 * 3.6 times the median, so 8 leaves margin that no sphere reaches.
 */
export const WIDE_TRIANGLE_FACTOR = 8

/** A node's texel as a unit direction in the shader's frame. */
export function nodeDirection(u: number, v: number): Vec3 {
  const { lat, lon } = outputUvToLatLon(u, v)
  return latLonToDirection(lat, lon)
}

/**
 * The fragment's first step under a warp, as TypeScript: an interpolated
 * direction back to `(u, v)`. Normalizes, so it takes the interpolant as
 * the rasterizer hands it over.
 */
export function directionToWarpUv(d: Vec3): { u: number; v: number } {
  const { lat, lon } = directionToLatLon(d)
  return latLonToSphereUv(lat, lon)
}

/**
 * A node's raster position → clip space in its viewport: `x` divided by
 * the file's own aspect, then both axes scaled into the rect. No axis
 * flips — the format's `y` is up and so is GL's, which is the one
 * convention that lines up for free.
 */
export function meshToClip(x: number, y: number, aspect: number, viewport: WarpViewport): { x: number; y: number } {
  return {
    x: (viewport.x + ((x / aspect + 1) / 2) * viewport.w) * 2 - 1,
    y: (viewport.y + ((y + 1) / 2) * viewport.h) * 2 - 1,
  }
}

/** The angle between two directions — `atan2`, which keeps its precision at the tiny angles a cell spans. */
function angleBetween(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y
  const cy = a.z * b.x - a.x * b.z
  const cz = a.x * b.y - a.y * b.x
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z)
}

/** Rounding slack for a viewport edge: SOS's quadrants meet at exactly 0.5. */
const VIEWPORT_EPSILON = 1e-9

function viewportInside({ x, y, w, h }: WarpViewport): boolean {
  return (
    [x, y, w, h].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1 + VIEWPORT_EPSILON &&
    y + h <= 1 + VIEWPORT_EPSILON
  )
}

/** Two rects sharing area, not merely an edge. */
function viewportsOverlap(a: WarpViewport, b: WarpViewport): boolean {
  return (
    a.x < b.x + b.w - VIEWPORT_EPSILON &&
    b.x < a.x + a.w - VIEWPORT_EPSILON &&
    a.y < b.y + b.h - VIEWPORT_EPSILON &&
    b.y < a.y + a.h - VIEWPORT_EPSILON
  )
}

function assertViewport(viewport: WarpViewport, index: number): void {
  if (!viewportInside(viewport)) {
    throw new RangeError(`mesh ${index}: viewport ${JSON.stringify(viewport)} is not inside the framebuffer`)
  }
}

/** A vertex as the build assembles it: a raster position in the mesh's own units, a direction, a weight. */
interface WarpVertex {
  readonly x: number
  readonly y: number
  readonly dir: Vec3
  readonly weight: number
}

type VertexTri = readonly [WarpVertex, WarpVertex, WarpVertex]

/**
 * Where the reconstructed edge is cut into strips, as fractions of the
 * way from the last node to the silhouette. The texel under a point of
 * that band follows the square-root law, which is nothing like the
 * straight line a rasterizer interpolates, so the strips' corners are put
 * on the law: drawn as one strip, the band's texels land a p90 3.2° from
 * sphere-sim's trace across Boulder's edge cells, and cut here 1.0°, what
 * the grid itself manages in those cells. The last strip is also where
 * the weight fades out.
 */
const EDGE_BAND_LEVELS = [0.5, 0.75] as const

/**
 * The ratio of the last step to the one before it along a grid line that
 * ends `q` short of a smooth silhouette, the two steps `h1` and `h2` long
 * in raster units. Near such an edge the angle a ray sweeps grows like
 * the square root of its distance from it — a ray grazing a sphere — so
 * the steps lengthen towards it, by a factor that says how far off it is:
 * √h1 / (√(h1 + h2) − √h1), 2.414 on an even grid, with the edge on the
 * last node, falling towards h1 / h2 as it recedes. Strictly decreasing
 * in `q`, which the bisection relies on.
 */
function silhouetteStepRatio(q: number, h1: number, h2: number): number {
  return (Math.sqrt(q + h1) - Math.sqrt(q)) / (Math.sqrt(q + h1 + h2) - Math.sqrt(q + h1))
}

/**
 * The reconstructed edge along one grid line: from node `a`, which
 * reaches the surface, towards its neighbour `b`, which does not, with
 * `a1` and `a2` the nodes behind `a` on the same line (`a2` absent at the
 * grid's border). The band's vertices past `a`, nearest first and the
 * last on the silhouette — or `null` where the grid gives nothing to
 * extend by: no drawn node behind `a`, or steps that put the edge on `a`
 * itself.
 *
 * **Where.** When the last two steps lengthen as the square-root law
 * allows for an edge inside this cell, the law places the crossing: on
 * Boulder, 464 of its 496 crossings, a median 1.1 px from sphere-sim's
 * trace (p90 9 px, worst 15). When they do not, the edge is not a
 * silhouette met head-on — a grid line running along it, whose steps are
 * all alike, or a mesh surface's open rim — and the grid holds nothing
 * about where in the cell it falls, so the crossing goes halfway and the
 * steps carry on unchanged. On Boulder's other 32 the edge lies a median
 * 0.7 of a cell out.
 *
 * **What texel.** Carried on past `a` along the great circle from `a1`
 * through `a`, by the angle the law gives at each vertex, so the band
 * reads the texels sphere-sim's rays would.
 *
 * **What weight.** The nodes' own trend, continued to the crossing and
 * clamped to [0, the last node's]: where another projector is taking
 * over, the weights fall steeply into the edge and reach zero before it;
 * where this one lights the edge alone they hold. Fading to zero across
 * the whole band instead halved the light at a lone projector's rim. The
 * last strip then fades to zero at the crossing whatever the trend says.
 * The light there arrives edge-on — a raster's last quarter-band spans the
 * outer half of the band's arc on the sphere — so fading it costs a lone
 * rim little, while a weight held there put light where a blend has none:
 * inside sphere-sim's polar mask, whose zero can fall past the last node
 * where no trend can see it, and past the sphere wherever the crossing
 * overshoots.
 *
 * The weights are the ones the nodes draw with (`drawnWeight`), not the
 * file's. A node past the blend's own zero line draws below zero, and
 * its band holds that value all the way out, the last vertex included:
 * the band is dark whichever it carries, but a strip between it and a
 * lit node's band then crosses zero where the grid's own cells do.
 * Holding 0 instead lit such a strip to its outer edge, 11 px past
 * sphere-sim's trace at a corner of Boulder's disc on a 1680×1050
 * display.
 */
function edgeBand(
  nodes: readonly WarpNode[],
  dirs: readonly (Vec3 | null)[],
  weights: readonly number[],
  a: number,
  b: number,
  a1: number,
  a2: number | null,
): { readonly vertices: readonly WarpVertex[]; readonly byLaw: boolean } | null {
  const d0 = dirs[a]
  const d1 = dirs[a1]
  if (d0 === null || d1 === null) return null
  const last = angleBetween(d1, d0)
  // The great circle's normal; a step of zero has no direction to carry on in.
  const n = { x: d1.y * d0.z - d1.z * d0.y, y: d1.z * d0.x - d1.x * d0.z, z: d1.x * d0.y - d1.y * d0.x }
  const nLength = Math.hypot(n.x, n.y, n.z)
  if (!(last > 0) || !(nLength > 0)) return null
  // Unit and perpendicular to d0, pointing on from a1 through a.
  const t = {
    x: (n.y * d0.z - n.z * d0.y) / nLength,
    y: (n.z * d0.x - n.x * d0.z) / nLength,
    z: (n.x * d0.y - n.y * d0.x) / nLength,
  }

  const distance = (p: number, q: number): number => Math.hypot(nodes[p].x - nodes[q].x, nodes[p].y - nodes[q].y)
  const h1 = distance(a, a1)
  const hB = distance(a, b)
  const d2 = a2 === null ? null : dirs[a2]
  const before = d2 === null ? 0 : angleBetween(d2, d1)

  // The crossing, `q` past `a` in raster units, and the angle past `a` at a
  // fraction `f` of the way out to it.
  let law: { q: number; angleAt: (f: number) => number } | null = null
  if (d2 !== null && a2 !== null && before > 0) {
    const h2 = distance(a1, a2)
    const ratio = last / before
    if (ratio >= silhouetteStepRatio(0, h1, h2)) return null
    if (ratio > silhouetteStepRatio(hB, h1, h2)) {
      let lo = 0
      let hi = hB
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2
        if (silhouetteStepRatio(mid, h1, h2) > ratio) lo = mid
        else hi = mid
      }
      const q = (lo + hi) / 2
      const k = last / (Math.sqrt(q + h1) - Math.sqrt(q))
      law = { q, angleAt: (f) => k * (Math.sqrt(q) - Math.sqrt(q * (1 - f))) }
    }
  }
  const halfway = hB / 2
  const { q, angleAt } = law ?? { q: halfway, angleAt: (f: number) => (last * halfway * f) / h1 }

  const wA = weights[a]
  const trend = Math.min(wA, Math.max(0, wA - (weights[a1] - wA) * (angleAt(1) / last)))
  const vertices = [...EDGE_BAND_LEVELS, 1].map((f): WarpVertex => {
    const s = (q * f) / hB
    const phi = angleAt(f)
    const c = Math.cos(phi)
    const sn = Math.sin(phi)
    return {
      x: nodes[a].x + (nodes[b].x - nodes[a].x) * s,
      y: nodes[a].y + (nodes[b].y - nodes[a].y) * s,
      dir: { x: d0.x * c + t.x * sn, y: d0.y * c + t.y * sn, z: d0.z * c + t.z * sn },
      weight: f === 1 ? Math.min(0, wA) : wA + (trend - wA) * f,
    }
  })
  return { vertices, byLaw: law !== null }
}

/**
 * Triangulate the part of a cell between two bands leaving its drawn
 * corners, strip by strip: the quad between level k and k + 1 on either
 * side, cut along its shorter diagonal so no strip becomes a sliver. A
 * band that was not extended lends its corner to every strip, which fans
 * the other band out from it; two bands leaving one corner meet in a
 * triangle.
 */
function ladder(left: readonly WarpVertex[], right: readonly WarpVertex[], out: VertexTri[]): void {
  const levels = Math.max(left.length, right.length)
  const at = (band: readonly WarpVertex[], k: number): WarpVertex => band[Math.min(k, band.length - 1)]
  for (let k = 0; k + 1 < levels; k++) {
    const l0 = at(left, k)
    const l1 = at(left, k + 1)
    const r0 = at(right, k)
    const r1 = at(right, k + 1)
    const split: VertexTri[] =
      Math.hypot(l0.x - r1.x, l0.y - r1.y) <= Math.hypot(l1.x - r0.x, l1.y - r0.y)
        ? [
            [l0, l1, r1],
            [l0, r1, r0],
          ]
        : [
            [l0, l1, r0],
            [l1, r1, r0],
          ]
    for (const tri of split) {
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) out.push(tri)
    }
  }
}

/** The widest angle between two of a triangle's directions. */
function triangleWidth([p, q, r]: VertexTri): number {
  return Math.max(angleBetween(p.dir, q.dir), angleBetween(q.dir, r.dir), angleBetween(p.dir, r.dir))
}

/**
 * The weight node (i, j) draws with: its own, unless the blend has faded
 * it to 0 beside a node it has not.
 *
 * A blend reaches zero inside a projector's picture wherever something
 * else takes over — a sector crossfade handing the side of a disc to a
 * neighbour, a polar mask switching a cap off — and its fall is often
 * steeper than a cell. Interpolated from a node written 0, the picture
 * ends at that node, so its edge follows the grid's columns and rows: on
 * Boulder at a 1680×1050 display, one column held for 150 px of height,
 * then a jump of about 20. So a 0 node takes the value its lit
 * neighbours' trend reaches there instead. Along each grid line whose
 * next two nodes rise, the line through them is continued to this node,
 * and the lowest of those values is taken when it is below zero. Below
 * zero is past the blend's own zero line, which `warpBlend` and
 * `blendFactor` both clamp, so the picture ends where the trend crosses
 * zero rather than at the node.
 *
 * The lowest because it puts every crossing nearest the light. Judged
 * per pixel against sphere-sim's trace on the cells the line crosses,
 * over the seven rigs the edge was chosen on, it beat the mean and the
 * highest on Boulder as designed and as built, most of all on light
 * drawn where the blend has none: on Boulder 0.11k px·w, against 0.19k
 * and 0.44k, and 17k with no reconstruction at all. Of the other five,
 * four write no 0 beside a lit node and draw as before. The lone placed
 * projector writes a few, near its polar mask, where all three halve its
 * stray light and the mean and the highest keep slightly more of the
 * light the blend does have. Continuing the cell's split diagonal as
 * well changed little — less light past the blend, more cut inside it —
 * and would tie the rule to how a cell is split.
 *
 * The band past the silhouette reads these weights too (`edgeBand`), so
 * the zero line carries on into it rather than stopping at the last
 * complete cell.
 */
function drawnWeight(nodes: readonly WarpNode[], cols: number, rows: number, i: number, j: number): number {
  const here = nodes[j * cols + i]
  if (here.weight !== 0) return here.weight
  const at = (ii: number, jj: number): WarpNode | null =>
    ii >= 0 && jj >= 0 && ii < cols && jj < rows && nodes[jj * cols + ii].drawable ? nodes[jj * cols + ii] : null
  let weight = 0
  for (const [di, dj] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const p = at(i + di, j + dj)
    const p2 = at(i + 2 * di, j + 2 * dj)
    // A line that does not rise towards the light continues above zero here.
    if (p === null || p2 === null || !(p.weight > 0)) continue
    const h1 = Math.hypot(p.x - here.x, p.y - here.y)
    const h2 = Math.hypot(p2.x - p.x, p2.y - p.y)
    weight = Math.min(weight, p.weight - (p2.weight - p.weight) * (h1 / h2))
  }
  return weight
}

/**
 * Build one output's geometry from its placed meshes: two triangles per
 * full cell, split along the same diagonal the plan's measurements used;
 * each cell the silhouette crosses drawn out to it (`edgeBand`); and
 * every triangle wound counter-clockwise in clip space whichever way the
 * file runs, so a mirrored or bottom-first mesh draws under the default
 * face culling rather than vanishing.
 *
 * Throws on a viewport outside the framebuffer: viewports come from a
 * layout that has already been validated, so reaching here with one is a
 * bug upstream rather than something an operator did.
 */
export function buildWarpGeometry(placed: readonly PlacedWarpMesh[]): WarpGeometry {
  const perMesh = placed.map(({ mesh, viewport }, index) => {
    assertViewport(viewport, index)
    const { cols, rows, nodes } = mesh
    const dirs = nodes.map((n) => (n.drawable ? nodeDirection(n.u, n.v) : null))
    const drawn = (k: number): boolean => dirs[k] !== null
    const weights = nodes.map((n, k) => (n.drawable ? drawnWeight(nodes, cols, rows, k % cols, Math.floor(k / cols)) : 0))
    const vertexOf = nodes.map((n, k): WarpVertex | null => {
      const dir = dirs[k]
      return dir === null ? null : { x: n.x, y: n.y, dir, weight: weights[k] }
    })

    // The band leaving a node towards each missing neighbour, keyed by node
    // and heading. Built once: two cells share every grid edge, and a band
    // they disagreed on would crack the edge between them.
    const bands = new Map<number, readonly WarpVertex[]>()
    let byLaw = 0
    let halfway = 0
    const inside = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < cols && j < rows
    const band = (i: number, j: number, di: number, dj: number): readonly WarpVertex[] => {
      const a = j * cols + i
      const key = a * 4 + (di > 0 ? 0 : di < 0 ? 1 : dj > 0 ? 2 : 3)
      const known = bands.get(key)
      if (known !== undefined) return known
      const a1 = inside(i - di, j - dj) ? (j - dj) * cols + (i - di) : null
      const a2 = inside(i - 2 * di, j - 2 * dj) ? (j - 2 * dj) * cols + (i - 2 * di) : null
      const edge = a1 === null ? null : edgeBand(nodes, dirs, weights, a, (j + dj) * cols + (i + di), a1, a2)
      if (edge?.byLaw === true) byLaw++
      else if (edge !== null) halfway++
      const vertices = [vertexOf[a] as WarpVertex, ...(edge?.vertices ?? [])]
      bands.set(key, vertices)
      return vertices
    }

    const node = (k: number): WarpVertex => vertexOf[k] as WarpVertex
    const grid: VertexTri[] = []
    const edge: VertexTri[] = []
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        for (const [p, q, r] of cellTriangles(cols, i, j, drawn)) {
          if (drawn(p) && drawn(q) && drawn(r)) grid.push([node(p), node(q), node(r)])
        }
        // The corners in order round the cell, and the band out of the
        // drawn part of it towards each corner that reaches nothing.
        const ring = [
          [i, j],
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1],
        ] as const
        const good = ring.map(([ci, cj]) => drawn(cj * cols + ci))
        const count = good.filter(Boolean).length
        if (count === 0 || count === 4) continue
        const next = (k: number): number => (k + 1) % 4
        const prev = (k: number): number => (k + 3) % 4
        const toward = (from: number, to: number): readonly WarpVertex[] =>
          band(ring[from][0], ring[from][1], ring[to][0] - ring[from][0], ring[to][1] - ring[from][1])
        if (count === 3) {
          // Beyond the diagonal of the three good corners' triangle.
          const m = good.indexOf(false)
          ladder(toward(prev(m), m), toward(next(m), m), edge)
        } else if (count === 1 || good[0] === good[2]) {
          // A lone corner, or two opposite ones — each on its own, never
          // bridged across the missing middle.
          for (let p = 0; p < 4; p++) {
            if (good[p]) ladder(toward(p, prev(p)), toward(p, next(p)), edge)
          }
        } else {
          // Two neighbours: out from the side they share.
          const s = [0, 1, 2, 3].find((k) => good[k] && good[next(k)]) as number
          ladder(toward(s, prev(s)), toward(next(s), next(next(s))), edge)
        }
      }
    }

    const widths = grid.map(triangleWidth).sort((p, q) => p - q)
    const medianWidthRad = widths.length === 0 ? 0 : widths[widths.length >> 1]
    // A zero median means most triangles name one texel — a degenerate file
    // with no scale to judge width against, so nothing is dropped for it.
    // The bound is the grid's own: the band's strips are no wider than the
    // grid's widest on any rig measured, so one rule serves both.
    const bound = medianWidthRad > 0 ? WIDE_TRIANGLE_FACTOR * medianWidthRad : Infinity
    const keptGrid = grid.filter((tri) => triangleWidth(tri) <= bound)
    const keptEdge = edge.filter((tri) => triangleWidth(tri) <= bound)
    return {
      mesh,
      viewport,
      kept: [...keptGrid, ...keptEdge],
      stats: {
        triangles: keptGrid.length + keptEdge.length,
        edgeTriangles: keptEdge.length,
        silhouette: { edges: bands.size, byLaw, halfway },
        droppedWide: grid.length - keptGrid.length + edge.length - keptEdge.length,
        medianWidthRad,
      },
    }
  })

  const vertexCount = perMesh.reduce((sum, m) => sum + m.kept.length * 3, 0)
  const positions = new Float32Array(vertexCount * 3)
  const directions = new Float32Array(vertexCount * 3)
  const weights = new Float32Array(vertexCount)
  let vertex = 0
  for (const { mesh, viewport, kept } of perMesh) {
    for (const tri of kept) {
      const clip = tri.map((v) => meshToClip(v.x, v.y, mesh.aspect, viewport))
      const area =
        (clip[1].x - clip[0].x) * (clip[2].y - clip[0].y) - (clip[2].x - clip[0].x) * (clip[1].y - clip[0].y)
      const order = area < 0 ? [0, 2, 1] : [0, 1, 2]
      for (const o of order) {
        const { dir, weight } = tri[o]
        positions.set([clip[o].x, clip[o].y, 0], vertex * 3)
        directions.set([dir.x, dir.y, dir.z], vertex * 3)
        weights[vertex] = weight
        vertex++
      }
    }
  }

  return { positions, directions, weights, vertexCount, meshes: perMesh.map((m) => m.stats) }
}

export interface WarpSample {
  readonly u: number
  readonly v: number
  readonly weight: number
}

/**
 * What the GPU draws at one clip-space point, as TypeScript: the
 * triangle that covers it, the direction and weight interpolated
 * linearly in screen space — which is what the rasterizer does with
 * `w = 1` — and the direction turned back into `(u, v)`. `null` where no
 * triangle covers the point: black in that projector's raster. The
 * weight is below zero past the blend's zero line (`drawnWeight`), as
 * the shader's is before it clamps; `blendFactor` clamps it the same way.
 *
 * The parity fixture's instrument, and a reference for anything that
 * later needs to ask which texel a projector pixel shows. A linear scan,
 * which is fine for a mesh of a few thousand triangles and a handful of
 * questions; not for a per-pixel loop.
 */
export function sampleWarpGeometry(geometry: WarpGeometry, clipX: number, clipY: number): WarpSample | null {
  const { positions: p, directions: d, weights: w } = geometry
  // Barycentric slack, scale-free: positions are float32, so a point on the
  // drawn region's edge can sit a rounding outside it, and 1e-5 of a
  // triangle's size covers that without admitting anything the GPU would not.
  const eps = 1e-5
  for (let t = 0; t < geometry.vertexCount; t += 3) {
    const x0 = p[t * 3], y0 = p[t * 3 + 1]
    const x1 = p[t * 3 + 3], y1 = p[t * 3 + 4]
    const x2 = p[t * 3 + 6], y2 = p[t * 3 + 7]
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (det === 0) continue
    const l0 = ((y1 - y2) * (clipX - x2) + (x2 - x1) * (clipY - y2)) / det
    const l1 = ((y2 - y0) * (clipX - x2) + (x0 - x2) * (clipY - y2)) / det
    const l2 = 1 - l0 - l1
    if (l0 < -eps || l1 < -eps || l2 < -eps) continue
    const at = (c: number): number => l0 * d[t * 3 + c] + l1 * d[t * 3 + 3 + c] + l2 * d[t * 3 + 6 + c]
    const { u, v } = directionToWarpUv({ x: at(0), y: at(1), z: at(2) })
    return { u, v, weight: l0 * w[t] + l1 * w[t + 1] + l2 * w[t + 2] }
  }
  return null
}


/**
 * What an encoded colour is multiplied by to apply a linear-light weight:
 * `encode(decode(c) · w)` under a power law is `c · w^(1/γ)`, so the
 * decode and encode collapse into one exponent on the weight. Applied per
 * fragment after `w` is interpolated — the weight is linear, so it is
 * interpolated where it is linear and converted once.
 *
 * A γ that is not a positive number falls back to the default rather
 * than producing `NaN` or black: a corrupt field should cost the operator
 * their calibration of the blend, not the projector.
 */
export function blendFactor(weight: number, gamma: number): number {
  if (!(weight > 0)) return 0
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : DEFAULT_BLEND_GAMMA
  return Math.pow(Math.min(weight, 1), 1 / g)
}

/** The buffers `buildWarpGeometry`'s arrays are bound under, beside Three's own `position`. */
export const WARP_ATTRIBUTES = {
  direction: 'warpDirection',
  weight: 'warpWeight',
} as const

/** The one uniform a warp adds. */
export const WARP_UNIFORMS = {
  blendGamma: 'uBlendGamma',
} as const

/**
 * The warp's vertex stage: each node's clip-space position as built, and
 * its direction and weight handed on to be interpolated — a direction,
 * never a texel, for the reason the module header gives. `position` is
 * declared by Three's own prefix; the two buffers are this module's.
 */
export const WARP_VERTEX_SHADER = `
attribute vec3 ${WARP_ATTRIBUTES.direction};
attribute float ${WARP_ATTRIBUTES.weight};
varying vec3 vWarpDirection;
varying float vWarpWeight;

void main() {
  vWarpDirection = ${WARP_ATTRIBUTES.direction};
  vWarpWeight = ${WARP_ATTRIBUTES.weight};
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`.trim()

/**
 * What a warp adds to the fragment stage, as GLSL, each a transcription
 * of the TypeScript above: `warpFrameUv` is `directionToWarpUv` — the
 * interpolated direction normalized and turned back into the frame
 * coordinate the equirect pass starts from — and `warpBlend` is
 * `blendFactor`, the linear-light weight applied to an encoded colour.
 * `blendFactor`'s fallback for a gamma that is not one is done where the
 * uniform is written, so the GLSL never sees one.
 *
 * Uses the pass's own `PI` and `TWO_PI`, so it has to follow their
 * declaration — `layerStack` places it in the preamble before `main`.
 */
export const WARP_FRAGMENT_GLSL = `
vec2 warpFrameUv(vec3 direction) {
  vec3 d = normalize(direction);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float lon = atan(d.z, d.x);
  return vec2(lon / TWO_PI + 0.5, lat / PI + 0.5);
}

float warpBlend(float weight, float gamma) {
  return pow(clamp(weight, 0.0, 1.0), 1.0 / gamma);
}
`.trim()

/** The ids SOS's quadrant layout places, in sphere-sim's `nominalRig` order. */
export type SosQuadrantId = 'P1' | 'P2' | 'P3' | 'P4'

/**
 * SOS's one framebuffer split 2×2, origin bottom-left — sphere-sim's
 * `SOS_QUADRANT_VIEWPORTS` and SOS's own `projectorInfo(viewport)`. The
 * parity fixture carries sphere-sim's table so a test holds this copy to
 * it.
 */
export const SOS_QUADRANT_VIEWPORTS: Readonly<Record<SosQuadrantId, WarpViewport>> = {
  P1: { x: 0, y: 0, w: 0.5, h: 0.5 },
  P2: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  P3: { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  P4: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
}

export type QuadrantLayoutResult =
  | { readonly ok: true; readonly viewports: readonly WarpViewport[] }
  | {
      readonly ok: false
      /** `unplaceable`: an id outside P1–P4. `duplicate`: two meshes for one quadrant. */
      readonly code: 'empty' | 'unplaceable' | 'duplicate'
      readonly ids: readonly string[]
    }

/**
 * Viewports for a set under SOS's quadrants, aligned with `ids`, or a
 * refusal naming the ids it could not place. For the operator's explicit
 * choice only — an id alone never implies this layout, because a placed
 * rig's `P1`…`P4` are not SOS's quadrants. Ids match exactly: `p3` is not
 * `P3`, since a guess is how a mesh lands in the wrong quadrant.
 */
export function sosQuadrantLayout(ids: readonly string[]): QuadrantLayoutResult {
  if (ids.length === 0) return { ok: false, code: 'empty', ids: [] }
  // Own keys only: `constructor` and `__proto__` are not quadrants.
  const isQuadrant = (id: string): id is SosQuadrantId =>
    Object.prototype.hasOwnProperty.call(SOS_QUADRANT_VIEWPORTS, id)
  const unplaceable = ids.filter((id) => !isQuadrant(id))
  if (unplaceable.length > 0) return { ok: false, code: 'unplaceable', ids: unplaceable }
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (duplicates.length > 0) return { ok: false, code: 'duplicate', ids: [...new Set(duplicates)] }
  return { ok: true, viewports: ids.map((id) => SOS_QUADRANT_VIEWPORTS[id as SosQuadrantId]) }
}

/**
 * The most meshes one output carries. Past any rig one framebuffer can
 * usefully be split for — sixty-four viewports leave each projector a
 * raster smaller than it is — so the bound is against a file that is
 * not a rig at all rather than against a large one.
 */
export const MAX_WARP_MESHES = 64

const MAX_WARP_ID_LENGTH = 64
/** C0 and C1 controls, both path separators, and the replacement character a bad decode leaves. */
const WARP_ID_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f/\\�]/

/**
 * Whether a string can name a projector. sphere-sim writes `P1`…`Pn`, or
 * whatever id a placed projector was given, and it arrives through a file
 * name — so the rule is what survives being one and being shown to an
 * operator: printable, no separators, not blank-edged, not all dots.
 */
export function isWarpId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_WARP_ID_LENGTH &&
    id.trim() === id &&
    !/^\.+$/.test(id) &&
    !WARP_ID_FORBIDDEN.test(id)
  )
}

/** One mesh of a set as it is carried and stored: the file's own text, and where it was placed. */
export interface WarpSetEntry {
  readonly id: string
  readonly viewport: WarpViewport
  readonly text: string
}

/** Why a set was refused. The panel and the output's HUD word their own messages from `code`. */
export type WarpSetRefusal =
  | { readonly code: 'no-meshes' }
  | { readonly code: 'too-many'; readonly count: number }
  | { readonly code: 'bad-id'; readonly id: string }
  /** Compared case-insensitively: `P1` and `p1` are one file on the disks they were extracted to. */
  | { readonly code: 'duplicate-id'; readonly ids: readonly string[] }
  | { readonly code: 'bad-viewport'; readonly id: string }
  /** Two projectors cannot share framebuffer pixels: each pixel reaches one projector. */
  | { readonly code: 'overlap'; readonly ids: readonly [string, string] }
  | { readonly code: 'mesh'; readonly id: string; readonly mesh: WarpRefusal }

export type WarpSetResult =
  | { readonly ok: true; readonly placed: readonly PlacedWarpMesh[] }
  | { readonly ok: false; readonly refusal: WarpSetRefusal }

/**
 * Check a whole set and parse every mesh in it, or refuse it whole.
 *
 * The one check a set passes wherever it is read — the manager on import
 * and again on restore, and the output on receipt — so a set refused in
 * one place is refused in all three, and none of them can hand
 * `buildWarpGeometry` a viewport it would throw on. Whole, never in part:
 * a rig missing one projector draws a picture with a hole where a quarter
 * of the sphere should be, and a hole looks like a lamp failure rather
 * than a refused file.
 *
 * `placed` is aligned with `entries`.
 */
export function placeWarpSet(entries: readonly WarpSetEntry[]): WarpSetResult {
  const refuse = (refusal: WarpSetRefusal): WarpSetResult => ({ ok: false, refusal })
  if (entries.length === 0) return refuse({ code: 'no-meshes' })
  if (entries.length > MAX_WARP_MESHES) return refuse({ code: 'too-many', count: entries.length })
  const bad = entries.find((e) => !isWarpId(e.id))
  if (bad !== undefined) return refuse({ code: 'bad-id', id: bad.id })
  const folded = entries.map((e) => e.id.toLowerCase())
  const duplicates = entries.filter((_, i) => folded.indexOf(folded[i]) !== i).map((e) => e.id)
  if (duplicates.length > 0) return refuse({ code: 'duplicate-id', ids: [...new Set(duplicates)] })
  const outside = entries.find((e) => !viewportInside(e.viewport))
  if (outside !== undefined) return refuse({ code: 'bad-viewport', id: outside.id })
  for (let i = 0; i < entries.length; i++) {
    for (let k = i + 1; k < entries.length; k++) {
      if (viewportsOverlap(entries[i].viewport, entries[k].viewport)) {
        return refuse({ code: 'overlap', ids: [entries[i].id, entries[k].id] })
      }
    }
  }
  const placed: PlacedWarpMesh[] = []
  for (const { id, viewport, text } of entries) {
    const parsed = parseWarpMesh(text)
    if (!parsed.ok) return refuse({ code: 'mesh', id, mesh: parsed.refusal })
    placed.push({ mesh: parsed.mesh, viewport })
  }
  return { ok: true, placed }
}
