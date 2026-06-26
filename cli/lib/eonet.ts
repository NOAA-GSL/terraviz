/**
 * NASA EONET → current-event mapper (pure).
 *
 * EONET (Earth Observatory Natural Event Tracker) is an openly-licensed,
 * curated feed of natural events (storms, wildfires, volcanoes, icebergs)
 * tagged with geometry + time + category — the closest fit to SOS
 * datasets and the first connector for the current-events ingestion path
 * (`docs/CURRENT_EVENTS_PLAN.md` §9). This module is the pure mapping
 * from an EONET v3 `events` payload to the `POST /api/v1/publish/events`
 * create bodies; the network fetch + posting live in
 * `cli/import-events.ts`.
 *
 * Source-agnostic backend, node-configurable connector: EONET is *one*
 * example connector wired for an Earth-science node. The event shape it
 * produces carries only generic provenance + a `feed_id` of `eonet`.
 */

export const EONET_FEED_ID = 'eonet'
export const EONET_SOURCE_NAME = 'NASA EONET'

/** Default EONET v3 endpoint — open events from the last 14 days. */
export const EONET_DEFAULT_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=14'

/** A raw EONET event (the subset we read). */
export interface EonetEvent {
  id?: unknown
  title?: unknown
  description?: unknown
  link?: unknown
  categories?: Array<{ id?: unknown; title?: unknown }>
  sources?: Array<{ id?: unknown; url?: unknown }>
  geometry?: Array<{ date?: unknown; type?: unknown; coordinates?: unknown }>
}

export interface EonetFeed {
  events?: EonetEvent[]
}

/** A `POST /api/v1/publish/events` create body. */
export interface EventCreateBody {
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  feedId: string
  externalId: string
  occurredStart?: string
  occurredEnd?: string
  geometry?: {
    boundingBox?: { n: number; s: number; w: number; e: number }
    point?: { lat: number; lon: number }
  }
  categories?: Record<string, string[]>
  keywords?: string[]
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Recursively collect `[lon, lat]` pairs from an EONET coordinates
 *  value (Point → one pair; Polygon → nested rings). */
function collectLonLat(coords: unknown, out: Array<[number, number]>): void {
  if (!Array.isArray(coords)) return
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    out.push([coords[0], coords[1]])
    return
  }
  for (const c of coords) collectLonLat(c, out)
}

/** Map one EONET geometry entry to event geometry (point for a single
 *  coordinate, bounding box for a polygon). */
function toGeometry(coordinates: unknown): EventCreateBody['geometry'] | undefined {
  const pairs: Array<[number, number]> = []
  collectLonLat(coordinates, pairs)
  if (pairs.length === 0) return undefined
  if (pairs.length === 1) {
    const [lon, lat] = pairs[0]
    return { point: { lat, lon } }
  }
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity
  for (const [lon, lat] of pairs) {
    if (lon < w) w = lon
    if (lon > e) e = lon
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return { boundingBox: { n, s, w, e } }
}

/**
 * Map a single EONET event to a create body, or null when it lacks the
 * minimum we need (a stable id, a title, and at least one geometry with
 * coordinates). The latest geometry entry drives the location + time;
 * the first source (falling back to the EONET link) is the citation.
 */
export function mapEonetEvent(raw: EonetEvent): EventCreateBody | null {
  const externalId = asStr(raw.id)
  const title = asStr(raw.title)
  if (!externalId || !title) return null

  const geoms = Array.isArray(raw.geometry) ? raw.geometry : []
  if (geoms.length === 0) return null
  const latest = geoms[geoms.length - 1]
  const geometry = toGeometry(latest?.coordinates)
  if (!geometry) return null

  const sourceUrl = asStr(raw.sources?.[0]?.url) ?? asStr(raw.link)
  if (!sourceUrl) return null

  const dates = geoms.map(g => asStr(g.date)).filter((d): d is string => !!d)
  const occurredStart = dates[0]
  const occurredEnd = dates.length > 1 ? dates[dates.length - 1] : undefined

  const catTitles = (raw.categories ?? []).map(c => asStr(c.title)).filter((t): t is string => !!t)
  const catIds = (raw.categories ?? []).map(c => asStr(c.id)).filter((t): t is string => !!t)

  const body: EventCreateBody = {
    title,
    source: { name: EONET_SOURCE_NAME, url: sourceUrl },
    feedId: EONET_FEED_ID,
    externalId,
    geometry,
  }
  const summary = asStr(raw.description)
  if (summary) body.summary = summary
  if (occurredStart) {
    body.occurredStart = occurredStart
    body.source.publishedAt = occurredStart
  }
  if (occurredEnd) body.occurredEnd = occurredEnd
  if (catTitles.length) body.categories = { EONET: catTitles }
  if (catIds.length) body.keywords = catIds
  return body
}

/** Map an EONET feed to create bodies, dropping events we can't map. */
export function mapEonetFeed(feed: EonetFeed): EventCreateBody[] {
  const events = Array.isArray(feed.events) ? feed.events : []
  return events.map(mapEonetEvent).filter((b): b is EventCreateBody => b !== null)
}
