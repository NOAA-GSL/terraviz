import { describe, it, expect } from 'vitest'
import { mapEonetEvent, mapEonetFeed, EONET_FEED_ID, EONET_SOURCE_NAME } from './eonet'

const POINT_EVENT = {
  id: 'EONET_6001',
  title: 'Hurricane Lena',
  description: 'A category 4 storm.',
  link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_6001',
  categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
  sources: [{ id: 'GDACS', url: 'https://gdacs.org/report/EONET_6001' }],
  geometry: [
    { date: '2026-06-24T00:00:00Z', type: 'Point', coordinates: [-88, 28] },
    { date: '2026-06-25T00:00:00Z', type: 'Point', coordinates: [-89, 29] },
  ],
}

describe('mapEonetEvent', () => {
  it('maps a point event with provenance, time span, and geometry', () => {
    const body = mapEonetEvent(POINT_EVENT)!
    expect(body.externalId).toBe('EONET_6001')
    expect(body.feedId).toBe(EONET_FEED_ID)
    expect(body.title).toBe('Hurricane Lena')
    expect(body.summary).toBe('A category 4 storm.')
    expect(body.source).toEqual({
      name: EONET_SOURCE_NAME,
      url: 'https://gdacs.org/report/EONET_6001',
      publishedAt: '2026-06-24T00:00:00Z',
    })
    // Latest geometry drives the location.
    expect(body.geometry).toEqual({ point: { lat: 29, lon: -89 } })
    expect(body.occurredStart).toBe('2026-06-24T00:00:00Z')
    expect(body.occurredEnd).toBe('2026-06-25T00:00:00Z')
    expect(body.categories).toEqual({ EONET: ['Severe Storms'] })
    expect(body.keywords).toEqual(['severeStorms'])
  })

  it('falls back to the EONET link when there is no source url', () => {
    const body = mapEonetEvent({ ...POINT_EVENT, sources: [] })!
    expect(body.source.url).toBe('https://eonet.gsfc.nasa.gov/api/v3/events/EONET_6001')
  })

  it('computes a bounding box for a polygon geometry', () => {
    const body = mapEonetEvent({
      ...POINT_EVENT,
      geometry: [
        { date: '2026-06-25T00:00:00Z', type: 'Polygon', coordinates: [[[-100, 20], [-100, 30], [-80, 30], [-80, 20], [-100, 20]]] },
      ],
    })!
    expect(body.geometry).toEqual({ boundingBox: { n: 30, s: 20, w: -100, e: -80 } })
  })

  it('returns null when id / title / geometry / source are missing', () => {
    expect(mapEonetEvent({ title: 'x', geometry: POINT_EVENT.geometry })).toBeNull() // no id
    expect(mapEonetEvent({ id: 'x', geometry: POINT_EVENT.geometry })).toBeNull() // no title
    expect(mapEonetEvent({ id: 'x', title: 'y', geometry: [] })).toBeNull() // no geometry
    expect(mapEonetEvent({ id: 'x', title: 'y', geometry: POINT_EVENT.geometry, sources: [], link: undefined })).toBeNull() // no source
  })
})

describe('mapEonetFeed', () => {
  it('maps an array of events and drops the unmappable ones', () => {
    const out = mapEonetFeed({ events: [POINT_EVENT, { id: 'bad' }] })
    expect(out).toHaveLength(1)
    expect(out[0].externalId).toBe('EONET_6001')
  })

  it('tolerates a missing events array', () => {
    expect(mapEonetFeed({})).toEqual([])
  })
})
