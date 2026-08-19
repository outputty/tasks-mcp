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

test("tools/list advertises the whole surface, each requiring project", async () => {
  const { client, cleanup } = await harness();
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining([
      "list_tasks",
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
    ]),
  );
  for (const t of tools) expect(t.inputSchema.required).toContain("project");
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

// --- the channel ------------------------------------------------------------------------------------

test("the server declares itself a channel, and never opts into permission relay", async () => {
  const { client, cleanup } = await harness();
  const capabilities = client.getServerCapabilities() as any;
  expect(capabilities.experimental["claude/channel"]).toEqual({});
  // relay would hand tool-approval authority to whoever can reach the channel; there is no human there
  expect(capabilities.experimental["claude/channel/permission"]).toBeUndefined();
  expect(client.getInstructions()).toMatch(/doorbell, not a report/);
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

test("notify rings the doorbell with a one-line reason", async () => {
  const { client, project, cleanup } = await harness();
  const res = structured(
    await client.callTool({
      name: "notify",
      arguments: { project, note: "spec gate on channel-emitter" },
    }),
  );
  expect(res.note).toBe("spec gate on channel-emitter");
  await cleanup();
});
