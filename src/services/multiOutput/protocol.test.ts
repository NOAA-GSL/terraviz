// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the control ↔ output IPC contract.
 *
 * A types-only module has little to execute, so these cover the two
 * things that are not types: the window-label grammar, which the Tauri
 * capability glob depends on, and the timing constants, whose ordering
 * is the whole point of keeping them in one place.
 */

import { describe, it, expect } from 'vitest'
import {
  OUTPUT_LABEL_PREFIX,
  outputLabel,
  outputLabelIndex,
  isOutputLabel,
  isFullState,
  STATE_TICK_MS,
  IPC_STALE_MS,
  IPC_ORPHAN_MS,
  type MirroredEquirectParams,
  type OutputGlobeState,
  type OutputStateMessage,
} from './protocol'
import { IDENTITY_PARAMS, type EquirectParams } from '../../output/equirectRtt'

describe('window labels', () => {
  it('mints 1-based labels matching the capability glob', () => {
    expect(outputLabel(1)).toBe('output-1')
    expect(outputLabel(4)).toBe('output-4')
  })

  it('round-trips every minted label through the recogniser', () => {
    for (let i = 1; i <= 16; i++) {
      expect(isOutputLabel(outputLabel(i))).toBe(true)
    }
  })

  it('reads an index back out of a minted label', () => {
    for (let i = 1; i <= 16; i++) {
      expect(outputLabelIndex(outputLabel(i))).toBe(i)
    }
  })

  it('refuses to read an index out of a label it would never mint', () => {
    // Inventing one would feed the counter that decides whether a fresh
    // Add collides with a restored window already on screen.
    for (const label of ['output-01', 'output-1x', 'output-', 'output-0', 'main']) {
      expect(outputLabelIndex(label)).toBeNull()
    }
  })

  it('does not claim the control window', () => {
    // The manager's boot scan walks every window and must not mistake
    // the window it is running in for an orphaned output.
    expect(isOutputLabel('main')).toBe(false)
  })

  it('rejects the bare prefix', () => {
    // 'output-' matches the capability glob but names no output. Left
    // unguarded it would look like a real window to the boot scan.
    expect(isOutputLabel(OUTPUT_LABEL_PREFIX)).toBe(false)
  })

  it('does not match a label that merely contains the prefix', () => {
    expect(isOutputLabel('spike-output-1')).toBe(false)
    expect(isOutputLabel('outputs')).toBe(false)
  })
})

describe('isFullState', () => {
  const state: OutputGlobeState = {
    dataset: null,
    primary: null,
    playback: null,
    display: null,
    layers: [],
    simulationDate: null,
    view: {
      mode: 'sos-equirect',
      dayNight: true,
      params: { cameraOffset: { x: 0, y: 0, z: 0 }, split: false, rotationOffsetRad: 0 },
    },
  }

  it('narrows a snapshot to the complete state', () => {
    const msg: OutputStateMessage = { seq: 1, full: true, state }
    expect(isFullState(msg)).toBe(true)
    if (isFullState(msg)) {
      // The narrowing is the point: `.layers` is only reachable without
      // a null check once the guard has run.
      expect(msg.state.layers).toEqual([])
    }
  })

  it('leaves a diff un-narrowed', () => {
    const msg: OutputStateMessage = {
      seq: 2,
      full: false,
      state: { simulationDate: '2026-09-03T00:00:00.000Z' },
    }
    expect(isFullState(msg)).toBe(false)
  })
})

describe('agreed timings', () => {
  it('orders tick < stale < orphan', () => {
    // The ordering is the contract. A stale threshold at or below the
    // send cadence would badge every healthy output; an orphan
    // threshold below stale would skip the stale state entirely.
    expect(STATE_TICK_MS).toBeLessThan(IPC_STALE_MS)
    expect(IPC_STALE_MS).toBeLessThan(IPC_ORPHAN_MS)
  })

  it('leaves room for a missed tick before declaring staleness', () => {
    // The plan tolerates 2 s of normal jitter against a 1 s cadence, so
    // the stale threshold must clear several ticks — otherwise one
    // dropped message reads as a degraded link.
    expect(IPC_STALE_MS).toBeGreaterThanOrEqual(STATE_TICK_MS * 3)
  })
})

describe('the equirect view is the shader’s own parameter object', () => {
  /**
   * Assignable **both ways**, which is the whole property.
   *
   * One direction alone is satisfied by a subset: if the wire type
   * lost `split`, `MirroredEquirectParams` would still be assignable to
   * nothing useful, but `EquirectParams` would remain assignable to a
   * widened wire type and a one-way check would stay green. Two
   * declarations mean neither side can quietly gain or drop a field.
   *
   * `protocol.ts` cannot import `equirectRtt` to state this itself —
   * the contract must not depend on one of its consumers, and
   * `equirectRtt` lives in the output bundle, which the control bundle
   * does not load. A test imports both freely, so this is where the
   * promise is kept.
   */
  type _WireIsParams = MirroredEquirectParams extends EquirectParams ? true : never
  type _ParamsIsWire = EquirectParams extends MirroredEquirectParams ? true : never
  const _bothWays: [_WireIsParams, _ParamsIsWire] = [true, true]

  it('accepts the shader’s identity params as a wire value', () => {
    // The types above prove the shapes match; this proves a real value
    // crosses, so the pairing cannot be satisfied by two types that
    // agree only because both are structurally empty.
    const view: MirroredEquirectParams = IDENTITY_PARAMS
    expect(view.split).toBe(false)
    expect(view.cameraOffset).toEqual({ x: 0, y: 0, z: 0 })
    expect(_bothWays).toEqual([true, true])
  })
})
