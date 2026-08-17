// MCP tests, end to end: the official SDK client over real HTTP against the real server — SDK
// transport, tool layer, service, provider, with nock at the GitHub boundary.

import { test, expect, beforeEach, afterAll } from "vitest";
import nock from "nock";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pkg from "../package.json";
import { createHttpServer } from "../src/mcp/http.ts";
import { SERVER_INFO } from "../src/mcp/server.ts";
import { CachedTaskService } from "../src/core/service.ts";
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
async function startHttp(service: CachedTaskService) {
  const server = createHttpServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`)),
  );
  const close = async () => {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { base, client, close };
}

// The whole stack on an ephemeral port: nock GitHub, real provider + service, real HTTP transport.
async function harness() {
  installNock(new NockGitHub());
  const project = tmpRepo();
  const cache = tmp();
  const service = new CachedTaskService(
    { cacheDir: cache.dir },
    nockProvider({ projects: false }),
  );
  const { base, client, close } = await startHttp(service);
  return {
    client,
    base,
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
  const ready = () =>
    client.callTool({ name: "list_ready", arguments: { project } });
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

test("/health answers with the server info", async () => {
  const { base, cleanup } = await harness();
  const health = (await (await fetch(`${base}/health`)).json()) as any;
  expect(health.ok).toBe(true);
  expect(health.server.version).toBe(pkg.version);
  await cleanup();
});
