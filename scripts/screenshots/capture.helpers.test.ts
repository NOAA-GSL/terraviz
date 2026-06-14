import { describe, expect, it } from 'vitest'

import { padClip, slugKey } from './capture'

describe('capture helpers', () => {
  describe('slugKey', () => {
    it('turns a dotted message key into a filesystem-safe slug', () => {
      expect(slugKey('browse.card.load')).toBe('browse-card-load')
    })

    it('collapses runs of non-alphanumerics and trims edges', () => {
      expect(slugKey('chat.settings.url.placeholder')).toBe(
        'chat-settings-url-placeholder',
      )
      expect(slugKey('.leading.and.trailing.')).toBe('leading-and-trailing')
    })
  })

  describe('padClip', () => {
    const vp = { width: 1440, height: 900 }

    it('pads the box by the given amount when there is room', () => {
      expect(padClip({ x: 100, y: 100, width: 50, height: 20 }, 24, vp)).toEqual({
        x: 76,
        y: 76,
        width: 98, // (100+50+24) - 76
        height: 68, // (100+20+24) - 76
      })
    })

    it('clamps to the top-left viewport edge', () => {
      const clip = padClip({ x: 5, y: 5, width: 40, height: 10 }, 24, vp)
      expect(clip.x).toBe(0)
      expect(clip.y).toBe(0)
    })

    it('clamps to the bottom-right viewport edge', () => {
      const clip = padClip(
        { x: 1400, y: 880, width: 60, height: 40 },
        24,
        vp,
      )
      expect(clip.x + clip.width).toBeLessThanOrEqual(vp.width)
      expect(clip.y + clip.height).toBeLessThanOrEqual(vp.height)
    })

    it('yields a zero-size clip for a box fully outside the viewport', () => {
      const clip = padClip(
        { x: 2000, y: 2000, width: 10, height: 10 },
        24,
        vp,
      )
      expect(clip.width).toBe(0)
      expect(clip.height).toBe(0)
    })
  })
})
