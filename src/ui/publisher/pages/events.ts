// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * /publish/events — the current-events review queue, redesigned as
 * **Direction A: a master–detail triage queue**
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md`).
 *
 * Readable by any active publisher; writes gate per event on
 * `can_edit`, and the feed Refresh is admin-only. Fetches the caller's
 * role (`/api/v1/publish/me`) and the events queue (`GET
 * /api/v1/publish/events`), then renders a top bar (heading + status
 * filter pills + Refresh / New-event actions + the search / source /
 * category / sort controls) over a two-pane body: the **event queue** on
 * the left (`event-queue.ts`) and the selected event's **detail** on the
 * right (`event-detail.ts`) with the two-level approval model. Both
 * review actions post to `POST /api/v1/publish/events/:id`.
 *
 * Search, filters and sort run client-side over the loaded bucket
 * (`event-queue-filters.ts`, matching in `events-model.ts`). The query
 * lives on the page state, so it survives a status switch, a feed
 * refresh and the reload that follows a review decision.
 */

import { fetchFeatures, renderFeatureDisabledCard } from '../features'
import { roleCan } from '../../../types/publisher-roles'
import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'
import { announcePolite } from '../../domUtils'
import { renderEventQueue } from '../components/events/event-queue'
import { renderEventDetail } from '../components/events/event-detail'
import { mountEventLocator } from '../components/events/event-locator-map'
import { openNewEventDrawer } from '../components/events/new-event-drawer'
import { renderQueueFilters, type QueueFilters } from '../components/events/event-queue-filters'
import {
  applyQueueQuery,
  categoryOptions,
  emptyQueueQuery,
  isQueueFiltered,
  matchesQueueQuery,
  sourceOptions,
  type EventStatus,
  type EventsResponse,
  type QueueQuery,
  type ReviewEvent,
} from '../components/events/events-model'

interface MeResponse {
  role: string
  is_admin: boolean
}

const ME_ENDPOINT = '/api/v1/publish/me'
const EVENTS_ENDPOINT = '/api/v1/publish/events'
const REFRESH_ENDPOINT = '/api/v1/publish/events/refresh'
/** As many events as the server will return (its `MAX_EVENT_LIST_LIMIT`).
 *  Search runs client-side, so an event not loaded cannot be found. */
const QUEUE_LIMIT = 500

interface RefreshResult {
  created: number
  refreshed: number
  failed: number
}

/** The queue's status filter — the four statuses plus `all`. */
type QueueFilter = EventStatus | 'all'
const QUEUE_FILTERS: readonly QueueFilter[] = ['proposed', 'approved', 'rejected', 'expired', 'all']

export interface EventsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

/** Holds the currently-mounted locator's disposer so it can be torn down
 *  before ANY re-render — not just a selection swap. Filter/refresh/reload
 *  paths call `mount.replaceChildren(...)`, which would otherwise orphan a
 *  live MapLibre WebGL context. */
interface LocatorHolder {
  dispose: (() => void) | null
}

/** Internal page state: the public options plus the locator holder that
 *  survives across re-renders within one page session, whether the
 *  caller is an admin (gates the feed-Refresh action; the review
 *  controls themselves gate per-event on `can_edit`), and the curator's
 *  search / filter / sort, which outlives every reload in the session. */
type TriageState = EventsPageOptions & {
  locator: LocatorHolder
  isAdmin: boolean
  canCreate: boolean
  query: QueueQuery
  /** Bumped by every load. A render, or a response, from an older
   *  generation has been replaced and must not touch the page — the
   *  locator above belongs to whichever render is current. */
  renderGen: number
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

function el(tag: string, className: string, children: (HTMLElement | string)[] = []): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  for (const c of children) node.append(c)
  return node
}

function shell(...children: HTMLElement[]): HTMLElement {
  return el('main', 'publisher-shell', children)
}

function card(...children: HTMLElement[]): HTMLElement {
  return el('section', 'publisher-card', children)
}

export async function renderEventsPage(mount: HTMLElement, options: EventsPageOptions = {}): Promise<void> {
  if (!(await fetchFeatures()).events) {
    renderFeatureDisabledCard(mount, 'events')
    return
  }
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', 'publisher-loading', [t('publisher.events.loading')])))

  const meRes = await publisherGet<MeResponse>(ME_ENDPOINT, { fetchFn })
  if (!meRes.ok) {
    if (meRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = meRes.kind === 'server' ? { status: meRes.status, body: meRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(meRes.kind, details)))
    return
  }
  // The whole events queue is readable by any active publisher. Writes
  // (approve / reject / edit / tour) gate per-event on `can_edit`; the
  // feed-Refresh action stays admin-only (it drives the feed connectors).
  await loadAndRenderQueue(mount, {
    fetchFn,
    navigate: options.navigate,
    locator: { dispose: null },
    isAdmin: clientIsPrivileged(meRes.data),
    // Composing a manual event needs an authoring role — derived from
    // the `me` read the page already made (no extra request).
    canCreate: roleCan(meRes.data.role, 'content.create'),
    query: emptyQueueQuery(),
    renderGen: 0,
  })
}

/** Fetch the queue at `status` and render the triage view. `selectId`
 *  prefers a specific event for the initial selection (e.g. a just-created
 *  one) when it's present in the returned list. Resolves true when the
 *  queue was rendered — false for an error card, a session redirect, or
 *  a load a newer one overtook — so a caller placing focus knows whether
 *  there is anything to place it on. */
async function loadAndRenderQueue(
  mount: HTMLElement,
  state: TriageState,
  notice?: string,
  status: QueueFilter = 'proposed',
  selectId?: string,
): Promise<boolean> {
  // From here on, anything the previous render still has in flight (a
  // review POST, a pending search) is stale.
  const gen = ++state.renderGen
  // Tear down any live locator before this render replaces the DOM, so a
  // filter/refresh/reload can't orphan its WebGL context.
  state.locator.dispose?.()
  state.locator.dispose = null
  const res = await publisherGet<EventsResponse>(
    `${EVENTS_ENDPOINT}?status=${status}&limit=${QUEUE_LIMIT}`,
    { fetchFn: state.fetchFn },
  )
  // A later load (another status pill) has started; its answer wins
  // whichever of the two arrives first.
  if (gen !== state.renderGen) return false
  if (!res.ok) {
    if (res.kind === 'session') {
      if (handleSessionError({ navigate: state.navigate }) === 'navigating') return false
      mount.replaceChildren(shell(buildErrorCard('session')))
      return false
    }
    const details = res.kind === 'server' ? { status: res.status, body: res.body } : {}
    mount.replaceChildren(shell(buildErrorCard(res.kind, details)))
    return false
  }
  const { events } = res.data
  // An older server sends no total; then what arrived is all there is.
  const total = Math.max(res.data.total ?? events.length, events.length)
  renderTriage(mount, events, total, state, notice, status, gen, selectId)
  return true
}

/** The master–detail triage view: top bar + (queue | detail). */
function renderTriage(
  mount: HTMLElement,
  events: ReviewEvent[],
  total: number,
  state: TriageState,
  notice: string | undefined,
  filter: QueueFilter,
  gen: number,
  selectId?: string,
): void {
  const live = (): boolean => state.renderGen === gen

  // A just-created event the query would hide is the one event the
  // curator certainly wants to see, so drop the search and filters for
  // it (the sort is kept — it hides nothing).
  const wanted = selectId ? events.find(e => e.id === selectId) : undefined
  if (wanted && !matchesQueueQuery(wanted, state.query)) {
    state.query = { ...emptyQueueQuery(), sort: state.query.sort }
  }

  let visible = applyQueueQuery(events, state.query)
  let selectedId: string | null =
    (selectId && visible.some(e => e.id === selectId) ? selectId : visible[0]?.id) ?? null

  // The body rebuilds queue + detail together so selection + in-place
  // status changes (which mutate `events`) stay in sync. The active
  // locator map is disposed before each rebuild so its WebGL context
  // doesn't leak across selections.
  const body = el('div', 'publisher-events-body')
  const eyebrow = filter === 'all' ? t('publisher.events.filter.all') : statusLabel(filter)
  let queue: HTMLElement | null = null
  // Declared before the closures that read it; assigned once the body
  // exists (nothing reads it before then).
  let filters: QueueFilters | null = null

  const queueList = (): HTMLElement | null =>
    queue?.querySelector<HTMLElement>('.publisher-events-queue-list') ?? null
  const buildQueue = (): HTMLElement =>
    renderEventQueue(visible, selectedId, {
      onSelect: id => {
        if (!live()) return
        selectedId = id
        rebuildBody()
        // The row that was clicked was replaced with the queue; put focus
        // back on its successor rather than dropping it to <body>.
        queue?.querySelector<HTMLElement>('.publisher-events-queue-row-selected')?.focus({ preventScroll: true })
      },
    }, eyebrow)
  // Re-render just the queue node in place (keeps queue | detail as the
  // grid's two direct children) so a per-link / bulk decision refreshes
  // the "N datasets to review" count without rebuilding the detail pane.
  // It does not re-sort: an event jumping out from under the pointer
  // because the curator just ruled on one of its pairings is worse than
  // an order that goes stale until the next query change. The list's
  // scroll position is carried over for the same reason.
  const refreshQueue = (keepScroll = true): void => {
    if (!live() || !queue) return
    const scrollTop = keepScroll ? (queueList()?.scrollTop ?? 0) : 0
    const next = buildQueue()
    queue.replaceWith(next)
    queue = next
    const list = queueList()
    if (list) list.scrollTop = scrollTop
  }
  const rebuildBody = (keepScroll = true): void => {
    if (!live()) return
    const scrollTop = keepScroll ? (queueList()?.scrollTop ?? 0) : 0
    state.locator.dispose?.()
    state.locator.dispose = null
    body.replaceChildren()
    queue = null
    if (events.length === 0) {
      body.append(el('p', 'publisher-empty-message', [t('publisher.events.empty')]))
      return
    }
    if (visible.length === 0) {
      body.append(renderNoMatch(() => filters?.clear()))
      return
    }
    queue = buildQueue()
    const selected = visible.find(e => e.id === selectedId) ?? visible[0]
    const detail = renderEventDetail(selected, {
      fetchFn: state.fetchFn,
      navigate: state.navigate,
      mountLocator: (slot, point) => {
        const dispose = mountEventLocator(slot, point)
        // A replaced render must not overwrite the live page's handle.
        if (live()) state.locator.dispose = dispose
        else dispose()
      },
      onEventStatusChange: (_id, next) => {
        if (!live()) return
        // If the event no longer matches the active filter, reload so it
        // leaves the queue; otherwise just refresh the body so the queue
        // dot reflects the new status.
        if (filter !== 'all' && next !== filter) {
          void loadAndRenderQueue(mount, state, t('publisher.events.saved'), filter)
          return
        }
        rebuildBody()
      },
      onLinksChanged: () => refreshQueue(),
    })
    body.append(queue, detail)
    const list = queueList()
    if (list) list.scrollTop = scrollTop
  }

  // Nothing loaded means nothing to search; the empty state says so.
  if (events.length > 0) {
    filters = renderQueueFilters({
      query: state.query,
      sources: sourceOptions(events),
      categories: categoryOptions(events),
      loaded: events.length,
      total,
      // Typed text is the page's as soon as it is typed, so a status
      // switch inside the debounce window keeps it.
      onDraft: next => {
        if (live()) state.query = next
      },
      onChange: next => {
        if (!live()) return
        state.query = next
        visible = applyQueueQuery(events, next)
        // Keep the detail pane (and its map) when the selected event
        // survives the change; otherwise the first match takes over.
        if (queue && selectedId !== null && visible.some(e => e.id === selectedId)) {
          filters?.setCount(visible.length)
          refreshQueue(false)
          return
        }
        selectedId = visible[0]?.id ?? null
        filters?.setCount(visible.length, visible[0]?.title ?? null)
        rebuildBody(false)
      },
    })
    filters.setCount(visible.length)
  }

  rebuildBody()

  const topbar = renderTopbar(mount, state, notice, filter, filters?.element ?? null)
  mount.replaceChildren(shell(topbar, card(body)))
  // The notice ("Saved.", a refresh result, "Event created.") sits in a
  // status paragraph that arrives already holding its text, which screen
  // readers do not reliably speak; and a query carried over from before
  // this load is filtering a list the curator has not heard about. Say
  // both, as one utterance, since the announcer keeps only the last.
  if (filters && isQueueFiltered(state.query)) filters.announceCount(notice)
  else if (notice) announcePolite(notice)
}

/** The body when the query hides every loaded event: say so, and offer
 *  the way back beside the message rather than only up in the toolbar. */
function renderNoMatch(onClear: () => void): HTMLElement {
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'publisher-button'
  clear.textContent = t('publisher.events.query.clear')
  clear.addEventListener('click', onClear)
  return el('div', 'publisher-events-nomatch', [
    el('p', 'publisher-empty-message', [t('publisher.events.query.noMatch')]),
    clear,
  ])
}

/** Top bar: heading, status-filter pills, Refresh / New-event actions
 *  (New event opens the slide-in drawer), the search / filter / sort
 *  controls when there is anything to search, and a status line. */
function renderTopbar(
  mount: HTMLElement,
  state: TriageState,
  notice: string | undefined,
  filter: QueueFilter,
  queryControls: HTMLElement | null,
): HTMLElement {
  const status = el('p', 'publisher-events-actions-status', notice ? [notice] : [])
  status.setAttribute('role', 'status')

  const refreshBtn = document.createElement('button')
  refreshBtn.type = 'button'
  refreshBtn.className = 'publisher-button'
  refreshBtn.textContent = t('publisher.events.refresh')
  refreshBtn.addEventListener('click', () => {
    refreshBtn.disabled = true
    status.classList.remove('publisher-events-status-error')
    status.textContent = t('publisher.events.refreshing')
    void publisherSend<RefreshResult>(REFRESH_ENDPOINT, {}, { method: 'POST', fetchFn: state.fetchFn }).then(res => {
      if (res.ok) {
        void loadAndRenderQueue(
          mount,
          state,
          t('publisher.events.refreshResult', {
            created: String(res.data.created),
            refreshed: String(res.data.refreshed),
            failed: String(res.data.failed),
          }),
          filter,
        )
        return
      }
      refreshBtn.disabled = false
      if (res.kind === 'session' && handleSessionError({ navigate: state.navigate }) === 'navigating') return
      status.textContent = t('publisher.events.refreshError')
      status.classList.add('publisher-events-status-error')
    })
  })

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'publisher-button publisher-button-primary'
  newBtn.textContent = t('publisher.events.new')
  newBtn.addEventListener('click', () => {
    openNewEventDrawer({
      fetchFn: state.fetchFn,
      navigate: state.navigate,
      // Prefer-select the new event so its manual + matched links are
      // ready to vet. It lands `proposed`, so reload a bucket that can
      // hold it: Proposed, or All if that is the view. Reloading Approved,
      // Rejected or Expired would leave it nowhere on the page. (It can
      // still miss the page in one case: an old occurred date in a bucket
      // past the server's 500, where it sorts below the cut.)
      onCreated: newId => {
        const into: QueueFilter = filter === 'all' ? 'all' : 'proposed'
        // Say so when the bucket changed, or nothing tells a screen-reader
        // user the list under them is a different one.
        const notice = into === filter
          ? t('publisher.events.form.created')
          : t('publisher.events.form.createdIn', { bucket: statusLabel('proposed') })
        // The drawer handed focus back to New event, which the reload
        // replaces; put it on the new event's row instead, one Tab from the
        // detail pane where its pairings are vetted next.
        void loadAndRenderQueue(mount, state, notice, into, newId).then(rendered => {
          if (rendered) mount.querySelector<HTMLElement>('.publisher-events-queue-row-selected')?.focus()
        })
      },
    })
  })

  const filters = el('div', 'publisher-events-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', t('publisher.events.filter.label'))
  for (const f of QUEUE_FILTERS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `publisher-events-filter${f === filter ? ' publisher-events-filter-active' : ''}`
    btn.textContent = f === 'all' ? t('publisher.events.filter.all') : statusLabel(f)
    btn.setAttribute('aria-pressed', f === filter ? 'true' : 'false')
    btn.addEventListener('click', () => {
      if (f === filter) return
      // The pill is replaced with the page; land focus on its successor.
      void loadAndRenderQueue(mount, state, undefined, f).then(rendered => {
        if (rendered) mount.querySelector<HTMLElement>('.publisher-events-filter-active')?.focus()
      })
    })
    filters.append(btn)
  }

  // Feed Refresh is admin-only (it runs the feed connectors); New event
  // needs an authoring role (reviewers get neither).
  const toolbarBtns: HTMLElement[] = []
  if (state.isAdmin) toolbarBtns.push(refreshBtn)
  if (state.canCreate) toolbarBtns.push(newBtn)
  const toolbar = el('div', 'publisher-events-toolbar', toolbarBtns)
  const bar = el('div', 'publisher-events-topbar', [
    el('div', 'publisher-events-topbar-head', [
      el('h2', 'publisher-card-heading', [t('publisher.events.title')]),
      toolbar,
    ]),
    el('p', 'publisher-events-intro', [t('publisher.events.subtitle')]),
    filters,
    ...(queryControls ? [queryControls] : []),
    status,
  ])
  return card(bar)
}

function statusLabel(status: EventStatus): string {
  switch (status) {
    case 'proposed': return t('publisher.events.status.proposed')
    case 'approved': return t('publisher.events.status.approved')
    case 'rejected': return t('publisher.events.status.rejected')
    case 'expired': return t('publisher.events.status.expired')
  }
}

