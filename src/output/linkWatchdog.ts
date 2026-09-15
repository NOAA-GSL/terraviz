// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Has the control window gone quiet, and what should the output do
 * about it (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery",
 * case 3)?
 *
 * The manager broadcasts at least once a second — `STATE_TICK_MS`, the
 * heartbeat that sends a full snapshot even when nothing changed — so
 * silence is measurable and means something. After `IPC_STALE_MS` the
 * link is **stale**: the output keeps rendering its last known state,
 * because a frozen frame of the right dataset is worth more to an
 * audience than a black sphere, and starts pinging so a manager that
 * is merely busy can notice and resync. After `IPC_ORPHAN_MS` it is
 * **orphaned** and stops pinging — nobody is listening, and a window
 * that pings forever is a window burning IPC on a dead channel for the
 * rest of an installation's uptime.
 *
 * Pure, and separate from `outputLink` for the reason `playbackSettle`
 * is separate from the transport: the decisions have wrong answers,
 * none of them needs a timer, a DOM or an IPC channel to reach, and
 * every one of them is about *elapsed time* — which is exactly the
 * thing that is miserable to test through a real clock.
 *
 * ## Three rules that are easy to get backwards
 *
 * **The clock starts at connect, not at the first message.** An output
 * that never hears anything at all is the most important case to
 * detect — it is what a manager that never called `start()`, or a
 * capability that forbids the channel, actually looks like — and a
 * watchdog armed by the first arrival would sit `live` forever in
 * exactly that case, which is the one where the sphere is showing an
 * idle Earth and nobody knows why.
 *
 * **Orphaned is not terminal.** The plan's recovery path is the
 * manager's boot scan finding existing `output-*` windows after a
 * control-window relaunch and sending a fresh snapshot; the output
 * "exits stale state on receipt and resumes normal rendering". So any
 * message at any time returns the link to `live`, and a window that
 * has been orphaned for an hour comes straight back.
 *
 * **Silence is measured from the last message, for both thresholds.**
 * Orphan is 60 s of quiet, not 60 s after going stale — the plan's two
 * numbers are both distances from the last contact, and stacking them
 * would push the orphan out to 65 s for no reason anyone could read
 * off the constants.
 */

import {
  IPC_ORPHAN_MS,
  IPC_STALE_MS,
  LINK_PING_INTERVAL_MS,
} from '../services/multiOutput/protocol'

/** What the output believes about its link to the control window. */
export type LinkHealth =
  /** Heard from within `IPC_STALE_MS`. Normal operation. */
  | 'live'
  /** Quiet past `IPC_STALE_MS`. Still rendering the last state, and
   *  pinging in case anyone is there. */
  | 'stale'
  /** Quiet past `IPC_ORPHAN_MS`. Still rendering; no longer pinging. */
  | 'orphaned'


/** Re-exported from the contract, where it moved once the manager
 *  turned out to need it too — see its docstring there. */
export { LINK_PING_INTERVAL_MS }

export interface LinkCheck {
  /** What the output should believe right now. */
  health: LinkHealth
  /** Whether a `output_health_check` is due this instant. True only
   *  while `stale` — never `live` (nothing to ask) and never
   *  `orphaned` (nobody to ask). */
  shouldPing: boolean
  /** Milliseconds since the last message, or since connect if there
   *  has never been one. What the ping and the debug HUD report. */
  silentMs: number
}

export interface LinkWatchdog {
  /** Record contact. Any message on any channel counts — arrival is
   *  the signal, not whether the contents changed anything. */
  sawMessage(nowMs: number): void
  /** Evaluate, and say whether to ping. Call it as often as you like;
   *  the ping cadence is enforced here rather than by the caller. */
  check(nowMs: number): LinkCheck
}

/**
 * @param startedAtMs when the link was established — the clock's zero.
 */
export function createLinkWatchdog(startedAtMs: number): LinkWatchdog {
  let lastMessageAtMs = startedAtMs
  let lastPingAtMs = Number.NEGATIVE_INFINITY

  return {
    sawMessage(nowMs) {
      lastMessageAtMs = nowMs
      // Reset so a link that goes quiet again pings promptly rather
      // than waiting out whatever remained of the previous interval.
      lastPingAtMs = Number.NEGATIVE_INFINITY
    },

    check(nowMs) {
      const silentMs = Math.max(0, nowMs - lastMessageAtMs)
      const health: LinkHealth =
        silentMs >= IPC_ORPHAN_MS ? 'orphaned' : silentMs >= IPC_STALE_MS ? 'stale' : 'live'

      if (health !== 'stale') return { health, shouldPing: false, silentMs }

      const due = nowMs - lastPingAtMs >= LINK_PING_INTERVAL_MS
      if (due) lastPingAtMs = nowMs
      return { health, shouldPing: due, silentMs }
    },
  }
}
