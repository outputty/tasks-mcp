// The detail screen's reads and writes, driven straight against a real in-process `TaskService` — no
// MCP client, no HTTP server. Most run on a file-only stack; the trail (a GitHub comment thread) runs on
// the nock stack. No renderer here — these are the console's write surface, each a direct service call.

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { planning } from "../src/core/graph.ts";
import {
  loadDetail,
  applyEdit,
  changeState,
  addComment,
  fileIdea,
  editFields,
  editPatch,
} from "../src/tui/actions.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";
import { task, tmp, tmpRepo } from "./helpers.ts";

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

const fileStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);
const nockStack = (cacheDir: string) =>
  new TaskStack({ cacheDir }, [
    new FileProvider({ cacheDir }),
    nockProvider({ projects: false, cacheDir }),
  ]);

test("editPatch carries only the fields that changed, and deps replace as a whole list", () => {
  const before = { title: "T", priority: "normal", tier: "3", qa: "subagent", deps: "a, b" };
  expect(editPatch(before, before)).toEqual({}); // nothing changed → no patch
  expect(editPatch(before, { ...before, priority: "high", tier: "2" })).toEqual({
    priority: "high",
    tier: 2,
  });
  expect(editPatch(before, { ...before, deps: "a, c" })).toEqual({ deps: ["a", "c"] }); // whole list
});

test("loadDetail returns the task, deps flagged done, and (file-only) an empty trail", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const ctx = { project: "p" };
  await svc.create(ctx, task({ id: "dep-done" }));
  await svc.close(ctx, "dep-done");
  await svc.create(ctx, task({ id: "dep-open" }));
  await svc.create(ctx, task({ id: "main", deps: ["dep-done", "dep-open"], title: "Main" }));
  const detail = await loadDetail(svc, ctx, "main");
  expect(detail.task.title).toBe("Main");
  expect(detail.deps).toEqual([
    { id: "dep-done", done: true },
    { id: "dep-open", done: false },
  ]);
  expect(detail.trail).toEqual([]);
  cache.cleanup();
});

test("applyEdit sends only the changed fields; other fields are untouched", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const ctx = { project: "p" };
  await svc.create(ctx, task({ id: "t", title: "Old", priority: "normal" }));
  const before = editFields((await svc.get(ctx, "t"))!);
  await applyEdit(svc, ctx, "t", editPatch(before, { ...before, priority: "high" }));
  expect((await svc.get(ctx, "t"))?.priority).toBe("high");
  expect((await svc.get(ctx, "t"))?.title).toBe("Old");
  cache.cleanup();
});

test("changeState starts, replans and closes through the service", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const ctx = { project: "p" };
  await svc.create(ctx, task({ id: "t" }));
  await changeState(svc, ctx, "t", "start");
  expect((await svc.get(ctx, "t"))?.status).toBe("in_progress");
  await changeState(svc, ctx, "t", "replan");
  expect((await svc.get(ctx, "t"))?.spec).toBe("replan");
  await changeState(svc, ctx, "t", "close");
  expect((await svc.get(ctx, "t"))?.status).toBe("done");
  cache.cleanup();
});

test("fileIdea files a drafting task that planning returns", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const ctx = { project: "p" };
  await fileIdea(svc, ctx, "new-idea", "A fresh idea");
  expect((await svc.get(ctx, "new-idea"))?.spec).toBe("drafting");
  expect(planning(await svc.list(ctx)).map((t) => t.id)).toContain("new-idea");
  cache.cleanup();
});

test("a rejected write surfaces as an error and changes nothing", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await expect(applyEdit(svc, { project: "p" }, "ghost", { title: "x" })).rejects.toThrow(/ghost/);
  cache.cleanup();
});

test("addComment appends a trail entry and returns the re-read thread", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const repo = tmpRepo();
  const svc = nockStack(cache.dir);
  const ctx = { project: repo.dir };
  await svc.create(ctx, task({ id: "api", title: "API" }));
  const trail = await addComment(svc, ctx, "api", "unblocked it");
  expect(trail.map((e) => e.note)).toContain("unblocked it");
  repo.cleanup();
  cache.cleanup();
});

test("loadDetail returns the trail newest-first", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const repo = tmpRepo();
  const svc = nockStack(cache.dir);
  const ctx = { project: repo.dir };
  await svc.create(ctx, task({ id: "api" }));
  await svc.appendTrail(ctx, "api", { note: "first" });
  await svc.appendTrail(ctx, "api", { note: "second" });
  const detail = await loadDetail(svc, ctx, "api");
  expect(detail.trail.map((e) => e.note)).toEqual(["second", "first"]);
  repo.cleanup();
  cache.cleanup();
});
