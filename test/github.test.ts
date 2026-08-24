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

test("the body renders a CONCISE visible spec that regenerates, and round-trips through the block", async () => {
  const { gh, provider, ctx } = setup();
  const t = {
    id: "api",
    title: "API",
    brief: "first brief",
    contract: "handle nulls",
    scope: ["src/api"],
  };
  await provider.upsert(ctx, task(t));
  // Visible (after the hidden block) = the brief + "what to account for"; scope/deps stay metadata.
  const visible = gh.issues[0].body.slice(gh.issues[0].body.indexOf("-->") + 3);
  expect(visible).toContain("first brief"); // problem + solution
  expect(visible).toContain("handle nulls"); // what to account for (the contract)
  expect(visible).not.toContain("src/api"); // scope is metadata — not in the visible summary
  // A changed brief REGENERATES the visible spec — the old text is gone, never duplicated.
  await provider.upsert(ctx, task({ id: "api", title: "API", brief: "second brief" }));
  expect(gh.issues[0].body).toContain("second brief");
  expect(gh.issues[0].body).not.toContain("first brief");
  // pull still reconstructs the brief from the machine block (BUILD/get_task keep working).
  expect((await provider.pull(ctx)).get("api")!.task.brief).toBe("second brief");
});

test("delete removes the issue and its board card; an unknown id is a no-op", async () => {
  const { gh, provider, ctx } = setup({}); // board on
  await provider.upsert(ctx, task({ id: "api" }));
  expect(gh.issues).toHaveLength(1);
  expect(gh.items.size).toBe(1);
  await provider.delete(ctx, "api");
  expect(gh.issues).toHaveLength(0); // issue gone
  expect(gh.items.size).toBe(0); // card gone too
  await provider.delete(ctx, "ghost"); // not here → no throw, no change
  expect(gh.issues).toHaveLength(0);
});

test("an update keeps a label it has never pulled, and replaces only the field labels", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", tier: 2 }));
  gh.labels.set("bug", "L_BUG");
  gh.issues[0].labels = ["bug", "tier:2"]; // a human added `bug` in the UI
  await provider.upsert(ctx, task({ id: "t-1", tier: 1 })); // a task that has never carried tags
  expect(gh.issues[0].labels).toEqual(["bug", "tier:1"]);
});

test("two servers racing on one new label: the loser adopts it instead of failing the write", async () => {
  const { gh, provider: first, cacheDir, ctx } = setup();
  const second = nockProvider({ cacheDir, projects: false });
  await first.init(ctx);
  await second.init(ctx); // both snapshot the repo's labels BEFORE either mints `kind:feature`

  await first.upsert(ctx, task({ id: "t-1", kind: "feature" })); // mints it
  await second.upsert(ctx, task({ id: "t-2", kind: "feature" })); // create refused: adopt, don't fail

  expect([...gh.labels.keys()]).toEqual(["kind:feature"]); // one label, created once
  expect(gh.issues.map((i) => i.labels)).toEqual([["kind:feature"], ["kind:feature"]]);
});

test("a field set to its DEFAULT wears no label — absence already means exactly that", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(
    ctx,
    task({ id: "t-1", tier: 3, qa: "subagent", priority: "normal", spec: "settled", type: "task" }),
  );
  expect(gh.issues[0].labels).toEqual([]); // five defaults, nothing a reader could not assume
  await provider.upsert(ctx, task({ id: "t-1", tier: 1, spec: "drafting" }));
  expect(gh.issues[0].labels).toEqual(["tier:1", "spec:drafting"]); // only what is NOT the default
});

test("a pull FLAGS an issue wearing a label that says nothing, so one sync cleans it", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", tier: 1 }));
  gh.labels.set("tier:3", "L_T3");
  gh.labels.set("frontend", "L_FE");

  gh.issues[0].labels = ["tier:1", "frontend"]; // current: a real value and a tag
  expect((await provider.pull(ctx)).get("t-1")!.reconcile).toBe(false);

  gh.issues[0].labels = ["tier:3"]; // a default an older version wrote — worth a rewrite
  expect((await provider.pull(ctx)).get("t-1")!.reconcile).toBe(true);

  gh.labels.set("tier:banana", "L_TB");
  gh.issues[0].labels = ["tier:banana"]; // junk the parser drops is stale for the same reason
  expect((await provider.pull(ctx)).get("t-1")!.reconcile).toBe(true);
});

test("tags are adopted from an issue's bare labels, and a write then makes them exact", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "t-1", tier: 1 }));
  gh.labels.set("security", "L_SEC");
  gh.issues[0].labels = ["tier:1", "security"]; // a human labelled it in the web UI
  const pulled = (await provider.pull(ctx)).get("t-1")!.task;
  expect(pulled.tags).toEqual(["security"]); // adopted: a UI edit flows back like any other

  await provider.upsert(ctx, { ...pulled, tags: ["security", "frontend"] });
  expect(gh.issues[0].labels).toEqual(["tier:1", "security", "frontend"]);
  await provider.upsert(ctx, { ...pulled, tags: [] });
  expect(gh.issues[0].labels).toEqual(["tier:1"]); // an explicit empty list removes them
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

test("an in-progress task keeps its issue OPEN and wears the label GitHub has no state for", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", status: "in_progress" }));
  expect(gh.issues[0].state).toBe("OPEN");
  expect(gh.issues[0].labels).toContain("status:in_progress");
});

test("open and done wear no status label — the issue's own state already says it", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api" }));
  expect(gh.issues[0].labels ?? []).not.toContain("status:open");
  await provider.upsert(ctx, task({ id: "api", status: "done" }));
  expect(gh.issues[0].labels ?? []).not.toContain("status:done");
});

test("in_progress round-trips back out of the label on pull", async () => {
  const { provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", status: "in_progress" }));
  const pulled = await provider.pull(ctx);
  expect(pulled.get("api")?.task.status).toBe("in_progress");
});

test("closing wins over a stale in-progress label — GitHub owns done", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "api", status: "in_progress" }));
  gh.issues[0].state = "CLOSED"; // closed by hand in the GitHub UI, label left behind
  const pulled = await provider.pull(ctx);
  expect(pulled.get("api")?.task.status).toBe("done");
});

// ---------------------------------------------------------------------------------------------------
// Targets and the sub-issue edge — a task's `target` IS its issue's parent, so the hierarchy a human
// sees on GitHub and the one the graph reasons over are the same object.

test("a target wears type:target; a plain task wears no type label at all", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "roadmap-row", type: "target" }));
  await provider.upsert(ctx, task({ id: "a" }));
  expect(gh.issues[0].labels).toContain("type:target");
  expect(gh.issues[1].labels ?? []).not.toContain("type:task");
});

test("a task naming a target becomes a sub-issue of the target's issue", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "roadmap-row", type: "target" }));
  await provider.upsert(ctx, task({ id: "a", target: "roadmap-row" }));
  const parent = gh.issues.find((i) => i.title === "roadmap-row")!;
  expect(gh.issues.find((i) => i.title === "a")!.parent).toBe(parent.id);
});

test("the edge round-trips: pull reads `target` back off the parent, not the body", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "roadmap-row", type: "target" }));
  await provider.upsert(ctx, task({ id: "a", target: "roadmap-row" }));
  expect(gh.issues.find((i) => i.title === "a")!.body).not.toContain("target:"); // the edge is its home
  const pulled = await provider.pull(ctx);
  expect(pulled.get("a")!.task.target).toBe("roadmap-row");
  expect(pulled.get("roadmap-row")!.task.type).toBe("target");
});

test("re-parenting in the GitHub UI flows back on the next pull", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "one", type: "target" }));
  await provider.upsert(ctx, task({ id: "two", type: "target" }));
  await provider.upsert(ctx, task({ id: "a", target: "one" }));
  // A human drags the issue under the other target.
  gh.issues.find((i) => i.title === "a")!.parent = gh.issues.find((i) => i.title === "two")!.id;
  expect((await provider.pull(ctx)).get("a")!.task.target).toBe("two");
});

test("moving a task to another target moves the edge; clearing it detaches", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "one", type: "target" }));
  await provider.upsert(ctx, task({ id: "two", type: "target" }));
  await provider.upsert(ctx, task({ id: "a", target: "one" }));
  await provider.upsert(ctx, task({ id: "a", target: "two" }));
  const child = () => gh.issues.find((i) => i.title === "a")!;
  expect(child().parent).toBe(gh.issues.find((i) => i.title === "two")!.id);
  await provider.upsert(ctx, task({ id: "a" })); // target cleared
  expect(child().parent).toBeNull();
});

test("a target whose issue does not exist yet never fails the write — the edge waits for a sync", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "a", target: "not-synced-yet" }));
  expect(gh.issues).toHaveLength(1); // the task still lands
  expect(gh.issues[0].parent).toBeUndefined();
});

test("with labels off, type survives in the body block — a target must never come back a task", async () => {
  const { gh, provider, ctx } = setup({ projects: false, labels: false });
  await provider.upsert(ctx, task({ id: "roadmap-row", type: "target" }));
  expect(gh.issues[0].labels ?? []).toHaveLength(0);
  expect(gh.issues[0].body).toContain("type: target");
  expect((await provider.pull(ctx)).get("roadmap-row")!.task.type).toBe("target");
});

// ---------------------------------------------------------------------------------------------------
// `-->` inside the hidden block. A mermaid arrow IS the HTML comment terminator, and the flow asks for
// diagrams inline in a brief, so this is the shape a real task arrives in.

const MERMAID_BRIEF = [
  "The sync path forks.",
  "",
  "```mermaid",
  "flowchart TD",
  "  pull --> merge",
  "  merge --> push",
  "```",
  "",
  "Both branches must converge.",
].join("\n");

test("a brief with an inline mermaid diagram round-trips whole, arrows and all", async () => {
  const { gh, provider, ctx } = setup();
  await provider.upsert(ctx, task({ id: "diagram", title: "D", brief: MERMAID_BRIEF }));

  // The hidden block must not contain a raw `-->`, or GitHub closes the comment at the first arrow
  // and renders the rest of the YAML as visible garbage.
  const block = gh.issues[0].body!.slice(0, gh.issues[0].body!.indexOf("\n-->"));
  expect(block).not.toContain("-->");
  expect(block).toContain("--&gt;");

  const pulled = (await provider.pull(ctx)).get("diagram")!.task;
  expect(pulled.brief).toBe(MERMAID_BRIEF); // the whole diagram, not truncated at the first arrow
});

test("a body written BEFORE the escaping still reads back whole, not cut at the first arrow", async () => {
  const { gh, provider, ctx } = setup();
  // Exactly what an older version wrote: the arrow raw inside the block.
  const yaml = `id: legacy-diagram\nbrief: |-\n${MERMAID_BRIEF.split("\n")
    .map((l) => `  ${l}`)
    .join("\n")}`;
  gh.issues.push({
    id: "I_70",
    number: 70,
    title: "legacy",
    body: `<!-- outputty:task\n${yaml}\n-->\n\nhuman prose below`,
    state: "OPEN",
    labels: [],
  });
  const pulled = (await provider.pull(ctx)).get("legacy-diagram")!.task;
  expect(pulled.brief).toBe(MERMAID_BRIEF); // recovered: the terminator is a line of its own
});

test("a hand-written one-line block is still found", async () => {
  const { gh, provider, ctx } = setup();
  gh.issues.push({
    id: "I_71",
    number: 71,
    title: "one-liner",
    body: "<!-- outputty:task id: hand-written -->",
    state: "OPEN",
    labels: [],
  });
  expect((await provider.pull(ctx)).get("hand-written")!.task.id).toBe("hand-written");
});
