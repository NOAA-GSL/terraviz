# Verification recipes

Don't ship a workflow you only eyeballed. These are cheap and catch the failures
that otherwise surface as a broken globe or a failed CI run.

## 1. Validate the pipeline + metadata against the repo's real validators

This runs the *same* checks the portal `/validate` uses, plus placeholder
interpolation and the inline-palette materialize step — so a pass means it will
save, interpolate to real URLs, and color correctly. Run from the repo root
(needs its `node_modules`); write the script to a temp file and delete it after.

```ts
// _wf_check.ts  (run: npx tsx _wf_check.ts ; then rm it)
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { parse } from 'yaml'
import { validatePipeline, validateMetadataTemplate } from './functions/api/v1/_lib/workflow-validators'
import { renderPipelineJson } from './src/types/zyra-pipeline-args'
import { materializeInlinePalettes } from './cli/zyra-publish-from-dispatch'

const yaml = readFileSync(process.argv[2], 'utf8')
const json = JSON.stringify(parse(yaml))
const errs: any[] = []; validatePipeline(json, errs)
console.log('validatePipeline:', errs.length ? errs : 'OK')
const ctx = { now: new Date('2026-07-31T15:00:00Z'), runId: '01HX0000000000000000000000' }
const rendered = renderPipelineJson(json, ctx)          // throws on unresolved placeholder
console.log('leftover {{ :', rendered.includes('{{'))
const wd = mkdtempSync(join(tmpdir(), 'wf-'))
const mat = await materializeInlinePalettes(rendered, wd)   // exercises cmap_inline
const hm = JSON.parse(mat).stages.find((s: any) => s.command === 'heatmap').args
console.log('cmap_file:', hm.cmap_file, '| data_encoded:', hm.data_encoded,
            '| width/height:', 'width' in hm || 'height' in hm)
console.log('sample rendered input:', JSON.parse(rendered).stages[0].args.inputs?.[0])
// If you also have a metadata template file:
// const merr: any[] = []; validateMetadataTemplate(readFileSync(process.argv[3],'utf8'), merr)
```
Green = `validatePipeline: OK`, `leftover {{ : false`, `data_encoded: true`,
`width/height: false`, and a rendered input that is a real URL.

## 2. Confirm a rendered URL actually resolves

Placeholder-render one input URL (from step 1's output) and HEAD it. S3 is open,
so this works from anywhere:
```bash
curl -sI "https://noaa-gefs-pds.s3.amazonaws.com/gefs.20260731/06/chem/pgrb2ap25/gefs.chem.t06z.a2d_0p25.f000.grib2" -o /dev/null -w "%{http_code}\n"   # expect 200
```
A `403` with `server: cloudflare` means you picked a Cloudflare source — switch
to S3/NODD.

## 3. Confirm the `--pattern` matches exactly one record + get the range

```bash
python3 scripts/sample_grib_range.py "<s3-grib2-url>" "COLMD:entire atmosphere:.*Dust dry"
```
It prints the matched `.idx` line (verify it's the one you want, and only one)
and the value percentiles — set `vmax ≈ p99.9`.

## 4. Confirm the publish attached the color scale

After a run, the publish log should list `render_encoding, color_scale` among
the updated fields:
```
[zyra-run] color-scale sidecar: _work/color-scale.json (NNNNN chars)
[zyra-run] dataset <id> metadata updated (…, render_encoding, color_scale)
```
If instead you see `WARN: … publishing as a picture`, the sidecar wasn't found —
re-check `data_encoded: true` + `color_scale_file` on the heatmap stage. On the
globe: **hovering returns a value** ⇒ the scale is attached (any remaining
grayscale is a palette problem, not attachment).

## 5. If you added templates/allowlist entries to the repo

New curated `WORKFLOW_TEMPLATES` entries are auto-run through `/validate` +
interpolation by `cli/lib/workflow-templates.test.ts` — run it. Full type-check
chain (`npm run type-check`) covers doc-coverage, i18n strings, and locale drift
if you touched `src/`.
