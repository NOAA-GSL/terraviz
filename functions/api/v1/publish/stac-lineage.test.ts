// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPost } from './stac-lineage'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { makeCtx } from '../_lib/test-helpers'

const publicationId = `revision-${'a'.repeat(22)}`
const source = { href: 'https://data.example/source.nc', content_digest: `sha256:${'b'.repeat(64)}`,
  evidence_href: 'https://data.example/run.json', evidence_digest: `sha256:${'c'.repeat(64)}` }

function fixture() {
  const state = stacRouteFixture()
  state.sqlite.prepare(`INSERT INTO stac_history_publications
    (id,dataset_id,kind,source_key,model_json,captured_at) VALUES (?,?,'revision','source','{}','2026-09-29')`)
    .run(publicationId, state.ids[0])
  const context = (body?: unknown, query = '') => {
    const ctx = makeCtx({ env: state.env, url: `https://node.example/api/v1/publish/stac-lineage${query}`,
      method: body === undefined ? 'GET' : 'POST' })
    if (body !== undefined) ctx.request = new Request(ctx.request.url, { method: 'POST', body: JSON.stringify(body) }) as typeof ctx.request
    ctx.data = { publisher: { id: 'ADMIN', role: 'admin', is_admin: 1, status: 'active' } }
    return ctx as never
  }
  return { ...state, context }
}

describe('STAC source lineage backfill', () => {
  it('records reviewed evidence idempotently without enabling Processing and refuses replacement', async () => {
    const { sqlite, context } = fixture()
    try {
      expect(await (await onRequestGet(context())).json()).toMatchObject({ processing_enabled: false,
        records: [{ lineage_status: 'missing', sources: [] }] })
      const body = { publication_id: publicationId, reviewed: true, sources: [source] }
      expect((await onRequestPost(context(body))).status).toBe(201)
      expect((await onRequestPost(context(body))).status).toBe(200)
      expect((await onRequestPost(context({ ...body, sources: [{ ...source, content_digest: `sha256:${'d'.repeat(64)}` }] }))).status).toBe(409)
      const report = await onRequestGet(context())
      expect(report.headers.get('cache-control')).toBe('private, no-store')
      expect(await report.json()).toMatchObject({ processing_enabled: false, next_cursor: null,
        records: [{ publication_id: publicationId, lineage_status: 'operator_attested', recorded_by: 'ADMIN', sources: [source] }] })
      expect(() => sqlite.exec("UPDATE stac_source_lineage SET sources_json='[]'")).toThrow('immutable')
    } finally { sqlite.close() }
  })

  it.each([undefined, { role: 'publisher', status: 'active' }, { role: 'admin', status: 'suspended', is_admin: 1 }])(
    'rejects unauthorized access before reading D1: %j', async publisher => {
      const ctx = makeCtx({ env: {} })
      ctx.data = publisher ? { publisher } : {}
      for (const handler of [onRequestGet, onRequestPost]) {
        expect((await handler(ctx as never)).status).toBe(publisher ? 403 : 401)
      }
    })

  it.each([
    { reviewed: false }, { sources: [] }, { sources: [source, source] },
    { sources: [{ ...source, content_digest: 'unknown' }] },
    { sources: [{ ...source, href: 'https://data.example/source.nc?token=secret' }] },
    { sources: [{ ...source, evidence_href: 'http://localhost/private' }] },
    { sources: [{ ...source, href: 'https://user:secret@data.example/source.nc' }] },
    { sources: [{ ...source, processing: 'guessed' }] },
  ])('fails closed for incomplete or unsafe evidence: %j', async override => {
    const { sqlite, context } = fixture()
    try {
      expect((await onRequestPost(context({ publication_id: publicationId, reviewed: true, sources: [source], ...override }))).status).toBe(400)
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM stac_source_lineage').get()).toEqual({ count: 0 })
    } finally { sqlite.close() }
  })

  it('paginates missing-lineage inventory without skipping publications', async () => {
    const { sqlite, ids, context } = fixture()
    try {
      const insert = sqlite.prepare(`INSERT INTO stac_history_publications
        (id,dataset_id,kind,source_key,model_json,captured_at) VALUES (?,?,'revision',?,'{}','2026-09-29')`)
      for (let index = 0; index < 50; index++) insert.run(`revision-${String(index).padStart(22, '0')}`, ids[0], String(index))
      const first = await (await onRequestGet(context())).json() as { records: { publication_id: string }[]; next_cursor: string }
      expect(first.records).toHaveLength(50)
      expect(first.next_cursor).toBe(first.records.at(-1)!.publication_id)
      const second = await (await onRequestGet(context(undefined, `?cursor=${first.next_cursor}`))).json() as { records: { publication_id: string }[] }
      expect(second).toMatchObject({ next_cursor: null, records: [{ publication_id: publicationId }] })
    } finally { sqlite.close() }
  })

  it('rejects missing publications, oversized payloads and invalid query parameters', async () => {
    const { sqlite, context } = fixture()
    try {
      expect((await onRequestPost(context({ publication_id: `revision-${'f'.repeat(22)}`, reviewed: true, sources: [source] }))).status).toBe(404)
      expect((await onRequestPost(context({ padding: 'x'.repeat(65536) }))).status).toBe(413)
      expect((await onRequestGet(context(undefined, '?unknown=1'))).status).toBe(400)
      await expect((await onRequestGet(context(undefined, `?cursor=${publicationId}`))).json()).resolves.toMatchObject({ records: [] })
      const invalid = context({}) as Parameters<typeof onRequestPost>[0]
      invalid.request = new Request('https://node.example/api/v1/publish/stac-lineage', { method: 'POST', body: '{' }) as typeof invalid.request
      expect((await onRequestPost(invalid)).status).toBe(400)
    } finally { sqlite.close() }
  })

  it('returns a no-store error if lineage storage is unavailable', async () => {
    const { sqlite, context } = fixture()
    sqlite.close()
    const response = await onRequestGet(context())
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ error: 'stac_lineage_unavailable' })
  })
})