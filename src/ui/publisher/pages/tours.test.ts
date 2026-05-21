import { describe, expect, it, vi } from 'vitest'
import { renderToursPage } from './tours'
import type { TourListItem } from '../../tourAuthoring/api'

function makeTour(overrides: Partial<TourListItem> = {}): TourListItem {
  return {
    id: '01HXAAAAAAAAAAAAAAAAAAAAAA',
    slug: 'sample-tour',
    title: 'Sample tour',
    description: null,
    tour_json_ref: 'r2:tours/01HXAAAAAAAAAAAAAAAAAAAAAA/draft.json',
    thumbnail_ref: null,
    visibility: 'public',
    updated_at: '2026-05-21T12:00:00.000Z',
    published_at: null,
    publisher_id: 'PUB-STAFF',
    ...overrides,
  }
}

describe('renderToursPage (tour/A → /G)', () => {
  it('renders the empty-state shell when the list is empty', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    expect(content.querySelector('h2')?.textContent).toBe('Tours')
    expect(content.querySelector('.publisher-empty')?.textContent).toContain('No tours yet')
  })

  it('renders a table of tours when the list has rows', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        tours: [
          makeTour({ id: '01HX01', title: 'Draft one' }),
          makeTour({
            id: '01HX02',
            title: 'Published one',
            published_at: '2026-05-21T13:00:00Z',
          }),
        ],
        next_cursor: null,
      })),
    })
    const rows = content.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Draft one')
    expect(rows[0].textContent).toContain('Draft')
    expect(rows[1].textContent).toContain('Published one')
    expect(rows[1].textContent).toContain('Published')
  })

  it('Edit / title link navigates to /?tourEdit=<id>', async () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    await renderToursPage(content, {
      navigate,
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        tours: [makeTour({ id: '01HX_T1' })],
        next_cursor: null,
      })),
    })
    content.querySelector<HTMLAnchorElement>('.publisher-row-link')!.click()
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=01HX_T1')
  })

  it('POSTs /publish/tours/draft and navigates to /?tourEdit=<new-id> on New tour click', async () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    const createDraft = vi.fn(async () => ({
      tour: {
        id: '01HXAAAAAAAAAAAAAAAAAAAAAA',
        slug: 'untitled-tour-aaaaaa',
        title: 'Untitled tour AAAAAA',
        tour_json_ref: 'r2:tours/01HXAAAAAAAAAAAAAAAAAAAAAA/draft.json',
        updated_at: '2026-05-21T20:30:00.000Z',
      },
    }))
    await renderToursPage(content, {
      navigate,
      createDraft,
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    content
      .querySelector<HTMLButtonElement>('button[aria-label="Start a new tour"]')!
      .click()
    await Promise.resolve()
    await Promise.resolve()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=01HXAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('surfaces a list-fetch error inline', async () => {
    const content = document.createElement('div')
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({
        error: 'Network unavailable',
        kind: 'network' as const,
      })),
    })
    expect(content.querySelector('.publisher-empty')?.textContent).toContain(
      'Network unavailable',
    )
  })

  it('clears prior content (idempotent re-render)', async () => {
    const content = document.createElement('div')
    content.innerHTML = '<div class="stale">stale</div>'
    await renderToursPage(content, {
      navigate: () => {},
      createDraft: vi.fn(),
      listFn: vi.fn(async () => ({ tours: [], next_cursor: null })),
    })
    expect(content.querySelector('.stale')).toBeNull()
    expect(content.querySelector('.publisher-shell')).toBeTruthy()
  })
})
