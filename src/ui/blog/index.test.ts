/**
 * Tests for the public blog surface — list cards, the sanitized post
 * page (markdown body, dataset deep links, event citation), and the
 * missing-post view.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootBlogPage } from './index'

const LIST = {
  posts: [
    { slug: 'gulf-warming', title: 'Watching the Gulf warm', summary: 'Three decades of SST.', publishedAt: '2026-07-01T00:00:00.000Z', datasetCount: 2 },
  ],
}
const POST = {
  post: {
    slug: 'gulf-warming',
    title: 'Watching the Gulf warm',
    summary: 'Three decades of SST.',
    bodyMd: '## The data\nWe looked at the loop. <script>alert(1)</script>',
    publishedAt: '2026-07-01T00:00:00.000Z',
    datasets: [{ id: 'DS_SST', title: 'Sea Surface Temperature' }],
    event: { id: 'EVT1', title: 'Gulf marine heatwave', sourceName: 'NOAA', sourceUrl: 'https://example.gov/heatwave' },
  },
}

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status === 200,
    status,
    json: async () => body,
  }) as unknown as Response))
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.body.classList.remove('blog-body')
})

describe('bootBlogPage', () => {
  it('renders published-post cards on /blog', async () => {
    history.pushState(null, '', '/blog')
    stubFetch(200, LIST)
    await bootBlogPage()
    const card = document.querySelector('.blog-card') as HTMLAnchorElement
    expect(card.getAttribute('href')).toBe('/blog/gulf-warming')
    expect(card.textContent).toContain('Watching the Gulf warm')
  })

  it('renders the post: sanitized markdown, dataset deep links, event citation', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, POST)
    await bootBlogPage()
    const body = document.querySelector('.blog-post-body')!
    expect(body.querySelector('h2')?.textContent).toBe('The data')
    // The sanitizer must strip the script tag.
    expect(body.querySelector('script')).toBeNull()
    expect(body.innerHTML).not.toContain('<script>')

    const explore = document.querySelector('.blog-post-explore-list a') as HTMLAnchorElement
    expect(explore.getAttribute('href')).toBe('/dataset/DS_SST')
    const cite = document.querySelector('.blog-post-citation a') as HTMLAnchorElement
    expect(cite.getAttribute('href')).toBe('https://example.gov/heatwave')
    expect(cite.rel).toContain('noopener')
  })

  it('renders the missing view for an unknown slug', async () => {
    history.pushState(null, '', '/blog/nope')
    stubFetch(404, { error: 'not_found' })
    await bootBlogPage()
    expect(document.querySelector('.blog-missing')).toBeTruthy()
    expect((document.querySelector('.blog-missing a') as HTMLAnchorElement).getAttribute('href')).toBe('/blog')
  })
})
