<!--
Guidance is in HTML comments — it won't render, so leave it in place
and write around it.

Delete any section that genuinely doesn't apply. An empty heading is
worse than no heading. The one section worth keeping even when it feels
obvious is Reviewer notes: it's where you say what you're least sure
about, and it's what makes review fast.

The checklist deliberately omits anything CI already enforces
(type-check chain, unit tests, DCO, actionlint, CodeQL). Those fail
loudly on their own; repeating them here just trains people to tick
boxes. What's listed instead are the conventions with no automated gate.
-->

## Summary

<!--
What problem does this solve, concretely? Numbers beat adjectives — "a
16-frame forecast plays in 0.53 seconds, too fast to read" tells a
reviewer more than "playback was too fast".

If the change is a fix, say what was broken and how it was found.
-->

## Related issue

<!-- `Closes #123`, or a sentence on why no issue exists. -->

## Changes

<!--
Grouped by area or by commit, with the *why* — including alternatives
you rejected and the reason. That reasoning is the part reviewers can't
reconstruct from the diff, and the part future readers need most.

If some commits are riskier than others, say so plainly:
"The first is inert; the second is the one that can corrupt a bundle."
-->

## Impact & risk

<!--
Blast radius. What breaks if this is wrong, and who notices first?

Call out explicitly:
- Schema or migration changes (and whether they're additive)
- Anything that requires a deploy ordering (runner before pipeline, etc.)
- Behaviour changes visible to publishers or end users
- What is deliberately NOT affected — that's often the most useful line
-->

## Verification

<!--
What you actually ran, and what it proved. Distinguish verified from
assumed — "type-checks" is not the same as "works on the wire".

If you could not verify something, say so and say why. An honest gap is
reviewable; a silent one is not.
-->

## Reviewer notes

<!--
Where to look, what you're unsure about, what you'd most like challenged.
Judgement calls that are easy to reverse belong here, so a reviewer knows
they're invited to push back rather than assuming they're settled.

Also: related work on other branches, follow-ups you deliberately left
out, and anything that only makes sense with context you have and the
reviewer doesn't.
-->

## Checklist

<!--
Only tick what applies — delete the rest. CI covers the mechanical
conventions; these are the ones it can't see.
-->

- [ ] Commits explain *why*, not just *what*, and the branch is current with `main`

**If this adds a UI route or surface under `src/ui/`**
- [ ] A `Scene` was added in `scripts/screenshots/scenes.ts`, plus a smoke assertion if it's interactive

**If this touches telemetry** (`src/analytics/**`, `functions/api/ingest.ts`, the `TelemetryEvent` union, any `emit()` call site)
- [ ] Reviewed against the checklist in `docs/ANALYTICS_CONTRIBUTING.md` — consider the `analytics-reviewer` subagent
- [ ] Tier chosen deliberately; `docs/ANALYTICS.md` row and `docs/ANALYTICS_QUERIES.md` layout added
- [ ] Grafana panel added; `docs/PRIVACY.md` updated if this captures a new category of signal

**If this edits a `docs/CATALOG_*` plan doc**
- [ ] Cross-links in the sibling docs updated in the same commit

**If this touches an LLM call**
- [ ] Follows `CONTRIBUTING.md` §LLM Integrations — existing contract, availability-gated with a working fallback, no vendor SDK in `dependencies`

**If this touches the desktop app** (`src-tauri/`)
- [ ] Exercised in `npm run dev:desktop`, or noted below why not
