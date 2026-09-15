// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's dataset overlay and multi-shell layer stack.
 *
 * This is the half of the output renderer that decides *what colour a
 * point on the sphere is*; `equirectRtt.ts` decides *which point a
 * pixel shows*. `buildOutputFragmentShader` composes the two.
 *
 * ## The maths here is not new, and must not be
 *
 * Placing a dataset on a sphere means bbox clipping, a `lonOrigin`
 * shift, a `isFlippedInY` flip, and — for a data-encoded dataset — a
 * palette lookup through a 256×1 LUT. All four already exist twice in
 * this repo: as GLSL in `photorealEarth.ts`'s `map_fragment` override,
 * and as the pure TS mirror `datasetProbe.latLonToTexelUv`.
 *
 * Both carry scar tissue worth reading before touching anything below.
 * The shader's own comment records that the expression was copied from
 * `earthTileLayer` with latitude inverted, "so a regional dataset
 * rendered into the mirrored hemisphere — a US bbox landing over the
 * South Pacific". `datasetProbe`'s records that an inverted V "has
 * shipped twice in this codebase". This is exactly the boring,
 * expensive class of bug the plan's Prior-art section says an
 * independent re-derivation would reproduce.
 *
 * So the GLSL below is written to match `photorealEarth`'s, and
 * `overlaySampleUv` mirrors it in TypeScript — and the tests assert
 * that mirror agrees with `datasetProbe.latLonToTexelUv`, which is the
 * canonical mirror of the same shader. Agreement is asserted rather
 * than imported so the output bundle does not pull the i18n runtime in
 * through `datasetProbe`; the test is what keeps the duplicate honest.
 *
 * **The better end state, not done here:** extract one GLSL snippet
 * that `photorealEarth` and this module both `#include`, so there is
 * literally one string. That means editing a shader shared by VR,
 * Orbit and the thumbnail generator — a production refactor with a
 * real regression surface and a moving visual baseline. It deserves
 * its own commit rather than riding along on a ladder rung.
 *
 * ## The shell stack is not shells here
 *
 * The plan describes stacked sphere meshes at radii 1.000 / 1.001 /
 * 1.002, and Open Question 8 asks whether they z-fight at 4K+. On the
 * equirect path that question does not arise: there are no meshes and
 * no depth buffer, so layers composite in array order inside one
 * fragment shader. Array order *is* z-order, exactly as the protocol
 * says. Worth recording as an open question the projection answers for
 * free rather than one still owed a test.
 */

import type { DatasetOverlayOptions } from '../types'
import { SHADER_DEFAULTS } from '../services/shaderSettingsService'
import { NADIR_LUT_SIZE } from './atmosphereNadir'
import { EQUIRECT_FRAGMENT_SHADER } from './equirectRtt'

/**
 * How many overlay layers one output composites.
 *
 * Bounded by fragment texture units, not by taste: WebGL guarantees
 * only 8. Count them — the base sphere (1), the two Earth-decoration
 * maps rung 12c added (night lights, clouds), then each layer's
 * texture *and* its palette LUT. The non-layer samplers are four,
 * not three — `uSphereTexture` plus the night-lights, cloud and
 * atmosphere maps — so `4 + 2n <= 8`, and n is 2. The cap is
 * unchanged by that correction, but the arithmetic is what a
 * future change would reason from, and `3 + 2n` would licence a
 * third slot that fails to link on the guaranteed 8 units.
 *
 * It was 4, on the reasoning that four layers "matches the control
 * window's own 4-globe ceiling". That arithmetic was already wrong
 * before the decoration — `1 + 2*4` is 9, one past the guarantee, so a
 * driver reporting exactly 8 would have failed to *link* the shader —
 * and the reasoning behind it conflated two different things: a
 * 4-globe layout is four panels holding one dataset each, and an
 * output mirrors one panel, not all four. Lowering it costs nothing
 * that exists: `layers` has no producer at all (see the plan's smoke
 * step 14a), so every shipped composite is the dataset alone.
 */
export const MAX_OUTPUT_LAYERS = 2

/**
 * Day/night constants, mirrored from `earthTileLayer`'s three raster
 * passes (`darkenFragSrc`, `lightsFragSrc`, `cloudsFragSrc`) — the
 * closest prior art there is, because that path is also a raster globe
 * shading from `dot(N, uSunDir)` with no PBR chain to borrow.
 *
 * **Copied rather than imported, and the reason is the bundle.**
 * `earthTileLayer` is a MapLibre `CustomLayerInterface`; importing it
 * here would pull MapLibre into the output bundle, which exists to
 * render one quad. Same trade `overlaySampleUv` makes against
 * `datasetProbe` — except that one is pinned by a test, and four
 * scalars cannot be, so the guard here is weaker: drift shows up as an
 * output whose night side does not match the control globe's.
 */
const NIGHT_DARKENING = 0.01
const NIGHT_LIGHT_STRENGTH = 0.5
const CLOUD_OPACITY = 0.65
/**
 * Luminance-to-alpha curve for the cloud asset, `earthTileLayer`'s.
 *
 * Above 1, so it *suppresses* thin cover: `pow(0.3, 1.8)` is 0.12
 * where the raw luminance was 0.3. That matters because the source is
 * not black over clear sky, and the first version of this composite
 * consumed `photorealEarth`'s canvas-baked alpha instead, which uses
 * **0.55** — below 1, so it lifts the same 0.3 to 0.51. Splicing that
 * texture into this opacity turned a light haze into a ~30% white wash
 * over the whole day side, greyed the oceans out, and — once the night
 * boost multiplied it — clamped the night side to solid black. One
 * module's calibration end to end; never half of each.
 */
const CLOUD_ALPHA_GAMMA = 1.8
/** Night-side clouds are boosted so even thin cover blocks the city
 *  lights underneath, rather than letting them glow through. */
const CLOUD_NIGHT_ALPHA_BOOST = 2.5

/**
 * The cloud zoom-fade anchors, in operator zoom levels.
 * `earthTileLayer`'s, unchanged: full cover at or below the first,
 * none at or above the second.
 *
 * The cloud asset is one global texture, so magnifying a patch of it
 * magnifies its blur — past a point it is a fuzzy grey wash sitting
 * over basemap detail that is genuinely sharper underneath, which is
 * why the control globe dissolves it on the way in.
 */
const CLOUD_FADE_START_ZOOM = 3
const CLOUD_FADE_END_ZOOM = 6

/**
 * The base colour grade, `earthTileLayer`'s pass 0.
 *
 * **Imported, not copied** — unlike the four decoration scalars
 * above, whose home pulls MapLibre. `shaderSettingsService` imports
 * one type and nothing else, so taking its defaults costs the output
 * bundle nothing and removes two numbers that would otherwise drift.
 *
 * The *defaults*, deliberately, not the live values: the dev shader
 * tuner can change them at runtime on the control window and nothing
 * mirrors that over the link, so reading live state here would make
 * an output disagree with a globe nobody else can reproduce. If those
 * ever become an operator-facing control they belong on the wire.
 */
const BASE_CONTRAST = SHADER_DEFAULTS.contrast
const BASE_SATURATION = SHADER_DEFAULTS.saturation

/** Rec. 709 luma, the weights every pass in both renderers uses. */
const LUMA_R = 0.299
const LUMA_G = 0.587
const LUMA_B = 0.114

/**
 * How far past the geometric terminator the night side reaches full
 * darkness, in units of `dot(normal, sunDir)`. Twilight, in effect.
 *
 * Named rather than inlined because both the TS mirror and the GLSL
 * have to use the same edge, and the two write it with opposite signs.
 */
const TERMINATOR_SOFTNESS = 0.2

/**
 * How much of the sphere is in night, 0 (full day) to 1.
 *
 * Written as `1 - smoothstep(-S, 0, NdotL)` with the edges in
 * **ascending** order. `earthTileLayer` and `photorealEarth` both ship
 * the reversed form, `smoothstep(0, -S, NdotL)`, and the first draft
 * here mirrored them on the reasoning that copying a shipped
 * expression leaves nothing to prove equal. But GLSL leaves
 * `smoothstep` **undefined** when `edge0 >= edge1`: every driver this
 * repo has met computes the general formula and gets the right answer,
 * which is exactly why the reversed form survives in shaders that were
 * tested on hardware — and this one has not been. The polynomial is
 * symmetric about its midpoint, so the two are the same curve; taking
 * the defined one costs nothing and removes undefined behaviour from
 * the one shader nobody here can run. A test pins them equal.
 *
 * `dayNight` off returns 0, which is the whole gate: it collapses the
 * darkening to a no-op multiply, the night lights to nothing, and the
 * clouds to their day colouring, with no branch anywhere below.
 */
export function nightFactor(ndotL: number, dayNight: boolean): number {
  if (!dayNight) return 0
  const t = Math.max(0, Math.min(1, (ndotL + TERMINATOR_SOFTNESS) / TERMINATOR_SOFTNESS))
  return 1 - t * t * (3 - 2 * t)
}

/**
 * The operator zoom this fragment is showing, from its ray length.
 *
 * The projection's zoom is a warp, so "how zoomed in is this?" has a
 * different answer at every pixel — which is the whole point of doing
 * the cloud fade here rather than as one uniform: on the control globe
 * the whole viewport is at one zoom, while on an output the focus is
 * magnified and the antipode is compressed *in the same frame*, and a
 * single fade would either keep the wash over the magnified part or
 * strip clouds off the three-quarters of the sphere that never zoomed.
 *
 * `t` is the ray-march's own hit distance, already computed. The camera
 * sits at `|o| = f` from the centre, so `t` runs from `1 - f` looking
 * at the focus to `1 + f` looking at the antipode, and the linear
 * magnification relative to a centred camera is `1 / t`.
 *
 * The conversion back to a zoom level is `cameraOffsetForCamera`'s own
 * mapping inverted — `f = 1 - 1/(z + 1)`, so `1 - f = 1/(z + 1)` and
 * `z = 1/t - 1`. That makes this **exact at the focus**: the centre of
 * the operator's area of interest reports the operator's actual zoom,
 * so feeding it through the control globe's unmodified curve below
 * makes the two surfaces agree there by construction rather than by a
 * matched pair of hand-tuned numbers.
 *
 * Two deliberate imprecisions. The warp is anisotropic — the true
 * linear scale is `sqrt(cos θ) / t`, where `cos θ` is the ray's
 * incidence on the surface — and this ignores the `cos θ`, which costs
 * at most ~27% of a magnification factor mid-frame and nothing at
 * either pole of the warp. And `MAX_CAMERA_OFFSET` caps `f` at 0.85,
 * so the largest local zoom any output can report is `1/0.15 - 1`,
 * about 5.67: past that the operator keeps zooming and the output does
 * not. Clouds therefore bottom out at ~11% of their alpha rather than
 * at zero, which is not a shortfall in the fade — it is the control
 * globe's own value at zoom 5.67, which is the zoom the capped output
 * is in fact showing.
 */
export function localZoomAt(rayLength: number): number {
  if (!(rayLength > 0)) return 0
  return Math.max(0, 1 / rayLength - 1)
}

/**
 * Cloud coverage multiplier for a local zoom, 1 (full) to 0 (gone).
 *
 * `earthTileLayer`'s curve, unmodified — the same reason the four
 * decoration scalars above are its and not this module's.
 */
export function cloudZoomFade(localZoom: number): number {
  const span = CLOUD_FADE_END_ZOOM - CLOUD_FADE_START_ZOOM
  return 1 - Math.max(0, Math.min(1, (localZoom - CLOUD_FADE_START_ZOOM) / span))
}

/** One decorated sample of the Earth's surface. `cloudLuma` is the raw
 *  luminance of the cloud asset at this point — the curve that turns it
 *  into coverage lives here rather than in whoever loaded it, so the
 *  gamma and the opacity stay one calibration. `cloudFade` is
 *  `cloudZoomFade`'s output for this fragment. */
export interface EarthDecoration {
  base: { r: number; g: number; b: number }
  lights: { r: number; g: number; b: number }
  cloudLuma: number
  cloudFade: number
  nightFactor: number
}

/**
 * The TS mirror of `EARTH_DECORATION_GLSL`, in the same
 * shader-is-testable split the rest of this module uses.
 *
 * Order is `earthTileLayer`'s pass order and matters: darken under a
 * multiply, then lights additively (so they are *not* darkened by the
 * pass that made room for them), then clouds over the top.
 */
export function decorateEarth(d: EarthDecoration): { r: number; g: number; b: number } {
  const n = d.nightFactor
  const brightness = 1 + (NIGHT_DARKENING - 1) * n
  const lit = {
    r: d.base.r * brightness + d.lights.r * n * NIGHT_LIGHT_STRENGTH,
    g: d.base.g * brightness + d.lights.g * n * NIGHT_LIGHT_STRENGTH,
    b: d.base.b * brightness + d.lights.b * n * NIGHT_LIGHT_STRENGTH,
  }
  const cloudAlpha = Math.pow(Math.max(0, d.cloudLuma), CLOUD_ALPHA_GAMMA) * CLOUD_OPACITY
  // The zoom fade multiplies the *boosted* alpha, which is where
  // `earthTileLayer` applies it — after the night mix, not before it.
  // Folding it into `cloudAlpha` instead would let the night boost
  // partly undo the fade, so a zoomed-in night side would keep cover a
  // zoomed-in day side had lost.
  const alpha =
    (cloudAlpha + (Math.min(cloudAlpha * CLOUD_NIGHT_ALPHA_BOOST, 1) - cloudAlpha) * n) *
    d.cloudFade
  // Day clouds are white, night clouds black — the same mix the raster
  // path uses, so a cloud reads as cover rather than as a light source.
  const cloud = 1 - n
  return {
    r: lit.r + (cloud - lit.r) * alpha,
    g: lit.g + (cloud - lit.g) * alpha,
    b: lit.b + (cloud - lit.b) * alpha,
  }
}

/**
 * The base colour grade — `earthTileLayer`'s pass 0, which runs
 * **first**, on the raw Blue Marble tiles, before night / lights /
 * clouds / atmosphere composite on top.
 *
 * Its two constants were tuned for exactly the thing this fixes:
 * contrast 1.10 is "a slight S-curve to deepen ocean blues" and
 * saturation 1.20 "pushes the Blue Marble greens/blues a touch". An
 * output that skipped it would show an ungraded base beside a graded
 * one, which is the same class of mismatch as the missing scattering
 * and was found alongside it.
 *
 * Purely per-pixel — no geometry, no viewer, no silhouette — so
 * unlike the four effects the plan rules out, there is nothing here
 * that an unwrap has to reinterpret.
 */
export function gradeEarthBase(c: { r: number; g: number; b: number }): {
  r: number
  g: number
  b: number
} {
  const r = (c.r - 0.5) * BASE_CONTRAST + 0.5
  const g = (c.g - 0.5) * BASE_CONTRAST + 0.5
  const b = (c.b - 0.5) * BASE_CONTRAST + 0.5
  const luma = r * LUMA_R + g * LUMA_G + b * LUMA_B
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  return {
    r: clamp(luma + (r - luma) * BASE_SATURATION),
    g: clamp(luma + (g - luma) * BASE_SATURATION),
    b: clamp(luma + (b - luma) * BASE_SATURATION),
  }
}

/** One entry of `atmosphereNadir`'s LUT, as the shader reads it. */
export interface AtmosphereSample {
  r: number
  g: number
  b: number
  transmittance: number
}

/**
 * Composite the atmosphere, `earthTileLayer`'s pass 5.
 *
 * The same `scattered + surface x viewTransmittance` the raster path
 * blends with `(ONE, SRC_ALPHA)`. Applied **after** the decoration,
 * because that is where it sits over there — the shell is drawn last,
 * over the clouds — and **before** the dataset layers, for the reason
 * the decoration is: a blue wash over a measured field is a rendering
 * artifact indistinguishable from a value.
 *
 * Where the sample comes from is `atmosphereNadir`'s business; this
 * only knows it is indexed by the sun cosine.
 */
export function applyAtmosphere(
  colour: { r: number; g: number; b: number },
  sample: AtmosphereSample,
): { r: number; g: number; b: number } {
  return {
    r: colour.r * sample.transmittance + sample.r,
    g: colour.g * sample.transmittance + sample.g,
    b: colour.b * sample.transmittance + sample.b,
  }
}

/** Uniform names for the Earth decoration. Same anti-typo reason as
 *  `overlayUniformNames`. */
export const DECORATION_UNIFORMS = {
  sunDir: 'uSunDir',
  dayNight: 'uDayNight',
  lightsMap: 'uNightLightsMap',
  hasLights: 'uHasNightLights',
  cloudMap: 'uCloudMap',
  hasCloud: 'uHasCloud',
  atmosphereLut: 'uAtmosphereLut',
  hasAtmosphere: 'uHasAtmosphere',
} as const

/**
 * The GLSL mirror of `nightFactor` + `decorateEarth`.
 *
 * Every effect here is a property of the sphere's *surface*, which is
 * the whole test the plan's decoration table applies: specular,
 * atmosphere shells, ground shadow and the sun sprite depend on a
 * viewer or a silhouette, an unwrap has neither, and baking one in
 * would paint a fixed glare spot or limb ring onto a physical sphere —
 * a rendering artifact that reads as a data feature. They are not
 * deferred here; they are incoherent here.
 */
export const EARTH_DECORATION_GLSL = `
// earthTileLayer pass 0, which runs before everything else on the
// raw tiles. Tuned to deepen ocean blues; see \`gradeEarthBase\`.
vec3 gradeEarthBase(vec3 c) {
  c = (c - 0.5) * ${BASE_CONTRAST.toFixed(2)} + 0.5;
  float luma = dot(c, vec3(${LUMA_R}, ${LUMA_G}, ${LUMA_B}));
  return clamp(mix(vec3(luma), c, ${BASE_SATURATION.toFixed(2)}), 0.0, 1.0);
}

float earthNightFactor(vec3 hit, vec3 sunDir, int dayNight) {
  if (dayNight == 0) return 0.0;
  // Ascending edges, unlike the older shaders' reversed form: GLSL
  // leaves smoothstep undefined for edge0 >= edge1. Same curve — the
  // polynomial is symmetric — but defined. See \`nightFactor\`.
  return 1.0 - smoothstep(-${TERMINATOR_SOFTNESS.toFixed(1)}, 0.0, dot(hit, sunDir));
}

// Per-fragment, because the projection's zoom is a warp: the focus and
// the antipode are at different magnifications in the same frame. See
// \`localZoomAt\` / \`cloudZoomFade\`.
float earthCloudZoomFade(float rayLength) {
  float localZoom = max(1.0 / max(rayLength, 1e-4) - 1.0, 0.0);
  return 1.0 - clamp(
    (localZoom - ${CLOUD_FADE_START_ZOOM.toFixed(1)})
      / ${(CLOUD_FADE_END_ZOOM - CLOUD_FADE_START_ZOOM).toFixed(1)},
    0.0, 1.0);
}

vec3 decorateEarth(vec3 base, vec3 lights, float cloudLuma, float night, float cloudFade) {
  vec3 colour = base * mix(1.0, ${NIGHT_DARKENING.toFixed(4)}, night);
  colour += lights * night * ${NIGHT_LIGHT_STRENGTH.toFixed(2)};
  float cloudAlpha = pow(max(cloudLuma, 0.0), ${CLOUD_ALPHA_GAMMA.toFixed(2)})
    * ${CLOUD_OPACITY.toFixed(2)};
  float alpha = mix(cloudAlpha, min(cloudAlpha * ${CLOUD_NIGHT_ALPHA_BOOST.toFixed(2)}, 1.0), night)
    * cloudFade;
  return mix(colour, mix(vec3(1.0), vec3(0.0), night), alpha);
}
`.trim()

/**
 * The GLSL mirror of `applyAtmosphere`, plus the LUT lookup.
 *
 * Its own string rather than part of the decoration block because it
 * is a different pass at a different point in the order: pass 5,
 * after the clouds, where the raster path draws its shell.
 *
 * **Day/night off samples at overhead, not off.** Turning the
 * terminator off means "do not show where the sun is"; an atmosphere
 * that still varied with sun angle would draw a terminator in blue
 * instead of in darkness. Holding it at the subsolar value gives a
 * uniformly-lit Earth that still has an ocean, which is what that
 * toggle is asking for.
 */
export const EARTH_ATMOSPHERE_GLSL = `
vec3 applyEarthAtmosphere(
  vec3 colour, vec3 hit, vec3 sunDir, sampler2D lut, int hasAtmosphere, int dayNight
) {
  if (hasAtmosphere == 0) return colour;
  float sunCos = dayNight == 1 ? dot(hit, sunDir) : 1.0;
  // Texel centres, not edges — see \`nadirLutU\`.
  float u = (clamp(sunCos * 0.5 + 0.5, 0.0, 1.0) * ${(NADIR_LUT_SIZE - 1).toFixed(1)} + 0.5)
    / ${NADIR_LUT_SIZE.toFixed(1)};
  vec4 s = texture2D(lut, vec2(u, 0.5));
  return colour * s.a + s.rgb;
}
`.trim()

/** Normalised texture coordinates in **shader space**: `v = 1` is the
 *  image's TOP row, because THREE uploads textures with `flipY`. This
 *  is the opposite of `datasetProbe`'s image-space V. */
export interface OverlayUv {
  u: number
  v: number
}

function isGlobalBbox(b: { n: number; s: number; w: number; e: number }): boolean {
  return b.n >= 90 && b.s <= -90 && b.w <= -180 && b.e >= 180
}

/**
 * lat/lon (degrees) → the overlay texture UV to sample, or `null` when
 * the point falls outside a regional dataset's bounding box.
 *
 * `null` is the shader's `discard` / base-map branch: reporting a
 * colour for a fragment the shader would not have drawn is worse than
 * reporting none.
 *
 * A bbox covering the whole globe is treated as no bbox, matching
 * `datasetProbe` — clipping to a box that clips nothing costs a branch
 * and loses the `lonOrigin` shift.
 */
export function overlaySampleUv(
  lat: number,
  lon: number,
  overlay?: DatasetOverlayOptions,
): OverlayUv | null {
  const bbox = overlay?.boundingBox
  const flipY = overlay?.isFlippedInY === true

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    if (lat > n || lat < s) return null
    let u: number
    if (w <= e) {
      if (lon < w || lon > e) return null
      u = (lon - w) / Math.max(e - w, 1e-6)
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      const span = 360 - w + e
      if (lon >= w) u = (lon - w) / span
      else if (lon <= e) u = (lon + 360 - w) / span
      else return null
    }
    // Shader space: the box's NORTH edge is v = 1.
    let v = (lat - s) / Math.max(n - s, 1e-6)
    if (flipY) v = 1 - v
    return { u, v }
  }

  const lonOrigin =
    typeof overlay?.lonOrigin === 'number' && Number.isFinite(overlay.lonOrigin)
      ? overlay.lonOrigin
      : 0
  // GLSL `fract`; JS `%` keeps the dividend's sign, so normalise twice.
  const raw = (lon - lonOrigin) / 360 + 0.5
  const u = ((raw % 1) + 1) % 1
  const v = (lat + 90) / 180
  return { u, v: flipY ? 1 - v : v }
}

/** Uniform names for one overlay slot. A misspelled uniform is
 *  silently ignored by WebGL and reads as "the dataset never loaded". */
export function overlayUniformNames(slot: number): {
  map: string
  lut: string
  bbox: string
  hasBbox: string
  lonOrigin: string
  flipY: string
  dataEncoded: string
  opacity: string
} {
  return {
    map: `uLayer${slot}Map`,
    lut: `uLayer${slot}Lut`,
    bbox: `uLayer${slot}Bbox`,
    hasBbox: `uLayer${slot}HasBbox`,
    lonOrigin: `uLayer${slot}LonOrigin`,
    flipY: `uLayer${slot}FlipY`,
    dataEncoded: `uLayer${slot}DataEncoded`,
    opacity: `uLayer${slot}Opacity`,
  }
}

/**
 * The GLSL mirror of `overlaySampleUv`, plus the data-encoded palette
 * lookup.
 *
 * Returns premultiplied-alpha-free RGBA with `a = 0` outside the bbox,
 * so the caller composites with a plain `mix` and an out-of-bbox
 * fragment contributes nothing rather than a colour.
 *
 * For a data-encoded layer the sampled `.r` is a *measurement*, looked
 * up in the palette LUT. It deliberately skips any contrast or
 * saturation treatment: those exist to make the Earth read well and
 * would silently rewrite every reported value, so the sphere would
 * disagree with the number the control window reports under the
 * cursor.
 */
export const OVERLAY_SAMPLE_GLSL = `
vec4 sampleOverlayLayer(
  sampler2D tex,
  sampler2D lut,
  float lat,
  float lon,
  vec4 bbox,
  int hasBbox,
  float lonOrigin,
  int flipY,
  int dataEncoded,
  float opacity
) {
  vec2 uv;
  if (hasBbox == 1) {
    float bn = bbox.x;
    float bs = bbox.y;
    float bw = bbox.z;
    float be = bbox.w;
    if (lat > bn || lat < bs) return vec4(0.0);
    float bu;
    if (bw <= be) {
      if (lon < bw || lon > be) return vec4(0.0);
      bu = (lon - bw) / max(be - bw, 1e-6);
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      bool eastSide = lon >= bw;
      bool westSide = lon <= be;
      if (!eastSide && !westSide) return vec4(0.0);
      float span = (360.0 - bw) + be;
      bu = eastSide ? (lon - bw) / span : (lon + 360.0 - bw) / span;
    }
    // v == 1 is the image's TOP row (THREE uploads with flipY), so the
    // box's north edge maps to bv 1, not 0. Inverting this is what put
    // a US bbox over the South Pacific once already.
    float bv = (lat - bs) / max(bn - bs, 1e-6);
    if (flipY == 1) bv = 1.0 - bv;
    uv = vec2(bu, bv);
  } else {
    float fu = fract((lon - lonOrigin) / 360.0 + 0.5);
    float fv = (lat + 90.0) / 180.0;
    if (flipY == 1) fv = 1.0 - fv;
    uv = vec2(fu, fv);
  }

  vec4 texel = texture2D(tex, uv);
  if (dataEncoded == 1) {
    // Luma is a measurement, not a look: no contrast or saturation
    // treatment here, or the sphere reports a different number than
    // the control window measured.
    vec4 pal = texture2D(lut, vec2(texel.r, 0.5));
    return vec4(pal.rgb, pal.a * opacity);
  }
  return vec4(texel.rgb, texel.a * opacity);
}
`.trim()

/**
 * Compose the full output fragment shader: the equirect ray-march from
 * `equirectRtt`, plus `layerCount` overlay slots composited in array
 * order over the base sphere texture.
 *
 * Built as a string rather than shipped as one because the slot count
 * is dynamic and GLSL ES 1.00 has no dynamic sampler indexing — a
 * loop over `uLayer[i]Map` does not compile. Unrolling at build time
 * is the standard way out and keeps the sampler count to what this
 * output actually needs.
 */
export function buildOutputFragmentShader(layerCount: number): string {
  const count = Math.max(0, Math.min(layerCount, MAX_OUTPUT_LAYERS))

  // **The Earth treatment is for the idle globe only**, and that is a
  // correction of what shipped rather than a preference.
  //
  // `earthTileLayer` gates its whole pass chain on `datasetActive` and
  // returns before any of it — the comment on that return says "no
  // earth effects when dataset is active" — so a control globe showing
  // a dataset shows an unlit, ungraded sphere, and a bbox dataset
  // `discard`s to raw Blue Marble tiles outside the box. This path used
  // to composite the decoration *under* the layers instead, on the
  // reasoning that under-compositing meant "day/night never tints a
  // dataset". That is true only of opaque global coverage. A
  // bbox-clipped, data-encoded overlay is translucent by construction —
  // its alpha is the measurement — so the terminator showed *through*
  // the very smoke plume the argument used as its example, and outside
  // the box the output was decorated while the control globe was not.
  // Found on hardware, rung 9 step 13.
  //
  // So the gate is the slot count, decided at build time because the
  // shader text is already a function of it: no layers means the idle
  // Earth and its full treatment, any layer means the raw sample and
  // nothing on top. `main.ts` fills a slot only when the mirror holds
  // *decoded* media for a dataset, which makes this a tighter test than
  // the control side's — `datasetActive` is set when the dataset is
  // assigned, this when its pixels exist.
  const idleEarth = count === 0
  const D = DECORATION_UNIFORMS
  const declarations: string[] = idleEarth
    ? [
        `uniform vec3 ${D.sunDir};`,
        `uniform int ${D.dayNight};`,
        `uniform sampler2D ${D.lightsMap};`,
        `uniform int ${D.hasLights};`,
        `uniform sampler2D ${D.cloudMap};`,
        `uniform int ${D.hasCloud};`,
        `uniform sampler2D ${D.atmosphereLut};`,
        `uniform int ${D.hasAtmosphere};`,
      ]
    : []
  const composites: string[] = []
  for (let slot = 0; slot < count; slot++) {
    const n = overlayUniformNames(slot)
    declarations.push(
      `uniform sampler2D ${n.map};`,
      `uniform sampler2D ${n.lut};`,
      `uniform vec4 ${n.bbox};`,
      `uniform int ${n.hasBbox};`,
      `uniform float ${n.lonOrigin};`,
      `uniform int ${n.flipY};`,
      `uniform int ${n.dataEncoded};`,
      `uniform float ${n.opacity};`,
    )
    composites.push(
      `  {`,
      `    vec4 layer = sampleOverlayLayer(${n.map}, ${n.lut}, hitLatDeg, hitLonDeg,`,
      `      ${n.bbox}, ${n.hasBbox}, ${n.lonOrigin}, ${n.flipY}, ${n.dataEncoded}, ${n.opacity});`,
      `    colour = mix(colour, layer.rgb, layer.a);`,
      `  }`,
    )
  }

  // The equirect pass ends by writing the base sample to gl_FragColor.
  // Replace that tail with the composite chain, so the ray-march above
  // it stays byte-identical to the shader `equirectRtt`'s own tests
  // cover.
  const BASE_TAIL = '  gl_FragColor = texture2D(uSphereTexture, sphereUv);\n}'
  if (!EQUIRECT_FRAGMENT_SHADER.includes(BASE_TAIL)) {
    throw new Error(
      'equirect fragment shader tail changed; buildOutputFragmentShader can no longer compose it',
    )
  }

  // The idle Earth, in `earthTileLayer`'s pass order. None of it is
  // emitted once a layer exists — see the note on `idleEarth` above.
  const earthTreatment = idleEarth
    ? [
        // Pass 0 first, on the raw sample, exactly where the raster path
        // runs it — everything below composites onto the graded base.
        '  vec3 colour = gradeEarthBase(texture2D(uSphereTexture, sphereUv).rgb);',
        // `hit` is the ray-march's landing point on the *unit* sphere, so
        // it is already the surface normal — the one line the plan's
        // decoration table promised the terminator would cost.
        `  float night = earthNightFactor(hit, ${D.sunDir}, ${D.dayNight});`,
        `  vec3 nightLights = ${D.hasLights} == 1`,
        `    ? texture2D(${D.lightsMap}, sphereUv).rgb : vec3(0.0);`,
        // Raw luminance, the same quantity earthTileLayer's cloud pass
        // reads, so the gamma below is the one that asset was tuned with.
        `  float cloudLuma = ${D.hasCloud} == 1`,
        `    ? dot(texture2D(${D.cloudMap}, sphereUv).rgb, vec3(0.299, 0.587, 0.114))`,
        '    : 0.0;',
        // `t` is the ray-march's hit distance, so the fade is per fragment:
        // clouds dissolve where the projection magnifies and stay where it
        // does not, which is the same "vanish on the way in" the control
        // globe does — just applied to a frame that holds several zooms at
        // once.
        '  float cloudFade = earthCloudZoomFade(t);',
        '  colour = decorateEarth(colour, nightLights, cloudLuma, night, cloudFade);',
        // Pass 5 last, over the clouds.
        `  colour = applyEarthAtmosphere(colour, hit, ${D.sunDir}, ${D.atmosphereLut},`,
        `    ${D.hasAtmosphere}, ${D.dayNight});`,
      ]
    : [
        // Raw, exactly as the control globe leaves it: its dataset branch
        // returns before pass 0, so the tiles a bbox dataset reveals
        // outside its box are ungraded and unlit. Grading only this side
        // would put a contrast curve on one of two globes showing the
        // same field.
        '  vec3 colour = texture2D(uSphereTexture, sphereUv).rgb;',
      ]

  const tail = [
    ...earthTreatment,
    // Emitted only when something samples them, so a zero-layer shader
    // does not declare two unread floats.
    ...(count > 0
      ? ['  float hitLatDeg = degrees(hitLat);', '  float hitLonDeg = degrees(hitLon);']
      : []),
    ...composites,
    '  gl_FragColor = vec4(colour, 1.0);',
    '}',
  ].join('\n')

  const body = EQUIRECT_FRAGMENT_SHADER.replace(BASE_TAIL, tail)

  // GLSL ES 1.00 has no forward declarations: `sampleOverlayLayer` must
  // appear textually before `main()` or the shader fails to compile.
  // Appending it after the body type-checks fine in TypeScript and
  // fails only on a GPU, which is nowhere this repo's tests run — so
  // the ordering is asserted in `layerStack.test.ts`.
  const decoration = `${EARTH_DECORATION_GLSL}\n\n${EARTH_ATMOSPHERE_GLSL}`
  const helpers = idleEarth ? decoration : OVERLAY_SAMPLE_GLSL
  const preamble = `${declarations.join('\n')}\n\n${helpers}\n`
  return body.replace('void main() {', `${preamble}\nvoid main() {`)
}
