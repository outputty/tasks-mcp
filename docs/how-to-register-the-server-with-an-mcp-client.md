# How to register the server with an MCP client

Give a coding agent the task graph for a repository, over stdio. This is the usual way to run
tasks-mcp: the client launches the package on demand and talks to it on stdin and stdout.

## Register it

Put a `.mcp.json` at the root of the repository the agent works in:

```json
{
  "mcpServers": {
    "tasks": {
      "command": "npx",
      "args": ["-y", "@outputty/tasks-mcp"]
    }
  }
}
```

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
      "args": ["-y", "@outputty/tasks-mcp", "--sync-interval", "60"]
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
    "serverInfo": { "name": "tasks-mcp", "version": "0.20.0" },
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

## Tell the agent which repository it is working on

The server has no working directory of its own. Every tool takes `project`, the **absolute** path to a
repository root, and that repository must have a github.com `origin` remote. A relative path, or a
directory that is not a git repository, fails with:

```text
Error: no git 'origin' remote in <path> — the GitHub provider needs one
```

One server instance handles any number of projects; the path in each call decides which.

## Related

- [How to run the server over HTTP](how-to-run-the-server-over-http.md) — one shared long-running
  instance instead of a per-client process.
- [MCP tool reference](reference-mcp-tools.md) — the surface the agent sees.
