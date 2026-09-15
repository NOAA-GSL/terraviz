// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Persisted multi-monitor output configuration
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Persistence", delivery rung 10).
 *
 * Two jobs, kept in one module because they share a schema and nothing
 * else in the codebase needs either half:
 *
 * 1. **Storage.** Read and write `localStorage['sos-multi-output-config']`,
 *    fail-closed, behind a `StorageLike` seam so a test drives it without
 *    a browser and the manager never touches `localStorage` directly.
 * 2. **Monitor matching.** Decide whether a persisted output's monitor is
 *    still present — the rule with real correctness content, and the
 *    reason this is a module rather than a few lines inside the manager.
 *
 * **A name-only match is not a match.** Windows reports `\\.\DISPLAY1`,
 * `\\.\DISPLAY2`, `\\.\DISPLAY3` — names assigned *positionally* and
 * reassigned across an unplug, a replug or a driver update. Matching on
 * the name alone can restore an output onto a physically different
 * monitor while looking like it worked, and on an installation that is a
 * projector showing the wrong thing to an audience with nothing on
 * screen to say so. So a match requires the name **and** the signed
 * physical origin; anything less is a monitor we do not recognise, and
 * the entry is skipped and logged rather than guessed at. Restoring
 * nothing is a better failure than restoring the wrong monitor.
 *
 * Origins are stored **signed and as reported** — physical pixels,
 * negative `x` included, exactly as `availableMonitors()` gave them. A
 * value that has been through a logical conversion cannot be compared
 * against a fresh `Monitor.position` on a HiDPI desk, and nothing in the
 * placement path wants the converted form anyway.
 *
 * Pure apart from the injected storage: no DOM, no Tauri, no timers.
 */

import { logger } from '../../utils/logger'
import {
  DEFAULT_FRAMEBUFFER_WIDTH,
  FRAMEBUFFER_WIDTHS,
  type OutputMode,
  type OutputRenderConfig,
} from './protocol'
import type { OutputMonitor, OutputRecord } from './manager'
import type { OutputViewSettings } from './stateAggregator'

export const OUTPUT_CONFIG_STORAGE_KEY = 'sos-multi-output-config'

/**
 * Schema version.
 *
 * The plan's shape carries no version field. One is added here because
 * the alternative is a stored blob that can only ever be re-parsed
 * optimistically: a future incompatible change would have to guess
 * whether an unrecognised object is old, corrupt, or from a newer build
 * the user has since downgraded from. A mismatch resets to defaults —
 * losing an output list an operator can rebuild in three clicks, rather
 * than half-applying a shape nobody wrote.
 */
export const OUTPUT_CONFIG_VERSION = 1

/**
 * How long to wait between spawning restored outputs.
 *
 * The spike's one measurable cost was startup contention — sixteen
 * outputs took ~160 ms longer to reach full rate than eight — so
 * restores are paced rather than fired together. Steady state was
 * unaffected, which is why this is a spawn-time delay and not a budget.
 */
export const OUTPUT_RESTORE_STAGGER_MS = 250

/** One persisted output. */
export interface PersistedOutput {
  /**
   * The window label it had last time, reused on restore when free so
   * `output-1` keeps meaning the same display across launches — which
   * is what makes it worth anything in a log or a health badge.
   */
  label: string
  /** OS-reported name; matched **with** `monitorOrigin`, never alone.
   *  `null` when the platform reported none, which Linux does. */
  monitorName: string | null
  /** Physical pixels, **signed**, exactly as reported. */
  monitorOrigin: { x: number; y: number }
  mode: OutputMode
  trackOperatorCamera: boolean
  split: boolean
  /**
   * Per-installation longitude rotation, degrees in `[0, 360)`
   * (rung 14).
   *
   * The one field here that is a property of the *room* rather than of
   * the session: a sphere's mounting does not change between launches,
   * so an operator calibrates once and this is what stops them doing
   * it again every morning.
   */
  rotationOffsetDeg: number
  /**
   * This output's render settings (rung 11).
   *
   * Both are the operator's explicit choice, so both come back — the
   * same rule every other field here follows. `debugOverlay` is the one
   * worth pausing on, because a HUD that survives a relaunch could in
   * principle greet an audience: it is persisted anyway, because it is
   * *self-announcing* (it is drawn on the sphere, so it cannot be
   * silently on) and because an operator diagnosing a fault across
   * relaunches is exactly who this rung is for. The alternative — one
   * setting that quietly does not come back — is a worse surprise.
   *
   * Added **without** a version bump: both are read with a default when
   * absent, so a config written before rung 11 restores unchanged.
   * Bumping would have reset every operator's outputs to buy nothing.
   */
  framebufferWidth: number
  debugOverlay: boolean
}

export interface PersistedOutputConfig {
  version: number
  outputs: PersistedOutput[]
  /** Opt-in, default false. Off means boot enumerates no monitors and
   *  opens no IPC link — the plan's "an install that never enabled
   *  outputs pays nothing". */
  autoRestoreOnLaunch: boolean
  /**
   * How many concurrent video decoders this machine is trusted with
   * (plan §"Cross-window decoder budget"), or `null` for "the operator
   * has not said".
   *
   * **Machine-scoped, not per-output**, because the constraint is: one
   * GPU and one media stack are shared by every window on the box, and
   * the whole reason this field exists is that `maxVideoPanels()`
   * answers per *window* and so cannot see the others.
   *
   * `null` rather than a stored default, so an unset budget keeps
   * tracking what the machine reports instead of freezing whatever it
   * reported the first time the panel was opened. A spike measured 16
   * outputs at 8192×4096 running at full rate on a 4090 laptop, and the
   * same code has to not crash an Intel-iGPU NUC — the value is a
   * property of the deployment, and the only honest default is to ask
   * the machine until someone who has measured it says otherwise.
   */
  concurrentDecoderBudget: number | null
}

export function defaultOutputConfig(): PersistedOutputConfig {
  return {
    version: OUTPUT_CONFIG_VERSION,
    outputs: [],
    autoRestoreOnLaunch: false,
    concurrentDecoderBudget: null,
  }
}

/**
 * A stored budget, or `null` for anything that is not a usable one.
 *
 * Whole and at least 1: a budget of 0 refuses every output *and* every
 * control panel, which reads as a broken app rather than as a setting,
 * and a fractional one makes `used < budget` depend on where the
 * rounding happens.
 */
export function parseDecoderBudget(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const whole = Math.floor(value)
  return whole >= 1 ? whole : null
}

/** The slice of `localStorage` this module uses. Injectable so a test
 *  needs no browser, and so a caller can hand in a null store. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The store the manager persists through. */
export interface OutputConfigStore {
  read(): PersistedOutputConfig
  write(config: PersistedOutputConfig): void
}

function defaultStorage(): StorageLike | null {
  try {
    // Access, not just presence: Safari in private mode has the object
    // and throws on use, and a throw here would take out the app boot
    // that reads this.
    if (typeof localStorage === 'undefined') return null
    localStorage.getItem(OUTPUT_CONFIG_STORAGE_KEY)
    return localStorage
  } catch {
    return null
  }
}

/**
 * Parse a stored blob, fail-closed.
 *
 * Anything unrecognised — wrong version, bad JSON, a non-array
 * `outputs`, an entry missing its origin — resolves to defaults rather
 * than to a partially-trusted object. This blob drives *window spawning*
 * on a machine an operator may not be sitting at, so a half-understood
 * entry is not worth acting on. Individual malformed entries are dropped
 * and the rest kept, because losing one output to a schema slip should
 * not cost an installation the other three.
 */
export function parseOutputConfig(raw: string | null): PersistedOutputConfig {
  if (!raw) return defaultOutputConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('[multiOutput] stored output config is not JSON; using defaults')
    return defaultOutputConfig()
  }
  if (!isRecord(parsed)) return defaultOutputConfig()
  if (parsed.version !== OUTPUT_CONFIG_VERSION) {
    logger.warn(
      `[multiOutput] stored output config is version ${String(parsed.version)}, ` +
        `expected ${OUTPUT_CONFIG_VERSION}; using defaults`,
    )
    return defaultOutputConfig()
  }
  const rawOutputs = Array.isArray(parsed.outputs) ? parsed.outputs : []
  const outputs: PersistedOutput[] = []
  for (const entry of rawOutputs) {
    const output = parseOutput(entry)
    if (output) outputs.push(output)
    else logger.warn('[multiOutput] dropping a malformed persisted output')
  }
  return {
    version: OUTPUT_CONFIG_VERSION,
    outputs,
    autoRestoreOnLaunch: parsed.autoRestoreOnLaunch === true,
    // Absent in a config written before rung 11c, and `null` there
    // means the same thing it means today: nobody has measured this
    // machine, so ask it. No version bump needed for that reason.
    concurrentDecoderBudget: parseDecoderBudget(parsed.concurrentDecoderBudget),
  }
}

function parseOutput(entry: unknown): PersistedOutput | null {
  if (!isRecord(entry)) return null
  const { label, monitorName, monitorOrigin, mode } = entry
  if (typeof label !== 'string' || !label) return null
  if (monitorName !== null && typeof monitorName !== 'string') return null
  if (!isRecord(monitorOrigin)) return null
  const { x, y } = monitorOrigin
  // `Number.isFinite`, not `typeof === 'number'`: `NaN` round-trips
  // through JSON as `null` but a hand-edited file can carry one, and a
  // NaN origin compares unequal to itself, so it would silently never
  // match any monitor.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (mode !== 'sos-equirect') return null
  return {
    label,
    monitorName,
    monitorOrigin: { x: x as number, y: y as number },
    mode,
    trackOperatorCamera: entry.trackOperatorCamera !== false,
    split: entry.split === true,
    // Normalised, not merely defaulted. A stored value outside one
    // turn is not wrong — 370 and 10 aim the sphere identically — but
    // the panel's slider has a range, and showing a number it cannot
    // represent is the same "two numbers, no way to tell which is
    // running" failure the framebuffer rung is narrowed against.
    rotationOffsetDeg: normalizeRotationOffset(entry.rotationOffsetDeg),
    // Defaulted rather than required: an entry written before rung 11
    // has neither key, and dropping it would cost an operator their
    // outputs on the launch after an update.
    //
    // Only a real rung is accepted. The scene snaps anything else, so a
    // stray number would not break an output — but it would leave the
    // panel's picker showing a value it cannot offer while the window
    // ran at a different one, and the operator with no way to tell.
    // Narrowing it here means every later reader has a rung.
    framebufferWidth: isFramebufferWidth(entry.framebufferWidth)
      ? entry.framebufferWidth
      : DEFAULT_FRAMEBUFFER_WIDTH,
    debugOverlay: entry.debugOverlay === true,
  }
}

/**
 * A stored rotation offset, folded into `[0, 360)`.
 *
 * Absent, non-finite or non-numeric resolves to `0` — a config written
 * before rung 14 has no key at all, and dropping the whole entry for
 * that would cost an operator their outputs on the launch after an
 * update (the rule rung 11's two fields already follow).
 *
 * A finite value is **wrapped rather than rejected**, and that is the
 * difference from `isFramebufferWidth` above. A framebuffer width off
 * the ladder is meaningless and gets replaced; 370° is perfectly
 * meaningful and aims the sphere exactly where 10° does, so throwing it
 * away would silently un-calibrate an installation whose operator
 * nudged past a full turn. `-20` wraps to `340` for the same reason.
 */
export function normalizeRotationOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/** Whether a stored value names a framebuffer rung this build offers. */
function isFramebufferWidth(value: unknown): value is number {
  return (FRAMEBUFFER_WIDTHS as readonly number[]).includes(value as number)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A store over `localStorage`, or an inert one where it is unavailable.
 *
 * Inert rather than throwing: a private-mode browser or a locked-down
 * webview should cost the operator persistence, not the feature. Reads
 * return defaults, writes are dropped, and everything above this line
 * keeps working.
 */
export function createOutputConfigStore(
  storage: StorageLike | null = defaultStorage(),
): OutputConfigStore {
  return {
    read() {
      if (!storage) return defaultOutputConfig()
      try {
        return parseOutputConfig(storage.getItem(OUTPUT_CONFIG_STORAGE_KEY))
      } catch (err) {
        logger.warn('[multiOutput] could not read output config:', err)
        return defaultOutputConfig()
      }
    },
    write(config) {
      if (!storage) return
      try {
        storage.setItem(OUTPUT_CONFIG_STORAGE_KEY, JSON.stringify(config))
      } catch (err) {
        // Quota, private mode, or a storage partition change. The live
        // outputs are unaffected; only the next launch is.
        logger.warn('[multiOutput] could not persist output config:', err)
      }
    },
  }
}

/**
 * Project a live output into its persisted form.
 *
 * Takes the record itself rather than its fields spread across
 * positional parameters — `Pick` ties this to the manager's own shape,
 * so a renamed field fails here instead of silently persisting
 * `undefined`. The dependency is type-only, and the manager already
 * flows the other way at runtime.
 */
export function toPersistedOutput(
  output: Pick<OutputRecord, 'label' | 'monitor' | 'mode' | 'view' | 'render'>,
): PersistedOutput {
  const { label, monitor, mode, view, render } = output
  return {
    label,
    monitorName: monitor.name,
    // Copied, not referenced: the record's monitor object outlives this
    // call, and a stored alias would let a later mutation rewrite
    // history that has already been serialised once.
    monitorOrigin: { x: monitor.position.x, y: monitor.position.y },
    mode,
    trackOperatorCamera: view.trackCamera,
    split: view.split,
    rotationOffsetDeg: view.rotationOffsetDeg,
    framebufferWidth: render.framebufferWidth,
    debugOverlay: render.debugOverlay,
  }
}

/**
 * The render settings a restored output comes back with.
 *
 * **`calibration` is absent from `PersistedOutput` on purpose, and
 * comes back off.** The rule is that what you calibrate persists and
 * the act of calibrating does not — `rotationOffsetDeg` is a property
 * of the room and must survive a relaunch, while a test pattern is a
 * property of the afternoon you spent aligning the rig.
 *
 * It is the one operator choice here that does not persist, which makes
 * it worth separating from `debugOverlay` beside it. The HUD is an
 * overlay *on* the content, so an installation that restored with it on
 * still shows its data with a small box in a corner: self-announcing
 * and degraded, but working. The pattern *replaces* the content, so an
 * installation that restored with it on shows no data at all — which is
 * the difference between a setting that came back and an installation
 * that did not.
 */
export function renderConfigFrom(output: PersistedOutput): OutputRenderConfig {
  return {
    framebufferWidth: output.framebufferWidth,
    debugOverlay: output.debugOverlay,
    calibration: false,
  }
}

/**
 * The view settings a restored or adopted output comes back with.
 *
 * Extracted at rung 14 because the mapping was written out twice — once
 * in `restoreOutputs`, once in `adoptOrphanedOutputs` — and a third
 * field is what made that a drift risk rather than a repetition. The
 * two paths must agree by construction: an operator who calibrates a
 * sphere and then reloads the control window would otherwise get their
 * rotation back from one path and not the other, and the symptom is a
 * picture turned a few degrees on a projector, which nothing on screen
 * would explain.
 *
 * Paired with `renderConfigFrom` above for the same reason it exists.
 */
export function viewSettingsFrom(output: PersistedOutput): OutputViewSettings {
  return {
    trackCamera: output.trackOperatorCamera,
    split: output.split,
    rotationOffsetDeg: output.rotationOffsetDeg,
  }
}

/**
 * Index of the monitor a persisted output should be restored onto, or
 * `null` when none matches.
 *
 * Requires name **and** signed origin. See the module header for why a
 * name-only match is treated as no match at all.
 */
export function matchMonitorIndex(
  output: PersistedOutput,
  monitors: readonly OutputMonitor[],
): number | null {
  const index = monitors.findIndex(
    monitor =>
      monitor.name === output.monitorName &&
      monitor.position.x === output.monitorOrigin.x &&
      monitor.position.y === output.monitorOrigin.y,
  )
  return index === -1 ? null : index
}
