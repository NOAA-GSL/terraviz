/**
 * Typed API wrappers for the Zyra workflow surface (Phase Z2 of
 * `docs/ZYRA_INTEGRATION_PLAN.md`) — thin layer over
 * `publisherGet` / `publisherSend`, mirroring how the tour pages
 * wrap their endpoints. Wire shapes match
 * `functions/api/v1/_lib/workflow-store.ts:toPublicWorkflow` and
 * the run rows.
 */

import {
  publisherGet,
  publisherSend,
  type PublisherApiResult,
  type PublisherSendResult,
} from './api'

export interface PublisherWorkflow {
  id: string
  publisher_id: string
  name: string
  description: string | null
  pipeline_json: string
  metadata_template: string
  schedule: string
  enabled: boolean
  target_dataset_id: string
  update_mode: string
  last_run_at: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface PublisherWorkflowRun {
  id: string
  workflow_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  trigger: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  gha_run_id: string | null
  upload_id: string | null
  error_summary: string | null
}

export interface WorkflowInputBody {
  name?: string
  description?: string | null
  pipeline_json?: string
  metadata_template?: string
  schedule?: string
  enabled?: boolean
  target_dataset_id?: string
}

const BASE = '/api/v1/publish/workflows'

export function listWorkflows(): Promise<PublisherApiResult<{ workflows: PublisherWorkflow[] }>> {
  return publisherGet(`${BASE}?limit=100`)
}

export function getWorkflow(id: string): Promise<PublisherApiResult<{ workflow: PublisherWorkflow }>> {
  return publisherGet(`${BASE}/${encodeURIComponent(id)}`)
}

export function listWorkflowRuns(
  id: string,
): Promise<PublisherApiResult<{ runs: PublisherWorkflowRun[] }>> {
  return publisherGet(`${BASE}/${encodeURIComponent(id)}/runs?limit=50`)
}

export function createWorkflow(
  body: WorkflowInputBody,
): Promise<PublisherSendResult<{ workflow: PublisherWorkflow }>> {
  return publisherSend(BASE, body)
}

export function patchWorkflow(
  id: string,
  body: WorkflowInputBody,
): Promise<PublisherSendResult<{ workflow: PublisherWorkflow }>> {
  return publisherSend(`${BASE}/${encodeURIComponent(id)}`, body, { method: 'PATCH' })
}

export function validateWorkflow(
  id: string,
  body: WorkflowInputBody,
): Promise<PublisherSendResult<{ ok: boolean; errors?: Array<{ field: string; code: string; message: string }> }>> {
  return publisherSend(`${BASE}/${encodeURIComponent(id)}/validate`, body)
}

export function runWorkflow(
  id: string,
): Promise<PublisherSendResult<{ run: PublisherWorkflowRun; mocked: boolean }>> {
  return publisherSend(`${BASE}/${encodeURIComponent(id)}/run`, {})
}
