// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Browser + filesystem primitives for the screenshot capture core.
 *
 * These were originally inlined in `../capture.ts` (the Weblate
 * capturer). They are extracted here unchanged so every consumer — the
 * Weblate capturer, the visual report, the regression differ, the smoke
 * runner — shares one implementation. `../capture.ts` re-exports the
 * pure helpers so its existing tests' import surface is preserved.
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import { parse, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Locator, type Page } from 'playwright'

import type { Box, Viewport } from './types'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
// core/ → screenshots/ → scripts/ → repo root
export const REPO_ROOT = resolve(HERE, '..', '..', '..')

/** Filesystem-safe slug for a dotted message key. */
export function slugKey(key: string): string {
  return key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
}

/** Pad a box by `pad` px and clamp it to the viewport. */
export function padClip(box: Box, pad: number, vp: Viewport): Box {
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  const right = Math.min(vp.width, box.x + box.width + pad)
  const bottom = Math.min(vp.height, box.y + box.height + pad)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/**
 * Parse a `WIDTHxHEIGHT` viewport string. Defaults to the
 * `SCREENSHOT_VIEWPORT` env var, then the desktop 1440x900 fallback, so
 * existing callers keep their behaviour; the general report passes
 * explicit strings to drive a multi-viewport matrix.
 */
export function parseViewport(
  raw: string = process.env.SCREENSHOT_VIEWPORT ?? '1440x900',
): Viewport {
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (!m) {
    throw new Error(`viewport must look like "1440x900", got "${raw}".`)
  }
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * Refuse to `rm -rf` a path that is the filesystem root, the repo root,
 * or an ancestor of it. Consumers wipe their output directory for a
 * clean slate, so a mistyped output dir (`/`, empty → cwd, a parent
 * dir) must not nuke real files.
 */
export function assertSafeOutDir(dir: string): void {
  const root = parse(dir).root
  const isAncestorOfRepo = `${REPO_ROOT}${sep}`.startsWith(`${dir}${sep}`)
  if (dir === root || dir === REPO_ROOT || isAncestorOfRepo) {
    throw new Error(
      `Refusing to delete output dir "${dir}": it is the filesystem ` +
        'root, the repo root, or an ancestor of it. Point it at a ' +
        'dedicated output directory.',
    )
  }
}

/**
 * Launch a headless Chromium for a capture run.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` overrides the browser binary. Playwright
 * resolves its default against the exact build its own version pins, so
 * a sandbox that ships a *different* Chromium build — as some
 * pre-provisioned dev containers do — fails to launch at all and the
 * only advertised fix is `npx playwright install`, which such an
 * environment usually cannot run. Pointing at the local binary is the
 * escape hatch. Unset in CI, where the pinned build is present, so the
 * gate keeps testing what it always tested.
 */
export function launchBrowser(opts: { args?: string[] } = {}): Promise<Browser> {
  // Trimmed, and empty falls back to Playwright's own resolution: an
  // env var templated to `""` or `" "` would otherwise be handed to
  // Playwright verbatim and fail to launch, which is a worse failure
  // than not setting it at all.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim() || undefined
  return chromium.launch({ args: opts.args, executablePath })
}

/**
 * Navigate to an app route, waiting only for `domcontentloaded` rather
 * than the full `load` event. The app is a long-lived WebGL surface that
 * keeps streaming external resources (GIBS map tiles, video) well after
 * it is interactive, so waiting for `load` flakily times out in CI.
 * Scenes and checks wait on their own readiness selectors after this.
 *
 * The catalog / globe routes are WebGL-heavy, and in a long-lived
 * capture browser (the Weblate capturer + the smoke suite both run many
 * scenes through one browser) accumulated GPU + dev-server pressure can
 * push the *initial* navigation past Playwright's default 30 s timeout —
 * an intermittent `page.goto: Timeout 30000ms exceeded` on
 * `/?catalog=true`. Use a longer ceiling and retry once: a stalled
 * first attempt almost always succeeds on a warm second try (module
 * transforms cached, transient contention passed).
 */
const GOTO_TIMEOUT_MS = 60_000

export async function gotoApp(page: Page, path: string): Promise<void> {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
  } catch (err) {
    if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
  }
  await settleBootSplash(page)
}

/**
 * Wait for boot to have finished, so the shot shows the app.
 *
 * Determinism is already handled — the context kills the splash's
 * transition, so no capture can catch a half-faded frame. What is left
 * is *usefulness*: a scene whose shutter opens before boot completes
 * photographs a splash screen, which is a stable and entirely useless
 * picture of the surface it claims to document.
 *
 * The signal is the `fade-out` class, not Playwright's `hidden`. With
 * the transition gone the app's `transitionend` handler never runs, so
 * the element settles at `opacity: 0` and stays `display: flex` —
 * invisible, but not `hidden` by Playwright's definition.
 *
 * Bounded and swallowed: boot genuinely does not finish offline for
 * some routes (the smoke suite's embed check stubs `/api/**` and
 * stalls there), and a splash is then the honest shot. Failing the
 * capture instead would turn "this page did not boot" into "there is
 * no screenshot", which is strictly less information.
 */
async function settleBootSplash(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const el = document.getElementById('loading-screen')
        if (!el) return true
        if (getComputedStyle(el).display === 'none') return true
        return el.classList.contains('fade-out')
      },
      undefined,
      { timeout: 10_000 },
    )
  } catch (err) {
    // **Only a timeout is swallowed.** A bare `catch` here also
    // swallowed a `TypeError` from calling a method the page object
    // does not have — which is exactly what `browser.test.ts`'s fake
    // Page was, so the helper threw on every unit test and the catch
    // hid it: the tests passed while never exercising this at all.
    // Caught in review, and it is the second time in this file that a
    // swallowed programming error looked like a working feature.
    if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
    // eslint-disable-next-line no-console
    console.warn('  boot never finished; this shot is of the splash screen')
  }
}

/** True when `url` is on the same origin as `baseURL`. Used to scope
 *  injected auth headers to the first party. Malformed URLs → false. */
export function isSameOrigin(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin
  } catch {
    return false
  }
}

/**
 * Run `fn` against a fresh page in its own context, always closing the
 * context afterward. Centralizes the per-scene lifecycle so every
 * consumer gets the same isolation (cookies, storage, init scripts) per
 * scene.
 */
export async function withScenePage<T>(
  browser: Browser,
  opts: {
    viewport: Viewport
    baseURL: string
    /** Headers (e.g. a Cloudflare Access service token) added **only**
     *  to first-party requests — same origin as `baseURL`. Never sent to
     *  third parties (tiles / CDNs / external APIs), so the token cannot
     *  leak cross-origin. */
    extraHTTPHeaders?: Record<string, string>
  },
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: opts.viewport,
    baseURL: opts.baseURL,
  })
  // Opt the capture browser out of telemetry before any page script
  // runs. A capture is not a user, so the events are junk data; more
  // practically, the emitter's batch beacon POSTs `/api/ingest`, which
  // no capture environment serves — it 403s against the dev server in
  // CI and aborts as the context tears down, and every scene that
  // lingers long enough to flush a batch was reported as a scene "with
  // problems". Seeded here rather than route-stubbed because the beacon
  // fires during pagehide, when the route handlers are already going
  // away. Mirrors the `off` tier in `src/analytics/config.ts`; an
  // unparseable or unknown value there falls back to `essential`, so
  // the shape has to match.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'off' }))
    } catch {
      // Storage unavailable — nothing to opt out of.
    }
  })
  // Remove the boot splash's fade rather than waiting it out.
  //
  // `#loading-screen` covers the viewport and leaves on an 0.8 s
  // opacity transition. `screenshotWithRetry` passes
  // `animations: 'disabled'`, which *freezes* a transition rather than
  // completing it — so a capture during that window is not a smear but
  // a **stable** frame of the whole page dimmed under a half-opaque
  // splash, pixel-identical every time it lands. That is what made
  // `browse-search-active` report exactly `2.03% (26340 px)` on
  // unrelated PRs, and `catalog-landing` 2.99% / 7.88%.
  //
  // Waiting for the splash to go was the first attempt and is the
  // weaker tool: it assumes boot always finishes, which is false
  // offline, and it cannot be shortened without reintroducing the
  // race. Deleting the transition removes the unstable state outright
  // — opacity is 1 or 0, nothing between, whenever the shutter opens.
  //
  // Consequence worth knowing: with no transition there is no
  // `transitionend`, so the app's own `display: none` handler never
  // runs and the splash finishes at `opacity: 0` while still
  // displayed. Visually identical, `pointer-events: none` either way —
  // but it is why `settleBootSplash` waits on the class rather than on
  // Playwright's `hidden`, which opacity alone does not satisfy.
  //
  // Passed as **source text, not a function**, and that is not a style
  // choice. `addInitScript` serialises a function argument and
  // evaluates the result in the page — but this file is compiled by
  // esbuild with `keepNames`, which rewrites a named inner function to
  // `__name(fn, 'fn')`. That helper exists in the bundle, never in the
  // page, so the injected script dies on `__name is not defined` and
  // takes every check in the smoke suite with it. A string cannot be
  // rewritten. (The telemetry script above survives only because it
  // declares no inner function.)
  //
  // Wrapped in an IIFE so re-injection cannot collide on a top-level
  // binding, and deferred to `DOMContentLoaded` when the document is
  // still parsing: an init script runs before the page's own scripts,
  // early enough that `document.head` *and* `documentElement` are both
  // null, so appending straight away throws.
  await context.addInitScript({
    content: `(() => {
      const inject = () => {
        const s = document.createElement('style')
        s.textContent = '#loading-screen { transition: none !important; }'
        ;(document.head || document.documentElement).appendChild(s)
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true })
      } else {
        inject()
      }
    })()`,
  })
  const headers = opts.extraHTTPHeaders
  if (headers && Object.keys(headers).length > 0) {
    // Scope the headers to the baseURL origin. Passing them to
    // newContext() would attach them to *every* request — including the
    // external tile/CDN hosts the app loads — leaking the secret.
    await context.route('**/*', async (route) => {
      const req = route.request()
      if (isSameOrigin(req.url(), opts.baseURL)) {
        await route.continue({ headers: { ...req.headers(), ...headers } })
      } else {
        await route.continue()
      }
    })
  }
  const page = await context.newPage()
  try {
    return await fn(page)
  } finally {
    await context.close()
  }
}

/**
 * Screenshot the page, retrying on failure.
 *
 * `animations: 'disabled'` freezes CSS animations/transitions so the
 * capture is stable. The retries absorb an intermittent compositor stall
 * — Playwright reports it as a misleading "waiting for fonts to load"
 * timeout even on pages with zero web fonts, and the same page
 * screenshots fine on the next attempt. It's most pronounced against a
 * live, continuously-rendering page (the WebGL globe's rAF loop + real
 * web fonts), so a *short* per-attempt timeout with *several* attempts
 * is faster than one long wait: a transient stall costs ~20s, not ~60s.
 * A transient-stall guard, not a correctness fix.
 *
 * `mask` paints the given locators with a solid colour so
 * non-deterministic regions (the WebGL globe, MapLibre tiles, a
 * force-directed graph) don't produce false positives in the regression
 * diff. Both baseline and current are masked identically, so the masked
 * area is byte-identical and contributes zero diff.
 */
export async function screenshotWithRetry(
  target: Page | Locator,
  path: string,
  extra: { mask?: Locator[] } = {},
): Promise<Buffer> {
  // Accepts a `Page` (full-viewport shot, supports `mask`) or a `Locator`
  // (element crop — `Locator.screenshot` has no `mask` option). Both get
  // the same animation-disable + retry treatment so crops are as stable
  // as full shots.
  const isPage = 'goto' in target
  const page = isPage ? target : target.page()
  const opts = isPage
    ? ({ path, animations: 'disabled', timeout: 20_000, ...extra } as const)
    : ({ path, animations: 'disabled', timeout: 20_000 } as const)
  // Escalating quiet-down before each retry. The short first pause
  // absorbs the common compositor stall; the later, longer waits ride
  // out a wedged renderer (`Protocol error (Page.captureScreenshot)`,
  // which CDP throws instantly, so no per-attempt timeout is paid) —
  // observed on CI to clear on its own within a few seconds, longer
  // than a run of short retries can span. Total retry window ≈ 9 s;
  // the happy path is unchanged.
  const RETRY_DELAYS_MS = [750, 2_500, 6_000] as const
  const attempts = RETRY_DELAYS_MS.length + 1
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await page.waitForTimeout(RETRY_DELAYS_MS[attempt - 2])
    try {
      return await target.screenshot(opts)
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn(`  screenshot attempt ${attempt}/${attempts} failed: ${msg}`)
    }
  }
  throw lastErr
}
