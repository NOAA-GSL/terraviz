// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The one-way handover from the immersive loading splash
 * (`vrLoading`) to the real globe + HUD.
 *
 * Readiness normally comes from the primary globe's `setTexture`
 * callback (`photorealEarth`), which reports either a live texture or
 * a video that failed. When neither ever arrives — an element that
 * never fires its events, a decode stalled behind a slow network — the
 * splash would otherwise stay in front of the globe for the whole
 * session, which reads as "the app is stuck on its splash" (or as two
 * spheres) with no way to tell it from a hang. A fallback timer
 * dismisses it after {@link VR_LOADING_FALLBACK_MS}.
 *
 * Only a live texture is reported as "Ready". A failure or the timeout
 * gets its own status, a longer pause so it can be read, and leaves
 * {@link VrLoadingHandover.dataMissing} set so the HUD can say the grey
 * placeholder Earth is not the data. A live texture arriving later
 * clears it; the splash is never faded twice.
 *
 * Kept free of Three.js and the session so the lifecycle can be pinned
 * with fake timers: every effect on the scene comes in as a callback.
 */

import { t } from '../i18n'
import type { TextureReadiness } from './photorealEarth'

/** How long the splash waits for readiness before dismissing itself. */
export const VR_LOADING_FALLBACK_MS = 10_000
/** Pause at "Ready" / 100 % before the fade, so completion registers. */
export const VR_LOADING_READY_PAUSE_MS = 250
/** Pause on a failure status before the fade — long enough to read it. */
export const VR_LOADING_FAILED_PAUSE_MS = 1500

/**
 * Where the handover stands.
 *
 *   `pending`   — splash up, waiting.
 *   `ready`     — a texture went live (possibly after a failure).
 *   `failed`    — the dataset's video reported an error.
 *   `timed-out` — nothing arrived within the fallback window.
 */
export type VrLoadingOutcome = 'pending' | 'ready' | 'failed' | 'timed-out'

export interface VrLoadingHandoverEffects {
  /**
   * Update the splash's status line, and its bar when `progress` is
   * given. Failure statuses omit it: a full bar reads as "done".
   */
  setStatus(status: string, progress?: number): void
  /** Fade the splash out; resolves when the fade has finished. */
  fadeOut(): Promise<void>
  /**
   * Remove and dispose the splash. Called exactly once — after the
   * fade, or from `end()` if the session ends first.
   */
  removeSplash(): void
  /** Show the globe + HUD. Called once after the fade, never after `end()`. */
  revealScene(): void
  /** Log line for the fallback firing. */
  warn(message: string): void
}

export interface VrLoadingHandover {
  /** Feed an outcome from the primary globe's `setTexture` `onReady`. */
  onReadiness(readiness: TextureReadiness): void
  /**
   * Start the fallback timer. A no-op once the handover has already
   * finished — `setTexture` reports images, `null` and decoded video
   * synchronously, before this is called.
   */
  armFallback(): void
  readonly outcome: VrLoadingOutcome
  /**
   * The splash was dismissed without the data on the globe, and no
   * live texture has arrived since. Drives the HUD hint.
   */
  readonly dataMissing: boolean
  /** Session ended: cancel timers and dispose the splash if it is still up. */
  end(): void
}

export function createVrLoadingHandover(effects: VrLoadingHandoverEffects): VrLoadingHandover {
  let outcome: VrLoadingOutcome = 'pending'
  let ended = false
  let splashRemoved = false
  let fallbackId: ReturnType<typeof setTimeout> | null = null
  /**
   * Captured so `end()` can cancel it if the user exits during the
   * pre-fade pause; otherwise it would fade a disposed splash.
   */
  let fadeId: ReturnType<typeof setTimeout> | null = null

  function clearFallback(): void {
    if (fallbackId !== null) {
      clearTimeout(fallbackId)
      fallbackId = null
    }
  }

  function removeSplashOnce(): void {
    if (splashRemoved) return
    splashRemoved = true
    effects.removeSplash()
  }

  /** Leave `pending` — runs at most once per session. */
  function finish(next: Exclude<VrLoadingOutcome, 'pending'>): void {
    outcome = next
    clearFallback()
    if (next === 'ready') effects.setStatus(t('vr.loading.ready'), 1)
    else if (next === 'failed') effects.setStatus(t('vr.loading.failed'))
    else effects.setStatus(t('vr.loading.timedOut'))
    fadeId = setTimeout(() => {
      fadeId = null
      if (ended) return
      void effects.fadeOut().then(() => {
        // `end()` during the fade already removed the splash, and
        // there is no scene left to reveal.
        if (ended) return
        removeSplashOnce()
        effects.revealScene()
      })
    }, next === 'ready' ? VR_LOADING_READY_PAUSE_MS : VR_LOADING_FAILED_PAUSE_MS)
  }

  return {
    onReadiness(readiness) {
      if (ended) return
      if (outcome === 'pending') {
        finish(readiness.ok ? 'ready' : 'failed')
      } else if (readiness.ok) {
        // Late arrival after a failure or the timeout: the texture is
        // on the globe now, so drop the hint — but don't fade again.
        outcome = 'ready'
      } else if (outcome === 'timed-out') {
        outcome = 'failed'
      }
    },

    armFallback() {
      if (ended || outcome !== 'pending' || fallbackId !== null) return
      fallbackId = setTimeout(() => {
        fallbackId = null
        if (ended || outcome !== 'pending') return
        effects.warn(
          `[VR] no texture readiness after ${VR_LOADING_FALLBACK_MS / 1000}s — dismissing the loading scene anyway`,
        )
        finish('timed-out')
      }, VR_LOADING_FALLBACK_MS)
    },

    get outcome() {
      return outcome
    },

    get dataMissing() {
      return outcome === 'failed' || outcome === 'timed-out'
    },

    end() {
      if (ended) return
      ended = true
      clearFallback()
      if (fadeId !== null) {
        clearTimeout(fadeId)
        fadeId = null
      }
      removeSplashOnce()
    },
  }
}
