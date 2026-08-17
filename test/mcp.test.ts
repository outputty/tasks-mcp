import { test, expect } from "vitest";
import { handleRpc, type RpcRequest } from "../src/mcp/protocol.ts";
import { createApp } from "../src/mcp/http.ts";
import { CachedTaskService } from "../src/core/service.ts";
import { tmp } from "./helpers.ts";
import { FakeProvider } from "./fake-provider.ts";

// A service over a temp cache dir and a fake provider — the whole protocol, no HTTP to GitHub.
function harness() {
  const project = tmp();
  const cache = tmp();
  const service = new CachedTaskService(
    { cacheDir: cache.dir },
    new FakeProvider(),
  );
  return {
    service,
    project: project.dir,
    cleanup: () => {
      project.cleanup();
      cache.cleanup();
    },
  };
}

const rpc = (
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): RpcRequest => ({ jsonrpc: "2.0", id, method, params });
const call = (name: string, args: Record<string, unknown>) =>
  rpc("tools/call", { name, arguments: args });
const structured = (res: Awaited<ReturnType<typeof handleRpc>>) =>
  (res as { result: { structuredContent: any; isError?: boolean } }).result;

test("initialize echoes the protocol version and names the server", async () => {
  const { service } = harness();
  const res = await handleRpc(
    rpc("initialize", { protocolVersion: "2025-06-18" }),
    service,
  );
  expect((res as any).result.protocolVersion).toBe("2025-06-18");
  expect((res as any).result.serverInfo.name).toBe("tasks-mcp");
});

test("tools/list advertises the whole surface, each requiring project", async () => {
  const { service } = harness();
  const res = await handleRpc(rpc("tools/list"), service);
  const tools = (res as any).result.tools;
  expect(tools.map((t: any) => t.name)).toEqual(
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
});

test("add_task then list_ready surfaces the new task", async () => {
  const { service, project, cleanup } = harness();
  await handleRpc(
    call("add_task", { project, id: "solo", title: "standalone" }),
    service,
  );
  const res = await handleRpc(call("list_ready", { project }), service);
  expect(structured(res).structuredContent.ids).toEqual(["solo"]);
  cleanup();
});

test("a dependency holds a task out of ready until its dep closes", async () => {
  const { service, project, cleanup } = harness();
  await handleRpc(call("add_task", { project, id: "schema" }), service);
  await handleRpc(
    call("add_task", { project, id: "api", deps: ["schema"] }),
    service,
  );
  expect(
    structured(await handleRpc(call("list_ready", { project }), service))
      .structuredContent.ids,
  ).toEqual(["schema"]);
  await handleRpc(call("close_task", { project, id: "schema" }), service);
  expect(
    structured(await handleRpc(call("list_ready", { project }), service))
      .structuredContent.ids,
  ).toEqual(["api"]);
  cleanup();
});

test("a tool failure comes back as isError, not a protocol error", async () => {
  const { service, project, cleanup } = harness();
  await handleRpc(call("add_task", { project, id: "dup" }), service);
  const dup = await handleRpc(
    call("add_task", { project, id: "dup" }),
    service,
  );
  expect(structured(dup).isError).toBe(true);
  cleanup();
});

test("an unknown method is a JSON-RPC method-not-found error", async () => {
  const { service } = harness();
  const res = await handleRpc(rpc("frobnicate"), service);
  expect((res as any).error.code).toBe(-32601);
});

test("the hono app answers /health and /mcp end to end", async () => {
  const { service, project, cleanup } = harness();
  const app = createApp(service);
  const health = await app.request("/health");
  expect((await health.json()).ok).toBe(true);

  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      call("add_task", { project, id: "viahttp", title: "over http" }),
    ),
  });
  expect((await res.json()).result.structuredContent.task.id).toBe("viahttp");
  cleanup();
});
