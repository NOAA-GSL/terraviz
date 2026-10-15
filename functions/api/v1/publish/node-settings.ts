// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /api/v1/publish/node-settings — the per-node feature toggles and
 * the embedding policy (which sites may frame the public app).
 *
 * GET → `{ features, embedding, updatedBy, updatedAt }`: the effective
 *       feature map (all keys, defaults filled) and the embedding
 *       policy (`{ mode, origins }`, `any` when never set). Any
 *       signed-in publisher may read it — gated pages render their
 *       "feature disabled" card from authoritative data, not just the
 *       sidebar's copy, and the Embedding card shows the policy
 *       read-only to non-admins.
 * PUT → Replace one section or both. Body:
 *       `{ features?: { <key>: boolean, ... }, embedding?: { mode, origins } }`
 *       — at least one. A section left out is untouched, so the two
 *       portal cards save independently. `features` may be partial
 *       (missing keys stay enabled); `embedding` is replaced whole and
 *       validated by `src/types/node-embedding.ts`, whose output goes
 *       into a response header on every page. 400 `{ errors }` for
 *       body problems (the publisher-API field-error envelope), with
 *       each refused origin named by index (`embedding.origins.2`).
 *       The response is the GET shape.
 *
 * Writes are **admin-only** (`isAdmin`, stricter than the node
 * profile's `isPrivileged`) — a service token must not be able to
 * flip node-level features or open the node to framing. Writes are
 * audit-logged (`node_settings.update`) and bust every cache that
 * carries either section: effective features, the public node-profile
 * payload (which ships the feature map to the SPA), and the effective
 * embedding policy the root middleware reads.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import {
  bustNodeEmbeddingCache,
  bustNodeFeaturesCache,
  disabledKeys,
  embedPolicyFromRow,
  featuresFromRow,
  getNodeSettings,
  setNodeSettings,
  validateFeaturesInput,
  type NodeSettingsRow,
  type NodeSettingsUpdate,
} from '../_lib/node-settings-store'
import { bustNodeProfileCache, type FieldError } from '../_lib/node-profile-store'
import { validateEmbedPolicyInput } from '../../../../src/types/node-embedding'
import { isAdmin } from '../_lib/publisher-store'
import { writeAuditEvent } from '../_lib/audit-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** The GET / PUT response: both sections, defaults filled. */
function settingsResponse(row: NodeSettingsRow | null): Response {
  return new Response(
    JSON.stringify({
      features: featuresFromRow(row),
      embedding: embedPolicyFromRow(row),
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    }),
    {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
    },
  )
}

/** Validate whichever sections the body carries. At least one is
 *  required; an unknown top-level key is ignored, as it always was. */
function validateSettingsInput(
  raw: unknown,
): { ok: true; value: NodeSettingsUpdate } | { ok: false; errors: FieldError[] } {
  const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const hasFeatures = 'features' in body
  const hasEmbedding = 'embedding' in body
  if (!hasFeatures && !hasEmbedding) {
    return {
      ok: false,
      errors: [{ field: 'body', code: 'required', message: 'Send `features`, `embedding`, or both.' }],
    }
  }
  const errors: FieldError[] = []
  const value: NodeSettingsUpdate = {}
  if (hasFeatures) {
    const features = validateFeaturesInput(body)
    if (features.ok) value.features = features.value
    else errors.push(...features.errors)
  }
  if (hasEmbedding) {
    const embedding = validateEmbedPolicyInput(body.embedding)
    if (embedding.ok) value.embedding = embedding.value
    else errors.push(...embedding.errors)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  return settingsResponse(await getNodeSettings(context.env.CATALOG_DB))
}

export const onRequestPut: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isAdmin(publisher)) {
    return jsonError(403, 'forbidden_role', 'Editing node settings is restricted to admins.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const validation = validateSettingsInput(body)
  if (!validation.ok) {
    return new Response(JSON.stringify({ errors: validation.errors }), {
      status: 400,
      headers: { 'Content-Type': CONTENT_TYPE },
    })
  }

  const update = validation.value
  const row = await setNodeSettings(context.env.CATALOG_DB, publisher, update)

  // Metadata names only the sections this write replaced.
  const metadata: Record<string, unknown> = {}
  if (update.features) metadata.disabled = disabledKeys(update.features)
  if (update.embedding) metadata.embedding = update.embedding
  await writeAuditEvent(context.env.CATALOG_DB, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'node_settings.update',
    subject_kind: 'node_settings',
    subject_id: null,
    metadata_json: JSON.stringify(metadata),
  })
  // Every hot path that carries either section: the middleware and
  // public-handler gate read node-features:v1, the public node-profile
  // payload ships the map to the SPA, and the root middleware reads
  // node-embedding:v1. Busting all three on any write is three KV
  // deletes on a rare admin action, and cannot leave one stale.
  await bustNodeFeaturesCache(context.env.CATALOG_KV)
  await bustNodeProfileCache(context.env.CATALOG_KV)
  await bustNodeEmbeddingCache(context.env.CATALOG_KV)

  return settingsResponse(row)
}
