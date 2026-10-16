// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The page-wide signal that this node has turned Orbit off since the
 * page booted (`features.orbit`, Node profile → Features).
 *
 * Boot decides once whether to offer Orbit, from the node profile. A
 * page that outlives that decision — a kiosk tab left running for
 * days, the usual way a Science On a Sphere installation runs — learns
 * of a later "off" three ways: the periodic re-read
 * (`nodeFeatures.watchForOrbitWithdrawal`), the chat endpoint refusing
 * a turn, or a voice endpoint refusing audio. Each is detected in a
 * service that must not import the UI, so they report here and
 * `chatUI` listens. The alternative each would otherwise fall into is
 * the wrong one: the docent treats a refused turn as a failed LLM and
 * answers from its keyword engine, and the voice engines treat a
 * refusal as one bad request and keep listening — exactly the
 * keyword-only docent and live microphone the toggle exists to remove.
 *
 * One-way for the life of the page: an operator who turns Orbit back
 * on reaches visitors on their next load, which is when a chat that
 * was never initialised can be. Imports nothing, so the LLM client and
 * the voice engines can depend on it without pulling in anything else.
 */

/** Which path noticed. Diagnostic only — every source is acted on alike. */
export type OrbitWithdrawalSource = 'recheck' | 'chat' | 'voice'

type Listener = (source: OrbitWithdrawalSource) => void

const listeners = new Set<Listener>()
let withdrawn = false

/**
 * Whether a response is an Orbit endpoint saying the node turned Orbit
 * off: the gate's exact envelope (`functions/api/_lib/orbit-gate.ts`),
 * not any 403. Orbit's chat can be pointed at another provider, and a
 * refusal from Ollama or a hosted API must not hide Orbit.
 */
export function isOrbitRefusal(status: number, body: unknown): boolean {
  if (status !== 403 || !body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return b.error === 'feature_disabled' && b.feature === 'orbit'
}

/** Report that the node has turned Orbit off. Idempotent. */
export function withdrawOrbit(source: OrbitWithdrawalSource): void {
  if (withdrawn) return
  withdrawn = true
  for (const listener of [...listeners]) {
    // One broken listener must not stop the rest from tearing down.
    try {
      listener(source)
    } catch {
      // Nothing useful to do with it here.
    }
  }
}

/** Whether Orbit has been withdrawn on this page. */
export function isOrbitWithdrawn(): boolean {
  return withdrawn
}

/** Be told when Orbit is withdrawn. No replay: check
 *  {@link isOrbitWithdrawn} first. Returns the unsubscribe. */
export function onOrbitWithdrawn(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests only — module state outlives a test case. */
export function resetOrbitAvailabilityForTests(): void {
  withdrawn = false
  listeners.clear()
}
