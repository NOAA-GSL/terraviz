/**
 * `/publish/workflows` — Zyra workflow list (Phase Z2 of
 * `docs/ZYRA_INTEGRATION_PLAN.md`).
 *
 * Mirrors the tours list: table of registered workflows (name,
 * schedule, target dataset, enabled state, last run) with a New
 * workflow button. Rows link to the detail page (run history +
 * Run now); Edit links to the form.
 */

import { t } from '../../../i18n'
import { clearWarmupFlag, handleSessionError } from '../api'
import { listWorkflows, type PublisherWorkflow } from '../workflows-api'

export interface WorkflowsPageOptions {
  navigate?: (url: string) => void
  /** Override the list call — tests inject a stub. */
  listFn?: typeof listWorkflows
}

export async function renderWorkflowsPage(
  content: HTMLElement,
  options: WorkflowsPageOptions = {},
): Promise<void> {
  const navigate = options.navigate ?? ((url: string) => window.location.assign(url))
  const list = options.listFn ?? listWorkflows

  content.replaceChildren(buildMessageShell(t('publisher.workflows.loading')))

  const result = await list()
  if (!result.ok) {
    if (result.kind === 'session') {
      if (handleSessionError({ navigate }) === 'navigating') return
    }
    content.replaceChildren(buildMessageShell(t('publisher.workflows.error')))
    return
  }
  clearWarmupFlag()

  content.replaceChildren(buildShell(result.data.workflows, navigate))
}

function buildMessageShell(message: string): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'
  const card = document.createElement('section')
  card.className = 'publisher-card publisher-glass publisher-empty'
  const p = document.createElement('p')
  p.className = 'publisher-empty-message'
  p.textContent = message
  card.appendChild(p)
  shell.appendChild(card)
  return shell
}

function buildShell(
  workflows: PublisherWorkflow[],
  navigate: (url: string) => void,
): HTMLElement {
  const shell = document.createElement('main')
  shell.className = 'publisher-shell'

  const header = document.createElement('div')
  header.className = 'publisher-tour-list-header'
  const h2 = document.createElement('h2')
  h2.textContent = t('publisher.workflows.heading')
  header.appendChild(h2)

  const newLink = document.createElement('a')
  newLink.href = '/publish/workflows/new'
  newLink.className = 'publisher-tab publisher-tab-active publisher-tour-new-btn'
  newLink.textContent = t('publisher.workflows.new')
  interceptNav(newLink, navigate)
  header.appendChild(newLink)
  shell.appendChild(header)

  const intro = document.createElement('p')
  intro.className = 'publisher-tour-intro'
  intro.textContent = t('publisher.workflows.intro')
  shell.appendChild(intro)

  if (workflows.length === 0) {
    const empty = document.createElement('section')
    empty.className = 'publisher-card publisher-glass publisher-empty'
    const emptyTitle = document.createElement('p')
    emptyTitle.className = 'publisher-empty-message'
    emptyTitle.textContent = t('publisher.workflows.empty.title')
    empty.appendChild(emptyTitle)
    const emptyHint = document.createElement('p')
    emptyHint.className = 'publisher-tour-empty-hint'
    emptyHint.textContent = t('publisher.workflows.empty.hint')
    empty.appendChild(emptyHint)
    shell.appendChild(empty)
    return shell
  }

  shell.appendChild(buildTable(workflows, navigate))
  return shell
}

function buildTable(
  workflows: PublisherWorkflow[],
  navigate: (url: string) => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'publisher-table-wrap publisher-glass'
  const table = document.createElement('table')
  table.className = 'publisher-table'

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const key of [
    'publisher.workflows.col.name',
    'publisher.workflows.col.schedule',
    'publisher.workflows.col.target',
    'publisher.workflows.col.enabled',
    'publisher.workflows.col.lastRun',
    'publisher.workflows.col.actions',
  ] as const) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = t(key)
    headRow.appendChild(th)
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const workflow of workflows) {
    tbody.appendChild(buildRow(workflow, navigate))
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

function buildRow(workflow: PublisherWorkflow, navigate: (url: string) => void): HTMLElement {
  const tr = document.createElement('tr')
  const detailPath = `/publish/workflows/${encodeURIComponent(workflow.id)}`

  const nameCell = document.createElement('td')
  const nameLink = document.createElement('a')
  nameLink.className = 'publisher-row-link'
  nameLink.href = detailPath
  nameLink.textContent = workflow.name
  interceptNav(nameLink, navigate)
  nameCell.appendChild(nameLink)
  tr.appendChild(nameCell)

  const scheduleCell = document.createElement('td')
  scheduleCell.textContent = workflow.schedule // i18n-exempt: ISO-8601 duration token
  tr.appendChild(scheduleCell)

  const targetCell = document.createElement('td')
  const targetLink = document.createElement('a')
  targetLink.className = 'publisher-row-action'
  targetLink.href = `/publish/datasets/${encodeURIComponent(workflow.target_dataset_id)}`
  targetLink.textContent = workflow.target_dataset_id
  interceptNav(targetLink, navigate)
  targetCell.appendChild(targetLink)
  tr.appendChild(targetCell)

  const enabledCell = document.createElement('td')
  const badge = document.createElement('span')
  badge.className = `publisher-badge publisher-badge-status publisher-badge-${workflow.enabled ? 'published' : 'draft'}`
  badge.textContent = workflow.enabled
    ? t('publisher.workflows.enabled.on')
    : t('publisher.workflows.enabled.off')
  enabledCell.appendChild(badge)
  tr.appendChild(enabledCell)

  const lastRunCell = document.createElement('td')
  lastRunCell.className = 'publisher-cell-updated'
  lastRunCell.textContent = workflow.last_run_at
    ? formatDate(workflow.last_run_at)
    : t('publisher.workflows.lastRun.never')
  tr.appendChild(lastRunCell)

  const actionsCell = document.createElement('td')
  const editLink = document.createElement('a')
  editLink.href = `${detailPath}/edit`
  editLink.className = 'publisher-row-action'
  editLink.textContent = t('publisher.workflows.action.edit')
  interceptNav(editLink, navigate)
  actionsCell.appendChild(editLink)
  tr.appendChild(actionsCell)

  return tr
}

/** SPA-navigate on plain left clicks; keep modified clicks native
 *  so cmd-click → new tab works (the tours-list convention). */
function interceptNav(a: HTMLAnchorElement, navigate: (url: string) => void): void {
  a.addEventListener('click', e => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(a.getAttribute('href') ?? '/publish/workflows')
  })
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
