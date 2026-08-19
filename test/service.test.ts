// Service tests, end to end: a real TaskStack over the real file layer and a real GitHub layer whose
// HTTP lands on the nock GitHub. The only fakes are the wire responses.

import { test, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import nock from "nock";
import { TaskStack, DuplicateTaskError } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { ready } from "../src/core/graph.ts";
import { Doorbell, drainEvents, postEvent } from "../src/core/channel.ts";
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
    project: project.dir,
    cacheDir: cache.dir,
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

/** The project's task file. The cache dir also holds the event spool and any config override, so
 *  every caller here picks the YAML out rather than assuming it is the only entry. */
const taskFiles = (cacheDir: string): string[] =>
  fs.readdirSync(cacheDir).filter((f) => f.endsWith(".yaml"));

test("the file layer lives outside the repo, in the given cacheDir", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"] }));

  expect(fs.existsSync(`${project}/.claude/tasks.cache.yaml`)).toBe(false); // nothing in the repo
  const files = taskFiles(cacheDir);
  expect(files).toHaveLength(1);
  expect(fs.readFileSync(`${cacheDir}/${files[0]}`, "utf8")).toContain("- schema");
  cleanup();
});

test("reads come from the top layer; deps gate readiness", async () => {
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

test("a deleted file layer is rebuilt from the issues, deps and all", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));

  // Fresh file layer, same "remote" (the nock GitHub keeps its issues).
  const cache2 = tmp();
  const svc2 = new TaskStack({ cacheDir: cache2.dir }, [
    new FileProvider({ cacheDir: cache2.dir }),
    nockProvider({ projects: false, cacheDir: cache2.dir }),
  ]);
  expect(await svc2.list(ctx)).toEqual([]);
  await svc2.sync(ctx);
  const api = (await svc2.list(ctx)).find((t) => t.id === "api")!;
  expect(api.deps).toEqual(["schema"]);
  expect(api.tier).toBe(2);
  cache2.cleanup();
  cleanup();
});

test("sync pushes a task the remote never saw (created offline)", async () => {
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

test("a file written before the stack (with a refs key) still loads", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "old" }));
  const file = `${cacheDir}/${taskFiles(cacheDir)[0]}`;
  fs.writeFileSync(
    file,
    "tasks:\n  - id: old\n    title: from before\n    status: open\n    refs:\n      issueId: I_1\n",
  );
  expect((await svc.get(ctx, "old"))?.title).toBe("from before");
  expect((await svc.get(ctx, "old")) as never).not.toHaveProperty("refs");
  cleanup();
});

test("a mistyped config file fails loudly, naming the file and the key", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  fs.writeFileSync(`${cacheDir}/config.yaml`, "projectNumber: seven\n");
  await expect(svc.create({ project }, task({ id: "a" }))).rejects.toThrow(/invalid config/);
  cleanup();
});

test("a corrupt task file is quarantined, not fatal, and sync rebuilds it", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "api", title: "survives", tier: 2 }));
  const file = `${cacheDir}/${fs.readdirSync(cacheDir).find((f) => f.endsWith(".yaml"))}`;
  fs.writeFileSync(file, "tasks: [unclosed");

  expect(await svc.list(ctx)).toEqual([]); // quarantined, empty top layer, no crash
  expect(fs.existsSync(`${file}.corrupt`)).toBe(true); // the bad file is set aside

  await svc.sync(ctx);
  const api = (await svc.get(ctx, "api"))!;
  expect(api.title).toBe("survives"); // rebuilt from GitHub, link intact
  expect(api.tier).toBe(2);
  cleanup();
});

test("sync reports real conflicts when two issues claim one task id", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "api" }));
  gh.issues.push({
    id: "I_50",
    number: 50,
    title: "duplicate",
    body: "<!-- outputty:task\nid: api\n-->",
    state: "OPEN",
  });

  expect((await svc.sync(ctx)).conflicts).toBe(1); // no longer hardwired 0
  cleanup();
});

// --- the background poll: what actually rings the channel -------------------------------------------

/** A doorbell wired to an array, so a test can read what it delivered. */
function recordingBell(): { bell: Doorbell; rung: string[] } {
  const bell = new Doorbell();
  const rung: string[] = [];
  bell.on((note) => void rung.push(note));
  return { bell, rung };
}

/** The harness with a doorbell attached, plus the notes it delivered. */
function ringingHarness() {
  installNock(new NockGitHub());
  const project = tmpRepo();
  const cache = tmp();
  const { bell, rung } = recordingBell();
  const layers = [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ];
  const svc = new TaskStack({ cacheDir: cache.dir }, layers, undefined, bell);
  const cleanup = () => {
    project.cleanup();
    cache.cleanup();
  };
  return { svc, rung, project: project.dir, cacheDir: cache.dir, settle, cleanup };
}

/** Let the doorbell's coalescing timer fire. */
const settle = () => new Promise((r) => setTimeout(r, 5));

test("the background poll rings when what can be started changes, and stays quiet when it does not", async () => {
  const { svc, rung, project, settle, cleanup } = ringingHarness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));

  await svc.syncSeen(); // first pass: a startable task appeared
  await settle();
  expect(rung).toEqual(["ready now: schema — re-evaluate"]); // the ring names which way to look

  await svc.syncSeen(); // nothing moved
  await settle();
  expect(rung).toHaveLength(1);

  await svc.create(ctx, task({ id: "parser" }));
  await svc.syncSeen();
  await settle();
  expect(rung).toHaveLength(2);
  cleanup();
});

test("a poll that finds nothing startable does not wake the session at startup", async () => {
  const { svc, rung, project, settle, cleanup } = ringingHarness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "later", spec: "drafting" })); // planning owns it, no worker can start
  await svc.syncSeen();
  await settle();
  expect(rung).toEqual([]);
  cleanup();
});

test("a note another process spooled is delivered on the next poll", async () => {
  const { svc, rung, project, cacheDir, settle, cleanup } = ringingHarness();
  await svc.list({ project }); // the server only polls projects it has served
  postEvent(cacheDir, project, "spec gate on channel-emitter", 999_999);

  await svc.syncSeen();
  await settle();
  expect(rung).toContain("spec gate on channel-emitter");
  cleanup();
});

test("closing a task spools a note for every other process, naming what moved", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  drainEvents(cacheDir, project, 999_999); // the create's own note, consumed

  await svc.close(ctx, "schema");

  // Drained as ANOTHER session would drain it: our own pid is filtered out of our own reads, and a
  // closure has to travel, or the orchestrator learns of it only on its next background sync.
  expect(drainEvents(cacheDir, project, 999_999)).toEqual(["task schema closed — re-evaluate"]);
  svc.stop();
  cleanup();
});

test("an edit that only touches prose spools nothing — a retitled task is not news", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  drainEvents(cacheDir, project, 999_999);

  await svc.update(ctx, "schema", { title: "Design the schema" });

  expect(drainEvents(cacheDir, project, 999_999)).toEqual([]);
  svc.stop();
  cleanup();
});

test("a dependency change spools, because it can move what is ready", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "api" }));
  drainEvents(cacheDir, project, 999_999);

  await svc.update(ctx, "api", { deps: ["schema"] });

  expect(drainEvents(cacheDir, project, 999_999)).toEqual([
    "task api changed its dependencies — re-evaluate",
  ]);
  svc.stop();
  cleanup();
});
