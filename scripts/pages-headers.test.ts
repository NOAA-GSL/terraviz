// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isPublisherPortalPath } from '../src/utils/publisherPath'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `public/_headers` is the only thing that keeps the publisher portal
 * from being framed by another site.
 *
 * `_redirects` sends every path to `index.html`, so the public app,
 * its `?embed=1` view and `/publish` are one document. Whatever a node
 * decides about embedding the public app, the portal is an admin
 * surface and must refuse to be framed by anyone but itself. Cloudflare
 * Access gates it, but clickjacking protection should not rest on that.
 *
 * Pages applies every rule whose pattern matches and joins a repeated
 * header with a comma. That makes two edits silently dangerous: a
 * second `X-Frame-Options` value (a conflicting pair blocks framing
 * outright, even same-origin), and a widened `frame-ancestors` on the
 * portal rule itself. The parser below applies the file the way Pages
 * does, so the assertions are about what a browser receives.
 *
 * Which paths are "the portal" is not written down here: it is
 * `isPublisherPortalPath`, the predicate `src/main.ts` boots the portal
 * on. The corpus is a spread of path shapes, and each one the gate
 * accepts must be one the rules protect. A hand-kept list let the gate
 * accept `/publisher` while the test called it a public path.
 */

interface HeaderRule {
  pattern: string
  /** `Name: value` lines, and `! Name` detach lines (value `null`). */
  headers: Array<[name: string, value: string | null]>
}

/** Parse `_headers`: unindented lines are URL patterns, indented
 *  `Name: value` lines belong to the pattern above, an indented
 *  `! Name` removes that header, `#` starts a comment. Patterns that
 *  name a host are kept, and the matcher decides whether they apply. */
function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: [] })
      continue
    }
    const rule = rules[rules.length - 1]
    if (!rule) throw new Error(`header line before any pattern: ${raw}`)
    const line = raw.trim()
    if (line.startsWith('!')) {
      rule.headers.push([line.slice(1).trim(), null])
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) throw new Error(`header line is neither "Name: value" nor "! Name": ${raw}`)
    rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  return rules
}

/** Pages' pattern grammar: `*` is a greedy splat, `:name` one segment.
 *  A pattern naming a host (`https://:project.pages.dev/*`) is treated
 *  as matching every host, so a rule scoped to the preview hostname is
 *  still checked: the portal there is the same portal. */
function matches(pattern: string, path: string): boolean {
  const hostScoped = /^https?:\/\/[^/]+(\/.*)$/.exec(pattern)
  if (hostScoped) pattern = hostScoped[1]
  if (!pattern.startsWith('/')) return false
  const source = pattern
    .split(/(\*|:[A-Za-z]\w*)/)
    .map(part => {
      if (part === '*') return '.*'
      if (part.startsWith(':')) return '[^/]+'
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${source}$`).test(path)
}

/** Every value each header receives on `path`, in file order. */
function headersFor(rules: HeaderRule[], path: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase()
      if (value === null) out.delete(key)
      else out.set(key, [...(out.get(key) ?? []), value])
    }
  }
  return out
}

/** Each `frame-ancestors` source list across every CSP policy. A
 *  comma separates policies, both inside one value and between the
 *  values Pages joins. */
function frameAncestorsLists(cspValues: string[]): string[][] {
  const lists: string[][] = []
  for (const policy of cspValues.join(',').split(',')) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/)
      if (name?.toLowerCase() === 'frame-ancestors') lists.push(sources)
    }
  }
  return lists
}

const rules = parseHeadersFile(readFileSync(resolve(REPO_ROOT, 'public/_headers'), 'utf8'))

/** Path shapes worth asking the gate about: real portal routes,
 *  near-misses that share the prefix, and the ordinary public routes. */
const PATH_CORPUS = [
  '/publish',
  '/publish/',
  '/publish//x',
  '/publish/overview',
  '/publish/users',
  '/publish/datasets/01HXYZ/edit',
  '/publish/node-profile',
  '/publisher',
  '/publishing',
  '/publish.',
  '/publish-x',
  '/publish;x',
  '/publish%20',
  '/publish%2Fusers',
  '/Publish',
  '/%70ublish',
  '//publish',
  '/',
  '/dataset/sea-surface-temperature',
  '/blog',
  '/orbit',
]

const PORTAL_PATHS = PATH_CORPUS.filter(isPublisherPortalPath)
const PUBLIC_PATHS = PATH_CORPUS.filter(path => !isPublisherPortalPath(path))

describe('the portal gate', () => {
  it('accepts the portal and nothing that merely shares its prefix', () => {
    expect(PORTAL_PATHS).toEqual(expect.arrayContaining(['/publish', '/publish/', '/publish/users']))
    expect(PUBLIC_PATHS).toEqual(
      expect.arrayContaining(['/publisher', '/publishing', '/publish-x', '/publish%2Fusers', '/']),
    )
  })
})

describe('public/_headers: the publisher portal refuses to be framed', () => {
  it.each(PORTAL_PATHS)('%s carries frame-ancestors limited to the node itself', path => {
    const csp = headersFor(rules, path).get('content-security-policy') ?? []
    const lists = frameAncestorsLists(csp)
    expect(lists.length).toBeGreaterThan(0)
    // Every policy is enforced, so one 'self' (or 'none') policy is
    // what blocks other sites. None may name a broader source either:
    // that would be the portal rule being loosened in place.
    for (const sources of lists) {
      for (const source of sources) expect(["'self'", "'none'"]).toContain(source.toLowerCase())
    }
  })

  it.each(PORTAL_PATHS)('%s carries exactly one X-Frame-Options value', path => {
    const xfo = headersFor(rules, path).get('x-frame-options') ?? []
    // Joined values are one header to the browser; a conflicting pair
    // blocks framing entirely, so the set must hold one value.
    const values = new Set(xfo.join(',').split(',').map(v => v.trim().toLowerCase()))
    expect([...values]).toEqual(['sameorigin'])
  })

  it('the portal rules leave the ordinary security headers in place', () => {
    const headers = headersFor(rules, '/publish/datasets')
    expect(headers.get('x-content-type-options')).toEqual(['nosniff'])
    expect(headers.get('referrer-policy')).toEqual(['strict-origin-when-cross-origin'])
  })
})

describe('public/_headers: the public app stays embeddable by default', () => {
  // The default posture (docs/WORDPRESS_INTEGRATION_PLAN.md §4): any
  // site may embed the app. A static framing rule here would override
  // that for every node, whatever its operator chose.
  it.each(PUBLIC_PATHS)(
    '%s gets no framing restriction from _headers',
    path => {
      const headers = headersFor(rules, path)
      expect(headers.get('x-frame-options')).toBeUndefined()
      expect(frameAncestorsLists(headers.get('content-security-policy') ?? [])).toEqual([])
    },
  )
})

describe('the _headers parser', () => {
  it('matches Pages patterns the way Pages does', () => {
    expect(matches('/*', '/anything/at/all')).toBe(true)
    expect(matches('/publish/*', '/publish/x')).toBe(true)
    expect(matches('/publish/*', '/publish')).toBe(false)
    expect(matches('/publish', '/publisher')).toBe(false)
    expect(matches('/a/:id/b', '/a/1/b')).toBe(true)
    expect(matches('/a/:id/b', '/a/1/2/b')).toBe(false)
    expect(matches('https://example.org/*', '/x')).toBe(true)
    expect(matches('https://example.org/a', '/x')).toBe(false)
  })

  it('applies a detach line to the headers set before it', () => {
    const parsed = parseHeadersFile('/*\n  X-A: one\n/p/*\n  ! X-A\n  X-B: two\n')
    expect(headersFor(parsed, '/p/q').get('x-a')).toBeUndefined()
    expect(headersFor(parsed, '/p/q').get('x-b')).toEqual(['two'])
  })

  it('checks a rule scoped to a host against the path', () => {
    const parsed = parseHeadersFile('https://:project.pages.dev/*\n  X-A: one\n')
    expect(headersFor(parsed, '/publish').get('x-a')).toEqual(['one'])
  })

  it('joins repeated headers across matching rules', () => {
    const parsed = parseHeadersFile('/*\n  X-A: one\n\n# note\n/p/*\n  X-A: two\n')
    expect(headersFor(parsed, '/p/q').get('x-a')).toEqual(['one', 'two'])
    expect(headersFor(parsed, '/q').get('x-a')).toEqual(['one'])
  })
})
