import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  repointWranglerToml,
  stillPinnedUpstream,
  UPSTREAM_PINNED_IDS,
} from './wrangler-toml'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const realConfig = (): string => readFileSync(resolve(REPO_ROOT, 'wrangler.toml'), 'utf-8')

const FIXTURE = `
name = "terraviz"

[ai]
binding = "AI"

[[d1_databases]]
binding = "FEEDBACK_DB"
database_name = "sphere-feedback"
database_id = "OLD-D1"
migrations_dir = "migrations"

[[d1_databases]]
binding = "CATALOG_DB"
database_name = "sphere-feedback"
database_id = "OLD-D1"
migrations_dir = "migrations/catalog"

# Example command quoting the upstream id:
#   wrangler kv key put telemetry_enabled disabled --namespace-id=OLD-TEL
[[kv_namespaces]]
binding = "TELEMETRY_KILL_SWITCH"
id = "OLD-TEL"

[[kv_namespaces]]
binding = "CATALOG_KV"
id = "OLD-CAT"

[[r2_buckets]]
binding = "CATALOG_R2"
bucket_name = "terraviz-assets"
`.trimStart()

describe('repointWranglerToml', () => {
  it('rewrites both D1 blocks even though they share a database_name', () => {
    const { text, changes } = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    expect(changes.map(c => c.binding)).toEqual(['FEEDBACK_DB', 'CATALOG_DB'])
    expect(text).not.toContain('OLD-D1')
    expect(text.match(/database_id = "NEW-D1"/g)).toHaveLength(2)
  })

  it('distinguishes the two KV blocks, which share a section header', () => {
    const { text } = repointWranglerToml(FIXTURE, {
      telemetryKvId: 'NEW-TEL',
      catalogKvId: 'NEW-CAT',
    })
    const telBlock = text.slice(text.indexOf('TELEMETRY_KILL_SWITCH'))
    expect(telBlock).toMatch(/id = "NEW-TEL"/)
    const catBlock = text.slice(text.indexOf('binding = "CATALOG_KV"'))
    expect(catBlock).toMatch(/id = "NEW-CAT"/)
  })

  it('leaves example commands inside comments alone', () => {
    const { text } = repointWranglerToml(FIXTURE, { telemetryKvId: 'NEW-TEL' })
    expect(text).toContain('--namespace-id=OLD-TEL')
  })

  it('preserves migrations_dir, which is what disambiguates the D1 blocks', () => {
    const { text } = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    expect(text).toContain('migrations_dir = "migrations"')
    expect(text).toContain('migrations_dir = "migrations/catalog"')
  })

  it('is idempotent — a second run reports no changes', () => {
    const first = repointWranglerToml(FIXTURE, { d1DatabaseId: 'NEW-D1' })
    const second = repointWranglerToml(first.text, { d1DatabaseId: 'NEW-D1' })
    expect(second.changes).toEqual([])
    expect(second.text).toBe(first.text)
  })

  it('ignores undefined targets rather than blanking the field', () => {
    const { text, changes } = repointWranglerToml(FIXTURE, {})
    expect(changes).toEqual([])
    expect(text).toBe(FIXTURE)
  })

  it('reports a binding whose block is absent instead of silently skipping', () => {
    const { unmatched } = repointWranglerToml('name = "x"\n', { d1DatabaseId: 'NEW' })
    expect(unmatched).toContain('d1_databases/FEEDBACK_DB')
  })

  it('records line numbers an operator can act on', () => {
    const { changes } = repointWranglerToml(FIXTURE, { catalogKvId: 'NEW-CAT' })
    expect(changes).toHaveLength(1)
    const line = FIXTURE.split('\n')[changes[0].line - 1]
    expect(line).toContain('id = ')
  })

  // The point of the whole module: it has to work on the file that
  // actually ships, not just a fixture shaped like it.
  it('repoints the real wrangler.toml', () => {
    const { text, changes, unmatched } = repointWranglerToml(realConfig(), {
      d1DatabaseId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      telemetryKvId: '11111111111111111111111111111111',
      catalogKvId: '22222222222222222222222222222222',
    })
    expect(unmatched).toEqual([])
    expect(changes.map(c => `${c.binding}.${c.key}`)).toEqual([
      'FEEDBACK_DB.database_id',
      'CATALOG_DB.database_id',
      'TELEMETRY_KILL_SWITCH.id',
      'CATALOG_KV.id',
    ])
    expect(stillPinnedUpstream(text)).toEqual([])
  })
})

describe('stillPinnedUpstream', () => {
  it('flags the shipped file as pinned to upstream', () => {
    // If this ever fails, either someone committed their own IDs or
    // the upstream constants drifted — both worth catching.
    expect(stillPinnedUpstream(realConfig()).sort()).toEqual([
      'CATALOG_DB',
      'CATALOG_KV',
      'FEEDBACK_DB',
      'TELEMETRY_KILL_SWITCH',
    ])
  })

  it('reports nothing once repointed', () => {
    const { text } = repointWranglerToml(realConfig(), {
      d1DatabaseId: 'mine-d1',
      telemetryKvId: 'mine-tel',
      catalogKvId: 'mine-cat',
    })
    expect(stillPinnedUpstream(text)).toEqual([])
  })

  it('knows the upstream ids the repo actually ships', () => {
    const config = realConfig()
    expect(config).toContain(UPSTREAM_PINNED_IDS.d1)
    expect(config).toContain(UPSTREAM_PINNED_IDS.telemetryKv)
    expect(config).toContain(UPSTREAM_PINNED_IDS.catalogKv)
  })
})
