/**
 * Resumable state for `npm run setup` — the machine-readable form of
 * the worksheet in `docs/SELF_HOSTING.md`.
 *
 * Installs fail halfway. A network blip during Vectorize creation, a
 * token that turns out to lack a permission, an operator who has to
 * go enable Workers Paid — every one of those leaves the account in a
 * partially-provisioned state. Re-running has to *converge* on the
 * target rather than duplicate what already exists, so every step
 * records what it resolved here and every step reads what earlier
 * steps resolved.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **No secret values are ever persisted.** The state file sits
 *      in the working tree (gitignored, but still on disk in
 *      plaintext). Secret *names* live in `expected-bindings.ts`;
 *      their values are read from the environment or `.dev.vars` at
 *      apply time and passed straight through to the Cloudflare API.
 *      `SetupState` has nowhere to put one, deliberately.
 *   2. **Resource names are inputs, resource IDs are outputs.** A
 *      fork may rename `terraviz-assets`; it may not invent a D1
 *      database ID. Names come from defaults or operator override,
 *      IDs only ever come from Cloudflare.
 */

/** Default resource names, matching `wrangler.toml` as shipped. */
export const DEFAULT_NAMES = {
  d1: 'sphere-feedback',
  telemetryKv: 'TELEMETRY_KILL_SWITCH',
  catalogKv: 'CATALOG_KV',
  r2Bucket: 'terraviz-assets',
  vectorizeIndex: 'terraviz-datasets',
  analyticsDataset: 'terraviz_events',
  pagesProject: 'terraviz',
} as const

/** The three metadata indexes the Vectorize query filters require. */
export const VECTORIZE_METADATA_PROPERTIES = ['peer_id', 'category', 'visibility'] as const

export interface ResourceRef {
  /** Name/title as it appears in the Cloudflare dashboard. */
  name: string
  /**
   * Cloudflare-assigned ID. Absent until the resource has been
   * created or adopted. Only D1 and KV bindings need one — R2,
   * Vectorize and Analytics Engine bindings address their resource
   * by name.
   */
  id?: string
}

export interface SetupState {
  /** Cloudflare account the resources live in (worksheet W1). */
  accountId?: string
  /** Pages project name (W10). */
  pagesProject: string
  /** Public hostname, no scheme (W2). Informational for slice 1. */
  hostname?: string

  d1: ResourceRef
  telemetryKv: ResourceRef
  catalogKv: ResourceRef
  r2Bucket: ResourceRef
  vectorizeIndex: ResourceRef
  analyticsDataset: ResourceRef

  /** Vectorize metadata indexes confirmed present. */
  vectorizeMetadata: string[]

  /**
   * Cloudflare Access team domain (W12) and application audience tag
   * (W13). Slice 2 provisions these; slice 1 consumes them if the
   * operator already has them, so a re-run after Access is set up
   * fills in `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` without a second
   * tool.
   */
  accessTeamDomain?: string
  accessAud?: string

  /** Comma-separated email domains for `TRUSTED_PUBLISHER_DOMAINS`. */
  trustedPublisherDomains?: string

  /** Public origin for the R2 bucket (`R2_PUBLIC_BASE`, W19). */
  r2PublicBase?: string

  /** Transcode dispatch target (Phase 13.2). */
  githubOwner?: string
  githubRepo?: string

  /** ISO timestamp of the last successful apply, for operator context. */
  lastAppliedAt?: string
}

export function defaultState(): SetupState {
  return {
    pagesProject: DEFAULT_NAMES.pagesProject,
    d1: { name: DEFAULT_NAMES.d1 },
    telemetryKv: { name: DEFAULT_NAMES.telemetryKv },
    catalogKv: { name: DEFAULT_NAMES.catalogKv },
    r2Bucket: { name: DEFAULT_NAMES.r2Bucket },
    vectorizeIndex: { name: DEFAULT_NAMES.vectorizeIndex },
    analyticsDataset: { name: DEFAULT_NAMES.analyticsDataset },
    vectorizeMetadata: [],
  }
}

/**
 * Merge a parsed state file over the defaults. Unknown keys are
 * dropped and malformed sub-objects fall back to their default rather
 * than throwing — a hand-edited state file should degrade to "re-
 * resolve that resource", never to a crash the operator can't read.
 */
export function hydrateState(raw: unknown): SetupState {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>

  const ref = (key: keyof SetupState, fallback: ResourceRef): ResourceRef => {
    const v = r[key]
    if (!v || typeof v !== 'object') return fallback
    const o = v as Record<string, unknown>
    return {
      name: typeof o.name === 'string' && o.name ? o.name : fallback.name,
      id: typeof o.id === 'string' && o.id ? o.id : undefined,
    }
  }
  const str = (key: keyof SetupState): string | undefined => {
    const v = r[key]
    return typeof v === 'string' && v ? v : undefined
  }

  return {
    accountId: str('accountId'),
    pagesProject: str('pagesProject') ?? base.pagesProject,
    hostname: str('hostname'),
    d1: ref('d1', base.d1),
    telemetryKv: ref('telemetryKv', base.telemetryKv),
    catalogKv: ref('catalogKv', base.catalogKv),
    r2Bucket: ref('r2Bucket', base.r2Bucket),
    vectorizeIndex: ref('vectorizeIndex', base.vectorizeIndex),
    analyticsDataset: ref('analyticsDataset', base.analyticsDataset),
    vectorizeMetadata: Array.isArray(r.vectorizeMetadata)
      ? r.vectorizeMetadata.filter((x): x is string => typeof x === 'string')
      : [],
    accessTeamDomain: str('accessTeamDomain'),
    accessAud: str('accessAud'),
    trustedPublisherDomains: str('trustedPublisherDomains'),
    r2PublicBase: str('r2PublicBase'),
    githubOwner: str('githubOwner'),
    githubRepo: str('githubRepo'),
    lastAppliedAt: str('lastAppliedAt'),
  }
}

/**
 * Environment overrides, applied over the persisted state. Lets CI
 * (or an operator with an existing deploy) drive the tool without
 * hand-editing JSON, and lets slice 2's Access values flow in before
 * slice 2 exists.
 */
export interface SetupEnv {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_PAGES_PROJECT_NAME?: string
  TERRAVIZ_HOSTNAME?: string
  TERRAVIZ_D1_NAME?: string
  TERRAVIZ_R2_BUCKET?: string
  TERRAVIZ_VECTORIZE_INDEX?: string
  TERRAVIZ_AE_DATASET?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  TRUSTED_PUBLISHER_DOMAINS?: string
  R2_PUBLIC_BASE?: string
  GITHUB_OWNER?: string
  GITHUB_REPO?: string
}

export function applyEnvOverrides(state: SetupState, env: SetupEnv): SetupState {
  const next: SetupState = {
    ...state,
    d1: { ...state.d1 },
    telemetryKv: { ...state.telemetryKv },
    catalogKv: { ...state.catalogKv },
    r2Bucket: { ...state.r2Bucket },
    vectorizeIndex: { ...state.vectorizeIndex },
    analyticsDataset: { ...state.analyticsDataset },
  }
  if (env.CLOUDFLARE_ACCOUNT_ID) next.accountId = env.CLOUDFLARE_ACCOUNT_ID
  if (env.CLOUDFLARE_PAGES_PROJECT_NAME) next.pagesProject = env.CLOUDFLARE_PAGES_PROJECT_NAME
  if (env.TERRAVIZ_HOSTNAME) next.hostname = env.TERRAVIZ_HOSTNAME
  // A renamed resource invalidates any ID we resolved for the old
  // name — drop it so the next run re-resolves against Cloudflare.
  if (env.TERRAVIZ_D1_NAME && env.TERRAVIZ_D1_NAME !== next.d1.name) {
    next.d1 = { name: env.TERRAVIZ_D1_NAME }
  }
  if (env.TERRAVIZ_R2_BUCKET) next.r2Bucket = { name: env.TERRAVIZ_R2_BUCKET }
  if (env.TERRAVIZ_VECTORIZE_INDEX && env.TERRAVIZ_VECTORIZE_INDEX !== next.vectorizeIndex.name) {
    next.vectorizeIndex = { name: env.TERRAVIZ_VECTORIZE_INDEX }
    next.vectorizeMetadata = []
  }
  if (env.TERRAVIZ_AE_DATASET) next.analyticsDataset = { name: env.TERRAVIZ_AE_DATASET }
  if (env.ACCESS_TEAM_DOMAIN) next.accessTeamDomain = env.ACCESS_TEAM_DOMAIN
  if (env.ACCESS_AUD) next.accessAud = env.ACCESS_AUD
  if (env.TRUSTED_PUBLISHER_DOMAINS) next.trustedPublisherDomains = env.TRUSTED_PUBLISHER_DOMAINS
  if (env.R2_PUBLIC_BASE) next.r2PublicBase = env.R2_PUBLIC_BASE
  if (env.GITHUB_OWNER) next.githubOwner = env.GITHUB_OWNER
  if (env.GITHUB_REPO) next.githubRepo = env.GITHUB_REPO
  return next
}

/** Stable, human-diffable serialisation for the on-disk state file. */
export function serialiseState(state: SetupState): string {
  return JSON.stringify(state, null, 2) + '\n'
}
