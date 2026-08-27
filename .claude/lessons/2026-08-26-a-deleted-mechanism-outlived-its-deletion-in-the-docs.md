# A deleted mechanism outlived its deletion in the docs

*PLANNING, 2026-08-26.*

## 1. The problem

`.claude/architecture.md` is this repository's record of **what exists**. It carries a prose section per
mechanism and a **feature index** at the end — one table row per feature, pattern or limitation — and
every session that plans, builds or reviews is told to read it whole.

`.claude/examples.md` holds the canonical worked examples, each an `Input:`/`Output:` pair, pinned once
and referenced from task contracts rather than copied.

Commit `0a940dd` deleted a whole subsystem:

```
Delete the channel: nothing pushes, the dispatcher reads

Gone: the notify tool and CLI command, the Doorbell, the cross-process
event spool, the claude/channel capability, and the
--dangerously-load-development-channels launch flag it required.
```

`src/core/channel.ts` was removed. Nothing else was.

## 2. What was expected

That product memory describes the code. A planning session's first act is to read `architecture.md`
whole and plan against it, on the stated assumption that what it documents is what exists.

## 3. What actually happened

Four false claims survived the deletion, and a planning session met all four while designing a **change
stream** — the exact area the deleted machinery had occupied.

`architecture.md` still carried a 60-line `## The channel` section describing the doorbell and the spool
as live, plus three feature-index rows:

```
| channel | feature | The server pushes a doorbell event into a live session… |
| doorbell | pattern | One event kind, coalesced per tick… |
| spool broadcast | pattern | Cross-process delivery once PER PROCESS… |
```

`examples.md` asserted a tool count, with a date stamp that made it look verified:

```
21 tools registered (REAL OBSERVED 2026-08-20, counted in src/mcp/server.ts): …
blockers, notify, get_config, set_config.
```

`notify` had been deleted. The real count, measured this session by counting `registerTool` calls, is
**20**. `architecture.md` said **16** in three separate places — a number that was stale before the
channel was ever deleted.

```
$ grep -c -A1 "server.registerTool(" src/mcp/server.ts   # 20
$ ls src/core/channel.ts                                 # No such file or directory
```

The cost was not hypothetical. The session was drafting `GET /events` and had to establish, from git
history rather than from the document, whether it was proposing a feature or reverting a decision.

## 4. Where it showed, and whether it repeats

1. `0a940dd` — deleted `src/core/channel.ts` and the notify tool; touched no product memory.
2. `.claude/architecture.md` — `## The channel` section, live-voice, removed this session.
3. `.claude/architecture.md` — three feature-index rows for deleted machinery, removed this session.
4. `.claude/examples.md` — "21 tools … notify", corrected to 20 this session.
5. `.claude/architecture.md` — "16 tools" in the prose, the mermaid diagram and the feature index,
   corrected to 20 this session. This one was stale *independently* of the deletion, so the drift has
   two separate causes.
6. `.claude/lessons.md` still references `src/core/channel.ts` in four `Files:` lines. Left as-is: the
   archive records what was true when written, and rewriting history there would be wrong.
7. `bin/cli.ts` removed the `?? process.cwd()` project-id fallback (BUILD, 2026-08-27, PR #100). The
   build's claim-surface sweep covered `docs/`, `src/`, `bin/` and `README.md` but **not `.claude/`**,
   and master QA caught two survivors: `architecture.md`'s CLI section still said `--project` "defaults
   to cwd", and `examples.md`'s `identify` example still said the id is "never resolved against … the
   filesystem" and carried a "not yet built" marker. Both described the exact behaviour the diff removed,
   in the same two files as items 2-5. Fixed in `e150101` on the salvage round.

×2 as events — a deletion (`0a940dd`) and a behaviour change (the cwd-fallback removal) — the first alone
yielding **five distinct false claims**, and the tool count had already drifted once on its own. The
pattern is any claim a diff falsifies — a count, an enumeration, or a described behaviour: it reads as
verified, ages silently, and nothing fails when it is wrong. Both events left the same two files stale
(`architecture.md`, `examples.md`), and in the second a sweep that skipped `.claude/` is what let it through.

## 5. How to prevent it

**A commit that deletes a mechanism deletes its feature-index row and its prose section in the same
commit — the deletion is not finished while the docs still describe it.** The feature index is the
checklist: if a row names something the diff removed, the row goes with it.

**The claim-surface sweep after a code change includes `.claude/` product memory, not only `docs/`,
`src/` and `bin/`.** `architecture.md` and `examples.md` describe behaviour a diff can falsify, and every
session reads them on plan, build and review — a stale line there re-plants the removed misconception in
the place the next session reads first. Grep the changed symbol, path and behaviour across `.claude/` in
the same sweep that covers the code, then run the done-condition (`rg '<the removed behaviour>' .claude/`
returns nothing).

**A count in product memory carries the command that produces it, beside the number.** A bare "21 tools"
cannot be checked without knowing how it was counted; a stamped one is worse, because the stamp reads as
evidence.

```
BEFORE
  21 tools registered (REAL OBSERVED 2026-08-20, counted in src/mcp/server.ts): …

AFTER
  20 tools registered (REAL OBSERVED 2026-08-26):
  $ grep -c -A1 "server.registerTool(" src/mcp/server.ts
```

Where a claim is genuinely expensive to re-derive, it belongs in the feature index as a `limitation`
carrying its probe — the shape this repository already uses for external constraints.
