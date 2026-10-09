// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { marked, type Token } from 'marked'
import { decideExtensionField, isApprovedMetadataReviewEvidence, metadataJsonBytes, validateExtensionRegistry, validateVocabularyDescriptor, validateVocabularyReferences } from './metadata-policy'
import { isSafeLicenseUrl } from './metadata-readiness'
import type { StacCustomField, StacNodeContext, StacPublicSelection } from './stac-read-model'
import type { StacDocument } from './stac-types'

export interface StacSchemaValidator {
  validate(uri: string, digest: string, document: StacDocument): 'valid' | 'invalid' | 'unavailable'
}

export function approvedStacSelection(node: StacNodeContext): StacPublicSelection['selectedValues'] | null {
  const selection = node.publicSelection
  if (!node.policyCurrent || !selection || metadataJsonBytes(selection, 32768) === null) return null
  if (Object.keys(selection).some(key => !['nodeId', 'revision', 'selectedValues', 'approval'].includes(key))
    || selection.nodeId !== node.identity.node_id || !Number.isSafeInteger(selection.revision) || selection.revision < 1
    || !isApprovedMetadataReviewEvidence(selection.approval)) return null
  const values = selection.selectedValues
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !['mission', 'about_md', 'region_focus', 'links'].includes(key))) return null
  for (const [key, max] of [['mission', 1000], ['about_md', 10000], ['region_focus', 200]] as const) {
    const value = values[key]
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) return null
  }
  if (values.links !== undefined) {
    if (!Array.isArray(values.links) || values.links.length > 10) return null
    const singletonPurposes = new Set<string>()
    for (const entry of values.links) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['purpose', 'label', 'url'].includes(key))
        || !['organization', 'about', 'related'].includes(entry.purpose) || typeof entry.label !== 'string'
        || !entry.label.trim() || entry.label.length > 100 || typeof entry.url !== 'string' || entry.url.length > 2048 || !isSafeLicenseUrl(entry.url)) return null
      if (entry.purpose !== 'related') {
        if (singletonPurposes.has(entry.purpose)) return null
        singletonPurposes.add(entry.purpose)
      }
    }
  }
  return values
}

export function stacPlainText(markdown: string, limit = 600): string {
  const text = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === 'html' || token.type === 'image') return ''
    if ('tokens' in token && Array.isArray(token.tokens)) return text(token.tokens)
    if ('items' in token && Array.isArray(token.items)) return text(token.items)
    if (token.type === 'space' || token.type === 'softbreak' || token.type === 'br') return ' '
    return 'text' in token && typeof token.text === 'string' ? token.text : ''
  }).join(' ')
  const plain = Array.from(text(marked.lexer(markdown)).replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
  return plain.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function applyStacPolicy(
  document: StacDocument, node: StacNodeContext, customFields: StacCustomField[],
  validator?: StacSchemaValidator,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  const scope = document.type === 'Feature' ? 'Item' : document.type
  const registry = validateExtensionRegistry(node.extensions ?? [])
  if (!registry.ok) return { ok: false, reasons: registry.reasons }
  for (const { assetKey, ...input } of customFields) {
    const decision = decideExtensionField(input, node.extensions ?? [])
    if (decision.decision === 'withhold') return { ok: false, reasons: decision.reasons }
  }
  const staged = structuredClone(document)
  const fields = staged.type === 'Feature' ? staged.properties : staged
  const candidates = customFields.filter(field => field.scope === scope || (field.scope === 'Asset' && staged.type !== 'Catalog' && staged.assets))
  const grouped = new Map<string, { essential: boolean; targets: { target: Record<string, unknown>; key: string }[]; payload: unknown[] }>()
  for (const field of candidates) {
    const { assetKey, ...input } = field
    const decision = decideExtensionField(input, node.extensions ?? [])
    if (decision.decision === 'withhold') return { ok: false, reasons: decision.reasons }
    if (decision.decision === 'omit') { reasons.push(...decision.reasons); continue }
    if (!node.policyCurrent) {
      if (field.essential) return { ok: false, reasons: ['policy_not_current'] }
      reasons.push('policy_not_current')
      continue
    }
    const target = field.scope === 'Asset'
      ? staged.type !== 'Catalog' && assetKey && staged.assets && Object.hasOwn(staged.assets, assetKey) ? staged.assets[assetKey] : undefined : fields
    if (!target || (field.scope !== 'Asset' && assetKey !== undefined) || Object.hasOwn(target, field.key)) return { ok: false, reasons: ['custom_field_target_invalid'] }
    const registration = registry.value.find(entry => entry.schemaUri === decision.schemaUri)!
    let group = grouped.get(registration.schemaUri)
    if (!group) { group = { essential: false, targets: [], payload: [] }; grouped.set(registration.schemaUri, group) }
    group.essential ||= field.essential
    group.payload.push({ [field.key]: field.value })
    if (metadataJsonBytes(group.payload, registration.maxPayloadBytes) === null) return { ok: false, reasons: ['aggregate_payload_limit_exceeded'] }
    const record = target as unknown as Record<string, unknown>
    record[field.key] = structuredClone(field.value)
    group.targets.push({ target: record, key: field.key })
  }
  for (const uri of grouped.keys()) staged.stac_extensions.push(uri)
  staged.stac_extensions.sort()
  for (const [uri, group] of grouped) {
    const registration = registry.value.find(entry => entry.schemaUri === uri)!
    const status = validator?.validate(uri, registration.schemaSha256, staged) ?? 'unavailable'
    if (status === 'invalid' || (status === 'unavailable' && group.essential)) return { ok: false, reasons: [status === 'invalid' ? 'extension_schema_invalid' : 'extension_schema_unavailable'] }
    if (status === 'unavailable') {
      reasons.push('extension_schema_unavailable')
      for (const { target, key } of group.targets) delete target[key]
      staged.stac_extensions = staged.stac_extensions.filter(value => value !== uri)
    }
  }
  for (const uri of staged.stac_extensions.filter(uri => grouped.has(uri))) {
    const registration = registry.value.find(entry => entry.schemaUri === uri)!
    if (validator?.validate(uri, registration.schemaSha256, staged) !== 'valid') return { ok: false, reasons: ['extension_schema_invalid'] }
  }
  Object.assign(document, staged)
  return { ok: true, reasons }
}

export function stacVocabularyReferences(references: unknown, node: StacNodeContext) {
  if (!node.policyCurrent) return { ok: false as const, reasons: ['policy_not_current'] }
  return validateVocabularyReferences(references, node.vocabularies ?? [])
}

export function buildStacVocabulary(input: unknown, node: StacNodeContext) {
  if (!node.policyCurrent) return { ok: false as const, reasons: ['policy_not_current'] }
  const parsed = validateVocabularyDescriptor(input)
  if (!parsed.ok) return parsed
  if (!parsed.value.approval) return { ok: false as const, reasons: ['vocabulary_unapproved'] }
  const { approval, ...publicDescriptor } = parsed.value
  return { ok: true as const, value: structuredClone(publicDescriptor), reasons: [] }
}