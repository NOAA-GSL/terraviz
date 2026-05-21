/**
 * In-memory tour-authoring state — the dock reads / writes here as
 * the publisher captures tasks; the persistence layer (tour/E,
 * upcoming) flushes to R2 + the `tours` row.
 *
 * Scope for tour/A: just the model + reducers. No autosave, no
 * backend round-trip. Closing the tab loses the state — same
 * fail-state every multi-step authoring tool ships before
 * autosave lands. The id is either a server-issued ULID (when the
 * dock opens against an existing tour) or the sentinel `'new'`
 * (fresh draft, no backend row yet).
 */

import type { TourTaskDef } from '../../types'

export interface TourAuthoringState {
  /** Server ULID for an existing tour, or `'new'` for a fresh draft. */
  tourId: string
  /** Free-text title. Defaults to a placeholder; tour/E surfaces a
   *  proper title field. */
  title: string
  /** Ordered list of tour tasks captured so far. */
  tasks: TourTaskDef[]
}

export function createEmptyState(tourId: string): TourAuthoringState {
  return { tourId, title: '', tasks: [] }
}

/** Append a captured task. Returns a new state object so the caller
 *  can re-render without aliasing. */
export function appendTask(
  state: TourAuthoringState,
  task: TourTaskDef,
): TourAuthoringState {
  return { ...state, tasks: [...state.tasks, task] }
}

/** Remove the task at `index` (used by the task editor in tour/D;
 *  exposed here so the model surface stays in one file). */
export function removeTaskAt(
  state: TourAuthoringState,
  index: number,
): TourAuthoringState {
  if (index < 0 || index >= state.tasks.length) return state
  const next = state.tasks.slice()
  next.splice(index, 1)
  return { ...state, tasks: next }
}
