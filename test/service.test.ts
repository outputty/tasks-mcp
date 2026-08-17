// Service tests, end to end: a real CachedTaskService over a real GitHubProvider whose HTTP lands on
// the nock GitHub. The only fakes are the wire responses.

import { test, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import nock from "nock";
import { CachedTaskService, DuplicateTaskError } from "../src/core/service.ts";
import { ready } from "../src/core/graph.ts";
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
  const svc = new CachedTaskService({ cacheDir: cache.dir }, nockProvider({ projects: false }));
  return {
    svc,
    gh,
    project: project.dir,
    cacheDir: cache.dir,
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

test("the cache lives outside the repo, in the given cacheDir", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));

  expect(fs.existsSync(`${project}/.claude/tasks.cache.yaml`)).toBe(false); // nothing in the repo
  const files = fs.readdirSync(cacheDir);
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(`${cacheDir}/${files[0]}`, "utf8")).toContain("- schema");
  cleanup();
});

test("reads come from the cache; deps gate readiness", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["schema"]);
  await svc.close(ctx, "schema");
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["api"]);
  cleanup();
});

test("a duplicate id is refused", async () => {
  const { svc, project, cleanup } = harness();
  await svc.create({ project }, task({ id: "dup" }));
  await expect(svc.create({ project }, task({ id: "dup" }))).rejects.toThrow(DuplicateTaskError);
  cleanup();
});

test("a deleted cache is rebuilt from the issues, deps and all", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));

  // Fresh cache dir, same "remote" (the nock GitHub keeps its issues).
  const cache2 = tmp();
  const svc2 = new CachedTaskService({ cacheDir: cache2.dir }, nockProvider({ projects: false }));
  expect(await svc2.list(ctx)).toEqual([]);
  await svc2.sync(ctx);
  const api = (await svc2.list(ctx)).find((t) => t.id === "api")!;
  expect(api.deps).toEqual(["schema"]);
  expect(api.tier).toBe(2);
  cache2.cleanup();
  cleanup();
});

test("sync pushes a task the provider never saw (created offline)", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "a" }));
  gh.issues.length = 0; // the "remote" lost it
  await svc.sync(ctx);
  expect(gh.issues).toHaveLength(1); // re-created on sync
  expect(gh.issues[0].body).toContain("id: a");
  cleanup();
});

test("sync adopts a hand-opened issue and stamps our block onto it", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  gh.issues.push({
    id: "I_9",
    number: 9,
    title: "reported bug",
    body: "someone typed this into github",
    state: "OPEN",
  });
  await svc.sync(ctx);
  expect((await svc.get(ctx, "gh-9"))?.title).toBe("reported bug");
  expect(gh.issues[0].body).toContain("id: gh-9"); // stamped back
  expect(gh.issues[0].body).toContain("someone typed this into github"); // prose kept
  cleanup();
});
