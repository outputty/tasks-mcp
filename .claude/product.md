# tasks-mcp — Product

> North Star + Language only. Every session reads this — keep it small. What we're building and why →
> `roadmap.md` · what exists → `architecture.md` · what we tried → `lessons.md`. Every ✅ claim is
> verified by a run.

## North Star

The agent runs the task list; the task systems keep the record. tasks-mcp is a proxy for
agentic task management: an agent plans, files, sequences, and closes work across sessions
through typed MCP tools, every change is backed up into one or more connected providers
(GitHub today) where humans see and edit the same plan, and a local copy of the graph gives
dependency resolution no external tracker offers.

Strong sides, one example each:

- Cross-session: a task filed in one session is `list_ready` in the next. The plan survives
  in the providers, not in the conversation.
- The two planning questions, answered instantly and offline from the local copy: `prereqs`
  (what must be done before X, as dependency-ordered layers) and `blockers` (open tasks
  ranked by transitive downstream impact).
- Two altitudes in one graph: a `target` is a roadmap row that groups the tasks serving it, its
  progress derived from them rather than maintained by hand, and the same engine answers
  "what must ship before this target" that answers it for a task.
- The sync survives the real world. A hand-opened issue is adopted as a task; a label edit
  in the GitHub UI flows back on the next sync; a junk label value is ignored, not crashed
  on; a corrupt or deleted local copy rebuilds itself from the providers.

Wedge: the agent owns task management end to end while the providers stay layered mirrors
behind one seam — deepest wins, absence is not a claim — so connecting another provider is
a free migration and losing the local copy loses nothing.

## Language

- **task** — One tracked unit — id, title, status, deps, scope, execution properties, brief/contract prose; one issue on GitHub.
- **layer** — One provider in the stack — a class implementing the seam, owning its own storage and handles. (replaces: backend, sync target, adapter)
- **stack** — The ordered provider list a project's tasks live in — file layer first, remotes beneath; order is authority order. (replaces: cache+provider pair)
- **seam** — The whole Provider interface — init / pull / upsert (+ optional upsertMany); create-vs-update is the layer's call. (replaces: port)
- **deepest wins** — The sync merge rule — on any disagreement the deepest layer's version is truth, pushed back into every layer that differs.
- **absence is not a claim** — A task missing from a layer is pushed into it, never deleted from the others; deletions never propagate.
- **free migration** — What the stack rules buy — a newly added (or wiped) layer is backfilled by the next sync, no tooling.
- **handle** — A layer-private remote id (issue number, card node id) kept in that layer's index — never visible above the seam. (replaces: ref)
- **body block** — The hidden YAML block leading a managed issue's body — id first, then deps, scope, brief, contract, attempts, discovered_from. (replaces: id-label)
- **managed issue** — An issue whose body carries the block; human prose below the block is preserved across updates.
- **adopt** — Import a hand-opened issue as task `gh-<number>` and stamp its body with the block, so it is tracked from then on.
- **execution properties** — The scalar fields that modify how a task is built — kind, tier, qa, spec, stage, priority.
- **field:value label** — One GitHub label per execution property (`tier:2`, `priority:high`) — created on demand, color-coded per field, editable in the UI, pulled back by sync; junk values ignored; foreign labels never touched.
- **board** — The Projects v2 kanban — one card per task-issue, Status column mirrors open/done both ways; found or created by name (default "Tasks"). (replaces: kanban)
- **best-effort** — The board's error contract — a board failure warns and continues; the issue write always decides success.
- **first-wins** — Duplicate-id resolution — when two issues claim one task id, every read and write resolves to the OLDEST issue; the collision is counted, never auto-deleted. (replaces: last-wins)
- **quarantine** — An unparseable task file is renamed `.corrupt`; the layer reads empty and the next sync rebuilds it from the layers below.
- **the two questions** — What a dependency graph is for — `prereqs` (what must be done before X, as ordered layers) and `blockers` (open tasks ranked by transitive downstream impact).
- **target** — A roadmap item as a graph node: `type: target`, groups the tasks naming it, never dispatched, progress derived. (replaces: roadmap row, epic, milestone)
- **sub-issue edge** — Where a task's `target` is stored on GitHub — the target's issue is its parent, so re-parenting in the web UI flows back. (replaces: target label, project membership)
- **derived progress** — A target's standing, counted from the tasks pointing at it; never authored, so it cannot go stale.
- **ready** — A task that can be worked right now — open, spec settled, every dep done, and NOT a target.
- **planning** — The tasks the planning stage still owns — spec `drafting` or `replan`.
