// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../i18n'
import {
  createVrLoadingHandover,
  VR_LOADING_FAILED_PAUSE_MS,
  VR_LOADING_FALLBACK_MS,
  VR_LOADING_READY_PAUSE_MS,
  type VrLoadingHandoverEffects,
} from './vrLoadingHandover'

const LIVE = { ok: true } as const
const FAILED = { ok: false } as const

/** Effects recorder; `fadeOut` resolves on the next microtask. */
function makeEffects() {
  const effects = {
    setStatus: vi.fn<VrLoadingHandoverEffects['setStatus']>(),
    fadeOut: vi.fn(() => Promise.resolve()),
    removeSplash: vi.fn(),
    revealScene: vi.fn(),
    warn: vi.fn(),
  }
  return effects
}

/** Run the pre-fade timer and let the fade promise settle. */
async function runFade(pauseMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(pauseMs)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('vrLoadingHandover — readiness path', () => {
  it('shows "Ready" at 100 %, fades once, and reveals the scene', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    h.onReadiness(LIVE)

    expect(fx.setStatus).toHaveBeenCalledExactlyOnceWith(t('vr.loading.ready'), 1)
    expect(fx.fadeOut).not.toHaveBeenCalled()
    await runFade(VR_LOADING_READY_PAUSE_MS)
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(fx.removeSplash).toHaveBeenCalledOnce()
    expect(fx.revealScene).toHaveBeenCalledOnce()
    expect(h.outcome).toBe('ready')
    expect(h.dataMissing).toBe(false)
  })

  it('does not arm the fallback once readiness already arrived synchronously', async () => {
    // Image / null / decoded video: setTexture reports before armFallback.
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.onReadiness(LIVE)
    h.armFallback()
    expect(vi.getTimerCount()).toBe(1) // just the pre-fade pause
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS * 2)
    expect(fx.warn).not.toHaveBeenCalled()
    expect(fx.setStatus).toHaveBeenCalledOnce()
    expect(fx.fadeOut).toHaveBeenCalledOnce()
  })

  it('makes the fallback do nothing when readiness arrived first', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS / 2)
    h.onReadiness(LIVE)
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS)
    expect(fx.warn).not.toHaveBeenCalled()
    expect(fx.setStatus).toHaveBeenCalledOnce()
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(h.outcome).toBe('ready')
  })

  it('ignores repeated readiness', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.onReadiness(LIVE)
    h.onReadiness(LIVE)
    await runFade(VR_LOADING_READY_PAUSE_MS)
    h.onReadiness(LIVE)
    expect(fx.setStatus).toHaveBeenCalledOnce()
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(fx.revealScene).toHaveBeenCalledOnce()
  })
})

describe('vrLoadingHandover — fallback', () => {
  it('fires at most once, with its own status rather than "Ready"', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    h.armFallback() // a second arm must not schedule a second timer

    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS - 1)
    expect(fx.warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(fx.warn).toHaveBeenCalledOnce()
    expect(fx.warn.mock.calls[0][0]).toContain(`${VR_LOADING_FALLBACK_MS / 1000}s`)
    expect(fx.setStatus).toHaveBeenCalledExactlyOnceWith(t('vr.loading.timedOut'))
    expect(fx.setStatus).not.toHaveBeenCalledWith(t('vr.loading.ready'), expect.anything())
    expect(h.outcome).toBe('timed-out')
    expect(h.dataMissing).toBe(true)

    await runFade(VR_LOADING_FAILED_PAUSE_MS)
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(fx.removeSplash).toHaveBeenCalledOnce()
    expect(fx.revealScene).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS * 3)
    expect(fx.warn).toHaveBeenCalledOnce()
    expect(fx.fadeOut).toHaveBeenCalledOnce()
  })

  it('does not fade again when readiness arrives late, but clears the hint', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS)
    await runFade(VR_LOADING_FAILED_PAUSE_MS)
    expect(h.dataMissing).toBe(true)

    h.onReadiness(LIVE)
    await vi.advanceTimersByTimeAsync(VR_LOADING_FAILED_PAUSE_MS * 2)
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(fx.revealScene).toHaveBeenCalledOnce()
    expect(fx.setStatus).toHaveBeenCalledOnce()
    expect(h.outcome).toBe('ready')
    expect(h.dataMissing).toBe(false)
  })

  it('is cancelled when the session ends first', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS / 2)
    h.end()
    expect(fx.removeSplash).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS * 2)
    expect(fx.warn).not.toHaveBeenCalled()
    expect(fx.setStatus).not.toHaveBeenCalled()
    expect(fx.fadeOut).not.toHaveBeenCalled()
    expect(fx.revealScene).not.toHaveBeenCalled()

    // Readiness after the end reaches nothing.
    h.onReadiness(LIVE)
    expect(fx.setStatus).not.toHaveBeenCalled()
  })
})

describe('vrLoadingHandover — failure outcome', () => {
  it('shows the failure status, not "Ready", and flags the data as missing', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    h.onReadiness(FAILED)

    expect(fx.setStatus).toHaveBeenCalledExactlyOnceWith(t('vr.loading.failed'))
    expect(h.outcome).toBe('failed')
    expect(h.dataMissing).toBe(true)

    // Held long enough to read before fading.
    await vi.advanceTimersByTimeAsync(VR_LOADING_READY_PAUSE_MS)
    expect(fx.fadeOut).not.toHaveBeenCalled()
    await runFade(VR_LOADING_FAILED_PAUSE_MS - VR_LOADING_READY_PAUSE_MS)
    expect(fx.fadeOut).toHaveBeenCalledOnce()
    expect(fx.revealScene).toHaveBeenCalledOnce()

    // The failure replaced the fallback.
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS)
    expect(fx.warn).not.toHaveBeenCalled()
    expect(fx.setStatus).toHaveBeenCalledOnce()
  })

  it('clears the hint when the element recovers or the next dataset goes live', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.onReadiness(FAILED)
    await runFade(VR_LOADING_FAILED_PAUSE_MS)
    h.onReadiness(FAILED) // a repeat error changes nothing
    expect(h.dataMissing).toBe(true)
    h.onReadiness(LIVE)
    expect(h.dataMissing).toBe(false)
    expect(fx.fadeOut).toHaveBeenCalledOnce()
  })

  it('upgrades a timeout to a failure if the video errors afterwards', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.armFallback()
    await vi.advanceTimersByTimeAsync(VR_LOADING_FALLBACK_MS)
    h.onReadiness(FAILED)
    expect(h.outcome).toBe('failed')
    expect(fx.setStatus).toHaveBeenCalledOnce()
  })
})

describe('vrLoadingHandover — session end', () => {
  it('cancels a pending pre-fade and removes the splash exactly once', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.onReadiness(LIVE)
    h.end()
    h.end()
    await vi.advanceTimersByTimeAsync(VR_LOADING_FAILED_PAUSE_MS)
    expect(fx.fadeOut).not.toHaveBeenCalled()
    expect(fx.revealScene).not.toHaveBeenCalled()
    expect(fx.removeSplash).toHaveBeenCalledOnce()
  })

  it('does not remove or reveal again when the session ends mid-fade', async () => {
    const fx = makeEffects()
    let finishFade!: () => void
    fx.fadeOut.mockImplementationOnce(() => new Promise<void>(r => { finishFade = r }))
    const h = createVrLoadingHandover(fx)
    h.onReadiness(LIVE)
    await vi.advanceTimersByTimeAsync(VR_LOADING_READY_PAUSE_MS)
    expect(fx.fadeOut).toHaveBeenCalledOnce()

    h.end()
    finishFade()
    await vi.advanceTimersByTimeAsync(0)
    expect(fx.removeSplash).toHaveBeenCalledOnce()
    expect(fx.revealScene).not.toHaveBeenCalled()
  })

  it('leaves nothing to do when it ends after the handover finished', async () => {
    const fx = makeEffects()
    const h = createVrLoadingHandover(fx)
    h.onReadiness(LIVE)
    await runFade(VR_LOADING_READY_PAUSE_MS)
    h.end()
    expect(fx.removeSplash).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
