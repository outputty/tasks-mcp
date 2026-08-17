// The MCP server, on the official @modelcontextprotocol/sdk — one tool per tracker operation, each a
// thin shell over the backend and the pure graph engine. The SDK owns the protocol (initialize,
// tools/list, tools/call, ping, notifications); this file owns only the tool surface. Every tool takes
// `project` (an absolute repo root) because the server has no cwd of its own; `branch` is optional and
// passed straight through to the backend.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { match, P } from "ts-pattern";
import { z } from "zod";
import pkg from "../../package.json";
import type { TaskService } from "../core/service.ts";
import type { ProjectContext, Task } from "../core/types.ts";
import { ready, planning, schedule, tierOf, qaOf, idList } from "../core/graph.ts";

// The single source of the server's identity: the name is the package's bare name, the version is the
// package version — never a hand-maintained copy.
export const SERVER_INFO = {
  name: pkg.name.replace(/^.*\//, ""),
  version: pkg.version,
};

const PROJECT = z.string().describe("Absolute path to the target repository root.");
const BRANCH = z
  .string()
  .optional()
  .describe("Branch to scope to (optional; the backend decides its use).");
/** deps/scope accept a proper array or a comma string. */
const LIST = z.union([z.array(z.string()), z.string()]);

const ctxOf = (args: { project: string; branch?: string }): ProjectContext => ({
  project: args.project,
  branch: args.branch,
});

/** deps/scope come in as a string array or a comma string; anything absent is an empty list. */
const asArray = (value: unknown): string[] =>
  match(value)
    .with(P.array(P.string), (v) => v)
    .with(P.string, (v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .otherwise(() => []);

// The optional task fields add_task passes through verbatim when present.
const OPTIONAL_FIELDS = [
  "brief",
  "contract",
  "tier",
  "qa",
  "spec",
  "stage",
  "discovered_from",
] as const;
function optionalFields(args: Record<string, unknown>): Partial<Task> {
  const out: Record<string, unknown> = {};
  for (const key of OPTIONAL_FIELDS) if (args[key] !== undefined) out[key] = args[key];
  return out as Partial<Task>;
}

// A compact index row, the same shape the tracker's derived index has always emitted.
const ROW = {
  id: z.string(),
  status: z.string(),
  deps: z.array(z.string()),
  summary: z.string(),
  tier: z.number(),
  qa: z.string(),
};
const indexRow = (task: Task) => ({
  id: task.id,
  status: task.status,
  deps: task.deps,
  summary: task.title,
  tier: tierOf(task),
  qa: qaOf(task),
});

// Tool results carry the JSON twice by MCP convention: `structuredContent` for typed consumers,
// serialized `content` text for the rest.
const result = <T extends Record<string, unknown>>(structured: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
  structuredContent: structured,
});

/** The MCP server over one task service. A transport (stdio or HTTP) connects to it. */
// Deviation from the 24-line cap, justified: this is a declarative tool table — eight registerTool
// calls that are schema data plus one-expression handlers. Splitting it into arbitrary function
// groups would hide the surface, and every handler body is under the cap on its own.
// oxlint-disable-next-line max-lines-per-function
export function createMcpServer(service: TaskService): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_ready",
    {
      description: "The tasks ready to build right now: open, settled, every dependency done.",
      inputSchema: { project: PROJECT, branch: BRANCH },
      outputSchema: { ids: z.array(z.string()), tasks: z.array(z.object(ROW)) },
    },
    async (args) => {
      const tasks = ready(await service.list(ctxOf(args)));
      return result({
        ids: tasks.map((t) => t.id),
        tasks: tasks.map(indexRow),
      });
    },
  );

  server.registerTool(
    "list_planning",
    {
      description:
        "The tasks the planning stage owns: never specced, or sent back by a build (replan).",
      inputSchema: { project: PROJECT, branch: BRANCH },
      outputSchema: { ids: z.array(z.string()), tasks: z.array(z.object(ROW)) },
    },
    async (args) => {
      const tasks = planning(await service.list(ctxOf(args)));
      return result({
        ids: tasks.map((t) => t.id),
        tasks: tasks.map(indexRow),
      });
    },
  );

  server.registerTool(
    "schedule",
    {
      description:
        "The whole open plan as dependency-ordered layers. Errors on a dependency cycle.",
      inputSchema: { project: PROJECT, branch: BRANCH },
      outputSchema: {
        layers: z.array(
          z.object({
            layer: z.number(),
            ids: z.array(z.string()),
            display: z.string(),
          }),
        ),
      },
    },
    async (args) => {
      const layers = schedule(await service.list(ctxOf(args)));
      return result({
        layers: layers.map((layer, i) => ({
          layer: i + 1,
          ids: layer.map((t) => t.id),
          display: idList(layer),
        })),
      });
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "One task's full record, or null if no task carries that id.",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        id: z.string().describe("The task id."),
      },
      outputSchema: { task: z.unknown() },
    },
    async (args) => {
      return result({ task: await service.get(ctxOf(args), args.id) });
    },
  );

  server.registerTool(
    "add_task",
    {
      description:
        "Create a task. deps/scope accept an array or a comma string. Fails if the id exists.",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        id: z.string().describe("Stable unique id."),
        title: z.string().optional().describe("One-line summary."),
        deps: LIST.optional().describe("Ids this task waits on."),
        scope: LIST.optional().describe("Folders the task may edit."),
        brief: z.string().optional().describe("The build brief: what it builds toward."),
        contract: z
          .string()
          .optional()
          .describe("The done-condition, turned into a failing test first."),
        tier: z.number().optional().describe("1-4; how much model the work needs (default 3)."),
        qa: z
          .enum(["skip", "inline", "subagent"])
          .optional()
          .describe("How much review (default subagent)."),
        spec: z.enum(["drafting", "settled", "replan"]).optional().describe("Planning lifecycle."),
        stage: z.string().optional().describe("Narrative label on a staged deliverable."),
        discovered_from: z.string().optional().describe("Parent task, when split out mid-build."),
      },
      outputSchema: { task: z.unknown() },
    },
    async (args) => {
      const task: Task = {
        id: args.id,
        title: args.title ?? "",
        status: "open",
        deps: asArray(args.deps),
        scope: asArray(args.scope),
        ...optionalFields(args),
      };
      tierOf(task); // validate before the write
      qaOf(task);
      return result({ task: await service.create(ctxOf(args), task) });
    },
  );

  server.registerTool(
    "amend_task",
    {
      description:
        "Widen an open task's scope and/or set its brief. Refuses a done task (it orphans work).",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        id: z.string().describe("The task id."),
        scope: LIST.optional().describe("Folders to ADD to the scope."),
        brief: z.string().optional().describe("Replacement brief."),
      },
      outputSchema: { task: z.unknown() },
    },
    async (args) => {
      const ctx = ctxOf(args);
      const task = await service.get(ctx, args.id);
      if (!task) throw new Error(`no task ${args.id}`);
      if (task.status === "done")
        throw new Error(`task ${args.id} is done — amend orphans committed work`);
      const patch: Partial<Task> = {};
      if (args.scope !== undefined) {
        const added = asArray(args.scope).filter((s) => !task.scope.includes(s));
        if (!added.length) throw new Error(`task ${args.id} already covers that scope`);
        patch.scope = [...task.scope, ...added];
      }
      if (args.brief !== undefined) patch.brief = args.brief;
      if (!Object.keys(patch).length) throw new Error("amend needs scope or brief");
      return result({ task: await service.update(ctx, args.id, patch) });
    },
  );

  server.registerTool(
    "close_task",
    {
      description: "Mark a task done (closes its issue).",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        id: z.string().describe("The task id."),
      },
      outputSchema: { closed: z.string() },
    },
    async (args) => {
      await service.close(ctxOf(args), args.id);
      return result({ closed: args.id });
    },
  );

  server.registerTool(
    "sync",
    {
      description:
        "Reconcile the repo with GitHub: pull every issue into the local cache, push seed tasks.",
      inputSchema: { project: PROJECT, branch: BRANCH },
      outputSchema: {
        pulled: z.number(),
        pushed: z.number(),
        conflicts: z.number(),
      },
    },
    async (args) => {
      return result({ ...(await service.sync(ctxOf(args))) });
    },
  );

  return server;
}
