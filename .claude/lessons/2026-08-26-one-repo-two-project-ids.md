# One repo became two projects, and three sessions called it a stale cache

*PLANNING, 2026-08-26 and 2026-08-27. Fix tracked as `cli-never-derives-id-1787814723`.*

## 1. The problem

A **project id** is the key a project's tasks, config and claim ledger are stored under. It was made
opaque and *supplied* on purpose. `product.md` states the rule:

> **project id** — an opaque, provider-agnostic string the user supplies (`--project-id`), never
> derived.

"Never derived" was not aesthetic. Deriving identity from a path had already made every git worktree of
one repository a separate project, each holding a stale partial copy of the graph.

The CLI kept one derivation. `bin/cli.ts:79`:

```ts
const projectId = (): string =>
  validateProjectId(program.opts().project ?? program.opts().projectId ?? process.cwd());
```

The MCP server path has no fallback — `bin/cli.ts:288` leaves the default `undefined` and makes a tool
call name its project.

```
BEFORE
  .mcp.json  --project-id outputty/tasks-mcp   ──►  agents  ──► <cache>/outputty/tasks-mcp.yaml
  bare `tasks-mcp roadmap` in the same dir     ──►  cwd     ──► <cache>/Users/…/tasks-mcp.yaml
```

## 2. What was expected

That a read command in a repository reports that repository's tasks. Three sessions in a row read a
graph, found it disagreeing with reality, and diagnosed a **stale cache** — reasoning that reads are
answered by a local file layer that never hits the network, so of course it lagged.

That reasoning is true, and it was the wrong explanation.

## 3. What actually happened

Nothing was stale. There were two projects.

```
$ node dist/cli.js roadmap        # cwd-derived id
tui-console-1787751801  open  0/6
$ git log --oneline -6            # all six layers merged
```

Running `sync` "fixed" it every time, which is what kept the misdiagnosis alive: GitHub is shared truth,
so syncing pulls the *other* identity's tasks into whichever file you are pointed at. It looked like a
refresh. It was an import.

The split, measured:

```
outputty/tasks-mcp.yaml                           29 tasks   ← agents
Users/ringolds/Documents/Outputty/tasks-mcp.yaml  31 tasks   ← bare CLI
shared task ids: 29 of 29
```

Three consequences, in increasing order of how long they hide:

1. **The task graph converges**, through GitHub, on every sync. This is the part that masks everything
   else.
2. **Claims never converge.** They are local by design (`src/core/claims.ts:17` — a heartbeat per layer
   would rewrite the GitHub issue body on every beat). Observed: `claims/outputty/tasks-mcp.json` held a
   claim on `tui-console-1787751801` while `claims/Users/…json` was empty. So `stale_claims`,
   `in_progress` and the console's age column were split, permanently, with nothing to reconcile them.
3. **The agents' own project vanished from `list_projects`.** Its cache file predated
   `cache-declares-id`, so it carried no `project:` key and was skipped. The listing reported only the
   cwd-derived identity — meaning the console, the picker and `/events` could not see the project the
   builds were actually using.

The operational cost was a stalled queue. A dispatch loop reported "no dispatchable target" three times
in a row while a ready task existed, and told the user only a planning session could unblock it.

```
AFTER (repaired by hand; the code fix is cli-never-derives-id-1787814723)
  both cache files and both claim ledgers deleted
  one sync under outputty/tasks-mcp  →  31 tasks, one identity
```

## 4. Where it showed, and whether it repeats

1. `bin/cli.ts:79` — the `?? process.cwd()` fallback, shipped by the very target that abolished derived
   identity.
2. `bin/cli.ts:288` — the server path, with no fallback, so the two surfaces disagree and neither says so.
3. Three sessions diagnosed "stale cache" and prescribed "sync before reading". One of them wrote that
   prescription up as a lesson and raised its count to ×2 — a wrong diagnosis, reinforced by its own
   evidence, because the fix always appeared to work.
4. `src/core/claims.ts:17` — the design note explaining why claims stay local. Correct, and it is what
   makes a split identity unrecoverable rather than merely annoying.
5. Not caught by tests: both ids are *valid*, both round-trip, both store and read correctly. There is
   no invariant anywhere that says a repository has one id.

×1 as this lesson. The shape: **a default that derives a value the system elsewhere insists must be
supplied.** It is invisible while only one surface is used, and it produces two correct-looking worlds
rather than an error.

## 5. How to prevent it

**A value the design says must be supplied has no default. The call fails instead.** A fallback that
computes one is the same derivation the rule forbids, wearing the word "default" — and it fails open,
into a second valid world, rather than closed into an error someone would have fixed on day one.

Where a value is genuinely needed for ergonomics, read it from **the place that already declares it**
rather than inventing one:

```
--project <id>        explicit, per call
--project-id <id>     explicit, per invocation
.mcp.json in the cwd  the id this repository already declares
                      → otherwise fail, naming the flag
```

**And the diagnostic rule, which is the one that cost three sessions:** when a repair keeps working but
the problem keeps coming back, the repair is treating a symptom. `sync` resolved this every time and
explained nothing. A fix that works without a mechanism you can state is a coincidence you have not
finished investigating.
