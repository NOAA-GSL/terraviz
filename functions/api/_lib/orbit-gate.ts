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
 * on the envelope or on fail-open. `getEffectiveFeatures` never throws
 * and answers all-enabled on any binding gap or storage error — a KV
 * blip must not take Orbit down on a node that never turned it off.
 *
 * Callers check the origin first, so a cross-origin request is refused
 * without costing a KV read, and leave CORS preflights ungated: a
 * preflight does no inference and must not need storage to answer.
 */

import { getEffectiveFeatures } from '../v1/_lib/node-settings-store'

/** The catalog bindings the gate reads. Pages bindings are
 *  project-wide, so these are present on every function. */
export interface OrbitGateEnv {
  CATALOG_DB?: D1Database
  CATALOG_KV?: KVNamespace
}

/** True unless the node operator turned Orbit off. Fail-open. */
export async function isOrbitEnabled(env: OrbitGateEnv): Promise<boolean> {
  return (await getEffectiveFeatures(env)).orbit
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
