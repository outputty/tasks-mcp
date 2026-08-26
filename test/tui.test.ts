// The console's data path end to end: a real tracker (file-only stack) served over real node:http, read
// through a real MCP client — the same client path a remote tracker uses. No renderer here (the render
// and navigation tests are tui-app.test.ts / tui-format.test.ts); this file stays OpenTUI-free.

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "vitest";
import { createHttpServer } from "../src/mcp/http.ts";
import { TaskStack } from "../src/core/service.ts";
import { FileProvider } from "../src/core/providers/file.ts";
import { connectTracker, fetchQueues } from "../src/tui/tracker.ts";
import { queueRows } from "../src/tui/queue.ts";
import { tmp, task } from "./helpers.ts";

function fileStack(cacheDir: string): TaskStack {
  return new TaskStack({ cacheDir }, [new FileProvider({ cacheDir })]);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.close(() => r());
    server.closeAllConnections();
  });
}

const structured = (res: unknown) =>
  (res as { structuredContent: Record<string, unknown> }).structuredContent;

/** Seed one tracker: a done task, a started (in_progress) one, a ready one, an open-but-blocked one, and
 *  a ready task under a second project — the whole cross-section the queue filter has to sort out. */
async function seed(svc: TaskStack): Promise<void> {
  await svc.create({ project: "acme/one" }, task({ id: "shipped" }));
  await svc.close({ project: "acme/one" }, "shipped"); // done — must not appear
  await svc.create({ project: "acme/one" }, task({ id: "building" }));
  await svc.start({ project: "acme/one" }, "building"); // in_progress — list_ready EXCLUDES this
  await svc.create({ project: "acme/one" }, task({ id: "ready-now" }));
  await svc.create({ project: "acme/one" }, task({ id: "blocked", deps: ["ready-now"] }));
  await svc.create({ project: "acme/two" }, task({ id: "solo" }));
}

test("the console's rows are in-progress-or-ready across projects, NOT list_ready alone", async () => {
  const cache = tmp();
  const svc = fileStack(cache.dir);
  await seed(svc);
  const server = createHttpServer(svc);
  const client = await connectTracker(`${await listen(server)}/mcp`);

  const rows = queueRows(await fetchQueues(client));
  expect(rows.map((r) => `${r.project}/${r.id}`).sort()).toEqual([
    "acme/one/building", // in_progress, present though list_ready omits it
    "acme/one/ready-now",
    "acme/two/solo", // flat list, project as the disambiguating column
  ]);
  expect(rows.find((r) => r.id === "shipped")).toBeUndefined(); // done is hidden
  expect(rows.find((r) => r.id === "blocked")).toBeUndefined(); // an open-but-blocked task is hidden
  expect(rows.find((r) => r.id === "building")?.state).toBe("in progress");

  // NOT list_ready alone: it excludes the very in_progress build being watched.
  const ready = await client.callTool({ name: "list_ready", arguments: { project: "acme/one" } });
  expect(structured(ready).ids).not.toContain("building");

  await client.close();
  await closeServer(server);
  cache.cleanup();
});
