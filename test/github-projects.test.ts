import { test, expect } from "bun:test";
import { GitHubProjectsTarget } from "../src/sync/github-projects.ts";
import { withDefaults } from "../src/graph.ts";
import type { Task } from "../src/types.ts";
import { envFor, fakeGraphql } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);
const ctx = { project: "/tmp/whatever" };
// The issue node id is supplied via refs in these tests, so the resolver is never called.
const target = () => new GitHubProjectsTarget(async () => null);

test("push adds the issue to the board and sets its status column", async () => {
  const gql = fakeGraphql();
  const refs = await target().push(
    envFor(undefined, gql),
    ctx,
    task({ id: "api" }),
    { issueNodeId: "ISSUE_1" },
  );
  expect(refs.projectItem).toBe("ITEM1");
  expect([...gql.items.values()][0]).toEqual({
    contentId: "ISSUE_1",
    status: "OPT_TODO",
  });
});

test("a done task lands in the Done column", async () => {
  const gql = fakeGraphql();
  await target().push(
    envFor(undefined, gql),
    ctx,
    task({ id: "api", status: "done" }),
    { issueNodeId: "ISSUE_1" },
  );
  expect([...gql.items.values()][0].status).toBe("OPT_DONE");
});

test("an existing project item is reused, not added twice", async () => {
  const gql = fakeGraphql();
  const t = target();
  const refs = await t.push(envFor(undefined, gql), ctx, task({ id: "api" }), {
    issueNodeId: "ISSUE_1",
  });
  await t.push(
    envFor(undefined, gql),
    ctx,
    task({ id: "api", status: "done" }),
    refs,
  );
  expect(gql.items.size).toBe(1);
  expect([...gql.items.values()][0].status).toBe("OPT_DONE");
});

test("with no board present, one is created and linked", async () => {
  const gql = fakeGraphql({ boards: [] });
  const refs = await target().push(
    envFor(undefined, gql),
    ctx,
    task({ id: "api" }),
    { issueNodeId: "ISSUE_1" },
  );
  expect(refs.projectItem).toBe("ITEM1");
});

test("Projects is skipped when disabled in config", () => {
  expect(
    target().enabled(envFor(undefined, fakeGraphql(), { projects: false })),
  ).toBe(false);
  expect(target().enabled(envFor(undefined, fakeGraphql(), {}))).toBe(true);
});
