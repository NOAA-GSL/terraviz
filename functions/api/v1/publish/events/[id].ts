/**
 * POST /api/v1/publish/events/:id — submit a curator review for one
 * current event (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (admin / service). Carries the curator's
 * decisions in a single body so an event verdict and per-link verdicts
 * land together:
 *
 *   {
 *     "event": "approve" | "reject",                 // optional: vet the event itself
 *     "links": [{ "datasetId": "...", "decision": "approve" | "reject" }], // optional
 *     "addDatasetIds": ["..."],                       // optional: pair extra datasets the matcher missed
 *     "edits": { "occurredStart": "...", "regionName": "..." } // optional: correct the event's own metadata
 *   }
 *
 * `edits` lets a curator override the occurred time and/or location —
 * the fix for a wrong or missing AI-inferred value (slice C). The
 * region name resolves through the same `regions.ts` vocabulary the
 * enrichment uses; an edited field sheds its "AI-inferred" flag and the
 * matcher re-runs so the pairing signals score the corrected values.
 *
 * `addDatasetIds` lets a curator pair a dataset the matcher never
 * suggested: each is seeded as a fresh `proposed` link (visibility-
 * filtered; ids already linked are skipped so a matcher score is never
 * clobbered), ready to approve like any other.
 *
 * Event status (is this event reputable/relevant?) and link status
 * (is this dataset pairing good?) are independent dimensions — a curator
 * can approve the event and reject a weak link in the same submit. 404
 * if the event is unknown; 400 `{ errors }` for a malformed body or a
 * `datasetId` that isn't a proposed link of the event. One audit row
 * (`event.reviewed`) records the whole submission.
 *
 * Reads `context.data.publisher` injected by the publish middleware.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { isPrivileged } from '../../_lib/publisher-store'
import { writeAuditEvent } from '../../_lib/audit-store'
import {
  getCurrentEvent,
  listLinksForEvent,
  getEventDecorations,
  setEventStatus,
  setLinkStatus,
  insertProposedLinkIfAbsent,
  applyEventEdits,
  toPublicEvent,
  bustFeaturedEventCache,
  type CurrentEventStatus,
  type EventGeometry,
  type EventLinkStatus,
} from '../../_lib/events-store'
import { sanitizeDatasetIds, filterVisibleDatasetIds } from '../../_lib/events-ingest'
import { runMatcherForEvent } from '../../_lib/events-matcher'
import { resolveRegion } from '../../../../../src/data/regions'

const CONTENT_TYPE = 'application/json; charset=utf-8'

interface FieldError {
  field: string
  code: string
  message: string
}

type Decision = 'approve' | 'reject'

interface LinkDecision {
  datasetId: string
  decision: Decision
}

interface ParsedReview {
  event?: Decision
  links: LinkDecision[]
  addDatasetIds: string[]
  /** Curator corrections to the event's own metadata (slice C: the fix
   *  for a wrong or missing AI-inferred value). `geometry` arrives
   *  resolved from `edits.regionName` via `regions.ts`. */
  edits?: { occurredStart?: string; geometry?: EventGeometry }
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function validationFailure(errors: FieldError[]): Response {
  return new Response(JSON.stringify({ errors }), {
    status: 400,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

const DECISION_TO_STATUS: Record<Decision, EventLinkStatus & CurrentEventStatus> = {
  approve: 'approved',
  reject: 'rejected',
}

/** Validate the review body shape (not yet against the event's links). */
function parseReview(
  raw: unknown,
): { ok: true; value: ParsedReview } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  let event: Decision | undefined
  if (body.event != null) {
    if (body.event === 'approve' || body.event === 'reject') event = body.event
    else errors.push({ field: 'event', code: 'invalid', message: '`event` must be "approve" or "reject".' })
  }

  const links: LinkDecision[] = []
  if (body.links != null) {
    if (!Array.isArray(body.links)) {
      errors.push({ field: 'links', code: 'invalid', message: '`links` must be an array.' })
    } else {
      body.links.forEach((entry, i) => {
        const l = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
        const datasetId = l.datasetId
        const decision = l.decision
        if (typeof datasetId !== 'string' || datasetId.length === 0) {
          errors.push({ field: `links[${i}].datasetId`, code: 'required', message: '`datasetId` is required.' })
        }
        if (decision !== 'approve' && decision !== 'reject') {
          errors.push({ field: `links[${i}].decision`, code: 'invalid', message: '`decision` must be "approve" or "reject".' })
        }
        if (typeof datasetId === 'string' && (decision === 'approve' || decision === 'reject')) {
          links.push({ datasetId, decision })
        }
      })
    }
  }

  const addDatasetIds = sanitizeDatasetIds(body.addDatasetIds)

  // Curator metadata corrections — a date and/or a place constrained to
  // the same regions.ts vocabulary the AI enrichment uses.
  let edits: ParsedReview['edits']
  if (body.edits != null) {
    const e = (body.edits && typeof body.edits === 'object' ? body.edits : {}) as Record<string, unknown>
    const out: NonNullable<ParsedReview['edits']> = {}
    if (e.occurredStart != null) {
      const ms = typeof e.occurredStart === 'string' ? Date.parse(e.occurredStart) : NaN
      if (!Number.isFinite(ms)) {
        errors.push({ field: 'edits.occurredStart', code: 'invalid', message: '`edits.occurredStart` must be a parseable date.' })
      } else {
        out.occurredStart = new Date(ms).toISOString()
      }
    }
    if (e.regionName != null) {
      const region = typeof e.regionName === 'string' ? resolveRegion(e.regionName) : null
      if (!region) {
        errors.push({ field: 'edits.regionName', code: 'invalid', message: '`edits.regionName` must be a known region name.' })
      } else {
        const [w, s, eb, n] = region.bounds
        out.geometry = { boundingBox: { n, s, w, e: eb }, regionName: region.name }
      }
    }
    if (Object.keys(out).length > 0) edits = out
  }

  if (event === undefined && links.length === 0 && addDatasetIds.length === 0 && edits === undefined && errors.length === 0) {
    errors.push({ field: 'event', code: 'empty', message: 'Provide an `event` decision, one or more `links`, `addDatasetIds`, or `edits`.' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { event, links, addDatasetIds, edits } }
}

export const onRequestPost: PagesFunction<CatalogEnv, 'id'> = async context => {
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  const publisher = (context.data as unknown as PublisherData).publisher
  if (!isPrivileged(publisher)) {
    return jsonError(403, 'forbidden_role', 'Reviewing events is restricted to admin and service callers.')
  }

  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing event id.')

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body is not valid JSON.')
  }

  const parsed = parseReview(body)
  if (!parsed.ok) return validationFailure(parsed.errors)

  const db = context.env.CATALOG_DB
  const event = await getCurrentEvent(db, id)
  if (!event) return jsonError(404, 'not_found', `Event ${id} not found.`)

  // Apply metadata corrections before anything else, so a same-submit
  // approve acts on the corrected event, and re-run the matcher so the
  // T/Ti/G signals score against the curator's values (statuses are
  // preserved; scores refresh, new candidates may propose).
  if (parsed.value.edits) {
    await applyEventEdits(db, id, parsed.value.edits)
    await runMatcherForEvent(db, id, { env: context.env })
  }

  // Seed any hand-picked additions FIRST (so an add + approve can land in
  // one submit). Drop hidden/retracted/unknown datasets via the shared
  // visibility filter, then insert atomically with DO-NOTHING-on-conflict:
  // an already-linked dataset is left untouched (its matcher score is never
  // clobbered), even under a concurrent add or matcher write.
  let addedCount = 0
  if (parsed.value.addDatasetIds.length > 0) {
    const visible = await filterVisibleDatasetIds(db, parsed.value.addDatasetIds)
    for (const datasetId of visible) {
      if (await insertProposedLinkIfAbsent(db, id, datasetId)) addedCount++
    }
  }

  // Every link decision must target a real link of this event. A link of
  // any status is fair game — a curator may revise an earlier decision —
  // so we check existence, not status.
  const existingLinks = await listLinksForEvent(db, id)
  const linkIds = new Set(existingLinks.map(l => l.dataset_id))
  const unknownLinks = parsed.value.links.filter(l => !linkIds.has(l.datasetId))
  if (unknownLinks.length > 0) {
    return validationFailure(
      unknownLinks.map(l => ({
        field: 'links',
        code: 'unknown_link',
        message: `Dataset ${l.datasetId} is not a link of event ${id}.`,
      })),
    )
  }

  if (parsed.value.event) {
    await setEventStatus(db, id, DECISION_TO_STATUS[parsed.value.event], publisher.id)
  }
  for (const link of parsed.value.links) {
    await setLinkStatus(db, id, link.datasetId, DECISION_TO_STATUS[link.decision], publisher.id)
  }

  await writeAuditEvent(db, {
    actor_kind: 'publisher',
    actor_id: publisher.id,
    action: 'event.reviewed',
    subject_kind: 'event',
    subject_id: id,
    metadata_json: JSON.stringify({
      event: parsed.value.event ?? null,
      links: parsed.value.links,
      added_links: addedCount,
      edits: parsed.value.edits ?? null,
    }),
  })

  // A status change can alter what the public "Right now" hero surfaces;
  // bust the cache so an approval shows up within a tick (the 60 s TTL is
  // the backstop).
  await bustFeaturedEventCache(context.env.CATALOG_KV)

  // Re-read so the response reflects the applied decisions.
  const updated = await getCurrentEvent(db, id)
  const decorations = await getEventDecorations(db, id)
  const links = await listLinksForEvent(db, id)
  return new Response(
    JSON.stringify({
      event: updated ? toPublicEvent(updated, decorations) : null,
      links: links.map(l => ({
        datasetId: l.dataset_id,
        score: l.match_score,
        status: l.status,
      })),
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' } },
  )
}
