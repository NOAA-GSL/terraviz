import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveFrameParams,
  expectedOutputKind,
  findFramesMeta,
  parseArgs,
  readPaddedFrameNames,
} from './zyra-publish-from-dispatch'

const ULID = '01HX0000000000000000000000'

describe('parseArgs', () => {

  it('defaults report-failure to failed and honors --status=canceled', () => {
    // A cancelled or timed-out GHA job must post `canceled`, not
    // `failed`, so the run row still reaches a terminal state and the
    // workflow is not wedged by the active-run guard.
    const base = [`--phase=report-failure`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]
    expect(parseArgs(base)).toMatchObject({ terminalStatus: 'failed' })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({ terminalStatus: 'canceled' })
    expect(parseArgs([...base, '--status=nonsense'])).toMatchObject({ terminalStatus: 'failed' })
  })

  it('defaults the summary to match the status it is stored against', () => {
    // The workflow always passes --error-summary, so this is the
    // hand-run path — but a row reading `canceled` with "Workflow run
    // failed" contradicts itself wherever it surfaces.
    const base = [`--phase=report-failure`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]
    expect(parseArgs(base)).toMatchObject({
      errorSummary: expect.stringContaining('failed'),
    })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({
      errorSummary: expect.stringContaining('cancelled'),
    })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({
      errorSummary: expect.not.stringContaining('failed'),
    })
    // An explicit summary still wins over both defaults.
    expect(
      parseArgs([...base, '--status=canceled', '--error-summary=out of disk']),
    ).toMatchObject({ errorSummary: 'out of disk' })
  })
  it('requires a valid phase and ULID ids', () => {
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs([`--phase=deploy`, `--workflow-id=${ULID}`, `--run-id=${ULID}`])).toHaveProperty('error')
    expect(parseArgs([`--phase=fetch`, `--workflow-id=nope`, `--run-id=${ULID}`])).toHaveProperty('error')
    expect(parseArgs([`--phase=fetch`, `--workflow-id=${ULID}`, `--run-id=${ULID}`])).toMatchObject({
      phase: 'fetch',
      workdir: '_work',
      waitSeconds: 1800,
    })
  })

  it('derives the default video path from the workdir', () => {
    const args = parseArgs([
      `--phase=publish`,
      `--workflow-id=${ULID}`,
      `--run-id=${ULID}`,
      `--workdir=/tmp/zw`,
    ])
    expect(args).toMatchObject({ video: '/tmp/zw/output/dataset.mp4' })
  })

  it('bounds the wait window', () => {
    expect(
      parseArgs([`--phase=publish`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--wait-seconds=999999`]),
    ).toHaveProperty('error')
  })

  it('accepts the frame-cache phases', () => {
    for (const phase of ['restore-frames', 'save-frames']) {
      expect(
        parseArgs([`--phase=${phase}`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]),
      ).toMatchObject({ phase, workdir: '_work' })
    }
  })

  it('accepts the acquire-softpass phase with a default staleness threshold', () => {
    expect(
      parseArgs([
        `--phase=acquire-softpass`,
        `--workflow-id=${ULID}`,
        `--run-id=${ULID}`,
        `--zyra-log=_work/zyra-run.log`,
      ]),
    ).toMatchObject({ phase: 'acquire-softpass', zyraLog: '_work/zyra-run.log', staleAfterSeconds: 172_800 })
  })

  it('bounds --stale-after-seconds', () => {
    expect(
      parseArgs([`--phase=acquire-softpass`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--stale-after-seconds=99999999`]),
    ).toHaveProperty('error')
    expect(
      parseArgs([`--phase=acquire-softpass`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--stale-after-seconds=3600`]),
    ).toMatchObject({ staleAfterSeconds: 3600 })
  })
})

describe('expectedOutputKind', () => {
  it('detects a video pipeline by its WORKFLOW_OUTPUT_PATH arg', () => {
    const video = JSON.stringify({
      stages: [
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { frames: '/work/images/frames', output: '/work/output/dataset.mp4' },
        },
      ],
    })
    expect(expectedOutputKind(video)).toBe('video')
  })

  it('treats a frames-output pipeline (no MP4 path) as frames', () => {
    const frames = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'scan-frames',
          args: { 'frames-dir': '/work/images/frames', output: '/work/frames-meta.json' },
        },
      ],
    })
    expect(expectedOutputKind(frames)).toBe('frames')
  })

  it('falls back to frames on unparseable pipeline JSON', () => {
    expect(expectedOutputKind('not json')).toBe('frames')
  })
})

describe('readPaddedFrameNames', () => {
  it('extracts the basenames of pad-missing created_files', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pad-'))
    const reportPath = join(workdir, 'pad-missing-report.json')
    // Shape mirrors a real pad-missing report (absolute paths).
    await writeFile(
      reportPath,
      JSON.stringify({
        status: 'completed',
        fill_mode: 'nearest',
        created_count: 2,
        created_files: [
          '/builds/x/_work/images/clouds/linear_rgb_cyl_20260611_1910.jpg',
          '/builds/x/_work/images/clouds/linear_rgb_cyl_20260611_1920.jpg',
        ],
        dry_run: false,
      }),
    )
    expect(await readPaddedFrameNames(reportPath)).toEqual([
      'linear_rgb_cyl_20260611_1910.jpg',
      'linear_rgb_cyl_20260611_1920.jpg',
    ])
  })

  it('returns [] for a dry run, a missing file, or no created_files', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pad-'))
    expect(await readPaddedFrameNames(join(workdir, 'absent.json'))).toEqual([])

    const dryPath = join(workdir, 'dry.json')
    await writeFile(dryPath, JSON.stringify({ dry_run: true, created_files: ['/x/a.png'] }))
    expect(await readPaddedFrameNames(dryPath)).toEqual([])

    const emptyPath = join(workdir, 'empty.json')
    await writeFile(emptyPath, JSON.stringify({ status: 'completed', missing_count: 0 }))
    expect(await readPaddedFrameNames(emptyPath)).toEqual([])
  })
})

describe('findFramesMeta', () => {
  it('prefers the workdir-root convention, falls back to the zyra-scheduler layout', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-test-'))
    expect(await findFramesMeta(workdir)).toBeNull()

    const nested = join(workdir, 'images', 'drought', 'metadata')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'frames-meta.json'), '{}')
    expect(await findFramesMeta(workdir)).toBe(join(nested, 'frames-meta.json'))

    await writeFile(join(workdir, 'frames-meta.json'), '{}')
    expect(await findFramesMeta(workdir)).toBe(join(workdir, 'frames-meta.json'))
  })
})

describe('deriveFrameParams', () => {
  /** A pipeline that regenerates every frame from source URLs — no
   *  acquire stage, so nothing incremental to cache. */
  const fromScratch = JSON.stringify({
    stages: [
      {
        stage: 'visualize',
        command: 'heatmap',
        args: { 'output-dir': '/work/images/frames', basemap: 'fv3-chem-basemap.jpg' },
      },
      {
        stage: 'process',
        command: 'scan-frames',
        args: { 'frames-dir': '/work/images/frames', 'period-seconds': 10800 },
      },
      {
        stage: 'visualize',
        command: 'compose-video',
        args: { frames: '/work/images/frames', glob: '*.png' },
      },
    ],
  })

  it('opts a pipeline into the cache only via `acquire --sync-dir`', () => {
    // Regression: cacheDir used to default to <workdir>/images/frames,
    // which restored another era's frames into a from-scratch
    // pipeline's output dir. compose-video globs *.png, so those
    // leftovers ended up in the published video.
    expect(deriveFrameParams(fromScratch, '/tmp/zw').cacheDir).toBeNull()
  })

  it('still resolves a frames dir to publish from without a sync-dir', () => {
    // framesDir is a different question from cacheDir: the
    // image-sequence publish path reads the frames the run produced,
    // and the runner's convention is where they land. Gating the
    // cache must not take that path's directory away.
    expect(deriveFrameParams(fromScratch, '/tmp/zw').framesDir).toBe(
      join('/tmp/zw', 'images', 'frames'),
    )
  })

  it('maps the sync-dir to its host path when the pipeline has one', () => {
    const cached = JSON.stringify({
      stages: [
        {
          stage: 'acquire',
          args: { 'sync-dir': '/work/images/frames', 'since-period': 'PT6H' },
        },
        {
          stage: 'process',
          command: 'scan-frames',
          args: { 'frames-dir': '/work/images/frames', 'period-seconds': 3600 },
        },
      ],
    })
    expect(deriveFrameParams(cached, '/tmp/zw')).toMatchObject({
      framesDir: join('/tmp/zw', 'images', 'frames'),
      cacheDir: join('/tmp/zw', 'images', 'frames'),
      // 6 h at an hourly cadence, inclusive of both endpoints.
      keepFrames: 7,
    })
  })

  it('does not opt in on a sync-dir outside the mounted workdir', () => {
    // The runner can only see paths under /work; a sync-dir elsewhere
    // is not a directory we could restore into.
    const elsewhere = JSON.stringify({
      stages: [{ stage: 'acquire', args: { 'sync-dir': '/scratch/frames' } }],
    })
    expect(deriveFrameParams(elsewhere, '/tmp/zw').cacheDir).toBeNull()
  })

  it('does not opt in on an unparseable pipeline', () => {
    expect(deriveFrameParams('not json', '/tmp/zw').cacheDir).toBeNull()
  })
})
