// MCP tests, end to end: the official SDK client over real HTTP against the real server — SDK
// transport, tool layer, service, provider, with nock at the GitHub boundary.

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pkg from "../package.json";
import { createHttpServer } from "../src/mcp/http.ts";
import { SERVER_INFO } from "../src/mcp/server.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { tmp, tmpRepo } from "./helpers.ts";
import { NockGitHub, installNock, nockProvider } from "./nock-github.ts";

beforeEach(() => {
  nock.cleanAll();
  nock.disableNetConnect();
  nock.enableNetConnect(/^(localhost|127\.0\.0\.1)/); // the tests talk to their own http server
});
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

/** The real HTTP server on an ephemeral port, plus an SDK client connected to it. */
async function startHttp(service: TaskStack) {
  const server = createHttpServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const close = async () => {
    await client.close();
    // Destroy lingering keep-alive sockets rather than wait on them — server.close alone can hang
    // the test on a pooled connection the client transport does not own.
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  };
  return { base, client, close };
}

// The whole stack on an ephemeral port: nock GitHub, real provider + service, real HTTP transport.
async function harness() {
  const gh = installNock(new NockGitHub());
  const project = tmpRepo();
  const cache = tmp();
  const service = new TaskStack({ cacheDir: cache.dir }, [
    new FileProvider({ cacheDir: cache.dir }),
    nockProvider({ projects: false, cacheDir: cache.dir }),
  ]);
  const { base, client, close } = await startHttp(service);
  return {
    client,
    base,
    gh,
    project: project.dir,
    cleanup: async () => {
      await close();
      project.cleanup();
      cache.cleanup();
    },
  };
}

const structured = (res: unknown) => (res as any).structuredContent;

test("initialize reports the package's own name and version", async () => {
  const { client, cleanup } = await harness();
  expect(client.getServerVersion()).toMatchObject({
    name: "tasks-mcp",
    version: pkg.version, // never a hand-maintained copy
  });
  expect(SERVER_INFO.version).toBe(pkg.version);
  await cleanup();
});

// The surface tools/list must advertise. Kept beside the test so adding a tool is a one-line change.
const TOOL_NAMES = [
  "list_tasks",
  "list_projects",
  "list_ready",
  "list_planning",
  "schedule",
  "get_task",
  "add_task",
  "amend_task",
  "edit_task",
  "close_task",
  "delete_task",
  "get_trail",
  "append_trail",
  "sync",
  "add_target",
  "roadmap",
];

test("tools/list advertises the whole surface, and project is optional (a --project-id default fills it)", async () => {
  const { client, cleanup } = await harness();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(TOOL_NAMES));
  // `project` is no longer required: an omitted one resolves to the server's --project-id default.
  for (const t of tools) expect(t.inputSchema.required ?? []).not.toContain("project");
  await cleanup();
});

test("list_projects lists the served project with counts, from the cache alone (no GitHub call)", async () => {
  const { client, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_task", { id: "a" });
  await call("add_task", { id: "b" });
  await call("add_task", { id: "c" });
  await call("close_task", { id: "a" }); // done
  await call("start_task", { id: "b" }); // in_progress

  // The one tool that takes NO project — it asks about the server itself.
  const { projects } = structured(await client.callTool({ name: "list_projects", arguments: {} }));
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({ tasks: 3, open: 1, in_progress: 1, done: 1 });
  expect(projects[0].updated_at).toBeTypeOf("string");
  // No interceptor is armed for a GitHub call here and net is disabled, so a network read would have
  // thrown — reaching this line proves the answer came from the cache directory alone.
  await cleanup();
});

test("add_task then list_ready surfaces the new task", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "solo", title: "standalone" },
  });
  const res = await client.callTool({
    name: "list_ready",
    arguments: { project },
  });
  expect(structured(res).ids).toEqual(["solo"]);
  await cleanup();
});

test("list_tasks returns every task, full records, open and done", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "schema", title: "Design the schema", tier: 2 },
  });
  await client.callTool({ name: "add_task", arguments: { project, id: "api", deps: ["schema"] } });
  await client.callTool({ name: "close_task", arguments: { project, id: "schema" } });

  const res = structured(await client.callTool({ name: "list_tasks", arguments: { project } }));
  expect(res.ids.sort()).toEqual(["api", "schema"]);
  const schema = res.tasks.find((t: { id: string }) => t.id === "schema");
  expect(schema.status).toBe("done"); // closed tasks included
  expect(schema.tier).toBe(2); // full fields, not index rows
  expect(res.tasks.find((t: { id: string }) => t.id === "api").deps).toEqual(["schema"]);
  await cleanup();
});

test("a dependency holds a task out of ready until its dep closes", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "schema" },
  });
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "api", deps: ["schema"] },
  });
  const ready = () => client.callTool({ name: "list_ready", arguments: { project } });
  expect(structured(await ready()).ids).toEqual(["schema"]);
  await client.callTool({
    name: "close_task",
    arguments: { project, id: "schema" },
  });
  expect(structured(await ready()).ids).toEqual(["api"]);
  await cleanup();
});

test("edit_task changes a field, delete_task removes the task, over MCP", async () => {
  const { client, gh, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "api", title: "API", tier: 3 },
  });

  const edited = await client.callTool({
    name: "edit_task",
    arguments: { project, id: "api", title: "API v2", tier: 1 },
  });
  expect(structured(edited).task.title).toBe("API v2");
  expect(structured(edited).task.tier).toBe(1);

  const del = await client.callTool({ name: "delete_task", arguments: { project, id: "api" } });
  expect(structured(del).deleted).toBe("api");
  expect(gh.issues).toHaveLength(0); // issue deleted on GitHub
  const ready = structured(await client.callTool({ name: "list_ready", arguments: { project } }));
  expect(ready.ids).toEqual([]); // gone from the local cache too
  await cleanup();
});

test("a tool failure comes back as isError, not a protocol error", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "dup" },
  });
  const dup = await client.callTool({
    name: "add_task",
    arguments: { project, id: "dup" },
  });
  expect(dup.isError).toBe(true);
  await cleanup();
});

test("prereqs and blockers answer the two planning questions over MCP", async () => {
  const { client, project, cleanup } = await harness();
  const add = (id: string, deps: string[] = [], priority?: string) =>
    client.callTool({ name: "add_task", arguments: { project, id, deps, priority } });
  await add("schema");
  await add("api", ["schema"]);
  await add("ui", ["api"], "high");

  // Q1: I want to start on ui — what has to be done first?
  const pre = structured(
    await client.callTool({ name: "prereqs", arguments: { project, id: "ui" } }),
  );
  expect(pre.startable).toBe(false);
  expect(pre.order).toEqual([["schema"], ["api"]]);

  // Q2: what is the biggest blocker right now?
  const blk = structured(await client.callTool({ name: "blockers", arguments: { project } }));
  expect(blk.blockers[0].id).toBe("schema");
  expect(blk.blockers[0].blocks).toBe(2);
  expect(blk.blockers[0].highPriorityBlocked).toEqual(["ui"]);
  expect(blk.blockers[0].unblockedBy).toEqual([]); // schema itself is startable now
  await cleanup();
});

test("append_trail comments on the issue and get_trail reads the whole thread over MCP", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({ name: "add_task", arguments: { project, id: "api", title: "API" } });
  await client.callTool({
    name: "append_trail",
    arguments: { project, id: "api", kind: "decision", note: "GraphQL only", link: "types.ts:79" },
  });
  const res = await client.callTool({
    name: "append_trail",
    arguments: { project, id: "api", note: "cut the branch param" }, // no kind — a plain comment
  });
  const trail = structured(res).trail;
  expect(trail).toHaveLength(2);
  // The kind/link round-trip through a hidden marker; author + timestamp come from GitHub.
  expect(trail[0]).toMatchObject({
    kind: "decision",
    note: "GraphQL only",
    link: "types.ts:79",
    author: "test-user",
  });
  expect(trail[0].at).toBeTypeOf("string");
  expect(trail[1]).toMatchObject({ note: "cut the branch param", author: "test-user" });
  expect(trail[1].kind).toBeUndefined(); // a plain human-style comment carries no kind
  await cleanup();
});

test("append_trail refuses a task that has no issue yet", async () => {
  const { client, project, cleanup } = await harness();
  const res = await client.callTool({
    name: "append_trail",
    arguments: { project, id: "ghost", note: "x" },
  });
  expect(res.isError).toBe(true);
  await cleanup();
});

test("a global set_config propagates to the GitHub layer on the next write", async () => {
  const { client, gh, project, cleanup } = await harness();
  await client.callTool({
    name: "set_config",
    arguments: { project, scope: "global", config: { labels: false } },
  });
  await client.callTool({ name: "add_task", arguments: { project, id: "plain", tier: 2 } });

  expect(gh.issues[0].labels ?? []).toEqual([]); // no labels anywhere, per the global spec
  await cleanup();
});

test("a per-repo override beats the global spec, layer by layer in get_config", async () => {
  const { client, gh, project, cleanup } = await harness();
  const set = (scope: string, config: object) =>
    client.callTool({ name: "set_config", arguments: { project, scope, config } });
  await set("global", { labels: false });
  await set("repo", { labels: true, labelFields: ["tier"] });
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "labelled", tier: 1, priority: "high" },
  });

  expect(gh.issues[0].labels).toEqual(["tier:1"]); // labels back on, tier only
  const cfg = structured(await client.callTool({ name: "get_config", arguments: { project } }));
  expect(cfg.global.labels).toBe(false);
  expect(cfg.repo.labels).toBe(true);
  expect(cfg.effective.labelFields).toEqual(["tier"]);
  await cleanup();
});

test("/health answers with the server info", async () => {
  const { base, cleanup } = await harness();
  const health = (await (await fetch(`${base}/health`)).json()) as any;
  expect(health.ok).toBe(true);
  expect(health.server.version).toBe(pkg.version);
  await cleanup();
});

// --- the server surface -----------------------------------------------------------------------------

test("the server is a plain tool provider — no channel capability, no push", async () => {
  const { client, cleanup } = await harness();
  const capabilities = client.getServerCapabilities() as any;
  expect(capabilities.experimental?.["claude/channel"]).toBeUndefined();
  expect(client.getInstructions()).toMatch(/Nothing here pushes/);
  await cleanup();
});

test("notify is gone from the surface", async () => {
  const { client, cleanup } = await harness();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).not.toContain("notify");
  await cleanup();
});

test("list_ready is ranked: reach multiplied by priority, best first", async () => {
  const { client, project, cleanup } = await harness();
  const add = (args: object) =>
    client.callTool({ name: "add_task", arguments: { project, ...args } });
  await add({ id: "solo", priority: "high" }); // (0 + 1) x 3 = 3
  await add({ id: "hub", priority: "low" }); //   (5 + 1) x 1 = 6
  for (const id of ["w1", "w2", "w3", "w4", "w5"]) await add({ id, deps: "hub" });

  const res = structured(await client.callTool({ name: "list_ready", arguments: { project } }));
  expect(res.ids).toEqual(["hub", "solo"]);
  expect(res.tasks.map((t: any) => [t.id, t.blocks, t.score])).toEqual([
    ["hub", 5, 6],
    ["solo", 0, 3],
  ]);
  await cleanup();
});

test("add_target files a roadmap row that list_ready never offers", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_target",
    arguments: { project, id: "roadmap-in-graph", title: "Targets in the graph", brief: "the why" },
  });
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "sub-issues", title: "The edge", target: "roadmap-in-graph" },
  });
  const ready = structured(await client.callTool({ name: "list_ready", arguments: { project } }));
  expect(ready.ids).toEqual(["sub-issues"]); // the target itself is not work
  expect(ready.tasks[0].target).toBe("roadmap-in-graph"); // every ready row names its target
  await cleanup();
});

test("roadmap reports derived progress per target, in dependency order", async () => {
  const { client, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_target", { id: "first", title: "First", brief: "why first" });
  await call("add_target", { id: "second", title: "Second", brief: "why second", deps: ["first"] });
  await call("add_task", { id: "a", target: "first" });
  await call("add_task", { id: "b", target: "first" });
  await call("close_task", { id: "a" });

  const { targets } = structured(await call("roadmap", {}));
  expect(targets.map((t: { id: string }) => t.id)).toEqual(["first", "second"]);
  expect(targets[0].progress).toEqual({ total: 2, open: 1, in_progress: 0, done: 1 });
  expect(targets[0].ready).toEqual(["b"]);
  expect(targets[1].progress.total).toBe(0);
  await cleanup();
});

test("add_task refuses a target that does not exist, rather than orphaning the work", async () => {
  const { client, project, cleanup } = await harness();
  const res = await client.callTool({
    name: "add_task",
    arguments: { project, id: "a", target: "no-such-row" },
  });
  expect((res as { isError?: boolean }).isError).toBe(true);
  expect(JSON.stringify(res.content)).toContain("no target no-such-row");
  await cleanup();
});

test("edit_task moves a task between targets", async () => {
  const { client, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_target", { id: "one", title: "One", brief: "why one" });
  await call("add_target", { id: "two", title: "Two", brief: "why two" });
  await call("add_task", { id: "a", target: "one" });
  const moved = structured(await call("edit_task", { id: "a", target: "two" }));
  expect(moved.task.target).toBe("two");
  await cleanup();
});

test("edit_task clears a field, and the label comes OFF the issue", async () => {
  const { client, gh, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_task", { id: "a", title: "A", spec: "drafting", stage: "prototype" });
  expect(gh.issues[0].labels).toEqual(["spec:drafting", "stage:prototype"]);

  const cleared = structured(await call("edit_task", { id: "a", clear: ["spec", "stage"] }));
  expect(cleared.task.spec).toBeUndefined(); // the field is GONE, not set to something else
  expect(cleared.task.stage).toBeUndefined();
  expect(gh.issues[0].labels).toEqual([]);
  await cleanup();
});

test("setting a field back to its default drops the label too — absence already means it", async () => {
  const { client, gh, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_task", { id: "a", title: "A", tier: 1 });
  expect(gh.issues[0].labels).toEqual(["tier:1"]);
  await call("edit_task", { id: "a", tier: 3 });
  expect(gh.issues[0].labels).toEqual([]);
  await cleanup();
});

test("edit_task sets tags as plain GitHub labels, alongside the field labels", async () => {
  const { client, gh, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_task", { id: "a", title: "A", priority: "high" });
  await call("edit_task", { id: "a", tags: "security,frontend" });
  expect(gh.issues[0].labels).toEqual(["priority:high", "security", "frontend"]);

  const res = await call("edit_task", { id: "a", tags: "tier:9" });
  expect((res as { isError?: boolean }).isError).toBe(true);
  expect(JSON.stringify(res.content)).toContain("shadows a task field");
  await cleanup();
});

test("add_target refuses a row with no WHY — a placeholder parent never reaches the roadmap", async () => {
  const { client, project, cleanup } = await harness();
  const res = await client.callTool({
    name: "add_target",
    arguments: { project, id: "someday", title: "Someday" },
  });
  expect((res as { isError?: boolean }).isError).toBe(true);
  await cleanup();
});

test("promoting a task to a target refuses the build fields it still carries", async () => {
  const { client, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_task", { id: "a", title: "A", scope: "src/", tier: 2 });
  const refused = await call("edit_task", { id: "a", type: "target" });
  expect((refused as { isError?: boolean }).isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("cannot carry scope, tier");

  await call("edit_task", { id: "a", brief: "the why", clear: ["scope", "tier"] });
  const promoted = structured(await call("edit_task", { id: "a", type: "target" }));
  expect(promoted.task.type).toBe("target");
  await cleanup();
});

test("list_ready ranks by the ROADMAP row, not the task alone", async () => {
  const { client, project, cleanup } = await harness();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { project, ...args } });
  await call("add_target", { id: "urgent", title: "Urgent", brief: "why", priority: "high" });
  await call("add_target", { id: "someday", title: "Someday", brief: "why", priority: "low" });
  await call("add_task", { id: "a", title: "A", target: "someday" });
  await call("add_task", { id: "b", title: "B", target: "urgent" });

  const ready = structured(await call("list_ready", {}));
  expect(ready.ids).toEqual(["b", "a"]); // identical tasks; only their roadmap rows differ
  expect(ready.tasks[0].roadmap).toMatchObject({ target: "urgent", priority: "high" });
  await cleanup();
});

// --- The dispatcher's read: lane, overlap, spike marker, stale claims -------------------------------
// list_ready is the one call a queue-driven dispatcher makes per wave, so its whole surface is
// exercised here through the real transport rather than trusted from the unit tests underneath.

test("list_ready carries scope, tags and overlap on every row", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: {
      project,
      id: "spike-csv-shape",
      title: "What shape should the CSV take?",
      scope: ["src/orders"],
      tags: ["spike"],
    },
  });
  const [row] = structured(
    await client.callTool({ name: "list_ready", arguments: { project } }),
  ).tasks;
  expect(row).toMatchObject({
    id: "spike-csv-shape",
    scope: ["src/orders"],
    tags: ["spike"], // the marker a dispatcher branches on
    overlap: [], // nothing in flight
  });
  await cleanup();
});

test("an untagged task reads as an empty tag list, never a missing key", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({ name: "add_task", arguments: { project, id: "plain" } });
  const [row] = structured(
    await client.callTool({ name: "list_ready", arguments: { project } }),
  ).tasks;
  expect(row.tags).toEqual([]);
  await cleanup();
});

test("the scope filter draws a lane, and overlap still crosses it", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "csv-export", scope: ["src/orders"] },
  });
  await client.callTool({
    name: "add_task",
    arguments: { project, id: "sweep", scope: ["src"] },
  });
  await client.callTool({ name: "start_task", arguments: { project, id: "sweep" } });

  const lane = structured(
    await client.callTool({ name: "list_ready", arguments: { project, scope: ["src/orders"] } }),
  );
  expect(lane.ids).toEqual(["csv-export"]); // `sweep` is outside the lane AND claimed
  expect(lane.tasks[0].overlap).toEqual(["sweep"]); // …but its claim still shows

  const elsewhere = structured(
    await client.callTool({ name: "list_ready", arguments: { project, scope: ["docs"] } }),
  );
  expect(elsewhere.ids).toEqual([]);
  await cleanup();
});

test("list_ready reports every claim with its age, and only a deliberate release drops one", async () => {
  const { client, project, cleanup } = await harness();
  await client.callTool({ name: "add_task", arguments: { project, id: "csv-export" } });
  await client.callTool({ name: "start_task", arguments: { project, id: "csv-export" } });

  const held = structured(await client.callTool({ name: "list_ready", arguments: { project } }));
  expect(held.ids).toEqual([]); // claimed, so not offered
  expect(held.claims).toHaveLength(1); // …but the live claim is reported, fresh
  expect(held.claims[0].id).toBe("csv-export");
  expect(held.claims[0].stale_for_minutes).toBe(0); // an age, not a verdict

  // The deliberate release: the same exit a build takes when it cannot proceed.
  await client.callTool({
    name: "edit_task",
    arguments: { project, id: "csv-export", spec: "replan" },
  });
  await client.callTool({
    name: "edit_task",
    arguments: { project, id: "csv-export", spec: "settled" },
  });
  const freed = structured(await client.callTool({ name: "list_ready", arguments: { project } }));
  expect(freed.ids).toEqual(["csv-export"]);
  expect(freed.claims).toEqual([]); // released, so gone from the ledger
  await cleanup();
});
