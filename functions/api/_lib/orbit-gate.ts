// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The per-node `orbit` feature gate for the edge endpoints only Orbit
 * calls — `/api/chat/completions`, `/api/models` and `/api/voice/*`
 * (`src/types/node-features.ts`).
 *
 * The public SPA hides Orbit when the node turns it off, so in normal
 * use none of these is reached. This is the backstop that makes "off"
 * true rather than cosmetic: a hand-written request, a stale tab that
 * booted before the toggle, or an old cached bundle cannot keep
 * spending the node's Workers AI quota. Same reasoning as the
 * publisher middleware's prefix table, which these routes sit outside.
 *
 * One helper rather than five inline checks so the routes cannot drift
 * on the envelope or on fail-open.
 *
 * **Memoised per isolate, with a last-known-good answer.** A talking
 * hands-free session sends one TTS request per sentence, and reading
 * the feature map on each would put a KV read on every one of them —
 * on a free-plan node, against the same daily quota the catalog cache
 * spends. So an answer is reused for {@link ORBIT_GATE_MEMO_MS}, which
 * costs no freshness worth having: the KV entry behind it is already up
 * to 5 minutes old. A failed read is memoised too, or every request
 * during an outage would retry storage.
 *
 * Reads that start together are not merged, so a window can cost more
 * than one read when requests arrive while a slow one is in flight.
 * Sharing the pending read would fix that and is deliberately not done:
 * it is storage I/O started by one request, and Workers bind I/O to the
 * request that started it, so the others would await a promise that can
 * be left unsettled if that request ends first — a hung response rather
 * than a spare KV read.
 *
 * The same memo narrows fail-open. `readEffectiveFeatures` answers
 * all-enabled on a storage error, and here that default is used only by
 * an isolate that has never read the map; one that has keeps its last
 * real answer, so a D1 blip on a node that turned Orbit off does not
 * turn it back on. A cold isolate during an outage still fails open —
 * the toggles' accepted risk (`docs/FEATURE_TOGGLES_PLAN.md`), and the
 * reason a KV blip cannot take Orbit down on a node that never turned
 * it off — and, being memoised, stays open for up to one window after
 * storage recovers.
 *
 * The voice and chat routes check the origin first, so a cross-origin
 * request is refused without consulting the gate. `/api/models` has
 * never checked an origin, and cannot usefully start (a same-origin GET
 * carries no `Origin` header, and a foreign one can be left off), so
 * the memo is what bounds what anonymous calls to it cost: a storage
 * read per isolate per minute. CORS preflights are not gated — they do
 * no inference and must not need storage to answer. A voice WebSocket
 * already open when Orbit is turned off is checked only at upgrade; the
 * SPA closes it when it withdraws Orbit, which it does on its next
 * re-read or refusal.
 */

import { readEffectiveFeatures } from '../v1/_lib/node-settings-store'

/** How long one isolate reuses an answer — one read from storage,
 *  or the fallback a failed read left. */
export const ORBIT_GATE_MEMO_MS = 60_000

/** The catalog bindings the gate reads. Pages bindings are
 *  project-wide, so these are present on every function. */
export interface OrbitGateEnv {
  CATALOG_DB?: D1Database
  CATALOG_KV?: KVNamespace
}

/** This isolate's current answer, and when it last asked storage. */
let lastRead: { enabled: boolean; atMs: number } | null = null

/** True unless the node operator turned Orbit off. Never throws. */
export async function isOrbitEnabled(env: OrbitGateEnv, nowMs: number = Date.now()): Promise<boolean> {
  if (lastRead && nowMs - lastRead.atMs < ORBIT_GATE_MEMO_MS) return lastRead.enabled
  const read = await readEffectiveFeatures(env)
  // Storage failed: the last real answer if this isolate has one, else
  // on. Memoised like a real read, or every request during an outage
  // would retry storage — the per-request cost the memo exists to stop.
  // The one assumed answer this can memoise is a cold isolate's `true`,
  // which lasts until the first read that succeeds after its window.
  const enabled = read.authoritative ? read.features.orbit : (lastRead?.enabled ?? true)
  lastRead = { enabled, atMs: nowMs }
  return enabled
}

/** Forget the memo — tests only; module state outlives a test case. */
export function resetOrbitGateForTests(): void {
  lastRead = null
}

/**
 * The 403 an Orbit endpoint answers while the feature is off. The
 * publisher middleware's `{ error, feature, message }` envelope, plus
 * `code` because the voice clients read their reason from `code`
 * (`_voice-lib.voiceError`'s shape). `no-store` so nothing caches the
 * refusal past a re-enable.
 */
export function orbitDisabledResponse(cors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: 'feature_disabled',
      code: 'feature_disabled',
      feature: 'orbit',
      message: 'The orbit feature is disabled on this node.',
    }),
    {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    },
  )
}
