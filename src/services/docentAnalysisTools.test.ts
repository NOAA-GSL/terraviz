/**
 * Tests for the executors behind Orbit's value answers.
 *
 * Two things are load-bearing and neither is obvious from reading the
 * happy path:
 *
 *   1. **The availability gate.** These tools exist to let Orbit state
 *      numbers, and the prompt otherwise forbids exactly that. If the
 *      gate leaks — a picture dataset, a browser with no WebGL2, a
 *      dataset mid-load — the tools are offered with nothing behind
 *      them, and the failure mode is Orbit confidently answering from
 *      training-time knowledge. So the gate is asserted, not assumed.
 *   2. **Absent data must not read as a low value.** A smoke field is
 *      mostly empty; a `noData` point that returns `vmin` produces "the
 *      smoke there is very light" for somewhere the dataset says
 *      nothing at all.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  executeFindExtremum,
  executeProbeValue,
  executeSummarizeRegion,
  isAnalysisAvailable,
  registerAnalysisSource,
  type DocentAnalysisSource,
} from './docentAnalysisTools'
import type { LumaSnapshot } from './glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'

/** vmin 0 / vmax 255 makes luma and value numerically equal, so an
 *  expectation can be read straight off the fixture. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the live RRFS rows carry. */
const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
  colorScale: SCALE,
}

function snap(w: number, h: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return { data, width: w, height: h }
}

function makeSource(over: Partial<DocentAnalysisSource> = {}): DocentAnalysisSource {
  return {
    frame: () => ({ snapshot: snap(8, 8, () => 200), scale: SCALE, options: OPTIONS }),
    datasetTitle: () => 'Wildfire Smoke Overhead',
    visibleBounds: () => ({ n: 85, s: 5, w: -175, e: -20 }),
    ...over,
  }
}

beforeEach(() => registerAnalysisSource(null))

describe('isAnalysisAvailable', () => {
  it('is false with nothing registered', () => {
    expect(isAnalysisAvailable()).toBe(false)
  })

  it('is false for a dataset with no frame — a picture, or no WebGL2', () => {
    // The single call covers every reason: a picture row has no
    // colorScale, a browser without WebGL2 has no sampler, and a
    // dataset mid-load has no decoded frame. All three arrive here as
    // a null frame.
    registerAnalysisSource(makeSource({ frame: () => null }))
    expect(isAnalysisAvailable()).toBe(false)
  })

  it('is true once a data-encoded frame is readable', () => {
    registerAnalysisSource(makeSource())
    expect(isAnalysisAvailable()).toBe(true)
  })

  it('is false rather than throwing when the source is mid-teardown', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerAnalysisSource(makeSource({ frame: () => { throw new Error('renderer gone') } }))
    expect(isAnalysisAvailable()).toBe(false)
    warn.mockRestore()
  })

  it('every executor refuses when unavailable, not just the gate', () => {
    // Belt and braces: the gate keeps the tools out of the array, but
    // a model that calls one anyway (a stale tool id in history, a
    // provider replaying a call) must not reach a null frame.
    registerAnalysisSource(null)
    expect(executeProbeValue({ lat: 40, lon: -105 }).ok).toBe(false)
    expect(executeSummarizeRegion({}).ok).toBe(false)
    expect(executeFindExtremum({}).ok).toBe(false)
  })
})

describe('executeProbeValue', () => {
  it('reports the value at a point inside coverage', () => {
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 45, lon: -100 })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(200, 6)
    expect(r.units).toBe('mg m-2')
    expect(r.dataset).toBe('Wildfire Smoke Overhead')
    expect(r.precision).toMatch(/quantised/i)
  })

  it('distinguishes "no data here" from "outside coverage"', () => {
    // Two different sentences. Absent data inside the box is a real
    // answer about a covered place; outside the box the dataset has no
    // opinion at all, and conflating them tells a user the field is
    // empty somewhere it was never measured.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(8, 8, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    const inside = executeProbeValue({ lat: 45, lon: -100 })
    expect(inside.ok).toBe(true)
    expect(inside.noData).toBe(true)

    const outside = executeProbeValue({ lat: -45, lon: -100 })
    expect(outside.ok).toBe(false)
    expect(outside.error).toMatch(/coverage/i)
  })

  it('rejects a missing or unparseable coordinate', () => {
    registerAnalysisSource(makeSource())
    expect(executeProbeValue({}).ok).toBe(false)
    expect(executeProbeValue({ lat: 'north', lon: -100 }).ok).toBe(false)
  })

  it('rounds to three significant digits, like the hover readout', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(1, 1, () => 137),
        scale: { ...SCALE, vmax: 1 },
        options: { ...OPTIONS, colorScale: { ...SCALE, vmax: 1 } },
      }),
    }))
    const r = executeProbeValue({ lat: 45, lon: -100 })
    // 137/255 = 0.537254901…; the transport cannot resolve past the
    // third digit, so neither does the answer.
    expect(r.value).toBeCloseTo(0.537, 9)
  })
})

describe('executeSummarizeRegion', () => {
  it('summarises the whole dataset by default', () => {
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(true)
    expect(r.region).toMatch(/whole dataset/i)
    expect(r.mean).toBeCloseTo(200, 6)
    expect(r.coverage).toBeCloseTo(1, 6)
  })

  it('narrows to a named region from the same table Orbit already uses', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (_x, y) => (y < 4 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const whole = executeSummarizeRegion({})
    const alaska = executeSummarizeRegion({ region_name: 'alaska' })
    expect(alaska.ok).toBe(true)
    expect(alaska.region).toBe('Alaska')
    expect(alaska.mean).not.toBeCloseTo(whole.mean!, 6)
  })

  it('errors on a region it cannot place, rather than answering about everywhere', () => {
    // The quietly wrong alternative: fall back to the whole dataset and
    // return statistics labelled with a region they do not describe.
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({ region_name: 'Mordor' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unknown region/i)
    expect(r.mean).toBeUndefined()
  })

  it('accepts an explicit bbox', () => {
    registerAnalysisSource(makeSource())
    const r = executeSummarizeRegion({ bbox: { north: 60, south: 40, west: -120, east: -90 } })
    expect(r.ok).toBe(true)
    expect(r.mean).toBeCloseTo(200, 6)
  })

  it('says so in prose when coverage is too low for a bare mean', () => {
    // A mean over 6% of a box is a different claim from a mean over all
    // of it, and the model needs words it can repeat, not a flag.
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(4, 4, (x, y) => (x === 0 && y === 0 ? 200 : 0)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(true)
    expect(r.coverage).toBeCloseTo(0.0625, 4)
    expect(r.caveat).toMatch(/6%/)
  })

  it('reports an empty region as empty rather than as zero', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeSummarizeRegion({})
    expect(r.ok).toBe(false)
    expect(r.mean).toBeUndefined()
  })
})

describe('executeFindExtremum', () => {
  it('locates the maximum and says where it is', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (x, y) => (x === 6 && y === 1 ? 250 : 100)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(250, 6)
    // Inside the dataset's own box, which is the only claim worth
    // pinning — the exact lat/lon is datasetProbe's contract, tested
    // there against its inverse.
    expect(r.lat!).toBeGreaterThan(5)
    expect(r.lat!).toBeLessThan(85)
    expect(r.lon!).toBeGreaterThan(-175)
    expect(r.lon!).toBeLessThan(-20)
    expect(r.precision).toMatch(/quantised/i)
  })

  it('finds the minimum among data, not the absent band', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (x, y) => (x === 2 && y === 2 ? 30 : x < 4 ? 0 : 150)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'min' })
    expect(r.ok).toBe(true)
    expect(r.value).toBeCloseTo(30, 6)
  })

  it('defaults to the maximum, which is what the question usually means', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(4, 4, (x) => (x === 0 ? 20 : 220)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    expect(executeFindExtremum({}).value).toBeCloseTo(220, 6)
  })

  it('scopes to a named region', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(16, 16, (_x, y) => (y < 4 ? 250 : 90)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max', region_name: 'mexico' })
    expect(r.ok).toBe(true)
    expect(r.region).toBe('Mexico')
    // Mexico is far south of the hot northern band, so the scoped
    // maximum must be the cooler value — proof the window was applied
    // rather than ignored.
    expect(r.value).toBeCloseTo(90, 6)
  })
})

describe('saying what the number is of', () => {
  it('carries the frame time, because these are animations', () => {
    // Without it, "the smoke is worst at 47.5N" is a claim about an
    // unnamed instant of an 85-frame forecast.
    registerAnalysisSource(makeSource())
    const t = 'Jul 28, 2026 at 12:00 PM'
    expect(executeProbeValue({ lat: 45, lon: -100 }, t).frameTime).toBe(t)
    expect(executeSummarizeRegion({}, t).frameTime).toBe(t)
    expect(executeFindExtremum({}, t).frameTime).toBe(t)
  })

  it('omits the time rather than inventing one when there is none', () => {
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({}, null).frameTime).toBeUndefined()
    expect(executeFindExtremum({}).frameTime).toBeUndefined()
  })

  it('names the region on every scoped answer', () => {
    // The live failure: find_extremum scoped to a region, and the
    // answer read as a whole-dataset claim because the region was
    // never mentioned.
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({ region_name: 'mexico' }).region).toBe('Mexico')
    expect(executeFindExtremum({}).region).toMatch(/whole dataset/i)
  })

  it('flags an extremum that is clipping at the top of the scale', () => {
    // A max of exactly vmax means the field saturates there — a floor,
    // not a measurement. Quoting it as exact overstates the encoding.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: SCALE, options: OPTIONS }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    expect(r.value).toBeCloseTo(255, 6)
    expect(r.saturated).toMatch(/at least/i)
  })

  it('says nothing about saturation for an unclipped field', () => {
    registerAnalysisSource(makeSource())
    expect(executeFindExtremum({ kind: 'max' }).saturated).toBeUndefined()
  })

  it('never flags a minimum as saturated', () => {
    // vmin is the bottom of the scale, and the no-data band already
    // covers "nothing here" — a min is not a clipped reading.
    registerAnalysisSource(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 255), scale: SCALE, options: OPTIONS }),
    }))
    expect(executeFindExtremum({ kind: 'min' }).saturated).toBeUndefined()
  })
})

describe('coordinates', () => {
  it('keeps a western longitude precise, not rounded to significant figures', () => {
    // Three significant figures turns -119.53 into -120 — half a
    // degree, about 50 km — while leaving -9.53 alone. Precision that
    // varies with magnitude is not precision.
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 47.531, lon: -119.534 })
    expect(r.lon).toBeCloseTo(-119.534, 9)
    expect(r.lat).toBeCloseTo(47.531, 9)
  })

  it('keeps the sign, which is the whole difference between Washington and China', () => {
    registerAnalysisSource(makeSource())
    const r = executeProbeValue({ lat: 47.5, lon: -119.5 })
    expect(r.lon).toBe(-119.5)
    expect(r.lon).toBeLessThan(0)
  })

  it('reports the extremum’s position without magnitude-dependent rounding', () => {
    registerAnalysisSource(makeSource({
      frame: () => ({
        snapshot: snap(64, 64, (x, y) => (x === 40 && y === 20 ? 250 : 100)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    const r = executeFindExtremum({ kind: 'max' })
    // Inside the dataset box, and carrying more than three significant
    // figures of longitude.
    expect(r.lon!).toBeLessThan(0)
    expect(Math.abs(r.lon! - Math.round(r.lon!))).toBeGreaterThan(0)
  })
})
