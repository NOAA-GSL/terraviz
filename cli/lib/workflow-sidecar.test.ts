import { describe, it, expect } from 'vitest'
import {
  buildRunVars,
  readFramesMetaRange,
  renderSidecar,
  sanitizeErrorSummary,
} from './workflow-sidecar'

const RUN_ID = '01HX0000000000000000000000'

// Z0-pending: inferred fixture — replace with a real frames-meta.json
// from the spike's run artifact and adjust readFramesMetaRange.
const framesMetaFixture = {
  frames: [
    { datetime: '2026-05-01T00:00:00Z', filename: 'DroughtRisk_Weekly_20260501.png' },
    { datetime: '2026-06-05T00:00:00Z', filename: 'DroughtRisk_Weekly_20260605.png' },
  ],
}

describe('readFramesMetaRange', () => {
  it('reads a per-frame list (first → last)', () => {
    expect(readFramesMetaRange(framesMetaFixture)).toEqual({
      dataStart: '2026-05-01T00:00:00Z',
      dataEnd: '2026-06-05T00:00:00Z',
    })
  })

  it('reads a top-level range', () => {
    expect(
      readFramesMetaRange({ start_datetime: '2026-01-01', end_datetime: '2026-02-01' }),
    ).toEqual({ dataStart: '2026-01-01', dataEnd: '2026-02-01' })
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
        keywords: ['drought', 'run {{run_id}}'],
      },
      vars,
    )
    expect(result.warnings).toEqual([])
    expect(result.fields).toEqual({
      title: 'Drought Risk — 2026-06-10',
      start_time: '2026-05-01T00:00:00Z',
      end_time: '2026-06-05T00:00:00Z',
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
