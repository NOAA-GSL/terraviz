// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared types + pure helpers for the Events-tab redesign
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md`). The
 * wire shapes mirror `GET /api/v1/publish/events` (each event via
 * `toPublicEvent`, so `geometry` + `categories` + `keywords` are already
 * present); the helpers are framework-free so the queue/detail
 * components and tests can share them.
 */

import { toDisplayScore } from './match-badge'

export type EventStatus = 'proposed' | 'approved' | 'rejected' | 'expired'
export type LinkStatus = 'proposed' | 'approved' | 'rejected'

/** Per-signal match breakdown (0–1 each, or null). "Topic" = lexical. */
export interface LinkSignals {
  geo?: number | null
  temporal?: number | null
  lexical?: number | null
  semantic?: number | null
}

export interface ReviewLink {
  datasetId: string
  datasetTitle: string | null
  score: number | null
  signals: LinkSignals | null
  status: LinkStatus
}

export interface EventGeometry {
  boundingBox?: { n: number; s: number; w: number; e: number }
  point?: { lat: number; lon: number }
  regionName?: string
}

/** The provenance vocabulary of the slice-C enrichment — which event
 *  fields the ingest layer can AI-infer (`events-enrich.ts`). */
export type InferredField = 'occurredStart' | 'geometry'

export interface ReviewEvent {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  status: EventStatus
  geometry?: EventGeometry
  /** Facet group → values, e.g. `{ "Wildfires": ["Fire"] }`. */
  categories?: Record<string, string[]>
  keywords?: string[]
  /** Fields the ingest layer AI-inferred — the detail pane badges these
   *  so the curator double-checks them before approving (feeds slice C).
   *  Mirrors the backend's `InferredField` provenance vocabulary. */
  inferredFields?: InferredField[]
  /** The story's lead image (feed enclosure / og:image) — shown in the
   *  detail pane so the curator vets it with the event. */
  imageUrl?: string
  /** Alt text for `imageUrl` (media accessibility) — curator-supplied
   *  on upload / suggestion pick. */
  imageAlt?: string
  /** Curator-picked agency video embed (youtube-nocookie/embed) — the
   *  generated tour frames it; independent of the story image. */
  videoEmbedUrl?: string
  /** Curator-picked DIRECT video file (non-YouTube agency MP4) — the
   *  generated tour plays it natively via the media-proxy. Mutually
   *  exclusive with `videoEmbedUrl` in practice (an event has one video). */
  videoFileUrl?: string
  links: ReviewLink[]
  /** Whether the caller may review/edit this event: its owner (with
   *  `content.edit.own`), or an `content.edit.any` holder
   *  (editor / admin / service) — the latter also covers as-yet-unclaimed
   *  events (`owner_id === null`), which are editable only at the `.any`
   *  tier, not by any active publisher. Absent (older payload / fixture)
   *  is treated as editable; the server is the authoritative gate. */
  can_edit?: boolean
}

export interface EventsResponse {
  events: ReviewEvent[]
  /** How many events the requested status bucket holds. More than
   *  `events.length` when the server stopped at its cap; absent from a
   *  server that predates the field, which means "assume all loaded". */
  total?: number
}

/**
 * Composite match ≥ this percent (display scale) is auto-suggested as
 * paired when the curator approves the event; the rest stay "suggested"
 * for a manual look. Single named constant per the brief §5.
 *
 * **This number is scale-dependent and has to be re-measured whenever
 * the matcher's scoring changes.** It was 90 against the old saturating
 * topical score, which pinned about a quarter of the catalogue at
 * exactly 1.0 and fired this shortcut on all 118 events then in the
 * queue. After the switch to an IDF-weighted cosine, a re-score of the
 * live catalogue put 3 links out of 3,355 at or above 0.90 — so 90 had
 * quietly retired the very shortcut it exists to enable.
 *
 * 80 catches 56 of those 3,355. The next rung down, 70, catches 469 —
 * roughly one scored link in seven, which is too many to hand to a
 * single click on a control whose whole promise is that the curator
 * need not look. Selective, not decorative, is the bar.
 */
export const AUTO_PAIR_THRESHOLD = 80

/** Composite match for a link on the display 0–100 scale (or null). */
export function compositePercent(link: ReviewLink): number | null {
  return toDisplayScore(link.score)
}

/**
 * A dataset title with a trailing climate-scenario qualifier removed, or
 * null when it has none.
 *
 * Scenario variants of one field — `Climate Model - Sea Ice
 * Concentration: SSP1 (Low)` / `SSP2 (Moderate)` / `SSP5 (Very High)` —
 * are the same globe three times to a viewer. They also score
 * identically against an event, so they clear any threshold together.
 *
 * Deliberately narrow. Grouping on the text before a colon would be
 * catalogue-agnostic and wrong: it collapses `Tsunami Historical
 * Series: Chile - 1960` with `… Japan - 2011`, which are eight distinct
 * events a curator may well want individually. Nothing lexical
 * separates "same field, different scenario" from "same series,
 * different event" — only the scenario vocabulary does, so that is what
 * this matches. Against the live 180-row catalogue it groups exactly
 * the 12 SSP datasets into 4 families and leaves everything else alone.
 */
export function scenarioFamily(title: string | null | undefined): string | null {
  if (!title) return null
  const stem = title.replace(SCENARIO_SUFFIX, '')
  if (stem === title) return null
  const trimmed = stem.replace(/[\s:\-–—]+$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Trailing `SSP2 (Moderate)` / `RCP8.5` and the separator before it. */
const SCENARIO_SUFFIX = /[\s:\-–—]*\b(?:SSP|RCP)\s*\d+(?:\.\d+)?\b(?:\s*\([^)]*\))?\s*$/i

/**
 * The dataset ids the bulk-approve control should pair: still-proposed
 * links whose composite clears {@link AUTO_PAIR_THRESHOLD}. Already
 * approved/rejected links are left as-is; null-composite links never
 * auto-pair (a human decides).
 *
 * At most one scenario variant per family is returned — the
 * highest-scoring, ties broken on dataset id so the choice is stable.
 * Measured against 118 real NASA EONET events, 36 of the 45 links this
 * shortcut would pair were three SSP siblings clearing together on 12
 * sea-ice events, so one click paired three near-identical projections
 * of one field. The others stay `proposed` rather than being rejected:
 * a curator who wants a second scenario can still pair it by hand. The
 * shortcut gets more conservative; nobody loses a choice.
 */
export function autoPairTargets(
  event: Pick<ReviewEvent, 'links'>,
  threshold: number = AUTO_PAIR_THRESHOLD,
): string[] {
  const eligible = event.links
    .filter(l => l.status === 'proposed')
    // Compare the RAW 0–1 score against the threshold, not the rounded
    // display percent — an approval shortcut must be conservative, so a
    // link at 0.795 (rounds to 80) stays below an 80% threshold.
    .filter(l => l.score != null && Number.isFinite(l.score) && l.score >= threshold / 100)

  const bestOfFamily = new Map<string, ReviewLink>()
  for (const link of eligible) {
    const family = scenarioFamily(link.datasetTitle)
    if (family === null) continue
    const held = bestOfFamily.get(family)
    if (
      !held ||
      (link.score ?? 0) > (held.score ?? 0) ||
      ((link.score ?? 0) === (held.score ?? 0) && link.datasetId < held.datasetId)
    ) {
      bestOfFamily.set(family, link)
    }
  }

  return eligible
    .filter(l => {
      const family = scenarioFamily(l.datasetTitle)
      return family === null || bestOfFamily.get(family) === l
    })
    .map(l => l.datasetId)
}

/**
 * A single lat/lon to centre the locator map on: the event's point, or
 * the centre of its bounding box. Region-only (or geometry-less) events
 * return null — the locator is hidden rather than faked.
 */
export function locatorPoint(geometry: EventGeometry | undefined): { lat: number; lon: number } | null {
  if (!geometry) return null
  if (geometry.point) return geometry.point
  if (geometry.boundingBox) {
    const { n, s, w, e } = geometry.boundingBox
    return { lat: (n + s) / 2, lon: (w + e) / 2 }
  }
  return null
}

/** The event's primary category value (drives the leading glyph / dot),
 *  or null when uncategorised. Takes the first value of the first
 *  facet group, matching how the queue surfaces one category word. */
export function primaryCategory(event: Pick<ReviewEvent, 'categories'>): string | null {
  const cats = event.categories
  if (!cats) return null
  for (const values of Object.values(cats)) {
    if (values && values.length > 0) return values[0]
  }
  return null
}

/** How many of an event's dataset pairings still await a decision —
 *  the queue row's "N datasets to review", and one of its sort keys. */
export function pendingLinkCount(event: Pick<ReviewEvent, 'links'>): number {
  return event.links.filter(l => l.status === 'proposed').length
}

/**
 * The event's strongest dataset pairing as a raw 0–1 score, or null when
 * nothing is scored. Rejected pairings are left out: a curator who has
 * already said "not this dataset" should not see the event ranked on it.
 */
export function bestMatchScore(event: Pick<ReviewEvent, 'links'>): number | null {
  let best: number | null = null
  for (const link of event.links) {
    if (link.status === 'rejected' || link.score == null || !Number.isFinite(link.score)) continue
    if (best === null || link.score > best) best = link.score
  }
  return best
}

/** How the queue is ordered. `newest` / `oldest` follow the server's own
 *  ordering (the event's occurred time, else its publish date, else
 *  ingest) rather than re-deriving it, so the two cannot disagree. */
export type QueueSort = 'newest' | 'oldest' | 'bestMatch' | 'mostToReview'
export const QUEUE_SORTS: readonly QueueSort[] = ['newest', 'oldest', 'bestMatch', 'mostToReview']

/** The curator's search, filters and sort over one loaded status bucket. */
export interface QueueQuery {
  /** Free text; every whitespace-separated term must appear. */
  text: string
  /** Exact `source.name`, or null for every source. */
  source: string | null
  /** A category value from any facet group, or null for every category. */
  category: string | null
  sort: QueueSort
}

export function emptyQueueQuery(): QueueQuery {
  return { text: '', source: null, category: null, sort: 'newest' }
}

/** Whether the query hides anything. Sort alone never does. */
export function isQueueFiltered(query: QueueQuery): boolean {
  return query.text.trim() !== '' || query.source !== null || query.category !== null
}

/** Lower-case and strip diacritics, so "sao paulo" finds "São Paulo". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Every category value on the event, across facet groups. The group
 *  key is left out: for EONET it is the word "EONET" on every row. */
function categoryValues(event: Pick<ReviewEvent, 'categories'>): string[] {
  return Object.values(event.categories ?? {}).flat()
}

/**
 * The text a search runs against: the event's own words — title, summary,
 * source, keywords, categories and place name. Linked dataset titles are
 * deliberately not in it: the matcher pairs datasets broadly, so a search
 * for "temperature" would otherwise return most of the queue.
 */
export function eventSearchText(event: ReviewEvent): string {
  return fold(
    [
      event.title,
      event.summary ?? '',
      event.source.name,
      ...(event.keywords ?? []),
      ...categoryValues(event),
      event.geometry?.regionName ?? '',
    ].join('\n'),
  )
}

export function matchesQueueQuery(event: ReviewEvent, query: QueueQuery): boolean {
  if (query.source !== null && event.source.name !== query.source) return false
  if (query.category !== null && !categoryValues(event).includes(query.category)) return false
  const terms = fold(query.text).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = eventSearchText(event)
  return terms.every(term => haystack.includes(term))
}

/**
 * The events the query keeps, in the order it asks for. `events` must be
 * in the server's order (newest first). `oldest` is that order reversed;
 * the score sorts break ties on it, newest first, so equal-scoring events
 * never shuffle between renders.
 */
export function applyQueueQuery(events: readonly ReviewEvent[], query: QueueQuery): ReviewEvent[] {
  const kept = events.filter(e => matchesQueueQuery(e, query))
  switch (query.sort) {
    case 'newest':
      return kept
    case 'oldest':
      return kept.reverse()
    case 'bestMatch':
      return stableSortDesc(kept, e => bestMatchScore(e) ?? -Infinity)
    case 'mostToReview':
      return stableSortDesc(kept, pendingLinkCount)
  }
}

function stableSortDesc(events: ReviewEvent[], key: (e: ReviewEvent) => number): ReviewEvent[] {
  return events
    .map((event, index) => ({ event, index, k: key(event) }))
    .sort((a, b) => b.k - a.k || a.index - b.index)
    .map(x => x.event)
}

/** One choice in a source / category dropdown, with how many loaded
 *  events carry it. */
export interface FacetOption {
  value: string
  count: number
}

function facetOptions(events: readonly ReviewEvent[], valuesOf: (e: ReviewEvent) => string[]): FacetOption[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    for (const value of new Set(valuesOf(event))) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** The sources present in the loaded events, most common first. */
export function sourceOptions(events: readonly ReviewEvent[]): FacetOption[] {
  return facetOptions(events, e => [e.source.name])
}

/** The category values present in the loaded events, most common first. */
export function categoryOptions(events: readonly ReviewEvent[]): FacetOption[] {
  return facetOptions(events, categoryValues)
}
