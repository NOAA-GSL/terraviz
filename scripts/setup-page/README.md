# `/setup` — the generated install console

Serves at `/setup`, next to `/privacy` and `/design-preview`. A
guided, resumable checklist for standing up a self-hosted node:
tier filter, worksheet substitution into every command block,
persistent progress, a printable pre-flight sheet, and a dependency
map of which phase produces each value.

## How it is wired

`package.json` mirrors the privacy page: `build:setup-page` and
`check:setup-page`, with `prebuild` / `predev` regenerating the file
so a stale `public/setup.html` never reaches a build.

CI runs both checks in the `type-check` job:

```yaml
- run: npm run check:privacy-page
- run: npm run check:setup-page
```

The privacy line is new too. `check:privacy-page` had existed in
`package.json` since the page shipped but was never invoked by a
workflow — and `npm run build` *regenerates* both pages via
`prebuild`, so a stale committed copy is invisible there. It only
surfaces as a mystery diff in the next person's working tree.

`scripts/` is outside every `tsconfig` in the repo — the root one
includes only `src`, and `functions/tsconfig.json` reaches
`scripts/lib/` but not here. `scripts/tsconfig.setup-page.json`
covers the generator, and `type-check` runs it. Without that, `tsx`
would strip the types without ever checking them.

## What is generated and what is written

| | |
|---|---|
| `content.ts` | Prose, traps, gate sentences, map framing. Hand-written, reviewed like copy. |
| `render.ts` | Imports the setup tool's own modules and renders the page. |
| `build-setup-page.ts` | CLI. Inlines tokens, writes or `--check`s. |
| `shell.ts` | What an export must not be able to break. Reapplies the page shell, then verifies it. |
| `shell.test.ts` | The guards, in the one file an export has never contained. |

Everything factual comes from the modules `npm run setup` and
`npm run check:pages-bindings` already use:

- `lib/expected-bindings.ts` → the bindings table, all 19 rows, each
  with the operator-facing hint the audit itself prints
- `lib/setup/interview.ts` → `QUESTIONS` (which values you supply)
  and `MANUAL_STEPS` (the pre-flight sheet, including whether the
  tool detects each one or you self-certify it)
- `lib/setup/state.ts` → default resource names
- `lib/setup/access.ts` → publisher paths, policy names
- `lib/setup/wrangler-toml.ts` → the upstream-pinned IDs
- `lib/setup/prompt.ts` → validator names (re-implemented in the
  page's inline script; see below)

The page therefore cannot claim a binding the audit does not check,
omit one it does, or describe a prerequisite the tool has since
learned to detect.

## `crossCheck()`

Runs on every build and fails it. Each check encodes a way the page
could quietly become wrong:

1. A binding with neither a hint nor a worksheet entry.
2. An interview question no worksheet field claims — or a worksheet
   field mapped to a question that no longer exists.
3. A secret field marked as having a persistable default.
4. **A value consumed before the phase that produces it.** This is
   the ordering invariant the whole guide is built on, and the one
   the pre-2026 revision violated.
5. Non-dense phase numbering, which would desync the nav and the map.
6. More than three self-certified manual steps, which would
   invalidate the pre-flight sheet's framing.
7. A missing `ANALYTICS` binding, or a `paidOnly` worksheet set that
   is not exactly `W9` — both would break the free-plan filter
   silently.
8. A worksheet field naming a validator the inline script does not
   implement — which would silently accept any input for that field.

Checks 2 and 8 are also enforced at compile time: `fromTool` is typed
as the interview's `AnswerKey` and `validator` as
`keyof typeof validators`, so a renamed question or validator fails to
build in `content.ts`. The runtime checks still earn their place —
`AnswerKey` is a hand-written union, so a question can be deleted from
`QUESTIONS` while its key survives in the type.

## The plan chooser

Workers Paid is the one prerequisite an operator can decline, so the
cost panel is a **selector**, not a table. Choosing *Free plan* drops
the Analytics Engine dataset (`W9`), its binding row, its dependency-map
row and add-on 13.4 — none of which can exist without a paid account —
and reframes the "ingest returns 204" troubleshooting entry as expected
behaviour rather than a fault.

A second selector chooses who runs Orbit's model. Picking *a model you
run yourself* reveals three extra variables in Phase 8. Those names come
from the Orbit provider docs rather than from a module `crossCheck` can
verify, and the block says so.

Both choices persist alongside tier and progress.

## Surviving a design export

`render.ts` and `content.ts` are regenerated wholesale by the design
tool and dropped in as replacements. That is the intended workflow —
but it means **any repo-side edit to those two files is lost on the
next export**. The first two exports both proved it, arriving with a
favicon and a globe SVG that do not exist in `public/`, and no CSP.

So the fixes are sorted by what happens when an export drops them:

| Concern | If dropped | Owner |
|---|---|---|
| Token aliases | ships unthemed | `shell.ts` — reapplied |
| Favicon | 404 | `shell.ts` — reapplied |
| Sidebar mark | 404, breaks the offline premise | `shell.ts` — reapplied |
| CSP | page ships unprotected | `shell.ts` — reapplied |
| Any *new* external subresource | breaks the offline premise | `shell.ts` — build fails |
| Backticks escaped in template literals | esbuild fails | build fails |
| `TRUST` worksheet field | `crossCheck` 2 | build fails |
| A validator the inline script lacks | field accepts anything | `shell.ts` — build fails |

Anything in the "reapplied" rows needs no action: `applyShell()` puts
it back and the build says which ones it had to restore. The rows that
fail the build need a hand-fix, and all three are one-liners; the error
message names the file and the change.

`shell.ts` is idempotent, so it is correct against both a raw export
and the current tree, where `render.ts` still carries the same fixes
inline. Nothing has to be reverted to a broken state to keep it honest.

The guards live in `shell.ts` and `shell.test.ts` rather than in
`render.ts` **because those are files the export has never contained**.
A guard inside `render.ts` disappears with the file it was meant to
protect. `assertSelfContained` in particular exists to catch the
breakage we have *not* seen yet: it fails on any subresource that is
not inline, rather than only on the two filenames that have gone wrong
so far.

## Fork-friendly doc links

The page carries 19 links into `SELF_HOSTING.md`, 17 of them anchored
per phase. Built naively they name *this* repo on `main`, which is
wrong for every fork: a fork's node serves a `/setup` that sends
readers to upstream's guide, describing upstream's code.

Two audiences, so two layers, both in `shell.ts` so an export cannot
drop them:

| | Fixes | How |
|---|---|---|
| `TERRAVIZ_DOCS_URL` at build time | a visitor who never fills the worksheet | set once in the fork's build config; unset, it resolves to upstream and the build is unchanged |
| `W3` at runtime | the operator installing | the worksheet already asks for the git remote; typing it retargets every link, no configuration |

The build-time href is always complete and working on its own, so the
runtime layer is an enhancement — with JavaScript off, or if an export
drops the injected script, the links still resolve.

The runtime deliberately reads only the `data-field="W3"` input and
the storage key, never `render.ts`'s script scope, because that scope
is regenerated by every export. Both contracts are asserted.

Deriving the URL from `git remote get-url origin` was the obvious
alternative and is deliberately rejected: it makes the build
environment-dependent, so a fresh fork's committed `setup.html` would
not match a build in their own CI and `check:setup-page` would fail on
their first push. The branch stays `main`; a fork on a different
default branch sets the full base URL via the variable.

## Known seams

**Validator behaviour is duplicated.** `render.ts` re-declares the
regexes from `prompt.ts` inside the page's inline script, because that
script runs in the browser with no module loader. Check 8 confirms
every named validator *exists* in both places; nothing confirms the
two implementations still *agree*. They are deliberately trivial, and
the authoritative copies stay in the tool.

**Token names are aliased.** `TOKEN_ALIASES` in `shell.ts` maps the
page's `--tv-*` names onto the repo's tokens. They were verified
against `src/styles/tokens.css` and carry literal fallbacks, so the
page renders either way. Three `--tv-*` names have no repo equivalent
and stay literal on purpose — the reasoning is in the comment above
the block, and that block is the only place that needs to know.
`shell.test.ts` asserts that every `--color-*` an alias points at
actually exists in `tokens.css`, so a token renamed upstream fails the
build instead of silently freezing this page on its literal.

## Self-contained means self-contained

Enforced by `assertSelfContained` in `shell.ts`, not by convention.


The page must render off a laptop, a checkout, or a broken preview —
that is the situation someone is in when they open it. So the design
tokens are inlined, the sidebar mark is inline SVG rather than an
`<img src="/…">`, and the CSP is `default-src 'none'`, which cannot be
satisfied by a page that fetches anything. That CSP also blocks the
analytics beacon Cloudflare Pages injects into every deployed HTML
file, matching what `privacy.html` already does with `script-src
'none'`. The one external reference left is `/favicon.ico`, which
404s harmlessly under `file://` exactly as `privacy.html`'s does.

**Tier assignment for bindings is inferred** from a name pattern in
`render.ts`. If a Tier 1 node ever needs one of the catalog bindings,
that predicate is where to change it.

## Not in scope

The page links into `SELF_HOSTING.md` for anything long: the full
sixteen troubleshooting symptoms, all nine add-ons, the click paths,
Reference D's verification status. The Markdown stays canonical. This
is the front door.
