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
  docLinkScript,
  costRuntime,
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
import { estimateStorage, REFERENCE_NODE } from './pricing'

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

  // The runtime writes a user-supplied value into an href. Reading the
  // regex and concluding "that looks fine" is not evidence, so this
  // runs the emitted script against hostile input and checks the
  // origin that actually comes out.
  describe('the emitted runtime, executed', () => {
    const run = (w3: string): string => {
      document.body.innerHTML =
        `<input data-field="W3" value="${w3.replace(/"/g, '&quot;')}"/>` +
        '<a data-doc="#phase-2" href="' + MARKDOWN_URL + '#phase-2"></a>'
      new Function(docLinkScript(MARKDOWN_URL))()
      return document.querySelector('[data-doc]')!.getAttribute('href')!
    }

    it('retargets a real owner/repo', () => {
      expect(run('museum/terraviz-fork')).toBe(
        'https://github.com/museum/terraviz-fork/blob/main/docs/SELF_HOSTING.md#phase-2',
      )
    })

    it.each([
      ['a scheme', 'javascript:alert(1)'],
      ['path traversal', '../..'],
      ['a protocol-relative host', '//evil.org/x'],
      ['userinfo confusion', 'evil.org%2f@x/y'],
      ['empty', ''],
    ])('falls back rather than trusting %s', (_label, w3) => {
      expect(run(w3)).toBe(`${MARKDOWN_URL}#phase-2`)
    })

    // data-doc is ours, but it reaches the href as DOM text. This is
    // the flow CodeQL flagged; the fragment must never carry a scheme.
    it('ignores a data-doc that is not a plain fragment', () => {
      document.body.innerHTML =
        '<input data-field="W3" value=""/>' +
        `<a data-doc="javascript:alert(1)" href="${MARKDOWN_URL}"></a>`
      new Function(docLinkScript(MARKDOWN_URL))()
      const href = document.querySelector('[data-doc]')!.getAttribute('href')!
      expect(href).toBe(MARKDOWN_URL)
      expect(new URL(href).protocol).toBe('https:')
    })

    // The construction, not the pattern, is what guarantees this.
    it('never leaves github.com', () => {
      for (const w3 of ['evil.com/x', 'a/b', '..-/x', '_/_']) {
        const url = run(w3)
        expect(new URL(url).origin, `${w3} escaped the origin`).toBe('https://github.com')
      }
    })
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

describe('the cost estimate runtime', () => {
  // `String.replace` reads `$'` in a *replacement string* as
  // "everything after the match". Both injected scripts format money
  // with `'~$' + …`, so a string replacement spliced the tail of the
  // document into the middle of a string literal and broke the page
  // with "Invalid or unexpected token". Nothing but parsing the output
  // catches that.
  it('survives injection without the $-pattern eating the document', () => {
    const page = applyShell(
      '<html><head><title>t</title></head><body><input data-cost-count/><output data-cost-out></output><p data-cost-note></p></body>\n</html>',
    ).html
    expect(page).toContain('data-cost-count')
    expect(page).not.toMatch(/'~\n/)
    expect(() => new Function(costRuntime())).not.toThrow()
  })

  it('is injected only when the panel is on the page', () => {
    const without = applyShell('<html><head><title>t</title></head><body></body></html>').html
    expect(without).not.toContain('data-cost-out')
  })

  // The browser copy and the tested pure function must not drift.
  it('matches estimateStorage() at the same inputs', () => {
    document.body.innerHTML =
      `<input data-cost-count value="${REFERENCE_NODE.videoDatasets}"/>` +
      '<output data-cost-out></output><p data-cost-note></p>'
    new Function(costRuntime())()
    const shown = document.querySelector('[data-cost-out]')!.textContent!
    const e = estimateStorage(REFERENCE_NODE.videoDatasets)
    expect(shown).toContain(e.storageGb.toFixed(0))
    // The browser copy must land on the real invoice too.
    expect(shown).toContain(String(REFERENCE_NODE.monthlyUsd))
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

  // The plan chooser offers Free as a supported choice, so the sheet
  // must not then list "Enable Workers Paid" as task one. Asserted on
  // the built page because the sheet lives in render.ts, which the
  // next design export replaces wholesale.
  it('offers a free-plan variant of the Workers Paid prerequisite', () => {
    const page = html()
    expect(page).toContain('data-when="paid"')
    expect(page).toMatch(/not on the free plan/)
    // Both variants present means the row count is stable across plans.
    expect((page.match(/Workers Paid/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  // A reader totting up Cloudflare line items concludes the node is
  // nearly free and is right — while missing that transcode is real
  // CPU work on GitHub's runners, free only while the fork is public.
  it('says where the compute happens and what it costs', () => {
    const page = html()
    expect(page).toContain('not on your Cloudflare bill')
    expect(page).toContain('transcode-hls')
    // Quoted, not paraphrased — it is someone else's policy.
    expect(page).toContain('free for self-hosted runners and for public repositories')
    expect(page).toContain('any other activity unrelated to the production')
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
