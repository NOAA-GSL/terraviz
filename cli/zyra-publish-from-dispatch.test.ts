import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFramesMeta, parseArgs } from './zyra-publish-from-dispatch'

const ULID = '01HX0000000000000000000000'

describe('parseArgs', () => {
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
