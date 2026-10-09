// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `photorealEarth.setTexture`'s readiness contract.
 *
 * The immersive loading splash waits on `onReady`, and the only call
 * that passes one is the first `setTexture` of the session — the
 * per-frame poll after it passes none. So the callback has to survive
 * a swap of the primary (a tour's `loadDataset`, `unloadDataset`), it
 * must not fire while a video is still on the placeholder, and a video
 * that fails to decode has to say so rather than leave the caller to
 * its own timeout.
 *
 * No GL context is involved: `setTexture` only swaps `material.map`
 * and uniforms, and the real stack builds under happy-dom with the
 * decoration (atmosphere LUT, clouds, sun, shadow) switched off. The
 * `<video>` is a stand-in whose `readyState` / `error` / events the
 * tests drive directly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  createPhotorealEarth,
  type PhotorealEarthHandle,
  type TextureReadiness,
  type VrDatasetTexture,
} from './photorealEarth'

/** The slice of `HTMLVideoElement` setTexture touches. */
class FakeVideo extends EventTarget {
  readyState = 0
  error: MediaError | null = null
  currentTime = 0
  play = vi.fn(() => Promise.resolve())
}

const videoSpec = (v: FakeVideo): VrDatasetTexture =>
  ({ kind: 'video', element: v as unknown as HTMLVideoElement })

const imageSpec = (): VrDatasetTexture =>
  ({ kind: 'image', element: document.createElement('canvas') })

let earth: PhotorealEarthHandle | null = null

function makeEarth(): PhotorealEarthHandle {
  earth = createPhotorealEarth(THREE, {
    includeAtmosphere: false,
    includeClouds: false,
    includeSun: false,
    includeShadow: false,
  })
  return earth
}

const mapOf = (e: PhotorealEarthHandle) =>
  (e.globe.material as THREE.MeshPhongMaterial).map

afterEach(() => {
  earth?.dispose()
  earth = null
})

describe('photorealEarth.setTexture — readiness', () => {
  it('reports live synchronously for an image and for null', () => {
    const e = makeEarth()
    const onReady = vi.fn()
    e.setTexture(imageSpec(), onReady)
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })

    const onNull = vi.fn()
    e.setTexture(null, onNull)
    expect(onNull).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('waits for the first decoded frame of a pending video', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    expect(onReady).not.toHaveBeenCalled()
    expect(mapOf(e)).toBe(e.baseEarthTexture)

    v.dispatchEvent(new Event('loadeddata'))
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })
    expect(mapOf(e)).toBeInstanceOf(THREE.VideoTexture)
  })

  it('does not report an unchanged, still-pending video as live', () => {
    // The trap in "just pass onReady from the per-frame poll": the
    // unchanged-element branch used to fire at once, dismissing the
    // splash while the globe was still on the placeholder.
    const e = makeEarth()
    const v = new FakeVideo()
    e.setTexture(videoSpec(v))
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    expect(onReady).not.toHaveBeenCalled()

    v.dispatchEvent(new Event('playing'))
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })

    // Once live, an unchanged call answers at once.
    const late = vi.fn()
    e.setTexture(videoSpec(v), late)
    expect(late).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('carries a pending onReady to an image that replaces the video', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    // The per-frame poll sees the primary change and passes no onReady.
    e.setTexture(imageSpec())
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('carries a pending onReady to null (dataset unloaded)', () => {
    const e = makeEarth()
    const onReady = vi.fn()
    e.setTexture(videoSpec(new FakeVideo()), onReady)
    e.setTexture(null)
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('carries a pending onReady to the next video, not the one it replaced', () => {
    const e = makeEarth()
    const first = new FakeVideo()
    const second = new FakeVideo()
    const onReady = vi.fn()
    e.setTexture(videoSpec(first), onReady)
    e.setTexture(videoSpec(second))

    // The replaced element's listeners are gone.
    first.dispatchEvent(new Event('loadeddata'))
    expect(onReady).not.toHaveBeenCalled()

    second.dispatchEvent(new Event('canplay'))
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: true })
  })

  it('reports a video error as a failure, then live if the element recovers', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    const outcomes: TextureReadiness[] = []
    e.setTexture(videoSpec(v), r => outcomes.push(r))

    v.dispatchEvent(new Event('error'))
    expect(outcomes).toEqual([{ ok: false }])
    // Still the placeholder — nothing to show.
    expect(mapOf(e)).toBe(e.baseEarthTexture)

    v.dispatchEvent(new Event('playing'))
    expect(outcomes).toEqual([{ ok: false }, { ok: true }])
    expect(mapOf(e)).toBeInstanceOf(THREE.VideoTexture)
  })

  it('reports an element that had already failed without waiting for an event', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    v.error = { code: 3 } as MediaError
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: false })
  })

  it('tells a caller joining an errored wait that it failed', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    e.setTexture(videoSpec(v))
    v.dispatchEvent(new Event('error'))
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    expect(onReady).toHaveBeenCalledExactlyOnceWith({ ok: false })
  })

  it('releases a failed waiter with ok: true when the next dataset goes live', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    const outcomes: TextureReadiness[] = []
    e.setTexture(videoSpec(v), r => outcomes.push(r))
    v.dispatchEvent(new Event('error'))
    e.setTexture(imageSpec())
    expect(outcomes).toEqual([{ ok: false }, { ok: true }])

    // A late error from the replaced element reaches nobody.
    v.dispatchEvent(new Event('error'))
    expect(outcomes).toHaveLength(2)
  })

  it('drops waiters on dispose without calling them', () => {
    const e = makeEarth()
    const v = new FakeVideo()
    const onReady = vi.fn()
    e.setTexture(videoSpec(v), onReady)
    e.dispose()
    earth = null
    v.dispatchEvent(new Event('loadeddata'))
    v.dispatchEvent(new Event('error'))
    expect(onReady).not.toHaveBeenCalled()
  })
})
