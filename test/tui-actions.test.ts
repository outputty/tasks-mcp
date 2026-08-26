// The detail screen's reads and writes, driven through a real MCP client against a real in-process
// tracker. Most run on a file-only stack; the trail (a GitHub comment thread) runs on the nock stack.
// No renderer here — these are the console's write surface, and every write is an existing tool.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { createHttpServer } from "../src/mcp/http.ts";
import { connectTracker } from "../src/tui/tracker.ts";
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
  nock.enableNetConnect(/^(localhost|127\.0\.0\.1)/); // the MCP client talks to its own http server
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
const structured = (res: unknown) =>
  (res as { structuredContent: Record<string, unknown> }).structuredContent;

async function serve(svc: TaskStack) {
  const server = createHttpServer(svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  const client = await connectTracker(`http://127.0.0.1:${addr.port}/mcp`);
  return {
    client,
    close: async () => {
      await client.close();
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

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
  await svc.create({ project: "p" }, task({ id: "dep-done" }));
  await svc.close({ project: "p" }, "dep-done");
  await svc.create({ project: "p" }, task({ id: "dep-open" }));
  await svc.create(
    { project: "p" },
    task({ id: "main", deps: ["dep-done", "dep-open"], title: "Main" }),
  );
  const { client, close } = await serve(svc);
  const detail = await loadDetail(client, "p", "main");
  expect(detail.task.title).toBe("Main");
  expect(detail.deps).toEqual([
    { id: "dep-done", done: true },
    { id: "dep-open", done: false },
  ]);
  expect(detail.trail).toEqual([]);
  await close();
  cache.cleanup();
});

test("applyEdit sends only the changed fields; other fields are untouched", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "t", title: "Old", priority: "normal" }));
  const { client, close } = await serve(svc);
  const before = editFields((await svc.get({ project: "p" }, "t"))!);
  await applyEdit(client, "p", "t", editPatch(before, { ...before, priority: "high" }));
  expect((await svc.get({ project: "p" }, "t"))?.priority).toBe("high");
  expect((await svc.get({ project: "p" }, "t"))?.title).toBe("Old");
  await close();
  cache.cleanup();
});

test("changeState starts, replans and closes through the existing tools", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await svc.create({ project: "p" }, task({ id: "t" }));
  const { client, close } = await serve(svc);
  await changeState(client, "p", "t", "start");
  expect((await svc.get({ project: "p" }, "t"))?.status).toBe("in_progress");
  await changeState(client, "p", "t", "replan");
  expect((await svc.get({ project: "p" }, "t"))?.spec).toBe("replan");
  await changeState(client, "p", "t", "close");
  expect((await svc.get({ project: "p" }, "t"))?.status).toBe("done");
  await close();
  cache.cleanup();
});

test("fileIdea files a drafting task that list_planning returns", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  const { client, close } = await serve(svc);
  await fileIdea(client, "p", "new-idea", "A fresh idea");
  expect((await svc.get({ project: "p" }, "new-idea"))?.spec).toBe("drafting");
  const planning = await client.callTool({ name: "list_planning", arguments: { project: "p" } });
  expect(structured(planning).ids).toContain("new-idea");
  await close();
  cache.cleanup();
});

test("a rejected write surfaces as an error and changes nothing", async () => {
  const cache = tmp();
  const { client, close } = await serve(fileStack(cache.dir));
  await expect(applyEdit(client, "p", "ghost", { title: "x" })).rejects.toThrow(/ghost/);
  await close();
  cache.cleanup();
});

test("addComment appends a trail entry and the re-read shows it (no /events fires for a trail write)", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const repo = tmpRepo();
  const svc = nockStack(cache.dir);
  await svc.create({ project: repo.dir }, task({ id: "api", title: "API" }));
  const { client, close } = await serve(svc);
  const trail = await addComment(client, repo.dir, "api", "unblocked it");
  expect(trail.map((e) => e.note)).toContain("unblocked it");
  await close();
  repo.cleanup();
  cache.cleanup();
});

test("loadDetail returns the trail newest-first", async () => {
  installNock(new NockGitHub());
  const cache = tmp();
  const repo = tmpRepo();
  const svc = nockStack(cache.dir);
  await svc.create({ project: repo.dir }, task({ id: "api" }));
  await svc.appendTrail({ project: repo.dir }, "api", { note: "first" });
  await svc.appendTrail({ project: repo.dir }, "api", { note: "second" });
  const { client, close } = await serve(svc);
  const detail = await loadDetail(client, repo.dir, "api");
  expect(detail.trail.map((e) => e.note)).toEqual(["second", "first"]);
  await close();
  repo.cleanup();
  cache.cleanup();
});
