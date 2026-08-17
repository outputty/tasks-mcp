import { test, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { CachedTaskService } from "../src/service.ts";
import { GitHubProvider } from "../src/providers/github/github.ts";
import { ready, withDefaults } from "../src/graph.ts";
import type { Task } from "../src/types.ts";
import { FakeGitHub, envFor, tmpProject } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);

function service(gh = new FakeGitHub()) {
  return new CachedTaskService(
    new GitHubProvider(async () => envFor(gh, { projects: false })),
  );
}

test("deps live in the committed cache, not the provider", async () => {
  const { dir, cleanup } = tmpProject();
  const svc = service();
  const ctx = { project: dir };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));

  const cacheFile = fs.readFileSync(
    path.join(dir, ".claude", "tasks.cache.yaml"),
    "utf8",
  );
  expect(cacheFile).toContain("id: api");
  expect(cacheFile).toContain("- schema"); // the dependency edge is in the committed file
  cleanup();
});

test("reads come from the cache; deps gate readiness", async () => {
  const { dir, cleanup } = tmpProject();
  const svc = service();
  const ctx = { project: dir };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["schema"]);
  await svc.close(ctx, "schema");
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["api"]);
  cleanup();
});

test("create mirrors the task to a GitHub issue (id in the body)", async () => {
  const { dir, cleanup } = tmpProject();
  const gh = new FakeGitHub();
  await service(gh).create(
    { project: dir },
    task({ id: "api", title: "Build the API", deps: ["schema"] }),
  );
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].body).toContain("id: api");
  expect(gh.issues[0].body).toContain("schema");
  cleanup();
});

test("a duplicate id is refused", async () => {
  const { dir, cleanup } = tmpProject();
  const svc = service();
  await svc.create({ project: dir }, task({ id: "dup" }));
  await expect(
    svc.create({ project: dir }, task({ id: "dup" })),
  ).rejects.toThrow(/already exists/);
  cleanup();
});

test("sync pulls a status change made on GitHub back into the cache", async () => {
  const { dir, cleanup } = tmpProject();
  const gh = new FakeGitHub();
  const svc = service(gh);
  const ctx = { project: dir };
  await svc.create(ctx, task({ id: "t-1" }));
  // Someone closes the issue in the GitHub UI.
  gh.issues[0].state = "CLOSED";

  const result = await svc.sync(ctx);
  expect(result.pulled).toBe(1);
  expect((await svc.get(ctx, "t-1"))?.status).toBe("done");
  cleanup();
});
