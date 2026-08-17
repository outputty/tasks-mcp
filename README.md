# @outputty/tasks-mcp

A local **MCP server** that exposes outputty's task tracker as typed tools. Each task is synced two-way to
a **provider** — GitHub Issues today, with Linear and others plug-and-play behind the same seam. A coding
agent calls `add_task` / `list_ready` / `schedule` instead of shelling out to a CLI.

- **The cache is local and disposable.** The graph engine reads a per-project cache under your OS cache
  dir (override with `--cache-dir`), never the repo. Each task's full record — deps included — is
  mirrored into its issue body, so a fresh or deleted cache is rebuilt from the provider by `sync`.
- **Providers are plug-and-play.** One `Provider` seam backs the cache. GitHub (Issues over GraphQL, plus
  a Projects kanban board) is the first; a new provider is one module, nothing above it moves.
- **Your existing credentials.** `GITHUB_TOKEN`, or whatever `gh auth login` already stored. No new login.

## Requirements

| Needs                                     | For                                            |
| ----------------------------------------- | ---------------------------------------------- |
| **Node ≥ 18** (or bun)                    | runs the built package (`npx`/`bunx`)          |
| a **GitHub repo** with an `origin` remote | the server reads owner/repo from it per call   |
| **`gh`** logged in, or `GITHUB_TOKEN` set | the GitHub provider authenticates over GraphQL |

## Install

No clone. Add the server to your project's `.mcp.json` and Claude Code launches it on demand:

```json
{
  "mcpServers": {
    "tasks": { "command": "npx", "args": ["-y", "@outputty/tasks-mcp"] }
  }
}
```

That runs the **stdio** transport (`bunx` works identically). For a long-running shared instance, run the
**HTTP** server instead:

```bash
npx -y @outputty/tasks-mcp --http        # http://localhost:3917/mcp  (health: /health)
```

```json
{
  "mcpServers": {
    "tasks": { "type": "http", "url": "http://localhost:3917/mcp" }
  }
}
```

## Three ways in: MCP server, CLI, library

The package is split into a **core** (all the business logic) and a thin **MCP wrapper** over it, so the
same logic is reachable three ways:

```bash
# 1. MCP server — what a coding agent uses (stdio by default, --http for the standalone server)
npx -y @outputty/tasks-mcp

# 2. Direct CLI — the same core, no MCP involved
npx -y @outputty/tasks-mcp add api --title "Build the API" --deps schema --project /abs/repo
npx -y @outputty/tasks-mcp ready --project /abs/repo
```

```ts
// 3. Library — embed the core (or the MCP layer) in your own program
import { makeService, ready } from "@outputty/tasks-mcp";
import { createApp, runStdio } from "@outputty/tasks-mcp/mcp";

const service = makeService({ projects: false });
const tasks = await service.list({ project: "/abs/repo" });
console.log(ready(tasks).map((t) => t.id));
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

That records the task in the local cache, opens a GitHub issue carrying the id in a hidden block in its
body (no labels), and adds a card to the board.

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
   bin/cli.ts   ── CLI subcommands  ·  MCP server (stdio / http)
        │
   src/mcp/     ── the MCP WRAPPER (@modelcontextprotocol/sdk): tools · stdio + streamable-http
        │  wraps ↓ ; never the other way round
   src/core/    ── the CORE (business logic): service · cache · graph engine · providers
        │  each call carries { project, branch? }
        ▼
   CACHE  <os cache dir>/<repo>.yaml   ── the working task model; disposable, rebuilt from the provider
        │  the pure graph engine (ready / schedule / planning) runs over this
        ▼
   Provider (one active, chosen by config)
        └── GitHub  ── all GraphQL ──┬── Issues     title · status(open/closed) · id-in-body   [primary]
                                     └── Projects   each task-issue → a board card; status column [best-effort]
```

**Authority split.** The cache holds the working graph and is what reads hit; the provider owns the fields
it can represent, so an issue closed in the UI wins on the next `sync`. Deps are mirrored into issue
bodies too, which is what makes the cache disposable — `sync` rebuilds it. The issue is primary (a write
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

Turn it off with `--no-projects`, or aim it at an existing board with `--project-number 7`.

## The MCP transport

The protocol is the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk):
`StdioServerTransport` for the spawned case, and stateless Streamable HTTP (JSON responses, no session
ids) served from plain `node:http` for `--http`. Each tool declares zod input and output schemas, so
results carry `structuredContent`. Runtime deps: the SDK, `octokit`, `yaml`, and `zod`.

## Config

Everything is a CLI flag — pass them in `.mcp.json`'s `args` (e.g. `["-y", "@outputty/tasks-mcp", "--no-projects"]`) or after `bunx … --http`:

| Flag                   | Description                          | Default      |
| ---------------------- | ------------------------------------ | ------------ |
| `--http`               | run the HTTP server instead of stdio | stdio        |
| `--port <n>`           | HTTP port (`--http` mode)            | `3917`       |
| `--provider <name>`    | which provider backs the project     | `github`     |
| `--project-number <n>` | target an existing Projects board    | find/create  |
| `--no-projects`        | disable the board sync               | board on     |
| `--board <title>`      | board title to find/create           | `Tasks`      |
| `--cache-dir <dir>`    | where task caches live               | OS cache dir |

A per-project `.claude/tasks-mcp.config.yaml` (keys: `provider`, `projects`, `projectNumber`, `board`)
overrides the flags for one repo. Credentials come from `GITHUB_TOKEN` / `GH_TOKEN`, else `gh auth token`.

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
npm install
npm run check        # THE build, exactly what CI runs: format check -> oxlint -> typecheck -> tests -> tsup
npm test             # vitest alone: graph engine · GitHub provider (nock) · cache service · MCP server
npm run build        # tsup alone -> dist/ (cli, index, mcp)
```

The GitHub provider is tested with **nock** — the tests drive the real Octokit client, and nock
intercepts the HTTP so the actual queries and responses are exercised without a network or credentials.
The service and MCP tests run the same way — the MCP suite drives the SDK client over real HTTP against the real server, end to end over the real provider, nock at the network boundary.

## Releasing

Publishing is automated, deliberate, and **tokenless** — it runs only when you cut a GitHub **Release**,
authenticating with **npm Trusted Publishing (OIDC)**: no `NPM_TOKEN` is stored anywhere.

One-time setup:

1. **First publish by hand** (OIDC can't do a package's first publish): `npm run build && npm publish`.
2. On npmjs, open the package → **Settings → Publishing → Add a trusted publisher** → GitHub Actions →
   org `outputty`, repo `tasks-mcp`, workflow `publish.yml`.

After that, **pushing code never publishes** — a push just runs CI (tests + build). Releasing is a
separate, manual step:

1. Bump `version` in `package.json`, commit, and push. CI runs; nothing publishes.
2. Create a GitHub **Release** with the tag `vX.Y.Z` (matching the version) — e.g.
   `gh release create v0.5.1 --generate-notes`, or the Releases UI.

Publishing the release fires the `Publish` workflow, which checks the tag matches `package.json` and the
version is new, tests, builds, and `npm publish`es via **OIDC** — the runner proves its identity to npm
with a short-lived token, and **provenance** is attached automatically. Nothing to store, rotate, or leak.
