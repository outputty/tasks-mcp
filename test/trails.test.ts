// Trail store semantics: per-task, append-only journals. No network — trails never touch a remote — so
// these drive the real TrailStore and a real service over a single file layer, no nock. The load-bearing
// property is the TEXT APPEND: a later entry never rewrites an earlier one, so hand-authored prose in a
// note survives forever (the reason outputty's original tracker refused to write trails at all).

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import { TrailStore } from "../src/core/trails.ts";
import { ConfigProvider } from "../src/core/providers/config.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { task, tmp } from "./helpers.ts";

/** A store over a throwaway project + cache, plus the resolved trails dir. */
function harness() {
  const project = tmp();
  const cache = tmp();
  const store = new TrailStore(new ConfigProvider({ cacheDir: cache.dir }));
  return {
    store,
    project: project.dir,
    trailsDir: path.join(project.dir, ".trails"),
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

test("append then read returns entries oldest-first, under .trails in the repo root", () => {
  const { store, project, trailsDir, cleanup } = harness();
  store.append(project, "api", { kind: "decision", note: "GraphQL only", link: "types.ts:79" });
  store.append(project, "api", { kind: "action", note: "cut the branch param" });

  const trail = store.read(project, "api");
  expect(trail).toEqual([
    { kind: "decision", note: "GraphQL only", link: "types.ts:79" },
    { kind: "action", note: "cut the branch param" },
  ]);
  expect(fs.existsSync(path.join(trailsDir, "api.yaml"))).toBe(true);
  cleanup();
});

test("an unwritten trail reads as empty, not an error", () => {
  const { store, project, cleanup } = harness();
  expect(store.read(project, "never-touched")).toEqual([]);
  cleanup();
});

test("kind defaults to note; an unknown kind and an empty note are refused", () => {
  const { store, project, cleanup } = harness();
  expect(store.append(project, "t", { note: "bare" } as never)).toEqual([
    { kind: "note", note: "bare" },
  ]);
  expect(() => store.append(project, "t", { kind: "guess" as never, note: "x" })).toThrow(
    /unknown trail kind/,
  );
  expect(() => store.append(project, "t", { kind: "note", note: "   " })).toThrow(/needs a note/);
  cleanup();
});

test("a task id that would escape the trails directory is refused", () => {
  const { store, project, cleanup } = harness();
  expect(() => store.append(project, "../evil", { kind: "note", note: "x" })).toThrow(
    /not a safe file name/,
  );
  expect(() => store.read(project, "a/b")).toThrow(/not a safe file name/);
  cleanup();
});

test("append is non-destructive: earlier bytes (and hand-authored prose) are never rewritten", () => {
  const { store, project, trailsDir, cleanup } = harness();
  store.append(project, "api", { kind: "decision", note: "first\nspanning two lines" });
  const afterFirst = fs.readFileSync(path.join(trailsDir, "api.yaml"), "utf8");

  store.append(project, "api", { kind: "note", note: "second" });
  const afterSecond = fs.readFileSync(path.join(trailsDir, "api.yaml"), "utf8");

  expect(afterSecond.startsWith(afterFirst)).toBe(true); // the whole earlier file is a byte-prefix
  expect(store.read(project, "api")[0].note).toBe("first\nspanning two lines"); // multiline round-trips
  cleanup();
});

test("a hand-edit missing a trailing newline is appended to cleanly, not fused onto the last line", () => {
  const { store, project, trailsDir, cleanup } = harness();
  fs.mkdirSync(trailsDir, { recursive: true });
  fs.writeFileSync(path.join(trailsDir, "api.yaml"), "- kind: note\n  note: hand written"); // no final \n

  store.append(project, "api", { kind: "action", note: "tool written" });
  expect(store.read(project, "api")).toEqual([
    { kind: "note", note: "hand written" },
    { kind: "action", note: "tool written" },
  ]);
  cleanup();
});

test("the trails directory is configurable and relative to the repo root", () => {
  const project = tmp();
  const cache = tmp();
  const config = new ConfigProvider({ cacheDir: cache.dir });
  config.set(project.dir, "repo", { trailsDir: "journal" });
  const store = new TrailStore(config);

  store.append(project.dir, "api", { kind: "note", note: "elsewhere" });
  expect(fs.existsSync(path.join(project.dir, "journal", "api.yaml"))).toBe(true);
  expect(fs.existsSync(path.join(project.dir, ".trails"))).toBe(false);
  project.cleanup();
  cache.cleanup();
});

test("through the service: appendTrail records, getTrail reads, an unknown id is refused", async () => {
  const project = tmp();
  const cache = tmp();
  const svc = new TaskStack({ cacheDir: cache.dir }, [new FileProvider({ cacheDir: cache.dir })]);
  const ctx = { project: project.dir };
  await svc.create(ctx, task({ id: "api", title: "API" }));

  await svc.appendTrail(ctx, "api", { kind: "decision", note: "settled" });
  expect(await svc.getTrail(ctx, "api")).toEqual([{ kind: "decision", note: "settled" }]);
  await expect(svc.appendTrail(ctx, "ghost", { kind: "note", note: "x" })).rejects.toThrow(
    "no task ghost",
  );
  project.cleanup();
  cache.cleanup();
});
