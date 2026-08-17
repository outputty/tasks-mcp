import { test, expect } from "vitest";
import fs from "node:fs";
import { CachedTaskService } from "../src/core/service.ts";
import { ready } from "../src/core/graph.ts";
import { task, tmp } from "./helpers.ts";
import { FakeProvider } from "./fake-provider.ts";

function harness(provider = new FakeProvider()) {
  const project = tmp();
  const cache = tmp();
  const svc = new CachedTaskService({ cacheDir: cache.dir }, provider);
  return {
    svc,
    provider,
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
  expect(fs.readFileSync(`${cacheDir}/${files[0]}`, "utf8")).toContain(
    "- schema",
  );
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
  await expect(svc.create({ project }, task({ id: "dup" }))).rejects.toThrow(
    /already exists/,
  );
  cleanup();
});

test("a deleted cache is rebuilt from the provider, deps and all", async () => {
  const provider = new FakeProvider();
  const h1 = harness(provider);
  const ctx = { project: h1.project };
  await h1.svc.create(ctx, task({ id: "schema" }));
  await h1.svc.create(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));

  // Fresh cache dir, same provider (the "remote").
  const cache2 = tmp();
  const svc2 = new CachedTaskService({ cacheDir: cache2.dir }, provider);
  expect(await svc2.list(ctx)).toEqual([]);
  await svc2.sync(ctx);
  const api = (await svc2.list(ctx)).find((t) => t.id === "api")!;
  expect(api.deps).toEqual(["schema"]);
  expect(api.tier).toBe(2);
  h1.cleanup();
  cache2.cleanup();
});

test("sync pushes a task the provider never saw (created offline)", async () => {
  const { svc, provider, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "a" }));
  provider.remote.delete("a"); // the provider "forgot" it
  provider.created.length = 0;
  await svc.sync(ctx);
  expect(provider.created.map((t) => t.id)).toContain("a"); // re-created on sync
  cleanup();
});

test("sync pushes back a task the provider flagged for reconcile", async () => {
  const { svc, provider, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "a" }));
  provider.remote.get("a")!.reconcile = true;
  await svc.sync(ctx);
  expect(provider.updated.map((t) => t.id)).toContain("a");
  cleanup();
});

test("sync adopts a task the provider has but the cache does not", async () => {
  const { svc, provider, project, cleanup } = harness();
  const ctx = { project };
  provider.remote.set("gh-5", {
    task: task({ id: "gh-5", title: "reported bug" }),
    refs: { issueId: "I_9" },
    reconcile: true,
  });
  await svc.sync(ctx);
  expect((await svc.get(ctx, "gh-5"))?.title).toBe("reported bug");
  expect(provider.updated.map((t) => t.id)).toContain("gh-5"); // stamped back
  cleanup();
});
