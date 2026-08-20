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
import type { Task, QaLevel, Priority, NodeType, Status } from "./types.ts";
import { SPEC_STATES, TIERS, QA_LEVELS, PRIORITIES, NODE_TYPES } from "./types.ts";

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

/** A record's validated type, defaulting to `task` — the shape everything had before targets. */
export function typeOf(task: Task): NodeType {
  const type = task.type ?? "task";
  if (!(NODE_TYPES as readonly string[]).includes(type)) {
    throw new Error(`unknown type '${type}' on task ${task.id} (types: ${NODE_TYPES.join(", ")})`);
  }
  return type;
}

/** A roadmap item: it groups the tasks that serve it and is never dispatched. */
export const isTarget = (task: Task): boolean => typeOf(task) === "target";

/**
 * Tasks that can be worked right now: open, settled, with every dependency done — and NOT a target.
 * A target is a roadmap row, not a unit of work; offering one would have an orchestrator dispatch a
 * whole roadmap item as if it were a single build.
 */
export function ready(tasks: Task[]): Task[] {
  const done = doneIds(tasks);
  return tasks.filter(
    (t) =>
      t.status === "open" && !isTarget(t) && specSettled(t) && t.deps.every((dep) => done.has(dep)),
  );
}

/**
 * The tasks the planning stage owns: never specced, or sent back by a build. Disjoint from `ready` by
 * construction. Targets belong here too — a roadmap row whose spec is still drafting is exactly what
 * planning owns — so this is a mirror of `ready` only across the non-target records.
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
  "type",
  "target",
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
  typeOf(task);
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
  if (task.type !== undefined) typeOf(task as Task);
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
    if (task.status === "done") continue; // a task being worked still blocks everything behind it
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

/** One task that could start right now, with the weight that ranks it. */
export interface Eligible {
  task: Task;
  /** How many open tasks transitively wait on this one. */
  blocks: number;
  /** (blocks + 1) x priority weight. */
  score: number;
}

// high 3, normal 2, low 1. Priority MULTIPLIES reach rather than outranking it: a low task blocking
// five beats a high task blocking none, while priority decides between tasks of comparable reach.
const priorityWeight = (task: Task): number => PRIORITIES.length - priorityRank(task);

/**
 * The ready tasks, ranked — the DEFAULT order, not the decision. The orchestrator starts from this
 * and re-reads the roadmap before it picks. Highest score first, then most blocked, then id.
 */
export function eligible(tasks: Task[]): Eligible[] {
  const graph = buildGraph(tasks);
  const ranked = ready(tasks).map((task) => {
    const blocks = openReach(graph, task.id, "out").size;
    return { task, blocks, score: (blocks + 1) * priorityWeight(task) };
  });
  return ranked.sort(byScore);
}

function byScore(a: Eligible, b: Eligible): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.blocks !== b.blocks) return b.blocks - a.blocks;
  return a.task.id < b.task.id ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------------
// The roadmap — the second altitude. A target groups the tasks that serve it; the graph derives where
// each one stands rather than anyone maintaining a status by hand.

/** The roadmap: every target node, in the order given. */
export const targets = (tasks: Task[]): Task[] => tasks.filter(isTarget);

/** The tasks serving one target. A target never counts as one of its own tasks. */
export const tasksOf = (tasks: Task[], id: string): Task[] =>
  tasks.filter((t) => t.target === id && !isTarget(t));

/** How one target's tasks stand. `total` is the tasks pointing at it, not a promise of completeness. */
export interface Progress {
  total: number;
  open: number;
  in_progress: number;
  done: number;
}

export function progressOf(tasks: Task[], id: string): Progress {
  const mine = tasksOf(tasks, id);
  const count = (status: Status): number => mine.filter((t) => t.status === status).length;
  return {
    total: mine.length,
    open: count("open"),
    in_progress: count("in_progress"),
    done: count("done"),
  };
}

/** One roadmap row as the graph knows it: the target, how its tasks stand, and what could start now. */
export interface RoadmapEntry {
  target: Task;
  progress: Progress;
  /** Ids of this target's tasks that are ready to dispatch. */
  ready: string[];
}

/**
 * The whole roadmap, dependency-ordered: every target with its derived progress and its startable
 * tasks. This is what replaces reading a hand-maintained status column — nothing here is authored.
 */
export function roadmap(tasks: Task[]): RoadmapEntry[] {
  const startable = new Set(ready(tasks).map((t) => t.id));
  return targetOrder(targets(tasks)).map((target) => ({
    target,
    progress: progressOf(tasks, target.id),
    ready: tasksOf(tasks, target.id)
      .filter((t) => startable.has(t.id))
      .map((t) => t.id),
  }));
}

/** Targets in dependency order. A cycle among targets is a DISPLAY problem, not a scheduling one, so
 *  an unorderable set falls back to the order given — `schedule` owns the cycle error contract. */
function targetOrder(all: Task[]): Task[] {
  const graph = buildGraph(all);
  try {
    return topologicalGenerations(graph)
      .flat()
      .map((node) => graph.getNodeAttribute(node, "task"));
  } catch {
    return all;
  }
}

/** Fill the structural defaults a backend may omit, so the graph functions never see undefined. */
export const withDefaults = (task: Partial<Task> & { id: string }): Task => ({
  status: "open",
  deps: [],
  scope: [],
  title: "",
  ...task,
});
