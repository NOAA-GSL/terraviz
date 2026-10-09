# Multi-monitor output — operator runbook

Status: first edition, written from two Windows hardware passes and
one Linux (WSL) sitting. §3.6 (projector rigs) was added 2026-09-29,
before any projector rig has run it.
Last reviewed: 2026-09-29

This is the deployment half of
[`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) — rung 15 of its
delivery ladder. The plan says how the feature is built; this says
how to stand one up and what to check before an audience is in the
room.

It is written for whoever provisions the machine driving a Science
On a Sphere installation, a dome or a projector array. It assumes
no knowledge of the codebase.

**The organising idea:** almost everything that has gone wrong on
real hardware was *invisible* — a correct-looking picture at a
fraction of the provisioned capacity, a control that renders as an
empty box, a monitor silently negotiating half its refresh rate.
None of it threw an error. So this document is mostly a list of
things to **look at** rather than things to do, and the order
matters: the checks in §1 will change what you conclude from
everything after them.

---

## 1. Before anything else: three hardware checks

Do these before adding a single output. Each one has silently cost
a hardware session.

### 1.1 Which GPU is actually rendering?

**This is the check that matters most, and the app cannot make it
for you.** A hybrid-graphics machine can put the webview on the
integrated GPU while a discrete card sits idle. The picture is
correct. Nothing is logged. The installation runs at a fraction of
what it was specified for.

The app's own `powerPreference` hint is inert — neither the
webview layer nor Tauri reads an override — so the only defence is
to look.

| Platform | How to check |
|---|---|
| Windows, macOS | Turn on the debug overlay (Outputs panel → Debug overlay) and read the **gpu** field on the output itself |
| **Linux** | `glxinfo` (below) — **the in-app field does not work here** |

On Linux, from a terminal with the same environment the app will
launch in:

```bash
sudo apt install mesa-utils          # provides glxinfo
glxinfo -B | grep -iE "renderer|device"
```

That Linux exception is not a nicety. WebKitGTK sanitises the
WebGL renderer string, so the **gpu** field reads `Apple GPU` on
every Linux machine regardless of hardware. The one in-app
mitigation for this risk is blind on the platform SOS
installations most often run. Measured on a laptop with an RTX
4090: the HUD said `Apple GPU`, and `glxinfo` said
`D3D12 (Intel(R) UHD Graphics)`.

If it names the wrong adapter, the fix is per-OS and outside the
app:

- **Windows** — Settings → System → Display → Graphics, add the
  executable, set *High performance*. Vendor control panels
  (NVIDIA Control Panel → Manage 3D settings → Program Settings)
  do the same thing and one may stick where the other does not.
- **Linux, PRIME offload** — launch with
  `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`,
  or `DRI_PRIME=1` on a Mesa-only stack.
- **macOS** — generally automatic, with no user-facing override
  for a webview.

**Confirm the override took before drawing any conclusion from
it.** Re-run the check above with the same environment the app
will launch in. An override that silently did not apply looks
exactly like one that did.

### 1.2 What refresh rate is the output monitor running?

The output's render loop rides the compositor's frame clock, so
the display's refresh rate is a hard ceiling on its frame rate.
A 4K panel that negotiates 30 Hz caps that output at 30 fps and
leaves it **no headroom at all**.

This happens silently, and the usual cause is the cable path
rather than the panel: 4K over HDMI 1.4, or a shared DisplayPort
budget on a dock renegotiating modes when another monitor is
plugged in.

**Give each output monitor a direct cable from the discrete GPU.
Not a dock.** A dock also forces a cross-adapter copy every frame
— one machine rendered on a 4090 while an Intel iGPU scanned out,
with the copy sitting in a region no in-app measurement can see.

Check it in the OS display settings, and re-check after plugging
in the *last* monitor rather than the first.

### 1.3 Screen savers and display sleep

Installations run for hours with no input. Tauri has no
cross-platform wake-lock API, so this is not something the app can
prevent — **disable screen savers and display sleep in the OS
settings**, per monitor where the OS allows it. On Linux also
check the desktop environment's own idle settings, which are
frequently separate from the power settings.

---

## 2. Linux prerequisites

Two package sets. Neither is installed by default on Ubuntu, and
**both fail silently in ways that do not look like missing
packages.** Add `mesa-utils` while you are here — §1.1's GPU check
needs `glxinfo`, and on Linux that check is the only one there is.

### 2.1 Media codecs — without these, no video plays at all

```bash
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
                 gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

WebKitGTK answers "can you play this?" through GStreamer. Without
the H.264 plugin sets, every HLS dataset — which is most of the
catalog — fails to load. The error the user sees names their
connection.

### 2.2 Fonts — without these, the controls are empty boxes

```bash
sudo apt install fonts-noto-core fonts-noto-color-emoji \
                 fonts-dejavu-core fonts-symbola
```

The app ships no font and no icon set; every control is a Unicode
symbol resolved from the system's fonts. On a minimal install the
entire transport bar renders as tofu — play, pause, step, browse,
all of it — with no error.

**The fourth package is the one people miss.** The icons split
into two classes with different requirements:

| Class | Needs |
|---|---|
| BMP symbols (play, step, gear, close) | DejaVu / Noto Sans Symbols 2 — ordinary font packages |
| Astral-plane emoji (chat, mute, delete, VR) | a **monochrome** emoji font |

Every icon is written with variation selector 15, which asks for
the *text* presentation. A colour emoji font supplies the colour
glyph, which the engine can decline for a VS15-marked codepoint
and fall through to tofu — so installing an emoji font is not the
same as fixing it. `fc-list :charset=1F4AC family` shows which
fonts on a box carry the chat glyph.

---

## 3. Setting up the outputs

Everything here is **Tools → Outputs** in the control window.

### 3.1 Adding an output

The picker lists every monitor with its name, pixel size and
position, marks which one is primary, and draws a to-scale diagram
of the arrangement. Check the diagram against the desk before
clicking Add — an output opens fullscreen, and you get one chance
to notice it is about to land on the wrong display.

A monitor already carrying an output is marked as such and cannot
take a second one. Two fullscreen windows on one monitor means one
is invisible with no way to tell which.

**"Nothing marked primary" is a valid reading on X11**, which can
leave no display flagged at all. The panel reports what the
platform says rather than guessing.

**Track operator camera** is on for a new output, and it makes the
control globe the sphere's remote. Wherever you centre the control
globe, the sphere turns so that place faces its **front**, the same
way up as on the control globe, and your zoom magnifies it there.
This is how a pole reaches an audience: drag the control globe to
Antarctica and Antarctica comes round to the front, on the equator.
A right-drag or a two-finger twist on the control globe turns the
picture on the sphere too. Tilting the control globe does not.

The front is latitude 0 on the meridian the **rotation offset**
names (§3.4), so the rotation decides which side of the sphere faces
the room. With tracking off, the sphere shows a fixed map — the
prime meridian at that same meridian, unzoomed — whatever you do on
the control globe.

### 3.2 Framebuffer is not monitor resolution

The panel shows two numbers and they are different things:

- the **monitor's** own pixel count, on the option line
- the **framebuffer**, chosen separately below it

The framebuffer is the equirectangular image the output renders —
the thing the sphere consumes. It is scaled to the window. The
whole ladder is offered rather than just the rungs that fit the
monitor, because the two most useful cases are at the extremes:
1024 to preview a sphere on a desk monitor, and 8192 to drive a
sphere from a 1080p preview screen.

Start at 4096×2048. Go higher only if the sphere's own resolution
justifies it, and re-read §4 afterwards.

A **projector-rig** output (§3.6) has no framebuffer picker. It
draws at the spanned display's own pixel size, because a warp
addresses the projectors' pixels directly, and the panel shows
that size where the picker would be.

### 3.3 Measuring this machine's decoder budget

The panel shows *N of M video decoders in use* and disables Add
when the budget is spent. `M` defaults to a guess derived from the
machine; **the guess is not a measurement, and the field exists so
you can replace it with one.**

To measure it:

1. Load a video dataset on the control window.
2. Turn on the debug overlay for each output.
3. Add outputs one at a time, watching **fps** on every output
   already running.
4. When an existing output's fps drops as a new one appears, you
   have passed the machine's real budget.
5. Set the budget field to one *below* the count where degradation
   started, and relaunch.

The count is *windows that can hold a decoder* — every control
panel plus every output — not decoders currently decoding. That is
deliberate: an output goes from free to costing a decoder the
instant a video loads, and a dataset load is not a moment where a
refusal can be shown. Counting windows puts the refusal on Add,
where there is a control to disable.

### 3.4 Calibration

Two controls, used together and in this order:

1. **Calibration pattern** — replaces the dataset with a graticule
   carrying pole letters, named anchors, a longitude scale and a
   live resolution readout. It travels the same path a dataset's
   pixels travel, so a pattern that lands correctly proves a
   dataset will.
2. **Rotation offset** — turns the projection to match how the
   sphere is physically mounted. Drag the slider while watching
   the sphere; type a number to reproduce a known value. With
   **Track operator camera** on, it says which side of the sphere
   is the front: the side the control globe's centre turns to.
   Centre the control globe on (0°, 0°), north up, and turn the
   offset until the pattern's centre crosshair faces the room.

Calibration is done **one sphere at a time** — a four-output rig
is four differently-mounted spheres, and the pattern appears only
on the output you toggled.

The southern colour bars are deliberately reversed: two identical
bands would be invariant under a vertical flip, which is the
orientation error this pattern most needs to expose. The
antimeridian is marked at both edges in its own colour, so a seam
artefact and a mis-set rotation cannot look alike.

**The rotation persists; the pattern does not.** The rotation is a
property of the room and comes back next launch. The test pattern
is a property of the afternoon, and an installation that restored
with it on would show no data at all.

On a projector rig the same control is labelled **content
rotation** and means something narrower — read §3.6 before
touching it there.

### 3.5 Restore on launch

Off by default, and deliberately: an operator who added an output
once, on a laptop later taken home, should not have a window try
to open on a projector that is not there.

Turn it on for a fixed installation. The set comes back next
launch, matched on monitor name **and** signed physical origin —
a name-only match can restore onto a physically different monitor
while looking like it worked. A monitor that no longer matches is
skipped and logged rather than guessed at.

### 3.6 Projector rigs: importing a sphere-sim warp

Everything above assumes a display that takes the equirectangular
image as it is: an LED sphere, or a dome's own player. A sphere lit
by **projectors** needs one more thing, a **warp**. It says where
each projector's pixels land on the sphere, and how brightly to
draw them where two projectors overlap. sphere-sim calibrates the
rig and exports the warp; this app draws it.

> **Not yet run on a projector rig.** This section is written from
> the code and from off-hardware checks. Nobody has drawn a warp on
> a sphere with it yet. The checks a first run should pass are
> steps W1–W9 in `MULTI_MONITOR_PLAN.md` Appendix B.

#### Span the projectors into one display

An output fills exactly one monitor, and a warp places every
projector's picture inside that one window. So the projector heads
must reach the app as **one monitor at their combined size**:
3840×2160 for SOS's four 1920×1080 projectors in a 2×2 grid.

| Route | Notes |
|---|---|
| NVIDIA Mosaic | NVIDIA's control panel, or `nvidia-settings` on Linux. Which grids a card offers is NVIDIA's question, so confirm 2×2 is one of them before an SOS rig depends on it |
| AMD Eyefinity | AMD's own control software; the same caveat |
| `xrandr --setmonitor` | Linux, **X11 only**; no Wayland equivalent. Below |

**Each head goes where its projector's part of the display is.**
For SOS that is the arrangement SOS itself uses: P1 bottom left, P2
bottom right, P3 top left, P4 top right. A current bundle's layout
says where each mesh goes on the display, and the import draws it;
nothing can say which cable feeds which head. This is the one thing a
warp cannot check. A projector fed the wrong part still shows a
plausible globe, just not the right part of it.

On Linux without a vendor span, place the heads, then declare them
one monitor. `<P1>` and the others are the names a bare `xrandr`
prints for the outputs cabled to those projectors (`DP-1`,
`HDMI-0`, …). X counts from the top left:

```bash
xrandr --output <P3> --mode 1920x1080 --pos 0x0 \
       --output <P4> --mode 1920x1080 --pos 1920x0 \
       --output <P1> --mode 1920x1080 --pos 0x1080 \
       --output <P2> --mode 1920x1080 --pos 1920x1080
xrandr --setmonitor SPHERE auto <P1>,<P2>,<P3>,<P4>
```

This lasts until the X session ends, so run it wherever the
installation's session starts.

**Confirm it took, twice.**

1. Tools → Outputs lists **one** monitor at the combined size. If
   it lists four, the heads are not spanned, and no setting in this
   app can place one window across them.
2. Once the output exists, its HUD's **buf** line names the
   combined size — before any warp is imported, since the HUD does
   not need one. A single projector's size means the desktop
   fullscreened the window onto one head, which a desktop that does
   not honour a user-defined monitor would do; a vendor span is the
   route to try then.

#### Add the output and import the warp

1. Add an output on the spanned monitor with **Output type →
   Projector rig (sphere-sim warp)**. The type is fixed for the life
   of the output; to change it, remove the output and add it again.
2. The new output draws **nothing**. The projectors go black, and
   the row says there is no warp set. That is deliberate: an
   unwarped globe thrown across calibrated projectors is exactly
   what this mode exists never to show.
3. **Import warp…** and pick the ZIP as sphere-sim exported it. A
   bundle that was extracted and zipped again is usually refused.
   Get the original if you can: the `.data` files from its `warp`
   folder, picked all at once, also import, but they arrive without
   the layout beside them, so step 6's question follows.
4. **Never pick files from `restore/warp/`.** The bundle's
   `restore` folder keeps the *previous* calibration, in the same
   format and under the same file names. The ZIP import ignores it.
   A file picked by hand from there is imported as though it were
   the new calibration.
5. **A bundle from a current sphere-sim says where its meshes go**,
   in a `layout.json` beside them. The panel lists the meshes it read
   and draws the display with each one in its own place. It says what
   rotation is already in them, and compares the display they were
   solved for with this one. Check the drawing against the cabling
   (above), then **Import**. There is nothing to choose: the bundle
   decided, from the rig sphere-sim calibrated.
6. **Anything that does not say where its meshes go** — loose `.data`
   files, or a bundle exported before sphere-sim added the layout —
   gets a question instead: **Import as equirectangular in SOS
   quadrants**, or **Cancel**. A diagram shows each mesh in the
   quadrant it would take. The answer states two things the files
   cannot: where each mesh goes, and that it addresses an
   equirectangular frame.
   - An SOS rig from sphere-sim: import.
   - **Any other rig: cancel**, and import the ZIP from a current
     sphere-sim instead. A rig sphere-sim placed itself, such as two
     projectors or a row of four, reuses SOS's projector names in other
     places. The quadrants would send every mesh to the wrong projector,
     and the picture would still look right.
   - **A mesh from a dome or mirror tool** (meshmapper and its kind):
     cancel. Those address a fisheye frame, which this app does not
     draw, and nothing in the file says so. Imported anyway, a mesh
     like that draws a smooth, convincing globe that is wrong: the
     whole world squeezed into the projector's disc. Renaming one to
     `P1.data` to get past a refusal is how it would get this far.
7. Once imported, the row reads *Drawing 4 meshes: P1, P2, P3, P4*.
   The HUD's `warp` line gives the set's id and the same count (§4).

**A `layout.json` this build cannot read refuses the import**; it
never falls back to the question. The likeliest reason is a newer
sphere-sim, and the message names the format it found. The remedy is
a newer build of this app, not a different file.

**So does a `layout.json` that says its meshes address anything but
an equirectangular frame** — a fisheye, say, or a model's own texture
layout. No sphere-sim writes that yet. Here the file is not broken:
it was made for a picture this app does not draw, and the remedy is a
different file.

**A stretch warning before the import** means the part of this
display a mesh would fill is not the shape it was solved for. The usual cause
is a 4096×2160 span, whose 2048×1080 quadrants stretch a 16:9
calibration by 7%. Span at the resolution the calibration used —
1920×1080 per projector for SOS — rather than accept it, unless you
know the lenses compensate. When every projector is stretched by the
same amount, the panel says so once. For a bundle, which names the
display it was solved for, that line reads *Solved for a 7680×4320
display, but this one is 3840×2400…*: the cause is the display, not
the meshes. Projectors are named only where the display does not
explain everything. That happens with loose files, which name no
display, or with a mesh that does not fit even the display its bundle
was solved for.

**Importing on a desk monitor to look at a bundle is harmless.** The
monitor is rarely the rig's shape, so the preview carries the stretch
warning, and each quadrant's disc comes out slightly oval. Nothing is
wrong with the calibration: import it again on the spanned display.

**The app keeps its own copy of the warp.** After the import it no
longer needs the file, so a calibration can arrive on a USB stick
that then leaves the building. Keep the file anyway. The copy lives
in this app's storage on this machine, which a new machine, or a
reinstall that clears the app's data, does not carry. A warp takes
about 80 KB per projector at sphere-sim's default 41×41 grid. A much
finer export of a many-projector rig can run into the storage
limit, and the import then says there is no room rather than
keeping part of it.

**Track operator camera** and **Split sphere** work through the
warp as they do on an LED sphere (§3.1). The front is where the warp
puts the middle of its texture, turned by the content rotation.

#### Set the blend gamma

Where two projectors overlap, each draws a share of the picture.
The shares are meant to add up to one projector's worth of light,
and they do only if the app knows the projectors' gamma. That is
**Blend gamma** in the row: 2.2 unless your calibration says
otherwise.

Check it in a darkened room:

1. Turn on the calibration pattern. Its grey ramp runs round the
   equator in eight flat steps, so every seam crosses it.
2. Use the content rotation to bring a mid-grey step onto a seam.
3. Compare the overlap with the single-projector grey either side.

| The overlap looks | Blend gamma |
|---|---|
| the same | leave it |
| slightly darker | raise it, 0.05 at a time |
| slightly brighter | lower it |
| about half as bright, on every seam | **not a gamma problem** — the blend is being applied wrongly. Report it with a photo |

Check every seam before settling on a number, and put the content
rotation back afterwards.

Overlaps also look lighter where the picture is **black**, because
two projectors' black levels add. That is not the gamma, and a warp
has nowhere to correct it.

#### Leave the rig's rotation alone

sphere-sim bakes the rig's own mechanical rotation into the warp.
So on a projector rig the rotation control is labelled **Content
rotation**. It turns the picture on top of whatever the warp maps,
and it starts at 0.

**Do not copy the rotation from SOS's own configuration into it.**
That rotation is already in the warp, and entering it again turns
every picture twice. Leave the content rotation at 0, turn on the
calibration pattern, and check that the prime meridian sits where
the calibration put it.

Below the rotation, the row shows the warp's own rotation, as the
bundle's `layout.json` states it. That note gives the number for a
sphere, and says none for a model, whose own texture layout anchors
it. For loose files or an older bundle it says *unknown*: nothing
stated the rotation, and the app does not guess it from the rig.

#### Edges you should expect

A warp file describes each projector on a coarse grid, 41×41 by
default, and says nothing about where between two grid points the
sphere's edge falls. The app works that out from how the grid bunches
up near the edge, and draws each projector's picture out to it,
fading out. Check the edges with the calibration pattern on, all the
way round each projector's picture.

On some rigs, the Boulder rig among them, the sides of each picture
end well inside the sphere's edge. The blend hands that part of the
sphere to the neighbouring projector, and this projector's share falls
to zero before its own edge. The warp file gives the share only at its
grid points, so the app follows its trend between them and ends the
picture where it reaches zero.

What you should see is a curved edge that fades out, and pictures that
hand over along smooth curves. What is left over is not a fault in
this app:

- **A short step where the grid runs along the edge**, at the top,
  bottom and sides of each projector's picture: the grid gives
  nothing to go on there, so the picture reaches halfway into that
  cell of the grid and stops.
- **An edge a few pixels off**, now and then about 15 px on the
  Boulder rig's meshes. Where it lands past the sphere, a faint
  sliver of light can reach the wall behind it.
- **The ring of grid cells just inside the edge is the least
  accurate.** The graticule can sit a few pixels off across an
  overlap there, up to about 28 px on the Boulder rig's meshes.
- **A rim that stays bright to the edge at the top and bottom of each
  picture**, on a rig whose blend darkens the poles, as the Boulder
  rig's does.
  The darkening falls between the grid's last point and the edge,
  where the file says nothing.
  [sphere-sim#55](https://github.com/zyra-project/sphere-sim/issues/55)
  asks sphere-sim's exporter to record it.

All four come from the grid's resolution. If any is objectionable,
export again from sphere-sim with a finer grid (`cols` / `rows`).

**Judge the edges on the sphere, not on a desk monitor.** A monitor
shows each projector's picture alone. A sliver drawn at 3% of full
brightness adds 3% to the neighbouring projector's light on the
sphere, but on the monitor it reads as a 20% grey.

A **staircase along the whole edge**, up to one grid cell deep, is a
fault: the edge is not being reconstructed. So are **steps down the
sides** of each picture, up to a grid cell wide, where it hands over
to its neighbour: the share is not being followed down to zero. So is
a **bright rim** well past the edge. Any of these belongs in a bug
report with the warp file.

#### Restore, and a warp that will not load

With restore on (§3.5), a projector-rig output comes back with its
warp, its blend gamma and its content rotation.

- **Power the projectors and apply the span before launching.**
  Restore looks for the spanned monitor by name and position. If it
  is missing at launch, the output is skipped and dropped from the
  saved configuration. Add it again and re-import the same file; the
  app still has the warp, and the import lands on it.
- **A warp that cannot be read costs its own output and nothing
  else.** The row says the warp could not be read and asks for it
  again, those projectors stay black, and every other output
  restores normally. Re-import the file.

Removing the output — from the panel, or by closing its window —
deletes the app's copy of its warp, unless another output uses it.
So do **Clear warp** and importing another warp over it. A crash
does not. Closing the window counts as removing the output, so use
F11 (§6) to get at the desktop behind it instead.

---

## 4. Reading the debug HUD

Turn it on per output: Outputs panel → Debug overlay. It is drawn
on the sphere, so it cannot be silently left on.

```
data   01KQG62XVNKZ112H3AR0K56SX9
sync   +69 ms
link   live
fps    29.0  (raf 60.0)
draw   0.4 ms
buf    4096×2048
gpu    ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 …)
```

| Field | What it means | Healthy |
|---|---|---|
| **data** | what is *on the glass*, not what was requested | the dataset you loaded |
| **sync** | playhead drift from the control window, signed | within ±150 ms; a dash with a reason beside it is often correct — `not-ready` on a still image is the right answer |
| **link** | contact with the control window | `live` |
| **fps (raf)** | frames drawn, against callbacks the browser offered | see below |
| **draw** | mean time inside one render call | see below |
| **warp** | projector rigs only, under **data**: the warp being drawn, as its id and mesh count | one mesh per projector, and never a `dropped` count on a sphere — see below |
| **buf** | the framebuffer, deliberately not the window | the rung you picked — or, on a projector rig, the spanned display's own size |
| **gpu** | render adapter, plus context state if not healthy | a discrete card — **and not readable on Linux**, see §1.1 |

**Read fps and raf as a pair.** Neither means much alone:

- `1.0 (raf 60.0)` on an idle globe is **correct** — a static
  output is floored at 1 Hz deliberately, so that an output which
  never redraws can still be told apart from a correct frame.
- `29.0 (raf 60.0)` with video is correct — the loop caps at 30.
- `30.0 (raf 30.0)` is a display running at 30 Hz. The output is
  drawing on every callback it is offered and has **no headroom
  left** — anything that slows a frame now costs you frames. See
  §1.2.
- `19 (raf 60.0)` is the loop declining callbacks it is being
  offered — that is a fault in the app, not your installation.

**`draw` reads differently per platform**, which is worth knowing
before you conclude anything from it. On Windows the render call
submits work and returns, so it reads under a millisecond even
when the GPU is saturated. On Linux the path is synchronous and
the same field reads the real cost — 302 ms was measured on an
iGPU under a translation layer. A sub-millisecond `draw` is not
proof of headroom unless you know which platform you are on.

**The `warp` line** appears on projector-rig outputs only (§3.6):

| Reads | Means |
|---|---|
| `warp  1a2b3c4d · 4 meshes` | drawing that warp, one mesh per projector |
| `warp  none — import a set …` | drawing **nothing**: no warp imported, or the saved one could not be read. The Outputs panel row says which |
| `warp  refused — <code>` | handed a warp it would not draw. The panel checks every warp by the same rules first, so this should never appear; report it with the code |
| `· 12 dropped` after the count | that many triangles too wide to draw. Never on a sphere; it means a damaged mesh, or a surface whose texture is laid out in pieces |

---

## 5. Health badges in the Outputs panel

A healthy output shows **no badge at all**. That is deliberate — a
row of green chips trains an operator to stop reading the row that
matters.

| Badge | Meaning | What the audience sees |
|---|---|---|
| *(none)* | live | correct, current picture |
| **Starting** | spawned, not yet announced itself | usually momentary |
| **Stale** (amber) | the control window has gone quiet | **a picture, but not a current one** — the sphere looks fine |
| **Display lost** (red) | the output lost its graphics context | nothing — a black sphere |

The distinction between amber and red is the whole value of the
badge, and it is the question you cannot answer by looking at the
sphere: a stale output is still showing something plausible.

Transitions are announced to screen readers as well as shown. A
row *disappearing* is deliberately not announced — that covers a
crash and your own Remove equally, and saying "gone" for a removal
you just asked for is noise.

---

## 6. Unattended launch

For an installation that should come up on boot with no keyboard:

```bash
terraviz --kiosk
```

or set `TERRAVIZ_KIOSK=1` in the environment. Two mechanisms
because they suit different launchers — a `.desktop` autostart
entry or a systemd unit sets a variable naturally, a wrapper
script passes a flag.

`TERRAVIZ_KIOSK=0` and an empty value both mean **off**, so a
deployment templating one unit file across several machines can
disable kiosk explicitly rather than by omission.

Kiosk mode is fullscreen and decorationless: no close button, no
title bar, no menu bar. Exits:

- **Ctrl+Q** (Windows/Linux) or **Cmd+Q** (macOS, via the standard
  application menu)
- **F11** on any window toggles fullscreen and brings the title
  bar back — the escape hatch during calibration
- SIGTERM from the installation's process supervisor

> **Not yet exercised end to end.** `--kiosk` compiles and its
> argument parsing is unit-tested, but its calls into the window
> API have never run on hardware. Try it before an installation
> depends on it.

---

## 7. What this document does not cover

- **Linux qualification.** The feature has run on a second monitor
  on Windows. A dual-monitor Linux workstation pass has not
  happened, and WSL is not a substitute — see `MULTI_MONITOR_PLAN.md`
  Appendix B for three configurations and why none of them
  qualifies anything.
- **Soak behaviour.** Every reading so far is from a single
  sitting. Nobody has watched an installation play for an hour.
- **Recovering a crashed output automatically.** The manager
  notices, badges it and keeps it in the restore config — it does
  not respawn it. Three crashes on one monitor stop new outputs
  going there for the session; relaunching clears that.
- **A projector rig on hardware.** §3.6 has not been run on one.
  The first run's checks are `MULTI_MONITOR_PLAN.md` Appendix B,
  steps W1–W9.
- **A placed rig from sphere-sim's page.** The bundle format carries
  any layout, and this app reads it, but sphere-sim's page exports
  from the install rig, so every bundle it writes today places SOS's
  quadrants. A placed rig's bundle has to come from sphere-sim's own
  builders until the page exports one.
- **Spanning on Linux.** `xrandr --setmonitor` needs X11, and the
  only X11 run so far — under WSL — aborted when an output window
  opened. Whether WSL caused it is unsettled; see the plan's
  Appendix B, "second-window abort". On a Linux projector rig, add
  one output before anything else.

---

## See also

- [`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) — the design,
  the delivery ladder, and Appendix B's hardware results log
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — standing up a node, if
  this installation serves its own catalog
