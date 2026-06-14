/**
 * Scene manifest for the Weblate screenshot pipeline.
 *
 * This is the one artifact a human maintains. Each scene is a stable
 * name plus an async `setup()` that drives the running app to a state
 * worth screenshotting. The capturer
 * (`scripts/screenshots/capture.ts`) handles the rest: it resets the
 * key trace, runs `setup()`, reads which i18n keys the scene
 * rendered (`window.__i18nTrace`), and screenshots the viewport.
 *
 * Keep scenes coarse — one per meaningful UI surface, ~15–25 total
 * at full coverage. The string→screenshot association falls out of
 * the capture automatically (via the `VITE_I18N_TRACE` hook in
 * `src/i18n/screenshotTrace.ts`); you never list individual keys
 * here.
 *
 * Prefer stable `#id` / role / text selectors over brittle CSS so a
 * styling change doesn't silently break a scene — and when a
 * selector *does* go stale, the capture step fails loudly in CI
 * rather than uploading a blank image.
 *
 * This is the **starter** set (phase S3). Broaden it to the full
 * high-traffic surface in S6. See
 * `docs/WEBLATE_SCREENSHOT_SYNC_PLAN.md`.
 */

import type { Page } from 'playwright'

export interface Scene {
  /** Stable id — used as the screenshot filename and Weblate name. */
  name: string
  /** Human-readable note for the manifest reviewer. */
  description: string
  /** Drive the app to the state to capture. */
  setup: (page: Page) => Promise<void>
}

/** Open the catalog landing surface (the Browse overlay). */
async function openCatalog(page: Page): Promise<void> {
  await page.goto('/?catalog=true')
  await page.locator('#browse-overlay').waitFor({ state: 'visible' })
  // Let the filter rail / grid paint before keys are read.
  await page.locator('#browse-toolbar').waitFor({ state: 'visible' })
}

/**
 * Open a publisher-portal route.
 *
 * The portal lives behind Cloudflare Access with a Pages-Functions
 * API backend — neither exists against a local dev server. What
 * *does* render without a backend is the part translators most need
 * context for: the topbar + section tabs, page headings, and (for
 * the static-form pages) field labels/placeholders. Every page
 * mounts its chrome synchronously before fetching data.
 *
 * Observed behaviour against the dev server (smoke-tested 2026-06-14):
 *   - `publish-dataset-new` renders its full static form (richest).
 *   - the data-backed list/detail pages (workflows, featured-hero,
 *     me, analytics, feedback, users) capture topbar chrome + a
 *     "Loading…" state — the fetch neither resolves nor errors into a
 *     card without a backend, so the error-card / populated strings
 *     are NOT captured here.
 *
 * Capturing those richer states (error cards, populated admin views)
 * needs a fixture session or a forced-failing fetch path — the
 * "fixture vs. live data" open question in the plan, wired in a later
 * phase. The chrome + nav strings captured here are already strictly
 * more context than today's empty Weblate screenshot field.
 */
async function openPublish(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.locator('#publisher-root .publisher-topbar').waitFor({ state: 'visible' })
}

export const scenes: Scene[] = [
  {
    name: 'catalog-landing',
    description: 'Dataset browser as the catalog landing surface, no filters applied',
    async setup(page) {
      await openCatalog(page)
    },
  },
  {
    name: 'browse-filters-open',
    description:
      'Browse overlay with the inline filter rail and an active facet filter applied',
    async setup(page) {
      await openCatalog(page)
      // At the capturer's 1440px desktop viewport the Cards view shows
      // the filter rail inline at every breakpoint; the small-screen
      // "Filters" drawer toggle (#browse-filters-btn) is display:none
      // here and only appears ≤1024px on the Graph/Timeline/Map views.
      // So drive the inline rail directly and activate the first facet
      // chip — that captures the rail plus the active-filter chrome.
      const rail = page.locator('#browse-filter-rail')
      await rail.waitFor({ state: 'visible' })
      await rail.locator('.browse-chip[data-facet]').first().click()
      await rail.locator('.browse-chip[aria-pressed="true"]').first().waitFor()
    },
  },
  {
    name: 'browse-search-active',
    description: 'Browse overlay with an active search query and the clear button shown',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-search').fill('ocean')
      // The clear button un-hides once the query is non-empty.
      await page.locator('#browse-search-clear:not(.hidden)').waitFor()
    },
  },
  {
    name: 'orbit-chat-open',
    description: 'Orbit (digital docent) chat panel opened from the browser',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-chat-btn').click()
      await page.locator('#chat-panel').waitFor({ state: 'visible' })
    },
  },
  {
    name: 'help-panel',
    description: 'Help & feedback panel (Guide tab + feedback form)',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#help-trigger-browse').click()
      await page.locator('#help-panel').waitFor({ state: 'visible' })
    },
  },
  {
    name: 'browse-graph-view',
    description: 'Browse overlay switched to the Graph view',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="graph"]').click()
      await page.locator('#browse-graph:not(.hidden)').waitFor()
    },
  },
  {
    name: 'browse-timeline-view',
    description: 'Browse overlay switched to the Timeline view',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="timeline"]').click()
      await page.locator('#browse-timeline:not(.hidden)').waitFor()
    },
  },
  {
    name: 'browse-map-view',
    description: 'Browse overlay switched to the Map (geographic coverage) view',
    async setup(page) {
      await openCatalog(page)
      await page.locator('#browse-view-mode [data-view-mode="map"]').click()
      await page.locator('#browse-map:not(.hidden)').waitFor()
    },
  },

  // ── Publisher portal ──────────────────────────────────────────
  // Chrome + forms + degraded states (no backend/auth locally). See
  // openPublish() above for why that's still useful translator context.
  {
    name: 'publish-datasets',
    description: 'Publisher portal — datasets list (chrome + empty/error state)',
    async setup(page) {
      await openPublish(page, '/publish/datasets')
    },
  },
  {
    name: 'publish-dataset-new',
    description: 'Publisher portal — new-dataset form (field labels & placeholders)',
    async setup(page) {
      await openPublish(page, '/publish/datasets/new')
    },
  },
  {
    name: 'publish-workflows',
    description: 'Publisher portal — Zyra workflows list',
    async setup(page) {
      await openPublish(page, '/publish/workflows')
    },
  },
  {
    name: 'publish-workflow-new',
    description: 'Publisher portal — new-workflow form (YAML editor + validate)',
    async setup(page) {
      await openPublish(page, '/publish/workflows/new')
    },
  },
  {
    name: 'publish-tours',
    description: 'Publisher portal — tour-creator landing page',
    async setup(page) {
      await openPublish(page, '/publish/tours')
    },
  },
  {
    name: 'publish-import',
    description: 'Publisher portal — import page',
    async setup(page) {
      await openPublish(page, '/publish/import')
    },
  },
  {
    name: 'publish-featured-hero',
    description: 'Publisher portal — "Right now" featured-hero override',
    async setup(page) {
      await openPublish(page, '/publish/featured-hero')
    },
  },
  {
    name: 'publish-me',
    description: 'Publisher portal — current-user identity & role',
    async setup(page) {
      await openPublish(page, '/publish/me')
    },
  },

  // ── Admin-only surfaces ───────────────────────────────────────
  // Privileged tabs; chrome + headings + degraded states without an
  // authenticated session. Populated data views come with the
  // fixture session in a later phase.
  {
    name: 'admin-analytics',
    description: 'Admin — analytics dashboard chrome (charts need a fixture session)',
    async setup(page) {
      await openPublish(page, '/publish/analytics')
    },
  },
  {
    name: 'admin-feedback',
    description: 'Admin — feedback review chrome (AI thumbs + bug/feature reports)',
    async setup(page) {
      await openPublish(page, '/publish/feedback')
    },
  },
  {
    name: 'admin-users',
    description: 'Admin — Users tab (approve / reject / suspend / role controls)',
    async setup(page) {
      await openPublish(page, '/publish/users')
    },
  },
]
