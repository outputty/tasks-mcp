import { test, expect } from "vitest";
import {
  ready,
  eligible,
  planning,
  schedule,
  prereqs,
  blockers,
  tierOf,
  qaOf,
  priorityOf,
  specSettled,
  typeOf,
  isTarget,
  tasksOf,
  progressOf,
  roadmap,
} from "../src/core/graph.ts";
import { task } from "./helpers.ts";
import type { Task } from "../src/core/types.ts";

test("ready: open task with all deps done is ready", () => {
  const tasks = [task({ id: "a", status: "done" }), task({ id: "b", deps: ["a"] })];
  expect(ready(tasks).map((x) => x.id)).toEqual(["b"]);
});

test("ready: a task with an open dep is not ready", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", deps: ["a"] })];
  expect(ready(tasks).map((x) => x.id)).toEqual(["a"]);
});

test("ready: a drafting or replan task is never ready", () => {
  const tasks = [task({ id: "a", spec: "drafting" }), task({ id: "b", spec: "replan" })];
  expect(ready(tasks)).toEqual([]);
});

test("planning: owns drafting and replan, disjoint from ready", () => {
  const tasks = [
    task({ id: "a", spec: "drafting" }),
    task({ id: "b", spec: "settled" }),
    task({ id: "c", spec: "replan" }),
  ];
  expect(planning(tasks).map((x) => x.id)).toEqual(["a", "c"]);
  expect(ready(tasks).map((x) => x.id)).toEqual(["b"]);
});

test("specSettled: absent means settled", () => {
  expect(specSettled(task({ id: "a" }))).toBe(true);
  expect(specSettled(task({ id: "a", spec: "replan" }))).toBe(false);
});

test("schedule: orders tasks into dependency layers", () => {
  const tasks = [
    task({ id: "ui", deps: ["api"] }),
    task({ id: "api", deps: ["schema"] }),
    task({ id: "schema" }),
    task({ id: "docs", deps: ["ui"] }),
  ];
  expect(schedule(tasks).map((layer) => layer.map((x) => x.id))).toEqual([
    ["schema"],
    ["api"],
    ["ui"],
    ["docs"],
  ]);
});

test("schedule: throws on a dependency cycle", () => {
  const tasks = [task({ id: "a", deps: ["b"] }), task({ id: "b", deps: ["a"] })];
  expect(() => schedule(tasks)).toThrow(/cycle or unmet dependency/);
});

test("tierOf: defaults to 3, validates 1-4", () => {
  expect(tierOf(task({ id: "a" }))).toBe(3);
  expect(tierOf(task({ id: "a", tier: 1 }))).toBe(1);
  expect(() => tierOf(task({ id: "a", tier: 9 }))).toThrow(/unknown tier/);
});

test("qaOf: defaults to subagent, validates the set", () => {
  expect(qaOf(task({ id: "a" }))).toBe("subagent");
  expect(qaOf(task({ id: "a", qa: "skip" }))).toBe("skip");
  // @ts-expect-error deliberately bad value
  expect(() => qaOf(task({ id: "a", qa: "sometimes" }))).toThrow(/unknown qa/);
});

// A small plan used by the prereqs/blockers rows: schema ← api ← ui, deploy ← {api, infra}.
const plan = () => [
  task({ id: "schema" }),
  task({ id: "api", deps: ["schema"] }),
  task({ id: "ui", deps: ["api"] }),
  task({ id: "deploy", deps: ["api", "infra"] }),
  task({ id: "infra" }),
];

test("prereqs: what must be done before I can start, in build order", () => {
  const layers = prereqs(plan(), "ui").map((layer) => layer.map((t) => t.id));
  expect(layers).toEqual([["schema"], ["api"]]);
});

test("prereqs: empty means start now", () => {
  expect(prereqs(plan(), "schema")).toEqual([]);
});

test("prereqs: a done dependency ends the chain (nothing beyond it is needed)", () => {
  const tasks = plan().map((t) => (t.id === "api" ? { ...t, status: "done" as const } : t));
  expect(prereqs(tasks, "ui")).toEqual([]); // api done; schema's state no longer gates ui
});

test("prereqs: an unknown id throws", () => {
  expect(() => prereqs(plan(), "nope")).toThrow(/no task nope/);
});

test("blockers: ranked by how much of the plan waits on each task", () => {
  const ranked = blockers(plan()).map((b) => [b.task.id, b.blocks.length]);
  expect(ranked[0]).toEqual(["schema", 3]); // api, ui, deploy all wait on schema
  expect(ranked).toContainEqual(["infra", 1]);
});

test("blockers: equal impact breaks ties by priority", () => {
  const tasks = [
    task({ id: "a" }),
    task({ id: "b", priority: "high" }),
    task({ id: "x", deps: ["a"] }),
    task({ id: "y", deps: ["b"] }),
  ];
  expect(blockers(tasks)[0].task.id).toBe("b");
});

test("blockers: a done task blocks nothing and hides its ancestors' reach", () => {
  const tasks = [
    task({ id: "a" }),
    task({ id: "b", deps: ["a"], status: "done" }),
    task({ id: "c", deps: ["b"] }),
  ];
  expect(blockers(tasks)).toEqual([]); // b is done, so a no longer gates c through it
});

test("priorityOf: defaults to normal, validates the set", () => {
  expect(priorityOf(task({ id: "a" }))).toBe("normal");
  expect(priorityOf(task({ id: "a", priority: "high" }))).toBe("high");
  // @ts-expect-error deliberately bad value
  expect(() => priorityOf(task({ id: "a", priority: "urgent" }))).toThrow(/unknown priority/);
});

test("eligible: priority multiplies reach, so a low task blocking five beats a lone high task", () => {
  const tasks = [
    task({ id: "solo", priority: "high" }), // (0 + 1) x 3 = 3
    task({ id: "hub", priority: "low" }), //  (5 + 1) x 1 = 6
    ...["w1", "w2", "w3", "w4", "w5"].map((id) => task({ id, deps: ["hub"] })),
  ];
  expect(eligible(tasks).map((e) => [e.task.id, e.score])).toEqual([
    ["hub", 6],
    ["solo", 3],
  ]);
});

test("eligible: an equal score breaks the tie on reach, not priority", () => {
  const tasks = [
    task({ id: "a", priority: "high" }), // blocks x        -> (1 + 1) x 3 = 6
    task({ id: "b", priority: "normal" }), // blocks y and z -> (2 + 1) x 2 = 6
    task({ id: "x", deps: ["a"] }),
    task({ id: "y", deps: ["b"] }),
    task({ id: "z", deps: ["b"] }),
  ];
  expect(eligible(tasks).map((e) => e.task.id)).toEqual(["b", "a"]);
});

test("eligible: only ready tasks rank — drafting, replan, blocked and done are all out", () => {
  const tasks = [
    task({ id: "ok" }),
    task({ id: "drafting", spec: "drafting" }),
    task({ id: "sent-back", spec: "replan" }),
    task({ id: "finished", status: "done" }),
    task({ id: "waiting", deps: ["drafting"] }),
  ];
  expect(eligible(tasks).map((e) => e.task.id)).toEqual(["ok"]);
});

// ---------------------------------------------------------------------------------------------------
// Targets — the roadmap altitude. A target groups tasks, is never dispatched, and its progress is
// derived rather than authored.

const target = (over: Partial<Task> & { id: string }): Task => task({ ...over, type: "target" });

test("typeOf: absent means task, and a junk value is refused rather than silently dispatched", () => {
  expect(typeOf(task({ id: "a" }))).toBe("task");
  expect(isTarget(target({ id: "r" }))).toBe(true);
  // A value hand-typed into a body block, past the label parser that would have dropped it.
  expect(() => typeOf({ ...task({ id: "a" }), type: "epic" } as unknown as Task)).toThrow(
    /unknown type/,
  );
});

test("ready never offers a target, however settled and unblocked it is", () => {
  const tasks = [target({ id: "roadmap-row" }), task({ id: "a", target: "roadmap-row" })];
  expect(ready(tasks).map((t) => t.id)).toEqual(["a"]);
  expect(eligible(tasks).map((e) => e.task.id)).toEqual(["a"]);
});

test("planning still owns a target whose spec is drafting — that is exactly its stage", () => {
  const tasks = [target({ id: "r", spec: "drafting" })];
  expect(planning(tasks).map((t) => t.id)).toEqual(["r"]);
  expect(ready(tasks)).toEqual([]);
});

test("tasksOf: the tasks naming a target, never the target itself", () => {
  const tasks = [
    target({ id: "r" }),
    task({ id: "a", target: "r" }),
    task({ id: "b", target: "r" }),
    task({ id: "c" }),
  ];
  expect(tasksOf(tasks, "r").map((t) => t.id)).toEqual(["a", "b"]);
});

test("progress is DERIVED from the tasks pointing at a target, never authored", () => {
  const tasks = [
    target({ id: "r" }),
    task({ id: "a", target: "r", status: "done" }),
    task({ id: "b", target: "r", status: "in_progress" }),
    task({ id: "c", target: "r" }),
  ];
  expect(progressOf(tasks, "r")).toEqual({ total: 3, open: 1, in_progress: 1, done: 1 });
});

test("roadmap: dependency-ordered targets, each with its progress and its startable tasks", () => {
  const tasks = [
    target({ id: "second", deps: ["first"] }),
    target({ id: "first" }),
    task({ id: "a", target: "first", status: "done" }),
    task({ id: "b", target: "first" }),
    task({ id: "c", target: "second", deps: ["b"] }), // blocked: b is still open
  ];
  const rows = roadmap(tasks);
  expect(rows.map((r) => r.target.id)).toEqual(["first", "second"]);
  expect(rows[0].progress).toEqual({ total: 2, open: 1, in_progress: 0, done: 1 });
  expect(rows[0].ready).toEqual(["b"]);
  expect(rows[1].ready).toEqual([]); // c waits on b
});

test("roadmap: a cycle among targets still renders — order is a display, not a schedule", () => {
  const tasks = [target({ id: "x", deps: ["y"] }), target({ id: "y", deps: ["x"] })];
  expect(
    roadmap(tasks)
      .map((r) => r.target.id)
      .sort(),
  ).toEqual(["x", "y"]);
});
