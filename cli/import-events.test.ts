import { describe, it, expect, vi } from 'vitest'
import { runImportEvents } from './import-events'
import type { CommandContext } from './commands'
import type { TerravizClient } from './lib/client'

const FEED = JSON.stringify({
  events: [
    {
      id: 'EONET_6001',
      title: 'Hurricane Lena',
      sources: [{ id: 'GDACS', url: 'https://gdacs.org/x' }],
      categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
      geometry: [{ date: '2026-06-25T00:00:00Z', type: 'Point', coordinates: [-89, 29] }],
    },
    { id: 'unmappable' }, // dropped by the mapper
  ],
})

function makeCtx(opts: {
  options?: Record<string, unknown>
  createEvent?: ReturnType<typeof vi.fn>
}): { ctx: CommandContext; out: string[]; err: string[]; createEvent: ReturnType<typeof vi.fn> } {
  const out: string[] = []
  const err: string[] = []
  const createEvent =
    opts.createEvent ??
    vi.fn(async (body: Record<string, unknown>) => ({
      ok: true,
      status: 201,
      body: { created: true, event: { id: 'E1', title: body.title } },
    }))
  const client = { createEvent } as unknown as TerravizClient
  const ctx: CommandContext = {
    client,
    args: { positional: [], options: { file: 'feed.json', ...opts.options } },
    stdout: { write: (c: string) => (out.push(c), true) },
    stderr: { write: (c: string) => (err.push(c), true) },
    readFile: () => FEED,
  }
  return { ctx, out, err, createEvent }
}

describe('runImportEvents', () => {
  it('dry-run prints the plan and writes nothing', async () => {
    const { ctx, out, createEvent } = makeCtx({ options: { 'dry-run': true } })
    const code = await runImportEvents(ctx)
    expect(code).toBe(0)
    expect(createEvent).not.toHaveBeenCalled()
    expect(out.join('')).toContain('mappable events:       1')
    expect(out.join('')).toContain('Dry run')
  })

  it('posts each mappable event and reports created count', async () => {
    const { ctx, out, createEvent } = makeCtx({})
    const code = await runImportEvents(ctx)
    expect(code).toBe(0)
    expect(createEvent).toHaveBeenCalledTimes(1)
    const body = createEvent.mock.calls[0][0]
    expect(body).toMatchObject({ externalId: 'EONET_6001', feedId: 'eonet', title: 'Hurricane Lena' })
    expect(out.join('')).toContain('created:               1')
  })

  it('counts a refresh (created=false) separately', async () => {
    const createEvent = vi.fn(async () => ({ ok: true, status: 200, body: { created: false, event: { id: 'E1', title: 'x' } } }))
    const { ctx, out } = makeCtx({ createEvent })
    await runImportEvents(ctx)
    expect(out.join('')).toContain('refreshed (existing):  1')
  })

  it('returns exit 1 when an ingest fails', async () => {
    const createEvent = vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }))
    const { ctx } = makeCtx({ createEvent })
    expect(await runImportEvents(ctx)).toBe(1)
  })
})
