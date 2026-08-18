// The pure task-graph engine, ported verbatim in behaviour from outputty's tasks.js. Every function
// here is a pure function of a Task[] — no I/O, no backend. This is why adding a backend never touches
// scheduling: a backend only has to produce the Task[] these operate on.
//
// Reachability questions (prereqs, blockers) run on graphology, the maintained standard graph library;
// `schedule` keeps its own 15-line generation peel because its error contract ("cycle or unmet
// dependency among: <exact ids>") is API and graphology's topological sort reports cycles differently.

import { DirectedGraph } from "graphology";
import { topologicalGenerations } from "graphology-dag";
import { bfsFromNode } from "graphology-traversal";
import { match, P } from "ts-pattern";
import type { Task, QaLevel, Priority } from "./types.ts";
import { SPEC_STATES, TIERS, QA_LEVELS, PRIORITIES } from "./types.ts";

/** Ids of the tasks that are already finished. */
export function doneIds(tasks: Task[]): Set<string> {
  return new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
}

/**
 * Whether a task's spec is settled enough to build. Only `settled` is buildable; absent means settled,
 * so a graph written before this field ever existed still schedules unchanged.
 */
export function specSettled(task: Task): boolean {
  if (task.spec === undefined) return true;
  if (!(SPEC_STATES as readonly string[]).includes(task.spec)) {
    throw new Error(
      `unknown spec state '${task.spec}' on task ${task.id} (states: ${SPEC_STATES.join(", ")})`,
    );
  }
  return task.spec === "settled";
}

/** Tasks that can be worked right now: open, settled, with every dependency done. */
export function ready(tasks: Task[]): Task[] {
  const done = doneIds(tasks);
  return tasks.filter(
    (t) => t.status === "open" && specSettled(t) && t.deps.every((dep) => done.has(dep)),
  );
}

/**
 * The tasks the planning stage owns: never specced, or sent back by a build. This is the mirror of
 * `ready`, and the two are disjoint by construction.
 */
export function planning(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "open" && !specSettled(t));
}

/** A task's validated tier, defaulting to 3 (the build baseline). */
export function tierOf(task: Task): number {
  const tier = task.tier ?? 3;
  if (!TIERS.includes(tier as (typeof TIERS)[number])) {
    throw new Error(`unknown tier ${tier} on task ${task.id} (tiers: 1, 2, 3, 4)`);
  }
  return tier;
}

/** A task's validated QA level, defaulting to `subagent` (nothing downgrades unless PLAN says so). */
export function qaOf(task: Task): QaLevel {
  const qa = task.qa ?? "subagent";
  if (!(QA_LEVELS as readonly string[]).includes(qa))
    throw new Error(`unknown qa '${qa}' on task ${task.id} (qa: ${QA_LEVELS.join(", ")})`);
  return qa;
}

/** A task's validated priority, defaulting to `normal`. */
export function priorityOf(task: Task): Priority {
  const priority = task.priority ?? "normal";
  if (!(PRIORITIES as readonly string[]).includes(priority))
    throw new Error(
      `unknown priority '${priority}' on task ${task.id} (priorities: ${PRIORITIES.join(", ")})`,
    );
  return priority;
}

/** Most-important-first rank, for sorting. */
export const priorityRank = (task: Task): number => PRIORITIES.indexOf(priorityOf(task));

/** Loose list input (MCP args or CLI flags): a string array, a comma string, or nothing. */
export const asArray = (value: unknown): string[] =>
  match(value)
    .with(P.array(P.string), (v) => v)
    .with(P.string, (v) =>
      v
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .otherwise(() => []);

// The optional task fields a loose input may carry through verbatim.
const OPTIONAL_FIELDS = [
  "brief",
  "contract",
  "tier",
  "qa",
  "priority",
  "spec",
  "stage",
  "discovered_from",
] as const;

/**
 * ONE task builder for every surface (MCP add_task, CLI add): normalizes deps/scope from array or
 * comma string, carries the optional fields that are present, and validates before anything writes.
 */
export function buildTask(id: string, input: Record<string, unknown>): Task {
  const task: Task = {
    id,
    title: typeof input.title === "string" ? input.title : "",
    status: "open",
    deps: asArray(input.deps),
    scope: asArray(input.scope),
  };
  for (const key of OPTIONAL_FIELDS) {
    if (input[key] !== undefined) (task as unknown as Record<string, unknown>)[key] = input[key];
  }
  tierOf(task);
  qaOf(task);
  priorityOf(task);
  return task;
}

/**
 * A partial update for `edit_task` (and the CLI `edit`): only the fields actually supplied, deps/scope
 * normalized, the label fields validated. `title` stays out of the patch when absent so a blank never
 * clobbers the existing title. Every field a task can carry is editable except `id` (the stable key).
 */
export function buildPatch(id: string, input: Record<string, unknown>): Partial<Task> {
  const patch: Partial<Task> = {};
  if (typeof input.title === "string") patch.title = input.title;
  if (input.deps !== undefined) patch.deps = asArray(input.deps);
  if (input.scope !== undefined) patch.scope = asArray(input.scope);
  for (const key of OPTIONAL_FIELDS) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  validateLabelFields({ ...patch, id } as Task);
  return patch;
}

/** Throw on an out-of-range tier/qa/priority actually present on a patch (each validator defaults an
 *  absent field, so only validate the ones the edit set). */
function validateLabelFields(task: Partial<Task> & { id: string }): void {
  if (task.tier !== undefined) tierOf(task as Task);
  if (task.qa !== undefined) qaOf(task as Task);
  if (task.priority !== undefined) priorityOf(task as Task);
}

/** The whole plan as ordered layers, in dependency order. Throws on a dependency cycle. */
export function schedule(tasks: Task[]): Task[][] {
  const done = doneIds(tasks);
  let remaining = tasks.filter((t) => t.status !== "done");
  const layers: Task[][] = [];

  while (remaining.length > 0) {
    const layer = remaining.filter((t) => t.deps.every((dep) => done.has(dep)));
    if (layer.length === 0) {
      throw new Error(`cycle or unmet dependency among: ${idList(remaining)}`);
    }
    layers.push(layer);
    layer.forEach((t) => done.add(t.id));
    remaining = remaining.filter((t) => !layer.includes(t));
  }
  return layers;
}

export const idList = (tasks: Task[]): string => tasks.map((t) => t.id).join(", ");

type TaskGraph = DirectedGraph<{ task: Task }>;

/** The dependency DAG: an edge dep → task means dep must finish before task can start. */
function buildGraph(tasks: Task[]): TaskGraph {
  const graph: TaskGraph = new DirectedGraph();
  for (const task of tasks) graph.addNode(task.id, { task });
  for (const task of tasks) {
    for (const dep of task.deps) if (graph.hasNode(dep)) graph.addEdge(dep, task.id);
  }
  return graph;
}

/**
 * The open tasks reachable from `id` in one direction, traversal PRUNED at done tasks — a finished
 * task already satisfied its side of the graph, so nothing beyond it constrains (or is constrained by)
 * `id` through that path.
 */
function openReach(graph: TaskGraph, id: string, mode: "in" | "out"): Map<string, Task> {
  const reached = new Map<string, Task>();
  bfsFromNode(
    graph,
    id,
    (node, attrs) => {
      if (node === id) return false;
      if (attrs.task.status === "done") return true; // prune: a done task ends the chain
      reached.set(node, attrs.task);
      return false;
    },
    { mode },
  );
  return reached;
}

/** The subgraph induced by `keep`: those nodes, and only the edges among them. */
function induced(graph: TaskGraph, keep: Map<string, Task>): TaskGraph {
  const sub: TaskGraph = new DirectedGraph();
  for (const [id, task] of keep) sub.addNode(id, { task });
  for (const [id] of keep) {
    for (const dep of graph.inNeighbors(id)) if (sub.hasNode(dep)) sub.addEdge(dep, id);
  }
  return sub;
}

/**
 * "If I want to start on `id`, what has to be done first?" — the open tasks `id` transitively waits
 * on, as dependency-ordered layers (work layer 1 first, then layer 2, …). Empty means start now.
 */
export function prereqs(tasks: Task[], id: string): Task[][] {
  const graph = buildGraph(tasks);
  if (!graph.hasNode(id)) throw new Error(`no task ${id}`);
  return prereqsOn(graph, id);
}

/** `prereqs` over an already-built graph, so rankings never rebuild it per task. */
function prereqsOn(graph: TaskGraph, id: string): Task[][] {
  const needed = openReach(graph, id, "in");
  const sub = induced(graph, needed);
  return topologicalGenerations(sub).map((layer) =>
    layer.map((node) => sub.getNodeAttribute(node, "task")),
  );
}

/** One entry in the blocker ranking: an open task and every open task transitively waiting on it. */
export interface Blocker {
  task: Task;
  /** The open tasks that cannot start (or finish their chain) until this one is done. */
  blocks: Task[];
  /** What has to happen before the blocker itself can start, dependency-ordered. */
  unblockedBy: Task[][];
}

/**
 * "What is the biggest blocker right now?" — every open task ranked by how many open tasks
 * transitively wait on it: most blocked first, then higher priority, then id. The first entry is the
 * single biggest bottleneck in the plan.
 */
export function blockers(tasks: Task[]): Blocker[] {
  const graph = buildGraph(tasks);
  const out: Blocker[] = [];
  for (const task of tasks) {
    if (task.status !== "open") continue;
    const blocks = [...openReach(graph, task.id, "out").values()];
    if (blocks.length > 0) out.push({ task, blocks, unblockedBy: prereqsOn(graph, task.id) });
  }
  return out.sort(byImpact);
}

function byImpact(a: Blocker, b: Blocker): number {
  if (a.blocks.length !== b.blocks.length) return b.blocks.length - a.blocks.length;
  if (priorityRank(a.task) !== priorityRank(b.task))
    return priorityRank(a.task) - priorityRank(b.task);
  return a.task.id < b.task.id ? -1 : 1;
}

/** Fill the structural defaults a backend may omit, so the graph functions never see undefined. */
export const withDefaults = (task: Partial<Task> & { id: string }): Task => ({
  status: "open",
  deps: [],
  scope: [],
  title: "",
  ...task,
});
