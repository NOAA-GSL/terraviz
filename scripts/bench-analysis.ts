/**
 * Benchmark the CPU half of the data-analysis path, at real frame size.
 *
 * `docs/DATA_ANALYSIS_PLAN.md`'s surfaces all read one frame back and
 * reduce it on the main thread. This measures what that costs, so
 * decisions about workers, async readback and playback-tracking rest on
 * numbers instead of on intuition about where the time goes.
 *
 *     npm run bench:analysis
 *     npm run bench:analysis -- --size 2048x1024 --field turbulent
 *
 * ## What this measures, and what it cannot
 *
 * Measured: the reducers, the contour extractor, the readback's CPU
 * tail, and worker handoff. All of it is pure JS over a `Uint8Array` —
 * byte for byte the code that runs in the browser.
 *
 * **Not measured: the `readPixels` GPU→CPU sync stall**, or the
 * `PIXEL_PACK_BUFFER` + `fenceSync` alternative to it. That needs real
 * hardware. Under a software rasteriser there is no pipeline to stall,
 * so a bench here would report the two as identical and be believed.
 *
 * ## Read the ratios, not the absolutes
 *
 * Node on a CI box is not a browser on a laptop. When this was first
 * run, its turbulent field at 12 levels emitted *more* vertices than
 * the real RRFS frame measured for PR #342 (85.0k vs 73.2k) and still
 * finished in under half the time (178 ms vs 376 ms) — same code, more
 * work, faster machine. The shape of the cost transfers; the
 * milliseconds do not.
 */

import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

import {
  areaAboveKm2,
  buildHistogram,
  findExtremum,
  summarize,
  zonalMeans,
  type LumaSnapshot,
} from '../src/services/datasetStats'
import { extractContourSet } from '../src/services/datasetContours'
import type { ColorScale } from '../src/types/color-scale'
import type { DatasetOverlayOptions } from '../src/types'

// --- options ---------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const [W, H] = flag('size', '4096x2048').split('x').map(Number)
const FIELDS = flag('field', 'both')
const N = W * H

if (!Number.isInteger(W) || !Number.isInteger(H) || W < 2 || H < 2) {
  console.error('--size must be WxH, e.g. 4096x2048')
  process.exit(1)
}

/** The shipped smoke palette's shape: a low absent band, then a ramp. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 0.5, rgba: [254, 153, 41, 128] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 0.0005,
  units: 'kg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the live RRFS rows carry, so the row-area weighting is
 *  exercised over a real latitude span rather than a global one. */
const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
}

const FIRST_DATA_CODE = 12

// --- synthetic frames ------------------------------------------------
//
// Sparsity is tuned to the figure in `lumaAtDataQuantile`'s docstring:
// 88% of a published RRFS smoke frame is absent data. That number is
// load-bearing here — the contour walk exits early on any cell no level
// crosses, so a denser frame overstates the cost and a sparser one
// flatters it.

/** Smooth Gaussian plumes: the optimistic end of the bracket. */
function smoothFrame(): Uint8Array {
  const data = new Uint8Array(N)
  const blobs = [
    { cx: 0.28, cy: 0.42, r: 0.075, amp: 1.0 },
    { cx: 0.55, cy: 0.3, r: 0.05, amp: 0.75 },
    { cx: 0.7, cy: 0.62, r: 0.09, amp: 0.55 },
    { cx: 0.4, cy: 0.7, r: 0.04, amp: 0.9 },
    { cx: 0.85, cy: 0.2, r: 0.035, amp: 0.6 },
  ]
  for (let y = 0; y < H; y++) {
    const v = y / H
    for (let x = 0; x < W; x++) {
      const u = x / W
      let acc = 0
      for (const b of blobs) {
        const dx = u - b.cx
        const dy = v - b.cy
        const d2 = (dx * dx + dy * dy) / (b.r * b.r)
        if (d2 < 9) acc += b.amp * Math.exp(-d2)
      }
      const t = Math.pow(Math.min(1, acc), 2.2)
      data[y * W + x] = t < 0.06 ? 0 : Math.min(255, FIRST_DATA_CODE + Math.round(t * 243))
    }
  }
  return data
}

/**
 * The same coverage with structure — multi-octave value noise modulating
 * the plumes. The realistic end of the bracket, and the one to quote.
 *
 * Contour cost scales with how much *perimeter* the levels cut, not with
 * how many texels carry data, so smooth blobs and a turbulent field at
 * identical coverage are not the same workload at all. Real smoke is
 * turbulent.
 */
function turbulentFrame(): Uint8Array {
  const data = new Uint8Array(N)
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
  const ease = (t: number): number => t * t * (3 - 2 * t)
  const noise = (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = ease(x - xi)
    const yf = ease(y - yi)
    return lerp(
      lerp(hash(xi, yi), hash(xi + 1, yi), xf),
      lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), xf),
      yf,
    )
  }
  const blobs = [
    { cx: 0.28, cy: 0.42, r: 0.11, amp: 1.0 },
    { cx: 0.55, cy: 0.3, r: 0.07, amp: 0.75 },
    { cx: 0.7, cy: 0.62, r: 0.13, amp: 0.55 },
  ]
  for (let y = 0; y < H; y++) {
    const v = y / H
    for (let x = 0; x < W; x++) {
      const u = x / W
      let env = 0
      for (const b of blobs) {
        const dx = u - b.cx
        const dy = v - b.cy
        const d2 = (dx * dx + dy * dy) / (b.r * b.r)
        if (d2 < 9) env += b.amp * Math.exp(-d2)
      }
      if (env <= 0) {
        data[y * W + x] = 0
        continue
      }
      let n = 0
      let amp = 0.5
      let freq = 24
      for (let o = 0; o < 5; o++) {
        n += amp * noise(u * freq, v * freq)
        amp *= 0.5
        freq *= 2
      }
      const t = Math.pow(Math.min(1, env * n * 2.2), 1.8)
      data[y * W + x] = t < 0.09 ? 0 : Math.min(255, FIRST_DATA_CODE + Math.round(t * 243))
    }
  }
  return data
}

// --- harness ---------------------------------------------------------

/** Median of `runs` timed calls, after one warm-up. Median rather than
 *  mean because a single GC pause otherwise sets the headline. */
function bench(label: string, runs: number, fn: () => unknown): void {
  fn()
  const times: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const lo = times[0].toFixed(1)
  const hi = times[times.length - 1].toFixed(1)
  console.log(`  ${label.padEnd(44)}${median.toFixed(1).padStart(8)} ms   (${lo}–${hi})`)
}

function absentPercent(data: Uint8Array): number {
  let absent = 0
  for (let i = 0; i < data.length; i++) if (data[i] < FIRST_DATA_CODE) absent++
  return (absent / data.length) * 100
}

function main(): void {
  console.log(`\nFrame ${W}×${H} = ${(N / 1e6).toFixed(1)}M texels`)
  console.log('Absolutes are this machine; read the ratios.\n')

  const smooth = { data: smoothFrame(), width: W, height: H } satisfies LumaSnapshot
  const turbulent = { data: turbulentFrame(), width: W, height: H } satisfies LumaSnapshot

  const wanted: [string, LumaSnapshot][] = []
  if (FIELDS === 'both' || FIELDS === 'smooth') wanted.push(['SMOOTH plumes', smooth])
  if (FIELDS === 'both' || FIELDS === 'turbulent') wanted.push(['TURBULENT field', turbulent])
  if (!wanted.length) {
    console.error('--field must be one of: both, smooth, turbulent')
    process.exit(1)
  }

  // Reducers are O(texels) and visit every one regardless of structure,
  // so a single field settles them.
  const [, primary] = wanted[wanted.length - 1]
  console.log(`REDUCERS — whole frame (${absentPercent(primary.data).toFixed(1)}% absent)`)
  bench('buildHistogram', 5, () => buildHistogram(primary, SCALE, OPTIONS))
  bench('summarize (builds its own histogram)', 5, () => summarize(primary, SCALE, OPTIONS))
  bench('zonalMeans', 5, () => zonalMeans(primary, SCALE, OPTIONS))
  bench('findExtremum', 5, () => findExtremum(primary, SCALE, 'max', OPTIONS))
  const hist = buildHistogram(primary, SCALE, OPTIONS)
  bench('areaAboveKm2 (over a built histogram)', 5, () => areaAboveKm2(hist, SCALE, 0.0001))

  // Contours are structure-dependent, so both ends of the bracket.
  const span = SCALE.vmax - SCALE.vmin
  const levelsFor = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => SCALE.vmin + ((i + 1) / (n + 1)) * span)

  for (const [name, snap] of wanted) {
    console.log(`\nCONTOURS — ${name} (${absentPercent(snap.data).toFixed(1)}% absent)`)
    for (const n of [1, 6, 12, 24]) {
      const levels = levelsFor(n)
      const result = extractContourSet(snap, SCALE, levels, OPTIONS)
      const verts = result.reduce(
        (a, lvl) => a + lvl.lines.reduce((b, line) => b + line.length, 0),
        0,
      )
      bench(`${String(n).padStart(2)} level(s)  [${String(verts).padStart(7)} verts]`, 3, () =>
        extractContourSet(snap, SCALE, levels, OPTIONS))
    }
  }

  // What `glLumaSampler.snapshot` pays *after* readPixels returns. The
  // de-interleave only runs on the RGBA fallback path, taken when the
  // driver will not read an R8 attachment back.
  console.log('\nREADBACK CPU TAIL (after readPixels; the stall itself needs a GPU)')
  const rgba = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) rgba[i * 4] = primary.data[i]
  bench('RGBA→R8 de-interleave (fallback path)', 5, () => {
    const out = new Uint8Array(N)
    for (let i = 0; i < N; i++) out[i] = rgba[i * 4]
    return out
  })
  bench('allocate RGBA staging buffer', 5, () => new Uint8Array(N * 4))
  bench('allocate R8 buffer', 5, () => new Uint8Array(N))

  void benchWorkerHandoff(primary.data)
}

/**
 * What it costs to hand a frame to a worker.
 *
 * The reducers are already pure functions over `(snapshot, scale,
 * options, window)` with no DOM, GL or fetch, and `LumaSnapshot.data` is
 * a transferable `Uint8Array` — so this is the price of moving the whole
 * reduce off the main thread. Transferred against cloned, because
 * forgetting the transfer list is the one mistake that would make the
 * worker slower than doing the work inline.
 */
async function benchWorkerHandoff(data: Uint8Array): Promise<void> {
  console.log('\nWORKER HANDOFF (can the reduce move off the main thread cheaply?)')
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads');" +
      'parentPort.on("message", (m) => parentPort.postMessage(m.byteLength))',
    { eval: true },
  )
  const roundTrip = (transfer: boolean): Promise<number> =>
    new Promise((resolve) => {
      const copy = data.slice()
      const t0 = performance.now()
      worker.once('message', () => resolve(performance.now() - t0))
      worker.postMessage(copy, transfer ? [copy.buffer] : [])
    })

  const median = async (transfer: boolean): Promise<number> => {
    const times: number[] = []
    for (let i = 0; i < 5; i++) times.push(await roundTrip(transfer))
    times.sort((a, b) => a - b)
    return times[2]
  }

  const mb = (N / 1e6).toFixed(1)
  console.log(`  ${`${mb} MB transferred (zero-copy)`.padEnd(44)}${(await median(true)).toFixed(1).padStart(8)} ms   round trip`)
  console.log(`  ${`${mb} MB structured-cloned (copied)`.padEnd(44)}${(await median(false)).toFixed(1).padStart(8)} ms   round trip`)
  await worker.terminate()
  console.log()
}

main()
