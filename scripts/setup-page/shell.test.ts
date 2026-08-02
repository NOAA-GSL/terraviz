/**
 * The export-proof layer.
 *
 * `render.ts` and `content.ts` are replaced wholesale by each design
 * export, so a guard living in either of them protects nothing — it is
 * gone with the file that held it. This test is the one place the
 * export has never reached, which makes it the right home for the
 * assertions that must outlive it.
 *
 * Two exports in a row shipped a favicon and a globe SVG that do not
 * exist in `public/`, and no CSP. Both would have deployed silently.
 * These tests are what turn that into a red build.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applyDocLinks,
  applyShell,
  docLinkRuntime,
  resolveDocsUrl,
  assertSelfContained,
  assertValidatorsImplemented,
  CSP_META,
  FAVICON_LINK,
  GLOBE_MARK,
  repairSummary,
  TOKEN_ALIASES,
} from './shell'
import { MARKDOWN_URL, WORKSHEET } from './content'

const PAGE = resolve(__dirname, '../../public/setup.html')
const html = (): string => readFileSync(PAGE, 'utf8')

const RAW_EXPORT_HEAD = [
  '<head>',
  '<meta charset="utf-8"/>',
  '<title>Terraviz — install console</title>',
  '<meta name="robots" content="noindex"/>',
  '<link rel="icon" href="/terraviz-favicon-32.png"/>',
  '</head><body>',
  '<img src="/terraviz-globe.svg" alt="" width="26" height="26"/>',
  '</body>',
].join('\n')

describe('applyShell', () => {
  it('repairs everything a raw export drops', () => {
    const { html: out, repairs } = applyShell(RAW_EXPORT_HEAD)
    expect(repairSummary(repairs).sort()).toEqual(['csp', 'favicon', 'globeMark'])
    expect(out).toContain(FAVICON_LINK)
    expect(out).toContain(CSP_META)
    expect(out).toContain(GLOBE_MARK)
    expect(out).not.toContain('terraviz-favicon')
    expect(out).not.toContain('terraviz-globe.svg')
  })

  // The repo keeps the same fixes inline in render.ts. If applying the
  // shell to an already-fixed page changed anything, the two sources
  // would fight and every build would differ from the last.
  it('is a no-op on a page that already has them', () => {
    const once = applyShell(RAW_EXPORT_HEAD).html
    const { html: twice, repairs } = applyShell(once)
    expect(twice).toBe(once)
    expect(repairSummary(repairs)).toEqual([])
  })

  it('refuses to guess where the CSP goes if the head is restructured', () => {
    expect(() => applyShell('<html><body>no head markers</body></html>')).toThrow(
      /Cannot place the CSP/,
    )
  })
})

describe('fork-friendly doc links', () => {
  const doc = (anchor = '') => `<a href="${MARKDOWN_URL}${anchor}">d</a>`

  it('defaults to the upstream guide when nothing is configured', () => {
    expect(resolveDocsUrl({})).toBe(MARKDOWN_URL)
    expect(resolveDocsUrl({ TERRAVIZ_DOCS_URL: '   ' })).toBe(MARKDOWN_URL)
  })

  it('takes the configured base and drops a trailing slash', () => {
    expect(resolveDocsUrl({ TERRAVIZ_DOCS_URL: 'https://x.org/g.md/' })).toBe('https://x.org/g.md')
  })

  it('retargets every link and keeps each anchor', () => {
    const { html, count } = applyDocLinks(
      `${doc()}${doc('#phase-2--create-the-cloudflare-resources')}`,
      'https://github.com/fork/repo/blob/main/docs/SELF_HOSTING.md',
    )
    expect(count).toBe(2)
    expect(html).toContain('data-doc="#phase-2--create-the-cloudflare-resources"')
    expect(html).toContain(
      'href="https://github.com/fork/repo/blob/main/docs/SELF_HOSTING.md#phase-2--create-the-cloudflare-resources"',
    )
    expect(html).not.toContain(MARKDOWN_URL)
  })

  // The runtime layer is an enhancement. With JS off, or after an
  // export drops the script, the static href must still work.
  it('leaves a complete working href, not a fragment', () => {
    const { html } = applyDocLinks(doc('#x'), 'https://e.org/g.md')
    expect(html).toContain('href="https://e.org/g.md#x"')
  })

  it('is a no-op when the page has no doc links', () => {
    const { html, count } = applyDocLinks('<p>none</p>', 'https://e.org/g.md')
    expect(count).toBe(0)
    expect(html).toBe('<p>none</p>')
  })

  // Coupling to render.ts's script scope would break on the next
  // export; these two contracts are all the runtime may rely on.
  it('reads only the W3 field and the storage key', () => {
    const js = docLinkRuntime(MARKDOWN_URL)
    expect(js).toContain('data-field="W3"')
    expect(js).toContain('terraviz-setup-console-v1')
  })

  it('injects the runtime only when there are links to retarget', () => {
    expect(applyShell('<html><head><title>t</title></head><body></body></html>').html)
      .not.toContain('terraviz-setup-console-v1')
    const withLinks = applyShell(
      `<html><head><title>t</title></head><body>${doc('#a')}</body></html>`,
    )
    expect(withLinks.docLinks).toBe(1)
    expect(withLinks.html).toContain('terraviz-setup-console-v1')
  })
})

describe('assertSelfContained', () => {
  it('accepts inline and data: subresources, and the favicon', () => {
    expect(() =>
      assertSelfContained(
        `${FAVICON_LINK}<img src="data:image/png;base64,AA"/><a href="https://example.org">x</a>`,
      ),
    ).not.toThrow()
  })

  // The transforms above only fix breakages we have already seen. This
  // is what catches the next one.
  it.each([
    ['a script', '<script src="https://cdn.example.org/a.js"></script>'],
    ['a stylesheet', '<link rel="stylesheet" href="/assets/app.css"/>'],
    ['an image', '<img src="/some-new-asset.svg"/>'],
    ['a CSS url()', '<style>body{background:url(/bg.png)}</style>'],
  ])('rejects %s the page would have to fetch', (_label, markup) => {
    expect(() => assertSelfContained(markup)).toThrow(/self-contained/)
  })

  it('does not mistake a link for a subresource', () => {
    expect(() =>
      assertSelfContained('<a href="https://github.com/x/y/blob/main/docs/SELF_HOSTING.md">d</a>'),
    ).not.toThrow()
  })
})

describe('assertValidatorsImplemented', () => {
  const field = (validator: string) =>
    [{ validator, id: 'X' }] as unknown as typeof WORKSHEET

  it('passes when the inline script defines the validator', () => {
    expect(() =>
      assertValidatorsImplemented(field('emailDomainList'), 'const V = { emailDomainList: v => null }'),
    ).not.toThrow()
  })

  // The second export dropped exactly this one. Unnoticed, the field
  // accepts any input at all.
  it('fails when it does not', () => {
    expect(() => assertValidatorsImplemented(field('emailDomainList'), 'const V = {}')).toThrow(
      /emailDomainList/,
    )
  })
})

describe('the committed public/setup.html', () => {
  it('is self-contained', () => {
    expect(() => assertSelfContained(html())).not.toThrow()
  })

  it('implements every validator its worksheet names', () => {
    expect(() => assertValidatorsImplemented(WORKSHEET, html())).not.toThrow()
  })

  it('tags every doc link so the runtime can retarget it', () => {
    const page = html()
    // 15 phases + the two standing references.
    expect((page.match(/data-doc="/g) ?? []).length).toBeGreaterThanOrEqual(17)
    expect(page).toContain('terraviz-setup-console-v1')
  })

  it('carries the CSP and the real favicon', () => {
    expect(html()).toContain(CSP_META)
    expect(html()).toContain(FAVICON_LINK)
  })

  // Losing this is how the page stops tracking the palette. The alias
  // names were verified against src/styles/tokens.css; a token that
  // does not exist there resolves to its literal forever, silently.
  it('inlines the token aliases', () => {
    expect(html()).toContain('--tv-accent:')
    for (const token of TOKEN_ALIASES.matchAll(/var\((--color-[a-z-]+),/g)) {
      expect(
        readFileSync(resolve(__dirname, '../../src/styles/tokens.css'), 'utf8'),
        `${token[1]} is aliased but not defined in tokens.css`,
      ).toContain(`${token[1]}:`)
    }
  })

  // The interview asks for it; without a worksheet field claiming it,
  // crossCheck 2 fails the build. Asserted on the output too, because
  // that check lives in a file the next export replaces.
  it('renders a field for every value the interview asks for', () => {
    expect(html()).toContain('data-field="TRUST"')
  })
})
