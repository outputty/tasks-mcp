# How to change what the queue offers next

`list_ready` returns the tasks that can be worked right now, best first. This is how to move something
up that order, hold something back, or split the queue between two workers.

The order is a starting point, not a decision — a caller is free to read the roadmap and pick
differently. What follows changes the starting point.

## Know what you are moving

Each ready row is scored:

```text
score = (blocks + 1) × the task's priority weight × the roadmap weight of its target
```

`blocks` is how many open tasks transitively wait on this one. Priority weights are `high` 3,
`normal` 2, `low` 1. An ordinary target — normal priority, blocking no other target — weighs exactly
`1`, so a task with no target is never penalised for having none.

Two rows from the same graph:

```json
[
  { "id": "order-schema", "priority": "normal", "blocks": 1, "score": 4 },
  { "id": "flaky-login", "priority": "high", "blocks": 0, "score": 3 }
]
```

A normal task that unblocks one other task outranks a lone high-priority task. Reach and urgency
multiply; neither overrides the other.

Ties break on `blocks`, then on id. One thing does not participate in the arithmetic at all: a row
whose `roadmap.waiting` is true sorts below **every** row whose roadmap standing is clear, however
high it scores.

## To move one task up

```bash
tasks-mcp edit flaky-login --priority high
```

That triples its weight. To put it back:

```bash
tasks-mcp edit flaky-login --priority normal
```

Setting a field to its default drops its GitHub label too, since absence already means the default.
`--clear priority` removes the field outright and has the same effect on the ranking.

## To move a whole target's work up

Rank the roadmap row instead of the tasks under it:

```bash
tasks-mcp edit csv-export --priority high
```

Every task naming `csv-export` now carries a roadmap weight of 3 instead of 1. This is usually the
edit you want: it says the _outcome_ matters more, and it survives tasks being added and closed
underneath.

A target that other targets wait on lifts its work the same way — `roadmap.blocks` feeds the weight,
so a row that gates two releases outweighs one that gates none, without anyone setting a priority.

## To hold a whole target's work back until something ships first

Give the target a dependency on the target that must ship first:

```bash
tasks-mcp edit csv-export --deps order-sync
```

While `order-sync` is open, every task under `csv-export` sorts below every task whose roadmap row is
clear. `roadmap` shows it as `waitingOn`:

```console
$ tasks-mcp roadmap
```

Sequencing between targets belongs here, one altitude up. A task's own `deps` may not reach outside
its target, and `add_task` and `edit_task` refuse one that does.

## To take a task out of the queue without deleting it

```bash
tasks-mcp edit export-endpoint --spec drafting
```

Only `spec: settled` is buildable, so the task leaves `list_ready` and appears in `list_planning`
instead. `tasks-mcp edit export-endpoint --spec settled` puts it back.

## To make one task wait for another

```bash
tasks-mcp edit export-endpoint --deps order-schema
```

`--deps` replaces the list; pass every dependency you want, comma separated. A task with an open
dependency is not ready at all, whatever its priority — priority orders the work that _can_ start.

Check the effect from the other end:

```console
$ tasks-mcp prereqs export-endpoint
[
  [
    "order-schema"
  ]
]
```

## To find what is worth unblocking first

```bash
tasks-mcp blockers
```

Open tasks ranked by how much of the plan transitively waits on them, biggest bottleneck first. Each
entry carries `blocked` (what it holds up) and, over MCP, `highPriorityBlocked` and `unblockedBy` —
what has to happen before you can even start on the blocker itself.

## To split the queue between two workers

Pass a lane. Only tasks whose folders touch it are listed:

```jsonc
// list_ready { "project": "/abs/repo", "scope": ["src/orders"] }
```

Folder containment counts either way, so a lane drawn at `src` covers a task scoped `src/orders`, and
a lane drawn at `src/orders` includes a task scoped `src`. Matching is segment-wise, so `src/orders`
never matches `src/orders-legacy`. A task with no scope is in every lane, because it declares no files
to exclude it on.

Before dispatching a row, read its `overlap`: the ids of tasks being worked right now whose scope
touches that row's, computed across **all** lanes — a claim in another lane is exactly the collision a
lane filter would otherwise hide. Normally empty. Non-empty means two workers would be over the same
folders.

Lanes are a filter on the MCP tool only; the CLI's `ready` has no `--scope`.

## Related

- [About the two altitudes](explanation-two-altitudes.md) — why the roadmap ranks the work below it.
- [MCP tool reference](reference-mcp-tools.md#list_ready) — the full ready row, lane rules, and sort
  order.
