// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import Ajv, { type AnySchemaObject } from 'ajv'
import addFormats from 'ajv-formats'
import type { StacSchemaValidator } from './stac-policy'

export interface StacSchemaSource { uri: string; sha256: string; bytes: Uint8Array }

export function addStacFormats(ajv: Ajv): void {
  addFormats(ajv)
  ajv.addFormat('iri', { type: 'string', validate: value => { try { new URL(value); return !/\s/.test(value) } catch { return false } } })
  ajv.addFormat('iri-reference', { type: 'string', validate: value => { try { new URL(value, 'https://schema.invalid/'); return !/\s/.test(value) } catch { return false } } })
}

export async function createStacSchemaValidator(sources: StacSchemaSource[]): Promise<StacSchemaValidator> {
  if (sources.length > 33 || sources.reduce((sum, source) => sum + source.bytes.byteLength, 0) > 1048576) throw new Error('Schema bundle exceeds bounds')
  const schemas = new Map<string, { schema: AnySchemaObject; digest: string }>()
  for (const source of sources) {
    const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(source.bytes))
    const digest = 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
    if (digest !== source.sha256 || schemas.has(source.uri)) throw new Error('Schema digest or identity mismatch')
    const schema = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as AnySchemaObject
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.$id?.replace(/#$/, '') !== source.uri
      || schema.$schema !== 'http://json-schema.org/draft-07/schema#') throw new Error('Expected identified draft-07 schema')
    schemas.set(source.uri, { schema, digest })
  }
  const resolve = (address: string): unknown => {
    const url = new URL(address)
    const fragment = decodeURIComponent(url.hash.slice(1))
    url.hash = ''
    let value: unknown = schemas.get(url.href)?.schema
    if (!value) throw new Error('Unresolved schema reference')
    if (fragment) {
      if (!fragment.startsWith('/')) throw new Error('Only JSON Pointer references are supported')
      for (const part of fragment.slice(1).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('Unresolved schema pointer')
        value = (value as Record<string, unknown>)[key]
      }
    }
    return value
  }
  // Both counters are bundle-wide budgets, not per-schema allowances.
  let references = 0
  let visited = 0
  const scan = (value: unknown, base: string, stack: Set<string>, depth: number, nesting: number): void => {
    if (++visited > 32768 || depth > 8 || nesting > 64) throw new Error('Schema reference or nesting depth exceeded')
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const entry of value) scan(entry, base, stack, depth, nesting + 1); return }
    const record = value as Record<string, unknown>
    if (record.$id !== undefined && record !== schemas.get(base)?.schema) throw new Error('Nested schema identities are unsupported')
    if (record.$ref !== undefined) {
      if (typeof record.$ref !== 'string') throw new Error('Invalid schema reference')
      const address = new URL(record.$ref, base).href
      if (stack.has(address)) throw new Error('Cyclic schema reference')
      const nextBase = new URL(address)
      nextBase.hash = ''
      scan(resolve(address), nextBase.href, new Set([...stack, address]), depth + 1, nesting + 1)
    }
    for (const [key, entry] of Object.entries(record)) {
      if (['$ref', 'const', 'enum', 'default', 'examples'].includes(key)) continue
      scan(entry, base, stack, depth, nesting + 1)
    }
  }
  for (const [uri, { schema }] of schemas) {
    const count = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value)) {
        if (key === '$ref') references++
        if (!['const', 'enum', 'default', 'examples'].includes(key)) count(entry)
      }
    }
    count(schema)
    if (references > 32) throw new Error('Too many schema references across the bundle (maximum 32)')
    scan(schema, uri, new Set([uri]), 0, 0)
  }
  const ajv = new Ajv({ strict: false, strictSchema: true, allErrors: false, validateFormats: true, ownProperties: true })
  addStacFormats(ajv)
  for (const { schema } of schemas.values()) ajv.addSchema(schema)
  for (const uri of schemas.keys()) ajv.getSchema(uri)
  return {
    validate(uri, digest, document) {
      const source = schemas.get(uri)
      if (!source) return 'unavailable'
      if (source.digest !== digest) return 'invalid'
      try { return ajv.getSchema(uri)?.(document) ? 'valid' : 'invalid' } catch { return 'invalid' }
    },
  }
}