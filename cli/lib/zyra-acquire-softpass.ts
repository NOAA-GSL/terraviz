/**
 * Soft-pass decision for a transient NOAA-FTP `acquire` failure in a
 * scheduled Zyra workflow run.
 *
 * The problem this solves (`.github/workflows/zyra-run.yml`): zyra's
 * FTP backend has no retry and no reconnect (an MDTM storm can
 * self-inflict a disconnect mid-`sync_directory`), so a single
 * transient NOAA-FTP hiccup crashes the `acquire` stage and fails the
 * whole run — firing a red GitHub job + a `failed` workflow_run status
 * even though the published dataset is intact and self-heals on the
 * next tick (acquire is incremental: the missing frames are fetched
 * next run). Those are false-positive notifications.
 *
 * The fix: when `zyra run` fails *specifically* at acquire AND the
 * dataset already has a published, still-fresh bundle, finish the run
 * GREEN as a no-op ("no new data this tick") instead of red. A
 * *sustained* outage still escalates — once the published bundle's
 * trailing edge falls behind `staleAfterSeconds`, the run fails loudly
 * so the operator is paged. Anything that isn't a recognized transient
 * acquire/FTP error (a compose-video crash, a code error, a
 * never-published dataset) always fails loudly — this only ever
 * softens the one well-understood transient.
 *
 * Pure logic, unit-tested. The runner phase
 * (`cli/zyra-publish-from-dispatch.ts --phase=acquire-softpass`) wires
 * the captured `zyra run` log + the dataset row into these helpers and
 * either posts a no-op `succeeded` (soft-pass) or returns non-zero
 * (escalate → the workflow's `if: failure()` step posts `failed`).
 */

/**
 * Signatures that mark a `zyra run` failure as an *acquire-stage*
 * fetch failure rather than a downstream (compose / code) failure.
 *
 * Two families, both safe to soft-pass:
 *   - FTP-connector specifics — zyra's `connectors/backends/ftp.py`
 *     (`ftplib`, MDTM, `ensure_ftp_connection`, the ftplib exception
 *     classes). Unambiguous.
 *   - Network-level transients — timeouts, connection resets/refusals,
 *     DNS failures. In a real-time pipeline `acquire` is the *only*
 *     network-touching stage (`pad-missing` and `compose-video` are
 *     local), so a network error is an acquire error. A compose-video
 *     failure surfaces ffmpeg errors, not these — the families don't
 *     overlap in practice.
 *
 * Deliberately conservative: an unrecognized failure returns
 * `acquireFailure: false` and escalates (the current, notify-loudly
 * behaviour), so a real bug can never be silently swallowed.
 */
const ACQUIRE_FAILURE_SIGNATURES: ReadonlyArray<{ re: RegExp; label: string }> = [
  // FTP-connector specifics.
  { re: /ftplib/i, label: 'ftplib' },
  { re: /ensure_ftp_connection|sync_directory/i, label: 'ftp-connector' },
  { re: /\bMDTM\b/, label: 'ftp-mdtm' },
  { re: /error_perm|error_temp|error_proto|error_reply/i, label: 'ftplib-error' },
  { re: /\bftp:\/\//i, label: 'ftp-url' },
  // Network-level transients (acquire is the only network stage).
  { re: /TimeoutError|socket\.timeout|timed out/i, label: 'timeout' },
  { re: /Connection reset|ConnectionResetError|\[Errno 104\]/i, label: 'conn-reset' },
  { re: /Connection refused|\[Errno 111\]/i, label: 'conn-refused' },
  { re: /Network is unreachable|\[Errno 101\]|\[Errno 110\]/i, label: 'net-unreachable' },
  { re: /\bEOFError\b/, label: 'eof' },
  {
    re: /Temporary failure in name resolution|getaddrinfo|Name or service not known/i,
    label: 'dns',
  },
]

export interface FailureClassification {
  /** True when the captured log matches a known transient
   *  acquire/FTP/network signature. */
  acquireFailure: boolean
  /** The matched signature label (for logging), or null. */
  signal: string | null
}

/**
 * Classify a failed `zyra run`'s captured combined output. Matches the
 * first acquire/FTP/network signature it finds; otherwise reports a
 * non-acquire failure (which the caller escalates).
 */
export function classifyZyraFailure(log: string): FailureClassification {
  for (const sig of ACQUIRE_FAILURE_SIGNATURES) {
    if (sig.re.test(log)) return { acquireFailure: true, signal: sig.label }
  }
  return { acquireFailure: false, signal: null }
}

/** A dataset is "published" once it has any non-empty `data_ref` — it
 *  has been through a successful transcode at least once and is
 *  serving content. A never-published dataset (null/empty ref) has
 *  nothing to fall back to, so its acquire failure must escalate. */
export function hasPublishedBundle(dataRef: string | null | undefined): boolean {
  return typeof dataRef === 'string' && dataRef.trim().length > 0
}

export interface FreshnessInput {
  dataRef: string | null | undefined
  /** The dataset row's `end_time` (the data's trailing edge). A
   *  soft-pass never advances it — during an outage it freezes while
   *  `now` marches on, so its age is the outage duration. */
  endTime: string | null | undefined
  nowMs: number
  staleAfterSeconds: number
}

export interface FreshnessResult {
  published: boolean
  stale: boolean
  /** Age of the bundle's trailing edge in seconds, or null when it
   *  can't be measured (unset/unparseable `end_time`). */
  ageSeconds: number | null
  detail: string
}

/**
 * Assess whether the dataset's published bundle is fresh enough to
 * soft-pass over a transient acquire failure.
 *
 * - No published bundle → not fresh (escalate: nothing to serve).
 * - Published but `end_time` unset/unparseable → can't measure age;
 *   treat as fresh (don't escalate on an unknown — the data is intact
 *   and the failure is a recognized transient).
 * - Published with a trailing edge older than `staleAfterSeconds` →
 *   stale (escalate: the outage is sustained).
 */
export function assessBundleFreshness(input: FreshnessInput): FreshnessResult {
  if (!hasPublishedBundle(input.dataRef)) {
    return {
      published: false,
      stale: true,
      ageSeconds: null,
      detail: `dataset has no published bundle (data_ref=${input.dataRef ?? '(none)'})`,
    }
  }
  const endMs = input.endTime ? Date.parse(input.endTime) : NaN
  if (!Number.isFinite(endMs)) {
    return {
      published: true,
      stale: false,
      ageSeconds: null,
      detail: `end_time ${input.endTime ?? '(unset)'} is unparseable — cannot measure staleness, treating the bundle as fresh`,
    }
  }
  const ageSeconds = Math.round((input.nowMs - endMs) / 1000)
  const stale = ageSeconds > input.staleAfterSeconds
  return {
    published: true,
    stale,
    ageSeconds,
    detail: `published bundle trailing edge is ${ageSeconds}s old (stale-after ${input.staleAfterSeconds}s)`,
  }
}

export interface SoftPassDecision {
  /** Finish the run GREEN as a no-op (post `succeeded`). */
  softPass: boolean
  /** Human-readable rationale for the run log. */
  reason: string
}

/**
 * Combine the failure classification and bundle freshness into the
 * terminal soft-pass-or-escalate decision. Soft-pass requires BOTH a
 * recognized transient acquire failure AND a published, still-fresh
 * bundle; every other path escalates (fail loudly + notify).
 */
export function decideAcquireSoftPass(opts: {
  classification: FailureClassification
  freshness: FreshnessResult
}): SoftPassDecision {
  if (!opts.classification.acquireFailure) {
    return {
      softPass: false,
      reason:
        'failure is not a recognized transient acquire/FTP error — failing loudly (real error)',
    }
  }
  if (!opts.freshness.published) {
    return {
      softPass: false,
      reason: `acquire failed and ${opts.freshness.detail} — nothing to fall back to, failing loudly`,
    }
  }
  if (opts.freshness.stale) {
    return {
      softPass: false,
      reason: `acquire failed and ${opts.freshness.detail} — sustained outage, escalating`,
    }
  }
  return {
    softPass: true,
    reason: `transient acquire failure (${opts.classification.signal}); ${opts.freshness.detail} — no new data this tick, soft-passing (prior bundle preserved)`,
  }
}
