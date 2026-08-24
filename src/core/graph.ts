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
import type { Task, TaskPatch, QaLevel, Priority, NodeType, Status } from "./types.ts";
import {
  SPEC_STATES,
  TIERS,
  QA_LEVELS,
  PRIORITIES,
  NODE_TYPES,
  DEFAULTS,
  LABEL_FIELD_NAMES,
} from "./types.ts";

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
  return task.spec === DEFAULTS.spec;
}

/** A record's validated type, defaulting to `task` — the shape everything had before targets. */
export function typeOf(task: Task): NodeType {
  const type = task.type ?? DEFAULTS.type;
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
  const tier = task.tier ?? DEFAULTS.tier;
  if (!TIERS.includes(tier as (typeof TIERS)[number])) {
    throw new Error(`unknown tier ${tier} on task ${task.id} (tiers: 1, 2, 3, 4)`);
  }
  return tier;
}

/** A task's validated QA level, defaulting to `subagent` (nothing downgrades unless PLAN says so). */
export function qaOf(task: Task): QaLevel {
  const qa = task.qa ?? DEFAULTS.qa;
  if (!(QA_LEVELS as readonly string[]).includes(qa))
    throw new Error(`unknown qa '${qa}' on task ${task.id} (qa: ${QA_LEVELS.join(", ")})`);
  return qa;
}

/** A task's validated priority, defaulting to `normal`. */
export function priorityOf(task: Task): Priority {
  const priority = task.priority ?? DEFAULTS.priority;
  if (!(PRIORITIES as readonly string[]).includes(priority))
    throw new Error(
      `unknown priority '${priority}' on task ${task.id} (priorities: ${PRIORITIES.join(", ")})`,
    );
  return priority;
}

/** Most-important-first rank, for sorting. */
export const priorityRank = (task: Task): number => PRIORITIES.indexOf(priorityOf(task));

// high 3, normal 2, low 1 — the multiplier a priority contributes at EITHER altitude.
const weightOf = (priority: Priority): number => PRIORITIES.length - PRIORITIES.indexOf(priority);
const priorityWeight = (task: Task): number => weightOf(priorityOf(task));
// What an unremarkable roadmap row weighs. Dividing by it keeps a normal-priority target that blocks
// nothing at exactly 1, so a task under an ordinary target ranks where it did before the roadmap
// entered the ranking, and only a target that is genuinely more (or less) than ordinary moves its work.
const ORDINARY = weightOf(DEFAULTS.priority);

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

/**
 * The optional task fields a loose input may carry through verbatim — and, because every one of them
 * is optional, exactly the set an edit may CLEAR. `id`, `title` and `status` are absent by design:
 * a task always has all three, so there is nothing to clear. `deps`/`scope`/`tags` are lists that
 * empty to `[]` rather than vanishing, and are handled on their own.
 */
export const OPTIONAL_FIELDS = [
  "type",
  "target",
  "kind",
  "brief",
  "contract",
  "tier",
  "qa",
  "priority",
  "spec",
  "stage",
  "discovered_from",
] as const;

/** Every field an edit may clear: the optionals, plus the lists (clearing a list empties it). */
export const CLEARABLE_FIELDS = [...OPTIONAL_FIELDS, "deps", "scope", "tags"] as const;

export type ClearableField = (typeof CLEARABLE_FIELDS)[number];

/**
 * What a TARGET may not carry. A target is a roadmap row: it is never offered by `ready`, never
 * dispatched, never built and never reviewed, so every field describing HOW to build something is a
 * category error on one. Keeping them off is what stops a parent issue drifting into a second, worse
 * task — the failure mode that fills a roadmap with placeholder rows.
 */
export const BUILD_ONLY_FIELDS = [
  "scope",
  "contract",
  "tier",
  "qa",
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
  if (input.tags !== undefined) task.tags = assertTags(asArray(input.tags));
  for (const key of OPTIONAL_FIELDS) {
    if (input[key] !== undefined) (task as unknown as Record<string, unknown>)[key] = input[key];
  }
  tierOf(task);
  qaOf(task);
  priorityOf(task);
  typeOf(task);
  return task;
}

/** Whether a tag is shaped like one of OUR labels (`tier:1`). Such a tag would be read back as that
 *  field on the next pull — its junk value ignored — and silently vanish, so it is refused instead. */
function shadowsField(tag: string): boolean {
  const at = tag.indexOf(":");
  return at !== -1 && (LABEL_FIELD_NAMES as readonly string[]).includes(tag.slice(0, at));
}

/** Tags, validated: a tag is a PLAIN GitHub label, never a `field:value` one outputty owns. */
export function assertTags(tags: string[]): string[] {
  const shadowed = tags.filter(shadowsField);
  if (shadowed.length === 0) return tags;
  throw new Error(
    `tag ${shadowed.join(", ")} shadows a task field — a tag is a plain label, set the field itself instead`,
  );
}

/** deps/scope/tags from a loose input: normalized when supplied, left absent when not. */
function listFields(input: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  if (input.deps !== undefined) patch.deps = asArray(input.deps);
  if (input.scope !== undefined) patch.scope = asArray(input.scope);
  if (input.tags !== undefined) patch.tags = assertTags(asArray(input.tags));
  return patch;
}

/** The fields an edit asked to CLEAR, validated against the clearable set. A typo is thrown on rather
 *  than skipped: silently leaving a label on the issue is the exact failure `clear` exists to fix. */
function clearedFields(input: unknown): ClearableField[] {
  const names = asArray(input);
  const unknown = names.filter((n) => !(CLEARABLE_FIELDS as readonly string[]).includes(n));
  if (unknown.length === 0) return names as ClearableField[];
  throw new Error(`cannot clear ${unknown.join(", ")} (clearable: ${CLEARABLE_FIELDS.join(", ")})`);
}

/** What clearing one field writes. A LIST clears to empty — an issue wearing no tags is a fact worth
 *  recording — while a scalar clears to null, which `update` turns into a deleted key. */
const cleared = (field: ClearableField): unknown =>
  (["deps", "scope", "tags"] as readonly string[]).includes(field) ? [] : null;

/**
 * A partial update for `edit_task` (and the CLI `edit`): only the fields actually supplied, the lists
 * normalized, the label fields validated, and anything named in `clear` set to null so the write
 * REMOVES it. `title` stays out of the patch when absent so a blank never clobbers the existing
 * title. Every field a task can carry is editable except `id` (the stable key).
 */
export function buildPatch(id: string, input: Record<string, unknown>): TaskPatch {
  const patch = listFields(input);
  if (typeof input.title === "string") patch.title = input.title;
  for (const key of OPTIONAL_FIELDS) {
    if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key];
  }
  validateLabelFields({ ...patch, id } as Task);
  for (const field of clearedFields(input.clear)) {
    (patch as Record<string, unknown>)[field] = cleared(field);
  }
  return patch;
}

/** A value that is genuinely absent. An empty list is not a claim either. */
const unset = (value: unknown): boolean =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0);

/**
 * What a target may CARRY. A target wearing build fields is a task in a roadmap hat: it would be
 * tiered, staged and QA'd like work, while `ready` never offers it and nothing ever builds it.
 * Checked on the MERGED record, so promoting a task that still has a scope fails exactly the way
 * filing such a target does.
 */
export function assertTargetFields(task: Task): void {
  if (!isTarget(task)) return;
  if (task.target) {
    throw new Error(
      `target ${task.id} cannot serve target ${task.target} — the roadmap is one altitude`,
    );
  }
  const worn = BUILD_ONLY_FIELDS.filter((field) => !unset(task[field]));
  if (worn.length === 0) return;
  throw new Error(
    `target ${task.id} cannot carry ${worn.join(", ")} — a target is never built (clear them first, or file it as a task)`,
  );
}

/**
 * Whether an edit could have INTRODUCED a target-shape problem: it touched a build field, the record's
 * type, or its parent. A status-only change — closing a target, starting a task — never can, and must
 * never be refused because someone hand-labelled the issue `tier:2` in the GitHub web UI last week.
 * `sync` adopts such a label (it records what GitHub says), so without this the UI action would make
 * the target uncloseable.
 */
export const touchesTargetShape = (patch: Record<string, unknown>): boolean =>
  [...BUILD_ONLY_FIELDS, "type", "target"].some((field) => field in patch);

/**
 * What a target must SAY before it exists. A roadmap row is a name and a paragraph of why it is worth
 * building, now; without the why it is a placeholder, and a roadmap of placeholders ranks nothing.
 * Enforced when a target is CREATED or promoted — never on a later edit, so a row filed before this
 * rule can still be closed.
 */
export function assertTargetWhy(task: Task): void {
  if (!isTarget(task)) return;
  if (!task.title?.trim()) {
    throw new Error(`target ${task.id} needs a title — name the target in one sentence`);
  }
  if (!task.brief?.trim()) {
    throw new Error(`target ${task.id} needs a brief — the WHY it is worth building, and now`);
  }
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
export function schedule(tasks: Task[], target?: string): Task[][] {
  const done = doneIds(tasks);
  let remaining = tasks.filter((t) => t.status !== "done");
  // Scoping to one target keeps `done` seeded from the WHOLE graph, so a dep this target does not hold
  // still resolves when it has shipped. One that has not shipped throws the unmet-dependency error
  // below, which is the correct loud failure: a target whose work waits on another target is
  // mis-scoped, and nothing can build it as one stack.
  if (target !== undefined) remaining = remaining.filter((t) => t.target === target);
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
  /** How many open TASKS transitively wait on this one. Targets are counted at their own altitude. */
  blocks: number;
  /** (blocks + 1) x the task's priority weight x the roadmap weight of the target it serves. */
  score: number;
  /** How the roadmap ranks it. Absent when the task serves no target. */
  roadmap?: Standing;
  /** Ids of tasks being worked RIGHT NOW whose scope touches this one's. Normally empty; non-empty
   *  means dispatching this would put two workers over the same folders. */
  overlap: string[];
}

/**
 * A task's ROADMAP standing — everything about the target it serves that bears on what to build next.
 * Without this a task under a shelved roadmap row competes on equal footing with one under the row
 * that gates the next release, because the graph only ever saw the task's own priority.
 */
export interface Standing {
  /** The target this task serves. */
  target: string;
  /** The target's own urgency. */
  priority: Priority;
  /** Open targets that transitively wait on this target — reach at the roadmap altitude. */
  blocks: number;
  /** The target's roadmap dependencies have NOT all shipped: the plan says this comes later. */
  waiting: boolean;
  /** priority x reach, normalized so an ordinary target weighs exactly 1. */
  weight: number;
}

/** How many reached records match — reach, counted at ONE altitude rather than mixing the two. */
const countReached = (reached: Map<string, Task>, keep: (t: Task) => boolean): number =>
  [...reached.values()].filter(keep).length;

/**
 * Whether two scope lists touch. Scope is a FOLDER, never a file list, so containment either way is
 * an intersection: `src` covers `src/orders`, and a task scoped `src/orders` is inside a lane drawn
 * at `src`. Comparison is path-segment-wise, so `src/orders` never matches `src/orders-legacy`.
 */
export function scopesIntersect(a: string[], b: string[]): boolean {
  return a.some((one) => b.some((other) => covers(one, other) || covers(other, one)));
}

/** Whether `outer` contains `inner` as a folder — equal, or a parent of it. */
const covers = (outer: string, inner: string): boolean => {
  const o = trimSlashes(outer);
  const i = trimSlashes(inner);
  return o === "" || o === i || i.startsWith(`${o}/`);
};

const trimSlashes = (folder: string): string => folder.replace(/^\/+|\/+$/g, "");

/**
 * The tasks inside a lane. An EMPTY filter is not a lane — it means "everything", so an unfiltered
 * dispatcher behaves exactly as it did before lanes existed. A task with no scope at all is in every
 * lane: it declares no files, so no lane can exclude it on evidence.
 */
export function inLane(task: Task, lane: string[]): boolean {
  if (lane.length === 0) return true;
  if (task.scope.length === 0) return true;
  return scopesIntersect(task.scope, lane);
}

/**
 * The live claims whose scope touches this task's — the mis-drawn-lane signal. A task being worked is
 * a task whose files are moving, so dispatching a second task over the same folders is how two agents
 * come to edit one file. Normally empty: PLAN packs same-folder tasks into one LAYER, built in
 * sequence by one worker, and lanes are drawn so items do not share folders. Advisory, because the
 * dispatcher decides — a hard refusal here would also block re-dispatching after a stale claim.
 */
export function overlappingClaims(tasks: Task[], task: Task): string[] {
  return tasks
    .filter((t) => t.status === "in_progress" && t.id !== task.id)
    .filter((t) => scopesIntersect(t.scope, task.scope))
    .map((t) => t.id);
}

/**
 * The ready tasks, ranked — the DEFAULT order, not the decision. The orchestrator starts from this
 * and re-reads the roadmap before it picks. Score MULTIPLIES three things rather than letting any one
 * override the rest: the task's own reach, its own urgency, and the standing of the roadmap row it
 * serves. A task whose target still waits on an unshipped target sorts below every task whose row is
 * clear, because that is a categorical fact about the plan, not a matter of degree.
 */
export function eligible(tasks: Task[], lane: string[] = []): Eligible[] {
  const graph = buildGraph(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = doneIds(tasks);
  const ranked = ready(tasks)
    .filter((task) => inLane(task, lane))
    .map((task) => {
      const blocks = countReached(openReach(graph, task.id, "out"), (t) => !isTarget(t));
      const standing = standingOf(graph, byId, done, task);
      const score = (blocks + 1) * priorityWeight(task) * (standing?.weight ?? 1);
      // Overlap is computed against EVERY task, never just the lane: a claim in another lane is
      // exactly the collision a lane filter would otherwise hide.
      const overlap = overlappingClaims(tasks, task);
      return { task, blocks, score, overlap, ...(standing ? { roadmap: standing } : {}) };
    });
  return ranked.sort(byScore);
}

/**
 * A task's roadmap standing, or null when it serves no target — a stray bug competes on its own
 * merits and is never penalised for having no roadmap row.
 */
function standingOf(
  graph: TaskGraph,
  byId: Map<string, Task>,
  done: Set<string>,
  task: Task,
): Standing | null {
  const target = task.target ? byId.get(task.target) : undefined;
  if (!target || !isTarget(target)) return null;
  const blocks = countReached(openReach(graph, target.id, "out"), isTarget);
  return {
    target: target.id,
    priority: priorityOf(target),
    blocks,
    waiting: target.deps.some((dep) => !done.has(dep)),
    weight: (priorityWeight(target) / ORDINARY) * (blocks + 1),
  };
}

/** Whether the ROADMAP says this comes later: the row it serves still waits on an unshipped target. */
const waiting = (entry: Eligible): boolean => entry.roadmap?.waiting === true;

function byScore(a: Eligible, b: Eligible): number {
  if (waiting(a) !== waiting(b)) return waiting(a) ? 1 : -1;
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
  /** Targets that must ship before this one and have NOT — the roadmap's own blockers. Non-empty
   *  means every task under this row is ranked below work whose row is clear. */
  waitingOn: string[];
  /** Open targets that transitively wait on this one: what a slip here delays downstream. */
  blocks: string[];
}

/**
 * The whole roadmap, dependency-ordered: every target with its derived progress, its startable tasks,
 * and where it sits in the roadmap's own dependency graph. Nothing here is authored — a hand-kept
 * status column beside a graph that already knows the answer is the thing this replaces.
 */
export function roadmap(tasks: Task[]): RoadmapEntry[] {
  const startable = new Set(ready(tasks).map((t) => t.id));
  const graph = buildGraph(tasks);
  const done = doneIds(tasks);
  return targetOrder(targets(tasks)).map((target) => ({
    target,
    progress: progressOf(tasks, target.id),
    ready: tasksOf(tasks, target.id)
      .filter((t) => startable.has(t.id))
      .map((t) => t.id),
    waitingOn: target.deps.filter((dep) => !done.has(dep)),
    blocks: [...openReach(graph, target.id, "out").values()].filter(isTarget).map((t) => t.id),
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
