// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The equirectangular render-to-texture pass.
 *
 * For each pixel of a 2:1 output framebuffer this takes the direction
 * that pixel represents, ray-marches it from a configurable camera
 * position against the unit sphere, and samples the sphere's texture
 * at the hit point. One pass, native 2:1 output, no pole artifacts —
 * see `docs/MULTI_MONITOR_PLAN.md` §"Equirectangular RTT is one shader
 * pass, not a cubemap", which rejects the cubemap-and-convert route
 * outright. Do not build the cubemap path.
 *
 * With the camera at the sphere's centre the mapping is the identity
 * and the output is a uniform equirectangular unwrap. Moving the
 * camera off-centre makes it non-uniform: surface points on the side
 * the camera moved toward subtend larger angles and take up more of
 * the frame, so the area of focus grows on the physical sphere while
 * the antipode compresses. That warp *is* the zoom, it is the primary
 * v1 mode rather than a forward-compat hook, and it is what SOS
 * installations have done for over a decade (§3.5).
 *
 * **Everything here except the GLSL strings is pure**, mirroring the
 * shader in TypeScript so the projection — the part most likely to be
 * wrong and least likely to *look* wrong on a sphere nobody in this
 * repo can see — is unit-testable without a GL context. Same split as
 * `src/services/datasetProbe.ts`.
 *
 * Deliberately no Three.js import. This module is the maths and the
 * shader source; commit 3 builds the material and the render target
 * around it, and the repo lazy-loads Three everywhere so a static
 * import here would pull it into any bundle that touches the
 * projection.
 *
 * Not here yet, on purpose:
 *
 * - **Layer compositing.** This samples one sphere texture. The
 *   multi-shell stack arrives with `layerStack.ts` in commit 4.
 */

/**
 * The largest camera-offset magnitude the projection stays sane at.
 *
 * `|o| = 1` puts the camera on the sphere's surface, where a single
 * source texel smears across most of the output. The cap keeps the
 * warp continuous.
 */
export const MAX_CAMERA_OFFSET = 0.85

/** Output framebuffers are 2:1. Width / height. */
export const EQUIRECT_ASPECT = 2

/** A plain triple. Not a `THREE.Vector3` — this crosses the IPC
 *  boundary and this module owns no Three import. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface EquirectParams {
  /** Camera position inside the unit sphere. `|cameraOffset|` should
   *  be ≤ `MAX_CAMERA_OFFSET`; the maths stays finite up to but not
   *  including 1. */
  cameraOffset: Vec3
  /** Mirror the area of focus to the antipodal hemisphere. */
  split: boolean
  /**
   * Per-installation longitude rotation, **radians** (rung 14).
   *
   * An LED sphere is a physical object: its north-pole pin may not
   * align with celestial north, or a museum may want the prime
   * meridian facing the main entrance. This turns the whole picture on
   * the sphere so the operator can put it where the room needs it.
   *
   * Radians rather than the degrees the operator types, because a
   * `EquirectParams` is what `setParams` hands the shader — the same
   * reason `cameraOffset` is a derived `Vec3` here and lat/lon/zoom on
   * the wire. `OutputViewSettings.rotationOffsetDeg` holds the
   * operator's number and `projectView` is the one place that
   * converts, so no second conversion exists to disagree with it.
   */
  rotationOffsetRad: number
}

/** The centred, unsplit, unrotated projection — a uniform 1:1 unwrap. */
export const IDENTITY_PARAMS: EquirectParams = {
  cameraOffset: { x: 0, y: 0, z: 0 },
  split: false,
  rotationOffsetRad: 0,
}

/**
 * Split mode: fold the output's U so the frame contains two copies.
 *
 * The area of focus lands at U=0.25 and U=0.75, which the LED sphere
 * wraps to two longitudes 180° apart — visitors on either side see the
 * same hurricane without walking around it.
 */
export function foldSplitU(u: number, split: boolean): number {
  if (!split) return u
  const doubled = u * 2
  return doubled - Math.floor(doubled)
}

/**
 * Output framebuffer UV → the lat/lon that pixel represents, degrees.
 *
 * **V is bottom-up here**: `v = 0` is latitude −90°. That is GL's
 * framebuffer origin, and it makes row 0 of the rendered image the
 * south pole, so a conventionally-oriented equirectangular (north at
 * top) falls out when the buffer is read the way GL hands it over.
 * `datasetProbe.latLonToTexelUv` uses the *opposite*, image-space V
 * for reading dataset textures; getting this sign wrong mirrors the
 * world across the equator, which the probe's own docstring notes has
 * happened twice in this codebase.
 *
 * Matches `datasetProbe.sphereUvToLatLon`, which is the repo's sphere-
 * UV convention. That agreement is asserted in the tests rather than
 * enforced by an import, so the output bundle does not pull the i18n
 * runtime in through `datasetProbe`.
 */
export function outputUvToLatLon(u: number, v: number): { lat: number; lon: number } {
  return { lat: (v - 0.5) * 180, lon: (u - 0.5) * 360 }
}

/** Inverse of `outputUvToLatLon`, for sampling the sphere texture. */
export function latLonToSphereUv(lat: number, lon: number): { u: number; v: number } {
  return { u: lon / 360 + 0.5, v: lat / 180 + 0.5 }
}

const DEG = Math.PI / 180

/**
 * lat/lon (degrees) → unit direction, Y-up.
 *
 * The manager derives `cameraOffset` through this same function, so
 * the offset and the per-pixel ray share a frame. Any self-consistent
 * convention would do; what must not happen is the two ends picking
 * different ones.
 */
export function latLonToDirection(lat: number, lon: number): Vec3 {
  const latRad = lat * DEG
  const lonRad = lon * DEG
  const cosLat = Math.cos(latRad)
  return {
    x: cosLat * Math.cos(lonRad),
    y: Math.sin(latRad),
    z: cosLat * Math.sin(lonRad),
  }
}

/** Unit direction → lat/lon in degrees. Inverse of the above. */
export function directionToLatLon(d: Vec3): { lat: number; lon: number } {
  const len = Math.hypot(d.x, d.y, d.z) || 1
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, d.y / len))) / DEG,
    lon: Math.atan2(d.z, d.x) / DEG,
  }
}

/**
 * Turn the picture on the physical sphere by `rotationOffsetRad`.
 *
 * **Applied to the longitude, after the split fold, before the
 * ray-march.** The plan says only "before the ray-march" and the old
 * note here pointed at `foldSplitU`, which would be wrong: `foldSplitU`
 * is periodic in U with period ½, so rotating its *input* would make a
 * 180° offset a no-op on exactly the installations most likely to use
 * split mode. Rotating the longitude the fold produced turns both
 * copies together, which is what an operator aligning a sphere means.
 *
 * No wrap. The plan's snippet ends `mod(lon + offset, TWO_PI)`, which
 * is dead arithmetic — the only consumers are `cos` and `sin`, and the
 * offset is bounded to one turn, so there is no range to normalise and
 * no precision to protect. Left out rather than transcribed, so the TS
 * mirror and the GLSL stay one line each.
 *
 * Sign: a **positive** offset moves the picture east on the sphere, so
 * an operator who sees the prime meridian 20° west of the doorway
 * types 20. That is a convention, and the test pins it.
 */
export function applyRotationOffset(lonDeg: number, rotationOffsetRad: number): number {
  return lonDeg - (rotationOffsetRad / DEG)
}

/**
 * Distance along `dir` from `origin` to the unit sphere.
 *
 * With the origin strictly inside the sphere the quadratic
 * `t² + 2(o·d)t + (|o|² − 1) = 0` always has exactly one positive
 * root, because its constant term is negative. **Every ray hits**, so
 * there is no miss branch and the far hemisphere shrinks rather than
 * clipping. `dir` is assumed unit-length.
 */
export function rayUnitSphereT(origin: Vec3, dir: Vec3): number {
  const b = origin.x * dir.x + origin.y * dir.y + origin.z * dir.z
  const c = origin.x * origin.x + origin.y * origin.y + origin.z * origin.z - 1
  return -b + Math.sqrt(b * b - c)
}

/**
 * The whole chain: output pixel UV → the sphere-texture UV to sample.
 *
 * This is the TS mirror of `EQUIRECT_FRAGMENT_SHADER` below. With
 * `IDENTITY_PARAMS` it returns its input unchanged, which is the
 * property worth pinning: a centred camera must cost nothing.
 */
export function equirectSourceUv(
  u: number,
  v: number,
  params: EquirectParams,
): { u: number; v: number } {
  const folded = foldSplitU(u, params.split)
  const { lat, lon } = outputUvToLatLon(folded, v)
  const dir = latLonToDirection(lat, applyRotationOffset(lon, params.rotationOffsetRad))
  const o = params.cameraOffset
  const t = rayUnitSphereT(o, dir)
  const hit: Vec3 = {
    x: o.x + t * dir.x,
    y: o.y + t * dir.y,
    z: o.z + t * dir.z,
  }
  const hitLatLon = directionToLatLon(hit)
  return latLonToSphereUv(hitLatLon.lat, hitLatLon.lon)
}

/**
 * The operator's MapLibre camera → the offset that reproduces its zoom
 * on the sphere (§3.5).
 *
 * The plan's snippet caps only the top of the range. This clamps both
 * ends: `1 − 1/(zoom + 1)` goes *negative* below zoom 0 and diverges as
 * zoom approaches −1, which would place the camera at or outside the
 * surface pointing at the antipode — the degenerate case the cap
 * exists to prevent, reached from the other direction.
 */
export function cameraOffsetForCamera(lat: number, lon: number, zoom: number): Vec3 {
  const raw = 1 - 1 / (zoom + 1)
  const factor = Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_CAMERA_OFFSET)) : 0
  const dir = latLonToDirection(lat, lon)
  return { x: dir.x * factor, y: dir.y * factor, z: dir.z * factor }
}

/**
 * Uniform names, so the material wiring in commit 3 cannot typo one.
 * A misspelled uniform is silently ignored by WebGL and shows up as
 * "the zoom does nothing".
 */
export const EQUIRECT_UNIFORMS = {
  sphereTexture: 'uSphereTexture',
  cameraOffset: 'uCameraOffset',
  split: 'uSplit',
  rotationOffset: 'uRotationOffsetRad',
} as const

/** Fullscreen pass. GLSL ES 1.00, matching the dialect Three's
 *  `ShaderMaterial` compiles and `photorealEarth` already uses. */
export const EQUIRECT_VERTEX_SHADER = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`.trim()

/**
 * The pass itself. Mirrored by `equirectSourceUv` above — change one
 * and the tests that compare them will say so.
 */
export const EQUIRECT_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uSphereTexture;
uniform vec3 uCameraOffset;
uniform bool uSplit;
uniform float uRotationOffsetRad;

const float PI = 3.14159265358979;
const float TWO_PI = 6.28318530717959;

void main() {
  // Split folds U so the frame carries two copies of the projection.
  float u = uSplit ? fract(vUv.x * 2.0) : vUv.x;

  // Output pixel -> the direction it represents. V is bottom-up: v = 0
  // is the south pole. The per-installation rotation is subtracted from
  // the longitude here — after the fold, so both copies of a split
  // frame turn together, and with no mod() because the only consumers
  // are cos and sin. See applyRotationOffset in this module.
  float lon = (u - 0.5) * TWO_PI - uRotationOffsetRad;
  float lat = (vUv.y - 0.5) * PI;
  float cosLat = cos(lat);
  vec3 dir = vec3(cosLat * cos(lon), sin(lat), cosLat * sin(lon));

  // March from the camera to the unit sphere. With the camera strictly
  // inside, the discriminant is always positive and every ray hits, so
  // there is no miss branch to write.
  float b = dot(uCameraOffset, dir);
  float c = dot(uCameraOffset, uCameraOffset) - 1.0;
  float t = -b + sqrt(b * b - c);
  vec3 hit = uCameraOffset + t * dir;

  // Hit point -> sphere-texture UV.
  float hitLat = asin(clamp(hit.y, -1.0, 1.0));
  float hitLon = atan(hit.z, hit.x);
  vec2 sphereUv = vec2(hitLon / TWO_PI + 0.5, hitLat / PI + 0.5);

  gl_FragColor = texture2D(uSphereTexture, sphereUv);
}
`.trim()
