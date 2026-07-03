/**
 * Tests for the dock's Media capture helpers — positionless task
 * shapes (rail routing), media-ID minting across reopened drafts,
 * and the hide-latest pairing logic.
 */

import { describe, expect, it } from 'vitest'
import type { TourTaskDef } from '../../types'
import {
  buildHideLatestMediaTask,
  buildShowImageTask,
  buildShowVideoTask,
  isHttpMediaUrl,
  nextMediaId,
} from './mediaCapture'

describe('nextMediaId', () => {
  it('continues the dock sequence found in an existing draft', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media2', filename: 'https://x/a.png' } },
      { showImage: { imageID: 'hero-shot', filename: 'https://x/b.png' } },
    ]
    expect(nextMediaId(tasks)).toBe('media3')
    expect(nextMediaId([])).toBe('media1')
  })
})

describe('buildShowImageTask / buildShowVideoTask', () => {
  it('emits positionless params so the player routes to the media rail', () => {
    const task = buildShowImageTask('https://x/a.png', '  A caption ', [])
    expect(task).toEqual({
      showImage: { imageID: 'media1', filename: 'https://x/a.png', caption: 'A caption' },
    })
    // No SOS coordinates anywhere — that's the rail contract.
    expect(JSON.stringify(task)).not.toMatch(/xPct|yPct|widthPct|heightPct/)

    expect(buildShowVideoTask('https://x/clip.mp4')).toEqual({
      showVideo: { filename: 'https://x/clip.mp4' },
    })
  })

  it('omits an empty caption', () => {
    expect(buildShowImageTask('https://x/a.png', '   ', [])).toEqual({
      showImage: { imageID: 'media1', filename: 'https://x/a.png' },
    })
  })
})

describe('isHttpMediaUrl', () => {
  it('accepts http(s) and rejects everything else', () => {
    expect(isHttpMediaUrl('https://x/a.png')).toBe(true)
    expect(isHttpMediaUrl('http://x/a.png')).toBe(true)
    expect(isHttpMediaUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpMediaUrl('not a url')).toBe(false)
  })
})

describe('buildHideLatestMediaTask', () => {
  it('hides the newest still-visible media, respecting existing hides', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
      { showVideo: { filename: 'https://x/clip.mp4' } },
      { hideVideo: 'https://x/clip.mp4' },
    ]
    // The video is already hidden — the image is the newest survivor.
    expect(buildHideLatestMediaTask(tasks)).toEqual({ hideImage: 'media1' })
  })

  it('returns a hideVideo for the newest visible video', () => {
    const tasks: TourTaskDef[] = [
      { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
      { showVideo: { filename: 'https://x/clip.mp4' } },
    ]
    expect(buildHideLatestMediaTask(tasks)).toEqual({ hideVideo: 'https://x/clip.mp4' })
  })

  it('honours the empty-string hide-all-videos convention', () => {
    const tasks: TourTaskDef[] = [
      { showVideo: { filename: 'https://x/a.mp4' } },
      { showVideo: { filename: 'https://x/b.mp4' } },
      { hideVideo: '' },
    ]
    expect(buildHideLatestMediaTask(tasks)).toBeNull()
  })

  it('returns null when nothing is visible', () => {
    expect(buildHideLatestMediaTask([])).toBeNull()
    expect(
      buildHideLatestMediaTask([
        { showImage: { imageID: 'media1', filename: 'https://x/1.png' } },
        { hideImage: 'media1' },
      ]),
    ).toBeNull()
  })
})
