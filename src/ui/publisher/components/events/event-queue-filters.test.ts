// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderQueueFilters, type QueueFiltersOptions } from './event-queue-filters'
import { emptyQueueQuery, type QueueQuery } from './events-model'
import { until } from '../../../../test-utils'

function render(over: Partial<QueueFiltersOptions> = {}) {
  const onChange = vi.fn<(q: QueueQuery) => void>()
  const onDraft = vi.fn<(q: QueueQuery) => void>()
  const filters = renderQueueFilters({
    query: emptyQueueQuery(),
    sources: [
      { value: 'NASA EONET', count: 84 },
      { value: 'NOAA News', count: 12 },
    ],
    categories: [{ value: 'Wildfires', count: 60 }],
    loaded: 96,
    total: 96,
    onChange,
    onDraft,
    ...over,
  })
  // Attached, as on the page: a detached control never reports. The
  // app-wide announcer is part of every page the portal runs in.
  const announcer = document.createElement('div')
  announcer.id = 'a11y-announcer'
  document.body.replaceChildren(filters.element, announcer)
  const selects = filters.element.querySelectorAll<HTMLSelectElement>('select')
  return {
    filters,
    onChange,
    onDraft,
    announcer,
    search: filters.element.querySelector<HTMLInputElement>('input[type="search"]')!,
    source: selects[0],
    category: selects.length === 3 ? selects[1] : null,
    sort: selects[selects.length - 1],
    clear: filters.element.querySelector<HTMLButtonElement>('.publisher-events-query-clear')!,
    count: filters.element.querySelector<HTMLElement>('.publisher-events-query-count')!,
  }
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change'))
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('renderQueueFilters', () => {
  it('labels every control and offers each source with its count', () => {
    const { filters, source, sort } = render()
    expect(filters.element.getAttribute('role')).toBe('search')
    for (const control of filters.element.querySelectorAll('input, select')) {
      expect(control.closest('label')?.textContent?.trim()).not.toBe('')
    }
    expect([...source.options].map(o => o.textContent)).toEqual([
      'All sources',
      'NASA EONET (84)',
      'NOAA News (12)',
    ])
    expect(sort.value).toBe('newest')
  })

  it('applies a dropdown change at once', () => {
    const { onChange, source, category, sort } = render()
    choose(source, 'NOAA News')
    expect(onChange).toHaveBeenLastCalledWith({ ...emptyQueueQuery(), source: 'NOAA News' })
    choose(category!, 'Wildfires')
    expect(onChange).toHaveBeenLastCalledWith({ ...emptyQueueQuery(), source: 'NOAA News', category: 'Wildfires' })
    choose(sort, 'bestMatch')
    expect(onChange).toHaveBeenLastCalledWith({
      text: '',
      source: 'NOAA News',
      category: 'Wildfires',
      sort: 'bestMatch',
    })
    choose(source, '')
    expect(onChange.mock.lastCall?.[0].source).toBeNull()
  })

  it('applies typed text once, after the typing pauses', async () => {
    const { onChange, search } = render()
    type(search, 'w')
    type(search, 'wi')
    type(search, 'wild')
    expect(onChange).not.toHaveBeenCalled()
    await until(() => onChange.mock.calls.length > 0, 'the debounced search')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].text).toBe('wild')
  })

  it('reports nothing once detached — the page that replaced it owns the detail pane', async () => {
    const { filters, onChange, search, source } = render()
    type(search, 'wild')
    filters.element.remove()
    choose(source, 'NOAA News')
    expect(onChange).not.toHaveBeenCalled()
    // Outlast the debounce with a positive anchor: a second, attached
    // control's own debounced report proves the timer window has passed.
    const other = render()
    type(other.search, 'x')
    await until(() => other.onChange.mock.calls.length > 0, 'the attached control reporting')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows Clear only while something is filtered, and Clear keeps the sort', () => {
    const { onChange, clear, source, sort, search } = render({
      query: { text: 'fire', source: null, category: null, sort: 'oldest' },
    })
    expect(clear.hidden).toBe(false)
    expect(search.value).toBe('fire')
    expect(sort.value).toBe('oldest')
    choose(source, 'NASA EONET')
    clear.click()
    expect(onChange).toHaveBeenLastCalledWith({ text: '', source: null, category: null, sort: 'oldest' })
    expect(search.value).toBe('')
    expect(source.value).toBe('')
    expect(clear.hidden).toBe(true)
    expect(document.activeElement).toBe(search)
  })

  it('keeps a chosen source the bucket lacks, at zero, instead of showing "all"', () => {
    const { source } = render({ query: { ...emptyQueueQuery(), source: 'GDACS' } })
    expect(source.value).toBe('GDACS')
    expect(source.selectedOptions[0].textContent).toBe('GDACS (0)')
  })

  it('omits the category dropdown when no loaded event has a category', () => {
    const { category, filters } = render({ categories: [] })
    expect(category).toBeNull()
    expect(filters.element.querySelectorAll('select')).toHaveLength(2)
  })

  it('counts all loaded events, or the matches while filtering', () => {
    const plain = render()
    plain.filters.setCount(96)
    expect(plain.count.textContent).toBe('96 events')
    // Not a live region: it would speak after nearly every keystroke.
    expect(plain.count.getAttribute('role')).toBeNull()
    expect(plain.count.getAttribute('aria-live')).toBeNull()

    const filtered = render({ query: { ...emptyQueueQuery(), text: 'fire' } })
    filtered.filters.setCount(12)
    expect(filtered.count.textContent).toBe('12 of 96 shown')
  })

  it('hands every edit to the page at once, before the search applies', () => {
    const { onDraft, onChange, search } = render()
    type(search, 'fl')
    expect(onDraft).toHaveBeenLastCalledWith({ ...emptyQueueQuery(), text: 'fl' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('announces a changed count once input goes quiet, and not the first one', async () => {
    const { filters, search, announcer } = render()
    filters.setCount(96) // the page arriving: the baseline, not news
    type(search, 'fire')
    filters.setCount(12, 'Wildfire near Boise')
    await until(() => announcer.textContent !== '', 'the count announcement')
    expect(announcer.textContent).toBe('12 of 96 shown Now showing Wildfire near Boise.')
  })

  it('does not repeat an unchanged count', async () => {
    const { filters, sort, announcer } = render({ query: { ...emptyQueueQuery(), text: 'fire' } })
    filters.setCount(12)
    choose(sort, 'oldest')
    filters.setCount(12)
    // A positive anchor: a different count afterwards is announced, so
    // the quiet window has passed and the repeat above was skipped.
    filters.setCount(11)
    await until(() => announcer.textContent !== '', 'the changed count')
    expect(announcer.textContent).toBe('11 of 96 shown')
  })

  it('announces the count on request, whatever was said before', async () => {
    const { filters, announcer } = render({ query: { ...emptyQueueQuery(), source: 'NOAA News' } })
    filters.setCount(12)
    filters.announceCount()
    await until(() => announcer.textContent !== '', 'the forced announcement')
    expect(announcer.textContent).toBe('12 of 96 shown')
  })

  it('notes when the server loaded only part of the bucket, and ties the note to the search box', () => {
    const capped = render({ loaded: 500, total: 734 })
    const note = capped.filters.element.querySelector('.publisher-events-query-note')
    expect(note?.textContent).toContain('500 of 734')
    expect(capped.search.getAttribute('aria-describedby')).toBe(note?.id)
    const whole = render()
    expect(whole.filters.element.querySelector('.publisher-events-query-note')).toBeNull()
    expect(whole.search.hasAttribute('aria-describedby')).toBe(false)
  })
})
