# @outputty/tasks-mcp

A local **MCP server** that exposes outputty's task tracker as typed tools. The dependency graph lives in
a **committed cache** in your repo; each task is synced two-way to a **provider** — GitHub Issues today,
with Linear and others plug-and-play behind the same seam. A coding agent calls `add_task` / `list_ready`
/ `schedule` instead of shelling out to a CLI.

- **The cache owns the graph.** Deps can't live in a GitHub Issue, so the authoritative task graph is a
  committed file (`.claude/tasks.cache.yaml`). It travels with the repo and survives a fresh clone.
- **Providers are plug-and-play.** One `Provider` seam backs the cache. GitHub (Issues over GraphQL, plus
  a Projects kanban board) is the first; a new provider is one module, nothing above it moves.
- **Your existing credentials.** `GITHUB_TOKEN`, or whatever `gh auth login` already stored. No new login.

## Requirements

| Needs                                     | For                                            |
| ----------------------------------------- | ---------------------------------------------- |
| **[bun](https://bun.sh)** ≥ 1.1           | runs the server (`bunx`, no build step)        |
| a **GitHub repo** with an `origin` remote | the server reads owner/repo from it per call   |
| **`gh`** logged in, or `GITHUB_TOKEN` set | the GitHub provider authenticates over GraphQL |

## Install

No clone. Add the server to your project's `.mcp.json` and Claude Code launches it on demand with `bunx`:

```json
{
  "mcpServers": {
    "tasks": { "command": "bunx", "args": ["-y", "@outputty/tasks-mcp"] }
  }
}
```

That runs the **stdio** transport. For a long-running shared instance, run the **HTTP** server instead:

```bash
bunx -y @outputty/tasks-mcp --http        # http://localhost:3917/mcp  (health: /health)
```

```json
{
  "mcpServers": {
    "tasks": { "type": "http", "url": "http://localhost:3917/mcp" }
  }
}
```

## What the tools do

Every tool takes `project` — the absolute path to the repo it acts on — because the server has no working
directory of its own. The first write to a repo it hasn't seen provisions the Projects board
automatically (when the board sync is enabled).

```jsonc
// add_task — a typed call, so a multi-line brief needs no shell quoting
{
  "project": "/abs/path/to/repo",
  "id": "api",
  "title": "Build the API",
  "deps": ["schema"],
  "scope": ["src/api"],
  "tier": 2,
  "qa": "inline",
  "brief": "turn the contract into a failing test,\nthen the laziest diff",
}
```

That records the task in the committed cache, opens a GitHub issue carrying the id in a hidden block in
its body (no labels), and adds a card to the board.

```jsonc
// list_ready — the graph engine over the cache
{ "project": "/abs/path/to/repo" }
// -> { "ids": ["schema"], "tasks": [ { "id": "schema", "status": "open", "tier": 3, "qa": "subagent" } ] }
```

`schema` is ready and `api` is not, because `api` waits on `schema`. Close `schema` (`close_task`) and
`api` is ready on the very next call — reads are cache-local, with no GitHub indexing lag.

| Tool            | Does                                                                                     | Writes |
| --------------- | ---------------------------------------------------------------------------------------- | ------ |
| `list_ready`    | open, settled, all deps done                                                             | —      |
| `list_planning` | drafting or sent back by a build (replan)                                                | —      |
| `schedule`      | the whole plan as dependency layers; errors on a cycle                                   | —      |
| `get_task`      | one task's full record                                                                   | —      |
| `add_task`      | create a task (cache + issue + board)                                                    | ✎      |
| `amend_task`    | widen an open task's scope, or set its brief                                             | ✎      |
| `close_task`    | mark done (close the issue, move the card)                                               | ✎      |
| `sync`          | two-way reconcile: pull issue/board status, adopt hand-opened issues, push offline tasks | ✎      |

## How it works

```
   MCP tools    ── stdio (bunx, for Claude Code)  ·  http (hono, standalone)
        │  each call carries { project, branch? }
        ▼
   CACHE  .claude/tasks.cache.yaml   ── the authoritative task model + DEPENDENCY GRAPH (committed)
        │  the pure graph engine (ready / schedule / planning) runs over this
        ▼
   Provider (one active, chosen by config)
        └── GitHub  ── all GraphQL ──┬── Issues     title · status(open/closed) · id-in-body   [primary]
                                     └── Projects   each task-issue → a board card; status column [best-effort]
```

**Authority split.** The cache owns the dependency graph — nothing else can hold it. The provider owns the
fields it can represent: an issue closed in the UI wins on the next `sync`. The issue is primary (a write
must land there); the board is best-effort (a hiccup is a warning, never a lost task).

The task ↔ issue mapping (all GraphQL, no labels):

| Task field                                                              | Issue home                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `id`                                                                    | leads the hidden YAML block in the issue body (the stable key) |
| `title` / `status`                                                      | issue title / open ↔ closed                                    |
| `deps` `scope` `brief` `contract` `tier` `qa` `spec` `stage` `attempts` | the rest of that hidden block                                  |

An issue is "managed" iff its body carries that block. Prose a human writes below it is preserved across
updates.

## Kanban board (GitHub Projects v2)

Each task-issue is added to a Projects v2 board and its **Status** column tracks the task
(`open → Todo`, `done → Done`). By default the server finds or creates a board named **Tasks** linked to
the repo; point it at an existing board with `projectNumber`, or turn it off entirely.

**Projects v2 needs the token's `project` scope**, which `gh` does not grant by default — add it once
with `gh auth refresh -s project`. Without it, the board sync is skipped with a warning and the task
still lands as an issue (Projects is best-effort).

```yaml
# .claude/tasks-mcp.config.yaml   (all optional)
provider: github # the backing provider (default github; linear planned)
projects: true # set false to disable the board
projectNumber: 7 # target an existing board instead of find/create "Tasks"
board: Tasks # the title to find/create when projectNumber is absent
```

## The MCP transport

A tools-only server sends no server-initiated messages. Over stdio it is newline-delimited JSON-RPC; over
HTTP the Streamable HTTP transport collapses to one JSON-RPC message in, one JSON reply out — no SSE
stream, no session id. Both handle `initialize`, `tools/list`, and `tools/call` (plus `ping` and the
`initialized` notification). This is why the whole server is just `hono` + `octokit`.

## Config

| Variable                    | Description                       | Default                       | Required |
| --------------------------- | --------------------------------- | ----------------------------- | -------- |
| `OUTPUTTY_MCP_PORT`         | HTTP port (`--http` mode)         | `3917`                        | no       |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub token for the provider     | falls back to `gh auth token` | no       |
| `OUTPUTTY_PROVIDER`         | which provider backs the project  | `github`                      | no       |
| `OUTPUTTY_PROJECT_NUMBER`   | target an existing Projects board | find/create "Tasks"           | no       |
| `OUTPUTTY_PROJECTS`         | `off` disables the board sync     | on                            | no       |

## Sync semantics

`sync` reconciles the cache with GitHub **both ways**:

- **Status flows in.** A task is **done** when its issue is closed **or** its board card is in a Done
  column. `sync` writes that into the cache and pushes it back — closing/reopening the issue and moving
  the card so all three agree. To reopen a task, reopen its issue (and move the card off Done).
- **Hand-opened issues are adopted.** Any repo issue `sync` finds without the outputty block is imported
  as a task (`gh-<number>`) and its body is stamped, so it is tracked from then on. Prose already in the
  issue is preserved below the block.
- **Offline tasks are pushed.** A task added while the provider was unreachable is created on the next
  `sync`.

## Limitations

- **Reading a moved card needs the `project` scope.** Board → cache sync requires the token's
  `read:project` scope (`gh auth refresh -s project`). Without it the board is push-only and issue state
  is the sole status source. Writing cards (add/set-column) needs `project`; nothing else here does.

## Development

```bash
bun test            # graph engine · GitHub provider (mocked GraphQL) · cache service · MCP protocol
bun run dev         # hot-reloading HTTP server
```

The GitHub provider is tested against an in-memory GraphQL fake, so the suite needs no network and no
credentials.
