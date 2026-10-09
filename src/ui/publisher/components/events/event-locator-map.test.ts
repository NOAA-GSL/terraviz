// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { until } from '../../../../test-utils'

// Mock MapLibre so no WebGL / tile fetching happens in the test.
const mapStub = vi.hoisted(() => {
  const remove = vi.fn()
  const addTo = vi.fn()
  const setLngLat = vi.fn(() => ({ addTo }))
  const instances: Array<{ opts: Record<string, unknown> }> = []
  class Map {
    opts: Record<string, unknown>
    remove = remove
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      instances.push(this)
    }
  }
  class Marker {
    setLngLat = setLngLat
    constructor(_o: unknown) { void _o }
  }
  return { Map, Marker, remove, setLngLat, addTo, instances }
})

// Named exports with no `default`, which is the shape MapLibre 6 actually
// ships — it is ESM-only. A mock carrying a `default` would keep passing
// against a consumer that still destructured one, which is the bug this
// shape exists to catch. `setWorkerUrl` is called by `utils/maplibre`,
// which the locator imports MapLibre through.
vi.mock('maplibre-gl', () => ({ Map: mapStub.Map, Marker: mapStub.Marker, setWorkerUrl: vi.fn() }))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

import { mountEventLocator } from './event-locator-map'

describe('mountEventLocator', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="slot"></div>'
    mapStub.instances.length = 0
    mapStub.remove.mockClear()
    mapStub.setLngLat.mockClear()
  })

  it('mounts a non-interactive map centred on the point, then disposes it', async () => {
    const slot = document.getElementById('slot')!
    const dispose = mountEventLocator(slot, { lat: 46.4, lon: -117.2 })
    // The lazy import chain is done once the marker is placed — its last step.
    await until(() => mapStub.setLngLat.mock.calls.length > 0, 'the locator marker')

    expect(mapStub.instances).toHaveLength(1)
    expect(mapStub.instances[0].opts.center).toEqual([-117.2, 46.4]) // [lon, lat]
    expect(mapStub.instances[0].opts.interactive).toBe(false)
    expect(slot.querySelector('.publisher-events-locator-canvas')).not.toBeNull()
    expect(mapStub.setLngLat).toHaveBeenCalledWith([-117.2, 46.4])

    dispose()
    expect(mapStub.remove).toHaveBeenCalled()
  })

  it('cancels the mount when disposed before the map finishes loading', async () => {
    const slot = document.getElementById('slot')!
    const dispose = mountEventLocator(slot, { lat: 0, lon: 0 })
    dispose() // dispose before the lazy import resolves

    // Positive anchor: a second, undisposed mount reaching its map proves
    // the lazy import has resolved, so the first mount's chance to build
    // one has come and gone.
    const other = document.createElement('div')
    document.body.appendChild(other)
    mountEventLocator(other, { lat: 10, lon: 20 })
    await until(() => mapStub.instances.length > 0, 'the second locator mounting')

    expect(mapStub.instances).toHaveLength(1)
    expect(mapStub.instances[0].opts.center).toEqual([20, 10])
    expect(slot.querySelector('.publisher-events-locator-canvas')).toBeNull()
  })
})
