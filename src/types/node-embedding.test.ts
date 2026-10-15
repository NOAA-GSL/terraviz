// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  MAX_EMBED_ORIGINS,
  defaultEmbedPolicy,
  frameAncestorsHeader,
  parseStoredEmbedPolicy,
  validateEmbedOrigin,
  validateEmbedPolicyInput,
} from './node-embedding'

/**
 * The origin validator is a security boundary: what it accepts is
 * written into a response header on every page. These cases are the
 * grammar it allows and the ways a value could try to escape a CSP
 * source list.
 */
describe('validateEmbedOrigin', () => {
  it.each([
    ['https://www.example.org', 'https://www.example.org'],
    ['https://example.org', 'https://example.org'],
    ['https://WWW.Example.ORG', 'https://www.example.org'],
    ['HTTPS://example.org', 'https://example.org'],
    ['https://news.noaa.gov:8443', 'https://news.noaa.gov:8443'],
    ['https://*.example.org', 'https://*.example.org'],
    ['https://*.sites.example.org', 'https://*.sites.example.org'],
    ['https://localhost', 'https://localhost'],
    ['https://192.168.1.10', 'https://192.168.1.10'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example'],
  ])('accepts %s as %s', (raw, value) => {
    expect(validateEmbedOrigin(raw)).toEqual({ ok: true, value })
  })

  it.each([
    // What a CSP source list is split on, or what ends a directive.
    ['https://a.org https://b.org', 'whitespace'],
    ['https://a.org *', 'whitespace'],
    ['https://a.org\n', 'whitespace'],
    ['https://a.org\r\nX-Injected: 1', 'whitespace'],
    ['https://a.org\t', 'whitespace'],
    [' https://a.org', 'whitespace'],
    ['https://a.org;script-src', 'forbidden_char'],
    ['https://a.org,https://b.org', 'forbidden_char'],
    ['https://a.org"', 'forbidden_char'],
    ["https://a.org'", 'forbidden_char'],
    ['https://a.org\\', 'forbidden_char'],
    ['https://a.org\u0000', 'forbidden_char'],
    // Keywords, quoted or not, and the bare wildcard.
    ['*', 'keyword'],
    ["'*'", 'keyword'],
    ["'unsafe-inline'", 'keyword'],
    ['unsafe-eval', 'keyword'],
    ["'none'", 'keyword'],
    ["'self'", 'keyword'],
    ['self', 'keyword'],
    ["'strict-dynamic'", 'keyword'],
    ["'nonce-abc'", 'keyword'],
    ["'sha256-abc='", 'keyword'],
    // Not an https origin.
    ['http://example.org', 'not_https'],
    ['http://localhost:8080', 'not_https'],
    ['https:', 'not_https'],
    ['https:example.org', 'not_https'],
    ['data:', 'not_https'],
    ['blob:', 'not_https'],
    ['example.org', 'not_https'],
    ['//example.org', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    // More than an origin.
    ['https://example.org/', 'has_path'],
    ['https://example.org/embed', 'has_path'],
    ['https://example.org?x=1', 'has_path'],
    ['https://example.org#top', 'has_path'],
    ['https://user:pw@example.org', 'has_userinfo'],
    ['https://user@example.org', 'has_userinfo'],
    // Bad ports and hosts.
    ['https://example.org:', 'bad_port'],
    ['https://example.org:0', 'bad_port'],
    ['https://example.org:65536', 'bad_port'],
    ['https://example.org:08443', 'bad_port'],
    ['https://example.org:*', 'bad_port'],
    ['https://', 'bad_host'],
    ['https://*', 'bad_host'],
    ['https://a.*.org', 'bad_host'],
    ['https://example.org.', 'bad_host'],
    ['https://-example.org', 'bad_host'],
    ['https://exa_mple.org', 'bad_host'],
    ['https://exa%20mple.org', 'bad_host'],
    ['https://[::1]', 'bad_host'],
    ['https://*.org', 'wildcard_too_broad'],
    ['https://*.com', 'wildcard_too_broad'],
    ['https://bücher.example', 'not_ascii'],
    ['', 'empty'],
  ])('rejects %j as %s', (raw, code) => {
    const result = validateEmbedOrigin(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(code)
      expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it('rejects non-strings and over-long values', () => {
    expect(validateEmbedOrigin(42).ok).toBe(false)
    expect(validateEmbedOrigin(null).ok).toBe(false)
    expect(validateEmbedOrigin(['https://a.org']).ok).toBe(false)
    const long = `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(30)}.org`
    const result = validateEmbedOrigin(long)
    expect(result.ok).toBe(false)
  })

  it('never accepts a value that could add a CSP token', () => {
    // A property over every accepted case: the value is one token
    // made of the characters an https origin can hold.
    const accepted = [
      'https://www.example.org',
      'https://*.example.org',
      'https://news.noaa.gov:8443',
    ]
    for (const raw of accepted) {
      const result = validateEmbedOrigin(raw)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value).toMatch(/^https:\/\/(\*\.)?[a-z0-9.-]+(:[0-9]+)?$/)
    }
  })
})

describe('validateEmbedPolicyInput', () => {
  it('accepts each mode in its own shape', () => {
    expect(validateEmbedPolicyInput({ mode: 'any' })).toEqual({ ok: true, value: { mode: 'any', origins: [] } })
    expect(validateEmbedPolicyInput({ mode: 'self', origins: [] })).toEqual({
      ok: true,
      value: { mode: 'self', origins: [] },
    })
    expect(
      validateEmbedPolicyInput({ mode: 'list', origins: ['https://www.example.org', 'https://example.org'] }),
    ).toEqual({ ok: true, value: { mode: 'list', origins: ['https://www.example.org', 'https://example.org'] } })
  })

  it('lowercases, then refuses a duplicate by naming the first', () => {
    const result = validateEmbedPolicyInput({
      mode: 'list',
      origins: ['https://example.org', 'https://EXAMPLE.org'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual([
        { field: 'embedding.origins.1', code: 'duplicate', message: 'This repeats site 1.' },
      ])
    }
  })

  it('names each bad origin by its index, rather than dropping it', () => {
    const result = validateEmbedPolicyInput({
      mode: 'list',
      origins: ['https://ok.example.org', 'http://bad.example.org', "'unsafe-inline'"],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.map(e => [e.field, e.code])).toEqual([
        ['embedding.origins.1', 'not_https'],
        ['embedding.origins.2', 'keyword'],
      ])
    }
  })

  it('requires at least one origin for list, and none for any or self', () => {
    const empty = validateEmbedPolicyInput({ mode: 'list', origins: [] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors[0]).toMatchObject({ field: 'embedding.origins', code: 'required' })

    for (const mode of ['any', 'self']) {
      const stale = validateEmbedPolicyInput({ mode, origins: ['https://example.org'] })
      expect(stale.ok).toBe(false)
      if (!stale.ok) expect(stale.errors[0]).toMatchObject({ field: 'embedding.origins', code: 'unexpected' })
    }
  })

  it(`caps the list at ${MAX_EMBED_ORIGINS}`, () => {
    const origins = Array.from({ length: MAX_EMBED_ORIGINS + 1 }, (_, i) => `https://s${i}.example.org`)
    const result = validateEmbedPolicyInput({ mode: 'list', origins })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ code: 'too_many' }))
    expect(validateEmbedPolicyInput({ mode: 'list', origins: origins.slice(0, MAX_EMBED_ORIGINS) }).ok).toBe(true)
  })

  it('rejects an unknown mode, unknown fields and the wrong shapes', () => {
    for (const body of [
      null,
      'list',
      [],
      { mode: 'some' },
      { mode: 'list', origins: 'https://example.org' },
      { mode: 'any', extra: true },
    ]) {
      expect(validateEmbedPolicyInput(body).ok).toBe(false)
    }
  })
})

describe('parseStoredEmbedPolicy', () => {
  it('reads each mode back', () => {
    expect(parseStoredEmbedPolicy({ mode: 'any', origins: [] })).toEqual(defaultEmbedPolicy())
    expect(parseStoredEmbedPolicy({ mode: 'self' })).toEqual({ mode: 'self', origins: [] })
    expect(parseStoredEmbedPolicy({ mode: 'list', origins: ['https://a.example.org'] })).toEqual({
      mode: 'list',
      origins: ['https://a.example.org'],
    })
  })

  it('re-validates stored origins and drops a bad one, keeping the rest', () => {
    expect(
      parseStoredEmbedPolicy({
        mode: 'list',
        origins: ['https://a.example.org', 'https://b.org *', 'https://A.example.org', 'https://c.example.org'],
      }),
    ).toEqual({ mode: 'list', origins: ['https://a.example.org', 'https://c.example.org'] })
  })

  it('is null when the value cannot be used at all', () => {
    for (const raw of [
      null,
      'list',
      [],
      { mode: 'some' },
      { mode: 'list' },
      { mode: 'list', origins: [] },
      { mode: 'list', origins: ['*', "'unsafe-inline'"] },
    ]) {
      expect(parseStoredEmbedPolicy(raw)).toBeNull()
    }
  })
})

describe('frameAncestorsHeader', () => {
  it('sends nothing for any, and always includes self otherwise', () => {
    expect(frameAncestorsHeader({ mode: 'any', origins: [] })).toBeNull()
    expect(frameAncestorsHeader({ mode: 'self', origins: [] })).toBe("frame-ancestors 'self'")
    expect(
      frameAncestorsHeader({ mode: 'list', origins: ['https://www.example.org', 'https://*.example.net'] }),
    ).toBe("frame-ancestors 'self' https://www.example.org https://*.example.net")
  })
})
