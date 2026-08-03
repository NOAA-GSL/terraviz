---
name: add-analytics-event
description: Add a new telemetry event to the analytics pipeline, or add a field to an existing one. Walks the nine-step contributor checklist in order — schema, tier, emit, throttle, sanitize, docs, privacy policy, tests, Grafana panel — and surfaces the position-stability rule that silently breaks dashboards. Use when adding, changing, or removing anything in the TelemetryEvent union, any emit() call site, or grafana/dashboards/**.
---

# Add an analytics event

Adding telemetry here touches seven files across four directories, and
two of the failure modes are silent: a mis-tiered event ships to every
user who did not opt out, and a badly-ordered field breaks every
dashboard query for its event type without a type error or a failing
test.

`docs/ANALYTICS_CONTRIBUTING.md` is the authoritative process. Read it —
this skill sequences it and flags the traps, it does not replace it.

## Step 0 — decide the tier before writing anything

This is the highest-stakes and least reversible decision. Work the table
in §Choosing a tier. The short version: if the event captures anything
the user typed, said, or chose; per-message chat detail; dwell duration;
per-frame or per-gesture data; a sanitized stack; or a value
distribution that itself reveals content — **Tier B**.

When genuinely unsure, choose Tier B. Promoting B→A later is an ordinary
schema decision. Shipping a sensitive event as Tier A means it already
leaked from every user who did not opt out, and that cannot be undone.

Tier B is one edit: add the `event_type` to `TIER_B_EVENT_TYPES` in
`src/types/index.ts`. `src/analytics/emitter.ts:tierGate()` reads it as a
Set and short-circuits before queueing.

## The trap: position stability

Read the `toDataPoint` comment in `functions/api/ingest.ts` before
touching an existing event's fields.

Analytics Engine storage is positional. `blob1..blob4` are server-stamped
(`event_type`, `environment`, `country`, `internal`). **Everything after
that is the event's own string and number fields in alphabetical order**
— strings to blobs, numbers to doubles, booleans to blobs as
`'true'`/`'false'`.

Two consequences people get wrong:

1. **Adding a field that sorts early shifts every field after it.** Add
   `duration_ms` to an event that already has `layer_id` and every
   dashboard query pinned to the old positions silently reads the wrong
   column. Check `docs/ANALYTICS_QUERIES.md` for the event's current
   layout and update it in the same change.
2. **Optional fields are dangerous.** Every event of a given
   `event_type` must contribute the same key set, or a missing field
   shifts positions per-datapoint. Declare fields required and emit
   `''` / `0` sentinels at the call site when a value is absent — which
   in practice looks like `layer_id: ctx.getDatasetId() ?? ''`
   (`src/services/vrSession.ts:630`), never an optional field.
   `SessionStartEvent.resumed` is the one tolerated optional field, and
   only because it sorts after `platform`.

If a change reshuffles positions, that is a schema-version bump, not a
routine addition.

## The nine steps

Follow §TL;DR contributor checklist in order. Notes where the repo has a
specific expectation:

1. **Interface** in `src/types/index.ts`, extending `TelemetryEventBase`,
   with a string-literal `event_type`. Append to the `TelemetryEvent`
   union — the union is what makes type-checking exhaustive.
   Field names lowercase snake_case; no object or array fields (ingest
   validation rejects them — flatten or hash instead).
2. **Tier** — step 0 above.
3. **Emit** — `import { emit } from '../analytics'`. Only ever from the
   barrel; never reach into the queue or batch internals.
4. **Throttle** if it can fire faster than ~30/min per user. Export the
   cap so dashboards know the ceiling; the naming convention is
   `<SUBJECT>_MAX_PER_MINUTE` — `CAMERA_SETTLED_MAX_PER_MINUTE`,
   `VR_INTERACTION_MAX_PER_MINUTE` — not a bare `MAX_PER_MINUTE`. If the
   throttle is per-bucket, the bucket key must be bounded — an enum, not
   user-supplied text, or the map grows without limit.
5. **Sanitize** — free text through `hashQuery()` (`src/analytics/hash.ts`);
   error messages and stacks through `sanitizeMessage()`
   (`src/analytics/errorCapture.ts`), stacks only in Tier B
   `error_detail`; lat/lon rounded to 3 decimals.
6. **Docs** — a catalog row in `docs/ANALYTICS.md` naming the call site,
   and the positional layout in `docs/ANALYTICS_QUERIES.md`.
7. **Privacy policy** — update `docs/PRIVACY.md` if this captures a
   category of signal not already disclosed, then regenerate with
   `npm run build:privacy-page`. `npm run check:privacy-page` fails CI on
   drift, and the generated `public/privacy.html` is write-guarded.
8. **Tests** alongside the call site: happy path, tier gating (Essential
   drops Tier B, Off drops everything), idempotency under repeat calls,
   and throttle behaviour if you added one.
9. **Grafana panel** — `product-health.json` for Tier A,
   `research.json` for Tier B. Note these dashboards have structural
   tests (`grafana/dashboards/*.test.ts`) that pin blob positions; if
   your change moves positions, those tests are where it surfaces.

## Reference implementations

| Need | Read |
|---|---|
| Global throttle on one event type | `src/analytics/camera.ts` |
| Per-bucket throttle | `src/services/vrInteraction.ts` |
| Rolling-window sampling | `src/analytics/perfSampler.ts` |
| Hashing free text correctly | `src/ui/browseUI.ts` (`browse_search`) |
| Sentinel instead of optional field | `src/services/vrSession.ts:630` |

## Escalate instead of shipping

Stop and open a discussion first if the change introduces a new
persistent identifier, a field capturing content the user typed or spoke
(**even hashed**), a new ingest endpoint or server stamp, a change to
what `internal` means, or a change to the kill switch, rate limits, or
CORS allowlist. See §When to escalate.

## Finish by reviewing

Run the `analytics-reviewer` subagent on the diff before opening the PR.
It applies the full reviewer checklist independently and reports
anything it cannot positively confirm — which is the point, since the
author is the worst-placed person to notice an omission.
