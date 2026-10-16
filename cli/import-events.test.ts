// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
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

describe('runImportEvents — registry-driven refresh (default mode)', () => {
  function makeRefreshCtx(opts: {
    options?: Record<string, string | boolean>
    refreshEvents?: ReturnType<typeof vi.fn>
  }) {
    const out: string[] = []
    const err: string[] = []
    const refreshEvents =
      opts.refreshEvents ??
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: {
          fetched: 12,
          mappable: 10,
          created: 3,
          refreshed: 7,
          failed: 0,
          feeds: [
            { id: 'FEED_EONET_DEFAULT', kind: 'eonet', label: 'NASA EONET', created: 3, refreshed: 7, failed: 0 },
          ],
        },
      }))
    const client = { refreshEvents } as unknown as TerravizClient
    const ctx: CommandContext = {
      client,
      args: { positional: [], options: { ...opts.options } },
      stdout: { write: (c: string) => (out.push(c), true) },
      stderr: { write: (c: string) => (err.push(c), true) },
    }
    return { ctx, out, err, refreshEvents }
  }

  it('with no --file/--source-url it calls the refresh endpoint once', async () => {
    const { ctx, out, refreshEvents } = makeRefreshCtx({})
    const code = await runImportEvents(ctx)
    expect(code).toBe(0)
    expect(refreshEvents).toHaveBeenCalledTimes(1)
    expect(out.join('')).toContain('Registry refresh complete')
    expect(out.join('')).toContain('NASA EONET [eonet]: +3 / ~7 / !0')
  })

  it('dry-run skips the call', async () => {
    const { ctx, out, refreshEvents } = makeRefreshCtx({ options: { 'dry-run': true } })
    expect(await runImportEvents(ctx)).toBe(0)
    expect(refreshEvents).not.toHaveBeenCalled()
    expect(out.join('')).toContain('Dry run')
  })

  it('exits 1 on a failed request or a connector error', async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 502, error: 'feed_unavailable' }))
    expect(await runImportEvents(makeRefreshCtx({ refreshEvents: failing }).ctx)).toBe(1)

    const connectorError = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        fetched: 0, mappable: 0, created: 0, refreshed: 0, failed: 0,
        feeds: [{ id: 'F1', kind: 'rss', label: 'Broken Feed', created: 0, refreshed: 0, failed: 0, error: 'feed responded 502' }],
      },
    }))
    expect(await runImportEvents(makeRefreshCtx({ refreshEvents: connectorError }).ctx)).toBe(1)
  })

  describe('with failures', () => {
    // The CI runner sets GITHUB_ACTIONS, which switches on the
    // stop-commands wrapper; pin it so these tests read the same anywhere.
    beforeEach(() => {
      vi.stubEnv('GITHUB_ACTIONS', '')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    function failing(feed: Record<string, unknown>, failed: number) {
      return vi.fn(async () => ({
        ok: true,
        status: 200,
        body: {
          fetched: failed, mappable: failed, created: 0, refreshed: 0, failed,
          feeds: [{ id: 'F1', kind: 'rss', label: 'Feed', created: 0, refreshed: 0, failed, ...feed }],
        },
      }))
    }

    it('names each failed item the server describes, and how many it did not', async () => {
      const refreshEvents = failing(
        {
          label: 'NHC Atlantic',
          failures: [
            {
              externalId: 'https://www.nhc.noaa.gov/',
              title: 'There are no tropical cyclones at this time.',
              code: 'ingest_failed',
              message: 'D1_ERROR: boom',
            },
            { externalId: null, title: null, code: 'invalid_item', message: 'source.url: invalid' },
          ],
        },
        8,
      )
      const { ctx, out } = makeRefreshCtx({ refreshEvents })
      expect(await runImportEvents(ctx)).toBe(1)
      const text = out.join('')
      expect(text).toContain(
        '      ! "There are no tropical cyclones at this time." [https://www.nhc.noaa.gov/]: ' +
          'ingest_failed — D1_ERROR: boom\n',
      )
      expect(text).toContain('      ! (untitled): invalid_item — source.url: invalid\n')
      expect(text).toContain('      … and 6 more\n')
    })

    it('leaves no workflow command in either syntax, wherever the text sits', async () => {
      const refreshEvents = failing(
        {
          label: 'Feed\n::error::label ##[error]label',
          error: 'down\u2028::error::connector',
          failures: [
            {
              externalId: 'x\r\n::error::forged',
              // The legacy syntax is read anywhere in a line, not just at its start.
              title: '##[error title=Action required;file=src/main.ts;line=1]Rotate the token',
              code: 'ingest_failed',
              message: 'e\n::warning::z \u0085##[add-mask]y',
            },
          ],
        },
        1,
      )
      const { ctx, out } = makeRefreshCtx({ refreshEvents })
      await runImportEvents(ctx)
      for (const line of out.join('').split('\n')) {
        expect(line.trimStart().startsWith('::')).toBe(false)
        expect(line).not.toContain('##[')
      }
      // Escaped, not dropped: an operator can still read what the feed said.
      expect(out.join('')).toContain('##\\[error title=Action required')
    })

    it('prints only the count from a server that names no failures', async () => {
      const { ctx, out } = makeRefreshCtx({ refreshEvents: failing({}, 2) })
      expect(await runImportEvents(ctx)).toBe(1)
      const text = out.join('')
      expect(text).toContain('  - Feed [rss]: +0 / ~0 / !2\n')
      expect(text).not.toContain('      !')
      expect(text).not.toContain('more')
    })

    it('does not throw on a non-string field from a misbehaving server', async () => {
      const refreshEvents = failing(
        { failures: [{ externalId: 42, title: { a: 1 }, code: null, message: undefined }] },
        1,
      )
      const { ctx } = makeRefreshCtx({ refreshEvents })
      expect(await runImportEvents(ctx)).toBe(1)
    })

    it('under GitHub Actions, switches workflow commands off behind a fresh token', async () => {
      vi.stubEnv('GITHUB_ACTIONS', 'true')
      const tokens: string[] = []
      for (let run = 0; run < 2; run++) {
        const { ctx, out } = makeRefreshCtx({ refreshEvents: failing({}, 1) })
        await runImportEvents(ctx)
        const lines = out.join('').split('\n').filter(Boolean)
        const stop = /^::stop-commands::(.+)$/.exec(lines[0])
        expect(stop).not.toBeNull()
        const token = stop![1]
        expect(lines[lines.length - 1]).toBe(`::${token}::`)
        // Everything the server sent sits between the two.
        expect(lines.slice(1, -1).join('\n')).toContain('Registry refresh complete')
        tokens.push(token)
      }
      // A token a feed could guess, it could print to switch commands back on.
      expect(tokens[0]).not.toBe(tokens[1])
      expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})
