// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The control window's mirrored-state accumulator.
 *
 * Every fact an output needs arrives here from a different place and on
 * a different schedule — a dataset load, a palette change, a playback
 * tick, a camera move — and leaves as one ordered stream of
 * `SharedStateMessage`s. Design: `docs/MULTI_MONITOR_PLAN.md` §3
 * "Globe state — what gets mirrored" and "Per-state-change flow".
 *
 * It is **pure**: no DOM, no Tauri, no timers, no subscriptions. Facts
 * are pushed in with `apply()` and messages come back as return values,
 * so the whole diff/sequence contract is testable without a window and
 * without a second monitor. `MultiOutputManager` owns the timer that
 * drives the per-second tick and the transport that emits the result;
 * this owns what is worth sending and what number it carries.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * **`full()` does not advance `seq`.** A full snapshot restates a point
 * the sequence has already reached — it is what a newly-ready output
 * gets so it can join mid-stream, not a new event. Bumping `seq` for it
 * would make two outputs that hold identical state disagree about how
 * far along they are, and the late joiner would out-rank a diff the
 * others correctly applied. Only a real change advances the sequence.
 *
 * **The view is projected per output, not stored per output.** What is
 * stored is `SharedView` — `dayNight` plus the operator's own
 * `camera` (MapLibre lat/lon/zoom). What an output receives is a
 * `MirroredView` arm, built at the send boundary by `projectView` from
 * that shared camera, the output's `OutputViewSettings` and its
 * `OutputMode`.
 *
 * So the camera is one fact stored once and *derived* N times, not one
 * derivation copied N times. Storing the derived value instead would
 * put N copies of it behind N update paths, drifting the moment one
 * missed an update — and it would have to be stored in some *one*
 * geometry's encoding, which is the thing this shape exists to avoid.
 * `split` is the other half of the per-output view and originates
 * there: it is a pure operator choice with no globe fact behind it.
 *
 * **The shared view has no mode**, and that is what makes an output
 * driven as the wrong geometry impossible rather than merely unlikely:
 * `projectView` takes the mode the output actually booted in, and
 * there is no canonical arm for it to fall back to.
 */

import {
  type MirroredGlobeState,
  type MirroredView,
  type OperatorCamera,
  type OutputGlobeState,
  type OutputMode,
  type SharedStateMessage,
  type SharedView,
} from './protocol'
// The one import that crosses from the control side into `src/output/`,
// and it is deliberate. `equirectRtt` is pure TS by construction — no
// Three, no GL, no DOM — precisely so the projection maths is testable
// without a context, which also makes it importable from here. The
// alternative is extracting `cameraOffsetForCamera` and the
// `MAX_CAMERA_OFFSET` it clamps against into a third module, and that
// splits the shader's own invariant away from the shader mirror that
// exists to hold it. Measured cost: Rollup gives `equirectRtt` its own
// chunk, shared by `manager` and the output bundle — one copy, fetched
// only by whoever imports it. The web entry chunk names that chunk in
// its dynamic-import preload map, exactly as it already names `manager`
// and `publisher`, and never fires the import. Check the markers
// (`sos-equirect`, `uCameraOffset` — both absent from
// `dist/assets/main-*.js`), never chunk filenames.
import { cameraOffsetForCamera } from '../../output/equirectRtt'
// Shared with the output's own store rather than defined here: both
// ends must give the same answer to "did this change?", and the cost
// of disagreeing is an output rebuilding its HLS instance on every
// idle heartbeat. See `stateEquality.ts`.
import { hasOwn, sameValue } from './stateEquality'

/** The camera offset that produces a uniform 1:1 equirectangular
 *  unwrap — the identity, and what an output that does not track the
 *  operator's camera always gets. */
export const CENTRED_CAMERA = { x: 0, y: 0, z: 0 } as const

/**
 * The operator camera an app starts with: the whole globe, unzoomed.
 *
 * `zoom: 0` is load-bearing rather than a placeholder. `sos-equirect`'s
 * derivation is `1 − 1/(zoom + 1)`, which is exactly `0` there, so this
 * camera produces `CENTRED_CAMERA` — the uniform 1:1 unwrap — without
 * that identity being written twice. `lat`/`lon` are then irrelevant to
 * the result, which is why any values will do for them; `0, 0` is
 * simply the least surprising pair to read. A mode added later gets the
 * same guarantee for free if its own derivation is centred at zoom 0,
 * and a test pins the equirect half of it.
 */
export const DEFAULT_OPERATOR_CAMERA: OperatorCamera = { lat: 0, lon: 0, zoom: 0 }

/**
 * The state before anything has loaded.
 *
 * `dayNight: true` matches the control globe's own default, so an
 * output opened on a freshly-booted app shows the same Earth the
 * operator is looking at rather than a flat-lit one that has to be
 * corrected by the first diff.
 */
export function initialState(): MirroredGlobeState {
  return {
    dataset: null,
    primary: null,
    playback: null,
    display: null,
    layers: [],
    simulationDate: null,
    view: {
      dayNight: true,
      camera: { ...DEFAULT_OPERATOR_CAMERA },
    },
  }
}

/**
 * The per-output half of the view — what the Outputs panel sets on one
 * output rather than on the globe.
 *
 * Left flat, unlike `MirroredView`, and the asymmetry is deliberate.
 * `trackCamera` is projection-independent (a flat mode would want a
 * per-output camera too), so only `split` is equirect-only here — one
 * field, against a wire type where it was two out of three. And this
 * shape is **persisted**: `PersistedOutput` mirrors it, so regrouping
 * it is a storage-schema change, and rung 10's version field resets a
 * mismatched blob rather than migrating it. Trading every operator's
 * saved outputs for the tidier home of one boolean is the wrong side
 * of that deal until a second mode actually needs it.
 */
export interface OutputViewSettings {
  /** When false, this output gets `CENTRED_CAMERA` regardless of where
   *  the operator has panned. */
  trackCamera: boolean
  /** Mirror the area of focus to the antipodal hemisphere.
   *  `sos-equirect` only — see `MirroredEquirectParams`. */
  split: boolean
  /**
   * Per-installation longitude rotation, **degrees** in `[0, 360)`
   * (rung 14).
   *
   * Degrees here and radians in `MirroredEquirectParams`, because this
   * type is what the operator edits and what gets persisted — the
   * number they type into the panel and read back next launch — while
   * the params object is what the shader is handed. `projectView` is
   * the single conversion, the same shape `camera` → `cameraOffset`
   * already has.
   *
   * Flat beside `split` rather than grouped, for the reason that type's
   * docstring gives: this is persisted, so regrouping would be a schema
   * change that resets every operator's saved outputs.
   */
  rotationOffsetDeg: number
}

export const DEFAULT_VIEW_SETTINGS: OutputViewSettings = {
  trackCamera: true,
  split: false,
  rotationOffsetDeg: 0,
}

/**
 * Build one output's view from the shared one and that output's own
 * settings and mode.
 *
 * This is where the operator's camera becomes a *geometry's* camera,
 * and it is the only place that conversion happens. The shared view
 * holds `OperatorCamera` — MapLibre's own lat/lon/zoom — so no mode is
 * privileged: `sos-equirect` derives a ray-march origin from it here,
 * and a mode added later derives its own thing from the same three
 * numbers rather than from equirect's answer.
 *
 * **`mode` is an argument, not a property of `shared`.** The arm an
 * output receives is a property of *that output*; the shared state has
 * no mode at all now, which is what makes that impossible to get wrong.
 *
 * Each arm is built **whole**, field by field. Spreading would pass
 * through any field a later commit adds to that arm's params without
 * deciding whether it is shared or per-output — and the wrong answer
 * there is invisible, because it looks like the setting simply working.
 *
 * The `switch` has one arm today. It is a `switch` rather than an `if`
 * because that is where a second mode's derivation goes, and because
 * the exhaustiveness check below turns "you added a mode and forgot to
 * project it" into a compile error rather than a projection that
 * returns the wrong geometry.
 */
export function projectView(
  shared: SharedView,
  settings: OutputViewSettings,
  mode: OutputMode,
): MirroredView {
  switch (mode) {
    case 'sos-equirect':
      return {
        mode: 'sos-equirect',
        dayNight: shared.dayNight,
        params: {
          // Derived here, once per output, from the one shared camera —
          // rather than derived once and stored, which would be a
          // second copy of the same fact, or derived by each output,
          // which would be N copies of the same code.
          cameraOffset: settings.trackCamera
            ? cameraOffsetForCamera(shared.camera.lat, shared.camera.lon, shared.camera.zoom)
            : { ...CENTRED_CAMERA },
          split: settings.split,
          // The one place degrees become radians. A non-finite stored
          // value resolves to no rotation rather than reaching the
          // shader as a NaN longitude, which would make every ray miss
          // — the same guard `operatorCameraFrom` applies to a camera
          // MapLibre reported as NaN.
          rotationOffsetRad: Number.isFinite(settings.rotationOffsetDeg)
            ? (settings.rotationOffsetDeg * Math.PI) / 180
            : 0,
        },
      }
    default:
      // `mode` narrows to `never` here while every `OutputMode` has a
      // case above. Adding one without a case makes this assignment
      // fail, which is the whole point of the annotation.
      return assertUnreachableMode(mode)
  }
}

/** Reached only if a new `OutputMode` skipped `projectView`'s switch —
 *  a compile error there, and a loud one here if it is ever forced
 *  through at runtime by an `as`. */
function assertUnreachableMode(mode: never): never {
  throw new Error(`[multiOutput] no view projection for mode: ${String(mode)}`)
}

/**
 * Re-state a whole shared snapshot or diff for one output.
 *
 * Overloaded rather than generic in the state, because this is the
 * boundary where the two state types meet: a complete
 * `MirroredGlobeState` becomes a complete `OutputGlobeState`, and a
 * diff becomes a diff. One signature returning `T` would have to claim
 * the view came out the same type it went in, which is exactly what
 * stopped being true.
 *
 * A diff that does not mention `view` passes through **by reference**:
 * projecting an absent key into a present one would turn "nothing about
 * the view changed" into a redundant write on every unrelated update.
 */
export function projectState(
  state: MirroredGlobeState,
  settings: OutputViewSettings,
  mode: OutputMode,
): OutputGlobeState
export function projectState(
  state: Partial<MirroredGlobeState>,
  settings: OutputViewSettings,
  mode: OutputMode,
): Partial<OutputGlobeState>
export function projectState(
  state: Partial<MirroredGlobeState>,
  settings: OutputViewSettings,
  mode: OutputMode,
): Partial<OutputGlobeState> {
  // Sound because the guard proves `view` is absent, and every other
  // key is identical between the two states. The cast is what lets the
  // reference — not a copy — reach the caller, which the "untouched
  // diff" contract above depends on.
  if (!state.view) return state as Partial<OutputGlobeState>
  return { ...state, view: projectView(state.view, settings, mode) }
}

/**
 * Every top-level key of the mirrored state, so `apply` can walk a
 * patch without trusting its shape.
 *
 * The two guards below make this list **exhaustive at compile time**.
 * Without them a key added to `MirroredGlobeState` type-checks
 * everywhere and is simply never diffed — the output would only ever
 * learn about it from a `full()` snapshot, so the bug would look like
 * "that setting takes a second to apply" rather than like a missing
 * case.
 */
const STATE_KEYS = [
  'dataset',
  'primary',
  'playback',
  'display',
  'layers',
  'simulationDate',
  'view',
] as const satisfies readonly (keyof MirroredGlobeState)[]

/**
 * Compile-time proof that `STATE_KEYS` names every key.
 *
 * `Exclude` is empty — `never` — only when nothing is missing, so the
 * `extends never` constraint fails to satisfy the moment a key is added
 * to `MirroredGlobeState` without being listed above.
 *
 * It has to be a *constraint* rather than a value. The obvious version,
 * `const _: MissingStateKey[] = []`, compiles happily whatever the type
 * resolves to, because an empty array literal is assignable to every
 * array type — a guard that reads correctly and checks nothing. (It was
 * written that way first, and only caught by deleting a key to see the
 * build stay green.)
 */
type AssertNoneMissing<T extends never> = T
type _StateKeysAreExhaustive = AssertNoneMissing<
  Exclude<keyof MirroredGlobeState, (typeof STATE_KEYS)[number]>
>

/**
 * Fold one key of a patch into the state, recording it in `changed`.
 * Returns whether anything moved.
 *
 * Generic over the single key rather than inlined into `apply`'s loop
 * because a union-typed key makes `state[key] = patch[key]` unsound to
 * TypeScript — the write would demand the *intersection* of every value
 * type. Pinning `K` per call keeps the read and the write on the same
 * indexed access, which is what makes this safe without a cast.
 */
function foldKey<K extends keyof MirroredGlobeState>(
  state: MirroredGlobeState,
  changed: Partial<MirroredGlobeState>,
  patch: Partial<MirroredGlobeState>,
  key: K,
): boolean {
  if (!hasOwn(patch, key)) return false
  const next = patch[key]
  // `{ dataset: undefined }` is what a spread of an optional field
  // produces, and it means "I have nothing to say about this", never
  // "clear it" — the schema spells absence as `null`. Forwarding it
  // would also be a broadcast the output cannot act on: structured
  // clone drops an `undefined` property outright, so the diff would
  // arrive naming a key that is not there.
  if (next === undefined) return false
  if (sameValue(state[key], next)) return false
  // Stored as a **copy**, not by reference. Holding the caller's object
  // means a later in-place mutation of it also mutates the state we
  // compare against, so the next `apply()` hits the `a === b` fast path
  // and the change is silently absorbed — the outputs keep rendering
  // the old value with nothing on either side able to notice. Every
  // value here is structured-clone-safe by contract (`protocol.ts`),
  // which is exactly what makes this the cheap fix rather than a
  // convention nobody can enforce.
  const stored = clone(next)
  state[key] = stored
  changed[key] = stored
  return true
}

/**
 * Deep copy of a mirrored-state value.
 *
 * `structuredClone` where the runtime has it; every value crossing this
 * module is plain JSON-shaped data, so the JSON round trip is an exact
 * fallback rather than an approximation.
 */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

export class StateAggregator {
  private state: MirroredGlobeState = initialState()
  private seq = 0

  /** The current shared state. Returned by reference for reads; callers
   *  must not mutate it — every write goes through `apply`. */
  current(): Readonly<MirroredGlobeState> {
    return this.state
  }

  /** How far the sequence has advanced. Exposed for the manager's
   *  bookkeeping and for tests; not part of the wire format. */
  sequence(): number {
    return this.seq
  }

  /**
   * Fold a patch into the state.
   *
   * Returns the diff message to broadcast, or `null` when nothing
   * actually changed — which is the common case for the per-second
   * tick on a paused globe, and the reason the tick can run
   * unconditionally instead of being started and stopped alongside
   * playback.
   *
   * Only the keys that changed appear in the diff. A patch naming a key
   * whose value is structurally identical is dropped rather than
   * forwarded: an output that rebuilds an HLS instance on `dataset` has
   * to be able to trust that a `dataset` in a diff means a *different*
   * dataset.
   */
  apply(patch: Partial<MirroredGlobeState>): SharedStateMessage | null {
    const changed: Partial<MirroredGlobeState> = {}
    let any = false

    for (const key of STATE_KEYS) {
      if (foldKey(this.state, changed, patch, key)) any = true
    }

    if (!any) return null

    this.seq += 1
    return { seq: this.seq, full: false, state: changed }
  }

  /**
   * The whole state, stamped with the sequence number it is current as
   * of. Sent to an output on `output_ready` and after a reconnect.
   */
  full(): SharedStateMessage {
    return { seq: this.seq, full: true, state: this.state }
  }

  /**
   * Advance the sequence without changing the state, and return the new
   * value.
   *
   * For a message that is a genuine new event for **one** output but
   * not a change to shared state — today, only the per-output view
   * projection when the operator toggles that output's own settings.
   * Such a message still has to out-rank every diff that output has
   * already applied, and re-using the current `seq` does not: the
   * output coalesces most-recent-wins, so an equal number loses and the
   * update is silently dropped.
   *
   * The cost is that the other outputs see a **gap** in the sequence.
   * That is deliberate and safe: `seq` is an ordering key, not a
   * delivery counter, and nothing on either side infers loss from a
   * skipped number. Do not add a gap detector without first giving
   * per-output messages their own sequence space.
   */
  bump(): number {
    this.seq += 1
    return this.seq
  }

  /**
   * Drop back to the initial state and restart the sequence.
   *
   * The counterpart to the protocol's "it resets on manager restart,
   * which a `full` snapshot always accompanies" — a caller that resets
   * owes every live output a `full()` immediately, or they will hold
   * state from the previous session at sequence numbers the new one is
   * about to reuse.
   */
  reset(): void {
    this.state = initialState()
    this.seq = 0
  }
}
