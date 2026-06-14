import { describe, expect, it } from 'vitest'

import { scenes } from './scenes'

describe('screenshot scene manifest', () => {
  it('has at least the starter set', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(4)
  })

  it('every scene has a unique name', () => {
    const names = scenes.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names are filesystem- and Weblate-safe slugs', () => {
    // Used verbatim as `<name>.png` and as the Weblate screenshot
    // name, so keep them to lowercase / digits / dashes.
    for (const s of scenes) {
      expect(s.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('every scene has a non-empty description and a setup function', () => {
    for (const s of scenes) {
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(typeof s.setup).toBe('function')
    }
  })

  it('covers the publisher and admin surfaces', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['publish-datasets']))
    expect(names.some((n) => n.startsWith('admin-'))).toBe(true)
  })
})
