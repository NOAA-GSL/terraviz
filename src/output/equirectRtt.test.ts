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
  MAX_CAMERA_OFFSET,
  IDENTITY_PARAMS,
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
  type Vec3,
} from './equirectRtt'

const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z)

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
      const params = { cameraOffset: { x: offset, y: 0, z: 0 }, split: false, rotationOffsetRad: 0 }
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
    const params = { cameraOffset: { x: 0.4, y: 0, z: 0 }, split: true, rotationOffsetRad: 0 }
    for (const u of [0.05, 0.2, 0.37, 0.49]) {
      const left = equirectSourceUv(u, 0.6, params)
      const right = equirectSourceUv(u + 0.5, 0.6, params)
      expect(right.u).toBeCloseTo(left.u, 10)
      expect(right.v).toBeCloseTo(left.v, 10)
    }
  })

  it('leaves the frame unsplit when split is off', () => {
    const params = { cameraOffset: { x: 0.4, y: 0, z: 0 }, split: false, rotationOffsetRad: 0 }
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
    const params = { cameraOffset: { x: 0, y: 0, z: 0 }, split: true, rotationOffsetRad: Math.PI }
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
    const zoomed = { cameraOffset: latLonToDirection(0, 0), split: false, rotationOffsetRad: 0 }
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
