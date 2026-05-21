import { describe, expect, it, vi } from 'vitest'
import { renderToursPage } from './tours'

describe('renderToursPage (tour/A)', () => {
  it('renders the empty-state shell with a New tour button', () => {
    const content = document.createElement('div')
    renderToursPage(content, { navigate: () => {} })
    expect(content.querySelector('h2')?.textContent).toBe('Tours')
    const btn = content.querySelector<HTMLButtonElement>(
      'button[aria-label="Start a new tour"]',
    )
    expect(btn).toBeTruthy()
    expect(content.querySelector('.publisher-empty')?.textContent).toContain('No tours yet')
  })

  it('navigates to /?tourEdit=new when New tour is clicked', () => {
    const content = document.createElement('div')
    const navigate = vi.fn()
    renderToursPage(content, { navigate })
    content
      .querySelector<HTMLButtonElement>('button[aria-label="Start a new tour"]')!
      .click()
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=new')
  })

  it('clears prior content (idempotent re-render)', () => {
    const content = document.createElement('div')
    content.innerHTML = '<div class="stale">stale</div>'
    renderToursPage(content, { navigate: () => {} })
    expect(content.querySelector('.stale')).toBeNull()
    expect(content.querySelector('.publisher-shell')).toBeTruthy()
  })
})
