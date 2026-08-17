import { test, expect } from "bun:test";
import {
  ready,
  planning,
  schedule,
  tierOf,
  qaOf,
  specSettled,
  withDefaults,
} from "../src/graph.ts";
import type { Task } from "../src/types.ts";

const t = (over: Partial<Task> & { id: string }): Task => withDefaults(over);

test("ready: open task with all deps done is ready", () => {
  const tasks = [t({ id: "a", status: "done" }), t({ id: "b", deps: ["a"] })];
  expect(ready(tasks).map((x) => x.id)).toEqual(["b"]);
});

test("ready: a task with an open dep is not ready", () => {
  const tasks = [t({ id: "a" }), t({ id: "b", deps: ["a"] })];
  expect(ready(tasks).map((x) => x.id)).toEqual(["a"]);
});

test("ready: a drafting or replan task is never ready", () => {
  const tasks = [
    t({ id: "a", spec: "drafting" }),
    t({ id: "b", spec: "replan" }),
  ];
  expect(ready(tasks)).toEqual([]);
});

test("planning: owns drafting and replan, disjoint from ready", () => {
  const tasks = [
    t({ id: "a", spec: "drafting" }),
    t({ id: "b", spec: "settled" }),
    t({ id: "c", spec: "replan" }),
  ];
  expect(planning(tasks).map((x) => x.id)).toEqual(["a", "c"]);
  expect(ready(tasks).map((x) => x.id)).toEqual(["b"]);
});

test("specSettled: absent means settled", () => {
  expect(specSettled(t({ id: "a" }))).toBe(true);
  expect(specSettled(t({ id: "a", spec: "settled" }))).toBe(true);
  expect(specSettled(t({ id: "a", spec: "replan" }))).toBe(false);
});

test("schedule: orders tasks into dependency layers", () => {
  const tasks = [
    t({ id: "ui", deps: ["api"] }),
    t({ id: "api", deps: ["schema"] }),
    t({ id: "schema" }),
    t({ id: "docs", deps: ["ui"] }),
  ];
  expect(schedule(tasks).map((layer) => layer.map((x) => x.id))).toEqual([
    ["schema"],
    ["api"],
    ["ui"],
    ["docs"],
  ]);
});

test("schedule: throws on a dependency cycle", () => {
  const tasks = [t({ id: "a", deps: ["b"] }), t({ id: "b", deps: ["a"] })];
  expect(() => schedule(tasks)).toThrow(/cycle or unmet dependency/);
});

test("schedule: excludes done tasks from the plan", () => {
  const tasks = [t({ id: "a", status: "done" }), t({ id: "b", deps: ["a"] })];
  expect(schedule(tasks).map((layer) => layer.map((x) => x.id))).toEqual([
    ["b"],
  ]);
});

test("tierOf: defaults to 3, validates 1-4", () => {
  expect(tierOf(t({ id: "a" }))).toBe(3);
  expect(tierOf(t({ id: "a", tier: 1 }))).toBe(1);
  expect(() => tierOf(t({ id: "a", tier: 9 }))).toThrow(/unknown tier/);
});

test("qaOf: defaults to subagent, validates the set", () => {
  expect(qaOf(t({ id: "a" }))).toBe("subagent");
  expect(qaOf(t({ id: "a", qa: "skip" }))).toBe("skip");
  // @ts-expect-error deliberately bad value
  expect(() => qaOf(t({ id: "a", qa: "sometimes" }))).toThrow(/unknown qa/);
});
