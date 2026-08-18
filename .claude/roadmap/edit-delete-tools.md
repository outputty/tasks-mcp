# Edit and delete tools (roadmap #8)

Two tools round out task CRUD: **`edit_task`** patches any field of a task, and **`delete_task`**
permanently removes a task and its GitHub issue.

## Before / After

Before: the surface could `add`, `amend` (widen scope / set brief only), and `close`. There was no
general edit — fixing a title or contract meant hand-editing the issue — and no delete at all, by the
"deletions never propagate" ruling.

After:

- **`edit_task`** — patch any field (`title`, `brief`, `contract`, `deps`, `scope`, `tier`, `qa`,
  `priority`, `spec`, `stage`); only the fields passed change, the `id` is fixed. It shares `buildPatch`
  with the CLI `edit` (deps/scope normalized, the label fields validated). Unlike `amend_task` it can
  narrow scope and edit a done task. Real observed (nock suite): `edit_task {title, tier}` returns the
  updated task; the issue body and labels are rewritten.
- **`delete_task`** — permanently remove the task from every layer.

## Delete semantics

Delete is an **explicit, intentional** operation — the counterpart to, not a violation of, "deletions
never propagate." That ruling is about `sync`: an *accidental* absence in one layer is restored
(absence is not a claim). `delete_task` is the deliberate opposite, and it fans **deepest-first**:

1. `GitHubProvider.delete` — best-effort remove the board card (`deleteProjectV2Item`), then
   `deleteIssue` (permanent). Needs the token's **delete-issue permission** (repo admin/triage); a
   normal token can't, and the error propagates.
2. then the shallower layers (the file cache).

Deepest-first means a permission refusal on GitHub throws **before** the local cache is touched — no
half-deleted state for the next `sync` to resurrect. A three-layer stack test pins that a deleted task
stays gone across a following `sync`. A provider that doesn't implement `delete` is skipped (it can't be
deleted from, and would resurrect on sync) — the file and GitHub layers both implement it.

## Where the record lives

- Code: `src/core/providers/provider.ts` (`delete?` on the seam), `src/core/providers/github.ts`
  (`delete`, `removeCard`, the `deleteIssue`/`deleteProjectV2Item` mutations),
  `src/core/providers/file.ts` (`delete`), `src/core/service.ts` (`delete`, deepest-first),
  `src/core/graph.ts` (`buildPatch`), `src/mcp/server.ts` (`edit_task`, `delete_task`),
  `bin/cli.ts` (`edit`, `delete`).
- Tests: `test/github.test.ts` (delete removes issue + card), `test/stack.test.ts` (delete through
  every layer, stays gone on sync), `test/mcp.test.ts` (edit + delete over HTTP); `test/nock-github.ts`
  fakes the delete mutations.
- Docs: `README.md` (tools table), `.claude/architecture/surfaces.md`, `architecture.yaml` MCP entry.
