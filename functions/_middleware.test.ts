// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The root middleware: which responses get the embedding policy, what
 * the header says for each mode, and what it must never do — touch a
 * Function route, the portal, a non-HTML response or an operator's
 * own CSP, or let a storage failure turn into an error page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMBED_POLICY_MEMO_MS,
  embedPolicyFor,
  isHtmlResponse,
  isPublicAppPath,
  onRequest,
  resetEmbedPolicyMemoForTests,
  withEmbedPolicy,
} from './_middleware'
import { NODE_EMBEDDING_CACHE_KEY } from './api/v1/_lib/node-settings-store'
import { makeKV } from './api/v1/_lib/test-helpers'
import type { EmbedPolicy } from '../src/types/node-embedding'

beforeEach(resetEmbedPolicyMemoForTests)

const ANY: EmbedPolicy = { mode: 'any', origins: [] }
const SELF: EmbedPolicy = { mode: 'self', origins: [] }
const LIST: EmbedPolicy = { mode: 'list', origins: ['https://www.example.org', 'https://*.example.net'] }

/** A KV holding `policy` under the cache key, so reads never reach D1. */
function envWith(policy: EmbedPolicy) {
  const kv = makeKV()
  kv._store.set(NODE_EMBEDDING_CACHE_KEY, JSON.stringify(policy))
  const get = vi.spyOn(kv, 'get')
  return { env: { CATALOG_KV: kv }, get }
}

function html(headers: Record<string, string> = {}): Response {
  return new Response('<!doctype html><title>t</title>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
  })
}

function run(opts: {
  path: string
  env: Record<string, unknown>
  downstream?: Response
  method?: string
  requestHeaders?: Record<string, string>
}) {
  const request = new Request(`https://node.example${opts.path}`, {
    method: opts.method ?? 'GET',
    headers: opts.requestHeaders,
  })
  const next = vi.fn(async (_input?: Request | string) => opts.downstream ?? html())
  const context = {
    request,
    env: opts.env,
    params: {},
    data: {},
    next,
    waitUntil: () => {},
    passThroughOnException: () => {},
    functionPath: opts.path,
  } as unknown as Parameters<typeof onRequest>[0]
  return { next, response: onRequest(context) as Promise<Response> }
}

describe('the header each mode sends', () => {
  it('any adds nothing, and passes the response through as it was', async () => {
    const { env } = envWith(ANY)
    const downstream = html()
    const { response } = run({ path: '/', env, downstream })
    const res = await response
    expect(res).toBe(downstream)
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })

  it("self sends frame-ancestors 'self'", async () => {
    const { env } = envWith(SELF)
    const res = await run({ path: '/', env }).response
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it("list sends 'self' and each listed site", async () => {
    const { env } = envWith(LIST)
    const res = await run({ path: '/dataset/sst', env }).response
    expect(res.headers.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://www.example.org https://*.example.net",
    )
  })

  it('keeps the status, the body and the headers _headers attached', async () => {
    const { env } = envWith(SELF)
    const res = await run({ path: '/?dataset=x&embed=1', env }).response
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toContain('<title>t</title>')
  })

  it("appends to an operator's own CSP rather than replacing it", async () => {
    const { env } = envWith(LIST)
    const downstream = html({ 'Content-Security-Policy': "connect-src 'self'" })
    const res = await run({ path: '/', env, downstream }).response
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    // Two policies, joined with a comma when read back: both enforced.
    expect(csp).toBe("connect-src 'self', frame-ancestors 'self' https://www.example.org https://*.example.net")
  })

  it('answers a HEAD the same way, so a readout can check the live policy', async () => {
    const { env } = envWith(SELF)
    const downstream = new Response(null, { headers: { 'Content-Type': 'text/html' } })
    const res = await run({ path: '/', env, downstream, method: 'HEAD' }).response
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })
})

describe('what it leaves alone', () => {
  it.each(['/api/v1/catalog', '/api/v1/publish/node-settings', '/schema/stac/x.json', '/.well-known/terraviz.json'])(
    '%s: a Function route, untouched and never read for',
    async path => {
      const { env, get } = envWith(SELF)
      const downstream = html()
      const { response, next } = run({ path, env, downstream })
      expect(await response).toBe(downstream)
      expect(get).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
    },
  )

  it.each(['/publish', '/publish/', '/publish/users'])(
    "%s: the portal, which _headers governs, untouched whatever the policy",
    async path => {
      const { env, get } = envWith(LIST)
      const downstream = html({ 'Content-Security-Policy': "frame-ancestors 'self'" })
      const res = await run({ path, env, downstream }).response
      expect(res).toBe(downstream)
      expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'")
      expect(get).not.toHaveBeenCalled()
    },
  )

  it.each(['image/png', 'application/javascript', 'application/json', 'text/plain'])(
    'a %s response, untouched and never read for',
    async type => {
      const { env, get } = envWith(SELF)
      const downstream = new Response('x', { headers: { 'Content-Type': type } })
      expect(await run({ path: '/something', env, downstream }).response).toBe(downstream)
      expect(get).not.toHaveBeenCalled()
    },
  )

  it('a response with no content type, untouched', async () => {
    const { env } = envWith(SELF)
    const downstream = new Response(null, { status: 304 })
    expect(await run({ path: '/', env, downstream }).response).toBe(downstream)
  })
})

describe('conditional requests', () => {
  it('forwards an app page request without its validators, so no 304 keeps a stale policy', async () => {
    const { env } = envWith(SELF)
    const { response, next } = run({
      path: '/',
      env,
      requestHeaders: { 'If-None-Match': '"abc"', 'If-Modified-Since': 'Thu, 01 Oct 2026 00:00:00 GMT', Accept: 'text/html' },
    })
    await response
    const forwarded = next.mock.calls[0][0] as Request
    expect(forwarded.headers.get('If-None-Match')).toBeNull()
    expect(forwarded.headers.get('If-Modified-Since')).toBeNull()
    expect(forwarded.headers.get('Accept')).toBe('text/html')
    expect(forwarded.url).toBe('https://node.example/')
  })

  it('forwards a Function route request untouched', async () => {
    const { env } = envWith(SELF)
    const { response, next } = run({ path: '/api/v1/catalog', env, requestHeaders: { 'If-None-Match': '"abc"' } })
    await response
    expect(next).toHaveBeenCalledWith()
  })
})

describe('failures', () => {
  it('a storage outage on a cold isolate fails open: no header, and the page is served', async () => {
    const throwingDb = {
      prepare() {
        throw new Error('D1 down')
      },
    } as unknown as D1Database
    const downstream = html()
    const res = await run({ path: '/', env: { CATALOG_DB: throwingDb }, downstream }).response
    expect(res).toBe(downstream)
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})

describe('embedPolicyFor: the per-isolate memo', () => {
  it('reuses an answer inside the window, and reads again after it', async () => {
    const { env, get } = envWith(SELF)
    expect(await embedPolicyFor(env, 1_000)).toEqual(SELF)
    expect(await embedPolicyFor(env, 1_000 + EMBED_POLICY_MEMO_MS - 1)).toEqual(SELF)
    expect(get).toHaveBeenCalledTimes(1)
    await embedPolicyFor(env, 1_000 + EMBED_POLICY_MEMO_MS)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('keeps a known restriction through a storage failure', async () => {
    const { env } = envWith(LIST)
    expect(await embedPolicyFor(env, 0)).toEqual(LIST)
    const broken = {
      CATALOG_KV: {
        get() {
          throw new Error('kv down')
        },
      } as unknown as KVNamespace,
      CATALOG_DB: {
        prepare() {
          throw new Error('D1 down')
        },
      } as unknown as D1Database,
    }
    expect(await embedPolicyFor(broken, EMBED_POLICY_MEMO_MS)).toEqual(LIST)
  })

  it('takes a real answer that lifts a restriction', async () => {
    expect(await embedPolicyFor(envWith(SELF).env, 0)).toEqual(SELF)
    expect(await embedPolicyFor(envWith(ANY).env, EMBED_POLICY_MEMO_MS)).toEqual(ANY)
  })

  it('a node with no catalog binding is any', async () => {
    expect(await embedPolicyFor({}, 0)).toEqual(ANY)
  })
})

describe('the helpers', () => {
  it('isPublicAppPath', () => {
    expect(isPublicAppPath('/')).toBe(true)
    expect(isPublicAppPath('/orbit')).toBe(true)
    expect(isPublicAppPath('/publisher')).toBe(true)
    expect(isPublicAppPath('/publish')).toBe(false)
    expect(isPublicAppPath('/api/ingest')).toBe(false)
    expect(isPublicAppPath('/.well-known/terraviz.json')).toBe(false)
  })

  it('isHtmlResponse', () => {
    expect(isHtmlResponse(new Response('', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))).toBe(true)
    expect(isHtmlResponse(new Response('', { headers: { 'Content-Type': 'TEXT/HTML' } }))).toBe(true)
    expect(isHtmlResponse(new Response('', { headers: { 'Content-Type': 'text/htmlx' } }))).toBe(false)
    expect(isHtmlResponse(new Response('', { headers: { 'Content-Type': 'application/xhtml+xml' } }))).toBe(false)
  })

  it('withEmbedPolicy returns the same response for any', () => {
    const response = html()
    expect(withEmbedPolicy(response, ANY)).toBe(response)
  })
})
