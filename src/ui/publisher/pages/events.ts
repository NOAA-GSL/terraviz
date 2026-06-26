/**
 * /publish/events — the current-events review queue
 * (`docs/CURRENT_EVENTS_PLAN.md` §5).
 *
 * Privileged-only (staff / admin / service). Fetches the caller's role
 * (`/api/v1/publish/me`) and the proposed events
 * (`GET /api/v1/publish/events`), then renders one card per event: its
 * source citation, summary, status, and the proposed event→dataset
 * links with their match score + per-signal breakdown. The curator
 * vets the event itself (Approve / Reject) and each dataset link
 * independently; both post to `POST /api/v1/publish/events/:id`.
 *
 * Non-privileged callers get a restricted card (the API also enforces
 * 403, but gating here avoids a fetch-then-reject round-trip).
 */

import { t } from '../../../i18n'
import { publisherGet, publisherSend, handleSessionError } from '../api'
import { buildErrorCard } from '../components/error-card'

interface MeResponse {
  role: string
  is_admin: boolean
}

type EventStatus = 'proposed' | 'approved' | 'rejected' | 'expired'
type LinkStatus = 'proposed' | 'approved' | 'rejected'

interface ReviewLink {
  datasetId: string
  datasetTitle: string | null
  score: number | null
  signals: { geo?: number | null; temporal?: number | null; semantic?: number | null } | null
  status: LinkStatus
}

interface ReviewEvent {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  status: EventStatus
  links: ReviewLink[]
}

interface EventsResponse {
  events: ReviewEvent[]
}

const ME_ENDPOINT = '/api/v1/publish/me'
const EVENTS_ENDPOINT = '/api/v1/publish/events'

export interface EventsPageOptions {
  fetchFn?: typeof fetch
  navigate?: (url: string) => void
}

function clientIsPrivileged(me: MeResponse): boolean {
  return me.is_admin === true || me.role === 'admin' || me.role === 'service'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  for (const c of children) node.append(c)
  return node
}

function shell(...children: HTMLElement[]): HTMLElement {
  const m = el('main', { className: 'publisher-shell' })
  for (const c of children) m.append(c)
  return m
}

function card(...children: HTMLElement[]): HTMLElement {
  const c = el('section', { className: 'publisher-card publisher-glass' })
  for (const child of children) c.append(child)
  return c
}

function heading(text: string): HTMLElement {
  return el('h2', { className: 'publisher-card-heading', textContent: text })
}

export async function renderEventsPage(
  mount: HTMLElement,
  options: EventsPageOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn
  mount.replaceChildren(shell(el('p', { className: 'publisher-loading', textContent: t('publisher.events.loading') })))

  // Resolve identity + gate BEFORE fetching the events queue: the events
  // endpoint 403s a non-privileged caller, which would otherwise surface
  // as a generic server-error card instead of the intended restricted
  // card.
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
  if (!clientIsPrivileged(meRes.data)) {
    mount.replaceChildren(
      shell(
        card(
          heading(t('publisher.events.title')),
          el('p', { className: 'publisher-events-restricted', textContent: t('publisher.events.restricted') }),
        ),
      ),
    )
    return
  }

  const eventsRes = await publisherGet<EventsResponse>(EVENTS_ENDPOINT, { fetchFn })
  if (!eventsRes.ok) {
    if (eventsRes.kind === 'session') {
      if (handleSessionError({ navigate: options.navigate }) === 'navigating') return
      mount.replaceChildren(shell(buildErrorCard('session')))
      return
    }
    const details = eventsRes.kind === 'server' ? { status: eventsRes.status, body: eventsRes.body } : {}
    mount.replaceChildren(shell(buildErrorCard(eventsRes.kind, details)))
    return
  }

  renderQueue(mount, eventsRes.data.events, { fetchFn, navigate: options.navigate })
}

function renderQueue(mount: HTMLElement, events: ReviewEvent[], state: EventsPageOptions): void {
  const intro = el('p', { className: 'publisher-events-intro', textContent: t('publisher.events.intro') })

  if (events.length === 0) {
    mount.replaceChildren(
      shell(card(heading(t('publisher.events.title')), intro, el('p', { className: 'publisher-empty-message', textContent: t('publisher.events.empty') }))),
    )
    return
  }

  const list = el('div', { className: 'publisher-events-list' })
  for (const event of events) list.append(renderEventCard(event, state))
  mount.replaceChildren(shell(card(heading(t('publisher.events.title')), intro), list))
}

/** Translated status label (literal keys so the MessageKey union
 *  verifies each one). */
function statusLabel(status: EventStatus | LinkStatus): string {
  switch (status) {
    case 'proposed':
      return t('publisher.events.status.proposed')
    case 'approved':
      return t('publisher.events.status.approved')
    case 'rejected':
      return t('publisher.events.status.rejected')
    case 'expired':
      return t('publisher.events.status.expired')
  }
}

/** A translated status badge for an event or link. */
function badge(status: EventStatus | LinkStatus): HTMLElement {
  return el('span', {
    className: `publisher-events-badge publisher-events-badge-${status}`,
    textContent: statusLabel(status),
  })
}

function formatScore(score: number | null): string {
  if (score == null) return '—'
  return `${Math.round(score * 100)}%`
}

function renderEventCard(event: ReviewEvent, state: EventsPageOptions): HTMLElement {
  const statusEl = el('div', { className: 'publisher-events-status', role: 'status' })
  const badgeEl = badge(event.status)

  const setBusy = (busy: boolean, buttons: HTMLButtonElement[]): void => {
    for (const b of buttons) b.disabled = busy
  }

  // ----- Event-level Approve / Reject -----
  const approveBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-primary', textContent: t('publisher.events.approve') })
  const rejectBtn = el('button', { type: 'button', className: 'publisher-btn', textContent: t('publisher.events.reject') })
  const eventButtons = [approveBtn, rejectBtn]

  const submitEvent = (decision: 'approve' | 'reject'): void => {
    statusEl.textContent = ''
    statusEl.classList.remove('publisher-events-status-error')
    setBusy(true, eventButtons)
    void publisherSend<{ event: { status: EventStatus } | null }>(
      `${EVENTS_ENDPOINT}/${event.id}`,
      { event: decision },
      { method: 'POST', fetchFn: state.fetchFn },
    ).then(res => {
      setBusy(false, eventButtons)
      if (res.ok) {
        const next: EventStatus = res.data.event?.status ?? (decision === 'approve' ? 'approved' : 'rejected')
        badgeEl.className = `publisher-events-badge publisher-events-badge-${next}`
        badgeEl.textContent = statusLabel(next)
        statusEl.textContent = t('publisher.events.saved')
        return
      }
      handleWriteError(res, statusEl, state.navigate)
    })
  }
  approveBtn.addEventListener('click', () => submitEvent('approve'))
  rejectBtn.addEventListener('click', () => submitEvent('reject'))

  // ----- Source citation -----
  const source = el('p', { className: 'publisher-events-source' }, [
    el('span', { className: 'publisher-field-label', textContent: t('publisher.events.source') + ': ' }),
    el('a', { className: 'publisher-events-source-link', href: event.source.url, target: '_blank', rel: 'noopener noreferrer', textContent: event.source.name }),
  ])
  if (event.source.publishedAt) {
    source.append(el('span', { className: 'publisher-events-published', textContent: ` · ${event.source.publishedAt}` }))
  }

  const headerRow = el('div', { className: 'publisher-events-header' }, [
    el('h3', { className: 'publisher-events-event-title', textContent: event.title }),
    badgeEl,
  ])

  const meta: HTMLElement[] = [headerRow, source]
  if (event.summary) meta.push(el('p', { className: 'publisher-events-summary', textContent: event.summary }))
  if (event.occurredStart) {
    const when = event.occurredEnd ? `${event.occurredStart} → ${event.occurredEnd}` : event.occurredStart
    meta.push(el('p', { className: 'publisher-events-when' }, [
      el('span', { className: 'publisher-field-label', textContent: t('publisher.events.occurred') + ': ' }),
      when,
    ]))
  }

  const eventActions = el('div', { className: 'publisher-events-actions' }, [approveBtn, rejectBtn])

  return el('article', { className: 'publisher-events-card publisher-glass' }, [
    ...meta,
    eventActions,
    renderLinks(event, state),
    statusEl,
  ])
}

function renderLinks(event: ReviewEvent, state: EventsPageOptions): HTMLElement {
  const wrap = el('div', { className: 'publisher-events-links' })
  wrap.append(el('h4', { className: 'publisher-events-links-heading', textContent: t('publisher.events.links') }))

  if (event.links.length === 0) {
    wrap.append(el('p', { className: 'publisher-events-nolinks', textContent: t('publisher.events.noLinks') }))
    return wrap
  }

  for (const link of event.links) wrap.append(renderLinkRow(event.id, link, state))
  return wrap
}

function renderLinkRow(eventId: string, link: ReviewLink, state: EventsPageOptions): HTMLElement {
  const linkBadge = badge(link.status)
  const rowStatus = el('span', { className: 'publisher-events-link-status', role: 'status' })

  const approveBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-small publisher-btn-primary', textContent: t('publisher.events.approve') })
  const rejectBtn = el('button', { type: 'button', className: 'publisher-btn publisher-btn-small', textContent: t('publisher.events.reject') })
  const buttons = [approveBtn, rejectBtn]

  const submit = (decision: 'approve' | 'reject'): void => {
    rowStatus.textContent = ''
    for (const b of buttons) b.disabled = true
    void publisherSend<unknown>(
      `${EVENTS_ENDPOINT}/${eventId}`,
      { links: [{ datasetId: link.datasetId, decision }] },
      { method: 'POST', fetchFn: state.fetchFn },
    ).then(res => {
      for (const b of buttons) b.disabled = false
      if (res.ok) {
        const next: LinkStatus = decision === 'approve' ? 'approved' : 'rejected'
        linkBadge.className = `publisher-events-badge publisher-events-badge-${next}`
        linkBadge.textContent = statusLabel(next)
        return
      }
      handleWriteError(res, rowStatus, state.navigate)
    })
  }
  approveBtn.addEventListener('click', () => submit('approve'))
  rejectBtn.addEventListener('click', () => submit('reject'))

  const signals = el('span', { className: 'publisher-events-signals' }, [
    signalChip('geo', link.signals?.geo),
    signalChip('temporal', link.signals?.temporal),
  ])

  return el('div', { className: 'publisher-events-link' }, [
    el('span', { className: 'publisher-events-link-title', textContent: link.datasetTitle ?? link.datasetId }),
    el('span', { className: 'publisher-events-link-score', textContent: `${t('publisher.events.match')} ${formatScore(link.score)}` }),
    signals,
    linkBadge,
    el('span', { className: 'publisher-events-link-actions' }, [approveBtn, rejectBtn]),
    rowStatus,
  ])
}

function signalChip(kind: 'geo' | 'temporal', value: number | null | undefined): HTMLElement {
  const label = kind === 'geo' ? t('publisher.events.signal.geo') : t('publisher.events.signal.temporal')
  const v = value == null ? '—' : `${Math.round(value * 100)}%`
  return el('span', { className: 'publisher-events-chip', textContent: `${label} ${v}` })
}

function handleWriteError(
  res: { ok: false; kind: string; errors?: Array<{ message: string }> },
  status: HTMLElement,
  navigate?: (url: string) => void,
): void {
  if (res.kind === 'session') {
    if (handleSessionError({ navigate }) === 'navigating') return
    status.textContent = t('publisher.events.error.session')
    status.classList.add('publisher-events-status-error')
    return
  }
  if (res.kind === 'validation' && res.errors && res.errors.length > 0) {
    status.textContent = res.errors[0].message
    status.classList.add('publisher-events-status-error')
    return
  }
  status.textContent = t('publisher.events.error.generic')
  status.classList.add('publisher-events-status-error')
}
