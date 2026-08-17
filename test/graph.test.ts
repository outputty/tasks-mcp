import { test, expect } from "vitest";
import {
  ready,
  planning,
  schedule,
  prereqs,
  blockers,
  tierOf,
  qaOf,
  priorityOf,
  specSettled,
} from "../src/core/graph.ts";
import { task } from "./helpers.ts";

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
