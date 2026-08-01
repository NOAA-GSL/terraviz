import { describe, expect, it } from 'vitest'
import { collectSecrets, parseDotEnv, runSetup, type SetupDeps } from './setup-node.ts'
import type { CommandResult } from './lib/setup/provision.ts'

interface Harness {
  deps: SetupDeps
  out: () => string
  errOut: () => string
  writes: Map<string, string>
  calls: string[][]
}

function harness(overrides: Partial<SetupDeps> & { files?: Record<string, string> } = {}): Harness {
  const chunks: string[] = []
  const errChunks: string[] = []
  const writes = new Map<string, string>()
  const calls: string[][] = []
  const files: Record<string, string> = overrides.files ?? {}

  const deps: SetupDeps = {
    argv: [],
    env: {},
    stdout: { write: s => void chunks.push(s) },
    stderr: { write: s => void errChunks.push(s) },
    runner: async argv => {
      calls.push(argv)
      return { code: 0, stdout: '', stderr: '' } satisfies CommandResult
    },
    readFile: p => {
      if (p in files) return files[p]
      throw new Error(`unexpected read: ${p}`)
    },
    writeFile: (p, c) => void writes.set(p, c),
    exists: p => p in files,
    ...overrides,
  }
  return { deps, out: () => chunks.join(''), errOut: () => errChunks.join(''), writes, calls }
}

describe('parseDotEnv', () => {
  it('reads plain assignments and strips quotes', () => {
    expect(parseDotEnv('A=1\nB="two"\nC=\'three\'')).toEqual({ A: '1', B: 'two', C: 'three' })
  })

  it('ignores comments, blanks and malformed lines', () => {
    expect(parseDotEnv('# note\n\nBARE\n=novalue\nD=4')).toEqual({ D: '4' })
  })

  it('keeps base64 padding and other = characters in the value', () => {
    expect(parseDotEnv('K=abc=def==').K).toBe('abc=def==')
  })
})

describe('collectSecrets', () => {
  it('reads a manifest secret from the environment', () => {
    const s = collectSecrets({ PREVIEW_SIGNING_KEY: 'env-value' }, null)
    expect(s.PREVIEW_SIGNING_KEY).toBe('env-value')
  })

  it('falls back to .dev.vars', () => {
    const s = collectSecrets({}, 'NODE_ID_PRIVATE_KEY_PEM=from-file')
    expect(s.NODE_ID_PRIVATE_KEY_PEM).toBe('from-file')
  })

  it('prefers the environment over .dev.vars', () => {
    const s = collectSecrets(
      { PREVIEW_SIGNING_KEY: 'from-env' },
      'PREVIEW_SIGNING_KEY=from-file',
    )
    expect(s.PREVIEW_SIGNING_KEY).toBe('from-env')
  })

  // The safety property this allowlist exists for: .dev.vars carries
  // DEV_BYPASS_ACCESS=true and the MOCK_* flags, and pushing those to
  // a production Pages environment would disable Access auth on the
  // publisher API.
  it('never picks up dev-only flags from .dev.vars', () => {
    const devVars = [
      'DEV_BYPASS_ACCESS=true',
      'DEV_PUBLISHER_EMAIL=dev@localhost',
      'MOCK_R2=true',
      'MOCK_AI=true',
      'MOCK_STREAM=true',
      'ALLOW_DEV_PREVIEW_FALLBACK=true',
      'PREVIEW_SIGNING_KEY=real',
    ].join('\n')
    const s = collectSecrets({}, devVars)
    expect(Object.keys(s)).toEqual(['PREVIEW_SIGNING_KEY'])
    expect(s.DEV_BYPASS_ACCESS).toBeUndefined()
    expect(s.MOCK_R2).toBeUndefined()
  })

  it('ignores an environment variable that is not a manifest secret', () => {
    const s = collectSecrets({ SOMETHING_ELSE: 'x' }, null)
    expect(s.SOMETHING_ELSE).toBeUndefined()
  })
})

describe('runSetup — plan mode', () => {
  it('is the default and makes no changes', async () => {
    const h = harness({ files: { 'wrangler.toml': 'name = "terraviz"\n' } })
    const code = await runSetup(h.deps)
    expect(code).toBe(0)
    expect(h.writes.size).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.out()).toContain('PLAN (no changes')
    expect(h.out()).toContain('Re-run with --apply')
  })

  it('shows what it would create', async () => {
    const h = harness({ files: { 'wrangler.toml': '' }, argv: ['--only=resources'] })
    await runSetup(h.deps)
    expect(h.out()).toContain('would ensure D1')
    expect(h.out()).toContain('would ensure Vectorize')
    expect(h.out()).toContain('created on first write')
  })

  it('reports unknown steps rather than silently doing everything', async () => {
    const h = harness({ argv: ['--only=bogus'] })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('unknown step')
  })

  it('rejects an unrecognised flag', async () => {
    const h = harness({ argv: ['--force'] })
    expect(await runSetup(h.deps)).toBe(2)
  })

  it('prints help without touching anything', async () => {
    const h = harness({ argv: ['--help'] })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('Prerequisites this tool cannot do for you')
    expect(h.writes.size).toBe(0)
  })
})

describe('runSetup — wrangler.toml step', () => {
  const CONFIG = [
    '[[d1_databases]]',
    'binding = "CATALOG_DB"',
    'database_name = "sphere-feedback"',
    'database_id = "78fbe5c3-8e40-4504-b183-155b0069222e"',
    '',
  ].join('\n')

  // A fresh clone is legitimately still pinned upstream, so the plan
  // reports it and carries on; only an apply treats it as fatal,
  // because running migrations against upstream's database is the
  // failure this whole guard exists to prevent.
  it('reports upstream pinning in plan mode without failing', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml'],
      files: { 'wrangler.toml': CONFIG },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('still pinned to upstream')
    expect(h.writes.size).toBe(0)
  })

  it('refuses to apply while still pinned upstream', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml', '--apply'],
      files: { 'wrangler.toml': CONFIG },
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('still pinned to upstream')
    expect(h.writes.has('wrangler.toml')).toBe(false)
  })

  it('writes the repointed file under --apply', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml', '--apply'],
      files: {
        'wrangler.toml': CONFIG,
        '.terraviz-setup.json': JSON.stringify({ d1: { name: 'db', id: 'MY-ID' } }),
      },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.writes.get('wrangler.toml')).toContain('database_id = "MY-ID"')
  })

  it('does not write the file in plan mode', async () => {
    const h = harness({
      argv: ['--only=wrangler-toml'],
      files: {
        'wrangler.toml': CONFIG,
        '.terraviz-setup.json': JSON.stringify({ d1: { name: 'db', id: 'MY-ID' } }),
      },
    })
    await runSetup(h.deps)
    expect(h.writes.has('wrangler.toml')).toBe(false)
    expect(h.out()).toContain('would set')
  })
})

describe('runSetup — migrations step', () => {
  // CATALOG_DB must run first. Verified against a clean database:
  // FEEDBACK_DB's migrations dir also holds the generated
  // catalog-schema.sql snapshot, which on an empty database applies
  // for real and creates the whole catalog schema outside the
  // migration tracker — after which every CATALOG_DB migration fails
  // on "table node_identity already exists".
  it('applies CATALOG_DB before FEEDBACK_DB', async () => {
    const h = harness({ argv: ['--only=migrations', '--apply'], files: {} })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.calls.map(c => c[3])).toEqual(['CATALOG_DB', 'FEEDBACK_DB'])
  })

  it('tolerates the known catalog-schema.sql failure on FEEDBACK_DB', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async argv =>
        argv[3] === 'FEEDBACK_DB'
          ? { code: 1, stdout: '', stderr: 'table analytics_daily already exists' }
          : { code: 0, stdout: '', stderr: '' },
    })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('catalog-schema.sql')
  })

  it('does not extend that tolerance to CATALOG_DB', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async () => ({ code: 1, stdout: '', stderr: 'table datasets already exists' }),
    })
    expect(await runSetup(h.deps)).toBe(1)
  })

  it('stops on the first failure instead of reporting success', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply'],
      files: {},
      runner: async () => ({ code: 1, stdout: '', stderr: 'no such database' }),
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('no such database')
  })

  it('honours --local-migrations for a dry run', async () => {
    const h = harness({
      argv: ['--only=migrations', '--apply', '--local-migrations'],
      files: {},
    })
    await runSetup(h.deps)
    expect(h.calls[0]).toContain('--local')
    expect(h.calls[0]).not.toContain('--remote')
  })
})

describe('runSetup — bindings step', () => {
  const state = JSON.stringify({
    accountId: 'acct',
    pagesProject: 'my-node',
    d1: { name: 'db', id: 'd1id' },
    telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'kv1' },
    catalogKv: { name: 'CATALOG_KV', id: 'kv2' },
  })

  it('needs a token and account id before it will write', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      files: { '.terraviz-setup.json': state },
    })
    expect(await runSetup(h.deps)).toBe(2)
    expect(h.errOut()).toContain('Cloudflare Pages → Edit')
  })

  it('PATCHes both environments and reports the manual leftovers', async () => {
    let body: unknown
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(0)
    const configs = (body as { deployment_configs: Record<string, unknown> }).deployment_configs
    expect(Object.keys(configs).sort()).toEqual(['preview', 'production'])
    expect(h.out()).toContain('left unset')
  })

  it('surfaces an API failure rather than claiming success', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': state },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), {
          status: 403,
          statusText: 'Forbidden',
        })) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('Cloudflare Pages → Edit')
  })

  // R2 / Vectorize / AE / AI bindings resolve from default *names*
  // even with no state at all, so "something resolved" is not proof
  // the resources exist. Only the D1 + KV ids are.
  it('refuses to write a half-wired project when the resource ids are unknown', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok' },
      files: { '.terraviz-setup.json': JSON.stringify({ accountId: 'a' }) },
      fetchImpl: (async () => {
        throw new Error('must not reach the API')
      }) as unknown as typeof fetch,
    })
    expect(await runSetup(h.deps)).toBe(1)
    expect(h.errOut()).toContain('no resource ID for')
    expect(h.errOut()).toContain('the resources step first')
  })

  it('still plans without ids, so an operator can preview the shape', async () => {
    const h = harness({ argv: ['--only=bindings'], files: {} })
    expect(await runSetup(h.deps)).toBe(0)
    expect(h.out()).toContain('CATALOG_DB')
  })
})

describe('runSetup — state persistence', () => {
  it('never persists a secret value', async () => {
    const h = harness({
      argv: ['--only=bindings', '--apply'],
      env: { CLOUDFLARE_API_TOKEN: 'tok', PREVIEW_SIGNING_KEY: 'NEVER-PERSIST-ME' },
      files: {
        '.terraviz-setup.json': JSON.stringify({
          accountId: 'a',
          d1: { name: 'db', id: 'x' },
          telemetryKv: { name: 'TELEMETRY_KILL_SWITCH', id: 'kv1' },
          catalogKv: { name: 'CATALOG_KV', id: 'kv2' },
        }),
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch,
    })
    await runSetup(h.deps)
    expect(h.writes.get('.terraviz-setup.json')).not.toContain('NEVER-PERSIST-ME')
  })

  it('writes no state file in plan mode', async () => {
    const h = harness({ argv: ['--only=resources'], files: {} })
    await runSetup(h.deps)
    expect(h.writes.has('.terraviz-setup.json')).toBe(false)
  })
})
