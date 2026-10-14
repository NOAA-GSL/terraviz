// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The public SPA's read of this node's feature toggles
 * (`src/types/node-features.ts`), from the public
 * `GET /api/v1/node-profile` the blog boot and the portal chrome
 * already read.
 *
 * Most toggles need no client read at all: a disabled feature's
 * public endpoint answers empty and the surface that renders it
 * degrades on its own. `orbit` is the exception, because hiding Orbit
 * means not drawing the trigger and not starting the chat — including
 * the hands-free wake word, which opens the microphone — and the only
 * way to know that before drawing is to ask.
 *
 * **Fail-open, and bounded.** Every failure answers all-enabled: a
 * network error, a non-2xx, a body that is not the expected JSON, and
 * a request still outstanding when the wait's deadline passes. The
 * deadline is the wait's, not the request's — boot starts the request
 * at the top and waits for it only where the chat is set up, and the
 * catalog load in between must not count against it, or a slow but
 * working network would fail open. On the deadline the request is
 * aborted and the wait resolves without it, whether or not the fetch
 * layer honours the signal, so the answer boot acted on is the only
 * one and nothing can hold boot past it. The worst outcome is a
 * disabled Orbit offered to a page whose node did not answer in time;
 * its endpoints refuse it, which withdraws it (`orbitAvailability`),
 * and so does {@link watchForOrbitWithdrawal}'s next re-read.
 *
 * `no-store` on the request: the endpoint is served with a five-minute
 * `max-age`, and a browser holding an `orbit: true` from before the
 * operator turned it off would otherwise hand that back.
 *
 * `apiFetch` rather than `fetch`, so a desktop build asks the node it
 * is configured for rather than its own bundled `index.html`. Note
 * that `npm run dev` proxies `/api` to the production node, so a dev
 * server follows production's toggle unless `VITE_DEV_API_TARGET`
 * points elsewhere.
 */

import { defaultFeatures, normalizeFeatures, type FeatureMap } from '../types/node-features'
import { apiFetch } from './catalogSource'
import { withdrawOrbit, isOrbitWithdrawn, onOrbitWithdrawn } from './orbitAvailability'
import { logger } from '../utils/logger'

const NODE_PROFILE_PATH = '/api/v1/node-profile'

/** How long a caller waits for the toggles before assuming
 *  all-enabled, measured from the wait, not the request. */
export const NODE_FEATURES_TIMEOUT_MS = 3000

/** How often a page with Orbit on asks whether it still should be.
 *  Matches the server's cache TTL, which bounds propagation anyway. */
export const ORBIT_RECHECK_MS = 5 * 60_000

type FetchFn = (path: string, init?: RequestInit) => Promise<Response>

export interface NodeFeaturesOptions {
  fetchFn?: FetchFn
}

/** A read in flight. */
export interface PendingNodeFeatures {
  /**
   * The node's feature map, waiting at most `timeoutMs` **from this
   * call**. Never rejects. Idempotent: later calls return the first
   * call's answer, so every waiter acts on the same one.
   */
  settle(timeoutMs?: number): Promise<FeatureMap>
}

/** Start reading the toggles now; wait for them later. */
export function startNodeFeaturesRead(opts: NodeFeaturesOptions = {}): PendingNodeFeatures {
  const fetchFn = opts.fetchFn ?? apiFetch
  const controller = new AbortController()
  const read = (async (): Promise<FeatureMap> => {
    try {
      const res = await fetchFn(NODE_PROFILE_PATH, { signal: controller.signal, cache: 'no-store' })
      if (!res.ok) return defaultFeatures()
      const body = (await res.json()) as { features?: unknown } | null
      return normalizeFeatures(body?.features)
    } catch (err) {
      logger.debug('[nodeFeatures] read failed; treating every feature as enabled:', err)
      return defaultFeatures()
    }
  })()

  let settled: Promise<FeatureMap> | null = null
  return {
    settle(timeoutMs = NODE_FEATURES_TIMEOUT_MS) {
      settled ??= new Promise<FeatureMap>(resolve => {
        const timer = setTimeout(() => {
          controller.abort()
          resolve(defaultFeatures())
        }, timeoutMs)
        void read.then(features => {
          clearTimeout(timer)
          resolve(features)
        })
      })
      return settled
    },
  }
}

/** Read the toggles and wait for them — for a caller that has nothing
 *  to overlap the request with. Never rejects. */
export function fetchNodeFeatures(
  opts: NodeFeaturesOptions & { timeoutMs?: number } = {},
): Promise<FeatureMap> {
  return startNodeFeaturesRead(opts).settle(opts.timeoutMs)
}

/**
 * Re-read the toggles every {@link ORBIT_RECHECK_MS} while Orbit is on,
 * and withdraw it when the node says off. Without this, a page that
 * never reloads — a kiosk — keeps offering Orbit, and any hands-free
 * microphone, until a visitor's turn happens to be refused. Only a
 * definite `orbit: false` withdraws: every failure answers all-enabled,
 * so a network blip cannot take Orbit away. Stops itself once Orbit is
 * withdrawn by any path. Returns the stop.
 */
export function watchForOrbitWithdrawal(
  opts: NodeFeaturesOptions & { intervalMs?: number } = {},
): () => void {
  if (isOrbitWithdrawn()) return () => {}
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) return
    inFlight = true
    void fetchNodeFeatures(opts)
      .then(features => {
        if (!features.orbit) withdrawOrbit('recheck')
      })
      .finally(() => {
        inFlight = false
      })
  }, opts.intervalMs ?? ORBIT_RECHECK_MS)
  const unsubscribe = onOrbitWithdrawn(() => stop())
  function stop(): void {
    clearInterval(timer)
    unsubscribe()
  }
  return stop
}
