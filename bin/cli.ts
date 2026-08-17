#!/usr/bin/env bun
// The npm bin. Default: stdio, for `.mcp.json` -> `bunx @outputty/tasks-mcp` (Claude Code spawns it).
// `--http [--port N]`: run the standalone hono server instead.

import { runStdio } from "../src/stdio.ts";

const args = process.argv.slice(2);

if (args.includes("--http")) {
  const { createApp } = await import("../src/server.ts");
  const portFlag = args.indexOf("--port");
  const port = Number(
    portFlag !== -1
      ? args[portFlag + 1]
      : process.env.OUTPUTTY_MCP_PORT || 3917,
  );
  const app = createApp();
  console.error(
    `tasks-mcp (http) listening on http://localhost:${port}/mcp  (health: /health)`,
  );
  Bun.serve({ port, fetch: app.fetch });
} else {
  await runStdio();
}
