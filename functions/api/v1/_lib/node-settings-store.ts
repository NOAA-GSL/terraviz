// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `node_settings` singleton row helpers
 * (`migrations/catalog/0037_node_settings.sql`) — the per-node
 * feature toggles, and since 0057 the embedding policy
 * (`src/types/node-embedding.ts`): which sites may frame the public
 * app.
 *
 * Mirrors `node-profile-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler (admin-only
 * writes via `isAdmin` — stricter than the profile's `isPrivileged`,
 * deliberately, so a service token cannot flip node-level features).
 * Absence of a row means "never configured" — every feature enabled.
 *
 * `getEffectiveFeatures` is the hot-path read consumed by the
 * `/publish` middleware gate and the gated public handlers. It is
 * KV-cached and **fail-open**: any D1/KV/parse error returns
 * all-enabled rather than throwing. A KV outage or a corrupt row
 * must never take down the publisher API or blank the public site;
 * the worst failure mode is a disabled feature briefly reappearing
 * (same semantics as the telemetry kill switch in
 * `functions/api/ingest.ts`).
 *
 * `readEffectiveEmbedPolicy` is the same shape for the embedding
 * policy, read by the root middleware on every HTML page. A storage
 * failure fails open to `any` — no framing header — for the same
 * reason, and the trade-off is sharper here, so it is stated: an
 * outage can briefly lift a node's restriction, so a site the node did
 * not list could frame it for that long. The alternative is worse. Failing
 * closed would send `frame-ancestors 'self'` on every page during an
 * outage, blanking every legitimate embed on every site at once, for
 * a node that may never have restricted anything. The middleware
 * narrows the window further by keeping its last real answer
 * (`functions/_middleware.ts`).
 */

import {
  FEATURE_KEYS,
  defaultFeatures,
  normalizeFeatures,
  type FeatureKey,
  type FeatureMap,
} from '../../../../src/types/node-features'
import {
  defaultEmbedPolicy,
  parseStoredEmbedPolicy,
  type EmbedPolicy,
  type StoredEmbedPolicy,
} from '../../../../src/types/node-embedding'
import type { CatalogEnv } from './env'
import type { FieldError } from './node-profile-store'
import type { PublisherRow } from './publisher-store'

/** KV key for the effective feature map. Bump on shape changes. */
export const NODE_FEATURES_CACHE_KEY = 'node-features:v1'

/** Cache TTL — toggles change rarely; a stale read self-heals. */
const CACHE_TTL_SECONDS = 300

/** Best-effort bust of the effective-features cache. */
export async function bustNodeFeaturesCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(NODE_FEATURES_CACHE_KEY)
  } catch {
    // Best-effort — a stale entry expires on its own TTL.
  }
}

/** KV key for the effective embedding policy. Bump on shape changes. */
export const NODE_EMBEDDING_CACHE_KEY = 'node-embedding:v1'

/**
 * An hour, not the features cache's five minutes. The middleware reads
 * this on every page an isolate serves after its 60 s memo lapses, so
 * the KV entry expires and is refilled far more often than the toggle
 * map's, and every refill is a KV write: the free plan allows 1,000 a
 * day for the whole account, and a five-minute TTL alone costs about
 * 288 of them. Freshness does not depend on the TTL, because every
 * save busts the entry. What a long TTL does stretch is the rare race
 * where a refill that read D1 just before a save lands just after it,
 * re-caching the previous policy until expiry; saving again clears it,
 * and the portal's readout shows when it has happened.
 */
const EMBEDDING_CACHE_TTL_SECONDS = 3600

/** Best-effort bust of the effective-embedding-policy cache. */
export async function bustNodeEmbeddingCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(NODE_EMBEDDING_CACHE_KEY)
  } catch {
    // Best-effort — a stale entry expires on its own TTL.
  }
}

/** The `node_settings` row as stored, less the embedding policy
 *  (see {@link getStoredEmbedPolicyJson} for why that is read apart). */
export interface NodeSettingsRow {
  features_json: string
  updated_by: string
  updated_at: string
}

/** Fetch the singleton settings row, or null when never configured. */
export async function getNodeSettings(db: D1Database): Promise<NodeSettingsRow | null> {
  const row = await db
    .prepare(
      `SELECT features_json, updated_by, updated_at
         FROM node_settings
        WHERE id = 1
        LIMIT 1`,
    )
    .first<NodeSettingsRow>()
  return row ?? null
}

/**
 * The stored embedding policy's JSON, or null when never set (0057's
 * NULL, or no row at all).
 *
 * Its own query, and the feature reads never name the column, because
 * a fork can deploy this code before it applies migration 0057: CI
 * applies migrations before deploying on `main`, but a fork has that
 * step off by default (`docs/SELF_HOSTING.md` §14.3). Selecting the
 * column alongside `features_json` would make the toggles' hot path
 * fail on such a node, and that path fails open, so every feature an
 * operator turned off, Orbit included, would quietly come back. Kept
 * apart, only the embedding read fails there, and it fails to `any`,
 * which is what that node sent before. Throws on a missing column;
 * callers decide what that means.
 */
export async function getStoredEmbedPolicyJson(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT embed_policy_json
         FROM node_settings
        WHERE id = 1
        LIMIT 1`,
    )
    .first<{ embed_policy_json: string | null }>()
  return row?.embed_policy_json ?? null
}

/** Parse a stored row's `features_json` into a complete map.
 *  Corrupt JSON degrades to all-enabled rather than failing the read. */
export function featuresFromRow(row: NodeSettingsRow | null): FeatureMap {
  if (!row) return defaultFeatures()
  try {
    return normalizeFeatures(JSON.parse(row.features_json))
  } catch {
    return defaultFeatures()
  }
}

/**
 * Read a stored policy. `null` means the value is not a policy at all
 * (corrupt JSON), which callers treat as a failed read; a policy that
 * was never written is `any`, authoritatively; one that no longer
 * validates comes back narrowed and flagged ({@link parseStoredEmbedPolicy}).
 */
function storedEmbedPolicy(json: string | null): StoredEmbedPolicy | null {
  if (json == null) return { policy: defaultEmbedPolicy() }
  try {
    return parseStoredEmbedPolicy(JSON.parse(json))
  } catch {
    return null
  }
}

/** Why the enforced policy differs from what was saved, for the
 *  portal: `unreadable` (corrupt, so `any` is enforced) or `refused`
 *  (it no longer validates, so a narrower policy is enforced). */
export type EmbedPolicyProblem = 'unreadable' | 'refused'

/** A stored policy for display: what the middleware enforces for it,
 *  and why that differs from what was saved, if it does. */
export function embedPolicyFromStored(json: string | null): {
  policy: EmbedPolicy
  problem?: EmbedPolicyProblem
} {
  return storedEmbedPolicy(json) ?? { policy: defaultEmbedPolicy(), problem: 'unreadable' }
}

/** The sections one write replaces. Each section given is replaced
 *  whole and a section left out is untouched, so the Features and
 *  Embedding cards save independently. */
export interface NodeSettingsUpdate {
  features?: FeatureMap
  embedding?: EmbedPolicy
}

/**
 * Upsert the singleton, replacing only the sections given. Features
 * are stored as the complete normalized map (only `false` values
 * matter, but storing every key keeps the row self-describing); the
 * policy as the validated `{mode, origins}`. Audit trail is written by
 * the route handler (`node_settings.update`), matching the
 * node-profile split of concerns.
 *
 * Only the columns of the sections given are named, in the INSERT as
 * well as the UPDATE, so a features-only write never touches the
 * 0057 column and keeps working on a node that has not applied it
 * ({@link getStoredEmbedPolicyJson}). The column names are fixed
 * strings chosen here, never input; every value is bound.
 */
export async function setNodeSettings(
  db: D1Database,
  publisher: PublisherRow,
  update: NodeSettingsUpdate,
  now: string = new Date().toISOString(),
): Promise<NodeSettingsRow> {
  // A first write that names one section leaves the other at its
  // never-configured value: every feature on (the column's '{}'
  // default), embedding NULL, which reads as `any`.
  const columns: string[] = []
  const values: string[] = []
  if (update.features) {
    columns.push('features_json')
    values.push(JSON.stringify(update.features))
  }
  if (update.embedding) {
    columns.push('embed_policy_json')
    values.push(JSON.stringify(update.embedding))
  }
  const sets = [...columns, 'updated_by', 'updated_at'].map(column => `${column} = excluded.${column}`)
  await db
    .prepare(
      `INSERT INTO node_settings (id, ${[...columns, 'updated_by', 'updated_at'].join(', ')})
       VALUES (1, ${[...columns, 'updated_by', 'updated_at'].map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${sets.join(', ')}`,
    )
    .bind(...values, publisher.id, now)
    .run()
  const row = await getNodeSettings(db)
  if (!row) throw new Error('node_settings upsert did not persist')
  return row
}

/** {@link setNodeSettings} for the feature map alone. */
export async function setNodeFeatures(
  db: D1Database,
  publisher: PublisherRow,
  features: FeatureMap,
  now: string = new Date().toISOString(),
): Promise<NodeSettingsRow> {
  return setNodeSettings(db, publisher, { features }, now)
}

/**
 * Validate a `PUT /api/v1/publish/node-settings` body. The body is
 * `{ features: { <key>: boolean, ... } }` — partial is fine (missing
 * keys stay enabled), unknown keys are a field error rather than a
 * silent drop so the operator sees what the form refused, and
 * non-boolean values are rejected.
 */
export function validateFeaturesInput(
  raw: unknown,
): { ok: true; value: FeatureMap } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const featuresRaw = body.features
  if (featuresRaw == null || typeof featuresRaw !== 'object' || Array.isArray(featuresRaw)) {
    errors.push({
      field: 'features',
      code: 'invalid',
      message: '`features` must be an object of {feature: boolean}.',
    })
    return { ok: false, errors }
  }

  const rec = featuresRaw as Record<string, unknown>
  const known = new Set<string>(FEATURE_KEYS)
  for (const [key, value] of Object.entries(rec)) {
    if (!known.has(key)) {
      errors.push({
        field: `features.${key}`,
        code: 'unknown',
        message: `\`${key}\` is not a known feature.`,
      })
      continue
    }
    if (typeof value !== 'boolean') {
      errors.push({
        field: `features.${key}`,
        code: 'invalid',
        message: `\`features.${key}\` must be a boolean.`,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const value = defaultFeatures()
  for (const key of FEATURE_KEYS) {
    if (rec[key] === false) value[key] = false
  }
  return { ok: true, value }
}

/** The keys currently disabled — audit metadata + log lines. */
export function disabledKeys(features: FeatureMap): FeatureKey[] {
  return FEATURE_KEYS.filter(key => !features[key])
}

/** {@link readEffectiveFeatures}' answer. `authoritative` is false
 *  only when a storage error forced the fail-open default: a node with
 *  no catalog binding or no settings row has genuinely enabled
 *  everything, and says so authoritatively. */
export interface EffectiveFeaturesRead {
  features: FeatureMap
  authoritative: boolean
}

/**
 * The hot-path read: the effective feature map for this node.
 * One KV hit when warm; on miss reads D1 and fills the cache.
 * FAIL-OPEN — any D1/KV error or corrupt JSON returns all-enabled.
 * Never throws. Most callers want {@link getEffectiveFeatures}; this
 * form also says whether the answer was read or assumed, for a caller
 * that keeps its own last-known-good value (`api/_lib/orbit-gate.ts`).
 */
export async function readEffectiveFeatures(env: CatalogEnv): Promise<EffectiveFeaturesRead> {
  try {
    if (env.CATALOG_KV) {
      try {
        const cached = await env.CATALOG_KV.get(NODE_FEATURES_CACHE_KEY)
        if (cached) return { features: normalizeFeatures(JSON.parse(cached)), authoritative: true }
      } catch {
        // KV failure = cache miss; D1 is the source of truth.
      }
    }
    if (!env.CATALOG_DB) return { features: defaultFeatures(), authoritative: true }
    const features = featuresFromRow(await getNodeSettings(env.CATALOG_DB))
    if (env.CATALOG_KV) {
      try {
        await env.CATALOG_KV.put(NODE_FEATURES_CACHE_KEY, JSON.stringify(features), {
          expirationTtl: CACHE_TTL_SECONDS,
        })
      } catch {
        // Best-effort fill.
      }
    }
    return { features, authoritative: true }
  } catch {
    return { features: defaultFeatures(), authoritative: false }
  }
}

/** {@link readEffectiveFeatures}, map only. Never throws. */
export async function getEffectiveFeatures(env: CatalogEnv): Promise<FeatureMap> {
  return (await readEffectiveFeatures(env)).features
}

/** {@link readEffectiveEmbedPolicy}'s answer. `authoritative` is false
 *  when a storage error or unusable stored data forced the fail-open
 *  `any`, so a caller holding a last-known-good answer can keep it. */
export interface EffectiveEmbedPolicyRead {
  policy: EmbedPolicy
  authoritative: boolean
}

/**
 * The hot-path read for the root middleware: this node's embedding
 * policy. One KV hit when warm; on a miss, reads D1 and fills the
 * cache. FAIL-OPEN — any D1/KV error or corrupt stored value returns
 * `any` with `authoritative: false` (see this module's header for why
 * open rather than closed). A stored policy that no longer validates
 * is not a failed read: it comes back narrowed, as
 * `parseStoredEmbedPolicy` explains. Never throws. A cached value is re-parsed
 * through the same validator as a stored one, so nothing in KV reaches
 * a header unchecked either.
 */
export async function readEffectiveEmbedPolicy(env: CatalogEnv): Promise<EffectiveEmbedPolicyRead> {
  try {
    if (env.CATALOG_KV) {
      try {
        const cached = await env.CATALOG_KV.get(NODE_EMBEDDING_CACHE_KEY)
        if (cached) {
          const stored = parseStoredEmbedPolicy(JSON.parse(cached))
          if (stored) return { policy: stored.policy, authoritative: true }
        }
      } catch {
        // KV failure or a bad entry = cache miss; D1 is the source of truth.
      }
    }
    if (!env.CATALOG_DB) return { policy: defaultEmbedPolicy(), authoritative: true }
    // Throws on a node that has not applied 0057; caught below as a
    // failed read, so such a node sends nothing, as it did before.
    const stored = storedEmbedPolicy(await getStoredEmbedPolicyJson(env.CATALOG_DB))
    if (!stored) return { policy: defaultEmbedPolicy(), authoritative: false }
    const policy = stored.policy
    if (env.CATALOG_KV) {
      try {
        await env.CATALOG_KV.put(NODE_EMBEDDING_CACHE_KEY, JSON.stringify(policy), {
          expirationTtl: EMBEDDING_CACHE_TTL_SECONDS,
        })
      } catch {
        // Best-effort fill.
      }
    }
    return { policy, authoritative: true }
  } catch {
    return { policy: defaultEmbedPolicy(), authoritative: false }
  }
}
