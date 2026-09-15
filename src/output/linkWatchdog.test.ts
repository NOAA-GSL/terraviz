// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the link watchdog.
 *
 * Every case here is about elapsed time, which is exactly why the
 * machine is pure — driving these through a real clock would mean a
 * sixty-second test that fails on a loaded runner.
 */

import { describe, it, expect } from 'vitest'

import { IPC_ORPHAN_MS, IPC_STALE_MS } from '../services/multiOutput/protocol'
import { LINK_PING_INTERVAL_MS, createLinkWatchdog } from './linkWatchdog'

describe('createLinkWatchdog', () => {
  it('starts live', () => {
    expect(createLinkWatchdog(0).check(0).health).toBe('live')
  })

  it('stays live while the heartbeat keeps arriving', () => {
    const dog = createLinkWatchdog(0)
    // The manager broadcasts at least once a second, so a live link
    // never gets anywhere near the threshold.
    for (let t = 1000; t <= IPC_ORPHAN_MS * 2; t += 1000) {
      dog.sawMessage(t)
      expect(dog.check(t).health).toBe('live')
    }
  })

  it('goes stale on silence even though nothing ever arrived', () => {
    // The clock starts at connect, not at the first message. An output
    // that never hears anything at all is the most important case to
    // detect — it is what a manager that never opened the link looks
    // like — and a watchdog armed by the first arrival would sit
    // `live` forever in exactly that case.
    const dog = createLinkWatchdog(0)

    expect(dog.check(IPC_STALE_MS - 1).health).toBe('live')
    expect(dog.check(IPC_STALE_MS).health).toBe('stale')
  })

  it('measures both thresholds from the last message, not from each other', () => {
    // Orphan is 60 s of quiet, not 60 s after going stale. Stacking
    // them would put the orphan at 65 s for no reason anyone could
    // read off the constants.
    const dog = createLinkWatchdog(0)
    dog.sawMessage(10_000)

    expect(dog.check(10_000 + IPC_ORPHAN_MS - 1).health).toBe('stale')
    expect(dog.check(10_000 + IPC_ORPHAN_MS).health).toBe('orphaned')
  })

  it('reports how long it has been quiet', () => {
    const dog = createLinkWatchdog(0)
    dog.sawMessage(4_000)

    expect(dog.check(9_500).silentMs).toBe(5_500)
  })

  it('never reports negative silence if the clock steps back', () => {
    const dog = createLinkWatchdog(0)
    dog.sawMessage(5_000)

    expect(dog.check(4_000).silentMs).toBe(0)
  })
})

describe('pinging', () => {
  it('does not ping while live — there is nothing to ask', () => {
    const dog = createLinkWatchdog(0)

    expect(dog.check(IPC_STALE_MS - 1).shouldPing).toBe(false)
  })

  it('pings as soon as it goes stale', () => {
    const dog = createLinkWatchdog(0)

    expect(dog.check(IPC_STALE_MS).shouldPing).toBe(true)
  })

  it('rations pings to the interval however often it is asked', () => {
    // `check` rides the render loop, which runs far faster than the
    // ping cadence. The rationing belongs here rather than at the call
    // site, or every caller has to remember it.
    const dog = createLinkWatchdog(0)
    dog.check(IPC_STALE_MS)

    let pings = 0
    for (let t = IPC_STALE_MS; t < IPC_STALE_MS + LINK_PING_INTERVAL_MS; t += 16) {
      if (dog.check(t).shouldPing) pings++
    }

    expect(pings).toBe(0)
    expect(dog.check(IPC_STALE_MS + LINK_PING_INTERVAL_MS).shouldPing).toBe(true)
  })

  it('stops pinging once orphaned — nobody is listening', () => {
    const dog = createLinkWatchdog(0)

    const orphaned = dog.check(IPC_ORPHAN_MS)

    expect(orphaned.health).toBe('orphaned')
    expect(orphaned.shouldPing).toBe(false)
    expect(dog.check(IPC_ORPHAN_MS * 10).shouldPing).toBe(false)
  })
})

describe('recovery', () => {
  it('comes back live from stale', () => {
    const dog = createLinkWatchdog(0)
    expect(dog.check(IPC_STALE_MS).health).toBe('stale')

    dog.sawMessage(IPC_STALE_MS + 1)

    expect(dog.check(IPC_STALE_MS + 1).health).toBe('live')
  })

  it('comes back live from orphaned, because orphaned is not terminal', () => {
    // The plan's recovery path is the manager's boot scan finding
    // existing `output-*` windows after a control-window relaunch and
    // sending a fresh snapshot. An output that had latched itself off
    // would stay showing an hour-old frame with the manager alive and
    // broadcasting at it.
    const dog = createLinkWatchdog(0)
    expect(dog.check(IPC_ORPHAN_MS * 60).health).toBe('orphaned')

    dog.sawMessage(IPC_ORPHAN_MS * 60)

    expect(dog.check(IPC_ORPHAN_MS * 60).health).toBe('live')
  })

  it('pings promptly when it goes quiet again rather than waiting out the old interval', () => {
    const dog = createLinkWatchdog(0)
    dog.check(IPC_STALE_MS) // pinged
    dog.sawMessage(IPC_STALE_MS + 1)

    expect(dog.check(IPC_STALE_MS + 1 + IPC_STALE_MS).shouldPing).toBe(true)
  })
})
