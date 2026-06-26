import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderEventsPage } from './events'

const DS = 'DS000' + 'A'.repeat(21)
const EVT = '01HEVENT00000000000000000A'

interface RouteSpec { status?: number; body?: unknown }

function mockFetch(routes: Record<string, RouteSpec>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const bare = String(path).split('?')[0]
    const spec = routes[`${method} ${bare}`] ?? routes[bare] ?? {}
    const status = spec.status ?? 200
    const body = spec.body ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      type: 'basic',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
}

const oneEvent = () => ({
  events: [
    {
      id: EVT,
      title: 'Hurricane makes landfall',
      summary: 'A category 4 storm reached the coast.',
      source: { name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-06-25T00:00:00Z' },
      occurredStart: '2026-06-25T12:00:00Z',
      status: 'proposed',
      links: [
        { datasetId: DS, datasetTitle: 'Live Storm', score: 0.9, signals: { geo: null, temporal: 1 }, status: 'proposed' },
      ],
    },
  ],
})

const baseRoutes = (): Record<string, RouteSpec> => ({
  '/api/v1/publish/me': { body: { role: 'admin', is_admin: true } },
  '/api/v1/publish/events': { body: oneEvent() },
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
})

describe('renderEventsPage', () => {
  it('shows a restricted card for a non-privileged publisher', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/me'] = { body: { role: 'publisher', is_admin: false } }
    await renderEventsPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-events-restricted')).not.toBeNull()
    expect(mount.querySelector('.publisher-events-card')).toBeNull()
  })

  it('renders an event card with its source, title, and link row', async () => {
    await renderEventsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    expect(mount.querySelector('.publisher-events-event-title')?.textContent).toBe('Hurricane makes landfall')
    const sourceLink = mount.querySelector('.publisher-events-source-link') as HTMLAnchorElement
    expect(sourceLink?.href).toContain('example.gov/storm')
    const linkRow = mount.querySelector('.publisher-events-link')
    expect(linkRow?.querySelector('.publisher-events-link-title')?.textContent).toBe('Live Storm')
  })

  it('shows the empty state when there are no events', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/events'] = { body: { events: [] } }
    await renderEventsPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-empty-message')).not.toBeNull()
    expect(mount.querySelector('.publisher-events-card')).toBeNull()
  })

  it('approves the event via POST and updates the badge', async () => {
    const routes = baseRoutes()
    routes[`POST /api/v1/publish/events/${EVT}`] = { body: { event: { status: 'approved' }, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const approve = mount.querySelector('.publisher-events-actions .publisher-btn-primary') as HTMLButtonElement
    approve.click()
    await flush()

    const post = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST')
    expect(post).toBeTruthy()
    expect(String(post![0])).toBe(`/api/v1/publish/events/${EVT}`)
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ event: 'approve' })

    const badge = mount.querySelector('.publisher-events-header .publisher-events-badge')
    expect(badge?.classList.contains('publisher-events-badge-approved')).toBe(true)
  })

  it('approves a single link via POST with the link decision', async () => {
    const routes = baseRoutes()
    routes[`POST /api/v1/publish/events/${EVT}`] = { body: { event: null, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const linkApprove = mount.querySelector('.publisher-events-link .publisher-btn-small.publisher-btn-primary') as HTMLButtonElement
    linkApprove.click()
    await flush()

    const post = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST')
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      links: [{ datasetId: DS, decision: 'approve' }],
    })
  })
})
