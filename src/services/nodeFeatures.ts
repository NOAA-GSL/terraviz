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
 * network error, a non-2xx, a body that is not the expected JSON (the
 * Vite dev server answers unknown paths with `index.html`), and a
 * request still outstanding after {@link NODE_FEATURES_TIMEOUT_MS}.
 * Boot awaits this before it starts the chat, so the timeout is what
 * keeps a slow endpoint from holding up the app; it is aborted rather
 * than left to land later, so the answer boot acted on is the only
 * one. The worst outcome is a disabled Orbit showing on a node whose
 * profile endpoint is down — and its endpoints refuse it server-side,
 * so it still costs no inference.
 *
 * `apiFetch` rather than `fetch`, so a desktop build asks the node it
 * is configured for rather than its own bundled `index.html`.
 */

import { defaultFeatures, normalizeFeatures, type FeatureMap } from '../types/node-features'
import { apiFetch } from './catalogSource'
import { logger } from '../utils/logger'

/** How long boot waits for the toggles before assuming all-enabled.
 *  The request starts at the top of boot and overlaps the catalog
 *  load, so in practice this is rarely waited on at all. */
export const NODE_FEATURES_TIMEOUT_MS = 3000

export interface FetchNodeFeaturesOptions {
  fetchFn?: (path: string, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/** This node's effective feature map. Never rejects. */
export async function fetchNodeFeatures(
  opts: FetchNodeFeaturesOptions = {},
): Promise<FeatureMap> {
  const fetchFn = opts.fetchFn ?? apiFetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? NODE_FEATURES_TIMEOUT_MS)
  try {
    const res = await fetchFn('/api/v1/node-profile', { signal: controller.signal })
    if (!res.ok) return defaultFeatures()
    const body = (await res.json()) as { features?: unknown } | null
    return normalizeFeatures(body?.features)
  } catch (err) {
    logger.debug('[nodeFeatures] read failed; treating every feature as enabled:', err)
    return defaultFeatures()
  } finally {
    clearTimeout(timer)
  }
}
