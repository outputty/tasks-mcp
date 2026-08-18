import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
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

function setup(options: Record<string, unknown> = { projects: false }) {
  const gh = installNock(new NockGitHub());
  const repo = tmpRepo();
  const cache = tmp();
  return {
    gh,
    provider: nockProvider({ cacheDir: cache.dir, ...options }),
    cacheDir: cache.dir,
    ctx: { project: repo.dir },
  };
}

test("upsert of a new id creates an issue: id and deps in the body, scalars as labels", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(
    ctx,
    task({ id: "api", title: "API", tier: 2, priority: "high", deps: ["schema"] }),
  );
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].body).toContain("id: api");
  expect(gh.issues[0].body).toContain("schema");
  expect(gh.issues[0].body).not.toContain("tier"); // label-worn, not in the block
  expect(gh.issues[0].labels).toEqual(["tier:2", "priority:high"]);
});

test("upsert of a known id updates the issue instead of duplicating it", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", title: "old" }));
  await provider.upsert(ctx, task({ id: "api", title: "new" }));
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].title).toBe("new");
});

test("a done task is created then closed", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", status: "done" }));
  expect(gh.issues[0].state).toBe("CLOSED");
});

test("upsert rewrites the body and preserves human prose below the block", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", title: "old" }));
  gh.issues[0].body += "\nHuman note: see the design.";
  await provider.upsert(ctx, task({ id: "t-1", title: "new", tier: 4 }));
  expect(gh.issues[0].title).toBe("new");
  expect(gh.issues[0].labels).toContain("tier:4");
  expect(gh.issues[0].body).toContain("Human note: see the design.");
});

test("the body carries a VISIBLE spec that regenerates, and still round-trips through the block", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", title: "API", brief: "first brief" }));
  // The brief is visible — after the hidden machine block, not only inside it.
  const visible = gh.issues[0].body.slice(gh.issues[0].body.indexOf("-->") + 3);
  expect(visible).toContain("first brief");
  // A changed brief REGENERATES the visible spec — the old text is gone, never duplicated.
  await provider.upsert(ctx, task({ id: "api", title: "API", brief: "second brief" }));
  expect(gh.issues[0].body).toContain("second brief");
  expect(gh.issues[0].body).not.toContain("first brief");
  // pull still reconstructs the brief from the machine block (BUILD/get_task keep working).
  expect((await provider.pull(ctx)).get("api")!.task.brief).toBe("second brief");
});

test("an update keeps foreign labels and replaces only the field labels", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", tier: 2 }));
  gh.labels.set("bug", "L_BUG");
  gh.issues[0].labels = ["bug", "tier:2"]; // a human added `bug` in the UI
  await provider.upsert(ctx, task({ id: "t-1", tier: 3 }));
  expect(gh.issues[0].labels).toEqual(["bug", "tier:3"]);
});

test("labels flow back on pull, and win over a legacy body block", async () => {
  const { gh, provider, ctx } = setup();
  gh.labels.set("tier:1", "L_T1");
  gh.labels.set("qa:skip", "L_QS");
  gh.issues.push({
    id: "I_50",
    number: 50,
    title: "legacy",
    body: "<!-- outputty:task\nid: legacy\ntier: 4\n-->",
    state: "OPEN",
    labels: ["tier:1", "qa:skip"],
  });
  const state = (await provider.pull(ctx)).get("legacy")!;
  expect(state.task.tier).toBe(1); // the label wins over the block
  expect(state.task.qa).toBe("skip");
});

test("a hand-typed junk label value is ignored, not crashed on", async () => {
  const { gh, provider, ctx } = setup();
  gh.labels.set("tier:banana", "L_TB");
  gh.issues.push({
    id: "I_60",
    number: 60,
    title: "typo",
    body: "<!-- outputty:task\nid: typo\n-->",
    state: "OPEN",
    labels: ["tier:banana"],
  });
  expect((await provider.pull(ctx)).get("typo")!.task.tier).toBeUndefined();
});

test("the index survives a fresh provider: an existing issue is found, not re-created", async () => {
  const { gh, ctx, cacheDir } = setup();
  const options = { projects: false, cacheDir };
  await nockProvider(options).upsert(ctx, task({ id: "api", title: "one" }));
  // A different provider instance (fresh in-memory index) — it must rediscover the issue by listing.
  await nockProvider(options).upsert(ctx, task({ id: "api", title: "two" }));
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].title).toBe("two");
});

test("pull reconstructs full tasks (deps) from bodies and adopts hand-opened issues", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));
  gh.issues.push({
    id: "I_99",
    number: 99,
    title: "hand-written",
    body: "just a normal issue",
    state: "OPEN",
  });

  const remote = await provider.pull(ctx);
  expect([...remote.keys()].sort()).toEqual(["api", "gh-99"]);
  expect(remote.get("api")!.task.deps).toEqual(["schema"]); // deps recovered from the body
  expect(remote.get("api")!.task.tier).toBe(2);
  expect(remote.get("gh-99")!.reconcile).toBe(true); // hand-opened → needs stamping
});

test("with Projects on, a card moved to Done pulls back as done + reconcile", async () => {
  const { gh, provider, ctx } = setup({});
  await provider.upsert(ctx, task({ id: "api" })); // issue open, card Todo
  const itemId = [...gh.items.keys()][0];
  gh.items.get(itemId)!.status = "OPT_DONE"; // dragged to Done
  const state = (await provider.pull(ctx)).get("api")!;
  expect(state.task.status).toBe("done");
  expect(state.reconcile).toBe(true);
});

test("a Projects failure never fails the task write (best-effort)", async () => {
  const { gh, provider, ctx } = setup({ projectNumber: 404 });
  gh.boards = []; // no board, and #404 can't be created
  await provider.upsert(ctx, task({ id: "api" }));
  expect(gh.issues).toHaveLength(1); // the issue still lands
  expect(gh.items.size).toBe(0); // board skipped
});

test("two issues claiming one id: the oldest is the record, the pull flags a conflict", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", title: "the original" }));
  gh.issues.push({
    id: "I_99",
    number: 99,
    title: "an impostor",
    body: "<!-- outputty:task\nid: api\n-->",
    state: "OPEN",
  });

  const state = (await provider.pull(ctx)).get("api")!;
  expect(state.task.title).toBe("the original"); // oldest wins
  expect(state.conflict).toBe(true);

  await provider.upsert(ctx, task({ id: "api", title: "renamed" }));
  expect(gh.issues[0].title).toBe("renamed"); // updates resolve to the oldest…
  expect(gh.issues[1].title).toBe("an impostor"); // …the newer duplicate is never touched
});
