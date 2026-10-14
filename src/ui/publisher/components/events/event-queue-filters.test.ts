// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderQueueFilters, type QueueFiltersOptions } from './event-queue-filters'
import { emptyQueueQuery, type QueueQuery } from './events-model'
import { until } from '../../../../test-utils'

function render(over: Partial<QueueFiltersOptions> = {}) {
  const onChange = vi.fn<(q: QueueQuery) => void>()
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
    ...over,
  })
  // Attached, as on the page: a detached control never reports.
  document.body.replaceChildren(filters.element)
  const selects = filters.element.querySelectorAll<HTMLSelectElement>('select')
  return {
    filters,
    onChange,
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
    expect(plain.count.getAttribute('role')).toBe('status')

    const filtered = render({ query: { ...emptyQueueQuery(), text: 'fire' } })
    filtered.filters.setCount(12)
    expect(filtered.count.textContent).toBe('12 of 96 match')
  })

  it('notes when the server loaded only part of the bucket', () => {
    const capped = render({ loaded: 500, total: 734 })
    expect(capped.filters.element.querySelector('.publisher-events-query-note')?.textContent).toContain('500 of 734')
    const whole = render()
    expect(whole.filters.element.querySelector('.publisher-events-query-note')).toBeNull()
  })
})
