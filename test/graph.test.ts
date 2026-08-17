import { test, expect } from "vitest";
import {
  ready,
  planning,
  schedule,
  tierOf,
  qaOf,
  specSettled,
} from "../src/core/graph.ts";
import { task } from "./helpers.ts";

test("ready: open task with all deps done is ready", () => {
  const tasks = [
    task({ id: "a", status: "done" }),
    task({ id: "b", deps: ["a"] }),
  ];
  expect(ready(tasks).map((x) => x.id)).toEqual(["b"]);
});

test("ready: a task with an open dep is not ready", () => {
  const tasks = [task({ id: "a" }), task({ id: "b", deps: ["a"] })];
  expect(ready(tasks).map((x) => x.id)).toEqual(["a"]);
});

test("ready: a drafting or replan task is never ready", () => {
  const tasks = [
    task({ id: "a", spec: "drafting" }),
    task({ id: "b", spec: "replan" }),
  ];
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
  const tasks = [
    task({ id: "a", deps: ["b"] }),
    task({ id: "b", deps: ["a"] }),
  ];
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
