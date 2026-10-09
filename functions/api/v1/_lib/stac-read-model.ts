// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { D1_BIND_BATCH, getDecorations, getNodeIdentity, listPublicDatasets, type DatasetRow, type DecorationRows, type NodeIdentityRow } from './catalog-store'
import type { ExtensionRegistration, MetadataReviewEvidence, MetadataScope, VocabularyDescriptor, VocabularyReference } from './metadata-policy'

export interface StacMediaIntrinsics {
  width: number | null
  height: number | null
  render_width: number | null
  render_height: number | null
  color_space: string | null
  bit_depth: number | null
  hdr_transfer: string | null
  has_alpha: number
  alpha_encoding: string | null
  primary_codec: string | null
}
export interface StacRendition {
  dataset_id: string
  rendition_id: string
  codec: string
  color_space: string
  bit_depth: number
  has_alpha: number
  alpha_encoding: string | null
  width: number
  height: number
  bitrate_kbps: number | null
  ref: string
  mime_type: string
  content_digest: string | null
  created_at: string
}
export interface StacCustomField {
  key: string
  value: unknown
  scope: MetadataScope
  ownerNodeId: string
  essential: boolean
  assetKey?: string
}
export interface StacPublicSelection {
  nodeId: string
  revision: number
  selectedValues: {
    mission?: string
    about_md?: string
    region_focus?: string
    links?: { purpose: 'organization' | 'about' | 'related'; label: string; url: string }[]
  }
  approval: MetadataReviewEvidence | null
}
export interface StacNodeContext {
  identity: NodeIdentityRow
  publicOrgName?: string
  publicLogo?: { href: string; type: string }
  publicSelection?: StacPublicSelection
  policyCurrent?: boolean
  extensions?: ExtensionRegistration[]
  vocabularies?: VocabularyDescriptor[]
  customFields?: StacCustomField[]
}
export interface StacDatasetReadModel {
  verifiedFrameAssets?: { sourceRef: string; href: string; type: string }[]
  row: DatasetRow
  decorations: DecorationRows
  media: StacMediaIntrinsics
  renditions: StacRendition[]
  customFields?: StacCustomField[]
  vocabularyReferences?: VocabularyReference[]
  licenseReferenceEvidence?: Record<string, string>
  publicationKind?: 'indivisible' | 'sequence' | 'workflow' | 'unknown'
  itemIdentity?: { kind: 'frame' | 'revision'; persisted_id: string }
}
export interface StacReadModel {
  node: StacNodeContext | null
  datasets: StacDatasetReadModel[]
}

export async function readStacModel(db: D1Database): Promise<StacReadModel> {
  const [identity, rows] = await Promise.all([getNodeIdentity(db), listPublicDatasets(db)])
  const decorations = await getDecorations(db, rows.map(row => row.id))
  const media = new Map<string, StacMediaIntrinsics>()
  const renditions = new Map<string, StacRendition[]>()
  const workflowDatasets = new Set<string>()
  for (let offset = 0; offset < rows.length; offset += D1_BIND_BATCH) {
    const ids = rows.slice(offset, offset + D1_BIND_BATCH).map(row => row.id)
    const placeholders = ids.map(() => '?').join(',')
    const [mediaResult, renditionResult, workflowResult] = await Promise.all([
      db.prepare(`SELECT id, width, height, render_width, render_height, color_space,
        bit_depth, hdr_transfer, has_alpha, alpha_encoding, primary_codec
        FROM datasets WHERE id IN (${placeholders})`).bind(...ids).all<StacMediaIntrinsics & { id: string }>(),
      db.prepare(`SELECT * FROM dataset_renditions WHERE dataset_id IN (${placeholders})
        ORDER BY dataset_id, rendition_id`).bind(...ids).all<StacRendition>(),
      db.prepare(`SELECT DISTINCT target_dataset_id FROM workflows WHERE target_dataset_id IN (${placeholders})`).bind(...ids).all<{ target_dataset_id: string }>(),
    ])
    for (const workflow of workflowResult.results) workflowDatasets.add(workflow.target_dataset_id)
    for (const { id, ...intrinsics } of mediaResult.results) media.set(id, intrinsics)
    for (const rendition of renditionResult.results) {
      const group = renditions.get(rendition.dataset_id)
      if (group) group.push(rendition)
      else renditions.set(rendition.dataset_id, [rendition])
    }
  }
  return {
    node: identity ? { identity } : null,
    datasets: rows.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0).map(row => {
      const intrinsics = media.get(row.id)
      if (!intrinsics) throw new Error('STAC read interrupted by dataset removal; retry the snapshot')
      return { row, decorations: decorations.get(row.id)!, media: intrinsics, renditions: renditions.get(row.id) ?? [],
        publicationKind: workflowDatasets.has(row.id) ? 'workflow' as const : undefined }
    }),
  }
}