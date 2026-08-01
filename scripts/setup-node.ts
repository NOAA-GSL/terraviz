/**
 * `npm run setup` — provision a Terraviz node's Cloudflare resources
 * and wire its Pages bindings.
 *
 * Automates Phases 2, 3, 4 and 8 of `docs/SELF_HOSTING.md`: create
 * the D1 / KV / R2 / Vectorize resources, repoint `wrangler.toml` at
 * them, apply both migration sets, and write every binding to both
 * the Production and Preview environments.
 *
 * ## What it deliberately does not do
 *
 * Account creation, Workers Paid, nameservers, Zero Trust onboarding,
 * the Pages project itself, Cloudflare Access, and the first SSO
 * sign-in. Those are either billing/registrar actions or one-time
 * dashboard flows; the guide covers them and this tool tells you when
 * one is blocking it.
 *
 * ## Plan by default
 *
 * A bare `npm run setup` writes nothing. It prints what it would
 * create and what it would set, and exits. `--apply` is the explicit
 * opt-in. Provisioning cloud resources and mutating a live deploy's
 * bindings is not something to do as a side effect of running a
 * command to see what it does.
 *
 * ## Resumability
 *
 * State lands in `.terraviz-setup.json` (gitignored) after every
 * resolution, not at the end — a run that dies partway through
 * Vectorize still records the D1 and KV IDs it resolved, so the next
 * run adopts rather than re-creates. Secret *values* are never
 * written there.
 *
 * Usage:
 *   npm run setup                    # plan only
 *   npm run setup -- --apply         # provision + wire
 *   npm run setup -- --only=bindings # one step
 *   npm run setup -- --apply --local-migrations
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPECTED_BINDINGS } from './lib/expected-bindings.ts'
import {
  buildPatchBody,
  formatBindingsPlan,
  OPTIONAL_EXTRAS,
  planBindings,
  type SecretSource,
} from './lib/setup/bindings-plan.ts'
import { PagesProjectWriter } from './lib/setup/cf-pages-write.ts'
import {
  applyMigrations,
  ensureD1,
  ensureKv,
  ensureR2Bucket,
  ensureVectorizeIndex,
  ensureVectorizeMetadata,
  isSnapshotFileFailure,
  SNAPSHOT_MIGRATION_FILE,
  type CommandResult,
  type CommandRunner,
} from './lib/setup/provision.ts'
import {
  applyEnvOverrides,
  hydrateState,
  serialiseState,
  VECTORIZE_METADATA_PROPERTIES,
  type SetupEnv,
  type SetupState,
} from './lib/setup/state.ts'
import { repointWranglerToml, stillPinnedUpstream } from './lib/setup/wrangler-toml.ts'

const STEPS = ['resources', 'wrangler-toml', 'migrations', 'bindings'] as const
type Step = (typeof STEPS)[number]

export interface SetupDeps {
  argv: string[]
  env: SetupEnv & Record<string, string | undefined>
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  runner: CommandRunner
  readFile: (path: string) => string
  writeFile: (path: string, contents: string) => void
  exists: (path: string) => boolean
  fetchImpl?: typeof fetch
}

interface Options {
  apply: boolean
  steps: Set<Step>
  statePath: string
  wranglerPath: string
  devVarsPath: string
  localMigrations: boolean
  help: boolean
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = {
    apply: false,
    steps: new Set(STEPS),
    statePath: '.terraviz-setup.json',
    wranglerPath: 'wrangler.toml',
    devVarsPath: '.dev.vars',
    localMigrations: false,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--local-migrations') opts.localMigrations = true
    else if (arg.startsWith('--only=')) {
      const wanted = arg.slice('--only='.length).split(',').map(s => s.trim())
      const bad = wanted.filter(w => !STEPS.includes(w as Step))
      if (bad.length > 0) {
        return { error: `unknown step(s): ${bad.join(', ')}. Valid: ${STEPS.join(', ')}` }
      }
      opts.steps = new Set(wanted as Step[])
    } else if (arg.startsWith('--state=')) opts.statePath = arg.slice('--state='.length)
    else if (arg.startsWith('--config=')) opts.wranglerPath = arg.slice('--config='.length)
    else return { error: `unrecognised argument: ${arg}` }
  }
  return opts
}

const HELP = `
npm run setup — provision a Terraviz node (SELF_HOSTING.md Phases 2, 3, 4, 8)

  npm run setup                     Plan only. Writes nothing.
  npm run setup -- --apply          Create resources, repoint wrangler.toml,
                                    apply migrations, wire Pages bindings.

Options
  --apply                 Actually make changes. Off by default.
  --only=<steps>          Comma-separated subset of: ${STEPS.join(', ')}
  --local-migrations      Apply migrations to the local .wrangler/ DB
                          instead of --remote. Useful for a dry run.
  --state=<path>          State file (default .terraviz-setup.json)
  --config=<path>         Wrangler config (default wrangler.toml)

Environment
  CLOUDFLARE_ACCOUNT_ID          Required for the bindings step.
  CLOUDFLARE_API_TOKEN           Required for the bindings step.
                                 Needs Account -> Cloudflare Pages -> Edit.
  CLOUDFLARE_PAGES_PROJECT_NAME  Defaults to the state file's value.
  ACCESS_TEAM_DOMAIN, ACCESS_AUD, TRUSTED_PUBLISHER_DOMAINS,
  R2_PUBLIC_BASE, GITHUB_OWNER, GITHUB_REPO
                                 Optional; set the matching binding when present.

Secrets are read from the environment first, then from .dev.vars, and only
for names the binding manifest declares as secrets. Their values are never
logged and never written to the state file.

Prerequisites this tool cannot do for you (see docs/SELF_HOSTING.md):
  Phase 0  Cloudflare account, Workers Paid, domain on Cloudflare DNS
  Phase 5  the Pages project itself
  Phase 6  Cloudflare Access application + service token
  Phase 11 the first SSO sign-in
`

/**
 * Read secret values for manifest-declared secrets only.
 *
 * The allowlist matters: `.dev.vars` also carries `DEV_BYPASS_ACCESS`
 * and the `MOCK_*` flags, and pushing those to a production Pages
 * environment would disable Access authentication on the publisher
 * API. Reading strictly by manifest name makes that unexpressible.
 */
export function collectSecrets(
  env: Record<string, string | undefined>,
  devVars: string | null,
): SecretSource {
  const names = EXPECTED_BINDINGS.filter(b => b.type === 'secret').map(b => b.name)
  const out: Record<string, string> = {}
  const fromFile = devVars ? parseDotEnv(devVars) : {}
  for (const name of names) {
    const value = env[name] ?? fromFile[name]
    if (value) out[name] = value
  }
  return out
}

/** Minimal dotenv parse — `KEY=value`, `#` comments, optional quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (value) out[key] = value
  }
  return out
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  const parsed = parseArgs(deps.argv)
  if ('error' in parsed) {
    deps.stderr.write(`setup: ${parsed.error}\n${HELP}`)
    return 2
  }
  const opts = parsed
  if (opts.help) {
    deps.stdout.write(HELP)
    return 0
  }

  // ── State ───────────────────────────────────────────────────────
  let state = hydrateState(
    deps.exists(opts.statePath) ? safeJson(deps.readFile(opts.statePath)) : null,
  )
  state = applyEnvOverrides(state, deps.env)

  const persist = (): void => {
    if (opts.apply) deps.writeFile(opts.statePath, serialiseState(state))
  }

  const mode = opts.apply ? 'APPLY' : 'PLAN (no changes — pass --apply to execute)'
  deps.stdout.write(`Terraviz node setup — ${mode}\n`)
  deps.stdout.write(`  state:   ${opts.statePath}\n`)
  deps.stdout.write(`  project: ${state.pagesProject}\n\n`)

  // ── Step: resources ─────────────────────────────────────────────
  if (opts.steps.has('resources')) {
    deps.stdout.write('── Phase 2 — Cloudflare resources ──────────────────\n')
    if (!opts.apply) {
      deps.stdout.write(
        `  would ensure D1        ${state.d1.name}${idNote(state.d1.id)}\n` +
          `  would ensure KV        ${state.telemetryKv.name}${idNote(state.telemetryKv.id)}\n` +
          `  would ensure KV        ${state.catalogKv.name}${idNote(state.catalogKv.id)}\n` +
          `  would ensure R2        ${state.r2Bucket.name}\n` +
          `  would ensure Vectorize ${state.vectorizeIndex.name} (768/cosine)\n` +
          `  would ensure metadata  ${VECTORIZE_METADATA_PROPERTIES.join(', ')}\n` +
          '  Analytics Engine       no action — the dataset is created on first write\n\n',
      )
    } else {
      try {
        const d1 = await ensureD1(deps.runner, state.d1.name)
        state.d1.id = d1.id
        persist()
        deps.stdout.write(`  D1        ${state.d1.name}  ${verb(d1.created)} (${d1.id})\n`)

        const tel = await ensureKv(deps.runner, state.telemetryKv.name)
        state.telemetryKv.id = tel.id
        persist()
        deps.stdout.write(
          `  KV        ${state.telemetryKv.name}  ${verb(tel.created)} (${tel.id})\n`,
        )

        const cat = await ensureKv(deps.runner, state.catalogKv.name)
        state.catalogKv.id = cat.id
        persist()
        deps.stdout.write(
          `  KV        ${state.catalogKv.name}  ${verb(cat.created)} (${cat.id})\n`,
        )

        const r2 = await ensureR2Bucket(deps.runner, state.r2Bucket.name)
        deps.stdout.write(`  R2        ${state.r2Bucket.name}  ${verb(r2.created)}\n`)

        const vec = await ensureVectorizeIndex(deps.runner, state.vectorizeIndex.name)
        deps.stdout.write(
          `  Vectorize ${state.vectorizeIndex.name}  ${verb(vec.created)}\n`,
        )
        const meta = await ensureVectorizeMetadata(
          deps.runner,
          state.vectorizeIndex.name,
          VECTORIZE_METADATA_PROPERTIES,
        )
        state.vectorizeMetadata = [...meta.created, ...meta.existing]
        persist()
        deps.stdout.write(
          `  metadata  ${state.vectorizeMetadata.join(', ')}  ` +
            `(${meta.created.length} created, ${meta.existing.length} existing)\n\n`,
        )
      } catch (e) {
        deps.stderr.write(`\n  ✘ ${errText(e)}\n\n`)
        return 1
      }
    }
  }

  // ── Step: wrangler.toml ─────────────────────────────────────────
  if (opts.steps.has('wrangler-toml')) {
    deps.stdout.write('── Phase 3 — repoint wrangler.toml ─────────────────\n')
    if (!deps.exists(opts.wranglerPath)) {
      deps.stderr.write(`  ✘ ${opts.wranglerPath} not found\n\n`)
      return 1
    }
    const source = deps.readFile(opts.wranglerPath)
    const result = repointWranglerToml(source, {
      d1DatabaseId: state.d1.id,
      telemetryKvId: state.telemetryKv.id,
      catalogKvId: state.catalogKv.id,
      d1DatabaseName: state.d1.name,
      r2BucketName: state.r2Bucket.name,
      vectorizeIndexName: state.vectorizeIndex.name,
      analyticsDataset: state.analyticsDataset.name,
    })
    if (result.unmatched.length > 0) {
      deps.stderr.write(
        `  ! no block found for: ${result.unmatched.join(', ')} — ` +
          'wrangler.toml has drifted from what this tool expects\n',
      )
    }
    if (result.changes.length === 0) {
      const pinned = stillPinnedUpstream(source)
      if (pinned.length > 0) {
        // On a fresh clone this is the expected state, so in plan
        // mode it is information, not an error — the operator wants
        // to see the rest of the plan. Under --apply it is fatal:
        // leaving upstream IDs in place aims `d1 migrations apply` at
        // a database the operator does not own.
        const message =
          `still pinned to upstream: ${pinned.join(', ')}\n` +
          '    Resource IDs are not known yet — run the resources step first.\n\n'
        if (opts.apply) {
          deps.stderr.write(`  ✘ ${message}`)
          return 1
        }
        deps.stdout.write(`  ! ${message}`)
      } else {
        deps.stdout.write('  already correct — no changes\n\n')
      }
    } else {
      for (const c of result.changes) {
        deps.stdout.write(
          `  ${opts.apply ? 'set ' : 'would set '}${c.binding}.${c.key} ` +
            `${short(c.from)} → ${short(c.to)}  (line ${c.line})\n`,
        )
      }
      if (opts.apply) deps.writeFile(opts.wranglerPath, result.text)
      deps.stdout.write('\n')
    }
  }

  // ── Step: migrations ────────────────────────────────────────────
  if (opts.steps.has('migrations')) {
    const target = opts.localMigrations ? '--local' : '--remote'
    deps.stdout.write(`── Phase 4 — migrations (${target}) ─────────────────\n`)
    if (!opts.apply) {
      deps.stdout.write(
        '  would apply CATALOG_DB   (migrations/catalog/)\n' +
          '  would apply FEEDBACK_DB  (migrations/)\n' +
          '  CATALOG_DB runs first — see isSnapshotFileFailure() in\n' +
          '  scripts/lib/setup/provision.ts for why the order matters.\n\n',
      )
    } else {
      // CATALOG_DB first — see isSnapshotFileFailure(). Reversing
      // these on a fresh database lets the generated
      // `catalog-schema.sql` snapshot apply for real and wreck the
      // catalog migration sequence.
      for (const binding of ['CATALOG_DB', 'FEEDBACK_DB'] as const) {
        const res = await applyMigrations(deps.runner, binding, !opts.localMigrations)
        if (res.code === 0) {
          deps.stdout.write(`  ${binding}  applied\n`)
          continue
        }
        if (binding === 'FEEDBACK_DB' && isSnapshotFileFailure(res)) {
          deps.stdout.write(
            `  ${binding}  applied — then stopped on ${SNAPSHOT_MIGRATION_FILE}\n` +
              `           (a generated snapshot, not a migration; it lives in this\n` +
              `           binding's migrations dir and always fails here. Harmless\n` +
              `           because CATALOG_DB ran first.)\n`,
          )
          continue
        }
        deps.stderr.write(
          `  ✘ ${binding}: ${(res.stderr || res.stdout).trim().slice(0, 400)}\n\n`,
        )
        return 1
      }
      deps.stdout.write('\n')
    }
  }

  // ── Step: bindings ──────────────────────────────────────────────
  if (opts.steps.has('bindings')) {
    deps.stdout.write('── Phase 8 — Pages bindings (Production + Preview) ──\n')
    const devVars = deps.exists(opts.devVarsPath) ? deps.readFile(opts.devVarsPath) : null
    const secrets = collectSecrets(deps.env, devVars)
    const plan = planBindings(state, secrets, [...EXPECTED_BINDINGS, ...OPTIONAL_EXTRAS])
    deps.stdout.write(formatBindingsPlan(plan) + '\n\n')

    // R2 / Vectorize / Analytics Engine / AI bindings address their
    // resource by name, so they "resolve" from defaults even on a
    // completely fresh state. Only the D1 and KV IDs prove the
    // resources step actually ran. Writing the name-based half alone
    // would leave a deploy that looks wired and isn't — exactly the
    // half-configured state this tool exists to prevent — so require
    // the IDs before touching a live project.
    const unresolvedIds = [
      state.d1.id ? null : 'D1',
      state.telemetryKv.id ? null : 'TELEMETRY_KILL_SWITCH',
      state.catalogKv.id ? null : 'CATALOG_KV',
    ].filter((x): x is string => x !== null)

    if (opts.apply && unresolvedIds.length > 0) {
      deps.stderr.write(
        `  ✘ no resource ID for: ${unresolvedIds.join(', ')}\n` +
          '    Run the resources step first, or fill the IDs into ' +
          `${opts.statePath} by hand.\n\n`,
      )
      return 1
    }

    if (opts.apply) {
      const token = deps.env.CLOUDFLARE_API_TOKEN
      const accountId = state.accountId
      if (!token || !accountId) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to write bindings.\n' +
            '    The token needs Account → Cloudflare Pages → Edit.\n\n',
        )
        return 2
      }
      const writer = new PagesProjectWriter({
        apiToken: token,
        accountId,
        projectName: state.pagesProject,
        fetchImpl: deps.fetchImpl,
      })
      try {
        await writer.patchBindings(buildPatchBody(plan))
      } catch (e) {
        deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
        return 1
      }
      state.lastAppliedAt = new Date().toISOString()
      persist()
      deps.stdout.write(
        `  wrote ${plan.resolved.length} binding(s) to both environments\n\n`,
      )
    }

    if (plan.skipped.length > 0) {
      deps.stdout.write(
        `  ${plan.skipped.length} binding(s) left unset — these are the manual\n` +
          '  pieces (Access values from Phase 6, secrets from Phase 7, and the\n' +
          '  Phase 13 add-ons). Re-run once you have them.\n\n',
      )
    }
  }

  // ── Next steps ──────────────────────────────────────────────────
  if (opts.apply) {
    deps.stdout.write(
      'Next:\n' +
        '  1. Redeploy — bindings take effect on the next deployment, not immediately.\n' +
        '  2. npm run check:pages-bindings      (audits what we just wrote)\n' +
        '  3. npm run terraviz -- verify-deploy --server https://<your-host>\n',
    )
  } else {
    deps.stdout.write('Re-run with --apply to execute.\n')
  }
  return 0
}

// ── helpers ───────────────────────────────────────────────────────

function idNote(id: string | undefined): string {
  return id ? `  (known: ${id})` : '  (id unknown — will resolve)'
}
function verb(created: boolean): string {
  return created ? 'created ' : 'adopted '
}
function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s || '(empty)'
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Real wrangler execution. Never inherits stdio — output is parsed. */
export const wranglerRunner: CommandRunner = argv =>
  new Promise<CommandResult>(res => {
    execFile(
      'npx',
      ['wrangler', ...argv],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0
        res({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  const code = await runSetup({
    argv: process.argv.slice(2),
    env: process.env as SetupEnv & Record<string, string | undefined>,
    stdout: { write: s => process.stdout.write(s) },
    stderr: { write: s => process.stderr.write(s) },
    runner: wranglerRunner,
    readFile: p => readFileSync(resolve(p), 'utf-8'),
    writeFile: (p, c) => writeFileSync(resolve(p), c, 'utf-8'),
    exists: p => existsSync(resolve(p)),
  })
  process.exit(code)
}
