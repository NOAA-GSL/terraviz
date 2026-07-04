# Embed URL Grammar — v1

**Status: stable (grammar v1).** This is the public contract for
deep-linking and embedding the TerraViz web app by URL. It is the
surface external hosts compose against — the companion poster, kiosk
displays, and (the reason it is written down) the WordPress plugin's
Gutenberg blocks and shortcodes
([`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §3).

Because independent consumers now depend on these parameters, they
are treated as a versioned contract, not incidental query handling:
additive changes are safe; renaming or removing a parameter, or
changing an accepted value's meaning, is a breaking change that bumps
the grammar version and is called out in the Changelog below. This
mirrors the "publish the contract, don't share the source" discipline
in [`architecture/federation-scoping.md`](architecture/federation-scoping.md)
§7 Directive 2 — a host composing these URLs should never have to
read `src/main.ts` to know what is safe to rely on.

The parameters are read at boot by `src/main.ts` and the helpers in
`src/utils/{catalogMode,embedMode,posterDeepLinks}.ts` /
`src/services/deepLinkService.ts`. Behaviour is deliberately
conservative: an unknown parameter value is a silent no-op, and the
URL is not rewritten after boot, so a refresh preserves the linked
state.

---

## Base URL

An embed targets a full TerraViz **origin** — the app runs inside the
iframe against its own `/api`, so the host page's own domain is
irrelevant to data loading:

```
https://<terraviz-node>/?<params>
```

`<terraviz-node>` is the canonical deployment
(`terraviz.zyra-project.org`) or a partner-operated node. It is never
the WordPress site's own origin.

---

## Selector parameters — what to show

Exactly one selector is normally used per embed. If more than one is
present, the precedence is `dataset` > `tour` > `catalog` (`?dataset=`
wins, and `?tour=` is skipped when `?dataset=` is also set —
`src/utils/posterDeepLinks.ts:174-188`).

| Parameter | Value | Effect | Source |
|---|---|---|---|
| `dataset` | catalog ID (e.g. `INTERNAL_SOS_123`) | Boot straight into that dataset on the globe. | `src/main.ts` initial-load path |
| *(path form)* `/dataset/<id>` | catalog ID | Equivalent to `?dataset=<id>`; canonicalized to the query form at boot. | `src/services/deepLinkService.ts:72-77` |
| `tour` | tour slug, catalog ID, or legacy ID | Boot straight into a tour. Resolves **only** to rows whose `format === 'tour/json'`; a non-tour match is a no-op by design. | `src/utils/posterDeepLinks.ts:111-137` |
| `catalog` | `true` (or any value except `false`/`0`) | Catalog mode — the dataset browser is the primary surface; the globe stays hidden until selection. | `src/utils/catalogMode.ts:21-28` |
| `preview` | opaque token (with `&dataset=<id>`) | Load a token-gated **draft** dataset. For authoring previews, not public embeds. | `src/main.ts` preview deep-link path |

---

## Embed parameters — how much chrome

| Parameter | Value | Effect |
|---|---|---|
| `embed` | `1` (or any value except `false`/`0`) | **Minimal-chrome mode.** Hides the tools menu, help trigger, home button, and Orbit chat trigger; outside catalog mode also hides the browse overlay and the catalog↔sphere tab control. Keeps the globe and the playback transport. Applied before first paint so no chrome flashes in. |
| `chat` | `1` | Only meaningful with `embed=1`. Keeps the **Orbit chat trigger** for a "dataset + ask Orbit" embed. Omit for a fully minimal embed. |

`embed` and `chat` parse with the same truthy convention as
`catalog` (`false`/`0` are the only opt-outs, case-insensitive —
`src/utils/embedMode.ts`). In catalog mode (`?catalog=true&embed=1`)
the browse grid and the tab control are **kept**, since the catalog
grid is the point of that embed.

---

## View modifiers — optional, composable

These layer on top of any selector. Each is independent.

| Parameter | Accepted values | Effect | Notes |
|---|---|---|---|
| `terrain` | `on` | Enable 3D terrain. | Only `on` acts; any other value is a no-op. |
| `labels` | `on` | Show place labels. | " |
| `borders` | `on` | Show country/coastline borders. | " |
| `rotate` | `on` | Start auto-rotation. | " |
| `layout` | `1`, `2`, `4` | Multi-globe grid (`2` = side-by-side). | `src/utils/posterDeepLinks.ts:74-94` |
| `setview` | `1`, `2h`, `2v`, `4` | Legacy/advanced layout form (accepts vertical `2v`). | Prefer `layout`; `setview` is the older dev alias. |
| `orbit` | `open` | Open the Orbit chat panel on load. | Optionally seed the input with `&prompt=tour`. |
| `prompt` | `tour` | Seed text for the Orbit input when `orbit=open`. | Unknown values open the panel without a seed. |

The view toggles (`terrain`/`labels`/`borders`/`rotate`) are applied
by clicking the real Tools-menu buttons, so analytics, accessibility
announcements, and button state stay in sync even when the chrome is
hidden by `embed=1`.

---

## Composition examples

These are the exact shapes the WordPress blocks (and the poster)
compose:

```text
# Single dataset, minimal chrome
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1

# Single dataset with terrain + auto-rotate, and Orbit available
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1&chat=1&terrain=on&rotate=on

# A tour, minimal chrome
https://terraviz.zyra-project.org/?tour=climate-futures&embed=1

# The full catalog browser, embedded (grid + tab control kept)
https://terraviz.zyra-project.org/?catalog=true&embed=1

# Four-globe layout, embedded
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1&layout=4
```

---

## Stability guarantees

- **Additive by default.** New parameters and new accepted values may
  appear without a version bump. A host that ignores unknown
  parameters keeps working.
- **Truthy convention is fixed.** `catalog`, `embed`, and `chat` all
  treat presence as on and only `false`/`0` (case-insensitive) as
  off. New boolean flags should follow the same convention.
- **Breaking changes bump the version.** Renaming or removing a
  parameter, or changing what an existing value does, is a v2 change
  and appears in the Changelog with a migration note.
- **`embed=1` is presentational only.** It never changes what data
  loads or which API is called — only which chrome is visible. A
  host can add or drop `embed=1` on any otherwise-valid URL.

---

## Changelog

| Grammar version | Date | Change |
|---|---|---|
| v1 | 2026-07-04 | Initial written contract. Documents the pre-existing `dataset` / `/dataset/:id` / `tour` / `catalog` / `preview` selectors and the `terrain` / `labels` / `borders` / `rotate` / `layout` / `setview` / `orbit` / `prompt` modifiers, and introduces the new `embed` minimal-chrome flag and its `chat` sub-flag. |

---

## See also

- [`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §3 — the Gutenberg blocks that consume this grammar
- `src/utils/embedMode.ts` — the `embed` / `chat` reader + body-class application
- `src/utils/catalogMode.ts` — the `catalog` reader
- `src/utils/posterDeepLinks.ts` — `tour` / view-toggle / `orbit` dispatch
- `src/services/deepLinkService.ts` — `/dataset/:id` path form and native `zyra://` links
- `src/styles/embed.css` — the chrome-hiding rules `embed=1` switches on
