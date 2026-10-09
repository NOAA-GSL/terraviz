// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isAllowedStacSchemaUri, STAC_SCHEMA_SEEDS, stacSchemaFilename, vendorStacSchemas } from './vendor-stac-schemas'

describe('official schema maintenance', () => {
  it('allows every explicit seed, including a sixth extension, but not arbitrary discovered URLs', () => {
    const sixth = 'https://new-extension.example/v1.0.0/schema.json'
    const seeds = [...STAC_SCHEMA_SEEDS, sixth]
    for (const uri of seeds) expect(isAllowedStacSchemaUri(uri, seeds)).toBe(true)
    expect(isAllowedStacSchemaUri('https://unreviewed.example/schema.json', seeds)).toBe(false)
  })

  it('gives same-basename extensions descriptive distinct URI-derived names', () => {
    const file = stacSchemaFilename('https://stac-extensions.github.io/file/v2.1.0/schema.json')
    const scientific = stacSchemaFilename('https://stac-extensions.github.io/scientific/v1.0.0/schema.json')
    expect(file).toContain('file-v2.1.0-schema-')
    expect(scientific).toContain('scientific-v1.0.0-schema-')
    expect(file).not.toBe(scientific)
  })

  it('keeps filenames and manifest order stable when dependency discovery order changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stac-schemas-'))
    try {
      const root = 'https://schemas.stacspec.org/v1.1.0/test/root.json'
      const first = 'https://schemas.stacspec.org/v1.1.0/test/first.json'
      const second = 'https://schemas.stacspec.org/v1.1.0/test/second.json'
      let references = [first, second]
      const fetchSchema = vi.fn<typeof fetch>(async input => new Response(JSON.stringify({ $id: String(input),
        ...(String(input) === root ? { allOf: references.map($ref => ({ $ref })) } : { type: 'object' }) })))
      const original = await vendorStacSchemas(directory, fetchSchema, [root])
      references = [second, first]
      const reordered = await vendorStacSchemas(directory, fetchSchema, [root])
      expect(reordered.map(({ uri, file }) => ({ uri, file }))).toEqual(original.map(({ uri, file }) => ({ uri, file })))
      expect(reordered.filter(entry => entry.uri !== root)).toEqual(original.filter(entry => entry.uri !== root))
      expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toEqual(reordered)
      references = [first]
      await vendorStacSchemas(directory, fetchSchema, [root])
      expect(await readdir(directory)).not.toContain(stacSchemaFilename(second))
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})