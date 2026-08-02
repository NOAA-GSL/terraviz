---
name: terraviz-data-video
description: >-
  Author and debug TerraViz/Zyra data-encoded ("data-driven") video workflows —
  the pipelines that put a gridded model field (aerosols, smoke, dust, AOD,
  PM, any GRIB2/NetCDF forecast) onto the globe with live hover values and a
  client-recolored palette. Use this skill whenever the user is building,
  editing, or debugging a Zyra workflow pipeline (convert-format → reproject →
  heatmap → compose-video), adding a new model dataset to the catalog, wiring
  up `heatmap --data-encoded` / `color_scale` / `cmap_inline` / palettes,
  choosing vmin/vmax, writing a workflow metadata template, or troubleshooting
  a black or grayscale globe, a missing legend, or absent hover values on a
  data-encoded dataset. Also use it for picking a non-Cloudflare data source
  (NOAA Open Data on S3 / NODD) and inspecting a GRIB2 `.idx` variable
  inventory. Reach for it even when the user just says "add global X to the
  globe", "make a data-driven video of Y", or "why is my dataset
  black-and-white" — the data-encoded contract has many non-obvious gotchas
  captured here that are painful to rediscover from scratch.
---

# TerraViz data-encoded video workflows

A **data-encoded** ("data-driven") TerraViz dataset is a video whose pixel
**luma encodes the physical value** (not a baked-in color). The globe recolors
it client-side from a `color_scale` sidecar, and hovering reports the real
value + units. This is what separates a *measurement you can query* from a
*picture*. Getting there is a Zyra pipeline plus a specific, non-obvious
contract — most of this skill is that contract and the gotchas, because they
cost hours to rediscover.

**If you only remember three things:**
1. Data-encoded needs `data_encoded: true` **and** `color_scale_file` on the
   `heatmap` stage. Missing either → it publishes as a plain picture (no hover,
   no recolor).
2. `--cmap` is **ignored** on the data-encoded path. The palette must come from
   a `--cmap-file`/`cmap_inline` JSON, or you get a grayscale globe.
3. `--width`/`--height` are **forbidden** with `--data-encoded`, and
   `compose-video preset: sos` silently corrupts values by rescaling. Regrid
   *upstream* in `reproject` instead.

## Workflow: build a new data-encoded dataset

Follow these steps in order. Each links to a reference for depth.

### 1. Pick a source that a CI runner can actually reach
Prefer **NOAA Open Data on S3 (NODD)** over agency THREDDS servers.
`gsl.noaa.gov` (and many `*.noaa.gov` sites) sit behind Cloudflare that **403s
datacenter/CI IPs** — the workflow will fail on fetch no matter how correct the
pipeline is. `*.s3.amazonaws.com` buckets (e.g. `noaa-gefs-pds`) are open.
GEFS-Aerosols on `noaa-gefs-pds` *is* the operational descendant of GSL's
FV3-Chem, so it usually covers the same fields. See
[references/data-sources.md](references/data-sources.md).

### 2. Find the exact variable in the GRIB2
Read the `.idx` sidecar next to any GRIB2 on S3 to list records, then select
**one** with a `convert-format --pattern` regex. For aerosols the column field
is `COLMD` (column mass density), one record per species
(`Dust dry`, `Particulate organic matter dry` = smoke, `Black carbon dry`,
`Sulphate dry`, `Sea salt dry`, `Total aerosol`). Run
`scripts/sample_grib_range.py` to both confirm the record and get the value
distribution. See [references/data-sources.md](references/data-sources.md).

### 3. Set vmin/vmax from the real data, not a guess
`vmin: 0`, and **`vmax ≈ the p99.9** of the field. A vmax that's ~10× too high
maps everything into the low/transparent end → a near-black globe (the single
most common "it's broken" symptom). `scripts/sample_grib_range.py` prints
percentiles; use p99.9 as vmax, or p99.99 to keep the most intense cores from
clipping.

### 4. Write the pipeline
Start from [assets/model-cycle-data-encoded.template.yaml](assets/model-cycle-data-encoded.template.yaml)
(a self-updating GEFS-Aerosols column-field pipeline) and adapt the `--pattern`,
frame count, palette, and vmax. The proven five-stage shape:
`convert-format` (fetch + `.idx`-subset + geotiff) → `reproject`
(0–360 → ±180, regrid to 4096×2048) → `heatmap --data-encoded` → `scan-frames`
(derive time range) → `compose-video`. Full arg reference and the placeholder
grammar are in [references/pipeline-reference.md](references/pipeline-reference.md).

### 5. Colorize with a palette (no hosting)
The `heatmap` stage **writes** the `color_scale` sidecar from a palette spec.
Prefer `cmap_inline` (a JSON string; the runner materializes it to a file) so
you don't host a palette per dataset. Aerosol default:
`{"type":"continuous","base":"<matplotlib cmap>","transparent_range":12,"blend_range":48,"overall_alpha":0.95}`.
Pick a **light-starting** colormap so faint plumes read on the black globe, and
follow the aerosol color convention (smoke `YlOrBr`, dust `Oranges`). Details +
the classified format in [references/pipeline-reference.md](references/pipeline-reference.md).

### 6. Write the metadata template
Plain-language title/abstract for the globe; self-updating dates via
`{{valid_iso:...}}`; allowed fields only. See
[references/pipeline-reference.md](references/pipeline-reference.md) §Metadata.

### 7. Verify before you ship
Validate the YAML against the repo's *actual* validators + placeholder renderer
(don't just eyeball it), confirm a rendered S3 URL returns 200, and confirm the
publish log shows `render_encoding, color_scale` were attached. Recipes in
[references/verification.md](references/verification.md).

### 8. Legend
There is **no auto gradient legend on `main`** — the dynamic colorbar (built
from `color_scale`) lives on the unmerged `claude/data-driven-video-analytics`
branch. Until it ships, generate a colorbar PNG with `scripts/make_legend.py`
and attach it to the dataset's `legend_ref` via the publisher form → Media. The
`color_scale` still powers the **hover readout**, which is the live value
surface on `main`.

## The data-encoded contract (why the gotchas exist)

These are the rules that silently produce a wrong-looking dataset. Each has a
*why* — understanding it beats memorizing it. Full debugging map in
[references/data-encoded-contract.md](references/data-encoded-contract.md).

| Rule | Why | Symptom if violated |
|---|---|---|
| `data_encoded: true` **and** `color_scale_file` both set | publish scrapes the heatmap stage for both to attach `render_encoding`+`color_scale`; the client needs both or it shows raw luma | grayscale globe, no hover, no legend |
| Palette via `--cmap-file`/`cmap_inline`, **not** `--cmap` | `--cmap` is ignored for data-encoded; `build_color_scale(None)` writes a black→white ramp | detailed but **grayscale** globe (hover works) |
| **No** `width`/`height` on the heatmap stage | resizing would average values never measured; zyra hard-errors | stage fails: "cannot be used with --data-encoded" |
| Regrid to 4096×2048 **in `reproject`**, not heatmap | reprojection resamples the *data* (legit); image resize averages *luma* | (how you get 4K without breaking #3) |
| **No** `compose-video preset: sos` | it pins 4096×2048 and rescales the luma frames → corrupts values *silently* | subtly wrong hover values, no error |
| **No** `basemap` on a data-encoded heatmap | data-encoded bypasses the basemap; the globe supplies Earth | ignored at best; keep it clean |
| `vmin`/`vmax` from real data | required; a too-high vmax pushes everything near 0 | near-black globe with faint detail |

## Debugging: what the globe is telling you

Match the symptom, don't guess. Deep version in
[references/data-encoded-contract.md](references/data-encoded-contract.md) §Debugging.

- **Black globe, but detail appears when you zoom/adjust** → `vmax` too high.
  Sample the range, set `vmax ≈ p99.9`.
- **Grayscale (detail visible), hover values work** → palette is grayscale:
  `--cmap` was used (ignored) or no palette at all. Add `cmap_inline`/`cmap_file`.
- **Grayscale, NO hover values, NO legend** → the color scale never attached.
  Check the publish log for `WARN: … publishing as a picture`; confirm
  `data_encoded: true` + `color_scale_file` are both present; confirm publishing
  went through the Zyra dispatch path (not a manual upload); check the dataset
  row's `render_encoding`/`color_scale` columns.
- **Color + hover work, but no legend** → expected on `main`. Attach a
  `legend_ref` PNG, or ship the analytics branch.
- **`403 Forbidden` on fetch** → Cloudflare blocking the CI IP. Switch to an
  S3/NODD source (§1).
- **`unrecognized arguments: --X`** → the pinned zyra container doesn't support
  that arg (e.g. `--sync-dir` on `acquire http`, or `cmap_inline` before the
  runner build that materializes it deployed).

## Bundled scripts

- `scripts/sample_grib_range.py <s3-grib2-url> <idx-regex>` — fetches the `.idx`,
  range-GETs just the matching record, decodes with eccodes, prints
  min/max/mean/percentiles. Use it to pick `vmax` and to confirm your
  `--pattern` matches exactly one record. Needs `pip install eccodes numpy`.
- `scripts/make_legend.py` — renders a colorbar PNG (opaque white background)
  matching a colormap + vmin/vmax + units, for the stopgap `legend_ref`. Needs
  `pip install matplotlib pillow numpy`.

## References

- [references/data-encoded-contract.md](references/data-encoded-contract.md) —
  the full contract with code-level *why* (which functions gate each behavior)
  and the complete debugging map.
- [references/data-sources.md](references/data-sources.md) — Cloudflare vs
  S3/NODD, GEFS-Aerosols paths + variable inventory, the `.idx` inspection
  recipe, GEFS-Aerosols ↔ FV3-Chem lineage.
- [references/pipeline-reference.md](references/pipeline-reference.md) —
  stage-by-stage arg reference, the placeholder grammar (incl. what it *can't*
  express), metadata template rules, palette specs, `cmap_inline`, cadence/fps.
- [references/verification.md](references/verification.md) — validating a YAML
  against the repo's real validators, checking URLs, confirming the publish
  attached the scale.
