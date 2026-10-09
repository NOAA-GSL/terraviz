// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { isPublicStacUrl } from '../_lib/stac-builders'
import { ETAG_HASH_LENGTH } from '../_lib/snapshot'

interface SourceEvidence {
  href: string
  content_digest: string
  evidence_href: string
  evidence_digest: string
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}

function authorize(context: EventContext<CatalogEnv, string, Record<string, unknown>>): Response | null {
  const publisher = (context.data as Partial<PublisherData>).publisher
  if (!publisher) return json(401, { error: 'unauthenticated' })
  if (publisher.status !== 'active' || !isPrivileged(publisher)) return json(403, { error: 'forbidden' })
  if (!context.env.CATALOG_DB) return json(503, { error: 'binding_missing' })
  return null
}

function reference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || !isPublicStacUrl(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && !url.search && !url.hash && url.href === value
}

function sources(raw: unknown): SourceEvidence[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) return null
  const result: SourceEvidence[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['href', 'content_digest', 'evidence_href', 'evidence_digest'].includes(key))
      || !reference(entry.href) || !reference(entry.evidence_href)
      || typeof entry.content_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.content_digest)
      || typeof entry.evidence_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.evidence_digest)) return null
    result.push({ href: entry.href, content_digest: entry.content_digest,
      evidence_href: entry.evidence_href, evidence_digest: entry.evidence_digest })
  }
  if (new Set(result.map(entry => entry.href)).size !== result.length) return null
  return result.sort((first, second) => first.href < second.href ? -1 : first.href > second.href ? 1 : 0)
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  const denied = authorize(context)
  if (denied) return denied
  const query = new URL(context.request.url).searchParams
  if ([...query.keys()].some(key => key !== 'cursor') || query.getAll('cursor').length > 1
    || (query.get('cursor')?.length ?? 0) > 200) return json(400, { error: 'invalid_query' })
  try {
    const rows = await context.env.CATALOG_DB!.prepare(`SELECT publication.id AS publication_id,
      publication.dataset_id, publication.kind, publication.captured_at,
      CASE WHEN lineage.publication_id IS NULL THEN 'missing' ELSE 'operator_attested' END AS lineage_status,
      lineage.sources_json, lineage.recorded_by, lineage.recorded_at
      FROM stac_history_publications publication LEFT JOIN stac_source_lineage lineage
        ON lineage.publication_id = publication.id
      WHERE publication.id > ? ORDER BY publication.id LIMIT 51`).bind(query.get('cursor') ?? '')
      .all<{ publication_id: string; sources_json: string | null }>()
    const page = rows.results.slice(0, 50)
    return json(200, { processing_enabled: false,
      records: page.map(({ sources_json, ...row }) => ({ ...row, sources: sources_json ? JSON.parse(sources_json) : [] })),
      next_cursor: rows.results.length > 50 ? page.at(-1)!.publication_id : null })
  } catch { return json(503, { error: 'stac_lineage_unavailable' }) }
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const denied = authorize(context)
  if (denied) return denied
  if (new URL(context.request.url).search) return json(400, { error: 'invalid_query' })
  const reader = context.request.body?.getReader()
  if (!reader) return json(400, { error: 'invalid_json' })
  let raw: unknown
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 65536) { await reader.cancel(); return json(413, { error: 'body_too_large' }) }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch { return json(400, { error: 'invalid_json' }) }
  finally { reader.releaseLock() }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return json(400, { error: 'invalid_body' })
  const body = raw as Record<string, unknown>
  const evidence = sources(body.sources)
  if (Object.keys(body).some(key => !['publication_id', 'reviewed', 'sources'].includes(key))
    || typeof body.publication_id !== 'string' || !new RegExp(`^(frames|revision)-[A-Za-z0-9_-]{${ETAG_HASH_LENGTH}}$`).test(body.publication_id)
    || body.reviewed !== true || !evidence) return json(400, { error: 'invalid_body' })
  const publisher = (context.data as unknown as PublisherData).publisher
  const db = context.env.CATALOG_DB!
  const canonical = JSON.stringify(evidence)
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO stac_source_lineage (publication_id, sources_json, recorded_by, recorded_at)
        SELECT id, ?, ?, ? FROM stac_history_publications WHERE id = ?
        ON CONFLICT(publication_id) DO NOTHING`)
        .bind(canonical, publisher.id, new Date().toISOString(), body.publication_id),
      db.prepare('SELECT sources_json FROM stac_source_lineage WHERE publication_id = ?').bind(body.publication_id),
    ])
    const saved = results[1].results[0] as { sources_json: string } | undefined
    if (!saved) return json(404, { error: 'publication_not_found' })
    if (saved.sources_json !== canonical) return json(409, { error: 'lineage_conflict' })
    return json(results[0].meta.changes ? 201 : 200, { publication_id: body.publication_id,
      lineage_status: 'operator_attested', processing_enabled: false })
  } catch { return json(503, { error: 'stac_lineage_unavailable' }) }
}