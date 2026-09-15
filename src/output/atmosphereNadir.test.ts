// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's nadir scattering.
 *
 * The load-bearing one is `the column's optical depth does not depend
 * on the sun`: it is the observable consequence of the claim the whole
 * module rests on — that a nadir ray's integral is a function of one
 * variable — and it would fail loudly if someone reintroduced a
 * sun-dependent path length.
 */

import { describe, it, expect } from 'vitest'
import {
  ATMOSPHERE_HEIGHT_KM,
  RAYLEIGH_BETA,
} from '../services/atmosphereConstants'
import {
  NADIR_COLUMN_LENGTH_KM,
  NADIR_LUT_SIZE,
  buildNadirScatterLut,
  nadirLutU,
  nadirScatter,
  sampleNadirLut,
} from './atmosphereNadir'

describe('the nadir column', () => {
  it('is exactly the atmosphere height', () => {
    // `nadirScatter` skips the general ray-sphere intersection because
    // for a straight-down ray the bounds are known: the origin sits on
    // the atmosphere sphere (tNear = 0) and the planet is hit after
    // exactly one atmosphere height. If that stops being true the
    // hand-rolled bounds are wrong.
    expect(NADIR_COLUMN_LENGTH_KM).toBeCloseTo(ATMOSPHERE_HEIGHT_KM, 10)
  })

  it('does not depend on the sun for its optical depth', () => {
    // The claim in one assertion. View-side extinction integrates
    // density over altitude, and a nadir column's altitudes are the
    // same wherever the sun is — so transmittance is *constant* across
    // the whole sun-angle sweep. Only the in-scattered term varies.
    const at = [-1, -0.5, -0.1, 0, 0.25, 0.6, 1].map(s => nadirScatter(s).transmittance)
    for (const t of at) expect(t).toBeCloseTo(at[0], 12)
    expect(at[0]).toBeGreaterThan(0)
    expect(at[0]).toBeLessThan(1)
  })
})

describe('nadirScatter', () => {
  it('scatters blue hardest, which is the entire point', () => {
    // Rayleigh beta is [0.0058, 0.0135, 0.0331]: blue ~5.7x red. On a
    // near-black ocean the in-scattered term is not a tint on blue
    // water, it *is* the blue water.
    const c = nadirScatter(1)
    expect(c.b).toBeGreaterThan(c.g)
    expect(c.g).toBeGreaterThan(c.r)
    expect(RAYLEIGH_BETA[2] / RAYLEIGH_BETA[0]).toBeGreaterThan(5)
  })

  it('stays inside the calibration its own constants were tuned to', () => {
    // SUN_INTENSITY's docstring records that 3.0 was chosen to bring
    // "noon-zenith blue contribution down to ~0.05 per fragment". This
    // pins that the nadir path lands in that band rather than silently
    // drifting to a different exposure than the control globe's.
    const noon = nadirScatter(1)
    expect(noon.b).toBeGreaterThan(0.03)
    expect(noon.b).toBeLessThan(0.12)
  })

  it('falls monotonically as the sun sets', () => {
    let previous = Infinity
    for (const s of [1, 0.8, 0.6, 0.4, 0.2, 0.1, 0.05]) {
      const b = nadirScatter(s).b
      expect(b).toBeLessThan(previous)
      previous = b
    }
  })

  it('goes dark on the night side', () => {
    // The sun-transmittance LUT returns zero where the planet occludes
    // the light path, so the night hemisphere gets no in-scatter — no
    // blue haze over the city lights.
    for (const s of [-0.2, -0.5, -1]) {
      const c = nadirScatter(s)
      expect(c.r).toBeCloseTo(0, 6)
      expect(c.g).toBeCloseTo(0, 6)
      expect(c.b).toBeCloseTo(0, 6)
    }
  })

  it('clamps its input rather than extrapolating', () => {
    expect(nadirScatter(4)).toEqual(nadirScatter(1))
    expect(nadirScatter(-4)).toEqual(nadirScatter(-1))
  })

  it('inherits the shared tier\'s coarseness on purpose', () => {
    // 16 steps across a 100 km column with an 8 km scale height puts
    // most of the signal in about three samples, so the default reads
    // ~7% under a 128-step reference. That is *not* fixed here even
    // though this table is built once on the CPU and could afford any
    // step count: `ATMOSPHERE_STEPS_HIGH` is what the control globe
    // marches, and an output that integrated more finely would render
    // a measurably bluer ocean than the globe it exists to match.
    // Matching beats being 7% more right on a surface whose whole job
    // is to agree. Pinned so the trade is visible rather than assumed.
    const shared = nadirScatter(1, 16).b
    const reference = nadirScatter(1, 128).b
    const gap = (reference - shared) / reference
    expect(gap).toBeGreaterThan(0.02)
    expect(gap).toBeLessThan(0.12)
  })
})

describe('the LUT', () => {
  const pixels = buildNadirScatterLut()

  it('is one texel tall and 256 wide', () => {
    expect(pixels.length).toBe(NADIR_LUT_SIZE * 4)
  })

  it('maps the endpoints onto texel centres, not edges', () => {
    // Naive `sunCos * 0.5 + 0.5` reads texel -0.5 and 255.5 on a GPU,
    // both clamped — half a texel of sun angle lost at each end, right
    // where the terminator gradient is steepest.
    expect(nadirLutU(-1) * NADIR_LUT_SIZE).toBeCloseTo(0.5, 10)
    expect(nadirLutU(1) * NADIR_LUT_SIZE).toBeCloseTo(NADIR_LUT_SIZE - 0.5, 10)
  })

  it('round-trips the integral to 8-bit precision', () => {
    // The TS sampler mirrors what the shader's sampler does, so this
    // compares the two ends of the same lookup. One 8-bit step is
    // 1/255; allow two for the round and the lerp.
    for (const s of [1, 0.75, 0.5, 0.25, 0, -0.5, -1]) {
      const direct = nadirScatter(s)
      const viaLut = sampleNadirLut(pixels, s)
      expect(viaLut.r).toBeCloseTo(direct.r, 2)
      expect(viaLut.g).toBeCloseTo(direct.g, 2)
      expect(viaLut.b).toBeCloseTo(direct.b, 2)
      expect(viaLut.transmittance).toBeCloseTo(direct.transmittance, 2)
    }
  })

  it('carries transmittance in alpha, constant across every entry', () => {
    // Constant for the reason above — stored per entry anyway so the
    // shader needs no second uniform, and so a future non-nadir view
    // would not need a new channel.
    const alphas = new Set<number>()
    for (let i = 0; i < NADIR_LUT_SIZE; i++) alphas.add(pixels[i * 4 + 3])
    expect(alphas.size).toBe(1)
    expect([...alphas][0]).toBeGreaterThan(0)
    expect([...alphas][0]).toBeLessThan(255)
  })

  it('refuses a degenerate size rather than dividing by zero', () => {
    expect(() => buildNadirScatterLut(1)).toThrow(/size/)
  })
})
