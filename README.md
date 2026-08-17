# @outputty/tasks-mcp

A local **MCP server** that gives a coding agent a dependency-aware task tracker. The agent calls typed
tools — `add_task`, `list_ready`, `prereqs`, `blockers`, `sync` — over a task graph that is mirrored
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

| Tool            | Answers                                                        | Writes |
| --------------- | -------------------------------------------------------------- | ------ |
| `prereqs`       | what must be done before this task can start, in build order   | —      |
| `blockers`      | which tasks hold up the most work, ranked                      | —      |
| `list_ready`    | which tasks can be worked right now (open, settled, deps done) | —      |
| `list_planning` | which tasks planning still owns (drafting / replan)            | —      |
| `schedule`      | the whole open plan as dependency layers; errors on a cycle    | —      |
| `get_task`      | one task's full record                                         | —      |
| `add_task`      | create a task (file + issue + labels + board card)             | ✎      |
| `amend_task`    | widen an open task's scope, or set its brief                   | ✎      |
| `close_task`    | mark done (closes the issue, moves the card)                   | ✎      |
| `sync`          | reconcile every layer both ways; adopt hand-opened issues      | ✎      |

A task carries: `id`, `title`, `status`, `deps`, `scope`, the execution-modifying properties `tier`
(1–4), `qa` (skip/inline/subagent), `priority` (high/normal/low), `spec`, `stage`, `kind`, and
`brief`/`contract` prose. On GitHub, the scalar properties are worn as **`field:value` labels**
(`tier:2`, `priority:high`, …) — visible, filterable, and editable in the GitHub UI; edit a label
there and `sync` pulls the change back. See [docs/architecture.md](docs/architecture.md) for the full
mapping.

## Configuration

Flags go in `.mcp.json`'s `args` (e.g. `["-y", "@outputty/tasks-mcp", "--no-projects"]`):

| Flag                    | Description                             | Default       |
| ----------------------- | --------------------------------------- | ------------- |
| `--http` / `--port <n>` | standalone HTTP server instead of stdio | stdio, `3917` |
| `--provider <name>`     | the remote layer backing each project   | `github`      |
| `--project-number <n>`  | target an existing Projects board       | find/create   |
| `--no-projects`         | disable the board sync                  | board on      |
| `--board <title>`       | board title to find/create              | `Tasks`       |
| `--cache-dir <dir>`     | where the file layer lives              | OS cache dir  |

A per-project `.claude/tasks-mcp.config.yaml` (or `.json`) overrides the flags for one repo, with the
same keys (`provider`, `projects`, `projectNumber`, `board`). The file is zod-validated: a typo'd key
or a mistyped value fails loudly with the file's path. Credentials come from `GITHUB_TOKEN` /
`GH_TOKEN`, else `gh auth token`.

## More

- **[Architecture](docs/architecture.md)** — the provider stack, sync semantics, and the task ↔ GitHub
  mapping (body block, labels, board).
- **[CLI](docs/cli.md)** — the same tracker as shell commands (`tasks-mcp blockers`), no MCP involved,
  plus the library API.
- **[Development](docs/development.md)** — building, testing, and releasing this package.
