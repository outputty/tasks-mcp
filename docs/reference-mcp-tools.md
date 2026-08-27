# MCP tool reference

Every tool the server registers, its arguments, and what it returns. Generated from the zod schemas in
`src/mcp/server.ts` for version 0.21.0.

## Common arguments

Every tool takes these, except [`list_projects`](#list_projects), which asks about the server itself
and takes no `project`. The server has no working directory of its own, so `project` names which one a
call is about; omit it to use the server's `--project-id` default.

| Argument  | Type     | Required | Meaning                                                  |
| --------- | -------- | -------- | -------------------------------------------------------- |
| `project` | `string` | no       | The project id; omit to use the server's `--project-id`. |
| `branch`  | `string` | no       | Branch to scope to; the backend decides its use.         |

Each tool below lists only the arguments it adds. A list argument (`deps`, `scope`, `tags`, `clear`)
accepts either a string array or a comma-separated string.

Every result carries the same JSON twice: `structuredContent` for typed consumers, and the same object
serialized into `content[0].text`.

## The surface

| Tool                              | Answers or does                                | Writes |
| --------------------------------- | ---------------------------------------------- | ------ |
| [`list_ready`](#list_ready)       | which tasks can be worked right now, ranked    | no     |
| [`roadmap`](#roadmap)             | where every target stands, in dependency order | no     |
| [`list_planning`](#list_planning) | which records the planning stage still owns    | no     |
| [`schedule`](#schedule)           | the open plan as dependency-ordered layers     | no     |
| [`list_tasks`](#list_tasks)       | every record, full, open and done              | no     |
| [`list_projects`](#list_projects) | every project the cache holds, with counts     | no     |
| [`get_task`](#get_task)           | one record                                     | no     |
| [`add_task`](#add_task)           | create a task                                  | yes    |
| [`add_target`](#add_target)       | create a roadmap target                        | yes    |
| [`amend_task`](#amend_task)       | widen an open task's scope, set its brief      | yes    |
| [`edit_task`](#edit_task)         | change or clear any field                      | yes    |
| [`start_task`](#start_task)       | mark a task in progress                        | yes    |
| [`close_task`](#close_task)       | mark a task done                               | yes    |
| [`delete_task`](#delete_task)     | permanently delete a task and its issue        | yes    |
| [`get_trail`](#get_trail)         | a task's issue comment thread                  | no     |
| [`append_trail`](#append_trail)   | post one comment on a task's issue             | yes    |
| [`sync`](#sync)                   | reconcile every provider layer, both ways      | yes    |
| [`prereqs`](#prereqs)             | what must be done before this task can start   | no     |
| [`blockers`](#blockers)           | which open tasks hold up the most work         | no     |
| [`get_config`](#get_config)       | the configuration, layer by layer              | no     |
| [`set_config`](#set_config)       | write the global spec or a repo override       | yes    |

Reads are answered from the file layer and never touch the network. The first write, or `sync`,
resolves credentials, repo, labels, and the Projects board once per project.

## Shared result shapes

### Index row

Returned by `list_planning` and `prereqs`.

| Field      | Type       | Meaning                                      |
| ---------- | ---------- | -------------------------------------------- |
| `id`       | `string`   | The task id.                                 |
| `status`   | `string`   | `open`, `in_progress`, or `done`.            |
| `deps`     | `string[]` | Ids this task waits on.                      |
| `summary`  | `string`   | The task's title.                            |
| `tier`     | `number`   | 1–4, defaulted to 3.                         |
| `qa`       | `string`   | `skip`, `inline`, or `subagent`, defaulted.  |
| `priority` | `string`   | `high`, `normal`, or `low`, defaulted.       |
| `target`   | `string`   | The roadmap target served. Absent when none. |

### Ready row

Returned by `list_ready`: an index row plus its rank and its collision report.

| Field     | Type       | Meaning                                                                             |
| --------- | ---------- | ----------------------------------------------------------------------------------- |
| …         | …          | Every index-row field above.                                                        |
| `scope`   | `string[]` | Folders the task may edit.                                                          |
| `tags`    | `string[]` | The issue's plain GitHub labels. Always present; `[]` when the task wears none.     |
| `blocks`  | `number`   | Open tasks that transitively wait on this one. Targets are not counted here.        |
| `score`   | `number`   | `(blocks + 1)` × the task's priority weight × the roadmap weight below.             |
| `overlap` | `string[]` | Ids of in-progress tasks whose scope touches this row's, computed across all lanes. |
| `roadmap` | `object`   | Roadmap standing. Absent when the task serves no target.                            |

`roadmap` carries `target` (string), `priority` (string), `blocks` (number — open targets waiting on
this target), `waiting` (boolean — this target's own deps have not all shipped), and `weight` (number
— the target's priority weight normalized so an ordinary target is exactly `1`, times `blocks + 1`).

Priority weights are `high` 3, `normal` 2, `low` 1.

### Trail entry

Returned by `get_trail` and `append_trail`.

| Field    | Type     | Meaning                                                           |
| -------- | -------- | ----------------------------------------------------------------- |
| `note`   | `string` | The comment body.                                                 |
| `kind`   | `string` | `decision`, `action`, or `note`. Absent on a plain human comment. |
| `link`   | `string` | A file:line, URL, or commit. Absent when not set.                 |
| `author` | `string` | GitHub login of the comment's author.                             |
| `at`     | `string` | ISO 8601 timestamp from GitHub.                                   |

### Claim

Returned inside `list_ready` — one row per in-progress task, every claim, not only the quiet ones.

| Field               | Type     | Meaning                                                                                         |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `id`                | `string` | The claimed task.                                                                               |
| `claimed_at`        | `string` | ISO 8601; when `start_task` took the claim.                                                     |
| `heartbeat_at`      | `string` | ISO 8601; when the holder last wrote.                                                           |
| `stale_for_minutes` | `number` | Whole minutes since the last heartbeat — an age, not a verdict. The reader picks the threshold. |

---

## `list_ready`

The tasks that are open, spec-settled, not a target, and have every dependency done — ranked, best
first. A task marked in progress is not listed.

| Argument | Type                   | Required | Meaning                                              |
| -------- | ---------------------- | -------- | ---------------------------------------------------- |
| `scope`  | `string[]` or `string` | no       | Folders that draw a lane. Omit for every ready task. |

Returns `ids` (`string[]`), `tasks` ([ready rows](#ready-row)), and `claims` ([claims](#claim)).

Lane rules: folder containment counts either way, so `src` covers `src/orders` and `src/orders` sits
inside a lane drawn at `src`. Matching is path-segment-wise, so `src/orders` never matches
`src/orders-legacy`. A task with no scope is in every lane. An empty filter means everything.

`claims` reports every in-progress task's claim with its age; nothing here releases one. It is an age,
not a verdict — a dispatcher sweeping for a dead worker filters it itself,
`claims.filter((c) => c.stale_for_minutes >= threshold)`, with `threshold` its configured
`claimStaleMinutes` (default 15). See
[how to recover work from a dead worker](how-to-recover-work-from-a-dead-worker.md).

```json
{
  "ids": ["order-schema", "flaky-login"],
  "tasks": [
    {
      "id": "order-schema",
      "status": "open",
      "deps": [],
      "summary": "Give an order a stable export shape",
      "tier": 3,
      "qa": "subagent",
      "priority": "normal",
      "target": "csv-export",
      "scope": ["src/orders"],
      "tags": [],
      "blocks": 1,
      "score": 4,
      "overlap": [],
      "roadmap": {
        "target": "csv-export",
        "priority": "normal",
        "blocks": 0,
        "waiting": false,
        "weight": 1
      }
    },
    {
      "id": "flaky-login",
      "status": "open",
      "deps": [],
      "summary": "Fix the flaky login redirect",
      "tier": 3,
      "qa": "subagent",
      "priority": "high",
      "scope": ["src/auth"],
      "tags": ["bug"],
      "blocks": 0,
      "score": 3,
      "overlap": []
    }
  ],
  "claims": []
}
```

`claims` is empty here because both tasks are ready — a task appears in `claims` only while it is in
progress. For a populated example, see
[how to recover work from a dead worker](how-to-recover-work-from-a-dead-worker.md).

Sort order: a row whose `roadmap.waiting` is true sorts below every row whose roadmap standing is
clear; then by `score` descending; then by `blocks` descending; then by id.

## `roadmap`

Every roadmap target, in dependency order, with progress derived from the tasks that name it.

No arguments beyond the common ones.

Returns `targets`, an array of:

| Field       | Type       | Meaning                                                       |
| ----------- | ---------- | ------------------------------------------------------------- |
| `id`        | `string`   | The target id.                                                |
| `summary`   | `string`   | The target's title.                                           |
| `status`    | `string`   | `open`, `in_progress`, or `done`.                             |
| `deps`      | `string[]` | Targets that must ship before this one.                       |
| `priority`  | `string`   | `high`, `normal`, or `low`, defaulted.                        |
| `progress`  | `object`   | `total`, `open`, `in_progress`, `done` — counts of its tasks. |
| `ready`     | `string[]` | This target's tasks that are ready to dispatch.               |
| `waitingOn` | `string[]` | This target's deps that have not shipped.                     |
| `blocks`    | `string[]` | Open targets that transitively wait on this one.              |

`progress.total` counts the tasks pointing at the target, not a promise of completeness. A cycle among
targets falls back to the order the records came in; the cycle error belongs to `schedule`.

## `list_planning`

The records whose spec is `drafting` or `replan`, and whose status is `open`. Targets are included.
Disjoint from `list_ready` by construction.

Ordered `replan` first, then `drafting`; inside each group the records keep the order they came in. A
`replan` is a build that already stalled on an unclear spec, so specifying it again restarts work that
is stopped, while a `drafting` record has never cost anyone a build.

No arguments beyond the common ones.

Returns `ids` (`string[]`) and `tasks` ([index rows](#index-row)).

## `schedule`

The open plan as dependency-ordered layers: everything in layer 1 can start now, layer 2 once layer 1
is done, and so on.

| Argument | Type     | Required | Meaning                                                  |
| -------- | -------- | -------- | -------------------------------------------------------- |
| `target` | `string` | no       | Scope the layers to the tasks this roadmap target holds. |

Returns `layers`, an array of `{ layer: number (1-based), ids: string[], display: string }` where
`display` is the ids joined with `", "`.

Throws `cycle or unmet dependency among: <ids>` on a dependency cycle. With `target` set, `done` is
still seeded from the whole graph, so a shipped dependency outside the target resolves; an unshipped
one throws the same unmet-dependency error, which means the target is not self-contained.

Without `target`, target records appear in the layers alongside tasks, because the filter is on status,
not on type.

## `list_tasks`

Every record the top provider layer holds, full, open and done.

No arguments beyond the common ones.

Returns `ids` (`string[]`) and `tasks` — full [task records](reference-task-record.md).

## `list_projects`

Every project the server's cache directory holds — the one tool that takes **no** `project`, because it
answers about the server itself rather than one project. Read-only and local: it never touches a
provider or the network.

No arguments (not even the common `project`).

Returns `projects`, an array sorted by `project` of:

| Field         | Type     | Meaning                                                                     |
| ------------- | -------- | --------------------------------------------------------------------------- |
| `project`     | `string` | The project id.                                                             |
| `tasks`       | `number` | Total records the project holds, targets included.                          |
| `open`        | `number` | Records with status `open`.                                                 |
| `in_progress` | `number` | Records with status `in_progress`.                                          |
| `done`        | `number` | Records with status `done`.                                                 |
| `updated_at`  | `string` | ISO 8601 mtime of the cache file — when the CACHE last changed, not GitHub. |

`tasks` equals `open + in_progress + done`. `updated_at` is the cache file's mtime, so a project edited
only on GitHub reads an older stamp until the next `sync`. An unparseable or non-project file in the
cache directory is skipped, so one bad file never takes the listing down; an empty cache directory
returns `{ "projects": [] }`.

Each cache file declares its own project id. A file written before that — a **pre-identity orphan**, left
behind by an id change — has no declared id and is **skipped**, so a dead file never lists as a phantom
project. It is only skipped, never touched on disk: to bring a project back, run `sync` for it (which
rewrites the file with its id) or delete the old file.

```json
{
  "projects": [
    {
      "project": "outputty/tasks-mcp",
      "tasks": 3,
      "open": 1,
      "in_progress": 1,
      "done": 1,
      "updated_at": "2026-08-26T19:12:32.494Z"
    }
  ]
}
```

## `get_task`

| Argument | Type     | Required | Meaning      |
| -------- | -------- | -------- | ------------ |
| `id`     | `string` | yes      | The task id. |

Returns `task`: the full [task record](reference-task-record.md), or `null` when no record carries
that id.

## `add_task`

Create a task. Fails if the id already exists.

| Argument          | Type                   | Required | Meaning                                             |
| ----------------- | ---------------------- | -------- | --------------------------------------------------- |
| `id`              | `string`               | yes      | Stable unique id.                                   |
| `title`           | `string`               | no       | One-line summary.                                   |
| `deps`            | `string[]` or `string` | no       | Ids this task waits on.                             |
| `scope`           | `string[]` or `string` | no       | Folders the task may edit.                          |
| `brief`           | `string`               | no       | The build brief: what it builds toward.             |
| `contract`        | `string`               | no       | The done-condition.                                 |
| `tier`            | `number`               | no       | 1–4. Default 3.                                     |
| `qa`              | `string`               | no       | `skip`, `inline`, `subagent`. Default `subagent`.   |
| `priority`        | `string`               | no       | `high`, `normal`, `low`. Default `normal`.          |
| `spec`            | `string`               | no       | `drafting`, `settled`, `replan`. Default `settled`. |
| `stage`           | `string`               | no       | Narrative label on a staged deliverable.            |
| `kind`            | `string`               | no       | Free-text classifier.                               |
| `tags`            | `string[]` or `string` | no       | Plain GitHub labels, verbatim. Replaces the list.   |
| `target`          | `string`               | no       | The roadmap target this serves. Must already exist. |
| `discovered_from` | `string`               | no       | Parent task, when split out mid-build.              |

Returns `task`: the created record.

Refusals: an existing id (`task <id> already exists`); a `target` that does not exist
(`no target <id>`) or that is a task (`<id> is a task, not a target`); a `dep` that belongs to a
different target or is itself a target (`a target is self-contained`); a tag shaped like one of the
`field:value` labels (`tag tier:2 shadows a task field`).

Writes fan down every layer: the file cache, then the issue, its labels, its board card, and the
sub-issue edge to its target's issue.

## `add_target`

Create a roadmap target — the row a set of tasks serves. A target is never offered by `list_ready` and
is never built.

| Argument   | Type                   | Required | Meaning                                                    |
| ---------- | ---------------------- | -------- | ---------------------------------------------------------- |
| `id`       | `string`               | yes      | Stable unique id.                                          |
| `title`    | `string`               | yes      | The target, nameable in one sentence.                      |
| `brief`    | `string`               | yes      | The why: what makes this worth building, and now.          |
| `deps`     | `string[]` or `string` | no       | Targets that must ship before this one.                    |
| `priority` | `string`               | no       | `high`, `normal`, `low`. Multiplies the rank of its tasks. |
| `spec`     | `string`               | no       | `drafting`, `settled`, `replan`.                           |
| `kind`     | `string`               | no       | Free-text classifier.                                      |
| `tags`     | `string[]` or `string` | no       | Plain GitHub labels, verbatim.                             |

Returns `task`: the created record, carrying `type: "target"`.

A target may not carry `scope`, `contract`, `tier`, `qa`, `stage`, or `discovered_from`, and may not
name a `target` of its own. Those arguments are absent from the schema; a record that acquires one
another way is refused with `target <id> cannot carry <fields> — a target is never built`.

An empty `title` or `brief` is refused: `target <id> needs a title`, `target <id> needs a brief`.

On GitHub a target is an issue whose sub-issues are the tasks that name it.

## `amend_task`

Widen an open task's scope, set its brief, or both. Only ever adds scope.

| Argument | Type                   | Required | Meaning                      |
| -------- | ---------------------- | -------- | ---------------------------- |
| `id`     | `string`               | yes      | The task id.                 |
| `scope`  | `string[]` or `string` | no       | Folders to add to the scope. |
| `brief`  | `string`               | no       | Replacement brief.           |

Returns `task`: the updated record.

Refuses a done task (`task <id> is done — amend orphans committed work`), a scope the task already
covers (`task <id> already covers that scope`), and a call carrying neither argument
(`amend needs scope or brief`). To narrow a scope or remove a field, use `edit_task`.

## `edit_task`

Change any field of a record. Only the fields passed change; `id` is fixed.

| Argument   | Type                   | Required | Meaning                                                      |
| ---------- | ---------------------- | -------- | ------------------------------------------------------------ |
| `id`       | `string`               | yes      | The task id, unchanged.                                      |
| `title`    | `string`               | no       | One-line summary.                                            |
| `deps`     | `string[]` or `string` | no       | Replaces the list.                                           |
| `scope`    | `string[]` or `string` | no       | Replaces the list.                                           |
| `brief`    | `string`               | no       | The build brief.                                             |
| `contract` | `string`               | no       | The done-condition.                                          |
| `tier`     | `number`               | no       | 1–4.                                                         |
| `qa`       | `string`               | no       | `skip`, `inline`, `subagent`.                                |
| `priority` | `string`               | no       | `high`, `normal`, `low`.                                     |
| `spec`     | `string`               | no       | `drafting`, `settled`, `replan`.                             |
| `stage`    | `string`               | no       | Narrative label on a staged deliverable.                     |
| `kind`     | `string`               | no       | Free-text classifier.                                        |
| `tags`     | `string[]` or `string` | no       | Plain GitHub labels. Replaces the list.                      |
| `target`   | `string`               | no       | Move under a different roadmap target; re-parents its issue. |
| `type`     | `string`               | no       | `task` or `target`.                                          |
| `clear`    | `string[]` or `string` | no       | Fields to remove outright.                                   |

Returns `task`: the updated record.

`clear` accepts exactly these names: `type`, `target`, `kind`, `brief`, `contract`, `tier`, `qa`,
`priority`, `spec`, `stage`, `discovered_from`, `deps`, `scope`, `tags`. Clearing a list empties it to
`[]`; clearing a scalar removes the key. Any other name is refused with
`cannot clear <name> (clearable: …)`.

Clearing is the only way a `field:value` label comes off an issue without opening the GitHub UI.
Setting a field back to its default (tier 3, qa subagent, priority normal, spec settled) also drops
its label, since absence already means the default.

Two edits release a claimed record back to a queue: setting `spec` to `replan`, and moving `spec` from
an unsettled state to `settled`. Both set `status` back to `open`. See
[About claims](explanation-claims.md).

Promoting a record with `type: "target"` demands a title and a brief and refuses the build fields;
clear `scope`, `contract`, `tier`, `qa`, `stage` first.

A call that changes nothing is refused with `edit needs at least one field to change`.

## `start_task`

Mark a task in progress. It leaves `list_ready`, its issue stays open and wears `status:in_progress`,
and its board card moves to In Progress.

| Argument | Type     | Required | Meaning                    |
| -------- | -------- | -------- | -------------------------- |
| `id`     | `string` | yes      | The task id being started. |

Returns `task`: the updated record.

Stamps a claim in the local ledger: `claimed_at` and `heartbeat_at` on a first claim, `heartbeat_at`
alone on a repeat. Closing the task, or a spec transition that releases it, drops the claim.

## `close_task`

Mark a task done. Closes its issue and moves its board card.

| Argument | Type     | Required | Meaning      |
| -------- | -------- | -------- | ------------ |
| `id`     | `string` | yes      | The task id. |

Returns `{ "closed": "<id>" }`. Releases any claim on the task.

## `delete_task`

Permanently delete a record and its GitHub issue from every layer, deepest first.

| Argument | Type     | Required | Meaning                |
| -------- | -------- | -------- | ---------------------- |
| `id`     | `string` | yes      | The task id to delete. |

Returns `{ "deleted": "<id>" }`.

Needs the token's delete-issue permission (repo admin or triage); a normal token cannot. Deepest-first
order means a remote that refuses throws before the local cache is touched. Deleting a target that
still holds tasks is refused: `target <id> still holds <ids> — retarget or delete those first`.

Irreversible. To mark a task done, use `close_task`.

## `get_trail`

A task's GitHub issue comment thread, every comment an entry, oldest first.

| Argument | Type     | Required | Meaning      |
| -------- | -------- | -------- | ------------ |
| `id`     | `string` | yes      | The task id. |

Returns `trail`: an array of [trail entries](#trail-entry). Empty when the task has no issue yet.

A project with no GitHub-backed layer throws `trails need a GitHub-backed project`.

## `append_trail`

Post one comment on a task's GitHub issue and return the whole thread.

| Argument | Type     | Required | Meaning                                        |
| -------- | -------- | -------- | ---------------------------------------------- |
| `id`     | `string` | yes      | The task id.                                   |
| `note`   | `string` | yes      | The comment body.                              |
| `kind`   | `string` | no       | `decision`, `action`, or `note`.               |
| `link`   | `string` | no       | Where it landed — a file:line, URL, or commit. |

Returns `trail`: an array of [trail entries](#trail-entry).

`kind` and `link` ride a hidden HTML-comment marker at the top of the comment body, so the comment
still renders as plain text on GitHub.

Refusals: a task with no issue (`no task <id> on GitHub — sync it before adding a trail entry`); a
blank note (`a trail entry needs a note`); an unknown kind.

The write also refreshes the task's claim heartbeat, if it holds one. A note on an unclaimed task never
creates a claim.

## `sync`

Reconcile the repo with every provider layer, both ways.

No arguments beyond the common ones.

| Field       | Type     | Meaning                                        |
| ----------- | -------- | ---------------------------------------------- |
| `pulled`    | `number` | Records in the merged result.                  |
| `pushed`    | `number` | Writes into layers below the top one.          |
| `conflicts` | `number` | Task ids claimed by more than one remote item. |

Every layer is pulled, the results merged with the deepest layer winning any disagreement, then the
merged truth pushed back into each layer that lacks a record, flagged one, or disagrees. A hand-opened
issue is adopted with the id `gh-<number>` and stamped with the hidden block. Absence is never a
deletion. See [About the provider stack](explanation-the-provider-stack.md).

## `prereqs`

What has to be done before work on this task can start.

| Argument | Type     | Required | Meaning                     |
| -------- | -------- | -------- | --------------------------- |
| `id`     | `string` | yes      | The task you want to start. |

| Field       | Type         | Meaning                                                       |
| ----------- | ------------ | ------------------------------------------------------------- |
| `id`        | `string`     | The task asked about.                                         |
| `startable` | `boolean`    | True when nothing is in the way.                              |
| `order`     | `string[][]` | Open prerequisites as dependency-ordered layers.              |
| `tasks`     | rows         | The same tasks as [index rows](#index-row), layers flattened. |

Traversal is pruned at done tasks: a finished dependency ends the chain, so nothing behind it is
listed. An unknown id throws `no task <id>`.

## `blockers`

The open tasks ranked by how much of the plan transitively waits on them.

| Argument | Type     | Required | Meaning                 |
| -------- | -------- | -------- | ----------------------- |
| `limit`  | `number` | no       | Max entries. Default 5. |

Returns `blockers`, an array of:

| Field                 | Type         | Meaning                                          |
| --------------------- | ------------ | ------------------------------------------------ |
| `id`                  | `string`     | The blocking task.                               |
| `summary`             | `string`     | Its title.                                       |
| `priority`            | `string`     | `high`, `normal`, or `low`.                      |
| `blocks`              | `number`     | How many open tasks transitively wait on it.     |
| `blocked`             | `string[]`   | Their ids.                                       |
| `highPriorityBlocked` | `string[]`   | The high-priority subset.                        |
| `unblockedBy`         | `string[][]` | What must happen before it can start, in layers. |

Sorted by `blocks` descending, then priority, then id. A task being worked still blocks everything
behind it, so `in_progress` tasks are ranked. A task that blocks nothing is not listed.

## `get_config`

The configuration for a project, layer by layer.

No arguments beyond the common ones.

Returns `flags`, `global`, `repo`, and `effective` — each a
[configuration object](reference-configuration.md#the-settings).

## `set_config`

Merge settings into the global spec or one repo's override.

| Argument | Type     | Required | Meaning                                                           |
| -------- | -------- | -------- | ----------------------------------------------------------------- |
| `scope`  | `string` | yes      | `global` (every repo) or `repo` (this repo only).                 |
| `config` | `object` | yes      | The [settings](reference-configuration.md#the-settings) to merge. |

Returns `{ "effective": { … } }`: the new effective configuration for this project.

The object is parsed with zod in strict mode. An unknown key or a mistyped value throws
`invalid config set_config(<scope>) — <key>: <message>` and nothing is written.
