// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import type { DatasetRow, DecorationRows } from './catalog-store'
import type { StacDatasetReadModel } from './stac-read-model'
import { loadFrameManifest, frameTimestamp } from './frames-manifest'
import { evaluateMetadataReadiness, evaluateTemporal } from './metadata-readiness'
import { parseIsoDuration } from './iso-duration'
import type { StacProduct } from './stac-builders'
import { buildContentAddressedFrameKey } from './r2-store'
import type { StacCollection } from './stac-types'
import { computeEtag } from './snapshot'
import { readStacPublicationInput } from './stac-publication-store'
import { verifyFrameAssets } from './stac-assets'

export interface StacHistoryItem {
  id: string
  ordinal: number
  data_ref: string
  content_digest: string
  format: string
  start_time: string
  end_time: string
}

export interface StacHistoryPublication {
  id: string
  dataset_id: string
  kind: 'frame' | 'revision'
  source_key: string
  model_json: string
  captured_at: string
  items: StacHistoryItem[]
}

const scientificFields = ['id', 'origin_node', 'resource_kind', 'celestial_body', 'start_time', 'end_time', 'period',
  'temporal_semantics', 'temporal_evidence', 'bbox_n', 'bbox_s', 'bbox_e', 'bbox_w', 'bbox_provenance', 'bbox_evidence',
  'lon_origin', 'is_flipped_in_y', 'render_encoding', 'color_scale', 'probing_info', 'frame_extension'] as const

function historyIdentity(row: DatasetRow, kind: StacHistoryPublication['kind']): Record<string, unknown> {
  const fields = [...scientificFields, 'data_ref', 'content_digest', 'format',
    ...(kind === 'frame' ? ['frame_count', 'frame_source_filenames_ref'] as const : [])] as const
  return Object.fromEntries(fields.map(key => [key, row[key]]))
}

export function historyMatchesDataset(publication: StacHistoryPublication, dataset: StacDatasetReadModel): boolean {
  const saved = (JSON.parse(publication.model_json) as StacDatasetReadModel).row
  const row = dataset.row
  if ((publication.kind === 'revision') !== (dataset.publicationKind === 'workflow')) return false
  return JSON.stringify(historyIdentity(saved, publication.kind)) === JSON.stringify(historyIdentity(row, publication.kind))
}

export function historyModels(publication: StacHistoryPublication, parent: DatasetRow, decorations?: DecorationRows): StacDatasetReadModel[] {
  const model = JSON.parse(publication.model_json) as StacDatasetReadModel
  const verified = new Map(model.verifiedFrameAssets?.map(asset => [asset.sourceRef, asset]))
  return publication.items.map(item => ({ ...model,
    decorations: { ...model.decorations, developers: decorations?.developers ?? model.decorations.developers },
    verifiedFrameAssets: verified.has(item.data_ref) ? [verified.get(item.data_ref)!] : [],
    row: { ...model.row, data_ref: item.data_ref, content_digest: item.content_digest || null,
      format: item.format, start_time: item.start_time, end_time: item.end_time,
      visibility: parent.visibility, is_hidden: parent.is_hidden, published_at: parent.published_at,
      retracted_at: parent.retracted_at, transcoding: 0, organization: parent.organization,
      license_spdx: parent.license_spdx, license_url: parent.license_url, license_statement: parent.license_statement,
      rights_holder: parent.rights_holder, attribution_text: parent.attribution_text,
      doi: parent.doi, citation_text: parent.citation_text },
    publicationKind: publication.kind === 'frame' ? 'sequence' : 'workflow',
    itemIdentity: { kind: publication.kind, persisted_id: item.id },
  }))
}

export async function prepareFrameHistory(env: CatalogEnv, row: DatasetRow, capturedAt: string): Promise<StacHistoryPublication | null> {
  if (env.STAC_HISTORY_CAPTURE !== 'true' || row.visibility !== 'public' || row.is_hidden !== 0 || !row.frame_count || !row.frame_extension || !row.frame_source_filenames_ref || !env.CATALOG_R2
    || !evaluateTemporal(row).ready || !row.period) return null
  if (!['png', 'jpg', 'webp'].includes(row.frame_extension) || (parseIsoDuration(row.period) ?? 0) <= 0) return null
  const input = await readStacPublicationInput(env.CATALOG_DB!, true, row.id)
  const model = input.datasets.find(dataset => dataset.row.id === row.id)
  if (!model || model.publicationKind === 'workflow') return null
  const manifest = await loadFrameManifest(env.CATALOG_R2, row.frame_source_filenames_ref.replace(/^r2:/, ''))
  if (!manifest || manifest.length !== row.frame_count) throw new Error('STAC frame manifest is missing or inconsistent')
  const frames: Omit<StacHistoryItem, 'id'>[] = []
  for (const entry of manifest) {
    const timestamp = frameTimestamp(row, entry.index)
    if (!timestamp || !evaluateTemporal({ ...row, start_time: timestamp, end_time: timestamp }).ready
      || Date.parse(timestamp) > Date.parse(row.end_time!)) return null
    frames.push({ ordinal: entry.index, data_ref: `r2:${buildContentAddressedFrameKey(row.id, entry.digest, row.frame_extension)}`,
      content_digest: entry.digest, format: row.frame_extension === 'jpg' ? 'image/jpeg' : `image/${row.frame_extension}`,
      start_time: timestamp, end_time: timestamp })
  }
  const snapshot = { ...model, row: { ...model.row, ...row }, renditions: [],
    verifiedFrameAssets: await verifyFrameAssets(env, frames) }
  const sourceKey = (await computeEtag(JSON.stringify({ scientific: historyIdentity(row, 'frame'),
    frames }))).replace(/"/g, '')
  const id = `frames-${sourceKey}`
  return { id, dataset_id: row.id, kind: 'frame', source_key: sourceKey,
    model_json: JSON.stringify(snapshot), captured_at: capturedAt,
    items: frames.map(frame => ({ ...frame, id: `frame-${sourceKey}-${frame.ordinal}` })) }
}

export async function prepareWorkflowHistory(env: CatalogEnv, row: DatasetRow, capturedAt: string): Promise<StacHistoryPublication | null> {
  if (env.STAC_HISTORY_CAPTURE !== 'true' || row.visibility !== 'public' || row.is_hidden !== 0 || row.transcoding || !evaluateTemporal(row).ready) return null
  const bundle = new RegExp(`^r2:videos/${row.id}/([0-9A-HJKMNP-TV-Z]{26})/master\\.m3u8$`).exec(row.data_ref)
  const content = /^sha256:([a-f0-9]{64})$/.exec(row.content_digest ?? '')
  const immutableAsset = content && row.data_ref.startsWith(`r2:datasets/${row.id}/by-digest/sha256/${content[1]}/`)
  if (!bundle && !immutableAsset) return null
  const input = await readStacPublicationInput(env.CATALOG_DB!, true, row.id)
  const model = input.datasets.find(dataset => dataset.row.id === row.id)
  if (model?.publicationKind !== 'workflow') return null
  const snapshot: StacDatasetReadModel = { ...model, row: { ...model.row, ...row }, renditions: [] }
  const sourceKey = (await computeEtag(JSON.stringify(historyIdentity(row, 'revision')))).replace(/"/g, '')
  return { id: `revision-${sourceKey}`, dataset_id: row.id, kind: 'revision', source_key: sourceKey,
    model_json: JSON.stringify(snapshot), captured_at: capturedAt, items: [{ id: `revision-${sourceKey}`, ordinal: 0,
      data_ref: row.data_ref, content_digest: bundle ? '' : row.content_digest!, format: row.format,
      start_time: row.start_time!, end_time: row.end_time! }] }
}

export async function prepareHistory(env: CatalogEnv, row: DatasetRow, capturedAt: string): Promise<StacHistoryPublication | null> {
  try {
    const publication = await prepareFrameHistory(env, row, capturedAt) ?? await prepareWorkflowHistory(env, row, capturedAt)
    if (!publication && row.published_at && env.CATALOG_DB) {
      const saved = await env.CATALOG_DB.prepare(`SELECT kind,
        (SELECT id FROM stac_history_items WHERE publication_id=history.id ORDER BY ordinal LIMIT 1) AS item_id
        FROM stac_history_publications history WHERE dataset_id=? ORDER BY captured_at DESC, id DESC LIMIT 1`)
        .bind(row.id).first<{ kind: StacHistoryPublication['kind']; item_id: string | null }>()
      if (saved) {
        const reasons = evaluateMetadataReadiness({ ...row,
          publication_kind: saved.kind === 'revision' ? 'workflow' : 'sequence',
          item_identity: { kind: saved.kind, persisted_id: saved.item_id ?? undefined } }).reasons
        if (env.STAC_HISTORY_CAPTURE !== 'true') reasons.unshift('capture_disabled')
        if (row.transcoding) reasons.push('transcoding_in_progress')
        console.warn('[stac-history] capture skipped for published dataset:', row.id,
          reasons.join(', ') || 'capture prerequisites unmet')
      }
    }
    return publication
  }
  catch (error) {
    console.warn('[stac-history] capture unavailable; native publication continues:', error instanceof Error ? error.message : String(error))
    return null
  }
}

export async function writeWithHistory(db: D1Database, statement: D1PreparedStatement, history: D1PreparedStatement[]): Promise<number> {
  if (history.length) {
    try { return (await db.batch([...history, statement])).at(-1)!.meta.changes }
    catch (error) {
      console.warn('[stac-history] history transaction failed; retrying native write without history:', error instanceof Error ? error.message : String(error))
    }
  }
  return (await statement.run()).meta.changes
}

/** Only physical dataset columns are compared; joined aliases never become SQL identifiers.
 * A mismatched snapshot inserts nothing, leaving the native write's conflict handling intact. */
export function historyInsertStatements(db: D1Database, publication: StacHistoryPublication,
  expected: DatasetRow = (JSON.parse(publication.model_json) as StacDatasetReadModel).row): D1PreparedStatement[] {
  const columns = ['id', 'updated_at', 'title', 'abstract', 'data_ref', 'content_digest', 'source_digest',
    'active_transcode_upload_id', 'transcoding', 'visibility', 'is_hidden', 'published_at', 'retracted_at',
    'start_time', 'end_time', 'period', 'frame_count', 'frame_extension', 'frame_source_filenames_ref',
    'bbox_n', 'bbox_s', 'bbox_e', 'bbox_w', 'license_spdx', 'license_url', 'license_statement'] as const
  const expectedColumns = Object.fromEntries(columns.map(key => [key, expected[key]]))
  const matches = `EXISTS(SELECT 1 FROM datasets WHERE id = ? AND NOT EXISTS
    (SELECT 1 FROM json_each(?) expected WHERE (CASE expected.key
      ${columns.map(key => `WHEN '${key}' THEN datasets.${key}`).join(' ')} END) IS NOT expected.value))`
  const statements = [db.prepare(`INSERT INTO stac_history_publications
    (id, dataset_id, kind, source_key, model_json, captured_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${matches}
    ON CONFLICT(dataset_id, kind, source_key) DO NOTHING`)
    .bind(publication.id, publication.dataset_id, publication.kind, publication.source_key,
      publication.model_json, publication.captured_at, publication.dataset_id, JSON.stringify(expectedColumns))]
  for (let offset = 0; offset < publication.items.length; offset += 100) {
    statements.push(db.prepare(`INSERT INTO stac_history_items
      (id, publication_id, ordinal, data_ref, content_digest, format, start_time, end_time)
      SELECT json_extract(value,'$.id'), ?, json_extract(value,'$.ordinal'), json_extract(value,'$.data_ref'),
        json_extract(value,'$.content_digest'), json_extract(value,'$.format'), json_extract(value,'$.start_time'),
        json_extract(value,'$.end_time') FROM json_each(?) WHERE ${matches}
        AND EXISTS(SELECT 1 FROM stac_history_publications WHERE id = ?) ON CONFLICT(id) DO NOTHING`)
      .bind(publication.id, JSON.stringify(publication.items.slice(offset, offset + 100)),
        publication.dataset_id, JSON.stringify(expectedColumns), publication.id))
  }
  return statements
}

export function linkHistoryRevisions(products: StacProduct[], history: StacHistoryPublication[]): void {
  const items = new Map(products.flatMap(product => product.item ? [[product.item.id, product.item] as const] : []))
  const groups = new Map<string, StacHistoryPublication[]>()
  for (const publication of history) {
    if (publication.kind !== 'revision' || publication.items.length !== 1) continue
    const group = groups.get(publication.dataset_id) ?? []
    group.push(publication)
    groups.set(publication.dataset_id, group)
  }
  for (const group of groups.values()) {
    group.sort((first, second) => Date.parse(first.captured_at) - Date.parse(second.captured_at))
    const times = group.map(publication => Date.parse(publication.captured_at))
    if (times.some(time => !Number.isFinite(time)) || new Set(times).size !== times.length) continue
    const versions = group.map(publication => items.get(`${publication.dataset_id}-revision-${publication.items[0].id}`))
    for (let index = 0; index < versions.length; index++) {
      const item = versions[index]
      if (!item) continue
      const targets = [['predecessor-version', versions[index - 1]], ['successor-version', versions[index + 1]],
        ['latest-version', versions.at(-1)]] as const
      for (const [rel, target] of targets) {
        if (!target || target.id === item.id) continue
        const self = target.links.find(link => link.rel === 'self')
        if (self) item.links.push({ rel, href: self.href, type: 'application/geo+json' })
      }
    }
  }
}

export function mergeHistoryCollections(products: StacProduct[], liveCollections: Map<string, StacCollection> = new Map()): void {
  const groups = new Map<string, StacProduct[]>()
  for (const product of products) {
    if (!product.collection) continue
    const group = groups.get(product.collection.id) ?? []
    group.push(product)
    groups.set(product.collection.id, group)
  }
  for (const group of groups.values()) {
    const latest = liveCollections.get(group[0].collection!.id) ?? group[0].collection!
    const boxes = group.flatMap(product => product.collection!.extent.spatial.bbox)
    const crossing = boxes.some(box => box[0] > box[2])
    const intervals = group.flatMap(product => product.collection!.extent.temporal.interval)
    const starts = intervals.map(interval => interval[0])
    const ends = intervals.map(interval => interval[1])
    const collection: StacCollection = { ...latest, extent: {
      spatial: { bbox: [[crossing ? -180 : Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        crossing ? 180 : Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))]] },
      temporal: { interval: [[starts.includes(null) ? null : starts.sort()[0], ends.includes(null) ? null : ends.sort().at(-1)!]] },
    }, links: [...latest.links.filter(link => link.rel !== 'item'),
      ...group.flatMap(product => product.collection!.links.filter(link => link.rel === 'item'))] }
    for (const product of group) product.collection = collection
  }
}