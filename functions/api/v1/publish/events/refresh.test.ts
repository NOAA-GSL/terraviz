// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/events/refresh — the
 * on-demand ingestion pull.
 *
 * Coverage: privileged gate (403), 503 when CATALOG_DB is unbound, 502
 * when the feed is unreachable, a 200 success that creates events from
 * a stubbed EONET feed + writes the `event.refreshed` audit row, and
 * idempotency (a second pull refreshes rather than duplicates).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as refreshPost } from './refresh'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import { listCurrentEvents } from '../../_lib/events-store'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUBLISHER', email: 'c@e', role: 'publisher', is_admin: 0 }

function setupEnv() {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow }) {
  return {
    request: new Request('https://localhost/api/v1/publish/events/refresh', { method: 'POST' }),
    env: opts.env,
    params: {} as Record<string, string | string[]>,
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/events/refresh',
  } as unknown as Parameters<typeof refreshPost>[0]
}

function auditCount(sqlite: ReturnType<typeof seedFixtures>, action: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`).get(action) as { n: number }
  return row.n
}

/** A minimal EONET v3 feed the pure mapper accepts: a stable id, a
 *  title, one geometry with coordinates, and a source url. */
const EONET_FEED = {
  events: [
    {
      id: 'EONET_1001',
      title: 'Wildfire — Example Ridge',
      description: 'A wildfire burning in the example range.',
      categories: [{ id: 'wildfires', title: 'Wildfires' }],
      sources: [{ id: 'IRWIN', url: 'https://eonet.gsfc.nasa.gov/events/EONET_1001' }],
      geometry: [{ date: '2026-06-25T00:00:00Z', type: 'Point', coordinates: [-120.5, 38.2] }],
    },
    {
      id: 'EONET_1002',
      title: 'Tropical Storm — Example Sea',
      sources: [{ id: 'NOAA', url: 'https://eonet.gsfc.nasa.gov/events/EONET_1002' }],
      geometry: [{ date: '2026-06-24T00:00:00Z', type: 'Point', coordinates: [-89, 29] }],
    },
  ],
}

/** Stub the global fetch the route uses to pull the feed. */
function stubFeed(value: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status: ok ? 200 : 502, json: async () => value }) as unknown as Response),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/v1/publish/events/refresh', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env, publisher: PUBLISHER }))
    expect(res.status).toBe(403)
  })

  it('503 when CATALOG_DB is unbound', async () => {
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env: {} }))
    expect(res.status).toBe(503)
  })

  it('502 when the feed is unreachable', async () => {
    const { env } = setupEnv()
    stubFeed(null, false) // non-ok feed response
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(502)
    const body = JSON.parse(await res.text()) as { error: string }
    expect(body.error).toBe('feed_unavailable')
  })

  it('pulls the enabled connectors, creates proposed events, and audits the refresh', async () => {
    const { env, sqlite } = setupEnv()
    stubFeed(EONET_FEED)

    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      fetched: number
      mappable: number
      created: number
      refreshed: number
      failed: number
      feeds: Array<{ id: string; kind: string; created: number; error?: string }>
    }
    expect(body).toMatchObject({ fetched: 2, mappable: 2, created: 2, refreshed: 0, failed: 0 })
    // The migration-seeded EONET connector is the one enabled feed.
    expect(body.feeds).toHaveLength(1)
    expect(body.feeds[0]).toMatchObject({ id: 'FEED_EONET_DEFAULT', kind: 'eonet', created: 2 })

    const events = await listCurrentEvents(env.CATALOG_DB as Parameters<typeof listCurrentEvents>[0])
    expect(events).toHaveLength(2)
    expect(events.every(e => e.status === 'proposed')).toBe(true)
    expect(auditCount(sqlite, 'event.refreshed')).toBe(1)

    // Run bookkeeping recorded on the connector row.
    const row = sqlite
      .prepare(`SELECT last_run_status, last_run_error FROM feed_connectors WHERE id = ?`)
      .get('FEED_EONET_DEFAULT') as { last_run_status: string; last_run_error: string | null }
    expect(row).toMatchObject({ last_run_status: 'ok', last_run_error: null })

    // The feed fetch identifies itself — real news CDNs 406 a bare
    // Workers fetch with no User-Agent (The Guardian did, live).
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    expect(init?.headers?.['User-Agent']).toContain('TerravizEventsBot')
    expect(init?.headers?.Accept).toBeTruthy()
  })

  it('records the failure on the connector row when its feed is down', async () => {
    const { env, sqlite } = setupEnv()
    stubFeed(null, false)
    await refreshPost(ctx({ env }))
    const row = sqlite
      .prepare(`SELECT last_run_status, last_run_error FROM feed_connectors WHERE id = ?`)
      .get('FEED_EONET_DEFAULT') as { last_run_status: string; last_run_error: string | null }
    expect(row.last_run_status).toBe('error')
    expect(row.last_run_error).toContain('502')
  })

  it('skips a disabled connector (200 with zeros when none are enabled)', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = ?`).run('FEED_EONET_DEFAULT')
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { created: number; feeds: unknown[] }
    expect(body.created).toBe(0)
    expect(body.feeds).toHaveLength(0)
  })

  it('200 (not 502) when every enabled row is an unknown kind — config, not outage', async () => {
    const { env, sqlite } = setupEnv()
    sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = 'FEED_EONET_DEFAULT'`).run()
    sqlite
      .prepare(
        `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
         VALUES ('FEED_AHEAD', 'from-the-future', 'Ahead of the code', 'https://example.org/f', 'news', 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run()
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { feeds: Array<{ error?: string }> }
    expect(body.feeds[0].error).toContain('unknown connector kind')
  })

  it('rejects a non-http(s) connector URL without fetching it', async () => {
    const { env, sqlite } = setupEnv()
    sqlite
      .prepare(`UPDATE feed_connectors SET url = 'file:///etc/passwd' WHERE id = 'FEED_EONET_DEFAULT'`)
      .run()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await refreshPost(ctx({ env }))
    // Config error, not an outage → 200 with the error recorded.
    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    const row = sqlite
      .prepare(`SELECT last_run_status, last_run_error FROM feed_connectors WHERE id = 'FEED_EONET_DEFAULT'`)
      .get() as { last_run_status: string; last_run_error: string }
    expect(row.last_run_status).toBe('error')
    expect(row.last_run_error).toContain('invalid feed URL')
  })

  it('skips a connector of unknown kind with a recorded error, without failing the run', async () => {
    const { env, sqlite } = setupEnv()
    sqlite
      .prepare(
        `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
         VALUES ('FEED_FUTURE', 'carrier-pigeon', 'Future feed', 'https://example.org/feed.xml', 'news', 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run()
    stubFeed(EONET_FEED)
    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as {
      created: number
      feeds: Array<{ id: string; error?: string }>
    }
    // EONET still ingests; the unknown-kind row reports its error.
    expect(body.created).toBe(2)
    const future = body.feeds.find(f => f.id === 'FEED_FUTURE')
    expect(future?.error).toContain('unknown connector kind')
    const row = sqlite
      .prepare(`SELECT last_run_status FROM feed_connectors WHERE id = 'FEED_FUTURE'`)
      .get() as { last_run_status: string }
    expect(row.last_run_status).toBe('error')
  })

  it('ingests an RSS connector — connector id as feedId, label as provenance', async () => {
    const { env, sqlite } = setupEnv()
    // Only the RSS connector is enabled, so the single fetch stub serves it.
    sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = 'FEED_EONET_DEFAULT'`).run()
    sqlite
      .prepare(
        `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
         VALUES ('FEED_RSS_01', 'rss', 'Example Environment', 'https://news.example.org/rss', 'news', 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run()
    const rssXml = `<rss version="2.0"><channel>
      <item>
        <title>Storm batters the coast</title>
        <link>https://news.example.org/storm</link>
        <guid>storm-1</guid>
        <pubDate>Tue, 30 Jun 2026 08:15:00 GMT</pubDate>
      </item>
    </channel></rss>`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => rssXml }) as unknown as Response),
    )

    const res = await refreshPost(ctx({ env }))
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as { created: number; feeds: Array<{ id: string; kind: string }> }
    expect(body.created).toBe(1)
    expect(body.feeds).toEqual([expect.objectContaining({ id: 'FEED_RSS_01', kind: 'rss', created: 1 })])

    const events = await listCurrentEvents(env.CATALOG_DB as Parameters<typeof listCurrentEvents>[0])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      title: 'Storm batters the coast',
      feed_id: 'FEED_RSS_01',
      external_id: 'storm-1',
      source_name: 'Example Environment',
      status: 'proposed',
    })
  })

  describe('a failed item', () => {
    function rssEnv(items: Array<{ guid: string; title: string }>) {
      const setup = setupEnv()
      setup.sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = 'FEED_EONET_DEFAULT'`).run()
      setup.sqlite
        .prepare(
          `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
           VALUES ('FEED_RSS_01', 'rss', 'Example Environment', 'https://news.example.org/rss', 'news', 1,
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
        )
        .run()
      const rssXml = `<rss version="2.0"><channel>${items
        .map(
          i => `<item><title>${i.title}</title><link>https://news.example.org/${i.guid}</link>` +
            `<guid>${i.guid}</guid></item>`,
        )
        .join('')}</channel></rss>`
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, text: async () => rssXml }) as unknown as Response),
      )
      vi.spyOn(console, 'error').mockImplementation(() => {})
      return setup
    }

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('is named in the summary with its error, and the rest still ingest', async () => {
      const { env, sqlite } = rssEnv([
        { guid: 'ok-1', title: 'Storm batters the coast' },
        { guid: 'bad-1', title: 'There are no tropical cyclones at this time.' },
      ])
      // A real insert failure for one item, as D1 would raise it.
      sqlite
        .prepare(
          `CREATE TRIGGER fail_one BEFORE INSERT ON current_events
           WHEN NEW.external_id = 'bad-1' BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`,
        )
        .run()

      const res = await refreshPost(ctx({ env }))
      expect(res.status).toBe(200)
      const body = JSON.parse(await res.text()) as {
        created: number
        failed: number
        feeds: Array<{ failed: number; failures?: Array<Record<string, unknown>> }>
      }
      expect(body.created).toBe(1)
      expect(body.failed).toBe(1)
      expect(body.feeds[0].failures).toEqual([
        {
          externalId: 'bad-1',
          title: 'There are no tropical cyclones at this time.',
          code: 'ingest_failed',
          message: expect.stringContaining('simulated insert failure'),
        },
      ])
      // The deployment's own logs carry it too.
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('bad-1'))
      // And the audit row, which stores the summary, keeps the reason.
      const audit = sqlite
        .prepare(`SELECT metadata_json FROM audit_events WHERE action = 'event.refreshed'`)
        .get() as { metadata_json: string }
      expect(audit.metadata_json).toContain('simulated insert failure')
    })

    it('leaves `failures` off a connector where nothing failed', async () => {
      const { env } = rssEnv([{ guid: 'ok-1', title: 'Storm batters the coast' }])
      const body = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as {
        feeds: Array<Record<string, unknown>>
      }
      expect(body.feeds[0]).not.toHaveProperty('failures')
    })

    it('says a body that fails validation is `invalid_item`, with its field errors', async () => {
      // `https://` passes the RSS mapper's scheme test but is not a URL,
      // so the create validation refuses it: a failure that repeats every
      // run, unlike a write that throws.
      const { env } = rssEnv([{ guid: 'ok-1', title: 'Storm batters the coast' }])
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          status: 200,
          text: async () =>
            `<rss version="2.0"><channel><item><title>Bad link</title><link>https://</link>` +
            `<guid>bad-link</guid></item></channel></rss>`,
        }) as unknown as Response),
      )
      const body = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as {
        failed: number
        feeds: Array<{ failures: Array<Record<string, unknown>> }>
      }
      expect(body.failed).toBe(1)
      expect(body.feeds[0].failures).toEqual([
        {
          externalId: 'bad-link',
          title: 'Bad link',
          code: 'invalid_item',
          message: 'source.url: invalid',
          errors: [expect.objectContaining({ field: 'source.url', code: 'invalid' })],
        },
      ])
    })

    it('puts a hostile error message on one line and cuts it short', async () => {
      const { env, sqlite } = rssEnv([{ guid: 'bad-1', title: 'Item' }])
      // A message with a line break in it, and far longer than the cap.
      sqlite
        .prepare(
          `CREATE TRIGGER fail_long BEFORE INSERT ON current_events
           BEGIN SELECT RAISE(ABORT, 'first line
::error::second line ${'x'.repeat(400)}'); END`,
        )
        .run()
      const body = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as {
        feeds: Array<{ failures: Array<{ message: string }> }>
      }
      const { message } = body.feeds[0].failures[0]
      expect(message).not.toMatch(/[\r\n]/)
      expect(message).toContain('first line ::error::second line')
      expect(Array.from(message)).toHaveLength(300)
      expect(message.endsWith('…')).toBe(true)
    })

    it('cuts a long message on a whole character, never inside one', async () => {
      const { env, sqlite } = rssEnv([{ guid: 'bad-1', title: 'Item' }])
      // An astral character straddles UTF-16 units 299 and 300, where a
      // plain .slice would leave half a surrogate pair.
      sqlite
        .prepare(
          `CREATE TRIGGER fail_astral BEFORE INSERT ON current_events
           BEGIN SELECT RAISE(ABORT, '${'x'.repeat(298)}🌀🌀🌀'); END`,
        )
        .run()
      const body = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as {
        feeds: Array<{ failures: Array<{ message: string }> }>
      }
      expect(body.feeds[0].failures[0].message).toBe(`${'x'.repeat(298)}🌀…`)
    })

    it('describes at most five per connector but counts them all', async () => {
      const items = Array.from({ length: 7 }, (_, n) => ({ guid: `bad-${n}`, title: `Item ${n}` }))
      const { env, sqlite } = rssEnv(items)
      sqlite
        .prepare(
          `CREATE TRIGGER fail_all BEFORE INSERT ON current_events
           BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`,
        )
        .run()

      const body = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as {
        failed: number
        feeds: Array<{ failed: number; failures: unknown[] }>
      }
      expect(body.failed).toBe(7)
      expect(body.feeds[0].failed).toBe(7)
      expect(body.feeds[0].failures).toHaveLength(5)
      // Every one is still logged, not just the five described.
      expect(console.error).toHaveBeenCalledTimes(7)
    })
  })

  it('ingests an item that repeats a category, and refreshes it again', async () => {
    // Decorations are sets. A repeat used to throw on the primary key
    // after the event row was written, and the refresh, which rewrites
    // the decorations, then threw on every later run too.
    const { env, sqlite } = setupEnv()
    sqlite.prepare(`UPDATE feed_connectors SET enabled = 0 WHERE id = 'FEED_EONET_DEFAULT'`).run()
    sqlite
      .prepare(
        `INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
         VALUES ('FEED_RSS_01', 'rss', 'Example Environment', 'https://news.example.org/rss', 'news', 1,
                 '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
      )
      .run()
    const rssXml = `<rss version="2.0"><channel><item>
        <title>Storm batters the coast</title>
        <link>https://news.example.org/storm</link>
        <guid>storm-1</guid>
        <category>Environment</category>
        <category>Environment</category>
      </item></channel></rss>`
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => rssXml }) as unknown as Response),
    )

    const first = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number; failed: number }
    expect(first).toMatchObject({ created: 1, failed: 0 })
    const second = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { refreshed: number; failed: number }
    expect(second).toMatchObject({ refreshed: 1, failed: 0 })

    const keywords = sqlite.prepare(`SELECT keyword FROM event_keywords`).all() as Array<{ keyword: string }>
    expect(keywords).toEqual([{ keyword: 'Environment' }])
  })

  it('ingests an EONET event that repeats a category title', async () => {
    // EONET's category titles become `event_categories` rows, the other
    // decoration set; the RSS case above covers `event_keywords`.
    const { env, sqlite } = setupEnv()
    const event = EONET_FEED.events[0]
    stubFeed({
      events: [
        {
          ...event,
          categories: [
            { id: 'wildfires', title: 'Wildfires' },
            { id: 'wildfires', title: 'Wildfires' },
          ],
        },
      ],
    })
    const first = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number; failed: number }
    expect(first).toMatchObject({ created: 1, failed: 0 })
    const second = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { refreshed: number; failed: number }
    expect(second).toMatchObject({ refreshed: 1, failed: 0 })
    const rows = sqlite.prepare(`SELECT facet, value FROM event_categories`).all()
    expect(rows).toEqual([{ facet: 'EONET', value: 'Wildfires' }])
  })

  it('is idempotent — a second pull refreshes instead of duplicating', async () => {
    const { env } = setupEnv()
    stubFeed(EONET_FEED)

    const first = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number }
    expect(first.created).toBe(2)

    const second = JSON.parse(await (await refreshPost(ctx({ env }))).text()) as { created: number; refreshed: number }
    expect(second.created).toBe(0)
    expect(second.refreshed).toBe(2)

    const events = await listCurrentEvents(env.CATALOG_DB as Parameters<typeof listCurrentEvents>[0])
    expect(events).toHaveLength(2)
  })
})
