import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderDatasetForm } from './dataset-form'

/**
 * The data-encoded controls, which are the only way to publish a
 * dataset whose luma carries values rather than a picture.
 *
 * The behaviour worth pinning is the *ordering*: `render_encoding` is
 * read off the row by the transcode when it fires, so a row that
 * acquires the flag after its bytes are uploaded is one that claims to
 * carry values it has already lost to a bicubic rescale. These assert
 * that the upload cannot start before the sidecar is readable.
 */

const VALID_SCALE = JSON.stringify({
  stops: [
    { t: 0, rgba: [68, 1, 84, 0] },
    { t: 1, rgba: [253, 231, 37, 255] },
  ],
  vmin: -35,
  vmax: 78.025,
  units: 'dBZ',
  dataMinLuma: 8,
})

function mount(overrides: Record<string, unknown> = {}): {
  root: HTMLElement
  fetchFn: ReturnType<typeof vi.fn>
} {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ dataset: { id: 'ds1' } }), { status: 200 }))
  renderDatasetForm(root, {
    mode: 'create',
    navigate: vi.fn(),
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  } as unknown as Parameters<typeof renderDatasetForm>[1])
  return { root, fetchFn }
}

function toggle(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('#dataset-data-encoded')
}

function scaleBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('#dataset-color-scale')
}

/** Walk to the Media step — the form is a stepper and only the active
 *  section is in the DOM's visible flow. */
function openMedia(root: HTMLElement): void {
  const nav = root.querySelector<HTMLElement>(
    '.publisher-form-nav-link[data-section="ds-section-media"]')
  if (!nav) throw new Error('media step nav button not found')
  nav.click()
}

describe('dataset form — data-encoded controls', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('offers the encoding toggle, off by default', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
    // The sidecar field only exists once the mode is chosen — an
    // always-visible JSON textarea on a picture dataset is noise.
    expect(scaleBox(root)).toBeNull()
  })

  it('reveals the colour-scale field when enabled', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    expect(scaleBox(root)).not.toBeNull()
  })

  it('rejects a malformed sidecar while it is still on screen', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = '{ "stops": [], "vmin": 1, "vmax": 1 }'
    area.dispatchEvent(new Event('input'))
    // Assert the specific message, not merely that *an* error element
    // exists — a required-title error would satisfy that and the test
    // would pass without the sidecar ever being validated.
    expect(root.textContent ?? '').toMatch(/not a valid colour scale/i)
  })

  it('accepts a valid sidecar', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = VALID_SCALE
    area.dispatchEvent(new Event('input'))
    const text = root.textContent ?? ''
    expect(text).toMatch(/dBZ/)
  })

  it('does not send the encoding pair for an ordinary picture dataset', async () => {
    // A pair of nulls in the body of every dataset ever created would
    // be the wrong fix for "unticking must clear the columns".
    const { root, fetchFn } = mount()
    const title = root.querySelector<HTMLInputElement>('#dataset-title')
    if (title) {
      title.value = 'Picture dataset'
      title.dispatchEvent(new Event('change'))
    }
    const form = root.querySelector('form')
    form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await Promise.resolve()
    // Anchor on the request having happened at all. Without this the
    // body is `undefined`, every `not.toContain` trivially holds, and
    // the test reports success for a form that never submitted.
    expect(fetchFn).toHaveBeenCalled()
    const body = fetchFn.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    expect(body as string).not.toContain('render_encoding')
    expect(body as string).not.toContain('color_scale')
  })
})
