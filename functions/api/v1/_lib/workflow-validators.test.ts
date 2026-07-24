import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_FRAMES_OUTPUT_DIR,
  WORKFLOW_OUTPUT_PATH,
} from '../../../../src/types/zyra-workflow-constants'
import {
  validateMetadataTemplate,
  validatePipeline,
  validateRunStatusInput,
  validateWorkflowInput,
  type WorkflowValidationError,
} from './workflow-validators'

const goodPipeline = JSON.stringify({
  stages: [
    {
      stage: 'acquire',
      command: 'ftp',
      args: { path: 'ftp://ftp.nnvl.noaa.gov/SOS/DroughtRisk_Weekly', 'sync-dir': '/work/images/drought' },
    },
    {
      stage: 'visualize',
      command: 'compose-video',
      args: { frames: '/work/images/drought', output: WORKFLOW_OUTPUT_PATH },
    },
  ],
})

const goodTemplate = JSON.stringify({
  title: 'Drought Risk (Weekly) — {{run_date}}',
  keywords: ['drought', 'real-time'],
  start_time: '{{data_start}}',
  period: 'P1W',
})

const ULID = '01HX0000000000000000000000'

function runPipeline(json: unknown): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = []
  validatePipeline(json, errors)
  return errors
}

function runTemplate(json: unknown): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = []
  validateMetadataTemplate(json, errors)
  return errors
}

describe('validatePipeline', () => {
  it('accepts an allowlisted pipeline that writes the output path', () => {
    expect(runPipeline(goodPipeline)).toEqual([])
  })

  it('accepts a frames-output (recall) pipeline with no composed MP4', () => {
    const framesPipeline = JSON.stringify({
      stages: [
        {
          stage: 'acquire',
          command: 'ftp',
          args: { path: 'ftp://host/x', 'sync-dir': WORKFLOW_FRAMES_OUTPUT_DIR },
        },
        {
          stage: 'process',
          command: 'scan-frames',
          args: { 'frames-dir': WORKFLOW_FRAMES_OUTPUT_DIR, output: '/work/frames-meta.json' },
        },
      ],
    })
    expect(runPipeline(framesPipeline)).toEqual([])
  })

  it('rejects a pipeline that writes neither the MP4 nor a frames dir', () => {
    const noOutput = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'ftp', args: { path: 'ftp://host/x' } }],
    })
    expect(runPipeline(noOutput).some(e => e.code === 'missing_output')).toBe(true)
  })

  it('accepts a process reproject stage (regional-model pattern)', () => {
    // Warps projected model output (e.g. HRRR Lambert Conformal) onto
    // the equirectangular grid the globe expects, and wraps 0-360
    // global grids to ±180. All args are scalars.
    const reprojectPipeline = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'reproject',
          args: {
            i: '/work/images/in.tif',
            o: '/work/images/frames/out.tif',
            'dst-bounds': 'auto',
            width: 2048,
            'dst-nodata': 'nan',
          },
        },
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { frames: WORKFLOW_FRAMES_OUTPUT_DIR, output: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(reprojectPipeline)).toEqual([])
  })

  it('accepts array args of scalars (multi-valued flags like dst-bounds)', () => {
    const pipeline = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'reproject',
          args: { i: '/work/tmp/in.tif', o: '/work/tmp/out.tif', dst_bounds: [-180, -90, 180, 90], width: 2048 },
        },
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { frames: WORKFLOW_FRAMES_OUTPUT_DIR, output: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(pipeline)).toEqual([])
  })

  it('rejects array args with non-scalar elements or bad lengths', () => {
    const nested = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'reproject',
          args: { dst_bounds: [[-180, -90]], o: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(nested).some(e => e.code === 'invalid_value')).toBe(true)
    const empty = JSON.stringify({
      stages: [
        { stage: 'process', command: 'reproject', args: { dst_bounds: [], o: WORKFLOW_OUTPUT_PATH } },
      ],
    })
    expect(runPipeline(empty).some(e => e.code === 'invalid_value')).toBe(true)
    const oversized = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'reproject',
          args: { dst_bounds: Array.from({ length: 17 }, (_, n) => n), o: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(oversized).some(e => e.code === 'invalid_value')).toBe(true)
  })

  it('validates arg placeholders at save time', () => {
    const good = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'decode-grib2',
          args: {
            file_or_url: 'https://x/gefs.{{cycle_date:PT6H:PT5H}}/{{cycle_hour:PT6H:PT5H}}/f000.grib2',
            raw: true,
          },
        },
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { frames: WORKFLOW_FRAMES_OUTPUT_DIR, output: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(good)).toEqual([])
    const bad = JSON.stringify({
      stages: [
        {
          stage: 'acquire',
          command: 'http',
          args: { url: 'https://x/{{cycle_date}}', output: WORKFLOW_OUTPUT_PATH },
        },
      ],
    })
    expect(runPipeline(bad).some(e => e.code === 'invalid_placeholder')).toBe(true)
  })

  it('rejects stages and commands off the allowlist', () => {
    const shell = JSON.stringify({ stages: [{ stage: 'shell', command: 'bash' }] })
    expect(runPipeline(shell).some(e => e.code === 'not_allowlisted')).toBe(true)
    const badCommand = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'scp', args: { output: WORKFLOW_OUTPUT_PATH } }],
    })
    expect(runPipeline(badCommand).some(e => e.code === 'not_allowlisted')).toBe(true)
  })

  it('requires at least one arg to equal the output path', () => {
    const noOutput = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'http', args: { url: 'https://x.test/a' } }],
    })
    expect(runPipeline(noOutput).some(e => e.code === 'missing_output')).toBe(true)
  })

  it('rejects non-scalar args and malformed JSON', () => {
    const nested = JSON.stringify({
      stages: [{ stage: 'acquire', command: 'http', args: { url: { nested: true } } }],
    })
    expect(runPipeline(nested).some(e => e.code === 'invalid_value')).toBe(true)
    expect(runPipeline('{not json').some(e => e.code === 'invalid_json')).toBe(true)
    expect(runPipeline(JSON.stringify({ stages: [] })).some(e => e.code === 'invalid_shape')).toBe(true)
  })
})

describe('validateMetadataTemplate', () => {
  it('accepts allowlisted fields with known placeholders', () => {
    expect(runTemplate(goodTemplate)).toEqual([])
  })

  it('rejects unknown fields and unknown placeholders', () => {
    expect(
      runTemplate(JSON.stringify({ data_ref: 'r2:evil' })).some(e => e.code === 'unknown_field'),
    ).toBe(true)
    expect(
      runTemplate(JSON.stringify({ title: '{{hostname}}' })).some(
        e => e.code === 'unknown_placeholder',
      ),
    ).toBe(true)
  })
})

describe('validateWorkflowInput', () => {
  const full = {
    name: 'Weekly drought',
    pipeline_json: goodPipeline,
    metadata_template: goodTemplate,
    schedule: 'P1W',
    target_dataset_id: ULID,
  }

  it('accepts a complete create body', () => {
    const result = validateWorkflowInput(full, true)
    expect(result.ok).toBe(true)
  })

  it('requires the full set on create but not on PATCH', () => {
    const partial = { schedule: 'PT1H' }
    expect(validateWorkflowInput(partial, true).ok).toBe(false)
    expect(validateWorkflowInput(partial, false).ok).toBe(true)
  })

  it('rejects sub-tick schedules and non-overwrite update modes', () => {
    expect(validateWorkflowInput({ ...full, schedule: 'PT5M' }, true).ok).toBe(false)
    expect(validateWorkflowInput({ ...full, update_mode: 'append' }, true).ok).toBe(false)
  })
})

describe('validateRunStatusInput', () => {
  it('accepts callbacks and truncates error summaries', () => {
    const result = validateRunStatusInput({
      status: 'failed',
      gha_run_id: '27246906285',
      error_summary: 'x'.repeat(2000),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.error_summary).toHaveLength(500)
      expect(result.value.gha_run_id).toBe('27246906285')
    }
  })

  it('rejects array bodies', () => {
    expect(validateRunStatusInput([{ status: 'running' }]).ok).toBe(false)
  })

  it('rejects queued (not a callback state) and unknown statuses', () => {
    expect(validateRunStatusInput({ status: 'queued' }).ok).toBe(false)
    expect(validateRunStatusInput({ status: 'done' }).ok).toBe(false)
  })
})
