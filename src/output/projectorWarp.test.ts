// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_BLEND_GAMMA } from '../services/multiOutput/protocol'
import {
  MAX_WARP_GRID,
  MAX_WARP_MESHES,
  SOS_QUADRANT_VIEWPORTS,
  WIDE_TRIANGLE_FACTOR,
  blendFactor,
  buildWarpGeometry,
  directionToWarpUv,
  isWarpId,
  meshToClip,
  nodeDirection,
  parseWarpMesh,
  placeWarpSet,
  sampleWarpGeometry,
  sosQuadrantLayout,
  type SosQuadrantId,
  type WarpGeometry,
  type WarpMesh,
  type WarpRefusal,
  type WarpSetEntry,
  type WarpSetRefusal,
  type WarpViewport,
} from './projectorWarp'
import { latLonToDirection, type Vec3 } from './equirectRtt'

const FIXTURES = resolve(__dirname, 'fixtures/projectorWarp')
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8')
const FULL: WarpViewport = { x: 0, y: 0, w: 1, h: 1 }

/**
 * A regular mesh laid out as sphere-sim writes one: nodes corner to
 * corner, rows top first, `x` over ±aspect. `node` returns `[u, v, i]`,
 * or `null` for a node that reaches nothing.
 */
function gridText(
  cols: number,
  rows: number,
  node: (i: number, j: number) => [number, number, number] | null,
  aspect = 16 / 9,
): string {
  const lines = ['2', `${cols} ${rows}`]
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((2 * i) / (cols - 1) - 1) * aspect
      const y = 1 - (2 * j) / (rows - 1)
      const n = node(i, j)
      lines.push(n === null ? `${x} ${y} -1 -1 -1` : `${x} ${y} ${n[0]} ${n[1]} ${n[2]}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** A small, smooth patch of texture — the shape every real cell has. */
const smooth = (i: number, j: number): [number, number, number] => [0.45 + 0.02 * i, 0.55 - 0.02 * j, 1]

function parsed(text: string): WarpMesh {
  const result = parseWarpMesh(text)
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} — ${result.refusal.detail}`)
  return result.mesh
}

function refusalOf(text: string): WarpRefusal {
  const result = parseWarpMesh(text)
  if (result.ok) throw new Error('parsed; a refusal was expected')
  return result.refusal
}

function angleRad(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y
  const cy = a.z * b.x - a.x * b.z
  const cz = a.x * b.y - a.y * b.x
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z)
}

/** Signed area of each drawn triangle, in clip space. */
function triangleAreas(g: WarpGeometry): number[] {
  const p = g.positions
  const areas: number[] = []
  for (let t = 0; t < g.vertexCount; t += 3) {
    const [x0, y0, x1, y1, x2, y2] = [p[t * 3], p[t * 3 + 1], p[t * 3 + 3], p[t * 3 + 4], p[t * 3 + 6], p[t * 3 + 7]]
    areas.push((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))
  }
  return areas
}

describe('parseWarpMesh', () => {
  it("reads sphere-sim's own export as written", () => {
    const mesh = parsed(fixture('boulder-P3.data'))
    expect(mesh.cols).toBe(41)
    expect(mesh.rows).toBe(41)
    // x spans ±the aspect, not ±1 — the format's asymmetry, and 16:9 here.
    expect(mesh.aspect).toBeCloseTo(16 / 9, 5)
    expect(mesh.nodes).toHaveLength(41 * 41)
    // The plan's count: 681 of 1,681 nodes land on the sphere.
    expect(mesh.nodes.filter((n) => n.drawable)).toHaveLength(681)
    // Row-major, top row first, as the file runs.
    expect(mesh.nodes[0]).toMatchObject({ x: -1.777778, y: 1, drawable: false })
    expect(mesh.nodes[40]).toMatchObject({ x: 1.777778, y: 1 })
    expect(mesh.nodes[41].y).toBeCloseTo(0.95, 6)
  })

  it("carries P3's seam into the nodes rather than smoothing it away", () => {
    // Two neighbours on the equator row: the texture wraps between them.
    const mesh = parsed(fixture('boulder-P3.data'))
    const k = mesh.nodes.findIndex((n, idx) => n.drawable && n.u === 1 && mesh.nodes[idx + 1].u < 0.02)
    expect(k).toBeGreaterThan(0)
    expect(mesh.nodes[k + 1].drawable).toBe(true)
  })

  it('treats either of the format’s no-data markers as enough on its own', () => {
    // Three columns, so the three drawable nodes on the right still make
    // one triangle and the mesh draws something.
    const mesh = parsed(
      [
        '2',
        '3 2',
        '-1 1 -1 -1 -1',
        '0 1 0 0 -1',
        '1 1 0.6 0.5 1',
        '-1 -1 1.5 0.5 1',
        '0 -1 0.5 0.5 0.5',
        '1 -1 0.6 0.4 1',
      ].join('\n'),
    )
    // Both markers; a valid texel with a negative weight; a texel off the texture.
    expect(mesh.nodes.map((n) => n.drawable)).toEqual([false, false, true, false, true, true])
    // A node that draws nothing carries nothing a caller could draw by mistake.
    expect(mesh.nodes[1]).toMatchObject({ weight: 0 })
    expect(mesh.nodes[1].u).toBeNaN()
    expect(mesh.nodes[4]).toMatchObject({ u: 0.5, v: 0.5, weight: 0.5 })
  })

  it('reads CRLF, a byte-order mark and blank lines the same as clean text', () => {
    const clean = gridText(3, 3, smooth)
    const messy = `\uFEFF${clean.replace(/\n/g, '\r\n').replace('\r\n', '\r\n\r\n')}\r\n  \r\n`
    expect(parseWarpMesh(messy)).toEqual(parseWarpMesh(clean))
  })

  it('reads a mesh written bottom row first, or mirrored', () => {
    // The file's positions decide where each node draws, so a writer's
    // row order or a rear-projection mirror is its own business.
    const lines = gridText(3, 3, smooth).trimEnd().split('\n')
    const bottomFirst = [lines[0], lines[1], ...lines.slice(8, 11), ...lines.slice(5, 8), ...lines.slice(2, 5)]
    expect(parseWarpMesh(bottomFirst.join('\n')).ok).toBe(true)
    const mirrored = lines.map((l, i) => (i < 2 ? l : l.replace(/^(\S+)/, (x) => String(-Number(x)))))
    expect(parseWarpMesh(mirrored.join('\n')).ok).toBe(true)
  })

  it('clamps a weight a rounding past 1 and refuses one plainly above it', () => {
    const almost = gridText(2, 2, () => [0.5, 0.5, 1.0000005])
    expect(parsed(almost).nodes.every((n) => n.weight === 1)).toBe(true)
    const over = refusalOf(gridText(2, 2, (i) => [0.5, 0.5, i === 1 ? 1.01 : 1]))
    expect(over).toMatchObject({ code: 'weight-out-of-range', line: 4 })
  })

  describe('refuses, with a code and the line to blame', () => {
    const good = gridText(3, 2, smooth).trimEnd().split('\n')
    const edited = (edit: (lines: string[]) => string[]): string => edit([...good]).join('\n')

    it('an empty file', () => {
      expect(refusalOf('').code).toBe('empty')
      expect(refusalOf(' \n\n\t\n').code).toBe('empty')
    })

    it('a mesh type other than rectangular', () => {
      expect(refusalOf(edited((l) => ['1', ...l.slice(1)]))).toMatchObject({ code: 'not-rectangular', line: 1 })
      expect(refusalOf(edited((l) => ['2.0', ...l.slice(1)])).code).toBe('not-rectangular')
    })

    it('dimensions that are not two whole numbers in range', () => {
      for (const dims of ['3', '3 x', '3 2 1', '2.5 2', '-3 2', '1 2', '3 0', `${MAX_WARP_GRID + 1} 2`]) {
        const refusal = refusalOf(edited((l) => [l[0], dims, ...l.slice(2)]))
        expect(refusal, dims).toMatchObject({ code: 'bad-dimensions', line: 2 })
      }
      expect(refusalOf('2\n').code).toBe('bad-dimensions')
    })

    it('a node line that is not five finite numbers', () => {
      for (const node of ['0 0 0.5 0.5', '0 0 0.5 0.5 1 1', '0 0 NaN 0.5 1', '0 0 0x1f 0.5 1', '0 0 .5. 0.5 1']) {
        const refusal = refusalOf(edited((l) => [...l.slice(0, 4), node, ...l.slice(5)]))
        expect(refusal, node).toMatchObject({ code: 'bad-node', line: 5 })
      }
      const huge = refusalOf(edited((l) => [...l.slice(0, 4), '0 0 1e999 0.5 1', ...l.slice(5)]))
      expect(huge).toMatchObject({ code: 'bad-node', line: 5 })
    })

    it('more or fewer nodes than the header states', () => {
      expect(refusalOf(edited((l) => l.slice(0, -1)))).toMatchObject({ code: 'node-count', line: 7 })
      expect(refusalOf(edited((l) => [...l, l[2]]))).toMatchObject({ code: 'node-count', line: 9 })
    })

    it('positions that do not form a grid', () => {
      // Two nodes of the top row swapped: x runs backwards once.
      const swapped = refusalOf(edited((l) => [l[0], l[1], l[3], l[2], ...l.slice(4)]))
      expect(swapped.code).toBe('not-a-grid')
      // The header's cols and rows exchanged, as a writer that transposed would.
      const transposed = refusalOf(gridText(3, 2, smooth).replace('3 2', '2 3'))
      expect(transposed.code).toBe('not-a-grid')
    })

    it('a raster span other than ±aspect by ±1', () => {
      // Normalized to [0, 1] instead: this mesh would land in a quarter of its viewport.
      const unit = gridText(3, 3, smooth)
        .trimEnd()
        .split('\n')
        .map((line, k) => {
          if (k < 2) return line
          const [x, y, ...rest] = line.split(' ')
          return [(Number(x) / (16 / 9) + 1) / 2, (Number(y) + 1) / 2, ...rest].join(' ')
        })
        .join('\n')
      expect(refusalOf(unit).code).toBe('bad-extent')
      expect(refusalOf(gridText(3, 3, smooth, 10)).code).toBe('bad-extent')
    })

    it('a mesh in which nothing reaches the surface', () => {
      expect(refusalOf(gridText(3, 3, () => null)).code).toBe('nothing-drawable')
    })

    it('a mesh whose drawable nodes never meet three to a cell', () => {
      // One node alone, and a checkerboard: every cell has at most two
      // corners on the surface, so the build would draw no triangle.
      const lone = gridText(2, 2, (i, j) => (i === 1 && j === 1 ? smooth(i, j) : null))
      const checker = gridText(3, 3, (i, j) => ((i + j) % 2 === 0 ? smooth(i, j) : null))
      for (const text of [lone, checker]) expect(refusalOf(text).code).toBe('nothing-drawable')
    })

    it('a mesh whose triangles all weigh 0', () => {
      expect(refusalOf(gridText(3, 3, (i, j) => [smooth(i, j)[0], smooth(i, j)[1], 0])).code).toBe('unlit')
      // The one positive weight sits on a node no complete triangle
      // reaches, so nothing drawn can carry it.
      const isolated = gridText(3, 3, (i, j) => {
        if ((i === 1 && j === 2) || (i === 2 && j === 1)) return null
        return [smooth(i, j)[0], smooth(i, j)[1], i === 2 && j === 2 ? 1 : 0]
      })
      expect(refusalOf(isolated).code).toBe('unlit')
    })
  })

  it('draws a triangle lit at a single corner — the weight is interpolated', () => {
    const oneCorner = gridText(2, 2, (i, j) => [smooth(i, j)[0], smooth(i, j)[1], i === 0 && j === 0 ? 0.5 : 0])
    const g = buildWarpGeometry([{ mesh: parsed(oneCorner), viewport: FULL }])
    expect(g.meshes[0].triangles).toBe(2)
    expect(Math.max(...g.weights)).toBe(0.5)
  })
})

describe('buildWarpGeometry', () => {
  it('draws two non-indexed triangles per cell, each vertex carrying all three attributes', () => {
    const g = buildWarpGeometry([{ mesh: parsed(gridText(3, 2, smooth)), viewport: FULL }])
    expect(g.meshes).toEqual([
      {
        triangles: 4,
        edgeTriangles: 0,
        silhouette: { edges: 0, byLaw: 0, halfway: 0 },
        droppedWide: 0,
        medianWidthRad: expect.any(Number),
      },
    ])
    expect(g.vertexCount).toBe(12)
    expect(g.positions).toHaveLength(36)
    expect(g.directions).toHaveLength(36)
    expect(g.weights).toHaveLength(12)
    for (let k = 0; k < g.vertexCount; k++) {
      const [x, y, z] = g.directions.subarray(k * 3, k * 3 + 3)
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
      expect(g.positions[k * 3 + 2]).toBe(0)
    }
  })

  it("draws a cell missing a corner as its good corners' triangle, then out towards the missing one", () => {
    // Node (0, 0) reaches nothing. Its cell keeps the triangle of its three
    // good corners, and the band past that triangle's diagonal reaches
    // halfway to the missing corner along both edges: these steps are all
    // alike, so the square-root law has nothing to read.
    const g = buildWarpGeometry([{ mesh: parsed(gridText(3, 3, (i, j) => (i === 0 && j === 0 ? null : smooth(i, j)))), viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({
      triangles: 13,
      edgeTriangles: 6,
      silhouette: { edges: 2, byLaw: 0, halfway: 2 },
      droppedWide: 0,
    })
    // In clip space the cell is x in [-1, 0], y in [0, 1], missing (-1, 1).
    // The good corners' triangle is below its diagonal x - y = -1, and the
    // band runs out to the line through the two halfway points, x - y = -1.5.
    expect(sampleWarpGeometry(g, -0.3, 0.3)).not.toBeNull()
    const band = sampleWarpGeometry(g, -0.55, 0.75)!
    expect(band).not.toBeNull()
    expect(sampleWarpGeometry(g, -0.9, 0.9)).toBeNull()
    // Held at the good corners' weight — the nodes' trend is flat — through
    // three quarters of the band, then faded out over the last strip.
    expect(band.weight).toBeCloseTo(1, 6)
    expect(sampleWarpGeometry(g, -0.748, 0.75)!.weight).toBeLessThan(0.05)
  })

  it('draws the triangle of an edge cell\'s three good corners, whichever corner is missing', () => {
    // A fixed split drew nothing where the missing corner sat on its
    // diagonal, so two sides of every projector's disc were a staircase.
    const corners = { a: [0, 0], b: [1, 0], c: [0, 1], d: [1, 1] } as const
    for (const [name, [mi, mj]] of Object.entries(corners)) {
      const mesh = parsed(gridText(2, 2, (i, j) => (i === mi && j === mj ? null : smooth(i, j))))
      const g = buildWarpGeometry([{ mesh, viewport: FULL }])
      // No node lies behind either good corner on a 2×2 grid, so the edge
      // is not extended: the triangle is all that is drawn.
      expect(g.meshes[0], name).toMatchObject({ triangles: 1, edgeTriangles: 0, silhouette: { edges: 2, byLaw: 0, halfway: 0 } })
      // The drawn triangle is the three good corners: half the cell, on
      // the side away from the missing one.
      const far = { a: [0.5, -0.5], b: [-0.5, -0.5], c: [0.5, 0.5], d: [-0.5, 0.5] }[name]!
      const near = { a: [-0.5, 0.5], b: [0.5, 0.5], c: [-0.5, -0.5], d: [0.5, -0.5] }[name]!
      expect(sampleWarpGeometry(g, far[0], far[1]), name).not.toBeNull()
      expect(sampleWarpGeometry(g, near[0], near[1]), name).toBeNull()
    }
  })

  it('keeps a full cell on the diagonal the parity fixtures were measured on', () => {
    // Weights 1 on a and d, 0 on b and c: the cell's centre lies on both
    // diagonals, and reads 0 split along b–c but 1 along a–d.
    const mesh = parsed(gridText(2, 2, (i, j) => [0.45 + 0.02 * i, 0.55 - 0.02 * j, i === j ? 1 : 0]))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 2, edgeTriangles: 0 })
    expect(sampleWarpGeometry(g, 0, 0)!.weight).toBeCloseTo(0, 6)
  })

  it("turns each node's texel into a direction through equirectRtt's frame", () => {
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.8], [1, 0.3], [0, 0.3]]) {
      const expected = latLonToDirection((v - 0.5) * 180, (u - 0.5) * 360)
      const d = nodeDirection(u, v)
      expect([d.x, d.y, d.z]).toEqual([expected.x, expected.y, expected.z])
      const back = directionToWarpUv(d)
      // u = 0 and u = 1 are one meridian; the recovery picks one of them.
      expect(Math.min(Math.abs(back.u - u), 1 - Math.abs(back.u - u))).toBeLessThan(1e-12)
      expect(back.v).toBeCloseTo(v, 12)
    }
  })

  it('interpolates across the seam instead of sweeping back through the texture', () => {
    // One cell straddling ±180°: u ≈ 0.99 on the left, ≈ 0.01 on the right.
    const mesh = parsed(gridText(2, 2, (i, j) => [i === 0 ? 0.99 : 0.01, 0.49 + 0.02 * j, 1], 1))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 2, droppedWide: 0 })
    // Interpolated as written, the cell's centre would read u = 0.5 — the far side of the world.
    const centre = sampleWarpGeometry(g, 0, 0)!
    expect(Math.min(centre.u, 1 - centre.u)).toBeLessThan(1e-6)
    expect(centre.v).toBeCloseTo(0.5, 6)
  })

  it('interpolates through a pole that no unwrap of u can reach', () => {
    // Four corners at 88°N, a quarter-turn apart: the cell encloses the pole.
    const lon = [[135, 45], [-135, -45]]
    const mesh = parsed(gridText(2, 2, (i, j) => [lon[j][i] / 360 + 0.5, 88 / 180 + 0.5, 1], 1))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 2, droppedWide: 0 })
    // Unwrapped (u, v) puts the centre at 88°N, two degrees off the pole it holds.
    expect(sampleWarpGeometry(g, 0, 0)!.v).toBeCloseTo(1, 6)
  })

  it(`drops and counts a triangle wider than ${WIDE_TRIANGLE_FACTOR}× the median`, () => {
    // One corner node sent to the far side of the texture: a UV-island straddle.
    const mesh = parsed(gridText(4, 4, (i, j) => (i === 3 && j === 3 ? [0.95, 0.55, 1] : smooth(i, j))))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 17, edgeTriangles: 0, droppedWide: 1 })
  })

  it('winds every triangle counter-clockwise, whichever way the file runs', () => {
    const lines = gridText(3, 3, smooth).trimEnd().split('\n')
    const bottomFirst = [lines[0], lines[1], ...lines.slice(8, 11), ...lines.slice(5, 8), ...lines.slice(2, 5)]
    const mirrored = lines.map((l, i) => (i < 2 ? l : l.replace(/^(\S+)/, (x) => String(-Number(x)))))
    for (const text of [lines.join('\n'), bottomFirst.join('\n'), mirrored.join('\n')]) {
      const areas = triangleAreas(buildWarpGeometry([{ mesh: parsed(text), viewport: FULL }]))
      expect(areas).toHaveLength(8)
      expect(areas.every((a) => a > 0)).toBe(true)
    }
  })

  it("places a mesh in its viewport, x over the file's own aspect", () => {
    const aspect = 16 / 9
    // P3 is SOS's top-left quadrant; P1 its bottom-left. GL's y is up, so no flip.
    expect(meshToClip(-aspect, 1, aspect, SOS_QUADRANT_VIEWPORTS.P3)).toEqual({ x: -1, y: 1 })
    expect(meshToClip(aspect, -1, aspect, SOS_QUADRANT_VIEWPORTS.P3)).toEqual({ x: 0, y: 0 })
    expect(meshToClip(-aspect, -1, aspect, SOS_QUADRANT_VIEWPORTS.P1)).toEqual({ x: -1, y: -1 })
    expect(meshToClip(0, 0, aspect, SOS_QUADRANT_VIEWPORTS.P4)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('concatenates a set and reports each mesh on its own', () => {
    const a = parsed(gridText(3, 2, smooth))
    const b = parsed(gridText(3, 3, (i, j) => (i === 0 && j === 0 ? null : smooth(i, j))))
    const g = buildWarpGeometry([
      { mesh: a, viewport: SOS_QUADRANT_VIEWPORTS.P1 },
      { mesh: b, viewport: SOS_QUADRANT_VIEWPORTS.P4 },
    ])
    expect(g.meshes.map((m) => m.triangles)).toEqual([4, 13])
    expect(g.vertexCount).toBe(51)
    // The first mesh's vertices are all in P1's quadrant, the second's in P4's.
    for (let k = 0; k < g.vertexCount; k++) {
      const [x, y] = [g.positions[k * 3], g.positions[k * 3 + 1]]
      if (k < 12) expect(x <= 0 && y <= 0).toBe(true)
      else expect(x >= 0 && y >= 0).toBe(true)
    }
  })

  it('refuses a viewport outside the framebuffer', () => {
    const mesh = parsed(gridText(2, 2, smooth))
    for (const viewport of [
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
    ]) {
      expect(() => buildWarpGeometry([{ mesh, viewport }]), JSON.stringify(viewport)).toThrow(RangeError)
    }
  })
})

describe('the reconstructed edge', () => {
  /**
   * A 4×3 mesh whose rows run up meridians, so each row is a great circle
   * and the angle between two of its nodes is exactly the difference of
   * their latitudes: `lat[i]` for the three drawn columns, then a fourth
   * column that reaches nothing. Rows sit 0.02 rad of longitude apart.
   */
  function meridianRows(lat: readonly number[], weight: readonly number[] = [1, 1, 1]): WarpMesh {
    return parsed(
      gridText(4, 3, (i, j) => (i === 3 ? null : [0.5 + (0.02 * j) / (2 * Math.PI), 0.5 + lat[i] / Math.PI, weight[i]])),
    )
  }
  /** A column's clip-space x under `FULL`, from `gridText`'s spacing. */
  const columnX = (i: number): number => (2 * i) / 3 - 1
  /** Where a fraction of the way out to an edge `q` cells past column 2 lies. */
  const bandX = (q: number, f: number): number => columnX(2) + q * f * (columnX(3) - columnX(2))
  /** The vertices past the last drawn column — the band's — with their latitude. */
  function bandVertices(g: WarpGeometry): { x: number; lat: number; weight: number }[] {
    const out: { x: number; lat: number; weight: number }[] = []
    for (let k = 0; k < g.vertexCount; k++) {
      const x = g.positions[k * 3]
      if (x < columnX(2) + 1e-5) continue
      const [dx, dy, dz] = g.directions.subarray(k * 3, k * 3 + 3)
      out.push({ x, lat: (directionToWarpUv({ x: dx, y: dy, z: dz }).v - 0.5) * Math.PI, weight: g.weights[k] })
    }
    return out
  }
  const at = (g: WarpGeometry, x: number) => bandVertices(g).filter((v) => Math.abs(v.x - x) < 1e-5)
  /** How many triangles hold a point strictly inside them. */
  function coverCount(g: WarpGeometry, x: number, y: number): number {
    let n = 0
    for (let t = 0; t < g.vertexCount; t += 3) {
      const p = g.positions
      const [x0, y0, x1, y1, x2, y2] = [p[t * 3], p[t * 3 + 1], p[t * 3 + 3], p[t * 3 + 4], p[t * 3 + 6], p[t * 3 + 7]]
      const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
      const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / det
      const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / det
      if (l0 > 0 && l1 > 0 && 1 - l0 - l1 > 0) n++
    }
    return n
  }

  // Latitude θL − k√(pL − i): a silhouette 0.4 of a cell past column 2, at 0.5 rad.
  const [K, EDGE_Q, THETA_L] = [0.2, 0.4, 0.5]
  const sqrtProfile = [0, 1, 2].map((i) => THETA_L - K * Math.sqrt(2 + EDGE_Q - i))

  it('places the crossing, and the texels out to it, on an exact square-root profile', () => {
    const g = buildWarpGeometry([{ mesh: meridianRows(sqrtProfile), viewport: FULL }])
    expect(g.meshes[0].silhouette).toEqual({ edges: 3, byLaw: 3, halfway: 0 })
    // Cut at a half and three quarters of the way out, then the edge itself,
    // each vertex carrying the latitude the profile has there.
    for (const f of [0.5, 0.75, 1]) {
      const vertices = at(g, bandX(EDGE_Q, f))
      expect(vertices.length, String(f)).toBeGreaterThan(0)
      for (const v of vertices) expect(v.lat, String(f)).toBeCloseTo(THETA_L - K * Math.sqrt(EDGE_Q * (1 - f)), 6)
    }
    expect(Math.max(...bandVertices(g).map((v) => v.x))).toBeCloseTo(bandX(EDGE_Q, 1), 5)
  })

  it('reaches halfway where the steps do not lengthen, carrying them on unchanged', () => {
    // Uniform steps are a grid line running along an edge, or an open rim:
    // nothing says where in the cell the edge falls.
    const g = buildWarpGeometry([{ mesh: meridianRows([0.1, 0.2, 0.3]), viewport: FULL }])
    expect(g.meshes[0].silhouette).toEqual({ edges: 3, byLaw: 0, halfway: 3 })
    expect(Math.max(...bandVertices(g).map((v) => v.x))).toBeCloseTo(bandX(0.5, 1), 5)
    for (const v of at(g, bandX(0.5, 1))) expect(v.lat).toBeCloseTo(0.35, 6)
  })

  it('extends nothing where the steps put the edge on the last node', () => {
    // A last step three times the one before: past the law's 2.414 even with
    // the edge on the node itself.
    const g = buildWarpGeometry([{ mesh: meridianRows([0.1, 0.15, 0.3]), viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ edgeTriangles: 0, silhouette: { edges: 3, byLaw: 0, halfway: 0 } })
    expect(sampleWarpGeometry(g, columnX(2) + 0.01, 0.5)).toBeNull()
  })

  it("follows the nodes' own weight trend, never above the last node's, and ends at zero", () => {
    const weightsAt = (w: number[]) => {
      const g = buildWarpGeometry([{ mesh: meridianRows(sqrtProfile, w), viewport: FULL }])
      return [0.5, 0.75, 1].map((f) => {
        const ws = at(g, bandX(EDGE_Q, f)).map((v) => v.weight)
        expect(Math.max(...ws) - Math.min(...ws)).toBeLessThan(1e-6)
        return ws[0]
      })
    }
    const close = (actual: number[], expected: number[]) =>
      actual.forEach((a, k) => expect(a, `${expected}`).toBeCloseTo(expected[k], 6))
    // A lone projector's edge: held to three quarters, then out.
    close(weightsAt([1, 1, 1]), [1, 1, 0])
    // A blend handing over: the trend reaches zero before the edge, so the
    // band falls straight from the last node's weight to nothing.
    close(weightsAt([1, 0.9, 0.2]), [0.1, 0.05, 0])
    // Rising towards the edge: never brighter than the last node.
    close(weightsAt([0.2, 0.5, 0.8]), [0.8, 0.8, 0])
    // Falling, not to zero: continued at its own rate per radian, to the
    // angle the law puts between the last node and the edge.
    const toEdge = K * Math.sqrt(EDGE_Q)
    const trend = 0.5 - (0.8 - 0.5) * (toEdge / (sqrtProfile[2] - sqrtProfile[1]))
    expect(trend).toBeGreaterThan(0)
    close(weightsAt([1, 0.8, 0.5]), [0.5 + (trend - 0.5) * 0.5, 0.5 + (trend - 0.5) * 0.75, 0])
  })

  it('extends two opposite corners each on its own, never across the missing middle', () => {
    // The cell (1..2, 1..2) keeps a and d and loses b and c: in clip space
    // a at (-1/3, 1/3), d at (1/3, -1/3). Each reaches halfway to its two
    // missing neighbours; bridging the two would draw the cell's middle,
    // which no node there reaches.
    const g = buildWarpGeometry([
      { mesh: parsed(gridText(4, 4, (i, j) => ((i === 2 && j === 1) || (i === 1 && j === 2) ? null : smooth(i, j)))), viewport: FULL },
    ])
    expect(sampleWarpGeometry(g, -0.3, 0.3)).not.toBeNull()
    expect(sampleWarpGeometry(g, 0.3, -0.3)).not.toBeNull()
    expect(sampleWarpGeometry(g, 0, 0)).toBeNull()
  })

  it('covers the band exactly once, with no crack where two cells share a crossing', () => {
    const g = buildWarpGeometry([{ mesh: meridianRows(sqrtProfile), viewport: FULL }])
    const edgeX = bandX(EDGE_Q, 1)
    let inside = 0
    for (let s = 1; s <= 600; s++) {
      // A low-discrepancy scatter over the last column of cells, off every edge.
      const x = columnX(2) + ((s * 0.6180339887) % 1) * (columnX(3) - columnX(2))
      const y = -1 + ((s * 0.7548776662) % 1) * 2
      if (Math.abs(x - edgeX) < 1e-4) continue
      if (x < edgeX) inside++
      expect(coverCount(g, x, y), `${x}, ${y}`).toBe(x < edgeX ? 1 : 0)
    }
    expect(inside).toBeGreaterThan(100)
  })
})

describe("the blend's zero line", () => {
  /** Six columns by three rows, each column's weight the same all the way down; `null` reaches nothing. */
  function columns(weights: readonly (number | null)[]): WarpMesh {
    return parsed(
      gridText(6, 3, (i, j) => (weights[i] === null ? null : [smooth(i, j)[0], smooth(i, j)[1], weights[i] as number])),
    )
  }
  /** Column `c`'s clip-space x under `FULL`, fractional columns included. */
  const columnX = (c: number): number => (2 * c) / 5 - 1
  const weightAt = (g: WarpGeometry, c: number): number => {
    const s = sampleWarpGeometry(g, columnX(c), 0.2)
    if (s === null) throw new Error(`nothing covers column ${c}`)
    return s.weight
  }

  it('ends the picture where the nodes’ trend crosses zero, not at the node written 0', () => {
    // A ramp that reaches zero 0.4 of a cell before column 2: 0.3 at column
    // 2, 0.8 at column 3. Columns 0 and 1 are past it and written 0, and
    // interpolated from those the picture would run on to column 1.
    const g = buildWarpGeometry([{ mesh: columns([0, 0, 0.3, 0.8, 1, 1]), viewport: FULL }])
    expect(weightAt(g, 1.4)).toBeCloseTo(0, 6)
    expect(weightAt(g, 1.6)).toBeCloseTo(0.1, 6)
    expect(blendFactor(weightAt(g, 1.2), DEFAULT_BLEND_GAMMA)).toBe(0)
    expect(blendFactor(weightAt(g, 1.6), DEFAULT_BLEND_GAMMA)).toBeGreaterThan(0)
    // Column 0 has no lit neighbour and keeps its 0.
    expect(weightAt(g, 0)).toBeCloseTo(0, 6)
  })

  it('measures the trend in the file’s own spacing, which need not be even', () => {
    // Columns at clip x -1, -0.8, -0.5, 0, 0.5, 1, and a ramp w = x + 0.6
    // that reaches zero at -0.6: between the 0 node at -0.8 and the lit
    // one at -0.5, two thirds of the way along — not where an even grid's
    // arithmetic would put it.
    const xs = [-1, -0.8, -0.5, 0, 0.5, 1]
    const aspect = 16 / 9
    const lines = ['2', `${xs.length} 3`]
    for (let j = 0; j < 3; j++) {
      xs.forEach((x, i) => lines.push(`${x * aspect} ${1 - j} ${smooth(i, j)[0]} ${smooth(i, j)[1]} ${Math.min(1, Math.max(0, x + 0.6))}`))
    }
    const g = buildWarpGeometry([{ mesh: parsed(`${lines.join('\n')}\n`), viewport: FULL }])
    const at = (x: number): number => sampleWarpGeometry(g, x, 0.2)!.weight
    expect(at(-0.6)).toBeCloseTo(0, 6)
    expect(at(-0.55)).toBeCloseTo(0.05, 6)
    expect(blendFactor(at(-0.65), DEFAULT_BLEND_GAMMA)).toBe(0)
  })

  it('leaves a 0 node alone where its lit neighbours’ trend does not reach zero before it', () => {
    for (const [name, weights] of [
      ['flat', [0, 0.5, 0.5, 0.5, 0.5, 0.5]],
      ['falling inwards', [0, 0.5, 0.3, 0.2, 0.2, 0.2]],
      ['still above zero at the node', [0, 0.6, 0.8, 1, 1, 1]],
    ] as const) {
      const g = buildWarpGeometry([{ mesh: columns(weights), viewport: FULL }])
      expect(weightAt(g, 0), name).toBeCloseTo(0, 6)
      expect(weightAt(g, 0.5), name).toBeCloseTo(weights[1] / 2, 6)
    }
  })

  it('takes the lowest value where two lit neighbours’ trends disagree', () => {
    // Node (0, 0) is written 0. Along its row the trend reaches -0.2 there,
    // down its column -0.5: the lower puts each crossing nearest the light.
    const w = (i: number, j: number): number =>
      i === 0 && j === 0 ? 0 : j === 0 ? [0, 0.3, 0.8, 1][i] : i === 0 ? [0, 0.2, 0.9, 1][j] : 1
    const g = buildWarpGeometry([
      { mesh: parsed(gridText(4, 4, (i, j) => [smooth(i, j)[0], smooth(i, j)[1], w(i, j)])), viewport: FULL },
    ])
    expect(sampleWarpGeometry(g, -1, 1)!.weight).toBeCloseTo(-0.5, 6)
  })

  it('carries a 0 node’s value out through the band past the silhouette', () => {
    // Column 0 reaches nothing, column 1 is written 0 and draws with -0.2,
    // and its band carries -0.2 all the way to the silhouette — the last
    // vertex too — so a strip beside it crosses zero where the cells do.
    const g = buildWarpGeometry([{ mesh: columns([null, 0, 0.3, 0.8, 1, 1]), viewport: FULL }])
    const band: number[] = []
    for (let k = 0; k < g.vertexCount; k++) if (g.positions[k * 3] < columnX(1) - 1e-5) band.push(g.weights[k])
    expect(band.length).toBeGreaterThan(0)
    for (const weight of band) expect(weight).toBeCloseTo(-0.2, 6)
    expect(blendFactor(sampleWarpGeometry(g, columnX(0.8), 0.2)!.weight, DEFAULT_BLEND_GAMMA)).toBe(0)
  })
})

describe('sampleWarpGeometry', () => {
  const mesh = parsed(gridText(3, 3, (i, j) => [0.45 + 0.02 * i, 0.55 - 0.02 * j, 0.25 * i]))
  const g = buildWarpGeometry([{ mesh, viewport: SOS_QUADRANT_VIEWPORTS.P1 }])

  it('returns nothing where no triangle is drawn', () => {
    expect(sampleWarpGeometry(g, 0.5, 0.5)).toBeNull()
  })

  it("returns a node's own texel and weight at the node", () => {
    const node = mesh.nodes[4]
    const at = meshToClip(node.x, node.y, mesh.aspect, SOS_QUADRANT_VIEWPORTS.P1)
    const s = sampleWarpGeometry(g, at.x, at.y)!
    expect(s.u).toBeCloseTo(node.u, 6)
    expect(s.v).toBeCloseTo(node.v, 6)
    expect(s.weight).toBeCloseTo(node.weight, 6)
  })

  it('interpolates the weight linearly, where it is linear light', () => {
    const left = mesh.nodes[3]
    const right = mesh.nodes[4]
    const mid = meshToClip((left.x + right.x) / 2, left.y, mesh.aspect, SOS_QUADRANT_VIEWPORTS.P1)
    expect(sampleWarpGeometry(g, mid.x, mid.y)!.weight).toBeCloseTo((left.weight + right.weight) / 2, 6)
  })
})

describe('blendFactor', () => {
  it('passes full weight and blacks out none', () => {
    expect(blendFactor(1, 2.2)).toBe(1)
    expect(blendFactor(0, 2.2)).toBe(0)
    expect(blendFactor(-1, 2.2)).toBe(0)
    expect(blendFactor(Number.NaN, 2.2)).toBe(0)
    expect(blendFactor(1.5, 2.2)).toBe(1)
  })

  it('is decode, multiply, encode — the weight applied in linear light', () => {
    for (const c of [0.2, 0.5, 0.9]) {
      for (const w of [0.1, 0.5, 0.75]) {
        for (const gamma of [1.8, 2.2, 2.4]) {
          expect(c * blendFactor(w, gamma)).toBeCloseTo(Math.pow(Math.pow(c, gamma) * w, 1 / gamma), 12)
        }
      }
    }
  })

  it('makes two half-weight projectors sum to the target, where an encoded multiply leaves 44%', () => {
    const gamma = DEFAULT_BLEND_GAMMA
    const c = 0.8
    const target = Math.pow(c, gamma)
    const linear = 2 * Math.pow(c * blendFactor(0.5, gamma), gamma)
    expect(linear / target).toBeCloseTo(1, 12)
    const encodedMultiply = 2 * Math.pow(c * 0.5, gamma)
    expect(encodedMultiply / target).toBeCloseTo(0.435, 3)
  })

  it('falls back to the default for a gamma no field could hold', () => {
    const expected = blendFactor(0.5, DEFAULT_BLEND_GAMMA)
    for (const gamma of [0, -2.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(blendFactor(0.5, gamma), String(gamma)).toBe(expected)
    }
  })
})

describe('sosQuadrantLayout', () => {
  it('places P1–P4 in any order, and a subset keeps its slots', () => {
    expect(sosQuadrantLayout(['P3', 'P1'])).toEqual({
      ok: true,
      viewports: [SOS_QUADRANT_VIEWPORTS.P3, SOS_QUADRANT_VIEWPORTS.P1],
    })
  })

  it('refuses an id the quadrants cannot place rather than guessing', () => {
    expect(sosQuadrantLayout(['P1', 'P5', 'p3'])).toEqual({ ok: false, code: 'unplaceable', ids: ['P5', 'p3'] })
    // Nothing inherited counts as a quadrant.
    expect(sosQuadrantLayout(['constructor', '__proto__'])).toMatchObject({ ok: false, code: 'unplaceable' })
  })

  it('refuses two meshes for one quadrant, and an empty set', () => {
    expect(sosQuadrantLayout(['P1', 'P2', 'P1'])).toEqual({ ok: false, code: 'duplicate', ids: ['P1'] })
    expect(sosQuadrantLayout([])).toEqual({ ok: false, code: 'empty', ids: [] })
  })
})

describe('isWarpId', () => {
  it.each(['P1', 'P12', 'Projector 2', 'dome-east', 'Pé', 'a.b', 'x'.repeat(64)])('accepts %j', (id) => {
    expect(isWarpId(id)).toBe(true)
  })

  it.each(['', ' P1', 'P1 ', '﻿P1', '.', '..', 'a/b', 'a\\b', 'P\u0000', 'P\u0085', 'P�', 'x'.repeat(65)])(
    'refuses %j',
    (id) => {
      expect(isWarpId(id)).toBe(false)
    },
  )
})

describe('placeWarpSet', () => {
  const mesh = gridText(3, 3, smooth)
  const entry = (id: SosQuadrantId, text = mesh): WarpSetEntry => ({ id, viewport: SOS_QUADRANT_VIEWPORTS[id], text })
  const refusal = (entries: readonly WarpSetEntry[]): WarpSetRefusal => {
    const result = placeWarpSet(entries)
    if (result.ok) throw new Error('placed; a refusal was expected')
    return result.refusal
  }

  it('parses every mesh and keeps each with its viewport, in order', () => {
    const result = placeWarpSet([entry('P3', fixture('boulder-P3.data')), entry('P1'), entry('P4'), entry('P2')])
    if (!result.ok) throw new Error(JSON.stringify(result.refusal))
    expect(result.placed.map((p) => p.viewport)).toEqual([
      SOS_QUADRANT_VIEWPORTS.P3,
      SOS_QUADRANT_VIEWPORTS.P1,
      SOS_QUADRANT_VIEWPORTS.P4,
      SOS_QUADRANT_VIEWPORTS.P2,
    ])
    expect(result.placed[0].mesh.cols).toBe(41)
    // What it accepts, the geometry build draws without throwing.
    expect(buildWarpGeometry(result.placed).meshes).toHaveLength(4)
  })

  it('accepts viewports that share an edge, and a single mesh over the whole window', () => {
    expect(placeWarpSet([entry('P1'), entry('P2'), entry('P3'), entry('P4')]).ok).toBe(true)
    // Whichever side of the shared edge comes first.
    expect(placeWarpSet([entry('P4'), entry('P3'), entry('P2'), entry('P1')]).ok).toBe(true)
    expect(placeWarpSet([{ id: 'only', viewport: FULL, text: mesh }]).ok).toBe(true)
  })

  it('refuses an empty set, and more meshes than an output carries', () => {
    expect(refusal([])).toEqual({ code: 'no-meshes' })
    const many = Array.from({ length: MAX_WARP_MESHES + 1 }, (_, i) => ({
      id: `P${i}`,
      viewport: { x: i / (MAX_WARP_MESHES + 1), y: 0, w: 1 / (MAX_WARP_MESHES + 1), h: 1 },
      text: mesh,
    }))
    expect(refusal(many)).toEqual({ code: 'too-many', count: MAX_WARP_MESHES + 1 })
  })

  it('refuses an id that cannot be one, and ids that fold together', () => {
    expect(refusal([{ id: 'a/b', viewport: FULL, text: mesh }])).toEqual({ code: 'bad-id', id: 'a/b' })
    expect(refusal([entry('P1'), { ...entry('P2'), id: 'p1' }])).toEqual({ code: 'duplicate-id', ids: ['p1'] })
  })

  it('refuses a viewport outside the framebuffer, or with no area', () => {
    const at = (viewport: WarpViewport): WarpSetRefusal => refusal([{ id: 'P1', viewport, text: mesh }])
    expect(at({ x: 0.6, y: 0, w: 0.5, h: 1 })).toEqual({ code: 'bad-viewport', id: 'P1' })
    expect(at({ x: -0.1, y: 0, w: 0.5, h: 1 })).toEqual({ code: 'bad-viewport', id: 'P1' })
    expect(at({ x: 0, y: 0, w: 0, h: 1 })).toEqual({ code: 'bad-viewport', id: 'P1' })
    expect(at({ x: Number.NaN, y: 0, w: 0.5, h: 1 })).toEqual({ code: 'bad-viewport', id: 'P1' })
  })

  it('refuses two projectors sharing framebuffer pixels', () => {
    const left: WarpSetEntry = { id: 'L', viewport: { x: 0, y: 0, w: 0.6, h: 1 }, text: mesh }
    const right: WarpSetEntry = { id: 'R', viewport: { x: 0.5, y: 0, w: 0.5, h: 1 }, text: mesh }
    expect(refusal([left, right])).toEqual({ code: 'overlap', ids: ['L', 'R'] })
    expect(refusal([entry('P1'), { id: 'all', viewport: FULL, text: mesh }])).toEqual({ code: 'overlap', ids: ['P1', 'all'] })
  })

  it('refuses the whole set for one mesh that does not parse, naming it', () => {
    const truncated = mesh.split('\n').slice(0, 6).join('\n')
    expect(refusal([entry('P1'), entry('P2', truncated)])).toMatchObject({
      code: 'mesh',
      id: 'P2',
      mesh: { code: 'node-count' },
    })
  })
})

describe("parity with sphere-sim's own tracer", () => {
  interface Rig {
    name: string
    file: string
    projectorId: string
    resX: number
    resY: number
    samples: [number, number, number, number][]
  }
  interface EdgeRig extends Rig {
    /** `[i, j, di, dj, t]`: node (i, j) reaches the surface, its neighbour past it does not, and the tracer's rays stop `t` of the way. */
    silhouette: [number, number, number, number, number][]
    /** `[px, py, u, v, w]`: traced texel and weight where complete triangles alone leave black. */
    band: [number, number, number, number, number][]
    /** `[i, j, di, dj, t]`: node (i, j) is drawn and weighted 0, its neighbour lit, and the traced weight rises above 0 `t` of the way. */
    zeroLine: [number, number, number, number, number][]
  }
  const parity = JSON.parse(fixture('parity.json')) as {
    provenance: { sphereSimCommit: string }
    sosQuadrantViewports: ({ id: string } & WarpViewport)[]
    rigs: EdgeRig[]
    rotated: Rig & { rotationOffsetDeg: number }
  }

  it('was generated from a named sphere-sim commit', () => {
    expect(parity.provenance.sphereSimCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("carries a sphere rig's own rotation in the mesh, so nothing may apply it again (convention 3)", () => {
    // SOS's nominal rig turned 30°, which sphere-sim bakes into `u`.
    // Boulder's rotation is 0, so no other fixture can tell a mesh that
    // carries the rotation from one that does not. With nothing applied
    // the mesh lands where the tracer says; with the rig's rotation
    // applied again — seeding the output's content rotation from the rig
    // — it lands the rotation away. Measured: 0.21° at most against
    // 26–30°, at 21×21 on interior cells.
    const rig = parity.rotated
    expect(rig.rotationOffsetDeg).toBe(30)
    const geometry = buildWarpGeometry([{ mesh: parsed(fixture(rig.file)), viewport: FULL }])
    const degrees = (a: Vec3, b: Vec3): number => (angleRad(a, b) * 180) / Math.PI
    expect(rig.samples.length).toBeGreaterThan(10)
    for (const [px, py, u, v] of rig.samples) {
      const s = sampleWarpGeometry(geometry, (px / rig.resX) * 2 - 1, 1 - (py / rig.resY) * 2)
      if (s === null) throw new Error(`no triangle covers (${px}, ${py})`)
      const truth = nodeDirection(u, v)
      expect(degrees(nodeDirection(s.u, s.v), truth)).toBeLessThan(1)
      expect(degrees(nodeDirection(s.u - rig.rotationOffsetDeg / 360, s.v), truth)).toBeGreaterThan(20)
    }
  })

  it("holds SOS's quadrant table to sphere-sim's", () => {
    for (const { id, ...viewport } of parity.sosQuadrantViewports) {
      expect(SOS_QUADRANT_VIEWPORTS[id as keyof typeof SOS_QUADRANT_VIEWPORTS], id).toEqual(viewport)
    }
    expect(parity.sosQuadrantViewports.map((v) => v.id)).toEqual(Object.keys(SOS_QUADRANT_VIEWPORTS))
  })

  /**
   * Everything a sample needs to be judged: where the module puts it, and
   * where the mesh's own cell says it should be to within the grid's error.
   * The error is an angle in units of the cell's own pixel scale — the
   * measure the plan's numbers were taken in — and the tolerance steps by
   * the cell's distance from the silhouette, because the 41×41 grid is
   * least accurate in the ring beside it: measured over every triangle by
   * `scripts/generate-warp-parity-fixtures.ts`, independently of this
   * module, the worst is 28.4 px there, 5.2 px one ring in and 2.8 px
   * in the interior.
   */
  function judge(rig: Rig) {
    const mesh = parsed(fixture(rig.file))
    const layout = rig.name === 'boulder' ? sosQuadrantLayout([rig.projectorId]) : null
    const viewport = layout?.ok ? layout.viewports[0] : FULL
    const g = buildWarpGeometry([{ mesh, viewport }])
    const { cols, rows, nodes } = mesh
    const dirOf = (i: number, j: number): Vec3 => nodeDirection(nodes[j * cols + i].u, nodes[j * cols + i].v)
    const pxOf = (i: number, j: number): [number, number] => [(i / (cols - 1)) * rig.resX, (j / (rows - 1)) * rig.resY]
    const noData: [number, number][] = []
    nodes.forEach((n, k) => {
      if (!n.drawable) noData.push([k % cols, Math.floor(k / cols)])
    })

    return rig.samples.map(([px, py, u, v]) => {
      const x = ((px / rig.resX) * 2 - 1) * mesh.aspect
      const y = 1 - (py / rig.resY) * 2
      const clip = meshToClip(x, y, mesh.aspect, viewport)
      const s = sampleWarpGeometry(g, clip.x, clip.y)

      const fx = (px / rig.resX) * (cols - 1)
      const fy = (py / rig.resY) * (rows - 1)
      // A sample on a cell's edge is rounded to three decimals in the
      // fixture, so floor() alone can hand it to the neighbour — possibly a
      // cell the silhouette dropped, whose no-data corner would make every
      // figure below NaN. Take whichever adjacent cell is drawn.
      const drawnCell = (ci: number, cj: number): boolean =>
        [cj * cols + ci, cj * cols + ci + 1, (cj + 1) * cols + ci, (cj + 1) * cols + ci + 1].every((k) => nodes[k].drawable)
      const cellI = (f: number): number => Math.max(0, Math.min(cols - 2, Math.floor(f)))
      const cellJ = (f: number): number => Math.max(0, Math.min(rows - 2, Math.floor(f)))
      const EDGE = 1e-4
      const candidates = [-EDGE, EDGE].flatMap((dx) => [-EDGE, EDGE].map((dy) => [cellI(fx + dx), cellJ(fy + dy)]))
      const [i, j] = candidates.find(([ci, cj]) => drawnCell(ci, cj)) ?? [cellI(fx), cellJ(fy)]
      const corners: [number, number][] =
        fx - i + (fy - j) <= 1 ? [[i, j], [i + 1, j], [i, j + 1]] : [[i + 1, j], [i + 1, j + 1], [i, j + 1]]
      const edgeScale = (a: number, b: number): number => {
        const [pa, pb] = [pxOf(...corners[a]), pxOf(...corners[b])]
        return angleRad(dirOf(...corners[a]), dirOf(...corners[b])) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
      }
      const radPerPx = (edgeScale(0, 1) + edgeScale(1, 2) + edgeScale(0, 2)) / 3
      let ring = Infinity
      for (const [ii, jj] of noData) {
        ring = Math.min(ring, Math.max(Math.abs(ii - i), Math.abs(jj - j), Math.abs(ii - i - 1), Math.abs(jj - j - 1)))
      }
      const truth = nodeDirection(u, v)
      const errorPx = s === null ? Infinity : angleRad(nodeDirection(s.u, s.v), truth) / radPerPx

      // The same point under a stock Bourke player's arithmetic, for the contrasts below.
      const cu = corners.map(([ci, cj]) => nodes[cj * cols + ci].u)
      const cv = corners.map(([ci, cj]) => nodes[cj * cols + ci].v)
      const cp = corners.map(([ci, cj]) => pxOf(ci, cj))
      const det = (cp[1][1] - cp[2][1]) * (cp[0][0] - cp[2][0]) + (cp[2][0] - cp[1][0]) * (cp[0][1] - cp[2][1])
      const l0 = ((cp[1][1] - cp[2][1]) * (px - cp[2][0]) + (cp[2][0] - cp[1][0]) * (py - cp[2][1])) / det
      const l1 = ((cp[2][1] - cp[0][1]) * (px - cp[2][0]) + (cp[0][0] - cp[2][0]) * (py - cp[2][1])) / det
      const l = [l0, l1, 1 - l0 - l1]
      const asWritten = nodeDirection(l[0] * cu[0] + l[1] * cu[1] + l[2] * cu[2], l[0] * cv[0] + l[1] * cv[1] + l[2] * cv[2])
      const unwrappedU = cu.map((c) => c - Math.round(c - cu[0]))
      const unwrapped = nodeDirection(
        l[0] * unwrappedU[0] + l[1] * unwrappedU[1] + l[2] * unwrappedU[2],
        l[0] * cv[0] + l[1] * cv[1] + l[2] * cv[2],
      )
      let wind = 0
      for (let k = 0; k < 3; k++) {
        const du = cu[(k + 1) % 3] - cu[k]
        wind += du - Math.round(du)
      }
      return {
        drawn: s !== null,
        ring,
        errorPx,
        seam: Math.max(...cu) - Math.min(...cu) > 0.5,
        pole: Math.abs(wind) > 0.5,
        asWrittenPx: angleRad(asWritten, truth) / radPerPx,
        unwrappedPx: angleRad(unwrapped, truth) / radPerPx,
      }
    })
  }

  const tolerancePx = (ring: number): number => (ring <= 2 ? 30 : ring === 3 ? 6 : 3)

  for (const rig of parity.rigs) {
    it(`${rig.name} ${rig.projectorId}: every sample within the grid's own error, by ring`, () => {
      const judged = judge(rig)
      expect(judged.length).toBeGreaterThan(200)
      expect(judged.every((j) => j.drawn)).toBe(true)
      // Written as "not within" so a NaN — a sample judged against a cell it
      // is not in — fails rather than slipping past a greater-than.
      const outside = judged.filter((j) => !(j.errorPx <= tolerancePx(j.ring)))
      expect(outside).toEqual([])
    })
  }

  it('boulder P3 crosses the seam in 38 of its 620 cells, as the plan counts them', () => {
    const { cols, rows, nodes } = parsed(fixture('boulder-P3.data'))
    let drawn = 0
    let seam = 0
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const corners = [nodes[j * cols + i], nodes[j * cols + i + 1], nodes[(j + 1) * cols + i], nodes[(j + 1) * cols + i + 1]]
        if (!corners.every((n) => n.drawable)) continue
        drawn++
        const us = corners.map((n) => n.u)
        if (Math.max(...us) - Math.min(...us) > 0.5) seam++
      }
    }
    expect([drawn, seam]).toEqual([620, 38])
  })

  it('boulder P3: the seam, which (u, v) as written sweeps across the whole world', () => {
    const seam = judge(parity.rigs.find((r) => r.name === 'boulder')!).filter((j) => j.seam)
    // Five points in each of the 76 seam triangles, less the few on a
    // diagonal that land in the neighbouring triangle once rounded.
    expect(seam.length).toBeGreaterThan(300)
    expect(Math.max(...seam.map((j) => j.errorPx))).toBeLessThan(tolerancePx(2))
    expect(Math.max(...seam.map((j) => j.asWrittenPx))).toBeGreaterThan(1000)
  })

  it('placed rig: the pole, where directions hold and unwrapped (u, v) cannot', () => {
    const pole = judge(parity.rigs.find((r) => r.name === 'placed-pole')!).filter((j) => j.pole)
    expect(pole.length).toBeGreaterThan(0)
    const worstDirection = Math.max(...pole.map((j) => j.errorPx))
    const worstUnwrapped = Math.max(...pole.map((j) => j.unwrappedPx))
    // The plan's measurement: within 2 px under directions, tens of px under (u, v).
    expect(worstDirection).toBeLessThanOrEqual(2)
    expect(worstUnwrapped).toBeGreaterThan(19)
    expect(worstUnwrapped).toBeGreaterThan(10 * worstDirection)
  })

  it('drops nothing as too wide on a sphere: the widest real triangle is far inside the bound', () => {
    for (const rig of parity.rigs) {
      const mesh = parsed(fixture(rig.file))
      const g = buildWarpGeometry([{ mesh, viewport: FULL }])
      expect(g.meshes[0].droppedWide, rig.name).toBe(0)
      let widest = 0
      for (let t = 0; t < g.vertexCount; t += 3) {
        const d = [0, 1, 2].map((k): Vec3 => {
          const [x, y, z] = g.directions.subarray((t + k) * 3, (t + k) * 3 + 3)
          return { x, y, z }
        })
        widest = Math.max(widest, angleRad(d[0], d[1]), angleRad(d[1], d[2]), angleRad(d[0], d[2]))
      }
      // The plan's figure is 3.6× on Boulder and both placed rigs; the bound is 8×.
      expect(widest / g.meshes[0].medianWidthRad, rig.name).toBeLessThan(4)
    }
  })

  describe('the silhouette, which the mesh cannot state', () => {
    /**
     * Every figure here was measured on this fixture. The two rigs are the
     * two cases the weight rule is torn between: Boulder's edges are almost
     * all blended, so its band is dark, and the placed rig's one projector
     * lights its edge alone at full weight — whose deliberate fade over the
     * last strip is most of that rig's weight error.
     */
    const expected: Record<string, { law: number; halfway: number; medianPx: number; maxPx: number; light: number; texelDeg: number; weight: number }> = {
      boulder: { law: 116, halfway: 8, medianPx: 1.5, maxPx: 16, light: 0.99, texelDeg: 2, weight: 0.03 },
      'placed-pole': { law: 116, halfway: 8, medianPx: 1.5, maxPx: 7, light: 0.95, texelDeg: 3.5, weight: 0.13 },
    }

    /** How far along the segment from `a` to `b`, as a fraction, the geometry's farthest vertex on it lies. */
    function reachAlong(g: WarpGeometry, a: { x: number; y: number }, b: { x: number; y: number }): number {
      const [ex, ey] = [b.x - a.x, b.y - a.y]
      const length2 = ex * ex + ey * ey
      let reach = 0
      for (let k = 0; k < g.vertexCount; k++) {
        const [px, py] = [g.positions[k * 3] - a.x, g.positions[k * 3 + 1] - a.y]
        const along = (px * ex + py * ey) / length2
        if (Math.abs(px * ey - py * ex) / length2 < 1e-5 && along > 1e-6 && along <= 1 + 1e-6) reach = Math.max(reach, along)
      }
      return reach
    }

    for (const rig of parity.rigs) {
      const want = expected[rig.name]

      it(`${rig.name} ${rig.projectorId}: extends every silhouette edge, the law's crossings within pixels of the tracer's`, () => {
        const mesh = parsed(fixture(rig.file))
        const g = buildWarpGeometry([{ mesh, viewport: FULL }])
        expect(g.meshes[0].silhouette).toEqual({ edges: rig.silhouette.length, byLaw: want.law, halfway: want.halfway })
        const { cols, rows, nodes } = mesh
        const clip = (i: number, j: number) => meshToClip(nodes[j * cols + i].x, nodes[j * cols + i].y, mesh.aspect, FULL)
        const lawPx: number[] = []
        for (const [i, j, di, dj, t] of rig.silhouette) {
          // The band's last vertex on this grid edge is where it put the crossing.
          const reach = reachAlong(g, clip(i, j), clip(i + di, j + dj))
          expect(reach, `${i},${j} towards ${di},${dj}`).toBeGreaterThan(0)
          if (Math.abs(reach - 0.5) < 1e-6) continue
          lawPx.push(Math.abs(reach - t) * (di !== 0 ? rig.resX / (cols - 1) : rig.resY / (rows - 1)))
        }
        lawPx.sort((p, q) => p - q)
        expect(lawPx).toHaveLength(want.law)
        expect(lawPx[lawPx.length >> 1]).toBeLessThan(want.medianPx)
        expect(lawPx[lawPx.length - 1]).toBeLessThan(want.maxPx)
      })

      it(`${rig.name} ${rig.projectorId}: draws the band a staircase leaves black, with the tracer's texels`, () => {
        const g = buildWarpGeometry([{ mesh: parsed(fixture(rig.file)), viewport: FULL }])
        expect(rig.band.length).toBeGreaterThan(500)
        let light = 0
        let drawn = 0
        const texelDeg: number[] = []
        const weightError: number[] = []
        for (const [px, py, u, v, w] of rig.band) {
          const s = sampleWarpGeometry(g, (px / rig.resX) * 2 - 1, 1 - (py / rig.resY) * 2)
          light += w
          if (s === null) continue
          drawn += w
          // What the projector emits: past the blend's zero line the
          // interpolated weight is below zero, and the shader clamps it.
          weightError.push(Math.abs(Math.min(1, Math.max(0, s.weight)) - w))
          if (w >= 0.05) texelDeg.push((angleRad(nodeDirection(s.u, s.v), nodeDirection(u, v)) * 180) / Math.PI)
        }
        // Complete triangles alone draw none of these points.
        expect(drawn / light).toBeGreaterThan(want.light)
        expect(Math.max(...texelDeg)).toBeLessThan(want.texelDeg)
        expect(weightError.reduce((sum, e) => sum + e, 0) / weightError.length).toBeLessThan(want.weight)
      })
    }
  })

  describe("the blend's zero line, which the mesh cannot state either", () => {
    /**
     * Measured on this fixture. Boulder's sector crossfade rises like a
     * power of the distance past its zero line, so the nodes' straight
     * trend lands a few pixels inside the traced line, where the staircase
     * lands tens outside it. The placed projector's zero line is its polar
     * mask, which ends in a quadratic tail: there the trend lands further
     * inside than the staircase lands outside, which costs the tail's faint
     * light and halves the light drawn past the mask.
     */
    const expected: Record<string, { reconstructed: number; medianPx: number; maxPx: number; staircasePx?: number }> = {
      boulder: { reconstructed: 80, medianPx: 8, maxPx: 16, staircasePx: 30 },
      'placed-pole': { reconstructed: 21, medianPx: 17, maxPx: 34 },
    }

    for (const rig of parity.rigs) {
      const want = expected[rig.name]

      it(`${rig.name} ${rig.projectorId}: draws the zero line near the tracer's, not at the node written 0`, () => {
        const mesh = parsed(fixture(rig.file))
        const g = buildWarpGeometry([{ mesh, viewport: FULL }])
        const { cols, rows, nodes } = mesh
        const drawnAt = (i: number, j: number): number => {
          const c = meshToClip(nodes[j * cols + i].x, nodes[j * cols + i].y, mesh.aspect, FULL)
          const s = sampleWarpGeometry(g, c.x, c.y)
          if (s === null) throw new Error(`nothing covers node ${i},${j}`)
          return s.weight
        }
        expect(rig.zeroLine.length).toBeGreaterThan(20)
        const errorPx: number[] = []
        const staircasePx: number[] = []
        let reconstructed = 0
        for (const [i, j, di, dj, t] of rig.zeroLine) {
          const zero = drawnAt(i, j)
          const lit = drawnAt(i + di, j + dj)
          expect(lit).toBeGreaterThan(0)
          // Interpolation is linear along a grid edge: it crosses zero this
          // far from the 0 node, or at the node when that kept its 0.
          const s = zero < 0 ? zero / (zero - lit) : 0
          if (zero < 0) reconstructed++
          const cell = di !== 0 ? rig.resX / (cols - 1) : rig.resY / (rows - 1)
          errorPx.push(Math.abs(s - t) * cell)
          staircasePx.push(t * cell)
        }
        const median = (a: number[]): number => [...a].sort((p, q) => p - q)[a.length >> 1]
        expect(reconstructed).toBe(want.reconstructed)
        expect(median(errorPx)).toBeLessThan(want.medianPx)
        expect(Math.max(...errorPx)).toBeLessThan(want.maxPx)
        if (want.staircasePx !== undefined) expect(median(staircasePx)).toBeGreaterThan(want.staircasePx)
      })
    }
  })
})
