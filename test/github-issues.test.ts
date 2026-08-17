import { test, expect } from "bun:test";
import { GitHubIssuesTarget } from "../src/sync/github-issues.ts";
import { withDefaults } from "../src/graph.ts";
import type { Task } from "../src/types.ts";
import { FakeGitHub, envFor } from "./fake-github.ts";

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);
const ctx = { project: "/tmp/whatever" };

test("push creates an issue carrying the id label and the structured body", async () => {
  const gh = new FakeGitHub();
  const target = new GitHubIssuesTarget();
  const refs = await target.push(
    envFor(gh),
    ctx,
    task({ id: "api", title: "API", tier: 2, qa: "inline" }),
    {},
  );
  expect(refs.issue).toBe(1);
  expect(refs.issueNodeId).toBe("ISSUE_1");
  expect(gh.issues[0].labels).toContainEqual({ name: "outputty:id:api" });
  expect(gh.issues[0].body).toContain("tier: 2");
  expect(gh.issues[0].body).toContain("qa: inline");
});

test("push with a known ref updates in place instead of creating a second issue", async () => {
  const gh = new FakeGitHub();
  const target = new GitHubIssuesTarget();
  const refs = await target.push(
    envFor(gh),
    ctx,
    task({ id: "t-1", title: "old" }),
    {},
  );
  await target.push(envFor(gh), ctx, task({ id: "t-1", title: "new" }), refs);
  expect(gh.issues).toHaveLength(1);
  expect(gh.issues[0].title).toBe("new");
});

test("push preserves human prose written below the metadata block", async () => {
  const gh = new FakeGitHub();
  const target = new GitHubIssuesTarget();
  const refs = await target.push(envFor(gh), ctx, task({ id: "t-1" }), {});
  gh.issues[0].body = gh.issues[0].body + "\nHuman note: see the design.";
  await target.push(envFor(gh), ctx, task({ id: "t-1", tier: 4 }), refs);
  expect(gh.issues[0].body).toContain("Human note: see the design.");
  expect(gh.issues[0].body).toContain("tier: 4");
});

test("pull reports status for outputty issues and ignores the rest", async () => {
  const gh = new FakeGitHub();
  const target = new GitHubIssuesTarget();
  await target.push(envFor(gh), ctx, task({ id: "t-1", title: "mine" }), {});
  gh.issues.push({
    number: 50,
    title: "not mine",
    state: "open",
    body: "",
    labels: [{ name: "bug" }],
  });
  gh.issues[0].state = "closed";
  const changes = await target.pull(envFor(gh), ctx);
  expect([...changes.keys()]).toEqual(["t-1"]);
  expect(changes.get("t-1")).toEqual({ title: "mine", status: "done" });
});
