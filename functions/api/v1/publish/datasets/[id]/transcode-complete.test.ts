// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `POST /api/v1/publish/datasets/{id}/transcode-complete`.
 *
 * The endpoint is the workflow side of the 3pd transcode pipeline:
 * GHA writes the HLS bundle to R2 under
 * `videos/{datasetId}/{uploadId}/`, then POSTs back through this
 * route to flip `data_ref` and clear `transcoding`. The server
 * constructs `data_ref` itself from the route id + upload id, so
 * the workflow can't accidentally PATCH dataset A with dataset B's
 * bundle (Phase 3pd review fix #3).
 *
 * Restricted to privileged callers (service token / admin) —
 * publisher- and readonly-role accounts shouldn't be able to
 * manipulate the `transcoding` column directly.
 */

import { describe, expect, it, vi } from 'vitest'
import { onRequestPost as transcodeComplete } from './transcode-complete'
import { asD1, makeKV, seedFixtures } from '../../../_lib/test-helpers'
import type { PublisherRow } from '../../../_lib/publisher-store'
import { publishDataset } from '../../../_lib/dataset-mutations'
import { readStacPublication } from '../../../_lib/stac-publication'
import { serveStac } from '../../../_lib/stac-http'
import { stacRouteFixture } from '../../../_lib/stac-test-helpers'
import { abandonTranscoding, stampTranscodingForVideoSource, type AssetUploadRow } from '../../../_lib/asset-uploads'

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

const SERVICE: PublisherRow = {
  ...ADMIN,
  id: 'PUB-SERVICE',
  email: 'transcode@service',
  display_name: 'Transcode service',
  role: 'service',
  is_admin: 0,
}

const PUBLISHER: PublisherRow = {
  ...ADMIN,
  id: 'PUB-PUBLISHER',
  email: 'publisher@example.com',
  display_name: 'Publisher',
  role: 'publisher',
  is_admin: 0,
}

// ULIDs are Crockford base32 — `U`, `I`, `L`, `O` are excluded.
// `DS000` (D, S, 0) and `KP000` (K, P, 0) all live inside the
// allowed set so the route's regex check accepts them.
const DATASET_ID = 'DS000' + 'A'.repeat(21)
const UPLOAD_ID = 'KP000' + 'A'.repeat(21)
const DEFAULT_SOURCE_DIGEST = 'sha256:' + 'a'.repeat(64)

function setupEnv(opts: {
  transcoding?: boolean
  sourceDigest?: string
  /** Seed the matching asset_uploads row. Defaults to true.
   *  Tests that want to exercise the "upload not found" branch
   *  pass `false`. */
  seedUpload?: boolean
  /** Override the seeded upload's `target_ref` (for the
   *  "upload_kind_mismatch" branch). */
  uploadTargetRef?: string
  /** Override the seeded upload's `kind`. */
  uploadKind?: 'data' | 'thumbnail'
  /** Override the seeded upload's `mime`. Frames uploads use
   *  `image/png` etc. instead of `video/mp4`. */
  uploadMime?: string
  /** Set the seeded upload's `frame_count` column. Triggers the
   *  frames-source completion branch in `transcode-complete`
   *  (Phase 3pf). MP4 sources leave this NULL. */
  uploadFrameCount?: number | null
  /** Override the seeded `datasets.active_transcode_upload_id`.
   *  Defaults to UPLOAD_ID. Pass another ULID to simulate a
   *  superseding upload, or `null` to simulate a pre-0012 row. */
  activeUploadId?: string | null
} = {}) {
  const sqlite = seedFixtures({ count: 1 })
  for (const p of [ADMIN, SERVICE, PUBLISHER]) {
    sqlite
      .prepare(
        `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
  }
  const sourceDigest = opts.sourceDigest ?? DEFAULT_SOURCE_DIGEST
  // The active-upload-id binding (migration 0012) defaults to the
  // canonical UPLOAD_ID so the happy-path tests below don't have to
  // pass it explicitly. Tests that exercise the mismatch branch
  // override `activeUploadId` (to a different id) or pass the
  // sentinel `null` to clear it (simulating a row that was
  // transcoding before the migration shipped).
  const activeUploadId =
    opts.activeUploadId === null
      ? null
      : opts.activeUploadId ?? UPLOAD_ID
  if (opts.transcoding ?? true) {
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = 1,
               active_transcode_upload_id = ?,
               data_ref = '',
               source_digest = ?
         WHERE id = ?`,
      )
      .run(activeUploadId, sourceDigest, DATASET_ID)
  }
  if (opts.seedUpload ?? true) {
    sqlite
      .prepare(
        `INSERT INTO asset_uploads
           (id, dataset_id, publisher_id, kind, target, target_ref, mime,
            declared_size, claimed_digest, status, failure_reason,
            created_at, completed_at, frame_count)
         VALUES (?, ?, ?, ?, 'r2', ?, ?, 1000, ?, 'completed', NULL, ?, ?, ?)`,
      )
      .run(
        UPLOAD_ID,
        DATASET_ID,
        ADMIN.id,
        opts.uploadKind ?? 'data',
        opts.uploadTargetRef ?? `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/source.mp4`,
        opts.uploadMime ?? 'video/mp4',
        sourceDigest,
        '2026-04-29T12:00:00.000Z',
        '2026-04-29T12:01:00.000Z',
        opts.uploadFrameCount ?? null,
      )
  }
  return {
    sqlite,
    datasetId: DATASET_ID,
    uploadId: UPLOAD_ID,
    env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() },
  }
}

function ctx(opts: {
  env: Record<string, unknown>
  datasetId: string
  publisher?: PublisherRow
  body?: unknown
}) {
  const url = `https://localhost/api/v1/publish/datasets/${opts.datasetId}/transcode-complete`
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env: opts.env,
    params: { id: opts.datasetId },
    data: { publisher: opts.publisher ?? SERVICE },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof transcodeComplete>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('POST .../transcode-complete — happy path', () => {
  it.each(['metadata', 'transaction', 'disabled', 'abandoned', 'new-source', 'new-source-failed'] as const)(
    'withholds old workflow revisions when the next callback skips capture: %s', async scenario => {
      const { sqlite, ids, env } = stacRouteFixture()
      const datasetId = ids[0], uploadId = UPLOAD_ID
      const configured = { ...env, STAC_ENABLED: 'true', STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example' }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })))
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
          VALUES ('${ADMIN.id}','admin@example.com','Admin','admin','active','2026-01-01');
          INSERT INTO asset_uploads (id,dataset_id,publisher_id,kind,target,target_ref,mime,declared_size,claimed_digest,status,created_at)
          VALUES ('${uploadId}','${datasetId}','${ADMIN.id}','data','r2','r2:uploads/${datasetId}/${uploadId}/source.mp4',
            'video/mp4',1000,'${DEFAULT_SOURCE_DIGEST}','completed','2026-01-01');
          INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
          VALUES ('WF','${ADMIN.id}','Recurring','{}','{}','P1D','${datasetId}','2026-01-01','2026-01-01');
          UPDATE datasets SET title='Workflow output', abstract='Measured field', slug='workflow-output', format='video/mp4',
          visibility='public', is_hidden=0, retracted_at=NULL, transcoding=NULL, active_transcode_upload_id=NULL, thumbnail_ref=NULL,
          published_at='2026-01-01T00:00:00Z', resource_kind='product', content_digest=NULL, source_digest='${DEFAULT_SOURCE_DIGEST}', license_spdx='CC0-1.0',
          temporal_semantics='represented', temporal_evidence='Source metadata',
          bbox_provenance='measured', bbox_evidence='Source metadata', bbox_n=30, bbox_s=-30, bbox_w=-60, bbox_e=60,
          start_time='2026-01-01T00:00:00Z', end_time='2026-01-02T00:00:00Z',
          data_ref='r2:videos/${datasetId}/01ARZ3NDEKTSV4RRFFQ69G5FAV/master.m3u8'`)
        expect((await publishDataset(configured, datasetId)).ok).toBe(true)
        const first = await readStacPublication(configured)
        expect(first.report).toEqual([{ id: datasetId, included: true, reasons: [], items_included: 1, items_total: 1 }])
        expect(first.products).toHaveLength(1)
        const digest = scenario.startsWith('new-source') ? `sha256:${'b'.repeat(64)}` : DEFAULT_SOURCE_DIGEST
        sqlite.prepare('UPDATE asset_uploads SET claimed_digest=? WHERE id=?').run(digest, uploadId)
        const upload = await env.CATALOG_DB.prepare('SELECT * FROM asset_uploads WHERE id=?').bind(uploadId).first<AssetUploadRow>()
        if (scenario !== 'abandoned') sqlite.exec("UPDATE datasets SET start_time='2026-02-01T00:00:00Z', end_time='2026-02-02T00:00:00Z'")
        expect(await stampTranscodingForVideoSource(env.CATALOG_DB, datasetId, upload!, '2026-10-02T12:00:00Z')).toBe(1)
        if (scenario === 'new-source-failed') {
          expect(await abandonTranscoding(env.CATALOG_DB, datasetId, uploadId, '2026-10-02T12:01:00Z')).toBe(1)
          expect((await publishDataset(configured, datasetId)).ok).toBe(true)
          const stale = await readStacPublication(configured, { operatorReport: true })
          expect(stale.report[0].reasons).toEqual(['history_stale', 'spatial_unknown', 'temporal_unknown'])
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
          sqlite.exec("UPDATE datasets SET start_time='2026-01-01T00:00:00Z', end_time='2026-01-02T00:00:00Z', temporal_semantics='represented', temporal_evidence='Source metadata', bbox_provenance='measured', bbox_evidence='Source metadata'")
          expect((await publishDataset(configured, datasetId)).ok).toBe(true)
          expect((await readStacPublication(configured)).products[0].item).toEqual(first.products[0].item)
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
          return
        }
        if (scenario === 'abandoned') {
          expect((await readStacPublication(configured)).products.map(product => product.item!.id)).toEqual([first.products[0].item!.id])
          expect(await abandonTranscoding(env.CATALOG_DB, datasetId, uploadId, '2026-10-02T12:01:00Z')).toBe(1)
          expect(sqlite.prepare('SELECT source_digest FROM datasets').get()).toEqual({ source_digest: null })
          expect((await readStacPublication(configured)).report[0]).toMatchObject({ included: true, reasons: [], items_included: 1, items_total: 1 })
          expect((await publishDataset(configured, datasetId)).ok).toBe(true)
          const unchanged = await readStacPublication(configured)
          expect(unchanged.products[0].item).toEqual(first.products[0].item)
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
          return
        }
        const originalBatch = env.CATALOG_DB.batch.bind(env.CATALOG_DB)
        const batch = vi.spyOn(env.CATALOG_DB, 'batch')
        if (scenario === 'transaction') batch.mockRejectedValueOnce(new Error('History transaction unavailable'))
        if (scenario === 'metadata') batch.mockImplementationOnce(async statements => {
          sqlite.exec("UPDATE datasets SET abstract='Concurrent correction', updated_at='2026-10-01T12:00:00Z'")
          return originalBatch(statements)
        })
        try {
          const response = await transcodeComplete(ctx({ env: { ...configured,
            STAC_HISTORY_CAPTURE: scenario === 'disabled' ? undefined : 'true' }, datasetId,
            body: { upload_id: uploadId, source_digest: digest } }))
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ dataset: { transcoding: null,
            data_ref: `r2:videos/${datasetId}/${uploadId}/master.m3u8` } })
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
          for (const operatorReport of [false, true]) {
            const stale = await readStacPublication(configured, { operatorReport })
            expect(stale.products).toEqual([])
            expect(stale.report).toEqual([{ id: datasetId, included: false,
              reasons: scenario === 'new-source' ? ['history_stale', 'spatial_unknown', 'temporal_unknown'] : ['history_stale'],
              items_included: 0, items_total: 2 }])
          }
          expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${first.products[0].item!.id}`), configured)).status).toBe(404)
        } finally { batch.mockRestore() }
        if (scenario === 'new-source') {
          expect(warning).toHaveBeenCalledWith('[stac-history] capture skipped for published dataset:', datasetId,
            expect.stringMatching(/spatial_unknown.*temporal_unknown/))
          warning.mockClear()
          expect((await publishDataset(configured, datasetId)).ok).toBe(true)
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
          expect((await readStacPublication(configured, { operatorReport: true })).report[0].reasons)
            .toEqual(['history_stale', 'spatial_unknown', 'temporal_unknown'])
          expect(warning).toHaveBeenCalledWith('[stac-history] capture skipped for published dataset:', datasetId,
            expect.stringMatching(/spatial_unknown.*temporal_unknown/))
          sqlite.exec("UPDATE datasets SET temporal_semantics='represented', temporal_evidence='New source metadata', bbox_provenance='measured', bbox_evidence='New source metadata'")
        }
        expect((await publishDataset(configured, datasetId)).ok).toBe(true)
        const recovered = await readStacPublication(configured)
        expect(recovered.products).toHaveLength(2)
        expect(recovered.report[0].reasons).toEqual([])
      } finally { warning.mockRestore(); vi.unstubAllGlobals(); sqlite.close() }
    })

  it.each(['superseded', 'metadata', 'missing', 'disabled', 'verified'] as const)(
    'preserves native completion semantics during history capture: %s', async scenario => {
      const { sqlite, datasetId, uploadId, env } = setupEnv({ uploadMime: 'image/png', uploadFrameCount: 2,
        uploadTargetRef: `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/frames/` })
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
      const get = vi.fn(async () => {
        if (scenario === 'superseded') sqlite.prepare('UPDATE datasets SET active_transcode_upload_id=?').run('NEW00' + 'A'.repeat(21))
        if (scenario === 'metadata') sqlite.exec("UPDATE datasets SET abstract='Concurrent edit', updated_at='2026-09-29T22:00:00Z'")
        if (scenario === 'missing') return null
        return { text: async () => JSON.stringify([0, 1].map(index => ({ index, filename: `${index}.png`,
          digest: `sha256:${String(index).repeat(64)}` }))) }
      })
      try {
        sqlite.exec(`UPDATE datasets SET visibility='public', is_hidden=0, retracted_at=NULL,
          published_at='2026-01-01T00:00:00Z', resource_kind='product',
          temporal_semantics='represented', temporal_evidence='Source metadata', period='P1D',
          start_time='2026-01-01T00:00:00Z', end_time='2026-01-02T00:00:00Z'`)
        const configured = { ...env, STAC_HISTORY_CAPTURE: scenario === 'disabled' ? undefined : 'true',
          R2_PUBLIC_BASE: 'https://data.example', CATALOG_R2: { get } }
        const response = await transcodeComplete(ctx({ env: configured, datasetId,
          body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }))
        expect(response.status).toBe(scenario === 'superseded' ? 409 : 200)
        if (scenario === 'superseded') expect(await response.json()).toMatchObject({ error: 'transcode_upload_mismatch' })
        else expect(sqlite.prepare('SELECT transcoding FROM datasets').get()).toEqual({ transcoding: null })
        if (scenario === 'disabled') expect(get).not.toHaveBeenCalled()
        expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: scenario === 'verified' ? 1 : 0 })
        if (scenario === 'verified') {
          expect((await transcodeComplete(ctx({ env: configured, datasetId,
            body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }))).status).toBe(200)
          expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 1 })
        }
      } finally { warning.mockRestore(); vi.unstubAllGlobals(); sqlite.close() }
    })

  it('clears transcoding, server-constructs data_ref, returns the updated row', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ dataset: { data_ref: string; transcoding: number | null } }>(
      res,
    )
    // data_ref is built server-side from the route id + upload id;
    // the workflow never gets to choose. Fix for #3.
    expect(body.dataset.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    expect(body.dataset.transcoding).toBeNull()

    const row = sqlite
      .prepare(`SELECT data_ref, transcoding FROM datasets WHERE id = ?`)
      .get(datasetId) as { data_ref: string; transcoding: number | null }
    expect(row.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    expect(row.transcoding).toBeNull()
  })

  it('marks the asset_uploads row completed (durable backstop for /complete mark-failure)', async () => {
    // PR #112 followup — /asset/.../complete's
    // markTranscodingUploadCompleted step can fail transiently after
    // dispatch succeeds, leaving the upload row stuck `pending`.
    // /transcode-complete re-marks it here so the post-workflow
    // state is always upload.status='completed', and any retry
    // of /complete hits the top-of-handler idempotent branch
    // cleanly. Closes the attack vector that required the
    // earlier `alreadyCompleted` recovery branch in /complete
    // (which the publisher could forge via a planted data_ref).
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    // Simulate the stuck-pending state: /asset/.../complete
    // ran its dispatch but the mark step never landed.
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'pending', completed_at = NULL WHERE id = ?`)
      .run(uploadId)
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const row = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string; completed_at: string | null }
    expect(row.status).toBe('completed')
    expect(row.completed_at).not.toBeNull()
  })

  it('writes an audit_events row tagged transcode_complete with the upload_id', async () => {
    const { sqlite, datasetId, uploadId, env } = setupEnv()
    await transcodeComplete(ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }))
    const audit = sqlite
      .prepare(
        `SELECT action, metadata_json FROM audit_events WHERE subject_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(datasetId) as { action: string; metadata_json: string }
    expect(audit.action).toBe('dataset.update')
    const meta = JSON.parse(audit.metadata_json) as {
      fields: string[]
      reason: string
      upload_id: string
    }
    expect(meta.reason).toBe('transcode_complete')
    // Audit metadata lists every server-managed column
    // clearTranscoding mutates — PR #112 followup
    // (transcode-complete.ts audit completeness).
    expect(meta.fields).toEqual([
      'data_ref',
      'transcoding',
      'active_transcode_upload_id',
      'content_digest',
    ])
    expect(meta.upload_id).toBe(uploadId)
  })

  it('accepts an image-sequence upload (target_ref points at frames/ prefix)', async () => {
    // Phase 3pf — the frames source completion path. The upload
    // row's `target_ref` is the `uploads/{ds}/{up}/frames/`
    // prefix (vs. MP4's `source.mp4` filename), and `frame_count`
    // is non-NULL. The handler must accept both shapes and pass
    // the `frame_count` + `frame_extension` + filenames-ref to
    // `clearTranscoding` so the dataset row's frame_* columns
    // swap atomically with `data_ref`. First live retry of a
    // frames dispatch surfaced this — the pre-fix guard rejected
    // the upload as `upload_kind_mismatch` because
    // `isVideoSourceKey('uploads/.../frames/')` is false.
    const { sqlite, datasetId, uploadId, env } = setupEnv({
      uploadTargetRef: `r2:uploads/${DATASET_ID}/${UPLOAD_ID}/frames/`,
      uploadMime: 'image/png',
      uploadFrameCount: 5,
    })
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const row = sqlite
      .prepare(
        `SELECT data_ref, transcoding, frame_count, frame_extension,
                frame_source_filenames_ref
           FROM datasets WHERE id = ?`,
      )
      .get(datasetId) as {
      data_ref: string
      transcoding: number | null
      frame_count: number | null
      frame_extension: string | null
      frame_source_filenames_ref: string | null
    }
    expect(row.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    expect(row.transcoding).toBeNull()
    expect(row.frame_count).toBe(5)
    expect(row.frame_extension).toBe('png')
    expect(row.frame_source_filenames_ref).toBe(
      `r2:uploads/${datasetId}/${uploadId}/source_filenames.json`,
    )
  })

  it('accepts a matching source_digest belt-and-suspenders check', async () => {
    const sourceDigest = 'sha256:' + 'b'.repeat(64)
    const { datasetId, uploadId, env } = setupEnv({ sourceDigest })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: sourceDigest },
      }),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST .../transcode-complete — auth', () => {
  it('allows admins through', async () => {
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: ADMIN,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('rejects publisher-role accounts with 403', async () => {
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: PUBLISHER,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('transcode_complete_forbidden')
  })

  it('rejects readonly-role accounts with 403', async () => {
    const readonly: PublisherRow = { ...ADMIN, role: 'readonly', is_admin: 0 }
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        publisher: readonly,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(403)
  })
})

describe('POST .../transcode-complete — refusals', () => {
  it('returns 404 for an unknown dataset id', async () => {
    const { uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId: 'NOPE',
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 upload_not_found when the upload doesn’t exist', async () => {
    const { datasetId, env } = setupEnv({ seedUpload: false })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: UPLOAD_ID, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_not_found')
  })

  it('returns 404 upload_not_found when the upload belongs to a different dataset', async () => {
    // Seed a fresh dataset with a different id and bind the
    // upload to it; the route still points at the original
    // datasetId, so the mismatched binding should 404.
    const { sqlite, env } = setupEnv({ seedUpload: false })
    const otherDataset = 'DSXYZ' + 'A'.repeat(21)
    sqlite
      .prepare(
        `INSERT INTO datasets (id, slug, origin_node, title, format, data_ref,
                                weight, visibility, is_hidden, schema_version,
                                created_at, updated_at, transcoding)
         VALUES (?, 'other', 'NODE000', 'Other', 'video/mp4', '',
                 0, 'public', 0, 1,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1)`,
      )
      .run(otherDataset)
    sqlite
      .prepare(
        `INSERT INTO asset_uploads
           (id, dataset_id, publisher_id, kind, target, target_ref, mime,
            declared_size, claimed_digest, status, failure_reason,
            created_at, completed_at)
         VALUES (?, ?, ?, 'data', 'r2', ?, 'video/mp4', 1000, ?, 'completed', NULL, ?, ?)`,
      )
      .run(
        UPLOAD_ID,
        otherDataset,
        ADMIN.id,
        `r2:uploads/${otherDataset}/${UPLOAD_ID}/source.mp4`,
        DEFAULT_SOURCE_DIGEST,
        '2026-04-29T12:00:00.000Z',
        '2026-04-29T12:01:00.000Z',
      )
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId: DATASET_ID, // <- doesn't match the upload's dataset_id
        body: { upload_id: UPLOAD_ID, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(404)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_not_found')
  })

  it('returns 409 upload_kind_mismatch when the upload isn’t a video source', async () => {
    // Seed an upload whose target_ref doesn't live under
    // `uploads/` — i.e. it's an image upload that landed at the
    // content-addressed key. The workflow shouldn't be finalising
    // anything except video sources.
    const { datasetId, uploadId, env } = setupEnv({
      uploadTargetRef: `r2:datasets/${DATASET_ID}/by-digest/sha256/abc/asset.png`,
    })
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('upload_kind_mismatch')
  })

  it('returns 409 not_transcoding when the row isn’t currently transcoding', async () => {
    const { datasetId, uploadId, env } = setupEnv({ transcoding: false })
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_transcoding')
  })

  it('is idempotent on a workflow retry against an already-applied row', async () => {
    // PR #112 followup — the workflow's POST to this endpoint
    // can have its response dropped on the wire (R2 → GHA
    // runner network blip). Its retry loop then re-POSTs after
    // the database has already applied the clearTranscoding
    // change. Without the idempotency check the second call
    // sees `transcoding IS NULL` and 409s — reporting a
    // successful transcode as a failure to the workflow, which
    // would then exit non-zero and confuse operators.
    //
    // The check is keyed on (data_ref matches the expected
    // master.m3u8 path AND source_digest matches the row's
    // stored value). Only a previously-successful
    // clearTranscoding for THIS exact upload can produce that
    // state, and the endpoint is service-token-gated so a
    // publisher PUT can't plant the data_ref to forge it.
    const { sqlite, datasetId, uploadId, env } = setupEnv({ transcoding: false })
    // Seed the row as if the FIRST /transcode-complete call
    // succeeded (data_ref swapped, transcoding cleared,
    // source_digest still set from the original stamp).
    sqlite
      .prepare(
        `UPDATE datasets
           SET transcoding = NULL,
               active_transcode_upload_id = NULL,
               data_ref = ?,
               source_digest = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        `r2:videos/${datasetId}/${uploadId}/master.m3u8`,
        DEFAULT_SOURCE_DIGEST,
        '2026-04-29T12:30:00.000Z',
        datasetId,
      )
    // Also seed the asset_uploads row as `pending` — simulating
    // the gap where clearTranscoding committed but the original
    // markTranscodingUploadCompleted step failed. The idempotent
    // branch should catch this up before returning so a
    // subsequent /asset/.../complete retry doesn't re-stamp the
    // row and re-dispatch the workflow. PR #112 followup —
    // transcode-complete.ts:idempotent-skips-mark.
    sqlite
      .prepare(`UPDATE asset_uploads SET status = 'pending', completed_at = NULL WHERE id = ?`)
      .run(uploadId)

    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ idempotent: boolean; dataset: { data_ref: string } }>(res)
    expect(body.idempotent).toBe(true)
    expect(body.dataset.data_ref).toBe(`r2:videos/${datasetId}/${uploadId}/master.m3u8`)
    // The upload row is now marked completed even though we hit
    // the idempotent path — the stuck-pending vector is closed.
    const row = sqlite
      .prepare(`SELECT status, completed_at FROM asset_uploads WHERE id = ?`)
      .get(uploadId) as { status: string; completed_at: string | null }
    expect(row.status).toBe('completed')
    expect(row.completed_at).not.toBeNull()
  })

  it('still 409s on a non-transcoding row when the data_ref does NOT match (real "fired twice" case)', async () => {
    // Negative companion to the idempotent test: if a workflow
    // fires against the wrong dataset (or against a stale row
    // that was reset out-of-band), the row's data_ref won't
    // match the expected path. The fall-through path must still
    // 409 — the idempotency check is narrow on purpose.
    const { datasetId, uploadId, env, sqlite } = setupEnv({ transcoding: false })
    // data_ref points at something completely unrelated.
    sqlite
      .prepare(`UPDATE datasets SET data_ref = 'vimeo:9999' WHERE id = ?`)
      .run(datasetId)
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('not_transcoding')
  })

  it('returns 409 transcode_upload_mismatch when the callback’s upload_id is stale', async () => {
    // Migration 0012 — two uploads with identical bytes (same
    // source_digest) need a per-upload binding to disambiguate
    // their callbacks. The newer upload's /complete handler set
    // active_transcode_upload_id to its own id; an older
    // workflow's callback (carrying the previous upload_id) must
    // 409 here instead of clearing transcoding against the wrong
    // upload's bundle.
    const newerUploadId = 'KP000' + 'B'.repeat(21)
    const { datasetId, uploadId, env } = setupEnv({ activeUploadId: newerUploadId })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; message: string }>(res)
    expect(body.error).toBe('transcode_upload_mismatch')
    expect(body.message).toContain(newerUploadId)
  })

  it('returns 409 transcode_upload_mismatch when active_transcode_upload_id is NULL (pre-0012 row)', async () => {
    // A row that was transcoding before migration 0012 shipped
    // has the column NULL. Such rows are stuck and need operator
    // cleanup rather than a workflow callback flipping data_ref
    // against an unverified binding.
    const { datasetId, uploadId, env } = setupEnv({ activeUploadId: null })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: { upload_id: uploadId, source_digest: DEFAULT_SOURCE_DIGEST },
      }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe(
      'transcode_upload_mismatch',
    )
  })

  it('returns 409 source_digest_mismatch on a digest mismatch', async () => {
    const { datasetId, uploadId, env } = setupEnv({
      sourceDigest: 'sha256:' + 'a'.repeat(64),
    })
    const res = await transcodeComplete(
      ctx({
        env,
        datasetId,
        body: {
          upload_id: uploadId,
          source_digest: 'sha256:' + 'f'.repeat(64),
        },
      }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('source_digest_mismatch')
  })

  it('returns 400 invalid_body on a missing source_digest (#3)', async () => {
    // Required since 3pd-review3/B — a stale dispatch should
    // not be able to win against a fresher upload's
    // source_digest just by omitting the field.
    const { datasetId, uploadId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: uploadId } }),
    )
    expect(res.status).toBe(400)
    const body = await readJson<{ message: string }>(res)
    expect(body.message).toMatch(/source_digest/)
  })

  it('returns 400 invalid_body on a missing upload_id', async () => {
    const { datasetId, env } = setupEnv()
    const res = await transcodeComplete(ctx({ env, datasetId, body: {} }))
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_body on an upload_id that isn’t a ULID', async () => {
    const { datasetId, env } = setupEnv()
    const res = await transcodeComplete(
      ctx({ env, datasetId, body: { upload_id: 'not-a-ulid' } }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 invalid_json on a non-JSON body', async () => {
    const { datasetId, env } = setupEnv()
    const url = `https://localhost/api/v1/publish/datasets/${datasetId}/transcode-complete`
    const baseCtx = ctx({ env, datasetId, body: {} })
    const goodCtx = {
      ...baseCtx,
      request: new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    } as typeof baseCtx
    const res = await transcodeComplete(goodCtx)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })
})
