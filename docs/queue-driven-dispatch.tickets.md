# Queue-driven dispatch - server tickets

The claude-plugin is deleting its master orchestrator pane: the queue becomes the coordinator, an
attended dispatcher session wave-dispatches unattended background build children, and children close or
refile their own tickets. These four tickets are the server's share of that design. The full ticket set,
the dependency graph, and the design rationale live in the plugin repo:
[claude-plugin/docs/queue-driven-dispatch.tickets.md](https://github.com/outputty/claude-plugin/blob/main/docs/queue-driven-dispatch.tickets.md).

Cross-repo ordering: **`mcp-claim-heartbeat` and `mcp-lane-filter` merge before the plugin's
`start-dispatcher` dispatches anything, and `mcp-delete-channel` merges last** - it removes `notify`,
which older plugin versions still call, so it ships as a major or clearly-flagged minor.

### `mcp-claim-heartbeat` - a claim carries a heartbeat, and staleness is queryable

`{ id: "mcp-claim-heartbeat", scope: ["src"], deps: [] }`

#### Brief

## Problem

`start_task` claims a task, and `list_ready` excludes claimed work by design. The only crash detector is
outside the server: "a task stuck at `in_progress` with no pane behind it is a crashed child"
(claude-plugin `skills/orchestrate/SKILL.md:156`), checkable only because every child used to be a Herdr
pane a master session could enumerate. Queue-driven dispatch deletes that pane, and a background agent
never has a pane - so the predicate returns true for every healthy worker and the detector is
un-implementable. A claim held by a dead process then narrows `list_ready` silently and forever: the
queue shrinks and nothing distinguishes "progressing" from "died last night".

## Expected solution

The claim itself carries liveness, refreshed by writes the build already makes (one trail note per
layer), so no client changes its call pattern.

```text
start_task  { project, id }                      -> claim stamped with claimed_at + heartbeat_at
append_trail / close_task / edit_task (by claim holder) -> heartbeat_at refreshed as a side effect
list_ready  { project }                          -> stale claims surface instead of hiding
edit_task   { project, id, spec: "replan" }      -> releases the claim (existing behaviour, unchanged)
```

Input - a claim goes quiet:

```json
{ "id": "csv-export", "status": "in_progress", "heartbeat_at": "2026-08-23T02:14:00Z" }
```

Output shape - `list_ready` 20 minutes later:

```json
{
  "ready": [],
  "stale_claims": [
    { "id": "csv-export", "claimed_at": "<iso>", "heartbeat_at": "<iso>", "stale_for_minutes": 20 }
  ]
}
```

- **Sibling:** `start_task`'s existing claim write - the field lands beside it.
- **Architecture:** no new seams - two timestamps on the claim record, one derived list in `list_ready`.
- **Where:** the server's task-store module (`src`).
- **Anchor:** claude-plugin `skills/orchestrate/SKILL.md:156` (the detector being replaced);
  `skills/build/SKILL.md:18` (claim is the build's first call).

#### Contract

## Definition of done

1. `append_trail` refreshes the heartbeat: claim a task, append one trail entry (the `examples.md`
   trail example, verbatim - `kind: "decision"`, the streaming note), read the task -> `heartbeat_at`
   is newer than `claimed_at`.
2. A claim with no heartbeat for longer than the threshold appears in `list_ready`'s `stale_claims`
   with its age; a fresh claim never does.
3. `edit_task { spec: "replan" }` on a stale claim releases it and the task returns to `ready` - the
   existing release path, proven still to work against the new fields.
4. No new tool: `tools/list` gains nothing. Heartbeat is a side effect of existing writes only.

## Constraints to respect

- **Refresh must piggyback existing writes**, never a new required call - a bespoke heartbeat tool would
  change the build skill and every live session for a liveness ping the trail write already implies.
- **Threshold default 15 minutes, overridable per project** - a build writes one trail note per layer
  and a layer under an hour is normal, so the flag must say "quiet", not "slow": flag, never auto-release.
  Auto-release would let two children claim one task, the exact race `start_task` exists to prevent.
- **The sweep consumer is the dispatcher's 1-minute tick** (claude-plugin `start-dispatcher`), so the
  staleness computation runs on read, not on a server timer - the server stays a passive store.

## Open questions

- (none - the shape is settled; the threshold number is the builder's to default and expose)

---

### `mcp-lane-filter` - `list_ready` takes a scope filter

`{ id: "mcp-lane-filter", scope: ["src"], deps: [] }`

#### Brief

## Problem

A dispatcher session owns a _lane_: a scope subtree it may build in, so two concurrent dispatchers never
write the same files. `list_ready` today returns everything ready repo-wide, so a lane dispatcher must
filter by hand from prose, and a mis-drawn lane (a ready task whose scope crosses another lane's live
claim) is invisible until the merge conflicts. Cross-agent PR pairs conflict at roughly twice the rate
of single-agent ones, so the lane boundary is the load-bearing safety property of the whole design -
it deserves a query, not a convention.

## Expected solution

```text
list_ready { project, scope: ["skills"] }
```

Input - the `examples.md` task (`scope: ["src/orders"]`) is ready.

Output shape:

```json
{ "ready": [{ "id": "csv-export", "scope": ["src/orders"], "overlap": [] }] }
```

for `scope: ["src/orders"]`, and `{ "ready": [] }` for `scope: ["docs"]`. Every returned task carries
`overlap`: the ids of live claims whose scope intersects this task's scope - normally empty, and a
non-empty value is the mis-drawn-lane signal the dispatcher refuses to dispatch on.

- **Sibling:** `list_ready`'s existing ranked filter (it already excludes claimed work).
- **Architecture:** no new seams - one filter parameter, one derived field per row.
- **Where:** the server's ready-ranking module (`src`).
- **Anchor:** claude-plugin `skills/planning/SKILL.md:196-197` (scope is one folder; sharing a folder is normal
  _within_ an item - the filter guards _across_ items).

#### Contract

## Definition of done

1. The `examples.md` `add_task` example, verbatim, then `list_ready { scope: ["src/orders"] }` includes
   `csv-export` and `list_ready { scope: ["docs"] }` excludes it.
2. Scope intersection is prefix-based on folders: filter `["src"]` matches task scope `["src/orders"]`
   and the reverse.
3. With a live claim on scope `["src/orders"]`, a ready task scoped `["src/orders/export"]` returns
   `overlap: ["<claim id>"]`; with no intersecting claim, `overlap: []`.
4. No filter argument -> behaviour unchanged, byte-for-byte, for every existing caller.

## Constraints to respect

- **Filter, never partition** - the server must not learn what a "lane" is. Lanes are a dispatcher
  convention; baking them into the store adds state that goes stale the moment a human redraws one.
- **`overlap` is advisory** - the dispatcher decides; the server only reports. A hard server-side block
  would also block the single-dispatcher case where overlap with your _own_ wave's finished claims is
  routine.

## Open questions

- (none)

---

### `mcp-spike-marker` - a spike is machine-readable in `list_ready`

`{ id: "mcp-spike-marker", scope: ["src"], deps: [] }`

#### Brief

## Problem

Under queue dispatch a build child folds research, planning and building into one unattended session -
_unless_ the ticket is a spike, whose deliverable is a drafted ticket rather than merged code. That
branch is taken by the dispatcher when it writes the child's prompt, so the marker must ride the
`list_ready` row. Today the only candidate carriers are prose in the brief (not a mechanism - nothing
parses it) and `tags` (plain GitHub labels, adopted on every pull).

## Expected solution

A task tagged as a spike surfaces that tag in `list_ready` output:

```text
add_task  { project, id: "spike-csv-shape", title: "...", tags: ["spike"] }
list_ready { project }
```

Output shape:

```json
{ "ready": [{ "id": "spike-csv-shape", "tags": ["spike"], "scope": ["src/orders"] }] }
```

- **Sibling:** the `tags` field on `edit_task` (already sets plain GitHub labels).
- **Architecture:** none - a field surfaced in one read, no new seams.
- **Where:** the server's ready-ranking module (`src`).
- **Anchor:** claude-plugin `skills/init/block.md` tool 15 (`tags` sets plain GitHub labels; every pull adopts them).

#### Contract

## Definition of done

1. A task created with `tags: ["spike"]` returns those tags in its `list_ready` row.
2. A tag added through the GitHub web UI flows back into the row on the next `sync` (the existing
   adoption path, proven against `list_ready`).

## Open questions

- **Settle first:** whether `list_ready` already returns `tags` - if it does, this ticket collapses to
  a conformance test plus one documentation line, and that is the preferred outcome. Verify against the
  server before building anything.

---

### `mcp-delete-channel` - delete the doorbell

`{ id: "mcp-delete-channel", scope: ["src"], deps: ["mcp-claim-heartbeat"] }`

#### Brief

## Problem

The channel exists to wake an idle master pane: `notify { project, note }`, the announce spool behind
it, and the `--dangerously-load-development-channels server:tasks` launch flag every orchestrator
session must carry (claude-plugin `skills/orchestrate/SKILL.md:93-97`). Queue-driven dispatch has no
idle listener. The dispatcher's wave loop re-runs `list_ready` on a one-minute tick, a worker's own
merge is what unblocks the next task (so the dispatcher learns of the change by causing it), and a
child's escalation reaches the dispatcher as its completion report. The channel is dead weight with a
scary launch flag attached, and every mutating write pays the announce fan-out for readers that no
longer exist.

## Expected solution

```text
tools/list -> no `notify`
add_task / close_task / edit_task ... -> no announce emitted, same results otherwise
claude <no channel flag> -> full functionality
```

- **Sibling:** none - a deletion.
- **Architecture:** none - seams removed, none added.
- **Where:** the server's announce/spool module (`src`).
- **Anchor:** claude-plugin `skills/orchestrate/SKILL.md:93-97` (the flag requirement);
  `skills/build/SKILL.md:221` and `skills/planning/SKILL.md:33` (the two remaining ringers, removed by
  the plugin tickets).

#### Contract

## Definition of done

1. `tools/list` contains no `notify`; calling it errors as an unknown tool.
2. Every mutating tool passes its existing conformance suite unchanged with the spool code deleted.
3. A session launched with no channel flag exercises the full tool surface.

## Constraints to respect

- **`mcp-claim-heartbeat` merges first** - the "build abandoned" doorbell ring was the last liveness
  signal a crashed child emitted; the stale-claim sweep replaces it, so the replacement exists before
  the original dies.
- **The plugin still rings it until `delete-orchestrate` merges** - deleting `notify` breaks
  `skills/build/SKILL.md:221` and `skills/planning/SKILL.md:33` in older plugin versions. Ship the
  server change as a major or clearly-flagged minor, and note it in the release line.

## Open questions

- (none)

---
