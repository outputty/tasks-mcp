// The pure task-graph engine, ported verbatim in behaviour from outputty's tasks.js. Every function
// here is a pure function of a Task[] — no I/O, no backend. This is why adding a backend never touches
// scheduling: a backend only has to produce the Task[] these operate on.

import type { Task, QaLevel } from "./types.ts";

const SPEC_STATES = ["drafting", "settled", "replan"] as const;
const TIERS = [1, 2, 3, 4] as const;
// Ordered weakest-first, so a build's review level is the strongest qa among the tasks it drained.
const QA_LEVELS: QaLevel[] = ["skip", "inline", "subagent"];

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
  if (!SPEC_STATES.includes(task.spec)) {
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
  if (!QA_LEVELS.includes(qa))
    throw new Error(`unknown qa '${qa}' on task ${task.id} (qa: ${QA_LEVELS.join(", ")})`);
  return qa;
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

/** Fill the structural defaults a backend may omit, so the graph functions never see undefined. */
export const withDefaults = (task: Partial<Task> & { id: string }): Task => ({
  status: "open",
  deps: [],
  scope: [],
  title: "",
  ...task,
});
