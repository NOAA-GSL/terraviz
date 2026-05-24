import { describe, it, expect } from 'vitest'
import {
  buildGraph,
  datasetNodeId,
  facetValueNodeId,
  keywordNodeId,
  topCoOccurrences,
  type GraphNode,
} from './catalogGraph'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'd1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    tags: ['Water'],
    ...overrides,
  }
}

describe('node ID helpers', () => {
  it('encodes facet-value IDs verbatim', () => {
    expect(facetValueNodeId('category', 'Water')).toBe('facet:category:Water')
    expect(facetValueNodeId('format', 'video')).toBe('facet:format:video')
  })

  it('lowercases keyword IDs so casing variants collapse', () => {
    expect(keywordNodeId('Hurricane')).toBe('keyword:hurricane')
    expect(keywordNodeId('HURRICANE')).toBe('keyword:hurricane')
  })

  it('namespaces dataset IDs', () => {
    expect(datasetNodeId('abc-123')).toBe('dataset:abc-123')
  })
})

describe('buildGraph — baseline shape', () => {
  it('emits one dataset node per filtered row plus category + format nodes', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'image/jpeg' }),
      makeDataset({ id: 'd3', tags: ['Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})

    const datasetNodes = graph.nodes.filter(n => n.kind === 'dataset')
    expect(datasetNodes).toHaveLength(3)
    expect(datasetNodes.map(n => n.id).sort()).toEqual([
      'dataset:d1', 'dataset:d2', 'dataset:d3',
    ])

    const categoryNodes = graph.nodes
      .filter((n): n is Extract<GraphNode, { kind: 'facet-value'; facet: string }> =>
        n.kind === 'facet-value' && n.facet === 'category')
    expect(categoryNodes.map(n => n.value).sort()).toEqual(['Land', 'Water'])

    const formatNodes = graph.nodes
      .filter((n): n is Extract<GraphNode, { kind: 'facet-value'; facet: string }> =>
        n.kind === 'facet-value' && n.facet === 'format')
    expect(formatNodes.map(n => n.value).sort()).toEqual(['image', 'video'])

    expect(graph.filteredDatasetCount).toBe(3)
  })

  it('counts memberships correctly per facet-value node', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Water'] }),
      makeDataset({ id: 'd3', tags: ['Water'] }),
      makeDataset({ id: 'd4', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {})
    const waterNode = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Water'))
    const landNode = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Land'))
    expect(waterNode?.datasetCount).toBe(3)
    expect(landNode?.datasetCount).toBe(1)
  })

  it('assigns the right facet group / colour key to each node', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    const category = graph.nodes.find(n => n.id === facetValueNodeId('category', 'Water'))
    const format = graph.nodes.find(n => n.id === facetValueNodeId('format', 'video'))
    const dataset = graph.nodes.find(n => n.kind === 'dataset')
    expect(category?.group).toBe('category-content')
    expect(format?.group).toBe('format-medium')
    expect(dataset?.group).toBeNull()
  })

  it('emits a membership edge per (dataset, facet-value) pair', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Air'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    const membershipEdges = graph.edges.filter(e => e.kind === 'membership')
    // d1 attaches to: category:Water, category:Air, format:video → 3 edges
    expect(membershipEdges).toHaveLength(3)
    const targets = new Set(membershipEdges.map(e => e.source + '->' + e.target))
    expect(targets.size).toBe(3) // no duplicates
  })

  it('respects filter state by passing it through to filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {
      category: { kind: 'multi-select', values: ['Water'] },
    })
    expect(graph.filteredDatasetCount).toBe(1)
    expect(graph.nodes.filter(n => n.kind === 'dataset').map(n => n.id))
      .toEqual(['dataset:d1'])
    // Land node shouldn't appear — no dataset in the filtered set carries it.
    expect(graph.nodes.find(n => n.id === facetValueNodeId('category', 'Land')))
      .toBeUndefined()
  })

  it('honours prefix search tokens via parseSearchQuery, like the chip rail', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const graph = buildGraph(datasets, {}, 'category:Water')
    expect(graph.filteredDatasetCount).toBe(1)
    expect(graph.nodes.find(n => n.id === 'dataset:d1')).toBeDefined()
    expect(graph.nodes.find(n => n.id === 'dataset:d2')).toBeUndefined()
  })

  it('excludes hidden datasets via filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Water'], isHidden: true }),
    ]
    const graph = buildGraph(datasets, {})
    expect(graph.filteredDatasetCount).toBe(1)
  })
})

describe('buildGraph — co-occurrence', () => {
  it('emits one co-occurrence edge per (category, format) pair above the weight floor', () => {
    // 3 Water+video → weight 3; 1 Water+image → weight 1 (dropped at default 2);
    // 2 Land+video → weight 2 (kept)
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd3', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd4', tags: ['Water'], format: 'image/jpeg' }),
      makeDataset({ id: 'd5', tags: ['Land'], format: 'video/mp4' }),
      makeDataset({ id: 'd6', tags: ['Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    const labelled = coOcc.map(e => ({
      pair: [e.source, e.target].sort().join('//'),
      weight: e.weight,
    }))
    expect(labelled).toContainEqual({
      pair: ['facet:category:Water', 'facet:format:video'].sort().join('//'),
      weight: 3,
    })
    expect(labelled).toContainEqual({
      pair: ['facet:category:Land', 'facet:format:video'].sort().join('//'),
      weight: 2,
    })
    // Water+image (weight 1) should be hidden at the default floor.
    expect(labelled.find(l => l.pair.includes('image'))).toBeUndefined()
  })

  it('honours minEdgeWeight = 1 to surface singletons', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water'], format: 'image/jpeg' }),
    ]
    const graph = buildGraph(datasets, {}, '', { minEdgeWeight: 1 })
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    expect(coOcc).toHaveLength(2) // Water-video, Water-image
  })

  it('only emits cross-facet co-occurrence (no Category↔Category)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Land'], format: 'video/mp4' }),
      makeDataset({ id: 'd2', tags: ['Water', 'Land'], format: 'video/mp4' }),
    ]
    const graph = buildGraph(datasets, {})
    const coOcc = graph.edges.filter(e => e.kind === 'co-occurrence')
    // Should emit Water↔video and Land↔video but NOT Water↔Land.
    expect(coOcc.every(e => {
      const isCategory = (id: string) => id.startsWith('facet:category:')
      const isFormat = (id: string) => id.startsWith('facet:format:')
      return (isCategory(e.source) && isFormat(e.target)) ||
             (isFormat(e.source) && isCategory(e.target))
    })).toBe(true)
  })
})

describe('buildGraph — keyword expansion', () => {
  it('does not emit keyword nodes by default', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['hurricane', 'storm'] },
      }),
    ]
    const graph = buildGraph(datasets, {})
    expect(graph.nodes.find(n => n.kind === 'keyword')).toBeUndefined()
  })

  it('emits keyword nodes connected to the parent facet-value when expanded', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        format: 'video/mp4',
        enriched: { keywords: ['hurricane', 'storm'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Water'],
        format: 'video/mp4',
        enriched: { keywords: ['hurricane'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywordNodes = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywordNodes.map(n => n.id).sort()).toEqual([
      'keyword:hurricane', 'keyword:storm',
    ])
    const hurricane = keywordNodes.find(n => n.id === 'keyword:hurricane')
    expect(hurricane?.datasetCount).toBe(2)
  })

  it('only expands keywords whose datasets overlap with the expanded parent', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['hurricane'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Land'],
        enriched: { keywords: ['drought'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywordNodes = graph.nodes.filter(n => n.kind === 'keyword')
    // Only `hurricane` should surface — `drought` lives under Land.
    expect(keywordNodes.map(n => n.id)).toEqual(['keyword:hurricane'])
  })

  it('falls back to tags when enriched.keywords is missing (mirrors keyword resolver)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }), // no enriched
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords.map(n => n.value)).toEqual(['Water'])
  })

  it('deduplicates keyword nodes by case-insensitive value', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        enriched: { keywords: ['Hurricane'] },
      }),
      makeDataset({
        id: 'd2',
        tags: ['Water'],
        enriched: { keywords: ['hurricane'] },
      }),
    ]
    const waterId = facetValueNodeId('category', 'Water')
    const graph = buildGraph(datasets, {}, '', {
      expandedKeywordParents: new Set([waterId]),
    })
    const keywords = graph.nodes.filter(n => n.kind === 'keyword')
    expect(keywords).toHaveLength(1)
    expect(keywords[0].datasetCount).toBe(2)
  })
})

describe('topCoOccurrences', () => {
  it('returns the highest-weight co-occurring nodes desc', () => {
    const datasets: Dataset[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDataset({
        id: `d${i}`, tags: ['Water'], format: 'video/mp4',
      })),
      ...Array.from({ length: 3 }, (_, i) => makeDataset({
        id: `e${i}`, tags: ['Water'], format: 'image/jpeg',
      })),
      ...Array.from({ length: 2 }, (_, i) => makeDataset({
        id: `f${i}`, tags: ['Water'], format: 'tour/json',
      })),
    ]
    const graph = buildGraph(datasets, {})
    const top = topCoOccurrences(graph, facetValueNodeId('category', 'Water'), 3)
    expect(top.map(t => t.neighbourId)).toEqual([
      facetValueNodeId('format', 'video'),
      facetValueNodeId('format', 'image'),
      facetValueNodeId('format', 'tour'),
    ])
    expect(top[0].weight).toBe(5)
  })

  it('respects the limit argument', () => {
    const datasets: Dataset[] = [
      ...Array.from({ length: 5 }, (_, i) => makeDataset({
        id: `d${i}`, tags: ['Water'], format: 'video/mp4',
      })),
      ...Array.from({ length: 3 }, (_, i) => makeDataset({
        id: `e${i}`, tags: ['Water'], format: 'image/jpeg',
      })),
    ]
    const graph = buildGraph(datasets, {})
    const top = topCoOccurrences(graph, facetValueNodeId('category', 'Water'), 1)
    expect(top).toHaveLength(1)
  })
})
