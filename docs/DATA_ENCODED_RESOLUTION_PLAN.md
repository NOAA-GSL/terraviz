# Higher-resolution data-encoded video: the 8192×4096 rung

**Status: draft for review.** The encode half is measured; the decode
half has two real devices and they disagree, which is the answer the
decision gate was written for. Nothing in Phases 1–3 is built. The
Phase 0 *instrument* is built, its 8K bundle is staged in
`public/luma-check/`, and the matrix now reads: **desktop Chrome
decodes the 8192×4096 rung at true native resolution; iOS Safari
refuses it outright.** That is the "a population that matters cannot
decode it" branch, so the route is Phase 1 **plus** Phase 2 rather
than Phase 1 alone. Four rows remain, and a live question sits behind
the green one — whether it decoded in hardware or in software at an
unwatchable rate.

**Last reviewed: 2026-08-13.**
**Revisit when:** the Phase 0 matrix fills past its first row; a data
source arrives that genuinely warrants more than 9.78 km; H.264 level
6.0 hardware decode becomes uniform enough to skip Phase 0; or
`DATA_ENCODED_RENDITIONS` changes for any other reason.

This is the implementation plan for the route
[`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) §Why the
frame is 4096×2048 ranks second — one larger single stream. That
section explains *why* the other three routes lose; this one says what
building this one would take.

---

## Context: what has actually been measured

An 8192×4096 test encode was run through the repo's exact data-encoded
settings — `libx264`, `-profile:v main`, `-pix_fmt yuv420p`, no colour
range or colourspace tags, `-preset slow`, `-crf 18`, and
`scale=…:flags=neighbor` — against a 4096×2048 control, on synthetic
frames carrying all 256 luma codes plus a band of random noise as a
storm-edge analogue.

Three things came out of it, one of them the opposite of what the
scoping section assumed.

**1. The frame size is not the problem.** x264 accepts 8192×4096 at
Main profile and stamps **level 6.0** — not 6.2. Levels 6.0, 6.1 and
6.2 share one 139,264-macroblock frame ceiling and differ only in
bitrate; 8192×4096 is 131,072 macroblocks, so it clears the *lowest* of
the three. The scoping section's "fits level 6.2, barely" understates
the compatibility position, since 6.0 is the better-supported tier.

**2. The bitrate cap is the problem, and it fails silently.**
`DATA_ENCODED_RENDITIONS` carries `maxBitrateKbps: 25_000` alongside
`height: 2048`. Quadrupling the pixels against an unchanged cap
quarters the bits per pixel, and the value round trip degrades in the
tail:

| encode | p50 | p99 | p99.9 | max\|e\| | fraction >5 |
|---|---|---|---|---|---|
| 4096×2048 @ 25 Mbps — control | 0 | 1 | 2 | 13 | 0.006% |
| 8192×4096 @ 25 Mbps | 0 | 1 | **7** | **152** | **0.117%** |
| 8192×4096 @ 100 Mbps | 0 | 1 | 2 | 18 | 0.012% |

At matched bits-per-pixel the 8K encode is indistinguishable from the
shipped rung. At the shipped cap it is not: the p99.9 error more than
triples and the fraction of badly-wrong texels goes up twentyfold.

The distribution matters more than the summary. Median and p99 are
identical across all three — the damage is entirely in the tail, and it
**clusters in high-spatial-frequency regions**. For a reflectivity
field that is precisely the convective cores, so bitrate starvation
corrupts the most interesting data first while leaving the calm
majority untouched. A spot check of open ocean would show nothing
wrong.

**3. The transport lattice is resolution-independent.** All three
encodes recovered **220 of 256** distinct codes, consistent with the
~219 the Encoder section documents. Going bigger neither helps nor
hurts value precision, exactly as the scoping section predicted.

### What has *not* been measured

**Whether anything decodes it.** This is the gating unknown and Phase 0
exists for it. An encoder accepting a frame size says nothing about an
iPhone, a Quest, or a mid-range Android accepting it, and the scoping
section's own warning — that hardware often advertises a level and tops
out at 4K — is unaddressed by any of the above.

Two lesser gaps. The test clip was 10 frames, so VBV never reached
steady state and the reported bitrates (40.5 / 69.7 / 160.8 Mbps) are
I-frame-dominated rather than representative. And the noise band is far
harsher than real model output: the 4K control's max\|e\| of 13 does
not match the max\|e\| 1 that `ffmpeg-hls.ts` records for the shipped
path, which means these absolute numbers are **not** comparable to that
figure. Only the 4K↔8K comparison under identical conditions is valid,
and that comparison is what the table above reports.

---

## Non-goals

- **Tiling, frame sequences, and bandwidth-adaptive ladders.** Ruled
  out with reasons in the scoping section. This plan is the single
  larger stream only.
- **More than ~8 effective bits per texel.** Orthogonal, and answered
  by §Why the chroma planes aren't spare precision.
- **Anything past ~35 MP.** 8192×4096 is the last frame size H.264
  admits. Beyond it the answer is a tiled pyramid with zoom-dependent
  LOD, which is a different renderer and its own plan.
- **Making 8K the default.** Every phase here is opt-in per dataset.
  9.78 km remains correct for the overwhelming majority of the catalog.

---

## Phase 0 — does anything decode it? (gating)

Nothing else in this plan is worth building until this returns. It is
also the cheapest phase, which is why it is first.

Produce one 8192×4096 data-encoded HLS bundle by hand, host it, and
open it on the device matrix. For each device record: does it play;
does `readyState` reach 2; does a `texImage2D` from the video element
succeed; and does a known texel read back the value it should.

The last one is the real test. A device that plays the video but
silently downscales it before the WebGL upload would look fine and
report wrong numbers — the same failure shape as the classified-palette
bug, and worth checking for explicitly rather than trusting playback.

Minimum matrix: desktop Chrome, Firefox, Safari; iOS Safari; one
mid-range Android; Quest browser. `docs/DATA_ENCODED_VIDEO_PLAN.md`
§Encoder already notes Safari and iOS Safari were unverified for the
colour-range decision, so this probe should close that gap at both
resolutions while it is set up.

### The probe

Built, as the `H_ceiling_8k` variant of `scripts/luma-range-check`. It
is the same encoder settings as the shipped data-encoded path, at
8192×4096 — deliberately not a new encoder question — so what it
measures is the device rather than the argv.

```bash
npx tsx scripts/luma-range-check --emit-static   # regenerate + stage
npx tsx scripts/luma-range-check --serve         # LAN URL for a device
```

`--emit-static` writes the bundle into `public/luma-check/`, so every
preview deploy serves it and testing a headset or a phone is a URL
rather than a network setup. The 8K encode adds **78 KiB** — flat bands
compress to almost nothing, so hosting it costs effectively nothing.
"Copy results" puts the whole record on the clipboard, because nobody
is transcribing a table by hand inside a Quest.

Two measurements were added beyond the four this section asks for.

**`MAX_TEXTURE_SIZE`.** A context whose limit is 4096 cannot hold an
8192-wide frame at all, so it settles the question for that device
before any decoding happens. This is a real mobile ceiling, not a
theoretical one — and the check's own CI renderer (SwiftShader) reports
exactly 8192, meaning the proposed rung sits *at* the limit with no
headroom rather than comfortably inside it.

**An isolated-spike region, and it is the one that matters.** The ramp
bands are 32 texels wide at this size, so they survive a silent 2×
downscale completely intact — a device that quietly halved the frame
would pass a ramp-only check while serving averaged values, which is
precisely the failure this section warns about and the same shape as
the classified-palette bug. The lower half of the frame therefore
carries single-texel spikes on a flat background. Measured through the
encoder: they read **252** at native resolution and **63** through a 2×
box downscale, so the `native` column separates the two cases by a
factor of four rather than by a judgement call.

### The matrix

Fill this in as devices report. A failure is a result, not a bug — only
`D_full_proper` sets the check's exit code, so a red row here does not
break CI.

| device / browser | decodes | readyState | decoded size | MAX_TEXTURE_SIZE | texImage2D | native | notes |
|---|---|---|---|---|---|---|---|
| desktop Chrome 150 (Win 11, Intel UHD 770, ANGLE/D3D11) | **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 252.0 | Values round-trip at 8K exactly as at 4K. Decode path unconfirmed; see below |
| desktop Firefox (Win 11) | *stalls* | — | — | — | — | — | Ran 2026-08-13, never returned. Stalling variant unattributed — see below |
| desktop Safari | | | | | | | |
| iOS Safari 26.6 (iOS 18.7, Apple GPU) | **no** | — | — | 16384 | — | — | `MediaError` code 4 at `loadeddata`; refused before playback. A–G at 4096×256 all decode and upload on the same device |
| mid-range Android | | | | | | | |
| Quest browser | | | | | | | |

**Row 1 — iOS Safari, 2026-08-13.** The rung is refused outright:
`MEDIA_ERR_SRC_NOT_SUPPORTED` fires on load, so `readyState`, decoded
size, `texImage2D` and `native` never get a value. There is nothing
ambiguous to interpret and nothing that could be a downscale in
disguise — the frame never arrives.

Three things this row settles, and one it does not.

**It is not the GL side.** `MAX_TEXTURE_SIZE` is 16384 on this device,
double what the rung needs — the headroom §The probe worried about
(SwiftShader reporting exactly 8192) is comfortable here. Had the video
decoded, WebGL would have held it. The ceiling is the video decoder,
which is the one layer no amount of our own code routes around.

**It is not a bad encode.** The same file's siblings play on this
device, and §Context already establishes 8192×4096 is 131,072
macroblocks against H.264's 139,264 ceiling — legal at level 6.0. The
most likely reading is that Apple's H.264 decoder implements up to
level 5.2 (4096×2304, ≈9.4 MP) and this frame is ≈33.6 MP, about 3.6×
beyond it. That is inference from a well-known platform limit, not
something this probe measured: `MediaError` 4 does not name a reason,
and the probe cannot distinguish an unimplemented level from any other
refusal. It does not change what to build either way.

**It pushes the decision gate toward Phase 2.** The gate says Phase 1
alone if the matrix is broadly green, Phase 1 + Phase 2 if a
population that matters cannot decode it. iOS Safari is named
explicitly in the minimum matrix and is not a population this project
can serve a broken globe to. One row is not the matrix, and the
remaining five could still change the shape of the answer — but they
can only make it worse for Phase-1-alone, since no other device
decoding it would make iOS decode it.

**What it does not settle: whether a smaller rung would clear.** This
probe tests one size. The gap between 4096×2048 (shipped, ≈8.4 MP) and
8192×4096 (≈33.6 MP) is a factor of four, and Apple's ≈9.4 MP limit
sits inside it — close to the shipped size, not the proposed one. The
largest **2:1** frame clearing level 5.2 is 4320×2160 (36,450
macroblocks against the level's 36,864), which is 5% more linear
resolution than ships today. A middle rung is therefore not worth
building: the whole usable headroom below Apple's ceiling is a rounding
error on the frame we already publish. Recording it here so the option
is rejected on its size rather than quietly forgotten and re-derived.

**Row 2 — desktop Chrome, 2026-08-13.** The rung decodes, and it
decodes *properly*. `readyState` 4, decoded size 8192×4096, a clean
`texImage2D`, and — the measurement this section was built around — a
spike mean of **252.0** against the 200 threshold, so the frame is
genuinely native and not a silently halved one wearing the right
dimensions. Values round-trip at 8K exactly as they do at 4K (220/256
exact, gain 1.0005, max|e| 1), which is the useful confirmation that
quadrupling the frame costs nothing in fidelity.

**But the decode path is unconfirmed, and this is the row the
software-decode caveat was written for.** Intel's Quick Sync H.264
decoder does not reach 8192 wide — its ceiling is 4096 — so a UHD 770
almost certainly did not decode this in hardware, which leaves
Chrome's ffmpeg software fallback. That is consistent with everything
observed and is still inference: the probe reads one frame after a
seek and never asks how fast frames arrive, so a decode that took a
second per frame looks identical here to one that took a millisecond.

Confirming it is cheap and should happen before this row is treated as
green. Open `chrome://media-internals` while the check runs and read
the decoder name: `D3D11VideoDecoder` or `MojoVideoDecoder` means
hardware, `FFmpegVideoDecoder` means software. Then watch the 8K clip
play and see whether it holds a watchable rate. If it is software at a
few frames per second, this row does not unblock Phase 1 for desktop
either, and the honest reading of Phase 0 becomes "nothing in the
matrix can play this," not "desktop can."

**Row 3 — desktop Firefox, inconclusive, and the probe's fault.**
Firefox on Windows 11 ran the check and never returned anything at
all. That is a third distinct behaviour: iOS Safari declines cleanly
with a `MediaError`, desktop Chrome accepts, and Firefox neither
fires `loadeddata` nor `error` — it simply stops.

The probe made this worse than it needed to be, in two ways now fixed.
Its waits on `loadeddata` and `seeked` were unbounded, so an element
that fires no event either way hangs the run indefinitely; and the
table rendered only after every variant completed, so the stalled
variant discarded the results of the seven that had already passed.
The observation therefore cannot say *which* variant stalled, which is
the one thing worth knowing. Both waits are now capped at 30 s, a
timeout is recorded as its own outcome distinct from a load failure,
and results repaint after each variant with the variant in flight
named on screen.

Re-running Firefox against the updated page should attribute the stall
and fill this row. The likely answer is that it stalls on
`H_ceiling_8k` and the 4096×256 variants were all fine — but that is a
guess, and the row stays inconclusive until the re-run says so. Worth
recording either way: a decoder that stalls rather than declines is
harder for the Phase 2 fallback to detect than one that errors,
because there is no event to trigger on. If Firefox turns out to
behave this way on the 8K rung, Phase 2 needs a timeout of its own
rather than an `error` handler.

**A different browser on iOS does not help, so the row is the
platform.** Chrome, Firefox and Edge on iOS are WKWebView — App Store
policy requires it, and although iOS 17.4 opened alternative engines to
EU builds via BrowserEngineKit, no major browser ships one. The
stronger reason is one layer down: H.264 decode goes through
VideoToolbox to a fixed-function hardware block, so the engine on top
does not change which levels exist. A hypothetical Blink-on-iOS would
be refused the same frame. Software decode is not a way out either at
≈33.6 MP per frame on a phone. Record iOS results per *device*, not
per browser; one row covers all of them.

**A green row may still be an unusable one.** The probe seeks to 0.2 s
and reads a single frame, which answers "does a frame decode" and not
"does this play." Desktop Chrome falls back to software H.264 decode
where hardware declines, and a software decode of a 33.6 MP frame can
easily succeed once and then sustain nothing like a watchable rate. So
a desktop row that comes back green is necessary but not sufficient
evidence, and Phase 1 should not be unblocked by one without a
framerate observation beside it. Row 2 is exactly that case and is
recorded green-with-an-asterisk for it. On iOS the caveat is moot —
nothing decoded at all.

**Not yet covered by the probe: HLS delivery.** It serves a progressive
MP4, which isolates the decoder from the delivery layer and is what the
existing check already does. The shipped path is HLS, and
`MediaSource.isTypeSupported()` is documented as optimistic about level
— so a device may well decode this MP4 and still refuse the same stream
through MSE. That is a second question, worth answering before Phase 1
is built, and it is not answered here.

**Decision gate.** If the matrix is broadly green, Phase 1 alone is
enough and Phase 2 is never built. If a population that matters cannot
decode it, Phase 1 plus Phase 2. If almost nothing decodes it, stop —
and record the result here so the question is not reopened from scratch.

## Phase 1 — the 8192×4096 rung

Assumes Phase 0 passed.

| change | file | note |
|---|---|---|
| Add the rung | `cli/lib/ffmpeg-hls.ts` | `DATA_ENCODED_RENDITIONS` is a single-element `readonly` tuple at `height: 2048`. Needs to become per-dataset rather than a module constant. |
| **Scale `maxBitrateKbps` with pixel count** | same | The measured failure. 25 Mbps at `height: 4096` corrupts values. Either scale to ~100 Mbps or drop the cap and let `crf 18` drive, but it must not bind. |
| Bump `segmentDescriptorHash` | `cli/lib/hls-incremental.ts` | `v: 1` → `2`. Its own docstring warns ladder-wide codec settings are not per-rendition fields; without the bump, segments cached under the old settings get recycled into a bundle carrying the new ones. |
| Accept the resolution | `cli/lib/sos-spec.ts` | Currently *warns* (not fails) on anything other than 4096×2048. Should stay quiet for a data-encoded dataset legitimately at 8192×4096. |
| Publisher opt-in | publisher API + portal | Which datasets get the rung. Transcode cost and storage both roughly quadruple, so this cannot be automatic. |
| Extend the round-trip check | `scripts/luma-range-check` | Add an 8192×4096 variant beside the existing ones, so the fidelity property is guarded rather than measured once by hand. |

**Deploy ordering:** the runner must ship before any dataset opts in, or
a pipeline requests a rung the transcoder does not know how to build.

**The `crf`-versus-`maxrate` question is worth deciding deliberately.**
The measurement shows the cap binding and corrupting values, but the
delivered bitrate on real content is whatever `crf 18` asks for, which
for a smooth field is far below either cap. The synthetic noise band
demanded ~160 Mbps and is not representative. Before picking a number,
encode one real 8K reflectivity or aerosol frame set and see what it
actually wants.

## Phase 2 — pinned two-rung ladder (only if Phase 0 says so)

Build this only if a population that matters fails Phase 0. It is
strictly more complexity than Phase 1 and buys nothing if 8K decodes
everywhere.

Publish 8192×4096 and 4096×2048, resolve capability once at load, then
**pin** — `hls.currentLevel`, which locks a rung — rather than
`autoLevelCapping`, which leaves ABR free to move beneath the cap.
Keep `hlsService`'s existing media-error handler as the escape hatch,
since a decode failure is real capability information.

The open design question is what "resolve capability" means in code.
`hlsService` today caps on screen dimension, with a comment noting
`capLevelToPlayerSize` does not work here because the canvas is not
sized at first-frame decode. Screen size is a poor proxy for decoder
capability, and `MediaSource.isTypeSupported()` is documented as
optimistic about level — it commonly returns true and then falls back
to software decode, which is a performance collapse rather than a clean
failure. Phase 0's matrix is what should decide this; do not guess it
in advance.

Two consequences to carry:

- **The rungs disagree about values.** The downscale must be
  `flags=neighbor` per the Encoder section, and neighbour decimation
  means the 4K rung samples the 8K one rather than averaging it. Two
  viewers on different hardware read different numbers at the same
  lat/lon. Neither is wrong; they are different samplings.
- **That has to surface.** The Analyze panel already carries a
  quantisation caveat and needs a resolution one beside it, with a new
  i18n key. Whether a CSV export should record which rung produced it
  is an open question — see below.

---

## Verification

- The Phase 0 matrix, recorded here as a table rather than a verdict,
  including the read-back-a-known-texel result per device.
- `scripts/luma-range-check` extended with an 8192×4096 variant —
  **done** (`H_ceiling_8k`) — and passing on every browser it currently
  covers, which is still outstanding: the extension has been verified
  against a synthetic texture (band addressing exact, 256/256), but no
  browser has yet decoded the 8K stream, since CI's Chromium ships no
  H.264 decoder at all.
- One real 8K dataset published and probed end to end: hover value,
  Analyze statistics, and a contour pass, each compared against the same
  dataset at 4096×2048. The statistics will differ — that is expected
  and is the point of the caveat line — but they should differ by
  resampling, not by the tail corruption Phase 1's bitrate change fixes.
- A deliberate negative: confirm a device that *cannot* decode the 8K
  rung degrades the way Phase 0 predicted, rather than silently
  presenting downscaled values as measured ones.

## Open questions

1. **Should a reported value carry its resolution?** If two viewers
   read different numbers, an Analyze CSV export arguably has to record
   which rung produced it, or the file is not reproducible. Leaning yes,
   but it widens the export schema.
2. **What bitrate does real 8K content actually want?** See Phase 1.
   Nobody should pick a cap from the synthetic measurement above.
3. **Is 4.89 km worth it at all?** The honest possibility is that
   quadrupled transcode cost, quadrupled storage, and a device-support
   cliff buy a resolution nobody asked for. The scoping section ranks
   "accept 9.78 km" first for a reason. This plan should not be built
   speculatively — it wants a dataset whose value is visibly limited by
   the grid.
