# The CLI (and the library)

The MCP server is the primary interface; the CLI drives the same core directly — useful for a human
poking at the graph, or for scripts. It is built on [commander](https://www.npmjs.com/package/commander);
`--help` on any command is authoritative.

```bash
npx -y @outputty/tasks-mcp <command> [options]
```

With no command it runs the MCP server (stdio, or `--http` — see the README).

## Commands

```bash
# the two planning questions
npx -y @outputty/tasks-mcp prereqs deploy --project /abs/repo
# -> [["schema"], ["api", "infra"]]        finish these layers first, then start deploy
npx -y @outputty/tasks-mcp blockers --project /abs/repo
# -> [{ "id": "schema", "blocks": 3, "blocked": "api, ui, deploy", "priority": "normal" }, …]

# the roadmap altitude
npx -y @outputty/tasks-mcp roadmap  --project /abs/repo   # every target, derived progress, what's ready
# -> [{ "id": "memory-is-derived", "summary": "…", "status": "open",
#       "progress": { "total": 1, "open": 1, "in_progress": 0, "done": 0 },
#       "ready": ["plugin-roadmap-is-why"] }, …]

# the working set
npx -y @outputty/tasks-mcp ready    --project /abs/repo   # ids that can be worked now, best first
npx -y @outputty/tasks-mcp planning --project /abs/repo   # ids planning still owns
npx -y @outputty/tasks-mcp schedule --project /abs/repo   # the whole plan as dependency layers
npx -y @outputty/tasks-mcp list     --project /abs/repo   # every task, full records
npx -y @outputty/tasks-mcp get api  --project /abs/repo   # one task

# configuration (read; set it through the MCP server's set_config tool)
npx -y @outputty/tasks-mcp config --project /abs/repo
# -> { "flags": {...}, "global": {...}, "repo": {...}, "effective": {...} }

# writes
npx -y @outputty/tasks-mcp add-target memory-is-derived --title "…" --brief "<the WHY>" \
  --project /abs/repo
npx -y @outputty/tasks-mcp add api --title "Build the API" --deps schema --tier 2 \
  --priority high --target memory-is-derived --project /abs/repo
npx -y @outputty/tasks-mcp edit api --title "Build the API v2" --tier 1 --project /abs/repo
npx -y @outputty/tasks-mcp start api --project /abs/repo  # in progress: leaves the ready list
npx -y @outputty/tasks-mcp close api --project /abs/repo
npx -y @outputty/tasks-mcp delete junk --project /abs/repo  # permanent; needs delete-issue permission
npx -y @outputty/tasks-mcp sync --project /abs/repo       # reconcile every layer, both ways

# ring the channel doorbell so an idle session re-evaluates
npx -y @outputty/tasks-mcp notify --note "spec gate on channel-emitter" --project /abs/repo

# trails — the task's GitHub issue comment thread (every comment an entry)
npx -y @outputty/tasks-mcp trail-add api --kind decision --note "GraphQL only" \
  --link types.ts:79 --project /abs/repo   # posts a comment on the issue
npx -y @outputty/tasks-mcp trail api --project /abs/repo
# -> [{ "kind": "decision", "note": "GraphQL only", "link": "types.ts:79",
#      "author": "octocat", "at": "2026-08-17T19:30:00Z" }]
```

`--project` defaults to the current directory. The global flags (`--provider`, `--no-projects`,
`--board`, `--project-number`, `--cache-dir`) work on every command and mean the same as in `.mcp.json`
args.

`notify` is the hook-friendly one: any process — a git hook, CI, a worker session — can ring the
doorbell of a session running elsewhere on the machine, because the note travels through a spool keyed
on the repo rather than on the checkout path.

`add` options: `--title`, `--deps a,b`, `--scope src/api`, `--tier 1..4`, `--qa skip|inline|subagent`,
`--priority high|normal|low`, `--brief`, `--contract`, `--kind`, `--tags a,b`, `--target <id>`.

`edit` takes all of those plus `--type task|target` and `--clear <fields>` — the way a field, and so
its label, comes OFF an issue (`edit api --clear spec,stage`).

`add-target` options: `--title` and `--brief` (the WHY), **both required**, then `--deps a,b` (the
targets that must SHIP first), `--priority`, `--spec`, `--kind`, `--tags`. A target takes no build
fields — nothing ever builds one.

`trail-add` options: `--note` (required), `--kind decision|action|note`, `--link`.

## The library

The same core is importable — the MCP layer is a wrapper, never a requirement:

```ts
import { makeService, prereqs, blockers } from "@outputty/tasks-mcp";
import { createHttpServer, runStdio } from "@outputty/tasks-mcp/mcp";

const service = makeService({ projects: false });
const tasks = await service.list({ project: "/abs/repo" });
console.log(blockers(tasks)[0]?.task.id); // the biggest blocker
```

Exports: `makeService` / `TaskStack` (the orchestrator), `FileProvider` / `GitHubProvider` /
`buildStack` (the layers), the pure graph engine (`ready`, `planning`, `schedule`, `prereqs`,
`blockers`, …), and `createMcpServer` / `createHttpServer` / `runStdio` under `./mcp`.
