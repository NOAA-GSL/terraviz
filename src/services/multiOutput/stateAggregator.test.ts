// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the mirrored-state accumulator.
 *
 * Three properties carry the contract with the output window, and each
 * one fails silently on a real sphere if it breaks: a diff must name
 * only what changed (an output rebuilds its HLS instance on `dataset`),
 * `seq` must never go backwards or repeat (the output coalesces
 * most-recent-wins, so a repeat lets a stale message win), and the
 * per-output view projection must not turn an absent key into a
 * present one.
 */

import { describe, it, expect } from 'vitest'
import type {
  MirroredDataset,
  MirroredGlobeState,
  MirroredLayer,
  SharedView,
} from './protocol'
import { isFullState } from './protocol'
import {
  CENTRED_CAMERA,
  DEFAULT_OPERATOR_CAMERA,
  DEFAULT_VIEW_SETTINGS,
  StateAggregator,
  initialState,
  projectState,
  projectView,
} from './stateAggregator'
import { MAX_CAMERA_OFFSET } from '../../output/equirectRtt'

const DATASET: MirroredDataset = {
  id: 'ds-1',
  url: 'https://example.test/a.m3u8',
  kind: 'video',
  overlay: { datasetId: 'ds-1', boundingBox: { n: 50, s: 24, w: -125, e: -66 } },
  startTime: '2026-01-01T00:00:00.000Z',
  endTime: '2026-01-08T00:00:00.000Z',
}

const LAYER: MirroredLayer = {
  id: 'l-1',
  datasetId: 'ds-2',
  url: 'https://example.test/b.png',
  kind: 'image',
  overlay: { datasetId: 'ds-2' },
}

describe('initial state', () => {
  it('is a fresh object each call, so one aggregator cannot alias another', () => {
    const a = initialState()
    const b = initialState()
    expect(a).not.toBe(b)
    expect(a.view.camera).not.toBe(b.view.camera)
    expect(a).toEqual(b)
  })

  it('starts centred, empty and day/night on', () => {
    const s = initialState()
    expect(s.dataset).toBeNull()
    expect(s.playback).toBeNull()
    expect(s.layers).toEqual([])
    expect(s.view.dayNight).toBe(true)
    // No mode on the shared view at all — that is the point of the
    // split. The arm only exists once an output is projected for.
    expect(s.view).not.toHaveProperty('mode')
    expect(s.view.camera).toEqual(DEFAULT_OPERATOR_CAMERA)
  })
})

describe('apply', () => {
  it('returns null when nothing changed, so the tick is free on a paused globe', () => {
    const agg = new StateAggregator()
    expect(agg.apply({})).toBeNull()
    expect(agg.apply({ dataset: null })).toBeNull()
    expect(agg.apply({ layers: [] })).toBeNull()
    expect(agg.sequence()).toBe(0)
  })

  it('names only the keys that changed', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET, simulationDate: '2026-01-01T00:00:00Z' })

    const msg = agg.apply({
      dataset: DATASET,
      simulationDate: '2026-01-02T00:00:00Z',
    })

    expect(msg).not.toBeNull()
    expect(Object.keys(msg!.state)).toEqual(['simulationDate'])
    expect(msg!.full).toBe(false)
  })

  it('drops a structurally identical value rather than re-broadcasting it', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })

    // A fresh object with the same contents — what a call site that
    // rebuilds its options bundle every load actually produces.
    const rebuilt: MirroredDataset = {
      id: 'ds-1',
      url: 'https://example.test/a.m3u8',
      kind: 'video',
      overlay: { datasetId: 'ds-1', boundingBox: { n: 50, s: 24, w: -125, e: -66 } },
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-08T00:00:00.000Z',
    }
    expect(agg.apply({ dataset: rebuilt })).toBeNull()
  })

  it('compares regardless of key order', () => {
    const agg = new StateAggregator()
    agg.apply({
      view: { dayNight: true, camera: { lat: 10, lon: 20, zoom: 3 } },
    })
    const reordered = {
      camera: { zoom: 3, lon: 20, lat: 10 },
      dayNight: true,
    }
    expect(agg.apply({ view: reordered })).toBeNull()
  })

  it('ignores an explicitly-undefined key rather than clearing it', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    // `{ dataset: undefined }` is what a spread of an optional field
    // produces. It must not be read as "clear the dataset" — the
    // schema spells absence as `null` — and it must not go on the
    // wire, since structured clone drops an `undefined` property and
    // the output would receive a diff naming a key that is not there.
    expect(agg.apply({ dataset: undefined })).toBeNull()
    expect(agg.current().dataset).toEqual(DATASET)
    expect(agg.sequence()).toBe(1)
  })

  it('detects a layer reorder, since array order is z-order', () => {
    const agg = new StateAggregator()
    const second: MirroredLayer = { ...LAYER, id: 'l-2', datasetId: 'ds-3' }
    agg.apply({ layers: [LAYER, second] })
    const msg = agg.apply({ layers: [second, LAYER] })
    expect(msg).not.toBeNull()
    expect((msg!.state as MirroredGlobeState).layers.map(l => l.id)).toEqual(['l-2', 'l-1'])
  })

  it('detects a change nested inside overlay', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const shifted: MirroredDataset = {
      ...DATASET,
      overlay: { ...DATASET.overlay, lonOrigin: 180 },
    }
    expect(agg.apply({ dataset: shifted })).not.toBeNull()
  })

  it('stores a copy, so a caller mutating its own object cannot go unnoticed', () => {
    const agg = new StateAggregator()
    const layers: MirroredLayer[] = [LAYER]
    agg.apply({ layers })

    // A caller that pushes onto the array it already handed over would
    // otherwise hit the `a === b` fast path: the aggregator's "previous"
    // value *is* the mutated one, so the diff is silently absorbed and
    // the outputs keep rendering one layer forever.
    layers.push({ ...LAYER, id: 'l-2' })
    const msg = agg.apply({ layers })

    expect(msg).not.toBeNull()
    expect((msg!.state as MirroredGlobeState).layers).toHaveLength(2)
  })

  it('does not expose its internals for outside mutation', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const held = agg.current().dataset!

    // Same hazard from the other direction: the stored object must not
    // be the caller's, or a later edit of theirs rewrites our state.
    expect(held).not.toBe(DATASET)
    expect(held).toEqual(DATASET)
  })

  it('detects a null → value transition and back', () => {
    const agg = new StateAggregator()
    expect(agg.apply({ playback: { date: '2026-01-01T00:00:00Z', positionRatio: 0.5, paused: false, playbackRate: 1 } })).not.toBeNull()
    expect(agg.apply({ playback: null })).not.toBeNull()
    expect(agg.apply({ playback: null })).toBeNull()
  })
})

describe('sequence numbers', () => {
  it('advances by one per real change and never for a no-op', () => {
    const agg = new StateAggregator()
    expect(agg.apply({ dataset: DATASET })!.seq).toBe(1)
    expect(agg.apply({})).toBeNull()
    expect(agg.apply({ simulationDate: '2026-03-01T00:00:00Z' })!.seq).toBe(2)
  })

  it('does not advance for full(), so a late joiner cannot out-rank a diff', () => {
    const agg = new StateAggregator()
    const diff = agg.apply({ dataset: DATASET })!
    const snap = agg.full()

    expect(snap.seq).toBe(diff.seq)
    expect(isFullState(snap)).toBe(true)
    // And the next real change still moves past both.
    expect(agg.apply({ simulationDate: '2026-03-01T00:00:00Z' })!.seq).toBe(diff.seq + 1)
  })

  it('full() carries the whole state, not just what changed', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const snap = agg.full()
    expect(isFullState(snap)).toBe(true)
    expect(snap.state).toEqual(agg.current())
    expect((snap.state as MirroredGlobeState).layers).toEqual([])
  })

  it('bump() advances the sequence without touching the state', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const before = agg.current()

    expect(agg.bump()).toBe(2)
    expect(agg.sequence()).toBe(2)
    expect(agg.current()).toEqual(before)
    // And the next real change keeps going up, so a bumped message and
    // the diff after it can never collide.
    expect(agg.apply({ simulationDate: '2026-06-06T00:00:00Z' })!.seq).toBe(3)
  })

  it('bump() outranks the diff an output has already applied', () => {
    const agg = new StateAggregator()
    const applied = agg.apply({ dataset: DATASET })!
    // The failure this exists to prevent: an equal seq loses under
    // most-recent-wins coalescing, so the message is silently dropped.
    expect(agg.bump()).toBeGreaterThan(applied.seq)
  })

  it('reset() returns to the initial state and restarts the sequence', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    agg.reset()
    expect(agg.sequence()).toBe(0)
    expect(agg.current()).toEqual(initialState())
    expect(agg.apply({ dataset: DATASET })!.seq).toBe(1)
  })
})

describe('per-output view projection', () => {
  /**
   * `lat: 90` is chosen so the derived offset is order-sensitive:
   * `latLonToDirection` puts latitude on **Y**, so this camera derives
   * to `(0, f, 0)`. A `projectView` that passed lat and lon the wrong
   * way round would produce `(0, 0, f)` and fail — which asserting
   * against `cameraOffsetForCamera(...)` with the same argument order
   * could never catch.
   *
   * `zoom: 1` gives `f = 1 − 1/(1 + 1) = 0.5`, under the clamp.
   */
  const shared = {
    dayNight: false,
    camera: { lat: 90, lon: 0, zoom: 1 },
  }

  it('passes the operator camera through when tracking', () => {
    const v = projectView(shared, { trackCamera: true, split: false, rotationOffsetDeg: 0 }, 'sos-equirect')
    expect(v.params.cameraOffset.x).toBeCloseTo(0, 10)
    expect(v.params.cameraOffset.y).toBeCloseTo(0.5, 10)
    expect(v.params.cameraOffset.z).toBeCloseTo(0, 10)
    expect(v.dayNight).toBe(false)
  })

  it('centres the camera when not tracking', () => {
    const v = projectView(shared, { trackCamera: false, split: false, rotationOffsetDeg: 0 }, 'sos-equirect')
    expect(v.params.cameraOffset).toEqual(CENTRED_CAMERA)
  })

  it('takes split from the output, never from the shared view', () => {
    expect(
      projectView(shared, { trackCamera: true, split: true, rotationOffsetDeg: 0 }, 'sos-equirect').params.split,
    ).toBe(true)
    // There is nowhere on the shared view for a `split` to come from
    // any more — it is not a globe fact — so the output's own setting
    // is the only source by construction.
    expect(shared).not.toHaveProperty('split')
    expect(
      projectView(shared, DEFAULT_VIEW_SETTINGS, 'sos-equirect').params.split,
    ).toBe(false)
  })

  it('does not alias the shared offset, so one output cannot mutate another', () => {
    const a = projectView(shared, { trackCamera: true, split: false, rotationOffsetDeg: 0 }, 'sos-equirect')
    const b = projectView(shared, { trackCamera: true, split: false, rotationOffsetDeg: 0 }, 'sos-equirect')
    // Each output gets its own object graph. The offset is derived per
    // projection now rather than copied from a stored one, so two
    // outputs cannot end up sharing — but that has to stay true if the
    // derivation is ever memoised.
    expect(a.params.cameraOffset).not.toBe(b.params.cameraOffset)
    expect(a.params).not.toBe(b.params)
    expect(a.params.cameraOffset).toEqual(b.params.cameraOffset)
  })

  it('leaves a diff without a view untouched', () => {
    const diff = { simulationDate: '2026-01-01T00:00:00Z' }
    const projected = projectState(diff, { trackCamera: false, split: true, rotationOffsetDeg: 0 }, 'sos-equirect')
    expect(projected).toBe(diff)
    expect('view' in projected).toBe(false)
  })

  it('projects a diff that does carry a view', () => {
    const diff = { view: shared }
    const projected = projectState(diff, { trackCamera: false, split: true, rotationOffsetDeg: 0 }, 'sos-equirect')
    expect(projected.view!.params.cameraOffset).toEqual(CENTRED_CAMERA)
    expect(projected.view!.params.split).toBe(true)
    // The input is not mutated — two outputs project the same diff.
    expect(diff.view.camera).toEqual({ lat: 90, lon: 0, zoom: 1 })
  })

  it('stamps the arm with the mode the output was given', () => {
    // The discriminant is what lets an output check the view it
    // received against the mode it booted in, so it has to be on the
    // wire rather than implied by the fields present.
    const v = projectView(shared, DEFAULT_VIEW_SETTINGS, 'sos-equirect')
    expect(v.mode).toBe('sos-equirect')
    const projected = projectState({ view: shared }, DEFAULT_VIEW_SETTINGS, 'sos-equirect')
    expect(projected.view!.mode).toBe('sos-equirect')
  })

  it('derives the default camera to a centred, uniform unwrap', () => {
    // The behavioural continuity the split has to preserve. Before it,
    // `initialState` stored `CENTRED_CAMERA` literally; now it stores
    // `zoom: 0` and the identity falls out of the derivation
    // (`1 − 1/(0 + 1)` is exactly 0). If that ever stops holding, a
    // freshly-booted output opens on a warped sphere with no dataset
    // loaded and nothing on screen to explain it.
    const v = projectView(initialState().view, DEFAULT_VIEW_SETTINGS, 'sos-equirect')
    expect(v.params.cameraOffset).toEqual(CENTRED_CAMERA)
  })

  it('keeps the derived camera inside the sphere however far the operator zooms', () => {
    // `MAX_CAMERA_OFFSET` is why the ray-march needs no miss branch, and
    // the shared view now holds an *unclamped* operator zoom — so the
    // clamp has to survive the extra hop. A camera at or past the
    // surface smears one texel across most of the sphere.
    const far = { dayNight: true, camera: { lat: 35, lon: -120, zoom: 1e6 } }
    const o = projectView(far, DEFAULT_VIEW_SETTINGS, 'sos-equirect').params.cameraOffset
    expect(Math.hypot(o.x, o.y, o.z)).toBeLessThanOrEqual(MAX_CAMERA_OFFSET)
  })

  it('throws loudly rather than silently mis-projecting an unknown mode', () => {
    // Unreachable through the type system, and through persistence too
    // — `outputPersistence` fail-closes on a mode it does not know. This
    // covers the remaining way in: a cast, or a future arm added to
    // `OutputMode` whose `projectView` case was forgotten and forced
    // past the compiler. Returning an unprojected view there would put
    // one geometry's settings on another's renderer, which is the exact
    // failure the union exists to prevent — so it must not be quiet.
    expect(() =>
      projectView(shared, DEFAULT_VIEW_SETTINGS, 'flat-perspective' as 'sos-equirect'),
    ).toThrow(/no view projection for mode/)
  })
})

describe('the rotation offset (rung 14)', () => {
  const shared = (): SharedView => ({
    dayNight: true,
    camera: { lat: 0, lon: 0, zoom: 0 },
  })

  it('converts the operator degrees to shader radians, once', () => {
    // The single conversion. Degrees are what the operator types and
    // what gets persisted; radians are what the shader takes. A second
    // conversion inside the output would be free to disagree with this
    // one, and the symptom is a sphere turned by the wrong amount.
    const view = projectView(
      shared(),
      { ...DEFAULT_VIEW_SETTINGS, rotationOffsetDeg: 180 },
      'sos-equirect',
    )
    expect(view.params.rotationOffsetRad).toBeCloseTo(Math.PI, 12)
  })

  it('is per-output, so one sphere can be aligned without turning another', () => {
    // Two spheres in two rooms are mounted differently. This is the
    // reason the offset rides `params` rather than the shared view.
    const a = projectView(shared(), { ...DEFAULT_VIEW_SETTINGS, rotationOffsetDeg: 90 }, 'sos-equirect')
    const b = projectView(shared(), { ...DEFAULT_VIEW_SETTINGS, rotationOffsetDeg: 0 }, 'sos-equirect')
    expect(a.params.rotationOffsetRad).toBeCloseTo(Math.PI / 2, 12)
    expect(b.params.rotationOffsetRad).toBe(0)
  })

  it('falls back to no rotation rather than sending NaN to the shader', () => {
    // A NaN longitude makes every ray miss, which is a black sphere in
    // front of an audience. Same guard `operatorCameraFrom` applies to
    // a camera MapLibre reported as NaN.
    const view = projectView(
      shared(),
      { ...DEFAULT_VIEW_SETTINGS, rotationOffsetDeg: Number.NaN },
      'sos-equirect',
    )
    expect(view.params.rotationOffsetRad).toBe(0)
  })

  it('defaults to none, so an uncalibrated install is unchanged', () => {
    expect(DEFAULT_VIEW_SETTINGS.rotationOffsetDeg).toBe(0)
    expect(projectView(shared(), DEFAULT_VIEW_SETTINGS, 'sos-equirect').params.rotationOffsetRad).toBe(0)
  })
})
