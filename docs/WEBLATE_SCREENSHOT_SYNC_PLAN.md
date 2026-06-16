# Weblate Screenshot Sync — Planning Document

**Status:** draft for review
**Date:** 2026-06-14
**Owner:** Eric Hackathorn

## Context

Weblate lets a maintainer attach **screenshots** to source
strings. In the translator editor, a screenshot showing the
string *in situ* answers the questions a glossary entry can't:
How much space does this label have? Is "Load" a button or a
column header? Does this `{count}` sit next to a number or inside
a sentence? Good screenshots measurably cut mistranslations on
short, ambiguous UI strings — exactly the kind this app is full
of (`browse.card.load`, `browse.card.meta.added`,
`tools.toggle.labels`).

Today that field is empty, and the obvious way to fill it — a
human screenshotting each screen and hand-associating strings in
the Weblate UI — does not survive contact with development. We
ship UI continuously; a manually curated screenshot set is stale
the week after it's made, and nobody re-does it. The string
context that *is* automated, the per-string **Explanation** field
(`locales/_explanations.json` → Weblate via
[`scripts/sync-weblate-metadata.ts`](../scripts/sync-weblate-metadata.ts)
and [`.github/workflows/sync-weblate.yml`](../.github/workflows/sync-weblate.yml)),
stays fresh precisely *because* it's a CI job keyed off the repo.

This document plans a screenshot pipeline that follows that same
discipline: screenshots are **generated from the running app in
CI** and **pushed to Weblate via its REST API**, so they track
development instead of decaying away from it.

This plan pairs with [`I18N_PLAN.md`](I18N_PLAN.md) (the L1/L1.5
i18n foundation it builds on) and reuses the Weblate-token plumbing
already established for the Explanation sync.

---

## What Weblate gives us to work with

The Weblate REST API has a first-class screenshots surface:

| Endpoint | Use |
|---|---|
| `GET /api/screenshots/` | List existing screenshots (for idempotent reconcile). |
| `POST /api/screenshots/` | Create a screenshot: `name`, `image` (multipart file), `translation` (URL of the **source / `en`** translation). |
| `GET /api/screenshots/{id}/` | Read one (name, image hash, associated units). |
| `PUT/PATCH /api/screenshots/{id}/file/` | Replace the image of an existing screenshot. |
| `POST /api/screenshots/{id}/units/` | Associate a source **unit** (by id) with the screenshot. |
| `DELETE /api/screenshots/{id}/units/{unit_id}/` | Drop a stale association. |

Two facts shape the whole design:

1. **Association is by unit, and units are keyed by `context`.**
   The existing sync already relies on this: a Weblate unit's
   `context` field is our flat locale key (`browse.card.load`).
   We resolve `key → unit.id` exactly as
   `sync-weblate-metadata.ts` does today (`fetchSourceUnits()` →
   `Map<context, unit>`). The screenshot uploader can import the
   same helper rather than re-deriving it.

2. **Weblate offers OCR auto-association, but we won't rely on
   it.** Weblate can scan an uploaded image and guess which
   strings appear in it. That's lossy for short labels, icon
   buttons, and `aria-label`-only strings (which have *no* visible
   text at all). We have something far better than OCR: the app
   *knows* which keys it rendered. We associate explicitly from
   that ground truth.

---

## Design Goals

1. **Tracks development automatically.** The same property that
   keeps the Explanation field fresh: a maintainer changes the UI,
   CI regenerates and re-pushes. No human in the screenshot loop.
2. **Ground-truth association, not OCR.** Each screenshot is
   linked to the *exact* set of keys the app rendered while it was
   captured — including invisible `aria-*` strings, which are the
   ones translators most need help with.
3. **Idempotent and cheap to re-run.** Like the Explanation sync:
   skip screenshots whose image and associations are unchanged.
   Re-running on every push must be safe and mostly a no-op.
4. **Curate scenes, not strings.** A human maintains a short list
   of *scenes* ("Browse overlay, open, default filters"), never a
   string→image spreadsheet. String association falls out of the
   capture automatically.
5. **Zero impact on the shipped app.** All instrumentation is
   behind a build-time flag (the `VITE_TELEMETRY_*` precedent) and
   tree-shakes out of production bundles entirely.
6. **Reuse, don't reinvent.** Token plumbing, the unit-resolution
   helper, the idempotent-reconcile shape, and the workflow
   skeleton all already exist for the Explanation sync. This is a
   sibling of that job, not a new philosophy.

---

## Non-Goals

- **100% string coverage.** Screenshots are best-effort context,
  not a gate. Strings that never appear in a captured scene (deep
  error states, desktop-only keychain dialogs, rarely-hit toasts)
  simply have no screenshot. We report coverage; we do not fail CI
  on it.
- **Per-locale screenshots.** Screenshots attach to the **source**
  unit and are shared across all target languages, matching how
  the Explanation field works. We capture the `en` UI only.
- **Pixel-diff visual regression.** This pipeline exists to inform
  translators, not to catch UI regressions. If we later want
  visual-regression testing, it can share the Playwright harness
  but is out of scope here.
- **Translating screenshot *content*** (e.g. dataset titles inside
  the globe view). Those are catalog data, not UI strings, and are
  L3 territory in [`I18N_PLAN.md`](I18N_PLAN.md).
- **Capturing the desktop (Tauri) or VR surfaces.** Web SPA only
  in this phase; the WebXR and native shells can be added later as
  additional scene sources if the value justifies the harness
  cost.

---

## Architecture

Four pieces, three of them new:

```
┌─────────────────────┐   build flag    ┌──────────────────────┐
│  i18n runtime t()   │───VITE_I18N_────▶│  key-trace recorder  │
│  (src/i18n/index.ts)│      TRACE       │  window.__i18nTrace  │
└─────────────────────┘                  └──────────┬───────────┘
                                                     │ read per scene
┌─────────────────────┐   drives         ┌──────────▼───────────┐
│  scenes manifest    │─────scenes──────▶│  Playwright capturer  │
│ scripts/screenshots/│                  │  (headless Chromium)  │
│   scenes.ts         │                  └──────────┬───────────┘
└─────────────────────┘                             │ {png, keys[]}
                                                     │ per scene
                                          ┌──────────▼───────────┐
                                          │  Weblate uploader     │
                                          │  (REST, idempotent)   │
                                          └───────────────────────┘
```

### 1. Key-trace instrumentation (`src/i18n/index.ts`)

The single choke point for *every* resolved string is already
`t()` ([`src/i18n/index.ts:95`](../src/i18n/index.ts)). All the
attribute-escaping variants (`tHtml`, `tAttr`) and the static-
markup walker (`applyI18nAttributes.ts`) funnel through it. So one
hook captures everything — visible text, `aria-label`s, button
labels set via `textContent`, the lot — with **zero call-site
changes**.

Behind a Vite flag (`import.meta.env.VITE_I18N_TRACE`), `t()`
records each resolved key into a module-level `Set` and mirrors it
to `window.__i18nTrace` so Playwright can read it from the page
context:

```ts
// Sketch — gated so it tree-shakes out of production.
export function t<K extends MessageKey>(key: K, params?: …): string {
  if (import.meta.env.VITE_I18N_TRACE) recordKey(key as string)
  // …existing body unchanged…
}
```

The recorder also exposes `window.__i18nTrace.reset()` so the
capturer can clear the set between scenes and attribute keys to
the scene that actually rendered them.

**Why a per-scene Set and not per-DOM-node mapping?** Viewport-
precise association (this key is *this* pixel) would need every
`t()` call site to stamp its key onto a DOM node — invasive and
incomplete (many strings are `aria` attributes with no element of
their own). The Set approach says "these keys appeared on the
Browse screen," which is exactly the context a translator wants
and costs nothing at the call sites. We can layer viewport
precision on later for static `data-i18n` markup, which *already*
carries its key in the DOM.

### 2. Scenes manifest (`scripts/screenshots/scenes.ts`)

The one artifact a human maintains. Each scene is a name plus an
async setup function that navigates the app to a state worth
screenshotting:

```ts
export const scenes: Scene[] = [
  {
    name: 'browse-overlay-default',
    description: 'Dataset browser, open, no filters applied',
    async setup(page) {
      await page.goto('/?catalog=true')
      await page.getByRole('button', { name: /browse/i }).click()
      await page.waitForSelector('#browse-overlay:not(.collapsed)')
    },
  },
  // tools popover, info panel, Orbit chat, playback transport, …
]
```

Scenes are deliberately coarse — one per meaningful UI surface,
~15–25 total to start, covering the high-traffic modules in the
[CLAUDE.md](../CLAUDE.md) module map (`browseUI`, `toolsMenuUI`,
`chatUI`, `playbackController`, `datasetLoader` info panel,
`helpUI`, `privacyUI`, the catalog Graph/Map/Timeline views). The
manifest is the thing reviewers eyeball in a PR; keeping it small
and declarative is the point.

### 3. Playwright capturer (`scripts/screenshots/capture.ts`)

Headless Chromium against a locally-served production-style build
(`vite preview`, or `vite dev` with the trace flag). For each
scene:

1. `await page.evaluate(() => window.__i18nTrace.reset())`
2. `await scene.setup(page)`
3. `const keys = await page.evaluate(() => [...window.__i18nTrace.seen])`
4. `await page.screenshot({ path: out/<scene.name>.png })`

Emits a manifest `out/screenshots.json`:
`[{ name, file, sha256, keys: [...] }]`. The SHA is what makes the
upload step idempotent (see below).

Playwright is the **one new dependency** of consequence. The repo
has no browser-automation tooling today (confirmed: no Playwright/
Puppeteer/Cypress in `package.json`), so this is a deliberate
addition — installed as a `devDependency`, with the browser
binary fetched in CI via `npx playwright install --with-deps
chromium` (Chromium only, to keep the cache small).

### 4. Weblate uploader (`scripts/sync-weblate-screenshots.ts`)

A sibling of `sync-weblate-metadata.ts`, reusing its token
handling and unit-resolution. Algorithm:

1. Resolve `key → unit.id` via the existing `fetchSourceUnits()`
   pattern (refactor that helper into a shared
   `scripts/weblate-client.ts` so both syncs import it — see
   *Refactor* below).
2. `GET /api/screenshots/` and index existing screenshots by
   `name` (we name each after its scene).
3. For each scene in `out/screenshots.json`:
   - **New scene** → `POST` the image, then `POST` each resolved
     unit to `…/units/`.
   - **Existing, image SHA changed** → replace via
     `…/file/`, then reconcile unit associations (add new keys,
     remove keys no longer present).
   - **Existing, image and key set unchanged** → skip (the common
     case on re-run; this is what makes the job cheap).
4. Warn-don't-fail on keys with no matching Weblate unit (same
   posture as the Explanation sync: usually means Weblate hasn't
   pulled latest `main` yet).

Idempotency state lives entirely in Weblate (image hash +
association set), so no extra state file in the repo — mirroring
how the Explanation sync derives everything from the live unit
list.

### Refactor: shared Weblate client

`fetchSourceUnits()`, `authHeaders()`, and the project/component/
URL config currently live inside `sync-weblate-metadata.ts`.
Extract them to `scripts/weblate-client.ts` so the screenshot sync
reuses identical auth, pagination, and `key → unit` resolution.
This is a small, behaviour-preserving lift done in its own commit
before the new script lands, so the existing Explanation sync's
diff stays reviewable.

---

## CI integration

A new workflow, `.github/workflows/sync-weblate-screenshots.yml`,
modelled on `sync-weblate.yml` but heavier (it builds the app and
runs a browser), so its triggers are more conservative:

| Trigger | Rationale |
|---|---|
| `workflow_dispatch` | Always available for one-off refreshes. |
| `schedule` (weekly) | Catches drift without taxing every push. |
| `push` to `main` paths: `src/ui/**`, `src/i18n/**`, `locales/en.json`, `scripts/screenshots/**` | Only when something that could change a screenshot actually moves. |

Deliberately **not** on every PR: capturing 20 scenes in a
browser is minutes, not seconds, and we don't want to push
screenshots from un-merged branches into Weblate. PRs can run the
*capture* step (producing artifacts for review) without the
*upload* step; only `main` uploads.

Permissions stay minimal (`contents: read`), token via the
existing `WEBLATE_TOKEN` secret, `concurrency: sync-weblate-
screenshots` with `cancel-in-progress: false` — all carried over
from the Explanation workflow's hardening.

Job shape:

```yaml
- npm ci
- npx playwright install --with-deps chromium
- npm run build                       # production-style bundle
- VITE_I18N_TRACE=true npm run preview &   # serve with trace hook
- npm run screenshots:capture         # → out/screenshots.json + PNGs
- npm run screenshots:sync            # upload (main only)
  env: { WEBLATE_TOKEN: ${{ secrets.WEBLATE_TOKEN }} }
```

New npm scripts (mirroring the `sync:weblate` naming):

| Script | What it does |
|---|---|
| `screenshots:capture` | `tsx scripts/screenshots/capture.ts` |
| `screenshots:sync` | `tsx scripts/sync-weblate-screenshots.ts` |

---

## Phasing

Each phase is independently shippable and committed on its own,
per the repo's one-logical-change-per-turn discipline.

| Phase | Deliverable | Gate |
|---|---|---|
| **S1** | Trace hook in `t()` behind `VITE_I18N_TRACE`; unit test that the flag is off in a normal build and on under the flag. No CI yet. | — |
| **S2** | `scripts/weblate-client.ts` refactor; `sync-weblate-metadata.ts` switched to it (pure refactor, sync behaviour unchanged). | S1 |
| **S3** | Playwright devDependency + capturer + a *starter* `scenes.ts` (3–4 scenes: Browse, Tools, Info panel, Orbit). Output reviewable locally as artifacts; no Weblate writes. | S2 |
| **S4** | `sync-weblate-screenshots.ts` uploader (idempotent reconcile). Run manually against Weblate once, by hand, to validate the association model end-to-end before automating. | S3 |
| **S5** | `sync-weblate-screenshots.yml` workflow (dispatch + schedule + scoped `main` push). Capture-only on PRs. | S4 |
| **S6** | Broaden `scenes.ts` to the full high-traffic surface (~15–25 scenes); add a non-failing coverage report (`keys-with-screenshot / total keys`). | S5 |
| **S7** | Per-string **close-up crops**: a tight, padded crop of each visible `data-i18n*` element, uploaded as that string's own screenshot alongside the full-scene shot. The translator's "zoom in on the pertinent section." | S6 |

S1–S2 are safe to land immediately and carry no external side
effects. S4 is the first phase that writes to Weblate and should
be validated by hand before S5 automates it.

**Implementation status (this branch).** S1–S7 are all implemented:
the `VITE_I18N_TRACE` hook (`src/i18n/screenshotTrace.ts`), the
shared `scripts/weblate-client.ts`, the Playwright capturer +
`scripts/screenshots/scenes.ts` (19 scenes incl. the publisher
portal and admin tabs) **with per-string close-up crops (S7)**, the
idempotent `scripts/sync-weblate-screenshots.ts` uploader
(`--dry-run` supported), the `sync-weblate-screenshots.yml`
workflow, and the coverage report
(`scripts/screenshots/coverage.ts`). Everything is
verified by unit tests + type-check; the **one outstanding gate is
the S4 hand-validation** — a real headless-browser capture + a live
Weblate round-trip — which needs a session whose network policy
allows the Playwright browser CDN (and, for populated screenshots,
the app's catalog/tile hosts). Until that runs, scene selectors are
grounded in the current `index.html` / UI source but not yet
confirmed against the rendered DOM.

Two refinements made during implementation, noted so the doc
matches the code:

- **Coverage lives in the capturer, not the uploader.** It runs on
  PRs (where capture runs but upload does not) and needs no Weblate
  token, so PR reviewers see coverage. It prints a console line and,
  in CI, writes a `$GITHUB_STEP_SUMMARY` block.
- **Mobile is a cheap second pass, not a second code path.** The
  capturer honours `SCREENSHOT_VIEWPORT` + `SCREENSHOT_NAME_SUFFIX`
  + `SCREENSHOT_OUT_DIR`, so a mobile set
  (`…VIEWPORT=390x844 …NAME_SUFFIX=-mobile …OUT_DIR=…-mobile`)
  produces distinct, non-colliding Weblate screenshots without
  touching the manifest shape or the uploader. The workflow stays
  desktop-only for now; adding the mobile pass is a few workflow
  lines when wanted.

---

## S7 — Per-string close-up crops

**Motivation.** With S1–S6, every string a scene renders is
associated to that scene's *full* screenshot. Useful, but a
translator editing `browse.card.load` sees the whole Browse screen
and has to find the "Load" button in it. They'd rather see the
button.

**What Weblate does *not* give us.** Weblate's only native
per-string highlight is **OCR-based** — its "Find strings in image"
button scans the image and matches source text to regions. There is
**no coordinate/bounding-box field on the screenshot↔unit
association** in the REST API (`POST /api/screenshots/{id}/units/`
takes a unit id, nothing more). So we cannot push our own highlight
rectangles, and OCR is exactly the lossy path S1 rejected (blank on
short labels, useless for `aria-*`-only strings).

**What we do instead — crop the element, upload it as the string's
own screenshot.** The capturer already runs a real browser that
knows precisely where each `data-i18n*` element sits. For every
*distinct* key (first scene that renders it visibly wins), it takes
a tight, padded crop of that element's bounding box and emits it as
a normal screenshot entry with a single key. The uploader needs **no
changes** — it already creates an image and associates each entry's
`keys`. In the editor the translator then sees two screenshots for
the string: the close-up (their exact element, zoomed, with a little
surrounding context) and the full-scene shot (where it lives).

**Mechanics.**

- Source of truth for "which element is which key" is the
  `data-i18n` / `data-i18n-aria-label` / `data-i18n-title` /
  `data-i18n-placeholder` attributes (mirror of
  `src/i18n/applyI18nAttributes.ts`). Each maps an element → a key.
- Crop = element `boundingBox()` padded by `CROP_PAD` (24 px) and
  clamped to the viewport (`padClip`), captured via
  `page.screenshot({ clip })` with animations disabled.
- Crop entries carry `kind: 'crop'` and a `crop:<key>` name; scene
  shots carry `kind: 'scene'`. The coverage report counts them
  separately. Deduped by key across the whole run.
- Best-effort and isolated: any element that can't be measured or
  shot is skipped, never failing the scene. Toggle off with
  `SCREENSHOT_CROPS=false`.

**Boundaries (unchanged from the plan's altitude).** Only
`data-i18n*`-marked elements are croppable — that's the static
markup. Strings set via `t()` in JS (dynamic browse cards, etc.)
have no DOM marker tying a box to a key, so they keep the
full-scene shot only; closing that gap would need a per-call-site
annotation pass and is a future increment. `aria-*`-only strings get
a crop of their (icon) element even though the label isn't visible —
still better orientation than the bare key, with the Explanation
field remaining their primary home.

## Risks & tradeoffs

- **Playwright is a real new dependency and a CI cost.** It's the
  honest price of capturing the *running* app, which is the only
  way screenshots stay truthful. We contain it: Chromium-only,
  scheduled + path-scoped rather than per-push, capture-only on
  PRs. If the harness proves valuable it also unlocks future
  visual-regression and smoke testing — but we don't pre-build for
  that here.
- **Scene drift.** A renamed selector breaks a scene's `setup()`.
  Because capture runs in CI, a broken scene *fails loudly* (the
  step errors) rather than silently shipping a blank screenshot —
  better than the manual process, where staleness is invisible.
  Scenes use role/text selectors over brittle CSS where possible.
- **Coarse association — now mitigated by S7.** Scene-level
  association says "this key appeared on the Browse screen," not
  "this key is this button." S7's per-string crops close most of
  that gap for the static `data-i18n*` markup (the translator gets a
  zoomed close-up of the exact element). The remaining coarse-only
  strings are those set via `t()` in JS with no DOM marker — still
  covered by the full-scene shot, upgradeable later with a
  per-call-site annotation pass.
- **`aria`-only strings have no visible anchor.** They'll be
  associated to the scene where they're rendered but won't be
  *visible* in the image. That's acceptable — the translator at
  least sees the surrounding UI, which is more than the bare key
  gives them. The Explanation field remains the right home for
  "this is a screen-reader label."
- **Weblate API shape drift.** The screenshots endpoints are less
  exercised than the units endpoints. S4's manual validation pass
  exists specifically to confirm the create/associate/replace
  calls against the live instance before we automate them.

---

## Open questions

1. **Viewport matrix.** ✅ *Resolved.* Desktop (1440×900) is the
   default; mobile is available as a cheap second pass via the
   `SCREENSHOT_VIEWPORT` / `SCREENSHOT_NAME_SUFFIX` /
   `SCREENSHOT_OUT_DIR` knobs (see implementation status). The
   workflow is desktop-only until someone wants the mobile set.
2. **Schedule cadence.** ✅ *Resolved.* Both — weekly `schedule`
   plus path-scoped `push` to `main`, with the schedule as a safety
   net. Implemented in `sync-weblate-screenshots.yml`.
3. **Coverage visibility.** ✅ *Resolved.* Console line on every
   run + a `$GITHUB_STEP_SUMMARY` block in CI, emitted by the
   capturer (`coverage.ts`), non-failing. No badge yet — revisit if
   anyone asks.
4. **Dataset-dependent scenes.** ⏳ *Still open.* Surfaces that only
   populate once a dataset loads (info panel, playback transport)
   are **not** in the scene set yet — capturing them pulls live
   catalog data into CI. *Lean: a small committed fixture dataset so
   capture is deterministic and offline; add the fixture-backed
   scenes once the S4 hand-validation confirms the base pipeline.*
   The same fixture/auth question gates the *populated* (vs.
   chrome-only) publisher and admin scenes.
