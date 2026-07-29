# export-dataset-video

Export a **data-encoded** catalog dataset as a standalone colour MP4, plus the
sidecars needed to use it outside the app (Science On a Sphere included).

## Why this exists

A dataset published with `renderEncoding: "data-luma"` ships frames whose luma
*is* the normalised value — black is `vmin`, white is `vmax`. The colour lives in
the row's `colorScale` sidecar and is applied by the globe shaders at draw time
(`docs/DATA_ENCODED_VIDEO_PLAN.md`). That is what makes the hover readout possible
and the dataset repalettable, but it means **downloading the published asset gets
you a greyscale field**. Anyone who wants a normal watchable video has to apply
the palette themselves. This does that.

It is the "one canonical copy" caveat in the plan doc showing up in practice —
that doc records the download story as follow-up work, and this script is the
stop-gap.

## Install

```bash
pip install av pillow numpy requests imageio-ffmpeg
```

`av` (PyAV) does the decoding and `imageio-ffmpeg` supplies an ffmpeg binary for
encoding. If you already have a system ffmpeg, pass `--ffmpeg /path/to/ffmpeg`.

## Use

```bash
python3 scripts/export-dataset-video/export_dataset_video.py \
  --dataset north-america-smoke \
  --out-dir export-out
```

`--dataset` takes a catalog slug or a ULID id. Run it with a bad name and the
error lists the data-encoded datasets the node currently publishes.

The `npm run export:dataset-video` alias calls `python3`. On Windows, where that
command usually isn't on `PATH`, invoke the launcher directly instead — everything
else is identical:

```bat
py -3 scripts/export-dataset-video/export_dataset_video.py --dataset north-america-smoke
```

## Output

| File | What |
|---|---|
| `<slug>.mp4` | Colourised video, no text burned in |
| `sidecar.json` | Frame → valid time, bbox + pixel→lat/lon formula, colour scale, provenance |
| `labels.txt` | One human-readable date **per movie frame** — the SOS label file |
| `legend.png` | The dataset's published legend |
| `thumbnail.png` | The dataset's published thumbnail |

Segments and basemap textures are cached under `<out-dir>/.cache`, so re-running
with different render options does not re-download anything.

## Things worth knowing

**The backdrop is not decoration.** H.264 has no alpha plane, but these palettes
are genuinely transparent — the smoke palette forces alpha to 0 below
`transparentRange`. That transparency has to resolve against *something*, so
frames are composited over the same equirectangular basemap the globe uses,
cropped to the dataset's bounding box so the two are in register. `--no-basemap`
gives flat black instead. Either way, bare backdrop means "below the transparency
cutoff", **not** "zero" — `sidecar.json` records the actual threshold.

**Frame timing is measured, not assumed.** The publish pipeline runs the data rate
below the video frame rate, so each forecast step is held for several encoded
frames (the RRFS smoke run: 636 encoded frames for 85 steps, ~7.48 each). The
script samples the middle of each hold and verifies the uniform-hold model against
the observed transitions, warning if they disagree.

**`labels.txt` is line-per-*movie-frame*, not per data step.** With the defaults
(`--fps-in 8 --fps-out 24`) every step is held 3 container frames, so 85 steps
produce 255 lines. SOS reads the file positionally, so a count that disagrees with
the real frame count silently shifts every label after the mismatch — the script
probes the finished MP4 and refuses to write the file if the numbers disagree.
For a 1:1 file, pass `--fps-out` equal to `--fps-in`.

Do **not** try to recover the step boundaries by diffing the *exported* MP4: the
basemap fills the frame, so x264's per-frame quantisation noise comes out as large
as the data's real frame-to-frame change (measured 0.462 noise vs 0.468 signal).
The source encode separates cleanly; the export does not.

## Options

| Flag | Default | Notes |
|---|---|---|
| `--node` | `https://terraviz.zyra-project.org` | Any node serving `/api/v1/catalog` |
| `--width` / `--height` | source size | Native is 4096×2048 for the RRFS runs |
| `--fps-in` / `--fps-out` | `8` / `24` | `--fps-out` must be an integer multiple |
| `--crf` / `--preset` | `18` / `slow` | x264 quality |
| `--dim` | `0.55` | Basemap brightness; lower if plumes look washed out |
| `--no-basemap`, `--no-borders` | off | Flat black / drop country lines |
| `--label-format` | `%a %b %d, %Y  %H:%M UTC` | Any `strftime` format |

## Language note

`scripts/` is otherwise TypeScript. This one is Python because it needs
frame-accurate H.264 decode, and shelling out to the ffmpeg CLI is not dependable
for that — a static ffmpeg build segfaults decoding 4096×2048 H.264 in the
container this was written in, while PyAV's libav bindings handle it fine. ffmpeg
is still used for encoding, which works.

The colour maths in `build_color_scale_lut` is a line-for-line port of
`buildColorScaleLut` in [`src/types/color-scale.ts`](../../src/types/color-scale.ts).
**If that file changes, change this too** — there is no shared test binding them.
