// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Outputs panel's warp controls for one `projector-warp` output
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16") — what it is drawing, the
 * import of a sphere-sim bundle, the layout question, the blend gamma,
 * and a way to clear it.
 *
 * Its own module because `outputUI` is long enough already and this is
 * one self-contained flow with its own wrong answers, the same reason
 * the monitor diagram's arithmetic is exported rather than inline.
 *
 * **The layout is read or asked, never assumed.** A bundle from
 * sphere-sim#52 on says where its meshes go in `layout.json`, and the
 * panel draws that layout — the display with each mesh in its own place,
 * and the rotation already baked into them — before a single click
 * imports it. Anything else (loose `.data` files, an older bundle) gets
 * the question instead: SOS's quadrants drawn with each mesh where they
 * would put it, and the operator's explicit answer, because a placed
 * rig's `P1`…`P4` are not SOS's quadrants. Declining imports nothing
 * either way; there is no silent default.
 *
 * **The raster's shape is checked, not enforced.** A mesh's `x` span
 * states the aspect it was solved for, and its part of this display
 * has one of its own. A mismatch stretches the picture, but the
 * operator may know the lens compensates, so it is a warning shown
 * before the choice rather than a refusal. Each stretch is said
 * **once**. The usual rig is one projector model throughout, so on a
 * display of the wrong shape every mesh is off by the same amount, and
 * four copies of one sentence read as four problems. Meshes that would
 * read the same sentence share it. When a bundle's meshes all fit the
 * display they were solved for, the cause is this display, and it is
 * said as one line about the display.
 *
 * **Every refusal is worded.** The import is fail-closed from end to
 * end, so each code the manager can return has a sentence here — the
 * category translated, the specific code carried raw beside it, since
 * that is what an operator with the file open in an editor can act on.
 *
 * Every `multiOutput/` import is **type-only**, for `outputUI`'s reason:
 * the panel is loaded eagerly by `main.ts`, and a runtime import would
 * pull the contract into the web entry chunk.
 */

import { plural, t } from '../i18n'
import { formatNumber } from '../i18n/format'
import type { OutputMonitor, OutputRecord, WarpAssignRefusal, WarpAssignment, WarpFileLike } from '../services/multiOutput/manager'
import type { OutputRenderConfig, OutputWarpSet } from '../services/multiOutput/protocol'
import type { BundleLayout, BundleLayoutProblem, WarpPlacement, WarpSource, WarpSourcesResult } from '../services/multiOutput/warpImport'
import { logger } from '../utils/logger'
import { announcePolite } from './domUtils'

/** The slice of the manager the warp controls call. */
export interface OutputWarpManager {
  readWarpFiles(files: readonly WarpFileLike[]): Promise<WarpSourcesResult>
  importWarpSet(label: string, sources: readonly WarpSource[], placement: WarpPlacement): Promise<WarpAssignment>
  clearOutputWarp(label: string): Promise<void>
  setOutputRenderConfig(label: string, render: Partial<Omit<OutputRenderConfig, 'warp'>>): Promise<void>
}

/** A mesh's rect of the display: fractions, origin bottom-left. */
interface Viewport {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * SOS's quadrants, restated for the diagram and the shape check — P1
 * bottom-left, P2 bottom-right, P3 top-left, P4 top-right, as sphere-sim
 * and SOS's own `projectorInfo` have them. Restated rather than imported
 * for the type-only rule above; the viewports a set is placed with are
 * applied by the manager from the one table in `projectorWarp`, never
 * from this.
 */
const SOS_QUADRANTS: readonly { readonly id: string; readonly viewport: Viewport }[] = [
  { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 } },
  { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  { id: 'P3', viewport: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
  { id: 'P4', viewport: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
]

/**
 * How far a mesh's picture is stretched in its viewport, as a percentage,
 * or `null` when the two agree to within 1%.
 *
 * The mesh states the aspect it was solved for (`x` spans ±aspect); the
 * viewport's is its share of the display's own pixels. A 16:9 mesh in a
 * 2048×1080 quadrant is 7% too wide for it.
 */
export function rasterStretchPercent(
  meshAspect: number,
  viewport: { w: number; h: number },
  display: { width: number; height: number },
): number | null {
  const viewportAspect = (viewport.w * display.width) / (viewport.h * display.height)
  if (!(meshAspect > 0) || !(viewportAspect > 0)) return null
  const stretch = Math.abs(viewportAspect / meshAspect - 1) * 100
  return stretch < 1 ? null : Math.round(stretch)
}

/**
 * How far this display's shape is from the one a bundle was solved for,
 * in `rasterStretchPercent`'s terms, or `null` within 1%. A layout places
 * each viewport as a fraction of the display, so a change of shape
 * stretches every viewport by exactly this amount.
 */
export function displayStretchPercent(
  solved: { width: number; height: number },
  display: { width: number; height: number },
): number | null {
  return rasterStretchPercent(solved.width / solved.height, { w: 1, h: 1 }, display)
}

/** A mesh with the viewport it would fill. */
interface PlacedMesh {
  readonly id: string
  readonly aspect: number
  readonly viewport: Viewport
}

/** One stretch sentence, and the meshes it is true of. */
interface StretchGroup {
  readonly ids: string[]
  readonly mesh: string
  readonly viewport: string
  readonly percent: number
}

/** Each source with the viewport `viewportOf` gives it; a source with none is left out. */
function placeMeshes(sources: readonly WarpSource[], viewportOf: (id: string) => Viewport | undefined): PlacedMesh[] {
  return sources.flatMap(source => {
    const viewport = viewportOf(source.id)
    return viewport === undefined ? [] : [{ id: source.id, aspect: source.mesh.aspect, viewport }]
  })
}

/**
 * The meshes `display` would stretch, grouped by the sentence each would
 * read. The key is the text as shown, rounding included, because what an
 * operator reads decides what counts as one sentence.
 */
function stretchGroups(meshes: readonly PlacedMesh[], display: { width: number; height: number }): StretchGroup[] {
  const groups = new Map<string, StretchGroup>()
  for (const { id, aspect, viewport } of meshes) {
    const percent = rasterStretchPercent(aspect, viewport, display)
    if (percent === null) continue
    const mesh = aspect.toFixed(3)
    const shape = ((viewport.w * display.width) / (viewport.h * display.height)).toFixed(3)
    const key = `${mesh} ${shape} ${percent}`
    const group = groups.get(key)
    if (group) group.ids.push(id)
    else groups.set(key, { ids: [id], mesh, viewport: shape, percent })
  }
  return [...groups.values()]
}

/** One warning per group, shown before the choice. */
function stretchWarnings(groups: readonly StretchGroup[]): HTMLElement[] {
  return groups.map(({ ids, mesh, viewport, percent }) =>
    paragraph(
      plural(
        ids.length,
        { one: 'outputs.warp.aspectMismatch.one', other: 'outputs.warp.aspectMismatch.other' },
        { ids: ids.join(', '), mesh, viewport, percent },
      ),
      'output-warning',
    ),
  )
}

/** A refusal from any step of the import, as the sentence the panel shows. */
export function describeWarpRefusal(refusal: WarpAssignRefusal): string {
  switch (refusal.code) {
    case 'nothing-picked':
      return t('outputs.warp.refusal.nothingPicked')
    case 'too-large':
      return t('outputs.warp.refusal.tooLarge', { megabytes: Math.ceil(refusal.bytes / (1024 * 1024)) })
    case 'mixed-selection':
      return t('outputs.warp.refusal.mixedSelection')
    case 'unsupported-file':
      return t('outputs.warp.refusal.unsupportedFile', { file: refusal.file })
    case 'archive':
      // The two an operator can act on differently get sentences of their
      // own; the rest say which structural problem it was.
      if (refusal.zip.code === 'compressed') return t('outputs.warp.refusal.archiveCompressed', { file: refusal.file })
      if (refusal.zip.code === 'checksum') {
        return t('outputs.warp.refusal.archiveChecksum', { file: refusal.file, entry: refusal.zip.entry ?? refusal.file })
      }
      return t('outputs.warp.refusal.archive', { file: refusal.file, reason: refusal.zip.code })
    case 'no-meshes':
      return t('outputs.warp.refusal.noMeshes', { file: refusal.file })
    case 'too-many':
      return t('outputs.warp.refusal.tooMany', { count: refusal.count })
    case 'bad-name':
      return t('outputs.warp.refusal.badName', { file: refusal.file })
    case 'duplicate-id':
      return t('outputs.warp.refusal.duplicateId', { ids: refusal.ids.join(', ') })
    case 'not-text':
      return t('outputs.warp.refusal.notText', { file: refusal.file })
    case 'mesh':
      return refusal.mesh.line === undefined
        ? t('outputs.warp.refusal.mesh', { file: refusal.file, reason: refusal.mesh.code })
        : t('outputs.warp.refusal.meshAtLine', { file: refusal.file, reason: refusal.mesh.code, line: refusal.mesh.line })
    case 'layout':
      return refusal.reason === 'duplicate'
        ? t('outputs.warp.refusal.layoutDuplicate', { ids: refusal.ids.join(', ') })
        : t('outputs.warp.refusal.layoutUnplaceable', { ids: refusal.ids.join(', ') })
    case 'bundle-layout':
      // The format gets a sentence of its own: a newer sphere-sim is the
      // likeliest reason, and the remedy is a different build, not a
      // different file. So does the frame, whose file is not broken: it
      // is made for a projection this build does not draw.
      if (refusal.problem.code === 'format') {
        return t('outputs.warp.refusal.bundleLayoutFormat', { file: refusal.file, format: refusal.problem.format })
      }
      if (refusal.problem.code === 'uv') {
        return t('outputs.warp.refusal.bundleLayoutUv', { file: refusal.file, uv: refusal.problem.uv })
      }
      return t('outputs.warp.refusal.bundleLayout', { file: refusal.file, reason: layoutProblemReason(refusal.problem) })
    case 'set':
      return t('outputs.warp.refusal.set', { reason: refusal.set.code })
    case 'no-output':
      return t('outputs.warp.refusal.noOutput')
    case 'not-a-warp-output':
      return t('outputs.warp.refusal.notAWarpOutput')
    case 'storage':
      return refusal.reason === 'no-room' ? t('outputs.warp.refusal.noRoom') : t('outputs.warp.refusal.unavailable')
    default: {
      // A code added to the manager's refusals has to be worded here
      // before it compiles, rather than reaching the operator as nothing.
      const unreachable: never = refusal
      return unreachable
    }
  }
}

/** A layout problem as the raw reason the panel carries: the code, and the entry to blame if there is one. */
function layoutProblemReason(problem: BundleLayoutProblem): string {
  return 'mesh' in problem ? `${problem.code}: ${problem.mesh}` : problem.code
}

/**
 * The warp's own rotation, as the row states it beside the content
 * rotation — what the bundle said is already in the meshes, so an
 * operator can see it rather than enter it a second time. `null` with no
 * set loaded, since there is no warp to have a rotation.
 */
export function warpRotationNote(warp: OutputWarpSet | null): string | null {
  if (warp === null) return null
  const texture = warp.texture
  if (texture === null) return t('outputs.warp.warpRotationUnknown')
  if (texture.surface === 'mesh') return t('outputs.warp.warpRotationMesh')
  return t('outputs.warp.warpRotationSphere', { degrees: formatNumber(texture.rotationOffsetDeg, { maximumFractionDigits: 2 }) })
}

function paragraph(text: string, className: string): HTMLElement {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

function button(text: string, className: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = text
  return el
}

/** What the output is drawing, in one line — the panel's half of "says why". */
function statusLine(record: OutputRecord): HTMLElement {
  const warp = record.render.warp
  if (warp) {
    const ids = warp.meshes.map(m => m.id).join(', ')
    return paragraph(
      plural(warp.meshes.length, { one: 'outputs.warp.loaded.one', other: 'outputs.warp.loaded.other' }, { ids }),
      'output-warp-status',
    )
  }
  // A reference with nothing loaded is a stored set that could not be
  // read — a different message from "nothing imported", because the
  // action is different: import the same bundle again.
  return paragraph(
    record.warpRef !== null ? t('outputs.warp.unreadable') : t('outputs.warp.none'),
    'output-warp-status output-warning',
  )
}

/**
 * The display, drawn in its own shape, with each cell in its viewport.
 * One picture for both paths: SOS's quadrants with the meshes that would
 * fill them, or a bundle's own layout, every cell filled.
 *
 * Presentational and `aria-hidden`: the text beside it carries the same
 * mapping, and boxes named only by their position are noise to a screen
 * reader. A picture of the physical display, so it never mirrors under
 * `dir="rtl"` — the cells are placed with **physical** `left` / `bottom`,
 * like the monitor map's, and `.output-warp-layout` pins `direction: ltr`.
 * Cells are appended in reading order, top row first, which is also the
 * order a screen with the attribute ignored would speak them in.
 */
function layoutDiagram(
  cells: readonly { readonly id: string; readonly viewport: Viewport; readonly filled: boolean }[],
  display: { readonly width: number; readonly height: number },
): HTMLElement {
  const frame = document.createElement('div')
  frame.className = 'output-warp-layout'
  frame.setAttribute('aria-hidden', 'true')
  frame.style.aspectRatio = `${display.width} / ${display.height}`
  const ordered = [...cells].sort(
    (a, b) => b.viewport.y + b.viewport.h - (a.viewport.y + a.viewport.h) || a.viewport.x - b.viewport.x,
  )
  const pct = (fraction: number): string => `${fraction * 100}%`
  for (const { id, viewport, filled } of ordered) {
    const cell = document.createElement('div')
    cell.className = filled ? 'output-warp-cell is-filled' : 'output-warp-cell'
    cell.textContent = id
    cell.style.left = pct(viewport.x)
    cell.style.bottom = pct(viewport.y)
    cell.style.width = pct(viewport.w)
    cell.style.height = pct(viewport.h)
    frame.appendChild(cell)
  }
  return frame
}

/** A share of the display, as a percentage an operator reads. */
const percent = (fraction: number): string => formatNumber(fraction * 100, { maximumFractionDigits: 1 })

/**
 * The bundle's layout as text, one sentence per mesh, for a screen reader:
 * the diagram's own content, since the diagram is hidden from one. Placed
 * with the same bottom-left origin the file states, in words that do not
 * depend on reading direction.
 */
function layoutAsText(layout: BundleLayout): HTMLElement {
  const list = document.createElement('ul')
  list.className = 'sr-only'
  for (const { id, viewport } of layout.projectors) {
    const item = document.createElement('li')
    item.textContent = t('outputs.warp.viewportEntry', {
      id,
      width: percent(viewport.w),
      height: percent(viewport.h),
      left: percent(viewport.x),
      bottom: percent(viewport.y),
    })
    list.appendChild(item)
  }
  return list
}

/**
 * The warp controls for one `projector-warp` output. `repaint` redraws
 * the panel after an import or a clear, since both change the status
 * line and the row's other controls read the same record.
 */
export function buildWarpSection(
  mgr: OutputWarpManager,
  record: OutputRecord,
  monitor: OutputMonitor,
  displayName: string,
  repaint: () => void,
): HTMLElement {
  const section = document.createElement('div')
  section.className = 'output-warp'

  const title = document.createElement('p')
  title.className = 'output-field-label'
  title.textContent = t('outputs.warp.title')
  section.append(title, statusLine(record))

  const actions = document.createElement('div')
  actions.className = 'output-warp-actions'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,.data'
  input.multiple = true
  input.hidden = true
  const importBtn = button(t('outputs.warp.import'), 'output-warp-import')
  importBtn.setAttribute('aria-label', t('outputs.warp.importAria', { monitor: displayName }))
  const clearBtn = button(t('outputs.warp.clear'), 'output-warp-clear')
  clearBtn.setAttribute('aria-label', t('outputs.warp.clearAria', { monitor: displayName }))
  clearBtn.disabled = record.warpRef === null && record.render.warp === null
  actions.append(importBtn, clearBtn, input)
  section.appendChild(actions)

  /**
   * Where a refusal or the layout question goes — replaced, never stacked.
   * A polite live region, the treatment the app gives every message that
   * arrives after an await: everything that lands here does, away from
   * where focus is, so without it the question an import waits on would
   * appear in silence to anyone not looking at it. Created empty, so the
   * region is registered before the first message changes it.
   */
  const pending = document.createElement('div')
  pending.className = 'output-warp-pending'
  pending.setAttribute('role', 'status')
  pending.setAttribute('aria-live', 'polite')
  section.appendChild(pending)
  const show = (...children: HTMLElement[]): void => pending.replaceChildren(...children)

  importBtn.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : []
    // Cleared at once so choosing the same file again still fires `change`.
    input.value = ''
    if (files.length === 0) return
    importBtn.disabled = true
    const restore = importBtn.textContent
    importBtn.textContent = t('outputs.warp.reading')
    void mgr
      .readWarpFiles(files)
      .then(read => {
        if (!read.ok) show(paragraph(describeWarpRefusal(read.refusal), 'output-error'))
        else if (read.layout !== null) show(...confirmBundleLayout(read.sources, read.layout))
        else show(...askQuadrants(read.sources))
      })
      .catch(err => {
        // A file that went away between the pick and the read, or one the
        // platform would not hand over — not a refusal, so not worded as one.
        logger.warn('[outputUI] reading a warp bundle failed:', err)
        show(paragraph(t('outputs.warp.readFailed'), 'output-error'))
      })
      .finally(() => {
        importBtn.textContent = restore
        importBtn.disabled = false
      })
  })

  /** What arrived, in one sentence: the first thing both flows say. */
  const arrived = (sources: readonly WarpSource[]): HTMLElement =>
    paragraph(
      plural(
        sources.length,
        { one: 'outputs.warp.arrived.one', other: 'outputs.warp.arrived.other' },
        { ids: sources.map(s => s.id).join(', ') },
      ),
      'output-note',
    )

  /**
   * The two buttons that end either flow. The confirm button imports by
   * `placement`; Cancel clears the question and imports nothing.
   */
  const decision = (sources: readonly WarpSource[], placement: WarpPlacement, confirmLabel: string): HTMLElement => {
    const choose = button(confirmLabel, 'output-warp-choose')
    const cancel = button(t('outputs.warp.cancel'), 'output-warp-cancel')
    cancel.addEventListener('click', () => show())
    choose.addEventListener('click', () => {
      choose.disabled = true
      cancel.disabled = true
      void mgr
        .importWarpSet(record.label, sources, placement)
        .then(result => {
          if (!result.ok) {
            show(paragraph(describeWarpRefusal(result.refusal), 'output-error'))
            return
          }
          // Said through the app-wide announcer rather than `pending`: the
          // repaint replaces this whole section, region included, and a
          // region swapped out with its content announces nothing.
          announcePolite(
            plural(
              sources.length,
              { one: 'outputs.warp.loaded.one', other: 'outputs.warp.loaded.other' },
              { ids: sources.map(s => s.id).join(', ') },
            ),
          )
          repaint()
        })
        .catch(err => {
          logger.warn('[outputUI] importing a warp set failed:', err)
          choose.disabled = false
          cancel.disabled = false
        })
    })
    const row = document.createElement('div')
    row.className = 'output-warp-actions'
    row.append(choose, cancel)
    return row
  }

  /**
   * No layout to read: what arrived, where SOS's quadrants would put it,
   * and the question. It asks for the frame as well as the place, since
   * files with no layout cannot say what their `(u, v)` address and a
   * dome's fisheye mesh would otherwise import on the placement alone;
   * the confirm button names both, so the click is the declaration.
   */
  const askQuadrants = (sources: readonly WarpSource[]): HTMLElement[] => {
    const ids = sources.map(s => s.id)
    return [
      arrived(sources),
      paragraph(t('outputs.warp.askQuadrants'), 'output-note'),
      layoutDiagram(
        SOS_QUADRANTS.map(q => ({ ...q, filled: ids.includes(q.id) })),
        monitor.size,
      ),
      paragraph(t('outputs.warp.quadrantsKey'), 'output-note'),
      ...stretchWarnings(
        stretchGroups(
          placeMeshes(sources, id => SOS_QUADRANTS.find(q => q.id === id)?.viewport),
          monitor.size,
        ),
      ),
      decision(sources, 'sos-quadrants', t('outputs.warp.useQuadrants')),
    ]
  }

  /**
   * The bundle says where its meshes go: draw that, say what it baked in,
   * compare the display it was solved for with this one, and import on
   * one click. There is no question to ask — only a chance to see the
   * layout before the projectors change.
   */
  const confirmBundleLayout = (sources: readonly WarpSource[], layout: BundleLayout): HTMLElement[] => {
    const meshes = placeMeshes(sources, id => layout.projectors.find(p => p.id === id)?.viewport)
    const parts: HTMLElement[] = [
      arrived(sources),
      paragraph(t('outputs.warp.bundlePlaces'), 'output-note'),
      layoutDiagram(
        layout.projectors.map(p => ({ id: p.id, viewport: p.viewport, filled: true })),
        monitor.size,
      ),
      layoutAsText(layout),
      paragraph(
        layout.texture.surface === 'sphere'
          ? t('outputs.warp.bakedRotationSphere', {
              degrees: formatNumber(layout.texture.rotationOffsetDeg, { maximumFractionDigits: 2 }),
            })
          : t('outputs.warp.bakedRotationMesh'),
        'output-note',
      ),
    ]
    const solved = layout.framebuffer
    const here = monitor.size
    // What each picture will actually be on this display: the truth the
    // warnings report, unless one line about the display says it all.
    let stretched = stretchGroups(meshes, here)
    if (solved.width !== here.width || solved.height !== here.height) {
      const params = { solvedWidth: solved.width, solvedHeight: solved.height, width: here.width, height: here.height }
      const reshaped = displayStretchPercent(solved, here)
      if (reshaped === null) {
        parts.push(paragraph(t('outputs.warp.framebufferResampled', params), 'output-note'))
      } else if (stretchGroups(meshes, solved).length === 0) {
        // Every mesh fits the display it was solved for, so this display's
        // shape is the whole story: each picture is stretched by exactly
        // `reshaped`, and one line says so for every projector.
        parts.push(
          paragraph(
            plural(
              meshes.length,
              { one: 'outputs.warp.framebufferStretched.one', other: 'outputs.warp.framebufferStretched.other' },
              { ...params, percent: reshaped },
            ),
            'output-warning',
          ),
        )
        stretched = []
      } else {
        // A mesh that does not fit even its own layout: the display is
        // not the whole story, so it is stated as a fact and each picture
        // is reported as it will be here. The two can cancel, and a
        // projector this display happens to suit gets no warning.
        parts.push(paragraph(t('outputs.warp.framebufferDifferentShape', params), 'output-warning'))
      }
    }
    parts.push(...stretchWarnings(stretched), decision(sources, layout, t('outputs.warp.useBundleLayout')))
    return parts
  }

  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true
    void mgr
      .clearOutputWarp(record.label)
      .then(() => {
        announcePolite(t('outputs.warp.none'))
        repaint()
      })
      .catch(err => {
        logger.warn('[outputUI] clearing a warp failed:', err)
        clearBtn.disabled = false
      })
  })

  section.appendChild(buildBlendGamma(mgr, record))
  return section
}

/**
 * The blend gamma (convention 2): the display gamma the projectors' blend
 * weights are applied through, 2.2 unless a calibration says otherwise.
 * Committed on `change` — a typed "2.4" must not pass through "2" on the
 * way — and put back if the value is not one the output would use.
 */
function buildBlendGamma(mgr: OutputWarpManager, record: OutputRecord): HTMLElement {
  const field = document.createElement('label')
  field.className = 'output-field'
  const text = document.createElement('span')
  text.className = 'output-field-label'
  text.textContent = t('outputs.warp.blendGamma')
  const number = document.createElement('input')
  number.type = 'number'
  number.className = 'output-field-number output-warp-gamma'
  number.min = '0.5'
  number.max = '4'
  number.step = '0.05'
  let applied = record.render.blendGamma
  number.value = String(applied)
  number.title = t('outputs.warp.blendGammaHint')
  number.addEventListener('change', () => {
    const raw = number.value.trim()
    const next = Number(raw)
    // `Number('')` is 0, not NaN — the empty check is the one that
    // keeps a field cleared for retyping from committing a gamma of 0.
    if (raw === '' || !Number.isFinite(next) || next <= 0 || next > 10) {
      number.value = String(applied)
      return
    }
    number.disabled = true
    void mgr
      .setOutputRenderConfig(record.label, { blendGamma: next })
      .then(() => {
        applied = next
      })
      .catch(err => {
        logger.warn('[outputUI] blend gamma change failed:', err)
        number.value = String(applied)
      })
      .finally(() => {
        number.disabled = false
      })
  })
  field.append(text, number)
  return field
}
