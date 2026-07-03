/**
 * Tests for POST /api/v1/publish/blog/generate — the AI blog-draft
 * endpoint (Phase 3d).
 *
 * Wire-level: privileged gate, no-datasets 400, unknown-event 404,
 * no-AI 503, unparseable-reply 502, the happy path (grounded prompt
 * carries profile + event + dataset facts; draft returned, nothing
 * persisted), the companion-tour path (tour draft persisted via the
 * normal pipeline; failure never sinks the draft), and the
 * blog.generate audit row. Pure: prompt building + reply parsing.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestPost as generate } from './generate'
import { buildBlogPrompt, parseDraftReply } from '../../_lib/blog-generate'
import { asD1, makeKV, seedFixtures } from '../../_lib/test-helpers'
import { insertCurrentEvent } from '../../_lib/events-store'
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
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const DS_0 = 'DS000' + 'A'.repeat(21)
const DS_1 = 'DS001' + 'A'.repeat(21)

interface BucketState {
  puts: Map<string, string>
}

function makeBucket(state: BucketState): R2Bucket {
  return {
    put: async (key: string, body: ReadableStream | string | ArrayBuffer | null) => {
      state.puts.set(key, typeof body === 'string' ? body : '')
      return {} as unknown as R2Object
    },
    get: async () => null,
  } as unknown as R2Bucket
}

const DRAFT_REPLY = JSON.stringify({
  title: 'Watching the Gulf warm',
  summary: 'Three decades of SST in one loop.',
  bodyMd: '## The data\nWe looked at the loop...',
})

function aiStub(reply: unknown = { response: DRAFT_REPLY }) {
  return { run: vi.fn(async (_model: string, _inputs: Record<string, unknown>) => reply) }
}

function setupEnv(ai?: ReturnType<typeof aiStub>) {
  const sqlite = seedFixtures({ count: 2 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  // A node profile so the prompt grounding is observable.
  sqlite
    .prepare(
      `INSERT INTO node_profile (id, org_name, mission, default_tone, updated_by, updated_at)
       VALUES (1, 'Coastal Science Center', 'Connect visitors with live ocean data.', 'educational', ?, ?)`,
    )
    .run(ADMIN.id, '2026-07-01T00:00:00.000Z')
  const bucket: BucketState = { puts: new Map() }
  return {
    sqlite,
    bucket,
    env: {
      CATALOG_DB: asD1(sqlite),
      CATALOG_KV: makeKV(),
      CATALOG_R2: makeBucket(bucket),
      ...(ai ? { AI: ai } : {}),
    },
  }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; body?: unknown }) {
  const url = 'https://localhost/api/v1/publish/blog/generate'
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? {}),
    }),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof generate>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST /api/v1/publish/blog/generate', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setupEnv(aiStub())
    const res = await generate(ctx({ env, publisher: PUBLISHER, body: { datasetIds: [DS_0] } }))
    expect(res.status).toBe(403)
  })

  it('400 when no datasets are selected (or none are visible)', async () => {
    const { env, sqlite } = setupEnv(aiStub())
    let res = await generate(ctx({ env, body: { datasetIds: [] } }))
    expect(res.status).toBe(400)
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(DS_0)
    res = await generate(ctx({ env, body: { datasetIds: [DS_0] } }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('no_datasets')
  })

  it('404 for an unknown cited event', async () => {
    const { env } = setupEnv(aiStub())
    const res = await generate(ctx({ env, body: { datasetIds: [DS_0], eventId: 'NOPE00000000000000000000A' } }))
    expect(res.status).toBe(404)
  })

  it('503 when Workers AI is unbound', async () => {
    const { env } = setupEnv()
    const res = await generate(ctx({ env, body: { datasetIds: [DS_0] } }))
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('ai_unavailable')
  })

  it('502 when the model reply cannot be parsed into a draft', async () => {
    const { env } = setupEnv(aiStub({ response: 'sorry, no json here' }))
    const res = await generate(ctx({ env, body: { datasetIds: [DS_0] } }))
    expect(res.status).toBe(502)
    expect((await readJson<{ error: string }>(res)).error).toBe('generation_failed')
  })

  it('200: returns the draft, grounds the prompt, persists nothing, audits', async () => {
    const ai = aiStub()
    const { env, sqlite } = setupEnv(ai)
    const ev = await insertCurrentEvent(env.CATALOG_DB, {
      originNode: 'NODE000',
      title: 'Gulf marine heatwave',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/heatwave',
    })
    const res = await generate(ctx({ env, body: { datasetIds: [DS_0, DS_1], eventId: ev.id, length: 'short' } }))
    expect(res.status).toBe(200)
    const { draft, tour } = await readJson<{ draft: { title: string; bodyMd: string }; tour: unknown }>(res)
    expect(draft.title).toBe('Watching the Gulf warm')
    expect(draft.bodyMd).toContain('The data')
    expect(tour).toBeNull()

    // The prompt carried the profile, the event citation, and the
    // dataset titles — the grounding contract.
    const inputs = ai.run.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> }
    const user = inputs.messages.find(m => m.role === 'user')!.content
    expect(user).toContain('Coastal Science Center')
    expect(user).toContain('Gulf marine heatwave')
    expect(user).toContain('https://example.gov/heatwave')
    expect(user).toContain('Test Dataset 0')
    const system = inputs.messages.find(m => m.role === 'system')!.content
    expect(system).toContain('250 words')
    expect(system).toContain('educational')

    // Nothing persisted; one audit row.
    const posts = sqlite.prepare('SELECT COUNT(*) AS n FROM blog_posts').get() as { n: number }
    expect(posts.n).toBe(0)
    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'blog.generate'`)
      .get() as { n: number }
    expect(audit.n).toBe(1)
  })

  it('includeTour persists a companion tour draft over the selected datasets', async () => {
    const { env, bucket, sqlite } = setupEnv(aiStub())
    const ev = await insertCurrentEvent(env.CATALOG_DB, {
      originNode: 'NODE000',
      title: 'Gulf marine heatwave',
      sourceName: 'NOAA',
      sourceUrl: 'https://example.gov/heatwave',
      occurredStart: '2026-06-25T12:00:00.000Z',
      geometry: { point: { lat: 25.5, lon: -80.2 } },
    })
    const res = await generate(
      ctx({ env, body: { datasetIds: [DS_0], eventId: ev.id, includeTour: true } }),
    )
    expect(res.status).toBe(200)
    const { tour, tourError } = await readJson<{ tour: { id: string } | null; tourError: string | null }>(res)
    expect(tourError).toBeNull()
    expect(tour).toBeTruthy()

    const row = sqlite
      .prepare('SELECT id, published_at FROM tours WHERE id = ?')
      .get(tour!.id) as { id: string; published_at: string | null }
    expect(row.published_at).toBeNull()
    const blob = bucket.puts.get(`tours/${tour!.id}/draft.json`)
    expect(blob).toBeTruthy()
    const file = JSON.parse(blob!) as { tourTasks: Array<Record<string, unknown>> }
    expect(file.tourTasks.some(t => 'loadDataset' in t)).toBe(true)
    expect(file.tourTasks.some(t => 'setTime' in t)).toBe(true)
  })

  it('includeTour without an event returns the draft plus a tourError', async () => {
    const { env } = setupEnv(aiStub())
    const res = await generate(ctx({ env, body: { datasetIds: [DS_0], includeTour: true } }))
    expect(res.status).toBe(200)
    const { draft, tour, tourError } = await readJson<{ draft: unknown; tour: unknown; tourError: string }>(res)
    expect(draft).toBeTruthy()
    expect(tour).toBeNull()
    expect(tourError).toContain('cited event')
  })
})

describe('buildBlogPrompt / parseDraftReply', () => {
  it('falls back to a default tone and clips oversized fields on parse', () => {
    const { system } = buildBlogPrompt({ profile: null, event: null, datasets: [{ id: 'x', title: 'T', abstract: null }] })
    expect(system).toContain('curious, educational')

    const parsed = parseDraftReply(
      `Sure! Here you go: ${JSON.stringify({ title: 'y'.repeat(300), summary: 's', bodyMd: 'b' })}`,
    )
    expect(parsed?.title).toHaveLength(200)
    expect(parseDraftReply('no json at all')).toBeNull()
    expect(parseDraftReply(JSON.stringify({ title: 'x', summary: 's' }))).toBeNull() // no body
  })
})
