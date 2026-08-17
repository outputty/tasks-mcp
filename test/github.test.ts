import { test, expect } from "bun:test";
import { GitHubProvider } from "../src/providers/github/github.ts";
import { withDefaults } from "../src/graph.ts";
import type { ProjectConfig, Task } from "../src/types.ts";
import { FakeGitHub, envFor } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);
const ctx = { project: "/tmp/whatever" };
const provider = (gh: FakeGitHub, config: ProjectConfig = {}) =>
  new GitHubProvider(async () => envFor(gh, config));

test("create stores the id in the issue body — no labels anywhere", async () => {
  const gh = new FakeGitHub();
  const refs = await provider(gh, { projects: false }).create(
    ctx,
    task({ id: "api", title: "API", tier: 2, deps: ["schema"] }),
  );
  expect(refs.issueId).toBe("I_1");
  expect(gh.issues[0].body).toContain("id: api");
  expect(gh.issues[0].body).toContain("tier: 2");
  expect(gh.issues[0].body).toContain("schema");
  expect(gh.issues[0].title).toBe("API");
});

test("a done task is created closed", async () => {
  const gh = new FakeGitHub();
  await provider(gh, { projects: false }).create(
    ctx,
    task({ id: "t-1", status: "done" }),
  );
  expect(gh.issues[0].state).toBe("CLOSED");
});

test("update rewrites the body and preserves human prose below the block", async () => {
  const gh = new FakeGitHub();
  const p = provider(gh, { projects: false });
  const refs = await p.create(ctx, task({ id: "t-1", title: "old" }));
  gh.issues[0].body = gh.issues[0].body + "\nHuman note: see the design.";
  await p.update(ctx, task({ id: "t-1", title: "new", tier: 4 }), refs);
  expect(gh.issues[0].title).toBe("new");
  expect(gh.issues[0].body).toContain("tier: 4");
  expect(gh.issues[0].body).toContain("Human note: see the design.");
});

test("pull returns managed issues and ignores issues without the block", async () => {
  const gh = new FakeGitHub();
  const p = provider(gh, { projects: false });
  await p.create(ctx, task({ id: "mine", title: "mine" }));
  gh.issues.push({
    id: "I_99",
    number: 99,
    title: "hand-written",
    body: "just a normal issue",
    state: "OPEN",
  });
  gh.issues[0].state = "CLOSED";
  const remote = await p.pull(ctx);
  expect([...remote.keys()]).toEqual(["mine"]);
  expect(remote.get("mine")).toEqual({
    patch: { title: "mine", status: "done" },
    refs: { issueId: "I_1" },
  });
});

test("with Projects on, the issue becomes a board card in the right column", async () => {
  const gh = new FakeGitHub();
  const refs = await provider(gh).create(ctx, task({ id: "api" }));
  expect(refs.projectItem).toBe("ITEM1");
  expect([...gh.items.values()][0]).toEqual({
    contentId: "I_1",
    status: "OPT_TODO",
  });
});

test("a Projects failure never fails the task write (best-effort)", async () => {
  const gh = new FakeGitHub();
  // Break Projects only: no boards and a config that forbids creating one.
  gh.boards = [];
  const refs = await provider(gh, { projectNumber: 404 }).create(
    ctx,
    task({ id: "api" }),
  );
  expect(refs.issueId).toBe("I_1"); // issue still created
  expect(refs.projectItem).toBeUndefined(); // board skipped
});
