// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Atmospheric scattering for the equirectangular output, as a
 * one-dimensional lookup.
 *
 * ## Why the output needs this at all
 *
 * Both surfaces start from the same base texture — `earth_diffuse_*`
 * and the control globe's GIBS `BlueMarble_NextGeneration` tiles are
 * the same product, and both have an ocean of `rgb(2, 5, 20)`, which
 * is very nearly black. **Blue Marble's blue is not in Blue Marble.**
 * On the control globe it comes from `earthTileLayer`'s pass 5, whose
 * shell sits at `ATMOSPHERE_RADIUS_FACTOR` (~1.0157) and therefore
 * covers the whole visible disc rather than a limb ring, compositing
 * as `scattered + background x viewTransmittance`. Rayleigh beta is
 * `[0.0058, 0.0135, 0.0331]`, so blue scatters ~5.7x harder than red
 * and the in-scattered term *is* the ocean's colour.
 *
 * Without it an output renders a near-black sea while the operator's
 * globe shows a blue one, which was reported from hardware as "the
 * main application window is much more blue".
 *
 * ## Why it is one variable, not a ray-march
 *
 * The plan's decoration table rules out "atmosphere shells" on an
 * unwrap. That is right about the *limb* and wrong about the *disc
 * tint*, and this module is the part that crosses.
 *
 * Fix the view direction to nadir — straight down at every point,
 * which is the one choice an unwrap can make without inventing a
 * viewer. Then for surface point `P` (a unit vector, and on this path
 * the ray-march's own hit point), take the ray from the top of
 * atmosphere above `P` pointing at `-P`. Every term of
 * `computeAtmosphereScattering` collapses:
 *
 * - `samplePos = P * (ATMOSPHERE_RADIUS - t)`, so
 *   `normalize(samplePos) === P` at every step.
 * - The sun-transmittance lookup keys on
 *   `dot(normalize(samplePos), sunDir)`, which is therefore
 *   `dot(P, sunDir)` — **constant down the whole column**.
 * - The view-side optical depths depend only on altitude, so only
 *   on `t`.
 * - Both phase functions key on `dot(rayDir, sunDir)`, which is
 *   `-dot(P, sunDir)`.
 *
 * So the entire result is a function of the single scalar
 * `s = dot(P, sunDir)`. Not approximately — exactly, for this
 * ray-march, which is single-scatter with no ground-albedo coupling
 * (read the loop in `buildAtmosphereRaymarchGlsl`: nothing in it
 * reads the surface).
 *
 * And `s` is a number the output shader already computes:
 * `earthNightFactor` takes it. So the scattering costs one texture
 * lookup into the 256x1 LUT this module builds, not a per-fragment
 * integration of 8.4 million columns.
 *
 * ## What this deliberately does not bring across
 *
 * Specular glint, the ground shadow and the sun sprite stay out, and
 * the reason is sharper than "they depend on a viewer". Ask what each
 * effect *becomes* at nadir: scattering becomes a smooth global
 * function of sun angle, which is meaningful everywhere. Specular
 * becomes a fixed bright spot at the subsolar point — the same "glare
 * spot painted onto a physical sphere" the plan rules out, just
 * reached by a different route. That is the test, and only this one
 * passes it.
 *
 * ## Two honest limits
 *
 * **Single-scatter.** At high sun-zenith angles the real sky is
 * brighter than this. The control globe has exactly the same
 * limitation, which is the point: the two agree because they share
 * these constants, rather than because either is right.
 *
 * **Nadir is a choice.** The control globe shows one viewer's
 * scattering, so the two match near the sub-viewer point and diverge
 * toward its limb. An unwrap has no viewer to match; nadir is what a
 * satellite directly overhead sees, which is the most defensible
 * reading of what every point of an unwrap is showing.
 *
 * Everything here is pure: no DOM, no GL, no Three. The constants and
 * the transmittance LUT are **imported** from
 * `services/atmosphereConstants` and `services/atmosphereLut` rather
 * than copied — unlike the four decoration scalars in `layerStack`,
 * which had to be hand-copied because their home imports MapLibre.
 * `atmosphereConstants` imports nothing at all, and `atmosphereLut`
 * imports only from it, so sharing them costs the output bundle
 * nothing and removes a whole class of drift.
 */

import {
  ATMOSPHERE_HEIGHT_KM,
  ATMOSPHERE_RADIUS_KM,
  ATMOSPHERE_STEPS_HIGH,
  MIE_BETA_EXT,
  MIE_BETA_SCATTER,
  MIE_G,
  MIE_SCALE_HEIGHT_KM,
  OZONE_BETA_ABS,
  OZONE_CENTER_HEIGHT_KM,
  OZONE_WIDTH_KM,
  PLANET_RADIUS_KM,
  RAYLEIGH_BETA,
  RAYLEIGH_SCALE_HEIGHT_KM,
  SUN_INTENSITY,
} from '../services/atmosphereConstants'
import { computeTransmittanceLut, type AtmosphereLutData } from '../services/atmosphereLut'

/**
 * Per-pass intensity, matching `earthTileLayer`'s `ATMOSPHERE_INTENSITY`.
 *
 * That one is module-private there, so this is the one value in this
 * file that *is* a copy. It is 1.0 on both sides, so drift would be
 * invisible until someone changed it — hence saying so here rather
 * than leaving a bare literal.
 */
export const OUTPUT_ATMOSPHERE_INTENSITY = 1.0

/** Entries in the nadir LUT. 256 keeps it a one-texel-tall RGBA
 *  texture of exactly 1 KiB, the same size as the palette LUTs the
 *  output already uploads. */
export const NADIR_LUT_SIZE = 256

/** Luminance weights for the scalar view-transmittance, matching the
 *  ray-march's own `dot(viewTransFinal, vec3(0.299, 0.587, 0.114))`. */
const LUMA: readonly [number, number, number] = [0.299, 0.587, 0.114]

/** One nadir column's result: in-scattered colour to add, and how
 *  much of the surface beneath survives the trip up. */
export interface NadirScatter {
  /** Post-ACES, post-intensity in-scattered RGB, each in [0, 1]. */
  r: number
  g: number
  b: number
  /** Scalar view transmittance in [0, 1] — multiply the surface by
   *  this before adding the scatter. */
  transmittance: number
}

function rayleighDensity(h: number): number {
  return Math.exp(-Math.max(h, 0) / RAYLEIGH_SCALE_HEIGHT_KM)
}
function mieDensity(h: number): number {
  return Math.exp(-Math.max(h, 0) / MIE_SCALE_HEIGHT_KM)
}
function ozoneDensity(h: number): number {
  return Math.max(0, 1 - Math.abs(h - OZONE_CENTER_HEIGHT_KM) / OZONE_WIDTH_KM)
}

function rayleighPhase(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu)
}
function cornetteShanksPhase(mu: number): number {
  const gg = MIE_G * MIE_G
  const num = 3 * (1 - gg) * (1 + mu * mu)
  const den = 8 * Math.PI * (2 + gg) * Math.pow(Math.max(1 + gg - 2 * MIE_G * mu, 1e-4), 1.5)
  return num / den
}

/** Narkowicz 2015 ACES approximation — the TS mirror of
 *  `ATMOSPHERE_GLSL_TONEMAP`, applied per fragment on the raster
 *  path and therefore per LUT entry here. */
function acesFilm(x: number): number {
  const a = 2.51
  const b = 0.03
  const c = 2.43
  const d = 0.59
  const e = 0.14
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)))
}

/**
 * Bilinear read of the shared transmittance LUT, matching what a GPU
 * sampler does to the same texture: `LINEAR` filtering with
 * clamp-to-edge, and the half-texel offset that goes with it.
 *
 * Nearest-neighbour would be simpler and would quietly disagree with
 * the control globe by up to half a texel of sun angle near the
 * terminator, which is exactly where the gradient is steepest.
 */
function sampleTransmittance(
  lut: AtmosphereLutData,
  altitudeKm: number,
  mu: number,
  out: [number, number, number],
): void {
  const u = mu * 0.5 + 0.5
  const v = Math.min(1, Math.max(0, altitudeKm / ATMOSPHERE_HEIGHT_KM))
  const fx = u * lut.width - 0.5
  const fy = v * lut.height - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const cx = (x: number): number => Math.min(lut.width - 1, Math.max(0, x))
  const cy = (y: number): number => Math.min(lut.height - 1, Math.max(0, y))
  const x1 = cx(x0 + 1)
  const y1 = cy(y0 + 1)
  const xa = cx(x0)
  const ya = cy(y0)

  for (let c = 0; c < 3; c++) {
    const p00 = lut.pixels[(ya * lut.width + xa) * 4 + c] / 255
    const p10 = lut.pixels[(ya * lut.width + x1) * 4 + c] / 255
    const p01 = lut.pixels[(y1 * lut.width + xa) * 4 + c] / 255
    const p11 = lut.pixels[(y1 * lut.width + x1) * 4 + c] / 255
    const top = p00 + (p10 - p00) * tx
    const bot = p01 + (p11 - p01) * tx
    out[c] = top + (bot - top) * ty
  }
}

/**
 * Integrate one nadir column for a given sun cosine.
 *
 * `sunCos` is `dot(surfaceNormal, sunDir)`: +1 with the sun directly
 * overhead, 0 at the geometric terminator, -1 at local midnight.
 *
 * The bounds are not searched for, because for a nadir ray they are
 * known: the origin sits *on* the atmosphere sphere, so `tNear` is 0,
 * and the planet is hit after exactly `ATMOSPHERE_HEIGHT_KM`. Running
 * the general ray-sphere intersection here would return those two
 * numbers and cost a square root to do it.
 */
export function nadirScatter(
  sunCos: number,
  steps: number = ATMOSPHERE_STEPS_HIGH.primarySteps,
  lut: AtmosphereLutData = computeTransmittanceLut(),
): NadirScatter {
  const s = Math.min(1, Math.max(-1, sunCos))
  const stepSize = ATMOSPHERE_HEIGHT_KM / steps

  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sumMR = 0
  let sumMG = 0
  let sumMB = 0
  let odR = 0
  let odM = 0
  let odO = 0
  const sunTrans: [number, number, number] = [0, 0, 0]

  for (let i = 0; i < steps; i++) {
    // Marching down from the top of atmosphere, so altitude falls.
    const h = ATMOSPHERE_HEIGHT_KM - (i + 0.5) * stepSize
    const dR = rayleighDensity(h)
    const dM = mieDensity(h)
    const dO = ozoneDensity(h)

    odR += dR * stepSize
    odM += dM * stepSize
    odO += dO * stepSize

    // Constant `mu` down the column — the property this whole module
    // rests on. See the header.
    sampleTransmittance(lut, h, s, sunTrans)

    const vR = Math.exp(-(RAYLEIGH_BETA[0] * odR + MIE_BETA_EXT[0] * odM + OZONE_BETA_ABS[0] * odO))
    const vG = Math.exp(-(RAYLEIGH_BETA[1] * odR + MIE_BETA_EXT[1] * odM + OZONE_BETA_ABS[1] * odO))
    const vB = Math.exp(-(RAYLEIGH_BETA[2] * odR + MIE_BETA_EXT[2] * odM + OZONE_BETA_ABS[2] * odO))

    sumR += dR * vR * sunTrans[0] * stepSize
    sumG += dR * vG * sunTrans[1] * stepSize
    sumB += dR * vB * sunTrans[2] * stepSize
    sumMR += dM * vR * sunTrans[0] * stepSize
    sumMG += dM * vG * sunTrans[1] * stepSize
    sumMB += dM * vB * sunTrans[2] * stepSize
  }

  // Phase angle for a downward ray: the sun cosine, negated.
  const pR = rayleighPhase(-s)
  const pM = cornetteShanksPhase(-s)
  const k = SUN_INTENSITY

  const tR = Math.exp(-(RAYLEIGH_BETA[0] * odR + MIE_BETA_EXT[0] * odM + OZONE_BETA_ABS[0] * odO))
  const tG = Math.exp(-(RAYLEIGH_BETA[1] * odR + MIE_BETA_EXT[1] * odM + OZONE_BETA_ABS[1] * odO))
  const tB = Math.exp(-(RAYLEIGH_BETA[2] * odR + MIE_BETA_EXT[2] * odM + OZONE_BETA_ABS[2] * odO))

  return {
    r: acesFilm(k * (pR * RAYLEIGH_BETA[0] * sumR + pM * MIE_BETA_SCATTER[0] * sumMR)) *
      OUTPUT_ATMOSPHERE_INTENSITY,
    g: acesFilm(k * (pR * RAYLEIGH_BETA[1] * sumG + pM * MIE_BETA_SCATTER[1] * sumMG)) *
      OUTPUT_ATMOSPHERE_INTENSITY,
    b: acesFilm(k * (pR * RAYLEIGH_BETA[2] * sumB + pM * MIE_BETA_SCATTER[2] * sumMB)) *
      OUTPUT_ATMOSPHERE_INTENSITY,
    transmittance: tR * LUMA[0] + tG * LUMA[1] + tB * LUMA[2],
  }
}

/**
 * Build the 256x1 RGBA LUT the output shader samples.
 *
 * Index maps `sunCos` from -1 at texel 0 to +1 at the last texel, so
 * the shader reads it at `dot(hit, sunDir) * 0.5 + 0.5` — the same
 * encoding the transmittance LUT uses for its own `mu` axis, and the
 * same value `earthNightFactor` is already handed.
 *
 * RGB carries the in-scattered colour and **A the transmittance**,
 * which is what makes the shader side a single `mix`-free line:
 * `colour = colour * lut.a + lut.rgb`. Packing transmittance into a
 * second texture would double the uploads to save nothing.
 *
 * **Built once and never rebuilt.** The sun's *position* never enters
 * this table — only its cosine, which the shader derives per fragment
 * from `uSunDir`. An earlier draft of this comment said the table was
 * rebuilt as the sun moved, which is the mistake the whole design
 * exists to avoid: a per-minute rebuild would burn a 256-entry
 * integration to reproduce the bytes it already holds.
 *
 * `steps` is a parameter rather than a constant because the control
 * globe picks its tier from `isMobile()` (`earthTileLayer.ts`), and an
 * output that hard-coded HIGH would integrate more finely than the
 * globe it exists to match on any touch-capable machine — rendering a
 * measurably bluer ocean, which is the exact failure this module is
 * here to fix. The caller reads the environment and passes the tier;
 * this module stays pure. The default is HIGH so a test need not.
 */
export function buildNadirScatterLut(
  size: number = NADIR_LUT_SIZE,
  steps: number = ATMOSPHERE_STEPS_HIGH.primarySteps,
): Uint8Array {
  if (size < 2) throw new Error(`[atmosphereNadir] size must be >= 2 (got ${size})`)
  const lut = computeTransmittanceLut()
  const pixels = new Uint8Array(size * 4)
  for (let i = 0; i < size; i++) {
    const sunCos = (i / (size - 1)) * 2 - 1
    const c = nadirScatter(sunCos, steps, lut)
    pixels[i * 4] = Math.round(Math.min(1, Math.max(0, c.r)) * 255)
    pixels[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255)
    pixels[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255)
    pixels[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, c.transmittance)) * 255)
  }
  return pixels
}

/**
 * Texture coordinate for a sun cosine, with the half-texel offset a
 * `LINEAR`-filtered 1-D LUT needs.
 *
 * The naive `sunCos * 0.5 + 0.5` lands half a texel off at both ends:
 * a GPU maps `u` to `u * size - 0.5`, so -1 would read texel -0.5 and
 * +1 texel 255.5, both clamped. Mapping onto texel *centres* instead
 * makes the endpoints exact, which is what lets the TS mirror and the
 * shader be asserted equal rather than approximately equal.
 */
export function nadirLutU(sunCos: number, size: number = NADIR_LUT_SIZE): number {
  const t = Math.min(1, Math.max(0, sunCos * 0.5 + 0.5))
  return (t * (size - 1) + 0.5) / size
}

/**
 * Read the built LUT the way the shader's sampler does — the TS
 * mirror, so a test can compare the two ends of the same lookup.
 */
export function sampleNadirLut(
  pixels: Uint8Array,
  sunCos: number,
  size: number = NADIR_LUT_SIZE,
): NadirScatter {
  const texel = nadirLutU(sunCos, size) * size - 0.5
  const i0 = Math.min(size - 1, Math.max(0, Math.floor(texel)))
  const i1 = Math.min(size - 1, i0 + 1)
  const f = texel - Math.floor(texel)
  const lerp = (c: number): number =>
    (pixels[i0 * 4 + c] + (pixels[i1 * 4 + c] - pixels[i0 * 4 + c]) * f) / 255
  return { r: lerp(0), g: lerp(1), b: lerp(2), transmittance: lerp(3) }
}

/**
 * The planet-radius sanity the nadir bounds assume, exported so a
 * test can assert it rather than a reader having to trust the
 * arithmetic in `nadirScatter`'s docstring.
 */
export const NADIR_COLUMN_LENGTH_KM = ATMOSPHERE_RADIUS_KM - PLANET_RADIUS_KM
