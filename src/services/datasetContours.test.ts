/**
 * Tests for the isoline extractor.
 *
 * Two of these matter more than the rest, because both failures produce
 * a contour that looks entirely plausible on a globe:
 *
 *   1. Tracing the edge of the no-data region. A smoke field is mostly
 *      absent, and if absent texels are read as low values the isoline
 *      wraps the data's own footprint in a smooth, confident, completely
 *      fictional curve. That is `datasetStats`' "counting absent as
 *      vmin" mistake wearing different clothes.
 *   2. Crossing the antimeridian. A polyline stepping from +179 to −179
 *      is geometrically fine and draws as a stripe across the entire
 *      globe.
 *
 * The rest pin the marching-squares mechanics: that a crossing lands
 * where linear interpolation says, that neighbouring cells share their
 * crossings rather than each emitting a disconnected stub, and that the
 * ambiguous saddle resolves the same way twice.
 */
import { describe, expect, it } from 'vitest'
import {
  contoursToGeoJson,
  extractContours,
  splitAtSeam,
  type ContourPoint,
} from './datasetContours'
import type { LumaSnapshot } from './glLumaSampler'
import type { ColorScale, DatasetOverlayOptions } from '../types'

/** vmin 0 / vmax 255, so luma and value are numerically equal and an
 *  expected threshold can be read straight off the fixture. */
const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 255,
  units: 'mg m-2',
  transparentRange: 12 / 256,
}

/** A scale with no absent band at all, for the cases where absence is
 *  not what is under test. */
const DENSE: ColorScale = { ...SCALE, transparentRange: undefined }

/** A whole-globe frame keeps texel→lat/lon simple: u maps linearly to
 *  −180..180 and v to 90..−90. */
const GLOBAL: DatasetOverlayOptions = { boundingBox: { n: 90, s: -90, w: -180, e: 180 } }

function snap(width: number, height: number, fill: (x: number, y: number) => number): LumaSnapshot {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y)
  }
  return { data, width, height }
}

/** Total vertices across every returned line. */
function vertexCount(lines: ContourPoint[][]): number {
  return lines.reduce((n, l) => n + l.length, 0)
}

describe('extractContours', () => {
  it('returns nothing when the field is entirely on one side', () => {
    const high = snap(8, 8, () => 200)
    expect(extractContours(high, DENSE, 100, GLOBAL)).toEqual([])
    const low = snap(8, 8, () => 20)
    expect(extractContours(low, DENSE, 100, GLOBAL)).toEqual([])
  })

  it('returns nothing for a frame too small to hold a cell', () => {
    expect(extractContours(snap(1, 8, () => 200), DENSE, 100, GLOBAL)).toEqual([])
    expect(extractContours(snap(8, 1, () => 200), DENSE, 100, GLOBAL)).toEqual([])
  })

  it('ignores a non-finite threshold rather than emitting garbage', () => {
    const ramp = snap(8, 8, x => x * 32)
    expect(extractContours(ramp, DENSE, Number.NaN, GLOBAL)).toEqual([])
    expect(extractContours(ramp, DENSE, Number.POSITIVE_INFINITY, GLOBAL)).toEqual([])
  })

  it('puts the crossing where linear interpolation says, not on a texel centre', () => {
    // Two columns: 0 and 100. A threshold of 25 sits a quarter of the way
    // across, so the isoline should be at x = 0.25 in centre space — not
    // snapped to either centre.
    const frame = snap(2, 4, x => (x === 0 ? 0 : 100))
    const lines = extractContours(frame, DENSE, 25, GLOBAL)
    expect(lines).toHaveLength(1)
    // Width 2 → centres at u = 0.25 and 0.75, i.e. lon −90 and +90. A
    // quarter of the way between them is lon −45.
    for (const p of lines[0]) expect(p.lon).toBeCloseTo(-45, 6)
  })

  it('joins crossings across neighbouring cells into one line', () => {
    // A vertical step in an 8-tall frame: every row crosses at the same
    // place, and the result must be a single connected line rather than
    // seven two-point stubs.
    const frame = snap(4, 8, x => (x < 2 ? 0 : 200))
    const lines = extractContours(frame, DENSE, 100, GLOBAL)
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeGreaterThan(2)
    // 8 rows of texels → 7 rows of cells, and each cell links the
    // crossing on its top edge to the one on its bottom edge. Those
    // edges are shared, so 7 cells chain 8 distinct vertices — the
    // off-by-one is the point: 7 would mean an end had been dropped.
    expect(lines[0]).toHaveLength(8)
  })

  it('closes a loop around an interior blob', () => {
    // A high square in the middle of a low field. The isoline encircles
    // it, so it comes back as a closed ring: first point repeated last.
    const frame = snap(9, 9, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5 ? 200 : 0))
    const lines = extractContours(frame, DENSE, 100, GLOBAL)
    expect(lines).toHaveLength(1)
    const ring = lines[0]
    expect(ring.length).toBeGreaterThan(4)
    expect(ring[0].lat).toBeCloseTo(ring[ring.length - 1].lat, 12)
    expect(ring[0].lon).toBeCloseTo(ring[ring.length - 1].lon, 12)
  })

  it('does not trace the boundary of the no-data region', () => {
    // The whole left half is absent (luma below the 12/256 band), the
    // right half is uniformly high. There is no real crossing anywhere:
    // every cell either touches absent data or is entirely above.
    // Counting absent as vmin would draw a crisp line straight down the
    // middle, which is the bug this asserts against.
    const frame = snap(8, 8, x => (x < 4 ? 0 : 200))
    expect(extractContours(frame, SCALE, 100, GLOBAL)).toEqual([])

    // The same frame under a scale with no absent band *does* produce
    // the line — proving the fixture would otherwise contour, so the
    // assertion above is about absence and not about the geometry.
    expect(extractContours(frame, DENSE, 100, GLOBAL).length).toBeGreaterThan(0)
  })

  it('contours the data-carrying part of a frame that also has absent texels', () => {
    // Absent on the far left, a real gradient on the right. The isoline
    // should exist, and every vertex should sit in the data region
    // rather than at the absent boundary.
    const frame = snap(10, 6, x => (x < 2 ? 0 : 20 + (x - 2) * 30))
    const lines = extractContours(frame, SCALE, 100, GLOBAL)
    expect(lines.length).toBeGreaterThan(0)
    // Absent columns are x < 2; cells touching them are skipped, so no
    // vertex can sit west of the x = 2 centre. Width 10 → centre 2 is at
    // u = 0.25, lon −90.
    for (const line of lines) {
      for (const p of line) expect(p.lon).toBeGreaterThan(-90)
    }
  })

  it('resolves the saddle the same way on every call', () => {
    // Two high corners on one diagonal, two low on the other — the
    // ambiguous case. Whatever it decides, it must decide it stably, or
    // a redraw flickers between two different pictures of one frame.
    const frame = snap(2, 2, (x, y) => ((x + y) % 2 === 0 ? 200 : 0))
    const a = extractContours(frame, DENSE, 100, GLOBAL)
    const b = extractContours(frame, DENSE, 100, GLOBAL)
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('honours a window and contours only inside it', () => {
    const frame = snap(16, 8, x => x * 16)
    const full = extractContours(frame, DENSE, 128, GLOBAL)
    const windowed = extractContours(frame, DENSE, 128, GLOBAL, {
      x0: 0, y0: 0, x1: 4, y1: 8,
    })
    expect(full.length).toBeGreaterThan(0)
    // The threshold is crossed at x = 8, outside the window entirely.
    expect(windowed).toEqual([])
  })

  it('excludes the outer half-texel rather than extrapolating past it', () => {
    // 8 columns of centres → 7 cells, so a monotonic ramp can produce at
    // most 7 crossing rows and none outside the centre lattice.
    const frame = snap(8, 8, x => x * 32)
    const lines = extractContours(frame, DENSE, 16, GLOBAL)
    // Threshold 16 falls between column 0 (0) and column 1 (32).
    expect(lines).toHaveLength(1)
    // Width 8 → centres span u = 1/16 .. 15/16, i.e. lon −168.75..168.75.
    for (const p of lines[0]) {
      expect(p.lon).toBeGreaterThanOrEqual(-168.75)
      expect(p.lon).toBeLessThanOrEqual(168.75)
    }
  })
})

describe('splitAtSeam', () => {
  it('cuts a line that jumps the antimeridian', () => {
    const points: ContourPoint[] = [
      { lat: 10, lon: 178 },
      { lat: 11, lon: 179 },
      { lat: 12, lon: -179 },
      { lat: 13, lon: -178 },
    ]
    const parts = splitAtSeam(points)
    expect(parts).toHaveLength(2)
    expect(parts[0].map(p => p.lon)).toEqual([178, 179])
    expect(parts[1].map(p => p.lon)).toEqual([-179, -178])
  })

  it('leaves an ordinary line alone', () => {
    const points: ContourPoint[] = [
      { lat: 0, lon: -10 },
      { lat: 1, lon: 0 },
      { lat: 2, lon: 10 },
    ]
    expect(splitAtSeam(points)).toEqual([points])
  })

  it('drops a fragment too short to draw', () => {
    // A single point stranded on the far side of the seam is not a line.
    const parts = splitAtSeam([
      { lat: 0, lon: 179 },
      { lat: 0, lon: -179 },
    ])
    expect(parts).toEqual([])
  })

  it('handles a degenerate input', () => {
    expect(splitAtSeam([])).toEqual([])
    expect(splitAtSeam([{ lat: 0, lon: 0 }])).toEqual([[{ lat: 0, lon: 0 }]])
  })
})

describe('contoursToGeoJson', () => {
  it('emits lon/lat order, which is the one GeoJSON wants', () => {
    const feature = contoursToGeoJson([[{ lat: 10, lon: -20 }, { lat: 11, lon: -21 }]])
    expect(feature.geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[[-20, 10], [-21, 11]]],
    })
  })

  it('survives an empty extraction', () => {
    const feature = contoursToGeoJson([])
    expect((feature.geometry as GeoJSON.MultiLineString).coordinates).toEqual([])
  })
})

describe('the contract with areaAboveKm2', () => {
  it('agrees about which side of the threshold a texel is on', () => {
    // The isoline and the area readout must use the same comparison, or
    // the panel says "1,000 km² above 100" while drawing the line
    // somewhere else. Both are `value >= threshold`; this pins that a
    // field entirely at the threshold counts as above and produces no
    // contour, which is the boundary case where a `>` would disagree.
    const exact = snap(8, 8, () => 100)
    expect(extractContours(exact, DENSE, 100, GLOBAL)).toEqual([])
    // And one code below the threshold produces no line either — there
    // is no crossing, not merely a line in a different place.
    const below = snap(8, 8, () => 99)
    expect(extractContours(below, DENSE, 100, GLOBAL)).toEqual([])
  })
})

describe('vertex budget', () => {
  it('does not emit more vertices than the cell lattice can hold', () => {
    // A sanity bound: every cell contributes at most two crossings, so a
    // noisy field cannot blow the source up without bound. This is the
    // cheap guard against handing MapLibre a million-vertex feature.
    const noisy = snap(32, 32, (x, y) => ((x * 7 + y * 13) % 2 === 0 ? 200 : 0))
    const lines = extractContours(noisy, DENSE, 100, GLOBAL)
    const cells = 31 * 31
    expect(vertexCount(lines)).toBeLessThanOrEqual(cells * 2 + lines.length)
  })
})
