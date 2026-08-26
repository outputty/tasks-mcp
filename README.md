# @outputty/tasks-mcp

A dependency-aware task tracker for coding agents: an MCP server, a CLI, and a library over one task
graph that is mirrored two-way into GitHub — one issue per task, `field:value` labels for its
execution properties, and a Projects v2 kanban board.

The graph holds two altitudes. **Tasks** are units of work with dependencies, scope, and a build
brief. **Targets** are roadmap rows that group them, and their progress is counted from the tasks
rather than typed by anyone. `list_ready` answers what can be worked right now, ranked at both
altitudes.

## Requirements

- Node 18 or newer.
- A git repository with a github.com `origin` remote.
- A GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or a logged-in `gh` CLI. For the kanban board, grant the
  `project` scope once with `gh auth refresh -s project`; without it tasks still land as issues.

## Install

Nothing to clone. Register the server in your project's `.mcp.json` and your MCP client launches it on
demand:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "npx",
      "args": ["-y", "@outputty/tasks-mcp", "--sync-interval", "60"]
    }
  }
}
```

Or drive the same graph from a shell:

```bash
npm install -g @outputty/tasks-mcp
```

## First run

From inside the repository you want to track:

```console
$ tasks-mcp add order-schema --title "Give an order a stable export shape" --scope src/orders
{
  "id": "order-schema",
  "title": "Give an order a stable export shape",
  "status": "open",
  "deps": [],
  "scope": [
    "src/orders"
  ]
}
```

That wrote the task to a local cache and opened a GitHub issue for it. Ask what can be worked:

```console
$ tasks-mcp ready
[
  "order-schema"
]
```

## Documentation

### Tutorial — start here

- [Your first task graph](https://github.com/outputty/tasks-mcp/blob/main/docs/tutorial-your-first-task-graph.md)
  — build a target and two tasks in a throwaway repository, and watch the queue move.

### How-to guides

- [Register the server with an MCP client](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-register-the-server-with-an-mcp-client.md)
  — stdio, `.mcp.json`, credentials, and how to check it before blaming the client.
- [Run the server over HTTP](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-run-the-server-over-http.md)
  — one shared long-running instance instead of a process per client.
- [Adopt an existing GitHub Issues backlog](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-adopt-an-existing-github-backlog.md)
  — what the first sync writes, and how to give adopted issues structure.
- [Recover work from a dead worker](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-recover-work-from-a-dead-worker.md)
  — find a stale claim and hand the task back to the queue.
- [Change what the queue offers next](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-change-what-the-queue-offers-next.md)
  — priority at both altitudes, dependencies, and lanes for parallel workers.
- [Use tasks-mcp as a library](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-use-tasks-mcp-as-a-library.md)
  — the graph engine, the service, and running without GitHub.
- [Develop, test, and release this package](https://github.com/outputty/tasks-mcp/blob/main/docs/how-to-develop-test-and-release.md)
  — for contributors.

### Reference

- [MCP tools](https://github.com/outputty/tasks-mcp/blob/main/docs/reference-mcp-tools.md) — all
  twenty tools, their arguments, and their results.
- [CLI](https://github.com/outputty/tasks-mcp/blob/main/docs/reference-cli.md) — every subcommand,
  flag, and printed shape.
- [Task record](https://github.com/outputty/tasks-mcp/blob/main/docs/reference-task-record.md) — the
  fields, their defaults, and where each one lives on GitHub.
- [Configuration](https://github.com/outputty/tasks-mcp/blob/main/docs/reference-configuration.md) —
  the settings, the four layers, the files, and the credentials.

### Explanation

- [The two altitudes](https://github.com/outputty/tasks-mcp/blob/main/docs/explanation-two-altitudes.md)
  — why targets and tasks share one graph.
- [Claims](https://github.com/outputty/tasks-mcp/blob/main/docs/explanation-claims.md) — why a claim
  that has gone quiet is reported and never freed.
- [The provider stack](https://github.com/outputty/tasks-mcp/blob/main/docs/explanation-the-provider-stack.md)
  — layers, sync rules, and why the store is GitHub Issues.
- [Trails](https://github.com/outputty/tasks-mcp/blob/main/docs/explanation-trails.md) — why a task's
  decision record is its issue comment thread.

## License

MIT
