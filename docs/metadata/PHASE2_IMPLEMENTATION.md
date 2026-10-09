# Phase 2: Browsable Core Resources

**Status:** Implemented; deployment opt-in required
**Last reviewed:** 2026-09-29
**Revisit when:** Public profile snapshots, custom registry storage or immutable history ships.

| Step | Implementation |
|---|---|
| 1 | Opt-in core routes, independent content-addressed KV/ETags, public schema and notices |
| 2 | Atomic primary-backed public read, strict readiness and bounded asset verification |
| 3 | Authenticated no-store operator report including excluded non-public rows |
| 4 | Persisted-row route/schema, pagination, media and cache invalidation regressions |
| 5 | Offline CI traversal tests and opt-in scheduled live reachability audit |

## Rollout

1. Apply migrations through 0054. Keep `STAC_ENABLED` unset while deploying.
2. Review, replace or clear `node_identity.description` using the
   [existing-node instructions](../SELF_HOSTING.md#91-existing-nodes-review-descriptions-before-stac-publication).
   Enabling this release makes that description public. No per-profile approval
   is necessary, and no private mission/about/audit fields are read.
3. Deploy and verify `https://terraviz.zyra-project.org/schema/stac/terraviz/v1.0.0/schema.json`
   against the reviewed local schema. The versioned schema route is independent
   of the opt-in. A fork must retain the upstream schema identity and wait for
   that URI to be live; do not silently rewrite its meaning or URI.
4. Set `STAC_ENABLED=true` only after these prerequisites. HTTP `Link` discovery
   on the well-known response is enabled together with the resource routes.
   The well-known JSON and native protocol schemas remain unchanged.
   Discovery retains its five-minute cache and ten-minute stale-while-revalidate
   window, including on conditional responses. An opt-in or base-URL change may
   therefore take that window to appear in cached discovery; the STAC routes
   themselves check the flag on every request.
   Set `STAC_ASSET_ORIGINS` to a comma-separated list of trusted exact HTTPS
   origins for direct assets, license text and branding. The configured public
   R2 origin is also trusted. Only name public hosts you control or explicitly
   trust; this is an outbound-network allowlist, not a client-supplied filter.
5. Verify the root, traverse its links and audit asset reachability before
   announcing the surface to external consumers. Unset the flag to disable it.

## Routes

All paths are under `/api/v1/stac`: the root Catalog, `/collections`,
`/collections/:id`, `/collections/:id/items`,
`/collections/:id/items/:itemId`, `/items`, and `/items/:id`.
The standalone Item routes are necessary for truthful unknown-geometry Items.
Lists accept `limit` (1-100, default 50) and `cursor` (last emitted ID).
Malformed or unknown query parameters are rejected, including search filters;
no `/search`, `/conformance` or API conformance declarations are offered.

The root links to `/collections` with `rel="data"` and `/items` with
`rel="items"`. Each Collection links to its own items listing. These are
deployed resource-list entry points, not an STAC API conformance declaration.
The existing static child/item links remain available; pagination does not
yet bound the root Catalog's size.

Canonical absolute URLs come from the stored node base URL, never the request
Host header. Collections/Catalogs use `application/json`; Items and
FeatureCollections use `application/geo+json`. Conditional GET supports weak
and comma-separated validators. Errors are `no-store`.

## Cache And Mapping

STAC uses `stac:publication:v1:<input-hash>` KV keys, separate from native
snapshots. Fresh D1 state is required on every request before any KV reuse;
HTTP responses require revalidation, never stale-while-revalidate. KV outages
are cache misses. Input hashing includes identity, all dataset inputs, public
branding, public R2 configuration, trusted asset origins and the operator-report
flag. Public and operator inputs cannot share a key even when their rows match;
the operator path still never reads or writes KV. Old keys expire after five minutes and
are unreachable after an input change, even if KV deletion is delayed. This
trades D1 reads for immediate access/branding invalidation; it does not claim
the native catalog's KV-only hot-path performance.

The public snapshot is one transactional D1 batch in a `first-primary` session,
including identity, all decorations/media, workflow ownership and public
branding. It uses the exact native public/published/not-hidden/not-retracted
predicate. A write committed before that batch is visible immediately; a write
concurrent with it is reflected on the next revalidation. This is snapshot
consistency, not an impossible promise to revoke bytes already in flight.

On a cache miss assets must pass anonymous HEAD with a real Content-Type.
Only explicit HTTPS origins are probed, with no redirects or cookies, a
three-second per-request timeout, a fifteen-second build deadline and a maximum
of 40 distinct URL probes per snapshot build. Count or build-deadline exhaustion
fails the entire public response with a no-store 503, including when only an
optional asset or logo exceeded the budget. No partial snapshot is cached.
The cache input version changes with this behavior so earlier partial snapshots
cannot be reused. The operator report remains available with a publication-level
budget reason. Individual unverifiable assets, including HEAD-unsupported
servers, are still withheld rather than advertised speculatively. Colour-table
references are verified alongside primary media and the other supporting assets.
References are resolved and deduplicated before probing. Up to 16 HEAD requests
run concurrently through the shared bounded pool; each job records its own
failure instead of stopping other jobs. Count overflow is known before the pool
starts. Only the first 40 distinct URLs are probed, preserving private-report
diagnostics for those candidates while the whole public snapshot is rejected.
The deadline remains a fail-closed backstop; queued jobs do not fetch after it
expires. Slow healthy origins no longer consume the deadline one asset at a time.
Verification is retained
with the five-minute snapshot; later external outages are caught by the audit
or the next rebuild, not treated as a permanent availability guarantee. Large
catalogs needing more probes require a separately reviewed persisted verification
worker; this release refuses public publication beyond its bounded request budget.

The initial resolver supports durable direct URLs and configured public R2
assets. Unsupported/unresolved delivery schemes are withheld rather than
replaced with a playback-manifest JSON URL mislabeled as media. The native
playback manifest is a separate metadata Asset. Origin links are not guessed.
Sequences and recurring outputs remain withheld until Phase 3 persists their
immutable identities. Richer profile/extension/vocabulary mappings stay
disabled until their storage, permissions and publication tests exist.

## Operator Report

`GET /api/v1/publish/stac-report` uses the existing Cloudflare Access publisher
middleware and additionally requires an active admin or service operator. It
works with public STAC disabled, so remediation can precede opt-in. The response
is versioned JSON: `schema_version`, `publication_enabled`, `publication_issues`, `totals` and sorted
`records` with immutable `id`, `included` and machine-readable `reasons`.
Non-public rows receive `not_public`; their assets are never probed. Scientific
readiness reasons are preserved. Unresolved primary assets also carry concrete
verification reasons such as `asset_origin_untrusted`, `asset_http_403`,
`asset_probe_failed` or `asset_probe_budget_exceeded`.
Prose-only license evidence without a resolved public text asset reports
`license_text_asset_pending`, not `license_asset_unresolved`. Publish the terms
at a trusted public HTTPS URL and set `license_url`; a URL that cannot be verified
still reports `license_asset_unresolved`. Prose is never sent to the HEAD prober.
`publication_issues` contains `asset_probe_budget_exceeded` when the public
snapshot cannot be completed, even if all primary assets passed and only an
optional asset or logo exceeded the budget. In that case the row-level totals
describe evaluated candidates, not a successfully published partial catalog.

This endpoint is always `private, no-store`, never reads or writes the public
KV snapshot, and does not return private titles, source URLs, draft prose or
review identities. It evaluates current state rather than claiming that every
excluded row can be automatically repaired.
Catalog-level failures log their diagnostic message server-side; public errors
remain the generic `stac_unavailable` envelope and do not expose those details.

## Regression Coverage

Route tests compose persisted valid ULIDs, migrated SQLite, the atomic D1
adapter, asset verification, builders and HTTP responses. They cover media
types, canonical absolute links, standalone resources, bounded pagination,
collection membership, unsupported API paths, weak/list/wildcard conditional
GET, node-description changes, logo replacement/removal, private draft
non-dependencies, dataset/decorations/renditions/delivery changes, deployment
R2 changes, visibility withdrawal with warm KV, and KV/D1 failure behavior.
Distinct primary URLs exercise the 40/41/60-probe boundaries; optional-asset
overflow and a deadline expiring on the final probe also reject publication.
Fake-clock checks cover six healthy 2.8-second assets and forty 400-millisecond
assets, enforcing the 16-request concurrency cap and URL deduplication. Individual
failures do not abort queued probes. Additional tests cover operator/public hash
separation, discovery caching on 200/304, private failure diagnostics and prose
versus URL license evidence.
The pinned official core and extension validator also validates actual HTTP
output, not only hand-built projection fixtures. Richer mapping invalidation
tests remain deferred together with those disabled mappings.

## Reachability Audit

Run `npm run audit:stac` with `STAC_AUDIT_ROOT` set to the enabled HTTPS root.
Set `STAC_AUDIT_ORIGINS` to comma-separated trusted asset, contextual-link and
schema origins. Only the root origin and `https://stac-extensions.github.io`
are included automatically. A fork using the upstream Terraviz schema must
explicitly include `https://terraviz.zyra-project.org`; the upstream site is not
implicitly trusted for assets, contextual links or schemas. No credentials are
read or forwarded. These variables
are operator configuration, never copied from an untrusted dataset.

The audit traverses same-root resource and pagination links, checks declared
media types and self links, fetches declared schemas and verifies their IDs,
compares the Terraviz schema with the reviewed local document, and performs
anonymous HEAD checks for Assets and supporting links. Redirects are failures,
not silently followed. Requests have a ten-second deadline; JSON is bounded to
2 MiB; traversal is capped at 1000 documents, 1000 assets and 32 schemas.
Exhausting a cap is a failed audit, not a successful truncated report. Output
is machine-readable JSON and any issue exits nonzero. This is a core-resource
health audit, not an STAC API conformance test or proof of scientific accuracy.

The normal CI Vitest suite runs `scripts/audit-stac.test.ts` against real local
route handlers and controlled failures, without network dependence. The
root-only traversal test discovers all listing shapes and follows real next
pages across 51 records, including failure when a next page returns 503. Its
shared image URL deliberately isolates pagination from the distinct-URL budget
tests above. The
`STAC Resource Audit` workflow also supports weekly/manual live runs. Configure
repository variables `STAC_AUDIT_ROOT` and `STAC_AUDIT_ORIGINS` only after
publication is enabled. Without a root it is explicitly skipped. Each run
retains its JSON report for 30 days; a failed audit is a failing Actions job.
No deployment flag, repository variable or production data is changed by this
implementation PR. The first live audit remains an operator rollout task.