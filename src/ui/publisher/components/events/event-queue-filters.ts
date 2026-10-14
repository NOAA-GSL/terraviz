// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Events queue's search, filter and sort controls — a free-text
 * search, a source dropdown, a category dropdown and a sort order, over
 * the status bucket already loaded. All of it is client-side: the page
 * holds the whole bucket (up to the server's cap), and the matching and
 * ordering live in `events-model.ts` as pure functions.
 *
 * Text is applied after a short pause in typing rather than per
 * keystroke. The page swaps the detail pane when the selected event is
 * filtered out, and a detail render mounts a map and asks outside hosts
 * for image suggestions — once per letter typed would be a burst of
 * both for a word nobody finished. The dropdowns apply at once.
 *
 * The controls keep their own DOM between changes rather than being
 * rebuilt, so the search box keeps focus and caret while the list under
 * it changes. Framework-free.
 */

import { plural, t } from '../../../../i18n'
import { debounce } from '../../../../utils/debounce'
import {
  QUEUE_SORTS,
  emptyQueueQuery,
  isQueueFiltered,
  type FacetOption,
  type QueueQuery,
  type QueueSort,
} from './events-model'

/** How long typing must pause before the search applies. */
export const SEARCH_DEBOUNCE_MS = 200

export interface QueueFiltersOptions {
  query: QueueQuery
  sources: readonly FacetOption[]
  categories: readonly FacetOption[]
  /** Events loaded into the page. */
  loaded: number
  /** Events the status bucket holds on the server — more than `loaded`
   *  when the server stopped at its cap. */
  total: number
  onChange: (query: QueueQuery) => void
}

export interface QueueFilters {
  element: HTMLElement
  /** Drop the search and both filters (the sort stays), tell the page,
   *  and put focus in the search box. */
  clear(): void
  /** Show how many events the query keeps. */
  setCount(shown: number): void
}

function sortLabel(sort: QueueSort): string {
  switch (sort) {
    case 'newest': return t('publisher.events.query.sort.newest')
    case 'oldest': return t('publisher.events.query.sort.oldest')
    case 'bestMatch': return t('publisher.events.query.sort.bestMatch')
    case 'mostToReview': return t('publisher.events.query.sort.mostToReview')
  }
}

function field(caption: string, control: HTMLElement, extraClass = ''): HTMLElement {
  const label = document.createElement('label')
  label.className = `publisher-events-query-field${extraClass ? ` ${extraClass}` : ''}`
  const text = document.createElement('span')
  text.className = 'publisher-events-query-caption'
  text.textContent = caption
  label.append(text, control)
  return label
}

/** A dropdown of `options` under an "all" choice whose value is `''`.
 *  A selected value the bucket no longer has (the curator switched
 *  status) is kept as a zero-count choice, so the control still says
 *  what is filtering the list instead of quietly showing "all". */
function facetSelect(allLabel: string, options: readonly FacetOption[], selected: string | null): HTMLSelectElement {
  const select = document.createElement('select')
  select.className = 'publisher-events-query-select'
  const all = document.createElement('option')
  all.value = ''
  all.textContent = allLabel
  select.append(all)
  const shown = selected !== null && !options.some(o => o.value === selected)
    ? [...options, { value: selected, count: 0 }]
    : options
  for (const opt of shown) {
    const option = document.createElement('option')
    option.value = opt.value
    option.textContent = t('publisher.events.query.option', { name: opt.value, count: String(opt.count) })
    select.append(option)
  }
  select.value = selected ?? ''
  return select
}

export function renderQueueFilters(opts: QueueFiltersOptions): QueueFilters {
  let current: QueueQuery = { ...opts.query }

  const root = document.createElement('div')
  root.className = 'publisher-events-query'
  root.setAttribute('role', 'search')
  root.setAttribute('aria-label', t('publisher.events.query.aria'))

  const search = document.createElement('input')
  search.type = 'search'
  search.className = 'publisher-events-query-input'
  search.placeholder = t('publisher.events.query.searchPlaceholder')
  search.value = current.text

  const source = facetSelect(t('publisher.events.query.allSources'), opts.sources, current.source)

  const category = opts.categories.length > 0 || current.category !== null
    ? facetSelect(t('publisher.events.query.allCategories'), opts.categories, current.category)
    : null

  const sort = document.createElement('select')
  sort.className = 'publisher-events-query-select'
  for (const s of QUEUE_SORTS) {
    const option = document.createElement('option')
    option.value = s
    option.textContent = sortLabel(s)
    sort.append(option)
  }
  sort.value = current.sort

  // A text button on the count's line rather than a button in the
  // controls row: it appears on the first keystroke, and in the row it
  // wrapped onto a line of its own and pushed the queue down mid-word.
  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'publisher-events-query-clear'
  clearBtn.textContent = t('publisher.events.query.clear')

  // Announced politely after each change, so a screen-reader user hears
  // what the search did without leaving the box. The Clear button sits
  // beside it, not inside, so it is not read out with every count.
  const count = document.createElement('p')
  count.className = 'publisher-events-query-count'
  count.setAttribute('role', 'status')
  const statusRow = document.createElement('div')
  statusRow.className = 'publisher-events-query-status'
  statusRow.append(count, clearBtn)

  const controls = document.createElement('div')
  controls.className = 'publisher-events-query-controls'
  controls.append(
    field(t('publisher.events.query.search'), search, 'publisher-events-query-field-search'),
    field(t('publisher.events.query.source'), source),
  )
  if (category) controls.append(field(t('publisher.events.query.category'), category))
  controls.append(field(t('publisher.events.query.sort'), sort))
  root.append(controls, statusRow)

  if (opts.total > opts.loaded) {
    const note = document.createElement('p')
    note.className = 'publisher-events-query-note'
    note.textContent = t('publisher.events.query.truncated', {
      loaded: String(opts.loaded),
      total: String(opts.total),
    })
    root.append(note)
  }

  const syncClear = (): void => {
    clearBtn.hidden = !isQueueFiltered(current)
  }

  // A change still pending when the page re-renders (the curator typed,
  // then clicked a status pill) must not reach the page that replaced
  // this one: that page owns the live detail pane and its map now.
  const emit = (): void => {
    syncClear()
    if (root.isConnected) opts.onChange({ ...current })
  }
  const emitSoon = debounce(emit, SEARCH_DEBOUNCE_MS)

  search.addEventListener('input', () => {
    current = { ...current, text: search.value }
    emitSoon()
  })
  source.addEventListener('change', () => {
    current = { ...current, source: source.value === '' ? null : source.value }
    emit()
  })
  category?.addEventListener('change', () => {
    current = { ...current, category: category.value === '' ? null : category.value }
    emit()
  })
  sort.addEventListener('change', () => {
    current = { ...current, sort: sort.value as QueueSort }
    emit()
  })

  const clear = (): void => {
    current = { ...emptyQueueQuery(), sort: current.sort }
    search.value = ''
    source.value = ''
    if (category) category.value = ''
    emit()
    search.focus()
  }
  clearBtn.addEventListener('click', clear)

  syncClear()

  return {
    element: root,
    clear,
    setCount(shown: number): void {
      count.textContent = isQueueFiltered(current)
        ? t('publisher.events.query.count.filtered', { shown: String(shown), total: String(opts.loaded) })
        : plural(
            opts.loaded,
            { one: 'publisher.events.query.count.one', other: 'publisher.events.query.count.other' },
            { count: opts.loaded },
          )
    },
  }
}
