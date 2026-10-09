// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import { stacRouteFixture } from './stac-test-helpers'
import { historyInsertStatements, historyModels, linkHistoryRevisions, prepareFrameHistory, prepareWorkflowHistory, type StacHistoryPublication } from './stac-history'
import { readStacPublicationInput } from './stac-publication-store'
import { publishDataset } from './dataset-mutations'
import { readStacPublication } from './stac-publication'
import type { CatalogEnv } from './env'
import { serveStac } from './stac-http'
import { clearTranscoding } from './asset-uploads'

describe('immutable STAC history', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sequenceFixture(count = 1) {
    const fixture = stacRouteFixture(count)
    fixture.sqlite.exec(`UPDATE datasets SET slug='frame-sequence', frame_count=2, frame_extension='png',
      frame_source_filenames_ref='r2:manifest.json', period='P1D', format='video/mp4' WHERE id='${fixture.ids[0]}'`)
    const manifest = [{ index: 0, filename: 'one.png', digest: `sha256:${'a'.repeat(64)}` },
      { index: 1, filename: 'two.png', digest: `sha256:${'b'.repeat(64)}` }]
    const env: CatalogEnv = { ...fixture.env, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example',
      CATALOG_R2: { get: vi.fn(async () => ({ text: async () => JSON.stringify(manifest) })) } as unknown as R2Bucket }
    return { ...fixture, env, manifest }
  }

  it('publishes timestamped frame Items with stable IDs, merged extents and current access gates', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      const first = await readStacPublication(env)
      expect(first.products).toHaveLength(2)
      const itemIds = first.products.map(product => product.item!.id)
      expect(new Set(itemIds).size).toBe(2)
      expect(first.products.map(product => product.item!.properties.datetime)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'])
      expect(first.products[0].item!.assets.data.href).toContain(`/frames/sha256/${'a'.repeat(64)}.png`)
      expect(first.products[0].collection!.extent.temporal.interval).toEqual([['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']])
      expect(first.catalog.links.filter(link => link.rel === 'child')).toHaveLength(1)
      const collections = await serveStac(new Request('https://node.example/api/v1/stac/collections'), env)
      expect(await collections.json()).toMatchObject({ collections: [expect.objectContaining({ id: first.products[0].collection!.id })] })
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect((await readStacPublication(env)).products.map(product => product.item!.id)).toEqual(itemIds)
      sqlite.exec("UPDATE datasets SET title='New title', slug='new-slug'")
      const later = await readStacPublication(env)
      expect(later.products.map(product => product.item)).toEqual(first.products.map(product => product.item))
      expect(later.products[0].collection!.title).toBe('New title')
      sqlite.exec("UPDATE datasets SET visibility='private'")
      expect((await readStacPublication(env)).products).toEqual([])
      expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${itemIds[0]}`), env)).status).toBe(404)
    } finally { sqlite.close() }
  })

  it('keeps native publication independent of disabled capture and missing manifests', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    const get = vi.mocked(env.CATALOG_R2!.get)
    get.mockResolvedValue(null)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await publishDataset({ ...env, STAC_ENABLED: undefined, STAC_HISTORY_CAPTURE: undefined }, ids[0])).ok).toBe(true)
      expect(get).not.toHaveBeenCalled()
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('capture unavailable'), 'STAC frame manifest is missing or inconsistent')
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 0 })
    } finally { warning.mockRestore(); sqlite.close() }
  })

  it.each(["frame_source_filenames_ref='r2:new-manifest.json'", "start_time='2026-01-02T00:00:00Z', end_time='2026-01-03T00:00:00Z'"])(
    'withholds stale frames after skipped capture and recovers after recapture: %s', async change => {
      const { sqlite, ids, env } = sequenceFixture()
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
      try {
        await publishDataset(env, ids[0])
        const first = await readStacPublication(env)
        sqlite.exec(`UPDATE datasets SET ${change}`)
        expect((await publishDataset({ ...env, STAC_HISTORY_CAPTURE: undefined }, ids[0])).ok).toBe(true)
        vi.mocked(fetch).mockClear()
        for (const operatorReport of [false, true]) {
          const stale = await readStacPublication(env, { operatorReport })
          expect(stale.products).toEqual([])
          expect(stale.catalog.links.some(link => link.rel === 'child')).toBe(false)
          expect(stale.report).toEqual([{ id: ids[0], included: false, reasons: ['history_stale'], items_included: 0, items_total: 2 }])
        }
        expect(fetch).not.toHaveBeenCalled()
        expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${first.products[0].item!.id}`), env)).status).toBe(404)
        await publishDataset(env, ids[0])
        expect((await readStacPublication(env)).products).toHaveLength(2)
      } finally { sqlite.close() }
    })

  it.each(['image/jpeg', 'failure'])('does not capture unverified frame assets: %s', async result => {
    const { sqlite, ids, env } = sequenceFixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: result === 'failure' ? 503 : 200,
      headers: { 'content-type': result } })))
    try {
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 0 })
    } finally { warning.mockRestore(); sqlite.close() }
  })

  it.each(['disabled', 'missing', 'probe', 'transaction', 'concurrent'] as const)(
    'isolates stale frame history after %s capture without blocking native publication', async scenario => {
      const { sqlite, ids, env } = sequenceFixture(2)
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const batch = vi.spyOn(env.CATALOG_DB!, 'batch')
      try {
        await publishDataset(env, ids[0])
        const first = await readStacPublication(env)
        sqlite.prepare('UPDATE datasets SET frame_source_filenames_ref=? WHERE id=?').run('r2:new-manifest.json', ids[0])
        if (scenario === 'missing') vi.mocked(env.CATALOG_R2!.get).mockResolvedValueOnce(null)
        if (scenario === 'probe') vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }))
        if (scenario === 'transaction') batch.mockRejectedValueOnce(new Error('History storage unavailable'))
        if (scenario === 'concurrent') vi.mocked(fetch).mockImplementationOnce(async () => {
          sqlite.prepare("UPDATE datasets SET abstract='Concurrent edit' WHERE id=?").run(ids[0])
          return new Response(null, { headers: { 'content-type': 'image/png' } })
        })
        const captureEnv = scenario === 'disabled' ? { ...env, STAC_HISTORY_CAPTURE: undefined } : env
        expect((await publishDataset(captureEnv, ids[0])).ok).toBe(true)
        for (const operatorReport of [false, true]) {
          const result = await readStacPublication(env, { operatorReport })
          expect(result.products.map(product => product.item!.id)).toEqual([ids[1]])
          expect(result.report).toContainEqual({ id: ids[0], included: false, reasons: ['history_stale'], items_included: 0, items_total: 2 })
        }
        expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${first.products[0].item!.id}`), env)).status).toBe(404)
        expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
        await publishDataset(env, ids[0])
        expect((await readStacPublication(env)).products).toHaveLength(3)
      } finally { batch.mockRestore(); warning.mockRestore(); sqlite.close() }
    })

  it('retries the native write if optional history storage fails atomically', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    const batch = vi.spyOn(env.CATALOG_DB!, 'batch').mockRejectedValueOnce(new Error('History storage unavailable'))
    try {
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 0 })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('history transaction failed'), 'History storage unavailable')
    } finally { batch.mockRestore(); warning.mockRestore(); sqlite.close() }
  })

  it('reads only the capture dataset and no prior history', async () => {
    const { sqlite, ids, env } = stacRouteFixture(3)
    try {
      sqlite.prepare(`INSERT INTO stac_history_publications (id,dataset_id,kind,source_key,model_json,captured_at)
        VALUES ('ignored',?,'frame','ignored','{}','2026-01-01')`).run(ids[0])
      const input = await readStacPublicationInput(env.CATALOG_DB, true, ids[1])
      expect(input.datasets.map(dataset => dataset.row.id)).toEqual([ids[1]])
      expect(input.history).toEqual([])
    } finally { sqlite.close() }
  })

  it('does not mint frames for descriptive edits and projects corrected Collection metadata immediately', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      await publishDataset(env, ids[0])
      const first = await readStacPublication(env)
      sqlite.exec("UPDATE datasets SET title='Corrected title', abstract='Corrected description', license_spdx='CC0-1.0', attribution_text='Corrected attribution'")
      const edited = await readStacPublication(env)
      expect(edited.products[0].collection).toMatchObject({ title: 'Corrected title', description: 'Corrected description',
        license: 'CC0-1.0', 'terraviz:attribution': 'Corrected attribution' })
      for (const [index, product] of edited.products.entries()) {
        expect(product.item).toMatchObject({ id: first.products[index].item!.id, geometry: first.products[index].item!.geometry,
          assets: first.products[index].item!.assets, properties: { datetime: first.products[index].item!.properties.datetime,
            title: first.products[index].item!.properties.title, license: 'CC0-1.0', 'terraviz:attribution': 'Corrected attribution' } })
      }
      await publishDataset(env, ids[0])
      expect((await readStacPublication(env)).products.map(product => product.item!.id)).toEqual(first.products.map(product => product.item!.id))
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
      sqlite.exec("UPDATE datasets SET start_time='2026-01-03T00:00:00Z', end_time='2026-01-04T00:00:00Z'")
      await publishDataset(env, ids[0])
      const revised = await readStacPublication(env)
      expect(revised.products).toHaveLength(2)
      expect(revised.products.map(product => product.item!.properties.datetime)).toEqual(['2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z'])
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 2 })
    } finally { sqlite.close() }
  })

  it('skips a snapshot if parent metadata changes while frame assets are read', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      const row = (await readStacPublicationInput(env.CATALOG_DB!, true)).datasets[0].row
      const publication = (await prepareFrameHistory(env, row, '2026-09-29T00:00:00Z'))!
      sqlite.exec("UPDATE datasets SET title='Concurrent edit'")
      await env.CATALOG_DB!.batch(historyInsertStatements(env.CATALOG_DB!, publication))
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 0 })
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_items').get()).toEqual({ total: 0 })
      expect(publication.dataset_id).toBe(ids[0])
    } finally { sqlite.close() }
  })

  it.each(["temporal_semantics='unknown'", "period='PT0S'", "end_time='2026-01-01T00:00:00Z'", "visibility='private'", 'is_hidden=1'])(
    'does not invent frame time when %s', async change => {
      const { sqlite, env } = sequenceFixture()
      try {
        sqlite.exec(`UPDATE datasets SET ${change}`)
        const row = (await readStacPublicationInput(env.CATALOG_DB!, true)).datasets[0].row
        expect(await prepareFrameHistory(env, row, '2026-09-29T00:00:00Z')).toBeNull()
      } finally { sqlite.close() }
    })

  it('retains workflow revisions across bundle swaps and makes completion atomic', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    const configured: CatalogEnv = { ...env, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example' }
    const uploadId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })))
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','publisher@example.test','Publisher','service','active','2026-01-01');
        INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
        SELECT 'WF','PUB','Recurring','{}','{}','P1D',id,'2026-01-01','2026-01-01' FROM datasets;
        UPDATE datasets SET slug='workflow-output', format='video/mp4', transcoding=1, active_transcode_upload_id='${uploadId}'`)
      const before = (await readStacPublicationInput(env.CATALOG_DB, true)).datasets[0].row
      const now = '2026-09-29T00:00:00Z'
      const completed = { ...before, data_ref: `r2:videos/${ids[0]}/${uploadId}/master.m3u8`, transcoding: null,
        content_digest: null, active_transcode_upload_id: null, updated_at: now }
      const prepared = (await prepareWorkflowHistory(configured, completed, now))!
      expect(prepared).not.toBeNull()
      expect(await clearTranscoding(env.CATALOG_DB, ids[0], uploadId, completed.data_ref, now, null,
        historyInsertStatements(env.CATALOG_DB, prepared, before))).toBe(1)
      const first = await readStacPublication(configured)
      expect(first.products).toHaveLength(1)
      expect(first.products[0].item!.id).toContain('-revision-')
      expect(first.products[0].item!.assets.data).not.toHaveProperty('file:checksum')
      sqlite.exec("UPDATE datasets SET title='Corrected workflow title', abstract='Corrected description'")
      expect((await publishDataset(configured, ids[0])).ok).toBe(true)
      const corrected = await readStacPublication(configured)
      expect(corrected.products[0].item).toEqual(first.products[0].item)
      expect(corrected.products[0].collection!.title).toBe('Corrected workflow title')
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
      const secondUpload = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
      sqlite.prepare('UPDATE datasets SET data_ref=?, start_time=?, end_time=?').run(
        `r2:videos/${ids[0]}/${secondUpload}/master.m3u8`, '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z')
      expect((await publishDataset(configured, ids[0])).ok).toBe(true)
      expect((await publishDataset(configured, ids[0])).ok).toBe(true)
      const later = await readStacPublication(configured)
      expect(later.products).toHaveLength(2)
      const oldItem = later.products.find(product => product.item!.id === first.products[0].item!.id)!.item!
      expect({ ...oldItem, links: first.products[0].item!.links }).toEqual(first.products[0].item)
      const newItem = later.products.find(product => product.item!.id !== oldItem.id)!.item!
      expect(oldItem.links).toEqual(expect.arrayContaining([
        expect.objectContaining({ rel: 'successor-version', href: newItem.links.find(link => link.rel === 'self')!.href }),
        expect.objectContaining({ rel: 'latest-version', href: newItem.links.find(link => link.rel === 'self')!.href }),
      ]))
      expect(newItem.links).toContainEqual(expect.objectContaining({ rel: 'predecessor-version', href: oldItem.links.find(link => link.rel === 'self')!.href }))
      const history = (await readStacPublicationInput(env.CATALOG_DB, true)).history
      const unlinked = structuredClone(later.products)
      for (const product of unlinked) product.item!.links = product.item!.links.filter(link => !link.rel.endsWith('-version'))
      linkHistoryRevisions(unlinked, history.map(publication => ({ ...publication, captured_at: now })))
      expect(unlinked.every(product => product.item!.links.every(link => !link.rel.endsWith('-version')))).toBe(true)
      linkHistoryRevisions([unlinked[0]], history)
      expect(unlinked[0].item!.links.every(link => !link.rel.endsWith('-version'))).toBe(true)
      const current = (await readStacPublicationInput(env.CATALOG_DB, true)).datasets[0].row
      expect(await prepareWorkflowHistory(configured, { ...current, data_ref: 'url:https://data.example/latest.mp4' }, now)).toBeNull()
      expect(await prepareWorkflowHistory(configured, { ...current, transcoding: 1 }, now)).toBeNull()
      expect(await prepareWorkflowHistory(configured, { ...current, visibility: 'private' }, now)).toBeNull()
      sqlite.prepare('UPDATE datasets SET data_ref=?').run(`r2:videos/${ids[0]}/01ARZ3NDEKTSV4RRFFQ69G5FAX/master.m3u8`)
      expect((await publishDataset({ ...configured, STAC_HISTORY_CAPTURE: undefined }, ids[0])).ok).toBe(true)
      for (const operatorReport of [false, true]) {
        const stale = await readStacPublication(configured, { operatorReport })
        expect(stale.products).toEqual([])
        expect(stale.report).toEqual([{ id: ids[0], included: false, reasons: ['history_stale'], items_included: 0, items_total: 3 }])
      }
      expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${oldItem.id}`), configured)).status).toBe(404)
      await publishDataset(configured, ids[0])
      expect((await readStacPublication(configured)).products).toHaveLength(3)
    } finally { sqlite.close() }
  })

  it('serves a 45-frame sequence from persisted verification without request-time HEADs', async () => {
    const { sqlite, ids, env, manifest } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      manifest.splice(0, manifest.length, ...Array.from({ length: 45 }, (_, index) => ({ index,
        filename: `${index}.png`, digest: `sha256:${index.toString(16).padStart(64, '0')}` })))
      sqlite.exec("UPDATE datasets SET frame_count=45, end_time='2026-02-14T00:00:00Z'")
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(45)
      vi.mocked(fetch).mockClear()
      const publication = await readStacPublication(env)
      expect(publication.products).toHaveLength(45)
      expect(publication.publicationIssues).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
      const changedHost = await readStacPublication({ ...env, R2_PUBLIC_BASE: 'http://untrusted.example' })
      expect(changedHost.products).toHaveLength(0)
    } finally { sqlite.close() }
  })

  it('reports partial Item inclusion and withholds legacy unverified frames without probing', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      const row = (await readStacPublicationInput(env.CATALOG_DB!, true)).datasets[0].row
      const publication = (await prepareFrameHistory(env, row, '2026-09-29T00:00:00Z'))!
      const saved = JSON.parse(publication.model_json)
      saved.verifiedFrameAssets = saved.verifiedFrameAssets.slice(0, 1)
      publication.model_json = JSON.stringify(saved)
      await env.CATALOG_DB!.batch(historyInsertStatements(env.CATALOG_DB!, publication))
      vi.mocked(fetch).mockClear()
      const result = await readStacPublication(env)
      expect(result.products).toHaveLength(1)
      expect(result.report).toEqual([expect.objectContaining({ id: ids[0], included: true,
        items_included: 1, items_total: 2, reasons: expect.arrayContaining(['frame_verification_required']) })])
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('persists idempotent Items and prevents historical metadata mutation', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const model = (await readStacPublicationInput(env.CATALOG_DB)).datasets[0]
      const publication: StacHistoryPublication = { id: 'frames-one', dataset_id: ids[0], kind: 'frame', source_key: 'one',
        captured_at: '2026-09-29T00:00:00Z', model_json: JSON.stringify(model), items: [{ id: 'frame-one', ordinal: 0,
          data_ref: 'r2:immutable.png', content_digest: `sha256:${'a'.repeat(64)}`, format: 'image/png',
          start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:00:00Z' }] }
      await env.CATALOG_DB.batch(historyInsertStatements(env.CATALOG_DB, publication))
      await env.CATALOG_DB.batch(historyInsertStatements(env.CATALOG_DB, publication))
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_items').get()).toEqual({ total: 1 })
      expect(() => sqlite.exec("UPDATE stac_history_items SET start_time='2020-01-01'" )).toThrow('immutable')
      expect(() => sqlite.exec("UPDATE stac_history_publications SET model_json='{}'" )).toThrow('immutable')
      const historical = historyModels(publication, { ...model.row, title: 'Changed', visibility: 'private' })[0]
      expect(historical.row.title).toBe(model.row.title)
      expect(historical.row.visibility).toBe('private')
      expect(historical.row.start_time).toBe('2026-01-01T00:00:00Z')
      expect(historical.itemIdentity).toEqual({ kind: 'frame', persisted_id: 'frame-one' })
    } finally { sqlite.close() }
  })
})