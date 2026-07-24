/**
 * Placeholder support for Zyra workflow pipeline args (the follow-up
 * to array args — `docs/ZYRA_INTEGRATION_PLAN.md` §Pipeline arg
 * placeholders).
 *
 * Model-output sources embed the forecast cycle in their paths
 * (`gefs.20260724/00/...`), so a static pipeline can only ever fetch
 * one frozen cycle. String arg values may therefore reference:
 *
 *   - `{{run_date}}`  — the run's UTC date, `YYYY-MM-DD` (same value
 *     the metadata sidecar interpolates)
 *   - `{{run_id}}`    — the workflow_runs ULID
 *   - `{{cycle_date:INTERVAL:LAG}}` — `YYYYMMDD` of the most recent
 *     model cycle, where cycles start every INTERVAL and become
 *     available LAG after their nominal time (both ISO-8601
 *     durations): cycle = floor((now − LAG) / INTERVAL) · INTERVAL,
 *     anchored to the Unix epoch (midnight-aligned for divisors of
 *     24 h)
 *   - `{{cycle_hour:INTERVAL:LAG}}` — zero-padded `HH` of that same
 *     cycle (INTERVAL and LAG must match the `cycle_date` reference
 *     in the same pipeline for the pair to describe one cycle)
 *
 * Shared by the save/dispatch-time validator (`functions/`) and the
 * runner (`cli/`), which interpolates just before writing
 * `pipeline.json`. Unlike the metadata sidecar's drop-with-warning
 * behavior, an unresolved or malformed pipeline placeholder is a
 * hard error: a URL with a missing date fetches garbage, and the
 * run must fail loudly instead.
 */

export const PIPELINE_ARG_VARIABLES = ['run_date', 'run_id', 'cycle_date', 'cycle_hour'] as const

const CYCLE_VARIABLES = new Set(['cycle_date', 'cycle_hour'])

/** Matches `{{name}}` and `{{name:P1:P2}}`; loose on the inside so
 *  malformed contents surface as validation errors, not silent
 *  literals. */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g

const BODY_RE = /^\s*([a-z_]+)(?::([A-Za-z0-9.]+):([A-Za-z0-9.]+))?\s*$/

/**
 * Minimal ISO-8601 duration parser (`PnW`, `PnD`, `PTnH`, `PTnM`,
 * `PTnS`, and combinations). Returns seconds, or null when the
 * string is not a valid duration. Kept dependency-free because it
 * runs in both the Pages functions and the node runner.
 */
export function isoDurationSeconds(duration: string): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (!m) return null
  const [, w, d, h, min, s] = m
  if (!w && !d && !h && !min && !s) return null
  return (
    (Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 +
    Number(h ?? 0) * 3_600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0)
  )
}

export interface PipelinePlaceholder {
  name: string
  intervalSeconds?: number
  lagSeconds?: number
}

/**
 * Parse one placeholder body (the text between the braces). Returns
 * the parsed placeholder or an error message.
 */
export function parsePlaceholder(body: string): PipelinePlaceholder | string {
  const m = BODY_RE.exec(body)
  if (!m) return `Malformed placeholder "{{${body}}}".`
  const [, name, interval, lag] = m
  if (!(PIPELINE_ARG_VARIABLES as readonly string[]).includes(name)) {
    return `Unknown placeholder "${name}" — allowed: ${PIPELINE_ARG_VARIABLES.join(', ')}.`
  }
  if (CYCLE_VARIABLES.has(name)) {
    if (!interval || !lag) {
      return `"${name}" requires interval and lag, e.g. {{${name}:PT6H:PT5H}}.`
    }
    const intervalSeconds = isoDurationSeconds(interval)
    const lagSeconds = isoDurationSeconds(lag)
    if (intervalSeconds == null || intervalSeconds <= 0) {
      return `"${name}": interval "${interval}" is not a positive ISO-8601 duration.`
    }
    if (lagSeconds == null || lagSeconds < 0) {
      return `"${name}": lag "${lag}" is not an ISO-8601 duration.`
    }
    return { name, intervalSeconds, lagSeconds }
  }
  if (interval || lag) {
    return `"${name}" takes no parameters.`
  }
  return { name }
}

/**
 * Validate every placeholder in one arg string. Returns error
 * messages (empty when the string is placeholder-free or all
 * placeholders are well-formed).
 */
export function validateArgPlaceholders(value: string): string[] {
  const errors: string[] = []
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const parsed = parsePlaceholder(match[1])
    if (typeof parsed === 'string') errors.push(parsed)
  }
  return errors
}

export interface PipelineArgContext {
  now: Date
  runId: string
}

/** The nominal start of the most recent available cycle. */
export function cycleStart(now: Date, intervalSeconds: number, lagSeconds: number): Date {
  const shifted = Math.floor(now.getTime() / 1000) - lagSeconds
  const floored = Math.floor(shifted / intervalSeconds) * intervalSeconds
  return new Date(floored * 1000)
}

/**
 * Interpolate every placeholder in one arg string. Throws on a
 * malformed or unknown placeholder — save/dispatch validation should
 * have caught it, so reaching this is a hard bug, and rendering a
 * literal `{{...}}` into a URL must never proceed silently.
 */
export function renderArgPlaceholders(value: string, ctx: PipelineArgContext): string {
  return value.replace(PLACEHOLDER_RE, (_, body: string) => {
    const parsed = parsePlaceholder(body)
    if (typeof parsed === 'string') throw new Error(parsed)
    switch (parsed.name) {
      case 'run_date':
        return ctx.now.toISOString().slice(0, 10)
      case 'run_id':
        return ctx.runId
      case 'cycle_date': {
        const c = cycleStart(ctx.now, parsed.intervalSeconds!, parsed.lagSeconds!)
        return c.toISOString().slice(0, 10).replace(/-/g, '')
      }
      case 'cycle_hour': {
        const c = cycleStart(ctx.now, parsed.intervalSeconds!, parsed.lagSeconds!)
        return c.toISOString().slice(11, 13)
      }
      default:
        throw new Error(`Unhandled placeholder "${parsed.name}".`)
    }
  })
}

/**
 * Render a whole pipeline document: walks `stages[].args`,
 * interpolating string values (including strings inside array args).
 * Non-string values pass through untouched. Returns the rendered
 * JSON string, or throws with a message naming the offending stage.
 */
export function renderPipelineJson(pipelineJson: string, ctx: PipelineArgContext): string {
  const doc = JSON.parse(pipelineJson) as { stages?: unknown }
  if (!Array.isArray(doc.stages)) return pipelineJson
  doc.stages.forEach((stage, i) => {
    if (typeof stage !== 'object' || stage === null) return
    const args = (stage as { args?: unknown }).args
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      try {
        if (typeof value === 'string') {
          ;(args as Record<string, unknown>)[key] = renderArgPlaceholders(value, ctx)
        } else if (Array.isArray(value)) {
          ;(args as Record<string, unknown>)[key] = value.map(v =>
            typeof v === 'string' ? renderArgPlaceholders(v, ctx) : v,
          )
        }
      } catch (e) {
        throw new Error(`stages[${i}].args.${key}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  })
  return JSON.stringify(doc)
}
