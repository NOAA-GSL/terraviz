# Publisher roles & capabilities — scoping

**Status:** implemented (R1–R5 landed); this doc is now the reference
for the model. All five open decisions were resolved as recommended
(D1 tighter events approval, D2 rename, D3 editor hero, D4 contributor
default, D5 plain drafts).
**Last reviewed:** 2026-07-15
**Owner:** catalog / publisher-portal track
**Supersedes when:** the role/capability matrix is folded into
`CATALOG_PUBLISHING_TOOLS.md` (the `publisher-store.ts` taxonomy comment
already points here).

> **Implementation note.** The matrix lives in
> `src/types/publisher-roles.ts` (shared) with the server adapter in
> `functions/api/v1/_lib/capabilities.ts`. `isPrivileged` / `isAdmin`
> are retained as thin aliases (`operator.manage` / `users.manage`).
> Every create surface now gates in the UI on `content.create`:
> events / hero / users as originally specified, plus datasets / blog /
> tours / import, which hide (or, for import, replace with a restricted
> card) their create affordance after a `/me` probe. The datasets probe
> runs on a dedicated `meFetchFn` seam so it doesn't perturb the
> list's fetch-sequence tests. The server 403 remains the authoritative
> gate behind every one of these.

A design for a WordPress-style five-role model for the publisher
portal, replacing today's effectively-binary (`admin` vs everyone)
authorization with an explicit **capability matrix**.

This is a scoping artifact, not an implementation. It lays out the
problem, the capability vocabulary, the role→capability matrix, the
per-endpoint mapping, the data model + migration, the portal UI, the
phasing, and the open decisions.

---

## 1. Why

The recent "read-all / write-own" work (PR #283) opened datasets,
events, and blog to any active publisher while keeping *writes*
owner-scoped. That's the right shape, but it exposed a structural gap:

- **Authorization is binary.** The only two primitives in the codebase
  are `isPrivileged(p)` (`role ∈ {admin, service}`) and `isAdmin(p)`
  (`role === 'admin'`). Every gate is one of those two plus an
  ownership check.
- **`readonly` is a no-op.** `ASSIGNABLE_ROLES` advertises
  `['admin', 'publisher', 'readonly']`, but `readonly` is **never
  checked anywhere**. A `readonly` account can create and write its own
  datasets/blog/events exactly like a `publisher`. We ship a role that
  does nothing.
- **Nothing sits between author and admin.** The only way to let
  someone review/publish *other people's* content is to hand them full
  admin — which also grants user management, feed connectors, the node
  profile, and the signing keys. That's too much power for a "managing
  editor."

WordPress solved this decades ago with a small, legible ladder:
Administrator ▸ Editor ▸ Author ▸ Contributor ▸ Subscriber. Each rung
is a well-understood bundle of capabilities. We adopt the same ladder,
implemented as a capability matrix so the policy lives in one table.

### Non-goals

- **Per-object ACLs / sharing.** No "share this dataset with user X."
  Access is role + ownership, not per-row grants.
- **Groups / teams beyond `org_id`.** The `publishers.org_id` column
  exists and may later scope visibility to an org, but this plan is
  about *role* capabilities, not org membership.
- **Federation role propagation.** Roles are node-local. A peer node's
  roles are its own; nothing here crosses the federation boundary.
- **A general CMS permission engine.** Fixed capability enum, fixed
  role table. No user-defined roles or runtime capability editing.

---

## 2. The five roles

| Role | WordPress analogue | One-line charter |
|---|---|---|
| **Admin** | Administrator | Everything — content, users, feeds, node profile, keys. |
| **Editor** | Editor | Review/publish/edit **any** content; **no** users/operator settings. |
| **Author** | Author | Create + publish/edit **own** content. |
| **Contributor** | Contributor | Create + edit **own drafts**; **cannot self-publish** — an Editor/Admin approves. |
| **Reviewer** | Subscriber | **Read-only** — sees catalog, queues, insights; authors nothing. |

Plus one non-assignable machine role:

- **Service** — machine credential / CLI token. Capability-equivalent
  to Admin. Provisioned automatically from an Access service token,
  never hand-assigned (unchanged from today).

### Naming (Decision D2, §8)

Today's stored role strings are `admin` / `publisher` / `readonly` /
`service`. This plan proposes canonical strings
`admin` / `editor` / `author` / `contributor` / `reviewer` / `service`,
migrating `publisher → author` and `readonly → reviewer` (additive
backfill, same pattern as `0023_publisher_roles_two_tier.sql` which
renamed `staff/community → admin/publisher`). Display labels are i18n
keys, so the wire string and the shown label are already decoupled.

---

## 3. Capability vocabulary

A capability is a verb the server checks, independent of role. The
matrix maps roles to capability sets; gates ask `can(publisher, cap)`,
never `role === '...'`.

| Capability | Meaning |
|---|---|
| `content.read` | Read the catalog, the events queue, the blog list, and any single row/draft. |
| `content.create` | Create a new **own** draft (dataset / event / blog / tour). |
| `content.edit.own` | Edit/delete a row you own. |
| `content.publish.own` | Publish/retract (blog, dataset) or **approve** (event) a row you own. |
| `content.edit.any` | Edit/delete **any** row, regardless of owner. |
| `content.publish.any` | Publish/retract/approve/reject **any** row, incl. claiming an unclaimed event. |
| `insights.read` | Read Analytics + Feedback dashboards. |
| `hero.read` | See the current "Right now" hero pin. |
| `hero.manage` | Set/clear the hero override. |
| `operator.manage` | Feed connectors, node profile, R2/key config, feed Refresh. |
| `users.manage` | Approve/suspend publishers, assign roles (the Users tab). |

Ownership-aware gates compose a capability with an ownership test, e.g.

```
canEditDataset(p, row) =
  can(p, 'content.edit.any') ||
  (can(p, 'content.edit.own') && row.publisher_id === p.id)
```

This is the same shape as today's `canMutateDataset` /
`canMutateBlogPost` / `canMutateEvent`, but the privileged half becomes
a capability check instead of `isPrivileged`.

---

## 4. Role → capability matrix

`●` = granted, `–` = denied.

| Capability | Reviewer | Contributor | Author | Editor | Admin |
|---|:--:|:--:|:--:|:--:|:--:|
| `content.read` | ● | ● | ● | ● | ● |
| `insights.read` | ● | ● | ● | ● | ● |
| `hero.read` | ● | ● | ● | ● | ● |
| `content.create` | – | ● | ● | ● | ● |
| `content.edit.own` | – | ● | ● | ● | ● |
| `content.publish.own` | – | – | ● | ● | ● |
| `content.edit.any` | – | – | – | ● | ● |
| `content.publish.any` | – | – | – | ● | ● |
| `hero.manage` | – | – | – | ●¹ | ● |
| `operator.manage` | – | – | – | – | ● |
| `users.manage` | – | – | – | – | ● |

¹ `hero.manage` for Editor is **Decision D3** (§8) — the current
behavior is admin-only. Recommendation: grant it to Editor (the hero is
an editorial curation call), but it is the one cell reasonable people
will disagree on.

Service = Admin's column.

**Reading the ladder:** each role is a strict superset of the one to
its left, except that Editor gains the `*.any` tier and Admin adds the
operator/users tier on top. That monotonicity is worth preserving —
it's what makes the model legible.

---

## 5. Per-endpoint mapping

The gate each route should call after Phase R1. "own-or-any" means the
ownership-composed check from §3.

### Datasets (`functions/api/v1/publish/datasets*`)
| Route | Today | New gate |
|---|---|---|
| `GET` list / `GET :id` | open to active | `content.read` |
| `POST` (create draft) | open to active | `content.create` |
| `PUT :id` (edit) | owner-or-privileged | edit own-or-any |
| `POST :id/publish`, `/retract` | owner-or-privileged | publish own-or-any |
| `DELETE :id` | owner-or-privileged | delete own-or-any |
| `POST :id/preview` | owner-or-privileged | edit own-or-any |
| `POST :id/reindex` | `isPrivileged` | `content.publish.any` |

### Events (`functions/api/v1/publish/events*`)
| Route | Today | New gate |
|---|---|---|
| `GET` list | open to active | `content.read` |
| `POST` (manual create) | open to active | `content.create` (creator owns) |
| `POST :id` (review/approve/reject) | unclaimed-or-owner-or-priv | **see D1** |
| `POST :id/image`, `/tour` | unclaimed-or-owner-or-priv | edit own-or-any |
| `POST refresh` (feeds) | `isPrivileged` | `operator.manage` |

### Blog (`functions/api/v1/publish/blog*`)
| Route | Today | New gate |
|---|---|---|
| `GET` list / `GET :id` | open to active | `content.read` |
| `POST` (create), `/generate` | open to active | `content.create` |
| `PUT :id` (edit) | author-or-priv | edit own-or-any |
| `POST :id` (publish/unpublish) | author-or-priv | publish own-or-any |

### Tours (`functions/api/v1/publish/tours*`)
Same shape as datasets (create/edit/publish own-or-any). Tours were not
part of PR #283's read-all work; folding them into the capability model
is part of Phase R3/R4.

### Everything else
| Surface | New gate |
|---|---|
| Analytics, Feedback (GET) | `insights.read` |
| Featured Hero (GET / PUT-DELETE) | `hero.read` / `hero.manage` |
| Feeds console, Node profile, key/R2 config | `operator.manage` |
| Users tab | `users.manage` |

---

## 6. The events-approval reconciliation (Decision D1)

This is the one place the five-role model **changes behavior we just
shipped**, so it gets its own section.

PR #283 decided: *any active publisher may approve an unclaimed
(feed-proposed) event, thereby claiming ownership.* Under a role ladder
where **publishing is a privilege that grows with rank**, that's too
generous — approving an event makes it public, and "make content you
don't own public" is exactly `content.publish.any` (Editor+).

Recommended reconciliation:

- **Contributor** — may `POST` a manual event (it's a draft/proposed
  row they own) but **cannot approve** anything, including their own.
- **Author** — may approve/reject an event **they own** (their manual
  event) via `content.publish.own`. May **not** approve an unclaimed
  feed event (that needs `.any`).
- **Editor / Admin** — may approve/reject **any** event via
  `content.publish.any`, which is also what claims an unclaimed feed
  event. Approving still stamps `owner_id` (the claim), so the audit
  trail of "who made it public" is preserved.

Net effect: the feed review queue becomes an **Editor** responsibility
(matches "the managing editor runs the newsroom"), while Authors and
Contributors propose. This is a one-line change to `canMutateEvent`
plus the approve-branch in the review handler, and an update to the
events route tests added in PR #283.

> If the team prefers the shipped egalitarian-queue behavior (any
> author can claim + approve a feed event), that's the alternative for
> D1 — grant `content.publish.any` on unclaimed-owner rows to Author.
> The doc recommends the tighter reading for ladder consistency.

---

## 7. Implementation shape

### 7.1 Capability layer (server)

A new pure module `functions/api/v1/_lib/capabilities.ts`:

```ts
export type Capability = 'content.read' | 'content.create' | …
export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = { … }
export function can(publisher: PublisherRow, cap: Capability): boolean
```

- `isPrivileged` / `isAdmin` become thin, deprecated aliases
  (`can(p, 'content.publish.any')` / `can(p, 'users.manage')`) so
  Phase R1 is a **no-behavior-change** refactor with the existing tests
  still green.
- The matrix is unit-tested as a table (role × capability), so a
  future edit to one cell is a visible, reviewed diff.

### 7.2 Shared role→capability constant (both tiers)

The portal needs to gate controls the same way the server gates
requests. Mirror the `src/types/node-features.ts` pattern: a shared
constant (`src/types/publisher-roles.ts`) with the role list + the
capability map + a `can(role, cap)` helper, imported by both
`functions/` and `src/ui/publisher/`. `GET /api/v1/publish/me` returns
the caller's `role` (it already does) and gains a derived
`capabilities: string[]` so the portal never hard-codes the matrix.

### 7.3 Data model / migration

- `0039_publisher_roles_five.sql` — no schema change (the `role` column
  has no CHECK constraint, by design; see
  `0005_publishers_audit.sql`). Additive backfill only:
  `UPDATE publishers SET role='author' WHERE role='publisher';`
  `UPDATE publishers SET role='reviewer' WHERE role='readonly';`
  New rows (`editor`, `contributor`) need no backfill. `is_admin` stays
  the synced mirror of `role='admin'`.
- `ASSIGNABLE_ROLES` → `['admin','editor','author','contributor','reviewer']`.
- Provisioning defaults unchanged (untrusted-domain logins →
  `contributor`/`pending`? — **Decision D4**, §8; today it's
  `publisher`/`pending`).

### 7.4 Portal UI

- **Users tab** (`pages/users.ts`) — the role `<select>` grows from 3
  options to 5, each with a one-line capability blurb. No structural
  change; it already PATCHes `role`.
- **Every gated page** already reads `can_edit`-style flags per row
  (added in PR #283). Page-level chrome (New buttons, the events
  Refresh, hero Set/Clear) switches from `clientIsPrivileged(me)` to
  `can(me, cap)` using the shared constant.
- **Contributor's missing publish** needs one new affordance: a
  dataset/blog "Submit for review" state (draft that an Editor
  publishes). Minimal version: Contributors simply lack the Publish
  button; the draft sits in the queue for an Editor. A first-class
  "submitted" sub-status is a **stretch** (D5).

---

## 8. Open decisions

- **D1 — events approval tier.** Recommended: approving an *unclaimed*
  event requires `content.publish.any` (Editor+); Authors approve only
  their own. Alternative: keep PR #283's any-author-claims behavior.
  *(This is the one behavior-reversal; needs an explicit call.)*
- **D2 — rename `publisher→author`, `readonly→reviewer`?** Recommended:
  yes, via additive backfill, for names that match the mental model.
  Alternative: keep the wire strings, relabel in i18n only.
- **D3 — `hero.manage` for Editor?** Recommended: yes (editorial call).
  Alternative: keep hero admin-only.
- **D4 — default role for a new untrusted-domain login.** Recommended:
  `contributor`/`pending` (least privilege; an admin promotes).
  Today's default is `publisher`(author)/`pending`.
- **D5 — first-class "submitted for review" status** for Contributor
  drafts, vs. just "a draft an Editor can publish." Recommended: ship
  the plain version first, add the sub-status only if the review
  workflow needs it.

---

## 9. Phasing

Each phase is independently shippable and, except where noted, tested
before the next begins (per the repo's one-logical-change rule).

- **R1 — Capability layer, zero behavior change.** Add
  `capabilities.ts` + the shared constant; rewire existing gates to
  `can(...)` so results are identical; matrix table tests. `me` returns
  `capabilities`.
- **R2 — Make Reviewer real.** `reviewer` (ex-`readonly`) loses
  `content.create`/`edit`/`publish`. First actual behavior change:
  fixes the no-op role. Users tab + docs updated.
- **R3 — Editor role.** Grant `content.*.any` (+ `hero.manage` per D3).
  Fold tours into the ownership-composed gates. Portal: Editors see
  Edit/Publish on any row.
- **R4 — Contributor role.** `content.create` + `edit.own` without
  `publish.own`. Publish affordances hidden for Contributors across
  datasets/blog/events; the D1 events reconciliation lands here.
- **R5 — Polish.** Default-role decision (D4), optional submitted-status
  (D5), provisioning copy, and folding this matrix into
  `CATALOG_PUBLISHING_TOOLS.md` + the `publisher-store.ts` taxonomy
  comment. Retire the deprecated `isPrivileged`/`isAdmin` aliases.

---

## 10. Testing posture

- **Matrix table test** — the single source of truth; `role ×
  capability → boolean`, asserted exhaustively so any cell change is a
  reviewed diff.
- **Per-endpoint gate tests** — one "allowed" + one "forbidden" case
  per capability tier per route (extends the PR #283 suites, which
  already stand up multi-role contexts).
- **Ownership composition** — own-vs-others cases for each `*.own`
  capability (already present for datasets/blog/events; extend to
  tours).
- **Portal gating** — the shared `can()` constant is unit-tested;
  page tests assert the right controls appear per role (mirrors the
  read-only tests added in PR #283).

---

## 11. Rollout / safety

- The migration is additive and reversible (roles are free-text).
  Existing `admin` and `publisher`(→`author`) accounts keep their
  current effective powers; only `readonly`(→`reviewer`) *loses* the
  authoring it was never supposed to have — a security tightening, not
  a regression for any legitimate workflow.
- No account is silently promoted. `editor` / `contributor` exist only
  once an admin assigns them.
- Because R1 is behavior-preserving and every later phase is gated
  behind a role nobody holds yet (R3/R4) or a tightening of an unused
  role (R2), the blast radius at each step is small and auditable.
