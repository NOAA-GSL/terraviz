/**
 * Shader-settings service — the runtime side of the §7.2 globe-
 * shader uniforms. Persists the user's specular-strength preset
 * (Tools menu) and the dev-tuner overrides for contrast,
 * saturation, and bump intensity, and exposes them as a single
 * `getShaderSettings()` snapshot the renderer reads each frame.
 *
 * Load precedence per uniform, highest first:
 *
 *   1. Live override set by the `?tune=shader` dev tuner — not
 *      persisted; reset on reload unless explicitly saved.
 *   2. `localStorage[STORAGE_KEY]` — the user's saved choice.
 *   3. The shipped default below (the value the codebase has tuned
 *      against the Blue Marble reference).
 *
 * The renderer holds a reference to the live snapshot and re-reads
 * it on every frame — there's no event channel; mutating via
 * `setShaderSettings` triggers a `dispatchEvent` that the
 * earth-tile layer + photoreal-earth subscribers latch onto for
 * `triggerRepaint`. The tuner panel listens too so its sliders
 * stay in sync if the same setting is changed from elsewhere.
 */

import type { SpecularPreset } from '../types/index'

export type { SpecularPreset } from '../types/index'

/** The three Tools-menu specular presets, mirroring the plan. */
export const SPECULAR_PRESETS: Record<SpecularPreset, number> = {
  none: 0.0,
  default: 0.35,
  comfortable: 0.55,
} as const

/**
 * Shipped default snapshot. `default` is named to match the
 * Tools-menu preset; contrast/saturation/bump are dev-tuned and
 * shipped as one bundle. Editing these numbers (after using the
 * tuner to confirm) is the canonical way to ship a look change.
 *
 * Why these numbers (2026-05-26 tuning pass — to be replaced once
 * the tuner page goes live):
 *  - contrast 1.10 — slight S-curve to deepen ocean blues
 *  - saturation 1.20 — push the Blue Marble greens/blues a touch
 *  - specular 0.35 — Adrian's "reduce specular" ask, was 0.60
 *  - bump 0.85 — normal-map intensity; subtle but visible
 *  - night 1.00 — reserved for future night-side scalar
 */
export const SHADER_DEFAULTS = {
  contrast: 1.10,
  saturation: 1.20,
  specularStrength: SPECULAR_PRESETS.default,
  bumpStrength: 0.85,
} as const

/** Hard-clamp band for any incoming value. */
const CONTRAST_MIN = 0.0
const CONTRAST_MAX = 2.0
const SATURATION_MIN = 0.0
const SATURATION_MAX = 2.0
const SPECULAR_MIN = 0.0
const SPECULAR_MAX = 1.0
const BUMP_MIN = 0.0
const BUMP_MAX = 2.0

/** localStorage key for the persisted specular-preset choice. */
const SPECULAR_STORAGE_KEY = 'sos-shader-specular.v1'

/** A snapshot of every shader uniform the §7.2 work touches. */
export interface ShaderSettings {
  contrast: number
  saturation: number
  specularStrength: number
  bumpStrength: number
}

/** Live mutable state — the renderer pulls from this each frame. */
const state: ShaderSettings = { ...SHADER_DEFAULTS }

/** Event name dispatched whenever any uniform changes. */
const CHANGE_EVENT = 'sos-shader-settings:change'
const target: EventTarget = typeof window === 'undefined'
  ? new EventTarget()
  : window

/** Internal — clamp + sanitise a numeric input. */
function clamp(raw: unknown, min: number, max: number): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return null
  if (n < min || n > max) return null
  return n
}

/**
 * Read the persisted specular-strength preset from localStorage,
 * returning `null` on a missing/invalid entry. Versioned to match
 * the `sos-browse-view-mode.v1` / `sos-ui-scale.v1` pattern.
 */
export function loadSpecularPreset(): SpecularPreset | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SPECULAR_STORAGE_KEY)
    if (raw === 'none' || raw === 'default' || raw === 'comfortable') {
      return raw
    }
    return null
  } catch {
    return null
  }
}

/** Persist the specular-strength preset choice. Best-effort. */
function persistSpecularPreset(preset: SpecularPreset): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SPECULAR_STORAGE_KEY, preset)
  } catch {
    /* swallow — at worst the choice reverts on reload */
  }
}

/** Boot the runtime: apply persisted preferences over the shipped
 *  defaults. Called once at startup. */
export function initShaderSettings(): ShaderSettings {
  const preset = loadSpecularPreset()
  if (preset != null) {
    state.specularStrength = SPECULAR_PRESETS[preset]
  }
  return getShaderSettings()
}

/** Immutable read of the live settings snapshot. */
export function getShaderSettings(): ShaderSettings {
  return { ...state }
}

/**
 * Pick a Tools-menu preset. Updates the live specular-strength
 * uniform, persists the choice, and notifies subscribers.
 */
export function setSpecularPreset(preset: SpecularPreset): void {
  state.specularStrength = SPECULAR_PRESETS[preset]
  persistSpecularPreset(preset)
  notify()
}

/**
 * Map the current specular value back to a preset name (the radio
 * needs to know which button is active). Returns `null` if the
 * value sits between presets — the tuner can write any value, not
 * just preset values.
 */
export function matchSpecularPreset(value: number): SpecularPreset | null {
  for (const [name, target] of Object.entries(SPECULAR_PRESETS) as Array<
    [SpecularPreset, number]
  >) {
    if (Math.abs(value - target) < 0.01) return name
  }
  return null
}

/**
 * Tuner-only setter — writes a freeform value to any of the
 * shader uniforms. Does NOT persist (the tuner is a dev surface;
 * shipping requires editing SHADER_DEFAULTS above). Clamps to the
 * uniform's safe band; out-of-range input is a no-op.
 */
export function setTunerValue(
  key: keyof ShaderSettings,
  raw: number,
): void {
  const band = TUNER_BANDS[key]
  const value = clamp(raw, band.min, band.max)
  if (value == null) return
  state[key] = value
  notify()
}

/** Safe-band metadata exposed to the tuner UI so the sliders can
 *  build their min/max/step from a single source of truth. */
export const TUNER_BANDS: Record<keyof ShaderSettings, { min: number; max: number; step: number }> = {
  contrast: { min: CONTRAST_MIN, max: CONTRAST_MAX, step: 0.01 },
  saturation: { min: SATURATION_MIN, max: SATURATION_MAX, step: 0.01 },
  specularStrength: { min: SPECULAR_MIN, max: SPECULAR_MAX, step: 0.01 },
  bumpStrength: { min: BUMP_MIN, max: BUMP_MAX, step: 0.01 },
}

/** Subscribe to setting changes. Returns an unsubscribe callback.
 *  Used by the renderer to call `triggerRepaint` and by the tuner
 *  panel to re-sync sliders if a change came from elsewhere. */
export function onShaderSettingsChange(
  listener: (settings: ShaderSettings) => void,
): () => void {
  const handler = () => listener(getShaderSettings())
  target.addEventListener(CHANGE_EVENT, handler)
  return () => target.removeEventListener(CHANGE_EVENT, handler)
}

function notify(): void {
  target.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Test-only — reset to shipped defaults. */
export function resetShaderSettingsForTests(): void {
  Object.assign(state, SHADER_DEFAULTS)
}

/** Test-only — localStorage key for the specular preset. */
export const SHADER_SPECULAR_STORAGE_KEY = SPECULAR_STORAGE_KEY
