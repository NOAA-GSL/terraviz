// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the equirectangular RTT projection.
 *
 * The TS here mirrors GLSL nobody in this repo can run, so these cover
 * the properties that would be invisible on a sphere: that a centred
 * camera costs nothing, that every ray hits, that the warp moves the
 * right way, and that the shader source and its mirror have not
 * drifted apart.
 */

import { describe, it, expect } from 'vitest'
import { sphereUvToLatLon } from '../services/datasetProbe'
import {
  FRONT,
  MAX_CAMERA_OFFSET,
  IDENTITY_PARAMS,
  IDENTITY_ORIENTATION,
  applyOrientation,
  followCamera,
  followOrientation,
  foldSplitU,
  outputUvToLatLon,
  latLonToSphereUv,
  latLonToDirection,
  directionToLatLon,
  rayUnitSphereT,
  equirectSourceUv,
  cameraOffsetForCamera,
  EQUIRECT_UNIFORMS,
  EQUIRECT_FRAGMENT_SHADER,
  EQUIRECT_VERTEX_SHADER,
  type EquirectParams,
  type Mat3,
  type Vec3,
} from './equirectRtt'

const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z)
const toPoint = (uv: { u: number; v: number }) => ({ x: uv.u, y: uv.v })

describe('output UV convention', () => {
  it('agrees with the repo sphere-UV convention in datasetProbe', () => {
    // Asserted rather than imported: `datasetProbe` pulls the i18n
    // runtime, which has no business in the output bundle. This is
    // what keeps the duplicate honest.
    for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]]) {
      expect(outputUvToLatLon(u, v)).toEqual(sphereUvToLatLon({ x: u, y: v }))
    }
  })

  it('puts v=0 at the south pole, not the north', () => {
    // The sign that has been wrong twice in this codebase.
    expect(outputUvToLatLon(0.5, 0).lat).toBe(-90)
    expect(outputUvToLatLon(0.5, 1).lat).toBe(90)
  })

  it('round-trips through the sphere-UV inverse', () => {
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]]) {
      const { lat, lon } = outputUvToLatLon(u, v)
      const back = latLonToSphereUv(lat, lon)
      expect(back.u).toBeCloseTo(u, 12)
      expect(back.v).toBeCloseTo(v, 12)
    }
  })
})

describe('direction round-trip', () => {
  it('produces unit directions', () => {
    for (const [lat, lon] of [[0, 0], [45, 90], [-60, -170], [89.9, 179.9]]) {
      expect(len(latLonToDirection(lat, lon))).toBeCloseTo(1, 12)
    }
  })

  it('inverts back to the same lat/lon', () => {
    for (const [lat, lon] of [[0, 0], [45, 90], [-60, -170], [12.5, 34.25]]) {
      const back = directionToLatLon(latLonToDirection(lat, lon))
      expect(back.lat).toBeCloseTo(lat, 10)
      expect(back.lon).toBeCloseTo(lon, 10)
    }
  })
})

describe('ray / unit sphere', () => {
  it('returns 1 from the centre — the ray is already a unit vector', () => {
    const o = { x: 0, y: 0, z: 0 }
    expect(rayUnitSphereT(o, latLonToDirection(0, 0))).toBeCloseTo(1, 12)
    expect(rayUnitSphereT(o, latLonToDirection(37, -122))).toBeCloseTo(1, 12)
  })

  it('always hits, in every direction, right up to the cap', () => {
    // The property the shader relies on to have no miss branch. If
    // this ever fails, the far hemisphere clips instead of shrinking.
    const o = { x: MAX_CAMERA_OFFSET, y: 0, z: 0 }
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let lon = -180; lon < 180; lon += 15) {
        const t = rayUnitSphereT(o, latLonToDirection(lat, lon))
        expect(Number.isFinite(t)).toBe(true)
        expect(t).toBeGreaterThan(0)
      }
    }
  })

  it('lands exactly on the sphere', () => {
    const o = { x: 0.3, y: -0.2, z: 0.5 }
    const dir = latLonToDirection(20, 140)
    const t = rayUnitSphereT(o, dir)
    const hit = { x: o.x + t * dir.x, y: o.y + t * dir.y, z: o.z + t * dir.z }
    expect(len(hit)).toBeCloseTo(1, 12)
  })
})

describe('equirectSourceUv', () => {
  it('is the identity with a centred camera', () => {
    // A centred camera must cost nothing: the unzoomed sphere is a
    // uniform 1:1 unwrap, and any drift here warps the whole globe
    // before the operator has touched anything.
    for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.75, 0.9], [0.999, 0.001]]) {
      const out = equirectSourceUv(u, v, IDENTITY_PARAMS)
      expect(out.u).toBeCloseTo(u, 10)
      expect(out.v).toBeCloseTo(v, 10)
    }
  })

  it('stays inside the texture for every pixel at maximum offset', () => {
    const params = {
      cameraOffset: latLonToDirection(0, 0),
      orientation: IDENTITY_ORIENTATION,
      split: false,
      rotationOffsetRad: 0,
    }
    params.cameraOffset = {
      x: params.cameraOffset.x * MAX_CAMERA_OFFSET,
      y: params.cameraOffset.y * MAX_CAMERA_OFFSET,
      z: params.cameraOffset.z * MAX_CAMERA_OFFSET,
    }
    for (let u = 0; u <= 1; u += 0.05) {
      for (let v = 0; v <= 1; v += 0.05) {
        const out = equirectSourceUv(u, v, params)
        expect(out.u).toBeGreaterThanOrEqual(-1e-9)
        expect(out.u).toBeLessThanOrEqual(1 + 1e-9)
        expect(out.v).toBeGreaterThanOrEqual(-1e-9)
        expect(out.v).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('magnifies the hemisphere the camera moved toward', () => {
    // The whole point of the off-centre camera. Measure how much
    // output width is spent on the near hemisphere: it must grow.
    const nearHalfWidth = (offset: number) => {
      const params = { cameraOffset: { x: offset, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: false, rotationOffsetRad: 0 }
      let near = 0
      const step = 0.001
      for (let u = 0; u < 1; u += step) {
        const { lon } = sphereUvToLatLon({ x: equirectSourceUv(u, 0.5, params).u, y: 0.5 })
        if (Math.abs(lon) < 90) near += step
      }
      return near
    }
    // Camera toward lon 0, so |lon| < 90 is the near hemisphere.
    expect(nearHalfWidth(0)).toBeCloseTo(0.5, 2)
    expect(nearHalfWidth(0.5)).toBeGreaterThan(0.6)
    expect(nearHalfWidth(MAX_CAMERA_OFFSET)).toBeGreaterThan(nearHalfWidth(0.5))
  })

  it('split puts two copies of the projection in one frame', () => {
    const params = { cameraOffset: { x: 0.4, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: true, rotationOffsetRad: 0 }
    for (const u of [0.05, 0.2, 0.37, 0.49]) {
      const left = equirectSourceUv(u, 0.6, params)
      const right = equirectSourceUv(u + 0.5, 0.6, params)
      expect(right.u).toBeCloseTo(left.u, 10)
      expect(right.v).toBeCloseTo(left.v, 10)
    }
  })

  it('leaves the frame unsplit when split is off', () => {
    const params = { cameraOffset: { x: 0.4, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: false, rotationOffsetRad: 0 }
    expect(equirectSourceUv(0.2, 0.6, params).u).not.toBeCloseTo(
      equirectSourceUv(0.7, 0.6, params).u,
      6,
    )
  })
})

describe('foldSplitU', () => {
  it('passes U through untouched when off', () => {
    expect(foldSplitU(0.37, false)).toBe(0.37)
  })

  it('doubles the frequency when on', () => {
    expect(foldSplitU(0, true)).toBeCloseTo(0, 12)
    expect(foldSplitU(0.25, true)).toBeCloseTo(0.5, 12)
    expect(foldSplitU(0.5, true)).toBeCloseTo(0, 12)
    expect(foldSplitU(0.75, true)).toBeCloseTo(0.5, 12)
  })
})

describe('cameraOffsetForCamera', () => {
  it('is centred at zoom 0 — the full-Earth 1:1 state', () => {
    expect(len(cameraOffsetForCamera(0, 0, 0))).toBeCloseTo(0, 12)
  })

  it('grows with zoom and never exceeds the cap', () => {
    let previous = 0
    for (const zoom of [0.5, 1, 2, 4, 8, 16, 22]) {
      const mag = len(cameraOffsetForCamera(30, -90, zoom))
      expect(mag).toBeGreaterThanOrEqual(previous)
      expect(mag).toBeLessThanOrEqual(MAX_CAMERA_OFFSET + 1e-12)
      previous = mag
    }
  })

  it('points at the camera centre', () => {
    const offset = cameraOffsetForCamera(30, -90, 8)
    const back = directionToLatLon(offset)
    expect(back.lat).toBeCloseTo(30, 8)
    expect(back.lon).toBeCloseTo(-90, 8)
  })

  it('clamps a below-zero zoom instead of inverting through the sphere', () => {
    // The plan's snippet caps only the top. 1 - 1/(zoom+1) goes
    // negative below zoom 0 and diverges toward zoom -1, which would
    // put the camera on or outside the surface aimed at the antipode.
    for (const zoom of [-0.5, -0.9, -0.999, -1]) {
      const mag = len(cameraOffsetForCamera(10, 20, zoom))
      expect(Number.isFinite(mag)).toBe(true)
      expect(mag).toBeLessThanOrEqual(MAX_CAMERA_OFFSET + 1e-12)
    }
  })
})

describe('shader source', () => {
  it('declares every uniform the wiring will set', () => {
    // A misspelled uniform is silently ignored by WebGL and surfaces
    // as "the zoom does nothing", so pin the names to the source.
    for (const name of Object.values(EQUIRECT_UNIFORMS)) {
      expect(EQUIRECT_FRAGMENT_SHADER).toContain(name)
    }
  })

  it('passes UV from the vertex stage the fragment stage reads', () => {
    expect(EQUIRECT_VERTEX_SHADER).toContain('varying vec2 vUv')
    expect(EQUIRECT_FRAGMENT_SHADER).toContain('varying vec2 vUv')
  })

  it('has no miss branch, matching the always-hits property', () => {
    expect(EQUIRECT_FRAGMENT_SHADER).not.toContain('discard')
  })

  it('carries the rotation uniform, and the TS mirror applies it too', () => {
    // This was `not.toContain` until rung 14, guarding the deferral.
    // Inverted rather than deleted: what it was really protecting is
    // that the shader and `equirectSourceUv` stay one implementation,
    // so it now asserts both ends moved together.
    expect(EQUIRECT_FRAGMENT_SHADER).toContain('uRotationOffsetRad')
    expect(
      equirectSourceUv(0.5, 0.5, { ...IDENTITY_PARAMS, rotationOffsetRad: 1 }).u,
    ).not.toBeCloseTo(equirectSourceUv(0.5, 0.5, IDENTITY_PARAMS).u, 3)
  })
})

describe('the rotation offset (rung 14)', () => {
  const withRotation = (deg: number) => ({
    ...IDENTITY_PARAMS,
    rotationOffsetRad: (deg * Math.PI) / 180,
  })

  it('is the identity at zero', () => {
    // The property every other calibration claim rests on: an
    // installation that never calibrates must be byte-for-byte what it
    // was before this rung existed.
    for (const u of [0, 0.13, 0.5, 0.87, 1]) {
      for (const v of [0.1, 0.5, 0.9]) {
        const before = equirectSourceUv(u, v, IDENTITY_PARAMS)
        const after = equirectSourceUv(u, v, withRotation(0))
        expect(after.u).toBeCloseTo(before.u, 12)
        expect(after.v).toBeCloseTo(before.v, 12)
      }
    }
  })

  it('shifts the sampled longitude by exactly the offset', () => {
    // With a centred camera the projection is the identity, so the
    // whole effect is readable off one sample: the pixel that used to
    // show lon 0 now shows lon −90, which is the picture turning 90°
    // east on the sphere.
    const centreU = 0.5
    const plain = equirectSourceUv(centreU, 0.5, IDENTITY_PARAMS)
    const turned = equirectSourceUv(centreU, 0.5, withRotation(90))
    // u = lon/360 + 0.5, so a −90° sample lands a quarter turn back.
    expect(plain.u).toBeCloseTo(0.5, 10)
    expect(turned.u).toBeCloseTo(0.25, 10)
  })

  it('leaves latitude alone', () => {
    // It is a rotation about the polar axis. A version that touched
    // latitude would tilt the picture on the sphere, which is a
    // different and much worse mounting error than the one this fixes.
    for (const v of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const plain = equirectSourceUv(0.3, v, IDENTITY_PARAMS)
      const turned = equirectSourceUv(0.3, v, withRotation(137.5))
      expect(turned.v).toBeCloseTo(plain.v, 10)
    }
  })

  it('wraps a full turn back to nothing', () => {
    const full = equirectSourceUv(0.42, 0.6, withRotation(360))
    const none = equirectSourceUv(0.42, 0.6, IDENTITY_PARAMS)
    expect(full.u).toBeCloseTo(none.u, 9)
    expect(full.v).toBeCloseTo(none.v, 9)
  })

  it('turns BOTH halves of a split frame together', () => {
    // The reason the offset is applied to the longitude the fold
    // produced rather than to the fold's input. `foldSplitU` is
    // periodic in U with period ½, so rotating before it would make a
    // 180° offset a no-op — on exactly the installations most likely to
    // be running split mode.
    const params = { cameraOffset: { x: 0, y: 0, z: 0 }, orientation: IDENTITY_ORIENTATION, split: true, rotationOffsetRad: Math.PI }
    for (const u of [0.05, 0.2, 0.37, 0.49]) {
      const left = equirectSourceUv(u, 0.6, params)
      const right = equirectSourceUv(u + 0.5, 0.6, params)
      // Still two identical copies…
      expect(right.u).toBeCloseTo(left.u, 10)
      // …and both actually moved.
      const unturned = equirectSourceUv(u, 0.6, { ...params, rotationOffsetRad: 0 })
      expect(left.u).not.toBeCloseTo(unturned.u, 3)
    }
  })

  it('composes with the camera zoom rather than fighting it', () => {
    // The operator calibrates once and then zooms all day. A rotation
    // that only worked at a centred camera would drift the sphere's
    // alignment every time someone touched the control globe.
    const zoomed = { cameraOffset: latLonToDirection(0, 0), orientation: IDENTITY_ORIENTATION, split: false, rotationOffsetRad: 0 }
    zoomed.cameraOffset = {
      x: zoomed.cameraOffset.x * 0.5,
      y: zoomed.cameraOffset.y * 0.5,
      z: zoomed.cameraOffset.z * 0.5,
    }
    const turned = { ...zoomed, rotationOffsetRad: Math.PI / 2 }
    // Turning by 90° and asking for the pixel a quarter-frame along
    // must land where the unturned projection put the original pixel.
    const a = equirectSourceUv(0.5, 0.5, zoomed)
    const b = equirectSourceUv(0.75, 0.5, turned)
    expect(b.u).toBeCloseTo(a.u, 9)
    expect(b.v).toBeCloseTo(a.v, 9)
  })

  it('declares the uniform the shader reads', () => {
    // A misspelled uniform is silently ignored by WebGL and reads as
    // "the rotation does nothing" — the same trap `EQUIRECT_UNIFORMS`
    // exists for.
    expect(EQUIRECT_FRAGMENT_SHADER).toContain(`uniform float ${EQUIRECT_UNIFORMS.rotationOffset};`)
    expect(EQUIRECT_FRAGMENT_SHADER).toContain(`- ${EQUIRECT_UNIFORMS.rotationOffset};`)
  })
})

/**
 * The cameras every property below is swept over: the default, the
 * control globe's own default view, Antarctica, both poles (where north
 * is only defined by the meridian), the antimeridian from both sides,
 * and bearings from every quadrant including the half-turn.
 */
const CAMERAS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [38, -95, 0],
  [-80, 30, 0],
  [90, 0, 0],
  [-90, 45, 0],
  [12, 170, -60],
  [-45, -179, 135],
  [60, 10, 180],
]

const expectSameDirection = (a: Vec3, b: Vec3, digits = 10): void => {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
  expect(a.z).toBeCloseTo(b.z, digits)
}

/** The sphere-texture UV `equirectSourceUv` returned, as a direction —
 *  compared as directions because longitude means nothing at a pole. */
const sampledDirection = (uv: { u: number; v: number }): Vec3 => {
  const { lat, lon } = sphereUvToLatLon({ x: uv.u, y: uv.v })
  return latLonToDirection(lat, lon)
}

describe('followOrientation', () => {
  const det3 = (m: Mat3): number =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])

  it('is a rotation, never a mirror, everywhere including the poles', () => {
    // `latLonToDirection` is the mirror image of a right-handed Earth,
    // which is exactly how a hand-built turn ends up with determinant
    // −1: a sphere showing every coastline backwards, plausibly enough
    // that nobody in the room is sure.
    for (const [lat, lon, bearing] of CAMERAS) {
      const m = followOrientation(lat, lon, bearing)
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          // Columns orthonormal: MᵀM = I.
          const dot = m[i] * m[j] + m[3 + i] * m[3 + j] + m[6 + i] * m[6 + j]
          expect(dot).toBeCloseTo(i === j ? 1 : 0, 12)
        }
      }
      expect(det3(m)).toBeCloseTo(1, 12)
    }
  })

  it('brings the operator’s centre to the front', () => {
    for (const [lat, lon, bearing] of CAMERAS) {
      const m = followOrientation(lat, lon, bearing)
      expectSameDirection(applyOrientation(m, latLonToDirection(FRONT.lat, FRONT.lon)), latLonToDirection(lat, lon))
    }
  })

  it('puts the control globe’s top at the top of the front', () => {
    // The sphere's own north at the front is +Y, so that is what shows
    // the control globe's up: north at bearing 0, east at 90, south at
    // 180. Measured against finite differences of `latLonToDirection`
    // rather than the closed forms the implementation uses.
    const [lat, lon] = [30, 40]
    const h = 1e-6
    const at = latLonToDirection(lat, lon)
    const unit = (d: Vec3): Vec3 => {
      const n = len(d)
      return { x: d.x / n, y: d.y / n, z: d.z / n }
    }
    const towards = (p: Vec3): Vec3 => unit({ x: p.x - at.x, y: p.y - at.y, z: p.z - at.z })
    const north = towards(latLonToDirection(lat + h, lon))
    const east = towards(latLonToDirection(lat, lon + h))
    const top = (bearing: number) => applyOrientation(followOrientation(lat, lon, bearing), { x: 0, y: 1, z: 0 })
    expectSameDirection(top(0), north, 5)
    expectSameDirection(top(90), east, 5)
    expectSameDirection(top(180), { x: -north.x, y: -north.y, z: -north.z }, 5)
  })

  it('is the identity for the default camera, exactly', () => {
    // As the zoom's `1 − 1/(0 + 1)` is exactly 0: a freshly-booted
    // output must open on the uniform unwrap, not on one turned by
    // rounding.
    expect(followOrientation(0, 0, 0)).toEqual(IDENTITY_ORIENTATION)
  })

  it('reads a non-finite input as zero rather than blacking the sphere', () => {
    expect(followOrientation(Number.NaN, Number.NaN, Number.NaN)).toEqual(IDENTITY_ORIENTATION)
    expect(followOrientation(30, Number.POSITIVE_INFINITY, 20)).toEqual(followOrientation(30, 0, 20))
  })
})

describe('equirectSourceUv, following the operator camera', () => {
  const follow = (lat: number, lon: number, zoom: number, bearing: number) => ({
    ...IDENTITY_PARAMS,
    ...followCamera(lat, lon, zoom, bearing),
  })

  it('shows the operator’s centre at the front, at every zoom', () => {
    for (const [lat, lon, bearing] of CAMERAS) {
      for (const zoom of [0, 2, 6]) {
        expectSameDirection(
          sampledDirection(equirectSourceUv(0.5, 0.5, follow(lat, lon, zoom, bearing))),
          latLonToDirection(lat, lon),
          8,
        )
      }
    }
  })

  it('brings Antarctica round to the front, on the equator', () => {
    // What a zoom onto Antarctica could not do on its own: the pole sat
    // at the bottom of the sphere, magnified where nobody looks and, on
    // a projector rig, outside every projector's picture.
    const p = follow(-80, 0, 2, 0)
    expect(sphereUvToLatLon(toPoint(equirectSourceUv(0.5, 0.5, p))).lat).toBeCloseTo(-80, 8)
    // Down the front meridian, the pole itself is now just below the
    // front — ten degrees from the centre on the control globe, spread
    // wider by the zoom — and the sphere's bottom shows past it.
    let southmost = { lat: 90, v: 1 }
    for (let v = 0.005; v <= 0.5; v += 0.001) {
      const { lat } = sphereUvToLatLon(toPoint(equirectSourceUv(0.5, v, p)))
      if (lat < southmost.lat) southmost = { lat, v }
    }
    expect(southmost.lat).toBeLessThan(-89.5)
    expect(southmost.v).toBeGreaterThan(0.3)
    expect(sphereUvToLatLon(toPoint(equirectSourceUv(0.5, 0.005, p))).lat).toBeGreaterThan(-60)
  })

  it('shows the control globe’s picture the same way round, not mirrored', () => {
    // A step east on the sphere (u up) must show what is right of
    // centre on the control globe, and a step north (v up) what is
    // above it. Mirrored, the centre would still be right — the one
    // check above passes — and every coastline would run backwards.
    const [lat, lon] = [20, 50]
    const step = 0.002
    const centre = latLonToDirection(lat, lon)
    const offset = (bearing: number, du: number, dv: number) => {
      const d = sampledDirection(equirectSourceUv(0.5 + du, 0.5 + dv, follow(lat, lon, 0, bearing)))
      return { x: d.x - centre.x, y: d.y - centre.y, z: d.z - centre.z }
    }
    const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
    const north = { x: -Math.sin(lat * Math.PI / 180) * Math.cos(lon * Math.PI / 180), y: Math.cos(lat * Math.PI / 180), z: -Math.sin(lat * Math.PI / 180) * Math.sin(lon * Math.PI / 180) }
    const east = { x: -Math.sin(lon * Math.PI / 180), y: 0, z: Math.cos(lon * Math.PI / 180) }
    // North up: east is right, north is up.
    expect(dot(offset(0, step, 0), east)).toBeGreaterThan(0)
    expect(dot(offset(0, 0, step), north)).toBeGreaterThan(0)
    // East up (bearing 90): up shows east, and right shows south.
    expect(dot(offset(90, 0, step), east)).toBeGreaterThan(0)
    expect(dot(offset(90, step, 0), north)).toBeLessThan(0)
  })

  it('zooms the front whatever is turned to face it', () => {
    // The camera offset is the sphere's, so panning moves only the
    // turn — and the magnification at the front is the same for every
    // centre, poles included.
    const a = follow(38, -95, 3, 0)
    const b = follow(-90, 45, 3, 120)
    expect(a.cameraOffset).toEqual(b.cameraOffset)
    const front = latLonToDirection(FRONT.lat, FRONT.lon)
    expectSameDirection(a.cameraOffset, { x: front.x * 0.75, y: front.y * 0.75, z: front.z * 0.75 }, 12)
    // The frame's centre column is magnified: a small step there covers
    // less of the content than the same step does unzoomed.
    const spread = (p: EquirectParams) => {
      const l = sampledDirection(equirectSourceUv(0.49, 0.5, p))
      const r = sampledDirection(equirectSourceUv(0.51, 0.5, p))
      return Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z)
    }
    expect(spread(b)).toBeLessThan(spread(follow(-90, 45, 0, 120)) / 2)
    expect(spread(a)).toBeCloseTo(spread(b), 10)
  })

  it('puts the centre at both copies of a split frame', () => {
    // SOS's split puts the area of focus at U = 0.25 and 0.75; following
    // makes that true of wherever the operator is, not only of lon 0.
    const p = { ...follow(-60, 120, 2, 0), split: true }
    for (const u of [0.25, 0.75]) {
      expectSameDirection(sampledDirection(equirectSourceUv(u, 0.5, p)), latLonToDirection(-60, 120), 8)
    }
  })

  it('moves the front with the rotation offset', () => {
    // The offset says where the front is on a physical sphere: 90° east
    // puts the operator's centre a quarter-turn round, at U = 0.75.
    const p = { ...follow(-60, 120, 2, 30), rotationOffsetRad: Math.PI / 2 }
    expectSameDirection(sampledDirection(equirectSourceUv(0.75, 0.5, p)), latLonToDirection(-60, 120), 8)
  })
})

describe('the orientation in the shader', () => {
  it('turns the landing point after the march and before it becomes a texel', () => {
    // After: the camera offset is the sphere's, so the march has to run
    // in the sphere's frame. Before `hitLat`: everything from there on —
    // the texel, and the decoration `layerStack` composites onto this
    // pass — reads the content's point, where the sun is.
    const march = EQUIRECT_FRAGMENT_SHADER.indexOf('vec3 hit = uCameraOffset + t * dir;')
    const turn = EQUIRECT_FRAGMENT_SHADER.indexOf(`hit = ${EQUIRECT_UNIFORMS.orientation} * hit;`)
    const texel = EQUIRECT_FRAGMENT_SHADER.indexOf('float hitLat')
    expect(march).toBeGreaterThan(-1)
    expect(turn).toBeGreaterThan(march)
    expect(texel).toBeGreaterThan(turn)
    expect(EQUIRECT_FRAGMENT_SHADER).toContain(`uniform mat3 ${EQUIRECT_UNIFORMS.orientation};`)
  })
})
