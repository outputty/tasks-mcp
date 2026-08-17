#!/usr/bin/env node
// The package entry. With no command (or `mcp`) it runs the MCP server — stdio by default (for
// `.mcp.json` -> `bunx @outputty/tasks-mcp`), or `--http` for the standalone HTTP server. It also drives
// the core business logic directly as a CLI: `add`, `list`, `ready`, `schedule`, `get`, `close`, `sync`.
//
// Flags (all optional): --http --port <n> --provider <name> --project-number <n> --no-projects
//   --board <title> --cache-dir <dir> --project <path> --title <t> --deps <a,b> --scope <a,b> --tier <n>

import { runStdio } from "../src/mcp/stdio.ts";
import { createHttpServer } from "../src/mcp/http.ts";
import { makeService } from "../src/core/service.ts";
import { ready, planning, schedule } from "../src/core/graph.ts";
import type { ServerOptions } from "../src/core/config.ts";

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const val = (name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const list = (name: string): string[] =>
  (val(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const options: ServerOptions = {};
if (val("provider")) options.provider = val("provider");
if (val("project-number")) options.projectNumber = Number(val("project-number"));
if (has("no-projects") || val("projects") === "off") options.projects = false;
if (val("board")) options.board = val("board");
if (val("cache-dir")) options.cacheDir = val("cache-dir");

const service = makeService(options);
const positional = argv.filter((a) => !a.startsWith("--"));
const command = positional[0] ?? "mcp";
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

/** The task the `add` flags describe. */
const taskFromFlags = (id: string) => ({
  id,
  title: val("title") ?? "",
  status: "open" as const,
  deps: list("deps"),
  scope: list("scope"),
  ...(val("tier") ? { tier: Number(val("tier")) } : {}),
});

// The direct-CLI surface: each subcommand returns the value to print.
type Ctx = { project: string };
const COMMANDS: Record<string, (ctx: Ctx, id: string) => Promise<unknown>> = {
  list: (ctx) => service.list(ctx),
  ready: async (ctx) => ready(await service.list(ctx)).map((t) => t.id),
  planning: async (ctx) => planning(await service.list(ctx)).map((t) => t.id),
  schedule: async (ctx) => schedule(await service.list(ctx)).map((layer) => layer.map((t) => t.id)),
  get: (ctx, id) => service.get(ctx, id),
  add: (ctx, id) => service.create(ctx, taskFromFlags(id)),
  close: async (ctx, id) => {
    await service.close(ctx, id);
    return { closed: id };
  },
  sync: (ctx) => service.sync(ctx),
};

async function runBusiness(): Promise<boolean> {
  const run = COMMANDS[command];
  if (!run) return false;
  out(await run({ project: val("project") || process.cwd() }, positional[1]));
  return true;
}

/** The MCP server, on whichever transport the flags pick: `--http`, or stdio (the default). */
async function runServer(): Promise<void> {
  if (!has("http")) return runStdio(service);
  const port = Number(val("port") || 3917);
  console.error(`tasks-mcp (http) listening on http://localhost:${port}/mcp  (health: /health)`);
  createHttpServer(service).listen(port);
}

if (await runBusiness()) process.exit(0);
await runServer();
