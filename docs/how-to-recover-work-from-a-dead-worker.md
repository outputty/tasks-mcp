# How to recover work from a dead worker

A worker called `start_task`, then its terminal was closed or its process died. The task is still
marked in progress, so it never appears in `list_ready` again and the queue is quietly one task
narrower. This is how to get it back.

Nothing releases a claim on its own. That is deliberate — see
[About claims](explanation-claims.md) — so recovery is always a decision someone makes.

## Find the stranded work

Over MCP, `list_ready` reports every claim in the same call that gives you the queue — `claims`, one row
per in-progress task, each with a `stale_for_minutes` age:

```jsonc
// list_ready { "project": "/abs/repo" }
{
  "ids": ["export-endpoint"],
  "tasks": [ … ],
  "claims": [
    {
      "id": "flaky-login",
      "claimed_at": "2026-08-27T08:09:20.312Z",
      "heartbeat_at": "2026-08-27T08:09:20.312Z",
      "stale_for_minutes": 22
    }
  ]
}
```

`stale_for_minutes` is an age, not a verdict: the tool reports every claim and leaves the threshold to
you. A dispatcher sweeping for dead workers filters the list itself —

```js
claims.filter((c) => c.stale_for_minutes >= threshold); // threshold = claimStaleMinutes, default 15
```

— so a claim quiet longer than your threshold, like `flaky-login` at 22 minutes above, is the one to
look at.

From the shell there is no `claims` output; the CLI's `ready` prints ids only. Look for the status
instead:

```console
$ tasks-mcp list | grep -A5 in_progress
    "status": "in_progress",
    "deps": [],
    "scope": [],
    "title": "Fix the flaky login redirect",
    "id": "flaky-login",
```

Or read the ledger, one JSON file per project, keyed on the project id:

```bash
ls ~/.cache/tasks-mcp/claims/
cat ~/.cache/tasks-mcp/claims/<project-id>.json
```

## Check the worker is actually gone

`stale_for_minutes` says _quiet_, not _dead_. A build that is grinding through a long layer is quiet
too, and releasing a task under a live worker is exactly the race `start_task` exists to prevent.

Read the trail before you act:

```bash
tasks-mcp trail flaky-login
```

The last entry's `at` is the last thing that worker recorded. If it lines up with `heartbeat_at` and
nothing has moved since, the worker is gone.

## Release it

Two edits, in this order. The first hands the task back; the second returns it to the build queue.

```bash
tasks-mcp edit flaky-login --spec replan
tasks-mcp edit flaky-login --spec settled
```

Over MCP that is `edit_task` twice, with `{ "spec": "replan" }` then `{ "spec": "settled" }`.

Setting `spec` to `replan` sets `status` back to `open` and drops the claim, but a task whose spec is
`replan` belongs to planning, not to the build queue — it appears in `list_planning`, not
`list_ready`. Settling it again moves it across.

One edit is not enough. The release fires on the **transition** from unsettled to settled, not on the
state, because a build's own task is settled _and_ in progress for its whole run — releasing on the
state would put a second worker on live work.

If the work was in fact finished before the worker died, close it instead:

```bash
tasks-mcp close flaky-login
```

Closing also drops the claim.

## Confirm it is back

```console
$ tasks-mcp ready
[
  "flaky-login",
  "export-endpoint"
]
```

## Check nobody else is in those folders

If other workers are running, look at the row's `overlap` in `list_ready` before dispatching it again.
`overlap` lists the ids of tasks being worked right now whose `scope` touches this one's, computed
across every lane. Non-empty means re-dispatching would put two workers over the same folders.

## Tune the threshold

The threshold is yours to pick — the tool reports every claim's age and never filters. Fifteen minutes
is the default a dispatcher sweeps by, tuned to a build that writes a trail note per layer;
`claimStaleMinutes` stores a different one for a dispatcher to read. Raise it if your layers are longer,
so a slow worker is not swept as a dead one:

```jsonc
// set_config
{ "project": "/abs/repo", "scope": "repo", "config": { "claimStaleMinutes": 45 } }
```

`scope: "global"` applies it to every repository instead.

## Make the next one easier to spot

The heartbeat moves on every write the holder makes through the server, and `append_trail` is the one
a build already calls. A worker that records a note per layer keeps its claim visibly alive, and a
worker that stops recording is unambiguous. A worker that writes nothing for an hour looks exactly
like a dead one.

Deleting the ledger file clears the claims but does **not** free the tasks: `status: in_progress` lives
in the graph, not in the ledger. You would lose the staleness signal and keep the problem.

## Related

- [About claims](explanation-claims.md) — why a stale claim is reported rather than released.
- [MCP tool reference](reference-mcp-tools.md#list_ready) — the full `list_ready` result.
