/**
 * `terraviz import-events` — ingest current events from an authoritative
 * feed (NASA EONET, the first connector) into the catalog
 * (`docs/CURRENT_EVENTS_PLAN.md` §9).
 *
 * Fetches the feed, maps each item to a `POST /api/v1/publish/events`
 * create body via the pure `lib/eonet.ts` mapper, and posts each. The
 * endpoint is idempotent on `(feed_id, external_id)` — a re-run refreshes
 * open events instead of duplicating them — and runs the matcher on
 * create, so the curator review queue arrives pre-populated. Every
 * ingested event lands `proposed`; nothing reaches end-users until a
 * curator approves it.
 *
 * Typically run on a schedule (see `.github/workflows/import-events.yml`)
 * with a Cloudflare Access service token. `--file` reads a local EONET
 * JSON instead of fetching (offline runs / tests); `--dry-run` prints the
 * plan without writing.
 */

import { readFileSync } from 'node:fs'
import type { CommandContext } from './commands'
import { getString, getBool, getNumber } from './lib/args'
import { mapEonetFeed, EONET_DEFAULT_URL, type EonetFeed, type EventCreateBody } from './lib/eonet'

/** Modest pacing between create round-trips. The endpoint runs the
 *  matcher per event; pacing keeps a batch gentle on the backend. */
const DEFAULT_PACE_MS = 150

interface CreateEnvelope {
  created: boolean
  event: { id: string; title: string } | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function loadFeed(ctx: CommandContext, file: string | undefined, sourceUrl: string): Promise<EonetFeed> {
  if (file) {
    const reader = ctx.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
    return JSON.parse(reader(file)) as EonetFeed
  }
  const res = await fetch(sourceUrl)
  if (!res.ok) throw new Error(`feed fetch failed (${res.status}) for ${sourceUrl}`)
  return (await res.json()) as EonetFeed
}

export async function runImportEvents(ctx: CommandContext): Promise<number> {
  const file = getString(ctx.args.options, 'file')
  const sourceUrl = getString(ctx.args.options, 'source-url') ?? EONET_DEFAULT_URL
  const dryRun = getBool(ctx.args.options, 'dry-run')
  const paceMs = getNumber(ctx.args.options, 'pace-ms') ?? DEFAULT_PACE_MS

  let feed: EonetFeed
  try {
    feed = await loadFeed(ctx, file, sourceUrl)
  } catch (e) {
    ctx.stderr.write(`Could not load the EONET feed: ${e instanceof Error ? e.message : String(e)}\n`)
    return 2
  }

  const bodies: EventCreateBody[] = mapEonetFeed(feed)
  const total = Array.isArray(feed.events) ? feed.events.length : 0
  ctx.stdout.write(
    `EONET ingest plan:\n` +
      `  feed events:           ${total}\n` +
      `  mappable events:       ${bodies.length}\n` +
      `  skipped (unmappable):  ${total - bodies.length}\n`,
  )

  if (dryRun) {
    ctx.stdout.write('\nDry run — no events will be ingested. Re-run without --dry-run to apply.\n')
    return 0
  }

  let created = 0
  let updated = 0
  let failed = 0
  for (const body of bodies) {
    const result = await ctx.client.createEvent<CreateEnvelope>(body as unknown as Record<string, unknown>)
    if (!result.ok) {
      failed++
      ctx.stderr.write(
        `[${body.externalId}] ingest failed (${result.status}): ${result.error}` +
          (result.message ? ` — ${result.message}` : '') +
          '\n',
      )
      if (result.errors?.length) {
        for (const e of result.errors) ctx.stderr.write(`    ${e.field}: ${e.code} — ${e.message}\n`)
      }
      continue
    }
    if (result.body.created) created++
    else updated++
    if (paceMs > 0) await sleep(paceMs)
  }

  ctx.stdout.write(
    `\nIngest complete:\n` +
      `  created:               ${created}\n` +
      `  refreshed (existing):  ${updated}\n` +
      `  failed:                ${failed}\n`,
  )
  return failed > 0 ? 1 : 0
}
