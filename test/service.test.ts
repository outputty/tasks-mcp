import { test, expect } from "bun:test";
import fs from "fs";
import { CachedTaskService } from "../src/service.ts";
import { GitHubProvider } from "../src/providers/github/github.ts";
import { ready, withDefaults } from "../src/graph.ts";
import type { ProjectConfig, Task } from "../src/types.ts";
import { FakeGitHub, envFor, tmpProject } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);

// A service with the cache in its own temp dir (never the repo) and a fake-GitHub provider.
function harness(
  gh = new FakeGitHub(),
  config: ProjectConfig = { projects: false },
) {
  const project = tmpProject();
  const cache = tmpProject();
  const svc = new CachedTaskService(
    { cacheDir: cache.dir },
    new GitHubProvider(async () => envFor(gh, config)),
  );
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
  expect(fs.readFileSync(`${cacheDir}/${files[0]}`, "utf8")).toContain(
    "- schema",
  ); // the dep edge
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

test("create mirrors the task to a GitHub issue (id in the body)", async () => {
  const { svc, gh, project, cleanup } = harness();
  await svc.create(
    { project },
    task({ id: "api", title: "Build the API", deps: ["schema"] }),
  );
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].body).toContain("id: api");
  expect(gh.issues[0].body).toContain("schema");
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

test("a deleted cache is rebuilt from GitHub, deps and all", async () => {
  const gh = new FakeGitHub();
  const h1 = harness(gh);
  const ctx = { project: h1.project };
  await h1.svc.create(ctx, task({ id: "schema" }));
  await h1.svc.create(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));

  // Fresh machine: a brand-new empty cache dir, the same GitHub behind it.
  const cache2 = tmpProject();
  const svc2 = new CachedTaskService(
    { cacheDir: cache2.dir },
    new GitHubProvider(async () => envFor(gh, { projects: false })),
  );
  expect(await svc2.list(ctx)).toEqual([]); // empty before sync
  await svc2.sync(ctx);
  const api = (await svc2.list(ctx)).find((t) => t.id === "api")!;
  expect(api.deps).toEqual(["schema"]); // recovered from the issue body
  expect(api.tier).toBe(2);
  h1.cleanup();
  cache2.cleanup();
});

test("sync pulls a status change made on GitHub back into the cache", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "t-1" }));
  gh.issues[0].state = "CLOSED"; // closed in the UI
  const result = await svc.sync(ctx);
  expect(result.pulled).toBe(1);
  expect((await svc.get(ctx, "t-1"))?.status).toBe("done");
  cleanup();
});

test("sync adopts a hand-opened issue, stamps it, and stays stable", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  gh.issues.push({
    id: "I_7",
    number: 7,
    title: "reported bug",
    body: "plain text",
    state: "OPEN",
  });

  await svc.sync(ctx);
  expect((await svc.get(ctx, "gh-7"))?.title).toBe("reported bug");
  expect(gh.issues[0].body).toContain("id: gh-7"); // stamped as managed
  expect(gh.issues[0].body).toContain("plain text"); // human text preserved

  await svc.sync(ctx); // idempotent
  expect((await svc.list(ctx)).length).toBe(1);
  cleanup();
});

test("sync reads a board Done back and closes the issue to match", async () => {
  const gh = new FakeGitHub();
  const { svc, project, cleanup } = harness(gh, {}); // Projects on
  const ctx = { project };
  await svc.create(ctx, task({ id: "api" })); // issue open, card Todo
  [...gh.items.values()][0].status = "OPT_DONE"; // drag the card to Done

  await svc.sync(ctx);
  expect((await svc.get(ctx, "api"))?.status).toBe("done");
  expect(gh.issues[0].state).toBe("CLOSED"); // reconcile closed the issue
  cleanup();
});
