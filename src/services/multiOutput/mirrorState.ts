// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pure projections from the control window's app types into the
 * protocol's mirrored shapes (`docs/MULTI_MONITOR_PLAN.md` §3 "Globe
 * state — what gets mirrored").
 *
 * This is the translation layer `main.ts` would otherwise carry inline.
 * It lives here because the derivations have correctness content worth
 * testing — which URL an output is told to fetch, what an absent
 * overlay bundle becomes — and `main.ts` is four thousand lines with no
 * unit test to put them in.
 *
 * Pure: no DOM, no Tauri, no fetch. Takes plain values rather than a
 * `PanelState`, so a test does not have to build an `HTMLImageElement`
 * or an `HLSService` to exercise the mapping.
 */

import type { Dataset, DatasetOverlayOptions } from '../../types'
import { isDefaultDisplay, type ColorScaleDisplay } from '../colorScaleDisplay'
import { overlayOptionsFromDataset } from '../datasetOverlayOptions'
import { videoTimeToDate } from '../../utils/time'
import type {
  MirroredDataset,
  MirroredPlayback,
  MirroredPrimary,
  OperatorCamera,
  SharedView,
} from './protocol'

/**
 * The overlay bundle to mirror for `dataset`.
 *
 * `overlayOptionsFromDataset` returns `undefined` for the common case —
 * a global, prime-meridian, unflipped Earth picture — because the
 * renderer's option-aware path is an opt-in and the fast path is worth
 * keeping. The wire format has no such fast path: `MirroredDataset
 * .overlay` is required, and the reason it is required is the identity
 * pair. `datasetId` / `datasetTitle` travel with the geometry so a
 * frame can say what it is without asking app state and hoping the two
 * agree, and that argument does not weaken for a dataset whose geometry
 * happens to be the default.
 *
 * So the fallback is the identity-only bundle: every geometric field
 * left `undefined`, which is what the fast path means, plus the two
 * fields that say which dataset this is.
 */
export function overlayForMirror(dataset: Dataset): DatasetOverlayOptions {
  return (
    overlayOptionsFromDataset(dataset) ?? {
      datasetId: dataset.id,
      datasetTitle: dataset.title,
    }
  )
}

/**
 * Build the `MirroredDataset` for a loaded dataset, or `null` when it
 * cannot be mirrored yet.
 *
 * `url` is the URL the **control** window resolved — after offline-cache
 * lookup and variant probing — because the protocol makes that the
 * control window's job and an output never resolves one itself. A null
 * or empty `url` therefore yields `null` rather than a `MirroredDataset`
 * carrying an empty string: an output handed `''` would fetch the
 * output page's own document URL and decode it as a texture, which
 * fails somewhere far away from here. `null` is the value the schema
 * already defines as "nothing loaded", and the idle photoreal Earth is
 * a better wrong answer than a broken one.
 *
 * `startTime` / `endTime` are normalised to `null` rather than left
 * `undefined`: they cross a structured-clone boundary into a state the
 * aggregator diffs by deep structural equality, and an absent key and a
 * present-but-undefined one are different objects there while meaning
 * the same thing. `null` is also what the rest of the schema already
 * uses for "no value", so the output has one absence to handle.
 */
export function toMirroredDataset(
  dataset: Dataset,
  kind: 'image' | 'video',
  url: string | null | undefined,
): MirroredDataset | null {
  if (!url) return null
  return {
    id: dataset.id,
    url,
    kind,
    overlay: overlayForMirror(dataset),
    startTime: dataset.startTime ?? null,
    endTime: dataset.endTime ?? null,
  }
}

/**
 * What a panel's `(dataset, mediaDatasetId)` pair says about whether it
 * can be mirrored.
 *
 * - `empty` — nothing loaded; an output should show the idle Earth.
 * - `ready` — the row and the pixels agree, so the frame can be described.
 * - `unsettled` — they disagree. The panel's `dataset` is assigned before
 *   a load is attempted and stays set when one fails, while one is in
 *   flight, and for a `tour/json` row that paints nothing — in each case
 *   the panel still holds the *previous* dataset's pixels. Mirroring
 *   from the row alone would put one dataset's texture under another's
 *   bbox, `lonOrigin`, flip and palette, labelled with the wrong title.
 *
 * Split out of `main.ts` because it is the one piece of that wiring with
 * a wrong answer available, and `main.ts` has no exports to test through.
 */
export type PanelMirrorState = 'empty' | 'ready' | 'unsettled'

export function panelMirrorState(
  datasetId: string | null | undefined,
  mediaDatasetId: string | null,
): PanelMirrorState {
  if (!datasetId) return mediaDatasetId === null ? 'empty' : 'unsettled'
  return mediaDatasetId === datasetId ? 'ready' : 'unsettled'
}

/**
 * The operator's camera, normalised for the wire.
 *
 * Three things are wrong answers waiting to happen, and all three are
 * MapLibre's own behaviour rather than anything invented here.
 *
 * **Longitude accumulates.** `map.getCenter().lng` is not wrapped: drag
 * east around the globe three times and it reads 900-odd, not 180.
 * `OperatorCamera.lon` is documented −180..180 and
 * `cameraOffsetForCamera` derives a *direction vector* from it, so an
 * un-normalised value does not merely look odd — it aims the output's
 * camera somewhere the operator is not, and it gets further wrong the
 * longer they pan.
 *
 * **Latitude can exceed the poles** at some pitches, and a camera
 * outside the sphere is exactly what `MAX_CAMERA_OFFSET` exists to
 * prevent; clamping here keeps the shader's no-miss-branch assumption
 * true at the source rather than relying on the clamp downstream.
 *
 * **A non-finite value poisons everything it touches.** A `NaN` zoom
 * reaches the shader as a `NaN` offset, and every ray misses; the
 * output goes black, which is the one failure the 1 Hz floor exists to
 * make visible. Falling back to the last good value is not possible
 * here (this is pure), so it falls back to the centred default, which
 * is a picture rather than an absence.
 */
export function operatorCameraFrom(lat: number, lon: number, zoom: number): OperatorCamera {
  return {
    lat: Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : 0,
    lon: Number.isFinite(lon) ? wrapLongitude(lon) : 0,
    // Negative zoom is meaningful to MapLibre but not to
    // `cameraOffsetForCamera`, whose `1 − 1/(z+1)` goes negative below
    // zero and inverts the warp. Floored at the whole-globe view.
    zoom: Number.isFinite(zoom) ? Math.max(0, zoom) : 0,
  }
}

/**
 * The whole shared view, built around a camera.
 *
 * `SharedView` is published as one value because the aggregator diffs
 * whole keys — there is no partial-view patch, and inventing one would
 * mean the aggregator held something it had never been sent in full.
 *
 * **`dayNight` is a constant here, not a plumbed value.** Nothing on
 * the control side toggles it: the globe draws its terminator
 * unconditionally, and the output's shader does not consume the flag
 * yet (plan §"What the equirect path does to the Earth decoration").
 * `true` is what the aggregator already defaults to, so publishing it
 * changes nothing today — and this is the one line to change when a
 * real toggle lands, rather than a `false` the operator cannot explain.
 *
 * Built here rather than in `main.ts` because `main.ts` must not import
 * `stateAggregator` — that pulls the manager cluster into the web entry
 * chunk, the regression `c8df3380` removed — and this module is already
 * on its runtime import path.
 */
export function sharedViewFrom(camera: OperatorCamera): SharedView {
  return { dayNight: true, camera }
}

/** Fold any longitude into −180..180, keeping 180 rather than −180 so a
 *  camera parked on the antimeridian does not flip sign frame to frame
 *  and re-broadcast forever. */
function wrapLongitude(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/** What the primary's element and dataset need to offer before a
 *  playhead can be placed on a real-world timeline at all. */
export interface PrimaryPlaybackInput {
  currentTime: number
  duration: number
  paused: boolean
  /** Read from the element, **never** assumed to be 1 — a tour's
   *  `frameRate` task sets the primary's rate alone (terraviz#229). */
  playbackRate: number
  /** The dataset's own span. `null` for a dataset with no time axis. */
  startTime: string | null | undefined
  endTime: string | null | undefined
}

/**
 * Where the primary's playhead is.
 *
 * `null` only when there is no playhead to describe at all — no media,
 * or a duration or position that has not firmed up. **A missing time
 * axis is not that case.** A dataset without `startTime`/`endTime` has
 * no instant, but it still has a position in its clip, a rate, and a
 * play/pause state, and an output told none of those has no reason to
 * ever call `play()`. It shipped that way and left every SOS looping
 * animation — Air Traffic among them — frozen on its first decoded
 * frame on every output while the control globe played.
 *
 * So the absence is expressed as `date: null` inside a published
 * record rather than as a withheld record, and `positionRatio` carries
 * the position that survives having no clock.
 *
 * The date comes from `videoTimeToDate`, the same function the control
 * window's own time label and sibling sync use. A second derivation
 * here could disagree with the one the operator is reading.
 */
export function playbackFrom(input: PrimaryPlaybackInput): MirroredPlayback | null {
  if (!Number.isFinite(input.duration) || input.duration <= 0) return null
  if (!Number.isFinite(input.currentTime)) return null

  const base = {
    // Clamped rather than trusted: `currentTime` can sit a hair past
    // `duration` on an ended element, and the output multiplies this by
    // its own duration to get a seek target.
    positionRatio: Math.max(0, Math.min(1, input.currentTime / input.duration)),
    paused: input.paused,
    // A zero or negative rate is a stopped clock wearing a rate. The
    // output would divide by it; 1 is the value every other consumer
    // assumes when the element has not said otherwise.
    playbackRate:
      Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1,
  }

  const span = datasetSpan(input.startTime, input.endTime)
  if (!span) return { ...base, date: null }

  const date = videoTimeToDate(input.currentTime, input.duration, span.start, span.end)
  // A span that parses but still yields no instant. The position path
  // is the honest fallback, not a reason to publish nothing.
  if (Number.isNaN(date.getTime())) return { ...base, date: null }

  return { ...base, date: date.toISOString() }
}

/**
 * The primary's shape — how long the media is, and how much real time
 * it covers.
 *
 * Separate from `playbackFrom` because it changes on a dataset load and
 * not on a frame, and the aggregator diffs the two keys independently:
 * an output that rebuilt anything on `primary` would otherwise do it
 * sixty times a second.
 */
export function primaryFrom(
  duration: number,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): MirroredPrimary | null {
  const span = datasetSpan(startTime, endTime)
  if (!span) return null
  if (!Number.isFinite(duration) || duration <= 0) return null
  return { duration, rangeMs: span.end.getTime() - span.start.getTime() }
}

/**
 * A dataset's temporal span, or `null` for anything that is not one.
 *
 * Rejects an unparseable bound and a non-positive range. A zero-length
 * span would make `videoTimeToDate` divide by zero, and a reversed one
 * runs the output's clock backwards — both silent, both showing a
 * confidently wrong instant.
 */
function datasetSpan(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): { start: Date; end: Date } | null {
  if (!startTime || !endTime) return null
  const start = new Date(startTime)
  const end = new Date(endTime)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  if (end.getTime() <= start.getTime()) return null
  return { start, end }
}

/**
 * The operator's palette / stretch / threshold, as the wire carries it.
 *
 * The identity collapses to `null` rather than travelling as
 * `DEFAULT_DISPLAY`, and that is not tidiness. Two things already treat
 * `null` as "no transform": the aggregator holds it before the operator
 * has touched anything, and `outputScene.paletteTexture` reads it as
 * "build the dataset's own ramp". Publishing the identity object
 * instead would put a second encoding of the same fact on the wire,
 * reaching the shader down a different path — `buildDisplayLut` with
 * identity parameters rather than `buildColorScaleLut` — which then has
 * to agree byte for byte forever, and which the aggregator's structural
 * equality cannot collapse because the two values genuinely differ.
 *
 * The visible consequence is the reset: an operator who tries magma and
 * goes back to source returns the wire to the state a freshly-booted
 * output is already in, rather than leaving every output on a transform
 * that happens to be a no-op.
 *
 * `isDefaultDisplay` is imported rather than re-derived — it exists for
 * this question, and a second copy of "what counts as no transform"
 * would be free to disagree with the control window's own reset control.
 */
export function displayForMirror(display: ColorScaleDisplay): ColorScaleDisplay | null {
  return isDefaultDisplay(display) ? null : display
}
