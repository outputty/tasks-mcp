// Lanes: the scope filter that lets two dispatchers run side by side, and the overlap advisory that
// says when a lane was drawn wrong. Pure graph tests — no I/O, because both are pure functions of a
// Task[], which is the whole reason scheduling never needs a backend.

import { test, expect } from "vitest";
import { eligible, inLane, scopesIntersect, overlappingClaims } from "../src/core/graph.ts";
import { task } from "./helpers.ts";

// The examples.md task, verbatim in the fields lanes care about.
const csvExport = task({
  id: "csv-export",
  title: "Add a CSV export of the synced orders",
  scope: ["src/orders"],
});

test("a lane matches by folder containment, either way round", () => {
  expect(scopesIntersect(["src/orders"], ["src"])).toBe(true); // the lane contains the task
  expect(scopesIntersect(["src"], ["src/orders"])).toBe(true); // the task contains the lane
  expect(scopesIntersect(["src/orders"], ["src/orders"])).toBe(true);
  expect(scopesIntersect(["src/orders"], ["docs"])).toBe(false);
});

test("containment is segment-wise, so a shared prefix is not a match", () => {
  expect(scopesIntersect(["src/orders"], ["src/orders-legacy"])).toBe(false);
  expect(scopesIntersect(["src/orders-legacy"], ["src/orders"])).toBe(false);
});

test("trailing and leading slashes never change the answer", () => {
  expect(scopesIntersect(["src/orders/"], ["/src"])).toBe(true);
  expect(scopesIntersect(["src/orders"], ["src/"])).toBe(true);
});

test("list_ready filters the examples.md task by lane", () => {
  const tasks = [csvExport];
  expect(eligible(tasks, ["src/orders"]).map((e) => e.task.id)).toEqual(["csv-export"]);
  expect(eligible(tasks, ["src"]).map((e) => e.task.id)).toEqual(["csv-export"]);
  expect(eligible(tasks, ["docs"]).map((e) => e.task.id)).toEqual([]);
});

test("no filter means everything — an unfiltered dispatcher is unchanged", () => {
  const tasks = [csvExport, task({ id: "docs-pass", scope: ["docs"] })];
  expect(
    eligible(tasks)
      .map((e) => e.task.id)
      .sort(),
  ).toEqual(["csv-export", "docs-pass"]);
  expect(
    eligible(tasks, [])
      .map((e) => e.task.id)
      .sort(),
  ).toEqual(["csv-export", "docs-pass"]);
});

test("a task with no scope is in every lane — it declares no files to exclude it on", () => {
  const loose = task({ id: "loose" });
  expect(inLane(loose, ["docs"])).toBe(true);
  expect(inLane(loose, ["src/orders"])).toBe(true);
  expect(eligible([loose], ["anything"]).map((e) => e.task.id)).toEqual(["loose"]);
});

test("overlap names the live claim whose scope touches a ready task's", () => {
  const tasks = [
    csvExport,
    task({ id: "order-store", scope: ["src/orders/export"], status: "in_progress" }),
  ];
  const [row] = eligible(tasks, ["src/orders"]);
  expect(row.task.id).toBe("csv-export");
  expect(row.overlap).toEqual(["order-store"]);
});

test("overlap is empty when nothing in flight shares folders", () => {
  const tasks = [csvExport, task({ id: "docs-pass", scope: ["docs"], status: "in_progress" })];
  expect(eligible(tasks, ["src/orders"])[0].overlap).toEqual([]);
});

test("overlap crosses lanes — a claim the filter hides is exactly the collision to report", () => {
  const tasks = [csvExport, task({ id: "sweep", scope: ["src"], status: "in_progress" })];
  // The lane is drawn at src/orders, so `sweep` is not listed. Its claim still shows as an overlap.
  const rows = eligible(tasks, ["src/orders"]);
  expect(rows.map((e) => e.task.id)).toEqual(["csv-export"]);
  expect(rows[0].overlap).toEqual(["sweep"]);
});

test("only in-progress tasks count as claims; open and done ones do not", () => {
  const open = task({ id: "sibling", scope: ["src/orders"] });
  const done = task({ id: "shipped", scope: ["src/orders"], status: "done" });
  expect(overlappingClaims([csvExport, open, done], csvExport)).toEqual([]);
});

test("a task never overlaps itself", () => {
  const working = task({ id: "csv-export", scope: ["src/orders"], status: "in_progress" });
  expect(overlappingClaims([working], working)).toEqual([]);
});
