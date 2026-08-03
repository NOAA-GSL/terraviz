# Vendored skill: claude-automation-recommender

This directory is a **vendored copy** of the single skill shipped by
Anthropic's `claude-code-setup` plugin — it analyses a codebase and
recommends Claude Code automations (hooks, subagents, skills, plugins,
MCP servers). It is checked in so the skill is available in every
Claude Code web session for this repo without a per-session install.

| | |
|---|---|
| Upstream | https://github.com/anthropics/claude-plugins-official |
| Plugin | `claude-code-setup` (marketplace `claude-plugins-official`) |
| Upstream path | `plugins/claude-code-setup/skills/claude-automation-recommender` |
| Vendored version | **1.0.0** |
| Marketplace commit | `909649d9b178d142201000c76715b5fc952818e3` |
| License | Apache-2.0 (`LICENSE` in this directory) |

The skill is read-only by design: it emits recommendations and does not
create or modify files.

## Why vendored rather than installed as a plugin

The obvious approach — declaring the plugin under `enabledPlugins` in
`.claude/settings.json` — does not work in a cloud/web session. That
was tried first (PR #348) and backed out. What was measured:

- `extraKnownMarketplaces` **is** honoured at boot: the marketplace is
  registered and the plugin payload is fetched into
  `~/.claude/plugins/cache/`.
- But no install record is written to
  `~/.claude/plugins/installed_plugins.json`, and *that record* is what
  puts a plugin's skills into the session. Confirmed by A/B/A test:
  holding project settings and the cache constant and toggling only the
  record flips availability off/on.
- A SessionStart hook calling `claude plugin install` does write the
  record, but **one session too late** — the skill namespace is built
  before the hook finishes, so the plugin only appears in the *next*
  session. Since a fresh container starts with an empty record, that
  never reliably fires on the session that needs it.

Checked-in skills under `.claude/skills/` are loaded at boot with no
install step, which is why this repo already vendors `graphify` the
same way. Same reasoning, same pattern.

`~/.claude/plugins/` is container state, not repo state — nothing there
survives into a new session, so it cannot be relied on.

## Local divergence from upstream

**None.** `SKILL.md` and `references/` are byte-identical to upstream at
the version above. (Contrast `graphify`, whose `description:` was
rewritten locally — no such change was needed here; the upstream
triggering blurb is already scoped to setup/automation questions.)

Keep it that way if you can: a clean copy makes updating a plain
overwrite.

## Updating

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install claude-code-setup@claude-plugins-official
cp -r ~/.claude/plugins/cache/claude-plugins-official/claude-code-setup/<version>/skills/claude-automation-recommender/. \
      .claude/skills/claude-automation-recommender/
```

That overwrites `SKILL.md` + `references/` and leaves this file and
`LICENSE` in place. Afterwards, bump the version and marketplace-commit
rows above in the same commit, and re-check the divergence note.
