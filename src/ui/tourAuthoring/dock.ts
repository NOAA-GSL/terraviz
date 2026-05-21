/**
 * Floating tour-authoring dock — attaches to the regular SPA chrome
 * when the user opens `/?tourEdit=<id>` (or `=new`). First commit
 * (tour/A) ships:
 *
 *   - Dock chrome (header, close button)
 *   - One working capture: "Add camera step" → flyTo task from the
 *     current map view
 *   - In-memory task list rendered below the dock buttons
 *   - "Discard" button → navigates back to /publish/tours
 *
 * Later sub-phases extend the action set, add the task editor,
 * autosave, preview, and publish. Each capture function lives next
 * to the button so the per-task UX stays co-located with the wire
 * shape it produces.
 *
 * Architectural choice: the dock is a pure DOM mount. State lives
 * in `state.ts`; the renderer hands back a `dispose()` so the host
 * can tear down on session end.
 */

import { t } from '../../i18n'
import { escapeAttr, escapeHtml } from '../domUtils'
import { logger } from '../../utils/logger'
import type { FlyToTaskParams, MapViewContext, TourTaskDef } from '../../types'
import {
  appendTask,
  createEmptyState,
  type TourAuthoringState,
} from './state'

/**
 * Host-supplied callbacks. The dock only needs:
 *   - `getMapView()` → current viewport (`MapViewContext` shape) for
 *     camera-step capture
 *   - `onDiscard()` → user wants out; host clears the URL param and
 *     routes back to /publish/tours
 */
export interface TourAuthoringCallbacks {
  getMapView: () => MapViewContext | null
  onDiscard: () => void
}

export interface TourAuthoringHandle {
  /** Tear down the dock DOM + listeners. Idempotent. */
  dispose: () => void
}

/**
 * Mount the dock at the top-right of the viewport. Returns a
 * handle the host can use to dispose the dock on session end
 * (or on a re-mount). Re-mounting without disposing leaves
 * stacked docks — the host is responsible for the lifecycle.
 *
 * `tourId` is the URL-param value (`'new'` for fresh drafts, a
 * ULID otherwise). Stored on the state object for tour/E's
 * autosave; the dock itself doesn't act on it in tour/A.
 */
export function mountTourAuthoringDock(
  tourId: string,
  callbacks: TourAuthoringCallbacks,
): TourAuthoringHandle {
  let state = createEmptyState(tourId)
  const root = document.createElement('div')
  root.className = 'tour-authoring-dock'
  root.setAttribute('aria-label', t('tour.dock.aria'))
  root.setAttribute('role', 'region')
  document.body.appendChild(root)

  function render(): void {
    root.innerHTML = `
      <div class="tour-authoring-dock-header">
        <span class="tour-authoring-dock-title">${escapeHtml(t('tour.dock.title'))}</span>
        <button type="button" class="tour-authoring-dock-close"
                aria-label="${escapeAttr(t('tour.dock.discard.aria'))}">×</button>
      </div>
      <div class="tour-authoring-dock-actions">
        <button type="button" class="tour-authoring-action" data-action="capture-camera">
          ${escapeHtml(t('tour.dock.action.captureCamera'))}
        </button>
      </div>
      <ol class="tour-authoring-task-list" aria-label="${escapeAttr(t('tour.dock.taskList.aria'))}">
        ${state.tasks.length === 0
          ? `<li class="tour-authoring-task-empty">${escapeHtml(t('tour.dock.taskList.empty'))}</li>`
          : state.tasks
              .map((task, i) => `<li class="tour-authoring-task">
                <span class="tour-authoring-task-index">${i + 1}.</span>
                <span class="tour-authoring-task-label">${escapeHtml(describeTask(task))}</span>
              </li>`)
              .join('')}
      </ol>
    `
    wireButtons()
  }

  function wireButtons(): void {
    root.querySelector('.tour-authoring-dock-close')?.addEventListener('click', () => {
      callbacks.onDiscard()
    })
    root
      .querySelector<HTMLButtonElement>('[data-action="capture-camera"]')
      ?.addEventListener('click', () => {
        const captured = captureCameraStep(callbacks)
        if (!captured) return
        state = appendTask(state, captured)
        render()
      })
  }

  render()
  return {
    dispose() {
      root.remove()
    },
  }
}

/**
 * Build a `flyTo` task from the current map view. Returns null
 * when the renderer can't supply a view (e.g. boot race — the
 * dock loaded before MapLibre had its first render). Caller
 * logs + skips.
 *
 * `altmi` is derived from the renderer's zoom level via the
 * inverse of `execFlyTo`'s zoom math in `tourEngine.ts`:
 *
 *     altKm = (6371 × 2) / 2^zoom
 *     altmi = altKm / (MI_TO_KM × SOS_ALTITUDE_SCALE)
 *
 * The two constants come from `tourEngine.ts`. Inlined here
 * rather than imported so the dock isn't coupled to the engine's
 * private module surface.
 */
function captureCameraStep(callbacks: TourAuthoringCallbacks): TourTaskDef | null {
  const view = callbacks.getMapView()
  if (!view) {
    logger.warn('[tourAuthoring] capture-camera: no view context available')
    return null
  }
  const altMi = altmiFromZoom(view.zoom)
  const params: FlyToTaskParams = {
    lat: roundTo(view.center.lat, 4),
    lon: roundTo(view.center.lng, 4),
    altmi: roundTo(altMi, 0),
    // Default to animated — that's what almost every SOS-format tour
    // uses, and the user can flip it later via the task editor (tour/D).
    animated: true,
  }
  return { flyTo: params }
}

const MI_TO_KM = 1.60934
const SOS_ALTITUDE_SCALE = 0.2
const EARTH_RADIUS_KM = 6371

function altmiFromZoom(zoom: number): number {
  const altKm = (EARTH_RADIUS_KM * 2) / Math.pow(2, zoom)
  return altKm / (MI_TO_KM * SOS_ALTITUDE_SCALE)
}

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals)
  return Math.round(n * factor) / factor
}

/**
 * One-line task summary for the in-dock task list. Mirrors the
 * SOS authoring tool's convention: action name + key params.
 * Phase 3pt/D extends this with click-to-edit; for now it's
 * just a label.
 */
function describeTask(task: TourTaskDef): string {
  if ('flyTo' in task) {
    const p = task.flyTo
    return t('tour.task.flyTo.summary', { lat: p.lat, lon: p.lon, altmi: p.altmi })
  }
  // Unknown task shape — fall back to the JSON key. Future
  // sub-phases extend this switch as more captures land.
  const key = Object.keys(task)[0]
  return key
}
