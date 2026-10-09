// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Where a `projector-warp` output's meshes live between launches
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16", "Where the meshes live"): one
 * `localStorage` key per set, `sos-multi-output-warp:<warpId>`, holding
 * each mesh's own text and where it was placed.
 *
 * **Content, not a path.** A webview's `<input type="file">` never says
 * where a file lives, reading one back later would need a filesystem
 * capability this app does not grant, and a calibration commonly arrives
 * on a laptop or a USB stick that leaves the building after the import.
 * A Bourke mesh is about 80 KB of text, so the set itself is kept.
 *
 * **One key per set, none shared with the main config.** The main config
 * is rewritten on every toggle and should not carry a few hundred
 * kilobytes each time; a corrupt set then costs the outputs that use it
 * their warp and nothing else, because no read ever parses two sets at
 * once; and replacing a set is one `setItem`, so a write cut short cannot
 * leave half a set or damage another.
 *
 * **Re-read through the check that accepted it.** Every read re-parses
 * the meshes with `placeWarpSet` — one parser, one set of refusals — and
 * recomputes the content id: a set whose id no longer matches its key has
 * changed since it was written, and is refused rather than drawn.
 *
 * **The write is checked.** The largest thing the app keeps here, against
 * a per-origin quota of a few megabytes that a fine export of a
 * many-projector rig can reach: a set that does not fit is refused whole,
 * never kept in part.
 *
 * **Deleted when the operator lets go of it, and only then.** The plan's
 * rule was "deleted with its last reference", and a reference can vanish
 * by accident: a restore drops an output whose monitor was not
 * enumerated at boot — a projector array still powered off — and a
 * clean-up keyed on references would delete that rig's calibration with
 * it, when the laptop it came from may have left the building. So the
 * manager calls `remove` from the deliberate paths — Remove, a hand
 * close, Clear, a replacing import — when no other output still names
 * the set, and a set left behind by a failure stays, costing space. It
 * rarely costs even that: re-importing the same files lands under the
 * same content id, so the same key.
 *
 * Pure apart from the injected storage: no DOM, no Tauri, no timers.
 */

import { placeWarpSet, type PlacedWarpMesh, type WarpSetRefusal } from '../../output/projectorWarp'
import { logger } from '../../utils/logger'
import { isWarpSetId, type WarpTexture } from './protocol'
import { warpSetId, type WarpLayoutSource, type WarpSet, type WarpSetMesh } from './warpImport'

/** Every stored set's key is this plus its content id. */
export const WARP_SET_KEY_PREFIX = 'sos-multi-output-warp:'

/**
 * Schema version of one stored set. A mismatch is refused rather than
 * half-read — the same rule the main config follows — and here it costs
 * one output its warp rather than the installation its outputs.
 */
export const WARP_SET_VERSION = 1

/** One stored set: `localStorage['sos-multi-output-warp:' + id]`. */
export interface PersistedWarpSet extends WarpSet {
  readonly version: typeof WARP_SET_VERSION
  /** ISO 8601. For the panel, never for a decision. */
  readonly importedAt: string
}

/**
 * The slice of `Storage` this module needs — wider than the main
 * config's `StorageLike`, because it deletes, and because `list` has to
 * find sets this session did not write.
 */
export interface WarpStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

export type WarpSetWrite =
  | { readonly ok: true }
  /** No storage at all, or storage that refused for a reason other than space. */
  | { readonly ok: false; readonly reason: 'unavailable' | 'no-room' }

export type WarpSetRead =
  | { readonly ok: true; readonly set: PersistedWarpSet; readonly placed: readonly PlacedWarpMesh[] }
  | {
      readonly ok: false
      /**
       * `missing`: nothing under the key. `unreadable`: not a set this
       * build can read — not JSON, another version, a malformed field.
       * `altered`: its content no longer hashes to its key, so it changed
       * after it was written. `refused`: it reads, and the warp check
       * refuses it — `refusal` says how.
       */
      readonly reason: 'missing' | 'unreadable' | 'altered' | 'refused'
      readonly refusal?: WarpSetRefusal
    }

export interface WarpSetStore {
  write(id: string, set: WarpSet, importedAt: string): WarpSetWrite
  read(id: string): WarpSetRead
  /**
   * Delete one stored set. Never throws: a removal that failed leaves a
   * set behind, which costs space; one that threw would cost the
   * operator's action it follows.
   */
  remove(id: string): void
  /** The ids of every stored set, including ones nothing names any more. */
  list(): string[]
}

const LAYOUT_SOURCES: readonly WarpLayoutSource[] = ['sos-quadrants', 'bundle']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function meshFrom(value: unknown): WarpSetMesh | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null
  const { id, sourceName, text } = value
  const { x, y, w, h } = value.viewport
  if (typeof id !== 'string' || typeof sourceName !== 'string' || typeof text !== 'string') return null
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { id, sourceName, text, viewport: { x: x as number, y: y as number, w: w as number, h: h as number } }
}

/**
 * What a stored set says its meshes address: `null` when nothing said,
 * `undefined` when what is stored is not one of the two shapes a texture
 * takes. Absent reads as `null`, for a set written before textures were.
 */
function textureFrom(value: unknown): WarpTexture | null | undefined {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) return undefined
  if (value.surface === 'sphere' && typeof value.rotationOffsetDeg === 'number' && Number.isFinite(value.rotationOffsetDeg)) {
    return { surface: 'sphere', rotationOffsetDeg: value.rotationOffsetDeg }
  }
  if (value.surface === 'mesh' && value.rotationOffsetDeg === null) return { surface: 'mesh', rotationOffsetDeg: null }
  return undefined
}

/** The stored text as a set, or `null` for anything this build did not write. */
function parseStoredSet(raw: string): PersistedWarpSet | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== WARP_SET_VERSION) return null
  const { importedAt, layoutFrom, meshes } = parsed
  if (typeof importedAt !== 'string') return null
  if (!LAYOUT_SOURCES.includes(layoutFrom as WarpLayoutSource)) return null
  // Not part of the content id, so checked for shape instead: a bundle's
  // layout always states a texture, and SOS's quadrants never do.
  const texture = textureFrom(parsed.texture)
  if (texture === undefined || (layoutFrom === 'bundle') !== (texture !== null)) return null
  if (!Array.isArray(meshes)) return null
  const read = meshes.map(meshFrom)
  if (read.some((m) => m === null)) return null
  return {
    version: WARP_SET_VERSION,
    importedAt,
    layoutFrom: layoutFrom as WarpLayoutSource,
    texture,
    meshes: read as WarpSetMesh[],
  }
}

/** Space, by any of the names engines give it. */
function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

function defaultStorage(): WarpStorageLike | null {
  try {
    // Access, not just presence: private-mode Safari has the object and
    // throws on use.
    if (typeof localStorage === 'undefined') return null
    void localStorage.length
    return localStorage
  } catch {
    return null
  }
}

/**
 * A store over `localStorage`, or an inert one where it is unavailable —
 * reads find nothing and writes report `unavailable`, so an import is
 * refused with a reason rather than accepted and forgotten.
 */
export function createWarpSetStore(storage: WarpStorageLike | null = defaultStorage()): WarpSetStore {
  return {
    write(id, set, importedAt) {
      if (!storage) return { ok: false, reason: 'unavailable' }
      const stored: PersistedWarpSet = { version: WARP_SET_VERSION, importedAt, ...set }
      try {
        storage.setItem(WARP_SET_KEY_PREFIX + id, JSON.stringify(stored))
        return { ok: true }
      } catch (err) {
        logger.warn('[multiOutput] could not store a warp set:', err)
        return { ok: false, reason: isQuotaError(err) ? 'no-room' : 'unavailable' }
      }
    },

    read(id) {
      if (!storage || !isWarpSetId(id)) return { ok: false, reason: 'missing' }
      let raw: string | null
      try {
        raw = storage.getItem(WARP_SET_KEY_PREFIX + id)
      } catch {
        return { ok: false, reason: 'missing' }
      }
      if (raw === null) return { ok: false, reason: 'missing' }
      const set = parseStoredSet(raw)
      if (set === null) return { ok: false, reason: 'unreadable' }
      if (warpSetId(set.meshes) !== id) return { ok: false, reason: 'altered' }
      const checked = placeWarpSet(set.meshes)
      if (!checked.ok) return { ok: false, reason: 'refused', refusal: checked.refusal }
      return { ok: true, set, placed: checked.placed }
    },

    remove(id) {
      if (!storage || !isWarpSetId(id)) return
      try {
        storage.removeItem(WARP_SET_KEY_PREFIX + id)
      } catch (err) {
        logger.warn('[multiOutput] could not delete a stored warp set:', err)
      }
    },

    list() {
      if (!storage) return []
      const ids: string[] = []
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (key !== null && key.startsWith(WARP_SET_KEY_PREFIX)) ids.push(key.slice(WARP_SET_KEY_PREFIX.length))
        }
      } catch (err) {
        logger.warn('[multiOutput] could not list stored warp sets:', err)
      }
      return ids
    },
  }
}
