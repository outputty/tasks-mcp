# Readable issue bodies — a regenerated visible spec (roadmap #7)

A managed issue's body now renders a **visible, human-readable spec** below the hidden machine block,
so the issue reads properly in GitHub's web UI instead of looking blank.

## Before / After

Before: `renderBody` put the whole task record — `brief`, `contract`, `scope`, `deps` — inside the
hidden `<!-- outputty:task -->` HTML comment. GitHub renders HTML comments invisibly, so a task created
by `add_task` showed a **blank body** in the browser (only the title carried meaning). `get_task`/BUILD
read the brief fine (from the comment), but a human browsing the repo saw nothing.

After: below the hidden block, `renderBody` emits a visible render — the brief as the lead paragraph,
then `**Contract**`, `**Scope:**`, `**Depends on:**` — wrapped in `<!-- outputty:spec -->` …
`<!-- /outputty:spec -->` sentinels. Real observed (nock suite): the body reads cleanly; a changed
brief regenerates the region (old text gone, never duplicated); `pull` still recovers the brief from
the machine block.

## The design

The user's ruling (2026-08-17): **both** — a visible body (full spec) *and* the machine comment, which
keeps the `brief` so `get_task`/BUILD keep working. Two properties make it safe:

1. **Regenerated, never read back.** The visible spec is derived from the task on every write, so it can
   never drift. The hidden block remains the single source of truth `pull` parses; the visible region is
   display only.
2. **Sentineled, so it isn't mistaken for human prose.** `parseBody` strips the `<!-- outputty:spec -->`
   region before returning `human`, so regeneration never duplicates it and never clobbers genuinely
   human-written prose below it. A body from before this feature (no sentinels) is returned as-is and
   gains a region on its next write.

Consequence: the visible spec is MCP-owned — a hand-edit *inside* the sentinels is overwritten on the
next write. Durable human notes go below the region, or into the issue's comment thread (the trail).

## Where the record lives

- Code: `src/core/providers/github.ts` — `renderSpec`, `renderBody`, `parseBody`/`stripSpec`, the
  `SPEC_OPEN`/`SPEC_CLOSE` sentinels.
- Tests: `test/github.test.ts` — "the body carries a VISIBLE spec that regenerates, and still
  round-trips through the block" (brief visible after the block; a changed brief regenerates; `pull`
  recovers the brief).
- Docs: `README.md` (the tools section), `docs/architecture.md` (the task ↔ GitHub mapping),
  `.claude/architecture/github-mapping.md` (visible-spec section).
