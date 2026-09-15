// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import {
  CALIBRATION_ANCHORS,
  CALIBRATION_OVERLAY,
  MAX_PATTERN_WIDTH,
  buildCalibrationPattern,
  createCalibrationCache,
  createCalibrationCanvas,
  latLonToUv,
  paintCalibrationPattern,
  type PatternContext,
} from './calibrationPattern'
import { latLonToTexelUv } from '../services/datasetProbe'

const pattern = (framebufferWidth = 4096) => buildCalibrationPattern({ framebufferWidth })

describe('latLonToUv', () => {
  it('puts the prime meridian in the middle and the north pole at the top', () => {
    expect(latLonToUv(0, 0)).toEqual({ u: 0.5, v: 0.5 })
    expect(latLonToUv(90, 0).v).toBe(0)
    expect(latLonToUv(-90, 0).v).toBe(1)
  })

  it('agrees with the shader mirror for the overlay the pattern ships with', () => {
    // The load-bearing test in this file. `datasetProbe.latLonToTexelUv`
    // is the canonical TS mirror of the shader maths, and the pattern's
    // whole argument for being a texture is that it travels the same
    // sampling path a dataset does. If these two ever disagree, the
    // pattern is calibrating something the data does not do.
    for (const [lat, lon] of [
      [0, 0],
      [45, -120],
      [-30, 90],
      [78, 179],
      [-78, -179],
      [12.5, 37.25],
    ] as const) {
      const mine = latLonToUv(lat, lon)
      const theirs = latLonToTexelUv(lat, lon, CALIBRATION_OVERLAY)
      expect(theirs).not.toBeNull()
      expect(mine.u).toBeCloseTo(theirs!.u, 12)
      expect(mine.v).toBeCloseTo(theirs!.v, 12)
    }
  })

  it('keeps the two ends of the antimeridian apart, unlike the probe', () => {
    // Deliberate divergence, and the reason the pattern draws that
    // meridian twice: the probe wraps, because it answers "which texel
    // is under this point" and there is only one. A painter asking for
    // -180 and one asking for +180 want opposite edges of the same
    // image, so wrapping here would silently delete half the seam.
    expect(latLonToUv(0, 180).u).toBe(1)
    expect(latLonToUv(0, -180).u).toBe(0)
    expect(latLonToTexelUv(0, 180, CALIBRATION_OVERLAY)!.u).toBe(0)
  })
})

describe('the anchors', () => {
  it('marks the antimeridian at both edges', () => {
    const seams = CALIBRATION_ANCHORS.filter(a => Math.abs(a.lon) === 180)
    expect(seams).toHaveLength(2)
    expect(seams.map(a => latLonToUv(a.lat, a.lon).u).sort()).toEqual([0, 1])
  })

  it('draws a crosshair for every anchor', () => {
    const { lines } = pattern()
    for (const anchor of CALIBRATION_ANCHORS) {
      const { u, v } = latLonToUv(anchor.lat, anchor.lon)
      const horizontal = lines.some(l => l.v0 === v && l.v1 === v && l.u0 < u && l.u1 > u)
      const vertical = lines.some(l => l.u0 === u && l.u1 === u && l.v0 < v && l.v1 > v)
      expect(horizontal, `horizontal arm at ${anchor.label}`).toBe(true)
      expect(vertical, `vertical arm at ${anchor.label}`).toBe(true)
    }
  })
})

describe('the reference lines', () => {
  it('gives the equator, the prime meridian and the seam three colours', () => {
    const { lines } = pattern()
    const equator = lines.find(l => l.v0 === 0.5 && l.v1 === 0.5 && l.u0 === 0 && l.u1 === 1)
    const prime = lines.find(l => l.u0 === 0.5 && l.u1 === 0.5 && l.v0 === 0 && l.v1 === 1)
    const seams = lines.filter(l => l.v0 === 0 && l.v1 === 1 && (l.u0 === 0 || l.u0 === 1))

    expect(equator).toBeDefined()
    expect(prime).toBeDefined()
    expect(seams).toHaveLength(2)

    // Three distinct colours, because a seam artefact and a mis-set
    // rotation look identical if the edges are painted like the grid.
    const colours = new Set([equator!.stroke, prime!.stroke, seams[0].stroke])
    expect(colours.size).toBe(3)
    for (const seam of seams) expect(seam.stroke).toBe(seams[0].stroke)
  })

  it('draws the reference lines thicker than the ordinary graticule', () => {
    const { lines } = pattern()
    const equator = lines.find(l => l.v0 === 0.5 && l.v1 === 0.5)!
    const ordinary = lines.find(l => l.v0 === l.v1 && l.v0 !== 0.5 && l.u0 === 0 && l.u1 === 1)!
    expect(equator.widthPx).toBeGreaterThan(ordinary.widthPx)
  })
})

describe('the colour bars', () => {
  it('reverses the southern band so a vertical flip is visible', () => {
    const { rects } = pattern()
    const atLat = (lat: number) => {
      const v = latLonToUv(lat, 0).v
      return rects
        .filter(r => r.v0 < v && r.v1 > v && r.u1 - r.u0 < 0.9)
        .sort((a, b) => a.u0 - b.u0)
        .map(r => r.fill)
    }
    const north = atLat(30)
    const south = atLat(-30)

    expect(north).toHaveLength(8)
    expect(south).toEqual([...north].reverse())
    // Two identical bands would be invariant under the flip, which is
    // the whole reason for reversing one.
    expect(south).not.toEqual(north)
  })
})

describe('the grayscale ramp', () => {
  it('spans black to white across the full longitude', () => {
    const { rects } = pattern()
    const band = rects
      .filter(r => r.v0 < 0.5 && r.v1 > 0.5 && r.u1 - r.u0 < 0.9)
      .sort((a, b) => a.u0 - b.u0)

    expect(band).toHaveLength(8)
    expect(band[0].fill).toBe('rgb(0, 0, 0)')
    expect(band[7].fill).toBe('rgb(255, 255, 255)')
    expect(band[0].u0).toBe(0)
    expect(band[7].u1).toBe(1)
  })
})

describe('the readout', () => {
  it('names the framebuffer and its derived height', () => {
    const { texts } = buildCalibrationPattern({ framebufferWidth: 8192 })
    expect(texts.some(t => t.text === '8192 × 4096')).toBe(true)
  })

  it('repeats it around the sphere, because one label faces one way', () => {
    const { texts } = buildCalibrationPattern({ framebufferWidth: 2048 })
    const readouts = texts.filter(t => t.text === '2048 × 1024')
    expect(readouts).toHaveLength(4)
    expect(new Set(readouts.map(t => t.u)).size).toBe(4)
    // All on one parallel: they are the same statement seen from four
    // sides, not four different ones.
    expect(new Set(readouts.map(t => t.v)).size).toBe(1)
  })

  it('repeats the pole letters too, and puts N above S', () => {
    const { texts } = pattern()
    const north = texts.filter(t => t.text === 'N')
    const south = texts.filter(t => t.text === 'S')
    expect(north).toHaveLength(4)
    expect(south).toHaveLength(4)
    // v grows downward, so north is the smaller number. Backwards here
    // is the hemisphere error the whole pattern exists to expose.
    expect(north[0].v).toBeLessThan(south[0].v)
  })

  it('labels every meridian so a turned sphere can be read rather than estimated', () => {
    const { texts } = pattern()
    for (const label of ['0', '90E', '90W', '30E', '150W']) {
      expect(texts.some(t => t.text === label), label).toBe(true)
    }
  })
})

function recorder(): PatternContext & {
  rects: number[][]
  strokes: { from: number[]; to: number[]; style: string }[]
  labels: { text: string; x: number; y: number }[]
} {
  const rects: number[][] = []
  const strokes: { from: number[]; to: number[]; style: string }[] = []
  const labels: { text: string; x: number; y: number }[] = []
  let from: number[] = []
  let to: number[] = []
  return {
    rects,
    strokes,
    labels,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect: (x, y, w, h) => rects.push([x, y, w, h]),
    beginPath: () => {},
    moveTo: (x, y) => {
      from = [x, y]
    },
    lineTo: (x, y) => {
      to = [x, y]
    },
    stroke() {
      strokes.push({ from, to, style: this.strokeStyle })
    },
    fillText: (text, x, y) => labels.push({ text, x, y }),
  }
}

describe('paintCalibrationPattern', () => {
  it('scales every primitive to the canvas it is given', () => {
    const ctx = recorder()
    paintCalibrationPattern(
      ctx,
      {
        rects: [{ u0: 0, v0: 0, u1: 0.5, v1: 1, fill: '#fff' }],
        lines: [{ u0: 0.5, v0: 0, u1: 0.5, v1: 1, stroke: '#f0f', widthPx: 3 }],
        texts: [{ u: 0.25, v: 0.5, text: 'N', fill: '#fff', sizeV: 0.1 }],
      },
      400,
      200,
    )

    expect(ctx.rects).toEqual([[0, 0, 200, 200]])
    expect(ctx.strokes).toEqual([{ from: [200, 0], to: [200, 200], style: '#f0f' }])
    expect(ctx.labels).toEqual([{ text: 'N', x: 100, y: 100 }])
  })

  it('snaps rects outward so adjacent ramp steps cannot leave a gap', () => {
    // An eight-step ramp on a width that does not divide by eight is
    // where a naive round() leaves a background-coloured hairline, and
    // on a grayscale wedge that reads as banding in the projector.
    const ctx = recorder()
    paintCalibrationPattern(
      ctx,
      {
        rects: [
          { u0: 0, v0: 0, u1: 1 / 3, v1: 1, fill: '#000' },
          { u0: 1 / 3, v0: 0, u1: 2 / 3, v1: 1, fill: '#888' },
          { u0: 2 / 3, v0: 0, u1: 1, v1: 1, fill: '#fff' },
        ],
        lines: [],
        texts: [],
      },
      100,
      50,
    )

    const spans = ctx.rects.map(([x, , w]) => [x, x + w])
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i][0], `step ${i} starts at or before the previous end`).toBeLessThanOrEqual(
        spans[i - 1][1],
      )
    }
    expect(spans[0][0]).toBe(0)
    expect(spans[2][1]).toBe(100)
  })

  it('scales type to the canvas height rather than fixing it in pixels', () => {
    const small = recorder()
    const large = recorder()
    const one = {
      rects: [],
      lines: [],
      texts: [{ u: 0.5, v: 0.5, text: 'N', fill: '#fff', sizeV: 0.05 }],
    }
    paintCalibrationPattern(small, one, 1024, 512)
    const smallFont = small.font
    paintCalibrationPattern(large, one, 4096, 2048)

    // A fixed pixel size would vanish at 8192 and dominate at 1024.
    expect(smallFont).toContain('26px')
    expect(large.font).toContain('102px')
  })
})

describe('createCalibrationCanvas', () => {
  it('caps the canvas below the framebuffer rather than allocating 8K', () => {
    const canvas = createCalibrationCanvas({ framebufferWidth: 8192 })
    expect(canvas).not.toBeNull()
    expect(canvas!.width).toBe(MAX_PATTERN_WIDTH)
    expect(canvas!.height).toBe(MAX_PATTERN_WIDTH / 2)
  })

  it('keeps 2:1 at a rung below the cap', () => {
    const canvas = createCalibrationCanvas({ framebufferWidth: 1024 })
    expect(canvas!.width).toBe(1024)
    expect(canvas!.height).toBe(512)
  })

  it('returns null rather than a blank canvas when there is no 2D context', () => {
    // A black texture is indistinguishable from the dropped-upload
    // failure the 1 Hz floor exists to surface, so the caller has to be
    // able to tell the difference and leave the sphere alone.
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null)
    try {
      expect(createCalibrationCanvas({ framebufferWidth: 2048 })).toBeNull()
    } finally {
      HTMLCanvasElement.prototype.getContext = original
    }
  })
})

describe('createCalibrationCache', () => {
  const fakeCanvas = () => ({}) as HTMLCanvasElement

  it('builds once per framebuffer rung, not once per composite', () => {
    // The composite is rebuilt on every dataset load, palette change
    // and layer change. Building a pattern is a 4096×2048 fill, so
    // doing it there would redraw and re-upload the whole canvas for
    // changes that cannot affect it.
    const build = vi.fn(() => fakeCanvas())
    const cache = createCalibrationCache(build)

    const first = cache.canvasFor(4096)
    expect(cache.canvasFor(4096)).toBe(first)
    expect(cache.canvasFor(4096)).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('rebuilds when the operator changes the rung', () => {
    const build = vi.fn(() => fakeCanvas())
    const cache = createCalibrationCache(build)

    const small = cache.canvasFor(1024)
    const large = cache.canvasFor(4096)
    expect(large).not.toBe(small)
    expect(build).toHaveBeenNthCalledWith(2, { framebufferWidth: 4096 })
  })

  it('retries after a failure rather than caching the null forever', () => {
    // A 2D context that could not be had is a transient condition — a
    // memory ceiling, a browser that dropped its canvas backend. Caching
    // it as a permanent `null` would leave the toggle dead for the life
    // of the window with nothing on screen to say why.
    let fail = true
    const build = vi.fn(() => (fail ? null : fakeCanvas()))
    const cache = createCalibrationCache(build)

    expect(cache.canvasFor(4096)).toBeNull()
    expect(cache.canvasFor(4096)).toBeNull()
    expect(build).toHaveBeenCalledTimes(2)

    fail = false
    expect(cache.canvasFor(4096)).not.toBeNull()
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('keeps the pattern across a toggle off and back on', () => {
    // An operator toggling it is comparing the pattern against the
    // content and will toggle straight back, so discarding it on the
    // way out would put a visible rebuild pause on a control whose
    // whole value is an instant A/B. Nothing here is told about the
    // toggle at all, which is what makes that true by construction.
    const build = vi.fn(() => fakeCanvas())
    const cache = createCalibrationCache(build)

    const on = cache.canvasFor(2048)
    // …calibration goes off; nothing calls the cache…
    expect(cache.canvasFor(2048)).toBe(on)
    expect(build).toHaveBeenCalledTimes(1)
  })
})
