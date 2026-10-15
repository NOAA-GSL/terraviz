// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Root middleware: puts the node's embedding policy on the public
 * app's pages as a `frame-ancestors` header.
 *
 * The policy is an admin setting (`src/types/node-embedding.ts`, saved
 * through `PUT /api/v1/publish/node-settings`), so it cannot live in
 * the static `public/_headers`. The app, its `?embed=1` view and the
 * portal are one `index.html` (`public/_redirects`), and this is the
 * one place that sees every navigation to it.
 *
 * **What it touches, and what it leaves alone.**
 *
 * - Every HTML response except the publisher portal's, whatever the
 *   path. Not only the app's own paths: `_redirects` serves the app's
 *   `index.html` for any path nothing else answers, so `/api/nope?embed=1`
 *   boots the full app from under a Function prefix. Gating on the
 *   path let that frame freely; gating on the response cannot. No
 *   Function returns HTML today, and one that did would only be
 *   tightened. The portal is `public/_headers`' job, and stays
 *   `frame-ancestors 'self'` whatever the setting says;
 *   `public/_routes.json` keeps it from reaching this Function at
 *   all, and the check here holds if that file is ever widened. The
 *   directories `_routes.json` keeps away from this Function have the
 *   same fallback, so `_headers` locks those statically.
 * - A page opened with `?tourEdit=` always gets `frame-ancestors
 *   'self'`, whatever the setting. That is the tour-authoring dock, a
 *   publisher write surface on the public document; its own check
 *   refuses to mount under a foreign frame (`src/ui/tourAuthoring/`),
 *   and this makes the browser refuse first.
 * - It **appends** a separate `Content-Security-Policy` rather than
 *   editing one. An operator's own CSP, from `_headers` or the edge,
 *   stays exactly as they wrote it, and since every policy a browser
 *   receives is enforced, the two compose: neither can loosen the
 *   other.
 * - It passes `next()`'s response through, re-wrapped only to add the
 *   header. `_headers` rules are attached inside the asset handler
 *   that `next()` reaches, so they survive this; a response built
 *   from scratch here would lose them. Checked with `wrangler pages
 *   dev`, where a pass-through response and a re-wrapped one both
 *   kept every `_headers` rule and a fresh one kept none.
 * - `any`, the default, adds nothing, so a node that never saved a
 *   policy serves byte-for-byte what it served before this existed.
 *
 * **Conditional requests are made unconditional** on the pages it
 * governs: the app's paths, and anything a browser fetches as a
 * document or a frame (`Sec-Fetch-Dest`). Production Pages sends no `ETag` or `Last-Modified` on
 * HTML today, but `wrangler pages dev` does. A 304 carries no body
 * and, from the asset handler, no policy. A browser keeps the
 * headers it stored with the 200 unless the 304 replaces them, so a
 * policy lifted back to `any` would stay enforced in every cache that
 * revalidated. Dropping `If-None-Match` / `If-Modified-Since` costs
 * one small HTML transfer and keeps every page's policy current.
 *
 * **Memoised per isolate, with a last-known-good answer**, as
 * `functions/api/_lib/orbit-gate.ts` is and for the same reasons.
 * Every page navigation reaches this, so reading the policy each time
 * would put a KV read on every one. An answer is reused for
 * {@link EMBED_POLICY_MEMO_MS}, which costs little freshness: the KV
 * entry behind it is up to five minutes old anyway, and a save busts
 * that entry. A failed read keeps this isolate's last real answer, so
 * a D1 blip does not lift a node's restriction where the isolate
 * already knew it. A cold isolate during an outage fails open to
 * `any`. That is the accepted trade-off in `node-settings-store.ts`:
 * closed would blank every legitimate embed during an outage. Reads
 * that start together are not merged, for orbit-gate's reason:
 * sharing one request's storage I/O with another can leave a response
 * hanging.
 *
 * **Cost.** This is one Function invocation per HTML navigation, not
 * per asset (`public/_routes.json` excludes the static files), and
 * Pages Functions requests count against the Workers request quota.
 * `docs/SELF_HOSTING.md` §0.6 says so where it lists plan limits.
 *
 * **The read is bounded** at {@link EMBED_POLICY_READ_TIMEOUT_MS}. It
 * runs after `next()` has answered, so a slow D1 on a cold memo would
 * otherwise hold the page. A read that runs out counts as a failed one:
 * the isolate's last real answer, or `any`.
 *
 * Never throws past `next()`: a failure to apply the policy serves the
 * page without it rather than an error page.
 */

import { readEffectiveEmbedPolicy } from './api/v1/_lib/node-settings-store'
import { defaultEmbedPolicy, frameAncestorsHeader, type EmbedPolicy } from '../src/types/node-embedding'
import { isPublisherPortalPath } from '../src/utils/publisherPath'

/** How long one isolate reuses an answer — one read from storage, or
 *  the fallback a failed read left. */
export const EMBED_POLICY_MEMO_MS = 60_000

/** How long a page waits for the policy before taking the fallback. A
 *  warm KV read takes a few milliseconds and a D1 read tens to a few
 *  hundred; this is for the tail, not the common case. */
export const EMBED_POLICY_READ_TIMEOUT_MS = 1_000

/**
 * Path prefixes that belong to Function routes rather than the app.
 * One per top-level directory under `functions/`; the routing test
 * fails if a directory is added without its prefix here.
 */
export const FUNCTION_ROUTE_PREFIXES = ['/api/', '/schema/', '/.well-known/'] as const

/** The catalog bindings the policy is read from. Pages bindings are
 *  project-wide, so these are present here as on every route. */
export interface EmbedPolicyEnv {
  CATALOG_DB?: D1Database
  CATALOG_KV?: KVNamespace
}

/** This isolate's current answer, and when it last asked storage. */
let lastRead: { policy: EmbedPolicy; atMs: number } | null = null

/** The policy to enforce now. Never throws. */
export async function embedPolicyFor(env: EmbedPolicyEnv, nowMs: number = Date.now()): Promise<EmbedPolicy> {
  if (lastRead && nowMs - lastRead.atMs < EMBED_POLICY_MEMO_MS) return lastRead.policy
  let policy: EmbedPolicy
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<{ policy: EmbedPolicy; authoritative: false }>(resolve => {
      timer = setTimeout(() => resolve({ policy: defaultEmbedPolicy(), authoritative: false }), EMBED_POLICY_READ_TIMEOUT_MS)
    })
    const read = await Promise.race([readEffectiveEmbedPolicy(env), timedOut]).finally(() => clearTimeout(timer))
    // Storage failed: the last real answer if this isolate has one,
    // else `any`. Memoised like a real read, or every page during an
    // outage would retry storage.
    policy = read.authoritative ? read.policy : (lastRead?.policy ?? read.policy)
  } catch {
    policy = lastRead?.policy ?? defaultEmbedPolicy()
  }
  lastRead = { policy, atMs: nowMs }
  return policy
}

/** Forget the memo — tests only; module state outlives a test case. */
export function resetEmbedPolicyMemoForTests(): void {
  lastRead = null
}

/** Is this a page of the public app, as opposed to a Function route
 *  or the portal? Path only; the response type is checked separately. */
export function isPublicAppPath(pathname: string): boolean {
  if (isPublisherPortalPath(pathname)) return false
  return !FUNCTION_ROUTE_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

/** An HTML document, by its content type. */
export function isHtmlResponse(response: Response): boolean {
  const type = response.headers.get('Content-Type') ?? ''
  return /^\s*text\/html\b/i.test(type)
}

/** Will this response be used as a page, in a tab or a frame? The
 *  app's own paths always are; elsewhere, only a fetch the browser
 *  marks as a document or a frame. */
function isNavigation(request: Request, pathname: string): boolean {
  if (isPublicAppPath(pathname)) return true
  const dest = request.headers.get('Sec-Fetch-Dest')
  return dest === 'document' || dest === 'iframe' || dest === 'frame'
}

/** The request to forward: the same, minus the headers that would let
 *  the asset handler answer 304 with a stale policy. */
function unconditional(request: Request): Request {
  if (!request.headers.has('If-None-Match') && !request.headers.has('If-Modified-Since')) return request
  const headers = new Headers(request.headers)
  headers.delete('If-None-Match')
  headers.delete('If-Modified-Since')
  return new Request(request, { headers })
}

/** Add each policy's header to an HTML response, each as its own
 *  policy, so the stricter one wins. */
export function withEmbedPolicy(response: Response, ...policies: EmbedPolicy[]): Response {
  const headers = policies.map(frameAncestorsHeader).filter((h): h is string => h !== null)
  if (headers.length === 0) return response
  const out = new Response(response.body, response)
  for (const header of new Set(headers)) out.headers.append('Content-Security-Policy', header)
  return out
}

/** The tour-authoring dock's page: locked to this node whatever the
 *  setting says. */
const TOUR_AUTHORING_LOCK: EmbedPolicy = { mode: 'self', origins: [] }

export const onRequest: PagesFunction<EmbedPolicyEnv> = async context => {
  const url = new URL(context.request.url)
  if (isPublisherPortalPath(url.pathname)) return context.next()

  const forwarded = isNavigation(context.request, url.pathname) ? unconditional(context.request) : undefined
  const response = await (forwarded ? context.next(forwarded) : context.next())
  try {
    if (!isHtmlResponse(response)) return response
    const policy = await embedPolicyFor(context.env)
    return url.searchParams.has('tourEdit')
      ? withEmbedPolicy(response, policy, TOUR_AUTHORING_LOCK)
      : withEmbedPolicy(response, policy)
  } catch {
    return response
  }
}
