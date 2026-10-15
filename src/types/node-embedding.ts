// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The node's embedding policy: which other sites may show the public
 * app in an iframe. Shared by the publisher API (`functions/`), the
 * root middleware that enforces it, and the portal's Embedding card
 * (`src/`), so all three agree on one definition. Mirrors
 * `node-features.ts`.
 *
 * The default is today's behaviour and the recommendation in
 * `docs/WORDPRESS_INTEGRATION_PLAN.md` §4: **any site may embed.** An
 * operator opts in to a restriction; nothing restricts by default.
 *
 * - `any`  — no framing header is sent. Any site may embed the app.
 * - `list` — `frame-ancestors 'self' <origins>`: this node and the
 *            listed sites.
 * - `self` — `frame-ancestors 'self'`: only this node.
 *
 * **The validator is a security boundary.** Every origin it accepts
 * is written into a response header on every page of the app. CSP
 * source lists are separated by spaces, directives by `;` and whole
 * policies by `,`, so an origin that smuggled any of those in could
 * widen the policy (`https://a.org *`), end the directive early, or
 * start a second one. The accepted grammar is therefore a closed
 * allowlist, `https://` plus a lowercase ASCII host and an optional
 * port, not a blocklist of dangerous characters, and a value outside
 * it is rejected with a field error rather than repaired. Lowercasing
 * is the one normalization: hosts are case-insensitive, so it changes
 * nothing a browser checks and lets duplicates be found.
 *
 * Deliberately refused:
 *
 * - `http:` origins, `http://localhost` included. A node that limits
 *   embedding is a production node, and a developer testing an embed
 *   locally can point it at a node left on `any` or at a dev server.
 *   Listing `http://localhost:<port>` on a public node would let any
 *   page served from that port on a visitor's machine frame it.
 * - A wildcard over a single label (`https://*.org`). That would admit
 *   every site under a top-level domain. Two labels after `*.` are
 *   required. This cannot catch a public suffix such as `*.co.uk`
 *   without a suffix list, which is too heavy to ship for this check.
 * - Non-ASCII hosts. CSP matches the ASCII (punycode) form, so the
 *   operator is asked for the `xn--` form rather than having it
 *   converted behind their back.
 */

/** The three postures, in the order the portal offers them. */
export const EMBED_MODES = ['any', 'list', 'self'] as const

export type EmbedMode = (typeof EMBED_MODES)[number]

/** The stored and wire shape. `origins` is meaningful only for
 *  `list`, and empty for the other two modes. */
export interface EmbedPolicy {
  mode: EmbedMode
  origins: string[]
}

/** The most origins one node may list. A real allow-list is a handful
 *  of sites; the cap bounds the header every page carries. */
export const MAX_EMBED_ORIGINS = 50

/** Longest accepted origin. A DNS name is at most 253 characters;
 *  this leaves room for `https://`, a port and a `*.` prefix. */
export const MAX_EMBED_ORIGIN_LENGTH = 280

/** Any site may embed — the state of a node that never saved one. */
export function defaultEmbedPolicy(): EmbedPolicy {
  return { mode: 'any', origins: [] }
}

/** Why an origin was refused. The portal words each one; the API
 *  sends the code in its field-error envelope. */
export type EmbedOriginErrorCode =
  | 'empty'
  | 'too_long'
  | 'whitespace'
  | 'forbidden_char'
  | 'keyword'
  | 'not_ascii'
  | 'not_https'
  | 'has_userinfo'
  | 'has_path'
  | 'bad_port'
  | 'bad_host'
  | 'wildcard_too_broad'

export type EmbedOriginResult =
  | { ok: true; value: string }
  | { ok: false; code: EmbedOriginErrorCode; message: string }

/** A CSP keyword or bare wildcard, quoted or not. None of them is a
 *  site, and `*` or `'unsafe-…'` would undo the policy outright. */
const CSP_KEYWORD =
  /^'?(?:\*|none|self|unsafe-[a-z-]*|strict-dynamic|report-sample|wasm-unsafe-eval|nonce-.*|sha(?:256|384|512)-.*)'?$/i

/** One DNS label: letters, digits and inner hyphens, 1-63 long. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function fail(code: EmbedOriginErrorCode, message: string): EmbedOriginResult {
  return { ok: false, code, message }
}

/**
 * Validate one origin and return it in canonical form (lowercased).
 * Never repairs: whitespace, a trailing slash or an `http:` scheme is
 * an error the operator sees, not something silently fixed.
 */
export function validateEmbedOrigin(raw: unknown): EmbedOriginResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fail('empty', 'Enter a site, such as https://www.example.org.')
  }
  if (raw.length > MAX_EMBED_ORIGIN_LENGTH) {
    return fail('too_long', `A site can be at most ${MAX_EMBED_ORIGIN_LENGTH} characters.`)
  }
  // Checked before anything else parses the value, and over the whole
  // string: these are what would split or end a CSP source list.
  if (/\s/.test(raw)) {
    return fail('whitespace', 'Remove the spaces or line breaks.')
  }
  // Ahead of the punctuation check so a quoted keyword gets the
  // message that says what it is.
  if (CSP_KEYWORD.test(raw)) {
    return fail('keyword', 'Enter a site address, not a policy keyword.')
  }
  if (/[;,'"`\\<>^{}|]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) {
    return fail('forbidden_char', 'A site cannot contain ; , quotes or other punctuation.')
  }
  if (/[^\x21-\x7e]/.test(raw)) {
    return fail('not_ascii', 'Enter the punycode (xn--) form of an international domain name.')
  }

  const value = raw.toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):(\/\/)?/.exec(value)
  if (!scheme || scheme[1] !== 'https' || !scheme[2]) {
    return fail('not_https', 'A site must start with https://.')
  }
  const rest = value.slice('https://'.length)
  if (rest.includes('@')) {
    return fail('has_userinfo', 'Remove the user name or password before the host.')
  }
  if (/[/?#]/.test(rest)) {
    return fail('has_path', 'Enter only the scheme and host, with no path or trailing slash.')
  }

  // An IPv6 literal would confuse the port split below; CSP rarely
  // needs one, so it is refused as a host rather than parsed.
  if (/[[\]]/.test(rest)) {
    return fail('bad_host', 'Enter a valid host name, such as www.example.org.')
  }
  const portMatch = /:([^:]*)$/.exec(rest)
  const hostPart = portMatch ? rest.slice(0, portMatch.index) : rest
  if (portMatch) {
    const port = portMatch[1]
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
      return fail('bad_port', 'A port must be a number from 1 to 65535.')
    }
  }

  const wildcard = hostPart.startsWith('*.')
  const host = wildcard ? hostPart.slice(2) : hostPart
  const labels = host.split('.')
  if (host.length === 0 || host.length > 253 || !labels.every(label => LABEL.test(label))) {
    return fail('bad_host', 'Enter a valid host name, such as www.example.org.')
  }
  if (wildcard && labels.length < 2) {
    return fail('wildcard_too_broad', 'A wildcard must name a domain, such as https://*.example.org.')
  }
  return { ok: true, value }
}

/** A field error in the publisher-API envelope shape
 *  (`functions/api/v1/_lib/node-profile-store.ts`' `FieldError`). */
export interface EmbedFieldError {
  field: string
  code: string
  message: string
}

/**
 * Validate a policy from a request body. Rejects rather than strips:
 * an unknown mode, a bad origin, a duplicate or too many origins is
 * a field error naming the entry, so the operator sees exactly what
 * the form refused. `list` needs at least one origin, since an empty
 * list would mean the same as `self` while reading as a mistake. The
 * other two modes must send none, so a stale list is never stored
 * under a mode that ignores it.
 */
export function validateEmbedPolicyInput(
  raw: unknown,
): { ok: true; value: EmbedPolicy } | { ok: false; errors: EmbedFieldError[] } {
  const errors: EmbedFieldError[] = []
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      field: 'embedding',
      code: 'invalid',
      message: '`embedding` must be an object of {mode, origins}.',
    })
    return { ok: false, errors }
  }
  const rec = raw as Record<string, unknown>

  for (const key of Object.keys(rec)) {
    if (key !== 'mode' && key !== 'origins') {
      errors.push({ field: `embedding.${key}`, code: 'unknown', message: `\`${key}\` is not a known field.` })
    }
  }

  const mode = rec.mode
  if (typeof mode !== 'string' || !(EMBED_MODES as readonly string[]).includes(mode)) {
    errors.push({
      field: 'embedding.mode',
      code: 'invalid',
      message: `\`embedding.mode\` must be one of ${EMBED_MODES.join(', ')}.`,
    })
  }

  const originsRaw = rec.origins ?? []
  if (!Array.isArray(originsRaw)) {
    errors.push({ field: 'embedding.origins', code: 'invalid', message: '`embedding.origins` must be a list.' })
    return { ok: false, errors }
  }
  if (originsRaw.length > MAX_EMBED_ORIGINS) {
    errors.push({
      field: 'embedding.origins',
      code: 'too_many',
      message: `List at most ${MAX_EMBED_ORIGINS} sites.`,
    })
  }

  const origins: string[] = []
  const seen = new Map<string, number>()
  originsRaw.slice(0, MAX_EMBED_ORIGINS).forEach((entry, index) => {
    const field = `embedding.origins.${index}`
    const result = validateEmbedOrigin(entry)
    if (!result.ok) {
      errors.push({ field, code: result.code, message: result.message })
      return
    }
    const first = seen.get(result.value)
    if (first !== undefined) {
      errors.push({ field, code: 'duplicate', message: `This repeats site ${first + 1}.` })
      return
    }
    seen.set(result.value, index)
    origins.push(result.value)
  })

  if (mode === 'list' && originsRaw.length === 0) {
    errors.push({
      field: 'embedding.origins',
      code: 'required',
      message: 'List at least one site, or choose "No other site".',
    })
  }
  if ((mode === 'any' || mode === 'self') && originsRaw.length > 0) {
    errors.push({
      field: 'embedding.origins',
      code: 'unexpected',
      message: `Sites are only listed when the mode is list.`,
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { mode: mode as EmbedMode, origins } }
}

/**
 * Read a stored policy back. Storage is trusted less than a request
 * is: a row written by a build with a looser validator, or edited by
 * hand, must still never put an unchecked value into a header. So
 * every origin is re-validated and the canonical form kept.
 *
 * Returns `null` when the value is unusable as a whole: corrupt JSON,
 * an unknown mode, or a `list` with no valid origin left. The caller
 * decides what that means, and the store treats it as a failed read,
 * which fails open to `any`. A single bad origin among good ones is
 * dropped and the rest kept, so one stale entry cannot lift a whole
 * restriction.
 */
export function parseStoredEmbedPolicy(raw: unknown): EmbedPolicy | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const mode = rec.mode
  if (mode === 'any') return defaultEmbedPolicy()
  if (mode === 'self') return { mode: 'self', origins: [] }
  if (mode !== 'list' || !Array.isArray(rec.origins)) return null
  const origins: string[] = []
  for (const entry of rec.origins.slice(0, MAX_EMBED_ORIGINS)) {
    const result = validateEmbedOrigin(entry)
    if (result.ok && !origins.includes(result.value)) origins.push(result.value)
  }
  return origins.length > 0 ? { mode: 'list', origins } : null
}

/**
 * The `Content-Security-Policy` value a policy enforces, or `null`
 * for `any` (send nothing). Built only from {@link parseStoredEmbedPolicy}
 * or {@link validateEmbedPolicyInput} output, so every origin in it
 * has passed the validator. `'self'` is always first: a node that
 * restricts embedding still frames itself (the app embeds Orbit's
 * page, `/orbit`, in an iframe).
 */
export function frameAncestorsHeader(policy: EmbedPolicy): string | null {
  if (policy.mode === 'any') return null
  if (policy.mode === 'self') return "frame-ancestors 'self'"
  return ["frame-ancestors 'self'", ...policy.origins].join(' ')
}
