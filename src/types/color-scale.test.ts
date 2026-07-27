/**
 * Tests for the data-encoded video sidecar contract.
 *
 * The parser is fail-closed by design — a malformed sidecar must
 * return `null` so the caller falls back to treating the dataset as a
 * picture, rather than colouring real data through a half-valid
 * palette. Most of these cases pin that.
 */
import { describe, expect, it } from 'vitest'
import {
  buildColorScaleLut,
  COLOR_SCALE_LUT_SIZE,
  isTransparentLuma,
  lumaToValue,
  parseColorScale,
  type ColorScale,
} from './color-scale'

const VALID = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 100,
  units: 'mg m-2',
}

describe('parseColorScale', () => {
  it('accepts a well-formed sidecar as an object or a JSON string', () => {
    const fromObject = parseColorScale(VALID)
    const fromString = parseColorScale(JSON.stringify(VALID))
    expect(fromObject).not.toBeNull()
    expect(fromString).toEqual(fromObject)
    expect(fromObject?.vmin).toBe(0)
    expect(fromObject?.vmax).toBe(100)
    expect(fromObject?.units).toBe('mg m-2')
  })

  it('sorts stops rather than rejecting an out-of-order palette', () => {
    const scale = parseColorScale({
      ...VALID,
      stops: [
        { t: 1, rgba: [255, 255, 255, 255] },
        { t: 0.5, rgba: [128, 0, 0, 128] },
        { t: 0, rgba: [0, 0, 0, 0] },
      ],
    })
    expect(scale?.stops.map(s => s.t)).toEqual([0, 0.5, 1])
  })

  it.each([
    ['not an object', 42],
    ['null', null],
    ['unparseable JSON', '{nope'],
    ['no stops', { ...VALID, stops: undefined }],
    ['a single stop', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0, 0] }] }],
    ['a non-finite vmin', { ...VALID, vmin: Number.NaN }],
    ['a missing vmax', { ...VALID, vmax: undefined }],
    ['vmin === vmax (a zero-width range)', { ...VALID, vmin: 5, vmax: 5 }],
    ['a stop position outside [0,1]', { ...VALID, stops: [{ t: -0.1, rgba: [0, 0, 0, 0] }, VALID.stops[1]] }],
    ['a short rgba tuple', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0] }, VALID.stops[1]] }],
    ['an out-of-gamut channel', { ...VALID, stops: [{ t: 0, rgba: [0, 0, 0, 300] }, VALID.stops[1]] }],
  ])('returns null for %s', (_label, input) => {
    expect(parseColorScale(input)).toBeNull()
  })

  it('drops an empty units string and an out-of-range transparentRange', () => {
    const scale = parseColorScale({ ...VALID, units: '   ', transparentRange: 1.5 })
    expect(scale?.units).toBeUndefined()
    expect(scale?.transparentRange).toBeUndefined()
  })

  it('keeps a plausible transparentRange', () => {
    // The published smoke pipeline's value.
    expect(parseColorScale({ ...VALID, transparentRange: 12 / 256 })?.transparentRange)
      .toBeCloseTo(0.0469, 4)
  })
})

describe('buildColorScaleLut', () => {
  const scale = parseColorScale(VALID) as ColorScale

  it('produces one RGBA texel per 8-bit luma code', () => {
    expect(buildColorScaleLut(scale)).toHaveLength(COLOR_SCALE_LUT_SIZE * 4)
  })

  it('interpolates linearly between stops and pins both endpoints', () => {
    const lut = buildColorScaleLut(scale)
    expect([...lut.slice(0, 4)]).toEqual([0, 0, 0, 0])
    expect([...lut.slice(255 * 4, 256 * 4)]).toEqual([255, 255, 255, 255])
    // Midpoint of a black→white ramp.
    expect(lut[128 * 4]).toBeGreaterThan(126)
    expect(lut[128 * 4]).toBeLessThan(130)
  })

  it('honours multi-stop palettes at the stop positions', () => {
    const multi = parseColorScale({
      ...VALID,
      stops: [
        { t: 0, rgba: [0, 0, 0, 255] },
        { t: 0.5, rgba: [255, 0, 0, 255] },
        { t: 1, rgba: [255, 255, 0, 255] },
      ],
    }) as ColorScale
    const lut = buildColorScaleLut(multi)
    const mid = Math.round(0.5 * (COLOR_SCALE_LUT_SIZE - 1))
    expect(lut[mid * 4]).toBeGreaterThan(250) // red saturated
    expect(lut[mid * 4 + 1]).toBeLessThan(5) // green not yet risen
  })

  it('forces alpha to zero below transparentRange', () => {
    // A palette whose own low end already carries alpha — the cutoff
    // has to win, otherwise near-zero values haze the whole globe.
    const opaqueLow = parseColorScale({
      ...VALID,
      stops: [
        { t: 0, rgba: [10, 10, 10, 200] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      transparentRange: 0.1,
    }) as ColorScale
    const lut = buildColorScaleLut(opaqueLow)
    expect(lut[0 * 4 + 3]).toBe(0)
    expect(lut[10 * 4 + 3]).toBe(0) // 10/255 = 0.039 < 0.1
    expect(lut[200 * 4 + 3]).toBeGreaterThan(0)
  })
})

describe('lumaToValue', () => {
  const scale = parseColorScale({ ...VALID, vmin: -10, vmax: 30 }) as ColorScale

  it('maps the endpoints and the midpoint of the code range', () => {
    expect(lumaToValue(0, scale)).toBe(-10)
    expect(lumaToValue(255, scale)).toBe(30)
    expect(lumaToValue(127.5, scale)).toBeCloseTo(10, 6)
  })

  it('round-trips within one 8-bit step', () => {
    // The fidelity budget the design sets: a recovered value must sit
    // within one code level of the value that was encoded.
    const step = (scale.vmax - scale.vmin) / 255
    for (const luma of [0, 1, 64, 128, 200, 255]) {
      const value = lumaToValue(luma, scale)
      const back = ((value - scale.vmin) / (scale.vmax - scale.vmin)) * 255
      expect(Math.abs(back - luma) * step).toBeLessThanOrEqual(step)
    }
  })
})

describe('isTransparentLuma', () => {
  it('reports the no-data band, and nothing when no cutoff is declared', () => {
    const withCutoff = parseColorScale({ ...VALID, transparentRange: 12 / 256 }) as ColorScale
    expect(isTransparentLuma(0, withCutoff)).toBe(true)
    expect(isTransparentLuma(11, withCutoff)).toBe(true)
    expect(isTransparentLuma(64, withCutoff)).toBe(false)

    const noCutoff = parseColorScale(VALID) as ColorScale
    expect(isTransparentLuma(0, noCutoff)).toBe(false)
  })
})
