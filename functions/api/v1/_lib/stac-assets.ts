// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { runBoundedPool } from './bounded-pool'
import { isPublicStacUrl, type StacResolvedAsset } from './stac-builders'
import { evaluateMetadataReadiness } from './metadata-readiness'
import { resolveHttpAssetUrl } from './r2-public-url'
import type { StacPublicationInput } from './stac-publication-store'
import { buildContentAddressedFrameKey } from './r2-store'
import type { StacDatasetReadModel } from './stac-read-model'

interface VerifiedUrl { href: string; type: string }

function allowedAsset(env: CatalogEnv, href: string): boolean {
  const origins = new Set((env.STAC_ASSET_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (env.R2_PUBLIC_BASE && isPublicStacUrl(env.R2_PUBLIC_BASE)) origins.add(new URL(env.R2_PUBLIC_BASE).origin)
  return isPublicStacUrl(href) && new URL(href).protocol === 'https:' && origins.has(new URL(href).origin)
}

export async function verifyFrameAssets(env: CatalogEnv, frames: { data_ref: string; format: string }[]): Promise<NonNullable<StacDatasetReadModel['verifiedFrameAssets']>> {
  const unique = [...new Map(frames.map(frame => [frame.data_ref, frame])).values()]
  if (unique.length > 10000) throw new Error('Frame verification capture limit exceeded')
  const results: NonNullable<StacDatasetReadModel['verifiedFrameAssets']> = []
  const deadline = AbortSignal.timeout(30000)
  await runBoundedPool(unique.map(frame => async () => {
    const href = resolveHttpAssetUrl(env, frame.data_ref)
    if (!href || !allowedAsset(env, href) || deadline.aborted) return
    try {
      const response = await fetch(href, { method: 'HEAD', redirect: 'manual', credentials: 'omit',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]) })
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      await response.body?.cancel()
      if (response.ok && type === frame.format && !deadline.aborted) results.push({ sourceRef: frame.data_ref, href, type })
    } catch { /* An incomplete verification set prevents history capture, not native publication. */ }
  }), 16)
  if (results.length !== unique.length) throw new Error('Immutable frame verification incomplete')
  return results.sort((first, second) => first.sourceRef.localeCompare(second.sourceRef))
}

export async function verifyStacAssets(env: CatalogEnv, model: StacPublicationInput): Promise<{
  assets: Map<string, StacResolvedAsset>; issues: Map<string, string>; budgetExhausted: boolean
}> {
  const allowed = (href: string): boolean => allowedAsset(env, href)
  const references = new Set<string>()
  const persisted = new Map<string, VerifiedUrl>()
  const unverifiedFrames = new Set<string>()
  for (const dataset of model.datasets) {
    if (dataset.row.visibility !== 'public' || dataset.row.is_hidden !== 0 || !dataset.row.published_at || dataset.row.retracted_at !== null) continue
    const readiness = evaluateMetadataReadiness({ ...dataset.row, publication_kind: dataset.publicationKind, item_identity: dataset.itemIdentity })
    if (dataset.row.transcoding === 1 || ['excluded', 'needs_review'].includes(readiness.decision)) continue
    if (dataset.itemIdentity?.kind === 'frame') unverifiedFrames.add(dataset.row.data_ref)
    if (dataset.itemIdentity?.kind === 'frame' && /^sha256:[a-f0-9]{64}$/.test(dataset.row.content_digest ?? '')
      && ['png', 'jpg', 'webp'].includes(dataset.row.frame_extension ?? '')) {
      const expected = `r2:${buildContentAddressedFrameKey(dataset.row.id, dataset.row.content_digest!, dataset.row.frame_extension!)}`
      const saved = dataset.verifiedFrameAssets?.find(asset => asset.sourceRef === expected)
      const href = resolveHttpAssetUrl(env, expected)
      if (dataset.row.data_ref === expected && saved && href === saved.href && saved.type === dataset.row.format && allowed(href)) {
        persisted.set(expected, saved)
      }
    }
    for (const ref of [dataset.row.data_ref, ...dataset.renditions.map(entry => entry.ref), dataset.row.thumbnail_ref,
      dataset.row.sphere_thumbnail_ref, dataset.row.legend_ref, dataset.row.caption_ref, dataset.row.color_table_ref, dataset.row.license_url]) {
      if (ref) references.add(ref)
    }
  }
  if (model.branding?.logo_ref) references.add(model.branding.logo_ref)
  const verified = new Map<string, StacResolvedAsset>()
  const issues = new Map<string, string>()
  const urlIssues = new Map<string, string>()
  const byUrl = new Map<string, VerifiedUrl | null>()
  const resolvedRefs = new Map<string, string>()
  for (const ref of references) {
    const href = resolveHttpAssetUrl(env, ref.startsWith('url:') ? ref.slice(4) : ref)
    if (!href || !allowed(href)) { issues.set(ref, href ? 'asset_origin_untrusted' : 'asset_reference_unsupported'); continue }
    const saved = persisted.get(ref)
    if (saved) {
      verified.set(ref, { ...saved, sourceRef: ref, anonymous: true,
        ...(model.node ? { hostedBy: model.node.identity.node_id } : {}) })
      continue
    }
    if (unverifiedFrames.has(ref)) { issues.set(ref, 'frame_verification_required'); continue }
    resolvedRefs.set(ref, href)
  }
  const distinctUrls = [...new Set(resolvedRefs.values())]
  let budgetExhausted = distinctUrls.length > 40
  for (const href of distinctUrls.slice(40)) urlIssues.set(href, 'asset_probe_budget_exceeded')
  const deadline = AbortSignal.timeout(15000)
  await runBoundedPool(distinctUrls.slice(0, 40).map(href => async () => {
    if (deadline.aborted) {
      budgetExhausted = true
      urlIssues.set(href, 'asset_probe_budget_exceeded')
    } else {
      let result: VerifiedUrl | null = null
      try {
        const response = await fetch(href, { method: 'HEAD', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]), headers: { Accept: '*/*' } })
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (response.ok && type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) result = { href, type }
        else urlIssues.set(href, response.ok ? 'asset_content_type_missing' : `asset_http_${response.status}`)
        await response.body?.cancel()
      } catch { result = null; urlIssues.set(href, 'asset_probe_failed') }
      if (deadline.aborted) {
        budgetExhausted = true
        result = null
        urlIssues.set(href, 'asset_probe_budget_exceeded')
      }
      byUrl.set(href, result)
    }
  }), 16)
  for (const [ref, href] of resolvedRefs) {
    const result = byUrl.get(href)
    if (result) verified.set(ref, { ...result, sourceRef: ref, anonymous: true,
      ...(ref.startsWith('r2:') && model.node ? { hostedBy: model.node.identity.node_id } : {}) })
    else issues.set(ref, urlIssues.get(href) ?? 'asset_probe_failed')
  }
  return { assets: verified, issues, budgetExhausted }
}