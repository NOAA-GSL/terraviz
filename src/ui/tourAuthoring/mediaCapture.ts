/**
 * Pure capture helpers for the dock's Media group (task: tour media
 * authoring). Builds positionless `showImage` / `showVideo` tasks —
 * no SOS coordinate fields, so the player routes them into the
 * responsive media rail (`tourUI.usesMediaRail`) — plus the
 * hide-latest capture that pairs them.
 *
 * Kept separate from `dock.ts` so the ID-minting and hide-pairing
 * logic is unit-testable without mounting the dock.
 */

import type { ShowImageTaskParams, TourTaskDef } from '../../types'

/** Read a task's single key/value without trusting its shape. */
function taskEntry(task: TourTaskDef): [string, unknown] {
  const key = Object.keys(task)[0] ?? ''
  return [key, (task as Record<string, unknown>)[key]]
}

/**
 * Mint the next dock-issued image overlay ID (`media1`, `media2`, …)
 * — scans existing `showImage` tasks so re-opening a draft continues
 * the sequence instead of colliding with earlier captures.
 */
export function nextMediaId(tasks: readonly TourTaskDef[]): string {
  let max = 0
  for (const task of tasks) {
    const [key, value] = taskEntry(task)
    if (key !== 'showImage' && key !== 'showImg') continue
    const id = (value as ShowImageTaskParams | undefined)?.imageID
    const m = typeof id === 'string' ? /^media(\d+)$/.exec(id) : null
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `media${max + 1}`
}

/** True for the http(s) URLs tour media may reference. */
export function isHttpMediaUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Build a positionless `showImage` task (→ the media rail). */
export function buildShowImageTask(
  url: string,
  caption: string,
  tasks: readonly TourTaskDef[],
): TourTaskDef {
  const params: ShowImageTaskParams = {
    imageID: nextMediaId(tasks),
    filename: url,
    ...(caption.trim() ? { caption: caption.trim() } : {}),
  }
  return { showImage: params }
}

/** Build a positionless `showVideo` task (→ the media rail). */
export function buildShowVideoTask(url: string): TourTaskDef {
  return { showVideo: { filename: url } }
}

/**
 * Build the hide task for the most recently shown, still-visible
 * media overlay — the "Hide latest media" chip. Walks the task list
 * replaying show/hide pairs (including the SOS empty-string
 * "hide all videos" convention) and returns `{ hideImage: id }` /
 * `{ hideVideo: filename }` for the newest survivor, or null when
 * every shown media already has its hide.
 */
export function buildHideLatestMediaTask(tasks: readonly TourTaskDef[]): TourTaskDef | null {
  // Visible media in show order: kind + the identifier its hide task uses.
  const visible: Array<{ kind: 'image' | 'video'; ref: string }> = []
  const dropWhere = (pred: (v: { kind: 'image' | 'video'; ref: string }) => boolean): void => {
    for (let i = visible.length - 1; i >= 0; i--) {
      if (pred(visible[i])) visible.splice(i, 1)
    }
  }
  for (const task of tasks) {
    const [key, value] = taskEntry(task)
    switch (key) {
      case 'showImage':
      case 'showImg': {
        const id = (value as ShowImageTaskParams | undefined)?.imageID
        if (typeof id === 'string' && id) {
          dropWhere(v => v.kind === 'image' && v.ref === id)
          visible.push({ kind: 'image', ref: id })
        }
        break
      }
      case 'playVideo':
      case 'showVideo': {
        const filename = (value as { filename?: unknown } | undefined)?.filename
        if (typeof filename === 'string' && filename) {
          dropWhere(v => v.kind === 'video' && v.ref === filename)
          visible.push({ kind: 'video', ref: filename })
        }
        break
      }
      case 'hideImage':
      case 'hideImg':
        if (typeof value === 'string') dropWhere(v => v.kind === 'image' && v.ref === value)
        break
      case 'hideVideo':
      case 'hidePlayVideo':
      case 'stopVideo':
        if (typeof value === 'string') {
          // Empty string = hide ALL videos (SOS convention).
          dropWhere(v => v.kind === 'video' && (value === '' || v.ref === value))
        }
        break
      default:
        break
    }
  }
  const latest = visible[visible.length - 1]
  if (!latest) return null
  return latest.kind === 'image'
    ? ({ hideImage: latest.ref } as TourTaskDef)
    : ({ hideVideo: latest.ref } as TourTaskDef)
}
