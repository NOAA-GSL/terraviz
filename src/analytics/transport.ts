// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Telemetry transport — the POST side of the emitter.
 *
 * Separated from emitter.ts so the queueing logic stays focused on
 * state and the network layer is trivially mockable from tests. The
 * emitter imports the `Transport` interface and either gets a real
 * one from `createFetchTransport()` at app init or a mock from a
 * test setup.
 *
 * Three responsibilities:
 *
 *  1. Send a batch to `/api/ingest` via `fetch()` — uses the Tauri
 *     HTTP plugin when available (CORS-free on the desktop webview),
 *     falls back to native `fetch()` on the web.
 *  2. Unload-time flush via `navigator.sendBeacon()` — the one API
 *     that reliably delivers a POST as the page is closing.
 *  3. Offline queue persistence — on Tauri, if a send fails we
 *     persist the queue under `sos-telemetry-queue` so the next
 *     launch can replay. Web relies on `sendBeacon()` instead.
 *
 * Response semantics (mirrors functions/api/ingest.ts):
 *   204  accepted — drop locally, reset backoff
 *   410  kill switch on — permanent for the session, stop trying
 *   429  rate limited — retryable with backoff
 *   5xx  server error — retryable with backoff
 *   4xx  other — drop the batch (malformed / unauthorized origin)
 *   network error → retryable (offline, DNS, TLS, etc.)
 */

import { getApiOrigin } from '../config/endpoints'
import type { TelemetryEvent } from '../types'

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

/**
 * Ingest path, relative to whichever origin `defaultEndpoint()` picks.
 *
 * Relative is the right answer on the web and only on the web: the
 * Pages Function that serves it is part of the same deploy that served
 * the page, so a fork reports to itself with no configuration at all.
 */
export const DEFAULT_ENDPOINT = '/api/ingest'

/**
 * Where a batch actually goes.
 *
 * **On desktop this must be absolute, and until this landed it was
 * not.** The docstring above `DEFAULT_ENDPOINT`
 * used to claim the endpoint was "absolute on Tauri because the
 * webview origin is not the Pages deploy. Callers can override via
 * `createFetchTransport({ endpoint })`" — a true description of a
 * requirement that nothing implemented and no caller ever met. A
 * desktop webview is served from `tauri://localhost/`, so the relative
 * path either fails to parse as a URL inside the Rust HTTP plugin
 * (caught below, classified retryable, retried forever with backoff
 * and persisted to localStorage between launches) or resolves to the
 * bundled `index.html`. Either way no row has ever reached Analytics
 * Engine from a desktop build.
 *
 * The origin comes from `getApiOrigin()` — the same resolution
 * `/api/v1/*` already uses, rather than a second variable meaning the
 * same thing. A node that followed `docs/SELF_HOSTING.md` §15.3 and
 * set `VITE_API_ORIGIN` therefore gets working desktop telemetry with
 * no further action, and one that did not sends it to the same place
 * its catalog reads already go. That default is worth being explicit
 * about: an un-configured fork's desktop build reports to upstream.
 * It is the existing behaviour of every other `/api/` call rather than
 * a new exposure, and §15.3 is the one place that tells an operator to
 * fix it — but it is a default, not a design, and the fix is one
 * build-time variable.
 *
 * Resolved per call rather than captured at module load for
 * `catalogSource`'s reason: a test needs to flip `window.__TAURI__`
 * between cases without re-importing the module.
 *
 * **This fixes the URL and does not by itself prove a row lands.**
 * `functions/api/ingest.ts` 403s any request whose `Origin` it does
 * not recognise, and a 403 is classified non-retryable and dropped.
 * `tauri://localhost` and its Windows variants are in that allowlist,
 * so a desktop request is accepted *if* it carries the header — but
 * this path goes through the Tauri HTTP plugin, which issues from
 * Rust rather than from the webview, and whether it forwards an
 * `Origin` has not been checked against a live deploy. That is one
 * observation away, and if it does not, the fix is one entry in
 * `ALLOWED_ORIGINS` rather than anything here.
 */
function defaultEndpoint(): string {
  if (!isTauri()) return DEFAULT_ENDPOINT
  return `${getApiOrigin()}${DEFAULT_ENDPOINT}`
}

/** localStorage key used by the offline persistence layer. Exposed
 * so tests can clear / inspect it without reaching into internals. */
export const PERSISTED_QUEUE_KEY = 'sos-telemetry-queue'

/** Upper bound on how many events we retain across a crash. Bumping
 * every event through localStorage is cheap but unbounded growth
 * isn't — a one-off backend outage shouldn't turn a long session
 * into a multi-megabyte persisted queue. */
export const MAX_PERSISTED_EVENTS = 500

/** Resolved per call, not captured at module load, so a test can flip
 *  `window.__TAURI__` between cases — the same reasoning
 *  `catalogSource.isTauri()` documents. */
function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI__?: unknown }).__TAURI__
  )
}

// ---------------------------------------------------------------
// Lazy Tauri fetch — same pattern as llmProvider.ts
// ---------------------------------------------------------------

let tauriFetcherPromise: Promise<typeof globalThis.fetch | null> | null = null

function getTauriFetcher(): Promise<typeof globalThis.fetch | null> {
  if (!isTauri()) return Promise.resolve(null)
  if (!tauriFetcherPromise) {
    tauriFetcherPromise = import('@tauri-apps/plugin-http')
      .then((m) => m.fetch as typeof globalThis.fetch)
      .catch(() => null)
  }
  return tauriFetcherPromise
}

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SendResult {
  /** HTTP status code, or null on network / transport failure. */
  status: number | null
  /** Accepted by the server — safe to drop the batch locally. */
  ok: boolean
  /** Caller should re-queue the events for a later attempt. */
  retryable: boolean
  /** Session-long cooldown requested (410). Caller should stop
   * attempting sends until the app is relaunched. */
  permanent: boolean
}

export interface Transport {
  /** Async POST. Returns a classification the emitter maps into
   * queue / cooldown / backoff actions. */
  send(sessionId: string, events: TelemetryEvent[]): Promise<SendResult>
  /** Unload-time POST via `navigator.sendBeacon()`. Returns whether
   * the browser accepted the beacon — `false` means the emitter
   * should fall back to persisting the queue. */
  sendBeacon(sessionId: string, events: TelemetryEvent[]): boolean
  /** Endpoint URL used by this transport — exposed for logging
   * and tests. */
  readonly endpoint: string
}

export interface TransportOptions {
  endpoint?: string
  /** Override the underlying fetch implementation. Used in tests. */
  fetchImpl?: typeof globalThis.fetch
  /** Override `navigator.sendBeacon`. Used in tests. */
  beaconImpl?: (url: string, body: BodyInit) => boolean
}

// ---------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------

/**
 * Build a real network transport. Safe to call at app init — the
 * Tauri HTTP plugin import is deferred until the first `send()`
 * call, so web builds never touch it.
 */
export function createFetchTransport(options: TransportOptions = {}): Transport {
  const endpoint = options.endpoint ?? defaultEndpoint()

  async function send(
    sessionId: string,
    events: TelemetryEvent[],
  ): Promise<SendResult> {
    if (events.length === 0) {
      return { status: 204, ok: true, retryable: false, permanent: false }
    }
    const body = JSON.stringify({ session_id: sessionId, events })
    let resp: Response
    try {
      const fetcher =
        options.fetchImpl ?? (await getTauriFetcher()) ?? globalThis.fetch
      resp = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        // `same-origin`, not `omit`: a node whose hostname sits
        // behind Cloudflare Access answers an uncredentialed
        // `/api/ingest` POST with a 302 to the login origin, which
        // sends no `Access-Control-Allow-Origin` — so the send fails
        // as a CORS error and retries forever. This does not widen
        // what the server sees: `functions/api/ingest.ts` reads
        // `Origin`, `Content-Length`, `CF-Connecting-IP` and
        // `CF-IPCountry` and never looks at a cookie. Nor does it
        // leak cross-origin — `same-origin` withholds cookies from
        // an absolute `endpoint` override exactly as `omit` did,
        // which is the Tauri case. `sendBeacon()` below has always
        // sent them; this makes the two paths agree.
        credentials: 'same-origin',
        keepalive: true,
      })
    } catch {
      // Network-level failure (offline, DNS, TLS, CORS, etc.) — retryable.
      return { status: null, ok: false, retryable: true, permanent: false }
    }
    return classifyResponse(resp.status)
  }

  function sendBeacon(
    sessionId: string,
    events: TelemetryEvent[],
  ): boolean {
    if (events.length === 0) return true
    const beacon = options.beaconImpl ?? navigatorBeacon()
    if (!beacon) return false
    try {
      const body = new Blob(
        [JSON.stringify({ session_id: sessionId, events })],
        { type: 'application/json' },
      )
      return beacon(endpoint, body)
    } catch {
      return false
    }
  }

  return { send, sendBeacon, endpoint }
}

/** Map an HTTP status code to a SendResult. Exposed for tests. */
export function classifyResponse(status: number): SendResult {
  if (status === 204) {
    return { status, ok: true, retryable: false, permanent: false }
  }
  if (status === 410) {
    return { status, ok: false, retryable: false, permanent: true }
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return { status, ok: false, retryable: true, permanent: false }
  }
  // Any other 4xx (400 invalid body, 403 origin, 413 too large) —
  // dropping the batch is safer than retrying a malformed payload.
  return { status, ok: false, retryable: false, permanent: false }
}

function navigatorBeacon():
  | ((url: string, body: BodyInit) => boolean)
  | null {
  if (typeof navigator === 'undefined') return null
  if (typeof navigator.sendBeacon !== 'function') return null
  return navigator.sendBeacon.bind(navigator)
}

// ---------------------------------------------------------------
// Offline queue persistence (Tauri-only safety net)
// ---------------------------------------------------------------

/** Persist the current queue to localStorage so the next launch can
 * replay after a crash / force-quit on desktop. No-op on web because
 * `sendBeacon()` handles the tab-close case there. */
export function persistQueue(events: readonly TelemetryEvent[]): void {
  if (typeof localStorage === 'undefined') return
  if (!shouldPersist()) return
  try {
    if (events.length === 0) {
      localStorage.removeItem(PERSISTED_QUEUE_KEY)
      return
    }
    const clipped =
      events.length > MAX_PERSISTED_EVENTS
        ? events.slice(-MAX_PERSISTED_EVENTS)
        : events
    localStorage.setItem(PERSISTED_QUEUE_KEY, JSON.stringify(clipped))
  } catch {
    // Quota / private-mode failures are non-fatal — we'd rather drop
    // the persisted copy than crash the emitter.
  }
}

/** Read and remove any previously-persisted queue. Defensive against
 * malformed JSON (returns `[]`) so a corrupted entry cannot poison
 * the emitter at startup. */
export function hydrateQueue(): TelemetryEvent[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(PERSISTED_QUEUE_KEY)
    if (!raw) return []
    localStorage.removeItem(PERSISTED_QUEUE_KEY)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is TelemetryEvent =>
        !!e && typeof e === 'object' && typeof (e as { event_type?: unknown }).event_type === 'string',
    )
  } catch {
    try {
      localStorage.removeItem(PERSISTED_QUEUE_KEY)
    } catch {
      // ignore
    }
    return []
  }
}

/** Explicit clear. Called on successful send and on 410. */
export function clearPersistedQueue(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(PERSISTED_QUEUE_KEY)
  } catch {
    // ignore
  }
}

/** Exposed for tests to force persistence on / off regardless of
 * the runtime `isTauri()` detection. */
let persistOverride: boolean | null = null
export function __setPersistOverrideForTests(v: boolean | null): void {
  persistOverride = v
}

function shouldPersist(): boolean {
  return persistOverride ?? isTauri()
}
