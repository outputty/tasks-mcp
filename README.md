# @outputty/tasks-mcp

A local **MCP server** that gives a coding agent a dependency-aware task tracker. The agent calls typed
tools — `add_task`, `list_ready`, `prereqs`, `blockers`, `roadmap`, `sync` — over a task graph that is mirrored
two-way into GitHub: one issue per task, `field:value` labels for its execution properties, and a
Projects v2 kanban board.

Tasks live in a **stack of provider layers**: a local file on top (every read is instant and offline),
GitHub beneath it as the source of truth. Deleting the local file loses nothing — `sync` rebuilds it.

![tasks-mcp architecture: the provider stack](docs/architecture.svg)

## Install

No clone. Add the server to your project's `.mcp.json` and your MCP client launches it on demand:

```json
{
  "mcpServers": {
    "tasks": { "command": "npx", "args": ["-y", "@outputty/tasks-mcp"] }
  }
}
```

Requirements: **Node ≥ 18** (or bun), a repo with a github.com `origin` remote, and either `gh` logged
in or `GITHUB_TOKEN` set. For the kanban board, grant the token the `project` scope once:
`gh auth refresh -s project` (without it, tasks still land as issues and the board is skipped with a
warning).

## The two questions it answers

The tracker is a dependency graph, and the two questions a graph is FOR each have a dedicated tool.

### "I want to start on task X — what has to be done first?"

```jsonc
// tool: prereqs        { "project": "/abs/repo", "id": "deploy" }
{
  "id": "deploy",
  "startable": false,
  "order": [["schema"], ["api", "infra"]], // finish layer 1, then layer 2, then start deploy
  "tasks": [
    {
      "id": "schema",
      "status": "open",
      "deps": [],
      "summary": "Design the schema",
      "tier": 3,
      "qa": "subagent",
      "priority": "normal",
    },
    {
      "id": "api",
      "status": "open",
      "deps": ["schema"],
      "summary": "Build the API",
      "tier": 2,
      "qa": "inline",
      "priority": "high",
    },
    {
      "id": "infra",
      "status": "open",
      "deps": [],
      "summary": "Provision infra",
      "tier": 3,
      "qa": "subagent",
      "priority": "normal",
    },
  ],
}
```

`startable: true` with an empty `order` means nothing is in the way — start now. Done tasks never
appear: a finished dependency ends the chain.

### "What is the biggest blocker right now?"

```jsonc
// tool: blockers       { "project": "/abs/repo" }
{
  "blockers": [
    {
      "id": "schema", // the single biggest bottleneck: first entry, most waited-on
      "summary": "Design the schema",
      "priority": "normal",
      "blocks": 3, // how many open tasks transitively wait on it
      "blocked": ["api", "ui", "deploy"],
      "highPriorityBlocked": ["ui"], // how it aligns with priorities
      "unblockedBy": [], // the path to it, dependency-ordered (empty: work it now)
    },
    {
      "id": "infra",
      "summary": "Provision infra",
      "priority": "normal",
      "blocks": 1,
      "blocked": ["deploy"],
      "highPriorityBlocked": [],
      "unblockedBy": [],
    },
  ],
}
```

Read it top to bottom: the first entry unblocks the most work; `unblockedBy` is what has to happen to
even get to it; `highPriorityBlocked` shows whether clearing it serves the priorities.

## The tools

Every tool takes `project` — the absolute path to the repo it acts on — because the server has no
working directory of its own. Reads are answered from the local file layer and never touch the
network; the first GitHub-touching call (a write, or `sync`) resolves repo, credentials, labels, and
the board once.

| Tool            | Answers                                                                 | Writes |
| --------------- | ----------------------------------------------------------------------- | ------ |
| `prereqs`       | what must be done before this task can start, in build order            | —      |
| `roadmap`       | where every target stands: progress, what it waits on, what waits on it | —      |
| `blockers`      | which tasks hold up the most work, ranked                               | —      |
| `list_tasks`    | every task, full records — the whole graph                              | —      |
| `list_ready`    | which tasks can be worked now, ranked by task AND roadmap row           | —      |
| `list_planning` | which tasks planning still owns (drafting / replan)                     | —      |
| `schedule`      | the whole open plan as dependency layers; errors on a cycle             | —      |
| `get_task`      | one task's full record                                                  | —      |
| `add_task`      | create a task (file + issue + labels + board card)                      | ✎      |
| `add_target`    | create a roadmap target — a name and a why, no build fields             | ✎      |
| `amend_task`    | widen an open task's scope, or set its brief                            | ✎      |
| `edit_task`     | edit any field, set `tags`, or `clear` a field outright                 | ✎      |
| `start_task`    | mark a task in progress — it leaves `list_ready` while built            | ✎      |
| `close_task`    | mark done (closes the issue, moves the card)                            | ✎      |
| `delete_task`   | permanently delete a task + its issue (needs delete permission)         | ✎      |
| `get_trail`     | a task's trail: its issue comment thread, oldest first                  | —      |
| `append_trail`  | append one entry to a task's trail (posts an issue comment)             | ✎      |
| `sync`          | reconcile every layer both ways; adopt hand-opened issues               | ✎      |

A task carries: `id`, `title`, `status` (open/in_progress/done), `deps`, `scope`, `target`, `tags`,
the execution-modifying properties `tier` (1–4), `qa` (skip/inline/subagent), `priority`
(high/normal/low), `spec`, `stage`, `kind`, and `brief`/`contract` prose. On GitHub, the scalar
properties are worn as **`field:value` labels** (`tier:2`, `priority:high`, `status:in_progress`, …)
— visible, filterable, and editable in the GitHub UI; edit a label there and `sync` pulls the change
back. `tags` are plain labels (`security`, `frontend`) carried verbatim beside them, adopted from the
issue on every pull.

**A label is only written when it says something.** Absence already means the default — `tier` reads
3, `qa` reads subagent, `priority` reads normal, an absent `spec` counts as settled — so a `tier:3`
label would sit on nearly every issue in the repo carrying no information, and none is written. Only
the value GitHub cannot otherwise show earns one. That makes setting a field back to its default the
natural way to drop its label; to remove a field outright, name it in `edit_task`'s `clear`. Labels an
older version already wrote are cleaned by a plain `sync` — a pull flags an issue wearing one, so the
migration needs no edit from anyone.

The issue **body renders a concise summary** — the brief (the
problem and expected solution), then **What to account for** (the contract) — for the web UI,
regenerated on every write, with the machine-readable record kept in a hidden block above it. See
[docs/architecture.md](docs/architecture.md) for the full mapping.

## The roadmap — two altitudes in one graph

A **target** is a roadmap item: it groups the tasks that serve it, it is never dispatched, and its
progress is **derived** from those tasks rather than maintained by anyone.

A target is a **name and a paragraph**, both required — the brief is the _why this is worth building,
and now_, never an implementation spec. If the why cannot be written, it is not a target yet. It
carries no build fields (`scope`, `contract`, `tier`, `qa`, `stage`, `discovered_from`): nothing ever
builds a target, so those would describe work that does not exist. And it cannot serve another target
— the roadmap is one altitude. What it _does_ carry is `deps` — the targets that must **ship** first
— and `priority`, and both rank every task underneath it.

```js
// tool: add_target  { "project": "/abs/repo", "id": "memory-is-derived",
//                     "title": "Product memory stops duplicating the graph",
//                     "brief": "<the WHY — what makes this worth building>" }
// tool: add_task    { "project": "/abs/repo", "id": "plugin-roadmap-is-why",
//                     "target": "memory-is-derived" }
// tool: roadmap     { "project": "/abs/repo" }
{
  "targets": [
    { "id": "roadmap-in-graph", "summary": "The roadmap becomes a second altitude in the graph",
      "status": "open", "deps": [], "waitingOn": [], "blocks": ["memory-is-derived"],
      "progress": { "total": 0, "open": 0, "in_progress": 0, "done": 0 }, "ready": [] },
    { "id": "memory-is-derived", "summary": "Product memory stops duplicating the graph",
      "status": "open", "deps": ["roadmap-in-graph"],
      "waitingOn": ["roadmap-in-graph"], "blocks": [],
      "progress": { "total": 1, "open": 1, "in_progress": 0, "done": 0 },
      "ready": ["plugin-roadmap-is-why"] }
  ]
}
```

On GitHub a task's `target` **is** its issue's parent — the sub-issue edge — so the hierarchy you
browse and the one the graph reasons over are the same object, GitHub draws its own progress bar, and
re-parenting an issue in the web UI flows back on the next sync. It costs nothing to read: `parent`
rides the issue listing the provider already pages through.

Because a target is an ordinary node, the graph answers roadmap questions with the machinery it
already had — `prereqs` on a target is "what must ship before this", and `blockers` ranks targets by
how much waits on them. And because a target is never `ready`, nothing dispatches a roadmap row as if
it were a single build.

## Trails — the decisions behind a task

A task's **trail is its GitHub issue comment thread**. `append_trail` posts a comment; `get_trail` reads
the whole thread back, oldest first — so the decisions and actions behind a task live right on the issue,
and **every comment counts**, including ones people write by hand.

```jsonc
// append_trail  { "project": "/abs/repo", "id": "readme-prereqs-order",
//                 "kind": "decision", "note": "prereqs example outputs [[schema],[api,infra]]",
//                 "link": "README.md:42" }
{
  "trail": [
    {
      "kind": "decision",
      "note": "prereqs example outputs [[schema],[api,infra]]",
      "link": "README.md:42",
      "author": "octocat",
      "at": "2026-08-17T19:30:00Z",
    },
  ],
}
```

`note` is the comment body; `author` and `at` come from GitHub. `kind` (`decision` / `action` / `note`)
and `link` are optional — outputty tucks them into a hidden marker on the comments it writes, so the
comment still renders as plain text on GitHub while round-tripping the tags. A comment a person leaves by
hand has no `kind`/`link`, just its `note`, `author`, and `at`. Trails need a GitHub-backed project;
`append_trail` requires the task's issue to exist (`sync` it first).

## Reading the queue — `list_ready`

Nothing here pushes. A dispatcher learns that the graph moved by re-reading `list_ready`, which is
also the call that would tell it anything a push could have — so the one read is both the wake signal
and the answer. `list_ready` is **ranked**, best first, by
`(blocks + 1) x the task's priority x the standing of the roadmap target it serves` — so reach and
urgency combine at **both altitudes** instead of any one overriding the rest:

```jsonc
// tool: list_ready     { "project": "/abs/repo", "scope": ["src"] }
{ "ids": ["hub", "solo"],
  "tasks": [ { "id": "hub",  "blocks": 5, "score": 6, "priority": "low",
               "scope": ["src/hub"], "tags": [], "overlap": [], … },
             { "id": "solo", "blocks": 0, "score": 3, "priority": "high",
               "scope": ["src/solo"], "tags": ["spike"], "overlap": [],
               "roadmap": { "target": "ship-v2", "priority": "high", "blocks": 1,
                            "waiting": false, "weight": 3 } } ],
  "stale_claims": [] }
```

A low task blocking five outranks a lone high task; priority decides between tasks of comparable
reach. On top of that, a task inherits the standing of its **roadmap row**: an urgent target, or one
other targets wait on, lifts everything under it, and an ordinary target weighs exactly 1 — so a
task with no target is never penalised for having none. One thing is categorical rather than a
matter of degree: a task whose target still **waits on an unshipped target** sorts below every task
whose roadmap row is clear. The order is a **starting point, not a decision** — the caller weighs its
own roadmap on top.

> A worker calls `start_task` as it picks a task up, which moves it to `in_progress` and out of
> `list_ready`. So the in-flight set lives in the **graph**, not in the dispatcher's memory, and the
> list is safe to dispatch straight from. It clears itself: closing sets `done`, and sending a task
> back to `spec: replan` returns it to `open`, so an abandoned build cannot strand a task. **How
> many** may run at once is still the caller's call — this package holds the graph, not the schedule.

### Lanes, and what a lane would collide with

`scope` draws a **lane**: only tasks whose folders touch it are listed, so two dispatchers can run
side by side without ever writing the same files. Folder containment counts either way (`src` covers
`src/orders`) and is segment-wise, so `src/orders` never matches `src/orders-legacy`. A task with no
scope is in every lane, and no filter means everything.

Each row also carries `overlap`: the ids of tasks being worked **right now** whose scope touches that
row's. It is computed across **all** lanes, because a claim in another lane is exactly the collision a
lane filter would otherwise hide. Normally empty; non-empty means dispatching that row would put two
workers over the same folders. Advisory — the dispatcher decides.

`tags` carries the row's plain GitHub labels, so a dispatcher can branch on the **kind** of work
without a second call, and labels added in the web UI reach it on the next pull.

### Stale claims — a worker that died still holding work

`start_task` takes a task out of `list_ready` so nothing dispatches it twice. That is right while the
worker lives and wrong once it dies: the task stays `in_progress`, and the queue is one task narrower
with nothing to say whether it is progressing or abandoned.

So a claim carries a **heartbeat**. `start_task` stamps `claimed_at` and `heartbeat_at`, and every
later write by the holder — `append_trail` above all, which a build already calls once per layer —
moves the beat. A claim nobody has refreshed inside the threshold appears in `stale_claims`:

```jsonc
{
  "stale_claims": [
    { "id": "csv-export", "claimed_at": "…", "heartbeat_at": "…", "stale_for_minutes": 20 },
  ],
}
```

Default 15 minutes, `claimStaleMinutes` to change it. It is a **report, not a release**: freeing a
claim whose worker is merely slow would let a second worker take the same task, which is the one race
`start_task` exists to prevent. Release one deliberately with `edit_task { spec: "replan" }`.

The ledger is local and keyed on the **repo**, not the checkout, so a worker claiming from inside a
worktree and a dispatcher sweeping from the primary checkout read one file. It is deliberately not a
task field: a heartbeat per layer would rewrite the GitHub issue body on every beat, and the liveness
of a local process is not project truth.

`--sync-interval` adds a background reconcile with GitHub — it is what notices a label edited in the
web UI.

## Configuration

Preferences are configured **centrally, through the server itself** — the `set_config` tool writes
them, they are stored beside the task caches (never in your repo), and they propagate to every
provider layer:

```jsonc
// set_config — a global spec that applies to every repo…
{ "project": "/abs/repo", "scope": "global", "config": { "labels": true, "board": "Tasks" } }
// …overridable per repo:
{ "project": "/abs/repo", "scope": "repo", "config": { "labelFields": ["tier", "priority"] } }
```

Precedence, weakest first: defaults < CLI flags < global spec < per-repo override. `get_config` shows
every layer plus the effective result. Configurable: `provider`, `projects`, `projectNumber`,
`board`, `labels` (label sync on/off), `labelFields` (which properties become labels). Everything is
zod-validated — a typo'd key or mistyped value fails loudly, naming the file.

Deployment flags (in `.mcp.json`'s `args`, e.g. `["-y", "@outputty/tasks-mcp", "--no-projects"]`):

| Flag                    | Description                                             | Default       |
| ----------------------- | ------------------------------------------------------- | ------------- |
| `--http` / `--port <n>` | standalone HTTP server instead of stdio                 | stdio, `3917` |
| `--provider <name>`     | the remote layer backing each project                   | `github`      |
| `--project-number <n>`  | target an existing Projects board                       | find/create   |
| `--no-projects`         | disable the board sync                                  | board on      |
| `--board <title>`       | board title to find/create                              | `Tasks`       |
| `--cache-dir <dir>`     | where the file layer + config live                      | OS cache dir  |
| `--sync-interval <s>`   | background sync cadence while the server runs (0 = off) | off           |

Credentials come from `GITHUB_TOKEN` / `GH_TOKEN`, else `gh auth token`.

## More

- **[Architecture](docs/architecture.md)** — the provider stack, sync semantics, and the task ↔ GitHub
  mapping (body block, labels, board).
- **[CLI](docs/cli.md)** — the same tracker as shell commands (`tasks-mcp blockers`), no MCP involved,
  plus the library API.
- **[Development](docs/development.md)** — building, testing, and releasing this package.
