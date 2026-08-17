import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { task, tmpRepo } from "./helpers.ts";
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
  return { gh, provider: nockProvider(options), ctx: { project: repo.dir } };
}

test("create sends a createIssue with the id in the body and no labels", async () => {
  const { gh, provider, ctx } = setup();
  const refs = await provider.create(
    ctx,
    task({ id: "api", title: "API", tier: 2, deps: ["schema"] }),
  );
  expect(refs.issueId).toBe("I_1");
  expect(gh.issues[0].body).toContain("id: api");
  expect(gh.issues[0].body).toContain("tier: 2");
  expect(gh.issues[0].body).toContain("schema");
});

test("a done task is created then closed via closeIssue", async () => {
  const { gh, provider, ctx } = setup();
  await provider.create(ctx, task({ id: "t-1", status: "done" }));
  expect(gh.issues[0].state).toBe("CLOSED");
});

test("update rewrites the body and preserves human prose below the block", async () => {
  const { gh, provider, ctx } = setup();
  const refs = await provider.create(ctx, task({ id: "t-1", title: "old" }));
  gh.issues[0].body += "\nHuman note: see the design.";
  await provider.update(ctx, task({ id: "t-1", title: "new", tier: 4 }), refs);
  expect(gh.issues[0].title).toBe("new");
  expect(gh.issues[0].body).toContain("tier: 4");
  expect(gh.issues[0].body).toContain("Human note: see the design.");
});

test("pull reconstructs full tasks (deps) from bodies and adopts hand-opened issues", async () => {
  const { gh, provider, ctx } = setup();
  await provider.create(ctx, task({ id: "api", deps: ["schema"], tier: 2 }));
  gh.issues.push({
    id: "I_99",
    number: 99,
    title: "hand-written",
    body: "just a normal issue",
    state: "OPEN",
  });

  const remote = await provider.pull(ctx);
  expect([...remote.keys()].sort()).toEqual(["api", "gh-99"]);
  expect(remote.get("api")!.patch.deps).toEqual(["schema"]); // deps recovered from the body
  expect(remote.get("api")!.patch.tier).toBe(2);
  expect(remote.get("gh-99")!.reconcile).toBe(true); // hand-opened → needs stamping
});

test("with Projects on, a card moved to Done pulls back as done + reconcile", async () => {
  const { gh, provider, ctx } = setup({});
  const refs = await provider.create(ctx, task({ id: "api" })); // issue open, card Todo
  gh.items.get(refs.projectItem!)!.status = "OPT_DONE"; // dragged to Done
  const state = (await provider.pull(ctx)).get("api")!;
  expect(state.patch.status).toBe("done");
  expect(state.reconcile).toBe(true);
});

test("a Projects failure never fails the task write (best-effort)", async () => {
  const { gh, provider, ctx } = setup({ projectNumber: 404 });
  gh.boards = []; // no board, and #404 can't be created
  const refs = await provider.create(ctx, task({ id: "api" }));
  expect(refs.issueId).toBe("I_1"); // the issue still lands
  expect(refs.projectItem).toBeUndefined(); // board skipped
});
