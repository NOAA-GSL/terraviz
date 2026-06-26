/**
 * /api/v1/publish/events — the current-events review queue + ingestion
 * sink (`docs/CURRENT_EVENTS_PLAN.md` §5, §9).
 *
 * GET  — Privileged-only review queue: events for a curator to vet, each
 *        with its proposed event→dataset links (score + per-signal
 *        breakdown + the linked dataset's title). Defaults to
 *        `status=proposed`; `?status=` narrows to another bucket.
 * POST — Privileged-only create (the ingestion path, typically a service
 *        token from the import-events CLI). Idempotent on
 *        `(feed_id, external_id)`: a re-ingest refreshes the existing
 *        event's content instead of duplicating it. On create/refresh the
 *        matcher runs to (re)propose dataset links, so the queue arrives
 *        pre-populated. Always lands as `proposed` — the curator gate is
 *        unchanged.
 *
 * Reads `context.data.publisher` injected by the publish middleware.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import { looksLikeUrl } from '../_lib/validators'
import { writeAuditEvent } from '../_lib/audit-store'
import { runMatcherForEvent } from '../_lib/events-matcher'
import {
  listCurrentEvents,
  listLinksForEvent,
  listLinksForEvents,
  getEventDecorations,
  getDecorationsForEvents,
  getCurrentEvent,
  insertCurrentEvent,
  findEventByExternal,
  updateCurrentEventContent,
  bustFeaturedEventCache,
  toPublicEvent,
  type CurrentEventStatus,
  type EventDatasetLinkRow,
  type EventGeometry,
  type NewCurrentEvent,
} from '../_lib/events-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

const VALID_STATUSES: readonly CurrentEventStatus[] = [
  'proposed',
  'approved',
  'rejected',
  'expired',
]

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

/** Shape a stored link row into the queue's wire form. */
function toPublicLink(row: EventDatasetLinkRow, datasetTitle: string | null) {
  return {
    datasetId: row.dataset_id,
    datasetTitle,
    score: row.match_score,
    signals: row.signals_json ? (JSON.parse(row.signals_json) as unknown) : null,
    status: row.status,
  }
}

/** Fetch the titles for a set of dataset ids in one query. */
async function fetchDatasetTitles(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (ids.length === 0) return titles
  const placeholders = ids.map(() => '?').join(', ')
  const res = await db
    .prepare(`SELECT id, title FROM datasets WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; title: string }>()
  for (const row of res.results ?? []) titles.set(row.id, row.title)
  return titles
}

export const onRequestGet: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'The events review queue is restricted to admin and service callers.')
  }

  const statusParam = new URL(context.request.url).searchParams.get('status')
  if (statusParam && !VALID_STATUSES.includes(statusParam as CurrentEventStatus)) {
    return jsonError(400, 'invalid_status', `\`status\` must be one of: ${VALID_STATUSES.join(', ')}.`)
  }
  const status = (statusParam as CurrentEventStatus | null) ?? 'proposed'

  const db = context.env.CATALOG_DB
  const eventRows = await listCurrentEvents(db, { status })

  // Bulk-fetch links + decorations for the whole page (chunked IN
  // queries) rather than two per event, then resolve all referenced
  // dataset titles in one more query — keeps the queue O(1) round-trips
  // as events accumulate, not O(N).
  const eventIds = eventRows.map(e => e.id)
  const linksByEvent = await listLinksForEvents(db, eventIds)
  const decorationsByEvent = await getDecorationsForEvents(db, eventIds)
  const datasetIds = [...new Set([...linksByEvent.values()].flat().map(l => l.dataset_id))]
  const titles = await fetchDatasetTitles(db, datasetIds)

  const events = eventRows.map(row => {
    const links = linksByEvent.get(row.id) ?? []
    const decorations = decorationsByEvent.get(row.id) ?? { categories: {}, keywords: [] }
    return {
      ...toPublicEvent(row, decorations),
      links: links.map(l => toPublicLink(l, titles.get(l.dataset_id) ?? null)),
    }
  })

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

// ----- POST: create / ingest -----

interface FieldError {
  field: string
  code: string
  message: string
}

function validationFailure(errors: FieldError[]): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 400,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Coerce an untrusted `categories` value to `Record<string, string[]>`,
 *  dropping non-array facets and non-string entries. An ingestion
 *  surface should persist a clean shape (or nothing) rather than let a
 *  malformed payload write garbage decoration rows. */
function sanitizeCategories(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [facet, values] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue
    const strs = values.filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (strs.length > 0) out[facet] = strs
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Parse the create body into a {@link NewCurrentEvent}. Provenance
 *  (title + source.name + source.url) is mandatory; everything else is
 *  optional. Geometry accepts any subset of bbox / point / region. */
function parseCreate(
  raw: unknown,
): { ok: true; value: NewCurrentEvent } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const title = asString(b.title)
  if (!title) errors.push({ field: 'title', code: 'required', message: '`title` is required.' })

  const src = (b.source && typeof b.source === 'object' ? b.source : {}) as Record<string, unknown>
  const sourceName = asString(src.name)
  const sourceUrl = asString(src.url)
  if (!sourceName) errors.push({ field: 'source.name', code: 'required', message: '`source.name` is required.' })
  if (!sourceUrl) {
    errors.push({ field: 'source.url', code: 'required', message: '`source.url` is required.' })
  } else if (!looksLikeUrl(sourceUrl)) {
    // The citation is rendered as a clickable link on public surfaces;
    // refuse non-http(s) schemes (javascript: / data:) at the door.
    errors.push({ field: 'source.url', code: 'invalid', message: '`source.url` must be an http(s) URL.' })
  }

  const geomRaw = (b.geometry && typeof b.geometry === 'object' ? b.geometry : {}) as Record<string, unknown>
  const geometry: EventGeometry = {}
  const bbox = (geomRaw.boundingBox && typeof geomRaw.boundingBox === 'object' ? geomRaw.boundingBox : null) as Record<string, unknown> | null
  if (bbox) {
    const n = asNumber(bbox.n), s = asNumber(bbox.s), w = asNumber(bbox.w), e = asNumber(bbox.e)
    if (n !== undefined && s !== undefined && w !== undefined && e !== undefined) {
      geometry.boundingBox = { n, s, w, e }
    }
  }
  const point = (geomRaw.point && typeof geomRaw.point === 'object' ? geomRaw.point : null) as Record<string, unknown> | null
  if (point) {
    const lat = asNumber(point.lat), lon = asNumber(point.lon)
    if (lat !== undefined && lon !== undefined) geometry.point = { lat, lon }
  }
  const regionName = asString(geomRaw.regionName)
  if (regionName) geometry.regionName = regionName

  const categories = sanitizeCategories(b.categories)
  const keywords = Array.isArray(b.keywords)
    ? (b.keywords as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0)
    : undefined

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      originNode: 'local', // overwritten with the node id in the handler
      title: title as string,
      summary: asString(b.summary) ?? null,
      sourceName: sourceName as string,
      sourceUrl: sourceUrl as string,
      publishedAt: asString(src.publishedAt) ?? null,
      feedId: asString(b.feedId) ?? null,
      externalId: asString(b.externalId) ?? null,
      occurredStart: asString(b.occurredStart) ?? null,
      occurredEnd: asString(b.occurredEnd) ?? null,
      geometry,
      categories,
      keywords,
    },
  }
}

/** Resolve this node's id for `origin_node`, mirroring the dataset
 *  write path's `(SELECT node_id FROM node_identity LIMIT 1)`. */
async function resolveOriginNode(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT node_id FROM node_identity LIMIT 1`).first<{ node_id: string }>()
  return row?.node_id ?? 'local'
}

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Creating events is restricted to admin and service callers.')
  }

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const parsed = parseCreate(body)
  if (!parsed.ok) return validationFailure(parsed.errors)

  const db = context.env.CATALOG_DB
  const input: NewCurrentEvent = { ...parsed.value, originNode: await resolveOriginNode(db) }

  // Idempotent on the feed dedupe key: a re-ingest refreshes the
  // existing event's content rather than creating a duplicate (and
  // never resurrects a curator-rejected one — status is untouched).
  let id: string
  let created: boolean
  if (input.feedId && input.externalId) {
    const existing = await findEventByExternal(db, input.feedId, input.externalId)
    if (existing) {
      await updateCurrentEventContent(db, existing.id, input)
      id = existing.id
      created = false
    } else {
      id = (await insertCurrentEvent(db, input)).id
      created = true
    }
  } else {
    id = (await insertCurrentEvent(db, input)).id
    created = true
  }

  // Re-propose dataset links for the (new or refreshed) event so the
  // review queue is pre-populated. Inline + awaited keeps the response
  // deterministic; the importer creates events serially with a throttle.
  const matches = await runMatcherForEvent(db, id)

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.ingested',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({
      created,
      feed_id: input.feedId ?? null,
      external_id: input.externalId ?? null,
      proposed_links: matches.length,
    }),
  })
  // A new approved event can't appear yet (lands proposed), but a
  // refresh of an already-approved event can change what the hero shows.
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  const row = await getCurrentEvent(db, id)
  const decorations = await getEventDecorations(db, id)
  const links = await listLinksForEvent(db, id)
  return new Response(
    JSON.stringify({
      created,
      event: row ? toPublicEvent(row, decorations) : null,
      links: links.map(l => toPublicLink(l, null)),
    }),
    { status: created ? 201 : 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
