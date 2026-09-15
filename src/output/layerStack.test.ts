// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's overlay sampling and layer composition.
 *
 * The load-bearing one is the agreement with `datasetProbe`: this
 * module mirrors GLSL that has shipped a mirrored-hemisphere bug twice
 * (a US bbox over the South Pacific, and an inverted V), and
 * `datasetProbe.latLonToTexelUv` is the canonical TS mirror of that
 * same shader. Asserting they agree is what makes the duplicate safe.
 */

import { describe, it, expect } from 'vitest'
import { latLonToTexelUv } from '../services/datasetProbe'
import { MAX_CAMERA_OFFSET, cameraOffsetForCamera, rayUnitSphereT, latLonToDirection } from './equirectRtt'
import type { DatasetOverlayOptions } from '../types'
import {
  EARTH_DECORATION_GLSL,
  MAX_OUTPUT_LAYERS,
  decorateEarth,
  gradeEarthBase,
  applyAtmosphere,
  EARTH_ATMOSPHERE_GLSL,
  localZoomAt,
  cloudZoomFade,
  nightFactor,
  overlaySampleUv,
  overlayUniformNames,
  buildOutputFragmentShader,
  OVERLAY_SAMPLE_GLSL,
} from './layerStack'

const CONUS: DatasetOverlayOptions = { boundingBox: { n: 50, s: 24, w: -125, e: -66 } }
const DATELINE: DatasetOverlayOptions = { boundingBox: { n: 60, s: -60, w: 150, e: -150 } }

describe('agreement with datasetProbe', () => {
  // datasetProbe uses IMAGE-space V (v = 0 is the top row); this module
  // uses SHADER space (v = 1 is the top row, because THREE uploads with
  // flipY). So the two agree on U exactly and on V after one flip.
  const cases: Array<[string, DatasetOverlayOptions | undefined, number, number]> = [
    ['global, no options', undefined, 0, 0],
    ['global, mid-latitude', undefined, 37.7, -122.4],
    ['global, antimeridian', undefined, 0, 179.9],
    ['global, poles', undefined, 89.9, 45],
    ['lonOrigin 180', { lonOrigin: 180 }, 12, -30],
    ['lonOrigin with flip', { lonOrigin: 90, isFlippedInY: true }, -45, 100],
    ['CONUS bbox', CONUS, 39, -100],
    ['CONUS bbox corner', CONUS, 50, -125],
    ['CONUS bbox flipped', { ...CONUS, isFlippedInY: true }, 30, -80],
    ['dateline-crossing bbox, east side', DATELINE, 10, 170],
    ['dateline-crossing bbox, west side', DATELINE, -10, -170],
  ]

  for (const [name, overlay, lat, lon] of cases) {
    it(`matches on ${name}`, () => {
      const mine = overlaySampleUv(lat, lon, overlay)
      const theirs = latLonToTexelUv(lat, lon, overlay)
      expect(mine).not.toBeNull()
      expect(theirs).not.toBeNull()
      expect(mine!.u).toBeCloseTo(theirs!.u, 10)
      // The one documented difference, and only this one.
      expect(mine!.v).toBeCloseTo(1 - theirs!.v, 10)
    })
  }

  it('rejects the same out-of-bbox points datasetProbe rejects', () => {
    // Outside CONUS in latitude, in longitude, and in both.
    for (const [lat, lon] of [[10, -100], [39, 20], [-40, 100]]) {
      expect(overlaySampleUv(lat, lon, CONUS)).toBeNull()
      expect(latLonToTexelUv(lat, lon, CONUS)).toBeNull()
    }
  })

  it('treats a whole-globe bbox as no bbox, as datasetProbe does', () => {
    // Clipping to a box that clips nothing costs a branch and loses the
    // lonOrigin shift.
    const global: DatasetOverlayOptions = {
      boundingBox: { n: 90, s: -90, w: -180, e: 180 },
      lonOrigin: 180,
    }
    const mine = overlaySampleUv(0, 0, global)
    const theirs = latLonToTexelUv(0, 0, global)
    expect(mine!.u).toBeCloseTo(theirs!.u, 10)
    expect(mine!.u).toBeCloseTo(0, 10) // the lonOrigin shift survived
  })
})

describe('shader-space V orientation', () => {
  it('puts north at v = 1, the opposite of image space', () => {
    // The sign that has shipped wrong twice. If this flips, every
    // dataset renders mirrored across the equator while still looking
    // like a plausible globe.
    expect(overlaySampleUv(90, 0)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(-90, 0)!.v).toBeCloseTo(0, 10)
  })

  it('puts a bbox north edge at v = 1', () => {
    expect(overlaySampleUv(50, -100, CONUS)!.v).toBeCloseTo(1, 10)
    expect(overlaySampleUv(24, -100, CONUS)!.v).toBeCloseTo(0, 10)
  })

  it('inverts both when isFlippedInY is set', () => {
    expect(overlaySampleUv(90, 0, { isFlippedInY: true })!.v).toBeCloseTo(0, 10)
    expect(overlaySampleUv(50, -100, { ...CONUS, isFlippedInY: true })!.v).toBeCloseTo(0, 10)
  })
})

describe('buildOutputFragmentShader', () => {
  it('composites no layers at zero, but still decorates the Earth', () => {
    // It used to hand back the projection pass untouched here. The
    // decoration is not a layer — it is what the sphere looks like —
    // and an idle output with no dataset is the case it matters most
    // for, so zero layers is decorated and simply has nothing over it.
    const src = buildOutputFragmentShader(0)
    expect(src).not.toContain('sampleOverlayLayer')
    expect(src).toContain('decorateEarth(')
    expect(src).toContain('earthNightFactor(hit,')
  })

  it('decorates before it composites, so a dataset is never tinted', () => {
    // Day/night shading belongs to the Earth, not to the data. If the
    // order inverted, a night-side smoke plume would read as less
    // smoke — a rendering artifact indistinguishable from a value.
    const src = buildOutputFragmentShader(1)
    // Anchored on the call sites, not the names: both helpers are
    // *defined* in the preamble, so a bare name finds the definition.
    expect(src.indexOf('colour = decorateEarth(colour,')).toBeLessThan(
      src.indexOf('vec4 layer = sampleOverlayLayer('),
    )
  })

  it('declares the helper before main(), as GLSL ES 1.00 requires', () => {
    // There are no forward declarations in GLSL ES 1.00. Getting this
    // backwards type-checks fine and fails only on a GPU — which is
    // nowhere this repo's tests run, so it is asserted here instead.
    const src = buildOutputFragmentShader(2)
    const helper = src.indexOf('vec4 sampleOverlayLayer(')
    const main = src.indexOf('void main() {')
    expect(helper).toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(-1)
    expect(helper).toBeLessThan(main)
  })

  it('declares every uniform each slot composites with', () => {
    // Driven off the cap rather than a literal, so lowering it cannot
    // quietly make this assert nothing.
    const src = buildOutputFragmentShader(MAX_OUTPUT_LAYERS)
    for (let slot = 0; slot < MAX_OUTPUT_LAYERS; slot++) {
      for (const name of Object.values(overlayUniformNames(slot))) {
        expect(src).toContain(`${name}`)
      }
    }
  })

  it('does not declare slots it was not asked for', () => {
    const src = buildOutputFragmentShader(1)
    expect(src).toContain(overlayUniformNames(0).map)
    expect(src).not.toContain(overlayUniformNames(1).map)
  })

  it('caps at MAX_OUTPUT_LAYERS rather than exhausting texture units', () => {
    // WebGL guarantees only 8 fragment texture units, and each layer
    // wants two (map + palette LUT).
    const src = buildOutputFragmentShader(99)
    expect(src).toContain(overlayUniformNames(MAX_OUTPUT_LAYERS - 1).map)
    expect(src).not.toContain(overlayUniformNames(MAX_OUTPUT_LAYERS).map)
  })

  it('composites in array order, so array order is z-order', () => {
    const src = buildOutputFragmentShader(MAX_OUTPUT_LAYERS)
    const positions = Array.from({ length: MAX_OUTPUT_LAYERS }, (_, s) =>
      src.indexOf(`sampleOverlayLayer(${overlayUniformNames(s).map}`),
    )
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i - 1]).toBeLessThan(positions[i])
    }
  })

  it('keeps the ray-march equirectRtt tests cover byte-identical', () => {
    // The composition only replaces the shader's final write. If it
    // started rewriting the projection, equirectRtt's own tests would
    // no longer be testing what ships.
    const src = buildOutputFragmentShader(2)
    expect(src).toContain('float t = -b + sqrt(b * b - c);')
    expect(src).toContain('vec3 hit = uCameraOffset + t * dir;')
  })

  it('throws loudly if the equirect tail it splices onto changes', () => {
    // A silent no-op replace would ship a shader that renders the base
    // texture and ignores every layer.
    expect(OVERLAY_SAMPLE_GLSL).toContain('vec4 sampleOverlayLayer(')
    expect(() => buildOutputFragmentShader(1)).not.toThrow()
  })
})

describe('data-encoded handling', () => {
  it('looks values up in the palette LUT rather than colouring directly', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('texture2D(lut, vec2(texel.r, 0.5))')
  })

  it('applies no contrast or saturation to a measurement', () => {
    // Those knobs exist to make the Earth read well; on a data-encoded
    // layer they would silently rewrite every reported value, so the
    // sphere would disagree with the control window's readout.
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uContrast')
    expect(OVERLAY_SAMPLE_GLSL).not.toContain('uSaturation')
  })

  it('returns zero alpha outside a bbox so the layer contributes nothing', () => {
    expect(OVERLAY_SAMPLE_GLSL).toContain('return vec4(0.0);')
  })
})

describe('nightFactor', () => {
  it('is zero in full daylight and one well past the terminator', () => {
    expect(nightFactor(1, true)).toBe(0)
    expect(nightFactor(-1, true)).toBe(1)
  })

  it('rises monotonically through the terminator', () => {
    const samples = [0, -0.05, -0.1, -0.15, -0.2].map(n => nightFactor(n, true))
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1])
    }
    expect(samples[0]).toBe(0)
    expect(samples[samples.length - 1]).toBe(1)
  })

  it('matches the reversed-edge form the older shaders ship', () => {
    // `earthTileLayer` and `photorealEarth` both write
    // `smoothstep(0, -0.2, NdotL)`, which GLSL leaves **undefined**
    // for edge0 >= edge1 — it survives there because it was tested on
    // hardware, and this shader has not been. The polynomial is
    // symmetric about its midpoint, so the ascending form shipped here
    // is the identical curve. This is the proof of that, and therefore
    // the reason taking the defined one changes nothing but the risk.
    const reversed = (x: number): number => {
      const t = Math.max(0, Math.min(1, (x - 0) / (-0.2 - 0)))
      return t * t * (3 - 2 * t)
    }
    for (const x of [0.5, 0, -0.05, -0.13, -0.2, -0.5]) {
      expect(nightFactor(x, true)).toBeCloseTo(reversed(x), 10)
    }
  })

  it('is zero everywhere when day/night is off', () => {
    // The single gate: it collapses the darkening to a no-op multiply,
    // the lights to nothing and the clouds to their day colouring,
    // with no branch anywhere downstream.
    for (const x of [1, 0, -0.1, -1]) expect(nightFactor(x, false)).toBe(0)
  })
})

describe('decorateEarth', () => {
  const GREY = { r: 0.5, g: 0.5, b: 0.5 }
  const LIT = { r: 0.8, g: 0.7, b: 0.4 }
  // `cloudFade: 1` is the unzoomed default, so every case below reads
  // as it did before the fade existed; the fade has its own describe.
  const plain = (over = {}) => ({
    base: GREY, lights: { r: 0, g: 0, b: 0 }, cloudLuma: 0, cloudFade: 1, nightFactor: 0, ...over,
  })

  it('leaves a cloudless day side exactly as it found it', () => {
    expect(decorateEarth(plain())).toEqual(GREY)
  })

  it('darkens the night side', () => {
    const out = decorateEarth(plain({ nightFactor: 1 }))
    expect(out.r).toBeCloseTo(0.5 * 0.01, 10)
  })

  it('shows city lights only at night', () => {
    expect(decorateEarth(plain({ lights: LIT })).r).toBeCloseTo(GREY.r, 10)
    expect(decorateEarth(plain({ lights: LIT, nightFactor: 1 })).r).toBeGreaterThan(
      decorateEarth(plain({ nightFactor: 1 })).r,
    )
  })

  it('adds the lights after the darkening rather than through it', () => {
    // Order is earthTileLayer's pass order and it matters: darken
    // multiplies, lights add. Darkening the lights too would make the
    // city glow the darkening was making room for ~1% of itself.
    const out = decorateEarth(plain({ lights: LIT, nightFactor: 1 }))
    expect(out.r).toBeCloseTo(0.5 * 0.01 + 0.8 * 0.5, 10)
  })

  it('paints day clouds white and night clouds black', () => {
    const day = decorateEarth(plain({ cloudLuma: 1 }))
    const night = decorateEarth(plain({ cloudLuma: 1, nightFactor: 1 }))
    expect(day.r).toBeGreaterThan(GREY.r)
    expect(night.r).toBeLessThan(0.5 * 0.01 + 1e-9)
  })

  it('boosts night cloud alpha so thin cover still hides the lights', () => {
    const thin = 0.5
    const lit = plain({ lights: LIT, cloudLuma: thin, nightFactor: 1 })
    const clear = plain({ lights: LIT, nightFactor: 1 })
    // Same city, same thin cloud: at night it is dimmed more than the
    // day-side alpha alone would dim it. The day alpha runs through the
    // gamma, so it is computed rather than assumed.
    const dayAlpha = Math.pow(thin, 1.8) * 0.65
    expect(decorateEarth(lit).r).toBeLessThan(
      decorateEarth(clear).r * (1 - dayAlpha) + 1e-9,
    )
  })

  it('never lets cloud alpha exceed one', () => {
    const out = decorateEarth(plain({ base: { r: 1, g: 1, b: 1 }, cloudLuma: 1, nightFactor: 1 }))
    for (const c of [out.r, out.g, out.b]) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }
  })
})

describe('EARTH_DECORATION_GLSL', () => {
  // `decorateEarth` above is the tested implementation; this is its
  // hand-transcription into a string no test can execute without a GPU.
  // So these assert the load-bearing *terms* are present and in the
  // right order — the same standard the overlay GLSL is held to, and
  // the reason is the same: a dropped term compiles fine and is only
  // visible on a sphere nobody in this repo can see.

  it('darkens by the night constant and adds the lights by the strength one', () => {
    expect(EARTH_DECORATION_GLSL).toContain('mix(1.0, 0.0100, night)')
    expect(EARTH_DECORATION_GLSL).toContain('lights * night * 0.50')
  })

  it('adds the lights after the darkening multiply, not through it', () => {
    // Inverted, the city glow would be darkened to ~1% of itself by
    // the very pass that made room for it.
    const darken = EARTH_DECORATION_GLSL.indexOf('base * mix(1.0,')
    const lights = EARTH_DECORATION_GLSL.indexOf('colour += lights')
    expect(darken).toBeGreaterThanOrEqual(0)
    expect(lights).toBeGreaterThan(darken)
  })

  it('boosts night cloud alpha and clamps it to one', () => {
    expect(EARTH_DECORATION_GLSL).toContain('min(cloudAlpha * 2.50, 1.0)')
  })

  it('applies the suppressing gamma to the raw cloud luminance', () => {
    // 1.80, not photorealEarth's 0.55. Above 1 it suppresses thin
    // cover; below 1 it lifts it, and consuming that module's
    // pre-baked alpha here washed the whole day side grey on hardware.
    expect(EARTH_DECORATION_GLSL).toContain('pow(max(cloudLuma, 0.0), 1.80)')
  })

  it('gates the whole thing on one dayNight branch', () => {
    // The single gate: everything downstream is a multiply by zero, so
    // there is no second place for "day/night off" to be half-applied.
    expect(EARTH_DECORATION_GLSL).toContain('if (dayNight == 0) return 0.0;')
  })

  it('reads the hit point as the normal, with no separate normal input', () => {
    expect(EARTH_DECORATION_GLSL).toContain('dot(hit, sunDir)')
  })

  it('orders smoothstep\'s edges, because the reverse is undefined', () => {
    // GLSL: "results are undefined if edge0 >= edge1". Shipping the
    // reversed form in a shader nobody here can run is undefined
    // behaviour that happens to work on the drivers someone else
    // tested — not a property this output can rely on.
    expect(EARTH_DECORATION_GLSL).toContain('1.0 - smoothstep(-0.2, 0.0,')
    expect(EARTH_DECORATION_GLSL).not.toContain('smoothstep(0.0, -')
  })
})

describe('cloud coverage curve', () => {
  it('suppresses thin cover rather than lifting it', () => {
    // The regression in one number. A raw luminance of 0.3 is haze:
    // this curve makes it 12% of full opacity. photorealEarth's 0.55
    // gamma would make it 51%, and that texture spliced into this
    // opacity is what greyed out the oceans and, once the night boost
    // multiplied it, clamped the night side to solid black.
    const base = { r: 1, g: 1, b: 1 }
    const day = (luma: number): number =>
      decorateEarth({ base, lights: { r: 0, g: 0, b: 0 }, cloudLuma: luma, cloudFade: 1, nightFactor: 0 }).r
    // White base under white cloud is still white, so measure against a
    // dark base where the cloud's contribution is the whole signal.
    const dark = { r: 0, g: 0, b: 0 }
    const alphaAt = (luma: number): number =>
      decorateEarth({ base: dark, lights: dark, cloudLuma: luma, cloudFade: 1, nightFactor: 0 }).r
    expect(day(0)).toBe(1)
    expect(alphaAt(0.3)).toBeCloseTo(Math.pow(0.3, 1.8) * 0.65, 10)
    expect(alphaAt(0.3)).toBeLessThan(Math.pow(0.3, 0.55) * 0.65)
  })

  it('is zero for a clear sky, so a cloudless output is untouched', () => {
    const grey = { r: 0.5, g: 0.5, b: 0.5 }
    expect(
      decorateEarth({ base: grey, lights: { r: 0, g: 0, b: 0 }, cloudLuma: 0, cloudFade: 1, nightFactor: 0 }),
    ).toEqual(grey)
  })
})

describe('the terminator lands where the control globe puts it', () => {
  // earthTileLayer's convention pair, transcribed: `createSphereGeometry`
  // for the normal and `sunDirectionFromLatLng` for the sun. Both use
  // MapLibre's ECEF frame, which is *not* equirectRtt's — what has to
  // agree is the geographic answer, not the vectors.
  const controlDir = (lat: number, lon: number): [number, number, number] => {
    const a = (lat * Math.PI) / 180
    const b = (lon * Math.PI) / 180
    return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]
  }
  const controlNdotL = (lat: number, lon: number, sunLat: number, sunLon: number): number => {
    const n = controlDir(lat, lon)
    const l = controlDir(sunLat, sunLon)
    return n[0] * l[0] + n[1] * l[1] + n[2] * l[2]
  }
  // The output's: `hit` is the ray-march's landing point on the unit
  // sphere, which is `latLonToDirection` of its own lat/lon, and
  // `outputScene` builds uSunDir through that same function.
  const outputNdotL = (lat: number, lon: number, sunLat: number, sunLon: number): number => {
    const n = latLonToDirection(lat, lon)
    const l = latLonToDirection(sunLat, sunLon)
    return n.x * l.x + n.y * l.y + n.z * l.z
  }
  // What shipped before, and what it did: `photorealEarth` negates Z for
  // the globe *mesh*, so borrowing its vector into this frame mirrors
  // the terminator about Greenwich — 180 degrees out at a subsolar
  // longitude of -90, which is how it was reported from hardware.
  const borrowedNdotL = (lat: number, lon: number, sunLat: number, sunLon: number): number => {
    const n = latLonToDirection(lat, lon)
    const a = (sunLat * Math.PI) / 180
    const b = (sunLon * Math.PI) / 180
    const l = { x: Math.cos(a) * Math.cos(b), y: Math.sin(a), z: -Math.cos(a) * Math.sin(b) }
    return n.x * l.x + n.y * l.y + n.z * l.z
  }

  const SUBSOLAR: Array<[number, number]> = [
    [0, 0], [0, -90], [0, 90], [0, 180], [23.4, -75], [-23.4, 137], [12, -45],
  ]
  const SURFACE: Array<[number, number]> = [
    [0, 0], [0, -90], [0, 90], [0, 180], [45, -100], [-33, 151], [60, 30], [-60, -60],
    [89, 0], [-89, 12],
  ]

  it('agrees with earthTileLayer everywhere, for every subsolar point', () => {
    for (const [sunLat, sunLon] of SUBSOLAR) {
      for (const [lat, lon] of SURFACE) {
        expect(outputNdotL(lat, lon, sunLat, sunLon)).toBeCloseTo(
          controlNdotL(lat, lon, sunLat, sunLon), 12,
        )
        expect(nightFactor(outputNdotL(lat, lon, sunLat, sunLon), true)).toBeCloseTo(
          nightFactor(controlNdotL(lat, lon, sunLat, sunLon), true), 12,
        )
      }
    }
  })

  it('would not have, with photorealEarth\'s vector', () => {
    // The guard has to fail on the bug it was written for, or it is
    // pinning a coincidence. Subsolar at -90 makes the borrowed frame
    // exactly antipodal: the day side reads as night.
    expect(nightFactor(outputNdotL(0, -90, 0, -90), true)).toBe(0)
    expect(nightFactor(borrowedNdotL(0, -90, 0, -90), true)).toBe(1)
  })

  it('puts night on the far side of the subsolar meridian', () => {
    // The check an operator can make by eye against the control globe:
    // at a subsolar longitude of -90, the Americas are lit and Asia is
    // dark. Independent of either transcription above.
    const sunLon = -90
    expect(nightFactor(outputNdotL(0, -90, 0, sunLon), true)).toBe(0)
    expect(nightFactor(outputNdotL(0, -120, 0, sunLon), true)).toBe(0)
    expect(nightFactor(outputNdotL(0, 90, 0, sunLon), true)).toBe(1)
    expect(nightFactor(outputNdotL(0, 60, 0, sunLon), true)).toBe(1)
  })
})

describe('the cloud zoom fade', () => {
  // The ray length an output's centre pixel gets when the operator is
  // at `zoom`: the camera sits on the axis it is looking down, so the
  // focus is `1 - |offset|` away.
  const focusRayLength = (zoom: number): number => {
    const o = cameraOffsetForCamera(0, 0, zoom)
    return rayUnitSphereT(o, latLonToDirection(0, 0))
  }

  it('reports the operator\'s own zoom at the focus', () => {
    // The property the whole thing rests on: this is
    // `cameraOffsetForCamera`'s mapping inverted, so the centre of the
    // area of interest is at exactly the zoom the operator is at, and
    // the control globe's unmodified curve therefore agrees there by
    // construction rather than by two hand-matched numbers.
    for (const zoom of [0, 1, 2.5, 3, 4, 5]) {
      expect(localZoomAt(focusRayLength(zoom))).toBeCloseTo(zoom, 10)
    }
  })

  it('is unzoomed at the antipode however far the operator zooms', () => {
    // The reason this is per fragment rather than one uniform: the far
    // side of the sphere is *compressed* in the same frame the focus is
    // magnified in, so a single fade would strip clouds off a
    // three-quarters of the sphere that never zoomed at all.
    for (const zoom of [1, 3, 5, 20]) {
      const o = cameraOffsetForCamera(0, 0, zoom)
      const t = rayUnitSphereT(o, latLonToDirection(0, 180))
      expect(t).toBeGreaterThan(1)
      expect(localZoomAt(t)).toBe(0)
      expect(cloudZoomFade(localZoomAt(t))).toBe(1)
    }
  })

  it('costs a centred output nothing', () => {
    // Identity camera: every ray is length 1, so every pixel is at zoom
    // 0 and the clouds are exactly what they were before the fade.
    const o = cameraOffsetForCamera(0, 0, 0)
    for (const lon of [-180, -90, 0, 90]) {
      for (const lat of [-90, -30, 0, 60]) {
        const t = rayUnitSphereT(o, latLonToDirection(lat, lon))
        expect(t).toBeCloseTo(1, 12)
        expect(cloudZoomFade(localZoomAt(t))).toBe(1)
      }
    }
  })

  it('falls off monotonically from the focus to the antipode', () => {
    const o = cameraOffsetForCamera(0, 0, 5)
    let previous = -1
    // Walking away from the focus, the fade can only recover cover.
    for (const angle of [0, 30, 60, 90, 120, 150, 180]) {
      const t = rayUnitSphereT(o, latLonToDirection(0, angle))
      const fade = cloudZoomFade(localZoomAt(t))
      expect(fade).toBeGreaterThanOrEqual(previous)
      previous = fade
    }
    expect(previous).toBe(1)
  })

  it('matches the control globe\'s anchors', () => {
    // earthTileLayer: full cover at or below zoom 3, none at or above
    // zoom 6, linear between. Copied as a curve, not as a shape.
    expect(cloudZoomFade(0)).toBe(1)
    expect(cloudZoomFade(3)).toBe(1)
    expect(cloudZoomFade(4.5)).toBeCloseTo(0.5, 10)
    expect(cloudZoomFade(6)).toBe(0)
    expect(cloudZoomFade(20)).toBe(0)
  })

  it('bottoms out where MAX_CAMERA_OFFSET stops the projection', () => {
    // Not a shortfall in the fade: the cap means an output can never
    // show more than ~5.67 zoom levels of magnification, and ~11% is
    // what the control globe has left at 5.67 too. Pinned because the
    // alternative — rescaling the curve to end at the cap — is the
    // tempting "fix" and would put a second calibration in the repo.
    const capped = localZoomAt(1 - MAX_CAMERA_OFFSET)
    expect(capped).toBeCloseTo(1 / (1 - MAX_CAMERA_OFFSET) - 1, 10)
    expect(cloudZoomFade(capped)).toBeCloseTo(0.111, 3)
    // Zooming past the cap changes neither, because the offset clamps.
    expect(localZoomAt(focusRayLength(50))).toBeCloseTo(capped, 10)
  })

  it('multiplies the boosted alpha, as the raster path does', () => {
    // earthTileLayer applies `alpha *= vZoomFade` after the night mix.
    // The two orderings only differ where the boost's clamp bites, so
    // this uses cover thick enough to reach it: 0.9 luma boosts to 1.34
    // and clamps to 1, and half-fading that gives 0.5 — where folding
    // the fade in first would give 0.67, a zoomed night side keeping
    // cover a zoomed day side had lost.
    const dark = { r: 0, g: 0, b: 0 }
    const white = { r: 1, g: 1, b: 1 }
    // Alpha recovered from the composite: a black base under white day
    // cloud reads the alpha directly; at night the base darkens to 0.01
    // and the cloud is black, so it reads 0.01 * (1 - alpha).
    const dayAlpha = (cloudFade: number): number =>
      decorateEarth({ base: dark, lights: dark, cloudLuma: 0.9, cloudFade, nightFactor: 0 }).r
    const nightAlpha = (cloudFade: number): number =>
      1 -
      decorateEarth({ base: white, lights: dark, cloudLuma: 0.9, cloudFade, nightFactor: 1 }).r /
        0.01
    const unboosted = Math.pow(0.9, 1.8) * 0.65
    expect(dayAlpha(1)).toBeCloseTo(unboosted, 10)
    expect(unboosted * 2.5).toBeGreaterThan(1)
    expect(nightAlpha(1)).toBeCloseTo(1, 10)
    expect(nightAlpha(0.5)).toBeCloseTo(0.5, 10)
    expect(nightAlpha(0.5)).not.toBeCloseTo(unboosted * 0.5 * 2.5, 3)
    expect(dayAlpha(0.5)).toBeCloseTo(unboosted * 0.5, 10)
    expect(dayAlpha(0)).toBe(0)
  })
})

describe('the composed shader wires the fade to the ray march', () => {
  it('feeds the fade the ray-march distance, not a uniform', () => {
    // `t` is the hit distance the projection already computes. A
    // uniform here would be one zoom for a frame that holds several.
    const src = buildOutputFragmentShader(0)
    expect(src).toContain('float cloudFade = earthCloudZoomFade(t);')
    expect(src.indexOf('float t = -b + sqrt(b * b - c);')).toBeLessThan(
      src.indexOf('float cloudFade = earthCloudZoomFade(t);'),
    )
    expect(src).toContain('decorateEarth(colour, nightLights, cloudLuma, night, cloudFade)')
  })

  it('carries the control globe\'s anchors into the GLSL', () => {
    // The GLSL is a hand transcription of a tested function and cannot
    // be executed here, so the numbers that would silently diverge are
    // asserted as text — the same standard the overlay GLSL is held to.
    expect(EARTH_DECORATION_GLSL).toContain('1.0 / max(rayLength, 1e-4) - 1.0')
    expect(EARTH_DECORATION_GLSL).toContain('(localZoom - 3.0)')
    expect(EARTH_DECORATION_GLSL).toContain('/ 3.0')
    // Applied to the mixed alpha, after the night boost.
    expect(EARTH_DECORATION_GLSL).toContain('* cloudFade;')
  })
})

describe('the base colour grade', () => {
  // The ocean both surfaces actually start from — GIBS Blue Marble and
  // earth_diffuse are the same product and both read this exact value.
  const OCEAN = { r: 2 / 255, g: 5 / 255, b: 20 / 255 }

  it('crushes the ocean to blue, which is what it was tuned for', () => {
    // Contrast 1.10 pivots about 0.5, so values this far below it are
    // pushed further down and red/green clip to black; saturation 1.20
    // then pushes what survives away from the luma. The result is the
    // "deepen ocean blues" the setting's docstring claims.
    const g = gradeEarthBase(OCEAN)
    expect(g.r).toBe(0)
    expect(g.g).toBe(0)
    expect(g.b).toBeGreaterThan(0)
    expect(g.b).toBeGreaterThan(OCEAN.b * 0.5)
  })

  it('cannot invent colour in a grey', () => {
    // Saturation mixes toward the luma, so a neutral input stays
    // neutral however hard it is pushed. Guards against a channel
    // swap or a botched luma.
    const g = gradeEarthBase({ r: 0.6, g: 0.6, b: 0.6 })
    expect(g.r).toBeCloseTo(g.g, 12)
    expect(g.g).toBeCloseTo(g.b, 12)
  })

  it('pushes away from mid grey rather than toward it', () => {
    expect(gradeEarthBase({ r: 0.8, g: 0.8, b: 0.8 }).r).toBeGreaterThan(0.8)
    expect(gradeEarthBase({ r: 0.2, g: 0.2, b: 0.2 }).r).toBeLessThan(0.2)
  })

  it('stays inside the display range', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const g = gradeEarthBase({ r: v, g: 0, b: 1 - v })
      for (const c of [g.r, g.g, g.b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the atmosphere composite', () => {
  it('is the raster path\'s own blend, surface dimmed then scatter added', () => {
    // `scattered + bg x viewTransmittance`, which earthTileLayer gets
    // from blendFunc(ONE, SRC_ALPHA).
    const out = applyAtmosphere(
      { r: 0.4, g: 0.5, b: 0.6 },
      { r: 0.01, g: 0.02, b: 0.07, transmittance: 0.88 },
    )
    expect(out.r).toBeCloseTo(0.4 * 0.88 + 0.01, 12)
    expect(out.g).toBeCloseTo(0.5 * 0.88 + 0.02, 12)
    expect(out.b).toBeCloseTo(0.6 * 0.88 + 0.07, 12)
  })

  it('is the identity for a transparent atmosphere', () => {
    const colour = { r: 0.3, g: 0.4, b: 0.5 }
    expect(applyAtmosphere(colour, { r: 0, g: 0, b: 0, transmittance: 1 })).toEqual(colour)
  })

  it('turns a near-black ocean bluer rather than merely darker', () => {
    // The whole point, end to end: grade the real ocean value, then
    // composite a noon-zenith atmosphere over it, and check blue has
    // gained while red and green have not run away with it.
    const graded = gradeEarthBase({ r: 2 / 255, g: 5 / 255, b: 20 / 255 })
    const out = applyAtmosphere(graded, { r: 0.007, g: 0.021, b: 0.072, transmittance: 0.884 })
    expect(out.b).toBeGreaterThan(20 / 255)
    expect(out.b).toBeGreaterThan(out.g * 2)
    expect(out.g).toBeGreaterThan(out.r)
  })
})

describe('EARTH_ATMOSPHERE_GLSL', () => {
  it('reads the LUT at texel centres', () => {
    // 255.0 and 256.0 rather than a bare 0.5/+0.5 mapping; see
    // `nadirLutU`. Asserted as text because the GLSL cannot be run.
    expect(EARTH_ATMOSPHERE_GLSL).toContain('* 255.0 + 0.5)')
    expect(EARTH_ATMOSPHERE_GLSL).toContain('/ 256.0')
  })

  it('holds the sun overhead when day/night is off', () => {
    // Otherwise the scattering gradient would draw a terminator in
    // blue on a globe whose terminator was explicitly turned off.
    expect(EARTH_ATMOSPHERE_GLSL).toContain('dayNight == 1 ? dot(hit, sunDir) : 1.0')
  })

  it('composites surface-times-alpha plus scatter', () => {
    expect(EARTH_ATMOSPHERE_GLSL).toContain('colour * s.a + s.rgb')
  })

  it('is inert when no LUT is bound', () => {
    expect(EARTH_ATMOSPHERE_GLSL).toContain('if (hasAtmosphere == 0) return colour;')
  })
})

describe('the composed shader runs the passes in earthTileLayer\'s order', () => {
  // Read at zero layers, which is the only shader that carries the
  // treatment at all — see "the Earth treatment is idle-only" below.
  const src = buildOutputFragmentShader(0)
  // Order has to be read inside `main()`. Every helper is *defined*
  // above it — GLSL ES 1.00 has no forward declarations — so searching
  // the whole source finds definitions, not call sites, and compares
  // the preamble's order instead of the pipeline's.
  const body = src.slice(src.indexOf('void main()'))

  it('grades the base before anything composites onto it', () => {
    // Pass 0 runs first over there, on the raw tiles.
    expect(body).toContain('gradeEarthBase(texture2D(uSphereTexture, sphereUv).rgb)')
    expect(body.indexOf('gradeEarthBase(texture2D')).toBeLessThan(
      body.indexOf('colour = decorateEarth('),
    )
  })

  it('applies the atmosphere after the decoration', () => {
    // Pass 5 is drawn last over there, over the clouds.
    const decorate = body.indexOf('colour = decorateEarth(')
    const atmosphere = body.indexOf('colour = applyEarthAtmosphere(')
    expect(decorate).toBeGreaterThan(0)
    expect(decorate).toBeLessThan(atmosphere)
  })

  it('declares the atmosphere uniforms it samples', () => {
    expect(src).toContain('uniform sampler2D uAtmosphereLut;')
    expect(src).toContain('uniform int uHasAtmosphere;')
  })

  it('defines the helper before main, as GLSL ES 1.00 requires', () => {
    expect(src.indexOf('vec3 applyEarthAtmosphere(')).toBeLessThan(src.indexOf('void main()'))
  })
})

describe('the Earth treatment is idle-only', () => {
  // `earthTileLayer` gates its whole pass chain on `datasetActive` and
  // returns before any of it, so a control globe showing a dataset
  // shows an unlit, ungraded sphere — and a bbox dataset reveals raw
  // Blue Marble tiles outside its box. This path used to composite the
  // decoration *under* the layers instead, on the reasoning that
  // under-compositing meant day/night could never tint a dataset. That
  // holds only for opaque global coverage: a data-encoded overlay is
  // translucent by construction, so the terminator showed through the
  // smoke plume the argument used as its own example. Found on
  // hardware, rung 9 step 13.
  const withLayer = buildOutputFragmentShader(1)

  it('emits no grade, decoration or atmosphere once a layer exists', () => {
    for (const call of [
      'gradeEarthBase(',
      'earthNightFactor(',
      'decorateEarth(',
      'applyEarthAtmosphere(',
      'earthCloudZoomFade(',
    ]) {
      expect(withLayer).not.toContain(call)
    }
  })

  it('samples the sphere raw, the way the control globe leaves it', () => {
    const body = withLayer.slice(withLayer.indexOf('void main()'))
    expect(body).toContain('vec3 colour = texture2D(uSphereTexture, sphereUv).rgb;')
  })

  it('declares none of the decoration uniforms it no longer reads', () => {
    // Not cosmetic: a declared-but-unread sampler is the shape of a
    // pass someone reinstates by wiring a uniform back up, which is
    // exactly the regression this guards.
    for (const u of [
      'uSunDir',
      'uNightLightsMap',
      'uHasNightLights',
      'uCloudMap',
      'uHasCloud',
      'uAtmosphereLut',
      'uHasAtmosphere',
    ]) {
      expect(withLayer).not.toContain(`uniform sampler2D ${u};`)
      expect(withLayer).not.toContain(`uniform int ${u};`)
      expect(withLayer).not.toContain(`uniform vec3 ${u};`)
    }
  })

  it('still carries the whole treatment at zero layers', () => {
    // The idle output is the case the decoration exists for, and the
    // gate must not cost it anything.
    const idle = buildOutputFragmentShader(0)
    for (const call of [
      'gradeEarthBase(',
      'decorateEarth(',
      'applyEarthAtmosphere(',
      'earthCloudZoomFade(',
    ]) {
      expect(idle).toContain(call)
    }
  })
})
