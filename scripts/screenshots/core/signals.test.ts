// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import {
  axeEnabled,
  createSignalCollector,
  type ConsoleMessageLike,
  type RequestLike,
  type ResponseLike,
} from './signals'

const consoleMsg = (type: string, text: string): ConsoleMessageLike => ({
  type: () => type,
  text: () => text,
})

const request = (
  url: string,
  method: string,
  errorText: string | null,
): RequestLike => ({
  url: () => url,
  method: () => method,
  failure: () => (errorText === null ? null : { errorText }),
})

const response = (url: string, status: number): ResponseLike => ({
  url: () => url,
  status: () => status,
})

describe('createSignalCollector', () => {
  it('buckets console errors and warnings, ignoring other levels', () => {
    const c = createSignalCollector()
    c.handleConsole(consoleMsg('error', 'boom'))
    c.handleConsole(consoleMsg('warning', 'heads up'))
    c.handleConsole(consoleMsg('log', 'noise'))
    c.handleConsole(consoleMsg('info', 'noise'))

    expect(c.signals.consoleErrors).toEqual(['boom'])
    expect(c.signals.consoleWarnings).toEqual(['heads up'])
  })

  it('records page errors by message', () => {
    const c = createSignalCollector()
    c.handlePageError(new Error('uncaught'))
    expect(c.signals.pageErrors).toEqual(['uncaught'])
  })

  it('records failed requests with a fallback failure text', () => {
    const c = createSignalCollector()
    c.handleRequestFailed(request('https://x/img.png', 'GET', 'net::ERR_FAILED'))
    c.handleRequestFailed(request('https://x/late', 'POST', null))

    expect(c.signals.failedRequests).toEqual([
      { url: 'https://x/img.png', method: 'GET', failure: 'net::ERR_FAILED' },
      { url: 'https://x/late', method: 'POST', failure: 'unknown' },
    ])
  })

  it('records only 4xx/5xx responses as bad', () => {
    const c = createSignalCollector()
    c.handleResponse(response('https://x/ok', 200))
    c.handleResponse(response('https://x/redirect', 302))
    c.handleResponse(response('https://x/missing', 404))
    c.handleResponse(response('https://x/boom', 500))

    expect(c.signals.badResponses).toEqual([
      { url: 'https://x/missing', status: 404 },
      { url: 'https://x/boom', status: 500 },
    ])
  })

  it('starts with no axe violations until a scan populates them', () => {
    const c = createSignalCollector()
    expect(c.signals.axeViolations).toBeUndefined()
  })
})

const resourceError = (status: number): ConsoleMessageLike =>
  consoleMsg(
    'error',
    `Failed to load resource: the server responded with a status of ${status} (Server Error)`,
  )

describe('a scene that expects a bad response', () => {
  const EXPECTED = [{ url: '/api/v1/publish/datasets', status: 500 }]

  it('drops the declared response and the console line it produces', () => {
    // publish-datasets-error stubs a 500 so the page renders its error
    // card. Badging that forever is how a badge stops being read.
    const c = createSignalCollector(EXPECTED)
    c.handleResponse(response('http://x/api/v1/publish/datasets?status=draft', 500))
    c.handleConsole(resourceError(500))

    expect(c.signals.badResponses).toEqual([])
    expect(c.signals.consoleErrors).toEqual([])
  })

  it('does not care which order the two events arrive in', () => {
    // The response event and the console line are the same failure seen
    // twice, and Playwright does not promise an order. Deciding as they
    // arrive would make the result depend on timing.
    const c = createSignalCollector(EXPECTED)
    c.handleConsole(resourceError(500))
    c.handleResponse(response('http://x/api/v1/publish/datasets?status=draft', 500))

    expect(c.signals.consoleErrors).toEqual([])
  })

  it('still reports a different endpoint failing with the same status', () => {
    // The half that keeps the declaration honest: status alone would
    // hide this, and a page that fetches several endpoints is the
    // likely case rather than the unlikely one.
    const c = createSignalCollector(EXPECTED)
    c.handleResponse(response('http://x/api/v1/publish/datasets', 500))
    c.handleResponse(response('http://x/api/v1/publish/tours', 500))

    expect(c.signals.badResponses).toEqual([{ url: 'http://x/api/v1/publish/tours', status: 500 }])
    // With an unexplained 500 still standing, the console line is kept
    // rather than attributed to the expected one.
    c.handleConsole(resourceError(500))
    expect(c.signals.consoleErrors).toHaveLength(1)
  })

  it('still reports the declared endpoint failing with a different status', () => {
    const c = createSignalCollector(EXPECTED)
    c.handleResponse(response('http://x/api/v1/publish/datasets', 404))
    expect(c.signals.badResponses).toEqual([
      { url: 'http://x/api/v1/publish/datasets', status: 404 },
    ])
  })

  it('leaves console errors that are not resource failures alone', () => {
    const c = createSignalCollector(EXPECTED)
    c.handleResponse(response('http://x/api/v1/publish/datasets', 500))
    c.handleConsole(consoleMsg('error', 'TypeError: x is not a function'))
    expect(c.signals.consoleErrors).toEqual(['TypeError: x is not a function'])
  })

  it('changes nothing when a scene declares no expectations', () => {
    const c = createSignalCollector()
    c.handleResponse(response('http://x/api/v1/publish/datasets', 500))
    c.handleConsole(resourceError(500))
    expect(c.signals.badResponses).toHaveLength(1)
    expect(c.signals.consoleErrors).toHaveLength(1)
  })

  it('matches a URL by pattern as well as by substring', () => {
    const c = createSignalCollector([{ url: /\/publish\/datasets\b/, status: 500 }])
    c.handleResponse(response('http://x/api/v1/publish/datasets?limit=200', 500))
    expect(c.signals.badResponses).toEqual([])
  })

  it('over-matches child routes when the declaration is a bare string', () => {
    // Not an endorsement — a pin on the sharp edge, so the docstring's
    // warning cannot quietly stop being true. `/publish/datasets/<id>`
    // is a real route, and a substring declaration swallows it.
    const c = createSignalCollector([{ url: '/api/v1/publish/datasets', status: 500 }])
    c.handleResponse(response('http://x/api/v1/publish/datasets/01ABC', 500))
    expect(c.signals.badResponses).toEqual([])
  })

  it('an anchored pattern keeps the child route reporting', () => {
    // What publish-datasets-error actually declares. The query string
    // still matches; the detail route does not.
    const anchored = [{ url: /\/api\/v1\/publish\/datasets(\?|$)/, status: 500 }]
    const c = createSignalCollector(anchored)
    c.handleResponse(response('http://x/api/v1/publish/datasets?status=draft&limit=200', 500))
    c.handleResponse(response('http://x/api/v1/publish/datasets', 500))
    c.handleResponse(response('http://x/api/v1/publish/datasets/01ABC', 500))

    expect(c.signals.badResponses).toEqual([
      { url: 'http://x/api/v1/publish/datasets/01ABC', status: 500 },
    ])
  })
})

describe('axeEnabled', () => {
  const orig = process.env.VISUAL_AXE
  const restore = () => {
    if (orig === undefined) delete process.env.VISUAL_AXE
    else process.env.VISUAL_AXE = orig
  }

  it('is true for "1" or "true", false otherwise', () => {
    process.env.VISUAL_AXE = '1'
    expect(axeEnabled()).toBe(true)
    process.env.VISUAL_AXE = 'true'
    expect(axeEnabled()).toBe(true)
    process.env.VISUAL_AXE = 'false'
    expect(axeEnabled()).toBe(false)
    delete process.env.VISUAL_AXE
    expect(axeEnabled()).toBe(false)
    restore()
  })
})
