// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the departure classification and the crash-storm guard.
 *
 * Both are small enough to look obviously right and both have a wrong
 * answer that is invisible in production, which is the combination
 * worth pinning: a misclassified crash is a silent one, and a guard
 * that never trips leaves an operator re-adding an output onto a
 * monitor that keeps killing it.
 */

import { describe, it, expect } from 'vitest'

import {
  CRASH_STORM_LIMIT,
  CRASH_STORM_WINDOW_MS,
  STALE_REPORT_TTL_MS,
  classifyDeparture,
  createCrashStormGuard,
  outputHealthState,
} from './outputHealth'
import { LINK_PING_INTERVAL_MS } from './protocol'

describe('outputHealthState', () => {
  it('is starting until the output announces itself', () => {
    expect(
      outputHealthState({ ready: false, lastHealthCheckAtMs: null, gpuLost: false }, 0),
    ).toBe('starting')
  })

  it('is live once announced with no complaint', () => {
    expect(outputHealthState({ ready: true, lastHealthCheckAtMs: null, gpuLost: false }, 0)).toBe('live')
  })

  it('is stale while a complaint is current', () => {
    expect(
      outputHealthState({ ready: true, lastHealthCheckAtMs: 1_000, gpuLost: false }, 1_000),
    ).toBe('stale')
    expect(
      outputHealthState(
        { ready: true, lastHealthCheckAtMs: 1_000, gpuLost: false },
        1_000 + STALE_REPORT_TTL_MS - 1,
      ),
    ).toBe('stale')
  })

  it('goes back to live once the complaints stop', () => {
    // An output stops complaining by going quiet — nothing arrives to
    // say the link recovered, so the badge has to age out on its own.
    expect(
      outputHealthState(
        { ready: true, lastHealthCheckAtMs: 1_000, gpuLost: false },
        1_000 + STALE_REPORT_TTL_MS,
      ),
    ).toBe('live')
  })

  it('rides out a single dropped ping without flickering', () => {
    // A stale output pings every `LINK_PING_INTERVAL_MS`. If the window
    // were one interval the badge would blink whenever a ping was late,
    // which answers the opposite question to the one an operator is
    // asking when they open this panel.
    expect(STALE_REPORT_TTL_MS).toBeGreaterThan(LINK_PING_INTERVAL_MS * 2)
    expect(
      outputHealthState(
        { ready: true, lastHealthCheckAtMs: 0, gpuLost: false },
        LINK_PING_INTERVAL_MS * 2,
      ),
    ).toBe('stale')
  })

  it('reports a lost GPU context over everything else', () => {
    // The other two are inferences the manager draws from silence; this
    // is the output stating outright that it is showing nothing. It is
    // also the only failure a *healthy* link can carry, so without the
    // precedence an output can read `live` by every other measure with
    // a black sphere in front of an audience.
    expect(
      outputHealthState({ ready: true, lastHealthCheckAtMs: null, gpuLost: true }, 0),
    ).toBe('gpu-lost')
    // Over `stale`…
    expect(
      outputHealthState({ ready: true, lastHealthCheckAtMs: 0, gpuLost: true }, 0),
    ).toBe('gpu-lost')
    // …and over `starting`, because a window that reported this has
    // plainly spoken, whatever else it has not said yet.
    expect(
      outputHealthState({ ready: false, lastHealthCheckAtMs: null, gpuLost: true }, 0),
    ).toBe('gpu-lost')
  })

  it('never ages the GPU latch out the way a stale link ages out', () => {
    // A stale link expires because the output stops complaining by
    // going quiet. A lost context is announced once and then nothing
    // further is said, so a TTL here would call a black projector
    // healthy a few seconds later.
    expect(
      outputHealthState(
        { ready: true, lastHealthCheckAtMs: 0, gpuLost: true },
        STALE_REPORT_TTL_MS * 1000,
      ),
    ).toBe('gpu-lost')
  })

  it('reports starting rather than stale for a window still booting', () => {
    // An output that never announced has nothing to be stale *from*,
    // and a degraded-link badge would send an operator looking at the
    // wrong thing.
    expect(
      outputHealthState({ ready: false, lastHealthCheckAtMs: 0, gpuLost: false }, 0),
    ).toBe('starting')
  })
})

describe('classifyDeparture', () => {
  it('calls a silent destroy a crash', () => {
    // The only evidence a crash leaves is the absence of everything
    // else: a killed process cannot report its own death.
    expect(classifyDeparture({ managerInitiated: false, sawClosing: false })).toBe('crashed')
  })

  it('calls a warned destroy an operator close', () => {
    // Alt+F4, a window manager's close button, or an operator reaching
    // an output they took out of fullscreen with F11.
    expect(classifyDeparture({ managerInitiated: false, sawClosing: true })).toBe('closed')
  })

  it('calls a close the manager asked for a removal', () => {
    expect(classifyDeparture({ managerInitiated: true, sawClosing: false })).toBe('removed')
  })

  it('prefers the manager’s own intent when both signals are set', () => {
    // The ordering that matters. Remove in the panel makes the manager
    // call `close()`, which fires the output's close-requested handler,
    // which emits `output_closing` — so both are true for one
    // departure, and reporting it as a hand-close would be wrong in the
    // one case the panel already knows the answer to.
    expect(classifyDeparture({ managerInitiated: true, sawClosing: true })).toBe('removed')
  })
})

describe('createCrashStormGuard', () => {
  /** A guard on a clock the test drives. */
  function guardAt() {
    let clock = 0
    const guard = createCrashStormGuard({ nowMs: () => clock })
    return { guard, advance: (ms: number) => (clock += ms) }
  }

  const MONITOR = 'HDMI-1@0,0'

  it('does not block before the limit', () => {
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT - 1; i++) guard.record(MONITOR)

    expect(guard.isBlocked(MONITOR)).toBe(false)
  })

  it('blocks once the limit is reached inside the window', () => {
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)

    expect(guard.isBlocked(MONITOR)).toBe(true)
    expect(guard.blocked()).toEqual([MONITOR])
  })

  it('does not block crashes spread wider than the window', () => {
    // Three crashes across an afternoon are three incidents, not a
    // storm, and refusing the monitor for them would take a working
    // display away from an operator.
    const { guard, advance } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) {
      guard.record(MONITOR)
      advance(CRASH_STORM_WINDOW_MS + 1)
    }

    expect(guard.isBlocked(MONITOR)).toBe(false)
  })

  it('never lifts a block it has tripped', () => {
    // The window detects the storm; it does not time the block out.
    // Nothing observed after the third crash suggests the hardware
    // improved, and an expiring block puts the operator back into the
    // re-add loop the guard exists to break.
    const { guard, advance } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)
    advance(CRASH_STORM_WINDOW_MS * 100)

    expect(guard.isBlocked(MONITOR)).toBe(true)
  })

  it('keeps monitors apart', () => {
    // One bad display must not cost the operator the others — the
    // reason this is keyed at all rather than counting globally.
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)

    expect(guard.isBlocked('DP-2@1920,0')).toBe(false)
  })

  it('starts clean, which is what makes relaunch the reset', () => {
    // A fresh guard is a fresh session. Nothing here is persisted, so
    // the block cannot outlive the reseated cable that fixed it.
    const { guard } = guardAt()
    for (let i = 0; i < CRASH_STORM_LIMIT; i++) guard.record(MONITOR)
    expect(guard.isBlocked(MONITOR)).toBe(true)

    const { guard: relaunched } = guardAt()
    expect(relaunched.isBlocked(MONITOR)).toBe(false)
    expect(relaunched.blocked()).toEqual([])
  })
})
