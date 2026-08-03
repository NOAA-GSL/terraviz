/**
 * The interactive interview — `npm run setup -- --interactive`.
 *
 * Two kinds of thing stand between a fresh clone and a running node,
 * and they need opposite treatment:
 *
 *   - **Values only the operator knows** (account id, hostname, staff
 *     email domain). Ask for these, explain exactly where each comes
 *     from, validate the answer against the shape the API expects,
 *     and re-prompt rather than failing three phases later.
 *   - **Actions only a human can take** (enable Workers Paid, move
 *     nameservers, complete a Zero Trust OAuth flow). These cannot be
 *     asked for at all — they can only be explained, then *detected*.
 *
 * Detection beats confirmation wherever it is available. "Have you
 * enabled Workers Paid? [y/N]" records an opinion; a failing API call
 * records a fact. So the manual steps below carry instructions for
 * the human and, where the tool can check, a note that it will find
 * out on its own rather than a prompt that invites a wrong answer.
 *
 * Everything here is data plus pure functions. The rendering is
 * testable, `--manual` prints the same instructions with no terminal
 * involved, and the flow control lives in the orchestrator.
 */

import { validators, wrap, type Question } from './prompt'
import { DEFAULT_NAMES, type SetupState } from './state'

/** Which `SetupState` field an answer lands in. */
export type AnswerKey =
  | 'accountId'
  | 'hostname'
  | 'pagesProject'
  | 'staffEmailDomain'
  | 'trustedPublisherDomains'
  | 'r2PublicBase'
  | 'githubRepo'

export interface InterviewQuestion extends Question {
  key: AnswerKey
  /** Env var that supplies this without a prompt. */
  envVar: string
  /** Skip unless the operator wants this optional feature. */
  featureGate?: 'r2' | 'transcode'
}

export const QUESTIONS: InterviewQuestion[] = [
  {
    key: 'accountId',
    envVar: 'CLOUDFLARE_ACCOUNT_ID',
    label: 'Cloudflare account ID',
    help: [
      'Cloudflare dashboard → any page → the sidebar shows "Account ID"',
      'with a copy button. It is also the 32-hex segment in every',
      'dashboard URL: dash.cloudflare.com/<account-id>/...',
    ],
    example: '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f',
    validate: validators.accountId,
  },
  {
    key: 'hostname',
    envVar: 'TERRAVIZ_HOSTNAME',
    label: 'Public hostname',
    help: [
      'The address people will visit. Its zone must already be on',
      'Cloudflare DNS — Cloudflare provisions the certificate and the',
      'CNAME for you, but only for a zone it controls.',
      'Hostname only: no https://, no trailing path.',
    ],
    example: 'terraviz.your-org.org',
    validate: validators.hostname,
  },
  {
    key: 'pagesProject',
    envVar: 'CLOUDFLARE_PAGES_PROJECT_NAME',
    label: 'Pages project name',
    help: [
      'Becomes <name>.pages.dev, which also serves your preview',
      'deployments. Lowercase letters, digits and dashes.',
    ],
    defaultValue: DEFAULT_NAMES.pagesProject,
    validate: validators.projectName,
  },
  {
    key: 'staffEmailDomain',
    envVar: 'TERRAVIZ_STAFF_EMAIL_DOMAIN',
    label: 'Staff email domain',
    help: [
      'The Access Allow policy matches "emails ending in" this domain.',
      'Everyone with an address here can reach the publisher portal.',
      'A domain, not an address — your-org.org, not you@your-org.org.',
      'Without it the application exists but no human can sign in.',
    ],
    example: 'your-org.org',
    validate: validators.emailDomain,
  },
  {
    key: 'trustedPublisherDomains',
    envVar: 'TRUSTED_PUBLISHER_DOMAINS',
    label: 'Auto-approve domains',
    help: [
      'Optional. Sign-ins from these domains skip the approval queue,',
      'but land READ-ONLY (role reviewer) — this does not make anyone',
      'an admin. You become admin by being the first to sign in.',
      'Comma-separated. Leave blank to approve everyone by hand.',
    ],
    example: 'your-org.org,partner.org',
    optional: true,
    validate: validators.emailDomainList,
  },
  {
    key: 'r2PublicBase',
    envVar: 'R2_PUBLIC_BASE',
    label: 'R2 public asset origin',
    help: [
      'Optional, needed before publisher asset uploads work. A hostname',
      'on one of your Cloudflare zones that will serve the bucket',
      'publicly — the tool attaches it to R2 for you.',
      'Give the full origin, including https://.',
    ],
    example: 'https://assets.your-org.org',
    optional: true,
    featureGate: 'r2',
    validate: validators.url,
  },
  {
    key: 'githubRepo',
    envVar: 'GITHUB_REPO',
    label: 'Fork repo (owner/repo)',
    help: [
      'Optional, needed only for publisher video uploads. The repo that',
      'hosts transcode-hls.yml — your fork. The publisher API fires a',
      'repository_dispatch at it when someone uploads a video.',
    ],
    example: 'your-org/terraviz',
    optional: true,
    featureGate: 'transcode',
    validate: validators.repoSlug,
  },
]

/** Apply an answer to state, splitting `owner/repo` where needed. */
export function applyAnswer(state: SetupState, key: AnswerKey, value: string): SetupState {
  const next = { ...state }
  switch (key) {
    case 'githubRepo': {
      const [owner, repo] = value.trim().split('/')
      next.githubOwner = owner
      next.githubRepo = repo
      return next
    }
    case 'r2PublicBase':
      next.r2PublicBase = value.trim().replace(/\/+$/, '')
      return next
    case 'trustedPublisherDomains':
      next.trustedPublisherDomains = value
        .split(',')
        .map(s => s.trim().replace(/^@/, ''))
        .filter(Boolean)
        .join(',')
      return next
    default:
      next[key] = value.trim()
      return next
  }
}

/** Is this question already answered, by state or by the environment? */
export function isAnswered(
  question: InterviewQuestion,
  state: SetupState,
  env: Record<string, string | undefined>,
): boolean {
  if (env[question.envVar]) return true
  switch (question.key) {
    case 'githubRepo':
      return Boolean(state.githubOwner && state.githubRepo)
    case 'pagesProject':
      // The default is always populated, so "answered" means the
      // operator (or a previous run) chose something other than it.
      return state.pagesProject !== DEFAULT_NAMES.pagesProject
    default:
      return Boolean(state[question.key])
  }
}

export interface PendingOptions {
  /** Include questions gated on optional features. */
  features?: Set<'r2' | 'transcode'>
}

export function pendingQuestions(
  state: SetupState,
  env: Record<string, string | undefined>,
  opts: PendingOptions = {},
): InterviewQuestion[] {
  return QUESTIONS.filter(q => {
    if (q.featureGate && !opts.features?.has(q.featureGate)) return false
    return !isAnswered(q, state, env)
  })
}

// ── Manual steps ──────────────────────────────────────────────────

export interface ManualStep {
  id: string
  title: string
  /** Why it matters — what breaks without it. */
  why: string
  /**
   * Deep link to where the work happens — the Cloudflare dashboard for
   * all but the fork step, which is on GitHub.
   */
  url?: string
  /**
   * The vendor's own documentation for this task, when there is a
   * canonical page for it — Cloudflare's, or GitHub's for the fork
   * step. The dashboard link says *where*; this says *what the thing
   * is*, which is what someone new to the platform actually needs.
   * Every URL here was checked to resolve.
   */
  docsUrl?: string
  steps: string[]
  /**
   * How completion is established. `detected` means a later step will
   * find out and say so, which is worth stating so the operator is
   * not asked to self-certify something checkable.
   */
  verification: 'detected' | 'self'
  /** Only relevant if the operator wants this optional feature. */
  featureGate?: 'r2' | 'transcode'
}

export const MANUAL_STEPS: ManualStep[] = [
  {
    id: 'fork',
    title: 'Fork the repository',
    why:
      'Everything here assumes your own copy. Phase 3 rewrites ' +
      'wrangler.toml with your resource IDs, Phase 5 points Pages at ' +
      'your remote, and the transcode workflow runs in your repo — none ' +
      'of which works against a repo you cannot push to. Cloning ' +
      'upstream directly fails late rather than early: it clones, it ' +
      'runs locally, and nothing complains until you have IDs to push ' +
      'and nowhere to push them.',
    url: 'https://github.com/zyra-project/terraviz/fork',
    docsUrl:
      'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo',
    steps: [
      'Fork zyra-project/terraviz, keeping the default settings.',
      'A fork lands with Actions DISABLED — enable them in the',
      '  Actions tab, or the transcode and deploy workflows never run.',
      'Record it as owner/repo; that is the W3 the interview asks for.',
    ],
    verification: 'self',
  },
  {
    id: 'workers-paid',
    title: 'Enable Workers Paid ($5/month)',
    why:
      'Optional — every product this node binds has a Workers Free ' +
      'allocation, so a free-plan account installs and runs. What you buy ' +
      'is headroom. Workers AI stops at 10,000 Neurons a day, roughly 200 ' +
      'Orbit turns, and that ceiling cannot be raised without upgrading. ' +
      'It fails soft, which is worse than failing loudly: Orbit quietly ' +
      'degrades to its keyword engine mid-demo.',
    url: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
    docsUrl: 'https://developers.cloudflare.com/workers/platform/pricing/',
    steps: [
      'Workers & Pages → Plans → Workers Paid → Subscribe.',
      'Billing is per account, not per project.',
    ],
    verification: 'self',
  },
  {
    id: 'dns',
    title: 'Put your domain on Cloudflare DNS',
    why:
      'Pages provisions the certificate and CNAME for your custom domain, ' +
      'and R2 can only serve a public bucket from a zone Cloudflare controls. ' +
      'Neither works on a domain hosted elsewhere.',
    url: 'https://dash.cloudflare.com/?to=/:account/add-site',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/manage-domains/add-site/',
    steps: [
      'Add the site in Cloudflare, then change the nameservers at your registrar.',
      'Propagation is usually minutes, occasionally hours.',
      'Transferring the registration is NOT required — only DNS.',
    ],
    verification: 'detected',
  },
  {
    id: 'api-token',
    title: 'Mint a Cloudflare API token',
    why: 'Everything this tool does runs through it.',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
    steps: [
      'My Profile → API Tokens → Create Token → Custom token.',
      'Permissions (grant only what you plan to run):',
      '  Account → Cloudflare Pages           → Edit   (Pages project + bindings)',
      '  Account → Access: Apps and Policies  → Edit   (the publisher application)',
      '  Account → Access: Service Tokens     → Edit   (the CLI credential)',
      '  Account → Access: Organizations      → Read   (discovers your team domain)',
      '  Account → Workers R2 Storage         → Edit   (only for --only=r2)',
      '  Zone    → Zone                       → Read   (resolves the zone)',
      '  Zone    → Zone WAF                   → Edit   (only for --only=waf)',
      '  Account → D1                         → Edit   (only for CI migrations)',
      'Then: export CLOUDFLARE_API_TOKEN=...',
    ],
    verification: 'detected',
  },
  {
    id: 'zero-trust',
    title: 'Complete Zero Trust onboarding',
    why:
      'The Access application that gates the publisher API cannot exist ' +
      'until the account has a Zero Trust organization and at least one ' +
      'identity provider. Without it every /api/v1/publish/** route 503s.',
    url: 'https://one.dash.cloudflare.com/',
    docsUrl: 'https://developers.cloudflare.com/cloudflare-one/setup/',
    steps: [
      'Pick a team name — it becomes <team>.cloudflareaccess.com.',
      'Settings → Authentication → add a login method.',
      'One-time PIN over email works and needs no IdP setup;',
      'Google / Okta / Entra are better for a real team.',
      'The free Zero Trust plan covers up to 50 users.',
    ],
    verification: 'detected',
  },
  {
    id: 'node-key',
    title: 'Generate the node keypair',
    why:
      'Signs your node federation responses and is advertised at ' +
      '/.well-known/terraviz.json. The generator also writes ' +
      'node-public-key.txt, which `terraviz init-node` reads in Phase 9.',
    steps: [
      'npm run gen:node-key',
      'Writes NODE_ID_PRIVATE_KEY_PEM into .dev.vars at mode 0600.',
      'Back that file up — regenerating means re-provisioning your identity.',
    ],
    verification: 'detected',
  },
  {
    id: 'git-connect',
    title: 'Connect the Pages project to your Git remote (or skip it)',
    why:
      'The Cloudflare↔GitHub handshake is an OAuth flow with no API, so ' +
      'this tool creates a Direct Upload project. Cloudflare will not run ' +
      'your build until you connect a remote, which means the VITE_* build ' +
      'variables have to be set wherever the build actually happens.',
    docsUrl: 'https://developers.cloudflare.com/pages/configuration/git-integration/',
    steps: [
      'Either: Workers & Pages → your project → Settings → Builds →',
      '  Connect to Git, then set the VITE_* variables in the dashboard.',
      'Or: keep Direct Upload and deploy from CI with',
      '  `wrangler pages deploy dist/ --project-name <your-project>`,',
      '  setting the VITE_* variables in the CI job instead.',
    ],
    verification: 'detected',
  },
  {
    id: 'r2-token',
    title: 'Mint the R2 S3 API token',
    why:
      'Server-side presigned uploads and digest verification need S3-API ' +
      'credentials. Automating this would require a token that can create ' +
      'tokens — a credential that could grant itself more authority — so it ' +
      'stays a deliberate manual step.',
    url: 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens',
    docsUrl: 'https://developers.cloudflare.com/r2/api/tokens/',
    steps: [
      'R2 → Manage R2 API Tokens → Create API token.',
      'Permission: Object Read & Write, scoped to your assets bucket.',
      'Copy all three values — the secret is shown once:',
      '  export R2_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com',
      '  export R2_ACCESS_KEY_ID=...',
      '  export R2_SECRET_ACCESS_KEY=...',
      'Then re-run setup; the bindings step picks them up from the shell.',
    ],
    verification: 'self',
    featureGate: 'r2',
  },
]

export function renderManualStep(step: ManualStep, index?: number): string {
  const heading = index === undefined ? step.title : `${index}. ${step.title}`
  const lines = [heading, '']
  const why = wrap(step.why, 66)
  lines.push(`   Why: ${why[0] ?? ''}`)
  for (const line of why.slice(1)) lines.push(`        ${line}`)
  lines.push('')
  // "Where" rather than "Dashboard": six of these land in Cloudflare's
  // dashboard, but forking happens on GitHub, and a label that names
  // the wrong product is a small lie in the one place someone new is
  // trusting the output.
  if (step.url) lines.push(`   Where: ${step.url}`)
  if (step.docsUrl) lines.push(`   Docs:  ${step.docsUrl}`)
  if (step.url || step.docsUrl) lines.push('')
  for (const s of step.steps) lines.push(`   ${s}`)
  lines.push('')
  lines.push(
    step.verification === 'detected'
      ? '   (setup detects whether this is done — no need to confirm)'
      : '   (setup cannot check this one; it is on you)',
  )
  return lines.join('\n')
}

export function renderManualSteps(features: Set<'r2' | 'transcode'> = new Set()): string {
  const steps = MANUAL_STEPS.filter(s => !s.featureGate || features.has(s.featureGate))
  const out = [
    'Manual prerequisites — the parts no API can do for you.',
    '',
  ]
  steps.forEach((step, i) => {
    out.push(renderManualStep(step, i + 1))
    out.push('')
  })
  return out.join('\n')
}
