// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Regenerate the parity fixtures `src/output/projectorWarp.test.ts` holds
 * `projectorWarp` to: warp meshes written by sphere-sim's own exporter, and
 * the texel sphere-sim's own tracer puts at raster points inside them.
 *
 *     npx tsx scripts/generate-warp-parity-fixtures.ts --sphere-sim ../sphere-sim
 *
 * `docs/MULTI_MONITOR_PLAN.md` §"Rung 16", "Verification": the pure module
 * is only as right as its agreement with the tool that made the file, and
 * terraviz cannot run that tool in its own test suite — sphere-sim is a
 * separate repository. So the tool runs here, once, against a checkout,
 * and what it said is committed as data. The commit it ran at goes into the
 * fixture, so a regenerated file names what changed.
 *
 * Two rigs, each chosen for the case it is the only witness to:
 *
 *   - **Boulder's P3** — the SOS preset's projector whose raster crosses
 *     the texture's ±180° meridian, so it carries the seam: cells whose
 *     corners jump from u ≈ 1 to u ≈ 0.
 *   - **A placed projector aimed high** — a pole in view, where a
 *     triangle's corners go all the way round in longitude and no unwrap
 *     of `u` can interpolate them. Aimed off the pole on purpose: straight
 *     down the axis puts the pole exactly on the centre node, and a pole
 *     on a node is the easy case — the node's direction is the axis
 *     whatever its `u` says.
 *
 * Two more outputs, each for one question the rigs above cannot answer:
 *
 *   - **SOS's nominal rig turned 30°** — convention 3. sphere-sim bakes a
 *     sphere rig's mechanical rotation into `u`, and Boulder's is 0, so
 *     only a turned rig can show that the mesh alone lands where the
 *     tracer says and the rig's rotation applied again lands 30° out. At
 *     21×21, interior cells only: what it witnesses is tens of degrees.
 *   - **A whole bundle** from sphere-sim's own `bundleEntries` and
 *     `buildZip`, at 5×5, with a restore point holding an older P1 — the
 *     ZIP reader's fixture, and the one entry it must never take. It
 *     carries `layout.json` (sphere-sim#52), built as the page builds it:
 *     `projectorLayout` over the raw rig, `warpTexture`, and the mesh ids.
 *     Written twice: with the layout, and without it, which is how a
 *     refused layout and every bundle from before #52 read.
 *   - **A placed pair**, the rig the layout exists for: sphere-sim's own
 *     builders applied to two placed projectors, whose layout is halves
 *     at full height where SOS's quadrants would put the same ids in the
 *     bottom row. The page does not export a placed rig yet; sphere-sim
 *     pins this case at the builder, and so does this fixture.
 *
 * Samples are taken inside every triangle that crosses the seam or holds
 * the pole, every triangle in the two rings nearest the silhouette (where
 * the 41×41 grid is least accurate, and the test's tolerances step), and
 * a stride through the interior. Each is sphere-sim's answer, not ours:
 * `pixelToRay`, the intersection, `worldLonToTextureLon`, `coordToUv`.
 *
 * And the silhouette itself, which a mesh cannot state and the module
 * reconstructs: for every grid edge from a node that reaches the surface
 * to one that does not, where along it the tracer's rays stop hitting,
 * found by bisection; and the traced texel and blend weight — the
 * exporter's own `coverageAndWeights` times its polar mask — on a 4×4
 * lattice in every cell the silhouette crosses, kept only where a player
 * drawing complete triangles alone leaves black.
 *
 * And the blend's zero line, which a mesh cannot state either: for every
 * grid edge from a drawn node the exporter weighted 0 to a lit neighbour,
 * where along it the traced weight first rises above 0, found the same way.
 *
 * Also printed, not written: the same interpolation error measured with
 * this script's own arithmetic, independent of `projectorWarp`, per ring.
 * Those are the numbers the test's tolerances come from — setting them
 * from the module under test would make the check circular.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type V3 = [number, number, number]

interface SphereSimNode { x: number; y: number; u: number; v: number; intensity: number }
interface SphereSimExport { projectorId: string; cols: number; rows: number; nodes: SphereSimNode[] }
interface Hit { point: unknown; normal: unknown; location: unknown }
// The slice of sphere-sim's types this script touches, declared locally so
// it does not need that repository's type graph to run.
interface SphereSimRig {
  rotationOffsetDeg: number
  blend: unknown
  surface: {
    intersect(lens: unknown, ray: unknown): Hit | null
    coordAt(point: unknown, location: unknown): { latDeg: number; lonDeg: number }
  }
  projectors: { lens: unknown; cal: { id: string; intrinsics: { resX: number; resY: number } } }[]
}

const OUT_DIR = resolve(import.meta.dirname, '../src/output/fixtures/projectorWarp')
const DEG = 180 / Math.PI
/**
 * Every seam and pole triangle is sampled; the rest are strided, since a
 * fixture of every triangle would be a second copy of the mesh. The survey
 * printed alongside covers every triangle regardless.
 */
const RING_STRIDE = 3
const INTERIOR_STRIDE = 12
/** The probes' five barycentric points — centroid, three edge midpoints, one off-centre. */
const FIVE_POINTS: V3[] = [
  [1 / 3, 1 / 3, 1 / 3],
  [0.5, 0.5, 0],
  [0, 0.5, 0.5],
  [0.5, 0, 0.5],
  [0.6, 0.2, 0.2],
]

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** The shader's frame, restated here so the survey is independent of the module under test. */
function dir(u: number, v: number): V3 {
  const lon = (u - 0.5) * 2 * Math.PI
  const lat = (v - 0.5) * Math.PI
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)]
}
function angle(a: V3, b: V3): number {
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return [a[0] / l, a[1] / l, a[2] / l]
}
const round = (x: number, places: number): number => Number(x.toFixed(places))

async function main(): Promise<void> {
  const root = resolve(argValue('--sphere-sim') ?? '../sphere-sim')
  const load = async <T>(rel: string): Promise<T> =>
    (await import(pathToFileURL(join(root, rel)).href)) as T
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  const { BOULDER_PRESET } = await load<{ BOULDER_PRESET: unknown }>('packages/web/src/settings.ts')
  const { buildWorld } = await load<{ buildWorld(p: unknown): { compositorRig: unknown; truthRig: unknown } }>(
    'packages/web/src/rigs.ts',
  )
  const { prepareRig, pixelToRay } = await load<{
    prepareRig(r: unknown): SphereSimRig
    pixelToRay(p: unknown, x: number, y: number): unknown
  }>('packages/sim/src/optics.ts')
  const { placedRig } = await load<{ placedRig(p: unknown): unknown }>('packages/sim/src/placement.ts')
  const { buildWarpExports, formatWarpMesh } = await load<{
    buildWarpExports(r: SphereSimRig, options?: { cols?: number; rows?: number }): SphereSimExport[]
    formatWarpMesh(w: SphereSimExport): string
  }>('packages/sim/src/warp.ts')
  const { worldLonToTextureLon } = await load<{ worldLonToTextureLon(lon: number, off: number): number }>(
    'packages/sim/src/geometry.ts',
  )
  const { coordToUv } = await load<{
    coordToUv(c: { latDeg: number; lonDeg: number }): { u: number; v: number }
  }>('packages/sim/src/mesh/surface.ts')
  const { blendModelApplies } = await load<{ blendModelApplies(s: unknown): boolean }>(
    'packages/sim/src/surface.ts',
  )
  const { coverageAndWeights, polarMask } = await load<{
    coverageAndWeights(point: unknown, normal: unknown, rig: SphereSimRig, at?: unknown): { weights: number[] }
    polarMask(latDeg: number, blend: unknown, interpretation: 'latitude'): number
  }>('packages/sim/src/coverage.ts')
  const { SOS_QUADRANT_VIEWPORTS } = await load<{
    SOS_QUADRANT_VIEWPORTS: readonly { x: number; y: number; w: number; h: number }[]
  }>('packages/sim/src/scene.ts')

  /** sphere-sim's own answer for a raster point: the texel, v up, as its exporter writes it. */
  function truth(rig: SphereSimRig, index: number, px: number, py: number): [number, number] | null {
    const p = rig.projectors[index]
    const hit = rig.surface.intersect(p.lens, pixelToRay(p, px, py))
    if (hit === null) return null
    const coord = rig.surface.coordAt(hit.point, hit.location)
    const lon = blendModelApplies(rig.surface)
      ? worldLonToTextureLon(coord.lonDeg, rig.rotationOffsetDeg)
      : coord.lonDeg
    const tex = coordToUv({ latDeg: coord.latDeg, lonDeg: lon })
    return [tex.u, 1 - tex.v]
  }

  /**
   * `truth`, plus the blend weight sphere-sim's exporter would write for
   * the same ray — its `coverageAndWeights` share times the polar mask, as
   * `buildWarpExport` computes a node's intensity.
   */
  function traced(rig: SphereSimRig, index: number, px: number, py: number): [number, number, number] | null {
    const tex = truth(rig, index, px, py)
    if (tex === null) return null
    const p = rig.projectors[index]
    const hit = rig.surface.intersect(p.lens, pixelToRay(p, px, py)) as Hit
    const coord = rig.surface.coordAt(hit.point, hit.location)
    const mask = blendModelApplies(rig.surface) ? polarMask(coord.latDeg, rig.blend, 'latitude') : 1
    return [tex[0], tex[1], coverageAndWeights(hit.point, hit.normal, rig, hit.location).weights[index] * mask]
  }

  function insideTriangle(t: [number, number][], x: number, y: number): boolean {
    const det = (t[1][1] - t[2][1]) * (t[0][0] - t[2][0]) + (t[2][0] - t[1][0]) * (t[0][1] - t[2][1])
    const l0 = ((t[1][1] - t[2][1]) * (x - t[2][0]) + (t[2][0] - t[1][0]) * (y - t[2][1])) / det
    const l1 = ((t[2][1] - t[0][1]) * (x - t[2][0]) + (t[0][0] - t[2][0]) * (y - t[2][1])) / det
    return l0 >= 0 && l1 >= 0 && 1 - l0 - l1 >= 0
  }

  const rigs: {
    name: string
    file: string
    projectorId: string
    resX: number
    resY: number
    samples: number[][]
    silhouette: number[][]
    band: number[][]
    zeroLine: number[][]
  }[] = []

  const cases: { name: string; rig: SphereSimRig; projectorId: string }[] = [
    { name: 'boulder', rig: prepareRig(buildWorld(BOULDER_PRESET).compositorRig), projectorId: 'P3' },
    {
      name: 'placed-pole',
      rig: prepareRig(placedRig({ projectors: [{ position: { x: 2.5, y: 0, z: 2.0 } }] })),
      projectorId: 'P1',
    },
  ]

  mkdirSync(OUT_DIR, { recursive: true })
  for (const { name, rig, projectorId } of cases) {
    const index = rig.projectors.findIndex((p) => p.cal.id === projectorId)
    const exported = buildWarpExports(rig)[index]
    const { resX, resY } = rig.projectors[index].cal.intrinsics
    const { cols, rows, nodes } = exported
    const file = `${name}-${projectorId}.data`
    writeFileSync(join(OUT_DIR, file), formatWarpMesh(exported))

    const valid = (n: SphereSimNode): boolean => n.intensity >= 0
    const at = (i: number, j: number): SphereSimNode => nodes[j * cols + i]
    const pixelOf = (i: number, j: number): [number, number] => [
      (i / (cols - 1)) * resX,
      (j / (rows - 1)) * resY,
    ]
    // Chebyshev distance, in cells, from a cell to the nearest no-data node —
    // the ring measure the plan's per-ring numbers were taken with.
    const noData: [number, number][] = []
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (!valid(at(i, j))) noData.push([i, j])
    const ringOf = (i: number, j: number): number => {
      let best = Infinity
      for (const [ii, jj] of noData) {
        best = Math.min(best, Math.max(Math.abs(ii - i), Math.abs(jj - j), Math.abs(ii - i - 1), Math.abs(jj - j - 1)))
      }
      return best
    }

    const samples: number[][] = []
    const errorsByRing = new Map<number, number[]>()
    const seamErrors: number[] = []
    const poleErrors: number[] = []
    // What a stock Bourke player gets on the same points: (u, v) interpolated
    // with u unwrapped per triangle — the contrast the test pins.
    const naiveSeam: number[] = []
    const naivePole: number[] = []
    let ringSeen = 0
    let interiorSeen = 0
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const corners: [number, number][] = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]
        if (!corners.every(([ci, cj]) => valid(at(ci, cj)))) continue
        const ring = ringOf(i, j)
        for (const tri of [[0, 1, 2], [1, 3, 2]]) {
          const t = tri.map((k) => corners[k])
          const n = t.map(([ci, cj]) => at(ci, cj))
          const us = n.map((m) => m.u)
          const seam = Math.max(...us) - Math.min(...us) > 0.5
          let wind = 0
          for (let k = 0; k < 3; k++) {
            let du = n[(k + 1) % 3].u - n[k].u
            du -= Math.round(du)
            wind += du
          }
          const pole = Math.abs(wind) > 0.5
          const special = seam || pole
          const near = ring <= 3
          const sampled = special ||
            (near ? ringSeen++ % RING_STRIDE === 0 : interiorSeen++ % INTERIOR_STRIDE === 0)

          const px = t.map(([ci, cj]) => pixelOf(ci, cj))
          const d = n.map((m) => dir(m.u, m.v))
          const edge = (a: number, b: number): number =>
            (angle(d[a], d[b]) * DEG) / Math.hypot(px[b][0] - px[a][0], px[b][1] - px[a][1])
          const degPerPx = (edge(0, 1) + edge(1, 2) + edge(0, 2)) / 3
          const unwrapped = us.map((u) => u - Math.round(u - us[0]))
          // The survey covers every triangle at all five points; the fixture
          // keeps the special ones whole and the centroid of a stride of the rest.
          FIVE_POINTS.forEach((w, pointIndex) => {
            const x = w[0] * px[0][0] + w[1] * px[1][0] + w[2] * px[2][0]
            const y = w[0] * px[0][1] + w[1] * px[1][1] + w[2] * px[2][1]
            const tex = truth(rig, index, x, y)
            if (tex === null) return
            const target = dir(tex[0], tex[1])
            const interp = normalize([0, 1, 2].map((c) => w[0] * d[0][c] + w[1] * d[1][c] + w[2] * d[2][c]) as V3)
            const errPx = (angle(interp, target) * DEG) / degPerPx
            const bucket = Math.min(ring, 4)
            errorsByRing.set(bucket, [...(errorsByRing.get(bucket) ?? []), errPx])
            if (special) {
              const nu = w[0] * unwrapped[0] + w[1] * unwrapped[1] + w[2] * unwrapped[2]
              const nv = w[0] * n[0].v + w[1] * n[1].v + w[2] * n[2].v
              const naivePx = (angle(dir(nu, nv), target) * DEG) / degPerPx
              ;(pole ? poleErrors : seamErrors).push(errPx)
              ;(pole ? naivePole : naiveSeam).push(naivePx)
            }
            if (sampled && (special || pointIndex === 0)) {
              samples.push([round(x, 3), round(y, 3), round(tex[0], 7), round(tex[1], 7)])
            }
          })
        }
      }
    }

    // The silhouette, as the header describes: each edge's crossing as a
    // fraction of it from the good node, then the band's traced samples.
    const silhouette: number[][] = []
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!valid(at(i, j))) continue
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [bi, bj] = [i + di, j + dj]
          if (bi < 0 || bj < 0 || bi >= cols || bj >= rows || valid(at(bi, bj))) continue
          const [ax, ay] = pixelOf(i, j)
          const [bx, by] = pixelOf(bi, bj)
          let lo = 0
          let hi = 1
          for (let k = 0; k < 40; k++) {
            const m = (lo + hi) / 2
            if (truth(rig, index, ax + (bx - ax) * m, ay + (by - ay) * m) !== null) lo = m
            else hi = m
          }
          silhouette.push([i, j, di, dj, round(lo, 5)])
        }
      }
    }
    const band: number[][] = []
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const good = ([[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]] as [number, number][]).filter(([ci, cj]) =>
          valid(at(ci, cj)),
        )
        if (good.length === 0 || good.length === 4) continue
        // Three good corners' triangle is drawn by any player; fewer, nothing.
        const drawn = good.length === 3 ? good.map(([ci, cj]) => pixelOf(ci, cj)) : null
        for (let b = 0; b < 4; b++) {
          for (let a = 0; a < 4; a++) {
            const x = ((i + (a + 0.5) / 4) / (cols - 1)) * resX
            const y = ((j + (b + 0.5) / 4) / (rows - 1)) * resY
            if (drawn !== null && insideTriangle(drawn, x, y)) continue
            const t = traced(rig, index, x, y)
            if (t !== null) band.push([round(x, 3), round(y, 3), round(t[0], 7), round(t[1], 7), round(t[2], 5)])
          }
        }
      }
    }

    // The blend's own zero line, which a node written 0 cannot place either:
    // for every grid edge from a drawn node the exporter weighted 0 to a
    // lit neighbour, where along it the traced weight first rises above 0.
    const zeroLine: number[][] = []
    const weightAt = (x: number, y: number): number => traced(rig, index, x, y)?.[2] ?? 0
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!valid(at(i, j)) || at(i, j).intensity !== 0) continue
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const [pi, pj] = [i + di, j + dj]
          if (pi < 0 || pj < 0 || pi >= cols || pj >= rows || !valid(at(pi, pj)) || !(at(pi, pj).intensity > 0)) continue
          const [zx, zy] = pixelOf(i, j)
          const [px, py] = pixelOf(pi, pj)
          let lo = 0
          let hi = 1
          for (let k = 0; k < 40; k++) {
            const m = (lo + hi) / 2
            if (weightAt(zx + (px - zx) * m, zy + (py - zy) * m) > 0) hi = m
            else lo = m
          }
          zeroLine.push([i, j, di, dj, round((lo + hi) / 2, 5)])
        }
      }
    }

    rigs.push({ name, file, projectorId, resX, resY, samples, silhouette, band, zeroLine })
    const summary = (a: number[]): string => {
      const s = [...a].sort((p, q) => p - q)
      return s.length === 0
        ? 'none'
        : `n ${s.length}, median ${s[s.length >> 1].toFixed(2)} px, max ${s[s.length - 1].toFixed(2)} px`
    }
    console.log(`${name} ${projectorId}: ${cols}x${rows}, ${samples.length} samples written`)
    for (const ring of [...errorsByRing.keys()].sort((p, q) => p - q)) {
      const label = ring === 4 ? 'ring >= 4 (interior)' : `ring ${ring}`
      console.log(`  directions, ${label}: ${summary(errorsByRing.get(ring) ?? [])}`)
    }
    console.log(`  seam triangles: directions ${summary(seamErrors)} | unwrapped (u, v) ${summary(naiveSeam)}`)
    console.log(`  pole triangles: directions ${summary(poleErrors)} | unwrapped (u, v) ${summary(naivePole)}`)
    const past = silhouette.map((e) => e[4]).sort((p, q) => p - q)
    const light = band.reduce((sum, b) => sum + b[4], 0)
    console.log(
      `  silhouette: ${silhouette.length} edges, a median ${past[past.length >> 1].toFixed(2)} of a cell past the last node;` +
        ` ${band.length} band samples a staircase leaves black, weight sum ${light.toFixed(1)}`,
    )
    const rise = zeroLine.map((e) => e[4]).sort((p, q) => p - q)
    console.log(
      rise.length === 0
        ? '  zero line: none — no drawn node weighted 0 beside a lit one'
        : `  zero line: ${zeroLine.length} edges, the weight rising a median ${rise[rise.length >> 1].toFixed(2)} of a cell past the 0 node`,
    )
  }

  // Convention 3: a sphere rig's mechanical rotation is baked into `u`
  // (`worldLonToTextureLon`), so the mesh alone must land where the
  // tracer says, and an output that also applied the rig's rotation as
  // its content rotation would land that far out. Boulder's rotation is
  // 0 and cannot tell the two apart; SOS's nominal rig turned 30° can.
  // 21×21 and interior cells only, because what this witnesses is tens
  // of degrees, not pixels — the coarse grid keeps the fixture small.
  const { nominalRig } = await load<{ nominalRig(p: { rotationOffsetDeg?: number }): unknown }>('packages/sim/src/scene.ts')
  const ROTATION_DEG = 30
  const turned = prepareRig(nominalRig({ rotationOffsetDeg: ROTATION_DEG }))
  const turnedIndex = turned.projectors.findIndex((p) => p.cal.id === 'P3')
  const turnedExport = buildWarpExports(turned, { cols: 21, rows: 21 })[turnedIndex]
  const turnedFile = `nominal-rot${ROTATION_DEG}-P3.data`
  writeFileSync(join(OUT_DIR, turnedFile), formatWarpMesh(turnedExport))
  const turnedSamples: number[][] = []
  {
    const { cols, rows, nodes } = turnedExport
    const { resX, resY } = turned.projectors[turnedIndex].cal.intrinsics
    const valid = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < cols && j < rows && nodes[j * cols + i].intensity >= 0
    let seen = 0
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        // Two cells in from any no-data node on every side: interior.
        let interior = true
        for (let dj = -2; dj <= 3 && interior; dj++) for (let di = -2; di <= 3 && interior; di++) interior = valid(i + di, j + dj)
        if (!interior || seen++ % 3 !== 0) continue
        const x = ((i + 0.5) / (cols - 1)) * resX
        const y = ((j + 0.5) / (rows - 1)) * resY
        const tex = truth(turned, turnedIndex, x, y)
        if (tex !== null) turnedSamples.push([round(x, 3), round(y, 3), round(tex[0], 7), round(tex[1], 7)])
      }
    }
  }
  console.log(`rotated ${ROTATION_DEG}° P3: 21x21, ${turnedSamples.length} interior samples written`)

  const parity = {
    provenance: {
      generator: 'scripts/generate-warp-parity-fixtures.ts',
      sphereSimCommit: commit,
      note:
        'Meshes are formatWarpMesh output; samples are [px, py, u, v] with px/py raster ' +
        'pixels (y down, corner-to-corner as buildWarpExport spaces its nodes) and u/v the ' +
        "texel sphere-sim's tracer puts there, v up. silhouette is [i, j, di, dj, t]: the " +
        'grid edge from node (i, j), which reaches the surface, to its neighbour (i + di, ' +
        "j + dj), which does not, and t the fraction of it at which the tracer's rays stop " +
        'hitting. band is [px, py, u, v, w] at points in the cells the silhouette crosses ' +
        'that complete triangles leave black, w the weight the exporter would write there. ' +
        'zeroLine is [i, j, di, dj, t]: the grid edge from drawn node (i, j), which the exporter ' +
        'weighted 0, to its lit neighbour (i + di, j + dj), and t the fraction of it at which the ' +
        'traced weight first rises above 0. Regenerate rather than edit.',
    },
    sosQuadrantViewports: SOS_QUADRANT_VIEWPORTS.map((vp, i) => ({ id: `P${i + 1}`, ...vp })),
    rigs,
    rotated: {
      name: 'nominal-rot30',
      file: turnedFile,
      projectorId: 'P3',
      rotationOffsetDeg: ROTATION_DEG,
      resX: turned.projectors[turnedIndex].cal.intrinsics.resX,
      resY: turned.projectors[turnedIndex].cal.intrinsics.resY,
      samples: turnedSamples,
    },
  }
  // One sample per line: pretty-printing puts every number on its own line
  // and triples the file for nothing a reviewer reads.
  const json = JSON.stringify(parity, null, 1)
    .replace(
      /\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g,
      '[$1, $2, $3, $4, $5]',
    )
    .replace(/\[\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+),\n\s+(-?[\d.]+)\n\s+\]/g, '[$1, $2, $3, $4]')
  writeFileSync(join(OUT_DIR, 'parity.json'), `${json}\n`)

  // A whole bundle as sphere-sim's page writes one, for the ZIP reader:
  // its own `bundleEntries` and `buildZip`, at a coarse grid so the archive
  // is a few kilobytes — what it tests is the container, not the mesh. It
  // carries a restore point holding an OLDER `warp/P1.data`, a 4×4 export,
  // which is the one entry a careless reader would take for a mesh: the
  // same format under the same file name, one directory down.
  const { buildSosAlignments, formatSosAlignment } = await load<{
    buildSosAlignments(truth: SphereSimRig, compositor: SphereSimRig): { projectorId: string; alignment: unknown }[]
    formatSosAlignment(a: unknown): string
  }>('packages/sim/src/sos.ts')
  const { bundleEntries, projectorLayout } = await load<{
    bundleEntries(input: unknown): unknown[]
    projectorLayout(rig: unknown, texture: unknown, meshes: readonly string[]): unknown
  }>('packages/web/src/bundle.ts')
  const { warpTexture } = await load<{ warpTexture(rig: SphereSimRig): unknown }>('packages/sim/src/warp.ts')
  const { buildZip } = await load<{ buildZip(entries: unknown[]): Uint8Array }>('packages/web/src/zip.ts')
  const { planRestore } = await load<{
    planRestore(targets: { path: string; kind: string }[], held: { path: string; bytes: Uint8Array }[]): unknown
  }>('packages/web/src/restore.ts')
  const world = buildWorld(BOULDER_PRESET)
  const truthRig = prepareRig(world.truthRig)
  const contentRig = prepareRig(world.compositorRig)
  const warp = buildWarpExports(contentRig, { cols: 5, rows: 5 }).map((e) => [e.projectorId, formatWarpMesh(e)] as const)
  const alignment = buildSosAlignments(truthRig, contentRig).map(
    (e) => [e.projectorId, formatSosAlignment(e.alignment)] as const,
  )
  const older = formatWarpMesh(buildWarpExports(contentRig, { cols: 4, rows: 4 })[0])
  const targets = [
    ...warp.map(([id]) => ({ path: `warp/${id}.data`, kind: 'warp' })),
    ...alignment.map(([id]) => ({ path: `alignment/${id}.alignment`, kind: 'alignment' })),
  ]
  const restore = planRestore(targets, [{ path: 'warp/P1.data', bytes: new TextEncoder().encode(older) }])
  // The layout exactly as the page builds it (sphere-sim#52): from the raw
  // rig the meshes were traced on, the texture that rig's bake reads, and
  // the ids of the meshes the archive carries, in their order.
  const layout = projectorLayout(
    world.compositorRig,
    warpTexture(contentRig),
    warp.map(([id]) => id),
  )
  const entries = bundleEntries({
    warp,
    layout,
    alignment,
    config: null,
    configName: 'local_sos_config.json',
    alignmentCost: '',
    rigSummary: `${warp.length} projectors, as the install describes them.`,
    restore,
  })
  writeFileSync(join(OUT_DIR, 'sphere-sim-bundle.zip'), buildZip(entries))
  console.log(`bundle: ${entries.length} entries, ${warp.length} meshes at 5x5, an older P1 at 4x4 under restore/`)
  // The same archive with no layout, as sphere-sim writes one when its
  // layout was refused — and, to the reader, as every bundle exported
  // before sphere-sim#52 looks. Those exist, and the import has to ask.
  const bare = bundleEntries({
    warp,
    layout: null,
    alignment,
    config: null,
    configName: 'local_sos_config.json',
    alignmentCost: '',
    rigSummary: `${warp.length} projectors, as the install describes them.`,
    restore,
  })
  writeFileSync(join(OUT_DIR, 'sphere-sim-bundle-no-layout.zip'), buildZip(bare))

  // A placed pair, the rig the layout exists for: sphere-sim names its
  // projectors P1 and P2 and splits the framebuffer into halves at full
  // height, where SOS's quadrants would put the same two ids in the bottom
  // row. The page does not export a placed rig yet, so this bundle is its
  // own builders applied to one — the case sphere-sim pins at the builder.
  const placedRaw = placedRig({
    projectors: [{ position: { x: 2.5, y: 0, z: 0 } }, { position: { x: -2.5, y: 0, z: 0 } }],
  })
  const placedPrepared = prepareRig(placedRaw)
  const placedWarp = buildWarpExports(placedPrepared, { cols: 5, rows: 5 }).map(
    (e) => [e.projectorId, formatWarpMesh(e)] as const,
  )
  const placedEntries = bundleEntries({
    warp: placedWarp,
    layout: projectorLayout(placedRaw, warpTexture(placedPrepared), placedWarp.map(([id]) => id)),
    alignment: [],
    config: null,
    configName: 'local_sos_config.json',
    alignmentCost: '',
    rigSummary: `${placedWarp.length} placed projectors.`,
    restore: planRestore(
      placedWarp.map(([id]) => ({ path: `warp/${id}.data`, kind: 'warp' })),
      [],
    ),
  })
  writeFileSync(join(OUT_DIR, 'sphere-sim-placed-bundle.zip'), buildZip(placedEntries))
  console.log(`placed bundle: ${placedEntries.length} entries, ${placedWarp.length} meshes at 5x5`)
  console.log(`wrote ${OUT_DIR} (sphere-sim ${commit.slice(0, 7)})`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
