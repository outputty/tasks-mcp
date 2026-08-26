#!/usr/bin/env node
// The package entry, on commander. With no subcommand it runs the MCP server — stdio by default (for
// `.mcp.json` -> `bunx @outputty/tasks-mcp`), or `--http` for the standalone HTTP server. The
// subcommands drive the same core directly, no MCP involved: `add`, `add-target`, `edit`, `delete`,
// `list`, `ready`, `roadmap`, `planning`, `schedule`, `prereqs`, `blockers`, `get`, `start`, `close`,
// `trail`, `trail-add`, `sync`, `identify`.

import { Command } from "commander";
import { runStdio } from "../src/mcp/stdio.ts";
import { createHttpServer } from "../src/mcp/http.ts";
import { SERVER_INFO } from "../src/mcp/server.ts";
import { makeService, startBackgroundSync } from "../src/core/service.ts";
import { validateProjectId } from "../src/core/providers/config.ts";
import type { ServerOptions } from "../src/core/types.ts";
import type { ProjectContext, TrailEntry, TrailKind } from "../src/core/types.ts";
import {
  eligible,
  planning,
  schedule,
  prereqs,
  blockers,
  roadmap,
  buildTask,
  buildPatch,
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
  .option(
    "--sync-interval <seconds>",
    "background sync cadence in seconds while the MCP server runs (0 = off)",
    (v) => Number.parseInt(v, 10),
    0,
  )
  .option(
    "--project-id <id>",
    "default project id for the MCP server and subcommands — an opaque, supplied string",
  )
  .option("--project <id>", "project id for subcommands (overrides --project-id)");

/** The CLI-set knobs, in ServerOptions shape. `projects` is only carried when actually turned off. */
function serverOptions(): ServerOptions {
  const opts = program.opts();
  return {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.projectNumber !== undefined ? { projectNumber: opts.projectNumber } : {}),
    ...(opts.projects === false ? { projects: false } : {}),
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.syncInterval ? { syncInterval: opts.syncInterval } : {}),
  };
}

// The project id a subcommand acts on: an explicit --project, else --project-id, else the cwd (a valid
// opaque id for direct CLI use). Validated, never resolved against git or the filesystem.
const projectId = (): string =>
  validateProjectId(program.opts().project ?? program.opts().projectId ?? process.cwd());
const ctx = (): ProjectContext => ({ project: projectId() });
const service = () => makeService(serverOptions());
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

program
  .command("list")
  .description("every task, straight from the top layer")
  .action(async () => out(await service().list(ctx())));

program
  .command("ready")
  .description("the tasks ready to build right now, best first")
  .action(async () => out(eligible(await service().list(ctx())).map((e) => e.task.id)));

program
  .command("roadmap")
  .description("where every target stands: derived progress and what is ready under each")
  .action(async () =>
    out(
      roadmap(await service().list(ctx())).map((row) => ({
        id: row.target.id,
        summary: row.target.title,
        status: row.target.status,
        progress: row.progress,
        ready: row.ready,
      })),
    ),
  );

program
  .command("planning")
  .description("the tasks the planning stage owns, resubmitted (replan) ones first")
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
  .option("--kind <text>", "free-text classifier — feature | bug | chore | yours")
  .option("--tags <labels>", "comma-separated plain GitHub labels (no `field:` prefix)")
  .option("--target <id>", "the roadmap target this task serves")
  .action(async (id: string, opts: Record<string, unknown>) => {
    // The SAME builder the MCP surface uses: comma strings normalize, tier/qa/priority validate.
    out(await service().create(ctx(), buildTask(id, opts)));
  });

program
  .command("add-target")
  .description(
    "create a roadmap target — the row a set of tasks serves; never built itself. A name and a " +
      "paragraph, both required; it may carry no build fields.",
  )
  .argument("<id>", "stable unique id")
  .requiredOption("--title <text>", "the target, nameable in one sentence")
  .requiredOption("--brief <text>", "the WHY: what makes this worth building, and now")
  .option("--deps <ids>", "comma-separated targets that must SHIP before this one")
  .option("--priority <level>", "high | normal | low — multiplies the rank of every task it holds")
  .option("--spec <state>", "drafting | settled | replan")
  .option("--kind <text>", "free-text classifier")
  .option("--tags <labels>", "comma-separated plain GitHub labels")
  .action(async (id: string, opts: Record<string, unknown>) => {
    out(await service().create(ctx(), buildTask(id, { ...opts, type: "target" })));
  });

program
  .command("edit")
  .description("edit any field of a task (only the fields you pass change; the id is fixed)")
  .argument("<id>", "the task id")
  .option("--title <text>", "one-line summary")
  .option("--deps <ids>", "comma-separated ids (replaces the list)")
  .option("--scope <folders>", "comma-separated folders (replaces the list)")
  .option("--tier <n>", "1-4; how much model the work needs", (v) => Number.parseInt(v, 10))
  .option("--qa <level>", "skip | inline | subagent")
  .option("--priority <level>", "high | normal | low")
  .option("--spec <state>", "drafting | settled | replan")
  .option("--stage <label>", "narrative label on a staged deliverable")
  .option("--brief <text>", "the build brief (problem + expected solution)")
  .option("--contract <text>", "the done-condition (what to account for)")
  .option("--kind <text>", "free-text classifier — feature | bug | chore | yours")
  .option("--tags <labels>", "comma-separated plain GitHub labels (replaces the list)")
  .option("--target <id>", "move this under a different roadmap target")
  .option("--type <node>", "task | target")
  .option("--clear <fields>", "comma-separated fields to REMOVE (how a label comes off an issue)")
  .action(async (id: string, opts: Record<string, unknown>) => {
    const patch = buildPatch(id, opts); // same builder the MCP edit_task uses
    if (!Object.keys(patch).length) throw new Error("edit needs at least one field to change");
    out(await service().update(ctx(), id, patch));
  });

program
  .command("start")
  .description("mark a task in progress, so it leaves the ready list while a worker builds it")
  .argument("<id>", "the task id")
  .action(async (id: string) => out(await service().start(ctx(), id)));

program
  .command("close")
  .description("mark a task done (closes its issue)")
  .argument("<id>", "the task id")
  .action(async (id: string) => {
    await service().close(ctx(), id);
    out({ closed: id });
  });

program
  .command("delete")
  .description(
    "PERMANENTLY delete a task and its issue (needs the token's delete-issue permission)",
  )
  .argument("<id>", "the task id")
  .action(async (id: string) => {
    await service().delete(ctx(), id);
    out({ deleted: id });
  });

program
  .command("trail")
  .description("a task's trail: its GitHub issue comment thread, every comment an entry")
  .argument("<id>", "the task id")
  .action(async (id: string) => out(await service().getTrail(ctx(), id)));

program
  .command("trail-add")
  .description("append one entry to a task's trail (posts a comment on its GitHub issue)")
  .argument("<id>", "the task id")
  .requiredOption("--note <text>", "what was decided, done, or noticed")
  .option("--kind <kind>", "decision | action | note (optional tag)")
  .option("--link <ref>", "where it landed — a file:line, URL, or commit")
  .action(async (id: string, opts: Record<string, unknown>) => {
    const entry: TrailEntry = {
      note: opts.note as string,
      ...(opts.kind ? { kind: opts.kind as TrailKind } : {}),
      ...(opts.link ? { link: opts.link as string } : {}),
    };
    out(await service().appendTrail(ctx(), id, entry)); // the provider validates note and kind
  });

program
  .command("config")
  .description("the configuration, layer by layer: flags, global spec, repo override, effective")
  .action(async () => out(await service().getConfig(ctx())));

program
  .command("sync")
  .description("reconcile every layer of the stack, both ways")
  .action(async () => out(await service().sync(ctx())));

program
  .command("identify")
  .description(
    "echo the project id a call would use — opaque, validated, never resolved against git or the fs",
  )
  .action(() => out({ id: projectId() }));

// No subcommand: run the MCP server on the chosen transport. One service instance backs both the
// transport and the background loop, so the loop reconciles exactly the projects the server serves.
// The --project-id (or --project) becomes the server's default project, filling a tool call that omits
// one — validated up front so a bad default fails at launch, not on the first call.
program.action(async () => {
  const opts = program.opts();
  const svc = makeService(serverOptions());
  const rawDefault = opts.project ?? opts.projectId;
  const defaultProject = rawDefault === undefined ? undefined : validateProjectId(rawDefault);
  if (opts.syncInterval > 0) startBackgroundSync(svc, opts.syncInterval);
  if (!opts.http) return runStdio(svc, defaultProject);
  console.error(
    `tasks-mcp (http) listening on http://localhost:${opts.port}/mcp  (health: /health)`,
  );
  createHttpServer(svc, defaultProject).listen(opts.port);
});

await program.parseAsync(process.argv);
