# Phase 3: Atomic History

**Status:** Implemented; deployment and operator backfill pending
**Last reviewed:** 2026-10-02
**Revisit when:** Asset hosting/origin policy, Workers quotas, callback timeouts, or history retention/deletion policy changes.

One DCO-signed commit corresponds to each numbered step in the
[metadata plan](README.md#phase-3-atomic-history).

## Step 1: Frame Items

Migration 0055 adds publication snapshots and atomic Items. Both tables reject
updates. Dataset deletion cascades through them; they are not an independent
public archive after the parent dataset is removed.

Native publication captures frame sequences whose manifest, represented-time
evidence, positive cadence and extent are valid. Frame assets use the existing
content-addressed R2 keys. Publication persists IDs and timestamps rather than
deriving them during public reads. Identical repeated publication is idempotent;
changed scientific metadata or frame content creates a new snapshot. Frame keys
cover represented time/cadence, extent and its evidence, geographic orientation,
encoding/scale, asset refs/digests/format, frame manifest ref/count, and ordered
frame digests. Titles, abstracts, tags, rights and
other descriptive corrections do not mint a second set of frame Items.

Capture requires `STAC_HISTORY_CAPTURE=true`, independently of `STAC_ENABLED`.
It is off by default, so no capture preparation reads or asset probes run.
Capture reads one dataset and its decorations, never the entire catalog or old
Item history. A null prepare result for an already-published dataset performs
one bounded lookup of its latest publication kind/first Item ID. If history
exists, the skip is logged with readiness reasons (or `capture_disabled` / a
prerequisite fallback); datasets without history do not emit this warning.
The insert and native publication update share one D1 transaction. Conditional
inserts compare an explicit list of physical dataset columns (including the
metadata revision timestamp); a mismatch skips the snapshot rather than raising
a synthetic CHECK failure. Joined aliases cannot become SQL identifiers.
The transcode UPDATE retains its active-upload guard: a superseded callback
returns the existing 409 and writes no history. A concurrent metadata edit lets
native completion proceed without a stale snapshot. Missing/inconsistent
manifests, failed verification and capture reads are logged with their error
message and skip capture.
If the optional history transaction fails, its atomic rollback is followed by
the original native write without history. Native write failures still surface;
they are not reported as successful. Invalid or untimestamped sequences remain
native-only.

Before projecting history, the reader compares the latest saved publication's
asset and scientific identity with the current row, using the same fields as
capture keys. Revision comparisons include `data_ref`, content digest,
format and scientific fields; frame comparisons also include the manifest ref
and frame count. Manifest refs must identify immutable source sets. Descriptive
corrections do not make history stale. `source_digest` tracks the latest upload
attempt, not the published asset: stamping changes it and failure cleanup clears
it even while the old bundle remains published. It is therefore excluded from
both capture keys and freshness checks, but retained in the native write's
concurrency guard. A same-file stamp, abandonment and republish cannot create a
duplicate revision merely because that upload-attempt digest becomes null.
A changed identity without a matching
latest capture excludes that dataset's entire history and Collection, including
direct Item URLs (404), with `history_stale` plus the live row's normal readiness
reasons in the operator report. For example, a changed upload that resets
evidence reports `spatial_unknown` and `temporal_unknown` rather than hiding
those actionable causes. Other
datasets remain available. The check uses the fresh primary-backed read and is
a cache dependency, so a previously cached snapshot cannot hide the mismatch.
Missing manifests, failed HEADs, storage failures, concurrent edits, or disabling
capture can therefore leave an honest gap, never an old run advertised as current.
The report records zero included Items; its total is the declared current frame
count, or stored revision count plus the uncaptured current revision. These are
expected candidate counts, not proof that the new assets have passed verification.
Check the report's readiness reasons and establish evidence for the actual
published asset before explicitly republishing to capture the missing state.
Plain republish cannot restore unknown temporal/spatial evidence. A retry of an
already-completed transcode callback alone is idempotent and does not backfill
history. After a failed workflow run, rerun successfully **or restore the prior
represented times and other scientific metadata/evidence for the retained
bundle before republishing**. The runner applies new-run metadata before upload;
abandonment retains the old bundle but does not roll that metadata back. Merely
re-attesting the new run's times can freeze a mislabel as an immutable revision
of old bytes. Capture permits scientific corrections to the same bundle; this
PR adds no same-bundle conflict/override mechanism, so operators must verify the
asset-to-metadata relationship rather than infer it from the latest run's fields.
Then rerun the report and reachability audit.

The public projection reads snapshots with current parent visibility in its
primary-backed transaction. Private, restricted, hidden, draft and retracted
parents cannot expose historical Items, even with a warm cache. Saved Item title,
represented time, geometry and primary assets remain fixed. Collections use live
titles/descriptions/keywords/links; rights, licence, organization, developer and
citation corrections apply to both Collection and historical Item projections
immediately. Original snapshots remain unchanged in D1 for audit. Corrected
licensing must still pass readiness and asset validation before publication.
Collections combine the included Items' extents with conservative antimeridian
bounds, not the live row's uncaptured scientific changes. They do not implicitly
choose descriptive metadata from whichever Item happened to be last.

Only the latest frame publication is public (explicit capture-time order, with
ID as a deterministic tie-break); older sets remain in D1 for lineage/audit.
Older frame Item URLs return 404 once superseded. Workflow revisions remain
public and linked. This prevents duplicate public timestamps after scientific
recapture without claiming adjacent frames are versions of one another.
The operator report includes `items_included` and `items_total` for the current
public candidate set, so partial inclusion is visible; collection-only products
count as zero Items. Report aggregation is keyed by dataset ID.

Existing sequences are not silently backfilled. Republishing captures current
evidenced state, not historical states that the node never retained. Capture
verifies distinct immutable frame URLs with anonymous, no-redirect HEAD requests
(16 concurrent, 3 seconds per request, 30 seconds total, at most 10,000 distinct
frames). Every frame must pass with its declared image MIME type; otherwise no
snapshot is captured and native publication continues. The successful source
ref, public URL and MIME evidence is persisted in the snapshot, atomically with
its Items. Catalog reads reuse that evidence only for the exact content-addressed
ref, matching URL/type and current trusted-origin policy. Verified frames do not
consume the Phase 2 40-URL request budget. Non-frame and supporting assets still
use that budget and remain fail-closed; those assets are not independently
archived here. Legacy/unverified frames are withheld with
`frame_verification_required`, never silently sent through the request probe
budget. Hosting-policy changes require an explicit verification refresh strategy
before moving a node's immutable assets; stored evidence is not a trust bypass.

Apply migration 0055 before deploying these readers. STAC remains opt-in through
`STAC_ENABLED`; capture is separately opt-in. No production settings or data are
changed by this PR.

## Step 2: Workflow Revisions

Workflow-owned datasets capture a revision when explicit publication succeeds,
or when a verified transcode callback replaces an already published output.
Only public, non-hidden publications are captured. The history insert and the
guarded transcode update run in the same D1 transaction. Draft transcodes do not
publish history; their later explicit publication captures it.

**Known recurring-workflow limitation:** the runner applies sidecar evidence
before uploading, and a distinct-file stamp resets that evidence afterwards.
Completion can therefore succeed without capture, even with the flag enabled.
Re-attest evidence for the newly published bundle and explicitly republish; do
not assume callback success proves a saved revision exists. This pre-existing
ordering/trust-boundary issue is tracked separately in
[#475](https://github.com/zyra-project/terraviz/issues/475), not changed by this PR.
Callback capture works only when the completed row still has valid evidence.

Capture accepts upload-specific HLS bundle paths or content-addressed R2 assets
with matching content digests. Mutable external URLs stay excluded. The stored
snapshot fixes represented time, scientific metadata and the primary asset;
the live rights/attribution overlays above still apply. HLS receives
no invented whole-bundle checksum. Frame-producing workflows use the immutable
run bundle as their revision Item; non-workflow sequences use per-frame Items.

Run success alone is not publication: the runner can finish while transcoding
continues, and a no-data soft pass can succeed without an upload. Neither event
creates history. Both revisions and frame sets use asset plus scientific identity,
not the whole descriptive snapshot. Repeated publication of identical assets and
scientific fields reuses the saved identity; a title, abstract, keyword or rights
correction does not create a revision or predecessor/successor pair for the same
data. A new upload or changed scientific metadata creates a new revision.
New Item IDs have a kind prefix so even a hash beginning with `-` or `_` is a valid
persisted identifier. Previously stored IDs and snapshots are never rewritten.
No history is inferred from old workflow-run logs. Operators must retain the
upload-specific bundles and content-addressed assets for historical Items to
remain reachable. The existing reachability and count-budget checks still apply.

## Step 3: Revision Links

Workflow revisions of the same dataset expose `predecessor-version`,
`successor-version`, and `latest-version` links using their persisted capture
times, not represented scientific time. Equal or invalid capture timestamps
leave the chain unlinked rather than inventing an order. Frames are not versions
of their neighbors. Links target only Items included in the current public
projection; an unavailable immediate neighbor is not silently skipped.

These registered link relations do not claim the STAC Versioning extension.
Links are a live projection and can change as revisions arrive, while the saved
metadata and primary asset remain immutable. History is a cache dependency, so
new revisions update prior Items' ETags and links without changing their IDs.

## Step 4: Source-Lineage Backfill

Migration 0056 adds an immutable evidence record for each saved publication.
`GET /api/v1/publish/stac-lineage` inventories all publications, including those
with missing lineage, in 50-row pages. Follow `next_cursor` using `?cursor=`.
`POST` at the same path records the reviewed source set. Both methods require
an active admin or service publisher and always return `private, no-store`.
The endpoint works while public STAC is disabled so backfill can precede rollout.

The POST body has exactly these fields:

```json
{
	"publication_id": "revision-<saved-22-character-id>",
	"reviewed": true,
	"sources": [{
		"href": "https://data.example/inputs/model.nc",
		"content_digest": "sha256:<64-lowercase-hex>",
		"evidence_href": "https://data.example/evidence/run.json",
		"evidence_digest": "sha256:<64-lowercase-hex>"
	}]
}
```

Use the actual `publication_id` from the inventory, not an Item ID. For a frame
publication the evidence must describe the source set for the entire captured
sequence. Inspect retained source files and acquisition/execution records;
compute their digests and review their relationship to this precise saved
publication before submitting. A workflow template, successful run status,
rendered upload digest, or matching title alone does not establish the original
scientific source. Leave the record missing when evidence is unavailable.

Sources must use canonical public HTTPS URLs without credentials, query strings
or fragments; signed/private locators must not be submitted. The request is
limited to 64 KiB and 1-32 distinct sources. A first insert returns 201, an
identical retry (independent of source order) returns 200, and a changed source
set returns 409 without replacing evidence. Unknown publications return 404;
invalid input returns 400 and oversized input 413. The inventory includes the
reviewer's publisher ID and server timestamp. Dataset deletion cascades through
the history and lineage records.

`operator_attested` means a privileged curator supplied reviewed evidence, not
that the server fetched and scientifically verified it. No remote requests are
made, no source evidence enters public STAC, and **Processing remains disabled**
even after backfill. Enabling it requires separately reviewed processing facts,
extension registration/schema validation, public-source permissions, and tests;
source lineage is necessary but not sufficient. This PR provides the backfill
mechanism, not a claim that production records have already been reviewed.

## Rollout

Apply 0055 and 0056 before deploying. Retain historical source assets and bundles;
the tables alone do not preserve R2 objects. Exercise sequence publish, workflow
completion and retry, access withdrawal, revision traversal, and the lineage
inventory on a staging node. Backfill only evidenced sources. Run the existing
STAC inclusion report and reachability audit before enabling `STAC_ENABLED`.
Enable `STAC_HISTORY_CAPTURE=true` first to populate and verify history without
enabling public STAC. The request-time 40-URL cap no longer counts verified frame
assets; it remains a constraint for non-frame assets and workflow histories.
Immutable assets must be retained: persisted verification records a successful
capture, not a continuous availability guarantee. Run periodic reachability
audits, and withdraw affected parents if immutable objects are removed. No STAC
API, Processing, or Versioning extension conformance is advertised by this change.

### Capture Budget And Client Latency

Capture is synchronous inside publish and transcode completion. The 30-second
deadline bounds frame HEAD verification, not the entire HTTP request: manifest
reads, D1 work and response handling add time. The runner's
`postTranscodeComplete` in `cli/transcode-from-dispatch.ts` uses `fetch` without
an application-level abort timer, so it does not impose a shorter timeout.
That is not an end-to-end timeout guarantee: verify the runner, proxy/Access
path, browser publisher client and job timeout on staging with a slow capture
before enabling it. Keep the caller connected for at least 30 seconds plus
measured non-probe overhead. No production timeout or account plan was changed
or assumed verified by this PR.

The 10,000-distinct-frame code cap is **not** a supported deployment ceiling.
The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)
checked on 2026-10-01 list 50 external subrequests for Free and a configurable
10,000 default for Paid; internal-service limits and other requests also need
headroom. Confirm the actual deployed plan and configured quota. A Free plan
cannot capture hundreds of distinct frames in one invocation. Even on Paid,
do not allocate the entire invocation budget to frame HEADs.

Although the pool starts up to 16 tasks, Workers allows only six connections
waiting for headers at once; excess requests queue. The practical frame-count
ceiling is below the minimum of 10,000, the remaining subrequest allowance, and
`effective concurrency * 30 seconds / measured mean HEAD latency`, with margin
for tails and queueing (each task has a 3-second timeout). At six effective
connections, 500 distinct frames require roughly 360 ms mean latency or better;
3,650 require roughly 49 ms, before overhead. These are optimistic throughput
bounds, not guarantees. Benchmark representative sequences on the target node,
record an operational frame-count ceiling, and keep capture disabled there
until its largest sequence fits. Larger histories need a separately designed
background verification path, not larger synchronous budgets. Check for
`history_stale` after any skipped recapture and recover as described above.