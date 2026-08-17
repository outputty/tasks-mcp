import { test, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { CachedTaskService } from "../src/service.ts";
import { GitHubIssuesTarget } from "../src/sync/github-issues.ts";
import { ready } from "../src/graph.ts";
import { withDefaults } from "../src/graph.ts";
import type { Task } from "../src/types.ts";
import { FakeGitHub, envFor, tmpProject } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);

function service(gh = new FakeGitHub()) {
  return new CachedTaskService(
    async () => envFor(gh),
    [new GitHubIssuesTarget()],
  );
}

test("deps live in the committed cache, not the backend", async () => {
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

test("reads come from the cache, so they never see GitHub's list lag", async () => {
  const { dir, cleanup } = tmpProject();
  const svc = service();
  const ctx = { project: dir };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));

  // Immediately readable — the create wrote the cache synchronously.
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["schema"]);
  await svc.close(ctx, "schema");
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["api"]);
  cleanup();
});

test("create mirrors the task to a GitHub issue with the id label", async () => {
  const { dir, cleanup } = tmpProject();
  const gh = new FakeGitHub();
  const svc = service(gh);
  await svc.create(
    { project: dir },
    task({ id: "api", title: "Build the API", deps: ["schema"] }),
  );
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].title).toBe("Build the API");
  expect(gh.issues[0].labels).toContainEqual({ name: "outputty:id:api" });
  expect(gh.issues[0].body).toContain("schema"); // deps mirrored into the body for a human reader
  cleanup();
});

test("close marks the task done and closes the issue", async () => {
  const { dir, cleanup } = tmpProject();
  const gh = new FakeGitHub();
  const svc = service(gh);
  await svc.create({ project: dir }, task({ id: "t-1" }));
  await svc.close({ project: dir }, "t-1");
  expect((await svc.get({ project: dir }, "t-1"))?.status).toBe("done");
  expect(gh.issues[0].state).toBe("closed");
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

test("sync adopts an issue created directly in GitHub and re-pushes the graph", async () => {
  const { dir, cleanup } = tmpProject();
  const gh = new FakeGitHub();
  const svc = service(gh);
  await svc.create({ project: dir }, task({ id: "known" }));
  // Someone opens an outputty-labelled issue straight in the GitHub UI.
  gh.issues.push({
    number: 99,
    node_id: "ISSUE_99",
    title: "from the UI",
    state: "open",
    body: "",
    labels: [{ name: "outputty:id:from-ui" }],
  });

  const result = await svc.sync({ project: dir });
  expect(result.pulled).toBeGreaterThanOrEqual(2);
  const ids = (await svc.list({ project: dir })).map((t) => t.id).sort();
  expect(ids).toEqual(["from-ui", "known"]);
  cleanup();
});
