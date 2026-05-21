import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountTourAuthoringDock } from './dock'
import type { MapViewContext } from '../../types'

function makeView(overrides: Partial<MapViewContext> = {}): MapViewContext {
  return {
    center: { lat: 29, lng: -89 },
    zoom: 3,
    bearing: 0,
    pitch: 0,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    visibleCountries: [],
    visibleOceans: [],
    ...overrides,
  }
}

afterEach(() => {
  // Each test mounts the dock to body; tear them all down so the
  // next test starts from a clean DOM.
  document.querySelectorAll('.tour-authoring-dock').forEach(el => el.remove())
})

describe('mountTourAuthoringDock (tour/A)', () => {
  it('appends a dock element with the documented role + aria label', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      onDiscard: () => {},
    })
    const dock = document.querySelector('.tour-authoring-dock')!
    expect(dock).toBeTruthy()
    expect(dock.getAttribute('role')).toBe('region')
    expect(dock.getAttribute('aria-label')).toBe('Tour authoring dock')
  })

  it('shows the empty-state message when no tasks have been captured', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      onDiscard: () => {},
    })
    const empty = document.querySelector('.tour-authoring-task-empty')
    expect(empty?.textContent).toContain('No tasks captured yet')
  })

  it('appends a flyTo task when "Add camera step" is clicked', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView({ center: { lat: 35.7, lng: 139.7 }, zoom: 5 }),
      onDiscard: () => {},
    })
    const btn = document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
    btn.click()
    const tasks = document.querySelectorAll('.tour-authoring-task')
    expect(tasks).toHaveLength(1)
    const label = tasks[0].querySelector('.tour-authoring-task-label')?.textContent ?? ''
    // The summary template renders "Camera → {lat}, {lon} at {altmi} mi".
    expect(label).toContain('Camera')
    expect(label).toContain('35.7')
    expect(label).toContain('139.7')
  })

  it('renders captured tasks in capture order with 1-based indices', () => {
    mountTourAuthoringDock('new', {
      getMapView: () => makeView({ center: { lat: 0, lng: 0 } }),
      onDiscard: () => {},
    })
    const btn = document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!
    btn.click()
    btn.click()
    btn.click()
    const indices = Array.from(document.querySelectorAll('.tour-authoring-task-index')).map(
      el => el.textContent,
    )
    expect(indices).toEqual(['1.', '2.', '3.'])
  })

  it('does not capture a task when the renderer has no view context yet', () => {
    // Boot race — dock mounts before MapLibre fires its first
    // render. Click should no-op (warning logged, no task added)
    // rather than crash.
    mountTourAuthoringDock('new', {
      getMapView: () => null,
      onDiscard: () => {},
    })
    document.querySelector<HTMLButtonElement>('[data-action="capture-camera"]')!.click()
    expect(document.querySelectorAll('.tour-authoring-task')).toHaveLength(0)
    expect(document.querySelectorAll('.tour-authoring-task-empty')).toHaveLength(1)
  })

  it('fires onDiscard when the close button is clicked', () => {
    const onDiscard = vi.fn()
    mountTourAuthoringDock('new', {
      getMapView: () => makeView(),
      onDiscard,
    })
    document.querySelector<HTMLButtonElement>('.tour-authoring-dock-close')!.click()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('captures altmi from zoom (higher zoom → lower altitude)', () => {
    // Inverse of `execFlyTo`'s zoom math in `tourEngine.ts`:
    //   altKm = (6371 × 2) / 2^zoom
    //   altmi = altKm / (MI_TO_KM × SOS_ALTITUDE_SCALE)
    // At zoom 0: altKm = 12742, altmi ≈ 39580 (very high).
    // At zoom 5: altKm = 398.18, altmi ≈ 1236.
    // Just confirm the relationship — exact magnitudes vary with
    // the constants, so we assert "higher zoom yields smaller
    // altmi" rather than pinning the number.
    function altmiAt(zoom: number): number {
      document.querySelectorAll('.tour-authoring-dock').forEach(el => el.remove())
      let captured: { altmi: number } | null = null
      mountTourAuthoringDock('new', {
        getMapView: () => makeView({ zoom }),
        onDiscard: () => {},
      })
      // Patch the label parser by reading the rendered text.
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-action="capture-camera"]',
      )!
      btn.click()
      const label =
        document.querySelector('.tour-authoring-task-label')?.textContent ?? ''
      const match = /at (\d+) mi/.exec(label)
      if (match) captured = { altmi: parseInt(match[1], 10) }
      return captured?.altmi ?? -1
    }
    const lo = altmiAt(0)
    const hi = altmiAt(5)
    expect(lo).toBeGreaterThan(hi)
  })
})
