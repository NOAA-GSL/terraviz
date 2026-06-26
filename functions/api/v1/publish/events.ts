/**
 * GET /api/v1/publish/events — the current-events review queue
 * (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (staff / admin / service). Lists events for a curator
 * to vet, each with its proposed event→dataset links (score + per-signal
 * breakdown + the linked dataset's title, so the reviewer can judge the
 * pairing without a second request). Defaults to `status=proposed`;
 * `?status=approved|rejected|expired` narrows to another bucket.
 *
 * Read-only — the approve/reject mutations live in
 * `events/[id].ts`. Reads `context.data.publisher` injected by the
 * publish middleware.
 */

import type { CatalogEnv } from '../_lib/env'
import type { PublisherData } from './_middleware'
import { isPrivileged } from '../_lib/publisher-store'
import {
  listCurrentEvents,
  listLinksForEvent,
  getEventDecorations,
  toPublicEvent,
  type CurrentEventStatus,
  type EventDatasetLinkRow,
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
    return jsonError(403, 'forbidden_role', 'The events review queue is restricted to staff, admin, and service callers.')
  }

  const statusParam = new URL(context.request.url).searchParams.get('status')
  if (statusParam && !VALID_STATUSES.includes(statusParam as CurrentEventStatus)) {
    return jsonError(400, 'invalid_status', `\`status\` must be one of: ${VALID_STATUSES.join(', ')}.`)
  }
  const status = (statusParam as CurrentEventStatus | null) ?? 'proposed'

  const db = context.env.CATALOG_DB
  const eventRows = await listCurrentEvents(db, { status })

  // Gather links + decorations per event, then resolve all referenced
  // dataset titles in a single query.
  const perEvent = await Promise.all(
    eventRows.map(async row => ({
      row,
      links: await listLinksForEvent(db, row.id),
      decorations: await getEventDecorations(db, row.id),
    })),
  )
  const datasetIds = [...new Set(perEvent.flatMap(e => e.links.map(l => l.dataset_id)))]
  const titles = await fetchDatasetTitles(db, datasetIds)

  const events = perEvent.map(({ row, links, decorations }) => ({
    ...toPublicEvent(row, decorations),
    links: links.map(l => toPublicLink(l, titles.get(l.dataset_id) ?? null)),
  }))

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}
