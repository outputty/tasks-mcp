# tasks-mcp

tasks-mcp is a local **MCP server** that exposes outputty's task tracker as typed tools, backed by
**GitHub Issues** with two-way sync. A coding agent calls `add_task` / `list_ready` / `schedule`
instead of shelling out to a CLI, and every task is a real issue in your repo.

- **GitHub Issues are the source of truth.** Reads pull from the API, writes push to it. Nothing to keep
  in sync by hand.
- **Uses your existing credentials.** `GITHUB_TOKEN`, or whatever `gh auth login` already stored. No new
  login.
- **Pluggable backends.** The graph engine (`ready` / `planning` / `schedule`) is pure and
  backend-agnostic; GitHub Issues is the first adapter behind the port.

## Requirements

| Needs                                     | For                                          |
| ----------------------------------------- | -------------------------------------------- |
| **[bun](https://bun.sh)** ≥ 1.1           | runs the server and the tests; no build step |
| a **GitHub repo** with an `origin` remote | the server reads owner/repo from it per call |
| **`gh`** logged in, or `GITHUB_TOKEN` set | the Octokit client authenticates from these  |

## Quickstart

```bash
bun install
bun run start        # listens on http://localhost:3917/mcp
```

Confirm it is up:

```bash
curl -s localhost:3917/health
```

```json
{ "ok": true, "server": { "name": "tasks-mcp", "version": "0.1.0" } }
```

Register it with Claude Code by adding to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "tasks": { "type": "http", "url": "http://localhost:3917/mcp" }
  }
}
```

## What the tools do

Every tool takes `project` — the absolute path to the repo it acts on — because the server has no
working directory of its own. The first write to a repo it hasn't seen creates the `outputty` marker
label automatically ("spots a new repo → sets it up").

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

That creates a GitHub issue titled _Build the API_, labelled `outputty:id:api`, with the structured
fields tucked into a hidden block in the issue body.

```jsonc
// list_ready — the graph engine over live issues
{ "project": "/abs/path/to/repo" }
// -> { "ids": ["schema"], "tasks": [ { "id": "schema", "status": "open", "tier": 3, "qa": "subagent" } ] }
```

`schema` is ready and `api` is not, because `api` waits on `schema`. Close `schema` (`close_task`) and
`api` becomes ready on the next `list_ready`.

| Tool            | Does                                                                       | Writes GitHub |
| --------------- | -------------------------------------------------------------------------- | ------------- |
| `list_ready`    | open, settled, all deps done                                               | —             |
| `list_planning` | drafting or sent back by a build (replan)                                  | —             |
| `schedule`      | the whole plan as dependency layers; errors on a cycle                     | —             |
| `get_task`      | one task's full record                                                     | —             |
| `add_task`      | create a task (issue)                                                      | ✎             |
| `amend_task`    | widen an open task's scope, or set its brief                               | ✎             |
| `close_task`    | mark done (close the issue)                                                | ✎             |
| `sync`          | pull every issue into `.claude/tasks.yaml`; push `.claude/tasks.seed.yaml` | ✎             |

## How it works

```
   MCP tools  (list_ready · schedule · add_task · …)          each call carries { project, branch? }
        │
        ▼
   Graph engine  (ready · planning · schedule · tier · qa)     PURE — no I/O, backend-agnostic
        │  operates on Task[]
        ▼
   Backend port  (list · get · create · update · close · sync)
        └── GitHub Issues adapter ── Octokit ──►  issues = source of truth
```

The task ↔ issue mapping:

| Task field                                                              | Issue home                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`                                                                    | label `outputty:id:<id>` (stable key; survives title edits, lets GitHub look a task up directly) |
| `title` / `status`                                                      | issue title / open ↔ closed                                                                      |
| `deps` `scope` `brief` `contract` `tier` `qa` `spec` `stage` `attempts` | a hidden YAML block in the issue body                                                            |

Prose a human writes below that block is preserved across updates.

**Two-way sync** is inherent: reads pull from GitHub, writes push to it. The `sync` tool adds the file
bridge — it materialises the full remote state into an in-repo `.claude/tasks.yaml` snapshot and imports
any task in `.claude/tasks.seed.yaml` that has no issue yet. GitHub is the source of truth, so a pull
never edits an existing issue and there are no conflicts to resolve.

## The MCP transport

A tools-only server sends no server-initiated messages, so the Streamable HTTP transport collapses to
one JSON-RPC message in, one JSON reply out — no SSE stream, no session id. The `/mcp` endpoint handles
`initialize`, `tools/list`, and `tools/call` (plus `ping` and the `initialized` notification). This is
why the whole server is just `hono` + `octokit`.

## Config

| Variable                    | Description                | Default                       | Required |
| --------------------------- | -------------------------- | ----------------------------- | -------- |
| `OUTPUTTY_MCP_PORT`         | port the server listens on | `3917`                        | no       |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub token for Octokit   | falls back to `gh auth token` | no       |

## Development

```bash
bun test            # graph engine, GitHub adapter (mocked), and the MCP protocol
bun run dev         # hot-reloading server
```

The GitHub adapter is tested against an in-memory fake, so the suite needs no network and no
credentials.
