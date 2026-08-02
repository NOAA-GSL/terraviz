#!/usr/bin/env tsx
/**
 * Generates `public/setup.html` — the guided install console served
 * at `/setup`, alongside `/privacy` and `/design-preview`.
 *
 * Run modes, matching `build-privacy-page.ts`:
 *
 *   npm run build:setup-page              write the file
 *   npm run build:setup-page -- --check   fail if it is out of date
 *
 * `--check` runs in CI. It regenerates in memory and diffs, so a
 * change to `content.ts`, to the setup tool's modules, or to the
 * design tokens without a matching rebuild fails the build instead of
 * shipping a page that disagrees with the code.
 *
 * ## Why this page is generated rather than written
 *
 * A hand-written install page drifts. Not dramatically — a binding
 * gets added to the audit and the table keeps its old nine rows, a
 * prerequisite becomes auto-detected and the checklist still tells
 * you to verify it by hand. Each drift is small and none of them
 * announce themselves. They surface at 2am, on someone else's
 * install, as "the docs lied".
 *
 * So everything factual here is imported from the modules the tool
 * uses. `crossCheck()` in `render.ts` turns each known drift mode
 * into a build error.
 *
 * ## Why tokens are inlined rather than linked
 *
 * `/setup` is read while the deploy is broken. Linking the SPA's
 * stylesheet would make the page fail in exactly the situation it
 * exists for. Inlining at build time keeps it self-contained *and*
 * tracking the palette — the frozen-copy approach in
 * `build-privacy-page.ts` only gets the first half.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderSetupPage, ContentDriftError } from './setup-page/render'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TOKENS = resolve(ROOT, 'src/styles/tokens.css')
const OUT = resolve(ROOT, 'public/setup.html')

/**
 * Maps the page's `--tv-*` names onto the repo's design tokens.
 *
 * Verified against `src/styles/tokens.css` rather than guessed. Where
 * a repo token carries the same value the design asked for, the alias
 * points at it and the page tracks the palette. Where the repo has no
 * equivalent, the alias keeps its literal — pointing at a
 * near-miss token would be worse than not tracking, because it would
 * drift *away* from the design on the next palette change.
 *
 * Three cases are worth naming, since each looks like an oversight:
 *
 *   - `--tv-surface` / `--tv-surface-code` stay literal. The repo's
 *     `--color-surface` family is translucent white — glass meant to
 *     composite over the WebGL globe. This page is opaque document
 *     chrome with nested panels, and stacking translucency would make
 *     each nesting level progressively lighter.
 *   - `--tv-text-muted` maps to `--color-text-secondary`, not to
 *     `--color-text-muted`. The names invite the opposite pairing, but
 *     the values decide it: the design's #bbbbbb *is*
 *     `--color-text-secondary`; `--color-text-muted` is #999999.
 *   - `--tv-error` maps to `--color-error-soft` (#ff6b6b), the
 *     foreground red. `--color-error` (#ef4444) is the deeper red the
 *     `-bg` / `-border` literals below are derived from.
 *
 * The repo has no font tokens at all, so both font stacks stay
 * literal. If `tokens.css` gains any of the missing names, this block
 * is the only place that needs to know.
 */
const ALIASES = `
:root{
  --tv-bg:              var(--color-bg,                    #0d0d12);
  --tv-surface:         #121218;
  --tv-surface-2:       var(--color-surface-alt,           rgba(255,255,255,.04));
  --tv-surface-3:       var(--color-surface,               rgba(255,255,255,.06));
  --tv-surface-code:    #08080b;
  --tv-border:          var(--color-surface-border-subtle, rgba(255,255,255,.08));
  --tv-border-strong:   var(--color-surface-border,        rgba(255,255,255,.1));
  --tv-text:            var(--color-text,                  #e8eaf0);
  --tv-text-muted:      var(--color-text-secondary,        #bbbbbb);
  --tv-text-dim:        var(--color-text-dim,              #888888);
  --tv-accent:          var(--color-accent,                #4da6ff);
  --tv-accent-hover:    var(--color-accent-hover,          #6ab8ff);
  --tv-accent-strong:   var(--color-accent-dark,           #0066cc);
  --tv-accent-bg:       rgba(77,166,255,.07);
  --tv-accent-border:   rgba(77,166,255,.24);
  --tv-error:           var(--color-error-soft,            #ff6b6b);
  --tv-error-bg:        rgba(239,68,68,.08);
  --tv-error-border:    rgba(239,68,68,.22);
  --tv-warn:            var(--color-warning,               #ffcc66);
  --tv-warn-bg:         rgba(255,204,102,.07);
  --tv-warn-border:     rgba(255,204,102,.22);
  --tv-success:         var(--color-success,               #22c55e);
  --tv-font-sans:       -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --tv-font-mono:       ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
`

function loadTokens(): string {
  if (!existsSync(TOKENS)) {
    // Not fatal: the aliases carry literal fallbacks, so the page
    // still renders. Say so loudly rather than shipping a silently
    // unthemed page.
    process.stderr.write(
      `warning: ${TOKENS} not found — using literal fallbacks for every token.\n`,
    )
    return ALIASES
  }
  return `${readFileSync(TOKENS, 'utf8').trim()}\n${ALIASES}`
}

/**
 * The generated-at stamp would make every build differ, so `--check`
 * compares with it normalised out. A rebuild that changes nothing but
 * the date is not a failure.
 */
const STAMP = /Produced by scripts\/build-setup-page\.ts on [^.]*\./
const normalise = (s: string): string =>
  s.replace(STAMP, 'Produced by scripts/build-setup-page.ts on <date>.')

function main(): void {
  const check = process.argv.includes('--check')

  let html: string
  try {
    html = renderSetupPage({
      tokensCss: loadTokens(),
      generatedAt: new Date().toISOString().slice(0, 10),
    })
  } catch (error) {
    if (error instanceof ContentDriftError) {
      process.stderr.write(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }

  if (check) {
    if (!existsSync(OUT)) {
      process.stderr.write(
        'public/setup.html is missing. Run `npm run build:setup-page`.\n',
      )
      process.exit(1)
    }
    const current = readFileSync(OUT, 'utf8')
    if (normalise(current) !== normalise(html)) {
      process.stderr.write(
        'public/setup.html is out of date.\n' +
          'Something changed in scripts/setup-page/, in the setup tool modules it\n' +
          'imports, or in src/styles/tokens.css.\n\n' +
          'Run `npm run build:setup-page` and commit the result.\n',
      )
      process.exit(1)
    }
    process.stdout.write('public/setup.html is up to date.\n')
    return
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, html, 'utf8')
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)
  process.stdout.write(`Wrote public/setup.html (${kb} KB)\n`)
}

main()
