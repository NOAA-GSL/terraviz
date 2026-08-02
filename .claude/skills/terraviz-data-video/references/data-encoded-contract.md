# The data-encoded contract (with code-level why)

A data-encoded dataset is an **all-or-nothing pair**: the dataset row must carry
both `render_encoding: 'data-luma'` **and** a parseable `color_scale`. Any break
in that chain falls back to displaying the raw grayscale luma video — which for
a value-encoded frame looks near-black — with no recolor and no hover readout.
This is a *fail-closed* design: a half-configured dataset shows as the picture
it visibly is rather than throwing.

## Table of contents
1. How a dataset becomes colored (client path)
2. How the color scale gets attached (publish path)
3. The palette: why `--cmap` doesn't work
4. Why width/height and preset:sos are forbidden
5. vmin/vmax
6. The legend (why it's separate, and where the real one is)
7. Complete debugging map

---

## 1. How a dataset becomes colored (client path)

The client (SPA) gates recolor on the pair. Key files on `main`:

- `src/types/color-scale.ts` — `RENDER_ENCODING_DATA_LUMA = 'data-luma'`;
  `parseColorScale()` is fail-closed (returns `null` on any malformed sidecar).
- `src/services/dataService.ts` `dataEncodingFromWire()` — drops the pair unless
  `renderEncoding === 'data-luma'` **and** `parseColorScale(colorScale)`
  succeeds. Either missing → the dataset renders as a picture.
- `src/services/datasetOverlayOptions.ts` `dataEncodedScale()` — only forwards
  `colorScale` to the renderer when `renderEncoding === 'data-luma'`.
- `src/services/earthTileLayer.ts` `syncColorLut()` — no `colorScale` ⇒ returns
  `null`; the shader's `uDataEncoded` goes false and it draws the **raw texture**
  (the near-black grayscale). With the scale, it recolors via a 256×1 LUT.
- The hover **readout** (`src/services/mapRenderer.ts probeValueAt` →
  `datasetProbe.ts`) is gated on the *same* `colorScale`. So **if hover works,
  the scale is attached** — a crucial diagnostic.

A valid `color_scale` sidecar (what `parseColorScale` accepts):
```json
{ "stops": [ {"t":0,"rgba":[0,0,0,0]}, {"t":1,"rgba":[255,0,0,255]} ],
  "vmin": 0, "vmax": 50, "units": "kg m-2", "transparentRange": 0.047 }
```
Requires ≥2 stops (`t∈[0,1]`, `rgba` 4×[0,255]) and **finite, distinct**
vmin/vmax. `vmin === vmax` fails validation → drops to grayscale.

## 2. How the color scale gets attached (publish path)

The Zyra publish runner (`cli/zyra-publish-from-dispatch.ts`) attaches the pair:

- `deriveColorScalePath()` walks the pipeline's `heatmap` stages looking for the
  `--data-encoded` flag **and** `--color-scale-file` (both kebab and snake
  spellings). It **NO-OPs** (→ picture) when:
  - the flag is on a non-`heatmap` stage (`if (stage.command !== 'heatmap') continue`),
  - no `--data-encoded` on any heatmap stage,
  - `--data-encoded` present but **no `--color-scale-file`** (logs
    `WARN: … --data-encoded with no --color-scale-file — publishing as a picture`).
- `readColorScaleFields()` reads + validates the sidecar file; returns `{}` (→
  picture) if unreadable, over `COLOR_SCALE_MAX_CHARS` (16384), or fails
  `parseColorScale`. On success it PATCHes exactly two row fields:
  `render_encoding: 'data-luma'` and `color_scale: <raw json>`.

There is **no `color_scale_url`** field — the sidecar's JSON body is inlined
into the `color_scale` column. Server-side `validateRenderEncoding`
(`functions/api/v1/_lib/validators.ts`) enforces all-or-nothing both directions
(data-luma without a sidecar, or a sidecar without data-luma, are both rejected).

**Consequence:** if you ran zyra by hand and uploaded the MP4 yourself, none of
this ran → no scale attached → grayscale. Publishing must go through the Zyra
dispatch path.

## 3. The palette: why `--cmap` doesn't work

In zyra's `src/zyra/visualization/cli_heatmap.py`, the data-encoded path builds
the palette from **`--cmap-file` only**:
```python
palette = None
if getattr(ns, "cmap_file", None):
    palette = load_palette_spec(cmap_file)
scale = build_color_scale(palette, vmin=..., vmax=..., units=...)
```
A named `--cmap` (e.g. `YlOrBr`) is **ignored** here. And
`build_color_scale(None, ...)` produces *"a plain black→white ramp"*
(`luma_writer.py`). So `--data-encoded --cmap YlOrBr` with no `--cmap-file`
yields a **grayscale** globe with correct hover values — the single most
confusing symptom, because everything *looks* wired up.

Fix: supply the palette via `--cmap-file` (path/URL/s3) or, in this repo, the
`cmap_inline` convention (see pipeline-reference.md). `--legend-file` similarly
must be requested to emit a legend PNG.

## 4. Why width/height and preset:sos are forbidden

`--data-encoded` writes each frame at the **native source grid** on purpose:
resizing would average values that were never measured, corrupting the encoding.
zyra hard-errors on `--width`/`--height` with `--data-encoded`.

To get a larger frame (e.g. the 4096×2048 SOS spec), **regrid the DATA upstream**
in the `reproject` stage (`width`/`height`/`dst_bounds` there). Reprojection
resamples the data grid — a legitimate operation — whereas resizing a rendered
luma PNG averages luma.

The same trap at the video stage: `compose-video preset: sos` "pins 4096×2048"
and **rescales** the frames → averages luma → corrupts values, and does so
*silently* (no error, just subtly wrong hover values). Use `size: WxH` matching
the actual frame size, or omit it. (Frame *duplication* to hit 30 fps in the
downstream transcode is safe — it copies frames, doesn't blend — so a low
compose `fps` is fine and controls the loop duration.)

## 5. vmin/vmax

Required with `data_encoded`. A `vmax` far above the data's real maximum maps
nearly every pixel into the low/transparent end → a near-black globe with faint
detail. This is *distinct* from "scale not attached": here the scale IS attached
(hover works, legend would show), the coverage is just wrong. Set
`vmax ≈ p99.9` of the field (sample it — `scripts/sample_grib_range.py`).

## 6. The legend (why it's separate)

TerraViz on `main` has **no color-scale-driven gradient legend widget**. The
`color_scale` powers (a) the globe recolor and (b) the hover value readout. The
visible *colorbar* legend is a separate **image asset** (`legend_ref` →
`legendLink`), shown when set + the Tools→legend toggle is on
(`src/services/datasetLoader.ts`, `src/main.ts`). The Zyra publish PATCH does
**not** attach a legend image — so a workflow-published data-encoded dataset has
no legend until you attach one.

The real fix — a live colorbar rendered from `color_scale`, plus repalette /
stretch / threshold display transforms and an Analyze panel — lives on the
**unmerged** `claude/data-driven-video-analytics` branch (`src/ui/colorbarUI.ts`,
`src/services/colorScaleDisplay.ts`). Until it merges: stopgap `legend_ref` PNG
via `scripts/make_legend.py` + publisher form → Media.

## 7. Complete debugging map

| Symptom | Cause | Fix |
|---|---|---|
| Black globe, detail on zoom/stretch | `vmax` too high | sample range, `vmax ≈ p99.9` |
| Grayscale w/ detail, **hover works** | palette grayscale (`--cmap` ignored / none) | add `cmap_inline`/`cmap_file` |
| Grayscale, **no hover, no legend** | scale not attached | check publish `WARN`; ensure `data_encoded`+`color_scale_file`; ensure dispatch-path publish; check row `render_encoding`/`color_scale` |
| Color+hover OK, no legend | expected on `main` | attach `legend_ref` PNG; or ship analytics branch |
| Slightly-wrong hover values | luma rescaled | remove `preset: sos`/`width`/`height`; regrid in reproject |
| `... cannot be used with --data-encoded` | width/height on heatmap | remove them; regrid upstream |
| `403 Forbidden` on fetch | Cloudflare blocks CI IP | use S3/NODD source |
| `unrecognized arguments: --X` | pinned zyra lacks the arg / runner build predates a convention | check zyra version; `cmap_inline` needs the materialize-runner deployed |
