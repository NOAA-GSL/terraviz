/**
 * Media suggestions for the Events tab (task: media suggestion
 * engine, slice 1) — pure candidate builders the detail pane renders
 * as a "Suggested media" card row.
 *
 * First source: **NASA Worldview snapshots** — the Worldview
 * Snapshots API renders real satellite imagery for a bounding box and
 * date as a plain image URL (keyless, public domain, no fetch needed
 * to *suggest*; the URL itself is the image). Since events carry
 * geometry and a date, this gives every located event a "what the
 * satellite saw there, that day" candidate — the most on-mission
 * image a node about live Earth data can offer.
 *
 * Curator-picked by design: nothing here writes anything. The pane's
 * "Use as event image" posts the chosen URL through the review
 * endpoint's `edits`, where it lands on `current_events.image_url`
 * and flows into generated tours like any vetted story image.
 */

import type { EventGeometry } from './events-model'

export interface MediaSuggestion {
  /** Provenance tier — drives the badge. */
  kind: 'worldview'
  /** The image URL itself. */
  url: string
  /** Attribution shown on the card and stored in curator memory —
   *  Worldview imagery is public domain but credit is good manners. */
  attribution: string
}

/** Daily global true-color — available for any date since 2000 and
 *  the closest thing to "what you'd have seen from space". */
export const WORLDVIEW_SNAPSHOT_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'

const SNAPSHOT_HOST = 'https://wvs.earthdata.nasa.gov/api/v1/snapshot'
const SNAPSHOT_WIDTH = 768
/** Padding around a point event, degrees — wide enough for context
 *  (a hurricane, a fire complex), tight enough to still be "there". */
const POINT_PAD_DEG = 5
/** Minimum bbox span, degrees — a very tight bbox snapshots to noise. */
const MIN_SPAN_DEG = 2

const clampLat = (v: number): number => Math.max(-90, Math.min(90, v))
const clampLon = (v: number): number => Math.max(-180, Math.min(180, v))

/**
 * Build the Worldview snapshot candidate for an event, or null when
 * the event lacks what a snapshot needs (a date and a location).
 */
export function buildWorldviewSnapshot(event: {
  occurredStart?: string
  source?: { publishedAt?: string }
  geometry?: EventGeometry
}): MediaSuggestion | null {
  const rawDate = event.occurredStart ?? event.source?.publishedAt
  const ms = rawDate ? Date.parse(rawDate) : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms).toISOString().slice(0, 10)

  let n: number, s: number, w: number, e: number
  const bbox = event.geometry?.boundingBox
  const point = event.geometry?.point
  if (bbox) {
    n = clampLat(bbox.n)
    s = clampLat(bbox.s)
    w = clampLon(bbox.w)
    e = clampLon(bbox.e)
    // Grow degenerate boxes to a visible span around their centre.
    if (n - s < MIN_SPAN_DEG) {
      const mid = (n + s) / 2
      n = clampLat(mid + MIN_SPAN_DEG / 2)
      s = clampLat(mid - MIN_SPAN_DEG / 2)
    }
    if (e - w < MIN_SPAN_DEG) {
      const mid = (e + w) / 2
      e = clampLon(mid + MIN_SPAN_DEG / 2)
      w = clampLon(mid - MIN_SPAN_DEG / 2)
    }
  } else if (point) {
    n = clampLat(point.lat + POINT_PAD_DEG)
    s = clampLat(point.lat - POINT_PAD_DEG)
    w = clampLon(point.lon - POINT_PAD_DEG)
    e = clampLon(point.lon + POINT_PAD_DEG)
  } else {
    // Region-only events resolve to a bbox at ingest; an event with
    // neither has nowhere to point a snapshot.
    return null
  }
  if (n <= s || e <= w) return null

  const height = Math.max(
    192,
    Math.min(SNAPSHOT_WIDTH, Math.round((SNAPSHOT_WIDTH * (n - s)) / (e - w))),
  )
  const params = new URLSearchParams({
    REQUEST: 'GetSnapshot',
    TIME: date,
    // EPSG:4326 axis order: lat_min, lon_min, lat_max, lon_max.
    BBOX: `${s},${w},${n},${e}`,
    CRS: 'EPSG:4326',
    LAYERS: WORLDVIEW_SNAPSHOT_LAYER,
    WIDTH: String(SNAPSHOT_WIDTH),
    HEIGHT: String(height),
    FORMAT: 'image/jpeg',
  })
  return {
    kind: 'worldview',
    url: `${SNAPSHOT_HOST}?${params.toString()}`,
    attribution: 'NASA Worldview / GIBS', // i18n-exempt: proper noun attribution
  }
}
