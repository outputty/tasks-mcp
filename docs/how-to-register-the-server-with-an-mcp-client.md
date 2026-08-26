# How to register the server with an MCP client

Give a coding agent the task graph for a repository, over stdio. This is the usual way to run
tasks-mcp: the client launches the package on demand and talks to it on stdin and stdout.

## Register it

Put a `.mcp.json` at the root of the repository the agent works in, and give it a `--project-id` — an
opaque string that names this project's graph:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "npx",
      "args": ["-y", "@outputty/tasks-mcp", "--project-id", "outputty/tasks-mcp"]
    }
  }
}
```

`--project-id` is the default a tool call uses when it omits `project`, so the agent need not repeat it.
Because the file is checked in, every git worktree cut from the repo inherits the same id and therefore
one shared task cache — see [the project id](reference-cli.md#the-project-id). Use any stable string;
`owner/repo` is a convenient convention, not a requirement.

Nothing is cloned or installed ahead of time — `npx -y` fetches the package the first time the client
launches it. Use `bunx` in place of `npx` if you prefer bun; the package runs on Node 18 or newer.

Restart the client so it picks the file up.

## Add the background reconcile

Without it, the server only learns about a change made in the GitHub UI — a label edited, a card
dragged, an issue closed — when something calls `sync`. Give it a cadence in seconds:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "npx",
      "args": [
        "-y",
        "@outputty/tasks-mcp",
        "--project-id",
        "outputty/tasks-mcp",
        "--sync-interval",
        "60"
      ]
    }
  }
}
```

The loop reconciles every project the server has been asked about, one at a time, and re-arms only
after a pass finishes, so a slow sync never overlaps the next. A project's own failure is logged to
stderr and skipped. Sixty seconds is a reasonable starting cadence; `0`, the default, turns it off.

Deployment flags all go in the same `args` array — `--no-projects`, `--board`, `--cache-dir`. User
preferences do not: set those with the `set_config` tool, which stores them centrally. See the
[configuration reference](reference-configuration.md).

## Give it credentials

The server reads `GITHUB_TOKEN`, then `GH_TOKEN`, then falls back to shelling out to `gh auth token`.
If your client launches servers with a stripped environment, `gh` is the path of least resistance:

```bash
gh auth login
gh auth refresh -s project
```

The `project` scope is only needed for the Projects v2 board. Without it, tasks still land as issues
and the board is skipped with a warning on stderr.

## Check it works before blaming the client

Drive the server by hand. This is the same process the client spawns:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | npx -y @outputty/tasks-mcp
```

A healthy server answers on one line:

```json
{
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "tasks-mcp", "version": "0.21.0" },
    "instructions": "A task tracker. …"
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

If that works and the client still shows nothing, the problem is the client's config file or its
environment, not the server.

Logs go to stderr, never stdout — stdout carries the protocol. Anything the server has to warn about
is prefixed `tasks-mcp:` and will show up in your client's MCP log.

## Which project a call is about

The server has no working directory of its own. Every tool takes `project` — the opaque
[project id](reference-cli.md#the-project-id), not a path — and falls back to the server's
`--project-id` when a call omits it. One server instance handles any number of projects; the id in each
call (or the default) decides which.

GitHub coordinates are separate from the id: the provider uses the project's `repo` setting, or the
`origin` of the directory the server was launched from. A server launched by a repo's `.mcp.json` gets
its coordinates from that repo's `origin` for free. A shared server started outside any repository must
set `repo` for the project, or a GitHub-touching call fails with:

```text
Error: no GitHub repo for this project — set `repo` (owner/repo) in its config, or launch the server from the repository so `origin` can supply it
```

## Related

- [How to run the server over HTTP](how-to-run-the-server-over-http.md) — one shared long-running
  instance instead of a per-client process.
- [MCP tool reference](reference-mcp-tools.md) — the surface the agent sees.
