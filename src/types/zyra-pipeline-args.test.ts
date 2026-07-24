import { describe, it, expect } from 'vitest'
import {
  cycleStart,
  isoDurationSeconds,
  parsePlaceholder,
  renderArgPlaceholders,
  renderPipelineJson,
  validateArgPlaceholders,
} from './zyra-pipeline-args'

const CTX = { now: new Date('2026-07-24T13:07:00Z'), runId: '01HX0000000000000000000000' }

describe('isoDurationSeconds', () => {
  it('parses common durations', () => {
    expect(isoDurationSeconds('PT6H')).toBe(21_600)
    expect(isoDurationSeconds('PT5H')).toBe(18_000)
    expect(isoDurationSeconds('P1D')).toBe(86_400)
    expect(isoDurationSeconds('P1W')).toBe(604_800)
    expect(isoDurationSeconds('PT90M')).toBe(5_400)
  })
  it('rejects junk', () => {
    expect(isoDurationSeconds('6h')).toBeNull()
    expect(isoDurationSeconds('P')).toBeNull()
    expect(isoDurationSeconds('')).toBeNull()
  })
})

describe('cycleStart', () => {
  it('floors to the most recent available cycle', () => {
    // 13:07Z with 6h cycles and 5h lag: 13:07-5h = 08:07 → floor → 06:00.
    const c = cycleStart(CTX.now, 21_600, 18_000)
    expect(c.toISOString()).toBe('2026-07-24T06:00:00.000Z')
  })
  it('crosses the date boundary when the lag pushes it back', () => {
    // 03:00Z with 6h cycles and 5h lag: 22:00 previous day → 18:00 cycle.
    const c = cycleStart(new Date('2026-07-24T03:00:00Z'), 21_600, 18_000)
    expect(c.toISOString()).toBe('2026-07-23T18:00:00.000Z')
  })
})

describe('parsePlaceholder / validateArgPlaceholders', () => {
  it('accepts the vocabulary', () => {
    expect(parsePlaceholder('run_date')).toEqual({ name: 'run_date' })
    expect(parsePlaceholder('cycle_date:PT6H:PT5H')).toEqual({
      name: 'cycle_date',
      intervalSeconds: 21_600,
      lagSeconds: 18_000,
    })
  })
  it('rejects unknown names, missing params, bad durations', () => {
    expect(typeof parsePlaceholder('tomorrow')).toBe('string')
    expect(typeof parsePlaceholder('cycle_date')).toBe('string')
    expect(typeof parsePlaceholder('cycle_hour:6h:5h')).toBe('string')
    expect(typeof parsePlaceholder('run_date:PT1H:PT1H')).toBe('string')
  })
  it('rejects unterminated or mismatched braces', () => {
    // matchAll() sees no complete placeholder here; the residual-brace
    // check must catch it or the literal leaks into a URL.
    expect(validateArgPlaceholders('https://x/gefs.{{cycle_date:PT6H:PT5H/f000.grib2')).toHaveLength(1)
    expect(validateArgPlaceholders('stray }} closer')).toHaveLength(1)
    expect(validateArgPlaceholders('{{run_date}} then {{broken')).toHaveLength(1)
    // Single braces are ordinary characters.
    expect(validateArgPlaceholders('a{b}c')).toEqual([])
  })

  it('collects errors from a URL-shaped string', () => {
    const errors = validateArgPlaceholders(
      'https://x/gefs.{{cycle_date:PT6H:PT5H}}/{{cycle_hr}}/f000.grib2',
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('cycle_hr')
  })
})

describe('renderArgPlaceholders', () => {
  it('renders a dated URL', () => {
    const url = renderArgPlaceholders(
      'https://noaa-gefs-pds.s3.amazonaws.com/gefs.{{cycle_date:PT6H:PT5H}}/{{cycle_hour:PT6H:PT5H}}/chem/f000.grib2',
      CTX,
    )
    expect(url).toBe('https://noaa-gefs-pds.s3.amazonaws.com/gefs.20260724/06/chem/f000.grib2')
  })
  it('renders run vars', () => {
    expect(renderArgPlaceholders('{{run_date}}/{{run_id}}', CTX)).toBe(
      '2026-07-24/01HX0000000000000000000000',
    )
  })
  it('throws on malformed placeholders', () => {
    expect(() => renderArgPlaceholders('{{cycle_date}}', CTX)).toThrow(/requires interval/)
  })
  it('throws on unterminated braces instead of passing them through', () => {
    expect(() => renderArgPlaceholders('https://x/{{cycle_date:PT6H:PT5H', CTX)).toThrow(
      /Unterminated or mismatched/,
    )
  })
})

describe('renderPipelineJson', () => {
  it('renders strings and array elements, leaves numbers alone', () => {
    const pipeline = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'decode-grib2',
          args: {
            file_or_url: 'https://x/gefs.{{cycle_date:PT6H:PT5H}}/f000.grib2',
            raw: true,
          },
        },
        {
          stage: 'process',
          command: 'reproject',
          args: { dst_bounds: [-180, -90, 180, 90], width: 2048 },
        },
      ],
    })
    const rendered = JSON.parse(renderPipelineJson(pipeline, CTX))
    expect(rendered.stages[0].args.file_or_url).toBe('https://x/gefs.20260724/f000.grib2')
    expect(rendered.stages[1].args.dst_bounds).toEqual([-180, -90, 180, 90])
  })
  it('names the offending stage on failure', () => {
    const pipeline = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'http', args: { url: '{{bogus}}' } }],
    })
    expect(() => renderPipelineJson(pipeline, CTX)).toThrow(/stages\[0\].args.url/)
  })
})
