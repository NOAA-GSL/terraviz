/**
 * Tour-authoring public surface — consumed by `src/main.ts` to
 * detect the `?tourEdit=` URL param and mount the dock.
 *
 * Phase 3pt/A: detection + mount + a single "Discard" exit.
 * Persistence, more captures, the task editor, preview, and
 * publish all land in later sub-phases of this branch.
 */

import { logger } from '../../utils/logger'
import {
  mountTourAuthoringDock,
  type TourAuthoringCallbacks,
  type TourAuthoringHandle,
} from './dock'

const TOUR_EDIT_PARAM = 'tourEdit'

/**
 * Returns the tour id when the URL is in tour-authoring mode,
 * `null` otherwise. The id can be a server-issued ULID or the
 * sentinel `'new'` (fresh draft, no backend row yet).
 */
export function readTourEditParam(url: URL = new URL(window.location.href)): string | null {
  const value = url.searchParams.get(TOUR_EDIT_PARAM)
  if (!value || value.length === 0) return null
  return value
}

/**
 * Mount the dock if the URL signals tour-authoring mode. Idempotent
 * — the host calls this once per boot; re-calling without a prior
 * `dispose()` is a no-op (logs a warning so a buggy host doesn't
 * stack ghost docks). Returns null when the URL isn't in authoring
 * mode.
 */
let activeHandle: TourAuthoringHandle | null = null

export function initTourAuthoring(
  callbacks: TourAuthoringCallbacks,
): TourAuthoringHandle | null {
  const id = readTourEditParam()
  if (id === null) return null
  if (activeHandle) {
    logger.warn('[tourAuthoring] initTourAuthoring called while a dock is already mounted; ignoring.')
    return activeHandle
  }
  // Wrap the host's `onDiscard` so the singleton is cleared on
  // exit. The host's onDiscard typically navigates away from
  // `?tourEdit=`, which would trip the re-mount guard above on
  // any subsequent boot if we didn't null the singleton here.
  const hostOnDiscard = callbacks.onDiscard
  const wrappedCallbacks: TourAuthoringCallbacks = {
    ...callbacks,
    onDiscard: () => {
      try {
        hostOnDiscard()
      } finally {
        if (activeHandle) {
          activeHandle.dispose()
          activeHandle = null
        }
      }
    },
  }
  activeHandle = mountTourAuthoringDock(id, wrappedCallbacks)
  return activeHandle
}

/** Tear-down for tests / hot-reload. */
export function teardownTourAuthoring(): void {
  if (activeHandle) {
    activeHandle.dispose()
    activeHandle = null
  }
}
