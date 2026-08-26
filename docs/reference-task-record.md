# Task record reference

The fields a record carries, their value domains, and where each one lives on GitHub. Generated from
`src/core/types.ts` and `src/core/providers/github.ts` for version 0.21.0.

One record type covers both altitudes. A record whose `type` is `target` is a roadmap row; anything
else is a task. See [About the two altitudes](explanation-two-altitudes.md).

## Fields

| Field             | Type       | Default    | Meaning                                                                      |
| ----------------- | ---------- | ---------- | ---------------------------------------------------------------------------- |
| `id`              | `string`   | —          | Stable key, unique within a project. Survives title edits. Never editable.   |
| `title`           | `string`   | `""`       | One-line summary. Becomes the issue title.                                   |
| `type`            | `string`   | `task`     | `task` or `target`.                                                          |
| `status`          | `string`   | `open`     | `open`, `in_progress`, or `done`.                                            |
| `deps`            | `string[]` | `[]`       | Ids this record waits on.                                                    |
| `scope`           | `string[]` | `[]`       | Folders the task may edit. Folders, not files.                               |
| `target`          | `string`   | absent     | The roadmap target this record serves.                                       |
| `kind`            | `string`   | absent     | Free-text classifier — `feature`, `bug`, `chore`, or your own.               |
| `tags`            | `string[]` | absent     | Plain GitHub labels, verbatim, with no `field:` prefix.                      |
| `brief`           | `string`   | absent     | The build brief: the problem and the expected solution.                      |
| `contract`        | `string`   | absent     | The done-condition — what the work has to account for.                       |
| `tier`            | `number`   | `3`        | `1`, `2`, `3`, or `4`; how much model the work needs.                        |
| `qa`              | `string`   | `subagent` | `skip`, `inline`, or `subagent`; how much review the work earns.             |
| `priority`        | `string`   | `normal`   | `high`, `normal`, or `low`.                                                  |
| `spec`            | `string`   | `settled`  | `drafting`, `settled`, or `replan`; the planning lifecycle.                  |
| `stage`           | `string`   | absent     | Narrative label on a staged deliverable.                                     |
| `attempts`        | `object[]` | absent     | Roads already closed: `{ tried, killed_by }`, appended when a build replans. |
| `discovered_from` | `string`   | absent     | The parent task a discovered task was split from.                            |

Absence and the default are the same fact. `tierOf` reads an absent `tier` as 3, an absent `spec`
counts as settled, a record with no `type` is a task. Nothing writes a default value where absence
already says it.

An out-of-domain value throws rather than being coerced, naming the record and the valid set — for
example `unknown qa 'thorough' on task api (qa: skip, inline, subagent)`.

`deps`, `scope`, `tags`, and `clear` accept either a string array or a comma-separated string on every
authoring surface. Whitespace around each part is trimmed and empty parts are dropped.

## Target constraints

A target may not carry `scope`, `contract`, `tier`, `qa`, `stage`, or `discovered_from`, and may not
name a `target` of its own. An empty list does not count as carrying one.

A target needs a non-blank `title` and a non-blank `brief`. That is checked when a target is created or
promoted, never on a later edit, so a row filed before the rule can still be closed.

A task's `deps` must stay inside its own target. A dep pointing at another target's task, or at a
target directly, is refused on `add_task` and on an `edit_task` that rewrites `deps` or `target`.
`sync` stays tolerant: it records what GitHub already says.

## Readiness

A record is offered by `list_ready` when all four hold:

| Condition              | Detail                                 |
| ---------------------- | -------------------------------------- |
| `status` is `open`     | `in_progress` and `done` are excluded. |
| `type` is not `target` | A roadmap row is never dispatched.     |
| `spec` is `settled`    | Absent counts as settled.              |
| every dep is `done`    | Measured across the whole graph.       |

`list_planning` takes the mirror: `status` is `open` and `spec` is not `settled`. Targets are included
there, because a roadmap row still being drafted is exactly what planning owns. It leads with the
`replan` records — the ones a build handed back — before the ones that were never specced.

## Where each field lives on GitHub

| Home                                     | Fields                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Issue title                              | `title`                                                                           |
| Issue state, open or closed              | `status` — closed means `done`                                                    |
| Sub-issue edge (the issue's parent)      | `target`                                                                          |
| Hidden YAML block at the top of the body | `id`, `type`, `deps`, `scope`, `brief`, `contract`, `attempts`, `discovered_from` |
| `field:value` labels                     | `type`, `kind`, `tier`, `qa`, `spec`, `stage`, `priority`, `status`               |
| Plain labels                             | `tags`                                                                            |
| Issue comment thread                     | the [trail](explanation-trails.md)                                                |

`type` rides both the block and its label, because with the label sync off a target that round-tripped
as a plain task would be offered to `list_ready` and dispatched as a build.

Labels win over a legacy body block that still carries those fields.

### The hidden block

```text
<!-- outputty:task
id: export-endpoint
deps:
  - order-schema
scope:
  - src/api
brief: >-
  Finance downloads the file instead of asking support for it.
-->
```

An issue is managed if and only if its body carries this block. `id` leads. The block's text escapes
`-->` as `--&gt;` on write and restores it on read, so a brief containing a mermaid arrow does not
close the HTML comment at its first arrow. The terminator is a `-->` alone on its line; a body written
before the escaping still reads back whole, and a hand-written one-line block is still found.

### The visible body

Below the block, between `<!-- outputty:spec -->` and `<!-- /outputty:spec -->`, the body renders the
brief and then a **What to account for** section holding the contract. That region is regenerated on
every write and never read back. Prose a person adds below it is preserved across updates.

### Which labels get written

A label is written only when its value is not the field's default:

| Field      | Label written when                       | Example              |
| ---------- | ---------------------------------------- | -------------------- |
| `type`     | the value is not `task`                  | `type:target`        |
| `tier`     | the value is not `3`                     | `tier:1`             |
| `qa`       | the value is not `subagent`              | `qa:inline`          |
| `spec`     | the value is not `settled`               | `spec:drafting`      |
| `priority` | the value is not `normal`                | `priority:high`      |
| `status`   | the value is `in_progress`               | `status:in_progress` |
| `kind`     | the field is set — free text, no default | `kind:bug`           |
| `stage`    | the field is set — free text, no default | `stage:prototype`    |

`status` is narrower than the others because GitHub's issue state already shows open and closed.

A pull flags an issue wearing a `field:value` label the record would not write — a default-valued one,
or junk the parser dropped — so one plain `sync` cleans a repo that older versions labelled. Narrowing
`labelFields` is not destructive: it stops writing a field's label, it does not strip labels already
there.

A hand-typed junk value such as `tier:banana` is ignored on read, not crashed on. Labels a person adds
in the web UI flow back on every pull as `tags`. A tag shaped like one of the eight field names is
refused on write, because it would read back as that field and vanish.

`labels: false` in the [configuration](reference-configuration.md) leaves labels out of the mutation
entirely: nothing is written and nothing is read as a field.

### The Projects v2 board

Cards are matched to columns by the Status field's option name, lower-cased, first match wins:

| Status        | Column names tried                    |
| ------------- | ------------------------------------- |
| `done`        | `done`, `closed`                      |
| `in_progress` | `in progress`, `in-progress`, `doing` |
| `open`        | `todo`, `to do`, `backlog`            |

A column outside these names is left alone and reads back as no status. The board is best-effort: a
board failure is logged to stderr and the issue write still succeeds.

On a pull, the issue wins for `done` — closing is unambiguous — and otherwise the board wins, so
dragging a card into In Progress in the GitHub UI flows back on the next sync.

## Adopted issues

An issue with no hidden block is adopted by `sync` under the id `gh-<issue number>`, keeping its title,
its state, and its prose. The next write stamps the block onto it. That id is permanent: `id` is the
stable key and no surface renames one.

When two issues carry the same id in their blocks, the oldest is the record, the newer ones are
shadowed, and `sync` counts them in `conflicts`. Nothing is deleted; repairing it is a human call.

## Trail entry

| Field    | Type     | Meaning                                                     |
| -------- | -------- | ----------------------------------------------------------- |
| `note`   | `string` | The comment body. Required, and may not be blank.           |
| `kind`   | `string` | `decision`, `action`, or `note`. Absent on a human comment. |
| `link`   | `string` | A file:line, URL, or commit.                                |
| `author` | `string` | GitHub login. Read-only.                                    |
| `at`     | `string` | ISO 8601. Read-only.                                        |

`kind` and `link` are carried in a hidden `<!-- outputty:trail kind=… link=… -->` marker at the top of
the comment body. A comment written by a person has neither and reads back as a bare note with its
author and timestamp.

## Claim

Held in a local ledger, not on the record. One entry per in-progress task.

| Field               | Type     | Meaning                                        |
| ------------------- | -------- | ---------------------------------------------- |
| `id`                | `string` | The claimed task.                              |
| `claimed_at`        | `string` | ISO 8601; set once, by the first `start_task`. |
| `heartbeat_at`      | `string` | ISO 8601; moved by every later write.          |
| `stale_for_minutes` | `number` | Whole minutes of silence. Only on a stale row. |

`start_task` stamps a claim. Closing a task, or a spec transition that releases it, drops the claim.
`append_trail` on a claimed task moves the heartbeat; on an unclaimed task it does nothing. An
unreadable or half-written ledger reads as empty rather than failing the call.
