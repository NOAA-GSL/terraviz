// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import { DEFAULT_DISPLAY, type ColorScaleDisplay } from '../colorScaleDisplay'
import type { Dataset } from '../../types'
import {
  displayForMirror,
  operatorCameraFrom,
  overlayForMirror,
  panelMirrorState,
  playbackFrom,
  primaryFrom,
  toMirroredDataset,
} from './mirrorState'

/** The common case: a global, prime-meridian, unflipped Earth picture —
 *  the one `overlayOptionsFromDataset` deliberately returns `undefined`
 *  for, to keep the renderer on its fast path. */
function plainDataset(over: Partial<Dataset> = {}): Dataset {
  return { id: 'INTERNAL_plain', title: 'A Plain Picture', ...over } as Dataset
}

describe('overlayForMirror', () => {
  it('falls back to an identity-only bundle for a default-geometry dataset', () => {
    const overlay = overlayForMirror(plainDataset())

    // The wire format has no fast path, and the reason it doesn't is
    // these two fields: a frame must be able to say what it is without
    // asking app state.
    expect(overlay.datasetId).toBe('INTERNAL_plain')
    expect(overlay.datasetTitle).toBe('A Plain Picture')
    // Every geometric field stays absent — that is what the renderer's
    // `undefined` meant, and inventing a default here would be claiming
    // the catalog said something it did not.
    expect(overlay.boundingBox).toBeUndefined()
    expect(overlay.lonOrigin).toBeUndefined()
    expect(overlay.isFlippedInY).toBeUndefined()
    expect(overlay.colorScale).toBeUndefined()
  })

  it('passes a real bundle through, identity included', () => {
    const overlay = overlayForMirror(
      plainDataset({ id: 'INTERNAL_regional', lonOrigin: 20, isFlippedInY: true }),
    )

    expect(overlay.lonOrigin).toBe(20)
    expect(overlay.isFlippedInY).toBe(true)
    expect(overlay.datasetId).toBe('INTERNAL_regional')
  })
})

describe('toMirroredDataset', () => {
  it('carries the control-resolved URL and kind', () => {
    const mirrored = toMirroredDataset(plainDataset(), 'video', 'https://cdn/x.m3u8')

    expect(mirrored).toEqual({
      id: 'INTERNAL_plain',
      url: 'https://cdn/x.m3u8',
      kind: 'video',
      overlay: { datasetId: 'INTERNAL_plain', datasetTitle: 'A Plain Picture' },
      startTime: null,
      endTime: null,
    })
  })

  it('carries the dataset’s own temporal range, which the output cannot derive', () => {
    // `computeSiblingSyncCorrection` places the primary's real-world
    // date on the output's timeline through `sibStart`/`sibEnd`. An
    // output has no catalog to look those up in, and `primary.rangeMs`
    // gives the span's length without saying where it starts — so
    // without these the output can hold a date it cannot act on.
    const dataset = plainDataset()
    dataset.startTime = '2026-03-01T00:00:00Z'
    dataset.endTime = '2026-03-08T00:00:00Z'

    const mirrored = toMirroredDataset(dataset, 'video', 'https://cdn/x.m3u8')

    expect(mirrored?.startTime).toBe('2026-03-01T00:00:00Z')
    expect(mirrored?.endTime).toBe('2026-03-08T00:00:00Z')
  })

  it('normalises an absent range to null rather than leaving it undefined', () => {
    // The aggregator diffs by deep structural equality, where an absent
    // key and a present-but-undefined one are different objects meaning
    // the same thing — which would forward a dataset diff that
    // changed nothing, and an output rebuilds its HLS instance on one.
    const mirrored = toMirroredDataset(plainDataset(), 'image', 'https://cdn/x.jpg')

    expect(mirrored).toHaveProperty('startTime', null)
    expect(mirrored).toHaveProperty('endTime', null)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('returns null when the URL is %s', (_label, url) => {
    // An output handed '' fetches its own document and tries to decode
    // the HTML as a texture — a failure that surfaces far from here.
    // `null` is already the schema's "nothing loaded".
    expect(toMirroredDataset(plainDataset(), 'image', url)).toBeNull()
  })
})

describe('panelMirrorState', () => {
  it('is empty only when the panel holds neither a row nor pixels', () => {
    expect(panelMirrorState(null, null)).toBe('empty')
    expect(panelMirrorState(undefined, null)).toBe('empty')
  })

  it('is ready when the row and the pixels are the same dataset', () => {
    expect(panelMirrorState('A', 'A')).toBe('ready')
  })

  it('is unsettled when a load failed or is still in flight', () => {
    // `dataset` is assigned before the load is attempted, so a failure
    // leaves row B paired with dataset A's pixels. Mirroring that would
    // draw A under B's geometry and call it B.
    expect(panelMirrorState('B', 'A')).toBe('unsettled')
    // Nothing has painted for this row yet.
    expect(panelMirrorState('B', null)).toBe('unsettled')
  })

  it('is unsettled for a tour row sitting over a previous dataset', () => {
    // A `tour/json` row sets `dataset` and paints nothing, so the panel
    // still shows the earlier dataset. Reporting `empty` here would
    // blank the sphere while the operator watches the tour run.
    expect(panelMirrorState('TOUR', 'PREVIOUS')).toBe('unsettled')
  })

  it('is unsettled mid-teardown, when pixels outlive the row', () => {
    expect(panelMirrorState(null, 'A')).toBe('unsettled')
  })
})

describe('operatorCameraFrom', () => {
  it('passes an ordinary camera through', () => {
    expect(operatorCameraFrom(45, -120, 3)).toEqual({ lat: 45, lon: -120, zoom: 3 })
  })

  it('wraps a longitude that has accumulated past a full turn', () => {
    // MapLibre does not wrap `getCenter().lng`. Drag east around the
    // globe three times and it reads 900-odd — and
    // `cameraOffsetForCamera` builds a *direction* from it, so the
    // output aims somewhere the operator is not, further wrong the
    // longer they pan.
    expect(operatorCameraFrom(0, 900, 1).lon).toBeCloseTo(180, 10)
    expect(operatorCameraFrom(0, -190, 1).lon).toBeCloseTo(170, 10)
    expect(operatorCameraFrom(0, 190, 1).lon).toBeCloseTo(-170, 10)
  })

  it('keeps the antimeridian on one side of itself', () => {
    // −180 and 180 are the same place. Letting it alternate would make
    // a parked camera re-broadcast every frame, since the aggregator
    // compares by value.
    expect(operatorCameraFrom(0, 180, 1).lon).toBe(180)
    expect(operatorCameraFrom(0, -180, 1).lon).toBe(180)
  })

  it('clamps latitude to the poles', () => {
    expect(operatorCameraFrom(120, 0, 1).lat).toBe(90)
    expect(operatorCameraFrom(-120, 0, 1).lat).toBe(-90)
  })

  it('floors zoom at the whole globe', () => {
    // `cameraOffsetForCamera` is `1 − 1/(z+1)`, which goes negative
    // below zero and inverts the warp — the output would magnify the
    // hemisphere the operator zoomed *away* from.
    expect(operatorCameraFrom(0, 0, -2).zoom).toBe(0)
  })

  it('falls back to the centred default rather than passing NaN through', () => {
    // A NaN reaches the shader as a NaN offset, every ray misses, and
    // the output goes black — the one failure the 1 Hz floor exists to
    // make visible.
    expect(operatorCameraFrom(Number.NaN, Number.NaN, Number.NaN)).toEqual({
      lat: 0,
      lon: 0,
      zoom: 0,
    })
    expect(operatorCameraFrom(0, Number.POSITIVE_INFINITY, 1).lon).toBe(0)
  })
})

describe('playbackFrom', () => {
  const base = {
    currentTime: 50,
    duration: 100,
    paused: false,
    playbackRate: 1,
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-11T00:00:00.000Z',
  }

  it('places the playhead on the dataset timeline', () => {
    // Halfway through a ten-day span.
    expect(playbackFrom(base)?.date).toBe('2026-01-06T00:00:00.000Z')
  })

  it('carries paused rather than treating it as an absence', () => {
    // A paused primary still has a position the output must match.
    // Returning null would leave the output wherever it happened to be.
    const paused = playbackFrom({ ...base, paused: true })
    expect(paused?.paused).toBe(true)
    expect(paused?.date).toBe('2026-01-06T00:00:00.000Z')
  })

  it('carries the element\'s real rate', () => {
    // A tour's `frameRate` task sets the primary's rate alone. An
    // output assuming 1 against 0.167x runs ~6x fast for the whole
    // tour — terraviz#229 in a second window.
    expect(playbackFrom({ ...base, playbackRate: 0.167 })?.playbackRate).toBeCloseTo(0.167, 5)
  })

  it.each([
    ['a zero rate', 0],
    ['a negative rate', -1],
    ['a NaN rate', Number.NaN],
  ])('substitutes 1 for %s', (_label, playbackRate) => {
    // A stopped clock wearing a rate. The output divides by it.
    expect(playbackFrom({ ...base, playbackRate })?.playbackRate).toBe(1)
  })

  it('reports the position in the clip alongside the instant', () => {
    expect(playbackFrom(base)?.positionRatio).toBeCloseTo(0.5, 6)
  })

  it.each([
    ['past the end on an ended element', { currentTime: 100.04 }, 1],
    ['a negative playhead', { currentTime: -0.001 }, 0],
  ])('clamps the ratio for %s', (_label, over, expected) => {
    // The output multiplies this by its own duration to get a seek
    // target, and `currentTime` can sit a hair past `duration`.
    expect(playbackFrom({ ...base, ...over })?.positionRatio).toBe(expected)
  })

  it.each([
    ['no time axis', { startTime: null, endTime: null }],
    ['only a start', { endTime: null }],
    ['an unparseable bound', { endTime: 'sometime' }],
    ['a zero-length span', { endTime: base.startTime }],
    ['a reversed span', { startTime: base.endTime, endTime: base.startTime }],
  ])('publishes a dateless record for %s', (_label, over) => {
    // The regression this replaced: these all returned null, so nothing
    // about the primary's transport reached the output — and
    // `syncVideoToState`'s only `play()` sits past the gate that
    // rejects a null playback. Every SOS looping animation held its
    // first decoded frame on every output for the life of the window.
    const out = playbackFrom({ ...base, ...over })

    expect(out).not.toBeNull()
    expect(out?.date).toBeNull()
    expect(out?.paused).toBe(false)
    expect(out?.positionRatio).toBeCloseTo(0.5, 6)
  })

  it.each([
    ['no duration yet', { duration: 0 }],
    ['a NaN duration', { duration: Number.NaN }],
    ['a NaN playhead', { currentTime: Number.NaN }],
  ])('returns null for %s', (_label, over) => {
    // These are the absences with genuinely nothing to describe: no
    // instant *and* no position in a clip. A missing time axis is not
    // one of them — see above.
    expect(playbackFrom({ ...base, ...over })).toBeNull()
  })
})

describe('primaryFrom', () => {
  it('reports the media length and the real-world span it covers', () => {
    expect(primaryFrom(100, '2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z')).toEqual({
      duration: 100,
      rangeMs: 10 * 24 * 60 * 60 * 1000,
    })
  })

  it('returns null for a dataset with no time axis', () => {
    expect(primaryFrom(100, null, null)).toBeNull()
  })

  it('returns null before the duration firms up', () => {
    // HLS reports 0 until enough segments have buffered. Publishing it
    // would make `outputSync` place every instant at the start.
    expect(primaryFrom(0, '2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z')).toBeNull()
  })
})

describe('displayForMirror', () => {
  const MAGMA: ColorScaleDisplay = {
    palette: 'magma',
    stretch: { lo: 0.1, hi: 0.9 },
    threshold: { min: null, max: null },
  }

  it('carries a real transform through', () => {
    expect(displayForMirror(MAGMA)).toEqual(MAGMA)
  })

  it('collapses the identity to null', () => {
    // `null` is what the aggregator holds before the operator touches
    // anything and what `paletteTexture` reads as "the dataset's own
    // ramp". Publishing DEFAULT_DISPLAY instead puts a second encoding
    // of the same fact on the wire, reaching the shader through
    // `buildDisplayLut` rather than `buildColorScaleLut` — two paths
    // that then have to agree byte for byte, and which the aggregator
    // cannot collapse because the values genuinely differ.
    expect(displayForMirror(DEFAULT_DISPLAY)).toBeNull()
  })

  it('returns an operator to the state a fresh output boots in', () => {
    // The visible half: try magma, reset to source, and every output
    // goes back to no transform rather than to a transform that happens
    // to be a no-op.
    expect(displayForMirror(MAGMA)).not.toBeNull()
    expect(displayForMirror({ ...MAGMA, palette: 'source', stretch: { lo: 0, hi: 1 } })).toBeNull()
  })
})
