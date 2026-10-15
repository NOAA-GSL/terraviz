// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Embedding card: the live-policy analysis (pure), and the card's
 * behaviour — the posture radios, the list editor and its inline
 * errors, the body Save sends, server errors landing on the right row,
 * the read-only view, and the readout of what the node sends.
 */

import { describe, expect, it, vi } from 'vitest'
import { until } from '../../../test-utils'
import type { EmbedPolicy } from '../../../types/node-embedding'
import {
  analyzeLivePolicy,
  buildEmbeddingCard,
  embedPolicyFromSettings,
  frameAncestorsDirectives,
} from './embedding-card'

const ANY: EmbedPolicy = { mode: 'any', origins: [] }
const SELF: EmbedPolicy = { mode: 'self', origins: [] }
const LIST: EmbedPolicy = { mode: 'list', origins: ['https://www.example.org', 'https://example.org'] }

describe('frameAncestorsDirectives', () => {
  it('finds the directive in every policy of a joined value', () => {
    expect(
      frameAncestorsDirectives("default-src 'self'; frame-ancestors 'none', frame-ancestors 'self' https://A.org"),
    ).toEqual(["frame-ancestors 'none'", "frame-ancestors 'self' https://a.org"])
    expect(frameAncestorsDirectives(null)).toEqual([])
    expect(frameAncestorsDirectives("connect-src 'self'")).toEqual([])
  })
})

describe('analyzeLivePolicy', () => {
  it('all clear when the node sends exactly what the setting says', () => {
    expect(analyzeLivePolicy(ANY, { csp: null, xfo: null })).toEqual([{ kind: 'ok' }])
    expect(analyzeLivePolicy(SELF, { csp: "frame-ancestors 'self'", xfo: null })).toEqual([{ kind: 'ok' }])
    expect(
      analyzeLivePolicy(LIST, {
        csp: "connect-src 'self', frame-ancestors 'self' https://www.example.org https://example.org",
        xfo: null,
      }),
    ).toEqual([{ kind: 'ok' }])
  })

  it('flags X-Frame-Options, which can block every other site', () => {
    expect(analyzeLivePolicy(ANY, { csp: null, xfo: 'SAMEORIGIN' })).toEqual([{ kind: 'xfo', value: 'SAMEORIGIN' }])
  })

  it('flags a frame-ancestors the setting did not produce', () => {
    expect(analyzeLivePolicy(ANY, { csp: "frame-ancestors 'none'", xfo: null })).toEqual([
      { kind: 'extra', value: "frame-ancestors 'none'" },
    ])
    expect(
      analyzeLivePolicy(LIST, {
        csp: "frame-ancestors 'self' https://www.example.org https://example.org, frame-ancestors 'self'",
        xfo: null,
      }),
    ).toEqual([{ kind: 'extra', value: "frame-ancestors 'self'" }])
  })

  it('says a save is still propagating when its own directive is missing', () => {
    expect(analyzeLivePolicy(SELF, { csp: null, xfo: null })).toEqual([{ kind: 'pending' }])
    // The old setting's directive is still live: one "pending", not an
    // extra policy as well.
    expect(analyzeLivePolicy(LIST, { csp: "frame-ancestors 'self'", xfo: null })).toEqual([{ kind: 'pending' }])
  })
})

describe('embedPolicyFromSettings', () => {
  it('hides the card for a response with no policy, an older deploy', () => {
    expect(embedPolicyFromSettings({ features: {} })).toBeNull()
    expect(embedPolicyFromSettings(null)).toBeNull()
  })

  it('reads a policy, and treats a malformed one as any', () => {
    expect(embedPolicyFromSettings({ embedding: LIST })).toEqual(LIST)
    expect(embedPolicyFromSettings({ embedding: { mode: 'sometimes' } })).toEqual(ANY)
    expect(embedPolicyFromSettings({ embedding: null })).toEqual(ANY)
    expect(embedPolicyFromSettings({ embedding: { mode: 'self', origins: ['https://x.org'] } })).toEqual(SELF)
  })
})

// ----- The card -----

interface Call {
  url: string
  method: string
  body: unknown
}

/** A fetch that answers `HEAD /` with `live`, and a node-settings PUT
 *  with `put` (200 echoing the body unless a 400 is given). */
function makeFetch(opts: {
  live?: { csp?: string; xfo?: string }
  put?: { status: number; body: unknown }
}) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (method === 'HEAD') {
      const headers = new Headers()
      if (opts.live?.csp) headers.set('Content-Security-Policy', opts.live.csp)
      if (opts.live?.xfo) headers.set('X-Frame-Options', opts.live.xfo)
      return { ok: true, status: 200, type: 'basic', headers } as unknown as Response
    }
    const status = opts.put?.status ?? 200
    const payload = opts.put?.body ?? { features: {}, ...(body as object) }
    return {
      ok: status < 400,
      status,
      type: 'basic',
      redirected: false,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

function mount(policy: EmbedPolicy, opts: Parameters<typeof makeFetch>[0] & { canEdit?: boolean } = {}) {
  const { fetchFn, calls } = makeFetch(opts)
  const card = buildEmbeddingCard({ policy, canEdit: opts.canEdit ?? true, fetchFn })
  document.body.replaceChildren(card)
  const q = <T extends Element>(selector: string) => card.querySelector<T>(selector)
  const qa = <T extends Element>(selector: string) => Array.from(card.querySelectorAll<T>(selector))
  const radio = (mode: string) => q<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!
  const inputs = () => qa<HTMLInputElement>('.publisher-nodeprofile-embed-input')
  const save = () => qa<HTMLButtonElement>('button').find(b => b.textContent === 'Save embedding')
  const puts = () => calls.filter(c => c.method === 'PUT')
  return { card, calls, q, qa, radio, inputs, save, puts }
}

function choose(radio: HTMLInputElement): void {
  radio.checked = true
  radio.dispatchEvent(new Event('change'))
}

describe('buildEmbeddingCard', () => {
  it('offers the three postures as labelled radios in a fieldset, checked from the policy', () => {
    const { q, qa, radio } = mount(ANY)
    expect(q('fieldset legend')?.textContent).toBe('Who can embed this node')
    expect(qa('input[type="radio"]')).toHaveLength(3)
    expect(radio('any').checked).toBe(true)
    for (const mode of ['any', 'list', 'self']) {
      const r = radio(mode)
      expect(r.closest('label')).toBeTruthy()
      const desc = document.getElementById(r.getAttribute('aria-describedby')!)
      expect(desc?.textContent?.length).toBeGreaterThan(0)
    }
  })

  it('shows the list only for "Only sites I list", with one empty row to start', () => {
    const { q, radio, inputs } = mount(ANY)
    const block = q<HTMLElement>('.publisher-nodeprofile-embed-origins')!
    expect(block.hidden).toBe(true)
    choose(radio('list'))
    expect(block.hidden).toBe(false)
    expect(inputs()).toHaveLength(1)
    expect(inputs()[0].getAttribute('aria-label')).toBe('Site 1')
  })

  it('pre-fills the list, and Save sends it trimmed with empty rows skipped', async () => {
    const view = mount(LIST)
    expect(view.inputs().map(i => i.value)).toEqual(LIST.origins)
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    view.inputs()[2].value = '  https://news.example.org  '
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    expect(view.puts()[0].url).toContain('/api/v1/publish/node-settings')
    expect(view.puts()[0].body).toEqual({
      embedding: {
        mode: 'list',
        origins: ['https://www.example.org', 'https://example.org', 'https://news.example.org'],
      },
    })
    await until(() => view.q('[role="status"]')?.textContent !== '', 'the saved message')
    expect(view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent).toMatch(/saved/i)
  })

  it('sends no origins for "No other site", even with rows still filled in', async () => {
    const view = mount(LIST)
    choose(view.radio('self'))
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    expect(view.puts()[0].body).toEqual({ embedding: { mode: 'self', origins: [] } })
  })

  it('marks a bad site inline, focuses it, and sends nothing', () => {
    const view = mount(LIST)
    view.inputs()[1].value = 'http://example.org/embed'
    view.save()!.click()
    const bad = view.inputs()[1]
    expect(bad.getAttribute('aria-invalid')).toBe('true')
    const errorId = bad.getAttribute('aria-describedby')!.split(' ')[0]
    const error = document.getElementById(errorId)!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toBe('A site must start with https://.')
    expect(document.activeElement).toBe(bad)
    expect(view.puts()).toHaveLength(0)
    // Typing clears the error.
    bad.value = 'https://example.net'
    bad.dispatchEvent(new Event('input'))
    expect(bad.hasAttribute('aria-invalid')).toBe(false)
    expect(error.hidden).toBe(true)
  })

  it('refuses a duplicate by naming the row it repeats', () => {
    const view = mount(LIST)
    view.inputs()[1].value = 'https://WWW.example.org'
    view.save()!.click()
    expect(view.inputs()[1].getAttribute('aria-invalid')).toBe('true')
    const error = document.getElementById(view.inputs()[1].getAttribute('aria-describedby')!.split(' ')[0])!
    expect(error.textContent).toBe('This repeats site 1.')
    expect(view.puts()).toHaveLength(0)
  })

  it('needs at least one site for the list posture', () => {
    const view = mount(ANY)
    choose(view.radio('list'))
    view.save()!.click()
    expect(view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent).toBe(
      'List at least one site, or choose "No other site".',
    )
    expect(view.puts()).toHaveLength(0)
  })

  it('puts a server field error on the row that sent that entry', async () => {
    const view = mount(
      { mode: 'list', origins: ['https://a.example.org', 'https://b.example.org'] },
      {
        put: {
          status: 400,
          body: { errors: [{ field: 'embedding.origins.1', code: 'bad_host', message: 'Bad host.' }] },
        },
      },
    )
    // An empty row between the two: the server's index 1 is the third row.
    view.q<HTMLButtonElement>('.publisher-nodeprofile-embed-origins .publisher-button')!.click()
    const rows = view.inputs()
    const third = rows[2]
    third.value = rows[1].value
    rows[1].value = ''
    view.save()!.click()
    await until(() => third.getAttribute('aria-invalid') === 'true', 'the server error on the row')
    expect(rows[1].hasAttribute('aria-invalid')).toBe(false)
    const error = document.getElementById(third.getAttribute('aria-describedby')!.split(' ')[0])!
    expect(error.textContent).toBe('Enter a valid host name, such as www.example.org.')
  })

  it('removing a row renumbers the rest and keeps focus in the list', () => {
    const view = mount({ mode: 'list', origins: ['https://a.example.org', 'https://b.example.org', 'https://c.example.org'] })
    view.qa<HTMLButtonElement>('.publisher-nodeprofile-embed-remove')[0].click()
    expect(view.inputs().map(i => i.getAttribute('aria-label'))).toEqual(['Site 1', 'Site 2'])
    expect(view.qa('.publisher-nodeprofile-embed-remove').map(b => b.getAttribute('aria-label'))).toEqual([
      'Remove site 1',
      'Remove site 2',
    ])
    expect(document.activeElement).toBe(view.inputs()[0])
  })

  it('read-only for a caller who is not an admin: no editing, no Save, the list as text', () => {
    const view = mount(LIST, { canEdit: false })
    expect(view.qa<HTMLInputElement>('input[type="radio"]').every(r => r.disabled)).toBe(true)
    expect(view.save()).toBeUndefined()
    expect(view.inputs()).toHaveLength(0)
    expect(view.qa('.publisher-nodeprofile-embed-readonly li').map(li => li.textContent)).toEqual(LIST.origins)
    expect(view.q('.publisher-nodeprofile-embed-origins')?.hasAttribute('hidden')).toBe(false)
  })
})

describe('buildEmbeddingCard: what this node sends now', () => {
  it('reads HEAD / on render and shows the two headers, quietly', async () => {
    const view = mount(SELF, { live: { csp: "frame-ancestors 'self'" } })
    await until(() => view.qa('.publisher-nodeprofile-embed-live-values dd').length === 2, 'the readout')
    const head = view.calls.find(c => c.method === 'HEAD')!
    expect(head.url).toBe('/')
    const values = view.qa('.publisher-nodeprofile-embed-live-values dd').map(dd => dd.textContent)
    expect(values).toEqual(["frame-ancestors 'self'", '(not sent)'])
    expect(view.q('.publisher-nodeprofile-embed-finding')?.textContent).toBe('This matches the saved setting.')
    // Not announced: nobody asked.
    expect(view.q('.publisher-nodeprofile-embed-live [role="status"]')?.textContent).toBe('')
  })

  it('warns about X-Frame-Options, and announces a check the user asked for', async () => {
    const view = mount(ANY, { live: { xfo: 'SAMEORIGIN' } })
    await until(() => view.qa('.publisher-nodeprofile-embed-finding-warn').length === 1, 'the warning')
    expect(view.q('.publisher-nodeprofile-embed-finding-warn')?.textContent).toContain('X-Frame-Options: SAMEORIGIN')
    view.qa<HTMLButtonElement>('button').find(b => b.textContent === 'Check again')!.click()
    const liveStatus = view.q('.publisher-nodeprofile-embed-live [role="status"]')!
    await until(() => (liveStatus.textContent ?? '').includes('SAMEORIGIN'), 'the announced verdict')
  })

  it('compares against the newly saved policy after a save', async () => {
    const view = mount(ANY, { live: {} })
    await until(() => view.qa('.publisher-nodeprofile-embed-finding').length === 1, 'the first readout')
    choose(view.radio('self'))
    view.save()!.click()
    await until(() => view.puts().length === 1, 'the PUT')
    await until(
      () => (view.q('.publisher-nodeprofile-actions [role="status"]')?.textContent ?? '').length > 0,
      'the save outcome',
    )
    view.qa<HTMLButtonElement>('button').find(b => b.textContent === 'Check again')!.click()
    await until(
      () => (view.q('.publisher-nodeprofile-embed-live [role="status"]')?.textContent ?? '').includes("doesn't match"),
      'the pending verdict',
    )
  })

  it('says so when the check itself fails', async () => {
    const card = buildEmbeddingCard({
      policy: ANY,
      canEdit: true,
      fetchFn: vi.fn(async () => {
        throw new TypeError('offline')
      }) as unknown as typeof fetch,
    })
    document.body.replaceChildren(card)
    await until(() => card.querySelector('.publisher-nodeprofile-embed-finding-warn') !== null, 'the error')
    expect(card.querySelector('.publisher-nodeprofile-embed-finding-warn')?.textContent).toBe(
      "Couldn't check what this node sends.",
    )
  })
})
