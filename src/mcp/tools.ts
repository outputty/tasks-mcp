// The MCP tool surface — one tool per tracker operation, each a thin shell over the backend and the pure
// graph engine. Every tool takes `project` (an absolute repo root) because the server has no cwd of its
// own; `branch` is optional and passed straight through to the backend.

import type { TaskService } from "../core/service.ts";
import type { ProjectContext, Task } from "../core/types.ts";
import {
  ready,
  planning,
  schedule,
  tierOf,
  qaOf,
  idList,
} from "../core/graph.ts";

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(
    service: TaskService,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

const PROJECT = {
  type: "string",
  description: "Absolute path to the target repository root.",
};
const BRANCH = {
  type: "string",
  description: "Branch to scope to (optional; the backend decides its use).",
};

const schema = (
  props: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties: { project: PROJECT, branch: BRANCH, ...props },
  required: ["project", ...required],
  additionalProperties: false,
});

const ctxOf = (args: Record<string, unknown>): ProjectContext => {
  const project = args.project;
  if (typeof project !== "string" || !project)
    throw new Error("`project` (absolute repo root) is required");
  return {
    project,
    branch: typeof args.branch === "string" ? args.branch : undefined,
  };
};

const asArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String)
    : typeof value === "string" && value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

// A compact index row, the same shape the tracker's derived index has always emitted.
const indexRow = (task: Task) => ({
  id: task.id,
  status: task.status,
  deps: task.deps,
  summary: task.title,
  tier: tierOf(task),
  qa: qaOf(task),
});

export const TOOLS: Tool[] = [
  {
    name: "list_ready",
    description:
      "The tasks ready to build right now: open, settled, every dependency done.",
    inputSchema: schema({}, []),
    async handler(backend, args) {
      const tasks = ready(await backend.list(ctxOf(args)));
      return { ids: tasks.map((t) => t.id), tasks: tasks.map(indexRow) };
    },
  },
  {
    name: "list_planning",
    description:
      "The tasks the planning stage owns: never specced, or sent back by a build (replan).",
    inputSchema: schema({}, []),
    async handler(backend, args) {
      const tasks = planning(await backend.list(ctxOf(args)));
      return { ids: tasks.map((t) => t.id), tasks: tasks.map(indexRow) };
    },
  },
  {
    name: "schedule",
    description:
      "The whole open plan as dependency-ordered layers. Errors on a dependency cycle.",
    inputSchema: schema({}, []),
    async handler(backend, args) {
      const layers = schedule(await backend.list(ctxOf(args)));
      return {
        layers: layers.map((layer, i) => ({
          layer: i + 1,
          ids: layer.map((t) => t.id),
          display: idList(layer),
        })),
      };
    },
  },
  {
    name: "get_task",
    description: "One task's full record, or null if no task carries that id.",
    inputSchema: schema(
      { id: { type: "string", description: "The task id." } },
      ["id"],
    ),
    async handler(backend, args) {
      return { task: await backend.get(ctxOf(args), String(args.id)) };
    },
  },
  {
    name: "add_task",
    description:
      "Create a task. deps/scope accept an array or a comma string. Fails if the id exists.",
    inputSchema: schema(
      {
        id: { type: "string", description: "Stable unique id." },
        title: { type: "string", description: "One-line summary." },
        deps: {
          type: "array",
          items: { type: "string" },
          description: "Ids this task waits on.",
        },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Folders the task may edit.",
        },
        brief: {
          type: "string",
          description: "The build brief: what it builds toward.",
        },
        contract: {
          type: "string",
          description: "The done-condition, turned into a failing test first.",
        },
        tier: {
          type: "number",
          description: "1-4; how much model the work needs (default 3).",
        },
        qa: {
          type: "string",
          enum: ["skip", "inline", "subagent"],
          description: "How much review (default subagent).",
        },
        spec: {
          type: "string",
          enum: ["drafting", "settled", "replan"],
          description: "Planning lifecycle.",
        },
        stage: {
          type: "string",
          description: "Narrative label on a staged deliverable.",
        },
        discovered_from: {
          type: "string",
          description: "Parent task, when split out mid-build.",
        },
      },
      ["id"],
    ),
    async handler(backend, args) {
      const task: Task = {
        id: String(args.id),
        title: typeof args.title === "string" ? args.title : "",
        status: "open",
        deps: asArray(args.deps),
        scope: asArray(args.scope),
        ...(typeof args.brief === "string" ? { brief: args.brief } : {}),
        ...(typeof args.contract === "string"
          ? { contract: args.contract }
          : {}),
        ...(typeof args.tier === "number" ? { tier: args.tier } : {}),
        ...(typeof args.qa === "string" ? { qa: args.qa as Task["qa"] } : {}),
        ...(typeof args.spec === "string"
          ? { spec: args.spec as Task["spec"] }
          : {}),
        ...(typeof args.stage === "string" ? { stage: args.stage } : {}),
        ...(typeof args.discovered_from === "string"
          ? { discovered_from: args.discovered_from }
          : {}),
      };
      tierOf(task); // validate before the write
      qaOf(task);
      return { task: await backend.create(ctxOf(args), task) };
    },
  },
  {
    name: "amend_task",
    description:
      "Widen an open task's scope and/or set its brief. Refuses a done task (it orphans work).",
    inputSchema: schema(
      {
        id: { type: "string", description: "The task id." },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "Folders to ADD to the scope.",
        },
        brief: { type: "string", description: "Replacement brief." },
      },
      ["id"],
    ),
    async handler(backend, args) {
      const ctx = ctxOf(args);
      const id = String(args.id);
      const task = await backend.get(ctx, id);
      if (!task) throw new Error(`no task ${id}`);
      if (task.status === "done")
        throw new Error(`task ${id} is done — amend orphans committed work`);
      const patch: Partial<Task> = {};
      if (args.scope !== undefined) {
        const added = asArray(args.scope).filter(
          (s) => !task.scope.includes(s),
        );
        if (!added.length)
          throw new Error(`task ${id} already covers that scope`);
        patch.scope = [...task.scope, ...added];
      }
      if (typeof args.brief === "string") patch.brief = args.brief;
      if (!Object.keys(patch).length)
        throw new Error("amend needs scope or brief");
      return { task: await backend.update(ctx, id, patch) };
    },
  },
  {
    name: "close_task",
    description: "Mark a task done (closes its issue).",
    inputSchema: schema(
      { id: { type: "string", description: "The task id." } },
      ["id"],
    ),
    async handler(backend, args) {
      await backend.close(ctxOf(args), String(args.id));
      return { closed: String(args.id) };
    },
  },
  {
    name: "sync",
    description:
      "Reconcile the repo with GitHub: pull every issue into .claude/tasks.yaml, push seed tasks.",
    inputSchema: schema({}, []),
    async handler(backend, args) {
      return await backend.sync(ctxOf(args));
    },
  },
];

export const TOOLS_BY_NAME: Map<string, Tool> = new Map(
  TOOLS.map((t) => [t.name, t]),
);
