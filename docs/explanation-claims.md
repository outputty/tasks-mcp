# About claims

Why picking work up marks it in the graph, why a claim that has gone quiet is reported rather than
freed, and why the ledger is a local file instead of a task field.

## The race a claim prevents

Two workers reading the same queue will take the same task. There is no cleverness that avoids this if
the queue is a pure read: both call `list_ready`, both see the same first row, both start building it,
and the second one discovers the collision when it hits a merge conflict.

`start_task` closes that by moving the task to `in_progress`, which takes it out of `list_ready`. The
in-flight set therefore lives in the graph, not in any dispatcher's memory. That matters more than it
sounds: it means a second dispatcher, a restarted dispatcher, or a human running the CLI all see the
same picture, and `list_ready` is safe to dispatch straight from without any coordination between the
readers.

The alternative — a dispatcher tracking what it started — works exactly until there is more than one
dispatcher, or until the one you have restarts.

## The failure it creates

A claim is right while the worker lives and wrong the moment it dies. The task stays `in_progress`,
the queue is one task narrower, and nothing distinguishes "someone is grinding through it" from "the
terminal was closed last night". Left alone, the graph slowly loses tasks to workers that no longer
exist.

The earlier answer to this lived outside the server: an orchestrator cross-referenced claims against
the panes it had started. That cannot survive workers that are background agents with no pane to
enumerate, and it made the detector the property of one particular orchestrator rather than of the
graph.

So liveness moved onto the claim itself. A claim carries two stamps: when it was taken, and when it
was last heard from. A claim nobody has refreshed inside the threshold — 15 minutes by default — is
reported in `stale_claims`, on the same `list_ready` call that returns the queue.

## Why the heartbeat is not a separate call

Nothing has to be called to keep a claim alive. Every write the holder makes through the server moves
the beat, and `append_trail` is the one a build already makes once per layer.

A heartbeat that has to be remembered is a heartbeat that gets forgotten, and a heartbeat call that a
worker makes on a timer proves the timer is alive, not that the work is. Tying it to the writes a
working worker already performs means the signal is a by-product of working. A worker that records
nothing for an hour genuinely does look like a dead one, and treating it as suspicious is correct.

The mirror of this: a trail note on a task nobody claimed never invents a claim. Commenting on an open
issue says nothing about anyone building it.

## Why staleness is a report, not a release

This is the design decision people push back on, so it is worth stating plainly: **nothing in the
package ever releases a claim automatically.**

`stale_for_minutes` means _quiet_, not _dead_. Fifteen minutes is tuned to a build that writes a note
per layer, and a layer that takes an hour is ordinary work, not a crash. If the server freed a claim
on crossing the threshold, it would sometimes free one out from under a worker that was merely slow —
and a second worker on live work is precisely the race `start_task` exists to prevent. Auto-release
would trade a visible, recoverable problem for an invisible, destructive one.

So the threshold flags, and a person or an orchestrator decides. Recovery is two deliberate edits:
`spec: replan` hands the task back and returns it to `open`, and settling it again returns it to the
build queue. See
[how to recover work from a dead worker](how-to-recover-work-from-a-dead-worker.md).

## Why the release fires on a transition, not a state

Two edits hand a claimed item back: sending it to `replan`, and moving it from an unsettled spec to
`settled`.

The second one exists because a planning session claims the item it is specifying, so that a second
planning session picks a different one. Settling is the handoff, and it has to hand the claim back
too — otherwise a settled item still marked in progress reaches no queue at all. `list_ready` wants an
open task; `list_planning` wants an unsettled one; the item sits in the gap between them until someone
notices by hand.

But it fires on the **transition** from unsettled to settled, never on the state. A build's own task is
settled _and_ in progress for its entire run. Releasing on that state would put a second worker onto
live work every time anything edited the task.

## Why the ledger is a local file

Claims live in `<cacheDir>/claims/<id>.json`, not on the task record.

A field on the record would mean a heartbeat per layer rewrites the GitHub issue body on every beat.
That is a lot of API traffic, a lot of noise on the issue, and a lot of sync churn, all to record
something that is not project truth: the liveness of a local process is a fact about this machine, not
about the work.

The ledger is keyed on the **project id**, like every other store. A build agent frequently claims from
inside a git worktree while the dispatcher sweeps from the primary checkout; they resolve to one ledger
because they share one supplied id — the `--project-id` in the repo's checked-in `.mcp.json` — not
because of any git resolution of a worktree back to its primary checkout. (Earlier the ledger was keyed
on the repository via `git rev-parse --git-common-dir` while task caches were keyed per path, so a
worktree shared a ledger but not a cache; the supplied id collapses both onto one key.)

An unreadable or half-written ledger reads as empty. Losing it costs the staleness signal, and it must
never take down the tool call that touched it. Note the asymmetry that follows: deleting the ledger
does not free anything, because `status: in_progress` lives in the graph. You lose the report and keep
the problem.

## The advisory signal beside it

`overlap` on each ready row lists the tasks being worked right now whose `scope` touches that row's,
computed across every lane. It is not a claim and it does not block anything — the dispatcher decides.

It is advisory on purpose. A hard refusal would also block re-dispatching a task after recovering it
from a stale claim, which is the one moment you most want to dispatch it.

## Related

- [Task record reference](reference-task-record.md#claim) — the claim's exact fields.
- [MCP tool reference](reference-mcp-tools.md#list_ready) — where `stale_claims` is reported.
