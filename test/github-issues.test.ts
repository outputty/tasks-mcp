import { test, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { GitHubIssuesBackend } from "../src/backends/github-issues.ts";
import { withDefaults } from "../src/graph.ts";
import type { ProjectContext, Task } from "../src/types.ts";
import { FakeGitHub } from "./fake-github.ts";

const CTX: ProjectContext = { project: "/tmp/whatever" };

function make() {
  const gh = new FakeGitHub();
  const backend = new GitHubIssuesBackend(async () => ({
    octokit: gh,
    repo: { owner: "outputty", repo: "demo" },
  }));
  return { gh, backend };
}

const task = (over: Partial<Task> & { id: string }): Task => withDefaults(over);

test("create then get round-trips the structured fields through the issue body", async () => {
  const { backend } = make();
  await backend.create(
    CTX,
    task({
      id: "api",
      title: "Build the API",
      deps: ["schema"],
      scope: ["src/api"],
      tier: 2,
      qa: "inline",
      brief: "wire it",
    }),
  );
  const got = await backend.get(CTX, "api");
  expect(got).toMatchObject({
    id: "api",
    title: "Build the API",
    status: "open",
    deps: ["schema"],
    scope: ["src/api"],
    tier: 2,
    qa: "inline",
    brief: "wire it",
  });
});

test("the id is stored as a label so lookups survive a title edit", async () => {
  const { gh, backend } = make();
  await backend.create(CTX, task({ id: "t-1", title: "old" }));
  await backend.update(CTX, "t-1", { title: "new title" });
  expect(gh.issues[0].title).toBe("new title");
  expect((await backend.get(CTX, "t-1"))?.title).toBe("new title");
});

test("close marks the issue closed and the task done", async () => {
  const { gh, backend } = make();
  await backend.create(CTX, task({ id: "t-1" }));
  await backend.close(CTX, "t-1");
  expect(gh.issues[0].state).toBe("closed");
  expect((await backend.get(CTX, "t-1"))?.status).toBe("done");
});

test("list ignores issues without an outputty id label and pull requests", async () => {
  const { gh, backend } = make();
  await backend.create(CTX, task({ id: "t-1", title: "mine" }));
  gh.issues.push({
    number: 99,
    title: "someone else's issue",
    state: "open",
    body: "",
    labels: [{ name: "bug" }],
  });
  gh.issues.push({
    number: 100,
    title: "a PR",
    state: "open",
    body: "",
    labels: [{ name: "outputty:id:pr" }],
    pull_request: {},
  });
  const tasks = await backend.list(CTX);
  expect(tasks.map((t) => t.id)).toEqual(["t-1"]);
});

test("update preserves human prose written below the metadata block", async () => {
  const { gh, backend } = make();
  await backend.create(CTX, task({ id: "t-1", title: "x" }));
  // A human edits the issue body, adding prose under the hidden block.
  gh.issues[0].body =
    gh.issues[0].body + "\nHuman note: see the linked design.";
  await backend.update(CTX, "t-1", { tier: 4 });
  expect(gh.issues[0].body).toContain("Human note: see the linked design.");
  expect((await backend.get(CTX, "t-1"))?.tier).toBe(4);
});

test("creating a duplicate id is refused", async () => {
  const { backend } = make();
  await backend.create(CTX, task({ id: "dup" }));
  await expect(backend.create(CTX, task({ id: "dup" }))).rejects.toThrow(
    /already exists/,
  );
});

test("provisioning creates the marker label exactly once", async () => {
  const { gh, backend } = make();
  await backend.create(CTX, task({ id: "a" }));
  await backend.create(CTX, task({ id: "b" }));
  expect(gh.labels.has("outputty")).toBe(true);
});

test("sync pulls issues into a snapshot and pushes seed tasks that have no issue", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-mcp-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "tasks.seed.yaml"),
    "- id: seeded\n  title: from the seed file\n  deps: []\n  scope: []\n",
  );
  const ctx: ProjectContext = { project: dir };
  const { backend } = make();
  await backend.create(ctx, task({ id: "already-there", title: "live" }));

  const result = await backend.sync(ctx);
  expect(result.pushed).toBe(1); // "seeded" gets created
  expect(result.conflicts).toBe(0);

  const snapshot = fs.readFileSync(
    path.join(dir, ".claude", "tasks.yaml"),
    "utf8",
  );
  expect(snapshot).toContain("already-there");
  expect((await backend.get(ctx, "seeded"))?.title).toBe("from the seed file");
  fs.rmSync(dir, { recursive: true, force: true });
});
