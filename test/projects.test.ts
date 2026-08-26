// The project walker — a pure filesystem read, so it is exercised directly against a temp cache dir
// (no service, no network). It counts each cache file's tasks by status and skips everything that is
// not a project file.

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { readProjectSummaries } from "../src/core/projects.ts";
import { tmp } from "./helpers.ts";

/** Write a cache file at `rel` under `dir`, nesting folders as an `owner/repo` id would. */
function writeProject(dir: string, rel: string, statuses: string[]): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = statuses
    .map((s, i) => `  - id: t${i}\n    title: T${i}\n    status: ${s}`)
    .join("\n");
  fs.writeFileSync(file, `tasks:\n${body}\n`);
}

test("a missing cache directory is not an error — it lists nothing", () => {
  const cache = tmp();
  expect(readProjectSummaries(path.join(cache.dir, "does-not-exist"))).toEqual([]);
  cache.cleanup();
});

test("an empty cache directory returns no projects", () => {
  const cache = tmp();
  expect(readProjectSummaries(cache.dir)).toEqual([]);
  cache.cleanup();
});

test("readProjectSummaries counts each file's tasks by status", () => {
  const cache = tmp();
  writeProject(cache.dir, "acme-widgets.yaml", ["open", "open", "in_progress", "done"]);
  const [row] = readProjectSummaries(cache.dir);
  expect(row).toMatchObject({
    project: "acme-widgets",
    tasks: 4,
    open: 2,
    in_progress: 1,
    done: 1,
  });
  expect(row.updated_at).toBeTypeOf("string");
  expect(new Date(row.updated_at).toISOString()).toBe(row.updated_at); // a real ISO timestamp
  cache.cleanup();
});

test("nested owner/repo ids and flat ids are both found, and rows sort by project", () => {
  const cache = tmp();
  writeProject(cache.dir, path.join("outputty", "tasks-mcp.yaml"), ["open", "in_progress"]);
  writeProject(cache.dir, "flat-legacy.yaml", ["done"]);
  const rows = readProjectSummaries(cache.dir);
  expect(rows.map((r) => r.project)).toEqual(["flat-legacy", "outputty/tasks-mcp"]); // sorted
  expect(rows[1]).toMatchObject({
    project: "outputty/tasks-mcp",
    tasks: 2,
    open: 1,
    in_progress: 1,
  });
  cache.cleanup();
});

test("an unparseable file, a .corrupt file and config files are skipped; the rest survive", () => {
  const cache = tmp();
  writeProject(cache.dir, "good.yaml", ["open"]);
  fs.writeFileSync(path.join(cache.dir, "broken.yaml"), "tasks:\n  - id: x\n    : : bad yaml");
  fs.writeFileSync(
    path.join(cache.dir, "good.yaml.corrupt"),
    "tasks:\n  - id: q\n    status: open\n",
  );
  fs.writeFileSync(path.join(cache.dir, "config.yaml"), "provider: github\n"); // global config, no tasks:
  fs.writeFileSync(path.join(cache.dir, "good.config.yaml"), "labels: false\n"); // per-repo config
  const rows = readProjectSummaries(cache.dir);
  expect(rows.map((r) => r.project)).toEqual(["good"]); // exactly the one real project
  cache.cleanup();
});

test("the claims and events sibling stores are never mistaken for projects", () => {
  const cache = tmp();
  writeProject(cache.dir, "real.yaml", ["open"]);
  fs.mkdirSync(path.join(cache.dir, "claims"), { recursive: true });
  fs.writeFileSync(path.join(cache.dir, "claims", "real.json"), "{}");
  fs.mkdirSync(path.join(cache.dir, "events", "real"), { recursive: true });
  const rows = readProjectSummaries(cache.dir);
  expect(rows.map((r) => r.project)).toEqual(["real"]);
  cache.cleanup();
});
