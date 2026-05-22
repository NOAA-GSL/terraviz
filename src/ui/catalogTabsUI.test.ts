import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  hideCatalogTabs,
  initCatalogTabs,
  setActiveCatalogTab,
  showCatalogTabs,
} from './catalogTabsUI'

function setupDom(): void {
  document.body.innerHTML = `
    <div id="container">
      <div id="ui"></div>
    </div>
  `
}

describe('catalogTabsUI', () => {
  beforeEach(() => {
    setupDom()
  })

  it('mounts a tab control under #ui with both tabs', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    const host = document.getElementById('catalog-tabs')
    expect(host).not.toBeNull()
    expect(host!.parentElement?.id).toBe('ui')
    expect(host!.querySelector('#catalog-tab-catalog')).not.toBeNull()
    expect(host!.querySelector('#catalog-tab-sphere')).not.toBeNull()
  })

  it('starts hidden — caller decides when to reveal', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(true)
  })

  it('showCatalogTabs reveals the control; hideCatalogTabs hides it', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    showCatalogTabs()
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(false)
    hideCatalogTabs()
    expect(document.getElementById('catalog-tabs')?.classList.contains('hidden')).toBe(true)
  })

  it('setActiveCatalogTab marks the chosen tab active and sets aria-selected', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    setActiveCatalogTab('catalog')
    const catalogBtn = document.getElementById('catalog-tab-catalog')!
    const sphereBtn = document.getElementById('catalog-tab-sphere')!
    expect(catalogBtn.classList.contains('active')).toBe(true)
    expect(catalogBtn.getAttribute('aria-selected')).toBe('true')
    expect(sphereBtn.classList.contains('active')).toBe(false)
    expect(sphereBtn.getAttribute('aria-selected')).toBe('false')

    setActiveCatalogTab('sphere')
    expect(catalogBtn.classList.contains('active')).toBe(false)
    expect(catalogBtn.getAttribute('aria-selected')).toBe('false')
    expect(sphereBtn.classList.contains('active')).toBe(true)
    expect(sphereBtn.getAttribute('aria-selected')).toBe('true')
  })

  it('clicking Catalog calls onSelectCatalog', () => {
    const onCatalog = vi.fn()
    const onSphere = vi.fn()
    initCatalogTabs({ onSelectCatalog: onCatalog, onSelectSphere: onSphere })
    document.getElementById('catalog-tab-catalog')!.click()
    expect(onCatalog).toHaveBeenCalledTimes(1)
    expect(onSphere).not.toHaveBeenCalled()
  })

  it('clicking Sphere calls onSelectSphere', () => {
    const onCatalog = vi.fn()
    const onSphere = vi.fn()
    initCatalogTabs({ onSelectCatalog: onCatalog, onSelectSphere: onSphere })
    document.getElementById('catalog-tab-sphere')!.click()
    expect(onSphere).toHaveBeenCalledTimes(1)
    expect(onCatalog).not.toHaveBeenCalled()
  })

  it('is idempotent — re-calling initCatalogTabs does not double-mount', () => {
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    initCatalogTabs({ onSelectCatalog: vi.fn(), onSelectSphere: vi.fn() })
    expect(document.querySelectorAll('#catalog-tabs').length).toBe(1)
  })
})
