/**
 * Catalog API fixtures for the smoke tests.
 *
 * The catalog browse surface (`/?catalog=true`) boots from this
 * deployment's `/api/v1/catalog` (+ `/api/v1/tours`). On a CI dev
 * server there is no Pages Functions backend, so those paths return the
 * bundled `index.html` — HTML that fails JSON parse, leaving the
 * catalog empty and `#browse-overlay` hidden. The smoke catalog checks
 * then race a never-arriving grid against the 30s locator timeout and
 * flake.
 *
 * Stubbing the two endpoints makes the browse overlay populate
 * deterministically. Two of the four datasets carry "Ocean" in the
 * title so the search-narrowing assertion (search "ocean" → strictly
 * fewer cards) is stable. See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { FixtureRule } from '../core/fixtures'
// Type-only import — erased at runtime, so no SPA runtime code (i18n,
// logger) is pulled into the node capture scripts.
import type { PublicEvent } from '../../../src/services/eventsService'

/** Minimal subset of the `/api/v1/catalog` wire shape the SPA consumes. */
interface WireDatasetFixture {
  id: string
  title: string
  format: string
  dataLink: string
  organization?: string
  abstractTxt?: string
  tags?: string[]
  boundingBox?: { n: number; s: number; w: number; e: number }
}

const WORLDWIDE = { n: 90, s: -90, w: -180, e: 180 }

const DATASETS: WireDatasetFixture[] = [
  {
    id: 'INTERNAL_OCEAN_SST',
    title: 'Ocean Surface Temperature',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Sea surface temperature across the global ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_OCEAN_CURRENTS',
    title: 'Ocean Surface Currents',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Surface currents across the world ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_ATMO_CO2',
    title: 'Atmospheric Carbon Dioxide',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Global atmospheric carbon dioxide concentration.',
    tags: ['Atmosphere'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_LAND_NDVI',
    title: 'Vegetation Index',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Land vegetation greenness from satellite.',
    tags: ['Land'],
    boundingBox: WORLDWIDE,
  },
]

/** Route-stub rules for the catalog + tours endpoints. */
export function catalogFixtures(): FixtureRule[] {
  return [
    { url: '/api/v1/catalog', json: { datasets: DATASETS } },
    { url: '/api/v1/tours', json: { tours: [] } },
  ]
}

/** One approved current event linked to a fixture dataset — typed
 *  against the SPA's own wire shape so drift is caught at type-check,
 *  and the catalog Map / Timeline event overlays render (and diff)
 *  deterministically. */
const EVENT: PublicEvent = {
  id: '01HFIXTUREEVENT000000001',
  title: 'Marine heatwave develops in the North Pacific',
  summary: 'Sea surface temperatures are running well above average across the basin.',
  source: { name: 'Example Science Desk', url: 'https://news.example.org/heatwave', publishedAt: '2026-06-20T12:00:00.000Z' },
  occurredStart: '2026-06-18T00:00:00.000Z',
  geometry: { point: { lat: 40, lon: -150 } },
  datasetIds: ['INTERNAL_OCEAN_SST'],
}

/**
 * The full fixture set for **visual-report** SPA scenes.
 *
 * The catalog scenes used to capture the *live* production catalog
 * (the dev server proxies `/api` upstream), so every content change or
 * slow thumbnail diffed against the baseline — the report's residual
 * churn after the globe backdrop was stabilised. This pins every
 * content endpoint the SPA reads on boot; the trailing catch-all lets
 * everything else (the GIBS tile proxy, telemetry ingest) through so
 * those behave exactly as before.
 */
export function catalogReportFixtures(): FixtureRule[] {
  return [
    ...catalogFixtures(),
    { url: '/api/v1/featured-event', json: { event: null } },
    // The hero's operator-override read (`heroService.backendUrl()`) —
    // `{ hero: null }` is the endpoint's documented no-override shape.
    { url: '/api/v1/featured-hero', json: { hero: null } },
    { url: '/api/v1/events', json: { events: [EVENT] } },
    // Orbit settings' model dropdown — a fixed list, not the live
    // provider's.
    { url: '/api/models', json: { data: [{ id: 'llama-3.1-70b' }] } },
    { url: '/api/', passthrough: true },
  ]
}
