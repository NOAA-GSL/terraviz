import { describe, it, expect } from 'vitest'
import {
  buildRunVars,
  readFramesMetaRange,
  renderSidecar,
  sanitizeErrorSummary,
  secondsToIsoDuration,
} from './workflow-sidecar'

const RUN_ID = '01HX0000000000000000000000'

// Mirrors upstream's `_compute_frames_metadata()` output (verified
// against NOAA-GSL/zyra source after the Z0 spike run).
const framesMetaFixture = {
  frames_dir: '/work/images/drought',
  pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$',
  datetime_format: '%Y%m%d',
  period_seconds: 604800,
  frame_count_actual: 53,
  start_datetime: '2026-05-01T00:00:00',
  end_datetime: '2026-06-05T00:00:00',
}

describe('readFramesMetaRange', () => {
  it('reads the transform-metadata shape incl. period_seconds', () => {
    expect(readFramesMetaRange(framesMetaFixture)).toEqual({
      dataStart: '2026-05-01T00:00:00Z',
      dataEnd: '2026-06-05T00:00:00Z',
      periodSeconds: 604800,
    })
  })

  it('reads a per-frame list fallback (first → last)', () => {
    expect(
      readFramesMetaRange({
        frames: [
          { datetime: '2026-05-01T00:00:00Z' },
          { datetime: '2026-06-05T00:00:00Z' },
        ],
      }),
    ).toEqual({ dataStart: '2026-05-01T00:00:00Z', dataEnd: '2026-06-05T00:00:00Z' })
  })

  it('returns null for unrecognised shapes', () => {
    expect(readFramesMetaRange(null)).toBeNull()
    expect(readFramesMetaRange({ frames: [] })).toBeNull()
    expect(readFramesMetaRange({ frames: [{ size: 1 }] })).toBeNull()
  })
})

describe('renderSidecar', () => {
  const vars = buildRunVars({
    runId: RUN_ID,
    now: new Date('2026-06-10T12:00:00Z'),
    framesMeta: framesMetaFixture,
  })

  it('interpolates run and data variables', () => {
    const result = renderSidecar(
      {
        title: 'Drought Risk — {{run_date}}',
        start_time: '{{data_start}}',
        end_time: '{{data_end}}',
        period: '{{data_period}}',
        keywords: ['drought', 'run {{run_id}}'],
      },
      vars,
    )
    expect(result.warnings).toEqual([])
    expect(result.fields).toEqual({
      title: 'Drought Risk — 2026-06-10',
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-06-05T00:00:00Z',
      period: 'P7D',
      keywords: ['drought', `run ${RUN_ID}`],
    })
  })

  it('drops fields with unresolved placeholders instead of failing', () => {
    const noMeta = buildRunVars({ runId: RUN_ID, now: new Date('2026-06-10T12:00:00Z') })
    const result = renderSidecar(
      { title: 'T — {{run_date}}', start_time: '{{data_start}}' },
      noMeta,
    )
    expect(result.fields).toEqual({ title: 'T — 2026-06-10' })
    expect(result.warnings).toHaveLength(1)
  })

  it('passes literal (non-string) values through', () => {
    const result = renderSidecar({ title: 'Plain', keywords: ['a', 'b'] }, vars)
    expect(result.fields).toEqual({ title: 'Plain', keywords: ['a', 'b'] })
  })
})

describe('toUtcIso normalisation', () => {
  it('appends Z to naive timestamps and preserves valid UTC ones', async () => {
    const { toUtcIso } = await import('./workflow-sidecar')
    expect(toUtcIso('2026-05-01T00:00:00')).toBe('2026-05-01T00:00:00Z')
    expect(toUtcIso('2026-05-01T00:00:00Z')).toBe('2026-05-01T00:00:00Z')
    expect(toUtcIso('2026-05-01T02:00:00+02:00')).toBe('2026-05-01T00:00:00Z')
  })
})

describe('secondsToIsoDuration', () => {
  it('renders the datasets.period vocabulary', () => {
    expect(secondsToIsoDuration(604800)).toBe('P7D')
    expect(secondsToIsoDuration(86400)).toBe('P1D')
    expect(secondsToIsoDuration(3600)).toBe('PT1H')
    expect(secondsToIsoDuration(90061)).toBe('P1DT1H1M1S')
    expect(secondsToIsoDuration(0)).toBe('PT0S')
  })
})

describe('sanitizeErrorSummary', () => {
  it('redacts credential assignments and long tokens', () => {
    const input =
      'PUT failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD and token=shh'
    const out = sanitizeErrorSummary(input)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    expect(out).not.toContain('shh')
  })

  it('collapses whitespace and truncates', () => {
    const out = sanitizeErrorSummary(`a\n\n${'word '.repeat(200)}`)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out.startsWith('a word')).toBe(true)
  })
})
