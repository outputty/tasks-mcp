#!/usr/bin/env node
// The package entry, on commander. With no subcommand it runs the MCP server — stdio by default (for
// `.mcp.json` -> `bunx @outputty/tasks-mcp`), or `--http` for the standalone HTTP server. The
// subcommands drive the same core directly, no MCP involved: `add`, `list`, `ready`, `planning`,
// `schedule`, `prereqs`, `blockers`, `get`, `close`, `sync`.

import { Command } from "commander";
import { runStdio } from "../src/mcp/stdio.ts";
import { createHttpServer } from "../src/mcp/http.ts";
import { SERVER_INFO } from "../src/mcp/server.ts";
import { makeService } from "../src/core/service.ts";
import type { ServerOptions } from "../src/core/config.ts";
import type { ProjectContext } from "../src/core/types.ts";
import {
  ready,
  planning,
  schedule,
  prereqs,
  blockers,
  buildTask,
  priorityOf,
  idList,
} from "../src/core/graph.ts";

const program = new Command()
  .name(SERVER_INFO.name)
  .description("outputty's task tracker — MCP server by default, direct subcommands for humans")
  .version(SERVER_INFO.version)
  .option("--http", "run the standalone HTTP server instead of stdio")
  .option("--port <n>", "HTTP port (--http mode)", (v) => Number.parseInt(v, 10), 3917)
  .option("--provider <name>", "the remote layer backing each project (default github)")
  .option("--project-number <n>", "target an existing Projects v2 board", (v) =>
    Number.parseInt(v, 10),
  )
  .option("--no-projects", "disable the Projects board sync")
  .option("--board <title>", "board title to find or create (default Tasks)")
  .option("--cache-dir <dir>", "where the file layer keeps its task files")
  .option("--project <path>", "target repo for subcommands (default: cwd)");

/** The CLI-set knobs, in ServerOptions shape. `projects` is only carried when actually turned off. */
function serverOptions(): ServerOptions {
  const opts = program.opts();
  return {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.projectNumber !== undefined ? { projectNumber: opts.projectNumber } : {}),
    ...(opts.projects === false ? { projects: false } : {}),
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  };
}

const ctx = (): ProjectContext => ({ project: program.opts().project || process.cwd() });
const service = () => makeService(serverOptions());
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program
  .command("list")
  .description("every task, straight from the top layer")
  .action(async () => out(await service().list(ctx())));

program
  .command("ready")
  .description("the tasks ready to build right now")
  .action(async () => out(ready(await service().list(ctx())).map((t) => t.id)));

program
  .command("planning")
  .description("the tasks the planning stage owns")
  .action(async () => out(planning(await service().list(ctx())).map((t) => t.id)));

program
  .command("schedule")
  .description("the whole open plan as dependency-ordered layers")
  .action(async () =>
    out(schedule(await service().list(ctx())).map((layer) => layer.map((t) => t.id))),
  );

program
  .command("prereqs")
  .description("what must be done before this task can start, in build order")
  .argument("<id>", "the task id")
  .action(async (id: string) =>
    out(prereqs(await service().list(ctx()), id).map((layer) => layer.map((t) => t.id))),
  );

program
  .command("blockers")
  .description("open tasks ranked by how much of the plan waits on them")
  .action(async () =>
    out(
      blockers(await service().list(ctx())).map((b) => ({
        id: b.task.id,
        blocks: b.blocks.length,
        blocked: idList(b.blocks),
        priority: priorityOf(b.task),
      })),
    ),
  );

program
  .command("get")
  .description("one task's full record")
  .argument("<id>", "the task id")
  .action(async (id: string) => out(await service().get(ctx(), id)));

program
  .command("add")
  .description("create a task")
  .argument("<id>", "stable unique id")
  .option("--title <text>", "one-line summary")
  .option("--deps <ids>", "comma-separated ids this task waits on")
  .option("--scope <folders>", "comma-separated folders the task may edit")
  .option("--tier <n>", "1-4; how much model the work needs", (v) => Number.parseInt(v, 10))
  .option("--qa <level>", "skip | inline | subagent")
  .option("--priority <level>", "high | normal | low")
  .option("--spec <state>", "drafting | settled | replan")
  .option("--stage <label>", "narrative label on a staged deliverable")
  .option("--brief <text>", "the build brief")
  .option("--contract <text>", "the done-condition")
  .action(async (id: string, opts: Record<string, unknown>) => {
    // The SAME builder the MCP surface uses: comma strings normalize, tier/qa/priority validate.
    out(await service().create(ctx(), buildTask(id, opts)));
  });

program
  .command("close")
  .description("mark a task done (closes its issue)")
  .argument("<id>", "the task id")
  .action(async (id: string) => {
    await service().close(ctx(), id);
    out({ closed: id });
  });

program
  .command("config")
  .description("the configuration, layer by layer: flags, global spec, repo override, effective")
  .action(async () => out(await service().getConfig(ctx())));

program
  .command("sync")
  .description("reconcile every layer of the stack, both ways")
  .action(async () => out(await service().sync(ctx())));

// No subcommand: run the MCP server on the chosen transport.
program.action(async () => {
  const opts = program.opts();
  if (!opts.http) return runStdio(service());
  console.error(
    `tasks-mcp (http) listening on http://localhost:${opts.port}/mcp  (health: /health)`,
  );
  createHttpServer(service()).listen(opts.port);
});

await program.parseAsync(process.argv);
