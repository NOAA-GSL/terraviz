/**
 * Metadata-sidecar rendering for the Zyra runner (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §Metadata sidecar).
 *
 * A workflow row carries a `metadata_template` — a JSON object
 * whose string values may reference `{{run_date}}`, `{{run_id}}`,
 * `{{data_start}}`, `{{data_end}}`. The runner resolves the
 * variables from the run context (+ the pipeline's
 * `frames-meta.json` when present) and interpolates; the result is
 * the dataset-PATCH body. A field referencing a variable that
 * could not be resolved is dropped with a warning rather than
 * failing the run — a missing frames-meta shouldn't kill an
 * otherwise-good publish.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g

export interface RunVars {
  run_date: string
  run_id: string
  data_start: string | null
  data_end: string | null
}

export function buildRunVars(options: {
  runId: string
  now?: Date
  framesMeta?: unknown
}): RunVars {
  const now = options.now ?? new Date()
  const range = options.framesMeta !== undefined ? readFramesMetaRange(options.framesMeta) : null
  return {
    run_date: now.toISOString().slice(0, 10),
    run_id: options.runId,
    data_start: range?.dataStart ?? null,
    data_end: range?.dataEnd ?? null,
  }
}

/**
 * Tolerant reader for Zyra's `frames-meta.json` (the `transform
 * metadata` stage output). Z0-pending: the shape below is inferred
 * from zyra-scheduler's pipeline; swap the fixture in
 * `workflow-sidecar.test.ts` for a real spike artifact and adjust.
 * Recognised shapes:
 *   - `{ start_datetime, end_datetime }` (top-level range)
 *   - `{ frames: [{ datetime | timestamp }, ...] }` (per-frame;
 *     range is first→last)
 * Anything else → null (the template's data_* fields get dropped).
 */
export function readFramesMetaRange(
  meta: unknown,
): { dataStart: string; dataEnd: string } | null {
  if (typeof meta !== 'object' || meta === null) return null
  const m = meta as Record<string, unknown>
  if (typeof m.start_datetime === 'string' && typeof m.end_datetime === 'string') {
    return { dataStart: m.start_datetime, dataEnd: m.end_datetime }
  }
  if (Array.isArray(m.frames) && m.frames.length > 0) {
    const stamp = (f: unknown): string | null => {
      if (typeof f !== 'object' || f === null) return null
      const r = f as Record<string, unknown>
      if (typeof r.datetime === 'string') return r.datetime
      if (typeof r.timestamp === 'string') return r.timestamp
      return null
    }
    const first = stamp(m.frames[0])
    const last = stamp(m.frames[m.frames.length - 1])
    if (first && last) return { dataStart: first, dataEnd: last }
  }
  return null
}

export interface SidecarResult {
  /** The dataset-PATCH body. */
  fields: Record<string, unknown>
  /** Fields dropped because a referenced variable was unresolved. */
  warnings: string[]
}

export function renderSidecar(
  template: Record<string, unknown>,
  vars: RunVars,
): SidecarResult {
  const fields: Record<string, unknown> = {}
  const warnings: string[] = []
  const lookup = vars as unknown as Record<string, string | null>

  const renderString = (s: string): string | null => {
    let unresolved = false
    const rendered = s.replace(PLACEHOLDER_RE, (_, name: string) => {
      const value = lookup[name]
      if (value == null) {
        unresolved = true
        return ''
      }
      return value
    })
    return unresolved ? null : rendered
  }

  for (const [key, value] of Object.entries(template)) {
    if (typeof value === 'string') {
      const rendered = renderString(value)
      if (rendered === null) {
        warnings.push(`dropped "${key}" — an unresolved placeholder (frames-meta missing?)`)
      } else {
        fields[key] = rendered
      }
    } else if (Array.isArray(value)) {
      const rendered = value.map(v => (typeof v === 'string' ? renderString(v) : null))
      if (rendered.some(v => v === null)) {
        warnings.push(`dropped "${key}" — an unresolved placeholder in a list entry`)
      } else {
        fields[key] = rendered
      }
    } else {
      fields[key] = value
    }
  }
  return { fields, warnings }
}

/**
 * Strip anything secret-shaped from a failure message before it
 * leaves the runner: long high-entropy tokens, obvious credential
 * assignments, and bearer headers. Second line of defence is the
 * server-side truncation in `workflow-validators.ts`.
 */
export function sanitizeErrorSummary(message: string, maxLength = 500): string {
  return message
    .replace(/(authorization|cf-access-client-secret|token|secret|password|key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
