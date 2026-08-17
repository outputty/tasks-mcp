import { test, expect } from "bun:test";
import { handleRpc, type RpcRequest } from "../src/mcp.ts";
import { GitHubIssuesBackend } from "../src/backends/github-issues.ts";
import { createApp } from "../src/server.ts";
import { FakeGitHub } from "./fake-github.ts";

const PROJECT = "/tmp/whatever";

function backendWithFake() {
  const gh = new FakeGitHub();
  return new GitHubIssuesBackend(async () => ({
    octokit: gh,
    repo: { owner: "outputty", repo: "demo" },
  }));
}

const rpc = (
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): RpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const call = (name: string, args: Record<string, unknown>) =>
  rpc("tools/call", { name, arguments: args });
const structured = (res: Awaited<ReturnType<typeof handleRpc>>) =>
  (res as { result: { structuredContent: any; isError?: boolean } }).result;

test("initialize echoes the requested protocol version and names the server", async () => {
  const res = await handleRpc(
    rpc("initialize", { protocolVersion: "2025-06-18" }),
    backendWithFake(),
  );
  expect((res as any).result.protocolVersion).toBe("2025-06-18");
  expect((res as any).result.serverInfo.name).toBe("tasks-mcp");
  expect((res as any).result.capabilities.tools).toBeDefined();
});

test("an initialized notification gets no response", async () => {
  const res = await handleRpc(
    rpc("notifications/initialized"),
    backendWithFake(),
  );
  expect(res).toBeNull();
});

test("tools/list advertises the whole surface", async () => {
  const res = await handleRpc(rpc("tools/list"), backendWithFake());
  const names = (res as any).result.tools.map((t: any) => t.name);
  expect(names).toEqual(
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
  // Every tool requires `project`.
  for (const t of (res as any).result.tools)
    expect(t.inputSchema.required).toContain("project");
});

test("add_task then list_ready surfaces the new task", async () => {
  const backend = backendWithFake();
  await handleRpc(
    call("add_task", { project: PROJECT, id: "solo", title: "standalone" }),
    backend,
  );
  const res = await handleRpc(
    call("list_ready", { project: PROJECT }),
    backend,
  );
  expect(structured(res).structuredContent.ids).toEqual(["solo"]);
});

test("a dependency keeps a task out of ready until its dep closes", async () => {
  const backend = backendWithFake();
  await handleRpc(
    call("add_task", { project: PROJECT, id: "schema" }),
    backend,
  );
  await handleRpc(
    call("add_task", { project: PROJECT, id: "api", deps: ["schema"] }),
    backend,
  );
  let ready = structured(
    await handleRpc(call("list_ready", { project: PROJECT }), backend),
  ).structuredContent.ids;
  expect(ready).toEqual(["schema"]);
  await handleRpc(
    call("close_task", { project: PROJECT, id: "schema" }),
    backend,
  );
  ready = structured(
    await handleRpc(call("list_ready", { project: PROJECT }), backend),
  ).structuredContent.ids;
  expect(ready).toEqual(["api"]);
});

test("a tool failure comes back as isError, not a protocol error", async () => {
  const backend = backendWithFake();
  const res = await handleRpc(
    call("get_task", { project: PROJECT, id: "ghost" }),
    backend,
  );
  // get on a missing id returns { task: null } — not an error — so provoke a real one: duplicate add.
  await handleRpc(call("add_task", { project: PROJECT, id: "dup" }), backend);
  const dup = await handleRpc(
    call("add_task", { project: PROJECT, id: "dup" }),
    backend,
  );
  expect(structured(res).structuredContent.task).toBeNull();
  expect(structured(dup).isError).toBe(true);
});

test("an unknown tool name is reported as isError", async () => {
  const res = await handleRpc(
    call("nonesuch", { project: PROJECT }),
    backendWithFake(),
  );
  expect(structured(res).isError).toBe(true);
});

test("an unknown method is a JSON-RPC method-not-found error", async () => {
  const res = await handleRpc(rpc("frobnicate"), backendWithFake());
  expect((res as any).error.code).toBe(-32601);
});

test("the hono app answers /health and /mcp end to end", async () => {
  const app = createApp(backendWithFake());
  const health = await app.request("/health");
  expect(health.status).toBe(200);
  expect((await health.json()).ok).toBe(true);

  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      call("add_task", { project: PROJECT, id: "viahttp", title: "over http" }),
    ),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.structuredContent.task.id).toBe("viahttp");
});
