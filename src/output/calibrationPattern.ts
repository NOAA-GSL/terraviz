// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The calibration test pattern an operator aligns a physical sphere
 * against (`docs/MULTI_MONITOR_PLAN.md` §3 "Calibration tooling", rung
 * 14b) — the thing rung 14a's rotation offset turns.
 *
 * ## Why it is a texture and not a shader
 *
 * The plan sizes this as "~80 LOC GLSL" and it is built as a 2:1 canvas
 * instead, for a reason that is about *what is being calibrated* rather
 * than about convenience. A pattern drawn inside the fragment shader
 * would bypass `layerStack`'s sampling entirely — its bbox clipping,
 * its `lonOrigin` shift, its `isFlippedInY`, the whole path a real
 * dataset's pixels travel — so it could land perfectly while the
 * dataset path was wrong, which is the one failure a calibration
 * pattern exists to rule out. As a canvas it is installed in an
 * ordinary overlay slot and travels that path exactly, so a pattern
 * that lands right proves a dataset will.
 *
 * The convenience is real too, and the plan half-predicted it: the pole
 * labels, the anchor names, the longitude scale and the live resolution
 * readout are **glyphs**, which are miserable in GLSL and one
 * `fillText` on a canvas.
 *
 * ## The split
 *
 * Geometry is pure and the painting is thin, the shape `voiceVad` and
 * `playbackSettle` use. `buildCalibrationPattern` returns primitives in
 * **normalised UV**, so every question with a wrong answer — is the
 * prime meridian at u = 0.5, is the north pole at v = 0, does the
 * antimeridian appear at both edges — is answerable with no canvas, no
 * 2D context and no GL. `paintCalibrationPattern` walks the list and
 * does nothing else.
 *
 * ## V is image space
 *
 * `v = 0` is the image's **top** row and therefore the north edge,
 * matching `datasetProbe.latLonToTexelUv` — the canonical mirror of the
 * shader maths — and matching how an equirectangular image is stored.
 * It is the opposite of `layerStack`'s shader-space V, and that is not
 * a discrepancy: THREE uploads with `flipY`, so a canvas authored top
 * row first arrives at the shader the same way a dataset image does.
 * Getting this backwards puts the whole pattern in the wrong hemisphere
 * while leaving it looking plausible, which the probe's own docstring
 * records as having shipped twice.
 *
 * ## Deliberately not translated
 *
 * Degree markings, compass letters and a pixel count, read by an
 * operator standing at a sphere — the same category as the debug HUD,
 * and `check:i18n-strings` scans `src/ui/` rather than `src/output/`.
 * The panel's *toggle*, which a curator sees, is translated.
 */

import type { DatasetOverlayOptions } from '../types'

/**
 * The overlay the pattern is installed with: identity geometry, and an
 * identity that says what it is.
 *
 * Every geometric field is left absent deliberately rather than written
 * out as its default — no `boundingBox`, no `lonOrigin`, no
 * `isFlippedInY`, no `colorScale`. The pattern is authored *in* the
 * coordinates `latLonToUv` defines, which are the coordinates a
 * defaulted overlay produces, so stating them again would create a
 * second place for the two to disagree. It also means the pattern
 * exercises `layerStack`'s ordinary path rather than a special case of
 * it, which is the whole argument for making it a texture.
 *
 * `datasetId` / `datasetTitle` are carried because they are why
 * `overlay` is required at all (see `mirrorState.overlayForMirror`): a
 * frame has to be able to say what it is without asking app state.
 */
export const CALIBRATION_OVERLAY: DatasetOverlayOptions = {
  // i18n-exempt: an operator-facing machine label on the sphere itself,
  // the same category as the debug HUD's field names.
  datasetId: '__terraviz_calibration__',
  datasetTitle: 'Calibration pattern',
}

/** Longest edge the pattern is drawn at, whatever the framebuffer is.
 *
 *  An 8192-wide canvas is 134 MB of backing store plus as much again
 *  once uploaded, on hardware the plan already found can silently land
 *  on an integrated GPU — and it buys nothing that matters here. What
 *  is being calibrated is *where* a line falls, and a bilinear-sampled
 *  4096 pattern places every line within half a framebuffer pixel of
 *  its true position at 8192. The readout still names the framebuffer,
 *  because that is the number the operator is confirming. */
export const MAX_PATTERN_WIDTH = 4096

/** Ordinary graticule spacing, in degrees, both axes. */
const GRATICULE_STEP_DEG = 30

/** Half-height of the grayscale band, in degrees of latitude. */
const RAMP_HALF_HEIGHT_DEG = 9

/** Centre latitude of each colour-bar band. */
const BAR_LAT_DEG = 30
/** Half-height of a colour-bar band, in degrees. */
const BAR_HALF_HEIGHT_DEG = 6

/** Latitude of the resolution / rotation readout. */
const READOUT_LAT_DEG = 16.5
/** Latitude of the longitude scale. */
const LON_SCALE_LAT_DEG = -16.5
/** Latitude the pole letters are drawn at.
 *
 *  Not at the pole itself: an equirectangular row at ±90° smears across
 *  the entire top or bottom edge of the sphere, so a letter drawn there
 *  is unreadable by construction. 78° is inside the polar cap and still
 *  legible. */
const POLE_LABEL_LAT_DEG = 78

/** Longitudes the readout, the pole letters and the anchors repeat at.
 *
 *  A sphere is walked around. One readout at the prime meridian is
 *  invisible from the other side of the rig, and an operator checking
 *  an alignment is standing wherever the mounting hardware lets them. */
const REPEAT_LONS_DEG = [-180, -90, 0, 90] as const

const COLOR = {
  background: '#101014',
  graticule: '#4a4a55',
  /** The equator, and the one line whose latitude the sphere's own
   *  seam should coincide with. */
  equator: '#ffb000',
  /** The prime meridian — what the rotation offset aims. */
  primeMeridian: '#00d0ff',
  /** The antimeridian, which is where the texture's own seam falls. A
   *  third colour because a seam artefact and a mis-set rotation look
   *  identical if both edges are drawn the same. */
  antimeridian: '#ff45c8',
  text: '#ffffff',
  anchor: '#ffffff',
} as const

/**
 * The classic eight bars, brightest first.
 *
 * Reversed in the southern band, and that asymmetry is the point: two
 * identical bands are invariant under a vertical flip, so the one
 * orientation error this pattern most needs to expose would be
 * invisible. The pole letters say it too; two independent statements of
 * the same fact is cheap here.
 */
const COLOR_BARS = [
  '#ffffff',
  '#ffff00',
  '#00ffff',
  '#00ff00',
  '#ff00ff',
  '#ff0000',
  '#0000ff',
  '#000000',
] as const

/** Eight equal steps from black to white, for checking a projector's
 *  gamma and its black and white clipping in one glance. */
const GRAY_STEPS = 8

/** A filled axis-aligned box in normalised UV. */
export interface PatternRect {
  u0: number
  v0: number
  u1: number
  v1: number
  fill: string
}

/** A stroked segment in normalised UV. `widthPx` is in *pattern*
 *  pixels, so a line stays the same thickness on every rung. */
export interface PatternLine {
  u0: number
  v0: number
  u1: number
  v1: number
  stroke: string
  widthPx: number
}

/** A label in normalised UV, positioned by its own centre. */
export interface PatternText {
  u: number
  v: number
  text: string
  fill: string
  /** Fraction of the pattern's *height*, so type scales with the rung
   *  rather than shrinking into invisibility at 8192. */
  sizeV: number
}

export interface CalibrationPattern {
  rects: readonly PatternRect[]
  lines: readonly PatternLine[]
  texts: readonly PatternText[]
}

export interface CalibrationPatternOptions {
  /** What the *window* is rendering at. Reported, not drawn at — see
   *  {@link MAX_PATTERN_WIDTH}. */
  framebufferWidth: number
}

/**
 * **Why the rotation offset is not in the readout**, which is the first
 * thing a reader will look for, given that rung 14a's rotation is what
 * this pattern exists to serve.
 *
 * Two reasons, and the second is the decisive one.
 *
 * It would make the pattern a function of a value that changes
 * *continuously*. The panel's slider commits on `input`, so one drag is
 * dozens of commits, and each would redraw a 4096×2048 canvas and
 * re-upload it — tens of milliseconds apiece, which is the "stutter a
 * sphere in front of an audience" failure `datasetMirror`'s reload rule
 * is written against, arriving through a different door.
 *
 * And it is redundant, and worse than what is already here. The
 * longitude scale under the equator turns *with* the sphere, so the
 * operator reads the rotation off whichever label has arrived at the
 * physical mark they are aligning to — continuously, at the sphere,
 * without looking back at a panel. That is the measurement they want; a
 * number echoing what they typed a moment ago is not.
 *
 * The upshot is that the pattern depends on the framebuffer width
 * alone, so it is rebuilt only when the operator changes a rung.
 */

/**
 * Latitude/longitude → normalised UV, image space.
 *
 * The same mapping `datasetProbe.latLonToTexelUv` applies for a global,
 * prime-meridian, unflipped dataset — which is exactly the overlay this
 * pattern is installed with, so the two agree by construction rather
 * than by two hand-matched formulas.
 *
 * Longitude is **not** wrapped. A caller asking for −180 and one asking
 * for +180 mean the same meridian and want it drawn at opposite edges,
 * so collapsing them here would silently delete half of the seam.
 */
export function latLonToUv(lat: number, lon: number): { u: number; v: number } {
  return { u: lon / 360 + 0.5, v: (90 - lat) / 180 }
}

/**
 * The four equatorial cardinal points, which are what a rotation offset
 * actually moves.
 *
 * Deliberately the projection's own landmarks rather than geographic
 * ones: there is no coastline in a test pattern to compare a city
 * against, and what an operator aligns is a meridian against a physical
 * mark on the rig.
 */
export const CALIBRATION_ANCHORS: readonly { lat: number; lon: number; label: string }[] = [
  { lat: 0, lon: 0, label: '0°' },
  { lat: 0, lon: 90, label: '90°E' },
  { lat: 0, lon: -90, label: '90°W' },
  // Both edges, not one. The antimeridian is a single meridian that an
  // equirectangular image cuts in half, so a crosshair drawn only at
  // u = 1 loses the half that falls at u = 0 — and on a sphere those
  // two halves are the same mark, which is precisely the join an
  // operator is checking for a seam.
  { lat: 0, lon: 180, label: '180°' },
  { lat: 0, lon: -180, label: '180°' },
]

/** Longitude labels for the scale under the equator, one per meridian. */
function longitudeLabel(lon: number): string {
  if (lon === 0) return '0'
  if (lon === 180 || lon === -180) return '180'
  return `${Math.abs(lon)}${lon > 0 ? 'E' : 'W'}`
}

/**
 * Every primitive the pattern is made of, in draw order.
 *
 * Order is z-order: the background, then the bands, then the graticule
 * over them, then the coloured reference lines over that, then text
 * last. The equator line crossing the grayscale ramp is intentional —
 * it marks the ramp's centre, and a hairline costs a ramp nothing.
 */
export function buildCalibrationPattern(opts: CalibrationPatternOptions): CalibrationPattern {
  const rects: PatternRect[] = []
  const lines: PatternLine[] = []
  const texts: PatternText[] = []

  rects.push({ u0: 0, v0: 0, u1: 1, v1: 1, fill: COLOR.background })

  // --- The grayscale ramp, centred on the equator ---
  const rampTop = latLonToUv(RAMP_HALF_HEIGHT_DEG, 0).v
  const rampBottom = latLonToUv(-RAMP_HALF_HEIGHT_DEG, 0).v
  for (let i = 0; i < GRAY_STEPS; i++) {
    const level = Math.round((255 * i) / (GRAY_STEPS - 1))
    rects.push({
      u0: i / GRAY_STEPS,
      v0: rampTop,
      u1: (i + 1) / GRAY_STEPS,
      v1: rampBottom,
      fill: `rgb(${level}, ${level}, ${level})`,
    })
  }

  // --- Colour bars, north in order and south reversed ---
  for (const sign of [1, -1] as const) {
    const centre = BAR_LAT_DEG * sign
    const top = latLonToUv(centre + BAR_HALF_HEIGHT_DEG, 0).v
    const bottom = latLonToUv(centre - BAR_HALF_HEIGHT_DEG, 0).v
    const bars = sign === 1 ? COLOR_BARS : [...COLOR_BARS].reverse()
    bars.forEach((fill, i) => {
      rects.push({
        u0: i / bars.length,
        v0: top,
        u1: (i + 1) / bars.length,
        v1: bottom,
        fill,
      })
    })
  }

  // --- Graticule ---
  for (let lon = -180; lon <= 180; lon += GRATICULE_STEP_DEG) {
    const isPrime = lon === 0
    const isSeam = lon === 180 || lon === -180
    const { u } = latLonToUv(0, lon)
    lines.push({
      u0: u,
      v0: 0,
      u1: u,
      v1: 1,
      stroke: isPrime ? COLOR.primeMeridian : isSeam ? COLOR.antimeridian : COLOR.graticule,
      widthPx: isPrime || isSeam ? 5 : 2,
    })
  }
  for (let lat = -90 + GRATICULE_STEP_DEG; lat <= 90 - GRATICULE_STEP_DEG; lat += GRATICULE_STEP_DEG) {
    const { v } = latLonToUv(lat, 0)
    lines.push({
      u0: 0,
      v0: v,
      u1: 1,
      v1: v,
      stroke: lat === 0 ? COLOR.equator : COLOR.graticule,
      widthPx: lat === 0 ? 5 : 2,
    })
  }

  // --- Anchor crosshairs ---
  const crossHalfU = 0.012
  const crossHalfV = 0.024
  for (const anchor of CALIBRATION_ANCHORS) {
    const { u, v } = latLonToUv(anchor.lat, anchor.lon)
    lines.push({
      u0: u - crossHalfU,
      v0: v,
      u1: u + crossHalfU,
      v1: v,
      stroke: COLOR.anchor,
      widthPx: 4,
    })
    lines.push({
      u0: u,
      v0: v - crossHalfV,
      u1: u,
      v1: v + crossHalfV,
      stroke: COLOR.anchor,
      widthPx: 4,
    })
  }

  // --- Longitude scale, so a turned sphere can be read off rather
  //     than estimated ---
  const scaleV = latLonToUv(LON_SCALE_LAT_DEG, 0).v
  for (let lon = -180; lon <= 180; lon += GRATICULE_STEP_DEG) {
    texts.push({
      u: latLonToUv(0, lon).u,
      v: scaleV,
      text: longitudeLabel(lon),
      fill: COLOR.text,
      sizeV: 0.022,
    })
  }

  // --- Pole letters and the readout, repeated around ---
  const readoutV = latLonToUv(READOUT_LAT_DEG, 0).v
  const width = Math.max(0, Math.round(opts.framebufferWidth))
  const readout = `${width} × ${Math.round(width / 2)}`
  for (const lon of REPEAT_LONS_DEG) {
    const { u } = latLonToUv(0, lon)
    texts.push({ u, v: readoutV, text: readout, fill: COLOR.text, sizeV: 0.026 })
    texts.push({
      u,
      v: latLonToUv(POLE_LABEL_LAT_DEG, 0).v,
      text: 'N',
      fill: COLOR.text,
      sizeV: 0.05,
    })
    texts.push({
      u,
      v: latLonToUv(-POLE_LABEL_LAT_DEG, 0).v,
      text: 'S',
      fill: COLOR.text,
      sizeV: 0.05,
    })
  }

  return { rects, lines, texts }
}

/** The subset of `CanvasRenderingContext2D` the painter touches, so a
 *  test can record it without the global canvas stub growing a method
 *  per primitive kind. */
export interface PatternContext {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  font: string
  textAlign: string
  textBaseline: string
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
}

/**
 * Walk the primitives onto a context. No decisions — every one of them
 * was made in {@link buildCalibrationPattern}, where they are testable.
 *
 * A rect is snapped outward to whole pixels so adjacent bars in a ramp
 * cannot leave a background-coloured hairline between them, which on a
 * grayscale wedge reads as a banding artefact in the projector.
 */
export function paintCalibrationPattern(
  ctx: PatternContext,
  pattern: CalibrationPattern,
  width: number,
  height: number,
): void {
  for (const r of pattern.rects) {
    ctx.fillStyle = r.fill
    const x = Math.floor(r.u0 * width)
    const y = Math.floor(r.v0 * height)
    ctx.fillRect(x, y, Math.ceil(r.u1 * width) - x, Math.ceil(r.v1 * height) - y)
  }

  for (const l of pattern.lines) {
    ctx.strokeStyle = l.stroke
    ctx.lineWidth = l.widthPx
    ctx.beginPath()
    ctx.moveTo(l.u0 * width, l.v0 * height)
    ctx.lineTo(l.u1 * width, l.v1 * height)
    ctx.stroke()
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const t of pattern.texts) {
    ctx.fillStyle = t.fill
    const size = Math.max(1, Math.round(t.sizeV * height))
    ctx.font = `600 ${size}px monospace`
    ctx.fillText(t.text, t.u * width, t.v * height)
  }
}

/**
 * The pattern as something the scene can upload, or `null` when a 2D
 * context cannot be had.
 *
 * `null` rather than a throw, and rather than a blank canvas: the
 * caller's fallback is to leave whatever was on the sphere alone, and a
 * black texture would be indistinguishable from the dropped-upload
 * failure the 1 Hz floor exists to surface.
 */
/** Holds one built pattern so the output does not redraw ~8M pixels
 *  every time something else about the frame changes. */
export interface CalibrationCache {
  /** The pattern for this framebuffer rung, rebuilding only if the rung
   *  moved or the last attempt failed. `null` when it cannot be built. */
  canvasFor(framebufferWidth: number): HTMLCanvasElement | null
}

/**
 * The pattern's lifecycle, which has three wrong answers available and
 * so does not belong inline in the output's composition.
 *
 * **Rebuild on the rung, not on the recomposite.** The composite is
 * rebuilt on every dataset load, palette change and layer change, and
 * building a pattern is a 4096×2048 fill — doing it there would redraw
 * and re-upload the whole canvas for changes that cannot affect it.
 *
 * **A failure is not cached.** The width is recorded only when a canvas
 * came back, so a 2D context that could not be had (a browser that lost
 * its canvas backend, a memory ceiling) is retried the next time the
 * operator toggles, rather than being remembered as a permanent `null`
 * for the life of the window.
 *
 * **Nothing is discarded when calibration goes off.** It is at most
 * 33 MB, an operator toggling it is comparing the pattern against the
 * content and will toggle straight back, and rebuilding on each flip
 * puts a visible pause on a control whose whole value is an instant
 * A/B.
 */
export function createCalibrationCache(
  build: (opts: CalibrationPatternOptions) => HTMLCanvasElement | null = createCalibrationCanvas,
): CalibrationCache {
  let canvas: HTMLCanvasElement | null = null
  let builtFor = 0
  return {
    canvasFor(framebufferWidth) {
      if (canvas && framebufferWidth === builtFor) return canvas
      canvas = build({ framebufferWidth })
      if (canvas) builtFor = framebufferWidth
      return canvas
    },
  }
}

export function createCalibrationCanvas(
  opts: CalibrationPatternOptions,
): HTMLCanvasElement | null {
  const width = Math.min(MAX_PATTERN_WIDTH, Math.max(2, Math.round(opts.framebufferWidth)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round(width / 2)
  const ctx = canvas.getContext('2d') as unknown as PatternContext | null
  if (!ctx) return null
  paintCalibrationPattern(ctx, buildCalibrationPattern(opts), canvas.width, canvas.height)
  return canvas
}
