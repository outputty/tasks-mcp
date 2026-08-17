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
      "list_ready",
      "list_planning",
      "schedule",
      "get_task",
      "add_task",
      "amend_task",
      "close_task",
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
