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

# the working set
npx -y @outputty/tasks-mcp ready    --project /abs/repo   # ids that can be worked right now
npx -y @outputty/tasks-mcp planning --project /abs/repo   # ids planning still owns
npx -y @outputty/tasks-mcp schedule --project /abs/repo   # the whole plan as dependency layers
npx -y @outputty/tasks-mcp list     --project /abs/repo   # every task, full records
npx -y @outputty/tasks-mcp get api  --project /abs/repo   # one task

# configuration (read; set it through the MCP server's set_config tool)
npx -y @outputty/tasks-mcp config --project /abs/repo
# -> { "flags": {...}, "global": {...}, "repo": {...}, "effective": {...} }

# writes
npx -y @outputty/tasks-mcp add api --title "Build the API" --deps schema --tier 2 \
  --priority high --project /abs/repo
npx -y @outputty/tasks-mcp close api --project /abs/repo
npx -y @outputty/tasks-mcp sync --project /abs/repo       # reconcile every layer, both ways
```

`--project` defaults to the current directory. The global flags (`--provider`, `--no-projects`,
`--board`, `--project-number`, `--cache-dir`) work on every command and mean the same as in
`.mcp.json` args.

`add` options: `--title`, `--deps a,b`, `--scope src/api`, `--tier 1..4`, `--qa skip|inline|subagent`,
`--priority high|normal|low`, `--brief`, `--contract`.

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
`stackFor` (the layers), the pure graph engine (`ready`, `planning`, `schedule`, `prereqs`,
`blockers`, …), and `createMcpServer` / `createHttpServer` / `runStdio` under `./mcp`.
