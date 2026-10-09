// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STAC_SCHEMA_SEEDS = [
  'https://schemas.stacspec.org/v1.1.0/catalog-spec/json-schema/catalog.json',
  'https://schemas.stacspec.org/v1.1.0/collection-spec/json-schema/collection.json',
  'https://schemas.stacspec.org/v1.1.0/item-spec/json-schema/item.json',
  'https://stac-extensions.github.io/file/v2.1.0/schema.json',
  'https://stac-extensions.github.io/scientific/v1.0.0/schema.json',
] as const

export function isAllowedStacSchemaUri(uri: string, seeds: readonly string[] = STAC_SCHEMA_SEEDS): boolean {
  return uri.startsWith('https://schemas.stacspec.org/v1.1.0/')
    || uri.startsWith('https://geojson.org/schema/') || seeds.includes(uri)
}

export function stacSchemaFilename(uri: string): string {
  const url = new URL(uri)
  const name = (url.hostname + url.pathname).replace(/\.json$/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 140)
  const suffix = createHash('sha256').update(uri).digest('hex').slice(0, 12)
  return `${name}-${suffix}.json`
}

interface SchemaEntry { uri: string; file: string; sha256: string }

export async function vendorStacSchemas(
  destination = resolve('docs/metadata/schemas/official'),
  fetchSchema: typeof fetch = fetch,
  seeds: readonly string[] = STAC_SCHEMA_SEEDS,
): Promise<SchemaEntry[]> {
  const pending = [...new Set(seeds)]
  const manifest: SchemaEntry[] = []
  const files = new Map<string, Uint8Array>()
  for (let index = 0; index < pending.length; index++) {
    if (pending.length > 40) throw new Error('Unexpected schema dependency expansion')
    const uri = pending[index]
    if (!isAllowedStacSchemaUri(uri, seeds)) throw new Error(`Unreviewed schema host: ${uri}`)
    const response = await fetchSchema(uri)
    if (!response.ok) throw new Error(`${response.status}: ${uri}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const schema: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const [key, entry] of Object.entries(value)) {
        if (key === '$ref' && typeof entry === 'string') {
          const target = new URL(entry, uri)
          target.hash = ''
          if (!target.href.startsWith('http://json-schema.org/draft-07/schema') && !pending.includes(target.href)) pending.push(target.href)
        } else visit(entry)
      }
    }
    visit(schema)
    const file = stacSchemaFilename(uri)
    files.set(file, bytes)
    manifest.push({ uri, file, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') })
  }
  manifest.sort((first, second) => first.uri < second.uri ? -1 : first.uri > second.uri ? 1 : 0)
  let previous: SchemaEntry[] = []
  try { previous = JSON.parse(await readFile(resolve(destination, 'manifest.json'), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(destination, { recursive: true })
  for (const [file, bytes] of files) await writeFile(resolve(destination, file), bytes)
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const entry of previous) {
    if (!files.has(entry.file) && basename(entry.file) === entry.file
      && (/^\d{2}-[A-Za-z0-9._-]+\.json$/.test(entry.file) || entry.file === stacSchemaFilename(entry.uri))) {
      await rm(resolve(destination, entry.file), { force: true })
    }
  }
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = await vendorStacSchemas()
  console.log(`Vendored ${manifest.length} official schemas. Review every digest change before committing.`)
}