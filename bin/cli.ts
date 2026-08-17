#!/usr/bin/env bun
// The npm bin. Default: stdio, for `.mcp.json` -> `bunx @outputty/tasks-mcp` (Claude Code spawns it).
// `--http`: run the standalone hono server instead.
//
// Flags (all optional):
//   --http                 run the HTTP server instead of stdio
//   --port <n>             HTTP port (default 3917)
//   --provider <name>      backing provider (default github)
//   --project-number <n>   target an existing Projects v2 board (else find/create one)
//   --no-projects          disable the Projects board sync
//   --board <title>        board title to find/create (default "Tasks")
//   --cache-dir <dir>      where caches live (default the OS cache dir)

import { runStdio } from "../src/stdio.ts";
import { createApp } from "../src/server.ts";
import { makeService } from "../src/service.ts";
import type { ServerOptions } from "../src/config.ts";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const val = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : undefined;
};

const options: ServerOptions = {};
if (val("provider")) options.provider = val("provider");
if (val("project-number"))
  options.projectNumber = Number(val("project-number"));
if (has("no-projects") || val("projects") === "off") options.projects = false;
if (val("board")) options.board = val("board");
if (val("cache-dir")) options.cacheDir = val("cache-dir");

const service = makeService(options);

if (has("http")) {
  const port = Number(val("port") || 3917);
  const app = createApp(service);
  console.error(
    `tasks-mcp (http) listening on http://localhost:${port}/mcp  (health: /health)`,
  );
  Bun.serve({ port, fetch: app.fetch });
} else {
  await runStdio(service);
}
