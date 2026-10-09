// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { asD1, seedFixtures } from './test-helpers'
import { readStacModel } from './stac-read-model'

describe('canonical STAC read model', () => {
  it('classifies even disabled overwrite workflows from their persisted ownership', async () => {
    const sqlite = seedFixtures({ count: 1 })
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','publisher@example.test','Publisher','service','active','2026-01-01');
        INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
        SELECT 'WF','PUB','Recurring','{}','{}','P1D',id,'2026-01-01','2026-01-01' FROM datasets;`)
      const result = await readStacModel(asD1(sqlite))
      expect(result.datasets[0].publicationKind).toBe('workflow')
    } finally { sqlite.close() }
  })

  it('retains decorations, media and delivered/source digests independently', async () => {
    const sqlite = seedFixtures({ count: 1 })
    try {
      const { id } = sqlite.prepare('SELECT id FROM datasets').get() as { id: string }
      sqlite.prepare(`UPDATE datasets SET width=4096, height=2048, primary_codec='h264',
        content_digest=?, source_digest=?, bbox_evidence='Measured extent'`).run(`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`)
      sqlite.prepare(`INSERT INTO dataset_renditions (dataset_id,rendition_id,codec,color_space,
        bit_depth,width,height,ref,mime_type,content_digest,created_at)
        VALUES (?,'REN1','h264','rec709',8,2048,1024,'r2:video/master.m3u8',
        'application/vnd.apple.mpegurl',?,'2026-01-01T00:00:00Z')`).run(id, `sha256:${'c'.repeat(64)}`)
      const result = await readStacModel(asD1(sqlite))
      expect(result.node?.identity.description).toBeDefined()
      expect(Object.keys(result.node!)).toEqual(['identity'])
      expect(result.datasets).toHaveLength(1)
      expect(result.datasets[0]).toMatchObject({
        row: { id, bbox_evidence: 'Measured extent', content_digest: `sha256:${'a'.repeat(64)}`, source_digest: `sha256:${'b'.repeat(64)}` },
        media: { width: 4096, height: 2048, primary_codec: 'h264', render_width: null },
        renditions: [{ rendition_id: 'REN1', content_digest: `sha256:${'c'.repeat(64)}` }],
      })
      expect(result.datasets[0].decorations).toHaveProperty('categories')
    } finally { sqlite.close() }
  })

  it.each([
    "visibility='private'", "visibility='restricted'", "visibility='federated'",
    'published_at=NULL', 'is_hidden=1', "retracted_at='2026-01-01'",
  ])('excludes non-public rows with %s', async change => {
    const sqlite = seedFixtures({ count: 1 })
    try {
      sqlite.exec(`UPDATE datasets SET ${change}`)
      expect((await readStacModel(asD1(sqlite))).datasets).toEqual([])
    } finally { sqlite.close() }
  })

  it('supports missing identity and reads more than one D1 bind batch', async () => {
    const sqlite = seedFixtures({ count: 161 })
    try {
      sqlite.exec('DELETE FROM node_identity')
      const result = await readStacModel(asD1(sqlite))
      expect(result.node).toBeNull()
      expect(result.datasets).toHaveLength(161)
      expect(result.datasets.every(dataset => dataset.renditions.length === 0)).toBe(true)
    } finally { sqlite.close() }
  })
})