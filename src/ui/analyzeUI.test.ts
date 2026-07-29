/**
 * Tests for the Analyze panel and its CSV export.
 *
 * The panel is thin — the arithmetic lives in `datasetStats` and is
 * tested there — so these cover the parts that only exist here: that a
 * region choice actually narrows the window, that the empty states are
 * distinguishable (nothing loaded / outside coverage / no data in
 * region are three different answers and reading one for another sends
 * a user looking for the wrong problem), and that the export carries
 * enough context to be falsifiable later.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  closeAnalyzeUI,
  currentResult,
  initAnalyzeUI,
  isAnalyzeUIOpen,
  notifyAnalyzeDatasetChanged,
  openAnalyzeUI,
  type AnalyzeSource,
} from './analyzeUI'
import { buildCsvText, downloadCsv } from './analyzeExport'
import { buildHistogram, summarize } from '../services/datasetStats'
import { resolveRegion } from '../data/regions'
import { DEFAULT_DISPLAY } from '../services/colorScaleDisplay'
import type { LumaSnapshot } from '../services/glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [255, 255, 229, 0] },
    { t: 1, rgba: [102, 37, 6, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** The bbox the live RRFS rows carry. */
const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
  colorScale: SCALE,
}

function snap(w: number, h: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return { data, width: w, height: h }
}

function makeSource(over: Partial<AnalyzeSource> = {}): AnalyzeSource {
  return {
    frame: () => ({ snapshot: snap(8, 8, () => 200), scale: SCALE, options: OPTIONS }),
    visibleBounds: () => ({ n: 85, s: 5, w: -175, e: -20 }),
    display: () => DEFAULT_DISPLAY,
    datasetTitle: () => 'Wildfire Smoke Overhead',
    datasetId: () => 'INTERNAL_SMOKE_COLUMN',
    ...over,
  }
}

const select = () => document.getElementById('analyze-scope-select') as HTMLSelectElement
const bodyText = () => document.querySelector('.analyze-body')?.textContent ?? ''

beforeEach(() => {
  closeAnalyzeUI()
  document.body.innerHTML = ''
})

describe('openAnalyzeUI', () => {
  it('computes against the current frame on open', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    expect(isAnalyzeUIOpen()).toBe(true)
    expect(currentResult()?.mean).toBeCloseTo(200, 6)
    expect(document.querySelector('.analyze-histogram')).not.toBeNull()
    expect(document.querySelectorAll('.analyze-stat')).toHaveLength(8)
  })

  it('states the quantisation step next to the numbers, not in a footnote', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const note = document.querySelector('.analyze-precision')?.textContent ?? ''
    // 255 over 255 codes is a step of 1.
    expect(note).toContain('1')
    expect(note).toContain('mg m-2')
  })

  it('reports coverage, so a mean over 3% of a box is not read as a mean over all of it', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({
        // One data texel in sixteen; the rest absent.
        snapshot: snap(4, 4, (x, y) => (x === 0 && y === 0 ? 200 : 0)),
        scale: SCALE,
        options: OPTIONS,
      }),
    }))
    openAnalyzeUI()
    expect(currentResult()?.coverage).toBeCloseTo(0.0625, 6)
    expect(document.querySelector('.analyze-coverage')?.textContent).toContain('6.3')
  })

  it('closes on Escape and on the close button', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(isAnalyzeUIOpen()).toBe(false)

    openAnalyzeUI()
    ;(document.querySelector('.analyze-close') as HTMLButtonElement).click()
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('replaces an already-open panel rather than stacking', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    openAnalyzeUI()
    expect(document.querySelectorAll('.analyze-panel')).toHaveLength(1)
  })
})

describe('empty states', () => {
  it('distinguishes "no data-encoded dataset" from a computed result', () => {
    initAnalyzeUI(makeSource({ frame: () => null }))
    openAnalyzeUI()
    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-message')).not.toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })

  it('says the region misses the dataset rather than showing zeroes', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    select().value = 'view'
    // A view far south of the 5°N bottom edge.
    initAnalyzeUI(makeSource({ visibleBounds: () => ({ n: -30, s: -60, w: -100, e: -50 }) }))
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()).toBeNull()
    expect(bodyText()).not.toBe('')
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })

  it('says a region carries no values when every texel there is absent', () => {
    initAnalyzeUI(makeSource({
      frame: () => ({ snapshot: snap(4, 4, () => 0), scale: SCALE, options: OPTIONS }),
    }))
    openAnalyzeUI()
    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
  })
})

describe('region scope', () => {
  it('offers the whole dataset, the current view, and named regions', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const values = [...select().options].map((o) => o.value)
    expect(values.slice(0, 2)).toEqual(['dataset', 'view'])
    expect(values.filter((v) => v.startsWith('named:')).length).toBeGreaterThan(0)
  })

  it('narrows the result when the region shrinks', () => {
    // North half hot, south half cool. Restricting to the north half
    // must raise the mean above the whole-dataset value.
    initAnalyzeUI(makeSource({
      frame: () => ({
        snapshot: snap(8, 8, (_x, y) => (y < 4 ? 240 : 40)),
        scale: SCALE,
        options: OPTIONS,
      }),
      visibleBounds: () => ({ n: 85, s: 45, w: -175, e: -20 }),
    }))
    openAnalyzeUI()
    const whole = currentResult()!.mean

    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()!.mean).toBeGreaterThan(whole)
    expect(currentResult()!.mean).toBeCloseTo(240, 6)
  })

  it('falls back to the whole dataset when the view is unknown', () => {
    initAnalyzeUI(makeSource({ visibleBounds: () => null }))
    openAnalyzeUI()
    select().value = 'view'
    select().dispatchEvent(new Event('change', { bubbles: true }))
    expect(currentResult()?.mean).toBeCloseTo(200, 6)
  })
})

describe('buildCsvText', () => {
  const s = snap(4, 4, (x) => (x < 2 ? 100 : 200))
  const stats = summarize(s, SCALE, OPTIONS)!
  const hist = buildHistogram(s, SCALE, OPTIONS)

  it('records what the numbers are of', () => {
    const csv = buildCsvText(stats, hist, SCALE, {
      datasetTitle: 'Wildfire Smoke Overhead', scopeLabel: 'dataset',
    })
    expect(csv).toContain('dataset,Wildfire Smoke Overhead')
    expect(csv).toContain('units,mg m-2')
    expect(csv).toContain('quantisation_step,1')
  })

  it('carries the distribution, not just the summary', () => {
    const csv = buildCsvText(stats, hist, SCALE, { datasetTitle: null, scopeLabel: 'dataset' })
    expect(csv).toContain('value,area_km2,texel_count')
    // Exactly the two occupied bins, and no rows for absent codes.
    const bins = csv.split('value,area_km2,texel_count\r\n')[1].trim().split('\r\n')
    expect(bins).toHaveLength(2)
    expect(bins[0].startsWith('100,')).toBe(true)
    expect(bins[1].startsWith('200,')).toBe(true)
  })

  it('exports full precision, not the three digits the panel shows', () => {
    // The rounding on screen is a legibility choice; re-imposing it here
    // would destroy what the file exists to carry.
    const odd: ColorScale = { ...SCALE, vmin: 0, vmax: 1 / 3 }
    const csv = buildCsvText(
      summarize(s, odd, OPTIONS)!, buildHistogram(s, odd, OPTIONS), odd,
      { datasetTitle: null, scopeLabel: 'dataset' })
    expect(csv).toMatch(/mean,0\.\d{6,}/)
  })

  it('quotes only cells that need it, with CRLF line endings', () => {
    const csv = buildCsvText(stats, hist, SCALE, {
      datasetTitle: 'Smoke, column', scopeLabel: 'dataset',
    })
    expect(csv).toContain('"Smoke, column"')
    expect(csv).toContain('\r\n')
    expect(csv).toContain('units,mg m-2') // no gratuitous quoting
  })

  it('is downloadable without throwing when the DOM has no object URLs', () => {
    // happy-dom has no createObjectURL; the export must degrade rather
    // than take the click handler down with it.
    const original = URL.createObjectURL
    // @ts-expect-error — deliberately removing the API under test.
    URL.createObjectURL = undefined
    expect(() => downloadCsv('x.csv', 'a,b')).not.toThrow()
    URL.createObjectURL = original
  })
})

describe('export button', () => {
  it('serialises the numbers currently on screen', () => {
    const spy = vi.fn()
    const original = URL.createObjectURL
    URL.createObjectURL = spy.mockReturnValue('blob:x')
    URL.revokeObjectURL = () => {}
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    ;(document.querySelector('.analyze-export') as HTMLButtonElement).click()
    expect(spy).toHaveBeenCalled()
    URL.createObjectURL = original
  })
})

describe('region names that cannot be resolved', () => {
  // `getRegionNames` returns display names; `resolveRegion` looks up
  // lowercased aliases. At least one entry's display name is not among
  // its own aliases, so offering the raw list produced a region that
  // fell through to whole-dataset statistics wearing that region's
  // label — real numbers, wrong answer, no error.
  it('never offers a region it cannot locate', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    const named = [...select().options]
      .map((o) => o.value)
      .filter((v) => v.startsWith('named:'))
      .map((v) => v.slice(6))
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) {
      expect(resolveRegion(name), `"${name}" is offered but does not resolve`).not.toBeNull()
    }
  })

  it('says so rather than silently measuring everything', () => {
    initAnalyzeUI(makeSource())
    openAnalyzeUI()
    // Force the state directly: the picker no longer offers one, but
    // the regions table can change underneath it.
    const s = select()
    const opt = document.createElement('option')
    opt.value = 'named:Not A Real Place'
    s.appendChild(opt)
    s.value = 'named:Not A Real Place'
    s.dispatchEvent(new Event('change', { bubbles: true }))

    expect(currentResult()).toBeNull()
    expect(document.querySelector('.analyze-stats')).toBeNull()
    expect(document.querySelector('.analyze-message')).not.toBeNull()
  })
})

describe('the globe changing underneath the panel', () => {
  // The panel computes once, on open. Left open across a dataset swap
  // it showed a statistics table describing something no longer on
  // screen — every figure real, every figure about the wrong thing.
  // The old teardown only fired when *no* dataset carried a palette, so
  // swapping one data-encoded row for another kept it open.
  it('closes when a different dataset is loaded', () => {
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    expect(isAnalyzeUIOpen()).toBe(true)

    notifyAnalyzeDatasetChanged('SMOKE_NEAR_SURFACE')
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('stays open when the same dataset is re-announced', () => {
    // Re-announcing happens on layout changes and legend refreshes;
    // closing on those would make the panel unusable.
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    notifyAnalyzeDatasetChanged('SMOKE_COLUMN')
    expect(isAnalyzeUIOpen()).toBe(true)
  })

  it('closes when the dataset is unloaded entirely', () => {
    initAnalyzeUI(makeSource({ datasetId: () => 'SMOKE_COLUMN' }))
    openAnalyzeUI()
    notifyAnalyzeDatasetChanged(null)
    expect(isAnalyzeUIOpen()).toBe(false)
  })

  it('is inert when the panel is closed', () => {
    initAnalyzeUI(makeSource())
    expect(() => notifyAnalyzeDatasetChanged('ANYTHING')).not.toThrow()
    expect(isAnalyzeUIOpen()).toBe(false)
  })
})
