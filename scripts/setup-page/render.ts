/**
 * Renders `public/setup.html` from the setup tool's own modules plus
 * the editorial content in `content.ts`.
 *
 * ## The invariant
 *
 * Everything factual on the page is derived from the same exports
 * `npm run setup` and `npm run check:pages-bindings` use. The page
 * cannot claim a binding the audit does not check, cannot omit one it
 * does, and cannot describe a prerequisite the tool has since learned
 * to detect. `crossCheck()` turns each of those into a build failure
 * rather than a documentation bug.
 *
 * Agreeing with `SELF_HOSTING.md` would be the weaker guarantee. The
 * failure operators actually hit is "the guide says one thing, the
 * tool does another", and only this direction rules it out.
 *
 * ## No stylesheet dependency
 *
 * Design tokens are inlined at build time from `src/styles/tokens.css`
 * rather than linked. A setup page is what someone reads *while the
 * deploy is broken* — it has to render when the SPA bundle does not.
 * Inlining tracks the palette and keeps the page self-contained; the
 * privacy page makes the same trade for the same reason.
 */

import { EXPECTED_BINDINGS, type ExpectedBinding } from '../lib/expected-bindings'
import { QUESTIONS, MANUAL_STEPS, type ManualStep } from '../lib/setup/interview'
import { DEFAULT_NAMES } from '../lib/setup/state'
import { PUBLISHER_PATHS, STAFF_POLICY_NAME, AUTOMATION_POLICY_NAME } from '../lib/setup/access'
import { UPSTREAM_PINNED_IDS } from '../lib/setup/wrangler-toml'
import {
  PHASES,
  WORKSHEET,
  ORIGIN_LABELS,
  ADDONS,
  TROUBLESHOOTING,
  WEEK_ONE,
  MAP_READINGS,
  TIERS,
  MARKDOWN_URL,
  type Phase,
  type Callout,
  type CodeBlock,
  type WorksheetField,
  type ValidatorName,
} from './content'

/**
 * The validators `runtime()` defines on its inline `V` object. Kept
 * beside the checks rather than derived from the generated string:
 * parsing our own output to find out what we emitted would be a
 * fragile way to learn something we already know.
 */
const INLINE_VALIDATORS: ReadonlySet<ValidatorName> = new Set([
  'accountId',
  'aud',
  'hostname',
  'emailDomain',
  'emailDomainList',
  'url',
  'repoSlug',
  'projectName',
])

// ── Cross-checks ──────────────────────────────────────────────────

export class ContentDriftError extends Error {
  constructor(problems: string[]) {
    super(
      'The /setup page content has drifted from the setup tool:\n\n' +
        problems.map(p => `  • ${p}`).join('\n') +
        '\n\nFix scripts/setup-page/content.ts, then re-run `npm run build:setup-page`.\n',
    )
    this.name = 'ContentDriftError'
  }
}

/**
 * Every check here encodes a way the page could quietly become wrong.
 * They run on every build, so a change to the tool that the page has
 * not caught up with fails CI instead of shipping.
 */
export function crossCheck(): void {
  const problems: string[] = []

  // 1. Every binding the audit checks must be presentable. The page
  //    renders EXPECTED_BINDINGS directly, so this only catches a
  //    binding whose name no worksheet field or phase explains.
  const explained = new Set<string>([
    ...WORKSHEET.map(w => w.label),
    ...WORKSHEET.map(w => w.id),
  ])
  const unexplained = EXPECTED_BINDINGS.filter(
    b => !explained.has(b.name) && !b.hint,
  ).map(b => b.name)
  if (unexplained.length) {
    problems.push(
      `bindings with neither a hint nor a worksheet entry: ${unexplained.join(', ')}`,
    )
  }

  // 2. Every value the interview asks for must appear on the
  //    worksheet, or the page understates what an operator supplies.
  const asked = new Set(QUESTIONS.map(q => q.key))
  const mapped = new Set(WORKSHEET.filter(w => w.fromTool).map(w => w.fromTool!))
  for (const key of asked) {
    if (!mapped.has(key)) {
      problems.push(`interview asks for "${key}" but no worksheet field claims it`)
    }
  }
  for (const key of mapped) {
    if (!asked.has(key)) {
      problems.push(
        `worksheet maps a field to "${key}", which the interview no longer asks for`,
      )
    }
  }

  // 3. Secret worksheet fields must never be persisted. This mirrors
  //    the rule SetupState enforces on the tool side.
  const persisted = WORKSHEET.filter(w => w.secret && w.origin === 'default')
  if (persisted.length) {
    problems.push(
      `secret fields cannot have origin "default": ${persisted.map(w => w.id).join(', ')}`,
    )
  }

  // 4. The dependency map's ordering invariant — the whole reason the
  //    phases are numbered as they are. A value may not be consumed
  //    before the phase that produces it.
  for (const w of WORKSHEET) {
    const early = w.consumedBy.filter(n => n < w.phase)
    if (early.length) {
      problems.push(
        `${w.id} is produced in phase ${w.phase} but consumed in ${early.join(', ')}`,
      )
    }
  }

  // 5. Phase numbering must be dense and ordered, or the nav and the
  //    map disagree about what "later" means.
  PHASES.forEach((p, i) => {
    if (p.n !== i) problems.push(`phase at index ${i} is numbered ${p.n}`)
  })

  // 6. Manual steps the tool can now detect should not be presented
  //    as operator self-certification.
  const selfCertified = MANUAL_STEPS.filter(s => s.verification === 'self')
  if (selfCertified.length > 3) {
    problems.push(
      `${selfCertified.length} manual steps are self-certified — the page's pre-flight ` +
        'sheet assumes most are detected; re-read the copy before shipping',
    )
  }

  // 7. Every validator a worksheet field names must exist in the
  //    page's inline script. Behaviour still cannot be compared across
  //    the module boundary, but a field pointing at a validator the
  //    browser does not have would silently accept anything — the one
  //    failure mode of this seam that costs nothing to close.
  const missing = [
    ...new Set(
      WORKSHEET.map(w => w.validator).filter(
        (v): v is NonNullable<typeof v> => Boolean(v),
      ),
    ),
  ].filter(v => !INLINE_VALIDATORS.has(v))
  if (missing.length) {
    problems.push(
      `worksheet fields name validators the inline script does not implement: ` +
        `${missing.join(', ')} (add them to V in runtime(), and to INLINE_VALIDATORS)`,
    )
  }

  if (problems.length) throw new ContentDriftError(problems)
}

// ── Escaping and small helpers ────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `**bold**`, `*italic*`, `` `code` `` → HTML. Inputs are ours. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code style="font-family:var(--tv-font-mono);font-size:.92em;background:var(--tv-surface-3);padding:1px 5px;border-radius:3px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b style="font-weight:600;color:var(--tv-text)">$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
}

/** Substitution tokens survive escaping and are replaced at runtime. */
function withSlots(s: string): string {
  return inline(s).replace(/\{\{(\w+)\}\}/g, (_, id) => slot(id))
}

function slot(id: string): string {
  return `<span data-slot="${esc(id)}" data-w="${esc(id)}" style="cursor:pointer;padding:1px 5px;border-radius:3px"></span>`
}

const CODE_WRAP =
  'position:relative;margin:0 0 14px'
const PRE =
  'margin:0;background:var(--tv-surface-code);border:1px solid var(--tv-border);color:var(--tv-text-muted);font:400 12.5px/1.8 var(--tv-font-mono);padding:36px 16px 15px;border-radius:6px;overflow-x:auto'
const COPY_BTN =
  "position:absolute;top:7px;right:8px;background:rgba(255,255,255,.07);color:var(--tv-text-dim);border:1px solid var(--tv-border-strong);border-radius:3px;font:500 10px/1 var(--tv-font-sans);letter-spacing:.08em;text-transform:uppercase;padding:5px 8px;cursor:pointer"

/** Renders a code block, dimming `#` comments and wiring slots. */
function code(block: CodeBlock): string {
  const lines = block.code.split('\n').map(line => {
    const m = /^(.*?)(\s*#.*)$/.exec(line)
    const body = m ? m[1] : line
    const comment = m ? m[2] : ''
    return (
      withSlots(body) +
      (comment ? `<span style="color:var(--tv-text-dim)">${esc(comment)}</span>` : '')
    )
  })
  return `<div style="${CODE_WRAP}">
  <pre style="${PRE}">${lines.join('\n')}</pre>
  <button data-copy="1" style="${COPY_BTN}">Copy</button>
</div>`
}

const CALLOUT_STYLE: Record<Callout['kind'], { bg: string; border: string; accent: string }> = {
  trap: { bg: 'var(--tv-error-bg)', border: 'var(--tv-error-border)', accent: 'var(--tv-error)' },
  note: { bg: 'var(--tv-warn-bg)', border: 'var(--tv-warn-border)', accent: 'var(--tv-warn)' },
  gate: { bg: 'var(--tv-accent-bg)', border: 'var(--tv-accent-border)', accent: 'var(--tv-accent)' },
}

const CALLOUT_LABEL: Record<Callout['kind'], string> = {
  trap: 'Trap',
  note: 'Worth knowing',
  gate: 'How it works',
}

function callout(c: Callout): string {
  const s = CALLOUT_STYLE[c.kind]
  return `<div style="background:${s.bg};border:1px solid ${s.border};border-left:3px solid ${s.accent};border-radius:6px;padding:15px 17px;margin:0 0 16px">
  <div style="font:600 10.5px/1 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:${s.accent};margin:0 0 8px">${esc(CALLOUT_LABEL[c.kind])} · ${esc(c.title)}</div>
  ${c.body.map(p => `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(p)}</p>`).join('\n  ')}
  ${c.code ? code(c.code) : ''}
</div>`
}

function isCallout(x: unknown): x is Callout {
  return typeof x === 'object' && x !== null && 'kind' in x
}
function isCode(x: unknown): x is CodeBlock {
  return typeof x === 'object' && x !== null && 'code' in x && !('kind' in x)
}

// ── Sections ──────────────────────────────────────────────────────

const CARD =
  'background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px'
const EYEBROW =
  'font:600 10.5px/1 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-text-dim)'

function tierPicker(): string {
  return `<section data-noprint="1" style="margin:0 0 44px">
  <div style="${EYEBROW};margin:0 0 12px">Step one · pick your node type</div>
  <p style="margin:0 0 16px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">This is the only decision that changes the shape of the install. Pick one and the rest of the page shows you only the phases, bindings and variables that node type needs.</p>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
    ${TIERS.map(
      t => `<button data-tier="${t.n}" style="text-align:left;cursor:pointer;border-radius:8px;padding:18px;font-family:var(--tv-font-sans)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 8px">
        <span style="font:600 13px/1 var(--tv-font-sans);letter-spacing:.04em">Tier ${t.n}</span>
        <span style="font:500 11px/1 var(--tv-font-mono);opacity:.7">${esc(t.duration)}</span>
      </div>
      <div style="font:600 16px/1.3 var(--tv-font-sans);margin:0 0 8px">${esc(t.name)}</div>
      <div style="font:400 12.5px/1.5;opacity:.78;text-wrap:pretty">${esc(t.body)}</div>
    </button>`,
    ).join('\n    ')}
  </div>
</section>`
}

/**
 * The pre-flight sheet, built from `MANUAL_STEPS`.
 *
 * The tool distinguishes prerequisites it will detect from ones only
 * the operator can confirm. That distinction is the most useful thing
 * on this sheet and it exists nowhere in the prose, so it is rendered
 * as a badge rather than flattened into a checkbox list.
 */
function preflight(): string {
  const step = (s: ManualStep, i: number): string => {
    const detected = s.verification === 'detected'
    const badge = detected
      ? `<span style="flex:none;background:var(--tv-accent-bg);color:var(--tv-accent);border:1px solid var(--tv-accent-border);border-radius:999px;padding:2px 8px;font:600 9px/1.5 var(--tv-font-sans);letter-spacing:.07em;text-transform:uppercase">setup checks this</span>`
      : `<span style="flex:none;background:var(--tv-warn-bg);color:var(--tv-warn);border:1px solid var(--tv-warn-border);border-radius:999px;padding:2px 8px;font:600 9px/1.5 var(--tv-font-sans);letter-spacing:.07em;text-transform:uppercase">on you</span>`
    return `<div style="display:flex;gap:10px;align-items:flex-start">
    <button data-toggle="pf-${esc(s.id)}" data-check="1" style="flex:none;margin-top:2px"></button>
    <div style="min-width:0">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 3px">
        <span style="font:600 13.5px/1.4 var(--tv-font-sans);color:var(--tv-text)">${i + 1}. ${esc(s.title)}</span>
        ${badge}
      </div>
      <div style="font-size:13px;line-height:1.5;color:var(--tv-text-muted);text-wrap:pretty">${inline(s.why)}</div>
    </div>
  </div>`
  }

  const gates = PHASES.map(
    p => `<div data-phase-row="${p.n}" style="display:flex;gap:10px;align-items:flex-start">
    <button data-toggle="p${p.n}" data-check="1" style="flex:none;margin-top:1px"></button>
    <div style="flex:none;width:22px;font:500 11.5px/1.5 var(--tv-font-mono);color:var(--tv-text-dim)">${String(p.n).padStart(2, '0')}</div>
    <div style="font-size:13.5px;line-height:1.5;color:var(--tv-text-muted);text-wrap:pretty">${inline(p.gateShort)}</div>
  </div>`,
  ).join('\n  ')

  return `<section id="preflight" data-sheet="1" style="${CARD};padding:28px 30px;margin:0 0 44px;scroll-margin-top:20px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin:0 0 6px">
    <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0">Pre-flight sheet</h2>
    <button data-act="print" data-noprint="1" style="flex:none;cursor:pointer;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:6px;padding:7px 12px;font:500 12px/1 var(--tv-font-sans);color:var(--tv-text-muted)">Print this page</button>
  </div>
  <p style="margin:0 0 24px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Print it, keep it next to the keyboard. Left side is what only a human can do; right side is the one thing that proves each phase worked.</p>
  <div data-sheetgrid="1" style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:34px">
    <div>
      <div style="${EYEBROW};margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--tv-border)">Before you start — no API can do these</div>
      <div style="display:flex;flex-direction:column;gap:13px">${MANUAL_STEPS.map(step).join('\n  ')}</div>
    </div>
    <div>
      <div style="${EYEBROW};margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--tv-border)">The gate for each phase</div>
      <div style="display:flex;flex-direction:column;gap:7px">${gates}</div>
    </div>
  </div>
</section>`
}

/** The dependency map — a span chart, one row per worksheet value. */
function dependencyMap(): string {
  const rows = WORKSHEET.map(w => {
    const cells = PHASES.map(
      p => `<div data-cell="${p.n}" style="height:27px;display:flex;align-items:center;justify-content:center"><span data-mark="1"></span></div>`,
    ).join('')
    return `<div data-map-row="${esc(w.id)}" data-w="${esc(w.id)}" data-produced="${w.phase}" data-consumed="${w.consumedBy.join(',')}" data-tier="${w.minTier}" style="display:grid;grid-template-columns:224px repeat(${PHASES.length},minmax(0,1fr));align-items:center;cursor:pointer;border-radius:4px">
    <div style="display:flex;align-items:baseline;gap:7px;padding:0 6px 0 4px;min-width:0">
      <span data-map-id="1" style="flex:none;font:500 10.5px/1 var(--tv-font-mono)">${esc(w.id)}</span>
      <span style="font-size:11.5px;color:var(--tv-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(w.label)}</span>
    </div>${cells}
  </div>`
  }).join('\n  ')

  const heads = PHASES.map(
    p => `<a href="#p${p.n}" data-col="${p.n}" style="justify-self:center;border:none;font:500 11px/1 var(--tv-font-mono);color:var(--tv-text-dim);padding:3px 2px">${String(p.n).padStart(2, '0')}</a>`,
  ).join('')

  return `<section id="map" data-sheet="1" data-map="1" style="background:var(--tv-surface-2);border:1px solid var(--tv-border);border-radius:8px;padding:28px 30px;margin:0 0 44px;scroll-margin-top:20px">
  <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 10px">Where every value comes from</h2>
  <p style="margin:0 0 6px;max-width:64ch;color:var(--tv-text-muted);text-wrap:pretty">A filled dot is where a value is <b style="font-weight:600;color:var(--tv-text)">born</b>; the rings are every later phase that <b style="font-weight:600;color:var(--tv-text)">needs</b> it. Read the shape, not the rows: nothing ever reaches backwards.</p>
  <p style="margin:0 0 22px;max-width:64ch;font-size:13.5px;color:var(--tv-text-dim);text-wrap:pretty">Dots turn blue as you fill each value in, so this doubles as a resume view. Click a row to edit it; click a phase number to jump there.</p>
  <div data-map-head="1" style="display:grid;grid-template-columns:224px repeat(${PHASES.length},minmax(0,1fr));align-items:center;margin:0 0 6px;padding-bottom:8px;border-bottom:1px solid var(--tv-border)">
    <div style="${EYEBROW}">Value</div>${heads}
  </div>
  ${rows}
  <div style="display:flex;flex-wrap:wrap;gap:22px;align-items:center;margin:18px 0 0;padding-top:14px;border-top:1px solid var(--tv-border)">
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:9px;height:9px;border-radius:50%;background:var(--tv-accent)"></span>produced here</span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:7px;height:7px;border-radius:50%;border:1.5px solid var(--tv-accent)"></span>needed here</span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--tv-text-dim)"><span style="width:9px;height:9px;border-radius:50%;background:var(--tv-warn)"></span>not filled in yet</span>
  </div>
  <div data-noprint="1" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 0">
    ${MAP_READINGS.map(
      r => `<div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:14px 16px">
      <div style="font:600 12.5px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 5px">${esc(r.title)}</div>
      <p style="margin:0;font-size:12.5px;line-height:1.5;color:var(--tv-text-dim);text-wrap:pretty">${esc(r.body)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
</section>`
}

/**
 * The bindings table — rendered straight from `EXPECTED_BINDINGS`.
 *
 * Nineteen rows, not the nine a hand-written table tends to carry.
 * Every hint is the operator-facing text the audit itself prints when
 * the binding is missing, so the page and the failure message agree
 * word for word.
 */
function bindingsTable(): string {
  const tierOf = (b: ExpectedBinding): number =>
    /^(CATALOG_(DB|KV|R2|VECTORIZE)|ACCESS_|NODE_ID|PREVIEW_SIGNING)/.test(b.name) ? 2 : 1
  const row = (b: ExpectedBinding): string =>
    `<div data-binding-row="1" data-tier="${tierOf(b)}" style="display:contents">
    <div style="background:var(--tv-surface-2);padding:10px 12px;font-family:var(--tv-font-mono);overflow-wrap:anywhere">${esc(b.name)}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-dim)">${esc(b.type)}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-dim)">${b.environments.length === 2 ? 'both' : esc(b.environments.join(', '))}</div>
    <div style="background:var(--tv-surface-2);padding:10px 12px;color:var(--tv-text-muted)">${b.hint ? inline(b.hint) : ''}</div>
  </div>`
  const head = ['Name', 'Type', 'Envs', 'What the audit says when it is missing']
    .map(
      h =>
        `<div style="background:var(--tv-surface-3);padding:9px 12px;${EYEBROW}">${esc(h)}</div>`,
    )
    .join('')
  return `<div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,.6fr) minmax(0,.45fr) minmax(0,2.4fr);gap:1px;background:var(--tv-border);border:1px solid var(--tv-border);border-radius:6px;overflow:hidden;font-size:12.5px;margin:0 0 18px">
  ${head}
  ${EXPECTED_BINDINGS.map(row).join('\n  ')}
</div>`
}

function phaseSection(p: Phase): string {
  const parts: string[] = []

  if (p.produces?.length) {
    parts.push(
      `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px;align-items:center">
      <span style="${EYEBROW};margin-right:3px">Produces</span>
      ${p.produces
        .map(id => {
          const w = WORKSHEET.find(x => x.id === id)
          return `<span data-w="${esc(id)}" style="cursor:pointer;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:3px;padding:4px 8px;font:500 11px/1.2 var(--tv-font-mono);color:var(--tv-text-muted)">${esc(id)} ${esc(w ? w.label.toLowerCase() : '')}</span>`
        })
        .join('\n      ')}
    </div>`,
    )
  }

  if (p.automated) {
    parts.push(code(p.automated))
  }
  for (const para of p.automatedNote ?? []) {
    parts.push(
      `<p style="margin:0 0 16px;max-width:64ch;font-size:13.5px;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(para)}</p>`,
    )
  }

  for (const item of p.body ?? []) {
    if (isCallout(item)) parts.push(callout(item))
    else if (isCode(item)) parts.push(code(item))
  }

  if (p.n === 8) parts.push(bindingsTable())
  if (p.n === 13) {
    parts.push(
      `<div style="display:flex;flex-direction:column;gap:10px;margin:0 0 16px">${ADDONS.map(
        a => `<div style="border:1px solid var(--tv-border);border-radius:6px;padding:15px 17px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 6px">
          <div style="font:500 15px/1.3 var(--tv-font-sans);color:var(--tv-text)">${esc(a.id)} · ${esc(a.title)}</div>
          <span style="flex:none;font:500 11px/1 var(--tv-font-mono);color:var(--tv-accent)">${esc(a.flag)}</span>
        </div>
        <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(a.body)}</p>
        ${a.extra ? `<p style="margin:8px 0 0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(a.extra)}</p>` : ''}
      </div>`,
      ).join('\n    ')}</div>`,
    )
  }

  if (p.manual) {
    const body = p.manual.body
      .map(item => {
        if (isCallout(item)) return callout(item)
        if (isCode(item)) return code(item)
        return `<p style="margin:0 0 10px;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);max-width:64ch;text-wrap:pretty">${(item as { html: string }).html}</p>`
      })
      .join('\n    ')
    parts.push(`<details style="border-top:1px solid var(--tv-border);padding-top:13px;margin:0 0 14px">
    <summary style="display:block;cursor:pointer;font:500 13px/1 var(--tv-font-sans);color:var(--tv-accent);list-style:none">+ ${esc(p.manual.summary)}</summary>
    <div style="padding-top:14px">${body}</div>
  </details>`)
  }

  parts.push(`<div style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-left:3px solid var(--tv-accent);border-radius:6px;padding:14px 16px;margin:0 0 14px">
    <div style="font:600 10.5px/1 var(--tv-font-sans);letter-spacing:.13em;text-transform:uppercase;color:var(--tv-accent);margin:0 0 7px">Gate</div>
    <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(p.gate)}</p>
  </div>`)

  return `<section id="p${p.n}" data-phase="${p.n}" data-min-tier="${p.minTier}"${p.tierExact ? ` data-exact-tier="${p.tierExact}"` : ''} style="${CARD};padding:26px 30px;margin:0 0 16px;scroll-margin-top:20px">
  <div style="display:flex;align-items:flex-start;gap:15px;margin:0 0 18px">
    <button data-toggle="p${p.n}" data-check="lg" style="flex:none;margin-top:5px"></button>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 4px">
        <span style="font:500 11.5px/1 var(--tv-font-mono);color:var(--tv-text-dim);letter-spacing:.06em">PHASE ${String(p.n).padStart(2, '0')}</span>
        <span style="font:400 11.5px/1 var(--tv-font-sans);color:var(--tv-text-dim)">${esc(p.duration)}${p.aside ? ' · ' + esc(p.aside) : ''}</span>
      </div>
      <h2 style="font:700 24px/1.25 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0">${esc(p.title)}</h2>
    </div>
  </div>
  ${p.intro.map(t => `<p style="margin:0 0 16px;max-width:64ch;color:var(--tv-text-muted);text-wrap:pretty">${withSlots(t)}</p>`).join('\n  ')}
  ${parts.join('\n  ')}
  <p style="margin:0;font-size:12.5px;color:var(--tv-text-dim)"><a href="${MARKDOWN_URL}#${esc(p.anchor)}">${esc(p.linkText ?? 'Full detail in SELF_HOSTING.md')} ↗</a></p>
</section>`
}

function worksheetDrawer(): string {
  const field = (w: WorksheetField): string => {
    const o = ORIGIN_LABELS[w.origin]
    return `<div data-field-row="${esc(w.id)}" data-tier="${w.minTier}" style="margin:0 0 14px">
    <div style="display:flex;align-items:center;gap:7px;margin:0 0 5px;flex-wrap:wrap">
      <label style="font:500 11.5px/1.3 var(--tv-font-mono);color:var(--tv-text-muted)">${esc(w.id)}</label>
      <span style="font:400 12.5px/1.3 var(--tv-font-sans);color:var(--tv-text)">${esc(w.label)}</span>
      <span title="${esc(o.hint)}" style="background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:999px;padding:1px 7px;font:600 9px/1.6 var(--tv-font-sans);letter-spacing:.06em;text-transform:uppercase;color:var(--tv-text-dim)">${esc(o.label)}</span>
      ${w.secret ? '<span style="background:var(--tv-error-bg);color:var(--tv-error);border:1px solid var(--tv-error-border);border-radius:999px;padding:1px 7px;font:600 9px/1.6 var(--tv-font-sans);letter-spacing:.06em;text-transform:uppercase">secret</span>' : ''}
    </div>
    <input data-field="${esc(w.id)}"${w.validator ? ` data-validate="${esc(w.validator)}"` : ''} placeholder="${esc(w.placeholder)}" spellcheck="false" autocomplete="off" style="width:100%;background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:6px;padding:8px 10px;font:400 13px/1.4 var(--tv-font-mono);color:var(--tv-text)"/>
    <div data-error="${esc(w.id)}" style="display:none;font:400 11.5px/1.5 var(--tv-font-sans);color:var(--tv-error);margin-top:4px"></div>
    ${w.note ? `<div style="font:400 11.5px/1.5 var(--tv-font-sans);color:var(--tv-text-dim);margin-top:4px">${esc(w.note)}</div>` : ''}
  </div>`
  }

  const askedCount = QUESTIONS.length
  return `<div data-drawer="1" data-noprint="1" style="display:none;position:fixed;inset:0;z-index:50;justify-content:flex-end">
  <div data-act="close" style="position:absolute;inset:0;background:rgba(0,0,0,.62)"></div>
  <div style="position:relative;width:460px;max-width:92vw;height:100%;background:var(--tv-surface);border-left:1px solid var(--tv-border);overflow-y:auto;box-shadow:-14px 0 40px rgba(0,0,0,.5)">
    <div style="position:sticky;top:0;background:var(--tv-surface);border-bottom:1px solid var(--tv-border);padding:22px 24px 16px;z-index:2">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin:0 0 10px">
        <div>
          <div style="font:700 19px/1.25 var(--tv-font-sans);color:var(--tv-text)">Your values</div>
          <div style="font:400 12.5px/1.5;color:var(--tv-text-dim);margin-top:3px">Fill these in once. Every command on the page updates.</div>
        </div>
        <button data-act="close" style="flex:none;cursor:pointer;background:none;border:1px solid var(--tv-border-strong);border-radius:6px;width:28px;height:28px;font:400 15px/1 var(--tv-font-sans);color:var(--tv-text-muted)">×</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;height:4px;background:var(--tv-surface-3);border-radius:3px;overflow:hidden"><div data-fill-bar="1" style="height:100%;background:var(--tv-accent);width:0%"></div></div>
        <span data-fill-count="1" style="font:500 11.5px/1 var(--tv-font-mono);color:var(--tv-accent)"></span>
      </div>
    </div>
    <div style="padding:18px 24px 40px">
      <div style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:6px;padding:11px 13px;margin:0 0 16px;font-size:12.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">Of these, <b style="font-weight:600;color:var(--tv-text)">${askedCount}</b> are things the setup interview actually asks you for. The rest Cloudflare assigns, a local command generates, or a dialog shows once — you are recording them here, not inventing them.</div>
      <div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:11px 13px;margin:0 0 20px;font-size:12.5px;line-height:1.55;color:var(--tv-text-dim);text-wrap:pretty">Plain values are kept in this browser only. Anything marked <span style="color:var(--tv-error)">SECRET</span> is held for this session only and never written to storage. Nothing leaves your machine either way.</div>
      ${WORKSHEET.map(field).join('\n      ')}
      <button data-act="clear" style="margin-top:8px;cursor:pointer;background:none;border:1px solid var(--tv-border-strong);border-radius:6px;padding:8px 12px;font:500 12px/1 var(--tv-font-sans);color:var(--tv-error)">Clear everything on this page</button>
    </div>
  </div>
</div>`
}

function troubleshooting(): string {
  return `<section id="stuck" data-noprint="1" style="margin:44px 0 0;scroll-margin-top:20px">
  <div style="${EYEBROW};margin:0 0 12px">If you are stuck right now</div>
  <h2 style="font:700 28px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 14px">The ten symptoms people actually hit</h2>
  <p style="margin:0 0 22px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Find your symptom, not your phase. Most of these exist because someone hit the snag and it was worth writing down — if yours is not here, that is worth an issue.</p>
  <div style="display:flex;flex-direction:column;gap:2px">
    ${TROUBLESHOOTING.map(
      t => `<div style="${CARD};padding:16px 18px">
      <div style="font:500 14px/1.4 var(--tv-font-mono);color:var(--tv-error);margin:0 0 6px">${esc(t.symptom)}</div>
      <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${inline(t.fix)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
  <p style="margin:16px 0 0;font-size:12.5px;color:var(--tv-text-dim)"><a href="${MARKDOWN_URL}#reference-e--troubleshooting">All sixteen symptoms in SELF_HOSTING.md ↗</a></p>
</section>`
}

function weekOne(): string {
  return `<section data-noprint="1" style="margin:44px 0 0">
  <div style="${EYEBROW};margin:0 0 12px">After a successful launch</div>
  <h2 style="font:700 28px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 20px">Five things worth doing in week one</h2>
  <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px">
    ${WEEK_ONE.map(
      w => `<div style="${CARD};padding:16px 18px${w.wide ? ';grid-column:1 / -1' : ''}">
      <div style="font:500 14px/1.3 var(--tv-font-sans);color:var(--tv-text);margin:0 0 6px">${esc(w.title)}</div>
      <p style="margin:0;font-size:13.5px;line-height:1.55;color:var(--tv-text-muted);text-wrap:pretty">${esc(w.body)}</p>
    </div>`,
    ).join('\n    ')}
  </div>
</section>`
}

function sidebar(): string {
  const links = PHASES.map(
    p => `<a href="#p${p.n}" data-nav="${p.n}" style="display:flex;align-items:center;gap:9px;padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)">
    <span data-nav-dot="1" style="flex:0 0 15px;height:15px;border-radius:50%;border:1.5px solid var(--tv-border-strong);display:flex;align-items:center;justify-content:center;font:600 9px/1 var(--tv-font-sans);color:transparent"></span>
    <span style="flex:0 0 17px;font:500 11px/1 var(--tv-font-mono);color:var(--tv-text-dim)">${String(p.n).padStart(2, '0')}</span>
    <span>${esc(p.label)}</span>
  </a>`,
  ).join('\n  ')

  return `<aside data-noprint="1" style="position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;border-right:1px solid var(--tv-border);background:var(--tv-surface);padding:26px 20px 40px">
  <div style="display:flex;align-items:center;gap:9px;margin:0 0 18px">
    ${GLOBE_MARK}
    <div>
      <div style="font:600 9.5px/1.3 var(--tv-font-sans);letter-spacing:.16em;text-transform:uppercase;color:var(--tv-text-dim)">Terraviz</div>
      <div style="font:700 15px/1.25 var(--tv-font-sans);color:var(--tv-text)">Install console</div>
    </div>
  </div>
  <div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:11px 12px;margin:0 0 18px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 7px">
      <span style="${EYEBROW}">Progress</span>
      <span data-progress="1" style="font:500 12px/1 var(--tv-font-mono);color:var(--tv-accent)"></span>
    </div>
    <div style="height:5px;background:var(--tv-surface-3);border-radius:3px;overflow:hidden">
      <div data-progress-bar="1" style="height:100%;background:var(--tv-accent);border-radius:3px;transition:width .3s ease;width:0%"></div>
    </div>
  </div>
  <nav style="display:flex;flex-direction:column;gap:1px;margin:0 0 20px">${links}</nav>
  <div style="display:flex;flex-direction:column;gap:1px;border-top:1px solid var(--tv-border);padding-top:12px">
    <a href="#preflight" style="padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)">Pre-flight sheet</a>
    <a href="#map" style="padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)">Dependency map</a>
    <a href="#stuck" style="padding:5px 7px;border-radius:4px;border:none;font:400 13px/1.3 var(--tv-font-sans);color:var(--tv-text-muted)">When it goes wrong</a>
  </div>
</aside>`
}

/**
 * The sidebar mark, inlined rather than linked.
 *
 * This page's whole premise is that it still works when the deploy
 * does not — read off a laptop, off a checkout, off a broken
 * preview. An `<img src="/...">` breaks under `file://` and under any
 * host that does not serve the SPA root, which is precisely the
 * situation someone is in when they open it.
 *
 * Gradient and clip-path ids are prefixed `tvg-` because SVG ids
 * share the document namespace once inlined.
 */
const GLOBE_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true" focusable="false" style="display:block;flex:none"><defs><radialGradient id="tvg-sphere" cx="40%" cy="35%" r="50%"><stop offset="0%" stop-color="#4FC3F7"></stop><stop offset="60%" stop-color="#1565C0"></stop><stop offset="100%" stop-color="#0D2137"></stop></radialGradient><radialGradient id="tvg-shine" cx="35%" cy="30%" r="45%"><stop offset="0%" stop-color="white" stop-opacity="0.3"></stop><stop offset="100%" stop-color="white" stop-opacity="0"></stop></radialGradient><clipPath id="tvg-clip"><circle cx="16" cy="16" r="14.08"></circle></clipPath></defs><circle cx="16" cy="16" r="14.72" fill="#0a1628"></circle><circle cx="16" cy="16" r="14.08" fill="url(#tvg-sphere)"></circle><g clip-path="url(#tvg-clip)" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"><ellipse cx="16" cy="16" rx="14.08" ry="1.92"></ellipse><ellipse cx="16" cy="10.56" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="21.44" rx="11.2" ry="1.6"></ellipse><ellipse cx="16" cy="16" rx="1.92" ry="14.08"></ellipse><ellipse cx="11.84" cy="16" rx="1.28" ry="13.44"></ellipse><ellipse cx="20.16" cy="16" rx="1.28" ry="13.44"></ellipse></g><g clip-path="url(#tvg-clip)" fill="rgba(76,175,80,0.5)" stroke="none"><path d="M12.16 7.04 Q13.44 8 12.8 10.24 Q11.52 11.52 12.16 12.8 Q13.44 15.36 12.16 17.6 Q11.2 19.84 11.84 22.4 Q11.2 20.8 10.56 18.56 Q10.24 16 10.88 13.44 Q10.56 11.2 11.2 8.96 Z"></path><path d="M16.64 8 Q17.92 8.96 18.56 10.88 Q19.2 12.8 18.24 15.36 Q17.6 17.6 17.92 19.84 Q17.28 18.56 16.96 16 Q16.64 13.44 17.28 10.88 Q16.64 9.6 16 8.64 Z"></path></g><circle cx="16" cy="16" r="14.08" fill="url(#tvg-shine)"></circle><circle cx="16" cy="16" r="14.08" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"></circle></svg>`

// ── Runtime ───────────────────────────────────────────────────────

/**
 * Client script. Vanilla and inline — the page must work with the SPA
 * bundle broken, which is exactly when someone reads it.
 *
 * Validators are re-declared here rather than imported: this string
 * runs in the browser with no module loader. Their *behaviour* cannot
 * be cross-checked against `prompt.ts`, so the shapes are kept trivial
 * and the authoritative copies stay in the tool. Their *existence*
 * can be, and is — see `INLINE_VALIDATORS` and check 7.
 */
function runtime(fields: WorksheetField[]): string {
  const meta = fields.map(f => ({
    id: f.id,
    token: f.token,
    secret: Boolean(f.secret),
    tier: f.minTier,
    validator: f.validator ?? null,
  }))
  return `
const KEY = 'terraviz-setup-console-v1';
const FIELDS = ${JSON.stringify(meta)};
const PHASE_COUNT = ${PHASES.length};
const V = {
  accountId: v => /^[0-9a-f]{32}$/i.test(v) ? null : 'expected 32 hex characters',
  aud: v => /^[0-9a-f]{64}$/i.test(v) ? null : 'expected 64 hex characters',
  hostname: v => /^https?:\\/\\//i.test(v) ? 'drop the https:// — just the hostname'
    : v.includes('/') ? 'drop the path — just the hostname'
    : /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(v) ? null : 'expected something like terraviz.your-org.org',
  emailDomain: v => v.replace(/^@/, '').includes('@') ? 'a domain, not an address'
    : /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/i.test(v.replace(/^@/, '')) ? null : 'expected something like your-org.org',
  emailDomainList: v => { for (const part of v.split(',')) { const e = V.emailDomain(part); if (e) return '"' + part.trim() + '": ' + e; } return null; },
  url: v => { try { const u = new URL(v); return (u.protocol === 'https:' || u.protocol === 'http:') ? null : 'expected an http(s) URL'; } catch { return 'expected a full URL'; } },
  repoSlug: v => /^[\\w.-]+\\/[\\w.-]+$/.test(v) ? null : 'expected owner/repo',
  projectName: v => /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/.test(v) ? null : 'lowercase letters, digits and dashes only'
};

let state = { tier: 2, vals: {}, done: {} };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) { const s = JSON.parse(raw); state.tier = s.tier || 2; state.vals = s.vals || {}; state.done = s.done || {}; }
} catch (e) {}

const SECRET = new Set(FIELDS.filter(f => f.secret).map(f => f.id));
function persist() {
  try {
    const vals = {};
    for (const k in state.vals) if (!SECRET.has(k)) vals[k] = state.vals[k];
    localStorage.setItem(KEY, JSON.stringify({ tier: state.tier, vals: vals, done: state.done }));
  } catch (e) {}
}

const q = (s, r) => Array.from((r || document).querySelectorAll(s));
const visiblePhase = n => {
  const el = document.querySelector('[data-phase="' + n + '"]');
  if (!el) return false;
  const exact = el.getAttribute('data-exact-tier');
  if (exact) return state.tier === Number(exact);
  if (state.tier === 1) return [0,1,2,3,4,5,8,10].indexOf(n) !== -1;
  return true;
};

function paintChecks() {
  q('[data-check]').forEach(b => {
    const id = b.getAttribute('data-toggle');
    const on = !!state.done[id];
    const lg = b.getAttribute('data-check') === 'lg';
    const sz = lg ? 22 : 17;
    b.style.cssText = 'flex:none;width:' + sz + 'px;height:' + sz + 'px;border-radius:' + (lg ? 4 : 3) + 'px;border:1.5px solid;cursor:pointer;display:flex;align-items:center;justify-content:center;font:600 ' + (lg ? 13 : 11) + 'px/1 var(--tv-font-sans);' + b.style.cssText.replace(/(flex|width|height|border[^;]*|cursor|display|align-items|justify-content|font):[^;]*;?/g, '') +
      (on ? 'background:var(--tv-accent);border-color:var(--tv-accent);color:var(--tv-bg)' : 'background:var(--tv-surface-3);border-color:var(--tv-border-strong);color:transparent');
    b.textContent = on ? '✓' : '';
  });
}

function paintSlots() {
  q('[data-slot]').forEach(s => {
    const id = s.getAttribute('data-slot');
    const f = FIELDS.find(x => x.id === id);
    const val = (state.vals[id] || '').trim();
    s.textContent = val || (f ? f.token : id);
    s.style.cssText = 'cursor:pointer;padding:1px 5px;border-radius:3px;' + (val
      ? 'background:rgba(77,166,255,.14);color:var(--tv-accent);border-bottom:1px solid rgba(77,166,255,.45)'
      : 'background:rgba(255,204,102,.10);color:var(--tv-warn);border-bottom:1px dotted rgba(255,204,102,.55)');
  });
}

function paintTier() {
  q('[data-phase]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-phase'))) ? '' : 'none';
  });
  q('[data-nav]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-nav'))) ? 'flex' : 'none';
  });
  q('[data-phase-row]').forEach(el => {
    el.style.display = visiblePhase(Number(el.getAttribute('data-phase-row'))) ? 'flex' : 'none';
  });
  q('[data-field-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? '' : 'none';
  });
  q('[data-binding-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? 'contents' : 'none';
  });
  q('[data-map-row]').forEach(el => {
    el.style.display = Number(el.getAttribute('data-tier')) <= state.tier ? 'grid' : 'none';
  });
  q('[data-tier]').forEach(b => {
    if (b.tagName !== 'BUTTON') return;
    const on = Number(b.getAttribute('data-tier')) === state.tier;
    b.style.cssText = b.style.cssText.replace(/(background|border|color|box-shadow):[^;]*;?/g, '') +
      (on ? ';background:var(--tv-accent-bg);border:1px solid var(--tv-accent);color:var(--tv-text);box-shadow:0 0 0 1px rgba(77,166,255,.2)'
          : ';background:var(--tv-surface-3);border:1px solid var(--tv-border);color:var(--tv-text-muted)');
  });
  paintMap();
  paintProgress();
}

function paintProgress() {
  let shown = 0, done = 0;
  for (let n = 0; n < PHASE_COUNT; n++) { if (visiblePhase(n)) { shown++; if (state.done['p' + n]) done++; } }
  const pct = shown ? Math.round(done / shown * 100) : 0;
  const p = document.querySelector('[data-progress]');
  if (p) p.textContent = done + ' / ' + shown;
  const bar = document.querySelector('[data-progress-bar]');
  if (bar) bar.style.width = pct + '%';
  q('[data-nav-dot]').forEach(d => {
    const n = d.parentElement.getAttribute('data-nav');
    const on = !!state.done['p' + n];
    d.style.background = on ? 'var(--tv-accent)' : 'transparent';
    d.style.borderColor = on ? 'var(--tv-accent)' : 'var(--tv-border-strong)';
    d.style.color = on ? 'var(--tv-bg)' : 'transparent';
    d.textContent = on ? '✓' : '';
  });
  const relevant = FIELDS.filter(f => f.tier <= state.tier);
  const filled = relevant.filter(f => (state.vals[f.id] || '').trim()).length;
  const fc = document.querySelector('[data-fill-count]');
  if (fc) fc.textContent = filled + ' / ' + relevant.length;
  const fb = document.querySelector('[data-fill-bar]');
  if (fb) fb.style.width = relevant.length ? Math.round(filled / relevant.length * 100) + '%' : '0%';
  const badge = document.querySelector('[data-drawer-count]');
  if (badge) badge.textContent = filled + ' / ' + relevant.length;
}

function paintMap() {
  const cols = [];
  for (let n = 0; n < PHASE_COUNT; n++) if (visiblePhase(n)) cols.push(n);
  const tpl = '224px repeat(' + cols.length + ',minmax(0,1fr))';
  const head = document.querySelector('[data-map-head]');
  if (head) {
    head.style.gridTemplateColumns = tpl;
    q('[data-col]', head).forEach(a => {
      a.style.display = cols.indexOf(Number(a.getAttribute('data-col'))) === -1 ? 'none' : '';
    });
  }
  q('[data-map-row]').forEach(row => {
    row.style.gridTemplateColumns = tpl;
    const id = row.getAttribute('data-w');
    const produced = Number(row.getAttribute('data-produced'));
    const consumed = (row.getAttribute('data-consumed') || '').split(',').filter(Boolean).map(Number);
    const filled = !!(state.vals[id] || '').trim();
    const hue = filled ? 'var(--tv-accent)' : 'var(--tv-warn)';
    const idEl = row.querySelector('[data-map-id]');
    if (idEl) idEl.style.color = hue;
    const live = consumed.filter(n => cols.indexOf(n) !== -1 && n !== produced);
    const start = cols.indexOf(produced);
    const last = live.length ? Math.max.apply(null, live.map(n => cols.indexOf(n))) : start;
    q('[data-cell]', row).forEach(cell => {
      const n = Number(cell.getAttribute('data-cell'));
      const i = cols.indexOf(n);
      cell.style.display = i === -1 ? 'none' : 'flex';
      cell.style.backgroundImage = '';
      if (i !== -1 && last > start && i >= start && i <= last) {
        const size = (i === start || i === last) ? '50% 1px' : '100% 1px';
        const pos = i === start ? 'right center' : (i === last ? 'left center' : 'center');
        cell.style.backgroundImage = 'linear-gradient(var(--tv-border-strong),var(--tv-border-strong))';
        cell.style.backgroundSize = size;
        cell.style.backgroundPosition = pos;
        cell.style.backgroundRepeat = 'no-repeat';
      }
      const mark = cell.querySelector('[data-mark]');
      if (!mark) return;
      if (n === produced) mark.style.cssText = 'display:block;width:9px;height:9px;border-radius:50%;background:' + hue + ';box-shadow:0 0 0 3px var(--tv-surface-2)';
      else if (consumed.indexOf(n) !== -1) mark.style.cssText = 'display:block;width:7px;height:7px;border-radius:50%;border:1.5px solid ' + hue + ';background:var(--tv-surface-2);box-shadow:0 0 0 3px var(--tv-surface-2)';
      else mark.style.cssText = 'display:none';
    });
  });
}

function paintInputs() {
  FIELDS.forEach(f => {
    const el = document.querySelector('[data-field="' + f.id + '"]');
    if (el && el !== document.activeElement) el.value = state.vals[f.id] || '';
  });
}

function validate(id, value) {
  const f = FIELDS.find(x => x.id === id);
  const err = document.querySelector('[data-error="' + id + '"]');
  if (!err) return;
  const fn = f && f.validator ? V[f.validator] : null;
  const msg = (value.trim() && fn) ? fn(value.trim()) : null;
  err.textContent = msg || '';
  err.style.display = msg ? 'block' : 'none';
}

function repaint() { paintChecks(); paintSlots(); paintTier(); paintInputs(); }

document.addEventListener('input', e => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const id = el.getAttribute('data-field');
  state.vals[id] = el.value;
  validate(id, el.value);
  persist(); paintSlots(); paintMap(); paintProgress();
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-toggle],[data-w],[data-copy],[data-tier],[data-act]');
  if (!el) return;
  if (el.hasAttribute('data-copy')) {
    const pre = el.parentElement.querySelector('pre');
    if (!pre) return;
    const done = () => { el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy'; }, 1300); };
    if (navigator.clipboard) navigator.clipboard.writeText(pre.innerText).then(done, done); else done();
    return;
  }
  if (el.tagName === 'BUTTON' && el.hasAttribute('data-tier')) {
    state.tier = Number(el.getAttribute('data-tier')); persist(); repaint(); return;
  }
  const tog = el.getAttribute('data-toggle');
  if (tog) { state.done[tog] = !state.done[tog]; persist(); paintChecks(); paintProgress(); return; }
  const act = el.getAttribute('data-act');
  if (act === 'drawer') { document.querySelector('[data-drawer]').style.display = 'flex'; return; }
  if (act === 'close') { document.querySelector('[data-drawer]').style.display = 'none'; return; }
  if (act === 'print') { window.print(); return; }
  if (act === 'clear') { state.vals = {}; state.done = {}; persist(); repaint(); return; }
  const w = el.getAttribute('data-w');
  if (w) {
    document.querySelector('[data-drawer]').style.display = 'flex';
    const input = document.querySelector('[data-field="' + w + '"]');
    if (input) { input.focus(); input.select(); }
  }
});

repaint();
`
}

// ── Document ──────────────────────────────────────────────────────

export interface RenderOptions {
  /** Contents of `src/styles/tokens.css`, inlined verbatim. */
  tokensCss: string
  /** ISO date stamped into the header comment. */
  generatedAt: string
}

export function renderSetupPage(opts: RenderOptions): string {
  crossCheck()

  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Terraviz — install console</title>
<meta name="description" content="Guided, resumable checklist for standing up a self-hosted Terraviz node."/>
<meta name="robots" content="noindex"/>
<!--
  Same posture as public/privacy.html, relaxed by exactly one
  directive. That page can afford script-src 'none' because it has no
  script; this one carries its checklist logic inline, so it needs
  'unsafe-inline' there. Everything else stays shut: default-src
  'none' means the page cannot fetch, connect or embed anything, which
  is both a real restriction and a standing check on the claim that
  this page is self-contained. If a future change needs a network
  origin here, that is the signal to reconsider the change, not the
  policy.

  No frame-ancestors: browsers ignore it when it arrives in a
  <meta> element, and say so in the console. privacy.html carries it
  anyway and takes the console error for a directive that was never
  in force. Framing control belongs in public/_headers, which is
  where to add it if this page ever needs it.
-->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'"/>
<link rel="icon" href="/favicon.ico" sizes="48x48"/>
<style>
${opts.tokensCss}
html,body{margin:0;padding:0}
body{background:var(--tv-bg);color:var(--tv-text);font:400 15px/1.65 var(--tv-font-sans);-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
a{color:var(--tv-accent);text-decoration:none;border-bottom:1px solid rgba(77,166,255,.3)}
a:hover{color:var(--tv-accent-hover);border-bottom-color:var(--tv-accent-hover)}
nav a,aside a{border-bottom:none}
nav a:hover,aside a:hover{background:var(--tv-surface-3)}
summary::-webkit-details-marker{display:none}
input:focus{outline:none;border-color:rgba(77,166,255,.5)!important;background:rgba(255,255,255,.08)!important}
::selection{background:rgba(77,166,255,.3)}
code{overflow-wrap:anywhere}
@media print{
  body{background:#fff}
  [data-noprint]{display:none!important}
  [data-shell]{display:block!important}
  [data-main]{padding:0!important;max-width:none!important}
  [data-sheet]{border:none!important;box-shadow:none!important;padding:0!important;margin:0 0 24px!important;background:none!important}
  [data-sheet],[data-sheet] *{color:#111!important}
  [data-sheet] [data-check]{border-color:#666!important;background:#fff!important}
  [data-map]{break-before:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}
  [data-map] [data-cell]{background-image:linear-gradient(#bbb,#bbb)!important}
  [data-map] [data-mark]{box-shadow:0 0 0 3px #fff!important}
}
</style>
</head>
<body>
<!--
  GENERATED FILE — do not edit.

  Produced by scripts/build-setup-page.ts on ${opts.generatedAt}.
  Prose lives in scripts/setup-page/content.ts; every binding,
  prerequisite and validator is imported from the modules the setup
  tool itself uses, so this page cannot disagree with \`npm run setup\`.

  Regenerate:  npm run build:setup-page
  Verify:      npm run build:setup-page -- --check
-->`

  const hero = `<section data-noprint="1" style="margin:0 0 44px">
  <div style="${EYEBROW};margin:0 0 14px">Self-hosting a Terraviz node</div>
  <h1 style="font:300 46px/1.12 var(--tv-font-sans);letter-spacing:-.005em;color:var(--tv-text);margin:0 0 18px;max-width:17ch;text-wrap:pretty">You can have your own node running this afternoon.</h1>
  <p style="margin:0 0 22px;max-width:60ch;font-size:17px;color:var(--tv-text-muted);text-wrap:pretty">${PHASES.length} phases, ordered so no step ever asks for a value an earlier step has not already produced. Type your values in once and every command on this page fills itself in. Tick things off as you go — this page remembers where you stopped.</p>
  <div style="display:flex;flex-wrap:wrap;gap:9px;margin:0 0 24px">
    ${['≈2–3 h for a publisher node', '$5/mo Workers Paid', 'A domain already on Cloudflare DNS']
      .map(
        t =>
          `<span style="background:var(--tv-surface-3);border:1px solid var(--tv-border-strong);border-radius:3px;padding:5px 10px;font:500 12px/1.2 var(--tv-font-sans);color:var(--tv-text-muted)">${esc(t)}</span>`,
      )
      .join('\n    ')}
  </div>
  <p style="margin:0;font-size:13.5px;color:var(--tv-text-dim)">This page is a front door. The canonical text — every click path, every caveat — is <a href="${MARKDOWN_URL}">SELF_HOSTING.md</a>, and each phase links straight into it.</p>
</section>`

  const setupPanel = `<section data-noprint="1" style="background:var(--tv-accent-bg);border:1px solid var(--tv-accent-border);border-radius:8px;padding:28px 30px;margin:0 0 40px">
  <div style="${EYEBROW};color:var(--tv-accent);margin:0 0 12px">Start here</div>
  <h2 style="font:700 27px/1.2 var(--tv-font-sans);letter-spacing:-.01em;color:var(--tv-text);margin:0 0 14px">Let the tool do the mechanical parts</h2>
  <p style="margin:0 0 18px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Most of what follows is dashboard clicking that a script can do faster and without typos. <code style="font-family:var(--tv-font-mono);font-size:.92em">npm run setup</code> provisions the resources, rewrites the config, applies the migrations in the order that works, creates the Access application (<code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(DEFAULT_NAMES.accessApp)}</code>) with its <code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(STAFF_POLICY_NAME)}</code> and <code style="font-family:var(--tv-font-mono);font-size:.92em">${esc(AUTOMATION_POLICY_NAME)}</code> policies, and writes every binding to <i>both</i> environments.</p>
  ${code({
    code: `# what only a human can do, with click paths
npm run setup -- --manual

# answer ${QUESTIONS.length} questions, validated at the prompt
npm run setup -- --interactive

# plan only — writes nothing
npm run setup

# provision + wire
npm run setup -- --apply`,
  })}
  <p style="margin:0 0 18px;max-width:62ch;color:var(--tv-text-muted);text-wrap:pretty">Every phase below leads with the tool. Where a human is genuinely required — billing, an OAuth handshake, the first SSO sign-in — it says so and shows you the clicks. Where you would rather do it yourself anyway, open <b style="font-weight:600;color:var(--tv-text)">Do it by hand</b>.</p>
  <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
    ${[
      ['Plan by default', 'A bare run prints what it would do and exits. No network calls.'],
      ['Idempotent', 'Re-running adopts what exists rather than making a second one.'],
      ['Resumable', 'IDs land in .terraviz-setup.json as they are found. Never secrets.'],
    ]
      .map(
        ([t, b]) => `<div style="background:var(--tv-surface-3);border:1px solid var(--tv-border);border-radius:6px;padding:14px 16px">
      <div style="font:500 12px/1.3 var(--tv-font-sans);color:var(--tv-accent);margin:0 0 4px">${esc(t)}</div>
      <div style="font:400 12px/1.5;color:var(--tv-text-dim)">${esc(b)}</div>
    </div>`,
      )
      .join('\n    ')}
  </div>
</section>`

  const pinned = `<p style="margin:0 0 44px;font-size:12.5px;color:var(--tv-text-dim)">Shipped <code style="font-family:var(--tv-font-mono)">wrangler.toml</code> still pins upstream's D1 <code style="font-family:var(--tv-font-mono)">${esc(UPSTREAM_PINNED_IDS.d1.slice(0, 8))}…</code> until Phase 3 rewrites it. Access gates ${PUBLISHER_PATHS.length} paths per host.</p>`

  return `${head}
<div data-shell="1" style="display:grid;grid-template-columns:262px minmax(0,1fr)">
${sidebar()}
<main data-main="1" style="padding:54px 52px 140px;max-width:940px">
${hero}
${tierPicker()}
${preflight()}
${dependencyMap()}
${setupPanel}
${pinned}
${PHASES.map(phaseSection).join('\n')}
${troubleshooting()}
${weekOne()}
<footer data-noprint="1" style="margin:52px 0 0;padding-top:24px;border-top:1px solid var(--tv-border);display:flex;flex-wrap:wrap;gap:22px;align-items:baseline">
  <p style="margin:0;font-size:13.5px;color:var(--tv-text-dim);flex:1;min-width:280px;text-wrap:pretty">If something here is wrong or under-documented, open an issue. Most of this exists because someone hit a snag and it was worth writing down.</p>
  <a href="${MARKDOWN_URL}" style="font-size:13.5px">SELF_HOSTING.md ↗</a>
  <a href="${MARKDOWN_URL}#reference-a--complete-variable-inventory" style="font-size:13.5px">Variable inventory ↗</a>
</footer>
</main>
</div>
<button data-act="drawer" data-noprint="1" style="position:fixed;right:26px;bottom:26px;z-index:40;display:flex;align-items:center;gap:10px;background:var(--tv-accent-strong);color:#fff;border:none;border-radius:6px;padding:13px 18px;font:500 13.5px/1 var(--tv-font-sans);cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.45)">
  <span>Your values</span>
  <span data-drawer-count="1" style="font:500 12px/1 var(--tv-font-mono);background:rgba(255,255,255,.16);padding:4px 7px;border-radius:3px"></span>
</button>
${worksheetDrawer()}
<script>${runtime(WORKSHEET)}</script>
</body>
</html>
`
}
