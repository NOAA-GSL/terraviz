// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  AUTO_PAIR_THRESHOLD,
  compositePercent,
  autoPairTargets,
  scenarioFamily,
  locatorPoint,
  primaryCategory,
  applyQueueQuery,
  bestMatchScore,
  categoryOptions,
  emptyQueueQuery,
  isQueueFiltered,
  matchesQueueQuery,
  pendingLinkCount,
  sourceOptions,
  type QueueQuery,
  type ReviewEvent,
  type ReviewLink,
} from './events-model'

function link(over: Partial<ReviewLink>): ReviewLink {
  return { datasetId: 'd', datasetTitle: 'D', score: 0.9, signals: null, status: 'proposed', ...over }
}

describe('compositePercent', () => {
  it('scales 0–1 score to a whole percent, null passes through', () => {
    expect(compositePercent(link({ score: 0.91 }))).toBe(91)
    expect(compositePercent(link({ score: null }))).toBeNull()
  })
})

describe('scenarioFamily', () => {
  it('groups scenario variants of one field', () => {
    expect(scenarioFamily('Climate Model - Sea Ice Concentration: SSP1 (Low)')).toBe(
      'Climate Model - Sea Ice Concentration',
    )
    expect(scenarioFamily('Climate Model - Sea Ice Concentration: SSP5 (Very High)')).toBe(
      'Climate Model - Sea Ice Concentration',
    )
    expect(scenarioFamily('Air Temperature RCP8.5')).toBe('Air Temperature')
  })

  it('leaves distinct members of a titled series alone', () => {
    // The reason this is scenario-specific rather than colon-based: these
    // are eight different tsunamis, not one field under three scenarios.
    expect(scenarioFamily('Tsunami Historical Series: Chile - 1960')).toBeNull()
    expect(scenarioFamily('Tsunami Historical Series: Japan - 2011')).toBeNull()
    expect(scenarioFamily('Solar Eclipse Paths and Cloud Fractions: April')).toBeNull()
    expect(scenarioFamily('Exoplanet: Kepler-10b')).toBeNull()
    expect(scenarioFamily('Sea Surface Temperature - Real-time')).toBeNull()
  })

  it('handles absent and degenerate titles', () => {
    expect(scenarioFamily(null)).toBeNull()
    expect(scenarioFamily(undefined)).toBeNull()
    expect(scenarioFamily('')).toBeNull()
    // A title that is *only* a scenario has no stem to group on.
    expect(scenarioFamily('SSP2 (Moderate)')).toBeNull()
  })
})

describe('autoPairTargets scenario dedupe', () => {
  const family = (suffix: string, score: number, datasetId: string) =>
    link({ datasetId, score, datasetTitle: `Climate Model - Sea Ice Concentration: ${suffix}` })

  it('pairs only the best-scoring variant of a family', () => {
    const event = {
      links: [
        family('SSP2 (Moderate)', 0.93, 'ssp2'),
        family('SSP5 (Very High)', 0.95, 'ssp5'),
        family('SSP1 (Low)', 0.91, 'ssp1'),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['ssp5'])
  })

  it('keeps unrelated links and separate families intact', () => {
    const event = {
      links: [
        family('SSP2 (Moderate)', 0.93, 'ice2'),
        family('SSP5 (Very High)', 0.95, 'ice5'),
        link({ datasetId: 'smoke', score: 0.94, datasetTitle: 'Global Smoke Forecast' }),
        link({ datasetId: 'precip5', score: 0.92, datasetTitle: 'Climate Model - Precipitation Change: SSP5 (Very High)' }),
        link({ datasetId: 'precip1', score: 0.91, datasetTitle: 'Climate Model - Precipitation Change: SSP1 (Low)' }),
      ],
    }
    // One per family, plus the unrelated dataset, in input order.
    expect(autoPairTargets(event)).toEqual(['ice5', 'smoke', 'precip5'])
  })

  it('breaks a tie on dataset id so the pick is stable', () => {
    const event = {
      links: [family('SSP5 (Very High)', 0.93, 'zulu'), family('SSP1 (Low)', 0.93, 'alpha')],
    }
    expect(autoPairTargets(event)).toEqual(['alpha'])
  })

  it('does not dedupe variants that fall below the threshold', () => {
    // Below the bar nothing pairs, deduped or not.
    const event = { links: [family('SSP5 (Very High)', 0.5, 'a'), family('SSP1 (Low)', 0.4, 'b')] }
    expect(autoPairTargets(event)).toEqual([])
  })

  it('never groups distinct members of a titled series', () => {
    const event = {
      links: [
        link({ datasetId: 'chile', score: 0.95, datasetTitle: 'Tsunami Historical Series: Chile - 1960' }),
        link({ datasetId: 'japan', score: 0.94, datasetTitle: 'Tsunami Historical Series: Japan - 2011' }),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['chile', 'japan'])
  })
})

describe('autoPairTargets', () => {
  it('selects only still-proposed links at or above the threshold', () => {
    const event = {
      links: [
        link({ datasetId: 'strong', score: 0.98, status: 'proposed' }), // ✓ 98
        link({ datasetId: 'exactly', score: AUTO_PAIR_THRESHOLD / 100, status: 'proposed' }), // ✓ exactly at the bar
        link({ datasetId: 'mid', score: 0.68, status: 'proposed' }), // ✗ below
        link({ datasetId: 'already', score: 0.99, status: 'approved' }), // ✗ not proposed
        link({ datasetId: 'noscore', score: null, status: 'proposed' }), // ✗ null
      ],
    }
    expect(autoPairTargets(event)).toEqual(['strong', 'exactly'])
  })

  it('honours a custom threshold', () => {
    const event = { links: [link({ datasetId: 'a', score: 0.7 }), link({ datasetId: 'b', score: 0.5 })] }
    expect(autoPairTargets(event, 60)).toEqual(['a'])
  })

  it('compares the raw score, not the rounded display percent', () => {
    // Half a display-point under the bar rounds *to* the bar but must
    // not clear it. Derived from the constant rather than written out:
    // the property holds at any threshold, and hardcoding the numbers
    // is what coupled this test to 90 and broke it when the bar moved.
    const bar = AUTO_PAIR_THRESHOLD / 100
    const event = {
      links: [
        link({ datasetId: 'justUnder', score: bar - 0.005, status: 'proposed' }),
        link({ datasetId: 'justOver', score: bar + 0.005, status: 'proposed' }),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['justOver'])
  })
})

describe('locatorPoint', () => {
  it('prefers an explicit point', () => {
    expect(locatorPoint({ point: { lat: 46.4, lon: -117.2 } })).toEqual({ lat: 46.4, lon: -117.2 })
  })
  it('falls back to the bbox centre', () => {
    expect(locatorPoint({ boundingBox: { n: 10, s: 0, w: -20, e: 0 } })).toEqual({ lat: 5, lon: -10 })
  })
  it('returns null for region-only or missing geometry', () => {
    expect(locatorPoint({ regionName: 'Arctic' })).toBeNull()
    expect(locatorPoint(undefined)).toBeNull()
  })
})

describe('primaryCategory', () => {
  it('returns the first value of the first facet group', () => {
    expect(primaryCategory({ categories: { Wildfires: ['Fire', 'Smoke'] } })).toBe('Fire')
  })
  it('returns null when uncategorised', () => {
    expect(primaryCategory({ categories: {} })).toBeNull()
    expect(primaryCategory({})).toBeNull()
  })
})

function ev(id: string, over: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id,
    title: `Event ${id}`,
    source: { name: 'NASA EONET', url: 'https://example.gov/' + id },
    status: 'proposed',
    links: [],
    ...over,
  }
}

function q(over: Partial<QueueQuery> = {}): QueueQuery {
  return { ...emptyQueueQuery(), ...over }
}

const ids = (events: readonly ReviewEvent[]): string[] => events.map(e => e.id)

describe('matchesQueueQuery — text', () => {
  const fire = ev('A', {
    title: 'Wildfire near São Paulo',
    summary: 'Smoke over the city.',
    keywords: ['smoke', 'air quality'],
    categories: { EONET: ['Wildfires'] },
    geometry: { regionName: 'South America' },
  })

  it('matches the title, summary, keywords, categories, source and place', () => {
    for (const text of ['wildfire', 'smoke over', 'air quality', 'wildfires', 'eonet', 'south america']) {
      expect(matchesQueueQuery(fire, q({ text })), text).toBe(true)
    }
  })

  it('ignores case and accents in both directions', () => {
    expect(matchesQueueQuery(fire, q({ text: 'SAO PAULO' }))).toBe(true)
    expect(matchesQueueQuery(ev('B', { title: 'Sao Paulo floods' }), q({ text: 'São' }))).toBe(true)
  })

  it('requires every term, in any order', () => {
    expect(matchesQueueQuery(fire, q({ text: 'smoke wildfire' }))).toBe(true)
    expect(matchesQueueQuery(fire, q({ text: 'smoke hurricane' }))).toBe(false)
  })

  it('treats a blank search as no search', () => {
    expect(matchesQueueQuery(fire, q({ text: '   ' }))).toBe(true)
  })

  it('does not match on linked dataset titles', () => {
    // The matcher pairs datasets broadly; searching their titles would
    // return most of the queue for any common field name.
    const paired = ev('C', {
      links: [{ datasetId: 'd', datasetTitle: 'Sea Surface Temperature', score: 0.9, signals: null, status: 'proposed' }],
    })
    expect(matchesQueueQuery(paired, q({ text: 'temperature' }))).toBe(false)
  })
})

describe('matchesQueueQuery — source and category', () => {
  const eonet = ev('A', { categories: { EONET: ['Wildfires', 'Volcanoes'] } })
  const news = ev('B', { source: { name: 'NOAA News', url: 'https://example.gov/b' } })

  it('filters on the exact source name', () => {
    expect(matchesQueueQuery(eonet, q({ source: 'NASA EONET' }))).toBe(true)
    expect(matchesQueueQuery(news, q({ source: 'NASA EONET' }))).toBe(false)
  })

  it('filters on any category value, whatever its facet group', () => {
    expect(matchesQueueQuery(eonet, q({ category: 'Volcanoes' }))).toBe(true)
    // The group key is not a category a curator picks.
    expect(matchesQueueQuery(eonet, q({ category: 'EONET' }))).toBe(false)
    expect(matchesQueueQuery(news, q({ category: 'Wildfires' }))).toBe(false)
  })

  it('combines text, source and category', () => {
    expect(matchesQueueQuery(eonet, q({ text: 'event a', source: 'NASA EONET', category: 'Wildfires' }))).toBe(true)
    expect(matchesQueueQuery(eonet, q({ text: 'event b', source: 'NASA EONET', category: 'Wildfires' }))).toBe(false)
  })
})

describe('isQueueFiltered', () => {
  it('is true for text, source or category, never for sort alone', () => {
    expect(isQueueFiltered(q())).toBe(false)
    expect(isQueueFiltered(q({ sort: 'bestMatch' }))).toBe(false)
    expect(isQueueFiltered(q({ text: ' ' }))).toBe(false)
    expect(isQueueFiltered(q({ text: 'x' }))).toBe(true)
    expect(isQueueFiltered(q({ source: 'NOAA' }))).toBe(true)
    expect(isQueueFiltered(q({ category: 'Wildfires' }))).toBe(true)
  })
})

describe('bestMatchScore / pendingLinkCount', () => {
  it('takes the highest raw score, skipping rejected and unscored pairings', () => {
    const e = ev('A', {
      links: [
        link({ score: 0.95, status: 'rejected' }),
        link({ score: 0.7, status: 'approved' }),
        link({ score: 0.6 }),
        link({ score: null }),
      ],
    })
    expect(bestMatchScore(e)).toBe(0.7)
    expect(bestMatchScore(ev('B'))).toBeNull()
  })

  it('counts only pairings still awaiting a decision', () => {
    const e = ev('A', { links: [link({}), link({ status: 'approved' }), link({ status: 'rejected' }), link({})] })
    expect(pendingLinkCount(e)).toBe(2)
  })
})

describe('applyQueueQuery — sorting', () => {
  // Server order: newest first.
  const events = [
    ev('A', { links: [link({ score: 0.5 })] }),
    ev('B', { links: [link({ score: 0.9 }), link({}), link({})] }),
    ev('C'),
    ev('D', { links: [link({ score: 0.9 })] }),
  ]

  it('keeps the server order for newest and reverses it for oldest', () => {
    expect(ids(applyQueueQuery(events, q()))).toEqual(['A', 'B', 'C', 'D'])
    expect(ids(applyQueueQuery(events, q({ sort: 'oldest' })))).toEqual(['D', 'C', 'B', 'A'])
  })

  it('puts the strongest match first, unscored last, ties in server order', () => {
    expect(ids(applyQueueQuery(events, q({ sort: 'bestMatch' })))).toEqual(['B', 'D', 'A', 'C'])
  })

  it('puts the most pairings to review first, ties in server order', () => {
    expect(ids(applyQueueQuery(events, q({ sort: 'mostToReview' })))).toEqual(['B', 'A', 'D', 'C'])
  })

  it('sorts only what the filter kept, and leaves its input alone', () => {
    const input = [...events]
    const out = applyQueueQuery(input, q({ text: 'event b', sort: 'oldest' }))
    expect(ids(out)).toEqual(['B'])
    expect(ids(input)).toEqual(['A', 'B', 'C', 'D'])
  })
})

describe('sourceOptions / categoryOptions', () => {
  const events = [
    ev('A', { categories: { EONET: ['Wildfires'] } }),
    ev('B', { categories: { EONET: ['Wildfires', 'Severe Storms'] } }),
    ev('C', { source: { name: 'NOAA News', url: 'https://example.gov/c' } }),
    ev('D', { source: { name: 'BBC Science', url: 'https://example.gov/d' } }),
  ]

  it('lists each source once with its count, most common first then by name', () => {
    expect(sourceOptions(events)).toEqual([
      { value: 'NASA EONET', count: 2 },
      { value: 'BBC Science', count: 1 },
      { value: 'NOAA News', count: 1 },
    ])
  })

  it('lists category values across groups, an event counted once per value', () => {
    expect(categoryOptions(events)).toEqual([
      { value: 'Wildfires', count: 2 },
      { value: 'Severe Storms', count: 1 },
    ])
    expect(categoryOptions([ev('X', { categories: { a: ['Fire'], b: ['Fire'] } })])).toEqual([
      { value: 'Fire', count: 1 },
    ])
  })
})
