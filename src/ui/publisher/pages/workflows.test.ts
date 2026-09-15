// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import { renderWorkflowsPage } from './workflows'
import type { PublisherWorkflow } from '../workflows-api'
import { until } from '../../../test-utils'

function workflow(overrides: Partial<PublisherWorkflow> = {}): PublisherWorkflow {
  return {
    id: '01HX0000000000000000000000',
    publisher_id: '01HX0000000000000000000001',
    name: 'Weekly drought',
    description: null,
    pipeline_json: '{"stages":[]}',
    metadata_template: '{}',
    schedule: 'P1W',
    enabled: true,
    target_dataset_id: '01HX0000000000000000000002',
    update_mode: 'overwrite',
    last_run_at: '2026-06-09T12:00:00.000Z',
    next_run_at: '2026-06-16T12:00:00.000Z',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-09T12:00:00.000Z',
    ...overrides,
  }
}

describe('renderWorkflowsPage', () => {
  let mount: HTMLElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.replaceChildren(mount)
  })

  it('renders a row per workflow with enabled badge and links', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({
        ok: true,
        data: { workflows: [workflow(), workflow({ id: '01HX0000000000000000000003', enabled: false })] },
      }),
      navigate: () => {},
    })
    const rows = mount.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    const badges = mount.querySelectorAll('.publisher-badge')
    expect(badges[0].className).toContain('publisher-badge-published')
    expect(badges[1].className).toContain('publisher-badge-draft')
    const detailLink = mount.querySelector<HTMLAnchorElement>('a.publisher-row-link')
    expect(detailLink?.getAttribute('href')).toBe('/publish/workflows/01HX0000000000000000000000')
  })

  it('hydrates the last-run status badge and runs a workflow on demand', async () => {
    const runCalls: string[] = []
    const failedRun = {
      id: 'r1',
      workflow_id: 'wf1',
      status: 'failed' as const,
      trigger: 'manual',
      created_at: '2026-06-09T12:00:00.000Z',
      started_at: null,
      finished_at: null,
      gha_run_id: null,
      upload_id: null,
      error_summary: 'exit 1',
    }
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [workflow({ id: 'wf1' })] } }),
      runsFn: async () => ({ ok: true, data: { runs: [failedRun] } }),
      runFn: async (id: string) => {
        runCalls.push(id)
        return { ok: true, data: { run: failedRun, mocked: true } }
      },
      navigate: () => {},
    })
    // Status badge hydrated into the last-run cell.
    await new Promise(r => setTimeout(r, 0))
    const badge = mount.querySelector('.publisher-workflows-runstatus')
    expect(badge?.textContent).toBe('Failed')

    // Run now posts to the run endpoint and reports queued.
    const runBtn = mount.querySelector<HTMLButtonElement>('.publisher-workflows-run')!
    runBtn.click()
    await new Promise(r => setTimeout(r, 0))
    expect(runCalls).toEqual(['wf1'])
    expect(mount.querySelector('.publisher-row-action-status')?.textContent).toBe('Queued ✓')
  })

  it('survives a runs response whose body is not the shape it expects', async () => {
    // The bug this replaces: the capture fixtures served the workflows
    // *list* payload to the per-workflow runs probe (the runs URL has
    // the list URL as a substring), so `data.runs` was undefined and
    // `for...of` threw. The call is floated, so that surfaced as an
    // uncaught page error rather than a missing badge — a last-run badge
    // is decoration and must not be able to take the page down.
    //
    // The rejection is the *only* thing that separates guarded from
    // unguarded here: both render the same table and both probe every
    // workflow, because the map callbacks all reach their `await` before
    // any of them throws. So the assertion has to observe it directly.
    const rejections: unknown[] = []
    const onReject = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onReject)
    const probed: string[] = []
    try {
      await renderWorkflowsPage(mount, {
        listFn: async () => ({ ok: true, data: { workflows: [workflow({ id: 'wf1' })] } }),
        // A well-formed 200 carrying the wrong body.
        runsFn: async (id: string) => {
          probed.push(id)
          return { ok: true, data: { workflows: [] } } as never
        },
        navigate: () => {},
      })
      // Anchor on the probe firing, not on the DOM: `buildShell` creates
      // the last-run cell *before* the hydration is floated, so waiting
      // for that cell is already true on arrival and proves nothing —
      // which is exactly how the first version of this test passed with
      // the guard removed.
      await until(() => probed.length === 1, 'the per-workflow run probe')
      // Then let the continuation after that await run, and Node deliver
      // any rejection it produced.
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(rejections).toEqual([])
      // Degraded, not broken: the row is there, just with no badge.
      expect(mount.querySelector('table')).not.toBeNull()
      expect(mount.querySelector('.publisher-workflows-runstatus')).toBeNull()
    } finally {
      process.off('unhandledRejection', onReject)
    }
  })

  it('renders the empty state when no workflows exist', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [] } }),
      navigate: () => {},
    })
    expect(mount.querySelector('.publisher-empty')).not.toBeNull()
    expect(mount.querySelector('table')).toBeNull()
  })

  it('renders the error shell on server failures', async () => {
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: false, kind: 'server', status: 500 }),
      navigate: () => {},
    })
    expect(mount.querySelector('.publisher-empty-message')).not.toBeNull()
    expect(mount.querySelector('table')).toBeNull()
  })

  it('SPA-navigates on plain clicks of the New workflow link', async () => {
    const visited: string[] = []
    await renderWorkflowsPage(mount, {
      listFn: async () => ({ ok: true, data: { workflows: [] } }),
      navigate: url => visited.push(url),
    })
    const newLink = mount.querySelector<HTMLAnchorElement>('a.publisher-workflows-new')
    newLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(visited).toEqual(['/publish/workflows/new'])
  })
})
