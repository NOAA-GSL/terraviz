/**
 * Reading the value under the cursor on a data-encoded dataset.
 *
 * The globe already knows the lat/lon the pointer is over. This turns
 * that into a texel, reads one pixel of the current frame, and maps
 * its luma back to a physical value through the dataset's sidecar.
 * See `docs/DATA_ENCODED_VIDEO_PLAN.md` §Part 4.
 *
 * Everything except `sampleLumaAt` is pure, so the UV mapping — the
 * part most likely to be wrong, and least likely to look wrong — is
 * unit-testable without a GL context.
 */

import type { DatasetOverlayOptions } from '../types'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import { t } from '../i18n'
import { formatNumber } from '../i18n/format'

/** Normalised texture coordinates, origin at the image's top-left. */
export interface TexelUv {
  u: number
  v: number
}

/**
 * lat/lon → texture UV, mirroring the GLSL in the dataset shaders.
 *
 * Returns `null` when the point falls outside a regional dataset's
 * bounding box — the shader `discard`s there, and reporting a value
 * for a fragment that was never drawn would be worse than reporting
 * nothing.
 *
 * **The V axis is image-space here**, matching `earthTileLayer`'s
 * `v = (n - lat) / (n - s)` and full-globe `v = vUV.y`, i.e. v == 0
 * is the image's TOP row. The THREE renderers use the opposite
 * convention on the sphere (`photorealEarth.ts:584-588`) and flip on
 * the way in; callers reading a *texture* — which is what the
 * readout does — want this one. Getting the sign wrong mirrors the
 * data across the equator, which has happened twice in this
 * codebase.
 */
export function latLonToTexelUv(
  lat: number,
  lon: number,
  options?: DatasetOverlayOptions,
): TexelUv | null {
  const bbox = options?.boundingBox
  const flipY = options?.isFlippedInY === true

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    if (lat > n || lat < s) return null
    let u: number
    if (w <= e) {
      if (lon < w || lon > e) return null
      u = (lon - w) / (e - w)
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      const span = 360 - w + e
      if (lon >= w) u = (lon - w) / span
      else if (lon <= e) u = (lon + 360 - w) / span
      else return null
    }
    let v = (n - lat) / (n - s)
    if (flipY) v = 1 - v
    return { u, v }
  }

  const lonOrigin = typeof options?.lonOrigin === 'number' && Number.isFinite(options.lonOrigin)
    ? options.lonOrigin
    : 0
  // fract() in GLSL; JS `%` keeps the sign of the dividend, so add 1
  // before taking the remainder again.
  const raw = (lon - lonOrigin) / 360 + 0.5
  const u = ((raw % 1) + 1) % 1
  const vTop = (90 - lat) / 180
  return { u, v: flipY ? 1 - vTop : vTop }
}

/**
 * Sphere-geometry UV → lat/lon, for the VR globe.
 *
 * THREE populates `uv` on every raycast hit for free, and it is the
 * *mesh-local* texture coordinate — so it already accounts for however
 * far the user has spun the globe, and no inverse-quaternion step is
 * needed to recover the Earth-fixed point. That is why this is the
 * cheaper route into the readout than re-deriving from a world-space
 * ray.
 *
 * **The V convention here is THREE's, not the 2D globe's.**
 * `SphereGeometry` puts `uv.y == 1` at the north pole, the opposite of
 * `earthTileLayer`'s own sphere, which is why the two shaders carry
 * mirrored latitude expressions (`photorealEarth.ts:584-588`). Copying
 * the 2D form here mirrors the data across the equator — a failure
 * that has shipped twice in this codebase and looks entirely plausible
 * on screen. Latitude is therefore derived as `(v - 0.5) * 180` and
 * handed straight to `latLonToTexelUv`, which owns the conversion back
 * into image space, so the sign lives in exactly one place per
 * direction.
 */
export function sphereUvToLatLon(uv: { x: number; y: number }): { lat: number; lon: number } {
  return { lat: (uv.y - 0.5) * 180, lon: (uv.x - 0.5) * 360 }
}

/** A source the probe can read one texel out of. */
export type ProbeSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement

function sourceSize(source: ProbeSource): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth, height: source.naturalHeight }
  }
  return { width: source.width, height: source.height }
}

/**
 * Reads the luma (0-255) at a normalised UV, or null when there is
 * nothing to read.
 *
 * This is a seam, not an implementation. The shipped one is
 * `createGlLumaSampler` in `glLumaSampler.ts`, which reads through
 * WebGL because a 1×1 `drawImage` into a 2D canvas — the obvious
 * approach, and what this originally did — returns transformed values
 * on iOS Safari. See that module for the measurements.
 *
 * Whatever implements it must copy **one texel, not a frame**: a
 * full-frame read at 4096×2048 is 32 MB per pointer event, which on a
 * `mousemove` stream is not a slow path but a broken one.
 */
export type LumaSampler = (source: ProbeSource, uv: TexelUv) => number | null

/** Clamp a normalised UV onto the source's texel grid centres.
 *  Exported for tests; the GL sampler filters NEAREST so it does not
 *  need this, but the maths is worth pinning independently. */
export function uvToTexel(
  source: ProbeSource,
  uv: TexelUv,
): { sx: number; sy: number } | null {
  const { width, height } = sourceSize(source)
  if (!width || !height) return null
  return {
    sx: Math.min(width - 1, Math.max(0, Math.floor(uv.u * width))),
    sy: Math.min(height - 1, Math.max(0, Math.floor(uv.v * height))),
  }
}

export interface ProbeReading {
  /** The physical value, in `units`. */
  value: number
  units?: string
  /** True when the sample falls in the palette's no-data band, so the
   *  caller should say "no data" rather than print a number that
   *  happens to sit at the bottom of the range. */
  noData: boolean
}

/**
 * The full pointer → value path. Returns `null` when there is nothing
 * meaningful to report: not a data-encoded dataset, outside its bbox,
 * or no frame decoded yet.
 */
export function probeDatasetValue(
  lat: number,
  lon: number,
  source: ProbeSource,
  sample: LumaSampler,
  options: DatasetOverlayOptions | undefined,
): ProbeReading | null {
  const scale: ColorScale | undefined = options?.colorScale
  if (!scale) return null
  const uv = latLonToTexelUv(lat, lon, options)
  if (!uv) return null
  const luma = sample(source, uv)
  if (luma === null) return null
  return {
    value: lumaToValue(luma, scale),
    units: scale.units,
    noData: isTransparentLuma(luma, scale),
  }
}

/**
 * Render a reading for display, shared by the 2D lat/lon strip and the
 * in-VR HUD so the two never disagree about the same pixel.
 *
 * Significant digits rather than fixed decimals, because the same code
 * formats a smoke column in mg m-2 and a temperature in K, and a fixed
 * precision is wrong for at least one of them. A sample in the
 * palette's no-data band says so rather than printing a number that
 * happens to sit at the bottom of the range.
 */
export function formatProbeReading(reading: ProbeReading): string {
  if (reading.noData) return t('probe.noData')
  const value = formatNumber(reading.value, { maximumSignificantDigits: 3 })
  return reading.units
    ? t('probe.value', { value, units: reading.units })
    : t('probe.valueNoUnits', { value })
}

/** `wireToDataset` defaults every catalog row's bbox to worldwide, so
 *  a global dataset arrives carrying a box rather than no box. Treat
 *  that as the full-globe path — otherwise the bbox branch would
 *  re-derive the same UVs by a longer route and, at the poles, clip
 *  a row it should not. */
function isGlobalBbox(b: { n: number; s: number; w: number; e: number }): boolean {
  return b.n >= 90 && b.s <= -90 && b.w <= -180 && b.e >= 180
}
