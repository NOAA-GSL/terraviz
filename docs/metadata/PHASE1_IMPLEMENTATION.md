# Phase 1: Pure STAC Projection

**Status:** Implemented; internal projection only, no public exposure
**Last reviewed:** 2026-09-17
**Revisit when:** Phase 1 contracts change or Phase 2 begins public exposure.

This implements the five numbered steps in [the metadata plan](README.md#phase-1-pure-projection), one DCO-signed commit per step.

| Step | Scope | Status |
|---|---|---|
| 1 | STAC core 1.1 TypeScript contracts | Implemented |
| 2 | Canonical D1 read model and separate node context | Implemented |
| 3 | Deterministic resource and mapping builders | Implemented |
| 4 | Local Terraviz extension schema and validation | Implemented |
| 5 | Table-driven eligibility and mapping coverage | Implemented |

No STAC routes, schema URLs, discovery links, native public fields, profile
publication storage/UI, or frame/revision history are introduced. Identity-only
root projection must work without private profile data or approval state.

The types deliberately cover the generated subset of STAC core 1.1, not an
arbitrary third-party STAC parser. Geometry is WGS 84 Polygon/MultiPolygon or
explicitly null; a null geometry cannot carry a fabricated bbox. An Item has
either one represented instant or a complete represented interval.

The read model reuses canonical public visibility filters and decoration reads,
and reads media intrinsics and renditions in 80-ID batches. Delivered and source
digests remain distinct. Node identity is read once, independently of datasets;
missing identity is explicit. Approved profile selections, custom values and
vocabulary references are optional caller-supplied inputs, never private draft
reads. The reader is not an atomic D1 snapshot: Phase 2 must provide a consistent
read session and authoritative access/freshness rechecks before exposing output.

`StacNodeContext` is an internal projection input, not a frozen public wire or
storage schema. Identity is the currently populated baseline. The optional
profile/extension/vocabulary shapes are provisional and may evolve when their
real storage and request adapters are implemented. Their privacy and validation
invariants remain mandatory. No production request composes this reader and
these builders yet; Phase 2 must add request-level composition tests, verified
approval provenance and freshness before enabling richer mappings. A fixture's
`policyCurrent` flag must never substitute for those checks.

Builders return structured exclusion/omission reasons. Asset resolution is an
injected trust boundary: the caller attests to an anonymous, stable URL for the
exact source reference, MIME type and (when supplied) delivered bytes/host.
No builder fetches assets or treats URL syntax as proof of reachability. HLS
bundle digests and source-upload digests are not emitted as file checksums.
The reader joins workflow ownership; sequences and recurring outputs remain
withheld without the immutable identities deferred to Phase 3.

The `manifest` asset means the existing native playback endpoint
[`GET /api/v1/datasets/{id}/manifest`](../../functions/api/v1/datasets/%5Bid%5D/manifest.ts),
not a proposed STAC manifest route. The Phase 2 adapter must point it at that
deployed endpoint (or a verified equivalent) and test anonymous reachability
for every exported delivery scheme; the existing endpoint does not support
all peer references. Merely constructing an absolute URL proves neither route
existence nor successful resolution. If a required route cannot be supplied,
the resolver must fail and the product is withheld. STAC routes, their links
and extension-schema hosting must become available together before discovery
is advertised; emitting links first is not an allowed rollout sequence.

Expected resolver failures have explicit resource/asset/origin reasons, and
UTC normalization failures have temporal reasons. Unexpected policy or mapping
exceptions propagate for diagnosis instead of being relabeled as invalid URLs.
Zero-area bounds are rejected in readiness as `spatial_bounds_degenerate`;
the geometry builder retains an invariant assertion as a second line of defense.

Optional policy fixtures explicitly assert `policyCurrent`; that assertion is
not an authorization or cache implementation. Selected profile fields use the
Phase 0 two-actor review contract. Custom values require registration, matching
scope/owner, aggregate bounds, and a pinned local schema validator; unavailable
optional fields are omitted, essential or invalid fields withhold the resource.
Vocabulary projections retain owner and revision but exclude review evidence.

The [local schema bundle](schemas/README.md) documents each mapping and its
scope. Tests validate core Catalog/Collection/Item output and every declared
extension against pinned offline schema bytes. UTC normalization preserves
arbitrary fractional-second precision. Schema publication remains Phase 2.

The table-driven tests cover public visibility, classification, geometry and
time eligibility, SPDX/LicenseRef handling, resolved image/MP4/HLS and opaque
R2/Stream/Vimeo/peer references, renditions, data-luma fallback, mirror origins
and hosting, deterministic IDs/order, selected-field withdrawal, namespace and
scope failures, optional versus essential omission, aggregate limits, pinned
schema execution, and vocabulary ownership. Native probing annotations and
frame enumeration remain native-only: this phase does not invent frame Items
or promote unvalidated legacy probing metadata into measurement claims.

Validation: the Phase 1 slice and `npm run type-check` pass. The full Windows
suite reported 8460 passing, 7 failing and 3 skipped tests: five known path
failures, an unrelated privacy-page drift check, and a timeline timeout that
passed on isolated rerun. No unrelated files were changed to silence those
failures. PySTAC validation has not been run; official JSON Schema validation
is offline and automated. Public route traversal/reachability, authenticated
policy provenance, cache invalidation, and publication notices remain Phase 2
gates, not claims made by these pure builders.