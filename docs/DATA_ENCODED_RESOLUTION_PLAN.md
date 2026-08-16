# Higher-resolution data-encoded video: the 8192×4096 rung

**Status: draft for review.** The encode half is measured; the decode
half has five conclusive devices and one inconclusive, and the results
split by browser *and* by platform with no clean rule joining them.
Nothing in Phases 1–3 is built. The Phase 0 *instrument* is built and
its 8K bundle is staged in `public/luma-check/`.

**The matrix so far: three accepts, two refusals, one stall — and the
same OS lands on both sides.** Windows Chrome, macOS Safari and a
Quest 3 all decode the 8192×4096 rung at true native resolution. macOS
Chrome refuses it on the same machine Safari accepts it on, iOS Safari
refuses it, and Windows Firefox stalls without returning anything.
Neither "Apple platforms can't" nor "Chrome can" survives contact with
the full set. Two attempts at a generalisation were written into this
document and each was falsified by the next device to report — the
per-row records stand, the rules drawn from them did not, and the
lesson is to record the (platform, browser) pair and wait for the
matrix rather than extract a rule from half of it.

**What the accepts have changed:** they now span x86 desktop, Apple
silicon and a mobile ARM headset, so the rung is decodable rather than
merely survivable by workstations, and the doubt hanging over the
desktop rows is no longer about whether the frame can be decoded at
all. **What they have not changed:** the gate still sits on its middle
branch, because iOS Safari cannot decode it and is not a population
this project can serve a broken globe to. Phase 1 alone is not enough;
Phase 2 is load-bearing rather than optional.

**Playback is now measured on a 7200×3600 stand-in, and it passes on
the device that mattered most.** The clip is 25.9 MP against the rung's
33.6 MP — **23% fewer pixels** — so read the margins, not just the
verdicts: upload cost scales with pixel count, which would put the
Quest's 4.69 ms mean nearer 6.1 ms at the full rung. Still inside the
11.1 ms budget, but with less room than the number below suggests, and
the full rung's sustained cost is an open check rather than a measured
one. The Quest 3 holds 0.994× of real time with zero dropped frames
and a 4.69 ms mean texture upload against its 11.1 ms budget at 90 Hz —
better than either desktop, because a software-decoded frame is already
in memory its unified-memory GPU can address, while a discrete card has
to pull it across PCIe first. Desktop Chrome also keeps up, with an
occasional p95 hitch at 60 Hz.

So the remaining blockers are the two refusals, not performance: iOS
Safari and macOS Chrome still cannot decode the rung at all. Mid-range
Android is the only unmeasured row.

**Last reviewed: 2026-08-16.**
**Revisit when:** mid-range Android reports, or Firefox is re-run
against the fixed harness; an HEVC/AV1 rung is measured, since H.264
caps hardware decode at 4096 wide and that may matter more than the
frame size; `DATA_ENCODED_RENDITIONS` changes; or the full 8192×4096
rung is played rather than the 7200×3600 stand-in.

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

**~~Whether anything decodes it.~~ Answered — see §Phase 0.** This was
the gating unknown when the section was written; the matrix now records
three native decodes, two refusals and one stall. What remains
unmeasured is narrower and listed there: mid-range Android, a Firefox
re-run, HEVC/AV1 as an alternative to H.264, and the full 8192×4096
rung under playback rather than the 7200×3600 clip that stood in for
it.

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
| desktop Chrome 151 (macOS, M2 Ultra, ANGLE Metal) | **no** | — | — | 16384 | — | — | `MediaError` 4, and no software fallback — while Safari on the same OS accepts |
| desktop Firefox (Win 11) | *stalls* | — | — | — | — | — | Ran 2026-08-13, never returned. Stalling variant unattributed — see below |
| desktop Safari 26.5.2 (macOS, Apple GPU) | **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 252.0 | Decodes what Chrome on the same OS refuses. Decode path unconfirmed |
| iOS Safari 26.6 (iOS 18.7, Apple GPU) | **no** | — | — | 16384 | — | — | `MediaError` code 4 at `loadeddata`; refused before playback. A–G at 4096×256 all decode and upload on the same device |
| mid-range Android | | | | | | | |
| Quest 3 (OculusBrowser 149, Adreno 740) | **yes** | 4 | 8192×4096 | **8192** | ok | **yes** — spike 251.0 | Texture limit *equals* the frame width: fits with zero headroom |

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

**Row 4 — macOS Chrome.** Chrome 151 on an M2 Ultra refuses the rung
with the same `MediaError` 4 as iOS Safari, and does not attempt a
software fallback despite considerably more CPU headroom than the
Windows box had.

This row was first written up here as settling the
browser-versus-platform question: Blink and WebKit refusing alike on
Apple hardware while the same engine accepted on Windows, therefore
the platform decides. **Row 5 inverts that.** Safari on the same OS
decodes the frame, so the refusal belongs to Chrome-on-macOS
specifically rather than to macOS, and neither half of the pair
generalises on its own.

The 4096×256 variants all pass here, but not in the way any other
device passes them; see
[`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) §Encoder,
where this row alone costs the full-range recommendation its
universality.

**Row 5 — macOS Safari, which breaks the pattern.** Safari 26.5.2
decodes the rung: `readyState` 4, decoded size 8192×4096, clean
`texImage2D`, and a spike mean of **252.0** against the 200 threshold,
so the frame is genuinely native rather than quietly resampled. Values
round-trip at 8K exactly as at 4K (220/256, gain 1.0005).

Two conclusions recorded earlier in this section die here, and it is
worth naming them rather than editing them away:

- *"Every Apple platform refuses the rung, on both engines."* False.
  macOS Safari is an Apple platform and it accepts.
- *"The browser is not the variable; the platform's decoder is."*
  Inverted. On one macOS machine Safari accepts and Chrome refuses,
  which is the browser being exactly the variable.

What survives is narrower and less quotable: **the (platform, browser)
pair decides, and neither half predicts the answer alone.** iOS Safari
refuses what macOS Safari accepts, so WebKit does not carry the
capability with it. macOS Chrome refuses what macOS Safari accepts, so
neither does the OS. Both generalisations were written after a single
new device and both lasted exactly one more device; the matrix is the
artifact, not the rule someone extracts from it half-full.

**The framerate question applies here too.** Apple's hardware H.264
block does not reach 8192 wide either, so this accept is most likely
VideoToolbox software decode — plausible on an M2 Ultra and evidence
of nothing at all about a MacBook Air or an older Mac. One frame after
a seek is not playback. This row needs the same watch-it-actually-play
check row 2 does before it counts as a capability rather than a
curiosity.

**Row 6 — Quest 3, the accept that changes the reading.** The rung
decodes: `readyState` 4, 8192×4096, clean `texImage2D`, spike mean
**251.0**, native. The two desktop accepts could both be explained away
as workstations brute-forcing a software decode. An Adreno 740 in a
headset cannot be explained that way, and it is the first evidence
that the rung is decodable rather than merely survivable on hardware
with room to spare.

**`MAX_TEXTURE_SIZE` is 8192 — exactly the frame width.** §The probe
flagged this as a worry when CI's SwiftShader reported 8192; it is now
confirmed on the real device class most likely to want the rung. The
frame fits with **zero headroom**: a single texel wider and this device
could not hold it at all, no matter what the decoder managed. Two
consequences worth writing down. Nothing above 8192 wide is available
on this hardware, so the ladder in Phase 3 has a hard ceiling here
rather than a soft one. And the margin between "works" and "cannot be
uploaded" is one texel, so the 8192×4096 geometry is not a starting
point to be nudged later — it is the terminal rung for this device
class.

**And this is where the framerate question is sharpest.** A headset
must hold 72–90 Hz or it is unusable in a way a stuttering desktop
video is not, and this is simultaneously the device where the rung's
angular resolution would matter most. A decode that lands one frame
after a seek says nothing about that. Play the 8K clip in the headset
and watch it before this row counts as a capability.

### Does it play? — measured, and the GPU barely matters

**Windows Chrome 150, 7200×3600 at 25 Mbps, 2026-08-16.** The same clip,
same machine, on both of its GPUs:

| device | mean | implied | p95 | max |
|---|---|---|---|---|
| Intel UHD 770 (integrated) | 11.47 ms | 9.0 GB/s | 30.20 ms | 40.40 ms |
| RTX 4090 Laptop (discrete) | **9.89 ms** | 10.5 GB/s | 19.60 ms | 37.40 ms |

**A 4090 is 1.16× faster than an integrated Intel part at this, and it
has on the order of fifty times the memory bandwidth.** That single
comparison is worth more than either number on its own: whatever
`texImage2D` is spending its time on here, it is not GPU memory
bandwidth, or the discrete card would have walked away with it.

The likely explanation is that the frame never gets near the GPU until
the very last step. **H.264 hardware decode is capped at 4096×4096 on
essentially all consumer silicon** — Intel Quick Sync, NVIDIA NVDEC and
Apple VideoToolbox alike; the 8K decode those parts advertise is for
HEVC and AV1, not H.264. A 7200-wide H.264 stream is therefore
software-decoded on the CPU *whichever* GPU is active, lands in system
memory, and the per-frame cost is the CPU-side colour conversion and
copy — which scales with pixel count and is indifferent to the card it
is eventually handed to. 10 GB/s is an entirely ordinary figure for
that path.

**This reframes Phase 1: the lever is the codec, not the resolution.**
The plan has assumed H.264 throughout because that is what the shipped
ladder emits. But an HEVC or AV1 rung could get *hardware* decode at
8K where H.264 structurally cannot, keeping the frame in GPU memory and
turning the upload into a GPU-side copy rather than a bus transfer.
That is a different and much more promising question than "can we make
the H.264 frame bigger", and it should be answered before Phase 1 is
built. It is inference from a well-known hardware limit plus this
measurement, not something the probe verified directly.

**Playback itself is fine, and consistently so.** All three runs held
0.973–0.975× of real time at the app's own 1.88 fps. Decode is not the
constraint at the rate a data-encoded dataset actually plays.

**The dropped-frame count is a startup artifact, not sustained loss.**
Every run reported exactly **5 of 31**, unchanged across two different
GPUs and three runs. A figure that identical is deterministic — the
first frames as playback starts — rather than 16% of timesteps being
lost throughout. Worth correcting, because "16% of forecast hours never
displayed" was the wrong reading of it.

**Against the frame budget**, on the better of the two GPUs: the mean
(9.89 ms) fits 90 Hz with little room; the p95 (19.60 ms) is 1.77× the
90 Hz budget and still 1.17× the 60 Hz one. So the hitch is real but
occasional, and it arrives roughly twice a second at this playback
rate.

**Row 2 — Quest 3, and it beats both desktops.** The device with the
tightest frame budget, the narrowest memory bus, and no texture
headroom is the fastest of the three by a wide margin:

| device | mean | p95 | budget | mean | p95 |
|---|---|---|---|---|---|
| Intel UHD 770 | 11.47 ms | 30.20 ms | 60 Hz | 0.69× | 1.81× |
| RTX 4090 Laptop | 9.89 ms | 19.60 ms | 60 Hz | 0.59× | 1.17× |
| **Quest 3 / Adreno 740** | **4.69 ms** | **5.10 ms** | **90 Hz** | **0.42×** | **0.46×** |

Playback held **0.994×** with **zero dropped frames** — better than
either desktop on every metric, and 2.1× the 4090 on mean upload, 3.8×
on p95. Implied throughput is 22.1 GB/s against the 4090's 10.5.

**The likely reason is that a discrete GPU is a handicap here.** The
frame is software-decoded into system memory; on the laptop it must
then cross PCIe to VRAM, and the card's enormous local bandwidth never
comes into play because the bottleneck is upstream of it. The Quest has
unified memory and, on Android, Chromium can hand a decoded video frame
to GL through `SurfaceTexture`/`EGLImage` with little or no copy. The
frame is already where the GPU can see it. That also explains why the
Intel part — unified memory but no such fast path in the Windows media
stack — is the slowest of the three.

**Read the budgets by device, which the earlier rows did not.** 90 Hz
only applies to VR. A desktop globe renders at 60 Hz, where the 4090's
mean is 0.59× of budget and only its p95 slightly exceeds it. The
device that genuinely needs 90 Hz is the Quest, and it comes in at
0.42× and 0.46×. Both pass; the desktop's occasional p95 hitch is the
only wart, and it lands on the platform where a dropped frame costs
least.

**This reverses what this section predicted.** It called the Quest
decisive and expected it to fail — "if the upload cost there is
anything like this row's, the rung is not viable in VR at 7200×3600."
It is not like it. It is twice as good, and the prediction was drawn
from a measurement taken on the wrong GPU and generalised to hardware
with a different memory architecture.

**One caveat worth keeping.** The Adreno is a tile-based renderer, and
this probe's own comment notes that a tiler can report near-zero for
work it has merely queued. `gl.finish()` after a `texelFetch` draw
should force the upload to resolve, but a result that inverts the
expected ordering deserves more scrutiny than one that confirms it. If
Phase 1 is going to rest on this row, it is worth a second measurement
that does not depend on `finish()` semantics — a sustained render loop
at 90 Hz with the upload in it, and the frame rate observed rather than
timed.

**Two limits still apply.** The probe calls `gl.finish()` before
stopping the clock, deliberately, so these are an upper bound on what a
pipelined renderer pays. And this is a laptop 4090: upload crosses PCIe
from system RAM, so a desktop card with the same silicon would not
necessarily do better, since the bottleneck appears to be upstream of
the bus anyway.

<details>
<summary>Superseded first run — measured on the wrong GPU</summary>

### Does it play? — first measurement (superseded, wrong GPU)

**Retracted before it was acted on.** The numbers below were measured on
an **Intel UHD 770**, on a machine that has an RTX 4090. The probe
created its WebGL context without a `powerPreference`, so the browser
handed it the integrated GPU — while MapLibre asks for
`powerPreference: "high-performance"` and gets the discrete one. The row
therefore measured upload bandwidth on a device the 2D globe never uses.

The probe now requests `high-performance` to match MapLibre and prints
what was granted alongside what was asked for. The reasoning below about
*where* the constraint lies still holds — decode keeps up, the upload is
what costs — but every absolute number is from the wrong hardware and
must be re-measured.

**One thing this did surface, and it is not a probe bug.** MapLibre asks
for the discrete GPU; **Three.js does not** — its `WebGLRenderer` default
is `powerPreference: 'default'`, and nothing under `src/` overrides it.
So on a hybrid-graphics desktop the VR/AR globe and the Orbit character
page may be rendering on integrated graphics while the 2D globe uses the
discrete card. That deserves checking on its own account, independent of
this plan: a PCVR session on an iGPU would be far more damaging than a
slow texture upload. It does not affect the Quest, which has one GPU.

**Windows Chrome 150, Intel UHD 770 (unintended), 7200×3600 at 25 Mbps, 2026-08-15.**

```
realtime=0.975x  presented=1.8fps  frames=22 over 12.0s  loops=1
dropped=5/31 (16.13%)
texImage2D mean=11.47ms  p95=30.20ms  max=40.40ms
```

**Decode is not the bottleneck, and that reverses the assumption this
plan was built on.** At the rate the app actually plays a data-encoded
dataset — `MIN_PLAYBACK_RATE` 0.0625×, i.e. 1.88 fps — the clip held
0.975× of real time. The decoder is asked for roughly two frames a
second and delivers them. Every worry in §Context about sustained
decode throughput was aimed at the wrong layer.

**The texture upload is the constraint.** A 7200×3600 RGBA upload moves
**103.7 MB per frame**, and the measured times imply 9.0 GB/s at the
mean falling to 2.6 GB/s at the worst — plausible for an integrated GPU
on shared memory, and not something a faster decoder or a lower bitrate
improves. Against a render frame budget:

| | mean 11.47 ms | p95 30.20 ms |
|---|---|---|
| 90 Hz (11.1 ms) | 1.03× over | **2.72× over** |
| 72 Hz (13.9 ms) | 0.83× | **2.17× over** |
| 60 Hz (16.7 ms) | 0.69× | **1.81× over** |

Aggregate cost is small — 1.88 uploads/s × 11.47 ms is **22 ms per
second**, about 2% of the main thread. The problem is not the total but
the *distribution*: it arrives in one lump roughly twice a second, and
each lump overruns a 90 Hz frame. That is a visible hitch on a cadence
slow enough to notice individually rather than a uniform slowdown.

**Dropped frames matter more here than for ordinary video.** 5 of 31 is
16%, and each dropped frame of a data-encoded dataset is a *skipped
timestep* — a forecast hour the viewer never sees — rather than a
skipped picture nobody misses.

Two limits on how far to read this row.

**The probe's own stall inflates the number.** `uploadAndDraw` calls
`gl.finish()` before stopping the clock, deliberately, so the time lands
on the frame that caused it rather than measuring how fast the driver
accepts work. That makes these an *upper* bound on what a pipelined
renderer pays, and it may be causing some of the dropped frames itself.
For a transfer-bound operation the bound is fairly tight — 103.7 MB has
to cross the bus whenever it is attributed — but the p95 in particular
should not be read as a number the app would necessarily hit.

**This is the weakest GPU in the matrix.** An Intel UHD 770 on shared
memory is the floor, not the median; a discrete GPU or Apple silicon
should do considerably better.

**What it makes decisive: the Quest.** It has the tightest budget
(72–90 Hz, where the mean already fails), the narrowest memory bus, and
`MAX_TEXTURE_SIZE` exactly equal to the frame width. It is also the
device where the extra resolution would matter most. If the upload cost
there is anything like this row's, the rung is not viable in VR at
7200×3600 regardless of the decode result — and that, not decoding,
becomes the reason to stop.

</details>

**A different browser does not help on iOS, and that much is
structural.** Chrome, Firefox and Edge on iOS are all WKWebView, since
App Store policy requires it and no major browser has shipped an
alternative engine even after iOS 17.4 opened the door in the EU.
Below the engine, H.264 decode goes through VideoToolbox, and software
decode is not a way out at ≈33.6 MP per frame on a phone. One row
covers every browser on iOS.

**It does not extend to macOS**, which is where an earlier version of
this note overreached. Browsers there bring their own engine *and*
their own decode policy, and rows 4 and 5 disagree on the same
machine — Safari decoding what Chrome refuses. Test each browser on
macOS; test the device on iOS.

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

**The playback clip is deliberately not committed.** `play.html` takes
its clip from `?clip=`, so it carries no asset of its own. The real
7200×3600 clips measured for this section are ~4.3 MB at the shipped
25 Mbps ceiling and ~17.3 MB at 100 Mbps, and git history is
permanent — that is a large one-way cost for a diagnostic that runs a
handful of times. Reproduce them instead, from
`scripts/encode-geotiff-sequence.ts`, and serve them locally:

```bash
# out/ under the check is gitignored, so nothing can be committed by accident
cp real_7200_25mbps.mp4 scripts/luma-range-check/out/
npx tsx scripts/luma-range-check --serve      # prints a LAN URL
# then, on the device:
#   http://<lan-ip>:8791/play.html?clip=/out/real_7200_25mbps.mp4
```

The LAN restriction that motivated `--emit-static` does not bite here:
the devices worth playback-testing are the ones that *accept* the rung,
and iOS — the browser hardest to reach over a LAN — already refuses it
at the decode stage. If a future run needs a device off the network,
committing the 25 Mbps clip alone is the minimal version of that
decision, not both.

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
  **done** (`H_ceiling_8k`), and **run on six real devices**: three
  native decodes (Windows Chrome, macOS Safari, Quest 3), two refusals
  (iOS Safari, macOS Chrome), one stall (Windows Firefox, inconclusive
  and awaiting a re-run against the fixed harness). CI still cannot
  contribute a row — Playwright's Chromium ships no H.264 decoder at
  all — which is why `--serve` and the static bundle exist.
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
3. ~~**Is 4.89 km worth it at all?**~~ **Answered, 2026-08-16.** The
   question asked for a dataset whose value is visibly limited by the
   grid, and MPAS 3 km reflectivity is one. Published at the shipped
   4096×2048 rung it lands at **9.78 km per texel — 3.3× coarser than
   its own source grid** — and at storm-scale zoom the texels are
   plainly visible as blocks, with individual convective cells a
   handful of texels across.

   That is the justification this plan was missing, and it is worth
   being precise about what it does and does not establish. It shows
   the grid is the binding limit *for this dataset*, not that 4.89 km
   is worth quadrupled transcode and storage for the catalog at large —
   the scoping section still ranks "accept 9.78 km" first, correctly,
   for the overwhelming majority of rows. What changes is that Phase 1
   would no longer be built speculatively: there is now a real dataset,
   already published, that it visibly improves.

   Note the arithmetic does not stop at 4.89 km. Even an 8192-wide
   rung leaves MPAS 1.6× coarser than native, so this buys a
   substantial improvement rather than parity.
