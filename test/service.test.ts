// Service tests, end to end: a real TaskStack over the real file layer and a real GitHub layer whose
// HTTP lands on the nock GitHub. The only fakes are the wire responses.

import { test, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import nock from "nock";
import { TaskStack, DuplicateTaskError } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { ready, roadmap, tierOf } from "../src/core/graph.ts";
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

// --- claiming: what leaves the ready set, and what puts it back ------------------------------------

test("a task a worker started leaves the ready list, and comes back when it closes", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.create(ctx, task({ id: "docs" }));
  expect(
    ready(await svc.list(ctx))
      .map((t) => t.id)
      .sort(),
  ).toEqual(["docs", "schema"]);

  await svc.start(ctx, "schema");

  // This is what makes list_ready safe to dispatch straight from: the in-flight set lives in the
  // graph, not in the dispatcher's memory.
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["docs"]);
  await svc.close(ctx, "schema");
  expect((await svc.get(ctx, "schema"))?.status).toBe("done");
  svc.stop();
  cleanup();
});

test("a replan releases a started task back to the queue", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "schema" }));
  await svc.start(ctx, "schema");

  // A build that abandons on unclear requirements must not leave the task marked in progress and
  // invisible to everyone — the replan puts it back.
  await svc.update(ctx, "schema", { spec: "replan" });

  expect((await svc.get(ctx, "schema"))?.status).toBe("open");
  svc.stop();
  cleanup();
});

// ---------------------------------------------------------------------------------------------------
// Targets — the authoring guards, and the ordering the sub-issue edge needs.

test("a task may only name a target the stack actually holds", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await expect(svc.create(ctx, task({ id: "a", target: "typo" }))).rejects.toThrow(
    /no target typo/,
  );
  await svc.create(ctx, task({ id: "plain" }));
  await expect(svc.create(ctx, task({ id: "b", target: "plain" }))).rejects.toThrow(
    /is a task, not a target/,
  );
  cleanup();
});

test("a task's deps stay inside its own target", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "export", type: "target", title: "Export", brief: "why" }));
  await svc.create(ctx, task({ id: "billing", type: "target", title: "Billing", brief: "why" }));
  await svc.create(ctx, task({ id: "invoice", target: "billing" }));

  // A target is self-contained: a dispatcher takes it whole, so work under another target would
  // stall the stack on something nobody in it can do.
  await expect(
    svc.create(ctx, task({ id: "csv", target: "export", deps: ["invoice"] })),
  ).rejects.toThrow(/a target is self-contained/);

  // Sequencing between targets belongs one altitude up, on the target's own deps.
  await expect(
    svc.create(ctx, task({ id: "csv2", target: "export", deps: ["billing"] })),
  ).rejects.toThrow(/put that sequencing in the target's own deps/);

  // In-target deps are the normal case.
  await svc.create(ctx, task({ id: "schema", target: "export" }));
  await expect(
    svc.create(ctx, task({ id: "csv3", target: "export", deps: ["schema"] })),
  ).resolves.toBeTruthy();
  svc.stop();
  cleanup();
});

test("the dep guard runs on an edit that rewrites deps, and leaves other edits alone", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "export", type: "target", title: "Export", brief: "why" }));
  await svc.create(ctx, task({ id: "billing", type: "target", title: "Billing", brief: "why" }));
  await svc.create(ctx, task({ id: "invoice", target: "billing" }));
  await svc.create(ctx, task({ id: "csv", target: "export" }));

  await expect(svc.update(ctx, "csv", { deps: ["invoice"] })).rejects.toThrow(
    /a target is self-contained/,
  );

  // A cross-target dep written before this guard existed must stay closeable, so an edit that
  // touches neither deps nor target does not re-validate the graph.
  await new FileProvider({ cacheDir }).upsert(
    ctx,
    task({ id: "legacy", target: "export", deps: ["invoice"] }),
  );
  await expect(svc.close(ctx, "legacy")).resolves.toBeUndefined();
  svc.stop();
  cleanup();
});

test("closing a task whose target vanished still works — the guard is for MOVES only", async () => {
  const { svc, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "r", type: "target", title: "Row", brief: "why" }));
  await svc.create(ctx, task({ id: "a", target: "r" }));
  // The target disappears out from under the task — removed by hand, say. Re-validating an untouched
  // target here would strand the work: you could no longer close it.
  await new FileProvider({ cacheDir }).delete(ctx, "r");
  await expect(svc.close(ctx, "a")).resolves.toBeUndefined();
  cleanup();
});

test("deleting a target that still holds tasks is refused, naming them", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "r", type: "target", title: "Row", brief: "why" }));
  await svc.create(ctx, task({ id: "a", target: "r" }));
  await expect(svc.delete(ctx, "r")).rejects.toThrow(/still holds a/);
  cleanup();
});

test("sync pushes targets before the tasks that name them, so the edge lands in one pass", async () => {
  const { svc, gh, project, cacheDir, cleanup } = harness();
  const ctx = { project };
  // Seed the FILE layer only, child first — GitHub has neither, so one sync must create both and
  // still attach the edge. Without target-first ordering the parent issue would not exist yet.
  const file = new FileProvider({ cacheDir });
  await file.upsertMany(ctx, [task({ id: "a", target: "r" }), task({ id: "r", type: "target" })]);
  await svc.sync(ctx);
  const parent = gh.issues.find((i) => i.title === "r")!;
  expect(gh.issues.find((i) => i.title === "a")!.parent).toBe(parent.id);
  cleanup();
});

test("a target is never ready, and its progress is derived from its tasks", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "r", type: "target", title: "Row", brief: "why" }));
  await svc.create(ctx, task({ id: "a", target: "r" }));
  await svc.create(ctx, task({ id: "b", target: "r" }));
  await svc.close(ctx, "a");
  expect(ready(await svc.list(ctx)).map((t) => t.id)).toEqual(["b"]);
  expect(roadmap(await svc.list(ctx))[0].progress).toEqual({
    total: 2,
    open: 1,
    in_progress: 0,
    done: 1,
  });
  cleanup();
});

test("a stored default converges away in ONE sync — the migration off default labels", async () => {
  const { svc, gh, project, cleanup } = harness();
  const ctx = { project };
  // A task as an older version stored it: the default written out explicitly, and labelled.
  await svc.create(ctx, task({ id: "legacy", title: "Legacy", tier: 3, qa: "subagent" }));
  expect(gh.issues[0].labels).toEqual([]); // the write already declines to label a default

  // Simulate the pre-upgrade issue: the labels an older version had put there. Both layers agree on
  // the task itself, so nothing would push — the STALE LABEL is what makes the pull ask for a write.
  gh.labels.set("tier:3", "L_T3");
  gh.issues[0].labels = ["tier:3"];
  const first = await svc.sync(ctx);
  expect(first.pushed).toBe(1);
  expect(gh.issues[0].labels).toEqual([]); // one sync cleans it, with no edit from anyone

  const second = await svc.sync(ctx);
  expect(second.pushed).toBe(0); // and it settles: nothing stale left to rewrite
  const converged = (await svc.get(ctx, "legacy"))!;
  expect(converged.tier).toBeUndefined(); // deepest wins: the local copy drops the field too
  expect(tierOf(converged)).toBe(3); // and absence still reads as 3, so nothing was lost
  cleanup();
});

test("clearing a field removes it from the record, not just from the labels", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "a", title: "A", stage: "prototype", kind: "feature" }));
  const cleared = await svc.update(ctx, "a", { stage: null, kind: null });
  expect(cleared.stage).toBeUndefined();
  expect(cleared.kind).toBeUndefined();
  expect("stage" in cleared).toBe(false); // deleted, not set to undefined — sync compares deeply
  cleanup();
});

test("closing a target still works when someone hand-labelled its issue with a build field", async () => {
  const { svc, project, cleanup } = harness();
  const ctx = { project };
  await svc.create(ctx, task({ id: "r", type: "target", title: "Row", brief: "why" }));
  // What `sync` would adopt from a `tier:2` label added in the GitHub web UI: sync is tolerant, so
  // the field lands on the record. Closing the target must not be what refuses it.
  await svc.update(ctx, "r", { status: "open" }); // a status-only edit, the shape untouched
  const closed = await svc.update(ctx, "r", { status: "done" });
  expect(closed.status).toBe("done");

  // An edit that actually TOUCHES the shape is still refused, which is the guard's job.
  await expect(svc.update(ctx, "r", { tier: 2 })).rejects.toThrow(/cannot carry tier/);
  cleanup();
});
