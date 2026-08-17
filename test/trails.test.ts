// Trails are a task's GitHub issue COMMENT THREAD — every comment an entry. These drive the real stack
// (file cache on top, real GitHubProvider beneath) with nock at the wire: append posts a comment, get
// reads the whole thread, kind/link round-trip through a hidden marker, and a comment made by hand on
// the issue shows up too (every comment counts).

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { task, tmp, tmpRepo } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

function harness() {
  const gh = installNock(new NockGitHub());
  const project = tmpRepo();
  const cache = tmp();
  const svc = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ]);
  return {
    svc,
    gh,
    ctx: { project: project.dir },
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

test("append posts a comment on the issue; get reads the whole thread, oldest first", async () => {
  const { svc, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api", title: "API" }));
  await svc.appendTrail(ctx, "api", {
    kind: "decision",
    note: "GraphQL only",
    link: "types.ts:79",
  });
  const trail = await svc.appendTrail(ctx, "api", { note: "cut the branch param" });

  expect(trail).toHaveLength(2);
  // kind/link round-trip through the hidden marker; author + timestamp come from GitHub.
  expect(trail[0]).toMatchObject({
    kind: "decision",
    note: "GraphQL only",
    link: "types.ts:79",
    author: "test-user",
  });
  expect(trail[0].at).toBeTypeOf("string");
  expect(trail[1]).toMatchObject({ note: "cut the branch param", author: "test-user" });
  expect(trail[1].kind).toBeUndefined(); // a plain comment carries no kind
  cleanup();
});

test("every comment counts: a comment made by hand on the issue is in the trail", async () => {
  const { svc, gh, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api" }));
  const issueId = gh.issues[0].id; // someone comments directly on the issue — no outputty marker
  gh.comments.set(issueId, [
    { body: "looks good to me", author: "octocat", createdAt: "2026-01-02T00:00:00Z" },
  ]);

  expect(await svc.getTrail(ctx, "api")).toEqual([
    { note: "looks good to me", author: "octocat", at: "2026-01-02T00:00:00Z" },
  ]);
  cleanup();
});

test("a task with no comments has an empty trail", async () => {
  const { svc, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api" }));
  expect(await svc.getTrail(ctx, "api")).toEqual([]);
  cleanup();
});

test("append refuses a task with no issue, and an empty note", async () => {
  const { svc, ctx, cleanup } = harness();
  await svc.create(ctx, task({ id: "api" }));
  await expect(svc.appendTrail(ctx, "ghost", { note: "x" })).rejects.toThrow(/no task ghost/);
  await expect(svc.appendTrail(ctx, "api", { note: "   " })).rejects.toThrow(/needs a note/);
  cleanup();
});

test("trails need a GitHub-backed project: a file-only stack refuses", async () => {
  const cache = tmp();
  const project = tmp();
  const svc = new TaskStack({ cacheDir: cache.dir }, [new FileProvider({ cacheDir: cache.dir })]);
  await expect(svc.getTrail({ project: project.dir }, "api")).rejects.toThrow(/GitHub-backed/);
  project.cleanup();
  cache.cleanup();
});
