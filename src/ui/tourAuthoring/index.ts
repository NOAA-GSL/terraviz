// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tour-authoring public surface — consumed by `src/main.ts` to
 * detect the `?tourEdit=` URL param and mount the dock.
 *
 * Phase 3pt/A: detection + mount + a single "Discard" exit.
 * Persistence, more captures, the task editor, preview, and
 * publish all land in later sub-phases of this branch.
 */

import { logger } from '../../utils/logger'
import { collapseBrowseUI } from '../browseUI'
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
 * True when any page above this one in the frame tree is on another
 * origin.
 *
 * The dock is a publisher write surface: it saves, uploads media and
 * publishes with the signed-in publisher's credentials. It lives on
 * the public document (`/?tourEdit=<id>`), which any site may embed by
 * default, so it cannot lean on `frame-ancestors` the way `/publish`
 * does. A foreign page could frame it and trick a publisher into
 * clicking through to Publish. Refusing to mount there closes that
 * without restricting the public app. The portal opens the dock as a
 * top-level navigation, so no real use is framed.
 *
 * `location.ancestorOrigins` names every ancestor where the browser
 * offers it (Chromium, WebKit); a sandboxed one reads `"null"`, which
 * counts as foreign. Elsewhere, reading the top window's origin throws
 * across origins, which also counts as foreign.
 */
export function hasForeignAncestor(win: Window = window): boolean {
  if (win.top === win) return false
  const own = win.location.origin
  const ancestors = win.location.ancestorOrigins
  if (ancestors && ancestors.length > 0) {
    for (let i = 0; i < ancestors.length; i++) {
      if (ancestors[i] !== own) return true
    }
  }
  try {
    return win.top?.location.origin !== own
  } catch {
    return true
  }
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
  if (hasForeignAncestor()) {
    logger.warn('[tourAuthoring] Not mounting the authoring dock inside a page from another site.')
    return null
  }
  if (activeHandle) {
    logger.warn('[tourAuthoring] initTourAuthoring called while a dock is already mounted; ignoring.')
    return activeHandle
  }
  // Phase 3pt-review/F — collapse the browse overlay so the
  // dock isn't obscured at boot, and flip the body class that
  // hides `#help-trigger` (otherwise it sits z-index:600 over
  // the dock's z-index:50, covering the top-right corner). The
  // overlay stays in the DOM — the publisher can re-open it to
  // load a dataset for a `loadDataset` capture.
  collapseBrowseUI()
  document.body.classList.add('tour-authoring-open')
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
        document.body.classList.remove('tour-authoring-open')
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
  document.body.classList.remove('tour-authoring-open')
  if (activeHandle) {
    activeHandle.dispose()
    activeHandle = null
  }
}
