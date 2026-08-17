// The MCP server, on the official @modelcontextprotocol/sdk — one tool per tracker operation, each a
// thin shell over the backend and the pure graph engine. The SDK owns the protocol (initialize,
// tools/list, tools/call, ping, notifications); this file owns only the tool surface. Every tool takes
// `project` (an absolute repo root) because the server has no cwd of its own; `branch` is optional and
// passed straight through to the backend.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../../package.json";
import type { TaskService } from "../core/service.ts";
import type { ProjectContext, Task } from "../core/types.ts";
import { QA_LEVELS, SPEC_STATES, PRIORITIES } from "../core/types.ts";
import { ProjectConfigSchema } from "../core/providers/config.ts";
import {
  ready,
  planning,
  schedule,
  prereqs,
  blockers,
  buildTask,
  asArray,
  tierOf,
  qaOf,
  priorityOf,
  idList,
} from "../core/graph.ts";

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

// A compact index row, the same shape the tracker's derived index has always emitted.
const ROW = {
  id: z.string(),
  status: z.string(),
  deps: z.array(z.string()),
  summary: z.string(),
  tier: z.number(),
  qa: z.string(),
  priority: z.string(),
};
const indexRow = (task: Task) => ({
  id: task.id,
  status: task.status,
  deps: task.deps,
  summary: task.title,
  tier: tierOf(task),
  qa: qaOf(task),
  priority: priorityOf(task),
});

// The config object's zod shape — THE schema from core/config.ts, so the surfaces cannot drift.
const CONFIG = ProjectConfigSchema.shape;

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
        qa: z.enum(QA_LEVELS).optional().describe("How much review (default subagent)."),
        priority: z.enum(PRIORITIES).optional().describe("How urgent (default normal)."),
        spec: z.enum(SPEC_STATES).optional().describe("Planning lifecycle."),
        stage: z.string().optional().describe("Narrative label on a staged deliverable."),
        discovered_from: z.string().optional().describe("Parent task, when split out mid-build."),
      },
      outputSchema: { task: z.unknown() },
    },
    async (args) => {
      const task = buildTask(args.id, args); // normalizes and validates before the write
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

  server.registerTool(
    "prereqs",
    {
      description:
        "Answers: to start working on this task, what has to be done first? Returns its open " +
        "prerequisites as dependency-ordered layers (work layer 1 first). startable=true means " +
        "nothing is in the way.",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        id: z.string().describe("The task you want to start."),
      },
      outputSchema: {
        id: z.string(),
        startable: z.boolean(),
        order: z.array(z.array(z.string())),
        tasks: z.array(z.object(ROW)),
      },
    },
    async (args) => {
      const layers = prereqs(await service.list(ctxOf(args)), args.id);
      return result({
        id: args.id,
        startable: layers.length === 0,
        order: layers.map((layer) => layer.map((t) => t.id)),
        tasks: layers.flat().map(indexRow),
      });
    },
  );

  server.registerTool(
    "blockers",
    {
      description:
        "Answers: what is the biggest blocker right now? Open tasks ranked by how much of the plan " +
        "transitively waits on them — the first entry is the single biggest bottleneck. Each entry " +
        "says what it blocks (with the high-priority subset called out) and what has to happen to " +
        "get to it (unblockedBy, dependency-ordered).",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        limit: z.number().int().positive().optional().describe("Max entries (default 5)."),
      },
      outputSchema: {
        blockers: z.array(
          z.object({
            id: z.string(),
            summary: z.string(),
            priority: z.string(),
            blocks: z.number(),
            blocked: z.array(z.string()),
            highPriorityBlocked: z.array(z.string()),
            unblockedBy: z.array(z.array(z.string())),
          }),
        ),
      },
    },
    async (args) => {
      const tasks = await service.list(ctxOf(args));
      const ranked = blockers(tasks).slice(0, args.limit ?? 5);
      return result({
        blockers: ranked.map((b) => ({
          id: b.task.id,
          summary: b.task.title,
          priority: priorityOf(b.task),
          blocks: b.blocks.length,
          blocked: b.blocks.map((t) => t.id),
          highPriorityBlocked: b.blocks.filter((t) => priorityOf(t) === "high").map((t) => t.id),
          unblockedBy: b.unblockedBy.map((layer) => layer.map((t) => t.id)),
        })),
      });
    },
  );

  server.registerTool(
    "get_config",
    {
      description:
        "The configuration for a project, layer by layer: CLI flags, the global spec (applies to " +
        "every repo), this repo's override, and the effective result.",
      inputSchema: { project: PROJECT, branch: BRANCH },
      outputSchema: {
        flags: z.object(CONFIG),
        global: z.object(CONFIG),
        repo: z.object(CONFIG),
        effective: z.object(CONFIG),
      },
    },
    async (args) => {
      return result({ ...(await service.getConfig(ctxOf(args))) });
    },
  );

  server.registerTool(
    "set_config",
    {
      description:
        "Configure preferences centrally — they propagate to every provider layer. scope=global " +
        "writes the spec that applies to all repos; scope=repo overrides it for this repo only.",
      inputSchema: {
        project: PROJECT,
        branch: BRANCH,
        scope: z.enum(["global", "repo"]).describe("Where the settings apply."),
        config: z.object(CONFIG).describe("The settings to merge in."),
      },
      outputSchema: { effective: z.object(CONFIG) },
    },
    async (args) => {
      return result({
        effective: await service.setConfig(ctxOf(args), args.scope, args.config),
      });
    },
  );

  return server;
}
