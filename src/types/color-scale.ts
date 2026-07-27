/**
 * The data-encoded video sidecar — the palette and scale that turn a
 * grayscale frame back into colour and numbers at display time.
 *
 * Shared by the publisher API (`functions/`), the SPA renderers
 * (`src/services/`), and the publisher portal, so the shape is defined
 * once here rather than three times. See
 * `docs/DATA_ENCODED_VIDEO_PLAN.md`.
 *
 * A data-encoded dataset ships frames whose luma *is* the normalised
 * value: black is `vmin` (and no data), white is `vmax`. Nothing in
 * the frame says what that means, so the row carries this alongside —
 * the palette to colour it with, the range to scale it by, and the
 * units to report it in.
 *
 * Everything here is pure and dependency-free: it is imported by
 * Workers code, by browser code, and by tests.
 */

/** The only encoding defined so far. A dataset whose `renderEncoding`
 *  is absent is a picture and takes every path it takes today. */
export const RENDER_ENCODING_DATA_LUMA = 'data-luma'

export type RenderEncoding = typeof RENDER_ENCODING_DATA_LUMA

/** Width of the LUT the shaders sample. 256 because the source is an
 *  8-bit luma channel — a wider LUT cannot express more. */
export const COLOR_SCALE_LUT_SIZE = 256

/** Length cap on the stored JSON. Generous next to `probing_info`'s
 *  4096 because a palette can legitimately carry a stop per code
 *  value, and ~256 stops serialise to roughly 10 KB. */
export const COLOR_SCALE_MAX_CHARS = 16_384

/** One palette stop. `t` is the normalised position in [0,1]; `rgba`
 *  is 0-255 per channel, alpha included, because the palettes zyra
 *  reads (`--cmap-file`) carry their own transparency. */
export interface ColorScaleStop {
  t: number
  rgba: [number, number, number, number]
}

export interface ColorScale {
  /** Ascending by `t`, at least two entries. */
  stops: ColorScaleStop[]
  /** Physical value at luma 0. */
  vmin: number
  /** Physical value at luma 255. */
  vmax: number
  /** Unit label for the readout, e.g. `mg m-2`. */
  units?: string
  /**
   * Normalised width at the bottom of the range that is forced fully
   * transparent. The published smoke pipeline uses 12/256 ≈ 0.047:
   * values that low are indistinguishable from "nothing measured here"
   * and drawing them produces a haze over the whole globe.
   */
  transparentRange?: number
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function parseStop(raw: unknown): ColorScaleStop | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { t, rgba } = raw as { t?: unknown; rgba?: unknown }
  if (!isFiniteNumber(t) || t < 0 || t > 1) return null
  if (!Array.isArray(rgba) || rgba.length !== 4) return null
  const channels: number[] = []
  for (const c of rgba) {
    if (!isFiniteNumber(c) || c < 0 || c > 255) return null
    channels.push(c)
  }
  return { t, rgba: [channels[0], channels[1], channels[2], channels[3]] }
}

/**
 * Parse an untrusted sidecar into a `ColorScale`, or `null`.
 *
 * Fail-closed on purpose: a malformed sidecar returns `null`, the
 * caller treats the dataset as a picture, and the viewer sees raw
 * grayscale rather than confidently-wrong colours over a plausible
 * palette. Accepts either a JSON string (how D1 stores it) or an
 * already-parsed object (how the wire delivers it).
 */
export function parseColorScale(input: unknown): ColorScale | null {
  let raw: unknown = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { stops, vmin, vmax, units, transparentRange } = raw as Record<string, unknown>
  if (!Array.isArray(stops) || stops.length < 2) return null
  if (!isFiniteNumber(vmin) || !isFiniteNumber(vmax) || vmin === vmax) return null

  const parsed: ColorScaleStop[] = []
  for (const s of stops) {
    const stop = parseStop(s)
    if (!stop) return null
    parsed.push(stop)
  }
  // Sort rather than reject: stop order is a serialisation detail and
  // an out-of-order palette is still fully determined.
  parsed.sort((a, b) => a.t - b.t)

  const scale: ColorScale = { stops: parsed, vmin, vmax }
  if (typeof units === 'string' && units.trim() !== '') scale.units = units
  if (isFiniteNumber(transparentRange) && transparentRange > 0 && transparentRange < 1) {
    scale.transparentRange = transparentRange
  }
  return scale
}

/**
 * Expand a `ColorScale` into the RGBA LUT the shaders sample —
 * `COLOR_SCALE_LUT_SIZE` texels, 4 bytes each, indexed by luma.
 *
 * Interpolation is linear between adjacent stops, in straight
 * (non-premultiplied) 8-bit space, which is what the shader's
 * `mix(base, palette, alpha)` expects.
 */
export function buildColorScaleLut(scale: ColorScale): Uint8Array {
  const lut = new Uint8Array(COLOR_SCALE_LUT_SIZE * 4)
  const { stops } = scale
  // Below `transparentRange` nothing was measured; force alpha to 0
  // rather than trusting the palette's own low end, which frequently
  // ramps up from a small but non-zero alpha.
  const cutoff = scale.transparentRange ?? 0
  let si = 0
  for (let i = 0; i < COLOR_SCALE_LUT_SIZE; i++) {
    const t = i / (COLOR_SCALE_LUT_SIZE - 1)
    while (si < stops.length - 2 && stops[si + 1].t < t) si++
    const a = stops[si]
    const b = stops[si + 1] ?? a
    const span = b.t - a.t
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0
    const o = i * 4
    for (let c = 0; c < 4; c++) {
      lut[o + c] = Math.round(a.rgba[c] + (b.rgba[c] - a.rgba[c]) * f)
    }
    if (t < cutoff) lut[o + 3] = 0
  }
  return lut
}

/**
 * Recover the physical value from a sampled luma code (0-255).
 *
 * The inverse of what zyra's writer does: it normalised against
 * `vmin`/`vmax` and never autoscaled per frame, precisely so this
 * mapping is the same for every frame in the dataset.
 */
export function lumaToValue(luma: number, scale: ColorScale): number {
  return scale.vmin + (luma / 255) * (scale.vmax - scale.vmin)
}

/** Whether a sampled luma falls in the region the palette declares to
 *  be "nothing measured here". */
export function isTransparentLuma(luma: number, scale: ColorScale): boolean {
  const cutoff = scale.transparentRange ?? 0
  return luma / 255 < cutoff
}
