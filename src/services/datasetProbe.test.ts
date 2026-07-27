/**
 * Tests for the data-encoded hover probe.
 *
 * The UV mapping carries the bug that has already shipped twice in
 * this codebase — an inverted V, which mirrors the data across the
 * equator and still looks like a plausible globe. So these check the
 * poles and the hemispheres explicitly rather than only round-tripping
 * a midpoint, which an inverted mapping would pass.
 */
import { describe, expect, it } from 'vitest'
import {
  latLonToTexelUv,
  probeDatasetValue,
  sampleLumaAt,
  type ProbeSource,
} from './datasetProbe'
import type { ColorScale, DatasetOverlayOptions } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 100,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

describe('latLonToTexelUv — full globe', () => {
  it('puts the north pole at the top of the image, not the bottom', () => {
    // v == 0 is the image's TOP row. An inverted mapping is the
    // failure this test exists for.
    expect(latLonToTexelUv(90, 0)?.v).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(-90, 0)?.v).toBeCloseTo(1, 6)
    expect(latLonToTexelUv(0, 0)?.v).toBeCloseTo(0.5, 6)
  })

  it('maps the northern hemisphere above the equator', () => {
    const north = latLonToTexelUv(45, 0)
    const south = latLonToTexelUv(-45, 0)
    expect(north?.v).toBeLessThan(0.5)
    expect(south?.v).toBeGreaterThan(0.5)
  })

  it('centres longitude 0 at u = 0.5 and wraps at the dateline', () => {
    expect(latLonToTexelUv(0, 0)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, -180)?.u).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 180)?.u).toBeCloseTo(0, 6)
  })

  it('shifts U by lonOrigin, wrapping like GLSL fract()', () => {
    // A dateline-centred dataset: lon 180 becomes the middle.
    const opts: DatasetOverlayOptions = { lonOrigin: 180 }
    expect(latLonToTexelUv(0, 180, opts)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, 0, opts)?.u).toBeCloseTo(0, 6)
    // A negative intermediate must wrap forward like GLSL fract(),
    // not clamp and not stay negative. lon -90 sits 270 degrees east
    // of the dateline centre, so it lands on the texture's right
    // half: raw = -0.25, fract(-0.25) = 0.75.
    const u = latLonToTexelUv(0, -90, opts)?.u
    expect(u).toBeGreaterThanOrEqual(0)
    expect(u).toBeLessThan(1)
    expect(u).toBeCloseTo(0.75, 6)
    // …and the eastward direction is the mirror of it.
    expect(latLonToTexelUv(0, 90, opts)?.u).toBeCloseTo(0.25, 6)
  })

  it('honours isFlippedInY', () => {
    expect(latLonToTexelUv(90, 0, { isFlippedInY: true })?.v).toBeCloseTo(1, 6)
  })

  it('treats a worldwide bbox as the full-globe path', () => {
    // wireToDataset defaults every catalog row to this box.
    const global: DatasetOverlayOptions = {
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
    }
    expect(latLonToTexelUv(90, 0, global)?.v).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 0, global)?.u).toBeCloseTo(0.5, 6)
  })
})

describe('latLonToTexelUv — regional bbox', () => {
  // The RRFS smoke box, the dataset that motivated this work.
  const opts: DatasetOverlayOptions = { boundingBox: { n: 53, s: 21, w: -134, e: -60 } }

  it('maps the box corners to the texture corners', () => {
    expect(latLonToTexelUv(53, -134, opts)).toEqual({ u: 0, v: 0 })
    const se = latLonToTexelUv(21, -60, opts)
    expect(se?.u).toBeCloseTo(1, 6)
    expect(se?.v).toBeCloseTo(1, 6)
  })

  it('keeps north at the top inside the box', () => {
    const north = latLonToTexelUv(50, -100, opts)!
    const south = latLonToTexelUv(25, -100, opts)!
    expect(north.v).toBeLessThan(south.v)
  })

  it('returns null outside the box, matching the shader discard', () => {
    expect(latLonToTexelUv(60, -100, opts)).toBeNull() // north of n
    expect(latLonToTexelUv(10, -100, opts)).toBeNull() // south of s
    expect(latLonToTexelUv(37, 20, opts)).toBeNull() // east of e
  })

  it('handles an antimeridian-crossing box', () => {
    const pacific: DatasetOverlayOptions = { boundingBox: { n: 20, s: -20, w: 170, e: -170 } }
    expect(latLonToTexelUv(0, 170, pacific)?.u).toBeCloseTo(0, 6)
    expect(latLonToTexelUv(0, 180, pacific)?.u).toBeCloseTo(0.5, 6)
    expect(latLonToTexelUv(0, -170, pacific)?.u).toBeCloseTo(1, 6)
    expect(latLonToTexelUv(0, 0, pacific)).toBeNull()
  })
})

/** A canvas whose 2D context reports a fixed pixel, and records the
 *  drawImage arguments so the "one texel, not one frame" rule can be
 *  asserted directly. */
function fakeScratch(luma: number, calls: number[][] = []) {
  return {
    canvas: {
      getContext: () => ({
        drawImage: (...args: unknown[]) => calls.push(args.slice(1) as number[]),
        getImageData: () => ({ data: [luma, luma, luma, 255] }),
      }),
    } as unknown as HTMLCanvasElement,
    calls,
  }
}

const fakeVideo = (w = 4096, h = 2048): ProbeSource =>
  Object.assign(Object.create(HTMLVideoElement.prototype) as HTMLVideoElement, {
    videoWidth: w,
    videoHeight: h,
  })

describe('sampleLumaAt', () => {
  it('copies a single texel rather than a frame', () => {
    const { canvas, calls } = fakeScratch(128)
    sampleLumaAt(fakeVideo(), { u: 0.5, v: 0.5 }, canvas)
    // sx, sy, sw, sh, dx, dy, dw, dh — the source rect must be 1x1.
    expect(calls[0].slice(2, 4)).toEqual([1, 1])
    expect(calls[0].slice(4)).toEqual([0, 0, 1, 1])
  })

  it('indexes the texel from the UV', () => {
    const { canvas, calls } = fakeScratch(0)
    sampleLumaAt(fakeVideo(4096, 2048), { u: 0.25, v: 0.75 }, canvas)
    expect(calls[0].slice(0, 2)).toEqual([1024, 1536])
  })

  it('clamps at the far edge rather than sampling out of bounds', () => {
    const { canvas, calls } = fakeScratch(0)
    sampleLumaAt(fakeVideo(100, 50), { u: 1, v: 1 }, canvas)
    expect(calls[0].slice(0, 2)).toEqual([99, 49])
  })

  it('returns null before a frame has decoded', () => {
    const { canvas } = fakeScratch(0)
    expect(sampleLumaAt(fakeVideo(0, 0), { u: 0.5, v: 0.5 }, canvas)).toBeNull()
  })

  it('returns null instead of throwing on a tainted canvas', () => {
    const tainted = {
      getContext: () => ({
        drawImage: () => {},
        getImageData: () => {
          throw new DOMException('tainted', 'SecurityError')
        },
      }),
    } as unknown as HTMLCanvasElement
    expect(sampleLumaAt(fakeVideo(), { u: 0.5, v: 0.5 }, tainted)).toBeNull()
  })
})

describe('probeDatasetValue', () => {
  it('reports the physical value with units', () => {
    const { canvas } = fakeScratch(255)
    const r = probeDatasetValue(0, 0, fakeVideo(), canvas, { colorScale: SCALE })
    expect(r?.value).toBeCloseTo(100, 6)
    expect(r?.units).toBe('mg m-2')
    expect(r?.noData).toBe(false)
  })

  it('flags the no-data band instead of reporting a number near vmin', () => {
    const { canvas } = fakeScratch(3) // 3/255 < 12/256
    expect(probeDatasetValue(0, 0, fakeVideo(), canvas, { colorScale: SCALE })?.noData).toBe(true)
  })

  it('returns null for a dataset that is not data-encoded', () => {
    // The backwards-compatibility guarantee for the readout: a
    // picture dataset reports nothing rather than a made-up number.
    const { canvas } = fakeScratch(200)
    expect(probeDatasetValue(0, 0, fakeVideo(), canvas, undefined)).toBeNull()
    expect(probeDatasetValue(0, 0, fakeVideo(), canvas, { lonOrigin: 0 })).toBeNull()
  })

  it('returns null outside a regional dataset', () => {
    const { canvas } = fakeScratch(200)
    const opts: DatasetOverlayOptions = {
      colorScale: SCALE,
      boundingBox: { n: 53, s: 21, w: -134, e: -60 },
    }
    expect(probeDatasetValue(0, 0, fakeVideo(), canvas, opts)).toBeNull()
    expect(probeDatasetValue(37, -100, fakeVideo(), canvas, opts)).not.toBeNull()
  })
})
